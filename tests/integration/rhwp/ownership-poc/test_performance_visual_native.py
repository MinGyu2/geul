"""Fail-closed acceptance of performance-visual-native.py, driven through main() with fake native tools."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('ownership_performance_visual', Path(__file__).with_name('performance-visual-native.py'))
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
# Independent copy of the official matrix: never derived from the harness or history.LARGE.
FOUR = ['basic-ko.hwp', 'basic-ko.hwpx', '연구노트(화학).hwp', '3249937_asset_management_rules.hwpx']
CHEMICAL = '연구노트(화학).hwp'
LABELS = ('warm', 'typed-10', 'typed-20', 'typed-30', 'undo', 'redo')


class FakeDisplay:
    def __init__(self, *args, **kwargs):
        self.stdout = mock.Mock(readline=lambda: '99\n')
    def terminate(self): pass
    def wait(self, timeout=None): return 0


class FakeNative:
    """Replays a successful native edit/history run; each scenario breaks exactly one contract."""
    def __init__(self, frame=None, caret_missing_after_undo=False):
        self.frame = frame or (lambda index: {'verified': True, 'pixels': 0, 'maxDelta': 0})
        self.caret_missing_after_undo = caret_missing_after_undo
        self.frames = 0; self.undone = False; self.revision = 10; self.sample = None
        self.popen = mock.Mock(side_effect=FakeDisplay); self.ended = 0

    def js(self, script, *args):
        if 'fullFrameCheck' in script:
            self.frames += 1
            return self.frame(self.frames - 1)
        if 'activeLeaseCount' in script: return True
        if 'devicePixelRatio' in script: return 1
        return {}

    def status(self, d):
        empty = self.undone and self.sample == CHEMICAL
        return {'caret': '0:23:0' if empty else '0:3:9', 'paragraphText': '' if empty else 'abab', 'localRevision': str(self.revision), 'pages': '1'}

    def history_key(self, d, key):
        self.undone = key == 'z'; self.revision += 1
        return self.status(d), True

    def wait_until(self, d, script, timeout=None):
        if 'rhwp-caret' in script and self.undone and self.caret_missing_after_undo:
            raise runner.smoke.Failure('caret absent')
        return True

    def open_document(self, d, path, *args):
        self.sample = Path(path).name; self.undone = False

    def run(self, cmd, **kwargs):
        if str(cmd[1]).endswith('tests/fixtures/rhwp/generate.mjs'):
            Path(cmd[2]).mkdir(parents=True, exist_ok=True)
            for name in FOUR[:2]: (Path(cmd[2]) / name).write_bytes(name.encode())
        return subprocess.CompletedProcess(cmd, 0, b'', b'')

    def end_session(self, d): self.ended += 1

    @contextlib.contextmanager
    def tauri_driver(self, *args):
        yield lambda: mock.Mock(js=self.js)

    def execute(self, *argv):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'result.json'
            argv = [f'--{name}=/fake/{name}' for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool')] + ['--output', str(output), *argv]
            patches = [
                mock.patch.object(runner.subprocess, 'Popen', self.popen),
                mock.patch.object(runner.subprocess, 'run', self.run),
                mock.patch.object(runner.subprocess, 'check_output', return_value='7\n'),
                mock.patch.object(runner.smoke, 'tauri_driver', self.tauri_driver),
                mock.patch.object(runner.smoke, 'wait_until', self.wait_until),
                mock.patch.object(runner.smoke, 'end_session', self.end_session),
                mock.patch.object(runner.native_probe, 'install', lambda *a: None),
                mock.patch.object(runner.poc, 'open_document', self.open_document),
                mock.patch.object(runner.poc, 'close_tab', lambda *a: True),
                mock.patch.object(runner.poc, 'set_zoom', lambda *a: None),
                mock.patch.object(runner.poc, 'click_paragraph_start', lambda *a: None),
                mock.patch.object(runner.poc, 'press', lambda *a, **k: None),
                mock.patch.object(runner.poc, 'type_ascii', lambda *a: None),
                mock.patch.object(runner.poc, 'status', self.status),
                mock.patch.object(runner.history, 'caret_page', lambda d: 0),
                mock.patch.object(runner.history, 'stable_digest', lambda *a: None),
                mock.patch.object(runner.history, 'history_key', self.history_key),
                mock.patch.object(runner.history, 'caret_matches_engine', lambda d: True),
                mock.patch.object(runner.history, 'close_discard', lambda *a: None),
                mock.patch('sys.argv', ['performance-visual-native.py', *argv]),
                contextlib.redirect_stderr(io.StringIO()),  # argparse rejection text
            ]
            with contextlib.ExitStack() as stack:
                for patch in patches: stack.enter_context(patch)
                try:
                    code = runner.main()
                except SystemExit as exit:
                    code = exit.code
            return code, json.loads(output.read_text()) if output.exists() else None


class SampleSelection(unittest.TestCase):
    def test_unknown_sample_rejected_before_native_infrastructure(self):
        fake = FakeNative()
        code, result = fake.execute('--sample', 'missing.hwp')
        self.assertNotEqual(code, 0)
        self.assertFalse(fake.popen.called, 'Xvfb must not start for an unknown sample')
        self.assertTrue(result is None or result['status'] != 'PASS')

    def test_empty_sample_name_rejected(self):
        fake = FakeNative()
        code, result = fake.execute('--sample', '')
        self.assertNotEqual(code, 0)
        self.assertFalse(fake.popen.called)
        self.assertTrue(result is None or result['status'] != 'PASS')

    def test_empty_selection_cannot_pass(self):
        # Shape of the observed false PASS: only the two global assertions, zero documents and references.
        tests = [{'name': name, 'status': 'PASS'} for name in ('bootstrap-clean-close', 'native-final-resource-cleanup')]
        verdict = runner.classify({'tests': tests, 'documents': [], 'visualReferences': [], 'historyGates': [], 'historyChecks': [],
                                   'cleanup': dict.fromkeys(runner.CLEANUP_STEPS, True)}, [])
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertEqual(verdict['failures'], ['empty sample selection'])
        self.assertFalse(verdict['pixelReferencesComplete'])

    def test_selection_is_exact_fixture_set(self):
        self.assertEqual(runner.select_samples(None), FOUR)
        self.assertEqual(runner.select_samples(CHEMICAL), [CHEMICAL])

    def test_shared_large_list_cannot_shrink_official_matrix(self):
        saved = list(runner.history.LARGE)
        runner.history.LARGE[:] = saved[:1]
        try:
            spec = importlib.util.spec_from_file_location('reloaded_visual', Path(__file__).with_name('performance-visual-native.py'))
            reloaded = importlib.util.module_from_spec(spec); spec.loader.exec_module(reloaded)
            self.assertEqual(reloaded.select_samples(None), FOUR)
            self.assertEqual(reloaded.required_tests(FOUR), runner.required_tests(FOUR))
            with tempfile.TemporaryDirectory() as folder:
                for name in FOUR[:2]: (Path(folder) / name).write_bytes(b'x')
                self.assertEqual([path.name for path in reloaded.fixture_paths(Path(folder))], FOUR)
        finally:
            runner.history.LARGE[:] = saved

    def test_missing_official_sample_fails_instead_of_shrinking(self):
        with mock.patch.object(runner.history, 'S', Path('/nonexistent-samples')):
            with self.assertRaisesRegex(RuntimeError, 'official fixtures missing'):
                runner.fixture_paths(Path('/nonexistent-generated'))


class Acceptance(unittest.TestCase):
    def test_strict_four_documents_pass(self):
        code, result = FakeNative().execute()
        self.assertEqual((code, result['status']), (0, 'PASS'), result.get('failures'))
        self.assertEqual(len(result['visualReferences']), 24)
        self.assertTrue(result['pixelReferencesComplete'])
        self.assertEqual([row['sample'] for row in result['documents']], FOUR)

    def test_single_document_diagnostic_pass(self):
        code, result = FakeNative().execute('--sample', CHEMICAL)
        self.assertEqual((code, result['status']), (0, 'PASS'), result.get('failures'))
        self.assertEqual([row['name'] for row in result['visualReferences']], [CHEMICAL + '-' + label for label in LABELS])

    def test_missing_references_fail(self):
        verdict = self.verdict(lambda refs: refs.pop())
        self.assertEqual(verdict['status'], 'FAIL'); self.assertFalse(verdict['pixelReferencesComplete'])

    def test_missing_document_fails(self):
        verdict = self.verdict(lambda refs: None, documents=FOUR[:3])
        self.assertEqual(verdict['status'], 'FAIL')

    def test_unverified_reference_fails(self):
        code, result = FakeNative(frame=lambda index: {'verified': False, 'reason': 'extent'} if index == 5 else {'verified': True, 'pixels': 0, 'maxDelta': 0}).execute()
        self.assertEqual(code, 1); self.assertEqual(result['status'], 'FAIL'); self.assertFalse(result['pixelReferencesComplete'])
        verdict = self.verdict(lambda refs: refs[3].update(verified=False))
        self.assertEqual(verdict['status'], 'FAIL')

    def test_pixel_mismatch_fails(self):
        code, result = FakeNative(frame=lambda index: {'verified': True, 'pixels': 3 if index == 7 else 0, 'maxDelta': 9 if index == 7 else 0}).execute()
        self.assertEqual(code, 1); self.assertEqual(result['status'], 'FAIL'); self.assertFalse(result['pixelReferencesComplete'])
        verdict = self.verdict(lambda refs: refs[9].update(pixels=1, maxDelta=1))
        self.assertEqual(verdict['status'], 'FAIL')
        verdict = self.verdict(lambda refs: refs[9].update(pixels=0, maxDelta=5))  # inconsistent row is still a mismatch
        self.assertEqual(verdict['status'], 'FAIL'); self.assertFalse(verdict['pixelReferencesComplete'])

    def test_mandatory_caret_failure_stays_nonzero_with_continuation(self):
        code, result = FakeNative(caret_missing_after_undo=True).execute('--continue-after-caret-failure')
        self.assertEqual(code, 1); self.assertEqual(result['status'], 'FAIL')
        self.assertTrue(result['diagnosticContinuation'])
        self.assertIn('basic-ko.hwp-undo-caret-visible', [row['name'] for row in result['tests'] if row['status'] == 'FAIL'])

    def test_mandatory_caret_failure_strict(self):
        code, result = FakeNative(caret_missing_after_undo=True).execute()
        self.assertEqual(code, 1); self.assertEqual(result['status'], 'FAIL')

    def test_missing_mandatory_assertion_fails(self):
        code, result = FakeNative().execute()
        self.assertEqual(code, 0)
        result['tests'] = [row for row in result['tests'] if row['name'] != CHEMICAL + '-original-empty-paragraph-restored']
        self.assertEqual(runner.classify(result, FOUR)['status'], 'FAIL')

    def test_incomplete_cleanup_fails(self):
        verdict = self.verdict(lambda refs: None, cleanup={'sessionEnded': True, 'driverStopped': True, 'displayTerminated': False})
        self.assertEqual(verdict['status'], 'FAIL')

    def test_failed_history_gate_fails(self):
        verdict = self.verdict(lambda refs: None, gates=[{'gate': 'D1', 'item': 'x', 'result': 'FAIL'}])
        self.assertEqual(verdict['status'], 'FAIL')

    def test_history_evidence_from_another_contract_fails(self):
        # The harness never produces undo_native gates; a passing entry is not evidence for this contract.
        self.assertEqual(self.verdict(lambda refs: None, gates=[{'gate': 'D1', 'item': 'x', 'result': 'PASS'}])['status'], 'FAIL')
        self.assertEqual(self.mutated(lambda r: r.update(historyChecks=['x']))['status'], 'FAIL')
        self.assertEqual(self.mutated(lambda r: r.pop('historyGates'))['status'], 'FAIL')
        verdict = self.verdict(lambda refs: None)
        self.assertEqual(verdict['status'], 'PASS'); self.assertIn('named mandatory assertions', verdict['historyGateContract'])

    def test_duplicate_required_assertion_fails(self):
        verdict = self.mutated(lambda r: r['tests'].insert(4, dict(r['tests'][3])))
        self.assertEqual(verdict['status'], 'FAIL'); self.assertTrue(any('duplicate' in f for f in verdict['failures']))

    def test_unexpected_assertion_fails(self):
        verdict = self.mutated(lambda r: r['tests'].append({'name': 'extra-check', 'status': 'PASS'}))
        self.assertEqual(verdict['status'], 'FAIL'); self.assertTrue(any('unexpected' in f for f in verdict['failures']))

    def test_assertions_out_of_execution_order_fail(self):
        verdict = self.mutated(lambda r: r['tests'].insert(1, r['tests'].pop(5)))
        self.assertEqual(verdict['status'], 'FAIL'); self.assertIn('assertions out of execution order', verdict['failures'])

    def test_missing_max_delta_fails(self):
        self.assertEqual(self.verdict(lambda refs: refs[2].pop('maxDelta'))['status'], 'FAIL')
        code, result = FakeNative(frame=lambda index: {'verified': True, 'pixels': 0}).execute()
        self.assertEqual((code, result['status']), (1, 'FAIL'))

    def test_non_integer_pixel_evidence_fails(self):
        for field, value in (('pixels', False), ('pixels', 0.0), ('pixels', '0'), ('pixels', None), ('pixels', -1),
                             ('maxDelta', False), ('maxDelta', 0.0), ('maxDelta', -1)):
            with self.subTest(field=field, value=value):
                verdict = self.verdict(lambda refs: refs[4].update({field: value}))
                self.assertEqual(verdict['status'], 'FAIL'); self.assertFalse(verdict['pixelReferencesComplete'])

    def test_malformed_reference_rows_fail(self):
        self.assertEqual(self.mutated(lambda r: r['visualReferences'].__setitem__(0, 'ok'))['status'], 'FAIL')
        self.assertEqual(self.mutated(lambda r: r.update(visualReferences={}))['status'], 'FAIL')
        self.assertEqual(self.mutated(lambda r: r['tests'].__setitem__(0, None))['status'], 'FAIL')

    def test_duplicate_or_mislabelled_reference_fails(self):
        self.assertEqual(self.verdict(lambda refs: refs.__setitem__(1, dict(refs[0])))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda refs: refs[7].update(sample=FOUR[0]))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda refs: refs[7].update(name='other'))['status'], 'FAIL')

    def test_engine_row_cannot_override_reference_identity(self):
        spoof = lambda index: {'verified': True, 'pixels': 0, 'maxDelta': 0, 'name': 'spoof', 'sample': 'x', 'frame': 'y'}
        code, result = FakeNative(frame=spoof).execute()
        self.assertEqual((code, result['status']), (0, 'PASS'), result.get('failures'))
        self.assertEqual(result['visualReferences'][0]['name'], 'basic-ko.hwp-warm')

    def mutated(self, change):
        code, result = FakeNative().execute()
        self.assertEqual(code, 0)
        change(result)
        return runner.classify(result, FOUR)

    def verdict(self, change, documents=None, cleanup=None, gates=()):
        # Start from the actual successful run's result and break one field.
        code, result = FakeNative().execute()
        self.assertEqual(code, 0)
        change(result['visualReferences'])
        if documents is not None: result['documents'] = [row for row in result['documents'] if row['sample'] in documents]
        if cleanup is not None: result['cleanup'] = cleanup
        result['historyGates'] = list(gates)
        return runner.classify(result, FOUR)


if __name__ == '__main__':
    unittest.main()
