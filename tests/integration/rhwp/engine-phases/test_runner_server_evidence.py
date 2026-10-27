"""Server lifecycle and evidence serialization failure paths.

Scenarios that could block run in a child interpreter in its own session with a hard deadline; on timeout only
that child's process group is killed. No real browser, rhwp submodule or network beyond 127.0.0.1.
"""
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.request

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('engine_phase_runner_fixtures', HERE/'test_runner_failures.py')
fixtures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fixtures)
runner = fixtures.runner
CHILD_DEADLINE = 60


def sockets():
    return sum(os.readlink(f'/proc/self/fd/{fd}').startswith('socket:') for fd in os.listdir('/proc/self/fd')
               if os.path.exists(f'/proc/self/fd/{fd}'))


def scenario(name):
    """Child side: run one scenario and print a JSON summary as the last line."""
    tc = fixtures.RunnerLifecycleTests('test_positive_complete_matrix'); tc.setUp()
    before = sockets(); out = {}
    stall = {'on': False}
    real_handle = runner.ThreadingHTTPServer.handle_request
    def blocking_handle(self):
        if stall['on']: time.sleep(3600)
        return real_handle(self)
    real_encode = runner.encode_evidence
    def inject_unserializable(result):
        result['injectedUnserializable'] = object()
        return real_encode(result)
    patches = {
        'thread-constructor': [mock.patch.object(runner.threading, 'Thread', side_effect=RuntimeError('injected Thread() failure'))],
        'thread-start': [mock.patch.object(runner.threading.Thread, 'start', side_effect=RuntimeError('injected start() failure'))],
        'bind': [mock.patch.object(runner, 'ThreadingHTTPServer', side_effect=OSError(98, 'Address already in use'))],
        'loop-exits-early': [mock.patch.object(runner.ThreadingHTTPServer, 'handle_request', side_effect=RuntimeError('injected loop failure'))],
        'close-exception': [mock.patch.object(runner.ThreadingHTTPServer, 'server_close', side_effect=OSError(9, 'injected close failure'))],
        'surrogate-fail': [], 'surrogate-complete': [], 'unserializable': [mock.patch.object(runner, 'encode_evidence', side_effect=inject_unserializable)],
    }
    if name == 'surrogate-fail': tc.write_payload(b'{"status": "FAIL", "error": "\\ud800 \xed\x95\x9c"}')
    if name == 'surrogate-complete':
        value = fixtures.valid_payload(); value['note'] = '\ud800 low \udc00 한글 \U0001d11e'
        tc.write_payload(json.dumps(value, ensure_ascii=True).encode())
    if name in ('server-stop-timeout', 'server-normal', 'server-partial'):
        with mock.patch.multiple(runner, SERVER_STOP_TIMEOUT=1):
            server = runner.LocalServer(runner.BaseHTTPRequestHandler)
            if name == 'server-partial':
                with mock.patch.object(runner.threading.Thread, 'start', side_effect=RuntimeError('injected start() failure')):
                    try: server.start()
                    except RuntimeError as error: out['startError'] = str(error)
            else:
                with mock.patch.object(runner.ThreadingHTTPServer, 'handle_request', blocking_handle):
                    port = server.start()
                    try: urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=5)
                    except urllib.error.HTTPError as error: out['httpStatus'] = error.code
                    stall['on'] = name == 'server-stop-timeout'
                    time.sleep(.2)  # let the loop enter the stalled call
            started = time.monotonic()
            for attempt in range(2):
                try: server.stop(); out[f'stop{attempt}'] = 'ok'
                except RuntimeError as error: out[f'stop{attempt}'] = 'error: '+str(error)
            out['stopSeconds'] = round(time.monotonic()-started, 2)
            out['record'] = server.record; out['socketFd'] = server.server.socket.fileno()
        out['socketsLeaked'] = sockets()-before - (0 if out['socketFd'] == -1 else 1)
    else:
        argv = ['--baseline', str(tc.root/'baseline'), '--phase', str(tc.root/'phase'), '--chrome', str(tc.browser),
                '--fixtures', str(tc.root/'fixtures'), '--samples', str(tc.root/'samples'), '--output', str(tc.output)]
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {**tc.env, 'GEUL_FAKE_MODE': 'ok'}), mock.patch.object(sys, 'stderr', stderr), \
             mock.patch.multiple(runner, RESULT_TIMEOUT=4, TERM_TIMEOUT=1, KILL_TIMEOUT=3, METADATA_TIMEOUT=5):
            for patch in patches[name]: patch.start()
            try: out['code'] = runner.main(argv)
            finally:
                for patch in patches[name]: patch.stop()
        raw = tc.output.read_bytes() if tc.output.exists() else None
        out['written'] = raw is not None; out['stderr'] = stderr.getvalue()[:2000]
        if raw is not None:
            value = json.loads(raw.decode('utf-8')); out['result'] = value
            out['utf8Valid'] = True; out['rawHasEscapedSurrogate'] = b'\\ud800' in raw
        out['pending'] = [p.name for p in tc.output.parent.glob('*.pending')]
        out['socketsLeaked'] = sockets()-before
        if name == 'surrogate-complete': out['expectedNote'] = value['note'] == '\ud800 low \udc00 한글 \U0001d11e'
    tc.tearDown()
    print('RESULT '+json.dumps(out, ensure_ascii=True))


def run_child(name):
    process = subprocess.Popen([sys.executable, '-I', __file__, '--scenario', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, text=True)
    try: stdout, stderr = process.communicate(timeout=CHILD_DEADLINE)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL); process.communicate()
        raise AssertionError(f'{name}: child exceeded {CHILD_DEADLINE}s deadline (blocked)')
    lines = [line for line in stdout.splitlines() if line.startswith('RESULT ')]
    if process.returncode != 0 or not lines: raise AssertionError(f'{name}: child exit {process.returncode}\n{stderr[-3000:]}')
    return json.loads(lines[-1][7:])


class ServerLifecycleTests(unittest.TestCase):
    def assert_startup_failure(self, out, created, thread_started):
        self.assertEqual(out['code'], 1); self.assertTrue(out['written']); self.assertEqual(out['pending'], [])
        result = out['result']; attempt = result['attempt']; server = attempt['server']
        self.assertEqual(result['status'], 'FAIL'); self.assertFalse(attempt['validDiagnosticEvidence'])
        self.assertEqual(attempt['failures'][0]['stage'], 'server-start'); self.assertIsNone(attempt['browserProcess'])
        self.assertEqual((server['created'], server['threadStarted'], server['started']), (created, thread_started, False))
        self.assertEqual(server['socketClosed'], created); self.assertEqual(out['socketsLeaked'], 0)
        return attempt

    def test_thread_constructor_failure(self):
        attempt = self.assert_startup_failure(run_child('thread-constructor'), True, False)
        self.assertFalse(attempt['server']['threadCreated']); self.assertIn('Thread()', attempt['failures'][0]['message'])

    def test_thread_start_failure_does_not_block_cleanup(self):
        attempt = self.assert_startup_failure(run_child('thread-start'), True, False)
        self.assertTrue(attempt['server']['threadCreated']); self.assertIsNone(attempt['server']['threadJoined'])

    def test_bind_failure_before_thread(self):
        attempt = self.assert_startup_failure(run_child('bind'), False, False)
        self.assertFalse(attempt['server']['shutdown']); self.assertEqual(attempt['failures'][0]['type'], 'OSError')

    def test_loop_exiting_before_readiness(self):
        attempt = self.assert_startup_failure(run_child('loop-exits-early'), True, True)
        categories = [f['category'] for f in attempt['failures']]
        self.assertIn('server-cleanup', categories); self.assertIn('injected loop failure', attempt['server']['loopError'])

    def test_server_close_exception_still_releases_browser_and_profile(self):
        out = run_child('close-exception'); attempt = out['result']['attempt']
        self.assertEqual(out['code'], 1); self.assertEqual(out['result']['status'], 'FAIL')
        self.assertIn('server-cleanup', [f['category'] for f in attempt['failures']])
        self.assertFalse(attempt['server']['socketClosed']); self.assertFalse(attempt['server']['shutdown'])
        self.assertTrue(attempt['browserProcess']['cleanupSucceeded']); self.assertTrue(attempt['profileRemoved'])

    def test_stop_after_partial_startup_and_twice(self):
        out = run_child('server-partial')
        self.assertEqual((out['stop0'], out['stop1']), ('ok', 'ok')); self.assertEqual(out['socketFd'], -1)
        self.assertEqual((out['record']['threadStarted'], out['record']['stopRequested'], out['record']['shutdown']), (False, False, True))
        self.assertEqual(out['socketsLeaked'], 0)

    def test_normal_start_stop_is_idempotent(self):
        out = run_child('server-normal')
        self.assertEqual(out['httpStatus'], 501)  # bare handler: proves the loop served a request
        self.assertEqual((out['stop0'], out['stop1']), ('ok', 'ok')); self.assertLess(out['stopSeconds'], 1)
        self.assertTrue(out['record']['threadJoined'] and out['record']['shutdown']); self.assertEqual(out['socketsLeaked'], 0)

    def test_stalled_loop_is_bounded_and_reported(self):
        out = run_child('server-stop-timeout')
        self.assertTrue(out['stop0'].startswith('error: server thread still running'))
        self.assertLess(out['stopSeconds'], 5); self.assertFalse(out['record']['threadJoined']); self.assertFalse(out['record']['shutdown'])
        self.assertTrue(out['record']['socketClosed'])


class RunnerSerializationTests(unittest.TestCase):
    def test_surrogate_in_failed_browser_result_is_persisted(self):
        out = run_child('surrogate-fail'); result = out['result']
        self.assertEqual(out['code'], 1); self.assertEqual(result['status'], 'FAIL'); self.assertTrue(out['rawHasEscapedSurrogate'])
        self.assertEqual(result['error'], '\ud800 한'); self.assertEqual(result['attempt']['evidenceEncoding'], 'ascii-escaped')
        self.assertEqual(out['pending'], [])

    def test_surrogate_in_complete_result_keeps_success_and_value(self):
        out = run_child('surrogate-complete')
        self.assertEqual((out['code'], out['result']['status']), (0, 'DIAGNOSTIC_COMPLETE')); self.assertTrue(out['expectedNote'])

    def test_unserializable_value_writes_labelled_minimal_record(self):
        out = run_child('unserializable'); result = out['result']
        self.assertEqual(out['code'], 3); self.assertEqual(result['status'], 'FAIL'); self.assertFalse(result['validDiagnosticEvidence'])
        self.assertIn('TypeError', result['evidenceSerializationError']); self.assertEqual(result['originalStatus'], 'DIAGNOSTIC_COMPLETE')
        self.assertIn('EVIDENCE_SERIALIZATION_FAILED', out['stderr']); self.assertNotIn('EVIDENCE_PERSISTENCE_FAILED', out['stderr'])


class EncodeAndPersistTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.dir = Path(self.tmp.name); self.output = self.dir/'result.json'

    def tearDown(self):
        os.chmod(self.dir, 0o700); self.tmp.cleanup()

    def round_trip(self, value, encoding):
        data, used, error = runner.encode_evidence(value)
        self.assertEqual((used, error), (encoding, None))
        self.assertEqual(json.loads(data.decode('utf-8')), value)
        return data

    def test_unicode_values_round_trip_exactly(self):
        self.round_trip({'error': '\ud800'}, 'ascii-escaped')
        self.round_trip({'error': '\udc00'}, 'ascii-escaped')
        self.assertIn('\U0001d11e'.encode(), self.round_trip({'error': '\U0001d11e'}, 'utf-8'))
        self.assertIn('연구노트'.encode(), self.round_trip({'sample': '연구노트(화학).hwp'}, 'utf-8'))
        self.round_trip({'rows': [{'a': ['x', {'b': '\ud83d 한 \ude00'}]}], '한': '\U0001f600'}, 'ascii-escaped')

    def test_attempt_records_the_encoding_used(self):
        value = {'status': 'FAIL', 'attempt': {'attemptId': 'x'}, 'e': '\ud800'}
        data, used, _ = runner.encode_evidence(value)
        self.assertEqual((used, json.loads(data)['attempt']['evidenceEncoding']), ('ascii-escaped', 'ascii-escaped'))

    def test_unserializable_and_nan_fail_predictably(self):
        for bad in [object(), float('nan'), {1j}]:
            data, used, error = runner.encode_evidence({'status': 'DIAGNOSTIC_COMPLETE', 'attempt': {'attemptId': 'a', 'failures': []}, 'x': bad})
            value = json.loads(data.decode('utf-8'))
            self.assertEqual((used, value['status'], value['originalStatus'], value['attemptId']), ('fallback', 'FAIL', 'DIAGNOSTIC_COMPLETE', 'a'))
            self.assertIsInstance(error, (TypeError, ValueError))

    def persist(self, attempt='a1'):
        data, _, _ = runner.encode_evidence({'status': 'FAIL', 'text': '한글 \ud800'})
        with mock.patch('sys.stderr', new_callable=io.StringIO) as stderr:
            written = runner.persist(self.output, data, attempt)
        return written, stderr.getvalue(), data

    def test_inaccessible_directory(self):
        if os.geteuid() == 0: self.skipTest('root ignores directory permissions')
        os.chmod(self.dir, 0o500)
        written, stderr, data = self.persist()
        self.assertIsNone(written); self.assertIn('EVIDENCE_PERSISTENCE_FAILED PermissionError', stderr); self.assertIn(data.decode(), stderr)

    def test_disk_full_and_write_failure_remove_only_own_pending(self):
        for target in ['fsync', 'write']:
            with self.subTest(target=target):
                real_open = open
                class Failing:
                    def __init__(self, *args): self.f = real_open(*args)
                    def __enter__(self): return self
                    def __exit__(self, *exc): self.f.close()
                    def write(self, data): raise OSError(28, 'No space left on device')
                    def flush(self): self.f.flush()
                    def fileno(self): return self.f.fileno()
                patch = mock.patch.object(runner.os, 'fsync', side_effect=OSError(28, 'No space left on device')) if target == 'fsync' \
                    else mock.patch('builtins.open', Failing)
                with patch: written, stderr, data = self.persist()
                self.assertIsNone(written); self.assertIn('No space left', stderr)
                self.assertEqual(list(self.dir.iterdir()), []); self.assertIn(json.loads(data)['text'], json.loads(stderr.split('\n', 1)[1]).values())

    def test_existing_target_is_not_replaced(self):
        self.output.write_text('previous\n')
        written, stderr, data = self.persist()
        self.assertEqual(self.output.read_text(), 'previous\n'); self.assertEqual(written.name, 'result.json.a1.pending')
        self.assertEqual(written.read_bytes(), data); self.assertIn('FileExistsError', stderr)

    def test_unrelated_pending_is_kept(self):
        other = self.dir/'result.json.a1.pending'; other.write_text('other attempt\n')
        written, stderr, _ = self.persist()
        self.assertIsNone(written); self.assertEqual(other.read_text(), 'other attempt\n'); self.assertFalse(self.output.exists())

    def test_hard_link_failure_keeps_pending(self):
        with mock.patch.object(runner.os, 'link', side_effect=OSError(18, 'Invalid cross-device link')):
            written, stderr, data = self.persist()
        self.assertEqual(written.read_bytes(), data); self.assertFalse(self.output.exists()); self.assertIn('record kept at', stderr)

    def test_successful_persist_is_valid_utf8_json(self):
        written, stderr, data = self.persist()
        self.assertEqual((written, stderr), (self.output, '')); self.assertEqual(json.loads(self.output.read_bytes().decode('utf-8'))['text'], '한글 \ud800')
        self.assertEqual(list(self.dir.glob('*.pending')), [])


if __name__ == '__main__':
    if sys.argv[1:2] == ['--scenario']: scenario(sys.argv[2])
    else: unittest.main()
