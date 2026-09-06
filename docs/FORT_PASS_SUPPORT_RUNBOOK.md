# Fort Pass Support Runbook

Use this internal runbook for the first paid Fort Pass beta. Keep the support
posture simple: one paid room upgrade, accountless guests, manual refunds,
and no plaintext server chat history. This document is not a published
customer refund policy or a monitored support channel.

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

## Paid Promotion Gate

Keep paid promotion blocked until:

- An owner approves and publishes the customer refund policy and a monitored
  support destination, assigns a response owner, and makes both discoverable
  before purchase. Align Stripe receipts/business support details with that
  destination. No public support endpoint currently exists in the repository;
  do not invent one or treat this internal runbook as a substitute.
- The purchase explanation states that Fort Pass upgrades one temporary room,
  guests do not pay, codes are not permanently owned, and checkout must finish
  in the originating tab. Publish the approved recovery/refund terms rather
  than promising secret or account recovery.
- The intended live deployment's price, credentials, Checkout return origin,
  and required webhook subscriptions are verified, and an authorized live
  same-tab purchase, return, redemption, and refund are observed end to end.
  Historical sandbox results and a configured status response are not proof.

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

The following is an internal beta recommendation, not a published commitment.
The owner must approve the actual policy and refund window before paid
promotion. Until then, do not present these recommendations as customer terms.

Recommended handling:

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
- Room teardown deletes live room state and the encrypted delivery backlog,
  but retains minimal payment/redemption integrity records, including refunded
  tombstones, to prevent replay or an older purchase affecting a newer one.
  It does not imply deletion of Stripe records or operational metadata.

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
- Confirm the endpoint subscribes to `checkout.session.completed`,
  `charge.refunded`, and `charge.dispute.created` in the correct Stripe mode.
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

Before enabling Fort Pass publicly, satisfy the paid promotion gate above and
record these checks (do not infer dashboard configuration from this document):

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Complete one test-mode Stripe purchase against the deployed URL.
- Verify `checkout.session.completed`, `charge.refunded`, and
  `charge.dispute.created` are all enabled on the deployment's Stripe webhook
  endpoint, with matching API and signing credentials.
- Verify the configured one-time amount, currency, and applicable tax
  presentation match the buyer-facing offer; a sandbox price is not live proof.
- Confirm `/api/stripe/webhook` rejects unsigned payloads.
- Confirm a signed paid event makes the code unavailable.
- Confirm partial refund, full refund, and dispute events revoke only their
  exact Checkout Session, remove paid perks without destroying the active
  encrypted room, and are safe to replay. Use separate test-mode purchases.
- Deliver a verified refund before completion fulfillment; then deliver and
  replay completion and confirm the refunded purchase cannot grant or redeem.
- Replay completion after redemption and after refund; confirm no duplicate
  grant or resurrection. Replay older refund/dispute events after a newer
  purchase uses the code; confirm the newer entitlement remains unaffected.
- Confirm the checkout success return creates the paid room in the same tab
  that started Checkout.
- Confirm copied success URLs cannot redeem without the originating tab secret.
- Confirm setup without either the Checkout Session ID or the matching claim
  secret is rejected.
- Complete and observe an authorized live same-tab purchase, return,
  redemption, and refund on the intended public deployment before paid
  promotion. Keep dispute and ordering exercises in test mode; do not create
  a live dispute merely to verify the integration.

## Support Copy

Use concise copy:

- "Fort Pass upgrades one disposable room."
- "Guests do not need accounts or payment."
- "Paid rooms are still temporary."
- "Room content is end-to-end encrypted. Ending a fort deletes its live room
  state and encrypted delivery backlog; minimal payment integrity records
  remain."
- "We cannot recover room passwords or restore a knocked-down fort."

Avoid copy that implies:

- Permanent code ownership.
- Recoverable room history.
- User accounts.
- Stronger privacy because the room is paid.
