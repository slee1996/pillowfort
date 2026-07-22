import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { setupSecureRoom } from "../services/ws";
import { track } from "../services/analytics";
import { checkFortPassCode, clearFortPassClaimSecret, getFortPassStatus, normalizeFortPassCode, startFortPassCheckout, type FortPassStatus } from "../services/fortPass";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";
import { generateRoomId, generateRoomSecret, validateRoomSecret } from "../services/roomSecret";
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
  const [fortPassCode, setFortPassCode] = useState("");
  const [fortPassStatus, setFortPassStatus] = useState("");
  const [fortPassConfig, setFortPassConfig] = useState<FortPassStatus | null>(null);
  const [fortPassBusy, setFortPassBusy] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<FortPassPreviewTheme>("campus-blue");
  const [secret, setSecret] = useState(generateRoomSecret);
  const [showSecret, setShowSecret] = useState(false);
  const [secretError, setSecretError] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

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
    const validation = validateRoomSecret(secret);
    if (!validation.valid) {
      setSecretError(validation.message);
      passwordRef.current?.focus();
      return;
    }
    const pw = validation.secret;
    setSecretError("");
    setPassword(pw);
    const roomId = activityMode ? generateRoomId() : pendingFortPass?.code || generateRoomId();
    const options = {
      roomId,
      roomSecret: pw,
      displayName: name,
      ...(!activityMode && pendingFortPass ? {
        fortPassSessionId: pendingFortPass.sessionId,
        fortPassClaimSecret: pendingFortPass.claimSecret,
      } : {}),
    };
    let result = await setupSecureRoom(options);
    if (result.status === "busy" && window.confirm("This secure fort is open in another tab. Move it here?")) {
      result = await setupSecureRoom({ ...options, lock: { takeover: true } });
    }
    if (result.status !== "connected") {
      setSecretError(result.status === "busy"
        ? "This secure fort is already open in another tab."
        : "Secure browser storage and tab locking are required to create a fort.");
    } else if (pendingFortPass) {
      clearFortPassClaimSecret(pendingFortPass.sessionId);
      setPendingFortPass(null);
    }
  };

  const handleCancel = () => {
    // Keep a successfully redeemed pass recoverable in this tab. The raw
    // claim secret remains session-scoped and is erased only after setup
    // succeeds; cancelling the screen must not strand a paid entitlement.
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
        buttons={[{ label: "✕", close: true, onClick: handleCancel }]}
      >
        <div className="xp-window-body">
          <p className="auth-note">
            Pillowfort generated a strong room secret. Copy it now; Pillowfort does not store it.
          </p>
          {pendingFortPass && !activityMode && (
            <div className="fort-pass-redeemed-panel" role="status">
              <div className="fort-pass-title">Fort Pass unlocked</div>
              <div className="fort-pass-redeemed-code">flag: {pendingFortPass.code}</div>
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
            readOnly
            aria-describedby="setup-secret-help setup-secret-error"
            maxLength={64}
            autoComplete="new-password"
            autoCorrect="off"
            ref={passwordRef}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />
          <div className="secret-controls">
            <Button
              id="btn-toggle-setup-secret"
              onClick={() => setShowSecret((shown) => !shown)}
              aria-controls="setup-password"
              aria-pressed={showSecret}
            >
              {showSecret ? "Hide" : "Show"}
            </Button>
            <Button
              id="btn-regenerate-secret"
              onClick={() => {
                setSecret(generateRoomSecret());
                setSecretError("");
                passwordRef.current?.focus();
              }}
            >
              Regenerate
            </Button>
            <Button
              id="btn-copy-secret"
              onClick={() => {
                void navigator.clipboard.writeText(secret).then(
                  () => showToast("Room secret copied"),
                  () => showToast("Could not copy room secret")
                );
              }}
            >
              Copy
            </Button>
          </div>
          <div id="setup-secret-help" className="secret-help">Generated securely and locked. Copy it, then share it privately with your guests.</div>
          {secretError && <div id="setup-secret-error" className="secret-error" role="alert">{secretError}</div>}

          {!pendingFortPass && !activityMode && (
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
            <Button id="btn-create" primary onClick={handleCreate}>
              Build the Fort
            </Button>
            <Button onClick={handleCancel}>Cancel</Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
