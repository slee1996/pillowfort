# Beta Analytics

Pillowfort beta analytics are same-origin, privacy-safe funnel events. They are
intended to answer product questions without collecting chat content or user
identity.

## Goals

Measure whether rooms activate:

- Fort created.
- Guest joined.
- Invite copied.
- First message sent.
- Game started.
- Fort knocked down.
- Activation nudge shown and clicked.
- Fort Pass code checked.
- Fort Pass status checked; checkout started, failed, and returned.
- Discord Activity context detected.

## Non-Goals

Do not collect:

- Chat message text.
- Room passwords.
- Derived encryption keys.
- Screen names.
- Raw room codes.
- Persistent user accounts.

## Event Contract

The client posts JSON to `/analytics`.

Allowed event names:

- `room_created`
- `room_joined`
- `guest_joined`
- `invite_copied`
- `first_message_sent`
- `game_started`
- `room_knocked_down`
- `activation_nudge_shown`
- `activation_nudge_clicked`
- `fort_pass_code_checked`
- `fort_pass_status_checked`
- `fort_pass_checkout_started`
- `fort_pass_checkout_failed`
- `fort_pass_checkout_returned`
- `discord_activity_detected`
- `probe_blocked`
- `stripe_webhook_failed`
- `ws_rejected`
- `room_setup_failed`
- `room_join_failed`

Allowed properties:

- `kind`: sanitized game/event kind.
- `role`: `host` or `guest`.
- `source`: sanitized UI source.
- `reason`: sanitized failure or status reason.
- `surface`: sanitized runtime surface.
- `memberCount`: integer from 0 to 1000.
- `queueDepth`: integer from 0 to 1000.
- `status`: integer from 0 to 1000.
- `mobile`: boolean.

All other properties are dropped by both client and server sanitizers.

## Current Backend Behavior

The backend validates the event and writes a sanitized log line. There is no
database or user profile. This is enough for early beta measurement through
platform logs and keeps the implementation reversible.

Operational events are emitted through the same sanitizer so probes, webhook
failures, and join/setup failures stay measurable without logging secrets or
room metadata. See `docs/PRODUCTION_MONITORING.md` for suggested alert
thresholds.

For the current review loop, use `npm run metrics:report -- <log-file>` to turn
sanitized log lines into a Markdown funnel readout. If the product needs
dashboards later, add a storage/export layer behind this same sanitized event
contract.
