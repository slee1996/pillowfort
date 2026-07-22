import { describe, expect, it } from "bun:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  MAX_SECURE_DRAW_POINTS,
  canonicalBase64UrlV4,
  canonicalJsonV4,
  isSecureApplicationEventV4,
  isSecureDisplayNameV4,
  isSecureRoomStateSnapshotV4,
  isSecureUnsignedApplicationEventV4,
  parseSecureApplicationEventV4,
  secureApplicationEventSigningBytesV4,
  signSecureApplicationEventV4,
  verifySecureApplicationEventV4,
  type SecureApplicationContentV4,
  type SecureRoomStateSnapshotV4,
  type SecureUnsignedApplicationEventV4,
} from "../src/applicationEventsV4";

function encoded(bytes: number, fill = 0): string {
  return canonicalBase64UrlV4(new Uint8Array(bytes).fill(fill));
}

const ROOM = encoded(16, 1);
const ALICE = encoded(16, 2);
const BOB = encoded(16, 3);
const EVENT = encoded(16, 4);
const GAME = encoded(16, 5);
const REQUEST = encoded(16, 6);
const COMMITMENT = encoded(32, 7);
const NONCE = encoded(32, 8);

function snapshot(): SecureRoomStateSnapshotV4 {
  return {
    v: 4,
    roomInstance: ROOM,
    logicalOrder: 1,
    revision: 1,
    hostDeviceId: ALICE,
    pendingHostDeviceId: null,
    pendingRemovalDeviceIds: [],
    membershipAdmissionBindings: [
      { deviceId: ALICE, admissionId: EVENT },
      { deviceId: BOB, admissionId: REQUEST },
    ],
    theme: "away-message",
    closedReason: null,
    members: [
      { deviceId: ALICE, displayName: "alice", status: "available", awayText: null, lastSequence: 1 },
      { deviceId: BOB, displayName: "bob", status: "away", awayText: "coffee", lastSequence: 0 },
    ],
    messages: [],
    drawings: [],
    queue: [],
    vote: null,
    rps: null,
    ttt: null,
    saboteur: null,
    leaderboards: [
      { deviceId: ALICE, pillowFight: 0, rps: 0, ttt: 0, saboteur: 0, koth: 0 },
      { deviceId: BOB, pillowFight: 0, rps: 0, ttt: 0, saboteur: 0, koth: 0 },
    ],
    seenEventIds: [EVENT],
  };
}

function unsigned(content: SecureApplicationContentV4): SecureUnsignedApplicationEventV4 {
  return { v: 4, roomInstance: ROOM, eventId: EVENT, deviceId: ALICE, deviceSequence: 1, logicalOrder: 1, content };
}

describe("protocol v4 application event schema", () => {
  it("strictly covers every protected application content family", () => {
    const variants: SecureApplicationContentV4[] = [
      { type: "member-profile", displayName: "alice" },
      { type: "member-leave" },
      { type: "presence", status: "away", awayText: "coffee" },
      { type: "chat", text: "hello", style: { bold: true, color: "#FF0000" } },
      { type: "typing" },
      { type: "drawing", color: "hsl(359, 80%, 65%)", points: [[0, 0.5], [1, 1]], strokeStart: true },
      { type: "theme", theme: "campus-blue" },
      { type: "pillow-toss", targetDeviceId: BOB },
      { type: "host-transfer", action: "offer", targetDeviceId: BOB },
      { type: "host-transfer", action: "accept", authorizationId: REQUEST },
      { type: "room-close", reason: "host closed the fort" },
      { type: "queue", action: "enqueue", requestId: REQUEST, game: "rps", targetDeviceId: BOB },
      { type: "queue", action: "cancel", requestId: REQUEST },
      { type: "vote", action: "start", gameId: GAME, targetDeviceId: BOB },
      { type: "vote", action: "cast", gameId: GAME, choice: "yes" },
      { type: "vote", action: "close", gameId: GAME },
      { type: "vote", action: "cancel", gameId: GAME },
      { type: "rps", action: "challenge", gameId: GAME, targetDeviceId: BOB },
      { type: "rps", action: "accept", gameId: GAME },
      { type: "rps", action: "decline", gameId: GAME },
      { type: "rps", action: "cancel", gameId: GAME },
      { type: "rps", action: "forfeit", gameId: GAME },
      { type: "rps", action: "commit", gameId: GAME, commitment: COMMITMENT },
      { type: "rps", action: "reveal", gameId: GAME, pick: "rock", nonce: NONCE },
      { type: "ttt", action: "challenge", gameId: GAME, targetDeviceId: BOB },
      { type: "ttt", action: "accept", gameId: GAME },
      { type: "ttt", action: "decline", gameId: GAME },
      { type: "ttt", action: "cancel", gameId: GAME },
      { type: "ttt", action: "forfeit", gameId: GAME },
      { type: "ttt", action: "move", gameId: GAME, cell: 8 },
      { type: "saboteur", action: "start", gameId: GAME },
      { type: "saboteur", action: "entropy-commit", gameId: GAME, commitment: COMMITMENT },
      { type: "saboteur", action: "entropy-reveal", gameId: GAME, nonce: NONCE },
      { type: "saboteur", action: "accuse", gameId: GAME, suspectDeviceId: BOB },
      { type: "saboteur", action: "vote", gameId: GAME, choice: "no" },
      { type: "saboteur", action: "resolve-vote", gameId: GAME },
      { type: "saboteur", action: "strike", gameId: GAME },
      { type: "saboteur", action: "close", gameId: GAME },
      { type: "koth", action: "challenge", gameId: GAME },
      { type: "state-snapshot", state: snapshot() },
    ];
    for (const content of variants) expect(isSecureUnsignedApplicationEventV4(unsigned(content))).toBe(true);
  });

  it("rejects unknown fields, unknown variants, prototype tricks, sparse arrays, NaN, and bounds violations", () => {
    expect(isSecureUnsignedApplicationEventV4({ ...unsigned({ type: "typing" }), downgrade: true })).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "typing", leak: true } as never))).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "future-event" } as never))).toBe(false);

    const polluted = Object.assign(Object.create({ admin: true }), unsigned({ type: "typing" }));
    expect(isSecureUnsignedApplicationEventV4(polluted)).toBe(false);
    const throwingProxy = new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });
    expect(isSecureUnsignedApplicationEventV4(throwingProxy)).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(JSON.parse(JSON.stringify({ ...unsigned({ type: "typing" }), __proto_marker: true })))).toBe(false);

    const sparse = new Array(2) as [number, number];
    sparse[1] = 0;
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "drawing", color: "#FF0000", points: [sparse] }))).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "drawing", color: "#FF0000", points: [[Number.NaN, 0]] }))).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "drawing", color: "#FF0000", points: Array.from({ length: MAX_SECURE_DRAW_POINTS + 1 }, () => [0, 0]) as [number, number][] }))).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "chat", text: "x".repeat(2_001) }))).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "member-profile", displayName: " x " }))).toBe(false);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "presence", status: "available", awayText: "leak" }))).toBe(false);
  });

  it("rejects prototype keys and invisible or bidirectional display-name controls", () => {
    for (const displayName of [
      "__proto__",
      "PROTOTYPE",
      "constructor",
      "alice\u202e",
      "alice\u2066",
      "a\u200db",
      "alice\u0000",
    ]) {
      expect(isSecureDisplayNameV4(displayName)).toBe(false);
      expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "member-profile", displayName }))).toBe(false);
    }

    expect(isSecureDisplayNameV4("Alice 🧸")).toBe(true);
    expect(isSecureUnsignedApplicationEventV4(unsigned({ type: "member-profile", displayName: "Alice 🧸" }))).toBe(true);
  });

  it("uses one deterministic NFC UTF-8 JSON representation", () => {
    expect(canonicalJsonV4({ z: 1, a: [true, { y: "ok", x: null }] })).toBe('{"a":[true,{"x":null,"y":"ok"}],"z":1}');
    expect(secureApplicationEventSigningBytesV4(unsigned({ type: "chat", text: "é" }))).not.toBeNull();
    expect(secureApplicationEventSigningBytesV4(unsigned({ type: "chat", text: "e\u0301" }))).toBeNull();
    expect(() => canonicalJsonV4({ n: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJsonV4({ n: -0 })).toThrow();
    let deep: unknown = "leaf";
    for (let index = 0; index < 18; index++) deep = [deep];
    expect(() => canonicalJsonV4(deep)).toThrow();
  });

  it("binds domain-separated signing bytes to every event field and the MLS credential key", async () => {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    const publicKey = await getPublicKeyAsync(secretKey);
    const event = await signSecureApplicationEventV4(
      unsigned({ type: "chat", text: "signed" }),
      (bytes) => signAsync(bytes, secretKey),
    );
    expect(isSecureApplicationEventV4(event, { expectedRoomInstance: ROOM })).toBe(true);
    expect(await verifySecureApplicationEventV4(event, publicKey, { expectedRoomInstance: ROOM })).toBe(true);
    expect(await verifySecureApplicationEventV4({ ...event, logicalOrder: 2 }, publicKey)).toBe(false);
    expect(await verifySecureApplicationEventV4({ ...event, content: { type: "chat", text: "tampered" } }, publicKey)).toBe(false);
    expect(await verifySecureApplicationEventV4(event, encoded(32, 99))).toBe(false);
    expect(await verifySecureApplicationEventV4(event, publicKey, { expectedRoomInstance: encoded(16, 99) })).toBe(false);
  });

  it("owns canonical event data across async signing and verification boundaries", async () => {
    const secretKey = crypto.getRandomValues(new Uint8Array(32));
    const publicKey = await getPublicKeyAsync(secretKey);
    const mutable = unsigned({ type: "chat", text: "signed before mutation", style: { bold: true } });
    let releaseSigner!: () => void;
    let signerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signerEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseSigner = resolve; });
    let capturedSigningBytes: Uint8Array | null = null;
    const signing = signSecureApplicationEventV4(mutable, async (bytes) => {
      capturedSigningBytes = bytes;
      signerEntered();
      await release;
      return signAsync(bytes, secretKey);
    });
    await entered;
    (mutable.content as { type: "chat"; text: string }).text = "mutated during signer await";
    releaseSigner();
    const signed = await signing;
    expect(signed.content).toMatchObject({ type: "chat", text: "signed before mutation" });
    expect(capturedSigningBytes !== null && [...capturedSigningBytes].every((byte) => byte === 0)).toBe(true);
    expect(await verifySecureApplicationEventV4(signed, publicKey)).toBe(true);

    const parsed = parseSecureApplicationEventV4(signed)!;
    const verifying = verifySecureApplicationEventV4(signed, publicKey);
    (signed.content as { type: "chat"; text: string }).text = "mutated during verifier await";
    expect(await verifying).toBe(true);
    expect(parsed.content).toMatchObject({ type: "chat", text: "signed before mutation" });
    expect(await verifySecureApplicationEventV4(signed, publicKey)).toBe(false);
    secretKey.fill(0);
    publicKey.fill(0);
  });

  it("validates state snapshots recursively and rejects nested drift", () => {
    const valid = snapshot();
    expect(isSecureRoomStateSnapshotV4(valid)).toBe(true);
    expect(isSecureRoomStateSnapshotV4({ ...valid, members: [{ ...valid.members[0], admin: true }, valid.members[1]] })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({ ...valid, members: [valid.members[0], { ...valid.members[1], displayName: "alice" }] })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({ ...valid, members: [valid.members[0], { ...valid.members[1], displayName: "ALICE" }] })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({ ...valid, hostDeviceId: encoded(16, 44) })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({ ...valid, pendingRemovalDeviceIds: [ALICE] })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({ ...valid, pendingRemovalDeviceIds: [BOB, BOB] })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({ ...valid, seenEventIds: [EVENT, EVENT] })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({
      ...valid,
      messages: [{ eventId: EVENT, deviceId: ALICE, displayName: "alice", text: "must not persist", style: null }],
    })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({
      ...valid,
      drawings: [{ eventId: EVENT, deviceId: ALICE, displayName: "alice", color: "#FF0000", points: [[0, 0]], strokeStart: true }],
    })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({
      ...valid,
      rps: {
        gameId: GAME,
        p1DeviceId: ALICE,
        p2DeviceId: BOB,
        phase: "pending",
        koth: false,
        commitments: [{ deviceId: ALICE, commitment: COMMITMENT }],
        reveals: [],
      },
    })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({
      ...valid,
      pendingHostDeviceId: BOB,
      rps: {
        gameId: GAME,
        p1DeviceId: ALICE,
        p2DeviceId: BOB,
        phase: "pending",
        koth: false,
        commitments: [],
        reveals: [],
      },
    })).toBe(false);
    expect(isSecureRoomStateSnapshotV4({
      ...valid,
      ttt: {
        gameId: GAME,
        p1DeviceId: ALICE,
        p2DeviceId: BOB,
        phase: "playing",
        board: ["O", "O", "", "", "", "", "", "", ""],
        turn: 2,
      },
    })).toBe(false);
    const revealing = {
      gameId: GAME,
      p1DeviceId: ALICE,
      p2DeviceId: BOB,
      phase: "revealing" as const,
      koth: false,
      commitments: [
        { deviceId: ALICE, commitment: COMMITMENT },
        { deviceId: BOB, commitment: encoded(32, 9) },
      ],
      reveals: [
        { deviceId: ALICE, pick: "rock" as const, nonce: NONCE },
        { deviceId: BOB, pick: "paper" as const, nonce: encoded(32, 10) },
      ],
    };
    expect(isSecureRoomStateSnapshotV4({ ...valid, rps: revealing })).toBe(false);
    const queued = {
      requestId: REQUEST,
      game: "rps" as const,
      byDeviceId: ALICE,
      targetDeviceId: BOB,
    };
    expect(isSecureRoomStateSnapshotV4({ ...valid, queue: [queued, queued] })).toBe(false);
  });
});
