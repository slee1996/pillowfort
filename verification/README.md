# Pillowfort coordination analysis

The executable models implement the M1–M4 planning decomposition. The source-grounded protocol contract is in `docs/PROTOCOL_V4_TECHNICAL_APPENDIX.md`; the property-by-property coverage and exclusions are in `docs/PROTOCOL_V4_VERIFICATION_MATRIX.md`.

- `IdleRetirement.tla`: deletion and notification to two original device/socket pairs. Model dispatch and receipt separately; check exact ownership and conditional dispatch under fair scheduling, not delivery to an offline peer. Five weakened configurations violate a property; a witness reaches both receipts through a restart after the first send.
- `OutcomeRecovery.tla`: two immutable application ciphertexts; accepted and rejected results, durable MLS generation, speculative application changes, retries and restoration.
- `HistoricalCleanup.tla`: two ordered retirement tuples, old acknowledgments versus the current request, historical marker replay, and processing already-queued incoming work before socket close.
- `M1Delivery.tla`: sender persistence, connection-bound grants, host preview readiness, delivery/result separation, replay and prefix ACKs.
- `Reinvite.tla`: delayed receipt of a manual refusal versus the next offer, and independent invitation/roster/bootstrap checks after migration and reload. Three weakened guards must fail; an unweakened witness reaches active membership. It abstracts authenticated keys and storage, not the cryptography itself.
- `M2Admission.tla`: host approval, Add/Welcome/bootstrap/proof/activation, partial-admission expiry, single-use KeyPackages and retained identity ambiguity.
- `M3Resume.tla`: replay persistence, authenticated snapshot reconciliation and exact connection/request/terminator completion.
- `M4Succession.tla`: internal join-order offers, explicit acceptance/refusal, old-host fencing, durable authority, former-host removal, successor policy refresh and safe termination without a new policy.
- `Coordination.tla`: staged 12/16-step prefixes plus a fixed-point exploration of all four interlocked machines with one operation, one KeyPackage token, a backlog of one, and three host/succession identities. The latter has no step cutoff; it does not remove the finite domain bounds.
- `ResumeAcrossSuccession.tla`: M3 replay and M4 consent joined by a signed acceptance in a returning guest's backlog. The relay can change host before or during replay; completion is checked against its current backlog end.
- `RepeatedResume.tla`: any positive finite bound on replacement sockets after handoff. The channel retains all earlier authenticated completion requests and ACKs, including requests with the same backlog end. A dedicated finite witness reaches four replacements with earlier receipts still in flight.

- `ReconnectRace.tla`: host resume ownership versus guest replay completion, a late close from a replaced socket, and a cut after storing but before delivering a time-limited offer. Four unweakened witnesses reach both reconnect orders, a post-restore acceptance, and a refusal followed by another member's acceptance.

Run Java 21 or compatible with pinned `tla2tools` v1.7.4:

```sh
curl --fail --location https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar --output /tmp/tla2tools-1.7.4.jar
python3 scripts/check-protocol-models.py --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-model-results
```

The runner checks the JAR SHA-256 before execution. It writes source copies, exact configurations, raw TLC logs, deliberate-mutant counterexamples, commands and per-configuration state counts to the output directory. It fails if a normal model violates its invariant or any deliberately weakened model does not produce a counterexample.

The runner enumerates all normal, mutant and witness profiles and rejects an unexpected result in any of them. `--case composed-full-finite` selects the full finite product. Disabled TLC deadlock checking is not a deadlock-freedom result. The original preview-readiness mutation corresponds to a separately reproduced relay scheduling bug. A model counterexample by itself is not an implementation bug.

### Inductive safety and production decisions

The four `*Proof.tla` component modules establish their invariants by induction on the actual M1–M4 model actions. `CoordinationProof.tla` projects each product step onto a component action or stutter and proves the send interlock. `Capacity` and `MaxOps` may be any natural numbers; no trace length is fixed. Admission ordinals and socket incarnations have arbitrary positive finite bounds. M4 allows joins, departures and repeated transfers; at every live change of host the nominated member previously accepted. Selection consumes exactly one entry in the current policy. The separate `RepeatedResumeProof.tla` induction retains old completions across replacements. These are safety results under abstract authenticated messages and atomic storage, not whole-program refinement or unconditional progress.

Use TLAPM [`961e909`](https://github.com/tlaplus/tlapm/tree/961e909fa3aca1fba412ee0908c5848b808e4b24) with native Z3 4.13.3. The [verification workflow](../.github/workflows/protocol-induction.yml) pins their Linux binaries by digest. The checker verifies **all six** modules without reusing fingerprints; proving only the product would assume its imported component theorems. `node scripts/check-protocol-guards.mjs /tmp/pf-guards` separately reads the shipped TypeScript expressions and requires both satisfiable outcomes and unsatisfiable disagreement with the stated decision. It abstracts signature and membership predicates, not their implementation. It fails on an unknown expression. The same script checks both ends of ordered policy construction and the relay’s first-eligible scan. `check-protocol-boundaries.mjs` checks whether concrete publication sites are reached only after the required completed write, including exceptions and early returns. It requires five in-memory changes to break their intended property; it does not execute mutated runtime code.

```sh
python3 scripts/check-protocol-proofs.py --tlapm /path/to/tlapm/bin/tlapm --output /tmp/pf-induction
node scripts/check-protocol-guards.mjs /tmp/pf-guards /path/to/z3
node scripts/check-protocol-boundaries.mjs /tmp/pf-boundaries
```

### Implementation conformance and the host-loss tradeoff

`PILLOWFORT_RELAY_CONFORMANCE_REPORT=/tmp/relay.json bun test ./test/secure-relay-v4.test.ts` applies independent pre/postconditions to every transition exercised by the relay suite, not an alternative implementation. All wire families plus create, disconnect and clock advancement must be represented. It checks retained outcomes, grants, immutable bindings, exact admission and resume, the two transfer paths, replayed historical removals and exact FIFO head completion. The output contains counts, never credentials. Coverage of every family is not coverage of every possible input or schedule.

For the private timing study, build the production client, then run `python3 scripts/measure-premature-succession.py /tmp/pillowfort-study` (a fresh output directory, Bun and Playwright Chromium; the process-suspension arm uses POSIX signals). The relay, stopwatch and two observers remain running. `--subset absence` selects the still-absent host comparison. A 30-second extension exists only in the counterfactual Worker fixture. The timed interruption begins at the first fresh challenge after setup. No clock is advanced. A stopped Chromium process set is not a physical sleeping laptop. Never suspend a shared test host.

To check just the cross-host resume:

```sh
python3 scripts/check-protocol-models.py --model ResumeAcrossSuccession --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-resume-model
bun test ./test/secure-relay-v4.test.ts --test-name-pattern 'fresh replay boundary when succession'
npm --prefix client run build
bun scripts/protocol-browser-evidence.ts --mode faults --fault guest-resume-after-succession --output /tmp/pillowfort-resume-browser
```

The model checks one ordinary guest, one consenting successor and one replacement connection. The endpoint's replayed signature, the relay's snapshot and the relay's current backlog end are distinct inputs. A stale completion cannot activate the guest; the check records the host **at activation**, not the host indefinitely afterward. With all guards intact, the `NoRecoveredGuest` probe must produce a trace in which the guest receives its completion ACK and the successor finishes removal. This guards against a model that passes simply by blocking every return. The browser scenario exercises that path using separate profiles. The model checks authority and replay ordering, not wall-clock time to an offer; that behavior is covered by relay and browser tests.

To reproduce the second interruption and removal boundary, build the client as above, then run:

```sh
python3 scripts/check-protocol-models.py --model RepeatedResume --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-second-model
bun test ./test/secure-relay-v4.test.ts --test-name-pattern 'fences the first resume socket|replays a former-host retirement'
bun test ./test/secure-room-engine.test.ts --test-name-pattern 'binds authentication to one socket'
bun scripts/protocol-browser-evidence.ts --mode faults --fault second-resume --output /tmp/pillowfort-second-browser
bun scripts/protocol-browser-evidence.ts --mode faults --fault former-host-removal --output /tmp/pillowfort-removal-browser
```

The second model distinguishes which socket activated the relay from which ACK released the guest. The safe witness requires recovery with the first ACK still in flight. The removal experiment instead tests real MLS storage, page reload and browser message/close ordering; TLC does not model those mechanisms.

To exercise the production Worker locally (ephemeral storage, no live credentials):

```sh
npm run build
node scripts/protocol-workerd-evidence.mjs persisted-offer /tmp/pillowfort-worker-restart
for cut in silent-host-loss silent-host-uplink silent-host-downlink probe-restart idle-retirement idle-retirement-prefix; do
  node scripts/protocol-workerd-evidence.mjs "$cut" "/tmp/pillowfort-$cut"
done
bun scripts/protocol-browser-evidence.ts --mode faults --fault lost-guest-keys --output /tmp/pillowfort-lost-keys
bun scripts/protocol-browser-evidence.ts --mode faults --fault peer-storage --output /tmp/pillowfort-peer
bun scripts/protocol-browser-evidence.ts --mode faults --fault full-room --output /tmp/pillowfort-full
python3 scripts/check-protocol-models.py --model HostPath --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-hostpath
```

The offer test evicts the production Durable Object between commit and dispatch with its sockets hibernated. The test process receives complete Worker evidence over local IPC; a browser that sees the offer first still records its own observation time before awaiting the measured relay timestamp. The three silent cuts discard bytes on both legs, on the uplink, or on the downlink of an open TCP path; none forces a transport close. Each must see an offer within the local scenario budget, a signed refusal then acceptance, and two-way encrypted chat. `probe-restart` loses the original challenge after commit, evicts the object, and requires the original nonce on retry and healthy chat without succession. `HostPath` checks eventual suspicion for a permanently silent watched host under weakly fair alarm dispatch; it cannot bound wall-clock delay. Its three reply-binding mutations violate safety; suppressing detection violates the temporal property. The room-limit exercise uses only local browser contexts. No public fault injection or load test.

## Bounds and exclusions

Normal TLC configurations use up to two operation/KeyPackage tokens, backlog capacity two, four succession ranks and five successive socket incarnations in the focused profiles. Time is abstracted into relevant deadline regions. TLC checks bounded prefixes and one complete finite product. Induction removes those numerical bounds for the specified component relations. Coupled and high-capacity profiles retain their own declared domains; no model represents all browser processes or MLS trees. Cryptographic correctness, malicious endpoint equivocation, full host/epoch view agreement, all historical-marker identities, arbitrary conflicting authenticated peer views, deadlock freedom, fairness, unbounded liveness and physical storage durability remain outside this analysis. The coverage matrix marks those exclusions rather than treating every property in the broader plan as proved.

The `guest-backpressure` cut intercepts one ordinary guest ACK on loopback, not a flood. It emulates the relay’s limit response and close, waits for authenticated recovery, and checks that the exact original device can exchange fresh chat without displaying the replayed delivery twice. It is never enabled in production.

To exercise admission and resume inside a *chain* of host losses, build the release client and run `bun scripts/protocol-browser-evidence.ts --mode faults --fault changing-tenures --output /tmp/pillowfort-changing-tenures`. The same room must advance through four holders by signed choice, admit a fifth device using a successor-pinned invite, resume that device four times with bidirectional encrypted traffic after every matching receipt, and finish with both remaining participants observing closure. It runs on loopback; no production fault injection.

The relay regressions and actual browser fault script are separate evidence. Run their documented commands rather than inferring an implementation pass from TLC results.
