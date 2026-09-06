import { useLayoutEffect, useRef } from "react";
import { buddyIconColor } from "../../utils/nameColor";

interface MemberPickerProps {
  title: string;
  members: string[];
  onPick: (name: string) => void;
  onClose: () => void;
}

export function MemberPicker({ title, members, onPick, onClose }: MemberPickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    const firstMember = dialog.querySelector<HTMLButtonElement>(".member-picker-item");
    const closeButton = dialog.querySelector<HTMLButtonElement>(".xp-title-btn-close");
    (firstMember ?? closeButton)?.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  const handleClose = () => {
    dialogRef.current?.close();
    onClose();
  };

  const handlePick = (name: string) => {
    dialogRef.current?.close();
    onPick(name);
  };

  return (
    <dialog
      ref={dialogRef}
      id="member-picker-overlay"
      className="member-picker-overlay open"
      aria-labelledby="member-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        handleClose();
      }}
      onClick={(event) => event.target === event.currentTarget && handleClose()}
    >
      <div className="member-picker">
        <div className="xp-title-bar" style={{ cursor: "default" }}>
          <div id="member-picker-title" className="xp-title-text">{title}</div>
          <div className="xp-title-buttons">
            <button
              type="button"
              className="xp-title-btn xp-title-btn-close"
              aria-label="Cancel member selection"
              onClick={handleClose}
            >
              ✕
            </button>
          </div>
        </div>
        <div id="member-picker-body" className="member-picker-body">
          {members.length === 0 ? (
            <div className="member-picker-empty">No one to pick.</div>
          ) : (
            members.map((name) => (
              <button
                type="button"
                key={name}
                className="member-picker-item"
                onClick={() => handlePick(name)}
              >
                <span className="buddy-icon" style={{ background: buddyIconColor(name) }} />
                <span>{name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </dialog>
  );
}
