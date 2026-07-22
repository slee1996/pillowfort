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

## Social Skin References

- Away Message: AIM 4.7/Buddy List references for grouped buddy lists, status icons, and away-message identity.
  - Sources: https://en.wikipedia.org/wiki/AIM_%28software%29 and https://computer.howstuffworks.com/e-mail-messaging/aol-instant-messenger.htm
- Campus Blue: Thefacebook-era references for a utilitarian blue masthead, white content, gray module borders, and compact academic-directory density.
  - Source: https://www.webdesignmuseum.org/gallery/facebook-2004
- Top 8: classic MySpace profile references for blue/orange module chrome and Top 8 friends as a two-row public friend display.
  - Sources: https://layouts.spacehey.com/layout?id=23729 and https://www.speedace.info/music/myspace.htm

## Design Rules

- Keep the chat log calm. Theme the frame, toolbar, status strip, and side panels more aggressively than the message text itself.
- Make presence visible at all times: available/away counts, grouped buddies, away text, and host identity should be scannable without opening a modal.
- Use menu bars and toolbar gutters like software, not marketing UI. Small icons, separators, checkmarks, and disabled paid options are part of the charm.
- Premium skins should feel like early social-web room chrome: same layout, different modules, borders, status treatment, and buddy-list behavior.
- Prefer compact, repeat-use controls over large cards. The app should feel like something you leave open on the side of the desktop.

## Implemented In This Pass

- Added an AIM-style profile card to the Buddy panel with current user, role, status, and copyable fort flag.
- Split buddies into `Inside` and `Away` groups, including away-message snippets.
- Added a bottom status strip for available count, away count, active skin, encryption state, and Fort Pass state.
- Reworked menu dropdowns with a left icon/check gutter, theme swatches, and locked Fort Pass theme rows for free rooms.
- Added a tighter toolbar treatment for top actions and game shortcuts.
- Expanded the smiley picker from 8 to 16 entries.
- Reworked the theme set into social skins: Away Message as the default, with Campus Blue and Top 8 as Fort Pass skins.
- Deepened Away Message with yellow status-note treatments, away-member emphasis, ruled chat paper, and warmer AIM-era utility chrome.
- Deepened Campus Blue with a flat blue masthead, gray module borders, white feed rows, square buttons, and Facebook-like sidebar modules.
- Deepened Top 8 with MySpace blue/orange modules, a friend-grid buddy list, profile-box chrome, and orange-accented status/game surfaces.

## Screenshot Status

The social skin screenshots should be refreshed after the next visual QA pass.
