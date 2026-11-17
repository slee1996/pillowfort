# Pillowfort architecture

Pillowfort is an invite-only, temporary room for encrypted chat, drawing, and games.
There are no user accounts or public room directory. New devices require host
approval and do not receive earlier chat or drawings.

## Runtime boundaries

| Component | Role |
| --- | --- |
| React + Vite browser client | UI, device identity, encryption, and participant-visible state |
| `src/participant/` | Shared MLS engine, room controller, agent actions, drawing, and game logic |
| `server.ts` | Local Bun server and in-memory room runtime |
| `src/index.ts` and `src/room.ts` | Cloudflare request routing and Durable Object room runtime |
| `hosted-mcp/` | Managed, memory-only agent participants using the shared engine |
| `scripts/agent-sdk.mjs` | Local agents using isolated Playwright browser contexts |

The browser supplies IndexedDB, Web Locks, WebSockets, and rendering adapters.
Hosted MCP supplies memory storage, single-writer leases, and Worker WebSockets;
it does not run Chromium. Both are ordinary encrypted-room participants, not
privileged plaintext relay clients.

## Protocol and admission

Production accepts only protocol v4. There is no plaintext fallback or downgrade
to the older shared-key protocols. OpenMLS ciphersuite 1 protects application
events, including chat, drawing, presence, and games.

Setup and reconnect use fresh challenges and invitation- and device-bound
signatures. A new device also needs the current host's explicit approval of its
exact pending credential and KeyPackage, followed by an MLS Add. An invitation
permits an admission request; it does not establish recipient identity.

The relay coordinates authenticated membership, ordering, acknowledgements, and
bounded encrypted delivery. It sees routing identifiers, protocol/destination
classes, timing, counts, and padded ciphertext sizes, not application plaintext.
Participants persist cryptographic transitions before sending or acknowledging
dependent traffic. Removal commits act as delivery barriers.

The [protocol specification](docs/SECURE_ROOM_PROTOCOL_V4.md) is authoritative for
wire formats, admission, replay, recovery, and host succession. The
[technical appendix](docs/PROTOCOL_V4_TECHNICAL_APPENDIX.md) describes the security
model and its limits.

## State and lifetime

Temporary rooms still require state for safe delivery and recovery:

- **Relay:** production Durable Objects retain room/version bindings, public
  credentials, membership and host authority, causal delivery records, bounded
  opaque backlog, replay tombstones, throttles, and deadlines. Local Bun holds
  room state in process memory.
- **Browser:** revisioned, encrypted IndexedDB records retain MLS/application
  state and pending operations under a per-room Web Lock. Recovery requires the
  original credentials. Storage or lock failures fail closed; erasing a local
  room retains replay tombstones needed to reject stale reuse.
- **Agents:** local contexts are ephemeral; hosted participant identities and
  keys are memory-only. Hosted authorization, quota, and lifecycle metadata have
  a separate lifecycle. Lost participant identities are not silently recreated.
- **Commerce:** Fort Pass entitlement and payment/redemption records have a
  separate lifecycle from room content.

Encrypted recovery state is not a user-visible message archive for late joiners.
Ending a room retires it and closes its connections; lifecycle cleanup removes
live room state and backlog. It cannot erase participant exports, screenshots,
model histories, or copies held elsewhere.

See the [state policy](docs/PRODUCTION_STATE_POLICY.md) before changing persistence
or hibernation behavior.

## Host authority

A planned host transfer requires the selected member's explicit acceptance.
After unexpected host loss and the recovery window, the relay can offer authority
to an eligible connected member under the host-signed succession policy, in
admitted-member order. Delivery of an offer is not acceptance. If no eligible
member accepts, the room retires.

The relay controls liveness decisions and can deny progress; it cannot forge
the host's delegation or a successor's signature. See
[host succession](docs/SECURE_ROOM_PROTOCOL_V4.md#host-transfer-and-consent-based-succession).

## Trust boundaries

Encryption does not protect against a compromised endpoint, malicious
first-party JavaScript, or an admitted participant copying content. A hosted
agent deliberately places an endpoint under managed custody: its runtime,
operator, and model provider receiving results can access the content it sees.
See [agent security](docs/agents/security.md) and [security reporting](SECURITY.md).

## Working on the code

Keep local and production room behavior aligned when changing admission,
ordering, lifecycle, limits, or protocol handling. Use the shared participant and
protocol modules rather than introducing transport-specific room rules.

Start with `src/participant/`, `src/secureRelayV4.ts`,
`src/secureTransportV4.ts`, and `src/applicationEventsV4.ts`. Run the checks in the
[README](README.md#contributing); consult the
[verification matrix](docs/PROTOCOL_V4_VERIFICATION_MATRIX.md) for security coverage.
