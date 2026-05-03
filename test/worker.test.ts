import { describe, expect, it } from "bun:test";
import { FORT_PASS_EXTENDED_IDLE_MS, FORT_PASS_MAX_LIFETIME_MS, type FortPassEntitlement } from "../src/entitlements";
import worker, { Room, type Env } from "../src/index";
import { ROOM_FORT_PASS_FULFILL_PATH, ROOM_STATUS_PATH } from "../src/routes";
import { computeStripeWebhookSignature } from "../src/stripe";

class FakeStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  alarmDeleted = false;
  deletedAll = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.deletedAll = true;
    this.values.clear();
  }

  async setAlarm(deadline: number): Promise<void> {
    this.alarm = deadline;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmDeleted = true;
    this.alarm = null;
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

function createWorkerEnv() {
  const routed: Request[] = [];
  const assetRequests: Request[] = [];
  const roomStatus = new Map<string, boolean>();
  const fulfilledEntitlements = new Map<string, FortPassEntitlement>();
  const env = {
    ROOM: {
      idFromName(name: string) {
        return { name };
      },
      get(id: { name: string }) {
        return {
          async fetch(request: Request) {
            routed.push(request);
            if (new URL(request.url).pathname === ROOM_STATUS_PATH) {
              return Response.json({ exists: roomStatus.get(id.name) === true });
            }
            if (new URL(request.url).pathname === ROOM_FORT_PASS_FULFILL_PATH) {
              fulfilledEntitlements.set(id.name, await request.json() as FortPassEntitlement);
              roomStatus.set(id.name, true);
              return Response.json({ ok: true });
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

  return { env, routed, assetRequests, roomStatus, fulfilledEntitlements };
}

describe("Worker production entrypoint", () => {
  it("routes valid websocket room requests to the Room Durable Object", async () => {
    const { env, routed } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/ws?room=abc12345"), env);

    expect(res.status).toBe(209);
    expect(await res.text()).toBe("room:abc12345");
    expect(routed).toHaveLength(1);
    expect(new URL(routed[0].url).searchParams.get("room")).toBe("abc12345");
  });

  it("rejects websocket requests without a usable room id", async () => {
    const { env, routed } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/ws"), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid room");
    expect(routed).toHaveLength(0);
  });

  it("rejects invalid websocket room ids before Durable Object routing", async () => {
    const { env, routed } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/ws?room=analytics"), env);

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

  it("validates analytics events at the Worker boundary", async () => {
    const { env } = createWorkerEnv();

    const accepted = await worker.fetch(new Request("https://pillow.test/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "game_started",
        props: { kind: "rps", role: "host", text: "must be dropped" },
      }),
    }), env);
    const rejected = await worker.fetch(new Request("https://pillow.test/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "message_text",
        props: { text: "must not be collected" },
      }),
    }), env);

    expect(accepted.status).toBe(204);
    expect(rejected.status).toBe(400);
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
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves activity route with Discord-compatible frame headers", async () => {
    const { env, assetRequests } = createWorkerEnv();

    const res = await worker.fetch(new Request("https://pillow.test/activity?frame_id=frame-test"), env);

    expect(res.status).toBe(200);
    expect(assetRequests).toHaveLength(1);
    expect(new URL(assetRequests[0].url).pathname).toBe("/");
    expect(res.headers.get("content-security-policy")).toContain("https://*.discord.com");
    expect(res.headers.get("content-security-policy")).toContain("https://*.discordsays.com");
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("reports Fort Pass public beta readiness without secrets", async () => {
    const { env } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
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

    const available = await worker.fetch(new Request("https://pillow.test/api/fort-pass/code?code=Party-1"), env);
    const taken = await worker.fetch(new Request("https://pillow.test/api/fort-pass/code?code=taken-1"), env);
    const invalid = await worker.fetch(new Request("https://pillow.test/api/fort-pass/code?code=analytics"), env);

    expect(available.headers.get("cache-control")).toBe("no-store");
    expect(await available.json()).toEqual({ code: "party-1", available: true });
    expect(await taken.json()).toEqual({ code: "taken-1", available: false, reason: "taken" });
    expect(await invalid.json()).toEqual({ code: null, available: false, reason: "invalid" });
  });

  it("validates Fort Pass checkout requests without granting an entitlement", async () => {
    const { env, roomStatus } = createWorkerEnv();
    roomStatus.set("taken-1", true);

    const invalid = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "analytics" }),
    }), env);
    const taken = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "taken-1" }),
    }), env);
    const notConfigured = await worker.fetch(new Request("https://pillow.test/api/fort-pass/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "Party-1" }),
    }), env);

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_custom_room_code" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "custom_room_code_taken", code: "taken-1" });
    expect(notConfigured.status).toBe(501);
    expect(await notConfigured.json()).toEqual({ error: "checkout_not_configured", code: "party-1" });
  });

  it("creates a Stripe checkout session when provider config is present", async () => {
    const { env } = createWorkerEnv();
    let stripeBody: URLSearchParams | null = null;
    const configuredEnv = {
      ...env,
      STRIPE_SECRET_KEY: "sk_test_secret",
      FORT_PASS_PRICE_ID: "price_test",
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "Party-1" }),
    }), configuredEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: "party-1",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
      sessionId: "cs_test_123",
    });
    expect(stripeBody?.get("metadata[custom_room_code]")).toBe("party-1");
    expect(stripeBody?.get("success_url")).toBe("https://pillow.test/?fort_pass=success&code=party-1&session_id={CHECKOUT_SESSION_ID}");
  });

  it("fulfills Fort Pass entitlements from signed Stripe webhooks", async () => {
    const { env, fulfilledEntitlements } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    } as Env;
    const event = {
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          metadata: {
            kind: "fort-pass",
            custom_room_code: "Party-1",
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");

    const res = await worker.fetch(new Request("https://pillow.test/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    }), configuredEnv);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, fulfilled: true, code: "party-1" });
    expect(fulfilledEntitlements.get("party-1")?.providerRef).toBe("cs_test_123");
    expect(fulfilledEntitlements.get("party-1")?.perks.customRoomCode).toBe("party-1");
  });

  it("rejects unsigned Stripe webhooks", async () => {
    const { env } = createWorkerEnv();
    const configuredEnv = {
      ...env,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    } as Env;

    const res = await worker.fetch(new Request("https://pillow.test/api/stripe/webhook", {
      method: "POST",
      body: JSON.stringify({ type: "checkout.session.completed" }),
    }), configuredEnv);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_webhook_signature" });
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

  it("stores fulfilled Fort Pass entitlements before room setup", async () => {
    const state = new FakeDurableObjectState();
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    const res = await room.fetch(new Request("https://pillow.test/__pillowfort/fort-pass/fulfill", {
      method: "POST",
      body: JSON.stringify(entitlement("party-1")),
    }));
    const status = await room.fetch(new Request("https://pillow.test/__pillowfort/room-status"));

    expect(res.status).toBe(200);
    expect(await status.json()).toEqual({ exists: true });
    expect((state.storage.values.get("fortPassEntitlement") as FortPassEntitlement).providerRef).toBe("cs_test_123");
  });

  it("uses the Fort Pass idle timeout when a paid room is set up", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("fortPassEntitlement", entitlement("party-1"));
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth: { v: 1, kdf: "pbkdf2-sha256-600k-v1", verifier: "a".repeat(32) },
      fortPassSessionId: "cs_test_123",
    }));

    expect(JSON.parse(socket.sent[0]).type).toBe("room-created");
    expect(JSON.parse(socket.sent[0]).fortPass).toEqual({ themePack: "retro-plus" });
    expect(state.storage.alarm).toBeGreaterThan(Date.now() + FORT_PASS_EXTENDED_IDLE_MS - 5_000);
  });

  it("persists premium room themes for paid rooms", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("fortPassEntitlement", entitlement("party-1"));
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth: { v: 1, kdf: "pbkdf2-sha256-600k-v1", verifier: "a".repeat(32) },
      fortPassSessionId: "cs_test_123",
    }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-theme",
      theme: "retro-green",
    }));

    expect(JSON.parse(socket.sent[1])).toEqual({
      type: "room-theme",
      theme: "retro-green",
    });
    expect(state.storage.values.get("roomTheme")).toBe("retro-green");
  });

  it("rejects premium room themes for free rooms", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "free-1");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth: { v: 1, kdf: "pbkdf2-sha256-600k-v1", verifier: "a".repeat(32) },
    }));
    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-theme",
      theme: "retro-green",
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
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("fortPassEntitlement", entitlement("party-1"));
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth: { v: 1, kdf: "pbkdf2-sha256-600k-v1", verifier: "a".repeat(32) },
    }));

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "error",
      message: "paid room redemption required",
    });
    expect(state.storage.values.get("authVerifier")).toBeUndefined();
  });

  it("reports whether a room already exists from persisted auth state", async () => {
    const state = new FakeDurableObjectState();
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("authVerifier", "verifier");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    const res = await room.fetch(new Request("https://pillow.test/__pillowfort/room-status"));

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ exists: true });
  });

  it("rejects setup when persisted auth state already exists without a host socket", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
    state.sockets.push(socket);
    state.storage.values.set("roomId", "party-1");
    state.storage.values.set("authVerifier", "verifier");
    const room = new Room(state as unknown as DurableObjectState, {} as Env);
    await state.ready;

    await room.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({
      type: "set-up",
      name: "alice",
      auth: { v: 1, kdf: "pbkdf2-sha256-600k-v1", verifier: "a".repeat(32) },
    }));

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "error",
      message: "fort already exists",
    });
  });

  it("destroys the room when the idle alarm is due", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
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
    expect(state.storage.deletedAll).toBe(true);
  });

  it("prioritizes the saboteur bomb when multiple alarms are due", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
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
    expect(state.storage.deletedAll).toBe(true);
  });

  it("keeps a future alarm scheduled without destroying the room", async () => {
    const state = new FakeDurableObjectState();
    const socket = new FakeSocket();
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
