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

Current product constraint:

- Refund fulfillment is not automated yet.
- Refunding in the payment provider does not currently revoke an already active
  room entitlement inside Pillowfort.
- Because Fort Pass is one-hangout state, this is acceptable for beta if support
  copy does not promise instant revocation.

Before a larger paid launch, add refund webhook handling that marks affected
entitlements as `refunded` and prevents unused refunded codes from being
redeemed.

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

- Buyer is setting up the paid code without the Checkout Session ID from the
  success URL.
- Someone else learned the code and tried to claim it.

Action:

- Ask the buyer to return from the checkout success URL or provide the Checkout
  Session ID.
- If the buyer cannot recover the success URL, refund manually during beta.

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
- Confirm setup from the checkout success URL creates the paid room.
- Confirm setup without the Checkout Session ID is rejected.

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
