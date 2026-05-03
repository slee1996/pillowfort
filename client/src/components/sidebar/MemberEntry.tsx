import { buddyIconColor } from "../../utils/nameColor";

interface MemberEntryProps {
  name: string;
  isHost: boolean;
  isMuted: boolean;
  status?: "available" | "away";
  awayText?: string;
}

export function MemberEntry({ name, isHost, isMuted, status = "available", awayText }: MemberEntryProps) {
  const isAway = status === "away";
  const statusTitle = isAway
    ? (awayText ? `Away: ${awayText}` : "Away")
    : "Available";

  return (
    <div
      className={`member-entry ${isHost ? "is-host" : ""} ${isMuted ? "is-muted" : ""} ${isAway ? "is-away" : ""}`}
      title={statusTitle}
    >
      <div className="member-entry-main">
        <span className="buddy-icon" style={{ background: buddyIconColor(name) }} />
        <span className={`member-dot ${isAway ? "away" : ""}`} />
        {isHost && <span className="host-badge">★</span>}
        <span className="member-name">{name}</span>
        {isAway && <span className="member-status-pill">away</span>}
      </div>
      {isAway && awayText && <div className="member-away-text">{awayText}</div>}
    </div>
  );
}
