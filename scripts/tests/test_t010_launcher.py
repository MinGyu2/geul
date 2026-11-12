"""Regression tests for owned T010 launcher filesystem cleanup and finalization."""
import copy
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import t010_acceptance as gate
import t010_launcher as launcher
import test_t010_acceptance as acceptance_fixtures


RUN = acceptance_fixtures.RUN
COMMAND = '9' * 64


def actual_resources(parent):
    return [launcher.create_directory(name, RUN, parent=parent)
            for name in launcher.RESOURCE_NAMES]


def lifecycle_fixture(path):
    report, expected = acceptance_fixtures.production_evidence()
    report.update(expectedIdentity=expected, status='PENDING_CLEANUP')
    report_path = Path(path)
    report['nativeLauncher'] = {'runId': RUN, 'commandSha256': COMMAND,
                                'acceptanceReport': str(report_path)}
    session = {'runId': RUN, 'commandSha256': COMMAND,
               'acceptanceReport': str(report_path),
               'temporaryResources': acceptance_fixtures.directory_cleanup_evidence()[0]}
    directories = acceptance_fixtures.directory_cleanup_evidence()[1]
    cleanup = {'runId': RUN, 'commandSha256': COMMAND, 'complete': True,
               'proven': True, 'subreaper': True, 'survivors': [], 'exit': 0,
               'ownedAtTeardown': 3, 'leakedAfterManagedStop': {},
               'processErrors': [], 'directories': directories,
               'filesystemProven': True}
    return report, session, cleanup


class OwnedDirectoryCleanup(unittest.TestCase):
    def test_removes_both_owned_roots_and_records_identity(self):
        with tempfile.TemporaryDirectory() as parent:
            resources = actual_resources(parent)
            self.assertTrue(all(Path(r['path']).is_dir() for r in resources))
            results = launcher.cleanup_directories(resources, RUN)
            self.assertEqual([r['status'] for r in results], ['removed', 'removed'])
            self.assertTrue(all(r['attempted'] and r['deleteAttempted'] and r['ownershipVerified']
                                and r['remaining'] is False and r['error'] is None for r in results))
            self.assertTrue(all(not Path(r['path']).exists() for r in resources))
            gate.directory_cleanup({'runId': RUN, 'temporaryResources': resources}, {'directories': results})

    def test_accepts_owned_resource_already_absent_without_claiming_deletion(self):
        with tempfile.TemporaryDirectory() as parent:
            resources = actual_resources(parent)
            shutil.rmtree(resources[0]['path'])
            results = launcher.cleanup_directories(resources, RUN)
            self.assertEqual(results[0]['status'], 'already-absent')
            self.assertTrue(results[0]['attempted'] and results[0]['ownershipVerified'])
            self.assertFalse(results[0]['deleteAttempted'])
            self.assertFalse(results[0]['remaining'])
            gate.directory_cleanup({'runId': RUN, 'temporaryResources': resources}, {'directories': results})

    def test_attempts_both_roots_when_work_removal_fails(self):
        with tempfile.TemporaryDirectory() as parent:
            resources = actual_resources(parent)
            original = shutil.rmtree
            attempted = []

            def injected(path, *args, **kwargs):
                attempted.append(str(path))
                if str(path) == resources[0]['path']:
                    raise PermissionError('injected work removal failure')
                return original(path, *args, **kwargs)

            with patch.object(launcher.shutil, 'rmtree', side_effect=injected):
                results = launcher.cleanup_directories(resources, RUN)
            self.assertEqual(attempted, [r['path'] for r in resources])
            self.assertEqual([r['status'] for r in results], ['failed', 'removed'])
            self.assertTrue(results[0]['remaining'])
            self.assertFalse(results[1]['remaining'])
            self.assertEqual(results[0]['error']['type'], 'PermissionError')

    def test_attempts_both_roots_when_socket_removal_fails(self):
        with tempfile.TemporaryDirectory() as parent:
            resources = actual_resources(parent)
            original = shutil.rmtree
            attempted = []

            def injected(path, *args, **kwargs):
                attempted.append(str(path))
                if str(path) == resources[1]['path']:
                    raise PermissionError('injected socket removal failure')
                return original(path, *args, **kwargs)

            with patch.object(launcher.shutil, 'rmtree', side_effect=injected):
                results = launcher.cleanup_directories(resources, RUN)
            self.assertEqual(attempted, [r['path'] for r in resources])
            self.assertEqual([r['status'] for r in results], ['removed', 'failed'])
            self.assertFalse(results[0]['remaining'])
            self.assertTrue(results[1]['remaining'])
            self.assertEqual(results[1]['error']['type'], 'PermissionError')

    def test_attempts_socket_after_work_failure_and_records_both_failures(self):
        with tempfile.TemporaryDirectory() as parent:
            resources = actual_resources(parent)
            attempted = []

            def injected(path, *args, **kwargs):
                attempted.append(str(path))
                raise PermissionError('injected removal failure')

            with patch.object(launcher.shutil, 'rmtree', side_effect=injected):
                results = launcher.cleanup_directories(resources, RUN)
            self.assertEqual(attempted, [r['path'] for r in resources])
            self.assertEqual([r['status'] for r in results], ['failed', 'failed'])
            self.assertTrue(all(r['remaining'] and r['error'] for r in results))

    def test_wrong_run_and_replaced_or_symlink_roots_are_never_deleted(self):
        with tempfile.TemporaryDirectory() as parent:
            resources = actual_resources(parent)
            wrong_run = launcher.cleanup_directories(resources, 'other-run')
            self.assertEqual([r['status'] for r in wrong_run], ['not-performed', 'not-performed'])
            self.assertTrue(all(Path(r['path']).is_dir() for r in resources))

        with tempfile.TemporaryDirectory() as parent:
            resource = launcher.create_directory('work', RUN, parent=parent)
            root = Path(resource['path'])
            shutil.rmtree(root)
            unrelated = Path(parent) / 'unrelated-target'
            unrelated.mkdir()
            marker = unrelated / 'keep.txt'
            marker.write_text('preserve')
            root.symlink_to(unrelated, target_is_directory=True)
            result = launcher.cleanup_directories([resource], RUN)[0]
            self.assertEqual(result['status'], 'not-performed')
            self.assertTrue(root.is_symlink())
            self.assertEqual(marker.read_text(), 'preserve')

        with tempfile.TemporaryDirectory() as parent:
            resource = launcher.create_directory('socket', RUN, parent=parent)
            root = Path(resource['path'])
            shutil.rmtree(root)
            root.mkdir()
            marker = root / 'replacement.txt'
            marker.write_text('preserve replacement')
            result = launcher.cleanup_directories([resource], RUN)[0]
            self.assertEqual(result['status'], 'not-performed')
            self.assertEqual(marker.read_text(), 'preserve replacement')

    def test_acceptance_gate_rejects_missing_wrong_run_unattempted_or_remaining_results(self):
        resources, results = acceptance_fixtures.directory_cleanup_evidence()
        session = {'runId': RUN, 'temporaryResources': resources}
        gate.directory_cleanup(session, {'directories': results})
        mutations = []
        mutations.append({'directories': results[:1]})
        bad = copy.deepcopy(results); bad[0]['runId'] = 'other-run'; mutations.append({'directories': bad})
        bad = copy.deepcopy(results); bad[0]['attempted'] = False; mutations.append({'directories': bad})
        bad = copy.deepcopy(results); bad[0]['remaining'] = True; mutations.append({'directories': bad})
        bad = copy.deepcopy(results); bad[0]['status'] = 'failed'; bad[0]['error'] = {'type': 'OSError'}; mutations.append({'directories': bad})
        bad = copy.deepcopy(results); bad[0]['path'] = '/tmp/other'; mutations.append({'directories': bad})
        for cleanup in mutations:
            with self.subTest(cleanup=cleanup):
                self.assertEqual(gate.verdict(gate.directory_cleanup, session, cleanup)['status'], 'FAIL')


class FinalAcceptanceLifecycle(unittest.TestCase):
    def write_pending(self, path, status='PENDING_CLEANUP'):
        report, identity, cleanup = lifecycle_fixture(path)
        report['status'] = status
        launcher.atomic_json(path, report)
        return report, identity, cleanup

    def test_final_pass_and_zero_exit_require_inner_process_and_filesystem_success(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            self.write_pending(path)
            _, identity, cleanup = lifecycle_fixture(path)
            self.assertEqual(launcher.finalize_report(path, identity, cleanup, 0), 0)
            final = json.loads(path.read_text())
            self.assertEqual(final['status'], 'PASS')
            self.assertEqual(final['launcherExit'], 0)
            self.assertEqual(final['acceptance']['status'], 'PASS')
            self.assertEqual(final['launcherAcceptance']['status'], 'PASS')

    def test_process_success_with_filesystem_failure_is_nonpass_and_nonzero(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            self.write_pending(path)
            _, identity, cleanup = lifecycle_fixture(path)
            cleanup['directories'][0].update(status='failed', remaining=True,
                                             error={'type': 'PermissionError', 'message': 'injected'})
            cleanup['filesystemProven'] = False
            code = launcher.finalize_report(path, identity, cleanup, 0)
            final = json.loads(path.read_text())
            self.assertNotEqual(code, 0)
            self.assertEqual(final['status'], 'FAIL')
            self.assertEqual(final['launcherExit'], code)
            self.assertEqual(final['launcherAcceptance']['status'], 'FAIL')

    def test_filesystem_success_with_process_failure_is_nonpass_and_nonzero(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            self.write_pending(path)
            _, identity, cleanup = lifecycle_fixture(path)
            cleanup['proven'] = False
            cleanup['survivors'] = [456]
            code = launcher.finalize_report(path, identity, cleanup, 0)
            final = json.loads(path.read_text())
            self.assertNotEqual(code, 0)
            self.assertEqual(final['status'], 'FAIL')
            self.assertEqual(final['launcherExit'], code)
            self.assertEqual(final['launcherAcceptance']['status'], 'FAIL')

    def test_prior_native_failure_remains_failure_after_successful_cleanup(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            report, identity, cleanup = self.write_pending(path, status='FAIL')
            report['formats'][0]['checks'][0]['status'] = 'FAIL'
            launcher.atomic_json(path, report)
            code = launcher.finalize_report(path, identity, cleanup, 0)
            final = json.loads(path.read_text())
            self.assertNotEqual(code, 0)
            self.assertEqual(final['status'], 'FAIL')
            self.assertEqual(final['acceptance']['status'], 'FAIL')
            self.assertEqual(final['launcherExit'], code)

    def test_failed_final_writer_leaves_no_pass_and_records_failure(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            self.write_pending(path)
            _, identity, cleanup = lifecycle_fixture(path)

            def fail_writer(_path, _value):
                raise OSError('injected report replacement failure')

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = launcher.finalize_report(path, identity, cleanup, 0, writer=fail_writer)
            self.assertNotEqual(code, 0)
            self.assertNotEqual(json.loads(path.read_text()).get('status'), 'PASS')
            sidecar = json.loads(path.with_name(path.name + '.finalization.json').read_text())
            self.assertEqual(sidecar['status'], 'FAIL')
            self.assertIn('report replacement failure', sidecar['error'])
            self.assertIn('ACCEPTANCE FINALIZATION FAILED', stderr.getvalue())

    def test_actual_atomic_replacement_failure_retains_pending_and_cleans_own_pending_file(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            self.write_pending(path)
            _, identity, cleanup = lifecycle_fixture(path)
            replace = os.replace
            def deny_final(src, dst):
                if Path(dst) == path:
                    raise PermissionError('injected atomic replace failure')
                return replace(src, dst)
            with patch.object(launcher.os, 'replace', side_effect=deny_final), contextlib.redirect_stderr(io.StringIO()):
                code = launcher.finalize_report(path, identity, cleanup, 0)
            self.assertNotEqual(code, 0)
            self.assertEqual(json.loads(path.read_text())['status'], 'PENDING_CLEANUP')
            self.assertFalse(list(Path(parent).glob('*.pending')))
            self.assertTrue(path.with_name(path.name + '.finalization.json').exists())

    def test_prior_failed_status_or_command_cannot_be_reclassified_by_successful_predicates(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            for status, native_exit in [('FAIL', 0), ('PENDING_CLEANUP', 1)]:
                _, identity, cleanup = self.write_pending(path, status=status)
                code = launcher.finalize_report(path, identity, cleanup, native_exit)
                result = json.loads(path.read_text())
                self.assertNotEqual(code, 0)
                self.assertEqual(result['status'], 'FAIL')
                self.assertEqual(result['nativeExecutionStatus'], status)
                self.assertEqual(result['nativeCommandExit'], native_exit)

    def test_prepare_invalidates_stale_pass_and_does_not_create_missing_child_output(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            path.write_text(json.dumps({'status': 'PASS', 'runId': 'old'}))
            launcher.prepare_report(path, RUN)
            pending = json.loads(path.read_text())
            self.assertEqual(pending, {'status': 'PENDING_CLEANUP', 'runId': RUN,
                                       'phase': 'launcher-starting'})
            absent = Path(parent) / 'not-created' / 'child.json'
            launcher.prepare_report(absent, RUN)
            self.assertFalse(absent.parent.exists())

    def test_child_pass_before_outer_cleanup_is_rejected_and_downgraded(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent) / 'final.json'
            self.write_pending(path, status='PASS')
            _, identity, cleanup = lifecycle_fixture(path)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = launcher.finalize_report(path, identity, cleanup, 0)
            final = json.loads(path.read_text())
            self.assertNotEqual(code, 0)
            self.assertEqual(final['status'], 'FAIL')
            self.assertEqual(final['phase'], 'finalization-failed')
            self.assertEqual(final['launcherExit'], code)
            self.assertIn('child claimed PASS', final['error'])


if __name__ == '__main__':
    unittest.main()
