import { MAX_MLS_RELAY_PAYLOAD_BYTES } from "./protocolV4";

const UTF8 = new TextEncoder();
const BUNDLE_MAGIC = UTF8.encode("PFADMV41");
const LENGTH_BYTES = 4;
const HEADER_BYTES = BUNDLE_MAGIC.byteLength + LENGTH_BYTES * 2;

export const SECURE_ADMISSION_BUNDLE_MAGIC_V4 = "PFADMV41" as const;
export const SECURE_ADMISSION_BUNDLE_HEADER_BYTES_V4 = HEADER_BYTES;

export interface SecureAdmissionBundleV4 {
  welcome: Uint8Array;
  ratchetTree: Uint8Array;
}

function validBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength > 0;
}

function addIsSafe(...values: number[]): boolean {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || total > Number.MAX_SAFE_INTEGER - value) return false;
    total += value;
  }
  return true;
}

/**
 * Encode the two MLS admission artifacts into one unambiguous relay payload.
 * Both lengths are unsigned, network-byte-order u32 values and the aggregate
 * is subject to the same 64 KiB limit as every other opaque relay payload.
 */
export function encodeSecureAdmissionBundleV4(
  welcome: Uint8Array,
  ratchetTree: Uint8Array,
): Uint8Array {
  if (!validBytes(welcome) || !validBytes(ratchetTree) ||
      !addIsSafe(HEADER_BYTES, welcome.byteLength, ratchetTree.byteLength)) {
    throw new TypeError("invalid MLS admission artifacts");
  }
  const total = HEADER_BYTES + welcome.byteLength + ratchetTree.byteLength;
  if (total > MAX_MLS_RELAY_PAYLOAD_BYTES) {
    throw new RangeError("MLS admission bundle exceeds the relay payload limit");
  }

  const output = new Uint8Array(total);
  output.set(BUNDLE_MAGIC, 0);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  view.setUint32(BUNDLE_MAGIC.byteLength, welcome.byteLength, false);
  view.setUint32(BUNDLE_MAGIC.byteLength + LENGTH_BYTES, ratchetTree.byteLength, false);
  output.set(welcome, HEADER_BYTES);
  output.set(ratchetTree, HEADER_BYTES + welcome.byteLength);
  return output;
}

/** Decode only the exact canonical bundle: no empty fields or trailing bytes. */
export function decodeSecureAdmissionBundleV4(value: unknown): SecureAdmissionBundleV4 | null {
  if (!(value instanceof Uint8Array) || value.byteLength < HEADER_BYTES + 2 ||
      value.byteLength > MAX_MLS_RELAY_PAYLOAD_BYTES) return null;
  for (let index = 0; index < BUNDLE_MAGIC.byteLength; index++) {
    if (value[index] !== BUNDLE_MAGIC[index]) return null;
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const welcomeLength = view.getUint32(BUNDLE_MAGIC.byteLength, false);
  const treeLength = view.getUint32(BUNDLE_MAGIC.byteLength + LENGTH_BYTES, false);
  if (welcomeLength < 1 || treeLength < 1 || !addIsSafe(HEADER_BYTES, welcomeLength, treeLength)) return null;
  const expectedLength = HEADER_BYTES + welcomeLength + treeLength;
  if (expectedLength !== value.byteLength) return null;
  return {
    welcome: value.slice(HEADER_BYTES, HEADER_BYTES + welcomeLength),
    ratchetTree: value.slice(HEADER_BYTES + welcomeLength),
  };
}
