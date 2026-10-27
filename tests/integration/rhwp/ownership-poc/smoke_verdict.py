"""Bounded smoke outcome helpers; no global process discovery or signalling."""
import hashlib
import json
import math
import os
import tempfile
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
    if 'input' in at or key_time is not None or input_time is not None:
        input_offset = at.get('input')
        if type(input_offset) not in (int,float) or not math.isfinite(input_offset) or input_offset > at['observed'] + 0.1:
            raise ValueError('input occurs after revision observation or is invalid')
    if key_time is not None or input_time is not None:
        input_offset = at.get('input')
        if any(type(x) not in (int, float) or not math.isfinite(x) for x in (key_time, input_time, input_offset)) or abs((input_time-key_time)-input_offset)>0.1:
            raise ValueError('timeline does not match native input')
    return True


def attach_teardown(result, records, start):
    """Attach only the unique record created after this invocation's boundary."""
    result.pop('teardown', None); result.pop('teardownAttemptId', None)
    if type(start) is not int or start < 0 or len(records) != start + 1:
        return False
    result['teardown'] = records[start]
    result['teardownAttemptId'] = result.get('attemptId')
    return True


def finalize(result, observations_complete):
    cleanup = result.get('cleanup', {})
    if not isinstance(cleanup, dict): cleanup = {}
    required = all(isinstance(cleanup.get(name), dict) and cleanup[name].get('ok') is True
                   and ('returncode' not in cleanup[name] or type(cleanup[name]['returncode']) is int)
                   and not cleanup[name].get('survivors') for name in ('vite', 'xvfb'))
    teardown = result.get('teardown')
    teardown_ok = isinstance(teardown, dict) and bool(result.get('attemptId')) and result.get('teardownAttemptId') == result.get('attemptId')
    if teardown_ok:
        deletions = teardown.get('sessionDeletes')
        teardown_ok = (teardown.get('complete') is True and teardown.get('driverKilled') is False
                       and isinstance(deletions, list) and bool(deletions)
                       and all(isinstance(row, dict) and row.get('outcome') == 'ok' for row in deletions)
                       and teardown.get('remainingAfterWait') == [] and teardown.get('survivorsAfterSigterm') == []
                       and teardown.get('sigtermErrors') == [] and type(teardown.get('driverExit')) is int
                       and teardown['driverExit'] in (0,-15,143))
    assessment = result.get('oracleAssessment')
    oracle_ok = result.get('oracleEnabled') is not True
    if oracle_ok: result['oracleAssessment'] = {'status':'NOT RUN', 'errors':[]}
    if result.get('oracleEnabled') is True:
        frame = result.get('visibleFrame'); revision = result.get('revisionObservation')
        if isinstance(frame, dict) and isinstance(revision, dict) and isinstance(revision.get('after'), dict):
            checked = assess_oracle(True, frame.get('comparison'), frame.get('attached'), revision['after'].get('modelVersion'), frame.get('modelVersion'), frame.get('revisionStable'), frame.get('completedJobs'))
            candidate = result.get('candidate')
            oracle_ok = (isinstance(assessment, dict) and assessment.get('status') == 'PASS' and assessment.get('errors') == []
                         and checked['status'] == 'PASS' and result.get('fixtureExpectedSha256') == EXPECTED_FIXTURE
                         and result.get('fixtureSha256') == EXPECTED_FIXTURE and result.get('fixtureUnchanged') is True
                         and isinstance(candidate, dict) and candidate.get('wasmSha256') == '0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956')
    ok = bool(observations_complete and not result.get('failures') and required and teardown_ok and oracle_ok)
    result['status'] = 'PARTIAL' if ok else 'FAIL'
    result['executionStatus'] = 'PASS' if ok else 'FAIL'
    result['readinessVerdict'] = 'INCONCLUSIVE'
    result['cleanupScope'] = 'direct Vite/Xvfb plus tauri-smoke XDG-owned processes; Vite descendants not independently tracked'
    result['cleanupStatus'] = ('FAIL' if any(not isinstance(item, dict) or item.get('ok') is not True or ('returncode' in item and type(item['returncode']) is not int) or bool(item.get('survivors')) for item in cleanup.values()) or not teardown_ok else
                               'PASS' if required else 'UNKNOWN')
    return ok


def assess_oracle(enabled, comparison, attached, intended_version, current_version, revision_stable, completed, page=0):
    """Evaluate actual comparison and observed target; never infer equality from verified alone."""
    if not enabled:
        return {'status': 'NOT RUN', 'errors': []}
    errors = []
    if not isinstance(comparison, dict): comparison = {}; errors.append('invalid comparison')
    if comparison.get('verified') is not True: errors.append('comparison not verified')
    if type(comparison.get('pixels')) is not int or comparison.get('pixels') != 0: errors.append('pixel mismatch or invalid count')
    if not isinstance(attached, dict) or type(attached.get('page')) is not int or attached.get('page') != page or attached.get('connected') is not True:
        errors.append('invalid attached page')
    for dimension in ('width', 'height'):
        value = comparison.get(dimension)
        if type(value) is not int or value <= 0 or not isinstance(attached, dict) or type(attached.get(dimension)) is not int or value != attached[dimension]:
            errors.append('invalid or mismatched ' + dimension)
    if revision_stable is not True: errors.append('revision changed')
    if type(intended_version) is not int or current_version != intended_version or type(current_version) is not int:
        errors.append('model version mismatch')
    if not isinstance(completed, list) or not any(isinstance(job, dict) and job.get('event') == 'complete' and job.get('state') == 'COMPLETE' and type(job.get('page')) is int and job.get('page') == page and type(job.get('version')) is int and job.get('version') == intended_version and type(job.get('job')) is int for job in completed):
        errors.append('no matching completed job')
    return {'status': 'FAIL' if errors else 'PASS', 'errors': errors}


def persist_result(result, path):
    """Serialize before writing, then publish by exclusive hard link; preserve complete pending on link failure."""
    result['evidenceStatus'] = 'PASS'; pending = None; created = False; complete = False
    try:
        data = (json.dumps(result, ensure_ascii=True, indent=2, allow_nan=False) + '\n').encode('utf-8')
        path = Path(path)
        fd, pending = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.pending', dir=path.parent)
        created = True
        try:
            stream = os.fdopen(fd, 'wb')
        except Exception:
            os.close(fd); raise
        with stream as output:
            written = output.write(data)
            if written != len(data): raise OSError('short evidence write')
            output.flush(); os.fsync(output.fileno())
        complete = True
        os.link(pending, path)
        try: os.unlink(pending)
        except OSError as error:
            try: print('evidence written; pending copy not removed: ' + str(error), file=sys.stderr)
            except Exception: pass
        return True
    except Exception as error:
        result['evidenceStatus'] = 'FAIL'; result['status'] = 'FAIL'; result['executionStatus'] = 'FAIL'
        failure(result, 'evidence-persistence', error)
        if created and pending and not complete:
            try: os.unlink(pending)
            except OSError: pass
        try:
            print('EVIDENCE_PERSISTENCE_FAILED ' + str(error) + (f'; pending={pending}' if complete else ''), file=sys.stderr)
        except Exception:
            pass
        return False
