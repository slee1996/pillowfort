# Pillowfort secure room protocol v4

Status: implemented security contract.

Protocol-v4 rooms are intentionally incompatible with protocol v1-v3 rooms and
must be recreated. This document describes the current browser, relay, Durable
Object, and OpenMLS WASM implementation. It is a security design record, not a
claim that the system is invulnerable.

## Security goals

Protocol v4 uses MLS 1.0 (RFC 9420) with ciphersuite 1,
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Each browser device has its own
MLS signing and HPKE identity. The implementation is designed to provide:

- authenticated, per-device group membership with explicit Add, Remove, and
  Update commits;
- forward secrecy after obsolete generations and epochs have been erased;
- post-compromise recovery after a fresh update from an uncompromised member;
- end-to-end protection for member profiles, presence detail, chat, typing,
  drawings, themes, pillow tosses, host transfer, room close, queues, votes,
  RPS, tic-tac-toe, Saboteur, King of the Hill, and application snapshots;
- device-signed application events and deterministic state reducers;
- crash-safe, cross-tab replay and cryptographic state persistence;
- fail-closed membership, ordering, reconnect, and delivery state machines.

MLS does not hide transport metadata, make an authorized participant unable to
copy plaintext, protect a compromised browser, or make a malicious relay
available. Those boundaries are listed explicitly below.

## Identifiers and bounds

`roomInstance`, `deviceId`, and `messageId` are independent 128-bit random
values encoded as canonical unpadded base64url. A free transport room ID is
`f-` followed by ten lowercase RFC 4648 base32 symbols (50 random bits); the
whole `f-` namespace is reserved for generated rooms. A paid custom code is
4–10 characters and setup requires a live entitlement bound to that exact code
and redemption session.

The protocol accepts only version 4, ciphersuite 1, OpenMLS 0.8.1, KeyPackages
of at most 16 KiB, opaque relay payloads of at most 64 KiB, and complete
WebSocket frames of at most 96 KiB. Identifiers and base64url values are
strictly canonical. Unknown fields, wrong versions or suites, malformed
encodings, mismatched room instances, duplicate identifiers, invalid routes,
and oversized values fail closed.

WebSocket upgrade URLs accept exactly one `room` and one `protocol=4` query
parameter. Duplicate or unknown parameters—including secret/password-looking
keys—are rejected at the local edge, production edge, and Durable Object
boundary before room routing or upgrade.

Cloudflare automatic invocation logs are disabled and the WebSocket edge/room
path emits no custom console logs, preventing accepted room IDs or rejected
secret-looking query values from being persisted through application logging.
The hosting provider still necessarily processes request URLs and an authorized
real-time trace can expose them, so clients never place credentials in a URL;
the query rejection is defense in depth, not transport secrecy.

Authenticated traffic has independent five-second budgets: 100 raw frames per
socket, 256 raw frames across the room, and 30 client-initiated operations per
socket. Only an `order-request` consumes the operation budget because every
mutation-bearing MLS/application frame is causally preceded by one. Required
delivery ACKs, host decisions, admission controls, and granted relay frames
still consume the raw budgets, but are not charged a second time as initiated
operations. This bounds abuse without disconnecting passive recipients merely
for completing mandatory protocol fanout.

The first-party client defaults to a generated 32-byte invitation secret,
encoded as canonical `pf2_` plus 43 unpadded base64url characters. A host may
instead explicitly choose a custom password of 15–64 Unicode scalar values.
Custom input is NFC-normalized; leading/trailing whitespace, control/default-
ignorable/line-separator characters, lone surrogates, oversized UTF-8
encodings, noncharacters/non-ASCII separators, and malformed values in the
reserved `pf2_` namespace are rejected. New-room creation additionally rejects
common, repeated, sequential, low-diversity, and room/name-derived choices.
That strength policy is intentionally not applied while joining or deriving an
existing room: changing a future creation blocklist must not lock out an
already-compatible room. Custom-entry mode rejects syntactically canonical
`pf2_` values so a hand-authored low-entropy string cannot masquerade as the
generated option.

Before any custom password reaches MLS, invitation authentication, or durable
state, the browser derives a 32-byte canonical protocol secret using
PBKDF2-HMAC-SHA-256 with 600,000 iterations. The salt is a canonical JSON tuple
containing `pillowfort:custom-room-secret:v1`, the pinned KDF identifier, room
ID, and random 128-bit room instance. Generated `pf2_` secrets pass through
unchanged for compatibility, but execute and wipe one equivalent PBKDF2 result
so challenge timing does not reveal which credential mode the host selected.
The human password remains only in the mounted UI so an invite can reproduce
it; the protocol and encrypted state use the resolved canonical secret. A
non-secret, tab-scoped recovery pointer (mode, room ID, display name, and exact
room instance) survives reload, but recovery still requires re-entering the exact
copied password.

The resolved invitation secret is not an MLS group key and cannot decrypt MLS
traffic. A second, domain-separated PBKDF2-HMAC-SHA-256 derivation with 600,000
iterations produces the Ed25519 invitation-authentication key. The relay stores
its public key, not the invitation secret or private key.

Custom passwords are a deliberate usability compromise, not equivalent to the
generated 256-bit default. The invitation public key and a stolen local wrapped
state are offline guess oracles. PBKDF2 raises the cost of each guess but cannot
add entropy to a short or common phrase, so the UI recommends at least 16
characters or four unrelated words and warns against password reuse. Explicit
host approval of each device remains independently required.

## Setup, admission, and resume are different protocols

### Setup and join

Setup and join authenticate the invitation and introduce new MLS key material.
They carry:

- a `SecureMemberHelloV4` with the exact protocol, suite, room instance,
  device ID, and one single-use MLS KeyPackage;
- the device's Ed25519 MLS credential public key; and
- an invitation-signed `RoomInvitationMemberBindingV4`.

The member binding is a long-lived admission authorization, separate from the
one-use socket challenge. Its signature covers the mode (`founder` or
`admission`), room ID, room instance, device ID, admission ID, device signature
key, and SHA-256 digest of the exact KeyPackage. A relay or network attacker
therefore cannot substitute a device key, KeyPackage, room instance, or
admission identifier while retaining a valid binding.

The setup/join socket proof separately signs a domain-separated challenge
transcript that includes the mode, room, room instance, device, connection,
request, challenge, and device public key. Challenges are random, expire, and
are consumed by the authentication attempt. Setup establishes the room's
invitation public key; later join attempts must verify under that stored key.

The founder becomes the first active member. A later join follows this exact
admission sequence:

1. The relay authenticates the invitation proof and stores the pending Hello,
   credential key, and member binding.
2. The host independently verifies the invitation signature, KeyPackage
   digest, device key, room instance, and OpenMLS credential fingerprint.
3. The UI asks the host to approve or reject that exact pending device. No MLS
   Add occurs before explicit approval.
4. On approval, the host obtains the next causal-order grant, performs one MLS
   Add, and durably persists the resulting state and outbound commit before
   transmitting it.
5. Existing members process the commit. Only the admitted device receives the
   matching Welcome and ratchet tree bundle.
6. The joiner persists its joined MLS state, processes a history-redacted
   bootstrap snapshot, and sends a device-signed profile proof.
7. The host validates the proof against the new MLS roster credential and asks
   the relay to activate that exact admission. Only then does the relay mark
   the device active.

Pending admissions cannot send normal group traffic or use the active-member
resume protocol. Expired, rejected, or inconsistent admissions are cancelled
and require a fresh admission.

### Resume

Resume proves possession of the already-active device credential; it does not
carry a Hello or KeyPackage and cannot replace either MLS or credential
material. The client first restores its durable local state. The relay then
issues a random challenge and the device signs a domain-separated transcript
binding version, suite, room ID, room instance, device ID, connection ID,
request ID, and challenge. The relay verifies this proof with the credential
key stored for that active device.

A missing, retired, pending, or `requiresFreshAdmission` device cannot resume.
It must join again with a fresh, never-before-used KeyPackage and a new
invitation-signed binding.

## Relay-visible and encrypted data

An MLS wire message is carried in a bounded `SecureRelayEnvelopeV4`:

```text
{
  v: 4,
  suite: 1,
  roomInstance: base64url(16 bytes),
  messageId: base64url(16 bytes),
  route: "host" | "group" | "device",
  to?: base64url(16 bytes),
  payload: base64url(one complete MLS wire message)
}
```

`to` is required only for device routing. The surrounding relay frame exposes
a coarse `relayKind`, such as commit, Welcome, bootstrap, join proof,
application, or host-transfer acceptance. The relay also sees routing IDs,
destination class, connection lifecycle, timing, count, and padded ciphertext
length. It does not see the ordinary application-event subtype or plaintext.

OpenMLS application plaintext is padded in 1 KiB blocks. Padding reduces
fine-grained length leakage but does not conceal timing, count, routing, or
large size classes.

## Signed application log

One strict, versioned application-event union carries all protected product and
game semantics. Each event includes a random event ID, the room instance,
sender device ID, per-device monotonic sequence, relay-assigned logical order,
content, and an Ed25519 signature made by the key in that device's MLS
credential. Verification uses strict Ed25519 behavior with ZIP-215 acceptance
disabled.

Recipients reject non-canonical values, unknown keys, invalid signatures,
duplicate event IDs, sequence regression, logical-order mismatch, non-members,
wrong room instances, and reducer-precondition failures. Snapshots are bounded
and recursively validated. A new member's bootstrap snapshot excludes chat and
drawing history from before admission; it includes only the state required to
join the current room epoch and application state.

Game reducers are deterministic. RPS and Saboteur randomness use
commit-then-reveal contributions so one participant cannot choose a value
after learning another participant's committed value. This prevents
post-commit unilateral bias; it does not prevent a participant from refusing
to reveal and stalling the game.

## Causal ordering and host decisions

The relay issues at most one current logical-order grant. A grant is bound in
durable relay state to its request, random token, device, connection, order,
and expiration. The corresponding device-signed event also commits to the
logical order. A stale, expired, rebound, parallel, or out-of-order use fails.

For a non-host application event or commit, the relay holds the opaque MLS
frame and sends it to the current host for preview. The host decrypts and
validates it in an isolated engine copy, then approves or rejects the exact
pending frame. The relay learns the decision, not the plaintext. This does not
make the host a neutral party: the host is an authorized participant and can
misuse its approval authority or disclose plaintext it is entitled to read.

Delivery has a durable result path:

1. The sender performs its MLS/application transition and persists the new
   state, rollback state, causal grant context, and outbox entry before send.
2. The relay validates the exact current grant and persists the pending or
   accepted operation before emitting delivery effects.
3. The relay queues the acceptance/rejection result in the sender's durable
   backlog.
4. The sender durably acknowledges the accepted local transition, or durably
   restores the rollback state on rejection.
5. Only after that local transaction succeeds does the sender send the exact
   delivery ACK and continue with dependent work.

The same persist-before-ACK rule applies to inbound MLS transitions,
application results, commit results, admission results, and host-transfer
authorization. A crash may cause an idempotent replay; it must not turn a
durable success into a silent rollback or skip a causal dependency.

If a delivery, admission, or removal barrier blocks an `order-request`, the
relay persists an exact `order-cancelled` result bound to its request ID and
reason. The same request deterministically replays that result. A generic
error is insufficient because it cannot release the client's matching durable
grant intent and would leave later work permanently blocked.

## Exact resume protocol

Every successful active-device resume enters a persisted replay phase, even
when its backlog is empty. The order is authoritative:

1. The relay marks the member pending with phase `replaying-backlog` and binds
   the phase to the resume request ID.
2. It replays the device's durable backlog in original chronology. A historical
   removal marker is inserted before the associated Remove commit.
3. The client processes and durably persists each entry, then sends a
   `delivery-ack` for exactly the acknowledged backlog prefix.
4. The relay sends one authoritative `room-state-snapshot` covering relay
   membership, host authority, admissions, removals, and transfer state.
5. The relay sends `backlog-end`. Its `lastMessageId` is the final backlog
   message ID, or the resume request ID as the empty-backlog sentinel.
6. The client refuses the terminator unless it has reconciled the snapshot with
   its MLS roster and signed application state. It then sends `resume-complete`
   bound to the exact terminator.
7. The relay activates the member only after that exact completion frame. The
   client resumes durable outbound work only after the relay acknowledges it.

An ACK can remove only the exact front of the persisted backlog. A snapshot
cannot authorize a relay-only member, silently retire an MLS member without a
matching removal marker, or change signed host authority.

Browser `message` and `close` events share the same serialized controller
queue. A close observed immediately after a message is reconciled only after
all earlier received encrypted frames have been authenticated and durably
applied, so a final self-removal commit or room-retirement notice cannot be
discarded as stale merely because the transport closed.

## Membership barriers and historical markers

Admission, removal, and host transfer are causal barriers. While an admission
is incomplete, only its exact Welcome, bootstrap, and join-proof sequence may
advance. While a removal is pending, only the host's exact Remove commit for
the bound `(deviceId, admissionCommitMessageId)` may advance. Normal grants,
queued operations, conflicting commits, pending admissions, and transfers are
cancelled or blocked as required by the barrier.

If an admitted device disappears before finishing or an expired/disconnected
member still exists in the MLS roster, the relay persists a FIFO historical
removal marker. That marker survives disconnects, resume, replay, and retired
member tombstone pruning. The client rejects attempts to rebind a marker to a
different device or admission. Backlog and provenance references keep their
required replay/tombstone records alive until the dependent operation is
resolved.

Every admitted KeyPackage digest is retained for the bounded room lifetime and
can never be reused. The ledger is capped at 276 entries (20 live/member slots
plus 256 retired tombstones) and fails closed at the cap. Reaching it requires
recreating the ephemeral room; see the availability boundary below.

For terminal room teardown, the relay first persists the retired state and
clears every stored connection ID. It then sends the content-free
`room-retired` notice only to sockets that are still attached, authenticated as
protocol v4, and bound to a device in the retired membership snapshot. This
preserves persist-before-notify ordering without broadening the terminal
broadcast to an unknown or unauthenticated socket.

## Durable client state

Each room/device has one revisioned IndexedDB record protected by a live
per-room Web Lock. New opaque records use a domain-separated SHA-256 key bound
to both the room instance and resolved canonical credential. Thus an abandoned
wrong-password attempt cannot shadow the correct credential's durable state;
the Web Lock remains room-scoped so two credentials cannot mutate the room
concurrently. A successfully decrypted legacy room-only record is moved to its
credential-scoped key with one strict, atomic IndexedDB transaction. Failed
decryption never moves or deletes legacy state. Secret-bearing state remains an
opaque blob, while non-secret record metadata exposes its hashed room scope and
`provisional`/`authentication-ambiguous`/`established` lifecycle. Immediately
before an authentication frame is sent, the browser atomically advances the
record to `authentication-ambiguous`; a reload therefore cannot mistake a
possibly committed identity for an unsent artifact. A bounded metadata
registry tracks at most four unresolved identities per room and sixteen per
origin. Definitive rejection erases only an artifact proven unsent or created
by that exact rejected attempt. UI cancellation erases only before
transmission; ambiguous or accepted-pending attempts remain locked to exact
recovery. Saturation fails closed rather than evicting a possibly
relay-accepted identity. The adapter
performs compare-and-swap writes with strict durability. The blob contains:

- the MLS snapshot and application snapshot;
- local event sequence, current epoch, replay markers, and processed delivery
  IDs;
- pending commit/application/admission outbox entries and causal grants;
- pending relay controls and admission/removal/host-transfer state;
- commit and application rollback states; and
- retained secrets required to finish an already-durable pending commit.

Before storage, the complete durable state is wrapped with AES-256-GCM. A
room-bound, versioned HKDF-SHA-256 derivation from the resolved canonical room
secret and a fresh 32-byte salt produces the wrapping key; a fresh 12-byte nonce
is used and the canonical wrapper header is authenticated as AAD. The embedded raw MLS
snapshot has its own room-bound authenticated wrapper. Parsers require exact
version, suite, room, instance, canonical JSON, and cross-state invariants.

For every MLS mutation, the engine validates the result, persists the wrapped
state by revision, and zeroes temporary transition buffers before returning
the wire message. If persistence fails or the Web Lock is lost, it restores the
last authoritative state or retires the unusable session and fails closed.
Erasing a local room deletes the opaque state but retains replay tombstones
needed to reject stale reuse.

The browser adapters keep explicit references to their own raw MLS snapshot,
serialized durable-state plaintext, room-secret KDF input, salt, nonce, and
derivation-info buffers until each awaited WebCrypto operation settles. Their
`finally` paths then wipe those mutable buffers. This prevents a helper-created
plaintext copy from becoming unreachable before it can be erased; it cannot
wipe the caller's immutable JavaScript room-secret string, a `CryptoKey`'s
engine-private representation, or copies made inside WebCrypto, the browser,
the OS, or storage hardware.

AES wrapping protects secret state at rest against an IndexedDB-only
disclosure. The disclosure can still correlate hashed record scopes and learn
unresolved-versus-established lifecycle metadata. AES wrapping does not
protect against code running in the trusted origin with the room
secret, a compromised browser/OS, physical disk recovery, or rollback of the
entire browser profile.

## Forward secrecy, updates, and key erasure

The OpenMLS group configuration disables past-epoch retention and resumption
PSKs, sets sender-ratchet out-of-order tolerance to zero, and bounds forward
distance. Obsolete state and consumed transition buffers are zeroed. A fresh
update is scheduled after admission, removal, host transfer, successful
resume, and periodically while the room remains active.

Forward secrecy applies only after old key material has actually been erased.
Post-compromise recovery applies only after fresh entropy from an
uncompromised device is committed and the attacker no longer controls an
endpoint. Neither property retroactively removes plaintext, snapshots, or keys
an attacker already copied.

## OpenMLS artifact and memory controls

The repository pins Rust 1.94.1, `wasm-bindgen-cli` 0.2.120, OpenMLS 0.8.1, and
the complete Cargo dependency lockfile. Production builds run with `--locked`
in a fresh target directory. A checked-in manifest hashes the toolchain,
adapter, vendored patches, generated browser artifacts, and all relevant source
inputs; the build verifies both the source set and exact artifact set before
Vite bundles them.

The local WASM adapter is deliberately narrow. It bounds input, converts
failures to closed errors, copies exported bytes directly into JavaScript-owned
arrays, and zeroes Rust-side temporary buffers. Its custom WASM allocator
scrubs allocations on deallocation and uses allocate/copy/scrub/free for
reallocation. The locally vendored OpenMLS memory-storage fork wipes replaced,
deleted, temporary, and dropped key/value buffers. The fork records its
upstream provenance and checksum.

These controls reduce ordinary linear-memory residue and supply-chain drift.
They are not a guarantee against compiler/runtime copies, malicious JavaScript,
process-memory capture, hardware attacks, or unknown OpenMLS defects.

## Downgrade and migration

- v4 rooms reject v1-v3 frames and ciphertexts.
- Version, suite, and room instance are persisted before setup is acknowledged.
- The relay never translates between protocol generations.
- A missing or mismatched version, suite, room instance, credential, or durable
  state fails closed.
- Existing v1-v3 rooms are invalidated and recreated instead of migrated under
  an ambiguous mixed protocol.

## Residual security and availability boundaries

The following are deliberate, documented limits rather than claims of solved
properties:

1. **Mutable origin and browser endpoint.** An origin that serves malicious
   JavaScript, a hostile extension, or a compromised browser can read plaintext
   and invitation/MLS secrets or alter protocol behavior. TLS, CSP, Trusted
   Types, pinned artifacts, and deployment review reduce exposure but do not
   establish an independently trusted client.
2. **Authorized participants.** Every current MLS member can read group
   plaintext and may copy, screenshot, export, or leak it. E2EE is not DRM.
3. **Relay and network metadata.** The relay and Cloudflare can observe room and
   device routing IDs, coarse relay class, destination class, membership and
   connection lifecycle, IP/network metadata, timing, count, and coarse padded
   size buckets.
4. **Relay liveness and traffic control.** A relay can delay, drop, reorder,
   partition, suppress heartbeats, or deny service. Exact grants and ACKs make
   inconsistency fail closed; they cannot force delivery.
5. **Relay equivocation.** A malicious relay can show different participants
   selectively delivered, internally consistent subsets of a transcript. There
   is no public transparency log, witness, or out-of-band gossip channel.
6. **Host authority.** The current host approves admissions and previews
   non-host operations. A malicious or unavailable host can reject or stall
   legitimate work, though it cannot forge another device's signature.
7. **OS, memory, disk, and rollback.** JavaScript and WASM cannot guarantee
   erasure of immutable strings, engine-private `CryptoKey` material, physical
   disk blocks, or copies made by WebCrypto, the OS, runtime, debugger,
   extension, backup, or process-memory capture. Whole-profile rollback is
   detectable only where monotonic client or relay state exposes it.
8. **Captured historical snapshots.** A snapshot captured at time T contains
   the state and keys available at T. Later updates, removal, and zeroization do
   not delete an attacker's copy or make an already compromised endpoint
   trustworthy retroactively.
9. **Commit-reveal withholding.** Commit-reveal prevents choosing after seeing
   another reveal, but a participant can withhold its reveal and stall. Forced
   completion would need an escrowed/trusted randomness beacon, penalties, or a
   different multiparty protocol.
10. **Saboteur role visibility.** `saboteurDeviceId` is part of shared MLS group
    application state. Any authorized participant can inspect it with developer
    tools. A genuinely private role requires pairwise dealer encryption, MPC,
    or a trusted dealer not present in this design.
11. **Commerce metadata.** A Fort Pass raw claim is a tab-scoped commerce bearer
    used during setup. Checkout, reservation, redemption, and payment metadata
    are outside room E2EE, and no cross-tab recovery is claimed.
12. **Finite KeyPackage history.** The permanent digest ledger fails closed
    after 276 admitted KeyPackages. An authorized participant can consume this
    finite room-lifetime availability through valid admissions; recreation is
    the recovery path.
13. **Dependency maintenance.** The pinned dependency graph currently contains
    transitive `instant 0.1.13`, covered by RUSTSEC-2024-0384 (unmaintained, with
    no patched release). It is monitored and should be removed through a safe
    upstream dependency update when available.
14. **No absolute proof.** Tests, source pinning, threat analysis, and review
    reduce known risk. They cannot prove the absence of implementation,
    compiler, runtime, cryptographic-library, or deployment defects.

## Verification map

- Strict wire and application schemas: `test/protocol-v4.test.ts` and
  `test/application-events-v4.test.ts`.
- Device resume and invitation/member binding: `test/device-auth-v4.test.ts`
  and `test/room-invitation-auth-v4.test.ts`.
- Deterministic games, signatures, transcript redaction, and commit-reveal:
  `test/secure-game-reducer.test.ts`.
- Admission, causal results, resume, crash recovery, and membership barriers:
  `test/secure-room-engine.test.ts`, `test/secure-relay-v4.test.ts`, and
  `test/secure-server-runtime-v4.test.ts`.
- Durable Object terminal delivery and split raw/operation rate budgets:
  `test/secure-room-do-runtime-v4.test.ts`.
- Wrapped state, CAS persistence, replay tombstones, and locking:
  `test/replay-persistence.test.ts` and `test/mls-protocol-v4.test.ts`.
- WASM secret-residue regressions:
  `test/openmls-wasm-zeroization.test.ts`.

The security remediation report records the concrete findings, source
locations, verification coverage, and residual risk decisions.
