export const FORT_PASS_KIND = "fort-pass";
export const CUSTOM_ROOM_CODE_MIN_LEN = 4;
export const CUSTOM_ROOM_CODE_MAX_LEN = 10;
export const GENERATED_FREE_ROOM_ID_PREFIX = "f-";
export const GENERATED_FREE_ROOM_ID_SYMBOLS = 10;
export const FORT_PASS_EXTENDED_IDLE_MS = 6 * 60 * 60 * 1000;
export const FORT_PASS_MAX_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const FORT_PASS_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const FORT_PASS_CHECKOUT_SESSION_LIFETIME_MS = 31 * 60 * 1000;
export const FORT_PASS_RESERVATION_MS = 40 * 60 * 1000;
export const FORT_PASS_CLAIM_SECRET_BYTES = 32;

export type FortPassStatus = "active" | "refunded" | "expired";
export type FortPassProvider = "stripe" | "manual";
export type FortPassThemePack = "retro-plus";
export type RoomTheme = "away-message" | "campus-blue" | "top-8";

export interface FortPassPerks {
  customRoomCode?: string;
  extendedIdleMs?: number;
  themePack?: FortPassThemePack;
}

export interface FortPassEntitlement {
  v: 1;
  kind: typeof FORT_PASS_KIND;
  status: FortPassStatus;
  roomId: string;
  hostRef: string;
  provider: FortPassProvider;
  providerRef: string;
  createdAt: number;
  expiresAt: number;
  perks: FortPassPerks;
}

export type CustomRoomCodeAvailabilityReason = "invalid" | "taken";

export interface CustomRoomCodeAvailability {
  code: string | null;
  available: boolean;
  reason?: CustomRoomCodeAvailabilityReason;
}

export interface FortPassCheckoutRequest {
  customRoomCode: string;
  claimHash: string;
}

const RESERVED_ROOM_CODES = new Set([
  "admin",
  "analytics",
  "api",
  "app",
  "activity",
  "asset",
  "assets",
  "billing",
  "checkout",
  "help",
  "home",
  "index",
  "join",
  "login",
  "logout",
  "privacy",
  "room",
  "rooms",
  "setup",
  "static",
  "support",
  "terms",
  "ws",
]);

const TOKEN_RE = /^[a-zA-Z0-9_:-]{1,128}$/;
const ROOM_CODE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GENERATED_FREE_ROOM_ID_RE = /^f-[a-z2-7]{10}$/u;
const STRIPE_CHECKOUT_SESSION_ID_RE = /^cs_(?:test_|live_)?[A-Za-z0-9_]{3,255}$/u;
const FORT_PASS_CLAIM_SECRET_RE = /^[a-f0-9]{64}$/u;
const RETRO_PLUS_THEMES = new Set<RoomTheme>(["campus-blue", "top-8"]);

function cleanToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}

function cleanTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const timestamp = Math.trunc(value);
  if (timestamp < 0) return null;
  return timestamp;
}

export function isReservedRoomCode(code: string): boolean {
  return RESERVED_ROOM_CODES.has(code);
}

export function normalizeCustomRoomCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.trim().toLowerCase();
  // The complete f- namespace is reserved for server-recognizable free room
  // capabilities. A paid vanity code must never be confusable with one.
  if (code.startsWith(GENERATED_FREE_ROOM_ID_PREFIX)) return null;
  if (code.length < CUSTOM_ROOM_CODE_MIN_LEN || code.length > CUSTOM_ROOM_CODE_MAX_LEN) return null;
  if (!ROOM_CODE_RE.test(code)) return null;
  if (code.includes("--")) return null;
  if (isReservedRoomCode(code)) return null;
  return code;
}

export function isGeneratedFreeRoomId(input: unknown): input is string {
  return typeof input === "string" && GENERATED_FREE_ROOM_ID_RE.test(input);
}

export function normalizeRoomId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const roomId = input.trim().toLowerCase();
  if (isGeneratedFreeRoomId(roomId)) return roomId;
  return normalizeCustomRoomCode(roomId);
}

export function customRoomCodeAvailability(input: unknown, taken: boolean): CustomRoomCodeAvailability {
  const code = normalizeCustomRoomCode(input);
  if (!code) return { code: null, available: false, reason: "invalid" };
  if (taken) return { code, available: false, reason: "taken" };
  return { code, available: true };
}

export function normalizeFortPassClaimSecret(input: unknown): string | null {
  return typeof input === "string" && FORT_PASS_CLAIM_SECRET_RE.test(input) ? input : null;
}

export function normalizeFortPassClaimHash(input: unknown): string | null {
  return typeof input === "string" && FORT_PASS_CLAIM_SECRET_RE.test(input) ? input : null;
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function fortPassClaimHash(secretInput: unknown): Promise<string | null> {
  const secret = normalizeFortPassClaimSecret(secretInput);
  if (!secret) return null;
  const secretBytes = hexBytes(secret);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      secretBytes.buffer as ArrayBuffer,
    ));
    return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    secretBytes.fill(0);
  }
}

export function constantTimeFortPassClaimHashEqual(aInput: unknown, bInput: unknown): boolean {
  const a = normalizeFortPassClaimHash(aInput);
  const b = normalizeFortPassClaimHash(bInput);
  if (!a || !b) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export function normalizeFortPassCheckoutRequest(input: unknown): FortPassCheckoutRequest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Reflect.ownKeys(raw).length !== 2
    || !Object.prototype.hasOwnProperty.call(raw, "customRoomCode")
    || !Object.prototype.hasOwnProperty.call(raw, "claimHash")) return null;
  const customRoomCode = normalizeCustomRoomCode(raw.customRoomCode);
  const claimHash = normalizeFortPassClaimHash(raw.claimHash);
  if (!customRoomCode || customRoomCode !== raw.customRoomCode || !claimHash) return null;
  return { customRoomCode, claimHash };
}

function normalizeStatus(input: unknown, expiresAt: number, now: number): FortPassStatus | null {
  if (input === "refunded") return "refunded";
  if (input === "expired") return "expired";
  if (input === "active") return expiresAt > now ? "active" : "expired";
  return null;
}

function normalizeProvider(input: unknown): FortPassProvider | null {
  if (input === "stripe" || input === "manual") return input;
  return null;
}

function normalizeThemePack(input: unknown): FortPassThemePack | undefined {
  return input === "retro-plus" ? input : undefined;
}

function normalizePerks(input: unknown): FortPassPerks {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const perks: FortPassPerks = {};

  const customRoomCode = normalizeCustomRoomCode(raw.customRoomCode);
  if (customRoomCode) perks.customRoomCode = customRoomCode;

  if (typeof raw.extendedIdleMs === "number" && Number.isFinite(raw.extendedIdleMs)) {
    const extendedIdleMs = Math.trunc(raw.extendedIdleMs);
    if (extendedIdleMs > 0 && extendedIdleMs <= FORT_PASS_EXTENDED_IDLE_MS) {
      perks.extendedIdleMs = extendedIdleMs;
    }
  }

  const themePack = normalizeThemePack(raw.themePack);
  if (themePack) perks.themePack = themePack;

  return perks;
}

export function normalizeFortPassEntitlement(input: unknown, now = Date.now()): FortPassEntitlement | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (raw.v !== 1 || raw.kind !== FORT_PASS_KIND) return null;

  const roomId = normalizeCustomRoomCode(raw.roomId);
  const hostRef = cleanToken(raw.hostRef);
  const provider = normalizeProvider(raw.provider);
  const providerRef = cleanToken(raw.providerRef);
  const createdAt = cleanTimestamp(raw.createdAt);
  const expiresAt = cleanTimestamp(raw.expiresAt);
  if (!roomId || !hostRef || !provider || !providerRef || createdAt === null || expiresAt === null) return null;
  if (expiresAt <= createdAt || expiresAt - createdAt > FORT_PASS_MAX_LIFETIME_MS) return null;
  if (createdAt > now + FORT_PASS_CLOCK_SKEW_MS) return null;
  if (provider === "stripe" && !STRIPE_CHECKOUT_SESSION_ID_RE.test(providerRef)) return null;

  const status = normalizeStatus(raw.status, expiresAt, now);
  if (!status) return null;
  const perks = normalizePerks(raw.perks);
  // A malformed persisted/internal entitlement must never grant a paid code
  // other than the Durable Object it was issued for.
  if (perks.customRoomCode !== roomId) return null;

  return {
    v: 1,
    kind: FORT_PASS_KIND,
    status,
    roomId,
    hostRef,
    provider,
    providerRef,
    createdAt,
    expiresAt,
    perks,
  };
}

export function isFortPassActive(entitlement: FortPassEntitlement, now = Date.now()): boolean {
  return entitlement.status === "active" && entitlement.expiresAt > now;
}

export function fortPassIdleMs(
  entitlement: FortPassEntitlement | null,
  defaultIdleMs: number,
  now = Date.now()
): number {
  if (!entitlement || !isFortPassActive(entitlement, now)) return defaultIdleMs;
  return entitlement.perks.extendedIdleMs || defaultIdleMs;
}

export function fortPassAllowsCustomRoomCode(
  entitlement: FortPassEntitlement | null,
  code: unknown,
  now = Date.now()
): boolean {
  if (!entitlement || !isFortPassActive(entitlement, now)) return false;
  const normalized = normalizeCustomRoomCode(code);
  return !!normalized && entitlement.perks.customRoomCode === normalized;
}

export function normalizeFortPassRedemptionToken(input: unknown): string | null {
  return cleanToken(input);
}

export function fortPassRedemptionMatches(
  entitlement: FortPassEntitlement | null,
  token: unknown,
  now = Date.now()
): boolean {
  if (!entitlement || !isFortPassActive(entitlement, now)) return false;
  const normalized = normalizeFortPassRedemptionToken(token);
  return !!normalized && normalized === entitlement.providerRef;
}

export function normalizeRoomTheme(input: unknown): RoomTheme | null {
  if (input === "away-message" || input === "campus-blue" || input === "top-8") return input;
  if (input === "classic") return "away-message";
  if (input === "retro-green") return "campus-blue";
  if (input === "midnight") return "top-8";
  return null;
}

export function fortPassAllowsRoomTheme(
  entitlement: FortPassEntitlement | null,
  theme: unknown,
  now = Date.now()
): boolean {
  const normalized = normalizeRoomTheme(theme);
  if (!normalized) return false;
  if (normalized === "away-message") return true;
  return !!entitlement &&
    isFortPassActive(entitlement, now) &&
    entitlement.perks.themePack === "retro-plus" &&
    RETRO_PLUS_THEMES.has(normalized);
}
