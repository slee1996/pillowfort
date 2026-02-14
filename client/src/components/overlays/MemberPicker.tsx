import { buddyIconColor } from "../../utils/nameColor";

interface MemberPickerProps {
  title: string;
  members: string[];
  onPick: (name: string) => void;
  onClose: () => void;
}

export function MemberPicker({ title, members, onPick, onClose }: MemberPickerProps) {
  return (
    <div
      className="member-picker-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="member-picker">
        <div className="xp-title-bar" style={{ cursor: "default" }}>
          <div className="xp-title-text">{title}</div>
          <div className="xp-title-buttons">
            <div className="xp-title-btn xp-title-btn-close" onClick={onClose}>
              ✕
            </div>
          </div>
        </div>
        <div className="member-picker-body">
          {members.length === 0 ? (
            <div className="p-2 text-[11px] text-[#888]">No one to pick.</div>
          ) : (
            members.map((name) => (
              <div
                key={name}
                className="member-picker-item"
                onClick={() => onPick(name)}
              >
                <span className="buddy-icon" style={{ background: buddyIconColor(name) }} />
                <span>{name}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
