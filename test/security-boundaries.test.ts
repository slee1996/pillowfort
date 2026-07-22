import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  generateLegacyRoomId,
  secureRandomHex,
  startLocalServer,
  strictBoundedEnvironmentInteger,
  unbiasedRandomIndex,
} from "../server";
import {
  computeStripeWebhookSignature,
  createFortPassStripeCheckoutSession,
  normalizeStripeHostedCheckoutUrl as normalizeServerCheckoutUrl,
} from "../src/stripe";
import {
  normalizeStripeHostedCheckoutUrl as normalizeClientCheckoutUrl,
  startFortPassCheckout,
} from "../client/src/services/fortPass";
import { connectUrl, roomAuth, type Client } from "./ws-client";

const originalFetch = globalThis.fetch;
const TEST_FORT_PASS_CLAIM_SECRET = "11".repeat(32);
const TEST_FORT_PASS_CLAIM_HASH = "02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc";

function installMemorySessionStorage(): () => void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(String(key), String(value)); },
  } satisfies Storage;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  return () => {
    if (prior) Object.defineProperty(globalThis, "sessionStorage", prior);
    else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const VALID_CHECKOUT_URLS = [
  "https://checkout.stripe.com/c/pay/cs_test_123",
  "https://checkout.stripe.com/c/pay/cs_test_123?prefilled_email=friend%40example.com",
  // Stripe's documented hosted-session example includes an opaque fragment.
  "https://checkout.stripe.com/c/pay/cs_test_123#fidkdWxOYHwnPyd1blpxYHZxWjA0",
];

const INVALID_CHECKOUT_URLS = [
  "http://checkout.stripe.com/c/pay/cs_test_123",
  "https://checkout.stripe.com.evil.example/c/pay/cs_test_123",
  "https://sub.checkout.stripe.com/c/pay/cs_test_123",
  "https://checkout-stripe.com/c/pay/cs_test_123",
  "https://checkout.stripe.com@evil.example/c/pay/cs_test_123",
  "https://user:password@checkout.stripe.com/c/pay/cs_test_123",
  "https://checkout.stripe.com:443/c/pay/cs_test_123",
  "https://checkout.stripe.com:8443/c/pay/cs_test_123",
  "https://CHECKOUT.stripe.com/c/pay/cs_test_123",
  "https://checkout.stripe.com\\@evil.example/c/pay/cs_test_123",
  "//checkout.stripe.com/c/pay/cs_test_123",
  "javascript:alert(1)",
  " https://checkout.stripe.com/c/pay/cs_test_123",
  "https://checkout.stripe.com/c/pay/cs_test_123\n",
];

describe("local security configuration bounds", () => {
  it("uses only canonical in-range integers and fails malformed limits closed", () => {
    expect(strictBoundedEnvironmentInteger("999", 5, 1, 1_000)).toBe(999);
    for (const value of [undefined, "", "0", "-1", "+5", "05", "5.0", "5e2", "NaN", "Infinity", "1001"]) {
      expect(strictBoundedEnvironmentInteger(value, 5, 1, 1_000)).toBe(5);
    }
    expect(() => strictBoundedEnvironmentInteger("5", 0, 1, 10)).toThrow(RangeError);
  });
});

describe("Stripe-hosted Checkout navigation boundary", () => {
  it("accepts only exact first-party HTTPS Checkout URLs on server and client", () => {
    for (const url of VALID_CHECKOUT_URLS) {
      expect(normalizeServerCheckoutUrl(url)).toBe(url);
      expect(normalizeClientCheckoutUrl(url)).toBe(url);
    }
    for (const url of INVALID_CHECKOUT_URLS) {
      expect(normalizeServerCheckoutUrl(url)).toBeNull();
      expect(normalizeClientCheckoutUrl(url)).toBeNull();
    }
  });

  it("rejects a malicious provider URL before the local server can return it", async () => {
    for (const url of INVALID_CHECKOUT_URLS.slice(0, 10)) {
      await expect(createFortPassStripeCheckoutSession({
        secretKey: "sk_test_secret",
        priceId: "price_test",
        publicBaseUrl: "https://pillowfort.test",
        customRoomCode: "party-1",
        claimHash: TEST_FORT_PASS_CLAIM_HASH,
        fetcher: async () => Response.json({ id: "cs_test_123", url }),
      })).rejects.toThrow("stripe checkout session response invalid");
    }

    await expect(createFortPassStripeCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_test",
      publicBaseUrl: "https://pillowfort.test",
      customRoomCode: "party-1",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
      fetcher: async () => Response.json({ id: "cs_test_123", url: VALID_CHECKOUT_URLS[2] }),
    })).resolves.toEqual({ id: "cs_test_123", url: VALID_CHECKOUT_URLS[2] });
  });

  it("fails closed on the client before a caller can navigate to an API-supplied URL", async () => {
    const restoreStorage = installMemorySessionStorage();
    try {
    for (const checkoutUrl of INVALID_CHECKOUT_URLS.slice(0, 10)) {
      globalThis.fetch = (async () => Response.json({
        code: "party-1",
        checkoutUrl,
        sessionId: "cs_test_123",
      })) as typeof fetch;
      await expect(startFortPassCheckout("party-1")).resolves.toEqual({
        ok: false,
        error: "checkout_provider_error",
      });
    }

    globalThis.fetch = (async () => Response.json({
      code: "party-1",
      checkoutUrl: VALID_CHECKOUT_URLS[2],
      sessionId: "cs_test_123",
    })) as typeof fetch;
    await expect(startFortPassCheckout("party-1")).resolves.toEqual({
      ok: true,
      code: "party-1",
      checkoutUrl: VALID_CHECKOUT_URLS[2],
      sessionId: "cs_test_123",
    });
    } finally {
      restoreStorage();
    }
  });
});

describe("local Stripe fulfillment boundary", () => {
  it("requires both a valid signature and an authoritative configured-Price session", async () => {
    const priorSecret = process.env.STRIPE_SECRET_KEY;
    const priorPrice = process.env.FORT_PASS_PRICE_ID;
    const priorWebhook = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_SECRET_KEY = "sk_test_secret";
    process.env.FORT_PASS_PRICE_ID = "price_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

    const created = Math.floor(Date.now() / 1_000);
    const session = {
      id: "cs_test_local_123",
      object: "checkout.session",
      created,
      livemode: false,
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      payment_intent: "pi_test_local_123",
      client_reference_id: "fort-pass:paid-1",
      amount_total: 500,
      amount_subtotal: 500,
      currency: "usd",
      metadata: {
        kind: "fort-pass",
        entitlement_kind: "fort-pass",
        custom_room_code: "paid-1",
        price_id: "price_test",
        claim_hash: TEST_FORT_PASS_CLAIM_HASH,
      },
      line_items: {
        object: "list",
        has_more: false,
        data: [{
          object: "item",
          quantity: 1,
          amount_total: 500,
          amount_subtotal: 500,
          currency: "usd",
          price: {
            object: "price",
            id: "price_test",
            type: "one_time",
            unit_amount: 500,
            currency: "usd",
            livemode: false,
          },
        }],
      },
    };
    const event = {
      object: "event",
      id: "evt_test_local_123",
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { ...session, line_items: undefined } },
    };
    let stripeRetrievals = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href = input instanceof Request ? input.url : String(input);
      if (href.startsWith("https://api.stripe.com/v1/checkout/sessions/")) {
        stripeRetrievals += 1;
        return Response.json(session);
      }
      if (href === "https://api.stripe.com/v1/checkout/sessions" && init?.method === "POST") {
        return Response.json({
          id: "cs_test_local_123",
          url: "https://checkout.stripe.com/c/pay/cs_test_local_123",
        });
      }
      if (href === "https://api.stripe.com/v1/charges/ch_test_local_123") {
        return Response.json({
          id: "ch_test_local_123",
          object: "charge",
          livemode: false,
          payment_intent: "pi_test_local_123",
          paid: true,
          captured: true,
          amount: 500,
          amount_captured: 500,
          amount_refunded: 250,
          refunded: false,
          currency: "usd",
        });
      }
      if (href.startsWith("https://api.stripe.com/v1/checkout/sessions?")) {
        return Response.json({ object: "list", has_more: false, data: [session] });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    const origin = `http://127.0.0.1:${server.port}`;
    const clients: Client[] = [];
    try {
      const payload = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1_000);
      const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");
      const checkout = await fetch(`${origin}/api/fort-pass/checkout`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ customRoomCode: "paid-1", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
      });
      const unsigned = await fetch(`${origin}/api/stripe/webhook`, { method: "POST", body: payload });
      const deliver = () => fetch(`${origin}/api/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      });

      // A copied success URL exposes only the code and Session ID. Without
      // the originating tab's 256-bit secret it carries no redemption power.
      const stolenUrlRedemption = await fetch(`${origin}/api/fort-pass/redeem`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ customRoomCode: "paid-1", sessionId: "cs_test_local_123" }),
      });
      const redeemed = await fetch(`${origin}/api/fort-pass/redeem`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          customRoomCode: "paid-1",
          sessionId: "cs_test_local_123",
          claimSecret: TEST_FORT_PASS_CLAIM_SECRET,
        }),
      });
      const replay = await deliver();
      const availability = await fetch(`${origin}/api/fort-pass/code?code=paid-1`);

      expect(checkout.status).toBe(200);
      expect(unsigned.status).toBe(400);
      expect(stolenUrlRedemption.status).toBe(400);
      expect(await stolenUrlRedemption.json()).toEqual({ error: "invalid_checkout_redemption" });
      expect(redeemed.status).toBe(200);
      expect(await redeemed.json()).toEqual({ redeemed: true, code: "paid-1" });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ received: true, fulfilled: true, code: "paid-1", replay: true });
      expect(await availability.json()).toEqual({ code: "paid-1", available: false, reason: "taken" });
      expect(stripeRetrievals).toBe(2);

      const wsBase = `ws://127.0.0.1:${server.port}/ws?room=paid-1`;
      const setup = async (claimSecret?: string) => {
        const client = await connectUrl(wsBase);
        clients.push(client);
        client.name = "alice";
        client.roomId = "paid-1";
        client.password = "correct horse battery staple";
        client.send({
          type: "set-up",
          name: "alice",
          auth: await roomAuth(
            client,
            "paid-1",
            "correct horse battery staple",
            "set-up",
            "alice",
          ),
          fortPassSessionId: "cs_test_local_123",
          ...(claimSecret ? { fortPassClaimSecret: claimSecret } : {}),
        });
        return client;
      };
      const missingSetupSecret = await setup();
      expect((await missingSetupSecret.waitFor("error")).message).toBe("paid room redemption required");
      const wrongSetupSecret = await setup("22".repeat(32));
      expect((await wrongSetupSecret.waitFor("error")).message).toBe("paid room redemption required");
      const validSetup = await setup(TEST_FORT_PASS_CLAIM_SECRET);
      expect((await validSetup.waitFor("room-created")).room).toBe("paid-1");

      const refundEvent = {
        object: "event",
        id: "evt_test_local_refund_123",
        type: "charge.refunded",
        livemode: false,
        data: {
          object: {
            id: "ch_test_local_123",
            object: "charge",
            livemode: false,
            payment_intent: "pi_test_local_123",
          },
        },
      };
      const refundPayload = JSON.stringify(refundEvent);
      const refundSignature = await computeStripeWebhookSignature(refundPayload, timestamp, "whsec_test");
      const deliverRefund = () => fetch(`${origin}/api/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${refundSignature}` },
        body: refundPayload,
      });
      const refunded = await deliverRefund();
      expect(refunded.status).toBe(200);
      expect(await refunded.json()).toEqual({ received: true, processed: true, revoked: true });
      const refundReplay = await deliverRefund();
      expect(refundReplay.status).toBe(200);
      expect(await refundReplay.json()).toEqual({ received: true, processed: true, replay: true });
      const availableAfterRefund = await fetch(`${origin}/api/fort-pass/code?code=paid-1`);
      // Revocation removes perks/claim authority but intentionally does not
      // destroy an active encrypted room or make its live code claimable.
      expect(await availableAfterRefund.json()).toEqual({ code: "paid-1", available: false, reason: "taken" });
    } finally {
      await Promise.all(clients.map(client => client.close()));
      server.stop(true);
      globalThis.fetch = originalFetch;
      if (priorSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = priorSecret;
      if (priorPrice === undefined) delete process.env.FORT_PASS_PRICE_ID;
      else process.env.FORT_PASS_PRICE_ID = priorPrice;
      if (priorWebhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = priorWebhook;
    }
  });

  it("invalidates the exact local reservation when refund wins the completion race", async () => {
    const prior = {
      secret: process.env.STRIPE_SECRET_KEY,
      price: process.env.FORT_PASS_PRICE_ID,
      webhook: process.env.STRIPE_WEBHOOK_SECRET,
    };
    process.env.STRIPE_SECRET_KEY = "sk_test_secret";
    process.env.FORT_PASS_PRICE_ID = "price_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const created = Math.floor(Date.now() / 1_000);
    const session = {
      id: "cs_test_early_local_123",
      object: "checkout.session",
      created,
      livemode: false,
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      payment_intent: "pi_test_early_local_123",
      client_reference_id: "fort-pass:early-lc",
      amount_total: 500,
      amount_subtotal: 500,
      currency: "usd",
      metadata: {
        kind: "fort-pass",
        entitlement_kind: "fort-pass",
        custom_room_code: "early-lc",
        price_id: "price_test",
        claim_hash: TEST_FORT_PASS_CLAIM_HASH,
      },
      line_items: {
        object: "list",
        has_more: false,
        data: [{
          object: "item",
          quantity: 1,
          amount_total: 500,
          amount_subtotal: 500,
          currency: "usd",
          price: {
            object: "price",
            id: "price_test",
            type: "one_time",
            unit_amount: 500,
            currency: "usd",
            livemode: false,
          },
        }],
      },
    };
    const charge = {
      id: "ch_test_early_local_123",
      object: "charge",
      livemode: false,
      payment_intent: "pi_test_early_local_123",
      paid: true,
      captured: true,
      amount: 500,
      amount_captured: 500,
      amount_refunded: 250,
      refunded: false,
      currency: "usd",
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
        return Response.json({
          id: session.id,
          url: "https://checkout.stripe.com/c/pay/cs_test_early_local_123",
        });
      }
      if (url.pathname === `/v1/charges/${charge.id}`) return Response.json(charge);
      if (url.pathname === "/v1/checkout/sessions" && url.searchParams.has("payment_intent")) {
        return Response.json({ object: "list", has_more: false, data: [session] });
      }
      if (url.pathname === `/v1/checkout/sessions/${session.id}`) return Response.json(session);
      return originalFetch(input, init);
    }) as typeof fetch;
    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    const origin = `http://127.0.0.1:${server.port}`;
    const postSigned = async (event: unknown) => {
      const payload = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1_000);
      const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");
      return fetch(`${origin}/api/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      });
    };
    try {
      const checkout = await fetch(`${origin}/api/fort-pass/checkout`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ customRoomCode: "early-lc", claimHash: TEST_FORT_PASS_CLAIM_HASH }),
      });
      expect(checkout.status).toBe(200);

      const refund = await postSigned({
        object: "event",
        id: "evt_test_early_local_refund_123",
        type: "charge.refunded",
        livemode: false,
        data: { object: charge },
      });
      expect(refund.status).toBe(200);
      expect(await refund.json()).toEqual({ received: true, processed: true, revoked: true });

      const completion = await postSigned({
        object: "event",
        id: "evt_test_early_local_completion_123",
        type: "checkout.session.completed",
        livemode: false,
        data: { object: { ...session, line_items: undefined } },
      });
      expect(completion.status).toBe(409);
      expect(await completion.json()).toEqual({ error: "entitlement_fulfillment_failed" });
      const availability = await fetch(`${origin}/api/fort-pass/code?code=early-lc`);
      expect(await availability.json()).toEqual({ code: "early-lc", available: true });
    } finally {
      server.stop(true);
      globalThis.fetch = originalFetch;
      if (prior.secret === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prior.secret;
      if (prior.price === undefined) delete process.env.FORT_PASS_PRICE_ID;
      else process.env.FORT_PASS_PRICE_ID = prior.price;
      if (prior.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
      else process.env.STRIPE_WEBHOOK_SECRET = prior.webhook;
    }
  });
});

describe("legacy local-server security and fairness randomness", () => {
  it("uses rejection sampling when the uint32 range is not divisible by the candidate count", () => {
    const draws = [0xffff_ffff, 17];
    let calls = 0;
    const result = unbiasedRandomIndex(10, () => {
      calls += 1;
      return draws.shift()!;
    });
    expect(result).toBe(7);
    expect(calls).toBe(2);

    expect(() => unbiasedRandomIndex(0)).toThrow(RangeError);
    expect(() => unbiasedRandomIndex(2, () => -1)).toThrow(RangeError);
    expect(unbiasedRandomIndex(1, () => { throw new Error("must not draw"); })).toBe(0);
  });

  it("generates room IDs and correlation tags entirely from cryptographic bytes", () => {
    const ids = Array.from({ length: 64 }, () => generateLegacyRoomId());
    expect(ids.every((id) => /^f-[a-z2-7]{10}$/u.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(secureRandomHex(2)).toMatch(/^[a-f0-9]{4}$/u);
    expect(secureRandomHex(32)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not retain Math.random in legacy room, host, role, or socket-tag choices", async () => {
    const source = await readFile(joinServerPath(), "utf8");
    expect(source).not.toContain("Math.random");
    expect(source).toContain("candidates[unbiasedRandomIndex(candidates.length)]");
    expect(source).toContain("m[unbiasedRandomIndex(m.length)]");
    expect(source).toContain("hash: secureRandomHex(2)");
    expect(source).toContain("const id = d.roomId || generateLegacyRoomId()");
  });

  it("rejects noncanonical WebSocket room aliases and redirects room-link aliases", async () => {
    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const uppercaseLink = await fetch(`${origin}/Party-1?invite=yes`, { redirect: "manual" });
      expect(uppercaseLink.status).toBe(308);
      expect(uppercaseLink.headers.get("location")).toBe("/party-1?invite=yes");

      const uppercaseSocket = await fetch(`${origin}/ws?room=Party-1&protocol=legacy`, { headers: { origin } });
      expect(uppercaseSocket.status).toBe(400);
      expect(await uppercaseSocket.text()).toBe("invalid room");

      const whitespaceSocket = await fetch(`${origin}/ws?room=%20party-1%20&protocol=legacy`, { headers: { origin } });
      expect(whitespaceSocket.status).toBe(400);
      expect(await whitespaceSocket.text()).toBe("invalid room");

      const secretQuerySocket = await fetch(
        `${origin}/ws?room=party-1&protocol=legacy&password=not-a-real-secret`,
        { headers: { origin } },
      );
      expect(secretQuerySocket.status).toBe(400);
      expect(await secretQuerySocket.text()).toBe("invalid websocket parameters");

      const canonicalSocket = await fetch(`${origin}/ws?room=party-1&protocol=legacy`, { headers: { origin } });
      expect(canonicalSocket.status).toBe(400);
      expect(await canonicalSocket.text()).toBe("upgrade failed");
    } finally {
      server.stop(true);
    }
  });

  it("serves only regular files inside the local build root", async () => {
    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const traversal = await fetch(`${origin}/%252e%252e%252fpackage.json`);
      const directory = await fetch(`${origin}/assets`);
      const mutation = await fetch(`${origin}/index.html`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "unexpected",
      });

      expect(traversal.status).toBe(404);
      expect(traversal.headers.get("cache-control")).toBe("no-store");
      expect(directory.status).toBe(404);
      expect(mutation.status).toBe(405);
      expect(mutation.headers.get("allow")).toBe("GET, HEAD");
      expect(mutation.headers.get("cache-control")).toBe("no-store");
    } finally {
      server.stop(true);
    }
  });

  it("never treats an absent protocol as legacy and keeps legacy behind an explicit local opt-in", async () => {
    const server = startLocalServer(0);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      for (const query of ["room=party-1", "room=party-1&protocol=legacy", "room=party-1&protocol=3"]) {
        const response = await fetch(`${origin}/ws?${query}`, { headers: { origin } });
        expect(response.status).toBe(426);
      }
      const explicitV4 = await fetch(`${origin}/ws?room=party-1&protocol=4`, { headers: { origin } });
      expect(explicitV4.status).toBe(400);
      expect(await explicitV4.text()).toBe("upgrade failed");
    } finally {
      server.stop(true);
    }
  });

  it("ignores the legacy websocket opt-in outside the test environment", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const response = await fetch(`${origin}/ws?room=party-1&protocol=legacy`, {
        headers: { origin },
      });
      expect(response.status).toBe(426);
      expect(await response.text()).toBe("protocol v4 required");
    } finally {
      server.stop(true);
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it("binds join messages to the exact canonical room selected by the socket URL", async () => {
    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    const wsOrigin = `ws://127.0.0.1:${server.port}/ws`;
    const clients: Client[] = [];
    try {
      const aliasClient = await connectUrl(wsOrigin);
      clients.push(aliasClient);
      aliasClient.send({ type: "join", name: "guest", room: "Party-1" });
      const aliasError = await aliasClient.waitFor("error");
      expect(aliasError.message).toContain("canonical fort flag required");

      const boundClient = await connectUrl(`${wsOrigin}?room=party-1`);
      clients.push(boundClient);
      boundClient.send({ type: "join", name: "guest", room: "party-2" });
      const mismatchError = await boundClient.waitFor("error");
      expect(mismatchError.message).toContain("canonical fort flag required");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      server.stop(true);
    }
  });

  it("rejects cross-site local mutations and WebSocket handshakes", async () => {
    const server = startLocalServer(0, { allowLegacyWebSockets: true });
    const origin = `http://127.0.0.1:${server.port}`;
    const analyticsBody = JSON.stringify({ event: "fort_pass_status_checked", props: { source: "test" } });
    try {
      const missingOrigin = await fetch(`${origin}/analytics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: analyticsBody,
      });
      const evilOrigin = await fetch(`${origin}/analytics`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: analyticsBody,
      });
      const accepted = await fetch(`${origin}/analytics`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: analyticsBody,
      });
      const badMedia = await fetch(`${origin}/api/fort-pass/checkout`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin },
        body: JSON.stringify({ customRoomCode: "party-1" }),
      });
      const socket = await fetch(`${origin}/ws?room=party-1`);

      expect(missingOrigin.status).toBe(403);
      expect(evilOrigin.status).toBe(403);
      expect(accepted.status).toBe(204);
      expect(badMedia.status).toBe(415);
      expect(socket.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });
});

function joinServerPath(): string {
  return `${import.meta.dir}/../server.ts`;
}
