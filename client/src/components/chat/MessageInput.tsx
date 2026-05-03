import { useEffect, useRef, useState } from "react";
import { useGameStore } from "../../stores/gameStore";
import { useFormatStore } from "../../stores/formatStore";
import { send } from "../../services/ws";
import { track, trackOnce } from "../../services/analytics";
import { encryptChatPayload, isChatCryptoAvailable } from "../../services/chatCrypto";
import { playSendSound } from "../../hooks/useSound";
import { showToast } from "../xp/Toast";
import { Button } from "../xp/Button";

let lastTypingSent = 0;
const MOBILE_KEYBOARD_OPEN_PX = 120;

export function MessageInput({ onPickerOpen }: { onPickerOpen: (type: string) => void }) {
  const name = useGameStore((s) => s.name);
  const isHost = useGameStore((s) => s.isHost);
  const members = useGameStore((s) => s.members);
  const sabRole = useGameStore((s) => s.sabRole);
  const sabCanStrike = useGameStore((s) => s.sabCanStrike);
  const inputRef = useRef<HTMLInputElement>(null);
  const [mobileKeyboardOpen, setMobileKeyboardOpen] = useState(false);
  const mobileViewportBaseRef = useRef(0);
  const disableRoomAction = mobileKeyboardOpen;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const getVisibleViewport = () => {
      const vv = window.visualViewport;
      if (!vv) return window.innerHeight;
      return vv.height + vv.offsetTop;
    };
    const detectKeyboard = () => {
      if (!media.matches) {
        setMobileKeyboardOpen(false);
        mobileViewportBaseRef.current = getVisibleViewport();
        return;
      }
      const visible = getVisibleViewport();
      if (!mobileViewportBaseRef.current) mobileViewportBaseRef.current = visible;
      if (visible > mobileViewportBaseRef.current) mobileViewportBaseRef.current = visible;
      const delta = Math.max(0, mobileViewportBaseRef.current - visible);
      setMobileKeyboardOpen(delta > MOBILE_KEYBOARD_OPEN_PX);
      if (delta < 8) mobileViewportBaseRef.current = visible;
    };
    const onOrientation = () => {
      mobileViewportBaseRef.current = 0;
      detectKeyboard();
    };
    detectKeyboard();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", detectKeyboard);
    vv?.addEventListener("scroll", detectKeyboard);
    window.addEventListener("resize", detectKeyboard);
    window.addEventListener("orientationchange", onOrientation);
    try {
      media.addEventListener("change", detectKeyboard);
      return () => {
        media.removeEventListener("change", detectKeyboard);
        vv?.removeEventListener("resize", detectKeyboard);
        vv?.removeEventListener("scroll", detectKeyboard);
        window.removeEventListener("resize", detectKeyboard);
        window.removeEventListener("orientationchange", onOrientation);
      };
    } catch {
      media.addListener(detectKeyboard);
      return () => {
        media.removeListener(detectKeyboard);
        vv?.removeEventListener("resize", detectKeyboard);
        vv?.removeEventListener("scroll", detectKeyboard);
        window.removeEventListener("resize", detectKeyboard);
        window.removeEventListener("orientationchange", onOrientation);
      };
    }
  }, []);

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
      showToast(
        isChatCryptoAvailable()
          ? "Encryption failed. Message not sent."
          : "Encryption unavailable here. Use HTTPS or localhost."
      );
      return;
    }

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

  const handleKnockDown = () => {
    if (disableRoomAction) return;
    useGameStore.getState().setIntentionalLeave(true);
    send("knock-down");
  };

  const handleLeave = () => {
    if (disableRoomAction) return;
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
          <span className="message-game-label">Games</span>
          <button id="aim-btn-vote" className="game-shortcut-btn" title="Pillow Fight" onClick={() => {
            if (members.length < 3) return showToast("Need at least 3 people");
            onPickerOpen("vote");
          }}>⚔</button>
          <button id="aim-btn-rps" className="game-shortcut-btn" title="Rock Paper Scissors" onClick={() => onPickerOpen("rps")}>✊</button>
          <button id="aim-btn-ttt" className="game-shortcut-btn" title="Tic-Tac-Toe" onClick={() => onPickerOpen("ttt")}>⬜</button>
          <button id="aim-btn-sab" className="game-shortcut-btn" title="Secret Saboteur" onClick={() => {
            if (members.length < 4) return showToast("Need at least 4 people");
            send("sab-start");
          }}>🕵</button>
          {sabRole === "defender" && (
            <button className="game-shortcut-btn" title="Accuse Saboteur" onClick={() => onPickerOpen("sab-accuse")}>🗳</button>
          )}
          <button id="aim-btn-koth" className="game-shortcut-btn" title="Dethrone" onClick={() => {
            if (isHost) return showToast("You're already the host!");
            send("koth-challenge");
            useGameStore.getState().addSystemMessage("👑 You challenged the host for the crown!");
          }}>👑</button>
          {sabRole === "saboteur" && sabCanStrike && (
            <button className="sab-strike-btn" onClick={handleSabStrike}>💣 Strike!</button>
          )}
        </div>
        <div className="message-controls-spacer" />
        {isHost ? (
          <Button
            id="btn-knock-down"
            onClick={handleKnockDown}
            className="message-btn message-btn-leave"
            disabled={disableRoomAction}
          >
            Knock Down
          </Button>
        ) : (
          <Button
            id="btn-leave-room"
            onClick={handleLeave}
            className="message-btn message-btn-leave"
            disabled={disableRoomAction}
          >
            Leave Fort
          </Button>
        )}
      </div>
    </div>
  );
}
