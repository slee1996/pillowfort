import { describe, expect, it } from "bun:test";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  canonicalBase64UrlV4,
  canonicalJsonV4,
  signSecureApplicationEventV4,
  type SecureApplicationContentV4,
  type SecureApplicationEventV4,
  type SecureRoomStateSnapshotV4,
} from "../src/applicationEventsV4";
import {
  computeRpsCommitmentV4,
  computeSaboteurCommitmentV4,
  createEmptySecureRoomStateV4,
  createSecureRoomStateV4 as createUnboundSecureRoomStateV4,
  reconcileSecureRoomMembershipV4,
  reduceSecureRoomEventV4,
  selectSaboteurDeviceV4,
  type SecureMemberCredentialV4,
} from "../src/secureGameReducer";

function encoded(bytes: number, fill: number): string {
  return canonicalBase64UrlV4(new Uint8Array(bytes).fill(fill));
}

const ROOM = encoded(16, 240);
let nextEventByte = 80;

interface TestMember {
  credential: SecureMemberCredentialV4;
  secretKey: Uint8Array;
}

async function member(fill: number, displayName: string, profiled = true): Promise<TestMember> {
  const secretKey = new Uint8Array(32).fill(fill);
  const publicKey = await getPublicKeyAsync(secretKey);
  return {
    secretKey,
    credential: {
      deviceId: encoded(16, fill),
      signaturePublicKey: canonicalBase64UrlV4(publicKey),
      ...(profiled ? { displayName } : {}),
    },
  };
}

function bindMembershipAdmissions(
  state: SecureRoomStateSnapshotV4,
  members: readonly TestMember[],
): SecureRoomStateSnapshotV4 {
  state.membershipAdmissionBindings = members.map((entry) => ({
    deviceId: entry.credential.deviceId,
    // Test-only deterministic canonical admission ids. Production values are
    // invitation-authenticated and distinct from device ids.
    admissionId: entry.credential.deviceId,
  })).sort((left, right) => left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0);
  return state;
}

function createSecureRoomStateV4(
  roomInstance: string,
  members: readonly SecureMemberCredentialV4[],
  hostDeviceId: string,
): SecureRoomStateSnapshotV4 {
  const state = createUnboundSecureRoomStateV4(roomInstance, members, hostDeviceId);
  state.membershipAdmissionBindings = members.map((entry) => ({
    deviceId: entry.deviceId,
    admissionId: entry.deviceId,
  })).sort((left, right) => left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0);
  return state;
}

async function signedEvent(
  state: SecureRoomStateSnapshotV4,
  actor: TestMember,
  content: SecureApplicationContentV4,
  overrides: Partial<{ deviceSequence: number; logicalOrder: number; deviceId: string }> = {},
): Promise<SecureApplicationEventV4> {
  const stateMember = state.members.find((entry) => entry.deviceId === actor.credential.deviceId);
  return signSecureApplicationEventV4({
    v: 4,
    roomInstance: ROOM,
    eventId: encoded(16, nextEventByte++),
    deviceId: overrides.deviceId ?? actor.credential.deviceId,
    deviceSequence: overrides.deviceSequence ?? (stateMember?.lastSequence ?? 0) + 1,
    logicalOrder: overrides.logicalOrder ?? state.logicalOrder + 1,
    content,
  }, (bytes) => signAsync(bytes, actor.secretKey));
}

async function apply(
  state: SecureRoomStateSnapshotV4,
  actor: TestMember,
  content: SecureApplicationContentV4,
  members: readonly TestMember[],
) {
  const event = await signedEvent(state, actor, content);
  const result = await reduceSecureRoomEventV4(state, event, members.map((entry) => entry.credential));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result;
}

describe("secure room deterministic reducer", () => {
  it("provides a valid bounded pre-admission state", () => {
    const empty = createEmptySecureRoomStateV4(ROOM);
    expect(empty).toMatchObject({ roomInstance: ROOM, logicalOrder: 0, revision: 0, hostDeviceId: null });
    expect(empty.members).toEqual([]);
  });

  it("binds an unprofiled MLS credential once and rejects normalized impersonation or later drift", async () => {
    const alice = await member(20, "alice", false);
    const bob = await member(21, "bob", false);
    let state = createEmptySecureRoomStateV4(ROOM);
    bindMembershipAdmissions(state, [alice]);
    const aliceProfile = await apply(state, alice, { type: "member-profile", displayName: "alice" }, [alice]);
    state = aliceProfile.state;
    expect(state.hostDeviceId).toBe(alice.credential.deviceId);
    expect(state.members[0].displayName).toBe("alice");
    bindMembershipAdmissions(state, [alice, bob]);

    const duplicate = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "member-profile", displayName: "ALICE" }),
      [alice.credential, bob.credential],
    );
    expect(duplicate).toEqual({ ok: false, code: "membership-mismatch" });

    state = (await apply(state, bob, { type: "member-profile", displayName: "bob" }, [alice, bob])).state;
    const rename = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "member-profile", displayName: "robert" }),
      [alice.credential, bob.credential],
    );
    expect(rename).toEqual({ ok: false, code: "membership-mismatch" });

    const driftedBob = { ...bob.credential, displayName: "robert" };
    const mismatchedRoster = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, alice, { type: "typing" }),
      [alice.credential, driftedBob],
    );
    expect(mismatchedRoster).toEqual({ ok: false, code: "membership-mismatch" });
  });

  it("bootstraps an unprofiled MLS joiner from the current host's profiled-subset snapshot", async () => {
    const alice = await member(18, "alice");
    const bob = await member(19, "bob", false);
    const members = [alice, bob];
    const empty = createEmptySecureRoomStateV4(ROOM);
    const eventId = encoded(16, nextEventByte++);
    const snapshot = createSecureRoomStateV4(ROOM, [alice.credential], alice.credential.deviceId);
    bindMembershipAdmissions(snapshot, members);
    snapshot.logicalOrder = 7;
    snapshot.revision = 8;
    snapshot.members.find((entry) => entry.deviceId === alice.credential.deviceId)!.lastSequence = 3;
    snapshot.seenEventIds.push(eventId);
    const event = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId,
      deviceId: alice.credential.deviceId,
      deviceSequence: 3,
      logicalOrder: 7,
      content: { type: "state-snapshot", state: snapshot },
    }, (bytes) => signAsync(bytes, alice.secretKey));
    const restored = await reduceSecureRoomEventV4(empty, event, members.map((entry) => entry.credential));
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.code);
    expect(restored.state).toEqual(snapshot);
    expect(restored.state.members.some((entry) => entry.deviceId === bob.credential.deviceId)).toBe(false);

    const refreshEventId = encoded(16, nextEventByte++);
    const refreshedSnapshot = structuredClone(restored.state);
    refreshedSnapshot.logicalOrder = 8;
    refreshedSnapshot.revision = 9;
    refreshedSnapshot.members.find((entry) => entry.deviceId === alice.credential.deviceId)!.lastSequence = 4;
    refreshedSnapshot.seenEventIds.push(refreshEventId);
    const refreshEvent = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId: refreshEventId,
      deviceId: alice.credential.deviceId,
      deviceSequence: 4,
      logicalOrder: 8,
      content: { type: "state-snapshot", state: refreshedSnapshot },
    }, (bytes) => signAsync(bytes, alice.secretKey));
    const refreshed = await reduceSecureRoomEventV4(
      restored.state,
      refreshEvent,
      members.map((entry) => entry.credential),
    );
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error(refreshed.code);
    expect(refreshed.state).toEqual(refreshedSnapshot);

    // An unauthenticated relay can rewrite an outer MLS delivery id, but it
    // cannot make that rewrite agree with the host's invitation-signed
    // admission ledger in the next encrypted snapshot.
    const relayReboundAdmission = structuredClone(restored.state);
    const bobAdmission = relayReboundAdmission.membershipAdmissionBindings.find((binding) =>
      binding.deviceId === bob.credential.deviceId);
    if (!bobAdmission) throw new Error("bob admission binding missing");
    bobAdmission.admissionId = encoded(16, 15);
    expect(await reduceSecureRoomEventV4(
      relayReboundAdmission,
      refreshEvent,
      members.map((entry) => entry.credential),
    )).toEqual({ ok: false, code: "invalid-transition" });

    const rewrittenSnapshot = structuredClone(refreshedSnapshot);
    rewrittenSnapshot.logicalOrder = 9;
    rewrittenSnapshot.revision = 10;
    rewrittenSnapshot.members[0].lastSequence = 5;
    rewrittenSnapshot.leaderboards[0].rps = 999;
    const rewriteEventId = encoded(16, nextEventByte++);
    rewrittenSnapshot.seenEventIds.push(rewriteEventId);
    const rewriteEvent = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId: rewriteEventId,
      deviceId: alice.credential.deviceId,
      deviceSequence: 5,
      logicalOrder: 9,
      content: { type: "state-snapshot", state: rewrittenSnapshot },
    }, (bytes) => signAsync(bytes, alice.secretKey));
    expect(await reduceSecureRoomEventV4(
      refreshed.state,
      rewriteEvent,
      members.map((entry) => entry.credential),
    )).toEqual({ ok: false, code: "invalid-transition" });

    const wrongSignerEvent = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId: encoded(16, nextEventByte++),
      deviceId: bob.credential.deviceId,
      deviceSequence: 1,
      logicalOrder: 7,
      content: { type: "state-snapshot", state: snapshot },
    }, (bytes) => signAsync(bytes, bob.secretKey));
    expect(await reduceSecureRoomEventV4(empty, wrongSignerEvent, members.map((entry) => entry.credential)))
      .toEqual({ ok: false, code: "invalid-transition" });

    const mallory = await member(17, "mallory");
    const rogueSnapshot = createSecureRoomStateV4(ROOM, [alice.credential, mallory.credential], alice.credential.deviceId);
    rogueSnapshot.logicalOrder = 7;
    rogueSnapshot.revision = 8;
    rogueSnapshot.members.find((entry) => entry.deviceId === alice.credential.deviceId)!.lastSequence = 3;
    const rogueEventId = encoded(16, nextEventByte++);
    rogueSnapshot.seenEventIds.push(rogueEventId);
    const rogueMemberEvent = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId: rogueEventId,
      deviceId: alice.credential.deviceId,
      deviceSequence: 3,
      logicalOrder: 7,
      content: { type: "state-snapshot", state: rogueSnapshot },
    }, (bytes) => signAsync(bytes, alice.secretKey));
    expect(await reduceSecureRoomEventV4(empty, rogueMemberEvent, members.map((entry) => entry.credential)))
      .toEqual({ ok: false, code: "invalid-transition" });

    const carol = await member(16, "carol");
    const wrongHostMembers = [alice, carol, bob];
    const wrongHostSnapshot = createSecureRoomStateV4(
      ROOM,
      [alice.credential, carol.credential],
      carol.credential.deviceId,
    );
    wrongHostSnapshot.logicalOrder = 7;
    wrongHostSnapshot.revision = 8;
    wrongHostSnapshot.members.find((entry) => entry.deviceId === alice.credential.deviceId)!.lastSequence = 3;
    const wrongHostEventId = encoded(16, nextEventByte++);
    wrongHostSnapshot.seenEventIds.push(wrongHostEventId);
    const wrongHostEvent = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId: wrongHostEventId,
      deviceId: alice.credential.deviceId,
      deviceSequence: 3,
      logicalOrder: 7,
      content: { type: "state-snapshot", state: wrongHostSnapshot },
    }, (bytes) => signAsync(bytes, alice.secretKey));
    expect(await reduceSecureRoomEventV4(empty, wrongHostEvent, wrongHostMembers.map((entry) => entry.credential)))
      .toEqual({ ok: false, code: "invalid-transition" });
  });

  it("redacts pre-admission transcript history while incumbents retain it and future events converge", async () => {
    const alice = await member(31, "alice");
    const bob = await member(32, "bob");
    const charlie = await member(33, "charlie", false);
    const membership = [alice.credential, bob.credential, charlie.credential];
    const incumbent = createSecureRoomStateV4(
      ROOM,
      [alice.credential, bob.credential],
      alice.credential.deviceId,
    );
    bindMembershipAdmissions(incumbent, [alice, bob, charlie]);
    incumbent.logicalOrder = 4;
    incumbent.revision = 4;
    incumbent.members[0].lastSequence = 2;
    incumbent.members[1].lastSequence = 2;
    const oldChatId = encoded(16, 34);
    const oldDrawingId = encoded(16, 35);
    const aliceLocalMessages: SecureRoomStateSnapshotV4["messages"] = [{
      eventId: oldChatId,
      deviceId: alice.credential.deviceId,
      displayName: "alice",
      text: "before charlie joined",
      style: null,
    }];
    const bobLocalDrawings: SecureRoomStateSnapshotV4["drawings"] = [{
      eventId: oldDrawingId,
      deviceId: bob.credential.deviceId,
      displayName: "bob",
      color: "#FF0000",
      points: [[0.1, 0.2], [0.3, 0.4]],
      strokeStart: true,
    }];
    incumbent.seenEventIds = [oldChatId, oldDrawingId];

    const bootstrapEventId = encoded(16, 36);
    const redacted = structuredClone(incumbent);
    redacted.messages = [];
    redacted.drawings = [];
    redacted.logicalOrder = 5;
    redacted.revision = 5;
    redacted.members[0].lastSequence = 3;
    redacted.seenEventIds.push(bootstrapEventId);
    const bootstrap = await signSecureApplicationEventV4({
      v: 4,
      roomInstance: ROOM,
      eventId: bootstrapEventId,
      deviceId: alice.credential.deviceId,
      deviceSequence: 3,
      logicalOrder: 5,
      content: { type: "state-snapshot", state: redacted },
    }, (bytes) => signAsync(bytes, alice.secretKey));

    const aliceView = await reduceSecureRoomEventV4(incumbent, bootstrap, membership);
    const bobView = await reduceSecureRoomEventV4(structuredClone(incumbent), bootstrap, membership);
    const charlieView = await reduceSecureRoomEventV4(createEmptySecureRoomStateV4(ROOM), bootstrap, membership);
    expect(aliceView.ok).toBeTrue();
    expect(bobView.ok).toBeTrue();
    expect(charlieView.ok).toBeTrue();
    if (!aliceView.ok || !bobView.ok || !charlieView.ok) throw new Error("bootstrap failed");
    expect(aliceView.state.messages).toEqual([]);
    expect(bobView.state.drawings).toEqual([]);
    expect(aliceLocalMessages.map((message) => message.text)).toEqual(["before charlie joined"]);
    expect(bobLocalDrawings.map((drawing) => drawing.eventId)).toEqual([oldDrawingId]);
    expect(charlieView.state.messages).toEqual([]);
    expect(charlieView.state.drawings).toEqual([]);

    const future = await signedEvent(
      charlieView.state,
      bob,
      { type: "chat", text: "after charlie joined" },
    );
    const incumbentFuture = await reduceSecureRoomEventV4(aliceView.state, future, membership);
    const joinerFuture = await reduceSecureRoomEventV4(charlieView.state, future, membership);
    expect(incumbentFuture.ok).toBeTrue();
    expect(joinerFuture.ok).toBeTrue();
    if (!incumbentFuture.ok || !joinerFuture.ok) throw new Error("future event failed");
    expect(incumbentFuture.effects).toEqual(joinerFuture.effects);
    for (const effect of incumbentFuture.effects) {
      if (effect.type === "chat") aliceLocalMessages.push({
        eventId: effect.eventId,
        deviceId: effect.deviceId,
        displayName: effect.displayName,
        text: effect.text,
        style: effect.style,
      });
    }
    const charlieLocalMessages = joinerFuture.effects
      .filter((effect) => effect.type === "chat")
      .map((effect) => effect.type === "chat" ? effect.text : "");
    expect(aliceLocalMessages.map((message) => message.text)).toEqual([
      "before charlie joined",
      "after charlie joined",
    ]);
    expect(charlieLocalMessages).toEqual(["after charlie joined"]);
    const withoutHistory = (state: SecureRoomStateSnapshotV4) => ({
      ...state,
      messages: [],
      drawings: [],
    });
    expect(withoutHistory(incumbentFuture.state)).toEqual(withoutHistory(joinerFuture.state));

    const tamperMutations: Array<(state: SecureRoomStateSnapshotV4) => void> = [
      (state) => { state.theme = "campus-blue"; },
      (state) => { state.members[1].status = "away"; },
      (state) => { state.leaderboards[1].rps = 1; },
      (state) => { state.queue.push({ requestId: encoded(16, 37), game: "rps", byDeviceId: bob.credential.deviceId, targetDeviceId: alice.credential.deviceId }); },
    ];
    for (let index = 0; index < tamperMutations.length; index += 1) {
      const eventId = encoded(16, 40 + index);
      const tampered = structuredClone(redacted);
      tampered.seenEventIds[tampered.seenEventIds.length - 1] = eventId;
      tamperMutations[index](tampered);
      const event = await signSecureApplicationEventV4({
        v: 4,
        roomInstance: ROOM,
        eventId,
        deviceId: alice.credential.deviceId,
        deviceSequence: 3,
        logicalOrder: 5,
        content: { type: "state-snapshot", state: tampered },
      }, (bytes) => signAsync(bytes, alice.secretKey));
      expect(await reduceSecureRoomEventV4(incumbent, event, membership))
        .toEqual({ ok: false, code: "invalid-transition" });
    }
  });

  it("binds signatures, device sequence, logical order, and display names without mutating rejected state", async () => {
    const alice = await member(1, "alice");
    const bob = await member(2, "bob");
    const members = [alice, bob];
    const state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);
    const before = canonicalJsonV4(state);

    const forged = await signedEvent(state, alice, { type: "typing" }, { deviceId: bob.credential.deviceId });
    expect(await reduceSecureRoomEventV4(state, forged, members.map((entry) => entry.credential))).toEqual({ ok: false, code: "invalid-signature" });

    const skipped = await signedEvent(state, alice, { type: "typing" }, { logicalOrder: 2 });
    expect(await reduceSecureRoomEventV4(state, skipped, members.map((entry) => entry.credential))).toEqual({ ok: false, code: "out-of-order" });

    const wrongName = await signedEvent(state, alice, { type: "member-profile", displayName: "mallory" });
    expect(await reduceSecureRoomEventV4(state, wrongName, members.map((entry) => entry.credential))).toEqual({ ok: false, code: "membership-mismatch" });
    expect(canonicalJsonV4(state)).toBe(before);

    const valid = await apply(state, alice, { type: "chat", text: "hello", style: { italic: true } }, members);
    expect(valid.state.logicalOrder).toBe(1);
    expect(valid.state.members[0].lastSequence).toBe(1);
    expect(valid.effects[0]).toMatchObject({ type: "chat", deviceId: alice.credential.deviceId, displayName: "alice" });
    expect(valid.state.messages).toEqual([]);
    const drawing = await apply(valid.state, alice, {
      type: "drawing", color: "#FF0000", points: [[0.1, 0.2], [0.3, 0.4]], strokeStart: true,
    }, members);
    expect(drawing.state.drawings).toEqual([]);
    expect(drawing.effects[0]).toMatchObject({
      type: "drawing", deviceId: alice.credential.deviceId, displayName: "alice",
      color: "#FF0000", points: [[0.1, 0.2], [0.3, 0.4]], strokeStart: true,
    });
    expect(canonicalJsonV4(state)).toBe(before);

    const replay = await reduceSecureRoomEventV4(drawing.state, await signedEvent(drawing.state, alice, { type: "typing" }, {
      logicalOrder: 1,
      deviceSequence: 1,
    }), members.map((entry) => entry.credential));
    expect(replay).toEqual({ ok: false, code: "out-of-order" });
  });

  it("enforces host-only theme/close and an explicit offer/accept transfer", async () => {
    const alice = await member(3, "alice");
    const bob = await member(4, "bob");
    const members = [alice, bob];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);

    const unauthorized = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "theme", theme: "campus-blue" }),
      members.map((entry) => entry.credential),
    );
    expect(unauthorized).toEqual({ ok: false, code: "invalid-transition" });

    const toss = await apply(state, alice, { type: "pillow-toss", targetDeviceId: bob.credential.deviceId }, members);
    state = toss.state;
    expect(state.pendingHostDeviceId).toBe(bob.credential.deviceId);
    expect(state.hostDeviceId).toBe(alice.credential.deviceId);
    expect(toss.effects).toContainEqual({ type: "pillow-tossed", fromDeviceId: alice.credential.deviceId, targetDeviceId: bob.credential.deviceId });
    state = (await apply(state, bob, {
      type: "host-transfer", action: "accept", authorizationId: encoded(16, 61),
    }, members)).state;
    expect(state.hostDeviceId).toBe(bob.credential.deviceId);
    state = (await apply(state, bob, { type: "theme", theme: "campus-blue" }, members)).state;
    expect(state.theme).toBe("campus-blue");
    const closed = await apply(state, bob, { type: "room-close", reason: "done playing" }, members);
    expect(closed.state.closedReason).toBe("done playing");
    const afterClose = await reduceSecureRoomEventV4(
      closed.state,
      await signedEvent(closed.state, alice, { type: "typing" }),
      members.map((entry) => entry.credential),
    );
    expect(afterClose).toEqual({ ok: false, code: "room-closed" });
  });

  it("turns a signed non-host leave into an authenticated removal request", async () => {
    const alice = await member(27, "alice");
    const bob = await member(28, "bob");
    const members = [alice, bob];
    let state = createSecureRoomStateV4(
      ROOM,
      members.map((entry) => entry.credential),
      alice.credential.deviceId,
    );

    const hostLeave = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, alice, { type: "member-leave" }),
      members.map((entry) => entry.credential),
    );
    expect(hostLeave).toEqual({ ok: false, code: "invalid-transition" });

    const leave = await apply(state, bob, { type: "member-leave" }, members);
    state = leave.state;
    expect(leave.effects).toContainEqual({
      type: "member-removal-request",
      deviceId: bob.credential.deviceId,
      reason: "leave",
    });
    expect(state.members.map((entry) => entry.deviceId)).toContain(bob.credential.deviceId);
    expect(state.pendingRemovalDeviceIds).toEqual([bob.credential.deviceId]);
    expect(state.members.find((entry) => entry.deviceId === bob.credential.deviceId)?.lastSequence).toBe(1);

    const afterLeaving = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "chat", text: "still here" }),
      members.map((entry) => entry.credential),
    );
    expect(afterLeaving).toEqual({ ok: false, code: "invalid-transition" });
  });

  it("does not let a game straddle a pending host transfer", async () => {
    const host = await member(38, "host");
    const successor = await member(39, "successor");
    const members = [host, successor];
    let state = createSecureRoomStateV4(
      ROOM, members.map((entry) => entry.credential), host.credential.deviceId,
    );
    state = (await apply(state, host, {
      type: "host-transfer", action: "offer", targetDeviceId: successor.credential.deviceId,
    }, members)).state;

    const gameId = encoded(16, 66);
    const direct = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, host, {
        type: "rps", action: "challenge", gameId, targetDeviceId: successor.credential.deviceId,
      }),
      members.map((entry) => entry.credential),
    );
    expect(direct).toEqual({ ok: false, code: "invalid-transition" });

    state = (await apply(state, host, {
      type: "queue", action: "enqueue", requestId: gameId, game: "rps",
      targetDeviceId: successor.credential.deviceId,
    }, members)).state;
    expect(state.rps).toBeNull();
    expect(state.queue).toHaveLength(1);

    const accepted = await apply(state, successor, {
      type: "host-transfer", action: "accept", authorizationId: encoded(16, 67),
    }, members);
    expect(accepted.state.hostDeviceId).toBe(successor.credential.deviceId);
    expect(accepted.state.pendingHostDeviceId).toBeNull();
    expect(accepted.state.queue).toEqual([]);
    expect(accepted.state.rps).toMatchObject({
      gameId,
      p1DeviceId: host.credential.deviceId,
      p2DeviceId: successor.credential.deviceId,
    });
  });

  it("never resolves a partial pillow vote and does not let the target cancel it", async () => {
    const members = await Promise.all([
      member(29, "alice"), member(30, "bob"), member(31, "carol"), member(32, "dave"),
    ]);
    let state = createSecureRoomStateV4(
      ROOM,
      members.map((entry) => entry.credential),
      members[0].credential.deviceId,
    );
    const gameId = encoded(16, 55);
    state = (await apply(state, members[0], {
      type: "vote", action: "start", gameId, targetDeviceId: members[1].credential.deviceId,
    }, members)).state;
    state = (await apply(state, members[2], {
      type: "vote", action: "cast", gameId, choice: "no",
    }, members)).state;

    const nonHostClose = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, members[3], { type: "vote", action: "close", gameId }),
      members.map((entry) => entry.credential),
    );
    expect(nonHostClose).toEqual({ ok: false, code: "invalid-transition" });

    const hostClose = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, members[0], { type: "vote", action: "close", gameId }),
      members.map((entry) => entry.credential),
    );
    expect(hostClose).toEqual({ ok: false, code: "invalid-transition" });

    const targetCancel = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, members[1], { type: "vote", action: "cancel", gameId }),
      members.map((entry) => entry.credential),
    );
    expect(targetCancel).toEqual({ ok: false, code: "invalid-transition" });

    const cancelled = await apply(state, members[0], { type: "vote", action: "cancel", gameId }, members);
    expect(cancelled.state.vote).toBeNull();
    expect(cancelled.effects).toContainEqual({
      type: "game-cancelled", game: "vote", gameId,
      byDeviceId: members[0].credential.deviceId, forfeited: false,
    });
    expect(cancelled.effects.some((effect) => effect.type === "vote-result")).toBe(false);
    expect(cancelled.effects.some((effect) => effect.type === "member-removal-request")).toBe(false);
  });

  it("resolves votes and Tic-Tac-Toe from authenticated ordered actions", async () => {
    const alice = await member(5, "alice");
    const bob = await member(6, "bob");
    const carol = await member(7, "carol");
    const members = [alice, bob, carol];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);
    const voteId = encoded(16, 30);

    state = (await apply(state, alice, { type: "vote", action: "start", gameId: voteId, targetDeviceId: bob.credential.deviceId }, members)).state;
    const voteResult = await apply(state, carol, { type: "vote", action: "cast", gameId: voteId, choice: "yes" }, members);
    state = voteResult.state;
    expect(state.vote).toBeNull();
    expect(state.pendingRemovalDeviceIds).toEqual([bob.credential.deviceId]);
    expect(voteResult.effects).toContainEqual(expect.objectContaining({ type: "vote-result", ejected: true, yes: 2, no: 0 }));
    expect(voteResult.effects).toContainEqual({ type: "member-removal-request", deviceId: bob.credential.deviceId, reason: "vote" });

    const ejectedAction = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "chat", text: "evade ejection" }),
      members.map((entry) => entry.credential),
    );
    expect(ejectedAction).toEqual({ ok: false, code: "invalid-transition" });

    const blockedGame = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, alice, {
        type: "ttt", action: "challenge", gameId: encoded(16, 39), targetDeviceId: carol.credential.deviceId,
      }),
      members.map((entry) => entry.credential),
    );
    expect(blockedGame).toEqual({ ok: false, code: "invalid-transition" });

    const reconciled = reconcileSecureRoomMembershipV4(state, [alice.credential, carol.credential]);
    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) throw new Error(reconciled.code);
    state = reconciled.state;
    expect(state.pendingRemovalDeviceIds).toEqual([]);

    const gameId = encoded(16, 31);
    const remaining = [alice, carol];
    state = (await apply(state, alice, { type: "ttt", action: "challenge", gameId, targetDeviceId: carol.credential.deviceId }, remaining)).state;
    state = (await apply(state, carol, { type: "ttt", action: "accept", gameId }, remaining)).state;
    for (const [actor, cell] of [[alice, 0], [carol, 3], [alice, 1], [carol, 4]] as const) {
      state = (await apply(state, actor, { type: "ttt", action: "move", gameId, cell }, remaining)).state;
    }
    const win = await apply(state, alice, { type: "ttt", action: "move", gameId, cell: 2 }, remaining);
    expect(win.state.ttt).toBeNull();
    expect(win.effects).toContainEqual({ type: "ttt-result", gameId, winnerDeviceId: alice.credential.deviceId, draw: false });
    expect(win.state.leaderboards.find((entry) => entry.deviceId === alice.credential.deviceId)?.ttt).toBe(1);
  });

  it("uses RPS commit-reveal and rejects a reveal that does not open its commitment", async () => {
    const alice = await member(8, "alice");
    const bob = await member(9, "bob");
    const members = [alice, bob];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);
    const gameId = encoded(16, 32);
    const aliceNonce = encoded(32, 10);
    const bobNonce = encoded(32, 11);
    const aliceCommit = await computeRpsCommitmentV4(gameId, alice.credential.deviceId, "rock", aliceNonce);
    const bobCommit = await computeRpsCommitmentV4(gameId, bob.credential.deviceId, "scissors", bobNonce);

    state = (await apply(state, alice, { type: "rps", action: "challenge", gameId, targetDeviceId: bob.credential.deviceId }, members)).state;
    state = (await apply(state, bob, { type: "rps", action: "accept", gameId }, members)).state;
    state = (await apply(state, alice, { type: "rps", action: "commit", gameId, commitment: aliceCommit }, members)).state;
    state = (await apply(state, bob, { type: "rps", action: "commit", gameId, commitment: bobCommit }, members)).state;

    const beforeBadReveal = canonicalJsonV4(state);
    const badReveal = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, alice, { type: "rps", action: "reveal", gameId, pick: "paper", nonce: aliceNonce }),
      members.map((entry) => entry.credential),
    );
    expect(badReveal).toEqual({ ok: false, code: "invalid-transition" });
    expect(canonicalJsonV4(state)).toBe(beforeBadReveal);

    state = (await apply(state, alice, { type: "rps", action: "reveal", gameId, pick: "rock", nonce: aliceNonce }, members)).state;
    const result = await apply(state, bob, { type: "rps", action: "reveal", gameId, pick: "scissors", nonce: bobNonce }, members);
    expect(result.state.rps).toBeNull();
    expect(result.effects).toContainEqual(expect.objectContaining({ type: "rps-result", winnerDeviceId: alice.credential.deviceId }));
    expect(result.state.leaderboards.find((entry) => entry.deviceId === alice.credential.deviceId)?.rps).toBe(1);
  });

  it("keeps KOTH authority relay-consistent until a separate authorized transfer", async () => {
    const host = await member(33, "host");
    const challenger = await member(34, "challenger");
    const members = [host, challenger];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), host.credential.deviceId);
    const gameId = encoded(16, 62);
    const challengerNonce = encoded(32, 62);
    const hostNonce = encoded(32, 63);
    const challengerCommit = await computeRpsCommitmentV4(
      gameId, challenger.credential.deviceId, "rock", challengerNonce,
    );
    const hostCommit = await computeRpsCommitmentV4(gameId, host.credential.deviceId, "scissors", hostNonce);

    state = (await apply(state, challenger, { type: "koth", action: "challenge", gameId }, members)).state;

    const transferDuringGame = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, host, {
        type: "host-transfer", action: "offer", targetDeviceId: challenger.credential.deviceId,
      }),
      members.map((entry) => entry.credential),
    );
    expect(transferDuringGame).toEqual({ ok: false, code: "invalid-transition" });

    state = (await apply(state, challenger, {
      type: "rps", action: "commit", gameId, commitment: challengerCommit,
    }, members)).state;
    state = (await apply(state, host, {
      type: "rps", action: "commit", gameId, commitment: hostCommit,
    }, members)).state;
    state = (await apply(state, challenger, {
      type: "rps", action: "reveal", gameId, pick: "rock", nonce: challengerNonce,
    }, members)).state;
    const result = await apply(state, host, {
      type: "rps", action: "reveal", gameId, pick: "scissors", nonce: hostNonce,
    }, members);
    state = result.state;

    expect(state.hostDeviceId).toBe(host.credential.deviceId);
    expect(state.pendingHostDeviceId).toBe(challenger.credential.deviceId);
    expect(state.leaderboards.find((entry) => entry.deviceId === challenger.credential.deviceId)?.koth).toBe(1);
    expect(result.effects).toContainEqual({
      type: "host-transfer-required", deviceId: challenger.credential.deviceId,
    });
    expect(result.effects.some((effect) => effect.type === "host-changed")).toBe(false);

    state = (await apply(state, host, {
      type: "host-transfer", action: "offer", targetDeviceId: challenger.credential.deviceId,
    }, members)).state;
    expect(state.hostDeviceId).toBe(host.credential.deviceId);
    state = (await apply(state, challenger, {
      type: "host-transfer", action: "accept", authorizationId: encoded(16, 64),
    }, members)).state;
    expect(state.hostDeviceId).toBe(challenger.credential.deviceId);
    expect(state.pendingHostDeviceId).toBeNull();
  });

  it("does not let a pillow vote target the current host", async () => {
    const members = await Promise.all([
      member(35, "host"), member(36, "bob"), member(37, "carol"),
    ]);
    const state = createSecureRoomStateV4(
      ROOM, members.map((entry) => entry.credential), members[0].credential.deviceId,
    );
    const gameId = encoded(16, 65);
    const direct = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, members[1], {
        type: "vote", action: "start", gameId, targetDeviceId: members[0].credential.deviceId,
      }),
      members.map((entry) => entry.credential),
    );
    expect(direct).toEqual({ ok: false, code: "invalid-transition" });

    const queued = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, members[1], {
        type: "queue", action: "enqueue", requestId: gameId, game: "vote",
        targetDeviceId: members[0].credential.deviceId,
      }),
      members.map((entry) => entry.credential),
    );
    expect(queued).toEqual({ ok: false, code: "invalid-transition" });
  });

  it("reconciles only authenticated MLS removals and drains the queue after an aborted game", async () => {
    const alice = await member(16, "alice");
    const bob = await member(17, "bob");
    const carol = await member(42, "carol");
    const members = [alice, bob, carol];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);
    const gameId = encoded(16, 34);
    const queuedGameId = encoded(16, 35);
    state = (await apply(state, alice, { type: "rps", action: "challenge", gameId, targetDeviceId: bob.credential.deviceId }, members)).state;
    state = (await apply(state, carol, {
      type: "queue", action: "enqueue", requestId: queuedGameId, game: "ttt",
      targetDeviceId: alice.credential.deviceId,
    }, members)).state;

    const removed = reconcileSecureRoomMembershipV4(state, [alice.credential, carol.credential]);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error(removed.code);
    expect(removed.state.rps).toBeNull();
    expect(removed.state.ttt).toMatchObject({
      gameId: queuedGameId,
      p1DeviceId: carol.credential.deviceId,
      p2DeviceId: alice.credential.deviceId,
      phase: "pending",
    });
    expect(removed.state.queue).toEqual([]);
    expect(removed.state.members.map((entry) => entry.deviceId)).toEqual([
      alice.credential.deviceId, carol.credential.deviceId,
    ]);
    expect(removed.effects).toContainEqual({ type: "member-removed", deviceId: bob.credential.deviceId });

    const removeHost = reconcileSecureRoomMembershipV4(state, [bob.credential]);
    expect(removeHost).toEqual({ ok: false, code: "invalid-transition" });
  });

  it("requires accepted-game participants to forfeit and deterministically drains the queue", async () => {
    const alice = await member(22, "alice");
    const bob = await member(23, "bob");
    const carol = await member(24, "carol");
    const members = [alice, bob, carol];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);
    const rpsId = encoded(16, 50);
    const queuedTttId = encoded(16, 51);
    state = (await apply(state, alice, { type: "rps", action: "challenge", gameId: rpsId, targetDeviceId: bob.credential.deviceId }, members)).state;
    state = (await apply(state, bob, { type: "rps", action: "accept", gameId: rpsId }, members)).state;
    const duplicateActiveId = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, carol, { type: "queue", action: "enqueue", requestId: rpsId, game: "ttt", targetDeviceId: alice.credential.deviceId }),
      members.map((entry) => entry.credential),
    );
    expect(duplicateActiveId).toEqual({ ok: false, code: "invalid-transition" });
    state = (await apply(state, carol, { type: "queue", action: "enqueue", requestId: queuedTttId, game: "ttt", targetDeviceId: alice.credential.deviceId }, members)).state;
    expect(state.queue).toHaveLength(1);

    const evadeLoss = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "rps", action: "cancel", gameId: rpsId }),
      members.map((entry) => entry.credential),
    );
    expect(evadeLoss).toEqual({ ok: false, code: "invalid-transition" });

    const forfeited = await apply(state, bob, { type: "rps", action: "forfeit", gameId: rpsId }, members);
    state = forfeited.state;
    expect(forfeited.effects).toContainEqual({ type: "game-cancelled", game: "rps", gameId: rpsId, byDeviceId: bob.credential.deviceId, forfeited: true });
    expect(state.leaderboards.find((entry) => entry.deviceId === alice.credential.deviceId)?.rps).toBe(1);
    expect(state.queue).toEqual([]);
    expect(state.ttt).toMatchObject({ gameId: queuedTttId, p1DeviceId: carol.credential.deviceId, p2DeviceId: alice.credential.deviceId, phase: "pending" });

    const unauthorized = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, bob, { type: "ttt", action: "cancel", gameId: queuedTttId }),
      members.map((entry) => entry.credential),
    );
    expect(unauthorized).toEqual({ ok: false, code: "invalid-transition" });

    state = (await apply(state, alice, { type: "ttt", action: "accept", gameId: queuedTttId }, members)).state;
    const playingParticipantCancel = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, carol, { type: "ttt", action: "cancel", gameId: queuedTttId }),
      members.map((entry) => entry.credential),
    );
    expect(playingParticipantCancel).toEqual({ ok: false, code: "invalid-transition" });
    const tttForfeit = await apply(state, carol, { type: "ttt", action: "forfeit", gameId: queuedTttId }, members);
    expect(tttForfeit.state.ttt).toBeNull();
    expect(tttForfeit.state.leaderboards.find((entry) => entry.deviceId === alice.credential.deviceId)?.ttt).toBe(1);
  });

  it("does not erase an unrelated queued game when an RPS challenge starts", async () => {
    const alice = await member(25, "alice");
    const bob = await member(26, "bob");
    const members = [alice, bob];
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), alice.credential.deviceId);
    const queuedTttId = encoded(16, 53);
    state.queue.push({
      requestId: queuedTttId,
      game: "ttt",
      byDeviceId: alice.credential.deviceId,
      targetDeviceId: bob.credential.deviceId,
    });
    const rpsId = encoded(16, 54);
    state = (await apply(state, alice, {
      type: "rps", action: "challenge", gameId: rpsId, targetDeviceId: bob.credential.deviceId,
    }, members)).state;
    expect(state.rps?.gameId).toBe(rpsId);
    expect(state.queue).toEqual([{
      requestId: queuedTttId,
      game: "ttt",
      byDeviceId: alice.credential.deviceId,
      targetDeviceId: bob.credential.deviceId,
    }]);
  });

  it("orders Saboteur entropy by explicit code units, independent of localeCompare", async () => {
    const reveals = [
      { deviceId: encoded(16, 65), nonce: encoded(32, 1) },
      { deviceId: encoded(16, 95), nonce: encoded(32, 2) },
      { deviceId: encoded(16, 90), nonce: encoded(32, 3) },
      { deviceId: encoded(16, 97), nonce: encoded(32, 4) },
    ];
    const expected = await selectSaboteurDeviceV4(encoded(16, 52), reveals);
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => { throw new Error("locale ordering must not be consulted"); };
    try {
      expect(await selectSaboteurDeviceV4(encoded(16, 52), [...reveals].reverse())).toBe(expected);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("derives Saboteur from every participant's committed entropy and keeps the relay out of randomness", async () => {
    const members = await Promise.all([
      member(12, "alice"), member(13, "bob"), member(14, "carol"), member(15, "dave"),
    ]);
    let state = createSecureRoomStateV4(ROOM, members.map((entry) => entry.credential), members[0].credential.deviceId);
    const gameId = encoded(16, 33);
    const reveals = members.map((entry, index) => ({ deviceId: entry.credential.deviceId, nonce: encoded(32, 40 + index) }));
    const expectedSaboteur = await selectSaboteurDeviceV4(gameId, reveals);

    state = (await apply(state, members[0], { type: "saboteur", action: "start", gameId }, members)).state;
    for (let index = 0; index < members.length; index++) {
      const commitment = await computeSaboteurCommitmentV4(gameId, members[index].credential.deviceId, reveals[index].nonce);
      state = (await apply(state, members[index], { type: "saboteur", action: "entropy-commit", gameId, commitment }, members)).state;
    }
    for (let index = 0; index < members.length - 1; index++) {
      state = (await apply(state, members[index], { type: "saboteur", action: "entropy-reveal", gameId, nonce: reveals[index].nonce }, members)).state;
      expect(state.saboteur?.saboteurDeviceId).toBeNull();
    }
    const ready = await apply(state, members[3], { type: "saboteur", action: "entropy-reveal", gameId, nonce: reveals[3].nonce }, members);
    state = ready.state;
    expect(state.saboteur?.saboteurDeviceId).toBe(expectedSaboteur);
    expect(ready.effects).toContainEqual({ type: "saboteur-ready", gameId, saboteurDeviceId: expectedSaboteur });

    const saboteur = members.find((entry) => entry.credential.deviceId === expectedSaboteur)!;
    const defender = members.find((entry) => entry !== saboteur)!;
    const wrongTarget = members.find((entry) => entry !== saboteur && entry !== defender)!;
    state = (await apply(state, saboteur, { type: "saboteur", action: "strike", gameId }, members)).state;
    expect(state.saboteur?.canStrike).toBe(false);
    state = (await apply(state, defender, { type: "saboteur", action: "accuse", gameId, suspectDeviceId: wrongTarget.credential.deviceId }, members)).state;
    const partialResolution = await reduceSecureRoomEventV4(
      state,
      await signedEvent(state, members[0], { type: "saboteur", action: "resolve-vote", gameId }),
      members.map((entry) => entry.credential),
    );
    expect(partialResolution).toEqual({ ok: false, code: "invalid-transition" });
    for (const voter of members) state = (await apply(state, voter, { type: "saboteur", action: "vote", gameId, choice: "yes" }, members)).state;
    expect(state.saboteur?.canStrike).toBe(true);
  });
});
