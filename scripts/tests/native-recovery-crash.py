#!/usr/bin/env python3
"""T014 B native acceptance: real RHWP WASM checkpoint -> SIGKILL -> fresh launch -> restore -> reopen.

Per format (HWP, HWPX), with an isolated XDG_DATA_HOME (Tauri app_local_data_dir) per format:
  launch 1: open a generated approved fixture copy (tests/fixtures/rhwp/generate.mjs), type a marker through
            native XTest keys, wait for the product's automatic checkpoint (2 s debounce) to report
            `protected`, independently validate the private record on disk (GRR1 header checksum, payload
            hash, format, revision) and reopen its payload with the approved Release WASM, then type one more
            character (newer revision, still `waiting`) and SIGKILL exactly the test-owned app PID.
  launch 2: a fresh app process on the same data directory; RecoveryCenter lists the surviving candidate;
            restoring onto an existing file is refused (real backend, bytes unchanged); restoring through the
            native GTK chooser publishes a new file that opens with the RHWP engine; the published bytes are
            independently reopened with the Release WASM; the source copy is unchanged; the candidate remains.
Run inside the private X11/IBus launcher. No test hooks, no mocked backend/engine, no DOM composition events.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp
sys.path.insert(0, str(ROOT / 'scripts/tests'))
import native_recovery_checks as checks

spec = importlib.util.spec_from_file_location('production_native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

IDENTIFIER = 'io.github.mingyu2.geul'
STATUS = '[data-testid=rhwp-status]'
MARK = 'T014MARK'
SIGNATURE = {'hwp': bytes.fromhex('d0cf11e0a1b11ae1'), 'hwpx': b'PK\x03\x04'}
RESTORE_TITLE = '복구 사본을 새 파일로 복원'

VERIFY = r"""
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [js,wasm,file,expectFormat]=process.argv.slice(1);
const r=await import(pathToFileURL(js));r.initSync({module:readFileSync(wasm)});
const d=new r.HwpDocument(readFileSync(file));
try{const n=d.getParagraphCount(0);
 const paragraphs=Array.from({length:n},(_,p)=>d.getTextRange(0,p,0,d.getParagraphLength(0,p)));
 console.log(JSON.stringify({format:d.getSourceFormat(),pages:d.pageCount(),paragraphs,controls:d.getControls(),expectFormat}));}
finally{d.free();}
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def release_engine():
    build = json.loads((ROOT / 'dist/rhwp/BUILD.json').read_text())
    folder = ROOT / 'dist/rhwp/generations' / build['generation']
    js, wasm = folder / 'rhwp.js', folder / 'rhwp_bg.wasm'
    checks.require(sha(js) == build['artifacts']['rhwp.js'] and sha(wasm) == build['artifacts']['rhwp_bg.wasm'], 'setup',
                   'Release artifacts match dist/rhwp/BUILD.json', {'js': sha(js), 'wasm': sha(wasm)}, build['artifacts'])
    immutable = json.loads((folder / 'BUILD.json').read_text())
    checks.require(checks.canonical(immutable) == checks.canonical(build), 'setup', 'immutable generation metadata equals the selection',
                   immutable, build)
    return {'generation': build['generation'], 'js': str(js), 'wasm': str(wasm), 'manifest': build,
            'jsSha256': sha(js), 'wasmSha256': sha(wasm), 'profile': build['profile']}


# Captured inside the running WebView after the product loaded an RHWP document (see
# native_recovery_checks.compare_runtime_identity). `HwpDocument.createEmpty()` needs an initialized WASM
# instance; the probe never initializes one, and frees the empty model it gets from the running engine.
RUNTIME_IDENTITY = r'''
const hex=async u=>{const r=await fetch(u,{cache:'force-cache'});if(!r.ok)throw Error(u+' '+r.status);
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await r.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('')};
const selected=await (await fetch('/rhwp/BUILD.json',{cache:'no-store'})).json();
const base='/rhwp/generations/'+selected.generation;
const usable=async url=>{const m=await import(url);try{const d=m.HwpDocument.createEmpty();d.free();return {ok:true}}catch(e){return {ok:false,error:String(e).slice(0,120)}}};
const running=await usable(base+'/rhwp.js');
const control=await usable(base+'/rhwp.js?t014-fresh-instance='+Date.now());
return {generation:selected.generation,selected,initialized:running.ok,controlInitialized:control.ok,controlError:control.error??null,
 immutable:await (await fetch(base+'/BUILD.json',{cache:'force-cache'})).json(),
 jsSha256:await hex(base+'/rhwp.js'),wasmSha256:await hex(base+'/rhwp_bg.wasm')};
'''


def runtime_identity(a, engine):
    captured = a.async_js(RUNTIME_IDENTITY)
    if not captured.get('ok'):
        raise checks.CheckError(f'runtime identity probe failed: {captured!r}')
    return checks.compare_runtime_identity(captured['value'], engine)


def wasm_open(engine, path, fmt):
    out = subprocess.run(['node', '--input-type=module', '-e', VERIFY, engine['js'], engine['wasm'], str(path), fmt],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def parse_record(path):
    """Independent reader of the RecoveryStore GRR1 format (recovery.rs): magic, u32 LE header length,
    64 hex SHA-256 of the header JSON, header JSON, payload."""
    data = Path(path).read_bytes()
    if data[:4] != b'GRR1':
        raise checks.CheckError('recovery record magic')
    n = int.from_bytes(data[4:8], 'little')
    checksum, header = data[8:72].decode(), data[72:72 + n]
    if hashlib.sha256(header).hexdigest() != checksum:
        raise checks.CheckError('recovery record header checksum')
    meta = json.loads(header)
    payload = data[72 + n:]
    if hashlib.sha256(payload).hexdigest() != meta['payloadHash']:
        raise checks.CheckError('recovery record payload hash')
    return meta, payload


def app_pids(data_home, app):
    """Exactly the test-owned app process: inherits this scenario's XDG_DATA_HOME and executes the app binary."""
    found = []
    for pid in smoke.pids_with(data_home):
        try:
            if os.path.realpath(f'/proc/{pid}/exe') == os.path.realpath(app):
                found.append(pid)
        except OSError:
            continue
    return found


def gone(pid):
    try:
        state = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
        return state == 'Z'
    except OSError:
        return True


HWP_ONLY_STEPS = ('B4 HWP PrvText stream (CFB) is the regenerated protected revision',
                  'C13 restored HWP PrvText stream is the regenerated protected revision')
REQUIRED_STEPS = (
    'B1 WebView serves the embedded app (tauri: protocol, not a dev URL)',
    'B1 test-owned app process held by pidfd (exe + isolated XDG_DATA_HOME + start time)',
    'B1 running WebView engine is the independent Release generation (initialized module + embedded bytes)',
    'B1 opened with RHWP, ready, clean',
    'B2 marker committed, dirty, no IME transaction',
    'B3 automatic checkpoint protected for the committed revision',
    'B3 debounce: capture began no earlier than ~2 s after the commit',
    'B5 real backend recovery_list',
    'B5 one valid candidate of this format and revision',
    'B5 persistent GRR1 record: checksums, format, revision, generation, original path',
    'B5 record is private (0600, single link)',
    'B4 payload keeps the original container format',
    'B4 Release WASM reopens the record payload with the edit',
    'B4 payload controls structurally equal to the source (parsed getControls JSON, in order)',
    HWP_ONLY_STEPS[0],
    'B6 original bytes unchanged, still dirty, saved revision not advanced, same path',
    'B6 no document file published next to the source',
    'B7 newer revision shown as waiting, not protected',
    'C6/C7 exact app process terminated by SIGKILL through its pidfd',
    'C8 record survived the process boundary',
    'C14 source unchanged after the crash',
    'C8 fresh app process (different PID) on the same isolated data directory',
    'C8 no live session was reused',
    'C9/C10 RecoveryCenter lists the valid candidate from the killed process',
    'C11 restore onto an existing file refused by create-only publication',
    'C12 restored file opened as a new RHWP session, ready and clean',
    'C11 restored file is a new create-only publication',
    'C13 Release WASM reopens the restored file: protected revision content, not the killed newer one',
    'C13 restored controls structurally equal to the source',
    HWP_ONLY_STEPS[1],
    'C12 fresh launch WebView loaded the same independent Release generation',
    'C13 restored bytes equal the validated record payload',
    'C15 candidate retained until explicit discard',
    'C14 source and existing destination unchanged',
    'C16 restored tab closed without a discard prompt',
)


def required_steps(fmt):
    return [name for name in REQUIRED_STEPS if fmt == 'hwp' or name not in HWP_ONLY_STEPS]


@contextlib.contextmanager
def acceptance_launch(args, fmt, phase, data_home, report):
    """Bind the shared driver's actual teardown to the pidfd-verified app launch.

    The shared driver has no launch ID. Its live ACTIVE teardown is extended here,
    rather than synthesizing cleanup evidence or matching by array position.
    """
    launch = {'id': f'{fmt}:{phase}', 'dataHome': str(data_home)}
    report.setdefault('launches', []).append(launch)
    with smoke.tauri_driver(str(args.driver), args.port, str(data_home)) as start:
        teardown = smoke.ACTIVE['teardown']
        teardown.update(launchId=launch['id'], dataHome=str(data_home))
        def identified_start():
            driver = start()
            with checks.OwnedProcess(args.app, str(data_home)) as process:
                identity = {'pid': process.pid, 'startTime': process.start}
                launch.update(identity)
                teardown.update(identity)
            return driver
        yield identified_start


def run_format(args, fmt, engine, report):
    out = args.out / fmt
    out.mkdir()
    data_home = out / 'appdata'
    source = out / f'source.{fmt}'
    shutil.copyfile(args.fixtures / f'basic-ko.{fmt}', source)
    original_sha = sha(source)
    original = wasm_open(engine, source, fmt)
    entry = {'format': fmt, 'sourceSha256': original_sha, 'sourceParagraph0': original['paragraphs'][0], 'steps': []}
    report['formats'].append(entry)

    # Explicit exceptions (never `assert`): a FAIL stops the scenario under `python -O` as well.
    step = checks.Steps(entry, fmt)

    record_dir = data_home / IDENTIFIER / 'recovery'
    # ---------------- launch 1 ----------------
    smoke.DRIVER_LOG = str(out / 'driver-1.log')
    killed = None
    with contextlib.ExitStack() as owned_stack, acceptance_launch(args, fmt, 'launch1', data_home, report) as start:
        d = start()
        try:
            a = base.Acceptance(args, d, report)
            smoke.wait_until(d, 'return document.readyState==="complete"', timeout=30)
            step('B1 WebView serves the embedded app (tauri: protocol, not a dev URL)', d.js('return location.protocol') == 'tauri:',
                 d.js('return location.origin'))
            smoke.wait_until(d, 'return !!document.querySelector(".document-bar") && !!document.querySelector("[data-testid=recovery-center]")', timeout=30)
            # A pidfd-held reference to exactly this scenario's app process, kept until the intended SIGKILL.
            process = owned_stack.enter_context(checks.OwnedProcess(args.app, str(data_home)))
            step('B1 test-owned app process held by pidfd (exe + isolated XDG_DATA_HOME + start time)', process.alive(),
                 {'pid': process.pid, 'startTime': process.start})
            first_pid = process.pid
            a.open(fmt, source)
            identity = runtime_identity(a, engine)
            step('B1 running WebView engine is the independent Release generation (initialized module + embedded bytes)', True, identity)
            entry['runtimeIdentity'] = {'launch1': identity}
            session = next(s for s in a.sessions() if s['displayName'] == source.name)
            step('B1 opened with RHWP, ready, clean', session['engine'] == 'rhwp' and session['format'] == fmt
                 and session['state'] == 'ready' and session['dirty'] is False, session)
            entry['session'] = {k: session[k] for k in ('sessionId', 'loadGeneration', 'revision')}
            sid = session['sessionId']
            a.engine('xkb:us::eng')
            rhwp.click_paragraph_start(d)
            a.type(MARK)
            a.wait('const s=document.querySelector(arguments[0]);return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision && s.dataset.dirty==="true"', STATUS)
            status = a.status(fmt)
            revision = int(status['revision'])
            step('B2 marker committed, dirty, no IME transaction', revision == len(MARK) and status['dirty'] == 'true'
                 and status['composing'] == 'false', status)
            committed_at = time.monotonic()
            selector = f'[data-testid=recovery-checkpoint-{sid}]'
            states = []
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                row = d.js('const e=document.querySelector(arguments[0]);return e?{...e.dataset}:null', selector)
                observed = (row or {}).get('state'), (row or {}).get('revision')
                if not states or states[-1][:2] != observed:
                    states.append((*observed, round(time.monotonic() - committed_at, 2)))
                if row and row.get('state') in ('protected', 'failed', 'unsupported') and row.get('revision') == str(revision):
                    break
                time.sleep(0.05)
            entry['checkpointStates'] = states
            capturing = next((t for s, r, t in states if s == 'capturing'), None)
            step('B3 automatic checkpoint protected for the committed revision',
                 states[-1][0] == 'protected' and states[-1][1] == str(revision), states)
            step('B3 debounce: capture began no earlier than ~2 s after the commit', capturing is not None and capturing >= 1.8, capturing)
            listed = a.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
            step('B5 real backend recovery_list', listed['ok'], listed)
            candidates = [c for c in listed['value'] if c['valid'] and c['format'] == fmt and c['revision'] == revision]
            step('B5 one valid candidate of this format and revision', len(candidates) == 1, listed['value'])
            candidate = candidates[0]
            files = sorted(p.name for p in record_dir.iterdir())
            record = record_dir / candidate['id']
            meta, payload = parse_record(record)
            step('B5 persistent GRR1 record: checksums, format, revision, generation, original path',
                 meta['format'] == fmt and meta['revision'] == revision and meta['generation'] == session['loadGeneration']
                 and meta['original'] == str(source) and meta['target'] == str(source), {'files': files, 'header': {k: meta[k] for k in ('format', 'revision', 'generation')}})
            step('B5 record is private (0600, single link)', (record.stat().st_mode & 0o777) == 0o600 and record.stat().st_nlink == 1)
            (out / f'record-payload.{fmt}').write_bytes(payload)
            step('B4 payload keeps the original container format', payload.startswith(SIGNATURE[fmt]))
            reopened = wasm_open(engine, out / f'record-payload.{fmt}', fmt)
            step('B4 Release WASM reopens the record payload with the edit', reopened['format'] == fmt
                 and reopened['paragraphs'][0] == MARK + original['paragraphs'][0]
                 and reopened['paragraphs'][1:] == original['paragraphs'][1:], {k: reopened[k] for k in ('format', 'pages', 'paragraphs')})
            controls = checks.compare_controls(original['controls'], reopened['controls'])
            step('B4 payload controls structurally equal to the source (parsed getControls JSON, in order)', True,
                 [c['ctrlId'] for c in controls])
            if fmt == 'hwp':
                preview = checks.check_regenerated_prv_text(source.read_bytes(), payload, MARK)
                step('B4 HWP PrvText stream (CFB) is the regenerated protected revision', True, preview)
            entry['candidate'] = {'id': candidate['id'], 'revision': revision, 'recordSha256': sha(record), 'payloadSha256': hashlib.sha256(payload).hexdigest()}
            sessions = a.sessions()
            now = next(s for s in sessions if s['sessionId'] == sid)
            step('B6 original bytes unchanged, still dirty, saved revision not advanced, same path',
                 sha(source) == original_sha and now['dirty'] is True and now['revision'] == revision and now['displayName'] == source.name, now)
            step('B6 no document file published next to the source', sorted(p.name for p in out.iterdir() if p.name.startswith('.geul-save-')) == [])
            # A newer committed revision is not represented as protected by the older record.
            a.type('Z')
            a.wait('const s=document.querySelector(arguments[0]);return s?.dataset.localRevision===s.dataset.revision && Number(s.dataset.revision)===arguments[1]', STATUS, revision + 1)
            row = d.js('const e=document.querySelector(arguments[0]);return e?{...e.dataset}:null', selector)
            step('B7 newer revision shown as waiting, not protected', row and row['state'] == 'waiting' and row['revision'] == str(revision + 1), row)
            # SIGKILL exactly the pidfd-held app process before the newer revision's debounce elapses.
            killed = {**process.kill(), 'atRevision': revision + 1, 'protectedRevision': revision}
            step('C6/C7 exact app process terminated by SIGKILL through its pidfd', not process.alive() and gone(first_pid), killed)
        except Exception:
            try:
                d.screenshot(out / 'launch1-failure.png')
            except Exception:
                pass
            raise
        finally:
            try:
                smoke.end_session(d)
            except Exception as error:
                entry['launch1SessionEnd'] = type(error).__name__ + ' (expected after SIGKILL)' if killed else str(error)
    listing = sorted(p.name for p in record_dir.iterdir())
    step('C8 record survived the process boundary', candidate['id'] in listing, listing)
    step('C14 source unchanged after the crash', sha(source) == original_sha)
    # ---------------- launch 2 ----------------
    smoke.DRIVER_LOG = str(out / 'driver-2.log')
    existing = out / f'existing.{fmt}'
    existing.write_bytes(b'existing destination must not be overwritten')
    existing_sha = sha(existing)
    destination = out / f'restored.{fmt}'
    with acceptance_launch(args, fmt, 'launch2', data_home, report) as start:
        d = start()
        try:
            a = base.Acceptance(args, d, report)
            smoke.wait_until(d, 'return !!document.querySelector("[data-testid=recovery-center]")', timeout=30)
            pids = app_pids(str(data_home), args.app)
            step('C8 fresh app process (different PID) on the same isolated data directory', len(pids) == 1 and pids[0] != killed['pid'], pids)
            step('C8 no live session was reused', a.sessions() == [])
            d.js('document.querySelector("[data-testid=recovery-refresh]").click()')
            item = f'[data-testid=recovery-candidate][data-recovery-id="{candidate["id"]}"]'
            a.wait('const e=document.querySelector(arguments[0]);return e?.dataset.valid==="true"', item)
            step('C9/C10 RecoveryCenter lists the valid candidate from the killed process', True,
                 d.js('return document.querySelector(arguments[0]).textContent', item))
            refused = a.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_restore',{id:arguments[0],path:arguments[1]})", candidate['id'], str(existing))
            step('C11 restore onto an existing file refused by create-only publication', not refused['ok']
                 and 'FileConflict' in json.dumps(refused['error']) and sha(existing) == existing_sha, refused)
            d.js('document.querySelector(arguments[0]).click()', f'[data-testid="recovery-restore-{candidate["id"]}"]')
            a.chooser(destination, RESTORE_TITLE)
            a.ready(fmt, destination.name)
            restored_session = next(s for s in a.sessions() if s['displayName'] == destination.name)
            step('C12 restored file opened as a new RHWP session, ready and clean',
                 restored_session['engine'] == 'rhwp' and restored_session['format'] == fmt
                 and restored_session['state'] == 'ready' and restored_session['dirty'] is False, restored_session)
            step('C11 restored file is a new create-only publication', destination.exists() and destination.read_bytes().startswith(SIGNATURE[fmt]))
            restored = wasm_open(engine, destination, fmt)
            step('C13 Release WASM reopens the restored file: protected revision content, not the killed newer one',
                 restored['format'] == fmt and restored['paragraphs'][0] == MARK + original['paragraphs'][0]
                 and restored['paragraphs'][1:] == original['paragraphs'][1:], {k: restored[k] for k in ('format', 'pages', 'paragraphs')})
            checks.compare_controls(original['controls'], restored['controls'])
            step('C13 restored controls structurally equal to the source', True)
            if fmt == 'hwp':
                step('C13 restored HWP PrvText stream is the regenerated protected revision', True,
                     checks.check_regenerated_prv_text(source.read_bytes(), destination.read_bytes(), MARK))
            identity = runtime_identity(a, engine)
            step('C12 fresh launch WebView loaded the same independent Release generation', True, identity)
            entry['runtimeIdentity']['launch2'] = identity
            step('C13 restored bytes equal the validated record payload', sha(destination) == entry['candidate']['payloadSha256'])
            d.screenshot(out / 'restored.png')
            listed = a.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
            step('C15 candidate retained until explicit discard', listed['ok'] and any(c['id'] == candidate['id'] for c in listed['value']), listed)
            step('C14 source and existing destination unchanged', sha(source) == original_sha and sha(existing) == existing_sha)
            step('C16 restored tab closed without a discard prompt', rhwp.close_tab(d, destination.name))
            entry['restored'] = {'sha256': sha(destination), 'paragraph0': restored['paragraphs'][0], 'session': restored_session['sessionId']}
        except Exception:
            try:
                d.screenshot(out / 'launch2-failure.png')
                entry['failureDom'] = d.js('return document.body.innerText.slice(-3000)')
            except Exception:
                pass
            raise
        finally:
            smoke.end_session(d)
    entry['status'] = 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'fixtures'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--port', type=int, default=4444)
    parser.add_argument('--app-sha256', required=True, help='expected SHA-256 of the embedded production app')
    parser.add_argument('--formats', nargs='+', default=['hwp', 'hwpx'])
    args = parser.parse_args()
    args.out, args.fixtures, args.app = args.out.resolve(), args.fixtures.resolve(), args.app.resolve()
    # A plain `cargo test`/`build` without tauri/custom-protocol replaces the same debug path with a dev-URL
    # binary; never run the destructive scenario against an unexpected executable.
    if sha(args.app) != args.app_sha256:
        raise SystemExit(f'app SHA-256 {sha(args.app)} != expected {args.app_sha256}; rebuild the embedded app')
    args.out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(args.app)
    engine = release_engine()
    head = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(['git', '-C', str(ROOT), 'status', '--porcelain'], capture_output=True, text=True).stdout.splitlines()
    report = {'status': 'RUNNING', 'sourceHead': head, 'sourceDirty': dirty, 'appSha256': sha(args.app),
              'harnessSha256': sha(__file__), 'checksSha256': sha(ROOT / 'scripts/tests/native_recovery_checks.py'),
              'engine': {k: v for k, v in engine.items() if k != 'manifest'}, 'fixtures': {
        p.name: sha(p) for p in sorted(args.fixtures.iterdir())}, 'formats': [],
        'scope': 'embedded production app; real RHWP Release WASM; actual Rust checkpoint/RecoveryStore; native XTest; SIGKILL of the exact test-owned app PID'}
    try:
        for fmt in args.formats:
            run_format(args, fmt, engine, report)
    except Exception as error:
        traceback.print_exc()
        report['error'] = type(error).__name__ + ': ' + str(error)
    report['teardown'] = smoke.TEARDOWN
    # The overall result is derived from the recorded evidence, never set optimistically.
    report['status'], report['problems'] = checks.overall(report, {fmt: required_steps(fmt) for fmt in ('hwp', 'hwpx')})
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + '\n')
    print(f"overall {report['status']}" + ''.join('\n  ' + p for p in report['problems']))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
