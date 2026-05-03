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

const ROOM_CODE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORT_PASS_SESSION_RE = /^[a-zA-Z0-9_:-]{1,128}$/;
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

export function normalizeFortPassCode(input: string | null): string | null {
  if (!input) return null;
  const code = input.trim().toLowerCase();
  if (code.length < 4 || code.length > 10) return null;
  if (!ROOM_CODE_RE.test(code) || code.includes("--")) return null;
  if (RESERVED_ROOM_CODES.has(code)) return null;
  return code;
}

export function normalizeFortPassSessionId(input: string | null): string | null {
  if (!input) return null;
  const token = input.trim();
  return FORT_PASS_SESSION_RE.test(token) ? token : null;
}

export async function checkFortPassCode(code: string): Promise<FortPassAvailability> {
  const res = await fetch(`/api/fort-pass/code?code=${encodeURIComponent(code)}`, {
    headers: { "accept": "application/json" },
  });
  return await res.json() as FortPassAvailability;
}

export async function getFortPassStatus(): Promise<FortPassStatus> {
  const res = await fetch("/api/fort-pass/status", {
    headers: { "accept": "application/json" },
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
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
  const res = await fetch("/api/fort-pass/checkout", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ customRoomCode: code }),
  });
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (res.ok && data && typeof data.code === "string" && typeof data.checkoutUrl === "string" && typeof data.sessionId === "string") {
    return {
      ok: true,
      code: data.code,
      checkoutUrl: data.checkoutUrl,
      sessionId: data.sessionId,
    };
  }
  const error = typeof data?.error === "string" ? data.error : "unknown";
  if (
    error === "invalid_custom_room_code" ||
    error === "custom_room_code_taken" ||
    error === "checkout_not_configured" ||
    error === "checkout_provider_error"
  ) {
    return { ok: false, error, ...(typeof data?.code === "string" ? { code: data.code } : {}) };
  }
  return { ok: false, error: "unknown" };
}
