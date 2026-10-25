"""Fail-closed acceptance of one native D1 wrapper run (performance-visual-native.py under an evidence wrapper).

The wrapper's exit status must come from this verdict, never from the harness exit code or the result's own
status string alone. Every invariant is re-checked from the raw fields; a missing, wrong-typed or extra field
is a failure, not an implicit success. Expected counts and names are independent constants of the current
strict four-document D1 contract (39 assertions, 24 exact RGBA references, three cleanup steps); they are never
read from the result. test_native_d1_result.py cross-checks them against the harness's required_tests().
"""
SCHEMA = 1
SAMPLES = ('basic-ko.hwp', 'basic-ko.hwpx', '연구노트(화학).hwp', '3249937_asset_management_rules.hwpx')
EMPTY_ORIGINAL_PARAGRAPH = '연구노트(화학).hwp'
FRAMES = ('warm', 'typed-10', 'typed-20', 'typed-30', 'undo', 'redo')
CLEANUP_STEPS = ('sessionEnded', 'driverStopped', 'displayTerminated')
EXPECTED_ASSERTIONS = 39
EXPECTED_REFERENCES = 24
# Failure categories, kept separate so a cleanup failure is never hidden behind passing visual assertions.
CATEGORIES = ('native-subprocess', 'missing-result', 'malformed-result', 'failed-assertions', 'incomplete-verification',
              'cleanup', 'candidate-identity', 'dependency-mutation', 'lifecycle', 'evidence-write')


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


def check_result(v, result, expected_wasm):
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
    cleanup = result.get('cleanup')
    if v.require(isinstance(cleanup, dict) and sorted(cleanup) == sorted(CLEANUP_STEPS), 'cleanup',
                 f'cleanup fields are {sorted(cleanup) if isinstance(cleanup, dict) else cleanup!r}, not exactly {list(CLEANUP_STEPS)}'):
        bad = [step for step in CLEANUP_STEPS if cleanup[step] is not True]
        v.require(not bad, 'cleanup', 'cleanup not exact true: ' + ', '.join(bad))
    identity = result.get('engineIdentity')
    v.require(isinstance(identity, dict) and identity.get('wasmSha256') == expected_wasm, 'candidate-identity',
              f'engine-reported WASM {identity.get("wasmSha256") if isinstance(identity, dict) else identity!r} != expected')


def check_teardown(v, teardown):
    """tauri_smoke.TEARDOWN for the one D1 driver scenario: DELETE answered, nothing owned survived, nothing signaled."""
    if not v.require(isinstance(teardown, list) and len(teardown) == 1 and isinstance(teardown[0], dict), 'cleanup',
                     f'teardown record missing or not exactly one scenario: {type(teardown).__name__}'):
        return
    t = teardown[0]
    deletes = t.get('sessionDeletes')
    v.require(isinstance(deletes, list) and len(deletes) == 1 and isinstance(deletes[0], dict) and deletes[0].get('outcome') == 'ok',
              'cleanup', f'session deletion not exactly one answered DELETE: {deletes!r}'[:300])
    # An int (a signal exit is negative); None means the driver was still running when observed.
    v.require(type(t.get('driverExit')) is int, 'cleanup', f'tauri-driver exit not observed: {t.get("driverExit")!r}')
    for key in ('remainingAfterWait', 'sigtermSent', 'sigtermErrors', 'survivorsAfterSigterm'):
        v.require(t.get(key) == [] and type(t.get(key)) is list, 'cleanup', f'teardown {key} is {t.get(key)!r}, not an empty list'[:300])
    v.require(t.get('complete') is True, 'cleanup', 'teardown record not completed')


def check_lifecycle(v, lifecycle):
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


def validate(*, harness_exit, result, result_error, expected_wasm, candidate_wasm_before, candidate_wasm_after,
             dependencies_before, dependencies_after, lifecycle, evidence_errors=()):
    """Return {'status','failures','categories'}; PASS only when no invariant failed.

    result is the parsed harness JSON (dict) or None; result_error is 'missing' or a parse error text when None.
    expected_wasm is the independently trusted candidate identity (committed evidence), never the result's own."""
    v = Verdict()
    v.require(type(harness_exit) is int and harness_exit == 0, 'native-subprocess', f'harness exit {harness_exit!r}')
    if not sha256_text(expected_wasm):
        v.fail('candidate-identity', 'expected WASM identity is not a sha256')
    v.require(candidate_wasm_before == expected_wasm and candidate_wasm_after == expected_wasm, 'candidate-identity',
              'candidate WASM bytes do not match the expected identity before and after the run')
    v.require(isinstance(dependencies_before, dict) and bool(dependencies_before) and dependencies_before == dependencies_after,
              'dependency-mutation', 'executed dependencies changed (or were not recorded) during the run')
    if isinstance(dependencies_before, dict):
        v.require(dependencies_before.get('rhwp_bg.wasm') == expected_wasm, 'candidate-identity', 'executed WASM digest != expected')
    if result is None:
        v.fail('missing-result' if result_error == 'missing' else 'malformed-result', f'result unavailable: {result_error}')
    elif not isinstance(result, dict):
        v.fail('malformed-result', f'result is {type(result).__name__}, not an object')
    else:
        check_result(v, result, expected_wasm)
        check_teardown(v, result.get('teardown'))
    check_lifecycle(v, lifecycle)
    for error in evidence_errors:
        v.fail('evidence-write', str(error))
    categories = sorted({f['category'] for f in v.failures})
    return {'schema': SCHEMA, 'status': 'FAIL' if v.failures else 'PASS', 'failures': v.failures, 'categories': categories,
            'harnessExit': harness_exit, 'expectedAssertions': EXPECTED_ASSERTIONS, 'expectedReferences': EXPECTED_REFERENCES,
            'expectedCleanup': list(CLEANUP_STEPS), 'expectedWasmSha256': expected_wasm}


def exit_code(verdict, harness_exit):
    """0 only for PASS. A failed verdict keeps a nonzero harness code; a harness 0 with a failed verdict becomes 3."""
    if verdict.get('status') == 'PASS' and not verdict.get('failures'): return 0
    return harness_exit if type(harness_exit) is int and 0 < harness_exit < 256 else 3
