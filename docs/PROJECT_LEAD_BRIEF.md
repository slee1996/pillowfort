# Pillowfort Project Lead Brief

Analysis date: 2026-05-02

This document is the product, technical, and business brief for taking over
Pillowfort as project lead. It complements `ARCHITECTURE.md`, which covers the
system design and WebSocket protocol in more detail.

## Executive Summary

Pillowfort is a small, private, disposable hangout room for friends. A host
creates a fort, shares an 8-character room code plus a password, people join in
real time, chat, doodle, play small games, and then knock the room down.

The product is not just "chat." Its strongest shape is:

> Instant private party rooms with retro AIM / Windows XP energy, built-in
> friend games, and no account setup.

The repo is already beyond a toy prototype. It has a React frontend, Bun local
runtime, Cloudflare Workers + Durable Objects production runtime, encrypted chat
payloads, reconnection and host handoff behavior, multiple room games,
integration tests, visual snapshot tests, screenshots, and a video marketing
pipeline.

The business opportunity is not selling yet another messaging app. The credible
opportunity is selling the ritual: a tiny private room friends actually want to
open for game night, long-distance hanging out, or a small community event.

## What This Codebase Is

Pillowfort is a full-stack TypeScript application.

Primary runtime pieces:

- `client/`: React + Vite frontend.
- `server.ts`: local Bun server with in-memory room state.
- `src/index.ts`: Cloudflare Worker entrypoint.
- `src/room.ts`: Cloudflare Durable Object room runtime.
- `src/shared.ts`: shared validation helpers and limits.
- `src/game.ts`: shared pure mini-game rules.
- `src/analytics.ts`: privacy-safe analytics validation.
- `src/entitlements.ts`: host-only paid SKU entitlement helpers.
- `src/alarms.ts`: Durable Object alarm schedule helpers.
- `client/src/services/protocol.ts`: typed WebSocket protocol.
- `client/src/services/chatCrypto.ts`: browser-side room-key chat encryption.
- `test/`: Bun, WebSocket, Playwright, and visual regression tests.
- `video/`: Remotion-based demo and marketing video pipeline.

Core user flow:

1. User picks a screen name.
2. Host creates a fort with a secret password.
3. App generates an 8-character room code.
4. Host shares code/link and password out of band.
5. Guests join with screen name, code, and password.
6. Members chat, draw, and play games.
7. Host knocks the fort down, or the room expires after idle time.

The product intentionally avoids durable social infrastructure:

- No accounts.
- No public room directory.
- No persistent transcript database.
- No message replay for late joiners.
- Only the last used screen name is kept client-side.

## Current Product Surface

Core room behavior:

- Invite-only rooms.
- Host-created room codes.
- Password-gated entry.
- Auto-suffixed duplicate names.
- Typing indicators.
- Room-scoped presence and away messages.
- Reconnect grace window.
- Host migration via pillow throw.
- Manual host transfer.
- Guest cap.
- Message rate limiting.
- Idle room self-destruction.

Chat and UX:

- AIM / Windows XP inspired UI.
- Desktop and mobile layouts.
- AES-GCM encrypted chat payloads.
- Message formatting.
- Emoji insertion.
- Save-chat export from the local UI.
- Invite-copy flow with room link and password.

Games and social mechanics:

- Shared drawing canvas.
- Breakout when the chat window is minimized.
- Pillow Fight vote-to-kick.
- Rock Paper Scissors.
- Tic-Tac-Toe.
- Secret Saboteur.
- King of the Hill host challenge.
- Per-room leaderboards.
- Queued game flow.

Marketing assets:

- Product screenshots in `docs/screenshots/`.
- Demo videos in `demo-videos/`.
- Remotion compositions and rendered outputs in `video/`.

## What Pillowfort Is Good At

Pillowfort is good at low-friction small-group presence. It gets a private room
open quickly without asking anyone to create an account or install an app.

The strongest attributes are:

- Fast setup: room code plus password is enough.
- Clear privacy posture: no public discovery and no durable chat history.
- Differentiated identity: the XP/AIM interface is memorable.
- Small-group play: games are part of the room, not bolted on as external links.
- Social continuity: host handoff avoids killing a room just because the first
  host disconnects.
- Demoability: the product is visual and already has screenshots, video assets,
  and choreography tests.
- Low operational complexity: Cloudflare Workers and Durable Objects are a good
  fit for per-room real-time coordination.

The product has a credible wedge because it feels more intentional than a random
Discord thread, lighter than a full game platform, and more playful than a
generic encrypted chat room.

## Technical Strengths

The codebase has several real strengths:

- The room lifecycle is explicit and documented.
- The WebSocket protocol is typed on the client.
- Production routing is simple: `/ws?room=...` goes to the room Durable Object,
  static assets serve the SPA, and `/:roomId` resolves room links.
- The frontend state model is centralized with Zustand.
- Chat encryption is client-side, room-key based, and binds sender/session data
  into AES-GCM additional authenticated data for newer payloads.
- The server validates message length, name length, style colors, encrypted
  payload shape, auth verifier shape, and game actions.
- Core tests cover lifecycle, joins, wrong password, duplicate names, capacity,
  reconnect, host handoff, games, leaderboards, queueing, rate limiting, and
  invite-link behavior.
- Design snapshot tests exist for desktop and mobile screens.

As of this brief, the core suite passes:

```text
79 pass
0 fail
```

## Main Risks

### Runtime Duplication

The largest engineering risk is duplicated room logic.

Local behavior lives in `server.ts`; production behavior lives in `src/room.ts`.
The same room rules, game rules, timers, validation, and state transitions are
implemented twice. This makes every product change more expensive and creates
risk that local tests pass while production behaves differently.

Project-lead recommendation:

- Move pure game logic and room transition helpers into shared modules where
  possible.
- Keep runtime-specific socket/storage code separate.
- Add tests around shared rules first, then shrink duplicated branches.

### Durable Object Hibernation State

The production runtime uses Durable Objects and the hibernation WebSocket API.
That is the right architectural direction, but Cloudflare hibernation discards
in-memory state. This means anything important after hibernation must be
recoverable from Durable Object storage or WebSocket attachments.

Currently persisted state appears intentionally minimal: room ID and auth
verifier. Active games, queues, leaderboards, and some transient timers are
mostly in memory. That may be acceptable for an ephemeral app, but it needs an
explicit decision.

Project-lead recommendation:

- Define state classes:
  - Must persist through hibernation.
  - May reset on hibernation.
  - Must die when the fort is knocked down.
- Persist only the first class.
- Prefer Durable Object alarms for scheduled production behavior where state
  must survive object eviction.

### Product Positioning

"Private chat app" is too weak as a market position. Existing messaging apps
already own habitual chat.

Pillowfort should position around:

- Disposable private party rooms.
- Retro online hangout energy.
- Built-in friend games.
- No account setup.
- A room that ends.

### Trust And Safety

The product intentionally avoids accounts, which is good for privacy and
friction but harder for moderation, abuse prevention, payments, and support.

Project-lead recommendation:

- Keep free rooms anonymous.
- Require account or payment identity only for paid host features.
- Add minimal abuse controls before public launch:
  - IP-level creation rate limits in production.
  - Report abuse contact path.
  - Optional host controls for muting/ejecting.
  - Clear privacy copy around what is and is not encrypted.

### Monetization Fit

The free loop is the growth loop. Monetization must not block room creation,
joining, or the first successful game night.

Paid features should attach to hosts and organizers, not random guests.

## Monetization Thesis

Do not monetize chat. Monetize hosting, customization, and events.

Recommended model:

1. Free core product.
2. Paid host upgrades.
3. Optional one-time party packs.
4. Later, Discord Activity monetization.

The free product should include:

- Create rooms.
- Join rooms.
- Core chat.
- Core games.
- Basic invite flow.
- Short idle timeout.
- Default theme.

Potential paid SKUs:

### Pillowfort Plus

Target price: about $5/month.

Host-focused perks:

- Custom room codes.
- Custom room themes.
- Longer idle timeout.
- More saved room presets.
- More sound packs.
- Extra emoji/sticker packs.
- Advanced host controls.
- Optional local transcript export improvements.

### Party Packs

Target price: $3-$10 one-time purchases.

Examples:

- Halloween Saboteur pack.
- Sleepover theme pack.
- LAN-party theme pack.
- Extra room soundboard.
- Seasonal mini-game variants.

### Event / Creator Tier

Target price: $15-$49/month or $29/event.

For communities, streamers, small creators, and remote teams:

- Larger room caps.
- Branded room shell.
- Scheduled event links.
- Moderator controls.
- Host-only game queue management.
- Post-event export controls.
- Stream-friendly overlay mode.

## Best Distribution Path

The strongest distribution path is Discord.

Pillowfort is already close to what Discord calls an Activity: a web app in an
iframe for multiplayer games and social experiences. Discord also supports
native app monetization through subscriptions and one-time purchases for apps
and Activities.

Why Discord fits:

- Users already gather there.
- Pillowfort does not need to pull people away from their social graph.
- The product already works as a web app.
- The game-room behavior fits group channels and DMs.
- Native Discord purchases could reduce billing friction for Activity-specific
  upgrades.

Standalone web should still exist. It is useful for direct links, SEO, demos,
and users outside Discord. But Discord should be treated as the first serious
growth channel.

## Competitive Context

Relevant comparables:

- Kosmi: browser-based watch parties, games, rooms, and virtual hangouts.
- Hyperbeam Watch Party: shared browsing and watch-party rooms.
- Discord Activities: embedded multiplayer/social experiences inside Discord.
- Classic AIM/IRC/hack.chat: inspiration for lightweight real-time rooms.

Pillowfort should not try to beat watch-party products at video sync or shared
browsing. Its wedge should be:

> Private retro game-night rooms for friends.

## Roadmap

### Phase 1: Stabilize The Core

Goal: make the current product reliable enough for public beta.

Work:

- Decide hibernation persistence rules for production.
- Reduce duplicated game/room logic between local and production runtimes.
- Add production-like tests for Durable Object behavior where feasible.
- Add privacy copy that accurately explains encryption and metadata.
- Add basic analytics that never capture message content.
- Add lightweight error and session observability.
- Tighten deploy checklist.

Success criteria:

- Core tests remain green.
- Production room lifecycle matches local tests.
- A user can create, invite, play, disconnect, rejoin, and knock down without
  manual recovery.

Current status:

- Edge hardening, security headers, operational events, and production
  monitoring docs are in place.
- The safety code moved out of chat into the Fort menu.

### Phase 2: Public Beta

Goal: prove that people will use it for real hangouts.

Work:

- Ship standalone beta.
- Add a concise product homepage or first-run intro without blocking room
  creation.
- Add a "start game night" flow.
- Instrument privacy-safe funnel metrics:
  - Room created.
  - Invite copied.
  - Guest joined.
  - First message sent.
  - First game started.
  - Room duration.
  - Return host rate.
- Use the existing video pipeline for launch clips.

Current status:

- Home/setup copy now states invite-only, accountless, temporary room, and
  password-storage boundaries without adding an onboarding wall.
- Chat now shows activation nudges for empty rooms and first-game starts.
- `npm run metrics:report` turns sanitized analytics logs into a weekly funnel
  readout.

Success criteria:

- Users create rooms without help.
- At least 2-4 people join a meaningful share of rooms.
- Games are started in a meaningful share of active rooms.
- Some hosts return.

### Phase 3: First Revenue

Goal: test willingness to pay without hurting viral growth.

Work:

- Add accountless host redemption only when needed for paid upgrades.
- Ship first paid SKU:
  - Custom room code.
  - Longer timeout.
  - Theme pack.
- Add billing with Stripe for standalone web.
- Keep guests accountless.
- Keep refund/support handling simple and manual for beta.

Current status:

- Fort Pass entitlement model exists.
- Custom-code availability exists.
- Public Fort Pass status exists for non-secret checkout readiness.
- Stripe Checkout creation exists.
- Signed Stripe webhook fulfillment exists.
- Checkout success redemption exists.
- The setup screen has a host-facing Fort Pass upgrade entry point.
- Fort Pass rooms can switch to premium room themes.
- The setup screen disables checkout if the deployed environment does not report
  paid beta readiness.
- A paid beta support/refund runbook exists.

Success criteria:

- First paid hosts.
- No meaningful drop in room creation or guest join conversion.
- Clear support path for billing issues.

### Phase 4: Discord Activity

Goal: meet users where they already organize hangouts.

Work:

- Prototype Discord Embedded App SDK integration.
- Map room identity to Discord activity instances.
- Replace or adapt invite flow for Discord launch context.
- Test mobile and desktop iframe constraints.
- Evaluate Discord native monetization.

Current status:

- `/activity` serves the shared app shell with Discord frame headers.
- Client-side Discord Activity detection maps an Activity launch to a
  deterministic `dc-......` room flag.
- SDK installation/authentication is intentionally deferred until a Discord
  client ID and token exchange endpoint are ready.

Success criteria:

- A Discord user can launch Pillowfort as an Activity.
- Friends can join from the same Discord context.
- Core game flow works inside Discord.
- Purchase or entitlement checks work for at least one premium perk.

## Metrics To Watch

Activation:

- Room creation completion rate.
- Invite copied rate.
- First guest joined rate.
- Time from home screen to live room.

Engagement:

- Messages per active room.
- Game starts per active room.
- Median active room duration.
- Share of rooms with 3+ participants.
- Return host rate.

Retention:

- Hosts who create another room within 7 days.
- Guests who later become hosts.
- Repeat usage by paid hosts.

Revenue:

- Free-to-paid host conversion.
- Paid host churn.
- Revenue per active host.
- Purchase rate by SKU.

Safety:

- Room creation rate-limit hits.
- Ejections and vote-to-kick frequency.
- Support reports.
- Failed auth attempts.

## Operating Principles

Keep friction low:

- No account required for free rooms.
- Do not block guest joins behind payment.
- Avoid onboarding walls.

Keep rooms small:

- The product should feel intimate.
- Scaling to huge rooms is a separate product.

Keep privacy claims precise:

- Message payloads can be encrypted.
- Server still sees metadata such as room, sender name, event timing, and joins.
- Local export exists because the user's browser can save what it sees.

Keep the vibe:

- The nostalgia is a differentiator.
- UI polish matters more here than generic feature count.

Keep the room disposable:

- Ending the room is part of the product.
- Paid features should not turn Pillowfort into a permanent workspace clone.

## Immediate Project Lead Priorities

1. Finish and land the current game hardening work already visible in the
   worktree.
2. Write a production-state policy for Durable Object hibernation.
3. Extract shared game rules from duplicated runtimes where low risk.
4. Add beta analytics without message content collection.
5. Prepare a first public beta deploy checklist.
6. Define the first paid SKU and keep it host-only.
7. Scope the Discord Activity prototype.

Current supporting docs:

- [Production state policy](PRODUCTION_STATE_POLICY.md)
- [Beta analytics contract](BETA_ANALYTICS.md)
- [Public beta deploy checklist](PUBLIC_BETA_DEPLOY_CHECKLIST.md)
- [First paid SKU](FIRST_PAID_SKU.md)
- [Fort Pass support runbook](FORT_PASS_SUPPORT_RUNBOOK.md)
- [Discord Activity prototype scope](DISCORD_ACTIVITY_SCOPE.md)

## External References

- Cloudflare Durable Objects:
  https://developers.cloudflare.com/durable-objects/
- Cloudflare Durable Object WebSocket hibernation:
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cloudflare Durable Object lifecycle:
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Cloudflare Workers pricing:
  https://developers.cloudflare.com/workers/platform/pricing/
- Discord Activities:
  https://docs.discord.com/developers/platform/activities
- Discord app monetization:
  https://docs.discord.com/developers/platform/app-monetization
- Kosmi:
  https://kosmi.io/
- Hyperbeam Watch Party:
  https://watch.hyperbeam.com/
