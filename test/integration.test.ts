import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  startServer, stopServer, cleanupClients,
  connectClient, connectClientToRoom, createRoom, joinRoom, roomAuth, sendEncryptedChat,
  TEST_GRACE_MS,
} from "./helpers";
import { generateRoomId } from "../client/src/services/roomSecret";

beforeAll(startServer);
afterEach(cleanupClients);
afterAll(stopServer);

// ---- Room lifecycle ----

describe("Room lifecycle", () => {
  it("create room → room-created with a high-entropy ID", async () => {
    const { roomId } = await createRoom();
    expect(roomId).toMatch(/^f-[a-z2-7]{10}$/);
  });

  it("join room → joined with members list", async () => {
    const { roomId } = await createRoom("alice");
    const guest = await connectClientToRoom(roomId);
    guest.send({ type: "join", name: "bob", auth: await roomAuth(guest, roomId, "secret", "join", "bob"), room: roomId });
    const joined = await guest.waitFor("joined");
    expect(joined.members).toContain("alice");
    expect(joined.members).toContain("bob");
  });

  it("join with wrong password → error", async () => {
    const { roomId } = await createRoom();
    const guest = await connectClientToRoom(roomId);
    guest.send({ type: "join", name: "bob", auth: await roomAuth(guest, roomId, "wrong", "join", "bob"), room: roomId });
    const err = await guest.waitFor("error");
    expect(err.message).toContain("wrong password");
  });

  it("join nonexistent room → error", async () => {
    const guest = await connectClientToRoom("zzzzzz");
    guest.send({ type: "join", name: "bob", auth: await roomAuth(guest, "zzzzzz", "secret", "join", "bob"), room: "zzzzzz" });
    const err = await guest.waitFor("error");
    expect(err.message).toContain("fort not found");
  });

  it("chat → all members receive message", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await sendEncryptedChat(host, roomId, "secret", "alice", "hello fort");
    const hostMsg = await host.waitFor("message");
    const guestMsg = await bob.waitFor("message");
    expect(hostMsg.from).toBe("alice");
    expect(hostMsg.enc?.v).toBe(3);
    expect(guestMsg.from).toBe("alice");
    expect(guestMsg.enc).toEqual(hostMsg.enc);
  });

  it("encrypted chat payload relays without plaintext", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const enc = { v: 3, kdf: "pbkdf2-sha256-600k-v1", sid: "abcdefghijklmnop", seq: 1, iv: "QUJDREVGR0hJSktM", ct: "c2VjcmV0LWNpcGhlcnRleHQ=" };
    host.send({ type: "chat", enc });
    const msg = await bob.waitFor("message");
    expect(msg.from).toBe("alice");
    expect(msg.enc).toEqual(enc);
    expect(msg.text).toBeUndefined();
  });
});

describe("Protocol v2 hardening", () => {
  it("serializes concurrent setup attempts for the same room ID", async () => {
    const roomId = generateRoomId();
    const first = await connectClientToRoom(roomId);
    const second = await connectClientToRoom(roomId);
    const [firstAuth, secondAuth] = await Promise.all([
      roomAuth(first, roomId, "first-secret", "set-up", "alice"),
      roomAuth(second, roomId, "second-secret", "set-up", "mallory"),
    ]);

    first.send({ type: "set-up", name: "alice", auth: firstAuth });
    second.send({ type: "set-up", name: "mallory", auth: secondAuth });

    await Bun.sleep(250);
    const terminal = [...first.messages, ...second.messages]
      .filter((message) => message.type === "room-created" || message.type === "error");
    expect(terminal.filter((message) => message.type === "room-created")).toHaveLength(1);
    expect(terminal.filter((message) => message.type === "error")).toHaveLength(1);
    expect(terminal.find((message) => message.type === "error")?.message).toContain("already exists");
  });

  it("rejects a captured proof on a different one-use challenge", async () => {
    const { roomId } = await createRoom("alice");
    const first = await connectClientToRoom(roomId);
    const captured = await roomAuth(first, roomId, "secret", "join", "bob");
    first.send({ type: "join", name: "bob", auth: captured, room: roomId });
    await first.waitFor("joined");

    const replay = await connectClientToRoom(roomId);
    replay.send({ type: "join", name: "mallory", auth: captured, room: roomId });
    const error = await replay.waitFor("error");
    expect(error.message).toContain("wrong password");
  });

  it("consumes the challenge after a tampered proof", async () => {
    const { roomId } = await createRoom("alice");
    const client = await connectClientToRoom(roomId);
    const valid = await roomAuth(client, roomId, "secret", "join", "bob");
    const tampered = { ...valid, proof: `${valid.proof[0] === "A" ? "B" : "A"}${valid.proof.slice(1)}` };
    client.send({ type: "join", name: "bob", auth: tampered, room: roomId });
    expect((await client.waitFor("error")).message).toContain("wrong password");
    client.send({ type: "join", name: "bob", auth: valid, room: roomId });
    expect((await client.waitFor("error")).message).toContain("already attempted");
  });

  it("consumes the one authentication attempt for a malformed auth frame", async () => {
    const { roomId } = await createRoom("alice");
    const client = await connectClientToRoom(roomId);
    client.send({ type: "join", name: "bob", room: roomId, auth: null });
    expect((await client.waitFor("error")).message).toContain("wrong password");
    client.send({
      type: "join",
      name: "bob",
      room: roomId,
      auth: await roomAuth(client, roomId, "secret", "join", "bob"),
    });
    expect((await client.waitFor("error")).message).toContain("already attempted");
  });

  it("throttles the sixth failed authentication for a room and client IP", async () => {
    const { roomId } = await createRoom("alice");
    for (let attempt = 0; attempt < 5; attempt++) {
      const client = await connectClientToRoom(roomId);
      client.send({
        type: "join",
        name: `wrong-${attempt}`,
        auth: await roomAuth(client, roomId, `wrong-${attempt}`, "join", `wrong-${attempt}`),
        room: roomId,
      });
      expect((await client.waitFor("error")).message).toContain("wrong password");
    }
    const blocked = await connectClientToRoom(roomId);
    blocked.send({
      type: "join",
      name: "bob",
      auth: await roomAuth(blocked, roomId, "secret", "join", "bob"),
      room: roomId,
    });
    expect((await blocked.waitFor("error")).message).toContain("too many failed attempts");
  });

  it("rejects legacy encrypted-chat envelopes", async () => {
    const { host } = await createRoom("alice");
    host.send({ type: "chat", enc: { v: 2, iv: "QUJDREVGR0hJSktM", ct: "c2VjcmV0LWNpcGhlcnRleHQ=" } });
    expect((await host.waitFor("error")).message).toContain("encrypted chat v3 required");
  });

  it("closes with policy violation for commands before authentication", async () => {
    const roomId = `p${Math.random().toString(36).slice(2, 9)}`;
    const client = await connectClientToRoom(roomId);
    const closed = new Promise<number>((resolve) => client.ws.addEventListener("close", (event) => resolve(event.code)));
    client.send({ type: "typing" });
    expect(await closed).toBe(1008);
  });

  it("closes oversized and binary WebSocket frames before parsing", async () => {
    const oversized = await connectClient();
    const oversizedClosed = new Promise<number>((resolve) => oversized.ws.addEventListener("close", (event) => resolve(event.code)));
    oversized.ws.send("x".repeat(8 * 1024 + 1));
    expect(await oversizedClosed).not.toBe(1000);

    const binary = await connectClient();
    const binaryClosed = new Promise<number>((resolve) => binary.ws.addEventListener("close", (event) => resolve(event.code)));
    binary.ws.send(new Uint8Array([1, 2, 3]));
    expect(await binaryClosed).toBe(1003);
  });

  it("bounds malformed pre-auth JSON frames", async () => {
    const client = await connectClient();
    const closed = new Promise<number>((resolve) => client.ws.addEventListener("close", (event) => resolve(event.code)));
    for (let index = 0; index < 4; index++) client.ws.send("{");
    expect(await closed).toBe(1008);
  });
});

// ---- Room-scoped presence ----

describe("Presence (room-scoped)", () => {
  it("set-status broadcasts to members in same room", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "set-status", status: "away", awayText: "coffee break" });

    const toHost = await host.waitFor("member-status");
    const toBob = await bob.waitFor("member-status");
    expect(toHost.name).toBe("alice");
    expect(toHost.status).toBe("away");
    expect(toHost.awayText).toBe("coffee break");
    expect(toBob.name).toBe("alice");
    expect(toBob.status).toBe("away");
    expect(toBob.awayText).toBe("coffee break");
  });

  it("presence does not leak across rooms", async () => {
    const roomA = await createRoom("alice");
    const roomB = await createRoom("zoe");
    const bob = await joinRoom(roomA.roomId, "bob");
    const yan = await joinRoom(roomB.roomId, "yan");

    roomA.host.send({ type: "set-status", status: "away", awayText: "brb" });
    const sameRoom = await bob.waitFor("member-status");
    expect(sameRoom.name).toBe("alice");
    expect(sameRoom.status).toBe("away");

    // Keep room B active, then assert no cross-room status messages appeared.
    await sendEncryptedChat(roomB.host, roomB.roomId, "secret", "zoe", "ping");
    await yan.waitFor("message");
    const leaks = yan.messages.filter((m) => m.type === "member-status");
    expect(leaks.length).toBe(0);
  });
});

// ---- Style passthrough ----

describe("Encrypted style", () => {
  it("style is carried only inside authenticated ciphertext", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await sendEncryptedChat(host, roomId, "secret", "alice", "styled", { bold: true, color: "#FF0000" });
    const msg = await bob.waitFor("message");
    expect(msg.enc.v).toBe(3);
    expect(msg.style).toBeUndefined();
  });

  it("legacy plaintext and outer style are rejected", async () => {
    const { host } = await createRoom("alice");
    host.send({ type: "chat", text: "bad", style: { color: "#BADCOLOR" } });
    const error = await host.waitFor("error");
    expect(error.message).toContain("encrypted chat v3 required");
  });
});

// ---- Host migration ----

describe("Host migration", () => {
  it("host disconnects → guest gets member-away, then host-offer after grace", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await host.close();
    const away = await bob.waitFor("member-away");
    expect(away.name).toBe("alice");
    const offer = await bob.waitFor("host-offer", TEST_GRACE_MS + 1000);
    expect(offer.oldHost).toBe("alice");
  });

  it("guest accepts → new-host broadcast", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await host.close();
    await bob.waitFor("host-offer", TEST_GRACE_MS + 1000);
    bob.send({ type: "accept-host" });
    const nh = await bob.waitFor("new-host");
    expect(nh.name).toBe("bob");
  });

  it("guest ducks → next guest gets host-offer", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");
    await host.close();

    // Wait for grace period to expire
    await Bun.sleep(TEST_GRACE_MS + 200);

    // Determine who got the first offer
    const bobGotOffer = bob.messages.some(m => m.type === "host-offer");
    const firstPick = bobGotOffer ? bob : carol;
    const secondPick = bobGotOffer ? carol : bob;

    firstPick.send({ type: "reject-host" });
    const offer = await secondPick.waitFor("host-offer", 1000);
    expect(offer.oldHost).toBeDefined();
  });

  it("all duck → knocked-down", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await host.close();
    await bob.waitFor("host-offer", TEST_GRACE_MS + 1000);
    bob.send({ type: "reject-host" });
    const kd = await bob.waitFor("knocked-down", 1000);
    expect(kd.reason).toContain("nobody caught the pillow");
  });
});

// ---- Toss pillow ----

describe("Toss pillow", () => {
  it("host tosses → target receives host-offer", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "toss-pillow", target: "bob" });
    const offer = await bob.waitFor("host-offer");
    expect(offer.oldHost).toBe("alice");
  });

  it("target catches → new-host broadcast", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "toss-pillow", target: "bob" });
    await bob.waitFor("host-offer");
    bob.send({ type: "accept-host" });
    const nh = await host.waitFor("new-host");
    expect(nh.name).toBe("bob");
  });

  it("target ducks → original host restored", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "toss-pillow", target: "bob" });
    await bob.waitFor("host-offer");
    bob.send({ type: "reject-host" });
    const restored = await host.waitFor("new-host");
    expect(restored.name).toBe("alice");
  });
});

// ---- Grace period / reconnect ----

describe("Grace period / reconnect", () => {
  it("client disconnects → others get member-away", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await bob.close();
    const away = await host.waitFor("member-away");
    expect(away.name).toBe("bob");
  });

  it("rejoin within grace → restored, others get member-back", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await bob.close();
    await host.waitFor("member-away");

    const bob2 = await connectClientToRoom(roomId);
    bob2.send({ type: "rejoin", name: "bob", auth: await roomAuth(bob2, roomId, "secret", "rejoin", "bob"), room: roomId });
    const rejoined = await bob2.waitFor("rejoined");
    expect(rejoined.name).toBe("bob");
    const back = await host.waitFor("member-back");
    expect(back.name).toBe("bob");
  });

  it("rejoin after grace → falls through to normal join", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await bob.close();
    await host.waitFor("member-away");

    await Bun.sleep(TEST_GRACE_MS + 100);

    const bob2 = await connectClientToRoom(roomId);
    bob2.send({ type: "rejoin", name: "bob", auth: await roomAuth(bob2, roomId, "secret", "rejoin", "bob"), room: roomId });
    const result = await bob2.waitFor("joined");
    expect(result.name).toBe("bob");
  });

  it("host reconnects while still host → restored as host", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await host.close();
    await bob.waitFor("member-away");

    const alice2 = await connectClientToRoom(roomId);
    alice2.send({ type: "rejoin", name: "alice", auth: await roomAuth(alice2, roomId, "secret", "rejoin", "alice"), room: roomId });
    const rejoined = await alice2.waitFor("rejoined");
    expect(rejoined.isHost).toBe(true);
  });

  it("host reconnects after someone else became host → rejoins as guest", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await host.close();

    // Wait for bob to get host offer and accept
    const offer = await bob.waitFor("host-offer", TEST_GRACE_MS + 1000);
    bob.send({ type: "accept-host" });
    await bob.waitFor("new-host");

    // Now alice tries to rejoin — grace expired, someone else is host
    const alice2 = await connectClientToRoom(roomId);
    alice2.send({ type: "rejoin", name: "alice", auth: await roomAuth(alice2, roomId, "secret", "rejoin", "alice"), room: roomId });
    const result = await alice2.waitFor("joined");
    expect(result.name).toBe("alice");
  });
});

// ---- Rate limiting ----

describe("Rate limiting", () => {
  it("11th message in <5s gets 'slow down' error", async () => {
    const { host } = await createRoom("alice");
    for (let i = 0; i < 10; i++) {
      host.send({ type: "chat", enc: { v: 3, kdf: "pbkdf2-sha256-600k-v1", sid: "abcdefghijklmnop", seq: i + 1, iv: "QUJDREVGR0hJSktM", ct: "c2VjcmV0LWNpcGhlcnRleHQ=" } });
    }
    await Bun.sleep(100);
    host.send({ type: "chat", enc: { v: 3, kdf: "pbkdf2-sha256-600k-v1", sid: "abcdefghijklmnop", seq: 11, iv: "QUJDREVGR0hJSktM", ct: "c2VjcmV0LWNpcGhlcnRleHQ=" } });
    const err = await host.waitFor("error");
    expect(err.message).toContain("slow down");
  });
});

// ---- Intentional leave ----

describe("Intentional leave", () => {
  it("send leave → immediate member-left", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    bob.send({ type: "leave" });
    const left = await host.waitFor("member-left");
    expect(left.name).toBe("bob");
    for (let i = 0; i < 20 && bob.ws.readyState !== WebSocket.CLOSED; i++) await Bun.sleep(10);
    expect(bob.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("send knock-down as host → knocked-down broadcast", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "knock-down" });
    const kd = await bob.waitFor("knocked-down");
    expect(kd.reason).toContain("host knocked it down");
  });
});
