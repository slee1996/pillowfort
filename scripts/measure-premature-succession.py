#!/usr/bin/env python3
"""Reproduce the paired small-room study using only private workerd instances."""
import argparse
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
CASES = [("network-3000", 0), ("network-18000", 0), ("network-18000", 30000),
         ("suspend-3000", 0), ("suspend-18000", 0), ("suspend-18000", 30000),
         ("reply-12000", 0), ("reply-18000", 0), ("reply-18000", 30000), ("close-3000", 0),
         ("absence-52000", 0), ("absence-52000", 30000)]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("output", type=Path)
    p.add_argument("--repetitions", type=int, default=2)
    p.add_argument("--subset", choices=("all", "interruption", "absence"), default="all")
    args = p.parse_args()
    cases = [p for p in CASES if args.subset == "all" or p[0].startswith("absence-") == (args.subset == "absence")]
    if args.repetitions < 1:
        p.error("choose at least one repetition")
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for repetition in range(1, args.repetitions + 1):
        for case, extra in (cases if repetition % 2 else reversed(cases)):
            directory = out / f"{repetition}-{case}-{extra}"
            directory.mkdir()  # Never silently replace or select observations.
            env = dict(os.environ, PILLOWFORT_STUDY_CASE=case, PILLOWFORT_STUDY_EXTRA_MS=str(extra))
            with (directory / "run.log").open("w") as log:
                proc = subprocess.run(["node", "scripts/protocol-workerd-evidence.mjs", "premature-succession", str(directory)],
                                      cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=125)
            if proc.returncode:
                raise SystemExit((directory / "run.log").read_text())
            record = json.loads((directory / "browser-results.json").read_text())
            assert record["passed"] and len(record["faults"]) == 1
            trial = {"repetition": repetition, **record["faults"][0]}
            assert trial["setting"] == case and trial["controlExtraFinalWaitMs"] == extra
            results.append(trial)
            print(json.dumps(trial), flush=True)
    (out / "results.json").write_text(json.dumps({"environment": record["environment"], "trials": results}, indent=2) + "\n")


if __name__ == "__main__":
    main()
