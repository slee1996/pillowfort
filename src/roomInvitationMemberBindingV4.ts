import { verifyAsync } from "@noble/ed25519";
import { normalizeRoomId } from "./entitlements";
import {
  MAX_MLS_KEY_PACKAGE_BYTES,
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
} from "./protocolV4";
import {
  ROOM_INVITATION_AUTH_KDF_V4,
  ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4,
  ROOM_INVITATION_AUTH_SIGNATURE_BYTES_V4,
} from "./roomInvitationAuthV4";
import { fromBase64Url, toBase64Url } from "./roomAuth";

const MEMBER_BINDING_DOMAIN_V4 = "pillowfort:secure-room-member-binding:v4";
const UTF8 = new TextEncoder();
const SHA256_BYTES = 32;

export type RoomInvitationMemberBindingModeV4 = "founder" | "admission";

export interface RoomInvitationMemberBindingContextV4 {
  mode: RoomInvitationMemberBindingModeV4;
  roomId: string;
  roomInstance: string;
  deviceId: string;
  admissionId: string;
  signaturePublicKey: string;
  keyPackageDigest: string;
}

/**
 * Invitation-key authorization for one exact MLS credential and KeyPackage.
 * It is intentionally independent of a relay connection/challenge so the
 * founder binding can be persisted and checked by members joining later.
 */
export interface RoomInvitationMemberBindingV4 extends RoomInvitationMemberBindingContextV4 {
  v: 4;
  kdf: typeof ROOM_INVITATION_AUTH_KDF_V4;
  proof: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype &&
      Reflect.ownKeys(value).every((key) => typeof key === "string" &&
        !["__proto__", "constructor", "prototype"].includes(key));
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
  );
}

function validContext(value: RoomInvitationMemberBindingContextV4): boolean {
  return !!value && typeof value === "object" &&
    (value.mode === "founder" || value.mode === "admission") &&
    normalizeRoomId(value.roomId) === value.roomId &&
    canonicalBase64UrlByteLength(value.roomInstance) === SECURE_ROOM_ID_BYTES &&
    canonicalBase64UrlByteLength(value.deviceId) === SECURE_DEVICE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.admissionId) === SECURE_MESSAGE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.signaturePublicKey) === SHA256_BYTES &&
    canonicalBase64UrlByteLength(value.keyPackageDigest) === SHA256_BYTES;
}

export function parseRoomInvitationMemberBindingV4(value: unknown): RoomInvitationMemberBindingV4 | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "v", "kdf", "mode", "roomId", "roomInstance", "deviceId", "admissionId",
    "signaturePublicKey", "keyPackageDigest", "proof",
  ])) return null;
  const context = value as unknown as RoomInvitationMemberBindingContextV4;
  if (value.v !== SECURE_ROOM_PROTOCOL_VERSION || value.kdf !== ROOM_INVITATION_AUTH_KDF_V4 ||
      !validContext(context) ||
      canonicalBase64UrlByteLength(value.proof) !== ROOM_INVITATION_AUTH_SIGNATURE_BYTES_V4) return null;
  return {
    v: 4,
    kdf: ROOM_INVITATION_AUTH_KDF_V4,
    mode: context.mode,
    roomId: context.roomId,
    roomInstance: context.roomInstance,
    deviceId: context.deviceId,
    admissionId: context.admissionId,
    signaturePublicKey: context.signaturePublicKey,
    keyPackageDigest: context.keyPackageDigest,
    proof: value.proof as string,
  };
}

export function roomInvitationMemberBindingProofBytesV4(
  context: RoomInvitationMemberBindingContextV4,
): Uint8Array {
  if (!validContext(context)) throw new TypeError("invalid secure-room member binding context");
  return UTF8.encode(JSON.stringify([
    MEMBER_BINDING_DOMAIN_V4,
    SECURE_ROOM_PROTOCOL_VERSION,
    SECURE_ROOM_MLS_CIPHERSUITE,
    context.mode,
    context.roomId,
    context.roomInstance,
    context.deviceId,
    context.admissionId,
    context.signaturePublicKey,
    context.keyPackageDigest,
  ]));
}

export async function secureKeyPackageDigestV4(keyPackage: string | Uint8Array): Promise<string> {
  let bytes: Uint8Array | null = null;
  let copied = false;
  if (typeof keyPackage === "string") {
    const length = canonicalBase64UrlByteLength(keyPackage);
    if (length === null || length < 1 || length > MAX_MLS_KEY_PACKAGE_BYTES) {
      throw new TypeError("invalid canonical MLS KeyPackage");
    }
    bytes = fromBase64Url(keyPackage);
  } else if (keyPackage instanceof Uint8Array &&
      keyPackage.byteLength >= 1 && keyPackage.byteLength <= MAX_MLS_KEY_PACKAGE_BYTES) {
    bytes = keyPackage.slice();
    copied = true;
  }
  if (!bytes) throw new TypeError("invalid canonical MLS KeyPackage");
  try {
    return toBase64Url(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      bytes.slice().buffer as ArrayBuffer,
    )));
  } finally {
    // The KeyPackage is public, but avoid retaining an unnecessary decoded
    // duplicate in either the browser or Worker isolate.
    if (typeof keyPackage === "string" || copied) bytes.fill(0);
  }
}

/** Server-facing name retained to make the invitation binding explicit. */
export const roomInvitationKeyPackageDigestV4 = secureKeyPackageDigestV4;

export async function verifyRoomInvitationMemberBindingV4(options: {
  binding: unknown;
  invitationPublicKey: string;
  expected?: RoomInvitationMemberBindingContextV4;
}): Promise<boolean> {
  const binding = parseRoomInvitationMemberBindingV4(options.binding);
  if (!binding ||
      canonicalBase64UrlByteLength(options.invitationPublicKey) !== ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4) {
    return false;
  }
  if (options.expected) {
    if (!validContext(options.expected)) return false;
    for (const key of [
      "mode", "roomId", "roomInstance", "deviceId", "admissionId",
      "signaturePublicKey", "keyPackageDigest",
    ] as const) {
      if (binding[key] !== options.expected[key]) return false;
    }
  }
  const proof = fromBase64Url(binding.proof, ROOM_INVITATION_AUTH_SIGNATURE_BYTES_V4);
  const publicKey = fromBase64Url(options.invitationPublicKey, ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4);
  if (!proof || !publicKey) return false;
  try {
    return await verifyAsync(
      proof,
      roomInvitationMemberBindingProofBytesV4(binding),
      publicKey,
      { zip215: false },
    );
  } catch {
    return false;
  } finally {
    proof.fill(0);
    publicKey.fill(0);
  }
}
