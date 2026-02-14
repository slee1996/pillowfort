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
      className="flex-1 overflow-y-auto bg-white px-3.5 py-3 max-sm:px-3 max-sm:py-2.5 font-[Arial,Helvetica,sans-serif] text-[13px] leading-[1.45]"
    >
      {messages.map((msg) => (
        <ChatMessage key={msg.id} msg={msg} />
      ))}
    </div>
  );
}
