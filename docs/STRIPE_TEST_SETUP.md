# Stripe Test Setup

This records the current non-secret Stripe and Cloudflare setup for the Fort
Pass beta path.

Configured on May 3, 2026.

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
- Enabled event: `checkout.session.completed`

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

## Smoke Results

Completed against the deployed Worker:

- `GET /api/fort-pass/code?code=smoke-1` returned available.
- `POST /api/fort-pass/checkout` created a Stripe Checkout Session.
- Unsigned `POST /api/stripe/webhook` was rejected with
  `bad_webhook_signature`.
- Stripe CLI triggered a test `checkout.session.completed` event with Fort Pass
  metadata for `smoke-2`.
- `smoke-2` became unavailable after webhook fulfillment.
- Deployed WebSocket setup redeemed `smoke-2` using the Checkout Session ID.
- Paid room switched to `retro-green`.
- Smoke room was knocked down and `smoke-2` became available again.

## Manual Test Purchase

For a browser purchase smoke:

1. Open `https://pillowfort.spencerlee96.workers.dev`.
2. Enter a screen name and choose `Set Up Fort`.
3. Enter an available custom Fort Pass code.
4. Choose `Upgrade`.
5. Complete Stripe Checkout with a Stripe test card.
6. Return to Pillowfort and create the room.
7. Confirm the host can switch to `retro-green` or `midnight`.

Use Stripe test card data from Stripe's dashboard/docs. Do not use a real card
against the sandbox setup.
