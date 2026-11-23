#!/usr/bin/env python3
"""Check each component before its product, without trusting saved fingerprints."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
MODULES = ['M1Delivery', 'M2Admission', 'M3Resume', 'M4Succession', 'Coordination']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tlapm', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    pm = args.tlapm.resolve(strict=True)
    version = subprocess.check_output([pm, '--version'], text=True).strip()
    if version != '961e909':
        raise SystemExit(f'Unexpected TLAPM {version}; expected 961e909')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    records = []
    with tempfile.TemporaryDirectory(prefix='pillowfort-induction-') as cache:
        for module in MODULES:
            proof = f'verification/{module}Proof.tla'
            result = subprocess.run([pm, '--strict', '--nofp', '--threads', '2', '--cache-dir', cache,
                                     '-I', 'verification', proof], cwd=ROOT, encoding='utf8',
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            log = result.stdout.replace(cache, '$PROOF_CACHE').replace(str(ROOT), '$SOURCE')
            (out / f'{module}.log').write_text(log)
            totals = re.findall(r'\[INFO\]: All (\d+) obligations proved\.', log)
            if result.returncode or len(totals) != 1 or not int(totals[0]):
                raise SystemExit(f'{module}: no successful complete proof; see {out / (module + ".log")}')
            records.append({'module': module, 'obligations': int(totals[0]), 'source': {
                f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in [f'verification/{module}.tla', proof]}})
            print(f'{module}: {totals[0]} obligations proved', flush=True)
    (out / 'induction.json').write_text(json.dumps({
        'proofManager': version, 'strict': True, 'reusedFingerprints': False, 'modules': records,
        'theorem': 'Init /\\ [][Next]_vars => []Safety for the intact modeled transitions, for every natural Capacity and MaxOps.',
        'scope': 'Arbitrary trace length and parameter sizes, not arbitrary new identities or sockets. The models retain three succession identities, their abstract writes and their specified replay phases. Safety, not liveness or whole-program refinement.'
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
