"""Regression tests for T010 evidence validators; fixtures do not prove native behavior."""
import copy
import ast
import hashlib
import json
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
import unittest

import t010_acceptance as gate
import t010_usability_contract as usability_contract


D = 'a' * 64
RUN = 'run-42'
RELEASE = {
    'engine': 'rhwp', 'profile': 'release', 'generation': 'b' * 64,
    'artifacts': {'rhwp.js': 'c' * 64, 'rhwp_bg.wasm': 'd' * 64},
}
BUILD = {
    'schema': 'geul.frontend-build.v1', 'mode': 'production', 'testFlags': {},
    'assets': {'assets/app.js': 'f' * 64}, 'indexSourceSha256': 'e' * 64, 'entrypoints': ['/assets/app.js'],
}


def teardown_evidence():
    session = {'runId': RUN, 'dataHome': '/tmp/t010-data-42', 'driverPid': 1234, 'sessionId': 'webdriver-42'}
    record = {
        'runId': RUN, 'dataHome': session['dataHome'], 'driverPid': session['driverPid'],
        'sessionIds': [session['sessionId']], 'sessionDeletes': [{'outcome': 'ok'}],
        'complete': True, 'driverExit': 0, 'driverKilled': False,
        'beforeDriverStop': [{'pid': 1234}], 'afterDriverStop': [],
        'remainingAfterWait': [], 'sigtermSent': [], 'sigtermErrors': [], 'survivorsAfterSigterm': [],
    }
    return [record], [session]


def directory_cleanup_evidence(run_id=RUN):
    resources = [
        {'name': 'work', 'runId': run_id, 'path': f'/tmp/geul-work-{run_id}',
         'device': 1, 'inode': 101, 'uid': 1000, 'ownerMarker': '.geul-launcher-owner', 'ownerToken': 'a' * 64},
        {'name': 'socket', 'runId': run_id, 'path': f'/tmp/geul-socket-{run_id}',
         'device': 1, 'inode': 102, 'uid': 1000, 'ownerMarker': '.geul-launcher-owner', 'ownerToken': 'b' * 64},
    ]
    results = [{**resource, 'attempted': True, 'deleteAttempted': True,
                'ownershipVerified': True, 'status': 'removed', 'remaining': False,
                'error': None} for resource in resources]
    return resources, results


def production_evidence():
    records, sessions = teardown_evidence()
    formats = []
    for fmt in gate.FORMATS:
        formats.append({
            'format': fmt, 'status': 'PASS',
            'checks': [{'name': name, 'status': 'PASS'} for name in gate.PRODUCTION_CHECKS],
            'saves': [{'label': label, 'verified': True, 'result': {'state': 'saved'}, 'sha256': D,
                       'first': prefix + 'Fixture paragraph', 'restSha256': D}
                      for label, prefix in zip(gate.SAVES, ('Alpha 한글', 'Alpha ', 'Alpha 한글', '', 'Alpha 한글', 'Alpha Z', 'Alpha Z', 'b'))],
        })
    return {
        'runId': RUN, 'appSha256': D, 'runningApplication': [{'pid': 5678, 'startTime': '98765', 'sha256': D, 'testFlags': []}],
        'location': 'tauri://localhost', 'testFlagsInEnvironment': [],
        'frontendBuild': copy.deepcopy(BUILD), 'frontendAssetHashes': copy.deepcopy(BUILD['assets']), 'frontendEntrypoints': copy.deepcopy(BUILD['entrypoints']),
        'testTraceAbsent': True, 'testHooksAbsent': True,
        'rhwpIdentity': copy.deepcopy(RELEASE), 'servedArtifactHashes': copy.deepcopy(RELEASE['artifacts']),
        'oracleIdentity': {'generation': RELEASE['generation'], 'artifacts': copy.deepcopy(RELEASE['artifacts'])},
        'formats': formats, 'fixtureOracle': {fmt: {'first': 'Fixture paragraph', 'restSha256': D} for fmt in gate.FORMATS},
        'teardown': records, 'sessions': sessions,
    }, {'appSha256': D, 'release': copy.deepcopy(RELEASE), 'frontendBuild': copy.deepcopy(BUILD)}


def ime_state(text, caret, revision, composing='false', *, session='session-1', undo=3, redo=0, transaction=False):
    return {
        'paragraphText': text, 'caret': f'0:0:{caret}', 'selection': '',
        'localRevision': str(revision), 'revision': str(revision), 'composing': composing,
        'session': session,
        'ime': {'historyUndo': undo, 'historyRedo': redo, 'historyTransaction': transaction, 'provisional': False},
    }


def composition_fixture(accepted):
    text = '문장 가'
    committed = ime_state(text, len(text), 10, undo=4, redo=0)
    pre = ime_state(text + '나', len(text) + 1, 10, 'true', undo=4, redo=0, transaction=True)
    if accepted:
        after = ime_state(text, len(text), 12, undo=4, redo=1)
        request = {'id': 'edit.undo', 'session': 'session-1', 'available': True, 'reason': None}
        records = [[1, 1, 'dom:input', {'inputType': 'insertFromComposition', 'length': 1}], [2, 2, 'command:request', request], [3, 3, 'command:dispatch', {'id': 'edit.undo', 'accepted': True}]]
    else:
        after = ime_state(text + '나', len(text) + 1, 11, undo=5, redo=0)
        request = {'id': 'edit.undo', 'session': 'session-1', 'available': False, 'reason': 'composing'}
        records = [[1, 1, 'command:request', request], [2, 2, 'dom:input', {'inputType': 'insertFromComposition', 'length': 1}]]
    events = [
        {'type': 'keydown', 'key': 'z', 'ctrlKey': True, 'trusted': True},
        {'type': 'compositionend', 'trusted': True, 'data': '나'},
        {'type': 'input', 'inputType': 'insertFromComposition', 'trusted': True, 'data': '나'},
    ]
    trace = {'seq': len(records), 'dropped': 0, 'records': records}
    return committed, pre, after, events, trace


def rejected(function, *args):
    return gate.verdict(function, *args)['status'] == 'FAIL'


def complete_usability_evidence(formats=None, cases=None, *, composition_accepted=True,
                                boundary_pressures=None, boundary_evicted=None,
                                history_steps=None):
    """Synthetic, fully scoped evidence fixture for the validator contract only."""
    formats = list(formats or gate.FORMATS)
    cases = list(cases or usability_contract.CASES)
    full = set(formats) == set(gate.FORMATS) and set(cases) == set(usability_contract.CASES)
    records, sessions = teardown_evidence()
    report = {'runId': RUN, 'formatsRequested': formats, 'cases': cases,
              'requestedCoverage': 'full' if full else 'selected',
              'scenarios': [], 'teardown': records, 'sessions': sessions}

    for fmt in formats:
        for case in cases:
            required, fixed_states, plans = gate.usability_plan(fmt, case)
            scenario_id = f'{RUN}-{fmt}-{case}'
            if case == 'complex':
                document_names = ['u-complex-' + hashlib.sha256(PurePosixPath(p).name.encode()).hexdigest()[:8]
                                  + PurePosixPath(p).suffix for p in usability_contract.COMPLEX_SOURCES[fmt]]
            elif case == 'switch':
                document_names = [f'u-switch-a.{fmt}', f'u-switch-b.{fmt}']
            else:
                document_names = [f'u-{case}.{fmt}']
            owner_by_session = {f'{scenario_id}-doc-{i}': name for i, name in enumerate(document_names)}
            states_by_label = {}

            def state(label, revision=1, document=None, session=None):
                session = session or next(iter(owner_by_session))
                document = document or owner_by_session[session]
                return {'label': label, 'runId': RUN, 'scenarioId': scenario_id, 'format': fmt,
                        'document': document, 'session': session, 'paragraphText': 'fixture',
                        'caret': '0:0:0', 'selection': '', 'localRevision': str(revision),
                        'revision': str(revision), 'composing': 'false', 'status': 'ready',
                        'uncertain': 'false', 'pages': 1, 'settleSeconds': 0,
                        'undo': {'disabled': False}, 'redo': {'disabled': True},
                        'ime': {'session': session, 'revision': revision, 'generation': 1,
                                'historyUndo': 0, 'historyRedo': 0,
                                'historyTransaction': False, 'provisional': False,
                                'pendingCommit': False}}

            # Fixed checkpoints come from the independent reviewed contract.
            for index, label in enumerate(fixed_states):
                session = next(iter(owner_by_session))
                doc = owner_by_session[session]
                if case == 'switch' and label.startswith('B '):
                    session = list(owner_by_session)[1]
                    doc = owner_by_session[session]
                elif case == 'complex':
                    doc = next(name for name in document_names if label.startswith(name + ' '))
                    session = next(s for s, name in owner_by_session.items() if name == doc)
                states_by_label[label] = state(label, index + 1, doc, session)

            # Contracted history chains may legitimately have different depths.
            row_chains = []
            for chain_index, (label, direction, bound) in enumerate(plans):
                if case == 'boundary':
                    presses = (boundary_pressures or {}).get(fmt, 40)
                    evicted = (boundary_evicted or {}).get(fmt, 0)
                    steps = presses + 1 - evicted
                elif history_steps and case in history_steps:
                    configured = history_steps[case]
                    steps = configured[chain_index] if isinstance(configured, (tuple, list)) else configured
                else:
                    steps = 2
                steps = max(1, int(steps))
                labels = [f'{label} before {direction} 0'] + [f'{label} {direction} {i}' for i in range(steps)]
                if case == 'complex':
                    doc = next(name for name in document_names if label == name or label == name + ' redo')
                    session = next(s for s, name in owner_by_session.items() if name == doc)
                else:
                    session, doc = next(iter(owner_by_session.items()))
                for i, label_name in enumerate(labels):
                    states_by_label[label_name] = state(label_name, 100 + i, doc, session)
                row_chains.append({'label': label, 'direction': direction, 'limit': max(steps + 2, min(bound, 80)),
                                   'states': labels})

            boundary = None
            if case == 'boundary':
                presses = (boundary_pressures or {}).get(fmt, 40)
                evicted = (boundary_evicted or {}).get(fmt, 0)
                boundary = {'presses': presses, 'evicted': evicted}
                for n in range(20, presses + 1, 20):
                    label = f'after {n} Returns'
                    states_by_label[label] = state(label, n + 1)

            # The native composition checkpoints carry complete owner/revision/history evidence.
            composition = None
            if case == 'korean':
                doc_session, doc_name = next(iter(owner_by_session.items()))
                text = '문장 가'
                committed_rev, committed_undo = 10, 4
                committed = state('Redo committed syllable', committed_rev, doc_name, doc_session)
                committed.update(paragraphText=text, caret=f'0:0:{len(text)}')
                committed['ime'].update(revision=committed_rev, historyUndo=committed_undo)
                pre = state('preedit visible', committed_rev, doc_name, doc_session)
                pre.update(paragraphText=text + '나', caret=f'0:0:{len(text) + 1}', composing='true')
                pre['ime'].update(revision=committed_rev, historyUndo=committed_undo, historyTransaction=True)
                if composition_accepted:
                    after_rev, after_undo, after_redo = committed_rev + 2, committed_undo, 1
                    after_text, after_caret = text, len(text)
                    request = {'id': 'edit.undo', 'session': doc_session, 'available': True, 'reason': None}
                    ordered_trace = [
                        ['dom:input', {'inputType': 'insertFromComposition', 'length': 1}],
                        ['command:request', request],
                        ['command:dispatch', {'id': 'edit.undo', 'accepted': True}],
                    ]
                    outcome = 'accepted-after-commit'
                else:
                    after_rev, after_undo, after_redo = committed_rev + 1, committed_undo + 1, 0
                    after_text, after_caret = text + '나', len(text) + 1
                    request = {'id': 'edit.undo', 'session': doc_session, 'available': False, 'reason': 'composing'}
                    ordered_trace = [
                        ['command:request', request],
                        ['dom:input', {'inputType': 'insertFromComposition', 'length': 1}],
                    ]
                    outcome = 'refused-then-committed'
                after = state('Ctrl+Z during composition', after_rev, doc_name, doc_session)
                after.update(paragraphText=after_text, caret=f'0:0:{after_caret}')
                after['ime'].update(revision=after_rev, historyUndo=after_undo, historyRedo=after_redo)
                continued_rev = after_rev + 1
                continued_text = after_text + '달'
                continued = state('typing after composition Undo', continued_rev, doc_name, doc_session)
                continued.update(paragraphText=continued_text, caret=f'0:0:{len(continued_text)}')
                continued['ime'].update(revision=continued_rev, historyUndo=after_undo + 1)
                states_by_label.update({st['label']: st for st in (committed, pre, after, continued)})
                scope = {'runId': RUN, 'scenarioId': scenario_id, 'format': fmt, 'session': doc_session}
                events = [
                    {'type': 'keydown', 'key': 'z', 'ctrlKey': True, 'trusted': True, **scope},
                    {'type': 'compositionend', 'trusted': True, 'data': '나', **scope},
                    {'type': 'input', 'inputType': 'insertFromComposition', 'trusted': True, 'data': '나', **scope},
                ]
                trace_records = [[1, 1, 'native:t010-composition-scope', scope]]
                trace_records.extend([[index + 2, index + 2, kind, payload]
                                      for index, (kind, payload) in enumerate(ordered_trace)])
                composition = {**scope, 'stateLabels': list(usability_contract.KOREAN_STATES),
                               'events': events,
                               'trace': {'seq': len(trace_records), 'dropped': 0, 'records': trace_records},
                               'outcome': outcome}

            check_names = list(required)
            for chain, plan in zip(row_chains, plans):
                label, direction, _ = plan
                check_names.extend(f'{label} {direction} {i} advances revision by one'
                                   for i in range(len(chain['states']) - 1))
            if boundary:
                check_names.extend(f'{n} rapid Returns all applied'
                                   for n in range(20, boundary['presses'] + 1, 20))
                if boundary['evicted'] == 0:
                    check_names.append('full Undo restores original model and pages')
            check_names.extend(label + ': status paragraph is a prefix of the engine paragraph'
                               for label in states_by_label)
            row = {'runId': RUN, 'scenarioId': scenario_id, 'format': fmt, 'case': case,
                   'status': 'PASS', 'checks': [{'name': name, 'status': 'PASS'} for name in check_names],
                   'states': list(states_by_label.values()), 'documentSessions': owner_by_session,
                   'chains': row_chains}
            if boundary:
                row['boundary'] = boundary
            if composition:
                row['compositionUndo'] = composition
            if case == 'save':
                row.update(save={'state': 'saved'}, savedSha256=D)
            if case == 'complex':
                documents, backlog = [], []
                for source, name in zip(usability_contract.COMPLEX_SOURCES[fmt], document_names):
                    documents.append({'source': source, 'copy': name, 'sha256': D, 'zoom': 100})
                    backlog.extend([
                        {'document': name, 'mode': 'rapid', 'samples': [[1, 1, 1, 1]]},
                        {'document': name, 'mode': 'human-rate 120ms', 'samples': [[1, 1, 1, 1]],
                         'maxKeydownMinusAppliedLag': 1, 'keydownsReceived': 2},
                    ])
                row.update(documents=documents, backlog=backlog)
            report['scenarios'].append(row)
    if not full:
        report['usabilityCoverage'] = {'fullUsabilityCoverage': 'INCOMPLETE'}
    return report


class InsertionAssertions(unittest.TestCase):
    def test_valid_exact_unicode_insertion_and_caret(self):
        before = {'paragraphText': '가나 다', 'caret': '0:0:2'}
        after = {'paragraphText': '가나달 다', 'caret': '0:0:3', 'selection': '', 'revision': '5', 'localRevision': '5'}
        gate.insertion(before, after, '달')

    def test_verdict_preserves_keyword_only_end_caret_contract(self):
        before = {'paragraphText': '가나', 'caret': '0:0:1'}
        after = {'paragraphText': '가달나', 'caret': '0:0:3', 'selection': '', 'revision': '5', 'localRevision': '5'}
        self.assertEqual(gate.verdict(gate.insertion, before, after, '달', end=True)['status'], 'PASS')
        after['caret'] = '0:0:2'
        self.assertEqual(gate.verdict(gate.insertion, before, after, '달', end=True)['status'], 'FAIL')

    def test_rejects_reordering(self):
        before = {'paragraphText': '가', 'caret': '0:0:1'}
        wrong = {'paragraphText': '나가', 'caret': '0:0:2', 'selection': '', 'revision': '1', 'localRevision': '1'}
        self.assertTrue(rejected(gate.insertion, before, wrong, '나'))

    def test_rejects_duplicated_syllable(self):
        before = {'paragraphText': '가', 'caret': '0:0:1'}
        wrong = {'paragraphText': '가나나', 'caret': '0:0:3', 'selection': '', 'revision': '1', 'localRevision': '1'}
        self.assertTrue(rejected(gate.insertion, before, wrong, '나'))

    def test_rejects_missing_committed_syllable(self):
        committed, pre, after, events, trace = composition_fixture(False)
        after['paragraphText'] = committed['paragraphText']
        self.assertTrue(rejected(gate.composition_undo, committed, pre, after, events, trace))

    def test_rejects_correct_text_at_wrong_position(self):
        before = {'paragraphText': '가나 다', 'caret': '0:0:2'}
        wrong = {'paragraphText': '가나 다달', 'caret': '0:0:5', 'selection': '', 'revision': '5', 'localRevision': '5'}
        self.assertTrue(rejected(gate.insertion, before, wrong, '달'))

    def test_rejects_wrong_caret_independently(self):
        before = {'paragraphText': '가나', 'caret': '0:0:2'}
        after = {'paragraphText': '가나달', 'caret': '0:0:2', 'selection': '', 'revision': '5', 'localRevision': '5'}
        self.assertTrue(rejected(gate.insertion, before, after, '달'))

    def test_rejects_unsettled_revision_independently(self):
        before = {'paragraphText': '가나', 'caret': '0:0:2'}
        after = {'paragraphText': '가나달', 'caret': '0:0:3', 'selection': '', 'revision': '5', 'localRevision': '4'}
        self.assertTrue(rejected(gate.insertion, before, after, '달'))

    def test_accepts_both_explicit_native_transaction_outcomes(self):
        for accepted, expected in ((True, 'accepted-after-commit'), (False, 'refused-then-committed')):
            with self.subTest(accepted=accepted):
                self.assertEqual(gate.composition_undo(*composition_fixture(accepted)), expected)

    def test_rejects_incomplete_trace_native_key_and_transaction_boundary(self):
        fixture = composition_fixture(True)
        f = copy.deepcopy(fixture); f[4]['records'].pop(0)
        self.assertTrue(rejected(gate.composition_undo, *f))
        f = copy.deepcopy(fixture); f[3][0]['ctrlKey'] = False
        self.assertTrue(rejected(gate.composition_undo, *f))
        f = copy.deepcopy(fixture); f[1]['ime']['historyTransaction'] = False
        self.assertTrue(rejected(gate.composition_undo, *f))
        f = copy.deepcopy(fixture); f[2]['session'] = 'another-owner'
        self.assertTrue(rejected(gate.composition_undo, *f))

    def test_rejects_missing_untrusted_or_synthetic_native_evidence(self):
        fixture = composition_fixture(False)
        self.assertTrue(rejected(gate.composition_undo, *fixture[:3], [], fixture[4]))
        events = copy.deepcopy(fixture[3]); events[1]['trusted'] = False
        self.assertTrue(rejected(gate.composition_undo, *fixture[:3], events, fixture[4]))
        events = copy.deepcopy(fixture[3]); events[2]['inputType'] = 'insertText'
        self.assertTrue(rejected(gate.composition_undo, *fixture[:3], events, fixture[4]))

    def test_rejects_wrong_undo_disposition_revision_owner_and_history(self):
        fixture = composition_fixture(False)
        cases = []
        f = copy.deepcopy(fixture); f[4]['records'][0][3]['session'] = 'other'; cases.append(f)
        f = copy.deepcopy(fixture); f[2]['localRevision'] = '12'; f[2]['revision'] = '12'; cases.append(f)
        f = copy.deepcopy(fixture); f[2]['ime']['historyUndo'] = 4; cases.append(f)
        f = copy.deepcopy(fixture); f[4]['records'].append([2, 2, 'command:dispatch', {'id': 'edit.undo', 'accepted': False}]); cases.append(f)
        for case in cases:
            with self.subTest(case=case):
                self.assertTrue(rejected(gate.composition_undo, *case))


class TeardownAssertions(unittest.TestCase):
    def test_accepts_complete_owned_teardown(self):
        gate.teardown(*teardown_evidence(), RUN)

    def test_rejects_missing_extra_failed_or_wrong_identity_teardown(self):
        records, sessions = teardown_evidence()
        self.assertTrue(rejected(gate.teardown, [], sessions, RUN))
        self.assertTrue(rejected(gate.teardown, records + copy.deepcopy(records), sessions, RUN))
        bad = copy.deepcopy(records); bad[0]['sessionDeletes'][0]['outcome'] = 'httpError'
        self.assertTrue(rejected(gate.teardown, bad, sessions, RUN))
        bad = copy.deepcopy(records); bad[0]['remainingAfterWait'] = [{'pid': 999}]
        self.assertTrue(rejected(gate.teardown, bad, sessions, RUN))
        bad = copy.deepcopy(records); bad[0]['runId'] = 'other'
        self.assertTrue(rejected(gate.teardown, bad, sessions, RUN))
        bad = copy.deepcopy(records); bad[0]['sessionIds'] = ['wrong-session']
        self.assertTrue(rejected(gate.teardown, bad, sessions, RUN))
        bad = copy.deepcopy(records); bad[0]['driverPid'] = 7
        self.assertTrue(rejected(gate.teardown, bad, sessions, RUN))
        bad = copy.deepcopy(records); del bad[0]['survivorsAfterSigterm']
        self.assertTrue(rejected(gate.teardown, bad, sessions, RUN))


class ProductionAssertions(unittest.TestCase):
    def setUp(self):
        self.report, self.expected = production_evidence()

    def test_accepts_complete_production_evidence(self):
        gate.production(self.report, self.expected)

    def test_rejects_executable_origin_runtime_and_build_identity(self):
        mutations = []
        r = copy.deepcopy(self.report); r['appSha256'] = '0' * 64; mutations.append(r)
        r = copy.deepcopy(self.report); r['runningApplication'][0]['sha256'] = '0' * 64; mutations.append(r)
        r = copy.deepcopy(self.report); r['location'] = 'http://localhost:1420'; mutations.append(r)
        r = copy.deepcopy(self.report); r['location'] = 'tauri://unexpected'; mutations.append(r)
        r = copy.deepcopy(self.report); r['testFlagsInEnvironment'] = ['VITE_GEUL_TEST_HOOKS']; mutations.append(r)
        r = copy.deepcopy(self.report); r['frontendBuild']['testFlags'] = {'VITE_GEUL_TEST_HOOKS': '1'}; mutations.append(r)
        r = copy.deepcopy(self.report); del r['frontendBuild']; mutations.append(r)
        r = copy.deepcopy(self.report); r['frontendBuild']['mode'] = 'development'; mutations.append(r)
        r = copy.deepcopy(self.report); r['frontendAssetHashes']['assets/app.js'] = '0' * 64; mutations.append(r)
        r = copy.deepcopy(self.report); r['testTraceAbsent'] = False; mutations.append(r)
        r = copy.deepcopy(self.report); r['frontendEntrypoints'] = ['/src/main.tsx']; mutations.append(r)
        for report in mutations:
            with self.subTest(report=report):
                self.assertTrue(rejected(gate.production, report, self.expected))

    def test_rejects_release_generation_artifact_and_oracle_identity(self):
        mutations = []
        r = copy.deepcopy(self.report); r['rhwpIdentity']['generation'] = '0' * 64; mutations.append((r, self.expected))
        r = copy.deepcopy(self.report); r['rhwpIdentity']['artifacts']['rhwp.js'] = '0' * 64; mutations.append((r, self.expected))
        r = copy.deepcopy(self.report); r['servedArtifactHashes'] = {}; mutations.append((r, self.expected))
        r = copy.deepcopy(self.report); r['oracleIdentity'] = None; mutations.append((r, self.expected))
        expected = copy.deepcopy(self.expected); expected['release']['generation'] = '0' * 64
        mutations.append((copy.deepcopy(self.report), expected))
        expected = copy.deepcopy(self.expected); expected['release']['artifacts']['rhwp_bg.wasm'] = '0' * 64
        mutations.append((copy.deepcopy(self.report), expected))
        for report, expected in mutations:
            with self.subTest(report=report, expected=expected):
                self.assertTrue(rejected(gate.production, report, expected))

    def test_rejects_missing_scenario_failed_assertion_and_content_oracle(self):
        for fmt in gate.FORMATS:
            r = copy.deepcopy(self.report); r['formats'] = [row for row in r['formats'] if row['format'] != fmt]
            self.assertTrue(rejected(gate.production, r, self.expected), f'missing {fmt}')
        r = copy.deepcopy(self.report); r['formats'][0]['checks'][0]['status'] = 'FAIL'; self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['formats'][0]['checks'].pop(); self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['formats'][0]['saves'].pop(); self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['formats'][1]['saves'][0]['verified'] = False; self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['formats'][0]['saves'][0]['result']['state'] = 'failed'; self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['formats'][0]['saves'][0]['first'] += 'duplicate'; self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['formats'][1]['saves'][0]['restSha256'] = '0' * 64; self.assertTrue(rejected(gate.production, r, self.expected))

    def test_rejects_teardown_failure_inside_overall_production_acceptance(self):
        r = copy.deepcopy(self.report); r['teardown'] = []
        self.assertTrue(rejected(gate.production, r, self.expected))
        r = copy.deepcopy(self.report); r['teardown'][0]['sessionDeletes'][0]['outcome'] = 'driverLost'
        self.assertTrue(rejected(gate.production, r, self.expected))


class UsabilityAssertions(unittest.TestCase):
    def test_accepts_each_complete_scenario_and_full_sixteen_rows(self):
        for case in usability_contract.CASES:
            with self.subTest(case=case):
                report = complete_usability_evidence(cases=[case])
                gate.usability(report, report['formatsRequested'], report['cases'])
        report = complete_usability_evidence()
        gate.usability(report, report['formatsRequested'], report['cases'])
        self.assertEqual(gate.usability_coverage(report, report['formatsRequested'], report['cases'])['fullUsabilityCoverage'], 'PASS')

    def test_accepts_korean_accepted_and_refused_native_transaction_outcomes(self):
        for accepted in (True, False):
            report = complete_usability_evidence(cases=['korean'], composition_accepted=accepted)
            gate.usability(report, report['formatsRequested'], report['cases'])
            outcomes = {r['compositionUndo']['outcome'] for r in report['scenarios']}
            self.assertEqual(outcomes, {'accepted-after-commit' if accepted else 'refused-then-committed'})

    def test_accepts_dynamic_history_depths_and_boundary_eviction_counts(self):
        report = complete_usability_evidence(cases=['korean', 'boundary'],
                                             history_steps={'korean': (3, 3, 2, 2)},
                                             boundary_pressures={'hwp': 40, 'hwpx': 100},
                                             boundary_evicted={'hwp': 0, 'hwpx': 7})
        gate.usability(report, report['formatsRequested'], report['cases'])

    def test_declared_subset_passes_selected_scope_but_is_not_full_coverage(self):
        report = complete_usability_evidence(formats=['hwp'], cases=['english', 'korean'])
        gate.usability(report, report['formatsRequested'], report['cases'])
        coverage = gate.usability_coverage(report, report['formatsRequested'], report['cases'])
        self.assertEqual(coverage['selectedScenarioAcceptance'], 'PASS')
        self.assertEqual(coverage['fullUsabilityCoverage'], 'INCOMPLETE')

    def test_every_fixed_and_dynamic_final_checkpoint_requires_explicit_certainty(self):
        source = complete_usability_evidence()
        missing = object()
        invalid_values = (missing, None, 'true', '', 'unknown', False, True, 0, [], {})

        for row_index, source_row in enumerate(source['scenarios']):
            required, checkpoints, _ = gate.usability_plan(source_row['format'], source_row['case'])
            final_labels = ([label for label in checkpoints if label.endswith(' continued editing')]
                            if source_row['case'] == 'complex' else [checkpoints[-1]])
            for label in final_labels:
                check_name = (label.removesuffix(' continued editing') + ' final ready/certain/settled'
                              if source_row['case'] == 'complex'
                              else next(name for name in required if name.endswith('ready/certain/settled')))
                for value in invalid_values:
                    with self.subTest(format=source_row['format'], case=source_row['case'],
                                      checkpoint=label, uncertain=value):
                        report = copy.deepcopy(source)
                        row = report['scenarios'][row_index]
                        state = next(s for s in row['states'] if s['label'] == label)
                        if value is missing:
                            state.pop('uncertain')
                        else:
                            state['uncertain'] = value
                        # Keep the earlier ready/certain/settled assertion explicitly PASS.
                        self.assertTrue(any(check['name'] == check_name and check['status'] == 'PASS'
                                            for check in row['checks']))
                        self.assertTrue(rejected(gate.usability, report,
                                                 report['formatsRequested'], report['cases']))

    def test_native_ready_check_requires_explicit_certain_status_value(self):
        source_path = Path(__file__).with_name('native-t010-usability.py')
        module = ast.parse(source_path.read_text(encoding='utf-8'), filename=str(source_path))
        native_class = next(node for node in module.body
                            if isinstance(node, ast.ClassDef) and node.name == 'Usability')
        methods = [node for node in native_class.body
                   if isinstance(node, ast.FunctionDef) and node.name in ('check', 'ready_ok')]
        isolated_class = ast.ClassDef(name='IsolatedUsabilityObservation', bases=[], keywords=[],
                                      body=methods, decorator_list=[])
        isolated_module = ast.fix_missing_locations(ast.Module(body=[isolated_class], type_ignores=[]))
        namespace = {'smoke': SimpleNamespace(Failure=RuntimeError), 'json': json}
        exec(compile(isolated_module, str(source_path), 'exec'), namespace)
        usability = namespace['IsolatedUsabilityObservation']()

        def observe(state):
            usability.current = {'format': 'hwp', 'case': 'english', 'checks': []}
            try:
                usability.ready_ok(state, 'english final')
            except RuntimeError:
                pass
            return usability.current['checks'][-1]['status']

        certain = {'status': 'ready', 'uncertain': 'false', 'composing': 'false',
                   'localRevision': '7', 'revision': '7'}
        self.assertEqual(observe(copy.deepcopy(certain)), 'PASS')
        invalid_states = []
        missing = copy.deepcopy(certain); del missing['uncertain']; invalid_states.append(missing)
        for value in (None, 'true', '', 'unknown', False, True, 0, [], {}):
            invalid = copy.deepcopy(certain); invalid['uncertain'] = value; invalid_states.append(invalid)
        for state in invalid_states:
            with self.subTest(state=state):
                self.assertEqual(observe(state), 'FAIL')

        for key, value in (('status', 'loading'), ('composing', 'true'), ('revision', '8')):
            invalid = copy.deepcopy(certain); invalid[key] = value
            with self.subTest(guard=key):
                self.assertEqual(observe(invalid), 'FAIL')

    def test_rejects_arbitrary_only_korean_pass_and_missing_replaced_or_duplicate_checks(self):
        report = complete_usability_evidence(cases=['korean'])
        row = report['scenarios'][0]
        row['checks'] = [{'name': 'native exact assertion', 'status': 'PASS'}]
        self.assertTrue(rejected(gate.usability, report, report['formatsRequested'], report['cases']))

        source = complete_usability_evidence(cases=['korean'])
        for fmt in gate.FORMATS:
            original = next(r for r in source['scenarios'] if r['format'] == fmt)
            for name in usability_contract.CHECKS['korean']:
                with self.subTest(format=fmt, check=name, mutation='missing'):
                    bad = copy.deepcopy(source)
                    row = next(r for r in bad['scenarios'] if r['format'] == fmt)
                    row['checks'] = [c for c in row['checks'] if c['name'] != name]
                    self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))
                with self.subTest(format=fmt, check=name, mutation='replaced'):
                    bad = copy.deepcopy(source)
                    row = next(r for r in bad['scenarios'] if r['format'] == fmt)
                    row['checks'] = [c for c in row['checks'] if c['name'] != name]
                    row['checks'].append({'name': 'unrelated PASS', 'status': 'PASS'})
                    self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))
                with self.subTest(format=fmt, check=name, mutation='duplicate'):
                    bad = copy.deepcopy(source)
                    row = next(r for r in bad['scenarios'] if r['format'] == fmt)
                    required_check = next(c for c in row['checks'] if c['name'] == name)
                    row['checks'].append(copy.deepcopy(required_check))
                    self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))

    def test_rejects_missing_corrupt_or_mis_scoped_korean_composition_evidence(self):
        source = complete_usability_evidence(cases=['korean'])
        mutations = []
        bad = copy.deepcopy(source); del bad['scenarios'][0]['compositionUndo']; mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['trace']['records'].pop(); mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['trace']['records'][0] = [1, 1, 'noise', {}]; mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['events'][1]['trusted'] = False; mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['events'].pop(); mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['runId'] = 'other-run'; mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['scenarioId'] = 'other-scenario'; mutations.append(bad)
        bad = copy.deepcopy(source); bad['scenarios'][0]['compositionUndo']['session'] = 'other-session'; mutations.append(bad)
        def mutate_state(label, callback):
            def apply(row):
                callback(next(s for s in row['states'] if s['label'] == label))
            return apply
        for key, mutate in (
            ('text', mutate_state('Ctrl+Z during composition', lambda state: state.update(paragraphText='문장 가나나'))),
            ('caret', mutate_state('Ctrl+Z during composition', lambda state: state.update(caret='0:0:1'))),
            ('revision', mutate_state('Ctrl+Z during composition', lambda state: state.update(localRevision='13', revision='13'))),
            ('history', mutate_state('Ctrl+Z during composition', lambda state: state['ime'].update(historyUndo=99))),
            ('preedit history', mutate_state('preedit visible', lambda state: state['ime'].update(historyUndo=99))),
            ('baseline selection', mutate_state('Redo committed syllable', lambda state: state.update(selection='0:0:1'))),
            ('trace sequence huge', lambda row: row['compositionUndo']['trace'].update(seq=10**12)),
            ('state run', mutate_state('Ctrl+Z during composition', lambda state: state.update(runId='other-run'))),
            ('state session', mutate_state('Ctrl+Z during composition', lambda state: state.update(session='other-session'))),
            ('scenario check', lambda row: row['checks'].remove(next(c for c in row['checks'] if c['name'] == 'composition Undo has exact native text/caret/revision/history outcome'))),
        ):
            bad = copy.deepcopy(source)
            for row in bad['scenarios']:
                if row['format'] == 'hwp':
                    mutate(row)
                    break
            mutations.append(bad)
        for index, report in enumerate(mutations):
            with self.subTest(index=index):
                self.assertTrue(rejected(gate.usability, report, report['formatsRequested'], report['cases']))

    def test_rejects_missing_other_scenario_assertion_absent_row_and_bad_full_claim(self):
        report = complete_usability_evidence(cases=['english', 'selection'])
        bad = copy.deepcopy(report)
        row = next(r for r in bad['scenarios'] if r['case'] == 'english' and r['format'] == 'hwp')
        row['checks'] = [c for c in row['checks'] if c['name'] != usability_contract.CHECKS['english'][0]]
        self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))
        bad = copy.deepcopy(report)
        bad['scenarios'] = [r for r in bad['scenarios'] if not (r['case'] == 'selection' and r['format'] == 'hwpx')]
        self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))
        bad = copy.deepcopy(report)
        bad['requestedCoverage'] = 'full'
        bad['usabilityCoverage'] = {'fullUsabilityCoverage': 'PASS'}
        self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))

    def test_rejects_missing_dynamic_step_checkpoint_and_model_observation(self):
        source = complete_usability_evidence(cases=['korean'])
        for mutation in ('step-check', 'step-state', 'state-observation'):
            bad = copy.deepcopy(source)
            row = bad['scenarios'][0]
            chain = row['chains'][0]
            if mutation == 'step-check':
                name = 'Korean undo 0 advances revision by one'
                row['checks'] = [c for c in row['checks'] if c['name'] != name]
            elif mutation == 'step-state':
                label = chain['states'][1]
                row['states'] = [state for state in row['states'] if state['label'] != label]
            else:
                label = chain['states'][1]
                name = label + ': status paragraph is a prefix of the engine paragraph'
                row['checks'] = [c for c in row['checks'] if c['name'] != name]
            with self.subTest(mutation=mutation):
                self.assertTrue(rejected(gate.usability, bad, bad['formatsRequested'], bad['cases']))

    def test_contract_inventory_matches_literal_harness_checkpoints_and_states(self):
        from pathlib import Path
        harness_path = Path(__file__).with_name('native-t010-usability.py')
        module = ast.parse(harness_path.read_text())
        usability_class = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == 'Usability')
        methods = {n.name: n for n in usability_class.body if isinstance(n, ast.FunctionDef)}

        def calls(method, attribute):
            return [n for n in ast.walk(method) if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute) and n.func.attr == attribute]

        def literal(arg):
            return arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None

        ready_event = 'all editor input events trusted native'
        for case, method_name in (('english', 'english'), ('korean', 'korean'), ('selection', 'selection'),
                                  ('boundary', 'boundary'), ('switch', 'switch'), ('close', 'close_case'), ('save', 'save')):
            method = methods[method_name]
            literal_checks = [literal(call.args[0]) for call in calls(method, 'check') if call.args]
            literal_checks = [name for name in literal_checks if name is not None]
            ready_labels = [literal(call.args[1]) for call in calls(method, 'ready_ok') if len(call.args) > 1]
            actual = literal_checks + [label + ' ready/certain/settled' for label in ready_labels]
            actual.append(ready_event)  # scenario() records this after the method succeeds
            expected = list(usability_contract.CHECKS[case])
            if case == 'boundary':
                # This assertion is deliberately conditional on zero evicted transactions.
                expected.append('full Undo restores original model and pages')
            self.assertCountEqual(actual, expected, case)

            literal_states = [literal(call.args[0]) for call in calls(method, 'state') if call.args]
            literal_states = [label for label in literal_states if label is not None]
            self.assertCountEqual(literal_states, usability_contract.STATES[case], case)

        complex_method = methods['complex']
        complex_check_suffixes = []
        for call in calls(complex_method, 'check'):
            if not call.args or not isinstance(call.args[0], ast.JoinedStr):
                continue
            tail = ''.join(part.value for part in call.args[0].values if isinstance(part, ast.Constant))
            complex_check_suffixes.append(tail.strip())
        complex_check_suffixes.append('final ready/certain/settled')  # generated by ready_ok(name + ' final')
        self.assertCountEqual(complex_check_suffixes, usability_contract.COMPLEX_CHECKS)
        complex_state_suffixes = []
        for call in calls(complex_method, 'state'):
            if not call.args or not isinstance(call.args[0], ast.JoinedStr):
                continue
            tail = ''.join(part.value for part in call.args[0].values if isinstance(part, ast.Constant))
            complex_state_suffixes.append(tail.strip())
        self.assertCountEqual(complex_state_suffixes, usability_contract.COMPLEX_STATES)

        # The helper-generated names are a bounded, explicit dynamic contract.
        for case in usability_contract.CASES:
            checks, state_names, chains = gate.usability_plan('hwp', case)
            self.assertTrue(all(isinstance(name, str) and name for name in checks + state_names), case)
            if case in ('korean', 'boundary', 'complex'):
                self.assertTrue(chains, case)
                self.assertTrue(all(label and direction in ('undo', 'redo') and bound > 1
                                    for label, direction, bound in chains), case)

    def test_rejects_missing_scenario_failed_check_and_teardown(self):
        records, sessions = teardown_evidence()
        report = {'runId': RUN, 'scenarios': [{'format': fmt, 'case': case, 'status': 'PASS',
                   'checks': [{'name': 'assertion', 'status': 'PASS'}]} for fmt in gate.FORMATS for case in ('english', 'korean')],
                  'teardown': records, 'sessions': sessions}
        r = copy.deepcopy(report); r['scenarios'].pop()
        self.assertTrue(rejected(gate.usability, r, list(gate.FORMATS), ['english', 'korean']))
        r = copy.deepcopy(report); r['scenarios'][0]['checks'][0]['status'] = 'FAIL'
        self.assertTrue(rejected(gate.usability, r, list(gate.FORMATS), ['english', 'korean']))
        r = copy.deepcopy(report); r['teardown'] = []
        self.assertTrue(rejected(gate.usability, r, list(gate.FORMATS), ['english', 'korean']))


class LauncherCleanupAssertions(unittest.TestCase):
    def setUp(self):
        self.command_hash = '9' * 64
        self.report = {
            'runId': RUN, 'acceptance': {'status': 'PASS'},
            'nativeLauncher': {'runId': RUN, 'commandSha256': self.command_hash, 'acceptanceReport': '/tmp/t010/final.json'},
        }
        resources, directories = directory_cleanup_evidence()
        self.session = {'runId': RUN, 'commandSha256': self.command_hash, 'acceptanceReport': '/tmp/t010/final.json',
                        'temporaryResources': resources}
        self.cleanup = {'processErrors': [], 'ownedAtTeardown': 3, 'leakedAfterManagedStop': {}, 'runId': RUN, 'commandSha256': self.command_hash, 'complete': True, 'proven': True,
                        'subreaper': True, 'survivors': [], 'exit': 0,
                        'directories': directories, 'filesystemProven': True}

    def test_accepts_complete_matching_outer_launcher_cleanup(self):
        gate.launcher_cleanup(self.report, self.session, self.cleanup)

    def test_recorded_process_errors_cannot_be_hidden_by_proven_true(self):
        for errors in (None, [{'type': 'OSError', 'message': 'injected process failure'}]):
            bad = copy.deepcopy(self.cleanup)
            if errors is None:
                bad.pop('processErrors')
            else:
                bad['processErrors'] = errors
            self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))

    def test_rejects_missing_failed_or_mismatched_outer_cleanup(self):
        bad = copy.deepcopy(self.cleanup); bad['complete'] = False
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))
        bad = copy.deepcopy(self.cleanup); bad['proven'] = False
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))
        bad = copy.deepcopy(self.cleanup); bad['survivors'] = [999]
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))
        bad = copy.deepcopy(self.cleanup); bad['exit'] = 1
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))
        bad = copy.deepcopy(self.cleanup); bad['runId'] = 'another-run'
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))
        bad = copy.deepcopy(self.cleanup); bad['commandSha256'] = '8' * 64
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, self.session, bad))
        bad_session = copy.deepcopy(self.session); bad_session['acceptanceReport'] = '/tmp/other.json'
        self.assertTrue(rejected(gate.launcher_cleanup, self.report, bad_session, self.cleanup))

    def test_child_remains_pending_until_matching_parent_cleanup_is_available(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        report = {'runId': RUN, 'acceptance': {'status': 'PASS'}}
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('GEUL_NATIVE_SESSION_REPORT', None)
            gate.pending_cleanup(report)
        self.assertEqual(report['status'], 'INCONCLUSIVE')

        report = {'runId': RUN, 'acceptance': {'status': 'PASS'}}
        with tempfile.TemporaryDirectory() as directory:
            session_path = Path(directory) / 'session.json'
            session_path.write_text(json.dumps(self.session))
            with patch.dict(os.environ, {'GEUL_NATIVE_SESSION_REPORT': str(session_path)}):
                gate.pending_cleanup(report)
        self.assertEqual(report['status'], 'PENDING_CLEANUP')
        self.assertNotEqual(report['status'], 'PASS')

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing-session.json'
            for malformed in (None, '{broken-json', '[]'):
                if malformed is not None:
                    path.write_text(malformed)
                report = {'runId': RUN, 'acceptance': {'status': 'PASS'}}
                with patch.dict(os.environ, {'GEUL_NATIVE_SESSION_REPORT': str(path)}):
                    gate.pending_cleanup(report)
                self.assertEqual(report['status'], 'INCONCLUSIVE')


        report = {'runId': RUN, 'acceptance': {'status': 'FAIL'}}
        gate.pending_cleanup(report)
        self.assertEqual(report['status'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
