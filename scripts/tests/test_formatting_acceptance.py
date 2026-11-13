"""Contract tests for the RHWP formatting Stage 5/6 finalizer (pure validation; no Tauri, no RHWP build)."""
import copy
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import formatting_acceptance as contract
import t010_launcher as launcher
import test_t010_acceptance as fixtures

D, E, RUN, COMMAND = 'a' * 64, 'b' * 64, fixtures.RUN, '9' * 64


def event_log():
    log = []

    def add(kind, target, **extra):
        log.append({'seq': len(log), 'type': kind, 'trusted': True, 'target': target, **extra})
    add('keydown', 'body')
    add('compositionstart', 'rhwp-input'); add('compositionend', 'rhwp-input', data='안')
    snapshot = len(log)  # what the old harness looked at: the log as of the IME check
    for name in ('strikethrough', 'bold', 'italic', 'underline'):
        add('mousedown', 'format.' + name); add('click', 'format.' + name)
    add('click', 'tab-close'); add('keydown', 'rhwp-input'); add('click', 'tab-close')
    return log, snapshot


def row(fmt):
    models = contract.expected_models()
    log, _ = event_log()
    return {'format': fmt, 'status': 'PASS', 'checks': [{'name': name, 'status': 'PASS'} for name in contract.CHECKS],
            'operations': [{'command': 'format.' + name, 'via': how, 'selection': selection, 'canvasBefore': D, 'canvasAfter': E}
                           for name, how, selection in contract.OPERATIONS],
            'saves': [{'label': label, 'verified': True, 'result': {'state': 'saved'}, 'sha256': digest, 'model': copy.deepcopy(models[label])}
                      for label, digest in zip(contract.SAVES, (D, E))],
            'reopen': {'nativeChooser': True, 'pressed': copy.deepcopy(contract.REOPEN_PRESSED), 'localRevision': '0', 'dirty': 'false', 'savedSha256': E},
            'events': log, 'eventCount': len(log)}


class Evidence:
    """A complete, consistent evidence set on disk; tests mutate one aspect and re-evaluate."""

    def __init__(self, folder):
        self.folder = Path(folder)
        self.result = self.folder / 'native/result.json'
        self.session_dir = self.folder / 'session'
        self.result.parent.mkdir(); self.session_dir.mkdir()
        self.report, trusted = fixtures.production_evidence()
        self.expected = {**trusted, 'productTrees': dict.fromkeys(contract.PRODUCT_PATHS, 'c' * 40), 'sourceDiffSha256': contract.EMPTY_DIFF,
                         'harness': dict.fromkeys(contract.HARNESS_FILES, D)}
        for record in self.report['teardown'] + self.report['sessions']:
            record['dataHome'] = str(self.result.parent.resolve() / 'data')
        self.report.pop('fixtureOracle')
        self.report.update(formats=[row(fmt) for fmt in contract.FORMATS], expectedIdentity=copy.deepcopy(trusted), head='c' * 40, productTrees=dict(self.expected['productTrees']),
                           sourceDiffSha256=contract.EMPTY_DIFF, harnessSha256=dict(self.expected['harness']),
                           contract={'schema': contract.SCHEMA, 'formats': list(contract.FORMATS), 'checks': list(contract.CHECKS)},
                           status=contract.PENDING, acceptance={'status': 'PASS'}, nativeLauncher={'runId': RUN, 'commandSha256': COMMAND})
        resources = [launcher.create_directory(name, RUN, parent=self.folder) for name in launcher.RESOURCE_NAMES]
        self.session = {'runId': RUN, 'commandSha256': COMMAND, 'acceptanceReport': None, 'temporaryResources': resources,
                        'globalEngine': 'hangul', 'setGlobalEngine': {'exit': 0}}
        self.cleanup = {'runId': RUN, 'commandSha256': COMMAND, 'complete': True, 'exit': 0, 'subreaper': True, 'ownedAtTeardown': 7,
                        'leakedAfterManagedStop': {}, 'survivors': [], 'proven': True, 'processErrors': [],
                        'directories': launcher.cleanup_directories(resources, RUN), 'filesystemProven': True}

    def evaluate(self, launcher_exit=0, skip=()):
        for path, value in ((self.result, self.report), (self.session_dir / 'session.json', self.session), (self.session_dir / 'cleanup.json', self.cleanup)):
            if path.name not in skip:
                path.write_text(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False))
        return contract.evaluate(self.result, self.session_dir, self.expected, launcher_exit)


class FinalizerTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.e = Evidence(folder.name)

    def status(self, **kw):
        verdict = self.e.evaluate(**kw)
        self.assertEqual(verdict['transitions'][-1], {'step': 'final', 'status': verdict['status']})
        return verdict['status']

    def step(self, verdict, name):
        return next(t for t in verdict['transitions'] if t['step'] == name)

    def test_complete_evidence_passes_through_every_transition(self):
        verdict = self.e.evaluate()
        self.assertEqual(verdict['status'], 'PASS', verdict)
        self.assertEqual([(t['step'], t['status']) for t in verdict['transitions']],
                         [('native-scenario', 'PASS'), ('identity', 'PASS'), ('pending-launcher-cleanup', 'PASS'),
                          ('launcher-cleanup-verified', 'PASS'), ('final', 'PASS')])
        self.assertEqual({k: v['status'] for k, v in verdict['formats'].items()}, {'hwp': 'PASS', 'hwpx': 'PASS'})
        self.assertEqual(len(contract.CHECKS), 58)
        self.assertEqual(len(set(contract.CHECKS)), 58)

    # 1-5: launcher evidence
    def test_missing_cleanup_is_incomplete(self):
        self.assertEqual(self.status(skip=('cleanup.json',)), 'INCOMPLETE')

    def test_invalid_json_and_non_object_never_pass(self):
        self.e.cleanup = '{not json'
        self.assertEqual(self.status(), 'INCOMPLETE')
        self.e.cleanup = '[]'
        self.assertEqual(self.status(), 'INCOMPLETE')

    def test_missing_result_is_incomplete_even_with_valid_cleanup(self):
        verdict = self.e.evaluate(skip=('result.json',))
        self.assertEqual(verdict['status'], 'INCOMPLETE')
        self.assertEqual({v['status'] for v in verdict['formats'].values()}, {'MISSING'})

    def test_cleanup_survivors_fail(self):
        self.e.cleanup['survivors'] = [4242]
        self.assertEqual(self.status(), 'FAIL')

    def test_incomplete_launcher_cleanup_fails(self):
        for key, value in (('complete', False), ('proven', False), ('subreaper', False), ('filesystemProven', False), ('processErrors', [{'type': 'X'}])):
            with self.subTest(key):
                e = copy.deepcopy(self.e.cleanup)
                self.e.cleanup[key] = value
                self.assertEqual(self.status(), 'FAIL')
                self.e.cleanup = e
        self.e.cleanup['directories'][0].update(status='failed', remaining=True)
        self.assertEqual(self.status(), 'FAIL')

    def test_wrong_run_id_fails(self):
        for target in ('cleanup', 'session'):
            with self.subTest(target):
                getattr(self.e, target)['runId'] = 'other-run'
                self.assertEqual(self.status(), 'FAIL')
                getattr(self.e, target)['runId'] = RUN
        self.e.report['nativeLauncher'] = {}
        self.assertEqual(self.status(), 'FAIL')

    def test_unrelated_command_fails(self):
        self.e.cleanup['commandSha256'] = D
        self.assertEqual(self.status(), 'FAIL')

    def test_nonzero_exit_fails_despite_clean_teardown(self):
        self.e.cleanup['exit'] = 1
        self.assertEqual(self.status(), 'FAIL')
        self.e.cleanup['exit'] = 0
        self.assertEqual(self.status(launcher_exit=3), 'FAIL')
        self.assertEqual(self.status(launcher_exit=0), 'PASS')

    def test_launcher_exit_must_be_explicit_integer_zero(self):
        self.assertEqual(self.status(launcher_exit=0), 'PASS')
        self.assertEqual(self.status(launcher_exit=None), 'FAIL')
        for invalid in (False, True, 0.0, '0', -1, 1):
            with self.subTest(launcher_exit=invalid):
                self.assertEqual(self.status(launcher_exit=invalid), 'FAIL')

    def test_missing_launcher_exit_cannot_pass_through_evaluate_or_finalize(self):
        self.assertEqual(self.e.evaluate(launcher_exit=0)['status'], 'PASS')
        verdict = contract.evaluate(self.e.result, self.e.session_dir, self.e.expected)
        self.assertEqual(verdict['status'], 'FAIL')
        target = self.e.folder / 'final-verdict.json'
        verdict = contract.finalize(self.e.result, self.e.session_dir, target, self.e.expected)
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertEqual(json.loads(target.read_text())['status'], 'FAIL')

    def test_command_json_launcher_exit_must_match_explicit_exit(self):
        command = self.e.folder / 'command.json'
        command.write_text(json.dumps({'command': ['launcher'], 'launcherExit': 0}))
        self.assertEqual(self.status(launcher_exit=0), 'PASS')
        for record in ({}, {'launcherExit': 1}, {'launcherExit': False}, {'launcherExit': True},
                       {'launcherExit': 0.0}, {'launcherExit': '0'}, {'launcherExit': None}):
            with self.subTest(recorded=record):
                command.write_text(json.dumps({'command': ['launcher'], **record}))
                self.assertEqual(self.status(launcher_exit=0), 'FAIL')
        command.write_text('{broken')
        verdict = self.e.evaluate(launcher_exit=0)
        self.assertEqual(verdict['status'], 'INCOMPLETE')
        self.assertEqual(self.step(verdict, 'launcher-cleanup-verified')['status'], 'INCOMPLETE')

    def test_finalize_cli_requires_launcher_exit_before_finalization(self):
        argv = ['formatting_acceptance.py', 'finalize', '--result', str(self.e.result), '--session-dir', str(self.e.session_dir),
                '--verdict', str(self.e.folder / 'final-verdict.json'), '--app', str(self.e.folder / 'app')]
        with mock.patch.object(contract.sys, 'argv', argv), mock.patch.object(contract, 'trusted_inputs') as trusted_inputs, \
                mock.patch.object(contract, 'finalize') as finalize, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                contract.main()
        self.assertEqual(error.exception.code, 2)
        trusted_inputs.assert_not_called()
        finalize.assert_not_called()
        self.assertFalse((self.e.folder / 'final-verdict.json').exists())

    def test_run_mode_passes_actual_subprocess_return_code_to_finalize(self):
        expected = {'appSha256': D}
        for exit_code, final_status, expected_return in ((0, 'PASS', 0), (7, 'FAIL', 1)):
            with self.subTest(exit_code=exit_code):
                evidence = self.e.folder / f'run-{exit_code}'
                finalized = []

                def finalize(result, session, verdict, trusted, code):
                    finalized.append((result, session, verdict, trusted, code))
                    return {'status': final_status}

                argv = ['formatting_acceptance.py', 'run', '--evidence', str(evidence), '--driver', str(self.e.folder / 'driver'),
                        '--app', str(self.e.folder / 'app')]
                completed = mock.Mock(returncode=exit_code)
                with mock.patch.object(contract.sys, 'argv', argv), mock.patch.object(contract, 'trusted_inputs', return_value=expected), \
                        mock.patch.object(contract.subprocess, 'run', return_value=completed) as run, \
                        mock.patch.object(contract, 'finalize', side_effect=finalize), mock.patch.object(contract, 'sha', return_value=D), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(contract.main(), expected_return)
                run.assert_called_once()
                self.assertEqual(finalized[0][-1], exit_code)
                recorded = json.loads((evidence / 'command.json').read_text())
                self.assertEqual(recorded['launcherExit'], exit_code)

    def test_recorded_errors_fail(self):
        self.e.session['error'] = 'RuntimeError: IBus daemon did not start'
        self.assertEqual(self.status(), 'FAIL')
        del self.e.session['error']
        self.e.report['error'] = 'Failure: x'
        self.assertEqual(self.status(), 'FAIL')

    def test_webdriver_teardown_must_be_clean(self):
        self.e.report['teardown'][0]['survivorsAfterSigterm'] = [77]
        self.assertEqual(self.status(), 'FAIL')

    # 6: state transition
    def test_only_pending_child_is_eligible(self):
        for status in ('PASS', 'RUNNING', 'FAIL', 'INCONCLUSIVE', 'PASS_PENDING_LAUNCHER_CLEANUP', None):
            with self.subTest(status):
                self.e.report['status'] = status
                verdict = self.e.evaluate()
                self.assertEqual(verdict['status'], 'FAIL')
                self.assertEqual(self.step(verdict, 'pending-launcher-cleanup')['status'], 'FAIL')
        self.e.report['status'] = contract.PENDING
        self.e.report['acceptance'] = {'status': 'FAIL'}
        self.assertEqual(self.status(), 'FAIL')

    def test_valid_cleanup_does_not_prove_native_and_vice_versa(self):
        self.e.report['formats'][1]['status'] = 'FAIL'
        verdict = self.e.evaluate()
        self.assertEqual((self.step(verdict, 'native-scenario')['status'], self.step(verdict, 'launcher-cleanup-verified')['status'], verdict['status']),
                         ('FAIL', 'PASS', 'FAIL'))
        self.e.report['formats'][1]['status'] = 'PASS'
        self.e.cleanup['proven'] = False
        verdict = self.e.evaluate()
        self.assertEqual((self.step(verdict, 'native-scenario')['status'], self.step(verdict, 'launcher-cleanup-verified')['status'], verdict['status']),
                         ('PASS', 'FAIL', 'FAIL'))

    # 7-8: fixed two-format coverage
    def test_one_format_only_is_incomplete_and_keeps_the_other_verdict(self):
        self.e.report['formats'] = self.e.report['formats'][:1]
        verdict = self.e.evaluate()
        self.assertEqual(verdict['status'], 'INCOMPLETE')
        self.assertEqual({k: v['status'] for k, v in verdict['formats'].items()}, {'hwp': 'PASS', 'hwpx': 'MISSING'})
        # The child harness may accept its requested subset; the final contract may not.
        self.assertEqual(contract.native(self.e.report, ('hwp',))['status'], 'PASS')

    def test_failed_format_does_not_erase_the_passing_one(self):
        self.e.report['formats'][1]['checks'][3]['status'] = 'FAIL'
        verdict = self.e.evaluate()
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertEqual({k: v['status'] for k, v in verdict['formats'].items()}, {'hwp': 'PASS', 'hwpx': 'FAIL'})

    def test_duplicate_or_unknown_format_fails(self):
        self.e.report['formats'].append(copy.deepcopy(self.e.report['formats'][0]))
        self.assertEqual(self.status(), 'FAIL')
        self.e.report['formats'] = [row('hwp'), row('hwpx'), row('docx')]
        self.assertEqual(self.status(), 'FAIL')
        self.e.report['formats'] = [row('hwp'), {**row('hwpx'), 'format': 'HWPX'}]
        self.assertEqual(self.status(), 'FAIL')

    # 9-10: explicit mandatory checks
    def test_missing_mandatory_check_fails_even_when_all_emitted_checks_pass(self):
        del self.e.report['formats'][0]['checks'][10]
        self.assertTrue(all(c['status'] == 'PASS' for c in self.e.report['formats'][0]['checks']))
        self.assertEqual(self.status(), 'FAIL')

    def test_duplicate_name_cannot_mask_a_missing_check(self):
        checks = self.e.report['formats'][0]['checks']
        checks[10] = copy.deepcopy(checks[9])
        self.assertEqual(len(checks), len(contract.CHECKS))
        self.assertEqual(self.status(), 'FAIL')

    def test_extra_fabricated_check_fails(self):
        self.e.report['formats'][0]['checks'].append({'name': 'extra coverage', 'status': 'PASS'})
        self.assertEqual(self.status(), 'FAIL')

    def test_failed_mandatory_check_fails(self):
        self.e.report['formats'][0]['checks'][-1]['status'] = 'FAIL'
        self.assertEqual(self.status(), 'FAIL')

    def test_operations_are_fixed(self):
        del self.e.report['formats'][0]['operations'][3]
        self.assertEqual(self.status(), 'FAIL')
        self.e.report['formats'][0] = row('hwp')
        self.e.report['formats'][0]['operations'][0]['canvasAfter'] = D
        self.assertEqual(self.status(), 'FAIL')

    # 11: saves and reopen
    def test_save_evidence_missing_unverified_or_wrong_fails(self):
        mutations = (lambda r: r['saves'].pop(), lambda r: r['saves'][1].update(verified=False), lambda r: r['saves'][0]['result'].update(state='failed'),
                     lambda r: r['saves'][1]['model']['cells'][1][1].__setitem__(0, '-'), lambda r: r['saves'][1]['model']['body'][0].__setitem__(0, '안녕안녕'),
                     lambda r: r['saves'][0].update(sha256=E), lambda r: r['saves'].append(copy.deepcopy(r['saves'][1])))
        for index, mutate in enumerate(mutations):
            with self.subTest(index):
                self.e.report['formats'][1] = row('hwpx')
                mutate(self.e.report['formats'][1])
                self.assertEqual(self.status(), 'FAIL')

    def test_native_reopen_evidence_required(self):
        mutations = (lambda r: r.pop('reopen'), lambda r: r['reopen'].update(nativeChooser=False), lambda r: r['reopen'].update(dirty='true'),
                     lambda r: r['reopen'].update(savedSha256=D), lambda r: r['reopen']['pressed']['cell-bold'].update(bold=False))
        for index, mutate in enumerate(mutations):
            with self.subTest(index):
                self.e.report['formats'][0] = row('hwp')
                mutate(self.e.report['formats'][0])
                self.assertEqual(self.status(), 'FAIL')

    # 12-13: identity and staleness
    def test_wrong_application_or_release_identity_fails(self):
        mutations = (lambda r: r.update(appSha256=E), lambda r: r['runningApplication'][0].update(sha256=E),
                     lambda r: r['runningApplication'][0].update(testFlags=['VITE_GEUL_TEST_RHWP_FORMAT']),
                     lambda r: r['servedArtifactHashes'].update({'rhwp_bg.wasm': 'f' * 64}), lambda r: r['oracleIdentity'].update(generation='f' * 64),
                     lambda r: r['frontendBuild'].update(testFlags={'VITE_GEUL_TEST_HOOKS': '1'}), lambda r: r.update(location='http://localhost:1420/'),
                     lambda r: r['expectedIdentity'].update(appSha256=E), lambda r: r.update(testHooksAbsent=False))
        original = copy.deepcopy(self.e.report)
        for index, mutate in enumerate(mutations):
            with self.subTest(index):
                self.e.report = copy.deepcopy(original)
                mutate(self.e.report)
                verdict = self.e.evaluate()
                self.assertEqual((verdict['status'], self.step(verdict, 'identity')['status']), ('FAIL', 'FAIL'))

    def test_report_cannot_supply_its_own_expected_identity(self):
        self.e.report['appSha256'] = E
        self.e.report['runningApplication'][0]['sha256'] = E
        self.e.report['expectedIdentity']['appSha256'] = E
        self.assertEqual(self.status(), 'FAIL')

    def test_stale_evidence_fails(self):
        original = copy.deepcopy(self.e.report)
        for mutate in (lambda r: r['productTrees'].update(src='d' * 40), lambda r: r['productTrees'].pop('external/rhwp'), lambda r: r.update(sourceDiffSha256=D),
                       lambda r: r['harnessSha256'].update({'native-formatting-acceptance.py': E}), lambda r: r['contract']['checks'].pop()):
            self.e.report = copy.deepcopy(original)
            mutate(self.e.report)
            self.assertEqual(self.status(), 'FAIL')
        self.e.report = original
        self.assertEqual(self.status(), 'PASS')
        self.e.report['head'] = 'd' * 40  # a later harness/documentation commit alone is not staleness
        self.assertEqual(self.status(), 'PASS')
        self.e.expected['sourceDiffSha256'] = D  # product sources modified after the run
        self.assertEqual(self.status(), 'FAIL')

    def test_contradictory_result_and_cleanup_fail(self):
        self.assertEqual(self.status(), 'PASS')
        later = (self.e.session_dir / 'cleanup.json').stat().st_mtime_ns + 5_000_000_000
        os.utime(self.e.result, ns=(later, later))
        verdict = contract.evaluate(self.e.result, self.e.session_dir, self.e.expected, 0)
        self.assertEqual(verdict['status'], 'FAIL')
        for record in self.e.report['teardown'] + self.e.report['sessions']:
            record['dataHome'] = '/elsewhere/data'
        self.assertEqual(self.status(), 'FAIL')

    # 14: input events
    def test_old_snapshot_would_have_missed_a_late_untrusted_event(self):
        log, snapshot = event_log()
        log[-2]['trusted'] = False  # keyboard input on the reopened document, after the IME check
        contract.trusted(log[:snapshot])  # the pre-fix assertion looked only at this prefix and passed
        with self.assertRaises(ValueError):
            contract.trusted(log)
        self.e.report['formats'][0]['events'] = log
        verdict = self.e.evaluate()
        self.assertEqual((verdict['status'], verdict['formats']['hwp']['status']), ('FAIL', 'FAIL'))

    def test_early_snapshot_is_not_a_complete_log(self):
        log, snapshot = event_log()
        with self.assertRaises(ValueError):
            contract.events(log[:snapshot], snapshot)
        self.e.report['formats'][0].update(events=log[:snapshot], eventCount=snapshot)
        self.assertEqual(self.status(), 'FAIL')

    def test_incomplete_event_logs_fail(self):
        full, _ = event_log()
        cases = {'missing': (None, None), 'empty': ([], 0), 'dropped tail': (full[:-1], len(full)), 'dropped middle': (full[:4] + full[5:], len(full) - 1),
                 'counter ahead': (full, len(full) + 1), 'trusted missing': ([{k: v for k, v in e.items() if k != 'trusted'} for e in full], len(full)),
                 'truthy but not true': ([{**e, 'trusted': 1} if e['seq'] == 5 else e for e in full], len(full)),
                 'no composition': ([{**e, 'type': 'keydown'} if e['type'].startswith('composition') else e for e in full], len(full)),
                 'no final close': ([{**e, 'target': 'button'} if e['seq'] == len(full) - 1 else e for e in full], len(full))}
        for name, (log, count) in cases.items():
            with self.subTest(name):
                self.e.report['formats'][1] = {**row('hwpx'), 'events': log, 'eventCount': count}
                self.assertEqual(self.status(), 'FAIL')

    # finalizer I/O
    def test_finalize_writes_the_verdict_and_never_defaults_to_pass(self):
        self.e.evaluate()
        target = self.e.folder / 'final-verdict.json'
        self.assertEqual(contract.finalize(self.e.result, self.e.session_dir, target, self.e.expected, 0)['status'], 'PASS')
        self.assertEqual(json.loads(target.read_text())['status'], 'PASS')
        self.assertEqual(contract.finalize(self.e.result, self.e.session_dir, target, {}, 0)['status'], 'FAIL')
        self.assertEqual(json.loads(target.read_text())['status'], 'FAIL')
        self.assertEqual(contract.finalize(self.e.folder / 'absent.json', self.e.folder / 'absent', target, self.e.expected, 0)['status'], 'INCOMPLETE')


if __name__ == '__main__':
    unittest.main()
