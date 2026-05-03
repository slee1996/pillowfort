# Early-00s IM UI References

This pass keeps Pillowfort in the desktop instant-messenger lane: dense, practical, small controls, visible presence, and skinnable room chrome.

## Primary References

- AOL Instant Messenger: grouped Buddy Lists, away messages as identity, bottom text entry, Save Chat, Buddy Chat, file/send affordances, smiley picker, and chat windows that keep the conversation text sacred.
  - Source: https://computer.howstuffworks.com/e-mail-messaging/aol-instant-messenger.htm
- AIM 5.0 Expressions: downloadable themes applied to Buddy List and chat windows, with a narrow visual treatment around the main communication surface.
  - Source: https://www.internetnews.com/marketing/aim-5-0-to-feature-themes-bigger-ads/
- MSN Messenger 4.6: XP-era chrome, grouped contacts, interface refresh around contact organization, and compact conversation windows.
  - Source: https://en.wikipedia.org/wiki/MSN_Messenger
- Yahoo! Messenger IMVironments: chat-window personalization, themed environments, custom status messages, typing/status feedback, and richer emoticon culture.
  - Source: https://en.wikipedia.org/wiki/Yahoo_Messenger
- ICQ, mIRC, Trillian, and Winamp: compact status-first interfaces, small icon strips, skinnable surfaces, and dense utility controls.

## Design Rules

- Keep the chat log calm. Theme the frame, toolbar, status strip, and side panels more aggressively than the message text itself.
- Make presence visible at all times: available/away counts, grouped buddies, away text, and host identity should be scannable without opening a modal.
- Use menu bars and toolbar gutters like software, not marketing UI. Small icons, separators, checkmarks, and disabled paid options are part of the charm.
- Premium themes should feel like AIM/Yahoo-era room skins: same layout, different chrome, subtle background texture, no layout surprises.
- Prefer compact, repeat-use controls over large cards. The app should feel like something you leave open on the side of the desktop.

## Implemented In This Pass

- Added an AIM-style profile card to the Buddy panel with current user, role, status, and copyable fort flag.
- Split buddies into `Inside` and `Away` groups, including away-message snippets.
- Added a bottom status strip for available count, away count, active theme, encryption state, and Fort Pass state.
- Reworked menu dropdowns with a left icon/check gutter, theme swatches, and locked Fort Pass theme rows for free rooms.
- Added a tighter toolbar treatment for top actions and game shortcuts.
- Expanded the smiley picker from 8 to 16 entries.
- Strengthened Classic, Retro Green, and Midnight theme treatments while keeping message text readable.

## Fresh Screenshots

- `docs/screenshots/early-00s-chat-classic.png`
- `docs/screenshots/early-00s-theme-classic.png`
- `docs/screenshots/early-00s-theme-retro-green.png`
- `docs/screenshots/early-00s-theme-midnight.png`
