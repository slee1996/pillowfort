import {
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
  isSecureMemberHelloV4,
  type SecureMemberHelloV4,
} from "./protocolV4";
import {
  parseRoomInvitationAuthPayloadV4,
  type RoomInvitationAuthPayloadV4,
} from "./roomInvitationAuthV4";
import {
  parseRoomInvitationMemberBindingV4,
  type RoomInvitationMemberBindingV4,
} from "./roomInvitationMemberBindingV4";
import {
  MAX_SECURE_RELAY_MEMBERS_V4,
  parseSecureClientFrameV4,
  type SecureClientFrameV4,
  type SecureJoinFrameV4,
  type SecureLogicalOrderGrantV4,
  type SecureMemberLifecycleV4,
  type SecureRelayErrorCodeV4,
  type SecureRelayFrameV4,
  type SecureResumeFrameV4,
  type SecureSetupFrameV4,
} from "./secureRelayV4";

export const SECURE_AUTH_CHALLENGE_BYTES_V4 = 32;
export const SECURE_TRANSPORT_ERROR_CODE_MAX_BYTES_V4 = 64;

export interface SecureAuthChallengeFrameV4 {
  kind: "secure-auth-challenge";
  v: 4;
  suite: 1;
  connectionId: string;
  challenge: string;
  /** Null only while a new room is being set up. */
  roomInstance: string | null;
}

export type SecureAuthenticateFrameV4 =
  | {
      kind: "secure-authenticate";
      v: 4;
      suite: 1;
      mode: "setup";
      frame: SecureSetupFrameV4;
      auth: RoomInvitationAuthPayloadV4;
      fortPassSessionId?: string;
      fortPassClaimSecret?: string;
    }
  | {
      kind: "secure-authenticate";
      v: 4;
      suite: 1;
      mode: "join";
      frame: SecureJoinFrameV4;
      auth: RoomInvitationAuthPayloadV4;
    }
  | {
      kind: "secure-authenticate";
      v: 4;
      suite: 1;
      mode: "resume";
      frame: SecureResumeFrameV4;
      resumeProof: string;
    };

export type SecureServerErrorCodeV4 = SecureRelayErrorCodeV4
  | "authentication-expired"
  | "authentication-failed"
  | "room-exists"
  | "room-not-found"
  | "room-state-invalid"
  | "persistence-failed"
  | "rate-limited"
  | "internal-error";

export type SecureServerFrameV4 =
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "authenticated";
      mode: "setup" | "resume";
      roomInstance: string;
      deviceId: string;
      status: "active" | "pending";
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "authenticated";
      mode: "join";
      roomInstance: string;
      deviceId: string;
      status: "pending";
      founderBinding: RoomInvitationMemberBindingV4;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "deliver-key-package";
      fromDeviceId: string;
      admissionId: string;
      hello: SecureMemberHelloV4;
      memberBinding: RoomInvitationMemberBindingV4;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "relay";
      fromDeviceId: string;
      frame: SecureRelayFrameV4;
      logicalOrder: number | null;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "application-preview";
      fromDeviceId: string;
      frame: Extract<SecureRelayFrameV4, { relayKind: "application" | "host-transfer-accept" }>;
      logicalOrder: number;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "commit-preview";
      fromDeviceId: string;
      frame: Extract<SecureRelayFrameV4, { relayKind: "commit" }>;
      logicalOrder: number;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "admission-proof-preview";
      fromDeviceId: string;
      frame: Extract<SecureRelayFrameV4, { relayKind: "join-proof" }>;
      logicalOrder: number;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "order-granted";
      grant: SecureLogicalOrderGrantV4;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "order-expired";
      tokenId: string;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "order-cancelled";
      requestId: string;
      reason: "connection-lost" | "delivery-pending" | "removal-pending" | "admission-pending";
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "frame-accepted";
      messageId: string;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "application-result";
      messageId: string;
      logicalOrder: number;
      result: "accepted" | "rejected";
      reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending" | null;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "commit-rejected";
      messageId: string;
      reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending";
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "host-transfer-authorized";
      fromHostDeviceId: string;
      authorizationId: string;
      offerMessageId: string;
      expiresAt: number;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "host-transfer-expired";
      authorizationId: string;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "backlog-end";
      lastMessageId: string;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "room-state-snapshot";
      hostDeviceId: string;
      members: Array<{
        deviceId: string;
        status: "pending" | "active" | "disconnected";
      }>;
      pendingHostTransfer: null | {
        targetDeviceId: string;
        authorizationId: string;
      };
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "fresh-admission-required";
      deviceId: string;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "zombie-removal-required";
      deviceId: string;
      admissionCommitMessageId: string;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "member-lifecycle";
      deviceId: string;
      status: SecureMemberLifecycleV4;
    }
  | {
      kind: "secure-server";
      v: 4;
      suite: 1;
      type: "host-changed";
      deviceId: string;
    }
  | { kind: "secure-server"; v: 4; suite: 1; type: "room-retired" }
  | { kind: "secure-server"; v: 4; suite: 1; type: "error"; code: SecureServerErrorCodeV4 };

const SERVER_ERROR_CODES = new Set<SecureServerErrorCodeV4>([
  "invalid-frame", "invalid-state", "invalid-actor", "wrong-room", "downgrade", "room-retired",
  "device-mismatch", "connection-mismatch", "authentication-required", "duplicate-id",
  "duplicate-key-package", "key-package-limit", "device-exists", "unknown-device", "invalid-lifecycle", "member-limit",
  "pending-limit", "host-required", "recipient-unavailable", "invalid-route", "invalid-admission",
  "invalid-reference", "pending-cannot-send", "active-member-required", "order-already-pending",
  "order-queue-full", "delivery-pending", "invalid-grant", "grant-expired", "grant-token-required",
  "admission-pending", "removal-pending", "fresh-admission-required", "order-exhausted", "authentication-expired", "authentication-failed",
  "room-exists", "room-not-found", "room-state-invalid", "persistence-failed", "rate-limited",
  "internal-error",
  "clock-regression", "revision-exhausted",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key));
}

function fixedId(value: unknown, bytes = SECURE_MESSAGE_ID_BYTES): value is string {
  return canonicalBase64UrlByteLength(value) === bytes;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function commonServerFrame(value: Record<string, unknown>): boolean {
  return value.kind === "secure-server" && value.v === SECURE_ROOM_PROTOCOL_VERSION &&
    value.suite === SECURE_ROOM_MLS_CIPHERSUITE && typeof value.type === "string";
}

function parseGrant(value: unknown): SecureLogicalOrderGrantV4 | null {
  if (!isPlainRecord(value) || !exactKeys(value, [
    "v", "suite", "roomInstance", "requestId", "tokenId", "deviceId", "logicalOrder", "expiresAt",
  ])) return null;
  if (value.v !== 4 || value.suite !== 1 || !fixedId(value.roomInstance, SECURE_ROOM_ID_BYTES) ||
      !fixedId(value.requestId) || !fixedId(value.tokenId) || !fixedId(value.deviceId, SECURE_DEVICE_ID_BYTES) ||
      !positiveInteger(value.logicalOrder) || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) < 0) return null;
  return value as unknown as SecureLogicalOrderGrantV4;
}

function parseRelay(value: unknown): SecureRelayFrameV4 | null {
  const frame = parseSecureClientFrameV4(value);
  return frame?.kind === "relay" ? frame : null;
}

export function parseSecureAuthChallengeFrameV4(value: unknown): SecureAuthChallengeFrameV4 | null {
  if (!isPlainRecord(value) || !exactKeys(value, [
    "kind", "v", "suite", "connectionId", "challenge", "roomInstance",
  ]) || value.kind !== "secure-auth-challenge" || value.v !== 4 || value.suite !== 1 ||
      !fixedId(value.connectionId) || !fixedId(value.challenge, SECURE_AUTH_CHALLENGE_BYTES_V4) ||
      !(value.roomInstance === null || fixedId(value.roomInstance, SECURE_ROOM_ID_BYTES))) return null;
  return {
    kind: "secure-auth-challenge", v: 4, suite: 1,
    connectionId: value.connectionId, challenge: value.challenge,
    roomInstance: value.roomInstance as string | null,
  };
}

export function parseSecureAuthenticateFrameV4(value: unknown): SecureAuthenticateFrameV4 | null {
  if (!isPlainRecord(value) || value.kind !== "secure-authenticate" || value.v !== 4 || value.suite !== 1 ||
      (value.mode !== "setup" && value.mode !== "join" && value.mode !== "resume")) return null;
  const frame = parseSecureClientFrameV4(value.frame);
  if (value.mode === "setup") {
    if (!exactKeys(value, ["kind", "v", "suite", "mode", "frame", "auth"], [
      "fortPassSessionId", "fortPassClaimSecret",
    ]) ||
        frame?.kind !== "setup") return null;
    const auth = parseRoomInvitationAuthPayloadV4(value.auth, "setup");
    const hasFortPassSession = Object.prototype.hasOwnProperty.call(value, "fortPassSessionId");
    const hasFortPassClaim = Object.prototype.hasOwnProperty.call(value, "fortPassClaimSecret");
    if (!auth || hasFortPassSession !== hasFortPassClaim ||
        (hasFortPassSession && (typeof value.fortPassSessionId !== "string" ||
          !/^[a-zA-Z0-9_:-]{1,128}$/u.test(value.fortPassSessionId) ||
          typeof value.fortPassClaimSecret !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.fortPassClaimSecret)))) return null;
    return {
      kind: "secure-authenticate", v: 4, suite: 1, mode: "setup", frame, auth,
      ...(hasFortPassSession && {
        fortPassSessionId: value.fortPassSessionId as string,
        fortPassClaimSecret: value.fortPassClaimSecret as string,
      }),
    };
  }
  if (value.mode === "join") {
    if (!exactKeys(value, ["kind", "v", "suite", "mode", "frame", "auth"]) || frame?.kind !== "join") return null;
    const auth = parseRoomInvitationAuthPayloadV4(value.auth, "join");
    return auth ? { kind: "secure-authenticate", v: 4, suite: 1, mode: "join", frame, auth } : null;
  }
  if (!exactKeys(value, ["kind", "v", "suite", "mode", "frame", "resumeProof"]) ||
      frame?.kind !== "resume" || !fixedId(value.resumeProof, 64)) return null;
  return {
    kind: "secure-authenticate", v: 4, suite: 1, mode: "resume", frame,
    resumeProof: value.resumeProof as string,
  };
}

export function parseSecureServerFrameV4(value: unknown): SecureServerFrameV4 | null {
  if (!isPlainRecord(value) || !commonServerFrame(value)) return null;
  const base = ["kind", "v", "suite", "type"];
  switch (value.type) {
    case "authenticated":
      if (!exactKeys(
        value,
        [...base, "mode", "roomInstance", "deviceId", "status"],
        value.mode === "join" ? ["founderBinding"] : [],
      ) ||
          (value.mode !== "setup" && value.mode !== "join" && value.mode !== "resume") ||
          !fixedId(value.roomInstance, SECURE_ROOM_ID_BYTES) || !fixedId(value.deviceId, SECURE_DEVICE_ID_BYTES) ||
          (value.status !== "active" && value.status !== "pending")) return null;
      if (value.mode === "join") {
        const founderBinding = parseRoomInvitationMemberBindingV4(value.founderBinding);
        if (!founderBinding || founderBinding.mode !== "founder"
          || founderBinding.roomInstance !== value.roomInstance || value.status !== "pending") return null;
        return { ...value, founderBinding } as unknown as SecureServerFrameV4;
      }
      return value as unknown as SecureServerFrameV4;
    case "deliver-key-package":
      if (!exactKeys(value, [...base, "fromDeviceId", "admissionId", "hello", "memberBinding"]) ||
          !fixedId(value.fromDeviceId, SECURE_DEVICE_ID_BYTES) || !fixedId(value.admissionId) ||
          !isPlainRecord(value.hello) || !isSecureMemberHelloV4(value.hello)) return null;
      {
        const memberBinding = parseRoomInvitationMemberBindingV4(value.memberBinding);
        if (!memberBinding || memberBinding.mode !== "admission"
          || memberBinding.deviceId !== value.fromDeviceId
          || memberBinding.admissionId !== value.admissionId
          || memberBinding.roomInstance !== value.hello.roomInstance
          || value.hello.deviceId !== value.fromDeviceId) return null;
        return { ...value, memberBinding } as unknown as SecureServerFrameV4;
      }
    case "relay": {
      if (!exactKeys(value, [...base, "fromDeviceId", "frame", "logicalOrder"]) ||
          !fixedId(value.fromDeviceId, SECURE_DEVICE_ID_BYTES) ||
          !(value.logicalOrder === null || positiveInteger(value.logicalOrder))) return null;
      const frame = parseRelay(value.frame);
      return frame ? { ...value, frame } as unknown as SecureServerFrameV4 : null;
    }
    case "application-preview":
    case "commit-preview":
    case "admission-proof-preview": {
      if (!exactKeys(value, [...base, "fromDeviceId", "frame", "logicalOrder"]) ||
          !fixedId(value.fromDeviceId, SECURE_DEVICE_ID_BYTES) || !positiveInteger(value.logicalOrder)) return null;
      const frame = parseRelay(value.frame);
      const requiredKind = value.type === "application-preview"
        ? ["application", "host-transfer-accept"]
        : value.type === "commit-preview" ? "commit" : "join-proof";
      const matches = Array.isArray(requiredKind)
        ? !!frame && requiredKind.includes(frame.relayKind)
        : frame?.relayKind === requiredKind;
      return matches ? { ...value, frame } as unknown as SecureServerFrameV4 : null;
    }
    case "order-granted": {
      if (!exactKeys(value, [...base, "grant"])) return null;
      const grant = parseGrant(value.grant);
      return grant ? { ...value, grant } as unknown as SecureServerFrameV4 : null;
    }
    case "order-expired":
      return exactKeys(value, [...base, "tokenId"]) && fixedId(value.tokenId)
        ? value as unknown as SecureServerFrameV4 : null;
    case "order-cancelled":
      return exactKeys(value, [...base, "requestId", "reason"]) && fixedId(value.requestId)
        && (value.reason === "connection-lost" || value.reason === "delivery-pending" || value.reason === "removal-pending"
          || value.reason === "admission-pending")
        ? value as unknown as SecureServerFrameV4 : null;
    case "frame-accepted":
      return exactKeys(value, [...base, "messageId"]) && fixedId(value.messageId)
        ? value as unknown as SecureServerFrameV4 : null;
    case "application-result": {
      if (!exactKeys(value, [...base, "messageId", "logicalOrder", "result", "reason"]) ||
          !fixedId(value.messageId) || !positiveInteger(value.logicalOrder) ||
          (value.result !== "accepted" && value.result !== "rejected") ||
          !(value.reason === null || value.reason === "host-rejected" || value.reason === "approval-expired" ||
            value.reason === "grant-expired" || value.reason === "member-retired" || value.reason === "removal-pending"
            || value.reason === "admission-pending")) return null;
      if ((value.result === "accepted") !== (value.reason === null)) return null;
      return value as unknown as SecureServerFrameV4;
    }
    case "commit-rejected":
      return exactKeys(value, [...base, "messageId", "reason"]) && fixedId(value.messageId)
        && (value.reason === "host-rejected" || value.reason === "approval-expired"
          || value.reason === "grant-expired" || value.reason === "member-retired" || value.reason === "removal-pending"
          || value.reason === "admission-pending")
        ? value as unknown as SecureServerFrameV4 : null;
    case "host-transfer-authorized":
      return exactKeys(value, [
        ...base, "fromHostDeviceId", "authorizationId", "offerMessageId", "expiresAt",
      ]) && fixedId(value.fromHostDeviceId, SECURE_DEVICE_ID_BYTES)
        && fixedId(value.authorizationId) && fixedId(value.offerMessageId)
        && positiveInteger(value.expiresAt)
        ? value as unknown as SecureServerFrameV4 : null;
    case "host-transfer-expired":
      return exactKeys(value, [...base, "authorizationId"]) && fixedId(value.authorizationId)
        ? value as unknown as SecureServerFrameV4 : null;
    case "backlog-end":
      return exactKeys(value, [...base, "lastMessageId"]) && fixedId(value.lastMessageId)
        ? value as unknown as SecureServerFrameV4 : null;
    case "room-state-snapshot": {
      if (!exactKeys(value, [...base, "hostDeviceId", "members", "pendingHostTransfer"])
        || !fixedId(value.hostDeviceId, SECURE_DEVICE_ID_BYTES)
        || !Array.isArray(value.members) || value.members.length < 1
        || value.members.length > MAX_SECURE_RELAY_MEMBERS_V4) return null;
      const members: Array<{
        deviceId: string;
        status: "pending" | "active" | "disconnected";
      }> = [];
      for (const member of value.members) {
        if (!isPlainRecord(member) || !exactKeys(member, ["deviceId", "status"])
          || !fixedId(member.deviceId, SECURE_DEVICE_ID_BYTES)
          || (member.status !== "pending" && member.status !== "active"
            && member.status !== "disconnected")) return null;
        members.push({ deviceId: member.deviceId, status: member.status });
      }
      if (new Set(members.map((member) => member.deviceId)).size !== members.length
        || !members.some((member) => member.deviceId === value.hostDeviceId)) return null;
      let pendingHostTransfer: null | { targetDeviceId: string; authorizationId: string } = null;
      const rawPendingHostTransfer = value.pendingHostTransfer;
      if (rawPendingHostTransfer !== null) {
        if (!isPlainRecord(rawPendingHostTransfer)
          || !exactKeys(rawPendingHostTransfer, ["targetDeviceId", "authorizationId"])
          || !fixedId(rawPendingHostTransfer.targetDeviceId, SECURE_DEVICE_ID_BYTES)
          || !fixedId(rawPendingHostTransfer.authorizationId)
          || !members.some((member) => member.deviceId === rawPendingHostTransfer.targetDeviceId)) {
          return null;
        }
        pendingHostTransfer = {
          targetDeviceId: rawPendingHostTransfer.targetDeviceId,
          authorizationId: rawPendingHostTransfer.authorizationId,
        };
      }
      return {
        ...value,
        members,
        pendingHostTransfer,
      } as unknown as SecureServerFrameV4;
    }
    case "fresh-admission-required":
    case "host-changed":
      return exactKeys(value, [...base, "deviceId"]) && fixedId(value.deviceId, SECURE_DEVICE_ID_BYTES)
        ? value as unknown as SecureServerFrameV4 : null;
    case "zombie-removal-required":
      return exactKeys(value, [...base, "deviceId", "admissionCommitMessageId"]) &&
        fixedId(value.deviceId, SECURE_DEVICE_ID_BYTES) && fixedId(value.admissionCommitMessageId)
        ? value as unknown as SecureServerFrameV4 : null;
    case "member-lifecycle":
      return exactKeys(value, [...base, "deviceId", "status"]) && fixedId(value.deviceId, SECURE_DEVICE_ID_BYTES) &&
        (value.status === "pending" || value.status === "active" || value.status === "disconnected" || value.status === "retired")
        ? value as unknown as SecureServerFrameV4 : null;
    case "room-retired":
      return exactKeys(value, base) ? value as unknown as SecureServerFrameV4 : null;
    case "error":
      return exactKeys(value, [...base, "code"]) && typeof value.code === "string" &&
        new TextEncoder().encode(value.code).byteLength <= SECURE_TRANSPORT_ERROR_CODE_MAX_BYTES_V4 &&
        SERVER_ERROR_CODES.has(value.code as SecureServerErrorCodeV4)
        ? value as unknown as SecureServerFrameV4 : null;
    default:
      return null;
  }
}

/** After authentication, clients send raw strict SecureClientFrameV4 frames. */
export function parseSecurePostAuthClientFrameV4(value: unknown): SecureClientFrameV4 | null {
  const frame = parseSecureClientFrameV4(value);
  return frame && frame.kind !== "setup" && frame.kind !== "join" && frame.kind !== "resume" ? frame : null;
}
