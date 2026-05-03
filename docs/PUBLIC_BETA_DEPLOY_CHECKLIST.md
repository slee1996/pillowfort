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
- `wrangler.toml` still points at `src/index.ts`.
- `client/dist` was produced by the current commit.
- The Durable Object migration list still includes the `Room` class.
- The production state policy has no unresolved change required by this release.
- Analytics events still follow the privacy-safe beta contract.
- If Fort Pass is enabled, Stripe Checkout and the signed webhook endpoint are
  configured together.

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
2. Create a fort with a password.
3. Copy the invite from the room UI.
4. Join from a second browser profile or device.
5. Send one message from each participant.
6. Start one lightweight game, preferably Rock Paper Scissors.
7. Disconnect and reconnect one participant inside the grace window.
8. Change presence to away and back.
9. Knock the fort down as host.
10. Confirm the old room cannot be rejoined as an active room.

Mobile smoke:

1. Create or join a room on a narrow viewport.
2. Send a message.
3. Open and close the member/game surfaces.
4. Copy invite details.
5. Confirm no primary controls overlap.

Paid smoke, only if Fort Pass is enabled:

1. Check an available custom code with `/api/fort-pass/code?code=party-1`.
2. Start checkout for that code.
3. Complete a test Checkout Session.
4. Confirm Stripe sends a signed `checkout.session.completed` event to
   `/api/stripe/webhook`.
5. Confirm the same code now reports `taken`.
6. Confirm the checkout success redirect includes `fort_pass=success`, `code`,
   and `session_id`.
7. Set up the paid room from the success flow and verify the extended idle
   entitlement applies.
8. As host, switch to a premium theme and confirm another joined browser sees
   the same room theme.

## Privacy Checks

Before public traffic:

- Do not log plaintext chat content.
- Do not log room passwords.
- Do not log derived encryption keys.
- Do not log raw room codes in analytics.
- Do not add persistent user identity for free rooms.
- Keep `/analytics` same-origin and sanitized.
- Keep privacy copy precise: messages can be encrypted, but metadata still
  exists.

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

- Room access, auth verifier, member socket attachments, idle deadline, and
  active Saboteur bomb deadline must survive Durable Object wake-up.
- Leaderboards, active games, and queued game state may reset after hibernation
  during beta.

## Observability Checks

Immediately after deploy:

- Watch Worker logs for uncaught exceptions.
- Confirm `/analytics` accepts known events and rejects unknown events.
- Confirm sanitized analytics log lines do not include names, room codes,
  passwords, or message text.
- Confirm `/api/fort-pass/code?code=party-1` returns only availability data and
  uses `cache-control: no-store`.
- If Stripe is not configured, confirm `/api/fort-pass/checkout` returns
  `checkout_not_configured`.
- If Stripe is configured, confirm checkout creation returns only `code`,
  `checkoutUrl`, and `sessionId`.
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
