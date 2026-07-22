import { analyticsLogLine, readAnalyticsEvent } from "./analytics";
import { constantTimeFortPassClaimHashEqual, customRoomCodeAvailability, fortPassClaimHash, normalizeCustomRoomCode, normalizeFortPassCheckoutRequest, normalizeRoomId, type FortPassEntitlement } from "./entitlements";
import { checkoutPublicOrigin, isJsonRequest, isLoopbackHostname, isStrictSameOriginRequest } from "./httpBoundary";
import { FORT_PASS_CHECKOUT_PATH, FORT_PASS_CODE_PATH, FORT_PASS_REDEEM_PATH, FORT_PASS_STATUS_PATH, ROOM_FORT_PASS_FULFILL_PATH, ROOM_FORT_PASS_RESERVATION_PATH, ROOM_FORT_PASS_RESERVE_PATH, ROOM_FORT_PASS_REVOKE_PATH, ROOM_STATUS_PATH, ROOM_STRIPE_SESSION_LEDGER_PATH, ROOM_WS_OPEN_LIMIT_PATH, STRIPE_WEBHOOK_PATH } from "./routes";
import { readByteLimitedText } from "./requestBody";
import { blockedProbeResponse, isDiscordActivityRequest, logBlockedProbe, logRateLimitedOpsEvent, probeReasonForPath, withSecurityHeaders, type SecurityHeaderMode } from "./security";
import { createFortPassStripeCheckoutSession, createStripeFulfillmentClaimToken, normalizeStripeCheckoutSessionId, normalizeStripeRedemptionRequest, resolveFortPassCheckoutSession, resolveFortPassEntitlementFromStripeEvent, resolveFortPassRevocationFromStripeEvent, stripeFulfillmentSessionKey, stripeRevocationEventKey, verifyStripeWebhookSignature, type StripeFortPassRevocationReason } from "./stripe";

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  STRIPE_SECRET_KEY?: string;
  FORT_PASS_PRICE_ID?: string;
  PUBLIC_BASE_URL?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_FETCHER?: typeof fetch;
}

export { Room } from "./room";
export { isStrictSameOriginRequest, normalizePublicCheckoutOrigin } from "./httpBoundary";

const CHECKOUT_LIMIT_SLOTS = 3;
const CHECKOUT_LIMIT_RETRY_SECONDS = 30 * 60;

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function readSmallJson(request: Request): Promise<unknown | null> {
  const body = await readByteLimitedText(request, 1024);
  if (!body.ok || !body.text) return null;
  try {
    return JSON.parse(body.text);
  } catch {
    return null;
  }
}

function sourceAddress(request: Request, url: URL): string | null {
  const value = request.headers.get("cf-connecting-ip");
  if (value && value.length <= 64 && /^[0-9a-f:.]+$/i.test(value)) return value;
  // Wrangler's local runtime may not synthesize the Cloudflare header. Local
  // development still gets one shared limiter without trusting X-Forwarded-For.
  return isLoopbackHostname(url.hostname) ? "local-development" : null;
}

async function checkoutSourceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:fort-pass-checkout-limit:v1:${source}`)
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

type CheckoutLimitResult = "allowed" | "limited" | "unavailable";
type WebSocketOpenLimitResult = "allowed" | "limited" | "unavailable";
type PublicSurfaceLimitResult = "allowed" | "limited" | "unavailable";

async function publicSurfaceSourceHash(source: string, scope: "analytics" | "fort-pass-code"): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:public-surface-limit:v1:${scope}:${source}`),
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function takePublicSurfaceRateLimitSlot(
  env: Env,
  request: Request,
  url: URL,
  scope: "analytics" | "fort-pass-code",
): Promise<PublicSurfaceLimitResult> {
  const source = sourceAddress(request, url);
  if (!source) return "unavailable";
  const sourceHash = await publicSurfaceSourceHash(source, scope);
  try {
    const id = env.ROOM.idFromName(`__public_surface_limit__:${scope}:${sourceHash}`);
    const response = await env.ROOM.get(id).fetch(new Request(
      new URL(ROOM_WS_OPEN_LIMIT_PATH, request.url),
      { method: "POST" },
    ));
    if (response.status === 204) return "allowed";
    return response.status === 429 ? "limited" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function webSocketSourceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pillowfort:websocket-open-limit:v1:${source}`),
  );
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function takeWebSocketOpenRateLimitSlot(
  env: Env,
  request: Request,
  url: URL,
): Promise<WebSocketOpenLimitResult> {
  const source = sourceAddress(request, url);
  if (!source) return "unavailable";
  const sourceHash = await webSocketSourceHash(source);
  try {
    const id = env.ROOM.idFromName(`__ws_open_limit__:${sourceHash}`);
    const limitUrl = new URL(ROOM_WS_OPEN_LIMIT_PATH, request.url);
    const response = await env.ROOM.get(id).fetch(new Request(limitUrl, { method: "POST" }));
    if (response.status === 204) return "allowed";
    return response.status === 429 ? "limited" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function takeCheckoutRateLimitSlot(env: Env, request: Request, url: URL): Promise<CheckoutLimitResult> {
  const source = sourceAddress(request, url);
  if (!source) return "unavailable";
  const sourceHash = await checkoutSourceHash(source);

  try {
    for (let slot = 0; slot < CHECKOUT_LIMIT_SLOTS; slot++) {
      const id = env.ROOM.idFromName(`__fort_pass_checkout_limit__:${sourceHash}:${slot}`);
      const limitUrl = new URL(ROOM_FORT_PASS_RESERVE_PATH, request.url);
      const response = await env.ROOM.get(id).fetch(new Request(limitUrl, { method: "POST" }));
      if (response.ok) return "allowed";
      if (response.status !== 409) return "unavailable";
    }
    return "limited";
  } catch {
    return "unavailable";
  }
}

async function roomExists(env: Env, roomId: string, request: Request): Promise<boolean> {
  const id = env.ROOM.idFromName(roomId);
  const url = new URL(ROOM_STATUS_PATH, request.url);
  const res = await env.ROOM.get(id).fetch(new Request(url, { method: "GET" }));
  if (!res.ok) return true;
  const status = await res.json().catch(() => null) as { exists?: unknown } | null;
  return status?.exists === true;
}

async function fulfillFortPass(
  env: Env,
  entitlement: FortPassEntitlement,
  claimHash: string,
  request: Request,
): Promise<boolean> {
  const id = env.ROOM.idFromName(entitlement.roomId);
  const url = new URL(ROOM_FORT_PASS_FULFILL_PATH, request.url);
  const res = await env.ROOM.get(id).fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entitlement, claimHash }),
  }));
  return res.ok;
}

type FortPassReservationClaim =
  | { status: "claimed"; token: string }
  | { status: "supersession_required"; token: string; sessionId: string }
  | { status: "conflict" }
  | { status: "unavailable" };

async function targetFortPassReservationRequest(
  env: Env,
  request: Request,
  roomId: string,
  body: Record<string, string>,
): Promise<Response | null> {
  try {
    const id = env.ROOM.idFromName(roomId);
    return await env.ROOM.get(id).fetch(new Request(
      new URL(ROOM_FORT_PASS_RESERVATION_PATH, request.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ));
  } catch {
    return null;
  }
}

async function claimTargetFortPassReservation(
  env: Env,
  request: Request,
  roomId: string,
  claimHash: string,
): Promise<FortPassReservationClaim> {
  const token = createStripeFulfillmentClaimToken();
  const response = await targetFortPassReservationRequest(env, request, roomId, {
    action: "claim", token, claimHash,
  });
  if (!response) return { status: "unavailable" };
  if (response.status === 201) return { status: "claimed", token };
  if (response.status === 409) return { status: "conflict" };
  if (response.status !== 200) return { status: "unavailable" };
  const value = await response.json().catch(() => null) as Record<string, unknown> | null;
  const sessionId = normalizeStripeCheckoutSessionId(value?.sessionId);
  return value?.status === "supersession-required" && sessionId
    ? { status: "supersession_required", token, sessionId }
    : { status: "unavailable" };
}

async function supersedeTargetFortPassReservation(
  env: Env,
  request: Request,
  roomId: string,
  token: string,
  priorSessionId: string,
  claimHash: string,
): Promise<"claimed" | "conflict" | "unavailable"> {
  const response = await targetFortPassReservationRequest(env, request, roomId, {
    action: "supersede", token, priorSessionId, claimHash,
  });
  if (!response) return "unavailable";
  if (response.status === 201) return "claimed";
  return response.status === 409 ? "conflict" : "unavailable";
}

async function bindTargetFortPassReservation(
  env: Env,
  request: Request,
  roomId: string,
  token: string,
  sessionId: string,
): Promise<boolean> {
  const response = await targetFortPassReservationRequest(env, request, roomId, {
    action: "bind", token, sessionId,
  });
  return response?.status === 204;
}

type StripeLedgerClaim =
  | { status: "claimed"; token: string; sessionKey: string }
  | { status: "complete" }
  | { status: "busy"; retryAfter: string | null }
  | { status: "unavailable" };

async function stripeLedgerRequest(
  env: Env,
  request: Request,
  sessionKey: string,
  action: "claim" | "complete" | "release",
  roomId: string,
  token: string,
): Promise<Response | null> {
  try {
    const id = env.ROOM.idFromName(`__stripe_fulfillment__:${sessionKey}`);
    return await env.ROOM.get(id).fetch(new Request(
      new URL(ROOM_STRIPE_SESSION_LEDGER_PATH, request.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, roomId, token }),
      },
    ));
  } catch {
    return null;
  }
}

async function claimStripeFulfillment(
  env: Env,
  request: Request,
  sessionId: string,
  roomId: string,
): Promise<StripeLedgerClaim> {
  const sessionKey = await stripeFulfillmentSessionKey(sessionId);
  const token = createStripeFulfillmentClaimToken();
  const response = await stripeLedgerRequest(env, request, sessionKey, "claim", roomId, token);
  if (!response) return { status: "unavailable" };
  if (response.status === 201) return { status: "claimed", token, sessionKey };
  if (response.status === 200) return { status: "complete" };
  if (response.status === 409) return { status: "busy", retryAfter: response.headers.get("retry-after") };
  return { status: "unavailable" };
}

async function finishStripeFulfillment(
  env: Env,
  request: Request,
  claim: Extract<StripeLedgerClaim, { status: "claimed" }>,
  roomId: string,
  action: "complete" | "release",
): Promise<boolean> {
  const response = await stripeLedgerRequest(env, request, claim.sessionKey, action, roomId, claim.token);
  return !!response && response.status === 204;
}

type StripeFulfillmentOutcome =
  | { status: "fulfilled"; replay: boolean }
  | { status: "busy"; retryAfter: string | null }
  | { status: "ledger_unavailable" }
  | { status: "fulfillment_failed" }
  | { status: "ledger_completion_failed" };

async function fulfillVerifiedStripeSession(
  env: Env,
  request: Request,
  sessionId: string,
  claimHash: string,
  entitlement: FortPassEntitlement,
): Promise<StripeFulfillmentOutcome> {
  const claim = await claimStripeFulfillment(env, request, sessionId, entitlement.roomId);
  if (claim.status === "complete") return { status: "fulfilled", replay: true };
  if (claim.status === "busy") return { status: "busy", retryAfter: claim.retryAfter };
  if (claim.status === "unavailable") return { status: "ledger_unavailable" };

  if (!await fulfillFortPass(env, entitlement, claimHash, request)) {
    await finishStripeFulfillment(env, request, claim, entitlement.roomId, "release");
    return { status: "fulfillment_failed" };
  }
  if (!await finishStripeFulfillment(env, request, claim, entitlement.roomId, "complete")) {
    // The target room keeps a durable providerRef tombstone, so retrying after
    // the lease expires cannot grant this paid session twice.
    return { status: "ledger_completion_failed" };
  }
  return { status: "fulfilled", replay: false };
}

async function revokeTargetFortPass(
  env: Env,
  request: Request,
  roomId: string,
  sessionId: string,
  reason: StripeFortPassRevocationReason,
): Promise<"revoked" | "stale" | "unavailable"> {
  try {
    const id = env.ROOM.idFromName(roomId);
    const response = await env.ROOM.get(id).fetch(new Request(
      new URL(ROOM_FORT_PASS_REVOKE_PATH, request.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, reason }),
      },
    ));
    if (response.status !== 200) return "unavailable";
    const body = await readByteLimitedText(response, 512);
    if (!body.ok || !body.text) return "unavailable";
    const value = JSON.parse(body.text) as Record<string, unknown>;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value).sort().join(",");
      if (value.revoked === false && value.stale === true && keys === "revoked,stale") return "stale";
      if (
        value.revoked === true
        && typeof value.replay === "boolean"
        && (value.reason === "refund" || value.reason === "dispute")
        && keys === "reason,replay,revoked"
      ) return "revoked";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

async function stripeRevocationLedgerRequest(
  env: Env,
  request: Request,
  eventKey: string,
  action: "claim" | "complete" | "release",
  roomId: string,
  token: string,
): Promise<Response | null> {
  try {
    const id = env.ROOM.idFromName(`__stripe_revocation__:${eventKey}`);
    return await env.ROOM.get(id).fetch(new Request(
      new URL(ROOM_STRIPE_SESSION_LEDGER_PATH, request.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, roomId, token }),
      },
    ));
  } catch {
    return null;
  }
}

async function claimStripeRevocation(
  env: Env,
  request: Request,
  eventId: string,
  roomId: string,
): Promise<StripeLedgerClaim> {
  let eventKey: string;
  try {
    eventKey = await stripeRevocationEventKey(eventId);
  } catch {
    return { status: "unavailable" };
  }
  const token = createStripeFulfillmentClaimToken();
  const response = await stripeRevocationLedgerRequest(env, request, eventKey, "claim", roomId, token);
  if (!response) return { status: "unavailable" };
  if (response.status === 201) return { status: "claimed", token, sessionKey: eventKey };
  if (response.status === 200) return { status: "complete" };
  if (response.status === 409) return { status: "busy", retryAfter: response.headers.get("retry-after") };
  return { status: "unavailable" };
}

async function finishStripeRevocation(
  env: Env,
  request: Request,
  claim: Extract<StripeLedgerClaim, { status: "claimed" }>,
  roomId: string,
  action: "complete" | "release",
): Promise<boolean> {
  const response = await stripeRevocationLedgerRequest(
    env, request, claim.sessionKey, action, roomId, claim.token,
  );
  return !!response && response.status === 204;
}

type StripeRevocationOutcome =
  | { status: "processed"; revoked: boolean; stale: boolean; replay: boolean }
  | { status: "busy"; retryAfter: string | null }
  | { status: "ledger_unavailable" | "target_unavailable" | "ledger_completion_failed" };

async function revokeVerifiedStripeSession(
  env: Env,
  request: Request,
  eventId: string,
  sessionId: string,
  roomId: string,
  reason: StripeFortPassRevocationReason,
): Promise<StripeRevocationOutcome> {
  const claim = await claimStripeRevocation(env, request, eventId, roomId);
  if (claim.status === "complete") {
    return { status: "processed", revoked: false, stale: false, replay: true };
  }
  if (claim.status === "busy") return { status: "busy", retryAfter: claim.retryAfter };
  if (claim.status === "unavailable") return { status: "ledger_unavailable" };

  const target = await revokeTargetFortPass(env, request, roomId, sessionId, reason);
  if (target === "unavailable") {
    await finishStripeRevocation(env, request, claim, roomId, "release");
    return { status: "target_unavailable" };
  }
  if (!await finishStripeRevocation(env, request, claim, roomId, "complete")) {
    // The room writes the entitlement tombstone transactionally before this
    // point, so a Stripe retry remains safe after the global lease expires.
    return { status: "ledger_completion_failed" };
  }
  return {
    status: "processed",
    revoked: target === "revoked",
    stale: target === "stale",
    replay: false,
  };
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const probeReason = probeReasonForPath(url.pathname);
  if (probeReason) {
    logBlockedProbe(url.pathname);
    return blockedProbeResponse();
  }

  if (url.pathname === "/analytics") {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!isStrictSameOriginRequest(request)) return new Response("forbidden", { status: 403 });
    if (!isJsonRequest(request)) return new Response("unsupported media type", { status: 415 });
    const analyticsLimit = await takePublicSurfaceRateLimitSlot(env, request, url, "analytics");
    if (analyticsLimit !== "allowed") {
      return new Response(analyticsLimit === "limited" ? "rate limited" : "source unavailable", {
        status: analyticsLimit === "limited" ? 429 : 503,
        headers: {
          "cache-control": "no-store",
          ...(analyticsLimit === "limited" ? { "retry-after": "60" } : {}),
        },
      });
    }
    const event = await readAnalyticsEvent(request);
    if (!event) return new Response("bad analytics event", { status: 400 });
    console.log(analyticsLogLine(event));
    return new Response(null, { status: 204 });
  }

  if (url.pathname === FORT_PASS_CODE_PATH) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const codeParameters = url.searchParams.getAll("code");
    const code = codeParameters.length === 1 ? normalizeCustomRoomCode(codeParameters[0]) : null;
    if (!code) return json(customRoomCodeAvailability(null, false));
    const codeLimit = await takePublicSurfaceRateLimitSlot(env, request, url, "fort-pass-code");
    if (codeLimit !== "allowed") {
      return json(
        { error: codeLimit === "limited" ? "code_check_rate_limited" : "code_check_source_unavailable" },
        codeLimit === "limited" ? 429 : 503,
        codeLimit === "limited" ? { "retry-after": "60" } : undefined,
      );
    }
    return json(customRoomCodeAvailability(code, await roomExists(env, code, request)));
  }

  if (url.pathname === FORT_PASS_STATUS_PATH) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    return json({
      beta: true,
      checkoutConfigured: Boolean(
        env.STRIPE_SECRET_KEY
        && env.FORT_PASS_PRICE_ID
        && env.STRIPE_WEBHOOK_SECRET
        && checkoutPublicOrigin(env.PUBLIC_BASE_URL, url)
      ),
      priceLabel: "$5",
      perks: ["custom_code", "extended_idle", "theme_pack"],
    });
  }

  if (url.pathname === FORT_PASS_CHECKOUT_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!isStrictSameOriginRequest(request)) return json({ error: "forbidden" }, 403);
    if (!isJsonRequest(request)) return json({ error: "unsupported_media_type" }, 415);
    const checkout = normalizeFortPassCheckoutRequest(await readSmallJson(request));
    if (!checkout) return json({ error: "invalid_custom_room_code" }, 400);
    const publicOrigin = checkoutPublicOrigin(env.PUBLIC_BASE_URL, url);
    if (!env.STRIPE_SECRET_KEY || !env.FORT_PASS_PRICE_ID || !env.STRIPE_WEBHOOK_SECRET || !publicOrigin) {
      return json({ error: "checkout_not_configured", code: checkout.customRoomCode }, 501);
    }
    const checkoutLimit = await takeCheckoutRateLimitSlot(env, request, url);
    if (checkoutLimit === "limited") {
      return json(
        { error: "checkout_rate_limited" },
        429,
        { "retry-after": String(CHECKOUT_LIMIT_RETRY_SECONDS) }
      );
    }
    if (checkoutLimit === "unavailable") {
      return json({ error: "checkout_source_unavailable" }, 503);
    }
    // Consume the bounded source budget before touching an attacker-selected
    // target Durable Object name. Otherwise arbitrary valid codes create an
    // unbounded DO fan-out even when checkout is unavailable or abusive.
    if (await roomExists(env, checkout.customRoomCode, request)) {
      return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
    }
    let reservation = await claimTargetFortPassReservation(
      env, request, checkout.customRoomCode, checkout.claimHash,
    );
    if (reservation.status === "supersession_required") {
      const prior = await resolveFortPassCheckoutSession(
        reservation.sessionId,
        checkout.customRoomCode,
        {
          secretKey: env.STRIPE_SECRET_KEY,
          priceId: env.FORT_PASS_PRICE_ID,
          fetcher: env.STRIPE_FETCHER,
        },
      );
      if (prior.status === "verified") {
        const fulfillment = await fulfillVerifiedStripeSession(
          env, request, prior.sessionId, prior.claimHash, prior.entitlement,
        );
        if (fulfillment.status === "fulfilled") {
          return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
        }
        return json({ error: "checkout_reservation_unavailable" }, 503);
      }
      if (prior.status !== "expired_unpaid") {
        return json(
          { error: prior.status === "pending" ? "custom_room_code_taken" : "checkout_reservation_unavailable" },
          prior.status === "pending" ? 409 : 503,
        );
      }
      const superseded = await supersedeTargetFortPassReservation(
        env,
        request,
        checkout.customRoomCode,
        reservation.token,
        prior.sessionId,
        checkout.claimHash,
      );
      if (superseded === "conflict") {
        return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
      }
      if (superseded !== "claimed") return json({ error: "checkout_reservation_unavailable" }, 503);
      reservation = { status: "claimed", token: reservation.token };
    }
    if (reservation.status === "conflict") {
      return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
    }
    if (reservation.status !== "claimed") return json({ error: "checkout_reservation_unavailable" }, 503);
    try {
      const session = await createFortPassStripeCheckoutSession({
        secretKey: env.STRIPE_SECRET_KEY,
        priceId: env.FORT_PASS_PRICE_ID,
        publicBaseUrl: publicOrigin,
        customRoomCode: checkout.customRoomCode,
        claimHash: checkout.claimHash,
        fetcher: env.STRIPE_FETCHER,
      });
      if (!await bindTargetFortPassReservation(
        env,
        request,
        checkout.customRoomCode,
        reservation.token,
        session.id,
      )) {
        return json({ error: "checkout_reservation_unavailable" }, 503);
      }
      return json({ code: checkout.customRoomCode, checkoutUrl: session.url, sessionId: session.id });
    } catch {
      // A timeout/connection failure can happen after Stripe created a live
      // Checkout Session. Keep the bounded reservation until it expires; an
      // eager release could reallocate the code while that session can pay.
      return json({ error: "checkout_provider_error" }, 502);
    }
  }

  if (url.pathname === FORT_PASS_REDEEM_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!isStrictSameOriginRequest(request)) return json({ error: "forbidden" }, 403);
    if (!isJsonRequest(request)) return json({ error: "unsupported_media_type" }, 415);
    if (!env.STRIPE_SECRET_KEY || !env.FORT_PASS_PRICE_ID || !env.STRIPE_WEBHOOK_SECRET) {
      return json({ error: "checkout_not_configured" }, 501);
    }
    const redemption = normalizeStripeRedemptionRequest(await readSmallJson(request));
    if (!redemption) return json({ error: "invalid_checkout_redemption" }, 400);
    const redemptionLimit = await takeCheckoutRateLimitSlot(env, request, url);
    if (redemptionLimit !== "allowed") {
      return json(
        { error: redemptionLimit === "limited" ? "checkout_rate_limited" : "checkout_source_unavailable" },
        redemptionLimit === "limited" ? 429 : 503,
        redemptionLimit === "limited" ? { "retry-after": String(CHECKOUT_LIMIT_RETRY_SECONDS) } : undefined,
      );
    }

    const resolution = await resolveFortPassCheckoutSession(
      redemption.sessionId,
      redemption.customRoomCode,
      {
        secretKey: env.STRIPE_SECRET_KEY,
        priceId: env.FORT_PASS_PRICE_ID,
        fetcher: env.STRIPE_FETCHER,
      },
    );
    if (resolution.status === "unavailable") return json({ error: "checkout_verification_failed" }, 502);
    if (resolution.status === "invalid" || resolution.status === "expired_unpaid") {
      return json({ error: "checkout_not_redeemable" }, 409);
    }
    const presentedClaimHash = await fortPassClaimHash(redemption.claimSecret);
    if (!constantTimeFortPassClaimHashEqual(presentedClaimHash, resolution.claimHash)) {
      return json({ error: "checkout_not_redeemable" }, 409);
    }
    if (resolution.status === "pending") {
      return json(
        { status: "pending", code: redemption.customRoomCode },
        202,
        { "retry-after": "1" },
      );
    }

    const fulfillment = await fulfillVerifiedStripeSession(
      env, request, resolution.sessionId, resolution.claimHash, resolution.entitlement,
    );
    if (fulfillment.status === "fulfilled") {
      return json({
        redeemed: true,
        code: resolution.entitlement.roomId,
        ...(fulfillment.replay ? { replay: true } : {}),
      });
    }
    if (fulfillment.status === "busy") {
      return json(
        { status: "pending", code: redemption.customRoomCode },
        202,
        { "retry-after": fulfillment.retryAfter || "1" },
      );
    }
    if (fulfillment.status === "fulfillment_failed") {
      return json({ error: "checkout_not_redeemable" }, 409);
    }
    return json({ error: "checkout_redemption_unavailable" }, 503);
  }

  if (url.pathname === STRIPE_WEBHOOK_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "not_configured", status: 501 });
      return json({ error: "webhook_not_configured" }, 501);
    }
    const body = await readByteLimitedText(request, 64 * 1024);
    if (!body.ok || !body.text) {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "bad_payload", status: 400 });
      return json({ error: "bad_webhook_payload" }, 400);
    }
    const payload = body.text;
    const verification = await verifyStripeWebhookSignature(
      payload,
      request.headers.get("stripe-signature"),
      webhookSecret
    );
    if (!verification.ok) {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "bad_signature", status: 400 });
      return json({ error: "bad_webhook_signature" }, 400);
    }
    if (!env.STRIPE_SECRET_KEY || !env.FORT_PASS_PRICE_ID) {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "not_configured", status: 501 });
      return json({ error: "webhook_not_configured" }, 501);
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "bad_payload", status: 400 });
      return json({ error: "bad_webhook_payload" }, 400);
    }

    const revocation = await resolveFortPassRevocationFromStripeEvent(event, {
      secretKey: env.STRIPE_SECRET_KEY,
      priceId: env.FORT_PASS_PRICE_ID,
      fetcher: env.STRIPE_FETCHER,
    });
    if (revocation.status !== "ignored") {
      if (revocation.status === "invalid") {
        logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", {
          reason: `revocation_${revocation.reason}`,
          status: 200,
        });
        return json({ received: true, ignored: true });
      }
      if (revocation.status === "unavailable") {
        logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", {
          reason: "revocation_provider_unavailable",
          status: 502,
        });
        return json({ error: "revocation_verification_failed" }, 502);
      }

      const outcome = await revokeVerifiedStripeSession(
        env,
        request,
        revocation.eventId,
        revocation.sessionId,
        revocation.roomId,
        revocation.reason,
      );
      if (outcome.status === "processed") {
        return json({
          received: true,
          processed: true,
          ...(outcome.revoked ? { revoked: true } : {}),
          ...(outcome.stale ? { stale: true } : {}),
          ...(outcome.replay ? { replay: true } : {}),
        });
      }
      if (outcome.status === "busy") {
        return json(
          { error: "entitlement_revocation_in_progress" },
          503,
          outcome.retryAfter ? { "retry-after": outcome.retryAfter } : undefined,
        );
      }
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", {
        reason: outcome.status,
        status: 503,
      });
      return json({
        error: outcome.status === "target_unavailable"
          ? "entitlement_revocation_failed"
          : outcome.status === "ledger_completion_failed"
            ? "revocation_ledger_completion_failed"
            : "revocation_ledger_unavailable",
      }, 503);
    }

    const resolution = await resolveFortPassEntitlementFromStripeEvent(event, {
      secretKey: env.STRIPE_SECRET_KEY,
      priceId: env.FORT_PASS_PRICE_ID,
      fetcher: env.STRIPE_FETCHER,
    });
    if (resolution.status === "ignored") return json({ received: true, ignored: true });
    if (resolution.status === "invalid") {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", {
        reason: resolution.reason,
        status: 200,
      });
      return json({ received: true, ignored: true });
    }
    if (resolution.status === "unavailable") {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "provider_unavailable", status: 502 });
      return json({ error: "checkout_verification_failed" }, 502);
    }

    const fulfillment = await fulfillVerifiedStripeSession(
      env, request, resolution.sessionId, resolution.claimHash, resolution.entitlement,
    );
    if (fulfillment.status === "fulfilled") {
      return json({
        received: true,
        fulfilled: true,
        code: resolution.entitlement.roomId,
        ...(fulfillment.replay ? { replay: true } : {}),
      });
    }
    if (fulfillment.status === "busy") {
      return json(
        { error: "entitlement_fulfillment_in_progress" },
        503,
        fulfillment.retryAfter ? { "retry-after": fulfillment.retryAfter } : undefined,
      );
    }
    if (fulfillment.status === "ledger_unavailable") {
      return json({ error: "entitlement_ledger_unavailable" }, 503);
    }
    if (fulfillment.status === "fulfillment_failed") {
      logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "fulfillment_failed", status: 502 });
      return json({ error: "entitlement_fulfillment_failed" }, 502);
    }
    logRateLimitedOpsEvent("stripe-webhook", "stripe_webhook_failed", { reason: "ledger_completion_failed", status: 502 });
    return json({ error: "entitlement_ledger_completion_failed" }, 502);
  }

  if (url.pathname === "/ws") {
    if (!isStrictSameOriginRequest(request)) {
      logRateLimitedOpsEvent("ws-edge", "ws_rejected", { reason: "bad_origin", surface: "edge", status: 403 });
      return new Response("forbidden", { status: 403 });
    }
    const roomParameters = url.searchParams.getAll("room");
    const protocolParameters = url.searchParams.getAll("protocol");
    if (roomParameters.length > 1 || protocolParameters.length > 1) {
      logRateLimitedOpsEvent("ws-edge", "ws_rejected", { reason: "ambiguous_parameters", surface: "edge", status: 400 });
      return new Response("invalid websocket parameters", { status: 400 });
    }
    const roomId = roomParameters[0];
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!roomId || !normalizedRoomId || normalizedRoomId !== roomId) {
      logRateLimitedOpsEvent("ws-edge", "ws_rejected", { reason: roomId ? "invalid_room" : "missing_room", surface: "edge", status: 400 });
      return new Response("invalid room", { status: 400 });
    }
    if (protocolParameters.length !== 1 || protocolParameters[0] !== "4") {
      logRateLimitedOpsEvent("ws-edge", "ws_rejected", { reason: "protocol_required", surface: "edge", status: 426 });
      return new Response("protocol v4 required", {
        status: 426,
        headers: { "cache-control": "no-store" },
      });
    }
    const openLimit = await takeWebSocketOpenRateLimitSlot(env, request, url);
    if (openLimit !== "allowed") {
      const limited = openLimit === "limited";
      logRateLimitedOpsEvent("ws-edge", "ws_rejected", {
        reason: limited ? "rate_limited" : "source_unavailable",
        surface: "edge",
        status: limited ? 429 : 503,
      });
      return new Response(limited ? "websocket open rate limited" : "websocket source unavailable", {
        status: limited ? 429 : 503,
        headers: {
          "cache-control": "no-store",
          ...(limited ? { "retry-after": "60" } : {}),
        },
      });
    }
    // Room identifiers are capability-adjacent metadata. Keep them out of
    // provider logs even though the relay necessarily uses them for routing.
    console.log("[ws] routing accepted websocket");
    const id = env.ROOM.idFromName(normalizedRoomId);
    return env.ROOM.get(id).fetch(request);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { "allow": "GET, HEAD", "cache-control": "no-store" },
    });
  }

  if (url.pathname === "/activity") {
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  }

  // Room-link aliases are canonicalized before rendering. A relative Location
  // prevents a spoofed Host value from turning this into an external redirect.
  const rawRoomPath = url.pathname.slice(1);
  const canonicalRoomPath = normalizeRoomId(rawRoomPath);
  if (canonicalRoomPath) {
    if (rawRoomPath !== canonicalRoomPath) {
      return new Response(null, {
        status: 308,
        headers: {
          "location": `/${canonicalRoomPath}${url.search}`,
          "cache-control": "no-store",
        },
      });
    }
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mode: SecurityHeaderMode = isDiscordActivityRequest(request) ? "discord-activity" : "default";
    return withSecurityHeaders(await handleFetch(request, env), mode);
  },
} satisfies ExportedHandler<Env>;
