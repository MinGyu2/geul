#!/usr/bin/env python3
"""Extract the cache from an explicit patch and run its real Rust tests plus desired contracts.

Choose the external contract explicitly: --suite current (cache_current_contract.rs, the supported job-owned lease
contract), --suite historical (cache_contract.rs, the v2-era expectations kept with their two known failures), or
--contract FILE for another contract (decoded_lease_contract.rs, ownership_contract.rs, ...). There is no default, so an
old command cannot silently switch suites. The two suites are reported separately and never combined.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DEFAULT_PATCH = ROOT / 'tests/integration/rhwp/evidence/t010-cache-hardening/upstream-rhwp-bounded-image-cache-v2.patch'
SUITES = {'current': HERE / 'cache_current_contract.rs', 'historical': HERE / 'cache_contract.rs'}


def counts(output):
    """libtest summary counts (passed/failed/ignored) and the failing test names; None when no summary was printed."""
    summary = re.findall(r'^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored', output, re.M)
    if len(summary) != 1: return None
    passed, failed, ignored = map(int, summary[0])
    return {'passed': passed, 'failed': failed, 'ignored': ignored,
            'failedTests': sorted(re.findall(r'^test (\S+) \.\.\. FAILED$', output, re.M))}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--patch', type=Path, default=DEFAULT_PATCH)
    p.add_argument('--rustc', default='rustc')
    p.add_argument('--source', type=Path, help='Explicit isolated surface_cache.rs; overrides patch extraction')
    choice = p.add_mutually_exclusive_group(required=True)
    choice.add_argument('--suite', choices=sorted(SUITES))
    choice.add_argument('--contract', type=Path)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    contract = SUITES[a.suite] if a.suite else a.contract
    if a.source:
        source = a.source.read_text()
    else:
        patch = a.patch.read_text()
        section = patch.split('diff --git a/src/renderer/surface_cache.rs b/src/renderer/surface_cache.rs\n', 1)[1].split('\ndiff --git ', 1)[0]
        source = '\n'.join(line[1:] for line in section.splitlines() if line.startswith('+') and not line.startswith('+++')) + '\n'
    report = {'sourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'contractSha256': hashlib.sha256(contract.read_bytes()).hexdigest(), 'schema': 2, 'patchSha256': None if a.source else hashlib.sha256(a.patch.read_bytes()).hexdigest(),
              'suite': a.suite, 'contract': contract.name,
              'compiler': subprocess.check_output([a.rustc, '--version'], text=True).strip(), 'checks': []}
    with tempfile.TemporaryDirectory(prefix='geul-cache-unit-') as d:
        tmp = Path(d)
        env = {**os.environ, 'TMPDIR': str(tmp)}
        (tmp / 'surface_cache.rs').write_text(source)
        shutil.copy2(contract, tmp / 'cache_contract.rs')
        # 'internal' = the cache source's own #[test]s; 'contracts' = the selected external contract.
        for name, src in [('internal', 'surface_cache.rs'), ('contracts', 'cache_contract.rs')]:
            binary = tmp / name
            build = subprocess.run([a.rustc, '--edition=2021', '--test', str(tmp / src), '-o', str(binary)], text=True, capture_output=True, env=env)
            if build.returncode:
                report['checks'].append({'name': name, 'status': 'FAIL', 'compileExit': build.returncode, 'output': build.stderr.replace(str(tmp), '<temporary>')})
                continue
            run = subprocess.run([str(binary), '--nocapture', '--test-threads=1'], text=True, capture_output=True, env=env)
            output = (run.stdout + run.stderr).replace(str(tmp), '<temporary>')
            report['checks'].append({'name': name, 'status': 'PASS' if run.returncode == 0 else 'FAIL', 'exit': run.returncode, 'counts': counts(output), 'output': output})
    report['status'] = 'PASS' if all(x['status'] == 'PASS' for x in report['checks']) else 'FAIL'
    # The contract binary includes the cache's internal tests (`mod surface_cache;`), so its counts are the suite result
    # (e.g. 21 = 11 internal + 10 external). Adding the 'internal' check would count those 11 twice.
    contracts = [x for x in report['checks'] if x['name'] == 'contracts']
    report['suiteCounts'] = contracts[0].get('counts') if contracts else None
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'checks'}))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
