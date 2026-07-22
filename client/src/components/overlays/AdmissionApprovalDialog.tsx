import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { Button } from "../xp/Button";
import { LogoIcon } from "../xp/Logo";

export function AdmissionApprovalDialog() {
  const admissions = useGameStore((state) => state.pendingAdmissions);
  const pending = admissions[0];
  if (!pending) return null;

  const approving = pending.status === "approving";
  return (
    <div className="dialog-overlay" id="admission-approval-overlay" role="dialog" aria-modal="true">
      <div className="xp-window dialog-window admission-approval-window">
        <div className="xp-title-bar">
          <div className="xp-title-text">
            <div className="xp-title-icon"><LogoIcon /></div>
            approve a device
          </div>
        </div>
        <div className="xp-window-body">
          <div className="notice-row">
            <div className="host-offer-icon-wrap" aria-hidden>🔐</div>
            <div className="notice-text">
              <strong>A device with this fort&apos;s invitation wants to join.</strong>
              <p className="notice-subtext">
                Approve only if you expect someone now. Device fingerprint: {pending.deviceFingerprint}
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
    </div>
  );
}
