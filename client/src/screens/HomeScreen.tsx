import { useRef, useEffect, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { LogoIcon } from "../components/xp/Logo";
import { ensureAudio } from "../hooks/useSound";
import { track } from "../services/analytics";
import { getDiscordActivityContext } from "../services/discordActivity";
import {
  getFortPassClaimSecret,
  getPendingFortPassRedemption,
  fortPassRedemptionErrorMessage,
  fortPassReturnCleanupPath,
  normalizeFortPassCode,
  normalizeFortPassSessionId,
  redeemFortPassCheckout,
  rememberPendingFortPassRedemption,
} from "../services/fortPass";
import { normalizeRoomId } from "../../../src/entitlements";
import { getSecureRoomRecovery } from "../services/ws";
import { isSecureDisplayNameV4 } from "../../../src/applicationEventsV4";
import { peekRoomInvitation, takeRoomInvitation, takeRoomInvitationError } from "../services/roomInvitation";

export function HomeScreen() {
  const name = useGameStore((s) => s.name);
  const activitySource = useGameStore((s) => s.activitySource);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const inputRef = useRef<HTMLInputElement>(null);
  const [nameError, setNameError] = useState("");
  const [fortPassNotice, setFortPassNotice] = useState("");
  const [invitationNotice, setInvitationNotice] = useState("");

  // Check for room link in URL on mount
  useEffect(() => {
    const invitation = peekRoomInvitation();
    const invitationError = takeRoomInvitationError();
    const invitationAttempted = !!invitation || !!invitationError;
    const params = new URLSearchParams(location.search);
    const isFortPassReturn = params.get("fort_pass") === "success";
    const isFortPassCancel = params.get("fort_pass") === "cancel";
    const incompatiblePayment = invitationAttempted && (isFortPassReturn || isFortPassCancel);
    const reportInvitation = (message: string) => {
      setInvitationNotice(message);
      useGameStore.getState().showError(message);
    };
    if (incompatiblePayment) {
      takeRoomInvitation();
      reportInvitation("This invite cannot be combined with a payment return. Finish your original checkout in this tab, then open the invite on its own.");
    } else if (invitationError) {
      reportInvitation(invitationError);
    }
    const secureRoomRecovery = getSecureRoomRecovery();
    const resumeRecovery = () => {
      if (!secureRoomRecovery) return false;
      if (invitation && !incompatiblePayment) history.replaceState(null, "", "/");
      if (invitation && (secureRoomRecovery.mode !== "join" || secureRoomRecovery.roomId !== invitation.roomId)) {
        takeRoomInvitation();
        reportInvitation("Resume your original fort first. This invite was discarded so it cannot replace your saved secure identity.");
      }
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
      return true;
    };
    if (secureRoomRecovery && (!invitation || incompatiblePayment)) {
      resumeRecovery();
      return;
    }

    let cancelled = false;
    const fortPassCode = normalizeFortPassCode(params.get("code"));
    const fortPassSessionId = normalizeFortPassSessionId(params.get("session_id"));
    const fortPassClaimSecret = fortPassSessionId ? getFortPassClaimSecret(fortPassSessionId) : null;
    // A same-tab checkout reference is recovery context, never payment proof.
    // Restore it before any asynchronous work so setup cannot lose the purchase.
    if (isFortPassReturn && fortPassCode && fortPassSessionId && fortPassClaimSecret) {
      rememberPendingFortPassRedemption(fortPassCode, fortPassSessionId, fortPassClaimSecret);
      useGameStore.getState().setPendingFortPass({
        code: fortPassCode,
        sessionId: fortPassSessionId,
        claimSecret: fortPassClaimSecret,
      });
      setFortPassNotice("Your original checkout is saved in this tab. Verifying payment…");
    } else {
      const recovery = getPendingFortPassRedemption();
      if (recovery) useGameStore.getState().setPendingFortPass(recovery);
      if (isFortPassCancel) {
        setFortPassNotice(recovery
          ? "Checkout was canceled. Start a new fort to resume or verify that same saved checkout, or explicitly choose a free fort. Payment has not been confirmed."
          : "Checkout was canceled. No payment has been confirmed. You can still start a free fort.");
      }
    }
    if (isFortPassReturn || isFortPassCancel) {
      const cleanedPath = fortPassReturnCleanupPath(location.pathname, location.search, location.hash);
      if (cleanedPath) history.replaceState(null, "", cleanedPath);
    }
    void (async () => {
      const activity = await getDiscordActivityContext().catch(() => null);
      if (cancelled || useGameStore.getState().screen !== "home") return;
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
      if (activity && invitationAttempted) {
        takeRoomInvitation();
        reportInvitation("Open this invite in a regular browser tab, outside Discord Activity. No invitation was joined here.");
      }
      if (resumeRecovery()) return;

      if (isFortPassReturn && (activity || !fortPassCode || !fortPassSessionId || !fortPassClaimSecret)) {
        track("fort_pass_checkout_failed", {
          reason: activity ? "activity_unverified" : "missing_claim_secret",
          source: "stripe",
        });
        const message = activity
          ? "Fort Pass redemption is unavailable inside an unverified Discord Activity. Keep your original checkout in the browser tab where you started it."
          : "This Checkout return must be opened in the same browser tab that started payment. Return to that tab to resume or verify the original purchase; do not buy another pass.";
        setFortPassNotice(message);
        useGameStore.getState().showError(message);
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
          const message = fortPassRedemptionErrorMessage(redemption.error);
          setFortPassNotice(message);
          useGameStore.getState().showError(message);
        }
        return;
      }

      if (invitationAttempted) {
        if (invitation && !activity && !incompatiblePayment) {
          history.replaceState(null, "", "/");
          useGameStore.getState().setPendingRoom(invitation.roomId);
          setScreen("join");
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
    const enteredName = inputRef.current?.value.normalize("NFC").trim() ?? "";
    if (!isSecureDisplayNameV4(enteredName)) {
      setNameError(enteredName
        ? "Use 1–24 visible characters. Remove hidden/control characters and choose a non-reserved name (not constructor, prototype, or __proto__)."
        : "Choose a screen name before continuing.");
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
    takeRoomInvitation();
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
    <main className="screen entry-screen">
      <section className="entry-card entry-card-home" aria-labelledby="home-title">
        <header className="entry-brand">
          <LogoIcon size={48} />
          <span>pillowfort</span>
        </header>
        <h1 id="home-title" className="entry-title">A little room for your people</h1>
        <p className="entry-description">
          Invite your friends to talk, doodle, and play. A private, temporary fort, with no accounts.
        </p>
        {activitySource && (
          <p className="auth-note" role="status">
            Discord Activity preview — shared launch linking is not enabled yet.
          </p>
        )}
        {fortPassNotice && <p className="auth-note" role="status">{fortPassNotice}</p>}
        {invitationNotice && <p className="auth-note" role="status">{invitationNotice}</p>}
        <form className="entry-form" onSubmit={(event) => { event.preventDefault(); handleSetup(); }}>
          <Input
            id="name-input"
            label="What should your friends call you?"
            placeholder="Your screen name"
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
            autoFocus
          />
          <p id="name-input-help" className="secret-help">Just a name for this fort. No account or email needed.</p>
          {nameError && (
            <div id="name-input-error" className="secret-error" role="alert">{nameError}</div>
          )}
          <div className="entry-actions">
            <Button id="btn-setup" type="submit" primary>Start a new fort</Button>
            <Button id="btn-join" type="button" onClick={handleJoin}>Join a friend&apos;s fort</Button>
          </div>
        </form>
        <details className="entry-details">
          <summary>Private by invitation. Temporary by design.</summary>
          <p>
            Friends need the password and your approval to enter. End the fort when you&apos;re done.
            Messages and game state are end-to-end encrypted. The relay can still see the room ID,
            connection timing, size buckets, and connected-device count. As with any web app, the code
            served to your browser must be trusted.
          </p>
        </details>
      </section>
    </main>
  );
}
