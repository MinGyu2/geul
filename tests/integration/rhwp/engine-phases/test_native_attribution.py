"""Segment arithmetic of the native attribution on synthetic samples (no producer run)."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
_spec = importlib.util.spec_from_file_location('engine_phase_native_attribution', Path(__file__).with_name('native_attribution.py'))
attribution = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(attribution)


def sample(end=60):
    return {'kind': 'groupStart', 'keyToFrame': end,
            'at': {'key': 0, 'input': 2, 'handlerEnd': 20, 'observed': 22, 'raf1': end-4, 'end': end},
            'engineTimeline': [{'name': 'insertText', 'at': 3, 'ms': 2}, {'name': 'beginRenderJob', 'at': 9, 'ms': 0},
                               {'name': 'canvasReadback', 'at': 12, 'ms': 1}, {'name': 'pollRenderJob', 'at': 9, 'ms': 5},
                               {'name': 'adapterRenderRequest', 'at': 9, 'ms': 5}, {'name': 'getCursorRect', 'at': 30, 'ms': 1}],
            'timeline': [{'name': 'dom:keyup', 'at': end-8}, {'name': 'rhwp:commit-ack', 'at': end-9}]}


class AttributionTests(unittest.TestCase):
    def test_segments_partition_and_nested_calls_are_not_double_counted(self):
        row = attribution.sample_segments(sample())
        self.assertEqual(row['segments'], {'delivery': 2, 'handler': 18, 'toObserved': 2, 'observedToRaf1': 34, 'raf1ToEnd': 4})
        self.assertEqual((row['engineJsInHandlerMs'], row['engineJsObservedToRaf1Ms'], row['engineJsBeforeEndMs']), (7, 1, 8))
        self.assertEqual((row['renderJobs'], row['maxPollMs'], row['raf1AfterKeyupMs'], row['raf1AfterCommitAckMs']), (1, 5, 4, 5))

    def test_incomplete_or_inconsistent_samples_fail_closed(self):
        for mutate in [lambda s: s['at'].pop('raf1'), lambda s: s['at'].update(raf1=10), lambda s: s.update(keyToFrame=90),
                       lambda s: s['at'].update(handlerEnd=None)]:
            value = sample(); mutate(value)
            with self.assertRaises(ValueError): attribution.sample_segments(value)

    def test_summary_requires_every_group_start_sample(self):
        perf = {'sample': 'x', 'groupStart': {'n': 3}, 'zeroWorkFrameFloorMs': {}, 'frameGapDuringHistoryAndFollowingInputMs': {},
                'timelineSamples': [sample(), sample(40), copy.deepcopy(sample()) | {'kind': 'undo'}]}
        with self.assertRaises(ValueError): attribution.summarize(perf)
        perf['groupStart']['n'] = 2
        summary = attribution.summarize(perf)
        self.assertEqual((summary['failingOverLimit'], summary['dominantSegmentInFailingSamples']), (1, {'observedToRaf1': 1}))
        self.assertEqual(summary['samplesStillOverLimitWithZeroEngineJs'], 1)


if __name__ == '__main__': unittest.main()
