import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4,
  ROOM_INVITATION_AUTH_KDF_V4,
  roomInvitationAuthProofBytesV4,
  type RoomInvitationAuthContextV4,
  type RoomInvitationAuthPayloadV4,
} from "../../../src/roomInvitationAuthV4";
import { normalizeRoomId } from "../../../src/entitlements";
import {
  SECURE_ROOM_ID_BYTES,
  SECURE_ROOM_MLS_CIPHERSUITE,
  SECURE_ROOM_PROTOCOL_VERSION,
  canonicalBase64UrlByteLength,
} from "../../../src/protocolV4";
import {
  roomInvitationMemberBindingProofBytesV4,
  verifyRoomInvitationMemberBindingV4,
  type RoomInvitationMemberBindingContextV4,
  type RoomInvitationMemberBindingV4,
} from "../../../src/roomInvitationMemberBindingV4";
import { toBase64Url } from "../../../src/roomAuth";

const UTF8 = new TextEncoder();
const PBKDF2_ITERATIONS = 600_000;
const SAFETY_CODE_DOMAIN_V4 = "pillowfort:secure-room-safety-code:v4";

async function deriveInvitationSeed(roomId: string, roomSecret: string): Promise<Uint8Array> {
  // Do not cache either a secret-bearing string key or the derived signing
  // seed. Protocol v4 authenticates reconnects with the MLS device key, so an
  // invitation proof is infrequent and can be derived for each fresh
  // setup/admission challenge, then zeroed by the caller.
  const secretBytes = UTF8.encode(roomSecret);
  try {
    const baseKey = await crypto.subtle.importKey("raw", secretBytes, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: UTF8.encode(`pillowfort:auth-sign-v4:${roomId}`),
    }, baseKey, 256);
    return new Uint8Array(bits);
  } finally {
    secretBytes.fill(0);
  }
}

/** Public comparison code; it fingerprints the authenticated invitation key and exact room instance. */
export async function secureRoomSafetyCodeV4(options: {
  roomId: string;
  roomInstance: string;
  invitationPublicKey: string;
}): Promise<string> {
  if (normalizeRoomId(options?.roomId) !== options.roomId ||
      canonicalBase64UrlByteLength(options?.roomInstance) !== SECURE_ROOM_ID_BYTES ||
      canonicalBase64UrlByteLength(options?.invitationPublicKey) !== ROOM_INVITATION_AUTH_PUBLIC_KEY_BYTES_V4) {
    throw new TypeError("invalid secure-room safety-code context");
  }
  const material = UTF8.encode(JSON.stringify([
    SAFETY_CODE_DOMAIN_V4,
    SECURE_ROOM_PROTOCOL_VERSION,
    SECURE_ROOM_MLS_CIPHERSUITE,
    options.roomId,
    options.roomInstance,
    options.invitationPublicKey,
  ]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  try {
    const encoded = toBase64Url(digest);
    return `${encoded.slice(0, 4)}-${encoded.slice(4, 8)}-${encoded.slice(8, 12)}`;
  } finally {
    digest.fill(0);
  }
}

/** Derives the invitation public key transiently, then returns its public comparison code. */
export async function secureRoomInvitationSafetyCodeV4(
  roomId: string,
  roomInstance: string,
  roomSecret: string,
): Promise<string> {
  const seed = await deriveInvitationSeed(roomId, roomSecret);
  let publicKeyBytes: Uint8Array | null = null;
  try {
    publicKeyBytes = await getPublicKeyAsync(seed);
    return await secureRoomSafetyCodeV4({
      roomId,
      roomInstance,
      invitationPublicKey: toBase64Url(publicKeyBytes),
    });
  } finally {
    publicKeyBytes?.fill(0);
    seed.fill(0);
  }
}

export async function createRoomInvitationAuthV4(
  context: RoomInvitationAuthContextV4,
  roomSecret: string,
): Promise<RoomInvitationAuthPayloadV4> {
  const seed = await deriveInvitationSeed(context.roomId, roomSecret);
  try {
    const publicKey = toBase64Url(await getPublicKeyAsync(seed));
    const proof = toBase64Url(await signAsync(roomInvitationAuthProofBytesV4(context, publicKey), seed));
    return {
      v: 4,
      kdf: ROOM_INVITATION_AUTH_KDF_V4,
      challenge: context.challenge,
      proof,
      ...(context.mode === "setup" && { publicKey }),
    };
  } finally {
    seed.fill(0);
  }
}

export async function createRoomInvitationMemberBindingV4(
  context: RoomInvitationMemberBindingContextV4,
  roomSecret: string,
): Promise<RoomInvitationMemberBindingV4> {
  const seed = await deriveInvitationSeed(context.roomId, roomSecret);
  try {
    return {
      v: 4,
      kdf: ROOM_INVITATION_AUTH_KDF_V4,
      ...context,
      proof: toBase64Url(await signAsync(roomInvitationMemberBindingProofBytesV4(context), seed)),
    };
  } finally {
    seed.fill(0);
  }
}

export async function verifyRoomInvitationMemberBindingWithSecretV4(options: {
  binding: unknown;
  expected: RoomInvitationMemberBindingContextV4;
  roomSecret: string;
}): Promise<boolean> {
  const seed = await deriveInvitationSeed(options.expected.roomId, options.roomSecret);
  try {
    const invitationPublicKey = toBase64Url(await getPublicKeyAsync(seed));
    return verifyRoomInvitationMemberBindingV4({
      binding: options.binding,
      invitationPublicKey,
      expected: options.expected,
    });
  } finally {
    seed.fill(0);
  }
}

export function clearSecureInvitationAuthCacheV4(): void {
  // Kept as a compatibility hook for callers compiled against the first v4
  // draft. There is deliberately no invitation-key cache to clear.
}
