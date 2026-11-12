"""Attach run/session ownership to existing smoke cleanup; never perform duplicate cleanup.

The supported T010 harnesses use exactly one WebDriver session per driver context.
The helper's sole sessionDeletes record therefore belongs to that recorded session.
"""
import contextlib
import hashlib
from pathlib import Path


def running_application(smoke, app):
    rows = []
    for pid in smoke.pids_with(smoke.ACTIVE['data_home']):
        try:
            exe = Path(f'/proc/{pid}/exe')
            if exe.resolve() != Path(app).resolve():
                continue
            rows.append({'pid': pid, 'startTime': Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19],
                         'sha256': hashlib.sha256(exe.read_bytes()).hexdigest(),
                         'testFlags': sorted(v.split(b'=', 1)[0].decode() for v in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if v.startswith(b'VITE_GEUL_TEST_'))})
        except (OSError, IndexError):
            continue
    return rows


@contextlib.contextmanager
def driver(smoke, path, port, data_home, report):
    offset = len(smoke.TEARDOWN)
    try:
        with smoke.tauri_driver(path, port, data_home) as start:
            record = smoke.ACTIVE['teardown']
            record.update(runId=report['runId'], dataHome=str(data_home), driverPid=smoke.ACTIVE['driver'].pid, sessionIds=[])

            def begin():
                d = start()
                record['sessionIds'].append(d.session)
                report.setdefault('sessions', []).append({k: record[k] for k in ('runId', 'dataHome', 'driverPid')} | {'sessionId': d.session})
                report['runningApplication'] = running_application(smoke, smoke.APP)
                return d
            yield begin
    finally:
        report['teardown'] = smoke.TEARDOWN[offset:]
