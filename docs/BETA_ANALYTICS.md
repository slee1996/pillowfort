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

Allowed properties:

- `kind`: sanitized game/event kind.
- `role`: `host` or `guest`.
- `source`: sanitized UI source.
- `memberCount`: integer from 0 to 1000.
- `queueDepth`: integer from 0 to 1000.
- `mobile`: boolean.

All other properties are dropped by both client and server sanitizers.

## Current Backend Behavior

The backend validates the event and writes a sanitized log line. There is no
database or user profile. This is enough for early beta measurement through
platform logs and keeps the implementation reversible.

If the product needs dashboards later, add a storage/export layer behind this
same sanitized event contract.
