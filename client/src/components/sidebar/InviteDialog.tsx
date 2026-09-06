import { useLayoutEffect, useRef, useState } from "react";
import { useGameStore } from "../../stores/gameStore";
import { copyTextWithFallback } from "../../services/clipboard";
import { track } from "../../services/analytics";
import { showToast } from "../xp/Toast";
import { PeriodIcon } from "../xp/PeriodIcon";

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
  const [showSecret, setShowSecret] = useState(false);
  const [copying, setCopying] = useState(false);
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
  }, [password]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    activeRef.current = true;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("#btn-close-invite")?.focus();
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

  const copyInvite = async () => {
    const state = useGameStore.getState();
    if (!activeRef.current || copyingRef.current || state.roomId !== roomId || !state.password) return;
    copyControllerRef.current?.abort();
    const controller = new AbortController();
    copyControllerRef.current = controller;
    copyingRef.current = true;
    setCopying(true);
    const secret = state.password;
    try {
      const copied = await copyTextWithFallback(`${link}\npassword: ${secret}`, controller.signal);
      const current = useGameStore.getState();
      if (!copied || controller.signal.aborted || !activeRef.current || current.roomId !== roomId || current.password !== secret) return;
      showToast("Invite copied!");
      track("invite_copied", {
        role: current.isHost ? "host" : "guest",
        source: "invite_dialog",
        memberCount: current.members.length,
      });
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
        <p id="invite-dialog-description">Send both to your friends. Keep this fort open to approve them.</p>
        <label htmlFor="invite-room-id">Fort code</label>
        <input id="invite-room-id" type="text" readOnly value={roomId} />
        <label htmlFor="invite-link">Invite link</label>
        <input id="invite-link" type="url" readOnly value={link} />
        <label htmlFor="invite-password">Password</label>
        <input
          id="invite-password"
          type={showSecret ? "text" : "password"}
          readOnly
          autoComplete="off"
          spellCheck={false}
          value={password || ""}
        />
        <button
          type="button"
          id="btn-toggle-invite-secret"
          aria-controls="invite-password"
          aria-pressed={showSecret}
          disabled={!password}
          onClick={() => setShowSecret((show) => !show)}
        >
          {showSecret ? "Hide password" : "Show password"}
        </button>
        {!password && <p role="status">Your password is unavailable. Rejoin this fort to restore your invitation.</p>}
      </div>
      <div className="product-dialog-actions">
        <button type="button" id="btn-copy-invite" disabled={!password || copying} onClick={() => void copyInvite()}>
          {copying ? "Copying…" : "Copy invite"}
        </button>
      </div>
    </dialog>
  );
}
