#!/usr/bin/env python3
"""Contract-3 before/after: the same dimensionMismatches mutations of genuine browser evidence, validated by
decoded_lease_run.py at --old-commit (current contract 2) and by the current file. Run from the repository root:
  python3 -I tests/integration/rhwp/evidence/t010-decoded-lease-readiness-closure/repro/dimension_contract_before_after.py \
    --old-commit 45c91501524494602c13c7c2a429814395430bdc --output OUT.json
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
GENUINE = {
    'contract1': EVIDENCE / 't010-decoded-resource-lease-accounting/browser/decoded-lease-chrome.json',
    'contract2-hardening': EVIDENCE / 't010-decoded-lease-accounting-hardening/browser/decoded-lease-chrome.json',
    'contract2-finalization': EVIDENCE / 't010-decoded-lease-contract-finalization/browser/decoded-lease-chrome.json',
    'contract3-chrome': EVIDENCE / 't010-decoded-lease-readiness-closure/browser/decoded-lease-chrome.json',
    'contract3-webkit': EVIDENCE / 't010-decoded-lease-readiness-closure/browser/decoded-lease-webkit.json',
}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verdict(fn):
    try:
        return 'ACCEPT: ' + str(fn())
    except Exception as error:  # noqa: BLE001 - the old validator may raise anything
        return 'REJECT: ' + type(error).__name__ + ': ' + str(error)[:120]


def strip(value, labels=None, ledger=True, jobs=True):
    value = copy.deepcopy(value)
    for p in value['ledger']:
        if labels is None or p['label'].removeprefix('candidate:') in labels:
            if ledger:
                p['decodedLedger'].pop('dimensionMismatches', None)
            if jobs:
                p['jobs']['decodedLedger'].pop('dimensionMismatches', None)
    value['transitions'][1]['cleanup']['jobs'] = value['ledger'][-1]['jobs']
    return value


def set_copy(value, label, name, number):
    value = copy.deepcopy(value)
    p = next(p for p in value['ledger'] if p['label'] == 'candidate:' + label)
    p['jobs']['decodedLedger'][name] = number
    return value


def set_both(value, label, name, number):
    value = copy.deepcopy(value)
    p = next(p for p in value['ledger'] if p['label'] == 'candidate:' + label)
    p['decodedLedger'][name] = number
    p['jobs']['decodedLedger'][name] = number
    value['transitions'][1]['cleanup']['jobs'] = value['ledger'][-1]['jobs']
    return value


def as_contract(value, number):
    value = copy.deepcopy(value)
    value['contract'] = number
    return value


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
    run = {k: json.loads(path.read_text())['run'] for k, path in GENUINE.items()}
    c3 = run['contract3-chrome']
    # The previous producer emitted contract 2, so the old validator sees each new-producer mutation with a
    # contract-2 claim; the current validator sees it as emitted (contract 3). The current runner always
    # validates as its own CURRENT_CONTRACT (3) whatever the result claims.
    s3 = next(p for p in c3['ledger'] if p['label'] == 'candidate:s3-shared')['decodedLedger']['uniqueBytes']
    historical = [
        ('genuine contract-1 (historical)', run['contract1'], 1, run['contract1'], 1),
        ('genuine contract-2 hardening (historical, no field)', run['contract2-hardening'], 2, run['contract2-hardening'], 2),
        ('genuine contract-2 finalization (historical, field present)', run['contract2-finalization'], 2, run['contract2-finalization'], 2),
        ('genuine contract-3 chrome', as_contract(c3, 2), 2, c3, 3),
        ('genuine contract-3 webkit', as_contract(run['contract3-webkit'], 2), 2, run['contract3-webkit'], 3),
        ('contract-1 evidence verified as contract 3', run['contract1'], 2, run['contract1'], 3),
        ('contract-2 hardening evidence verified as contract 3', run['contract2-hardening'], 2, run['contract2-hardening'], 3),
        ('contract-2 finalization evidence verified as contract 3', run['contract2-finalization'], 2, run['contract2-finalization'], 3),
        ('new result relabelled contract 2 (downgrade claim)', as_contract(c3, 2), 2, as_contract(c3, 2), 3),
    ]
    mutations = [
        ('field removed everywhere', strip(c3)),
        ('field removed in one checkpoint (s9-after)', strip(c3, {'s9-after'})),
        ('field removed in final only', strip(c3, {'final'})),
        ('field removed only from jobs.decodedLedger (s9-after)', strip(c3, {'s9-after'}, ledger=False)),
        ('copy dimensionMismatches False (s9-after)', set_copy(c3, 's9-after', 'dimensionMismatches', False)),
        ('copy dimensionMismatches 0.0 (s9-after)', set_copy(c3, 's9-after', 'dimensionMismatches', 0.0)),
        ('copy uniqueBytes as float (s3-shared)', set_copy(c3, 's3-shared', 'uniqueBytes', float(s3))),
        ('dimensionMismatches 1 in both copies (s9-after)', set_both(c3, 's9-after', 'dimensionMismatches', 1)),
        ('dimensionMismatches -1 in both copies (final)', set_both(c3, 'final', 'dimensionMismatches', -1)),
        ('dimensionMismatches null in both copies (s1-pending)', set_both(c3, 's1-pending', 'dimensionMismatches', None)),
        ('dimensionMismatches true in both copies (s1-pending)', set_both(c3, 's1-pending', 'dimensionMismatches', True)),
        ('dimensionMismatches 0.0 in both copies (s1-pending)', set_both(c3, 's1-pending', 'dimensionMismatches', 0.0)),
        ('dimensionMismatches "0" in both copies (s1-pending)', set_both(c3, 's1-pending', 'dimensionMismatches', '0')),
    ]
    cases = historical + [('new result: ' + name, as_contract(v, 2), 2, v, 3) for name, v in mutations]
    rows = [{'case': name, 'previousValidatorContract': before, 'currentValidatorContract': after,
             'previousValidator': verdict(lambda v=old_value, c=before: old.outcome(copy.deepcopy(v), c)),
             'currentValidator': verdict(lambda v=new_value, c=after: new.outcome(copy.deepcopy(v), c))}
            for name, old_value, before, new_value, after in cases]
    genuine_rows = rows[:5]
    mutated = rows[5:]
    report = {'schema': 1, 'oldCommit': a.old_commit,
              'oldRunnerSha256': hashlib.sha256(source).hexdigest(),
              'currentRunnerSha256': hashlib.sha256((HARNESS / 'decoded_lease_run.py').read_bytes()).hexdigest(),
              'genuineInputs': {k: p.relative_to(ROOT).as_posix() for k, p in GENUINE.items()},
              'rows': rows,
              'previousAcceptedInvalid': sum(r['previousValidator'].startswith('ACCEPT') for r in mutated),
              'currentAcceptedInvalid': sum(r['currentValidator'].startswith('ACCEPT') for r in mutated),
              'invalidCases': len(mutated),
              'genuineAcceptedByCurrent': sum(r['currentValidator'] == 'ACCEPT: PASS' for r in genuine_rows)}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'rows'}))
    return 0 if report['currentAcceptedInvalid'] == 0 and report['genuineAcceptedByCurrent'] == len(genuine_rows) else 1


if __name__ == '__main__':
    raise SystemExit(main())
