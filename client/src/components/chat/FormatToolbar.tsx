import { useState, useRef, useEffect } from "react";
import { useFormatStore } from "../../stores/formatStore";
import { PeriodIcon } from "../xp/PeriodIcon";

const FMT_COLORS = ["#FF0000", "#0000FF", "#008000", "#FF8C00", "#800080", "#000000", "#FF69B4", "#8B4513"];
const EMOJIS = [
  "😊", "😂", "😉", "😍",
  "😎", "😛", "😢", "😡",
  "😳", "🤔", "👍", "👋",
  "🎉", "🔥", "❤️", "💤",
];

export function FormatToolbar({ onInsertEmoji }: { onInsertEmoji: (emoji: string) => void }) {
  const { bold, italic, underline, color, toggleBold, toggleItalic, toggleUnderline, setColor } = useFormatStore();
  const [colorOpen, setColorOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handler = () => {
      setColorOpen(false);
      setEmojiOpen(false);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  return (
    <div
      className="format-toolbar"
      role="group"
      aria-label="Message formatting"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || (!colorOpen && !emojiOpen)) return;
        event.preventDefault();
        event.stopPropagation();
        (colorOpen ? colorButtonRef : emojiButtonRef).current?.focus();
        setColorOpen(false);
        setEmojiOpen(false);
      }}
    >
      <button
        type="button"
        id="fmt-bold"
        className={`format-btn ${bold ? "active" : ""}`}
        onClick={toggleBold}
        title="Bold"
        aria-label="Bold"
        aria-pressed={bold}
      >
        <b>B</b>
      </button>
      <button
        type="button"
        id="fmt-italic"
        className={`format-btn ${italic ? "active" : ""}`}
        onClick={toggleItalic}
        title="Italic"
        aria-label="Italic"
        aria-pressed={italic}
      >
        <i>I</i>
      </button>
      <button
        type="button"
        id="fmt-underline"
        className={`format-btn ${underline ? "active" : ""}`}
        onClick={toggleUnderline}
        title="Underline"
        aria-label="Underline"
        aria-pressed={underline}
      >
        <u>U</u>
      </button>

      <div className="format-sep" aria-hidden="true" />

      <div className="format-popover-anchor">
        <button
          type="button"
          ref={colorButtonRef}
          className="format-btn"
          title="Font Color"
          aria-label="Font color"
          aria-expanded={colorOpen}
          aria-controls="format-colors"
          onClick={(event) => {
            event.stopPropagation();
            setEmojiOpen(false);
            setColorOpen(!colorOpen);
          }}
        >
          <span
            className="format-color-preview"
            style={{ background: color || "#FF0000" }}
            aria-hidden="true"
          />
        </button>
        <div id="format-colors" className={`color-palette ${colorOpen ? "open" : ""}`} hidden={!colorOpen}>
          {FMT_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className="color-palette-swatch"
              style={{ background: c }}
              aria-label={`Text color ${c}`}
              aria-pressed={color === c}
              onClick={(event) => {
                event.stopPropagation();
                setColor(color === c ? null : c);
                setColorOpen(false);
                colorButtonRef.current?.focus();
              }}
            />
          ))}
        </div>
      </div>

      <div className="format-sep" aria-hidden="true" />

      <div className="format-popover-anchor">
        <button
          type="button"
          ref={emojiButtonRef}
          className="format-btn format-btn-emoji"
          title="Insert Smiley"
          aria-label="Insert smiley"
          aria-expanded={emojiOpen}
          aria-controls="format-emojis"
          onClick={(event) => {
            event.stopPropagation();
            setColorOpen(false);
            setEmojiOpen(!emojiOpen);
          }}
        >
          <PeriodIcon kind="smiley" />
        </button>
        <div id="format-emojis" className={`emoji-picker ${emojiOpen ? "open" : ""}`} hidden={!emojiOpen}>
          {EMOJIS.map((em) => (
            <button
              type="button"
              key={em}
              className="emoji-pick"
              aria-label={`Insert ${em}`}
              onClick={(event) => {
                event.stopPropagation();
                onInsertEmoji(em);
                setEmojiOpen(false);
              }}
            >
              {em}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
