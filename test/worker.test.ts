import { describe, expect, it } from "bun:test";
import { FORT_PASS_EXTENDED_IDLE_MS, FORT_PASS_MAX_LIFETIME_MS, type FortPassEntitlement } from "../src/entitlements";
import worker, { Room, type Env } from "../src/index";
import { ROOM_CREATE_LIMIT_PATH, ROOM_FORT_PASS_FULFILL_PATH, ROOM_FORT_PASS_RELEASE_PATH, ROOM_FORT_PASS_RESERVATION_PATH, ROOM_FORT_PASS_RESERVE_PATH, ROOM_FORT_PASS_REVOKE_PATH, ROOM_STATUS_PATH, ROOM_STRIPE_SESSION_LEDGER_PATH, ROOM_WS_OPEN_LIMIT_PATH } from "../src/routes";
import { computeStripeWebhookSignature } from "../src/stripe";
import { withSecurityHeaders } from "../src/security";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  ROOM_AUTH_CHALLENGE_TTL_MS,
  ROOM_AUTH_KDF_ID,
  roomAuthProofBytes,
  toBase64Url,
  type RoomAuthAction,
} from "../src/roomAuth";

const WORKER_ORIGIN = "https://pillow.test";
const TEST_FORT_PASS_CLAIM_SECRET = "11".repeat(32);
const TEST_FORT_PASS_CLAIM_HASH = "02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc";

function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: WORKER_ORIGIN,
    "cf-connecting-ip": "203.0.113.10",
    ...extra,
  };
}

function stripeCheckoutSession(
  created: number,
  roomId = "party-1",
  sessionId = "cs_test_123",
  priceId = "price_test",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: sessionId,
    object: "checkout.session",
    created,
    livemode: false,
    mode: "payment",
    payment_status: "paid",
    status: "complete",
    client_reference_id: `fort-pass:${roomId}`,
    amount_total: 500,
    amount_subtotal: 500,
    currency: "usd",
    metadata: {
      kind: "fort-pass",
      entitlement_kind: "fort-pass",
      custom_room_code: roomId,
      price_id: priceId,
      claim_hash: TEST_FORT_PASS_CLAIM_HASH,
    },
    line_items: {
      object: "list",
      has_more: false,
      data: [{
        object: "item",
        quantity: 1,
        amount_total: 500,
        amount_subtotal: 500,
        currency: "usd",
        price: {
          object: "price",
          id: priceId,
          type: "one_time",
          unit_amount: 500,
          currency: "usd",
          livemode: false,
        },
      }],
    },
    ...overrides,
  };
}

function stripeCheckoutEvent(created: number, roomId = "party-1", sessionId = "cs_test_123") {
  const session = stripeCheckoutSession(created, roomId, sessionId);
  return {
    object: "event",
    id: "evt_test_123",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: { ...session, line_items: undefined },
    },
  };
}

class FakeStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  alarmDeleted = false;
  deletedAll = false;
  private transactionQueue: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string | string[]): Promise<void> {
    for (const value of Array.isArray(key) ? key : [key]) this.values.delete(value);
  }

  async deleteAll(): Promise<void> {
    this.deletedAll = true;
    this.values.clear();
  }

  async list<T>(): Promise<Map<string, T>> {
    return new Map(this.values) as Map<string, T>;
  }

  async setAlarm(deadline: number): Promise<void> {
    this.alarm = deadline;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmDeleted = true;
    this.alarm = null;
  }

  async transaction<T>(callback: (transaction: FakeStorage) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionQueue;
    this.transactionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await callback(this); } finally { release(); }
  }
}

class FakeSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  attachment: unknown = {
    name: "",
    hash: "0000",
    isHost: false,
    hostRejected: false,
    status: "available",
    awayText: null,
    msgTimestamps: [],
  };

  send(message: string) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }

  deserializeAttachment() {
    return this.attachment;
  }

  serializeAttachment(value: unknown) {
    this.attachment = value;
  }
}

class FakeDurableObjectState {
  storage = new FakeStorage();
  sockets: FakeSocket[] = [];
  ready: Promise<void> = Promise.resolve();

  blockConcurrencyWhile(callback: () => Promise<void>) {
    this.ready = callback();
    return this.ready;
  }

  getWebSockets() {
    return this.sockets;
  }

  acceptWebSocket() {}
}

async function roomAuth(socket: FakeSocket, roomId: string, name: string, action: RoomAuthAction, password = "correct horse battery staple") {
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  socket.attachment = {
    ...(socket.attachment as object),
    authChallenge: challenge,
    authChallengeExpiresAt: Date.now() + ROOM_AUTH_CHALLENGE_TTL_MS,
    authAttempted: false,
  };
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: new TextEncoder().encode(`pillowfort:auth-sign-v2:${roomId}`),
    iterations: 600_000,
    hash: "SHA-256",
  }, material, 256));
  const publicKey = toBase64Url(await getPublicKeyAsync(seed));
  const proof = toBase64Url(await signAsync(roomAuthProofBytes(action, roomId, name, challenge, publicKey), seed));
  return {
    v: 2 as const,
    kdf: ROOM_AUTH_KDF_ID,
    challenge,
    proof,
    ...(action === "set-up" ? { publicKey } : {}),
  };
}

function createWorkerEnv() {
  const routed: Request[] = [];
  const assetRequests: Request[] = [];
  const roomStatus = new Map<string, boolean>();
  const fulfilledEntitlements = new Map<string, FortPassEntitlement>();
  const fulfilledClaimHashes = new Map<string, string>();
  const fulfillmentBodies: Array<{ entitlement: FortPassEntitlement; claimHash: string }> = [];
  const reservations = new Set<string>();
  const targetReservations = new Map<string, {
    expiresAt: number;
    token: string;
    sessionId: string | null;
    claimHash: string;
  }>();
  const routedIds: string[] = [];
  const wsOpenLimit = { remaining: Number.POSITIVE_INFINITY, unavailable: false };
  const stripeLedgers = new Map<string, {
    status: "pending" | "complete";
    roomId: string;
    token?: string;
    leaseExpiresAt?: number;
  }>();
  const env = {
    ROOM: {
      idFromName(name: string) {
        return { name };
      },
      get(id: { name: string }) {
        return {
          async fetch(request: Request) {
            routed.push(request);
            routedIds.push(id.name);
            const pathname = new URL(request.url).pathname;
            if (pathname === ROOM_WS_OPEN_LIMIT_PATH) {
              if (wsOpenLimit.unavailable) return new Response("unavailable", { status: 503 });
              if (wsOpenLimit.remaining <= 0) {
                return new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
              }
              wsOpenLimit.remaining--;
              return new Response(null, { status: 204 });
            }
            if (pathname === ROOM_STRIPE_SESSION_LEDGER_PATH) {
              const action = await request.json() as {
                action: "claim" | "complete" | "release";
                roomId: string;
                token: string;
              };
              const existing = stripeLedgers.get(id.name);
              if (existing && existing.roomId !== action.roomId) return new Response("conflict", { status: 409 });
              if (action.action === "claim") {
                if (existing?.status === "complete") return Response.json({ status: "complete" });
                if (existing?.status === "pending" && existing.token !== action.token
                  && (existing.leaseExpiresAt || 0) > Date.now()) {
                  return new Response("busy", { status: 409, headers: { "retry-after": "300" } });
                }
                const leaseExpiresAt = Date.now() + 300_000;
                stripeLedgers.set(id.name, {
                  status: "pending", roomId: action.roomId, token: action.token, leaseExpiresAt,
                });
                return Response.json({ status: "claimed", leaseExpiresAt }, { status: 201 });
              }
              if (action.action === "complete") {
                if (existing?.status === "complete") return new Response(null, { status: 204 });
                if (existing?.status !== "pending" || existing.token !== action.token) {
                  return new Response("conflict", { status: 409 });
                }
                stripeLedgers.set(id.name, { status: "complete", roomId: action.roomId });
                return new Response(null, { status: 204 });
              }
              if (existing?.status === "pending" && existing.token === action.token) stripeLedgers.delete(id.name);
              return new Response(null, { status: 204 });
            }
            if (pathname === ROOM_STATUS_PATH) {
              const owner = targetReservations.get(id.name);
              return Response.json({
                exists: roomStatus.get(id.name) === true || (!!owner && owner.expiresAt > Date.now()),
              });
            }
            if (pathname === ROOM_FORT_PASS_FULFILL_PATH) {
              const value = await request.json() as { entitlement: FortPassEntitlement; claimHash: string };
              if (Reflect.ownKeys(value).length !== 2
                || !value.entitlement || !/^[a-f0-9]{64}$/u.test(value.claimHash)) {
                return new Response("bad fulfillment", { status: 400 });
              }
              const { entitlement, claimHash } = value;
              fulfillmentBodies.push(value);
              const owner = targetReservations.get(id.name);
              const existing = fulfilledEntitlements.get(id.name);
              if (existing?.providerRef === entitlement.providerRef) return Response.json({ ok: true, replay: true });
              if (!owner || owner.sessionId !== entitlement.providerRef || owner.claimHash !== claimHash) {
                return new Response("wrong reservation owner", { status: 409 });
              }
              fulfilledEntitlements.set(id.name, entitlement);
              fulfilledClaimHashes.set(id.name, claimHash);
              targetReservations.delete(id.name);
              reservations.delete(id.name);
              roomStatus.set(id.name, true);
              return Response.json({ ok: true });
            }
            if (pathname === ROOM_FORT_PASS_RESERVATION_PATH) {
              const value = await request.json() as Record<string, string>;
              const existing = targetReservations.get(id.name);
              if (value.action === "claim") {
                if (existing && existing.expiresAt > Date.now()) return new Response("taken", { status: 409 });
                if (existing?.sessionId) {
                  return Response.json({ status: "supersession-required", sessionId: existing.sessionId });
                }
                targetReservations.set(id.name, {
                  expiresAt: Date.now() + 40 * 60_000,
                  token: value.token,
                  sessionId: null,
                  claimHash: value.claimHash,
                });
                reservations.add(id.name);
                return Response.json({ status: "claimed" }, { status: 201 });
              }
              if (value.action === "supersede") {
                if (!existing || existing.expiresAt > Date.now() || existing.sessionId !== value.priorSessionId) {
                  return new Response("conflict", { status: 409 });
                }
                targetReservations.set(id.name, {
                  expiresAt: Date.now() + 40 * 60_000,
                  token: value.token,
                  sessionId: null,
                  claimHash: value.claimHash,
                });
                reservations.add(id.name);
                return Response.json({ status: "claimed" }, { status: 201 });
              }
              if (value.action === "bind") {
                if (!existing || existing.expiresAt <= Date.now() || existing.token !== value.token
                  || (existing.sessionId !== null && existing.sessionId !== value.sessionId)) {
                  return new Response("conflict", { status: 409 });
                }
                existing.sessionId = value.sessionId;
                targetReservations.set(id.name, existing);
                return new Response(null, { status: 204 });
              }
              if (value.action === "release") {
                if (existing?.token === value.token && existing.sessionId === null) {
                  targetReservations.delete(id.name);
                  reservations.delete(id.name);
                }
                return new Response(null, { status: 204 });
              }
              return new Response("bad reservation", { status: 400 });
            }
            if (pathname === ROOM_FORT_PASS_REVOKE_PATH) {
              const value = await request.json() as { sessionId: string; reason: "refund" | "dispute" };
              const existing = fulfilledEntitlements.get(id.name);
              const owner = targetReservations.get(id.name);
              if (!existing && owner?.sessionId === value.sessionId) {
                targetReservations.delete(id.name);
                reservations.delete(id.name);
                fulfilledClaimHashes.delete(id.name);
                return Response.json({ revoked: true, replay: false, reason: value.reason });
              }
              if (!existing || existing.providerRef !== value.sessionId) {
                return Response.json({ revoked: false, stale: true });
              }
              const replay = existing.status === "refunded";
              fulfilledEntitlements.set(id.name, { ...existing, status: "refunded" });
              fulfilledClaimHashes.delete(id.name);
              roomStatus.set(id.name, false);
              return Response.json({ revoked: true, replay, reason: value.reason });
            }
            if (pathname === ROOM_FORT_PASS_RESERVE_PATH) {
              if (roomStatus.get(id.name) || reservations.has(id.name)) return new Response("taken", { status: 409 });
              reservations.add(id.name);
              return new Response(null, { status: 204 });
            }
            if (pathname === ROOM_FORT_PASS_RELEASE_PATH) {
              reservations.delete(id.name);
              return new Response(null, { status: 204 });
            }
            return new Response(`room:${id.name}`, { status: 209 });
          },
        };
      },
    },
    ASSETS: {
      fetch(request: Request) {
        assetRequests.push(request);
        return new Response("asset", {
          headers: { "content-type": "text/html" },
        });
      },
    },
  } as unknown as Env;

  return {
    env, routed, routedIds, assetRequests, roomStatus, fulfilledEntitlements, fulfilledClaimHashes,
    fulfillmentBodies,
    reservations, targetReservations, wsOpenLimit, stripeLedgers,
  };
}

describe("Worker production entrypoint", () => {
  it("preserves the accepted WebSocket while wrapping an upgrade response", () => {
    const acceptedWebSocket = {} as WebSocket;
    const upgrade = new Response(null, { status: 101 });
    Object.defineProperty(upgrade, "webSocket", { value: acceptedWebSocket });

    const wrapped = withSecurityHeaders(upgrade);

    expect(wrapped.status).toBe(101);
    expect(wrapped.webSocket).toBe(acceptedWebSocket);
    expect(wrapped.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("routes valid websocket room requests to the Room Durable Object", async () => {
    const { env, routed } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/ws?room=abc12345&protocol=4", {
      headers: browserHeaders(),
    }), env);

    expect(res.status).toBe(209);
    expect(await res.text()).toBe("room:abc12345");
    expect(routed).toHaveLength(2);
    expect(new URL(routed[0].url).pathname).toBe(ROOM_WS_OPEN_LIMIT_PATH);
    expect(new URL(routed[1].url).searchParams.get("room")).toBe("abc12345");
  });

  it("bounds distinct-room websocket fan-out before target Durable Object routing", async () => {
    const { env, routedIds, wsOpenLimit } = createWorkerEnv();
    wsOpenLimit.remaining = 2;

    const responses = [];
    for (const room of ["fanout01", "fanout02", "fanout03"]) {
      responses.push(await worker.fetch(new Request(
        `https://pillow.test/ws?room=${room}&protocol=4`,
        { headers: browserHeaders() },
      ), env));
    }

    expect(responses.map((response) => response.status)).toEqual([209, 209, 429]);
    const limiterIds = routedIds.filter((id) => id.startsWith("__ws_open_limit__:"));
    expect(new Set(limiterIds).size).toBe(1);
    expect(limiterIds[0]).not.toContain("203.0.113.10");
    expect(routedIds).toContain("fanout01");
    expect(routedIds).toContain("fanout02");
    expect(routedIds).not.toContain("fanout03");
  });

  it("fails websocket routing closed when the source limiter is unavailable", async () => {
    const { env, routedIds, wsOpenLimit } = createWorkerEnv();
    wsOpenLimit.unavailable = true;

    const response = await worker.fetch(new Request(
      "https://pillow.test/ws?room=fanout04&protocol=4",
      { headers: browserHeaders() },
    ), env);

    expect(response.status).toBe(503);
    expect(routedIds.some((id) => id.startsWith("__ws_open_limit__:"))).toBe(true);
    expect(routedIds).not.toContain("fanout04");
  });

  it("does not trust forwarded websocket source headers when Cloudflare identity is absent", async () => {
    const { env, routedIds } = createWorkerEnv();
    const response = await worker.fetch(new Request(
      "https://pillow.test/ws?room=fanout05&protocol=4",
      { headers: { origin: WORKER_ORIGIN, "x-forwarded-for": "203.0.113.10" } },
    ), env);

    expect(response.status).toBe(503);
    expect(routedIds).toHaveLength(0);
  });

  it("rejects websocket requests without a usable room id", async () => {
    const { env, routed } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/ws?protocol=4", {
      headers: browserHeaders(),
    }), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid room");
    expect(routed).toHaveLength(0);
  });

  it("rejects duplicate room or protocol selectors before Durable Object routing", async () => {
    const { env, routed } = createWorkerEnv();

    for (const query of [
      "room=abc12345&room=mallory1",
      "room=abc12345&protocol=4&protocol=3",
      "room=abc12345&protocol=4&password=not-a-real-secret",
      "room=abc12345&protocol=4&secret=not-a-real-secret",
    ]) {
      const res = await worker.fetch(new Request(`https://pillow.test/ws?${query}`, {
        headers: browserHeaders(),
      }), env);

      expect(res.status).toBe(400);
      expect(await res.text()).toBe("invalid websocket parameters");
    }
    expect(routed).toHaveLength(0);
  });

  it("requires an explicit protocol-v4 selector before Durable Object routing", async () => {
    const { env, routed } = createWorkerEnv();

    for (const suffix of ["", "&protocol=legacy", "&protocol=3"]) {
      const res = await worker.fetch(new Request(
        `https://pillow.test/ws?room=abc12345${suffix}`,
        { headers: browserHeaders() },
      ), env);
      expect(res.status).toBe(426);
      expect(await res.text()).toBe("protocol v4 required");
    }
    expect(routed).toHaveLength(0);
  });

  it("rejects invalid websocket room ids before Durable Object routing", async () => {
    const { env, routed } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/ws?room=analytics&protocol=4", {
      headers: browserHeaders(),
    }), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid room");
    expect(routed).toHaveLength(0);
  });

  it("serves room links through the assets binding as index.html", async () => {
    const { env, assetRequests } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/abc12345"), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
    expect(assetRequests).toHaveLength(1);
    expect(new URL(assetRequests[0].url).pathname).toBe("/");
  });

  it("serves custom paid room links through the assets binding", async () => {
    const { env, assetRequests } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/party-1"), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset");
    expect(assetRequests).toHaveLength(1);
    expect(new URL(assetRequests[0].url).pathname).toBe("/");
  });

  it("uses relative canonical redirects and never forwards mutation methods to static assets", async () => {
    const { env, assetRequests } = createWorkerEnv();

    const alias = await worker.fetch(new Request("https://pillow.test/Party-1?invite=yes"), env);
    const mutation = await worker.fetch(new Request("https://pillow.test/assets/app.js", {
      method: "POST",
      body: "unexpected",
    }), env);

    expect(alias.status).toBe(308);
    expect(alias.headers.get("location")).toBe("/party-1?invite=yes");
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET, HEAD");
    expect(mutation.headers.get("cache-control")).toBe("no-store");
    expect(assetRequests).toHaveLength(0);
  });

  it("validates analytics events at the Worker boundary", async () => {
    const { env } = createWorkerEnv();

    const accepted = await worker.fetch(new Request("https://pillow.test/analytics", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        event: "fort_pass_status_checked",
        props: { source: "setup", text: "must be dropped" },
      }),
    }), env);
    const protectedMetadata = await worker.fetch(new Request("https://pillow.test/analytics", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ event: "game_started", props: { kind: "rps" } }),
    }), env);
    const rejected = await worker.fetch(new Request("https://pillow.test/analytics", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        event: "message_text",
        props: { text: "must not be collected" },
      }),
    }), env);

    expect(accepted.status).toBe(204);
    expect(protectedMetadata.status).toBe(400);
    expect(rejected.status).toBe(400);
  });

  it("rate limits analytics before parsing or logging attacker-controlled bodies", async () => {
    const { env, routedIds, wsOpenLimit } = createWorkerEnv();
    wsOpenLimit.remaining = 0;
    const response = await worker.fetch(new Request(`${WORKER_ORIGIN}/analytics`, {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ event: "fort_pass_status_checked", props: { source: "test" } }),
    }), env);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(routedIds).toHaveLength(1);
    expect(routedIds[0].startsWith("__public_surface_limit__:analytics:")).toBe(true);
  });

  it("requires an exact same-origin browser context for mutation endpoints", async () => {
    const { env } = createWorkerEnv();
    const analyticsBody = JSON.stringify({ event: "game_started", props: { kind: "rps" } });

    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", origin: "https://evil.example" },
      { "content-type": "application/json", origin: "null" },
      {
        "content-type": "application/json",
        origin: WORKER_ORIGIN,
        "sec-fetch-site": "cross-site",
      },
    ]) {
      const response = await worker.fetch(new Request(`${WORKER_ORIGIN}/analytics`, {
        method: "POST",
        headers,
        body: analyticsBody,
      }), env);
      expect(response.status).toBe(403);
    }

    const checkout = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ customRoomCode: "party-1" }),
    }), env);
    const websocket = await worker.fetch(new Request(`${WORKER_ORIGIN}/ws?room=party-1`, {
      headers: { origin: "https://evil.example" },
    }), env);

    expect(checkout.status).toBe(403);
    expect(websocket.status).toBe(403);
  });

  it("requires JSON media types for browser JSON mutations", async () => {
    const { env } = createWorkerEnv();

    const analytics = await worker.fetch(new Request(`${WORKER_ORIGIN}/analytics`, {
      method: "POST",
      headers: browserHeaders({ "content-type": "text/plain" }),
      body: JSON.stringify({ event: "game_started" }),
    }), env);
    const checkout = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/checkout`, {
      method: "POST",
      headers: browserHeaders({ "content-type": "text/plain" }),
      body: JSON.stringify({ customRoomCode: "party-1" }),
    }), env);

    expect(analytics.status).toBe(415);
    expect(checkout.status).toBe(415);
  });

  it("blocks commodity scanner paths before assets or rooms", async () => {
    const { env, routed, assetRequests } = createWorkerEnv();

    const paths = [
      "/.env.prod",
      "/.%65%6Ev.%62%61%6B",
      "/.git/refs/heads/main",
      "/wp-content/sallu.php",
      "/cgi-bin/",
      "/test.php",
    ];

    for (const path of paths) {
      const res = await worker.fetch(new Request(`https://pillow.test${path}`), env);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect(routed).toHaveLength(0);
    expect(assetRequests).toHaveLength(0);
  });

  it("adds security headers to normal asset responses", async () => {
    const { env } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/"), env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("strict-transport-security")).toContain("includeSubDomains");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves activity route with Discord-compatible frame headers", async () => {
    const { env, assetRequests } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/activity?frame_id=frame-test"), env);

    expect(res.status).toBe(200);
    expect(assetRequests).toHaveLength(1);
    expect(new URL(assetRequests[0].url).pathname).toBe("/");
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("frame-ancestors https://discord.com https://canary.discord.com https://ptb.discord.com");
    expect(csp).not.toContain("*.discord.com");
    expect(csp).not.toContain("discordsays.com");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("reports Fort Pass public beta readiness without secrets", async () => {
    const { env } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: "https://pillow.test",
    } as Env;

    const closed = await worker.fetch(new Request("https://pillow.test/api/fort-pass/status"), env);
    const open = await worker.fetch(new Request("https://pillow.test/api/fort-pass/status"), configuredEnv);

    expect(await closed.json()).toEqual({
      beta: true,
      checkoutConfigured: false,
      priceLabel: "$5",
      perks: ["custom_code", "extended_idle", "theme_pack"],
    });
    expect(await open.json()).toEqual({
      beta: true,
      checkoutConfigured: true,
      priceLabel: "$5",
      perks: ["custom_code", "extended_idle", "theme_pack"],
    });
  });

  it("reports Fort Pass custom-code availability through room status only", async () => {
    const { env, roomStatus } = createWorkerEnv();
    roomStatus.set("taken-1", true);

    const available = await worker.fetch(new Request("https://pillow.test/api/fort-pass/code?code=Party-1", {
      headers: browserHeaders(),
    }), env);
    const taken = await worker.fetch(new Request("https://pillow.test/api/fort-pass/code?code=taken-1", {
      headers: browserHeaders(),
    }), env);
    const invalid = await worker.fetch(new Request("https://pillow.test/api/fort-pass/code?code=analytics"), env);

    expect(available.headers.get("cache-control")).toBe("no-store");
    expect(await available.json()).toEqual({ code: "party-1", available: true });
    expect(await taken.json()).toEqual({ code: "taken-1", available: false, reason: "taken" });
    expect(await invalid.json()).toEqual({ code: null, available: false, reason: "invalid" });
  });

  it("rate limits public availability before routing an attacker-selected room", async () => {
    const { env, routedIds, wsOpenLimit } = createWorkerEnv();
    wsOpenLimit.remaining = 1;

    const first = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/code?code=party-1`, {
      headers: browserHeaders(),
    }), env);
    const limited = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/code?code=party-2`, {
      headers: browserHeaders(),
    }), env);

    expect(first.status).toBe(200);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(routedIds).toContain("party-1");
    expect(routedIds).not.toContain("party-2");
    expect(routedIds.some(id => id.startsWith("__public_surface_limit__:fort-pass-code:"))).toBe(true);
    expect(routedIds.some(id => id.includes("203.0.113.10"))).toBe(false);
  });

  it("fails valid public availability closed without Cloudflare source identity", async () => {
    const { env, routedIds } = createWorkerEnv();
    const response = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/code?code=party-1`, {
      headers: { "x-forwarded-for": "203.0.113.10" },
    }), env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "code_check_source_unavailable" });
    expect(routedIds).toHaveLength(0);
  });

  it("validates Fort Pass checkout requests without granting an entitlement", async () => {
    const { env, roomStatus, routedIds } = createWorkerEnv();
    roomStatus.set("taken-1", true);

    const invalid = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "analytics", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), env);
    const unavailable = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "taken-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), env);
    const notConfigured = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), env);

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_custom_room_code" });
    expect(unavailable.status).toBe(501);
    expect(await unavailable.json()).toEqual({ error: "checkout_not_configured", code: "taken-1" });
    expect(routedIds).not.toContain("taken-1");
    expect(notConfigured.status).toBe(501);
    expect(await notConfigured.json()).toEqual({ error: "checkout_not_configured", code: "party-1" });

    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: WORKER_ORIGIN,
      STRIPE_FETCHER: async () => Response.json({ id: "cs_test_123", url: "https://checkout.stripe.com/test" }),
    } as Env;
    const taken = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "taken-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), configuredEnv);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "custom_room_code_taken", code: "taken-1" });
  });

  it("creates a Stripe checkout session when provider config is present", async () => {
    const { env } = createWorkerEnv();
    let stripeBody: URLSearchParams | null = null;
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: "https://pillow.test",
      STRIPE_FETCHER: async (_url: string | URL | Request, init?: RequestInit) => {
        stripeBody = init?.body as URLSearchParams;
        return Response.json({
          id: "cs_test_123",
          url: "https://checkout.stripe.com/c/pay/cs_test_123",
        });
      },
    } as Env;

    const res = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), configuredEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: "party-1",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
      sessionId: "cs_test_123",
    });
    expect(stripeBody?.get("metadata[custom_room_code]")).toBe("party-1");
    expect(stripeBody?.get("metadata[claim_hash]")).toBe(TEST_FORT_PASS_CLAIM_HASH);
    expect(stripeBody?.get("success_url")).toBe("https://pillow.test/?fort_pass=success&code=party-1&session_id={CHECKOUT_SESSION_ID}");
  });

  it("rejects missing, non-canonical, insecure, and cross-origin public checkout URLs", async () => {
    const invalidValues: Array<string | undefined> = [
      undefined,
      "http://pillow.test",
      "https://pillow.test/",
      "https://other.test",
      "https://user@pillow.test",
      "https://pillow.test:8443",
      " https://pillow.test",
    ];

    for (const publicBaseUrl of invalidValues) {
      const { env } = createWorkerEnv();
      let stripeCalled = false;
      const configuredEnv = {
        ...env,
        STRIPE_SECRET_KEY: "sk_test_secret",
        FORT_PASS_PRICE_ID: "price_test",
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        ...(publicBaseUrl === undefined ? {} : { PUBLIC_BASE_URL: publicBaseUrl }),
        STRIPE_FETCHER: async () => {
          stripeCalled = true;
          return Response.json({ id: "cs_test_123", url: "https://checkout.stripe.com/test" });
        },
      } as Env;

      const response = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/checkout`, {
        method: "POST",
        headers: browserHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
      }), configuredEnv);

      expect(response.status).toBe(501);
      expect(stripeCalled).toBe(false);
    }
  });

  it("allows an exact loopback HTTP checkout origin only for local development", async () => {
    const { env } = createWorkerEnv();
    let successUrl: string | null = null;
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_FETCHER: async (_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        successUrl = body.get("success_url");
        return Response.json({ id: "cs_test_123", url: "https://checkout.stripe.com/test" });
      },
    } as Env;

    const response = await worker.fetch(new Request("http://localhost:3025/api/fort-pass/checkout", {
      method: "POST",
      headers: {
        origin: "http://localhost:3025",
        "content-type": "application/json",
      },
      body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), configuredEnv);

    expect(response.status).toBe(200);
    expect(successUrl).toBe("http://localhost:3025/?fort_pass=success&code=party-1&session_id={CHECKOUT_SESSION_ID}");
  });

  it("limits checkout reservations per hashed Cloudflare source without retaining the IP", async () => {
    const { env, reservations } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: WORKER_ORIGIN,
      STRIPE_FETCHER: async () => Response.json({ id: "cs_test_123", url: "https://checkout.stripe.com/test" }),
    } as Env;
    const checkout = (code: string, source = "203.0.113.10") => worker.fetch(new Request(
      `${WORKER_ORIGIN}/api/fort-pass/checkout`,
      {
        method: "POST",
        headers: browserHeaders({
          "content-type": "application/json",
          "cf-connecting-ip": source,
        }),
        body: JSON.stringify({ customRoomCode: code, claimHash: TEST_FORT_PASS_CLAIM_HASH }),
      }
    ), configuredEnv);

    expect((await checkout("party-1")).status).toBe(200);
    expect((await checkout("party-2")).status).toBe(200);
    expect((await checkout("party-3")).status).toBe(200);
    const limited = await checkout("party-4");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1800");
    expect(await limited.json()).toEqual({ error: "checkout_rate_limited" });

    expect((await checkout("party-4", "203.0.113.11")).status).toBe(200);
    expect([...reservations].some(key => key.includes("203.0.113"))).toBe(false);
  });

  it("fails closed when Cloudflare source identity is absent on a public checkout", async () => {
    const { env } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: WORKER_ORIGIN,
      STRIPE_FETCHER: async () => Response.json({ id: "cs_test_123", url: "https://checkout.stripe.com/test" }),
    } as Env;

    const response = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/checkout`, {
      method: "POST",
      headers: {
        origin: WORKER_ORIGIN,
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), configuredEnv);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "checkout_source_unavailable" });
  });

  it("atomically reserves a custom code while checkout is in progress", async () => {
    const { env } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: "https://pillow.test",
      STRIPE_FETCHER: async () => Response.json({ id: "cs_test_123", url: "https://checkout.stripe.com/test" }),
    } as Env;
    const request = () => worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), configuredEnv);

    const [first, second] = await Promise.all([request(), request()]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
  });

  it("retains a reservation after an ambiguous Stripe failure", async () => {
    const { env, reservations } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      PUBLIC_BASE_URL: WORKER_ORIGIN,
      STRIPE_FETCHER: async () => { throw new Error("connection reset after request"); },
    } as Env;
    const request = () => worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/checkout`, {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "uncert-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }), configuredEnv);

    const failed = await request();
    const retry = await request();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "checkout_provider_error" });
    expect(retry.status).toBe(409);
    expect(reservations.has("uncert-1")).toBe(true);
  });

  it("does not let a copied Checkout success URL redeem without the originating tab secret", async () => {
    const { env, fulfilledEntitlements, targetReservations, fulfillmentBodies } = createWorkerEnv();
    const created = Math.floor(Date.now() / 1_000);
    const providerSession = stripeCheckoutSession(created);
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_FETCHER: async () => Response.json(providerSession),
    } as Env;
    targetReservations.set("party-1", {
      expiresAt: Date.now() + 40 * 60_000,
      token: "d".repeat(64),
      sessionId: "cs_test_123",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
    });
    const redeem = (body: unknown) => worker.fetch(new Request(`${WORKER_ORIGIN}/api/fort-pass/redeem`, {
      method: "POST",
      headers: browserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }), configuredEnv);

    const stolenUrl = await redeem({ customRoomCode: "party-1", sessionId: "cs_test_123" });
    const wrongSecret = await redeem({
      customRoomCode: "party-1", sessionId: "cs_test_123", claimSecret: "22".repeat(32),
    });
    const valid = await redeem({
      customRoomCode: "party-1", sessionId: "cs_test_123", claimSecret: TEST_FORT_PASS_CLAIM_SECRET,
    });

    expect(stolenUrl.status).toBe(400);
    expect(await stolenUrl.json()).toEqual({ error: "invalid_checkout_redemption" });
    expect(wrongSecret.status).toBe(409);
    expect(await wrongSecret.json()).toEqual({ error: "checkout_not_redeemable" });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ redeemed: true, code: "party-1" });
    expect(fulfilledEntitlements.get("party-1")?.providerRef).toBe("cs_test_123");
    const fulfillmentBody = fulfillmentBodies[0] as unknown as Record<string, unknown>;
    expect(Reflect.ownKeys(fulfillmentBody).sort()).toEqual(["claimHash", "entitlement"]);
    expect(fulfillmentBody.claimHash).toBe(TEST_FORT_PASS_CLAIM_HASH);
    expect(JSON.stringify(fulfillmentBody)).not.toContain(TEST_FORT_PASS_CLAIM_SECRET);
  });

  it("fulfills Fort Pass entitlements from signed Stripe webhooks", async () => {
    const { env, fulfilledEntitlements, routed, stripeLedgers, targetReservations } = createWorkerEnv();
    const created = Math.floor(Date.now() / 1_000);
    const providerSession = stripeCheckoutSession(created);
    let retrievals = 0;
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_FETCHER: async (input: string | URL | Request, init?: RequestInit) => {
        retrievals += 1;
        expect(String(input)).toContain("https://api.stripe.com/v1/checkout/sessions/cs_test_123");
        expect(init?.method).toBe("GET");
        return Response.json(providerSession);
      },
    } as Env;
    const event = stripeCheckoutEvent(created);
    targetReservations.set("party-1", {
      expiresAt: Date.now() + 40 * 60_000,
      token: "a".repeat(64),
      sessionId: "cs_test_123",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
    });
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");
    const webhookRequest = () => worker.fetch(new Request("https://pillow.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    }), configuredEnv);

    const res = await webhookRequest();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, fulfilled: true, code: "party-1" });
    expect(fulfilledEntitlements.get("party-1")?.providerRef).toBe("cs_test_123");
    expect(fulfilledEntitlements.get("party-1")?.perks.customRoomCode).toBe("party-1");
    expect(stripeLedgers.size).toBe(1);

    const replay = await webhookRequest();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, fulfilled: true, code: "party-1", replay: true });
    expect(retrievals).toBe(2);
    expect(routed.filter(request => new URL(request.url).pathname === ROOM_FORT_PASS_FULFILL_PATH)).toHaveLength(1);
  });

  it("authoritatively revokes partial refunds, full refunds, and disputes without touching a newer owner", async () => {
    const cases = [
      { suffix: "partial", roomId: "rvk-part", reason: "refund" as const, amountRefunded: 250 },
      { suffix: "full", roomId: "rvk-full", reason: "refund" as const, amountRefunded: 500 },
      { suffix: "dispute", roomId: "rvk-disp", reason: "dispute" as const, amountRefunded: 0 },
    ];

    for (const testCase of cases) {
      const { env, fulfilledEntitlements, targetReservations, routed } = createWorkerEnv();
      const roomId = testCase.roomId;
      const sessionId = `cs_test_${testCase.suffix}_123`;
      const paymentIntentId = `pi_test_${testCase.suffix}_123`;
      const chargeId = `ch_test_${testCase.suffix}_123`;
      const disputeId = `du_test_${testCase.suffix}_123`;
      const created = Math.floor(Date.now() / 1_000);
      const providerSession = stripeCheckoutSession(created, roomId, sessionId, "price_test", {
        payment_intent: paymentIntentId,
      });
      const providerCharge = {
        id: chargeId,
        object: "charge",
        livemode: false,
        payment_intent: paymentIntentId,
        paid: true,
        captured: true,
        amount: 500,
        amount_captured: 500,
        amount_refunded: testCase.amountRefunded,
        refunded: testCase.amountRefunded === 500,
        currency: "usd",
      };
      const providerDispute = {
        id: disputeId,
        object: "dispute",
        livemode: false,
        charge: chargeId,
        payment_intent: null,
        amount: 250,
        currency: "usd",
        status: "needs_response",
      };
      const configuredEnv = {
        ...env,
        STRIPE_WEBHOOK_SECRET: "whsec_test",
        STRIPE_SECRET_KEY: "sk_test_secret",
        FORT_PASS_PRICE_ID: "price_test",
        STRIPE_FETCHER: async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname === `/v1/checkout/sessions/${sessionId}`) return Response.json(providerSession);
          if (url.pathname === `/v1/charges/${chargeId}`) return Response.json(providerCharge);
          if (url.pathname === `/v1/disputes/${disputeId}`) return Response.json(providerDispute);
          if (url.pathname === "/v1/checkout/sessions" && url.searchParams.get("payment_intent") === paymentIntentId) {
            return Response.json({ object: "list", has_more: false, data: [providerSession] });
          }
          return new Response("not found", { status: 404 });
        },
      } as Env;
      const postSigned = async (event: unknown) => {
        const payload = JSON.stringify(event);
        const timestamp = Math.floor(Date.now() / 1_000);
        const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");
        return worker.fetch(new Request(`${WORKER_ORIGIN}/api/stripe/webhook`, {
          method: "POST",
          headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
          body: payload,
        }), configuredEnv);
      };

      targetReservations.set(roomId, {
        expiresAt: Date.now() + 40 * 60_000,
        token: "c".repeat(64),
        sessionId,
        claimHash: TEST_FORT_PASS_CLAIM_HASH,
      });
      const grant = stripeCheckoutEvent(created, roomId, sessionId);
      grant.id = `evt_test_grant_${testCase.suffix}`;
      expect((await postSigned(grant)).status).toBe(200);
      expect(fulfilledEntitlements.get(roomId)?.status).toBe("active");

      const revocationEvent = testCase.reason === "refund"
        ? {
            object: "event",
            id: `evt_test_refund_${testCase.suffix}`,
            type: "charge.refunded",
            livemode: false,
            data: { object: providerCharge },
          }
        : {
            object: "event",
            id: `evt_test_dispute_${testCase.suffix}`,
            type: "charge.dispute.created",
            livemode: false,
            data: { object: providerDispute },
          };
      const revoked = await postSigned(revocationEvent);
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toEqual({ received: true, processed: true, revoked: true });
      expect(fulfilledEntitlements.get(roomId)?.status).toBe("refunded");

      const replay = await postSigned(revocationEvent);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ received: true, processed: true, replay: true });
      expect(routed.filter(request => new URL(request.url).pathname === ROOM_FORT_PASS_REVOKE_PATH)).toHaveLength(1);

      const newerSessionId = `cs_test_new_${testCase.suffix}_123`;
      const current = fulfilledEntitlements.get(roomId)!;
      fulfilledEntitlements.set(roomId, {
        ...current,
        status: "active",
        hostRef: newerSessionId,
        providerRef: newerSessionId,
      });
      const delayedEvent = {
        ...revocationEvent,
        id: `evt_test_delayed_${testCase.suffix}`,
      };
      const stale = await postSigned(delayedEvent);
      expect(stale.status).toBe(200);
      expect(await stale.json()).toEqual({ received: true, processed: true, stale: true });
      expect(fulfilledEntitlements.get(roomId)?.providerRef).toBe(newerSessionId);
      expect(fulfilledEntitlements.get(roomId)?.status).toBe("active");
    }
  });

  it("cancels exact claim ownership when a refund arrives before Checkout completion", async () => {
    const { env, fulfilledEntitlements, targetReservations, fulfilledClaimHashes } = createWorkerEnv();
    const created = Math.floor(Date.now() / 1_000);
    const paymentIntentId = "pi_test_early_refund_123";
    const chargeId = "ch_test_early_refund_123";
    const providerSession = stripeCheckoutSession(created, "early-rf", "cs_test_early_refund_123", "price_test", {
      payment_intent: paymentIntentId,
    });
    const providerCharge = {
      id: chargeId,
      object: "charge",
      livemode: false,
      payment_intent: paymentIntentId,
      paid: true,
      captured: true,
      amount: 500,
      amount_captured: 500,
      amount_refunded: 250,
      refunded: false,
      currency: "usd",
    };
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_FETCHER: async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === `/v1/charges/${chargeId}`) return Response.json(providerCharge);
        if (url.pathname === "/v1/checkout/sessions" && url.searchParams.get("payment_intent") === paymentIntentId) {
          return Response.json({ object: "list", has_more: false, data: [providerSession] });
        }
        if (url.pathname === "/v1/checkout/sessions/cs_test_early_refund_123") {
          return Response.json(providerSession);
        }
        return new Response("not found", { status: 404 });
      },
    } as Env;
    targetReservations.set("early-rf", {
      expiresAt: Date.now() + 40 * 60_000,
      token: "e".repeat(64),
      sessionId: "cs_test_early_refund_123",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
    });
    const postSigned = async (event: unknown) => {
      const payload = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1_000);
      const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");
      return worker.fetch(new Request(`${WORKER_ORIGIN}/api/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      }), configuredEnv);
    };
    const refund = await postSigned({
      object: "event",
      id: "evt_test_early_refund_123",
      type: "charge.refunded",
      livemode: false,
      data: { object: providerCharge },
    });
    expect(refund.status).toBe(200);
    expect(await refund.json()).toEqual({ received: true, processed: true, revoked: true });
    expect(targetReservations.has("early-rf")).toBe(false);
    expect(fulfilledClaimHashes.has("early-rf")).toBe(false);

    const grant = stripeCheckoutEvent(created, "early-rf", "cs_test_early_refund_123");
    grant.id = "evt_test_late_grant_123";
    const lateGrant = await postSigned(grant);
    expect(lateGrant.status).toBe(502);
    expect(await lateGrant.json()).toEqual({ error: "entitlement_fulfillment_failed" });
    expect(fulfilledEntitlements.has("early-rf")).toBe(false);
  });

  it("rejects a signed event whose authoritative session has another Price", async () => {
    const { env, fulfilledEntitlements, stripeLedgers } = createWorkerEnv();
    const created = Math.floor(Date.now() / 1_000);
    const event = stripeCheckoutEvent(created);
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_FETCHER: async () => Response.json(stripeCheckoutSession(
        created,
        "party-1",
        "cs_test_123",
        "price_attacker",
      )),
    } as Env;

    const response = await worker.fetch(new Request(`${WORKER_ORIGIN}/api/stripe/webhook`, {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    }), configuredEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(fulfilledEntitlements.size).toBe(0);
    expect(stripeLedgers.size).toBe(0);
  });

  it("rejects unsigned Stripe webhooks", async () => {
    const { env } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
    } as Env;

    const res = await worker.fetch(new Request("https://pillow.test/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({ type: "checkout.session.completed" }),
    }), configuredEnv);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_webhook_signature" });
  });

  it("authenticates Stripe webhooks before reporting incomplete fulfillment configuration", async () => {
    const { env } = createWorkerEnv();
    const signingOnlyEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    } as Env;
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");

    const unsigned = await worker.fetch(new Request("https://pillow.test/api/stripe/webhook", {
      method: "POST",
      body: payload,
    }), signingOnlyEnv);
    const signed = await worker.fetch(new Request("https://pillow.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    }), signingOnlyEnv);

    expect(unsigned.status).toBe(400);
    expect(await unsigned.json()).toEqual({ error: "bad_webhook_signature" });
    expect(signed.status).toBe(501);
    expect(await signed.json()).toEqual({ error: "webhook_not_configured" });
  });
});

describe("Room Durable Object alarms", () => {
  function entitlement(code = "party-1"): FortPassEntitlement {
    const now = Date.now();
    return {
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId: code,
      hostRef: "cs_test_123",
      provider: "stripe",
      providerRef: "cs_test_123",
      createdAt: now,
      expiresAt: now + FORT_PASS_MAX_LIFETIME_MS,
      perks: {
        customRoomCode: code,
        extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS,
        themePack: "retro-plus",
      },
    };
  }

  function fulfillmentRequest(value: FortPassEntitlement): Request {
    return new Request("https://pillow.test/__pillowfort/fort-pass/fulfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entitlement: value, claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    });
  }

  async function bindFortPassReservation(room: Room, token: string): Promise<void> {
    const claimed = await room.fetch(new Request("https://pillow.test/__pillowfort/fort-pass/reservation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", token, claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }));
    expect(claimed.status).toBe(201);
    const bound = await room.fetch(new Request("https://pillow.test/__pillowfort/fort-pass/reservation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "bind", token, sessionId: "cs_test_123" }),
    }));
    expect(bound.status).toBe(204);
  }

  async function grantFortPass(room: Room, token: string): Promise<FortPassEntitlement> {
    const value = entitlement("party-1");
    await bindFortPassReservation(room, token);
    expect((await room.fetch(fulfillmentRequest(value))).status).toBe(200);
    return value;
  }

  it("stores fulfilled Fort Pass entitlements before room setup", async () => {
    const state = new FakeDurableObjectState();
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    const token = "a".repeat(64);
    await room.fetch(new Request("https://pillow.test/__pillowfort/fort-pass/reservation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", token, claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    }));
    await room.fetch(new Request("https://pillow.test/__pillowfort/fort-pass/reservation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "bind", token, sessionId: "cs_test_123" }),
    }));
    const res = await room.fetch(fulfillmentRequest(entitlement("party-1")));
    const status = await room.fetch(new Request("https://pillow.test/__pillowfort/room-status"));

    expect(res.status).toBe(200);
    expect(await status.json()).toEqual({ exists: true });
    expect((state.storage.values.get("fortPassEntitlement") as FortPassEntitlement).providerRef).toBe("cs_test_123");
  });

  it("treats repeated fulfillment for the same Stripe session as success", async () => {
    const state = new FakeDurableObjectState();
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const token = "b".repeat(64);
    await bindFortPassReservation(room, token);
    const value = entitlement("party-1");
    const request = () => room.fetch(fulfillmentRequest(value));

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
  });

  it("does not broadcast room events to unauthenticated sockets", async () => {
    const state = new FakeDurableObjectState();
    const host = new FakeSocket();
    const observer = new FakeSocket();
    host.attachment = { ...(host.attachment as object), name: "alice", isHost: true };
    state.sockets.push(host, observer);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "typing" }));
    expect(observer.sent).toHaveLength(0);
  });

  it("bounds and rate limits production drawing events", async () => {
    const state = new FakeDurableObjectState();
    const sender = new FakeSocket();
    const receiver = new FakeSocket();
    sender.attachment = { ...(sender.attachment as object), name: "alice" };
    receiver.attachment = { ...(receiver.attachment as object), name: "bob" };
    state.sockets.push(sender, receiver);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(sender as unknown as WebSocket, JSON.stringify({
      type: "draw", color: "url(javascript:bad)", pts: [[0, 0]],
    }));
    for (let i = 0; i < 41; i++) {
      await room.webSocketMessage(sender as unknown as WebSocket, JSON.stringify({
        type: "draw", color: "hsl(10, 80%, 65%)", pts: [[0.5, 0.5]],
      }));
    }

    expect(receiver.sent).toHaveLength(40);
    expect(sender.sent.map(JSON.parse).at(-1)).toEqual({ type: "error", message: "slow down" });
  });

  it("handles an explicit leave only once when the close callback follows", async () => {
    const state = new FakeDurableObjectState();
    const host = new FakeSocket();
    const guest = new FakeSocket();
    host.attachment = { ...(host.attachment as object), name: "alice", isHost: true };
    guest.attachment = { ...(guest.attachment as object), name: "bob" };
    state.sockets.push(host, guest);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "leave" }));
    await room.webSocketClose(host as unknown as WebSocket);
    const events = guest.sent.map(JSON.parse);
    expect(events.filter(event => event.type === "member-left")).toHaveLength(1);
    expect(events.some(event => event.type === "member-away")).toBe(false);
  });

  it("rate limits production room creation per source identity", async () => {
    const state = new FakeDurableObjectState();
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const request = () => room.fetch(new Request(`https://pillow.test${ROOM_CREATE_LIMIT_PATH}`, { method: "POST" }));

    for (let i = 0; i < 5; i++) expect((await request()).status).toBe(204);
    expect((await request()).status).toBe(429);
  });

  it("persists only the room authentication public key", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "f-aaaaaaaaaa");
    let room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const auth = await roomAuth(socket, "f-aaaaaaaaaa", "alice", "set-up");
    room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth }));

    expect(state.storage.values.get("authPublicKey")).toBe(auth.publicKey);
    expect(state.storage.values.has("authVerifier")).toBe(false);
    expect([...state.storage.values.keys()].some(key => key.includes("proof") || key.includes("password"))).toBe(false);
  });

  it("serializes concurrent setup attempts for one room", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "f-aaaaaaaaaa");
    const alice = new FakeSocket();
    const mallory = new FakeSocket();
    state.sockets.push(alice, mallory);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const [aliceAuth, malloryAuth] = await Promise.all([
      roomAuth(alice, "f-aaaaaaaaaa", "alice", "set-up", "correct horse battery staple"),
      roomAuth(mallory, "f-aaaaaaaaaa", "mallory", "set-up", "another difficult room phrase"),
    ]);

    await Promise.all([
      room.webSocketMessage(alice as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth: aliceAuth })),
      room.webSocketMessage(mallory as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "mallory", auth: malloryAuth })),
    ]);

    const outcomes = [...alice.sent, ...mallory.sent].map(message => JSON.parse(message).type).sort();
    expect(outcomes).toEqual(["error", "room-created"]);
    expect([aliceAuth.publicKey, malloryAuth.publicKey]).toContain(state.storage.values.get("authPublicKey"));
  });

  it("consumes authentication challenges once and rejects tampered proofs", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "f-aaaaaaaaaa");
    const socket = new FakeSocket();
    state.sockets.push(socket);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const auth = await roomAuth(socket, "f-aaaaaaaaaa", "alice", "set-up");
    const tampered = { ...auth, proof: `${auth.proof.slice(0, -1)}${auth.proof.endsWith("A") ? "B" : "A"}` };

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth: tampered }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth }));

    expect(socket.sent.map(JSON.parse)).toEqual([
      { type: "error", message: "authentication failed" },
      { type: "error", message: "authentication failed" },
    ]);
    expect(state.storage.values.has("authPublicKey")).toBe(false);
  });

  it("persists failed-auth throttling per room and source IP", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "f-aaaaaaaaaa");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    const failedAttempts: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      const socket = new FakeSocket();
      socket.attachment = { ...(socket.attachment as object), ip: "source-hash" };
      state.sockets.push(socket);
      await roomAuth(socket, "f-aaaaaaaaaa", "alice", "set-up");
      failedAttempts.push(room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth: {} })));
    }
    await Promise.all(failedAttempts);

    const validSocket = new FakeSocket();
    validSocket.attachment = { ...(validSocket.attachment as object), ip: "source-hash" };
    state.sockets.push(validSocket);
    const validAuth = await roomAuth(validSocket, "f-aaaaaaaaaa", "alice", "set-up");
    await room.webSocketMessage(validSocket as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth: validAuth }));

    expect(JSON.parse(validSocket.sent[0])).toEqual({ type: "error", message: "authentication failed" });
    expect((state.storage.values.get("authFailureBuckets") as Record<string, number[]>)["source-hash"]).toHaveLength(5);
    expect([...state.storage.values.keys()].some(key => key.includes("203.0.113.9"))).toBe(false);
  });

  it("does not let setup proofs clear failed joins for an existing room", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "f-aaaaaaaaaa");
    const host = new FakeSocket();
    host.attachment = { ...(host.attachment as object), name: "alice", isHost: true };
    state.sockets.push(host);
    const hostAuth = await roomAuth(host, "f-aaaaaaaaaa", "alice", "set-up", "correct horse battery staple");
    state.storage.values.set("authPublicKey", hostAuth.publicKey);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    const badJoin = async () => {
      const socket = new FakeSocket();
      socket.attachment = { ...(socket.attachment as object), ip: "source-hash" };
      state.sockets.push(socket);
      const auth = await roomAuth(socket, "f-aaaaaaaaaa", "mallory", "join", "wrong room secret");
      await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "join", name: "mallory", auth }));
      return socket;
    };

    for (let attempt = 0; attempt < 4; attempt++) await badJoin();

    const setupSocket = new FakeSocket();
    setupSocket.attachment = { ...(setupSocket.attachment as object), ip: "source-hash" };
    state.sockets.push(setupSocket);
    const setupAuth = await roomAuth(setupSocket, "f-aaaaaaaaaa", "mallory", "set-up", "attacker controlled secret");
    await room.webSocketMessage(setupSocket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "mallory",
      auth: setupAuth,
    }));

    expect(JSON.parse(setupSocket.sent[0])).toEqual({ type: "error", message: "fort already exists" });
    expect((state.storage.values.get("authFailureBuckets") as Record<string, number[]>)["source-hash"]).toHaveLength(4);

    await badJoin();

    const correctJoinSocket = new FakeSocket();
    correctJoinSocket.attachment = { ...(correctJoinSocket.attachment as object), ip: "source-hash" };
    state.sockets.push(correctJoinSocket);
    const correctJoinAuth = await roomAuth(correctJoinSocket, "f-aaaaaaaaaa", "mallory", "join", "correct horse battery staple");
    await room.webSocketMessage(correctJoinSocket as unknown as WebSocket, JSON.stringify({
      type: "join",
      name: "mallory",
      auth: correctJoinAuth,
    }));

    expect(JSON.parse(correctJoinSocket.sent[0])).toEqual({ type: "error", message: "authentication failed" });
    expect((state.storage.values.get("authFailureBuckets") as Record<string, number[]>)["source-hash"]).toHaveLength(5);
  });

  it("rejects binary and oversized frames before parsing", async () => {
    const state = new FakeDurableObjectState();
    const binary = new FakeSocket();
    const oversized = new FakeSocket();
    state.sockets.push(binary, oversized);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(binary as unknown as WebSocket, new ArrayBuffer(1));
    await room.webSocketMessage(oversized as unknown as WebSocket, "x".repeat(8193));

    expect(binary.closed).toEqual({ code: 1009, reason: "frame too large" });
    expect(oversized.closed).toEqual({ code: 1009, reason: "frame too large" });
  });

  it("caps malformed unauthenticated frames", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    socket.attachment = { ...(socket.attachment as object), preAuthFrames: 0 };
    state.sockets.push(socket);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    for (let index = 0; index < 4; index++) {
      await room.webSocketMessage(socket as unknown as WebSocket, "{");
    }

    expect(socket.closed).toEqual({ code: 1008, reason: "too many unauthenticated frames" });
  });

  it("supports protocol-v2 setup, join, and rejoin", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "f-aaaaaaaaaa");
    const host = new FakeSocket();
    state.sockets.push(host);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const setupAuth = await roomAuth(host, "f-aaaaaaaaaa", "alice", "set-up");
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ type: "set-up", name: "alice", auth: setupAuth }));

    const guest = new FakeSocket();
    guest.attachment = { ...(guest.attachment as object), ip: "203.0.113.10" };
    state.sockets.push(guest);
    const joinAuth = await roomAuth(guest, "f-aaaaaaaaaa", "bob", "join");
    await room.webSocketMessage(guest as unknown as WebSocket, JSON.stringify({ type: "join", name: "bob", auth: joinAuth }));
    await room.webSocketClose(guest as unknown as WebSocket);

    const restored = new FakeSocket();
    restored.attachment = { ...(restored.attachment as object), ip: "203.0.113.10" };
    state.sockets.push(restored);
    const rejoinAuth = await roomAuth(restored, "f-aaaaaaaaaa", "bob", "rejoin");
    await room.webSocketMessage(restored as unknown as WebSocket, JSON.stringify({ type: "rejoin", room: "f-aaaaaaaaaa", name: "bob", auth: rejoinAuth }));

    expect(JSON.parse(host.sent[0]).type).toBe("room-created");
    expect(guest.sent.map(JSON.parse).some(event => event.type === "joined")).toBe(true);
    expect(restored.sent.map(JSON.parse).some(event => event.type === "rejoined")).toBe(true);
  });

  it("rejects legacy encrypted chat envelopes", async () => {
    const state = new FakeDurableObjectState();
    const sender = new FakeSocket();
    const receiver = new FakeSocket();
    sender.attachment = { ...(sender.attachment as object), name: "alice" };
    receiver.attachment = { ...(receiver.attachment as object), name: "bob" };
    state.sockets.push(sender, receiver);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(sender as unknown as WebSocket, JSON.stringify({
      type: "chat", enc: { v: 2, iv: "A".repeat(16), ct: "A".repeat(16) },
    }));

    expect(JSON.parse(sender.sent[0])).toEqual({ type: "error", message: "encrypted chat required" });
    expect(receiver.sent).toHaveLength(0);
  });

  it("does not relay unauthenticated outer chat style or plaintext", async () => {
    const state = new FakeDurableObjectState();
    const sender = new FakeSocket();
    const receiver = new FakeSocket();
    sender.attachment = { ...(sender.attachment as object), name: "alice" };
    receiver.attachment = { ...(receiver.attachment as object), name: "bob" };
    state.sockets.push(sender, receiver);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const enc = {
      v: 3,
      kdf: "pbkdf2-sha256-600k-v1",
      sid: "sender-session-id",
      seq: 1,
      iv: "A".repeat(16),
      ct: "A".repeat(16),
    };

    await room.webSocketMessage(sender as unknown as WebSocket, JSON.stringify({
      type: "chat",
      text: "relay-visible plaintext",
      style: { color: "red", bold: true },
      enc,
    }));

    expect(receiver.sent.map(JSON.parse)).toEqual([{ type: "message", from: "alice", enc }]);
  });

  it("checks the production creation limiter before setting up a room", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "f-cccccccccc");
    const socket = new FakeSocket();
    socket.attachment = { ...(socket.attachment as object), ip: "203.0.113.7" };
    state.sockets.push(socket);
    const env = {
      ROOM: {
        idFromName: (name: string) => ({ name }),
        get: () => ({ fetch: async () => new Response("rate limited", { status: 429 }) }),
      },
    } as unknown as Env;
    const room = new Room(state as unknown as DurableObjectState, env);
    await state.ready;
    const auth = await roomAuth(socket, "f-cccccccccc", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
    }));

    expect(JSON.parse(socket.sent[0])).toEqual({ type: "error", message: "slow down — too many forts" });
    expect(state.storage.values.get("authVerifier")).toBeUndefined();
  });

  it("rejects direct setup of a paid custom code without a verified entitlement", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "party-1");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const auth = await roomAuth(socket, "party-1", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
    }));

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "error",
      message: "paid room redemption required",
    });
    expect(state.storage.values.has("authPublicKey")).toBe(false);
  });

  it("uses the Fort Pass idle timeout when a paid room is set up", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    await grantFortPass(room, "c".repeat(64));
    const auth = await roomAuth(socket, "party-1", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
      fortPassSessionId: "cs_test_123",
      fortPassClaimSecret: TEST_FORT_PASS_CLAIM_SECRET,
    }));

    expect(JSON.parse(socket.sent[0]).type).toBe("room-created");
    expect(JSON.parse(socket.sent[0]).fortPass).toEqual({ themePack: "retro-plus" });
    expect(state.storage.alarm).toBeGreaterThan(Date.now() + FORT_PASS_EXTENDED_IDLE_MS - 5_000);
  });

  it("persists premium room themes for paid rooms", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    await grantFortPass(room, "d".repeat(64));
    const auth = await roomAuth(socket, "party-1", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
      fortPassSessionId: "cs_test_123",
      fortPassClaimSecret: TEST_FORT_PASS_CLAIM_SECRET,
    }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-theme",
      theme: "campus-blue",
    }));

    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "room-theme",
      theme: "campus-blue",
    });
    expect(state.storage.values.get("roomTheme")).toBe("campus-blue");
  });

  it("rejects premium room themes for free rooms", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "f-bbbbbbbbbb");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const auth = await roomAuth(socket, "f-bbbbbbbbbb", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
    }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-theme",
      theme: "campus-blue",
    }));

    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "error",
      message: "Fort Pass required",
    });
    expect(state.storage.values.get("roomTheme")).toBeUndefined();
  });

  it("rejects paid room setup without the Fort Pass redemption token", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    await grantFortPass(room, "e".repeat(64));
    const auth = await roomAuth(socket, "party-1", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
    }));

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "error",
      message: "paid room redemption required",
    });
    expect(state.storage.values.get("authVerifier")).toBeUndefined();
  });

  it("replaces legacy verifier state with a fail-closed room tombstone", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("authVerifier", "verifier");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    const res = await room.fetch(new Request("https://pillow.test/__pillowfort/room-status"));

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ exists: true });
    expect(state.storage.values.has("authVerifier")).toBe(false);
    expect(state.storage.values.get("legacyAuthBlocked")).toBe(true);
  });

  it("does not allow an old room code to be reclaimed after verifier removal", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("authVerifier", "verifier");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;
    const auth = await roomAuth(socket, "party-1", "alice", "set-up");

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth,
    }));

    expect(JSON.parse(socket.sent[0])).toEqual({ type: "error", message: "fort already exists" });
    expect(state.storage.values.has("authPublicKey")).toBe(false);
  });

  it("destroys the room when the idle alarm is due", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    socket.attachment = { ...(socket.attachment as object), name: "alice", isHost: true };
    state.sockets.push(socket);
    state.storage.values.set("roomId", "abc12345");
    state.storage.values.set("authVerifier", "verifier");
    state.storage.values.set("alarmSchedule", { idle: Date.now() - 1 });
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.alarm();

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "knocked-down",
      reason: "the fort went quiet for too long",
    });
    expect(socket.closed).toEqual({
      code: 1000,
      reason: "the fort went quiet for too long",
    });
    expect(state.storage.alarmDeleted).toBe(true);
    expect(state.storage.values.size).toBe(0);
  });

  it("prioritizes the saboteur bomb when multiple alarms are due", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    socket.attachment = { ...(socket.attachment as object), name: "alice", isHost: true };
    state.sockets.push(socket);
    state.storage.values.set("roomId", "abc12345");
    state.storage.values.set("alarmSchedule", {
      idle: Date.now() - 1,
      "sab-bomb": Date.now() - 1,
    });
    state.storage.values.set("sabBomb", {
      saboteur: "alice",
      deadline: Date.now() - 1,
      durationMs: 10_000,
    });
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.alarm();

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "knocked-down",
      reason: "the saboteur's bomb exploded!",
    });
    expect(state.storage.values.size).toBe(0);
  });

  it("keeps a future alarm scheduled without destroying the room", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    socket.attachment = {
      ...(socket.attachment as object),
      protocol: "v4",
      secureAuthenticated: true,
    };
    state.sockets.push(socket);
    const deadline = Date.now() + 60_000;
    state.storage.values.set("roomId", "abc12345");
    state.storage.values.set("alarmSchedule", { idle: deadline });
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.alarm();

    expect(socket.sent).toHaveLength(0);
    expect(socket.closed).toBeNull();
    expect(state.storage.alarm).toBe(deadline);
    expect(state.storage.deletedAll).toBe(false);
  });
});
