import { useRef, useEffect, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { Window } from "../components/xp/Window";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { cancelSecureRoomConnection, getSecureRoomRecovery, joinSecureRoom } from "../services/ws";
import { BackgroundCanvas } from "../components/canvas/BackgroundCanvas";
import { validateRoomSecret } from "../services/roomSecret";

export function JoinScreen() {
  const name = useGameStore((s) => s.name);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingRoom = useGameStore((s) => s.pendingRoom);
  const pendingJoinFingerprint = useGameStore((s) => s.pendingJoinFingerprint);
  const recoveryHint = useRef(getSecureRoomRecovery()).current;
  const joinRecovery = recoveryHint?.mode === "join" ? recoveryHint : null;
  const nameRef = useRef<HTMLInputElement>(null);
  const roomRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [secretError, setSecretError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(!!joinRecovery);
  const [recoveryCredentialLocked, setRecoveryCredentialLocked] = useState(false);

  useEffect(() => {
    if (joinRecovery) {
      if (nameRef.current) nameRef.current.value = joinRecovery.displayName;
      if (roomRef.current) roomRef.current.value = joinRecovery.roomId;
      passwordRef.current?.focus();
      return;
    }
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
    if (connecting) return;
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
    const options = { roomId: room, roomSecret: pw, displayName: enteredName };
    if (recoveryRequired) setRecoveryCredentialLocked(true);
    setConnecting(true);
    try {
      let result = await joinSecureRoom(options);
      if (result.status === "busy" && window.confirm("This secure fort is open in another tab. Move it here?")) {
        result = await joinSecureRoom({ ...options, lock: { takeover: true } });
      }
      if (result.status !== "connected") {
        setPassword(null);
        const currentRecovery = getSecureRoomRecovery();
        const mustRecover = currentRecovery?.mode === "join" ||
          (result.status === "failed" &&
            (result.reason === "recovery-required" || result.reason === "recovery-credential-mismatch"));
        const credentialMismatch = result.status === "failed" &&
          result.reason === "recovery-credential-mismatch";
        setRecoveryRequired(mustRecover);
        if (credentialMismatch) setRecoveryCredentialLocked(false);
        else if (mustRecover) setRecoveryCredentialLocked(true);
        setSecretError(credentialMismatch
          ? "No saved join matched that password. Re-enter the exact password you copied."
          : mustRecover
          ? "This join may already be pending. Retry with these exact details to resolve it."
          : result.status === "busy"
          ? "This secure fort is already open in another tab."
          : result.status === "failed" && result.reason === "authentication-failed"
            ? "Could not join. Check the fort flag and password."
            : result.status === "failed" && result.reason === "rate-limited"
              ? "Too many attempts. Wait a minute, then try again."
              : "Secure browser cryptography, storage, and tab locking are required to join.");
      } else {
        setRecoveryRequired(false);
        setPassword(pw);
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleCancel = async () => {
    const canLeave = await cancelSecureRoomConnection();
    setPassword(null);
    setConnecting(false);
    if (!canLeave) {
      setRecoveryRequired(true);
      setSecretError("This join may already be pending. Retry with the same password to resolve it before leaving.");
      return;
    }
    setScreen("home");
  };

  return (
    <div className="screen">
      <BackgroundCanvas />
      <Window
        title="Join a Fort"
        className="auth-window"
        buttons={[{ label: "✕", close: true, onClick: () => void handleCancel() }]}
      >
        <div className="xp-window-body">
          <p className="auth-note">
            Enter the fort flag and exact generated secret or custom password from your invite.
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
            disabled={!!pendingJoinFingerprint || connecting || recoveryRequired}
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
            disabled={!!pendingJoinFingerprint || connecting || recoveryRequired}
          />
          <Input
            id="join-password"
            label="Secret Password"
            type={showSecret ? "text" : "password"}
            placeholder="The secret password"
            maxLength={128}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            ref={passwordRef}
            disabled={!!pendingJoinFingerprint || connecting || (recoveryRequired && recoveryCredentialLocked)}
            onChange={() => {
              if (secretError) setSecretError("");
            }}
            aria-describedby="join-secret-help join-secret-error"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleJoin();
            }}
          />
          <div className="secret-controls">
            <Button
              id="btn-toggle-join-secret"
              onClick={() => setShowSecret((shown) => !shown)}
              aria-controls="join-password"
              aria-pressed={showSecret}
              disabled={connecting}
            >
              {showSecret ? "Hide" : "Show"}
            </Button>
          </div>
          <div id="join-secret-help" className="secret-help">
            {recoveryRequired
              ? "Recovery mode: re-enter the exact copied password; the fort flag and name stay locked."
              : "Custom room passwords are 6–64 characters and are case-sensitive."}
          </div>
          {secretError && <div id="join-secret-error" className="secret-error" role="alert">{secretError}</div>}
          <div className="auth-actions">
            <Button id="btn-enter" primary disabled={!!pendingJoinFingerprint || connecting} onClick={() => void handleJoin()}>
              {pendingJoinFingerprint ? "Waiting for Host..." : connecting ? "Checking..." : "Join Fort"}
            </Button>
            <Button onClick={() => void handleCancel()}>Cancel</Button>
          </div>
        </div>
      </Window>
    </div>
  );
}
