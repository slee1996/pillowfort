const ROOM_SECRET_PREFIX = "pf2_";
const GENERATED_SECRET_BYTES = 32;
// A 32-byte unpadded base64url value has 43 characters and 16 valid
// canonical final characters (the other two low bits must be zero padding).
const GENERATED_SECRET_RE = /^pf2_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export type RoomSecretValidation =
  | { valid: true; secret: string }
  | { valid: false; message: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

export function validateRoomSecret(value: string): RoomSecretValidation {
  const secret = value.trim();
  if (!GENERATED_SECRET_RE.test(secret)) {
    return {
      valid: false,
      message: "Use the secure generated room secret (pf2_ followed by 43 characters).",
    };
  }
  return { valid: true, secret };
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
