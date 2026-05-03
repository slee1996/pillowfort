import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { showToast } from "../xp/Toast";
import type { RoomTheme } from "../../services/protocol";

type MenuClick = (e: React.MouseEvent<HTMLElement>) => void;

function MenuItem({
  label,
  icon,
  detail,
  checked = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon?: string;
  detail?: string;
  checked?: boolean;
  disabled?: boolean;
  onClick?: MenuClick;
}) {
  return (
    <div
      className={`xp-menu-dropdown-item ${disabled ? "disabled" : ""}`}
      role="menuitem"
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      <span className="xp-menu-glyph">{checked ? "✓" : icon || ""}</span>
      <span className="xp-menu-label">{label}</span>
      {detail && <span className="xp-menu-detail">{detail}</span>}
    </div>
  );
}

function ThemeMenuItem({
  label,
  theme,
  current,
  premiumLabel,
  locked = false,
  onClick,
}: {
  label: string;
  theme: RoomTheme;
  current: RoomTheme;
  premiumLabel?: string;
  locked?: boolean;
  onClick?: MenuClick;
}) {
  return (
    <div
      className={`xp-menu-dropdown-item theme-menu-item ${locked ? "disabled" : ""}`}
      role="menuitem"
      aria-disabled={locked}
      onClick={locked ? undefined : onClick}
    >
      <span className="xp-menu-glyph">{current === theme ? "✓" : locked ? "🔒" : ""}</span>
      <span className={`theme-menu-swatch swatch-${theme}`} />
      <span className="xp-menu-label">{label}</span>
      {premiumLabel && <span className="xp-menu-detail">{premiumLabel}</span>}
    </div>
  );
}

export function MenuBar() {
  const isHost = useGameStore((s) => s.isHost);
  const name = useGameStore((s) => s.name);
  const roomId = useGameStore((s) => s.roomId);
  const messages = useGameStore((s) => s.messages);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const roomTheme = useGameStore((s) => s.roomTheme);
  const fortPass = useGameStore((s) => s.fortPass);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  useEffect(() => {
    const close = () => setOpenMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const toggle = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu(openMenu === id ? null : id);
  };

  const hover = (id: string) => () => {
    if (openMenu) setOpenMenu(id);
  };

  const handleSaveChat = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    let text = "";
    messages.forEach((m) => {
      if (m.kind === "system") text += `pillowtalk: ${m.text}\n`;
      else text += `${m.from} (${m.timestamp}): ${m.text}\n`;
    });
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pillowfort-${roomId || "chat"}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleLeave = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    if (isHost) {
      useGameStore.getState().setIntentionalLeave(true);
      send("knock-down");
    } else {
      useGameStore.getState().setIntentionalLeave(true);
      send("leave");
      useGameStore.getState().cleanup();
      useGameStore.getState().setScreen("home");
    }
  };

  const handleCopyCode = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    if (roomId) navigator.clipboard.writeText(roomId).then(() => showToast("Copied!"));
  };

  const handleClearMsgs = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    useGameStore.getState().clearMessages();
    useGameStore.getState().addSystemMessage("Messages cleared.");
  };

  const handleToggleBuddies = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    if (window.innerWidth <= 600) {
      window.dispatchEvent(new CustomEvent("pf-show-mobile-buddies"));
    } else {
      window.dispatchEvent(new CustomEvent("pf-toggle-buddy-panel"));
    }
  };

  const myPresence = memberPresence[name];
  const isAway = myPresence?.status === "away";

  const handleSetAvailable = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    send("set-status", { status: "available" });
  };

  const handleSetAway = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    const initial = myPresence?.awayText || "";
    const value = window.prompt("Away message (optional)", initial);
    if (value == null) return;
    send("set-status", { status: "away", awayText: value });
  };

  const handleSetTheme = (theme: RoomTheme) => (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpenMenu(null);
    if (!isHost) return;
    send("set-theme", { theme });
  };

  const premiumThemes = fortPass?.themePack === "retro-plus";

  return (
    <div className="xp-menu-bar" id="menu-bar">
      <span
        className={`xp-menu-bar-item ${openMenu === "file" ? "open" : ""}`}
        onClick={toggle("file")}
        onMouseEnter={hover("file")}
      >
        File
        <div className="xp-menu-dropdown" role="menu">
          <MenuItem label="Save Chat" icon="💾" onClick={handleSaveChat} />
          <div className="xp-menu-dropdown-sep" />
          <MenuItem
            label={isHost ? "Knock Down Fort" : "Leave Fort"}
            icon={isHost ? "🏚" : "↩"}
            onClick={handleLeave}
          />
        </div>
      </span>
      <span
        className={`xp-menu-bar-item ${openMenu === "edit" ? "open" : ""}`}
        onClick={toggle("edit")}
        onMouseEnter={hover("edit")}
      >
        Edit
        <div className="xp-menu-dropdown" role="menu">
          <MenuItem label="Copy Fort Flag" icon="✉" onClick={handleCopyCode} />
          <MenuItem label="Clear Messages" icon="⌫" onClick={handleClearMsgs} />
        </div>
      </span>
      <span
        className={`xp-menu-bar-item ${openMenu === "people" ? "open" : ""}`}
        onClick={toggle("people")}
        onMouseEnter={hover("people")}
      >
        People
        <div className="xp-menu-dropdown" role="menu">
          <MenuItem
            label={isAway ? "Set Available" : "Set Away..."}
            icon={isAway ? "●" : "◐"}
            onClick={isAway ? handleSetAvailable : handleSetAway}
          />
          <div className="xp-menu-dropdown-sep" />
          <MenuItem label="Toggle Buddy List" icon="☷" onClick={handleToggleBuddies} />
        </div>
      </span>
      {isHost && (
        <span
          className={`xp-menu-bar-item ${openMenu === "themes" ? "open" : ""}`}
          onClick={toggle("themes")}
          onMouseEnter={hover("themes")}
        >
          Themes
          <div className="xp-menu-dropdown xp-theme-menu-dropdown" role="menu">
            <ThemeMenuItem
              label="Classic"
              theme="classic"
              current={roomTheme}
              onClick={handleSetTheme("classic")}
            />
            {premiumThemes && (
              <>
                <div className="xp-menu-dropdown-sep" />
                <ThemeMenuItem
                  label="Retro Green"
                  theme="retro-green"
                  current={roomTheme}
                  premiumLabel="Fort Pass"
                  onClick={handleSetTheme("retro-green")}
                />
                <ThemeMenuItem
                  label="Midnight"
                  theme="midnight"
                  current={roomTheme}
                  premiumLabel="Fort Pass"
                  onClick={handleSetTheme("midnight")}
                />
              </>
            )}
            {!premiumThemes && (
              <>
                <div className="xp-menu-dropdown-sep" />
                <ThemeMenuItem
                  label="Retro Green"
                  theme="retro-green"
                  current={roomTheme}
                  premiumLabel="Fort Pass"
                  locked
                />
                <ThemeMenuItem
                  label="Midnight"
                  theme="midnight"
                  current={roomTheme}
                  premiumLabel="Fort Pass"
                  locked
                />
              </>
            )}
          </div>
        </span>
      )}
    </div>
  );
}
