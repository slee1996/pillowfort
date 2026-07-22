import { normalizeRoomId } from "../../../src/entitlements";
import { SECURE_ROOM_ID_BYTES, canonicalBase64UrlByteLength } from "../../../src/protocolV4";

const ROOM_SECRET_PREFIX = "pf2_";
const GENERATED_SECRET_BYTES = 32;
export const CUSTOM_ROOM_SECRET_MIN_LENGTH = 15;
export const CUSTOM_ROOM_SECRET_MAX_LENGTH = 64;
export const CUSTOM_ROOM_SECRET_MAX_UTF8_BYTES = 256;
export const CUSTOM_ROOM_SECRET_KDF = "pbkdf2-sha256-600k-room-v1" as const;
const CUSTOM_ROOM_SECRET_KDF_ITERATIONS = 600_000;
const CUSTOM_ROOM_SECRET_KDF_DOMAIN = "pillowfort:custom-room-secret:v1";
// A 32-byte unpadded base64url value has 43 characters and 16 valid
// canonical final characters (the other two low bits must be zero padding).
const GENERATED_SECRET_RE = /^pf2_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const UNSAFE_CUSTOM_SECRET_RE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]/u;
const NON_ASCII_SEPARATOR_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;
const COMMON_CUSTOM_SECRET_PARTS = [
  "password", "pillowfort", "letmein", "qwerty", "welcome", "changeme", "admin", "monkey",
  "dragon", "football", "baseball", "sunshine", "princess", "iloveyou", "trustno1", "master",
  "correcthorsebatterystaple", "spring", "summer", "autumn", "winter",
] as const;
const OBVIOUS_SEQUENCES = [
  "0123456789", "9876543210", "abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba",
  "qwertyuiopasdfghjklzxcvbnm", "mnbvcxzlkjhgfdsaqpoiuytrewq",
] as const;
const UTF8 = new TextEncoder();

export type RoomSecretValidation =
  | { valid: true; secret: string }
  | { valid: false; message: string };

export interface RoomSecretValidationOptions {
  context?: readonly string[];
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8Length(value: string): number {
  const bytes = UTF8.encode(value);
  try {
    return bytes.byteLength;
  } finally {
    bytes.fill(0);
  }
}

export function generateRoomSecret(): string {
  const bytes = new Uint8Array(GENERATED_SECRET_BYTES);
  try {
    crypto.getRandomValues(bytes);
    return ROOM_SECRET_PREFIX + base64Url(bytes);
  } finally {
    // The returned JavaScript string cannot be reliably zeroized, but the
    // mutable entropy buffer does not need to remain in memory as a second
    // copy after encoding.
    bytes.fill(0);
  }
}

export function isGeneratedRoomSecret(value: unknown): boolean {
  return typeof value === "string" && GENERATED_SECRET_RE.test(value);
}

function compactForStrength(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function isRepeatedPattern(value: string): boolean {
  for (let width = 1; width <= Math.min(16, Math.floor(value.length / 2)); width += 1) {
    if (value.length % width === 0 && value.slice(0, width).repeat(value.length / width) === value) return true;
  }
  return false;
}

function customSecretIsObviouslyWeak(secret: string, context: readonly string[]): boolean {
  const folded = secret.toLocaleLowerCase("en-US");
  const compact = compactForStrength(folded);
  if (new Set([...folded]).size < 6 || isRepeatedPattern(compact)) return true;
  if (COMMON_CUSTOM_SECRET_PARTS.some((part) => compact.includes(part))) return true;
  if (OBVIOUS_SEQUENCES.some((sequence) => {
    for (let start = 0; start <= sequence.length - 6; start += 1) {
      if (compact.includes(sequence.slice(start, start + 6))) return true;
    }
    return false;
  })) return true;
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  if (words.length > 1 && new Set(words).size !== words.length) return true;
  return context.some((candidate) => {
    const contextual = compactForStrength(candidate.normalize("NFC"));
    return contextual.length >= 3 && compact.includes(contextual);
  });
}

export function validateRoomSecret(value: unknown): RoomSecretValidation {
  if (typeof value !== "string") {
    return {
      valid: false,
      message: "Enter a room password.",
    };
  }

  if (value !== value.trim()) {
    return {
      valid: false,
      message: "Room passwords cannot start or end with whitespace.",
    };
  }

  if (isGeneratedRoomSecret(value)) return { valid: true, secret: value };
  if (value.startsWith(ROOM_SECRET_PREFIX)) {
    return {
      valid: false,
      message: "That generated room secret is incomplete or malformed.",
    };
  }

  const secret = value.normalize("NFC");
  if (UNSAFE_CUSTOM_SECRET_RE.test(secret) || NON_ASCII_SEPARATOR_RE.test(secret)) {
    return {
      valid: false,
      message: "Remove control or invisible characters from the room password.",
    };
  }

  const characterLength = [...secret].length;
  if (characterLength < CUSTOM_ROOM_SECRET_MIN_LENGTH) {
    return {
      valid: false,
      message: `Use at least ${CUSTOM_ROOM_SECRET_MIN_LENGTH} characters for a custom room password.`,
    };
  }
  if (characterLength > CUSTOM_ROOM_SECRET_MAX_LENGTH ||
      utf8Length(secret) > CUSTOM_ROOM_SECRET_MAX_UTF8_BYTES) {
    return {
      valid: false,
      message: `Use no more than ${CUSTOM_ROOM_SECRET_MAX_LENGTH} characters for a custom room password.`,
    };
  }

  return { valid: true, secret };
}

/** Custom-entry mode reserves the pf2_ namespace for app-generated secrets. */
export function validateCustomRoomSecret(
  value: unknown,
  options: RoomSecretValidationOptions = {},
): RoomSecretValidation {
  if (typeof value === "string" && value.startsWith(ROOM_SECRET_PREFIX)) {
    return {
      valid: false,
      message: "Use Generated for pf2_ room secrets, or choose a different custom password.",
    };
  }
  const validation = validateRoomSecret(value);
  if (!validation.valid) return validation;
  if (customSecretIsObviouslyWeak(validation.secret, options.context ?? [])) {
    return {
      valid: false,
      message: "Choose a less common room password with more varied characters.",
    };
  }
  return validation;
}

/**
 * Converts a human-authored password into the fixed-width, high-cost secret
 * material expected by protocol v4. Generated 256-bit secrets pass through so
 * existing rooms and invitations retain their exact cryptographic identity.
 */
export async function deriveProtocolRoomSecret(
  roomId: string,
  roomInstance: string,
  value: unknown,
): Promise<string> {
  if (normalizeRoomId(roomId) !== roomId) throw new TypeError("invalid canonical room id");
  if (canonicalBase64UrlByteLength(roomInstance) !== SECURE_ROOM_ID_BYTES) {
    throw new TypeError("invalid canonical room instance");
  }
  const validation = validateRoomSecret(value);
  if (!validation.valid) throw new TypeError(validation.message);
  const generated = isGeneratedRoomSecret(validation.secret);

  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("WebCrypto is required to protect a custom room password");
  const secretBytes = UTF8.encode(validation.secret);
  const saltBytes = UTF8.encode(JSON.stringify([
    CUSTOM_ROOM_SECRET_KDF_DOMAIN,
    CUSTOM_ROOM_SECRET_KDF,
    roomId,
    roomInstance,
  ]));
  let derived: Uint8Array | null = null;
  try {
    const inputKey = await crypto.subtle.importKey("raw", secretBytes, "PBKDF2", false, ["deriveBits"]);
    derived = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: CUSTOM_ROOM_SECRET_KDF_ITERATIONS,
      salt: saltBytes,
    }, inputKey, GENERATED_SECRET_BYTES * 8));
    // Generated credentials already contain 256 random bits and retain their
    // exact protocol identity. Running the same expensive derivation before
    // returning them prevents a relay from classifying weaker custom-password
    // rooms by challenge-to-authenticate latency alone.
    return generated ? validation.secret : ROOM_SECRET_PREFIX + base64Url(derived);
  } finally {
    secretBytes.fill(0);
    saltBytes.fill(0);
    derived?.fill(0);
  }
}

export function generateRoomId(): string {
  // Ten base32 symbols provide exactly 50 bits of uniformly sampled entropy.
  // Room existence is intentionally queryable, so generated identifiers must
  // be impractical to enumerate even when an attacker can make many probes.
  const bytes = new Uint8Array(10);
  try {
    crypto.getRandomValues(bytes);
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    return `f-${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
  } finally {
    bytes.fill(0);
  }
}

export function isCredentialSystemMessage(text: string): boolean {
  return /(?:^|[—|])\s*(?:password|secret password|room secret|secret)\s*(?:is\b|=|:)/i.test(text.trim());
}
