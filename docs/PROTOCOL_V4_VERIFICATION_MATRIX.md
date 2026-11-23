# Protocol v4-CS1 verification matrix

This matrix maps the existing M1–M4 analysis plan to evidence, not to claims of complete verification. Run `npm run check` for implementation suites; run the model and browser commands in `PROTOCOL_V4_TECHNICAL_APPENDIX.md` for the additional evidence. Exact source revision, commands, raw logs and outcomes are recorded in the pinned artifact.

| Plan obligation | Model coverage | Concrete implementation evidence | Explicit exclusion |
|---|---|---|---|
| M1.1 Exact grant and usable preview | M1 connection and host-backlog guards; Grant and Preview mutants must fail | Relay connection-bound cancellation and M1 host-preview readiness regressions, including host ACK and host resume completion | Model abstracts signed bytes and wall-clock timestamps |
| M1.2 Persist before effects | M1 persist-before-emit; `IdleRetirement` separates durable deletion, dispatch and observation; lost-marker and wrong-binding mutants | `secure-room-engine.test.ts`: composite state/send/restart/CAS failures; `secure-room-do-runtime-v4.test.ts`: aborted idle deletion emits no notice. In two local workerd runs the relay was evicted after deletion: once before either notice and once after the first. Both passive browser sessions reached terminal state in both runs | No proof of filesystem/IndexedDB hardware durability |
| M1.3 Stable outcome | `OutcomeRecovery`: first verdict remains stable, rejection rolls back speculative application state without reversing the sender generation; three mutations and a restored-rejection witness | Relay exact replay fingerprints; engine application rollback versus rejected commit retirement | No model of all rejected-operation/game interleavings |
| M1.4 Prefix ACK | M1 front-of-backlog application/ACK | Relay durable delivery exact-prefix tests | Resume uses `resume-complete`, not independent per-entry ACKs |
| M1.5 No duplicate application | M1 retained seen-set and repeated delivery | Real MLS engine duplicate/replay/reorder tests | Retention is bounded; no unbounded exactly-once guarantee |
| M2 × M4 Re-invitation | `Reinvite`: valid restarted join, exact stored anchor and bootstrap signer; replacement-pin and other-signer mutants | Real MLS pin persistence; published SDK fresh admission after host loss; former host shares current-host link after planned transfer | A fresh link is a new private trust decision, not proof of an uninterrupted lineage |
| M1 × M4 Manual refusal | `Reinvite`: delayed first receipt cannot consume a later offer; stale-receipt mutant | Relay expiry/duplicate decision regressions and browser refusal → new offer → explicit catch → fresh chat | Manual and disconnect-driven offers are different authorizations |
| M2.1 Activation evidence | M2 ordered approval/Add/Welcome/bootstrap/proof/activation | Relay and engine exact approval; `lost-guest-keys` clears a real guest database, requires a new device/key/request and approval, and checks distinct mention routing and absence of prior chat | Signature and MLS capabilities abstracted in model |
| M2.2 Immutable binding | M2 room/admission proof guards; key token retention | Invitation-bound KeyPackage substitutions and strict member binding tests | Model does not represent full cryptographic credential encodings |
| M2.3 Pending not active | M2 active-state guard; composed send interlocks | Relay every post-Add phase barrier; real browser waits for self `member-lifecycle:active` | Composer visibility is not admission completion |
| M2.4 KeyPackage single use | M2 reserves the key on the join request, not when the MLS Add is committed; KeyReuse mutant must fail | Relay digest history reuse/exhaustion tests | Finite modeled tokens and finite production history |
| M2.5 Preserve uncertain identity | M2 durable ambiguous flag across abstract crash | Browser engine ambiguous authentication/reload/CAS/registry tests | Capacity/eviction registry not represented by TLC |
| M3.1 No early ordinary work | M3 Ready guard and composed interlock | `second-resume` and the controller regression keep sends blocked after an old ACK and release them on the current ACK; restored outbox survives unrelated active-lifecycle replay | Repeated reconnect sequences and concrete lifecycle helper calls are not exhaustively modeled |
| M3.2 Exact completion | M3 connection/request/terminator checks; coupled `StaleEnd` mutation detects activation with a superseded replay end | `requires a fresh replay boundary when succession commits during guest resume`: the relay rejects the old completion and accepts the same device's new replay; a second relay regression rejects the first socket even with identical ends | The handoff model checks one replacement; `RepeatedResume` separately checks two, including the same nonempty end |
| M3.3 No snapshot-only authority | Coupled returning guest must authenticate the replayed M4 acceptance before reconciling the new host; `ResumeSnapshot` mutation must fail | Controller authoritative snapshot and MLS roster reconciliation tests | Ordinary guest, not the candidate with an in-flight acceptance |
| M3.4 Historical causality | `HistoricalCleanup`: two distinct membership/Remove tuples, marker-before-Remove and historical replay; the implementation observer checks the concrete IDs on real replay | Relay exact marker/Remove/snapshot/end replay; engine replayed-marker cleanup | No TLC proof of all concrete marker-backlog interleavings |
| M3.5 Receive before close | `HistoricalCleanup` orders previously queued Remove before close, without waiting for future messages; `IdleRetirement` separates send from receipt | `former-host-removal` delivers the Remove immediately before close and checks the observer roster before replacement replay; separate final self-removal tests | No complete network event-loop model |
| M4.1 Scoped authority | M4 policy/offer/selected signer checks; Target mutant must fail | Signed sidecar target/policy/capability rejection tests | No proof that a relay can compare opaque MLS plaintext to a public sidecar |
| M4.2 Explicit consent | M4 choice stored before authority commit | Relay refusal→next acceptance and universal-refusal retirement; live catch/duck evidence | Arbitrary agent-host intent is outside protocol verification |
| M4.3 Persisted switch | M4 separate authority commit/removal actions | Relay recipient-overflow regression; lost-result crash-boundary test | Runtime storage implementation not refined to TLA+ |
| M4.4 Mode-specific removal | M4 exact abstract removal steps | Engine signed leave/Remove tests and relay former-host removal lifecycle | Model omits MLS tree internals |
| M4.5 Reconcile views | Focused M3×M4 safety check and reachable completed guest resume under the successor | `guest-resume-after-succession` checks same-device replay and encrypted delivery in both directions; separate successor crash regressions cover the candidate | One handoff; authority is checked at activation, not simultaneously at every peer |
| M4.6 Join-order priority | M4 earliest eligible unattempted member | Relay regressions: first offer on socket loss or eligible resume completion; skip disconnected members; expiry and refusal advance the offer | A dishonest relay can lie about eligibility/connectivity |
| M4.6a Detect a silent eligible host | `HostPath`: silence eventually leads to suspicion under weakly fair alarms; old-socket, wrong-nonce, wrong-device and never-detect mutants | Strict wire/expiry tests; no-FIN bilateral and directional partitions; dropped first challenge and real object eviction with intact storage | Cannot distinguish suspension from failure, impose a platform deadline, or opt legacy clients in |
| M4.7 Tenure binding | M4 invalidates policy on switch, refreshes only under current host | Prior-policy reducer rejection; three permanent-successor-loss cases retire without old delegation | No automatic second handoff before a new policy is accepted |
| M4.8 Barrier completion | `HistoricalCleanup` separates local retirement ACKs from lifecycle and previously completed requests; both weakened guards fail | Two queued targets: duplicate former-host retirement after relay restart cannot release the next target; engine retirement control/replayed marker tests | Concrete duplicate lifecycle signals are not exhaustively modeled |
| Composition | Staged M1→M1+M2→M1+M2+M3→M1–M4 send guards; Interlock mutant must fail | Existing admission/removal/host-transfer barriers and full project gate | 12/16-step prefixes plus the complete finite one-token, one-slot product (6,544,512 distinct states). No full code refinement, whole-system deadlock-freedom or unconditional liveness proof |
| Peer membership/storage disagreement | Not represented as malicious MLS divergence in TLC | Injected an IndexedDB failure while receiving an Add; other peers continued, the same device later resumed, replayed the committed proof, and exchanged encrypted chat with the new leaf in both directions. No fresh approval or replacement identity | Failure isolation, not automatic epoch merging |

## What the executable evidence covers

Twenty-four numbered coordination obligations appear above. `verification/relay-conformance.ts` observes the production relay exercised by its concrete suite. It checks independently that each successful state persists and reloads identically, rejected steps leave the input unchanged, grants and outcomes retain their bindings, and an authority switch has the corresponding consent path. The full run requires every frame family, alarm and disconnect, and nonzero hits for historical replay and each transfer mode. It is trace conformance, not a proof that TypeScript refines TLA+ for all states.

The cryptographic provider is also tested against RFC 9180 A.1.1 (recipient key derivation, opening an external ciphertext, and three exported secrets), not only against itself. `scripts/build-openmls-wasm.sh` can be run on a fresh source export with pinned Rust 1.94.1 and wasm-bindgen 0.2.120. Artifact identity and published vectors do not prove MLS, entropy, erasure, or secure endpoints. The application rules, transport parsing, endpoint custody, and browser/runtime suites are listed in the secure-room contract’s verification map.

`terminal-storage` delivers an actual retirement notice to a guest while its IndexedDB erasure transaction fails. Ordinary actions stop before erasure. The original recovery pointer and record survive reload; an explicit retry with the original password clears both. This addresses a distinct failure from the relay committing shutdown: permission or storage loss that never recovers cannot be repaired by the protocol.

## Reconnect and offer delivery

`ReconnectRace` refines the host/guest recovery race. `M4Succession` fences and offers in the same transition when a candidate is eligible. Relay tests cover both socket orders, four interrupted admission phases, exact signed acceptance one millisecond before, at and after expiry, and replay without a second publication. Replayed receipts may repeat.

The local workerd restart and silent-path experiments use three real browser profiles. See `verification/README.md` for commands and exclusions. The former drops the post-commit dispatch and hibernates live sockets; the latter separates observed relay loss from offer delivery. A planned-transfer browser case (`--fault planned-then-unplanned`) checks that the former host stays admitted and that a later automatic offer uses the *new* host's signed policy.

## Named successor crash regressions

`bun test test/secure-relay-v4.test.ts --test-name-pattern 'M4 successor crash boundaries'` exercises these six cases against the actual relay reducer and its strict exported/imported state:

- Result unacknowledged: same device returns and completes exact cleanup/policy refresh.
- Result unacknowledged: device never returns; room retires without reusing old policy.
- Removal unstarted: same-device resume preserves exact removal obligation.
- Removal unstarted: permanent absence retires the room.
- Removal completed, policy absent: same-device resume publishes its own policy.
- Removal completed, policy absent: permanent absence retires the room.

These relay tests intentionally use opaque payload bytes and real Ed25519 signatures; they do not themselves exercise MLS decryption. The separate actual-browser fault script supplies that layer for its documented cases.

## Counterexample disposition

| Deliberate model weakening | Counterexample | Disposition |
|---|---|---|
| Persistence | Send before storing sender state | Expected model sensitivity result; not an implementation vulnerability |
| Grant | Prepare → replace socket → send using old grant | Expected model sensitivity result |
| Preview readiness | First result accepted → sender ready before host ACK → next guest grant | Reproduced implementation race; fixed by waiting for host backlog drain and waking on host ACK/resume completion; failing-before/passing-after regressions retained |
| KeyReuse | Request → authorize → Add → expire → Remove → request same key | Expected model sensitivity result |
| Snapshot | Disconnect → replay/persist → accept unauthenticated host snapshot | Expected model sensitivity result |
| Target | Host loss → offer candidate 2 → candidate 3 accepts candidate 2's capability | Expected model sensitivity result |
| Interlock | Start an operation while admission is pending, then send | Expected composition sensitivity result |
| ResumeSnapshot | Accept the new host snapshot without applying the signed acceptance in the guest's replay | Expected focused-model sensitivity result |
| OldCompletion | Same nonempty backlog end on two sockets; a delayed completion activates the wrong incarnation | Expected focused-model sensitivity result |
| OldAck | Relay accepted the first completion; its delayed ACK releases ordinary work on the replacement | Expected focused-model sensitivity result; the real browser defect was a stuck replay, not premature release |
| StaleEnd | Guest captures the old replay prefix; authority changes before relay activation; obsolete completion is accepted | Expected focused-model sensitivity result |

During construction, one relay recovery test incorrectly sent a normal delivery ACK before its resume-complete terminator. The relay rejected that completion as `invalid-reference`. Inspection established that the controller suppresses ordinary ACKs during replay; the test was corrected to use the exact replay terminator. This was a harness error, not a demonstrated implementation vulnerability. Browser setup also requires permission to copy the generated secret; a clipboard-denied setup is not a room-protocol failure.

Browser exploration reproduced the preview race as consecutive guest frames: the first was accepted, then the second received `recipient-unavailable` while the host still had unacknowledged delivery. This was a real relay scheduling issue, not a cryptographic break. The M1 model now separates host storage and ACK, checks readiness before the next grant, and requires a counterexample when that safeguard is disabled.

The unsent-successor-policy browser crash also exposed a lifecycle reconciliation defect: `completeAdmissionLifecycle` rejected a pending application even when there was no admission barrier to complete. Its mutation guard now applies only after finding the matching barrier; an unrelated valid lifecycle signal leaves the restored ciphertext, rollback context and storage revision unchanged. The real-MLS restart regression failed before this change and passes after it. This is separate from the preview model mutation and is not claimed as a TLC-discovered implementation defect.

Two browser cuts exposed distinct progress defects: replacement replay inherited the old completion ID, and a restored successor mistook roster absence for completion of relay cleanup. The latter left the relay cancelling new orders. The controller now retains the bound Remove, then the exact retirement request until its ACK. A real-MLS restart regression checks both stages with a duplicate lifecycle notice. A separate observer defect appeared when the socket closed immediately after Remove: replay authenticated the already-processed delivery but attempted to consume a FIFO marker no longer present. A matching digest can acknowledge a duplicate; only a still-installed matching marker may be consumed. These are concrete regressions, not proofs of arbitrary recovery.
