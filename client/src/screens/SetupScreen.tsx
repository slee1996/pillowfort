import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { LogoIcon } from "../components/xp/Logo";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { cancelSecureRoomConnection, getSecureRoomRecovery, setupSecureRoom } from "../services/ws";
import { track } from "../services/analytics";
import { checkFortPassCode, clearFortPassClaimSecret, fortPassRedemptionErrorMessage, getFortPassStatus, getPendingFortPassCheckoutUrl, getPendingFortPassRedemption, normalizeFortPassCode, redeemFortPassCheckout, startFortPassCheckout, type FortPassStatus, type PendingFortPassRedemption } from "../services/fortPass";
import {
  generateRoomId,
  generateRoomSecret,
  validateCustomRoomSecret,
  validateRoomSecret,
} from "../services/roomSecret";
import { showToast } from "../components/xp/Toast";
import { isSecureDisplayNameV4 } from "../../../src/applicationEventsV4";
import { normalizeRoomId } from "../../../src/entitlements";
import { copyTextWithFallback } from "../services/clipboard";

type FortPassPreviewTheme = "campus-blue" | "top-8";

export function SetupScreen() {
  const name = useGameStore((s) => s.name);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingFortPass = useGameStore((s) => s.pendingFortPass);
  const setPendingFortPass = useGameStore((s) => s.setPendingFortPass);
  const activitySource = useGameStore((s) => s.activitySource);
  const activityMode = activitySource !== null;
  const recoveryHint = useRef(getSecureRoomRecovery()).current;
  const setupRecovery = recoveryHint?.mode === "setup" ? recoveryHint : null;
  const setupDisplayName = setupRecovery?.displayName ?? name.normalize("NFC").trim();
  const [storedFortPass] = useState(() => getPendingFortPassRedemption());
  const [useFreeFort, setUseFreeFort] = useState(false);
  const savedFortPass = setupRecovery
    ? storedFortPass?.code === setupRecovery.roomId ? storedFortPass : null
    : pendingFortPass ?? storedFortPass;
  const activeFortPass = useFreeFort ? null : savedFortPass;
  const [verifiedFortPass, setVerifiedFortPass] = useState<PendingFortPassRedemption | null>(null);
  const fortPassVerified = !!activeFortPass && verifiedFortPass?.code === activeFortPass.code
    && verifiedFortPass.sessionId === activeFortPass.sessionId
    && verifiedFortPass.claimSecret === activeFortPass.claimSecret;
  const [fortPassCode, setFortPassCode] = useState("");
  const [fortPassStatus, setFortPassStatus] = useState("");
  const [fortPassCodeError, setFortPassCodeError] = useState("");
  const [fortPassConfig, setFortPassConfig] = useState<FortPassStatus | null>(null);
  const [fortPassBusy, setFortPassBusy] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<FortPassPreviewTheme>("campus-blue");
  const [secret, setSecret] = useState(() => setupRecovery ? "" : generateRoomSecret());
  const [customSecret, setCustomSecret] = useState(!!setupRecovery);
  const [generatedSecretSaved, setGeneratedSecretSaved] = useState(false);
  const [manualSecretSave, setManualSecretSave] = useState(false);
  const [passwordOptionsOpen, setPasswordOptionsOpen] = useState(!!setupRecovery);
  const [showSecret, setShowSecret] = useState(false);
  const [secretError, setSecretError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const operationRef = useRef<"copy" | "create" | "checkout" | "verify" | "cancel" | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(true);
  const copyControllerRef = useRef<AbortController | null>(null);
  const [recoveryRequired, setRecoveryRequired] = useState(!!setupRecovery);
  const [recoveryCredentialLocked, setRecoveryCredentialLocked] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const fortPassCodeRef = useRef<HTMLInputElement>(null);
  const setupRoomIdRef = useRef<string | null>(setupRecovery?.roomId ?? null);
  const busy = copying || connecting || fortPassBusy || cancelling;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (customSecret || recoveryRequired) setPasswordOptionsOpen(true);
  }, [customSecret, recoveryRequired]);

  const handleCopySecret = async () => {
    if (operationRef.current) return;
    const validation = recoveryRequired
      ? validateRoomSecret(secret)
      : customSecret
      ? validateCustomRoomSecret(secret, { context: [setupDisplayName, setupRoomIdRef.current || activeFortPass?.code || ""] })
      : validateRoomSecret(secret);
    if (!validation.valid) {
      setSecretError(validation.message);
      passwordRef.current?.focus();
      return;
    }
    const attempt = ++attemptRef.current;
    copyControllerRef.current?.abort();
    const copyController = new AbortController();
    copyControllerRef.current = copyController;
    operationRef.current = "copy";
    setCopying(true);
    setSecret(validation.secret);
    setSecretError("");
    try {
      const copied = await copyTextWithFallback(validation.secret, copyController.signal);
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      if (!customSecret && !recoveryRequired) {
        setGeneratedSecretSaved(copied);
        if (!copied) setManualSecretSave(true);
      }
      if (copied) showToast("Password copied");
    } finally {
      if (attempt === attemptRef.current) {
        operationRef.current = null;
        if (mountedRef.current) setCopying(false);
      }
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (activityMode) {
      setFortPassConfig({ beta: true, checkoutConfigured: false, priceLabel: "", perks: [] });
      setFortPassStatus("");
      setFortPassBusy(false);
      return () => { cancelled = true; };
    }
    getFortPassStatus()
      .then((status) => {
        if (cancelled) return;
        setFortPassConfig(status);
        track("fort_pass_status_checked", {
          reason: status.checkoutConfigured ? "configured" : "not_configured",
          source: "setup",
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFortPassConfig({ beta: true, checkoutConfigured: false, priceLabel: "", perks: [] });
        track("fort_pass_status_checked", { reason: "failed", source: "setup" });
      });
    return () => {
      cancelled = true;
    };
  }, [activityMode]);

  const verifyFortPass = async (purchase: PendingFortPassRedemption, attempt: number) => {
    setFortPassStatus("Verifying your original checkout…");
    const result = await redeemFortPassCheckout(purchase.code, purchase.sessionId, purchase.claimSecret)
      .catch(() => ({ ok: false as const, error: "unknown" as const }));
    if (!mountedRef.current || attempt !== attemptRef.current || useGameStore.getState().screen !== "setup") return false;
    if (!result.ok) {
      setVerifiedFortPass(null);
      setFortPassStatus(fortPassRedemptionErrorMessage(result.error));
      return false;
    }
    setVerifiedFortPass(purchase);
    setFortPassStatus("Payment verified for this saved checkout. You can now open your fort.");
    return true;
  };

  const handleVerifyFortPass = async () => {
    if (operationRef.current || !activeFortPass || recoveryRequired || activityMode) return;
    const attempt = ++attemptRef.current;
    operationRef.current = "verify";
    setFortPassBusy(true);
    try {
      await verifyFortPass(activeFortPass, attempt);
    } finally {
      if (attempt === attemptRef.current) {
        operationRef.current = null;
        if (mountedRef.current) setFortPassBusy(false);
      }
    }
  };

  const handleResumeCheckout = () => {
    if (operationRef.current || !activeFortPass || recoveryRequired || activityMode) return;
    const checkoutUrl = getPendingFortPassCheckoutUrl(activeFortPass.sessionId);
    if (!checkoutUrl) {
      setFortPassStatus("The original checkout link is unavailable. Keep this tab and retry payment verification; do not start another purchase.");
      return;
    }
    operationRef.current = "checkout";
    setFortPassBusy(true);
    try {
      location.assign(checkoutUrl);
    } catch {
      operationRef.current = null;
      setFortPassBusy(false);
      setFortPassStatus("Could not open your original checkout. Keep this tab and try resuming it again.");
    }
  };

  const handleFreeFortChoice = () => {
    if (operationRef.current || recoveryRequired || getSecureRoomRecovery()) return;
    // Only an uncommitted setup can change room identity. Keep purchase storage.
    setupRoomIdRef.current = null;
    setUseFreeFort((current) => !current);
    setVerifiedFortPass(null);
    setFortPassStatus("");
    setConnectionError("");
    setSecretError("");
  };

  const handleCreate = async () => {
    if (operationRef.current) return;
    setConnectionError("");
    if (!isSecureDisplayNameV4(setupDisplayName)) {
      setConnectionError("Your screen name is invalid. Cancel and choose a name of 1–24 visible characters without hidden/control characters or reserved names.");
      return;
    }
    if (!recoveryRequired && !customSecret && manualSecretSave && !generatedSecretSaved) {
      setSecretError("Save this password, then confirm below before creating your fort.");
      return;
    }
    const roomId = setupRoomIdRef.current ??
      (activityMode ? generateRoomId() : activeFortPass?.code || generateRoomId());
    if (normalizeRoomId(roomId) !== roomId) {
      setConnectionError("This fort flag is invalid. Cancel and reopen setup with a valid flag.");
      return;
    }
    setupRoomIdRef.current = roomId;
    const validation = recoveryRequired
      ? validateRoomSecret(secret)
      : customSecret
      ? validateCustomRoomSecret(secret, { context: [setupDisplayName, roomId] })
      : validateRoomSecret(secret);
    if (!validation.valid) {
      setSecretError(validation.message);
      passwordRef.current?.focus();
      return;
    }
    const pw = validation.secret;
    const attempt = ++attemptRef.current;
    operationRef.current = "create";
    setSecret(pw);
    setSecretError("");
    const options = {
      roomId,
      roomSecret: pw,
      displayName: setupDisplayName,
      ...(!activityMode && activeFortPass ? {
        fortPassSessionId: activeFortPass.sessionId,
        fortPassClaimSecret: activeFortPass.claimSecret,
      } : {}),
    };
    if (recoveryRequired) setRecoveryCredentialLocked(true);
    const needsCopy = !recoveryRequired && !customSecret && !manualSecretSave;
    try {
      // Secure recovery resumes an exact prior room and password; its claim
      // may already be consumed. Only a fresh paid setup needs redemption here.
      if (!recoveryRequired && !activityMode && activeFortPass) {
        setFortPassBusy(true);
        const verified = await verifyFortPass(activeFortPass, attempt);
        if (!mountedRef.current || attempt !== attemptRef.current) return;
        setFortPassBusy(false);
        if (!verified) return;
      }
      if (needsCopy) {
        copyControllerRef.current?.abort();
        const copyController = new AbortController();
        copyControllerRef.current = copyController;
        operationRef.current = "copy";
        setCopying(true);
        const copied = await copyTextWithFallback(pw, copyController.signal);
        if (!mountedRef.current || attempt !== attemptRef.current || useGameStore.getState().screen !== "setup") return;
        setCopying(false);
        if (!copied) {
          setManualSecretSave(true);
          setGeneratedSecretSaved(false);
          setSecretError("Copy the password manually, then confirm you saved it. Your fort has not been created.");
          return;
        }
        setGeneratedSecretSaved(true);
      }
      operationRef.current = "create";
      setConnecting(true);
      let result = await setupSecureRoom(options);
      if (attempt !== attemptRef.current) return;
      if (result.status === "busy" && window.confirm("This secure fort is open in another tab. Move it here?")) {
        result = await setupSecureRoom({ ...options, lock: { takeover: true } });
        if (attempt !== attemptRef.current) return;
      }
      if (result.status !== "connected") {
        setPassword(null);
        const currentRecovery = getSecureRoomRecovery();
        const mustRecover = currentRecovery?.mode === "setup" ||
          (result.status === "failed" &&
            (result.reason === "recovery-required" || result.reason === "recovery-credential-mismatch"));
        const credentialMismatch = result.status === "failed" &&
          result.reason === "recovery-credential-mismatch";
        setRecoveryRequired(mustRecover);
        if (credentialMismatch) setRecoveryCredentialLocked(false);
        else if (mustRecover) setRecoveryCredentialLocked(true);
        const reportError = credentialMismatch ||
          (!mustRecover && result.status === "failed" && result.reason === "authentication-failed")
          ? setSecretError
          : setConnectionError;
        reportError(credentialMismatch
          ? "No saved setup matched that password. Re-enter the exact password you copied."
          : mustRecover
          ? "This setup may already exist. Retry with this exact password to resolve it."
          : result.status === "busy"
          ? "This secure fort is already open in another tab."
          : result.status === "failed" && result.reason === "rate-limited"
            ? "Too many attempts. Wait a minute, then try again."
            : result.status === "failed" && result.reason === "authentication-failed"
              ? "Could not create that fort. Check its flag and password."
              : result.status === "unsupported"
                ? result.reason === "takeover-channel-unavailable"
                  ? "This browser cannot move a fort between tabs. Return to the original tab."
                  : "This browser does not support the secure tab locking required to build a fort. Use a supported browser."
                : result.status === "failed" && result.reason === "invalid-input"
                  ? "Check your screen name, fort flag, and password. If using Fort Pass, reopen its saved setup in this tab."
                  : result.status === "failed" && result.reason === "socket-failed"
                    ? "Could not connect to build the fort. Check your internet connection and try again."
                    : result.status === "failed" && result.reason === "unavailable"
                      ? "The fort service is unavailable. Wait a moment and try again."
                      : result.status === "failed" && result.reason === "takeover-timeout"
                        ? "The other tab did not release this fort in time. Return to it or close it, then retry."
                        : result.status === "failed" && result.reason === "request-failed"
                          ? "Could not lock this fort to your tab. Close other fort tabs and try again."
                          : "The setup attempt was interrupted. Try again.");
      } else {
        setRecoveryRequired(false);
        setPassword(pw);
        if (activeFortPass) {
          clearFortPassClaimSecret(activeFortPass.sessionId);
          setPendingFortPass(null);
        }
      }
    } catch {
      if (attempt !== attemptRef.current || !mountedRef.current) return;
      setPassword(null);
      const mustRecover = recoveryRequired || getSecureRoomRecovery()?.mode === "setup";
      setRecoveryRequired(mustRecover);
      if (mustRecover) setRecoveryCredentialLocked(true);
      setConnectionError(mustRecover
        ? "This setup may already exist. Retry with this exact password to resolve it."
        : "Could not complete setup. Check your connection and try again.");
    } finally {
      if (attempt === attemptRef.current) {
        operationRef.current = null;
        if (mountedRef.current) {
          setCopying(false);
          setConnecting(false);
          setFortPassBusy(false);
        }
      }
    }
  };

  const handleCancel = async () => {
    if (operationRef.current === "cancel" || operationRef.current === "checkout") return;
    const attempt = ++attemptRef.current;
    copyControllerRef.current?.abort();
    operationRef.current = "cancel";
    setCancelling(true);
    setCopying(false);
    // Keep the original checkout recoverable in this tab. Its raw claim is
    // erased only after paid setup succeeds, not when this screen is canceled.
    const canLeave = await cancelSecureRoomConnection();
    if (!mountedRef.current || attempt !== attemptRef.current) return;
    setPassword(null);
    setConnecting(false);
    setFortPassBusy(false);
    operationRef.current = null;
    setCancelling(false);
    if (!canLeave) {
      setRecoveryRequired(true);
      setRecoveryCredentialLocked(true);
      setConnectionError("This setup may already exist. Retry with this same password to resolve it before leaving.");
      return;
    }
    setScreen("home");
  };

  const handleFortPassCheckout = async () => {
    if (operationRef.current || savedFortPass || recoveryRequired) return;
    if (activityMode) {
      setFortPassStatus("Fort Pass checkout is unavailable inside Discord Activities.");
      return;
    }
    if (!fortPassConfig?.checkoutConfigured) {
      setFortPassStatus("Fort Pass beta checkout is not open yet.");
      track("fort_pass_checkout_failed", { reason: "not_configured", source: "setup" });
      return;
    }

    const code = normalizeFortPassCode(fortPassCode);
    if (!code) {
      setFortPassCodeError("Use 4–10 letters, digits, or single inner hyphens. Start and end with a letter or digit; avoid reserved flags and the f- prefix.");
      fortPassCodeRef.current?.focus();
      track("fort_pass_code_checked", { reason: "invalid", source: "setup" });
      return;
    }
    setFortPassCodeError("");

    const attempt = ++attemptRef.current;
    operationRef.current = "checkout";
    setFortPassBusy(true);
    setFortPassStatus("Checking code...");
    try {
      const availability = await checkFortPassCode(code);
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      if (!availability.available) {
        setFortPassCodeError(availability.reason === "taken"
          ? "That flag is taken. Choose another."
          : "That flag is not allowed. Use 4–10 letters, digits, or single inner hyphens; avoid reserved flags and the f- prefix.");
        setFortPassStatus("");
        fortPassCodeRef.current?.focus();
        track("fort_pass_code_checked", { reason: availability.reason, source: "setup" });
        return;
      }

      track("fort_pass_code_checked", { reason: "available", source: "setup" });
      track("fort_pass_checkout_started", { source: "setup" });
      setFortPassStatus("Starting checkout...");
      const checkout = await startFortPassCheckout(code);
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      if (checkout.ok) {
        const purchase = getPendingFortPassRedemption();
        if (purchase) {
          setupRoomIdRef.current = null;
          setPendingFortPass(purchase);
        }
        location.assign(checkout.checkoutUrl);
        return;
      }

      const messages: Record<typeof checkout.error, string> = {
        invalid_custom_room_code: "That flag is not allowed. Choose another with 4–10 letters, digits, or single inner hyphens; avoid reserved flags and the f- prefix.",
        custom_room_code_taken: "That flag is taken. Choose another.",
        checkout_not_configured: "Fort Pass checkout is unavailable right now. You can still build a free fort.",
        checkout_provider_error: "Checkout could not be started. Try again later.",
        checkout_rate_limited: "Too many checkout attempts. Wait a minute before trying again.",
        checkout_source_unavailable: "Checkout is unavailable from this source. You can still build a free fort.",
        checkout_reservation_unavailable: "Checkout reservations are unavailable right now. Try again later.",
        unknown: "Checkout could not be started. Check your connection and try again.",
      };
      if (checkout.error === "invalid_custom_room_code" || checkout.error === "custom_room_code_taken") {
        setFortPassCodeError(messages[checkout.error]);
        setFortPassStatus("");
        fortPassCodeRef.current?.focus();
      } else {
        setFortPassStatus(messages[checkout.error]);
      }
      track("fort_pass_checkout_failed", { reason: checkout.error, source: "setup" });
    } catch {
      if (!mountedRef.current || attempt !== attemptRef.current) return;
      setFortPassStatus(getPendingFortPassRedemption()
        ? "Your checkout is saved, but could not be opened. Resume that same checkout or retry payment verification."
        : "Checkout could not be started. Check your connection and try again.");
      track("fort_pass_checkout_failed", { reason: "network", source: "setup" });
    } finally {
      if (attempt === attemptRef.current) {
        operationRef.current = null;
        if (mountedRef.current) setFortPassBusy(false);
      }
    }
  };

  return (
    <main className="screen entry-screen">
      <section className="entry-card entry-card-setup" aria-labelledby="setup-title">
        <header className="entry-brand"><LogoIcon size={40} /><span>pillowfort</span></header>
        <h1 id="setup-title" className="entry-title">{recoveryRequired ? "Finish opening your fort" : "Make room for your people"}</h1>
        <p className="entry-description">
          {recoveryRequired
            ? "Use the exact password from your earlier setup. Keep these details until your fort opens."
            : "We made a strong password for you. Copy it, open your fort, then invite your friends."}
        </p>
          {savedFortPass && !activityMode && (
            <div className="fort-pass-redeemed-panel">
              <div className="fort-pass-title">
                {useFreeFort ? "Saved checkout kept for later" : fortPassVerified ? "Fort Pass payment verified" : "Saved Fort Pass checkout"}
              </div>
              <div className="fort-pass-redeemed-code">flag: {savedFortPass.code}</div>
              <p className="auth-note">
                {useFreeFort
                  ? "This setup will create a free fort. Your original checkout stays saved in this tab."
                  : recoveryRequired
                  ? "This saved checkout is not proof of payment. Retry setup with the exact original password to recover your existing fort."
                  : fortPassVerified
                  ? "Your original purchase was verified. Opening the fort will check it again before setup."
                  : "Payment has not been verified. Retry verification or resume the same checkout; do not buy another pass. Your fort will not be created until verification succeeds."}
              </p>
              {activeFortPass && !recoveryRequired && (
                <div className="entry-actions">
                  <Button id="btn-verify-fort-pass" type="button" disabled={busy} onClick={() => void handleVerifyFortPass()}>
                    {fortPassBusy ? "Checking checkout…" : "Retry payment verification"}
                  </Button>
                  {!recoveryRequired && !fortPassVerified && (
                    <Button id="btn-resume-fort-pass" type="button" disabled={busy || !getPendingFortPassCheckoutUrl(activeFortPass.sessionId)} onClick={handleResumeCheckout}>
                      Resume saved checkout
                    </Button>
                  )}
                </div>
              )}
              {activeFortPass && !recoveryRequired && !fortPassVerified && !getPendingFortPassCheckoutUrl(activeFortPass.sessionId) && (
                <p className="auth-note">The original checkout link is unavailable. Keep this tab and retry verification of your original purchase.</p>
              )}
              {!recoveryRequired && (
                <Button id="btn-choose-free-fort" type="button" disabled={busy} onClick={handleFreeFortChoice}>
                  {useFreeFort ? "Return to saved checkout" : "Use a free fort instead"}
                </Button>
              )}
              {fortPassStatus && <div className="fort-pass-status" role="status">{fortPassStatus}</div>}
            </div>
          )}
          {activityMode && (
            <div className="activity-room-panel" role="status">
              <div className="activity-room-title">Discord Activity preview</div>
              <div className="activity-room-code">A fresh private fort will be generated. Shared launch linking is not enabled yet.</div>
            </div>
          )}
        <form className="entry-form" onSubmit={(event) => { event.preventDefault(); void handleCreate(); }}>
          <Input
            id="setup-password"
            label={recoveryRequired ? "Your original password" : customSecret ? "Your password" : "Your fort password"}
            type={showSecret ? "text" : "password"}
            value={secret}
            readOnly={!customSecret}
            aria-describedby={secretError ? "setup-secret-help setup-secret-error" : "setup-secret-help"}
            aria-invalid={!!secretError}
            maxLength={128}
            autoComplete={recoveryRequired ? "off" : "new-password"}
            autoCapitalize="none"
            autoCorrect="off"
            ref={passwordRef}
            disabled={busy || (recoveryRequired && recoveryCredentialLocked)}
            placeholder={recoveryRequired ? "Re-enter the exact prior password" : customSecret ? "6–64 characters" : undefined}
            onChange={(event) => {
              if (operationRef.current) return;
              copyControllerRef.current?.abort();
              setSecret(event.currentTarget.value);
              setGeneratedSecretSaved(false);
              if (secretError) setSecretError("");
            }}
            autoFocus
          />
          <div id="setup-secret-help" className={`secret-help${customSecret ? " secret-warning" : ""}`} aria-live="polite">
            {recoveryRequired
              ? "Recovery mode: re-enter the exact password you copied. Pillowfort stores only the non-secret room pointer."
              : customSecret
              ? "Short custom passwords are easier to guess offline. Never reuse an account password."
              : "Friends need this password and your approval to enter. Pillowfort cannot recover a lost password."}
          </div>
          <details
            id="password-options"
            className="entry-details"
            open={passwordOptionsOpen}
            onToggle={(event) => setPasswordOptionsOpen(event.currentTarget.open)}
          >
            <summary>Password options</summary>
            <div className="secret-controls" role="group" aria-label="Room password controls">
              <Button id="btn-copy-secret" type="button" onClick={() => void handleCopySecret()} disabled={busy}>
                Copy password
              </Button>
              <Button
                id="btn-toggle-setup-secret"
                type="button"
                onClick={() => {
                  if (!operationRef.current) setShowSecret((shown) => !shown);
                }}
                aria-controls="setup-password"
                aria-pressed={showSecret}
                disabled={busy}
              >
                {showSecret ? "Hide" : "Show"}
              </Button>
              <Button
                id="btn-custom-secret"
                type="button"
                onClick={() => {
                  if (operationRef.current || recoveryRequired) return;
                  copyControllerRef.current?.abort();
                  setCustomSecret(true);
                  setSecret("");
                  setGeneratedSecretSaved(false);
                  setManualSecretSave(false);
                  setSecretError("");
                  setShowSecret(false);
                  requestAnimationFrame(() => passwordRef.current?.focus());
                }}
                aria-pressed={customSecret}
                disabled={customSecret || busy || recoveryRequired}
              >
                Use my own password
              </Button>
              <Button
                id="btn-regenerate-secret"
                type="button"
                onClick={() => {
                  if (operationRef.current || recoveryRequired) return;
                  copyControllerRef.current?.abort();
                  setSecret(generateRoomSecret());
                  setCustomSecret(false);
                  setGeneratedSecretSaved(false);
                  setManualSecretSave(false);
                  setSecretError("");
                  setShowSecret(false);
                  passwordRef.current?.focus();
                }}
                aria-label={customSecret ? "Use generated password" : "Generate another password"}
                aria-pressed={!customSecret}
                disabled={busy || recoveryRequired}
              >
                {customSecret ? "Use generated password" : "Generate another"}
              </Button>
              {!customSecret && !recoveryRequired && (
                <Button
                  id="btn-manual-secret-save"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (operationRef.current) return;
                    setManualSecretSave(true);
                    setGeneratedSecretSaved(false);
                    setShowSecret(true);
                  }}
                >
                  I&apos;ll save it myself
                </Button>
              )}
            </div>
          </details>
          {!customSecret && !recoveryRequired && manualSecretSave && (
            <label className="secret-save-confirmation" htmlFor="setup-secret-saved">
              <input
                id="setup-secret-saved"
                type="checkbox"
                checked={generatedSecretSaved}
                disabled={busy}
                onChange={(event) => {
                  if (operationRef.current) return;
                  setGeneratedSecretSaved(event.currentTarget.checked);
                  if (event.currentTarget.checked && secretError) setSecretError("");
                }}
              />
              <span>I saved this password somewhere safe.</span>
            </label>
          )}
          {secretError && <div id="setup-secret-error" className="secret-error" role="alert">{secretError}</div>}
          {connectionError && <div className="secret-error" role="alert">{connectionError}</div>}
          <div className="entry-actions">
            <Button
              id="btn-create"
              type="submit"
              primary
              disabled={busy || (!customSecret && !recoveryRequired && manualSecretSave && !generatedSecretSaved)}
            >
              {copying ? "Copying password…" : connecting ? "Opening your fort…" : fortPassBusy ? "Verifying payment…" : recoveryRequired ? "Retry setup" : activeFortPass && !activityMode && !fortPassVerified ? "Verify payment & create fort" : customSecret || manualSecretSave ? "Create fort" : "Copy password & create fort"}
            </Button>
            <Button type="button" disabled={cancelling || operationRef.current === "checkout"} onClick={() => void handleCancel()}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
          </div>
        </form>
          {!recoveryRequired && !savedFortPass && !activityMode && (
            <details className="entry-details fort-pass-disclosure">
              <summary>Optional: Fort Pass</summary>
            <div className="fort-pass-panel">
              <div className="fort-pass-heading">
                <div>
                  <div className="fort-pass-title">Fort Pass</div>
                <div className="fort-pass-subtitle">quiet beta · custom flag · 6-hour idle · social skins</div>
              </div>
                <div className="fort-pass-price">{fortPassConfig?.checkoutConfigured ? fortPassConfig.priceLabel : fortPassConfig ? "Unavailable" : "Checking…"}</div>
              </div>
              <div className={`fort-pass-preview preview-${previewTheme}`} aria-hidden>
                <div className="fort-pass-preview-title">pillowfort — party-1</div>
                <div className="fort-pass-preview-body">
                  <div className="fort-pass-preview-lines">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="fort-pass-preview-buddies">
                    <span />
                    <span />
                  </div>
                </div>
              </div>
              <div className="fort-pass-theme-toggle" role="group" aria-label="Theme preview">
                <button
                  type="button"
                  className={previewTheme === "campus-blue" ? "active" : ""}
                  onClick={() => setPreviewTheme("campus-blue")}
                >
                  Campus Blue
                </button>
                <button
                  type="button"
                  className={previewTheme === "top-8" ? "active" : ""}
                  onClick={() => setPreviewTheme("top-8")}
                >
                  Top 8
                </button>
              </div>
              <div className="fort-pass-perk-row">
                <span>custom code</span>
                <span>6-hour idle</span>
                <span>skin pack</span>
              </div>
              <p className="auth-note">
                Optional upgrade for one temporary room, not permanent flag ownership. Guests stay free.
                Finish checkout and return in this same tab; purchase recovery depends on this tab.
              </p>
              <div className="fort-pass-controls">
                <Input
                  id="setup-fort-pass-code"
                  label="Custom Fort Code"
                  placeholder="party-1"
                  maxLength={10}
                  autoComplete="off"
                  autoCorrect="off"
                  value={fortPassCode}
                  disabled={busy || !fortPassConfig?.checkoutConfigured}
                  ref={fortPassCodeRef}
                  aria-invalid={!!fortPassCodeError}
                  aria-describedby={fortPassCodeError ? "setup-fort-pass-code-error" : undefined}
                  onChange={(e) => {
                    if (operationRef.current) return;
                    setFortPassCode(e.currentTarget.value);
                    if (fortPassStatus) setFortPassStatus("");
                    if (fortPassCodeError) setFortPassCodeError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleFortPassCheckout();
                  }}
                />
                <Button
                  id="btn-fort-pass-checkout"
                  onClick={() => void handleFortPassCheckout()}
                  disabled={busy || !fortPassConfig?.checkoutConfigured}
                >
                  {fortPassConfig?.checkoutConfigured && fortPassConfig.priceLabel ? `Upgrade ${fortPassConfig.priceLabel}` : "Upgrade unavailable"}
                </Button>
              </div>
              {fortPassCodeError && (
                <div id="setup-fort-pass-code-error" className="secret-error" role="alert">
                  {fortPassCodeError}
                </div>
              )}
              {fortPassConfig && !fortPassConfig.checkoutConfigured && (
                <div className="fort-pass-status fort-pass-status-muted" role="status">
                  Fort Pass checkout is unavailable right now. You can still build a free fort.
                </div>
              )}
              {fortPassStatus && (
                <div className="fort-pass-status" role="status">
                  {fortPassStatus}
                </div>
              )}
            </div>
            </details>
          )}

      </section>
    </main>
  );
}
