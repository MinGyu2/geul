"""Interval arithmetic and fail-closed validation of the native attribution on synthetic samples (no producer run)."""
import copy
import importlib.util
import itertools
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location('engine_phase_native_attribution', Path(__file__).with_name('native_attribution.py'),
                                               submodule_search_locations=None)
# native_attribution imports hash_catalog by name; resolve it from this directory without touching sys.path.
_catalog_spec = importlib.util.spec_from_file_location('hash_catalog', Path(__file__).with_name('hash_catalog.py'))
_catalog = importlib.util.module_from_spec(_catalog_spec); _catalog_spec.loader.exec_module(_catalog)
_saved = sys.modules.get('hash_catalog'); sys.modules['hash_catalog'] = _catalog
try:
    attribution = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(attribution)
finally:
    if _saved is None: sys.modules.pop('hash_catalog')
    else: sys.modules['hash_catalog'] = _saved

AT = {'key': 0, 'input': 2, 'handlerEnd': 20, 'observed': 22, 'raf1': 56, 'end': 60}


def sample(calls=(), at=None, timeline=None):
    at = dict(at or AT)
    return {'kind': 'groupStart', 'keyToFrame': at['end'], 'at': at,
            'engineTimeline': [{'name': n, 'at': s, 'ms': ms} for n, s, ms in calls],
            'timeline': timeline if timeline is not None else [{'name': 'dom:keyup', 'at': 52, 'ms': None, 'page': None},
                                                               {'name': 'rhwp:commit-ack', 'at': 51, 'ms': 49, 'page': None}]}


def occ(calls, **kw):
    return attribution.sample_segments(sample(calls, **kw))


class IntervalTests(unittest.TestCase):
    def test_baseline_crossing_example_is_clipped(self):
        row = occ([('insertText', 18, 12)])  # [18, 30): 2 ms in handler [2,20), 2 in toObserved, 8 in observedToRaf1
        self.assertEqual(row['syncOccupiedMs'], {'delivery': 0, 'handler': 2, 'toObserved': 2, 'observedToRaf1': 8, 'raf1ToEnd': 0})
        self.assertEqual(row['callsCrossingSegmentBoundary'], 1)

    def test_window_positions(self):
        cases = {'inside': ([('a', 5, 3)], 3), 'starts before': ([('a', 0, 5)], 3), 'ends after': ([('a', 15, 10)], 5),
                 'covers': ([('a', 1, 30)], 18), 'touches start': ([('a', -3, 5)], 0), 'touches end': ([('a', 20, 4)], 0),
                 'zero duration': ([('a', 10, 0)], 0), 'outside window': ([('a', -9, 4), ('b', 70, 5)], 0)}
        for name, (calls, handler) in cases.items():
            with self.subTest(name): self.assertEqual(occ(calls)['syncOccupiedMs']['handler'], handler)

    def test_nested_overlapping_disjoint_and_multiple(self):
        nested = occ([('canvasOffscreenDraw', 12, 5), ('pollRenderJob', 9, 8), ('adapterRenderRequest', 9, 8)])
        self.assertEqual((nested['syncOccupiedMs']['handler'], nested['nestedSyncCalls']), (8, 3))
        overlap = occ([('a', 3, 10), ('b', 5, 10)])  # union [3,15)
        self.assertEqual((overlap['syncOccupiedMs']['handler'], overlap['partiallyOverlappingSyncCalls']), (12, 2))
        disjoint = occ([('a', 3, 2), ('b', 8, 2), ('c', 12, 1)])
        self.assertEqual((disjoint['syncOccupiedMs']['handler'], disjoint['nestedSyncCalls'], disjoint['partiallyOverlappingSyncCalls']), (5, 0, 0))
        crossing_two = occ([('a', 19, 4)])  # handler 1, toObserved 2, observedToRaf1 1
        self.assertEqual([crossing_two['syncOccupiedMs'][k] for k in ['handler', 'toObserved', 'observedToRaf1']], [1, 2, 1])

    def test_async_await_is_not_sync_time(self):
        row = occ([('imageDecodeAwait', 4, 40), ('createImageBitmapRejected', 3, 5), ('insertText', 4, 1)])
        self.assertEqual((row['syncOccupiedInWindowMs'], row['asyncAwaitRecords']), (1, 2))

    def test_edge_crossing_and_outside_time(self):
        row = occ([('a', -5, 10), ('b', 58, 6)])
        self.assertEqual((row['callsCrossingWindowEdge'], row['syncOccupiedInWindowMs'], row['syncOutsideWindowMs']), (2, 7, 9))

    def test_invariants_on_random_records_and_order(self):
        rng = random.Random(7)
        for _ in range(300):
            calls = [(rng.choice(['a', 'b', 'c']), round(rng.uniform(-10, 70), 2), round(rng.choice([0, rng.uniform(0, 30)]), 2))
                     for _ in range(rng.randint(0, 12))]
            row = occ(calls)
            shuffled = calls[:]; rng.shuffle(shuffled)
            self.assertEqual(occ(shuffled)['syncOccupiedMs'], row['syncOccupiedMs'])
            merged = attribution.union([(s, s+ms) for _, s, ms in calls])
            for name, a, b in attribution.SEGMENTS:
                value = row['syncOccupiedMs'][name]
                self.assertGreaterEqual(value, 0); self.assertLessEqual(value, AT[b]-AT[a]+1e-9)
                self.assertGreaterEqual(row['unattributedMs'][name], -1e-9)
            total = attribution.occupied(merged, -math.inf, math.inf)
            self.assertAlmostEqual(row['syncOccupiedInWindowMs']+row['syncOutsideWindowMs'], total, places=6)
            self.assertLessEqual(total, sum(ms for _, _, ms in calls)+1e-9)

    def test_percentile_matches_producer_rule(self):
        for n in range(1, 40):
            values = list(range(n))
            for q in (.5, .95):
                self.assertEqual(attribution.pct(values, q), values[min(n-1, max(0, int(-(-q*n//1))-1))])


class ValidationTests(unittest.TestCase):
    def test_non_finite_bool_missing_and_reversed_inputs_are_rejected(self):
        mutations = [lambda s: s.update(keyToFrame=math.nan), lambda s: s.update(keyToFrame=math.inf), lambda s: s.update(keyToFrame=True),
                     lambda s: s['at'].update(end=math.nan), lambda s: s['at'].update(raf1=-math.inf), lambda s: s['at'].pop('observed'),
                     lambda s: s['at'].update(input=True), lambda s: s['at'].update(handlerEnd=None), lambda s: s['at'].update(raf1=10),
                     lambda s: s['at'].update(key=1), lambda s: s.update(keyToFrame=70),
                     lambda s: s['engineTimeline'][0].update(ms=math.nan), lambda s: s['engineTimeline'][0].update(ms=math.inf),
                     lambda s: s['engineTimeline'][0].update(ms=-3), lambda s: s['engineTimeline'][0].update(at=math.nan),
                     lambda s: s['engineTimeline'][0].update(at=None), lambda s: s['engineTimeline'][0].update(at=False),
                     lambda s: s['engineTimeline'][0].pop('name'), lambda s: s.update(engineTimeline={}),
                     lambda s: s['timeline'][0].update(at=math.nan), lambda s: s['timeline'][0].update(ms=-1),
                     lambda s: s['timeline'][0].update(page='1'), lambda s: s.update(timeline=None), lambda s: s.pop('at')]
        for i, mutate in enumerate(mutations):
            value = sample([('insertText', 4, 1)]); mutate(value)
            with self.subTest(i), self.assertRaises(ValueError): attribution.sample_segments(value)

    def test_signed_offsets_are_preserved(self):
        row = occ([('restoreSnapshot', -12.5, 3)], timeline=[{'name': 'dom:keydown', 'at': -40, 'ms': None, 'page': None}])
        self.assertEqual((row['syncOutsideWindowMs'], row['syncOccupiedInWindowMs']), (3, 0))

    def test_summary_requires_every_group_start_sample(self):
        perf = {'sample': 'x', 'groupStart': {'n': 3}, 'zeroWorkFrameFloorMs': {}, 'frameGapDuringHistoryAndFollowingInputMs': {},
                'timelineSamples': [sample(), sample(at=dict(AT, raf1=36, end=40)), copy.deepcopy(sample()) | {'kind': 'undo'}]}
        with self.assertRaises(ValueError): attribution.summarize(perf)
        perf['groupStart']['n'] = 2
        summary = attribution.summarize(perf)
        self.assertEqual((summary['failingOverLimit'], summary['dominantSegmentInFailingSamples']), (1, {'observedToRaf1': 1}))

    def test_cli_rejects_json_nan_constant_and_keeps_existing_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)/'in.json'; source.write_text('{"measurementComplete": true, "x": NaN}')
            run = lambda out: subprocess.run([sys.executable, str(Path(__file__).with_name('native_attribution.py')), '--input', str(source),
                                              '--output', str(out)], capture_output=True, text=True, timeout=60)
            result = run(Path(tmp)/'out.json')
            self.assertNotEqual(result.returncode, 0); self.assertIn('non-standard JSON constant NaN', result.stderr)
            self.assertFalse((Path(tmp)/'out.json').exists())
            existing = Path(tmp)/'existing.json'; existing.write_text('keep\n')
            self.assertEqual(run(existing).returncode, 2); self.assertEqual(existing.read_text(), 'keep\n')


if __name__ == '__main__': unittest.main()
