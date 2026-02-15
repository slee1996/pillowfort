import { useEffect, useRef } from "react";
import { useGameStore } from "../../stores/gameStore";
import { ChatMessage } from "./ChatMessage";

export function MessageList() {
  const messages = useGameStore((s) => s.messages);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div
      id="messages"
      ref={ref}
      className="message-list"
    >
      {messages.map((msg) => (
        <ChatMessage key={msg.id} msg={msg} />
      ))}
    </div>
  );
}
