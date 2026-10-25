"""Run the previous and the corrected native D1 wrapper, unmodified, against one controlled fake harness.

Each run gets a fresh temporary tree with the wrapper at its real depth, dummy executed dependencies, a dummy candidate
package and a fake tool directory first on PATH:
- `node` serves HTTP 200 on 127.0.0.1:1420 (stands in for Vite);
- `dbus-run-session` stands in for the native harness: it starts a short token-carrying child named `geul` (so the
  lifecycle observer sees an owned application that exits), writes the scenario's result (or none) to --output and
  exits with the scenario's code.
Nothing real is launched and no process outside the temporary tree is signaled. The tested wrappers are copied
verbatim: the previous one from git (--old-commit), the corrected one from this directory.
Usage: python3 -I native_wrapper_before_after.py --old-commit SHA --output OUT.json
"""
import argparse, hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[5]
OLD = 'tests/integration/rhwp/evidence/t010-decoded-lease-readiness-closure/run-native.py'
NEW = 'tests/integration/rhwp/evidence/t010-readiness-residual-stabilization/run-native.py'
VALIDATOR = 'tests/integration/rhwp/ownership-poc/native_d1_result.py'
P = 'tests/integration/rhwp/ownership-poc/'
DEPENDENCIES = [P + n for n in ('session.mjs', 'vite.config.mjs', 'native.py', 'generate.mjs', 'performance-visual-native.py')] + [
    'tests/integration/rhwp/undo_native.py', 'tests/integration/rhwp/native_probe.py', 'tests/integration/rhwp/rhwp_poc.py',
    'tests/e2e/tauri_smoke.py', 'tests/fixtures/rhwp/generate.mjs', 'src-tauri/target/debug/geul'] + [
    'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/' + n
    for n in ('engine-safety-gates.json', 'chrome.json', 'webkit.json')]
SCENARIOS = [  # (name, harness exit, result kind)
    ('exit0-complete-pass', 0, 'pass'), ('exit0-json-fail', 0, 'fail'), ('exit0-missing-json', 0, 'missing'),
    ('exit0-malformed-json', 0, 'malformed'), ('exit0-cleanup-false', 0, 'cleanup-false'),
    ('exit0-cleanup-field-missing', 0, 'cleanup-missing'), ('exit0-incomplete-assertions', 0, 'assertions-short'),
    ('exit0-incomplete-rgba', 0, 'rgba-short'), ('exit0-identity-mismatch', 0, 'identity'),
    ('exit0-dependency-mutation', 0, 'mutate'), ('exit1-json-pass', 1, 'pass')]

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
if kind == 'fail': result.update(status='FAIL', failures=['failed assertions: basic-ko.hwp-warm-full-reference-exact'])
if kind == 'cleanup-false': result['cleanup']['driverStopped'] = False
if kind == 'cleanup-missing': del result['cleanup']['displayTerminated']
if kind == 'assertions-short': result['tests'].pop(); result['expectedAssertionCount'] = 38
if kind == 'rgba-short': result['visualReferences'].pop(); result['verifiedExactReferenceCount'] = 23
if kind == 'identity': result['engineIdentity']['wasmSha256'] = '0' * 64
if kind == 'mutate': Path(os.environ['FAKE_MUTATE']).write_text('changed during the run\\n')
if kind == 'malformed': out.write_text('{{"status": "PASS", "tests": [')
elif kind != 'missing': out.write_text(json.dumps(result))
raise SystemExit(code)
'''


def complete_result(wasm):
    sys.path.insert(0, str(ROOT / P))
    import native_d1_result as contract
    four, frames = list(contract.SAMPLES), contract.FRAMES
    return {'status': 'PASS', 'failures': [], 'tests': [{'name': n, 'status': 'PASS'} for n in contract.required_tests()],
            'visualReferences': [{'name': f'{s}-{f}', 'sample': s, 'frame': f, 'verified': True, 'pixels': 0, 'maxDelta': 0} for s in four for f in frames],
            'selectedSamples': four, 'expectedSamples': four, 'diagnosticContinuation': False, 'historyGates': [], 'historyChecks': [],
            'documents': [{'sample': s} for s in four], 'expectedAssertionCount': 39, 'expectedReferenceCount': 24,
            'verifiedExactReferenceCount': 24, 'measurementComplete': True, 'pixelReferencesComplete': True,
            'cleanup': {'sessionEnded': True, 'driverStopped': True, 'displayTerminated': True}, 'engineIdentity': {'wasmSha256': wasm},
            'teardown': [{'sessionDeletes': [{'outcome': 'ok', 'seconds': 0.1}], 'complete': True, 'driverExit': 0, 'driverKilled': False,
                          'beforeDriverStop': [], 'afterDriverStop': [], 'remainingAfterWait': [], 'sigtermSent': [], 'sigtermErrors': [],
                          'survivorsAfterSigterm': []}]}


def tree(base, wrapper_rel, wrapper_text, validator_text):
    root = base / 'root'
    for rel in DEPENDENCIES:
        (root / rel).parent.mkdir(parents=True, exist_ok=True); (root / rel).write_text(f'dummy {rel}\n')
    (root / wrapper_rel).parent.mkdir(parents=True, exist_ok=True); (root / wrapper_rel).write_text(wrapper_text)
    (root / VALIDATOR).write_text(validator_text)
    package = base / 'candidate'; package.mkdir()
    for name in ('rhwp.js', 'rhwp_bg.wasm', 'ENGINE.json'): (package / name).write_bytes(b'fake ' + name.encode())
    tools = base / 'bin'; tools.mkdir()
    for name, text in (('node', FAKE_NODE), ('dbus-run-session', FAKE_HARNESS), ('geul', FAKE_APP)):
        (tools / name).write_text(text.format(py=sys.executable)); (tools / name).chmod(0o755)
    return root, package, tools


def run(label, wrapper_rel, wrapper_text, validator_text, scenario):
    name, code, kind = scenario
    with tempfile.TemporaryDirectory(prefix='geul-wrapper-repro-') as folder:
        base = Path(folder); root, package, tools = tree(base, wrapper_rel, wrapper_text, validator_text)
        wasm = hashlib.sha256((package / 'rhwp_bg.wasm').read_bytes()).hexdigest()
        env = {**os.environ, 'PATH': f'{tools}{os.pathsep}{os.environ["PATH"]}', 'TMPDIR': str(base),
               'GEUL_TAURI_DRIVER': 'fake', 'GEUL_WEBKIT_DRIVER': 'fake', 'GEUL_XVFB': 'fake', 'GEUL_XDOTOOL': 'fake',
               'GEUL_EVIDENCE_SCRATCH': str(base), 'FAKE_KIND': kind, 'FAKE_EXIT': str(code), 'FAKE_APP': str(tools / 'geul'),
               'FAKE_MUTATE': str(root / 'tests/e2e/tauri_smoke.py'), 'FAKE_RESULT': json.dumps(complete_result(wasm))}
        argv = ([sys.executable, wrapper_rel, '1', str(package), wasm] if label == 'previous'
                else [sys.executable, wrapper_rel, '--attempt', '1', '--candidate', str(package), '--expected-wasm', wasm])
        proc = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True, timeout=120)
        out = (root / wrapper_rel).parent
        row = {'scenario': name, 'harnessExit': code, 'wrapperExit': proc.returncode,
               'files': sorted(p.name for p in out.glob('native-d1-attempt1*'))}
        verdict_file = out / 'native-d1-attempt1-wrapper-verdict.json'
        if verdict_file.exists():
            record = json.loads(verdict_file.read_text())
            row.update(verdict=record['verdict']['status'], categories=record['verdict']['categories'], resultError=record['resultError'])
        result_file = out / 'native-d1-attempt1.json'
        try:
            row['resultStatus'] = json.loads(result_file.read_text()).get('status') if result_file.exists() else None
        except ValueError:
            row['resultStatus'] = 'unparseable (left as written by the harness)'
        if proc.returncode not in (0,) and label == 'previous':
            row['stderrTail'] = proc.stderr.strip().splitlines()[-1][:200] if proc.stderr.strip() else ''
        return row


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--old-commit', required=True); a.add_argument('--output', type=Path, required=True)
    args = a.parse_args()
    if args.output.exists(): raise SystemExit('preserve previous output')
    old = subprocess.check_output(['git', '-C', str(ROOT), 'show', f'{args.old_commit}:{OLD}'], text=True)
    validator = (ROOT / VALIDATOR).read_text()
    rows = {'previous': [run('previous', OLD, old, validator, s) for s in SCENARIOS],
            'corrected': [run('corrected', NEW, (ROOT / NEW).read_text(), validator, s) for s in SCENARIOS]}
    expected_pass = {'exit0-complete-pass'}
    summary = {label: {'exit0': [r['scenario'] for r in table if r['wrapperExit'] == 0],
                       'failOpen': [r['scenario'] for r in table if r['wrapperExit'] == 0 and r['scenario'] not in expected_pass]}
               for label, table in rows.items()}
    report = {'schema': 1, 'oldCommit': args.old_commit, 'previousWrapper': OLD, 'correctedWrapper': NEW,
              'previousWrapperSha256': hashlib.sha256(old.encode()).hexdigest(),
              'correctedWrapperSha256': hashlib.sha256((ROOT / NEW).read_bytes()).hexdigest(),
              'validatorSha256': hashlib.sha256(validator.encode()).hexdigest(),
              'method': 'both wrappers copied verbatim into a temporary tree; fake node/dbus-run-session/geul on PATH; no real native run',
              'summary': summary, 'runs': rows,
              'status': 'PASS' if summary['corrected']['exit0'] == ['exit0-complete-pass'] and summary['previous']['failOpen'] else 'FAIL'}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
