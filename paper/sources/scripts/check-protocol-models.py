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
    profiles += [("composed-larger-backlog", "Coordination", 2, 1, "None", 4, 16)]
    profiles += [(f"mutation-{mutation}", module, 2, 2, mutation, None, None) for module, mutation in
                 [("M1Delivery", "Persistence"), ("M1Delivery", "Grant"), ("M1Delivery", "Preview"),
                  ("M2Admission", "KeyReuse"), ("M3Resume", "Snapshot"), ("M4Succession", "Target")]]
    profiles += [("mutation-Interlock", "Coordination", 1, 1, "Interlock", 2, 8)]
    results = []
    for name, module, capacity, operations, mutant, stage, depth in profiles:
        config = output / (name + ".cfg")
        config.write_text("INIT Init\nNEXT Next\nINVARIANT Safety\nCONSTANTS\n"
                          f' Capacity = {capacity}\n MaxOps = {operations}\n Broken = "{mutant}"\n' +
                          (f" Stage = {stage}\n MaxDepth = {depth}\n" if stage is not None else ""))
        with tempfile.TemporaryDirectory(prefix="pillowfort-tlc-") as states:
            command = ["java", "-XX:+UseParallelGC", "-Xmx1024m", "-cp", str(jar), "tlc2.TLC", "-workers", "1",
                       "-seed", "1", "-deadlock", "-metadir", states,
                       "-config", config.name, module + ".tla"]
            run = subprocess.run(command, cwd=output, capture_output=True, text=True, timeout=300)
        log = run.stdout + run.stderr
        (output / (name + ".log")).write_text(log)
        counterexample = "Invariant Safety is violated" in log
        exhaustive = "Model checking completed. No error has been found." in log
        success = counterexample if mutant != "None" else run.returncode == 0 and exhaustive
        counts = re.search(r"([\d,]+) states generated, ([\d,]+) distinct states found", log)
        result = {"name": name, "module": module, "capacity": capacity, "maxOperations": operations,
                  "stage": stage, "maxCompositionSteps": depth, "mutation": mutant,
                  "exitCode": run.returncode, "expectedCounterexample": mutant != "None",
                  "counterexampleFound": counterexample, "passed": success,
                  "statesGenerated": int(counts[1].replace(",", "")) if counts else None,
                  "distinctStates": int(counts[2].replace(",", "")) if counts else None,
                  "config": config.name, "log": name + ".log", "command": command}
        results.append(result)
        print(json.dumps(result), flush=True)
        report = {"checker": "TLC 2.19 / tla2tools v1.7.4", "jarSha256": JAR_SHA256,
                  "platform": platform.platform(), "java": subprocess.run(["java", "-version"], capture_output=True, text=True).stderr,
                  "scope": "Finite coordination safety abstraction; no cryptographic proof, deadlock freedom, fairness or unbounded liveness claim.",
                  "results": results, "passed": len(results) == len(profiles) and all(r["passed"] for r in results)}
        (output / "model-results.json").write_text(json.dumps(report, indent=2) + "\n")
        if not success:
            raise SystemExit(f"Unexpected checker outcome in {name}; inspect {output / (name + '.log')}")


if __name__ == "__main__":
    main()
