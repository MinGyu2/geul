#!/usr/bin/env python3
"""P2-B before/after: the same schema/contract mutations of genuine browser evidence, validated by
decoded_lease_run.py at --old-commit and by the current file. Run from the repository root:
  python3 -I tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/repro/version_typing_before_after.py \
    --old-commit 9a7c4ceabacc11b5f70ae3896ce32b672b0d969c --output OUT.json
"""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[6]
HARNESS = ROOT / 'tests/integration/rhwp/cache-concurrency'
RUNNER = 'tests/integration/rhwp/cache-concurrency/decoded_lease_run.py'
EVIDENCE = ROOT / 'tests/integration/rhwp/evidence'
GENUINE = {1: EVIDENCE / 't010-decoded-resource-lease-accounting/browser/decoded-lease-chrome.json',
           2: EVIDENCE / 't010-decoded-lease-accounting-hardening/browser/decoded-lease-chrome.json'}
MISSING = object()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mutate(value, field, new):
    value = copy.deepcopy(value)
    if new is MISSING:
        value.pop(field, None)
    else:
        value[field] = new
    return value


def verdict(fn):
    try:
        return 'ACCEPT: ' + str(fn())
    except Exception as error:  # noqa: BLE001 - the old validator may raise anything
        return 'REJECT: ' + type(error).__name__ + ': ' + str(error)[:120]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--old-commit', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('preserve previous output')
    sys.path.insert(0, str(HARNESS))
    source = subprocess.check_output(['git', '-C', str(ROOT), 'show', f'{a.old_commit}:{RUNNER}'])
    with tempfile.TemporaryDirectory(prefix='geul-old-validator-') as d:
        old_path = Path(d) / 'a/b/c/d/old_decoded_lease_run.py'  # old module uses parents[3]
        old_path.parent.mkdir(parents=True)
        old_path.write_bytes(source)
        old = load('old_decoded_lease_run', old_path)
    new = load('new_decoded_lease_run', HARNESS / 'decoded_lease_run.py')
    run = {c: json.loads(path.read_text())['run'] for c, path in GENUINE.items()}
    cases = [(2, 'schema', v) for v in (True, False, 1.0, '1', None, [], {}, MISSING)]
    cases += [(2, 'contract', v) for v in (True, False, 2.0, '2', None, [], {}, 1, MISSING)]
    cases += [(1, 'contract', v) for v in (True, 1.0, '1', 2)]
    rows = [{'contract': c, 'field': 'unmodified', 'value': 'genuine',
             'previousValidator': verdict(lambda c=c: old.outcome(run[c], c)),
             'currentValidator': verdict(lambda c=c: new.outcome(run[c], c))} for c in (1, 2)]
    for contract, field, bad in cases:
        value = mutate(run[contract], field, bad)
        rows.append({'contract': contract, 'field': field, 'value': '<missing>' if bad is MISSING else repr(bad),
                     'previousValidator': verdict(lambda: old.outcome(copy.deepcopy(value), contract)),
                     'currentValidator': verdict(lambda: new.outcome(copy.deepcopy(value), contract))})
    mutated = rows[2:]
    report = {'schema': 1, 'oldCommit': a.old_commit,
              'oldRunnerSha256': hashlib.sha256(source).hexdigest(),
              'currentRunnerSha256': hashlib.sha256((HARNESS / 'decoded_lease_run.py').read_bytes()).hexdigest(),
              'genuineInputs': {str(c): p.relative_to(ROOT).as_posix() for c, p in GENUINE.items()},
              'rows': rows,
              'previousAccepted': sum(r['previousValidator'].startswith('ACCEPT') for r in mutated),
              'currentAccepted': sum(r['currentValidator'].startswith('ACCEPT') for r in mutated),
              'mutations': len(mutated)}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'rows'}))
    genuine_ok = all(r['currentValidator'] == 'ACCEPT: PASS' for r in rows[:2])
    return 0 if report['currentAccepted'] == 0 and genuine_ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
