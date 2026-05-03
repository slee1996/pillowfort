export const FORT_PASS_KIND = "fort-pass";
export const CUSTOM_ROOM_CODE_MIN_LEN = 4;
export const CUSTOM_ROOM_CODE_MAX_LEN = 10;
export const FORT_PASS_EXTENDED_IDLE_MS = 6 * 60 * 60 * 1000;
export const FORT_PASS_MAX_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export type FortPassStatus = "active" | "refunded" | "expired";
export type FortPassProvider = "stripe" | "manual";
export type FortPassThemePack = "retro-plus";
export type RoomTheme = "classic" | "retro-green" | "midnight";

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
const RETRO_PLUS_THEMES = new Set<RoomTheme>(["retro-green", "midnight"]);

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
  if (code.length < CUSTOM_ROOM_CODE_MIN_LEN || code.length > CUSTOM_ROOM_CODE_MAX_LEN) return null;
  if (!ROOM_CODE_RE.test(code)) return null;
  if (code.includes("--")) return null;
  if (isReservedRoomCode(code)) return null;
  return code;
}

export function customRoomCodeAvailability(input: unknown, taken: boolean): CustomRoomCodeAvailability {
  const code = normalizeCustomRoomCode(input);
  if (!code) return { code: null, available: false, reason: "invalid" };
  if (taken) return { code, available: false, reason: "taken" };
  return { code, available: true };
}

export function normalizeFortPassCheckoutRequest(input: unknown): FortPassCheckoutRequest | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const customRoomCode = normalizeCustomRoomCode(raw.customRoomCode);
  if (!customRoomCode) return null;
  return { customRoomCode };
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

  const status = normalizeStatus(raw.status, expiresAt, now);
  if (!status) return null;

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
    perks: normalizePerks(raw.perks),
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
  if (input === "classic" || input === "retro-green" || input === "midnight") return input;
  return null;
}

export function fortPassAllowsRoomTheme(
  entitlement: FortPassEntitlement | null,
  theme: unknown,
  now = Date.now()
): boolean {
  const normalized = normalizeRoomTheme(theme);
  if (!normalized) return false;
  if (normalized === "classic") return true;
  return !!entitlement &&
    isFortPassActive(entitlement, now) &&
    entitlement.perks.themePack === "retro-plus" &&
    RETRO_PLUS_THEMES.has(normalized);
}
