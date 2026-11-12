"""Regression tests for T010 evidence validators; fixtures do not prove native behavior."""
import copy
import unittest

import t010_acceptance as gate


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
    def test_accepts_all_selected_formats_and_scenarios_with_teardown(self):
        records, sessions = teardown_evidence()
        report = {
            'runId': RUN,
            'scenarios': [{'format': fmt, 'case': case, 'status': 'PASS',
                           'checks': [{'name': 'native exact assertion', 'status': 'PASS'}]}
                          for fmt in gate.FORMATS for case in ('english', 'korean')],
            'teardown': records, 'sessions': sessions,
        }
        gate.usability(report, list(gate.FORMATS), ['english', 'korean'])

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
        self.session = {'runId': RUN, 'commandSha256': self.command_hash, 'acceptanceReport': '/tmp/t010/final.json'}
        self.cleanup = {'ownedAtTeardown': 3, 'leakedAfterManagedStop': {}, 'runId': RUN, 'commandSha256': self.command_hash, 'complete': True, 'proven': True,
                        'subreaper': True, 'survivors': [], 'exit': 0}

    def test_accepts_complete_matching_outer_launcher_cleanup(self):
        gate.launcher_cleanup(self.report, self.session, self.cleanup)

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
