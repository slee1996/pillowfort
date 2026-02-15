import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";
import { LeaderboardsPanel } from "../games/LeaderboardsPanel";

type MobileSideTab = "buddies" | "leaderboard";

export function MobileBuddyOverlay() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<MobileSideTab>("buddies");

  useEffect(() => {
    const handler = () => {
      setTab("buddies");
      setOpen(true);
    };
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
          <span>People</span>
          <button
            className="mobile-buddy-close"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="member-panel-tabs mobile-buddy-tabs" role="tablist" aria-label="Mobile sidebar tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "buddies"}
            className={`member-panel-tab ${tab === "buddies" ? "active" : ""}`}
            onClick={() => setTab("buddies")}
          >
            Buddies ({members.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "leaderboard"}
            className={`member-panel-tab ${tab === "leaderboard" ? "active" : ""}`}
            onClick={() => setTab("leaderboard")}
          >
            Leaderboard
          </button>
        </div>
        <div className="mobile-buddy-content">
          {tab === "buddies" ? (
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
          ) : (
            <div className="mobile-buddy-leaderboards">
              <LeaderboardsPanel compact hideTitle />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
