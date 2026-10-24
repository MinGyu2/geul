"""Classification of the cache-trim and D4 frame-attribution diagnostics with synthetic results."""
import copy
import importlib.util
from pathlib import Path
import unittest

from test_lifecycle_evidence import WASM, point


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


trim = load('cache-trim-native')
frames = load('d4-frame-attribution-native')


def trim_result():
    phases = ['baseline', *[f'{k}-A{i}' for i in range(trim.CYCLES) for k in ('opened', 'closed')], 'idle10s-without-trim',
              'trim+0s', 'trim+2s', 'trim+10s', 'opened-C0', 'closed-C0']
    points = []
    for phase in phases:
        value = point(len(points), 'x', not phase.startswith('opened'))
        if phase.startswith('trim'):
            value['engineSurfaces'].update(detachedCanvases=0, canvasCount=0, canvasPixels=0)
            value['renderer']['cache']['decoded'].update(entries=0, bytes=0)
        value.update(phase=phase, ownershipFailures=trim.surfaces_accounted(value) if not phase.startswith('opened') else None)
        points.append(value)
    return {'points': points, 'engineIdentity': {'wasmSha256': WASM}, 'engineIdentityAtEnd': {'wasmSha256': WASM},
            'cleanup': dict.fromkeys(trim.lifecycle_evidence.CLEANUP_STEPS, True)}


class CacheTrim(unittest.TestCase):
    def test_complete_experiment_passes(self):
        verdict = trim.classify(trim_result(), WASM)
        self.assertEqual(verdict['status'], 'PASS', verdict['failures'])
        self.assertEqual(verdict['summary']['trim+0s']['detachedCanvases'], 0)

    def test_trim_that_keeps_surfaces_fails(self):
        result = trim_result()
        result['points'][-4]['engineSurfaces']['detachedCanvases'] = 2
        self.assertEqual(trim.classify(result, WASM)['status'], 'FAIL')

    def test_unaccounted_settled_surface_fails(self):
        result = trim_result()
        result['points'][2]['engineSurfaces'].update(detachedCanvases=5, canvasCount=5)
        result['points'][2]['ownershipFailures'] = trim.surfaces_accounted(result['points'][2])
        self.assertTrue(result['points'][2]['ownershipFailures'])
        self.assertEqual(trim.classify(result, WASM)['status'], 'FAIL')

    def test_missing_phase_or_identity_change_fails(self):
        result = trim_result(); del result['points'][5]
        self.assertEqual(trim.classify(result, WASM)['status'], 'FAIL')
        result = trim_result(); result['points'][7]['processes'][0]['startTime'] = 1
        self.assertEqual(trim.classify(result, WASM)['status'], 'FAIL')


def frame_result():
    record = {'kind': 'groupStart', 'key': 0, 'rev': 20, 'task0': 21, 'rafA': 25, 'taskA': 30, 'rafB': 58, 'taskB': 60, 'rafC': 70}
    doc = {'groupStart': {'n': 30, 'timeouts': 0}, 'observer': [dict(record) for _ in range(30)]}
    return {'documents': [copy.deepcopy(doc) for _ in range(4)]}


class FrameAttribution(unittest.TestCase):
    def test_complete_diagnostic_is_never_official(self):
        verdict = frames.classify(frame_result())
        self.assertEqual(verdict['status'], 'DIAGNOSTIC_COMPLETE')
        self.assertTrue(verdict['officialD4'].startswith('not evaluated'))

    def test_incomplete_observer_or_measure_fails(self):
        for change in (lambda r: r['documents'].pop(), lambda r: r['documents'][1]['observer'].pop(),
                       lambda r: r['documents'][2]['observer'][3].pop('rafB'), lambda r: r['documents'][0]['groupStart'].update(timeouts=1),
                       lambda r: r.update(error='lost')):
            result = frame_result(); change(result)
            self.assertEqual(frames.classify(result)['status'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
