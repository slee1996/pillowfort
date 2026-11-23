// A real native browser host talks to the installed npm stdio server or the hosted Worker.
// The listener replies to one synthetic, exact mention only. A running handler is not an idle third-party model.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startLocalServer } from "../../server";
const [mode, output, entry] = process.argv.slice(2);
if (!["stdio", "hosted"].includes(mode) || !output || (mode === "stdio" && !entry))
  throw Error("Usage: bun verification/app/agents.ts stdio|hosted OUTPUT [installed npm CLI path]");
const sameName = process.argv.includes("--same-name");
const guestName = sameName ? "host2" : "RelayBot";
const service = "https://mcp.pillowfort.xyz",
  rev = "2026-07-28";
const server = mode === "stdio" ? startLocalServer(0) : null;
const origin = server ? `http://127.0.0.1:${server.port}` : "https://pillowfort.xyz";
const browser = await chromium.launch({
  args: ["--enable-features=WebMCPTesting", "--enable-blink-features=WebMCP,WebMCPTesting"],
});
const page = await browser.newPage();
const client = new Client(
  { name: "pillowfort-acceptance", version: "1" },
  { versionNegotiation: { mode: { pin: rev } } },
);
let token = "",
  session = "",
  room = "",
  sub: Awaited<ReturnType<typeof client.listen>> | null = null,
  ended = false,
  seq = 0;
const result: { mode: string; passed: string[]; errors: string[]; counts: Record<string, number> } = {
  mode,
  passed: [],
  errors: [],
  counts: {},
};
let at = "initialize";
function mark(s: string) {
  result.passed.push(s);
}
async function native(n: string, i: object = {}) {
  const v = await page.evaluate(
    async ({ n, i }) => {
      const ctx = (document as any).modelContext,
        tools = await ctx.getTools();
      const t = tools.find((x: any) => x.name === n);
      if (!t) throw Error("Native tool unavailable: " + n);
      const raw = await ctx.executeTool(t, i);
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    },
    { n, i },
  );
  if (v?.ok === false) throw Error(n + ": " + v.error.code);
  return v?.ok === true ? v.data : v;
}
async function call(n: string, args: object = {}) {
  const r: any = await client.callTool({ name: n, arguments: args });
  if (!r.structuredContent?.ok)
    throw Error(n + ": " + (r.structuredContent?.error?.code ?? "missing result"));
  return r.structuredContent.data;
}
const action = (name: string, input: object) => call(name, { session, input });
async function state(side: "host" | "guest", test: (s: any) => boolean) {
  const host = side === "host";
  let s = host ? await native("room_observe") : await call("session_observe", { session });
  const until = Date.now() + 24_000;
  while (!test(s)) {
    if (Date.now() > until) throw Error(side + " did not reach " + at);
    s = host
      ? await native("room_wait", { afterRevision: s.revision, timeoutMs: 1500 })
      : await call("session_wait", { session, afterRevision: s.revision, timeoutMs: 1500 });
  }
  return s;
}
async function taskRpc(method: string, params: Record<string, any>) {
  const name = params.name ?? params.taskId,
    r = await fetch(service + "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": rev,
        "Mcp-Method": method,
        "Mcp-Name": name,
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++seq,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": rev,
            "io.modelcontextprotocol/clientInfo": { name: "pillowfort-acceptance", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { "io.modelcontextprotocol/tasks": {} },
            },
          },
        },
      }),
    });
  const d = (await r.json()) as any;
  if (!r.ok || d.error) throw Error("Task " + method + " HTTP " + r.status + " RPC " + d.error?.code);
  return d.result;
}
try {
  at = "native browser tool registration";
  await page.goto(origin);
  await page.waitForFunction(async () =>
    ((await (document as any).modelContext.getTools()) as any[]).some((t) => t.name === "room_next_event"),
  );
  const focused = await page.evaluate(async () =>
    (await (document as any).modelContext.getTools()).map((t: any) => t.name),
  );
  assert(!focused.includes("ttt_move"));
  await page.goto(origin + "/?agent_tools=full");
  await page.waitForFunction(async () =>
    (await (document as any).modelContext.getTools()).some((t: any) => t.name === "ttt_move"),
  );
  assert((await native("participant_preflight")).advisory);
  mark("native focused/full selection and preflight");
  if (mode === "hosted") {
    at = "advisory capacity and access";
    const capacity = (await (await fetch(service + "/preflight")).json()) as any;
    assert(
      capacity.quota.activeSessions === 0 && capacity.quota.canStartFullSession,
      "Do not consume shared capacity in use",
    );
    const response = await fetch(service + "/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptManagedCustody: true }),
    });
    assert.equal(response.status, 201);
    token = ((await response.json()) as any).access_token;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
  } else
    await client.connect(
      new StdioClientTransport({ command: "node", args: [entry, "mcp", "--url", origin], stderr: "ignore" }),
    );
  at = "authenticated discovery / guides / prompts";
  const listed = await client.listTools();
  result.counts.catalog = listed.tools.length;
  assert(listed.tools.some((t) => t.name === "room_next_event"));
  assert((await client.listPrompts()).prompts.some((x) => x.name === "join_room"));
  const guide = await client.readResource({ uri: "pillowfort://agents/workflows" });
  assert(String(guide.contents[0].text).includes("admission_approve"));
  mark(at);
  at = "native encrypted host";
  const setup = await native("room_setup", { displayName: "Host", confirm: true });
  room = setup.roomId;
  await state("host", (s) => s.connection.roomId === room && s.legalActions.canAct);
  mark(at);
  at = "exact admission";
  session = (await call("session_create")).session;
  await action("room_join_link", {
    displayName: sameName ? "host" : guestName,
    invitationUrl: setup.invitationUrl,
    confirm: true,
  });
  const guestPending = await state("guest", (s) => !!s.room.pendingJoinFingerprint);
  const hostPending = await state("host", (s) =>
    s.room.pendingAdmissions.some(
      (a: any) => a.status === "pending" && a.deviceFingerprint === guestPending.room.pendingJoinFingerprint,
    ),
  );
  const chosen = hostPending.room.pendingAdmissions.find(
    (a: any) => a.deviceFingerprint === guestPending.room.pendingJoinFingerprint,
  );
  assert(chosen.expiresAt > Date.now());
  await native("admission_approve", {
    roomId: room,
    admissionId: chosen.admissionId,
    deviceFingerprint: chosen.deviceFingerprint,
    confirm: true,
  });
  const s = await state("guest", (s) => s.connection.roomId === room && s.legalActions.canAct);
  assert.equal(s.connection.name, guestName);
  await state("host", (s) => s.room.members.some((m: any) => m.name === guestName));
  mark(at);
  at = "subscribe and reconcile baseline";
  const uri = `pillowfort://sessions/${session}/mentions`;
  const marker = `@${guestName} release check`,
    reply = "Acknowledged the release check";
  const notified = Promise.withResolvers<void>();
  void notified.promise.catch(() => {});
  let task: any;
  let started = false;
  client.setNotificationHandler("notifications/resources/updated", async ({ params }) => {
    if (params.uri !== uri || started) return;
    try {
      assert(Object.keys(params).every((k) => k === "uri" || k === "_meta"));
      const r: any = await client.readResource({ uri });
      assert.equal(r.ttlMs, 0);
      assert.equal(r.cacheScope, "private");
      const mentions = JSON.parse(r.contents[0].text);
      if (!mentions.messages.some((m: any) => m.text === marker && m.from === "Host")) return;
      started = true;
      await action("chat_send", { roomId: room, text: reply });
      notified.resolve();
    } catch (e) {
      notified.reject(e);
    }
  });
  sub = await client.listen({ resourceSubscriptions: [uri] });
  assert(sub.honoredFilter.resourceSubscriptions?.includes(uri));
  const base: any = await client.readResource({ uri });
  assert.equal(JSON.parse(base.contents[0].text).messages.length, 0);
  if (sameName) {
    const oldAddress = "@Host original address only";
    await native("chat_send", { roomId: room, text: oldAddress });
    await state("guest", s => s.messages.some((m: any) => m.text === oldAddress));
    const privateRead: any = await client.readResource({ uri });
    assert.equal(JSON.parse(privateRead.contents[0].text).messages.length, 0);
    mark("original name visible in chat but absent from new guest's mention resource");
  }
  mark(at);
  if (mode === "hosted") {
    at = "cancel independent Task";
    const make = () =>
      taskRpc("tools/call", {
        name: "room_next_event",
        arguments: { session, input: { cursor: s.attention.cursor, types: ["mention"] } },
      });
    const cancelled = await make();
    assert.equal(cancelled.status, "working");
    await taskRpc("tasks/cancel", { taskId: cancelled.taskId });
    assert.equal((await taskRpc("tasks/get", { taskId: cancelled.taskId })).status, "cancelled");
    task = await make();
    assert.equal(task.status, "working");
    mark(at);
  }
  at = "notification-driven private read and reply";
  await native("chat_send", { roomId: room, text: marker });
  let stop;
  try {
    await Promise.race([
      notified.promise,
      new Promise((_, reject) => {
        stop = setTimeout(() => reject(Error("No subscribed mention/reply")), 22_000);
      }),
    ]);
  } finally {
    clearTimeout(stop);
  }
  const delivered = await state("host", (s) =>
    s.messages.some((m: any) => m.text === reply && m.from === guestName),
  );
  assert.equal(delivered.messages.filter((m: any) => m.text === reply && m.from === guestName).length, 1);
  mark(at);
  if (task) {
    at = "independent Task fan-out and cursor read";
    let current = task;
    const until = Date.now() + 20_000;
    while (current.status === "working" && Date.now() < until) {
      await Bun.sleep(current.pollIntervalMs ?? 1000);
      current = await taskRpc("tasks/get", { taskId: task.taskId });
    }
    assert.equal(current.status, "completed");
    const meta = current.result.structuredContent.data;
    assert(meta.requiresRead && !JSON.stringify(current).includes(marker));
    const res = await action("room_next_event", {
      cursor: meta.readCursor,
      types: ["mention"],
      timeoutMs: 0,
    });
    assert(res.events.some((e: any) => e.type === "mention" && e.data.text === marker));
    mark(at);
  }
  at = "cancel listen without losing identity";
  await sub.close();
  sub = null;
  assert((await call("session_observe", { session })).legalActions.canAct);
  mark(at);
  at = "encrypted drawing and browser PNG export";
  await native("drawing_open", { roomId: room });
  await action("drawing_send", {
    roomId: room,
    color: "#0000FF",
    pts: [
      [0.2, 0.3],
      [0.5, 0.6],
    ],
  });
  await state("host", (s) => s.drawings.some((d: any) => d.color === "#0000FF"));
  const png = await native("drawing_export_png", { roomId: room });
  assert(
    Object.values(png).some((v) => typeof v === "string" && /^(data:image\/png;base64,)?iVBORw0KGgo/.test(v)),
  );
  mark(at);
  at = "terminal room observation";
  await native("room_end", { roomId: room, confirm: true });
  await state(
    "guest",
    (s) => s.connection.terminalPresentation === "room-destroyed" && s.connection.roomId === null,
  );
  ended = true;
  mark(at);
} catch (e) {
  const msg = (e as Error).message
    .split("\n")[0]
    .replace(/https?:\/\/\S+|pf[23]_[\w-]+|f-[a-z2-7]{10}|[\w-]{40,}/g, "[redacted]");
  result.errors.push(`${at}: ${msg}`);
} finally {
  try {
    await sub?.close();
  } catch {
    result.errors.push("subscription cleanup failed");
  }
  if (room && !ended) {
    try {
      const s = await native("room_observe");
      if (s.connection.roomId === room && s.connection.isHost)
        await native("room_end", { roomId: room, confirm: true });
    } catch {
      result.errors.push("owned room cleanup unconfirmed");
    }
  }
  if (session) {
    try {
      await call("session_close", { session, confirm: true });
      mark("participant closed");
    } catch {
      result.errors.push("participant cleanup failed");
    }
  }
  await client.close().catch(() => {});
  if (token) {
    try {
      const r = await fetch(service + "/mcp/access", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      assert(r.ok);
      mark("grant revoked");
    } catch {
      result.errors.push("grant cleanup failed");
    }
  }
  await browser.close();
  server?.stop(true);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
}
if (result.errors.length) process.exitCode = 1;
