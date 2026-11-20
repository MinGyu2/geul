"""Focused fail-closed checks for HWP caption native acceptance preconditions."""
import copy
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).with_name('native-stage3-hwp-caption-ime-lock.py')
spec = importlib.util.spec_from_file_location('hwp_caption_acceptance', SCRIPT)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class ImeObservations(unittest.TestCase):
    def test_expected_observations_are_accepted(self):
        harness.validate_ime_observations({'revision': '2'}, {'revision': '2', 'synced': 'true'})

    def test_incorrect_or_missing_values_are_rejected(self):
        for status, save in [
            ({'revision': '3'}, {'revision': '2', 'synced': 'true'}),
            ({}, {'revision': '2', 'synced': 'true'}),
            ({'revision': None}, {'revision': '2', 'synced': 'true'}),
            ({'revision': '2'}, {'revision': '1', 'synced': 'true'}),
            ({'revision': '2'}, {'synced': 'true'}),
            ({'revision': '2'}, {'revision': '2', 'synced': 'false'}),
            ({'revision': '2'}, {'revision': '2'}),
            ({'revision': '2'}, {'revision': '2', 'synced': None}),
            ({'revision': '2'}, {'revision': '2', 'synced': True}),
        ]:
            with self.subTest(status=status, save=save), self.assertRaises(ValueError):
                harness.validate_ime_observations(status, save)


class MockDriver:
    def __init__(self, events):
        self.events = events
        self.js_calls = []

    def js(self, script):
        self.js_calls.append(script)
        if script == 'return window.__captionIme':
            return self.events
        return None


class MockAcceptance:
    def __init__(self, events, statuses, save):
        self.d = MockDriver(events)
        self.statuses = list(statuses)
        self.save_result = save
        self.opened = []
        self.calls = []
        self.waits = []

    def open_native(self, fmt, path):
        opened = (fmt, Path(path))
        self.opened.append(opened)
        self.calls.append(('open', *opened))

    def engine(self, name):
        return None

    def status(self, fmt):
        if len(self.statuses) > 1:
            return self.statuses.pop(0)
        return self.statuses[0]

    def settle(self, fmt):
        return None

    def wait(self, script, **kwargs):
        self.waits.append((script, kwargs))

    def type(self, value):
        return None

    def key(self, value):
        return None

    def save(self, fmt):
        return self.save_result


class ExecutePassConditions(unittest.TestCase):
    """Exercise execute() itself with controlled Native driver observations."""

    @staticmethod
    def before_oracle():
        return {
            'shape': {'secIdx': 0, 'paraIdx': 0, 'controlIdx': 2},
            'caret': {'pageIndex': 0, 'x': 100, 'y': 200, 'height': 20},
            'texts': ['그림  '],
            'atnos': [{'id': 1, 'value': '그림 1'}],
            'props': {'width': 1200, 'height': 800, 'locked': False},
            'body': ['본문'],
        }

    @staticmethod
    def valid_events():
        return [
            {'type': 'compositionstart', 'isTrusted': True, 'data': ''},
            {'type': 'compositionupdate', 'isTrusted': True, 'data': 'ㅎ'},
            {'type': 'compositionend', 'isTrusted': True, 'data': '한글'},
        ]

    def run_execute(self, case, *, events=None, statuses=None, save=None,
                    after=None, close_result=True, close_error=None,
                    target_bytes_changed=False, reopened_wait_error=None):
        temp = tempfile.TemporaryDirectory(prefix='geul-caption-execute-test-')
        root = Path(temp.name)
        fixtures = root / 'fixtures'
        out = root / 'out'
        fixtures.mkdir()
        out.mkdir()
        (fixtures / 'fixture.hwp').write_bytes(b'fixture-hwp-bytes')
        (fixtures / 'locked.hwp').write_bytes(b'locked-hwp-bytes')

        if statuses is None:
            statuses = ([{'caret': '@caption/0/0/0', 'revision': '2'}]
                        if case == 'ime' else [
                            {'caret': '0:0:0', 'revision': '0'},
                            {'caret': '0:0:0', 'revision': '0'},
                        ])
        if events is None:
            events = self.valid_events()
        if save is None:
            save = {'state': 'saved', 'revision': '2', 'synced': 'true'}
        before = self.before_oracle()
        after_result = copy.deepcopy(before)
        after_result['texts'] = ['그림  한글']
        if after is not None:
            after_result.update(copy.deepcopy(after))

        driver = MockAcceptance(events, statuses, save)
        close_tab = mock.Mock()
        def close(*args):
            driver.calls.append(('close', *args))
            if close_error is not None:
                raise close_error
            return close_result

        close_tab.side_effect = close
        target = out / (case + '.hwp')
        oracle_calls = []

        def oracle(path):
            oracle_calls.append(Path(path))
            if len(oracle_calls) == 1:
                return copy.deepcopy(before)
            return copy.deepcopy(after_result)

        def sha(path):
            path = Path(path)
            if case == 'locked' and target_bytes_changed and path == target:
                return 'changed-target-bytes'
            return 'same-source-bytes'

        def wait(script, **kwargs):
            driver.waits.append((script, kwargs))
            if reopened_wait_error is not None and len(driver.waits) >= 3:
                raise reopened_wait_error

        driver.wait = wait
        with ExitStack() as patches:
            patches.enter_context(mock.patch.object(harness, 'inspect_caption_fixture',
                                                    side_effect=lambda path, expected: {'locked': expected}))
            patches.enter_context(mock.patch.object(harness.a, 'oracle', side_effect=oracle))
            patches.enter_context(mock.patch.object(harness.a, 'sha', side_effect=sha))
            patches.enter_context(mock.patch.object(harness.p.gso, 'choose'))
            patches.enter_context(mock.patch.object(harness.p, 'pointer'))
            patches.enter_context(mock.patch.object(harness.p.p4.rhwp_poc, 'close_tab', close_tab))
            try:
                result = harness.execute(driver, case, out, fixtures)
                outcome = ('result', result)
            except Exception as error:
                outcome = ('error', error)
        return temp, driver, close_tab, target, oracle_calls, outcome

    def assert_execute_fails(self, case, **kwargs):
        temp, driver, close_tab, target, oracle_calls, outcome = self.run_execute(case, **kwargs)
        try:
            self.assertEqual(outcome[0], 'error', f'execute unexpectedly returned {outcome[1]!r}')
            self.assertIsInstance(outcome[1], Exception)
        finally:
            temp.cleanup()

    def test_ime_success_closes_once_then_reopens_same_document(self):
        temp, driver, close_tab, target, oracle_calls, outcome = self.run_execute('ime')
        try:
            self.assertEqual(outcome[0], 'result', repr(outcome[1]))
            self.assertEqual(outcome[1]['status'], 'PASS')
            self.assertEqual(close_tab.call_count, 1)
            self.assertEqual(close_tab.call_args.args[0], driver.d)
            self.assertEqual(close_tab.call_args.args[1], target.name)
            self.assertEqual(driver.opened, [('hwp', target), ('hwp', target)])
            self.assertEqual(driver.calls, [
                ('open', 'hwp', target),
                ('close', driver.d, target.name),
                ('open', 'hwp', target),
            ])
            self.assertIn('endsWith(\'한글\')', driver.waits[-1][0])
            self.assertTrue(outcome[1]['reopenedInApp'])
        finally:
            temp.cleanup()

    def test_locked_success_refuses_entry_without_mutation(self):
        temp, driver, close_tab, target, oracle_calls, outcome = self.run_execute('locked')
        try:
            self.assertEqual(outcome[0], 'result', repr(outcome[1]))
            self.assertEqual(outcome[1]['status'], 'PASS')
            self.assertEqual(outcome[1]['beforeCaret'], '0:0:0')
            self.assertEqual(outcome[1]['afterCaret'], '0:0:0')
            self.assertEqual(outcome[1]['beforeRevision'], '0')
            self.assertEqual(outcome[1]['afterRevision'], '0')
            self.assertEqual(close_tab.call_count, 0)
            self.assertEqual(driver.opened, [('hwp', target)])
        finally:
            temp.cleanup()

    def test_locked_refusal_conditions_are_mandatory(self):
        cases = [
            ('caption entry', {'statuses': [
                {'caret': '0:0:0', 'revision': '0'},
                {'caret': '@caption/0/0/0', 'revision': '0'},
            ]}),
            ('caret change', {'statuses': [
                {'caret': '0:0:0', 'revision': '0'},
                {'caret': '0:0:1', 'revision': '0'},
            ]}),
            ('revision change after click', {'statuses': [
                {'caret': '0:0:0', 'revision': '0'},
                {'caret': '0:0:0', 'revision': '1'},
            ]}),
            ('revision already changed', {'statuses': [
                {'caret': '0:0:0', 'revision': '1'},
                {'caret': '0:0:0', 'revision': '0'},
            ]}),
            ('target bytes changed', {'target_bytes_changed': True}),
        ]
        for name, kwargs in cases:
            with self.subTest(case=name):
                self.assert_execute_fails('locked', **kwargs)

    def test_ime_trusted_composition_events_are_mandatory(self):
        cases = [
            ('missing compositionstart', [
                {'type': 'compositionend', 'isTrusted': True, 'data': '한글'},
            ]),
            ('untrusted compositionstart', [
                {'type': 'compositionstart', 'isTrusted': False, 'data': ''},
                {'type': 'compositionend', 'isTrusted': True, 'data': '한글'},
            ]),
            ('missing compositionend', [
                {'type': 'compositionstart', 'isTrusted': True, 'data': ''},
            ]),
            ('untrusted compositionend', [
                {'type': 'compositionstart', 'isTrusted': True, 'data': ''},
                {'type': 'compositionend', 'isTrusted': False, 'data': '한글'},
            ]),
            ('empty compositionend', [
                {'type': 'compositionstart', 'isTrusted': True, 'data': ''},
                {'type': 'compositionend', 'isTrusted': True, 'data': ''},
            ]),
        ]
        for name, events in cases:
            with self.subTest(case=name):
                self.assert_execute_fails('ime', events=events)

    def test_ime_input_and_save_revisions_are_mandatory(self):
        cases = [
            ('input revision incorrect', {'statuses': [{'caret': '@caption/0/0/0', 'revision': '3'}]}),
            ('input revision missing', {'statuses': [{'caret': '@caption/0/0/0'}]}),
            ('saved revision incorrect', {'save': {'state': 'saved', 'revision': '1', 'synced': 'true'}}),
            ('saved revision missing', {'save': {'state': 'saved', 'synced': 'true'}}),
            ('save synchronization false', {'save': {'state': 'saved', 'revision': '2', 'synced': 'false'}}),
            ('save synchronization missing', {'save': {'state': 'saved', 'revision': '2'}}),
            ('save state failed', {'save': {'state': 'failed', 'revision': '2', 'synced': 'true'}}),
        ]
        for name, kwargs in cases:
            with self.subTest(case=name):
                self.assert_execute_fails('ime', **kwargs)

    def test_saved_hwp_semantics_are_mandatory(self):
        cases = [
            ('caption text', {'texts': ['wrong caption']}),
            ('automatic numbering', {'atnos': []}),
            ('shape properties', {'props': {'width': 1}}),
            ('body content', {'body': ['changed body']}),
        ]
        for name, changed in cases:
            with self.subTest(case=name):
                self.assert_execute_fails('ime', after=changed)

    def test_close_failure_never_reopens_or_becomes_pass(self):
        for name, kwargs, expected_error in [
            ('false result', {'close_result': False}, ValueError),
            ('raised exception', {'close_error': RuntimeError('close failed')}, RuntimeError),
        ]:
            with self.subTest(case=name):
                temp, driver, close_tab, target, oracle_calls, outcome = self.run_execute('ime', **kwargs)
                try:
                    self.assertEqual(outcome[0], 'error')
                    self.assertIsInstance(outcome[1], expected_error)
                    self.assertEqual(close_tab.call_count, 1)
                    self.assertEqual(driver.opened, [('hwp', target)])
                    self.assertEqual(driver.calls, [
                        ('open', 'hwp', target),
                        ('close', driver.d, target.name),
                    ])
                finally:
                    temp.cleanup()

    def test_reopened_caption_verification_remains_mandatory(self):
        error = RuntimeError('reopen verification failed')
        temp, driver, close_tab, target, oracle_calls, outcome = self.run_execute(
            'ime', reopened_wait_error=error)
        try:
            self.assertEqual(outcome[0], 'error')
            self.assertIs(outcome[1], error)
            self.assertEqual(close_tab.call_count, 1)
            self.assertEqual(driver.opened, [('hwp', target), ('hwp', target)])
        finally:
            temp.cleanup()


class FixturePreflight(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='geul-hwp-lock-test-')
        cls.fixtures = Path(cls.temp.name) / 'fixtures'
        subprocess.run(['node', str(Path(__file__).with_name('stage3-hwp-caption-native-fixtures.cjs')), str(cls.fixtures)],
                       cwd=harness.ROOT, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_actual_serialized_caption_owner_and_lock(self):
        for name, expected in [('fixture.hwp', False), ('locked.hwp', True)]:
            with self.subTest(name=name):
                result = harness.inspect_caption_fixture(self.fixtures / name, expected)
                self.assertEqual((result['section'], result['paragraph'], result['control']), (0, 0, 2))
                self.assertTrue(result['caption'])
                self.assertEqual(result['locked'], expected)
                self.assertEqual(result['attribute'], '0x600a0000' if expected else '0x200a0000')

    def test_unlocked_replacement_refused_before_driver_start(self):
        bad = Path(self.temp.name) / 'bad-fixtures'
        bad.mkdir()
        shutil.copyfile(self.fixtures / 'fixture.hwp', bad / 'fixture.hwp')
        shutil.copyfile(self.fixtures / 'fixture.hwp', bad / 'locked.hwp')
        out = Path(self.temp.name) / 'preflight-out'
        argv = ['acceptance', '--out', str(out), '--fixtures', str(bad), '--xdotool', 'unused', '--ibus', 'unused']
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(harness.p.p4.smoke, 'tauri_driver') as driver:
            with self.assertRaises(ValueError):
                harness.main()
            driver.assert_not_called()

    def test_missing_or_ambiguous_lock_and_owner_rejected(self):
        streams = harness.cfb_streams((self.fixtures / 'locked.hwp').read_bytes())
        rows = harness.records(harness.unpacked(streams, 'BodyText/Section0'))
        target = next(i for i, (tag, level, data) in enumerate(rows) if (tag, level) == (71, 1) and data.startswith(b' osg'))
        broken_header = list(rows)
        broken_header[target] = (71, 1, broken_header[target][2][:6])
        wrong_owner = list(rows)
        wrong_owner[target] = (71, 1, b'bad!' + wrong_owner[target][2][4:])
        missing_list = list(rows)
        missing_list[target + 1] = (72, 2, b'')
        for bad in [broken_header, wrong_owner, missing_list, rows + [rows[target]]]:
            with self.subTest(bad=bad[target][2][:8]), self.assertRaises(ValueError):
                harness.inspect_caption_lock_records(bad, True)
        with self.assertRaises(ValueError):
            harness.inspect_caption_fixture(self.fixtures / 'fixture.hwp', True)
        with self.assertRaises(ValueError):
            harness.inspect_caption_fixture(self.fixtures / 'locked.hwp', False)


if __name__ == '__main__':
    unittest.main()
