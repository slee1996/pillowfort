import type { ChatMessage as ChatMsg } from "../../services/protocol";
import { nameColor } from "../../utils/nameColor";

export function ChatMessage({ msg }: { msg: ChatMsg }) {
  if (msg.kind === "system") {
    return (
      <div className="mb-0.5 break-words">
        <span className="font-bold text-[#999]">pillowtalk</span>
        <span className="text-[#888] text-xs italic">: {msg.text}</span>
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
    <div className="mb-0.5 break-words font-[Arial,Helvetica,sans-serif] text-[13px] leading-[1.45]">
      <span className="font-bold" style={{ color: nameColor(msg.from!) }}>
        {msg.from}
      </span>
      <span className="text-[#888] text-[11px]"> ({msg.timestamp})</span>
      {": "}
      <span className="text-[13px]">{textContent}</span>
    </div>
  );
}
