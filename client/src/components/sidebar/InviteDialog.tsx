import { useLayoutEffect, useRef, useState } from "react";
import { useGameStore } from "../../stores/gameStore";
import { copyTextWithFallback } from "../../services/clipboard";
import { track } from "../../services/analytics";
import { showToast } from "../xp/Toast";
import { PeriodIcon } from "../xp/PeriodIcon";
import { createRoomInvitationUrl } from "../../services/roomInvitation";
import { Input } from "../xp/Input";
import { Button } from "../xp/Button";

interface InviteDialogProps {
  open: boolean;
  onClose: () => void;
}

export function InviteDialog({ open, onClose }: InviteDialogProps) {
  const roomId = useGameStore((s) => s.roomId);
  return open && roomId ? <InviteDialogContent key={roomId} roomId={roomId} onClose={onClose} /> : null;
}

function InviteDialogContent({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const password = useGameStore((s) => s.password);
  const isHost = useGameStore((s) => s.isHost);
  const [showSecret, setShowSecret] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<"idle" | "link" | "manual" | "fallback" | "error">("idle");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const copyingRef = useRef(false);
  const activeRef = useRef(false);
  const copyControllerRef = useRef<AbortController | null>(null);
  const link = `${window.location.origin}/${roomId}`;

  useLayoutEffect(() => {
    setShowSecret(false);
    copyControllerRef.current?.abort();
    copyControllerRef.current = null;
    copyingRef.current = false;
    setCopying(false);
    setCopyResult("idle");
  }, [password]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    activeRef.current = true;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("#btn-copy-invite")?.focus();
    return () => {
      activeRef.current = false;
      copyControllerRef.current?.abort();
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const close = () => {
    activeRef.current = false;
    copyControllerRef.current?.abort();
    setShowSecret(false);
    dialogRef.current?.close();
    onClose();
  };

  const copyInvite = async (format: "link" | "manual" = "link") => {
    const state = useGameStore.getState();
    if (!activeRef.current || copyingRef.current || state.roomId !== roomId || !state.password) return;
    copyControllerRef.current?.abort();
    const controller = new AbortController();
    copyControllerRef.current = controller;
    copyingRef.current = true;
    setCopying(true);
    setCopyResult("idle");
    const secret = state.password;
    try {
      const text = format === "link"
        ? createRoomInvitationUrl(window.location.origin, roomId, secret)
        : `${link}\npassword: ${secret}`;
      const copied = await copyTextWithFallback(text, controller.signal);
      const current = useGameStore.getState();
      if (controller.signal.aborted || !activeRef.current || current.roomId !== roomId || current.password !== secret) return;
      if (!copied) {
        setCopyResult("fallback");
        return;
      }
      setCopyResult(format);
      showToast(format === "link" ? "Invite link copied!" : "Invite details copied!");
      track("invite_copied", {
        role: current.isHost ? "host" : "guest",
        source: "invite_dialog",
        memberCount: current.members.length,
      });
    } catch {
      if (!controller.signal.aborted && activeRef.current && useGameStore.getState().roomId === roomId) {
        setCopyResult("error");
      }
    } finally {
      if (copyControllerRef.current === controller) {
        copyingRef.current = false;
        if (activeRef.current) setCopying(false);
      }
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="product-dialog invite-dialog"
      aria-labelledby="invite-dialog-title"
      aria-describedby="invite-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <div className="product-dialog-header">
        <h2 id="invite-dialog-title"><PeriodIcon kind="invite" size={22} />Invite your friends</h2>
        <button type="button" id="btn-close-invite" onClick={close}>Close</button>
      </div>
      <div className="product-dialog-body">
        <div className="invite-intro">
          <span className="invite-intro-icon" aria-hidden="true"><PeriodIcon kind="invite" size={38} /></span>
          <div>
            <h3>One link. That’s it.</h3>
            <p id="invite-dialog-description">Your friend won’t need to type a password.</p>
          </div>
        </div>
        <ol className="invite-steps" aria-label="How to invite">
          <li><span aria-hidden="true">1</span><div><strong>Copy the invite link</strong><p>Everything they need is included.</p></div></li>
          <li><span aria-hidden="true">2</span><div><strong>Paste it in your chat</strong><p>Send it privately to your friend.</p></div></li>
          <li><span aria-hidden="true">3</span><div><strong>{isHost ? "Let your friend in" : "The host lets them in"}</strong><p>{isHost ? "Keep this fort open. Check their fingerprint when they join." : "Ask the host to stay here and approve their device."}</p></div></li>
        </ol>
        <p className="invite-privacy"><PeriodIcon kind="lock" size={18} /><span>Anyone with this link can ask to join. The host still decides who gets in.</span></p>
        <details className="entry-details invite-manual" onToggle={(event) => { if (!event.currentTarget.open) setShowSecret(false); }}>
          <summary>Use a code and password instead</summary>
          <p>Only needed for manual joining. The one-link invite includes these details automatically.</p>
          <Input id="invite-link" label="Room address only — needs the password below" type="url" readOnly value={link} />
          <Input id="invite-room-id" label="Fort code" type="text" readOnly value={roomId} />
          <Input
            id="invite-password"
            label="Password"
            type={showSecret ? "text" : "password"}
            readOnly
            autoComplete="off"
            spellCheck={false}
            value={password || ""}
          />
          <Button
            type="button"
            id="btn-toggle-invite-secret"
            aria-controls="invite-password"
            aria-pressed={showSecret}
            disabled={!password}
            onClick={() => setShowSecret((show) => !show)}
          >
            {showSecret ? "Hide password" : "Show password"}
          </Button>
          <Button type="button" id="btn-copy-manual-invite" disabled={!password || copying} onClick={() => void copyInvite("manual")}>
            Copy room address and password
          </Button>
        </details>
        {!password && <p role="status">Your password is unavailable. Rejoin this fort to restore your invitation.</p>}
      </div>
      <div className="product-dialog-actions invite-actions">
        <Button id="btn-copy-invite" type="button" primary disabled={!password || copying} aria-describedby="invite-copy-status" onClick={() => void copyInvite()}>
          <PeriodIcon kind={copyResult === "link" ? "check" : "invite"} size={22} />
          {copying ? "Copying…" : copyResult === "link" ? "Copy link again" : "Copy invite link"}
        </Button>
        <p id="invite-copy-status" className={`invite-copy-status${copyResult === "link" || copyResult === "manual" ? " is-success" : ""}`} role="status" aria-live="polite">
          {!password ? "Rejoin this fort to restore a shareable invite."
            : copyResult === "link" ? "Link copied. Paste it in a message to your friend."
            : copyResult === "manual" ? "Room address and password copied. Send both for manual joining."
            : copyResult === "fallback" ? "Copy the full selected link or details from the manual-copy dialog, then paste them in your chat."
            : copyResult === "error" ? "Couldn’t prepare the invite. Close this window and try again."
            : "Password included. Nothing else to send."}
        </p>
      </div>
    </dialog>
  );
}
