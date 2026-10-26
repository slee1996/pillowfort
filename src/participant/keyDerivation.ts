import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Protocol-v4 work factor and output are identical on browsers and Workers. */
export async function deriveParticipantKey(
  password: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  try {
    return new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt,
    }, key, 256));
  } catch (error) {
    // Production Workers cap native PBKDF2 at 100,000 iterations. Do not lower
    // the protocol work factor; use the same PBKDF2-HMAC-SHA256 in portable code.
    // Other cryptographic failures remain failures, never an alternate identity.
    if (!(error instanceof Error) || error.name !== "NotSupportedError") throw error;
    return pbkdf2Async(sha256, password, salt, { c: 600_000, dkLen: 32 });
  }
}
