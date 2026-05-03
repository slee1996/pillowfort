import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { track } from "../../services/analytics";
import { showToast } from "../xp/Toast";

function ActionButton({
  id,
  icon,
  label,
  title,
  onClick,
}: {
  id?: string;
  icon: string;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button id={id} className="aim-action-btn" onClick={onClick} title={title}>
      <span className="aim-action-icon" aria-hidden>{icon}</span>
      <span className="aim-action-label">{label}</span>
    </button>
  );
}

export function ActionBar({ onPickerOpen }: { onPickerOpen: (type: string) => void }) {
  const isHost = useGameStore((s) => s.isHost);
  const roomId = useGameStore((s) => s.roomId);
  const password = useGameStore((s) => s.password);
  const members = useGameStore((s) => s.members);

  const handleToss = () => {
    if (!isHost) {
      showToast("Only the host can toss the pillow");
      return;
    }
    onPickerOpen("toss");
  };

  const handleMute = () => {
    onPickerOpen("mute");
  };

  const handleInfo = () => {
    if (roomId) showToast(`fort: ${roomId} · ${members.length} inside`);
  };

  const handleInvite = () => {
    if (roomId) {
      const link = `${location.origin}/${roomId}`;
      const text = password ? `${link}\npassword: ${password}` : link;
      navigator.clipboard.writeText(text).then(() => {
        showToast("Invite link copied!");
        track("invite_copied", {
          role: isHost ? "host" : "guest",
          source: "action_bar",
          memberCount: members.length,
        });
      });
    }
  };

  return (
    <div className="aim-action-bar">
      <ActionButton id="aim-btn-toss" icon="🛏" label="Toss" title="Toss Pillow" onClick={handleToss} />
      <ActionButton icon="🔇" label="Mute" title="Mute" onClick={handleMute} />
      <span className="aim-action-separator" aria-hidden />
      <ActionButton icon="ℹ" label="Info" title="Info" onClick={handleInfo} />
      <ActionButton icon="✉" label="Invite" title="Copy Invite" onClick={handleInvite} />
    </div>
  );
}
