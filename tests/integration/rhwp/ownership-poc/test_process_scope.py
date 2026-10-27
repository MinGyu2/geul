"""Hermetic tests for process_scope.Scope (run directly: python3 -I test_process_scope.py).

Each case runs the scope in a separate interpreter so this test process never becomes a subreaper.
Bystanders are started by this test process, outside the scope's tree, and must survive.
"""
import json, os, signal, subprocess, sys, textwrap, time, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable

# A child that forks a setsid grandchild and exits at once: the grandchild is orphaned.
DETACH = textwrap.dedent('''
    import os, signal, sys, time
    r, w = os.pipe(); pid = os.fork()
    if pid == 0:
        os.setsid(); os.close(r)
        if sys.argv[1] == 'ignore': signal.signal(signal.SIGTERM, signal.SIG_IGN)
        os.write(w, str(os.getpid()).encode()); os.close(w); os.close(1); os.close(2); time.sleep(300); os._exit(0)
    os.close(w); print(os.read(r, 32).decode(), flush=True); os._exit(0)
''')

SCOPE = textwrap.dedent('''
    import json, os, subprocess, sys, time
    sys.path.insert(0, sys.argv[1]); import process_scope
    mode, args = sys.argv[2], json.loads(sys.argv[3])
    scope = process_scope.Scope()
    if mode != 'disabled': scope.enable()
    out = {'root': os.getpid()}
    if mode in ('detach', 'disabled', 'ignore'):
        p = subprocess.run([sys.executable, '-I', '-c', args['detach'], 'ignore' if mode == 'ignore' else 'term'], capture_output=True, text=True, timeout=10)
        orphan = int(p.stdout.strip()); out['orphan'] = orphan
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            info = process_scope._stat(orphan)
            if info and info['ppid'] != p.returncode and info['ppid'] != 0 and (mode == 'disabled' or info['ppid'] == os.getpid()): break
            time.sleep(.02)
        info = process_scope._stat(orphan); out['orphanParent'] = info and info['ppid']
        out['inTree'] = orphan in scope.descendants()
    if mode == 'failed':
        p = subprocess.Popen([sys.executable, '-I', '-c', 'import sys; sys.exit(3)']); scope.observe(); p.wait(); out['code'] = p.returncode
        q = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(300)']); out['running'] = q.pid; scope.observe()
    if mode == 'identity':
        q = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(300)']); time.sleep(.1)
        info = process_scope._stat(q.pid); out['signalled'] = scope._signal(q.pid, info['start'] + 1, 15)
        out['aliveAfterMismatch'] = q.poll() is None
        out['skipped'] = list(scope.record['identityMismatchSkipped'])
    if mode == 'bystander':
        out['bystanderInTree'] = args['bystander'] in scope.descendants()
    record = scope.teardown(); again = scope.teardown()
    out['record'] = record; out['idempotent'] = again is record
    print(json.dumps(out))
''')


def run_scope(mode, **args):
    args['detach'] = DETACH
    p = subprocess.run([PY, '-I', '-c', SCOPE, str(HERE), mode, json.dumps(args)], capture_output=True, text=True, timeout=60)
    if p.returncode != 0: raise AssertionError(p.stderr)
    return json.loads(p.stdout)


def alive(pid):
    try: return Path(f'/proc/{pid}/stat').read_text().rpartition(')')[2].split()[0] != 'Z'
    except OSError: return False


class ScopeTest(unittest.TestCase):
    def test_detached_orphan_is_adopted_and_removed(self):
        out = run_scope('detach'); r = out['record']
        self.assertEqual(out['orphanParent'], out['root']); self.assertTrue(out['inTree'])
        self.assertIn(out['orphan'], r['unownedRootChildren']); self.assertIn(out['orphan'], r['terminated'])
        self.assertEqual(r['survivors'], []); self.assertTrue(r['cleanupSucceeded']); self.assertTrue(out['idempotent'])
        self.assertFalse(alive(out['orphan']))

    def test_sigterm_ignoring_descendant_is_killed(self):
        out = run_scope('ignore'); r = out['record']
        self.assertIn(out['orphan'], r['terminated']); self.assertIn(out['orphan'], r['killed'])
        self.assertEqual(r['survivors'], []); self.assertTrue(r['cleanupSucceeded']); self.assertFalse(alive(out['orphan']))

    def test_without_subreaper_orphan_escapes_and_teardown_fails_closed(self):
        out = run_scope('disabled'); r = out['record']
        try:
            # Negative control: the observation-only model loses the orphan from the tree.
            self.assertNotEqual(out['orphanParent'], out['root']); self.assertFalse(out['inTree'])
            self.assertFalse(r['subreaper']); self.assertFalse(r['cleanupSucceeded'])
            self.assertIn('subreaper not enabled', r['errors'])
        finally:
            if alive(out['orphan']):
                fd = os.pidfd_open(out['orphan'])
                try: signal.pidfd_send_signal(fd, signal.SIGKILL)
                finally: os.close(fd)

    def test_failed_and_running_children(self):
        out = run_scope('failed'); r = out['record']
        self.assertEqual(out['code'], 3); self.assertIn(out['running'], r['terminated'])
        self.assertEqual(r['survivors'], []); self.assertTrue(r['cleanupSucceeded'])

    def test_identity_mismatch_is_never_signalled(self):
        out = run_scope('identity')
        self.assertFalse(out['signalled']); self.assertTrue(out['aliveAfterMismatch']); self.assertEqual(len(out['skipped']), 1)
        self.assertTrue(out['record']['cleanupSucceeded'])

    def test_unrelated_bystander_survives(self):
        bystander = subprocess.Popen([PY, '-I', '-c', 'import time; time.sleep(300)'])
        try:
            out = run_scope('bystander', bystander=bystander.pid); r = out['record']
            self.assertFalse(out['bystanderInTree']); self.assertIsNone(bystander.poll())
            for bucket in ('terminated', 'killed', 'adoptedOrphans'): self.assertNotIn(bystander.pid, r[bucket])
            self.assertTrue(r['cleanupSucceeded'])
        finally:
            bystander.kill(); bystander.wait()


if __name__ == '__main__':
    unittest.main(verbosity=2)
