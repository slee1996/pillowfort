import { beforeEach, describe, expect, it } from "bun:test";
import {
  ChatCryptoStateError,
  clearChatCryptoState,
  createRoomAuthPayload,
  decryptChatPayload,
  encryptChatPayload,
  setChatReplayStateStoreForTests,
  type ChatReplayStateStore,
} from "../client/src/services/chatCrypto";
import {
  createRoomAuthChallenge,
  normalizeAuthName,
  roomAuthProofBytes,
  validRoomAuthPayload,
  verifyRoomAuthProof,
} from "../src/roomAuth";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

class UnwritableStorage extends MemoryStorage {
  writes = 0;

  setItem(_key: string, _value: string) {
    this.writes += 1;
    throw new Error("storage unavailable");
  }
}

class MemoryReplayStateStore implements ChatReplayStateStore {
  private highWater = new Map<string, number>();
  private migrated = new Set<string>();

  async migrateLegacyReplayLedger(input: { roomId: string; roomInstance: string; rawLedger: string }) {
    if (this.migrated.has(input.roomInstance)) return { migrated: false };
    const ledger = JSON.parse(input.rawLedger) as { v?: unknown; saturated?: unknown; entries?: unknown };
    if (ledger.v !== 1 || ledger.saturated === true || !Array.isArray(ledger.entries)) throw new Error("invalid legacy ledger");
    for (const candidate of ledger.entries) {
      if (!candidate || typeof candidate !== "object") throw new Error("invalid legacy entry");
      const entry = candidate as { key?: unknown; seq?: unknown; seenAt?: unknown };
      if (typeof entry.key !== "string" || !Number.isSafeInteger(entry.seq) || typeof entry.seenAt !== "number") {
        throw new Error("invalid legacy entry");
      }
      const tuple = JSON.parse(entry.key) as unknown;
      if (!Array.isArray(tuple) || tuple.length !== 3 || entry.key !== JSON.stringify(tuple)) throw new Error("invalid legacy key");
      if (tuple[0] === input.roomId && typeof tuple[1] === "string" && typeof tuple[2] === "string") {
        const key = JSON.stringify([input.roomInstance, tuple[1], tuple[2]]);
        this.highWater.set(key, Math.max(this.highWater.get(key) || 0, entry.seq as number));
      }
    }
    this.migrated.add(input.roomInstance);
    return { migrated: true };
  }

  async advanceReplay(position: { roomInstance: string; senderId: string; sessionId: string; sequence: number }) {
    const key = JSON.stringify([position.roomInstance, position.senderId, position.sessionId]);
    const previous = this.highWater.get(key) || 0;
    if (position.sequence <= previous) {
      return { accepted: false as const, reason: "replay" as const, currentSequence: previous };
    }
    this.highWater.set(key, position.sequence);
    return { accepted: true as const, previousSequence: previous, currentSequence: position.sequence };
  }
}

const ROOM_ID = "abc12345";
const PASSWORD = "correct horse battery staple";

beforeEach(() => {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  setChatReplayStateStoreForTests(new MemoryReplayStateStore());
  clearChatCryptoState();
});

describe("room authentication protocol v2", () => {
  it("accepts only exact plain data-property authentication payloads", async () => {
    const challenge = createRoomAuthChallenge();
    const valid = await createRoomAuthPayload(ROOM_ID, PASSWORD, challenge, "set-up", "alice");

    expect(validRoomAuthPayload(valid)).toBe(true);
    expect(validRoomAuthPayload({ ...valid, role: "host" })).toBe(false);
    expect(validRoomAuthPayload({ ...valid, publicKey: undefined })).toBe(false);
    expect(validRoomAuthPayload(Object.assign(Object.create({ inherited: true }), valid))).toBe(false);
    expect(validRoomAuthPayload(Object.assign(Object.create(null), valid))).toBe(false);
    expect(validRoomAuthPayload({ ...valid, [Symbol("hidden")]: true })).toBe(false);

    let getterReads = 0;
    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, "proof", {
      enumerable: true,
      get() {
        getterReads += 1;
        return valid.proof;
      },
    });
    expect(validRoomAuthPayload(accessor)).toBe(false);
    expect(getterReads).toBe(0);

    const throwingProxy = new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });
    expect(validRoomAuthPayload(throwingProxy)).toBe(false);
  });

  it("uses one visible, canonical, scalar-safe display name for signing", () => {
    expect(normalizeAuthName("  Alice 🧸  ")).toBe("Alice 🧸");
    expect(normalizeAuthName(`${"a".repeat(23)}🧸x`)).toBe(`${"a".repeat(23)}🧸`);

    for (const dangerous of [
      "__proto__",
      "PROTOTYPE",
      "ｃｏｎｓｔｒｕｃｔｏｒ",
      "alice\u0000",
      "alice\u202e",
      "a\u200db",
      "alice\ufe0f",
      "e\u0301",
      "alice\ud800",
    ]) {
      expect(normalizeAuthName(dangerous)).toBe("");
      expect(() => roomAuthProofBytes("join", ROOM_ID, dangerous, "A", "B")).toThrow();
    }
  });

  it("stores a public setup key and verifies challenge-bound proofs", async () => {
    const challenge = createRoomAuthChallenge();
    const setup = await createRoomAuthPayload(ROOM_ID, PASSWORD, challenge, "set-up", "alice");

    expect(setup.v).toBe(2);
    expect(setup.publicKey).toHaveLength(43);
    expect((setup as unknown as Record<string, unknown>).verifier).toBeUndefined();
    expect(await verifyRoomAuthProof({
      auth: setup,
      action: "set-up",
      roomId: ROOM_ID,
      name: "alice",
      expectedChallenge: challenge,
    })).toBe(true);
  });

  it("verifies join proofs with the stored public key and rejects replay or context tampering", async () => {
    const setupChallenge = createRoomAuthChallenge();
    const setup = await createRoomAuthPayload(ROOM_ID, PASSWORD, setupChallenge, "set-up", "alice");
    const joinChallenge = createRoomAuthChallenge();
    const join = await createRoomAuthPayload(ROOM_ID, PASSWORD, joinChallenge, "join", "bob");

    expect(join.publicKey).toBeUndefined();
    expect(await verifyRoomAuthProof({
      auth: join,
      action: "join",
      roomId: ROOM_ID,
      name: "bob",
      expectedChallenge: joinChallenge,
      storedPublicKey: setup.publicKey,
    })).toBe(true);
    expect(await verifyRoomAuthProof({
      auth: join,
      action: "join",
      roomId: ROOM_ID,
      name: "bob",
      expectedChallenge: createRoomAuthChallenge(),
      storedPublicKey: setup.publicKey,
    })).toBe(false);
    expect(await verifyRoomAuthProof({
      auth: join,
      action: "rejoin",
      roomId: ROOM_ID,
      name: "bob",
      expectedChallenge: joinChallenge,
      storedPublicKey: setup.publicKey,
    })).toBe(false);
    expect(await verifyRoomAuthProof({
      auth: join,
      action: "join",
      roomId: ROOM_ID,
      name: "mallory",
      expectedChallenge: joinChallenge,
      storedPublicKey: setup.publicKey,
    })).toBe(false);
  });
});

describe("encrypted chat protocol v3", () => {
  it("binds ciphertext to the claimed sender", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "hello", { bold: true });
    expect(encrypted).not.toBeNull();

    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "mallory", encrypted!)).toBeNull();
    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).toEqual({
      text: "hello",
      style: { bold: true },
    });
  });

  it("keeps only allowlisted formatting inside authenticated ciphertext", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "styled", {
      bold: true,
      color: "red",
    });

    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).toEqual({
      text: "styled",
      style: { bold: true },
    });
  });

  it("uses a fresh sender session whenever runtime crypto state is cleared", async () => {
    const first = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "first");
    clearChatCryptoState();
    const second = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "second");

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(1);
    expect(second?.sid).not.toBe(first?.sid);
  });

  it("rejects a captured packet after cleanup reloads the persisted replay ledger", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "once only");
    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).toEqual({ text: "once only" });

    clearChatCryptoState();

    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).toBeNull();
  });

  it("does not age captured packets back into validity", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "never replay");
    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).toEqual({ text: "never replay" });
    const originalNow = Date.now;
    try {
      const future = originalNow() + 365 * 24 * 60 * 60 * 1_000;
      Date.now = () => future;
      clearChatCryptoState();
      expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).toBeNull();
    } finally {
      Date.now = originalNow;
    }
  });

  it("rejects legacy v1 and v2 ciphertext envelopes", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "current");
    const legacyV1 = { ...encrypted, v: 1, kdf: undefined, sid: undefined, seq: undefined };
    const legacyV2 = { ...encrypted, v: 2, sid: undefined, seq: undefined };

    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", legacyV1 as any)).toBeNull();
    expect(await decryptChatPayload(ROOM_ID, PASSWORD, "alice", legacyV2 as any)).toBeNull();
  });

  it("delivers encrypted messages in wire order and drops stale work after a room reset", async () => {
    const [{ handleMessage }, { useGameStore }] = await Promise.all([
      import("../client/src/services/messageHandler"),
      import("../client/src/stores/gameStore"),
    ]);
    useGameStore.setState({
      roomId: ROOM_ID,
      password: PASSWORD,
      name: "alice",
      messages: [],
      mutedNames: new Set(),
      minimized: false,
    });

    const first = await encryptChatPayload(ROOM_ID, PASSWORD, "bob", "first on the wire");
    const malformed = { ...first!, iv: "not-base64" };
    handleMessage({ type: "message", from: "bob", enc: first! });
    handleMessage({ type: "message", from: "bob", enc: malformed });

    for (let attempt = 0; attempt < 100 && useGameStore.getState().messages.length < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(useGameStore.getState().messages.map((message) => message.text)).toEqual([
      "first on the wire",
      "[unable to decrypt message]",
    ]);

    const stale = await encryptChatPayload(ROOM_ID, PASSWORD, "bob", "stale old-room work");
    handleMessage({ type: "message", from: "bob", enc: stale! });
    handleMessage({ type: "room-created", room: ROOM_ID });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(useGameStore.getState().messages.some((message) => message.text === "stale old-room work")).toBe(false);
    useGameStore.getState().cleanup();
    expect(useGameStore.getState().messages).toEqual([]);
  });

  it("builds protocol-v4 WebSocket URLs without invitation secrets", async () => {
    const { secureRoomWebSocketUrl } = await import("../client/src/services/secureRoomController");
    const httpUrl = secureRoomWebSocketUrl("abcdefgh", {
      protocol: "http:",
      host: "localhost:3025",
    });
    const httpsUrl = secureRoomWebSocketUrl("fort-id", {
      protocol: "https:",
      host: "pillowfort.example",
    });

    expect(httpUrl).toBe("ws://localhost:3025/ws?room=abcdefgh&protocol=4");
    expect(httpsUrl).toBe("wss://pillowfort.example/ws?room=fort-id&protocol=4");
    expect(httpUrl).not.toContain(PASSWORD);
  });

  it("fails closed when a persisted replay ledger is saturated", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "blocked by saturation");
    sessionStorage.setItem("pillowfort-chat-replay-v1", JSON.stringify({ v: 1, saturated: true, entries: [] }));
    clearChatCryptoState();

    await expect(decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).rejects.toBeInstanceOf(ChatCryptoStateError);
  });

  it("fails closed when any persisted replay-ledger entry is malformed", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "blocked by corruption");
    sessionStorage.setItem("pillowfort-chat-replay-v1", JSON.stringify({
      v: 1,
      saturated: false,
      entries: [{ key: 42, seq: 1, seenAt: Date.now() }],
    }));
    clearChatCryptoState();

    await expect(decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).rejects.toBeInstanceOf(ChatCryptoStateError);

    const malformedFlag = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "bad saturation flag");
    sessionStorage.setItem("pillowfort-chat-replay-v1", JSON.stringify({
      v: 1,
      saturated: "false",
      entries: [],
    }));
    clearChatCryptoState();
    await expect(decryptChatPayload(ROOM_ID, PASSWORD, "alice", malformedFlag!)).rejects.toBeInstanceOf(ChatCryptoStateError);
  });

  it("fails closed when replay state cannot be persisted", async () => {
    const encrypted = await encryptChatPayload(ROOM_ID, PASSWORD, "alice", "blocked by storage failure");
    let writes = 0;
    setChatReplayStateStoreForTests({
      async migrateLegacyReplayLedger() { return { migrated: true }; },
      async advanceReplay() {
        writes += 1;
        throw new Error("storage unavailable");
      },
    });
    clearChatCryptoState();

    await expect(decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).rejects.toBeInstanceOf(ChatCryptoStateError);
    await expect(decryptChatPayload(ROOM_ID, PASSWORD, "alice", encrypted!)).rejects.toBeInstanceOf(ChatCryptoStateError);
    expect(writes).toBe(1);
  });
});
