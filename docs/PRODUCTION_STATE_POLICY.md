# Production State Policy

This document defines what Pillowfort production state may do across Durable
Object hibernation, reconnects, and fort destruction. It should be read before
changing `src/room.ts`, `server.ts`, or shared room/game logic.

## Why This Exists

Production rooms run inside Cloudflare Durable Objects. Durable Objects can
hibernate while WebSocket clients remain connected. When a Durable Object wakes
up, its constructor runs again and ordinary in-memory fields are rebuilt from
scratch.

That means every piece of room state needs an explicit policy:

- Persist it if users must not observe it resetting while a room is alive.
- Keep it in memory only if reset is acceptable.
- Delete it when the fort is knocked down.

Pillowfort is intentionally ephemeral, but ephemeral does not mean undefined.
Live-room behavior should be predictable.

## State Classes

### Class A: Must Survive While The Fort Is Alive

This state is required for room access or live-room continuity. In production it
must be recoverable after Durable Object wake-up.

Current examples:

- Room ID.
- Room auth verifier.
- Active Fort Pass entitlement for a paid custom room.
- Production alarm schedule.
- Saboteur bomb deadline while a bomb is active.
- Per-socket member attachment:
  - Screen name.
  - Host flag.
  - Host rejection flag.
  - Presence status.
  - Away text.
  - Message rate-limit timestamps, if preserving short-window rate limits is
    required.

Storage strategy:

- Room-level Class A state belongs in Durable Object storage.
- Socket-level Class A state belongs in WebSocket attachments via
  `serializeAttachment()`.

Destroy behavior:

- Must be wiped on fort destruction.
- `storage.deleteAll()` is expected when a fort is knocked down.

### Class B: May Reset On Hibernation

This state improves the live experience but may be allowed to reset if the room
hibernates, provided the reset is intentional and documented.

Current examples:

- Roomwide leaderboards.
- Queued game flow.
- Active mini-game state.
- Vote timers.
- Challenge timers.
- Recent message rate-limit timestamps, if treated as best-effort.

Storage strategy:

- May stay in memory.
- If product expectations change, promote specific fields to Class A or C.

User-facing rule:

- If a reset would surprise users during normal active use, do not leave it in
  Class B.
- Long-idle rooms can tolerate more reset behavior than active rooms.

### Class C: Must Survive Timed Production Work

This state is tied to scheduled behavior that should complete even if the object
is evicted or hibernated.

Candidate examples:

- Idle destruction deadline.
- Saboteur bomb deadline.
- Vote deadline, if active votes should survive hibernation.
- Challenge expiration deadline, if pending challenges should auto-decline
  reliably after hibernation.

Storage strategy:

- Store the deadline and the minimum state needed to resolve it.
- Use Durable Object alarms for production scheduling.
- Reconstruct the pending action in `alarm()`.

Important constraint:

- A Durable Object has one alarm at a time. Multiple deadlines require storing a
  schedule and setting the alarm to the nearest deadline.

### Class D: Must Never Persist

This state should not be written to Durable Object storage or server logs.

Examples:

- Plaintext chat message content.
- Room password.
- Derived chat keys.
- Unencrypted private message bodies.

Current auth design:

- The server stores an auth verifier, not the room password.
- Encrypted chat payloads are relayed but not decrypted by the server.

## Current Production Policy

As of this document:

- Room ID and auth verifier are Class A.
- Active Fort Pass entitlements are Class A while the paid room window is
  active.
- Paid room theme selection is Class A while the fort is alive.
- WebSocket member attachment data is Class A.
- Chat plaintext is Class D.
- Room password and derived chat keys are Class D.
- Leaderboards, active games, game queue, and most timers are Class B unless a
  feature explicitly promotes them.
- Idle destruction uses a Durable Object alarm and is Class C.
- Saboteur bomb destruction uses the shared Durable Object alarm schedule and is
  Class C.
- The internal room-status check used for Fort Pass code availability returns
  only `{ exists: boolean }`; active Fort Pass entitlements count as existing
  rooms for availability checks.
- Premium room themes are available only through active Fort Pass entitlements.

This is acceptable for beta if the product copy does not promise persistent
leaderboards, persistent games, or timer continuity across long idle periods.

## Promotion Criteria

Promote Class B state to Class A or C when any of these become true:

- Users can pay for the state.
- The UI presents the state as reliable or durable.
- Losing the state creates unfair gameplay.
- Losing the state can trap a room in an inconsistent state.
- The state is needed to complete a destructive action, such as a bomb countdown
  or automatic ejection.

## Implementation Rules

When editing room state:

1. Classify the state in this document.
2. Update both local and production runtimes if behavior is shared.
3. Prefer shared pure helpers for rule logic.
4. Keep runtime-specific socket/storage code in runtime files.
5. Add tests for the rule, not just the UI path.
6. Do not store plaintext chat content or room passwords.
7. Keep paid entitlement state separate from chat state. Provider references,
   room code, active status, expiration, and paid perks are acceptable; chat
   content, passwords, and encryption material are not.
8. Persist paid room settings that users can observe during the live room, such
   as premium theme selection.

When adding a timer in `src/room.ts`:

- If losing the timer is harmless, document it as Class B.
- If the timer must complete, store a deadline and schedule an alarm.
- Avoid relying on `setTimeout` for production-critical behavior.
- Add or update coverage in `test/worker.test.ts` for alarm-backed behavior.

When destroying a room:

- Broadcast `knocked-down`.
- Close connected sockets.
- Clear transient timers.
- Clear disconnected grace timers.
- Delete Durable Object storage.
- Reset in-memory fields that could leak into a later room instance.
- Paid Fort Pass entitlements are one-hangout state and are cleared by the same
  storage deletion.

## Open Decisions

These decisions should be resolved before a larger public beta:

- Should room leaderboards survive hibernation while the fort is alive?
- Should game queue state survive hibernation?
- Should active votes survive hibernation?
- Should challenge auto-decline timers use alarms or remain best-effort?
- Should Fort Pass redemption graduate from Checkout Session ID matching to a
  one-time token, Stripe session lookup, or lightweight host identity before a
  larger paid launch?

Recommended beta answer:

- Persist room access and member identity.
- Keep games and leaderboards ephemeral for now.
- Keep Saboteur bomb countdowns alarm-backed.
