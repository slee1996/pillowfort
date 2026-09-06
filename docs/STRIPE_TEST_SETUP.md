# Stripe Test Setup

This records the non-secret Stripe and Cloudflare setup observed for the Fort
Pass beta path on May 3, 2026. It is a historical record, not verification of
the current Stripe dashboard, deployed configuration, or live-mode readiness.

## Stripe Sandbox

Account label:

- `Pillowfort sandbox`

Product:

- Name: `Fort Pass`
- Product ID: `prod_URhHzgabHGrU6t`
- Mode: test
- Default price: `price_1TSntpK2Ii5OvPunnGBG1nRT`

Price:

- Price ID: `price_1TSntpK2Ii5OvPunnGBG1nRT`
- Amount: `$5.00`
- Currency: `usd`
- Type: one-time
- Nickname: `Fort Pass beta`

Webhook endpoint:

- Endpoint ID: `we_1TSnvxK2Ii5OvPunYNIj3eVY`
- URL:
  `https://pillowfort.spencerlee96.workers.dev/api/stripe/webhook`
- Enabled event recorded at the time: `checkout.session.completed`. This alone
  is insufficient for the current refund/dispute behavior; see the required
  subscriptions below.

Do not commit or paste:

- Stripe secret key.
- Stripe webhook signing secret.

## Cloudflare Worker

Deployed Worker URL:

- `https://pillowfort.spencerlee96.workers.dev`

Configured secret bindings:

- `STRIPE_SECRET_KEY`
- `FORT_PASS_PRICE_ID`
- `PUBLIC_BASE_URL`
- `STRIPE_WEBHOOK_SECRET`

## Historical Smoke Results

Completed against the deployed Worker on May 3, 2026:

- `GET /api/fort-pass/code?code=smoke-1` returned available.
- `POST /api/fort-pass/checkout` created a Stripe Checkout Session.
- Unsigned `POST /api/stripe/webhook` was rejected with
  `bad_webhook_signature`.
- Stripe CLI triggered a test `checkout.session.completed` event with Fort Pass
  metadata for `smoke-2`.
- `smoke-2` became unavailable after webhook fulfillment.
- Deployed WebSocket setup redeemed `smoke-2` using the Checkout Session ID.
- Paid room switched to `campus-blue`.
- Smoke room was knocked down and `smoke-2` became available again.

These historical smoke results predate the tab-scoped Fort Pass claim-secret
boundary and are not sufficient for a new release. Before re-enabling the paid
path, repeat the browser purchase below and verify that a copied success URL,
a missing/wrong claim secret, and a refund-before-fulfillment race all fail
closed.

## Required Configuration Before Purchase Verification

For each environment being exercised, verify in Stripe that the webhook
endpoint for that deployment subscribes to all three events:

- `checkout.session.completed`
- `charge.refunded`
- `charge.dispute.created`

Verify the endpoint signing secret and API key belong to the same environment,
and that `PUBLIC_BASE_URL` is the intended app origin for the Checkout return.
The historical endpoint above is not a decision about the public production
domain. Confirm the actual configured one-time price, amount, currency, and
applicable tax presentation match the offer shown to the buyer; the sandbox
price record is not evidence of a live price.

Do not treat `/api/fort-pass/status` reporting checkout configured as proof of
these provider-side settings or of successful payment/redemption.

## Manual Test Purchase

For a test-mode browser purchase smoke, after verifying the configuration above:

1. Open the deployment's configured canonical checkout origin. A `workers.dev`
   alias may intentionally report checkout unavailable.
2. Enter a screen name, choose `Start a new fort`, and expand `Optional: Fort Pass`.
3. Enter an available custom Fort Pass code.
4. Choose `Upgrade`.
5. Complete Stripe Checkout with a Stripe test card.
6. Return to Pillowfort in the same tab that started Checkout and create the
   room. Do not copy or collect the tab-scoped claim secret.
   If verification is pending, keep the original purchase and use `Retry payment
   verification` or `Resume saved checkout`; do not create another purchase.
7. Confirm the host can switch to `campus-blue` or `top-8`.
8. Repeat the success URL in a fresh tab and confirm it cannot redeem or create
   the paid room. Confirm a missing or wrong claim secret fails closed.
9. Replay the signed completion event and confirm it cannot grant a second
   entitlement or resurrect an already redeemed or refunded purchase.
10. With separate test purchases, exercise partial refund, full refund, and
    dispute events. Observe verified webhook delivery and removal of premium
    themes and extended idle time from the exact affected room without ending
    its encrypted session. Replay each event and confirm it remains safe.
11. Exercise refund-before-fulfillment: arrange for a verified refund event to
    arrive before completion fulfillment, then deliver and replay completion.
    Confirm the refunded purchase cannot grant or redeem a paid entitlement.
12. After a code is reused by a newer purchase, replay an older purchase's
    refund/dispute event and confirm the newer entitlement is unaffected.

Use Stripe test card data from Stripe's dashboard/docs. Do not use a real card
against the sandbox setup.

## Paid Promotion Gate

Paid promotion remains blocked until both of these external gates are met:

- An owner-approved, monitored customer support route and refund policy are
  published and discoverable before purchase, with matching Stripe support
  details. The repository currently provides an internal support runbook, not
  a public support endpoint. Do not invent a contact address or policy promise.
- The intended live deployment has verified live-mode credentials, return
  origin, price, and all three webhook subscriptions, and an authorized real
  same-tab purchase, return, redemption, and refund have been observed there.
  Record the outcome and verify refund delivery and correctly scoped
  revocation; test-mode history alone does not meet this gate.

Use the replay, dispute, and ordering scenarios above in test mode as release
evidence; do not manufacture a live dispute. See
`FORT_PASS_SUPPORT_RUNBOOK.md` for support readiness and recovery boundaries.
