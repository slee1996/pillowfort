import {
  canonicalJsonV4,
  isSecureApplicationEventV4,
  isSecureRoomStateSnapshotV4,
  type SecureApplicationEventV4,
  type SecureRpsPickV4,
  type SecureRoomStateSnapshotV4,
} from "../../../src/applicationEventsV4";
import {
  SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4,
} from "../../../src/admissionBundleV4";
import {
  MAX_MLS_RELAY_PAYLOAD_BYTES,
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
} from "../../../src/protocolV4";
import { deriveCryptoRoomInstanceV4 } from "./cryptoStateStore";
import type { SecureLogicalOrderGrantV4 } from "../../../src/secureRelayV4";

const UTF8 = new TextEncoder();
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ROOM_SECRET_RE = /^pf2_([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
const STATE_MAGIC = UTF8.encode("PFRMST01");
const STATE_FORMAT_VERSION = 1;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const HEADER_BYTES = 8 + 2 + 2 + 2 + SECURE_ROOM_ID_BYTES + SALT_BYTES + NONCE_BYTES + 4;
const WRAP_DOMAIN = UTF8.encode("pillowfort:secure-room-state:v1\0");
const CREDENTIAL_STORE_KEY_DOMAIN = UTF8.encode("pillowfort:secure-room-credential-state-key:v1\0");
const OPAQUE_STATE_KEY_PREFIX = "pfri1_";
const MAX_PERSISTED_BYTES = 8 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES = MAX_PERSISTED_BYTES - HEADER_BYTES - GCM_TAG_BYTES;
const MAX_PENDING_OUTBOX_ENTRIES = 32;
const MAX_PENDING_OUTBOX_BYTES = 512 * 1024;
const MAX_OUTBOX_ARTIFACT_BYTES = 64 * 1024;
const MAX_PENDING_COMMIT_SECRETS = 8;
const MAX_PENDING_RELAY_CONTROLS = 16;
const MAX_PROCESSED_DELIVERIES = 256;
const MAX_MLS_SNAPSHOT_BYTES = 6 * 1024 * 1024;
const MAX_U64 = (1n << 64n) - 1n;

export const SECURE_ROOM_STATE_FORMAT_VERSION = STATE_FORMAT_VERSION;
export const MAX_SECURE_ROOM_PENDING_OUTBOX_ENTRIES = MAX_PENDING_OUTBOX_ENTRIES;
export const MAX_SECURE_ROOM_PENDING_OUTBOX_BYTES = MAX_PENDING_OUTBOX_BYTES;
export const MAX_SECURE_ROOM_PENDING_RELAY_CONTROLS = MAX_PENDING_RELAY_CONTROLS;
export const MAX_SECURE_ROOM_PROCESSED_DELIVERIES = MAX_PROCESSED_DELIVERIES;

export type SecureRoomStateErrorCode =
  | "invalid-input"
  | "unavailable"
  | "state-invalid";

export class SecureRoomStateError extends Error {
  readonly code: SecureRoomStateErrorCode;
  readonly cause?: unknown;

  constructor(code: SecureRoomStateErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "SecureRoomStateError";
    this.code = code;
    this.cause = cause;
  }
}

export interface SecureRoomDurableStateV1 {
  roomInstance: string;
  deviceId: string;
  mlsSnapshot: Uint8Array;
  applicationState: SecureRoomStateSnapshotV4;
  nextDeviceSequence: number;
  lastEpoch: string;
  pendingOutbox: SecureRoomPendingOutboxEntryV1[];
  pendingRelayControls: SecureRoomPendingRelayControlV1[];
  processedDeliveries: SecureRoomProcessedDeliveryV1[];
  pendingCommitSecrets: Record<string, SecureRoomPendingCommitSecretV4>;
  pendingApplicationRollback: SecureRoomPendingApplicationRollbackV1 | null;
  pendingCommitRollback: SecureRoomPendingCommitRollbackV1 | null;
}

export interface SecureRoomProcessedDeliveryV1 {
  messageId: string;
  digest: string;
}

export type SecureRoomApplicationRelayContextV1 =
  | { kind: "application" }
  | { kind: "bootstrap"; admissionId: string; welcomeMessageId: string }
  | { kind: "join-proof"; admissionId: string; welcomeMessageId: string }
  | { kind: "host-transfer-accept"; authorizationId: string };

export type SecureRoomPendingOutboxEntryV1 =
  | {
      kind: "commit";
      messageId: string;
      outbound: Uint8Array;
      grant: SecureLogicalOrderGrantV4;
    }
  | {
      kind: "application";
      messageId: string;
      outbound: Uint8Array;
      /** Retained under AEAD so a restarted UI can correlate the tentative state. */
      event: SecureApplicationEventV4;
      grant: SecureLogicalOrderGrantV4;
      /** Exact opaque relay variant and binding data required for byte-stable crash retry. */
      relayContext: SecureRoomApplicationRelayContextV1;
    }
  | {
      kind: "admission";
      admissionId: string;
      messageId: string;
      outbound: Uint8Array;
      /** Null for a setup/join key package; populated for a host add. */
      welcomeMessageId: string | null;
      welcome: Uint8Array | null;
      ratchetTree: Uint8Array | null;
      addedDeviceId: string | null;
      bootstrapMessageId: string | null;
      /** Joiner-only durable binding to the exact Welcome consumed before bootstrap/proof. */
      joinWelcomeMessageId: string | null;
      /** Null only for a setup/join key package. */
      grant: SecureLogicalOrderGrantV4 | null;
      /** A host add advances to the Welcome send only after its commit ack. */
      commitAcknowledged: boolean;
      /** Retained until completeAdmission() after bootstrap acceptance. */
      welcomeAcknowledged: boolean;
    };

export type SecureRoomPendingRelayControlV1 =
  | {
      /** Durable E2EE barrier from MLS Add through relay activation/retirement. */
      kind: "admission-barrier";
      admissionId: string;
      deviceId: string;
    }
  | {
      kind: "retire-member";
      requestId: string;
      deviceId: string;
      commitMessageId: string;
      /** Exact MLS Add/founder-setup binding for relay-expiry removals; null for signed application removals. */
      retirementAdmissionCommitMessageId: string | null;
    }
  | {
      kind: "close-room";
      requestId: string;
      authorizationMessageId: string;
    }
  | {
      kind: "transfer-host";
      /** Host authorization request id, persisted by the relay as the capability id. */
      authorizationId: string | null;
      targetDeviceId: string;
      offerMessageId: string;
      acceptMessageId: string | null;
    };

export type SecureRoomPendingCommitSecretV4 =
  | { kind: "rps"; gameId: string; pick: SecureRpsPickV4; nonce: string; commitment: string }
  | { kind: "saboteur"; gameId: string; nonce: string; commitment: string };

export interface SecureRoomPendingApplicationRollbackV1 {
  messageId: string;
  applicationState: SecureRoomStateSnapshotV4;
  nextDeviceSequence: number;
  lastEpoch: string;
  pendingOutbox: SecureRoomPendingOutboxEntryV1[];
  pendingRelayControls: SecureRoomPendingRelayControlV1[];
  processedDeliveries: SecureRoomProcessedDeliveryV1[];
  pendingCommitSecrets: Record<string, SecureRoomPendingCommitSecretV4>;
  deleteCommitSecretOnAccept: string | null;
}

export interface SecureRoomPendingCommitRollbackV1 {
  messageId: string;
  applicationState: SecureRoomStateSnapshotV4;
  nextDeviceSequence: number;
  lastEpoch: string;
  pendingOutbox: SecureRoomPendingOutboxEntryV1[];
  pendingRelayControls: SecureRoomPendingRelayControlV1[];
  processedDeliveries: SecureRoomProcessedDeliveryV1[];
  pendingCommitSecrets: Record<string, SecureRoomPendingCommitSecretV4>;
}

interface SerializedSecureRoomStateV1 {
  v: 1;
  protocol: 4;
  suite: 1;
  roomInstance: string;
  deviceId: string;
  mlsSnapshot: string;
  applicationState: SecureRoomStateSnapshotV4;
  nextDeviceSequence: number;
  lastEpoch: string;
  pendingOutbox: SerializedPendingOutboxEntryV1[];
  pendingRelayControls: SecureRoomPendingRelayControlV1[];
  processedDeliveries: SecureRoomProcessedDeliveryV1[];
  pendingCommitSecrets: Record<string, SecureRoomPendingCommitSecretV4>;
  pendingApplicationRollback: SerializedPendingApplicationRollbackV1 | null;
  pendingCommitRollback: SerializedPendingCommitRollbackV1 | null;
}

type SerializedPendingOutboxEntryV1 =
  | {
      kind: "commit";
      messageId: string;
      outbound: string;
      grant: SecureLogicalOrderGrantV4;
    }
  | {
      kind: "application";
      messageId: string;
      outbound: string;
      event: SecureApplicationEventV4;
      grant: SecureLogicalOrderGrantV4;
      relayContext: SecureRoomApplicationRelayContextV1;
    }
  | {
      kind: "admission";
      admissionId: string;
      messageId: string;
      outbound: string;
      welcomeMessageId: string | null;
      welcome: string | null;
      ratchetTree: string | null;
      addedDeviceId: string | null;
      bootstrapMessageId: string | null;
      joinWelcomeMessageId: string | null;
      grant: SecureLogicalOrderGrantV4 | null;
      commitAcknowledged: boolean;
      welcomeAcknowledged: boolean;
    };

interface SerializedPendingApplicationRollbackV1 {
  messageId: string;
  applicationState: SecureRoomStateSnapshotV4;
  nextDeviceSequence: number;
  lastEpoch: string;
  pendingOutbox: SerializedPendingOutboxEntryV1[];
  pendingRelayControls: SecureRoomPendingRelayControlV1[];
  processedDeliveries: SecureRoomProcessedDeliveryV1[];
  pendingCommitSecrets: Record<string, SecureRoomPendingCommitSecretV4>;
  deleteCommitSecretOnAccept: string | null;
}

interface SerializedPendingCommitRollbackV1 {
  messageId: string;
  applicationState: SecureRoomStateSnapshotV4;
  nextDeviceSequence: number;
  lastEpoch: string;
  pendingOutbox: SerializedPendingOutboxEntryV1[];
  pendingRelayControls: SecureRoomPendingRelayControlV1[];
  processedDeliveries: SecureRoomProcessedDeliveryV1[];
  pendingCommitSecrets: Record<string, SecureRoomPendingCommitSecretV4>;
}

function browserCrypto(): Crypto {
  const provider = globalThis.crypto;
  if (!provider?.subtle || typeof provider.getRandomValues !== "function") {
    throw new SecureRoomStateError("unavailable", "WebCrypto is required for secure room persistence");
  }
  return provider;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function encodeU16(value: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
}

function encodeU32(value: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).every((key) => typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key));
  } catch {
    return false;
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function decodeCanonicalBase64UrlV4(
  value: unknown,
  expectedBytes?: number,
  maximumBytes = MAX_MLS_SNAPSHOT_BYTES,
): Uint8Array | null {
  const decodedLength = canonicalBase64UrlByteLength(value);
  if (
    typeof value !== "string" || decodedLength === null || decodedLength > maximumBytes ||
    (expectedBytes !== undefined && decodedLength !== expectedBytes)
  ) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    if (binary.length !== decodedLength) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function randomSecureRoomIdV4(byteLength: 16 | 32 = 16): string {
  const bytes = browserCrypto().getRandomValues(new Uint8Array(byteLength));
  try {
    return encodeBase64Url(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function secureRoomOpaqueStoreKey(roomInstance: string): Promise<string> {
  if (canonicalBase64UrlByteLength(roomInstance) !== SECURE_ROOM_ID_BYTES) {
    throw new SecureRoomStateError("invalid-input", "invalid protocol-v4 room instance");
  }
  return deriveCryptoRoomInstanceV4(roomInstance);
}

/**
 * Separates durable identities created with different credentials for the
 * same public room instance. The room-scoped Web Lock intentionally continues
 * to use secureRoomOpaqueStoreKey(); only the opaque IndexedDB record uses
 * this credential-scoped digest. Consequently an abandoned wrong-password
 * join cannot shadow an established identity or block a later correct retry.
 */
export async function secureRoomCredentialStoreKey(
  roomInstance: string,
  roomSecret: string,
): Promise<string> {
  const roomBinding = decodeCanonicalBase64UrlV4(roomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES);
  if (!roomBinding) throw new SecureRoomStateError("invalid-input", "invalid protocol-v4 room instance");
  const secret = decodeRoomSecret(roomSecret);
  let material: Uint8Array<ArrayBuffer> | null = null;
  let digest: Uint8Array<ArrayBuffer> | null = null;
  try {
    material = concatBytes(CREDENTIAL_STORE_KEY_DOMAIN, roomBinding, secret);
    digest = new Uint8Array(await browserCrypto().subtle.digest("SHA-256", material));
    return `${OPAQUE_STATE_KEY_PREFIX}${encodeBase64Url(digest)}`;
  } catch (error) {
    if (error instanceof SecureRoomStateError) throw error;
    throw new SecureRoomStateError("unavailable", "credential-scoped state derivation failed", error);
  } finally {
    material?.fill(0);
    digest?.fill(0);
    secret.fill(0);
    roomBinding.fill(0);
  }
}

function decodeRoomSecret(roomSecret: unknown): Uint8Array {
  if (typeof roomSecret !== "string") {
    throw new SecureRoomStateError("invalid-input", "room secret must be a string");
  }
  const match = ROOM_SECRET_RE.exec(roomSecret);
  const decoded = match ? decodeCanonicalBase64UrlV4(match[1], 32, 32) : null;
  if (!decoded) {
    throw new SecureRoomStateError("invalid-input", "room secret is not a canonical 32-byte Pillowfort secret");
  }
  return decoded;
}

function validEpoch(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/u.test(value)) return false;
  try {
    return BigInt(value) <= MAX_U64;
  } catch {
    return false;
  }
}

function strictArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.every((key) =>
    typeof key === "string" && (key === "length" || /^(0|[1-9]\d*)$/u.test(key))
  );
}

function validOutboxArtifact(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength >= 1 && value.byteLength <= MAX_OUTBOX_ARTIFACT_BYTES;
}

function cloneGrant(grant: SecureLogicalOrderGrantV4): SecureLogicalOrderGrantV4 {
  return { ...grant };
}

function validGrant(
  value: unknown,
  roomInstance: string,
  deviceId: string,
): value is SecureLogicalOrderGrantV4 {
  return plainRecord(value) && exactKeys(value, [
    "v", "suite", "roomInstance", "requestId", "tokenId", "deviceId", "logicalOrder", "expiresAt",
  ]) && value.v === SECURE_ROOM_PROTOCOL_VERSION && value.suite === SECURE_ROOM_MLS_CIPHERSUITE &&
    value.roomInstance === roomInstance && value.deviceId === deviceId &&
    canonicalBase64UrlByteLength(value.requestId) === SECURE_MESSAGE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.tokenId) === SECURE_MESSAGE_ID_BYTES &&
    value.requestId !== value.tokenId &&
    Number.isSafeInteger(value.logicalOrder) && (value.logicalOrder as number) >= 1 &&
    Number.isSafeInteger(value.expiresAt) && (value.expiresAt as number) >= 0;
}

function validatePendingOutbox(
  value: unknown,
  roomInstance: string,
  deviceId: string,
): asserts value is SecureRoomPendingOutboxEntryV1[] {
  if (!strictArray(value) || value.length > MAX_PENDING_OUTBOX_ENTRIES) {
    throw new SecureRoomStateError("state-invalid", "pending outbox has an invalid shape or entry count");
  }
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const candidate of value) {
    if (!plainRecord(candidate) || canonicalBase64UrlByteLength(candidate.messageId) !== SECURE_MESSAGE_ID_BYTES) {
      throw new SecureRoomStateError("state-invalid", "pending outbox entry is malformed");
    }
    const messageId = candidate.messageId as string;
    if (ids.has(messageId)) throw new SecureRoomStateError("state-invalid", "pending outbox contains duplicate message ids");
    ids.add(messageId);
    if (!validOutboxArtifact(candidate.outbound)) {
      throw new SecureRoomStateError("state-invalid", "pending outbox artifact is malformed");
    }
    totalBytes += candidate.outbound.byteLength;

    if (candidate.kind === "commit") {
      if (!exactKeys(candidate, ["kind", "messageId", "outbound", "grant"]) ||
        !validGrant(candidate.grant, roomInstance, deviceId)) {
        throw new SecureRoomStateError("state-invalid", "pending commit outbox entry is malformed");
      }
      if (ids.has(candidate.grant.requestId) || ids.has(candidate.grant.tokenId)) {
        throw new SecureRoomStateError("state-invalid", "pending commit grant reuses a relay id");
      }
      ids.add(candidate.grant.requestId);
      ids.add(candidate.grant.tokenId);
      continue;
    }
    if (candidate.kind === "application") {
      if (
        !exactKeys(candidate, ["kind", "messageId", "outbound", "event", "grant", "relayContext"]) ||
        !isSecureApplicationEventV4(candidate.event) || candidate.event.roomInstance !== roomInstance ||
        !validGrant(candidate.grant, roomInstance, deviceId) ||
        candidate.grant.logicalOrder !== candidate.event.logicalOrder ||
        !validApplicationRelayContext(candidate.relayContext, candidate.event)
      ) throw new SecureRoomStateError("state-invalid", "pending application outbox entry is malformed");
      const relayContext = candidate.relayContext as SecureRoomApplicationRelayContextV1;
      const retainedJoinAuth = relayContext.kind === "join-proof" &&
        candidate.grant.requestId === relayContext.admissionId &&
        value.some((entry) => plainRecord(entry) && entry.kind === "admission" &&
          entry.admissionId === relayContext.admissionId && entry.messageId === entry.admissionId &&
          entry.welcomeMessageId === null && entry.commitAcknowledged === true &&
          entry.joinWelcomeMessageId === relayContext.welcomeMessageId);
      if ((ids.has(candidate.grant.requestId) && !retainedJoinAuth) || ids.has(candidate.grant.tokenId)) {
        throw new SecureRoomStateError("state-invalid", "pending application grant reuses a relay id");
      }
      if (!retainedJoinAuth) ids.add(candidate.grant.requestId);
      ids.add(candidate.grant.tokenId);
      continue;
    }
    if (candidate.kind !== "admission" || !exactKeys(candidate, [
      "kind", "admissionId", "messageId", "outbound", "welcomeMessageId", "welcome", "ratchetTree",
      "addedDeviceId", "bootstrapMessageId", "joinWelcomeMessageId", "grant", "commitAcknowledged", "welcomeAcknowledged",
    ]) || canonicalBase64UrlByteLength(candidate.admissionId) !== SECURE_MESSAGE_ID_BYTES ||
      !(candidate.bootstrapMessageId === null ||
        canonicalBase64UrlByteLength(candidate.bootstrapMessageId) === SECURE_MESSAGE_ID_BYTES) ||
      !(candidate.joinWelcomeMessageId === null ||
        canonicalBase64UrlByteLength(candidate.joinWelcomeMessageId) === SECURE_MESSAGE_ID_BYTES) ||
      typeof candidate.commitAcknowledged !== "boolean" || typeof candidate.welcomeAcknowledged !== "boolean") {
      throw new SecureRoomStateError("state-invalid", "pending admission outbox entry is malformed");
    }
    const isKeyPackage = candidate.welcomeMessageId === null && candidate.welcome === null &&
      candidate.ratchetTree === null && candidate.addedDeviceId === null;
    const isAdd = canonicalBase64UrlByteLength(candidate.welcomeMessageId) === SECURE_MESSAGE_ID_BYTES &&
      validOutboxArtifact(candidate.welcome) && validOutboxArtifact(candidate.ratchetTree) &&
      canonicalBase64UrlByteLength(candidate.addedDeviceId) === SECURE_DEVICE_ID_BYTES;
    if (
      (!isKeyPackage && !isAdd) ||
      (isKeyPackage && (candidate.admissionId !== messageId || candidate.bootstrapMessageId !== null || candidate.grant !== null ||
        candidate.welcomeAcknowledged || (candidate.joinWelcomeMessageId !== null &&
          (!candidate.commitAcknowledged || candidate.joinWelcomeMessageId === messageId)))) ||
      (isAdd && (!validGrant(candidate.grant, roomInstance, deviceId) ||
        candidate.joinWelcomeMessageId !== null ||
        candidate.admissionId === messageId || candidate.admissionId === candidate.welcomeMessageId ||
        candidate.bootstrapMessageId === messageId || candidate.bootstrapMessageId === candidate.welcomeMessageId ||
        candidate.bootstrapMessageId === candidate.admissionId ||
        candidate.grant.requestId === messageId || candidate.grant.tokenId === messageId ||
        candidate.grant.requestId === candidate.admissionId || candidate.grant.tokenId === candidate.admissionId ||
        candidate.grant.requestId === candidate.welcomeMessageId ||
        candidate.grant.tokenId === candidate.welcomeMessageId ||
        candidate.grant.requestId === candidate.bootstrapMessageId ||
        candidate.grant.tokenId === candidate.bootstrapMessageId ||
        (candidate.welcomeAcknowledged && !candidate.commitAcknowledged)))
    ) {
      throw new SecureRoomStateError("state-invalid", "pending admission artifacts are inconsistent");
    }
    if (isAdd && SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4 +
      (candidate.welcome as Uint8Array).byteLength + (candidate.ratchetTree as Uint8Array).byteLength >
      MAX_MLS_RELAY_PAYLOAD_BYTES) {
      throw new SecureRoomStateError("state-invalid", "pending admission bundle exceeds the relay payload limit");
    }
    if (candidate.admissionId !== messageId) {
      const admissionId = candidate.admissionId as string;
      if (ids.has(admissionId)) throw new SecureRoomStateError("state-invalid", "pending outbox contains duplicate relay ids");
      ids.add(admissionId);
    }
    if (isAdd) {
      const grant = candidate.grant as SecureLogicalOrderGrantV4;
      if (ids.has(grant.requestId) || ids.has(grant.tokenId)) {
        throw new SecureRoomStateError("state-invalid", "pending admission grant reuses a relay id");
      }
      ids.add(grant.requestId);
      ids.add(grant.tokenId);
      const welcomeMessageId = candidate.welcomeMessageId as string;
      if (ids.has(welcomeMessageId)) {
        throw new SecureRoomStateError("state-invalid", "pending outbox contains duplicate message ids");
      }
      ids.add(welcomeMessageId);
      totalBytes += (candidate.welcome as Uint8Array).byteLength + (candidate.ratchetTree as Uint8Array).byteLength;
    }
  }
  if (totalBytes > MAX_PENDING_OUTBOX_BYTES) {
    throw new SecureRoomStateError("state-invalid", "pending outbox exceeds its byte limit");
  }
}

function validApplicationRelayContext(
  value: unknown,
  event: SecureApplicationEventV4,
): value is SecureRoomApplicationRelayContextV1 {
  if (!plainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "application") {
    return exactKeys(value, ["kind"]) && !(event.content.type === "host-transfer" &&
      event.content.action === "accept");
  }
  if (value.kind === "host-transfer-accept") {
    return exactKeys(value, ["kind", "authorizationId"]) &&
      canonicalBase64UrlByteLength(value.authorizationId) === SECURE_MESSAGE_ID_BYTES &&
      event.content.type === "host-transfer" && event.content.action === "accept" &&
      event.content.authorizationId === value.authorizationId;
  }
  if (value.kind === "bootstrap" || value.kind === "join-proof") {
    return exactKeys(value, ["kind", "admissionId", "welcomeMessageId"]) &&
      canonicalBase64UrlByteLength(value.admissionId) === SECURE_MESSAGE_ID_BYTES &&
      canonicalBase64UrlByteLength(value.welcomeMessageId) === SECURE_MESSAGE_ID_BYTES &&
      value.admissionId !== value.welcomeMessageId &&
      (value.kind === "bootstrap"
        ? event.content.type === "state-snapshot"
        : event.content.type === "member-profile");
  }
  return false;
}

function commitSecretMatchesState(
  secret: SecureRoomPendingCommitSecretV4,
  state: SecureRoomStateSnapshotV4,
): boolean {
  if (secret.kind === "rps") {
    return state.rps?.gameId === secret.gameId &&
      (state.rps.phase === "committing" || state.rps.phase === "revealing");
  }
  return state.saboteur?.gameId === secret.gameId &&
    (state.saboteur.phase === "committing" || state.saboteur.phase === "revealing");
}

function validatePendingCommitSecrets(
  value: unknown,
  state: SecureRoomStateSnapshotV4,
  fallbackState?: SecureRoomStateSnapshotV4,
): asserts value is Record<string, SecureRoomPendingCommitSecretV4> {
  if (!plainRecord(value)) throw new SecureRoomStateError("state-invalid", "pending commit secret map is invalid");
  const gameIds = Object.keys(value);
  if (gameIds.length > MAX_PENDING_COMMIT_SECRETS) {
    throw new SecureRoomStateError("state-invalid", "pending commit secret map exceeds its limit");
  }
  for (const gameId of gameIds) {
    const secret = value[gameId];
    if (
      canonicalBase64UrlByteLength(gameId) !== SECURE_MESSAGE_ID_BYTES || !plainRecord(secret) ||
      secret.gameId !== gameId || canonicalBase64UrlByteLength(secret.nonce) !== 32 ||
      canonicalBase64UrlByteLength(secret.commitment) !== 32
    ) throw new SecureRoomStateError("state-invalid", "pending commit secret is malformed");
    if (secret.kind === "rps") {
      if (!exactKeys(secret, ["kind", "gameId", "pick", "nonce", "commitment"]) ||
          (secret.pick !== "rock" && secret.pick !== "paper" && secret.pick !== "scissors")) {
        throw new SecureRoomStateError("state-invalid", "pending RPS secret is malformed");
      }
    } else if (secret.kind === "saboteur") {
      if (!exactKeys(secret, ["kind", "gameId", "nonce", "commitment"])) {
        throw new SecureRoomStateError("state-invalid", "pending Saboteur secret is malformed");
      }
    } else {
      throw new SecureRoomStateError("state-invalid", "pending commit secret kind is unsupported");
    }
    const typedSecret = secret as unknown as SecureRoomPendingCommitSecretV4;
    if (
      !commitSecretMatchesState(typedSecret, state) &&
      (!fallbackState || !commitSecretMatchesState(typedSecret, fallbackState))
    ) {
      throw new SecureRoomStateError("state-invalid", "pending commit secret is not tied to an active game");
    }
  }
}

function clonePendingCommitSecrets(
  value: Record<string, SecureRoomPendingCommitSecretV4>,
): Record<string, SecureRoomPendingCommitSecretV4> {
  const clone: Record<string, SecureRoomPendingCommitSecretV4> = {};
  for (const [gameId, secret] of Object.entries(value)) clone[gameId] = { ...secret };
  return clone;
}

export function cloneSecureRoomPendingOutboxV1(
  value: readonly SecureRoomPendingOutboxEntryV1[],
): SecureRoomPendingOutboxEntryV1[] {
  return value.map((entry) => {
    if (entry.kind === "commit") {
      return {
        kind: "commit",
        messageId: entry.messageId,
        outbound: entry.outbound.slice(),
        grant: cloneGrant(entry.grant),
      };
    }
    if (entry.kind === "application") {
      return {
        kind: "application",
        messageId: entry.messageId,
        outbound: entry.outbound.slice(),
        event: JSON.parse(canonicalJsonV4(entry.event)) as SecureApplicationEventV4,
        grant: cloneGrant(entry.grant),
        relayContext: JSON.parse(canonicalJsonV4(entry.relayContext)) as SecureRoomApplicationRelayContextV1,
      };
    }
    return {
      kind: "admission",
      admissionId: entry.admissionId,
      messageId: entry.messageId,
      outbound: entry.outbound.slice(),
      welcomeMessageId: entry.welcomeMessageId,
      welcome: entry.welcome?.slice() ?? null,
      ratchetTree: entry.ratchetTree?.slice() ?? null,
      addedDeviceId: entry.addedDeviceId,
      bootstrapMessageId: entry.bootstrapMessageId,
      joinWelcomeMessageId: entry.joinWelcomeMessageId,
      grant: entry.grant === null ? null : cloneGrant(entry.grant),
      commitAcknowledged: entry.commitAcknowledged,
      welcomeAcknowledged: entry.welcomeAcknowledged,
    };
  });
}

function serializePendingOutbox(
  value: readonly SecureRoomPendingOutboxEntryV1[],
): SerializedPendingOutboxEntryV1[] {
  return value.map((entry) => {
    if (entry.kind === "commit") {
      return {
        kind: "commit",
        messageId: entry.messageId,
        outbound: encodeBase64Url(entry.outbound),
        grant: cloneGrant(entry.grant),
      };
    }
    if (entry.kind === "application") {
      return {
        kind: "application",
        messageId: entry.messageId,
        outbound: encodeBase64Url(entry.outbound),
        event: JSON.parse(canonicalJsonV4(entry.event)) as SecureApplicationEventV4,
        grant: cloneGrant(entry.grant),
        relayContext: JSON.parse(canonicalJsonV4(entry.relayContext)) as SecureRoomApplicationRelayContextV1,
      };
    }
    return {
      kind: "admission",
      admissionId: entry.admissionId,
      messageId: entry.messageId,
      outbound: encodeBase64Url(entry.outbound),
      welcomeMessageId: entry.welcomeMessageId,
      welcome: entry.welcome === null ? null : encodeBase64Url(entry.welcome),
      ratchetTree: entry.ratchetTree === null ? null : encodeBase64Url(entry.ratchetTree),
      addedDeviceId: entry.addedDeviceId,
      bootstrapMessageId: entry.bootstrapMessageId,
      joinWelcomeMessageId: entry.joinWelcomeMessageId,
      grant: entry.grant === null ? null : cloneGrant(entry.grant),
      commitAcknowledged: entry.commitAcknowledged,
      welcomeAcknowledged: entry.welcomeAcknowledged,
    };
  });
}

function parseSerializedPendingOutbox(
  value: unknown,
  roomInstance: string,
  deviceId: string,
): SecureRoomPendingOutboxEntryV1[] {
  if (!strictArray(value)) throw new SecureRoomStateError("state-invalid", "serialized pending outbox is invalid");
  const parsed: SecureRoomPendingOutboxEntryV1[] = [];
  for (const candidate of value) {
    if (!plainRecord(candidate) || typeof candidate.messageId !== "string" || typeof candidate.outbound !== "string") {
      throw new SecureRoomStateError("state-invalid", "serialized pending outbox entry is malformed");
    }
    const outbound = decodeCanonicalBase64UrlV4(candidate.outbound, undefined, MAX_OUTBOX_ARTIFACT_BYTES);
    if (!outbound || outbound.byteLength < 1) {
      throw new SecureRoomStateError("state-invalid", "serialized pending outbox artifact is malformed");
    }
    if (candidate.kind === "commit") {
      if (!exactKeys(candidate, ["kind", "messageId", "outbound", "grant"]) || !plainRecord(candidate.grant)) {
        throw new SecureRoomStateError("state-invalid", "serialized commit outbox entry is malformed");
      }
      parsed.push({
        kind: "commit",
        messageId: candidate.messageId,
        outbound,
        grant: candidate.grant as unknown as SecureLogicalOrderGrantV4,
      });
      continue;
    }
    if (candidate.kind === "application") {
      if (!exactKeys(candidate, ["kind", "messageId", "outbound", "event", "grant", "relayContext"]) ||
          !plainRecord(candidate.grant) || !plainRecord(candidate.relayContext)) {
        throw new SecureRoomStateError("state-invalid", "serialized application outbox entry is malformed");
      }
      parsed.push({
        kind: "application",
        messageId: candidate.messageId,
        outbound,
        event: candidate.event as SecureApplicationEventV4,
        grant: candidate.grant as unknown as SecureLogicalOrderGrantV4,
        relayContext: candidate.relayContext as unknown as SecureRoomApplicationRelayContextV1,
      });
      continue;
    }
    if (candidate.kind !== "admission" || !exactKeys(candidate, [
      "kind", "admissionId", "messageId", "outbound", "welcomeMessageId", "welcome", "ratchetTree",
      "addedDeviceId", "bootstrapMessageId", "joinWelcomeMessageId", "grant", "commitAcknowledged", "welcomeAcknowledged",
    ]) || typeof candidate.admissionId !== "string" || typeof candidate.commitAcknowledged !== "boolean" ||
      typeof candidate.welcomeAcknowledged !== "boolean" ||
      !(candidate.welcomeMessageId === null || typeof candidate.welcomeMessageId === "string") ||
      !(candidate.welcome === null || typeof candidate.welcome === "string") ||
      !(candidate.ratchetTree === null || typeof candidate.ratchetTree === "string") ||
      !(candidate.addedDeviceId === null || typeof candidate.addedDeviceId === "string") ||
      !(candidate.bootstrapMessageId === null || typeof candidate.bootstrapMessageId === "string") ||
      !(candidate.joinWelcomeMessageId === null || typeof candidate.joinWelcomeMessageId === "string") ||
      !(candidate.grant === null || plainRecord(candidate.grant))) {
      throw new SecureRoomStateError("state-invalid", "serialized admission outbox entry is malformed");
    }
    const welcome = candidate.welcome === null
      ? null
      : decodeCanonicalBase64UrlV4(candidate.welcome, undefined, MAX_OUTBOX_ARTIFACT_BYTES);
    const ratchetTree = candidate.ratchetTree === null
      ? null
      : decodeCanonicalBase64UrlV4(candidate.ratchetTree, undefined, MAX_OUTBOX_ARTIFACT_BYTES);
    if ((candidate.welcome !== null && (!welcome || welcome.byteLength < 1)) ||
        (candidate.ratchetTree !== null && (!ratchetTree || ratchetTree.byteLength < 1))) {
      throw new SecureRoomStateError("state-invalid", "serialized admission artifacts are malformed");
    }
    parsed.push({
      kind: "admission",
      admissionId: candidate.admissionId,
      messageId: candidate.messageId,
      outbound,
      welcomeMessageId: candidate.welcomeMessageId,
      welcome,
      ratchetTree,
      addedDeviceId: candidate.addedDeviceId,
      bootstrapMessageId: candidate.bootstrapMessageId,
      joinWelcomeMessageId: candidate.joinWelcomeMessageId,
      grant: candidate.grant as SecureLogicalOrderGrantV4 | null,
      commitAcknowledged: candidate.commitAcknowledged,
      welcomeAcknowledged: candidate.welcomeAcknowledged,
    });
  }
  validatePendingOutbox(parsed, roomInstance, deviceId);
  return parsed;
}

function pendingOutboxEqual(
  left: readonly SecureRoomPendingOutboxEntryV1[],
  right: readonly SecureRoomPendingOutboxEntryV1[],
): boolean {
  return canonicalJsonV4(serializePendingOutbox(left)) === canonicalJsonV4(serializePendingOutbox(right));
}

function pendingOutboxMatchesRollback(
  currentPrefix: readonly SecureRoomPendingOutboxEntryV1[],
  rollback: readonly SecureRoomPendingOutboxEntryV1[],
  applicationMessageId: string,
): boolean {
  if (pendingOutboxEqual(currentPrefix, rollback)) return true;
  const normalized = cloneSecureRoomPendingOutboxV1(currentPrefix);
  let associations = 0;
  for (const entry of normalized) {
    if (entry.kind === "admission" && entry.bootstrapMessageId === applicationMessageId) {
      entry.bootstrapMessageId = null;
      associations += 1;
    }
  }
  return associations === 1 && pendingOutboxEqual(normalized, rollback);
}

export function cloneSecureRoomPendingRelayControlsV1(
  value: readonly SecureRoomPendingRelayControlV1[],
): SecureRoomPendingRelayControlV1[] {
  return value.map((control) => ({ ...control }));
}

function relayControlMatchesState(
  control: SecureRoomPendingRelayControlV1,
  state: SecureRoomStateSnapshotV4,
): boolean {
  if (control.kind === "close-room") return state.closedReason !== null;
  if (control.kind === "transfer-host") {
    return control.acceptMessageId === null
      ? state.pendingHostDeviceId === control.targetDeviceId || state.hostDeviceId === control.targetDeviceId
      : state.hostDeviceId === control.targetDeviceId;
  }
  return true;
}

function validatePendingRelayControls(
  value: unknown,
  state: SecureRoomStateSnapshotV4,
  fallbackState?: SecureRoomStateSnapshotV4,
): asserts value is SecureRoomPendingRelayControlV1[] {
  if (!strictArray(value) || value.length > MAX_PENDING_RELAY_CONTROLS) {
    throw new SecureRoomStateError("state-invalid", "pending relay-control ledger is invalid or saturated");
  }
  const requestIds = new Set<string>();
  const retireDevices = new Set<string>();
  let closeCount = 0;
  let transferCount = 0;
  let admissionCount = 0;
  for (const candidate of value) {
    if (!plainRecord(candidate)) throw new SecureRoomStateError("state-invalid", "pending relay control is malformed");
    let typed: SecureRoomPendingRelayControlV1;
    if (candidate.kind === "admission-barrier") {
      admissionCount += 1;
      if (admissionCount > 1 || !exactKeys(candidate, ["kind", "admissionId", "deviceId"]) ||
          canonicalBase64UrlByteLength(candidate.admissionId) !== SECURE_MESSAGE_ID_BYTES ||
          canonicalBase64UrlByteLength(candidate.deviceId) !== SECURE_DEVICE_ID_BYTES) {
        throw new SecureRoomStateError("state-invalid", "pending admission barrier is malformed");
      }
      typed = candidate as unknown as SecureRoomPendingRelayControlV1;
    } else if (candidate.kind === "retire-member") {
      if (!exactKeys(candidate, [
        "kind", "requestId", "deviceId", "commitMessageId", "retirementAdmissionCommitMessageId",
      ]) ||
        canonicalBase64UrlByteLength(candidate.requestId) !== SECURE_MESSAGE_ID_BYTES ||
        canonicalBase64UrlByteLength(candidate.deviceId) !== SECURE_DEVICE_ID_BYTES ||
        canonicalBase64UrlByteLength(candidate.commitMessageId) !== SECURE_MESSAGE_ID_BYTES ||
        !(candidate.retirementAdmissionCommitMessageId === null ||
          canonicalBase64UrlByteLength(candidate.retirementAdmissionCommitMessageId) === SECURE_MESSAGE_ID_BYTES) ||
        retireDevices.has(candidate.deviceId as string)) {
        throw new SecureRoomStateError("state-invalid", "pending member-retirement control is malformed");
      }
      retireDevices.add(candidate.deviceId as string);
      typed = candidate as unknown as SecureRoomPendingRelayControlV1;
    } else if (candidate.kind === "close-room") {
      closeCount += 1;
      if (closeCount > 1 || !exactKeys(candidate, ["kind", "requestId", "authorizationMessageId"]) ||
        canonicalBase64UrlByteLength(candidate.requestId) !== SECURE_MESSAGE_ID_BYTES ||
        canonicalBase64UrlByteLength(candidate.authorizationMessageId) !== SECURE_MESSAGE_ID_BYTES) {
        throw new SecureRoomStateError("state-invalid", "pending room-close control is malformed");
      }
      typed = candidate as unknown as SecureRoomPendingRelayControlV1;
    } else if (candidate.kind === "transfer-host") {
      transferCount += 1;
      if (transferCount > 1 || !exactKeys(candidate, [
        "kind", "authorizationId", "targetDeviceId", "offerMessageId", "acceptMessageId",
      ]) || canonicalBase64UrlByteLength(candidate.targetDeviceId) !== SECURE_DEVICE_ID_BYTES ||
        canonicalBase64UrlByteLength(candidate.offerMessageId) !== SECURE_MESSAGE_ID_BYTES ||
        !(candidate.authorizationId === null ||
          canonicalBase64UrlByteLength(candidate.authorizationId) === SECURE_MESSAGE_ID_BYTES) ||
        !(candidate.acceptMessageId === null ||
          canonicalBase64UrlByteLength(candidate.acceptMessageId) === SECURE_MESSAGE_ID_BYTES) ||
        (candidate.acceptMessageId !== null && candidate.authorizationId === null) ||
        candidate.offerMessageId === candidate.acceptMessageId ||
        (candidate.authorizationId !== null && candidate.authorizationId === candidate.offerMessageId) ||
        (candidate.authorizationId !== null && candidate.acceptMessageId !== null &&
          candidate.authorizationId === candidate.acceptMessageId)) {
        throw new SecureRoomStateError("state-invalid", "pending host-transfer control is malformed");
      }
      typed = candidate as unknown as SecureRoomPendingRelayControlV1;
    } else {
      throw new SecureRoomStateError("state-invalid", "pending relay-control kind is unsupported");
    }
    if (typed.kind === "admission-barrier") {
      if (requestIds.has(typed.admissionId)) {
        throw new SecureRoomStateError("state-invalid", "pending admission id is duplicated");
      }
      requestIds.add(typed.admissionId);
    } else if (typed.kind !== "transfer-host") {
      if (requestIds.has(typed.requestId)) throw new SecureRoomStateError("state-invalid", "pending relay request id is duplicated");
      requestIds.add(typed.requestId);
    } else if (typed.authorizationId !== null) {
      if (requestIds.has(typed.authorizationId)) {
        throw new SecureRoomStateError("state-invalid", "pending host-transfer authorization id is duplicated");
      }
      requestIds.add(typed.authorizationId);
    }
    if (!relayControlMatchesState(typed, state) && (!fallbackState || !relayControlMatchesState(typed, fallbackState))) {
      throw new SecureRoomStateError("state-invalid", "pending relay control is inconsistent with application authority");
    }
  }
}

export function cloneSecureRoomProcessedDeliveriesV1(
  value: readonly SecureRoomProcessedDeliveryV1[],
): SecureRoomProcessedDeliveryV1[] {
  return value.map((delivery) => ({ ...delivery }));
}

function validateProcessedDeliveries(value: unknown): asserts value is SecureRoomProcessedDeliveryV1[] {
  if (!strictArray(value) || value.length > MAX_PROCESSED_DELIVERIES) {
    throw new SecureRoomStateError("state-invalid", "processed delivery ledger is invalid or saturated");
  }
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!plainRecord(candidate) || !exactKeys(candidate, ["messageId", "digest"]) ||
      canonicalBase64UrlByteLength(candidate.messageId) !== SECURE_MESSAGE_ID_BYTES ||
      canonicalBase64UrlByteLength(candidate.digest) !== 32 || ids.has(candidate.messageId as string)) {
      throw new SecureRoomStateError("state-invalid", "processed delivery record is malformed or duplicated");
    }
    ids.add(candidate.messageId as string);
  }
}

function validateApplicationCounter(
  applicationState: SecureRoomStateSnapshotV4,
  deviceId: string,
  nextDeviceSequence: number,
): void {
  const ownMember = applicationState.members.find((member) => member.deviceId === deviceId);
  const expectedSequence = (ownMember?.lastSequence ?? 0) + 1;
  if (nextDeviceSequence !== expectedSequence) {
    throw new SecureRoomStateError("state-invalid", "secure room device counter is inconsistent");
  }
}

function validateState(state: SecureRoomDurableStateV1): void {
  if (
    !state || typeof state !== "object" ||
    canonicalBase64UrlByteLength(state.roomInstance) !== SECURE_ROOM_ID_BYTES ||
    canonicalBase64UrlByteLength(state.deviceId) !== SECURE_DEVICE_ID_BYTES ||
    !(state.mlsSnapshot instanceof Uint8Array) || state.mlsSnapshot.byteLength < 1 ||
    state.mlsSnapshot.byteLength > MAX_MLS_SNAPSHOT_BYTES ||
    !isSecureRoomStateSnapshotV4(state.applicationState) ||
    state.applicationState.roomInstance !== state.roomInstance ||
    !Number.isSafeInteger(state.nextDeviceSequence) || state.nextDeviceSequence < 1 ||
    !validEpoch(state.lastEpoch)
  ) {
    throw new SecureRoomStateError("state-invalid", "secure room state failed validation");
  }
  validatePendingOutbox(state.pendingOutbox, state.roomInstance, state.deviceId);
  validateProcessedDeliveries(state.processedDeliveries);
  for (const entry of state.pendingOutbox) {
    if (entry.kind === "admission" && entry.joinWelcomeMessageId !== null &&
        !state.processedDeliveries.some((delivery) => delivery.messageId === entry.joinWelcomeMessageId)) {
      throw new SecureRoomStateError("state-invalid", "retained join Welcome is absent from the processed-delivery ledger");
    }
  }
  validateApplicationCounter(state.applicationState, state.deviceId, state.nextDeviceSequence);

  const rollback = state.pendingApplicationRollback;
  const commitRollback = state.pendingCommitRollback;
  if (rollback !== null && commitRollback !== null) {
    throw new SecureRoomStateError("state-invalid", "application and commit rollback states cannot coexist");
  }
  validatePendingRelayControls(state.pendingRelayControls, state.applicationState, rollback?.applicationState);
  validatePendingCommitSecrets(
    state.pendingCommitSecrets,
    state.applicationState,
    rollback?.applicationState,
  );
  if (rollback !== null) {
    if (
      !plainRecord(rollback) || !exactKeys(rollback, [
        "messageId", "applicationState", "nextDeviceSequence", "lastEpoch", "pendingOutbox",
        "pendingRelayControls", "processedDeliveries", "pendingCommitSecrets", "deleteCommitSecretOnAccept",
      ]) ||
      canonicalBase64UrlByteLength(rollback.messageId) !== SECURE_MESSAGE_ID_BYTES ||
      !isSecureRoomStateSnapshotV4(rollback.applicationState) ||
      rollback.applicationState.roomInstance !== state.roomInstance ||
      !Number.isSafeInteger(rollback.nextDeviceSequence) || rollback.nextDeviceSequence < 1 ||
      !validEpoch(rollback.lastEpoch) ||
      !(rollback.deleteCommitSecretOnAccept === null ||
        canonicalBase64UrlByteLength(rollback.deleteCommitSecretOnAccept) === SECURE_MESSAGE_ID_BYTES)
    ) throw new SecureRoomStateError("state-invalid", "pending application rollback state is invalid");
    validatePendingOutbox(rollback.pendingOutbox, state.roomInstance, state.deviceId);
    validatePendingRelayControls(rollback.pendingRelayControls, rollback.applicationState);
    validateProcessedDeliveries(rollback.processedDeliveries);
    validateApplicationCounter(rollback.applicationState, state.deviceId, rollback.nextDeviceSequence);
    validatePendingCommitSecrets(rollback.pendingCommitSecrets, rollback.applicationState);
    const pendingApplication = state.pendingOutbox[state.pendingOutbox.length - 1];
    if (
      state.pendingOutbox.length !== rollback.pendingOutbox.length + 1 ||
      rollback.pendingOutbox.some((entry) => entry.kind === "application") ||
      !pendingOutboxMatchesRollback(state.pendingOutbox.slice(0, -1), rollback.pendingOutbox, rollback.messageId) ||
      canonicalJsonV4(state.processedDeliveries) !== canonicalJsonV4(rollback.processedDeliveries) ||
      !pendingApplication || pendingApplication.kind !== "application" ||
      pendingApplication.messageId !== rollback.messageId ||
      pendingApplication.event.deviceId !== state.deviceId ||
      pendingApplication.event.deviceSequence !== rollback.nextDeviceSequence ||
      pendingApplication.event.logicalOrder !== state.applicationState.logicalOrder ||
      !state.applicationState.seenEventIds.includes(pendingApplication.event.eventId) ||
      state.nextDeviceSequence !== rollback.nextDeviceSequence + 1 ||
      state.applicationState.logicalOrder !== rollback.applicationState.logicalOrder + 1 ||
      BigInt(state.lastEpoch) !== BigInt(rollback.lastEpoch)
    ) throw new SecureRoomStateError("state-invalid", "pending application rollback boundary is inconsistent");
    if (
      rollback.deleteCommitSecretOnAccept !== null &&
      !Object.prototype.hasOwnProperty.call(rollback.pendingCommitSecrets, rollback.deleteCommitSecretOnAccept)
    ) throw new SecureRoomStateError("state-invalid", "pending reveal has no matching committed secret");
  } else if (state.pendingOutbox.some((entry) => entry.kind === "application")) {
    throw new SecureRoomStateError("state-invalid", "pending application outbox has no rollback state");
  }

  if (commitRollback !== null) {
    if (
      !plainRecord(commitRollback) || !exactKeys(commitRollback, [
        "messageId", "applicationState", "nextDeviceSequence", "lastEpoch", "pendingOutbox",
        "pendingRelayControls", "processedDeliveries", "pendingCommitSecrets",
      ]) ||
      canonicalBase64UrlByteLength(commitRollback.messageId) !== SECURE_MESSAGE_ID_BYTES ||
      !isSecureRoomStateSnapshotV4(commitRollback.applicationState) ||
      commitRollback.applicationState.roomInstance !== state.roomInstance ||
      !Number.isSafeInteger(commitRollback.nextDeviceSequence) || commitRollback.nextDeviceSequence < 1 ||
      !validEpoch(commitRollback.lastEpoch)
    ) throw new SecureRoomStateError("state-invalid", "pending commit rollback state is invalid");
    validatePendingOutbox(commitRollback.pendingOutbox, state.roomInstance, state.deviceId);
    validatePendingRelayControls(commitRollback.pendingRelayControls, commitRollback.applicationState);
    validateProcessedDeliveries(commitRollback.processedDeliveries);
    validatePendingCommitSecrets(commitRollback.pendingCommitSecrets, commitRollback.applicationState);
    validateApplicationCounter(commitRollback.applicationState, state.deviceId, commitRollback.nextDeviceSequence);
    const pendingCommit = state.pendingOutbox[state.pendingOutbox.length - 1];
    if (
      state.pendingOutbox.length !== commitRollback.pendingOutbox.length + 1 ||
      !pendingOutboxEqual(state.pendingOutbox.slice(0, -1), commitRollback.pendingOutbox) ||
      !pendingCommit || (pendingCommit.kind !== "commit" && pendingCommit.kind !== "admission") ||
      pendingCommit.messageId !== commitRollback.messageId ||
      pendingCommit.grant === null ||
      pendingCommit.grant.logicalOrder !== commitRollback.applicationState.logicalOrder + 1 ||
      (pendingCommit.kind === "admission" &&
        (pendingCommit.welcomeMessageId === null || pendingCommit.commitAcknowledged)) ||
      canonicalJsonV4(state.processedDeliveries) !== canonicalJsonV4(commitRollback.processedDeliveries) ||
      state.nextDeviceSequence !== commitRollback.nextDeviceSequence ||
      BigInt(state.lastEpoch) !== BigInt(commitRollback.lastEpoch) + 1n
    ) throw new SecureRoomStateError("state-invalid", "pending commit rollback boundary is inconsistent");
  }
}

function serializeState(state: SecureRoomDurableStateV1): SerializedSecureRoomStateV1 {
  validateState(state);
  return {
    v: 1,
    protocol: SECURE_ROOM_PROTOCOL_VERSION,
    suite: SECURE_ROOM_MLS_CIPHERSUITE,
    roomInstance: state.roomInstance,
    deviceId: state.deviceId,
    mlsSnapshot: encodeBase64Url(state.mlsSnapshot),
    applicationState: state.applicationState,
    nextDeviceSequence: state.nextDeviceSequence,
    lastEpoch: state.lastEpoch,
    pendingOutbox: serializePendingOutbox(state.pendingOutbox),
    pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(state.pendingRelayControls),
    processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(state.processedDeliveries),
    pendingCommitSecrets: clonePendingCommitSecrets(state.pendingCommitSecrets),
    pendingApplicationRollback: state.pendingApplicationRollback === null ? null : {
      messageId: state.pendingApplicationRollback.messageId,
      applicationState: state.pendingApplicationRollback.applicationState,
      nextDeviceSequence: state.pendingApplicationRollback.nextDeviceSequence,
      lastEpoch: state.pendingApplicationRollback.lastEpoch,
      pendingOutbox: serializePendingOutbox(state.pendingApplicationRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(state.pendingApplicationRollback.pendingRelayControls),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(state.pendingApplicationRollback.processedDeliveries),
      pendingCommitSecrets: clonePendingCommitSecrets(state.pendingApplicationRollback.pendingCommitSecrets),
      deleteCommitSecretOnAccept: state.pendingApplicationRollback.deleteCommitSecretOnAccept,
    },
    pendingCommitRollback: state.pendingCommitRollback === null ? null : {
      messageId: state.pendingCommitRollback.messageId,
      applicationState: state.pendingCommitRollback.applicationState,
      nextDeviceSequence: state.pendingCommitRollback.nextDeviceSequence,
      lastEpoch: state.pendingCommitRollback.lastEpoch,
      pendingOutbox: serializePendingOutbox(state.pendingCommitRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(state.pendingCommitRollback.pendingRelayControls),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(state.pendingCommitRollback.processedDeliveries),
      pendingCommitSecrets: clonePendingCommitSecrets(state.pendingCommitRollback.pendingCommitSecrets),
    },
  };
}

function parseSerializedState(value: unknown, expectedRoomInstance: string): SecureRoomDurableStateV1 {
  const expectedKeys = [
    "v", "protocol", "suite", "roomInstance", "deviceId", "mlsSnapshot",
    "applicationState", "nextDeviceSequence", "lastEpoch", "pendingOutbox", "pendingRelayControls",
    "processedDeliveries", "pendingCommitSecrets", "pendingApplicationRollback", "pendingCommitRollback",
  ];
  if (
    !plainRecord(value) || !exactKeys(value, expectedKeys) || value.v !== 1 ||
    value.protocol !== SECURE_ROOM_PROTOCOL_VERSION || value.suite !== SECURE_ROOM_MLS_CIPHERSUITE ||
    value.roomInstance !== expectedRoomInstance || typeof value.deviceId !== "string" ||
    typeof value.mlsSnapshot !== "string" || typeof value.lastEpoch !== "string" ||
    !Array.isArray(value.pendingOutbox) || !Array.isArray(value.pendingRelayControls) ||
    !Array.isArray(value.processedDeliveries) ||
    !plainRecord(value.pendingCommitSecrets)
  ) {
    throw new SecureRoomStateError("state-invalid", "secure room state schema is invalid");
  }
  const snapshot = decodeCanonicalBase64UrlV4(value.mlsSnapshot, undefined, MAX_MLS_SNAPSHOT_BYTES);
  if (!snapshot) throw new SecureRoomStateError("state-invalid", "secure room MLS snapshot encoding is invalid");
  let pendingApplicationRollback: SecureRoomPendingApplicationRollbackV1 | null = null;
  if (value.pendingApplicationRollback !== null) {
    const pending = value.pendingApplicationRollback;
    const pendingKeys = [
      "messageId", "applicationState", "nextDeviceSequence", "lastEpoch", "pendingOutbox",
      "pendingRelayControls", "processedDeliveries",
      "pendingCommitSecrets", "deleteCommitSecretOnAccept",
    ];
    if (
      !plainRecord(pending) || !exactKeys(pending, pendingKeys) || typeof pending.messageId !== "string" ||
      typeof pending.lastEpoch !== "string" ||
      !Array.isArray(pending.pendingOutbox) || !Array.isArray(pending.pendingRelayControls) ||
      !Array.isArray(pending.processedDeliveries) ||
      !plainRecord(pending.pendingCommitSecrets) ||
      !(pending.deleteCommitSecretOnAccept === null || typeof pending.deleteCommitSecretOnAccept === "string")
    ) throw new SecureRoomStateError("state-invalid", "pending application rollback schema is invalid");
    pendingApplicationRollback = {
      messageId: pending.messageId,
      applicationState: pending.applicationState as SecureRoomStateSnapshotV4,
      nextDeviceSequence: pending.nextDeviceSequence as number,
      lastEpoch: pending.lastEpoch,
      pendingOutbox: parseSerializedPendingOutbox(pending.pendingOutbox, expectedRoomInstance, value.deviceId),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
        pending.pendingRelayControls as SecureRoomPendingRelayControlV1[],
      ),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
        pending.processedDeliveries as SecureRoomProcessedDeliveryV1[],
      ),
      pendingCommitSecrets: clonePendingCommitSecrets(
        pending.pendingCommitSecrets as Record<string, SecureRoomPendingCommitSecretV4>,
      ),
      deleteCommitSecretOnAccept: pending.deleteCommitSecretOnAccept,
    };
  }
  let pendingCommitRollback: SecureRoomPendingCommitRollbackV1 | null = null;
  if (value.pendingCommitRollback !== null) {
    const pending = value.pendingCommitRollback;
    const pendingKeys = [
      "messageId", "applicationState", "nextDeviceSequence", "lastEpoch", "pendingOutbox",
      "pendingRelayControls", "processedDeliveries", "pendingCommitSecrets",
    ];
    if (
      !plainRecord(pending) || !exactKeys(pending, pendingKeys) || typeof pending.messageId !== "string" ||
      typeof pending.lastEpoch !== "string" ||
      !Array.isArray(pending.pendingOutbox) || !Array.isArray(pending.pendingRelayControls) ||
      !Array.isArray(pending.processedDeliveries) || !plainRecord(pending.pendingCommitSecrets)
    ) throw new SecureRoomStateError("state-invalid", "pending commit rollback schema is invalid");
    pendingCommitRollback = {
      messageId: pending.messageId,
      applicationState: pending.applicationState as SecureRoomStateSnapshotV4,
      nextDeviceSequence: pending.nextDeviceSequence as number,
      lastEpoch: pending.lastEpoch,
      pendingOutbox: parseSerializedPendingOutbox(pending.pendingOutbox, expectedRoomInstance, value.deviceId),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
        pending.pendingRelayControls as SecureRoomPendingRelayControlV1[],
      ),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
        pending.processedDeliveries as SecureRoomProcessedDeliveryV1[],
      ),
      pendingCommitSecrets: clonePendingCommitSecrets(
        pending.pendingCommitSecrets as Record<string, SecureRoomPendingCommitSecretV4>,
      ),
    };
  }
  const state: SecureRoomDurableStateV1 = {
    roomInstance: value.roomInstance as string,
    deviceId: value.deviceId,
    mlsSnapshot: snapshot,
    applicationState: value.applicationState as SecureRoomStateSnapshotV4,
    nextDeviceSequence: value.nextDeviceSequence as number,
    lastEpoch: value.lastEpoch,
    pendingOutbox: parseSerializedPendingOutbox(value.pendingOutbox, expectedRoomInstance, value.deviceId),
    pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
      value.pendingRelayControls as SecureRoomPendingRelayControlV1[],
    ),
    processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
      value.processedDeliveries as SecureRoomProcessedDeliveryV1[],
    ),
    pendingCommitSecrets: clonePendingCommitSecrets(
      value.pendingCommitSecrets as Record<string, SecureRoomPendingCommitSecretV4>,
    ),
    pendingApplicationRollback,
    pendingCommitRollback,
  };
  validateState(state);
  return state;
}

function wrapSalt(roomBinding: Uint8Array, randomSalt: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(
    WRAP_DOMAIN,
    encodeU16(SECURE_ROOM_PROTOCOL_VERSION),
    encodeU16(SECURE_ROOM_MLS_CIPHERSUITE),
    roomBinding,
    randomSalt,
  );
}

function wrapInfo(roomBinding: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(
    WRAP_DOMAIN,
    STATE_MAGIC,
    encodeU16(STATE_FORMAT_VERSION),
    encodeU16(SECURE_ROOM_PROTOCOL_VERSION),
    encodeU16(SECURE_ROOM_MLS_CIPHERSUITE),
    roomBinding,
  );
}

async function deriveWrappingKey(secret: Uint8Array, roomBinding: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = browserCrypto().subtle;
  const secretInput = copyBytes(secret);
  const saltInput = wrapSalt(roomBinding, salt);
  const infoInput = wrapInfo(roomBinding);
  try {
    const input = await subtle.importKey("raw", secretInput, "HKDF", false, ["deriveKey"]);
    return await subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltInput,
        info: infoInput,
      },
      input,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    // These are adapter-owned WebCrypto inputs. Retaining them through the
    // awaited derivation lets us erase the room-secret copy deterministically.
    secretInput.fill(0);
    saltInput.fill(0);
    infoInput.fill(0);
  }
}

function makeHeader(
  roomBinding: Uint8Array,
  salt: Uint8Array,
  nonce: Uint8Array,
  ciphertextLength: number,
): Uint8Array<ArrayBuffer> {
  const header = concatBytes(
    STATE_MAGIC,
    encodeU16(STATE_FORMAT_VERSION),
    encodeU16(SECURE_ROOM_PROTOCOL_VERSION),
    encodeU16(SECURE_ROOM_MLS_CIPHERSUITE),
    roomBinding,
    salt,
    nonce,
    encodeU32(ciphertextLength),
  );
  if (header.byteLength !== HEADER_BYTES) {
    throw new SecureRoomStateError("state-invalid", "secure room state header is inconsistent");
  }
  return header;
}

export async function protectSecureRoomStateV1(
  state: SecureRoomDurableStateV1,
  roomSecret: string,
): Promise<Uint8Array> {
  const roomBinding = decodeCanonicalBase64UrlV4(state?.roomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES);
  if (!roomBinding) throw new SecureRoomStateError("invalid-input", "invalid secure room binding");
  const secret = decodeRoomSecret(roomSecret);
  let plaintext: Uint8Array<ArrayBuffer> | null = null;
  const salt: Uint8Array<ArrayBuffer> = new Uint8Array(SALT_BYTES);
  const nonce: Uint8Array<ArrayBuffer> = new Uint8Array(NONCE_BYTES);
  browserCrypto().getRandomValues(salt);
  browserCrypto().getRandomValues(nonce);
  try {
    plaintext = UTF8.encode(canonicalJsonV4(serializeState(state)));
    if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new SecureRoomStateError("state-invalid", "secure room state exceeds the persistence limit");
    }
    const ciphertextLength = plaintext.byteLength + GCM_TAG_BYTES;
    const header = makeHeader(roomBinding, salt, nonce, ciphertextLength);
    const key = await deriveWrappingKey(secret, roomBinding, salt);
    const ciphertext = new Uint8Array(await browserCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: header,
        tagLength: 128,
      },
      key,
      plaintext,
    ));
    const wrapped = concatBytes(header, ciphertext);
    if (wrapped.byteLength > MAX_PERSISTED_BYTES) {
      throw new SecureRoomStateError("state-invalid", "wrapped secure room state exceeds the persistence limit");
    }
    return wrapped;
  } catch (error) {
    if (error instanceof SecureRoomStateError) throw error;
    throw new SecureRoomStateError("state-invalid", "secure room state protection failed", error);
  } finally {
    plaintext?.fill(0);
    secret.fill(0);
    roomBinding.fill(0);
    salt.fill(0);
    nonce.fill(0);
  }
}

interface ParsedEnvelope {
  header: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
}

function parseEnvelope(wrapped: Uint8Array, expectedRoomBinding: Uint8Array): ParsedEnvelope {
  if (!(wrapped instanceof Uint8Array) || wrapped.byteLength < HEADER_BYTES + GCM_TAG_BYTES || wrapped.byteLength > MAX_PERSISTED_BYTES) {
    throw new SecureRoomStateError("state-invalid", "wrapped secure room state has an invalid size");
  }
  let offset = 0;
  const take = (length: number): Uint8Array<ArrayBuffer> => {
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > wrapped.byteLength) {
      throw new SecureRoomStateError("state-invalid", "wrapped secure room state is truncated");
    }
    const result = copyBytes(wrapped.subarray(offset, end));
    offset = end;
    return result;
  };
  const magic = take(STATE_MAGIC.byteLength);
  if (!magic.every((byte, index) => byte === STATE_MAGIC[index])) {
    throw new SecureRoomStateError("state-invalid", "wrapped secure room state magic is invalid");
  }
  const readU16 = () => new DataView(take(2).buffer).getUint16(0, false);
  if (
    readU16() !== STATE_FORMAT_VERSION || readU16() !== SECURE_ROOM_PROTOCOL_VERSION ||
    readU16() !== SECURE_ROOM_MLS_CIPHERSUITE
  ) throw new SecureRoomStateError("state-invalid", "wrapped secure room state version or suite is unsupported");
  const roomBinding = take(SECURE_ROOM_ID_BYTES);
  if (!roomBinding.every((byte, index) => byte === expectedRoomBinding[index])) {
    throw new SecureRoomStateError("state-invalid", "wrapped secure room state belongs to a different room");
  }
  const salt = take(SALT_BYTES);
  const nonce = take(NONCE_BYTES);
  const ciphertextLength = new DataView(take(4).buffer).getUint32(0, false);
  if (ciphertextLength < GCM_TAG_BYTES + 1 || ciphertextLength !== wrapped.byteLength - offset) {
    throw new SecureRoomStateError("state-invalid", "wrapped secure room state ciphertext length is invalid");
  }
  const header = copyBytes(wrapped.subarray(0, offset));
  const ciphertext = take(ciphertextLength);
  if (offset !== wrapped.byteLength) {
    throw new SecureRoomStateError("state-invalid", "wrapped secure room state has trailing bytes");
  }
  return { header, salt, nonce, ciphertext };
}

export async function unprotectSecureRoomStateV1(
  wrapped: Uint8Array,
  expectedRoomInstance: string,
  roomSecret: string,
): Promise<SecureRoomDurableStateV1> {
  const roomBinding = decodeCanonicalBase64UrlV4(expectedRoomInstance, SECURE_ROOM_ID_BYTES, SECURE_ROOM_ID_BYTES);
  if (!roomBinding) throw new SecureRoomStateError("invalid-input", "invalid secure room binding");
  const secret = decodeRoomSecret(roomSecret);
  let plaintext: Uint8Array<ArrayBuffer> | null = null;
  let parsedEnvelope: ParsedEnvelope | null = null;
  try {
    parsedEnvelope = parseEnvelope(wrapped, roomBinding);
    const key = await deriveWrappingKey(secret, roomBinding, parsedEnvelope.salt);
    plaintext = new Uint8Array(await browserCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: parsedEnvelope.nonce,
        additionalData: parsedEnvelope.header,
        tagLength: 128,
      },
      key,
      parsedEnvelope.ciphertext,
    ));
    if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new SecureRoomStateError("state-invalid", "decrypted secure room state has an invalid size");
    }
    const text = FATAL_UTF8.decode(plaintext);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new SecureRoomStateError("state-invalid", "decrypted secure room state is not JSON", error);
    }
    if (canonicalJsonV4(value) !== text) {
      throw new SecureRoomStateError("state-invalid", "decrypted secure room state is not canonical");
    }
    return parseSerializedState(value, expectedRoomInstance);
  } catch (error) {
    if (error instanceof SecureRoomStateError) throw error;
    throw new SecureRoomStateError("state-invalid", "secure room state authentication failed", error);
  } finally {
    plaintext?.fill(0);
    secret.fill(0);
    roomBinding.fill(0);
    parsedEnvelope?.salt.fill(0);
    parsedEnvelope?.nonce.fill(0);
  }
}

export function cloneSecureRoomDurableStateV1(state: SecureRoomDurableStateV1): SecureRoomDurableStateV1 {
  validateState(state);
  return {
    roomInstance: state.roomInstance,
    deviceId: state.deviceId,
    mlsSnapshot: state.mlsSnapshot.slice(),
    applicationState: JSON.parse(canonicalJsonV4(state.applicationState)) as SecureRoomStateSnapshotV4,
    nextDeviceSequence: state.nextDeviceSequence,
    lastEpoch: state.lastEpoch,
    pendingOutbox: cloneSecureRoomPendingOutboxV1(state.pendingOutbox),
    pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(state.pendingRelayControls),
    processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(state.processedDeliveries),
    pendingCommitSecrets: clonePendingCommitSecrets(state.pendingCommitSecrets),
    pendingApplicationRollback: state.pendingApplicationRollback === null ? null : {
      messageId: state.pendingApplicationRollback.messageId,
      applicationState: JSON.parse(canonicalJsonV4(state.pendingApplicationRollback.applicationState)) as SecureRoomStateSnapshotV4,
      nextDeviceSequence: state.pendingApplicationRollback.nextDeviceSequence,
      lastEpoch: state.pendingApplicationRollback.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(state.pendingApplicationRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
        state.pendingApplicationRollback.pendingRelayControls,
      ),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
        state.pendingApplicationRollback.processedDeliveries,
      ),
      pendingCommitSecrets: clonePendingCommitSecrets(state.pendingApplicationRollback.pendingCommitSecrets),
      deleteCommitSecretOnAccept: state.pendingApplicationRollback.deleteCommitSecretOnAccept,
    },
    pendingCommitRollback: state.pendingCommitRollback === null ? null : {
      messageId: state.pendingCommitRollback.messageId,
      applicationState: JSON.parse(canonicalJsonV4(
        state.pendingCommitRollback.applicationState,
      )) as SecureRoomStateSnapshotV4,
      nextDeviceSequence: state.pendingCommitRollback.nextDeviceSequence,
      lastEpoch: state.pendingCommitRollback.lastEpoch,
      pendingOutbox: cloneSecureRoomPendingOutboxV1(state.pendingCommitRollback.pendingOutbox),
      pendingRelayControls: cloneSecureRoomPendingRelayControlsV1(
        state.pendingCommitRollback.pendingRelayControls,
      ),
      processedDeliveries: cloneSecureRoomProcessedDeliveriesV1(
        state.pendingCommitRollback.processedDeliveries,
      ),
      pendingCommitSecrets: clonePendingCommitSecrets(state.pendingCommitRollback.pendingCommitSecrets),
    },
  };
}
