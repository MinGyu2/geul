#!/usr/bin/env python3
"""T014: real native save -> debugger publication boundary -> pidfd SIGKILL -> startup cleanup.

Run in native-ibus-session.py. Requires an embedded custom-protocol debug app
(with DWARF), GDB Python support and the existing local tests/ native harness.
No product hook, preload, fake backend, fabricated positive journal, or timing crash.
GDB only observes cleanup and stops at the real publish() entry. It never calls
product functions, changes registers/variables, or skips save validation.
"""
import argparse
import contextlib
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('recovery_crash', Path(__file__).with_name('native-recovery-crash.py'))
crash = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crash)
checks, smoke, base, rhwp = crash.checks, crash.smoke, crash.base, crash.rhwp
sha = crash.sha
CASES = (('hwp', 'owned'), ('hwpx', 'owned'), ('hwpx', 'active'), ('hwpx', 'replaced'),
         ('hwpx', 'intent'), ('hwpx', 'corrupt'), ('hwpx', 'missing'), ('hwpx', 'untrusted'))
COMMON = ('embedded origin', 'real runtime engine', 'supported edit', 'publication boundary',
          'complete real ownership', 'owner holds lock', 'original not published',
          'fresh startup cleanup completed', 'negative candidates preserved', 'original finally unchanged')
INTERRUPTED = ('pidfd SIGKILL and lock release', 'post-crash original unchanged', 'cleanup filesystem and durability')
ACTIVE = ('startup preserves active owner', 'active owner finally SIGKILL')


def wait_file(path, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return json.loads(path.read_text())
        time.sleep(.05)
    raise checks.CheckError(f'timed out waiting for debugger evidence: {path}')


def identity(path):
    m = path.lstat()
    return {'dev': m.st_dev, 'ino': m.st_ino, 'size': m.st_size, 'mode': m.st_mode & 0o777,
            'uid': m.st_uid, 'nlink': m.st_nlink, 'sha256': sha(path)}


def read_ownership(record):
    lines = record.read_bytes().splitlines(keepends=True)
    checks.require(len(lines) == 2 and all(line.endswith(b'\n') for line in lines), 'setup', 'complete journal lines', lines)
    values = []
    for line in lines:
        payload, digest = line[:-1].rsplit(b'\t', 1)
        import hashlib
        checks.require(hashlib.sha256(payload).hexdigest().encode() == digest, 'setup', 'journal checksum')
        values.append(json.loads(payload))
    intent, created = values
    checks.require(set(intent) == {'v', 'dir', 'dirDev', 'dirIno', 'name', 'createdAt'} and intent['v'] == 1
                   and set(created) == {'dev', 'ino'}, 'setup', 'journal schema', values)
    return intent, created


def locked(record):
    with record.open('rb') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(f, fcntl.LOCK_UN)
        return False


def debugger_wrapper(args, out, phase):
    """An external GDB script, not compiled into or activated by the product."""
    boundary, gate, cleanup = (out / f'{phase}-{n}' for n in ('boundary.json', 'release', 'cleanup.json'))
    journal = ROOT / 'src-tauri/src/services/save/journal.rs'
    text = journal.read_text()
    pos = text.index('\n    report\n}', text.index('pub fn cleanup()'))
    line = text[:pos].count('\n') + 2
    early = [n for n, value in enumerate(text.splitlines(), 1)
             if text[:text.index('pub fn cleanup()')].count('\n') + 1 < n < line and value.strip() == 'return report;']
    script = out / f'{phase}.gdb'
    script.write_text('''set pagination off
set confirm off
set debuginfod enabled off
set startup-with-shell off
set disable-randomization off
handle SIGPIPE nostop noprint pass
handle SIGUSR1 nostop noprint pass
handle SIGUSR2 nostop noprint pass
python
import gdb, json, os, time
from pathlib import Path
''' + f'boundary=Path({str(boundary)!r})\ngate=Path({str(gate)!r})\ncleanup=Path({str(cleanup)!r})\n' + '''
def write_json(path, value):
    temporary = path.with_suffix('.writing')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)
class Cleanup(gdb.Breakpoint):
    def stop(self):
        value = gdb.parse_and_eval('report')
        counts = {k:int(value[k]) for k in ('removed','retired','active','unverified','failed')}
        write_json(cleanup, {'pid':gdb.selected_inferior().pid, 'counts':counts,
                            'boundary':'cleanup final report after all unlink/fsync/retirement results'})
        return False
class Publication(gdb.Breakpoint):
    def stop(self):
        frame = gdb.selected_frame()
        write_json(boundary, {'pid':gdb.selected_inferior().pid, 'function':frame.name(),
                              'thread':gdb.selected_thread().ptid, 'backtrace':gdb.execute('bt 8', to_string=True),
                              'boundary':'publish entry: stage returned verified bytes; before renameat'})
        # All-stop inferior remains stopped until the harness sends SIGKILL.
        # A bounded wait is only a failure limit, never a timing-based crash.
        deadline = time.monotonic() + 120
        while not gate.exists():
            if time.monotonic() > deadline:
                gdb.execute('kill')
                raise RuntimeError('publication gate timed out; acceptance must fail')
            time.sleep(.05)
        return False
''' + ''.join(f'Cleanup({str(journal) + ":" + str(n)!r})\n' for n in [line, *early]) +
                      ("Publication('geul_lib::services::save::publish::publish')\n" if phase == 'owner' else '') +
                      'end\nrun\nquit\n')
    wrapper = out / f'{phase}-app.sh'
    wrapper.write_text('#!/bin/sh\nexport XDG_DATA_HOME=' + shlex.quote(str(out / 'appdata')) + '\nexport GEUL_NATIVE_ACCEPTANCE_LAUNCH=' + shlex.quote(str(out / phase)) + '\nexec ' + ' '.join(shlex.quote(str(p)) for p in
                       (args.gdb, '--nx', '--batch', '-x', script, '--args', args.app)) + ' "$@"\n')
    wrapper.chmod(0o700)
    return wrapper, boundary, gate, cleanup


@contextlib.contextmanager
def launch(args, key, phase, home, wrapper, out, report, exclude=()):
    """Extend the actual shared teardown with pidfd-checked process identity."""
    item = {'id': f'{key}:{phase}', 'dataHome': str(home)}
    report.setdefault('launches', []).append(item)
    smoke.APP = str(wrapper)
    smoke.DRIVER_LOG = str(out / f'{phase}-driver.log')
    driver_home = out / (phase + '-driver-data')
    with smoke.tauri_driver(str(args.driver), args.port, str(driver_home)) as start:
        teardown = smoke.ACTIVE['teardown']
        teardown.update(launchId=item['id'], dataHome=str(home), driverDataHome=str(driver_home))
        d = start()
        try:
            with checks.OwnedProcess(args.app, str(home), proc_ids=lambda: [p for p in smoke.pids_with(str(home)) if p not in exclude]) as process:
                ident = {'pid': process.pid, 'startTime': process.start}
                item.update(ident)
                teardown.update(ident)
            yield d
        finally:
            # The isolated driver has its own marker; the actual app/descendants
            # use a launch marker so an intentionally active other instance cannot
            # substitute for or interfere with this launch's teardown.
            if any(p not in exclude for p in crash.app_pids(str(home), args.app)):
                smoke.end_session(d)
            marker = f'GEUL_NATIVE_ACCEPTANCE_LAUNCH={out / ("owner" if phase == "launch1" else "fresh")}'.encode()
            deadline = time.monotonic() + 30
            while True:
                remaining = []
                for proc in Path('/proc').iterdir():
                    if proc.name.isdigit():
                        with contextlib.suppress(OSError):
                            if marker in (proc / 'environ').read_bytes().split(b'\0'):
                                remaining.append(int(proc.name))
                if not remaining or time.monotonic() > deadline:
                    break
                time.sleep(.1)
            teardown['appDescendantsAfterWait'] = smoke.process_rows(remaining)
            if remaining:
                teardown['complete'] = False
                raise checks.CheckError(f'app descendants survived: {remaining}')


def kill_owner(process, gate):
    # Release GDB only AFTER successful SIGKILL delivery: no opportunity to resume publication.
    def send(fd, sig):
        signal.pidfd_send_signal(fd, sig)
        gate.write_text('SIGKILL delivered through the held pidfd\n')
    process._send = send
    return process.kill()


def run_case(args, fmt, variant, engine, report):
    key = f'{fmt}-{variant}'
    out = args.out / key
    out.mkdir(mode=0o700)
    home = out / 'appdata'
    source = out / f'source.{fmt}'
    shutil.copyfile(args.fixtures / f'basic-ko.{fmt}', source)
    original = identity(source)
    row = {'format': key, 'documentFormat': fmt, 'variant': variant, 'status': 'RUNNING', 'steps': [], 'original': original}
    report['formats'].append(row)
    step = checks.Steps(row, key)
    owner_app, boundary_path, gate, _ = debugger_wrapper(args, out, 'owner')
    fresh_app, _, _, cleanup_path = debugger_wrapper(args, out, 'fresh')
    foreign = out / '.geul-save-unowned.tmp'
    foreign.write_bytes(b'foreign unowned staging candidate: never delete by name')
    foreign_before = identity(foreign)
    preserved = {str(foreign): foreign_before}
    journal_dir = home / crash.IDENTIFIER / 'save-journal'
    killed = False
    with launch(args, key, 'launch1', home, owner_app, out, report) as d:
        with checks.OwnedProcess(args.app, str(home)) as process:
            try:
                a = base.Acceptance(args, d, report)
                a.wait('return !!document.querySelector(".document-bar")')
                step('embedded origin', d.js('return location.protocol') == 'tauri:', d.js('return location.origin'))
                a.open(fmt, source)
                row['runtimeIdentity'] = crash.runtime_identity(a, engine)
                step('real runtime engine', True, row['runtimeIdentity'])
                session = next(s for s in a.sessions() if s['displayName'] == source.name)
                a.engine('xkb:us::eng')
                rhwp.click_paragraph_start(d)
                a.type(crash.MARK)
                a.wait('const e=document.querySelector(arguments[0]);return e?.dataset.composing==="false" && e.dataset.dirty==="true" && e.dataset.localRevision===e.dataset.revision', crash.STATUS)
                edited = a.status(fmt)
                step('supported edit', session['engine'] == 'rhwp' and session['state'] == 'ready' and session['dirty'] is False
                     and int(edited['revision']) > session['revision'], edited)
                a.key('ctrl+s')
                boundary = wait_file(boundary_path)
                step('publication boundary', boundary['pid'] == process.pid
                     and boundary['function'] == 'geul_lib::services::save::publish::publish', boundary)
                row['boundary'] = boundary
                records = list(journal_dir.glob('*.save'))
                checks.require(len(records) == 1, key, 'one real journal record', [str(p) for p in records])
                record = records[0]
                intent, created = read_ownership(record)
                staged = out / intent['name']
                staged_before = identity(staged)
                record_before = identity(record)
                directory = out.stat()
                step('complete real ownership', intent['dir'] == str(out) and (intent['dirDev'], intent['dirIno']) == (directory.st_dev, directory.st_ino)
                     and (created['dev'], created['ino']) == (staged_before['dev'], staged_before['ino'])
                     and record_before['mode'] == 0o600 and record_before['uid'] == os.geteuid() and record_before['nlink'] == 1
                     and staged_before['sha256'] != original['sha256'] and staged_before['size'] > 0,
                     {'intent': intent, 'created': created, 'staging': staged_before, 'record': record_before})
                # Independent engine reopens the actual save-created staging bytes with the edit.
                reopened = crash.wasm_open(engine, staged, fmt)
                checks.require(reopened['format'] == fmt and reopened['paragraphs'][0].startswith(crash.MARK), key, 'real staged edit reopens', reopened)
                row['staging'] = {'path': str(staged), **staged_before}
                row['record'] = {'path': str(record), **record_before}
                shutil.copyfile(record, out / 'ownership-before.save-evidence')
                step('owner holds lock', locked(record), {'pid': process.pid, 'lockBlocked': True})
                # Bind the lock to an actual fd in this exact owner, not another process.
                fds = []
                for fd in Path(f'/proc/{process.pid}/fd').iterdir():
                    with contextlib.suppress(OSError):
                        if fd.stat().st_ino == record_before['ino'] and fd.stat().st_dev == record_before['dev']:
                            fds.append(int(fd.name))
                checks.require(bool(fds), key, 'owner has the journal fd', fds)
                row['ownerJournalFds'] = fds
                step('original not published', identity(source) == original, identity(source))
                if variant != 'active':
                    row['kill'] = kill_owner(process, gate)
                    killed = True
                    step('pidfd SIGKILL and lock release', not process.alive() and crash.gone(process.pid) and not locked(record), row['kill'])
                    step('post-crash original unchanged', identity(source) == original, identity(source))
                    if variant == 'replaced':
                        staged.rename(out / 'retained-real-staging')
                        staged.write_bytes(b'foreign replacement inode; not owned by geul')
                        preserved[str(staged)] = identity(staged)
                    elif variant == 'intent':
                        record.write_bytes(record.read_bytes().splitlines(keepends=True)[0])
                        preserved[str(staged)] = staged_before
                    elif variant == 'corrupt':
                        record.write_bytes(record.read_bytes() + b'corrupt trailing content\n')
                        preserved[str(staged)] = staged_before
                    elif variant == 'missing':
                        journal_dir.rename(out / 'retained-missing-journal')
                        journal_dir.mkdir(mode=0o700)
                        preserved[str(staged)] = staged_before
                    elif variant == 'untrusted':
                        journal_dir.chmod(0o755)
                        preserved[str(staged)] = staged_before
                # Fresh startup (active owner uses another WebDriver port).
                fresh_args = copy.copy(args)
                fresh_args.port += 10
                with launch(fresh_args, key, 'launch2', home, fresh_app, out, report, exclude=(process.pid,)) as fresh:
                    b = base.Acceptance(fresh_args, fresh, report)
                    b.wait('return !!document.querySelector(".document-bar")')
                    fresh_pid = report['launches'][-1]['pid']
                    cleanup = wait_file(cleanup_path)
                    counts = cleanup['counts']
                    row['startupCleanup'] = cleanup
                    step('fresh startup cleanup completed', cleanup['pid'] == fresh_pid and fresh_pid != process.pid
                         and counts['failed'] == 0 and fresh.js('return location.protocol') == 'tauri:', cleanup)
                    if variant == 'active':
                        step('startup preserves active owner', counts['active'] == 1 and counts['removed'] == 0
                             and identity(staged) == staged_before and record.exists() and locked(record) and process.alive(), counts)
                    else:
                        expected_removed = 1 if variant == 'owned' else 0
                        expected_unverified = 1 if variant in ('intent', 'corrupt') else 0
                        step('cleanup filesystem and durability', counts['removed'] == expected_removed
                             and counts['unverified'] == expected_unverified
                             and staged.exists() == (variant != 'owned')
                             and record.exists() == (variant in ('intent', 'corrupt', 'untrusted')),
                             {'counts': counts, 'stagingExists': staged.exists(), 'recordExists': record.exists()})
                    step('negative candidates preserved', all(Path(p).exists() and identity(Path(p)) == before for p, before in preserved.items()), preserved)
                if variant == 'active':
                    row['kill'] = kill_owner(process, gate)
                    killed = True
                    step('active owner finally SIGKILL', not process.alive() and not locked(record), row['kill'])
            finally:
                if process.alive():
                    row['emergencyKill'] = kill_owner(process, gate)
                if not killed:
                    row['interruptionCompleted'] = False
    step('original finally unchanged', identity(source) == original, identity(source))
    row['finalOriginal'] = identity(source)
    row['status'] = 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'fixtures', 'gdb'):
        parser.add_argument('--' + name, type=Path, required=True)
    for name in ('xdotool', 'ibus', 'app-sha256'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--port', type=int, default=4460)
    parser.add_argument('--cases', nargs='+', choices=[f'{f}-{v}' for f, v in CASES],
                        help='diagnostic subset; missing mandatory cases still yields FAIL')
    args = parser.parse_args()
    for name in ('app', 'driver', 'out', 'fixtures', 'gdb'):
        setattr(args, name, getattr(args, name).resolve())
    checks.require(sha(args.app) == args.app_sha256, 'setup', 'exact embedded executable SHA-256', sha(args.app), args.app_sha256)
    args.out.mkdir(parents=True, exist_ok=False)
    engine = crash.release_engine()
    report = {'status': 'RUNNING', 'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'sourceDirty': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).splitlines(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__), 'checksSha256': sha(checks.__file__),
              'driverSha256': sha(args.driver), 'gdbSha256': sha(args.gdb), 'formats': [], 'launches': [],
              'engine': engine, 'scope': 'HWP/HWPX real replacement saves; GDB observer only; no product instrumentation',
              'productSources': {str(p.relative_to(ROOT)): sha(p) for p in sorted((ROOT / 'src-tauri/src').rglob('*.rs'))},
              'submodules': subprocess.check_output(['git', 'submodule', 'status'], cwd=ROOT, text=True).splitlines()}
    smoke.TEARDOWN.clear()
    try:
        for fmt, variant in CASES:
            if args.cases and f'{fmt}-{variant}' not in args.cases:
                continue
            run_case(args, fmt, variant, engine, report)
    except Exception as error:
        traceback.print_exc()
        report['error'] = type(error).__name__ + ': ' + str(error)
    report['teardown'] = smoke.TEARDOWN
    for teardown in report['teardown']:
        if teardown.get('appDescendantsAfterWait') != []:
            teardown['complete'] = False
    required = {f'{fmt}-{variant}': list(COMMON + (ACTIVE if variant == 'active' else INTERRUPTED)) for fmt, variant in CASES}
    report['status'], report['problems'] = checks.overall(report, required)
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('overall', report['status'], *report['problems'], sep='\n')
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
