import { describe, expect, spyOn, test } from "bun:test";
import { deriveParticipantKey } from "../src/participant/keyDerivation";

const utf8 = new TextEncoder();

describe("production participant key derivation", () => {
  test("preserves the exact 600,000-iteration key when the provider caps native PBKDF2", async () => {
    const password = utf8.encode("pillowfort-test-π");
    const salt = utf8.encode("pillowfort:v4:fixed-salt");
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const expected = new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-256", iterations: 600_000, salt,
    }, key, 256));
    const limited = spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new DOMException(
      "Iteration counts above 100000 are not supported", "NotSupportedError",
    ));
    try {
      expect(await deriveParticipantKey(password, salt)).toEqual(expected);
    } finally {
      limited.mockRestore();
      password.fill(0);
      expected.fill(0);
    }
  });

  test("does not turn an operational crypto failure into a different derivation path", async () => {
    const failure = new DOMException("Synthetic cryptographic operation failure", "OperationError");
    const failed = spyOn(crypto.subtle, "deriveBits").mockRejectedValue(failure);
    try {
      await expect(deriveParticipantKey(utf8.encode("test"), utf8.encode("salt"))).rejects.toBe(failure);
    } finally {
      failed.mockRestore();
    }
  });
});
