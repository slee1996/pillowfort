#!/usr/bin/env python3
"""Run the bounded M1–M4 safety models and require counterexamples for mutants."""
import argparse
import hashlib
import json
import platform
import re
import subprocess
import tempfile
from pathlib import Path

JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", help="run only configurations for this TLA+ module")
    parser.add_argument("--case", help="run one named configuration")
    args = parser.parse_args()
    jar = args.jar.resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA256:
        raise SystemExit("TLC JAR does not match the pinned v1.7.4 SHA-256")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    for model in (ROOT / "verification").glob("*.tla"):
        (output / model.name).write_bytes(model.read_bytes())
    profiles = [(name, name, 2, 2, "None", None, None) for name in
                ["M1Delivery", "M2Admission", "M3Resume", "M4Succession"]]
    profiles += [(f"composed-M1-M{stage}", "Coordination", 1, 1, "None", stage, 12)
                 for stage in range(1, 5)]
    profiles += [("composed-larger-backlog", "Coordination", 2, 1, "None", 4, 16),
                 ("composed-full-finite", "Coordination", 1, 1, "None", 4, 0)]
    profiles += [(f"mutation-{mutation}", module, 2, 2, mutation, None, None) for module, mutation in
                 [("M1Delivery", "Persistence"), ("M1Delivery", "Grant"), ("M1Delivery", "Preview"),
                  ("M2Admission", "KeyReuse"), ("M3Resume", "Snapshot"), ("M4Succession", "Target"),
                  ("M4Succession", "DelayedOffer")]]
    profiles += [("mutation-Interlock", "Coordination", 1, 1, "Interlock", 2, 8)]
    coupled = "ResumeAcrossSuccession"
    witnesses = {"witness-RecoveredGuest": "NoRecoveredGuest", "witness-SecondRecovery": "NoSecondRecovery"}
    profiles += [(name, coupled, 1, 1, mutation, None, None) for name, mutation in
                 [(coupled, "None"), ("mutation-ResumeSnapshot", "Snapshot"),
                  ("mutation-StaleEnd", "StaleEnd"), ("witness-RecoveredGuest", "None")]]
    profiles += [(name, "RepeatedResume", 1, 1, mutation, None, None) for name, mutation in
                 [("RepeatedResume", "None"), ("mutation-OldCompletion", "OldCompletion"),
                  ("mutation-OldAck", "OldAck"), ("witness-SecondRecovery", "None")]]
    race = "ReconnectRace"
    for witness in ("HostReturned", "GuestWon", "ReplayedOffer", "RefusalAdvanced"):
        witnesses["witness-" + witness] = "No" + witness
    profiles += [(name, race, 1, 1, mutation, None, None) for name, mutation in
                 [(race, "None"), ("mutation-StaleClose", "StaleClose"),
                  ("mutation-RenewOffer", "RenewOffer"), ("mutation-EarlyCandidate", "EarlyCandidate")] +
                 [("witness-" + w, "None") for w in ("HostReturned", "GuestWon", "ReplayedOffer", "RefusalAdvanced")]]
    witnesses["witness-ReinvitedGuest"] = "NoReinvitedGuest"
    profiles += [(name, "Reinvite", 1, 2, mutation, None, None) for name, mutation in
                 [("Reinvite", "None"), ("mutation-CancelNew", "CancelNew"), ("mutation-ReplacePin", "ReplacePin"),
                  ("mutation-OtherSigner", "OtherSigner"), ("witness-ReinvitedGuest", "None")]]
    witnesses["witness-ReturnedHostPath"] = "NoFencedReturn"
    profiles += [(name, "HostPath", 1, 1, mutation, None, None) for name, mutation in
                 [("HostPath", "None"), ("mutation-OldSocket", "OldSocket"), ("mutation-WrongNonce", "WrongNonce"),
                  ("mutation-PeerReply", "PeerReply"), ("mutation-NeverDetect", "NeverDetect"),
                  ("witness-ReturnedHostPath", "None")]]
    witnesses["witness-RecoveredIdlePrefix"] = "NoRecoveredPrefix"
    profiles += [(name, "IdleRetirement", 1, 1, mutation, None, None) for name, mutation in
                 [("IdleRetirement", "None"), ("mutation-NoMarker", "NoMarker"), ("mutation-NoWake", "NoWake"),
                  ("mutation-AnyDevice", "AnyDevice"), ("mutation-AnyConnection", "AnyConnection"),
                  ("mutation-Unauthenticated", "Unauthenticated"), ("witness-RecoveredIdlePrefix", "None")]]
    witnesses.update({"witness-RecoveredRejection": "NoRecoveredRejection", "witness-TwoHistoricalRemovals": "NoTwoHistoricalRemovals"})
    for module, mutations, witness in [("OutcomeRecovery", ("Rewrite", "OtherOutcome", "RewindRatchet"), "RecoveredRejection"),
                                       ("HistoricalCleanup", ("OldRetire", "LifecycleReceipt", "MissingMarker", "EarlyClose"), "TwoHistoricalRemovals")]:
        profiles.append((module, module, 2, 2, "None", None, None))
        profiles.extend(("mutation-" + m, module, 2, 2, m, None, None) for m in mutations)
        profiles.append(("witness-" + witness, module, 2, 2, "None", None, None))
    if args.model:
        profiles = [p for p in profiles if p[1] == args.model]
        if not profiles:
            parser.error(f"unknown model: {args.model}")
    if args.case:
        profiles = [p for p in profiles if p[0] == args.case]
        if not profiles:
            parser.error(f"unknown configuration: {args.case}")
    results = []
    for name, module, capacity, operations, mutant, stage, depth in profiles:
        config = output / (name + ".cfg")
        invariants = "Safety" + (" " + witnesses[name] if name in witnesses else "")
        temporal = {"HostPath": "SilentProgress", "mutation-NeverDetect": "SilentProgress",
                    "IdleRetirement": "AttachedProgress", "mutation-NoWake": "AttachedProgress"}.get(name)
        behavior = f"SPECIFICATION Spec\nPROPERTY {temporal}" if temporal else "INIT Init\nNEXT Next"
        config.write_text(f"{behavior}\nINVARIANTS {invariants}\nCONSTANTS\n"
                          f' Capacity = {capacity}\n MaxOps = {operations}\n Broken = "{mutant}"\n' +
                          (f" Stage = {stage}\n MaxDepth = {depth}\n" if stage is not None else ""))
        with tempfile.TemporaryDirectory(prefix="pillowfort-tlc-") as states:
            command = ["java", "-XX:+UseParallelGC", "-Xmx1024m", "-cp", str(jar), "tlc2.TLC", "-workers", "1",
                       "-seed", "1", "-deadlock", "-metadir", states,
                       "-config", config.name, module + ".tla"]
            run = subprocess.run(command, cwd=output, capture_output=True, text=True, timeout=1800 if depth == 0 else 300)
        log = run.stdout + run.stderr
        (output / (name + ".log")).write_text(log)
        expected = witnesses.get(name, "Safety" if mutant != "None" else None)
        match = re.search(r"Invariant (\w+) is violated", log)
        violated = match[1] if match else None
        if temporal and "Temporal properties were violated" in log:
            violated = temporal
        if temporal and mutant != "None":
            expected = temporal
        exhaustive = "Model checking completed. No error has been found." in log
        success = (run.returncode == (13 if temporal and expected == temporal else 12) and violated == expected if expected
                   else run.returncode == 0 and exhaustive)
        counts = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found", log)
        result = {"name": name, "module": module, "capacity": capacity, "maxOperations": operations,
                  "stage": stage, "maxCompositionSteps": None if depth == 0 else depth,
                  "compositionToFixedPoint": depth == 0, "mutation": mutant,
                  "exitCode": run.returncode, "expectedCounterexample": mutant != "None",
                  "counterexampleFound": violated in ("Safety", "SilentProgress", "AttachedProgress"), "expectedViolation": expected,
                  "observedViolation": violated, "passed": success,
                  "statesGenerated": int(counts[1].replace(",", "")) if counts else None,
                  "distinctStates": int(counts[2].replace(",", "")) if counts else None,
                  "config": config.name, "log": name + ".log", "command": command}
        results.append(result)
        print(json.dumps(result), flush=True)
        report = {"checker": "TLC 2.19 / tla2tools v1.7.4", "jarSha256": JAR_SHA256,
                  "selectedModel": args.model, "platform": platform.platform(),
                  "java": subprocess.run(["java", "-version"], capture_output=True, text=True).stderr,
                  "scope": "Finite coordination abstractions. HostPath and IdleRetirement additionally check conditional progress under weakly fair dispatch; a send is not receipt. No cryptographic proof, system-wide deadlock freedom or unconditional liveness claim.",
                  "results": results, "passed": len(results) == len(profiles) and all(r["passed"] for r in results)}
        (output / "model-results.json").write_text(json.dumps(report, indent=2) + "\n")
        if not success:
            raise SystemExit(f"Unexpected checker outcome in {name}; inspect {output / (name + '.log')}")


if __name__ == "__main__":
    main()
