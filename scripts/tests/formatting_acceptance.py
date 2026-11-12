#!/usr/bin/env python3
"""Fixed acceptance contract and fail-closed finalizer for RHWP general character formatting (Stage 5/6).

The native scenario (native-formatting-acceptance.py) can only end as PENDING_LAUNCHER_CLEANUP. A final
PASS exists only in the verdict written here, derived from three records of the same execution:

    native scenario evidence valid for HWP and HWPX   (result.json)
        -> child reported PENDING_LAUNCHER_CLEANUP
        -> launcher teardown/cleanup evidence valid    (session.json, cleanup.json, exit codes)
        -> final PASS                                  (final-verdict.json)

Nothing is taken from a reported status: required formats, check names, operations, saved-file models,
reopen state and the input event log are compared with the constants below. Missing or unreadable
evidence gives INCOMPLETE, anything contradicting the contract gives FAIL. This contract is separate
from the T010 Undo/Redo contract; only the T010 helpers whose meaning is identical are reused.

  python3 scripts/tests/formatting_acceptance.py run --evidence DIR --app APP --driver TAURI_DRIVER
  python3 scripts/tests/formatting_acceptance.py finalize --result R --session-dir S --app APP --verdict V
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import t010_acceptance as gate
import t010_launcher as launcher

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = 'geul.formatting-acceptance.v1'
PENDING = 'PENDING_LAUNCHER_CLEANUP'
FORMATS = ('hwp', 'hwpx')
IME_KEYS, IME_TEXT = 'dkssud', '안녕'
EMPTY_DIFF = hashlib.sha256(b'').hexdigest()
# Every file whose behaviour decides the evidence; a change after the run makes the evidence stale.
HARNESS_FILES = ('formatting_acceptance.py', 'native-formatting-acceptance.py', 'rhwp-char-flags.mjs', 'native-ibus-session.py',
                 'native-t010-production.py', 'native-new-document.py', 't010_acceptance.py', 't010_lifecycle.py', 't010_launcher.py')

# Product inputs of the tested build. Identity is bound to these Git objects rather than to the commit,
# so committing harness or documentation changes does not invalidate (or silently refresh) evidence.
PRODUCT_PATHS = ('src', 'src-tauri', 'patches', 'external/rhwp', 'external/wordcraft', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts')

# tests/fixtures/rhwp/generate.mjs content: [text, one flag-letter set per character].
FIXTURE = {'body': [['한글 문단입니다. Korean paragraph.', ['-'] * 27], ['굵은 글씨 Bold text', ['B'] * 5 + ['-'] * 10], ['', []],
                    ['표 다음 문단 End.', ['-'] * 12]],
           'cells': [['셀 하나', ['-'] * 4], ['Cell two', ['-'] * 8], ['셋째 칸', ['-'] * 4], ['Fourth', ['-'] * 6]]}
CELL = '@0/1/0'  # table paragraph 2, control 0, second cell, first cell paragraph
# (command, how, selection): shortcuts for B/I/U, ribbon for all four, one table cell.
OPERATIONS = (('bold', 'ctrl+b', '0:0:0|0:0:2'), ('italic', 'ctrl+i', '0:0:5|0:0:7'), ('underline', 'ctrl+u', '0:0:7|0:0:10'),
              ('strikethrough', 'ribbon', '0:0:12|0:0:18'), ('bold', 'ribbon', '0:1:6|0:1:10'), ('italic', 'ribbon', '0:1:6|0:1:10'),
              ('underline', 'ribbon', '0:1:6|0:1:10'), ('bold', 'ctrl+b', f'0:2:0{CELL}|0:2:4{CELL}'))
OPERATION_CHECKS = ('one accepted revision', 'selection and caret kept', 'ribbon state reflects formatting', 'rendered page visibly changed')
_NONE = {'bold': False, 'italic': False, 'underline': False, 'strikethrough': False}
REOPEN_PRESSED = {'ime-bold': {**_NONE, 'bold': True}, 'italic': {**_NONE, 'italic': True}, 'underline': {**_NONE, 'underline': True},
                  'strike': {**_NONE, 'strikethrough': True}, 'unformatted': dict(_NONE),
                  'ribbon-biu': {**_NONE, 'bold': True, 'italic': True, 'underline': True},
                  'cell-bold': {**_NONE, 'bold': True}, 'cell-rest': dict(_NONE)}
EVENT_TYPES = ('keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'mousedown', 'mouseup', 'click')
CHECKS = (
    'document opened through the native chooser',
    'product build: test-only text hook absent',
    'document editable: ready, clean, input focused',
    'four formatting controls visible in the ribbon',
    'collapsed caret: formatting unavailable',
    'native Korean composition through IBus (trusted compositionstart/compositionend)',
    'valid selection: four formatting commands available and not pressed',
    *(f'{name} via {how} on {selection}: {check}' for name, how, selection in OPERATIONS for check in OPERATION_CHECKS),
    'undo via ctrl+z advances revision by one',
    'Undo: rendered page equals the state before the cell formatting',
    'Undo: bold no longer reported for the restored selection',
    'undo: GUI save succeeded',
    'undo: saved file read outside the app has exact text and character flags',
    'redo via ctrl+y advances revision by one',
    'Redo exhausted after Ctrl+Y',
    'Redo: rendered page equals the formatted state',
    'final: GUI save succeeded',
    'final: saved file read outside the app has exact text and character flags',
    'saved document closed by native pointer without a discard prompt',
    'reopened document: fresh clean session',
    'reopened document: application reports the saved formatting and unformatted neighbours',
    'reopened document untouched by inspection',
    'saved file unchanged by reopen',
    'source fixture bytes unchanged',
    'reopened document closed by native pointer without a discard prompt',
    'final event log: complete and contiguous through the last native close',
    'final event log: every recorded input event trusted',
)
SAVES = ('undo', 'final')
require = gate.require


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def harness_hashes(folder=ROOT / 'scripts/tests'):
    return {name: sha(Path(folder) / name) for name in HARNESS_FILES}


def product_trees(root=ROOT):
    return {path: subprocess.check_output(['git', 'rev-parse', 'HEAD:' + path], cwd=root, text=True).strip() for path in PRODUCT_PATHS}


def product_diff(root=ROOT):
    return hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', *PRODUCT_PATHS], cwd=root)).hexdigest()


def _marked(text, ranges):
    flags = ['-'] * len(text)
    for start, end, letters in ranges:
        flags[start:end] = [letters] * (end - start)
    return flags


def expected_models():
    """Exact saved-file content after Undo of the cell formatting and after Redo."""
    t0, t1, n = FIXTURE['body'][0][0], FIXTURE['body'][1][0], len(IME_TEXT)
    p0 = IME_TEXT + t0
    body = [[p0, _marked(p0, [(0, n, 'B'), (n + 3, n + 5, 'I'), (n + 5, n + 8, 'U'), (n + 10, n + 16, 'S')])],
            [t1, _marked(t1, [(0, 5, 'B'), (6, 10, 'BIU')])], *FIXTURE['body'][2:]]
    cells = [list(c) for c in FIXTURE['cells']]
    cells[1] = [cells[1][0], ['B'] * 4 + cells[1][1][4:]]
    return {'undo': {'body': body, 'cells': FIXTURE['cells']}, 'final': {'body': body, 'cells': cells}}


def events(log, count):
    """The complete native input log read at the end of one format scenario.

    The harness listener numbers every event and counts independently of the array, so a replaced,
    truncated or early snapshot cannot satisfy this: the log must run without gaps up to the counter
    and end with the pointer click that closed the reopened document.
    """
    require(isinstance(log, list) and log and type(count) is int and len(log) == count, 'event log missing/incomplete')
    for index, event in enumerate(log):
        require(isinstance(event, dict) and event.get('seq') == index and event.get('type') in EVENT_TYPES, 'event log not contiguous/unknown event')
    last = {}
    for event in log:
        last[(event['type'], event.get('target'))] = event['seq']
    starts = [e['seq'] for e in log if e['type'] == 'compositionstart']
    ends = [e['seq'] for e in log if e['type'] == 'compositionend']
    require(starts and ends and min(starts) < max(ends), 'Korean composition start/end not observed')
    ribbon = [last.get(('click', 'format.' + name)) for name in ('bold', 'italic', 'underline', 'strikethrough')]
    require(all(seq is not None for seq in ribbon), 'ribbon formatting click not observed')
    closes = [e['seq'] for e in log if e['type'] == 'click' and e.get('target') == 'tab-close']
    clicks = [e['seq'] for e in log if e['type'] == 'click']
    require(len(closes) == 2 and closes[-1] == clicks[-1] and closes[0] > max(ribbon + ends), 'log does not reach the final native close')
    keys = [e['seq'] for e in log if e['type'] == 'keydown']
    require(any(closes[0] < seq < closes[1] for seq in keys), 'no keyboard input observed on the reopened document')


def trusted(log):
    require(isinstance(log, list) and log and all(isinstance(e, dict) and e.get('trusted') is True for e in log), 'untrusted/unverified input event')


def scenario(row, fmt):
    """One complete accepted format scenario, judged from its raw evidence."""
    require(isinstance(row, dict) and row.get('format') == fmt and row.get('status') == 'PASS' and not row.get('error'), 'scenario failed/incomplete')
    checks = row.get('checks')
    require(isinstance(checks, list) and [c.get('name') for c in checks] == list(CHECKS), 'mandatory check missing, duplicated, reordered or extra')
    require(all(c.get('status') == 'PASS' for c in checks), 'mandatory check failed')
    operations = row.get('operations')
    require(isinstance(operations, list) and [(o.get('command'), o.get('via'), o.get('selection')) for o in operations]
            == [('format.' + name, how, selection) for name, how, selection in OPERATIONS], 'formatting operations missing/unexpected')
    require(all(gate.digest(o.get('canvasBefore')) and gate.digest(o.get('canvasAfter')) and o['canvasBefore'] != o['canvasAfter'] for o in operations),
            'formatting without a visible change')
    saves, models = row.get('saves'), expected_models()
    require(isinstance(saves, list) and [s.get('label') for s in saves] == list(SAVES), 'missing/duplicate save evidence')
    for save in saves:
        require(save.get('verified') is True and save.get('result', {}).get('state') == 'saved' and gate.digest(save.get('sha256')), 'failed/unverified save')
        require(save.get('model') == models[save['label']], 'saved-file text/character flags mismatch')
    require(saves[0]['sha256'] != saves[1]['sha256'], 'Undo and Redo saved the same bytes')
    reopen = row.get('reopen')
    require(isinstance(reopen, dict) and reopen.get('nativeChooser') is True and reopen.get('pressed') == REOPEN_PRESSED
            and reopen.get('localRevision') == '0' and reopen.get('dirty') == 'false' and reopen.get('savedSha256') == saves[1]['sha256'],
            'missing/incorrect native reopen evidence')
    events(row.get('events'), row.get('eventCount'))
    trusted(row.get('events'))


def native(report, required=FORMATS):
    """Independent verdict per required format; combined PASS only when every one passes."""
    rows = report.get('formats') if isinstance(report, dict) else None
    rows = rows if isinstance(rows, list) else []
    names = [r.get('format') if isinstance(r, dict) else None for r in rows]
    result = {}
    for fmt in required:
        if names.count(fmt) == 0:
            result[fmt] = {'status': 'MISSING', 'reason': 'no scenario result'}
        elif names.count(fmt) > 1:
            result[fmt] = {'status': 'FAIL', 'reason': 'duplicate scenario result'}
        else:
            result[fmt] = gate.verdict(scenario, rows[names.index(fmt)], fmt)
    extra = sorted({str(n) for n in names if n not in required})
    status = ('FAIL' if extra or any(v['status'] == 'FAIL' for v in result.values())
              else 'INCOMPLETE' if any(v['status'] == 'MISSING' for v in result.values()) else 'PASS')
    return {'status': status, 'formats': result, **({'unexpectedFormats': extra} if extra else {})}


def identity(report, expected):
    """Application, frontend, Release, source and harness identity against inputs read outside the run."""
    trusted_inputs = {k: expected[k] for k in ('appSha256', 'release', 'frontendBuild')}
    gate.release(expected['release'], expected['release'])
    require(report.get('expectedIdentity') == trusted_inputs, 'run used different expected identities')
    gate.production_identity(report, trusted_inputs)
    trees = expected.get('productTrees')
    require(isinstance(trees, dict) and set(trees) == set(PRODUCT_PATHS) and all(isinstance(v, str) and len(v) == 40 for v in trees.values())
            and report.get('productTrees') == trees, 'evidence from different product sources')
    require(report.get('sourceDiffSha256') == EMPTY_DIFF and expected.get('sourceDiffSha256') == EMPTY_DIFF, 'uncommitted product source')
    require(isinstance(expected.get('harness'), dict) and set(expected['harness']) == set(HARNESS_FILES)
            and report.get('harnessSha256') == expected['harness'], 'stale evidence: harness changed since the run')
    require(report.get('contract') == {'schema': SCHEMA, 'formats': list(FORMATS), 'checks': list(CHECKS)}, 'run used a different contract')


def launcher_cleanup(report, session, cleanup, launcher_exit, result_dir):
    """Launcher/WebDriver teardown of the same execution. Mirrors gate.launcher_cleanup without the
    T010-only report hand-off (`acceptanceReport`), which this workflow deliberately does not use."""
    owner = report.get('nativeLauncher') or {}
    require(owner.get('runId') == report.get('runId') == session.get('runId') == cleanup.get('runId') and bool(report.get('runId')), 'result and cleanup from different runs')
    require(owner.get('commandSha256') == session.get('commandSha256') == cleanup.get('commandSha256') and gate.digest(owner.get('commandSha256')), 'wrong launcher command')
    require(not session.get('error') and not report.get('error'), 'unresolved native/launcher error')
    require(session.get('globalEngine') == 'hangul' and session.get('setGlobalEngine', {}).get('exit') == 0, 'Hangul engine not proven active')
    gate.teardown(report.get('teardown'), report.get('sessions'), report.get('runId'))
    require(all(s.get('dataHome') == str(Path(result_dir) / 'data') for s in report['sessions']), 'result file does not belong to the recorded session')
    require(type(cleanup.get('ownedAtTeardown')) is int and cleanup['ownedAtTeardown'] >= 0
            and isinstance(cleanup.get('leakedAfterManagedStop'), dict), 'missing launcher process observations')
    require(cleanup.get('complete') is True and cleanup.get('proven') is True and cleanup.get('subreaper') is True
            and cleanup.get('survivors') == [] and cleanup.get('processErrors') == [], 'launcher cleanup incomplete/unsuccessful')
    require(type(cleanup.get('exit')) is int and cleanup['exit'] == 0, 'native command exited nonzero')
    require(launcher_exit is None or (type(launcher_exit) is int and launcher_exit == 0), 'launcher exited nonzero')
    gate.directory_cleanup(session, cleanup)
    require(cleanup.get('filesystemProven') is True, 'filesystem cleanup not proven')


def _load(path, verdict, name):
    try:
        path = Path(path)
        value = json.loads(path.read_text())
        require(isinstance(value, dict), 'not a JSON object')
        verdict['evidence'][name] = {'path': str(path), 'sha256': sha(path), 'mtimeNs': path.stat().st_mtime_ns}
        return value
    except (OSError, ValueError) as error:
        verdict['evidence'][name] = {'path': str(path), 'error': f'{type(error).__name__}: {error}'}
        return None


def evaluate(result_path, session_dir, expected, launcher_exit=None):
    """Derive the final verdict; never raises for bad evidence and never returns PASS by default."""
    verdict = {'schema': SCHEMA, 'status': 'INCOMPLETE', 'requiredFormats': list(FORMATS), 'checksPerFormat': len(CHECKS),
               'contractSha256': hashlib.sha256(json.dumps([FORMATS, CHECKS, OPERATIONS, SAVES, expected_models(), REOPEN_PRESSED], ensure_ascii=False).encode()).hexdigest(),
               'evidence': {}, 'launcherExit': launcher_exit, 'transitions': []}
    report = _load(result_path, verdict, 'result')
    session = _load(Path(session_dir) / 'session.json', verdict, 'session')
    cleanup = _load(Path(session_dir) / 'cleanup.json', verdict, 'cleanup')

    def step(name, outcome):
        verdict['transitions'].append({'step': name, **outcome})
        return outcome['status']

    missing = [n for n, v in (('result', report), ('session', session), ('cleanup', cleanup)) if v is None]
    scenarios = native(report or {})
    verdict['formats'] = scenarios['formats']
    verdict['runId'] = (report or {}).get('runId')
    states = [step('native-scenario', {k: v for k, v in scenarios.items() if k != 'formats'} if report else {'status': 'INCOMPLETE', 'reason': 'native result missing/unreadable'})]
    states.append(step('identity', gate.verdict(identity, report, expected) if report else {'status': 'INCOMPLETE', 'reason': 'native result missing/unreadable'}))
    pending = bool(report) and report.get('status') == PENDING and (report.get('acceptance') or {}).get('status') == 'PASS'
    states.append(step('pending-launcher-cleanup', {'status': 'PASS'} if pending
                       else {'status': 'INCOMPLETE' if not report else 'FAIL', 'reason': f'native status {(report or {}).get("status")!r} is not an accepted scenario awaiting cleanup'}))
    if missing:
        states.append(step('launcher-cleanup-verified', {'status': 'INCOMPLETE', 'reason': 'evidence missing/unreadable: ' + ', '.join(missing)}))
    else:
        outcome = gate.verdict(launcher_cleanup, report, session, cleanup, launcher_exit, Path(result_path).resolve().parent)
        order = verdict['evidence']['result']['mtimeNs'] <= verdict['evidence']['cleanup']['mtimeNs']
        states.append(step('launcher-cleanup-verified', outcome if outcome['status'] != 'PASS' or order
                           else {'status': 'FAIL', 'reason': 'contradictory evidence: native result written after launcher cleanup'}))
    verdict['status'] = 'PASS' if all(s == 'PASS' for s in states) else 'FAIL' if 'FAIL' in states else 'INCOMPLETE'
    verdict['transitions'].append({'step': 'final', 'status': verdict['status']})
    return verdict


def trusted_inputs(app, root=ROOT):
    """Expected identities read from the repository and the executable, never from the run's report."""
    return {'appSha256': sha(app), 'release': json.loads((root / 'public/rhwp/RELEASE.json').read_text()),
            'frontendBuild': json.loads((root / 'dist/frontend-build.json').read_text()),
            'productTrees': product_trees(root), 'sourceDiffSha256': product_diff(root), 'harness': harness_hashes()}


def finalize(result_path, session_dir, verdict_path, expected, launcher_exit=None):
    try:
        verdict = evaluate(result_path, session_dir, expected, launcher_exit)
    except Exception as error:  # a validator defect must never become PASS
        verdict = {'schema': SCHEMA, 'status': 'FAIL', 'error': f'{type(error).__name__}: {error}'}
    verdict['expected'] = {k: expected.get(k) for k in ('appSha256', 'productTrees', 'harness')} | {'releaseGeneration': (expected.get('release') or {}).get('generation')}
    launcher.atomic_json(verdict_path, verdict)
    return verdict


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='mode', required=True)
    run = sub.add_parser('run', help='launch the private IBus session with the native scenario, then finalize')
    run.add_argument('--evidence', required=True, type=Path, help='new directory: native/, session/, launcher.log, final-verdict.json')
    run.add_argument('--driver', required=True, type=Path)
    fin = sub.add_parser('finalize', help='derive the verdict from existing evidence of one execution')
    fin.add_argument('--result', required=True, type=Path)
    fin.add_argument('--session-dir', required=True, type=Path)
    fin.add_argument('--verdict', required=True, type=Path)
    fin.add_argument('--launcher-exit', type=int)
    for p in (run, fin):
        p.add_argument('--app', required=True, type=Path)
    args = parser.parse_args()
    expected = trusted_inputs(args.app.resolve())  # captured before anything is launched
    if args.mode == 'run':
        evidence = args.evidence.resolve()
        evidence.mkdir(parents=True, exist_ok=False)
        tests = ROOT / 'scripts/tests'
        command = [sys.executable, str(tests / 'native-ibus-session.py'), '--hangul-initial-mode', 'hangul', '--out', str(evidence / 'session'), '--',
                   sys.executable, str(tests / 'native-formatting-acceptance.py'), '--app', str(args.app.resolve()), '--app-sha256', expected['appSha256'],
                   '--driver', str(args.driver.resolve()), '--out', str(evidence / 'native'), '--xdotool', '@XDOTOOL@', '--ibus', '@IBUS@']
        with (evidence / 'launcher.log').open('w') as log:
            code = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT).returncode
        launcher.atomic_json(evidence / 'command.json', {'command': command, 'launcherExit': code})
        result, session, target = evidence / 'native/result.json', evidence / 'session', evidence / 'final-verdict.json'
    else:
        code, result, session, target = args.launcher_exit, args.result, args.session_dir, args.verdict
    verdict = finalize(result, session, target, expected, code)
    print(json.dumps({'status': verdict['status'], 'formats': verdict.get('formats'), 'transitions': verdict.get('transitions'),
                      'verdict': str(target), 'verdictSha256': sha(target)}, ensure_ascii=False, indent=2))
    return 0 if verdict['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
