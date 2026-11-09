import { expect, test } from "bun:test";
import { z } from "zod";
import { createAgentMcpHandler } from "../scripts/agent-mcp.mjs";
import { ObservedHostedAgent, envelope, PROTOCOL, turn } from "./mcp-wire";

class TaskStorage {
  readonly records = new Map<string, unknown>();
  async get(key: string) { return structuredClone(this.records.get(key)); }
  async put(key: string, value: unknown) { this.records.set(key, structuredClone(value)); }
  async delete(key: string) { return this.records.delete(key); }
  async list({ prefix }: { prefix: string }) { return new Map([...this.records].filter(([key]) => key.startsWith(prefix))); }
}

async function fixture() {
  const agent = new ObservedHostedAgent({ baseURL: "http://localhost:3000", createWebSocket: () => { throw new Error("Transport tests do not open a relay socket"); } });
  const taskStore = new TaskStorage();
  const handler = createAgentMcpHandler({ agent, includeCMS: false, taskStore });
  let id = 0;
  const request = async (method: string, params: Record<string, unknown> = {}, tasks = true) => {
    const meta = envelope();
    if (tasks) meta["io.modelcontextprotocol/clientCapabilities"] = { extensions: { "io.modelcontextprotocol/tasks": {} } };
    const name = method === "tools/call" ? params.name : method.startsWith("tasks/") ? params.taskId : undefined;
    const response = await handler.fetch(new Request("https://pillowfort.invalid/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, "Mcp-Method": method, ...(typeof name === "string" ? { "Mcp-Name": name } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: meta } }),
    }));
    return z.object({ result: z.record(z.string(), z.unknown()).optional(), error: z.unknown().optional() }).parse(await response.json());
  };
  const created = await request("tools/call", { name: "session_create", arguments: {} });
  const session = z.object({ structuredContent: z.object({ data: z.object({ session: z.string() }) }) }).parse(created.result).structuredContent.data.session;
  const store = agent.store(session);
  store.setState({ screen: "chat", roomId: "f-aaaaaaaaaa", name: "Receiver", members: ["Receiver", "Sender"] });
  const cursor = z.object({ cursor: z.string() }).parse((await agent.observe(session)).attention).cursor;
  const close = async () => { await handler.close(); await agent.close(); };
  return { agent, handler, taskStore, request, session, store, cursor, close };
}

test("MCP task completes on a real participant mention without persisting plaintext", async () => {
  const f = await fixture();
  try {
    const response = await f.request("tools/call", { name: "room_next_event", arguments: { session: f.session, input: { cursor: f.cursor, types: ["mention"] } } });
    expect(response.error).toBeUndefined();
    const task = z.object({ resultType: z.literal("task"), taskId: z.string(), status: z.literal("working") }).parse(response.result);
    expect(JSON.stringify([...f.taskStore.records.values()])).not.toContain("private message");
    f.store.getState().addChatMessage("Sender", "@Receiver private message");
    await turn();
    const completed = await f.request("tasks/get", { taskId: task.taskId });
    expect(completed.error).toBeUndefined();
    expect(completed.result).toMatchObject({ status: "completed", result: { structuredContent: { data: { ready: true, requiresRead: true, types: ["mention"] } } } });
    expect(JSON.stringify([...f.taskStore.records.values()])).not.toContain("private message");
    const read = await f.request("tools/call", { name: "room_next_event", arguments: { session: f.session, input: { cursor: f.cursor, types: ["mention"], timeoutMs: 0 } } });
    expect(read.result).toMatchObject({ structuredContent: { data: { events: [{ type: "mention", data: { text: "@Receiver private message" } }] } } });
  } finally { await f.close(); }
});

test("task cancellation is terminal and another owner cannot retrieve it", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const response = await f.request("tools/call", { name: "room_next_event", arguments: { session: f.session, input: { cursor: f.cursor, types: ["mention"] } } });
    const task = z.object({ taskId: z.string() }).parse(response.result);
    expect((await other.request("tasks/get", { taskId: task.taskId })).error).toBeDefined();
    expect((await f.request("tasks/cancel", { taskId: task.taskId })).error).toBeUndefined();
    f.store.getState().addChatMessage("Sender", "@Receiver after cancellation");
    await turn();
    expect((await f.request("tasks/get", { taskId: task.taskId })).result).toMatchObject({ status: "cancelled" });
  } finally { await f.close(); await other.close(); }
});

test("clients without Tasks get the blocking event result; invalid waits do not create tasks", async () => {
  const f = await fixture();
  try {
    const response = await f.request("tools/call", { name: "room_next_event", arguments: { session: f.session, input: { cursor: f.cursor, types: ["mention"], timeoutMs: 1 } } }, false);
    expect(response.result).toMatchObject({ structuredContent: { data: { events: [], missed: false } } });
    expect((await f.request("tools/call", { name: "room_next_event", arguments: { session: f.session, input: { timeoutMs: -1 } } })).result).toMatchObject({ isError: true });
    expect(f.taskStore.records.size).toBe(0);
  } finally { await f.close(); }
});
