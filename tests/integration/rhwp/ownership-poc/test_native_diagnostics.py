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

    def assertTrimFails(self, change, text=None):
        result = trim_result(); change(result)
        verdict = trim.classify(result, WASM)
        self.assertEqual(verdict['status'], 'FAIL', 'false PASS')
        if text: self.assertTrue(any(text in f for f in verdict['failures']), verdict['failures'][:6])
        return verdict

    def test_absent_or_none_ownership_result_cannot_hide_orphan_surface(self):
        def orphan(value):
            def change(result):
                result['points'][2]['engineSurfaces'].update(detachedCanvases=5, canvasCount=5)
                if value == 'missing': result['points'][2].pop('ownershipFailures')
                else: result['points'][2]['ownershipFailures'] = value
            return change
        for value in ('missing', None, []):
            with self.subTest(stored=value):
                self.assertTrimFails(orphan(value), 'not accounted')

    def test_ownership_is_recomputed_not_trusted(self):
        result = trim_result()
        for point in result['points']: point.pop('ownershipFailures')
        self.assertEqual(trim.classify(result, WASM)['status'], 'PASS')

    def test_empty_process_observations_fail(self):
        def empty(result):
            for point in result['points']: point['processes'] = []; point['aggregateRssBytes'] = 0
        self.assertTrimFails(empty, 'WebProcess')

    def test_invalid_process_identity_fails(self):
        self.assertTrimFails(lambda r: r['points'][3]['processes'][0].pop('pid'), 'pid/startTime')
        self.assertTrimFails(lambda r: r['points'][3]['processes'][0].update(pid=True), 'pid/startTime')
        self.assertTrimFails(lambda r: r['points'][3]['processes'][0].pop('startTime'), 'pid/startTime')
        def regenerated(result):
            for point in result['points'][8:]: point['processes'][0]['startTime'] = 777
        self.assertTrimFails(regenerated, 'identity')

    def test_missing_zero_or_invalid_rss_fails(self):
        for value in (None, 0, -5, 3.5, True):
            with self.subTest(rss=value):
                self.assertTrimFails(lambda r: r['points'][1]['processes'][0].update(rssBytes=value), 'RSS')
        self.assertTrimFails(lambda r: r['points'][1].pop('aggregateRssBytes'), 'RSS')

    def test_malformed_or_reordered_phases_fail(self):
        self.assertTrimFails(lambda r: r['points'].__setitem__(4, None), 'phases')
        self.assertTrimFails(lambda r: r['points'][4].pop('phase'), 'phases')
        self.assertTrimFails(lambda r: r['points'].insert(5, dict(r['points'][4])), 'phases')
        self.assertTrimFails(lambda r: r['points'].insert(2, r['points'].pop(3)), 'phases')
        self.assertTrimFails(lambda r: r['points'].append({**r['points'][-1], 'phase': 'extra'}), 'phases')
        for broken in (None, [], {'points': None}, {'points': 'x'}):
            with self.subTest(result=broken):
                self.assertEqual(trim.classify(broken, WASM)['status'], 'FAIL')

    def test_opened_state_must_still_be_structurally_valid(self):
        self.assertTrimFails(lambda r: r['points'][1]['renderer']['jobs'].pop('pendingCount'), 'job counters')
        self.assertTrimFails(lambda r: r['points'][1]['renderer'].pop('cache'), 'renderer stats')

    def test_trim_of_an_already_empty_cache_is_not_proof(self):
        def empty(result):
            for point in result['points']:
                point['engineSurfaces'].update(detachedCanvases=0, canvasCount=0, canvasPixels=0)
                point['renderer']['cache']['decoded'].update(entries=0, bytes=0)
        self.assertTrimFails(empty, 'populated')

    def test_idle_must_retain_cache_owned_surfaces(self):
        def dropped(result):
            idle = result['points'][11]; self.assertEqual(idle['phase'], 'idle10s-without-trim')
            idle['engineSurfaces'].update(detachedCanvases=1, canvasCount=1, canvasPixels=50)
            idle['renderer']['cache']['decoded'].update(entries=1, bytes=200)
        self.assertTrimFails(dropped, 'idle')

    def test_image_cache_must_be_empty_after_trim(self):
        def kept(result):
            result['points'][13]['renderer']['cache']['images'].update(entries=1, bytes=10)
            result['points'][13]['engineSurfaces'].update(imageCount=1)
        self.assertTrimFails(kept, 'trim')

    def test_reopen_must_repopulate(self):
        def empty(result):
            for point in result['points'][-2:]:
                point['engineSurfaces'].update(detachedCanvases=0, canvasCount=0, canvasPixels=0)
                point['renderer']['cache']['decoded'].update(entries=0, bytes=0)
        self.assertTrimFails(empty, 'repopulate')

    def test_run_error_cleanup_and_identity_required(self):
        self.assertTrimFails(lambda r: r.update(error='lost'), 'run error')
        self.assertTrimFails(lambda r: r['cleanup'].update(sessionEnded=False), 'cleanup')
        self.assertTrimFails(lambda r: r.pop('engineIdentityAtEnd'), 'engineIdentityAtEnd')
        self.assertTrimFails(lambda r: r['engineIdentity'].update(wasmSha256='e300'), 'engineIdentity')

    def test_unhashable_phase_is_a_failure_not_an_exception(self):
        self.assertTrimFails(lambda r: r['points'][3].update(phase=['closed-A1']))


def frame_result():
    def record(index):
        return {'kind': 'groupStart', 'key': 0.5, 'rev': 20, 'task0': 21, 'rafA': 25, 'taskA': 30, 'rafB': 58, 'taskB': 60, 'rafC': 70, 'revision': str(100 + index)}
    documents = [{'sample': name, 'sourceSha256': frames.EXPECTED_SOURCE_SHA256[name], 'engineIdentity': {'wasmSha256': WASM},
                  'groupStart': {'n': 30, 'timeouts': 0}, 'measureTimeline': [{'kind': 'groupStart', 'keyToFrame': 70, 'at': {}} for _ in range(30)],
                  'observer': [record(i) for i in range(30)] + [{'kind': 'extend', 'revision': 'x'}]} for name, _ in frames.FIXTURES]
    return {'documents': documents, 'engineIdentity': {'wasmSha256': WASM}}


class FrameAttribution(unittest.TestCase):
    def verdict(self, change):
        result = frame_result(); change(result)
        return frames.classify(result, WASM)

    def test_complete_diagnostic_is_never_official(self):
        verdict = frames.classify(frame_result(), WASM)
        self.assertEqual(verdict['status'], 'DIAGNOSTIC_COMPLETE', verdict['failures'])
        self.assertTrue(verdict['officialD4'].startswith('not evaluated'))
        self.assertIn('by order only', verdict['observerMeasurePairing'])

    def test_task_after_next_raf_is_an_observation_not_a_failure(self):
        self.assertEqual(self.verdict(lambda r: r['documents'][0]['observer'][0].update(taskA=60))['status'], 'DIAGNOSTIC_COMPLETE')

    def test_incomplete_observer_or_measure_fails(self):
        for change in (lambda r: r['documents'].pop(), lambda r: r['documents'][1]['observer'].pop(0),
                       lambda r: r['documents'][2]['observer'][3].pop('rafB'), lambda r: r['documents'][0]['groupStart'].update(timeouts=1),
                       lambda r: r['documents'][0]['measureTimeline'].pop(), lambda r: r['documents'][0].pop('measureTimeline'),
                       lambda r: r.update(error='lost')):
            self.assertEqual(self.verdict(change)['status'], 'FAIL')

    def test_fixture_order_and_identity_required(self):
        self.assertEqual(self.verdict(lambda r: r['documents'].reverse())['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r['documents'][1].update(sample='other.hwpx'))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r['documents'].append(copy.deepcopy(r['documents'][0])))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r['documents'][2].update(sourceSha256='0' * 64))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r['documents'][3].update(engineIdentity={'wasmSha256': 'e300'}))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r.update(engineIdentity=None))['status'], 'FAIL')

    def test_timestamps_must_be_finite_numbers_in_causal_order(self):
        for field, value in (('rafB', True), ('rev', float('nan')), ('taskB', float('inf')), ('key', None), ('rafA', '25')):
            with self.subTest(field=field, value=value):
                self.assertEqual(self.verdict(lambda r: r['documents'][0]['observer'][5].update({field: value}))['status'], 'FAIL')
        for field, value in (('rafA', 10), ('rafB', 24), ('rafC', 50), ('task0', 19), ('rev', -1)):
            with self.subTest(order=field):
                self.assertEqual(self.verdict(lambda r: r['documents'][1]['observer'][2].update({field: value}))['status'], 'FAIL')

    def test_duplicated_records_fail(self):
        self.assertEqual(self.verdict(lambda r: r['documents'][0]['observer'].insert(1, dict(r['documents'][0]['observer'][0])))['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r['documents'][0]['observer'][1].update(revision='100'))['status'], 'FAIL')

    def test_malformed_documents_fail_without_exception(self):
        for broken in (None, [], {'documents': None}, {'documents': [None] * 4}):
            with self.subTest(result=broken):
                self.assertEqual(frames.classify(broken, WASM)['status'], 'FAIL')
        self.assertEqual(self.verdict(lambda r: r['documents'][0]['observer'].__setitem__(3, 'x'))['status'], 'FAIL')

    def test_records_without_new_identity_fields_are_inconclusive(self):
        def historical(result):
            for doc in result['documents']:
                doc.pop('engineIdentity')
                for record in doc['observer']: record.pop('revision', None)
        verdict = self.verdict(historical)
        self.assertEqual((verdict['status'], verdict['failures']), ('INCONCLUSIVE', []))

if __name__ == '__main__':
    unittest.main()
