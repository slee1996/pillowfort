import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";
import { LeaderboardsPanel } from "../games/LeaderboardsPanel";

type SideTab = "buddies" | "leaderboard";

export function BuddyPanel() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<SideTab>("buddies");

  useEffect(() => {
    const handler = () => setHidden((h) => !h);
    window.addEventListener("pf-toggle-buddy-panel", handler);
    return () => window.removeEventListener("pf-toggle-buddy-panel", handler);
  }, []);

  if (hidden) return null;

  return (
    <div className="member-panel">
      <div className="member-panel-tabs" role="tablist" aria-label="Sidebar tabs">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "buddies"}
          className={`member-panel-tab ${tab === "buddies" ? "active" : ""}`}
          onClick={() => setTab("buddies")}
        >
          Buddies
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

      {tab === "buddies" ? (
        <>
          <div
            className={`buddy-group-header ${collapsed ? "collapsed" : ""}`}
            onClick={() => setCollapsed(!collapsed)}
          >
            <span
              className="buddy-group-caret"
              style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
            >
              ▼
            </span>
            Inside ({members.length})
          </div>
          {!collapsed && (
            <div className="buddy-list">
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
          )}
        </>
      ) : (
        <div className="member-panel-leaderboards">
          <LeaderboardsPanel compact hideTitle />
        </div>
      )}
    </div>
  );
}
