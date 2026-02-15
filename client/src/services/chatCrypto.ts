import type { ChatStyle, EncryptedChatPayload } from "./protocol";

const KEY_CACHE = new Map<string, Promise<CryptoKey>>();
const RECENT_NONCES = new Map<string, number>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PBKDF2_ITERATIONS = 120_000;
const RECENT_NONCE_LIMIT = 2000;
const RECENT_NONCE_TTL_MS = 10 * 60 * 1000;

interface EncryptedChatBodyV2 {
  t: string;
  s?: ChatStyle;
}

export interface DecryptedChatPayload {
  text: string;
  style?: ChatStyle;
}

interface CryptoLike {
  subtle?: SubtleCrypto;
  webkitSubtle?: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function getCryptoLike(): CryptoLike | null {
  const c = (globalThis as any).crypto as CryptoLike | undefined;
  return c || null;
}

function getSubtle(): SubtleCrypto | null {
  const c = getCryptoLike();
  if (!c) return null;
  return c.subtle || c.webkitSubtle || null;
}

function hasSubtleCrypto(): boolean {
  return !!getSubtle();
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function deriveRoomKey(roomId: string, password: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  if (!subtle) throw new Error("subtle-unavailable");
  const cacheKey = `${roomId}\u0000${password}`;
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
        salt: textEncoder.encode(`pillowfort-e2ee:${roomId}`),
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  })();

  KEY_CACHE.set(cacheKey, promise);
  try {
    return await promise;
  } catch (err) {
    KEY_CACHE.delete(cacheKey);
    throw err;
  }
}

function aadFor(roomId: string, sender: string): Uint8Array {
  return textEncoder.encode(`pf-e2ee:v2:${roomId}:${sender}`);
}

function trackNonce(roomId: string, sender: string, iv: string): boolean {
  const now = Date.now();
  for (const [key, ts] of RECENT_NONCES) {
    if (now - ts > RECENT_NONCE_TTL_MS) RECENT_NONCES.delete(key);
  }
  const key = `${roomId}\u0000${sender}\u0000${iv}`;
  if (RECENT_NONCES.has(key)) return false;
  RECENT_NONCES.set(key, now);
  if (RECENT_NONCES.size > RECENT_NONCE_LIMIT) {
    const first = RECENT_NONCES.keys().next().value;
    if (first) RECENT_NONCES.delete(first);
  }
  return true;
}

function sanitizeStyleInput(style?: ChatStyle): ChatStyle | undefined {
  if (!style) return undefined;
  const out: ChatStyle = {};
  if (style.bold) out.bold = true;
  if (style.italic) out.italic = true;
  if (style.underline) out.underline = true;
  if (typeof style.color === "string") out.color = style.color;
  return Object.keys(out).length ? out : undefined;
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
  const c = getCryptoLike();
  if (!subtle || !c) return null;
  if (!text.trim()) return null;
  const key = await deriveRoomKey(roomId, password);
  const iv = c.getRandomValues(new Uint8Array(12));
  const body: EncryptedChatBodyV2 = { t: text.slice(0, 2000) };
  const sanitizedStyle = sanitizeStyleInput(style);
  if (sanitizedStyle) body.s = sanitizedStyle;
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aadFor(roomId, sender)) },
    key,
    textEncoder.encode(JSON.stringify(body))
  );
  return { v: 2, iv: toBase64(iv), ct: toBase64(new Uint8Array(cipher)) };
}

export async function decryptChatPayload(
  roomId: string,
  password: string,
  sender: string,
  payload: EncryptedChatPayload,
  legacyStyle?: ChatStyle
): Promise<DecryptedChatPayload | null> {
  const subtle = getSubtle();
  if (!subtle) return null;
  if (!payload || (payload.v !== 1 && payload.v !== 2)) return null;
  const iv = fromBase64(payload.iv);
  const ct = fromBase64(payload.ct);
  if (!iv || !ct || iv.length !== 12 || ct.length === 0) return null;

  if (!trackNonce(roomId, sender, payload.iv)) return null;

  try {
    const key = await deriveRoomKey(roomId, password);
    const plain = await subtle.decrypt(
      payload.v === 2
        ? { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aadFor(roomId, sender)) }
        : { name: "AES-GCM", iv: asArrayBuffer(iv) },
      key,
      asArrayBuffer(ct)
    );
    const decoded = textDecoder.decode(plain);

    if (payload.v === 1) {
      return { text: decoded.slice(0, 2000), style: sanitizeStyleInput(legacyStyle) };
    }

    const parsed = JSON.parse(decoded) as EncryptedChatBodyV2;
    if (!parsed || typeof parsed.t !== "string") return null;
    return {
      text: parsed.t.slice(0, 2000),
      style: sanitizeStyleInput(parsed.s),
    };
  } catch {
    return null;
  }
}

export function clearChatCryptoState() {
  KEY_CACHE.clear();
  RECENT_NONCES.clear();
}

export function isChatCryptoAvailable(): boolean {
  return hasSubtleCrypto();
}
