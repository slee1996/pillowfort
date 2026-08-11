import { useRef, useEffect, useState } from "react";
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
import { getSecureRoomRecovery } from "../services/ws";

export function HomeScreen() {
  const name = useGameStore((s) => s.name);
  const activitySource = useGameStore((s) => s.activitySource);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const inputRef = useRef<HTMLInputElement>(null);
  const [nameError, setNameError] = useState("");

  // Check for room link in URL on mount
  useEffect(() => {
    const secureRoomRecovery = getSecureRoomRecovery();
    if (secureRoomRecovery) {
      // An authentication frame may have reached the relay even when its
      // response did not reach this tab. Resume that exact identity before
      // allowing a different setup/join flow to replace its UI context.
      const pendingFortPass = secureRoomRecovery.mode === "setup"
        ? getPendingFortPassRedemption()
        : null;
      useGameStore.getState().setName(secureRoomRecovery.displayName);
      useGameStore.getState().setPendingRoom(
        secureRoomRecovery.mode === "join" ? secureRoomRecovery.roomId : null,
      );
      // A setup claim is a bearer credential for one exact paid room code.
      // Never attach an unrelated tab-scoped redemption to recovery; clearing
      // only the in-memory slot leaves that unrelated session record intact.
      useGameStore.getState().setPendingFortPass(
        pendingFortPass?.code === secureRoomRecovery.roomId ? pendingFortPass : null,
      );
      setScreen(secureRoomRecovery.mode);
      return;
    }

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

  const readScreenName = () => {
    const enteredName = inputRef.current?.value.trim();
    if (!enteredName) {
      setNameError("Choose a screen name before continuing.");
      inputRef.current?.focus();
      return null;
    }
    setNameError("");
    return enteredName;
  };

  const handleSetup = () => {
    ensureAudio();
    const enteredName = readScreenName();
    if (!enteredName) return;
    setName(enteredName);
    useGameStore.getState().setPendingRoom(null);
    setScreen("setup");
  };

  const handleJoin = () => {
    ensureAudio();
    const enteredName = readScreenName();
    if (!enteredName) return;
    setName(enteredName);
    setScreen("join");
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Welcome to pillowfort"
        className="auth-window home-window"
      >
        <div className="xp-window-body">
          <header className="home-brand">
            <div className="home-logo-wrap">
              <LogoIcon size={68} />
            </div>
            <div className="home-brand-copy">
              <div className="home-eyebrow">Private hangouts, no accounts</div>
              <h1 className="home-title">pillowfort</h1>
              <p className="home-tagline">set up &middot; hang out &middot; knock down</p>
            </div>
          </header>

          <div className="home-content">
            {activitySource && (
              <div className="home-activity-note" role="status">
                Discord Activity preview — shared launch linking is not enabled yet.
              </div>
            )}

            <section className="home-identity" aria-labelledby="home-identity-title">
              <h2 id="home-identity-title">What should your friends call you?</h2>
              <p>This name only follows you into the fort you enter.</p>
              <Input
                id="name-input"
                label="Screen name"
                placeholder="e.g. luna"
                maxLength={24}
                autoComplete="off"
                autoCapitalize="off"
                defaultValue={name}
                ref={inputRef}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "name-input-help name-input-error" : "name-input-help"}
                onChange={() => {
                  if (nameError) setNameError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSetup();
                }}
              />
              <div id="name-input-help" className="home-name-help">
                No profile, email, or password needed.
              </div>
              {nameError && (
                <div id="name-input-error" className="home-name-error" role="alert">
                  {nameError}
                </div>
              )}
            </section>

            <div className="home-actions" aria-label="Choose how to enter Pillowfort">
              <Button id="btn-setup" primary className="home-action home-action-primary" onClick={handleSetup}>
                <span className="home-action-copy">
                  <span className="home-action-name">Start a new fort</span>
                  <span className="home-action-description">Open a temporary room and invite your people.</span>
                </span>
                <span className="home-action-arrow" aria-hidden="true">→</span>
              </Button>
              <Button id="btn-join" className="home-action home-action-secondary" onClick={handleJoin}>
                <span className="home-action-copy">
                  <span className="home-action-name">Join a friend&apos;s fort</span>
                  <span className="home-action-description">Use the fort flag and secret they sent you.</span>
                </span>
                <span className="home-action-arrow" aria-hidden="true">→</span>
              </Button>
            </div>

            <ul className="home-trust-strip" aria-label="Pillowfort room promises">
              <li><strong>Invite-only</strong><small>The host approves each device</small></li>
              <li><strong>Encrypted</strong><small>Chat and games stay private</small></li>
              <li><strong>Temporary</strong><small>End the room when you&apos;re done</small></li>
            </ul>

            <details className="home-privacy-note">
              <summary>Privacy at a glance</summary>
              <p>
                Messages and game state are end-to-end encrypted. The relay can still see the room ID,
                connection timing, size buckets, and connected-device count. As with any web app, the code
                served to your browser must be trusted.
              </p>
            </details>

            <div className="home-version">
              Public beta &middot; 2026
            </div>
          </div>
        </div>
      </Window>
    </div>
  );
}
