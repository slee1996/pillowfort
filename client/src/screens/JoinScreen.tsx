import { useRef, useEffect, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { disconnect, joinSecureRoom } from "../services/ws";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";
import { validateRoomSecret } from "../services/roomSecret";

export function JoinScreen() {
  const name = useGameStore((s) => s.name);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingRoom = useGameStore((s) => s.pendingRoom);
  const pendingJoinFingerprint = useGameStore((s) => s.pendingJoinFingerprint);
  const nameRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [secretError, setSecretError] = useState("");

  useEffect(() => {
    const room = pendingRoom;
    if (room && roomRef.current) {
      roomRef.current.value = room;
      useGameStore.getState().setPendingRoom(null);
      if (!name) nameRef.current?.focus();
      else passwordRef.current?.focus();
    } else {
      if (!name) nameRef.current?.focus();
      else roomRef.current?.focus();
    }
  }, []);

  const handleJoin = async () => {
    const enteredName = nameRef.current?.value.trim() || name.trim();
    const room = roomRef.current?.value.trim().toLowerCase();
    const enteredSecret = passwordRef.current?.value || "";
    if (!enteredName) {
      nameRef.current?.focus();
      return;
    }
    if (!room) {
      roomRef.current?.focus();
      return;
    }
    const validation = validateRoomSecret(enteredSecret);
    if (!validation.valid) {
      setSecretError(validation.message);
      passwordRef.current?.focus();
      return;
    }
    const pw = validation.secret;
    setSecretError("");
    setName(enteredName);
    setPassword(pw);
    const options = { roomId: room, roomSecret: pw, displayName: enteredName };
    let result = await joinSecureRoom(options);
    if (result.status === "busy" && window.confirm("This secure fort is open in another tab. Move it here?")) {
      result = await joinSecureRoom({ ...options, lock: { takeover: true } });
    }
    if (result.status !== "connected") {
      setSecretError(result.status === "busy"
        ? "This secure fort is already open in another tab."
        : "Secure browser storage and tab locking are required to join.");
    }
  };

  const handleCancel = () => {
    disconnect();
    setScreen("home");
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Join a Fort"
        className="auth-window"
        buttons={[{ label: "✕", close: true, onClick: handleCancel }]}
      >
        <div className="xp-window-body">
          <p className="auth-note">
            Enter the fort flag and secret password from your invite.
          </p>
          {pendingJoinFingerprint && (
            <div className="auth-note" role="status" aria-live="polite">
              <strong>Waiting for the host to approve this device.</strong>
              <br />Confirm this fingerprint with them outside Pillowfort: <code>{pendingJoinFingerprint}</code>
            </div>
          )}
          <Input
            id="join-name"
            label="Screen Name"
            placeholder="Enter a screen name"
            maxLength={24}
            autoComplete="off"
            autoCapitalize="off"
            defaultValue={name}
            disabled={!!pendingJoinFingerprint}
            ref={nameRef}
          />
          <Input
            id="join-room"
            label="Fort Flag"
            placeholder="f-… or custom flag"
            maxLength={12}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            ref={roomRef}
            disabled={!!pendingJoinFingerprint}
          />
          <Input
            id="join-password"
            label="Secret Password"
            type={showSecret ? "text" : "password"}
            placeholder="The secret password"
            maxLength={64}
            autoComplete="off"
            autoCorrect="off"
            ref={passwordRef}
            disabled={!!pendingJoinFingerprint}
            onChange={() => {
              if (secretError) setSecretError("");
            }}
            aria-describedby="join-secret-error"
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          />
          <div className="secret-controls">
            <Button
              id="btn-toggle-join-secret"
              onClick={() => setShowSecret((shown) => !shown)}
              aria-controls="join-password"
              aria-pressed={showSecret}
            >
              {showSecret ? "Hide" : "Show"}
            </Button>
          </div>
          {secretError && <div id="join-secret-error" className="secret-error" role="alert">{secretError}</div>}
          <div className="auth-actions">
            <Button id="btn-enter" primary disabled={!!pendingJoinFingerprint} onClick={handleJoin}>
              {pendingJoinFingerprint ? "Waiting for Host..." : "Join Fort"}
            </Button>
            <Button onClick={handleCancel}>Cancel</Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
