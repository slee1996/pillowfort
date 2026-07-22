import {
  fortPassClaimHash,
  normalizeCustomRoomCode,
  normalizeFortPassClaimSecret,
} from "../../../src/entitlements";

export type FortPassAvailability =
  | { code: string; available: true }
  | { code: string | null; available: false; reason: "invalid" | "taken" };

export type FortPassCheckoutResult =
  | { ok: true; code: string; checkoutUrl: string; sessionId: string }
  | { ok: false; error: "invalid_custom_room_code" | "custom_room_code_taken" | "checkout_not_configured" | "checkout_provider_error" | "unknown"; code?: string };

export type FortPassStatus = {
  beta: boolean;
  checkoutConfigured: boolean;
  priceLabel: string;
  perks: string[];
};

export type FortPassRedemptionResult =
  | { ok: true; code: string }
  | { ok: false; error: "pending" | "invalid_checkout_redemption" | "checkout_not_redeemable" | "checkout_not_configured" | "checkout_rate_limited" | "checkout_verification_failed" | "unknown" };

const FORT_PASS_SESSION_RE = /^cs_(?:test_|live_)?[A-Za-z0-9_]{3,255}$/;
const STRIPE_HOSTED_CHECKOUT_ORIGIN = "https://checkout.stripe.com";
const MAX_STRIPE_CHECKOUT_URL_LENGTH = 8 * 1024;
const MAX_FORT_PASS_API_RESPONSE_BYTES = 16 * 1024;
const MAX_FORT_PASS_API_RESPONSE_CHUNKS = 8_192;
const FORT_PASS_CLAIM_STORAGE_PREFIX = "pillowfort:fort-pass-claim:v1:";
const FORT_PASS_PENDING_REDEMPTION_KEY = "pillowfort:fort-pass-pending-redemption:v1";
const MAX_FORT_PASS_PENDING_REDEMPTION_BYTES = 512;

export interface PendingFortPassRedemption {
  code: string;
  sessionId: string;
  claimSecret: string;
}

function plainRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? input as Record<string, unknown>
    : null;
}

function exactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(input);
  return keys.length >= required.length
    && keys.every(key => typeof key === "string" && allowed.has(key))
    && required.every(key => Object.prototype.hasOwnProperty.call(input, key));
}

async function readBoundedApiJson(response: Response): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) return null;
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_FORT_PASS_API_RESPONSE_BYTES) return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount++;
      if (!(value instanceof Uint8Array) || chunkCount > MAX_FORT_PASS_API_RESPONSE_CHUNKS) {
        try { await reader.cancel("invalid response stream"); } catch {}
        return null;
      }
      received += value.byteLength;
      if (received > MAX_FORT_PASS_API_RESPONSE_BYTES) {
        try { await reader.cancel("response too large"); } catch {}
        return null;
      }
      chunks.push(value);
    }
  } catch {
    try { await reader.cancel("response stream failed"); } catch {}
    return null;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (contentLength !== null && received !== Number(contentLength)) return null;

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return plainRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

export function normalizeFortPassCode(input: string | null): string | null {
  return normalizeCustomRoomCode(input);
}

export function normalizeFortPassSessionId(input: string | null): string | null {
  if (!input) return null;
  const token = input.trim();
  return FORT_PASS_SESSION_RE.test(token) ? token : null;
}

export function fortPassReturnCleanupPath(
  pathname: string,
  search: string,
  hash: string,
): string | null {
  if (!pathname.startsWith("/") || /[\u0000-\u001f\u007f]/u.test(pathname + hash)) return null;
  const params = new URLSearchParams(search);
  const state = params.get("fort_pass");
  if (state !== "success" && state !== "cancel") return null;
  params.delete("fort_pass");
  params.delete("code");
  params.delete("session_id");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

function claimStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function createFortPassClaimSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getFortPassClaimSecret(sessionIdInput: string): string | null {
  const sessionId = normalizeFortPassSessionId(sessionIdInput);
  if (!sessionId || sessionId !== sessionIdInput) return null;
  const storage = claimStorage();
  if (!storage) return null;
  try {
    return normalizeFortPassClaimSecret(storage.getItem(`${FORT_PASS_CLAIM_STORAGE_PREFIX}${sessionId}`));
  } catch {
    return null;
  }
}

export function clearFortPassClaimSecret(sessionIdInput: string): void {
  const sessionId = normalizeFortPassSessionId(sessionIdInput);
  if (!sessionId || sessionId !== sessionIdInput) return;
  try {
    const storage = claimStorage();
    storage?.removeItem(`${FORT_PASS_CLAIM_STORAGE_PREFIX}${sessionId}`);
    if (storage) {
      const pending = readPendingFortPassRedemption(storage);
      if (pending?.sessionId === sessionId) storage.removeItem(FORT_PASS_PENDING_REDEMPTION_KEY);
    }
  } catch {}
}

function readPendingFortPassRedemption(storage: Storage): { code: string; sessionId: string } | null {
  const serialized = storage.getItem(FORT_PASS_PENDING_REDEMPTION_KEY);
  if (!serialized || serialized.length > MAX_FORT_PASS_PENDING_REDEMPTION_BYTES) return null;
  try {
    const value = plainRecord(JSON.parse(serialized));
    if (!value || !exactKeys(value, ["code", "sessionId"])) return null;
    const code = normalizeFortPassCode(typeof value.code === "string" ? value.code : null);
    const sessionId = normalizeFortPassSessionId(
      typeof value.sessionId === "string" ? value.sessionId : null,
    );
    if (!code || code !== value.code || !sessionId || sessionId !== value.sessionId) return null;
    return { code, sessionId };
  } catch {
    return null;
  }
}

export function rememberPendingFortPassRedemption(
  codeInput: string,
  sessionIdInput: string,
  claimSecretInput: string,
): boolean {
  const code = normalizeFortPassCode(codeInput);
  const sessionId = normalizeFortPassSessionId(sessionIdInput);
  const claimSecret = normalizeFortPassClaimSecret(claimSecretInput);
  const storage = claimStorage();
  if (!code || code !== codeInput || !sessionId || sessionId !== sessionIdInput || !claimSecret || !storage) {
    return false;
  }
  try {
    if (storage.getItem(`${FORT_PASS_CLAIM_STORAGE_PREFIX}${sessionId}`) !== claimSecret) return false;
    storage.setItem(FORT_PASS_PENDING_REDEMPTION_KEY, JSON.stringify({ code, sessionId }));
    return true;
  } catch {
    return false;
  }
}

export function getPendingFortPassRedemption(): PendingFortPassRedemption | null {
  const storage = claimStorage();
  if (!storage) return null;
  try {
    const pending = readPendingFortPassRedemption(storage);
    if (!pending) {
      storage.removeItem(FORT_PASS_PENDING_REDEMPTION_KEY);
      return null;
    }
    const claimSecret = getFortPassClaimSecret(pending.sessionId);
    if (!claimSecret) {
      storage.removeItem(FORT_PASS_PENDING_REDEMPTION_KEY);
      return null;
    }
    return { ...pending, claimSecret };
  } catch {
    return null;
  }
}

// Keep this client-side check even though the server validates Stripe's
// response. A compromised or misconfigured API response must not become an
// arbitrary navigation target. Stripe-hosted Checkout URLs legitimately use an
// opaque fragment, which is preserved after the exact-origin checks.
export function normalizeStripeHostedCheckoutUrl(input: unknown): string | null {
  if (
    typeof input !== "string"
    || input.length < 1
    || input.length > MAX_STRIPE_CHECKOUT_URL_LENGTH
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
    || !input.startsWith(`${STRIPE_HOSTED_CHECKOUT_ORIGIN}/`)
  ) {
    return null;
  }
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:"
      || url.origin !== STRIPE_HOSTED_CHECKOUT_ORIGIN
      || url.hostname !== "checkout.stripe.com"
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export async function checkFortPassCode(code: string): Promise<FortPassAvailability> {
  const canonicalCode = normalizeFortPassCode(code);
  if (!canonicalCode || canonicalCode !== code) return { code: null, available: false, reason: "invalid" };
  const res = await fetch(`/api/fort-pass/code?code=${encodeURIComponent(canonicalCode)}`, {
    headers: { "accept": "application/json" },
  });
  const data = await readBoundedApiJson(res);
  if (res.status !== 200 || !data) throw new Error("invalid Fort Pass availability response");
  if (data.available === true && data.code === canonicalCode && exactKeys(data, ["available", "code"])) {
    return { available: true, code: canonicalCode };
  }
  if (
    data.available === false
    && (data.reason === "invalid" || data.reason === "taken")
    && exactKeys(data, ["available", "code", "reason"])
    && ((data.reason === "invalid" && data.code === null) || (data.reason === "taken" && data.code === canonicalCode))
  ) {
    return { available: false, code: data.code as string | null, reason: data.reason };
  }
  throw new Error("invalid Fort Pass availability response");
}

export async function getFortPassStatus(): Promise<FortPassStatus> {
  const res = await fetch("/api/fort-pass/status", {
    headers: { "accept": "application/json" },
  });
  const data = await readBoundedApiJson(res);
  if (res.status !== 200 || !data || !exactKeys(data, ["beta", "checkoutConfigured", "priceLabel", "perks"])) {
    throw new Error("invalid Fort Pass status response");
  }
  return {
    beta: data?.beta === true,
    checkoutConfigured: data?.checkoutConfigured === true,
    priceLabel: typeof data?.priceLabel === "string" && data.priceLabel.length <= 12 ? data.priceLabel : "$5",
    perks: Array.isArray(data?.perks)
      ? data.perks.filter((perk): perk is string => typeof perk === "string" && perk.length <= 32).slice(0, 8)
      : [],
  };
}

export async function startFortPassCheckout(code: string): Promise<FortPassCheckoutResult> {
  const canonicalCode = normalizeFortPassCode(code);
  if (!canonicalCode || canonicalCode !== code) return { ok: false, error: "invalid_custom_room_code" };
  const storage = claimStorage();
  if (!storage) return { ok: false, error: "checkout_provider_error" };
  const claimSecret = createFortPassClaimSecret();
  const claimHash = await fortPassClaimHash(claimSecret);
  if (!claimHash) return { ok: false, error: "checkout_provider_error" };
  const res = await fetch("/api/fort-pass/checkout", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ customRoomCode: canonicalCode, claimHash }),
  });
  const data = await readBoundedApiJson(res);
  const checkoutUrl = normalizeStripeHostedCheckoutUrl(data?.checkoutUrl);
  const sessionId = normalizeFortPassSessionId(typeof data?.sessionId === "string" ? data.sessionId : null);
  if (
    res.status === 200
    && data
    && exactKeys(data, ["code", "checkoutUrl", "sessionId"])
    && data.code === canonicalCode
    && checkoutUrl
    && sessionId
    && sessionId === data.sessionId
  ) {
    try {
      storage.setItem(`${FORT_PASS_CLAIM_STORAGE_PREFIX}${sessionId}`, claimSecret);
    } catch {
      return { ok: false, error: "checkout_provider_error" };
    }
    return {
      ok: true,
      code: canonicalCode,
      checkoutUrl,
      sessionId,
    };
  }
  if (res.ok) {
    return { ok: false, error: "checkout_provider_error" };
  }
  const error = typeof data?.error === "string" ? data.error : "unknown";
  const expectedStatus = {
    invalid_custom_room_code: 400,
    custom_room_code_taken: 409,
    checkout_not_configured: 501,
    checkout_provider_error: 502,
  } as const;
  if (error in expectedStatus && res.status === expectedStatus[error as keyof typeof expectedStatus] && data) {
    const responseCode = data.code;
    if (!exactKeys(data, ["error"], ["code"])) return { ok: false, error: "unknown" };
    if (responseCode !== undefined && responseCode !== canonicalCode) return { ok: false, error: "unknown" };
    return { ok: false, error: error as keyof typeof expectedStatus, ...(responseCode === canonicalCode ? { code: canonicalCode } : {}) };
  }
  return { ok: false, error: "unknown" };
}

export async function redeemFortPassCheckout(
  customRoomCode: string,
  sessionId: string,
  claimSecretInput: string,
): Promise<FortPassRedemptionResult> {
  const code = normalizeFortPassCode(customRoomCode);
  const normalizedSessionId = normalizeFortPassSessionId(sessionId);
  const claimSecret = normalizeFortPassClaimSecret(claimSecretInput);
  if (!code || code !== customRoomCode || !normalizedSessionId || normalizedSessionId !== sessionId || !claimSecret) {
    return { ok: false, error: "invalid_checkout_redemption" };
  }
  const response = await fetch("/api/fort-pass/redeem", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ customRoomCode: code, sessionId: normalizedSessionId, claimSecret }),
  });
  const data = await readBoundedApiJson(response);
  if (
    response.status === 200
    && data?.redeemed === true
    && data.code === code
    && exactKeys(data, ["redeemed", "code"], ["replay"])
    && (data.replay === undefined || data.replay === true)
  ) return { ok: true, code };
  if (
    response.status === 202
    && data?.status === "pending"
    && data.code === code
    && exactKeys(data, ["status", "code"])
  ) {
    return { ok: false, error: "pending" };
  }
  const error = typeof data?.error === "string" ? data.error : "unknown";
  const expectedStatus = {
    invalid_checkout_redemption: 400,
    checkout_not_redeemable: 409,
    checkout_not_configured: 501,
    checkout_rate_limited: 429,
    checkout_verification_failed: 502,
  } as const;
  if (
    data
    && exactKeys(data, ["error"])
    && error in expectedStatus
    && response.status === expectedStatus[error as keyof typeof expectedStatus]
  ) return { ok: false, error: error as keyof typeof expectedStatus };
  return { ok: false, error: "unknown" };
}
