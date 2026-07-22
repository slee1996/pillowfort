# Pillowfort protocol-v4 security review and remediation record

Date: 2026-07-22

Scope: browser cryptographic state, MLS identity and membership, invitation and
resume authentication, end-to-end application/game events, causal relay
behavior, crash/reconnect recovery, replay protection, secret erasure, and the
OpenMLS WASM build boundary.

Status: all eight actionable findings identified in this review are fixed in
the current working tree. The fixed status means that the described defect has
an implemented control and regression coverage; it does not mean that
Pillowfort is free of security risk. The accepted design and operational limits
are recorded separately below.

## Executive summary

Pillowfort protocol v4 replaces the former shared AES chat channel with an MLS
1.0 group using a distinct credential and HPKE identity for every browser
device. All room and game semantics now travel as device-signed application
events inside MLS. Admission binds the exact invitation, device credential,
KeyPackage digest, room instance, and admission ID, and it requires explicit
host approval. Active-device resume uses a stored credential challenge proof;
it cannot introduce new MLS or credential material.

Cryptographic and application state is revisioned, authenticated, encrypted,
and persisted in IndexedDB under a live Web Lock. Transitions, rollback data,
outbox entries, delivery results, replay markers, and membership controls are
committed before dependent network effects. Resume is an explicit durable
backlog → authoritative snapshot → terminator → completion-ACK protocol.

The relay remains content-blind for application plaintext but necessarily sees
routing and traffic metadata, and it controls availability. The web origin and
authorized room participants remain trusted for plaintext confidentiality.
These and other residual limits are not disguised as “fixed.”

## Finding status

### PF-V4-001 — Shared static room encryption lacked forward secrecy and authenticated per-device membership

- Severity: Critical
- Status: **Fixed**
- Defect: The earlier design used one deterministic symmetric room key. A later
  secret disclosure exposed recorded ciphertext, members were not independent
  cryptographic principals, and there was no post-compromise update mechanism.
- Control: Protocol v4 uses MLS 1.0 ciphersuite 1 with per-device signing and
  HPKE identities, authenticated Add/Remove/Update epochs, no retained past
  epochs, no resumption PSKs, zero out-of-order sender-ratchet tolerance, and
  scheduled fresh updates after security-relevant lifecycle events.
- Source evidence: `crypto/openmls-wasm/src/lib.rs:100-125`,
  `crypto/openmls-wasm/src/lib.rs:665-680`, and
  `crypto/openmls-wasm/src/lib.rs:794-804`; membership transitions in
  `client/src/services/secureRoomEngine.ts:879-1188`; resume-triggered update
  scheduling in `client/src/services/secureRoomController.ts:887-893` and
  `client/src/services/secureRoomController.ts:2278-2305`.
- Verification coverage: `test/mls-protocol-v4.test.ts:31-365` and the
  membership/update cases in `test/secure-room-engine.test.ts`.
- Remaining boundary: forward secrecy begins only after obsolete material is
  erased, and post-compromise security begins only after an uncompromised
  member contributes fresh entropy. Neither property revokes an attacker copy
  made before that point.

### PF-V4-002 — Application and game semantics escaped the E2EE/authentication boundary

- Severity: High
- Status: **Fixed**
- Defect: Protecting only chat left presence, drawings, game actions/state,
  host actions, and results visible or forgeable at the relay boundary.
- Control: One strict application-event union covers every room/game feature.
  Events bind room instance, event ID, device ID, per-device sequence, causal
  logical order, content, and a strict Ed25519 signature. Bounded canonical
  parsing and deterministic reducers reject malformed, duplicate, unsigned,
  non-member, stale, or state-invalid events. Bootstrap snapshots redact chat
  and drawing history from before admission.
- Source evidence: event union and snapshot schema in
  `src/applicationEventsV4.ts:44-218`; recursive validation, canonical signing,
  and strict verification in `src/applicationEventsV4.ts:564-815`;
  deterministic validation and transcript redaction in
  `src/secureGameReducer.ts:801-879`.
- Verification coverage: `test/application-events-v4.test.ts:71-294` and
  `test/secure-game-reducer.test.ts:104-947`, including signature/order,
  redaction, RPS, and Saboteur commit-reveal cases.
- Remaining boundary: all authorized MLS participants receive shared group
  application state. In particular, Saboteur's `saboteurDeviceId` is inspectable
  by an authorized participant and is not a cryptographically private role.

### PF-V4-003 — Tab-scoped replay state and non-atomic cryptographic persistence allowed crash and concurrency gaps

- Severity: High
- Status: **Fixed**
- Defect: Tab-only replay history and separately persisted counters/state could
  disappear or diverge across reloads, concurrent tabs, and mid-transition
  crashes.
- Control: One opaque, revisioned IndexedDB record contains the MLS and
  application snapshots, sequence/order state, processed deliveries, pending
  outbox, relay controls, commit secrets, and rollback states. The complete
  record is protected with room-bound HKDF-SHA-256 and AES-256-GCM with random
  salt/nonce and authenticated header. A per-room Web Lock and CAS revision
  serialize writers. Every MLS mutation persists before its wire output is
  released; persistence or lock loss fails closed and restores the last
  authoritative state. Replay tombstones survive local room-state erasure.
- Source evidence: durable state and invariants in
  `client/src/services/secureRoomState.ts:68-186`,
  `client/src/services/secureRoomState.ts:952-1209`, and
  `client/src/services/secureRoomState.ts:1213-1425`; create/restore and
  persist-before-return in `client/src/services/secureRoomEngine.ts:468-595`
  and `client/src/services/secureRoomEngine.ts:2230-2328`; CAS/tombstone store
  in `client/src/services/cryptoStateStore.ts:538-637`.
- Verification coverage: `test/replay-persistence.test.ts:56-458`,
  `test/mls-protocol-v4.test.ts:31-365`, and crash paths in
  `test/secure-room-engine.test.ts`.
- Remaining boundary: wrapping does not protect against code that has the room
  secret, and browser storage cannot promise physical deletion or resist an
  OS/profile-level rollback in isolation.

### PF-V4-004 — Admission and resume could be confused or rebound to attacker-chosen credentials

- Severity: Critical
- Status: **Fixed**
- Defect: Treating join and reconnect as one operation allowed identity,
  KeyPackage, or admission substitution and risked automatic activation of an
  unreviewed member.
- Control: Setup/join carry a Hello and a separately invitation-signed member
  binding covering the exact mode, room, instance, device, admission,
  credential key, and KeyPackage SHA-256 digest. The host verifies that binding,
  the delivered KeyPackage, and its OpenMLS credential, then explicitly
  approves or rejects the exact candidate. Activation occurs only after Add,
  Welcome, history-redacted bootstrap, and a signed join proof. Resume carries
  no Hello or KeyPackage and requires a domain-separated challenge proof made
  by the stored active-device credential key.
- Source evidence: split wire types in `src/secureRelayV4.ts:55-85`; resume
  transcript/verification in `src/deviceAuthV4.ts:17-93`; member-binding
  transcript and digest in `src/roomInvitationMemberBindingV4.ts:19-181`;
  invitation proof context in `src/roomInvitationAuthV4.ts:13-134`; host
  verification/approval in `client/src/services/secureRoomController.ts:898-1045`
  and engine enforcement in `client/src/services/secureRoomEngine.ts:879-984`.
- Verification coverage: `test/device-auth-v4.test.ts:23-56`,
  `test/room-invitation-auth-v4.test.ts:19-109`, admission cases in
  `test/secure-relay-v4.test.ts:459-644`, and runtime substitution cases in
  `test/secure-server-runtime-v4.test.ts`.
- Remaining boundary: the invitation authorizes a request to join, while the
  current host decides admission. A malicious/unavailable host can reject or
  stall a legitimate join.

### PF-V4-005 — Relay ordering and lost sender results could violate causal game state

- Severity: High
- Status: **Fixed**
- Defect: Concurrent operations, grant reuse, a relay-selected semantic result,
  or a lost accept/reject reply could leave members with divergent game state
  or cause a sender to repeat/rollback a committed operation.
- Control: The relay serializes operations with one exact grant bound to the
  request, token, device, connection, order, and expiry. The signed event binds
  the same logical order. A non-host encrypted operation is held while the host
  validates it in an isolated engine preview and approves/rejects the exact
  frame. Acceptance/rejection is stored as a durable sender-backlog result. The
  sender commits the matching local ACK or rollback before acknowledging that
  delivery or requesting dependent work. A barrier-blocked immediate order
  request receives a persisted, exactly replayable `order-cancelled` result so
  its client intent cannot deadlock. Separate raw-frame, room-wide, and
  initiated-operation budgets bound abuse without double-charging mandatory
  ACK, decision, admission, and granted-frame traffic as new operations.
- Source evidence: grant/frame contracts in `src/secureRelayV4.ts:87-189`;
  commit/application grant and preview enforcement in
  `src/secureRelayV4.ts:3414-3735`; host decisions in
  `src/secureRelayV4.ts:3788-3880`; isolated preview in
  `client/src/services/secureRoomController.ts:1199-1242`; durable result
  processing in `client/src/services/secureRoomController.ts:1392-1516`;
  rate-budget separation in `server.ts:214-219`, `server.ts:398-433`,
  `server.ts:3471-3481`, `src/room.ts:140-145`, and `src/room.ts:738-771`.
- Verification coverage: causal rollback/result tests in
  `test/secure-room-engine.test.ts:2855-3029`; grant, exact cancellation,
  preview, timeout, ACK, and replay tests in
  `test/secure-relay-v4.test.ts:800-1519`; and split-budget runtime cases in
  `test/secure-server-runtime-v4.test.ts:207-285` and
  `test/secure-room-do-runtime-v4.test.ts:703-765`.
- Remaining boundary: the host is an authorized decision maker, not a trusted
  execution oracle. A malicious host or relay can deny progress, and a relay
  can selectively deliver different consistent prefixes without an external
  transparency/witness system.

### PF-V4-006 — Reconnect could race backlog replay, authority reconciliation, and new work

- Severity: High
- Status: **Fixed**
- Defect: Reconnecting directly to “active” could allow durable outgoing work
  to race missed commits/results or let relay-only membership/host state become
  authoritative without comparison to the MLS and signed application state.
- Control: Every active-device resume enters persisted
  `replaying-backlog`, including an empty backlog. The relay emits chronological
  durable entries with historical markers, then exactly one authoritative room
  snapshot, then `backlog-end` bound to the last message (or resume request as
  the empty sentinel). The client persists and prefix-ACKs entries, reconciles
  MLS roster and signed authority, and sends `resume-complete` for the exact
  terminator. Both sides resume normal work only after the completion ACK. The
  client queues socket-close reconciliation behind already-received encrypted
  frames. Terminal teardown is persisted before a content-free `room-retired`
  notice is sent only to attached, authenticated sockets whose device identity
  belonged to the retired room, even though persisted connection IDs are then
  already clear.
- Source evidence: resume state machine in `src/secureRelayV4.ts:3299-3375`,
  prefix ACK/completion enforcement in `src/secureRelayV4.ts:3738-3774`,
  snapshot reconciliation and terminator handling in
  `client/src/services/secureRoomController.ts:1549-1707`; queued close
  reconciliation in `client/src/services/secureRoomController.ts:405-437`;
  terminal delivery in `server.ts:477-494`, `server.ts:665-670`,
  `src/room.ts:2100-2114`, and `src/room.ts:2286-2290`.
- Verification coverage: `test/secure-relay-v4.test.ts:800-1250`; reconnect
  restoration cases beginning at `test/secure-room-engine.test.ts:2147`;
  queued-close coverage at `test/secure-room-engine.test.ts:2596-2683`; and
  terminal runtime cases at `test/secure-server-runtime-v4.test.ts:170-205`
  and `test/secure-room-do-runtime-v4.test.ts:672-701`.
- Remaining boundary: an authenticated relay can withhold or delay the sequence
  forever. The client fails closed; it cannot force availability.

### PF-V4-007 — Incomplete membership changes could create zombie members or lose removal provenance

- Severity: Critical
- Status: **Fixed**
- Defect: Admission expiry, disconnect, replay, or tombstone pruning could leave
  a device in the MLS roster after the relay considered it absent, permit
  unrelated operations to cross a membership epoch, or lose the exact evidence
  needed to remove it safely.
- Control: Admission and removal are exclusive causal barriers. A removal marker
  binds the exact device and admission-commit message and permits only the
  corresponding host Remove commit. FIFO historical markers are durable,
  inserted at the correct point during replay, reject rebinding, and keep
  referenced tombstone/replay provenance alive. Conflicting grants, queued
  operations, admissions, commits, and transfers are cancelled or blocked.
  Every admitted KeyPackage digest is retained for the bounded room lifetime,
  preventing reuse even after its member tombstone is pruned.
- Source evidence: marker/ledger state in `src/secureRelayV4.ts:427-459`;
  provenance-preserving pruning in `src/secureRelayV4.ts:1778-1831` and
  `src/secureRelayV4.ts:2088-2118`; barrier creation/consumption in
  `src/secureRelayV4.ts:2231-2431`; relay enforcement in
  `src/secureRelayV4.ts:3394-3412`; client binding in
  `client/src/services/secureRoomEngine.ts:768-828` and
  `client/src/services/secureRoomController.ts:1709-1875`.
- Verification coverage: admission/removal/barrier suites in
  `test/secure-relay-v4.test.ts:645-799` and
  `test/secure-relay-v4.test.ts:1520-2232`, plus engine barrier cases beginning
  at `test/secure-room-engine.test.ts:1841`.
- Remaining boundary: the non-evicting KeyPackage digest history is finite:
  276 admissions per room lifetime. It fails closed at the cap, so repeated
  authorized valid admissions can exhaust the room and force recreation.

### PF-V4-008 — Persisted/WASM secret residue and unverified build drift weakened the reviewed boundary

- Severity: High
- Status: **Fixed**
- Defect: Raw persisted MLS state, allocator/storage copies left in WASM linear
  memory, or unreviewed source/tool/artifact drift could expose secrets or make
  the deployed cryptographic core differ from the audited implementation.
- Control: Raw MLS snapshots and the complete outer durable state are both
  room-bound AES-GCM wrappers. Rust transition and snapshot types zero buffers
  on drop. A custom WASM allocator scrubs deallocated memory and implements
  reallocation as allocate/copy/scrub/free. The vendored OpenMLS memory-storage
  fork wipes replaced, removed, temporary, and dropped key/value buffers and
  records upstream provenance. Browser adapters retain their own room-secret
  KDF inputs and raw snapshot/durable-state plaintext buffers through awaited
  WebCrypto calls, then wipe those mutable buffers in `finally`. Rust,
  wasm-bindgen, Cargo dependencies, local patches, source inputs, and browser
  artifacts are pinned and hash-verified; builds use a clean target and
  `--locked`.
- Source evidence: wrapper creation/restore in
  `client/src/services/secureRoomState.ts:1213-1425` and
  `client/src/services/mlsCrypto.ts:220-503`; adapter-owned WebCrypto buffer
  retention/wiping in `client/src/services/mlsCrypto.ts:240-415` and
  `client/src/services/secureRoomState.ts:1234-1425`; zeroizing allocator/exports/drop
  paths in `crypto/openmls-wasm/src/lib.rs:30-98`,
  `crypto/openmls-wasm/src/lib.rs:175-241`, and
  `crypto/openmls-wasm/src/lib.rs:356-571`; storage wiping in
  `crypto/openmls-wasm/vendor/openmls-memory-storage/src/lib.rs:21-123` and
  `crypto/openmls-wasm/vendor/openmls-memory-storage/src/lib.rs:193-375`;
  dependency pins in `crypto/openmls-wasm/Cargo.toml:11-33` and
  `crypto/openmls-wasm/rust-toolchain.toml:1-4`; build verification in
  `scripts/build-openmls-wasm.sh:1-47` and
  `scripts/verify-openmls-artifacts.mjs:6-132`.
- Verification coverage: `test/openmls-wasm-zeroization.test.ts:14-78`,
  `test/mls-protocol-v4.test.ts:240-365`, and the pre-build OpenMLS artifact
  verifier.
- Remaining boundary: source-level zeroization cannot erase an immutable
  JavaScript room-secret string, a `CryptoKey`'s engine-private representation,
  all WebCrypto/compiler/runtime/OS copies, or physical disk blocks. Dependency
  vulnerabilities and implementation defects can still exist despite pinning.

## Residual risk register

These are material security or availability limits, not unfixed versions of
the eight implementation defects above.

1. **Mutable origin/browser endpoint — accepted architectural boundary.** A
   compromised origin, malicious deployment, browser extension, debugger, or
   endpoint can read plaintext and room secrets or alter the client. A separately
   signed and independently updated client is required to remove the mutable
   web-origin trust assumption.
2. **Authorized participants — inherent E2EE boundary.** Current MLS members
   possess group plaintext and current epoch keys and can copy or leak them.
   E2EE does not provide DRM.
3. **Relay metadata and traffic analysis — minimized, not eliminated.** The
   relay/Cloudflare sees room and device routing identifiers, connection and
   membership lifecycle, destination/coarse protocol class, timing, counts,
   coarse 1 KiB ciphertext buckets, and IP/network metadata.
4. **Relay liveness, equivocation, and denial of service — accepted distributed
   systems boundary.** The relay can delay, drop, reorder, partition, suppress
   heartbeat, or selectively deliver consistent-looking transcript prefixes.
   There is no external transparency log, witness, or gossip channel.
5. **OS/disk/memory/rollback — partially mitigated.** Authenticated wrapping,
   Web Locks, CAS revisions, tombstones, and explicit wiping of adapter-owned
   buffers reduce common failure modes. They cannot erase immutable JavaScript
   strings or engine-private WebCrypto material, guarantee physical deletion,
   or resist a compromised OS, process-memory capture, full-profile rollback,
   or backups.
6. **Captured historical snapshots — inherent.** A copy made at time T includes
   the plaintext/state/keys available at T. Later erasure, removal, or updates
   cannot erase that copy or retroactively heal the captured endpoint.
7. **Commit-reveal withholding — availability boundary.** Commit-reveal blocks
   choosing after another commitment but cannot force a reveal. A participant
   may stall unless the product adds escrow, penalties, or trusted/public
   randomness.
8. **Saboteur shared-state role — explicit product limitation.** The role is in
   shared MLS application state and is visible to an authorized participant via
   developer tools. True role secrecy requires pairwise dealer encryption, MPC,
   or a trusted dealer.
9. **Fort Pass commerce claim — separate boundary.** The raw claim is a
   tab-scoped bearer used during setup. Checkout, reservation, redemption, and
   payment metadata are outside E2EE; cross-tab recovery is not promised.
10. **Finite KeyPackage digest history — fail-closed availability bound.** The
    permanent digest ledger is limited to `20 + 256 = 276` admissions
    (`src/secureRelayV4.ts:29-40`, `src/secureRelayV4.ts:3248-3252`). A valid
    participant can consume the bound; the recovery is a new room.
11. **Transitive `instant 0.1.13` advisory — monitored dependency risk.** The
    pinned graph contains an unmaintained transitive crate covered by
    [RUSTSEC-2024-0384](https://rustsec.org/advisories/RUSTSEC-2024-0384/), for
    which no patched release exists. Preserve reproducible pins, monitor the
    OpenMLS dependency graph, and remove it during a tested upstream upgrade.
12. **No absolute proof — review limitation.** This review and its tests cover
    known code paths and identified abuse cases. They cannot prove the absence
    of unknown cryptographic-library, compiler, browser, dependency, deployment,
    or logic defects.

## Verification inventory

The controls above are covered by:

- `test/protocol-v4.test.ts`
- `test/application-events-v4.test.ts`
- `test/device-auth-v4.test.ts`
- `test/room-invitation-auth-v4.test.ts`
- `test/secure-game-reducer.test.ts`
- `test/secure-room-engine.test.ts`
- `test/secure-relay-v4.test.ts`
- `test/secure-server-runtime-v4.test.ts`
- `test/replay-persistence.test.ts`
- `test/mls-protocol-v4.test.ts`
- `test/openmls-wasm-zeroization.test.ts`

This report records source and test coverage; final release status depends on
running the repository's authoritative verification commands against the exact
tree and verified OpenMLS artifacts being deployed.

## Primary guidance

- [RFC 9420 — The Messaging Layer Security Protocol](https://www.rfc-editor.org/rfc/rfc9420)
- [RFC 9750 — MLS Architecture](https://www.rfc-editor.org/rfc/rfc9750)
- [OpenMLS](https://github.com/openmls/openmls)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)
- [RUSTSEC-2024-0384](https://rustsec.org/advisories/RUSTSEC-2024-0384/)
