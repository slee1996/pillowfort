import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { cancelSecureRoomConnection, getSecureRoomRecovery, setupSecureRoom } from "../services/ws";
import { track } from "../services/analytics";
import { checkFortPassCode, clearFortPassClaimSecret, getFortPassStatus, getPendingFortPassRedemption, normalizeFortPassCode, startFortPassCheckout, type FortPassStatus } from "../services/fortPass";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";
import {
  generateRoomId,
  generateRoomSecret,
  validateCustomRoomSecret,
  validateRoomSecret,
} from "../services/roomSecret";
import { showToast } from "../components/xp/Toast";

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
  const setupDisplayName = setupRecovery?.displayName ?? name;
  const [recoveryFortPass] = useState(() => setupRecovery ? getPendingFortPassRedemption() : null);
  const activeFortPass = setupRecovery
    ? recoveryFortPass?.code === setupRecovery.roomId ? recoveryFortPass : null
    : pendingFortPass;
  const [fortPassCode, setFortPassCode] = useState("");
  const [fortPassStatus, setFortPassStatus] = useState("");
  const [fortPassConfig, setFortPassConfig] = useState<FortPassStatus | null>(null);
  const [fortPassBusy, setFortPassBusy] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<FortPassPreviewTheme>("campus-blue");
  const [secret, setSecret] = useState(() => setupRecovery ? "" : generateRoomSecret());
  const [customSecret, setCustomSecret] = useState(!!setupRecovery);
  const [generatedSecretSaved, setGeneratedSecretSaved] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [secretError, setSecretError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(!!setupRecovery);
  const [recoveryCredentialLocked, setRecoveryCredentialLocked] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const setupRoomIdRef = useRef<string | null>(setupRecovery?.roomId ?? null);

  useEffect(() => {
    let cancelled = false;
    if (activityMode) {
      setFortPassConfig({ beta: true, checkoutConfigured: false, priceLabel: "$5", perks: [] });
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
        setFortPassConfig({ beta: true, checkoutConfigured: false, priceLabel: "$5", perks: [] });
        track("fort_pass_status_checked", { reason: "failed", source: "setup" });
      });
    return () => {
      cancelled = true;
    };
  }, [activityMode]);

  const handleCreate = async () => {
    if (connecting) return;
    if (!recoveryRequired && !customSecret && !generatedSecretSaved) {
      setSecretError("Copy the generated secret or confirm that you saved it before building the fort.");
      return;
    }
    const roomId = setupRoomIdRef.current ??
      (activityMode ? generateRoomId() : activeFortPass?.code || generateRoomId());
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
    setConnecting(true);
    try {
      let result = await setupSecureRoom(options);
      if (result.status === "busy" && window.confirm("This secure fort is open in another tab. Move it here?")) {
        result = await setupSecureRoom({ ...options, lock: { takeover: true } });
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
        setSecretError(credentialMismatch
          ? "No saved setup matched that password. Re-enter the exact password you copied."
          : mustRecover
          ? "This setup may already exist. Retry Build with this exact password to resolve it."
          : result.status === "busy"
          ? "This secure fort is already open in another tab."
          : result.status === "failed" && result.reason === "rate-limited"
            ? "Too many attempts. Wait a minute, then try again."
            : result.status === "failed" && result.reason === "authentication-failed"
              ? "Could not create that fort. Check its flag and password."
              : "Secure browser cryptography, storage, and tab locking are required to create a fort.");
      } else {
        setRecoveryRequired(false);
        setPassword(pw);
        if (activeFortPass) {
          clearFortPassClaimSecret(activeFortPass.sessionId);
          setPendingFortPass(null);
        }
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleCancel = async () => {
    // Keep a successfully redeemed pass recoverable in this tab. The raw
    // claim secret remains session-scoped and is erased only after setup
    // succeeds; cancelling the screen must not strand a paid entitlement.
    const canLeave = await cancelSecureRoomConnection();
    setPassword(null);
    setConnecting(false);
    if (!canLeave) {
      setRecoveryRequired(true);
      setSecretError("This setup may already exist. Retry Build with this same password to resolve it before leaving.");
      return;
    }
    setScreen("home");
  };

  const handleFortPassCheckout = async () => {
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
      setFortPassStatus("Invalid code.");
      track("fort_pass_code_checked", { reason: "invalid", source: "setup" });
      return;
    }

    setFortPassBusy(true);
    setFortPassStatus("Checking code...");
    try {
      const availability = await checkFortPassCode(code);
      if (!availability.available) {
        setFortPassStatus(availability.reason === "taken" ? "That code is taken." : "Invalid code.");
        track("fort_pass_code_checked", { reason: availability.reason, source: "setup" });
        return;
      }

      track("fort_pass_code_checked", { reason: "available", source: "setup" });
      track("fort_pass_checkout_started", { source: "setup" });
      setFortPassStatus("Starting checkout...");
      const checkout = await startFortPassCheckout(code);
      if (checkout.ok) {
        location.assign(checkout.checkoutUrl);
        return;
      }

      const messages: Record<typeof checkout.error, string> = {
        invalid_custom_room_code: "Invalid code.",
        custom_room_code_taken: "That code is taken.",
        checkout_not_configured: "Checkout is not configured.",
        checkout_provider_error: "Checkout failed.",
        unknown: "Checkout failed.",
      };
      setFortPassStatus(messages[checkout.error]);
      track("fort_pass_checkout_failed", { reason: checkout.error, source: "setup" });
    } catch {
      setFortPassStatus("Checkout failed.");
      track("fort_pass_checkout_failed", { reason: "network", source: "setup" });
    } finally {
      setFortPassBusy(false);
    }
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Set Up a Fort"
        className="auth-window"
        buttons={[{ label: "✕", close: true, onClick: () => void handleCancel() }]}
      >
        <div className="xp-window-body">
          <p className="auth-note">
            Use the strong generated secret, or choose a shorter custom password. Pillowfort does not store either one.
          </p>
          {activeFortPass && !activityMode && (
            <div className="fort-pass-redeemed-panel" role="status">
              <div className="fort-pass-title">Fort Pass unlocked</div>
              <div className="fort-pass-redeemed-code">flag: {activeFortPass.code}</div>
              <div className="fort-pass-perk-row">
                <span>custom code</span>
                <span>6-hour idle</span>
                <span>social skins</span>
              </div>
            </div>
          )}
          {activityMode && (
            <div className="activity-room-panel" role="status">
              <div className="activity-room-title">Discord Activity preview</div>
              <div className="activity-room-code">A fresh private fort will be generated. Shared launch linking is not enabled yet.</div>
            </div>
          )}
          <Input
            id="setup-password"
            label="Secret Password"
            type={showSecret ? "text" : "password"}
            value={secret}
            readOnly={!customSecret}
            aria-describedby="setup-secret-help setup-secret-error"
            maxLength={128}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            ref={passwordRef}
            disabled={connecting || (recoveryRequired && recoveryCredentialLocked)}
            placeholder={recoveryRequired ? "Re-enter the exact prior password" : customSecret ? "15–64 characters" : undefined}
            onChange={(event) => {
              setSecret(event.currentTarget.value);
              if (secretError) setSecretError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
            }}
            autoFocus
          />
          <div
            className="secret-controls secret-controls-grid"
            role="group"
            aria-label="Room password controls"
          >
            <Button
              id="btn-toggle-setup-secret"
              onClick={() => setShowSecret((shown) => !shown)}
              aria-controls="setup-password"
              aria-pressed={showSecret}
              disabled={connecting}
            >
              {showSecret ? "Hide" : "Show"}
            </Button>
            <Button
              id="btn-custom-secret"
              onClick={() => {
                setCustomSecret(true);
                setSecret("");
                setGeneratedSecretSaved(false);
                setSecretError("");
                setShowSecret(false);
                requestAnimationFrame(() => passwordRef.current?.focus());
              }}
              aria-pressed={customSecret}
              disabled={customSecret || connecting || recoveryRequired}
            >
              Custom
            </Button>
            <Button
              id="btn-regenerate-secret"
              onClick={() => {
                setSecret(generateRoomSecret());
                setCustomSecret(false);
                setGeneratedSecretSaved(false);
                setSecretError("");
                passwordRef.current?.focus();
              }}
              aria-label={customSecret ? "Use generated password" : "Generated password selected; regenerate"}
              aria-pressed={!customSecret}
              disabled={connecting || recoveryRequired}
            >
              {customSecret ? "Generated" : "Regenerate"}
            </Button>
            <Button
              id="btn-copy-secret"
              onClick={() => {
                const validation = recoveryRequired
                  ? validateRoomSecret(secret)
                  : customSecret
                  ? validateCustomRoomSecret(secret, { context: [setupDisplayName, activeFortPass?.code || ""] })
                  : validateRoomSecret(secret);
                if (!validation.valid) {
                  setSecretError(validation.message);
                  passwordRef.current?.focus();
                  return;
                }
                setSecret(validation.secret);
                void navigator.clipboard.writeText(validation.secret).then(
                  () => {
                    if (!customSecret && !recoveryRequired) setGeneratedSecretSaved(true);
                    showToast("Room secret copied");
                  },
                  () => showToast("Could not copy room secret")
                );
              }}
              disabled={connecting}
            >
              Copy
            </Button>
          </div>
          {!customSecret && !recoveryRequired && (
            <label className="secret-save-confirmation" htmlFor="setup-secret-saved">
              <input
                id="setup-secret-saved"
                type="checkbox"
                checked={generatedSecretSaved}
                disabled={connecting}
                onChange={(event) => {
                  setGeneratedSecretSaved(event.currentTarget.checked);
                  if (event.currentTarget.checked && secretError) setSecretError("");
                }}
              />
              <span>I saved this generated secret somewhere safe.</span>
            </label>
          )}
          <div
            id="setup-secret-help"
            className={`secret-help${customSecret ? " secret-warning" : ""}`}
            aria-live="polite"
          >
            {recoveryRequired
              ? "Recovery mode: re-enter the exact password you copied. Pillowfort stores only the non-secret room pointer."
              : customSecret
              ? "Custom passwords can be guessed offline. Use 16+ characters or four unrelated words; never reuse an account password."
              : "Generated securely and locked. Copy it, then share it privately with your guests."}
          </div>
          {secretError && <div id="setup-secret-error" className="secret-error" role="alert">{secretError}</div>}

          {!recoveryRequired && !activeFortPass && !activityMode && (
            <div className="fort-pass-panel">
              <div className="fort-pass-heading">
                <div>
                  <div className="fort-pass-title">Fort Pass</div>
                <div className="fort-pass-subtitle">quiet beta · custom flag · 6-hour idle · social skins</div>
              </div>
                <div className="fort-pass-price">{fortPassConfig?.priceLabel || "$5"}</div>
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
              <div className="fort-pass-controls">
                <Input
                  id="setup-fort-pass-code"
                  label="Custom Fort Code"
                  placeholder="party-1"
                  maxLength={10}
                  autoComplete="off"
                  autoCorrect="off"
                  value={fortPassCode}
                  onChange={(e) => {
                    setFortPassCode(e.currentTarget.value);
                    if (fortPassStatus) setFortPassStatus("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleFortPassCheckout();
                  }}
                />
                <Button
                  id="btn-fort-pass-checkout"
                  onClick={() => void handleFortPassCheckout()}
                  disabled={fortPassBusy || !fortPassConfig?.checkoutConfigured}
                >
                  Upgrade {fortPassConfig?.priceLabel || "$5"}
                </Button>
              </div>
              {fortPassConfig && !fortPassConfig.checkoutConfigured && (
                <div className="fort-pass-status fort-pass-status-muted" role="status">
                  Fort Pass beta opens after the paid smoke test.
                </div>
              )}
              {fortPassStatus && (
                <div className="fort-pass-status" role="status">
                  {fortPassStatus}
                </div>
              )}
            </div>
          )}

          <div className="auth-actions">
            <Button
              id="btn-create"
              primary
              disabled={connecting || (!customSecret && !recoveryRequired && !generatedSecretSaved)}
              onClick={() => void handleCreate()}
            >
              {connecting ? "Building..." : "Build the Fort"}
            </Button>
            <Button onClick={() => void handleCancel()}>Cancel</Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
