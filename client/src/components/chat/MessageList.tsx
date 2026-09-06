import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useGameStore } from "../../stores/gameStore";
import { ChatMessage } from "./ChatMessage";

export function MessageList({ emptyState }: { emptyState?: ReactNode }) {
  const messages = useGameStore((s) => s.messages);
  const roomId = useGameStore((s) => s.roomId);
  const ref = useRef<HTMLDivElement>(null);

  const previousRoomRef = useRef(roomId);
  const followingRef = useRef(true);

  useLayoutEffect(() => {
    if (previousRoomRef.current !== roomId || messages.length === 0) {
      followingRef.current = true;
      previousRoomRef.current = roomId;
    }
    if (ref.current && ref.current.clientHeight > 0 && followingRef.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [roomId, messages]);

  useLayoutEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight > 0 && followingRef.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      id="messages"
      ref={ref}
      className="message-list"
      role="log"
      aria-label="Fort conversation"
      aria-live="polite"
      aria-relevant="additions"
      aria-atomic="false"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        if (element.clientHeight === 0) return;
        followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 64;
      }}
    >
      {messages.length === 0 && <div className="message-empty-state">{emptyState}</div>}
      {messages.map((msg) => (
        <ChatMessage key={msg.id} msg={msg} />
      ))}
    </div>
  );
}
