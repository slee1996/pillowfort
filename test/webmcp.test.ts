import { afterEach, describe, expect, test } from "bun:test";
import { installPillowfortWebMcp } from "../client/src/agent/webmcp";
import { createParticipantAgent } from "../src/participant/agent";
import { MemoryCryptoStateStore } from "../src/participant/cryptoStateStore";
import { ParticipantEvents } from "../src/participant/events";
import { createParticipantStore } from "../src/participant/gameStore";
import { MemoryRoomCryptoLockCoordinator } from "../src/participant/roomCryptoLock";
import { SecureRoomController } from "../src/participant/secureRoomController";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function participant() {
  const store = createParticipantStore();
  const events = new ParticipantEvents();
  const cryptoStore = new MemoryCryptoStateStore();
  const lockCoordinator = new MemoryRoomCryptoLockCoordinator();
  const controller = new SecureRoomController({
    store, events, cryptoStore, lockCoordinator,
    location: { protocol: "http:", host: "localhost:3000" },
    createWebSocket: () => { throw new Error("Invalid native actions must not open a socket"); },
  });
  const agent = createParticipantAgent({ store, events, controller, origin: "http://localhost:3000", identityStorage: "isolated-memory" });
  const tools = new Map<string, { execute(input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> }>();
  const registration = installPillowfortWebMcp(agent, {
    source: "document",
    context: { registerTool(tool) { tools.set(tool.name, tool); } },
  });
  cleanups.push(async () => {
    registration.dispose();
    agent.dispose();
    await controller.dispose();
    await cryptoStore.close();
    lockCoordinator.close();
    events.clear();
  });
  await registration.ready;
  const invoke = (name: string, input: unknown, options?: { signal?: AbortSignal }) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Native tool ${name} was not registered`);
    return tool.execute(input, options);
  };
  return { store, agent, invoke };
}

describe("native WebMCP action outcomes", () => {
  test("preserves stale-room rejection without mutating the participant", async () => {
    const { store, agent, invoke } = await participant();
    store.setState({ screen: "chat", roomId: "f-aaaaaaaaaa", name: "Host", isHost: true });
    const before = agent.observe();
    const result = await invoke("chat_send", { roomId: "f-bbbbbbbbbb", text: "Not for this room" });
    expect(result).toMatchObject({ ok: false, error: { code: "stale-room", retryable: false } });
    const after = agent.observe();
    expect(after.connection).toEqual(before.connection);
    expect(after.operations).toEqual(before.operations);
    expect(after.messages).toEqual(before.messages);
  });

  test("returns actionable validation errors for snapshot tools", async () => {
    const { agent, invoke } = await participant();
    const before = agent.observe();
    const result = await invoke("room_wait", { afterRevision: -1 });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-input", retryable: false } });
    expect(agent.observe().revision).toBe(before.revision);
    const snapshot = await invoke("room_observe", {});
    expect(snapshot).toMatchObject({ connection: { roomId: null }, operations: [] });
  });

  test("cancelled native mutations never start room setup", async () => {
    const { agent, invoke } = await participant();
    const cancellation = new AbortController();
    cancellation.abort();
    const result = await invoke("room_setup", { displayName: "Host", confirm: true }, { signal: cancellation.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled", retryable: false } });
    const snapshot = agent.observe();
    expect(snapshot.connection).toMatchObject({ roomId: null, connecting: false });
    expect(snapshot.operations).toEqual([]);
  });

  test("receiver verification excludes old duplicates, other senders and local echoes", async () => {
    const { store, invoke } = await participant();
    const roomId = "f-aaaaaaaaaa";
    store.setState({ screen: "chat", roomId, name: "Receiver" });
    store.getState().addChatMessage("Sender", "Repeated text");
    const afterMessageId = store.getState().messages[0].id;
    const input = { roomId, from: "Sender", text: "Repeated text", afterMessageId };
    expect(await invoke("chat_verify_received", input)).toMatchObject({ ok: true, data: { status: "not-observed", messageId: null } });
    store.getState().addChatMessage("Other", "Repeated text");
    expect(await invoke("chat_verify_received", input)).toMatchObject({ ok: true, data: { status: "not-observed" } });
    expect(await invoke("chat_verify_received", { ...input, from: "Receiver" })).toMatchObject({ ok: false, error: { code: "receiver-required" } });
    store.getState().addChatMessage("Sender", "Repeated text");
    expect(await invoke("chat_verify_received", input)).toMatchObject({ ok: true, data: { status: "received", receiver: "Receiver", from: "Sender", messageId: afterMessageId + 2 } });
  });

  test("receiver verification rejects wrong scope and reports missing retained history as unknown", async () => {
    const { store, agent, invoke } = await participant();
    const roomId = "f-aaaaaaaaaa";
    store.setState({ screen: "chat", roomId, name: "Receiver" });
    const input = { roomId, from: "Sender", text: "Evicted text", afterMessageId: 0 };
    expect(await invoke("chat_verify_received", { ...input, roomId: "f-bbbbbbbbbb" })).toMatchObject({ ok: false, error: { code: "stale-room" } });
    expect(await invoke("chat_verify_received", { ...input, afterMessageId: 1 })).toMatchObject({ ok: false, error: { code: "invalid-cursor" } });
    store.getState().addChatMessage("Sender", "Evicted text");
    for (let index = 0; index < 512; index++) store.getState().addChatMessage("Other", `Newer ${index}`);
    const before = agent.observe();
    expect(await invoke("chat_verify_received", input)).toMatchObject({ ok: true, data: { status: "history-unavailable", messageId: null } });
    expect(agent.observe().messages).toEqual(before.messages);
    expect(agent.observe().operations).toEqual(before.operations);
    store.setState({ roomId: null });
    expect(await invoke("chat_verify_received", input)).toMatchObject({ ok: false, error: { code: "room-closed" } });
  });
});
