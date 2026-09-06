# Public Beta Deploy Checklist

Use this checklist when preparing Pillowfort for a public beta deploy. It keeps
the release path tied to the current repo shape: React/Vite assets, a Cloudflare
Worker entrypoint, and one Durable Object class for room state.

## Release Gate

Do not deploy a public beta unless all of these are true:

- `npm run check` passes. This single executable gate runs typecheck, `npm test`,
  and the production build in order, stopping on the first failure.
- Worker routing and Durable Object alarm tests pass as part of `npm test`.
- `npm test` also runs the security suite for invitation and device authentication,
  MLS add/remove/update epochs, durable replay rejection, exact resume ordering,
  membership barriers, malformed-frame rejection, and encrypted game events; do
  not run it a second time as a separate release requirement.
- `wrangler.toml` still points at `src/index.ts`.
- `client/dist` was produced by the current commit.
- The Durable Object migration list still includes the `Room` class.
- The production state policy has no unresolved change required by this release.
- Analytics events still follow the privacy-safe beta contract.
- If Fort Pass is enabled, Stripe Checkout and the signed webhook endpoint are
  configured together.
- `/api/fort-pass/status` reports `checkoutConfigured: true` before Fort Pass
  is promoted outside quiet beta. This requires Checkout and webhook secrets.

Read paid status from the configured canonical checkout origin. A noncanonical
`workers.dev` alias can intentionally report `checkoutConfigured: false`; this
does not by itself establish missing credentials or a different Worker.

Optional but recommended before a marketing push:

- `npm run test:design-snapshots`
- `npm run test:ui`

## Preflight Commands

Use Node.js 22.13+ and Bun 1.3.14; the release-check CI workflow uses Node.js 22.
The security gate runs persistent-browser tests with Node's native TypeScript
support and the remaining suites with Bun. From the repo root, install both
dependency trees from their committed lockfiles and install Playwright Chromium:

```bash
npm ci
npm --prefix client ci
npx playwright install --with-deps chromium

npm run check
```

The release-check workflow runs the same gate on pushes and pull requests with
read-only repository permissions, without deployment secrets or private
submodule checkout. It never deploys. Optional marketing and UI suites remain
separate from this gate.

Confirm Cloudflare auth before deploying:

```bash
npx wrangler whoami
```

Deploy with the guarded entrypoint. It reruns `npm run check`, rebuilding assets
from the selected source revision, and invokes Wrangler only if every gate
stage succeeds:

```bash
npm run deploy
```

## Manual Smoke Test

Run this against the deployed URL, not only local development:

1. Open the home screen on desktop.
2. Use copy-and-create with the locked generated password. Confirm the new
   default is exactly 26 characters: `pf3_` plus 22 canonical unpadded
   base64url characters, ending in `A`, `Q`, `g`, or `w`. Repeat with an
   explicit 16+ character custom password.
3. Deny clipboard permission and repeat creation. Confirm no room is silently
   created: manually copy the password and explicitly confirm it is saved
   before continuing.
4. Copy the flag and password from Invite; confirm the password is masked
   unless revealed.
5. Join from a second browser profile or device with each password. Confirm a
   wrong custom password is rejected before a host approval prompt and can be
   corrected in the same browser.
6. Approve the pending device from People, compare the displayed safety
   fingerprints out of band, then send one styled message from each participant
   and confirm text and style arrive in order.
7. Reload and recover the original device by re-entering the exact saved
   password, for both the new default and custom-password rooms. Confirm the
   existing identity resumes rather than requiring an unintended new admission.
8. With a still-live protocol-v4 room created using the old canonical `pf2_`
   format (32 bytes, 43 base64url suffix characters), join from another browser
   with the original invitation, then reload and recover an established device
   using that same password. Confirm the old room and device identities remain
   intact; do not substitute a newly generated `pf3_` password for the old one.
9. Start one lightweight game from Play, preferably Rock Paper Scissors.
10. Disconnect and reconnect one participant inside the grace window.
11. Change presence to away and back.
12. Knock the fort down as host from Room, confirming the destructive action.
13. Confirm the old room cannot be rejoined as an active room.

These are required smoke scenarios, not a record that they have been executed.
The short default carries 128 bits of random entropy; its room-bound
600,000-round PBKDF2-HMAC-SHA-256 resolution produces a canonical 32-byte
`pf2_` protocol secret, not 256 bits of input entropy. The old `pf2_` path keeps
its exact secret after equivalent derivation/wiping for timing compatibility,
and the custom-password controls and derivation remain unchanged. Neither
reserved namespace may fall back to custom input when malformed.

Mobile smoke:

1. Create or join a room on a narrow viewport.
2. Send a message.
3. Open and close the member/game surfaces.
4. Copy invite details and confirm the room secret remains masked by default.
5. Confirm no primary controls overlap.

Paid smoke, only if Fort Pass is enabled:

1. Confirm `/api/fort-pass/status` returns `checkoutConfigured: true`.
1. Check an available custom code with `/api/fort-pass/code?code=party-1`.
2. Start checkout for that code.
3. Complete a test Checkout Session.
4. Confirm Stripe sends a signed `checkout.session.completed` event to
   `/api/stripe/webhook`.
5. Confirm the same code now reports `taken`.
6. Confirm the checkout success redirect includes `fort_pass=success`, `code`,
   and `session_id`.
7. Copy that URL into a fresh tab and confirm redemption/setup is rejected;
   neither the code nor Session ID is payment authority without the originating
   tab's claim secret.
8. Return to the originating tab, set up the paid room, and verify the extended idle
   entitlement applies.
9. As host, switch to a premium theme and confirm another joined browser sees
   the same room theme.

## Privacy Checks

Before public traffic:

- Do not log plaintext chat content.
- Do not log room secrets, authentication signing seeds, or challenge proofs.
- Do not log derived encryption keys.
- Do not log raw room codes in analytics.
- Do not add persistent user identity for free rooms.
- Keep `/analytics` same-origin and sanitized.
- Keep privacy copy precise: room content is end-to-end encrypted, while relay
  routing identifiers, protocol/destination class, timing, message count, and
  coarse padded size remain visible.

## Production Behavior Checks

Room lifecycle:

- Rooms are invite-only.
- New joiners do not receive old message history.
- Fort destruction closes connected sockets.
- Durable Object storage is cleared when a fort is knocked down.

Timed behavior:

- Idle room destruction uses Durable Object alarms.
- Saboteur bomb destruction uses Durable Object alarms.
- Vote and challenge timers are currently best-effort game state.

State expectations:

- Protocol version/suite, room instance, invitation-auth public key, signed
  member bindings, host and lifecycle state, causal delivery ledger, bounded
  opaque backlog, replay tombstones, throttles, and required deadlines survive
  Durable Object wake-up.
- Each browser persists its complete wrapped MLS/application snapshot in
  IndexedDB under an exclusive per-room Web Lock. Credential-scoped state keys,
  atomic legacy migration, and bounded unresolved-state metadata keep a
  mistyped or pre-send-cancelled attempt from shadowing an established
  identity while preserving exact recovery after a sent attempt. Storage, lock,
  revision, or decode failures stop delivery and sending instead of reverting
  to volatile state.
- Cloudflare invocation logs are disabled; WebSocket edge/room paths emit no
  custom provider logs. Do not save raw real-time tail output because request
  URLs remain visible to authorized live observers.
- Chat and drawing events remain live-only product data: they are protected in
  transit but are not restored as a user-visible transcript to late joiners.

Security behavior:

- Production accepts only protocol v4. It never translates or downgrades v4
  traffic to a legacy plaintext or shared-key envelope.
- Setup, join, and rejoin require fresh one-use challenges plus invitation- and
  device-bound Ed25519 proofs. A join does not enter MLS until the host approves
  its exact signed device credential and one-use KeyPackage.
- OpenMLS ciphersuite 1 protects every chat, drawing, presence, membership UI,
  and game application event. Removal commits are delivery barriers: the relay
  cannot release later application traffic until the removal is durably
  acknowledged.
- Both runtimes reject v4 frames larger than 96 KiB before JSON parsing and
  enforce the 64 KiB MLS payload and 16 KiB KeyPackage limits inside the strict
  wire schema.
- Replay and MLS state survive reload, browser restart, reconnect, and tab
  takeover for the same device. Corrupt, unavailable, conflicting, full, or
  unwritable storage fails closed.
- The browser deletes consumed generations from logical MLS state and performs
  update commits after sensitive membership changes, reconnect, and on a
  bounded active-room cadence.
- The relay can still drop, delay, reorder, partition, or suppress traffic. It
  can affect availability and liveness decisions, but cannot forge or decrypt a
  valid MLS application message.
- A mutable first-party web origin, a compromised endpoint, or an authorized
  participant can expose plaintext. Do not describe browser E2EE as protection
  from those parties.

## Observability Checks

Immediately after deploy:

- Observe uncaught exceptions without saving raw real-time tail output or request
  envelopes. Keep invocation logs disabled; retain only sanitized application
  events and redacted exception details, never request URLs or secret material.
- Confirm `/analytics` accepts known events and rejects unknown events.
- Confirm sanitized analytics log lines do not include names, room codes,
  room secrets, authentication material, or message text.
- Confirm `/api/fort-pass/code?code=party-1` returns only availability data and
  uses `cache-control: no-store`.
- If Stripe is not configured, confirm `/api/fort-pass/checkout` returns
  `checkout_not_configured`.
- If Stripe is configured, confirm checkout creation returns only `code`,
  `checkoutUrl`, and `sessionId`.
- Confirm the raw Fort Pass claim secret appears only in the originating tab's
  `sessionStorage` and redemption/setup request, never in a return URL, Stripe
  metadata, server storage, or logs.
- If Fort Pass is enabled, confirm `/api/stripe/webhook` rejects unsigned
  payloads and fulfills only signed paid Checkout Session events with Fort Pass
  metadata.
- Confirm the non-secret Stripe setup record in `docs/STRIPE_TEST_SETUP.md` is
  current before running paid tests.
- Keep paid promotion blocked until the [Paid Promotion Gate](FORT_PASS_SUPPORT_RUNBOOK.md#paid-promotion-gate)
  is satisfied: owner-approved public refund/support details and an explicitly
  authorized live-mode purchase, return, redemption, and refund. A sandbox smoke
  or `checkoutConfigured: true` is not sufficient.
- Use `docs/FORT_PASS_SUPPORT_RUNBOOK.md` for paid beta support and refunds.
- Watch for repeated websocket close/error patterns.
- Watch room creation rate-limit hits.

Useful beta questions from the logs:

- How many rooms are created?
- How often is an invite copied?
- How often does a guest join?
- How often does a first message happen?
- How often does a game start?
- How often are forts knocked down?

## Rollback Plan

If the deploy breaks room creation, websocket join, message send, or fort
destruction:

1. Stop promotion and stop sharing the beta URL.
2. Select a verified known-good source revision and record its commit and
   deployment/version ID. Confirm its Worker, browser protocol, Durable Object
   schema, and migrations are compatible with the state currently in production.
   A code rollback does not roll back Durable Object storage or reverse migrations;
   if compatibility cannot be established, do not deploy that revision.
3. Use a clean checkout of that revision and repeat the locked dependency and
   Playwright installation steps above. Ensure its scripts retain the guarded
   `npm run check` then Wrangler deployment chain documented here; restore that
   guard before proceeding if the historical revision predates it.
4. Run `npm run deploy` from that checkout. The gate must pass and regenerate
   matching client assets before Wrangler uploads them. Never roll back with a
   bare `npx wrangler deploy` or reuse `client/dist` from another revision.
5. Verify create, join, chat, reconnect, and knock-down on the rolled-back URL.
6. Preserve only sanitized application events and redacted exception details from
   the failed deploy. Never save raw real-time tail output, request envelopes or
   URLs, room codes, secrets, authentication material, or message content.
7. Write the incident summary in `docs/` or the issue tracker before retrying,
   using only those sanitized records.

If analytics breaks but rooms still work:

1. Disable or revert the analytics route/client calls.
2. Keep the room product live if privacy checks remain clean.
3. Do not add a third-party analytics SDK during the incident.

## Ship/No-Ship Rule

Ship if the core room loop is reliable and privacy claims are accurate.

Do not ship if any of these are broken:

- Create room.
- Join room.
- Send encrypted messages.
- Invite copy.
- Reconnect grace.
- Knock down.
- Durable Object cleanup.
- Privacy-safe analytics sanitization.
- Signed Stripe webhook fulfillment, if Fort Pass is public.
