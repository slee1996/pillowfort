import { describe, expect, test } from "bun:test";
import {
  SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4,
  decodeSecureAdmissionBundleV4,
  encodeSecureAdmissionBundleV4,
} from "../src/admissionBundleV4";
import { MAX_MLS_RELAY_PAYLOAD_BYTES } from "../src/protocolV4";

describe("protocol-v4 MLS admission bundle", () => {
  test("round-trips distinct Welcome and ratchet-tree bytes", () => {
    const welcome = crypto.getRandomValues(new Uint8Array(257));
    const tree = crypto.getRandomValues(new Uint8Array(509));
    const encoded = encodeSecureAdmissionBundleV4(welcome, tree);
    const decoded = decodeSecureAdmissionBundleV4(encoded);
    expect(decoded?.welcome).toEqual(welcome);
    expect(decoded?.ratchetTree).toEqual(tree);

    decoded!.welcome.fill(0);
    expect(encoded.slice(SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4, SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4 + welcome.length)).toEqual(welcome);
  });

  test("rejects empty, truncated, length-confused, and trailing bundles", () => {
    expect(() => encodeSecureAdmissionBundleV4(new Uint8Array(), new Uint8Array([1]))).toThrow();
    expect(() => encodeSecureAdmissionBundleV4(new Uint8Array([1]), new Uint8Array())).toThrow();

    const encoded = encodeSecureAdmissionBundleV4(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]));
    for (let length = 0; length < encoded.length; length++) {
      expect(decodeSecureAdmissionBundleV4(encoded.slice(0, length))).toBeNull();
    }
    const confused = encoded.slice();
    new DataView(confused.buffer).setUint32(8, 4, false);
    expect(decodeSecureAdmissionBundleV4(confused)).toBeNull();

    const trailing = new Uint8Array(encoded.length + 1);
    trailing.set(encoded);
    expect(decodeSecureAdmissionBundleV4(trailing)).toBeNull();
    const wrongMagic = encoded.slice();
    wrongMagic[0] ^= 1;
    expect(decodeSecureAdmissionBundleV4(wrongMagic)).toBeNull();
  });

  test("enforces the aggregate relay payload limit", () => {
    const maximumWelcome = new Uint8Array(MAX_MLS_RELAY_PAYLOAD_BYTES - SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4 - 1);
    expect(encodeSecureAdmissionBundleV4(maximumWelcome, new Uint8Array([1]))).toHaveLength(MAX_MLS_RELAY_PAYLOAD_BYTES);
    expect(() => encodeSecureAdmissionBundleV4(
      new Uint8Array(MAX_MLS_RELAY_PAYLOAD_BYTES - SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4),
      new Uint8Array([1]),
    )).toThrow(RangeError);
  });
});
