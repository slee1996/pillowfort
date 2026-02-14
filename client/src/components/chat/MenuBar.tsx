import { useState, useEffect } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { showToast } from "../xp/Toast";

export function MenuBar() {
  const isHost = useGameStore((s) => s.isHost);
  const name = useGameStore((s) => s.name);
  const roomId = useGameStore((s) => s.roomId);
  const messages = useGameStore((s) => s.messages);
  const memberPresence = useGameStore((s) => s.memberPresence);
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

  const handleSaveChat = (e: React.MouseEvent) => {
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

  const handleLeave = (e: React.MouseEvent) => {
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

  const handleCopyCode = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu(null);
    if (roomId) navigator.clipboard.writeText(roomId).then(() => showToast("Copied!"));
  };

  const handleClearMsgs = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu(null);
    useGameStore.getState().clearMessages();
    useGameStore.getState().addSystemMessage("Messages cleared.");
  };

  const handleToggleBuddies = (e: React.MouseEvent) => {
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

  const handleSetAvailable = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu(null);
    send("set-status", { status: "available" });
  };

  const handleSetAway = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu(null);
    const initial = myPresence?.awayText || "";
    const value = window.prompt("Away message (optional)", initial);
    if (value == null) return;
    send("set-status", { status: "away", awayText: value });
  };

  return (
    <div className="xp-menu-bar" id="menu-bar">
      <span
        className={`xp-menu-bar-item ${openMenu === "file" ? "open" : ""}`}
        onClick={toggle("file")}
        onMouseEnter={hover("file")}
      >
        File
        <div className="xp-menu-dropdown">
          <div className="xp-menu-dropdown-item" onClick={handleSaveChat}>Save Chat</div>
          <div className="xp-menu-dropdown-sep" />
          <div className="xp-menu-dropdown-item" onClick={handleLeave}>
            {isHost ? "Knock Down Fort" : "Leave Fort"}
          </div>
        </div>
      </span>
      <span
        className={`xp-menu-bar-item ${openMenu === "edit" ? "open" : ""}`}
        onClick={toggle("edit")}
        onMouseEnter={hover("edit")}
      >
        Edit
        <div className="xp-menu-dropdown">
          <div className="xp-menu-dropdown-item" onClick={handleCopyCode}>Copy Fort Flag</div>
          <div className="xp-menu-dropdown-item" onClick={handleClearMsgs}>Clear Messages</div>
        </div>
      </span>
      <span
        className={`xp-menu-bar-item ${openMenu === "people" ? "open" : ""}`}
        onClick={toggle("people")}
        onMouseEnter={hover("people")}
      >
        People
        <div className="xp-menu-dropdown">
          <div className="xp-menu-dropdown-item" onClick={isAway ? handleSetAvailable : handleSetAway}>
            {isAway ? "Set Available" : "Set Away..."}
          </div>
          <div className="xp-menu-dropdown-sep" />
          <div className="xp-menu-dropdown-item" onClick={handleToggleBuddies}>Toggle Buddy List</div>
        </div>
      </span>
    </div>
  );
}
