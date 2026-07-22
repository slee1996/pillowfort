import { describe, expect, it } from "bun:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { createRoomInvitationAuthV4, createRoomInvitationMemberBindingV4 } from "../client/src/services/secureInvitationAuth";
import { createRoomAuthPayload } from "../client/src/services/chatCrypto";
import { Room, type Env } from "../src/index";
import { signSecureDeviceResumeProofV4 } from "../src/deviceAuthV4";
import {
  createSecureRelayStateV4,
  generateSecureRelayIdV4,
  type SecureCommitRelayFrameV4,
  type SecureRelayEffectV4,
} from "../src/secureRelayV4";
import { parseSecureServerFrameV4 } from "../src/secureTransportV4";
import { SECURE_RELAY_MANIFEST_KEY_V4, parseSecureRelayPersistenceManifestV4, prepareSecureRelayPersistenceV4, secureRelayChunkKeyV4 } from "../src/secureRelayPersistenceV4";
import { MAX_WEBSOCKET_FRAME_BYTES, toBase64Url } from "../src/roomAuth";
import { ROOM_FORT_PASS_FULFILL_PATH, ROOM_FORT_PASS_RESERVATION_PATH, ROOM_FORT_PASS_REVOKE_PATH, ROOM_STATUS_PATH, ROOM_STRIPE_SESSION_LEDGER_PATH, ROOM_WS_OPEN_LIMIT_PATH } from "../src/routes";
import { fortPassClaimHash, type FortPassEntitlement } from "../src/entitlements";
import { roomInvitationKeyPackageDigestV4 } from "../src/roomInvitationMemberBindingV4";

class TransactionalStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  events: string[] = [];
  private transactionQueue: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string | string[]): Promise<void> {
    for (const value of Array.isArray(key) ? key : [key]) this.values.delete(value);
  }
  async deleteAll(): Promise<void> { this.values.clear(); }
  async list<T>(): Promise<Map<string, T>> { return new Map(this.values) as Map<string, T>; }
  async setAlarm(value: number): Promise<void> { this.alarm = value; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
  async transaction<T>(callback: (transaction: TransactionalStorage) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previousTransaction = this.transactionQueue;
    this.transactionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previousTransaction;
    const prior = this.values;
    const transactional = new TransactionalStorage();
    transactional.values = new Map([...prior].map(([key, value]) => [key, structuredClone(value)]));
    transactional.alarm = this.alarm;
    try {
      const result = await callback(transactional);
      this.values = transactional.values;
      this.alarm = transactional.alarm;
      this.events.push("transaction-committed");
      return result;
    } catch (error) {
      throw error;
    } finally {
      release();
    }
  }
}

class TestSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(public attachment: Record<string, unknown>, private events: string[]) {}
  send(message: string) { this.sent.push(message); this.events.push("socket-send"); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; }
  deserializeAttachment() { return this.attachment; }
  serializeAttachment(value: unknown) { this.attachment = value as Record<string, unknown>; }
}

class TestState {
  storage = new TransactionalStorage();
  sockets: TestSocket[] = [];
  ready: Promise<void> = Promise.resolve();
  blockConcurrencyWhile(callback: () => Promise<void>) { this.ready = callback(); return this.ready; }
  getWebSockets() { return this.sockets; }
  acceptWebSocket() {}
}

function env(): Env {
  return {
    ROOM: {
      idFromName: (name: string) => ({ name }),
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
    ASSETS: { fetch: async () => new Response("asset") },
  } as unknown as Env;
}

function ledgerRequest(action: "claim" | "complete" | "release", roomId: string, token: string) {
  return new Request(`https://pillowfort.internal${ROOM_STRIPE_SESSION_LEDGER_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, roomId, token }),
  });
}

function reservationRequest(body: Record<string, unknown>) {
  return new Request(`https://pillowfort.internal${ROOM_FORT_PASS_RESERVATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function revocationRequest(sessionId: string, reason: "refund" | "dispute", contentType = "application/json") {
  return new Request(`https://pillowfort.internal${ROOM_FORT_PASS_REVOKE_PATH}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify({ sessionId, reason }),
  });
}

async function claimHashFor(secret: string): Promise<string> {
  const claimHash = await fortPassClaimHash(secret);
  if (!claimHash) throw new Error("invalid test claim secret");
  return claimHash;
}

function fulfillmentRequest(entitlement: FortPassEntitlement, claimHash: string, init?: {
  contentType?: string;
  body?: string;
}) {
  return new Request(`https://pillowfort.internal${ROOM_FORT_PASS_FULFILL_PATH}`, {
    method: "POST",
    headers: { "content-type": init?.contentType ?? "application/json" },
    body: init?.body ?? JSON.stringify({ entitlement, claimHash }),
  });
}

async function founderBinding(options: {
  roomId: string;
  roomInstance: string;
  deviceId: string;
  requestId: string;
  signaturePublicKey: string;
  keyPackage: string;
  roomSecret: string;
}) {
  return createRoomInvitationMemberBindingV4({
    mode: "founder",
    roomId: options.roomId,
    roomInstance: options.roomInstance,
    deviceId: options.deviceId,
    admissionId: options.requestId,
    signaturePublicKey: options.signaturePublicKey,
    keyPackageDigest: await roomInvitationKeyPackageDigestV4(options.keyPackage),
  }, options.roomSecret);
}

async function sendSecureSetup(options: {
  room: Room;
  state: TestState;
  roomId: string;
  roomSecret: string;
  source: string;
  fortPassSessionId?: string;
  fortPassClaimSecret?: string;
}): Promise<TestSocket> {
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const connectionId = generateSecureRelayIdV4();
  const deviceId = generateSecureRelayIdV4();
  const roomInstance = generateSecureRelayIdV4();
  const requestId = generateSecureRelayIdV4();
  const signatureSeed = crypto.getRandomValues(new Uint8Array(32));
  const signaturePublicKey = toBase64Url(await getPublicKeyAsync(signatureSeed));
  const keyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
  const socket = new TestSocket({
    name: "", hash: options.source, isHost: false, hostRejected: false,
    status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
    ip: options.source, authChallenge: challenge,
    authChallengeExpiresAt: Date.now() + 30_000, authAttempted: false,
    preAuthFrames: 0, protocol: "v4", secureConnectionId: connectionId,
    secureChallenge: challenge, secureChallengeExpiresAt: Date.now() + 30_000,
    secureAuthenticated: false,
  }, options.state.storage.events);
  options.state.sockets.push(socket);
  const frame = {
    kind: "secure-authenticate" as const,
    v: 4 as const,
    suite: 1 as const,
    mode: "setup" as const,
    frame: {
      kind: "setup" as const,
      requestId,
      signaturePublicKey,
      hello: { v: 4 as const, suite: 1 as const, roomInstance, deviceId, keyPackage },
      memberBinding: await founderBinding({
        roomId: options.roomId,
        roomInstance,
        deviceId,
        requestId,
        signaturePublicKey,
        keyPackage,
        roomSecret: options.roomSecret,
      }),
    },
    auth: await createRoomInvitationAuthV4({
      mode: "setup",
      roomId: options.roomId,
      roomInstance,
      deviceId,
      connectionId,
      requestId,
      challenge,
    }, options.roomSecret),
    ...(options.fortPassSessionId === undefined ? {} : {
      fortPassSessionId: options.fortPassSessionId,
      fortPassClaimSecret: options.fortPassClaimSecret,
    }),
  };
  await options.room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(frame));
  return socket;
}

describe("protocol-v4 Durable Object runtime", () => {
  it("closes expired unauthenticated sockets through the durable alarm", async () => {
    const state = new TestState();
    state.storage.values.set("roomId", "authsweep");
    state.storage.values.set("alarmSchedule", { "auth-sockets": Date.now() - 1 });
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const socket = new TestSocket({
      name: "", hash: "0000", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
      protocol: "v4", secureAuthenticated: false,
      secureChallengeExpiresAt: Date.now() - 1,
    }, state.storage.events);
    state.sockets.push(socket);

    await room.alarm();

    expect(socket.closed).toEqual({ code: 1008, reason: "authentication timeout" });
    expect((room as any).pendingSecureAuthenticationCount()).toBe(0);
    expect(state.storage.values.has("alarmSchedule")).toBe(false);
    expect(state.storage.alarm).toBeNull();
  });

  it("bounds pending authentication sockets and releases terminal challenges", async () => {
    const state = new TestState();
    state.storage.values.set("roomId", "socketcap");
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;

    for (let index = 0; index < 64; index++) {
      state.sockets.push(new TestSocket({
        name: "", hash: String(index), isHost: false, hostRejected: false,
        status: "available", awayText: null, msgTimestamps: [],
        protocol: "v4", secureAuthenticated: false, authAttempted: false,
        secureChallenge: `challenge-${index}`,
        secureChallengeExpiresAt: Date.now() + 30_000,
      }, state.storage.events));
    }
    expect((room as any).pendingSecureAuthenticationCount()).toBe(64);
    const saturated = await room.fetch(new Request(
      "https://pillowfort.invalid/ws?room=socketcap&protocol=4",
      { headers: { Upgrade: "websocket" } },
    ));
    expect(saturated.status).toBe(429);
    expect(saturated.headers.get("retry-after")).toBe("30");

    const terminal = state.sockets[0];
    (room as any).rejectSecureAuthentication(terminal, "authentication-failed");
    expect(terminal.closed).toEqual({ code: 1008, reason: "authentication failed" });
    expect((room as any).pendingSecureAuthenticationCount()).toBe(63);
  });

  it("atomically bounds edge websocket-open slots for one pseudonymous source", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const request = () => room.fetch(new Request(
      `https://pillowfort.internal${ROOM_WS_OPEN_LIMIT_PATH}`,
      { method: "POST" },
    ));

    const burst: Response[] = [];
    for (let index = 0; index < 60; index++) burst.push(await request());
    expect(burst.every((response) => response.status === 204)).toBe(true);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(JSON.stringify([...state.storage.values])).not.toContain("203.0.113");

    const corruptState = new TestState();
    corruptState.storage.values.set("webSocketOpenTimestamps", ["not-a-timestamp"]);
    const corruptLimiter = new Room(corruptState as unknown as DurableObjectState, env());
    await corruptState.ready;
    const corrupt = await corruptLimiter.fetch(new Request(
      `https://pillowfort.internal${ROOM_WS_OPEN_LIMIT_PATH}`,
      { method: "POST" },
    ));
    expect(corrupt.status).toBe(503);
    expect(corruptState.storage.values.get("webSocketOpenTimestamps")).toEqual(["not-a-timestamp"]);
  });

  it("serializes Stripe session claims and permanently completes the bound target", async () => {
    const state = new TestState();
    const ledger = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const firstToken = "a".repeat(64);
    const secondToken = "b".repeat(64);
    const [first, second] = await Promise.all([
      ledger.fetch(ledgerRequest("claim", "ledgerroom", firstToken)),
      ledger.fetch(ledgerRequest("claim", "ledgerroom", secondToken)),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const winningToken = first.status === 201 ? firstToken : secondToken;
    const losingToken = first.status === 201 ? secondToken : firstToken;
    expect((await ledger.fetch(ledgerRequest("complete", "ledgerroom", losingToken))).status).toBe(409);
    expect((await ledger.fetch(ledgerRequest("complete", "otherroom", winningToken))).status).toBe(409);
    expect((await ledger.fetch(ledgerRequest("complete", "ledgerroom", winningToken))).status).toBe(204);

    const restarted = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const replay = await restarted.fetch(ledgerRequest("claim", "ledgerroom", "c".repeat(64)));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ status: "complete" });
    expect((await restarted.fetch(ledgerRequest("release", "ledgerroom", winningToken))).status).toBe(409);
  });

  it("binds each paid-code reservation to one Stripe session and preserves expired owners until verified", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const firstToken = "1".repeat(64);
    const secondToken = "2".repeat(64);
    const firstSessionId = "cs_test_reservation_owner_one";
    const secondSessionId = "cs_test_reservation_owner_two";
    const firstClaimHash = await claimHashFor("a".repeat(64));
    const secondClaimHash = await claimHashFor("b".repeat(64));

    const claimed = await room.fetch(reservationRequest({
      action: "claim", token: firstToken, claimHash: firstClaimHash,
    }));
    expect(claimed.status).toBe(201);
    expect(claimed.headers.get("cache-control")).toBe("no-store");
    expect(await claimed.json()).toMatchObject({ status: "claimed", expiresAt: expect.any(Number) });
    expect((await room.fetch(reservationRequest({
      action: "claim", token: secondToken, claimHash: secondClaimHash,
    }))).status).toBe(409);
    expect((await room.fetch(reservationRequest({
      action: "bind", token: secondToken, sessionId: firstSessionId,
    }))).status).toBe(409);
    expect((await room.fetch(reservationRequest({
      action: "bind", token: firstToken, sessionId: firstSessionId,
    }))).status).toBe(204);
    expect((await room.fetch(reservationRequest({
      action: "bind", token: firstToken, sessionId: firstSessionId,
    }))).status).toBe(204);
    expect((await room.fetch(reservationRequest({ action: "release", token: firstToken }))).status).toBe(409);

    const expiredBound = state.storage.values.get("fortPassReservation") as Record<string, unknown>;
    expiredBound.expiresAt = Date.now() - 1;
    state.storage.values.set("fortPassReservation", expiredBound);
    const status = await room.fetch(new Request(`https://pillowfort.internal${ROOM_STATUS_PATH}`));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ exists: false });
    expect(state.storage.values.get("fortPassReservation")).toMatchObject({ sessionId: firstSessionId });

    const supersessionRequired = await room.fetch(reservationRequest({
      action: "claim", token: secondToken, claimHash: secondClaimHash,
    }));
    expect(supersessionRequired.status).toBe(200);
    expect(await supersessionRequired.json()).toEqual({
      status: "supersession-required",
      sessionId: firstSessionId,
    });
    expect((await room.fetch(reservationRequest({
      action: "supersede", token: secondToken, claimHash: secondClaimHash,
      priorSessionId: "cs_test_wrong_owner",
    }))).status).toBe(409);
    expect((await room.fetch(reservationRequest({
      action: "supersede", token: secondToken, claimHash: secondClaimHash,
      priorSessionId: firstSessionId,
    }))).status).toBe(201);

    const entitlementFor = (providerRef: string): FortPassEntitlement => {
      const createdAt = Date.now() - 1_000;
      return {
        v: 1,
        kind: "fort-pass",
        status: "active",
        roomId: "reserve-1",
        hostRef: providerRef,
        provider: "stripe",
        providerRef,
        createdAt,
        expiresAt: createdAt + 24 * 60 * 60 * 1_000,
        perks: { customRoomCode: "reserve-1", extendedIdleMs: 60_000, themePack: "retro-plus" },
      };
    };
    const fulfill = (providerRef: string) => room.fetch(
      fulfillmentRequest(entitlementFor(providerRef), secondClaimHash),
    );
    expect((await fulfill(firstSessionId)).status).toBe(409);
    expect((await room.fetch(reservationRequest({
      action: "bind", token: secondToken, sessionId: secondSessionId,
    }))).status).toBe(204);
    const secondReservation = state.storage.values.get("fortPassReservation") as Record<string, unknown>;
    secondReservation.expiresAt = Date.now() - 1;
    state.storage.values.set("fortPassReservation", secondReservation);
    expect((await fulfill(secondSessionId)).status).toBe(200);
    expect(state.storage.values.has("fortPassReservation")).toBe(false);
  });

  it("rejects malformed reservation actions and fails closed on corrupt durable state", async () => {
    const state = new TestState();
    state.storage.values.set("fortPassReservation", { expiresAt: Date.now() + 60_000 });
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const claimHash = await claimHashFor("c".repeat(64));
    const corrupt = await room.fetch(reservationRequest({
      action: "claim", token: "3".repeat(64), claimHash,
    }));
    expect(corrupt.status).toBe(503);
    expect(corrupt.headers.get("cache-control")).toBe("no-store");
    expect(state.storage.values.get("fortPassReservation")).toEqual({
      expiresAt: expect.any(Number),
    });
    const malformed = await room.fetch(reservationRequest({
      action: "claim", token: "4".repeat(64), claimHash, unexpected: true,
    }));
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
  });

  it("binds fulfillment to the reservation claim and tombstones a refund before grant", async () => {
    const roomId = "claim-lock";
    const sessionId = "cs_test_claim_lock_owner";
    const token = "6".repeat(64);
    const claimSecret = "1a".repeat(32);
    const claimHash = await claimHashFor(claimSecret);
    const wrongClaimHash = await claimHashFor("2b".repeat(32));
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const createdAt = Date.now() - 1_000;
    const entitlement: FortPassEntitlement = {
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId,
      hostRef: sessionId,
      provider: "stripe",
      providerRef: sessionId,
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1_000,
      perks: { customRoomCode: roomId, extendedIdleMs: 60_000, themePack: "retro-plus" },
    };

    expect((await room.fetch(reservationRequest({ action: "claim", token, claimHash }))).status).toBe(201);
    expect((await room.fetch(reservationRequest({ action: "bind", token, sessionId }))).status).toBe(204);
    expect((await room.fetch(fulfillmentRequest(entitlement, wrongClaimHash))).status).toBe(409);
    expect(state.storage.values.has("fortPassEntitlement")).toBe(false);
    expect(state.storage.values.has("fortPassRedemption")).toBe(false);
    expect((await room.fetch(fulfillmentRequest(entitlement, claimHash, {
      contentType: "text/plain",
    }))).status).toBe(415);
    expect((await room.fetch(fulfillmentRequest(entitlement, claimHash, {
      body: JSON.stringify({ entitlement, claimHash, extra: true }),
    }))).status).toBe(400);
    expect((await room.fetch(fulfillmentRequest(entitlement, claimHash, {
      body: JSON.stringify({ entitlement, claimHash }) + " ".repeat(4_096),
    }))).status).toBe(400);

    const revoked = await room.fetch(revocationRequest(sessionId, "refund"));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ revoked: true, replay: false, reason: "refund" });
    expect(state.storage.values.has("fortPassReservation")).toBe(false);
    const preGrantRevocation = state.storage.values.get("fortPassPreGrantRevocation") as Record<string, unknown>;
    expect(preGrantRevocation.v).toBe(1);
    expect(preGrantRevocation.reason).toBe("refund");
    expect(typeof preGrantRevocation.revokedAt).toBe("number");
    expect((await room.fetch(fulfillmentRequest(entitlement, claimHash))).status).toBe(409);
    expect(state.storage.values.has("fortPassEntitlement")).toBe(false);

    await (room as any).destroyRoom("pre-grant refund cleanup");
    expect(state.storage.values.has("fortPassPreGrantRevocation")).toBe(true);
    const restarted = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    expect((await restarted.fetch(fulfillmentRequest(entitlement, claimHash))).status).toBe(409);
  });

  it("revokes only the exact active Stripe owner without destroying its room", async () => {
    const roomId = "revoke-1";
    const sessionId = "cs_test_newest_paid_owner";
    const oldSessionId = "cs_test_older_paid_owner";
    const reservationToken = "5".repeat(64);
    const claimSecret = "d".repeat(64);
    const claimHash = await claimHashFor(claimSecret);
    const state = new TestState();
    const grantTarget = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const createdAt = Date.now() - 1_000;
    const entitlement: FortPassEntitlement = {
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId,
      hostRef: sessionId,
      provider: "stripe",
      providerRef: sessionId,
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1_000,
      perks: { customRoomCode: roomId, extendedIdleMs: 6 * 60 * 60 * 1_000, themePack: "retro-plus" },
    };
    expect((await grantTarget.fetch(reservationRequest({
      action: "claim", token: reservationToken, claimHash,
    }))).status).toBe(201);
    expect((await grantTarget.fetch(reservationRequest({
      action: "bind", token: reservationToken, sessionId,
    }))).status).toBe(204);
    expect((await grantTarget.fetch(fulfillmentRequest(entitlement, claimHash))).status).toBe(200);

    state.storage.values.set("authPublicKey", toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
    state.storage.values.set("roomTheme", "top-8");
    state.storage.values.set("alarmSchedule", { idle: Date.now() + 6 * 60 * 60 * 1_000 });
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const socket = new TestSocket({
      name: "host", hash: "revocation-host", isHost: true, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "legacy",
    }, state.storage.events);
    state.sockets.push(socket);

    const stale = await room.fetch(revocationRequest(oldSessionId, "refund"));
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({ revoked: false, stale: true });
    expect((state.storage.values.get("fortPassEntitlement") as FortPassEntitlement).status).toBe("active");
    expect(state.storage.values.get("roomTheme")).toBe("top-8");

    const beforeRevoke = Date.now();
    const revoked = await room.fetch(revocationRequest(sessionId, "refund"));
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(await revoked.json()).toEqual({ revoked: true, replay: false, reason: "refund" });
    expect((state.storage.values.get("fortPassEntitlement") as FortPassEntitlement).status).toBe("refunded");
    const redemption = state.storage.values.get("fortPassRedemption") as Record<string, unknown>;
    expect(redemption.v).toBe(3);
    expect(redemption.claimHash).toBeNull();
    expect(typeof redemption.revokedAt).toBe("number");
    expect(redemption.revocationReason).toBe("refund");
    expect(state.storage.values.get("roomTheme")).toBe("away-message");
    expect(state.storage.values.has("authPublicKey")).toBe(true);
    expect(socket.closed).toBeNull();
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "room-theme", theme: "away-message",
    });
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({
      type: "fort-pass-updated", fortPass: null,
    });
    const idleDeadline = (state.storage.values.get("alarmSchedule") as { idle: number }).idle;
    expect(idleDeadline).toBeGreaterThanOrEqual(beforeRevoke + 10 * 60 * 1_000);
    expect(idleDeadline).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1_000);

    await (room as any).onSetTheme(socket as unknown as WebSocket, { theme: "top-8" });
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "error", message: "Fort Pass required" });
    expect(state.storage.values.get("roomTheme")).toBe("away-message");

    const replay = await room.fetch(revocationRequest(sessionId, "dispute"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ revoked: true, replay: true, reason: "refund" });
    expect((state.storage.values.get("fortPassRedemption") as Record<string, unknown>).revocationReason).toBe("refund");
    expect((await room.fetch(revocationRequest(sessionId, "refund", "text/plain"))).status).toBe(415);
  });

  it("fails closed when Fort Pass revocation state is corrupt", async () => {
    const state = new TestState();
    state.storage.values.set("fortPassEntitlement", { status: "active" });
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const response = await room.fetch(revocationRequest("cs_test_corrupt_owner", "dispute"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.storage.values.get("fortPassEntitlement")).toEqual({ status: "active" });
  });

  it("recovers a crash after grant without replaying payment after target teardown", async () => {
    const ledgerState = new TestState();
    const ledger = new Room(ledgerState as unknown as DurableObjectState, env());
    await ledgerState.ready;
    const roomId = "crashroom";
    const firstToken = "d".repeat(64);
    expect((await ledger.fetch(ledgerRequest("claim", roomId, firstToken))).status).toBe(201);

    const targetState = new TestState();
    const target = new Room(targetState as unknown as DurableObjectState, env());
    await targetState.ready;
    const createdAt = Date.now() - 1_000;
    const entitlement: FortPassEntitlement = {
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId,
      hostRef: "cs_test_crash",
      provider: "stripe",
      providerRef: "cs_test_crash",
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1_000,
      perks: { customRoomCode: roomId, extendedIdleMs: 60_000, themePack: "retro-plus" },
    };
    const claimHash = await claimHashFor("e".repeat(64));
    expect((await target.fetch(reservationRequest({
      action: "claim", token: firstToken, claimHash,
    }))).status).toBe(201);
    expect((await target.fetch(reservationRequest({
      action: "bind", token: firstToken, sessionId: entitlement.providerRef,
    }))).status).toBe(204);
    const fulfill = () => target.fetch(fulfillmentRequest(entitlement, claimHash));
    expect((await fulfill()).status).toBe(200);
    await (target as any).destroyRoom("test teardown");
    expect(targetState.storage.values.has("fortPassEntitlement")).toBe(false);
    expect(targetState.storage.values.has("fortPassRedemption")).toBe(true);
    expect(JSON.stringify(targetState.storage.values.get("fortPassRedemption"))).not.toContain("cs_test_crash");

    const pending = ledgerState.storage.values.get("stripeSessionLedger") as Record<string, unknown>;
    pending.leaseExpiresAt = Date.now() - 1;
    ledgerState.storage.values.set("stripeSessionLedger", pending);
    const restartedLedger = new Room(ledgerState as unknown as DurableObjectState, env());
    await ledgerState.ready;
    const recoveryToken = "e".repeat(64);
    expect((await restartedLedger.fetch(ledgerRequest("claim", roomId, recoveryToken))).status).toBe(201);

    const restartedTarget = new Room(targetState as unknown as DurableObjectState, env());
    await targetState.ready;
    const replayGrant = await restartedTarget.fetch(fulfillmentRequest(entitlement, claimHash));
    expect(replayGrant.status).toBe(200);
    expect(await replayGrant.json()).toEqual({ ok: true, replay: true });
    expect(targetState.storage.values.has("fortPassEntitlement")).toBe(false);
    expect((await restartedLedger.fetch(ledgerRequest("complete", roomId, recoveryToken))).status).toBe(204);
    expect((await restartedLedger.fetch(ledgerRequest("claim", roomId, "f".repeat(64)))).status).toBe(200);
  });

  it("fails closed when the persisted relay manifest cannot be restored", async () => {
    const state = new TestState();
    state.storage.values.set("roomId", "corruptv4");
    state.storage.values.set(SECURE_RELAY_MANIFEST_KEY_V4, {
      schema: "pillowfort-secure-relay-persistence-v4",
      generation: 0,
      chunkCount: Number.MAX_SAFE_INTEGER,
    });
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;

    const response = await room.fetch(new Request(
      "https://pillowfort.invalid/ws?room=corruptv4&protocol=4",
      { headers: { Upgrade: "websocket" } },
    ));
    expect(response.status).toBe(503);
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(true);
  });

  it("closes sockets whose committed membership becomes retired", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const deviceId = generateSecureRelayIdV4();
    const socket = new TestSocket({
      name: "", hash: "0000", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "v4",
      secureAuthenticated: true, secureDeviceId: deviceId,
      secureConnectionId: generateSecureRelayIdV4(), secureAuthentication: "invitation",
    }, state.storage.events);
    state.sockets.push(socket);

    (room as any).dispatchSecureEffects([
      { type: "member-lifecycle", deviceId, status: "retired" },
    ] satisfies SecureRelayEffectV4[]);

    expect(socket.closed).toEqual({ code: 1008, reason: "membership ended" });
    expect(socket.attachment.secureAuthenticated).toBe(false);
  });

  it("delivers terminal retirement after persisted connection ids are cleared", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const deviceId = generateSecureRelayIdV4();
    const socket = new TestSocket({
      name: "", hash: "0000", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "v4",
      secureAuthenticated: true, secureDeviceId: deviceId,
      secureConnectionId: generateSecureRelayIdV4(), secureAuthentication: "invitation",
    }, state.storage.events);
    const unknownSocket = new TestSocket({
      name: "", hash: "0001", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "v4",
      secureAuthenticated: true, secureDeviceId: generateSecureRelayIdV4(),
      secureConnectionId: generateSecureRelayIdV4(), secureAuthentication: "invitation",
    }, state.storage.events);
    state.sockets.push(socket, unknownSocket);
    (room as any).secureRelayState = {
      members: [{ deviceId, connectionId: null, status: "retired" }],
    };

    (room as any).dispatchSecureEffects([
      { type: "room-retired" },
    ] satisfies SecureRelayEffectV4[]);

    expect(socket.sent).toHaveLength(1);
    expect(parseSecureServerFrameV4(JSON.parse(socket.sent[0]))).toMatchObject({ type: "room-retired" });
    expect(unknownSocket.sent).toHaveLength(0);
  });

  it("enforces a room-wide frame budget across authenticated sockets", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const authenticated = Array.from({ length: 10 }, (_, index) => new TestSocket({
      name: "", hash: String(index), isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "v4",
      secureAuthenticated: true, secureDeviceId: generateSecureRelayIdV4(),
      secureConnectionId: generateSecureRelayIdV4(), secureAuthentication: "invitation",
    }, state.storage.events));
    state.sockets.push(...authenticated);

    for (const socket of authenticated) {
      for (let index = 0; index < 25; index++) {
        await room.webSocketMessage(socket as unknown as WebSocket, "{}");
      }
    }
    for (let index = 0; index < 5; index++) {
      await room.webSocketMessage(authenticated[0] as unknown as WebSocket, "{}");
    }
    await room.webSocketMessage(authenticated[1] as unknown as WebSocket, "{}");
    await room.webSocketMessage(authenticated[2] as unknown as WebSocket, "{}");

    const last = parseSecureServerFrameV4(JSON.parse(authenticated[2].sent.at(-1)!));
    expect(last).toMatchObject({ type: "error", code: "rate-limited" });
    expect((authenticated[0].attachment.msgTimestamps as number[])).toHaveLength(30);
    expect((authenticated[1].attachment.msgTimestamps as number[])).toHaveLength(26);
    expect(authenticated[2].closed).toEqual({ code: 1008, reason: "rate limit exceeded" });

    state.sockets = state.sockets.filter((socket) => socket !== authenticated[2]);
    await room.webSocketMessage(authenticated[3] as unknown as WebSocket, "{}");
    expect(authenticated[3].closed).toEqual({ code: 1008, reason: "rate limit exceeded" });
  });

  it("separates mandatory raw traffic from the initiated-operation budget", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const passive = new TestSocket({
      name: "", hash: "passive", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "v4",
      secureAuthenticated: true, secureDeviceId: generateSecureRelayIdV4(),
      secureConnectionId: generateSecureRelayIdV4(), secureAuthentication: "invitation",
    }, state.storage.events);
    state.sockets.push(passive);

    for (let index = 0; index < 100; index++) {
      await room.webSocketMessage(passive as unknown as WebSocket, "{}");
    }
    expect(passive.closed).toBeNull();
    expect(passive.attachment.msgTimestamps).toHaveLength(100);
    await room.webSocketMessage(passive as unknown as WebSocket, "{}");
    expect(passive.closed).toEqual({ code: 1008, reason: "rate limit exceeded" });

    const initiator = { secureOperationTimestamps: "malformed" };
    const now = Date.now();
    for (let index = 0; index < 30; index++) {
      expect((room as any).takeSecureRoomOperationSlot(initiator, now)).toBe(true);
    }
    expect((room as any).takeSecureRoomOperationSlot(initiator, now)).toBe(false);
    expect(initiator.secureOperationTimestamps).toHaveLength(30);
    expect((room as any).takeSecureRoomOperationSlot(initiator, now + 5_001)).toBe(true);
  });

  it("normalizes a malformed hibernated per-socket rate ledger", async () => {
    const state = new TestState();
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const socket = new TestSocket({
      name: "", hash: "corrupt-ledger", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: "not-an-array", protocol: "v4",
      secureAuthenticated: true, secureDeviceId: generateSecureRelayIdV4(),
      secureConnectionId: generateSecureRelayIdV4(), secureAuthentication: "invitation",
    }, state.storage.events);
    state.sockets.push(socket);

    await expect(room.webSocketMessage(socket as unknown as WebSocket, "{}"))
      .resolves.toBeUndefined();
    expect(socket.attachment.msgTimestamps).toHaveLength(1);
  });

  it("rejects a websocket routed under a different persisted room id", async () => {
    const state = new TestState();
    state.storage.values.set("roomId", "boundroom");
    const legacySocket = new TestSocket({
      name: "legacy", hash: "0000", isHost: true, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "legacy",
    }, state.storage.events);
    state.sockets.push(legacySocket);
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    expect(legacySocket.closed).toEqual({ code: 1008, reason: "protocol v4 required" });

    for (const protocol of ["", "&protocol=legacy"]) {
      const response = await room.fetch(new Request(
        `https://pillowfort.invalid/ws?room=boundroom${protocol}`,
        { headers: { Upgrade: "websocket" } },
      ));
      expect(response.status).toBe(426);
    }

    const secretQuery = await room.fetch(new Request(
      "https://pillowfort.invalid/ws?room=boundroom&protocol=4&password=not-a-real-secret",
      { headers: { Upgrade: "websocket" } },
    ));
    expect(secretQuery.status).toBe(400);

    const response = await room.fetch(new Request(
      "https://pillowfort.invalid/ws?room=otherroom&protocol=4",
      { headers: { Upgrade: "websocket" } },
    ));
    expect(response.status).toBe(409);
  });

  it("rejects relay substitution of an invitation-bound MLS KeyPackage", async () => {
    const roomId = "f-cccccccccc";
    const state = new TestState();
    state.storage.values.set("roomId", roomId);
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const connectionId = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const roomInstance = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const signaturePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const authorizedKeyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const substitutedKeyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const roomSecret = "substitution-resistant invitation secret";
    const context = {
      mode: "setup" as const, roomId, roomInstance, deviceId, connectionId, requestId, challenge,
    };
    const socket = new TestSocket({
      name: "", hash: "substitution", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], protocol: "v4",
      secureConnectionId: connectionId, secureChallenge: challenge,
      secureChallengeExpiresAt: Date.now() + 30_000, secureAuthenticated: false,
      authChallenge: challenge, authChallengeExpiresAt: Date.now() + 30_000,
      authAttempted: false, preAuthFrames: 0,
    }, state.storage.events);
    state.sockets.push(socket);
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup",
      frame: {
        kind: "setup", requestId, signaturePublicKey,
        hello: { v: 4, suite: 1, roomInstance, deviceId, keyPackage: substitutedKeyPackage },
        memberBinding: await founderBinding({
          roomId, roomInstance, deviceId, requestId, signaturePublicKey,
          keyPackage: authorizedKeyPackage, roomSecret,
        }),
      },
      auth: await createRoomInvitationAuthV4(context, roomSecret),
    }));

    expect(socket.sent.map((raw) => parseSecureServerFrameV4(JSON.parse(raw)))).toContainEqual(
      expect.objectContaining({ type: "error", code: "authentication-failed" }),
    );
    expect(socket.closed).toEqual({ code: 1008, reason: "authentication failed" });
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(false);
  });

  it("fails closed after a persisted founder binding is substituted even with a recomputed manifest", async () => {
    const roomId = "f-dddddddddd";
    const roomInstance = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const connectionId = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const signaturePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const keyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const roomSecret = "persisted founder binding secret";
    const binding = await founderBinding({
      roomId, roomInstance, deviceId, requestId, signaturePublicKey, keyPackage, roomSecret,
    });
    const created = await createSecureRelayStateV4({
      deviceId, connectionId, authentication: "invitation",
    }, {
      kind: "setup", requestId, signaturePublicKey,
      hello: { v: 4, suite: 1, roomInstance, deviceId, keyPackage },
      memberBinding: binding,
    }, Date.now());
    if (!created.ok) throw new Error(created.code);
    const tampered = structuredClone(created.state);
    tampered.members[0].memberBinding.proof = toBase64Url(crypto.getRandomValues(new Uint8Array(64)));
    const auth = await createRoomInvitationAuthV4({
      mode: "setup", roomId, roomInstance, deviceId, connectionId, requestId,
      challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    }, roomSecret);
    if (!auth.publicKey) throw new Error("missing invitation public key");
    const prepared = await prepareSecureRelayPersistenceV4({
      roomId,
      roomAuthPublicKey: auth.publicKey,
      state: tampered,
      generation: 0,
    });
    const state = new TestState();
    state.storage.values.set("roomId", roomId);
    state.storage.values.set(SECURE_RELAY_MANIFEST_KEY_V4, prepared.manifest);
    prepared.chunks.forEach((chunk, index) => {
      state.storage.values.set(secureRelayChunkKeyV4(0, index), chunk);
    });
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;

    const response = await room.fetch(new Request(
      `https://pillowfort.invalid/ws?room=${roomId}&protocol=4`,
      { headers: { Upgrade: "websocket" } },
    ));
    expect(response.status).toBe(503);
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(true);
  });

  it("rejects protocol-v4 setup of a paid custom code without entitlement redemption", async () => {
    const roomId = "party-2";
    const state = new TestState();
    state.storage.values.set("roomId", roomId);
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const connectionId = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const roomInstance = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const socket = new TestSocket({
      name: "", hash: "paid-bypass", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
      ip: "hashed-source", authChallenge: challenge,
      authChallengeExpiresAt: Date.now() + 30_000, authAttempted: false,
      preAuthFrames: 0, protocol: "v4", secureConnectionId: connectionId,
      secureChallenge: challenge, secureChallengeExpiresAt: Date.now() + 30_000,
      secureAuthenticated: false,
    }, state.storage.events);
    state.sockets.push(socket);
    const context = {
      mode: "setup" as const, roomId, roomInstance, deviceId, connectionId,
      requestId, challenge,
    };
    const roomSecret = "paid bypass invitation secret";
    const signaturePublicKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const keyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const setupWire = JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup",
      frame: {
        kind: "setup", requestId,
        signaturePublicKey,
        hello: {
          v: 4, suite: 1, roomInstance, deviceId,
          keyPackage,
        },
        memberBinding: await founderBinding({
          roomId, roomInstance, deviceId, requestId, signaturePublicKey, keyPackage, roomSecret,
        }),
      },
      auth: await createRoomInvitationAuthV4(context, roomSecret),
    });

    await room.webSocketMessage(socket as unknown as WebSocket, setupWire);

    const frames = socket.sent.map((raw) => parseSecureServerFrameV4(JSON.parse(raw))).filter(Boolean);
    expect(frames).toContainEqual(expect.objectContaining({
      type: "error",
      code: "authentication-failed",
    }));
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(false);
    expect(socket.closed).toEqual({ code: 1008, reason: "authentication failed" });
  });

  it("requires the raw checkout claim secret before setting up a paid custom code", async () => {
    const roomId = "paid-proof";
    const sessionId = "cs_test_paid_setup_claim";
    const token = "7".repeat(64);
    const claimSecret = "3c".repeat(32);
    const claimHash = await claimHashFor(claimSecret);
    const state = new TestState();
    state.storage.values.set("roomId", roomId);
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;
    const createdAt = Date.now() - 1_000;
    const entitlement: FortPassEntitlement = {
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId,
      hostRef: sessionId,
      provider: "stripe",
      providerRef: sessionId,
      createdAt,
      expiresAt: createdAt + 24 * 60 * 60 * 1_000,
      perks: { customRoomCode: roomId, extendedIdleMs: 60_000, themePack: "retro-plus" },
    };
    expect((await room.fetch(reservationRequest({ action: "claim", token, claimHash }))).status).toBe(201);
    expect((await room.fetch(reservationRequest({ action: "bind", token, sessionId }))).status).toBe(204);
    expect((await room.fetch(fulfillmentRequest(entitlement, claimHash))).status).toBe(200);

    const wrongSecret = await sendSecureSetup({
      room,
      state,
      roomId,
      roomSecret: "paid room invitation secret",
      source: "wrong-paid-claim",
      fortPassSessionId: sessionId,
      fortPassClaimSecret: "4d".repeat(32),
    });
    const wrongFrames = wrongSecret.sent
      .map((raw) => parseSecureServerFrameV4(JSON.parse(raw)))
      .filter(Boolean);
    expect(wrongFrames).toContainEqual(expect.objectContaining({
      type: "error",
      code: "authentication-failed",
    }));
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(false);

    const correctSecret = await sendSecureSetup({
      room,
      state,
      roomId,
      roomSecret: "paid room invitation secret",
      source: "correct-paid-claim",
      fortPassSessionId: sessionId,
      fortPassClaimSecret: claimSecret,
    });
    const correctFrames = correctSecret.sent
      .map((raw) => parseSecureServerFrameV4(JSON.parse(raw)))
      .filter(Boolean);
    expect(correctFrames).toContainEqual(expect.objectContaining({
      type: "authenticated",
      mode: "setup",
      status: "active",
    }));
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(true);
  }, 15_000);

  it("commits a strict relay snapshot before acknowledging setup", async () => {
    const roomId = "f-aaaaaaaaaa";
    const state = new TestState();
    state.storage.values.set("roomId", roomId);
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;

    const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const connectionId = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const roomInstance = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const credentialSeed = crypto.getRandomValues(new Uint8Array(32));
    const socket = new TestSocket({
      name: "",
      hash: "0000",
      isHost: false,
      hostRejected: false,
      status: "available",
      awayText: null,
      msgTimestamps: [],
      drawTimestamps: [],
      ip: "hashed-source",
      authChallenge: challenge,
      authChallengeExpiresAt: Date.now() + 30_000,
      authAttempted: false,
      preAuthFrames: 0,
      protocol: "v4",
      secureConnectionId: connectionId,
      secureChallenge: challenge,
      secureChallengeExpiresAt: Date.now() + 30_000,
      secureAuthenticated: false,
    }, state.storage.events);
    state.sockets.push(socket);
    const context = {
      mode: "setup" as const,
      roomId,
      roomInstance,
      deviceId,
      connectionId,
      requestId,
      challenge,
    };
    const roomSecret = "durable invitation secret";
    const signaturePublicKey = toBase64Url(await getPublicKeyAsync(credentialSeed));
    const keyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(9 * 1024)));
    const setupWire = JSON.stringify({
      kind: "secure-authenticate",
      v: 4,
      suite: 1,
      mode: "setup",
      frame: {
        kind: "setup",
        requestId,
        signaturePublicKey,
        hello: {
          v: 4,
          suite: 1,
          roomInstance,
          deviceId,
          keyPackage,
        },
        memberBinding: await founderBinding({
          roomId, roomInstance, deviceId, requestId, signaturePublicKey, keyPackage, roomSecret,
        }),
      },
      auth: await createRoomInvitationAuthV4(context, roomSecret),
    });
    expect(new TextEncoder().encode(setupWire).byteLength).toBeGreaterThan(MAX_WEBSOCKET_FRAME_BYTES);
    await room.webSocketMessage(socket as unknown as WebSocket, setupWire);

    const frames = socket.sent.map((raw) => parseSecureServerFrameV4(JSON.parse(raw))).filter(Boolean);
    expect(frames.some((frame) => frame?.type === "authenticated")).toBe(true);
    const manifest = parseSecureRelayPersistenceManifestV4(
      state.storage.values.get(SECURE_RELAY_MANIFEST_KEY_V4),
    );
    expect(manifest).toMatchObject({ roomId, stateRevision: 1 });
    expect(socket.attachment).toMatchObject({
      protocol: "v4", secureAuthenticated: true, secureDeviceId: deviceId, secureConnectionId: connectionId,
    });
    expect(state.storage.events.indexOf("transaction-committed")).toBeGreaterThanOrEqual(0);
    expect(state.storage.events.indexOf("transaction-committed")).toBeLessThan(
      state.storage.events.indexOf("socket-send"),
    );

    const resumeChallenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const resumeConnectionId = generateSecureRelayIdV4();
    const resumeRequestId = generateSecureRelayIdV4();
    const resumedSocket = new TestSocket({
      name: "", hash: "0001", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
      ip: "hashed-source", authChallenge: resumeChallenge,
      authChallengeExpiresAt: Date.now() + 30_000, authAttempted: false,
      preAuthFrames: 0, protocol: "v4", secureConnectionId: resumeConnectionId,
      secureChallenge: resumeChallenge, secureChallengeExpiresAt: Date.now() + 30_000,
      secureAuthenticated: false,
    }, state.storage.events);
    state.sockets.push(resumedSocket);
    const resumeProof = await signSecureDeviceResumeProofV4({
      roomId, roomInstance, deviceId, connectionId: resumeConnectionId,
      requestId: resumeRequestId, challenge: resumeChallenge,
    }, (bytes) => signAsync(bytes, credentialSeed));
    await room.webSocketMessage(resumedSocket as unknown as WebSocket, JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "resume",
      frame: {
        kind: "resume", v: 4, suite: 1, roomInstance,
        requestId: resumeRequestId, deviceId,
      },
      resumeProof,
    }));
    expect(resumedSocket.sent.map((raw) => parseSecureServerFrameV4(JSON.parse(raw)))
      .some((frame) => frame?.type === "authenticated" && frame.mode === "resume")).toBe(true);
    expect(socket.closed).toEqual({ code: 4001, reason: "connection replaced" });
    expect(parseSecureRelayPersistenceManifestV4(
      state.storage.values.get(SECURE_RELAY_MANIFEST_KEY_V4),
    )?.stateRevision).toBe(2);

    // Model an alarm callback that was queued while an authenticated
    // transition refreshed idle activity. It must read the refreshed schedule
    // after acquiring the relay lock instead of destroying from stale state.
    state.storage.values.set("alarmSchedule", { idle: Date.now() - 1 });
    let enterLock!: () => void;
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => { enterLock = resolve; });
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    const heldTransition = (room as any).withSecureLock(async () => {
      enterLock();
      await lockGate;
      state.storage.values.set("alarmSchedule", { idle: Date.now() + 60_000 });
    }) as Promise<void>;
    await lockEntered;
    const queuedAlarm = room.alarm();
    await Bun.sleep(0);
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(true);
    releaseLock();
    await Promise.all([heldTransition, queuedAlarm]);
    expect(state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4)).toBe(true);
    expect(resumedSocket.closed).toBeNull();

    const previewMessageId = generateSecureRelayIdV4();
    const acceptedMessageId = generateSecureRelayIdV4();
    const rejectedMessageId = generateSecureRelayIdV4();
    const previewFrame: SecureCommitRelayFrameV4 = {
      kind: "relay",
      relayKind: "commit",
      grant: {
        v: 4,
        suite: 1,
        roomInstance,
        requestId: generateSecureRelayIdV4(),
        tokenId: generateSecureRelayIdV4(),
        deviceId,
        logicalOrder: 1,
        expiresAt: Date.now() + 5_000,
      },
      envelope: {
        v: 4,
        suite: 1,
        roomInstance,
        messageId: previewMessageId,
        route: "group",
        payload: toBase64Url(new Uint8Array([1])),
      },
    };
    const runtimeEffects: SecureRelayEffectV4[] = [
      {
        type: "commit-preview",
        fromDeviceId: deviceId,
        toHostDeviceId: deviceId,
        frame: previewFrame,
        logicalOrder: 1,
      },
      {
        type: "commit-rejected",
        deviceId,
        messageId: previewMessageId,
        reason: "host-rejected",
      },
      {
        type: "replay-backlog",
        toDeviceId: deviceId,
        entries: [
          {
            kind: "commit-result",
            receivedAt: Date.now(),
            logicalOrder: null,
            messageId: acceptedMessageId,
            result: "accepted",
            reason: null,
          },
          {
            kind: "commit-result",
            receivedAt: Date.now(),
            logicalOrder: null,
            messageId: rejectedMessageId,
            result: "rejected",
            reason: "approval-expired",
          },
        ],
      },
      {
        type: "backlog-end",
        toDeviceId: deviceId,
        lastMessageId: rejectedMessageId,
      },
    ];
    (room as any).dispatchSecureEffects(runtimeEffects);
    const dispatched = resumedSocket.sent
      .map((raw) => parseSecureServerFrameV4(JSON.parse(raw)))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
    expect(dispatched.some((frame) => frame.type === "commit-preview"
      && frame.frame.envelope.messageId === previewMessageId)).toBe(true);
    expect(dispatched.some((frame) => frame.type === "commit-rejected"
      && frame.messageId === previewMessageId && frame.reason === "host-rejected")).toBe(true);
    expect(dispatched.some((frame) => frame.type === "frame-accepted"
      && frame.messageId === acceptedMessageId)).toBe(true);
    expect(dispatched.some((frame) => frame.type === "commit-rejected"
      && frame.messageId === rejectedMessageId && frame.reason === "approval-expired")).toBe(true);
    expect(dispatched.some((frame) => frame.type === "backlog-end"
      && frame.lastMessageId === rejectedMessageId)).toBe(true);

    await room.webSocketClose(resumedSocket as unknown as WebSocket);
    const disconnectedState = (room as any).secureRelayState as {
      clockHighWater: number;
      members: Array<{ deviceId: string; disconnectExpiresAt: number | null }>;
    };
    const disconnectedHost = disconnectedState.members.find((member) => member.deviceId === deviceId)!;
    disconnectedHost.disconnectExpiresAt = disconnectedState.clockHighWater + 1;
    const expiryDelay = disconnectedHost.disconnectExpiresAt - Date.now() + 1;
    if (expiryDelay > 0) await Bun.sleep(expiryDelay);

    const expiredChallenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiredConnectionId = generateSecureRelayIdV4();
    const expiredRequestId = generateSecureRelayIdV4();
    const expiredSocket = new TestSocket({
      name: "", hash: "0002", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
      ip: "hashed-source", authChallenge: expiredChallenge,
      authChallengeExpiresAt: Date.now() + 30_000, authAttempted: false,
      preAuthFrames: 0, protocol: "v4", secureConnectionId: expiredConnectionId,
      secureChallenge: expiredChallenge, secureChallengeExpiresAt: Date.now() + 30_000,
      secureAuthenticated: false,
    }, state.storage.events);
    state.sockets.push(expiredSocket);
    const expiredProof = await signSecureDeviceResumeProofV4({
      roomId, roomInstance, deviceId, connectionId: expiredConnectionId,
      requestId: expiredRequestId, challenge: expiredChallenge,
    }, (bytes) => signAsync(bytes, credentialSeed));
    const eventOffset = state.storage.events.length;
    await room.webSocketMessage(expiredSocket as unknown as WebSocket, JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "resume",
      frame: {
        kind: "resume", v: 4, suite: 1, roomInstance,
        requestId: expiredRequestId, deviceId,
      },
      resumeProof: expiredProof,
    }));
    const expiredFrames = expiredSocket.sent
      .map((raw) => parseSecureServerFrameV4(JSON.parse(raw)))
      .filter(Boolean);
    expect(expiredFrames.some((frame) => frame?.type === "error" && frame.code === "room-retired")).toBe(true);
    expect(expiredFrames.some((frame) => frame?.type === "authenticated")).toBe(false);
    expect(expiredSocket.attachment.secureAuthenticated).toBe(false);
    expect(expiredSocket.closed).toEqual({ code: 1008, reason: "room retired" });
    const expiryEvents = state.storage.events.slice(eventOffset);
    expect(expiryEvents.indexOf("transaction-committed")).toBeGreaterThanOrEqual(0);
    expect(expiryEvents.indexOf("transaction-committed")).toBeLessThan(expiryEvents.indexOf("socket-send"));
  }, 10_000);

  it("allows only one protocol generation to win a concurrent setup", async () => {
    const roomId = "f-bbbbbbbbbb";
    const state = new TestState();
    state.storage.values.set("roomId", roomId);
    const room = new Room(state as unknown as DurableObjectState, env());
    await state.ready;

    const legacyChallenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const legacy = new TestSocket({
      name: "", hash: "0001", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
      ip: "legacy-source", authChallenge: legacyChallenge,
      authChallengeExpiresAt: Date.now() + 30_000, authAttempted: false,
      preAuthFrames: 0, protocol: "legacy",
    }, state.storage.events);
    const secureChallenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const connectionId = generateSecureRelayIdV4();
    const deviceId = generateSecureRelayIdV4();
    const roomInstance = generateSecureRelayIdV4();
    const requestId = generateSecureRelayIdV4();
    const secure = new TestSocket({
      name: "", hash: "0002", isHost: false, hostRejected: false,
      status: "available", awayText: null, msgTimestamps: [], drawTimestamps: [],
      ip: "secure-source", authChallenge: secureChallenge,
      authChallengeExpiresAt: Date.now() + 30_000, authAttempted: false,
      preAuthFrames: 0, protocol: "v4", secureConnectionId: connectionId,
      secureChallenge, secureChallengeExpiresAt: Date.now() + 30_000,
      secureAuthenticated: false,
    }, state.storage.events);
    state.sockets.push(legacy, secure);

    const legacyAuth = await createRoomAuthPayload(
      roomId, "legacy secret phrase", legacyChallenge, "set-up", "legacy founder",
    );
    const secureContext = {
      mode: "setup" as const, roomId, roomInstance, deviceId, connectionId, requestId,
      challenge: secureChallenge,
    };
    const credentialSeed = crypto.getRandomValues(new Uint8Array(32));
    const roomSecret = "secure invitation secret";
    const signaturePublicKey = toBase64Url(await getPublicKeyAsync(credentialSeed));
    const keyPackage = toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
    const secureWire = JSON.stringify({
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup",
      frame: {
        kind: "setup", requestId,
        signaturePublicKey,
        hello: {
          v: 4, suite: 1, roomInstance, deviceId,
          keyPackage,
        },
        memberBinding: await founderBinding({
          roomId, roomInstance, deviceId, requestId, signaturePublicKey, keyPackage, roomSecret,
        }),
      },
      auth: await createRoomInvitationAuthV4(secureContext, roomSecret),
    });

    await Promise.all([
      room.webSocketMessage(secure as unknown as WebSocket, secureWire),
      room.webSocketMessage(legacy as unknown as WebSocket, JSON.stringify({
        type: "set-up", name: "legacy founder", auth: legacyAuth,
      })),
    ]);

    const events = [...legacy.sent, ...secure.sent].map(JSON.parse);
    expect(events.filter((event) => event.type === "room-created" || event.type === "authenticated")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    const hasLegacy = state.storage.values.has("authPublicKey");
    const hasSecure = state.storage.values.has(SECURE_RELAY_MANIFEST_KEY_V4);
    expect(Number(hasLegacy) + Number(hasSecure)).toBe(1);
  }, 15_000);
});
