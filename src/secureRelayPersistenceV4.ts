import { normalizeRoomId } from "./entitlements";
import { canonicalBase64UrlByteLength } from "./protocolV4";
import {
  MAX_SECURE_RELAY_STATE_BYTES_V4,
  exportSecureRelayStateV4,
  importSecureRelayStateV4,
  type SecureRelayStateV4,
} from "./secureRelayV4";

export const SECURE_RELAY_MANIFEST_KEY_V4 = "secureRelayManifestV4";
export const SECURE_RELAY_PERSISTENCE_SCHEMA_V4 = "pillowfort-secure-relay-persistence-v4" as const;

// Legacy KV-backed Durable Objects cap one value at 128 KiB. Relay snapshots
// can legitimately be larger because disconnected devices have bounded opaque
// backlogs, so snapshots are split into transactionally-swapped 96 KiB values.
export const SECURE_RELAY_CHUNK_CHARS_V4 = 96 * 1024;
export const MAX_SECURE_RELAY_CHUNKS_V4 = Math.ceil(MAX_SECURE_RELAY_STATE_BYTES_V4 / SECURE_RELAY_CHUNK_CHARS_V4) + 1;

export interface SecureRelayPersistenceManifestV4 {
  schema: typeof SECURE_RELAY_PERSISTENCE_SCHEMA_V4;
  generation: 0 | 1;
  chunkCount: number;
  byteLength: number;
  stateRevision: number;
  sha256: string;
  roomId: string;
  roomAuthPublicKey: string;
}

export interface PreparedSecureRelayPersistenceV4 {
  manifest: SecureRelayPersistenceManifestV4;
  chunks: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
      && Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !!descriptor && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(required);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === "string" && allowed.has(key));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function persistenceDigestInput(roomId: string, roomAuthPublicKey: string, serializedState: string): string {
  return JSON.stringify([
    SECURE_RELAY_PERSISTENCE_SCHEMA_V4,
    roomId,
    roomAuthPublicKey,
    serializedState,
  ]);
}

export function secureRelayChunkKeyV4(generation: 0 | 1, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_SECURE_RELAY_CHUNKS_V4) {
    throw new RangeError("secure relay chunk index is out of range");
  }
  return `secureRelayV4:${generation}:${index}`;
}

export function parseSecureRelayPersistenceManifestV4(
  value: unknown,
): SecureRelayPersistenceManifestV4 | null {
  const keys = [
    "schema", "generation", "chunkCount", "byteLength", "stateRevision", "sha256", "roomId", "roomAuthPublicKey",
  ];
  if (!isPlainRecord(value) || !hasExactKeys(value, keys)
    || value.schema !== SECURE_RELAY_PERSISTENCE_SCHEMA_V4
    || (value.generation !== 0 && value.generation !== 1)
    || !Number.isSafeInteger(value.chunkCount) || (value.chunkCount as number) < 1
    || (value.chunkCount as number) > MAX_SECURE_RELAY_CHUNKS_V4
    || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 1
    || (value.byteLength as number) > MAX_SECURE_RELAY_STATE_BYTES_V4
    || !Number.isSafeInteger(value.stateRevision) || (value.stateRevision as number) < 1
    || canonicalBase64UrlByteLength(value.sha256) !== 32
    || typeof value.roomId !== "string" || normalizeRoomId(value.roomId) !== value.roomId
    || canonicalBase64UrlByteLength(value.roomAuthPublicKey) !== 32) return null;
  return {
    schema: SECURE_RELAY_PERSISTENCE_SCHEMA_V4,
    generation: value.generation,
    chunkCount: value.chunkCount as number,
    byteLength: value.byteLength as number,
    stateRevision: value.stateRevision as number,
    sha256: value.sha256 as string,
    roomId: value.roomId,
    roomAuthPublicKey: value.roomAuthPublicKey as string,
  };
}

export async function prepareSecureRelayPersistenceV4(options: {
  roomId: string;
  roomAuthPublicKey: string;
  state: SecureRelayStateV4;
  generation: 0 | 1;
}): Promise<PreparedSecureRelayPersistenceV4> {
  if (normalizeRoomId(options.roomId) !== options.roomId
    || canonicalBase64UrlByteLength(options.roomAuthPublicKey) !== 32
    || (options.generation !== 0 && options.generation !== 1)) {
    throw new TypeError("invalid secure relay persistence context");
  }
  const serialized = exportSecureRelayStateV4(options.state);
  // Relay snapshots contain only strict JSON keys and canonical base64url, so
  // every code unit is one UTF-8 byte. Refuse future schema drift that breaks
  // that invariant rather than splitting inside a multibyte character.
  if (!/^[\x20-\x7e]+$/u.test(serialized)) {
    throw new Error("secure relay snapshot is not canonical ASCII");
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < serialized.length; offset += SECURE_RELAY_CHUNK_CHARS_V4) {
    chunks.push(serialized.slice(offset, offset + SECURE_RELAY_CHUNK_CHARS_V4));
  }
  if (chunks.length < 1 || chunks.length > MAX_SECURE_RELAY_CHUNKS_V4) {
    throw new Error("secure relay snapshot exceeds chunk bound");
  }
  return {
    manifest: {
      schema: SECURE_RELAY_PERSISTENCE_SCHEMA_V4,
      generation: options.generation,
      chunkCount: chunks.length,
      byteLength: serialized.length,
      stateRevision: options.state.revision,
      sha256: await sha256Base64Url(persistenceDigestInput(
        options.roomId,
        options.roomAuthPublicKey,
        serialized,
      )),
      roomId: options.roomId,
      roomAuthPublicKey: options.roomAuthPublicKey,
    },
    chunks,
  };
}

export async function restoreSecureRelayPersistenceV4(
  manifestValue: unknown,
  chunkValues: readonly unknown[],
): Promise<{ manifest: SecureRelayPersistenceManifestV4; state: SecureRelayStateV4 } | null> {
  const manifest = parseSecureRelayPersistenceManifestV4(manifestValue);
  if (!manifest || chunkValues.length !== manifest.chunkCount
    || chunkValues.some((chunk) => typeof chunk !== "string"
      || chunk.length < 1 || chunk.length > SECURE_RELAY_CHUNK_CHARS_V4
      || !/^[\x20-\x7e]+$/u.test(chunk))) return null;
  const serialized = (chunkValues as readonly string[]).join("");
  if (serialized.length !== manifest.byteLength
    || await sha256Base64Url(persistenceDigestInput(
      manifest.roomId,
      manifest.roomAuthPublicKey,
      serialized,
    )) !== manifest.sha256) return null;
  const state = importSecureRelayStateV4(serialized);
  if (!state || state.revision !== manifest.stateRevision) return null;
  return { manifest, state };
}
