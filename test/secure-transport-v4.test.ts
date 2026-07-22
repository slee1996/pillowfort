import { describe, expect, test } from "bun:test";
import { toBase64Url } from "../src/roomAuth";
import { ROOM_INVITATION_AUTH_KDF_V4 } from "../src/roomInvitationAuthV4";
import { roomInvitationKeyPackageDigestV4 } from "../src/roomInvitationMemberBindingV4";
import {
  parseSecureAuthChallengeFrameV4,
  parseSecureAuthenticateFrameV4,
  parseSecureServerFrameV4,
} from "../src/secureTransportV4";

const id = (byte: number) => toBase64Url(new Uint8Array(16).fill(byte));
const challenge = toBase64Url(new Uint8Array(32).fill(9));
const roomInstance = id(1);
const deviceId = id(2);
const connectionId = id(3);
const requestId = id(4);
const tokenId = id(5);
const keyPackage = toBase64Url(new Uint8Array([1, 2, 3]));
const payload = toBase64Url(new Uint8Array([4, 5, 6]));
const grant = {
  v: 4 as const,
  suite: 1 as const,
  roomInstance,
  requestId,
  tokenId,
  deviceId,
  logicalOrder: 1,
  expiresAt: 10_000,
};
const relayEnvelope = {
  v: 4 as const,
  suite: 1 as const,
  roomInstance,
  messageId: id(6),
  route: "group" as const,
  payload,
};
const auth = {
  v: 4,
  kdf: ROOM_INVITATION_AUTH_KDF_V4,
  challenge,
  proof: toBase64Url(new Uint8Array(64).fill(5)),
  publicKey: toBase64Url(new Uint8Array(32).fill(6)),
};
const signaturePublicKey = toBase64Url(new Uint8Array(32).fill(7));

async function binding(mode: "founder" | "admission") {
  return {
    v: 4 as const,
    kdf: ROOM_INVITATION_AUTH_KDF_V4,
    mode,
    roomId: "room-1",
    roomInstance,
    deviceId,
    admissionId: requestId,
    signaturePublicKey,
    keyPackageDigest: await roomInvitationKeyPackageDigestV4(keyPackage),
    proof: toBase64Url(new Uint8Array(64).fill(8)),
  };
}

describe("protocol-v4 transport frames", () => {
  test("strictly parses setup authentication and challenge frames", async () => {
    const challengeFrame = { kind: "secure-auth-challenge", v: 4, suite: 1, connectionId, challenge, roomInstance: null };
    expect(parseSecureAuthChallengeFrameV4(challengeFrame)).toEqual(challengeFrame);
    expect(parseSecureAuthChallengeFrameV4({ ...challengeFrame, extra: true })).toBeNull();

    const setup = {
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup",
      frame: {
        kind: "setup", requestId, signaturePublicKey,
        hello: { v: 4, suite: 1, roomInstance, deviceId, keyPackage },
        memberBinding: await binding("founder"),
      },
      auth,
      fortPassSessionId: "cs_test_safe-token:1",
      fortPassClaimSecret: "a".repeat(64),
    };
    expect(parseSecureAuthenticateFrameV4(setup)).toEqual(setup);
    expect(parseSecureAuthenticateFrameV4({ ...setup, fortPassSessionId: " bad " })).toBeNull();
    const { fortPassClaimSecret: _missingClaim, ...missingClaim } = setup;
    expect(parseSecureAuthenticateFrameV4(missingClaim)).toBeNull();
    const { fortPassSessionId: _missingSession, ...missingSession } = setup;
    expect(parseSecureAuthenticateFrameV4(missingSession)).toBeNull();
    expect(parseSecureAuthenticateFrameV4({ ...setup, fortPassClaimSecret: "A".repeat(64) })).toBeNull();
    expect(parseSecureAuthenticateFrameV4({ ...setup, fortPassClaimSecret: "a".repeat(63) })).toBeNull();
    const freeSetup = { ...setup };
    delete (freeSetup as { fortPassSessionId?: string }).fortPassSessionId;
    delete (freeSetup as { fortPassClaimSecret?: string }).fortPassClaimSecret;
    expect(parseSecureAuthenticateFrameV4(freeSetup)).toEqual(freeSetup);
    expect(parseSecureAuthenticateFrameV4({ ...setup, auth: { ...auth, proof: `${auth.proof}=` } })).toBeNull();
  });

  test("forbids auth fields in the wrong mode and malformed server effects", async () => {
    const join = {
      kind: "secure-authenticate", v: 4, suite: 1, mode: "join",
      frame: {
        kind: "join", requestId, signaturePublicKey,
        hello: { v: 4, suite: 1, roomInstance, deviceId, keyPackage },
        memberBinding: await binding("admission"),
      },
      auth: { ...auth, publicKey: undefined },
    };
    expect(parseSecureAuthenticateFrameV4(join)).toBeNull();
    const { publicKey: _discarded, ...joinAuth } = auth;
    expect(parseSecureAuthenticateFrameV4({ ...join, auth: joinAuth })).not.toBeNull();

    const accepted = {
      kind: "secure-server", v: 4, suite: 1, type: "application-result",
      messageId: requestId, logicalOrder: 1, result: "accepted", reason: null,
    };
    expect(parseSecureServerFrameV4(accepted)).toEqual(accepted);
    expect(parseSecureServerFrameV4({ ...accepted, reason: "host-rejected" })).toBeNull();
    expect(parseSecureServerFrameV4({ ...accepted, result: "rejected", reason: null })).toBeNull();
    expect(parseSecureServerFrameV4({
      ...accepted, result: "rejected", reason: "grant-expired",
    })).not.toBeNull();
    expect(parseSecureServerFrameV4({
      kind: "secure-server", v: 4, suite: 1, type: "frame-accepted", messageId: requestId,
    })).not.toBeNull();
    expect(parseSecureServerFrameV4({ kind: "secure-server", v: 4, suite: 1, type: "error", code: "wat" })).toBeNull();

    const founderBinding = await binding("founder");
    const authenticatedJoin = {
      kind: "secure-server", v: 4, suite: 1, type: "authenticated", mode: "join",
      roomInstance, deviceId, status: "pending", founderBinding,
    };
    expect(parseSecureServerFrameV4(authenticatedJoin)).toEqual(authenticatedJoin);
    expect(parseSecureServerFrameV4({ ...authenticatedJoin, founderBinding: undefined })).toBeNull();
    const admissionBinding = await binding("admission");
    const delivery = {
      kind: "secure-server", v: 4, suite: 1, type: "deliver-key-package",
      fromDeviceId: deviceId, admissionId: requestId,
      hello: { v: 4, suite: 1, roomInstance, deviceId, keyPackage },
      memberBinding: admissionBinding,
    };
    expect(parseSecureServerFrameV4(delivery)).toEqual(delivery);
    expect(parseSecureServerFrameV4({
      ...delivery,
      hello: { ...delivery.hello, deviceId: id(10) },
    })).toBeNull();
  });

  test("strictly parses commit and atomic host-transfer approval frames", () => {
    const commit = {
      kind: "relay" as const,
      relayKind: "commit" as const,
      grant,
      envelope: relayEnvelope,
    };
    const commitPreview = {
      kind: "secure-server" as const,
      v: 4 as const,
      suite: 1 as const,
      type: "commit-preview" as const,
      fromDeviceId: deviceId,
      frame: commit,
      logicalOrder: 1,
    };
    expect(parseSecureServerFrameV4(commitPreview)).toEqual(commitPreview);
    const retirementCommit = {
      ...commit,
      retirementDeviceId: id(9),
      retirementAdmissionCommitMessageId: id(10),
    };
    expect(parseSecureServerFrameV4({ ...commitPreview, frame: retirementCommit })).not.toBeNull();
    expect(parseSecureServerFrameV4({
      ...commitPreview,
      frame: { ...commit, retirementDeviceId: id(9) },
    })).toBeNull();
    expect(parseSecureServerFrameV4({
      ...commitPreview,
      frame: { ...retirementCommit, admissionId: id(11) },
    })).toBeNull();
    expect(parseSecureServerFrameV4({
      ...commitPreview,
      frame: { ...commit, relayKind: "application" },
    })).toBeNull();

    const transfer = {
      kind: "relay" as const,
      relayKind: "host-transfer-accept" as const,
      authorizationId: id(7),
      grant,
      envelope: { ...relayEnvelope, messageId: id(8) },
    };
    const transferPreview = {
      kind: "secure-server" as const,
      v: 4 as const,
      suite: 1 as const,
      type: "application-preview" as const,
      fromDeviceId: deviceId,
      frame: transfer,
      logicalOrder: 1,
    };
    expect(parseSecureServerFrameV4(transferPreview)).toEqual(transferPreview);
    expect(parseSecureServerFrameV4({
      ...transferPreview,
      frame: { ...transfer, authorizationId: "not-canonical" },
    })).toBeNull();

    const rejected = {
      kind: "secure-server" as const,
      v: 4 as const,
      suite: 1 as const,
      type: "commit-rejected" as const,
      messageId: relayEnvelope.messageId,
      reason: "approval-expired" as const,
    };
    expect(parseSecureServerFrameV4(rejected)).toEqual(rejected);
    expect(parseSecureServerFrameV4({ ...rejected, reason: "removal-pending" })).not.toBeNull();
    expect(parseSecureServerFrameV4({ ...rejected, reason: null })).toBeNull();
    expect(parseSecureServerFrameV4({ ...rejected, extra: true })).toBeNull();
  });

  test("strictly parses the authoritative resume snapshot", () => {
    const otherDeviceId = id(11);
    const snapshot = {
      kind: "secure-server" as const,
      v: 4 as const,
      suite: 1 as const,
      type: "room-state-snapshot" as const,
      hostDeviceId: deviceId,
      members: [
        { deviceId, status: "active" as const },
        { deviceId: otherDeviceId, status: "disconnected" as const },
      ],
      pendingHostTransfer: {
        targetDeviceId: otherDeviceId,
        authorizationId: id(12),
      },
    };
    expect(parseSecureServerFrameV4(snapshot)).toEqual(snapshot);
    expect(parseSecureServerFrameV4({
      ...snapshot,
      members: [...snapshot.members, { deviceId, status: "pending" }],
    })).toBeNull();
    expect(parseSecureServerFrameV4({
      ...snapshot,
      hostDeviceId: id(13),
    })).toBeNull();
    expect(parseSecureServerFrameV4({
      ...snapshot,
      pendingHostTransfer: { ...snapshot.pendingHostTransfer, targetDeviceId: id(14) },
    })).toBeNull();
    expect(parseSecureServerFrameV4({ ...snapshot, extra: true })).toBeNull();
  });
});
