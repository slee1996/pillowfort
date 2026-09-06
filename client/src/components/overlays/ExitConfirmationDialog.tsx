import { useLayoutEffect, useRef } from "react";
import { Button } from "../xp/Button";

interface ExitConfirmationDialogProps {
  isHost: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExitConfirmationDialog({ isHost, onConfirm, onCancel }: ExitConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("#btn-cancel-room-exit")!.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      id="room-exit-dialog"
      className="xp-window"
      aria-labelledby="room-exit-title"
      aria-describedby="room-exit-description"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="xp-title-bar">
        <div className="xp-title-text" id="room-exit-title">
          {isHost ? "Knock down this fort?" : "Leave this fort?"}
        </div>
      </div>
      <div className="xp-window-body">
        <p id="room-exit-description">
          {isHost
            ? "You're the host. Knocking down the fort ends the room for everyone. To keep it open, cancel and pass host to a buddy first."
            : "You'll leave this fort. Everyone else can keep chatting."}
        </p>
        <div className="room-exit-actions">
          <Button id="btn-cancel-room-exit" primary autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button id="btn-confirm-room-exit" onClick={onConfirm}>
            {isHost ? "Knock Down Fort" : "Leave Fort"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
