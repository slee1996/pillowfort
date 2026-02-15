import { useEffect, useState } from "react";
import { useGameStore } from "../../stores/gameStore";
import type { GameQueueItem } from "../../services/protocol";

function describeQueueItem(item: GameQueueItem): string {
  switch (item.kind) {
    case "vote":
      return `Pillow Fight: ${item.by} vs ${item.target || "?"}`;
    case "rps":
      return `RPS: ${item.by} vs ${item.target || "?"}`;
    case "ttt":
      return `TTT: ${item.by} vs ${item.target || "?"}`;
    case "saboteur":
      return `Saboteur started by ${item.by}`;
    case "koth":
      return `KOTH challenge by ${item.by}`;
  }
}

export function MobileInviteSheet() {
  const gameQueue = useGameStore((s) => s.gameQueue);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("pf-show-mobile-invites", handler);
    return () => window.removeEventListener("pf-show-mobile-invites", handler);
  }, []);

  if (!open) return null;

  return (
    <div
      className="mobile-invite-overlay"
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="mobile-invite-card">
        <div className="mobile-invite-header">
          <span>Game Invites</span>
          <button
            className="mobile-invite-close"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="mobile-invite-body">
          <div className="mobile-invite-section">
            <div className="mobile-invite-title">Now Playing</div>
            <div className="mobile-invite-line">
              {gameQueue.current ? describeQueueItem(gameQueue.current) : "No active game."}
            </div>
          </div>
          <div className="mobile-invite-section">
            <div className="mobile-invite-title">Up Next</div>
            {gameQueue.queue.length > 0 ? (
              gameQueue.queue.slice(0, 4).map((q, idx) => (
                <div key={`${q.kind}-${q.by}-${q.target || ""}-${idx}`} className="mobile-invite-line">
                  {idx + 1}. {describeQueueItem(q)}
                </div>
              ))
            ) : (
              <div className="mobile-invite-line mobile-invite-empty">No queued games.</div>
            )}
          </div>
          <div className="mobile-invite-section">
            <div className="mobile-invite-title">Direct Invites</div>
            <div className="mobile-invite-line mobile-invite-empty">
              Invite inbox stub. Incoming challenge cards can land here next.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

