import {
  FORT_PASS_EXTENDED_IDLE_MS,
  FORT_PASS_KIND,
  FORT_PASS_MAX_LIFETIME_MS,
  normalizeCustomRoomCode,
  normalizeFortPassEntitlement,
  type FortPassEntitlement,
} from "./entitlements";

export interface StripeCheckoutConfig {
  secretKey: string;
  priceId: string;
  publicBaseUrl: string;
  customRoomCode: string;
  fetcher?: typeof fetch;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripeWebhookVerification {
  ok: boolean;
  reason?: "missing_header" | "bad_header" | "stale" | "mismatch";
}

export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function cleanBaseUrl(input: string): string {
  const url = new URL(input);
  url.search = "";
  url.hash = "";
  return url.origin;
}

function parseStripeSignatureHeader(header: string | null): { timestamp: number; signatures: string[] } | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = Math.trunc(parsed);
    }
    if (key === "v1" && value && /^[a-f0-9]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function computeStripeWebhookSignature(payload: string, timestamp: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  );
  return bytesToHex(signature);
}

export async function verifyStripeWebhookSignature(
  payload: string,
  header: string | null,
  secret: string,
  nowMs = Date.now(),
  toleranceSeconds = STRIPE_WEBHOOK_TOLERANCE_SECONDS
): Promise<StripeWebhookVerification> {
  if (!header) return { ok: false, reason: "missing_header" };
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "bad_header" };
  if (Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp) > toleranceSeconds) {
    return { ok: false, reason: "stale" };
  }
  const expected = await computeStripeWebhookSignature(payload, parsed.timestamp, secret);
  return parsed.signatures.some(signature => timingSafeEqual(signature, expected))
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

function appendCheckoutMetadata(params: URLSearchParams, customRoomCode: string) {
  params.set("metadata[kind]", FORT_PASS_KIND);
  params.set("metadata[custom_room_code]", customRoomCode);
  params.set("metadata[entitlement_kind]", FORT_PASS_KIND);
}

export async function createFortPassStripeCheckoutSession(config: StripeCheckoutConfig): Promise<StripeCheckoutSession> {
  const baseUrl = cleanBaseUrl(config.publicBaseUrl);
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", config.priceId);
  params.set("line_items[0][quantity]", "1");
  params.set("client_reference_id", `${FORT_PASS_KIND}:${config.customRoomCode}`);
  params.set("success_url", `${baseUrl}/?fort_pass=success&code=${encodeURIComponent(config.customRoomCode)}&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${baseUrl}/?fort_pass=cancel&code=${encodeURIComponent(config.customRoomCode)}`);
  appendCheckoutMetadata(params, config.customRoomCode);

  const res = await (config.fetcher || fetch)("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  const data = await res.json().catch(() => null) as { id?: unknown; url?: unknown; error?: unknown } | null;
  if (!res.ok) {
    throw new Error("stripe checkout session failed");
  }
  if (!data || typeof data.id !== "string" || typeof data.url !== "string" || !data.url.startsWith("https://")) {
    throw new Error("stripe checkout session response invalid");
  }
  return { id: data.id, url: data.url };
}

export function fortPassEntitlementFromStripeEvent(input: unknown, now = Date.now()): FortPassEntitlement | null {
  if (!input || typeof input !== "object") return null;
  const event = input as Record<string, unknown>;
  if (event.type !== "checkout.session.completed") return null;
  const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : null;
  const session = data?.object && typeof data.object === "object" ? data.object as Record<string, unknown> : null;
  if (!session) return null;
  if (session.object !== "checkout.session") return null;
  if (session.mode !== "payment" || session.payment_status !== "paid") return null;
  if (typeof session.id !== "string") return null;

  const metadata = session.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  if (metadata.kind !== FORT_PASS_KIND && metadata.entitlement_kind !== FORT_PASS_KIND) return null;

  const customRoomCode = normalizeCustomRoomCode(metadata.custom_room_code);
  if (!customRoomCode) return null;

  return normalizeFortPassEntitlement({
    v: 1,
    kind: FORT_PASS_KIND,
    status: "active",
    roomId: customRoomCode,
    hostRef: session.id,
    provider: "stripe",
    providerRef: session.id,
    createdAt: now,
    expiresAt: now + FORT_PASS_MAX_LIFETIME_MS,
    perks: {
      customRoomCode,
      extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS,
      themePack: "retro-plus",
    },
  }, now);
}
