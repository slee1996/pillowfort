import { useLayoutEffect, useRef } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { Button } from "../xp/Button";
import { LogoIcon } from "../xp/Logo";
import { PeriodIcon } from "../xp/PeriodIcon";

export function AdmissionApprovalDialog() {
  const admissions = useGameStore((state) => state.pendingAdmissions);
  const pending = admissions[0];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const explanationRef = useRef<HTMLDivElement>(null);
  const admissionId = pending?.admissionId;

  useLayoutEffect(() => {
    if (!admissionId) return;
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    // The native modal makes the rest of the document inert, including
    // pointer interaction and programmatic attempts to move focus behind it.
    explanationRef.current!.setAttribute("autofocus", "");
    dialog.showModal();
    explanationRef.current!.focus();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [admissionId]);

  useLayoutEffect(() => {
    if (pending?.status === "approving") explanationRef.current?.focus();
  }, [pending?.status]);

  if (!pending) return null;

  const approving = pending.status === "approving";
  return (
    <dialog
      ref={dialogRef}
      className="dialog-overlay"
      id="admission-approval-overlay"
      aria-modal="true"
      aria-labelledby="admission-approval-title"
      aria-describedby="admission-approval-description"
      style={{ margin: 0, border: 0, padding: 0, width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", color: "inherit" }}
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.findIndex((button) => button === document.activeElement);
        if (buttons.length === 0) {
          event.preventDefault();
          explanationRef.current?.focus();
        } else if (event.shiftKey && index <= 0) {
          event.preventDefault();
          buttons[buttons.length - 1].focus();
        } else if (!event.shiftKey && (index === -1 || index === buttons.length - 1)) {
          event.preventDefault();
          buttons[0].focus();
        }
      }}
    >
      <div className="xp-window dialog-window admission-approval-window">
        <div className="xp-title-bar">
          <div className="xp-title-text" id="admission-approval-title">
            <div className="xp-title-icon"><LogoIcon /></div>
            approve a device
          </div>
        </div>
        <div className="xp-window-body">
          <div className="notice-row">
            <div className="host-offer-icon-wrap" aria-hidden><PeriodIcon kind="lock" size={36} /></div>
            <div className="notice-text" id="admission-approval-description" ref={explanationRef} tabIndex={-1}>
              <strong>A device with this fort&apos;s invitation wants to join.</strong>
              <p className="notice-subtext">
                Before approving, compare this device fingerprint with your friend over a call or another trusted channel outside this fort.
                Approve only if it matches and you expect them now.
              </p>
              <p className="notice-subtext">
                Device fingerprint: {pending.deviceFingerprint}
              </p>
              <p className="notice-subtext">
                This request expires shortly. If it disappears before you can compare, ask your friend to join again.
              </p>
              {admissions.length > 1 && (
                <p className="notice-subtext">{admissions.length - 1} more request(s) waiting.</p>
              )}
            </div>
          </div>
          <div className="auth-actions">
            <Button
              id="btn-approve-admission"
              primary
              disabled={approving}
              onClick={() => send("admission-approve", { admissionId: pending.admissionId })}
            >
              {approving ? "Approving..." : "Approve"}
            </Button>
            <Button
              id="btn-reject-admission"
              disabled={approving}
              onClick={() => send("admission-reject", { admissionId: pending.admissionId })}
            >
              Reject
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
