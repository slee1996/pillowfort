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

- Protocol version and ciphersuite, room ID, cryptographic room instance, and
  invitation-authentication public key.
- Signed member bindings, device credential public keys, host identity,
  membership lifecycle, disconnected-member grace state, and retired-device
  provenance.
- Causal order grants, delivery acknowledgements, bounded opaque MLS backlog,
  and replay/idempotency tombstones.
- Bounded authentication, room-creation, WebSocket-open, and application-frame
  throttle buckets.
- Active Fort Pass entitlement for a paid custom room.
- Short-lived Fort Pass checkout reservation for a custom room code.
- Per-source room-creation timestamps used by the production limiter.
- Production alarm schedule for room, admission, grant, reconnect, and commerce
  deadlines.
- Per-socket member attachment:
  - Connection and device identifiers.
  - Authenticated/pending lifecycle status and last acknowledged message.
  - Before authentication: hashed source identifier, one-use challenge, mode,
    challenge expiry, attempt-consumed flag, and pre-auth frame count.

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

- Transient socket objects and retry timers reconstructed from Class A state.
- Ephemeral UI animations, typing presentation, and unsent drawing batches.
- Chat and drawing history that the product deliberately treats as live-only.

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
- Pending admission, order-grant, delivery, and disconnected-member deadlines.
- Fort Pass reservation/claim deadlines.

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

- Plaintext chat, drawing, presence, control, or game content.
- Room secret.
- Invitation signing seed, device private credential, challenge proof, or Fort
  Pass raw claim secret.
- Unwrapped OpenMLS snapshot, current/consumed epoch secrets, and decrypted
  application state.
- Unencrypted private message bodies.

Current protocol-v4 design:

- The server stores the room's invitation-authentication public key, signed
  member bindings, device public credentials, and opaque MLS envelopes; it does
  not receive the room secret, an invitation signing seed, an MLS private key,
  a reusable admission proof, or application plaintext.
- Authentication proofs bind a one-use server challenge to the exact room,
  device, protocol mode, credential, and KeyPackage. Host approval and an MLS
  Add commit are separately required before a new device becomes active.
- The invitation public key is deterministic and can confirm a guessed secret,
  so the first-party client requires a generated 256-bit `pf2_` room secret.
- Every application event is encrypted inside MLS. The relay sees routing
  identifiers, protocol and destination class, timing/count, and coarse padded
  ciphertext size.
- Free-room routing IDs occupy the disjoint `f-` plus ten lowercase RFC 4648
  base32-symbol namespace (50 random bits). Human 4–10 character codes are
  paid-only, and the entire `f-` prefix is unavailable to custom-code checkout.
- Every setup boundary enforces that namespace: free IDs need no entitlement;
  custom IDs require an active room-bound Fort Pass entitlement and its exact
  redemption session. Joining an already-created room never grants ownership.

## Current Production Policy

As of this document:

- Protocol/room identity, invitation public key, member/device bindings, host
  and lifecycle state, causal/replay ledgers, opaque backlog, socket
  attachments, and bounded throttle buckets are Class A.
- Active Fort Pass entitlements are Class A while the paid room window is
  active.
- Browser-visible application state, including paid theme, membership names,
  leaderboards, active games, and queues, is part of the browser's encrypted
  application snapshot. It is not plaintext Durable Object state.
- Every browser persists its wrapped MLS/application snapshot and replay state
  in IndexedDB before send, acknowledgement, or delivery. One Web Lock owns a
  device/room state at a time; storage or revision failure is terminal until a
  safe restore/rejoin.
- All application plaintext, room/invitation secrets, MLS private state, and
  authentication proofs are Class D at the server boundary.
- Idle destruction uses a Durable Object alarm and is Class C.
- Relay-visible membership, delivery, grant, and commerce deadlines share the
  Durable Object alarm schedule and are Class C.
- The internal room-status check used for Fort Pass code availability returns
  only `{ exists: boolean }`; active Fort Pass entitlements count as existing
  rooms for availability checks. Unexpired checkout reservations also count as
  existing so two buyers cannot purchase the same custom code concurrently.
- Stripe fulfillment is idempotent for repeated delivery of the same Checkout
  Session through a global per-Session ledger and a room-scoped hashed
  redemption tombstone.
- Fort Pass checkout/setup ownership is Class A until consumed or revoked. The
  Durable Object persists the exact bounded `{ entitlement, claimHash }`
  fulfillment state and constant-time verifies a presented raw secret's
  SHA-256 digest. The raw 256-bit secret is Class D: it exists only in the
  originating browser tab's `sessionStorage`, is never logged or server-stored,
  and is erased after successful setup.
- Stripe refund/dispute revocation uses a separate global per-Event ledger and
  preserves a room-scoped refunded entitlement/redemption tombstone. Only the
  exact current Checkout Session owner can be revoked; delayed events for an
  older owner are durable no-ops.
- Production room creation uses a Durable Object-backed five-per-minute source
  limit; local development applies the equivalent in-memory limit.
- Premium room themes are available only through active Fort Pass entitlements.

This is acceptable for beta only if product copy distinguishes encrypted room
content from unavoidable relay metadata and does not promise transcript restore
to a new device or availability against a malicious relay.

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
6. Do not store application plaintext, room secrets, invitation/device signing
   seeds, unwrapped MLS state, or challenge proofs.
7. Keep paid entitlement state separate from chat state. Provider references,
   room code, active status, expiration, and paid perks are acceptable; chat
   content, room secrets, and encryption material are not.
8. Persist paid room settings that users can observe during the live room, such
   as premium theme selection.
9. Keep protocol-v4 invitation and device authentication challenge-bound. Do
   not replace the public-key checks with a stored equality token or persist a
   client proof.
10. Preserve strict protocol-v4 schemas and the pre-parse 96 KiB frame ceiling,
    64 KiB MLS envelope cap, and 16 KiB KeyPackage cap. Consume only one auth
    attempt per challenge and retain bounded source throttles across Durable
    Object hibernation.
11. Never release an application event across an unresolved add/remove or resume
    barrier. Persist state before a grant, send, acknowledgement, or delivery.

When adding a relay-visible timer in `src/room.ts`:

- If losing the timer is harmless, document it as Class B.
- If the timer must complete, store a deadline and schedule an alarm.
- Avoid relying on `setTimeout` for production-critical behavior.
- Add or update v4 Durable Object recovery coverage for alarm-backed behavior.

Application/game timers are encrypted and client-reduced. They must use a
deterministic encrypted deadline and must not rely on the relay learning the
game type. If a future game requires trusted automatic resolution while every
client is offline, that is a protocol change, not permission to leak its state
into the relay.

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

- Should a future account system add recoverable Fort Pass ownership? The beta
  intentionally uses an unrecoverable, tab-scoped one-time claim secret and
  refunds buyers who lose the originating tab before setup.
- Should a separately signed/installed client reduce the mutable web-origin
  trust boundary?
- Should a future transparency/gossip service make relay equivocation visible?
- Do any future games warrant a trusted randomness/escrow service for progress
  when an authorized player withholds a reveal? Current commit-reveal games fail
  closed and may stall.
