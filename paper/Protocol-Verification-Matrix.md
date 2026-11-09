# Protocol v4-CS1 verification matrix

This matrix maps the existing M1–M4 analysis plan to evidence, not to claims of complete verification. Run `npm run check` for implementation suites; run the model and browser commands in `PROTOCOL_V4_TECHNICAL_APPENDIX.md` for the additional evidence. Exact source revision, commands, raw logs and outcomes are recorded in the pinned artifact.

| Plan obligation | Model coverage | Concrete implementation evidence | Explicit exclusion |
|---|---|---|---|
| M1.1 Exact grant and usable preview | M1 connection and host-backlog guards; Grant and Preview mutants must fail | Relay connection-bound cancellation and M1 host-preview readiness regressions, including host ACK and host resume completion | Model abstracts signed bytes and wall-clock timestamps |
| M1.2 Persist before effects | M1 separate sender storage/send and relay result/emission; Persistence mutant must fail | `secure-room-engine.test.ts`: composite state/send/restart/CAS failures; `secure-room-do-runtime-v4.test.ts`: persisted terminal notice | No proof of filesystem/IndexedDB hardware durability |
| M1.3 Stable outcome | Accepted-set monotonicity only; rejection rollback not modeled | Relay exact replay fingerprints; engine application rollback versus rejected commit retirement | No model of all rejected-operation/game interleavings |
| M1.4 Prefix ACK | M1 front-of-backlog application/ACK | Relay durable delivery exact-prefix tests | Resume uses `resume-complete`, not independent per-entry ACKs |
| M1.5 No duplicate application | M1 retained seen-set and repeated delivery | Real MLS engine duplicate/replay/reorder tests | Retention is bounded; no unbounded exactly-once guarantee |
| M2.1 Activation evidence | M2 ordered approval/Add/Welcome/bootstrap/proof/activation | Relay activation key/proof binding; engine explicit exact host approval | Signature and MLS capabilities abstracted in model |
| M2.2 Immutable binding | M2 room/admission proof guards; key token retention | Invitation-bound KeyPackage substitutions and strict member binding tests | Model does not represent full cryptographic credential encodings |
| M2.3 Pending not active | M2 active-state guard; composed send interlocks | Relay every post-Add phase barrier; real browser waits for self `member-lifecycle:active` | Composer visibility is not admission completion |
| M2.4 KeyPackage single use | M2 used-key set; KeyReuse mutant must fail | Relay digest history reuse/exhaustion tests | Finite modeled tokens and finite production history |
| M2.5 Preserve uncertain identity | M2 durable ambiguous flag across abstract crash | Browser engine ambiguous authentication/reload/CAS/registry tests | Capacity/eviction registry not represented by TLC |
| M3.1 No early ordinary work | M3 Ready guard and composed interlock | Controller snapshot/terminator/completion tests; real-engine restored outbox survives unrelated active-lifecycle replay | Repeated reconnect sequences and concrete lifecycle helper calls are not exhaustively modeled |
| M3.2 Exact completion | M3 request/connection/terminator checks | Relay empty/nonempty replay and stale-sentinel tests | One modeled replacement connection |
| M3.3 No snapshot-only authority | M3 authenticated-host comparison; Snapshot mutant must fail | Controller authoritative snapshot and MLS roster reconciliation tests | Composed model does not enumerate every client/relay host-view disagreement |
| M3.4 Historical causality | M4 abstract removal order; exact marker IDs not modeled | Relay exact marker/Remove/snapshot/end replay; engine replayed-marker cleanup | No TLC proof of all concrete marker-backlog interleavings |
| M3.5 Receive before close | Not represented in reduced TLC model | Browser engine/controller final self-removal and serialized-close tests | No complete network event-loop model |
| M4.1 Scoped authority | M4 policy/offer/selected signer checks; Target mutant must fail | Signed sidecar target/policy/capability rejection tests | No proof that a relay can compare opaque MLS plaintext to a public sidecar |
| M4.2 Explicit consent | M4 choice stored before authority commit | Relay refusal→next acceptance and universal-refusal retirement; live catch/duck evidence | Arbitrary agent-host intent is outside protocol verification |
| M4.3 Persisted switch | M4 separate authority commit/removal actions | Relay recipient-overflow regression; lost-result crash-boundary test | Runtime storage implementation not refined to TLA+ |
| M4.4 Mode-specific removal | M4 exact abstract removal steps | Engine signed leave/Remove tests and relay former-host removal lifecycle | Model omits MLS tree internals |
| M4.5 Reconcile views | M3 snapshot checks; M4 retained capability | Six relay successor crash regressions; browser lost-result and unsent-policy recovery | No global simultaneous-view assertion |
| M4.6 Join-order priority | M4 earliest eligible unattempted member | Relay disconnected-member skip, expired offer advance, refusal progression | A dishonest relay can lie about eligibility/connectivity |
| M4.7 Tenure binding | M4 invalidates policy on switch, refreshes only under current host | Prior-policy reducer rejection; three permanent-successor-loss cases retire without old delegation | No automatic second handoff before a new policy is accepted |
| M4.8 Barrier completion | Abstract remove-store/ACK/completion ordering only | Relay already-retired lifecycle regression; engine durable retirement control/replayed marker tests | Concrete duplicate lifecycle signals are not exhaustively modeled |
| Composition | Staged M1→M1+M2→M1+M2+M3→M1–M4 send guards; Interlock mutant must fail | Existing admission/removal/host-transfer barriers and full project gate | 12/16-step bounded prefixes; no refinement, deadlock-freedom or liveness proof |
| Peer membership/storage disagreement | Not represented as malicious MLS divergence in TLC | Browser storage-failure experiment and real MLS engine validation/rollback tests | Failure isolation, not automatic epoch merging |

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

During construction, one relay recovery test incorrectly sent a normal delivery ACK before its resume-complete terminator. The relay rejected that completion as `invalid-reference`. Inspection established that the controller suppresses ordinary ACKs during replay; the test was corrected to use the exact replay terminator. This was a harness error, not a demonstrated implementation vulnerability. Browser setup also requires permission to copy the generated secret; a clipboard-denied setup is not a room-protocol failure.

Browser exploration reproduced the preview race as consecutive guest frames: the first was accepted, then the second received `recipient-unavailable` while the host still had unacknowledged delivery. This was a real relay scheduling issue, not a cryptographic break. The M1 model now separates host storage and ACK, checks readiness before the next grant, and requires a counterexample when that safeguard is disabled.

The unsent-successor-policy browser crash also exposed a lifecycle reconciliation defect: `completeAdmissionLifecycle` rejected a pending application even when there was no admission barrier to complete. Its mutation guard now applies only after finding the matching barrier; an unrelated valid lifecycle signal leaves the restored ciphertext, rollback context and storage revision unchanged. The real-MLS restart regression failed before this change and passes after it. This is separate from the preview model mutation and is not claimed as a TLC-discovered implementation defect.
