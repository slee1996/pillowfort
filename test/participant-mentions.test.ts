import { describe, expect, test } from "bun:test";
import { toBase64Url } from "../src/roomAuth";
import { createSecureRoomStateV4, type SecureReducerEffectV4 } from "../src/secureGameReducer";
import { createParticipantAgent, type AgentSnapshot } from "../src/participant/agent";
import { MemoryCryptoStateStore } from "../src/participant/cryptoStateStore";
import { ParticipantEvents } from "../src/participant/events";
import { createParticipantStore } from "../src/participant/gameStore";
import { findMentions, formatMention } from "../src/participant/mentions";
import { MemoryRoomCryptoLockCoordinator } from "../src/participant/roomCryptoLock";
import { SecureRoomController } from "../src/participant/secureRoomController";
import { createSecureRoomUiV4 } from "../src/participant/secureUiV4";

const encoded = (length: number, byte: number) => toBase64Url(new Uint8Array(length).fill(byte));
const ALICE = encoded(16, 1);
const BOB = encoded(16, 2);
function fixture() {
  const store = createParticipantStore();
  store.getState().setName("alice");
  const events = new ParticipantEvents();
  const cryptoStore = new MemoryCryptoStateStore();
  const locks = new MemoryRoomCryptoLockCoordinator();
  const controller = new SecureRoomController({
    store, events, cryptoStore, lockCoordinator: locks,
    location: { protocol: "https:", host: "pillowfort.invalid" },
    createWebSocket: url => new WebSocket(url),
  });
  const state = createSecureRoomStateV4(encoded(16, 3), [
    { deviceId: ALICE, signaturePublicKey: encoded(32, 1), displayName: "alice" },
    { deviceId: BOB, signaturePublicKey: encoded(32, 2), displayName: "bob" },
  ], ALICE);
  const ui = createSecureRoomUiV4(store, events);
  ui.initializeSecureRoomUiV4({ roomId: "f-aaaaaaaaaa", ownDeviceId: ALICE, state });
  const agent = createParticipantAgent({ store, controller, events, origin: "https://pillowfort.invalid", identityStorage: "isolated-memory" });
  const close = async () => {
    agent.dispose();
    await controller.dispose();
    locks.close();
    await cryptoStore.close();
    events.clear();
  };
  return { store, state, ui, agent, close };
}

type MentionFeed = {
  latestMessageId: number;
  messages: { id: number; from: string; text: string; timestamp: string; mentions: string[] }[];
  retainedCount: number;
  liveOnly: boolean;
};
const feed = (snapshot: AgentSnapshot) => snapshot.mentions as unknown as MentionFeed;
const chat = (eventId: string, text: string, own = false): SecureReducerEffectV4 => ({
  type: "chat", eventId, deviceId: own ? ALICE : BOB, displayName: own ? "alice" : "bob", text, style: null,
});

describe("exact targeted mention syntax", () => {
  test("matches full plain Unicode tokens, exact case and literal roster names only", () => {
    const text = "(@Ann), @Ann-Marie @Ann_2 @李四 @everyone @ann @Annabelle @missing";
    expect(findMentions(text, ["Ann", "Ann-Marie", "Ann_2", "李四", "everyone"]).map(token => token.name))
      .toEqual(["Ann", "Ann-Marie", "Ann_2", "李四", "everyone"]);
    expect(findMentions("@everyone", ["Ann"])).toEqual([]);
    expect(findMentions("@Ann-Marie @Ann_2 @Annabelle", ["Ann"])).toEqual([]);
  });

  test("rejects email and embedded-word/prefix false positives", () => {
    for (const text of ["x@alice", "é@alice", "e\u0301@alice", "a.b@alice", "a+@alice", "_@alice", "-@alice", "@@alice", "@alice@example.test", "@alice.example", '@"Alice B"suffix']) {
      expect(findMentions(text, ["alice", "Alice B"])).toEqual([]);
    }
    expect(findMentions("hello @alice. (@alice)!", ["alice"]).map(token => token.name)).toEqual(["alice", "alice"]);
    expect(findMentions("𐐀@alice", ["alice"])).toEqual([]);
  });

  test("normalizes identities without changing original UTF-16 offsets", () => {
    const text = "🛏️ @Jose\u0301 and @𐐀";
    const tokens = findMentions(text, ["José", "𐐀"]);
    expect(tokens).toEqual([
      { start: text.indexOf("@Jose"), end: text.indexOf(" and"), name: "José" },
      { start: text.lastIndexOf("@"), end: text.length, name: "𐐀" },
    ]);
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe("@Jose\u0301");
    expect(findMentions("@José", ["Jose\u0301"])[0].name).toBe("José");
  });

  test("round-trips spaced and punctuated names with JSON escaping", () => {
    for (const name of ["alice", "Jean-Luc", "李四", "Alice B", 'A "quote"', "a\\b", "a.b", "a@b", "name🙂", "q\u0307"]) {
      const mention = formatMention(name);
      expect(findMentions(mention, [name])).toEqual([{ start: 0, end: mention.length, name: name.normalize("NFC") }]);
    }
    expect(formatMention("Jose\u0301")).toBe("@José");
    expect(findMentions('@"Alice\\u0020B"', ["Alice B"])[0].name).toBe("Alice B");
    expect(findMentions("@Alice B", ["Alice B"])).toEqual([]);
    expect(findMentions("@a.b", ["a.b"])).toEqual([]);
  });

  test("treats malformed quoted targets as invalid tokens, never nested mentions", () => {
    expect(findMentions('@"bad\\q @alice" @alice', ["alice"])).toEqual([{ start: 16, end: 22, name: "alice" }]);
    expect(findMentions('@"unterminated @alice', ["alice"])).toEqual([]);
    expect(findMentions('@"line\n@alice"', ["alice"])).toEqual([]);
    expect(findMentions('@"\\ud800"', ["alice"])).toEqual([]);
    expect(findMentions("@".repeat(2000), ["alice"])).toEqual([]);
    expect(findMentions("\ud800@alice", ["alice"])).toEqual([{ start: 1, end: 7, name: "alice" }]);
  });
});

describe("receipt metadata and bounded agent mention observations", () => {
  test("stores deduplicated receipt-time targets and preserves message IDs/styles", () => {
    const store = createParticipantStore();
    const state = store.getState();
    state.setMembers(["alice", "Alice B", "bob"]);
    state.addChatMessage("bob", '@alice @alice @"Alice B" @missing', { bold: true, color: "#FF0000" });
    const message = store.getState().messages[0];
    expect(message).toMatchObject({ id: 1, kind: "chat", from: "bob", mentions: ["alice", "Alice B"], style: { bold: true, color: "#FF0000" } });
    expect(message.timestamp).toBeString();
    state.setMembers(["bob", "missing"]);
    expect(store.getState().messages[0]).toBe(message);
    expect(findMentions(message.text, message.mentions ?? []).map(token => token.name)).toEqual(["alice", "alice", "Alice B"]);
    state.addChatMessage("bob", "@alice @missing");
    expect(store.getState().messages[1]).toMatchObject({ id: 2, mentions: ["missing"] });
  });

  test("wakes existing consumers for fresh mentions and exposes read-only history metadata", async () => {
    const f = fixture();
    try {
      const before = f.agent.observe();
      const pending = f.agent.waitForChange(before.revision, 30_000);
      f.ui.applySecureRoomUiV4(f.state, [chat("fresh", "hi @alice")], ALICE);
      let snapshot = await pending;
      expect(snapshot.revision).toBeGreaterThan(before.revision);
      // Projection changes may wake a revision wait before its chat effect is applied.
      while (feed(snapshot).latestMessageId === 0) snapshot = await f.agent.waitForChange(snapshot.revision, 30_000);
      const message = f.store.getState().messages[0];
      expect(feed(snapshot)).toEqual({ latestMessageId: message.id, messages: [{ id: message.id, from: "bob", text: "hi @alice", timestamp: message.timestamp, mentions: ["alice"] }], retainedCount: 1, liveOnly: true });
      expect(snapshot.messages).toEqual(expect.arrayContaining([expect.objectContaining({ mentions: ["alice"] })]));
      const history = await f.agent.execute("chat_history_export", {});
      expect(history).toMatchObject({ ok: true, data: { messages: [{ mentions: ["alice"] }] } });
      expect(f.agent.observe().revision).toBe(snapshot.revision);
      const copy = feed(f.agent.observe());
      copy.messages[0].mentions.push("injected");
      expect(feed(f.agent.observe()).messages[0].mentions).toEqual(["alice"]);
      expect(f.agent.observe().revision).toBe(snapshot.revision);
    } finally { await f.close(); }
  });

  test("never promotes self, muted, duplicate or replayed content into fresh mentions", async () => {
    const f = fixture();
    try {
      f.ui.applySecureRoomUiV4(f.state, [chat("self", "@alice", true)], ALICE);
      expect(feed(f.agent.observe()).retainedCount).toBe(0);
      f.store.getState().toggleMute("bob");
      const mutedRevision = f.agent.observe().revision;
      f.store.getState().addChatMessage("bob", "@alice direct muted receipt");
      expect(f.agent.observe().revision).toBe(mutedRevision);
      f.ui.applySecureRoomUiV4(f.state, [chat("muted", "@alice muted projection")], ALICE);
      f.store.getState().toggleMute("bob");
      f.ui.applySecureRoomUiV4(f.state, [chat("muted", "@alice muted projection")], ALICE);
      expect(feed(f.agent.observe()).latestMessageId).toBe(0);
      f.ui.applySecureRoomUiV4(f.state, [chat("backlog", "@alice historical resume")], ALICE, true);
      expect(f.store.getState().messages.at(-1)).toMatchObject({ replayed: true, mentions: ["alice"] });
      expect(feed(f.agent.observe()).latestMessageId).toBe(0);
      f.ui.applySecureRoomUiV4(f.state, [chat("after-resume", "@alice live after resume")], ALICE);
      const fresh = feed(f.agent.observe());
      expect(fresh.messages.map(message => message.text)).toEqual(["@alice live after resume"]);
      f.ui.applySecureRoomUiV4(f.state, [chat("after-resume", "@alice live after resume")], ALICE);
      expect(feed(f.agent.observe())).toEqual(fresh);
      f.store.getState().toggleMute("bob");
      expect(feed(f.agent.observe())).toEqual(fresh);
      f.store.getState().toggleMute("bob");
      f.store.getState().setMembers(["alice"]);
      expect(feed(f.agent.observe())).toEqual(fresh);
    } finally { await f.close(); }
  });

  test("bounds by row count and UTF-8 bytes while retaining the newest matching cursor", async () => {
    const f = fixture();
    try {
      for (let index = 0; index < 20; index++) f.store.getState().addChatMessage("bob", `@alice ${index}`);
      const short = feed(f.agent.observe());
      expect(short.retainedCount).toBe(20);
      expect(short.messages).toHaveLength(16);
      expect(short.messages[0].text).toBe("@alice 4");
      const large = `@alice ${"🙂".repeat(1993)}`;
      for (let index = 0; index < 4; index++) f.store.getState().addChatMessage("bob", large);
      const bounded = feed(f.agent.observe());
      expect(bounded.retainedCount).toBe(24);
      expect(bounded.latestMessageId).toBe(f.store.getState().messages.at(-1)!.id);
      expect(bounded.messages.length).toBeLessThan(4);
      expect(new TextEncoder().encode(JSON.stringify(bounded.messages)).byteLength).toBeLessThanOrEqual(16 * 1024);
      for (let index = 0; index < 512; index++) f.store.getState().addChatMessage("bob", "ordinary chat");
      expect(feed(f.agent.observe())).toEqual({ latestMessageId: 0, messages: [], retainedCount: 0, liveOnly: true });
      expect(f.store.getState().messages).toHaveLength(512);
    } finally { await f.close(); }
  });

  test("clears attention history atomically across rooms and keeps local IDs monotonic", async () => {
    const f = fixture();
    try {
      f.store.getState().addChatMessage("bob", "@alice room one");
      const before = f.agent.observe();
      const previousId = feed(before).latestMessageId;
      const changed = f.agent.waitForChange(before.revision, 30_000);
      f.store.getState().setRoomId("f-bbbbbbbbbb");
      expect(feed(await changed).messages).toEqual([]);
      expect(f.agent.observe().messages).toEqual([]);
      f.store.getState().addChatMessage("bob", "@alice room two");
      expect(feed(f.agent.observe()).latestMessageId).toBeGreaterThan(previousId);
      f.store.getState().clearMessages();
      expect(feed(f.agent.observe()).retainedCount).toBe(0);
      f.store.getState().addChatMessage("bob", "@alice before cleanup");
      f.store.getState().cleanup();
      expect(feed(f.agent.observe())).toEqual({ latestMessageId: 0, messages: [], retainedCount: 0, liveOnly: true });
    } finally { await f.close(); }
  });
});

describe("cancellable participant change waits", () => {
  test("cancels without state changes, releases bounded slots and permits rearming", async () => {
    const f = fixture();
    try {
      const before = f.agent.observe();
      for (let index = 0; index < 80; index++) {
        const pending = f.agent.waitForChange(before.revision, 30_000, "subscription");
        f.agent.cancelWait("subscription");
        expect(await pending).toEqual(before);
      }
      const waits = Array.from({ length: 64 }, (_, index) => f.agent.waitForChange(before.revision, 30_000, `wait-${index}`));
      await expect(f.agent.waitForChange(before.revision, 30_000, "overflow")).rejects.toMatchObject({ code: "busy" });
      f.agent.cancelWait("wait-0");
      await waits[0];
      const replacement = f.agent.waitForChange(before.revision, 30_000, "replacement");
      f.agent.cancelWait("replacement");
      expect(await replacement).toEqual(before);
      for (let index = 1; index < 64; index++) f.agent.cancelWait(`wait-${index}`);
      await Promise.all(waits);
      expect(f.agent.observe()).toEqual(before);
    } finally { await f.close(); }
  });

  test("validates IDs, preserves the original on duplicates and cleans up after change/dispose", async () => {
    const f = fixture();
    try {
      const before = f.agent.observe();
      for (const id of ["", "x".repeat(129)]) await expect(f.agent.waitForChange(before.revision, 30_000, id)).rejects.toMatchObject({ code: "invalid-input" });
      const pending = f.agent.waitForChange(before.revision, 30_000, "same");
      await expect(f.agent.waitForChange(before.revision, 30_000, "same")).rejects.toMatchObject({ code: "busy" });
      f.store.getState().addChatMessage("bob", "@alice wakes waiting subscriber");
      expect(feed(await pending).retainedCount).toBe(1);
      const next = f.agent.observe();
      const rearmed = f.agent.waitForChange(next.revision, 30_000, "same");
      f.agent.cancelWait("unknown");
      f.agent.cancelWait("same");
      expect(await rearmed).toEqual(next);
      expect(await f.agent.waitForChange(next.revision, 0, "same")).toEqual(next);
      expect(await f.agent.waitForChange(next.revision, 1, "same")).toEqual(next);
      const closing = f.agent.waitForChange(next.revision, 30_000, "same");
      f.agent.dispose();
      expect((await closing).revision).toBeGreaterThan(next.revision);
      f.agent.cancelWait("same");
      expect(feed(f.agent.observe()).messages).toEqual([]);
    } finally { await f.close(); }
  });
});
