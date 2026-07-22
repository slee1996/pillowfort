import {
  FORT_PASS_EXTENDED_IDLE_MS,
  FORT_PASS_CHECKOUT_SESSION_LIFETIME_MS,
  FORT_PASS_KIND,
  FORT_PASS_MAX_LIFETIME_MS,
  normalizeFortPassClaimHash,
  normalizeFortPassClaimSecret,
  normalizeCustomRoomCode,
  normalizeFortPassEntitlement,
  type FortPassEntitlement,
} from "./entitlements";
import { readByteLimitedText } from "./requestBody";

export interface StripeCheckoutConfig {
  secretKey: string;
  priceId: string;
  publicBaseUrl: string;
  customRoomCode: string;
  claimHash: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface StripeRedemptionRequest {
  customRoomCode: string;
  sessionId: string;
  claimSecret: string;
}

export interface StripeWebhookVerification {
  ok: boolean;
  reason?: "missing_header" | "bad_header" | "stale" | "mismatch";
}

export interface StripeEntitlementResolutionConfig {
  secretKey: string;
  priceId: string;
  fetcher?: typeof fetch;
  now?: number;
  timeoutMs?: number;
}

export type StripeEntitlementResolution =
  | { status: "ignored" }
  | { status: "invalid"; reason: "event" | "session_binding" }
  | { status: "unavailable" }
  | {
      status: "verified";
      eventId: string;
      sessionId: string;
      claimHash: string;
      entitlement: FortPassEntitlement;
    };

export type StripeCheckoutSessionResolution =
  | { status: "invalid" }
  | { status: "unavailable" }
  | { status: "pending"; sessionId: string; roomId: string; claimHash: string }
  | { status: "expired_unpaid"; sessionId: string; roomId: string; claimHash: string }
  | { status: "verified"; sessionId: string; roomId: string; claimHash: string; entitlement: FortPassEntitlement };

export type StripeFortPassRevocationReason = "refund" | "dispute";

export type StripeRevocationResolution =
  | { status: "ignored" }
  | { status: "invalid"; reason: "event" | "provider_binding" | "session_binding" }
  | { status: "unavailable" }
  | {
      status: "verified";
      eventId: string;
      sessionId: string;
      roomId: string;
      reason: StripeFortPassRevocationReason;
    };

export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
export const STRIPE_HOSTED_CHECKOUT_ORIGIN = "https://checkout.stripe.com";
const MAX_STRIPE_CHECKOUT_URL_LENGTH = 8 * 1024;
const MAX_PUBLIC_BASE_URL_LENGTH = 2 * 1024;
const MAX_STRIPE_SIGNATURE_HEADER_LENGTH = 8 * 1024;
const MAX_STRIPE_SIGNATURE_PARTS = 32;
const MAX_STRIPE_V1_SIGNATURES = 16;
const MAX_STRIPE_API_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_STRIPE_API_TIMEOUT_MS = 10_000;
const MAX_STRIPE_API_TIMEOUT_MS = 30_000;
const STRIPE_CHECKOUT_SESSION_ID_RE = /^cs_(?:test_|live_)?[A-Za-z0-9_]{3,255}$/u;
const STRIPE_EVENT_ID_RE = /^evt_(?:test_)?[A-Za-z0-9_]{3,255}$/u;
const STRIPE_PRICE_ID_RE = /^price_[A-Za-z0-9_]{3,255}$/u;
const STRIPE_CHARGE_ID_RE = /^ch_[A-Za-z0-9_]{3,255}$/u;
const STRIPE_DISPUTE_ID_RE = /^du_[A-Za-z0-9_]{3,255}$/u;
const STRIPE_PAYMENT_INTENT_ID_RE = /^pi_[A-Za-z0-9_]{3,255}$/u;
const STRIPE_SECRET_KEY_RE = /^(?:sk|rk)_(test|live)_[A-Za-z0-9_]{3,512}$/u;

type StripeMode = "test" | "live";

interface StripeFortPassSessionCandidate {
  sessionId: string;
  roomId: string;
  createdSeconds: number;
  livemode: boolean;
}

interface StripeFortPassEventCandidate extends StripeFortPassSessionCandidate {
  eventId: string;
  eventType: "checkout.session.completed" | "checkout.session.async_payment_succeeded";
}

interface StripeFortPassRevocationCandidate {
  eventId: string;
  eventType: "charge.refunded" | "charge.dispute.created";
  objectId: string;
  chargeId: string;
  paymentIntentId: string | null;
  livemode: boolean;
  reason: StripeFortPassRevocationReason;
}

/**
 * Accept only Stripe's first-party hosted Checkout origin. Custom Checkout
 * domains are intentionally not enabled for Pillowfort, so widening this list
 * requires an explicit configuration and security review.
 *
 * Stripe's documented hosted URLs may contain an opaque fragment, so fragments
 * are preserved. The authority itself must be the exact lowercase hostname:
 * this deliberately rejects credentials, explicit ports, lookalike subdomains,
 * and URL-parser backslash tricks before the URL is returned to a browser.
 */
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

export function normalizePublicBaseUrl(input: unknown): string | null {
  if (
    typeof input !== "string"
    || input.length < 1
    || input.length > MAX_PUBLIC_BASE_URL_LENGTH
    || input.trim() !== input
    || /[\u0000-\u001f\u007f]/u.test(input)
  ) {
    return null;
  }

  try {
    const url = new URL(input);
    if (url.username !== "" || url.password !== "") return null;
    const localHttp = url.protocol === "http:" && (
      url.hostname === "localhost"
      || url.hostname === "127.0.0.1"
      || url.hostname === "[::1]"
    );
    if (url.protocol !== "https:" && !localHttp) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function plainRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(input).length !== 0) return null;
  for (const key of Object.keys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return null;
  }
  return input as Record<string, unknown>;
}

function stripeModeFromSecret(secret: unknown): StripeMode | null {
  if (typeof secret !== "string" || secret.length > 600 || /[\u0000-\u001f\u007f]/u.test(secret)) return null;
  const match = STRIPE_SECRET_KEY_RE.exec(secret);
  return match?.[1] === "test" || match?.[1] === "live" ? match[1] : null;
}

function normalizeStripePriceId(input: unknown): string | null {
  return typeof input === "string" && STRIPE_PRICE_ID_RE.test(input) ? input : null;
}

export function normalizeStripeCheckoutSessionId(input: unknown): string | null {
  return typeof input === "string" && STRIPE_CHECKOUT_SESSION_ID_RE.test(input) ? input : null;
}

export function normalizeStripeRedemptionRequest(input: unknown): StripeRedemptionRequest | null {
  const value = plainRecord(input);
  if (!value || Reflect.ownKeys(value).length !== 3
    || !Object.prototype.hasOwnProperty.call(value, "customRoomCode")
    || !Object.prototype.hasOwnProperty.call(value, "sessionId")
    || !Object.prototype.hasOwnProperty.call(value, "claimSecret")) return null;
  const customRoomCode = normalizeCustomRoomCode(value.customRoomCode);
  const sessionId = normalizeStripeCheckoutSessionId(value.sessionId);
  const claimSecret = normalizeFortPassClaimSecret(value.claimSecret);
  return customRoomCode && customRoomCode === value.customRoomCode && sessionId && claimSecret
    ? { customRoomCode, sessionId, claimSecret }
    : null;
}

function boundedStripeTimeout(input: unknown): number {
  return Number.isSafeInteger(input) && (input as number) >= 100 && (input as number) <= MAX_STRIPE_API_TIMEOUT_MS
    ? input as number
    : DEFAULT_STRIPE_API_TIMEOUT_MS;
}

async function readStripeJson(response: Response): Promise<unknown> {
  // Fetch implementations may transparently decompress a Stripe response
  // while retaining the compressed Content-Length. Enforce the received byte
  // ceiling, but do not compare that decoded stream with a wire-length header.
  const body = await readByteLimitedText({ headers: new Headers(), body: response.body }, MAX_STRIPE_API_RESPONSE_BYTES);
  if (!body.ok || !body.text) throw new Error("stripe API response invalid");
  try {
    return JSON.parse(body.text);
  } catch {
    throw new Error("stripe API response invalid");
  }
}

async function stripeApiFetch(
  fetcher: typeof fetch | undefined,
  url: string,
  secretKey: string,
  init: RequestInit,
  timeoutMs: number | undefined,
): Promise<Response> {
  const mode = stripeModeFromSecret(secretKey);
  if (!mode) throw new Error("invalid Stripe secret key configuration");
  return (fetcher || fetch)(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(boundedStripeTimeout(timeoutMs)),
    headers: {
      "authorization": `Bearer ${secretKey}`,
      ...(init.headers || {}),
    },
  });
}

function parseStripeSignatureHeader(header: string | null): { timestamp: number; signatures: string[] } | null {
  if (!header || header.length > MAX_STRIPE_SIGNATURE_HEADER_LENGTH) return null;
  const parts = header.split(",");
  if (parts.length > MAX_STRIPE_SIGNATURE_PARTS) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) {
      if (timestamp !== null || !/^\d{1,16}$/u.test(value)) return null;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
      timestamp = parsed;
    }
    if (key === "v1" && value && /^[a-f0-9]{64}$/i.test(value)) {
      if (signatures.length >= MAX_STRIPE_V1_SIGNATURES) return null;
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function stripeFulfillmentSessionKey(sessionId: string): Promise<string> {
  if (!normalizeStripeCheckoutSessionId(sessionId)) throw new Error("invalid Stripe Checkout Session ID");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:stripe-session-ledger:v1:${sessionId}`),
  );
  return bytesToHex(digest);
}

export async function stripeRevocationEventKey(eventId: string): Promise<string> {
  if (!STRIPE_EVENT_ID_RE.test(eventId)) throw new Error("invalid Stripe Event ID");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:stripe-revocation-ledger:v1:${eventId}`),
  );
  return bytesToHex(digest);
}

export function createStripeFulfillmentClaimToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
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

function appendCheckoutMetadata(params: URLSearchParams, customRoomCode: string, priceId: string, claimHash: string) {
  params.set("metadata[kind]", FORT_PASS_KIND);
  params.set("metadata[custom_room_code]", customRoomCode);
  params.set("metadata[entitlement_kind]", FORT_PASS_KIND);
  params.set("metadata[price_id]", priceId);
  params.set("metadata[claim_hash]", claimHash);
}

export async function createFortPassStripeCheckoutSession(config: StripeCheckoutConfig): Promise<StripeCheckoutSession> {
  const baseUrl = normalizePublicBaseUrl(config.publicBaseUrl);
  const customRoomCode = normalizeCustomRoomCode(config.customRoomCode);
  const priceId = normalizeStripePriceId(config.priceId);
  const claimHash = normalizeFortPassClaimHash(config.claimHash);
  if (!baseUrl) throw new Error("invalid public checkout base URL");
  if (!customRoomCode || customRoomCode !== config.customRoomCode) {
    throw new Error("invalid custom room code");
  }
  if (!priceId) throw new Error("invalid Stripe price configuration");
  if (!claimHash) throw new Error("invalid Fort Pass claim hash");
  if (!stripeModeFromSecret(config.secretKey)) throw new Error("invalid Stripe secret key configuration");
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  // Stripe defaults Checkout Sessions to 24 hours. Pillowfort reserves a
  // one-of-one custom room code for 32 minutes, so expire Checkout first; a
  // late payment must never charge someone for a code that was reallocated.
  params.set("expires_at", String(
    Math.floor(Date.now() / 1_000) + FORT_PASS_CHECKOUT_SESSION_LIFETIME_MS / 1_000,
  ));
  params.set("client_reference_id", `${FORT_PASS_KIND}:${customRoomCode}`);
  params.set("success_url", `${baseUrl}/?fort_pass=success&code=${encodeURIComponent(customRoomCode)}&session_id={CHECKOUT_SESSION_ID}`);
  params.set("cancel_url", `${baseUrl}/?fort_pass=cancel&code=${encodeURIComponent(customRoomCode)}`);
  appendCheckoutMetadata(params, customRoomCode, priceId, claimHash);

  const res = await stripeApiFetch(config.fetcher, "https://api.stripe.com/v1/checkout/sessions", config.secretKey, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  }, config.timeoutMs);

  const data = await readStripeJson(res).catch(() => null) as { id?: unknown; url?: unknown; error?: unknown } | null;
  if (!res.ok) {
    throw new Error("stripe checkout session failed");
  }
  const checkoutUrl = normalizeStripeHostedCheckoutUrl(data?.url);
  if (!data || typeof data.id !== "string" || !STRIPE_CHECKOUT_SESSION_ID_RE.test(data.id) || !checkoutUrl) {
    throw new Error("stripe checkout session response invalid");
  }
  return { id: data.id, url: checkoutUrl };
}

function parseFortPassEventCandidate(input: unknown): StripeFortPassEventCandidate | "ignored" | null {
  const event = plainRecord(input);
  if (!event) return null;
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return "ignored";
  }
  if (event.object !== "event" || typeof event.id !== "string" || !STRIPE_EVENT_ID_RE.test(event.id)) return null;
  if (typeof event.livemode !== "boolean") return null;

  const data = plainRecord(event.data);
  const session = plainRecord(data?.object);
  const metadata = plainRecord(session?.metadata);
  if (!session || !metadata || session.object !== "checkout.session") return null;
  if (typeof session.id !== "string" || !STRIPE_CHECKOUT_SESSION_ID_RE.test(session.id)) return null;
  if (session.mode !== "payment" || session.payment_status !== "paid") return null;
  if (typeof session.livemode !== "boolean" || session.livemode !== event.livemode) return null;
  if (!Number.isSafeInteger(session.created) || (session.created as number) < 0) return null;
  if (metadata.kind !== FORT_PASS_KIND || metadata.entitlement_kind !== FORT_PASS_KIND) return null;

  const roomId = normalizeCustomRoomCode(metadata.custom_room_code);
  if (!roomId || metadata.custom_room_code !== roomId) return null;
  if (session.client_reference_id !== `${FORT_PASS_KIND}:${roomId}`) return null;

  return {
    eventId: event.id,
    eventType: event.type,
    sessionId: session.id,
    roomId,
    createdSeconds: session.created as number,
    livemode: event.livemode,
  };
}

function parseFortPassRevocationCandidate(input: unknown): StripeFortPassRevocationCandidate | "ignored" | null {
  const event = plainRecord(input);
  if (!event) return null;
  if (event.type !== "charge.refunded" && event.type !== "charge.dispute.created") return "ignored";
  if (event.object !== "event" || typeof event.id !== "string" || !STRIPE_EVENT_ID_RE.test(event.id)) return null;
  if (typeof event.livemode !== "boolean") return null;
  const data = plainRecord(event.data);
  const object = plainRecord(data?.object);
  if (!object || typeof object.livemode !== "boolean" || object.livemode !== event.livemode) return null;

  if (event.type === "charge.refunded") {
    if (
      object.object !== "charge"
      || typeof object.id !== "string" || !STRIPE_CHARGE_ID_RE.test(object.id)
      || typeof object.payment_intent !== "string" || !STRIPE_PAYMENT_INTENT_ID_RE.test(object.payment_intent)
    ) return null;
    return {
      eventId: event.id,
      eventType: event.type,
      objectId: object.id,
      chargeId: object.id,
      paymentIntentId: object.payment_intent,
      livemode: event.livemode,
      reason: "refund",
    };
  }

  if (
    object.object !== "dispute"
    || typeof object.id !== "string" || !STRIPE_DISPUTE_ID_RE.test(object.id)
    || typeof object.charge !== "string" || !STRIPE_CHARGE_ID_RE.test(object.charge)
    || (object.payment_intent !== null
      && (typeof object.payment_intent !== "string" || !STRIPE_PAYMENT_INTENT_ID_RE.test(object.payment_intent)))
  ) return null;
  return {
    eventId: event.id,
    eventType: event.type,
    objectId: object.id,
    chargeId: object.charge,
    paymentIntentId: object.payment_intent,
    livemode: event.livemode,
    reason: "dispute",
  };
}

interface VerifiedStripeSessionBinding {
  session: Record<string, unknown>;
  createdAt: number;
  claimHash: string;
}

function verifiedStripeSessionBinding(
  candidate: StripeFortPassSessionCandidate,
  sessionInput: unknown,
  expectedPriceId: string,
  expectedMode: StripeMode,
): VerifiedStripeSessionBinding | null {
  const session = plainRecord(sessionInput);
  const metadata = plainRecord(session?.metadata);
  const lineItems = plainRecord(session?.line_items);
  if (!session || !metadata || !lineItems) return null;
  if (
    session.id !== candidate.sessionId
    || session.object !== "checkout.session"
    || session.mode !== "payment"
    || session.client_reference_id !== `${FORT_PASS_KIND}:${candidate.roomId}`
    || session.created !== candidate.createdSeconds
    || session.livemode !== candidate.livemode
    || session.livemode !== (expectedMode === "live")
    || metadata.kind !== FORT_PASS_KIND
    || metadata.entitlement_kind !== FORT_PASS_KIND
    || metadata.custom_room_code !== candidate.roomId
  ) {
    return null;
  }

  // New sessions carry this redundant signed binding. In-flight sessions made
  // before the field existed remain valid only because the authoritative line
  // item below still proves the configured Price directly from Stripe.
  if (metadata.price_id !== undefined && metadata.price_id !== expectedPriceId) return null;
  const claimHash = normalizeFortPassClaimHash(metadata.claim_hash);
  if (!claimHash) return null;
  if (lineItems.object !== "list" || lineItems.has_more !== false || !Array.isArray(lineItems.data) || lineItems.data.length !== 1) {
    return null;
  }

  const line = plainRecord(lineItems.data[0]);
  const price = plainRecord(line?.price);
  if (!line || !price) return null;
  if (
    line.object !== "item"
    || line.quantity !== 1
    || price.object !== "price"
    || price.id !== expectedPriceId
    || price.type !== "one_time"
    || price.livemode !== candidate.livemode
  ) {
    return null;
  }

  const amountTotal = session.amount_total;
  const amountSubtotal = session.amount_subtotal;
  const lineTotal = line.amount_total;
  const lineSubtotal = line.amount_subtotal;
  const unitAmount = price.unit_amount;
  const currency = session.currency;
  if (
    !Number.isSafeInteger(amountTotal) || (amountTotal as number) <= 0
    || !Number.isSafeInteger(amountSubtotal) || (amountSubtotal as number) <= 0
    || !Number.isSafeInteger(lineTotal) || lineTotal !== amountTotal
    || !Number.isSafeInteger(lineSubtotal) || lineSubtotal !== amountSubtotal
    || !Number.isSafeInteger(unitAmount) || unitAmount !== amountSubtotal
    || typeof currency !== "string" || !/^[a-z]{3}$/u.test(currency)
    || line.currency !== currency || price.currency !== currency
  ) {
    return null;
  }

  const createdAt = candidate.createdSeconds * 1_000;
  return Number.isSafeInteger(createdAt) ? { session, createdAt, claimHash } : null;
}

function entitlementFromVerifiedSession(
  candidate: StripeFortPassSessionCandidate,
  sessionInput: unknown,
  expectedPriceId: string,
  expectedMode: StripeMode,
  now: number,
): FortPassEntitlement | null {
  const binding = verifiedStripeSessionBinding(candidate, sessionInput, expectedPriceId, expectedMode);
  if (!binding
    || binding.session.payment_status !== "paid"
    || binding.session.status !== "complete"
    || binding.createdAt > now + STRIPE_WEBHOOK_TOLERANCE_SECONDS * 1_000) return null;
  const createdAt = binding.createdAt;
  const expiresAt = createdAt + FORT_PASS_MAX_LIFETIME_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;

  const entitlement = normalizeFortPassEntitlement({
    v: 1,
    kind: FORT_PASS_KIND,
    status: "active",
    roomId: candidate.roomId,
    hostRef: candidate.sessionId,
    provider: "stripe",
    providerRef: candidate.sessionId,
    createdAt,
    expiresAt,
    perks: {
      customRoomCode: candidate.roomId,
      extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS,
      themePack: "retro-plus",
    },
  }, now);
  return entitlement?.status === "active" ? entitlement : null;
}

/**
 * Validate a signed event only when its Checkout Session already includes an
 * authoritative expanded line_items list. Production uses
 * resolveFortPassEntitlementFromStripeEvent, which retrieves that object from
 * Stripe instead of trusting the webhook's metadata as proof of purchase.
 */
export function fortPassEntitlementFromStripeEvent(
  input: unknown,
  expectedPriceId: string,
  now = Date.now(),
  expectedMode: StripeMode = "test",
): FortPassEntitlement | null {
  const priceId = normalizeStripePriceId(expectedPriceId);
  const candidate = parseFortPassEventCandidate(input);
  if (!priceId || !candidate || candidate === "ignored") return null;
  const event = plainRecord(input)!;
  const data = plainRecord(event.data)!;
  return entitlementFromVerifiedSession(candidate, data.object, priceId, expectedMode, now);
}

async function retrieveStripeCheckoutSession(
  sessionId: string,
  config: StripeEntitlementResolutionConfig,
): Promise<unknown> {
  const url = new URL(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  url.searchParams.append("expand[]", "line_items.data.price");
  const response = await stripeApiFetch(config.fetcher, url.href, config.secretKey, {
    method: "GET",
    headers: { "accept": "application/json" },
  }, config.timeoutMs);
  const body = await readStripeJson(response);
  if (!response.ok) throw new Error("stripe checkout session retrieval failed");
  return body;
}

async function retrieveStripeResource(
  kind: "charges" | "disputes",
  resourceId: string,
  config: StripeEntitlementResolutionConfig,
): Promise<unknown> {
  const response = await stripeApiFetch(
    config.fetcher,
    `https://api.stripe.com/v1/${kind}/${encodeURIComponent(resourceId)}`,
    config.secretKey,
    { method: "GET", headers: { "accept": "application/json" } },
    config.timeoutMs,
  );
  const body = await readStripeJson(response);
  if (!response.ok) throw new Error(`stripe ${kind} retrieval failed`);
  return body;
}

async function retrieveStripeCheckoutSessionForPaymentIntent(
  paymentIntentId: string,
  config: StripeEntitlementResolutionConfig,
): Promise<unknown> {
  const url = new URL("https://api.stripe.com/v1/checkout/sessions");
  url.searchParams.set("payment_intent", paymentIntentId);
  // Request two so an unexpected duplicate binding is detectable instead of
  // silently selecting whichever object Stripe happens to return first.
  url.searchParams.set("limit", "2");
  url.searchParams.append("expand[]", "data.line_items.data.price");
  const response = await stripeApiFetch(config.fetcher, url.href, config.secretKey, {
    method: "GET",
    headers: { "accept": "application/json" },
  }, config.timeoutMs);
  const body = await readStripeJson(response);
  if (!response.ok) throw new Error("stripe checkout session lookup failed");
  return body;
}

interface VerifiedStripeCharge {
  amount: number;
  currency: string;
  paymentIntentId: string;
}

function verifiedStripeCharge(
  input: unknown,
  candidate: StripeFortPassRevocationCandidate,
  expectedMode: StripeMode,
): VerifiedStripeCharge | null {
  const charge = plainRecord(input);
  if (!charge
    || charge.object !== "charge"
    || charge.id !== candidate.chargeId
    || charge.livemode !== candidate.livemode
    || charge.livemode !== (expectedMode === "live")
    || typeof charge.payment_intent !== "string" || !STRIPE_PAYMENT_INTENT_ID_RE.test(charge.payment_intent)
    || (candidate.paymentIntentId !== null && charge.payment_intent !== candidate.paymentIntentId)
    || charge.paid !== true
    || charge.captured !== true
    || !Number.isSafeInteger(charge.amount) || (charge.amount as number) <= 0
    || !Number.isSafeInteger(charge.amount_captured) || charge.amount_captured !== charge.amount
    || typeof charge.currency !== "string" || !/^[a-z]{3}$/u.test(charge.currency)) return null;

  if (candidate.reason === "refund") {
    if (!Number.isSafeInteger(charge.amount_refunded)
      || (charge.amount_refunded as number) <= 0
      || (charge.amount_refunded as number) > (charge.amount as number)
      || charge.refunded !== (charge.amount_refunded === charge.amount)) return null;
  }

  return {
    amount: charge.amount as number,
    currency: charge.currency,
    paymentIntentId: charge.payment_intent,
  };
}

function verifiedActiveStripeDispute(
  input: unknown,
  candidate: StripeFortPassRevocationCandidate,
  charge: VerifiedStripeCharge,
  expectedMode: StripeMode,
): boolean {
  const dispute = plainRecord(input);
  if (!dispute
    || dispute.object !== "dispute"
    || dispute.id !== candidate.objectId
    || dispute.charge !== candidate.chargeId
    || (dispute.payment_intent !== null && dispute.payment_intent !== charge.paymentIntentId)
    || (candidate.paymentIntentId !== null && dispute.payment_intent !== candidate.paymentIntentId)
    || dispute.livemode !== candidate.livemode
    || dispute.livemode !== (expectedMode === "live")
    || !Number.isSafeInteger(dispute.amount) || (dispute.amount as number) <= 0
    || (dispute.amount as number) > charge.amount
    || dispute.currency !== charge.currency) return false;
  // A delayed `created` delivery must not revoke an entitlement after Stripe
  // has authoritatively resolved the dispute in the merchant's favor or
  // prevented/closed the inquiry.
  return dispute.status === "needs_response"
    || dispute.status === "under_review"
    || dispute.status === "lost"
    || dispute.status === "warning_needs_response"
    || dispute.status === "warning_under_review";
}

function verifiedStripeSessionForPaymentIntent(
  input: unknown,
  paymentIntentId: string,
  expectedPriceId: string,
  expectedMode: StripeMode,
  eventLivemode: boolean,
  charge: VerifiedStripeCharge,
): { sessionId: string; roomId: string } | null {
  const list = plainRecord(input);
  if (!list || list.object !== "list" || list.has_more !== false || !Array.isArray(list.data) || list.data.length !== 1) {
    return null;
  }
  const session = plainRecord(list.data[0]);
  const metadata = plainRecord(session?.metadata);
  if (!session || !metadata
    || typeof session.id !== "string" || !STRIPE_CHECKOUT_SESSION_ID_RE.test(session.id)
    || session.payment_intent !== paymentIntentId
    || session.payment_status !== "paid"
    || session.status !== "complete"
    || session.livemode !== eventLivemode
    || !Number.isSafeInteger(session.created) || (session.created as number) < 0) return null;
  const roomId = normalizeCustomRoomCode(metadata.custom_room_code);
  if (!roomId || metadata.custom_room_code !== roomId) return null;
  const candidate: StripeFortPassSessionCandidate = {
    sessionId: session.id,
    roomId,
    createdSeconds: session.created as number,
    livemode: eventLivemode,
  };
  const binding = verifiedStripeSessionBinding(candidate, session, expectedPriceId, expectedMode);
  if (!binding
    || binding.session.amount_total !== charge.amount
    || binding.session.currency !== charge.currency) return null;
  return { sessionId: candidate.sessionId, roomId };
}

function candidateFromRetrievedSession(
  input: unknown,
  requestedSessionId: string,
  expectedRoomId: string,
): StripeFortPassSessionCandidate | null {
  const session = plainRecord(input);
  const metadata = plainRecord(session?.metadata);
  if (!session || !metadata
    || session.object !== "checkout.session"
    || session.id !== requestedSessionId
    || typeof session.livemode !== "boolean"
    || !Number.isSafeInteger(session.created) || (session.created as number) < 0
    || metadata.kind !== FORT_PASS_KIND
    || metadata.entitlement_kind !== FORT_PASS_KIND
    || metadata.custom_room_code !== expectedRoomId) return null;
  return {
    sessionId: requestedSessionId,
    roomId: expectedRoomId,
    createdSeconds: session.created as number,
    livemode: session.livemode,
  };
}

/**
 * Resolve a Checkout return or prior reservation owner directly against
 * Stripe. The Session ID is only a lookup capability: paid status, exact room
 * metadata, configured Price, quantity, amount, currency, and test/live mode
 * all come from the independently retrieved provider object.
 */
export async function resolveFortPassCheckoutSession(
  sessionIdInput: unknown,
  roomIdInput: unknown,
  config: StripeEntitlementResolutionConfig,
): Promise<StripeCheckoutSessionResolution> {
  const sessionId = normalizeStripeCheckoutSessionId(sessionIdInput);
  const roomId = normalizeCustomRoomCode(roomIdInput);
  if (!sessionId || !roomId || roomId !== roomIdInput) return { status: "invalid" };

  const priceId = normalizeStripePriceId(config.priceId);
  const mode = stripeModeFromSecret(config.secretKey);
  if (!priceId || !mode) return { status: "unavailable" };

  let sessionInput: unknown;
  try {
    sessionInput = await retrieveStripeCheckoutSession(sessionId, config);
  } catch {
    return { status: "unavailable" };
  }
  const candidate = candidateFromRetrievedSession(sessionInput, sessionId, roomId);
  if (!candidate) return { status: "invalid" };
  const binding = verifiedStripeSessionBinding(candidate, sessionInput, priceId, mode);
  if (!binding) return { status: "invalid" };

  const now = config.now ?? Date.now();
  if (binding.createdAt > now + STRIPE_WEBHOOK_TOLERANCE_SECONDS * 1_000) return { status: "invalid" };
  const entitlement = entitlementFromVerifiedSession(candidate, sessionInput, priceId, mode, now);
  if (entitlement) return { status: "verified", sessionId, roomId, claimHash: binding.claimHash, entitlement };
  if (binding.session.status === "expired" && binding.session.payment_status === "unpaid") {
    return { status: "expired_unpaid", sessionId, roomId, claimHash: binding.claimHash };
  }
  if (
    (binding.session.status === "open" || binding.session.status === "complete")
    && binding.session.payment_status !== "paid"
  ) {
    return { status: "pending", sessionId, roomId, claimHash: binding.claimHash };
  }
  return { status: "invalid" };
}

export async function resolveFortPassEntitlementFromStripeEvent(
  input: unknown,
  config: StripeEntitlementResolutionConfig,
): Promise<StripeEntitlementResolution> {
  const candidate = parseFortPassEventCandidate(input);
  if (candidate === "ignored") return { status: "ignored" };
  if (!candidate) return { status: "invalid", reason: "event" };

  const priceId = normalizeStripePriceId(config.priceId);
  const mode = stripeModeFromSecret(config.secretKey);
  if (!priceId || !mode) return { status: "unavailable" };

  let session: unknown;
  try {
    session = await retrieveStripeCheckoutSession(candidate.sessionId, config);
  } catch {
    return { status: "unavailable" };
  }

  const entitlement = entitlementFromVerifiedSession(
    candidate,
    session,
    priceId,
    mode,
    config.now ?? Date.now(),
  );
  return entitlement
    ? {
        status: "verified",
        eventId: candidate.eventId,
        sessionId: candidate.sessionId,
        claimHash: verifiedStripeSessionBinding(candidate, session, priceId, mode)!.claimHash,
        entitlement,
      }
    : { status: "invalid", reason: "session_binding" };
}

/**
 * Resolve refund/dispute revocation from a signed webhook event. Event fields
 * are lookup capabilities only: Stripe's current Charge/Dispute and the one
 * Checkout Session linked to the exact PaymentIntent must independently bind
 * the configured Price, room, amount, currency, and test/live mode.
 */
export async function resolveFortPassRevocationFromStripeEvent(
  input: unknown,
  config: StripeEntitlementResolutionConfig,
): Promise<StripeRevocationResolution> {
  const candidate = parseFortPassRevocationCandidate(input);
  if (candidate === "ignored") return { status: "ignored" };
  if (!candidate) return { status: "invalid", reason: "event" };

  const priceId = normalizeStripePriceId(config.priceId);
  const mode = stripeModeFromSecret(config.secretKey);
  if (!priceId || !mode) return { status: "unavailable" };

  let chargeInput: unknown;
  let disputeInput: unknown;
  let sessionsInput: unknown;
  try {
    if (candidate.reason === "dispute") {
      disputeInput = await retrieveStripeResource("disputes", candidate.objectId, config);
    }
    chargeInput = await retrieveStripeResource("charges", candidate.chargeId, config);
    // The authoritative Charge supplies the PaymentIntent when a pre-dispute
    // warning legitimately exposes `payment_intent: null` on the Dispute.
  } catch {
    return { status: "unavailable" };
  }

  const charge = verifiedStripeCharge(chargeInput, candidate, mode);
  if (!charge) return { status: "invalid", reason: "provider_binding" };
  if (candidate.reason === "dispute" && !verifiedActiveStripeDispute(disputeInput, candidate, charge, mode)) {
    return { status: "invalid", reason: "provider_binding" };
  }
  try {
    sessionsInput = await retrieveStripeCheckoutSessionForPaymentIntent(charge.paymentIntentId, config);
  } catch {
    return { status: "unavailable" };
  }
  const session = verifiedStripeSessionForPaymentIntent(
    sessionsInput,
    charge.paymentIntentId,
    priceId,
    mode,
    candidate.livemode,
    charge,
  );
  return session
    ? {
        status: "verified",
        eventId: candidate.eventId,
        sessionId: session.sessionId,
        roomId: session.roomId,
        reason: candidate.reason,
      }
    : { status: "invalid", reason: "session_binding" };
}
