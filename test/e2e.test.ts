import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  startServer, stopServer, cleanupClients, getPort,
  connectClient, createRoom, joinRoom,
} from "./helpers";

beforeAll(startServer);
afterEach(cleanupClients);
afterAll(stopServer);

// ---- Happy path: 3-user chat session ----

describe("Happy path: 3-user chat session", () => {
  it("create → join → chat → toss → catch → knock-down", async () => {
    // 1. User A creates fort
    const alice = await connectClient();
    alice.send({ type: "set-up", name: "alice", password: "fort123" });
    const created = await alice.waitFor("room-created");
    const roomId = created.room;
    expect(roomId).toMatch(/^[a-z0-9]{8}$/);

    // 2. User B joins
    const bob = await connectClient();
    bob.send({ type: "join", name: "bob", password: "fort123", room: roomId });
    const bobJoined = await bob.waitFor("joined");
    expect(bobJoined.members).toContain("alice");
    expect(bobJoined.members).toContain("bob");

    // 3. User C joins
    const carol = await connectClient();
    carol.send({ type: "join", name: "carol", password: "fort123", room: roomId });
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
});

// ---- Name collision ----

describe("Name collision", () => {
  it("second 'alice' gets renamed to 'alice2'", async () => {
    const { roomId } = await createRoom("alice");
    const alice2 = await connectClient();
    alice2.send({ type: "join", name: "alice", password: "secret", room: roomId });
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
    const extra = await connectClient();
    extra.send({ type: "join", name: "extra", password: "secret", room: roomId });
    const err = await extra.waitFor("error");
    expect(err.message).toContain("full");
  });
});
