import { verifyAsync } from "@noble/ed25519";

export const ROOM_AUTH_VERSION = 2 as const;
export const ROOM_AUTH_KDF_ID = "pbkdf2-sha256-600k-ed25519-v2" as const;
export const ROOM_AUTH_CHALLENGE_TTL_MS = 30_000;
export const MAX_WEBSOCKET_FRAME_BYTES = 8 * 1024;
export const MAX_AUTH_FAILURES_PER_MINUTE = 5;

export type RoomAuthAction = "set-up" | "join" | "rejoin";

export interface RoomAuthPayloadV2 {
  v: typeof ROOM_AUTH_VERSION;
  kdf: typeof ROOM_AUTH_KDF_ID;
  challenge: string;
  proof: string;
  publicKey?: string;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const AUTH_PAYLOAD_REQUIRED_KEYS = ["v", "kdf", "challenge", "proof"] as const;
const AUTH_PAYLOAD_ALLOWED_KEYS = new Set<string>([...AUTH_PAYLOAD_REQUIRED_KEYS, "publicKey"]);
const UNSAFE_AUTH_NAME_RE = /[\p{Cc}\p{Default_Ignorable_Code_Point}]/u;
const RESERVED_AUTH_NAMES = new Set(["__proto__", "prototype", "constructor"]);

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value: string, expectedLength?: number): Uint8Array | null {
  if (!value || !BASE64URL_RE.test(value)) return null;
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (expectedLength !== undefined && bytes.length !== expectedLength) return null;
    if (toBase64Url(bytes) !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

export function createRoomAuthChallenge(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function normalizeAuthName(name: string): string {
  if (typeof name !== "string" || UNSAFE_AUTH_NAME_RE.test(name)) return "";
  // Reject lone surrogates instead of signing one string while a renderer or
  // serializer displays a replacement character. Preserve the legacy
  // trim/truncate behavior, but truncate by Unicode scalar rather than UTF-16
  // code unit so an emoji cannot be split in half.
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = name.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return "";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return "";
    }
  }
  const normalized = [...name.trim()].slice(0, 24).join("");
  if (!normalized || normalized.normalize("NFC") !== normalized) return "";
  // NFKC folding catches compatibility-spelling variants of JavaScript's
  // prototype keys (for example full-width characters) without restricting
  // ordinary international names or emoji.
  if (RESERVED_AUTH_NAMES.has(normalized.normalize("NFKC").toLowerCase())) return "";
  return normalized;
}

export function roomAuthProofBytes(
  action: RoomAuthAction,
  roomId: string,
  name: string,
  challenge: string,
  publicKey: string
): Uint8Array {
  const normalizedName = normalizeAuthName(name);
  if (!normalizedName) throw new TypeError("invalid room authentication name");
  return textEncoder.encode(JSON.stringify([
    "pillowfort-room-auth",
    ROOM_AUTH_VERSION,
    action,
    roomId,
    normalizedName,
    challenge,
    publicKey,
  ]));
}

export function validRoomAuthPayload(value: unknown): value is RoomAuthPayloadV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== AUTH_PAYLOAD_REQUIRED_KEYS.length &&
      keys.length !== AUTH_PAYLOAD_REQUIRED_KEYS.length + 1) return false;
    for (const key of keys) {
      if (typeof key !== "string" || !AUTH_PAYLOAD_ALLOWED_KEYS.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    }
    if (!AUTH_PAYLOAD_REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
      return false;
    }

    const auth = value as Partial<RoomAuthPayloadV2>;
    const hasPublicKey = Object.prototype.hasOwnProperty.call(auth, "publicKey");
    return auth.v === ROOM_AUTH_VERSION &&
      auth.kdf === ROOM_AUTH_KDF_ID &&
      typeof auth.challenge === "string" &&
      fromBase64Url(auth.challenge, 32) !== null &&
      typeof auth.proof === "string" &&
      fromBase64Url(auth.proof, 64) !== null &&
      (!hasPublicKey ||
        (typeof auth.publicKey === "string" && fromBase64Url(auth.publicKey, 32) !== null));
  } catch {
    return false;
  }
}

export async function verifyRoomAuthProof(options: {
  auth: RoomAuthPayloadV2;
  action: RoomAuthAction;
  roomId: string;
  name: string;
  expectedChallenge: string;
  storedPublicKey?: string | null;
}): Promise<boolean> {
  const { auth, action, roomId, name, expectedChallenge, storedPublicKey } = options;
  if (!normalizeAuthName(name) || !validRoomAuthPayload(auth) || auth.challenge !== expectedChallenge) return false;

  const publicKey = action === "set-up" ? auth.publicKey : storedPublicKey;
  if (!publicKey) return false;
  if (action !== "set-up" && auth.publicKey !== undefined) return false;

  const signatureBytes = fromBase64Url(auth.proof, 64);
  const publicKeyBytes = fromBase64Url(publicKey, 32);
  if (!signatureBytes || !publicKeyBytes) return false;

  try {
    return await verifyAsync(
      signatureBytes,
      roomAuthProofBytes(action, roomId, name, auth.challenge, publicKey),
      publicKeyBytes,
      { zip215: false }
    );
  } catch {
    return false;
  }
}
