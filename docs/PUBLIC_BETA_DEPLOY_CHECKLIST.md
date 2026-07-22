# Public Beta Deploy Checklist

Use this checklist when preparing Pillowfort for a public beta deploy. It keeps
the release path tied to the current repo shape: React/Vite assets, a Cloudflare
Worker entrypoint, and one Durable Object class for room state.

## Release Gate

Do not deploy a public beta unless all of these are true:

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- Worker routing and Durable Object alarm tests pass as part of `npm test`.
- `npm run test:security` passes for invitation and device authentication,
  MLS add/remove/update epochs, durable replay rejection, exact resume ordering,
  membership barriers, malformed-frame rejection, and encrypted game events.
- `wrangler.toml` still points at `src/index.ts`.
- `client/dist` was produced by the current commit.
- The Durable Object migration list still includes the `Room` class.
- The production state policy has no unresolved change required by this release.
- Analytics events still follow the privacy-safe beta contract.
- If Fort Pass is enabled, Stripe Checkout and the signed webhook endpoint are
  configured together.
- `/api/fort-pass/status` reports `checkoutConfigured: true` before Fort Pass
  is promoted outside quiet beta. This requires Checkout and webhook secrets.

Optional but recommended before a marketing push:

- `npm run test:design-snapshots`
- `npm run test:ui`

## Preflight Commands

From the repo root:

```bash
npm install
cd client
npm install
cd ..

npm run typecheck
npm test
npm run build
```

Confirm Cloudflare auth before deploying:

```bash
npx wrangler whoami
```

Deploy:

```bash
npm run deploy
```

## Manual Smoke Test

Run this against the deployed URL, not only local development:

1. Open the home screen on desktop.
2. Create a fort with the locked, generated `pf2_` room secret.
3. Copy the flag and secret from the intentional room controls; confirm the
   secret is masked unless revealed.
4. Join from a second browser profile or device.
5. Approve the pending device from the host, compare the displayed safety
   fingerprints out of band, then send one styled message from each participant
   and confirm text and style arrive in order.
6. Start one lightweight game, preferably Rock Paper Scissors.
7. Disconnect and reconnect one participant inside the grace window.
8. Change presence to away and back.
9. Knock the fort down as host.
10. Confirm the old room cannot be rejoined as an active room.

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
  IndexedDB under an exclusive per-room Web Lock. Storage, lock, revision, or
  decode failures stop delivery and sending instead of reverting to volatile
  state.
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

- Watch Worker logs for uncaught exceptions.
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
- Keep the paid SKU private until there is a written refund/support process and
  one successful production-mode Stripe test purchase.
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
2. Deploy the last known good commit with `npx wrangler deploy`.
3. Verify create, join, chat, reconnect, and knock-down on the rolled-back URL.
4. Preserve logs from the failed deploy before they age out.
5. Write the incident summary in `docs/` or the issue tracker before retrying.

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
