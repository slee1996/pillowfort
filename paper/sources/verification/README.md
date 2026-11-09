# Pillowfort coordination analysis

The executable models implement the M1–M4 planning decomposition. The source-grounded protocol contract is in `docs/PROTOCOL_V4_TECHNICAL_APPENDIX.md`; the property-by-property coverage and exclusions are in `docs/PROTOCOL_V4_VERIFICATION_MATRIX.md`.

- `M1Delivery.tla`: sender persistence, connection-bound grants, host preview readiness, delivery/result separation, replay and prefix ACKs.
- `M2Admission.tla`: host approval, Add/Welcome/bootstrap/proof/activation, partial-admission expiry, single-use KeyPackages and retained identity ambiguity.
- `M3Resume.tla`: replay persistence, authenticated snapshot reconciliation and exact connection/request/terminator completion.
- `M4Succession.tla`: internal join-order offers, explicit acceptance/refusal, old-host fencing, durable authority, former-host removal, successor policy refresh and safe termination without a new policy.
- `Coordination.tla`: staged composition with admission, resume and host-availability interlocks and explicit 12/16-step bounds.

Run Java 21 or compatible with pinned `tla2tools` v1.7.4:

```sh
curl --fail --location https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar --output /tmp/tla2tools-1.7.4.jar
python3 scripts/check-protocol-models.py --jar /tmp/tla2tools-1.7.4.jar --output /tmp/pillowfort-model-results
```

The runner checks the JAR SHA-256 before execution. It writes source copies, exact configurations, raw TLC logs, deliberate-mutant counterexamples, commands and per-configuration state counts to the output directory. It fails if a normal model violates its invariant or any deliberately weakened model does not produce a counterexample.

Nine safe configurations and seven mutation configurations are required. The preview-readiness mutation reproduces the abstract form of a separately confirmed relay bug: a new guest grant could race the host's ACK of the prior delivery. The concrete fix waits for host backlog drain and wakes the queued request on host ACK/resume completion. This is progress coordination, not a cryptographic primitive.

## Bounds and exclusions

Standalone models use at most two operation/KeyPackage tokens, backlog capacities up to two and three succession identities. Time is abstracted into relevant deadline regions. The composition checks bounded prefixes; it is not a refinement proof of the TypeScript implementation. Cryptographic correctness, malicious endpoint equivocation, full host/epoch view agreement, all historical-marker identities, repeated arbitrary reconnects, deadlock freedom, fairness, unbounded liveness and physical storage durability remain outside this analysis. The coverage matrix marks those exclusions rather than treating every property in the broader plan as proved.

The relay regressions and actual browser fault script are separate evidence. Run their documented commands rather than inferring an implementation pass from TLC results.
