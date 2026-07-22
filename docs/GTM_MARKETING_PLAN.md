# Pillowfort GTM and Marketing Plan

Date: 2026-05-02
Owner: GTM Engineering

## Thesis

Pillowfort should not go to market as another chat app. That category is dead on arrival.

The marketable wedge is:

> Disposable private game-night rooms with retro AIM / Windows XP energy. No accounts. Invite-only. Built to end.

The product is already strong enough to market around a ritual, not a feature list: set up a fort, share the flag and password, hang out, play, knock it down.

## Current Product Read

What exists now:

- Accountless room creation and joining.
- Invite-only rooms with room flag plus password.
- Browser-side encrypted chat payloads.
- No public room directory.
- No durable chat history for late joiners.
- AIM / Windows XP visual identity.
- Built-in small-group games: drawing, RPS, Tic-Tac-Toe, Secret Saboteur, King of the Hill, Pillow Fight vote-to-kick, Breakout-on-minimize.
- Fort Pass beta path for custom codes, 6-hour idle, and social skins.
- Cloudflare Worker + Durable Object production architecture.
- Privacy-safe analytics log events and weekly report script.
- Launch assets: screenshots, demo videos, Remotion video pipeline.
- Discord Activity prototype surface at `/activity` with pre-SDK detection.

What this means: the first GTM motion should be a tight beta launch aimed at friend groups and Discord-native small communities, followed by a Discord Activity push if activation data supports it.

## Positioning

Primary one-liner:

> Private retro game-night rooms you can open in seconds and knock down when you're done.

Short homepage/subtitle copy:

> Set up a tiny invite-only room, share the flag and password, chat, doodle, play games, then let it disappear.

What to avoid:

- “secure chat app” as the main pitch
- “community platform”
- “Discord replacement”
- “private Slack”
- “metaverse room”
- “encrypted messenger”

Those either overclaim, trigger a saturated category, or fight the product’s best behavior.

## ICP

### Primary ICP: friend-group hosts

People who already coordinate casual hangs in Discord, group chats, iMessage, WhatsApp, or Slack.

Use cases:

- low-stakes online game night
- long-distance friend hangout
- “we need somewhere weird/fun for 30 minutes”
- post-stream or after-party room
- nostalgia-driven group chat event

Buyer/user split:

- Host creates and shares the room.
- Guests join free and accountless.
- Host is the likely Fort Pass buyer.

### Secondary ICP: small creators and community organizers

Small streamers, Discord mods, indie game communities, newsletter communities, fandom groups.

Use cases:

- subscriber hangout
- launch-night afterparty
- community game break
- retro-themed event

Do not build enterprise/community admin features for them yet. Use them for higher-intent beta feedback and Fort Pass willingness-to-pay tests.

## Beachhead Channels

### 1. Discord communities

This is the best-fit channel because users already gather in groups. Start with standalone links posted into Discord servers, then graduate to the Activity.

Actions I can carry out:

- Add Discord-specific landing copy and `/activity` explainer.
- Build a “launch in Discord / share in Discord” CTA if platform setup allows it.
- Prepare server-owner outreach copy.
- Build a beta invite kit for Discord mods.
- Instrument source tags for Discord CTA clicks and Discord Activity detection.

### 2. Short-form product demos

Pillowfort is visual. The XP interface and games sell faster as clips than as prose.

Actions I can carry out:

- Use the existing Remotion/video pipeline to cut 3 launch clips:
  - 15s: “open a fort”
  - 30s: “private game night”
  - 45s: “Secret Saboteur / chaos room”
- Export vertical and landscape versions.
- Add a small press/social asset folder with screenshots, captions, and post copy.

### 3. Product Hunt / Hacker News / indie web

This is not the core channel, but it can create the first traffic spike and nostalgic early adopters.

Angle:

- “I built disposable AIM-style rooms for private game nights.”
- Technical credibility: Cloudflare Durable Objects, no accounts, no durable transcripts.
- Product hook: the room ends.

Actions I can carry out:

- Add Open Graph/Twitter card metadata.
- Add a proper launch landing section without adding onboarding friction.
- Draft launch post, PH tagline, maker comment, and FAQ.
- Add `robots.txt`, `sitemap.xml`, and share image assets.

### 4. Niche nostalgia communities

Retro UI and early internet aesthetics are a real distribution advantage.

Targets:

- indie web circles
- retro computing/XPAesthetic communities
- personal site communities
- small design/dev Twitter accounts

Action:

- Package the launch around “temporary AIM rooms for 2026,” not generic privacy software.

## Funnel

North-star beta metric:

- Activated rooms: room has at least one guest, first message, and one game start.

Current measurable funnel:

1. `room_created`
2. `invite_copied`
3. `guest_joined`
4. `first_message_sent`
5. `game_started`
6. `room_knocked_down`
7. Fort Pass checkout events
8. Discord Activity detection

Missing or worth adding:

- `home_cta_clicked` with source.
- `share_link_clicked` / `share_sheet_opened` if a native/share CTA is added.
- `landing_demo_played` if videos land on homepage.
- `fort_pass_panel_viewed` to separate passive exposure from checkout intent.
- `return_host` is not currently possible without user identity; for beta, approximate via aggregate recurring room creation, not individual tracking.

Do not add third-party analytics yet. The privacy-safe log model is a product advantage.

## Conversion Improvements I Can Ship

### Homepage / first impression

Problem: the current home screen is clean, but it behaves more like an app sign-on than a marketable landing page.

Ship:

- Add a compact landing strip below or beside the sign-on window:
  - “private room in 10 seconds”
  - “no accounts”
  - “built-in friend games”
  - “knock it down when done”
- Add a small “How it works” 3-step visual.
- Add a demo clip embed or GIF using existing video assets.
- Add a “Start a game night” CTA that still routes to the existing screen-name flow.

Rule: do not create an onboarding wall. The app should still let people create a room immediately.

### Invite flow

Problem: GTM dies if hosts create empty rooms and fail to invite.

Current app already has invite copy and activation nudge. Strengthen it:

- Make copied invite text more intentional:
  - “come to my pillowfort: [link]\npassword: [password]\nroom disappears when we’re done”
- Add source-specific share buttons where supported: copy, Discord, native share.
- Add “send this to 2-4 friends” microcopy in empty room nudge.

### First game start

Problem: a room that only chats is less differentiated.

Ship:

- Keep the current “Start RPS / Tic-Tac-Toe” nudge.
- Add a “Game night mode” path during setup that creates the room and highlights RPS/Saboteur immediately.
- Make Secret Saboteur the hero demo, not necessarily the first default in-product prompt.

### Fort Pass

Problem: paid beta is present, but should remain quiet until Stripe smoke test and support are clean.

Ship after paid smoke:

- Fort Pass landing copy: “Upgrade tonight’s fort.”
- One simple offer: $5 one-time room upgrade.
- Keep the offer host-only.
- Do not imply permanent ownership.
- Add post-checkout success copy that reinforces custom flag, 6-hour idle, themes.

## Launch Sequence

### Phase 0: GTM readiness, 1-2 days

Goal: make the product shareable without weakening the app.

I can carry out:

1. Add production-ready meta tags, OG image, and share description.
2. Add `robots.txt` and `sitemap.xml`.
3. Add a lightweight landing/how-it-works module to home.
4. Add demo clip or poster asset from existing Remotion outputs.
5. Improve invite text and empty-room nudge copy.
6. Add missing privacy-safe marketing analytics events.
7. Run `npm run typecheck`, `npm test`, `npm run build`.

Ship gate:

- Create/join/invite/chat/game still works.
- No chat content, passwords, room codes, or names are added to analytics.

### Phase 1: Closed beta, 1 week

Goal: prove activation with 20-50 real friend-group rooms.

Audience:

- founder/dev friends
- Discord server mods
- small creator communities
- retro/indie web people

Motion:

- Personally seed rooms with hosts, not just post a public URL.
- Ask hosts to run one actual hangout with 2-4 people.
- Review weekly funnel logs using `npm run metrics:report`.

Success threshold:

- 50%+ of created rooms copy invite.
- 35%+ get at least one guest.
- 25%+ reach first message.
- 15%+ start a game.

If guest joins are weak, fix invite clarity before adding features.
If game starts are weak but rooms have guests, improve game prompts.

### Phase 2: Public beta launch, 1 week

Goal: create a focused traffic spike and learn whether strangers understand the product.

Launch surfaces:

- Product Hunt
- Hacker News “Show HN”
- X/Twitter launch thread
- indie hackers / Discord communities
- short-form clips

Launch copy angle:

> I built Pillowfort: disposable AIM-style rooms for private game nights. No accounts, no public room list, no durable chat history. Set up, hang out, knock down.

Success threshold:

- Traffic creates meaningful room starts, not just likes.
- Guest join rate remains healthy.
- Support/privacy confusion is low.

### Phase 3: First revenue test, after public beta signal

Goal: validate host willingness to pay without breaking guest conversion.

Offer:

- Fort Pass: $5 one-time room upgrade.
- Custom flag, 6-hour idle, social skins.

Motion:

- Quietly expose it in setup after Stripe smoke passes.
- Promote it only to hosts who are already setting up rooms.
- Do not interrupt join flow.

Success threshold:

- Any organic purchases are meaningful at this stage.
- Checkout returns work.
- Refund/support volume is manageable.
- Free room creation does not drop.

### Phase 4: Discord Activity GTM

Goal: test the real distribution channel.

I can carry out once Discord app credentials exist:

1. Add `@discord/embedded-app-sdk`.
2. Implement `ready()`, auth/token exchange boundary, and context-backed room join.
3. Skip manual room code/password inside Discord context if the platform context is validated.
4. Add Activity-specific layout QA.
5. Create a Discord install/launch landing page.
6. Prepare Discord server outreach.

Success threshold:

- Two users join the same Activity without manual invite entry.
- Chat and at least RPS work inside Discord.
- Discord source rooms activate better than standalone web rooms.

## Marketing Assets To Produce

### Copy bank

Taglines:

- “Set up. Hang out. Knock down.”
- “Private retro game-night rooms.”
- “A tiny AIM-style room for tonight.”
- “No accounts. No lobby. No permanent room.”
- “You had to be there.”

Launch post:

> Pillowfort is a disposable private room for small online hangs. Pick a screen name, make a fort, share the flag and password, chat, doodle, play games, then knock it down. It has AIM/Windows XP energy, no accounts, no public room list, and no durable chat history for late joiners.

Fort Pass copy:

> Upgrade tonight’s fort: custom flag, 6-hour idle, social skins. Guests still join free.

Discord outreach DM:

> I’m testing Pillowfort — tiny private retro rooms for Discord friend groups. No accounts, just a room flag/password, built-in games, and the room disappears when you’re done. Looking for a few servers to run one real game-night test and tell me where it breaks.

### Visual/video assets

Use existing assets:

- `docs/screenshots/aim-home.png`
- `docs/screenshots/aim-chat-full.png`
- `docs/screenshots/fort-pass-premium-unlocked.png`
- `video/out/v16-marketing-intro.mp4`
- `video/out/v16-marketing-intro-vert.mp4`
- `demo-videos/pillowfort-demo.mp4`

Produce:

- OG share image.
- 3 short clips.
- Product Hunt gallery images.
- 1 “how it works” screenshot strip.

## Concrete Repo Work I Can Execute

Recommended first branch:

`gtm/beta-launch-readiness`

Tasks:

1. Add homepage marketing strip and how-it-works copy.
2. Add metadata in `client/index.html`.
3. Add OG image asset from current screenshots.
4. Add `robots.txt` and `sitemap.xml` to client public assets.
5. Improve invite-copy text in `client/src/screens/ChatScreen.tsx`.
6. Add privacy-safe analytics events for homepage CTA and demo interaction.
7. Update `docs/BETA_ANALYTICS.md` and `scripts/analytics_report.mjs` for new events.
8. Create `docs/LAUNCH_COPY.md` with post copy, Discord outreach, PH assets, FAQ.
9. Run typecheck, tests, and build.

Second branch:

`gtm/launch-video-pack`

Tasks:

1. Audit current Remotion outputs.
2. Render/verify landscape and vertical launch clips.
3. Add a launch asset manifest in `docs/LAUNCH_ASSETS.md`.
4. Add instructions for regenerating assets.

Third branch:

`gtm/discord-beta`

Tasks:

1. Add Discord landing/explainer copy.
2. Add source-tagged Discord CTA.
3. Add SDK integration once credentials exist.
4. Add Activity smoke test path.
5. Update Discord prototype docs with implementation status.

## My Recommendation

Do the standalone beta launch first, but write every asset as if Discord is the eventual home.

The mistake would be overbuilding “community” features before proving the room ritual. The sharper move is smaller: make one private room feel worth sharing tonight.

If the core room activation works, Discord becomes an accelerant. If activation does not work, Discord will only hide the problem under easier distribution.
