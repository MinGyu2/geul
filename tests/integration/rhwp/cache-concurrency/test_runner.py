"""Failure-injection checks for the browser runner's completion contract (no actual browser required)."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class CompletionContract(unittest.TestCase):
    def probe(self, body, timeout):
        with tempfile.TemporaryDirectory() as temporary:
            tmp = Path(temporary)
            package = tmp / 'package'; package.mkdir()
            (package / 'rhwp.js').write_text('// intentionally unused by fake browser\n')
            (package / 'rhwp_bg.wasm').write_bytes(b'\0asm\x01\0\0\0')
            browser = tmp / 'browser'
            browser.write_text('#!' + sys.executable + '\nimport sys,time,json,urllib.request\n'
                               'if "--version" in sys.argv: print("test browser"); sys.exit(0)\n' + body)
            browser.chmod(0o700)
            out = tmp / 'result.json'
            run = subprocess.run([sys.executable, str(HERE / 'run.py'), '--pinned', str(package),
                                  '--candidate', str(package), '--browser', 'chrome', '--chrome', str(browser),
                                  '--timeout', str(timeout), '--output', str(out)], capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 1, run.stderr)
            result = json.loads(out.read_text())
            self.assertEqual(result['status'], 'FAIL')
            return result['error']

    def test_zero_exit_without_result_is_failure(self):
        self.assertIn('before completion', self.probe('sys.exit(0)\n', 2))

    def test_partial_pass_result_is_rejected(self):
        body = ('url=sys.argv[-1].replace("index.html", "result")\n'
                'request=urllib.request.Request(url,data=json.dumps({"schema":1,"status":"PASS"}).encode(),method="POST")\n'
                'urllib.request.urlopen(request).read()\n'
                'time.sleep(2)\n')
        self.assertIn('incomplete historical', self.probe(body, 2))

    def test_timeout_without_result_is_failure(self):
        self.assertIn('timed out', self.probe('time.sleep(3)\n', 0.2))


if __name__ == '__main__':
    unittest.main()
