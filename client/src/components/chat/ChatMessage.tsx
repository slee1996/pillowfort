import type { ChatMessage as ChatMsg } from "../../../../src/participant/protocol";
import { nameColor } from "../../utils/nameColor";
import { findMentions } from "../../../../src/participant/mentions";
import { useGameStore } from "../../stores/gameStore";

export function ChatMessage({ msg }: { msg: ChatMsg }) {
  const name = useGameStore((state) => state.name);
  if (msg.kind === "system") {
    return (
      <div className="chat-message chat-message-system">
        <span className="chat-system-text">{msg.text}</span>
      </div>
    );
  }

  const style = msg.style;
  const mentions = findMentions(msg.text, msg.mentions ?? []);
  const content: React.ReactNode[] = [];
  let offset = 0;
  for (const mention of mentions) {
    content.push(msg.text.slice(offset, mention.start));
    content.push(<mark className="chat-mention" key={mention.start}>{msg.text.slice(mention.start, mention.end)}</mark>);
    offset = mention.end;
  }
  content.push(msg.text.slice(offset));
  const addressed = msg.from?.normalize("NFC") !== name.normalize("NFC")
    && msg.mentions?.includes(name.normalize("NFC"));
  let textContent: React.ReactNode = <span>{content}</span>;

  if (style) {
    if (style.color) {
      textContent = <span style={{ color: style.color }}>{content}</span>;
    }
    if (style.bold) textContent = <b>{textContent}</b>;
    if (style.italic) textContent = <i>{textContent}</i>;
    if (style.underline) textContent = <u>{textContent}</u>;
  }

  return (
    <div className={`chat-message${addressed ? " chat-message-mentioned" : ""}`} data-message-id={msg.id}>
      {addressed && <span className="chat-mentioned-label">Mentioned you · </span>}
      <span className="chat-message-meta">
        <span className="chat-sender" style={{ color: nameColor(msg.from!) }}>
          {msg.from}
        </span>
        <time className="chat-timestamp"> ({msg.timestamp})</time>
      </span>
      {": "}
      <span className="chat-content">{textContent}</span>
    </div>
  );
}
