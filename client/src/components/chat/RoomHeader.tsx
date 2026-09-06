import type { ReactNode } from "react";
import { LogoIcon } from "../xp/Logo";

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
          <svg className="room-buddy-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <circle cx="7" cy="6" r="3" />
            <path d="M1 18v-3a6 6 0 0 1 12 0v3Z" />
            <circle cx="15" cy="7" r="2.5" />
            <path d="M14 12a4 4 0 0 1 5 4v2h-4v-3Z" />
          </svg>
          People <span id="member-count">{memberCount}</span>
        </button>
        <button
          type="button"
          id="btn-invite"
          className="room-header-action primary"
          aria-haspopup="dialog"
          onClick={onInvite}
        >
          Invite
        </button>
        {children}
      </div>
    </header>
  );
}
