import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";

export function MobileBuddyOverlay() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("pf-show-mobile-buddies", handler);
    return () => window.removeEventListener("pf-show-mobile-buddies", handler);
  }, []);

  if (!open) return null;

  return (
    <div
      className="mobile-buddy-overlay"
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="mobile-buddy-card">
        <div className="mobile-buddy-header">
          <span>Buddies ({members.length})</span>
          <button
            className="mobile-buddy-close"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="mobile-buddy-list">
          {members.map((name, i) => (
            <MemberEntry
              key={name}
              name={name}
              isHost={i === 0}
              isMuted={mutedNames.has(name)}
              status={memberPresence[name]?.status}
              awayText={memberPresence[name]?.awayText}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
