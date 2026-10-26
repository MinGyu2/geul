"""최종 커밋 후 실제 HEAD의 전체 이력 검사와 보호 경계/후보 신원을 외부 새 폴더에 보존한다."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
from identity import sha, snapshot

ROOT = Path(__file__).resolve().parents[4]
EVIDENCE = 'tests/integration/rhwp/evidence/t010-rust-199-clippy-compatibility/'
ALLOWED = (EVIDENCE, 'tests/integration/rhwp/rust-199-clippy-compatibility/')
PINS = {'external/rhwp': '1a76570e833917d15817415a53c09ad61ab3203f',
        'external/wordcraft': 'fc41918814f62645b6746ed68e71e8c2c2e85d6f'}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', required=True)
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--gitleaks', type=Path, required=True)
    p.add_argument('--output-dir', type=Path, required=True)
    a = p.parse_args()
    out = a.output_dir.resolve()
    if out.exists() or out.is_relative_to(ROOT):
        p.error('증거 보존: 저장소 외부의 새 출력 폴더 필요')
    out.mkdir(parents=True)
    head = git('rev-parse', 'HEAD').strip()
    commands = {
        'sensitive-history': [sys.executable, 'scripts/check-sensitive-info.py', '--history'],
        'gitleaks-history': [str(a.gitleaks.resolve()), 'git', '--redact', '--no-banner', '--config', '.gitleaks.toml',
                             '--report-format', 'json', '--report-path', str(out / 'gitleaks-findings.json')],
    }
    def run(item):
        name, command = item
        with (out / (name + '.log')).open('w') as log:
            process = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        return name, {'command': command, 'exit': process.returncode, 'logSha256': sha(out / (name + '.log'))}
    with ThreadPoolExecutor(max_workers=2) as pool:
        checks = dict(pool.map(run, commands.items()))
    report = {'schema': 1, '분류': '최종 로컬 커밋 후 실제 HEAD 검사; native 승인 아님',
              'startingHead': a.base, 'endingHead': head, 'historyChecks': checks, 'status': 'FAIL'}
    try:
        changed = git('diff', '--name-only', a.base, head).splitlines()
        report['protectedViolations'] = [n for n in changed if not n.startswith(ALLOWED)]
        report['changedPaths'] = len(changed)
        report['gitlinks'] = {}
        for path, pin in PINS.items():
            report['gitlinks'][path] = {'expected': pin, 'tree': git('ls-tree', head, path).split()[2],
                'index': git('ls-files', '-s', path).split()[1], 'checkout': git('-C', path, 'rev-parse', 'HEAD').strip(),
                'status': git('-C', path, 'status', '--porcelain').strip()}
        identity = json.loads(git('show', head + ':' + EVIDENCE + 'candidate-identity.json'))
        report['candidateArtifacts'] = {name: sha(a.candidate / name) for name in identity['artifacts']}
        report['sourceTreeSha256'] = snapshot(a.source)[1]
        report['patches'] = {}
        for name, expected in identity['patches'].items():
            blob = subprocess.check_output(['git', '-C', str(ROOT), 'show', head + ':' + EVIDENCE + name])
            import hashlib
            observed = hashlib.sha256(blob).hexdigest()
            report['patches'][name] = {'observed': observed, 'expected': expected}
        report['workingTreeClean'] = not git('status', '--porcelain').strip()
        report['headStable'] = git('rev-parse', 'HEAD').strip() == head
        findings = json.loads((out / 'gitleaks-findings.json').read_text())
        ok = all(r['exit'] == 0 for r in checks.values()) and findings == [] and not report['protectedViolations']
        ok = ok and all(r['tree'] == r['index'] == r['checkout'] == r['expected'] and not r['status'] for r in report['gitlinks'].values())
        ok = ok and report['candidateArtifacts'] == identity['artifacts'] and report['sourceTreeSha256'] == identity['sourceTreeSha256']
        ok = ok and all(r['observed'] == r['expected'] for r in report['patches'].values())
        ok = ok and report['workingTreeClean'] and report['headStable']
        report['status'] = 'PASS' if ok else 'FAIL'
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
    (out / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(report['status'], head)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
