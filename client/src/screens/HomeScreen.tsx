import { useRef, useEffect } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { LogoIcon } from "../components/xp/Logo";
import { ensureAudio } from "../hooks/useSound";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";
import { track } from "../services/analytics";
import { getDiscordActivityContext } from "../services/discordActivity";
import {
  getFortPassClaimSecret,
  getPendingFortPassRedemption,
  fortPassReturnCleanupPath,
  normalizeFortPassCode,
  normalizeFortPassSessionId,
  redeemFortPassCheckout,
  rememberPendingFortPassRedemption,
} from "../services/fortPass";
import { normalizeRoomId } from "../../../src/entitlements";

export function HomeScreen() {
  const name = useGameStore((s) => s.name);
  const activitySource = useGameStore((s) => s.activitySource);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check for room link in URL on mount
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const activity = await getDiscordActivityContext().catch(() => null);
      if (cancelled) return;
      if (activity) {
        // Until the Discord SDK launch and a server-issued instance token are
        // verified, Activity detection is presentation-only. Public route and
        // query values must never select or preclaim a shared room.
        useGameStore.getState().setActivityContext(activity.source);
        useGameStore.getState().setPendingRoom(null);
        track("discord_activity_detected", {
          source: activity.source,
          reason: activity.platform,
        });
      }

      const params = new URLSearchParams(location.search);
      const fortPassCode = normalizeFortPassCode(params.get("code"));
      const fortPassSessionId = normalizeFortPassSessionId(params.get("session_id"));
      const fortPassClaimSecret = fortPassSessionId ? getFortPassClaimSecret(fortPassSessionId) : null;
      const isFortPassReturn = params.get("fort_pass") === "success";
      const isFortPassCancel = params.get("fort_pass") === "cancel";
      if (
        isFortPassReturn
        && !activity
        && fortPassCode
        && fortPassSessionId
        && fortPassClaimSecret
      ) {
        // Persist the same-tab recovery pointer before removing the return
        // parameters. If provider verification stalls, the page reloads, or
        // the network drops after this point, the raw claim remains
        // discoverable without ever placing it in history or the URL.
        rememberPendingFortPassRedemption(
          fortPassCode,
          fortPassSessionId,
          fortPassClaimSecret,
        );
      }
      if (isFortPassReturn || isFortPassCancel) {
        const cleanedPath = fortPassReturnCleanupPath(
          location.pathname,
          location.search,
          location.hash,
        );
        if (cleanedPath) history.replaceState(null, "", cleanedPath);
      }
      if (!activity && !isFortPassReturn) {
        const recovery = getPendingFortPassRedemption();
        if (recovery && !useGameStore.getState().pendingFortPass) {
          useGameStore.getState().setPendingFortPass(recovery);
        }
      }
      if (isFortPassReturn && (activity || !fortPassCode || !fortPassSessionId || !fortPassClaimSecret)) {
        track("fort_pass_checkout_failed", {
          reason: activity ? "activity_unverified" : "missing_claim_secret",
          source: "stripe",
        });
        useGameStore.getState().showError(
          activity
            ? "Fort Pass redemption is unavailable inside an unverified Discord Activity."
            : "This Checkout return must be opened in the same browser tab that started payment.",
        );
        return;
      }
      if (
        isFortPassReturn &&
        fortPassCode &&
        fortPassSessionId &&
        fortPassClaimSecret
      ) {
        useGameStore.getState().setPendingRoom(null);
        let redemption = await redeemFortPassCheckout(fortPassCode, fortPassSessionId, fortPassClaimSecret).catch(() => ({
          ok: false as const,
          error: "unknown" as const,
        }));
        if (!redemption.ok && redemption.error === "pending") {
          await new Promise(resolve => window.setTimeout(resolve, 1_000));
          if (cancelled) return;
          redemption = await redeemFortPassCheckout(fortPassCode, fortPassSessionId, fortPassClaimSecret).catch(() => ({
            ok: false as const,
            error: "unknown" as const,
          }));
        }
        if (cancelled) return;
        if (redemption.ok) {
          useGameStore.getState().setPendingFortPass({
            code: fortPassCode,
            sessionId: fortPassSessionId,
            claimSecret: fortPassClaimSecret,
          });
          track("fort_pass_checkout_returned", { source: "stripe" });
          setScreen("setup");
        } else {
          track("fort_pass_checkout_failed", { reason: redemption.error, source: "stripe" });
          useGameStore.getState().showError(
            redemption.error === "pending"
              ? "Payment verification is still pending. Wait a moment before trying setup again."
              : "Payment could not be verified, so the custom code was not unlocked.",
          );
        }
        return;
      }

      const roomFromPath = activity ? null : normalizeRoomId(location.pathname.slice(1));
      if (roomFromPath) {
        history.replaceState(null, "", "/");
        useGameStore.getState().setPendingRoom(roomFromPath);
        setScreen("join");
      } else if (name && inputRef.current) {
        inputRef.current.select();
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSetup = () => {
    ensureAudio();
    const n = inputRef.current?.value.trim();
    if (!n) {
      inputRef.current?.focus();
      return;
    }
    setName(n);
    useGameStore.getState().setPendingRoom(null);
    setScreen("setup");
  };

  const handleJoin = () => {
    ensureAudio();
    const n = inputRef.current?.value.trim();
    if (!n) {
      inputRef.current?.focus();
      return;
    }
    setName(n);
    setScreen("join");
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="pillowfort Sign On"
        className="auth-window home-window"
        buttons={[
          { label: "─", onClick: () => {} },
          { label: "✕", close: true, onClick: () => {} },
        ]}
      >
        <div className="xp-window-body">
          <div className="home-brand">
            <div className="home-logo-wrap">
              <LogoIcon size={72} />
            </div>
            <div className="home-title">
              pillowfort
            </div>
            <div className="home-tagline">
              set up &middot; hang out &middot; knock down
            </div>
          </div>

          <div className="home-divider" />

          <div className="home-trust-strip" aria-label="Beta trust notes">
            <span>invite-only</span>
            <span>no accounts</span>
            <span>temporary rooms</span>
          </div>

          {activitySource && (
            <div className="home-activity-note" role="status">
              Discord Activity preview — shared launch linking is not enabled yet.
            </div>
          )}

          <Input
            id="name-input"
            label="Screen Name"
            placeholder="Enter a screen name"
            maxLength={24}
            autoComplete="off"
            autoCapitalize="off"
            defaultValue={name}
            ref={inputRef}
            onKeyDown={(e) => e.key === "Enter" && handleSetup()}
          />

          <div className="auth-actions">
            <Button id="btn-setup" primary onClick={handleSetup}>
              Start Hangout
            </Button>
            <Button id="btn-join" onClick={handleJoin}>
              Join Fort
            </Button>
          </div>

          <div className="home-privacy-note">
            Messages and game state are end-to-end encrypted. The relay can still see the room ID, connection timing,
            size buckets, and connected-device count. As with any web app, the code served to your browser must be trusted.
          </div>

          <div className="home-version">
            Public beta &middot; 2026
          </div>
        </div>
      </Window>
    </div>
  );
}
