# Pillowfort coordination analysis

The executable models implement the M1–M4 planning decomposition. The source-grounded protocol contract is in `docs/PROTOCOL_V4_TECHNICAL_APPENDIX.md`; the property-by-property coverage and exclusions are in `docs/PROTOCOL_V4_VERIFICATION_MATRIX.md`.

- `M1Delivery.tla`: sender persistence, connection-bound grants, host preview readiness, delivery/result separation, replay and prefix ACKs.
- `M2Admission.tla`: host approval, Add/Welcome/bootstrap/proof/activation, partial-admission expiry, single-use KeyPackages and retained identity ambiguity.
- `M3Resume.tla`: replay persistence, authenticated snapshot reconciliation and exact connection/request/terminator completion.
- `M4Succession.tla`: internal join-order offers, explicit acceptance/refusal, old-host fencing, durable authority, former-host removal, successor policy refresh and safe termination without a new policy.
- `Coordination.tla`: staged composition with admission, resume and host-availability interlocks and explicit 12/16-step bounds.
- `ResumeAcrossSuccession.tla`: M3 replay and M4 consent joined by a signed acceptance in a returning guest's backlog. The relay can change host before or during replay; completion is checked against its current backlog end.
- `RepeatedResume.tla`: two consecutive guest replacement sockets after handoff. Delayed completions retain their authenticated socket; delayed ACKs name a completion, not a backlog position.

Run Java 21 or compatible with pinned `tla2tools` v1.7.4:

```sh
curl --fail --location https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar --output /tmp/tla2tools-1.7.4.jar
python3 scripts/check-protocol-models.py --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-model-results
```

The runner checks the JAR SHA-256 before execution. It writes source copies, exact configurations, raw TLC logs, deliberate-mutant counterexamples, commands and per-configuration state counts to the output directory. It fails if a normal model violates its invariant or any deliberately weakened model does not produce a counterexample.

The default run requires eleven safe configurations, eleven deliberate mutations and two reachability witnesses. The original preview-readiness mutation corresponds to a separately reproduced relay scheduling bug. A model counterexample by itself is not an implementation bug.

To check just the cross-host resume:

```sh
python3 scripts/check-protocol-models.py --model ResumeAcrossSuccession --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-resume-model
bun test ./test/secure-relay-v4.test.ts --test-name-pattern 'fresh replay boundary when succession'
npm --prefix client run build
bun scripts/protocol-browser-evidence.ts --mode faults --fault guest-resume-after-succession --output /tmp/pillowfort-resume-browser
```

The model checks one ordinary guest, one consenting successor and one replacement connection. The endpoint's replayed signature, the relay's snapshot and the relay's current backlog end are distinct inputs. A stale completion cannot activate the guest; the check records the host **at activation**, not the host indefinitely afterward. With all guards intact, the `NoRecoveredGuest` probe must produce a trace in which the guest receives its completion ACK and the successor finishes removal. This guards against a model that passes simply by blocking every return. The browser scenario exercises that successful path using separate browser profiles and the real disconnect grace.

To reproduce the second interruption and removal boundary, build the client as above, then run:

```sh
python3 scripts/check-protocol-models.py --model RepeatedResume --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-second-model
bun test ./test/secure-relay-v4.test.ts --test-name-pattern 'fences the first resume socket|replays a former-host retirement'
bun test ./test/secure-room-engine.test.ts --test-name-pattern 'binds authentication to one socket'
bun scripts/protocol-browser-evidence.ts --mode faults --fault second-resume --output /tmp/pillowfort-second-browser
bun scripts/protocol-browser-evidence.ts --mode faults --fault former-host-removal --output /tmp/pillowfort-removal-browser
```

The second model distinguishes which socket activated the relay from which ACK released the guest. The safe witness requires recovery with the first ACK still in flight. The removal experiment instead tests real MLS storage, page reload and browser message/close ordering; TLC does not model those mechanisms.

## Bounds and exclusions

Standalone models use at most two operation/KeyPackage tokens, backlog capacities up to two and three succession identities. Time is abstracted into relevant deadline regions. The composition checks bounded prefixes; it is not a refinement proof of the TypeScript implementation. Cryptographic correctness, malicious endpoint equivocation, full host/epoch view agreement, all historical-marker identities, repeated arbitrary reconnects, deadlock freedom, fairness, unbounded liveness and physical storage durability remain outside this analysis. The coverage matrix marks those exclusions rather than treating every property in the broader plan as proved.

The relay regressions and actual browser fault script are separate evidence. Run their documented commands rather than inferring an implementation pass from TLC results.
