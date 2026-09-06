import type { ReactNode } from "react";
import { LogoIcon } from "../xp/Logo";
import { PeriodIcon } from "../xp/PeriodIcon";

interface RoomHeaderProps {
  roomId: string | null;
  isHost: boolean;
  memberCount: number;
  onInvite: () => void;
  onPeople: () => void;
  children?: ReactNode;
}

export function RoomHeader({ roomId, isHost, memberCount, onInvite, onPeople, children }: RoomHeaderProps) {
  return (
    <header className="room-header">
      <div className="room-brand">
        <LogoIcon size={32} />
        <span className="room-brand-name">pillowfort</span>
        <span id="room-code" className="room-code" aria-label="Fort code">{roomId}</span>
        {isHost && <span className="room-host-label">Host</span>}
      </div>
      <div className="room-header-actions">
        <button
          type="button"
          id="btn-people"
          className="room-header-action"
          aria-haspopup="dialog"
          title="Buddy list"
          onClick={onPeople}
        >
          <PeriodIcon kind="people" />
          People <span id="member-count">{memberCount}</span>
        </button>
        <button
          type="button"
          id="btn-invite"
          className="room-header-action primary"
          aria-haspopup="dialog"
          onClick={onInvite}
        >
          <PeriodIcon kind="invite" /> Invite
        </button>
        {children}
      </div>
    </header>
  );
}
