#!/usr/bin/env python3
"""cache_contract.rs across the committed historical complete patches, plus production callers of the
BoundedCache pending API (insert_pending/loaded/failed/can_insert_pending/pending_key) in each patch.
Run from the repository root (needs a rustc that links; see REPRODUCE.ko.txt):
  python3 -I tests/integration/rhwp/evidence/t010-decoded-lease-readiness-closure/repro/cache_history_survey.py \
    --rustc RUSTC --output OUT.json
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[6]
EV = ROOT / 'tests/integration/rhwp/evidence'
UNIT = ROOT / 'tests/integration/rhwp/cache-concurrency/unit.py'
PATCHES = ['t010-followup/upstream-rhwp-bounded-image-cache.patch',
           't010-cache-hardening/upstream-rhwp-bounded-image-cache-v2.patch',
           't010-cache-concurrency/upstream-rhwp-no-redundant-notify.patch',
           't010-render-ownership/upstream-rhwp-render-ownership.patch',
           't010-resource-scheduler/upstream-rhwp-resource-scheduler.patch',
           't010-lease-progress/upstream-rhwp-lease-progress.patch',
           't010-final-stabilization/upstream-rhwp-final-stabilization.patch',
           't010-caret-geometry/upstream-rhwp-caret-geometry.patch',
           't010-decoded-admission/upstream-rhwp-decoded-admission.patch',
           't010-decoded-resource-lease-accounting/upstream-rhwp-decoded-lease-complete.patch',
           't010-decoded-lease-accounting-hardening/upstream-rhwp-decoded-lease-hardening-complete.patch',
           't010-decoded-lease-contract-finalization/upstream-rhwp-decoded-lease-finalization-complete.patch']
APIS = ('insert_pending(', '.loaded(', 'can_insert_pending(', '.failed(', 'pending_key(')
FOCUS = ('trim_during_load_does_not_release_the_pending_handle',
         'two_oversize_completions_can_be_available_for_one_full_page_draw')


def callers(text):
    found = {}
    sections = re.split(r'^diff --git a/(\S+) b/\S+\n', text, flags=re.M)
    for name, body in zip(sections[1::2], sections[2::2]):
        if not name.startswith('src/') or name == 'src/renderer/surface_cache.rs':
            continue
        added = [l[1:] for l in body.splitlines() if l.startswith('+') and not l.startswith('+++')]
        for api in APIS:
            n = sum(api in l for l in added)
            if n:
                found.setdefault(name, {})[api] = n
    return found


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--rustc', required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('preserve previous output')
    rows = []
    with tempfile.TemporaryDirectory(prefix='geul-cache-history-') as d:
        for rel in PATCHES:
            patch = EV / rel
            out = Path(d) / 'r.json'
            out.unlink(missing_ok=True)
            subprocess.run([sys.executable, str(UNIT), '--patch', str(patch), '--rustc', a.rustc, '--output', str(out)],
                           capture_output=True, text=True)
            r = json.loads(out.read_text())
            checks = {c['name']: c for c in r['checks']}
            output = checks.get('contracts', {}).get('output', '')
            results = dict(re.findall(r'test (\S+) \.\.\. (\w+)', output))
            summary = re.search(r'test result: \w+\. (\d+) passed; (\d+) failed', output)
            rows.append({'patch': rel, 'patchSha256': hashlib.sha256(patch.read_bytes()).hexdigest(),
                         'surfaceCacheSha256': r['sourceSha256'],
                         'internalTests': checks.get('historical', {}).get('status'),
                         'contracts': {'passed': int(summary[1]), 'failed': int(summary[2])} if summary else
                                      {'compiled': False, 'status': checks.get('contracts', {}).get('status')},
                         'focus': {t: results.get(t) for t in FOCUS},
                         'otherFailures': sorted(t for t, s in results.items() if s != 'ok' and t not in FOCUS),
                         'pendingApiCallersOutsideCache': callers(patch.read_text())})
    report = {'schema': 1, 'contractSha256': hashlib.sha256((UNIT.parent / 'cache_contract.rs').read_bytes()).hexdigest(),
              'compiler': subprocess.check_output([a.rustc, '--version'], text=True).strip(), 'rows': rows}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2) + '\n')
    for row in rows:
        print(row['patch'], row['contracts'], row['focus'], bool(row['pendingApiCallersOutsideCache']))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
