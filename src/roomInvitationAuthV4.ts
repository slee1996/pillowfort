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
import { fromBase64Url } from "./roomAuth";

export const ROOM_INVITATION_AUTH_VERSION_V4 = 4 as const;
export const ROOM_INVITATION_AUTH_KDF_V4 = "pbkdf2-sha256-600k-ed25519-v4" as const;
export const ROOM_INVITATION_AUTH_SIGNATURE_BYTES_V4 = 64;
export const ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4 = 32;

const AUTH_DOMAIN_V4 = "pillowfort:secure-room-invitation-auth:v4";
const UTF8 = new TextEncoder();

export type RoomInvitationAuthModeV4 = "setup" | "join";

export interface RoomInvitationAuthContextV4 {
  mode: RoomInvitationAuthModeV4;
  roomId: string;
  roomInstance: string;
  deviceId: string;
  connectionId: string;
  requestId: string;
  challenge: string;
}

export interface RoomInvitationAuthPayloadV4 {
  v: 4;
  kdf: typeof ROOM_INVITATION_AUTH_KDF_V4;
  challenge: string;
  proof: string;
  publicKey?: string;
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

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key) &&
      Object.getOwnPropertyDescriptor(value, key)?.enumerable === true);
}

function validContext(value: RoomInvitationAuthContextV4): boolean {
  return !!value && typeof value === "object" &&
    (value.mode === "setup" || value.mode === "join") &&
    normalizeRoomId(value.roomId) === value.roomId &&
    canonicalBase64UrlByteLength(value.roomInstance) === SECURE_ROOM_ID_BYTES &&
    canonicalBase64UrlByteLength(value.deviceId) === SECURE_DEVICE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.connectionId) === SECURE_MESSAGE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.requestId) === SECURE_MESSAGE_ID_BYTES &&
    canonicalBase64UrlByteLength(value.challenge) === 32;
}

export function parseRoomInvitationAuthPayloadV4(
  value: unknown,
  mode: RoomInvitationAuthModeV4,
): RoomInvitationAuthPayloadV4 | null {
  if (!isPlainRecord(value) || !exactKeys(
    value,
    ["v", "kdf", "challenge", "proof"],
    mode === "setup" ? ["publicKey"] : [],
  )) return null;
  if (value.v !== ROOM_INVITATION_AUTH_VERSION_V4 || value.kdf !== ROOM_INVITATION_AUTH_KDF_V4 ||
      canonicalBase64UrlByteLength(value.challenge) !== 32 ||
      canonicalBase64UrlByteLength(value.proof) !== ROOM_INVITATION_AUTH_SIGNATURE_BYTES_V4) return null;
  if (mode === "setup" && canonicalBase64UrlByteLength(value.publicKey) !== ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4) {
    return null;
  }
  return {
    v: 4,
    kdf: ROOM_INVITATION_AUTH_KDF_V4,
    challenge: value.challenge as string,
    proof: value.proof as string,
    ...(mode === "setup" && { publicKey: value.publicKey as string }),
  };
}

export function roomInvitationAuthProofBytesV4(
  context: RoomInvitationAuthContextV4,
  publicKey: string,
): Uint8Array {
  if (!validContext(context) || canonicalBase64UrlByteLength(publicKey) !== ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4) {
    throw new TypeError("invalid secure-room invitation authentication context");
  }
  return UTF8.encode(JSON.stringify([
    AUTH_DOMAIN_V4,
    SECURE_ROOM_PROTOCOL_VERSION,
    SECURE_ROOM_MLS_CIPHERSUITE,
    context.mode,
    context.roomId,
    context.roomInstance,
    context.deviceId,
    context.connectionId,
    context.requestId,
    context.challenge,
    publicKey,
  ]));
}

export async function verifyRoomInvitationAuthV4(options: {
  context: RoomInvitationAuthContextV4;
  auth: unknown;
  storedPublicKey?: string | null;
}): Promise<boolean> {
  const auth = parseRoomInvitationAuthPayloadV4(options.auth, options.context?.mode);
  if (!auth || !validContext(options.context) || auth.challenge !== options.context.challenge) return false;
  const publicKey = options.context.mode === "setup" ? auth.publicKey : options.storedPublicKey;
  if (!publicKey || (options.context.mode === "join" && auth.publicKey !== undefined)) return false;
  const proof = fromBase64Url(auth.proof, ROOM_INVITATION_AUTH_SIGNATURE_BYTES_V4);
  const key = fromBase64Url(publicKey, ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4);
  if (!proof || !key) return false;
  try {
    return await verifyAsync(proof, roomInvitationAuthProofBytesV4(options.context, publicKey), key, { zip215: false });
  } catch {
    return false;
  }
}
