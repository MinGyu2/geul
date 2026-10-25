#!/usr/bin/env python3
"""P2-A before/after: apply the same mutations of a genuine contract-1 result to the previous
validator (decoded_lease_run.py at the given commit) and to the current one.

Run from the repository root:
  python3 -I tests/integration/rhwp/evidence/t010-decoded-lease-accounting-hardening/repro/validator_mutations.py \
    --old-commit 1323ca5403aa201f2ab3a9b809528d165989a454 --output OUT.json
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[6]
HARNESS = ROOT / 'tests/integration/rhwp/cache-concurrency'
RUNNER = 'tests/integration/rhwp/cache-concurrency/decoded_lease_run.py'
GENUINE = ROOT / 'tests/integration/rhwp/evidence/t010-decoded-resource-lease-accounting/browser/decoded-lease-chrome.json'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def point(v, label):
    return next(p for p in v['ledger'] if p['label'] == 'candidate:' + label)


def set_ledger(p, name, number):
    p['decodedLedger'][name] = number
    p['jobs']['decodedLedger'][name] = number


def final_leak(v):
    for name, n in (('uniqueBytes', 4), ('nonresidentBytes', 4), ('uniqueCount', 1), ('nonresidentCount', 1)):
        set_ledger(point(v, 'final'), name, n)


MUTATIONS = {
    'unmodified genuine result': lambda v: None,
    'ledger=[]': lambda v: v.update(ledger=[]),
    'ledger field absent': lambda v: v.pop('ledger'),
    'final checkpoint removed': lambda v: v['ledger'].pop(),
    'required test removed (final-ledger-zero)': lambda v: v['tests'].pop(),
    'required test duplicated': lambda v: v['tests'].append(copy.deepcopy(v['tests'][10])),
    'baseline test attributed to candidate arm': lambda v: v['tests'][0].update(arm='candidate'),
    'candidate-only result (no baseline arm)': lambda v: v.update(tests=[t for t in v['tests'] if t['arm'] == 'candidate']),
    "status 'pass' (lowercase)": lambda v: v['tests'][5].update(status='pass'),
    'status true (boolean)': lambda v: v['tests'][5].update(status=True),
    'budget field maxNonresidentBytes removed': lambda v: point(v, 's2-pending')['decodedLedger'].pop('maxNonresidentBytes'),
    'jobs.maxFrameBytes changed': lambda v: point(v, 's5b-pending')['jobs'].update(maxFrameBytes=128 << 20),
    'unique != resident + nonresident': lambda v: set_ledger(point(v, 's1-evicted'), 'residentBytes', point(v, 's1-evicted')['decodedLedger']['residentBytes'] + 4),
    'uniqueCount != resident + nonresident count': lambda v: set_ledger(point(v, 's1-evicted'), 'nonresidentCount', 9),
    'created - disposed != uniqueCount': lambda v: set_ledger(point(v, 's3-shared'), 'created', point(v, 's3-shared')['decodedLedger']['created'] + 1),
    'final created != disposed': lambda v: set_ledger(point(v, 'final'), 'disposed', point(v, 'final')['decodedLedger']['disposed'] - 1),
    'final leaks one backing (equations hold)': final_leak,
    'final activeJobs=1': lambda v: point(v, 'final')['jobs'].update(activeJobs=1),
    'accountingErrors=false (bool as int)': lambda v: set_ledger(point(v, 's0-after'), 'accountingErrors', False),
    'decodedLedger=null': lambda v: point(v, 's0-after').update(decodedLedger=None),
    'duplicate checkpoint label': lambda v: v['ledger'].insert(5, copy.deepcopy(v['ledger'][5])),
    'checkpoint attributed to baseline arm': lambda v: v['ledger'][2].update(label='baseline:s0-1'),
    'job statistics copy disagrees with ledger': lambda v: point(v, 's3-shared')['jobs']['decodedLedger'].update(uniqueBytes=1),
    'transitions removed': lambda v: v.pop('transitions'),
}


def verdict(fn, value):
    try:
        fn(value)
        return 'ACCEPT'
    except Exception as error:  # noqa: BLE001 - old validator raises arbitrary errors
        return 'REJECT: ' + type(error).__name__ + ': ' + str(error)[:160]


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
        # The old module derives ROOT from parents[3]; give it the same depth (never the repo).
        old_path = Path(d) / 'a/b/c/d/old_decoded_lease_run.py'
        old_path.parent.mkdir(parents=True)
        old_path.write_bytes(source)
        old = load('old_decoded_lease_run', old_path)
    new = load('new_decoded_lease_run', HARNESS / 'decoded_lease_run.py')
    genuine = json.loads(GENUINE.read_text())['run']
    rows = []
    for name, mutate in MUTATIONS.items():
        before, after = copy.deepcopy(genuine), copy.deepcopy(genuine)
        mutate(before), mutate(after)
        rows.append({'mutation': name, 'previousValidator': verdict(old.validate, before),
                     'currentValidatorContract1': verdict(lambda v: new.outcome(v, 1), after)})
    report = {'schema': 1, 'genuineInput': GENUINE.relative_to(ROOT).as_posix(), 'oldCommit': a.old_commit,
              'oldRunnerSha256': __import__('hashlib').sha256(source).hexdigest(),
              'currentRunnerSha256': __import__('hashlib').sha256((HARNESS / 'decoded_lease_run.py').read_bytes()).hexdigest(),
              'rows': rows,
              'previousAcceptedMutations': sum(r['previousValidator'] == 'ACCEPT' for r in rows[1:]),
              'currentAcceptedMutations': sum(r['currentValidatorContract1'] == 'ACCEPT' for r in rows[1:]),
              'genuineAccepted': {'previous': rows[0]['previousValidator'], 'current': rows[0]['currentValidatorContract1']}}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'rows'}))
    return 0 if report['currentAcceptedMutations'] == 0 and rows[0]['currentValidatorContract1'] == 'ACCEPT' else 1


if __name__ == '__main__':
    raise SystemExit(main())
