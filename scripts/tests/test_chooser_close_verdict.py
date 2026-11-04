"""Controlled observations for the native GTK chooser close verdict (no app, no X server).

Run: python3 -m unittest scripts/tests/test_chooser_close_verdict.py
"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('verdict', Path(__file__).with_name('chooser_close_verdict.py'))
verdict = importlib.util.module_from_spec(spec); spec.loader.exec_module(verdict)

BASE = {'observerInstalled': True, 'requestSent': True, 'before': 2, 'during': 2, 'dialogDuring': False,
        'afterCancel': 2, 'dialogAfterCancel': False, 'restoreResult': None, 'published': False, 'appAlive': True}


def classify(**changes):
    return verdict.classify({**BASE, **changes})


class ChooserCloseVerdict(unittest.TestCase):
    def test_no_delivery_during_or_after_is_not_reachable_with_baseline_and_delta(self):
        result, reason = classify()
        self.assertEqual(result, verdict.NOT_REACHABLE)
        self.assertIn('delta 0', reason)
        self.assertIn('baseline 2', reason)  # an unchanged nonzero counter is not "zero events total"

    def test_event_while_the_chooser_is_open_is_not_unreachable(self):
        self.assertEqual(classify(during=3, afterCancel=3)[0], verdict.DELIVERED_DURING)
        self.assertEqual(classify(dialogDuring=True)[0], verdict.DELIVERED_DURING)

    def test_delayed_event_after_cancellation_is_not_unreachable(self):
        self.assertEqual(classify(afterCancel=3)[0], verdict.DELIVERED_LATE)
        self.assertEqual(classify(dialogAfterCancel=True)[0], verdict.DELIVERED_LATE)

    def test_missing_or_unreliable_observations_are_inconclusive(self):
        for changes in [{'observerInstalled': False}, {'requestSent': False}, {'before': None}, {'during': 'x'},
                        {'afterCancel': None}, {'during': 1}, {'afterCancel': 1}, {'before': True}, {'during': -1}]:
            with self.subTest(changes=changes):
                self.assertEqual(classify(**changes)[0], verdict.INCONCLUSIVE)

    def test_state_contradictions_are_inconclusive(self):
        for changes in [{'restoreResult': 'pending'}, {'restoreResult': {'ok': True}}, {'published': True}, {'appAlive': False}]:
            with self.subTest(changes=changes):
                self.assertEqual(classify(**changes)[0], verdict.INCONCLUSIVE)

    def test_missing_required_negative_observations_are_inconclusive(self):
        for key in BASE:
            with self.subTest(missing=key):
                obs = dict(BASE)
                del obs[key]
                self.assertEqual(verdict.classify(obs)[0], verdict.INCONCLUSIVE)

    def test_boolean_fields_reject_truthy_and_falsy_non_booleans(self):
        for key in ('observerInstalled', 'requestSent', 'dialogDuring', 'dialogAfterCancel', 'published', 'appAlive'):
            for value in (None, 0, 1, 'false', 'true', [], {}):
                with self.subTest(key=key, value=value):
                    self.assertEqual(classify(**{key: value})[0], verdict.INCONCLUSIVE)

    def test_during_delivery_does_not_require_future_observations(self):
        for count, dialog in [(3, False), (2, True)]:
            with self.subTest(count=count, dialog=dialog):
                obs = {key: BASE[key] for key in ('observerInstalled', 'requestSent', 'before')}
                obs.update(during=count, dialogDuring=dialog)
                self.assertEqual(verdict.classify(obs)[0], verdict.DELIVERED_DURING)

    def test_late_delivery_does_not_require_restore_completion(self):
        obs = dict(BASE, afterCancel=3)
        del obs['restoreResult']
        self.assertEqual(verdict.classify(obs)[0], verdict.DELIVERED_LATE)

    def test_all_count_fields_reject_invalid_types_and_negative_values(self):
        for key in ('before', 'during', 'afterCancel'):
            for value in (None, True, False, -1, 0.0, '0', [], {}):
                with self.subTest(key=key, value=value):
                    self.assertEqual(classify(**{key: value})[0], verdict.INCONCLUSIVE)

    def test_supplied_post_delivery_counts_cannot_contradict_the_observer(self):
        self.assertEqual(classify(during=3, afterCancel=2)[0], verdict.INCONCLUSIVE)
        self.assertEqual(classify(during=3, afterCancel='unknown')[0], verdict.INCONCLUSIVE)

    def test_explicit_zero_baseline_is_not_reachable(self):
        self.assertEqual(classify(before=0, during=0, afterCancel=0)[0], verdict.NOT_REACHABLE)


if __name__ == '__main__':
    unittest.main()
