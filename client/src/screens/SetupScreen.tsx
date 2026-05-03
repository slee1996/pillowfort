import { useRef, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { connect, send } from "../services/ws";
import { track } from "../services/analytics";
import { createRoomAuthPayload } from "../services/chatCrypto";
import { checkFortPassCode, normalizeFortPassCode, startFortPassCheckout } from "../services/fortPass";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";

type FortPassPreviewTheme = "retro-green" | "midnight";

function generateRoomId(): string {
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const c = "bcdfghjklmnprstvwz0123456789";
  const v = "o0ua";
  const all = "abcdefghijklmnopqrstuvwxyz0123456789";
  const soft = "rln";
  const hard = "xksz";
  const [a, b] = Math.random() < 0.5 ? [soft, hard] : [hard, soft];
  return pick(c) + pick(v) + pick(a) + pick(c) + pick(v) + pick(b) + pick(all) + pick(all);
}

export function SetupScreen() {
  const name = useGameStore((s) => s.name);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingFortPass = useGameStore((s) => s.pendingFortPass);
  const setPendingFortPass = useGameStore((s) => s.setPendingFortPass);
  const [fortPassCode, setFortPassCode] = useState("");
  const [fortPassStatus, setFortPassStatus] = useState("");
  const [fortPassBusy, setFortPassBusy] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<FortPassPreviewTheme>("retro-green");
  const passwordRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    const pw = passwordRef.current?.value.trim();
    if (!pw) {
      passwordRef.current?.focus();
      return;
    }
    setPassword(pw);
    const roomId = pendingFortPass?.code || generateRoomId();
    const auth = await createRoomAuthPayload(roomId, pw);
    connect(roomId, () => send("set-up", {
      name,
      auth,
      ...(pendingFortPass ? { fortPassSessionId: pendingFortPass.sessionId } : {}),
    }));
  };

  const handleCancel = () => {
    setPendingFortPass(null);
    setScreen("home");
  };

  const handleFortPassCheckout = async () => {
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
            Pick a secret password. Share it with people you want to let inside.
          </p>
          {pendingFortPass && (
            <div className="fort-pass-redeemed-panel" role="status">
              <div className="fort-pass-title">Fort Pass unlocked</div>
              <div className="fort-pass-redeemed-code">flag: {pendingFortPass.code}</div>
              <div className="fort-pass-perk-row">
                <span>custom code</span>
                <span>6-hour idle</span>
                <span>retro themes</span>
              </div>
            </div>
          )}
          <Input
            id="setup-password"
            label="Secret Password"
            placeholder="Something only your friends know"
            maxLength={64}
            autoComplete="off"
            autoCorrect="off"
            ref={passwordRef}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            autoFocus
          />

          {!pendingFortPass && (
            <div className="fort-pass-panel">
              <div className="fort-pass-heading">
                <div>
                  <div className="fort-pass-title">Fort Pass</div>
                  <div className="fort-pass-subtitle">custom flag · 6-hour idle · retro themes</div>
                </div>
                <div className="fort-pass-price">$5</div>
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
                  className={previewTheme === "retro-green" ? "active" : ""}
                  onClick={() => setPreviewTheme("retro-green")}
                >
                  Retro Green
                </button>
                <button
                  type="button"
                  className={previewTheme === "midnight" ? "active" : ""}
                  onClick={() => setPreviewTheme("midnight")}
                >
                  Midnight
                </button>
              </div>
              <div className="fort-pass-perk-row">
                <span>custom code</span>
                <span>6-hour idle</span>
                <span>theme pack</span>
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
                  disabled={fortPassBusy}
                >
                  Upgrade $5
                </Button>
              </div>
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
