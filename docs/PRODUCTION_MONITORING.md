# Production Monitoring

Pillowfort currently uses privacy-safe structured log lines instead of a full
metrics backend. Operational events are emitted as `[analytics]` JSON lines with
bounded names and sanitized props. They intentionally avoid room passwords,
message text, names, custom codes, checkout IDs, IP addresses, and user agents.

## Operational Buckets

Watch these event names in Cloudflare logs:

- `probe_blocked`: scanner traffic blocked before assets, rooms, or APIs.
- `ws_rejected`: malformed WebSocket entry attempts.
- `room_setup_failed`: rejected room creation attempts.
- `room_join_failed`: rejected joins, including bad password and full room.
- `stripe_webhook_failed`: Stripe webhook configuration, payload, signature, or
  fulfillment failures.
- `fort_pass_code_checked`: client-side custom-code availability checks.
- `fort_pass_checkout_started`: host clicked through to Checkout.
- `fort_pass_checkout_failed`: checkout could not start from the setup screen.
- `fort_pass_checkout_returned`: Stripe success redirect reached Pillowfort.

## Suggested Alert Thresholds

These are beta defaults. Tune them after a week of traffic.

- `stripe_webhook_failed` > 0 in 15 minutes: page the operator. Payment
  fulfillment is the revenue path.
- `room_setup_failed` with `reason=paid_redemption` > 2 in 15 minutes: inspect
  Stripe webhook delivery and success-redirect state.
- `room_join_failed` with `reason=wrong_password` > 20 in 15 minutes: likely
  invite/password confusion or abuse. Check support channels.
- `ws_rejected` > 50 in 15 minutes: likely malformed traffic or broken client
  deploy. Confirm current JS asset is loading.
- `probe_blocked` > 500 in 15 minutes: scanner burst. No immediate action if
  app health is normal, but keep an eye on Worker request volume.
- `fort_pass_checkout_started` without matching Stripe completed events for a
  day: inspect Stripe Checkout abandonment and copy clarity.

## Scanner Handling

The Worker and local server now block common commodity probes before they reach
assets or room Durable Objects:

- dotfiles such as `.env*`, `.git/*`, `.npmrc`, `.htaccess`, `.htpasswd`
- PHP shells and PHP info probes
- WordPress paths such as `wp-admin`, `wp-content`, and `wp-includes`
- `cgi-bin`
- path traversal attempts

Blocked probes return `404` with `cache-control: no-store` and security headers.

## Headers To Verify

All HTTP responses should include these headers. `wrangler.toml` sets
`assets.run_worker_first = true` so the app shell and static assets are routed
through the same header wrapper as API and scanner responses.

- `Content-Security-Policy`
- `Strict-Transport-Security`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`

Quick check:

```bash
curl -sS -I https://pillowfort.xyz/
curl -sS -I https://pillowfort.xyz/.env.prod
curl -sS -I https://pillowfort.xyz/api/fort-pass/code?code=party-1
```
