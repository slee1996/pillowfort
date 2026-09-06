import { useRef, useEffect, useState } from "react";
import { useGameStore } from "../stores/gameStore";
import { LogoIcon } from "../components/xp/Logo";
import { Button } from "../components/xp/Button";
import { Input } from "../components/xp/Input";
import { PeriodIcon } from "../components/xp/PeriodIcon";
import { cancelSecureRoomConnection, getSecureRoomRecovery, joinSecureRoom } from "../services/ws";
import { validateRoomSecret } from "../services/roomSecret";
import { isSecureDisplayNameV4 } from "../../../src/applicationEventsV4";
import { normalizeRoomId } from "../../../src/entitlements";
import { takeRoomInvitation } from "../services/roomInvitation";

export function JoinScreen() {
  const name = useGameStore((s) => s.name);
  const setName = useGameStore((s) => s.setName);
  const setScreen = useGameStore((s) => s.setScreen);
  const setPassword = useGameStore((s) => s.setPassword);
  const pendingRoom = useGameStore((s) => s.pendingRoom);
  const pendingJoinFingerprint = useGameStore((s) => s.pendingJoinFingerprint);
  const recoveryHint = useRef(getSecureRoomRecovery()).current;
  const joinRecovery = recoveryHint?.mode === "join" ? recoveryHint : null;
  const [invitation] = useState(() => {
    const incoming = takeRoomInvitation();
    if (!incoming) return null;
    const expectedRoom = joinRecovery?.roomId ?? pendingRoom;
    if (incoming.roomId !== expectedRoom || (recoveryHint && !joinRecovery)) {
      incoming.roomSecret = "";
      return null;
    }
    return incoming;
  });
  const [linkMode, setLinkMode] = useState(!!invitation);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeRef = useRef(true);
  const joiningRef = useRef(false);
  const cancellingRef = useRef(false);
  const attemptRef = useRef(0);
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
    activeRef.current = true;
    if (joinRecovery) {
      if (nameRef.current) nameRef.current.value = joinRecovery.displayName;
      if (roomRef.current) roomRef.current.value = joinRecovery.roomId;
    } else if (pendingRoom && roomRef.current) {
      roomRef.current.value = pendingRoom;
    }
    useGameStore.getState().setPendingRoom(null);
    if (invitation && passwordRef.current) {
      passwordRef.current.value = invitation.roomSecret;
      invitation.roomSecret = "";
      if (!joinRecovery && !name) nameRef.current?.focus();
      else document.getElementById("btn-enter")?.focus();
    } else if (joinRecovery) {
      passwordRef.current?.focus();
    } else if (!name) {
      nameRef.current?.focus();
    } else if (pendingRoom) {
      passwordRef.current?.focus();
    } else {
      roomRef.current?.focus();
    }
    const passwordInput = passwordRef.current;
    return () => {
      activeRef.current = false;
      attemptRef.current += 1;
      if (invitation) invitation.roomSecret = "";
      if (passwordInput) passwordInput.value = "";
    };
  }, []);

  useEffect(() => {
    if (secretError || roomError) {
      setDetailsOpen(true);
      setShowSecret(false);
    }
  }, [secretError, roomError]);

  useEffect(() => {
    if (secretError) passwordRef.current?.focus();
    else if (roomError) roomRef.current?.focus();
  }, [detailsOpen, secretError, roomError]);

  const handleJoin = async () => {
    if (joiningRef.current || cancellingRef.current || pendingJoinFingerprint) return;
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
    joiningRef.current = true;
    const attempt = ++attemptRef.current;
    const isCurrent = () => activeRef.current && attemptRef.current === attempt;
    try {
      let result = await joinSecureRoom(options);
      if (!isCurrent()) return;
      if (result.status === "busy" && window.confirm("This secure fort is open in another tab. Move it here?")) {
        result = await joinSecureRoom({ ...options, lock: { takeover: true } });
        if (!isCurrent()) return;
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
        if (credentialMismatch) setDetailsOpen(true);
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
        if (invitation) invitation.roomSecret = "";
        if (passwordRef.current) passwordRef.current.value = "";
        setShowSecret(false);
      }
    } catch {
      if (!isCurrent()) return;
      setPassword(null);
      const mustRecover = recoveryRequired || getSecureRoomRecovery()?.mode === "join";
      setRecoveryRequired(mustRecover);
      if (mustRecover) setRecoveryCredentialLocked(true);
      setConnectionError(mustRecover
        ? "This join may already be pending. Retry with these exact details to resolve it."
        : "Could not complete the join. Check your connection and try again.");
    } finally {
      options.roomSecret = "";
      if (isCurrent()) {
        joiningRef.current = false;
        setConnecting(false);
      }
    }
  };

  const handleCancel = async () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    attemptRef.current += 1;
    try {
      const canLeave = await cancelSecureRoomConnection();
      if (!activeRef.current) return;
      setPassword(null);
      joiningRef.current = false;
      setConnecting(false);
      if (!canLeave) {
        setRecoveryRequired(true);
        setRecoveryCredentialLocked(!!passwordRef.current?.value);
        setDetailsOpen(true);
        setShowSecret(false);
        setConnectionError("This join may already be pending. Retry with the same password to resolve it before leaving.");
        return;
      }
      if (invitation) invitation.roomSecret = "";
      if (passwordRef.current) passwordRef.current.value = "";
      takeRoomInvitation();
      setScreen("home");
    } finally {
      cancellingRef.current = false;
    }
  };

  return (
    <main className="screen entry-screen">
      <section className="entry-card entry-card-join" aria-labelledby="join-title">
        <header className="entry-brand"><LogoIcon size={40} /><span>pillowfort</span></header>
        <h1 id="join-title" className="entry-title">{recoveryRequired ? "Return to your fort" : linkMode ? "You’re invited." : "Join your friends"}</h1>
        <p className="entry-description">
          {linkMode
            ? "Your link has everything you need. Choose a name, then join—no password to type."
            : "Use the fort code and password they sent you. The host approves you before you enter."}
        </p>
        {linkMode && !pendingJoinFingerprint && <p className="join-link-ready"><PeriodIcon kind="check" size={18} /> Password included. Host approval comes next.</p>}
        <form className="entry-form" onSubmit={(event) => { event.preventDefault(); void handleJoin(); }}>
          {pendingJoinFingerprint && (
            <div className="auth-note" role="status" aria-live="polite">
              <strong>Waiting for the host to approve this device.</strong>
              <br />Compare this device fingerprint with your host in your other chat or over a call: <code>{pendingJoinFingerprint}</code>
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
          <details
            className={linkMode ? "entry-details" : undefined}
            open={!linkMode || detailsOpen}
            onToggle={(event) => {
              if (linkMode) setDetailsOpen(event.currentTarget.open);
            }}
          >
            <summary hidden={!linkMode}>Use a different code or password</summary>
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
            onChange={() => {
              setRoomError("");
              if (linkMode && normalizeRoomId(roomRef.current?.value) !== invitation?.roomId) {
                setLinkMode(false);
                setShowSecret(false);
                if (invitation) invitation.roomSecret = "";
                if (passwordRef.current) passwordRef.current.value = "";
              }
            }}
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
          </details>
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
