# Early-00s IM UI References

The historical exploration below is not a literal UI specification. The current direction in [PROJECT_LEAD_BRIEF.md](PROJECT_LEAD_BRIEF.md) applies the verified AIM 4.x comps to a focused, private fort: a room-scoped buddy roster, separate transcript/editor panes, and explicit People, Invite, Room, and Play controls—not ads, global buddy graphs, or stacked utility menus.

## Verified Screenshot Comps

- [AIM reference board](design-comps/aim/aim-reference-board.png): six labeled Buddy List, conversation, away-state, and sign-on comps.
- [Messenger contrast board](design-comps/aim/messenger-contrast-board.png): MSN 6, ICQ 2000a, and two later AIM iPhone screens.
- [Browsable source gallery](design-comps/aim/index.html): all 11 originals, source links, version evidence, and caveats.
- [Machine-readable provenance](design-comps/aim/sources.json): original/resolved URLs, dimensions, file hashes, and the one explicitly labeled crop.

The strongest baseline is the [archived first-party AIM 4.7 page](https://web.archive.org/web/20020119232831/http://aim.aol.com/) and its original screenshot assets. The [AIM 4.8 away-message tutorial](https://web.archive.org/web/20030410070015/http://www.awaymessages.com/guide/aim1.htm) and its archived editor image provide another period-confirmed reference. The sign-on and customized conversation images from [Defragg](https://defragg.com/history-of-aim-aol-instant-messenger/) are explicitly labeled secondary: the sign-on visibly identifies version 3.0.1464, but their original capture dates are unverified.

### What the screenshots establish

- The period AIM 4.7/4.8 examples use gray controls and white transcript/editor areas. A uniformly cream interface is an interpretation, not a universal AIM default.
- Blue title bars and bevels are shared Windows conventions. Grouped Buddy Lists, away-note markers, running-man/buddy branding, colored screen names, and personal expression are more AIM-specific.
- The IM window separates transcript and composition, with formatting between them; it is not just a recolored single-line modern chat composer.
- The first-party preferences screenshot explicitly shows a configurable Buddy List font set to Arial, size 9. Do not assume one universal Tahoma treatment across all AIM surfaces.
- The secondary customized screenshot is useful for buddy-icon/personality layering, not for establishing the default client skin.
- [AIM for iPhone in 2010](https://www.webdesignmuseum.org/iphone/aim-for-iphone-in-2010) preserves buddy identity/groups while using mobile-native chrome. It is a later translation comp, not a desktop-era baseline.

For Pillowfort, the next design decision should select an explicit AIM-era baseline and adapt room-scoped presence, personal identity, and conversation rhythm. Do not inherit ads, global account graphs, or outdated security. No application code or styling changed in this research pass.

These are reference-only images of proprietary software, not cleared product artwork. Archive capture dates are not software release dates; all uncertainties and the Flickr uploader attribution are retained in the source catalog.

## Applied Direction

The approved application uses A01–A03 as the baseline: white transcript/editing areas, gray controls, and a restrained navy cap. A narrow desktop roster and compact mobile presence strip expose actual room membership and user-set Available/Away state; host identity is preserved across those groups.

The composer is a real multiline editor with its formatting band above it and Play/Send actions below. Enter sends once, Shift+Enter inserts a newline, and IME composition does not submit. The shorter generated passwords, accountless entry, encrypted room events, host approval, and exit confirmations remain unchanged.

The screenshots remain reference material only. The implementation uses Pillowfort-owned branding and existing personalization; no AOL screenshots or mascot assets were imported into the product.

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
