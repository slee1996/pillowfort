# Production Monitoring

Pillowfort has opt-in OpenTelemetry traces and aggregate room-volume metrics,
alongside privacy-safe `[analytics]` structured logs. Production OTel export
requires a stable authenticated collector ingress; instrumentation being deployed
does not mean production collection is enabled. Neither path exports message
contents, identities, room codes, credentials or invitation material.

## Room and message volume

The Grafana **Pillowfort · Operations and room volume** dashboard uses
`pillowfort_volume_calls_total`, split only by fixed activity, service and
environment labels (plus fixed collector/scope labels).

| `pillowfort_activity` | What increments it |
| --- | --- |
| `room.created` | A new protocol-v4 room successfully commits its initial state. DO construction, hibernation restores and rejected setup do not count. |
| `room.retired` | An open room commits retirement or is successfully removed by idle cleanup. Repeated close ACKs and subsequent cleanup do not count again. |
| `member.admitted` | A new member's join proof is accepted and published after host approval. Founders, resumes and replayed approvals do not count. |
| `application.accepted` | A new ordinary encrypted application event is accepted and published, once regardless of recipient count. Includes chat, typing, presence, drawing and games—not chat-only messages. |

Both the production room DO and local Bun server emit these counts after their
authoritative state boundary. Retry acknowledgements, delivery acknowledgements,
backlog replay, welcome/bootstrap, membership commits and host-transfer control
frames do not add ordinary application-event counts. Plaintext is not inspected
and no room, member, device, session or invitation identifier enters the exporter.

Count events use an always-on sampler, independently of HTTP trace sampling.
They travel over OTLP's trace transport to a dedicated collector pipeline that
validates the fixed vocabulary and strips other fields. It aggregates counters
without sending these events to Tempo or attaching trace exemplars.

Dashboard stat totals are received events since collector reset, not selected
range totals or lifetime product totals. Rate charts follow the time picker.
The four bounded counter streams do not expire merely because a room goes idle;
collector restart resets them. Prometheus retains scraped history for seven
days. Export is bounded/best-effort and can drop events under overload or outage.
Missing series mean unknown coverage, not zero usage. Never infer current
occupancy from creations minus retirements: collection may start mid-room.

Set `OTEL_ENABLED=false` to stop all export. `OTEL_SAMPLE_RATE=0` stops HTTP
traces but intentionally leaves aggregate volume enabled. Follow the root
[operational setup](../README.md#operational-telemetry) before enabling production.
No production room-volume history can be recovered from before collection.

## Operational Buckets

Watch these event names in Cloudflare logs:

- `probe_blocked`: scanner traffic blocked before assets, rooms, or APIs.
- `ws_rejected`: malformed WebSocket entry attempts.
- `room_setup_failed`: rejected room creation attempts.
- `room_join_failed`: rejected joins, including bad password and full room.
- `stripe_webhook_failed`: Stripe webhook configuration, payload, signature, or
  fulfillment failures.
- `fort_pass_code_checked`: client-side custom-code availability checks.
- `fort_pass_status_checked`: setup screen checked whether paid beta checkout is
  configured.
- `fort_pass_checkout_started`: host clicked through to Checkout.
- `fort_pass_checkout_failed`: checkout could not start from the setup screen.
- `fort_pass_checkout_returned`: Stripe success redirect reached Pillowfort.
- `activation_nudge_shown` / `activation_nudge_clicked`: first-room and
  first-game prompts.
- `discord_activity_detected`: Activity launch context was detected without
  logging Discord IDs.

This catalog includes legacy room-funnel names. Protocol-v4 private room paths
do not emit those setup/join log events; use the aggregate counters above for
volume, not absent legacy logs. The thresholds below are operator guidance,
not alerting rules provisioned by this repository.

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
