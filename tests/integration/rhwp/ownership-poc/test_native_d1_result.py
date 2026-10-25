"""Fail-closed native D1 wrapper verdict (native_d1_result.validate): one complete PASS, each invariant broken once."""
import copy
import importlib.util
from pathlib import Path
import unittest

import native_d1_result as contract

HERE = Path(__file__).resolve().parent
WASM = 'ca5c0b8443230ba719c07f4d8c835a94fb6e12eb4b50a7123ce5c8b6a8048d45'
OTHER = '0' * 64
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
            'teardown': [{'sessionDeletes': [{'outcome': 'ok', 'seconds': 0.2}], 'complete': True, 'driverExit': 0, 'driverKilled': False,
                          'beforeDriverStop': [], 'afterDriverStop': [], 'remainingAfterWait': [], 'sigtermSent': [], 'sigtermErrors': [],
                          'survivorsAfterSigterm': []}]}


def complete_lifecycle():
    return {'schema': 2, 'samples': 900, 'observerError': None, 'observerStopped': True, 'leftAtEnd': [],
            'processes': [{'pid': 20, 'comm': 'tauri-driver', 'gone': 80.1}, {'pid': 22, 'comm': 'geul', 'gone': 80.1},
                          {'pid': 23, 'comm': 'WebKitWebProces', 'gone': 80.3}]}


def run(result=None, *, missing=False, error=None, harness_exit=0, lifecycle=None, deps=None, deps_after=None,
        wasm_before=WASM, wasm_after=WASM, expected=WASM, evidence_errors=()):
    deps = {'rhwp_bg.wasm': WASM, 'tests/e2e/tauri_smoke.py': '1' * 64} if deps is None else deps
    return contract.validate(harness_exit=harness_exit, result=None if missing or error else (complete_result() if result is None else result),
                             result_error='missing' if missing else error, expected_wasm=expected, candidate_wasm_before=wasm_before,
                             candidate_wasm_after=wasm_after, dependencies_before=deps, dependencies_after=deps if deps_after is None else deps_after,
                             lifecycle=complete_lifecycle() if lifecycle is None else lifecycle, evidence_errors=evidence_errors)


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
        self.failing(run(deps_after={'rhwp_bg.wasm': WASM, 'tests/e2e/tauri_smoke.py': '2' * 64}), 'dependency-mutation')
        self.failing(run(deps={}), 'dependency-mutation')

    def test_exit0_candidate_identity_mismatch(self):
        self.failing(run(mutated(lambda r: r['engineIdentity'].update(wasmSha256=OTHER))), 'candidate-identity')
        self.failing(run(wasm_after=OTHER), 'candidate-identity')
        self.failing(run(wasm_before=OTHER), 'candidate-identity')
        self.failing(run(deps={'rhwp_bg.wasm': OTHER}), 'candidate-identity')

    def test_expected_identity_cannot_come_from_the_result(self):
        # Every self-reported identity agrees with a wrong expectation; the expectation itself is checked against bytes.
        verdict = self.failing(run(mutated(lambda r: r['engineIdentity'].update(wasmSha256=OTHER)), expected=OTHER), 'candidate-identity')
        self.assertTrue(any('bytes' in f['invariant'] for f in verdict['failures']))

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
        self.failing(run(mutated(lambda r: r.pop('teardown'))), 'cleanup')
        self.failing(run(mutated(lambda r: r.update(teardown=[]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(sessionDeletes=[{'outcome': 'driverLost'}]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(sessionDeletes=[]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(remainingAfterWait=[{'pid': 5, 'comm': 'geul'}]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(sigtermSent=[5]))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(driverExit=None))), 'cleanup')
        self.failing(run(mutated(lambda r: r['teardown'][0].update(complete=False))), 'cleanup')

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
        self.assertEqual(contract.validate(harness_exit=0, result=complete_result(), result_error=None, expected_wasm=WASM,
                                           candidate_wasm_before=WASM, candidate_wasm_after=WASM, dependencies_before={'rhwp_bg.wasm': WASM},
                                           dependencies_after={'rhwp_bg.wasm': WASM}, lifecycle=None)['categories'], ['evidence-write'])

    def test_categories_stay_separate(self):
        verdict = run(mutated(lambda r: r['cleanup'].update(driverStopped=False)), harness_exit=1, deps_after={'rhwp_bg.wasm': OTHER})
        self.assertEqual(verdict['categories'], ['cleanup', 'dependency-mutation', 'native-subprocess'])

    def test_input_is_not_modified(self):
        result = complete_result(); snapshot = copy.deepcopy(result)
        run(result)
        self.assertEqual(result, snapshot)



class GenuineEvidence(unittest.TestCase):
    """The real native runs recorded by the corrected wrapper pass; one flipped cleanup step in them fails."""
    EVIDENCE = HERE.parents[0] / 'evidence' / 't010-readiness-residual-stabilization'

    def verdict(self, attempt, change=None):
        import json
        result = json.loads((self.EVIDENCE / f'native-d1-attempt{attempt}.json').read_text())
        lifecycle = json.loads((self.EVIDENCE / f'native-d1-attempt{attempt}-lifecycle.json').read_text())
        if change: change(result)
        deps = result['executedDependencySha256']
        return contract.validate(harness_exit=result['parentExit'], result=result, result_error=None, expected_wasm=WASM,
                                 candidate_wasm_before=WASM, candidate_wasm_after=WASM, dependencies_before=deps,
                                 dependencies_after=deps if result['executedDependenciesStable'] is True else {}, lifecycle=lifecycle)

    def test_recorded_runs_pass_and_match_their_wrapper_verdict(self):
        import json
        for attempt in (1, 2, 3):
            recorded = json.loads((self.EVIDENCE / f'native-d1-attempt{attempt}-wrapper-verdict.json').read_text())
            self.assertEqual((recorded['verdict']['status'], recorded['harnessExit']), ('PASS', 0))
            self.assertEqual(self.verdict(attempt)['status'], 'PASS', self.verdict(attempt)['failures'])

    def test_recorded_run_with_one_cleanup_step_false_fails(self):
        verdict = self.verdict(1, lambda r: r['cleanup'].update(driverStopped=False))
        self.assertEqual(verdict['categories'], ['cleanup'])


if __name__ == '__main__':
    unittest.main()
