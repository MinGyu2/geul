#!/usr/bin/env python3
"""Reconstruct the exact tested native suite harnesses in an isolated source export."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = ROOT / 'tests/integration/rhwp/evidence/t010-lease-progress'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    work = args.work.resolve()
    if work.is_relative_to(ROOT) or not (work / 'Cargo.toml').is_file():
        parser.error('--work must be an existing isolated rhwp source outside the project')
    manifest = (EVIDENCE / 'native-suite-manifest.json').read_bytes()
    expected = json.loads((EVIDENCE / 'generated-test-inputs.json').read_text())
    if hashlib.sha256(manifest).hexdigest() != expected['manifestSha256']:
        raise RuntimeError('suite manifest identity mismatch')
    parsed = json.loads(manifest)
    for suite, sources in parsed['suites'].items():
        if not re.fullmatch(r'regression_suite_\d+', suite):
            raise RuntimeError('unsupported suite name')
        for name in sources:
            path = work / name
            if not path.resolve().is_relative_to(work) or path.is_symlink() or not path.is_file():
                raise RuntimeError('missing or unsafe suite source')
    script = """
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [work, manifest] = process.argv.slice(2);
const {renderHarness} = await import(pathToFileURL(work+'/scripts/rust-test-suite-manifest.mjs').href);
const m = JSON.parse(readFileSync(manifest,'utf8'));
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(m.suites).map(([n,s])=>[n+'.rs',renderHarness(n,s)]))));
"""
    result = subprocess.run(['node', '--input-type=module', '-', str(work), str(EVIDENCE / 'native-suite-manifest.json')],
                            input=script, text=True, capture_output=True, check=True)
    files = {work / 'tests/generated' / name: text.encode() for name, text in json.loads(result.stdout).items()}
    files[work / 'tests/suites/manifest.json'] = manifest
    # Existing distinct generated data may belong to another task; preserve it.
    for path, data in files.items():
        if path.is_symlink() or path.parent.is_symlink() or (path.exists() and path.read_bytes() != data):
            raise RuntimeError('refusing to replace different generated inputs')
    for path, data in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(data)
        if path.read_bytes() != data:
            raise RuntimeError('generated write verification failed')
    hashes = {p.name: hashlib.sha256(data).hexdigest() for p, data in files.items() if p.suffix == '.rs'}
    if hashes != expected['harnessSha256']:
        raise RuntimeError('generated harness identity mismatch')
    args.output.write_text(json.dumps({'status': 'PASS', 'manifestSha256': expected['manifestSha256'],
                                     'harnessSha256': hashes, 'sourcesVerified': expected['sourcesVerified'],
                                     'method': 'Pinned tested manifest; no source or Cargo targets changed'}, indent=2) + '\n')
    print('Verified native suite reconstruction:', len(hashes))


if __name__ == '__main__':
    main()
