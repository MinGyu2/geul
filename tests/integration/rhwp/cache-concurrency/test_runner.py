"""Failure-injection checks for the browser runner's completion contract (no actual browser required)."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent

spec = importlib.util.spec_from_file_location('cache_browser_runner', HERE / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def valid_result():
    image = {'bytes': 0, 'entries': 0, 'pendingEntries': 0}
    pending = {'status': 'PASS', 'requests': 100, **{k: {'images': dict(image)} for k in
        ('during', 'reduced', 'trimmedWhilePending', 'afterClosedCallbacks', 'afterFinalTrim')}}
    return {'schema': 1, 'status': 'PASS', 'pending': pending,
        'concurrent': {'status': 'PASS', 'loadAttempts': 2, 'notifications': 2, 'pixelMismatchCount': 0},
        'historical': {'status': 'PASS', 'draws': 50, 'candidate': {'results': {str(i): {} for i in range(12)}}},
        'formats': [{'format': f, 'status': 'PASS', 'pixelMismatchCount': 0} for f in ('hwp', 'hwpx')]}


class ResultValidation(unittest.TestCase):
    def test_valid_complete(self):
        runner.validate_result(valid_result())

    def test_pass_with_pending_fail(self):
        v = valid_result(); v['pending']['status'] = 'FAIL'
        with self.assertRaisesRegex(RuntimeError, 'contradicts'): runner.validate_result(v)

    def test_pass_with_concurrent_fail(self):
        v = valid_result(); v['concurrent']['status'] = 'FAIL'
        with self.assertRaisesRegex(RuntimeError, 'contradicts'): runner.validate_result(v)

    def test_pass_with_format_fail(self):
        v = valid_result(); v['formats'][0]['status'] = 'FAIL'
        with self.assertRaisesRegex(RuntimeError, 'contradicts'): runner.validate_result(v)

    def test_missing_measurement(self):
        v = valid_result(); del v['concurrent']['pixelMismatchCount']
        with self.assertRaisesRegex(RuntimeError, 'measurement'): runner.validate_result(v)

    def test_invalid_completion(self):
        v = valid_result(); v['status'] = 'PENDING'
        with self.assertRaisesRegex(RuntimeError, 'completion'): runner.validate_result(v)

    def test_incomplete_browser_result(self):
        v = valid_result(); del v['pending']['afterFinalTrim']
        with self.assertRaisesRegex(RuntimeError, 'measurement'): runner.validate_result(v)


    def test_missing_mandatory_ownership(self):
        with self.assertRaisesRegex(RuntimeError, 'ownership gate'):
            runner.validate_result(valid_result(), require_ownership=True)

    def test_ownership_missing_measurement(self):
        v = valid_result(); v['ownership'] = {'status': 'PASS', 'tests': [{'status': 'PASS'}], 'checkpoints': [{'jobs': {}}]}
        with self.assertRaisesRegex(RuntimeError, 'measurement'):
            runner.validate_result(v, require_ownership=True)

    def test_ownership_subordinate_failure(self):
        v = valid_result()
        fields = ('pendingCount', 'inFlightEstimatedBytes', 'readyLeaseCount', 'transientEstimatedBytes',
                  'ownedEstimatedBytes', 'activeLeaseEstimatedBytes', 'temporaryCanvasBytes',
                  'peakTemporaryCanvasBytes', 'loadAttempts', 'completionNotifications', 'retryCount',
                  'cancellations', 'errors', 'resourceLimits', 'maxOwnedBytes', 'maxPending', 'maxResources', 'maxFrameBytes',
                      'backupImageDataBytes', 'peakBackupImageDataBytes', 'peakStagingBytes', 'maxStagingBytes')
        v['ownership'] = {'status': 'PASS', 'tests': [{'status': 'FAIL'}], 'checkpoints': [{'jobs': dict.fromkeys(fields, 0)}]}
        with self.assertRaisesRegex(RuntimeError, 'contradicts'):
            runner.validate_result(v, require_ownership=True)

    def test_measurement_over_budget_despite_all_pass(self):
        v = valid_result()
        fields = ('pendingCount', 'inFlightEstimatedBytes', 'readyLeaseCount', 'transientEstimatedBytes',
                  'ownedEstimatedBytes', 'activeLeaseEstimatedBytes', 'temporaryCanvasBytes',
                  'peakTemporaryCanvasBytes', 'loadAttempts', 'completionNotifications', 'retryCount',
                  'cancellations', 'errors', 'resourceLimits', 'maxOwnedBytes', 'maxPending', 'maxResources', 'maxFrameBytes',
                      'backupImageDataBytes', 'peakBackupImageDataBytes', 'peakStagingBytes', 'maxStagingBytes')
        job = dict.fromkeys(fields, 0); job['ownedEstimatedBytes'] = 1
        v['ownership'] = {'status': 'PASS', 'tests': [{'status': 'PASS'}], 'checkpoints': [{'jobs': job}]}
        with self.assertRaisesRegex(RuntimeError, 'violates'):
            runner.validate_result(v, require_ownership=True)



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

    def test_duplicate_completion(self):
        value = valid_result()
        body = ('url=sys.argv[-1].replace("index.html", "result")\n'
                'value=' + repr(value) + '\n'
                'for _ in range(2):\n'
                ' request=urllib.request.Request(url,data=json.dumps(value).encode(),method="POST")\n'
                ' urllib.request.urlopen(request).read()\n'
                'time.sleep(2)\n')
        self.assertIn('duplicate', self.probe(body, 2))

    def test_timeout_without_result_is_failure(self):
        self.assertIn('timed out', self.probe('time.sleep(3)\n', 0.2))


if __name__ == '__main__':
    unittest.main()

class SchedulerValidation(unittest.TestCase):
    def value(self):
        v = valid_result()
        names = ['count-saturation-admits', 'bytes-saturation-admits',
            'cache-only-transition-established', 'cache-only-release-without-destruction',
            'cache-only-notification-progress', 'cache-only-repeated-terminal-cancel-bounded', 'cache-only-final-cleanup', 'cache-only-no-decode-wait-capacity-notification',
            'shared-byte-demand-established', 'shared-byte-cancel-no-false-capacity', 'shared-byte-cleanup', 'shared-byte-partial-release-no-false-capacity', 'active-saturation-waits-without-publication', 'active-owner-release-progress', 'intrinsic-active-byte-limit-explicit', 'resident-eviction-during-shared-draw', 'shared-resident-close-one-preserves-pixels'] + [
            'notification-progress-' + k for k in ('cancel-one', 'cancel-both', 'dispose', 'replace',
            'mutate', 'shared-owner', 'complete', 'error', 'budget', 'trim', 'competition', 'deadline')]
        job = {'uniqueResourceCount': 0, 'activeLeaseCount': 0, 'capacityNotifications': 0,
               'listenerNotifications': 0, 'pendingCount': 0, 'ownedEstimatedBytes': 0, 'activeJobs': 0, 'maxResources': 256, 'maxPending': 2, 'maxOwnedBytes': 256 << 20}
        v['scheduler'] = {'status': 'PASS', 'tests': [{'name': n, 'status': 'PASS'} for n in names],
                          'checkpoints': [{'jobs': job}]}
        return v

    def test_scheduler_valid(self):
        runner.validate_result(self.value(), require_scheduler=True)

    def test_scheduler_missing(self):
        with self.assertRaisesRegex(RuntimeError, 'missing mandatory scheduler'):
            runner.validate_result(valid_result(), require_scheduler=True)

    def test_scheduler_subtest_fail(self):
        v = self.value(); v['scheduler']['tests'][0]['status'] = 'FAIL'
        with self.assertRaisesRegex(RuntimeError, 'contradicts'): runner.validate_result(v)

    def test_scheduler_incomplete(self):
        v = self.value(); v['scheduler']['tests'].pop()
        with self.assertRaisesRegex(RuntimeError, 'incomplete scheduler'): runner.validate_result(v)

    def test_scheduler_resource_overflow(self):
        v = self.value(); v['scheduler']['checkpoints'][0]['jobs']['uniqueResourceCount'] = 257
        with self.assertRaisesRegex(RuntimeError, 'resource limit'): runner.validate_result(v)

    def test_scheduler_complete_with_pending(self):
        v = self.value(); v['scheduler']['tests'][0].update(completion='COMPLETE', requiredPendingCount=1)
        with self.assertRaisesRegex(RuntimeError, 'publication'): runner.validate_result(v)

    def test_scheduler_notification_storm(self):
        v = self.value(); v['scheduler']['tests'][0]['notifications'] = 100
        with self.assertRaisesRegex(RuntimeError, 'notification'): runner.validate_result(v)

    def test_scheduler_wrong_pixels(self):
        v = self.value(); v['scheduler']['tests'][0]['pixelMismatchCount'] = 1
        with self.assertRaisesRegex(RuntimeError, 'pixel'): runner.validate_result(v)

    def test_scheduler_missing_measurement(self):
        v = self.value(); del v['scheduler']['checkpoints'][0]['jobs']['capacityNotifications']
        with self.assertRaisesRegex(RuntimeError, 'measurements'): runner.validate_result(v, require_scheduler=True)

    def test_scheduler_declared_limits_cannot_be_relaxed(self):
        v = self.value(); v['scheduler']['checkpoints'][0]['jobs']['maxResources'] = 1000
        with self.assertRaisesRegex(RuntimeError, 'declared limits'): runner.validate_result(v, require_scheduler=True)
