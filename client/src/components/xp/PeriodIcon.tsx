import { useId } from "react";
import type { ReactNode } from "react";

export type PeriodIconKind =
  | "people" | "invite" | "chat" | "pencil" | "games" | "lock"
  | "crown" | "smiley" | "rock" | "paper" | "scissors" | "leave"
  | "pillow" | "board" | "search" | "check" | "cross" | "breakout";

const BLUE = ["#e4f7ff", "#489adc", "#255282"] as const;
const GOLD = ["#fff5b0", "#e9ac28", "#936219"] as const;
const PAPER = ["#ffffff", "#cbddeb", "#526c89"] as const;
const GREEN = ["#e3f9bf", "#74af44", "#456c2c"] as const;
const RED = ["#ffdcd4", "#db6354", "#8a392d"] as const;
const PALETTES: Record<PeriodIconKind, readonly [string, string, string]> = {
  people: BLUE, invite: PAPER, chat: BLUE, pencil: GOLD, games: BLUE,
  lock: GOLD, crown: GOLD, smiley: GOLD, rock: PAPER, paper: PAPER,
  scissors: BLUE, leave: BLUE, pillow: PAPER, board: PAPER,
  search: BLUE, check: GREEN, cross: RED, breakout: BLUE,
};

/** Original, decorative toolbar illustrations; labels belong to the surrounding control. */
export function PeriodIcon({ kind, size = 20 }: { kind: PeriodIconKind; size?: number }) {
  const gradientId = useId();
  const [light, dark, outline] = PALETTES[kind];
  const shade = `url(#${gradientId})`;
  let artwork: ReactNode;

  switch (kind) {
    case "people":
      artwork = <>
        <path d="M13 11c4-2 8 1 8 5v3h-8" fill="#84b75c" stroke="#4b7236" />
        <circle cx="16.5" cy="6.5" r="3.5" fill="#d0eeb3" stroke="#4b7236" />
        <path d="M2.5 20v-3.5a6 6 0 0 1 12 0V20c-3 1.5-9 1.5-12 0Z" fill={shade} />
        <circle cx="8.5" cy="7" r="4" fill={shade} />
        <path d="M5 16c.5-2 1.5-2.5 3-2.5M6.5 5.5l1-.5" stroke="#fff" />
      </>;
      break;
    case "invite":
      artwork = <>
        <path d="m2.5 6 9.5-3 9.5 3v14h-19Z" fill="#efc970" stroke="#997133" />
        <path d="M5 3.5h14v14H5Z" fill={shade} />
        <path d="M8 7h8M8 10h6" stroke="#829eb7" />
        <path d="m2.5 8 9.5 6 9.5-6v12h-19Z" fill={shade} />
        <path d="m3 19 6.5-6M21 19l-6.5-6" stroke="#829eb7" />
      </>;
      break;
    case "chat":
      artwork = <>
        <path d="M3 3.5h18v13H10l-6 4v-4H3Z" fill={shade} />
        <path d="M6 7h12M6 10h10M6 13h7" stroke="#fff" />
      </>;
      break;
    case "pencil":
      artwork = <>
        <path d="m3 16-1 6 6-1L21 8l-5-5Z" fill={shade} />
        <path d="m16 3 2-2 5 5-2 2Z" fill="#efa9a3" stroke="#985d59" />
        <path d="m3 16 5 5-6 1Z" fill="#f9e7c6" />
        <path d="m2 22 1-3 2 2Z" fill="#465163" />
        <path d="M6 16 17 5" stroke="#fff4b5" />
        <path d="m14.5 4.5 5 5" stroke="#a77c29" />
      </>;
      break;
    case "games":
      artwork = <>
        <path d="M6 7h12c2 0 3 2 3.5 5l1 5c.5 3-2.5 4-4 2l-3-3h-7l-3 3c-1.5 2-4.5 1-4-2l1-5C3 9 4 7 6 7Z" fill={shade} />
        <path d="M12 7V4l3-2" fill="none" />
        <path d="M5 12h5M7.5 9.5v5" stroke="#284f7e" strokeWidth="2" />
        <circle cx="17" cy="10.5" r="1.5" fill="#ecb841" stroke="#986922" />
        <circle cx="19" cy="14" r="1.5" fill="#83bd65" stroke="#477536" />
        <path d="M4.5 9c.5-.5 1-.5 2-.5" stroke="#fff" />
      </>;
      break;
    case "lock":
      artwork = <>
        <path d="M6 11V7a6 6 0 0 1 12 0v4h-3V7a3 3 0 0 0-6 0v4Z" fill="#dce7ee" stroke="#62778b" />
        <rect x="3.5" y="10" width="17" height="12" rx="2" fill={shade} />
        <path d="M6 12h12" stroke="#fff8cc" />
        <path d="M13.5 15a1.5 1.5 0 1 0-3 0c0 .6.3 1 .7 1.3l-.7 2.7h3l-.7-2.7c.4-.3.7-.7.7-1.3Z" fill="#805c24" stroke="none" />
      </>;
      break;
    case "crown":
      artwork = <>
        <path d="M4 18 2 6l6 5 4-8 4 8 6-5-2 12Z" fill={shade} />
        <rect x="4" y="18" width="16" height="3" rx="1" fill={shade} />
        <path d="m5 10 1 5h12" fill="none" stroke="#fff4b1" />
        <path d="m12 12 2 2-2 2-2-2Z" fill="#4a91c5" stroke="#31587d" />
      </>;
      break;
    case "smiley":
      artwork = <>
        <circle cx="12" cy="12" r="10" fill={shade} />
        <path d="M5 8c1-2 3-3 5-3" fill="none" stroke="#fffbd7" strokeWidth="2" />
        <path d="M8.5 8v2M15.5 8v2" stroke="#775122" strokeWidth="2" />
        <path d="M7 14c2 5 8 5 10 0" fill="#fff6dd" stroke="#775122" />
      </>;
      break;
    case "rock":
      artwork = <>
        <path d="m2 15 3-8 7-4 7 3 3 10-6 5H7Z" fill={shade} />
        <path d="m5 7 6 3 8-4M11 10l-2 7 7 4M9 17l-7-2M11 10l6 5 5 1" fill="none" stroke="#8699aa" />
        <path d="m6 8 5-3 6 2" fill="none" stroke="#fff" />
      </>;
      break;
    case "paper":
      artwork = <>
        <path d="M5 2h10l5 5v15H5Z" fill={shade} />
        <path d="M15 2v5h5" fill="#b9cfe0" />
        <path d="M8 11h9M8 14h9M8 17h7" stroke="#819db6" />
      </>;
      break;
    case "scissors":
      artwork = <>
        <path d="m8 15 9-13c2 5-3 12-6 15M15 15 4 3c0 6 4 11 8 14" fill="#dce6ee" stroke="#667d91" />
        <path d="M8 15c-5-4-10 2-5 6 4 3 8-2 5-6ZM15 15c5-4 10 2 5 6-4 3-8-2-5-6Z" fill={shade} />
        <path d="M6.5 17c-2-2-4 .5-2 2s4-.5 2-2ZM16.5 17c2-2 4 .5 2 2s-4-.5-2-2Z" fill="#f9fbfc" />
        <circle cx="11.5" cy="13.5" r="1.3" fill="#f8fafc" />
      </>;
      break;
    case "leave":
      artwork = <>
        <path d="M3 21V3h12v18Z" fill={shade} />
        <path d="m3 3 8 3v15l-8 2Z" fill="#edf5fb" />
        <circle cx="8" cy="13" r=".8" fill="#587a9b" stroke="none" />
        <path d="M13 10h5V7l5 5-5 5v-3h-5Z" fill="#dfad44" stroke="#927031" />
      </>;
      break;
    case "pillow":
      artwork = <>
        <path d="M2 4c4 1 6-1 10-1s6 2 10 1c-1 4-1 5-1 8s0 4 1 8c-4-1-6 1-10 1S6 19 2 20c1-4 1-5 1-8s0-4-1-8Z" fill={shade} />
        <path d="M5 7c5-1 9-1 14 0M5 7l2 2M19 7l-2 2M5 17l2-2M19 17l-2-2" fill="none" stroke="#94aec5" />
        <path d="M7 6c3-.5 7-.5 10 0" fill="none" stroke="#fff" />
      </>;
      break;
    case "board":
      artwork = <>
        <rect x="2" y="2" width="20" height="20" rx="2" fill={shade} />
        <path d="M8.5 4v16M15.5 4v16M4 8.5h16M4 15.5h16" stroke="#8fa7bc" />
        <path d="m4.5 4.5 2 2m0-2-2 2M10.5 10.5l3 3m0-3-3 3" stroke="#4378a4" strokeWidth="1.5" />
        <circle cx="18.5" cy="5.5" r="1.5" fill="none" stroke="#b4772d" />
        <circle cx="5.5" cy="18.5" r="1.5" fill="none" stroke="#b4772d" />
      </>;
      break;
    case "search":
      artwork = <>
        <path d="m14 14 8 7-2 2-7-8Z" fill="#be965b" stroke="#78552e" />
        <circle cx="9" cy="9" r="7" fill={shade} />
        <path d="M5 8c0-2 1-3 3-3" fill="none" stroke="#fff" strokeWidth="2" />
      </>;
      break;
    case "check":
      artwork = <path d="m2 12 4-4 5 5L19 3l4 3-12 15Z" fill={shade} />;
      break;
    case "cross":
      artwork = <path d="m5 2 7 7 7-7 3 3-7 7 7 7-3 3-7-7-7 7-3-3 7-7-7-7Z" fill={shade} />;
      break;
    case "breakout":
      artwork = <>
        <path d="M2 3h6v4H2ZM9 3h6v4H9ZM16 3h6v4h-6ZM2 8h6v4H2ZM9 8h6v4H9Z" fill={shade} />
        <path d="m16 14 3-4" stroke="#97aabc" strokeDasharray="1 2" />
        <circle cx="14.5" cy="16" r="2" fill="#f9d165" stroke="#9d7430" />
        <rect x="8" y="20" width="12" height="3" rx="1" fill={shade} />
      </>;
      break;
  }

  return (
    <svg
      className="period-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={outline}
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor={light} />
          <stop offset="1" stopColor={dark} />
        </linearGradient>
      </defs>
      {artwork}
    </svg>
  );
}
