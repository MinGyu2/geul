"""Synthetic mutations of genuine accepted native D1 evidence, judged by the previous and the hardened validator.

Base: ../t010-readiness-residual-stabilization/native-d1-attempt1.json + -lifecycle.json (a real run that both validators
accept). Each case changes exactly one thing. The previous validator is native_d1_result.py from --old-commit (git show);
the hardened one is the working copy. These are artificial inputs: they show which malformed evidence each validator
accepts; they are not observed native runtime failures. The genuine record is a manifest-v1 record, so the hardened
validator judges it with manifest_version=1 and the committed trust anchor.
Usage: python3 -I validator_before_after.py --old-commit SHA --output OUT.json
"""
import argparse, copy, hashlib, importlib.util, json, math, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[6]
VALIDATOR = 'tests/integration/rhwp/ownership-poc/native_d1_result.py'
BASE = ROOT / 'tests/integration/rhwp/evidence/t010-readiness-residual-stabilization'
WASM = 'ca5c0b8443230ba719c07f4d8c835a94fb6e12eb4b50a7123ce5c8b6a8048d45'
OTHER = 'f' * 64


def load(name, text):
    folder = Path(tempfile.mkdtemp(prefix='geul-validator-'))
    path = folder / (name + '.py'); path.write_text(text)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def td(change):
    return lambda r, d, a, x: change(r['teardown'][0])


CASES = [  # (name, area, mutate(result, deps_before, deps_after, extra) )
    ('genuine-unchanged', 'baseline', lambda r, d, a, x: None),
    ('forced-kill-sigkill', 'A', td(lambda t: t.update(driverKilled=True, driverExit=-9))),
    ('forced-kill-exit0', 'A', td(lambda t: t.update(driverKilled=True, driverExit=0))),
    ('sigkill-without-kill-record', 'A', td(lambda t: t.update(driverExit=-9))),
    ('unsupported-positive-exit', 'A', td(lambda t: t.update(driverExit=1))),
    ('driverKilled-missing', 'A/B', td(lambda t: t.pop('driverKilled'))),
    ('driverKilled-None', 'A', td(lambda t: t.update(driverKilled=None))),
    ('driverKilled-0', 'A', td(lambda t: t.update(driverKilled=0))),
    ('driverKilled-string', 'A', td(lambda t: t.update(driverKilled='false'))),
    ('driverExit-missing', 'A', td(lambda t: t.pop('driverExit'))),
    ('driverExit-True', 'A', td(lambda t: t.update(driverExit=True))),
    ('driverExit-float', 'A', td(lambda t: t.update(driverExit=0.0))),
    ('beforeDriverStop-missing', 'B', td(lambda t: t.pop('beforeDriverStop'))),
    ('afterDriverStop-missing', 'B', td(lambda t: t.pop('afterDriverStop'))),
    ('driverStopSeconds-missing', 'B', td(lambda t: t.pop('driverStopSeconds'))),
    ('driverStopSeconds-NaN', 'B', td(lambda t: t.update(driverStopSeconds=math.nan))),
    ('driverStopSeconds-inf', 'B', td(lambda t: t.update(driverStopSeconds=math.inf))),
    ('driverStopSeconds-negative', 'B', td(lambda t: t.update(driverStopSeconds=-0.01))),
    ('driverStopSeconds-string', 'B', td(lambda t: t.update(driverStopSeconds='0.01'))),
    ('driverStopSeconds-bool', 'B', td(lambda t: t.update(driverStopSeconds=True))),
    ('delete-seconds-missing', 'B', td(lambda t: t['sessionDeletes'][0].pop('seconds'))),
    ('process-row-malformed', 'B', td(lambda t: t['afterDriverStop'].append({'pid': '7', 'comm': 'geul'}))),
    ('process-row-pid-bool', 'B', td(lambda t: t['beforeDriverStop'].append({'pid': True, 'gone': True}))),
    ('unsupported-teardown-field', 'B', td(lambda t: t.update(extra=1))),
    ('only-wasm-dependency', 'C', lambda r, d, a, x: x.update(deps=({'rhwp_bg.wasm': WASM}, {'rhwp_bg.wasm': WASM}))),
    ('missing-tauri_smoke', 'C', lambda r, d, a, x: (d.pop('tests/e2e/tauri_smoke.py'), a.pop('tests/e2e/tauri_smoke.py'))),
    ('missing-validator', 'C', lambda r, d, a, x: (d.pop('tests/integration/rhwp/ownership-poc/native_d1_result.py'),
                                                   a.pop('tests/integration/rhwp/ownership-poc/native_d1_result.py'))),
    ('missing-app', 'C', lambda r, d, a, x: (d.pop('src-tauri/target/debug/geul'), a.pop('src-tauri/target/debug/geul'))),
    ('non-canonical-name', 'C', lambda r, d, a, x: [m.update({'./tests/e2e/tauri_smoke.py': m.pop('tests/e2e/tauri_smoke.py')}) for m in (d, a)]),
    ('wrong-digest-format', 'C', lambda r, d, a, x: [m.update({'rhwp.js': 'B69E' + m['rhwp.js'][4:]}) for m in (d, a)]),
    ('wrong-digest-type', 'C', lambda r, d, a, x: [m.update({'ENGINE.json': None}) for m in (d, a)]),
    ('candidate-js-not-anchor', 'D', lambda r, d, a, x: [m.update({'rhwp.js': OTHER}) for m in (d, a)]),
    ('expected-and-result-agree-on-wrong-wasm', 'D', lambda r, d, a, x: (r['engineIdentity'].update(wasmSha256=OTHER),
                                                    [m.update({'rhwp_bg.wasm': OTHER}) for m in (d, a)], x.update(expected=OTHER, bytes=OTHER))),
]


def judge(module, hardened, result, deps, lifecycle, expected, wasm_bytes, anchor):
    kwargs = dict(harness_exit=result['parentExit'], result=result, result_error=None, expected_wasm=expected,
                  candidate_wasm_before=wasm_bytes, candidate_wasm_after=wasm_bytes, dependencies_before=deps[0],
                  dependencies_after=deps[1], lifecycle=lifecycle)
    if hardened: kwargs.update(trusted_identity=anchor, manifest_version=1)
    verdict = module.validate(**kwargs)
    return {'status': verdict['status'], 'categories': verdict['categories'], 'exit': module.exit_code(verdict, result['parentExit'])}


def main():
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('--old-commit', required=True); a.add_argument('--output', type=Path, required=True)
    args = a.parse_args()
    if args.output.exists(): raise SystemExit('preserve previous output')
    old_text = subprocess.check_output(['git', '-C', str(ROOT), 'show', f'{args.old_commit}:{VALIDATOR}'], text=True)
    old, new = load('previous_validator', old_text), load('hardened_validator', (ROOT / VALIDATOR).read_text())
    anchor = new.load_trust_anchor(ROOT)
    genuine = json.loads((BASE / 'native-d1-attempt1.json').read_text())
    lifecycle = json.loads((BASE / 'native-d1-attempt1-lifecycle.json').read_text())
    rows = []
    for name, area, mutate in CASES:
        result = copy.deepcopy(genuine)
        before, after = copy.deepcopy(result['executedDependencySha256']), copy.deepcopy(result['executedDependencySha256'])
        extra = {}
        mutate(result, before, after, extra)
        deps = extra.get('deps', (before, after))
        expected, wasm_bytes = extra.get('expected', WASM), extra.get('bytes', WASM)
        rows.append({'case': name, 'area': area,
                     'previous': judge(old, False, result, copy.deepcopy(deps), lifecycle, expected, wasm_bytes, anchor),
                     'hardened': judge(new, True, result, copy.deepcopy(deps), lifecycle, expected, wasm_bytes, anchor)})
    exit_helper = {'previous_exit_code(PASS verdict, harness 2)': old.exit_code({'status': 'PASS', 'failures': []}, 2),
                   'hardened_exit_code(PASS verdict, harness 2)': new.exit_code({'schema': new.SCHEMA, 'status': 'PASS', 'failures': [], 'categories': []}, 2),
                   'hardened_exit_code(PASS-looking verdict without schema/categories, harness 0)': new.exit_code({'status': 'PASS', 'failures': []}, 0)}
    accepted_before = [r['case'] for r in rows if r['previous']['status'] == 'PASS' and r['case'] != 'genuine-unchanged']
    accepted_after = [r['case'] for r in rows if r['hardened']['status'] == 'PASS' and r['case'] != 'genuine-unchanged']
    report = {'schema': 1, 'kind': 'synthetic mutations of genuine evidence (not runtime observations)', 'oldCommit': args.old_commit,
              'previousValidatorSha256': hashlib.sha256(old_text.encode()).hexdigest(),
              'hardenedValidatorSha256': hashlib.sha256((ROOT / VALIDATOR).read_bytes()).hexdigest(),
              'base': 'native-d1-attempt1 of t010-readiness-residual-stabilization', 'cases': rows, 'exitCodeHelper': exit_helper,
              'previousAcceptedInvalid': accepted_before, 'hardenedAcceptedInvalid': accepted_after,
              'genuineAcceptedByBoth': rows[0]['previous']['status'] == rows[0]['hardened']['status'] == 'PASS'}
    report['status'] = 'PASS' if report['genuineAcceptedByBoth'] and not accepted_after and accepted_before else 'FAIL'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({k: report[k] for k in ('previousAcceptedInvalid', 'hardenedAcceptedInvalid', 'genuineAcceptedByBoth', 'exitCodeHelper', 'status')}, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
