"""Linux child-subreaper process scope for native T010 harnesses.

The existing engine-phases Browser tracker samples /proc, so a descendant that detached and whose
parent exited between two samples could escape (re-parented to init/systemd). Here the harness
process itself becomes a child subreaper (prctl PR_SET_CHILD_SUBREAPER): an orphaned descendant is
re-parented to the harness instead, so every live descendant stays in the harness process tree until
it is reaped. The tree walk at teardown is therefore complete for processes started after enable(),
which the observation-only tracker could not claim.

Identity is (pid, start ticks from /proc/PID/stat). Signals go through a pidfd opened for that pid
after which the start ticks are re-read; a reused PID is never signalled. Processes outside the tree
(bystanders, the user's own processes) are never enumerated as targets.
"""
import ctypes, errno, os, signal, time
from pathlib import Path

PR_SET_CHILD_SUBREAPER, PR_GET_CHILD_SUBREAPER = 36, 37
TERM_TIMEOUT, KILL_TIMEOUT = 5.0, 5.0


def _stat(pid):
    """(ppid, pgid, sid, start ticks, state, comm) or None if gone/unreadable."""
    try: raw = Path(f'/proc/{pid}/stat').read_text()
    except OSError: return None
    head, _, tail = raw.rpartition(')'); fields = tail.split()
    try: return {'ppid': int(fields[1]), 'pgid': int(fields[2]), 'sid': int(fields[3]),
                 'start': int(fields[19]), 'state': fields[0], 'comm': head.partition('(')[2]}
    except (IndexError, ValueError): return None


def _libc():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    return libc


class Scope:
    """Owns every process descended from this process after enable(). Idempotent teardown()."""

    def __init__(self):
        self.root = os.getpid(); self.enabled = False; self.seen = {}; self.reaped = []
        self.record = {'root': self.root, 'subreaper': False, 'mechanism': 'PR_SET_CHILD_SUBREAPER+pidfd',
                       'observedDescendants': 0, 'adoptedOrphans': [], 'unownedRootChildren': [], 'exitedBeforeTeardown': [],
                       'terminated': [], 'killed': [], 'reapedOrphans': 0, 'survivors': None,
                       'identityMismatchSkipped': [], 'errors': [], 'cleanupSucceeded': False, 'complete': False}

    def enable(self):
        libc = _libc()
        if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'prctl(PR_SET_CHILD_SUBREAPER) failed')
        value = ctypes.c_int(0)
        if libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.cast(ctypes.byref(value), ctypes.c_void_p).value, 0, 0, 0) != 0 or value.value != 1:
            raise OSError(ctypes.get_errno(), 'child subreaper not confirmed')
        self.enabled = self.record['subreaper'] = True
        return self

    def descendants(self):
        """Live (non-zombie) descendants as {pid: stat}. Complete while enabled (no escape route)."""
        table = {}
        for entry in Path('/proc').iterdir():
            if entry.name.isdigit() and (info := _stat(int(entry.name))): table[int(entry.name)] = info
        children = {}
        for pid, info in table.items(): children.setdefault(info['ppid'], []).append(pid)
        out, frontier = {}, [self.root]
        while frontier:
            pid = frontier.pop()
            for child in children.get(pid, []):
                if child not in out: out[child] = table[child]; frontier.append(child)
        return out

    def observe(self):
        for pid, info in self.descendants().items():
            key = (pid, info['start'])
            if key not in self.seen:
                self.seen[key] = {'pid': pid, 'start': info['start'], 'comm': info['comm'], 'pgid': info['pgid'],
                                  'sid': info['sid'], 'firstParent': info['ppid']}
            # Adopted: re-parented to the subreaper root although it was not started by it directly.
            if info['ppid'] == self.root and self.seen[key]['firstParent'] != self.root:
                self.seen[key]['adopted'] = True
        self.record['observedDescendants'] = len(self.seen)

    def _reap_orphans(self, owned_pids):
        """Reap zombie children that the harness did not start through Popen (adopted orphans)."""
        for pid, info in self.descendants().items():
            if info['ppid'] == self.root and info['state'] == 'Z' and pid not in owned_pids:
                try:
                    os.waitpid(pid, os.WNOHANG); self.record['reapedOrphans'] += 1
                except ChildProcessError: pass
                except OSError as error: self.record['errors'].append(f'reap {pid}: {error.errno}')

    def _signal(self, pid, start, sig):
        try: fd = os.pidfd_open(pid)
        except ProcessLookupError: return False
        except OSError as error: self.record['errors'].append(f'pidfd {pid}: {error.errno}'); return False
        try:
            info = _stat(pid)
            if not info or info['start'] != start:
                self.record['identityMismatchSkipped'].append(pid); return False
            signal.pidfd_send_signal(fd, sig); return True
        except ProcessLookupError: return False
        except OSError as error: self.record['errors'].append(f'signal {pid} {int(sig)}: {error.errno}'); return False
        finally: os.close(fd)

    def _live(self, owned_pids):
        return {pid: info for pid, info in self.descendants().items()
                if info['state'] != 'Z' or (info['ppid'] == self.root and pid not in owned_pids)}

    def teardown(self, owned_pids=()):
        """Terminate then kill every remaining descendant; reap adopted zombies. Never raises.

        `owned_pids` are Popen children the caller reaps itself (their zombies are left to Popen).
        """
        r = self.record
        if r['complete']: return r
        owned_pids = set(owned_pids)
        try:
            if not self.enabled: r['errors'].append('subreaper not enabled')
            self.observe()
            r['adoptedOrphans'] = sorted(v['pid'] for v in self.seen.values() if v.get('adopted'))
            r['observed'] = sorted(self.seen.values(), key=lambda v: (v['start'], v['pid']))
            # Children of the root that the caller did not start: adopted orphans whose re-parenting
            # happened before any observation (or unexpected direct children). Both are owned here.
            r['unownedRootChildren'] = sorted(pid for pid, info in self.descendants().items()
                                              if info['ppid'] == self.root and pid not in owned_pids)
            live = self._live(owned_pids)
            r['exitedBeforeTeardown'] = sorted(v['pid'] for (pid, start), v in self.seen.items()
                                                if pid not in live or live[pid]['start'] != start)
            for sig, bucket, timeout in ((signal.SIGTERM, 'terminated', TERM_TIMEOUT), (signal.SIGKILL, 'killed', KILL_TIMEOUT)):
                targets = {pid: info for pid, info in self._live(owned_pids).items() if info['state'] != 'Z'}
                if not targets: break
                for pid, info in targets.items():
                    if self._signal(pid, info['start'], sig): r[bucket].append(pid)
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    self._reap_orphans(owned_pids)
                    if not any(i['state'] != 'Z' for i in self._live(owned_pids).values()): break
                    time.sleep(.05)
            self._reap_orphans(owned_pids)
            survivors = [{'pid': pid, 'comm': info['comm'], 'state': info['state']}
                         for pid, info in self._live(owned_pids).items()]
            r['survivors'] = survivors
        except Exception as error:  # report, never mask an earlier failure
            r['errors'].append('teardown: ' + type(error).__name__ + ': ' + str(error))
        r['complete'] = True
        r['cleanupSucceeded'] = r['subreaper'] and r['survivors'] == [] and not r['errors']
        return r
