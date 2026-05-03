import { describe, it, expect } from "bun:test";
import { sanitizeAnalyticsEvent } from "../src/analytics";
import { firstDueRoomAlarm, nextRoomAlarmDeadline, normalizeRoomAlarmSchedule } from "../src/alarms";
import { normalizeFortPassCode, normalizeFortPassSessionId, startFortPassCheckout } from "../client/src/services/fortPass";
import {
  FORT_PASS_EXTENDED_IDLE_MS,
  fortPassAllowsCustomRoomCode,
  fortPassIdleMs,
  fortPassAllowsRoomTheme,
  fortPassRedemptionMatches,
  isFortPassActive,
  customRoomCodeAvailability,
  normalizeFortPassCheckoutRequest,
  normalizeCustomRoomCode,
  normalizeFortPassEntitlement,
  normalizeFortPassRedemptionToken,
  normalizeRoomTheme,
} from "../src/entitlements";
import { isRpsPick, rpsWinner, tttWinner } from "../src/game";
import { probeReasonForPath, withSecurityHeaders } from "../src/security";
import { sanitizeStyle, uniqueName, STYLE_COLORS, MAX_NAME_LEN } from "../src/shared";
import {
  computeStripeWebhookSignature,
  createFortPassStripeCheckoutSession,
  fortPassEntitlementFromStripeEvent,
  verifyStripeWebhookSignature,
} from "../src/stripe";

describe("sanitizeStyle", () => {
  it("returns undefined for null", () => {
    expect(sanitizeStyle(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(sanitizeStyle(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object", () => {
    expect(sanitizeStyle("bold")).toBeUndefined();
    expect(sanitizeStyle(42)).toBeUndefined();
  });

  it("passes through valid { bold: true }", () => {
    expect(sanitizeStyle({ bold: true })).toEqual({ bold: true });
  });

  it("passes through valid color from palette", () => {
    for (const color of STYLE_COLORS) {
      expect(sanitizeStyle({ color })).toEqual({ color });
    }
  });

  it("rejects unknown color strings", () => {
    expect(sanitizeStyle({ color: "#BADCOL" })).toBeUndefined();
    expect(sanitizeStyle({ color: "red" })).toBeUndefined();
    expect(sanitizeStyle({ color: "#FFFFFF" })).toBeUndefined();
  });

  it("rejects non-boolean bold/italic/underline values", () => {
    expect(sanitizeStyle({ bold: "yes" })).toBeUndefined();
    expect(sanitizeStyle({ italic: 1 })).toBeUndefined();
    expect(sanitizeStyle({ underline: "true" })).toBeUndefined();
  });

  it("returns undefined when all fields are invalid (empty result)", () => {
    expect(sanitizeStyle({ bold: false, color: "pink" })).toBeUndefined();
  });

  it("ignores extra/unknown properties", () => {
    expect(sanitizeStyle({ bold: true, fontSize: 24, foo: "bar" })).toEqual({ bold: true });
  });

  it("combines multiple valid fields", () => {
    expect(sanitizeStyle({ bold: true, italic: true, underline: true, color: "#FF0000" }))
      .toEqual({ bold: true, italic: true, underline: true, color: "#FF0000" });
  });
});

describe("uniqueName", () => {
  it("returns base name when not taken", () => {
    expect(uniqueName("alice", new Set())).toBe("alice");
    expect(uniqueName("alice", new Set(["bob"]))).toBe("alice");
  });

  it("returns base2 when base is taken", () => {
    expect(uniqueName("alice", new Set(["alice"]))).toBe("alice2");
  });

  it("returns base3 when both base and base2 are taken", () => {
    expect(uniqueName("alice", new Set(["alice", "alice2"]))).toBe("alice3");
  });

  it("truncates to fit within MAX_NAME_LEN when suffixing", () => {
    const longName = "a".repeat(MAX_NAME_LEN);
    const result = uniqueName(longName, new Set([longName]));
    expect(result.length).toBeLessThanOrEqual(MAX_NAME_LEN);
    expect(result).toBe("a".repeat(MAX_NAME_LEN - 1) + "2");
  });

  it("handles high suffix numbers with long names", () => {
    const base = "a".repeat(MAX_NAME_LEN);
    const taken = new Set([base]);
    for (let i = 2; i <= 10; i++) {
      const suffix = String(i);
      taken.add("a".repeat(MAX_NAME_LEN - suffix.length) + suffix);
    }
    const result = uniqueName(base, taken);
    expect(result.length).toBeLessThanOrEqual(MAX_NAME_LEN);
    expect(result).toBe("a".repeat(MAX_NAME_LEN - 2) + "11");
  });
});

describe("game helpers", () => {
  it("recognizes valid RPS picks", () => {
    expect(isRpsPick("rock")).toBe(true);
    expect(isRpsPick("paper")).toBe(true);
    expect(isRpsPick("scissors")).toBe(true);
  });

  it("rejects invalid RPS picks", () => {
    expect(isRpsPick("lizard")).toBe(false);
    expect(isRpsPick("")).toBe(false);
    expect(isRpsPick(null)).toBe(false);
    expect(isRpsPick(1)).toBe(false);
  });

  it("resolves every RPS win and draw", () => {
    expect(rpsWinner("alice", "bob", "rock", "scissors")).toBe("alice");
    expect(rpsWinner("alice", "bob", "scissors", "paper")).toBe("alice");
    expect(rpsWinner("alice", "bob", "paper", "rock")).toBe("alice");

    expect(rpsWinner("alice", "bob", "scissors", "rock")).toBe("bob");
    expect(rpsWinner("alice", "bob", "paper", "scissors")).toBe("bob");
    expect(rpsWinner("alice", "bob", "rock", "paper")).toBe("bob");

    expect(rpsWinner("alice", "bob", "rock", "rock")).toBeNull();
    expect(rpsWinner("alice", "bob", "paper", "paper")).toBeNull();
    expect(rpsWinner("alice", "bob", "scissors", "scissors")).toBeNull();
  });

  it("detects Tic-Tac-Toe wins", () => {
    expect(tttWinner(["X", "X", "X", "", "", "", "", "", ""], "X")).toBe(true);
    expect(tttWinner(["O", "", "", "O", "", "", "O", "", ""], "O")).toBe(true);
    expect(tttWinner(["X", "", "", "", "X", "", "", "", "X"], "X")).toBe(true);
    expect(tttWinner(["", "", "O", "", "O", "", "O", "", ""], "O")).toBe(true);
  });

  it("rejects non-winning Tic-Tac-Toe boards", () => {
    expect(tttWinner(["X", "O", "X", "X", "O", "O", "O", "X", "X"], "X")).toBe(false);
    expect(tttWinner(["X", "O", "X", "X", "O", "O", "O", "X", "X"], "O")).toBe(false);
    expect(tttWinner(["", "", "", "", "", "", "", "", ""], "X")).toBe(false);
  });
});

describe("sanitizeAnalyticsEvent", () => {
  it("keeps allowed event names and safe props", () => {
    expect(sanitizeAnalyticsEvent({
      event: "stripe_webhook_failed",
      props: {
        kind: "rps",
        role: "host",
        source: "action_bar",
        reason: "bad_signature",
        surface: "edge",
        memberCount: 4,
        queueDepth: 1,
        status: 400,
        mobile: false,
      },
    })).toEqual({
      event: "stripe_webhook_failed",
      props: {
        kind: "rps",
        role: "host",
        source: "action_bar",
        reason: "bad_signature",
        surface: "edge",
        memberCount: 4,
        queueDepth: 1,
        status: 400,
        mobile: false,
      },
    });
  });

  it("rejects unknown events", () => {
    expect(sanitizeAnalyticsEvent({ event: "message_text", props: {} })).toBeNull();
  });

  it("drops disallowed or unsafe props", () => {
    expect(sanitizeAnalyticsEvent({
      event: "room_joined",
      props: {
        room: "abc12345",
        name: "alice",
        text: "secret message",
        password: "secret",
        role: "guest",
        kind: "bad value with spaces",
        memberCount: 2.8,
        queueDepth: -1,
      },
    })).toEqual({
      event: "room_joined",
      props: {
        role: "guest",
        memberCount: 2,
      },
    });
  });
});

describe("room alarm helpers", () => {
  it("normalizes persisted alarm schedules", () => {
    expect(normalizeRoomAlarmSchedule({
      idle: 100,
      "sab-bomb": 50,
      bad: 1,
      alsoBad: "soon",
    })).toEqual({
      idle: 100,
      "sab-bomb": 50,
    });
  });

  it("selects the next alarm deadline", () => {
    expect(nextRoomAlarmDeadline({ idle: 100, "sab-bomb": 50 })).toBe(50);
    expect(nextRoomAlarmDeadline({ idle: 100 })).toBe(100);
    expect(nextRoomAlarmDeadline({})).toBeNull();
  });

  it("prioritizes saboteur bomb when multiple alarms are due", () => {
    expect(firstDueRoomAlarm({ idle: 100, "sab-bomb": 100 }, 100)).toBe("sab-bomb");
    expect(firstDueRoomAlarm({ idle: 100 }, 100)).toBe("idle");
    expect(firstDueRoomAlarm({ idle: 100, "sab-bomb": 200 }, 150)).toBe("idle");
    expect(firstDueRoomAlarm({ idle: 100, "sab-bomb": 200 }, 50)).toBeNull();
  });
});

describe("Fort Pass entitlements", () => {
  const now = 1_800_000;

  function rawEntitlement(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId: "party-1",
      hostRef: "cus_test_123",
      provider: "stripe",
      providerRef: "cs_test_123",
      createdAt: now,
      expiresAt: now + 60_000,
      perks: {
        customRoomCode: "Party-1",
        extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS,
        themePack: "retro-plus",
        messageHistory: true,
      },
      ...overrides,
    };
  }

  it("normalizes custom room codes", () => {
    expect(normalizeCustomRoomCode(" Party-1 ")).toBe("party-1");
    expect(normalizeCustomRoomCode("abc")).toBeNull();
    expect(normalizeCustomRoomCode("-party")).toBeNull();
    expect(normalizeCustomRoomCode("party-")).toBeNull();
    expect(normalizeCustomRoomCode("party--1")).toBeNull();
    expect(normalizeCustomRoomCode("analytics")).toBeNull();
    expect(normalizeCustomRoomCode("this-is-too-long")).toBeNull();
  });

  it("reports custom room-code availability without leaking room metadata", () => {
    expect(customRoomCodeAvailability("Party-1", false)).toEqual({
      code: "party-1",
      available: true,
    });
    expect(customRoomCodeAvailability("Party-1", true)).toEqual({
      code: "party-1",
      available: false,
      reason: "taken",
    });
    expect(customRoomCodeAvailability("analytics", false)).toEqual({
      code: null,
      available: false,
      reason: "invalid",
    });
  });

  it("normalizes checkout requests without accepting unsafe fields", () => {
    expect(normalizeFortPassCheckoutRequest({
      customRoomCode: "Party-1",
      email: "alice@example.com",
      paid: true,
    })).toEqual({ customRoomCode: "party-1" });
    expect(normalizeFortPassCheckoutRequest({ customRoomCode: "analytics" })).toBeNull();
    expect(normalizeFortPassCheckoutRequest({ customRoomCode: "x" })).toBeNull();
    expect(normalizeFortPassCheckoutRequest(null)).toBeNull();
  });

  it("keeps only safe entitlement fields and perks", () => {
    expect(normalizeFortPassEntitlement(rawEntitlement(), now)).toEqual({
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId: "party-1",
      hostRef: "cus_test_123",
      provider: "stripe",
      providerRef: "cs_test_123",
      createdAt: now,
      expiresAt: now + 60_000,
      perks: {
        customRoomCode: "party-1",
        extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS,
        themePack: "retro-plus",
      },
    });
  });

  it("marks expired active entitlements as expired", () => {
    const entitlement = normalizeFortPassEntitlement(rawEntitlement({
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
    }), now);

    expect(entitlement?.status).toBe("expired");
    expect(entitlement && isFortPassActive(entitlement, now)).toBe(false);
  });

  it("rejects suspicious entitlement records", () => {
    expect(normalizeFortPassEntitlement(rawEntitlement({ kind: "pro-plan" }), now)).toBeNull();
    expect(normalizeFortPassEntitlement(rawEntitlement({ hostRef: "alice@example.com" }), now)).toBeNull();
    expect(normalizeFortPassEntitlement(rawEntitlement({ roomId: "analytics" }), now)).toBeNull();
    expect(normalizeFortPassEntitlement(rawEntitlement({
      expiresAt: now + 15 * 24 * 60 * 60 * 1000,
    }), now)).toBeNull();
  });

  it("applies active paid room perks only while active", () => {
    const active = normalizeFortPassEntitlement(rawEntitlement(), now);
    const refunded = normalizeFortPassEntitlement(rawEntitlement({ status: "refunded" }), now);

    expect(fortPassAllowsCustomRoomCode(active, "PARTY-1", now)).toBe(true);
    expect(fortPassAllowsCustomRoomCode(active, "other", now)).toBe(false);
    expect(fortPassAllowsCustomRoomCode(refunded, "party-1", now)).toBe(false);
    expect(fortPassIdleMs(active, 600_000, now)).toBe(FORT_PASS_EXTENDED_IDLE_MS);
    expect(fortPassIdleMs(refunded, 600_000, now)).toBe(600_000);
  });

  it("matches paid-room redemption tokens to the provider session", () => {
    const active = normalizeFortPassEntitlement(rawEntitlement(), now);
    const expired = normalizeFortPassEntitlement(rawEntitlement({
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
    }), now);

    expect(normalizeFortPassRedemptionToken(" cs_test_123 ")).toBe("cs_test_123");
    expect(normalizeFortPassRedemptionToken("alice@example.com")).toBeNull();
    expect(fortPassRedemptionMatches(active, "cs_test_123", now)).toBe(true);
    expect(fortPassRedemptionMatches(active, "cs_test_other", now)).toBe(false);
    expect(fortPassRedemptionMatches(expired, "cs_test_123", now)).toBe(false);
  });

  it("allows premium themes only for active Fort Pass rooms", () => {
    const active = normalizeFortPassEntitlement(rawEntitlement(), now);
    const refunded = normalizeFortPassEntitlement(rawEntitlement({ status: "refunded" }), now);

    expect(normalizeRoomTheme("retro-green")).toBe("retro-green");
    expect(normalizeRoomTheme("bad-theme")).toBeNull();
    expect(fortPassAllowsRoomTheme(null, "classic", now)).toBe(true);
    expect(fortPassAllowsRoomTheme(active, "retro-green", now)).toBe(true);
    expect(fortPassAllowsRoomTheme(active, "midnight", now)).toBe(true);
    expect(fortPassAllowsRoomTheme(refunded, "retro-green", now)).toBe(false);
    expect(fortPassAllowsRoomTheme(null, "retro-green", now)).toBe(false);
  });
});

describe("Fort Pass client helpers", () => {
  it("normalizes client-side Fort Pass redirect fields", () => {
    expect(normalizeFortPassCode("Party-1")).toBe("party-1");
    expect(normalizeFortPassCode("analytics")).toBeNull();
    expect(normalizeFortPassCode("x")).toBeNull();
    expect(normalizeFortPassCode("bad code")).toBeNull();
    expect(normalizeFortPassSessionId(" cs_test_123 ")).toBe("cs_test_123");
    expect(normalizeFortPassSessionId("alice@example.com")).toBeNull();
  });

  it("posts checkout requests without granting paid perks client-side", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (_url, init) => {
      requestBody = String(init?.body || "");
      return Response.json({ error: "checkout_not_configured", code: "party-1" }, { status: 501 });
    }) as typeof fetch;

    try {
      await expect(startFortPassCheckout("party-1")).resolves.toEqual({
        ok: false,
        error: "checkout_not_configured",
        code: "party-1",
      });
      expect(JSON.parse(requestBody)).toEqual({ customRoomCode: "party-1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Stripe Fort Pass checkout", () => {
  it("creates a hosted one-time checkout session with Fort Pass metadata", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const session = await createFortPassStripeCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_test",
      publicBaseUrl: "https://pillow.example/some/path?x=1",
      customRoomCode: "party-1",
      fetcher: async (url, init) => {
        receivedUrl = String(url);
        receivedInit = init;
        return Response.json({
          id: "cs_test_123",
          url: "https://checkout.stripe.com/c/pay/cs_test_123",
        });
      },
    });

    expect(session).toEqual({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    expect(receivedUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(receivedInit?.method).toBe("POST");
    expect((receivedInit?.headers as Record<string, string>).authorization).toBe("Bearer sk_test_secret");
    const body = receivedInit?.body as URLSearchParams;
    expect(body.get("mode")).toBe("payment");
    expect(body.get("line_items[0][price]")).toBe("price_test");
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("client_reference_id")).toBe("fort-pass:party-1");
    expect(body.get("metadata[kind]")).toBe("fort-pass");
    expect(body.get("metadata[custom_room_code]")).toBe("party-1");
    expect(body.get("success_url")).toBe("https://pillow.example/?fort_pass=success&code=party-1&session_id={CHECKOUT_SESSION_ID}");
    expect(body.get("cancel_url")).toBe("https://pillow.example/?fort_pass=cancel&code=party-1");
  });

  it("rejects invalid provider responses", async () => {
    await expect(createFortPassStripeCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_test",
      publicBaseUrl: "https://pillow.example",
      customRoomCode: "party-1",
      fetcher: async () => Response.json({ id: "cs_test_123" }),
    })).rejects.toThrow("stripe checkout session response invalid");
  });
});

describe("Stripe Fort Pass webhooks", () => {
  const now = 1_900_000;

  function stripeEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: "evt_test_123",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          object: "checkout.session",
          mode: "payment",
          payment_status: "paid",
          metadata: {
            kind: "fort-pass",
            custom_room_code: "Party-1",
          },
          ...overrides,
        },
      },
    };
  }

  it("verifies Stripe webhook signatures over the raw body", async () => {
    const payload = JSON.stringify(stripeEvent());
    const timestamp = Math.floor(now / 1000);
    const signature = await computeStripeWebhookSignature(payload, timestamp, "whsec_test");

    await expect(verifyStripeWebhookSignature(
      payload,
      `t=${timestamp},v1=${signature}`,
      "whsec_test",
      now
    )).resolves.toEqual({ ok: true });
    await expect(verifyStripeWebhookSignature(
      payload,
      `t=${timestamp},v1=${"0".repeat(64)}`,
      "whsec_test",
      now
    )).resolves.toEqual({ ok: false, reason: "mismatch" });
    await expect(verifyStripeWebhookSignature(
      payload,
      `t=${timestamp - 600},v1=${signature}`,
      "whsec_test",
      now
    )).resolves.toEqual({ ok: false, reason: "stale" });
  });

  it("creates a Fort Pass entitlement from a paid Checkout Session event", () => {
    expect(fortPassEntitlementFromStripeEvent(stripeEvent(), now)).toEqual({
      v: 1,
      kind: "fort-pass",
      status: "active",
      roomId: "party-1",
      hostRef: "cs_test_123",
      provider: "stripe",
      providerRef: "cs_test_123",
      createdAt: now,
      expiresAt: now + 14 * 24 * 60 * 60 * 1000,
      perks: {
        customRoomCode: "party-1",
        extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS,
        themePack: "retro-plus",
      },
    });
  });

  it("ignores unpaid or malformed Checkout Session events", () => {
    expect(fortPassEntitlementFromStripeEvent({ type: "customer.created" }, now)).toBeNull();
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({ payment_status: "unpaid" }), now)).toBeNull();
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({
      metadata: { kind: "fort-pass", custom_room_code: "analytics" },
    }), now)).toBeNull();
  });
});

describe("HTTP security helpers", () => {
  it("classifies common scanner probe paths including encoded variants", () => {
    expect(probeReasonForPath("/.env.prod")).toBe("dotfile");
    expect(probeReasonForPath("/.%65%6Ev.%70%72%6F%64")).toBe("dotfile");
    expect(probeReasonForPath("/.git/refs/heads/main")).toBe("dotfile");
    expect(probeReasonForPath("/wp-content/sallu.php")).toBe("wordpress");
    expect(probeReasonForPath("/cgi-bin/")).toBe("cgi");
    expect(probeReasonForPath("/_profiler/phpinfo")).toBe("profiler");
    expect(probeReasonForPath("/party-1")).toBeNull();
  });

  it("adds browser hardening headers without dropping existing headers", async () => {
    const res = withSecurityHeaders(new Response("ok", {
      headers: { "content-type": "text/plain" },
    }));

    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("strict-transport-security")).toContain("max-age");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await res.text()).toBe("ok");
  });
});
