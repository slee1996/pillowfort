# Metrics Review

Pillowfort's beta metrics are intentionally lightweight. The app emits
privacy-safe `[analytics]` log lines, and the weekly review summarizes those
logs without storing room IDs, passwords, names, message text, or checkout IDs.

## Weekly Command

Save a Cloudflare log sample, then run:

```bash
npm run metrics:report -- cloudflare-tail.log
```

Or pipe logs directly:

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
- If room joins fail frequently with `wrong_password`, make invite/password
  copy clearer without weakening the password model.
