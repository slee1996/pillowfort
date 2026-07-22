# Fort Pass Support Runbook

Use this runbook for the first paid Fort Pass beta. Keep the support posture
simple: one paid room upgrade, accountless guests, manual refunds, no chat
history storage.

## Support Scope

Fort Pass support covers:

- Checkout started but did not complete.
- Checkout completed but the custom code did not unlock.
- Buyer returned from checkout but lost the setup page.
- Buyer wants a refund.
- Custom code was paid for but cannot be used.

Fort Pass support does not cover:

- Recovering chat history.
- Recovering room passwords.
- Identifying anonymous guests.
- Restoring a knocked-down fort.
- Permanent ownership of a room code.

## Information To Collect

Ask for the smallest useful set:

- Checkout Session ID, if visible in the return URL or receipt.
- Custom room code.
- Approximate purchase time.
- Contact email only if the buyer wants a reply.

Do not ask for:

- Room password.
- Fort Pass claim secret or browser `sessionStorage` contents.
- Chat message content.
- Encryption keys.
- Guest names unless the buyer volunteers them as context.

## Refund Policy

For the beta, refund quickly and manually.

Recommended rule:

- Refund any Fort Pass request within the paid room window unless there is clear
  abuse.
- If the room already worked, still favor refunding during beta.
- Treat refunds as learning cost, not a support argument.

Current product behavior:

- Signed Stripe `charge.refunded` events for partial or full refunds and
  `charge.dispute.created` events are verified against Stripe's current Charge,
  PaymentIntent, and Checkout Session before revocation.
- The exact current entitlement becomes a durable `refunded` tombstone. Premium
  themes and extended idle time are removed immediately without destroying an
  active encrypted room.
- Delayed events for an older Checkout Session cannot revoke a newer owner.
- Provider/API outages return a retryable webhook error rather than silently
  accepting an unverified revocation.

## Common Cases

### Checkout Not Configured

Symptom:

- The setup screen shows `Checkout is not configured.`
- API returns `{ "error": "checkout_not_configured" }`.

Action:

- Confirm `STRIPE_SECRET_KEY`, `FORT_PASS_PRICE_ID`, `PUBLIC_BASE_URL`, and
  `STRIPE_WEBHOOK_SECRET` are set in the deployed environment.
- Keep Fort Pass private until the production-mode paid smoke test passes.

### Checkout Completed, Code Still Available

Symptom:

- Buyer paid.
- `/api/fort-pass/code?code=...` still returns `available: true`.

Likely cause:

- Stripe webhook was not delivered or was rejected.

Action:

- Check Worker logs for `/api/stripe/webhook`.
- Confirm the webhook secret matches the deployed endpoint.
- Confirm the event is `checkout.session.completed` with `payment_status:
  paid` and Fort Pass metadata.
- Retry or replay the provider event if available.

### Paid Code Requires Redemption

Symptom:

- Websocket setup returns `paid room redemption required`.

Likely cause:

- Buyer is setting up the paid code outside the browser tab that started
  Checkout, so the tab-scoped claim secret is missing.
- Someone else learned the code and tried to claim it.

Action:

- Ask the buyer to return to the same tab that started Checkout. Cancelling the
  Setup screen keeps a same-tab recovery record until setup succeeds.
- A copied success URL or Session ID is intentionally insufficient. Never ask
  the buyer to send the claim secret; if the originating tab is gone, refund
  manually during beta.

### Code Taken After Payment

Symptom:

- Buyer paid for a code but setup says the fort already exists.

Likely causes:

- The paid room was already redeemed.
- A live room exists with that code.

Action:

- Ask whether the buyer or their group already created the fort.
- If not resolved quickly, refund manually.

## Operational Checks

Before enabling Fort Pass publicly:

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Complete one test-mode Stripe purchase against the deployed URL.
- Confirm `/api/stripe/webhook` rejects unsigned payloads.
- Confirm a signed paid event makes the code unavailable.
- Confirm partial refund, full refund, and dispute events revoke only their
  exact Checkout Session and are safe to replay.
- Confirm setup from the checkout success URL creates the paid room.
- Confirm copied success URLs cannot redeem without the originating tab secret.
- Confirm setup without either the Checkout Session ID or the matching claim
  secret is rejected.

## Support Copy

Use concise copy:

- "Fort Pass upgrades one disposable room."
- "Guests do not need accounts or payment."
- "Paid rooms are still temporary."
- "We do not store chat history or room passwords."

Avoid copy that implies:

- Permanent code ownership.
- Recoverable room history.
- User accounts.
- Stronger privacy because the room is paid.
