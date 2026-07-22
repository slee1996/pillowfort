import { verifyAsync } from "@noble/ed25519";
import { normalizeRoomId } from "./entitlements";
import {
  SECURE_DEVICE_ID_BYTES,
  SECURE_MESSAGE_ID_BYTES,
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
} from "./protocolV4";
import { fromBase64Url, toBase64Url } from "./roomAuth";

export const SECURE_DEVICE_AUTH_CHALLENGE_BYTES_V4 = 32;
export const SECURE_DEVICE_AUTH_SIGNATURE_BYTES_V4 = 64;
export const SECURE_DEVICE_AUTH_PUBLIC_KEY_BYTES_V4 = 32;

const DEVICE_RESUME_DOMAIN_V4 = "pillowfort:secure-device-resume:v4";
const UTF8 = new TextEncoder();

export interface SecureDeviceResumeContextV4 {
  roomId: string;
  roomInstance: string;
  deviceId: string;
  connectionId: string;
  requestId: string;
  challenge: string;
}

export type SecureDeviceResumeSignerV4 = (
  bytes: Uint8Array,
) => Promise<Uint8Array | string> | Uint8Array | string;

function validContext(value: SecureDeviceResumeContextV4): boolean {
  return !!value && typeof value === "object" &&
    normalizeRoomId(value.roomId) === value.roomId &&
    canonicalBase64UrlByteLength(value.roomInstance) === SECURE_ROOM_ID_BYTES &&
    canonicalBase64UrlByteLength(value.deviceId) === SECURE_DEVICE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.connectionId) === SECURE_MESSAGE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.requestId) === SECURE_MESSAGE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.challenge) === SECURE_DEVICE_AUTH_CHALLENGE_BYTES_V4;
}

export function secureDeviceResumeProofBytesV4(
  context: SecureDeviceResumeContextV4,
): Uint8Array {
  if (!validContext(context)) throw new TypeError("invalid secure-device resume context");
  return UTF8.encode(JSON.stringify([
    DEVICE_RESUME_DOMAIN_V4,
    SECURE_ROOM_PROTOCOL_VERSION,
    SECURE_ROOM_MLS_CIPHERSUITE,
    context.roomId,
    context.roomInstance,
    context.deviceId,
    context.connectionId,
    context.requestId,
    context.challenge,
  ]));
}

export async function signSecureDeviceResumeProofV4(
  context: SecureDeviceResumeContextV4,
  signer: SecureDeviceResumeSignerV4,
): Promise<string> {
  if (typeof signer !== "function") throw new TypeError("secure-device signer is required");
  const signature = await signer(secureDeviceResumeProofBytesV4(context));
  const bytes = typeof signature === "string"
    ? fromBase64Url(signature, SECURE_DEVICE_AUTH_SIGNATURE_BYTES_V4)
    : signature;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SECURE_DEVICE_AUTH_SIGNATURE_BYTES_V4) {
    throw new TypeError("secure-device signer returned an invalid signature");
  }
  return toBase64Url(bytes);
}

export async function verifySecureDeviceResumeProofV4(
  context: SecureDeviceResumeContextV4,
  proof: unknown,
  signaturePublicKey: unknown,
): Promise<boolean> {
  if (!validContext(context) || typeof proof !== "string" || typeof signaturePublicKey !== "string") return false;
  const signature = fromBase64Url(proof, SECURE_DEVICE_AUTH_SIGNATURE_BYTES_V4);
  const publicKey = fromBase64Url(signaturePublicKey, SECURE_DEVICE_AUTH_PUBLIC_KEY_BYTES_V4);
  if (!signature || !publicKey) return false;
  try {
    return await verifyAsync(
      signature,
      secureDeviceResumeProofBytesV4(context),
      publicKey,
      { zip215: false },
    );
  } catch {
    return false;
  }
}
