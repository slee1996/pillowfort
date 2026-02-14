import { useRef } from "react";
import { useGameStore } from "../../stores/gameStore";
import { useFormatStore } from "../../stores/formatStore";
import { send } from "../../services/ws";
import { encryptChatPayload } from "../../services/chatCrypto";
import { playSendSound } from "../../hooks/useSound";
import { showToast } from "../xp/Toast";
import { Button } from "../xp/Button";

let lastTypingSent = 0;

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
    try {
      const enc = await encryptChatPayload(roomId, password, name, text, style);
      if (!enc) {
        showToast("Encryption unavailable in this browser.");
        return;
      }
      send("chat", { enc });
    } catch {
      showToast("Couldn't encrypt message.");
      return;
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
    <div className="shrink-0 bg-[#ECE9D8] px-3 py-2.5 flex flex-col gap-2 max-sm:px-2.5 max-sm:pb-[max(8px,env(safe-area-inset-bottom,8px))] max-sm:gap-2">
      <input
        type="text"
        id="msg-input"
        ref={inputRef}
        placeholder="Type a message..."
        maxLength={2000}
        autoComplete="off"
        enterKeyHint="send"
        className="xp-input font-[Arial,Helvetica,sans-serif] !text-[13px] !p-1.5 max-sm:!text-base max-sm:!p-2.5"
        onKeyDown={(e) => e.key === "Enter" && handleSend()}
        onInput={handleInput}
      />
      <div className="flex gap-2 items-center flex-wrap max-sm:gap-1.5">
        <Button id="btn-send" primary onClick={handleSend} className="!px-4 !py-1.5 max-sm:!text-xs max-sm:!py-2 max-sm:!px-3 max-sm:flex-none max-sm:order-4">
          Send
        </Button>
        <div className="flex gap-0.5 items-center max-sm:order-2">
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
        <div className="flex-1 max-sm:hidden" />
        <span className="text-[11px] text-[#666] max-sm:ml-auto max-sm:order-3">{members.length} inside</span>
        {isHost ? (
          <Button id="btn-knock-down" onClick={handleKnockDown} className="!px-4 !py-1.5 max-sm:!text-xs max-sm:!py-2 max-sm:!px-3 max-sm:flex-none max-sm:order-1">
            Knock Down
          </Button>
        ) : (
          <Button id="btn-leave-room" onClick={handleLeave} className="!px-4 !py-1.5 max-sm:!text-xs max-sm:!py-2 max-sm:!px-3 max-sm:flex-none max-sm:order-1">
            Leave Fort
          </Button>
        )}
      </div>
    </div>
  );
}
