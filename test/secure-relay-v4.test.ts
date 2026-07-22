import { describe, expect, it } from "bun:test";
import {
  SECURE_ACTIVE_DISCONNECT_GRACE_MS_V4,
  SECURE_ADMISSION_TTL_MS_V4,
  SECURE_APPLICATION_APPROVAL_TTL_MS_V4,
  SECURE_COMMIT_APPROVAL_TTL_MS_V4,
  MAX_SECURE_DEVICE_BACKLOG_ENTRIES_V4,
  MAX_SECURE_KEY_PACKAGE_DIGESTS_V4,
  MAX_SECURE_REPLAY_RECORDS_V4,
  MAX_SECURE_RETIRED_TOMBSTONES_V4,
  advanceSecureRelayV4,
  createSecureRelayStateV4,
  disconnectSecureRelayDeviceV4,
  exportSecureRelayStateV4,
  getSecureRelayDeviceSignatureKeyV4,
  importSecureRelayStateV4,
  nextSecureRelayDeadlineV4,
  parseSecureClientFrameV4,
  reduceSecureRelayV4,
  type SecureApplicationRelayFrameV4,
  type SecureCommitRelayFrameV4,
  type SecureHostTransferAcceptRelayFrameV4,
  type SecureLogicalOrderGrantV4,
  type SecureRelayActorV4,
  type SecureRelayEffectV4,
  type SecureRelayStateV4,
  type SecureRelayTransitionV4,
} from "../src/secureRelayV4";
import type { SecureRelayEnvelopeV4 } from "../src/protocolV4";
import { ROOM_INVITATION_AUTH_KDF_V4 } from "../src/roomInvitationAuthV4";
import {
  roomInvitationKeyPackageDigestV4,
  type RoomInvitationMemberBindingModeV4,
  type RoomInvitationMemberBindingV4,
} from "../src/roomInvitationMemberBindingV4";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function idFactory(seed = 1) {
  let next = seed;
  return (bytes = 16): string => {
    const value = new Uint8Array(bytes);
    new DataView(value.buffer).setUint32(bytes - 4, next++);
    return base64Url(value);
  };
}

interface TestClock { now: number }

function tick(clock: TestClock, milliseconds = 1): number {
  clock.now += milliseconds;
  return clock.now;
}

function actor(
  deviceId: string,
  connectionId: string,
  authentication: "invitation" | "device" = "device",
): SecureRelayActorV4 {
  return { deviceId, connectionId, authentication };
}

function hello(roomInstance: string, deviceId: string, keyPackage: string) {
  return { v: 4 as const, suite: 1 as const, roomInstance, deviceId, keyPackage };
}

async function memberBinding(
  mode: RoomInvitationMemberBindingModeV4,
  roomInstance: string,
  deviceId: string,
  admissionId: string,
  signaturePublicKey: string,
  keyPackage: string,
  ids: ReturnType<typeof idFactory>,
): Promise<RoomInvitationMemberBindingV4> {
  return {
    v: 4,
    kdf: ROOM_INVITATION_AUTH_KDF_V4,
    mode,
    roomId: "relay-1",
    roomInstance,
    deviceId,
    admissionId,
    signaturePublicKey,
    keyPackageDigest: await roomInvitationKeyPackageDigestV4(keyPackage),
    proof: ids(64),
  };
}

function envelope(
  roomInstance: string,
  messageId: string,
  route: "host" | "group" | "device",
  payload: string,
  to?: string,
): SecureRelayEnvelopeV4 {
  return to === undefined
    ? { v: 4, suite: 1, roomInstance, messageId, route, payload }
    : { v: 4, suite: 1, roomInstance, messageId, route, to, payload };
}

function accepted(result: SecureRelayTransitionV4): Extract<SecureRelayTransitionV4, { ok: true }> {
  if (!result.ok) throw new Error(`expected accepted transition, got ${result.code}`);
  return result;
}

function rejected(result: SecureRelayTransitionV4, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

function effect<T extends SecureRelayEffectV4["type"]>(
  effects: SecureRelayEffectV4[],
  type: T,
): Extract<SecureRelayEffectV4, { type: T }> {
  const found = effects.find((candidate) => candidate.type === type);
  if (!found) throw new Error(`missing ${type} effect`);
  return found as Extract<SecureRelayEffectV4, { type: T }>;
}

function backlogId(entry: SecureRelayStateV4["members"][number]["backlog"][number]): string {
  if (entry.kind === "relay") return entry.frame.envelope.messageId;
  if (entry.kind === "application-result" || entry.kind === "commit-result") return entry.messageId;
  return entry.authorizationId;
}

function saturateMemberBacklog(
  state: SecureRelayStateV4,
  deviceId: string,
  ids: ReturnType<typeof idFactory>,
  receivedAt: number,
): void {
  const member = state.members.find((candidate) => candidate.deviceId === deviceId);
  if (!member) throw new Error("missing member to saturate");
  const entries: SecureRelayStateV4["members"][number]["backlog"] = Array.from(
    { length: MAX_SECURE_DEVICE_BACKLOG_ENTRIES_V4 },
    () => {
      const messageId = ids();
      state.recentMessages.push({
        id: messageId,
        kind: "commit",
        deviceId,
        acceptedAt: receivedAt,
        logicalOrder: null,
        rejectionReason: null,
        frameDigest: ids(32),
      });
      return {
      kind: "commit-result" as const,
      receivedAt,
      logicalOrder: null,
      messageId,
      result: "accepted" as const,
      reason: null,
      };
    },
  );
  member.backlog = entries;
  member.backlogBytes = entries.reduce(
    (total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength,
    0,
  );
}

async function setupRoom(ids = idFactory(), clock: TestClock = { now: 1_000 }) {
  const roomInstance = ids();
  const hostDeviceId = ids();
  const hostConnectionId = ids();
  const host = actor(hostDeviceId, hostConnectionId, "invitation");
  const signaturePublicKey = ids(32);
  const hostKeyPackage = ids(8);
  const requestId = ids();
  const result = accepted(await createSecureRelayStateV4(host, {
    kind: "setup",
    requestId,
    signaturePublicKey,
    hello: hello(roomInstance, hostDeviceId, hostKeyPackage),
    memberBinding: await memberBinding(
      "founder", roomInstance, hostDeviceId, requestId, signaturePublicKey, hostKeyPackage, ids,
    ),
  }, clock.now));
  return {
    ids, clock, roomInstance, host, hostSignaturePublicKey: signaturePublicKey, hostKeyPackage, state: result.state,
  };
}

async function requestGrant(
  state: SecureRelayStateV4,
  requestingActor: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
) {
  const result = accepted(await reduceSecureRelayV4(state, requestingActor, {
    kind: "order-request",
    v: 4,
    suite: 1,
    roomInstance: state.roomInstance,
    requestId: ids(),
  }, { now: tick(clock), nextGrantTokenId: ids() }));
  return { state: result.state, grant: effect(result.effects, "order-granted").grant };
}

async function ackThrough(
  state: SecureRelayStateV4,
  acknowledgingActor: SecureRelayActorV4,
  lastMessageId: string,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
): Promise<SecureRelayStateV4> {
  return accepted(await reduceSecureRelayV4(state, acknowledgingActor, {
    kind: "delivery-ack",
    v: 4,
    suite: 1,
    roomInstance: state.roomInstance,
    requestId: ids(),
    lastMessageId,
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
}

async function ackAll(
  stateValue: SecureRelayStateV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
): Promise<SecureRelayStateV4> {
  let state = stateValue;
  for (const snapshotMember of [...state.members]) {
    const member = state.members.find((candidate) => candidate.deviceId === snapshotMember.deviceId);
    if (!member?.connectionId || member.backlog.length === 0
      || (member.status !== "active" && member.status !== "pending")) continue;
    state = await ackThrough(
      state,
      actor(member.deviceId, member.connectionId),
      backlogId(member.backlog[member.backlog.length - 1]),
      ids,
      clock,
    );
  }
  return state;
}

async function removeCurrentZombie(
  stateValue: SecureRelayStateV4,
  host: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
): Promise<SecureRelayStateV4> {
  let state = await ackAll(stateValue, ids, clock);
  const marker = state.pendingZombieRemovals[0];
  if (!marker) throw new Error("missing zombie marker");
  const order = await requestGrant(state, host, ids, clock);
  state = order.state;
  const commitMessageId = ids();
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay", relayKind: "commit", grant: order.grant,
    retirementDeviceId: marker.deviceId,
    retirementAdmissionCommitMessageId: marker.admissionCommitMessageId,
    envelope: envelope(state.roomInstance, commitMessageId, "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  state = await ackAll(state, ids, clock);
  return accepted(await reduceSecureRelayV4(state, host, {
    kind: "retire-member", v: 4, suite: 1, roomInstance: state.roomInstance,
    requestId: ids(), deviceId: marker.deviceId, commitMessageId,
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
}

async function prepareAdmission(
  stateValue: SecureRelayStateV4,
  host: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
  exerciseWrongProofGrant = false,
) {
  let state = stateValue;
  const guest = actor(ids(), ids(), "invitation");
  const signaturePublicKey = ids(32);
  const admissionId = ids();
  const keyPackage = ids(8);
  state = accepted(await reduceSecureRelayV4(state, guest, {
    kind: "join",
    requestId: admissionId,
    signaturePublicKey,
    hello: hello(state.roomInstance, guest.deviceId, keyPackage),
    memberBinding: await memberBinding(
      "admission", state.roomInstance, guest.deviceId, admissionId, signaturePublicKey, keyPackage, ids,
    ),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;

  const addOrder = await requestGrant(state, host, ids, clock);
  state = addOrder.state;
  const commitMessageId = ids();
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay",
    relayKind: "commit",
    grant: addOrder.grant,
    admissionId,
    envelope: envelope(state.roomInstance, commitMessageId, "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  state = await ackAll(state, ids, clock);

  const welcomeMessageId = ids();
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay",
    relayKind: "welcome",
    admissionId,
    commitMessageId,
    envelope: envelope(state.roomInstance, welcomeMessageId, "device", ids(8), guest.deviceId),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;

  const bootstrapOrder = await requestGrant(state, host, ids, clock);
  state = bootstrapOrder.state;
  const bootstrapMessageId = ids();
  const bootstrapped = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay",
    relayKind: "bootstrap",
    admissionId,
    welcomeMessageId,
    grant: bootstrapOrder.grant,
    envelope: envelope(state.roomInstance, bootstrapMessageId, "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() }));
  state = bootstrapped.state;
  const proofGrant = effect(bootstrapped.effects, "order-granted").grant;
  state = await ackAll(state, ids, clock);

  const proofMessageId = ids();
  if (exerciseWrongProofGrant) {
    const forgedGrant = { ...proofGrant, tokenId: ids() };
    rejected(await reduceSecureRelayV4(state, guest, {
      kind: "relay",
      relayKind: "join-proof",
      admissionId,
      welcomeMessageId,
      grant: forgedGrant,
      envelope: envelope(state.roomInstance, proofMessageId, "group", ids(8)),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "invalid-admission");
  }
  state = accepted(await reduceSecureRelayV4(state, guest, {
    kind: "relay",
    relayKind: "join-proof",
    admissionId,
    welcomeMessageId,
    grant: proofGrant,
    envelope: envelope(state.roomInstance, proofMessageId, "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;

  return {
    state,
    guest,
    signaturePublicKey,
    admissionId,
    commitMessageId,
    welcomeMessageId,
    bootstrapMessageId,
    proofMessageId,
    proofGrant,
  };
}

type PendingAdmissionPhase = "pre-add" | "awaiting-welcome" | "awaiting-bootstrap"
  | "awaiting-proof" | "awaiting-activation";

async function pendingAdmissionAtPhase(
  stateValue: SecureRelayStateV4,
  host: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
  phase: PendingAdmissionPhase,
) {
  let state = stateValue;
  const guest = actor(ids(), ids(), "invitation");
  const signaturePublicKey = ids(32);
  const admissionId = ids();
  const keyPackage = ids(8);
  state = accepted(await reduceSecureRelayV4(state, guest, {
    kind: "join", requestId: admissionId, signaturePublicKey,
    hello: hello(state.roomInstance, guest.deviceId, keyPackage),
    memberBinding: await memberBinding(
      "admission", state.roomInstance, guest.deviceId, admissionId, signaturePublicKey, keyPackage, ids,
    ),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  if (phase === "pre-add") return { state, guest, admissionId, commitMessageId: null };

  const addOrder = await requestGrant(state, host, ids, clock);
  state = addOrder.state;
  const commitMessageId = ids();
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay", relayKind: "commit", grant: addOrder.grant, admissionId,
    envelope: envelope(state.roomInstance, commitMessageId, "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  state = await ackAll(state, ids, clock);
  if (phase === "awaiting-welcome") return { state, guest, admissionId, commitMessageId };

  const welcomeMessageId = ids();
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay", relayKind: "welcome", admissionId, commitMessageId,
    envelope: envelope(state.roomInstance, welcomeMessageId, "device", ids(8), guest.deviceId),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  if (phase === "awaiting-bootstrap") return { state, guest, admissionId, commitMessageId };

  const bootstrapOrder = await requestGrant(state, host, ids, clock);
  state = bootstrapOrder.state;
  const bootstrapped = accepted(await reduceSecureRelayV4(state, host, {
    kind: "relay", relayKind: "bootstrap", admissionId, welcomeMessageId,
    grant: bootstrapOrder.grant,
    envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() }));
  state = await ackAll(bootstrapped.state, ids, clock);
  if (phase === "awaiting-proof") return { state, guest, admissionId, commitMessageId };

  const proofGrant = effect(bootstrapped.effects, "order-granted").grant;
  state = accepted(await reduceSecureRelayV4(state, guest, {
    kind: "relay", relayKind: "join-proof", admissionId, welcomeMessageId,
    grant: proofGrant,
    envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  return { state, guest, admissionId, commitMessageId };
}

async function admitMember(
  stateValue: SecureRelayStateV4,
  host: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
  exerciseWrongProofGrant = false,
) {
  const prepared = await prepareAdmission(stateValue, host, ids, clock, exerciseWrongProofGrant);
  let state = prepared.state;
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "activate",
    v: 4,
    suite: 1,
    roomInstance: state.roomInstance,
    requestId: ids(),
    deviceId: prepared.guest.deviceId,
    admissionId: prepared.admissionId,
    proofMessageId: prepared.proofMessageId,
    signaturePublicKey: prepared.signaturePublicKey,
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  state = await ackAll(state, ids, clock);
  return { ...prepared, state };
}

function applicationFrame(
  state: SecureRelayStateV4,
  grant: SecureLogicalOrderGrantV4,
  ids: ReturnType<typeof idFactory>,
): SecureApplicationRelayFrameV4 {
  return {
    kind: "relay",
    relayKind: "application",
    grant,
    envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
  };
}

describe("protocol-v4 strict wire and admission authorization", () => {
  it("binds each relayed KeyPackage to the immutable invitation-authorized member context", async () => {
    const { ids, clock, state } = await setupRoom();
    const guest = actor(ids(), ids(), "invitation");
    const requestId = ids();
    const signaturePublicKey = ids(32);
    const keyPackage = ids(8);
    const binding = await memberBinding(
      "admission", state.roomInstance, guest.deviceId, requestId, signaturePublicKey, keyPackage, ids,
    );
    const frame = {
      kind: "join" as const,
      requestId,
      signaturePublicKey,
      hello: hello(state.roomInstance, guest.deviceId, keyPackage),
      memberBinding: binding,
    };

    rejected(await reduceSecureRelayV4(state, guest, {
      ...frame,
      hello: { ...frame.hello, keyPackage: ids(8) },
    }, { now: tick(clock), nextGrantTokenId: ids() }), "invalid-frame");
    expect(parseSecureClientFrameV4({
      ...frame,
      signaturePublicKey: ids(32),
    })).toBeNull();

    const joined = accepted(await reduceSecureRelayV4(state, guest, frame, {
      now: tick(clock), nextGrantTokenId: ids(),
    }));
    expect(effect(joined.effects, "deliver-key-package").memberBinding).toEqual(binding);
    const persisted = JSON.parse(exportSecureRelayStateV4(joined.state)) as SecureRelayStateV4;
    persisted.members[1].memberBinding = {
      ...persisted.members[1].memberBinding,
      signaturePublicKey: ids(32),
    };
    expect(importSecureRelayStateV4(JSON.stringify(persisted))).toBeNull();
  });

  it("rejects ambiguous transfer/application frames, unsigned joins, and fabricated proof grants", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const grant: SecureLogicalOrderGrantV4 = {
      v: 4,
      suite: 1,
      roomInstance: initial.roomInstance,
      requestId: ids(),
      tokenId: ids(),
      deviceId: host.deviceId,
      logicalOrder: 1,
      expiresAt: 9_999,
    };
    expect(parseSecureClientFrameV4({
      kind: "join",
      requestId: ids(),
      hello: hello(initial.roomInstance, ids(), ids(8)),
    })).toBeNull();
    expect(parseSecureClientFrameV4({
      ...applicationFrame(initial, grant, ids),
      authorizationId: ids(),
    })).toBeNull();
    expect(parseSecureClientFrameV4({
      kind: "relay",
      relayKind: "host-transfer-accept",
      grant,
      envelope: envelope(initial.roomInstance, ids(), "group", ids(8)),
    })).toBeNull();
    expect(parseSecureClientFrameV4({
      kind: "transfer-host",
      v: 4,
      suite: 1,
      roomInstance: initial.roomInstance,
      requestId: ids(),
    })).toBeNull();

    const admitted = await admitMember(initial, host, ids, clock, true);
    expect(getSecureRelayDeviceSignatureKeyV4(admitted.state, admitted.guest.deviceId))
      .toBe(admitted.signaturePublicKey);
    expect(admitted.state.nextLogicalOrder).toBe(3);
    expect(admitted.state.members.find((member) => member.deviceId === admitted.guest.deviceId)
      ?.membershipCommitMessageId).toBe(admitted.commitMessageId);
  });

  it("binds activation to the immutable join credential key", async () => {
    const { ids, clock, host, state } = await setupRoom();
    const pending = await prepareAdmission(state, host, ids, clock);
    rejected(await reduceSecureRelayV4(pending.state, host, {
      kind: "activate",
      v: 4,
      suite: 1,
      roomInstance: pending.state.roomInstance,
      requestId: ids(),
      deviceId: pending.guest.deviceId,
      admissionId: pending.admissionId,
      proofMessageId: pending.proofMessageId,
      signaturePublicKey: ids(32),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "invalid-admission");
  });

  it("fingerprints every encrypted relay retry, not only commits", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    let state = initial;
    const guest = actor(ids(), ids(), "invitation");
    const admissionId = ids();
    const signaturePublicKey = ids(32);
    const keyPackage = ids(8);
    state = accepted(await reduceSecureRelayV4(state, guest, {
      kind: "join", requestId: admissionId, signaturePublicKey,
      hello: hello(state.roomInstance, guest.deviceId, keyPackage),
      memberBinding: await memberBinding(
        "admission", state.roomInstance, guest.deviceId, admissionId,
        signaturePublicKey, keyPackage, ids,
      ),
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;

    const addOrder = await requestGrant(state, host, ids, clock);
    state = addOrder.state;
    const add = {
      kind: "relay" as const, relayKind: "commit" as const, grant: addOrder.grant, admissionId,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    state = accepted(await reduceSecureRelayV4(state, host, add, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    rejected(await reduceSecureRelayV4(state, host, {
      ...add, envelope: { ...add.envelope, payload: ids(8) },
    }, { now: tick(clock), nextGrantTokenId: ids() }), "duplicate-id");
    state = await ackAll(state, ids, clock);

    const welcome = {
      kind: "relay" as const, relayKind: "welcome" as const,
      admissionId, commitMessageId: add.envelope.messageId,
      envelope: envelope(state.roomInstance, ids(), "device", ids(8), guest.deviceId),
    };
    state = accepted(await reduceSecureRelayV4(state, host, welcome, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    expect(effect(accepted(await reduceSecureRelayV4(state, host, welcome, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).effects, "frame-accepted").messageId).toBe(welcome.envelope.messageId);
    rejected(await reduceSecureRelayV4(state, host, {
      ...welcome, envelope: { ...welcome.envelope, payload: ids(8) },
    }, { now: tick(clock), nextGrantTokenId: ids() }), "duplicate-id");

    const bootstrapOrder = await requestGrant(state, host, ids, clock);
    state = bootstrapOrder.state;
    const bootstrap = {
      kind: "relay" as const, relayKind: "bootstrap" as const,
      admissionId, welcomeMessageId: welcome.envelope.messageId, grant: bootstrapOrder.grant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    const bootstrapped = accepted(await reduceSecureRelayV4(state, host, bootstrap, {
      now: tick(clock), nextGrantTokenId: ids(),
    }));
    state = bootstrapped.state;
    const proofGrant = effect(bootstrapped.effects, "order-granted").grant;
    rejected(await reduceSecureRelayV4(state, host, {
      ...bootstrap, envelope: { ...bootstrap.envelope, payload: ids(8) },
    }, { now: tick(clock), nextGrantTokenId: ids() }), "duplicate-id");
    state = await ackAll(state, ids, clock);

    const proof = {
      kind: "relay" as const, relayKind: "join-proof" as const,
      admissionId, welcomeMessageId: welcome.envelope.messageId, grant: proofGrant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    state = accepted(await reduceSecureRelayV4(state, guest, proof, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    rejected(await reduceSecureRelayV4(state, guest, {
      ...proof, envelope: { ...proof.envelope, payload: ids(8) },
    }, { now: tick(clock), nextGrantTokenId: ids() }), "duplicate-id");

    const applicationSetup = await setupRoom(ids, clock);
    state = applicationSetup.state;
    const applicationOrder = await requestGrant(state, applicationSetup.host, ids, clock);
    state = applicationOrder.state;
    const application = applicationFrame(state, applicationOrder.grant, ids);
    state = accepted(await reduceSecureRelayV4(state, applicationSetup.host, application, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    rejected(await reduceSecureRelayV4(state, applicationSetup.host, {
      ...application, envelope: { ...application.envelope, payload: ids(8) },
    }, { now: tick(clock), nextGrantTokenId: ids() }), "duplicate-id");
  });
});

describe("protocol-v4 cryptographic admission barrier", () => {
  it("cancels work queued behind an Add commit and blocks every non-admission grant", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const active = await admitMember(initial, host, ids, clock);
    let state = active.state;
    const pending = actor(ids(), ids(), "invitation");
    const admissionId = ids();
    const signaturePublicKey = ids(32);
    const keyPackage = ids(8);
    state = accepted(await reduceSecureRelayV4(state, pending, {
      kind: "join", requestId: admissionId, signaturePublicKey,
      hello: hello(state.roomInstance, pending.deviceId, keyPackage),
      memberBinding: await memberBinding(
        "admission", state.roomInstance, pending.deviceId, admissionId, signaturePublicKey, keyPackage, ids,
      ),
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    const addOrder = await requestGrant(state, host, ids, clock);
    state = addOrder.state;
    const queuedRequestId = ids();
    state = accepted(await reduceSecureRelayV4(state, active.guest, {
      kind: "order-request", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: queuedRequestId,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    const added = accepted(await reduceSecureRelayV4(state, host, {
      kind: "relay", relayKind: "commit", grant: addOrder.grant, admissionId,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = added.state;
    expect(state.orderQueue).toEqual([]);
    expect(added.effects).toContainEqual({
      type: "order-cancelled", deviceId: active.guest.deviceId,
      requestId: queuedRequestId, reason: "admission-pending",
    });
    const blockedRequestId = ids();
    const blocked = accepted(await reduceSecureRelayV4(state, active.guest, {
      kind: "order-request", v: 4, suite: 1,
      roomInstance: state.roomInstance, requestId: blockedRequestId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(effect(blocked.effects, "order-cancelled")).toEqual({
      type: "order-cancelled", deviceId: active.guest.deviceId,
      requestId: blockedRequestId, reason: "admission-pending",
    });
  });

  it("cannot route an application or unrelated commit at any post-Add phase", async () => {
    for (const phase of [
      "awaiting-welcome", "awaiting-bootstrap", "awaiting-proof", "awaiting-activation",
    ] as const) {
      const setup = await setupRoom();
      const prepared = await pendingAdmissionAtPhase(
        setup.state, setup.host, setup.ids, setup.clock, phase,
      );
      let state = prepared.state;
      if (phase === "awaiting-bootstrap") {
        const order = await requestGrant(state, setup.host, setup.ids, setup.clock);
        state = order.state;
        rejected(await reduceSecureRelayV4(state, setup.host, applicationFrame(state, order.grant, setup.ids), {
          now: tick(setup.clock), nextGrantTokenId: setup.ids(),
        }), "admission-pending");
        rejected(await reduceSecureRelayV4(state, setup.host, {
          kind: "relay", relayKind: "commit", grant: order.grant,
          envelope: envelope(state.roomInstance, setup.ids(), "group", setup.ids(8)),
        }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }), "admission-pending");
      } else {
        const blockedRequestId = setup.ids();
        const blocked = accepted(await reduceSecureRelayV4(state, setup.host, {
          kind: "order-request", v: 4, suite: 1,
          roomInstance: state.roomInstance, requestId: blockedRequestId,
        }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
        expect(effect(blocked.effects, "order-cancelled")).toMatchObject({
          requestId: blockedRequestId, reason: "admission-pending",
        });
      }
    }
  });

  it("retires pending admissions at every phase and queues removal for every accepted Add", async () => {
    for (const phase of [
      "pre-add", "awaiting-welcome", "awaiting-bootstrap", "awaiting-proof", "awaiting-activation",
    ] as const) {
      const setup = await setupRoom();
      const active = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
      let state = accepted(disconnectSecureRelayDeviceV4(active.state, active.guest, {
        now: tick(setup.clock), nextGrantTokenId: setup.ids(),
      })).state;
      const deadline = state.members.find((member) => member.deviceId === active.guest.deviceId)!.disconnectExpiresAt!;
      const prepared = await pendingAdmissionAtPhase(
        state, setup.host, setup.ids, setup.clock, phase,
      );
      state = prepared.state;
      const expired = accepted(advanceSecureRelayV4(state, {
        now: deadline, nextGrantTokenId: setup.ids(),
      }));
      setup.clock.now = deadline;
      state = expired.state;
      const cancelled = state.members.find((member) => member.deviceId === prepared.guest.deviceId)!;
      expect(cancelled.status).toBe("retired");
      expect(cancelled.admissionId).toBeNull();
      expect(state.pendingZombieRemovals.map((marker) => marker.deviceId)).toEqual(
        prepared.commitMessageId === null
          ? [active.guest.deviceId]
          : [active.guest.deviceId, prepared.guest.deviceId],
      );
      while (state.pendingZombieRemovals.length !== 0) {
        state = await removeCurrentZombie(state, setup.host, setup.ids, setup.clock);
      }
      expect(state.pendingZombieRemovals).toEqual([]);
    }
  });

  it("accepts the causal bootstrap before overflow cleanup without granting a retired admission", async () => {
    const setup = await setupRoom();
    const first = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    const second = await admitMember(first.state, setup.host, setup.ids, setup.clock);
    let state = accepted(disconnectSecureRelayDeviceV4(second.state, second.guest, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    const pending = await pendingAdmissionAtPhase(
      state, setup.host, setup.ids, setup.clock, "awaiting-bootstrap",
    );
    state = pending.state;
    saturateMemberBacklog(state, second.guest.deviceId, setup.ids, setup.clock.now);
    const order = await requestGrant(state, setup.host, setup.ids, setup.clock);
    state = order.state;
    const bootstrapMessageId = setup.ids();
    const bootstrapped = accepted(await reduceSecureRelayV4(state, setup.host, {
      kind: "relay",
      relayKind: "bootstrap",
      admissionId: pending.admissionId,
      welcomeMessageId: state.members.find((member) =>
        member.deviceId === pending.guest.deviceId)!.welcomeMessageId!,
      grant: order.grant,
      envelope: envelope(state.roomInstance, bootstrapMessageId, "group", setup.ids(8)),
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));

    const routeIndex = bootstrapped.effects.findIndex((candidate) =>
      candidate.type === "route-relay" && candidate.frame.envelope.messageId === bootstrapMessageId);
    const barrierIndex = bootstrapped.effects.findIndex((candidate) =>
      candidate.type === "zombie-removal-required");
    expect(routeIndex).toBeGreaterThanOrEqual(0);
    expect(routeIndex).toBeLessThan(barrierIndex);
    expect(bootstrapped.effects.some((candidate) => candidate.type === "order-granted"
      && candidate.toDeviceId === pending.guest.deviceId)).toBe(false);
    const retiredPending = bootstrapped.state.members.find((member) =>
      member.deviceId === pending.guest.deviceId)!;
    expect(retiredPending.status).toBe("retired");
    expect(retiredPending.backlog).toEqual([]);
    expect(bootstrapped.state.pendingZombieRemovals.map((marker) => marker.deviceId)).toEqual([
      second.guest.deviceId,
      pending.guest.deviceId,
    ]);
    expect(importSecureRelayStateV4(exportSecureRelayStateV4(bootstrapped.state))).not.toBeNull();
  });
});

describe("protocol-v4 durable delivery and takeover", () => {
  it("durably cancels an immediate order request blocked by unacknowledged delivery", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    const hostOrder = await requestGrant(admitted.state, setup.host, setup.ids, setup.clock);
    const application = applicationFrame(hostOrder.state, hostOrder.grant, setup.ids);
    let state = accepted(await reduceSecureRelayV4(hostOrder.state, setup.host, application, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    const guestBacklog = state.members.find((member) =>
      member.deviceId === admitted.guest.deviceId)!.backlog;
    expect(guestBacklog).toHaveLength(1);

    const requestId = setup.ids();
    const cancelled = accepted(await reduceSecureRelayV4(state, admitted.guest, {
      kind: "order-request", v: 4, suite: 1,
      roomInstance: state.roomInstance, requestId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    state = cancelled.state;
    expect(effect(cancelled.effects, "order-cancelled")).toEqual({
      type: "order-cancelled", deviceId: admitted.guest.deviceId,
      requestId, reason: "delivery-pending",
    });
    expect(state.recentMessages.find((record) => record.id === requestId)).toMatchObject({
      kind: "order-cancelled", deviceId: admitted.guest.deviceId,
      rejectionReason: "delivery-pending",
    });

    state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;
    const retried = accepted(await reduceSecureRelayV4(state, admitted.guest, {
      kind: "order-request", v: 4, suite: 1,
      roomInstance: state.roomInstance, requestId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    expect(effect(retried.effects, "order-cancelled")).toMatchObject({
      requestId, reason: "delivery-pending",
    });
    rejected(await reduceSecureRelayV4(state, setup.host, {
      kind: "order-request", v: 4, suite: 1,
      roomInstance: state.roomInstance, requestId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }), "duplicate-id");
  });

  it("persists every active/disconnected delivery and ACKs only an exact queue prefix", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    let state = admitted.state;
    const oldGuest = admitted.guest;
    state = accepted(disconnectSecureRelayDeviceV4(state, oldGuest, { now: tick(clock), nextGrantTokenId: ids() })).state;

    const commitOrder = await requestGrant(state, host, ids, clock);
    state = commitOrder.state;
    const commit: SecureCommitRelayFrameV4 = {
      kind: "relay",
      relayKind: "commit",
      grant: commitOrder.grant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    state = accepted(await reduceSecureRelayV4(state, host, commit, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    state = await ackAll(state, ids, clock);

    const appOrder = await requestGrant(state, host, ids, clock);
    state = appOrder.state;
    const app = applicationFrame(state, appOrder.grant, ids);
    state = accepted(await reduceSecureRelayV4(state, host, app, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    state = await ackAll(state, ids, clock);

    const persisted = importSecureRelayStateV4(exportSecureRelayStateV4(state));
    expect(persisted).not.toBeNull();
    state = persisted!;
    const queued = state.members.find((member) => member.deviceId === oldGuest.deviceId)!.backlog;
    expect(queued.map((entry) => entry.kind)).toEqual(["relay", "relay"]);

    const resumedGuest = actor(oldGuest.deviceId, ids(), "device");
    const resumed = accepted(await reduceSecureRelayV4(state, resumedGuest, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: oldGuest.deviceId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = resumed.state;
    expect(effect(resumed.effects, "replay-backlog").entries).toHaveLength(2);
    rejected(await reduceSecureRelayV4(state, resumedGuest, {
      kind: "order-request", v: 4, suite: 1, roomInstance: state.roomInstance, requestId: ids(),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "active-member-required");

    const firstId = backlogId(queued[0]);
    state = await ackThrough(state, resumedGuest, firstId, ids, clock);
    expect(state.members.find((member) => member.deviceId === resumedGuest.deviceId)?.status).toBe("pending");
    expect(state.members.find((member) => member.deviceId === resumedGuest.deviceId)?.backlog).toHaveLength(1);
    state = accepted(await reduceSecureRelayV4(state, resumedGuest, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), lastMessageId: backlogId(queued[1]),
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    expect(state.members.find((member) => member.deviceId === resumedGuest.deviceId)?.status).toBe("active");

    rejected(disconnectSecureRelayDeviceV4(state, oldGuest, {
      now: tick(clock), nextGrantTokenId: ids(),
    }), "connection-mismatch");
  });

  it("replaces a still-active stale connection after device-proof resume", async () => {
    const { ids, clock, host, state } = await setupRoom();
    const replacement = actor(host.deviceId, ids(), "device");
    const resumed = accepted(await reduceSecureRelayV4(state, replacement, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: host.deviceId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(resumed.state.members[0].connectionId).toBe(replacement.connectionId);
    rejected(disconnectSecureRelayDeviceV4(resumed.state, host, {
      now: tick(clock), nextGrantTokenId: ids(),
    }), "connection-mismatch");
  });

  it("durably cancels a connection-bound grant so a resumed outbox cannot deadlock", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    const order = await requestGrant(admitted.state, admitted.guest, setup.ids, setup.clock);
    const staleFrame = applicationFrame(order.state, order.grant, setup.ids);
    let state = accepted(disconnectSecureRelayDeviceV4(order.state, admitted.guest, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;
    const resumedGuest = actor(admitted.guest.deviceId, setup.ids(), "device");
    const resumed = accepted(await reduceSecureRelayV4(state, resumedGuest, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(), deviceId: resumedGuest.deviceId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    state = accepted(await reduceSecureRelayV4(resumed.state, resumedGuest, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(), lastMessageId: effect(resumed.effects, "backlog-end").lastMessageId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    const recovered = accepted(await reduceSecureRelayV4(state, resumedGuest, staleFrame, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    }));
    expect(effect(recovered.effects, "order-cancelled")).toEqual({
      type: "order-cancelled",
      deviceId: resumedGuest.deviceId,
      requestId: order.grant.requestId,
      reason: "connection-lost",
    });
  });

  it("replays the exact pre-barrier backlog, marker, removal commit, snapshot, then end", async () => {
    const setup = await setupRoom();
    const doomed = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    const observerAdmission = await admitMember(doomed.state, setup.host, setup.ids, setup.clock);
    let state = accepted(disconnectSecureRelayDeviceV4(
      observerAdmission.state,
      doomed.guest,
      { now: tick(setup.clock), nextGrantTokenId: setup.ids() },
    )).state;
    const deadline = state.members.find((member) =>
      member.deviceId === doomed.guest.deviceId)!.disconnectExpiresAt!;
    state = accepted(disconnectSecureRelayDeviceV4(
      state,
      observerAdmission.guest,
      { now: tick(setup.clock, 100), nextGrantTokenId: setup.ids() },
    )).state;

    const oldOrder = await requestGrant(state, setup.host, setup.ids, setup.clock);
    state = oldOrder.state;
    const oldApplication = applicationFrame(state, oldOrder.grant, setup.ids);
    state = accepted(await reduceSecureRelayV4(state, setup.host, oldApplication, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    state = await ackAll(state, setup.ids, setup.clock);

    const expired = accepted(advanceSecureRelayV4(state, {
      now: deadline, nextGrantTokenId: setup.ids(),
    }));
    setup.clock.now = deadline;
    state = expired.state;
    const marker = state.pendingZombieRemovals[0];
    const removalOrder = await requestGrant(state, setup.host, setup.ids, setup.clock);
    state = removalOrder.state;
    const removalMessageId = setup.ids();
    state = accepted(await reduceSecureRelayV4(state, setup.host, {
      kind: "relay", relayKind: "commit", grant: removalOrder.grant,
      retirementDeviceId: marker.deviceId,
      retirementAdmissionCommitMessageId: marker.admissionCommitMessageId,
      envelope: envelope(state.roomInstance, removalMessageId, "group", setup.ids(8)),
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    state = await ackAll(state, setup.ids, setup.clock);
    state = accepted(await reduceSecureRelayV4(state, setup.host, {
      kind: "retire-member", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(), deviceId: doomed.guest.deviceId, commitMessageId: removalMessageId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    expect(state.pendingZombieRemovals).toEqual([]);

    const resumedObserver = actor(observerAdmission.guest.deviceId, setup.ids(), "device");
    const resumed = accepted(await reduceSecureRelayV4(state, resumedObserver, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(), deviceId: resumedObserver.deviceId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    const ordered = resumed.effects.filter((candidate) =>
      candidate.type === "replay-backlog" || candidate.type === "zombie-removal-required"
        || candidate.type === "room-state-snapshot" || candidate.type === "backlog-end");
    expect(ordered.map((candidate) => candidate.type)).toEqual([
      "replay-backlog",
      "zombie-removal-required",
      "replay-backlog",
      "room-state-snapshot",
      "backlog-end",
    ]);
    const replaySegments = ordered.filter((candidate): candidate is Extract<
      SecureRelayEffectV4,
      { type: "replay-backlog" }
    > => candidate.type === "replay-backlog");
    expect(replaySegments[0].entries.map(backlogId)).toEqual([oldApplication.envelope.messageId]);
    expect(replaySegments[1].entries.map(backlogId)).toEqual([removalMessageId]);
    const snapshot = effect(resumed.effects, "room-state-snapshot");
    expect(snapshot.members.find((member) => member.deviceId === resumedObserver.deviceId)?.status).toBe("active");
    expect(effect(resumed.effects, "backlog-end").lastMessageId).toBe(removalMessageId);
  });

  it("reconciles missed activation from a no-backlog resume without preceding the Add", async () => {
    const setup = await setupRoom();
    const observerAdmission = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    const pending = await pendingAdmissionAtPhase(
      observerAdmission.state,
      setup.host,
      setup.ids,
      setup.clock,
      "awaiting-activation",
    );
    let state = pending.state;
    const pendingMember = state.members.find((member) => member.deviceId === pending.guest.deviceId)!;
    const activated = accepted(await reduceSecureRelayV4(state, setup.host, {
      kind: "activate", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(),
      deviceId: pending.guest.deviceId,
      admissionId: pending.admissionId,
      proofMessageId: pendingMember.proofMessageId!,
      signaturePublicKey: pendingMember.signaturePublicKey!,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    state = activated.state;
    const observer = state.members.find((member) => member.deviceId === observerAdmission.guest.deviceId)!;
    state = await ackThrough(
      state,
      observerAdmission.guest,
      backlogId(observer.backlog[observer.backlog.length - 1]),
      setup.ids,
      setup.clock,
    );
    expect(state.members.find((member) =>
      member.deviceId === observerAdmission.guest.deviceId)!.backlog).toEqual([]);
    state = accepted(disconnectSecureRelayDeviceV4(state, observerAdmission.guest, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    const resumedObserver = actor(observerAdmission.guest.deviceId, setup.ids(), "device");
    const resumeRequestId = setup.ids();
    const resumed = accepted(await reduceSecureRelayV4(state, resumedObserver, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: resumeRequestId, deviceId: resumedObserver.deviceId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    expect(resumed.effects.some((candidate) => candidate.type === "replay-backlog")).toBe(false);
    expect(resumed.state.members.find((member) => member.deviceId === resumedObserver.deviceId)?.status)
      .toBe("pending");
    const snapshot = effect(resumed.effects, "room-state-snapshot");
    expect(snapshot.members.find((member) => member.deviceId === pending.guest.deviceId)).toEqual({
      deviceId: pending.guest.deviceId,
      status: "active",
    });
    expect(effect(resumed.effects, "backlog-end").lastMessageId).toBe(resumeRequestId);
    rejected(await reduceSecureRelayV4(resumed.state, resumedObserver, {
      kind: "order-request", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(),
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }), "active-member-required");
    const completed = accepted(await reduceSecureRelayV4(resumed.state, resumedObserver, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(), lastMessageId: resumeRequestId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    expect(completed.state.members.find((member) => member.deviceId === resumedObserver.deviceId)?.status)
      .toBe("active");
  });
});

describe("protocol-v4 persisted-state integrity", () => {
  it("cross-links durable results and relays to their exact authenticated replay records", async () => {
    const appSetup = await setupRoom();
    const appOrder = await requestGrant(
      appSetup.state, appSetup.host, appSetup.ids, appSetup.clock,
    );
    const appFrame = applicationFrame(appOrder.state, appOrder.grant, appSetup.ids);
    const appState = accepted(await reduceSecureRelayV4(appOrder.state, appSetup.host, appFrame, {
      now: tick(appSetup.clock), nextGrantTokenId: appSetup.ids(),
    })).state;
    const appSerialized = exportSecureRelayStateV4(appState);

    const mislabeledResult = JSON.parse(appSerialized) as SecureRelayStateV4;
    const mislabeledRecord = mislabeledResult.recentMessages.find((record) =>
      record.id === appFrame.envelope.messageId)!;
    mislabeledRecord.kind = "application-rejected";
    mislabeledRecord.rejectionReason = "host-rejected";
    expect(importSecureRelayStateV4(JSON.stringify(mislabeledResult))).toBeNull();

    const wrongOrder = JSON.parse(appSerialized) as SecureRelayStateV4;
    wrongOrder.nextLogicalOrder += 1;
    const wrongOrderMember = wrongOrder.members.find((member) =>
      member.deviceId === appSetup.host.deviceId)!;
    const wrongOrderEntry = wrongOrderMember.backlog.find((entry) =>
      entry.kind === "application-result")!;
    if (wrongOrderEntry.kind !== "application-result") throw new Error("missing app result");
    wrongOrderEntry.logicalOrder += 1;
    wrongOrderMember.backlogBytes = wrongOrderMember.backlog.reduce(
      (total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength,
      0,
    );
    expect(importSecureRelayStateV4(JSON.stringify(wrongOrder))).toBeNull();

    const commitSetup = await setupRoom();
    const commitOrder = await requestGrant(
      commitSetup.state, commitSetup.host, commitSetup.ids, commitSetup.clock,
    );
    const commitFrame: SecureCommitRelayFrameV4 = {
      kind: "relay", relayKind: "commit", grant: commitOrder.grant,
      envelope: envelope(commitOrder.state.roomInstance, commitSetup.ids(), "group", commitSetup.ids(8)),
    };
    const commitState = accepted(await reduceSecureRelayV4(
      commitOrder.state, commitSetup.host, commitFrame,
      { now: tick(commitSetup.clock), nextGrantTokenId: commitSetup.ids() },
    )).state;
    const wrongCommitResult = JSON.parse(exportSecureRelayStateV4(commitState)) as SecureRelayStateV4;
    const wrongCommitRecord = wrongCommitResult.recentMessages.find((record) =>
      record.id === commitFrame.envelope.messageId)!;
    wrongCommitRecord.kind = "commit-rejected";
    wrongCommitRecord.rejectionReason = "host-rejected";
    expect(importSecureRelayStateV4(JSON.stringify(wrongCommitResult))).toBeNull();

    const relaySetup = await setupRoom();
    const first = await admitMember(
      relaySetup.state, relaySetup.host, relaySetup.ids, relaySetup.clock,
    );
    const second = await admitMember(
      first.state, relaySetup.host, relaySetup.ids, relaySetup.clock,
    );
    let relayState = accepted(disconnectSecureRelayDeviceV4(second.state, first.guest, {
      now: tick(relaySetup.clock), nextGrantTokenId: relaySetup.ids(),
    })).state;
    const relayOrder = await requestGrant(
      relayState, relaySetup.host, relaySetup.ids, relaySetup.clock,
    );
    const relayFrame = applicationFrame(relayOrder.state, relayOrder.grant, relaySetup.ids);
    relayState = accepted(await reduceSecureRelayV4(relayOrder.state, relaySetup.host, relayFrame, {
      now: tick(relaySetup.clock), nextGrantTokenId: relaySetup.ids(),
    })).state;
    const wrongSender = JSON.parse(exportSecureRelayStateV4(relayState)) as SecureRelayStateV4;
    const firstBacklog = wrongSender.members.find((member) =>
      member.deviceId === first.guest.deviceId)!.backlog;
    const relayed = firstBacklog.find((entry) => entry.kind === "relay"
      && entry.frame.envelope.messageId === relayFrame.envelope.messageId)!;
    if (relayed.kind !== "relay") throw new Error("missing relay entry");
    relayed.fromDeviceId = second.guest.deviceId;
    expect(importSecureRelayStateV4(JSON.stringify(wrongSender))).toBeNull();
  });

  it("retains admission provenance and exact host-transfer authorization links", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    const serialized = exportSecureRelayStateV4(admitted.state);
    const missingAdmission = JSON.parse(serialized) as SecureRelayStateV4;
    const guestBindingId = missingAdmission.members.find((member) =>
      member.deviceId === admitted.guest.deviceId)!.memberBinding.admissionId;
    missingAdmission.recentMessages = missingAdmission.recentMessages.filter((record) =>
      record.id !== guestBindingId);
    expect(importSecureRelayStateV4(JSON.stringify(missingAdmission))).toBeNull();

    const wrongFounderEstablishment = JSON.parse(serialized) as SecureRelayStateV4;
    wrongFounderEstablishment.members.find((member) =>
      member.deviceId === setup.host.deviceId)!.membershipCommitMessageId = admitted.commitMessageId;
    expect(importSecureRelayStateV4(JSON.stringify(wrongFounderEstablishment))).toBeNull();

    const offerOrder = await requestGrant(admitted.state, setup.host, setup.ids, setup.clock);
    const offer = applicationFrame(offerOrder.state, offerOrder.grant, setup.ids);
    let transferState = accepted(await reduceSecureRelayV4(offerOrder.state, setup.host, offer, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    transferState = await ackAll(transferState, setup.ids, setup.clock);
    transferState = accepted(await reduceSecureRelayV4(transferState, setup.host, {
      kind: "authorize-host-transfer", v: 4, suite: 1, roomInstance: transferState.roomInstance,
      requestId: setup.ids(), deviceId: admitted.guest.deviceId,
      offerMessageId: offer.envelope.messageId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    const wrongAuthorization = JSON.parse(
      exportSecureRelayStateV4(transferState),
    ) as SecureRelayStateV4;
    const target = wrongAuthorization.members.find((member) =>
      member.deviceId === admitted.guest.deviceId)!;
    const authorizationEntry = target.backlog.find((entry) =>
      entry.kind === "host-transfer-authorization")!;
    if (authorizationEntry.kind !== "host-transfer-authorization") {
      throw new Error("missing transfer authorization");
    }
    authorizationEntry.offerMessageId = setup.ids();
    target.backlogBytes = target.backlog.reduce(
      (total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength,
      0,
    );
    expect(importSecureRelayStateV4(JSON.stringify(wrongAuthorization))).toBeNull();
  });

  it("protects the exact empty-backlog resume sentinel across pruning and takeover", async () => {
    const setup = await setupRoom();
    while (setup.state.recentMessages.length < MAX_SECURE_REPLAY_RECORDS_V4) {
      setup.state.recentMessages.push({
        id: setup.ids(), kind: "setup-request", deviceId: setup.host.deviceId,
        acceptedAt: setup.state.clockHighWater, logicalOrder: null,
        rejectionReason: null, frameDigest: null,
      });
    }
    const legacy = JSON.parse(exportSecureRelayStateV4(setup.state)) as SecureRelayStateV4;
    delete (legacy.members[0] as unknown as Record<string, unknown>).resumeRequestId;
    expect(importSecureRelayStateV4(JSON.stringify(legacy))).not.toBeNull();

    const firstConnection = actor(setup.host.deviceId, setup.ids(), "device");
    const firstResumeId = setup.ids();
    const firstResume = accepted(await reduceSecureRelayV4(setup.state, firstConnection, {
      kind: "resume", v: 4, suite: 1, roomInstance: setup.state.roomInstance,
      requestId: firstResumeId, deviceId: setup.host.deviceId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    expect(firstResume.state.recentMessages).toHaveLength(MAX_SECURE_REPLAY_RECORDS_V4);
    expect(firstResume.state.recentMessages.some((record) => record.id === firstResumeId)).toBe(true);
    expect(effect(firstResume.effects, "backlog-end").lastMessageId).toBe(firstResumeId);

    const missingSentinel = JSON.parse(
      exportSecureRelayStateV4(firstResume.state),
    ) as SecureRelayStateV4;
    delete (missingSentinel.members[0] as unknown as Record<string, unknown>).resumeRequestId;
    expect(importSecureRelayStateV4(JSON.stringify(missingSentinel))).toBeNull();

    const secondConnection = actor(setup.host.deviceId, setup.ids(), "device");
    const secondResumeId = setup.ids();
    const secondResume = accepted(await reduceSecureRelayV4(firstResume.state, secondConnection, {
      kind: "resume", v: 4, suite: 1, roomInstance: setup.state.roomInstance,
      requestId: secondResumeId, deviceId: setup.host.deviceId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    rejected(await reduceSecureRelayV4(secondResume.state, secondConnection, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: setup.state.roomInstance,
      requestId: setup.ids(), lastMessageId: firstResumeId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }), "invalid-reference");
    const completed = accepted(await reduceSecureRelayV4(secondResume.state, secondConnection, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: setup.state.roomInstance,
      requestId: setup.ids(), lastMessageId: secondResumeId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    expect(completed.state.members[0].resumeRequestId).toBeNull();
    expect(completed.state.members[0].status).toBe("active");
  });
});

describe("protocol-v4 host-gated commits", () => {
  it("never routes or accepts a non-host commit until durable host approval", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    let state = admitted.state;
    const order = await requestGrant(state, admitted.guest, ids, clock);
    state = order.state;
    const commit: SecureCommitRelayFrameV4 = {
      kind: "relay",
      relayKind: "commit",
      grant: order.grant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    const submitted = accepted(await reduceSecureRelayV4(state, admitted.guest, commit, {
      now: tick(clock), nextGrantTokenId: ids(),
    }));
    state = submitted.state;
    expect(effect(submitted.effects, "commit-preview").fromDeviceId).toBe(admitted.guest.deviceId);
    expect(submitted.effects.some((candidate) => candidate.type === "route-relay")).toBe(false);
    expect(submitted.effects.some((candidate) => candidate.type === "frame-accepted"
      && candidate.messageId === commit.envelope.messageId)).toBe(false);
    expect(state.members.every((member) => member.backlog.length === 0)).toBe(true);
    expect(state.nextLogicalOrder).toBe(order.grant.logicalOrder);

    const retry = accepted(await reduceSecureRelayV4(state, admitted.guest, commit, {
      now: tick(clock), nextGrantTokenId: ids(),
    }));
    state = retry.state;
    expect(effect(retry.effects, "commit-preview").frame).toEqual(commit);

    state = accepted(disconnectSecureRelayDeviceV4(state, host, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const resumedHost = actor(host.deviceId, ids(), "device");
    const resumed = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: host.deviceId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = resumed.state;
    expect(resumed.effects.some((candidate) => candidate.type === "commit-preview")).toBe(false);
    const resumedEnd = effect(resumed.effects, "backlog-end").lastMessageId;
    const completed = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), lastMessageId: resumedEnd,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = completed.state;
    expect(effect(completed.effects, "commit-preview").frame.envelope.messageId).toBe(commit.envelope.messageId);

    const approved = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "commit-decision", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), messageId: commit.envelope.messageId, decision: "approve",
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = approved.state;
    expect(effect(approved.effects, "route-relay").toDeviceIds).toContain(resumedHost.deviceId);
    expect(approved.effects.some((candidate) => candidate.type === "frame-accepted"
      && candidate.deviceId === admitted.guest.deviceId)).toBe(true);
    expect(state.nextLogicalOrder).toBe(order.grant.logicalOrder);
    expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))).not.toBeNull();
  });

  it("rejects opaque/mislabeled commits without recipient backlog and safely times out", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const first = await admitMember(initial, host, ids, clock);
    const second = await admitMember(first.state, host, ids, clock);
    let state = second.state;
    const order = await requestGrant(state, first.guest, ids, clock);
    state = order.state;
    const maliciousCommit: SecureCommitRelayFrameV4 = {
      kind: "relay",
      relayKind: "commit",
      grant: order.grant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    state = accepted(await reduceSecureRelayV4(state, first.guest, maliciousCommit, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    expect(state.members.find((member) => member.deviceId === second.guest.deviceId)?.backlog).toHaveLength(0);

    const queued = accepted(await reduceSecureRelayV4(state, second.guest, {
      kind: "order-request", v: 4, suite: 1, roomInstance: state.roomInstance, requestId: ids(),
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = queued.state;
    expect(queued.effects.some((candidate) => candidate.type === "order-granted")).toBe(false);

    const deadline = state.pendingCommit!.decisionExpiresAt;
    const expired = accepted(advanceSecureRelayV4(state, { now: deadline, nextGrantTokenId: ids() }));
    state = expired.state;
    expect(state.pendingCommit).toBeNull();
    expect(state.nextLogicalOrder).toBe(order.grant.logicalOrder);
    expect(effect(expired.effects, "commit-rejected").reason).toBe("approval-expired");
    expect(effect(expired.effects, "order-granted").toDeviceId).toBe(second.guest.deviceId);
    expect(state.members.find((member) => member.deviceId === second.guest.deviceId)?.backlog).toHaveLength(0);
  });

  it("prevents grant theft and cancels a queued order when an approved commit must be applied first", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const first = await admitMember(initial, host, ids, clock);
    const second = await admitMember(first.state, host, ids, clock);
    let state = second.state;
    const order = await requestGrant(state, first.guest, ids, clock);
    state = order.state;
    const commit: SecureCommitRelayFrameV4 = {
      kind: "relay", relayKind: "commit", grant: order.grant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    rejected(await reduceSecureRelayV4(state, second.guest, commit, {
      now: tick(clock), nextGrantTokenId: ids(),
    }), "invalid-grant");
    state = accepted(await reduceSecureRelayV4(state, first.guest, commit, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const queueRequestId = ids();
    state = accepted(await reduceSecureRelayV4(state, second.guest, {
      kind: "order-request", v: 4, suite: 1, roomInstance: state.roomInstance, requestId: queueRequestId,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    const decision = accepted(await reduceSecureRelayV4(state, host, {
      kind: "commit-decision", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), messageId: commit.envelope.messageId, decision: "approve",
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(decision.effects).toContainEqual({
      type: "order-cancelled",
      deviceId: second.guest.deviceId,
      requestId: queueRequestId,
      reason: "delivery-pending",
    });
    expect(decision.state.orderQueue).toHaveLength(0);
    expect(decision.state.members.find((member) => member.deviceId === second.guest.deviceId)?.backlog)
      .toHaveLength(1);
  });
});

async function createTransferOffer(
  stateValue: SecureRelayStateV4,
  host: SecureRelayActorV4,
  target: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
) {
  let state = stateValue;
  const offerOrder = await requestGrant(state, host, ids, clock);
  state = offerOrder.state;
  const offer = applicationFrame(state, offerOrder.grant, ids);
  state = accepted(await reduceSecureRelayV4(state, host, offer, {
    now: tick(clock), nextGrantTokenId: ids(),
  })).state;
  state = await ackAll(state, ids, clock);
  const authorizationId = ids();
  const authorized = accepted(await reduceSecureRelayV4(state, host, {
    kind: "authorize-host-transfer", v: 4, suite: 1, roomInstance: state.roomInstance,
    requestId: authorizationId, deviceId: target.deviceId, offerMessageId: offer.envelope.messageId,
  }, { now: tick(clock), nextGrantTokenId: ids() }));
  state = await ackAll(authorized.state, ids, clock);
  return { state, authorizationId, offerMessageId: offer.envelope.messageId };
}

async function completeHostTransfer(
  stateValue: SecureRelayStateV4,
  host: SecureRelayActorV4,
  target: SecureRelayActorV4,
  ids: ReturnType<typeof idFactory>,
  clock: TestClock,
): Promise<SecureRelayStateV4> {
  const offered = await createTransferOffer(stateValue, host, target, ids, clock);
  let state = offered.state;
  const order = await requestGrant(state, target, ids, clock);
  state = order.state;
  const acceptance: SecureHostTransferAcceptRelayFrameV4 = {
    kind: "relay", relayKind: "host-transfer-accept", grant: order.grant,
    authorizationId: offered.authorizationId,
    envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
  };
  state = accepted(await reduceSecureRelayV4(state, target, acceptance, {
    now: tick(clock), nextGrantTokenId: ids(),
  })).state;
  state = accepted(await reduceSecureRelayV4(state, host, {
    kind: "application-decision", v: 4, suite: 1, roomInstance: state.roomInstance,
    requestId: ids(), messageId: acceptance.envelope.messageId, decision: "approve",
  }, { now: tick(clock), nextGrantTokenId: ids() })).state;
  return ackAll(state, ids, clock);
}

describe("protocol-v4 atomic host transfer", () => {
  it("does not redeliver an authorization after its exact durable backlog entry was ACKed", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    const offered = await createTransferOffer(admitted.state, host, admitted.guest, ids, clock);
    const retry = accepted(await reduceSecureRelayV4(offered.state, host, {
      kind: "authorize-host-transfer", v: 4, suite: 1,
      roomInstance: offered.state.roomInstance,
      requestId: offered.authorizationId,
      deviceId: admitted.guest.deviceId,
      offerMessageId: offered.offerMessageId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(effect(retry.effects, "frame-accepted").messageId).toBe(offered.authorizationId);
    expect(retry.effects.some((candidate) => candidate.type === "host-transfer-authorized"))
      .toBe(false);
  });

  it("accepts only the dedicated capability-bound frame and persists app+relay host atomically", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    const offered = await createTransferOffer(admitted.state, host, admitted.guest, ids, clock);
    let state = offered.state;
    const order = await requestGrant(state, admitted.guest, ids, clock);
    state = order.state;

    const unknown: SecureHostTransferAcceptRelayFrameV4 = {
      kind: "relay", relayKind: "host-transfer-accept", grant: order.grant, authorizationId: ids(),
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    rejected(await reduceSecureRelayV4(state, admitted.guest, unknown, {
      now: tick(clock), nextGrantTokenId: ids(),
    }), "invalid-reference");

    const acceptFrame: SecureHostTransferAcceptRelayFrameV4 = {
      kind: "relay",
      relayKind: "host-transfer-accept",
      grant: order.grant,
      authorizationId: offered.authorizationId,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    const preview = accepted(await reduceSecureRelayV4(state, admitted.guest, acceptFrame, {
      now: tick(clock), nextGrantTokenId: ids(),
    }));
    state = preview.state;
    expect(effect(preview.effects, "application-preview").frame.relayKind).toBe("host-transfer-accept");
    expect(state.hostDeviceId).toBe(host.deviceId);
    expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))?.hostDeviceId).toBe(host.deviceId);

    const approved = accepted(await reduceSecureRelayV4(state, host, {
      kind: "application-decision", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), messageId: acceptFrame.envelope.messageId, decision: "approve",
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = approved.state;
    expect(state.hostDeviceId).toBe(admitted.guest.deviceId);
    expect(state.pendingHostTransfer).toBeNull();
    expect(state.pendingApplication).toBeNull();
    expect(effect(approved.effects, "host-changed").deviceId).toBe(admitted.guest.deviceId);
    const restored = importSecureRelayStateV4(exportSecureRelayStateV4(state));
    expect(restored?.hostDeviceId).toBe(admitted.guest.deviceId);
    expect(restored?.recentMessages.find((record) => record.id === acceptFrame.envelope.messageId)?.kind)
      .toBe("application");
  });

  it("rejection/timeout cannot persist an accepted inner transfer with the old relay host", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    const offered = await createTransferOffer(admitted.state, host, admitted.guest, ids, clock);
    let state = offered.state;
    const order = await requestGrant(state, admitted.guest, ids, clock);
    state = order.state;
    const acceptFrame: SecureHostTransferAcceptRelayFrameV4 = {
      kind: "relay", relayKind: "host-transfer-accept", grant: order.grant,
      authorizationId: offered.authorizationId,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    };
    state = accepted(await reduceSecureRelayV4(state, admitted.guest, acceptFrame, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const deadline = state.pendingApplication!.decisionExpiresAt;
    state = accepted(advanceSecureRelayV4(state, { now: deadline, nextGrantTokenId: ids() })).state;
    expect(state.hostDeviceId).toBe(host.deviceId);
    expect(state.pendingHostTransfer).toBeNull();
    expect(state.pendingApplication).toBeNull();
    expect(state.recentMessages.find((record) => record.id === acceptFrame.envelope.messageId)?.kind)
      .toBe("application-rejected");
  });
});

describe("protocol-v4 durable cleanup and bounded disconnects", () => {
  it("requires an invitation-bound MLS Remove when the former founder expires after host transfer", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    let state = await completeHostTransfer(
      admitted.state, setup.host, admitted.guest, setup.ids, setup.clock,
    );
    expect(state.hostDeviceId).toBe(admitted.guest.deviceId);
    const founderBinding = state.members.find((member) => member.deviceId === setup.host.deviceId)!
      .memberBinding.admissionId;

    state = accepted(disconnectSecureRelayDeviceV4(state, setup.host, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    const deadline = state.members.find((member) => member.deviceId === setup.host.deviceId)!
      .disconnectExpiresAt!;
    const expired = accepted(advanceSecureRelayV4(state, {
      now: deadline, nextGrantTokenId: setup.ids(),
    }));
    setup.clock.now = deadline;
    state = expired.state;
    expect(state.pendingZombieRemovals[0]).toMatchObject({
      deviceId: setup.host.deviceId,
      admissionCommitMessageId: founderBinding,
      removalCommitMessageId: null,
    });
    expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))).not.toBeNull();

    const cleanup = await requestGrant(state, admitted.guest, setup.ids, setup.clock);
    state = cleanup.state;
    rejected(await reduceSecureRelayV4(
      state,
      admitted.guest,
      applicationFrame(state, cleanup.grant, setup.ids),
      { now: tick(setup.clock), nextGrantTokenId: setup.ids() },
    ), "removal-pending");
    const removalMessageId = setup.ids();
    state = accepted(await reduceSecureRelayV4(state, admitted.guest, {
      kind: "relay", relayKind: "commit", grant: cleanup.grant,
      retirementDeviceId: setup.host.deviceId,
      retirementAdmissionCommitMessageId: founderBinding,
      envelope: envelope(state.roomInstance, removalMessageId, "group", setup.ids(8)),
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    expect(state.pendingZombieRemovals[0].removalCommitMessageId).toBe(removalMessageId);
  });

  it("requires the same founder-bound Remove after former-founder backlog overflow", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    let state = await completeHostTransfer(
      admitted.state, setup.host, admitted.guest, setup.ids, setup.clock,
    );
    const founderBinding = state.members.find((member) => member.deviceId === setup.host.deviceId)!
      .memberBinding.admissionId;
    const order = await requestGrant(state, admitted.guest, setup.ids, setup.clock);
    state = order.state;
    saturateMemberBacklog(state, setup.host.deviceId, setup.ids, state.clockHighWater);
    const causalApplication = applicationFrame(state, order.grant, setup.ids);
    const overflowed = accepted(await reduceSecureRelayV4(state, admitted.guest, causalApplication, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    }));
    state = overflowed.state;
    expect(effect(overflowed.effects, "route-relay").frame.envelope.messageId)
      .toBe(causalApplication.envelope.messageId);
    expect(state.members.find((member) => member.deviceId === setup.host.deviceId)).toMatchObject({
      status: "disconnected",
      requiresFreshAdmission: true,
    });
    expect(state.pendingZombieRemovals[0]).toMatchObject({
      deviceId: setup.host.deviceId,
      admissionCommitMessageId: founderBinding,
    });
    state = await ackAll(state, setup.ids, setup.clock);
    const cleanup = await requestGrant(state, admitted.guest, setup.ids, setup.clock);
    rejected(await reduceSecureRelayV4(
      cleanup.state,
      admitted.guest,
      applicationFrame(cleanup.state, cleanup.grant, setup.ids),
      { now: tick(setup.clock), nextGrantTokenId: setup.ids() },
    ), "removal-pending");
  });

  it("terminalizes a consumed grant when disconnect expiry activates a barrier in the same transition", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    let state = accepted(disconnectSecureRelayDeviceV4(admitted.state, admitted.guest, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    const deadline = state.members.find((member) => member.deviceId === admitted.guest.deviceId)!
      .disconnectExpiresAt!;
    setup.clock.now = deadline - 2;
    const order = await requestGrant(state, setup.host, setup.ids, setup.clock);
    state = order.state;
    const raced = applicationFrame(state, order.grant, setup.ids);
    const interrupted = accepted(await reduceSecureRelayV4(state, setup.host, raced, {
      now: deadline, nextGrantTokenId: setup.ids(),
    }));
    setup.clock.now = deadline;
    state = interrupted.state;
    expect(interrupted.effects).toContainEqual({
      type: "order-cancelled",
      deviceId: setup.host.deviceId,
      requestId: order.grant.requestId,
      reason: "removal-pending",
    });
    expect(interrupted.effects).toContainEqual({
      type: "application-rejected",
      deviceId: setup.host.deviceId,
      messageId: raced.envelope.messageId,
      logicalOrder: order.grant.logicalOrder,
      reason: "removal-pending",
    });
    expect(interrupted.effects.some((candidate) => candidate.type === "route-relay")).toBe(false);
    expect(state.recentMessages.find((record) => record.id === raced.envelope.messageId)).toMatchObject({
      kind: "application-rejected",
      rejectionReason: "removal-pending",
    });
    state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;
    const retry = accepted(await reduceSecureRelayV4(state, setup.host, raced, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    }));
    expect(effect(retry.effects, "application-rejected").messageId).toBe(raced.envelope.messageId);
    rejected(await reduceSecureRelayV4(state, setup.host, {
      ...raced, envelope: { ...raced.envelope, payload: setup.ids(8) },
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }), "duplicate-id");
  });

  it("recovers a lost timer cancellation and terminalizes an expired encrypted grant", async () => {
    {
      const setup = await setupRoom();
      const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
      let state = accepted(disconnectSecureRelayDeviceV4(admitted.state, admitted.guest, {
        now: tick(setup.clock), nextGrantTokenId: setup.ids(),
      })).state;
      const deadline = state.members.find((member) => member.deviceId === admitted.guest.deviceId)!
        .disconnectExpiresAt!;
      setup.clock.now = deadline - 2;
      const order = await requestGrant(state, setup.host, setup.ids, setup.clock);
      const stale = applicationFrame(order.state, order.grant, setup.ids);
      state = accepted(advanceSecureRelayV4(order.state, {
        now: deadline, nextGrantTokenId: setup.ids(),
      })).state;
      setup.clock.now = deadline;
      state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;
      const recovered = accepted(await reduceSecureRelayV4(state, setup.host, stale, {
        now: tick(setup.clock), nextGrantTokenId: setup.ids(),
      }));
      expect(effect(recovered.effects, "order-cancelled")).toEqual({
        type: "order-cancelled",
        deviceId: setup.host.deviceId,
        requestId: order.grant.requestId,
        reason: "removal-pending",
      });
    }

    {
      const setup = await setupRoom();
      const order = await requestGrant(setup.state, setup.host, setup.ids, setup.clock);
      const expiredFrame = applicationFrame(order.state, order.grant, setup.ids);
      const expired = accepted(await reduceSecureRelayV4(order.state, setup.host, expiredFrame, {
        now: order.grant.expiresAt, nextGrantTokenId: setup.ids(),
      }));
      expect(effect(expired.effects, "order-expired").tokenId).toBe(order.grant.tokenId);
      expect(effect(expired.effects, "application-rejected")).toMatchObject({
        messageId: expiredFrame.envelope.messageId,
        logicalOrder: order.grant.logicalOrder,
        reason: "grant-expired",
      });
      const restored = importSecureRelayStateV4(exportSecureRelayStateV4(expired.state))!;
      const retry = accepted(await reduceSecureRelayV4(restored, setup.host, expiredFrame, {
        now: order.grant.expiresAt + 1, nextGrantTokenId: setup.ids(),
      }));
      expect(effect(retry.effects, "application-rejected").reason).toBe("grant-expired");
    }
  });

  it("cancels pre-barrier grants and queues, then grants cleanup only to the host", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const first = await admitMember(initial, host, ids, clock);
    const second = await admitMember(first.state, host, ids, clock);
    let state = accepted(disconnectSecureRelayDeviceV4(second.state, first.guest, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const deadline = state.members.find((member) => member.deviceId === first.guest.deviceId)!.disconnectExpiresAt!;

    clock.now = deadline - 3;
    const nonHostOrder = await requestGrant(state, second.guest, ids, clock);
    state = nonHostOrder.state;
    const queuedHostRequestId = ids();
    state = accepted(await reduceSecureRelayV4(state, host, {
      kind: "order-request", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: queuedHostRequestId,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    expect(state.currentGrant?.deviceId).toBe(second.guest.deviceId);
    expect(state.orderQueue.map((entry) => entry.deviceId)).toEqual([host.deviceId]);

    const expired = accepted(advanceSecureRelayV4(state, { now: deadline, nextGrantTokenId: ids() }));
    clock.now = deadline;
    state = expired.state;
    expect(state.currentGrant).toBeNull();
    expect(state.orderQueue).toEqual([]);
    expect(expired.effects.filter((candidate) => candidate.type === "order-cancelled"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ deviceId: second.guest.deviceId, reason: "removal-pending" }),
        expect.objectContaining({ deviceId: host.deviceId, requestId: queuedHostRequestId, reason: "removal-pending" }),
      ]));
    const blockedRequestId = ids();
    const blocked = accepted(await reduceSecureRelayV4(state, second.guest, {
      kind: "order-request", v: 4, suite: 1,
      roomInstance: state.roomInstance, requestId: blockedRequestId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(effect(blocked.effects, "order-cancelled")).toMatchObject({
      requestId: blockedRequestId, reason: "removal-pending",
    });
    state = blocked.state;
    const cleanup = await requestGrant(state, host, ids, clock);
    expect(cleanup.grant.deviceId).toBe(host.deviceId);
  });

  it("persists zombie cleanup across a lost timeout effect and clears it only after a later removal commit", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    let state = initial;
    const guest = actor(ids(), ids(), "invitation");
    const admissionId = ids();
    const signaturePublicKey = ids(32);
    const keyPackage = ids(8);
    state = accepted(await reduceSecureRelayV4(state, guest, {
      kind: "join", requestId: admissionId, signaturePublicKey,
      hello: hello(state.roomInstance, guest.deviceId, keyPackage),
      memberBinding: await memberBinding(
        "admission", state.roomInstance, guest.deviceId, admissionId, signaturePublicKey, keyPackage, ids,
      ),
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    const admissionDeadline = state.members.find((member) => member.deviceId === guest.deviceId)!.admissionExpiresAt!;

    const addOrder = await requestGrant(state, host, ids, clock);
    state = addOrder.state;
    const addCommitId = ids();
    state = accepted(await reduceSecureRelayV4(state, host, {
      kind: "relay", relayKind: "commit", grant: addOrder.grant, admissionId,
      envelope: envelope(state.roomInstance, addCommitId, "group", ids(8)),
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    state = await ackAll(state, ids, clock);
    state = accepted(disconnectSecureRelayDeviceV4(state, host, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;

    const expired = accepted(advanceSecureRelayV4(state, {
      now: admissionDeadline, nextGrantTokenId: ids(),
    }));
    clock.now = admissionDeadline;
    state = expired.state;
    expect(effect(expired.effects, "zombie-removal-required").admissionCommitMessageId).toBe(admissionId);
    expect(state.pendingZombieRemovals).toEqual([{
      deviceId: guest.deviceId,
      admissionCommitMessageId: admissionId,
      requestedAt: admissionDeadline,
      removalCommitMessageId: null,
    }]);
    state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;

    const resumedHost = actor(host.deviceId, ids(), "device");
    const resumed = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: host.deviceId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    state = resumed.state;
    expect(effect(resumed.effects, "zombie-removal-required").deviceId).toBe(guest.deviceId);
    state = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), lastMessageId: effect(resumed.effects, "backlog-end").lastMessageId,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    rejected(await reduceSecureRelayV4(state, resumedHost, {
      kind: "retire-member", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: guest.deviceId, commitMessageId: addCommitId,
    }, { now: tick(clock), nextGrantTokenId: ids() }), "invalid-reference");

    const removalOrder = await requestGrant(state, resumedHost, ids, clock);
    state = removalOrder.state;
    rejected(await reduceSecureRelayV4(state, resumedHost, applicationFrame(state, removalOrder.grant, ids), {
      now: tick(clock), nextGrantTokenId: ids(),
    }), "removal-pending");
    rejected(await reduceSecureRelayV4(state, resumedHost, {
      kind: "relay", relayKind: "commit", grant: removalOrder.grant,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "invalid-reference");
    rejected(await reduceSecureRelayV4(state, resumedHost, {
      kind: "relay", relayKind: "commit", grant: removalOrder.grant,
      retirementDeviceId: ids(),
      retirementAdmissionCommitMessageId: addCommitId,
      envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "invalid-reference");
    const removalCommitId = ids();
    state = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "relay", relayKind: "commit", grant: removalOrder.grant,
      retirementDeviceId: guest.deviceId,
      retirementAdmissionCommitMessageId: admissionId,
      envelope: envelope(state.roomInstance, removalCommitId, "group", ids(8)),
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    expect(state.pendingZombieRemovals[0].removalCommitMessageId).toBe(removalCommitId);
    const blockedRequestId = ids();
    const blocked = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "order-request", v: 4, suite: 1,
      roomInstance: state.roomInstance, requestId: blockedRequestId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(effect(blocked.effects, "order-cancelled")).toMatchObject({
      requestId: blockedRequestId, reason: "removal-pending",
    });
    state = blocked.state;
    state = await ackAll(state, ids, clock);
    state = accepted(await reduceSecureRelayV4(state, resumedHost, {
      kind: "retire-member", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: guest.deviceId, commitMessageId: removalCommitId,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    expect(state.pendingZombieRemovals).toHaveLength(0);
  });

  it("cancels disconnect expiry on timely resume and requires fresh admission after the persisted deadline", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    let state = admitted.state;
    state = accepted(disconnectSecureRelayDeviceV4(state, admitted.guest, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const firstDeadline = state.members.find((member) => member.deviceId === admitted.guest.deviceId)!.disconnectExpiresAt!;
    expect(nextSecureRelayDeadlineV4(state)).toBe(firstDeadline);
    state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;

    const resumedGuest = actor(admitted.guest.deviceId, ids(), "device");
    state = accepted(await reduceSecureRelayV4(state, resumedGuest, {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: admitted.guest.deviceId,
    }, { now: firstDeadline - 1, nextGrantTokenId: ids() })).state;
    clock.now = firstDeadline - 1;
    expect(state.members.find((member) => member.deviceId === admitted.guest.deviceId)?.disconnectExpiresAt).toBeNull();
    const resumeEnd = state.recentMessages.filter((record) => record.kind === "resume-request"
      && record.deviceId === resumedGuest.deviceId).at(-1)!.id;
    state = accepted(await reduceSecureRelayV4(state, resumedGuest, {
      kind: "resume-complete", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), lastMessageId: resumeEnd,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;

    state = accepted(disconnectSecureRelayDeviceV4(state, resumedGuest, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const deadline = state.members.find((member) => member.deviceId === admitted.guest.deviceId)!.disconnectExpiresAt!;
    expect(deadline).toBe(clock.now + SECURE_ACTIVE_DISCONNECT_GRACE_MS_V4);
    const expired = accepted(advanceSecureRelayV4(state, { now: deadline, nextGrantTokenId: ids() }));
    state = expired.state;
    const expiredMember = state.members.find((member) => member.deviceId === admitted.guest.deviceId)!;
    expect(expiredMember.requiresFreshAdmission).toBe(true);
    expect(expiredMember.disconnectExpiresAt).toBeNull();
    expect(state.pendingZombieRemovals[0].admissionCommitMessageId).toBe(admitted.admissionId);
    rejected(await reduceSecureRelayV4(state, actor(admitted.guest.deviceId, ids()), {
      kind: "resume", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), deviceId: admitted.guest.deviceId,
    }, { now: deadline + 1, nextGrantTokenId: ids() }), "fresh-admission-required");
  });

  it("retires the room when the only relay host exceeds its disconnect grace", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    let state = accepted(disconnectSecureRelayDeviceV4(initial, host, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const deadline = state.members[0].disconnectExpiresAt!;
    const expired = accepted(advanceSecureRelayV4(state, { now: deadline, nextGrantTokenId: ids() }));
    state = expired.state;
    expect(state.lifecycle).toBe("retired");
    expect(state.hostDeviceId).toBeNull();
    expect(effect(expired.effects, "room-retired")).toEqual({ type: "room-retired" });
  });

  it("terminalizes pending application and commit records before host-loss persistence", async () => {
    {
      const { ids, clock, host, state: initial } = await setupRoom();
      const admitted = await admitMember(initial, host, ids, clock);
      let state = admitted.state;
      const order = await requestGrant(state, admitted.guest, ids, clock);
      state = order.state;
      const pendingFrame = applicationFrame(state, order.grant, ids);
      state = accepted(await reduceSecureRelayV4(state, admitted.guest, pendingFrame, {
        now: tick(clock), nextGrantTokenId: ids(),
      })).state;
      state = accepted(disconnectSecureRelayDeviceV4(state, host, {
        now: tick(clock), nextGrantTokenId: ids(),
      })).state;
      const hostDeadline = state.members.find((member) => member.deviceId === host.deviceId)!.disconnectExpiresAt!;
      state = accepted(advanceSecureRelayV4(state, { now: hostDeadline, nextGrantTokenId: ids() })).state;
      expect(state.lifecycle).toBe("retired");
      expect(state.pendingApplication).toBeNull();
      expect(state.recentMessages.find((record) => record.id === pendingFrame.envelope.messageId))
        .toMatchObject({ kind: "application-rejected", rejectionReason: "member-retired" });
      expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))).not.toBeNull();
    }

    {
      const { ids, clock, host, state: initial } = await setupRoom();
      const admitted = await admitMember(initial, host, ids, clock);
      let state = admitted.state;
      const order = await requestGrant(state, admitted.guest, ids, clock);
      state = order.state;
      const pendingFrame: SecureCommitRelayFrameV4 = {
        kind: "relay",
        relayKind: "commit",
        grant: order.grant,
        envelope: envelope(state.roomInstance, ids(), "group", ids(8)),
      };
      state = accepted(await reduceSecureRelayV4(state, admitted.guest, pendingFrame, {
        now: tick(clock), nextGrantTokenId: ids(),
      })).state;
      state = accepted(disconnectSecureRelayDeviceV4(state, host, {
        now: tick(clock), nextGrantTokenId: ids(),
      })).state;
      const hostDeadline = state.members.find((member) => member.deviceId === host.deviceId)!.disconnectExpiresAt!;
      state = accepted(advanceSecureRelayV4(state, { now: hostDeadline, nextGrantTokenId: ids() })).state;
      expect(state.lifecycle).toBe("retired");
      expect(state.pendingCommit).toBeNull();
      expect(state.recentMessages.find((record) => record.id === pendingFrame.envelope.messageId))
        .toMatchObject({ kind: "commit-rejected", rejectionReason: "member-retired" });
      expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))).not.toBeNull();
    }
  });
});

describe("protocol-v4 bounded persistence", () => {
  it("retains unique founder provenance when pruning at the retired-member cap", async () => {
    const setup = await setupRoom();
    const admitted = await admitMember(setup.state, setup.host, setup.ids, setup.clock);
    let state = await completeHostTransfer(
      admitted.state, setup.host, admitted.guest, setup.ids, setup.clock,
    );
    state = accepted(disconnectSecureRelayDeviceV4(state, setup.host, {
      now: tick(setup.clock), nextGrantTokenId: setup.ids(),
    })).state;
    const deadline = state.members.find((member) => member.deviceId === setup.host.deviceId)!
      .disconnectExpiresAt!;
    state = accepted(advanceSecureRelayV4(state, {
      now: deadline, nextGrantTokenId: setup.ids(),
    })).state;
    setup.clock.now = deadline;
    const marker = state.pendingZombieRemovals[0];
    const cleanup = await requestGrant(state, admitted.guest, setup.ids, setup.clock);
    state = cleanup.state;
    const removalMessageId = setup.ids();
    state = accepted(await reduceSecureRelayV4(state, admitted.guest, {
      kind: "relay", relayKind: "commit", grant: cleanup.grant,
      retirementDeviceId: setup.host.deviceId,
      retirementAdmissionCommitMessageId: marker.admissionCommitMessageId,
      envelope: envelope(state.roomInstance, removalMessageId, "group", setup.ids(8)),
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    state = await ackAll(state, setup.ids, setup.clock);
    state = accepted(await reduceSecureRelayV4(state, admitted.guest, {
      kind: "retire-member", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: setup.ids(), deviceId: setup.host.deviceId, commitMessageId: removalMessageId,
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() })).state;
    expect(state.members.find((member) => member.deviceId === setup.host.deviceId)?.status)
      .toBe("retired");

    const syntheticDeviceIds: string[] = [];
    const syntheticMembershipIds: string[] = [];
    for (let index = 1; index < MAX_SECURE_RETIRED_TOMBSTONES_V4; index += 1) {
      const deviceId = setup.ids();
      const admissionId = setup.ids();
      const signaturePublicKey = setup.ids(32);
      const keyPackage = setup.ids(8);
      const binding = await memberBinding(
        "admission", state.roomInstance, deviceId, admissionId,
        signaturePublicKey, keyPackage, setup.ids,
      );
      const membershipCommitMessageId = setup.ids();
      syntheticDeviceIds.push(deviceId);
      syntheticMembershipIds.push(membershipCommitMessageId);
      state.members.push({
        deviceId,
        signaturePublicKey,
        memberBinding: binding,
        status: "retired",
        joinedOrder: state.nextMemberOrder,
        connectionId: null,
        resumeStatus: null,
        resumePhase: null,
        resumeRequestId: null,
        disconnectExpiresAt: null,
        admissionId: null,
        admissionExpiresAt: null,
        keyPackage: null,
        keyPackageDigest: null,
        pendingPhase: null,
        admissionCommitMessageId: null,
        membershipCommitMessageId,
        welcomeMessageId: null,
        proofMessageId: null,
        proofFrame: null,
        proofGrant: null,
        backlog: [],
        backlogBytes: 0,
        requiresFreshAdmission: false,
      });
      state.nextMemberOrder += 1;
      state.recentMessages.push({
        id: admissionId,
        kind: "join-request",
        deviceId,
        acceptedAt: state.clockHighWater,
        logicalOrder: null,
        rejectionReason: null,
        frameDigest: setup.ids(32),
      }, {
        id: membershipCommitMessageId,
        kind: "commit",
        deviceId: admitted.guest.deviceId,
        acceptedAt: state.clockHighWater,
        logicalOrder: null,
        rejectionReason: null,
        frameDigest: setup.ids(32),
      });
      state.recentKeyPackageDigests.push(binding.keyPackageDigest);
    }
    // The oldest prunable tombstone authored the next member's establishment
    // commit. It must survive until that dependent member is pruned first.
    state.recentMessages.find((record) => record.id === syntheticMembershipIds[1])!.deviceId
      = syntheticDeviceIds[0];
    expect(state.members.filter((member) => member.status === "retired"))
      .toHaveLength(MAX_SECURE_RETIRED_TOMBSTONES_V4);
    state = importSecureRelayStateV4(exportSecureRelayStateV4(state))!;

    const joining = actor(setup.ids(), setup.ids(), "invitation");
    const admissionId = setup.ids();
    const signaturePublicKey = setup.ids(32);
    const keyPackage = setup.ids(8);
    const joined = accepted(await reduceSecureRelayV4(state, joining, {
      kind: "join", requestId: admissionId, signaturePublicKey,
      hello: hello(state.roomInstance, joining.deviceId, keyPackage),
      memberBinding: await memberBinding(
        "admission", state.roomInstance, joining.deviceId, admissionId,
        signaturePublicKey, keyPackage, setup.ids,
      ),
    }, { now: tick(setup.clock), nextGrantTokenId: setup.ids() }));
    const restored = importSecureRelayStateV4(exportSecureRelayStateV4(joined.state));
    expect(restored).not.toBeNull();
    expect(restored!.members.filter((member) => member.memberBinding.mode === "founder"))
      .toHaveLength(1);
    expect(restored!.members.find((member) => member.memberBinding.mode === "founder")?.status)
      .toBe("retired");
    expect(restored!.members.some((member) => member.deviceId === syntheticDeviceIds[0])).toBe(true);
    expect(restored!.members.some((member) => member.deviceId === syntheticDeviceIds[1])).toBe(false);
    expect(restored!.members.filter((member) => member.status === "retired"))
      .toHaveLength(MAX_SECURE_RETIRED_TOMBSTONES_V4 - 1);
  });

  it("never evicts a used key-package digest and fails closed when the lifetime ledger is full", async () => {
    const { ids, clock, hostKeyPackage, state: initial } = await setupRoom();
    const oldestDigest = initial.recentKeyPackageDigests[0];
    while (initial.recentKeyPackageDigests.length < MAX_SECURE_KEY_PACKAGE_DIGESTS_V4) {
      const candidate = ids(32);
      if (!initial.recentKeyPackageDigests.includes(candidate)) initial.recentKeyPackageDigests.push(candidate);
    }
    const state = importSecureRelayStateV4(exportSecureRelayStateV4(initial));
    if (!state) throw new Error("expected saturated key-package ledger to survive persistence");
    expect(state.recentKeyPackageDigests[0]).toBe(oldestDigest);

    const replayingGuest = actor(ids(), ids(), "invitation");
    const replayRequestId = ids();
    const replaySignaturePublicKey = ids(32);
    rejected(await reduceSecureRelayV4(state, replayingGuest, {
      kind: "join",
      requestId: replayRequestId,
      signaturePublicKey: replaySignaturePublicKey,
      hello: hello(state.roomInstance, replayingGuest.deviceId, hostKeyPackage),
      memberBinding: await memberBinding(
        "admission", state.roomInstance, replayingGuest.deviceId, replayRequestId,
        replaySignaturePublicKey, hostKeyPackage, ids,
      ),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "duplicate-key-package");

    const freshGuest = actor(ids(), ids(), "invitation");
    const freshRequestId = ids();
    const freshSignaturePublicKey = ids(32);
    const freshKeyPackage = ids(8);
    rejected(await reduceSecureRelayV4(state, freshGuest, {
      kind: "join",
      requestId: freshRequestId,
      signaturePublicKey: freshSignaturePublicKey,
      hello: hello(state.roomInstance, freshGuest.deviceId, freshKeyPackage),
      memberBinding: await memberBinding(
        "admission", state.roomInstance, freshGuest.deviceId, freshRequestId,
        freshSignaturePublicKey, freshKeyPackage, ids,
      ),
    }, { now: tick(clock), nextGrantTokenId: ids() }), "key-package-limit");
    expect(state.recentKeyPackageDigests[0]).toBe(oldestDigest);
    expect(state.recentKeyPackageDigests).toHaveLength(MAX_SECURE_KEY_PACKAGE_DIGESTS_V4);
  });

  it("protects membership and pending transfer capabilities while pruning a saturated replay ring", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    let state = admitted.state;
    const membership = state.recentMessages.find((record) => record.id === admitted.commitMessageId)!;
    const founderAdmission = state.recentMessages.find((record) =>
      record.id === state.members.find((member) => member.deviceId === host.deviceId)!
        .memberBinding.admissionId)!;
    const guestAdmission = state.recentMessages.find((record) =>
      record.id === state.members.find((member) => member.deviceId === admitted.guest.deviceId)!
        .memberBinding.admissionId)!;
    state.recentMessages = [founderAdmission, guestAdmission, membership];
    while (state.recentMessages.length < MAX_SECURE_REPLAY_RECORDS_V4) {
      state.recentMessages.push({
        id: ids(), kind: "setup-request", deviceId: host.deviceId,
        acceptedAt: state.clockHighWater, logicalOrder: null, rejectionReason: null, frameDigest: null,
      });
    }
    expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))).not.toBeNull();
    const offerOrder = await requestGrant(state, host, ids, clock);
    state = offerOrder.state;
    expect(state.recentMessages.some((record) => record.id === admitted.commitMessageId)).toBe(true);
    expect(importSecureRelayStateV4(exportSecureRelayStateV4(state))).not.toBeNull();

    const offer = applicationFrame(state, offerOrder.grant, ids);
    state = accepted(await reduceSecureRelayV4(state, host, offer, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    state = await ackAll(state, ids, clock);
    const offerRecord = state.recentMessages.find((record) => record.id === offer.envelope.messageId)!;
    const membershipRecord = state.recentMessages.find((record) => record.id === admitted.commitMessageId)!;
    state.recentMessages = [founderAdmission, guestAdmission, offerRecord, membershipRecord];
    while (state.recentMessages.length < MAX_SECURE_REPLAY_RECORDS_V4) {
      state.recentMessages.push({
        id: ids(), kind: "setup-request", deviceId: host.deviceId,
        acceptedAt: state.clockHighWater, logicalOrder: null, rejectionReason: null, frameDigest: null,
      });
    }
    const authorizationId = ids();
    state = accepted(await reduceSecureRelayV4(state, host, {
      kind: "authorize-host-transfer", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: authorizationId, deviceId: admitted.guest.deviceId,
      offerMessageId: offer.envelope.messageId,
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    const restored = importSecureRelayStateV4(exportSecureRelayStateV4(state));
    expect(restored?.pendingHostTransfer?.authorizationId).toBe(authorizationId);
    expect(restored?.recentMessages.some((record) => record.id === offer.envelope.messageId)).toBe(true);
    expect(restored?.recentMessages.some((record) => record.id === admitted.commitMessageId)).toBe(true);
    expect(restored?.recentMessages.some((record) => record.id === guestAdmission.id)).toBe(true);
  });
});

describe("protocol-v4 terminal room control", () => {
  it("lets only the relay host close from any accepted application, including a non-host terminal event", async () => {
    const { ids, clock, host, state: initial } = await setupRoom();
    const admitted = await admitMember(initial, host, ids, clock);
    let state = admitted.state;
    const order = await requestGrant(state, admitted.guest, ids, clock);
    state = order.state;
    const terminalApplication = applicationFrame(state, order.grant, ids);
    state = accepted(await reduceSecureRelayV4(state, admitted.guest, terminalApplication, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    state = accepted(await reduceSecureRelayV4(state, host, {
      kind: "application-decision", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), messageId: terminalApplication.envelope.messageId, decision: "approve",
    }, { now: tick(clock), nextGrantTokenId: ids() })).state;
    const hostBacklog = state.members.find((member) => member.deviceId === host.deviceId)!.backlog;
    state = await ackThrough(state, host, backlogId(hostBacklog[hostBacklog.length - 1]), ids, clock);

    rejected(await reduceSecureRelayV4(state, admitted.guest, {
      kind: "close-room", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), authorizationMessageId: terminalApplication.envelope.messageId,
    }, { now: tick(clock), nextGrantTokenId: ids() }), "host-required");
    state = accepted(disconnectSecureRelayDeviceV4(state, admitted.guest, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const hostOrder = await requestGrant(state, host, ids, clock);
    state = hostOrder.state;
    const queuedPayloadFrame = applicationFrame(state, hostOrder.grant, ids);
    state = accepted(await reduceSecureRelayV4(state, host, queuedPayloadFrame, {
      now: tick(clock), nextGrantTokenId: ids(),
    })).state;
    const currentHostBacklog = state.members.find((member) => member.deviceId === host.deviceId)!.backlog;
    state = await ackThrough(
      state,
      host,
      backlogId(currentHostBacklog[currentHostBacklog.length - 1]),
      ids,
      clock,
    );
    expect(exportSecureRelayStateV4(state)).toContain(queuedPayloadFrame.envelope.payload);

    const closed = accepted(await reduceSecureRelayV4(state, host, {
      kind: "close-room", v: 4, suite: 1, roomInstance: state.roomInstance,
      requestId: ids(), authorizationMessageId: terminalApplication.envelope.messageId,
    }, { now: tick(clock), nextGrantTokenId: ids() }));
    expect(closed.state.lifecycle).toBe("retired");
    expect(effect(closed.effects, "room-retired")).toEqual({ type: "room-retired" });
    expect(closed.state.hostDeviceId).toBeNull();
    expect(closed.state.currentGrant).toBeNull();
    expect(closed.state.pendingApplication).toBeNull();
    expect(closed.state.pendingCommit).toBeNull();
    expect(closed.state.pendingHostTransfer).toBeNull();
    expect(closed.state.pendingZombieRemovals).toEqual([]);
    expect(closed.state.orderQueue).toEqual([]);
    expect(closed.state.members.every((member) => member.status === "retired"
      && member.connectionId === null && member.resumeStatus === null
      && member.resumePhase === null && member.disconnectExpiresAt === null
      && member.admissionId === null && member.keyPackage === null
      && member.proofFrame === null && member.proofGrant === null
      && member.backlog.length === 0 && member.backlogBytes === 0)).toBe(true);
    const serialized = exportSecureRelayStateV4(closed.state);
    expect(serialized).not.toContain(queuedPayloadFrame.envelope.payload);
    expect(serialized).not.toContain(host.connectionId);
    expect(serialized).not.toContain(admitted.guest.connectionId);
    expect(importSecureRelayStateV4(serialized)).not.toBeNull();
  });
});

describe("protocol-v4 deadline constants", () => {
  it("keeps security timeouts bounded and ordered", () => {
    expect(SECURE_COMMIT_APPROVAL_TTL_MS_V4).toBeLessThan(SECURE_ADMISSION_TTL_MS_V4);
    expect(SECURE_APPLICATION_APPROVAL_TTL_MS_V4).toBeLessThan(SECURE_ACTIVE_DISCONNECT_GRACE_MS_V4);
  });
});
