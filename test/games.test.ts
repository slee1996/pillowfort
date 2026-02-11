import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  startServer, stopServer, cleanupClients,
  createRoom, joinRoom,
} from "./helpers";

beforeAll(startServer);
afterEach(cleanupClients);
afterAll(stopServer);

// ---- Rock Paper Scissors ----

describe("Rock Paper Scissors", () => {
  it("challenge → accept → pick → winner declared", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "rps-challenge", target: "bob" });
    await bob.waitFor("rps-challenged");
    bob.send({ type: "rps-accept" });
    await host.waitFor("rps-started");

    host.send({ type: "rps-pick", pick: "rock" });
    bob.send({ type: "rps-pick", pick: "scissors" });

    const result = await host.waitFor("rps-result");
    expect(result.winner).toBe("alice");
    expect(result.pick1).toBe("rock");
    expect(result.pick2).toBe("scissors");
  });

  it("both pick same → draw", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "rps-challenge", target: "bob" });
    await bob.waitFor("rps-challenged");
    bob.send({ type: "rps-accept" });
    await host.waitFor("rps-started");

    host.send({ type: "rps-pick", pick: "rock" });
    bob.send({ type: "rps-pick", pick: "rock" });

    const result = await host.waitFor("rps-result");
    expect(result.winner).toBeNull();
  });

  it("challenge → decline → rps-declined", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "rps-challenge", target: "bob" });
    await bob.waitFor("rps-challenged");
    bob.send({ type: "rps-decline" });

    const declined = await host.waitFor("rps-declined");
    expect(declined.from).toBe("bob");
  });

  it("challenge during active game → error", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "rps-challenge", target: "bob" });
    await bob.waitFor("rps-challenged");
    bob.send({ type: "rps-accept" });
    await host.waitFor("rps-started");

    // Try to start another challenge while game in progress
    bob.send({ type: "rps-challenge", target: "alice" });
    const err = await bob.waitFor("error");
    expect(err.message).toContain("duel is already in progress");
  });
});

// ---- Tic-Tac-Toe ----

describe("Tic-Tac-Toe", () => {
  it("challenge → accept → play to X win (top row)", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "ttt-challenge", target: "bob" });
    await bob.waitFor("ttt-challenged");
    bob.send({ type: "ttt-accept" });
    await host.waitFor("ttt-started");

    // alice = X (p1, even turns), bob = O (p2, odd turns)
    // X wins top row: cells 0, 1, 2
    // broadcast sends to both players so consume both
    host.send({ type: "ttt-move", cell: 0 }); // X at 0
    await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);

    bob.send({ type: "ttt-move", cell: 3 }); // O at 3
    await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);

    host.send({ type: "ttt-move", cell: 1 }); // X at 1
    await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);

    bob.send({ type: "ttt-move", cell: 4 }); // O at 4
    await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);

    host.send({ type: "ttt-move", cell: 2 }); // X at 2 → win!
    const [, finalUpdate] = await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);
    expect(finalUpdate.winner).toBe("alice");
  });

  it("play to draw (full board, no winner)", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "ttt-challenge", target: "bob" });
    await bob.waitFor("ttt-challenged");
    bob.send({ type: "ttt-accept" });
    await host.waitFor("ttt-started");

    // Draw board:
    // X O X
    // X X O
    // O X O
    const moves = [
      { player: host, cell: 0 }, // X
      { player: bob,  cell: 1 }, // O
      { player: host, cell: 2 }, // X
      { player: bob,  cell: 5 }, // O
      { player: host, cell: 3 }, // X
      { player: bob,  cell: 6 }, // O
      { player: host, cell: 4 }, // X
      { player: bob,  cell: 8 }, // O
      { player: host, cell: 7 }, // X → draw
    ];

    for (let i = 0; i < moves.length - 1; i++) {
      moves[i].player.send({ type: "ttt-move", cell: moves[i].cell });
      // broadcast sends to both players, consume both
      await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);
    }

    // Last move triggers draw
    const last = moves[moves.length - 1];
    last.player.send({ type: "ttt-move", cell: last.cell });
    const [, finalUpdate] = await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);
    expect(finalUpdate.winner).toBeNull();
    expect(finalUpdate.draw).toBe(true);
  });

  it("challenge → decline → ttt-declined", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "ttt-challenge", target: "bob" });
    await bob.waitFor("ttt-challenged");
    bob.send({ type: "ttt-decline" });

    const declined = await host.waitFor("ttt-declined");
    expect(declined.from).toBe("bob");
  });

  it("wrong player's turn → move ignored", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "ttt-challenge", target: "bob" });
    await bob.waitFor("ttt-challenged");
    bob.send({ type: "ttt-accept" });
    await host.waitFor("ttt-started");

    // It's alice's turn (p1, turn 0) — bob tries to move (should be ignored)
    bob.send({ type: "ttt-move", cell: 0 });

    // Alice moves — should succeed since bob's was ignored
    host.send({ type: "ttt-move", cell: 0 });
    const [, update] = await Promise.all([host.waitFor("ttt-update"), bob.waitFor("ttt-update")]);
    expect(update.board[0]).toBe("X");
    expect(update.turn).toBe(1);
  });
});

// ---- Pillow Fight (Vote to Eject) ----

describe("Pillow Fight (Vote)", () => {
  it("start vote → yes majority → target ejected", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");

    host.send({ type: "start-vote", target: "bob" });
    await bob.waitFor("vote-started");

    // alice auto-votes yes (as starter), carol votes yes
    carol.send({ type: "cast-vote", vote: "yes" });

    // both non-target voters voted → resolves
    const result = await host.waitFor("vote-result");
    expect(result.target).toBe("bob");
    expect(result.ejected).toBe(true);
    expect(result.yes).toBe(2);
  });

  it("start vote → no majority → target stays", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");

    host.send({ type: "start-vote", target: "bob" });
    await carol.waitFor("vote-started");

    carol.send({ type: "cast-vote", vote: "no" });

    const result = await host.waitFor("vote-result");
    expect(result.target).toBe("bob");
    expect(result.ejected).toBe(false);
  });

  it("need 3+ people → error with only 2", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    host.send({ type: "start-vote", target: "bob" });
    const err = await host.waitFor("error");
    expect(err.message).toContain("need at least 3 people");
  });
});

// ---- Secret Saboteur ----

describe("Secret Saboteur", () => {
  it("start → roles assigned (1 saboteur, rest defenders)", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");
    const dave = await joinRoom(roomId, "dave");

    host.send({ type: "sab-start" });

    // All get sab-started
    await host.waitFor("sab-started");

    // Each player gets a role
    const players = [host, bob, carol, dave];
    const roles: { client: typeof host; role: string }[] = [];
    for (const p of players) {
      const roleMsg = await p.waitFor("sab-role");
      roles.push({ client: p, role: roleMsg.role });
    }

    const saboteurs = roles.filter(r => r.role === "saboteur");
    const defenders = roles.filter(r => r.role === "defender");
    expect(saboteurs.length).toBe(1);
    expect(defenders.length).toBe(3);
  });

  it("3 strikes → fort knocked down", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");
    const dave = await joinRoom(roomId, "dave");

    host.send({ type: "sab-start" });
    await host.waitFor("sab-started");

    const players = [host, bob, carol, dave];
    const roles: { client: typeof host; role: string }[] = [];
    for (const p of players) {
      const roleMsg = await p.waitFor("sab-role");
      roles.push({ client: p, role: roleMsg.role });
    }

    const saboteur = roles.find(r => r.role === "saboteur")!;

    // Strike 1
    saboteur.client.send({ type: "sab-strike" });
    const s1 = await host.waitFor("sab-strike");
    expect(s1.strikes).toBe(1);

    // Strike 2
    saboteur.client.send({ type: "sab-strike" });
    const s2 = await host.waitFor("sab-strike");
    expect(s2.strikes).toBe(2);

    // Strike 3 → fort destroyed
    saboteur.client.send({ type: "sab-strike" });
    const s3 = await host.waitFor("sab-strike");
    expect(s3.strikes).toBe(3);

    const knockdown = await host.waitFor("knocked-down");
    expect(knockdown.reason).toContain("saboteur");
  });

  it("need 4+ people → error with 3", async () => {
    const { roomId, host } = await createRoom("alice");
    await joinRoom(roomId, "bob");
    await joinRoom(roomId, "carol");

    host.send({ type: "sab-start" });
    const err = await host.waitFor("error");
    expect(err.message).toContain("need at least 4 people");
  });

  it("saboteur caught by vote → auto pillow fight vote starts", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");
    const dave = await joinRoom(roomId, "dave");

    host.send({ type: "sab-start" });
    await host.waitFor("sab-started");

    const players = [host, bob, carol, dave];
    const names = ["alice", "bob", "carol", "dave"];
    const roles: { client: typeof host; name: string; role: string }[] = [];
    for (let i = 0; i < players.length; i++) {
      const roleMsg = await players[i].waitFor("sab-role");
      roles.push({ client: players[i], name: names[i], role: roleMsg.role });
    }

    const saboteur = roles.find(r => r.role === "saboteur")!;

    // Wait for the sab vote round to start (500ms in test mode)
    await host.waitFor("sab-vote-start");

    // Everyone votes for the actual saboteur
    for (const r of roles) {
      r.client.send({ type: "sab-vote", suspect: saboteur.name });
    }

    // Should get sab-vote-result with wasSaboteur: true
    const result = await host.waitFor("sab-vote-result");
    expect(result.wasSaboteur).toBe(true);
    expect(result.saboteur).toBe(saboteur.name);

    // Auto pillow fight vote should start targeting the saboteur
    const voteStarted = await host.waitFor("vote-started");
    expect(voteStarted.target).toBe(saboteur.name);
    expect(voteStarted.auto).toBe(true);
  });

  it("non-saboteur can't strike", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");
    const carol = await joinRoom(roomId, "carol");
    const dave = await joinRoom(roomId, "dave");

    host.send({ type: "sab-start" });
    await host.waitFor("sab-started");

    const players = [host, bob, carol, dave];
    const roles: { client: typeof host; role: string }[] = [];
    for (const p of players) {
      const roleMsg = await p.waitFor("sab-role");
      roles.push({ client: p, role: roleMsg.role });
    }

    const defender = roles.find(r => r.role === "defender")!;
    // Defender tries to strike — should be ignored (no sab-strike broadcast)
    defender.client.send({ type: "sab-strike" });

    // Send a chat to prove the connection is alive, then verify no sab-strike came
    defender.client.send({ type: "chat", text: "test" });
    const msg = await defender.client.waitFor("message");
    expect(msg.text).toBe("test");

    // Verify no sab-strike was broadcast
    const strikes = host.messages.filter(m => m.type === "sab-strike");
    expect(strikes.length).toBe(0);
  });
});

// ---- King of the Hill ----

describe("King of the Hill", () => {
  it("non-host challenges → RPS → challenger wins → new host", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    bob.send({ type: "koth-challenge" });
    await host.waitFor("koth-started");

    // KOTH auto-starts RPS (both get rps-started)
    await host.waitFor("rps-started");

    // bob = p1 (challenger), alice = p2 (host)
    bob.send({ type: "rps-pick", pick: "paper" });
    host.send({ type: "rps-pick", pick: "rock" });

    const result = await host.waitFor("rps-result");
    expect(result.winner).toBe("bob");
    expect(result.koth).toBe(true);

    const newHost = await host.waitFor("new-host");
    expect(newHost.name).toBe("bob");

    const kothResult = await host.waitFor("koth-result");
    expect(kothResult.winner).toBe("bob");
    expect(kothResult.loser).toBe("alice");
  });

  it("host defends → no host change", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    bob.send({ type: "koth-challenge" });
    await host.waitFor("koth-started");
    await host.waitFor("rps-started");

    // alice (host/p2) wins
    bob.send({ type: "rps-pick", pick: "scissors" });
    host.send({ type: "rps-pick", pick: "rock" });

    const result = await host.waitFor("rps-result");
    expect(result.winner).toBe("alice");

    const kothResult = await host.waitFor("koth-result");
    expect(kothResult.winner).toBe("alice");
    expect(kothResult.loser).toBe("bob");

    // No new-host event should have been sent
    const newHostMsgs = host.messages.filter(m => m.type === "new-host");
    expect(newHostMsgs.length).toBe(0);
  });

  it("host can't challenge self → error", async () => {
    const { roomId, host } = await createRoom("alice");
    await joinRoom(roomId, "bob");

    host.send({ type: "koth-challenge" });
    const err = await host.waitFor("error");
    expect(err.message).toContain("only non-hosts can challenge");
  });
});

// ---- Breakout chat sharing ----

describe("Breakout chat sharing", () => {
  it("breakout result chat message broadcasts to room", async () => {
    const { roomId, host } = await createRoom("alice");
    const bob = await joinRoom(roomId, "bob");

    // Simulate what breakout does: sends a chat message with game result
    host.send({ type: "chat", text: "\uD83C\uDFAE destroyed 25/40 bricks in Breakout before running out of lives" });

    const msg = await bob.waitFor("message");
    expect(msg.from).toBe("alice");
    expect(msg.text).toContain("Breakout");
    expect(msg.text).toContain("25/40");
  });
});
