import type { ChatMessage as ChatMsg } from "../../services/protocol";
import { nameColor } from "../../utils/nameColor";

export function ChatMessage({ msg }: { msg: ChatMsg }) {
  if (msg.kind === "system") {
    return (
      <div className="chat-message chat-message-system">
        <span className="chat-system-label">pillowtalk</span>
        <span className="chat-system-text">: {msg.text}</span>
      </div>
    );
  }

  const style = msg.style;
  let textContent: React.ReactNode = <span>{msg.text}</span>;

  if (style) {
    if (style.color) {
      textContent = <span style={{ color: style.color }}>{msg.text}</span>;
    }
    if (style.bold) textContent = <b>{textContent}</b>;
    if (style.italic) textContent = <i>{textContent}</i>;
    if (style.underline) textContent = <u>{textContent}</u>;
  }

  return (
    <div className="chat-message">
      <span className="chat-sender" style={{ color: nameColor(msg.from!) }}>
        {msg.from}
      </span>
      <span className="chat-timestamp"> ({msg.timestamp})</span>
      {": "}
      <span className="chat-content">{textContent}</span>
    </div>
  );
}
