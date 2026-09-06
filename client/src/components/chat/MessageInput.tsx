import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGameStore } from "../../stores/gameStore";
import { useFormatStore } from "../../stores/formatStore";
import { send } from "../../services/ws";
import { trackOnce } from "../../services/analytics";
import { playSendSound } from "../../hooks/useSound";
import { showToast } from "../xp/Toast";
import { Button } from "../xp/Button";
import { FormatToolbar } from "./FormatToolbar";
import { PeriodIcon } from "../xp/PeriodIcon";

let lastTypingSent = 0;

export function MessageInput({
  onPickerOpen,
  onDraw,
  onTakeBreak,
}: {
  onPickerOpen: (type: string) => void;
  onDraw: () => void;
  onTakeBreak: () => void;
}) {
  const name = useGameStore((s) => s.name);
  const isHost = useGameStore((s) => s.isHost);
  const roomId = useGameStore((s) => s.roomId);
  const members = useGameStore((s) => s.members);
  const sabRole = useGameStore((s) => s.sabRole);
  const sabCanStrike = useGameStore((s) => s.sabCanStrike);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const gameDialogRef = useRef<HTMLDialogElement>(null);
  const gamesButtonRef = useRef<HTMLButtonElement>(null);
  const [gamesOpen, setGamesOpen] = useState(false);
  const hostAvailable = members.length >= 2 && !!members[0] && members[0] !== name;

  useLayoutEffect(() => {
    if (!gamesOpen) return;
    const dialog = gameDialogRef.current!;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("#btn-close-games")!.focus();
    return () => dialog.close();
  }, [gamesOpen]);

  useEffect(() => {
    setGamesOpen(false);
  }, [roomId, isHost]);

  const closeGames = () => {
    gameDialogRef.current?.close();
    gamesButtonRef.current?.focus();
    setGamesOpen(false);
  };

  const pickGame = (type: string) => {
    closeGames();
    onPickerOpen(type);
  };

  const handleSend = () => {
    const text = inputRef.current?.value.trim();
    if (!text) return;

    const roomId = useGameStore.getState().roomId;
    if (!roomId) {
      showToast("Room key unavailable.");
      return;
    }

    const style = useFormatStore.getState().getStyle();
    if (!send("chat", { text, style })) return showToast("Secure delivery is unavailable.");

    playSendSound();
    trackOnce(`first-message:${roomId}`, "first_message_sent", {
      role: isHost ? "host" : "guest",
      memberCount: members.length,
    });
    inputRef.current!.value = "";
    inputRef.current!.focus();
  };

  const handleInput = () => {
    const now = Date.now();
    if (now - lastTypingSent > 2000) {
      send("typing");
      lastTypingSent = now;
    }
  };

  const handleInsertEmoji = (emoji: string) => {
    const input = inputRef.current;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    if (input.value.length - (end - start) + emoji.length > input.maxLength) return;
    input.setRangeText(emoji, start, end, "end");
    input.focus();
    handleInput();
  };

  return (
    <div className="message-input-wrap">
      <form
        className="message-input-form"
        aria-label="Send a message"
        onSubmit={(event) => {
          event.preventDefault();
          handleSend();
        }}
      >
        <div id="message-formatting">
          <FormatToolbar onInsertEmoji={handleInsertEmoji} />
        </div>
        <textarea
          id="msg-input"
          ref={inputRef}
          rows={3}
          aria-label="Message"
          aria-describedby="compose-keyboard-help"
          placeholder="Say something…"
          maxLength={2000}
          autoComplete="off"
          enterKeyHint="send"
          className="xp-input message-input-field"
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) return;
            event.preventDefault();
            if (!event.repeat) handleSend();
          }}
          onInput={handleInput}
        />
        <div className="message-compose-actions">
          <div className="message-input-controls">
            <button
              id="btn-open-games"
              ref={gamesButtonRef}
              type="button"
              className="xp-btn message-btn message-btn-games"
              aria-haspopup="dialog"
              aria-expanded={gamesOpen}
              aria-controls="game-picker-dialog"
              onClick={() => setGamesOpen(true)}
            >
              <PeriodIcon kind="games" /> Play
            </button>
            {sabRole === "defender" && (
              <button type="button" className="xp-btn" title="Accuse Saboteur" onClick={() => onPickerOpen("sab-accuse")}>
                Accuse Saboteur
              </button>
            )}
            {sabRole === "saboteur" && sabCanStrike && (
              <button type="button" className="sab-strike-btn" onClick={() => send("sab-strike")}>Strike!</button>
            )}
          </div>
          <span id="compose-keyboard-help">Enter to send · Shift+Enter for a new line</span>
          <Button id="btn-send" type="submit" className="message-btn message-btn-send">
            Send
          </Button>
        </div>
      </form>
      <dialog
        id="game-picker-dialog"
        ref={gameDialogRef}
        className="product-dialog game-picker-dialog"
        aria-labelledby="game-picker-title"
        aria-describedby="game-picker-description"
        onCancel={(event) => {
          event.preventDefault();
          closeGames();
        }}
      >
        <div className="product-dialog-header">
          <h2 id="game-picker-title"><PeriodIcon kind="games" /> Games</h2>
        </div>
        <div className="product-dialog-body">
          <p id="game-picker-description">Pick something to do. {members.length} {members.length === 1 ? "person" : "people"} in this fort.</p>
          <div className="message-game-controls game-choice-grid">
            <button
              type="button"
              id="btn-start-drawing"
              className="game-choice"
              onClick={() => {
                closeGames();
                onDraw();
              }}
            >
              <span className="game-choice-name"><PeriodIcon kind="pencil" /> Doodle</span>
              <span className="game-choice-hint">Draw on the fort’s shared canvas.</span>
            </button>
            <button
              type="button"
              id="aim-btn-rps"
              title="Rock Paper Scissors"
              className="game-choice"
              disabled={members.length < 2}
              onClick={() => pickGame("rps")}
            >
              <span className="game-choice-name"><PeriodIcon kind="rock" /> Rock Paper Scissors</span>
              <span className="game-choice-hint">Challenge a buddy. Needs 2 people.</span>
            </button>
            <button
              type="button"
              id="aim-btn-ttt"
              title="Tic-Tac-Toe"
              className="game-choice"
              disabled={members.length < 2}
              onClick={() => pickGame("ttt")}
            >
              <span className="game-choice-name"><PeriodIcon kind="board" /> Tic-Tac-Toe</span>
              <span className="game-choice-hint">Get three in a row. Needs 2 people.</span>
            </button>
            <button
              type="button"
              id="aim-btn-vote"
              title="Pillow Fight"
              className="game-choice"
              disabled={members.length < 3}
              onClick={() => pickGame("vote")}
            >
              <span className="game-choice-name"><PeriodIcon kind="pillow" /> Pillow Fight</span>
              <span className="game-choice-hint">Vote a buddy out of the fort. Needs 3 people.</span>
            </button>
            <button
              type="button"
              id="aim-btn-sab"
              title="Secret Saboteur"
              className="game-choice"
              disabled={members.length < 4}
              onClick={() => {
                closeGames();
                send("sab-start");
              }}
            >
              <span className="game-choice-name"><PeriodIcon kind="search" /> Secret Saboteur</span>
              <span className="game-choice-hint">Find the secret saboteur. Needs 4 people.</span>
            </button>
            <button
              type="button"
              id="aim-btn-koth"
              title="Dethrone"
              className="game-choice"
              disabled={isHost || !hostAvailable}
              onClick={() => {
                closeGames();
                send("koth-challenge");
                useGameStore.getState().addSystemMessage("You challenged the host for the crown!");
              }}
            >
              <span className="game-choice-name"><PeriodIcon kind="crown" /> Dethrone</span>
              <span className="game-choice-hint">
                {isHost
                  ? "Guests challenge the host. You're already the host."
                  : hostAvailable
                    ? "Challenge the host for the crown. Guests only."
                    : "Guests challenge the host. Needs a host in the fort."}
              </span>
            </button>
            <button
              type="button"
              id="chat-btn-min"
              title="Take a break"
              className="game-choice"
              onClick={() => {
                closeGames();
                onTakeBreak();
              }}
            >
              <span className="game-choice-name"><PeriodIcon kind="breakout" /> Breakout</span>
              <span className="game-choice-hint">Play solo while you wait for friends. Your fort stays open.</span>
            </button>
          </div>
        </div>
        <div className="product-dialog-actions game-picker-actions">
          <Button id="btn-close-games" type="button" onClick={closeGames}>Cancel</Button>
        </div>
      </dialog>
    </div>
  );
}
