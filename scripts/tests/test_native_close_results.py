"""Controlled fixtures for native harness execution versus behavior coverage."""
import copy
import json
from pathlib import Path
import sys
import unittest

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR))
import native_close_results as results

BASE_OBSERVATION = {
    'observerInstalled': True, 'requestSent': True, 'before': 2, 'during': 2,
    'dialogDuring': False, 'afterCancel': 2, 'dialogAfterCancel': False,
    'restoreResult': None, 'published': False, 'appAlive': True,
    'verdict': 'NOT REACHABLE',
    'positiveControl': {'before': 2, 'after': 3},
}
SCOPE = {
    'displayServer': 'X11', 'gdkBackend': 'x11', 'gtkChooser': 'gtk::FileChooserNative modal run()',
    'observationIntervalSeconds': 5.0, 'intervals': ['chooser open', 'after chooser cancellation'],
    'scope': 'fixture environment only',
}


def no_delivery(**updates):
    return {'status': 'PASS', 'mode': 'restore-chooser', 'negative': [{'status': 'NOT REACHABLE'}],
            'environment': copy.deepcopy(SCOPE), 'chooserCloseDelivery': {**BASE_OBSERVATION, **updates}}


def during_delivery(**updates):
    observation = {**BASE_OBSERVATION, 'during': 3, 'dialogDuring': True, 'busyDuring': True,
                   'verdict': 'DELIVERED DURING CHOOSER', **updates}
    for key in ('afterCancel', 'dialogAfterCancel', 'restoreResult', 'positiveControl'):
        observation.pop(key, None)
    return {'status': 'PASS', 'mode': 'restore-chooser', 'negative': [],
            'environment': copy.deepcopy(SCOPE), 'chooserCloseDelivery': observation}


class NativeCloseResults(unittest.TestCase):
    def test_valid_non_delivery_keeps_execution_pass_separate_from_coverage(self):
        report = no_delivery()
        result = results.finalize(report)
        self.assertIsNone(result)
        self.assertEqual(report['status'], 'PASS')  # legacy harness field remains compatible
        self.assertEqual(report['negative'][0]['status'], 'NOT REACHABLE')
        self.assertEqual(report['executionStatus'], 'PASS')
        self.assertEqual(report['behaviorVerdict'], 'NOT REACHABLE')
        self.assertEqual(report['observationValidity'], 'PASS')
        self.assertEqual(report['observerControl'], 'PASS')
        self.assertEqual(report['coverageCounts']['PASS'], 0)
        self.assertEqual(report['environment'], SCOPE)

    def test_verified_during_transition_is_the_only_chooser_behavior_pass(self):
        report = during_delivery(transitionAttempted=True, transitionVerified=True)
        self.assertEqual(results.coverage(report)[:3], ('PASS', 'PASS', 'NOT RUN'))
        results.finalize(report)
        self.assertEqual((report['executionStatus'], report['behaviorVerdict']), ('PASS', 'PASS'))
        self.assertEqual(report['chooserCloseDelivery']['verdict'], 'DELIVERED DURING CHOOSER')
        self.assertEqual(report['environment']['observationIntervalSeconds'], 5.0)

    def test_delivery_without_transition_assertions_is_not_behavior_pass(self):
        report = during_delivery(transitionAttempted=True)
        results.finalize(report)
        self.assertEqual(report['behaviorVerdict'], 'INCONCLUSIVE')
        self.assertEqual(report['executionStatus'], 'FAIL')
        self.assertEqual(report['status'], 'FAIL')

    def test_late_delivery_is_never_not_reachable_or_behavior_pass(self):
        report = no_delivery(afterCancel=3, verdict='DELIVERED AFTER CHOOSER')
        self.assertEqual(results.coverage(report)[0], 'INCONCLUSIVE')
        results.finalize(report)
        self.assertNotIn(report['behaviorVerdict'], ('PASS', 'NOT REACHABLE'))

    def test_missing_invalid_or_contradictory_observations_cannot_be_promoted(self):
        for key in ('observerInstalled', 'requestSent', 'before', 'during', 'dialogDuring',
                    'afterCancel', 'dialogAfterCancel', 'restoreResult', 'published', 'appAlive'):
            with self.subTest(missing=key):
                report = no_delivery()
                del report['chooserCloseDelivery'][key]
                results.finalize(report)
                self.assertEqual(report['behaviorVerdict'], 'INCONCLUSIVE')
                self.assertEqual(report['executionStatus'], 'FAIL')
        for key, value in [('dialogDuring', 'false'), ('published', 0), ('appAlive', 1), ('requestSent', None)]:
            with self.subTest(key=key, value=value):
                report = no_delivery(**{key: value})
                results.finalize(report)
                self.assertEqual(report['behaviorVerdict'], 'INCONCLUSIVE')
        report = no_delivery(verdict='DELIVERED DURING CHOOSER')
        results.finalize(report)
        self.assertEqual(report['behaviorVerdict'], 'INCONCLUSIVE')

    def test_missing_or_bad_positive_control_blocks_non_delivery_result(self):
        for control, expected in [(None, 'NOT RUN'), ({'before': 2, 'after': 2}, 'FAIL'),
                                  ({'before': 2, 'after': '3'}, 'FAIL'), ({'before': True, 'after': 2}, 'FAIL'),
                                  ({'before': 0, 'after': 1}, 'FAIL')]:
            with self.subTest(control=control):
                report = no_delivery(positiveControl=control)
                results.finalize(report)
                self.assertEqual(report['observerControl'], expected)
                self.assertEqual(report['behaviorVerdict'], 'INCONCLUSIVE')
                self.assertEqual(report['executionStatus'], 'FAIL')

    def test_assertion_failure_and_infrastructure_failure_are_distinct(self):
        assertion = during_delivery(transitionAttempted=True)
        assertion.update(status='FAIL', failureKind='assertion', failurePhase='native scenario')
        self.assertEqual(results.coverage(assertion)[0], 'FAIL')
        infrastructure = no_delivery()
        infrastructure.update(status='FAIL', failureKind='infrastructure', failurePhase='setup')
        self.assertEqual(results.coverage(infrastructure)[0], 'INCONCLUSIVE')

    def test_summary_separates_legacy_nonreachability_and_each_coverage_state(self):
        verified = during_delivery(transitionAttempted=True, transitionVerified=True)
        legacy_not_run = {'status': 'NOT RUN'}
        incomplete = during_delivery()
        failed = {'status': 'FAIL', 'failureKind': 'assertion'}
        results.finalize(incomplete)
        reports = [no_delivery(), verified, legacy_not_run, incomplete, failed]
        original = copy.deepcopy(reports)
        summary = results.summarize(reports)
        self.assertEqual(summary['coverageCounts'], {
            'PASS': 1, 'NOT REACHABLE': 1, 'NOT RUN': 1, 'INCONCLUSIVE': 1, 'FAIL': 1,
        })
        self.assertEqual(summary['executionCounts'], {'PASS': 2, 'FAIL': 2, 'NOT RUN': 1})
        self.assertEqual(reports, original)  # historical/fixture records are read only

    def test_old_report_json_remains_parseable_without_rewriting(self):
        report = no_delivery()
        legacy = {key: report[key] for key in ('status', 'negative', 'mode', 'chooserCloseDelivery')}
        parsed = json.loads(json.dumps(legacy))
        before = copy.deepcopy(parsed)
        self.assertEqual(results.summarize([parsed])['coverageCounts']['NOT REACHABLE'], 1)
        self.assertEqual(parsed, before)


if __name__ == '__main__':
    unittest.main()
