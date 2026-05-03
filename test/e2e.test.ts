import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { computeStripeWebhookSignature } from "../src/stripe";
import {
  startServer, stopServer, cleanupClients, getPort,
  connectClient, connectClientToRoom, createRoom, createRoomWithId, joinRoom, roomAuth,
} from "./helpers";

beforeAll(startServer);
afterEach(cleanupClients);
afterAll(stopServer);

// ---- Happy path: 3-user chat session ----

describe("Happy path: 3-user chat session", () => {
  it("create → join → chat → toss → catch → knock-down", async () => {
    // 1. User A creates fort
    const { host: alice, roomId } = await createRoom("alice", "fort123");
    expect(roomId).toMatch(/^[a-z0-9]{8}$/);

    // 2. User B joins
    const bob = await connectClientToRoom(roomId);
    bob.send({ type: "join", name: "bob", auth: await roomAuth(roomId, "fort123"), room: roomId });
    const bobJoined = await bob.waitFor("joined");
    expect(bobJoined.members).toContain("alice");
    expect(bobJoined.members).toContain("bob");

    // 3. User C joins
    const carol = await connectClientToRoom(roomId);
    carol.send({ type: "join", name: "carol", auth: await roomAuth(roomId, "fort123"), room: roomId });
    const carolJoined = await carol.waitFor("joined");
    expect(carolJoined.members).toContain("alice");
    expect(carolJoined.members).toContain("carol");

    // 4. Exchange messages — plain
    alice.send({ type: "chat", text: "hello everyone!" });
    await alice.waitFor("message"); // alice receives own broadcast
    const msg1 = await bob.waitFor("message");
    expect(msg1.from).toBe("alice");
    expect(msg1.text).toBe("hello everyone!");
    await carol.waitFor("message"); // carol also receives

    // 4b. Formatted message
    bob.send({ type: "chat", text: "bold blue", style: { bold: true, color: "#0000FF" } });
    const msg2 = await alice.waitFor("message");
    expect(msg2.from).toBe("bob");
    expect(msg2.style).toEqual({ bold: true, color: "#0000FF" });

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
  });

  it("GET /:customCode returns HTML for paid custom room links", async () => {
    const res = await fetch(`http://localhost:${getPort()}/party-1`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct).toContain("text/html");
  });
});

// ---- Beta analytics ----

describe("Beta analytics", () => {
  it("POST /analytics accepts sanitized funnel events", async () => {
    const res = await fetch(`http://localhost:${getPort()}/analytics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "game_started",
        props: { kind: "rps", role: "host", memberCount: 3 },
      }),
    });
    expect(res.status).toBe(204);
  });

  it("POST /analytics rejects unknown events", async () => {
    const res = await fetch(`http://localhost:${getPort()}/analytics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  it("reports invalid, available, and taken custom room codes", async () => {
    await createRoomWithId("taken-1", "host", "secret");

    const invalid = await fetch(`http://localhost:${getPort()}/api/fort-pass/code?code=analytics`);
    const available = await fetch(`http://localhost:${getPort()}/api/fort-pass/code?code=Party-1`);
    const taken = await fetch(`http://localhost:${getPort()}/api/fort-pass/code?code=taken-1`);

    expect(invalid.headers.get("cache-control")).toBe("no-store");
    expect(await invalid.json()).toEqual({ code: null, available: false, reason: "invalid" });
    expect(await available.json()).toEqual({ code: "party-1", available: true });
    expect(await taken.json()).toEqual({ code: "taken-1", available: false, reason: "taken" });
  });
});

describe("Fort Pass checkout boundary", () => {
  it("validates checkout requests but does not grant paid perks without provider config", async () => {
    await createRoomWithId("taken-2", "host", "secret");

    const invalid = await fetch(`http://localhost:${getPort()}/api/fort-pass/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "analytics" }),
    });
    const taken = await fetch(`http://localhost:${getPort()}/api/fort-pass/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "taken-2" }),
    });
    const notConfigured = await fetch(`http://localhost:${getPort()}/api/fort-pass/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customRoomCode: "Party-1", paid: true }),
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_custom_room_code" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "custom_room_code_taken", code: "taken-2" });
    expect(notConfigured.status).toBe(501);
    expect(await notConfigured.json()).toEqual({ error: "checkout_not_configured", code: "party-1" });
  });
});

describe("Fort Pass webhook fulfillment", () => {
  it("reserves a paid custom room code after a signed Stripe webhook", async () => {
    const event = {
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_paid_1",
          object: "checkout.session",
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
    const availability = await fetch(`http://localhost:${getPort()}/api/fort-pass/code?code=paid-1`);
    const blocked = await connectClientToRoom("paid-1");
    blocked.send({ type: "set-up", name: "intruder", auth: await roomAuth("paid-1", "secret") });
    const blockedError = await blocked.waitFor("error");
    const created = await createRoomWithId("paid-1", "host", "secret", "cs_test_paid_1");
    created.host.send({ type: "set-theme", theme: "retro-green" });
    const theme = await created.host.waitFor("room-theme");

    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ received: true, fulfilled: true, code: "paid-1" });
    expect(await availability.json()).toEqual({ code: "paid-1", available: false, reason: "taken" });
    expect(blockedError.message).toBe("paid room redemption required");
    expect(created.roomId).toBe("paid-1");
    expect(theme.theme).toBe("retro-green");
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
    await createRoomWithId("party-1", "alice", "secret");
    const second = await connectClientToRoom("party-1");
    second.send({
      type: "set-up",
      name: "mallory",
      auth: await roomAuth("party-1", "other-secret"),
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
    alice2.send({ type: "join", name: "alice", auth: await roomAuth(roomId, "secret"), room: roomId });
    const joined = await alice2.waitFor("joined");
    expect(joined.name).toBe("alice2");
  });
});

// ---- Room capacity ----

describe("Room capacity", () => {
  it("21st guest gets 'fort is full' error", async () => {
    const { roomId } = await createRoom("host");
    for (let i = 0; i < 20; i++) {
      await joinRoom(roomId, `guest${i}`);
    }
    const extra = await connectClientToRoom(roomId);
    extra.send({ type: "join", name: "extra", auth: await roomAuth(roomId, "secret"), room: roomId });
    const err = await extra.waitFor("error");
    expect(err.message).toContain("full");
  });
});
