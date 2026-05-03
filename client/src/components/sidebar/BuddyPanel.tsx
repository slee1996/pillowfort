import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { buddyIconColor } from "../../utils/nameColor";
import { showToast } from "../xp/Toast";
import { MemberEntry } from "./MemberEntry";
import { LeaderboardsPanel } from "../games/LeaderboardsPanel";

type SideTab = "buddies" | "leaderboard";
type BuddyGroup = "inside" | "away";

export function BuddyPanel() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const name = useGameStore((s) => s.name);
  const roomId = useGameStore((s) => s.roomId);
  const isHost = useGameStore((s) => s.isHost);
  const [collapsed, setCollapsed] = useState<Record<BuddyGroup, boolean>>({
    inside: false,
    away: false,
  });
  const [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<SideTab>("buddies");

  useEffect(() => {
    const handler = () => setHidden((h) => !h);
    window.addEventListener("pf-toggle-buddy-panel", handler);
    return () => window.removeEventListener("pf-toggle-buddy-panel", handler);
  }, []);

  if (hidden) return null;

  const availableMembers = members.filter((member) => memberPresence[member]?.status !== "away");
  const awayMembers = members.filter((member) => memberPresence[member]?.status === "away");
  const myPresence = memberPresence[name];
  const myStatus = myPresence?.status === "away" ? "Away" : "Available";
  const myStatusText = myPresence?.status === "away" && myPresence.awayText
    ? myPresence.awayText
    : myStatus;

  const copyRoomFlag = () => {
    if (!roomId) return;
    navigator.clipboard.writeText(roomId).then(() => showToast("Fort flag copied!"));
  };

  const toggleGroup = (group: BuddyGroup) => {
    setCollapsed((current) => ({ ...current, [group]: !current[group] }));
  };

  const renderGroup = (group: BuddyGroup, label: string, list: string[]) => (
    <>
      <div
        className={`buddy-group-header ${collapsed[group] ? "collapsed" : ""}`}
        onClick={() => toggleGroup(group)}
      >
        <span
          className="buddy-group-caret"
          style={{ transform: collapsed[group] ? "rotate(-90deg)" : undefined }}
        >
          ▼
        </span>
        {label} ({list.length})
      </div>
      {!collapsed[group] && (
        <div className="buddy-list">
          {list.map((member) => (
            <MemberEntry
              key={member}
              name={member}
              isHost={members.indexOf(member) === 0}
              isMuted={mutedNames.has(member)}
              status={memberPresence[member]?.status}
              awayText={memberPresence[member]?.awayText}
            />
          ))}
        </div>
      )}
    </>
  );

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
          <div className="buddy-profile-card">
            <div className="buddy-profile-row">
              <span className="buddy-profile-icon" style={{ background: buddyIconColor(name) }} />
              <div className="buddy-profile-copy">
                <div className="buddy-profile-name">{name || "guest"}</div>
                <div className="buddy-profile-status">{isHost ? "Host" : "Guest"} · {myStatusText}</div>
              </div>
            </div>
            <button type="button" className="buddy-profile-flag" onClick={copyRoomFlag}>
              flag: {roomId || "..."}
            </button>
          </div>
          {renderGroup("inside", "Inside", availableMembers)}
          {awayMembers.length > 0 && renderGroup("away", "Away", awayMembers)}
        </>
      ) : (
        <div className="member-panel-leaderboards">
          <LeaderboardsPanel compact hideTitle />
        </div>
      )}
    </div>
  );
}
