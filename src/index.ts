import { analyticsLogLine, opsLogLine, readAnalyticsEvent } from "./analytics";
import { customRoomCodeAvailability, normalizeCustomRoomCode, normalizeFortPassCheckoutRequest, type FortPassEntitlement } from "./entitlements";
import { FORT_PASS_CHECKOUT_PATH, FORT_PASS_CODE_PATH, FORT_PASS_STATUS_PATH, ROOM_FORT_PASS_FULFILL_PATH, ROOM_STATUS_PATH, STRIPE_WEBHOOK_PATH } from "./routes";
import { blockedProbeResponse, isDiscordActivityRequest, logBlockedProbe, probeReasonForPath, withSecurityHeaders, type SecurityHeaderMode } from "./security";
import { createFortPassStripeCheckoutSession, fortPassEntitlementFromStripeEvent, verifyStripeWebhookSignature } from "./stripe";

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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function readSmallJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > 1024) return null;
  const text = await request.text();
  if (!text || text.length > 1024) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) return null;
  const text = await request.text();
  if (!text || text.length > maxBytes) return null;
  return text;
}

async function roomExists(env: Env, roomId: string, request: Request): Promise<boolean> {
  const id = env.ROOM.idFromName(roomId);
  const url = new URL(ROOM_STATUS_PATH, request.url);
  const res = await env.ROOM.get(id).fetch(new Request(url, { method: "GET" }));
  if (!res.ok) return true;
  const status = await res.json().catch(() => null) as { exists?: unknown } | null;
  return status?.exists === true;
}

async function fulfillFortPass(env: Env, entitlement: FortPassEntitlement, request: Request): Promise<boolean> {
  const id = env.ROOM.idFromName(entitlement.roomId);
  const url = new URL(ROOM_FORT_PASS_FULFILL_PATH, request.url);
  const res = await env.ROOM.get(id).fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entitlement),
  }));
  return res.ok;
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
    const event = await readAnalyticsEvent(request);
    if (!event) return new Response("bad analytics event", { status: 400 });
    console.log(analyticsLogLine(event));
    return new Response(null, { status: 204 });
  }

  if (url.pathname === FORT_PASS_CODE_PATH) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const code = normalizeCustomRoomCode(url.searchParams.get("code"));
    if (!code) return json(customRoomCodeAvailability(null, false));
    return json(customRoomCodeAvailability(code, await roomExists(env, code, request)));
  }

  if (url.pathname === FORT_PASS_STATUS_PATH) {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    return json({
      beta: true,
      checkoutConfigured: Boolean(env.STRIPE_SECRET_KEY && env.FORT_PASS_PRICE_ID && env.STRIPE_WEBHOOK_SECRET),
      priceLabel: "$5",
      perks: ["custom_code", "extended_idle", "theme_pack"],
    });
  }

  if (url.pathname === FORT_PASS_CHECKOUT_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const checkout = normalizeFortPassCheckoutRequest(await readSmallJson(request));
    if (!checkout) return json({ error: "invalid_custom_room_code" }, 400);
    if (await roomExists(env, checkout.customRoomCode, request)) {
      return json({ error: "custom_room_code_taken", code: checkout.customRoomCode }, 409);
    }
    if (!env.STRIPE_SECRET_KEY || !env.FORT_PASS_PRICE_ID) {
      return json({ error: "checkout_not_configured", code: checkout.customRoomCode }, 501);
    }
    try {
      const session = await createFortPassStripeCheckoutSession({
        secretKey: env.STRIPE_SECRET_KEY,
        priceId: env.FORT_PASS_PRICE_ID,
        publicBaseUrl: env.PUBLIC_BASE_URL || url.origin,
        customRoomCode: checkout.customRoomCode,
        fetcher: env.STRIPE_FETCHER,
      });
      return json({ code: checkout.customRoomCode, checkoutUrl: session.url, sessionId: session.id });
    } catch {
      return json({ error: "checkout_provider_error" }, 502);
    }
  }

  if (url.pathname === STRIPE_WEBHOOK_PATH) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!env.STRIPE_WEBHOOK_SECRET) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "not_configured", status: 501 }));
      return json({ error: "webhook_not_configured" }, 501);
    }
    const payload = await readLimitedText(request, 64 * 1024);
    if (!payload) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "bad_payload", status: 400 }));
      return json({ error: "bad_webhook_payload" }, 400);
    }
    const verification = await verifyStripeWebhookSignature(
      payload,
      request.headers.get("stripe-signature"),
      env.STRIPE_WEBHOOK_SECRET
    );
    if (!verification.ok) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "bad_signature", status: 400 }));
      return json({ error: "bad_webhook_signature" }, 400);
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "bad_payload", status: 400 }));
      return json({ error: "bad_webhook_payload" }, 400);
    }
    const entitlement = fortPassEntitlementFromStripeEvent(event);
    if (!entitlement) return json({ received: true, ignored: true });
    if (!await fulfillFortPass(env, entitlement, request)) {
      console.log(opsLogLine("stripe_webhook_failed", { reason: "fulfillment_failed", status: 502 }));
      return json({ error: "entitlement_fulfillment_failed" }, 502);
    }
    return json({ received: true, fulfilled: true, code: entitlement.roomId });
  }

  if (url.pathname === "/ws") {
    const roomId = url.searchParams.get("room");
    if (!roomId || !normalizeCustomRoomCode(roomId)) {
      console.log(opsLogLine("ws_rejected", { reason: roomId ? "invalid_room" : "missing_room", surface: "edge", status: 400 }));
      return new Response("invalid room", { status: 400 });
    }
    console.log(`[ws] routing to room ${roomId}`);
    const id = env.ROOM.idFromName(roomId);
    return env.ROOM.get(id).fetch(request);
  }

  if (url.pathname === "/activity") {
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  }

  // room links: /abc123 → serve index.html
  if (normalizeCustomRoomCode(url.pathname.slice(1))) {
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
