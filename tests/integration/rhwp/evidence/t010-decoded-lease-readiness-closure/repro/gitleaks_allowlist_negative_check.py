#!/usr/bin/env python3
"""Negative check for the readiness-closure allowlist entry, in a disposable directory.

The genuine allowlisted files must produce no finding; unrelated values in the same exact paths, and the
allowed digests in any other path, must still be detected. Each case runs in three gitleaks modes: `dir`
(evidence mirrors), `git` over a disposable one-commit repository (pre-push/CI) and `git --pre-commit --staged`. Test values are generated at run time and never
written to the repository or the report (gitleaks runs with --redact). Run from the repository root:
  python3 -I .../repro/gitleaks_allowlist_negative_check.py --gitleaks GITLEAKS --config .gitleaks.toml --output OUT.json
"""
import argparse
import json
from pathlib import Path
import secrets
import shutil
import string
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[6]
DIR = 'tests/integration/rhwp/evidence/t010-decoded-lease-readiness-closure/browser'
ALLOWED = [f'{DIR}/{n}.json' for n in ('decoded-lease-chrome', 'decoded-lease-webkit', 'regression-chrome', 'regression-webkit')]
DIGESTS = ('9563a9ef26b5d0c22997e9beb8cb8c037e852df7ca95a8362800e7bd0cf24c5d',
           '3dfa6723ae9c89768157f26aac22566d18055c9074acfaa28b0686c3687ecacb')


GIT = ['git', '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', '-c', 'commit.gpgsign=false']


def scan(gitleaks, config, folder, mode):
    report = folder.parent / (folder.name + '-' + mode + '.json')
    common = ['--redact', '--no-banner', '-c', str(config), '--report-format', 'json', '--report-path', str(report)]
    if mode == 'dir':
        command = [gitleaks, 'dir', *common, '.']
    else:
        subprocess.run(GIT + ['init', '-q', '.'], cwd=folder, check=True)
        if mode == 'staged':
            (folder / '.probe-base').write_text('base\n')
            subprocess.run(GIT + ['add', '.probe-base'], cwd=folder, check=True)
            subprocess.run(GIT + ['commit', '-qm', 'base'], cwd=folder, check=True)
        subprocess.run(GIT + ['add', '-A'], cwd=folder, check=True)
        if mode == 'git':
            subprocess.run(GIT + ['commit', '-qm', 'probe'], cwd=folder, check=True)
            command = [gitleaks, 'git', *common, '.']
        else:
            command = [gitleaks, 'git', '--pre-commit', '--staged', *common, '.']
    subprocess.run(command, cwd=folder, capture_output=True, text=True)
    return [{'rule': f['RuleID'], 'file': f['File'], 'line': f['StartLine']} for f in json.loads(report.read_text())]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--gitleaks', required=True)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        p.error('preserve previous output')
    version = subprocess.run([a.gitleaks, 'version'], capture_output=True, text=True).stdout.strip()
    hexdigest = secrets.token_hex(32)
    aws = 'AKIA' + ''.join(secrets.choice(string.ascii_uppercase + '234567') for _ in range(16))
    github = 'ghp_' + ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
    cases = []
    with tempfile.TemporaryDirectory(prefix='geul-allowlist-check-') as d:
        base = Path(d)

        def case(name, files, expect_findings):
            for mode in ('dir', 'git', 'staged'):
                folder = base / f'{name}-{mode}'
                for rel, text in files.items():
                    (folder / rel).parent.mkdir(parents=True, exist_ok=True)
                    (folder / rel).write_text(text)
                found = scan(a.gitleaks, a.config.resolve(), folder, mode)
                cases.append({'case': name, 'mode': mode, 'files': sorted(files), 'expectFindings': expect_findings,
                              'findings': found, 'ok': bool(found) == expect_findings})

        case('genuine-allowlisted-files', {rel: (ROOT / rel).read_text() for rel in ALLOWED}, False)
        target = ALLOWED[0]
        case('other-sha256-in-allowed-path', {target: json.dumps({'src/wasm_api.rs': hexdigest}, indent=2)}, True)
        case('aws-key-in-allowed-path', {target: json.dumps({'access_key_id': aws}, indent=2)}, True)
        case('github-token-in-allowed-path', {target: json.dumps({'token': github}, indent=2)}, True)
        for digest in DIGESTS:
            case(f'allowed-digest-{digest[:6]}-in-other-file', {f'{DIR}/other.json': json.dumps({'src/wasm_api.rs': digest}, indent=2)}, True)
            case(f'allowed-digest-{digest[:6]}-in-other-directory',
                 {f'tests/integration/rhwp/evidence/t010-other/browser/decoded-lease-chrome.json':
                  json.dumps({'src/wasm_api.rs': digest}, indent=2)}, True)
    report = {'schema': 1, 'gitleaks': version, 'config': a.config.as_posix(), 'cases': cases,
              'allOk': all(c['ok'] for c in cases)}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=1) + '\n')
    print(json.dumps({'allOk': report['allOk'], 'cases': [(c['case'], c['mode'], len(c['findings']), c['ok']) for c in cases]}))
    return 0 if report['allOk'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
