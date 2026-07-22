import { describe, it, expect } from "bun:test";
import { sanitizeAnalyticsEvent } from "../src/analytics";
import { firstDueRoomAlarm, nextRoomAlarmDeadline, normalizeRoomAlarmSchedule } from "../src/alarms";
import {
  checkFortPassCode,
  clearFortPassClaimSecret,
  fortPassReturnCleanupPath,
  getFortPassClaimSecret,
  getPendingFortPassRedemption,
  normalizeFortPassCode,
  normalizeFortPassSessionId,
  redeemFortPassCheckout,
  rememberPendingFortPassRedemption,
  startFortPassCheckout,
} from "../client/src/services/fortPass";
import { getDiscordActivityContext } from "../client/src/services/discordActivity";
import {
  FORT_PASS_EXTENDED_IDLE_MS,
  fortPassClaimHash,
  fortPassAllowsCustomRoomCode,
  fortPassIdleMs,
  fortPassAllowsRoomTheme,
  fortPassRedemptionMatches,
  isGeneratedFreeRoomId,
  isFortPassActive,
  customRoomCodeAvailability,
  normalizeFortPassCheckoutRequest,
  normalizeCustomRoomCode,
  normalizeFortPassEntitlement,
  normalizeFortPassRedemptionToken,
  normalizeRoomId,
  normalizeRoomTheme,
} from "../src/entitlements";
import { isRpsPick, rpsWinner, tttWinner, voteHasMajority } from "../src/game";
import { isDiscordActivityRequest, logRateLimitedOpsEvent, probeReasonForPath, withSecurityHeaders } from "../src/security";
import { sanitizeDraw, sanitizeStyle, uniqueName, STYLE_COLORS, MAX_DRAW_POINTS, MAX_NAME_LEN } from "../src/shared";
import {
  CUSTOM_ROOM_SECRET_KDF,
  CUSTOM_ROOM_SECRET_MAX_LENGTH,
  CUSTOM_ROOM_SECRET_MIN_LENGTH,
  deriveProtocolRoomSecret,
  generateRoomId,
  generateRoomSecret,
  isCredentialSystemMessage,
  isGeneratedRoomSecret,
  validateCustomRoomSecret,
  validateRoomSecret,
} from "../client/src/services/roomSecret";
import {
  computeStripeWebhookSignature,
  createFortPassStripeCheckoutSession,
  fortPassEntitlementFromStripeEvent,
  normalizePublicBaseUrl,
  resolveFortPassCheckoutSession,
  resolveFortPassEntitlementFromStripeEvent,
  resolveFortPassRevocationFromStripeEvent,
  stripeRevocationEventKey,
  verifyStripeWebhookSignature,
} from "../src/stripe";

const TEST_FORT_PASS_CLAIM_SECRET = "11".repeat(32);
const TEST_FORT_PASS_CLAIM_HASH = "02d449a31fbb267c8f352e9968a79e3e5fc95c1bbeaa502fd6454ebde5a4bedc";

function installMemorySessionStorage(): { values: Map<string, string>; restore: () => void } {
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
  return {
    values,
    restore: () => {
      if (prior) Object.defineProperty(globalThis, "sessionStorage", prior);
      else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    },
  };
}

describe("room secrets", () => {
  it("generates a high-entropy base64url secret", () => {
    const first = generateRoomSecret();
    const second = generateRoomSecret();
    expect(first).toMatch(/^pf2_[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(validateRoomSecret(first)).toEqual({ valid: true, secret: first });
    for (let sample = 0; sample < 128; sample++) {
      expect(validateRoomSecret(generateRoomSecret()).valid).toBe(true);
    }
  });

  it("accepts bounded custom passwords without weakening generated-secret parsing", () => {
    const variedUnicode = Array.from({ length: 64 }, (_, index) => String.fromCodePoint(0x400 + index)).join("");
    const variedEmoji = Array.from({ length: 64 }, (_, index) => String.fromCodePoint(0x1f300 + index)).join("");
    expect(CUSTOM_ROOM_SECRET_MIN_LENGTH).toBe(6);
    expect(CUSTOM_ROOM_SECRET_MAX_LENGTH).toBe(64);
    expect(CUSTOM_ROOM_SECRET_KDF).toBe("pbkdf2-sha256-600k-room-v1");
    expect(validateRoomSecret("Velvet!Orbit7-Cedar")).toEqual({ valid: true, secret: "Velvet!Orbit7-Cedar" });
    expect(validateRoomSecret("four cozy pillows")).toEqual({ valid: true, secret: "four cozy pillows" });
    expect(validateRoomSecret("orb!7x")).toEqual({ valid: true, secret: "orb!7x" });
    expect(validateCustomRoomSecret("orchid")).toEqual({ valid: true, secret: "orchid" });
    expect(validateRoomSecret("cafe\u0301-night-4821")).toEqual({ valid: true, secret: "café-night-4821" });
    expect(validateRoomSecret(variedUnicode).valid).toBe(true);
    expect(validateRoomSecret(variedEmoji).valid).toBe(true);

    expect(validateRoomSecret("five5").valid).toBe(false);
    expect(validateRoomSecret(variedUnicode + "Ж").valid).toBe(false);
    expect(validateRoomSecret(variedEmoji + "🧸").valid).toBe(false);
    expect(validateRoomSecret(" outer-space").valid).toBe(false);
    expect(validateRoomSecret("outer-space ").valid).toBe(false);
    expect(validateRoomSecret("line\tbreak").valid).toBe(false);
    expect(validateRoomSecret("lantern\u2028blanket orbit").valid).toBe(false);
    expect(validateRoomSecret("lantern\u2029blanket orbit").valid).toBe(false);
    expect(validateRoomSecret("lantern\u00a0blanket orbit").valid).toBe(false);
    expect(validateRoomSecret("lantern\ufdd0blanket orbit").valid).toBe(false);
    expect(validateRoomSecret("lantern\ufffeblanket orbit").valid).toBe(false);
    expect(validateRoomSecret("hidden\u200bvalue").valid).toBe(false);
    expect(validateRoomSecret("broken\ud800value").valid).toBe(false);
    expect(validateCustomRoomSecret("password-for-room").valid).toBe(false);
    expect(validateCustomRoomSecret("qwerty").valid).toBe(false);
    expect(validateCustomRoomSecret("123456").valid).toBe(false);
    expect(validateCustomRoomSecret("z".repeat(15)).valid).toBe(false);
    expect(validateCustomRoomSecret("abcd".repeat(16)).valid).toBe(false);
    expect(validateCustomRoomSecret("correcthorsebatterystaple").valid).toBe(false);
    expect(validateCustomRoomSecret("SummerSummer2026!").valid).toBe(false);
    expect(validateCustomRoomSecret("Alice-orbit-velvet-7", { context: ["alice"] }).valid).toBe(false);
    // Join/derive syntax is intentionally stable: future creation-policy
    // changes must not lock an existing compatible room.
    expect(validateRoomSecret("correcthorsebatterystaple").valid).toBe(true);
    expect(validateRoomSecret("abcd".repeat(16)).valid).toBe(true);
    expect(validateRoomSecret(null).valid).toBe(false);
    expect(validateRoomSecret(`pf2_${"A".repeat(42)}`).valid).toBe(false);
    expect(validateRoomSecret(`pf2_${"A".repeat(42)}B`).valid).toBe(false);
    expect(validateCustomRoomSecret(`pf2_${"A".repeat(43)}`).valid).toBe(false);
  });

  it("hardens custom passwords into room-instance-bound canonical protocol secrets", async () => {
    const roomId = "abcdefghij";
    const roomInstance = "AAAAAAAAAAAAAAAAAAAAAA";
    const otherInstance = "AQEBAQEBAQEBAQEBAQEBAQ";
    const password = "four cozy pillows";
    const first = await deriveProtocolRoomSecret(roomId, roomInstance, password);
    const repeated = await deriveProtocolRoomSecret(roomId, roomInstance, password);
    const other = await deriveProtocolRoomSecret(roomId, otherInstance, password);

    expect(first).toBe(repeated);
    expect(first).toBe("pf2_SmahTVA-vkcg0zAhKi5tLv5cTiMS-9ou4RriSorYB5Y");
    expect(first).not.toBe(other);
    expect(isGeneratedRoomSecret(first)).toBe(true);
    expect(validateRoomSecret(first)).toEqual({ valid: true, secret: first });

    const generated = generateRoomSecret();
    expect(await deriveProtocolRoomSecret(roomId, roomInstance, generated)).toBe(generated);
    const creationBlockedLegacy = "correcthorsebatterystaple";
    expect(validateCustomRoomSecret(creationBlockedLegacy).valid).toBe(false);
    expect(await deriveProtocolRoomSecret(roomId, roomInstance, creationBlockedLegacy)).toBe(
      await deriveProtocolRoomSecret(roomId, roomInstance, creationBlockedLegacy),
    );
    await expect(deriveProtocolRoomSecret("INVALID", roomInstance, password)).rejects.toThrow("invalid canonical room id");
    await expect(deriveProtocolRoomSecret(roomId, "invalid", password)).rejects.toThrow("invalid canonical room instance");
  });

  it("generates crypto-backed room IDs in the expected format", () => {
    const roomId = generateRoomId();
    expect(roomId).toMatch(/^f-[a-z2-7]{10}$/);
    expect(isGeneratedFreeRoomId(roomId)).toBe(true);
    expect(normalizeRoomId(roomId)).toBe(roomId);
  });

  it("identifies historical credential banners for export redaction", () => {
    expect(isCredentialSystemMessage("Fort: abc12345 — Password: hunter2")).toBe(true);
    expect(isCredentialSystemMessage("Fort: abc12345 | Secret password: hunter2")).toBe(true);
    expect(isCredentialSystemMessage("Fort: abc12345 | Room secret is hunter2")).toBe(true);
    expect(isCredentialSystemMessage("Room secret: do-not-export")).toBe(true);
    expect(isCredentialSystemMessage("Secret password is do-not-export")).toBe(true);
    expect(isCredentialSystemMessage("Secret: do-not-export")).toBe(true);
    expect(isCredentialSystemMessage("Share the fort flag and room secret privately.")).toBe(false);
  });
});

describe("deployment privacy", () => {
  it("disables Cloudflare invocation logs that include full request URLs", async () => {
    const config = await Bun.file(new URL("../wrangler.toml", import.meta.url)).text();
    const logsSection = config.match(/\[observability\.logs\]([\s\S]*?)(?=\n\[|$)/u)?.[1] || "";
    expect(logsSection).toMatch(/\binvocation_logs\s*=\s*false\b/u);
    expect(logsSection).not.toMatch(/\binvocation_logs\s*=\s*true\b/u);
    const edgeSource = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const websocketBoundary = edgeSource.match(/if \(url\.pathname === "\/ws"\) \{([\s\S]*?)\n  \}\n\n  if \(request\.method/u)?.[1] || "";
    expect(websocketBoundary).not.toMatch(/console\.|logRateLimitedOpsEvent/u);
    const roomSource = await Bun.file(new URL("../src/room.ts", import.meta.url)).text();
    expect(roomSource).not.toMatch(/console\.(?:log|info|warn|error)/u);
  });
});

describe("Discord Activity launch boundary", () => {
  it("keeps unverified route, proxy, and query values presentation-only", async () => {
    const first = await getDiscordActivityContext(new URL(
      "https://pillow.test/activity?instance_id=123456789012345678&platform=desktop",
    ));
    const other = await getDiscordActivityContext(new URL(
      "https://pillow.test/activity?channel_id=attacker-selected&frame_id=forged",
    ));

    expect(first).toEqual({ active: true, source: "activity_route", platform: "desktop" });
    expect(first).not.toHaveProperty("roomId");
    expect(other).toEqual({ active: true, source: "activity_route", platform: "web" });
    expect(other).not.toHaveProperty("roomId");
    expect(await getDiscordActivityContext(new URL("https://pillow.test/"))).toBeNull();
    expect(await getDiscordActivityContext(new URL("https://pillow.test/activity"))).toEqual({
      active: true,
      source: "activity_route",
      platform: "web",
    });

    // Launch-looking query values on the ordinary app are inert.
    expect(await getDiscordActivityContext(new URL(
      "https://pillow.test/?discord_activity=1&frame_id=frame_123",
    ))).toBeNull();
    expect(await getDiscordActivityContext(new URL(
      "https://pillow.test/?frame_id=frame_123&instance_id=attacker-room",
    ))).toBeNull();

    const proxy = await getDiscordActivityContext(new URL(
      "https://pillowfort.discordsays.com/?channel_id=attacker-room",
    ));
    expect(proxy).toEqual({ active: true, source: "discord_proxy", platform: "discord_proxy" });
    expect(proxy).not.toHaveProperty("roomId");
  });
});

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

describe("sanitizeDraw", () => {
  it("accepts bounded normalized drawing points", () => {
    expect(sanitizeDraw({ color: "hsl(359, 80%, 65%)", pts: [[0, 0.5], [1, 1]], s: 1 })).toEqual({
      color: "hsl(359, 80%, 65%)",
      pts: [[0, 0.5], [1, 1]],
      s: 1,
    });
  });

  it("rejects malformed, out-of-range, and oversized drawing payloads", () => {
    expect(sanitizeDraw({ color: "red", pts: [[0, 0]] })).toBeNull();
    expect(sanitizeDraw({ color: "#FF0000", pts: [[Number.NaN, 0]] })).toBeNull();
    expect(sanitizeDraw({ color: "#FF0000", pts: [[1.1, 0]] })).toBeNull();
    expect(sanitizeDraw({ color: "#FF0000", pts: Array.from({ length: MAX_DRAW_POINTS + 1 }, () => [0, 0]) })).toBeNull();
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

  it("requires a majority of eligible voters before ejecting", () => {
    expect(voteHasMajority(1, 0, 2)).toBe(false);
    expect(voteHasMajority(2, 0, 3)).toBe(true);
    expect(voteHasMajority(2, 1, 4)).toBe(false);
    expect(voteHasMajority(3, 1, 4)).toBe(true);
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
      "auth-sockets": 75,
      bad: 1,
      alsoBad: "soon",
    })).toEqual({
      idle: 100,
      "sab-bomb": 50,
      "auth-sockets": 75,
    });
  });

  it("selects the next alarm deadline", () => {
    expect(nextRoomAlarmDeadline({ idle: 100, "sab-bomb": 50, "auth-sockets": 75 })).toBe(50);
    expect(nextRoomAlarmDeadline({ idle: 100 })).toBe(100);
    expect(nextRoomAlarmDeadline({})).toBeNull();
  });

  it("prioritizes saboteur bomb when multiple alarms are due", () => {
    expect(firstDueRoomAlarm({ idle: 100, "sab-bomb": 100 }, 100)).toBe("sab-bomb");
    expect(firstDueRoomAlarm({ idle: 100, "auth-sockets": 100 }, 100)).toBe("auth-sockets");
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
    expect(normalizeCustomRoomCode("activity")).toBeNull();
    expect(normalizeCustomRoomCode("this-is-too-long")).toBeNull();
    expect(normalizeCustomRoomCode("f-paidcode")).toBeNull();
    expect(normalizeCustomRoomCode("f-abcdefghij")).toBeNull();
    expect(normalizeRoomId(" F-ABCDEFGHIJ ")).toBe("f-abcdefghij");
    expect(normalizeRoomId("f-abcdefghij0")).toBeNull();
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
      customRoomCode: "party-1",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
    })).toEqual({ customRoomCode: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH });
    expect(normalizeFortPassCheckoutRequest({
      customRoomCode: "party-1",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
      email: "alice@example.com",
    })).toBeNull();
    expect(normalizeFortPassCheckoutRequest({ customRoomCode: "Party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH })).toBeNull();
    expect(normalizeFortPassCheckoutRequest({ customRoomCode: "analytics", claimHash: TEST_FORT_PASS_CLAIM_HASH })).toBeNull();
    expect(normalizeFortPassCheckoutRequest({ customRoomCode: "party-1", claimHash: "A".repeat(64) })).toBeNull();
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
    expect(normalizeFortPassEntitlement(rawEntitlement({ providerRef: "pi_test_123" }), now)).toBeNull();
    expect(normalizeFortPassEntitlement(rawEntitlement({ createdAt: now + 5 * 60_000 + 1 }), now)).toBeNull();
    expect(normalizeFortPassEntitlement(rawEntitlement({
      perks: { customRoomCode: "other-1", extendedIdleMs: FORT_PASS_EXTENDED_IDLE_MS },
    }), now)).toBeNull();
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

    expect(normalizeRoomTheme("campus-blue")).toBe("campus-blue");
    expect(normalizeRoomTheme("classic")).toBe("away-message");
    expect(normalizeRoomTheme("retro-green")).toBe("campus-blue");
    expect(normalizeRoomTheme("bad-theme")).toBeNull();
    expect(fortPassAllowsRoomTheme(null, "away-message", now)).toBe(true);
    expect(fortPassAllowsRoomTheme(active, "campus-blue", now)).toBe(true);
    expect(fortPassAllowsRoomTheme(active, "top-8", now)).toBe(true);
    expect(fortPassAllowsRoomTheme(refunded, "campus-blue", now)).toBe(false);
    expect(fortPassAllowsRoomTheme(null, "campus-blue", now)).toBe(false);
  });
});

describe("Fort Pass client helpers", () => {
  it("normalizes client-side Fort Pass redirect fields", () => {
    expect(normalizeFortPassCode("Party-1")).toBe("party-1");
    expect(normalizeFortPassCode("analytics")).toBeNull();
    expect(normalizeFortPassCode("x")).toBeNull();
    expect(normalizeFortPassCode("bad code")).toBeNull();
    expect(normalizeFortPassCode("f-abcdefghij")).toBeNull();
    expect(normalizeFortPassSessionId(" cs_test_123 ")).toBe("cs_test_123");
    expect(normalizeFortPassSessionId("alice@example.com")).toBeNull();
    expect(fortPassReturnCleanupPath(
      "/",
      "?fort_pass=cancel&code=party-1&utm_source=test",
      "#top",
    )).toBe("/?utm_source=test#top");
    expect(fortPassReturnCleanupPath(
      "/",
      "?fort_pass=success&code=party-1&session_id=cs_test_123",
      "",
    )).toBe("/");
    expect(fortPassReturnCleanupPath("/", "?code=party-1", "")).toBeNull();
  });

  it("keeps the raw checkout claim tab-scoped and recovers a redeemed pass after navigation", async () => {
    const originalFetch = globalThis.fetch;
    const storage = installMemorySessionStorage();
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || "{}"));
      return Response.json({
        code: "party-1",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_123",
        sessionId: "cs_test_123",
      });
    }) as typeof fetch;

    try {
      await expect(startFortPassCheckout("party-1")).resolves.toMatchObject({
        ok: true,
        code: "party-1",
        sessionId: "cs_test_123",
      });
      const claimSecret = getFortPassClaimSecret("cs_test_123");
      expect(claimSecret).toMatch(/^[a-f0-9]{64}$/u);
      expect(await fortPassClaimHash(claimSecret)).toBe(requestBody.claimHash);
      expect(requestBody.claimHash).not.toBe(claimSecret);

      expect(rememberPendingFortPassRedemption("party-1", "cs_test_123", claimSecret!)).toBe(true);
      expect(getPendingFortPassRedemption()).toEqual({
        code: "party-1",
        sessionId: "cs_test_123",
        claimSecret,
      });
      clearFortPassClaimSecret("cs_test_123");
      expect(getFortPassClaimSecret("cs_test_123")).toBeNull();
      expect(getPendingFortPassRedemption()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      storage.restore();
    }
  });

  it("posts checkout requests without granting paid perks client-side", async () => {
    const originalFetch = globalThis.fetch;
    const storage = installMemorySessionStorage();
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
      const parsed = JSON.parse(requestBody);
      expect(parsed.customRoomCode).toBe("party-1");
      expect(parsed.claimHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(Reflect.ownKeys(parsed).sort()).toEqual(["claimHash", "customRoomCode"]);
    } finally {
      globalThis.fetch = originalFetch;
      storage.restore();
    }
  });

  it("requires server-confirmed redemption before unlocking a returned Checkout", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (_url, init) => {
      requestBody = String(init?.body || "");
      return Response.json({ redeemed: true, code: "party-1" });
    }) as typeof fetch;

    try {
      await expect(redeemFortPassCheckout("party-1", "cs_test_123", TEST_FORT_PASS_CLAIM_SECRET)).resolves.toEqual({
        ok: true,
        code: "party-1",
      });
      expect(JSON.parse(requestBody)).toEqual({
        customRoomCode: "party-1",
        sessionId: "cs_test_123",
        claimSecret: TEST_FORT_PASS_CLAIM_SECRET,
      });
      await expect(redeemFortPassCheckout("party-1", "pi_attacker", TEST_FORT_PASS_CLAIM_SECRET))
        .resolves.toEqual({ ok: false, error: "invalid_checkout_redemption" });
      await expect(redeemFortPassCheckout("party-1", "cs_test_123", "A".repeat(64)))
        .resolves.toEqual({ ok: false, error: "invalid_checkout_redemption" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects noncanonical, status-confused, extra-field, and oversized API responses", async () => {
    const originalFetch = globalThis.fetch;
    const storage = installMemorySessionStorage();
    const validCheckoutUrl = "https://checkout.stripe.com/c/pay/cs_test_123";
    try {
      for (const response of [
        Response.json({ code: "other-1", checkoutUrl: validCheckoutUrl, sessionId: "cs_test_123" }),
        Response.json({ code: "party-1", checkoutUrl: validCheckoutUrl, sessionId: "pi_attacker_123" }),
        Response.json({ code: "party-1", checkoutUrl: validCheckoutUrl, sessionId: "cs_test_123", trusted: true }),
        Response.json({ code: "party-1", checkoutUrl: validCheckoutUrl, sessionId: "cs_test_123" }, { status: 201 }),
      ]) {
        globalThis.fetch = (async () => response) as typeof fetch;
        await expect(startFortPassCheckout("party-1")).resolves.toEqual({
          ok: false,
          error: "checkout_provider_error",
        });
      }

      globalThis.fetch = (async () => new Response(`{"padding":"${"x".repeat(16 * 1024)}"}`, {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      await expect(startFortPassCheckout("party-1")).resolves.toEqual({
        ok: false,
        error: "checkout_provider_error",
      });

      globalThis.fetch = (async () => Response.json({ available: true, code: "other-1" })) as typeof fetch;
      await expect(checkFortPassCode("party-1")).rejects.toThrow("invalid Fort Pass availability response");
      globalThis.fetch = (async () => Response.json({ available: true, code: "party-1" })) as typeof fetch;
      await expect(checkFortPassCode("party-1")).resolves.toEqual({ available: true, code: "party-1" });
    } finally {
      globalThis.fetch = originalFetch;
      storage.restore();
    }
  });

  it("cancels pathologically fragmented Fort Pass API responses", async () => {
    const originalFetch = globalThis.fetch;
    const storage = installMemorySessionStorage();
    let emitted = 0;
    let cancelled = false;
    const fragmented = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 9_000) {
          controller.close();
          return;
        }
        emitted++;
        controller.enqueue(Uint8Array.of(0x20));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (async () => new Response(fragmented, {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    try {
      await expect(startFortPassCheckout("party-1")).resolves.toEqual({
        ok: false,
        error: "checkout_provider_error",
      });
      expect(emitted).toBeGreaterThanOrEqual(8_193);
      expect(emitted).toBeLessThan(9_000);
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      storage.restore();
    }
  });
});

describe("Stripe Fort Pass checkout", () => {
  it("creates a hosted one-time checkout session with Fort Pass metadata", async () => {
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const beforeCreate = Math.floor(Date.now() / 1_000);
    const session = await createFortPassStripeCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_test",
      publicBaseUrl: "https://pillow.example/some/path?x=1",
      customRoomCode: "party-1",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
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
    expect(receivedInit?.redirect).toBe("error");
    expect(receivedInit?.signal).toBeInstanceOf(AbortSignal);
    expect((receivedInit?.headers as Record<string, string>).authorization).toBe("Bearer sk_test_secret");
    const body = receivedInit?.body as URLSearchParams;
    expect(body.get("mode")).toBe("payment");
    expect(body.get("line_items[0][price]")).toBe("price_test");
    expect(body.get("line_items[0][quantity]")).toBe("1");
    const expiresAt = Number(body.get("expires_at"));
    expect(expiresAt).toBeGreaterThanOrEqual(beforeCreate + 31 * 60);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 31 * 60);
    expect(body.get("client_reference_id")).toBe("fort-pass:party-1");
    expect(body.get("metadata[kind]")).toBe("fort-pass");
    expect(body.get("metadata[entitlement_kind]")).toBe("fort-pass");
    expect(body.get("metadata[custom_room_code]")).toBe("party-1");
    expect(body.get("metadata[price_id]")).toBe("price_test");
    expect(body.get("metadata[claim_hash]")).toBe(TEST_FORT_PASS_CLAIM_HASH);
    expect(body.get("success_url")).toBe("https://pillow.example/?fort_pass=success&code=party-1&session_id={CHECKOUT_SESSION_ID}");
    expect(body.get("cancel_url")).toBe("https://pillow.example/?fort_pass=cancel&code=party-1");
  });

  it("rejects invalid provider responses", async () => {
    await expect(createFortPassStripeCheckoutSession({
      secretKey: "sk_test_secret",
      priceId: "price_test",
      publicBaseUrl: "https://pillow.example",
      customRoomCode: "party-1",
      claimHash: TEST_FORT_PASS_CLAIM_HASH,
      fetcher: async () => Response.json({ id: "cs_test_123" }),
    })).rejects.toThrow("stripe checkout session response invalid");
  });
});

describe("Stripe Fort Pass webhooks", () => {
  const now = 1_900_000;
  const priceId = "price_test";

  function stripeEvent(overrides: Record<string, unknown> = {}) {
    return {
      object: "event",
      id: "evt_test_123",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        object: {
          id: "cs_test_123",
          object: "checkout.session",
          created: Math.floor(now / 1_000),
          livemode: false,
          mode: "payment",
          payment_status: "paid",
          status: "complete",
          client_reference_id: "fort-pass:party-1",
          amount_total: 500,
          amount_subtotal: 500,
          currency: "usd",
          metadata: {
            kind: "fort-pass",
            entitlement_kind: "fort-pass",
            custom_room_code: "party-1",
            price_id: priceId,
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
                id: priceId,
                type: "one_time",
                unit_amount: 500,
                currency: "usd",
                livemode: false,
              },
            }],
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
    expect(fortPassEntitlementFromStripeEvent(stripeEvent(), priceId, now)).toEqual({
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
    expect(fortPassEntitlementFromStripeEvent({ type: "customer.created" }, priceId, now)).toBeNull();
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({ payment_status: "unpaid" }), priceId, now)).toBeNull();
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({
      metadata: { kind: "fort-pass", entitlement_kind: "fort-pass", custom_room_code: "analytics" },
    }), priceId, now)).toBeNull();
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({
      line_items: {
        object: "list",
        has_more: false,
        data: [{
          object: "item",
          quantity: 1,
          amount_total: 500,
          amount_subtotal: 500,
          currency: "usd",
          price: { object: "price", id: "price_attacker", type: "one_time", unit_amount: 500, currency: "usd", livemode: false },
        }],
      },
    }), priceId, now)).toBeNull();
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({
      line_items: {
        object: "list",
        has_more: false,
        data: [{
          object: "item",
          quantity: 2,
          amount_total: 1_000,
          amount_subtotal: 1_000,
          currency: "usd",
          price: { object: "price", id: priceId, type: "one_time", unit_amount: 500, currency: "usd", livemode: false },
        }],
      },
      amount_total: 1_000,
      amount_subtotal: 1_000,
    }), priceId, now)).toBeNull();
  });

  it("anchors entitlement lifetime to Stripe's signed creation time", () => {
    const createdAt = now - 60_000;
    const entitlement = fortPassEntitlementFromStripeEvent(stripeEvent({
      created: Math.floor(createdAt / 1_000),
    }), priceId, now);
    expect(entitlement?.createdAt).toBe(createdAt);
    expect(entitlement?.expiresAt).toBe(createdAt + 14 * 24 * 60 * 60 * 1000);
    expect(fortPassEntitlementFromStripeEvent(stripeEvent({
      created: Math.floor((now + 10 * 60_000) / 1_000),
    }), priceId, now)).toBeNull();
  });

  it("retrieves and binds the paid session to the configured Stripe Price", async () => {
    const event = stripeEvent({ line_items: undefined });
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const resolution = await resolveFortPassEntitlementFromStripeEvent(event, {
      secretKey: "sk_test_secret",
      priceId,
      now,
      fetcher: async (url, init) => {
        requestedUrl = String(url);
        requestedInit = init;
        return Response.json(stripeEvent().data.object);
      },
    });

    expect(resolution.status).toBe("verified");
    if (resolution.status === "verified") expect(resolution.claimHash).toBe(TEST_FORT_PASS_CLAIM_HASH);
    expect(requestedUrl).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_123?expand%5B%5D=line_items.data.price");
    expect(requestedInit?.method).toBe("GET");
    expect(requestedInit?.redirect).toBe("error");
    expect((requestedInit?.headers as Record<string, string>).authorization).toBe("Bearer sk_test_secret");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not treat signed metadata as proof of the configured product", async () => {
    const providerSession = stripeEvent().data.object;
    const wrongPriceSession = {
      ...providerSession,
      line_items: {
        ...providerSession.line_items,
        data: [{
          ...providerSession.line_items.data[0],
          price: { ...providerSession.line_items.data[0].price, id: "price_attacker" },
        }],
      },
    };
    await expect(resolveFortPassEntitlementFromStripeEvent(stripeEvent({ line_items: undefined }), {
      secretKey: "sk_test_secret",
      priceId,
      now,
      fetcher: async () => Response.json(wrongPriceSession),
    })).resolves.toEqual({ status: "invalid", reason: "session_binding" });

    const malformedClaimSession = {
      ...providerSession,
      metadata: { ...providerSession.metadata, claim_hash: "A".repeat(64) },
    };
    await expect(resolveFortPassEntitlementFromStripeEvent(stripeEvent({ line_items: undefined }), {
      secretKey: "sk_test_secret",
      priceId,
      now,
      fetcher: async () => Response.json(malformedClaimSession),
    })).resolves.toEqual({ status: "invalid", reason: "session_binding" });
  });

  it("classifies direct Checkout returns and supersession owners authoritatively", async () => {
    const resolveSession = (providerSession: unknown, roomId = "party-1") =>
      resolveFortPassCheckoutSession("cs_test_123", roomId, {
        secretKey: "sk_test_secret",
        priceId,
        now,
        fetcher: async () => Response.json(providerSession),
      });

    const paid = await resolveSession(stripeEvent().data.object);
    expect(paid.status).toBe("verified");
    if (paid.status === "verified") expect(paid.claimHash).toBe(TEST_FORT_PASS_CLAIM_HASH);
    await expect(resolveSession(stripeEvent({ status: "open", payment_status: "unpaid" }).data.object))
      .resolves.toEqual({
        status: "pending", sessionId: "cs_test_123", roomId: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH,
      });
    await expect(resolveSession(stripeEvent({ status: "expired", payment_status: "unpaid" }).data.object))
      .resolves.toEqual({
        status: "expired_unpaid", sessionId: "cs_test_123", roomId: "party-1", claimHash: TEST_FORT_PASS_CLAIM_HASH,
      });
    await expect(resolveSession(stripeEvent().data.object, "other-1"))
      .resolves.toEqual({ status: "invalid" });
  });

  it("fails closed on unavailable or oversized Stripe API responses", async () => {
    await expect(resolveFortPassEntitlementFromStripeEvent(stripeEvent(), {
      secretKey: "sk_test_secret",
      priceId,
      now,
      fetcher: async () => { throw new Error("offline"); },
    })).resolves.toEqual({ status: "unavailable" });

    await expect(resolveFortPassEntitlementFromStripeEvent(stripeEvent(), {
      secretKey: "sk_test_secret",
      priceId,
      now,
      fetcher: async () => new Response("x".repeat(64 * 1024 + 1)),
    })).resolves.toEqual({ status: "unavailable" });
  });

  describe("authoritative refund and dispute revocation", () => {
    const paymentIntentId = "pi_test_123";
    const chargeId = "ch_test_123";
    const disputeId = "du_test_123";

    function providerSession(overrides: Record<string, unknown> = {}) {
      return {
        ...stripeEvent().data.object,
        payment_intent: paymentIntentId,
        ...overrides,
      };
    }

    function charge(amountRefunded: number, overrides: Record<string, unknown> = {}) {
      return {
        id: chargeId,
        object: "charge",
        livemode: false,
        payment_intent: paymentIntentId,
        paid: true,
        captured: true,
        amount: 500,
        amount_captured: 500,
        amount_refunded: amountRefunded,
        refunded: amountRefunded === 500,
        currency: "usd",
        ...overrides,
      };
    }

    function refundEvent(amountRefunded: number) {
      return {
        object: "event",
        id: `evt_test_refund_${amountRefunded}`,
        type: "charge.refunded",
        livemode: false,
        data: { object: charge(amountRefunded) },
      };
    }

    function disputeEvent(paymentIntent: string | null = null) {
      return {
        object: "event",
        id: "evt_test_dispute_123",
        type: "charge.dispute.created",
        livemode: false,
        data: {
          object: {
            id: disputeId,
            object: "dispute",
            charge: chargeId,
            payment_intent: paymentIntent,
            livemode: false,
          },
        },
      };
    }

    function revocationFetcher(options: {
      amountRefunded?: number;
      session?: Record<string, unknown>;
      sessions?: Record<string, unknown>[];
      chargeOverrides?: Record<string, unknown>;
      disputeOverrides?: Record<string, unknown>;
    } = {}): typeof fetch {
      return (async (input) => {
        const url = new URL(String(input));
        if (url.pathname === `/v1/charges/${chargeId}`) {
          return Response.json(charge(options.amountRefunded ?? 250, options.chargeOverrides));
        }
        if (url.pathname === `/v1/disputes/${disputeId}`) {
          return Response.json({
            id: disputeId,
            object: "dispute",
            charge: chargeId,
            payment_intent: null,
            livemode: false,
            amount: 250,
            currency: "usd",
            status: "needs_response",
            ...options.disputeOverrides,
          });
        }
        if (url.pathname === "/v1/checkout/sessions") {
          expect(url.searchParams.get("payment_intent")).toBe(paymentIntentId);
          expect(url.searchParams.get("limit")).toBe("2");
          expect(url.searchParams.get("expand[]")).toBe("data.line_items.data.price");
          return Response.json({
            object: "list",
            has_more: false,
            data: options.sessions || [options.session || providerSession()],
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;
    }

    it("revokes both partial and full refunds only after provider binding", async () => {
      for (const amountRefunded of [250, 500]) {
        await expect(resolveFortPassRevocationFromStripeEvent(refundEvent(amountRefunded), {
          secretKey: "sk_test_secret",
          priceId,
          now,
          fetcher: revocationFetcher({ amountRefunded }),
        })).resolves.toEqual({
          status: "verified",
          eventId: `evt_test_refund_${amountRefunded}`,
          sessionId: "cs_test_123",
          roomId: "party-1",
          reason: "refund",
        });
      }
    });

    it("binds a dispute through its Charge when Stripe exposes a null PaymentIntent on the Dispute", async () => {
      await expect(resolveFortPassRevocationFromStripeEvent(disputeEvent(), {
        secretKey: "sk_test_secret",
        priceId,
        now,
        fetcher: revocationFetcher({ amountRefunded: 0 }),
      })).resolves.toEqual({
        status: "verified",
        eventId: "evt_test_dispute_123",
        sessionId: "cs_test_123",
        roomId: "party-1",
        reason: "dispute",
      });
    });

    it("rejects wrong PaymentIntent, Price, duplicate Sessions, and resolved disputes while deriving the room only from Stripe", async () => {
      await expect(resolveFortPassRevocationFromStripeEvent(refundEvent(250), {
        secretKey: "sk_test_secret",
        priceId,
        fetcher: revocationFetcher({ chargeOverrides: { payment_intent: "pi_attacker_123" } }),
      })).resolves.toEqual({ status: "invalid", reason: "provider_binding" });

      const wrongRoom = providerSession({
        client_reference_id: "fort-pass:other-1",
        metadata: {
          kind: "fort-pass",
          entitlement_kind: "fort-pass",
          custom_room_code: "other-1",
          price_id: priceId,
          claim_hash: TEST_FORT_PASS_CLAIM_HASH,
        },
      });
      await expect(resolveFortPassRevocationFromStripeEvent(refundEvent(250), {
        secretKey: "sk_test_secret",
        priceId,
        fetcher: revocationFetcher({ session: wrongRoom }),
      })).resolves.toEqual({
        status: "verified",
        eventId: "evt_test_refund_250",
        sessionId: "cs_test_123",
        roomId: "other-1",
        reason: "refund",
      });

      const wrongPrice = providerSession({
        line_items: {
          ...stripeEvent().data.object.line_items,
          data: [{
            ...stripeEvent().data.object.line_items.data[0],
            price: { ...stripeEvent().data.object.line_items.data[0].price, id: "price_attacker" },
          }],
        },
      });
      await expect(resolveFortPassRevocationFromStripeEvent(refundEvent(250), {
        secretKey: "sk_test_secret",
        priceId,
        fetcher: revocationFetcher({ session: wrongPrice }),
      })).resolves.toEqual({ status: "invalid", reason: "session_binding" });

      await expect(resolveFortPassRevocationFromStripeEvent(disputeEvent(), {
        secretKey: "sk_test_secret",
        priceId,
        fetcher: revocationFetcher({ amountRefunded: 0, disputeOverrides: { status: "won" } }),
      })).resolves.toEqual({ status: "invalid", reason: "provider_binding" });

      const session = providerSession();
      await expect(resolveFortPassRevocationFromStripeEvent(refundEvent(250), {
        secretKey: "sk_test_secret",
        priceId,
        fetcher: revocationFetcher({ sessions: [session, { ...session, id: "cs_test_duplicate_123" }] }),
      })).resolves.toEqual({ status: "invalid", reason: "session_binding" });
    });

    it("derives opaque, domain-separated idempotency keys from canonical Stripe Event IDs", async () => {
      const first = await stripeRevocationEventKey("evt_test_refund_250");
      const second = await stripeRevocationEventKey("evt_test_refund_500");
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toMatch(/^[a-f0-9]{64}$/);
      expect(first).not.toBe(second);
      await expect(stripeRevocationEventKey("not-an-event")).rejects.toThrow("invalid Stripe Event ID");
    });
  });
});

describe("public checkout return origin", () => {
  it("allows HTTPS and loopback development origins only", () => {
    expect(normalizePublicBaseUrl("https://pillow.example/path?x=1")).toBe("https://pillow.example");
    expect(normalizePublicBaseUrl("http://localhost:3025/path")).toBe("http://localhost:3025");
    expect(normalizePublicBaseUrl("http://127.0.0.1:3025")).toBe("http://127.0.0.1:3025");
    expect(normalizePublicBaseUrl("http://pillow.example")).toBeNull();
    expect(normalizePublicBaseUrl("https://user:p@pillow.example")).toBeNull();
    expect(normalizePublicBaseUrl(" javascript:alert(1)")).toBeNull();
  });
});

describe("HTTP security helpers", () => {
  it("bounds repeated attacker-triggered operations logs", () => {
    const now = 2_000_000;
    const accepted = Array.from({ length: 21 }, () =>
      logRateLimitedOpsEvent("unit-security-log", "ws_rejected", { reason: "invalid_room" }, now)
    );
    expect(accepted.filter(Boolean)).toHaveLength(20);
    expect(accepted.at(-1)).toBe(false);
    expect(logRateLimitedOpsEvent("unit-security-log", "ws_rejected", {}, now + 60_001)).toBe(true);
  });

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

  it("allows Discord framing only on the dedicated activity route", () => {
    expect(isDiscordActivityRequest(new Request("https://pillow.test/activity?frame_id=launch"))).toBe(true);
    expect(isDiscordActivityRequest(new Request("https://pillow.test/?frame_id=launch"))).toBe(false);
    expect(isDiscordActivityRequest(new Request("https://pillow.test/room-code?discord_activity=1"))).toBe(false);
  });
});
