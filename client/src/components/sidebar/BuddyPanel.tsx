import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { MemberEntry } from "./MemberEntry";

export function BuddyPanel() {
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const mutedNames = useGameStore((s) => s.mutedNames);
  const [collapsed, setCollapsed] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const handler = () => setHidden((h) => !h);
    window.addEventListener("pf-toggle-buddy-panel", handler);
    return () => window.removeEventListener("pf-toggle-buddy-panel", handler);
  }, []);

  if (hidden) return null;

  return (
    <div className="member-panel">
      <div className="member-panel-header">Buddies</div>
      <div
        className={`buddy-group-header ${collapsed ? "collapsed" : ""}`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span
          className="text-[8px] inline-block transition-transform"
          style={{ transform: collapsed ? "rotate(-90deg)" : undefined }}
        >
          ▼
        </span>
        Inside ({members.length})
      </div>
      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
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
    </div>
  );
}
