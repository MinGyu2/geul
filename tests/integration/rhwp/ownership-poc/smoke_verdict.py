"""Bounded smoke outcome helpers; no global process discovery or signalling."""
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

EXPECTED_FIXTURE = '26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8'


def failure(result, stage, error):
    result.setdefault('failures', []).append({'stage': stage, 'type': type(error).__name__, 'message': str(error)})


def record_pending(result, stage, recorded):
    error = sys.exc_info()[1]
    if error is not None and id(error) not in recorded:
        failure(result, stage, error)
        recorded.add(id(error))


def stop_owned(process, label, result):
    """Stop only this Popen; record every error and try bounded escalation and reap."""
    if process is None:
        return
    errors = len(result.setdefault('failures', []))
    def poll():
        try: return process.poll()
        except Exception as error:
            failure(result, label + '-poll', error)
            return None
    initial = poll(); kill_attempted = False
    if initial is not None and initial != 0:
        failure(result, label + '-premature-exit', RuntimeError(f'owned process exited unexpectedly: {initial}'))
    if initial is None:
        try:
            process.terminate()
        except Exception as error:
            failure(result, label + '-terminate', error)
        try:
            process.wait(timeout=10)
        except Exception as error:
            failure(result, label + '-wait', error)
        if poll() is None:
            kill_attempted = True
            try:
                process.kill()
            except Exception as kill_error:
                failure(result, label + '-kill', kill_error)
            try:
                process.wait(timeout=5)
            except Exception as wait_error:
                failure(result, label + '-reap', wait_error)
    code = poll()
    if code is None:
        failure(result, label + '-survivor', RuntimeError('owned process still running'))
    elif initial is None and code not in ((0, -15, 143, -9, 137) if kill_attempted else (0, -15, 143)):
        failure(result, label + '-exit', RuntimeError(f'unexpected exit: {code}'))
    result.setdefault('cleanup', {})[label] = {'returncode': code, 'ok': len(result['failures']) == errors and code is not None}


def verify_fixture(path, result):
    result['fixtureExpectedSha256'] = EXPECTED_FIXTURE
    actual = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    result['fixtureSha256'] = actual
    if actual != EXPECTED_FIXTURE:
        raise ValueError('fixture SHA-256 mismatch')
    return actual


def verify_unchanged(path, before):
    if hashlib.sha256(Path(path).read_bytes()).hexdigest() != before:
        raise ValueError('fixture changed during execution')
    return True


def verify_observation(before, after, stage, before_count, after_count, key_count, input_count, key_time=None, input_time=None):
    if before.get('document') != after.get('document') or not before.get('document'):
        raise ValueError('document identity changed')
    if not isinstance(before.get('localRevision'), int) or not isinstance(after.get('localRevision'), int) or after['localRevision'] != before['localRevision'] + 1:
        raise ValueError('unexpected local revision')
    if type(before.get('modelVersion')) is not int or type(after.get('modelVersion')) is not int or after['modelVersion'] != before['modelVersion'] + 1:
        raise ValueError('unexpected model version')
    if after.get('revision') != after['localRevision'] or key_count != 1 or input_count != 1 or after_count != before_count + 1:
        raise ValueError('input/revision/timeline count mismatch')
    if not isinstance(stage, dict) or stage.get('kind') != 'type':
        raise ValueError('incorrect timeline kind')
    at = stage.get('at') or {}
    times = [at.get(k) for k in ('key', 'observed', 'raf1', 'end')]
    if any(type(x) not in (int,float) or not math.isfinite(x) for x in times) or times[0] != 0 or times != sorted(times):
        raise ValueError('invalid RAF timeline')
    if key_time is not None or input_time is not None:
        input_offset = at.get('input')
        if any(type(x) not in (int, float) or not math.isfinite(x) for x in (key_time, input_time, input_offset)) or abs((input_time-key_time)-input_offset)>0.1:
            raise ValueError('timeline does not match native input')
    return True


def finalize(result, observations_complete):
    ok = observations_complete and not result.get('failures')
    result['status'] = 'PARTIAL' if ok else 'FAIL'
    result['executionStatus'] = 'PASS' if ok else 'FAIL'
    result['readinessVerdict'] = 'INCONCLUSIVE'
    cleanup = result.get('cleanup', {})
    result['cleanupScope'] = 'direct Vite/Xvfb plus tauri-smoke XDG-owned processes; Vite descendants not independently tracked'
    result['cleanupStatus'] = ('FAIL' if any(not item['ok'] for item in cleanup.values()) else
                               'PASS' if all(name in cleanup for name in ('vite', 'xvfb')) and observations_complete and not result.get('failures') else 'UNKNOWN')
    return ok


def persist_result(result, path):
    """Exclusive creation, with stderr fallback; never turn persistence failure into success."""
    result['evidenceStatus'] = 'PASS'
    try:
        with open(path, 'x', encoding='utf-8') as output:
            json.dump(result, output, ensure_ascii=True, indent=2, allow_nan=False)
            output.write('\n')
        return True
    except Exception as error:
        result['evidenceStatus'] = 'FAIL'; result['status'] = 'FAIL'; result['executionStatus'] = 'FAIL'
        failure(result, 'evidence-persistence', error)
        try:
            print('EVIDENCE_PERSISTENCE_FAILED ' + json.dumps(result, ensure_ascii=True, default=str), file=sys.stderr)
        except Exception:
            pass
        return False
