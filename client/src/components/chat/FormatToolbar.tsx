import { useState, useRef, useEffect } from "react";
import { useFormatStore } from "../../stores/formatStore";
import { useGameStore } from "../../stores/gameStore";

const FMT_COLORS = ["#FF0000", "#0000FF", "#008000", "#FF8C00", "#800080", "#000000", "#FF69B4", "#8B4513"];
const EMOJIS = ["😊", "😂", "😍", "👍", "👋", "🎉", "🔥", "❤️"];

export function FormatToolbar({ onInsertEmoji }: { onInsertEmoji: (emoji: string) => void }) {
  const { bold, italic, underline, color, toggleBold, toggleItalic, toggleUnderline, setColor } = useFormatStore();
  const members = useGameStore((s) => s.members);
  const [colorOpen, setColorOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const colorRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => {
      setColorOpen(false);
      setEmojiOpen(false);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  const handleShowPeople = () => {
    if (window.innerWidth <= 600) {
      window.dispatchEvent(new CustomEvent("pf-show-mobile-buddies"));
    } else {
      window.dispatchEvent(new CustomEvent("pf-toggle-buddy-panel"));
    }
  };

  const handleShowInvites = () => {
    window.dispatchEvent(new CustomEvent("pf-show-mobile-invites"));
  };

  return (
    <div className="format-toolbar">
      <button
        id="fmt-bold"
        className={`format-btn ${bold ? "active" : ""}`}
        onClick={toggleBold}
        title="Bold"
      >
        <b>B</b>
      </button>
      <button
        id="fmt-italic"
        className={`format-btn ${italic ? "active" : ""}`}
        onClick={toggleItalic}
        title="Italic"
      >
        <i>I</i>
      </button>
      <button
        id="fmt-underline"
        className={`format-btn ${underline ? "active" : ""}`}
        onClick={toggleUnderline}
        title="Underline"
      >
        <u>U</u>
      </button>

      <div className="format-sep" />

      <div className="format-popover-anchor" ref={colorRef}>
        <button
          className="format-btn"
          title="Font Color"
          onClick={(e) => {
            e.stopPropagation();
            setEmojiOpen(false);
            setColorOpen(!colorOpen);
          }}
        >
          <div
            className="format-color-preview"
            style={{ background: color || "#FF0000" }}
          />
        </button>
        <div className={`color-palette ${colorOpen ? "open" : ""}`}>
          {FMT_COLORS.map((c) => (
            <div
              key={c}
              className="color-palette-swatch"
              style={{ background: c }}
              onClick={(e) => {
                e.stopPropagation();
                setColor(color === c ? null : c);
                setColorOpen(false);
              }}
            />
          ))}
        </div>
      </div>

      <div className="format-sep" />

      <div className="format-popover-anchor" ref={emojiRef}>
        <button
          className="format-btn format-btn-emoji"
          title="Insert Smiley"
          onClick={(e) => {
            e.stopPropagation();
            setColorOpen(false);
            setEmojiOpen(!emojiOpen);
          }}
        >
          ☺
        </button>
        <div className={`emoji-picker ${emojiOpen ? "open" : ""}`}>
          {EMOJIS.map((em) => (
            <span
              key={em}
              className="emoji-pick"
              onClick={(e) => {
                e.stopPropagation();
                onInsertEmoji(em);
                setEmojiOpen(false);
              }}
            >
              {em}
            </span>
          ))}
        </div>
      </div>
      <span id="member-count" className="format-member-count">{members.length} inside</span>
      <div className="format-mobile-actions">
        <button className="format-mobile-action" onClick={handleShowPeople}>People</button>
        <button className="format-mobile-action" onClick={handleShowInvites}>Invites</button>
      </div>
    </div>
  );
}
