"""Pure, fail-closed T010 evidence gates. Synthetic tests are not native acceptance."""
import re
from collections import Counter
from urllib.parse import urlsplit

FORMATS = ('hwp', 'hwpx')
SAVES = ('typed', 'ctrl-z-korean', 'ctrl-y-korean', 'ribbon-undo-all', 'redo-all',
         'branch', 'switch-a-undo', 'switch-b-redo')

PRODUCTION_CHECKS = ('product build: test-only text hook absent',
 'product build: no advanced-only history notice',
 'fresh document: Undo and Redo exposed but unavailable',
 'ordinary typing makes Undo available',
 'native Korean composition through IBus',
 'typed: saved file reopened outside the app holds expected text',
 'Undo available after save',
 'undo via ctrl+z advances revision by one',
 'ctrl-z-korean: saved file reopened outside the app holds expected text',
 'redo via ctrl+y advances revision by one',
 'Redo exhausted after Ctrl+Y',
 'ctrl-y-korean: saved file reopened outside the app holds expected text',
 'undo via button advances revision by one',
 'undo via button advances revision by one',
 'two ribbon Undo presses exhaust history',
 'Ctrl+Z with nothing to undo is a no-op',
 'ribbon-undo-all: saved file reopened outside the app holds expected text',
 'redo via ctrl+shift+z advances revision by one',
 'redo via button advances revision by one',
 'redo-all: saved file reopened outside the app holds expected text',
 'undo via ctrl+z advances revision by one',
 'new edit after Undo invalidates Redo',
 'Ctrl+Y on invalidated branch is a no-op',
 'branch: saved file reopened outside the app holds expected text',
 'reopened document: fresh session without history',
 'second document starts without history',
 'undo via ctrl+z advances revision by one',
 'first document keeps its own Undo after switching',
 'undo via ctrl+z advances revision by one',
 'switch-a-undo: saved file reopened outside the app holds expected text',
 'second document keeps its own Redo after switching',
 'redo via ctrl+y advances revision by one',
 'switch-b-redo: saved file reopened outside the app holds expected text',
 'all observed editor input events trusted')


def digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def require(ok, message):
    if not ok:
        raise ValueError(message)


def insertion(before, after, text, *, end=False):
    """Unicode scalar offsets, as used by RHWP; End may move to the paragraph end here."""
    require(isinstance(before['caret'], str) and re.fullmatch(r'\d+:\d+:\d+(?:@\d+/\d+/\d+)?', before['caret']), 'invalid caret identity')
    parts = before['caret'].split('@')
    loc = parts[0].split(':')
    at = int(loc[-1])
    require(0 <= at <= len(before['paragraphText']), 'invalid insertion anchor')
    expected = before['paragraphText'][:at] + text + before['paragraphText'][at:]
    loc[-1] = str(len(expected) if end else at + len(text))
    caret = ':'.join(loc) + ('@' + parts[1] if len(parts) == 2 else '')
    require(after['paragraphText'] == expected, 'text/order/insertion mismatch')
    require(after['caret'] == caret and after['selection'] == '', 'caret/selection mismatch')
    require(after['revision'] == after['localRevision'], 'unsettled revision')


def composition_undo(committed, pre, after, events, trace):
    """Two complete native outcomes: commit then accepted Undo, or refused Undo then commit.

    This is a bounded composition trial, not the separate original E→U→F compatibility gate.
    """
    require(pre['session'] == committed['session'] == after['session'], 'wrong composition owner')
    insertion(committed, pre, '나')
    require(pre['composing'] == 'true' and pre['localRevision'] == committed['localRevision']
            and pre['ime']['historyTransaction'] is True and committed['ime']['historyTransaction'] is False, 'no active preedit transaction')
    require(events and all(e.get('trusted') is True for e in events), 'untrusted/missing native events')
    require(any(e.get('type') == 'keydown' and e.get('key', '').lower() == 'z' and e.get('ctrlKey') is True for e in events), 'no native Ctrl+Z')
    require(any(e.get('type') == 'compositionend' for e in events)
            and any(e.get('type') == 'input' and e.get('inputType') == 'insertFromComposition' and e.get('data') == '나' for e in events), 'no native final commit')
    require(trace.get('dropped') == 0 and trace.get('records'), 'incomplete command trace')
    require([r[0] for r in trace['records']] == list(range(1, trace.get('seq', -1) + 1)), 'missing/out-of-order command trace records')
    requests = [r[3] for r in trace['records'] if r[2] == 'command:request' and r[3].get('id') == 'edit.undo']
    dispatch = [r[3] for r in trace['records'] if r[2] == 'command:dispatch' and r[3].get('id') == 'edit.undo']
    require(len(requests) == 1, 'missing/duplicate Undo request')
    require(str(requests[0]['session']) == committed['session'], 'wrong command owner')
    accepted = requests[0].get('available') is True and len(dispatch) == 1 and dispatch[0].get('accepted') is True
    refused = requests[0].get('available') is False and requests[0].get('reason') == 'composing' and not dispatch
    require(accepted or refused, 'unproven Undo disposition')
    request_seq = next(r[0] for r in trace['records'] if r[2] == 'command:request' and r[3].get('id') == 'edit.undo')
    finals = [r[0] for r in trace['records'] if r[2] == 'dom:input' and r[3].get('inputType') == 'insertFromComposition' and r[3].get('length') == 1]
    require(len(finals) == 1 and (finals[0] < request_seq if accepted else request_seq < finals[0]), 'unproven commit/command order')
    expected = committed if accepted else pre
    require(all(after[k] == expected[k] for k in ('paragraphText', 'caret', 'selection')), 'Undo text/caret/selection mismatch')
    require(after['composing'] == 'false' and after['revision'] == after['localRevision'], 'unsettled composition')
    require(int(after['localRevision']) == int(committed['localRevision']) + (2 if accepted else 1), 'wrong commit/Undo revision boundary')
    h, base = after['ime'], committed['ime']
    require(h['historyTransaction'] is False and h['provisional'] is False, 'open transaction after final')
    require(h['historyUndo'] == base['historyUndo'] + (0 if accepted else 1)
            and h['historyRedo'] == (1 if accepted else 0), 'wrong history transaction boundary')
    return 'accepted-after-commit' if accepted else 'refused-then-committed'


def teardown(records, sessions, run_id):
    require(isinstance(records, list) and records and isinstance(sessions, list) and sessions, 'missing teardown/session evidence')
    require(len(records) == len(sessions), 'missing/extra teardown')
    require(len({s['sessionId'] for s in sessions}) == len(sessions), 'duplicate session')
    for record, session in zip(records, sessions):
        require(record.get('runId') == run_id == session.get('runId') and bool(run_id), 'wrong teardown run')
        require(record.get('dataHome') == session.get('dataHome') and bool(session.get('dataHome')), 'wrong process ownership scope')
        require(type(record.get('driverPid')) is int and record['driverPid'] == session.get('driverPid'), 'wrong driver identity')
        require(isinstance(session.get('sessionId'), str) and bool(session['sessionId'])
                and record.get('sessionIds') == [session['sessionId']], 'wrong teardown session')
        deletes = record.get('sessionDeletes')
        require(isinstance(deletes, list) and len(deletes) == 1 and deletes[0].get('outcome') == 'ok', 'session deletion unsuccessful/missing')
        require(record.get('complete') is True and type(record.get('driverExit')) is int and record['driverExit'] == 0
                and record.get('driverKilled') is False, 'driver cleanup unsuccessful/incomplete')
        for name in ('remainingAfterWait', 'sigtermSent', 'sigtermErrors', 'survivorsAfterSigterm'):
            require(record.get(name) == [], 'mandatory cleanup failed/missing: ' + name)
        require(isinstance(record.get('beforeDriverStop'), list) and isinstance(record.get('afterDriverStop'), list), 'missing process observations')


def release(actual, expected):
    require(isinstance(expected, dict) and expected.get('engine') == 'rhwp' and expected.get('profile') == 'release'
            and digest(expected.get('generation')) and all(digest(expected.get('artifacts', {}).get(n)) for n in ('rhwp.js', 'rhwp_bg.wasm')), 'unverified expected Release')
    require(actual == expected, 'Release metadata/generation mismatch')


def production_identity(report, expected):
    require(digest(expected.get('appSha256')) and report.get('appSha256') == expected['appSha256'], 'executable hash mismatch')
    running = report.get('runningApplication', [])
    require(len(running) == 1 and running[0].get('sha256') == expected['appSha256'] and type(running[0].get('pid')) is int
            and running[0].get('startTime') and running[0].get('testFlags') == [], 'running executable unverified')
    loc = urlsplit(report.get('location', ''))
    require(loc.scheme == 'tauri' and loc.netloc == 'localhost' and loc.path in ('', '/') and not loc.query and not loc.fragment, 'unsupported application origin')
    require(report.get('testFlagsInEnvironment') == [], 'unexpected runtime test environment')
    build = report.get('frontendBuild')
    require(isinstance(build, dict) and build == expected.get('frontendBuild') and build.get('schema') == 'geul.frontend-build.v1'
            and build.get('mode') == 'production' and build.get('testFlags') == {} and build.get('assets') and digest(build.get('indexSourceSha256')) and build.get('entrypoints')
            and any(p.startswith('assets/') and p.endswith('.js') for p in build['assets']), 'unexpected/unverified frontend build configuration')
    require(report.get('frontendEntrypoints') == build['entrypoints'], 'unexpected embedded frontend entrypoints')
    require(all(digest(v) for v in build['assets'].values()) and report.get('frontendAssetHashes') == build['assets'], 'embedded frontend asset mismatch')
    require(report.get('testTraceAbsent') is True and report.get('testHooksAbsent') is True, 'test diagnostics present/unverified')
    release(report.get('rhwpIdentity'), expected['release'])
    require(report.get('servedArtifactHashes') == expected['release']['artifacts'], 'served Release artifact identity missing/mismatched')
    require(report.get('oracleIdentity') == {'generation': expected['release']['generation'], 'artifacts': expected['release']['artifacts']}, 'oracle Release identity missing/mismatched')


def rows_complete(rows, expected):
    require(isinstance(rows, list) and len(rows) == len(expected), 'missing/extra scenario')
    require(sorted((r['format'], r.get('case', 'production')) for r in rows) == sorted(expected), 'missing/duplicate scenario identity')
    for row in rows:
        require(row.get('status') == 'PASS' and row.get('checks') and all(c.get('status') == 'PASS' for c in row['checks']), 'failed/missing mandatory assertions')
        require(not row.get('cleanupError'), 'scenario cleanup failed')


def production(report, expected):
    production_identity(report, expected)
    rows_complete(report.get('formats'), [(f, 'production') for f in FORMATS])
    for row in report['formats']:
        counts = Counter(c['name'] for c in row['checks'])
        require(not (Counter(PRODUCTION_CHECKS) - counts), 'missing mandatory production assertion')
        oracle = report['fixtureOracle'][row['format']]
        prefixes = dict(zip(SAVES, ('Alpha 한글', 'Alpha ', 'Alpha 한글', '', 'Alpha 한글', 'Alpha Z', 'Alpha Z', 'b')))
        saves = row.get('saves', [])
        require(sorted(s['label'] for s in saves) == sorted(SAVES), 'missing/duplicate saved-file oracle')
        for save in saves:
            require(save.get('verified') is True and save.get('result', {}).get('state') == 'saved' and digest(save.get('sha256')), 'failed/unverified saved content')
            require(save.get('first') == prefixes[save['label']] + oracle['first'] and save.get('restSha256') == oracle['restSha256'] and digest(oracle['restSha256']), 'saved-file content mismatch')
    teardown(report.get('teardown'), report.get('sessions'), report.get('runId'))
    require(not report.get('error'), 'execution error')


def usability(report, formats, cases):
    require(formats and cases and len(set(formats)) == len(formats) and len(set(cases)) == len(cases)
            and set(formats) <= set(FORMATS), 'invalid scenario selection')
    rows_complete(report.get('scenarios'), [(f, c) for f in formats for c in cases])
    teardown(report.get('teardown'), report.get('sessions'), report.get('runId'))
    require(not report.get('error'), 'execution error')


def verdict(validate, *args, **kwargs):
    try:
        validate(*args, **kwargs)
        return {'status': 'PASS'}
    except (ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
        return {'status': 'FAIL', 'reason': str(error)}


def launcher_cleanup(report, session, cleanup):
    owner = report['nativeLauncher']
    require(owner.get('runId') == report.get('runId') == session.get('runId') == cleanup.get('runId') and bool(report.get('runId')), 'wrong launcher run')
    require(owner.get('commandSha256') == session.get('commandSha256') == cleanup.get('commandSha256')
            and digest(owner.get('commandSha256')), 'wrong launcher command')
    require(session.get('acceptanceReport') == owner.get('acceptanceReport') and bool(owner.get('acceptanceReport')), 'wrong launcher report')
    require(type(cleanup.get('ownedAtTeardown')) is int and cleanup['ownedAtTeardown'] >= 0
            and isinstance(cleanup.get('leakedAfterManagedStop'), dict), 'missing launcher process observations')
    require(cleanup.get('complete') is True and cleanup.get('proven') is True and cleanup.get('subreaper') is True
            and cleanup.get('survivors') == [] and type(cleanup.get('exit')) is int and cleanup['exit'] == 0, 'launcher cleanup missing/unsuccessful')
    require(report.get('acceptance', {}).get('status') == 'PASS', 'inner native acceptance failed')


def pending_cleanup(report):
    """A child cannot claim success for its parent's future teardown."""
    import os
    path = os.environ.get('GEUL_NATIVE_SESSION_REPORT')
    if path:
        import json
        from pathlib import Path
        try:
            session = json.loads(Path(path).read_text())
            report['nativeLauncher'] = {k: session.get(k) for k in ('runId', 'commandSha256', 'acceptanceReport')}
        except (OSError, ValueError, AttributeError):
            report['nativeLauncher'] = {}
    if report['acceptance']['status'] != 'PASS':
        report['status'] = 'FAIL'
    elif report.get('nativeLauncher', {}).get('runId') == report['runId'] and report['nativeLauncher'].get('acceptanceReport'):
        report['status'] = 'PENDING_CLEANUP'
    else:
        report['status'] = 'INCONCLUSIVE'
