import {
  MAX_MLS_KEY_PACKAGE_BYTES,
  MAX_SECURE_WEBSOCKET_FRAME_BYTES,
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
  isSecureMemberHelloV4,
  isSecureRelayEnvelopeV4,
  type SecureMemberHelloV4,
  type SecureRelayEnvelopeV4,
} from "./protocolV4";
import {
  parseRoomInvitationMemberBindingV4,
  roomInvitationKeyPackageDigestV4,
  type RoomInvitationMemberBindingV4,
} from "./roomInvitationMemberBindingV4";

/**
 * Protocol-v4 relay state is deliberately content-blind.  It contains only
 * random identifiers, MLS admission material, connection lifecycle, replay
 * markers, and ordering grants.  Display names and application/game data do
 * not belong at this boundary.
 */
export const SECURE_RELAY_STATE_SCHEMA_V4 = "pillowfort-secure-relay-state-v4" as const;
/** Maximum simultaneous non-retired MLS/application members. */
export const MAX_SECURE_RELAY_MEMBERS_V4 = 20;
export const MAX_SECURE_RETIRED_TOMBSTONES_V4 = 256;
export const MAX_SECURE_ORDER_QUEUE_V4 = 16;
export const MAX_SECURE_REPLAY_RECORDS_V4 = 4096;
// Retain every admitted KeyPackage digest for the bounded room lifetime. The
// ledger must cover the full live+retired state bound or tombstone pruning can
// become unreachable one join too early.
export const MAX_SECURE_KEY_PACKAGE_DIGESTS_V4 =
  MAX_SECURE_RELAY_MEMBERS_V4 + MAX_SECURE_RETIRED_TOMBSTONES_V4;
export const MAX_SECURE_DEVICE_BACKLOG_ENTRIES_V4 = 24;
export const MAX_SECURE_DEVICE_BACKLOG_BYTES_V4 = 128 * 1024;
export const MAX_SECURE_ZOMBIE_REMOVALS_V4 = MAX_SECURE_RELAY_MEMBERS_V4;
export const MAX_SECURE_RELAY_STATE_BYTES_V4 = 4 * 1024 * 1024;
export const SECURE_ORDER_GRANT_TTL_MS_V4 = 5_000;
export const SECURE_APPLICATION_APPROVAL_TTL_MS_V4 = 5_000;
export const SECURE_COMMIT_APPROVAL_TTL_MS_V4 = 5_000;
export const SECURE_ADMISSION_TTL_MS_V4 = 30_000;
export const SECURE_HOST_TRANSFER_TTL_MS_V4 = 30_000;
export const SECURE_ACTIVE_DISCONNECT_GRACE_MS_V4 = 120_000;

const SHA256_BYTES = 32;

export type SecureMemberLifecycleV4 = "pending" | "active" | "disconnected" | "retired";
export type SecurePendingPhaseV4 = "awaiting-welcome" | "awaiting-bootstrap" | "awaiting-proof";
export type SecureResumeLifecycleV4 = "active";

export interface SecureSetupFrameV4 {
  kind: "setup";
  requestId: string;
  /** Founder device credential key, verified against its MLS credential by the caller. */
  signaturePublicKey: string;
  hello: SecureMemberHelloV4;
  memberBinding: RoomInvitationMemberBindingV4;
}

export interface SecureJoinFrameV4 {
  kind: "join";
  requestId: string;
  /** Joiner credential key; activation must match this immutable declaration. */
  signaturePublicKey: string;
  hello: SecureMemberHelloV4;
  memberBinding: RoomInvitationMemberBindingV4;
}

/**
 * `resume` is accepted only after the caller verifies a domain-separated
 * challenge with the active device's stored signature key. Pending admissions
 * never resume and this frame cannot replace MLS or credential material.
 */
export interface SecureResumeFrameV4 {
  kind: "resume";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  deviceId: string;
}

export interface SecureLogicalOrderGrantV4 {
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  tokenId: string;
  deviceId: string;
  logicalOrder: number;
  expiresAt: number;
}

export interface SecureCommitRelayFrameV4 {
  kind: "relay";
  relayKind: "commit";
  grant: SecureLogicalOrderGrantV4;
  /** Present only when the commit admits the matching pending device. */
  admissionId?: string;
  /** Present as an exact pair only for the current relay-mandated MLS removal. */
  retirementDeviceId?: string;
  retirementAdmissionCommitMessageId?: string;
  envelope: SecureRelayEnvelopeV4;
}

/**
 * The envelope payload is one opaque, canonical admission bundle containing
 * the MLS Welcome and ratchet tree.  The relay never decodes either value.
 */
export interface SecureWelcomeRelayFrameV4 {
  kind: "relay";
  relayKind: "welcome";
  admissionId: string;
  commitMessageId: string;
  envelope: SecureRelayEnvelopeV4;
}

export interface SecureBootstrapRelayFrameV4 {
  kind: "relay";
  relayKind: "bootstrap";
  admissionId: string;
  welcomeMessageId: string;
  grant: SecureLogicalOrderGrantV4;
  envelope: SecureRelayEnvelopeV4;
}

export interface SecureJoinProofRelayFrameV4 {
  kind: "relay";
  relayKind: "join-proof";
  admissionId: string;
  welcomeMessageId: string;
  grant: SecureLogicalOrderGrantV4;
  envelope: SecureRelayEnvelopeV4;
}

export interface SecureApplicationRelayFrameV4 {
  kind: "relay";
  relayKind: "application";
  grant: SecureLogicalOrderGrantV4;
  envelope: SecureRelayEnvelopeV4;
}

export interface SecureHostTransferAcceptRelayFrameV4 {
  kind: "relay";
  relayKind: "host-transfer-accept";
  grant: SecureLogicalOrderGrantV4;
  authorizationId: string;
  envelope: SecureRelayEnvelopeV4;
}

export type SecureRelayFrameV4 =
  | SecureCommitRelayFrameV4
  | SecureWelcomeRelayFrameV4
  | SecureBootstrapRelayFrameV4
  | SecureJoinProofRelayFrameV4
  | SecureApplicationRelayFrameV4
  | SecureHostTransferAcceptRelayFrameV4;

export interface SecureActivateFrameV4 {
  kind: "activate";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  deviceId: string;
  admissionId: string;
  proofMessageId: string;
  /** Host-verified signing key from the admitted member's MLS roster credential. */
  signaturePublicKey: string;
}

export interface SecureOrderRequestFrameV4 {
  kind: "order-request";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
}

export interface SecureAuthorizeHostTransferFrameV4 {
  kind: "authorize-host-transfer";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  deviceId: string;
  offerMessageId: string;
}

export interface SecureRetireMemberFrameV4 {
  kind: "retire-member";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  deviceId: string;
  commitMessageId: string;
}

export interface SecureCancelAdmissionFrameV4 {
  kind: "cancel-admission";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  deviceId: string;
  admissionId: string;
}

export interface SecureCloseRoomFrameV4 {
  kind: "close-room";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  authorizationMessageId: string;
}

export interface SecureApplicationDecisionFrameV4 {
  kind: "application-decision";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  messageId: string;
  decision: "approve" | "reject";
}

export interface SecureCommitDecisionFrameV4 {
  kind: "commit-decision";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  messageId: string;
  decision: "approve" | "reject";
}

export interface SecureResumeCompleteFrameV4 {
  kind: "resume-complete";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  lastMessageId: string;
}

export interface SecureDeliveryAckFrameV4 {
  kind: "delivery-ack";
  v: 4;
  suite: 1;
  roomInstance: string;
  requestId: string;
  /** Acknowledge the durable queue prefix ending at this exact message ID. */
  lastMessageId: string;
}

export type SecureClientFrameV4 =
  | SecureSetupFrameV4
  | SecureJoinFrameV4
  | SecureResumeFrameV4
  | SecureRelayFrameV4
  | SecureActivateFrameV4
  | SecureOrderRequestFrameV4
  | SecureAuthorizeHostTransferFrameV4
  | SecureRetireMemberFrameV4
  | SecureCancelAdmissionFrameV4
  | SecureCloseRoomFrameV4
  | SecureApplicationDecisionFrameV4
  | SecureCommitDecisionFrameV4
  | SecureResumeCompleteFrameV4
  | SecureDeliveryAckFrameV4;

export type SecureReplayKindV4 =
  | "setup-request"
  | "join-request"
  | "resume-request"
  | "commit"
  | "commit-pending"
  | "commit-rejected"
  | "welcome"
  | "bootstrap"
  | "join-proof"
  | "join-proof-pending"
  | "application"
  | "application-pending"
  | "application-rejected"
  | "order-request"
  | "order-cancelled"
  | "grant-token"
  | "grant-expired"
  | "activate"
  | "authorize-host-transfer"
  | "retire-member"
  | "cancel-admission"
  | "close-room"
  | "application-decision"
  | "commit-decision"
  | "resume-complete"
  | "delivery-ack";

export interface SecureReplayRecordV4 {
  id: string;
  kind: SecureReplayKindV4;
  deviceId: string;
  acceptedAt: number;
  /** Ordered application/proof records retain this for exact retry results. */
  logicalOrder: number | null;
  /** Terminal operation rejection, retained for idempotent outbox recovery. */
  rejectionReason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "connection-lost" | "delivery-pending" | "removal-pending" | "admission-pending" | null;
  /** Exact accepted control or encrypted relay-frame fingerprint. */
  frameDigest: string | null;
}

export interface SecureRelayMemberStateV4 {
  deviceId: string;
  signaturePublicKey: string | null;
  /** Invitation-key signature over this member's immutable MLS admission identity. */
  memberBinding: RoomInvitationMemberBindingV4;
  status: SecureMemberLifecycleV4;
  joinedOrder: number;
  connectionId: string | null;
  resumeStatus: SecureResumeLifecycleV4 | null;
  resumePhase: "replaying-backlog" | null;
  /** Exact resume request that owns the current empty-backlog completion sentinel. */
  resumeRequestId: string | null;
  disconnectExpiresAt: number | null;
  admissionId: string | null;
  admissionExpiresAt: number | null;
  keyPackage: string | null;
  keyPackageDigest: string | null;
  pendingPhase: SecurePendingPhaseV4 | null;
  admissionCommitMessageId: string | null;
  /** Relay setup/Add record proving this MLS leaf reached an established epoch. */
  membershipCommitMessageId: string | null;
  welcomeMessageId: string | null;
  proofMessageId: string | null;
  proofFrame: SecureJoinProofRelayFrameV4 | null;
  proofGrant: SecureGrantStateV4 | null;
  backlog: SecureBacklogEntryV4[];
  backlogBytes: number;
  requiresFreshAdmission: boolean;
}

export interface SecureRelayBacklogEntryV4 {
  kind: "relay";
  receivedAt: number;
  /** Authenticated relay actor, persisted because ciphertext is intentionally opaque. */
  fromDeviceId: string;
  logicalOrder: number | null;
  frame: SecureCommitRelayFrameV4 | SecureWelcomeRelayFrameV4 | SecureBootstrapRelayFrameV4
    | SecureJoinProofRelayFrameV4 | SecureApplicationRelayFrameV4 | SecureHostTransferAcceptRelayFrameV4;
}

export interface SecureApplicationResultBacklogEntryV4 {
  kind: "application-result";
  receivedAt: number;
  logicalOrder: number;
  messageId: string;
  result: "accepted" | "rejected";
  reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending" | null;
}

export interface SecureCommitResultBacklogEntryV4 {
  kind: "commit-result";
  receivedAt: number;
  logicalOrder: null;
  messageId: string;
  result: "accepted" | "rejected";
  reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending" | null;
}

export interface SecureHostTransferAuthorizationBacklogEntryV4 {
  kind: "host-transfer-authorization";
  receivedAt: number;
  logicalOrder: null;
  fromHostDeviceId: string;
  authorizationId: string;
  offerMessageId: string;
  expiresAt: number;
}

export type SecureBacklogEntryV4 = SecureRelayBacklogEntryV4 | SecureApplicationResultBacklogEntryV4
  | SecureCommitResultBacklogEntryV4 | SecureHostTransferAuthorizationBacklogEntryV4;

export interface SecureOrderQueueEntryV4 {
  deviceId: string;
  connectionId: string;
  requestId: string;
  enqueuedAt: number;
}

export interface SecureGrantStateV4 extends SecureLogicalOrderGrantV4 {
  connectionId: string;
}

export interface SecurePendingApplicationStateV4 {
  fromDeviceId: string;
  connectionId: string;
  logicalOrder: number;
  receivedAt: number;
  decisionExpiresAt: number;
  frame: SecureApplicationRelayFrameV4 | SecureHostTransferAcceptRelayFrameV4;
}

export interface SecurePendingCommitStateV4 {
  fromDeviceId: string;
  connectionId: string;
  receivedAt: number;
  decisionExpiresAt: number;
  frame: SecureCommitRelayFrameV4;
}

export interface SecurePendingHostTransferStateV4 {
  authorizationId: string;
  hostDeviceId: string;
  targetDeviceId: string;
  offerMessageId: string;
  authorizedAt: number;
  expiresAt: number;
}

export interface SecureZombieRemovalStateV4 {
  deviceId: string;
  /**
   * Legacy field name: this is the invitation-signed membership admission ID
   * from memberBinding, not the unauthenticated outer Add message ID.
   */
  admissionCommitMessageId: string;
  requestedAt: number;
  /** Exact host removal commit accepted for this barrier; null until sent. */
  removalCommitMessageId: string | null;
}

export interface SecureRelayStateV4 {
  schema: typeof SECURE_RELAY_STATE_SCHEMA_V4;
  revision: number;
  clockHighWater: number;
  v: 4;
  suite: 1;
  roomInstance: string;
  lifecycle: "open" | "retired";
  hostDeviceId: string | null;
  members: SecureRelayMemberStateV4[];
  nextMemberOrder: number;
  nextLogicalOrder: number;
  currentGrant: SecureGrantStateV4 | null;
  pendingApplication: SecurePendingApplicationStateV4 | null;
  pendingCommit: SecurePendingCommitStateV4 | null;
  pendingHostTransfer: SecurePendingHostTransferStateV4 | null;
  pendingZombieRemovals: SecureZombieRemovalStateV4[];
  orderQueue: SecureOrderQueueEntryV4[];
  recentMessages: SecureReplayRecordV4[];
  recentKeyPackageDigests: string[];
}

export interface SecureRelayActorV4 {
  /** Device identity established by the authentication layer, never by frame data. */
  deviceId: string;
  /** Server-generated connection/session identifier stored in the socket attachment. */
  connectionId: string;
  authentication: "invitation" | "device";
}

export type SecureRelayEffectV4 =
  | {
      type: "deliver-key-package";
      fromDeviceId: string;
      toDeviceId: string;
      admissionId: string;
      hello: SecureMemberHelloV4;
      memberBinding: RoomInvitationMemberBindingV4;
    }
  | {
      type: "route-relay";
      fromDeviceId: string;
      toDeviceIds: string[];
      frame: SecureRelayFrameV4;
      logicalOrder: number | null;
    }
  | {
      type: "application-preview";
      fromDeviceId: string;
      toHostDeviceId: string;
      frame: SecureApplicationRelayFrameV4 | SecureHostTransferAcceptRelayFrameV4;
      logicalOrder: number;
    }
  | {
      type: "commit-preview";
      fromDeviceId: string;
      toHostDeviceId: string;
      frame: SecureCommitRelayFrameV4;
      logicalOrder: number;
    }
  | {
      type: "admission-proof-preview";
      fromDeviceId: string;
      toHostDeviceId: string;
      frame: SecureJoinProofRelayFrameV4;
      logicalOrder: number;
    }
  | { type: "order-granted"; toDeviceId: string; grant: SecureLogicalOrderGrantV4 }
  | { type: "order-expired"; deviceId: string; tokenId: string }
  | { type: "order-cancelled"; deviceId: string; requestId: string; reason: "connection-lost" | "delivery-pending" | "removal-pending" | "admission-pending" }
  | { type: "frame-accepted"; deviceId: string; messageId: string }
  | { type: "application-accepted"; deviceId: string; messageId: string; logicalOrder: number }
  | {
      type: "application-rejected";
      deviceId: string;
      messageId: string;
      logicalOrder: number;
      reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending";
    }
  | {
      type: "commit-rejected";
      deviceId: string;
      messageId: string;
      reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending";
    }
  | { type: "replay-backlog"; toDeviceId: string; entries: SecureBacklogEntryV4[] }
  | { type: "backlog-end"; toDeviceId: string; lastMessageId: string }
  | {
      type: "room-state-snapshot";
      toDeviceId: string;
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
      type: "host-transfer-authorized";
      toDeviceId: string;
      fromHostDeviceId: string;
      authorizationId: string;
      offerMessageId: string;
      expiresAt: number;
    }
  | { type: "host-transfer-expired"; deviceIds: string[]; authorizationId: string }
  | { type: "fresh-admission-required"; deviceId: string }
  | {
      type: "zombie-removal-required";
      toDeviceIds: string[];
      deviceId: string;
      admissionCommitMessageId: string;
    }
  | { type: "member-lifecycle"; deviceId: string; status: SecureMemberLifecycleV4 }
  | { type: "host-changed"; deviceId: string }
  | { type: "room-retired" };

export type SecureRelayErrorCodeV4 =
  | "invalid-frame"
  | "invalid-state"
  | "invalid-actor"
  | "wrong-room"
  | "downgrade"
  | "room-retired"
  | "device-mismatch"
  | "connection-mismatch"
  | "authentication-required"
  | "duplicate-id"
  | "duplicate-key-package"
  | "key-package-limit"
  | "device-exists"
  | "unknown-device"
  | "invalid-lifecycle"
  | "member-limit"
  | "pending-limit"
  | "host-required"
  | "recipient-unavailable"
  | "invalid-route"
  | "invalid-admission"
  | "invalid-reference"
  | "pending-cannot-send"
  | "active-member-required"
  | "order-already-pending"
  | "order-queue-full"
  | "delivery-pending"
  | "invalid-grant"
  | "grant-expired"
  | "grant-token-required"
  | "admission-pending"
  | "removal-pending"
  | "fresh-admission-required"
  | "order-exhausted"
  | "clock-regression"
  | "revision-exhausted";

export type SecureRelayTransitionV4 =
  | { ok: true; state: SecureRelayStateV4; effects: SecureRelayEffectV4[] }
  | { ok: false; code: SecureRelayErrorCodeV4 };

export type SecureRelayCreateResultV4 = SecureRelayTransitionV4;

export interface SecureRelayReduceOptionsV4 {
  now: number;
  /**
   * Fresh server-generated ID used only if this transition must issue the next
   * logical-order grant.  Supplying it eagerly is safe; reuse is rejected.
   */
  nextGrantTokenId?: string;
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isPlainDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
  }
  return keys.length === value.length + 1;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === "string" && allowed.has(key));
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isFixedBase64Url(value: unknown, bytes: number): value is string {
  return canonicalBase64UrlByteLength(value) === bytes;
}

function isRoomInstance(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_ROOM_ID_BYTES);
}

function isDeviceId(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_DEVICE_ID_BYTES);
}

function isMessageId(value: unknown): value is string {
  return isFixedBase64Url(value, SECURE_MESSAGE_ID_BYTES);
}

function parseHello(value: unknown): SecureMemberHelloV4 | null {
  if (!isPlainDataRecord(value) || !isSecureMemberHelloV4(value)) return null;
  return {
    v: SECURE_ROOM_PROTOCOL_VERSION,
    suite: SECURE_ROOM_MLS_CIPHERSUITE,
    roomInstance: value.roomInstance,
    deviceId: value.deviceId,
    keyPackage: value.keyPackage,
  };
}

function parseEnvelope(value: unknown): SecureRelayEnvelopeV4 | null {
  if (!isPlainDataRecord(value) || !isSecureRelayEnvelopeV4(value)) return null;
  const envelope: SecureRelayEnvelopeV4 = {
    v: SECURE_ROOM_PROTOCOL_VERSION,
    suite: SECURE_ROOM_MLS_CIPHERSUITE,
    roomInstance: value.roomInstance,
    messageId: value.messageId,
    route: value.route,
    payload: value.payload,
  };
  if (value.route === "device") envelope.to = value.to;
  return envelope;
}

function parseGrant(value: unknown): SecureLogicalOrderGrantV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "v", "suite", "roomInstance", "requestId", "tokenId", "deviceId", "logicalOrder", "expiresAt",
  ])) return null;
  if (value.v !== SECURE_ROOM_PROTOCOL_VERSION || value.suite !== SECURE_ROOM_MLS_CIPHERSUITE
    || !isRoomInstance(value.roomInstance) || !isMessageId(value.requestId)
    || !isMessageId(value.tokenId) || !isDeviceId(value.deviceId)
    || !isPositiveSafeInteger(value.logicalOrder) || !isSafeTimestamp(value.expiresAt)) return null;
  return {
    v: SECURE_ROOM_PROTOCOL_VERSION,
    suite: SECURE_ROOM_MLS_CIPHERSUITE,
    roomInstance: value.roomInstance,
    requestId: value.requestId,
    tokenId: value.tokenId,
    deviceId: value.deviceId,
    logicalOrder: value.logicalOrder,
    expiresAt: value.expiresAt,
  };
}

function parseRoomControlBase(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  return hasExactKeys(value, required)
    && value.v === SECURE_ROOM_PROTOCOL_VERSION
    && value.suite === SECURE_ROOM_MLS_CIPHERSUITE
    && isRoomInstance(value.roomInstance)
    && isMessageId(value.requestId);
}

/** Parse one already-decoded value or one bounded JSON WebSocket frame. */
export function parseSecureClientFrameV4(input: unknown): SecureClientFrameV4 | null {
  let value = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_SECURE_WEBSOCKET_FRAME_BYTES) return null;
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!isPlainDataRecord(value) || typeof value.kind !== "string") return null;

  if (value.kind === "setup" || value.kind === "join") {
    const required = ["kind", "requestId", "signaturePublicKey", "hello", "memberBinding"];
    if (!hasExactKeys(value, required) || !isMessageId(value.requestId)
      || !isFixedBase64Url(value.signaturePublicKey, SHA256_BYTES)) return null;
    const hello = parseHello(value.hello);
    const memberBinding = parseRoomInvitationMemberBindingV4(value.memberBinding);
    const expectedMode = value.kind === "setup" ? "founder" : "admission";
    if (!hello || !memberBinding || memberBinding.mode !== expectedMode
      || memberBinding.roomInstance !== hello.roomInstance
      || memberBinding.deviceId !== hello.deviceId
      || memberBinding.admissionId !== value.requestId
      || memberBinding.signaturePublicKey !== value.signaturePublicKey) return null;
    if (value.kind === "setup") {
      return {
        kind: "setup", requestId: value.requestId, signaturePublicKey: value.signaturePublicKey,
        hello, memberBinding,
      };
    }
    return {
      kind: "join", requestId: value.requestId, signaturePublicKey: value.signaturePublicKey,
      hello, memberBinding,
    };
  }
  if (value.kind === "resume") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "deviceId"];
    if (!parseRoomControlBase(value, keys) || !isDeviceId(value.deviceId)) return null;
    return {
      kind: "resume", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string, deviceId: value.deviceId,
    };
  }

  if (value.kind === "relay") {
    if (value.relayKind === "commit") {
      if (!hasExactKeys(value, ["kind", "relayKind", "grant", "envelope"], [
        "admissionId", "retirementDeviceId", "retirementAdmissionCommitMessageId",
      ])) return null;
      const grant = parseGrant(value.grant);
      const envelope = parseEnvelope(value.envelope);
      const hasAdmission = Object.prototype.hasOwnProperty.call(value, "admissionId");
      const hasRetirementDevice = Object.prototype.hasOwnProperty.call(value, "retirementDeviceId");
      const hasRetirementCommit = Object.prototype.hasOwnProperty.call(
        value,
        "retirementAdmissionCommitMessageId",
      );
      if (!grant || !envelope
        || (hasAdmission && !isMessageId(value.admissionId))
        || hasRetirementDevice !== hasRetirementCommit
        || (hasRetirementDevice && (!isDeviceId(value.retirementDeviceId)
          || !isMessageId(value.retirementAdmissionCommitMessageId)))
        || (hasAdmission && hasRetirementDevice)) return null;
      if (hasAdmission) {
        return {
          kind: "relay", relayKind: "commit", grant,
          admissionId: value.admissionId as string, envelope,
        };
      }
      if (hasRetirementDevice) {
        return {
          kind: "relay", relayKind: "commit", grant,
          retirementDeviceId: value.retirementDeviceId as string,
          retirementAdmissionCommitMessageId: value.retirementAdmissionCommitMessageId as string,
          envelope,
        };
      }
      return { kind: "relay", relayKind: "commit", grant, envelope };
    }
    if (value.relayKind === "welcome") {
      if (!hasExactKeys(value, ["kind", "relayKind", "admissionId", "commitMessageId", "envelope"])
        || !isMessageId(value.admissionId) || !isMessageId(value.commitMessageId)) return null;
      const envelope = parseEnvelope(value.envelope);
      return envelope ? {
        kind: "relay", relayKind: "welcome", admissionId: value.admissionId,
        commitMessageId: value.commitMessageId, envelope,
      } : null;
    }
    if (value.relayKind === "bootstrap") {
      if (!hasExactKeys(value, [
        "kind", "relayKind", "admissionId", "welcomeMessageId", "grant", "envelope",
      ]) || !isMessageId(value.admissionId) || !isMessageId(value.welcomeMessageId)) return null;
      const grant = parseGrant(value.grant);
      const envelope = parseEnvelope(value.envelope);
      return grant && envelope ? {
        kind: "relay", relayKind: "bootstrap", admissionId: value.admissionId,
        welcomeMessageId: value.welcomeMessageId, grant, envelope,
      } : null;
    }
    if (value.relayKind === "join-proof") {
      if (!hasExactKeys(value, ["kind", "relayKind", "admissionId", "welcomeMessageId", "grant", "envelope"])
        || !isMessageId(value.admissionId) || !isMessageId(value.welcomeMessageId)) return null;
      const grant = parseGrant(value.grant);
      const envelope = parseEnvelope(value.envelope);
      return grant && envelope ? {
        kind: "relay", relayKind: "join-proof", admissionId: value.admissionId,
        welcomeMessageId: value.welcomeMessageId, grant, envelope,
      } : null;
    }
    if (value.relayKind === "application") {
      if (!hasExactKeys(value, ["kind", "relayKind", "grant", "envelope"])) return null;
      const grant = parseGrant(value.grant);
      const envelope = parseEnvelope(value.envelope);
      return grant && envelope ? { kind: "relay", relayKind: "application", grant, envelope } : null;
    }
    if (value.relayKind === "host-transfer-accept") {
      if (!hasExactKeys(value, ["kind", "relayKind", "grant", "authorizationId", "envelope"])
        || !isMessageId(value.authorizationId)) return null;
      const grant = parseGrant(value.grant);
      const envelope = parseEnvelope(value.envelope);
      return grant && envelope ? {
        kind: "relay", relayKind: "host-transfer-accept", grant,
        authorizationId: value.authorizationId, envelope,
      } : null;
    }
    return null;
  }

  if (value.kind === "activate") {
    const keys = [
      "kind", "v", "suite", "roomInstance", "requestId", "deviceId", "admissionId",
      "proofMessageId", "signaturePublicKey",
    ];
    if (!parseRoomControlBase(value, keys) || !isDeviceId(value.deviceId)
      || !isMessageId(value.admissionId) || !isMessageId(value.proofMessageId)
      || !isFixedBase64Url(value.signaturePublicKey, SHA256_BYTES)) return null;
    return {
      kind: "activate", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string, deviceId: value.deviceId,
      admissionId: value.admissionId, proofMessageId: value.proofMessageId,
      signaturePublicKey: value.signaturePublicKey,
    };
  }
  if (value.kind === "order-request") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId"];
    if (!parseRoomControlBase(value, keys)) return null;
    return {
      kind: "order-request", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string,
    };
  }
  if (value.kind === "authorize-host-transfer") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "deviceId", "offerMessageId"];
    if (!parseRoomControlBase(value, keys) || !isDeviceId(value.deviceId)
      || !isMessageId(value.offerMessageId)) return null;
    return {
      kind: "authorize-host-transfer", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string, deviceId: value.deviceId, offerMessageId: value.offerMessageId,
    };
  }
  if (value.kind === "retire-member") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "deviceId", "commitMessageId"];
    if (!parseRoomControlBase(value, keys) || !isDeviceId(value.deviceId)
      || !isMessageId(value.commitMessageId)) return null;
    return {
      kind: "retire-member", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string, deviceId: value.deviceId,
      commitMessageId: value.commitMessageId,
    };
  }
  if (value.kind === "cancel-admission") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "deviceId", "admissionId"];
    if (!parseRoomControlBase(value, keys) || !isDeviceId(value.deviceId)
      || !isMessageId(value.admissionId)) return null;
    return {
      kind: "cancel-admission", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string, deviceId: value.deviceId, admissionId: value.admissionId,
    };
  }
  if (value.kind === "close-room") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "authorizationMessageId"];
    if (!parseRoomControlBase(value, keys) || !isMessageId(value.authorizationMessageId)) return null;
    return {
      kind: "close-room", v: 4, suite: 1, roomInstance: value.roomInstance as string,
      requestId: value.requestId as string, authorizationMessageId: value.authorizationMessageId,
    };
  }
  if (value.kind === "application-decision" || value.kind === "commit-decision") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "messageId", "decision"];
    if (!parseRoomControlBase(value, keys) || !isMessageId(value.messageId)
      || (value.decision !== "approve" && value.decision !== "reject")) return null;
    return {
      kind: value.kind, v: 4, suite: 1,
      roomInstance: value.roomInstance as string, requestId: value.requestId as string,
      messageId: value.messageId, decision: value.decision,
    };
  }
  if (value.kind === "resume-complete" || value.kind === "delivery-ack") {
    const keys = ["kind", "v", "suite", "roomInstance", "requestId", "lastMessageId"];
    if (!parseRoomControlBase(value, keys) || !isMessageId(value.lastMessageId)) return null;
    return {
      kind: value.kind, v: 4, suite: 1,
      roomInstance: value.roomInstance as string, requestId: value.requestId as string,
      lastMessageId: value.lastMessageId,
    };
  }
  return null;
}

function parseActor(value: unknown): SecureRelayActorV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, ["deviceId", "connectionId", "authentication"])
    || !isDeviceId(value.deviceId) || !isMessageId(value.connectionId)
    || (value.authentication !== "invitation" && value.authentication !== "device")) return null;
  return { deviceId: value.deviceId, connectionId: value.connectionId, authentication: value.authentication };
}

function parseReplayRecord(value: unknown): SecureReplayRecordV4 | null {
  const kinds: readonly SecureReplayKindV4[] = [
    "setup-request", "join-request", "resume-request", "commit", "commit-pending", "commit-rejected",
    "welcome", "bootstrap", "join-proof", "join-proof-pending",
    "application", "application-pending", "application-rejected", "order-request", "order-cancelled",
    "grant-token", "grant-expired", "activate",
    "authorize-host-transfer", "retire-member", "cancel-admission", "close-room",
    "application-decision", "commit-decision", "resume-complete", "delivery-ack",
  ];
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "id", "kind", "deviceId", "acceptedAt", "logicalOrder", "rejectionReason", "frameDigest",
  ])
    || !isMessageId(value.id) || !kinds.includes(value.kind as SecureReplayKindV4)
    || !isDeviceId(value.deviceId) || !isSafeTimestamp(value.acceptedAt)
    || !(value.logicalOrder === null || isPositiveSafeInteger(value.logicalOrder))
    || !(value.rejectionReason === null || value.rejectionReason === "host-rejected"
      || value.rejectionReason === "approval-expired" || value.rejectionReason === "grant-expired"
      || value.rejectionReason === "member-retired" || value.rejectionReason === "connection-lost"
      || value.rejectionReason === "delivery-pending"
      || value.rejectionReason === "removal-pending" || value.rejectionReason === "admission-pending")
    || !(value.frameDigest === null || isFixedBase64Url(value.frameDigest, SHA256_BYTES))) return null;
  const kind = value.kind as SecureReplayKindV4;
  const ordered = kind === "bootstrap" || kind === "join-proof" || kind === "join-proof-pending"
    || kind === "application" || kind === "application-pending" || kind === "application-rejected";
  const rejected = kind === "application-rejected" || kind === "commit-rejected"
    || kind === "order-cancelled";
  if (ordered !== (value.logicalOrder !== null)
    || (rejected !== (value.rejectionReason !== null))) return null;
  const fingerprinted = kind === "join-request" || kind === "commit" || kind === "commit-pending"
    || kind === "commit-rejected" || kind === "welcome" || kind === "bootstrap"
    || kind === "join-proof" || kind === "join-proof-pending"
    || kind === "application" || kind === "application-pending" || kind === "application-rejected"
    || kind === "activate" || kind === "application-decision"
    || kind === "commit-decision"
    || kind === "authorize-host-transfer"
    || kind === "retire-member" || kind === "cancel-admission" || kind === "close-room"
    || kind === "resume-complete" || kind === "delivery-ack";
  if (fingerprinted !== (value.frameDigest !== null)) return null;
  return {
    id: value.id,
    kind,
    deviceId: value.deviceId,
    acceptedAt: value.acceptedAt,
    logicalOrder: value.logicalOrder,
    rejectionReason: value.rejectionReason,
    frameDigest: value.frameDigest,
  };
}

function backlogEntryBytes(entry: SecureBacklogEntryV4): number {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
}

function parseBacklogEntry(value: unknown): SecureBacklogEntryV4 | null {
  if (!isPlainDataRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "relay") {
    if (!hasExactKeys(value, ["kind", "receivedAt", "fromDeviceId", "logicalOrder", "frame"])
      || !isSafeTimestamp(value.receivedAt)
      || !isDeviceId(value.fromDeviceId)
      || !(value.logicalOrder === null || isPositiveSafeInteger(value.logicalOrder))) return null;
    const frame = parseSecureClientFrameV4(value.frame);
    if (!frame || frame.kind !== "relay"
      || (frame.relayKind !== "commit" && frame.relayKind !== "welcome" && frame.relayKind !== "bootstrap"
        && frame.relayKind !== "join-proof" && frame.relayKind !== "application"
        && frame.relayKind !== "host-transfer-accept")) return null;
    if ((frame.relayKind === "commit" || frame.relayKind === "welcome") !== (value.logicalOrder === null)) return null;
    if ((frame.relayKind === "application" || frame.relayKind === "host-transfer-accept"
      || frame.relayKind === "bootstrap")
      && frame.grant.logicalOrder !== value.logicalOrder) return null;
    if (frame.relayKind === "join-proof" && frame.grant.logicalOrder !== value.logicalOrder) return null;
    return {
      kind: "relay",
      receivedAt: value.receivedAt,
      fromDeviceId: value.fromDeviceId,
      logicalOrder: value.logicalOrder,
      frame,
    };
  }
  if (value.kind === "application-result") {
    if (!hasExactKeys(value, ["kind", "receivedAt", "logicalOrder", "messageId", "result", "reason"])
      || !isSafeTimestamp(value.receivedAt) || !isPositiveSafeInteger(value.logicalOrder)
      || !isMessageId(value.messageId) || (value.result !== "accepted" && value.result !== "rejected")
      || !(value.reason === null || value.reason === "host-rejected" || value.reason === "approval-expired"
        || value.reason === "grant-expired"
        || value.reason === "member-retired" || value.reason === "removal-pending"
        || value.reason === "admission-pending")) return null;
    if ((value.result === "accepted") !== (value.reason === null)) return null;
    return {
      kind: "application-result", receivedAt: value.receivedAt, logicalOrder: value.logicalOrder,
      messageId: value.messageId, result: value.result, reason: value.reason,
    };
  }
  if (value.kind === "commit-result") {
    if (!hasExactKeys(value, ["kind", "receivedAt", "logicalOrder", "messageId", "result", "reason"])
      || !isSafeTimestamp(value.receivedAt) || value.logicalOrder !== null
      || !isMessageId(value.messageId) || (value.result !== "accepted" && value.result !== "rejected")
      || !(value.reason === null || value.reason === "host-rejected" || value.reason === "approval-expired"
        || value.reason === "grant-expired"
        || value.reason === "member-retired" || value.reason === "removal-pending"
        || value.reason === "admission-pending")) return null;
    if ((value.result === "accepted") !== (value.reason === null)) return null;
    return {
      kind: "commit-result", receivedAt: value.receivedAt, logicalOrder: null,
      messageId: value.messageId, result: value.result, reason: value.reason,
    };
  }
  if (value.kind === "host-transfer-authorization") {
    if (!hasExactKeys(value, [
      "kind", "receivedAt", "logicalOrder", "fromHostDeviceId", "authorizationId", "offerMessageId", "expiresAt",
    ]) || !isSafeTimestamp(value.receivedAt) || value.logicalOrder !== null
      || !isDeviceId(value.fromHostDeviceId) || !isMessageId(value.authorizationId)
      || !isMessageId(value.offerMessageId) || !isSafeTimestamp(value.expiresAt)
      || value.expiresAt <= value.receivedAt) return null;
    return {
      kind: "host-transfer-authorization",
      receivedAt: value.receivedAt,
      logicalOrder: null,
      fromHostDeviceId: value.fromHostDeviceId,
      authorizationId: value.authorizationId,
      offerMessageId: value.offerMessageId,
      expiresAt: value.expiresAt,
    };
  }
  return null;
}

function backlogEntryMessageId(entry: SecureBacklogEntryV4): string {
  if (entry.kind === "relay") return entry.frame.envelope.messageId;
  if (entry.kind === "application-result" || entry.kind === "commit-result") return entry.messageId;
  return entry.authorizationId;
}

function parseMember(value: unknown): SecureRelayMemberStateV4 | null {
  const legacyKeys = [
    "deviceId", "signaturePublicKey", "memberBinding", "status", "joinedOrder", "connectionId", "resumeStatus", "resumePhase",
    "disconnectExpiresAt", "admissionId",
    "admissionExpiresAt",
    "keyPackage", "keyPackageDigest", "pendingPhase", "admissionCommitMessageId", "membershipCommitMessageId",
    "welcomeMessageId", "proofMessageId", "proofFrame", "proofGrant",
    "backlog", "backlogBytes", "requiresFreshAdmission",
  ];
  const keys = [...legacyKeys, "resumeRequestId"];
  const hasResumeRequestId = isPlainDataRecord(value)
    && Object.prototype.hasOwnProperty.call(value, "resumeRequestId");
  const resumeRequestId = hasResumeRequestId && isPlainDataRecord(value)
    ? value.resumeRequestId
    : null;
  const memberBinding = isPlainDataRecord(value)
    ? parseRoomInvitationMemberBindingV4(value.memberBinding)
    : null;
  if (!isPlainDataRecord(value)
    || (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, keys))
    || !isDeviceId(value.deviceId)
    || !isFixedBase64Url(value.signaturePublicKey, SHA256_BYTES)
    || !memberBinding || memberBinding.deviceId !== value.deviceId
    || memberBinding.signaturePublicKey !== value.signaturePublicKey
    || !["pending", "active", "disconnected", "retired"].includes(value.status as string)
    || !isPositiveSafeInteger(value.joinedOrder)
    || !(value.connectionId === null || isMessageId(value.connectionId))
    || !(value.resumeStatus === null || value.resumeStatus === "active")
    || !(value.resumePhase === null || value.resumePhase === "replaying-backlog")
    || !(resumeRequestId === null || isMessageId(resumeRequestId))
    || !(value.disconnectExpiresAt === null || isSafeTimestamp(value.disconnectExpiresAt))
    || !(value.admissionId === null || isMessageId(value.admissionId))
    || !(value.admissionExpiresAt === null || isSafeTimestamp(value.admissionExpiresAt))
    || !(value.keyPackage === null || (typeof value.keyPackage === "string"
      && (canonicalBase64UrlByteLength(value.keyPackage) || 0) <= MAX_MLS_KEY_PACKAGE_BYTES
      && canonicalBase64UrlByteLength(value.keyPackage) !== null))
    || !(value.keyPackageDigest === null || isFixedBase64Url(value.keyPackageDigest, SHA256_BYTES))
    || !(value.pendingPhase === null || value.pendingPhase === "awaiting-welcome"
      || value.pendingPhase === "awaiting-bootstrap" || value.pendingPhase === "awaiting-proof")
    || !(value.admissionCommitMessageId === null || isMessageId(value.admissionCommitMessageId))
    || !(value.membershipCommitMessageId === null || isMessageId(value.membershipCommitMessageId))
    || !(value.welcomeMessageId === null || isMessageId(value.welcomeMessageId))
    || !(value.proofMessageId === null || isMessageId(value.proofMessageId))
    || !isPlainDataArray(value.backlog) || value.backlog.length > MAX_SECURE_DEVICE_BACKLOG_ENTRIES_V4
    || !isSafeTimestamp(value.backlogBytes) || typeof value.requiresFreshAdmission !== "boolean") return null;
  if ((value.joinedOrder === 1) !== (memberBinding.mode === "founder")) return null;
  if (value.keyPackageDigest !== null && memberBinding.keyPackageDigest !== value.keyPackageDigest) return null;

  const backlog: SecureBacklogEntryV4[] = [];
  let calculatedBacklogBytes = 0;
  let lastReceivedAt = -1;
  for (const raw of value.backlog) {
    const entry = parseBacklogEntry(raw);
    if (!entry || entry.receivedAt < lastReceivedAt) return null;
    calculatedBacklogBytes += backlogEntryBytes(entry);
    if (calculatedBacklogBytes > MAX_SECURE_DEVICE_BACKLOG_BYTES_V4) return null;
    lastReceivedAt = entry.receivedAt;
    backlog.push(entry);
  }
  if (calculatedBacklogBytes !== value.backlogBytes
    || new Set(backlog.map(backlogEntryMessageId)).size !== backlog.length) return null;

  const status = value.status as SecureMemberLifecycleV4;
  const proofFrame = value.proofFrame === null ? null : parseSecureClientFrameV4(value.proofFrame);
  if (value.proofFrame !== null && (!proofFrame || proofFrame.kind !== "relay"
    || proofFrame.relayKind !== "join-proof")) return null;
  const proofGrant = value.proofGrant === null ? null : parseGrantState(value.proofGrant);
  if (value.proofGrant !== null && !proofGrant) return null;
  const connected = status === "active" || status === "pending";
  if (connected !== (value.connectionId !== null) || (connected && value.resumeStatus !== null)) return null;

  const replaying = (status === "pending" || (status === "disconnected" && value.resumeStatus === "active"))
    && value.resumePhase === "replaying-backlog";
  if ((resumeRequestId !== null && !replaying)
    || (replaying && backlog.length === 0 && resumeRequestId === null)) return null;
  const admissionPending = (status === "pending" || status === "disconnected")
    && value.resumeStatus === null && value.admissionId !== null;
  if (admissionPending) {
    if (value.resumePhase !== null || value.admissionExpiresAt === null
      || value.keyPackageDigest === null || value.pendingPhase === null
      || memberBinding.admissionId !== value.admissionId) return null;
    if (value.pendingPhase === "awaiting-welcome") {
      if (value.keyPackage === null || value.welcomeMessageId !== null || value.proofMessageId !== null
        || proofFrame !== null || proofGrant !== null) return null;
    } else if (value.pendingPhase === "awaiting-bootstrap") {
      if (value.keyPackage !== null || value.admissionCommitMessageId === null
        || value.welcomeMessageId === null || value.proofMessageId !== null || proofFrame !== null
        || proofGrant !== null) return null;
    } else if (value.keyPackage !== null || value.admissionCommitMessageId === null
      || value.welcomeMessageId === null || proofGrant === null
      || (value.proofMessageId === null) !== (proofFrame === null)) return null;
  } else if (value.admissionId !== null || value.admissionExpiresAt !== null
    || value.keyPackage !== null || value.keyPackageDigest !== null
    || value.pendingPhase !== null || value.admissionCommitMessageId !== null
    || value.welcomeMessageId !== null || value.proofMessageId !== null || proofFrame !== null
    || proofGrant !== null) return null;

  if (status === "disconnected" && value.resumeStatus === null && !admissionPending) return null;
  if (status === "retired" && (value.connectionId !== null || value.resumeStatus !== null || value.resumePhase !== null)) return null;
  if (status === "active" && value.resumePhase !== null) return null;
  if (status === "pending" && !admissionPending && !replaying) return null;
  if ((status === "active" || (status === "disconnected" && value.resumeStatus === "active")
    || replaying || admissionPending)
    && value.signaturePublicKey === null) return null;
  const backlogAllowed = status === "active" || status === "pending"
    || (status === "disconnected" && (value.resumeStatus === "active" || admissionPending));
  if (!backlogAllowed && backlog.length !== 0) return null;
  if (value.requiresFreshAdmission && (status !== "disconnected" || value.resumeStatus !== "active"
    || value.resumePhase !== null || backlog.length !== 0)) return null;
  if (value.requiresFreshAdmission && value.signaturePublicKey === null) return null;
  const boundedActiveDisconnect = status === "disconnected" && value.resumeStatus === "active"
    && !value.requiresFreshAdmission;
  if (boundedActiveDisconnect !== (value.disconnectExpiresAt !== null)) return null;
  if (!boundedActiveDisconnect && value.disconnectExpiresAt !== null) return null;

  return {
    deviceId: value.deviceId,
    signaturePublicKey: value.signaturePublicKey,
    memberBinding,
    status,
    joinedOrder: value.joinedOrder,
    connectionId: value.connectionId,
    resumeStatus: value.resumeStatus,
    resumePhase: value.resumePhase,
    resumeRequestId: resumeRequestId as string | null,
    disconnectExpiresAt: value.disconnectExpiresAt,
    admissionId: value.admissionId,
    admissionExpiresAt: value.admissionExpiresAt,
    keyPackage: value.keyPackage,
    keyPackageDigest: value.keyPackageDigest,
    pendingPhase: value.pendingPhase,
    admissionCommitMessageId: value.admissionCommitMessageId,
    membershipCommitMessageId: value.membershipCommitMessageId,
    welcomeMessageId: value.welcomeMessageId,
    proofMessageId: value.proofMessageId,
    proofFrame: proofFrame as SecureJoinProofRelayFrameV4 | null,
    proofGrant,
    backlog,
    backlogBytes: value.backlogBytes,
    requiresFreshAdmission: value.requiresFreshAdmission,
  } as SecureRelayMemberStateV4;
}

function parseQueueEntry(value: unknown): SecureOrderQueueEntryV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, ["deviceId", "connectionId", "requestId", "enqueuedAt"])
    || !isDeviceId(value.deviceId) || !isMessageId(value.connectionId)
    || !isMessageId(value.requestId) || !isSafeTimestamp(value.enqueuedAt)) return null;
  return {
    deviceId: value.deviceId, connectionId: value.connectionId,
    requestId: value.requestId, enqueuedAt: value.enqueuedAt,
  };
}

function parseGrantState(value: unknown): SecureGrantStateV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "v", "suite", "roomInstance", "requestId", "tokenId", "deviceId", "logicalOrder", "expiresAt", "connectionId",
  ]) || !isMessageId(value.connectionId)) return null;
  const grant = parseGrant({
    v: value.v,
    suite: value.suite,
    roomInstance: value.roomInstance,
    requestId: value.requestId,
    tokenId: value.tokenId,
    deviceId: value.deviceId,
    logicalOrder: value.logicalOrder,
    expiresAt: value.expiresAt,
  });
  return grant ? { ...grant, connectionId: value.connectionId } : null;
}

function parsePendingApplication(value: unknown): SecurePendingApplicationStateV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "fromDeviceId", "connectionId", "logicalOrder", "receivedAt", "decisionExpiresAt", "frame",
  ]) || !isDeviceId(value.fromDeviceId) || !isMessageId(value.connectionId)
    || !isPositiveSafeInteger(value.logicalOrder) || !isSafeTimestamp(value.receivedAt)
    || !isSafeTimestamp(value.decisionExpiresAt) || value.decisionExpiresAt <= value.receivedAt
    || value.decisionExpiresAt - value.receivedAt !== SECURE_APPLICATION_APPROVAL_TTL_MS_V4) return null;
  const frame = parseSecureClientFrameV4(value.frame);
  if (!frame || frame.kind !== "relay"
    || (frame.relayKind !== "application" && frame.relayKind !== "host-transfer-accept")) return null;
  return {
    fromDeviceId: value.fromDeviceId,
    connectionId: value.connectionId,
    logicalOrder: value.logicalOrder,
    receivedAt: value.receivedAt,
    decisionExpiresAt: value.decisionExpiresAt,
    frame,
  };
}

function parsePendingCommit(value: unknown): SecurePendingCommitStateV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "fromDeviceId", "connectionId", "receivedAt", "decisionExpiresAt", "frame",
  ]) || !isDeviceId(value.fromDeviceId) || !isMessageId(value.connectionId)
    || !isSafeTimestamp(value.receivedAt) || !isSafeTimestamp(value.decisionExpiresAt)
    || value.decisionExpiresAt <= value.receivedAt
    || value.decisionExpiresAt - value.receivedAt !== SECURE_COMMIT_APPROVAL_TTL_MS_V4) return null;
  const frame = parseSecureClientFrameV4(value.frame);
  if (!frame || frame.kind !== "relay" || frame.relayKind !== "commit"
    || frame.admissionId !== undefined) return null;
  return {
    fromDeviceId: value.fromDeviceId,
    connectionId: value.connectionId,
    receivedAt: value.receivedAt,
    decisionExpiresAt: value.decisionExpiresAt,
    frame,
  };
}

function parsePendingHostTransfer(value: unknown): SecurePendingHostTransferStateV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "authorizationId", "hostDeviceId", "targetDeviceId", "offerMessageId", "authorizedAt", "expiresAt",
  ]) || !isMessageId(value.authorizationId) || !isDeviceId(value.hostDeviceId)
    || !isDeviceId(value.targetDeviceId) || value.targetDeviceId === value.hostDeviceId
    || !isMessageId(value.offerMessageId) || !isSafeTimestamp(value.authorizedAt)
    || !isSafeTimestamp(value.expiresAt) || value.expiresAt <= value.authorizedAt
    || value.expiresAt - value.authorizedAt !== SECURE_HOST_TRANSFER_TTL_MS_V4) return null;
  return {
    authorizationId: value.authorizationId,
    hostDeviceId: value.hostDeviceId,
    targetDeviceId: value.targetDeviceId,
    offerMessageId: value.offerMessageId,
    authorizedAt: value.authorizedAt,
    expiresAt: value.expiresAt,
  };
}

function parseZombieRemoval(value: unknown): SecureZombieRemovalStateV4 | null {
  if (!isPlainDataRecord(value) || !hasExactKeys(value, [
    "deviceId", "admissionCommitMessageId", "requestedAt", "removalCommitMessageId",
  ]) || !isDeviceId(value.deviceId) || !isMessageId(value.admissionCommitMessageId)
    || !isSafeTimestamp(value.requestedAt)
    || !(value.removalCommitMessageId === null || isMessageId(value.removalCommitMessageId))) return null;
  return {
    deviceId: value.deviceId,
    admissionCommitMessageId: value.admissionCommitMessageId,
    requestedAt: value.requestedAt,
    removalCommitMessageId: value.removalCommitMessageId,
  };
}

/**
 * Validate and defensively copy a persisted snapshot.  This function rejects
 * unknown fields, hostile prototypes, impossible lifecycle combinations, and
 * unbounded collections before any state is used.
 */
export function parseSecureRelayStateV4(value: unknown): SecureRelayStateV4 | null {
  const keys = [
    "schema", "revision", "clockHighWater", "v", "suite", "roomInstance", "lifecycle", "hostDeviceId", "members",
    "nextMemberOrder", "nextLogicalOrder", "currentGrant", "pendingApplication", "pendingCommit", "pendingHostTransfer",
    "pendingZombieRemovals",
    "orderQueue", "recentMessages",
    "recentKeyPackageDigests",
  ];
  if (!isPlainDataRecord(value) || !hasExactKeys(value, keys)
    || value.schema !== SECURE_RELAY_STATE_SCHEMA_V4 || !isPositiveSafeInteger(value.revision)
    || !isSafeTimestamp(value.clockHighWater) || value.v !== 4 || value.suite !== 1
    || !isRoomInstance(value.roomInstance) || (value.lifecycle !== "open" && value.lifecycle !== "retired")
    || !(value.hostDeviceId === null || isDeviceId(value.hostDeviceId))
    || !isPlainDataArray(value.members) || value.members.length < 1
    || value.members.length > MAX_SECURE_RELAY_MEMBERS_V4 + MAX_SECURE_RETIRED_TOMBSTONES_V4
    || !isPositiveSafeInteger(value.nextMemberOrder) || !isPositiveSafeInteger(value.nextLogicalOrder)
    || !isPlainDataArray(value.orderQueue) || value.orderQueue.length > MAX_SECURE_ORDER_QUEUE_V4
    || !isPlainDataArray(value.pendingZombieRemovals)
    || value.pendingZombieRemovals.length > MAX_SECURE_ZOMBIE_REMOVALS_V4
    || !isPlainDataArray(value.recentMessages) || value.recentMessages.length > MAX_SECURE_REPLAY_RECORDS_V4
    || !isPlainDataArray(value.recentKeyPackageDigests)
    || value.recentKeyPackageDigests.length > MAX_SECURE_KEY_PACKAGE_DIGESTS_V4) return null;

  const members: SecureRelayMemberStateV4[] = [];
  for (const raw of value.members) {
    const member = parseMember(raw);
    if (!member) return null;
    members.push(member);
  }
  if (new Set(members.map((member) => member.deviceId)).size !== members.length
    || new Set(members.map((member) => member.joinedOrder)).size !== members.length
    || new Set(members.map((member) => member.memberBinding.admissionId)).size !== members.length
    || new Set(members.map((member) => member.memberBinding.keyPackageDigest)).size !== members.length
    || members.filter((member) => member.memberBinding.mode === "founder").length !== 1
    || members.some((member) => member.memberBinding.roomInstance !== value.roomInstance)
    || members.some((member) => member.joinedOrder >= (value.nextMemberOrder as number))) return null;
  if (members.filter((member) => member.status !== "retired").length > MAX_SECURE_RELAY_MEMBERS_V4
    || members.filter((member) => member.status === "retired").length > MAX_SECURE_RETIRED_TOMBSTONES_V4) return null;
  for (const member of members) {
    if (member.proofFrame && (member.proofFrame.envelope.roomInstance !== value.roomInstance
      || member.proofFrame.envelope.messageId !== member.proofMessageId
      || member.proofFrame.admissionId !== member.admissionId
      || member.proofFrame.welcomeMessageId !== member.welcomeMessageId
      || member.proofFrame.grant.logicalOrder !== value.nextLogicalOrder)) return null;
    if (member.proofGrant && (member.admissionId === null || member.admissionExpiresAt === null
      || member.proofGrant.roomInstance !== value.roomInstance
      || member.proofGrant.requestId !== member.admissionId
      || member.proofGrant.deviceId !== member.deviceId
      || member.proofGrant.logicalOrder !== value.nextLogicalOrder
      || member.proofGrant.expiresAt !== member.admissionExpiresAt
      || (member.connectionId !== null && member.proofGrant.connectionId !== member.connectionId)
      || (member.proofFrame !== null && !grantEquals(member.proofFrame.grant, member.proofGrant)))) return null;
    let lastLogicalOrder = 0;
    for (const entry of member.backlog) {
      if (entry.receivedAt > (value.clockHighWater as number)) return null;
      if (entry.kind === "relay") {
        const welcomeRoute = entry.frame.relayKind === "welcome"
          && entry.frame.envelope.route === "device" && entry.frame.envelope.to === member.deviceId;
        const groupRoute = entry.frame.relayKind !== "welcome"
          && entry.frame.envelope.route === "group" && entry.frame.envelope.to === undefined;
        if (entry.frame.envelope.roomInstance !== value.roomInstance || (!welcomeRoute && !groupRoute)
          || entry.fromDeviceId === member.deviceId) return null;
        if (entry.frame.relayKind === "commit" && (entry.frame.grant.deviceId !== entry.fromDeviceId
          || entry.frame.grant.roomInstance !== value.roomInstance
          || entry.frame.grant.logicalOrder > (value.nextLogicalOrder as number))) return null;
      }
      if (entry.kind === "host-transfer-authorization"
        && entry.fromHostDeviceId === member.deviceId) return null;
      if (entry.logicalOrder !== null) {
        if (entry.logicalOrder < lastLogicalOrder) return null;
        if (entry.kind === "relay" && entry.logicalOrder >= (value.nextLogicalOrder as number)) return null;
        if (entry.kind === "application-result" && entry.result === "accepted"
          && entry.logicalOrder >= (value.nextLogicalOrder as number)) return null;
        if (entry.kind === "application-result" && entry.result === "rejected"
          && entry.logicalOrder > (value.nextLogicalOrder as number)) return null;
        lastLogicalOrder = entry.logicalOrder;
      }
    }
  }
  const connectionIds = members.flatMap((member) => member.connectionId === null ? [] : [member.connectionId]);
  if (new Set(connectionIds).size !== connectionIds.length) return null;

  const recentMessages: SecureReplayRecordV4[] = [];
  for (const raw of value.recentMessages) {
    const record = parseReplayRecord(raw);
    if (!record) return null;
    recentMessages.push(record);
  }
  if (new Set(recentMessages.map((record) => record.id)).size !== recentMessages.length) return null;
  if (recentMessages.some((record) => !members.some((member) => member.deviceId === record.deviceId))) return null;
  if (recentMessages.some((record) => record.acceptedAt > (value.clockHighWater as number))) return null;
  const replayById = new Map(recentMessages.map((record) => [record.id, record]));
  for (const member of members) {
    if (member.disconnectExpiresAt !== null && member.disconnectExpiresAt <= (value.clockHighWater as number)) {
      return null;
    }
    const admissionRecord = replayById.get(member.memberBinding.admissionId);
    const founder = member.memberBinding.mode === "founder";
    if (!admissionRecord || admissionRecord.deviceId !== member.deviceId
      || admissionRecord.kind !== (founder ? "setup-request" : "join-request")) return null;
    if (founder && member.membershipCommitMessageId !== member.memberBinding.admissionId) return null;
    if (member.resumeRequestId !== null) {
      const resumeRecord = replayById.get(member.resumeRequestId);
      if (!resumeRecord || resumeRecord.kind !== "resume-request"
        || resumeRecord.deviceId !== member.deviceId) return null;
    }
    if (member.admissionId === null) continue;
    const joinRecord = replayById.get(member.admissionId);
    if (!joinRecord || joinRecord.kind !== "join-request" || joinRecord.deviceId !== member.deviceId
      || member.admissionExpiresAt !== joinRecord.acceptedAt + SECURE_ADMISSION_TTL_MS_V4) {
      return null;
    }
    if (member.proofGrant && !recentMessages.some((record) => record.id === member.proofGrant!.tokenId
      && record.kind === "grant-token" && record.deviceId === member.deviceId)) return null;
  }
  for (const member of members) {
    const membershipAdmission = replayById.get(member.memberBinding.admissionId)!;
    const membershipEstablishment = member.membershipCommitMessageId === null
      ? null
      : replayById.get(member.membershipCommitMessageId) || null;
    const establishmentSender = membershipEstablishment === null
      ? null
      : members.find((candidate) => candidate.deviceId === membershipEstablishment.deviceId) || null;
    if (membershipEstablishment && (member.joinedOrder === 1
      ? membershipEstablishment.kind !== "setup-request"
        || membershipEstablishment.deviceId !== member.deviceId
      : membershipEstablishment.kind !== "commit"
        || membershipEstablishment.deviceId === member.deviceId
        || establishmentSender === null
        || establishmentSender.joinedOrder >= member.joinedOrder
        || membershipEstablishment.acceptedAt < membershipAdmission.acceptedAt)) return null;
    if ((member.membershipCommitMessageId !== null) !== (membershipEstablishment !== null)) return null;
    const needsEstablishedMembership = member.admissionId === null
      && (member.status === "active" || (member.status === "pending" && member.resumePhase === "replaying-backlog")
        || (member.status === "disconnected" && member.resumeStatus === "active"));
    if (needsEstablishedMembership && membershipEstablishment === null) return null;
  }
  for (const member of members) {
    for (const entry of member.backlog) {
      if (entry.kind === "application-result") {
        const record = replayById.get(entry.messageId);
        const expectedAcceptedKind = record?.kind === "application" || record?.kind === "join-proof";
        if (!record || record.deviceId !== member.deviceId
          || record.logicalOrder !== entry.logicalOrder
          || record.acceptedAt > entry.receivedAt
          || (entry.result === "accepted"
            ? !expectedAcceptedKind || record.rejectionReason !== null
            : record.kind !== "application-rejected" || record.rejectionReason !== entry.reason)) return null;
      } else if (entry.kind === "commit-result") {
        const record = replayById.get(entry.messageId);
        if (!record || record.deviceId !== member.deviceId || record.logicalOrder !== null
          || record.acceptedAt > entry.receivedAt
          || (entry.result === "accepted"
            ? record.kind !== "commit" || record.rejectionReason !== null
            : record.kind !== "commit-rejected" || record.rejectionReason !== entry.reason)) return null;
      } else if (entry.kind === "host-transfer-authorization") {
        const record = replayById.get(entry.authorizationId);
        if (!record || record.kind !== "authorize-host-transfer"
          || record.deviceId !== entry.fromHostDeviceId || record.logicalOrder !== null
          || record.rejectionReason !== null || record.acceptedAt > entry.receivedAt) return null;
      } else {
        const record = replayById.get(entry.frame.envelope.messageId);
        const expectedKind: SecureReplayKindV4 = entry.frame.relayKind === "host-transfer-accept"
          ? "application"
          : entry.frame.relayKind;
        if (!record || record.kind !== expectedKind || record.deviceId !== entry.fromDeviceId
          || record.logicalOrder !== entry.logicalOrder || record.rejectionReason !== null
          || record.frameDigest === null || record.acceptedAt > entry.receivedAt) return null;
        if (entry.frame.relayKind === "commit" && entry.frame.retirementDeviceId !== undefined) {
          const retirementDeviceId = entry.frame.retirementDeviceId;
          const retiredTarget = members.find((candidate) =>
            candidate.deviceId === retirementDeviceId);
          if (!retiredTarget
            || retiredTarget.memberBinding.admissionId
              !== entry.frame.retirementAdmissionCommitMessageId
            || (retiredTarget.status !== "retired"
              && !(retiredTarget.status === "disconnected"
                && retiredTarget.requiresFreshAdmission))) return null;
        }
      }
    }
  }
  for (const record of recentMessages) {
    if (record.logicalOrder === null) continue;
    const pending = record.kind === "application-pending" || record.kind === "join-proof-pending";
    const rejected = record.kind === "application-rejected";
    if ((!pending && !rejected && record.logicalOrder >= (value.nextLogicalOrder as number))
      || ((pending || rejected) && record.logicalOrder > (value.nextLogicalOrder as number))) return null;
  }

  const recentKeyPackageDigests: string[] = [];
  for (const digest of value.recentKeyPackageDigests) {
    if (!isFixedBase64Url(digest, SHA256_BYTES)) return null;
    recentKeyPackageDigests.push(digest);
  }
  if (new Set(recentKeyPackageDigests).size !== recentKeyPackageDigests.length
    || members.some((member) => !recentKeyPackageDigests.includes(member.memberBinding.keyPackageDigest))) return null;

  const orderQueue: SecureOrderQueueEntryV4[] = [];
  let lastEnqueuedAt = -1;
  for (const raw of value.orderQueue) {
    const entry = parseQueueEntry(raw);
    if (!entry || entry.enqueuedAt < lastEnqueuedAt
      || entry.enqueuedAt > (value.clockHighWater as number)) return null;
    const member = members.find((candidate) => candidate.deviceId === entry.deviceId);
    if (!member || member.status !== "active" || member.connectionId !== entry.connectionId) return null;
    if (member.backlog.length !== 0) return null;
    lastEnqueuedAt = entry.enqueuedAt;
    orderQueue.push(entry);
  }
  if (new Set(orderQueue.map((entry) => entry.deviceId)).size !== orderQueue.length
    || new Set(orderQueue.map((entry) => entry.requestId)).size !== orderQueue.length) return null;

  const currentGrant = value.currentGrant === null ? null : parseGrantState(value.currentGrant);
  if (value.currentGrant !== null && !currentGrant) return null;
  if (currentGrant) {
    const owner = members.find((member) => member.deviceId === currentGrant.deviceId);
    if (!owner || owner.status !== "active" || owner.connectionId !== currentGrant.connectionId
      || owner.backlog.length !== 0
      || currentGrant.roomInstance !== value.roomInstance || currentGrant.logicalOrder !== value.nextLogicalOrder
      || orderQueue.some((entry) => entry.deviceId === currentGrant.deviceId)) return null;
  }

  const pendingApplication = value.pendingApplication === null ? null : parsePendingApplication(value.pendingApplication);
  if (value.pendingApplication !== null && !pendingApplication) return null;
  const pendingApplicationRecords = recentMessages.filter((record) => record.kind === "application-pending");
  if (!pendingApplication) {
    if (pendingApplicationRecords.length !== 0) return null;
  } else if (pendingApplicationRecords.length !== 1
    || pendingApplicationRecords[0].id !== pendingApplication.frame.envelope.messageId
    || pendingApplicationRecords[0].deviceId !== pendingApplication.fromDeviceId
    || pendingApplicationRecords[0].logicalOrder !== pendingApplication.logicalOrder) return null;
  if (pendingApplication) {
    const sender = members.find((member) => member.deviceId === pendingApplication.fromDeviceId);
    if (!sender || sender.deviceId === value.hostDeviceId || (sender.status !== "active"
      && !(sender.status === "disconnected" && sender.resumeStatus === "active")
      && !(sender.status === "pending" && sender.resumePhase === "replaying-backlog"))
      || pendingApplication.frame.envelope.roomInstance !== value.roomInstance
      || pendingApplication.frame.grant.deviceId !== sender.deviceId
      || pendingApplication.frame.grant.logicalOrder !== pendingApplication.logicalOrder
      || pendingApplication.logicalOrder !== value.nextLogicalOrder || currentGrant !== null) return null;
    if (pendingApplication.receivedAt > value.clockHighWater) return null;
  }

  const pendingCommit = value.pendingCommit === null ? null : parsePendingCommit(value.pendingCommit);
  if (value.pendingCommit !== null && !pendingCommit) return null;
  const pendingCommitRecords = recentMessages.filter((record) => record.kind === "commit-pending");
  if (!pendingCommit) {
    if (pendingCommitRecords.length !== 0) return null;
  } else if (pendingCommitRecords.length !== 1
    || pendingCommitRecords[0].id !== pendingCommit.frame.envelope.messageId
    || pendingCommitRecords[0].deviceId !== pendingCommit.fromDeviceId) return null;
  if (pendingCommit) {
    const sender = members.find((member) => member.deviceId === pendingCommit.fromDeviceId);
    if (!sender || sender.deviceId === value.hostDeviceId || (sender.status !== "active"
      && !(sender.status === "disconnected" && sender.resumeStatus === "active")
      && !(sender.status === "pending" && sender.resumePhase === "replaying-backlog"))
      || pendingCommit.frame.envelope.roomInstance !== value.roomInstance
      || pendingCommit.frame.grant.deviceId !== sender.deviceId
      || pendingCommit.frame.grant.logicalOrder !== value.nextLogicalOrder
      || pendingCommit.receivedAt > value.clockHighWater || currentGrant !== null
      || pendingApplication !== null) return null;
  }

  const pendingHostTransfer = value.pendingHostTransfer === null
    ? null
    : parsePendingHostTransfer(value.pendingHostTransfer);
  if (value.pendingHostTransfer !== null && !pendingHostTransfer) return null;
  if (pendingHostTransfer) {
    const host = members.find((member) => member.deviceId === pendingHostTransfer.hostDeviceId);
    const target = members.find((member) => member.deviceId === pendingHostTransfer.targetDeviceId);
    const authorization = replayById.get(pendingHostTransfer.authorizationId);
    const offer = replayById.get(pendingHostTransfer.offerMessageId);
    const authorizationDeliveries = members.flatMap((candidate) => candidate.backlog
      .filter((entry): entry is SecureHostTransferAuthorizationBacklogEntryV4 =>
        entry.kind === "host-transfer-authorization"
          && entry.authorizationId === pendingHostTransfer.authorizationId)
      .map((entry) => ({ member: candidate, entry })));
    if (value.hostDeviceId !== pendingHostTransfer.hostDeviceId || !host || !target
      || host.status === "retired" || target.status === "retired"
      || !authorization || authorization.kind !== "authorize-host-transfer"
      || authorization.deviceId !== pendingHostTransfer.hostDeviceId
      || authorization.acceptedAt !== pendingHostTransfer.authorizedAt
      || !offer || offer.kind !== "application" || offer.deviceId !== pendingHostTransfer.hostDeviceId
      || authorizationDeliveries.some(({ member: recipient, entry }) =>
        recipient.deviceId !== pendingHostTransfer.targetDeviceId
          || entry.fromHostDeviceId !== pendingHostTransfer.hostDeviceId
          || entry.offerMessageId !== pendingHostTransfer.offerMessageId
          || entry.expiresAt !== pendingHostTransfer.expiresAt)
      || pendingHostTransfer.authorizedAt > value.clockHighWater
      || members.some((member) => member.admissionId !== null)) return null;
  }
  const pendingTransferApplicationId = pendingApplication?.frame.relayKind === "host-transfer-accept"
    ? pendingApplication.frame.authorizationId
    : undefined;
  if (pendingTransferApplicationId !== undefined && (!pendingHostTransfer
    || pendingHostTransfer.authorizationId !== pendingTransferApplicationId
    || pendingHostTransfer.targetDeviceId !== pendingApplication?.fromDeviceId)) return null;

  const pendingZombieRemovals: SecureZombieRemovalStateV4[] = [];
  for (const raw of value.pendingZombieRemovals) {
    const marker = parseZombieRemoval(raw);
    if (!marker || marker.requestedAt > (value.clockHighWater as number)) return null;
    const target = members.find((member) => member.deviceId === marker.deviceId);
    const membershipAdmission = recentMessages.find((record) =>
      record.id === marker.admissionCommitMessageId
      && (target?.joinedOrder === 1
        ? record.kind === "setup-request" && record.deviceId === marker.deviceId
        : record.kind === "join-request" && record.deviceId === marker.deviceId));
    const removalRequired = !!target && (target.status === "retired"
      || (target.status === "disconnected" && target.requiresFreshAdmission));
    if (!removalRequired || !membershipAdmission
      || target.memberBinding.admissionId !== marker.admissionCommitMessageId
      || membershipAdmission.acceptedAt > marker.requestedAt) return null;
    if (marker.removalCommitMessageId !== null) {
      const removalCommit = recentMessages.find((record) =>
        record.id === marker.removalCommitMessageId
        && record.kind === "commit"
        && record.deviceId === value.hostDeviceId
        && record.acceptedAt >= marker.requestedAt);
      if (!removalCommit || marker.removalCommitMessageId === marker.admissionCommitMessageId) return null;
    }
    pendingZombieRemovals.push(marker);
  }
  if (new Set(pendingZombieRemovals.map((marker) => marker.deviceId)).size !== pendingZombieRemovals.length
    || new Set(pendingZombieRemovals.map((marker) => marker.admissionCommitMessageId)).size
      !== pendingZombieRemovals.length) return null;
  if (pendingZombieRemovals.length !== 0) {
    const barrier = pendingZombieRemovals[0];
    if (pendingZombieRemovals.slice(1).some((marker) => marker.removalCommitMessageId !== null)
      || pendingApplication !== null || pendingCommit !== null || pendingHostTransfer !== null
      || members.some((member) => member.admissionId !== null)
      || (currentGrant !== null && (barrier.removalCommitMessageId !== null
        || currentGrant.deviceId !== value.hostDeviceId))
      || orderQueue.some((entry) => barrier.removalCommitMessageId !== null
        || entry.deviceId !== value.hostDeviceId)) return null;
  }
  const admissionBarriers = members.filter((member) => member.admissionId !== null
    && member.admissionCommitMessageId !== null);
  if (admissionBarriers.length > 1) return null;
  if (admissionBarriers.length === 1) {
    const barrier = admissionBarriers[0];
    const hostMayOrderBootstrap = barrier.pendingPhase === "awaiting-bootstrap";
    if (pendingZombieRemovals.length !== 0 || pendingApplication !== null || pendingCommit !== null
      || pendingHostTransfer !== null
      || (currentGrant !== null && (!hostMayOrderBootstrap || currentGrant.deviceId !== value.hostDeviceId))
      || orderQueue.some((entry) => !hostMayOrderBootstrap || entry.deviceId !== value.hostDeviceId)) return null;
  }

  const lifecycle = value.lifecycle as "open" | "retired";
  if (lifecycle === "open") {
    if (value.hostDeviceId === null) return null;
    const host = members.find((member) => member.deviceId === value.hostDeviceId);
    if (!host || (host.status !== "active"
      && !(host.status === "disconnected" && host.resumeStatus === "active")
      && !(host.status === "pending" && host.resumePhase === "replaying-backlog"))) return null;
  } else if (value.hostDeviceId !== null || currentGrant !== null || pendingApplication !== null
    || pendingCommit !== null
    || pendingHostTransfer !== null || pendingZombieRemovals.length !== 0 || orderQueue.length !== 0
    || members.some((member) => member.status !== "retired")) return null;

  return {
    schema: SECURE_RELAY_STATE_SCHEMA_V4,
    revision: value.revision,
    clockHighWater: value.clockHighWater,
    v: 4,
    suite: 1,
    roomInstance: value.roomInstance,
    lifecycle,
    hostDeviceId: value.hostDeviceId,
    members,
    nextMemberOrder: value.nextMemberOrder,
    nextLogicalOrder: value.nextLogicalOrder,
    currentGrant,
    pendingApplication,
    pendingCommit,
    pendingHostTransfer,
    pendingZombieRemovals,
    orderQueue,
    recentMessages,
    recentKeyPackageDigests,
  } as SecureRelayStateV4;
}

export function importSecureRelayStateV4(serialized: string): SecureRelayStateV4 | null {
  if (typeof serialized !== "string"
    || new TextEncoder().encode(serialized).byteLength > MAX_SECURE_RELAY_STATE_BYTES_V4) return null;
  try {
    return parseSecureRelayStateV4(JSON.parse(serialized));
  } catch {
    return null;
  }
}

export function exportSecureRelayStateV4(state: SecureRelayStateV4): string {
  const safe = parseSecureRelayStateV4(state);
  if (!safe) throw new Error("invalid secure relay state");
  const serialized = JSON.stringify(safe);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SECURE_RELAY_STATE_BYTES_V4) {
    throw new Error("secure relay state exceeds persistence bound");
  }
  return serialized;
}

/**
 * Return the immutable device credential key used by the outer authentication
 * layer to verify a domain-separated resume challenge.  The relay reducer
 * deliberately does not accept a replacement key in a resume frame.
 */
export function getSecureRelayDeviceSignatureKeyV4(
  stateValue: SecureRelayStateV4,
  deviceId: string,
): string | null {
  const state = parseSecureRelayStateV4(stateValue);
  if (!state || !isDeviceId(deviceId)) return null;
  return memberById(state, deviceId)?.signaturePublicKey || null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

type SecureRecoverableControlFrameV4 = Extract<SecureClientFrameV4, {
  kind: "activate" | "application-decision" | "commit-decision"
    | "authorize-host-transfer"
    | "retire-member" | "cancel-admission" | "close-room" | "resume-complete" | "delivery-ack";
}>;

function isRecoverableControlFrame(frame: SecureClientFrameV4): frame is SecureRecoverableControlFrameV4 {
  return frame.kind === "activate" || frame.kind === "application-decision" || frame.kind === "commit-decision"
    || frame.kind === "authorize-host-transfer"
    || frame.kind === "retire-member" || frame.kind === "cancel-admission" || frame.kind === "close-room"
    || frame.kind === "resume-complete" || frame.kind === "delivery-ack";
}

async function secureFrameDigest(frame: SecureClientFrameV4): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(frame));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export function generateSecureRelayIdV4(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(SECURE_MESSAGE_ID_BYTES)));
}

function reject(code: SecureRelayErrorCodeV4): SecureRelayTransitionV4 {
  return { ok: false, code };
}

function recordReplay(
  state: SecureRelayStateV4,
  id: string,
  kind: SecureReplayKindV4,
  deviceId: string,
  now: number,
  metadata: {
    logicalOrder?: number;
    rejectionReason?: SecureReplayRecordV4["rejectionReason"];
    frameDigest?: string;
  } = {},
): void {
  state.recentMessages.push({
    id,
    kind,
    deviceId,
    acceptedAt: now,
    logicalOrder: metadata.logicalOrder ?? null,
    rejectionReason: metadata.rejectionReason ?? null,
    frameDigest: metadata.frameDigest ?? null,
  });
  while (state.recentMessages.length > MAX_SECURE_REPLAY_RECORDS_V4) {
    const protectedIds = new Set<string>([
      ...(state.currentGrant ? [state.currentGrant.tokenId, state.currentGrant.requestId] : []),
      ...(state.pendingApplication ? [state.pendingApplication.frame.envelope.messageId] : []),
      ...(state.pendingCommit ? [state.pendingCommit.frame.envelope.messageId] : []),
      ...state.orderQueue.map((entry) => entry.requestId),
      ...state.members.flatMap((member) => [
        member.memberBinding.admissionId, member.admissionId, member.admissionCommitMessageId,
        member.welcomeMessageId, member.proofMessageId,
        member.membershipCommitMessageId,
        member.resumeRequestId,
        member.proofGrant?.tokenId ?? null,
      ].filter((candidate): candidate is string => candidate !== null)),
      ...state.members.flatMap((member) => member.backlog.map(backlogEntryMessageId)),
      ...state.pendingZombieRemovals.map((marker) => marker.admissionCommitMessageId),
      ...state.pendingZombieRemovals.flatMap((marker) =>
        marker.removalCommitMessageId === null ? [] : [marker.removalCommitMessageId]),
      ...(state.pendingHostTransfer
        ? [state.pendingHostTransfer.authorizationId, state.pendingHostTransfer.offerMessageId]
        : []),
    ]);
    const removable = state.recentMessages.findIndex((record) => !protectedIds.has(record.id));
    if (removable < 0) throw new Error("secure replay record bound exhausted");
    state.recentMessages.splice(removable, 1);
  }
}

function recordKeyPackageDigest(state: SecureRelayStateV4, digest: string): void {
  if (state.recentKeyPackageDigests.length >= MAX_SECURE_KEY_PACKAGE_DIGESTS_V4) {
    throw new Error("secure key-package digest lifetime bound exhausted");
  }
  state.recentKeyPackageDigests.push(digest);
}

function hasReplayId(state: SecureRelayStateV4, id: string): boolean {
  return state.recentMessages.some((record) => record.id === id)
    || state.currentGrant?.tokenId === id
    || state.orderQueue.some((entry) => entry.requestId === id)
    || state.members.some((member) => member.admissionId === id
      || member.admissionCommitMessageId === id || member.welcomeMessageId === id || member.proofMessageId === id);
}

function connectionIdInUse(state: SecureRelayStateV4, connectionId: string, exceptDeviceId?: string): boolean {
  return state.members.some((member) => member.deviceId !== exceptDeviceId && member.connectionId === connectionId);
}

function replayRecord(
  state: SecureRelayStateV4,
  id: string,
  kind?: SecureReplayKindV4,
  deviceId?: string,
): SecureReplayRecordV4 | null {
  return state.recentMessages.find((record) => record.id === id
    && (kind === undefined || record.kind === kind)
    && (deviceId === undefined || record.deviceId === deviceId)) || null;
}

type SecureRelayRetryResultV4 = "not-found" | "handled" | SecureRelayErrorCodeV4;

function isTerminalRelayRejectionReason(
  value: SecureReplayRecordV4["rejectionReason"],
): value is Extract<SecureRelayEffectV4, { type: "commit-rejected" }>["reason"] {
  return value === "host-rejected" || value === "approval-expired" || value === "grant-expired"
    || value === "member-retired" || value === "removal-pending" || value === "admission-pending";
}

function isOrderCancellationReason(
  value: SecureReplayRecordV4["rejectionReason"],
): value is SecureOrderCancellationReasonV4 {
  return value === "connection-lost" || value === "delivery-pending"
    || value === "removal-pending" || value === "admission-pending";
}

/**
 * Recover a sender outbox after the relay committed state but its response was
 * lost. The retried ciphertext is never routed: only the persisted record and
 * persisted pending frame determine the response/effect.
 */
function recoverRelayRetry(
  state: SecureRelayStateV4,
  actor: SecureRelayActorV4,
  frame: SecureRelayFrameV4,
  frameDigest: string | null,
  effects: SecureRelayEffectV4[],
): SecureRelayRetryResultV4 {
  const messageId = frame.envelope.messageId;
  const record = replayRecord(state, messageId);
  if (!record) {
    if (hasReplayId(state, messageId)) return "duplicate-id";
    const grant = frame.relayKind === "welcome" ? null : frame.grant;
    if (grant) {
      const cancellation = replayRecord(state, grant.requestId, "order-cancelled", actor.deviceId);
      if (cancellation && isOrderCancellationReason(cancellation.rejectionReason)) {
        effects.push({
          type: "order-cancelled",
          deviceId: actor.deviceId,
          requestId: grant.requestId,
          reason: cancellation.rejectionReason,
        });
        return "handled";
      }
      if (replayRecord(state, grant.tokenId, "grant-expired", actor.deviceId)) {
        effects.push({ type: "order-expired", deviceId: actor.deviceId, tokenId: grant.tokenId });
        return "handled";
      }
    }
    return "not-found";
  }
  if (record.deviceId !== actor.deviceId) return "duplicate-id";

  if (frameDigest === null || record.frameDigest !== frameDigest) return "duplicate-id";

  if (frame.relayKind === "commit") {
    if (record.kind === "commit-pending") {
      const pending = state.pendingCommit;
      const host = connectedHost(state);
      if (!pending || pending.fromDeviceId !== actor.deviceId
        || pending.frame.envelope.messageId !== messageId) return "invalid-state";
      if (host && host.backlog.length === 0) {
        effects.push({
          type: "commit-preview",
          fromDeviceId: actor.deviceId,
          toHostDeviceId: host.deviceId,
          frame: pending.frame,
          logicalOrder: pending.frame.grant.logicalOrder,
        });
      }
      return "handled";
    }
    if (record.kind === "commit") {
      effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId });
      return "handled";
    }
    if (record.kind === "commit-rejected" && isTerminalRelayRejectionReason(record.rejectionReason)) {
      effects.push({
        type: "commit-rejected",
        deviceId: actor.deviceId,
        messageId,
        reason: record.rejectionReason,
      });
      return "handled";
    }
    return "duplicate-id";
  }

  // Bootstrap, proof, ordinary application, and host-transfer acceptance are
  // all MLS application outbox entries. A barrier/grant race terminalizes any
  // of them through the same durable ordered result.
  if (record.kind === "application-rejected" && record.logicalOrder !== null
    && isTerminalRelayRejectionReason(record.rejectionReason)) {
    effects.push({
      type: "application-rejected",
      deviceId: actor.deviceId,
      messageId,
      logicalOrder: record.logicalOrder,
      reason: record.rejectionReason,
    });
    return "handled";
  }

  if (frame.relayKind === "welcome" || frame.relayKind === "bootstrap") {
    if (record.kind !== frame.relayKind) return "duplicate-id";
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId });
    if (frame.relayKind === "bootstrap") {
      const pending = state.members.find((candidate) => candidate.pendingPhase === "awaiting-proof"
        && candidate.proofGrant !== null);
      if (pending?.proofGrant) {
        const { connectionId: _connectionId, ...wireGrant } = pending.proofGrant;
        effects.push({ type: "order-granted", toDeviceId: pending.deviceId, grant: wireGrant });
      }
    }
    return "handled";
  }

  if (frame.relayKind === "join-proof") {
    if (record.kind === "join-proof-pending") {
      const pending = memberById(state, actor.deviceId);
      const host = connectedHost(state);
      if (!pending?.proofFrame || pending.proofMessageId !== messageId
        || pending.proofFrame.grant.logicalOrder !== record.logicalOrder) return "invalid-state";
      if (host) {
        effects.push({
          type: "admission-proof-preview",
          fromDeviceId: actor.deviceId,
          toHostDeviceId: host.deviceId,
          frame: pending.proofFrame,
          logicalOrder: pending.proofFrame.grant.logicalOrder,
        });
      }
      return "handled";
    }
    if (record.kind !== "join-proof" || record.logicalOrder === null) return "duplicate-id";
    effects.push({
      type: "application-accepted",
      deviceId: actor.deviceId,
      messageId,
      logicalOrder: record.logicalOrder,
    });
    return "handled";
  }

  if (record.kind === "application-pending") {
    const pending = state.pendingApplication;
    const host = connectedHost(state);
    if (!pending || pending.fromDeviceId !== actor.deviceId
      || pending.frame.envelope.messageId !== messageId
      || pending.logicalOrder !== record.logicalOrder) return "invalid-state";
    if (host) {
      effects.push({
        type: "application-preview",
        fromDeviceId: actor.deviceId,
        toHostDeviceId: host.deviceId,
        frame: pending.frame,
        logicalOrder: pending.logicalOrder,
      });
    }
    return "handled";
  }
  if (record.kind === "application" && record.logicalOrder !== null) {
    effects.push({
      type: "application-accepted",
      deviceId: actor.deviceId,
      messageId,
      logicalOrder: record.logicalOrder,
    });
    if (state.hostDeviceId === actor.deviceId) {
      effects.push({ type: "host-changed", deviceId: actor.deviceId });
    }
    return "handled";
  }
  return "duplicate-id";
}

function recoverControlRetry(
  state: SecureRelayStateV4,
  actor: SecureRelayActorV4,
  frame: SecureRecoverableControlFrameV4,
  frameDigest: string,
  effects: SecureRelayEffectV4[],
): SecureRelayRetryResultV4 {
  const record = replayRecord(state, frame.requestId);
  if (!record) return hasReplayId(state, frame.requestId) ? "duplicate-id" : "not-found";
  if (record.deviceId !== actor.deviceId || record.kind !== frame.kind
    || record.frameDigest !== frameDigest) return "duplicate-id";

  effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
  if (frame.kind === "close-room") {
    effects.push({ type: "room-retired" });
    return "handled";
  }
  if (frame.kind === "authorize-host-transfer") {
    const pending = state.pendingHostTransfer;
    const target = pending ? memberById(state, pending.targetDeviceId) : null;
    const authorizationStillPendingDelivery = !!target?.backlog.some((entry) =>
      entry.kind === "host-transfer-authorization"
      && entry.authorizationId === frame.requestId);
    if (pending?.authorizationId === frame.requestId && authorizationStillPendingDelivery) {
      effects.push({
        type: "host-transfer-authorized",
        toDeviceId: pending.targetDeviceId,
        fromHostDeviceId: pending.hostDeviceId,
        authorizationId: pending.authorizationId,
        offerMessageId: pending.offerMessageId,
        expiresAt: pending.expiresAt,
      });
    }
    return "handled";
  }
  if (frame.kind === "retire-member" || frame.kind === "cancel-admission") {
    const target = memberById(state, frame.deviceId);
    if (target) effects.push({ type: "member-lifecycle", deviceId: target.deviceId, status: target.status });
    return "handled";
  }
  if (frame.kind === "activate") {
    const target = memberById(state, frame.deviceId);
    if (target) effects.push({ type: "member-lifecycle", deviceId: target.deviceId, status: target.status });
    return "handled";
  }
  if (frame.kind === "resume-complete" || frame.kind === "delivery-ack") {
    const member = memberById(state, actor.deviceId);
    if (member) effects.push({ type: "member-lifecycle", deviceId: member.deviceId, status: member.status });
  }
  return "handled";
}

function memberById(state: SecureRelayStateV4, deviceId: string): SecureRelayMemberStateV4 | null {
  return state.members.find((member) => member.deviceId === deviceId) || null;
}

function pruneOldestRetiredTombstone(state: SecureRelayStateV4): void {
  if (state.members.filter((member) => member.status === "retired").length
    < MAX_SECURE_RETIRED_TOMBSTONES_V4) return;
  const replayById = new Map(state.recentMessages.map((record) => [record.id, record]));
  const retired = state.members
    .filter((member) => member.status === "retired"
      // The unique invitation-authenticated founder record is permanent room
      // provenance and is required to validate every imported snapshot.
      && member.memberBinding.mode !== "founder"
      && !state.pendingZombieRemovals.some((marker) => marker.deviceId === member.deviceId)
      // A disconnected recipient may still need this signed admission identity
      // immediately before replaying the corresponding MLS Remove commit.
      && !state.members.some((recipient) => recipient.backlog.some((entry) =>
        entry.kind === "relay" && entry.frame.relayKind === "commit"
          && entry.frame.retirementDeviceId === member.deviceId))
      // Removing a sender also removes every replay record attributed to that
      // device. Keep the tombstone while a surviving member still depends on
      // one of those records for MLS establishment or durable delivery.
      && !state.members.some((dependent) => dependent !== member
        && ((dependent.membershipCommitMessageId !== null
          && replayById.get(dependent.membershipCommitMessageId)?.deviceId === member.deviceId)
          || dependent.backlog.some((entry) =>
            (entry.kind === "relay" && entry.fromDeviceId === member.deviceId)
              || (entry.kind === "host-transfer-authorization"
                && entry.fromHostDeviceId === member.deviceId)))))
    .sort((left, right) => left.joinedOrder - right.joinedOrder);
  if (retired.length === 0) throw new Error("secure retired tombstone bound exhausted");
  const oldest = retired[0];
  state.members = state.members.filter((member) => member !== oldest);
  state.recentMessages = state.recentMessages.filter((record) => record.deviceId !== oldest.deviceId);
}

function connectedHost(state: SecureRelayStateV4): SecureRelayMemberStateV4 | null {
  if (!state.hostDeviceId) return null;
  const host = memberById(state, state.hostDeviceId);
  return host?.status === "active" ? host : null;
}

function boundMember(state: SecureRelayStateV4, actor: SecureRelayActorV4): SecureRelayMemberStateV4 | null {
  const member = memberById(state, actor.deviceId);
  if (!member || member.connectionId !== actor.connectionId) return null;
  return member;
}

function activeRecipients(state: SecureRelayStateV4, excludeDeviceId: string): string[] {
  return state.members
    .filter((member) => member.status === "active" && member.deviceId !== excludeDeviceId)
    .sort((left, right) => left.joinedOrder - right.joinedOrder)
    .map((member) => member.deviceId);
}

function emitRoomStateSnapshot(
  state: SecureRelayStateV4,
  toDeviceId: string,
  effects: SecureRelayEffectV4[],
): void {
  if (state.hostDeviceId === null) return;
  const members: Array<{
    deviceId: string;
    status: "pending" | "active" | "disconnected";
  }> = [];
  for (const member of [...state.members].sort((left, right) => left.joinedOrder - right.joinedOrder)) {
    if (member.status === "retired") continue;
    members.push({
      deviceId: member.deviceId,
      // The resume snapshot is emitted only after every durable delivery.
      // Treat the resuming member as active because backlog-end immediately
      // completes that same persisted transition.
      status: member.deviceId === toDeviceId ? "active" : member.status,
    });
  }
  effects.push({
    type: "room-state-snapshot",
    toDeviceId,
    hostDeviceId: state.hostDeviceId,
    members,
    pendingHostTransfer: state.pendingHostTransfer === null
      ? null
      : {
          targetDeviceId: state.pendingHostTransfer.targetDeviceId,
          authorizationId: state.pendingHostTransfer.authorizationId,
        },
  });
}

function zombieBarrierRecipients(state: SecureRelayStateV4, targetDeviceId: string): string[] {
  return state.members
    .filter((member) => member.status !== "retired" && member.deviceId !== targetDeviceId)
    .sort((left, right) => left.joinedOrder - right.joinedOrder)
    .map((member) => member.deviceId);
}

function activeAdmissionBarrier(state: SecureRelayStateV4): SecureRelayMemberStateV4 | null {
  return state.members.find((member) => member.admissionId !== null
    && member.admissionCommitMessageId !== null) || null;
}

type SecureOrderCancellationReasonV4 = Extract<
  SecureRelayEffectV4,
  { type: "order-cancelled" }
>["reason"];

function persistOrderCancellation(
  state: SecureRelayStateV4,
  deviceId: string,
  requestId: string,
  reason: SecureOrderCancellationReasonV4,
): void {
  const record = replayRecord(state, requestId, "order-request", deviceId);
  if (!record) throw new Error("secure order request lost before cancellation");
  record.kind = "order-cancelled";
  record.rejectionReason = reason;
}

function activateAdmissionBarrier(
  state: SecureRelayStateV4,
  effects: SecureRelayEffectV4[],
): void {
  if (!activeAdmissionBarrier(state)) return;
  if (state.currentGrant) {
    persistOrderCancellation(
      state, state.currentGrant.deviceId, state.currentGrant.requestId, "admission-pending",
    );
    effects.push({
      type: "order-cancelled",
      deviceId: state.currentGrant.deviceId,
      requestId: state.currentGrant.requestId,
      reason: "admission-pending",
    });
    state.currentGrant = null;
  }
  for (const queued of state.orderQueue) {
    persistOrderCancellation(state, queued.deviceId, queued.requestId, "admission-pending");
    effects.push({
      type: "order-cancelled",
      deviceId: queued.deviceId,
      requestId: queued.requestId,
      reason: "admission-pending",
    });
  }
  state.orderQueue = [];
}

function emitZombieRemovalBarrier(
  state: SecureRelayStateV4,
  effects: SecureRelayEffectV4[],
  onlyDeviceId?: string,
  explicitMarker?: Pick<SecureZombieRemovalStateV4, "deviceId" | "admissionCommitMessageId">,
): void {
  const marker = explicitMarker || state.pendingZombieRemovals[0];
  if (!marker) return;
  const toDeviceIds = onlyDeviceId === undefined
    ? zombieBarrierRecipients(state, marker.deviceId)
    : onlyDeviceId === marker.deviceId ? [] : [onlyDeviceId];
  if (toDeviceIds.length === 0) return;
  const alreadyTargeted = new Set(effects.flatMap((effect) =>
    effect.type === "zombie-removal-required"
      && effect.deviceId === marker.deviceId
      && effect.admissionCommitMessageId === marker.admissionCommitMessageId
      ? effect.toDeviceIds
      : []));
  const freshRecipients = toDeviceIds.filter((deviceId) => !alreadyTargeted.has(deviceId));
  if (freshRecipients.length !== 0) {
    effects.push({
      type: "zombie-removal-required",
      toDeviceIds: freshRecipients,
      deviceId: marker.deviceId,
      admissionCommitMessageId: marker.admissionCommitMessageId,
    });
  }
}

function activateZombieRemovalBarrier(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  if (state.pendingZombieRemovals.length === 0) return;

  // Grants do not encode their intended operation. Cancel every grant/queue
  // that predates the barrier so no application intent can race the removal;
  // the host must request a fresh grant after seeing removal-required.
  if (state.currentGrant) {
    persistOrderCancellation(
      state, state.currentGrant.deviceId, state.currentGrant.requestId, "removal-pending",
    );
    effects.push({
      type: "order-cancelled",
      deviceId: state.currentGrant.deviceId,
      requestId: state.currentGrant.requestId,
      reason: "removal-pending",
    });
    state.currentGrant = null;
  }
  for (const queued of state.orderQueue) {
    persistOrderCancellation(state, queued.deviceId, queued.requestId, "removal-pending");
    effects.push({
      type: "order-cancelled",
      deviceId: queued.deviceId,
      requestId: queued.requestId,
      reason: "removal-pending",
    });
  }
  state.orderQueue = [];

  // A pending admission may already have been added to the MLS group even
  // though relay activation has not completed. Never let a stale Welcome or
  // proof resume after an intervening removal epoch. Retire every pending
  // admission now; retirePendingAdmission preserves a FIFO removal marker for
  // each leaf whose Add commit had already been accepted.
  for (const pending of state.members.filter((candidate) => candidate.admissionId !== null)) {
    retirePendingAdmission(state, pending, now, effects);
  }

  const pendingApplication = state.pendingApplication;
  if (pendingApplication) {
    state.pendingApplication = null;
    const record = replayRecord(
      state,
      pendingApplication.frame.envelope.messageId,
      "application-pending",
      pendingApplication.fromDeviceId,
    );
    if (record) {
      record.kind = "application-rejected";
      record.rejectionReason = "removal-pending";
    }
    deliverApplicationResult(
      state,
      pendingApplication.fromDeviceId,
      pendingApplication.frame.envelope.messageId,
      pendingApplication.logicalOrder,
      "rejected",
      "removal-pending",
      now,
      effects,
    );
  }

  const pendingCommit = state.pendingCommit;
  if (pendingCommit) {
    state.pendingCommit = null;
    const record = replayRecord(
      state,
      pendingCommit.frame.envelope.messageId,
      "commit-pending",
      pendingCommit.fromDeviceId,
    );
    if (record) {
      record.kind = "commit-rejected";
      record.rejectionReason = "removal-pending";
    }
    deliverCommitResult(
      state,
      pendingCommit.fromDeviceId,
      pendingCommit.frame.envelope.messageId,
      "rejected",
      "removal-pending",
      now,
      effects,
    );
  }

  if (state.pendingHostTransfer) {
    const transfer = state.pendingHostTransfer;
    state.pendingHostTransfer = null;
    effects.push({
      type: "host-transfer-expired",
      deviceIds: [transfer.hostDeviceId, transfer.targetDeviceId],
      authorizationId: transfer.authorizationId,
    });
  }
}

function persistZombieRemoval(
  state: SecureRelayStateV4,
  deviceId: string,
  membershipAdmissionId: string,
  requestedAt: number,
  effects: SecureRelayEffectV4[],
): void {
  if (!state.pendingZombieRemovals.some((marker) => marker.deviceId === deviceId)) {
    if (state.pendingZombieRemovals.length >= MAX_SECURE_ZOMBIE_REMOVALS_V4) {
      throw new Error("secure zombie-removal bound exhausted");
    }
    const wasEmpty = state.pendingZombieRemovals.length === 0;
    state.pendingZombieRemovals.push({
      deviceId,
      admissionCommitMessageId: membershipAdmissionId,
      requestedAt,
      removalCommitMessageId: null,
    });
    if (wasEmpty) {
      activateZombieRemovalBarrier(state, requestedAt, effects);
      emitZombieRemovalBarrier(state, effects);
    }
  }
  emitZombieRemovalBarrier(state, effects);
}

function markBacklogOverflow(
  state: SecureRelayStateV4,
  member: SecureRelayMemberStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  if (member.deviceId === state.hostDeviceId) {
    retireRoomAfterHostLoss(state, effects);
    return;
  }
  const pendingTransfer = state.pendingHostTransfer;
  if (pendingTransfer && (pendingTransfer.hostDeviceId === member.deviceId
    || pendingTransfer.targetDeviceId === member.deviceId)) {
    state.pendingHostTransfer = null;
    effects.push({
      type: "host-transfer-expired",
      deviceIds: [pendingTransfer.hostDeviceId, pendingTransfer.targetDeviceId],
      authorizationId: pendingTransfer.authorizationId,
    });
  }
  if (member.admissionId !== null) {
    const admissionCommitMessageId = member.admissionCommitMessageId;
    retireMember(member);
    effects.push({ type: "member-lifecycle", deviceId: member.deviceId, status: "retired" });
    effects.push({ type: "fresh-admission-required", deviceId: member.deviceId });
    if (admissionCommitMessageId) {
      persistZombieRemoval(state, member.deviceId, member.memberBinding.admissionId, now, effects);
    }
    return;
  }
  member.status = "disconnected";
  member.connectionId = null;
  member.resumeStatus = "active";
  member.resumePhase = null;
  member.resumeRequestId = null;
  member.disconnectExpiresAt = null;
  member.backlog = [];
  member.backlogBytes = 0;
  member.requiresFreshAdmission = true;
  if (member.membershipCommitMessageId) {
    persistZombieRemoval(state, member.deviceId, member.memberBinding.admissionId, now, effects);
  }
  effects.push({ type: "member-lifecycle", deviceId: member.deviceId, status: "disconnected" });
  effects.push({ type: "fresh-admission-required", deviceId: member.deviceId });
}

function cancelQueuedOrderForDelivery(
  state: SecureRelayStateV4,
  member: SecureRelayMemberStateV4,
  effects: SecureRelayEffectV4[],
): void {
  const cancelled = state.orderQueue.filter((entry) => entry.deviceId === member.deviceId);
  if (cancelled.length === 0) return;
  state.orderQueue = state.orderQueue.filter((entry) => entry.deviceId !== member.deviceId);
  for (const entry of cancelled) {
    persistOrderCancellation(state, member.deviceId, entry.requestId, "delivery-pending");
    effects.push({
      type: "order-cancelled",
      deviceId: member.deviceId,
      requestId: entry.requestId,
      reason: "delivery-pending",
    });
  }
}

function appendBacklog(
  state: SecureRelayStateV4,
  member: SecureRelayMemberStateV4,
  entry: SecureBacklogEntryV4,
  effects: SecureRelayEffectV4[],
): "buffered" | "live" | "overflow" {
  if (member.requiresFreshAdmission) return "overflow";
  cancelQueuedOrderForDelivery(state, member, effects);
  const size = backlogEntryBytes(entry);
  if (member.backlog.length >= MAX_SECURE_DEVICE_BACKLOG_ENTRIES_V4
    || member.backlogBytes + size > MAX_SECURE_DEVICE_BACKLOG_BYTES_V4) {
    markBacklogOverflow(state, member, entry.receivedAt, effects);
    return "overflow";
  }
  member.backlog.push(entry);
  member.backlogBytes += size;
  return member.connectionId !== null && (member.status === "active" || member.status === "pending")
    ? "live"
    : "buffered";
}

function routeGroupFrame(
  state: SecureRelayStateV4,
  fromDeviceId: string,
  frame: SecureCommitRelayFrameV4 | SecureBootstrapRelayFrameV4
    | SecureJoinProofRelayFrameV4 | SecureApplicationRelayFrameV4 | SecureHostTransferAcceptRelayFrameV4,
  logicalOrder: number | null,
  now: number,
  effects: SecureRelayEffectV4[],
): string[] {
  const recipients: string[] = [];
  // Reserve the delivery effect before appending to recipient backlogs. An
  // append can overflow a disconnected member and synchronously activate a
  // zombie-removal barrier. Every connected member must observe the accepted
  // frame that caused that transition before the new barrier notification, or
  // it will correctly reject the older frame as a barrier bypass.
  effects.push({
    type: "route-relay",
    fromDeviceId,
    toDeviceIds: recipients,
    frame,
    logicalOrder,
  });
  for (const member of [...state.members].sort((left, right) => left.joinedOrder - right.joinedOrder)) {
    if (member.deviceId === fromDeviceId || member.status === "retired") continue;
    const connectedActive = member.status === "active";
    const disconnectedActive = member.status === "disconnected" && member.resumeStatus === "active";
    const replaying = member.status === "pending" && member.resumePhase === "replaying-backlog";
    if (!connectedActive && !disconnectedActive && !replaying) continue;
    const delivery = appendBacklog(state, member, {
      kind: "relay",
      receivedAt: now,
      fromDeviceId,
      logicalOrder,
      frame,
    }, effects);
    if (state.lifecycle === "retired") return [];
    if (delivery === "live") recipients.push(member.deviceId);
  }
  return recipients;
}

function deliverApplicationResult(
  state: SecureRelayStateV4,
  deviceId: string,
  messageId: string,
  logicalOrder: number,
  result: "accepted" | "rejected",
  reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending" | null,
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  const member = memberById(state, deviceId);
  if (!member || member.status === "retired") return;
  const directEffect: SecureRelayEffectV4 = result === "accepted"
    ? { type: "application-accepted", deviceId, messageId, logicalOrder }
    : { type: "application-rejected", deviceId, messageId, logicalOrder, reason: reason! };
  const connectedActive = member.status === "active";
  const disconnectedActive = member.status === "disconnected" && member.resumeStatus === "active";
  const replaying = member.status === "pending" && member.resumePhase === "replaying-backlog";
  if (!connectedActive && !disconnectedActive && !replaying) return;
  const delivery = appendBacklog(state, member, {
    kind: "application-result",
    receivedAt: now,
    logicalOrder,
    messageId,
    result,
    reason,
  }, effects);
  if (delivery === "live") effects.push(directEffect);
}

function deliverCommitResult(
  state: SecureRelayStateV4,
  deviceId: string,
  messageId: string,
  result: "accepted" | "rejected",
  reason: "host-rejected" | "approval-expired" | "grant-expired" | "member-retired" | "removal-pending" | "admission-pending" | null,
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  const member = memberById(state, deviceId);
  if (!member || member.status === "retired") return;
  const connectedActive = member.status === "active";
  const disconnectedActive = member.status === "disconnected" && member.resumeStatus === "active";
  const replaying = member.status === "pending" && member.resumePhase === "replaying-backlog";
  if (!connectedActive && !disconnectedActive && !replaying) return;
  const delivery = appendBacklog(state, member, {
    kind: "commit-result",
    receivedAt: now,
    logicalOrder: null,
    messageId,
    result,
    reason,
  }, effects);
  if (delivery !== "live") return;
  if (result === "accepted") {
    effects.push({ type: "frame-accepted", deviceId, messageId });
  } else {
    effects.push({ type: "commit-rejected", deviceId, messageId, reason: reason! });
  }
}

function terminalizeGrantBoundRelay(
  state: SecureRelayStateV4,
  actor: SecureRelayActorV4,
  frame: Exclude<SecureRelayFrameV4, SecureWelcomeRelayFrameV4>,
  frameDigest: string,
  reason: Extract<SecureRelayEffectV4, { type: "commit-rejected" }>["reason"],
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  const messageId = frame.envelope.messageId;
  if (hasReplayId(state, messageId)) throw new Error("secure terminal relay id collided");
  if (frame.relayKind === "commit") {
    recordReplay(state, messageId, "commit-rejected", actor.deviceId, now, {
      rejectionReason: reason,
      frameDigest,
    });
    deliverCommitResult(state, actor.deviceId, messageId, "rejected", reason, now, effects);
    return;
  }
  recordReplay(state, messageId, "application-rejected", actor.deviceId, now, {
    logicalOrder: frame.grant.logicalOrder,
    rejectionReason: reason,
    frameDigest,
  });
  deliverApplicationResult(
    state, actor.deviceId, messageId, frame.grant.logicalOrder, "rejected", reason, now, effects,
  );
}

function keyPackageDelivery(
  state: SecureRelayStateV4,
  member: SecureRelayMemberStateV4,
): SecureRelayEffectV4 | null {
  if (state.pendingZombieRemovals.length !== 0) return null;
  const host = connectedHost(state);
  if (!host || member.status !== "pending" || member.pendingPhase !== "awaiting-welcome"
    || member.admissionId === null || member.keyPackage === null
    || member.admissionCommitMessageId !== null) return null;
  return {
    type: "deliver-key-package",
    fromDeviceId: member.deviceId,
    toDeviceId: host.deviceId,
    admissionId: member.admissionId,
    memberBinding: member.memberBinding,
    hello: {
      v: 4,
      suite: 1,
      roomInstance: state.roomInstance,
      deviceId: member.deviceId,
      keyPackage: member.keyPackage,
    },
  };
}

function emitHostPendingWork(
  state: SecureRelayStateV4,
  host: SecureRelayMemberStateV4,
  effects: SecureRelayEffectV4[],
): void {
  if (state.hostDeviceId !== host.deviceId || host.status !== "active" || host.backlog.length !== 0) return;
  emitZombieRemovalBarrier(state, effects, host.deviceId);
  if (state.pendingZombieRemovals.length !== 0) return;
  if (state.pendingApplication) {
    effects.push({
      type: "application-preview",
      fromDeviceId: state.pendingApplication.fromDeviceId,
      toHostDeviceId: host.deviceId,
      frame: state.pendingApplication.frame,
      logicalOrder: state.pendingApplication.logicalOrder,
    });
  }
  if (state.pendingCommit) {
    effects.push({
      type: "commit-preview",
      fromDeviceId: state.pendingCommit.fromDeviceId,
      toHostDeviceId: host.deviceId,
      frame: state.pendingCommit.frame,
      logicalOrder: state.pendingCommit.frame.grant.logicalOrder,
    });
  }
  for (const pending of state.members) {
    if (pending.status === "pending" && pending.pendingPhase === "awaiting-proof" && pending.proofFrame) {
      effects.push({
        type: "admission-proof-preview",
        fromDeviceId: pending.deviceId,
        toHostDeviceId: host.deviceId,
        frame: pending.proofFrame,
        logicalOrder: pending.proofFrame.grant.logicalOrder,
      });
    }
    const delivery = keyPackageDelivery(state, pending);
    if (delivery) effects.push(delivery);
  }
}

function clearAdmission(member: SecureRelayMemberStateV4): void {
  member.admissionId = null;
  member.admissionExpiresAt = null;
  member.keyPackage = null;
  member.keyPackageDigest = null;
  member.pendingPhase = null;
  member.admissionCommitMessageId = null;
  member.welcomeMessageId = null;
  member.proofMessageId = null;
  member.proofFrame = null;
  member.proofGrant = null;
}

function retireMember(member: SecureRelayMemberStateV4): void {
  member.status = "retired";
  member.connectionId = null;
  member.resumeStatus = null;
  member.resumePhase = null;
  member.resumeRequestId = null;
  member.disconnectExpiresAt = null;
  member.backlog = [];
  member.backlogBytes = 0;
  member.requiresFreshAdmission = false;
  clearAdmission(member);
}

function grantEquals(left: SecureLogicalOrderGrantV4, right: SecureGrantStateV4): boolean {
  return left.v === right.v && left.suite === right.suite && left.roomInstance === right.roomInstance
    && left.requestId === right.requestId && left.tokenId === right.tokenId
    && left.deviceId === right.deviceId && left.logicalOrder === right.logicalOrder
    && left.expiresAt === right.expiresAt;
}

function validateGrantTokenId(state: SecureRelayStateV4, tokenId: unknown): tokenId is string {
  return isMessageId(tokenId) && !hasReplayId(state, tokenId)
    && !state.members.some((member) => member.deviceId === tokenId || member.connectionId === tokenId);
}

function issueNextGrant(
  state: SecureRelayStateV4,
  now: number,
  tokenId: unknown,
  effects: SecureRelayEffectV4[],
): SecureRelayErrorCodeV4 | null {
  const removalBarrier = state.pendingZombieRemovals[0];
  const admissionBarrier = activeAdmissionBarrier(state);
  const proofOrderReserved = state.members.some((member) => member.admissionId !== null
    && member.pendingPhase === "awaiting-proof");
  if (state.currentGrant || state.pendingApplication || state.pendingCommit
    || (!removalBarrier && !admissionBarrier && proofOrderReserved) || state.orderQueue.length === 0
    || (!!removalBarrier && removalBarrier.removalCommitMessageId !== null)) return null;
  if (removalBarrier && state.orderQueue[0].deviceId !== state.hostDeviceId) return "invalid-state";
  if (admissionBarrier && (admissionBarrier.pendingPhase !== "awaiting-bootstrap"
    || state.orderQueue[0].deviceId !== state.hostDeviceId)) return null;
  if (!validateGrantTokenId(state, tokenId)) return "grant-token-required";
  if (now > Number.MAX_SAFE_INTEGER - SECURE_ORDER_GRANT_TTL_MS_V4) return "order-exhausted";
  const entry = state.orderQueue.shift()!;
  const grant: SecureGrantStateV4 = {
    v: 4,
    suite: 1,
    roomInstance: state.roomInstance,
    requestId: entry.requestId,
    tokenId,
    deviceId: entry.deviceId,
    logicalOrder: state.nextLogicalOrder,
    expiresAt: now + SECURE_ORDER_GRANT_TTL_MS_V4,
    connectionId: entry.connectionId,
  };
  state.currentGrant = grant;
  recordReplay(state, tokenId, "grant-token", entry.deviceId, now);
  const { connectionId: _connectionId, ...wireGrant } = grant;
  effects.push({ type: "order-granted", toDeviceId: entry.deviceId, grant: wireGrant });
  return null;
}

function issueAdmissionProofGrant(
  state: SecureRelayStateV4,
  pending: SecureRelayMemberStateV4,
  now: number,
  tokenId: unknown,
  effects: SecureRelayEffectV4[],
): SecureRelayErrorCodeV4 | null {
  if (pending.admissionId === null || pending.admissionExpiresAt === null
    || pending.connectionId === null || pending.pendingPhase !== "awaiting-proof"
    || pending.proofGrant !== null) return "invalid-state";
  if (!validateGrantTokenId(state, tokenId)) return "grant-token-required";
  if (now >= pending.admissionExpiresAt) return "grant-expired";
  const grant: SecureGrantStateV4 = {
    v: 4,
    suite: 1,
    roomInstance: state.roomInstance,
    requestId: pending.admissionId,
    tokenId,
    deviceId: pending.deviceId,
    logicalOrder: state.nextLogicalOrder,
    expiresAt: pending.admissionExpiresAt,
    connectionId: pending.connectionId,
  };
  pending.proofGrant = grant;
  recordReplay(state, tokenId, "grant-token", pending.deviceId, now);
  const { connectionId: _connectionId, ...wireGrant } = grant;
  effects.push({ type: "order-granted", toDeviceId: pending.deviceId, grant: wireGrant });
  return null;
}

function expireCurrentGrant(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  if (!state.currentGrant || now < state.currentGrant.expiresAt) return;
  const tokenRecord = replayRecord(
    state, state.currentGrant.tokenId, "grant-token", state.currentGrant.deviceId,
  );
  if (!tokenRecord) throw new Error("secure grant token lost before expiration");
  tokenRecord.kind = "grant-expired";
  effects.push({
    type: "order-expired",
    deviceId: state.currentGrant.deviceId,
    tokenId: state.currentGrant.tokenId,
  });
  state.currentGrant = null;
}

function expirePendingApplication(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): boolean {
  const pending = state.pendingApplication;
  if (!pending || now < pending.decisionExpiresAt) return false;
  const record = replayRecord(state, pending.frame.envelope.messageId);
  if (record?.kind === "application-pending") {
    record.kind = "application-rejected";
    record.rejectionReason = "approval-expired";
  }
  deliverApplicationResult(
    state, pending.fromDeviceId, pending.frame.envelope.messageId, pending.logicalOrder,
    "rejected", "approval-expired", now, effects,
  );
  state.pendingApplication = null;
  const authorizationId = pending.frame.relayKind === "host-transfer-accept"
    ? pending.frame.authorizationId
    : undefined;
  const transfer = state.pendingHostTransfer;
  if (authorizationId !== undefined && transfer?.authorizationId === authorizationId) {
    state.pendingHostTransfer = null;
    effects.push({
      type: "host-transfer-expired",
      deviceIds: [transfer.hostDeviceId, transfer.targetDeviceId],
      authorizationId,
    });
  }
  return true;
}

function expirePendingCommit(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): boolean {
  const pending = state.pendingCommit;
  if (!pending || now < pending.decisionExpiresAt) return false;
  const record = replayRecord(state, pending.frame.envelope.messageId, "commit-pending", pending.fromDeviceId);
  if (record) {
    record.kind = "commit-rejected";
    record.rejectionReason = "approval-expired";
  }
  state.pendingCommit = null;
  deliverCommitResult(
    state,
    pending.fromDeviceId,
    pending.frame.envelope.messageId,
    "rejected",
    "approval-expired",
    now,
    effects,
  );
  return true;
}

function retirePendingAdmission(
  state: SecureRelayStateV4,
  pending: SecureRelayMemberStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): void {
  const admissionCommitMessageId = pending.admissionCommitMessageId;
  if (pending.proofMessageId !== null) {
    const proofRecord = replayRecord(state, pending.proofMessageId, "join-proof-pending", pending.deviceId);
    if (proofRecord) {
      proofRecord.kind = "application-rejected";
      proofRecord.rejectionReason = "member-retired";
      effects.push({
        type: "application-rejected",
        deviceId: pending.deviceId,
        messageId: pending.proofMessageId,
        logicalOrder: proofRecord.logicalOrder!,
        reason: "member-retired",
      });
    }
  }
  retireMember(pending);
  effects.push({ type: "member-lifecycle", deviceId: pending.deviceId, status: "retired" });
  if (admissionCommitMessageId) {
    persistZombieRemoval(state, pending.deviceId, pending.memberBinding.admissionId, now, effects);
  }
}

function expirePendingAdmission(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): boolean {
  const pending = state.members.find((member) => member.admissionId !== null
    && member.admissionExpiresAt !== null && now >= member.admissionExpiresAt);
  if (!pending) return false;
  retirePendingAdmission(state, pending, now, effects);
  return true;
}

function expirePendingHostTransfer(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): boolean {
  const pending = state.pendingHostTransfer;
  if (!pending || now < pending.expiresAt) return false;
  state.pendingHostTransfer = null;
  effects.push({
    type: "host-transfer-expired",
    deviceIds: [pending.hostDeviceId, pending.targetDeviceId],
    authorizationId: pending.authorizationId,
  });
  return true;
}

function retireRoomAfterHostLoss(
  state: SecureRelayStateV4,
  effects: SecureRelayEffectV4[],
): void {
  if (state.pendingApplication) {
    const pending = state.pendingApplication;
    const record = replayRecord(
      state,
      pending.frame.envelope.messageId,
      "application-pending",
      pending.fromDeviceId,
    );
    if (record) {
      record.kind = "application-rejected";
      record.rejectionReason = "member-retired";
    }
  }
  if (state.pendingCommit) {
    const pending = state.pendingCommit;
    const record = replayRecord(
      state,
      pending.frame.envelope.messageId,
      "commit-pending",
      pending.fromDeviceId,
    );
    if (record) {
      record.kind = "commit-rejected";
      record.rejectionReason = "member-retired";
    }
  }
  for (const member of state.members) retireMember(member);
  state.lifecycle = "retired";
  state.hostDeviceId = null;
  state.currentGrant = null;
  state.pendingApplication = null;
  state.pendingCommit = null;
  state.pendingHostTransfer = null;
  state.pendingZombieRemovals = [];
  state.orderQueue = [];
  effects.push({ type: "room-retired" });
}

function expireActiveDisconnects(
  state: SecureRelayStateV4,
  now: number,
  effects: SecureRelayEffectV4[],
): boolean {
  const expired = state.members.filter((member) => member.status === "disconnected"
    && member.resumeStatus === "active" && !member.requiresFreshAdmission
    && member.disconnectExpiresAt !== null && now >= member.disconnectExpiresAt);
  if (expired.length === 0) return false;
  if (expired.some((member) => member.deviceId === state.hostDeviceId)) {
    retireRoomAfterHostLoss(state, effects);
    return true;
  }
  for (const member of expired) {
    if (state.pendingApplication?.fromDeviceId === member.deviceId) {
      const pending = state.pendingApplication;
      const record = replayRecord(state, pending.frame.envelope.messageId, "application-pending", member.deviceId);
      if (record) {
        record.kind = "application-rejected";
        record.rejectionReason = "member-retired";
      }
      state.pendingApplication = null;
    }
    if (state.pendingCommit?.fromDeviceId === member.deviceId) {
      const pending = state.pendingCommit;
      const record = replayRecord(state, pending.frame.envelope.messageId, "commit-pending", member.deviceId);
      if (record) {
        record.kind = "commit-rejected";
        record.rejectionReason = "member-retired";
      }
      state.pendingCommit = null;
    }
    const transfer = state.pendingHostTransfer;
    if (transfer && (transfer.hostDeviceId === member.deviceId || transfer.targetDeviceId === member.deviceId)) {
      state.pendingHostTransfer = null;
      effects.push({
        type: "host-transfer-expired",
        deviceIds: [transfer.hostDeviceId, transfer.targetDeviceId],
        authorizationId: transfer.authorizationId,
      });
    }
    removeDeviceFromOrdering(state, member.deviceId);
    member.backlog = [];
    member.backlogBytes = 0;
    member.resumePhase = null;
    member.resumeRequestId = null;
    member.disconnectExpiresAt = null;
    member.requiresFreshAdmission = true;
    effects.push({ type: "fresh-admission-required", deviceId: member.deviceId });
    effects.push({ type: "member-lifecycle", deviceId: member.deviceId, status: "disconnected" });
    if (member.membershipCommitMessageId) {
      persistZombieRemoval(state, member.deviceId, member.memberBinding.admissionId, now, effects);
    }
  }
  return true;
}

function removeDeviceFromOrdering(
  state: SecureRelayStateV4,
  deviceId: string,
  cancellationReason?: SecureOrderCancellationReasonV4,
): void {
  if (cancellationReason !== undefined) {
    if (state.currentGrant?.deviceId === deviceId) {
      persistOrderCancellation(
        state, deviceId, state.currentGrant.requestId, cancellationReason,
      );
    }
    for (const queued of state.orderQueue.filter((entry) => entry.deviceId === deviceId)) {
      persistOrderCancellation(state, deviceId, queued.requestId, cancellationReason);
    }
  }
  state.orderQueue = state.orderQueue.filter((entry) => entry.deviceId !== deviceId);
  if (state.currentGrant?.deviceId === deviceId) state.currentGrant = null;
}

function cleanClone(state: SecureRelayStateV4): SecureRelayStateV4 | null {
  return parseSecureRelayStateV4(state);
}

/**
 * Create a v4 room.  Persist the returned state before emitting any effects.
 */
export async function createSecureRelayStateV4(
  actorValue: SecureRelayActorV4,
  frameValue: unknown,
  now: number,
): Promise<SecureRelayCreateResultV4> {
  const actor = parseActor(actorValue);
  const frame = parseSecureClientFrameV4(frameValue);
  if (!actor || !isSafeTimestamp(now)) return reject("invalid-actor");
  if (!frame) return reject("invalid-frame");
  if (frame.kind !== "setup") return reject("downgrade");
  if (actor.authentication !== "invitation") return reject("authentication-required");
  if (frame.hello.deviceId !== actor.deviceId) return reject("device-mismatch");
  if (new Set([frame.hello.roomInstance, frame.hello.deviceId, frame.requestId, actor.connectionId]).size !== 4) {
    return reject("duplicate-id");
  }
  const digest = await roomInvitationKeyPackageDigestV4(frame.hello.keyPackage);
  if (frame.memberBinding.keyPackageDigest !== digest) return reject("invalid-frame");
  const state: SecureRelayStateV4 = {
    schema: SECURE_RELAY_STATE_SCHEMA_V4,
    revision: 1,
    clockHighWater: now,
    v: 4,
    suite: 1,
    roomInstance: frame.hello.roomInstance,
    lifecycle: "open",
    hostDeviceId: actor.deviceId,
    members: [{
      deviceId: actor.deviceId,
      signaturePublicKey: frame.signaturePublicKey,
      memberBinding: frame.memberBinding,
      status: "active",
      joinedOrder: 1,
      connectionId: actor.connectionId,
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
      // The authenticated setup request is the founder's immutable MLS
      // establishment binding. If host authority later transfers away, this
      // gives the relay an exact capability to require removal of the former
      // founder leaf after disconnect expiry or backlog overflow.
      membershipCommitMessageId: frame.requestId,
      welcomeMessageId: null,
      proofMessageId: null,
      proofFrame: null,
      proofGrant: null,
      backlog: [],
      backlogBytes: 0,
      requiresFreshAdmission: false,
    }],
    nextMemberOrder: 2,
    nextLogicalOrder: 1,
    currentGrant: null,
    pendingApplication: null,
    pendingCommit: null,
    pendingHostTransfer: null,
    pendingZombieRemovals: [],
    orderQueue: [],
    recentMessages: [],
    recentKeyPackageDigests: [],
  };
  recordReplay(state, frame.requestId, "setup-request", actor.deviceId, now);
  recordKeyPackageDigest(state, digest);
  return {
    ok: true,
    state,
    effects: [{ type: "member-lifecycle", deviceId: actor.deviceId, status: "active" }],
  };
}

function frameRoomInstance(frame: SecureClientFrameV4): string {
  if (frame.kind === "setup" || frame.kind === "join") return frame.hello.roomInstance;
  if (frame.kind === "relay") return frame.envelope.roomInstance;
  return frame.roomInstance;
}

/**
 * Apply one authenticated client frame as a pure state transition.  The caller
 * must atomically persist `state` before delivering `effects`; rejected frames
 * never consume replay IDs or mutate the supplied snapshot.
 */
export async function reduceSecureRelayV4(
  stateValue: SecureRelayStateV4,
  actorValue: SecureRelayActorV4,
  frameValue: unknown,
  options: SecureRelayReduceOptionsV4,
): Promise<SecureRelayTransitionV4> {
  const state = cleanClone(stateValue);
  const actor = parseActor(actorValue);
  const frame = parseSecureClientFrameV4(frameValue);
  if (!state) return reject("invalid-state");
  if (!actor || !isSafeTimestamp(options?.now)) return reject("invalid-actor");
  if (!frame) return reject("invalid-frame");
  if (frame.kind === "setup") return reject("downgrade");
  if (frameRoomInstance(frame) !== state.roomInstance) return reject("wrong-room");
  if ((frame.kind === "join" && frame.hello.deviceId !== actor.deviceId)
    || (frame.kind === "resume" && frame.deviceId !== actor.deviceId)) {
    return reject("device-mismatch");
  }
  if (connectionIdInUse(state, actor.connectionId, actor.deviceId)) return reject("connection-mismatch");

  const now = options.now;
  const controlDigest = isRecoverableControlFrame(frame)
    ? await secureFrameDigest(frame)
    : null;
  const relayDigest = frame.kind === "relay"
    ? await secureFrameDigest(frame)
    : null;
  if (state.lifecycle !== "open") {
    if (frame.kind === "close-room" && controlDigest !== null) {
      const retryEffects: SecureRelayEffectV4[] = [];
      const retry = recoverControlRetry(state, actor, frame, controlDigest, retryEffects);
      if (retry === "handled") {
        if (now < state.clockHighWater) return reject("clock-regression");
        if (state.revision >= Number.MAX_SAFE_INTEGER) return reject("revision-exhausted");
        state.revision += 1;
        state.clockHighWater = now;
        return { ok: true, state, effects: retryEffects };
      }
      if (retry !== "not-found") return reject(retry);
    }
    return reject("room-retired");
  }
  if (now < state.clockHighWater) return reject("clock-regression");
  if (state.revision >= Number.MAX_SAFE_INTEGER) return reject("revision-exhausted");
  state.revision += 1;
  state.clockHighWater = now;
  const effects: SecureRelayEffectV4[] = [];
  const inFlightGlobalGrantFrame = frame.kind === "relay"
    && frame.relayKind !== "welcome" && frame.relayKind !== "join-proof"
    && state.currentGrant !== null
    && state.currentGrant.deviceId === actor.deviceId
    && state.currentGrant.connectionId === actor.connectionId
    && grantEquals(frame.grant, state.currentGrant)
    ? frame
    : null;
  const disconnectedExpired = expireActiveDisconnects(state, now, effects);
  if (state.hostDeviceId === null) return { ok: true, state, effects };
  if (frame.kind === "resume" && effects.some((effect) => effect.type === "fresh-admission-required"
    && effect.deviceId === actor.deviceId)) return { ok: true, state, effects };

  if (frame.kind !== "join" && frame.kind !== "resume") {
    const admissionExpired = expirePendingAdmission(state, now, effects);
    const applicationExpired = expirePendingApplication(state, now, effects);
    const transferExpired = expirePendingHostTransfer(state, now, effects);
    const commitExpired = expirePendingCommit(state, now, effects);
    if (disconnectedExpired || admissionExpired || applicationExpired || transferExpired || commitExpired) {
      if (inFlightGlobalGrantFrame && relayDigest !== null) {
        const cancellation = effects.find((effect): effect is Extract<
          SecureRelayEffectV4,
          { type: "order-cancelled" }
        > => effect.type === "order-cancelled"
          && effect.deviceId === actor.deviceId
          && effect.requestId === inFlightGlobalGrantFrame.grant.requestId);
        if (cancellation && (cancellation.reason === "removal-pending"
          || cancellation.reason === "admission-pending")) {
          terminalizeGrantBoundRelay(
            state, actor, inFlightGlobalGrantFrame, relayDigest, cancellation.reason, now, effects,
          );
        }
      }
      const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
      if (grantError) return reject(grantError);
      return { ok: true, state, effects };
    }
  }

  if (frame.kind === "join") {
    if (state.pendingZombieRemovals.length !== 0) return reject("removal-pending");
    if (frame.requestId === actor.deviceId || frame.requestId === actor.connectionId
      || actor.deviceId === actor.connectionId) return reject("duplicate-id");
    const digest = await roomInvitationKeyPackageDigestV4(frame.hello.keyPackage);
    if (frame.memberBinding.keyPackageDigest !== digest) return reject("invalid-frame");
    const frameDigest = await secureFrameDigest(frame);
    const existing = memberById(state, actor.deviceId);
    if (actor.authentication !== "invitation") return reject("authentication-required");
    const priorJoin = replayRecord(state, frame.requestId, "join-request", actor.deviceId);
    if (priorJoin) {
      if (!existing || priorJoin.frameDigest !== frameDigest || existing.admissionId !== frame.requestId
        || existing.keyPackageDigest !== digest || existing.signaturePublicKey !== frame.signaturePublicKey
        || existing.admissionExpiresAt === null || now >= existing.admissionExpiresAt
        || (existing.status !== "pending" && existing.status !== "disconnected")) return reject("duplicate-id");
      existing.status = "pending";
      existing.connectionId = actor.connectionId;
      existing.resumeStatus = null;
      existing.resumePhase = null;
      existing.resumeRequestId = null;
      if (existing.proofGrant) existing.proofGrant.connectionId = actor.connectionId;
      effects.push({ type: "member-lifecycle", deviceId: actor.deviceId, status: "pending" });
      const delivery = keyPackageDelivery(state, existing);
      if (delivery) effects.push(delivery);
      if (existing.backlog.length > 0) {
        effects.push({
          type: "replay-backlog",
          toDeviceId: existing.deviceId,
          entries: existing.backlog.map((entry) => ({ ...entry })),
        });
        effects.push({
          type: "backlog-end",
          toDeviceId: existing.deviceId,
          lastMessageId: backlogEntryMessageId(existing.backlog[existing.backlog.length - 1]),
        });
      }
      if (existing.proofGrant) {
        const { connectionId: _connectionId, ...wireGrant } = existing.proofGrant;
        effects.push({ type: "order-granted", toDeviceId: existing.deviceId, grant: wireGrant });
      }
      return { ok: true, state, effects };
    }
    if (hasReplayId(state, frame.requestId)) return reject("duplicate-id");
    if (state.recentKeyPackageDigests.includes(digest)) return reject("duplicate-key-package");
    if (state.recentKeyPackageDigests.length >= MAX_SECURE_KEY_PACKAGE_DIGESTS_V4) {
      return reject("key-package-limit");
    }
    if (existing) return reject("device-exists");
    if (state.pendingHostTransfer) return reject("pending-limit");
    if (state.members.filter((candidate) => candidate.status !== "retired").length >= MAX_SECURE_RELAY_MEMBERS_V4) {
      return reject("member-limit");
    }
    const pendingCount = state.members.filter((member) => member.admissionId !== null).length;
    if (pendingCount >= 1) return reject("pending-limit");
    if (state.nextMemberOrder >= Number.MAX_SAFE_INTEGER
      || now > Number.MAX_SAFE_INTEGER - SECURE_ADMISSION_TTL_MS_V4) return reject("order-exhausted");
    pruneOldestRetiredTombstone(state);
    const joining: SecureRelayMemberStateV4 = {
      deviceId: actor.deviceId,
      signaturePublicKey: frame.signaturePublicKey,
      memberBinding: frame.memberBinding,
      status: "pending",
      joinedOrder: state.nextMemberOrder,
      connectionId: actor.connectionId,
      resumeStatus: null,
      resumePhase: null,
      resumeRequestId: null,
      disconnectExpiresAt: null,
      admissionId: frame.requestId,
      admissionExpiresAt: now + SECURE_ADMISSION_TTL_MS_V4,
      keyPackage: frame.hello.keyPackage,
      keyPackageDigest: digest,
      pendingPhase: "awaiting-welcome",
      admissionCommitMessageId: null,
      membershipCommitMessageId: null,
      welcomeMessageId: null,
      proofMessageId: null,
      proofFrame: null,
      proofGrant: null,
      backlog: [],
      backlogBytes: 0,
      requiresFreshAdmission: false,
    };
    state.nextMemberOrder += 1;
    state.members.push(joining);
    recordReplay(state, frame.requestId, "join-request", actor.deviceId, now, { frameDigest });
    recordKeyPackageDigest(state, digest);
    effects.push({ type: "member-lifecycle", deviceId: actor.deviceId, status: "pending" });
    const delivery = keyPackageDelivery(state, joining);
    if (delivery) effects.push(delivery);
    return { ok: true, state, effects };
  }

  if (frame.kind === "resume") {
    if (hasReplayId(state, frame.requestId)) return reject("duplicate-id");
    if (frame.requestId === actor.deviceId || frame.requestId === actor.connectionId
      || actor.deviceId === actor.connectionId) return reject("duplicate-id");
    if (actor.authentication !== "device") return reject("authentication-required");
    const existing = memberById(state, actor.deviceId);
    if (!existing) return reject("unknown-device");
    const resumableActive = existing.admissionId === null && (
      existing.status === "active"
      || (existing.status === "disconnected" && existing.resumeStatus === "active")
      || (existing.status === "pending" && existing.resumePhase === "replaying-backlog")
    );
    if (!resumableActive) {
      return reject("invalid-lifecycle");
    }
    if (existing.requiresFreshAdmission) return reject("fresh-admission-required");
    existing.connectionId = actor.connectionId;
    existing.resumeStatus = null;
    existing.disconnectExpiresAt = null;
    // Every resume enters one explicit persisted recovery phase, even with an
    // empty delivery backlog. This prevents durable client retries from racing
    // ahead of the authoritative relay snapshot. The resume request ID is the
    // empty-backlog end sentinel acknowledged by resume-complete.
    existing.status = "pending";
    existing.resumePhase = "replaying-backlog";
    existing.resumeRequestId = frame.requestId;
    recordReplay(state, frame.requestId, "resume-request", actor.deviceId, now);
    effects.push({ type: "member-lifecycle", deviceId: actor.deviceId, status: "pending" });
    const currentMarker = state.pendingZombieRemovals[0] || null;
    let currentMarkerEmitted = false;
    let replaySegment: SecureBacklogEntryV4[] = [];
    const flushReplaySegment = (): void => {
      if (replaySegment.length === 0) return;
      effects.push({
        type: "replay-backlog",
        toDeviceId: actor.deviceId,
        entries: replaySegment.map((entry) => ({ ...entry })),
      });
      replaySegment = [];
    };
    for (const entry of existing.backlog) {
      const entryMessageId = backlogEntryMessageId(entry);
      if (currentMarker && !currentMarkerEmitted
        && (entry.receivedAt > currentMarker.requestedAt
          || (currentMarker.removalCommitMessageId !== null
            && entryMessageId === currentMarker.removalCommitMessageId))) {
        flushReplaySegment();
        emitZombieRemovalBarrier(state, effects, actor.deviceId);
        currentMarkerEmitted = true;
      }
      if (entry.kind === "relay" && entry.frame.relayKind === "commit"
        && entry.frame.retirementDeviceId !== undefined
        && entry.frame.retirementAdmissionCommitMessageId !== undefined) {
        flushReplaySegment();
        emitZombieRemovalBarrier(state, effects, actor.deviceId, {
          deviceId: entry.frame.retirementDeviceId,
          admissionCommitMessageId: entry.frame.retirementAdmissionCommitMessageId,
        });
        if (currentMarker?.deviceId === entry.frame.retirementDeviceId
          && currentMarker.admissionCommitMessageId
            === entry.frame.retirementAdmissionCommitMessageId) currentMarkerEmitted = true;
      }
      replaySegment.push(entry);
    }
    flushReplaySegment();
    if (currentMarker && !currentMarkerEmitted) {
      emitZombieRemovalBarrier(state, effects, actor.deviceId);
    }
    emitRoomStateSnapshot(state, actor.deviceId, effects);
    effects.push({
      type: "backlog-end",
      toDeviceId: actor.deviceId,
      lastMessageId: existing.backlog.length === 0
        ? frame.requestId
        : backlogEntryMessageId(existing.backlog[existing.backlog.length - 1]),
    });
    return { ok: true, state, effects };
  }

  const member = memberById(state, actor.deviceId);
  if (!member) return reject("unknown-device");
  if (member.connectionId !== actor.connectionId) return reject("connection-mismatch");

  if (controlDigest !== null && isRecoverableControlFrame(frame)) {
    const retry = recoverControlRetry(state, actor, frame, controlDigest, effects);
    if (retry === "handled") return { ok: true, state, effects };
    if (retry !== "not-found") return reject(retry);
  }

  if (frame.kind === "relay") {
    const { envelope } = frame;
    const retry = recoverRelayRetry(state, actor, frame, relayDigest, effects);
    if (retry === "handled") return { ok: true, state, effects };
    if (retry !== "not-found") return reject(retry);

    const removalBarrier = state.pendingZombieRemovals[0];
    if (removalBarrier && frame.relayKind !== "commit") return reject("removal-pending");
    if (!removalBarrier && frame.relayKind === "commit"
      && (frame.retirementDeviceId !== undefined
        || frame.retirementAdmissionCommitMessageId !== undefined)) return reject("invalid-reference");
    const admissionBarrier = activeAdmissionBarrier(state);
    if (admissionBarrier) {
      const allowed =
        (frame.relayKind === "welcome"
          && admissionBarrier.pendingPhase === "awaiting-welcome"
          && actor.deviceId === state.hostDeviceId)
        || (frame.relayKind === "bootstrap"
          && admissionBarrier.pendingPhase === "awaiting-bootstrap"
          && actor.deviceId === state.hostDeviceId)
        || (frame.relayKind === "join-proof"
          && admissionBarrier.pendingPhase === "awaiting-proof"
          && actor.deviceId === admissionBarrier.deviceId);
      if (!allowed) return reject("admission-pending");
    }

    if (frame.relayKind === "commit") {
      if (member.status !== "active") return reject("pending-cannot-send");
      if (member.backlog.length !== 0) return reject("delivery-pending");
      if (envelope.route !== "group" || envelope.to !== undefined) return reject("invalid-route");
      const grant = state.currentGrant;
      if (!grant || grant.deviceId !== actor.deviceId || grant.connectionId !== actor.connectionId
        || !grantEquals(frame.grant, grant)) return reject("invalid-grant");
      if (now >= grant.expiresAt) {
        expireCurrentGrant(state, now, effects);
        terminalizeGrantBoundRelay(state, actor, frame, relayDigest!, "grant-expired", now, effects);
        const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
        if (grantError) return reject(grantError);
        return { ok: true, state, effects };
      }
      if (grant.logicalOrder !== state.nextLogicalOrder) return reject("invalid-state");
      const isHost = state.hostDeviceId === actor.deviceId;
      if (removalBarrier) {
        if (!isHost || removalBarrier.removalCommitMessageId !== null) return reject("removal-pending");
        if (frame.retirementDeviceId !== removalBarrier.deviceId
          || frame.retirementAdmissionCommitMessageId !== removalBarrier.admissionCommitMessageId) {
          return reject("invalid-reference");
        }
      } else if (frame.retirementDeviceId !== undefined
        || frame.retirementAdmissionCommitMessageId !== undefined) {
        return reject("invalid-reference");
      }
      if (frame.admissionId !== undefined) {
        if (!isHost) return reject("host-required");
        const pending = state.members.find((candidate) => candidate.admissionId === frame.admissionId);
        if (!pending || pending.status !== "pending" || pending.pendingPhase !== "awaiting-welcome"
          || pending.admissionCommitMessageId !== null) return reject("invalid-admission");
        pending.admissionCommitMessageId = envelope.messageId;
      }
      if (!isHost) {
        const host = connectedHost(state);
        if (!host || host.backlog.length !== 0) return reject("recipient-unavailable");
        if (now > Number.MAX_SAFE_INTEGER - SECURE_COMMIT_APPROVAL_TTL_MS_V4) {
          return reject("order-exhausted");
        }
        state.currentGrant = null;
        state.pendingCommit = {
          fromDeviceId: actor.deviceId,
          connectionId: actor.connectionId,
          receivedAt: now,
          decisionExpiresAt: now + SECURE_COMMIT_APPROVAL_TTL_MS_V4,
          frame,
        };
        recordReplay(state, envelope.messageId, "commit-pending", actor.deviceId, now, {
          frameDigest: relayDigest!,
        });
        effects.push({
          type: "commit-preview",
          fromDeviceId: actor.deviceId,
          toHostDeviceId: host.deviceId,
          frame,
          logicalOrder: grant.logicalOrder,
        });
        return { ok: true, state, effects };
      }
      state.currentGrant = null;
      if (removalBarrier) removalBarrier.removalCommitMessageId = envelope.messageId;
      if (frame.admissionId !== undefined) activateAdmissionBarrier(state, effects);
      recordReplay(state, envelope.messageId, "commit", actor.deviceId, now, {
        frameDigest: relayDigest!,
      });
      routeGroupFrame(state, actor.deviceId, frame, null, now, effects);
      deliverCommitResult(state, actor.deviceId, envelope.messageId, "accepted", null, now, effects);
      const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
      if (grantError) return reject(grantError);
      return { ok: true, state, effects };
    }

    if (frame.relayKind === "welcome") {
      if (member.status !== "active" || state.hostDeviceId !== actor.deviceId) return reject("host-required");
      if (member.backlog.length !== 0) return reject("delivery-pending");
      if (envelope.route !== "device" || envelope.to === undefined) return reject("invalid-route");
      const pending = memberById(state, envelope.to);
      if (!pending || pending.status !== "pending" || pending.pendingPhase !== "awaiting-welcome"
        || pending.admissionId !== frame.admissionId
        || pending.admissionCommitMessageId !== frame.commitMessageId) return reject("invalid-admission");
      pending.pendingPhase = "awaiting-bootstrap";
      pending.keyPackage = null;
      pending.welcomeMessageId = envelope.messageId;
      recordReplay(state, envelope.messageId, "welcome", actor.deviceId, now, {
        frameDigest: relayDigest!,
      });
      const delivery = appendBacklog(state, pending, {
        kind: "relay",
        receivedAt: now,
        fromDeviceId: actor.deviceId,
        logicalOrder: null,
        frame,
      }, effects);
      effects.push({
        type: "route-relay", fromDeviceId: actor.deviceId,
        toDeviceIds: delivery === "live" ? [pending.deviceId] : [], frame, logicalOrder: null,
      });
      effects.push({
        type: "frame-accepted", deviceId: actor.deviceId, messageId: envelope.messageId,
      });
      return { ok: true, state, effects };
    }

    if (frame.relayKind === "bootstrap") {
      if (member.status !== "active" || state.hostDeviceId !== actor.deviceId) return reject("host-required");
      if (member.backlog.length !== 0) return reject("delivery-pending");
      if (envelope.route !== "group" || envelope.to !== undefined) return reject("invalid-route");
      const pending = state.members.find((candidate) => candidate.admissionId === frame.admissionId);
      if (!pending || pending.status !== "pending" || pending.pendingPhase !== "awaiting-bootstrap"
        || pending.welcomeMessageId !== frame.welcomeMessageId) return reject("invalid-admission");
      const grant = state.currentGrant;
      if (!grant || grant.deviceId !== actor.deviceId || grant.connectionId !== actor.connectionId
        || !grantEquals(frame.grant, grant)) return reject("invalid-grant");
      if (now >= grant.expiresAt) {
        expireCurrentGrant(state, now, effects);
        terminalizeGrantBoundRelay(state, actor, frame, relayDigest!, "grant-expired", now, effects);
        const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
        if (grantError) return reject(grantError);
        return { ok: true, state, effects };
      }
      if (grant.logicalOrder !== state.nextLogicalOrder || state.nextLogicalOrder >= Number.MAX_SAFE_INTEGER) {
        return reject("order-exhausted");
      }
      state.currentGrant = null;
      state.nextLogicalOrder += 1;
      pending.pendingPhase = "awaiting-proof";
      recordReplay(state, envelope.messageId, "bootstrap", actor.deviceId, now, {
        logicalOrder: grant.logicalOrder,
        frameDigest: relayDigest!,
      });
      const recipients = routeGroupFrame(state, actor.deviceId, frame, grant.logicalOrder, now, effects);
      // Routing can synchronously overflow an unrelated backlog, activating a
      // removal barrier that retires this admission. Preserve the causally
      // earlier accepted bootstrap and cleanup transition, but never append to
      // the retired member or mint it a proof grant.
      const routedPending = memberById(state, pending.deviceId);
      if (routedPending?.status === "pending" && routedPending.admissionId === frame.admissionId) {
        const pendingDelivery = appendBacklog(state, routedPending, {
          kind: "relay",
          receivedAt: now,
          fromDeviceId: actor.deviceId,
          logicalOrder: grant.logicalOrder,
          frame,
        }, effects);
        if (pendingDelivery === "live") recipients.push(pending.deviceId);
      }
      effects.push({
        type: "frame-accepted", deviceId: actor.deviceId, messageId: envelope.messageId,
      });
      const pendingAfterDelivery = memberById(state, pending.deviceId);
      if (pendingAfterDelivery?.status !== "pending"
        || pendingAfterDelivery.admissionId !== frame.admissionId) {
        return { ok: true, state, effects };
      }
      const proofGrantError = issueAdmissionProofGrant(
        state, pendingAfterDelivery, now, options.nextGrantTokenId, effects,
      );
      if (proofGrantError) return reject(proofGrantError);
      return { ok: true, state, effects };
    }

    if (frame.relayKind === "join-proof") {
      if (member.status !== "pending") return reject("invalid-lifecycle");
      if (member.backlog.length !== 0) return reject("delivery-pending");
      if (envelope.route !== "group" || envelope.to !== undefined) return reject("invalid-route");
      const proofGrant = member.proofGrant;
      if (member.pendingPhase !== "awaiting-proof" || member.admissionId !== frame.admissionId
        || member.welcomeMessageId !== frame.welcomeMessageId || member.proofMessageId !== null
        || !proofGrant || proofGrant.connectionId !== actor.connectionId
        || !grantEquals(frame.grant, proofGrant)
        || frame.grant.logicalOrder !== state.nextLogicalOrder) {
        return reject("invalid-admission");
      }
      if (now >= proofGrant.expiresAt) return reject("grant-expired");
      const host = connectedHost(state);
      if (!host || host.backlog.length !== 0) return reject("recipient-unavailable");
      member.proofMessageId = envelope.messageId;
      member.proofFrame = frame;
      recordReplay(state, envelope.messageId, "join-proof-pending", actor.deviceId, now, {
        logicalOrder: frame.grant.logicalOrder,
        frameDigest: relayDigest!,
      });
      effects.push({
        type: "admission-proof-preview", fromDeviceId: actor.deviceId,
        toHostDeviceId: host.deviceId, frame, logicalOrder: frame.grant.logicalOrder,
      });
      return { ok: true, state, effects };
    }

    if (member.status !== "active") return reject("pending-cannot-send");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    if (envelope.route !== "group" || envelope.to !== undefined) return reject("invalid-route");
    const grant = state.currentGrant;
    if (!grant || grant.deviceId !== actor.deviceId || grant.connectionId !== actor.connectionId
      || !grantEquals(frame.grant, grant)) return reject("invalid-grant");
    if (now >= grant.expiresAt) {
      expireCurrentGrant(state, now, effects);
      terminalizeGrantBoundRelay(state, actor, frame, relayDigest!, "grant-expired", now, effects);
      const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
      if (grantError) return reject(grantError);
      return { ok: true, state, effects };
    }
    if (grant.logicalOrder !== state.nextLogicalOrder) return reject("invalid-state");
    if (state.nextLogicalOrder >= Number.MAX_SAFE_INTEGER) return reject("order-exhausted");
    const isHost = state.hostDeviceId === actor.deviceId;
    const host = connectedHost(state);
    if (!isHost && (!host || host.backlog.length !== 0)) return reject("recipient-unavailable");
    const transferAuthorization = frame.relayKind === "host-transfer-accept"
      ? state.pendingHostTransfer
      : null;
    if (frame.relayKind === "host-transfer-accept" && (isHost || !transferAuthorization
      || transferAuthorization.authorizationId !== frame.authorizationId
      || transferAuthorization.targetDeviceId !== actor.deviceId
      || transferAuthorization.hostDeviceId !== state.hostDeviceId
      || now >= transferAuthorization.expiresAt)) return reject("invalid-reference");
    if (isHost && state.orderQueue.length > 0 && !validateGrantTokenId(state, options.nextGrantTokenId)) {
      return reject("grant-token-required");
    }
    if (!isHost && now > Number.MAX_SAFE_INTEGER - SECURE_APPLICATION_APPROVAL_TTL_MS_V4) {
      return reject("order-exhausted");
    }
    state.currentGrant = null;
    recordReplay(state, envelope.messageId, isHost ? "application" : "application-pending", actor.deviceId, now, {
      logicalOrder: grant.logicalOrder,
      frameDigest: relayDigest!,
    });
    if (!isHost) {
      state.pendingApplication = {
        fromDeviceId: actor.deviceId,
        connectionId: actor.connectionId,
        logicalOrder: grant.logicalOrder,
        receivedAt: now,
        decisionExpiresAt: now + SECURE_APPLICATION_APPROVAL_TTL_MS_V4,
        frame,
      };
      effects.push({
        type: "application-preview", fromDeviceId: actor.deviceId,
        toHostDeviceId: host!.deviceId, frame, logicalOrder: grant.logicalOrder,
      });
      return { ok: true, state, effects };
    }

    state.nextLogicalOrder += 1;
    routeGroupFrame(state, actor.deviceId, frame, grant.logicalOrder, now, effects);
    deliverApplicationResult(
      state,
      actor.deviceId,
      envelope.messageId,
      grant.logicalOrder,
      "accepted",
      null,
      now,
      effects,
    );
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "order-request") {
    if (member.status !== "active") return reject("active-member-required");
    const priorCancellation = replayRecord(
      state, frame.requestId, "order-cancelled", actor.deviceId,
    );
    if (priorCancellation && isOrderCancellationReason(priorCancellation.rejectionReason)) {
      effects.push({
        type: "order-cancelled",
        deviceId: actor.deviceId,
        requestId: frame.requestId,
        reason: priorCancellation.rejectionReason,
      });
      return { ok: true, state, effects };
    }
    if (hasReplayId(state, frame.requestId)) return reject("duplicate-id");
    const removalBarrier = state.pendingZombieRemovals[0];
    const admissionBarrier = activeAdmissionBarrier(state);
    const cancellationReason: SecureOrderCancellationReasonV4 | null =
      removalBarrier && (actor.deviceId !== state.hostDeviceId
        || removalBarrier.removalCommitMessageId !== null)
        ? "removal-pending"
        : admissionBarrier && (admissionBarrier.pendingPhase !== "awaiting-bootstrap"
          || actor.deviceId !== state.hostDeviceId)
          ? "admission-pending"
          : member.backlog.length !== 0
            ? "delivery-pending"
            : null;
    if (cancellationReason !== null) {
      // The client has already bound this request id to one local intent. A
      // generic error cannot identify or release that intent and permanently
      // wedges its grant queue. Persist and return the exact cancellation just
      // like a queued/current request displaced by a later barrier. Retrying
      // the same request deterministically replays this result above.
      recordReplay(state, frame.requestId, "order-request", actor.deviceId, now);
      persistOrderCancellation(state, actor.deviceId, frame.requestId, cancellationReason);
      effects.push({
        type: "order-cancelled",
        deviceId: actor.deviceId,
        requestId: frame.requestId,
        reason: cancellationReason,
      });
      return { ok: true, state, effects };
    }
    if (state.currentGrant?.deviceId === actor.deviceId
      || state.orderQueue.some((entry) => entry.deviceId === actor.deviceId)) return reject("order-already-pending");
    if (state.orderQueue.length >= MAX_SECURE_ORDER_QUEUE_V4) return reject("order-queue-full");
    const currentExpired = !!state.currentGrant && now >= state.currentGrant.expiresAt;
    const pendingExpired = !!state.pendingApplication && now >= state.pendingApplication.decisionExpiresAt;
    const pendingCommitExpired = !!state.pendingCommit && now >= state.pendingCommit.decisionExpiresAt;
    const needsGrant = (!state.pendingApplication || pendingExpired) && (!state.pendingCommit || pendingCommitExpired)
      && (!state.currentGrant || currentExpired);
    if (needsGrant && !validateGrantTokenId(state, options.nextGrantTokenId)) return reject("grant-token-required");
    expireCurrentGrant(state, now, effects);
    expirePendingApplication(state, now, effects);
    expirePendingCommit(state, now, effects);
    state.orderQueue.push({
      deviceId: actor.deviceId, connectionId: actor.connectionId,
      requestId: frame.requestId, enqueuedAt: now,
    });
    recordReplay(state, frame.requestId, "order-request", actor.deviceId, now);
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "delivery-ack") {
    if (hasReplayId(state, frame.requestId)) return reject("duplicate-id");
    if (member.status !== "active" && member.status !== "pending") return reject("invalid-lifecycle");
    const acknowledgedIndex = member.backlog.findIndex((entry) => backlogEntryMessageId(entry) === frame.lastMessageId);
    if (acknowledgedIndex < 0) return reject("invalid-reference");
    member.backlog.splice(0, acknowledgedIndex + 1);
    member.backlogBytes = member.backlog.reduce((total, entry) => total + backlogEntryBytes(entry), 0);
    recordReplay(state, frame.requestId, "delivery-ack", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    if (member.backlog.length === 0) emitHostPendingWork(state, member, effects);
    return { ok: true, state, effects };
  }

  if (frame.kind === "resume-complete") {
    if (member.status !== "pending" || member.resumePhase !== "replaying-backlog") {
      return reject("invalid-lifecycle");
    }
    if (hasReplayId(state, frame.requestId)) return reject("duplicate-id");
    const lastMessageId = member.backlog.length === 0
      ? member.resumeRequestId
      : backlogEntryMessageId(member.backlog[member.backlog.length - 1]);
    if (lastMessageId === null) return reject("invalid-state");
    if (frame.lastMessageId !== lastMessageId) return reject("invalid-reference");
    member.status = "active";
    member.resumePhase = null;
    member.resumeRequestId = null;
    member.backlog = [];
    member.backlogBytes = 0;
    recordReplay(state, frame.requestId, "resume-complete", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "member-lifecycle", deviceId: actor.deviceId, status: "active" });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    emitHostPendingWork(state, member, effects);
    return { ok: true, state, effects };
  }

  if (member.status !== "active") return reject("active-member-required");
  if (hasReplayId(state, frame.requestId)) return reject("duplicate-id");
  if (state.pendingZombieRemovals.length !== 0
    && frame.kind !== "retire-member"
    && frame.kind !== "cancel-admission"
    && frame.kind !== "close-room") return reject("removal-pending");
  if (activeAdmissionBarrier(state)
    && frame.kind !== "activate"
    && frame.kind !== "cancel-admission"
    && frame.kind !== "close-room") return reject("admission-pending");

  if (frame.kind === "commit-decision") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    const pending = state.pendingCommit;
    if (!pending || pending.frame.envelope.messageId !== frame.messageId) return reject("invalid-reference");
    if (now >= pending.decisionExpiresAt) return reject("grant-expired");
    if (frame.decision === "reject" && state.orderQueue.length > 0
      && !validateGrantTokenId(state, options.nextGrantTokenId)) return reject("grant-token-required");
    const commitRecord = replayRecord(state, frame.messageId, "commit-pending", pending.fromDeviceId);
    if (!commitRecord) return reject("invalid-state");
    state.pendingCommit = null;
    if (frame.decision === "approve") {
      commitRecord.kind = "commit";
      commitRecord.rejectionReason = null;
      routeGroupFrame(state, pending.fromDeviceId, pending.frame, null, now, effects);
      deliverCommitResult(
        state, pending.fromDeviceId, frame.messageId, "accepted", null, now, effects,
      );
    } else {
      commitRecord.kind = "commit-rejected";
      commitRecord.rejectionReason = "host-rejected";
      deliverCommitResult(
        state, pending.fromDeviceId, frame.messageId, "rejected", "host-rejected", now, effects,
      );
    }
    recordReplay(state, frame.requestId, "commit-decision", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "application-decision") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    const pending = state.pendingApplication;
    if (!pending || pending.frame.envelope.messageId !== frame.messageId) return reject("invalid-reference");
    if (now >= pending.decisionExpiresAt) return reject("grant-expired");
    const transfer = pending.frame.relayKind === "host-transfer-accept"
      ? state.pendingHostTransfer
      : null;
    if (pending.frame.relayKind === "host-transfer-accept" && (!transfer
      || transfer.authorizationId !== pending.frame.authorizationId
      || transfer.targetDeviceId !== pending.fromDeviceId
      || transfer.hostDeviceId !== actor.deviceId)) return reject("invalid-state");
    if (state.orderQueue.length > 0 && !validateGrantTokenId(state, options.nextGrantTokenId)) {
      return reject("grant-token-required");
    }
    const applicationRecord = replayRecord(state, pending.frame.envelope.messageId, "application-pending");
    if (!applicationRecord) return reject("invalid-state");
    state.pendingApplication = null;
    if (frame.decision === "approve") {
      if (state.nextLogicalOrder >= Number.MAX_SAFE_INTEGER) return reject("order-exhausted");
      applicationRecord.kind = "application";
      applicationRecord.rejectionReason = null;
      state.nextLogicalOrder += 1;
      routeGroupFrame(
        state, pending.fromDeviceId, pending.frame, pending.logicalOrder, now, effects,
      );
      deliverApplicationResult(
        state, pending.fromDeviceId, pending.frame.envelope.messageId, pending.logicalOrder,
        "accepted", null, now, effects,
      );
      if (transfer) {
        state.pendingHostTransfer = null;
        state.hostDeviceId = transfer.targetDeviceId;
        effects.push({ type: "host-changed", deviceId: transfer.targetDeviceId });
      }
    } else {
      applicationRecord.kind = "application-rejected";
      applicationRecord.rejectionReason = "host-rejected";
      deliverApplicationResult(
        state, pending.fromDeviceId, pending.frame.envelope.messageId, pending.logicalOrder,
        "rejected", "host-rejected", now, effects,
      );
      if (transfer) {
        state.pendingHostTransfer = null;
        effects.push({
          type: "host-transfer-expired",
          deviceIds: [transfer.hostDeviceId, transfer.targetDeviceId],
          authorizationId: transfer.authorizationId,
        });
      }
    }
    recordReplay(state, frame.requestId, "application-decision", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "activate") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    const pending = memberById(state, frame.deviceId);
    if (!pending || pending.status !== "pending" || pending.pendingPhase !== "awaiting-proof"
      || pending.admissionId !== frame.admissionId || pending.proofMessageId !== frame.proofMessageId
      || pending.signaturePublicKey !== frame.signaturePublicKey
      || !pending.proofFrame || pending.proofFrame.grant.logicalOrder !== state.nextLogicalOrder) {
      return reject("invalid-admission");
    }
    if (state.nextLogicalOrder >= Number.MAX_SAFE_INTEGER) return reject("order-exhausted");
    if (state.orderQueue.length > 0 && !validateGrantTokenId(state, options.nextGrantTokenId)) {
      return reject("grant-token-required");
    }
    const approvedProof = pending.proofFrame;
    const membershipCommitMessageId = pending.admissionCommitMessageId;
    if (!membershipCommitMessageId) return reject("invalid-state");
    const proofRecord = replayRecord(state, frame.proofMessageId, "join-proof-pending", pending.deviceId);
    if (!proofRecord) return reject("invalid-state");
    proofRecord.kind = "join-proof";
    pending.status = "active";
    pending.membershipCommitMessageId = membershipCommitMessageId;
    clearAdmission(pending);
    state.nextLogicalOrder += 1;
    recordReplay(state, frame.requestId, "activate", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    routeGroupFrame(
      state, pending.deviceId, approvedProof, approvedProof.grant.logicalOrder, now, effects,
    );
    deliverApplicationResult(
      state, pending.deviceId, approvedProof.envelope.messageId, approvedProof.grant.logicalOrder,
      "accepted", null, now, effects,
    );
    effects.push({ type: "member-lifecycle", deviceId: pending.deviceId, status: "active" });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "authorize-host-transfer") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    if (state.pendingHostTransfer || state.pendingZombieRemovals.length !== 0
      || state.members.some((candidate) => candidate.admissionId !== null)) return reject("invalid-lifecycle");
    const target = memberById(state, frame.deviceId);
    const offer = replayRecord(state, frame.offerMessageId, "application", actor.deviceId);
    if (!target || target.status !== "active" || target.deviceId === actor.deviceId) {
      return reject("invalid-lifecycle");
    }
    if (!offer) return reject("invalid-reference");
    if (now > Number.MAX_SAFE_INTEGER - SECURE_HOST_TRANSFER_TTL_MS_V4) return reject("order-exhausted");
    const pendingTransfer: SecurePendingHostTransferStateV4 = {
      authorizationId: frame.requestId,
      hostDeviceId: actor.deviceId,
      targetDeviceId: target.deviceId,
      offerMessageId: frame.offerMessageId,
      authorizedAt: now,
      expiresAt: now + SECURE_HOST_TRANSFER_TTL_MS_V4,
    };
    state.pendingHostTransfer = pendingTransfer;
    recordReplay(state, frame.requestId, "authorize-host-transfer", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    const delivery = appendBacklog(state, target, {
      kind: "host-transfer-authorization",
      receivedAt: now,
      logicalOrder: null,
      fromHostDeviceId: actor.deviceId,
      authorizationId: frame.requestId,
      offerMessageId: frame.offerMessageId,
      expiresAt: pendingTransfer.expiresAt,
    }, effects);
    if (delivery === "overflow") {
      state.pendingHostTransfer = null;
      effects.push({
        type: "host-transfer-expired",
        deviceIds: [actor.deviceId, target.deviceId],
        authorizationId: frame.requestId,
      });
    } else if (delivery === "live") {
      effects.push({
        type: "host-transfer-authorized",
        toDeviceId: target.deviceId,
        fromHostDeviceId: actor.deviceId,
        authorizationId: frame.requestId,
        offerMessageId: frame.offerMessageId,
        expiresAt: pendingTransfer.expiresAt,
      });
    }
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    return { ok: true, state, effects };
  }

  if (frame.kind === "retire-member") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    const target = memberById(state, frame.deviceId);
    if (!target || target.deviceId === actor.deviceId) return reject("invalid-lifecycle");
    const activeBarrier = state.pendingZombieRemovals[0] || null;
    if (activeBarrier && (activeBarrier.deviceId !== target.deviceId
      || activeBarrier.removalCommitMessageId === null
      || frame.commitMessageId !== activeBarrier.removalCommitMessageId)) {
      return reject("invalid-reference");
    }
    const removalCommit = replayRecord(state, frame.commitMessageId, "commit", actor.deviceId);
    if (!removalCommit) return reject("invalid-reference");
    const markerIndex = state.pendingZombieRemovals.findIndex((marker) => marker.deviceId === target.deviceId);
    const marker = state.pendingZombieRemovals[markerIndex];
    if (marker && (markerIndex !== 0 || frame.commitMessageId !== marker.removalCommitMessageId
      || frame.commitMessageId === marker.admissionCommitMessageId
      || removalCommit.acceptedAt < marker.requestedAt)) return reject("invalid-reference");
    if (target.status === "retired") {
      if (!marker) return reject("invalid-lifecycle");
      state.pendingZombieRemovals.splice(markerIndex, 1);
      recordReplay(state, frame.requestId, "retire-member", actor.deviceId, now, {
        frameDigest: controlDigest!,
      });
      effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
      emitZombieRemovalBarrier(state, effects);
      return { ok: true, state, effects };
    }
    const wasGrantOwner = state.currentGrant?.deviceId === target.deviceId;
    const wasPendingSender = state.pendingApplication?.fromDeviceId === target.deviceId;
    const wasPendingCommitSender = state.pendingCommit?.fromDeviceId === target.deviceId;
    const queuedOthers = state.orderQueue.some((entry) => entry.deviceId !== target.deviceId);
    if ((wasGrantOwner || wasPendingSender || wasPendingCommitSender) && queuedOthers
      && !validateGrantTokenId(state, options.nextGrantTokenId)) {
      return reject("grant-token-required");
    }
    if (wasPendingSender) {
      const pending = state.pendingApplication!;
      state.pendingApplication = null;
      const applicationRecord = replayRecord(
        state,
        pending.frame.envelope.messageId,
        "application-pending",
        target.deviceId,
      );
      if (!applicationRecord) return reject("invalid-state");
      applicationRecord.kind = "application-rejected";
      applicationRecord.rejectionReason = "member-retired";
      effects.push({
        type: "application-rejected", deviceId: target.deviceId,
        messageId: pending.frame.envelope.messageId, logicalOrder: pending.logicalOrder,
        reason: "member-retired",
      });
    }
    if (wasPendingCommitSender) {
      const pending = state.pendingCommit!;
      state.pendingCommit = null;
      const commitRecord = replayRecord(
        state, pending.frame.envelope.messageId, "commit-pending", target.deviceId,
      );
      if (!commitRecord) return reject("invalid-state");
      commitRecord.kind = "commit-rejected";
      commitRecord.rejectionReason = "member-retired";
      effects.push({
        type: "commit-rejected",
        deviceId: target.deviceId,
        messageId: pending.frame.envelope.messageId,
        reason: "member-retired",
      });
    }
    const pendingTransfer = state.pendingHostTransfer;
    if (pendingTransfer && (pendingTransfer.hostDeviceId === target.deviceId
      || pendingTransfer.targetDeviceId === target.deviceId)) {
      state.pendingHostTransfer = null;
      effects.push({
        type: "host-transfer-expired",
        deviceIds: [pendingTransfer.hostDeviceId, pendingTransfer.targetDeviceId],
        authorizationId: pendingTransfer.authorizationId,
      });
    }
    removeDeviceFromOrdering(state, target.deviceId);
    retireMember(target);
    if (marker) state.pendingZombieRemovals.splice(markerIndex, 1);
    recordReplay(state, frame.requestId, "retire-member", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "member-lifecycle", deviceId: target.deviceId, status: "retired" });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    emitZombieRemovalBarrier(state, effects);
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "cancel-admission") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    const target = memberById(state, frame.deviceId);
    if (!target || (target.status !== "pending" && target.status !== "disconnected")
      || target.admissionId !== frame.admissionId) return reject("invalid-admission");
    const needsGrant = !state.currentGrant && !state.pendingApplication && !state.pendingCommit
      && state.orderQueue.length > 0;
    if (needsGrant && !validateGrantTokenId(state, options.nextGrantTokenId)) {
      return reject("grant-token-required");
    }
    retirePendingAdmission(state, target, now, effects);
    recordReplay(state, frame.requestId, "cancel-admission", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    const grantError = issueNextGrant(state, now, options.nextGrantTokenId, effects);
    if (grantError) return reject(grantError);
    return { ok: true, state, effects };
  }

  if (frame.kind === "close-room") {
    if (state.hostDeviceId !== actor.deviceId) return reject("host-required");
    if (member.backlog.length !== 0) return reject("delivery-pending");
    if (!replayRecord(state, frame.authorizationMessageId, "application")) {
      return reject("invalid-reference");
    }
    for (const target of state.members) retireMember(target);
    state.lifecycle = "retired";
    state.hostDeviceId = null;
    state.currentGrant = null;
    state.pendingApplication = null;
    state.pendingCommit = null;
    state.pendingHostTransfer = null;
    state.pendingZombieRemovals = [];
    state.orderQueue = [];
    recordReplay(state, frame.requestId, "close-room", actor.deviceId, now, {
      frameDigest: controlDigest!,
    });
    effects.push({ type: "room-retired" });
    effects.push({ type: "frame-accepted", deviceId: actor.deviceId, messageId: frame.requestId });
    return { ok: true, state, effects };
  }

  return reject("invalid-frame");
}

/**
 * Disconnect only the socket whose server-generated connection ID still owns
 * the device.  A delayed close from an older socket cannot evict a resumed one.
 */
export function disconnectSecureRelayDeviceV4(
  stateValue: SecureRelayStateV4,
  actorValue: SecureRelayActorV4,
  options: SecureRelayReduceOptionsV4,
): SecureRelayTransitionV4 {
  const state = cleanClone(stateValue);
  const actor = parseActor(actorValue);
  if (!state) return reject("invalid-state");
  if (!actor || !isSafeTimestamp(options?.now)) return reject("invalid-actor");
  if (state.lifecycle !== "open") return reject("room-retired");
  if (options.now < state.clockHighWater) return reject("clock-regression");
  if (state.revision >= Number.MAX_SAFE_INTEGER) return reject("revision-exhausted");
  state.revision += 1;
  state.clockHighWater = options.now;
  const member = memberById(state, actor.deviceId);
  if (!member) return reject("unknown-device");
  if (member.connectionId !== actor.connectionId) return reject("connection-mismatch");
  if (member.status !== "active" && member.status !== "pending") return reject("invalid-lifecycle");
  const pendingAdmission = member.admissionId !== null;
  if (pendingAdmission) {
    member.status = "disconnected";
    member.connectionId = null;
    member.resumeStatus = null;
    member.resumePhase = null;
    member.resumeRequestId = null;
    member.disconnectExpiresAt = null;
    const effects: SecureRelayEffectV4[] = [{
      type: "member-lifecycle", deviceId: member.deviceId, status: "disconnected",
    }];
    return { ok: true, state, effects };
  }
  const wasGrantOwner = state.currentGrant?.deviceId === member.deviceId;
  const queuedOthers = state.orderQueue.some((entry) => entry.deviceId !== member.deviceId);
  if (wasGrantOwner && queuedOthers && !validateGrantTokenId(state, options.nextGrantTokenId)) {
    return reject("grant-token-required");
  }
  if (options.now > Number.MAX_SAFE_INTEGER - SECURE_ACTIVE_DISCONNECT_GRACE_MS_V4) {
    return reject("order-exhausted");
  }
  member.resumeStatus = "active";
  member.status = "disconnected";
  member.connectionId = null;
  member.resumePhase = null;
  member.resumeRequestId = null;
  member.disconnectExpiresAt = options.now + SECURE_ACTIVE_DISCONNECT_GRACE_MS_V4;
  removeDeviceFromOrdering(state, member.deviceId, "connection-lost");
  const effects: SecureRelayEffectV4[] = [
    { type: "member-lifecycle", deviceId: member.deviceId, status: "disconnected" },
  ];
  const grantError = issueNextGrant(state, options.now, options.nextGrantTokenId, effects);
  if (grantError) return reject(grantError);
  return { ok: true, state, effects };
}

/** Run from an alarm/timer to expire a grant and fairly issue the queue head. */
export function advanceSecureRelayV4(
  stateValue: SecureRelayStateV4,
  options: SecureRelayReduceOptionsV4,
): SecureRelayTransitionV4 {
  const state = cleanClone(stateValue);
  if (!state) return reject("invalid-state");
  if (!isSafeTimestamp(options?.now)) return reject("invalid-actor");
  if (state.lifecycle !== "open") return reject("room-retired");
  if (options.now < state.clockHighWater) return reject("clock-regression");
  if (state.revision >= Number.MAX_SAFE_INTEGER) return reject("revision-exhausted");
  state.revision += 1;
  state.clockHighWater = options.now;
  const effects: SecureRelayEffectV4[] = [];
  expireActiveDisconnects(state, options.now, effects);
  if (state.hostDeviceId === null) return { ok: true, state, effects };
  const currentWillClear = !state.currentGrant || options.now >= state.currentGrant.expiresAt;
  const pendingWillClear = !state.pendingApplication
    || options.now >= state.pendingApplication.decisionExpiresAt;
  const pendingCommitWillClear = !state.pendingCommit
    || options.now >= state.pendingCommit.decisionExpiresAt;
  const willNeedGrant = currentWillClear && pendingWillClear && pendingCommitWillClear
    && state.orderQueue.length > 0;
  if (willNeedGrant && !validateGrantTokenId(state, options.nextGrantTokenId)) {
    return reject("grant-token-required");
  }
  expirePendingAdmission(state, options.now, effects);
  expirePendingHostTransfer(state, options.now, effects);
  expireCurrentGrant(state, options.now, effects);
  expirePendingApplication(state, options.now, effects);
  expirePendingCommit(state, options.now, effects);
  const grantError = issueNextGrant(state, options.now, options.nextGrantTokenId, effects);
  if (grantError) return reject(grantError);
  const host = connectedHost(state);
  if (host) emitHostPendingWork(state, host, effects);
  return { ok: true, state, effects };
}

/** Earliest timer/alarm deadline needed for grant or host-approval expiry. */
export function nextSecureRelayDeadlineV4(stateValue: SecureRelayStateV4): number | null {
  const state = parseSecureRelayStateV4(stateValue);
  if (!state || state.lifecycle !== "open") return null;
  const deadlines = [
    state.currentGrant?.expiresAt,
    state.pendingApplication?.decisionExpiresAt,
    state.pendingCommit?.decisionExpiresAt,
    state.pendingHostTransfer?.expiresAt,
    ...state.members.flatMap((member) => member.admissionExpiresAt === null ? [] : [member.admissionExpiresAt]),
    ...state.members.flatMap((member) => member.disconnectExpiresAt === null ? [] : [member.disconnectExpiresAt]),
  ].filter((deadline): deadline is number => deadline !== undefined);
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}
