import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../../stores/gameStore";
import { send } from "../../services/ws";
import { showToast } from "../xp/Toast";
import type { RoomTheme } from "../../services/protocol";
import { isCredentialSystemMessage } from "../../services/roomSecret";
import { copyTextWithFallback } from "../../services/clipboard";

interface RoomMenuProps {
  onPickerOpen: (type: string) => void;
  onRequestExit: () => void;
}

export function RoomMenu({ onPickerOpen, onRequestExit }: RoomMenuProps) {
  const isHost = useGameStore((s) => s.isHost);
  const name = useGameStore((s) => s.name);
  const roomId = useGameStore((s) => s.roomId);
  const roomSafetyCode = useGameStore((s) => s.roomSafetyCode);
  const members = useGameStore((s) => s.members);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const roomTheme = useGameStore((s) => s.roomTheme);
  const fortPass = useGameStore((s) => s.fortPass);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const [showSafetyCode, setShowSafetyCode] = useState(false);
  const [copyingSafetyCode, setCopyingSafetyCode] = useState(false);
  const hostname = window.location.hostname;
  const localSkinDemo = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";

  const closeMenu = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    setShowSafetyCode(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) {
        details.open = false;
        setShowSafetyCode(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
    setShowSafetyCode(false);
  }, [roomId, roomSafetyCode]);

  const openPicker = (type: "toss" | "mute") => {
    const state = useGameStore.getState();
    if (state.roomId !== roomId || state.members.length < 2 || (type === "toss" && !state.isHost)) return;
    closeMenu();
    onPickerOpen(type);
  };

  const saveChat = () => {
    closeMenu();
    const state = useGameStore.getState();
    const text = state.messages
      .filter((message) => message.kind !== "system" || !isCredentialSystemMessage(message.text))
      .map((message) => message.kind === "system"
        ? `${message.text}\n`
        : `${message.from} (${message.timestamp}): ${message.text}\n`)
      .join("");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pillowfort-${state.roomId || "chat"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const setPresence = (status: "available" | "away") => {
    closeMenu();
    if (status === "available") {
      send("set-status", { status });
      return;
    }
    const awayText = window.prompt("Away message (optional)", memberPresence[name]?.awayText || "");
    if (awayText !== null && useGameStore.getState().roomId === roomId) {
      send("set-status", { status, awayText });
    }
  };

  const setTheme = (theme: RoomTheme) => {
    const state = useGameStore.getState();
    if (state.roomId !== roomId || !state.isHost) return;
    if (theme !== "away-message" && state.fortPass?.themePack !== "retro-plus" && !localSkinDemo) return;
    closeMenu();
    send("set-theme", { theme });
  };

  const copySafetyCode = async () => {
    const code = useGameStore.getState().roomSafetyCode;
    if (!code || copyingSafetyCode) return;
    setCopyingSafetyCode(true);
    try {
      if (await copyTextWithFallback(code) && useGameStore.getState().roomSafetyCode === code) {
        showToast("Safety code copied");
      }
    } finally {
      setCopyingSafetyCode(false);
    }
  };

  const isAway = memberPresence[name]?.status === "away";
  const premiumThemes = fortPass?.themePack === "retro-plus" || localSkinDemo;
  const premiumLabel = localSkinDemo && fortPass?.themePack !== "retro-plus" ? "Local preview" : "Fort Pass";

  return (
    <details
      ref={detailsRef}
      className="room-tools"
      onToggle={(event) => {
        if (!event.currentTarget.open) setShowSafetyCode(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && detailsRef.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <summary ref={triggerRef} id="btn-room-menu" className="room-tool-trigger" aria-controls="room-menu">
        Room
      </summary>
      <div id="room-menu" className="room-tool-panel">
        <section className="room-tool-section" aria-labelledby="room-presence-title">
          <h3 id="room-presence-title">Your presence</h3>
          <button type="button" className="room-tool-action" aria-pressed={!isAway} onClick={() => setPresence("available")}>
            Available
          </button>
          <button type="button" className="room-tool-action" aria-pressed={isAway} onClick={() => setPresence("away")}>
            Away…
          </button>
        </section>
        <section className="room-tool-section" aria-labelledby="room-people-tools-title">
          <h3 id="room-people-tools-title">People</h3>
          {isHost && (
            <button
              type="button"
              id="aim-btn-toss"
              className="room-tool-action"
              title={members.length < 2 ? "Invite someone first to pass host" : "Pass host to a buddy"}
              disabled={members.length < 2}
              onClick={() => openPicker("toss")}
            >
              Pass host
            </button>
          )}
          <button type="button" className="room-tool-action" disabled={members.length < 2} onClick={() => openPicker("mute")}>
            Mute or unmute…
          </button>
          <p>Muting only changes what you see.</p>
        </section>
        <section className="room-tool-section" aria-labelledby="room-transcript-title">
          <h3 id="room-transcript-title">On this device</h3>
          <button type="button" className="room-tool-action" onClick={saveChat}>Save chat</button>
          <button
            type="button"
            className="room-tool-action"
            onClick={() => {
              closeMenu();
              const state = useGameStore.getState();
              state.clearMessages();
              state.addSystemMessage("Messages cleared on this device.");
            }}
          >
            Clear messages
          </button>
        </section>
        <section className="room-tool-section" aria-labelledby="room-safety-title">
          <h3 id="room-safety-title">Safety code</h3>
          <p>Compare this code with a friend through another channel.</p>
          <label htmlFor="room-safety-code">This fort’s safety code</label>
          <input
            id="room-safety-code"
            type={showSafetyCode ? "text" : "password"}
            readOnly
            autoComplete="off"
            value={roomSafetyCode || ""}
            placeholder="Calculating…"
          />
          <button
            type="button"
            className="room-tool-action"
            disabled={!roomSafetyCode}
            aria-controls="room-safety-code"
            aria-pressed={showSafetyCode}
            onClick={() => setShowSafetyCode((show) => !show)}
          >
            {showSafetyCode ? "Hide safety code" : "Show safety code"}
          </button>
          <button type="button" className="room-tool-action" disabled={!roomSafetyCode || copyingSafetyCode} onClick={() => void copySafetyCode()}>
            Copy safety code
          </button>
        </section>
        {isHost && (
          <section className="room-tool-section" aria-labelledby="room-theme-title">
            <h3 id="room-theme-title">Room theme</h3>
            <button type="button" className="room-tool-action" aria-pressed={roomTheme === "away-message"} onClick={() => setTheme("away-message")}>
              Away Message
            </button>
            <button type="button" className="room-tool-action" aria-pressed={roomTheme === "campus-blue"} disabled={!premiumThemes} onClick={() => setTheme("campus-blue")}>
              Campus Blue <span>{premiumLabel}</span>
            </button>
            <button type="button" className="room-tool-action" aria-pressed={roomTheme === "top-8"} disabled={!premiumThemes} onClick={() => setTheme("top-8")}>
              Top 8 <span>{premiumLabel}</span>
            </button>
          </section>
        )}
        <section className="room-tool-section">
          <button
            type="button"
            id={isHost ? "btn-knock-down" : "btn-leave-room"}
            className="room-tool-action"
            onClick={() => {
              closeMenu();
              onRequestExit();
            }}
          >
            {isHost ? "End fort…" : "Leave fort…"}
          </button>
        </section>
      </div>
    </details>
  );
}
