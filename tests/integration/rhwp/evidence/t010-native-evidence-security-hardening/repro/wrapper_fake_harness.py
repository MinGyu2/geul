"""Previous vs hardened native D1 wrapper, both unmodified, against one controlled fake harness.

Each run gets a fresh temporary git repository with the wrapper at its real depth, dummy executed dependencies, the
real committed trust-anchor file (pinned bytes) and its own validator: the previous wrapper (--old-commit) gets the
native_d1_result.py of that commit, the hardened wrapper the working copy. The candidate package is a copy of the real
candidate files (--candidate) so the trust anchor applies. A fake tool directory comes first on PATH:
- `node` serves HTTP 200 on 127.0.0.1:1420 (stands in for Vite);
- `dbus-run-session` stands in for the native harness: it starts a short token-carrying child named `geul`, writes the
  scenario's result (or none) to --output and exits with the scenario's code.
Nothing real is launched; no process outside the temporary tree is signaled. Results are synthetic, not runtime observations.
Usage: python3 -I wrapper_fake_harness.py --old-commit SHA --candidate PKG --output OUT.json
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[5]
OLD = 'tests/integration/rhwp/evidence/t010-readiness-residual-stabilization/run-native.py'
NEW = 'tests/integration/rhwp/evidence/t010-native-evidence-security-hardening/run-native.py'
VALIDATOR = 'tests/integration/rhwp/ownership-poc/native_d1_result.py'
sys.path.insert(0, str(ROOT / 'tests/integration/rhwp/ownership-poc'))
import native_d1_result as contract  # noqa: E402
SCENARIOS = [  # (name, harness exit, kind, wrapper extra)
    ('complete-pass', 0, 'pass', None), ('forced-kill', 0, 'forced-kill', None), ('teardown-field-missing', 0, 'no-stop-seconds', None),
    ('driver-exit-unsupported', 0, 'driver-exit-1', None), ('duplicate-json-key', 0, 'duplicate-key', None),
    ('nan-in-json', 0, 'nan', None), ('dependency-file-missing', 0, 'pass', 'remove-tauri-smoke'),
    ('dependency-changed', 0, 'mutate', None), ('expected-wasm-not-anchor', 0, 'pass', 'wrong-expected'),
    ('anchor-bytes-tampered', 0, 'pass', 'tamper-anchor'), ('harness-exit1-json-pass', 1, 'pass', None)]

FAKE_NODE = '''#!{py}
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 1420), H).serve_forever()
'''
FAKE_APP = '''#!{py}
import sys, time
time.sleep(float(sys.argv[1]))
'''
FAKE_HARNESS = '''#!{py}
import json, os, subprocess, sys
from pathlib import Path
kind, code = os.environ['FAKE_KIND'], int(os.environ['FAKE_EXIT'])
out = Path(sys.argv[sys.argv.index('--output') + 1])
subprocess.run([os.environ['FAKE_APP'], '0.6'], check=True)
result = json.loads(os.environ['FAKE_RESULT'])
t = result['teardown'][0]
if kind == 'forced-kill': t.update(driverKilled=True, driverExit=-9)
if kind == 'no-stop-seconds': del t['driverStopSeconds']
if kind == 'driver-exit-1': t['driverExit'] = 1
if kind == 'mutate': Path(os.environ['FAKE_MUTATE']).write_text('changed during the run\\n')
text = json.dumps(result)
if kind == 'duplicate-key': text = text[:-1] + ', "status": "PASS"}}'
if kind == 'nan': text = text.replace('"driverStopSeconds": 0.011', '"driverStopSeconds": NaN')
out.write_text(text)
raise SystemExit(code)
'''


def complete_result(wasm):
    four, frames = list(contract.SAMPLES), contract.FRAMES
    return {'status': 'PASS', 'failures': [], 'tests': [{'name': n, 'status': 'PASS'} for n in contract.required_tests()],
            'visualReferences': [{'name': f'{s}-{f}', 'sample': s, 'frame': f, 'verified': True, 'pixels': 0, 'maxDelta': 0} for s in four for f in frames],
            'selectedSamples': four, 'expectedSamples': four, 'diagnosticContinuation': False, 'historyGates': [], 'historyChecks': [],
            'documents': [{'sample': s} for s in four], 'expectedAssertionCount': 39, 'expectedReferenceCount': 24,
            'verifiedExactReferenceCount': 24, 'measurementComplete': True, 'pixelReferencesComplete': True,
            'cleanup': {'sessionEnded': True, 'driverStopped': True, 'displayTerminated': True}, 'engineIdentity': {'wasmSha256': wasm},
            'teardown': [{'sessionDeletes': [{'outcome': 'ok', 'seconds': 0.009}], 'complete': True, 'driverExit': 0, 'driverKilled': False,
                          'beforeDriverStop': [], 'afterDriverStop': [], 'driverStopSeconds': 0.011, 'remainingAfterWait': [],
                          'sigtermSent': [], 'sigtermErrors': [], 'survivorsAfterSigterm': []}]}


def git(root, *args):
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', *args],
                   check=True, capture_output=True)


def tree(base, wrapper_rel, wrapper_text, validator_text, candidate_source, extra):
    root = base / 'root'
    names = [n for n in contract.DEPENDENCY_MANIFESTS[contract.CURRENT_MANIFEST] if n not in contract.CANDIDATE_FILES and not n.startswith('tree:')]
    for rel in names:
        (root / rel).parent.mkdir(parents=True, exist_ok=True); (root / rel).write_text(f'dummy {rel}\n')
    (root / 'src').mkdir(exist_ok=True); (root / 'src/main.ts').write_text('export {};\n')
    (root / wrapper_rel).parent.mkdir(parents=True, exist_ok=True); (root / wrapper_rel).write_text(wrapper_text)
    (root / VALIDATOR).write_text(validator_text)
    anchor = root / contract.TRUST_ANCHOR['path']; anchor.parent.mkdir(parents=True, exist_ok=True)
    data = (ROOT / contract.TRUST_ANCHOR['path']).read_bytes()
    anchor.write_bytes(data.replace(b'"note"', b'"note "') if extra == 'tamper-anchor' else data)
    git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'fixture')
    if extra == 'remove-tauri-smoke': (root / 'tests/e2e/tauri_smoke.py').unlink()
    package = base / 'candidate'; package.mkdir()
    for name in contract.CANDIDATE_FILES: shutil.copy2(candidate_source / name, package / name)
    tools = base / 'bin'; tools.mkdir()
    for name, text in (('node', FAKE_NODE), ('dbus-run-session', FAKE_HARNESS), ('geul', FAKE_APP)):
        (tools / name).write_text(text.format(py=sys.executable)); (tools / name).chmod(0o755)
    return root, package, tools


def run(label, wrapper_rel, wrapper_text, validator_text, candidate_source, scenario):
    name, code, kind, extra = scenario
    with tempfile.TemporaryDirectory(prefix='geul-wrapper-hardening-') as folder:
        base = Path(folder); root, package, tools = tree(base, wrapper_rel, wrapper_text, validator_text, candidate_source, extra)
        wasm = hashlib.sha256((package / 'rhwp_bg.wasm').read_bytes()).hexdigest()
        expected = '0' * 64 if extra == 'wrong-expected' else wasm
        env = {**os.environ, 'PATH': f'{tools}{os.pathsep}{os.environ["PATH"]}', 'TMPDIR': str(base),
               'GEUL_TAURI_DRIVER': 'fake', 'GEUL_WEBKIT_DRIVER': 'fake', 'GEUL_XVFB': 'fake', 'GEUL_XDOTOOL': 'fake',
               'GEUL_EVIDENCE_SCRATCH': str(base), 'FAKE_KIND': kind, 'FAKE_EXIT': str(code), 'FAKE_APP': str(tools / 'geul'),
               'FAKE_MUTATE': str(root / 'tests/e2e/tauri_smoke.py'), 'FAKE_RESULT': json.dumps(complete_result(wasm))}
        argv = [sys.executable, wrapper_rel, '--attempt', '1', '--candidate', str(package), '--expected-wasm', expected]
        proc = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=120)
        out = (root / wrapper_rel).parent
        row = {'scenario': name, 'harnessExit': code, 'wrapperExit': proc.returncode, 'files': sorted(p.name for p in out.glob('native-d1-attempt1*'))}
        verdict_file = out / 'native-d1-attempt1-wrapper-verdict.json'
        if verdict_file.exists():
            record = json.loads(verdict_file.read_text())
            row.update(verdict=record['verdict']['status'], categories=record['verdict']['categories'], resultError=record['resultError'])
        result_file = out / 'native-d1-attempt1.json'
        if result_file.exists():
            text = result_file.read_text()
            row['harnessFieldsPreserved'] = '"teardown"' in text and '"tests"' in text
        if proc.returncode and not verdict_file.exists():
            row['refusal'] = (proc.stderr.strip().splitlines() or [''])[-1][:200]
        return row


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--old-commit', required=True); a.add_argument('--candidate', type=Path, required=True); a.add_argument('--output', type=Path, required=True)
    args = a.parse_args()
    if args.output.exists(): raise SystemExit('preserve previous output')
    show = lambda path: subprocess.check_output(['git', '-C', str(ROOT), 'show', f'{args.old_commit}:{path}'], text=True)
    old_wrapper, old_validator = show(OLD), show(VALIDATOR)
    new_wrapper, new_validator = (ROOT / NEW).read_text(), (ROOT / VALIDATOR).read_text()
    rows = {'previous': [run('previous', OLD, old_wrapper, old_validator, args.candidate, s) for s in SCENARIOS],
            'hardened': [run('hardened', NEW, new_wrapper, new_validator, args.candidate, s) for s in SCENARIOS]}
    summary = {label: {'exit0': [r['scenario'] for r in table if r['wrapperExit'] == 0]} for label, table in rows.items()}
    report = {'schema': 1, 'kind': 'controlled fake harness (synthetic results, not runtime observations)', 'oldCommit': args.old_commit,
              'previousWrapperSha256': hashlib.sha256(old_wrapper.encode()).hexdigest(), 'hardenedWrapperSha256': hashlib.sha256(new_wrapper.encode()).hexdigest(),
              'previousValidatorSha256': hashlib.sha256(old_validator.encode()).hexdigest(), 'hardenedValidatorSha256': hashlib.sha256(new_validator.encode()).hexdigest(),
              'summary': summary, 'runs': rows}
    report['status'] = 'PASS' if summary['hardened']['exit0'] == ['complete-pass'] and len(summary['previous']['exit0']) > 1 else 'FAIL'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
