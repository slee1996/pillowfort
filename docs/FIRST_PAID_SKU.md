# First Paid SKU

The first paid Pillowfort offer should monetize hosts, not guests. Guest joins
must stay accountless and free so invites keep converting.

## Recommended SKU

Name:

- `Fort Pass`

Buyer:

- The room host.

Promise:

- Make a disposable room feel more personal for one hangout without turning
  Pillowfort into a permanent workspace.

Initial perks:

- Custom room code.
- Longer room idle timeout.
- Premium theme pack.

Do not include in the first SKU:

- Message history persistence.
- Public room discovery.
- Guest accounts.
- Admin dashboards.
- Permanent communities.

Those features fight the disposable-room positioning and increase privacy,
moderation, and support burden.

## Why This SKU

Custom room code:

- Easy for hosts to understand.
- Easy to share out loud or in a group chat.
- Keeps the viral guest flow intact.
- Creates a clear paid/free distinction without limiting core chat.

Longer timeout:

- Useful for parties, game nights, and async pre-event setup.
- Monetizes host convenience rather than guest access.
- Should be bounded so rooms still feel temporary.

Theme pack:

- Fits the product's nostalgia/design wedge.
- Does not create gameplay imbalance.
- Can be expanded later without changing room infrastructure.

## Suggested Beta Entitlements

Free room:

- Random room code.
- Standard idle timeout.
- Standard theme set.
- Accountless host and guests.

Fort Pass room:

- One custom room code for the room.
- Extended idle timeout.
- Premium theme selector.
- Accountless guests.

Avoid promising permanent ownership of a code in the first beta. Start with
custom code reservation for the life of the room or for a short paid window.

## Pricing Test

Start with one simple offer:

- One-time room upgrade for a single hangout.

Early price hypothesis:

- Low enough for impulse purchase.
- High enough to validate willingness to pay.
- Easy to refund manually during beta.

Do not introduce multiple tiers until there is evidence that hosts understand
and want the first paid upgrade.

## Implementation Shape

Minimal standalone web implementation:

1. Add host identity only at the upgrade moment.
2. Create a checkout session for the selected upgrade.
3. Store the paid room entitlement outside chat message storage.
4. Apply entitlement checks in room creation and room settings.
5. Keep guests out of billing and account creation.

Current shared implementation primitives:

- `src/entitlements.ts` defines Fort Pass entitlement shape, custom room-code
  validation, active versus refunded/expired checks, bounded extended-timeout
  behavior, and availability result shape.
- `src/stripe.ts` creates Stripe Checkout Sessions, verifies signed Stripe
  webhook payloads, and converts paid Checkout Session events into Fort Pass
  entitlements.
- `GET /api/fort-pass/code?code=...` checks whether a custom code is valid and
  not already occupied by a live room.
- `POST /api/fort-pass/checkout` validates the requested custom code. If Stripe
  config is present, it creates a hosted one-time Checkout Session. If Stripe is
  not configured, it returns `checkout_not_configured`.
- `POST /api/stripe/webhook` verifies Stripe's raw-body signature before
  granting any entitlement. Only paid `checkout.session.completed` events with
  Fort Pass metadata are fulfilled.
- The local Bun runtime checks the in-memory room map.
- The production Worker asks the target Durable Object for a minimal
  `{ exists: boolean }` status and returns only `available` / `reason`.
- The local Bun runtime stores webhook-confirmed entitlements in memory until
  the paid room is created.
- The production Durable Object stores webhook-confirmed entitlements in
  Durable Object storage before the room is set up.
- The Checkout success redirect carries `code` and `session_id` back to the
  client so the buyer can redeem the paid code during room setup without an
  account.
- The setup screen includes the first host-facing Fort Pass entry point: enter a
  custom code, start Checkout, and return through the accountless redemption
  flow.
- Paid rooms expose the `retro-plus` theme pack. The host can switch room theme
  to `retro-green` or `midnight`, and the room broadcasts the selected theme to
  connected members.

This does not add guest accounts. The current fulfillment path deliberately
trusts Stripe webhooks, not client checkout success redirects, as the source of
truth for paid perks.

Entitlement state should include:

- Payment provider checkout/session ID.
- Host identity or email.
- Entitlement type.
- Room code or room ID it applies to.
- Expiration time.
- Fulfillment status.

Do not store:

- Chat message content.
- Room password.
- Derived encryption keys.

## Product Copy

Use direct host-focused copy:

- "Upgrade this fort"
- "Pick a custom room code"
- "Keep this room open longer"
- "Unlock retro themes for tonight"

Avoid copy that implies permanence:

- "Own this room forever"
- "Save your chat history"
- "Create your community"
- "Archive every message"

## Success Metrics

Activation:

- Upgrade button click rate.
- Checkout start rate.
- Checkout completion rate.

Revenue:

- Paid rooms per active host.
- Free-to-paid host conversion.
- Refund/support rate.

Product health:

- Guest join conversion should not drop.
- Room creation should not drop meaningfully.
- Hosts should still create free rooms without confusion.

## Risks

Custom code abuse:

- Reserve obvious offensive words.
- Rate-limit custom code attempts.
- Keep codes non-public and invite-only.

Privacy confusion:

- Make clear that paid rooms are still ephemeral.
- Do not imply stronger encryption because a room is paid.

Support burden:

- Keep beta purchases manually refundable.
- Keep the first SKU simple enough to explain in one sentence.

## Build Order

1. Add entitlement model and storage. Done for Fort Pass entitlement records.
2. Add custom-code validation and reservation. Done for live rooms and
   webhook-confirmed paid entitlements.
3. Add checkout and fulfillment. Done at the backend boundary through Stripe
   Checkout Session creation and signed webhook fulfillment.
4. Add the extended timeout entitlement. Done for active Fort Pass rooms.
5. Add a checkout success redemption path that proves the paying host is the
   party setting up the paid room. Done for beta with the Stripe Checkout
   Session ID from the success redirect.
6. Add a host-only upgrade entry point in the frontend. Done as a compact Fort
   Pass custom-code checkout flow on setup.
7. Add premium theme selection. Done for Fort Pass rooms with `retro-green` and
   `midnight` room themes.
8. Add refund/support notes to launch docs. Done in
   `docs/FORT_PASS_SUPPORT_RUNBOOK.md`.

Do not publicly promote Fort Pass until one production-mode Stripe smoke test
passes and the refund/support process has an owner. Today, the app can start
checkout, reserve, redeem, and activate a paid custom code after Stripe
confirmation.

Before a larger paid launch, decide whether the beta redemption proof is enough.
Matching the Checkout Session ID is appropriate for a low-risk beta; a larger
launch may want a one-time redemption token, a server-side Stripe session
lookup, or lightweight host identity.

## API Contract

### Check Custom Code

```http
GET /api/fort-pass/code?code=party-1
```

Available response:

```json
{ "code": "party-1", "available": true }
```

Invalid response:

```json
{ "code": null, "available": false, "reason": "invalid" }
```

Taken response:

```json
{ "code": "party-1", "available": false, "reason": "taken" }
```

Responses are `cache-control: no-store`.

This endpoint must not return room owner, room password, member names, payment
state, or any room metadata beyond availability.

### Start Checkout

```http
POST /api/fort-pass/checkout
content-type: application/json

{ "customRoomCode": "party-1" }
```

Invalid code:

```json
{ "error": "invalid_custom_room_code" }
```

Taken code:

```json
{ "error": "custom_room_code_taken", "code": "party-1" }
```

Provider not configured:

```json
{ "error": "checkout_not_configured", "code": "party-1" }
```

Provider configured:

```json
{
  "code": "party-1",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/...",
  "sessionId": "cs_test_..."
}
```

Full paid-flow environment:

- `STRIPE_SECRET_KEY`
- `FORT_PASS_PRICE_ID`
- `PUBLIC_BASE_URL`
- `STRIPE_WEBHOOK_SECRET`

This endpoint intentionally does not create an entitlement. Entitlements are
created only by the signed Stripe webhook path.

### Fulfill Checkout

```http
POST /api/stripe/webhook
stripe-signature: t=...,v1=...
content-type: application/json

{ "type": "checkout.session.completed", "data": { "object": { ... } } }
```

Provider not configured:

```json
{ "error": "webhook_not_configured" }
```

Bad or missing signature:

```json
{ "error": "bad_webhook_signature" }
```

Ignored event:

```json
{ "received": true, "ignored": true }
```

Fulfilled event:

```json
{ "received": true, "fulfilled": true, "code": "party-1" }
```

The webhook handler reads the raw request body, verifies the
`Stripe-Signature` HMAC within a five-minute tolerance, parses only verified
payloads, and grants Fort Pass only when all of these are true:

- Event type is `checkout.session.completed`.
- Session object is `checkout.session`.
- Session mode is `payment`.
- Session payment status is `paid`.
- Session metadata marks the entitlement as `fort-pass`.
- Session metadata contains a valid `custom_room_code`.

Fulfillment records include provider/session references, active status, room
code, bounded expiration, extended idle timeout, and theme-pack entitlement.
They do not include chat content, room passwords, or encryption material.

### Redeem Paid Room

After checkout, Stripe redirects to:

```http
/?fort_pass=success&code=party-1&session_id=cs_test_...
```

The client starts setup for `code` and sends the Checkout Session ID in the
initial websocket setup message:

```json
{
  "type": "set-up",
  "name": "alice",
  "auth": { "v": 1, "kdf": "pbkdf2-sha256-600k-v1", "verifier": "..." },
  "fortPassSessionId": "cs_test_..."
}
```

If an active Fort Pass entitlement exists for the room code, setup is rejected
unless `fortPassSessionId` matches the provider session reference stored from
the signed webhook:

```json
{ "type": "error", "message": "paid room redemption required" }
```
