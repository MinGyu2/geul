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
            'diagnosticContinuation': False, 'historyGates': [], 'historyChecks': [], 'documents': [{'sample': s, 'sourceSha256': contract.FIXTURE_SHA256[s]} for s in FOUR],
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


def complete_dependencies(version=3):
    return {name: TRUSTED.get(name, {path: contract.FIXTURE_SHA256[sample] for sample, path in contract.PINNED_FIXTURES.items()}.get(name, format(index + 1, '064x'))) for index, name in enumerate(contract.DEPENDENCY_MANIFESTS[version])}


def complete_lifecycle():
    previous = HERE.parent / 'evidence/t010-native-evidence-security-hardening/native-d1-attempt1-lifecycle.json'
    return json.loads(previous.read_text())


def run(result=None, *, missing=False, error=None, harness_exit=0, lifecycle=None, deps=None, deps_after=None,
        wasm_before=WASM, wasm_after=WASM, expected=WASM, evidence_errors=(), trusted=TRUSTED, manifest=3, attempt=1):
    if lifecycle is None:
        lifecycle = complete_lifecycle()
        if type(harness_exit) is int:
            next(e for e in lifecycle['events'] if e['event'] == 'harness-exit')['exit'] = harness_exit
    deps = complete_dependencies() if deps is None else deps
    return contract.validate(harness_exit=harness_exit, result=None if missing or error else (complete_result() if result is None else result),
                             result_error='missing' if missing else error, expected_wasm=expected, candidate_wasm_before=wasm_before,
                             candidate_wasm_after=wasm_after, dependencies_before=deps, dependencies_after=copy.deepcopy(deps) if deps_after is None else deps_after,
                             lifecycle=complete_lifecycle() if lifecycle is None else lifecycle, evidence_errors=evidence_errors,
                             trusted_identity=trusted, manifest_version=manifest, attempt=attempt)


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
            self.assertEqual(result['dependencyManifest'], 2)
            self.assertEqual((result['teardown'][0]['driverKilled'], result['teardown'][0]['driverExit']), (False, 0))
            self.assertEqual(result['wrapperVerdict']['trustAnchor'], contract.TRUST_ANCHORS[3])

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
        self.assertEqual(contract.CURRENT_MANIFEST, 4)  # v4: trust anchor replacement approved 2026-10-28 (AnchorV2 below)
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
        for version in (0, 5, '2', 2.0, True, None):
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
        self.assertEqual(contract.load_trust_anchor(HERE.parents[3], 3), TRUSTED)
        data = (HERE.parents[3] / contract.TRUST_ANCHORS[3]['path']).read_bytes()
        self.assertEqual(contract.trust_anchor_from_bytes(data, 3), TRUSTED)

    def test_altered_anchor_bytes_are_rejected(self):
        data = (HERE.parents[3] / contract.TRUST_ANCHORS[3]['path']).read_bytes()
        with self.assertRaises(ValueError):
            contract.trust_anchor_from_bytes(data.replace(WASM.encode(), OTHER.encode()), 3)

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


class FinalIntegrity(unittest.TestCase):
    def reject(self, **kwargs):
        v = run(**kwargs)
        self.assertEqual(v['status'], 'FAIL', v)
        self.assertNotEqual(contract.exit_code(v, 0), 0)
        return v

    def lifecycle_bad(self, change):
        l = complete_lifecycle(); change(l); return self.reject(lifecycle=l)

    def test_v3_all_entries_and_new_inputs_exist(self):
        root = HERE.parents[3]
        required = contract.DEPENDENCY_MANIFESTS[3]
        self.assertTrue(set(contract.DEPENDENCY_MANIFESTS[2]) < set(required))
        self.assertEqual(len(required), len(set(required)))
        for name in (contract.NATIVE_WRAPPER, 'package.json', 'tsconfig.json', 'public/rhwp/rhwp.js',
                     'public/rhwp/rhwp_bg.wasm', 'public/rhwp/BUILD.json',
                     'tests/integration/rhwp/cache-concurrency/fixtures.mjs', *contract.PINNED_FIXTURES.values()):
            self.assertIn(name, required)
            self.assertTrue((root / name).is_file(), name)

    def test_every_v3_entry_missing_changed_unreadable_or_malformed(self):
        for name in contract.DEPENDENCY_MANIFESTS[3]:
            with self.subTest(name=name):
                d = complete_dependencies(); d.pop(name); self.reject(deps=d)
                self.reject(deps=changed(name, None))
                self.reject(deps=changed(name, 'A' * 64))
                self.reject(deps_after=changed(name, OTHER))

    def test_read_failure_and_missing_file_digest_fail_closed(self):
        from unittest.mock import patch
        root = HERE.parents[3]
        original = Path.read_bytes
        for failure in (PermissionError, FileNotFoundError):
            def read(path):
                if str(path).endswith('package.json'): raise failure('controlled read failure')
                return original(path)
            with patch.object(Path, 'read_bytes', read):
                d = contract.dependency_digests(root, root / 'public/rhwp')
            self.assertIsNone(d['package.json'])
            self.reject(deps=d)

    def test_submodule_revision_and_sample_bytes(self):
        from unittest.mock import patch
        root = HERE.parents[3]
        self.assertTrue(contract.pinned_samples_valid(root))
        with patch.object(contract.subprocess, 'check_output', return_value='160000 wrong 0\texternal/rhwp'):
            self.assertFalse(contract.pinned_samples_valid(root))
        original = Path.read_bytes
        for failure in (FileNotFoundError, PermissionError):
            def read(path):
                if str(path).endswith('연구노트(화학).hwp'): raise failure('controlled missing sample')
                return original(path)
            with patch.object(Path, 'read_bytes', read):
                self.assertFalse(contract.pinned_samples_valid(root))
        def altered(path):
            data = original(path)
            return data + b'x' if str(path).endswith('연구노트(화학).hwp') else data
        with patch.object(Path, 'read_bytes', altered): self.assertFalse(contract.pinned_samples_valid(root))

    def test_untracked_and_ignored_frontend_inputs_fail_closed(self):
        import tempfile, subprocess
        with tempfile.TemporaryDirectory() as tmp:
            r = Path(tmp); (r/'src').mkdir(); (r/'src/main.ts').write_text('export {};')
            subprocess.run(['git','init','-q',tmp], check=True)
            subprocess.run(['git','-C',tmp,'add','src/main.ts'], check=True)
            self.assertTrue(contract.frontend_inputs_valid(r))
            (r/'src/extra.ts').write_text('export {};')
            self.assertFalse(contract.frontend_inputs_valid(r))
            (r/'src/extra.ts').unlink(); (r/'.env.local').write_text('VITE_X=1')
            self.assertFalse(contract.frontend_inputs_valid(r))

    def test_missing_duplicate_reordered_documents(self):
        for change in (lambda r:r.pop('documents'), lambda r:r['documents'].pop(),
                       lambda r:r['documents'].append(r['documents'][0]), lambda r:r['documents'].reverse()):
            self.reject(result=mutated(change))

    def test_each_fixture_digest_must_be_independent_exact_sha256(self):
        for i in range(4):
            for value in (None, True, 1, [], {}, 'A'*64, '0'*63, OTHER):
                self.reject(result=mutated(lambda r:r['documents'][i].update(sourceSha256=value)))
            self.reject(result=mutated(lambda r:r['documents'][i].pop('sourceSha256')))
        self.reject(result=mutated(lambda r:[d.update(sourceSha256=OTHER) for d in r['documents']]))

    def test_lifecycle_missing_pid_or_name(self):
        for key in ('pid', 'comm', 'ppid', 'pgid', 'firstSeen', 'lastSeen', 'states'):
            self.lifecycle_bad(lambda l:l['processes'][0].pop(key))

    def test_lifecycle_pid_types(self):
        for key in ('pid', 'ppid', 'pgid'):
            for value in (True, 2.0, '2', None, -1):
                self.lifecycle_bad(lambda l:l['processes'][0].update({key:value}))

    def test_lifecycle_state_counters(self):
        for value in ({}, None, [], {'S':True}, {'S':1.0}, {'S':-1}, {'S':0}, {'Q':1}, {'SS':1}, {'S':999999}):
            self.lifecycle_bad(lambda l:l['processes'][0].update(states=value))

    def test_lifecycle_times(self):
        for key in ('firstSeen','lastSeen','gone'):
            for value in (True, -1, float('nan'), float('inf'), '0', None, 10**400):
                self.lifecycle_bad(lambda l:l['processes'][0].update({key:value}))
        self.lifecycle_bad(lambda l:l['processes'][0].update(firstSeen=9999))
        self.lifecycle_bad(lambda l:l['processes'][0].update(gone=0))

    def test_lifecycle_duplicate_identity(self):
        self.lifecycle_bad(lambda l:l['processes'].append(copy.deepcopy(l['processes'][0])))

    def test_lifecycle_metadata(self):
        for key in ('schema','attempt','observer','observerError','observerStopped','samples','events','leftAtEnd','cpuCount','loadAverage'):
            self.lifecycle_bad(lambda l:l.pop(key))
        for key, values in (('schema',(2.0,'2',True,3)), ('attempt',(0,True,'1',1.0)),
                            ('samples',(True,1.0,-1,None)), ('observerStopped',(None,1,False)),
                            ('observerError',('controlled observer failure',1))):
            for value in values:self.lifecycle_bad(lambda l:l.update({key:value}))

    def test_lifecycle_events(self):
        for value in (None, {}, [None], [{}], [{'t':0,'event':'gone','pid':True,'comm':'geul'}]):
            self.lifecycle_bad(lambda l:l.update(events=value))
        for key,value in (('pid',999999),('comm','wrong'),('t',-1),('t',True),('event','unknown')):
            self.lifecycle_bad(lambda l:l['events'][0].update({key:value}))
        self.lifecycle_bad(lambda l:l['events'].pop(0))

    def test_strict_attempt_is_independent_and_required(self):
        for attempt in (None, True, 1.0, '1', 0, 2):
            self.reject(attempt=attempt)
        self.assertEqual(run(attempt=1)['status'], 'PASS')

    def test_lifecycle_harness_exit_identity_and_times(self):
        self.lifecycle_bad(lambda l:next(e for e in l['events'] if e['event']=='harness-exit').update(exit=1))
        self.lifecycle_bad(lambda l:next(e for e in l['events'] if e['event']=='harness-exit').update(t=0))

    def test_lifecycle_survivor_and_final_consistency(self):
        self.lifecycle_bad(lambda l:l['processes'][0].pop('gone'))
        self.lifecycle_bad(lambda l:l.update(leftAtEnd=[l['processes'][0]]))
        self.lifecycle_bad(lambda l:l.update(leftAtEnd=None))
        self.lifecycle_bad(lambda l:l.update(processes=[{'comm':'geul','gone':1}]))

    def test_legitimate_disappearance_and_empty_driver_snapshots(self):
        l=complete_lifecycle()
        self.assertTrue(all('gone' in p for p in l['processes']))
        self.assertEqual(run(lifecycle=l)['status'],'PASS')
        r=complete_result();r['teardown'][0].update(beforeDriverStop=[],afterDriverStop=[])
        self.assertEqual(run(r,lifecycle=l)['status'],'PASS')

    def test_all_three_real_lifecycles_satisfy_structure(self):
        for attempt in (1,2,3):
            l=json.loads((HERE.parent/f'evidence/t010-native-evidence-security-hardening/native-d1-attempt{attempt}-lifecycle.json').read_text())
            v=contract.Verdict();contract.check_lifecycle(v,l,attempt)
            self.assertEqual(v.failures,[])
            v=contract.Verdict();contract.check_lifecycle(v,l,attempt+1)
            self.assertTrue(v.failures)

    def test_exit_schema_exact_integer(self):
        good={'schema':contract.SCHEMA,'status':'PASS','failures':[],'categories':[]}
        for value in (float(contract.SCHEMA),2.0,'2',True,False,None,0,99):
            self.assertNotEqual(contract.exit_code(dict(good,schema=value),0),0)
        self.assertEqual(contract.exit_code(good,0),0)

    def test_v2_does_not_claim_v3(self):
        verdict=GenuineEvidence().verdict(2,1,manifest=3)
        self.assertIn('dependency-manifest',verdict['categories'])
        self.assertEqual(GenuineEvidence().verdict(2,1)['schema'],2)



# Independent copies of the v2 anchor (t010-d1-trust-anchor-v2/candidate-identity.json), approved 2026-10-28.
WASM_V2 = '97a575093aab7fde6400e3ce2a1c3ec243de28645f49ce27a55286ca8dff37e2'
TRUSTED_V2 = {'rhwp_bg.wasm': WASM_V2, 'rhwp.js': '37cea466d25ecbd12c5586cdeddada1c97aa4fd45860e857160e12e83e668e5d',
              'rhwp.d.ts': '9d46972b79edcf09c9d87e732cd5c91ea4bfded79457639162b0c7d6e7530cb1',
              'ENGINE.json': '14d223fff35ec9eb6b9e2764229684b8ba2fd2b2c48a92ea4aa1953173424212'}
ANCHOR_V2 = 'tests/integration/rhwp/evidence/t010-d1-trust-anchor-v2/'


class AnchorV2(unittest.TestCase):
    """v4 = the strict v3 contract with only the trust anchor, its engine gates and the wrapper path replaced."""
    def test_v4_manifest_replaces_only_gates_and_wrapper(self):
        v3, v4 = contract.DEPENDENCY_MANIFESTS[3], contract.DEPENDENCY_MANIFESTS[4]
        old = 'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/'
        expected = [ANCHOR_V2 + 'engine-gates/' + n[len(old):] if n.startswith(old)
                    else ANCHOR_V2 + 'run-native.py' if n == 'tests/integration/rhwp/evidence/t010-native-evidence-final-integrity/run-native.py' else n
                    for n in v3]
        self.assertEqual(list(v4), expected)
        self.assertEqual(sum(a != b for a, b in zip(v3, v4)), 4)
        self.assertEqual(contract.NATIVE_WRAPPERS[4], ANCHOR_V2 + 'run-native.py')
        root = HERE.parents[3]
        for name in v4:
            if '/' in name and not name.startswith('tree:'):
                self.assertTrue((root / name).is_file(), name)

    def test_v2_anchor_bytes_and_preserved_v1_anchor(self):
        root = HERE.parents[3]
        self.assertEqual(contract.TRUST_ANCHOR, contract.TRUST_ANCHORS[4])
        self.assertEqual(contract.TRUST_ANCHORS[4]['path'], ANCHOR_V2 + 'candidate-identity.json')
        data = (root / contract.TRUST_ANCHORS[4]['path']).read_bytes()
        self.assertEqual(contract.trust_anchor_from_bytes(data, 4), TRUSTED_V2)
        with self.assertRaises(ValueError):
            contract.trust_anchor_from_bytes(data.replace(WASM_V2.encode(), OTHER.encode()), 4)
        with self.assertRaises(ValueError):  # the old anchor bytes are not the v4 anchor
            contract.trust_anchor_from_bytes((root / contract.TRUST_ANCHORS[3]['path']).read_bytes(), 4)
        self.assertEqual(contract.TRUST_ANCHORS[3]['sha256'], '1699dfbe6d51409c1b7f852c838e1ab37bb3b27be7efe6fbf3dd70eda8048271')
        self.assertEqual(contract.trust_anchor_from_bytes((root / contract.TRUST_ANCHORS[3]['path']).read_bytes(), 3), TRUSTED)

    def v4(self, **kwargs):
        deps = {name: TRUSTED_V2.get(name, {path: contract.FIXTURE_SHA256[sample] for sample, path in contract.PINNED_FIXTURES.items()}.get(name, format(i + 1, '064x')))
                for i, name in enumerate(contract.DEPENDENCY_MANIFESTS[4])}
        result = complete_result(); result['engineIdentity']['wasmSha256'] = WASM_V2
        args = dict(result=result, deps=deps, deps_after=dict(deps), wasm_before=WASM_V2, wasm_after=WASM_V2, expected=WASM_V2, trusted=TRUSTED_V2, manifest=4)
        args.update(kwargs)
        return run(**args)

    def test_complete_v4_run_passes_and_records_v2_anchor(self):
        verdict = self.v4()
        self.assertEqual(verdict['status'], 'PASS', verdict['failures'])
        self.assertEqual((verdict['schema'], verdict['dependencyManifest'], verdict['trustAnchor']), (3, 4, contract.TRUST_ANCHORS[4]))

    def test_v4_rejects_old_candidate_and_v3_dependency_set(self):
        self.assertIn('candidate-identity', self.v4(expected=WASM, wasm_before=WASM, wasm_after=WASM)['categories'])
        self.assertIn('dependency-manifest', self.v4(deps=complete_dependencies(3), deps_after=complete_dependencies(3))['categories'])


if __name__ == '__main__':
    unittest.main()
