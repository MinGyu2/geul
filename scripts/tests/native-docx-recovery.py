#!/usr/bin/env python3
"""T014 DOCX native automatic checkpoint -> pidfd SIGKILL -> fresh WordCraft restore.

Uses the existing isolated native launcher and recovery lifecycle helpers. No
RHWP engine, test-hook build, simulated composition, or fabricated record covers
DOCX. Independent ZIP/GRR1 observations and fresh WordCraft model loads are kept
separate. Run inside native-ibus-session.py with generated test fixtures only.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import traceback
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location('recovery_crash', Path(__file__).with_name('native-recovery-crash.py'))
crash = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crash)
checks, smoke, base = crash.checks, crash.smoke, crash.base
sha = crash.sha
STATUS = '[data-testid=docx-status]'
REQUIRED = (
    'embedded WordCraft ready clean', 'committed dirty revision',
    'automatic checkpoint protects exact revision', 'private validated GRR1 payload',
    'checkpoint preserves original and dirty revision', 'newer revision not protected',
    'pidfd SIGKILL of exact owner', 'record and original survive SIGKILL',
    'fresh process discovers candidate', 'fresh WordCraft validates payload before restore',
    'existing destination rejected', 'create-only restore opens clean WordCraft session',
    'restored payload and committed content match', 'original and existing destination preserved',
    'candidate retained until explicit discard', 'restored tab closes cleanly',
)


def paragraphs(path):
    """Read actual document.xml paragraph text; never a substring search in ZIP bytes."""
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read('word/document.xml'))
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    return [''.join(t.text or '' for t in p.findall('.//w:t', ns)) for p in root.findall('.//w:p', ns)]


def view(a, session):
    result = a.async_js("return await window.__TAURI_INTERNALS__.invoke('docx_view',"
                        "{sessionId:arguments[0],loadGeneration:arguments[1]})",
                        session['sessionId'], session['loadGeneration'])
    checks.require(result.get('ok'), 'docx', 'real WordCraft view', result)
    return result['value']


def run(args, report):
    out = args.out
    home = out / 'appdata'
    source = out / 'source.docx'
    shutil.copyfile(args.fixtures / 'basic-ko.docx', source)
    original = paragraphs(source)
    original_sha = sha(source)
    entry = {'format': 'docx', 'status': 'RUNNING', 'steps': [], 'originalSha256': original_sha}
    report['formats'].append(entry)
    step = checks.Steps(entry, 'docx')
    record_dir = home / crash.IDENTIFIER / 'recovery'
    killed = None
    with crash.acceptance_launch(args, 'docx', 'launch1', home, report) as start:
        d = start()
        try:
            a = base.Acceptance(args, d, report)
            a.wait('return !!document.querySelector(".document-bar")')
            a.open('docx', source)
            session = next(s for s in a.sessions() if s['displayName'] == source.name)
            step('embedded WordCraft ready clean', d.js('return location.protocol') == 'tauri:'
                 and session['engine'] == 'wordcraft' and session['state'] == 'ready'
                 and session['dirty'] is False and view(a, session)['view']['paragraphText'] == original[0], session)
            with checks.OwnedProcess(args.app, str(home)) as process:
                a.engine('xkb:us::eng')
                base.wordcraft_poc.click_paragraph_start(d)
                a.type(crash.MARK)
                a.wait('const e=document.querySelector(arguments[0]);return e?.dataset.pending==="0" && e.dataset.composing==="false" && e.dataset.dirty==="true"', STATUS)
                current = view(a, session)
                revision = current['session']['revision']
                step('committed dirty revision', revision > session['revision']
                     and current['view']['paragraphText'] == crash.MARK + original[0], current['session'])
                selector = f'[data-testid=recovery-checkpoint-{session["sessionId"]}]'
                a.wait('const e=document.querySelector(arguments[0]);return e?.dataset.state==="protected" && Number(e.dataset.revision)===arguments[1]', selector, revision, timeout=40)
                listed = a.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
                checks.require(listed.get('ok'), 'docx', 'recovery_list', listed)
                candidates = [c for c in listed['value'] if c['valid'] and c['format'] == 'docx' and c['revision'] == revision]
                step('automatic checkpoint protects exact revision', len(candidates) == 1, listed)
                candidate = candidates[0]
                record = record_dir / candidate['id']
                meta, payload = crash.parse_record(record)
                payload_path = out / 'record-payload.docx'
                payload_path.write_bytes(payload)
                expected = [crash.MARK + original[0], *original[1:]]
                stat = record.stat()
                step('private validated GRR1 payload', meta['format'] == 'docx' and meta['revision'] == revision
                     and meta['generation'] == session['loadGeneration'] and meta['original'] == str(source)
                     and meta['target'] == str(source) and stat.st_mode & 0o777 == 0o600
                     and stat.st_uid == os.geteuid() and stat.st_nlink == 1 and paragraphs(payload_path) == expected,
                     {'header': meta, 'recordSha256': sha(record), 'payloadSha256': sha(payload_path)})
                now = next(s for s in a.sessions() if s['sessionId'] == session['sessionId'])
                step('checkpoint preserves original and dirty revision', sha(source) == original_sha
                     and now['dirty'] is True and now['revision'] == revision and now['loadGeneration'] == session['loadGeneration']
                     and not list(out.glob('.geul-save-*.tmp')), now)
                a.type('Z')
                a.wait('const e=document.querySelector(arguments[0]);return e?.dataset.pending==="0" && Number(e.dataset.revision)===arguments[1]', STATUS, revision + 1)
                waiting = d.js('const e=document.querySelector(arguments[0]);return e?{...e.dataset}:null', selector)
                step('newer revision not protected', waiting and waiting['state'] == 'waiting'
                     and waiting['revision'] == str(revision + 1), waiting)
                killed = process.kill()
                step('pidfd SIGKILL of exact owner', not process.alive() and crash.gone(process.pid), killed)
                entry['kill'] = killed
                entry['protectedRevision'] = revision
                entry['unprotectedRevision'] = revision + 1
        finally:
            try:
                smoke.end_session(d)
            except Exception as error:
                if not killed:
                    raise
                entry['killedSessionEnd'] = type(error).__name__
    step('record and original survive SIGKILL', sha(source) == original_sha and record.exists()
         and crash.parse_record(record)[1] == payload)
    existing = out / 'existing.docx'
    existing.write_bytes(b'existing destination must survive')
    existing_sha = sha(existing)
    destination = out / 'restored.docx'
    with crash.acceptance_launch(args, 'docx', 'launch2', home, report) as start:
        d = start()
        try:
            a = base.Acceptance(args, d, report)
            a.wait('return !!document.querySelector("[data-testid=recovery-center]")')
            a.wait('const e=document.querySelector(arguments[0]);return e?.dataset.valid==="true"',
                   f'[data-testid=recovery-candidate][data-recovery-id="{candidate["id"]}"]')
            pid = report['launches'][-1]['pid']
            step('fresh process discovers candidate', pid != killed['pid'], {'pid': pid, 'candidate': candidate})
            a.open('docx', payload_path)
            reopened = next(s for s in a.sessions() if s['displayName'] == payload_path.name)
            observed = view(a, reopened)
            step('fresh WordCraft validates payload before restore', reopened['engine'] == 'wordcraft'
                 and reopened['state'] == 'ready' and not reopened['dirty']
                 and observed['view']['paragraphText'] == expected[0], observed['session'])
            refused = a.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_restore',{id:arguments[0],path:arguments[1]})", candidate['id'], str(existing))
            step('existing destination rejected', not refused.get('ok')
                 and 'FileConflict' in json.dumps(refused.get('error')) and sha(existing) == existing_sha, refused)
            d.js('document.querySelector(arguments[0]).click()', f'[data-testid="recovery-restore-{candidate["id"]}"]')
            a.chooser(destination, crash.RESTORE_TITLE)
            a.ready('docx', destination.name)
            restored = next(s for s in a.sessions() if s['displayName'] == destination.name)
            observed = view(a, restored)
            step('create-only restore opens clean WordCraft session', restored['engine'] == 'wordcraft'
                 and restored['state'] == 'ready' and restored['dirty'] is False, restored)
            step('restored payload and committed content match', destination.read_bytes() == payload
                 and paragraphs(destination) == expected and observed['view']['paragraphText'] == expected[0],
                 {'sha256': sha(destination), 'paragraph0': observed['view']['paragraphText']})
            step('original and existing destination preserved', sha(source) == original_sha and sha(existing) == existing_sha)
            listed = a.async_js("return await window.__TAURI_INTERNALS__.invoke('recovery_list')")
            step('candidate retained until explicit discard', listed.get('ok')
                 and any(c['id'] == candidate['id'] and c['valid'] for c in listed['value']), listed)
            step('restored tab closes cleanly', crash.rhwp.close_tab(d, destination.name))
            entry['restoredSha256'] = sha(destination)
            entry['finalOriginalSha256'] = sha(source)
        finally:
            smoke.end_session(d)
    entry['status'] = 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'fixtures'):
        parser.add_argument('--' + name, required=True, type=Path)
    for name in ('xdotool', 'ibus', 'app-sha256'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    for name in ('app', 'driver', 'out', 'fixtures'):
        setattr(args, name, getattr(args, name).resolve())
    checks.require(sha(args.app) == args.app_sha256, 'setup', 'exact embedded executable', sha(args.app))
    args.out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(args.app)
    smoke.DRIVER_LOG = str(args.out / 'driver.log')
    smoke.TEARDOWN.clear()
    report = {'sourceHead': crash.subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=crash.ROOT, text=True).strip(),
              'sourceDirty': crash.subprocess.check_output(['git', 'status', '--porcelain'], cwd=crash.ROOT, text=True).splitlines(),
              'status': 'RUNNING', 'formats': [], 'launches': [], 'appSha256': sha(args.app),
              'driverSha256': sha(args.driver), 'harnessSha256': sha(__file__), 'checksSha256': sha(checks.__file__),
              'sharedHarnessSha256': sha(crash.__file__), 'fixtureSha256': sha(args.fixtures / 'basic-ko.docx'),
              'scope': 'DOCX native WordCraft automatic checkpoint and fresh-process restore; no external Word compatibility claim'}
    try:
        run(args, report)
    except Exception as error:
        traceback.print_exc()
        report['error'] = type(error).__name__ + ': ' + str(error)
    report['teardown'] = smoke.TEARDOWN
    report['status'], report['problems'] = checks.overall(report, {'docx': REQUIRED})
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('overall', report['status'], *report['problems'], sep='\n')
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
