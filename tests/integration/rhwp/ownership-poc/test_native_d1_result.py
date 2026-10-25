"""Fail-closed native D1 wrapper verdict (native_d1_result.validate): one complete PASS, each invariant broken once."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import signal
import unittest

import native_d1_result as contract

HERE = Path(__file__).resolve().parent
WASM = 'ca5c0b8443230ba719c07f4d8c835a94fb6e12eb4b50a7123ce5c8b6a8048d45'
OTHER = '0' * 64
# Independent copies of the committed trust anchor values (t010-decoded-lease-readiness-closure/candidate-identity.json).
TRUSTED = {'rhwp_bg.wasm': WASM, 'rhwp.js': 'b69e920c8fb1e9d05dacadf3ebae2396b043da385137ad2b4b3386a9b3433252',
           'rhwp.d.ts': 'bce4ef51719a5ba738b26afc34ce62e0ab19224bef4ea7937b761e894eb21e9d',
           'ENGINE.json': '9d3b638a4dbbd38dde3cb640df3b5b78f16e685736da38a561099c870288b5d4'}
# Independent copy of the strict matrix; the contract constants must equal it and the harness's required_tests().
FOUR = ['basic-ko.hwp', 'basic-ko.hwpx', '연구노트(화학).hwp', '3249937_asset_management_rules.hwpx']
LABELS = ('warm', 'typed-10', 'typed-20', 'typed-30', 'undo', 'redo')


def complete_result():
    tests = [{'name': name, 'status': 'PASS'} for name in contract.required_tests()]
    refs = [{'name': f'{s}-{f}', 'sample': s, 'frame': f, 'verified': True, 'pixels': 0, 'maxDelta': 0} for s in FOUR for f in LABELS]
    return {'status': 'PASS', 'failures': [], 'tests': tests, 'visualReferences': refs, 'selectedSamples': list(FOUR), 'expectedSamples': list(FOUR),
            'diagnosticContinuation': False, 'historyGates': [], 'historyChecks': [], 'documents': [{'sample': s} for s in FOUR],
            'expectedAssertionCount': 39, 'expectedReferenceCount': 24, 'verifiedExactReferenceCount': 24,
            'measurementComplete': True, 'pixelReferencesComplete': True,
            'cleanup': {'sessionEnded': True, 'driverStopped': True, 'displayTerminated': True},
            'engineIdentity': {'wasmSha256': WASM, 'baseline': '1a76570e833917d15817415a53c09ad61ab3203f'},
            'teardown': [complete_teardown()]}


def complete_teardown():
    return {'sessionDeletes': [{'outcome': 'ok', 'seconds': 0.009}], 'complete': True, 'driverExit': 0, 'driverKilled': False,
            'beforeDriverStop': [{'pid': 30, 'comm': 'tauri-driver', 'state': 'S', 'ppid': 29}, {'pid': 33, 'comm': 'WebKitWebProces', 'state': 'R', 'ppid': 32}],
            'afterDriverStop': [{'pid': 33, 'comm': 'WebKitWebProces', 'state': 'S', 'ppid': 32}], 'driverStopSeconds': 0.011,
            'remainingAfterWait': [], 'sigtermSent': [], 'sigtermErrors': [], 'survivorsAfterSigterm': []}


def complete_dependencies(version=contract.CURRENT_MANIFEST):
    return {name: TRUSTED.get(name, format(index + 1, '064x')) for index, name in enumerate(contract.DEPENDENCY_MANIFESTS[version])}


def complete_lifecycle():
    return {'schema': 2, 'samples': 900, 'observerError': None, 'observerStopped': True, 'leftAtEnd': [],
            'processes': [{'pid': 20, 'comm': 'tauri-driver', 'gone': 80.1}, {'pid': 22, 'comm': 'geul', 'gone': 80.1},
                          {'pid': 23, 'comm': 'WebKitWebProces', 'gone': 80.3}]}


def run(result=None, *, missing=False, error=None, harness_exit=0, lifecycle=None, deps=None, deps_after=None,
        wasm_before=WASM, wasm_after=WASM, expected=WASM, evidence_errors=(), trusted=TRUSTED, manifest=contract.CURRENT_MANIFEST):
    deps = complete_dependencies() if deps is None else deps
    return contract.validate(harness_exit=harness_exit, result=None if missing or error else (complete_result() if result is None else result),
                             result_error='missing' if missing else error, expected_wasm=expected, candidate_wasm_before=wasm_before,
                             candidate_wasm_after=wasm_after, dependencies_before=deps, dependencies_after=copy.deepcopy(deps) if deps_after is None else deps_after,
                             lifecycle=complete_lifecycle() if lifecycle is None else lifecycle, evidence_errors=evidence_errors,
                             trusted_identity=trusted, manifest_version=manifest)


def changed(name, value, deps=None):
    deps = complete_dependencies() if deps is None else deps
    deps[name] = value; return deps


def mutated(change):
    result = complete_result(); change(result); return result


class Contract(unittest.TestCase):
    def test_constants_match_the_independent_matrix_and_the_harness(self):
        self.assertEqual(list(contract.SAMPLES), FOUR)
        self.assertEqual(contract.FRAMES, LABELS)
        spec = importlib.util.spec_from_file_location('d1_harness_for_contract', HERE / 'performance-visual-native.py')
        harness = importlib.util.module_from_spec(spec); spec.loader.exec_module(harness)
        self.assertEqual(contract.required_tests(), harness.required_tests(FOUR))
        self.assertEqual(len(contract.required_tests()), contract.EXPECTED_ASSERTIONS)
        self.assertEqual(len(FOUR) * len(LABELS), contract.EXPECTED_REFERENCES)
        self.assertEqual(contract.CLEANUP_STEPS, harness.CLEANUP_STEPS)

    def test_complete_pass(self):
        verdict = run()
        self.assertEqual((verdict['status'], verdict['failures']), ('PASS', []))
        self.assertEqual(contract.exit_code(verdict, 0), 0)


class FailClosed(unittest.TestCase):
    def failing(self, verdict, category, exit_from=0, code=3):
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertIn(category, verdict['categories'], verdict['failures'])
        self.assertEqual(contract.exit_code(verdict, exit_from), code)
        return verdict

    def test_exit0_json_fail(self):
        self.failing(run(mutated(lambda r: r.update(status='FAIL', failures=['cleanup incomplete: driverStopped']))), 'failed-assertions')

    def test_exit0_missing_json(self):
        self.assertEqual(self.failing(run(missing=True), 'missing-result')['categories'], ['missing-result'])

    def test_exit0_malformed_json(self):
        self.failing(run(error='JSONDecodeError: Expecting value'), 'malformed-result')

    def test_non_object_result(self):
        self.failing(run(['PASS']), 'malformed-result')

    def test_exit0_missing_cleanup_field(self):
        self.failing(run(mutated(lambda r: r['cleanup'].pop('displayTerminated'))), 'cleanup')
        self.failing(run(mutated(lambda r: r.pop('cleanup'))), 'cleanup')

    def test_exit0_cleanup_false_even_with_all_visual_assertions_passing(self):
        for step in contract.CLEANUP_STEPS:
            verdict = self.failing(run(mutated(lambda r: r['cleanup'].update({step: False}))), 'cleanup')
            self.assertEqual(verdict['categories'], ['cleanup'])

    def test_cleanup_truthy_non_bool_rejected(self):
        self.failing(run(mutated(lambda r: r['cleanup'].update(sessionEnded=1))), 'cleanup')
        self.failing(run(mutated(lambda r: r['cleanup'].update(extra=True))), 'cleanup')

    def test_exit0_incomplete_d1_assertions(self):
        self.failing(run(mutated(lambda r: r['tests'].pop())), 'incomplete-verification')
        self.failing(run(mutated(lambda r: r['tests'].reverse())), 'incomplete-verification')
        self.failing(run(mutated(lambda r: r['tests'][5].update(status='FAIL'))), 'failed-assertions')
        self.failing(run(mutated(lambda r: r.update(expectedAssertionCount=38))), 'incomplete-verification')

    def test_exit0_incomplete_rgba_verification(self):
        self.failing(run(mutated(lambda r: r['visualReferences'].pop())), 'incomplete-verification')
        self.failing(run(mutated(lambda r: r['visualReferences'][0].update(verified=False))), 'incomplete-verification')
        self.failing(run(mutated(lambda r: r['visualReferences'][3].update(pixels=4))), 'failed-assertions')
        self.failing(run(mutated(lambda r: r['visualReferences'][3].update(maxDelta=1))), 'failed-assertions')
        self.failing(run(mutated(lambda r: r.update(verifiedExactReferenceCount=23))), 'incomplete-verification')
        self.failing(run(mutated(lambda r: r.update(pixelReferencesComplete=False))), 'incomplete-verification')

    def test_exit0_dependencies_changed(self):
        self.assertEqual(run(deps_after=changed('tests/e2e/tauri_smoke.py', '2' * 64))['categories'], ['dependency-mutation'])
        self.failing(run(deps={}), 'dependency-manifest')

    def test_exit0_candidate_identity_mismatch(self):
        self.failing(run(mutated(lambda r: r['engineIdentity'].update(wasmSha256=OTHER))), 'candidate-identity')
        self.failing(run(wasm_after=OTHER), 'candidate-identity')
        self.failing(run(wasm_before=OTHER), 'candidate-identity')
        self.failing(run(deps=changed('rhwp_bg.wasm', OTHER)), 'candidate-identity')

    def test_expected_identity_cannot_come_from_the_result(self):
        # Every self-reported identity agrees with a wrong expectation; the expectation itself is checked against bytes.
        verdict = self.failing(run(mutated(lambda r: r['engineIdentity'].update(wasmSha256=OTHER)), expected=OTHER), 'candidate-identity')
        self.assertTrue(any('trust anchor' in f['invariant'] for f in verdict['failures']))

    def test_nonzero_harness_with_json_pass_keeps_its_code(self):
        self.failing(run(harness_exit=2), 'native-subprocess', exit_from=2, code=2)
        self.failing(run(harness_exit=-15), 'native-subprocess', exit_from=-15, code=3)
        self.failing(run(harness_exit=None), 'native-subprocess', exit_from=None, code=3)

    def test_wrong_typed_verification_fields(self):
        for change in (lambda r: r.update(status=True), lambda r: r.update(failures=None), lambda r: r.update(measurementComplete=1),
                       lambda r: r.update(expectedAssertionCount=39.0), lambda r: r.update(verifiedExactReferenceCount=True),
                       lambda r: r.update(expectedReferenceCount='24'), lambda r: r.update(diagnosticContinuation=0),
                       lambda r: r['visualReferences'][0].update(pixels=False), lambda r: r['visualReferences'][0].update(maxDelta=0.0),
                       lambda r: r['tests'].__setitem__(0, 'bootstrap-clean-close'), lambda r: r.update(historyGates=None)):
            verdict = run(mutated(change))
            self.assertEqual(verdict['status'], 'FAIL')
            self.assertTrue(set(verdict['categories']) <= {'incomplete-verification', 'failed-assertions'}, verdict['categories'])
            self.assertEqual(contract.exit_code(verdict, 0), 3)

    def test_harness_error_or_failure_list_cannot_pass(self):
        self.failing(run(mutated(lambda r: r.update(error='display cleanup: timeout'))), 'failed-assertions')
        self.failing(run(mutated(lambda r: r.update(failures=['x']))), 'failed-assertions')

    def test_teardown_record_required_and_must_show_no_survivors(self):
        # Missing or malformed evidence is 'teardown-evidence'; an observed leak or failed DELETE is 'cleanup'.
        self.failing(run(mutated(lambda r: r.pop('teardown'))), 'teardown-evidence')
        self.failing(run(mutated(lambda r: r.update(teardown=[]))), 'teardown-evidence')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(sessionDeletes=[{'outcome': 'driverLost', 'seconds': 60.0}]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(sessionDeletes=[]))), 'teardown-evidence')
        leak = run(mutated(lambda r: r['teardown'][0].update(remainingAfterWait=[{'pid': 5, 'comm': 'geul', 'state': 'S', 'ppid': 1}])))
        self.assertEqual(leak['categories'], ['cleanup'])
        self.failing(run(mutated(lambda r: r['teardown'][0].update(sigtermSent=[5]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(driverExit=None))), 'teardown-evidence')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(complete=False))), 'teardown-evidence')

    def test_lifecycle_contradicting_cleanup_fails(self):
        left = complete_lifecycle(); left['processes'][1].pop('gone'); left['leftAtEnd'] = [left['processes'][1]]
        self.failing(run(lifecycle=left), 'lifecycle')
        unseen = complete_lifecycle(); unseen['processes'] = [p for p in unseen['processes'] if p['comm'] != 'geul']
        self.failing(run(lifecycle=unseen), 'lifecycle')

    def test_observer_or_evidence_write_failure(self):
        self.failing(run(lifecycle=dict(complete_lifecycle(), observerError='PermissionError: /proc')), 'evidence-write')
        self.failing(run(lifecycle=dict(complete_lifecycle(), observerStopped=False)), 'evidence-write')
        self.failing(run(lifecycle=dict(complete_lifecycle(), samples=0)), 'evidence-write')
        self.failing(run(evidence_errors=['lifecycle write: OSError: disk full']), 'evidence-write')
        self.assertEqual(run(lifecycle=False)['categories'], ['evidence-write'])

    def test_categories_stay_separate(self):
        verdict = run(mutated(lambda r: r['cleanup'].update(driverStopped=False)), harness_exit=1, deps_after=changed('tests/e2e/tauri_smoke.py', OTHER))
        self.assertEqual(verdict['categories'], ['cleanup', 'dependency-mutation', 'native-subprocess'])

    def test_input_is_not_modified(self):
        result = complete_result(); snapshot = copy.deepcopy(result)
        run(result)
        self.assertEqual(result, snapshot)



class GenuineEvidence(unittest.TestCase):
    """Real native runs. Manifest-v1 records (t010-readiness-residual-stabilization) pass only under v1 and fail the strict
    v2 manifest; manifest-v2 records (t010-native-evidence-security-hardening) pass under v2. One flipped step fails."""
    EVIDENCE = HERE.parents[0] / 'evidence'
    SETS = {1: 't010-readiness-residual-stabilization', 2: 't010-native-evidence-security-hardening'}

    def verdict(self, version, attempt, change=None, manifest=None):
        folder = self.EVIDENCE / self.SETS[version]
        result = contract.loads_strict((folder / f'native-d1-attempt{attempt}.json').read_text())
        lifecycle = contract.loads_strict((folder / f'native-d1-attempt{attempt}-lifecycle.json').read_text())
        if change: change(result)
        before = result['executedDependencySha256']
        after = result.get('executedDependencySha256After', before if result['executedDependenciesStable'] is True else {})
        return contract.validate(harness_exit=result['parentExit'], result=result, result_error=None, expected_wasm=WASM,
                                 candidate_wasm_before=WASM, candidate_wasm_after=WASM, dependencies_before=before,
                                 dependencies_after=after, lifecycle=lifecycle, trusted_identity=TRUSTED,
                                 manifest_version=version if manifest is None else manifest)

    def attempts(self, version):
        return sorted(int(p.name.split('attempt')[1].split('-')[0]) for p in (self.EVIDENCE / self.SETS[version]).glob('native-d1-attempt*-wrapper-verdict.json'))

    def test_recorded_runs_pass_under_their_own_manifest(self):
        for version in (1, 2):
            attempts = self.attempts(version)
            self.assertEqual(attempts, [1, 2, 3], version)
            for attempt in attempts:
                recorded = json.loads((self.EVIDENCE / self.SETS[version] / f'native-d1-attempt{attempt}-wrapper-verdict.json').read_text())
                self.assertEqual((recorded['verdict']['status'], recorded['harnessExit']), ('PASS', 0))
                verdict = self.verdict(version, attempt)
                self.assertEqual(verdict['status'], 'PASS', verdict['failures'])

    def test_historical_v1_records_do_not_satisfy_the_strict_manifest(self):
        verdict = self.verdict(1, 1, manifest=2)
        self.assertEqual(verdict['categories'], ['dependency-manifest'])

    def test_recorded_v2_records_name_the_current_manifest_and_driver_policy(self):
        for attempt in self.attempts(2):
            result = json.loads((self.EVIDENCE / self.SETS[2] / f'native-d1-attempt{attempt}.json').read_text())
            self.assertEqual(result['dependencyManifest'], contract.CURRENT_MANIFEST)
            self.assertEqual((result['teardown'][0]['driverKilled'], result['teardown'][0]['driverExit']), (False, 0))
            self.assertEqual(result['wrapperVerdict']['trustAnchor'], contract.TRUST_ANCHOR)

    def test_recorded_run_with_one_cleanup_step_false_fails(self):
        for version in (1, 2):
            verdict = self.verdict(version, 1, lambda r: r['cleanup'].update(driverStopped=False))
            self.assertEqual(verdict['categories'], ['cleanup'])

    def test_recorded_run_with_forced_kill_fails(self):
        for version in (1, 2):
            verdict = self.verdict(version, 1, lambda r: r['teardown'][0].update(driverKilled=True, driverExit=-signal.SIGKILL))
            self.assertEqual(verdict['categories'], ['cleanup'])
            self.assertEqual(contract.exit_code(verdict, 0), 3)


def teardown_case(change):
    result = complete_result(); change(result['teardown'][0]); return run(result)


class DriverTermination(unittest.TestCase):
    """Strict D1 driver-termination contract: no forced kill; exit 0 (observed for tauri-driver 2.0.4) or -SIGTERM."""

    def rejected(self, change, category):
        verdict = teardown_case(change)
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertIn(category, verdict['categories'], verdict['failures'])
        self.assertEqual(contract.exit_code(verdict, 0), 3)
        return verdict

    def test_accepted_terminations(self):
        self.assertEqual(teardown_case(lambda t: None)['status'], 'PASS')
        self.assertEqual(teardown_case(lambda t: t.update(driverExit=-signal.SIGTERM))['status'], 'PASS')
        self.assertEqual(contract.ACCEPTED_DRIVER_EXITS, (0, -15))

    def test_forced_kill_is_never_clean(self):
        for code in (-signal.SIGKILL, 0):
            verdict = self.rejected(lambda t: t.update(driverKilled=True, driverExit=code), 'cleanup')
            self.assertTrue(any('force-killed' in f['invariant'] for f in verdict['failures']))
        # Even when every owned process was released afterwards, the forced kill stays visible.
        verdict = self.rejected(lambda t: t.update(driverKilled=True, driverExit=-9, afterDriverStop=[]), 'cleanup')
        self.assertEqual(verdict['categories'], ['cleanup'])

    def test_sigkill_status_without_a_kill_record(self):
        verdict = self.rejected(lambda t: t.update(driverExit=-signal.SIGKILL), 'cleanup')
        self.assertTrue(any('without a recorded forced kill' in f['invariant'] for f in verdict['failures']))

    def test_unsupported_exits(self):
        for code in (1, 2, 101, -signal.SIGSEGV, -signal.SIGINT):
            self.rejected(lambda t: t.update(driverExit=code), 'cleanup')

    def test_wrong_typed_or_missing_kill_and_exit_fields(self):
        for change in (lambda t: t.pop('driverKilled'), lambda t: t.update(driverKilled=None), lambda t: t.update(driverKilled=0),
                       lambda t: t.update(driverKilled='false'), lambda t: t.pop('driverExit'), lambda t: t.update(driverExit=None),
                       lambda t: t.update(driverExit=True), lambda t: t.update(driverExit=0.0), lambda t: t.update(driverExit='0')):
            self.rejected(change, 'teardown-evidence')


class TeardownSchema(unittest.TestCase):
    """Every supported teardown field is mandatory and typed; snapshots may be empty or differ."""

    def bad(self, change, category='teardown-evidence'):
        verdict = teardown_case(change)
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertIn(category, verdict['categories'], verdict['failures'])
        self.assertEqual(contract.exit_code(verdict, 0), 3)

    def test_every_field_is_required(self):
        for key in contract.TEARDOWN_KEYS:
            self.bad(lambda t: t.pop(key))

    def test_unsupported_field(self):
        self.bad(lambda t: t.update(note='x'))

    def test_durations(self):
        for value in (math.nan, math.inf, -0.001, '0.01', True, None):
            self.bad(lambda t: t.update(driverStopSeconds=value))
            self.bad(lambda t: t['sessionDeletes'][0].update(seconds=value))
        self.assertEqual(teardown_case(lambda t: t.update(driverStopSeconds=0))['status'], 'PASS')

    def test_delete_records(self):
        self.bad(lambda t: t['sessionDeletes'].append({'outcome': 'ok', 'seconds': 0.1}))
        self.bad(lambda t: t['sessionDeletes'][0].pop('outcome'))
        self.bad(lambda t: t['sessionDeletes'][0].update(outcome=None))
        self.bad(lambda t: t['sessionDeletes'][0].update(outcome='httpError'), 'cleanup')

    def test_process_rows(self):
        for row in ({'pid': '7', 'comm': 'geul', 'state': 'S', 'ppid': 1}, {'pid': True, 'gone': True}, {'pid': 7, 'gone': 1},
                    {'pid': 7, 'comm': '', 'state': 'S', 'ppid': 1}, {'pid': 7, 'comm': 'geul', 'state': 'Q', 'ppid': 1},
                    {'pid': 7, 'comm': 'geul', 'state': 'S', 'ppid': -1}, {'pid': 7, 'comm': 'geul', 'state': 'S'},
                    {'pid': 7, 'comm': 'geul', 'state': 'S', 'ppid': 1, 'cmdline': 'x'}, 'geul', None):
            for key in ('beforeDriverStop', 'afterDriverStop'):
                self.bad(lambda t: t[key].append(row))
        for key in ('beforeDriverStop', 'afterDriverStop'):
            self.bad(lambda t: t.update({key: None}))

    def test_legitimate_snapshots(self):
        self.assertEqual(teardown_case(lambda t: t.update(beforeDriverStop=[], afterDriverStop=[]))['status'], 'PASS')
        self.assertEqual(teardown_case(lambda t: t['afterDriverStop'].append({'pid': 40, 'gone': True}))['status'], 'PASS')
        # A process seen after the driver stopped that exits before the 30 s boundary is not a failure.
        self.assertEqual(teardown_case(lambda t: t['afterDriverStop'].append({'pid': 41, 'comm': 'geul', 'state': 'S', 'ppid': 1}))['status'], 'PASS')

    def test_contradictions_and_final_boundary(self):
        self.bad(lambda t: t['afterDriverStop'].append({'pid': 30, 'comm': 'tauri-driver', 'state': 'S', 'ppid': 29}))
        self.bad(lambda t: t.update(survivorsAfterSigterm=[{'pid': 41, 'comm': 'geul', 'state': 'S', 'ppid': 1}]), 'cleanup')
        self.bad(lambda t: t.update(sigtermSent=['41']))
        self.bad(lambda t: t.update(sigtermErrors=[{'pid': 41}]))
        self.bad(lambda t: t.update(sigtermErrors=[{'pid': 41, 'error': 'ProcessLookupError'}]), 'cleanup')
        self.bad(lambda t: t.update(complete=1))

    def test_invalid_evidence_is_distinguishable_from_a_leak(self):
        self.assertEqual(teardown_case(lambda t: t.pop('remainingAfterWait'))['categories'], ['teardown-evidence'])
        self.assertEqual(teardown_case(lambda t: t.update(remainingAfterWait=[{'pid': 41, 'comm': 'geul', 'state': 'S', 'ppid': 1}]))['categories'], ['cleanup'])


class DependencyManifest(unittest.TestCase):
    V2 = ['tests/integration/rhwp/ownership-poc/session.mjs', 'tests/integration/rhwp/ownership-poc/vite.config.mjs',
          'tests/integration/rhwp/ownership-poc/native.py', 'tests/integration/rhwp/ownership-poc/generate.mjs',
          'tests/integration/rhwp/ownership-poc/performance-visual-native.py', 'tests/integration/rhwp/ownership-poc/native_d1_result.py',
          'tests/integration/rhwp/undo_native.py', 'tests/integration/rhwp/native_probe.py', 'tests/integration/rhwp/rhwp_poc.py',
          'tests/e2e/tauri_smoke.py', 'tests/fixtures/rhwp/generate.mjs', 'src-tauri/target/debug/geul', 'rhwp.js', 'rhwp_bg.wasm', 'ENGINE.json',
          'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/engine-safety-gates.json',
          'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/chrome.json',
          'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/webkit.json',
          'rhwp.d.ts', 'vite.config.ts', 'index.html', 'tree:src']

    def bad(self, category, **kwargs):
        verdict = run(**kwargs)
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertIn(category, verdict['categories'], verdict['failures'])
        self.assertEqual(contract.exit_code(verdict, 0), 3)

    def without(self, name):
        deps = complete_dependencies(); deps.pop(name); return deps

    def test_manifest_is_the_independent_list(self):
        self.assertEqual(list(contract.DEPENDENCY_MANIFESTS[2]), self.V2)
        self.assertEqual(list(contract.DEPENDENCY_MANIFESTS[1]), self.V2[:18])
        self.assertEqual(contract.CURRENT_MANIFEST, 2)
        self.assertEqual(len(set(self.V2)), len(self.V2))

    def test_only_wasm(self):
        self.bad('dependency-manifest', deps={'rhwp_bg.wasm': WASM})

    def test_each_missing_mandatory_dependency(self):
        for name in ('tests/integration/rhwp/ownership-poc/native_d1_result.py', 'tests/e2e/tauri_smoke.py',
                     'tests/integration/rhwp/ownership-poc/performance-visual-native.py', 'rhwp.js', 'src-tauri/target/debug/geul',
                     'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/webkit.json', 'tree:src'):
            self.bad('dependency-manifest', deps=self.without(name))
            self.bad('dependency-manifest', deps_after=self.without(name))

    def test_digest_format_and_type(self):
        for value in ('B' * 64, 'b' * 63, None, 1, b'0' * 64):
            self.bad('dependency-manifest', deps=changed('tests/e2e/tauri_smoke.py', value))

    def test_changed_contents(self):
        self.assertEqual(run(deps_after=changed('tree:src', OTHER))['categories'], ['dependency-mutation'])

    def test_missing_collections(self):
        self.bad('dependency-manifest', deps={}, deps_after={})
        self.bad('dependency-manifest', deps_after='not a map')
        verdict = contract.validate(harness_exit=0, result=complete_result(), result_error=None, expected_wasm=WASM, candidate_wasm_before=WASM,
                                    candidate_wasm_after=WASM, dependencies_before=complete_dependencies(), dependencies_after=None,
                                    lifecycle=complete_lifecycle(), trusted_identity=TRUSTED, manifest_version=2)
        self.assertEqual(verdict['categories'], ['dependency-manifest'])

    def test_unsupported_manifest_versions(self):
        for version in (0, 3, '2', 2.0, True, None):
            self.bad('dependency-manifest', manifest=version)

    def test_unexpected_noncanonical_and_duplicate_names(self):
        self.bad('dependency-manifest', deps=changed('tests/e2e/extra.py', '3' * 64))
        deps = complete_dependencies(); deps['./tests/e2e/tauri_smoke.py'] = deps.pop('tests/e2e/tauri_smoke.py')
        self.bad('dependency-manifest', deps=deps)
        pairs = list(complete_dependencies().items()) + [('tests/e2e/tauri_smoke.py', '4' * 64)]
        self.bad('dependency-manifest', deps=pairs, deps_after=list(complete_dependencies().items()))
        self.assertEqual(run(deps=list(complete_dependencies().items()), deps_after=list(complete_dependencies().items()))['status'], 'PASS')
        with self.assertRaises(ValueError):
            contract.loads_strict('{"a": 1, "a": 2}')
        with self.assertRaises(ValueError):
            contract.loads_strict('{"a": NaN}')

    def test_candidate_entries_must_equal_the_anchor(self):
        for name in ('rhwp.js', 'rhwp.d.ts', 'ENGINE.json', 'rhwp_bg.wasm'):
            self.bad('candidate-identity', deps=changed(name, OTHER))


class TrustAnchor(unittest.TestCase):
    def test_committed_anchor_matches_the_independent_values(self):
        self.assertEqual(contract.load_trust_anchor(HERE.parents[3]), TRUSTED)
        data = (HERE.parents[3] / contract.TRUST_ANCHOR['path']).read_bytes()
        self.assertEqual(contract.trust_anchor_from_bytes(data), TRUSTED)

    def test_altered_anchor_bytes_are_rejected(self):
        data = (HERE.parents[3] / contract.TRUST_ANCHOR['path']).read_bytes()
        with self.assertRaises(ValueError):
            contract.trust_anchor_from_bytes(data.replace(WASM.encode(), OTHER.encode()))

    def test_unavailable_or_malformed_anchor_fails(self):
        for trusted in (None, {}, dict(TRUSTED, **{'rhwp.js': None}), {k: v for k, v in TRUSTED.items() if k != 'ENGINE.json'}):
            verdict = run(trusted=trusted)
            self.assertEqual(verdict['status'], 'FAIL')
            self.assertIn('candidate-identity', verdict['categories'])

    def test_argument_must_equal_the_anchor_even_if_everything_else_agrees(self):
        result = mutated(lambda r: r['engineIdentity'].update(wasmSha256=OTHER))
        verdict = run(result, expected=OTHER, wasm_before=OTHER, wasm_after=OTHER, deps=changed('rhwp_bg.wasm', OTHER))
        self.assertEqual(verdict['categories'], ['candidate-identity'])
        self.assertIsNone(None if verdict['expectedWasmSha256'] == WASM else verdict['expectedWasmSha256'])

    def test_result_cannot_supply_its_own_anchor(self):
        result = mutated(lambda r: r.update(trustedIdentity={k: OTHER for k in TRUSTED}, expectedWasm=OTHER))
        self.assertEqual(run(result)['status'], 'PASS')  # ignored fields: the anchor comes only from the caller
        self.assertEqual(run(result, trusted={k: OTHER for k in TRUSTED})['categories'], ['candidate-identity'])


class ExitCode(unittest.TestCase):
    PASS = {'schema': contract.SCHEMA, 'status': 'PASS', 'failures': [], 'categories': []}

    def test_only_harness_zero_and_wellformed_pass(self):
        self.assertEqual(contract.exit_code(dict(self.PASS), 0), 0)
        for harness, code in ((1, 1), (2, 2), (255, 255), (-15, 3), (256, 3), (None, 3), (True, 3), (0.0, 3)):
            self.assertEqual(contract.exit_code(dict(self.PASS), harness), code, harness)

    def test_malformed_verdicts(self):
        for verdict in (None, [], 'PASS', {}, dict(self.PASS, status='FAIL'), dict(self.PASS, status=True), dict(self.PASS, failures=None),
                        dict(self.PASS, failures=[{'category': 'cleanup'}]), dict(self.PASS, categories=['cleanup']),
                        dict(self.PASS, categories=None), dict(self.PASS, schema=1), {k: v for k, v in self.PASS.items() if k != 'schema'}):
            self.assertEqual(contract.exit_code(verdict, 0), 3, verdict)

    def test_real_verdict_round_trip(self):
        self.assertEqual(contract.exit_code(run(), 0), 0)
        self.assertEqual(contract.exit_code(run(harness_exit=1), 1), 1)


if __name__ == '__main__':
    unittest.main()
