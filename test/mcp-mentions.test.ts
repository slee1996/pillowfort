import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAgentMcpServer } from "../scripts/agent-mcp.mjs";
import { PillowfortHostedAgent } from "../src/participant/hostedAgent";
import type { ParticipantStore } from "../src/participant/gameStore";
import type { AgentSnapshot } from "../src/participant/agent";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Deferred { promise: Promise<void>; resolve(): void }

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Instrument only scheduling, not observations, receipt parsing, or wait results.
class ObservedHostedAgent extends PillowfortHostedAgent {
  waitCount = 0;
  pendingWaits = 0;
  lastWaitSignal?: AbortSignal;
  private started = new Set<() => void>();
  private resultGate?: { entered: Deferred; release: Deferred };
  private observationGate?: { entered: Deferred; release: Deferred };

  override async observe(name: string): Promise<AgentSnapshot> {
    const snapshot = await super.observe(name);
    const gate = this.observationGate;
    if (gate) {
      this.observationGate = undefined;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return snapshot;
  }

  override async wait(name: string, revision: number, timeoutMs = 30_000, options: { signal?: AbortSignal } = {}): Promise<AgentSnapshot> {
    const waiting = super.wait(name, revision, timeoutMs, options);
    this.waitCount++;
    this.pendingWaits++;
    this.lastWaitSignal = options.signal;
    for (const wake of [...this.started]) wake();
    try {
      const snapshot = await waiting;
      const gate = this.resultGate;
      if (gate) {
        this.resultGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return snapshot;
    } finally { this.pendingWaits--; }
  }

  async afterWait(count: number) {
    if (this.waitCount > count) return;
    await new Promise<void>(resolve => {
      const wake = () => {
        if (this.waitCount <= count) return;
        this.started.delete(wake);
        resolve();
      };
      this.started.add(wake);
      wake();
    });
  }

  pauseNextResult() {
    const gate = { entered: deferred(), release: deferred() };
    this.resultGate = gate;
    return gate;
  }

  pauseNextObservation() {
    const gate = { entered: deferred(), release: deferred() };
    this.observationGate = gate;
    return gate;
  }

  store(name: string): ParticipantStore {
    // The production adapter deliberately does not export a plaintext store API.
    const internals = this as unknown as { sessions: Map<string, { runtime: { controller: { store: ParticipantStore } } }> };
    const session = internals.sessions.get(name);
    if (!session) throw new Error("Missing real participant session");
    return session.runtime.controller.store;
  }
}

async function fixture() {
  const agent = new ObservedHostedAgent({
    baseURL: "http://localhost:3000", maxSessions: 16,
    createWebSocket: () => { throw new Error("These local receipt tests must not open a relay socket"); },
  });
  let closes = 0;
  const server = createAgentMcpServer({ agent, roomTools: [], includeCMS: false, onClose: () => { closes++; } });
  const client = new Client({ name: "mention-regression", version: "1.0.0" });
  const updates: { method: string; params?: unknown }[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => { updates.push(notification); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await agent.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const create = async (name: string, displayName = "Receiver") => {
    const result = await client.callTool({ name: "session_create", arguments: { session: name } });
    expect(result.isError).toBe(false);
    const store = agent.store(name);
    store.setState({ screen: "chat", roomId: "f-aaaaaaaaaa", name: displayName, members: [displayName, "Sender", "Other"] });
    return store;
  };
  const read = async (uri: string) => {
    const result = await client.readResource({ uri });
    const content = result.contents[0];
    if (!("text" in content)) throw new Error("Expected JSON resource text");
    return JSON.parse(content.text);
  };
  return { agent, server, client, updates, create, read, closes: () => closes };
}

const uri = "pillowfort://sessions/receiver/mentions";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

async function changeAndRearm(agent: ObservedHostedAgent, change: () => void) {
  const count = agent.waitCount;
  change();
  await agent.afterWait(count);
  await turn();
}

test("real MCP clients receive one URI-only own-mention update and retain tools, resources, and prompts", async () => {
  const { agent, client, updates, create, read } = await fixture();
  const store = await create("receiver");
  const other = await create("other", "Other");
  store.getState().addChatMessage("Sender", "@Receiver before subscribing");
  expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
  expect((await client.listResourceTemplates()).resourceTemplates[0].uriTemplate).toBe("pillowfort://sessions/{session}/mentions");
  expect((await client.listResources()).resources.some(resource => resource.uri === "pillowfort://agents/security")).toBe(true);
  expect((await client.readResource({ uri: "pillowfort://agents/security" })).contents.length).toBe(1);
  expect((await client.listPrompts()).prompts.some(prompt => prompt.name === "join_room")).toBe(true);
  expect((await client.getPrompt({ name: "join_room" })).messages.length).toBeGreaterThan(1);
  expect((await client.listTools()).tools.some(tool => tool.name === "session_observe")).toBe(true);
  expect((await client.callTool({ name: "session_observe", arguments: { session: "receiver" } })).isError).toBe(false);

  await Promise.all([client.subscribeResource({ uri }), client.subscribeResource({ uri })]);
  expect(agent.waitCount).toBe(1);
  expect(updates).toEqual([]);
  await changeAndRearm(agent, () => store.getState().addChatMessage("Sender", "not a mention: email@Receiver @Receivers"));
  await changeAndRearm(agent, () => store.getState().addChatMessage("Receiver", "@Receiver self"));
  await changeAndRearm(agent, () => store.getState().addSystemMessage("@Receiver system"));
  await changeAndRearm(agent, () => store.getState().addChatMessage("Sender", "@Receiver replay", undefined, true));
  await changeAndRearm(agent, () => store.getState().toggleMute("Sender"));
  store.getState().addChatMessage("Sender", "@Receiver muted");
  await turn();
  await changeAndRearm(agent, () => store.getState().toggleMute("Sender"));
  expect(updates).toEqual([]);

  await changeAndRearm(agent, () => store.getState().addChatMessage("Sender", "@Receiver fresh @Receiver @Other"));
  expect(updates).toEqual([{ method: "notifications/resources/updated", params: { uri } }]);
  const resource = await read(uri);
  expect(resource).toMatchObject({ session: "receiver", ephemeral: true, liveOnly: true });
  expect(resource.messages.at(-1)).toMatchObject({ from: "Sender", text: "@Receiver fresh @Receiver @Other", mentions: ["Receiver", "Other"] });
  expect(resource.latestMessageId).toBe(resource.messages.at(-1).id);
  expect(resource.messages.every((message: { text: string }) => !message.text.includes("muted") && !message.text.includes("replay"))).toBe(true);
  other.getState().addChatMessage("Sender", "@Other isolated");
  expect((await read("pillowfort://sessions/other/mentions")).messages.at(-1).text).toBe("@Other isolated");
  expect((await read(uri)).messages.some((message: { text: string }) => message.text.includes("isolated"))).toBe(false);
  expect(updates.length).toBe(1);
});

test("resource names are strict and only existing participant sessions in this connection are readable", async () => {
  const first = await fixture();
  const second = await fixture();
  await first.create("receiver");
  for (const invalid of [
    "pillowfort://sessions/missing/mentions", "pillowfort://sessions/receiver/mentions?x=1",
    "pillowfort://sessions/receiver/mentions#x", "pillowfort://sessions/%72eceiver/mentions",
    "pillowfort://sessions/../mentions", "pillowfort://sessions/receiver/mentions/",
    "pillowfort://sessions/receiver%2Fother/mentions", "pillowfort://sessions/_receiver/mentions",
    "pillowfort://sessions/receiver/mentions\n", "pillowfort://sessions/receiver/mentions\r\n",
  ]) {
    await expect(first.client.readResource({ uri: invalid })).rejects.toThrow();
    await expect(first.client.subscribeResource({ uri: invalid })).rejects.toThrow();
  }
  await expect(second.client.readResource({ uri })).rejects.toThrow();
  await expect(second.client.subscribeResource({ uri })).rejects.toThrow();
  expect(first.agent.waitCount).toBe(0);
  expect(second.agent.waitCount).toBe(0);
});

test("mention resource reads remain bounded and explicitly ephemeral", async () => {
  const { create, read } = await fixture();
  const store = await create("receiver");
  for (let index = 0; index < 40; index++) store.getState().addChatMessage("Sender", `@Receiver ${index} ${"x".repeat(1800)}`);
  const resource = await read(uri);
  expect(resource.messages.length).toBeGreaterThan(0);
  expect(resource.messages.length).toBeLessThanOrEqual(16);
  expect(new TextEncoder().encode(JSON.stringify(resource.messages)).byteLength).toBeLessThanOrEqual(16 * 1024);
  expect(resource.retainedCount).toBe(40);
  expect(resource.latestMessageId).toBe(resource.messages.at(-1).id);
  expect(resource).toMatchObject({ liveOnly: true, ephemeral: true });
});

test("unsubscribe cancels actual waiters repeatedly without exhausting limits or interfering with tool waits", async () => {
  const { agent, client, updates, create } = await fixture();
  const store = await create("receiver");
  const revision = (await agent.observe("receiver")).revision;
  const toolWait = client.callTool({ name: "session_wait", arguments: { session: "receiver", afterRevision: revision, timeoutMs: 30_000 } });
  await agent.afterWait(0);
  for (let index = 0; index < 80; index++) {
    await client.subscribeResource({ uri });
    await client.unsubscribeResource({ uri });
    expect(agent.pendingWaits).toBe(1);
  }
  store.getState().addChatMessage("Sender", "@Receiver only the tool waiter remains");
  expect((await toolWait).isError).toBe(false);
  expect(agent.pendingWaits).toBe(0);
  expect(updates).toEqual([]);
  expect(agent.listSessions()).toEqual([{ name: "receiver", state: "ready" }]);
});

test("a session closed during the subscribe baseline cannot bind a same-name replacement", async () => {
  const { agent, client, updates, create } = await fixture();
  await create("receiver");
  const gate = agent.pauseNextObservation();
  cleanups.unshift(async () => { gate.release.resolve(); });
  const subscribing = client.subscribeResource({ uri });
  const rejected = subscribing.then(() => false, () => true);
  await gate.entered.promise;
  await agent.closeSession("receiver");
  const replacement = await create("receiver");
  await client.subscribeResource({ uri });
  gate.release.resolve();
  expect(await rejected).toBe(true);
  await changeAndRearm(agent, () => replacement.getState().addChatMessage("Sender", "@Receiver after replacement baseline"));
  expect(updates).toEqual([{ method: "notifications/resources/updated", params: { uri } }]);
});

test("close and same-name recreation cannot leak a completed old wait or attach the new participant", async () => {
  const { agent, client, updates, create } = await fixture();
  const store = await create("receiver");
  const signal = agent.sessionSignal("receiver");
  await client.subscribeResource({ uri });
  const gate = agent.pauseNextResult();
  cleanups.unshift(async () => { gate.release.resolve(); });
  store.getState().addChatMessage("Sender", "@Receiver old pending delivery");
  await gate.entered.promise;
  await client.callTool({ name: "session_close", arguments: { session: "receiver", confirm: true } });
  expect(signal.aborted).toBe(true);
  const replacement = await create("receiver");
  replacement.getState().addChatMessage("Sender", "@Receiver replacement baseline");
  expect(agent.sessionSignal("receiver")).not.toBe(signal);
  gate.release.resolve();
  await turn();
  expect(updates).toEqual([]);
  await client.subscribeResource({ uri });
  await changeAndRearm(agent, () => replacement.getState().addChatMessage("Sender", "@Receiver replacement live"));
  expect(updates).toEqual([{ method: "notifications/resources/updated", params: { uri } }]);
});

test("an overlapping unsubscribe and resubscribe does not let old cleanup remove the new subscription", async () => {
  const { agent, client, updates, create } = await fixture();
  const store = await create("receiver");
  await client.subscribeResource({ uri });
  const oldSignal = agent.lastWaitSignal!;
  const gate = agent.pauseNextResult();
  cleanups.unshift(async () => { gate.release.resolve(); });
  store.getState().addChatMessage("Sender", "@Receiver pending old result");
  await gate.entered.promise;
  const aborted = new Promise<void>(resolve => oldSignal.addEventListener("abort", () => resolve(), { once: true }));
  const unsubscribed = client.unsubscribeResource({ uri });
  await aborted;
  await client.subscribeResource({ uri });
  gate.release.resolve();
  await unsubscribed;
  await changeAndRearm(agent, () => store.getState().addChatMessage("Sender", "@Receiver new subscription"));
  expect(updates).toEqual([{ method: "notifications/resources/updated", params: { uri } }]);
});

test("transport close composes owner cleanup and terminates all sixteen live subscriptions", async () => {
  const { agent, server, client, updates, create, closes } = await fixture();
  const stores: ParticipantStore[] = [];
  for (let index = 0; index < 16; index++) {
    const name = `receiver${index}`;
    stores.push(await create(name));
    await client.subscribeResource({ uri: `pillowfort://sessions/${name}/mentions` });
  }
  expect(agent.pendingWaits).toBe(16);
  await client.close();
  await turn();
  expect(closes()).toBe(1);
  expect(agent.pendingWaits).toBe(0);
  for (const store of stores) store.getState().addChatMessage("Sender", "@Receiver closed connection");
  await turn();
  expect(updates).toEqual([]);
  await server.close();
  expect(closes()).toBe(1);
});
