"""Post-launch evidence failures, without starting a native application."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('hardened_runner', HERE / 'run-current-perf.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class EvidenceFailures(unittest.TestCase):
    def decode(self, data, stage):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'producer.json'
            if data is not None:
                output.write_bytes(data)
            errors = []
            self.assertIsNone(runner.producer_result(output, errors))
            self.assertEqual(errors[0]['stage'], stage)
            if data is not None:
                self.assertEqual(output.read_bytes(), data)

    def test_missing(self):
        self.decode(None, 'producer-missing')

    def test_truncated(self):
        self.decode(b'{"measurementComplete":', 'producer-json')

    def test_invalid_json(self):
        self.decode(b'not json', 'producer-json')

    def test_invalid_utf8(self):
        self.decode(b'\xff', 'producer-json')

    def test_duplicate_keys_and_nonfinite_json(self):
        for data in [b'{"status":"FAIL","status":"PASS"}', b'{"value":NaN}']:
            with self.subTest(data=data):
                self.decode(data, 'producer-json')

    def test_structure(self):
        for data in [b'[]', b'null', b'1', b'{}', b'{"status":"PASS","measurementComplete":1}']:
            with self.subTest(data=data):
                self.decode(data, 'producer-structure')

    def test_read_permission(self):
        errors = []
        output = Mock()
        output.read_bytes.side_effect = PermissionError('controlled permission error')
        self.assertIsNone(runner.producer_result(output, errors))
        self.assertEqual(errors[0]['stage'], 'producer-read')

    def test_digest_failure_still_records_available_producer_and_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            output, record = [Path(directory) / name for name in ('producer.json', 'execution.json')]
            output.write_text('{"status":"FAIL","measurementComplete":false,"measurements":{"perf":[]},"gates":[]}')
            errors = []
            digest = Mock(side_effect=OSError('controlled dependency error'))
            producer, after = runner.final_evidence(output, {'source': 'known'}, digest, errors)
            self.assertEqual(producer['status'], 'FAIL')
            self.assertIsNone(after)
            self.assertEqual(errors[0]['stage'], 'dependency-digest')
            runner.write_record(record, {'verdict': 'FAIL', 'inputsBefore': {'source': 'known'}, 'errors': errors})
            self.assertIn('dependency-digest', record.read_text())
            previous = record.read_bytes()
            with self.assertRaises(FileExistsError), patch('sys.stderr'):
                runner.write_record(record, {'verdict': 'PASS'})
            self.assertEqual(record.read_bytes(), previous)

    def test_missing_and_digest_errors_both_survive(self):
        errors = []
        output = Mock()
        output.read_bytes.side_effect = FileNotFoundError('controlled missing output')
        runner.final_evidence(output, {}, Mock(side_effect=OSError('digest')), errors)
        self.assertEqual([e['stage'] for e in errors], ['producer-missing', 'dependency-digest'])

    def test_cleanup_wait_failure_is_recorded(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        process.wait.side_effect = ChildProcessError('controlled wait error')
        errors = []
        with patch.object(runner.os, 'killpg'):
            runner.cleanup_process('native', process, [], errors)
        self.assertEqual(errors[0]['stage'], 'cleanup-native')

    def test_cleanup_termination_failure_is_recorded(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        errors = []
        with patch.object(runner.os, 'killpg', side_effect=PermissionError('controlled termination error')):
            runner.cleanup_process('native', process, [], errors)
        self.assertEqual(errors[0]['stage'], 'cleanup-native')

    def test_forced_kill_is_retained(self):
        process = Mock(pid=12345)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired('controlled', 10), 0]
        forced, errors = [], []
        with patch.object(runner.os, 'killpg') as kill:
            runner.cleanup_process('native', process, forced, errors)
        self.assertEqual(forced, ['native'])
        self.assertEqual(kill.call_count, 2)
        self.assertEqual(errors, [])

    def test_observer_failure_is_recorded(self):
        proc = Mock()
        proc.iterdir.side_effect = PermissionError('controlled observer error')
        errors = []
        runner.observe_marker(b'marker', {}, errors, proc)
        self.assertEqual(errors[0]['stage'], 'observer')

    def test_incomplete_pass_is_rejected(self):
        self.decode(b'{"status":"PASS","measurementComplete":true,"measurements":{"perf":[]},"gates":[]}', 'producer-structure')

    def test_unexpected_postprocessing_error_still_allows_digest_and_record(self):
        output = Mock()
        output.read_bytes.side_effect = RuntimeError('controlled unexpected postprocess error')
        errors = []
        producer, after = runner.final_evidence(output, {'a': 1}, lambda: {'a': 1}, errors)
        self.assertIsNone(producer)
        self.assertEqual(after, {'a': 1})
        self.assertEqual(errors[0]['stage'], 'producer-postprocess')

    def test_successful_decode(self):
        output = Mock()
        output.read_bytes.return_value = b'{"status":"FAIL","measurementComplete":false,"measurements":{"perf":[]},"gates":[]}'
        errors = []
        producer, after = runner.final_evidence(output, {'a': 1}, lambda: {'a': 1}, errors)
        self.assertFalse(producer['measurementComplete'])
        self.assertEqual(after, {'a': 1})
        self.assertEqual(errors, [])


class MainFailureRecording(unittest.TestCase):
    """Exercise the actual main/finally path with controlled process objects."""
    def exercise(self, *, wait_error=False, observer_error=False, digest_error=False):
        import contextlib
        import json
        import time
        attempt = time.time_ns()
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            here = Path(directory)
            output = here / f'native-d4-off-attempt{attempt}.json'
            partial = b'{"truncated":'
            vite, native = Mock(pid=12345), Mock(pid=12346)
            vite.poll.return_value = native.poll.return_value = None
            def finish_native(**kwargs):
                output.write_bytes(partial)
                if wait_error:
                    raise ChildProcessError('controlled parent wait')
                return 1
            native.wait.side_effect = finish_native
            thread = Mock()
            thread.is_alive.return_value = observer_error
            response = Mock(status=200)
            response.__enter__ = Mock(return_value=response)
            response.__exit__ = Mock(return_value=False)
            calls = 0
            def tree(*args):
                nonlocal calls
                calls += 1
                if digest_error and calls > 2:
                    raise OSError('controlled after-launch digest')
                return 'tree'
            check_output = lambda args, **kwargs: b'{"artifacts":{"fake":"digest"}}' if 'show' in args else 'source-commit\n'
            for target, value in [
                ('HERE', here), ('sha', lambda p: 'digest'),
            ]:
                stack.enter_context(patch.object(runner, target, value))
            stack.enter_context(patch.object(runner.sys, 'argv', ['runner', '--candidate', str(here), '--preparation', 'off', '--attempt', str(attempt)]))
            stack.enter_context(patch.object(runner.identity, 'pinned_samples_valid', return_value=True))
            stack.enter_context(patch.object(runner.identity, 'FIXTURE_SHA256', {name: 'digest' for name in runner.identity.SAMPLES}))
            stack.enter_context(patch.object(runner.identity, 'tree_digest', side_effect=tree))
            stack.enter_context(patch.object(runner.subprocess, 'check_output', side_effect=check_output))
            stack.enter_context(patch.object(runner.subprocess, 'run'))
            # Native processes and digests are mocked; installed binaries are not prerequisites.
            stack.enter_context(patch.object(runner.Path, 'is_file', return_value=True))
            stack.enter_context(patch.object(runner.subprocess, 'Popen', side_effect=[vite, native]))
            stack.enter_context(patch.object(runner.urllib.request, 'urlopen', return_value=response))
            stack.enter_context(patch.object(runner.threading, 'Thread', return_value=thread))
            stack.enter_context(patch.object(runner, 'observe_marker'))
            stack.enter_context(patch.object(runner.time, 'sleep'))
            stack.enter_context(patch.object(runner.os, 'killpg'))
            stack.enter_context(patch('builtins.print'))
            try:
                self.assertEqual(runner.main(), 1)
                record = json.loads((here / f'native-d4-off-attempt{attempt}-execution.json').read_text())
                self.assertEqual(record['verdict'], 'FAIL')
                self.assertFalse(record['measurementComplete'])
                self.assertEqual(record['sourceCommit'], 'source-commit')
                self.assertEqual(output.read_bytes(), partial)
                stages = [e['stage'] for e in record['processCleanup']['postLaunchErrors']]
                self.assertIn('producer-json', stages)
                if wait_error:
                    self.assertIn('process-wait', stages)
                    self.assertIn('ChildProcessError', record['error'])
                if observer_error:
                    self.assertIn('observer-join', stages)
                if digest_error:
                    self.assertIn('dependency-digest', stages)
                    self.assertIsNone(record['inputsAfter'])
            finally:
                for label in ['vite', 'producer']:
                    Path(f'/tmp/geul-native-d4-off-attempt{attempt}-{label}.log').unlink(missing_ok=True)

    def test_actual_finally_records_wait_and_partial_json_errors(self):
        self.exercise(wait_error=True)

    def test_actual_finally_records_observer_join_error(self):
        self.exercise(observer_error=True)

    def test_actual_finally_records_dependency_digest_error(self):
        self.exercise(digest_error=True)


if __name__ == '__main__':
    unittest.main()
