import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { computeStripeWebhookSignature } from "../src/stripe";
import {
  startServer, stopServer, cleanupClients, getPort,
  connectClient, connectClientToRoom, createRoom, createRoomWithId, joinRoom, roomAuth, sendEncryptedChat,
} from "./helpers";

const TEST_FORT_PASS_CLAIM_HASH = "02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc";

beforeAll(startServer);
afterEach(cleanupClients);
afterAll(stopServer);

function localBrowserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin: `http://localhost:${getPort()}`,
    ...extra,
  };
}

// ---- Happy path: 3-user chat session ----

describe("Happy path: 3-user chat session", () => {
  it("create → join → chat → toss → catch → knock-down", async () => {
    // 1. User A creates fort
    const { host: alice, roomId } = await createRoom("alice", "fort123");
    expect(roomId).toMatch(/^f-[a-z2-7]{10}$/);

    // 2. User B joins
    const bob = await connectClientToRoom(roomId);
    bob.send({ type: "join", name: "bob", auth: await roomAuth(bob, roomId, "fort123", "join", "bob"), room: roomId });
    const bobJoined = await bob.waitFor("joined");
    expect(bobJoined.members).toContain("alice");
    expect(bobJoined.members).toContain("bob");

    // 3. User C joins
    const carol = await connectClientToRoom(roomId);
    carol.send({ type: "join", name: "carol", auth: await roomAuth(carol, roomId, "fort123", "join", "carol"), room: roomId });
    const carolJoined = await carol.waitFor("joined");
    expect(carolJoined.members).toContain("alice");
    expect(carolJoined.members).toContain("carol");

    // 4. Exchange encrypted messages
    await sendEncryptedChat(alice, roomId, "fort123", "alice", "hello everyone!");
    await alice.waitFor("message"); // alice receives own broadcast
    const msg1 = await bob.waitFor("message");
    expect(msg1.from).toBe("alice");
    expect(msg1.enc?.v).toBe(3);
    await carol.waitFor("message"); // carol also receives

    // 4b. Formatted message
    await sendEncryptedChat(bob, roomId, "fort123", "bob", "bold blue", { bold: true, color: "#0000FF" });
    const msg2 = await alice.waitFor("message");
    expect(msg2.from).toBe("bob");
    expect(msg2.enc?.v).toBe(3);
    expect(msg2.style).toBeUndefined();

    // 5. Alice tosses pillow to Bob
    alice.send({ type: "toss-pillow", target: "bob" });
    const offer = await bob.waitFor("host-offer");
    expect(offer.oldHost).toBe("alice");

    // 6. Bob catches → becomes host
    bob.send({ type: "accept-host" });
    const nh = await alice.waitFor("new-host");
    expect(nh.name).toBe("bob");

    // 7. Bob knocks down → all get knocked-down
    bob.send({ type: "knock-down" });
    const kdAlice = await alice.waitFor("knocked-down");
    const kdCarol = await carol.waitFor("knocked-down");
    expect(kdAlice.reason).toContain("host knocked it down");
    expect(kdCarol.reason).toContain("host knocked it down");
  });
});

// ---- Invite link flow ----

describe("Invite link flow", () => {
  it("GET /:roomId returns HTML", async () => {
    const res = await fetch(`http://localhost:${getPort()}/abc12345`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("text/html");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET /:customCode returns HTML for paid custom room links", async () => {
    const res = await fetch(`http://localhost:${getPort()}/party-1`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("text/html");
  });

  it("GET /activity returns HTML with Discord frame headers", async () => {
    const res = await fetch(`http://localhost:${getPort()}/activity?frame_id=test-frame`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://discord.com https://canary.discord.com https://ptb.discord.com",
    );
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("blocks scanner paths in the local runtime", async () => {
    const blocked = await fetch(`http://localhost:${getPort()}/.%65%6Ev.%70%72%6F%64`);
    const php = await fetch(`http://localhost:${getPort()}/wp-content/sallu.php`);

    expect(blocked.status).toBe(404);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect(blocked.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await blocked.text()).toBe("");
    expect(php.status).toBe(404);
  });
});

// ---- Beta analytics ----

describe("Beta analytics", () => {
  it("POST /analytics accepts only non-room product events", async () => {
    const res = await fetch(`http://localhost:${getPort()}/analytics`, {
      method: "POST",
      headers: localBrowserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        event: "fort_pass_status_checked",
        props: { source: "setup" },
      }),
    });
    expect(res.status).toBe(204);

    const protectedMetadata = await fetch(`http://localhost:${getPort()}/analytics`, {
      method: "POST",
      headers: localBrowserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ event: "game_started", props: { kind: "rps" } }),
    });
    expect(protectedMetadata.status).toBe(400);
  });

  it("POST /analytics rejects unknown events", async () => {
    const res = await fetch(`http://localhost:${getPort()}/analytics`, {
      method: "POST",
      headers: localBrowserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        event: "message_text",
        props: { text: "do not collect me" },
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ---- Fort Pass checkout boundary ----

describe("Fort Pass custom-code availability", () => {
  it("reports public Fort Pass beta readiness", async () => {
    const res = await fetch(`http://localhost:${getPort()}/api/fort-pass/status`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      beta: true,
      checkoutConfigured: false,
      priceLabel: "$5",
      perks: ["custom_code", "extended_idle", "theme_pack"],
    });
  });

  it("reports invalid and available custom room codes", async () => {
    const invalid = await fetch(`http://localhost:${getPort()}/api/fort-pass/code?code=analytics`);
    const available = await fetch(`http://localhost:${getPort()}/api/fort-pass/code?code=Party-1`);

    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(await invalid.json()).toEqual({ code: null, available: false, reason: "invalid" });
    expect(await available.json()).toEqual({ code: "party-1", available: true });
  });
});

describe("Fort Pass checkout boundary", () => {
  it("validates checkout requests but does not grant paid perks without provider config", async () => {
    const invalid = await fetch(`http://localhost:${getPort()}/api/fort-pass/checkout`, {
      method: "POST",
      headers: localBrowserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "analytics", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    });
    const notConfigured = await fetch(`http://localhost:${getPort()}/api/fort-pass/checkout`, {
      method: "POST",
      headers: localBrowserHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_custom_room_code" });
    expect(notConfigured.status).toBe(501);
    expect(await notConfigured.json()).toEqual({ error: "checkout_not_configured", code: "party-1" });
  });
});

describe("Fort Pass webhook fulfillment", () => {
  it("rejects signed fulfillment when authoritative Stripe configuration is incomplete", async () => {
    const event = {
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_paid_1",
          object: "checkout.session",
          created: Math.floor(Date.now() / 1_000),
          mode: "payment",
          payment_status: "paid",
          metadata: {
            kind: "fort-pass",
            custom_room_code: "paid-1",
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");

    const webhook = await fetch(`http://localhost:${getPort()}/api/stripe/webhook`, {
      method: "POST",
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      body: payload,
    });
    expect(webhook.status).toBe(501);
    expect(await webhook.json()).toEqual({ error: "webhook_not_configured" });
  });

  it("rejects unsigned Stripe webhooks", async () => {
    const res = await fetch(`http://localhost:${getPort()}/api/stripe/webhook`, {
      method: "POST",
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_webhook_signature" });
  });
});

describe("Room creation collision", () => {
  it("does not overwrite an existing room with the same custom code", async () => {
    const roomId = "f-aaaaaaaaaa";
    await createRoomWithId(roomId, "alice", "secret");
    const second = await connectClientToRoom(roomId);
    second.send({
      type: "set-up",
      name: "mallory",
      auth: await roomAuth(second, roomId, "other-secret", "set-up", "mallory"),
    });

    const err = await second.waitFor("error");
    expect(err.message).toContain("already exists");
  });
});

// ---- Name collision ----

describe("Name collision", () => {
  it("second 'alice' gets renamed to 'alice2'", async () => {
    const { roomId } = await createRoom("alice");
    const alice2 = await connectClientToRoom(roomId);
    alice2.send({ type: "join", name: "alice", auth: await roomAuth(alice2, roomId, "secret", "join", "alice"), room: roomId });
    const joined = await alice2.waitFor("joined");
    expect(joined.name).toBe("alice2");
  });
});

// ---- Room capacity ----

describe("Room capacity", () => {
  it("21st guest is rejected without becoming authorized for room commands", async () => {
    const { roomId } = await createRoom("host");
    for (let i = 0; i < 20; i++) {
      await joinRoom(roomId, `guest${i}`);
    }
    const extra = await connectClientToRoom(roomId);
    extra.send({ type: "join", name: "extra", auth: await roomAuth(extra, roomId, "secret", "join", "extra"), room: roomId });
    const err = await extra.waitFor("error");
    expect(err.message).toContain("full");

    const closed = new Promise<number>((resolve) => {
      extra.ws.addEventListener("close", (event) => resolve(event.code), { once: true });
    });
    extra.send({ type: "typing" });
    expect(await closed).toBe(1008);
  });
});
