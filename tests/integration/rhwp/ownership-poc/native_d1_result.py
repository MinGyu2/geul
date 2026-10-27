"""Fail-closed acceptance of one native D1 wrapper run (performance-visual-native.py under an evidence wrapper).

The wrapper's exit status must come from this verdict, never from the harness exit code or the result's own
status string alone. Every invariant is re-checked from the raw fields; a missing, wrong-typed or extra field
is a failure, not an implicit success. Expected counts and names are independent constants of the current
strict four-document D1 contract (39 assertions, 24 exact RGBA references, three cleanup steps); they are never
read from the result. test_native_d1_result.py cross-checks them against the harness's required_tests().

The same module is the single authority for the mandatory executed-dependency manifest (DEPENDENCY_MANIFESTS) and the
committed candidate-identity trust anchor (TRUST_ANCHOR); the wrapper builds its digests from it and the validator checks
the supplied maps against it, never against names or identities taken from the result.
"""
import hashlib
import json
import math
import signal
import subprocess

SCHEMA = 3
SAMPLES = ('basic-ko.hwp', 'basic-ko.hwpx', '연구노트(화학).hwp', '3249937_asset_management_rules.hwpx')
EMPTY_ORIGINAL_PARAGRAPH = '연구노트(화학).hwp'
FRAMES = ('warm', 'typed-10', 'typed-20', 'typed-30', 'undo', 'redo')
CLEANUP_STEPS = ('sessionEnded', 'driverStopped', 'displayTerminated')
EXPECTED_ASSERTIONS = 39
EXPECTED_REFERENCES = 24
# Failure categories, kept separate so a cleanup failure is never hidden behind passing visual assertions.
# 'cleanup' = an actual cleanup or driver-lifecycle failure (leak, forced kill, unexpected exit, failed DELETE);
# 'teardown-evidence' = the teardown record itself is missing, malformed or contradictory (no claim about a leak);
# 'dependency-manifest' = the dependency maps are incomplete, ambiguous or malformed; 'dependency-mutation' = bytes changed.
CATEGORIES = ('native-subprocess', 'missing-result', 'malformed-result', 'failed-assertions', 'incomplete-verification',
              'cleanup', 'teardown-evidence', 'candidate-identity', 'dependency-manifest', 'dependency-mutation', 'lifecycle',
              'evidence-write', 'fixture-identity', 'lifecycle-evidence', 'observer-failure')

# Strict D1 driver-termination contract (Linux). tauri_driver() sends SIGTERM and waits 10 s; driverKilled=True means
# that wait timed out and SIGKILL followed, which is never a clean D1 shutdown. tauri-driver 2.0.4 handles SIGTERM and
# exits 0 (observed); -SIGTERM is what subprocess reports when the default disposition ends it. Nothing else is accepted.
ACCEPTED_DRIVER_EXITS = (0, -signal.SIGTERM)

# Mandatory executed dependencies, by recorded name: repository paths, candidate files by bare name ('candidate'),
# and 'tree:<dir>' aggregate digests of the git-tracked files under <dir> (tree_digest). Version 1 is the set recorded by
# ../evidence/t010-readiness-residual-stabilization (historical); versions 1 and 2 retain their historical sets; version 3 is the current strict set. Exact set policy:
# a missing, extra or non-canonical name fails.
_P = 'tests/integration/rhwp/ownership-poc/'
_GATES = 'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/engine-gates/'
_V1 = tuple(_P + n for n in ('session.mjs', 'vite.config.mjs', 'native.py', 'generate.mjs', 'performance-visual-native.py',
                             'native_d1_result.py')) + (
    'tests/integration/rhwp/undo_native.py', 'tests/integration/rhwp/native_probe.py', 'tests/integration/rhwp/rhwp_poc.py',
    'tests/e2e/tauri_smoke.py', 'tests/fixtures/rhwp/generate.mjs', 'src-tauri/target/debug/geul',
    'rhwp.js', 'rhwp_bg.wasm', 'ENGINE.json') + tuple(_GATES + n for n in ('engine-safety-gates.json', 'chrome.json', 'webkit.json'))
# v2 adds what the D1 run also executes: the served candidate d.ts, the base Vite config merged by vite.config.mjs, the
# Vite entry page, and the application frontend Vite serves to the app (session.mjs imports two of its modules).
DEPENDENCY_MANIFESTS = {1: _V1, 2: _V1 + ('rhwp.d.ts', 'vite.config.ts', 'index.html', 'tree:src')}
NATIVE_WRAPPER = 'tests/integration/rhwp/evidence/t010-native-evidence-final-integrity/run-native.py'
# v4 (2026-10-28, trust anchor replacement approved by the repository owner): the same strict set as v3 with the
# engine gates and the authoritative wrapper of the new anchor's directory. Assertions, references, fixtures and
# the cleanup contract are unchanged; v1-v3 stay available for historical results.
_ANCHOR_V2 = 'tests/integration/rhwp/evidence/t010-d1-trust-anchor-v2/'
NATIVE_WRAPPERS = {3: NATIVE_WRAPPER, 4: _ANCHOR_V2 + 'run-native.py'}
RHWP_REVISION = '1a76570e833917d15817415a53c09ad61ab3203f'
PINNED_FIXTURES = dict(zip(SAMPLES[2:], (
    'external/rhwp/samples/rnote/연구노트(화학).hwp',
    'external/rhwp/samples/issue6031/3249937_asset_management_rules.hwpx')))
# Independent contract: generated twice in clean directories and a third time in a new Node process;
# pinned samples checked against the pinned submodule blobs. See final-integrity/fixtures.json.
FIXTURE_SHA256 = dict(zip(SAMPLES, (
    '57c901cc394abf6f58f4838315d1ea2c5ecf8a03d9934d3fc098fd8be6e6e12f',
    '26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8',
    '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91',
    '97b5d6c571a6b7626321c6a53d797e3511978447497bb73309bd23eaa8e7ea77')))
DEPENDENCY_MANIFESTS[3] = DEPENDENCY_MANIFESTS[2] + (
    NATIVE_WRAPPER, 'package.json', 'tsconfig.json', 'public/rhwp/rhwp.js', 'public/rhwp/rhwp_bg.wasm',
    'public/rhwp/BUILD.json', 'tests/integration/rhwp/cache-concurrency/fixtures.mjs', *PINNED_FIXTURES.values())
DEPENDENCY_MANIFESTS[4] = tuple(
    _ANCHOR_V2 + 'engine-gates/' + n[len(_GATES):] if n.startswith(_GATES) else NATIVE_WRAPPERS[4] if n == NATIVE_WRAPPER else n
    for n in DEPENDENCY_MANIFESTS[3])
CURRENT_MANIFEST = 4


def strict_manifest(version):
    """v3 and later use the strict checks; only an exact int qualifies (a str/bool/float never does)."""
    return type(version) is int and version >= 3
CANDIDATE_FILES = ('rhwp.js', 'rhwp_bg.wasm', 'ENGINE.json', 'rhwp.d.ts')

# Trust anchor: committed in 2636a65 and protected since; read from the committed tree (git show HEAD:path), never from
# the working tree or a result. Its own bytes are pinned so a later edit cannot move the anchor.
# v4 replaces the anchor (approved 2026-10-28); the v3 anchor file is preserved unchanged and still pinned for v3 results.
TRUST_ANCHORS = {
    3: {'path': 'tests/integration/rhwp/evidence/t010-decoded-lease-readiness-closure/candidate-identity.json',
        'sha256': '1699dfbe6d51409c1b7f852c838e1ab37bb3b27be7efe6fbf3dd70eda8048271'},
    4: {'path': _ANCHOR_V2 + 'candidate-identity.json', 'sha256': '799d3e31f2f3d5e23b7ee8a003ede43928bf19bef43838d2377e82be03e5877e'},
}
TRUST_ANCHOR = TRUST_ANCHORS[CURRENT_MANIFEST]
TRUSTED_KEYS = ('rhwp_bg.wasm', 'rhwp.js', 'rhwp.d.ts', 'ENGINE.json')


def loads_strict(text):
    """json.loads that rejects duplicate keys and NaN/Infinity (ValueError), so they cannot hide or fake values."""
    def pairs(items):
        keys = [k for k, _ in items]
        if len(keys) != len(set(keys)): raise ValueError(f'duplicate keys: {sorted({k for k in keys if keys.count(k) > 1})}')
        return dict(items)
    def constant(name): raise ValueError(f'non-finite number {name}')
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def trust_anchor_from_bytes(data, version=CURRENT_MANIFEST):
    """{name: sha256} for TRUSTED_KEYS from the committed anchor bytes; ValueError unless the bytes are the pinned ones."""
    if hashlib.sha256(data).hexdigest() != TRUST_ANCHORS[version]['sha256']: raise ValueError('trust anchor bytes differ from the pinned anchor')
    record = loads_strict(data.decode())
    expected = record['candidate']['expected']
    trusted = {k: expected[k] for k in ('rhwp_bg.wasm', 'rhwp.js', 'rhwp.d.ts')}
    trusted['ENGINE.json'] = record['candidate']['engineManifestSha256']
    if not all(sha256_text(v) for v in trusted.values()): raise ValueError('trust anchor values are not sha256')
    return trusted


def load_trust_anchor(root, version=CURRENT_MANIFEST):
    data = subprocess.run(['git', '-C', str(root), 'show', 'HEAD:' + TRUST_ANCHORS[version]['path']], capture_output=True, check=True).stdout
    return trust_anchor_from_bytes(data, version)


def tree_digest(root, directory):
    """sha256 over 'path\\0sha256\\n' of every git-tracked file under directory (working-tree bytes); None if one is unreadable."""
    names = subprocess.run(['git', '-C', str(root), 'ls-files', '-z', '--', directory], capture_output=True, check=True).stdout.split(b'\0')
    lines = []
    for name in sorted(n for n in names if n):
        try: lines.append(name + b'\0' + hashlib.sha256((root / name.decode()).read_bytes()).hexdigest().encode() + b'\n')
        except OSError: return None
    return hashlib.sha256(b''.join(lines)).hexdigest() if lines else None


def pinned_samples_valid(root):
    """Verify the superproject gitlink, checked-out revision and exact pinned sample blobs independently."""
    try:
        link = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--stage', '--', 'external/rhwp'], text=True).strip()
        if link != '160000 ' + RHWP_REVISION + ' 0\texternal/rhwp': return False
        sub = root / 'external/rhwp'
        if subprocess.check_output(['git', '-C', str(sub), 'rev-parse', 'HEAD'], text=True).strip() != RHWP_REVISION: return False
        for name, path in PINNED_FIXTURES.items():
            blob = subprocess.check_output(['git', '-C', str(sub), 'show', RHWP_REVISION + ':' + path[len('external/rhwp/'):]])
            if hashlib.sha256(blob).hexdigest() != FIXTURE_SHA256[name]: return False
            if (root / path).read_bytes() != blob: return False
        return True
    except (OSError, subprocess.CalledProcessError): return False


def frontend_inputs_valid(root):
    """Tracked tree covers only tracked bytes: reject even ignored extra src files and Vite's implicit env files."""
    try:
        tracked = set(subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z', '--', 'src']).split(b'\0')) - {b''}
        actual = {str(p.relative_to(root)).encode() for p in (root / 'src').rglob('*') if p.is_file() or p.is_symlink()}
        return actual == tracked and not any((root / n.decode()).is_symlink() for n in tracked) and not any(
            (root / n).exists() or (root / n).is_symlink() for n in ('.env', '.env.local', '.env.development', '.env.development.local'))
    except (OSError, subprocess.CalledProcessError): return False


def dependency_digests(root, candidate, version=CURRENT_MANIFEST):
    """{name: sha256 or None} for exactly the manifest names; unreadable files are None (and fail validation)."""
    digests = {}
    for name in DEPENDENCY_MANIFESTS[version]:
        if name.startswith('tree:'): digests[name] = tree_digest(root, name[5:]); continue
        path = candidate / name if name in CANDIDATE_FILES else root / name
        try: digests[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError: digests[name] = None
    if strict_manifest(version):
        if not frontend_inputs_valid(root): digests['tree:src'] = None
        if not pinned_samples_valid(root):
            for name in PINNED_FIXTURES.values(): digests[name] = None
    return digests


def required_tests():
    names = ['bootstrap-clean-close']
    for sample in SAMPLES:
        names += [f'{sample}-{label}-full-reference-exact' for label in FRAMES[:4]]
        if sample == EMPTY_ORIGINAL_PARAGRAPH: names.append(f'{sample}-original-empty-paragraph-restored')
        names += [f'{sample}-undo-caret-visible', f'{sample}-undo-full-reference-exact', f'{sample}-redo-full-reference-exact',
                  f'{sample}-history-model-caret', f'{sample}-original-preserved']
    return names + ['native-final-resource-cleanup']


def exact_int(value, expected=None):
    """A count is a real int (bool is not evidence); with expected, it must equal it exactly."""
    return type(value) is int and value >= 0 and (expected is None or value == expected)


def sha256_text(value):
    return type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


class Verdict:
    def __init__(self):
        self.failures = []

    def fail(self, category, invariant):
        assert category in CATEGORIES, category
        self.failures.append({'category': category, 'invariant': invariant[:300]})

    def require(self, condition, category, invariant):
        if not condition: self.fail(category, invariant)
        return condition


def check_result(v, result, expected_wasm, strict=True):
    """The harness result's own fields; returns nothing, records every violated invariant."""
    v.require(result.get('status') == 'PASS' and type(result.get('status')) is str, 'failed-assertions',
              f'status is {result.get("status")!r}, not exact PASS')
    v.require('error' not in result, 'failed-assertions', f'error present: {str(result.get("error"))[:200]}')
    v.require(result.get('failures') == [] and type(result.get('failures')) is list, 'failed-assertions',
              f'harness failures not an empty list: {result.get("failures")!r}'[:300])
    v.require(result.get('diagnosticContinuation') is False, 'incomplete-verification', 'diagnosticContinuation is not exact false')
    v.require(result.get('selectedSamples') == list(SAMPLES) and result.get('expectedSamples') == list(SAMPLES),
              'incomplete-verification', 'selected/expected samples are not the strict four-document matrix')
    for key in ('historyGates', 'historyChecks'):
        v.require(result.get(key) == [] and type(result.get(key)) is list, 'incomplete-verification', f'{key} must be an empty list')
    expected = required_tests()
    tests = result.get('tests')
    if v.require(isinstance(tests, list) and all(isinstance(r, dict) for r in tests), 'incomplete-verification', 'tests is not a list of objects'):
        names = [r.get('name') for r in tests]
        v.require(names == expected, 'incomplete-verification', f'{len(tests)} assertions do not equal the {len(expected)} required assertions in order')
        failed = [str(r.get('name')) for r in tests if r.get('status') != 'PASS' or type(r.get('status')) is not str]
        v.require(not failed, 'failed-assertions', 'failed assertions: ' + ', '.join(failed))
    v.require(exact_int(result.get('expectedAssertionCount'), EXPECTED_ASSERTIONS), 'incomplete-verification',
              f'expectedAssertionCount is {result.get("expectedAssertionCount")!r}, not int {EXPECTED_ASSERTIONS}')
    v.require(result.get('measurementComplete') is True, 'incomplete-verification', 'measurementComplete is not exact true')
    refs = result.get('visualReferences')
    want = [(s, f) for s in SAMPLES for f in FRAMES]
    if v.require(isinstance(refs, list) and all(isinstance(r, dict) for r in refs), 'incomplete-verification', 'visualReferences is not a list of objects'):
        got = [(r.get('sample'), r.get('frame')) for r in refs]
        v.require(got == want and all(r.get('name') == f'{r.get("sample")}-{r.get("frame")}' for r in refs), 'incomplete-verification',
                  f'{len(refs)} references do not equal the {len(want)} required (sample, frame) references in order')
        unverified = [str(r.get('name')) for r in refs if r.get('verified') is not True]
        v.require(not unverified, 'incomplete-verification', 'unverified references: ' + ', '.join(unverified))
        typed = [str(r.get('name')) for r in refs if not (exact_int(r.get('pixels')) and exact_int(r.get('maxDelta')))]
        v.require(not typed, 'incomplete-verification', 'missing or non-int pixels/maxDelta: ' + ', '.join(typed))
        inexact = [str(r.get('name')) for r in refs if str(r.get('name')) not in typed and (r['pixels'] != 0 or r['maxDelta'] != 0)]
        v.require(not inexact, 'failed-assertions', 'RGBA mismatch: ' + ', '.join(inexact))
    v.require(exact_int(result.get('expectedReferenceCount'), EXPECTED_REFERENCES), 'incomplete-verification',
              f'expectedReferenceCount is {result.get("expectedReferenceCount")!r}, not int {EXPECTED_REFERENCES}')
    v.require(exact_int(result.get('verifiedExactReferenceCount'), EXPECTED_REFERENCES), 'incomplete-verification',
              f'verifiedExactReferenceCount is {result.get("verifiedExactReferenceCount")!r}, not int {EXPECTED_REFERENCES}')
    v.require(result.get('pixelReferencesComplete') is True, 'incomplete-verification', 'pixelReferencesComplete is not exact true')
    documents = result.get('documents')
    v.require(isinstance(documents, list) and [d.get('sample') if isinstance(d, dict) else None for d in documents] == list(SAMPLES),
              'incomplete-verification', 'documents are not the four required samples in order')
    if strict and isinstance(documents, list):
        for d in documents:
            if isinstance(d, dict):
                digest = d.get('sourceSha256')
                v.require(type(d.get('sample')) is str and sha256_text(digest) and digest == FIXTURE_SHA256.get(d['sample']),
                          'fixture-identity', f'document source identity invalid: {d.get("sample")!r}')
    cleanup = result.get('cleanup')
    if v.require(isinstance(cleanup, dict) and sorted(cleanup) == sorted(CLEANUP_STEPS), 'cleanup',
                 f'cleanup fields are {sorted(cleanup) if isinstance(cleanup, dict) else cleanup!r}, not exactly {list(CLEANUP_STEPS)}'):
        bad = [step for step in CLEANUP_STEPS if cleanup[step] is not True]
        v.require(not bad, 'cleanup', 'cleanup not exact true: ' + ', '.join(bad))
    identity = result.get('engineIdentity')
    v.require(isinstance(identity, dict) and identity.get('wasmSha256') == expected_wasm, 'candidate-identity',
              f'engine-reported WASM {identity.get("wasmSha256") if isinstance(identity, dict) else identity!r} != expected')


TEARDOWN_KEYS = ('sessionDeletes', 'complete', 'beforeDriverStop', 'driverKilled', 'driverExit', 'afterDriverStop',
                 'driverStopSeconds', 'remainingAfterWait', 'sigtermSent', 'sigtermErrors', 'survivorsAfterSigterm')
PROCESS_STATES = set('RSDZTtWXxKPI')


def duration(value):
    """A finite, nonnegative int or float (bool, NaN, infinity, strings rejected)."""
    try: return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError: return False


def process_row(row):
    """tauri_smoke.process_rows(): {pid, comm, state, ppid} or the disappeared form {pid, gone: True}."""
    if not isinstance(row, dict) or not (type(row.get('pid')) is int and row['pid'] > 0): return False
    if set(row) == {'pid', 'gone'}: return row['gone'] is True
    return (set(row) == {'pid', 'comm', 'state', 'ppid'} and type(row['comm']) is str and 0 < len(row['comm']) <= 15
            and type(row['state']) is str and row['state'] in PROCESS_STATES and type(row['ppid']) is int and row['ppid'] >= 0)


def check_teardown(v, teardown):
    """tauri_smoke.TEARDOWN for the one D1 driver scenario, against the complete supported schema.

    Evidence defects (missing, extra, wrong-typed or contradictory fields) are 'teardown-evidence'; real lifecycle failures
    (DELETE not ok, forced kill, unsupported exit, owned survivors, signals) are 'cleanup'. Snapshots may legitimately be
    empty (the app can exit before beforeDriverStop) and may differ (processes exit between observations); only the final
    boundary lists must be empty."""
    if not v.require(isinstance(teardown, list) and len(teardown) == 1 and isinstance(teardown[0], dict), 'teardown-evidence',
                     f'teardown record missing or not exactly one scenario: {type(teardown).__name__}'):
        return
    t = teardown[0]
    missing = [k for k in TEARDOWN_KEYS if k not in t]
    extra = sorted(k for k in t if k not in TEARDOWN_KEYS)
    v.require(not missing and not extra, 'teardown-evidence', f'teardown fields missing {missing} / unsupported {extra}')
    deletes = t.get('sessionDeletes')
    if v.require(type(deletes) is list and len(deletes) == 1, 'teardown-evidence', f'not exactly one DELETE record: {deletes!r}'[:300]):
        d = deletes[0]
        if v.require(isinstance(d, dict) and set(d) == {'outcome', 'seconds'} and type(d['outcome']) is str and duration(d['seconds']),
                     'teardown-evidence', f'malformed DELETE record: {d!r}'[:300]):
            v.require(d['outcome'] == 'ok', 'cleanup', f'session DELETE outcome {d["outcome"]!r}, not ok')
    for key in ('beforeDriverStop', 'afterDriverStop', 'remainingAfterWait', 'survivorsAfterSigterm'):
        rows = t.get(key)
        v.require(type(rows) is list and all(process_row(r) for r in rows), 'teardown-evidence', f'{key} is not a list of process rows: {rows!r}'[:300])
    killed, code = t.get('driverKilled'), t.get('driverExit')
    typed = v.require(type(killed) is bool, 'teardown-evidence', f'driverKilled is {killed!r}, not exact bool')
    typed = v.require(type(code) is int, 'teardown-evidence', f'driverExit is {code!r}, not exact int (None = never observed)') and typed
    if typed:
        if killed:
            v.fail('cleanup', f'tauri-driver did not stop within its SIGTERM timeout and was force-killed (driverExit {code})')
        elif code == -signal.SIGKILL:
            v.fail('cleanup', 'driverExit -SIGKILL without a recorded forced kill (unexpected signal termination)')
        elif code not in ACCEPTED_DRIVER_EXITS:
            v.fail('cleanup', f'tauri-driver exit {code} is not an accepted status {list(ACCEPTED_DRIVER_EXITS)}')
    v.require(duration(t.get('driverStopSeconds')), 'teardown-evidence', f'driverStopSeconds is {t.get("driverStopSeconds")!r}, not a finite nonnegative number')
    after = t.get('afterDriverStop')
    if type(after) is list:
        v.require(not any(isinstance(r, dict) and r.get('comm') == 'tauri-driver' for r in after), 'teardown-evidence',
                  'tauri-driver still listed after it was reported stopped')
    for key in ('remainingAfterWait', 'survivorsAfterSigterm'):
        rows = t.get(key)
        if type(rows) is list:
            v.require(not rows, 'cleanup', f'owned processes at the final cleanup boundary ({key}): {rows!r}'[:300])
    sent, errors = t.get('sigtermSent'), t.get('sigtermErrors')
    if v.require(type(sent) is list and all(type(x) is int and x > 0 for x in sent), 'teardown-evidence', f'sigtermSent malformed: {sent!r}'[:300]):
        v.require(not sent, 'cleanup', f'cleanup had to SIGTERM owned processes: {sent}')
    if v.require(type(errors) is list and all(isinstance(e, dict) and set(e) == {'pid', 'error'} for e in errors), 'teardown-evidence',
                 f'sigtermErrors malformed: {errors!r}'[:300]):
        v.require(not errors, 'cleanup', f'cleanup signal errors: {errors}')
    v.require(t.get('complete') is True, 'teardown-evidence', 'teardown record not completed (complete is not exact true)')


def check_dependencies(v, before, after, version, trusted):
    """Both maps are exactly the manifest's names with sha256 values, unchanged, and the candidate entries equal the anchor."""
    if not v.require(type(version) is int and version in DEPENDENCY_MANIFESTS, 'dependency-manifest', f'unsupported manifest version {version!r}'):
        return
    required = DEPENDENCY_MANIFESTS[version]
    maps = {}
    for label, supplied in (('before', before), ('after', after)):
        if isinstance(supplied, list):  # (name, digest) pairs, e.g. read back from JSON: duplicates are ambiguous
            names = [p[0] if isinstance(p, (list, tuple)) and len(p) == 2 else None for p in supplied]
            if not v.require(all(type(n) is str for n in names) and len(names) == len(set(names)), 'dependency-manifest', f'{label} has duplicate or malformed names'):
                continue
            supplied = dict(supplied)
        if not v.require(isinstance(supplied, dict), 'dependency-manifest', f'{label} dependency map missing'):
            continue
        missing = [n for n in required if n not in supplied]
        extra = sorted(str(n) for n in supplied if n not in required)
        v.require(not missing, 'dependency-manifest', f'{label} lacks mandatory dependencies: {missing}'[:300])
        v.require(not extra, 'dependency-manifest', f'{label} has unexpected or non-canonical names: {extra}'[:300])
        bad = [n for n in required if n in supplied and not sha256_text(supplied[n])]
        v.require(not bad, 'dependency-manifest', f'{label} digests not sha256 text: {bad}'[:300])
        if strict_manifest(version):
            for sample, path in PINNED_FIXTURES.items():
                v.require(supplied.get(path) == FIXTURE_SHA256[sample], 'fixture-identity',
                          f'{label} pinned fixture differs from independent identity: {sample}')
        maps[label] = supplied
    if len(maps) == 2:
        changed = [n for n in required if n in maps['before'] and n in maps['after'] and maps['before'][n] != maps['after'][n]]
        v.require(not changed, 'dependency-mutation', f'executed dependencies changed during the run: {changed}'[:300])
    if 'before' in maps and isinstance(trusted, dict):
        wrong = [n for n in TRUSTED_KEYS if n in required and n in maps['before'] and maps['before'][n] != trusted.get(n)]
        v.require(not wrong, 'candidate-identity', f'executed candidate files differ from the trust anchor: {wrong}')


def check_lifecycle_historical(v, lifecycle):
    """The wrapper's own read-only token observer must have run and must not contradict cleanup success."""
    if not v.require(isinstance(lifecycle, dict), 'evidence-write', 'lifecycle record missing'):
        return
    v.require(lifecycle.get('observerError') is None, 'evidence-write', f'observer error: {lifecycle.get("observerError")!r}')
    v.require(lifecycle.get('observerStopped') is True, 'evidence-write', 'observer thread did not stop')
    v.require(exact_int(lifecycle.get('samples')) and lifecycle['samples'] > 0, 'evidence-write', 'observer took no samples')
    processes = lifecycle.get('processes')
    if not v.require(isinstance(processes, list) and all(isinstance(p, dict) for p in processes), 'lifecycle', 'lifecycle processes missing'):
        return
    apps = [p for p in processes if p.get('comm') == 'geul']
    v.require(bool(apps), 'lifecycle', 'observer never saw the token-owned application process')
    alive = [f'{p.get("pid")}({p.get("comm")})' for p in processes if 'gone' not in p]
    v.require(not alive, 'lifecycle', 'token-owned processes alive at end: ' + ', '.join(alive))
    v.require(lifecycle.get('leftAtEnd') == [], 'lifecycle', f'leftAtEnd is {lifecycle.get("leftAtEnd")!r}'[:300])


OBSERVER = 'read-only /proc sampling, 100 ms; processes carrying this attempt token only'
LIFECYCLE_KEYS = {'schema', 'attempt', 'observer', 'samples', 'observerError', 'observerStopped',
                  'loadAverage', 'cpuCount', 'processes', 'events', 'leftAtEnd'}


def positive_pid(x):
    return type(x) is int and x > 0


def check_lifecycle(v, lifecycle, attempt=None, harness_exit=None):
    """Schema 2 producer structure, plus producer-guaranteed row/event consistency; no cross-process exit ordering."""
    if not v.require(isinstance(lifecycle, dict), 'evidence-write', 'lifecycle record missing'): return
    def require(ok, text): return v.require(ok, 'lifecycle-evidence', text)
    require(set(lifecycle) == LIFECYCLE_KEYS, 'lifecycle fields missing or unsupported')
    require(type(lifecycle.get('schema')) is int and lifecycle['schema'] == 2, 'unsupported lifecycle schema')
    require(positive_pid(attempt) and positive_pid(lifecycle.get('attempt')) and lifecycle['attempt'] == attempt, 'invalid lifecycle attempt identity')
    require(lifecycle.get('observer') == OBSERVER, 'invalid observer metadata')
    require('observerError' in lifecycle and (lifecycle['observerError'] is None or type(lifecycle['observerError']) is str), 'invalid observerError')
    v.require(lifecycle.get('observerError') is None, 'evidence-write', 'observer failed to produce complete evidence')
    v.require(lifecycle.get('observerError') is None, 'observer-failure', 'observer failed')
    v.require(lifecycle.get('observerStopped') is True, 'evidence-write', 'observer did not stop')
    v.require(lifecycle.get('observerStopped') is True, 'observer-failure', 'observer thread did not stop')
    v.require(positive_pid(lifecycle.get('samples')), 'evidence-write', 'observer took no valid samples')
    require(positive_pid(lifecycle.get('samples')), 'sample count must be a positive exact integer')
    require(positive_pid(lifecycle.get('cpuCount')), 'invalid cpuCount')
    load = lifecycle.get('loadAverage')
    require(isinstance(load, dict) and set(load) == {'start', 'end'} and all(
        isinstance(load[k], (list, tuple)) and len(load[k]) == 3 and all(duration(x) for x in load[k]) for k in load), 'invalid loadAverage')
    rows = lifecycle.get('processes'); events = lifecycle.get('events'); final = lifecycle.get('leftAtEnd')
    if not require(type(rows) is list and all(isinstance(p, dict) for p in rows), 'processes must be object list'): return
    by_pid = {}
    for p in rows:
        keys = {'pid', 'comm', 'ppid', 'pgid', 'firstSeen', 'lastSeen', 'states'}
        valid = (set(p) in (keys, keys | {'gone'}) and positive_pid(p.get('pid'))
                 and type(p.get('ppid')) is int and p['ppid'] >= 0 and positive_pid(p.get('pgid'))
                 and type(p.get('comm')) is str and 0 < len(p['comm']) <= 15
                 and duration(p.get('firstSeen')) and duration(p.get('lastSeen')))
        if not require(valid, 'malformed process observation'): continue
        require(p['firstSeen'] <= p['lastSeen'], 'lastSeen before firstSeen')
        if 'gone' in p: require(duration(p['gone']) and p['gone'] >= p['lastSeen'], 'invalid terminal gone time')
        states = p['states']
        require(isinstance(states, dict) and bool(states) and all(type(k) is str and len(k) == 1 and k in PROCESS_STATES
                and positive_pid(n) for k, n in states.items()) and positive_pid(lifecycle.get('samples'))
                and sum(states.values()) <= lifecycle['samples'], 'invalid process state counters')
        require(p['pid'] not in by_pid, 'duplicate process identity')
        by_pid[p['pid']] = p
    require(type(final) is list and all(isinstance(p, dict) for p in final), 'invalid leftAtEnd structure')
    expected_final = [p for p in rows if 'gone' not in p]
    require(final == expected_final, 'leftAtEnd inconsistent with terminal observations')
    v.require(not expected_final and final == [], 'lifecycle', 'owned processes survive final boundary')
    v.require(any(p.get('comm') == 'geul' for p in rows), 'lifecycle', 'observer never saw owned geul')
    if not require(type(events) is list and all(isinstance(e, dict) for e in events), 'invalid event list'): return
    per_pid = {pid: [] for pid in by_pid}; harness = []; harness_times = []
    for e in events:
        kind = e.get('event'); t = e.get('t')
        if not require(duration(t), 'invalid event time'): continue
        if kind in ('harness-start', 'harness-exit'):
            keys = {'t', 'event'} | ({'exit'} if kind == 'harness-exit' else set())
            require(set(e) == keys and (kind != 'harness-exit' or type(e.get('exit')) is int), 'invalid harness event')
            harness.append(kind); harness_times.append(t)
            if kind == 'harness-exit' and harness_exit is not None:
                require(e.get('exit') == harness_exit, 'harness exit event differs from subprocess')
            continue
        keys = {'t', 'event', 'pid', 'comm'} | ({'ppid'} if kind == 'appeared' else {'from', 'to'} if kind == 'reparented' else set())
        if not require(kind in ('appeared', 'reparented', 'gone') and set(e) == keys and positive_pid(e.get('pid')),
                       'malformed process event'): continue
        p = by_pid.get(e['pid'])
        if not require(p is not None and e.get('comm') == p['comm'], 'unknown or inconsistent event identity'): continue
        if kind == 'appeared': require(type(e.get('ppid')) is int and e['ppid'] >= 0 and t == p['firstSeen'], 'invalid appeared event')
        if kind == 'gone': require('gone' in p and t == p['gone'], 'invalid gone event')
        if kind == 'reparented':
            require(all(type(e.get(k)) is int and e[k] >= 0 for k in ('from', 'to'))
                    and e.get('from') != e.get('to') and p['firstSeen'] <= t <= p['lastSeen'], 'invalid reparented event')
        per_pid[e['pid']].append(e)
    require(harness == ['harness-start', 'harness-exit'], 'incomplete harness event sequence')
    require(harness_times == sorted(harness_times), 'harness exit precedes start')
    for pid, p in by_pid.items():
        es = per_pid[pid]; kinds = [e['event'] for e in es]
        require([e['t'] for e in es] == sorted(e['t'] for e in es), 'process events go backwards')
        want = ['appeared'] + ['reparented'] * kinds.count('reparented') + (['gone'] if 'gone' in p else [])
        require(kinds == want, 'inconsistent process event sequence')
        parent = es[0].get('ppid') if es else None
        for e in es:
            if e['event'] == 'reparented':
                require(e.get('from') == parent, 'inconsistent parent transition'); parent = e.get('to')
        require(parent == p['ppid'], 'final parent differs from event chain')


def validate(*, harness_exit, result, result_error, expected_wasm, candidate_wasm_before, candidate_wasm_after,
             dependencies_before, dependencies_after, lifecycle, trusted_identity, manifest_version, evidence_errors=(), attempt=None):
    """Return {'schema','status','failures','categories',...}; PASS only when no invariant failed.

    result is the parsed harness JSON (dict) or None; result_error is 'missing' or a parse error text when None.
    trusted_identity is trust_anchor_from_bytes() of the committed anchor; expected_wasm (the operator's argument) must
    agree with it. manifest_version selects the mandatory dependency set (CURRENT_MANIFEST for new runs)."""
    v = Verdict()
    v.require(type(harness_exit) is int and harness_exit == 0, 'native-subprocess', f'harness exit {harness_exit!r}')
    anchored = v.require(isinstance(trusted_identity, dict) and sorted(trusted_identity) == sorted(TRUSTED_KEYS)
                         and all(sha256_text(trusted_identity[k]) for k in TRUSTED_KEYS), 'candidate-identity', 'trust anchor unavailable or malformed')
    trusted_wasm = trusted_identity['rhwp_bg.wasm'] if anchored else None
    v.require(sha256_text(expected_wasm) and expected_wasm == trusted_wasm, 'candidate-identity', 'expected WASM argument does not equal the trust anchor')
    v.require(trusted_wasm is not None and candidate_wasm_before == trusted_wasm and candidate_wasm_after == trusted_wasm, 'candidate-identity',
              'candidate WASM bytes do not match the trusted identity before and after the run')
    check_dependencies(v, dependencies_before, dependencies_after, manifest_version, trusted_identity if anchored else None)
    if result is None:
        v.fail('missing-result' if result_error == 'missing' else 'malformed-result', f'result unavailable: {result_error}')
    elif not isinstance(result, dict):
        v.fail('malformed-result', f'result is {type(result).__name__}, not an object')
    else:
        check_result(v, result, trusted_wasm, strict=strict_manifest(manifest_version))
        check_teardown(v, result.get('teardown'))
    if strict_manifest(manifest_version): check_lifecycle(v, lifecycle, attempt, harness_exit)
    else: check_lifecycle_historical(v, lifecycle)
    for error in evidence_errors:
        v.fail('evidence-write', str(error))
    categories = sorted({f['category'] for f in v.failures})
    return {'schema': SCHEMA if strict_manifest(manifest_version) else 2, 'status': 'FAIL' if v.failures else 'PASS', 'failures': v.failures, 'categories': categories,
            'harnessExit': harness_exit, 'expectedAssertions': EXPECTED_ASSERTIONS, 'expectedReferences': EXPECTED_REFERENCES,
            'expectedCleanup': list(CLEANUP_STEPS), 'acceptedDriverExits': list(ACCEPTED_DRIVER_EXITS),
            'dependencyManifest': manifest_version, 'trustAnchor': dict(TRUST_ANCHORS.get(manifest_version, TRUST_ANCHOR)), 'expectedWasmSha256': trusted_wasm}


def exit_code(verdict, harness_exit):
    """0 only when the known harness exit is exactly 0 AND the verdict is a well-formed PASS with no failures.
    Otherwise a nonzero harness code is kept; anything else (harness 0 with a failed or malformed verdict) is 3."""
    passed = (type(harness_exit) is int and harness_exit == 0 and isinstance(verdict, dict) and type(verdict.get('schema')) is int and verdict.get('schema') == SCHEMA
              and verdict.get('status') == 'PASS' and type(verdict.get('status')) is str
              and verdict.get('failures') == [] and type(verdict.get('failures')) is list
              and verdict.get('categories') == [] and type(verdict.get('categories')) is list)
    if passed: return 0
    return harness_exit if type(harness_exit) is int and 0 < harness_exit < 256 else 3
