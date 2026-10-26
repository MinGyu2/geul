"""통제된 producer 시험: 실제 native 승인 증거가 아니다."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('diagnose', HERE / 'diagnose_native.py')
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)
PASS = {'status': 'PASS', 'tests': [{'name': 'smoke', 'status': 'PASS'}], 'visualReferences': [{'verified': True}],
        'cleanup': dict.fromkeys(('sessionEnded', 'driverStopped', 'displayTerminated'), True)}


class DiagnosticTests(unittest.TestCase):
    def execute(self, mode):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / 'attempt'
            class Vite:
                def poll(self): return None
                def terminate(self):
                    if mode == 'cleanup-exception': raise OSError('cleanup failed')
                def wait(self, **kw): return 0
            def producer(*args, **kwargs):
                kwargs['stdout'].write('partial producer evidence\n')
                (out / 'driver.log').write_text('driver evidence\n')
                (out / 'driver.lost.json').write_text('[]')
                if mode == 'exception': raise OSError('diagnostic execution failed')
                result = copy.deepcopy(PASS)
                if mode == 'fail': result['status'] = 'FAIL'
                if mode == 'lifecycle': result['cleanup']['driverStopped'] = False
                if mode == 'lost': (out / 'driver.lost.json').write_text('[{"error":"lost"}]')
                if mode != 'missing-result':
                    (out / 'result.json').write_text('{' if mode == 'invalid' else json.dumps(result))
                if mode == 'missing-output': (out / 'driver.log').unlink()
                return type('Exit', (), {'returncode': 7 if mode == 'nonzero' else 0})()
            response = contextlib.nullcontext(type('Response', (), {'status': 200})())
            env = {k: '/existing-tool' for k in ('GEUL_TAURI_DRIVER', 'GEUL_WEBKIT_DRIVER', 'GEUL_XVFB', 'GEUL_XDOTOOL')}
            with patch.dict(os.environ, env), patch.object(diag.subprocess, 'Popen', return_value=Vite()), \
                    patch.object(diag.subprocess, 'run', side_effect=producer), \
                    patch.object(diag.urllib.request, 'urlopen', return_value=response), contextlib.redirect_stdout(io.StringIO()):
                argv = ['--candidate', tmp, '--gates', tmp, '--label', 'attempt', '--output-dir', tmp]
                code = diag.main(argv)
                summary = json.loads((out / 'summary.json').read_text())
                self.assertEqual(code, 0 if mode == 'pass' else 1)
                self.assertEqual(summary['status'], 'PASS' if mode == 'pass' else 'FAIL')
                self.assertIn('partial producer evidence', (out / 'producer.log').read_text())
                original = {f.name: f.read_bytes() for f in out.iterdir() if f.is_file()}
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    diag.main(argv)
                self.assertEqual(original, {f.name: f.read_bytes() for f in out.iterdir() if f.is_file()})
    def test_launch_failure_preserves_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: '/existing-tool' for k in ('GEUL_TAURI_DRIVER', 'GEUL_WEBKIT_DRIVER', 'GEUL_XVFB', 'GEUL_XDOTOOL')}
            with patch.dict(os.environ, env), patch.object(diag.subprocess, 'Popen', side_effect=OSError('launch failed')), contextlib.redirect_stdout(io.StringIO()):
                code = diag.main(['--candidate', tmp, '--gates', tmp, '--label', 'launch', '--output-dir', tmp])
            self.assertEqual(code, 1)
            out = Path(tmp) / 'launch'
            self.assertEqual(json.loads((out / 'summary.json').read_text())['status'], 'FAIL')
            self.assertTrue((out / 'vite.log').is_file())

    def test_strict_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'result.json'
            for invalid in ('{"status":"PASS","status":"FAIL"}', '{"x":NaN}', '{"x":Infinity}'):
                path.write_text(invalid)
                with self.assertRaises(ValueError): diag.strict_json(path)

    def test_pass(self): self.execute('pass')
    def test_nonzero(self): self.execute('nonzero')
    def test_missing_result(self): self.execute('missing-result')
    def test_invalid_json(self): self.execute('invalid')
    def test_explicit_fail(self): self.execute('fail')
    def test_missing_output(self): self.execute('missing-output')
    def test_execution_exception(self): self.execute('exception')
    def test_cleanup_failure(self): self.execute('lifecycle')
    def test_cleanup_exception(self): self.execute('cleanup-exception')
    def test_driver_lost(self): self.execute('lost')


if __name__ == '__main__': unittest.main()
