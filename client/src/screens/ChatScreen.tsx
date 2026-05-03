import { useState, useRef, useCallback, useEffect } from "react";
import { useGameStore } from "../stores/gameStore";
import { send } from "../services/ws";
import { track } from "../services/analytics";
import { showToast } from "../components/xp/Toast";
import { TitleBar } from "../components/xp/TitleBar";
import { MenuBar } from "../components/chat/MenuBar";
import { ActionBar } from "../components/chat/ActionBar";
import { FormatToolbar } from "../components/chat/FormatToolbar";
import { MessageList } from "../components/chat/MessageList";
import { MessageInput } from "../components/chat/MessageInput";
import { TypingIndicator } from "../components/chat/TypingIndicator";
import { BuddyPanel } from "../components/sidebar/BuddyPanel";
import { MobileBuddyOverlay } from "../components/sidebar/MobileBuddyOverlay";
import { MobileInviteSheet } from "../components/sidebar/MobileInviteSheet";
import { MemberPicker } from "../components/overlays/MemberPicker";
import { HostOfferDialog } from "../components/overlays/HostOfferDialog";
import { VoteBanner } from "../components/games/VoteBanner";
import { RpsOverlay } from "../components/games/RpsOverlay";
import { TttOverlay } from "../components/games/TttOverlay";
import { SabVoteBanner } from "../components/games/SabVoteBanner";
import { DrawCanvas } from "../components/canvas/DrawCanvas";
import { BreakoutCanvas } from "../components/canvas/BreakoutCanvas";
import { DraggableWindow } from "../components/effects/DraggableWindow";
import type { GameQueueItem } from "../services/protocol";

type PickerType = "toss" | "mute" | "vote" | "rps" | "ttt" | "sab-accuse" | null;

function describeQueueItem(item: GameQueueItem): string {
  switch (item.kind) {
    case "vote":
      return `Pillow Fight: ${item.by} vs ${item.target || "?"}`;
    case "rps":
      return `RPS: ${item.by} vs ${item.target || "?"}`;
    case "ttt":
      return `TTT: ${item.by} vs ${item.target || "?"}`;
    case "saboteur":
      return `Saboteur started by ${item.by}`;
    case "koth":
      return `KOTH challenge by ${item.by}`;
  }
}

function themeLabel(theme: string): string {
  switch (theme) {
    case "retro-green":
      return "Retro Green";
    case "midnight":
      return "Midnight";
    default:
      return "Classic";
  }
}

export function ChatScreen() {
  const roomId = useGameStore((s) => s.roomId);
  const isHost = useGameStore((s) => s.isHost);
  const name = useGameStore((s) => s.name);
  const members = useGameStore((s) => s.members);
  const minimized = useGameStore((s) => s.minimized);
  const unreadCount = useGameStore((s) => s.unreadCount);
  const sabRole = useGameStore((s) => s.sabRole);
  const sabStrikes = useGameStore((s) => s.sabStrikes);
  const sabBombCountdown = useGameStore((s) => s.sabBombCountdown);
  const sabDetonateSignal = useGameStore((s) => s.sabDetonateSignal);
  const gameQueue = useGameStore((s) => s.gameQueue);
  const roomTheme = useGameStore((s) => s.roomTheme);
  const memberPresence = useGameStore((s) => s.memberPresence);
  const fortPass = useGameStore((s) => s.fortPass);

  const [picker, setPicker] = useState<PickerType>(null);
  const [sabFrameFx, setSabFrameFx] = useState("");
  const titleBarRef = useRef<HTMLDivElement>(null);
  const fxTimeoutRef = useRef<number | null>(null);
  const prevSabStrikesRef = useRef(0);

  useEffect(() => {
    if (sabStrikes <= 0 || sabStrikes === prevSabStrikesRef.current) return;
    prevSabStrikesRef.current = sabStrikes;

    if (fxTimeoutRef.current) {
      window.clearTimeout(fxTimeoutRef.current);
      fxTimeoutRef.current = null;
    }

    if (sabStrikes >= 3) return;

    const isSecondStrike = sabStrikes === 2;
    setSabFrameFx(isSecondStrike ? "sab-fx-shake-heavy" : "sab-fx-shake-light");
    fxTimeoutRef.current = window.setTimeout(() => {
      setSabFrameFx("");
      fxTimeoutRef.current = null;
    }, isSecondStrike ? 520 : 360);
  }, [sabStrikes]);

  useEffect(() => {
    if (!sabDetonateSignal) return;
    if (fxTimeoutRef.current) {
      window.clearTimeout(fxTimeoutRef.current);
      fxTimeoutRef.current = null;
    }
    setSabFrameFx("sab-fx-explode");
  }, [sabDetonateSignal]);

  useEffect(() => {
    return () => {
      if (fxTimeoutRef.current) window.clearTimeout(fxTimeoutRef.current);
    };
  }, []);

  const handleMinimize = () => {
    const m = !minimized;
    useGameStore.getState().setMinimized(m);
    if (m) {
      track("game_started", {
        kind: "breakout",
        role: isHost ? "host" : "guest",
        memberCount: members.length,
      });
    }
    if (!m) useGameStore.getState().resetUnread();
  };

  const handleMaximize = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen();
    }
  };

  const handleClose = () => {
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

  const handleRestore = () => {
    if (minimized) {
      useGameStore.getState().setMinimized(false);
      useGameStore.getState().resetUnread();
    }
  };

  const handleCopyRoom = () => {
    if (roomId) navigator.clipboard.writeText(roomId).then(() => {
      showToast("Copied!");
      track("invite_copied", {
        role: isHost ? "host" : "guest",
        source: "room_code",
        memberCount: members.length,
      });
    });
  };

  const handlePickerOpen = useCallback((type: string) => {
    setPicker(type as PickerType);
  }, []);

  const handlePick = (picked: string) => {
    const type = picker;
    setPicker(null);
    if (!type) return;

    switch (type) {
      case "toss":
        send("toss-pillow", { target: picked });
        useGameStore.getState().addSystemMessage(`You tossed the pillow to ${picked}!`);
        break;
      case "mute": {
        const nowMuted = useGameStore.getState().toggleMute(picked);
        showToast(nowMuted ? `Muted ${picked}` : `Unmuted ${picked}`);
        break;
      }
      case "vote":
        send("start-vote", { target: picked });
        break;
      case "rps":
        send("rps-challenge", { target: picked });
        useGameStore.getState().addSystemMessage(`You challenged ${picked} to Rock Paper Scissors!`);
        break;
      case "ttt":
        send("ttt-challenge", { target: picked });
        useGameStore.getState().addSystemMessage(`You challenged ${picked} to Tic-Tac-Toe!`);
        break;
      case "sab-accuse":
        send("sab-accuse", { suspect: picked });
        useGameStore.getState().addSystemMessage(`You accused ${picked}.`);
        break;
    }
  };

  const pickerTitles: Record<string, string> = {
    toss: "Toss Pillow to...",
    mute: "Mute / Unmute",
    vote: "Vote to kick...",
    rps: "Challenge to RPS...",
    ttt: "Challenge to Tic-Tac-Toe...",
    "sab-accuse": "Accuse as saboteur...",
  };

  const filteredMembers = picker
    ? members.filter((n) => n !== name)
    : [];

  const handleInsertEmoji = (emoji: string) => {
    const input = (window as any).__pfMsgInput?.current as HTMLInputElement | undefined;
    if (input) {
      input.value += emoji;
      input.focus();
    }
  };

  const chatInfoText = `You are chatting with ${
    members.length === 1 ? "0 buddies" : `${members.length - 1} ${members.length - 1 === 1 ? "buddy" : "buddies"}`
  }`;
  const awayCount = members.filter((member) => memberPresence[member]?.status === "away").length;
  const availableCount = Math.max(0, members.length - awayCount);
  const activeThemeLabel = themeLabel(roomTheme);

  return (
    <div className={`screen screen-chat theme-${roomTheme}`}>
      <DrawCanvas />
      <BreakoutCanvas active={minimized} />

      <DraggableWindow
        className={`xp-window chat-window ${minimized ? "chat-window-minimized" : ""} ${sabFrameFx}`}
        minimized={minimized}
        titleBarRef={titleBarRef}
      >
        {!minimized && sabBombCountdown > 0 && (
          <div
            className={`sab-bomb-overlay ${sabBombCountdown <= 3 ? "critical" : ""}`}
            aria-live="polite"
          >
            <span className="sab-bomb-icon" aria-hidden>💣</span>
            <span className="sab-bomb-text">incoming detonation</span>
            <span className="sab-bomb-count">{sabBombCountdown}</span>
          </div>
        )}
        {!minimized && sabFrameFx === "sab-fx-explode" && (
          <div className="sab-mushroom-cloud" aria-hidden>
            <div className="sab-cloud-cap" />
            <div className="sab-cloud-stem" />
            <div className="sab-cloud-ring" />
          </div>
        )}

        <TitleBar
          ref={titleBarRef}
          title=""
          onDoubleClick={handleRestore}
          buttons={[
            { id: "chat-btn-min", label: "─", onClick: handleMinimize },
            { id: "chat-btn-max", label: "□", onClick: handleMaximize },
            { label: "✕", close: true, onClick: handleClose },
          ]}
          extra={
            <>
              pillowfort —{" "}
              <span
                id="room-code"
                className="room-code"
                title="Click to copy fort flag"
                onClick={handleCopyRoom}
              >
                {roomId}
              </span>
              {unreadCount > 0 && (
                <span className="unread-badge">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
              {sabRole && (
                <span className={`sab-role-badge ${sabRole}`}>
                  {sabRole === "saboteur" ? "SABOTEUR" : "DEFENDER"}
                </span>
              )}
            </>
          }
        />

        {!minimized && (
          <>
            <MenuBar />
            <ActionBar onPickerOpen={handlePickerOpen} />

            <div className="chat-main">
              <div className="chat-column">
                <div className="chat-info-bar">
                  <div className="chat-info-primary">{chatInfoText}</div>
                  {gameQueue.current && (
                    <>
                      <span className="chat-info-sep">•</span>
                      <span className="chat-info-queue-now">
                      Now playing: {describeQueueItem(gameQueue.current)}
                      </span>
                    </>
                  )}
                  {gameQueue.queue.length > 0 && (
                    <>
                      <span className="chat-info-sep">•</span>
                      <span className="chat-info-queue-next">
                        Up next: {gameQueue.queue.map(describeQueueItem).join(" • ")}
                      </span>
                    </>
                  )}
                </div>

                <SabVoteBanner />
                <VoteBanner />
                <MessageList />
                <TypingIndicator />
                <FormatToolbar onInsertEmoji={handleInsertEmoji} />
                <MessageInput onPickerOpen={handlePickerOpen} />
                <div className="chat-status-strip" aria-live="polite">
                  <span className="status-strip-cell status-online">
                    <span className="status-light" aria-hidden />
                    {availableCount} available
                  </span>
                  {awayCount > 0 && (
                    <span className="status-strip-cell status-away">{awayCount} away</span>
                  )}
                  <span className="status-strip-cell">theme: {activeThemeLabel}</span>
                  <span className="status-strip-cell">encrypted</span>
                  {fortPass?.themePack === "retro-plus" && (
                    <span className="status-strip-cell status-fort-pass">Fort Pass</span>
                  )}
                </div>
              </div>
              <BuddyPanel />
            </div>
          </>
        )}
      </DraggableWindow>

      {/* Overlays */}
      <HostOfferDialog />
      <RpsOverlay />
      <TttOverlay />
      <MobileBuddyOverlay />
      <MobileInviteSheet />

      {picker && (
        <MemberPicker
          title={pickerTitles[picker] || "Pick a member"}
          members={filteredMembers}
          onPick={handlePick}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
