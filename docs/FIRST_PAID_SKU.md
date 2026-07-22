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
- Premium social-skin pack.

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
  webhook payloads, resolves paid entitlements, and authoritatively binds
  refund/dispute revocations through Charge, PaymentIntent, and Checkout
  Session records.
- `GET /api/fort-pass/code?code=...` checks whether a custom code is valid and
  not already occupied by a live room.
- `GET /api/fort-pass/status` returns non-secret beta readiness data so the
  setup UI can keep checkout disabled unless Checkout and signed webhook
  fulfillment are both configured.
- `POST /api/fort-pass/checkout` validates and atomically reserves the requested
  custom code plus a client-generated SHA-256 claim hash for a bounded
  40-minute checkout window. The originating tab keeps the 256-bit raw claim
  secret in `sessionStorage`; raw claim material is never sent to Stripe or
  persisted by the server. If Stripe config is
  present, it creates a hosted one-time Checkout Session that expires after 31
  minutes. Ambiguous provider failures retain the reservation until expiry so a
  session created just before a timeout cannot later charge for a reallocated
  code. If Stripe is not configured, it returns `checkout_not_configured`.
- `POST /api/stripe/webhook` verifies Stripe's raw-body signature before
  granting any entitlement. It independently retrieves the exact Checkout
  Session and verifies payment status, mode, environment, room binding,
  quantity, amount, currency, and configured Price ID. Fulfillment uses a
  durable per-Session claim ledger plus a room redemption tombstone, so retries
  and post-teardown replays cannot grant the same purchase twice.
- Signed `charge.refunded` (partial or full) and
  `charge.dispute.created` events are independently retrieved from Stripe and
  bound to the exact Charge, PaymentIntent, one Checkout Session, configured
  Price, room, amount, currency, and test/live mode. A separate durable event
  ledger makes retries idempotent. Revocation persists a refunded entitlement
  tombstone, removes premium themes/idle time immediately, and never destroys
  the encrypted room. A delayed event for an older Checkout Session cannot
  revoke a newer owner.
- The local Bun runtime checks the in-memory room map.
- The production Worker asks the target Durable Object for a minimal
  `{ exists: boolean }` status and returns only `available` / `reason`.
- The local Bun runtime stores webhook-confirmed entitlements in memory until
  the paid room is created.
- The production Durable Object stores webhook-confirmed entitlements in
  Durable Object storage before the room is set up.
- The Checkout success redirect carries `code` and `session_id` back to the
  client, but neither value is redemption authority. The client unlocks setup
  only after the bounded redemption endpoint retrieves the exact paid Session
  and constant-time verifies the originating tab's raw claim secret against
  the provider-bound hash. Copying the return URL into another tab therefore
  cannot redeem or set up the paid room.
- The setup screen includes the first host-facing Fort Pass entry point: enter a
  custom code, start Checkout, and return through the accountless redemption
  flow.
- The setup screen checks Fort Pass status before enabling the paid beta
  checkout button.
- Paid rooms expose the `retro-plus` skin pack. The host can switch room theme
  to `campus-blue` or `top-8`, and the room broadcasts the selected theme to
  connected members.

This does not add guest accounts. A redirect alone is never proof of payment;
both webhook and checkout-return paths independently retrieve Stripe's current
provider objects before changing entitlement state.

Entitlement state should include:

- Payment provider checkout/session ID.
- Host identity or email.
- Entitlement type.
- Room code or room ID it applies to.
- Expiration time.
- Fulfillment status.

Do not store:

- Chat message content.
- Room secret.
- Authentication signing seed or challenge proof.
- Derived encryption keys.

## Product Copy

Use direct host-focused copy:

- "Upgrade this fort"
- "Pick a custom room code"
- "Keep this room open longer"
- "Unlock social skins for tonight"

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

- Keep beta purchases manually refundable in Stripe; signed refund/dispute
  events revoke the app entitlement automatically.
- Keep the first SKU simple enough to explain in one sentence.

## Build Order

1. Add entitlement model and storage. Done for Fort Pass entitlement records.
2. Add custom-code validation and reservation. Done for live rooms and
   webhook-confirmed paid entitlements.
3. Add checkout and fulfillment. Done at the backend boundary through Stripe
   Checkout Session creation and signed webhook fulfillment.
4. Add the extended timeout entitlement. Done for active Fort Pass rooms.
5. Add a checkout success redemption path that proves the paying host is the
   party setting up the paid room. Done with a client-generated 256-bit
   tab-scoped claim secret; only its SHA-256 hash is bound into Stripe metadata
   and server-side entitlement state.
6. Add a host-only upgrade entry point in the frontend. Done as a compact Fort
   Pass custom-code checkout flow on setup.
7. Add premium skin selection. Done for Fort Pass rooms with `campus-blue` and
   `top-8` room themes.
8. Add refund/support notes to launch docs. Done in
   `docs/FORT_PASS_SUPPORT_RUNBOOK.md`.

Do not publicly promote Fort Pass until one production-mode Stripe smoke test
passes and the refund/support process has an owner. Today, the app can start
checkout, reserve, redeem, activate, and automatically revoke a paid custom code
after authoritative Stripe confirmation.

The beta redemption proof is a one-time, accountless browser capability rather
than the public Checkout Session ID. Losing the originating tab before setup
cannot be recovered by support; refund the purchase instead of asking the buyer
to disclose the raw claim secret.

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

This endpoint must not return room owner, room secret, authentication material,
member names, payment state, or any room metadata beyond availability.

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

The checkout endpoint intentionally does not create an entitlement. A signed
webhook or the server-side Checkout-return redemption path must independently
retrieve and verify the paid Session first.

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

Verified refund/dispute event:

```json
{ "received": true, "processed": true, "revoked": true }
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
- Session metadata contains the canonical SHA-256 claim hash supplied before
  Checkout; it never contains the raw claim secret.
- The independently retrieved line item has exactly one unit of the configured
  one-time Price with matching positive amount and currency.

Fulfillment records include provider/session references, active status, room
code, bounded expiration, extended idle timeout, and theme-pack entitlement.
They do not include chat content, room secrets, authentication material, or
encryption material.

### Redeem Paid Room

After checkout, Stripe redirects to:

```http
/?fort_pass=success&code=party-1&session_id=cs_test_...
```

The client first receives a one-use protocol-v4 `secure-auth-challenge`. It
creates the founder's device credential and one-use MLS KeyPackage, signs their
exact binding with the invitation key derived from the resolved canonical room
secret (generated by default or password-hardened from an explicit custom
password), and signs the setup challenge transcript. It sends the Checkout
Session ID alongside those proofs and the originating tab's raw claim secret.
The relay hashes the presented claim secret and compares the digest in constant
time with the bounded fulfillment record. The security-relevant shape is:

```json
{
  "kind": "secure-authenticate",
  "v": 4,
  "suite": 1,
  "mode": "setup",
  "frame": {
    "kind": "setup",
    "requestId": "<one-use admission id>",
    "signaturePublicKey": "<device credential public key>",
    "hello": "<room/device-bound one-use MLS KeyPackage>",
    "memberBinding": "<invitation-signed founder binding>"
  },
  "auth": "<challenge-bound invitation proof>",
  "fortPassSessionId": "cs_test_...",
  "fortPassClaimSecret": "<64 lowercase hex characters>"
}
```

The room secret and signing seed are never sent to Stripe or the Pillowfort
relay. The Fort Pass claim secret is sent only to the redemption/setup boundary
over HTTPS/WSS, is never logged or persisted there, and is erased from the tab
after setup. The Durable Object persists the invitation public key, public
member binding, and claim hash, never the raw claim secret or MLS private state.

Every human custom room code is paid-only. Setup is rejected unless an active
entitlement is bound to that exact code and `fortPassSessionId` matches the
provider session reference stored from the signed webhook, and the presented
claim secret matches the stored hash. Free rooms instead
use the disjoint `f-` plus ten-base32-symbol generated namespace:

```json
{ "type": "error", "message": "paid room redemption required" }
```
