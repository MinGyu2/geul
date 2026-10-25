"""Protected-path and gitlink check for this task: every path changed since --base must lie outside the protected set.

Mode --worktree compares the base with the working tree (tracked changes + untracked files, as git status sees them);
mode --head compares the base with HEAD (use after the commit). Reads git only; changes nothing.
Usage: python3 -I protected_paths.py --base SHA (--worktree | --head) --output OUT.json
"""
import argparse, json, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
NEW_EVIDENCE = 'tests/integration/rhwp/evidence/t010-native-evidence-final-integrity/'
PROTECTED = [  # (prefix or exact path, reason)
    ('src/', 'production Geul frontend source'), ('src-tauri/src/', 'production Tauri source'),
    ('src-tauri/Cargo.toml', 'production crate manifest'), ('src-tauri/tauri.conf.json', 'production app config'),
    ('public/', 'public production WASM and assets'), ('external/', 'pinned RHWP / WordCraft submodules'),
    ('.gitleaks.toml', 'no allowlist change in this task'), ('.sensitive-info-allowlist', 'no allowlist change in this task'),
    ('tests/integration/rhwp/evidence/', 'previous T010 evidence (only the new directory may change)'),
    ('tests/e2e/tauri_smoke.py', 'shared with official D4 tooling; unchanged in this task'),
    ('tests/integration/rhwp/cache-concurrency/', 'cache contracts unchanged in this task'),
]
GITLINKS = {'external/rhwp': '1a76570e833917d15817415a53c09ad61ab3203f', 'external/wordcraft': 'fc41918814f62645b6746ed68e71e8c2c2e85d6f'}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True)


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--base', required=True); a.add_argument('--output', type=Path, required=True)
    mode = a.add_mutually_exclusive_group(required=True); mode.add_argument('--worktree', action='store_true'); mode.add_argument('--head', action='store_true')
    args = a.parse_args()
    if args.head:
        changed = git('diff', '--name-only', args.base, 'HEAD').split()
        tree = 'HEAD'
    else:
        changed = sorted(set(git('diff', '--name-only', args.base).split()) | set(git('ls-files', '--others', '--exclude-standard').split()))
        tree = None
    violations = []
    for path in changed:
        if path.startswith(NEW_EVIDENCE): continue
        for prefix, reason in PROTECTED:
            if path == prefix or (prefix.endswith('/') and path.startswith(prefix)):
                violations.append({'path': path, 'reason': reason})
    links = {}
    for path, expected in GITLINKS.items():
        recorded = git('ls-tree', tree or 'HEAD', path).split()
        index = git('ls-files', '-s', path).split()
        links[path] = {'expected': expected, 'tree': recorded[2] if len(recorded) > 2 else None, 'index': index[1] if len(index) > 1 else None,
                       'checkout': git('-C', path, 'rev-parse', 'HEAD').strip() if (ROOT / path / '.git').exists() else None}
    links_ok = all(v['tree'] == v['expected'] and v['index'] == v['expected'] and v['checkout'] in (None, v['expected']) for v in links.values())
    report = {'schema': 1, 'base': args.base, 'mode': 'head' if args.head else 'worktree', 'head': git('rev-parse', 'HEAD').strip(),
              'changed': changed, 'protected': [p for p, _ in PROTECTED], 'allowedEvidenceDirectory': NEW_EVIDENCE,
              'violations': violations, 'gitlinks': links, 'gitlinksUnchanged': links_ok,
              'status': 'PASS' if not violations and links_ok else 'FAIL'}
    args.output.write_text(json.dumps(report, indent=1) + '\n')
    print(report['status'], len(changed), 'changed', len(violations), 'violations', 'gitlinks', links_ok)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
