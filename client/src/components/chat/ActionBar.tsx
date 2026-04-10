import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { showToast } from "../xp/Toast";

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
      navigator.clipboard.writeText(text).then(() => showToast("Invite link copied!"));
    }
  };

  return (
    <div className="aim-action-bar">
      <button id="aim-btn-toss" className="aim-action-btn" onClick={handleToss} title="Toss Pillow">🛏 Toss</button>
      <button className="aim-action-btn" onClick={handleMute} title="Mute">🔇 Mute</button>
      <button className="aim-action-btn" onClick={handleInfo} title="Info">ℹ Info</button>
      <button className="aim-action-btn" onClick={handleInvite} title="Copy Invite">✉ Invite</button>
    </div>
  );
}
