import { useRef } from "react";
import { useGameStore } from "../../stores/gameStore";
import { useFormatStore } from "../../stores/formatStore";
import { send } from "../../services/ws";
import { encryptChatPayload, isChatCryptoAvailable } from "../../services/chatCrypto";
import { playSendSound } from "../../hooks/useSound";
import { showToast } from "../xp/Toast";
import { Button } from "../xp/Button";

let lastTypingSent = 0;
let warnedPlaintextFallback = false;

export function MessageInput({ onPickerOpen }: { onPickerOpen: (type: string) => void }) {
  const name = useGameStore((s) => s.name);
  const isHost = useGameStore((s) => s.isHost);
  const members = useGameStore((s) => s.members);
  const sabRole = useGameStore((s) => s.sabRole);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = async () => {
    const text = inputRef.current?.value.trim();
    if (!text) return;

    const roomId = useGameStore.getState().roomId;
    const password = useGameStore.getState().password;
    if (!roomId || !password) {
      showToast("Room key unavailable.");
      return;
    }

    const style = useFormatStore.getState().getStyle();
    let sent = false;
    try {
      const enc = await encryptChatPayload(roomId, password, name, text, style);
      if (enc) {
        send("chat", { enc });
        sent = true;
      }
    } catch {}

    if (!sent) {
      send("chat", { text, ...(style ? { style } : {}) });
      if (!warnedPlaintextFallback) {
        warnedPlaintextFallback = true;
        showToast(
          isChatCryptoAvailable()
            ? "Encryption failed. Sent without encryption."
            : "Encryption unavailable here (use HTTPS/localhost). Sent without encryption."
        );
      }
    }

    playSendSound();
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

  const handleKnockDown = () => {
    useGameStore.getState().setIntentionalLeave(true);
    send("knock-down");
  };

  const handleLeave = () => {
    useGameStore.getState().setIntentionalLeave(true);
    send("leave");
    useGameStore.getState().cleanup();
    useGameStore.getState().setScreen("home");
  };

  const handleSabStrike = () => {
    send("sab-strike");
  };

  // Expose inputRef for emoji insert
  (window as any).__pfMsgInput = inputRef;

  return (
    <div className="message-input-wrap">
      <input
        type="text"
        id="msg-input"
        ref={inputRef}
        placeholder="Type a message..."
        maxLength={2000}
        autoComplete="off"
        enterKeyHint="send"
        className="xp-input message-input-field"
        onKeyDown={(e) => e.key === "Enter" && handleSend()}
        onInput={handleInput}
      />
      <div className="message-input-controls">
        <Button id="btn-send" primary onClick={handleSend} className="message-btn message-btn-send">
          Send
        </Button>
        <div className="message-game-controls">
          <button className="game-shortcut-btn" title="Pillow Fight" onClick={() => {
            if (members.length < 3) return showToast("Need at least 3 people");
            onPickerOpen("vote");
          }}>⚔</button>
          <button className="game-shortcut-btn" title="Rock Paper Scissors" onClick={() => onPickerOpen("rps")}>✊</button>
          <button className="game-shortcut-btn" title="Tic-Tac-Toe" onClick={() => onPickerOpen("ttt")}>⬜</button>
          <button className="game-shortcut-btn" title="Secret Saboteur" onClick={() => {
            if (members.length < 4) return showToast("Need at least 4 people");
            send("sab-start");
          }}>🕵</button>
          <button className="game-shortcut-btn" title="Dethrone" onClick={() => {
            if (isHost) return showToast("You're already the host!");
            send("koth-challenge");
            useGameStore.getState().addSystemMessage("👑 You challenged the host for the crown!");
          }}>👑</button>
          {sabRole === "saboteur" && (
            <button className="sab-strike-btn" onClick={handleSabStrike}>💣 Strike!</button>
          )}
        </div>
        <div className="message-controls-spacer" />
        <span id="member-count" className="message-members-count">{members.length} inside</span>
        {isHost ? (
          <Button id="btn-knock-down" onClick={handleKnockDown} className="message-btn message-btn-leave">
            Knock Down
          </Button>
        ) : (
          <Button id="btn-leave-room" onClick={handleLeave} className="message-btn message-btn-leave">
            Leave Fort
          </Button>
        )}
      </div>
    </div>
  );
}
