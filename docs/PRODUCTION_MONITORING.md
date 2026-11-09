# Production Monitoring

Pillowfort has opt-in OpenTelemetry traces, aggregate room-volume metrics and
granular hosted MCP tool metrics, alongside privacy-safe `[analytics]` structured
logs. Production OTel export requires a stable authenticated collector ingress;
instrumentation being deployed does not mean production collection is enabled.
Neither path exports message contents, identities, room codes, credentials or
invitation material.

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
and MCP diagnostic traces but intentionally leaves aggregate volume and MCP tool
metrics enabled. Follow the root
[operational setup](../README.md#operational-telemetry) before enabling production.
No production room-volume history can be recovered from before collection.

## Hosted MCP tool calls

The dashboard's **Hosted MCP tool execution** section covers completed hosted
`tools/call` invocations, including validation failures and unknown tools.
It does not count initialization, tool listings, HTTP requests or local stdio
agent usage. One HTTP request is not necessarily one tool invocation.
Success/error describes the dispatcher result, including a returned
`{ok:false,error:{code}}`, not eventual completion of a queued room action.
Duration measures the actual invocation through validation and execution;
`session_wait` includes time spent waiting, while a queued action only measures
the call that queues it.

Every completed call emits a `mcp.tool.call` internal span in the always-on
`pillowfort.mcp.tools` scope, independently of `OTEL_SAMPLE_RATE`. The dedicated
`span_metrics/mcp_tools` connector receives only this scope, generates cumulative
counts and duration histograms in seconds, and emits no exemplars. These spans
**never go to Tempo**. A separate `pillowfort.mcp.tools.trace` diagnostic span is
sampled according to `OTEL_SAMPLE_RATE` and goes only to Tempo; it never generates
a second metric observation. Existing HTTP metrics accept only
`pillowfort.operational` spans, so tool calls do not inflate HTTP counters.

The collector accepts only service `pillowfort.hosted-mcp`, the fixed span name
and internal kind, and `production`, `development` or `test`. Its exact tool
allowlist mirrors [`agents/tools.json`](agents/tools.json); callers normalize
unknown requested names to `_unknown`, never the submitted name. Update that
collector allowlist when changing the tool catalog.

| Attribute / Prometheus label | Allowed values |
| --- | --- |
| `pillowfort.tool` / `pillowfort_tool` | Catalog tool names or `_unknown` |
| `pillowfort.outcome` / `pillowfort_outcome` | `success`, `error` |
| `pillowfort.error` / `pillowfort_error` | `none`, `invalid_input`, `unknown_tool`, `busy`, `quota`, `timeout`, `connection`, `session`, `internal` |

Success requires error `none`; failure requires a non-`none` category. Only these
three span attributes survive sanitization. Resource fields use the existing
service/environment and validated version/SDK allowlist. The collector strips
scope attributes/version, extra span attributes, status messages, trace state,
parent links, events and span links before aggregation or storage. No tool
arguments, results, exception text/stacks, message content, IDs, credentials,
client identities, room/session identifiers or arbitrary error codes are kept.
Diagnostic trace IDs are generated opaque correlation values, not client IDs.

Prometheus names under the collector's `pillowfort.mcp_tools` namespace are:

- `pillowfort_mcp_tools_calls_total`
- `pillowfort_mcp_tools_duration_seconds_bucket`
- `pillowfort_mcp_tools_duration_seconds_sum`
- `pillowfort_mcp_tools_duration_seconds_count`

`observability/prometheus.yaml` must also allow these metric families through its
metric-relabel filter. Collector exposure alone does not prove Prometheus stores
them. Deploy the updated scrape configuration and reload Prometheus with SIGHUP.

Dimensions are only tool, outcome, error, service and environment; default span
name/kind/status and collector-instance dimensions are excluded. The connector
caps aggregate cardinality at 4096, flushes every 15 seconds and does not expire
idle tool series. Histogram boundaries are 5, 10, 25, 50, 100, 250 and 500 ms, then
1, 2, 5, 10, 30 and 60 seconds (plus the overflow bucket). Dashboard p50/p95 are
bucket estimates over received calls, not exact per-call measurements. All
panels honor the environment and service selectors; selecting app or marketing
alone correctly shows no hosted tool telemetry.

Collector totals are received calls since its last reset, not time-picker totals,
lifetime totals or billing records. Rate and latency panels use the selected
range. Collector restarts lose in-memory counters/histograms; Prometheus retains
previously scraped history for seven days. Bounded exporters, collector memory
pressure, cardinality limits and outages can drop telemetry; calls still execute
and are not retried for telemetry. Missing series are unknown coverage, not zero.
There is no backfill, no per-user/session analysis and no diagnostic traces when
`OTEL_SAMPLE_RATE=0`. `OTEL_ENABLED=false` stops every telemetry stream.

### Live activation

These repository changes do not activate a running collector or deploy a Worker.
Use the existing authenticated ingress and explicit production settings in the
root [operational setup](../README.md#operational-telemetry). On the telemetry
host, deploy the updated `observability/collector.yaml`,
`observability/prometheus.yaml` and dashboard JSON. Restart the collector using
the existing compose/env-file deployment; Grafana's provisioner reloads dashboard
files every 30 seconds. Reload Prometheus with SIGHUP. Restarting the collector
resets room, HTTP and tool counter epochs without deleting scraped history.
Deploy the hosted-MCP Worker with its telemetry wrapper and preserved production
secrets; do not enable local development export.

After activation, select the correct environment and `pillowfort.hosted-mcp` in
Grafana. Confirm fresh tool counters and latency buckets after an authorized
tool call, and sampled tool diagnostics when the sample rate is nonzero.
At rate zero, counters/histograms should still advance without new HTTP/tool
diagnostic traces. Confirm room and HTTP panels retain their existing behavior;
deployment success alone is not evidence of telemetry receipt. Use `test` for
isolated synthetic validation. An explicitly authorized, bounded production
receipt smoke contributes synthetic production counts; do not interpret those
as organic usage. Checked-in configuration alone implies no live receipt.

Production receipt was verified on 2026-11-06 with hosted Worker version
`206903ad-3ba2-4160-bc3a-73e13606426e`: successful calls, returned invalid-input
failures and thrown unknown-tool failures reached Prometheus. A 1.2-second
`session_wait` produced a 1.2-second duration observation. Sampled tool spans
reached Tempo with only the three allowed span attributes; the unsampled metrics
scope had no matching stored traces. These were synthetic smoke calls, not organic
usage; the temporary participant was closed and access grants revoked.

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
