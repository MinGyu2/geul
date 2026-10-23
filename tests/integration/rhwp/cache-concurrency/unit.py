#!/usr/bin/env python3
"""Extract the cache from an explicit patch and run its real Rust tests plus desired contracts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
DEFAULT_PATCH = ROOT / 'tests/integration/rhwp/evidence/t010-cache-hardening/upstream-rhwp-bounded-image-cache-v2.patch'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--patch', type=Path, default=DEFAULT_PATCH)
    p.add_argument('--rustc', default='rustc')
    p.add_argument('--source', type=Path, help='Explicit isolated surface_cache.rs; overrides patch extraction')
    p.add_argument('--contract', type=Path, default=HERE / 'cache_contract.rs')
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.source:
        source = a.source.read_text()
    else:
        patch = a.patch.read_text()
        section = patch.split('diff --git a/src/renderer/surface_cache.rs b/src/renderer/surface_cache.rs\n', 1)[1].split('\ndiff --git ', 1)[0]
        source = '\n'.join(line[1:] for line in section.splitlines() if line.startswith('+') and not line.startswith('+++')) + '\n'
    report = {'sourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'contractSha256': hashlib.sha256(a.contract.read_bytes()).hexdigest(), 'schema': 1, 'patchSha256': None if a.source else hashlib.sha256(a.patch.read_bytes()).hexdigest(),
              'compiler': subprocess.check_output([a.rustc, '--version'], text=True).strip(), 'checks': []}
    with tempfile.TemporaryDirectory(prefix='geul-cache-unit-') as d:
        tmp = Path(d)
        env = {**os.environ, 'TMPDIR': str(tmp)}
        (tmp / 'surface_cache.rs').write_text(source)
        shutil.copy2(a.contract, tmp / 'cache_contract.rs')
        for name, src in [('historical', 'surface_cache.rs'), ('contracts', 'cache_contract.rs')]:
            binary = tmp / name
            build = subprocess.run([a.rustc, '--edition=2021', '--test', str(tmp / src), '-o', str(binary)], text=True, capture_output=True, env=env)
            if build.returncode:
                report['checks'].append({'name': name, 'status': 'FAIL', 'compileExit': build.returncode, 'output': build.stderr.replace(str(tmp), '<temporary>')})
                continue
            run = subprocess.run([str(binary), '--nocapture', '--test-threads=1'], text=True, capture_output=True, env=env)
            output = (run.stdout + run.stderr).replace(str(tmp), '<temporary>')
            report['checks'].append({'name': name, 'status': 'PASS' if run.returncode == 0 else 'FAIL', 'exit': run.returncode, 'output': output})
    report['status'] = 'PASS' if all(x['status'] == 'PASS' for x in report['checks']) else 'FAIL'
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'checks'}))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
