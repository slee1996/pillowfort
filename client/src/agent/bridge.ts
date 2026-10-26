import { createParticipantAgent, type PillowfortAgent } from "../../../src/participant/agent";
import { AgentError, object, text, confirm, type Schema } from "../../../src/participant/schema";
import { participantStore as store } from "../stores/gameStore";
import { participantFormatStore } from "../stores/formatStore";
import { participantController, participantEvents } from "../services/ws";
import { getDiscordActivityContext } from "../services/discordActivity";
import { checkFortPassCode, clearFortPassClaimSecret, fortPassRedemptionErrorMessage, getFortPassStatus, getFortPassClaimSecret, getPendingFortPassCheckoutUrl, getPendingFortPassRedemption, normalizeFortPassCode, normalizeFortPassSessionId, redeemFortPassCheckout, rememberPendingFortPassRedemption, startFortPassCheckout } from "../services/fortPass";
import { breakoutSnapshot, moveBreakout, resetBreakout, selectRoomActivity, subscribeBreakout } from "./breakout";
import { exportDrawingPng, getDrawingSurfaceSnapshot, setDrawingColor, subscribeDrawingSurface } from "../services/drawingSurface";

declare global { interface Window { pillowfortAgent?: PillowfortAgent } }
function fail(code: string, message: string, retryable = false): never { throw new AgentError(code, message, retryable); }
let participantBridge: PillowfortAgent | undefined;
export function installPillowfortAgent({ exposeWindow = true } = {}): PillowfortAgent | undefined {
  if (exposeWindow && new URLSearchParams(location.search).get("agent") !== "1") return;
  const bridge = participantBridge ??= createParticipantAgent({
    store, controller: participantController, events: participantEvents, origin: location.origin,
    formatStore: participantFormatStore,
    activities: { breakoutSnapshot, moveBreakout, resetBreakout, selectRoomActivity, subscribeBreakout,
      exportDrawingPng, getDrawingSurfaceSnapshot, setDrawingColor, subscribeDrawingSurface,
      dispose() { selectRoomActivity("conversation"); },
    },
    browser: {
      getPendingFortPassRedemption, clearFortPassClaimSecret,
      invitationContextBlocked: async () => new URLSearchParams(location.search).has("fort_pass") || !!await getDiscordActivityContext(),
      registerActions(add) {
  add("fort_pass_status", "Check Fort Pass availability/configuration, price and perks without starting payment.", object(), false, () => getFortPassStatus());
  const codeSchema: Schema = { ...text(10, 4), description: "Canonical custom flag: 4–10 lowercase letters/digits with optional single internal hyphens." };
  const checkCode = (code: string) => { if (normalizeFortPassCode(code) !== code) fail("invalid-code", "Use a canonical 4–10 character custom fort flag."); };
  add("fort_pass_code_check", "Check custom fort-flag availability.", object({ code: codeSchema }), false, input => { checkCode(input.code); return checkFortPassCode(input.code); });
  add("fort_pass_checkout_prepare", "Prepare a Stripe-hosted checkout URL and retain its claim credential in this tab. Does not pay or navigate. A human must complete payment separately; redemption must use this same browser session.", object({ code: codeSchema, confirm }), true, async input => {
    checkCode(input.code);
    if (store.getState().activitySource) fail("unauthorized", "Checkout is unavailable inside an unverified Discord Activity.");
    const pending = getPendingFortPassRedemption();
    if (pending) {
      const checkoutUrl = getPendingFortPassCheckoutUrl(pending.sessionId);
      if (pending.code === input.code && checkoutUrl) {
        return { status: "prepared", ok: true, code: pending.code, checkoutUrl, sessionId: pending.sessionId };
      }
      fail("purchase-recovery-required", "An original checkout is saved in this tab. Retry that purchase with fort_pass_redeem; do not create a duplicate checkout.");
    }
    const result = await startFortPassCheckout(input.code);
    if (!result.ok) fail(result.error, "Checkout could not be prepared. Check configuration and custom-code availability; retain any saved original purchase.", result.error === "checkout_provider_error" || result.error === "checkout_rate_limited" || result.error === "checkout_source_unavailable" || result.error === "checkout_reservation_unavailable");
    return { status: "prepared", ...result };
  });
  add("fort_pass_redeem", "Verify a completed checkout using this tab's retained claim secret and prepare the purchased code for room_setup. Never exports claim credentials or performs payment.", object({ code: codeSchema, sessionId: text(266), confirm }), true, async input => {
    checkCode(input.code);
    if (store.getState().activitySource) fail("unauthorized", "Redemption is unavailable inside an unverified Discord Activity.");
    if (normalizeFortPassSessionId(input.sessionId) !== input.sessionId) fail("invalid-session", "Use the exact Stripe session id returned by checkout preparation.");
    const claimSecret = getFortPassClaimSecret(input.sessionId);
    if (!claimSecret) fail("claim-unavailable", "Redeem in the same browser session that prepared this checkout.");
    const pending = getPendingFortPassRedemption();
    if (pending && (pending.code !== input.code || pending.sessionId !== input.sessionId)) {
      fail("purchase-recovery-required", "Use the code and session from the original saved checkout. Do not replace it or buy another pass.");
    }
    if (!rememberPendingFortPassRedemption(input.code, input.sessionId, claimSecret!)) fail("storage-unavailable", "Cannot retain redemption recovery in this browser.");
    const result = await redeemFortPassCheckout(input.code, input.sessionId, claimSecret!);
    if (!result.ok) fail(result.error, fortPassRedemptionErrorMessage(result.error), result.error === "pending" || result.error === "checkout_verification_failed" || result.error === "checkout_rate_limited" || result.error === "checkout_source_unavailable" || result.error === "checkout_redemption_unavailable" || result.error === "unknown");
    store.getState().setPendingFortPass({ code: input.code, sessionId: input.sessionId, claimSecret: claimSecret! });
    return { status: "redeemed", code: result.code };
  });

      },
    },
  });
  if (exposeWindow && !window.pillowfortAgent) {
    Object.defineProperty(window, "pillowfortAgent", { value: bridge, configurable: false, writable: false });
  }
  return bridge;
}
