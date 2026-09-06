import { useRef, useEffect, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { LogoIcon } from "../components/xp/Logo";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { cancelSecureRoomConnection, getSecureRoomRecovery, joinSecureRoom } from "../services/ws";
import { validateRoomSecret } from "../services/roomSecret";
import { isSecureDisplayNameV4 } from "../../../src/applicationEventsV4";
import { normalizeRoomId } from "../../../src/entitlements";

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
  const [nameError, setNameError] = useState("");
  const [roomError, setRoomError] = useState("");
  const [connectionError, setConnectionError] = useState("");
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
    const enteredName = (nameRef.current?.value ?? name).normalize("NFC").trim();
    const room = normalizeRoomId(roomRef.current?.value);
    const enteredSecret = passwordRef.current?.value || "";
    const invalidName = !isSecureDisplayNameV4(enteredName);
    setNameError(invalidName
      ? "Use 1–24 visible characters. Remove hidden/control characters and choose a non-reserved name (not constructor, prototype, or __proto__)."
      : "");
    setRoomError(!room
      ? "Copy the complete fort flag from your invite: f- followed by 10 letters (a–z) or digits (2–7), or a custom flag of 4–10 letters, digits, and single inner hyphens."
      : "");
    setConnectionError("");
    if (invalidName || !room) {
      if (invalidName) nameRef.current?.focus();
      else roomRef.current?.focus();
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
        const reportError = credentialMismatch ||
          (!mustRecover && result.status === "failed" && result.reason === "authentication-failed")
          ? setSecretError
          : setConnectionError;
        reportError(credentialMismatch
          ? "No saved join matched that password. Re-enter the exact password you copied."
          : mustRecover
          ? "This join may already be pending. Retry with these exact details to resolve it."
          : result.status === "busy"
          ? "This secure fort is already open in another tab."
          : result.status === "failed" && result.reason === "authentication-failed"
            ? "Could not join. Check the fort flag and password."
            : result.status === "failed" && result.reason === "rate-limited"
              ? "Too many attempts. Wait a minute, then try again."
              : result.status === "unsupported"
                ? result.reason === "takeover-channel-unavailable"
                  ? "This browser cannot move a fort between tabs. Return to the original tab."
                  : "This browser does not support the secure tab locking required to join. Use a supported browser."
                : result.status === "failed" && result.reason === "invalid-input"
                  ? "Check your screen name, fort flag, and password before trying again."
                  : result.status === "failed" && result.reason === "socket-failed"
                    ? "Could not connect to the fort. Check your internet connection and try again."
                    : result.status === "failed" && result.reason === "unavailable"
                      ? "The fort service is unavailable. Wait a moment and try again."
                      : result.status === "failed" && result.reason === "takeover-timeout"
                        ? "The other tab did not release this fort in time. Return to it or close it, then retry."
                        : result.status === "failed" && result.reason === "request-failed"
                          ? "Could not lock this fort to your tab. Close other fort tabs and try again."
                          : "The join attempt was interrupted. Try again.");
      } else {
        setRecoveryRequired(false);
        setPassword(pw);
      }
    } catch {
      setPassword(null);
      const mustRecover = recoveryRequired || getSecureRoomRecovery()?.mode === "join";
      setRecoveryRequired(mustRecover);
      if (mustRecover) setRecoveryCredentialLocked(true);
      setConnectionError(mustRecover
        ? "This join may already be pending. Retry with these exact details to resolve it."
        : "Could not complete the join. Check your connection and try again.");
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
      setConnectionError("This join may already be pending. Retry with the same password to resolve it before leaving.");
      return;
    }
    setScreen("home");
  };

  return (
    <main className="screen entry-screen">
      <section className="entry-card entry-card-join" aria-labelledby="join-title">
        <header className="entry-brand"><LogoIcon size={40} /><span>pillowfort</span></header>
        <h1 id="join-title" className="entry-title">{recoveryRequired ? "Return to your fort" : "Join your friends"}</h1>
        <p className="entry-description">
          Use the fort code and password they sent you. The host approves you before you enter.
        </p>
        <form className="entry-form" onSubmit={(event) => { event.preventDefault(); void handleJoin(); }}>
          {pendingJoinFingerprint && (
            <div className="auth-note" role="status" aria-live="polite">
              <strong>Waiting for the host to approve this device.</strong>
              <br />Confirm this fingerprint with them outside Pillowfort: <code>{pendingJoinFingerprint}</code>
            </div>
          )}
          <Input
            id="join-name"
            label="Your screen name"
            placeholder="Enter a screen name"
            maxLength={24}
            autoComplete="off"
            autoCapitalize="off"
            defaultValue={name}
            disabled={!!pendingJoinFingerprint || connecting || recoveryRequired}
            ref={nameRef}
            aria-invalid={!!nameError}
            aria-describedby={nameError ? "join-name-error" : undefined}
            onChange={() => setNameError("")}
          />
          {nameError && <div id="join-name-error" className="secret-error" role="alert">{nameError}</div>}
          <Input
            id="join-room"
            label="Fort code"
            placeholder="f-… or custom flag"
            maxLength={12}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            ref={roomRef}
            disabled={!!pendingJoinFingerprint || connecting || recoveryRequired}
            aria-invalid={!!roomError}
            aria-describedby={roomError ? "join-room-error" : undefined}
            onChange={() => setRoomError("")}
          />
          {roomError && <div id="join-room-error" className="secret-error" role="alert">{roomError}</div>}
          <Input
            id="join-password"
            label="Password"
            type={showSecret ? "text" : "password"}
            placeholder="The password your friend sent"
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
            aria-invalid={!!secretError}
          />
          <div className="secret-controls">
            <Button
              id="btn-toggle-join-secret"
              type="button"
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
              : "Passwords are case-sensitive. Enter yours exactly as shared."}
          </div>
          {secretError && <div id="join-secret-error" className="secret-error" role="alert">{secretError}</div>}
          {connectionError && <div className="secret-error" role="alert">{connectionError}</div>}
          <div className="entry-actions">
            <Button id="btn-enter" type="submit" primary disabled={!!pendingJoinFingerprint || connecting}>
              {pendingJoinFingerprint ? "Waiting for host…" : connecting ? "Joining…" : recoveryRequired ? "Retry join" : "Join fort"}
            </Button>
            <Button type="button" onClick={() => void handleCancel()}>Back</Button>
          </div>
        </form>
      </section>
    </main>
  );
}
