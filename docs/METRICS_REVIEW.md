# Metrics Review

> Current protocol-v4 correction: protected room, invite, message and game events
> are not emitted through public analytics. The room-funnel questions and ratios
> below are historical and cannot be computed from current logs. The report is
> useful only for events actually emitted, such as commerce/configuration and
> permitted operations. For activation and repeat use, follow the consenting-host
> cohort in [GTM_MARKETING_PLAN.md](GTM_MARKETING_PLAN.md); do not restore private
> activity logging to populate this historical funnel.

Pillowfort's beta metrics are intentionally lightweight. The app emits
privacy-safe `[analytics]` log lines, and the weekly review summarizes those
logs without storing room IDs, passwords, names, message text, or checkout IDs.

## Weekly Command

Never save a raw Cloudflare tail: authorized real-time events can include the
request URL even though automatic invocation-log persistence is disabled. Pipe
the live stream directly into the report, which retains only sanitized
`[analytics]` event bodies and aggregate counts:

```bash
wrangler tail pillowfort --format pretty | npm run metrics:report --
```

## Review Questions

- Are people creating rooms?
- Are hosts copying invites?
- Are guests joining after invites are copied?
- Are rooms reaching first message and first game?
- Are activation nudges increasing invite copy or game starts?
- Are Fort Pass checkout starts returning from Stripe?
- Are scanner, WebSocket, room-join, or webhook failures spiking?

## Weekly Readout

Record these counts every week:

- `room_created`
- `invite_copied`
- `guest_joined`
- `first_message_sent`
- `game_started`
- `room_knocked_down`
- `activation_nudge_shown`
- `activation_nudge_clicked`
- `fort_pass_code_checked`
- `fort_pass_checkout_started`
- `fort_pass_checkout_failed`
- `fort_pass_checkout_returned`

The report script also groups failure reasons for failed checkout, room-join,
and operational events.

## Decision Rules

- If `guest_joined / room_created` is low, improve invite copy and first-run
  clarity before adding more games.
- If `game_started / room_created` is low but rooms have guests, improve the
  in-room game prompt and default game choices.
- If Fort Pass checkouts start but do not return, inspect Stripe abandonment,
  webhook delivery, and setup copy.
- Review password usability through opt-in user feedback, not room-scoped
  failure logs; the WebSocket path intentionally emits no provider logs.
