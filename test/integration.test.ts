import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  startServer, stopServer, cleanupClients,
  connectClient, createRoom, joinRoom,
  TEST_GRACE_MS,
} from "./helpers";

beforeAll(startServer);
afterEach(cleanupClients);
afterAll(stopServer);

// ---- Room lifecycle ----

describe("Room lifecycle", () => {
  it("create room → room-created with 6-char ID", async () => {
    const { roomId } = await createRoom();
    expect(roomId).toMatch(/^[a-z0-9]{6}$/);
  });

  it("join room → joined with members list", async () => {
    const { roomId } = await createRoom("alice");
    const guest = await connectClient();
    guest.send({ type: "join", name: "bob", password: "secret", room: roomId });
    const joined = await guest.waitFor("joined");
    expect(joined.members).toContain("alice");
    expect(joined.members).toContain("bob");
  });

  it("join with wrong password → error", async () => {
    const { roomId } = await createRoom();
    const guest = await connectClient();
    guest.send({ type: "join", name: "bob", password: "wrong", room: roomId });
    const err = await guest.waitFor("error");
    expect(err.message).toContain("wrong password");
  });

  it("join nonexistent room → error", async () => {
    const guest = await connectClient();
    guest.send({ type: "join", name: "bob", password: "secret", room: "zzzzzz" });
    const err = await guest.waitFor("error");
    expect(err.message).toContain("fort not found");
  });

  it("chat → all members receive message", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "chat", text: "hello fort" });
    const hostMsg = await host.waitFor("message");
    const guestMsg = await bob.waitFor("message");
    expect(hostMsg.from).toBe("alice");
    expect(hostMsg.text).toBe("hello fort");
    expect(guestMsg.from).toBe("alice");
    expect(guestMsg.text).toBe("hello fort");
  });
});

// ---- Style passthrough ----

describe("Style passthrough", () => {
  it("valid style → broadcast includes validated style", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "chat", text: "styled", style: { bold: true, color: "#FF0000" } });
    const msg = await bob.waitFor("message");
    expect(msg.style).toEqual({ bold: true, color: "#FF0000" });
  });

  it("invalid style → broadcast has no style", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "chat", text: "bad", style: { color: "#BADCOLOR" } });
    const msg = await bob.waitFor("message");
    expect(msg.style).toBeUndefined();
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

    const bob2 = await connectClient();
    bob2.send({ type: "rejoin", name: "bob", password: "secret", room: roomId });
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

    const bob2 = await connectClient();
    bob2.send({ type: "rejoin", name: "bob", password: "secret", room: roomId });
    const result = await bob2.waitFor("joined");
    expect(result.name).toBe("bob");
  });

  it("host reconnects while still host → restored as host", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    await host.close();
    await bob.waitFor("member-away");

    const alice2 = await connectClient();
    alice2.send({ type: "rejoin", name: "alice", password: "secret", room: roomId });
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
    const alice2 = await connectClient();
    alice2.send({ type: "rejoin", name: "alice", password: "secret", room: roomId });
    const result = await alice2.waitFor("joined");
    expect(result.name).toBe("alice");
  });
});

// ---- Rate limiting ----

describe("Rate limiting", () => {
  it("11th message in <5s gets 'slow down' error", async () => {
    const { host } = await createRoom("alice");
    for (let i = 0; i < 10; i++) {
      host.send({ type: "chat", text: `msg${i}` });
    }
    await Bun.sleep(100);
    host.send({ type: "chat", text: "msg10" });
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
  });

  it("send knock-down as host → knocked-down broadcast", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    host.send({ type: "knock-down" });
    const kd = await bob.waitFor("knocked-down");
    expect(kd.reason).toContain("host knocked it down");
  });
});
