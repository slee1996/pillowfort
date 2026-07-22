# Pillowfort GTM Execution Plan

Date: 2026-05-02
Owner: GTM Engineering
Related: `docs/GTM_MARKETING_PLAN.md`

## Goal

Turn Pillowfort from a working product into something people can understand, share, and try in one sitting.

The plan is intentionally repo-executable: every step maps to concrete files, assets, copy, commands, or outreach artifacts I can produce from this codebase.

## Core GTM Thesis

Do not market Pillowfort as a chat app.

Market it as:

> Disposable private game-night rooms with retro AIM / Windows XP energy. No accounts. Invite-only. Built to end.

The product ritual is the hook:

1. Set up a fort.
2. Share the flag and password.
3. Hang out, chat, doodle, play.
4. Knock it down when done.

## Workstream 1: Brand and Visual System

### Objective

Make Pillowfort recognizable in one glance: small, private, retro, soft, temporary, playful.

### Current state

The app already has a small SVG `LogoIcon` at:

- `client/src/components/xp/Logo.tsx`

Current icon reads more like a generic XP/AIM running figure than a pillowfort-specific mark. It works as a placeholder, but it is not enough for launch assets, OG cards, Product Hunt, or Discord install surfaces.

### Logo direction

I would not use a generic AI-generated image as the actual logo. It will look cheap and be hard to reproduce.

I would create the real logo as a hand-authored SVG, likely with this shape:

- a tiny blanket/pillow fort silhouette
- pixel/XP-era geometry
- a small flag on top
- warm yellow window/light shape inside
- simple enough to work at 16px in the title bar
- expandable into larger launch art

Logo concept:

> A little pillow/blanket tent with a flag, rendered like an early-2000s desktop icon.

### Tools I would use

Primary logo production:

- Hand-authored SVG in code.
- Existing React component: `client/src/components/xp/Logo.tsx`.
- Browser QA at small sizes: 16px, 32px, 72px, 512px.
- Optional script-generated PNG exports from SVG for OG/favicon/app icons.

Optional exploration only:

- `image_generate` for moodboards or rough visual ideas.
- Not for final production logo.

Why: final logo needs to be deterministic, inspectable, versionable, and crisp in the UI. SVG wins.

### Files to touch

- Modify: `client/src/components/xp/Logo.tsx`
- Add: `client/public/icon.svg`
- Add: `client/public/apple-touch-icon.png` or generated equivalent
- Add: `client/public/og-image.png`
- Possibly modify: `client/index.html`

### Acceptance criteria

- Logo is legible at 16px in the XP title bar.
- Logo feels like Pillowfort, not generic chat.
- SVG has no external dependencies.
- OG image renders cleanly in 1200x630.
- Existing visual language remains intact.

## Workstream 2: Launch Landing Surface

### Objective

Keep the app fast, but give strangers enough context to understand why they should start a room.

### Current state

`HomeScreen.tsx` is an app sign-on screen. It has a nice trust strip:

- invite-only
- no accounts
- temporary rooms

But it does not yet function as a launch landing page.

### What to ship

Add a compact marketing panel, not a separate bloated website.

Copy:

- “Private retro game-night rooms.”
- “Open a tiny invite-only room, share the flag and password, play, then knock it down.”
- Three-step strip:
  1. Pick a screen name.
  2. Share the fort flag.
  3. Play and disappear.

CTA stays the existing flow:

- Primary: Start Hangout
- Secondary: Join Fort

No modal. No onboarding wall. No account bait.

### Files to touch

- Modify: `client/src/screens/HomeScreen.tsx`
- Modify: `client/src/styles/xp-theme.css`
- Possibly add: `client/src/components/marketing/HomeMarketingPanel.tsx`

### Acceptance criteria

- First-time visitor understands the product in under 5 seconds.
- Existing create/join flow remains one click away.
- Mobile layout stays clean.
- No privacy overclaim.

## Workstream 3: Share Metadata and SEO Basics

### Objective

Make Pillowfort look intentional when pasted into Discord, iMessage, X, Slack, Product Hunt, and HN.

### Current state

`client/index.html` has a title and basic mobile meta tags, but no real social metadata.

### What to ship

Add:

- title
- description
- Open Graph title/description/image
- Twitter card metadata
- canonical URL if production URL is known
- theme color aligned with XP blue
- favicon/icon references
- `robots.txt`
- `sitemap.xml`

### Files to touch

- Modify: `client/index.html`
- Add: `client/public/robots.txt`
- Add: `client/public/sitemap.xml`
- Add: `client/public/og-image.png`
- Add: `client/public/icon.svg`

### Acceptance criteria

- Link unfurls with correct image/title/description.
- Metadata does not mention “secure” as the main claim.
- Description matches product thesis.

## Workstream 4: Invite Conversion

### Objective

Increase the chance that a host’s room gets at least one guest.

If rooms stay empty, GTM fails.

### Current state

`ChatScreen.tsx` can copy room code or invite text. Empty rooms show a nudge to copy the invite.

### What to ship

Improve copied invite text:

```text
come to my pillowfort: [link]
password: [password]
room disappears when we’re done
```

If no password is available:

```text
come to my pillowfort: [link]
```

Improve empty-room nudge copy:

- “Send this to 2-4 friends.”
- “The room goes quiet if nobody joins.”

Potential later addition:

- `navigator.share()` on mobile.
- Discord deep/share CTA if appropriate.

### Files to touch

- Modify: `client/src/screens/ChatScreen.tsx`
- Modify: `client/src/styles/xp-theme.css`
- Update tests if copy assertions exist.

### Acceptance criteria

- Invite text is clear when pasted into Discord/iMessage/Slack.
- Password remains included only from the host/browser state.
- Analytics still does not log raw room code or password.

## Workstream 5: Marketing Analytics

### Objective

Measure the GTM funnel without betraying the product’s privacy promise.

### Current state

Analytics events are sanitized and same-origin. Existing events cover core beta funnel:

- `room_created`
- `invite_copied`
- `guest_joined`
- `first_message_sent`
- `game_started`
- `room_knocked_down`
- Fort Pass events
- Discord Activity detection

### What to add

Useful GTM events:

- `home_cta_clicked`
- `landing_demo_played`
- `share_sheet_opened`
- `fort_pass_panel_viewed`

Properties remain restricted:

- `source`
- `role`
- `kind`
- `mobile`
- `memberCount`

Do not add:

- room codes
- passwords
- screen names
- message text
- persistent user IDs

### Files to touch

- Modify: `client/src/services/analytics.ts`
- Modify: `src/analytics.ts`
- Modify: `docs/BETA_ANALYTICS.md`
- Modify: `scripts/analytics_report.mjs`
- Update tests in `test/` if analytics contract is covered.

### Acceptance criteria

- Unknown events are rejected.
- New events are sanitized both client and server side.
- Metrics report includes launch funnel counts.
- No sensitive properties survive sanitization.

## Workstream 6: Launch Copy and Outreach Pack

### Objective

Create the actual words used for launch, outreach, Product Hunt, HN, X/Twitter, and Discord mods.

### What to produce

Create `docs/LAUNCH_COPY.md` with:

- one-liner
- short description
- long description
- Product Hunt tagline
- Product Hunt maker comment
- Show HN post
- X/Twitter launch thread
- Discord mod DM
- FAQ
- privacy note
- Fort Pass note

### Initial copy direction

One-liner:

> Private retro game-night rooms you can open in seconds and knock down when you're done.

Short launch copy:

> Pillowfort is a disposable private room for small online hangs. Pick a screen name, make a fort, share the flag and password, chat, doodle, play games, then knock it down. AIM/Windows XP energy, no accounts, no public room list, and no durable chat history for late joiners.

### Files to touch

- Add: `docs/LAUNCH_COPY.md`
- Possibly add: `docs/LAUNCH_FAQ.md`

### Acceptance criteria

- Copy is concrete and non-corporate.
- Claims match actual product behavior.
- There is a ready-to-post version for each channel.

## Workstream 7: Launch Asset Pack

### Objective

Prepare visual assets for launch surfaces.

### Current assets

Screenshots:

- `docs/screenshots/aim-home.png`
- `docs/screenshots/aim-chat-full.png`
- `docs/screenshots/fort-pass-premium-unlocked.png`
- theme screenshots in `docs/screenshots/`

Videos:

- `demo-videos/pillowfort-demo.mp4`
- `video/out/v16-marketing-intro.mp4`
- `video/out/v16-marketing-intro-vert.mp4`

### What to produce

- OG image: 1200x630
- Product Hunt gallery images
- 15s vertical short
- 30s landscape demo
- 45s game-night demo
- asset manifest describing where each file is used

### Tools I would use

- Existing Remotion pipeline in `video/` for motion assets.
- Playwright/design snapshots for fresh screenshots if needed.
- SVG/HTML composition for OG image, then render to PNG.
- `ffmpeg` only for format conversion/trimming if needed.

### Files to touch

- Add: `docs/LAUNCH_ASSETS.md`
- Add or update assets under `client/public/`
- Possibly update files under `video/src/` for new renders

### Acceptance criteria

- Every launch channel has the correct size asset.
- Assets are reproducible or documented.
- No private room/password data appears in screenshots.

## Workstream 8: Fort Pass Revenue Readiness

### Objective

Prepare the first monetization push without damaging the free invite loop.

### Current state

Fort Pass exists as a quiet beta path:

- custom code
- 6-hour idle
- premium themes
- Stripe checkout boundary
- webhook fulfillment
- support/refund runbook

### What to ship before promotion

- Confirm production Stripe smoke test.
- Confirm `/api/fort-pass/status` returns configured state in production.
- Add clearer Fort Pass marketing copy after smoke passes.
- Add `fort_pass_panel_viewed` analytics.
- Keep checkout disabled when not configured.

### Files to touch

- Modify: `client/src/screens/SetupScreen.tsx`
- Modify: `docs/FIRST_PAID_SKU.md` if pricing/copy changes
- Update: `docs/FORT_PASS_SUPPORT_RUNBOOK.md` only if support process changes

### Acceptance criteria

- Guests never see a paywall.
- Free room creation remains obvious.
- Paid copy does not imply permanence.
- Refund/support path is documented.

## Workstream 9: Discord GTM Path

### Objective

Prepare the product for its most natural distribution channel.

### Current state

There is a Discord Activity pre-SDK slice:

- `/activity` surface
- frame header handling
- Activity context detection
- deterministic `dc-......` room flag

### What to plan next

Once credentials exist:

- add `@discord/embedded-app-sdk`
- call `ready()`
- implement authorize/authenticate flow
- add token exchange endpoint
- map Activity instance to one room
- skip manual invite/password inside validated Discord context
- add Activity-specific smoke tests

### Files likely to touch

- Modify: `client/src/services/discordActivity.ts`
- Modify: `client/src/screens/HomeScreen.tsx`
- Modify: `client/src/screens/SetupScreen.tsx`
- Modify: `client/src/screens/JoinScreen.tsx`
- Modify: `src/index.ts`
- Modify: `src/security.ts`
- Update: `docs/DISCORD_ACTIVITY_SCOPE.md`

### Acceptance criteria

- Two Discord users can enter the same room without manual code copy.
- Chat works.
- RPS works.
- App fits Discord viewport.
- No Discord identity is logged into analytics.

## Suggested Execution Order

### Branch 1: `gtm/beta-launch-readiness`

1. Create/replace logo SVG.
2. Add share metadata and public icons.
3. Add home marketing panel.
4. Improve invite copy and empty-room nudge.
5. Add GTM analytics events.
6. Add launch copy doc.
7. Run verification.

Verification:

```bash
npm run typecheck
npm test
npm run build
```

### Branch 2: `gtm/launch-assets`

1. Create OG image.
2. Audit existing videos.
3. Render or trim launch clips.
4. Create launch asset manifest.
5. Verify assets exist and load.

### Branch 3: `gtm/fort-pass-promo`

Only after paid smoke:

1. Tighten Fort Pass copy.
2. Add Fort Pass viewed event.
3. Update SKU docs if needed.
4. Verify checkout configured behavior.

### Branch 4: `gtm/discord-activity-beta`

Only after Discord credentials:

1. Add SDK integration.
2. Add server auth/token boundary.
3. Adapt room setup/join flow.
4. QA Activity viewport.
5. Update Discord docs.

## First Implementation Recommendation

Start with Branch 1.

The highest-leverage first move is not a giant launch. It is making the current product instantly legible and shareable:

- better logo
- better homepage context
- better link unfurl
- better invite text
- launch copy ready
- measurement clean

That turns the existing product into something we can actually put in front of people without explaining it manually every time.
