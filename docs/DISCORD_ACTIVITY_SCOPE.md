# Discord Activity Prototype Scope

The Discord Activity prototype should prove that Pillowfort works where friend
groups already gather. It should not replace the standalone web beta; it should
test distribution and multiplayer context.

## Prototype Goal

Answer one question:

Can a Discord user launch Pillowfort as an Activity and play/chat with friends
without the current invite-code flow getting in the way?

## In Scope

Core launch:

- Load the existing React app inside the Discord Activity surface.
- Detect that the app is running in Discord context.
- Create or attach to one Pillowfort room for the current Discord activity
  instance.
- Let participants join from the same Discord context without manually copying a
  room code.

Core room behavior:

- Chat.
- Presence.
- Reconnect handling.
- Knock down.
- At least one game: Rock Paper Scissors.

Identity:

- Use Discord context for display identity only where allowed.
- Do not require a Pillowfort account.
- Do not persist Discord user identity in chat logs.

Monetization exploration:

- Identify where entitlement checks would plug in.
- Test one premium host perk conceptually, such as theme access.
- Do not block guests behind purchase.

## Out Of Scope

Do not include in the prototype:

- Full billing implementation.
- Persistent Pillowfort accounts.
- Message history.
- Public room discovery.
- Full game catalog certification.
- Custom moderation tooling beyond existing room controls.

## Product Changes Needed

Standalone web assumes:

- Host creates a fort.
- Host copies invite code/password.
- Guest manually joins.

Discord Activity should instead assume:

- The Discord launch context is the invite.
- The activity instance maps to one Pillowfort room.
- The host role may come from the activity launcher or first participant.
- Room password may be unnecessary inside Discord if the platform context is the
  access boundary.

This should be implemented as a context adapter, not a forked app.

## Technical Shape

Recommended architecture:

- Keep `client/src/` as the shared app.
- Add a Discord launch/context service beside existing client services.
- Add room creation/join branching at the setup/join boundary.
- Keep websocket protocol changes minimal.
- Keep production room state in Durable Objects.

Server-side needs:

- A way to map Discord activity context to a room ID.
- Validation that the join came from an allowed Discord context.
- A policy for host assignment and host migration inside Discord.

Client-side needs:

- Discord context detection.
- Discord-specific loading/error states.
- A no-copy join path.
- Mobile and desktop iframe layout checks.

Current prototype slice:

- `/activity` serves the shared app shell and uses Discord-specific frame
  headers instead of the default `frame-ancestors 'none'` policy.
- `client/src/services/discordActivity.ts` detects likely Activity launches via
  `/activity`, Discord proxy hosts, `discord_activity=1`, or `frame_id`.
- The detected Activity instance maps to a deterministic `dc-......` room flag.
- The setup and join screens prefill/use that room flag while the existing
  password model remains in place.
- Analytics emits `discord_activity_detected` without logging Discord IDs.

This is intentionally a pre-SDK slice. The next implementation step is adding
`@discord/embedded-app-sdk`, calling `ready()`, and using `authorize()` /
`authenticate()` once a Discord client ID and token exchange endpoint exist.

## Open Decisions

Resolve before implementation:

- Does a Discord activity instance get one room for its lifetime, or can users
  knock it down and create another in the same context?
- Is the launcher always the first host?
- If the host leaves Discord voice, should host migration follow Pillowfort's
  existing pillow-throw rules?
- Should Discord display names be used directly or sanitized through the current
  name flow?
- Is a room password skipped entirely inside Discord context?

Recommended prototype answers:

- One activity instance maps to one room.
- First participant becomes host.
- Existing host migration still applies.
- Discord names go through the same max-length and uniqueness rules.
- Skip room password inside Discord context.

## Validation Checklist

Prototype is successful if:

- One user launches the Activity.
- A second user joins from Discord without manual invite entry.
- Both users can send messages.
- Both users can complete Rock Paper Scissors.
- A disconnected user can rejoin cleanly.
- The room can be knocked down.
- The app remains usable in Discord's constrained viewport.

## Risks

SDK and platform drift:

- Verified against Discord's official docs on 2026-05-03: Activities run as
  iframe-hosted SPAs, the SDK `ready()` handshake is required, Activity URLs use
  Discord's proxy/URL mappings, and native IAP should verify entitlements
  server-side rather than trusting only SDK data.

Privacy:

- Do not expand chat logging because Discord identity is present.
- Keep analytics sanitized.

Product fit:

- Discord users may expect voice-first behavior; Pillowfort should complement
  that with lightweight chat/games, not try to replace voice.

Revenue:

- Discord monetization rules may constrain standalone billing. Keep entitlement
  checks abstract enough to support either platform-native purchases or the
  standalone Fort Pass model.
