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
    require(type(trace.get('seq')) is int and trace['seq'] == len(trace['records'])
            and [r[0] for r in trace['records']] == list(range(1, len(trace['records']) + 1)), 'missing/out-of-order command trace records')
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
        require(not row.get('cleanupError') and not row.get('error'), 'scenario cleanup/execution failed')


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


def usability_plan(fmt, case):
    """Expected names/limits come from the reviewed harness contract, never check rows."""
    from hashlib import sha256
    from pathlib import PurePosixPath
    from t010_usability_contract import CHECKS, STATES, COMPLEX_SOURCES, COMPLEX_CHECKS, COMPLEX_STATES
    checks, states = list(CHECKS[case]), list(STATES[case])
    chains = []
    if case == 'korean':
        chains = [('Korean', 'undo', 80), ('Korean redo', 'redo', 80), ('mixed', 'undo', 80), ('mixed redo', 'redo', 80)]
    elif case == 'boundary':
        chains = [('boundary', 'undo', 145), ('boundary redo', 'redo', 145)]
    elif case == 'complex':
        checks.append('all editor input events trusted native')
        for source in COMPLEX_SOURCES[fmt]:
            p = PurePosixPath(source)
            name = 'u-complex-' + sha256(p.name.encode()).hexdigest()[:8] + p.suffix
            checks.extend(name + ' ' + suffix for suffix in COMPLEX_CHECKS)
            states.extend(name + ' ' + suffix for suffix in COMPLEX_STATES)
            chains.extend([(name, 'undo', 120), (name + ' redo', 'redo', 120)])
    return checks, states, chains


def usability_row(row, report):
    from t010_usability_contract import KOREAN_STATES, COMPLEX_SOURCES
    fmt, case = row['format'], row['case']
    require(row.get('runId') == report['runId'] and bool(report['runId'])
            and isinstance(row.get('scenarioId'), str) and bool(row['scenarioId']), 'wrong/missing scenario run identity')
    require(not any(row.get(k) for k in ('error', 'cleanupError', 'diagnosticError', 'trace')), 'hidden scenario execution error')
    required, checkpoints, chain_plan = usability_plan(fmt, case)
    counts = Counter(c['name'] for c in row['checks'])
    require(all(counts[name] == 1 for name in required), 'missing/replaced/duplicated mandatory usability check')
    states = row.get('states')
    require(isinstance(states, list) and states, 'missing scenario checkpoints')
    labels = [s['label'] for s in states]
    require(len(set(labels)) == len(labels), 'duplicate checkpoint identity')
    by_label = {s['label']: s for s in states}
    owners = row.get('documentSessions')
    require(isinstance(owners, dict) and owners, 'missing document ownership')
    if case == 'complex':
        from hashlib import sha256
        from pathlib import PurePosixPath
        expected_documents = {'u-complex-' + sha256(PurePosixPath(p).name.encode()).hexdigest()[:8] + PurePosixPath(p).suffix for p in COMPLEX_SOURCES[fmt]}
    elif case == 'switch':
        expected_documents = {f'u-switch-a.{fmt}', f'u-switch-b.{fmt}'}
    else:
        expected_documents = {f'u-{case}.{fmt}'}
    require(set(owners.values()) == expected_documents, 'wrong scenario document identity')
    for st in states:
        require(st.get('runId') == row['runId'] and st.get('scenarioId') == row['scenarioId']
                and st.get('format') == fmt and isinstance(st.get('session'), str) and st['session'] in owners
                and isinstance(st.get('document'), str) and bool(st['document']) and st['document'] == owners[st['session']], 'checkpoint from wrong execution/document')
        require(counts[st['label'] + ': status paragraph is a prefix of the engine paragraph'] == 1,
                'missing/duplicate model observation assertion')
    require(all(label in by_label for label in checkpoints), 'missing required checkpoint')
    finals = [n for n in checkpoints if n.endswith(' continued editing')] if case == 'complex' else [checkpoints[-1]]
    for label in finals:
        st = by_label[label]
        require(st.get('status') == 'ready' and st.get('composing') == 'false' and st.get('uncertain') in (None, 'false')
                and st.get('localRevision') == st.get('revision'), 'unsettled/failed final checkpoint')
    chains = row.get('chains', [])
    require(len(chains) == len(chain_plan), 'missing/extra history chain')
    require([(c['label'], c['direction']) for c in chains] == [(label, direction) for label, direction, _ in chain_plan], 'wrong history chain identity/order')
    expected_dynamic = set()
    for chain, (label, direction, bound) in zip(chains, chain_plan):
        names = chain['states']
        require(isinstance(names, list) and 2 <= len(names) <= bound, 'missing/unbounded history steps')
        require(type(chain.get('limit')) is int and len(names) <= chain['limit'] <= bound, 'wrong history limit')
        wanted = [f'{label} before {direction} 0'] + [f'{label} {direction} {i}' for i in range(len(names)-1)]
        require(names == wanted and all(n in by_label for n in names), 'missing/reordered history checkpoint')
        for i, (a, b) in enumerate(zip(names, names[1:])):
            check = f'{label} {direction} {i} advances revision by one'
            expected_dynamic.add(check)
            require(counts[check] == 1 and int(by_label[b]['localRevision']) == int(by_label[a]['localRevision']) + 1,
                    'missing/duplicate/invalid history step assertion')
    for undo, redo in zip(chains[::2], chains[1::2]):
        require(undo['direction'] == 'undo' and redo['direction'] == 'redo'
                and len(undo['states']) == len(redo['states']), 'incomplete Undo/Redo chain pair')
    actual_dynamic = {name for name in counts if name.endswith(' advances revision by one')}
    require(actual_dynamic == expected_dynamic, 'unaccounted history step assertion')
    if case == 'boundary':
        boundary = row['boundary']
        presses, evicted = boundary['presses'], boundary['evicted']
        require(type(presses) is int and 20 <= presses <= 140 and presses % 20 == 0, 'invalid Return workload')
        require(type(evicted) is int and evicted == presses + 1 - (len(chains[0]['states'])-1) and evicted >= 0, 'invalid history eviction evidence')
        for n in range(20, presses+1, 20):
            require(counts[f'{n} rapid Returns all applied'] == 1 and f'after {n} Returns' in by_label, 'missing Return batch assertion')
        observed_batches = {name for name in counts if name.endswith(' rapid Returns all applied')}
        require(observed_batches == {f'{n} rapid Returns all applied' for n in range(20, presses+1, 20)}, 'unexpected Return batch')
        require(counts['full Undo restores original model and pages'] == (1 if evicted == 0 else 0), 'missing/incorrect conditional full-Undo assertion')
    if case == 'save':
        require(row.get('save', {}).get('state') == 'saved' and digest(row.get('savedSha256')), 'missing saved-file evidence')
    if case == 'complex':
        docs = row.get('documents', [])
        require(len(docs) == len(COMPLEX_SOURCES[fmt]) and {d['source'] for d in docs} == set(COMPLEX_SOURCES[fmt]), 'missing/unexpected complex document')
        from hashlib import sha256
        from pathlib import PurePosixPath
        for doc in docs:
            source = PurePosixPath(doc['source'])
            require(doc['copy'] == 'u-complex-' + sha256(source.name.encode()).hexdigest()[:8] + source.suffix, 'wrong complex document copy')
            require(digest(doc.get('sha256')) and doc.get('zoom') in (50, 100), 'missing complex document identity')
            backlog = [b for b in row.get('backlog', []) if b.get('document') == doc['copy']]
            require(len(backlog) == 2 and all(b.get('samples') for b in backlog), 'missing backlog observations')
            human = [b for b in backlog if b.get('mode') == 'human-rate 120ms']
            require(len(human) == 1 and type(human[0].get('maxKeydownMinusAppliedLag')) is int
                    and human[0]['maxKeydownMinusAppliedLag'] <= 3 and human[0].get('keydownsReceived', 0) > 0, 'missing/failed human-rate evidence')
    if case == 'korean':
        require(len(owners) == 1, 'unexpected composition document owner')
        evidence = row.get('compositionUndo')
        require(isinstance(evidence, dict) and all(evidence.get(k) == row[k] for k in ('runId', 'scenarioId', 'format')), 'missing/wrong-run composition evidence')
        require(evidence.get('stateLabels') == list(KOREAN_STATES), 'missing/wrong composition checkpoints')
        committed, pre, after, continued = [by_label[n] for n in KOREAN_STATES]
        require(committed['selection'] == '' and committed['composing'] == 'false'
                and type(committed['ime']['generation']) is int and committed['ime']['generation'] > 0
                and pre['ime']['historyUndo'] == committed['ime']['historyUndo']
                and pre['ime']['historyRedo'] == committed['ime']['historyRedo'] == 0
                and pre['ime']['provisional'] is False and pre['ime']['pendingCommit'] is False, 'invalid baseline/preedit history boundary')
        session = evidence.get('session')
        require(isinstance(session, str) and owners.get(session) == f'u-korean.{fmt}'
                and all(s['session'] == session for s in (committed, pre, after, continued)), 'wrong composition document/session')
        for st in (committed, pre, after, continued):
            require(str(st['ime']['session']) == session and st['ime']['revision'] == int(st['localRevision'])
                    and st['revision'] == st['localRevision'] and st['ime']['generation'] == committed['ime']['generation'], 'wrong model/IME owner or revision')
        scope = {k: evidence[k] for k in ('runId', 'scenarioId', 'format', 'session')}
        events, trace = evidence['events'], evidence['trace']
        require(events and all(all(e.get(k) == v for k, v in scope.items()) for e in events), 'native events from wrong execution')
        require(trace['records'][0][2:] == ['native:t010-composition-scope', scope], 'wrong/missing trace scope')
        outcome = composition_undo(committed, pre, after, events, trace)
        require(evidence.get('outcome') == outcome, 'stored composition disposition contradicts evidence')
        insertion(after, continued, '달', end=True)
        require(int(continued['localRevision']) == int(after['localRevision']) + 1
                and continued['composing'] == 'false' and continued['ime']['historyTransaction'] is False
                and all(s['ime']['provisional'] is False and s['ime']['pendingCommit'] is False for s in (committed, after, continued)), 'incomplete composition/continued transaction')


def usability(report, formats, cases):
    from t010_usability_contract import CASES
    require(formats and cases and len(set(formats)) == len(formats) and len(set(cases)) == len(cases)
            and set(formats) <= set(FORMATS) and set(cases) <= set(CASES), 'invalid scenario selection')
    require(report.get('formatsRequested') == formats and report.get('cases') == cases, 'missing/mismatched declared selection')
    full = set(formats) == set(FORMATS) and set(cases) == set(CASES)
    require(report.get('requestedCoverage') == ('full' if full else 'selected'), 'incorrect coverage claim')
    require(full or report.get('usabilityCoverage', {}).get('fullUsabilityCoverage') != 'PASS', 'subset claimed as full coverage')
    rows_complete(report.get('scenarios'), [(f, c) for f in formats for c in cases])
    require(len({r['scenarioId'] for r in report['scenarios']}) == len(report['scenarios']), 'duplicate scenario execution identity')
    for row in report['scenarios']:
        usability_row(row, report)
    teardown(report.get('teardown'), report.get('sessions'), report.get('runId'))
    require(not report.get('error'), 'execution error')


def usability_coverage(report, formats, cases):
    from t010_usability_contract import CASES
    selected = verdict(usability, report, formats, cases)
    full = isinstance(formats, list) and isinstance(cases, list) and set(formats) == set(FORMATS) and set(cases) == set(CASES)
    rows = report.get('scenarios')
    failed = bool(report.get('error')) or (isinstance(rows, list) and any(isinstance(r, dict) and (r.get('status') == 'FAIL' or r.get('error')) for r in rows))
    return {'selectedScenarioAcceptance': selected['status'],
            'fullUsabilityCoverage': 'FAIL' if failed else ('PASS' if full and selected['status'] == 'PASS' else 'INCOMPLETE'),
            'scope': 'full' if full else 'selected', 'evidence': 'COMPLETE' if selected['status'] == 'PASS' else 'MISSING_OR_INVALID',
            **({'reason': selected['reason']} if 'reason' in selected else {})}

def verdict(validate, *args, **kwargs):
    try:
        validate(*args, **kwargs)
        return {'status': 'PASS'}
    except (ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
        return {'status': 'FAIL', 'reason': str(error)}


def directory_cleanup(session, cleanup):
    resources, results = session.get('temporaryResources'), cleanup.get('directories')
    require(isinstance(resources, list) and isinstance(results, list) and len(resources) == len(results) == 2,
            'missing mandatory temporary directory cleanup')
    require({r['name'] for r in resources} == {r['name'] for r in results} == {'work', 'socket'}, 'wrong/duplicate temporary resources')
    require(len({r['path'] for r in resources}) == 2, 'duplicate temporary directory path')
    expected = {r['name']: r for r in resources}
    for result in results:
        resource = expected[result['name']]
        require(all(result.get(k) == resource.get(k) for k in ('name', 'runId', 'path', 'device', 'inode', 'uid', 'ownerMarker', 'ownerToken'))
                and result.get('runId') == session.get('runId') and bool(result.get('runId')), 'wrong directory ownership/run identity')
        require(isinstance(resource.get('path'), str) and resource['path'].startswith('/')
                and type(resource.get('device')) is int and type(resource.get('inode')) is int and resource['inode'] > 0
                and type(resource.get('uid')) is int and resource.get('ownerMarker') == '.geul-launcher-owner'
                and digest(resource.get('ownerToken')), 'missing directory creation identity')
        require(result.get('attempted') is True and result.get('ownershipVerified') is True
                and result.get('remaining') is False and result.get('error') is None, 'temporary directory cleanup failed/incomplete')
        require((result.get('status') == 'removed' and result.get('deleteAttempted') is True)
                or (result.get('status') == 'already-absent' and result.get('deleteAttempted') is False), 'unproven temporary directory removal')


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
    require(cleanup.get('processErrors') == [], 'recorded process cleanup errors/missing observation')
    directory_cleanup(session, cleanup)
    require(cleanup.get('filesystemProven') is True, 'filesystem cleanup not proven')
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
