"""Runner lifecycle failure paths with controlled fake browsers; no real browser or rhwp submodule."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from unittest import mock

_spec = importlib.util.spec_from_file_location('engine_phase_runner_lifecycle', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)

ARMS = ['baseline', 'off', 'on']

# Fake browser: behaviour chosen by GEUL_FAKE_MODE; payload read from GEUL_FAKE_PAYLOAD.
FAKE = textwrap.dedent('''\
    import json, os, signal, subprocess, sys, time, urllib.request
    mode = os.environ['GEUL_FAKE_MODE']
    if '--version' in sys.argv:
        if mode == 'metadata-fail': sys.exit(7)
        print('FakeBrowser 1.0'); sys.exit(0)
    url = sys.argv[-1]
    def post(body):
        request = urllib.request.Request(url+'/result', data=body, method='POST', headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(request, timeout=10).close()
    def children():
        with open(os.environ['GEUL_FAKE_PIDS'], 'w') as f:
            same = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])
            alone = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)
            f.write(json.dumps([same.pid, alone.pid]))
    payload = open(os.environ['GEUL_FAKE_PAYLOAD'], 'rb').read()
    if mode == 'exit-early': sys.exit(3)
    if mode == 'self-kill': os.kill(os.getpid(), signal.SIGKILL)
    if mode in ('hang', 'orphans'):
        if mode == 'orphans': children()
        time.sleep(600)
    if mode == 'tamper': open(os.environ['GEUL_FAKE_TAMPER'], 'ab').write(b'changed')
    if mode == 'ignore-term': signal.signal(signal.SIGTERM, signal.SIG_IGN)
    post(payload)
    if mode == 'duplicate': post(payload)
    time.sleep(600)
''')


def valid_payload():
    rows = []
    for sample, pages in [('basic-ko.hwp', [0]), ('basic-ko.hwpx', [0]),
                          ('chemical.hwp', [0, 14, 15, 16, 19, 20, 21, 23]), ('asset.hwpx', [0])]:
        for page in pages:
            for trial in range(3):
                arm = {'outcome': 'COMPLETE', 'traceComplete': True, 'dropped': 0, 'polls': 1,
                       'ms': 1, 'queueMs': 0, 'afterPublicationRaf1Ms': 1, 'afterPublicationRaf2Ms': 1}
                row = {'sample': sample, 'page': page, 'trial': trial, 'exactRGBA': True,
                       'armOrder': ARMS[trial:] + ARMS[:trial], 'arms': {k: copy.deepcopy(arm) for k in ARMS}}
                row['arms']['on']['phases'] = [{'id': 1, 'parent': None, 'name': 'poll.total', 'at': 0, 'ms': 1,
                    'context': dict(sample=sample, page=page, trial=trial, arm='on')}]
                rows.append(row)
    cleanup = {'jobs': dict(activeJobs=0, activeLeaseCount=0, ownedEstimatedBytes=0),
               'cache': {'decoded': {'bytes': 0}, 'images': {'bytes': 0}}}
    return {'status': 'DIAGNOSTIC_COMPLETE', 'official': False, 'rows': rows, 'cleanup': {k: copy.deepcopy(cleanup) for k in ARMS}}


def alive(pid):
    try: state = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
    except OSError: return False
    return state != 'Z'


class RunnerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        for name in ['baseline', 'phase', 'fixtures', 'samples/rnote', 'samples/issue6031', 'out']: (root/name).mkdir(parents=True)
        for f in ['baseline/rhwp.js', 'phase/rhwp.js', 'fixtures/basic-ko.hwp', 'fixtures/basic-ko.hwpx',
                  'samples/rnote/연구노트(화학).hwp', 'samples/issue6031/3249937_asset_management_rules.hwpx']:
            (root/f).write_bytes(b'fixture '+f.encode())
        self.browser = root/'fake-browser'; self.browser.write_text('#!'+sys.executable+'\n'+FAKE); self.browser.chmod(0o755)
        self.payload = root/'payload.json'; self.write_payload(valid_payload())
        self.root = root; self.output = root/'out/result.json'
        constants = mock.patch.multiple(runner, RESULT_TIMEOUT=4, TERM_TIMEOUT=1, KILL_TIMEOUT=3, METADATA_TIMEOUT=5)
        constants.start(); self.addCleanup(constants.stop)
        self.env = {'GEUL_FAKE_PAYLOAD': str(self.payload), 'GEUL_FAKE_PIDS': str(root/'pids.json'),
                    'GEUL_FAKE_TAMPER': str(root/'baseline/rhwp.js')}

    def tearDown(self):
        pids = self.root/'pids.json'
        if pids.exists():
            for pid in json.loads(pids.read_text()):
                try: os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
        self.tmp.cleanup()

    def write_payload(self, value):
        self.payload.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())

    def run_mode(self, mode, browser=None):
        argv = ['--baseline', str(self.root/'baseline'), '--phase', str(self.root/'phase'), '--chrome', str(browser or self.browser),
                '--fixtures', str(self.root/'fixtures'), '--samples', str(self.root/'samples'), '--output', str(self.output)]
        with mock.patch.dict(os.environ, {**self.env, 'GEUL_FAKE_MODE': mode}), mock.patch('sys.stdout'):
            code = runner.main(argv)
        try: result = json.loads(self.output.read_text())
        except (OSError, ValueError): result = None
        return code, result

    def assert_failed(self, code, result, category):
        self.assertNotEqual(code, 0)
        self.assertEqual(result['status'], 'FAIL')
        self.assertFalse(result['attempt']['validDiagnosticEvidence'])
        self.assertIn(category, [f['category'] for f in result['attempt']['failures']], result['attempt']['failures'])
        self.assertTrue(result['attempt']['server']['shutdown'])
        self.assertEqual(list(self.output.parent.glob('*.pending')), [])
        process = result['attempt']['browserProcess']
        if process: self.assertFalse(alive(process['pid']))

    def test_positive_complete_matrix(self):
        code, result = self.run_mode('ok')
        self.assertEqual((code, result['status']), (0, 'DIAGNOSTIC_COMPLETE'))
        process = result['attempt']['browserProcess']
        self.assertTrue(process['cleanupSucceeded'] and process['gracefulExit'] and process['terminateAttempted'])
        self.assertEqual((process['exitSignal'], process['survivors']), (signal.SIGTERM, []))
        self.assertTrue(result['executedDependenciesStable']); self.assertEqual(result['browserVersion'], 'FakeBrowser 1.0')
        runner.validate(result)

    def test_01_browser_executable_missing(self):
        with mock.patch.object(runner.subprocess, 'Popen', side_effect=FileNotFoundError(2, 'No such file')):
            code, result = self.run_mode('ok')
        self.assert_failed(code, result, 'launch')
        self.assertIsNone(result['attempt']['browserProcess']); self.assertIsNone(result['browserExitAfterStop'])
        self.assertEqual(result['browserReportedStatus'], 'UNAVAILABLE')

    def test_01b_missing_launcher_is_preflight_without_attempt(self):
        with self.assertRaises(SystemExit) as stop, mock.patch('sys.stderr'):
            self.run_mode('ok', browser=self.root/'absent')
        self.assertEqual(stop.exception.code, 2); self.assertFalse(self.output.exists())

    def test_02_permission_denied_launch(self):
        self.browser.chmod(0o644)
        code, result = self.run_mode('ok')
        self.assert_failed(code, result, 'launch')
        self.assertEqual(result['attempt']['failures'][0]['type'], 'PermissionError')

    def test_03_browser_exits_before_reporting(self):
        code, result = self.run_mode('exit-early')
        self.assert_failed(code, result, 'browser-result')
        self.assertEqual(result['attempt']['browserProcess']['exitCode'], 3)
        self.assertTrue(result['attempt']['browserProcess']['leaderExitedBeforeStop'])

    def test_04_browser_never_returns(self):
        code, result = self.run_mode('hang')
        self.assert_failed(code, result, 'browser-result')
        self.assertEqual(result['attempt']['failures'][0]['type'], 'TimeoutError')

    def test_05_malformed_result_json(self):
        for body in [b'{not json', b'[1, 2]']:
            with self.subTest(body=body):
                self.output.unlink(missing_ok=True); self.write_payload(body)
                code, result = self.run_mode('ok')
                self.assert_failed(code, result, 'browser-result' if body.startswith(b'{') else 'validation')

    def test_06_duplicate_submission(self):
        code, result = self.run_mode('duplicate')
        self.assert_failed(code, result, 'validation'); self.assertEqual(result['attempt']['receivedResultCount'], 2)
        self.assertEqual(len(result['rows']), 33)

    def test_07_08_09_invalid_matrix_preserves_partial_rows(self):
        for name, mutate in [('missing-row', lambda v: v['rows'].pop()),
                             ('rgba', lambda v: v['rows'][0].update(exactRGBA=False)),
                             ('trace', lambda v: v['rows'][0]['arms']['on'].update(traceComplete=False))]:
            with self.subTest(name=name):
                self.output.unlink(missing_ok=True); value = valid_payload(); mutate(value); self.write_payload(value)
                code, result = self.run_mode('ok')
                self.assert_failed(code, result, 'validation')
                self.assertEqual(result['browserReportedStatus'], 'DIAGNOSTIC_COMPLETE')
                self.assertEqual(result['rows'], value['rows'])

    def test_10_termination_timeout_escalates_to_kill(self):
        code, result = self.run_mode('ignore-term')
        self.assert_failed(code, result, 'browser-cleanup')
        process = result['attempt']['browserProcess']
        self.assertTrue(process['killAttempted']); self.assertEqual(process['exitSignal'], signal.SIGKILL)
        self.assertFalse(process['gracefulExit']); self.assertTrue(process['cleanupSucceeded'])

    def test_11_forced_termination_before_report(self):
        code, result = self.run_mode('self-kill')
        self.assert_failed(code, result, 'browser-result')
        self.assertEqual(result['attempt']['browserProcess']['exitSignal'], signal.SIGKILL)

    def test_11b_unreaped_leader_is_cleanup_failure(self):
        real = subprocess.Popen.wait
        def wait(self, timeout=None):
            if timeout is not None: raise subprocess.TimeoutExpired(self.args, timeout)
            return real(self)
        with mock.patch.object(runner.subprocess.Popen, 'wait', wait):
            code, result = self.run_mode('ok')
        process = result['attempt']['browserProcess']
        try:
            self.assertNotEqual(code, 0); self.assertEqual(result['status'], 'FAIL')
            self.assertFalse(process['reaped'] or process['cleanupSucceeded'])
            self.assertIsNone(process['exitCode']); self.assertIsNone(process['exitSignal'])
        finally:
            try: os.waitpid(process['pid'], 0)
            except ChildProcessError: pass  # already reaped when the Popen object was collected

    def test_12_unexpected_cleanup_exception_releases_other_resources(self):
        with mock.patch.object(runner.Browser, 'stop', side_effect=RuntimeError('injected cleanup fault')):
            code, result = self.run_mode('ok')
        pid = result['attempt']['browserProcess']['pid']
        try:
            self.assertNotEqual(code, 0); self.assertEqual(result['status'], 'FAIL')
            self.assertIn('browser-cleanup', [f['category'] for f in result['attempt']['failures']])
            self.assertTrue(result['attempt']['server']['shutdown']); self.assertTrue(result['attempt']['profileRemoved'])
            self.assertFalse(result['attempt']['browserProcess']['cleanupSucceeded'])
        finally:
            os.killpg(pid, signal.SIGKILL); os.waitpid(pid, 0)

    def test_12b_owned_descendants_including_setsid_are_released(self):
        bystander = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'], start_new_session=True)
        try:
            code, result = self.run_mode('orphans')
            self.assert_failed(code, result, 'browser-result')
            for pid in json.loads((self.root/'pids.json').read_text()): self.assertFalse(alive(pid), pid)
            self.assertTrue(alive(bystander.pid))
            self.assertEqual(result['attempt']['browserProcess']['survivors'], [])
        finally: bystander.kill(); bystander.wait()

    def test_13_dependency_changed_during_execution(self):
        code, result = self.run_mode('tamper')
        self.assert_failed(code, result, 'dependency-recheck'); self.assertIs(result['executedDependenciesStable'], False)

    def test_14_browser_metadata_failure(self):
        code, result = self.run_mode('metadata-fail')
        self.assert_failed(code, result, 'metadata'); self.assertIsNone(result['browserVersion'])
        self.assertTrue(result['attempt']['validated'])

    def test_15_existing_output_is_preserved(self):
        self.output.write_text('previous evidence\n')
        with self.assertRaises(SystemExit) as stop, mock.patch('sys.stderr'): self.run_mode('ok')
        self.assertEqual(stop.exception.code, 2); self.assertEqual(self.output.read_text(), 'previous evidence\n')

    def test_15b_output_created_during_attempt_is_not_replaced(self):
        real = runner.persist
        def racing(output, result, attempt_id):
            output.write_text('concurrent evidence\n'); return real(output, result, attempt_id)
        with mock.patch.object(runner, 'persist', racing), mock.patch('sys.stderr'):
            code, _ = self.run_mode('ok')
        self.assertEqual(code, 3); self.assertEqual(self.output.read_text(), 'concurrent evidence\n')
        kept = list(self.output.parent.glob('*.pending')); self.assertEqual(len(kept), 1)
        self.assertEqual(json.loads(kept[0].read_text())['status'], 'DIAGNOSTIC_COMPLETE')

    def test_16_persistence_failure_is_reported(self):
        def broken(*args, **kwargs): raise OSError(28, 'No space left on device')
        with mock.patch('builtins.open', broken), mock.patch('sys.stderr') as stderr:
            code, result = self.run_mode('ok')
        self.assertEqual(code, 3); self.assertIsNone(result)
        self.assertEqual(list(self.output.parent.iterdir()), [])
        written = ''.join(call.args[0] for call in stderr.write.call_args_list)
        self.assertIn('EVIDENCE_PERSISTENCE_FAILED', written); self.assertIn('"attemptId"', written)

    def test_16b_unrelated_pending_name_is_not_removed(self):
        with mock.patch.object(runner.uuid, 'uuid4', return_value=mock.Mock(hex='fixed')), mock.patch('sys.stderr'):
            pending = self.output.with_name(self.output.name+'.fixed.pending'); pending.write_text('someone else\n')
            code, result = self.run_mode('ok')
        self.assertEqual(code, 3); self.assertIsNone(result); self.assertEqual(pending.read_text(), 'someone else\n')

if __name__ == '__main__': unittest.main()
