import { useState, useRef, useCallback, useEffect } from "react";
import { useGameStore } from "../stores/gameStore";
import { send } from "../services/ws";
import { track } from "../services/analytics";
import { showToast } from "../components/xp/Toast";
import { RoomHeader } from "../components/chat/RoomHeader";
import { RoomMenu } from "../components/chat/RoomMenu";
import { MessageList } from "../components/chat/MessageList";
import { MessageInput } from "../components/chat/MessageInput";
import { TypingIndicator } from "../components/chat/TypingIndicator";
import { PeopleDialog } from "../components/sidebar/PeopleDialog";
import { InviteDialog } from "../components/sidebar/InviteDialog";
import { RoomRoster } from "../components/sidebar/RoomRoster";
import { MemberPicker } from "../components/overlays/MemberPicker";
import { HostOfferDialog } from "../components/overlays/HostOfferDialog";
import { AdmissionApprovalDialog } from "../components/overlays/AdmissionApprovalDialog";
import { ExitConfirmationDialog } from "../components/overlays/ExitConfirmationDialog";
import { VoteBanner } from "../components/games/VoteBanner";
import { RpsOverlay } from "../components/games/RpsOverlay";
import { TttOverlay } from "../components/games/TttOverlay";
import { SabVoteBanner } from "../components/games/SabVoteBanner";
import { DrawCanvas } from "../components/canvas/DrawCanvas";
import { BreakoutCanvas } from "../components/canvas/BreakoutCanvas";
import type { GameQueueItem } from "../services/protocol";
import { agentMode, registerRoomActivities } from "../agent/breakout";

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

  const [picker, setPicker] = useState<PickerType>(null);
  const [sabFrameFx, setSabFrameFx] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingExit, setPendingExit] = useState<{ roomId: string; isHost: boolean } | null>(null);
  const fxTimeoutRef = useRef<number | null>(null);
  const prevSabStrikesRef = useRef(0);
  const returnButtonRef = useRef<HTMLButtonElement>(null);
  const focusedActivity = drawing || minimized;
  const roomMode = drawing ? "drawing" : minimized ? "breakout" : "conversation";

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

  useEffect(() => {
    setDrawing(false);
    setPeopleOpen(false);
    setInviteOpen(false);
    setPicker(null);
  }, [roomId]);

  useEffect(() => {
    setPendingExit(null);
  }, [roomId, isHost]);

  useEffect(() => {
    if (!focusedActivity) return;
    const frame = requestAnimationFrame(() => returnButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusedActivity]);

  const handleDraw = () => {
    setDrawing(true);
    useGameStore.getState().setMinimized(true);
  };

  const handleTakeBreak = () => {
    setDrawing(false);
    useGameStore.getState().setMinimized(true);
    track("game_started", {
      kind: "breakout",
      role: isHost ? "host" : "guest",
      memberCount: members.length,
    });
  };

  const handleRestore = () => {
    setDrawing(false);
    useGameStore.getState().setMinimized(false);
    useGameStore.getState().resetUnread();
    requestAnimationFrame(() => document.getElementById("msg-input")?.focus());
  };

  useEffect(() => {
    if (!agentMode()) return;
    return registerRoomActivities({
      drawing: handleDraw,
      breakout: handleTakeBreak,
      conversation: handleRestore,
    });
  }, [roomId, isHost, members.length]);

  const onRequestExit = () => {
    if (roomId) setPendingExit({ roomId, isHost });
  };

  const handleConfirmExit = () => {
    const current = useGameStore.getState();
    setPendingExit(null);
    if (!pendingExit || current.roomId !== pendingExit.roomId || current.isHost !== pendingExit.isHost) return;
    current.setIntentionalLeave(true);
    send(current.isHost ? "knock-down" : "leave");
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
    toss: "Pass host to...",
    mute: "Mute / Unmute",
    vote: "Vote to kick...",
    rps: "Challenge to RPS...",
    ttt: "Challenge to Tic-Tac-Toe...",
    "sab-accuse": "Accuse as saboteur...",
  };

  const filteredMembers = picker
    ? members.filter((n) => n !== name)
    : [];


  return (
    <div className={`screen room-scene screen-chat theme-${roomTheme}`} data-room-mode={roomMode}>
      <DrawCanvas active={drawing} />
      <BreakoutCanvas active={minimized && !drawing} />

      {focusedActivity && (
        <div className="room-focus-bar">
          <span className="room-focus-label">{drawing ? "Doodle together" : "Breakout"}</span>
          <button
            type="button"
            id="btn-return-room"
            className="room-header-action"
            ref={returnButtonRef}
            onClick={handleRestore}
          >
            Back to fort
            {unreadCount > 0 && (
              <span className="unread-badge" aria-label={`${unreadCount} unread messages`}>
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
        </div>
      )}

      <main className={`room-shell ${sabFrameFx}`} hidden={focusedActivity}>
        {sabBombCountdown > 0 && (
          <div
            className={`sab-bomb-overlay ${sabBombCountdown <= 3 ? "critical" : ""}`}
            aria-live="polite"
          >
            <span className="sab-bomb-icon" aria-hidden>💣</span>
            <span className="sab-bomb-text">incoming detonation</span>
            <span className="sab-bomb-count">{sabBombCountdown}</span>
          </div>
        )}
        {sabFrameFx === "sab-fx-explode" && (
          <div className="sab-mushroom-cloud" aria-hidden>
            <div className="sab-cloud-cap" />
            <div className="sab-cloud-stem" />
            <div className="sab-cloud-ring" />
          </div>
        )}

        <RoomHeader
          roomId={roomId}
          isHost={isHost}
          memberCount={members.length}
          onInvite={() => setInviteOpen(true)}
          onPeople={() => setPeopleOpen(true)}
        >
          <RoomMenu onPickerOpen={handlePickerOpen} onRequestExit={onRequestExit} />
        </RoomHeader>

        <div className="room-workspace">
          <div className="room-chat-column">
        <section className="room-conversation" aria-label="Conversation">
          {(gameQueue.current || gameQueue.queue.length > 0) && (
            <details className="room-game-queue">
              <summary>
                {gameQueue.current
                  ? `Now playing: ${describeQueueItem(gameQueue.current)}`
                  : `${gameQueue.queue.length} ${gameQueue.queue.length === 1 ? "game" : "games"} queued`}
              </summary>
              {gameQueue.queue.length > 0 ? (
                <ol aria-label="Up next">
                  {gameQueue.queue.map((item, index) => (
                    <li key={`${item.kind}-${item.by}-${item.target || ""}-${index}`}>
                      {describeQueueItem(item)}
                    </li>
                  ))}
                </ol>
              ) : <p>No games queued.</p>}
            </details>
          )}
          {sabRole && (
            <div className={`sab-role-badge ${sabRole}`}>
              {sabRole === "saboteur" ? "You are the saboteur" : "You are a defender"}
            </div>
          )}
          <SabVoteBanner />
          <VoteBanner />
          <MessageList
            emptyState={members.length <= 1 ? (
              <div className="room-empty-state">
                <h1 className="room-empty-title">Your fort is open.</h1>
                <p className="room-empty-description">Invite your people, then settle in.</p>
                <button type="button" className="room-empty-action" onClick={() => setInviteOpen(true)}>
                  Invite friends
                </button>
              </div>
            ) : (
              <p className="room-empty-state">You're in. Say hello.</p>
            )}
          />
          <TypingIndicator />
        </section>
        <MessageInput
          onPickerOpen={handlePickerOpen}
          onDraw={handleDraw}
          onTakeBreak={handleTakeBreak}
        />
          </div>
          <RoomRoster />
        </div>
      </main>

      <AdmissionApprovalDialog />
      <HostOfferDialog />
      <RpsOverlay />
      <TttOverlay />
      <PeopleDialog open={peopleOpen} onClose={() => setPeopleOpen(false)} />
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      {pendingExit && pendingExit.roomId === roomId && pendingExit.isHost === isHost && (
        <ExitConfirmationDialog
          isHost={isHost}
          onConfirm={handleConfirmExit}
          onCancel={() => setPendingExit(null)}
        />
      )}

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
