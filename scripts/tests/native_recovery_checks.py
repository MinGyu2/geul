"""Independent checks for the T014 native recovery acceptance (native-recovery-crash.py).

Pure standard library; shares no code with geul's Rust/TypeScript validators.
- Controls: RHWP `getControls()` returns JSON text (an array of control objects). It is parsed, schema-checked
  and compared structurally in document order; JSON key order is the only ignored difference.
- HWP PrvText: read as the actual `PrvText` CFB stream (directory entry, FAT/mini-stream chains) with the
  existing independent reader of scripts/tests/verify-hwp-preview.py, then strictly decoded as UTF-16LE.
- Process ownership: Linux pidfd (`os.pidfd_open`, `signal.pidfd_send_signal`). The pidfd is opened for the one
  matching process and its identity (executable, scenario XDG_DATA_HOME, start time) is re-verified after
  opening, so the signal can only reach that process even if the numeric PID is later reused. No fallback to
  `os.kill(pid)`: if pidfd is unavailable the destructive step is blocked.
- Runtime RHWP identity: binds the initialized engine module in the running WebView to a generation, and compares
  that generation's embedded metadata and bytes with the independent Release manifest (Resource Timing does not
  record the tauri: scheme in WebKitGTK, so it is not used).
"""
import importlib.util
import json
import os
from pathlib import Path
import select
import signal

_spec = importlib.util.spec_from_file_location('verify_hwp_preview', Path(__file__).with_name('verify-hwp-preview.py'))
_preview = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_preview)


class CheckError(AssertionError):
    """A required independent check failed (never converted into a pass or an empty default). Always raised
    explicitly, never through an `assert` statement, so it survives `python -O`/PYTHONOPTIMIZE."""


# ---------------- acceptance accounting (independent of `assert`) ----------------

class AcceptanceError(Exception):
    """A required native acceptance step failed. Carries the format, step, observed value and expected
    condition. Raised explicitly, so optimized interpreters (`-O`, PYTHONOPTIMIZE) cannot skip it."""

    def __init__(self, fmt, step, observed=None, expected='condition holds'):
        self.format, self.step, self.observed, self.expected = fmt, step, observed, expected
        text = repr(observed)
        super().__init__(f'[{fmt}] {step}: expected {expected}; observed {text[:2000]}')


def require(ok, fmt, step, observed=None, expected='condition holds'):
    """An unrecorded required condition (setup, helper results)."""
    if not ok:
        raise AcceptanceError(fmt, step, observed, expected)
    return observed


class Steps:
    """Records each required step as PASS or FAIL and stops the scenario at the first FAIL."""

    def __init__(self, entry, fmt):
        self.entry, self.format = entry, fmt
        entry.setdefault('steps', [])

    def __call__(self, name, ok, detail=None, expected='condition holds'):
        passed = bool(ok)
        row = {'step': name, 'status': 'PASS' if passed else 'FAIL'}
        if detail is not None:
            row['detail'] = detail
        if not passed:
            row['expected'] = expected
        self.entry['steps'].append(row)
        if not passed:
            raise AcceptanceError(self.format, name, detail, expected)
        return detail


LAUNCH_PHASES = ('launch1', 'launch2')  # checkpoint crash, then fresh restore


def overall(report, required):
    """Fail closed on incomplete steps and one-to-one launch/teardown evidence.

    Optional named steps may pass, but cannot replace mandatory steps. Each required
    format has two real app launches; PID/start-time identity is captured by pidfd.
    """
    problems = []
    def collection(value, label):
        if not isinstance(value, list):
            problems.append(f'{label}: missing or malformed collection')
            return []
        return value

    if not isinstance(report, dict) or not isinstance(required, dict):
        return 'FAIL', ['malformed report or required-step declaration']
    if not required:
        problems.append('no required formats declared')
    if report.get('error') is not None:
        problems.append(f'error recorded: {report["error"]}')
    entries = {}
    for entry in collection(report.get('formats'), 'formats'):
        if not isinstance(entry, dict) or not isinstance(entry.get('format'), str):
            problems.append('malformed format evidence')
            continue
        fmt = entry['format']
        if fmt in entries:
            problems.append(f'format {fmt} recorded twice')
        if fmt not in required:
            problems.append(f'unexpected format {fmt}')
        entries[fmt] = entry
        recorded = {}
        for row in collection(entry.get('steps'), f'{fmt}: steps'):
            if not isinstance(row, dict) or not isinstance(row.get('step'), str) or not row['step']:
                problems.append(f'{fmt}: malformed step evidence')
                continue
            recorded.setdefault(row['step'], []).append(row.get('status'))
            if row.get('status') != 'PASS':
                problems.append(f'{fmt}: step {row["step"]!r} is {row.get("status")!r}')
        names = required.get(fmt)
        if not isinstance(names, (list, tuple)) or not names or any(not isinstance(n, str) or not n for n in names):
            problems.append(f'{fmt}: no valid required steps declared')
            continue
        if len(set(names)) != len(names):
            problems.append(f'{fmt}: duplicate required-step declaration')
        for name in names:
            count = len(recorded.get(name, []))
            if count != 1:
                problems.append(f'{fmt}: required step {name!r} must occur exactly once (observed {count})')
        if entry.get('status') != 'PASS':
            problems.append(f'{fmt}: scenario did not complete (status {entry.get("status")!r})')
    for fmt in required:
        if fmt not in entries:
            problems.append(f'{fmt}: not run')

    # Stable launch IDs are scoped by format and scenario phase, then bound to
    # the observed app PID/start time and isolated directory, never list position.
    launches = {}
    identities = set()
    expected = {f'{fmt}:{phase}' for fmt in required for phase in LAUNCH_PHASES}
    for launch in collection(report.get('launches'), 'launches'):
        if not isinstance(launch, dict):
            problems.append('malformed launch evidence')
            continue
        lid = launch.get('id')
        if not isinstance(lid, str) or lid not in expected:
            problems.append(f'unexpected launch identity {lid!r}')
            continue
        if lid in launches:
            problems.append(f'duplicate launch evidence {lid}')
        launches[lid] = launch
        pid, start, home = launch.get('pid'), launch.get('startTime'), launch.get('dataHome')
        if (type(pid) is not int or pid <= 0 or type(start) is not int or start <= 0
                or not isinstance(home, str) or not home.startswith('/')):
            problems.append(f'{lid}: incomplete app process identity')
        else:
            identity = (pid, start)
            if identity in identities:
                problems.append(f'{lid}: duplicate app process identity')
            identities.add(identity)
    for lid in sorted(expected - launches.keys()):
        problems.append(f'missing required launch {lid}')
    seen = set()
    teardowns = collection(report.get('teardown'), 'teardown')
    if len(teardowns) != len(expected):
        problems.append(f'teardown count {len(teardowns)} != required launch count {len(expected)}')
    for at, teardown in enumerate(teardowns):
        if not isinstance(teardown, dict):
            problems.append(f'teardown {at}: malformed evidence')
            continue
        lid = teardown.get('launchId')
        if not isinstance(lid, str) or lid not in launches:
            problems.append(f'teardown {at}: no corresponding required launch {lid!r}')
        else:
            if lid in seen:
                problems.append(f'duplicate teardown for {lid}')
            seen.add(lid)
            launch = launches[lid]
            if any(teardown.get(k) != launch.get(k) for k in ('pid', 'startTime', 'dataHome')):
                problems.append(f'teardown {at}: contradictory launch identity {lid}')
        if (teardown.get('complete') is not True
                or teardown.get('remainingAfterWait') != []
                or teardown.get('survivorsAfterSigterm') != []
                or teardown.get('sigtermErrors') != []
                # tauri-driver handles our SIGTERM by exiting 0; app SIGKILL is separate.
                # complete only means collection finished, not that driver shutdown succeeded.
                or teardown.get('driverKilled') is not False
                or type(teardown.get('driverExit')) is not int
                or teardown.get('driverExit') != 0):
            problems.append(f'teardown {at} incomplete or left processes')
    for lid in sorted(expected - seen):
        problems.append(f'missing completed teardown for {lid}')
    return ('FAIL' if problems else 'PASS'), problems


# ---------------- controls ----------------

CONTROL_KEYS = {'ctrlId': str, 'ctrlCh': int, 'userDesc': str, 'list': int, 'para': int, 'pos': int,
                'controlIndex': int, 'props': dict}


def parse_controls(text):
    """`getControls()` JSON text -> list of control objects, or CheckError for anything unexpected."""
    if not isinstance(text, str):
        raise CheckError(f'getControls() did not return JSON text: {type(text).__name__}')
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise CheckError(f'malformed getControls() JSON: {error}') from None
    if not isinstance(value, list):
        raise CheckError('getControls() JSON is not an array')
    for at, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != set(CONTROL_KEYS):
            raise CheckError(f'control {at} has unexpected shape: {sorted(item) if isinstance(item, dict) else type(item).__name__}')
        for key, kind in CONTROL_KEYS.items():
            if not isinstance(item[key], kind) or (kind is int and isinstance(item[key], bool)):
                raise CheckError(f'control {at} field {key} is not {kind.__name__}')
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def compare_controls(expected_text, actual_text):
    """Structural equality in document order. Returns the parsed controls; raises CheckError with the first
    differing control otherwise."""
    expected, actual = parse_controls(expected_text), parse_controls(actual_text)
    if len(expected) != len(actual):
        raise CheckError(f'control count {len(actual)} != {len(expected)}')
    for at, (a, b) in enumerate(zip(expected, actual)):
        if canonical(a) != canonical(b):
            raise CheckError(f'control {at} differs: {canonical(b)} != {canonical(a)}')
    return actual


# ---------------- HWP PrvText ----------------

def prv_text(data):
    """Decoded text of the HWP `PrvText` CFB stream. CheckError if absent or not strict UTF-16LE."""
    try:
        streams = _preview.cfb_streams(data)
    except (AssertionError, IndexError, ValueError, StopIteration) as error:
        raise CheckError(f'unreadable CFB container: {error!r}') from None
    if 'PrvText' not in streams:
        raise CheckError('PrvText stream missing')
    raw = streams['PrvText']
    if len(raw) % 2:
        raise CheckError('PrvText has an odd byte length')
    try:
        text = raw.decode('utf-16-le', errors='strict')
    except UnicodeDecodeError as error:
        raise CheckError(f'PrvText is not valid UTF-16LE: {error}') from None
    if '\x00' in text:
        raise CheckError('PrvText contains NUL code units')
    return text


def check_regenerated_prv_text(original, recovered, marker):
    """The recovered preview is exactly the original preview with the marker typed at the document start
    (the protected revision), read from the actual streams; the source preview lacks the marker."""
    before, after = prv_text(original), prv_text(recovered)
    if marker in before:
        raise CheckError('marker already in the source PrvText')
    if after != marker + before:
        raise CheckError(f'recovered PrvText {after!r} is not the regenerated protected revision {marker + before!r}')
    return {'source': before, 'recovered': after}


# ---------------- process ownership (pidfd) ----------------

class ProcessError(RuntimeError):
    """Selecting or signaling the exact test-owned process failed; the destructive step must not count."""


def _start_time(pid):
    return int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19])


def _matches(pid, executable, marker):
    try:
        return (os.path.realpath(f'/proc/{pid}/exe') == os.path.realpath(executable)
                and marker in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'))
    except OSError:
        return False


class OwnedProcess:
    """A pidfd-held reference to the single process running `executable` with this scenario's environment
    marker (`XDG_DATA_HOME=...`). Use as a context manager; the pidfd is closed on every path."""

    def __init__(self, executable, data_home, *, opener=None, sender=None, proc_ids=None):
        self.executable, self.marker = executable, f'XDG_DATA_HOME={data_home}'.encode()
        self._open = opener or getattr(os, 'pidfd_open', None)
        self._send = sender or getattr(signal, 'pidfd_send_signal', None)
        self._ids = proc_ids or (lambda: [int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit()])
        self.fd = None
        self.pid = None
        self.start = None

    def acquire(self):
        if self._open is None or self._send is None:
            raise ProcessError('pidfd API unavailable; refusing unsafe numeric-PID signaling')
        found = [pid for pid in self._ids() if _matches(pid, self.executable, self.marker)]
        if len(found) != 1:
            raise ProcessError(f'expected exactly one test-owned process, found {found}')
        pid = found[0]
        try:
            start = _start_time(pid)
            fd = self._open(pid)
        except OSError as error:
            raise ProcessError(f'pidfd acquisition failed: {error!r}') from None
        # Re-verify through /proc after the pidfd exists: if the PID had been reused in between, the identity
        # (executable, environment marker, start time) no longer matches and the reference is discarded.
        try:
            same = _matches(pid, self.executable, self.marker) and _start_time(pid) == start
        except OSError:
            same = False
        if not same:
            os.close(fd)
            raise ProcessError('process identity changed while acquiring the pidfd')
        self.fd, self.pid, self.start = fd, pid, start
        return self

    def alive(self):
        if self.fd is None:
            return False
        poller = select.poll()
        poller.register(self.fd, select.POLLIN)
        return not poller.poll(0)  # a pidfd becomes readable when the process exits

    def kill(self, timeout=10.0):
        """SIGKILL through the pidfd and wait for the exit notification. Raises ProcessError if the process
        had already exited (no signal delivered by us) or delivery failed."""
        if self.fd is None:
            raise ProcessError('no process reference')
        try:
            self._send(self.fd, signal.SIGKILL)
        except ProcessLookupError:
            raise ProcessError('process already exited before the signal') from None
        except OSError as error:
            raise ProcessError(f'signal delivery failed: {error!r}') from None
        poller = select.poll()
        poller.register(self.fd, select.POLLIN)
        if not poller.poll(int(timeout * 1000)):
            raise ProcessError('process did not exit after SIGKILL')
        return {'pid': self.pid, 'startTime': self.start, 'method': 'pidfd_open + pidfd_send_signal(SIGKILL) + pidfd poll'}

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.close()
        return False


# ---------------- runtime RHWP identity ----------------

def compare_runtime_identity(runtime, independent):
    """`runtime` is captured inside the running WebView after the product loaded an RHWP document:
    - `generation`: the generation named by the embedded mutable `/rhwp/BUILD.json` (`selected`);
    - `initialized`: whether the ES module instance at `/rhwp/generations/<generation>/rhwp.js` already has an
      initialized WASM instance (a WASM-requiring call succeeds without this probe initializing anything). The
      module map is keyed by URL and only the product loader initializes it, so this binds the running engine
      to that generation;
    - `controlInitialized`: the same call on a cache-busted copy of that URL (a fresh, never-initialized module
      instance) — must be False, proving the probe discriminates;
    - `immutable`, `jsSha256`, `wasmSha256`: that generation's BUILD.json and artifact hashes as served by the
      embedded app (the loader checks the loaded bytes against these same hashes).
    `independent` is the Release engine used by the Node verifier (dist/rhwp, hash-checked)."""
    problems = []
    if runtime.get('generation') != independent['generation']:
        problems.append(f'WebView selected generation {runtime.get("generation")}, independent {independent["generation"]}')
    if runtime.get('initialized') is not True:
        problems.append('the selected generation module is not the initialized running engine')
    if runtime.get('controlInitialized') is not False:
        problems.append('negative control: a fresh module instance looked initialized (probe cannot discriminate)')
    if canonical(runtime.get('selected')) != canonical(independent['manifest']) or canonical(runtime.get('immutable')) != canonical(independent['manifest']):
        problems.append('embedded generation metadata differs from the independent Release manifest')
    if runtime.get('jsSha256') != independent['jsSha256'] or runtime.get('wasmSha256') != independent['wasmSha256']:
        problems.append('embedded JS/WASM bytes differ from the independent Release artifacts')
    if (runtime.get('immutable') or {}).get('profile') != 'release':
        problems.append('embedded generation is not a Release build')
    if problems:
        raise CheckError('; '.join(problems))
    return {'generation': runtime['generation'], 'jsSha256': runtime['jsSha256'], 'wasmSha256': runtime['wasmSha256'],
            'profile': 'release', 'runningModuleInitialized': True, 'freshModuleInitialized': False,
            'initError': runtime.get('controlError')}
