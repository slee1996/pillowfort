import { expect } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { runAgentMcp } from "../scripts/agent-mcp.mjs";
import { PillowfortHostedAgent } from "../src/participant/hostedAgent";
import type { ParticipantStore } from "../src/participant/gameStore";
import type { AgentSnapshot } from "../src/participant/agent";

export const PROTOCOL = "2026-07-28";
export const SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";
export const turn = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};
export const mentionUri = (session: string) => `pillowfort://sessions/${session}/mentions`;
export const envelope = () => ({
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "pillowfort-wire-regression", version: "1.0.0" },
});
const wireMessageSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.number(), z.string()]).optional(), method: z.string().optional(),
  params: z.looseObject({
    uri: z.string().optional(), _meta: z.record(z.string(), z.unknown()).optional(),
    notifications: z.object({ resourceSubscriptions: z.array(z.string()).optional() }).optional(),
  }).optional(),
  result: z.record(z.string(), z.unknown()).optional(), error: z.unknown().optional(),
});
export type WireMessage = z.infer<typeof wireMessageSchema>;
export interface Deferred { promise: Promise<void>; resolve(): void }
export function deferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

// Only scheduling is instrumented; receipts, snapshots and waits remain production code.
export class ObservedHostedAgent extends PillowfortHostedAgent {
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
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = () => {
      if (this.waitCount <= count) return;
      this.started.delete(wake);
      resolve();
    };
    this.started.add(wake);
    wake();
    await promise;
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
    const internals = this as unknown as { sessions: Map<string, { runtime: { controller: { store: ParticipantStore } } }> };
    const session = internals.sessions.get(name);
    if (!session) throw new Error("Missing real participant session");
    return session.runtime.controller.store;
  }
}

export class StdioWire {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly diagnostics = new PassThrough();
  readonly messages: WireMessage[] = [];
  readonly agent: ObservedHostedAgent;
  readonly finished: Promise<void>;
  private pending = new Set<() => void>();
  private nextId = 0;

  constructor() {
    this.agent = new ObservedHostedAgent({
      baseURL: "http://localhost:3000", maxSessions: 16,
      createWebSocket: () => { throw new Error("Receipt tests must not open a relay socket"); },
    });
    let buffer = "";
    this.output.on("data", chunk => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.messages.push(wireMessageSchema.parse(JSON.parse(line)));
      }
      for (const wake of [...this.pending]) wake();
    });
    this.finished = runAgentMcp({ agent: this.agent, input: this.input, output: this.output, diagnostics: this.diagnostics });
  }

  send(method: string, params: Record<string, unknown> = {}, id: number | string = ++this.nextId) {
    this.input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope() } }) + "\n");
    return id;
  }

  async waitFor(predicate: (message: WireMessage) => boolean, after = 0): Promise<WireMessage> {
    const find = () => this.messages.slice(after).find(predicate);
    const found = find();
    if (found) return found;
    const { promise, resolve, reject } = Promise.withResolvers<WireMessage>();
    const timer = setTimeout(() => {
      this.pending.delete(wake);
      reject(new Error(`No matching wire message: ${JSON.stringify(this.messages.slice(after))}`));
    }, 1500);
    const wake = () => {
      const message = find();
      if (!message) return;
      clearTimeout(timer);
      this.pending.delete(wake);
      resolve(message);
    };
    this.pending.add(wake);
    wake();
    return promise;
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    const id = this.send(method, params);
    return this.waitFor(message => message.id === id);
  }

  async result(method: string, params: Record<string, unknown> = {}) {
    const message = await this.request(method, params);
    expect(message.error).toBeUndefined();
    return z.record(z.string(), z.unknown()).parse(message.result);
  }

  async tool(name: string, args: Record<string, unknown> = {}) {
    return this.result("tools/call", { name, arguments: args });
  }

  async create(displayName = "Receiver") {
    const result = await this.tool("session_create");
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true, data: { state: "ready" } });
    const { session } = z.object({ data: z.object({ session: z.string() }) }).parse(result.structuredContent).data;
    expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const store = this.agent.store(session);
    store.setState({ screen: "chat", roomId: "f-aaaaaaaaaa", name: displayName, members: [displayName, "Sender", "Other"] });
    return { session, store, uri: mentionUri(session) };
  }

  async listen(uris: string[] = [], id: number | string = `listen-${++this.nextId}`) {
    this.send("subscriptions/listen", { notifications: { resourceSubscriptions: uris } }, id);
    const ack = await this.waitFor(message => message.id === id || (message.method === "notifications/subscriptions/acknowledged" && message.params?._meta?.[SUBSCRIPTION] === id));
    expect(ack.error).toBeUndefined();
    expect(ack.method).toBe("notifications/subscriptions/acknowledged");
    expect(ack.params?.notifications?.resourceSubscriptions ?? []).toEqual(uris);
    return id;
  }

  cancel(id: number | string) {
    this.input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, _meta: envelope() } }) + "\n");
  }

  updates() { return this.messages.filter(message => message.method === "notifications/resources/updated"); }

  async close() {
    this.input.end();
    await this.finished;
    this.output.destroy();
    this.diagnostics.destroy();
  }
}

export async function changeAndRearm(agent: ObservedHostedAgent, change: () => void) {
  const count = agent.waitCount;
  change();
  await agent.afterWait(count);
  await turn();
}
