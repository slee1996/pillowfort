import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  ROOM_AUTH_KDF_ID,
  ROOM_AUTH_VERSION,
  fromBase64Url,
  roomAuthProofBytes,
  toBase64Url,
  type RoomAuthAction,
} from "../../../src/roomAuth";
import { STYLE_COLORS } from "../../../src/shared";
import type { ChatStyle, EncryptedChatPayload, RoomAuthPayload } from "./protocol";
import {
  CryptoStateStore,
  deriveCryptoRoomInstance,
  type LegacyReplayMigrationInput,
  type ReplayAdvanceResult,
  type ReplayPosition,
} from "./cryptoStateStore";

const KEY_CACHE = new Map<string, Promise<CryptoKey>>();
const AUTH_SEED_CACHE = new Map<string, Promise<Uint8Array>>();
const SEND_SEQUENCES = new Map<string, number>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PBKDF2_ITERATIONS = 600_000;
const KDF_ID = "pbkdf2-sha256-600k-v1" as const;
const REPLAY_STORAGE_KEY = "pillowfort-chat-replay-v1";

let senderSessionId: string | null = null;
let replayStore: ChatReplayStateStore | null = null;
let replayStoreOverride: ChatReplayStateStore | null | undefined;
let replayStateFailure: ChatCryptoStateError | null = null;
const ROOM_INSTANCE_CACHE = new Map<string, Promise<string>>();
const REPLAY_MIGRATIONS = new Map<string, Promise<void>>();

interface EncryptedChatBodyV3 {
  t: string;
  s?: ChatStyle;
  sid: string;
  seq: number;
}

export interface DecryptedChatPayload {
  text: string;
  style?: ChatStyle;
}

export interface ChatReplayStateStore {
  advanceReplay(position: ReplayPosition): Promise<ReplayAdvanceResult>;
  migrateLegacyReplayLedger(input: LegacyReplayMigrationInput): Promise<unknown>;
}

export class ChatCryptoStateError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ChatCryptoStateError";
    this.cause = cause;
  }
}

interface CryptoLike {
  subtle?: SubtleCrypto;
  webkitSubtle?: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function getCryptoLike(): CryptoLike | null {
  const candidate = (globalThis as { crypto?: CryptoLike }).crypto;
  return candidate || null;
}

function getSubtle(): SubtleCrypto | null {
  const candidate = getCryptoLike();
  if (!candidate) return null;
  return candidate.subtle || candidate.webkitSubtle || null;
}

function hasSubtleCrypto(): boolean {
  return !!getSubtle();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function digestBase64Url(bytes: Uint8Array): Promise<string> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("subtle-unavailable");
  const hash = await subtle.digest("SHA-256", asArrayBuffer(bytes));
  return toBase64Url(new Uint8Array(hash));
}

function getSenderSessionId(): string {
  if (senderSessionId) return senderSessionId;
  const candidate = getCryptoLike();
  if (!candidate) throw new Error("crypto-unavailable");
  senderSessionId = toBase64Url(candidate.getRandomValues(new Uint8Array(16)));
  return senderSessionId;
}

async function deriveRoomKey(roomId: string, password: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("subtle-unavailable");
  const cacheKey = `${roomId}\u0000chat-v3\u0000${password}`;
  const existing = KEY_CACHE.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const baseKey = await subtle.importKey(
      "raw",
      textEncoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: textEncoder.encode(`pillowfort:chat-v3:${roomId}`),
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  })();

  KEY_CACHE.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    KEY_CACHE.delete(cacheKey);
    throw error;
  }
}

async function deriveRoomAuthSeed(roomId: string, password: string): Promise<Uint8Array> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("subtle-unavailable");
  const cacheKey = `${roomId}\u0000auth-sign-v2\u0000${password}`;
  const existing = AUTH_SEED_CACHE.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const baseKey = await subtle.importKey(
      "raw",
      textEncoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: textEncoder.encode(`pillowfort:auth-sign-v2:${roomId}`),
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      256
    );
    return new Uint8Array(bits);
  })();

  AUTH_SEED_CACHE.set(cacheKey, promise);
  try {
    return await promise;
  } catch (error) {
    AUTH_SEED_CACHE.delete(cacheKey);
    throw error;
  }
}

function aadFor(roomId: string, sender: string, sessionId: string, seq: number): Uint8Array {
  return textEncoder.encode(`pf-e2ee:v3:${roomId}:${sender}:${sessionId}:${seq}`);
}

function getReplayStore(): ChatReplayStateStore {
  if (replayStoreOverride !== undefined) {
    if (!replayStoreOverride) throw new ChatCryptoStateError("durable replay storage is unavailable");
    return replayStoreOverride;
  }
  if (!replayStore) replayStore = new CryptoStateStore();
  return replayStore;
}

async function roomAuthenticationPublicKey(roomId: string, password: string): Promise<string> {
  const seed = await deriveRoomAuthSeed(roomId, password);
  return toBase64Url(await getPublicKeyAsync(seed));
}

export async function chatCryptoRoomInstance(roomId: string, password: string): Promise<string> {
  const cacheKey = `${roomId}\u0000${password}`;
  const existing = ROOM_INSTANCE_CACHE.get(cacheKey);
  if (existing) return existing;
  const pending = (async () => deriveCryptoRoomInstance(
    roomId,
    await roomAuthenticationPublicKey(roomId, password),
  ))();
  ROOM_INSTANCE_CACHE.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    ROOM_INSTANCE_CACHE.delete(cacheKey);
    throw error;
  }
}

function readLegacyReplayLedger(): string {
  try {
    if (typeof sessionStorage === "undefined") {
      throw new Error("session-storage-unavailable");
    }
    return sessionStorage.getItem(REPLAY_STORAGE_KEY) || JSON.stringify({ v: 1, entries: [] });
  } catch (error) {
    throw new ChatCryptoStateError("legacy replay state could not be inspected", error);
  }
}

async function migrateReplayState(store: ChatReplayStateStore, roomId: string, roomInstance: string): Promise<void> {
  const existing = REPLAY_MIGRATIONS.get(roomInstance);
  if (existing) return existing;
  const pending = store.migrateLegacyReplayLedger({
    roomId,
    roomInstance,
    rawLedger: readLegacyReplayLedger(),
  }).then(() => undefined);
  REPLAY_MIGRATIONS.set(roomInstance, pending);
  try {
    await pending;
  } catch (error) {
    REPLAY_MIGRATIONS.delete(roomInstance);
    throw error;
  }
}

async function trackSequence(
  roomId: string,
  password: string,
  sender: string,
  sessionId: string,
  seq: number,
): Promise<boolean> {
  if (replayStateFailure) throw replayStateFailure;
  try {
    const store = getReplayStore();
    const roomInstance = await chatCryptoRoomInstance(roomId, password);
    await migrateReplayState(store, roomId, roomInstance);
    const result = await store.advanceReplay({
      roomInstance,
      senderId: sender,
      sessionId,
      sequence: seq,
    });
    return result.accepted;
  } catch (error) {
    const failure = error instanceof ChatCryptoStateError
      ? error
      : new ChatCryptoStateError("durable replay state failed; message delivery is blocked", error);
    replayStateFailure = failure;
    throw failure;
  }
}

/** Explicit dependency injection for deterministic unit tests; production uses IndexedDB. */
export function setChatReplayStateStoreForTests(store: ChatReplayStateStore | null | undefined): void {
  replayStoreOverride = store;
  replayStateFailure = null;
  ROOM_INSTANCE_CACHE.clear();
  REPLAY_MIGRATIONS.clear();
}

function sanitizeStyleInput(style?: ChatStyle): ChatStyle | undefined {
  if (!style) return undefined;
  const sanitized: ChatStyle = {};
  if (style.bold) sanitized.bold = true;
  if (style.italic) sanitized.italic = true;
  if (style.underline) sanitized.underline = true;
  if (typeof style.color === "string" && STYLE_COLORS.has(style.color)) sanitized.color = style.color;
  return Object.keys(sanitized).length ? sanitized : undefined;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function encryptChatPayload(
  roomId: string,
  password: string,
  sender: string,
  text: string,
  style?: ChatStyle
): Promise<EncryptedChatPayload | null> {
  const subtle = getSubtle();
  const candidate = getCryptoLike();
  if (!subtle || !candidate || !text.trim()) return null;

  const key = await deriveRoomKey(roomId, password);
  const iv = candidate.getRandomValues(new Uint8Array(12));
  const sid = getSenderSessionId();
  const sequenceKey = `${roomId}\u0000${sender}\u0000${sid}`;
  const seq = (SEND_SEQUENCES.get(sequenceKey) || 0) + 1;
  SEND_SEQUENCES.set(sequenceKey, seq);

  const body: EncryptedChatBodyV3 = { t: text.slice(0, 2_000), sid, seq };
  const sanitizedStyle = sanitizeStyleInput(style);
  if (sanitizedStyle) body.s = sanitizedStyle;
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aadFor(roomId, sender, sid, seq)) },
    key,
    textEncoder.encode(JSON.stringify(body))
  );
  return {
    v: 3,
    kdf: KDF_ID,
    sid,
    seq,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(cipher)),
  };
}

export async function decryptChatPayload(
  roomId: string,
  password: string,
  sender: string,
  payload: EncryptedChatPayload
): Promise<DecryptedChatPayload | null> {
  const subtle = getSubtle();
  if (!subtle || !payload || payload.v !== 3 || payload.kdf !== KDF_ID) return null;
  if (typeof payload.sid !== "string" || payload.sid.length < 16 || payload.sid.length > 64) return null;
  if (!Number.isSafeInteger(payload.seq) || payload.seq < 1) return null;
  if (typeof payload.iv !== "string" || typeof payload.ct !== "string" || payload.ct.length > 4_096) return null;

  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ct);
  if (!iv || !ciphertext || iv.length !== 12 || ciphertext.length === 0) return null;

  let verified: Partial<EncryptedChatBodyV3>;
  try {
    const key = await deriveRoomKey(roomId, password);
    const plain = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(iv),
        additionalData: asArrayBuffer(aadFor(roomId, sender, payload.sid, payload.seq)),
      },
      key,
      asArrayBuffer(ciphertext)
    );
    verified = JSON.parse(textDecoder.decode(plain)) as Partial<EncryptedChatBodyV3>;
  } catch {
    return null;
  }
  if (!verified || typeof verified.t !== "string") return null;
  if (verified.sid !== payload.sid || verified.seq !== payload.seq) return null;
  if (!await trackSequence(roomId, password, sender, payload.sid, payload.seq)) return null;
  return {
    text: verified.t.slice(0, 2_000),
    style: sanitizeStyleInput(verified.s),
  };
}

export function clearChatCryptoState() {
  KEY_CACHE.clear();
  AUTH_SEED_CACHE.clear();
  SEND_SEQUENCES.clear();
  ROOM_INSTANCE_CACHE.clear();
  senderSessionId = null;
}

export function isChatCryptoAvailable(): boolean {
  return hasSubtleCrypto();
}

export async function createRoomAuthPayload(
  roomId: string,
  password: string,
  challenge: string,
  action: RoomAuthAction,
  name: string
): Promise<RoomAuthPayload> {
  if (!fromBase64Url(challenge, 32)) throw new Error("invalid-auth-challenge");
  const seed = await deriveRoomAuthSeed(roomId, password);
  const publicKey = toBase64Url(await getPublicKeyAsync(seed));
  const proof = toBase64Url(await signAsync(
    roomAuthProofBytes(action, roomId, name, challenge, publicKey),
    seed
  ));
  return {
    v: ROOM_AUTH_VERSION,
    kdf: ROOM_AUTH_KDF_ID,
    challenge,
    proof,
    ...(action === "set-up" ? { publicKey } : {}),
  };
}

export async function roomSafetyCode(roomId: string, password: string): Promise<string | null> {
  try {
    const key = await deriveRoomKey(roomId, password);
    const raw = await crypto.subtle.exportKey("raw", key);
    const digest = await digestBase64Url(new Uint8Array(raw));
    return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
  } catch {
    return null;
  }
}
