import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createAgentToolRegistry } from "../scripts/agent-tools.mjs";
import { createAgentMcpHandler } from "../scripts/agent-mcp.mjs";
import { PillowfortBrowserAgent } from "../scripts/agent-browser.mjs";
import { StdioWire, ObservedHostedAgent, SUBSCRIPTION, PROTOCOL, changeAndRearm, envelope, mentionUri, turn } from "./mcp-wire";

const wires: StdioWire[] = [];
afterEach(async () => {
  for (const wire of wires.splice(0)) await wire.close();
});
function fixture() {
  const wire = new StdioWire();
  wires.push(wire);
  return wire;
}
const toolData = z.object({ ok: z.boolean(), data: z.unknown().optional() });

test("2026 stdio discovery needs no initialize and allocates no participant identity", async () => {
  const wire = fixture();
  const discovered = await wire.result("server/discover");
  expect(discovered.resultType).toBe("complete");
  expect(discovered.capabilities).toMatchObject({ tools: {}, resources: { subscribe: true }, prompts: {} });
  expect(discovered).toMatchObject({ ttlMs: expect.any(Number), cacheScope: "public" });
  expect(discovered._meta).toMatchObject({ "io.modelcontextprotocol/serverInfo": { name: "pillowfort" } });
  const listed = await wire.result("tools/list");
  const tools = z.array(z.object({ name: z.string(), inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) })).parse(listed.tools);
  expect(tools.find(tool => tool.name === "session_create")?.inputSchema.properties).toEqual({});
  expect(wire.agent.listSessions()).toEqual([]);
  expect(wire.agent.pendingWaits).toBe(0);
});

test("2026 stdio rejects initialize, claimless calls and resources subscribe shims", async () => {
  const wire = fixture();
  wire.input.write(JSON.stringify({ jsonrpc: "2.0", id: "legacy", method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "old", version: "1" }, capabilities: {} } }) + "\n");
  expect((await wire.waitFor(message => message.id === "legacy")).error).toBeDefined();
  await wire.result("server/discover");
  wire.input.write(JSON.stringify({ jsonrpc: "2.0", id: "claimless", method: "tools/list", params: {} }) + "\n");
  expect((await wire.waitFor(message => message.id === "claimless")).error).toBeDefined();
  for (const method of ["initialize", "resources/subscribe", "resources/unsubscribe"]) {
    expect((await wire.request(method, { uri: mentionUri(crypto.randomUUID()) })).error).toBeDefined();
  }
  expect((await wire.result("tools/list")).resultType).toBe("complete");
  expect(wire.agent.listSessions()).toEqual([]);
});

test("participant tools mint opaque handles, reject caller names and never adopt local or foreign identities", async () => {
  const first = fixture();
  const second = fixture();
  const callerNamed = await first.tool("session_create", { session: "chosen-name" });
  expect(callerNamed.isError).toBe(true);
  expect(first.agent.listSessions()).toEqual([]);
  const created = await first.create();
  const listed = await first.tool("session_list");
  expect(toolData.parse(listed.structuredContent).data).toEqual([{ session: created.session, state: "ready" }]);
  expect((await second.tool("session_observe", { session: created.session })).isError).toBe(true);
  const local = crypto.randomUUID();
  await first.agent.createSession(local);
  expect((await first.tool("session_observe", { session: local })).isError).toBe(true);
  expect((await first.request("resources/read", { uri: mentionUri(local) })).error).toBeDefined();
  expect((await second.request("resources/read", { uri: created.uri })).error).toBeDefined();
});

test("listen acknowledges before URI-only filtered notifications and stamps exact subscription IDs", async () => {
  const wire = fixture();
  const first = await wire.create();
  const second = await wire.create("Other");
  const firstId = await wire.listen([first.uri], "mention-stream");
  const secondId = await wire.listen([second.uri], 702);
  const emptyId = await wire.listen([], "no-resource-opt-in");
  expect(wire.updates()).toEqual([]);
  await changeAndRearm(wire.agent, () => first.store.getState().addChatMessage("Sender", "@Receiver never put this plaintext on the wire update"));
  expect(wire.updates()).toHaveLength(1);
  expect(wire.updates()[0]).toMatchObject({ params: { uri: first.uri, _meta: { [SUBSCRIPTION]: firstId } } });
  expect(Object.keys(wire.updates()[0].params ?? {}).sort()).toEqual(["_meta", "uri"]);
  expect(JSON.stringify(wire.updates())).not.toContain("plaintext");
  await changeAndRearm(wire.agent, () => second.store.getState().addChatMessage("Sender", "@Other isolated"));
  expect(wire.updates().map(message => message.params?._meta?.[SUBSCRIPTION])).toEqual([firstId, secondId]);
  expect(wire.updates().some(message => message.params?._meta?.[SUBSCRIPTION] === emptyId)).toBe(false);
});

test("participant reads are private TTL-zero, bounded and stale handles stay rejected after recreation", async () => {
  const wire = fixture();
  const created = await wire.create();
  created.store.getState().addChatMessage("Sender", "@Receiver private receipt");
  const read = await wire.result("resources/read", { uri: created.uri });
  expect(read).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
  const contents = z.array(z.object({ text: z.string() })).parse(read.contents);
  expect(JSON.parse(contents[0].text)).toMatchObject({ session: created.session, ephemeral: true, liveOnly: true });
  expect((await wire.result("resources/read", { uri: "pillowfort://agents/security" })).cacheScope).toBe("public");
  expect((await wire.tool("session_close", { session: created.session, confirm: true })).isError).toBe(false);
  const replacement = await wire.create();
  expect(replacement.session).not.toBe(created.session);
  expect((await wire.tool("session_observe", { session: created.session })).isError).toBe(true);
  expect((await wire.request("resources/read", { uri: created.uri })).error).toBeDefined();
  await changeAndRearm(wire.agent, () => replacement.store.getState().addChatMessage("Sender", "@Receiver replacement"));
  expect(wire.updates()).toEqual([]);
});

test("browser participant retirement disposes contexts before replacing capacity and coalesces close races", async () => {
  const [{ chromium }, { createServer }] = await Promise.all([
    import("playwright"),
    import("../client/node_modules/vite/dist/node/index.js"),
  ]);
  const vite = await createServer({
    root: `${import.meta.dir}/../client`,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const browser = await chromium.launch({ headless: true });
  // Only disposal scheduling is instrumented; pages, contexts, signals and capacity are real.
  class ClosingBrowserAgent extends PillowfortBrowserAgent {
    readonly closeCalls: string[] = [];
    closeGate?: Promise<void>;
    override async closeSession(session: string) {
      this.closeCalls.push(session);
      const gate = this.closeGate;
      this.closeGate = undefined;
      if (gate) await gate;
      return super.closeSession(session);
    }
  }
  const releaseGates: Array<() => void> = [];
  let agent: ClosingBrowserAgent | undefined;
  try {
    await vite.listen();
    const baseURL = vite.resolvedUrls?.local[0];
    if (!baseURL) throw new Error("Vite did not expose a browser participant test URL");
    agent = new ClosingBrowserAgent({ baseURL, maxSessions: 1, launchBrowser: async () => browser });
    const registry = await createAgentToolRegistry(agent, [], { roomTools: [], includeCMS: false });
    const invoke = (name: string, input = {}) => registry.get(name)!.invoke(input);
    const created = z.object({ data: z.object({ session: z.string() }) });
    const first = created.parse(await invoke("session_create")).data.session;
    const context = browser.contexts()[0];
    let disposed = false;
    context.on("close", () => { disposed = true; });
    const signal = agent.sessionSignal(first);
    const externalClose = Promise.withResolvers<void>();
    releaseGates.push(externalClose.resolve);
    agent.closeGate = externalClose.promise;
    await context.pages()[0].close();
    await turn();
    expect(signal.aborted).toBe(true);
    expect(agent.closeCalls).toEqual([first]);
    expect(await invoke("session_list")).toMatchObject({ ok: true, data: [] });
    expect(await invoke("session_observe", { session: first })).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    expect(await invoke("session_close", { session: first, confirm: true })).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    let replacementSettled = false;
    const replacement = invoke("session_create").then(result => { replacementSettled = true; return result; });
    await turn();
    expect(replacementSettled).toBe(false);
    expect(disposed).toBe(false);
    expect(browser.contexts()).toHaveLength(1);
    externalClose.resolve();
    const second = created.parse(await replacement).data.session;
    expect(second).not.toBe(first);
    expect(disposed).toBe(true);
    expect(browser.contexts()).toHaveLength(1);
    expect(agent.listSessions()).toEqual([{ name: second, state: "ready" }]);
    expect(await invoke("session_observe", { session: first })).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });

    const explicitClose = Promise.withResolvers<void>();
    releaseGates.push(explicitClose.resolve);
    agent.closeGate = explicitClose.promise;
    const closing = invoke("session_close", { session: second, confirm: true });
    await turn();
    expect(agent.closeCalls).toEqual([first, second]);
    await browser.contexts()[0].pages()[0].close();
    expect(await invoke("session_close", { session: second, confirm: true })).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    let nextSettled = false;
    const next = invoke("session_create").then(result => { nextSettled = true; return result; });
    await turn();
    expect(nextSettled).toBe(false);
    expect(agent.closeCalls).toEqual([first, second]);
    explicitClose.resolve();
    expect(await closing).toMatchObject({ ok: true, data: { session: second, closed: true } });
    const third = created.parse(await next).data.session;
    expect(third).not.toBe(second);
    expect(agent.listSessions()).toEqual([{ name: third, state: "ready" }]);
    expect(browser.contexts()).toHaveLength(1);
    expect(await invoke("session_observe", { session: second })).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
    expect(await invoke("session_close", { session: third, confirm: true })).toMatchObject({ ok: true });
    expect(agent.closeCalls).toEqual([first, second, third]);
    expect(agent.listSessions()).toEqual([]);
    expect(browser.contexts()).toEqual([]);
  } finally {
    for (const release of releaseGates) release();
    await agent?.close();
    await browser.close();
    await vite.close();
  }
}, 60_000);

test("cancelling stdio listen removes delivery but leaves identities and the single participant watcher alive", async () => {
  const wire = fixture();
  const created = await wire.create();
  await wire.agent.afterWait(0);
  for (let index = 0; index < 40; index++) {
    const id = await wire.listen([created.uri]);
    wire.cancel(id);
    await wire.result("tools/list");
  }
  expect(wire.agent.pendingWaits).toBe(1);
  expect(wire.agent.sessionSignal(created.session).aborted).toBe(false);
  await changeAndRearm(wire.agent, () => created.store.getState().addChatMessage("Sender", "@Receiver no cancelled stream"));
  expect(wire.updates()).toEqual([]);
  const id = await wire.listen([created.uri]);
  await changeAndRearm(wire.agent, () => created.store.getState().addChatMessage("Sender", "@Receiver reconnected live"));
  expect(wire.updates()).toHaveLength(1);
  expect(wire.updates()[0].params?._meta?.[SUBSCRIPTION]).toBe(id);
  expect(toolData.parse((await wire.tool("session_list")).structuredContent).data).toEqual([{ session: created.session, state: "ready" }]);
});

test("stdio EOF cancels real pending waits and destroys all participant identities", async () => {
  const wire = fixture();
  const created = await wire.create();
  await wire.agent.afterWait(0);
  await wire.listen([created.uri]);
  const signal = wire.agent.sessionSignal(created.session);
  const revision = (await wire.agent.observe(created.session)).revision;
  const count = wire.agent.waitCount;
  wire.send("tools/call", { name: "session_wait", arguments: { session: created.session, afterRevision: revision, timeoutMs: 30_000 } }, "pending-tool-wait");
  await wire.agent.afterWait(count);
  wire.input.end();
  await wire.finished;
  await turn();
  expect(signal.aborted).toBe(true);
  expect(wire.agent.pendingWaits).toBe(0);
  expect(wire.agent.listSessions()).toEqual([]);
  expect(wire.messages.some(message => message.id === "pending-tool-wait")).toBe(false);
});

test("each modern request validates its own protocol claim rather than inheriting connection capabilities", async () => {
  const wire = fixture();
  await wire.result("server/discover");
  wire.input.write(JSON.stringify({ jsonrpc: "2.0", id: "wrong-version", method: "tools/list", params: { _meta: { ...envelope(), "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } }) + "\n");
  expect((await wire.waitFor(message => message.id === "wrong-version")).error).toBeDefined();
  wire.input.write(JSON.stringify({ jsonrpc: "2.0", id: "missing-capabilities", method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL } } }) + "\n");
  expect((await wire.waitFor(message => message.id === "missing-capabilities")).error).toBeDefined();
  expect((await wire.result("tools/list")).resultType).toBe("complete");
});

test("stdio listen enforces sixteen streams and cancellation immediately returns stream capacity", async () => {
  const wire = fixture();
  await wire.result("server/discover");
  const ids: (number | string)[] = [];
  for (let index = 0; index < 16; index++) ids.push(await wire.listen());
  const overflow = await wire.request("subscriptions/listen", { notifications: {} });
  expect(overflow.error).toMatchObject({ code: -32603 });
  wire.cancel(ids[0]);
  await wire.listen([], "capacity-restored");
  expect(wire.agent.listSessions()).toEqual([]);
  expect(wire.agent.pendingWaits).toBe(0);
});

test("public definitions-only registry never allocates a participant scope or permits participant execution", async () => {
  const registry = await createAgentToolRegistry(null, [], { roomTools: [], includeCMS: false });
  expect(registry.get("session_create")?.definition.inputSchema.properties).toEqual({});
  expect((await registry.get("session_create")!.invoke({}))).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
  expect((await registry.get("session_list")!.invoke({}))).toMatchObject({ ok: false, error: { code: "SESSION_NOT_FOUND" } });
});

test("HTTP metadata mismatches are rejected before resource subscription authorization", async () => {
  const agent = new ObservedHostedAgent({
    baseURL: "http://localhost:3000",
    createWebSocket: () => { throw new Error("Header validation must not connect a participant"); },
  });
  const handler = createAgentMcpHandler({ agent, roomTools: [], includeCMS: false });
  try {
    const response = await handler.fetch(new Request("https://pillowfort.invalid/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL,
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
        params: { _meta: envelope(), notifications: { resourceSubscriptions: [mentionUri(crypto.randomUUID())] } },
      }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32020 } });
    expect(agent.listSessions()).toEqual([]);
  } finally {
    await handler.close();
    await agent.close();
  }
});
