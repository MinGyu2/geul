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
images = load('image-cache-trim-native')
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

    def test_opened_state_engine_surfaces_are_mandatory(self):
        def opened(change):
            def apply(result):
                point = result['points'][5]; self.assertEqual(point['phase'], 'opened-A2'); change(point)
            return apply
        cases = {'missing': lambda p: p.pop('engineSurfaces'), 'none': lambda p: p.update(engineSurfaces=None),
                 'list': lambda p: p.update(engineSurfaces=[]),
                 **{f'missing-{k}': (lambda k: lambda p: p['engineSurfaces'].pop(k))(k) for k in ('detachedCanvases', 'canvasCount', 'canvasPixels', 'imageCount', 'externrefSlots')},
                 'negative': lambda p: p['engineSurfaces'].update(detachedCanvases=-1), 'bool': lambda p: p['engineSurfaces'].update(canvasCount=True),
                 'float': lambda p: p['engineSurfaces'].update(canvasPixels=1.5)}
        for name, change in cases.items():
            with self.subTest(case=name):
                self.assertTrimFails(opened(change), 'engine surface')

    def test_opened_state_cache_counters_are_mandatory(self):
        self.assertTrimFails(lambda r: r['points'][5]['renderer']['cache']['decoded'].pop('entries'), 'decoded cache')
        self.assertTrimFails(lambda r: r['points'][5]['renderer']['cache']['images'].update(bytes='0'), 'images cache')

    def test_opened_state_may_hold_active_resources(self):
        result = trim_result()
        point = result['points'][5]
        point['engineSurfaces'].update(detachedCanvases=9, canvasCount=9, canvasPixels=999)  # staging beyond the cache
        point['renderer']['jobs'].update(activeJobs=3, activeLeaseCount=2, pendingCount=2)
        self.assertEqual(trim.classify(result, WASM)['status'], 'PASS', trim.classify(result, WASM)['failures'])

    def test_every_phase_has_a_summary(self):
        verdict = trim.classify(trim_result(), WASM)
        self.assertTrue(all(isinstance(v, dict) for v in verdict['summary'].values()))

    def test_unhashable_phase_is_a_failure_not_an_exception(self):
        self.assertTrimFails(lambda r: r['points'][3].update(phase=['closed-A1']))


def image_result():
    points = []
    for phase in images.PHASES:
        value = point(len(points), 'x', phase not in ('opened', 'reopened'))
        populated = phase in ('opened', 'closed', 'idle10s-without-trim', 'reopened', 'reclosed')
        value['renderer']['cache']['images'].update(entries=2 if populated else 0, bytes=8_000_000 if populated else 0)
        value['renderer']['cache']['decoded'].update(entries=2 if populated else 0, negativeEntries=2 if populated else 0, bytes=128 if populated else 0)
        value['engineSurfaces'].update(imageCount=2 if populated else 0, detachedCanvases=0, canvasCount=0, canvasPixels=0, imagePixels=1200 ** 2 + 1210 ** 2 if populated else 0)  # generate.mjs: two SVGs 1200 and 1210 px square
        value['phase'] = phase
        points.append(value)
    exact = {'verified': True, 'pixels': 0, 'maxDelta': 0}
    return {'points': points, 'frames': {'opened': dict(exact), 'reopened': dict(exact)}, 'engineIdentity': {'wasmSha256': WASM},
            'engineIdentityAtEnd': {'wasmSha256': WASM}, 'cleanup': dict.fromkeys(trim.lifecycle_evidence.CLEANUP_STEPS, True)}


class ImageCacheTrim(unittest.TestCase):
    def assertImageFails(self, change, text=None):
        result = image_result(); change(result)
        verdict = images.classify(result, WASM)
        self.assertEqual(verdict['status'], 'FAIL', 'false PASS')
        if text: self.assertTrue(any(text in f for f in verdict['failures']), verdict['failures'][:5])

    def test_complete_populated_image_experiment_passes(self):
        verdict = images.classify(image_result(), WASM)
        self.assertEqual(verdict['status'], 'PASS', verdict['failures'])
        self.assertEqual(verdict['summary']['opened']['imageEntries'], 2)

    def test_never_populated_image_cache_is_not_proof(self):
        def empty(result):
            for value in result['points']:
                value['renderer']['cache']['images'].update(entries=0, bytes=0); value['engineSurfaces'].update(imageCount=0)
        self.assertImageFails(empty, 'not populated')

    def test_decoded_entries_cannot_substitute_for_image_entries(self):
        def substitute(result):
            for value in result['points']:
                value['renderer']['cache']['images'].update(entries=0, bytes=0); value['engineSurfaces'].update(imageCount=0)
                if value['phase'] in ('opened', 'closed', 'idle10s-without-trim', 'reopened', 'reclosed'):
                    value['renderer']['cache']['decoded'].update(entries=4, negativeEntries=2, bytes=528)
                    value['engineSurfaces'].update(detachedCanvases=2, canvasCount=2, canvasPixels=100)
        self.assertImageFails(substitute, 'not populated')

    def test_image_cache_must_survive_close_and_idle(self):
        def lost(result):
            value = result['points'][3]; value['renderer']['cache']['images'].update(entries=1, bytes=4_000_000); value['engineSurfaces'].update(imageCount=1)
        self.assertImageFails(lost, 'keep')

    def test_trim_must_release_images_and_surfaces(self):
        self.assertImageFails(lambda r: r['points'][4]['renderer']['cache']['images'].update(entries=1, bytes=10) or r['points'][4]['engineSurfaces'].update(imageCount=1), 'trim')
        self.assertImageFails(lambda r: r['points'][9]['renderer']['cache']['images'].update(entries=1, bytes=10) or r['points'][9]['engineSurfaces'].update(imageCount=1), 'trim')

    def test_orphan_engine_image_in_settled_state_fails(self):
        self.assertImageFails(lambda r: r['points'][2]['engineSurfaces'].update(imageCount=3), 'image surfaces not accounted')

    def test_reopen_must_repopulate_with_exact_frames(self):
        def empty(result):
            for value in result['points'][7:9]:
                value['renderer']['cache']['images'].update(entries=0, bytes=0); value['engineSurfaces'].update(imageCount=0)
                value['renderer']['cache']['decoded'].update(entries=0, negativeEntries=0, bytes=0)
        self.assertImageFails(empty, 'repopulate')
        self.assertImageFails(lambda r: r['frames']['reopened'].update(pixels=4), 'not exact')
        self.assertImageFails(lambda r: r['frames'].pop('opened'), 'not exact')
        self.assertImageFails(lambda r: r['frames']['opened'].update(maxDelta=False), 'not exact')

    def test_image_pixel_evidence_is_mandatory_and_exact(self):
        def opened(change):
            return lambda r: change(r['points'][1]['engineSurfaces'])
        cases = {'missing': opened(lambda e: e.pop('imagePixels')), 'none': opened(lambda e: e.update(imagePixels=None)),
                 'false': opened(lambda e: e.update(imagePixels=False)), 'zero-populated': opened(lambda e: e.update(imagePixels=0)),
                 'negative': opened(lambda e: e.update(imagePixels=-1)), 'float': opened(lambda e: e.update(imagePixels=1.0)),
                 'string': opened(lambda e: e.update(imagePixels='2904100')), 'wrong-total': opened(lambda e: e.update(imagePixels=2_000_000)),
                 'closed-differs': lambda r: r['points'][2]['engineSurfaces'].update(imagePixels=1_440_000),
                 'after-trim': lambda r: r['points'][4]['engineSurfaces'].update(imagePixels=5),
                 'reopened-missing': lambda r: r['points'][7]['engineSurfaces'].pop('imagePixels'),
                 'baseline-missing': lambda r: r['points'][0]['engineSurfaces'].pop('imagePixels')}
        for name, change in cases.items():
            with self.subTest(case=name):
                self.assertImageFails(change)

    def test_baseline_must_start_empty(self):
        self.assertImageFails(lambda r: r['points'][0]['renderer']['cache']['images'].update(entries=2, bytes=10) or r['points'][0]['engineSurfaces'].update(imageCount=2), 'baseline')

    def test_process_generation_must_stay_stable(self):
        def regenerated(result):
            for value in result['points'][5:]: value['processes'][0]['startTime'] = 999
        self.assertImageFails(regenerated, 'identity')

    def test_malformed_or_incomplete_evidence_fails(self):
        self.assertImageFails(lambda r: r['points'].pop(3), 'phases')
        self.assertImageFails(lambda r: r['points'][3].update(phase=['closed']), 'phases')
        self.assertImageFails(lambda r: r['points'][1].pop('engineSurfaces'), 'engine surface')
        self.assertImageFails(lambda r: r['points'][1]['processes'][0].update(startTime=None), 'pid/startTime')
        self.assertImageFails(lambda r: r.update(error='lost'), 'run error')
        self.assertImageFails(lambda r: r['cleanup'].update(displayTerminated=False), 'cleanup')
        self.assertImageFails(lambda r: r['engineIdentity'].update(wasmSha256='e300'), 'engineIdentity')
        for broken in (None, [], {'points': None}):
            self.assertEqual(images.classify(broken, WASM)['status'], 'FAIL')


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

    def test_malformed_json_fields_fail_without_exception(self):
        cases = {
            'sample-list': lambda r: r['documents'][0].update(sample=[]), 'sample-dict': lambda r: r['documents'][1].update(sample={}),
            'revision-list': lambda r: r['documents'][0]['observer'][2].update(revision=[]), 'revision-dict': lambda r: r['documents'][0]['observer'][2].update(revision={}),
            'revision-number': lambda r: r['documents'][0]['observer'][2].update(revision=7),
            'engine-identity-list': lambda r: r['documents'][2].update(engineIdentity=[]), 'engine-identity-none': lambda r: r['documents'][2].update(engineIdentity=None),
            'engine-identity-nonempty-list': lambda r: r['documents'][2].update(engineIdentity=['x']), 'engine-identity-string': lambda r: r['documents'][2].update(engineIdentity=WASM),
            'group-start-n-float': lambda r: r['documents'][1]['groupStart'].update(n=30.0), 'group-start-timeouts-bool': lambda r: r['documents'][1]['groupStart'].update(timeouts=False),
            'final-identity-list': lambda r: r.update(engineIdentity=[]),
            'timeline-string': lambda r: r['documents'][0].update(measureTimeline='x'), 'timeline-dict': lambda r: r['documents'][0].update(measureTimeline={'a': 1}),
            'timeline-nested-list': lambda r: r['documents'][0]['measureTimeline'].__setitem__(0, []),
            'timeline-key-to-frame-bool': lambda r: r['documents'][0]['measureTimeline'][0].update(keyToFrame=True),
            'observer-dict': lambda r: r['documents'][3].update(observer={'a': 1}), 'observer-nested-list': lambda r: r['documents'][3]['observer'].__setitem__(4, [1]),
            'observer-kind-list': lambda r: r['documents'][3]['observer'][4].update(kind=[]),
            'group-start-list': lambda r: r['documents'][1].update(groupStart=[]), 'group-start-n-bool': lambda r: r['documents'][1]['groupStart'].update(n=True),
            'source-sha-list': lambda r: r['documents'][1].update(sourceSha256=[]), 'documents-dict': lambda r: r.update(documents={'a': 1}),
            'error-list': lambda r: r.update(error=['x'])}
        for name, change in cases.items():
            with self.subTest(case=name):
                self.assertEqual(self.verdict(change)['status'], 'FAIL')

    def test_extreme_or_non_numeric_timestamps_fail_without_exception(self):
        for value in (10 ** 400, -(10 ** 400), float('inf'), float('-inf'), float('nan'), True, False, None, '25'):
            with self.subTest(observer=repr(value)[:12]):
                verdict = self.verdict(lambda r: r['documents'][0]['observer'][3].update(rafA=value))
                self.assertEqual(verdict['status'], 'FAIL'); self.assertTrue(any('timestamp' in f for f in verdict['failures']))
            with self.subTest(measure=repr(value)[:12]):
                verdict = self.verdict(lambda r: r['documents'][1]['measureTimeline'][3].update(keyToFrame=value))
                self.assertEqual(verdict['status'], 'FAIL'); self.assertTrue(any('MEASURE' in f for f in verdict['failures']))

    def test_valid_integer_and_float_timestamps_complete(self):
        def mixed(result):
            for doc in result['documents']:
                for index, record in enumerate(doc['observer'][:30]):
                    record.update(key=1000 + index, rev=1020.25 + index, task0=1021.5 + index, rafA=1025 + index, taskA=1070 + index, rafB=1058.0 + index,
                                  taskB=1060 + index, rafC=1070.5 + index)
        self.assertEqual(self.verdict(mixed)['status'], 'DIAGNOSTIC_COMPLETE')

    def test_invalid_expected_wasm_identity_fails(self):
        for expected in (None, '', 'abc', 123, ['x'], WASM.upper()):
            with self.subTest(expected=expected):
                result = frame_result()
                for doc in result['documents']: doc['engineIdentity'] = {'wasmSha256': expected}
                result['engineIdentity'] = {'wasmSha256': expected}
                self.assertEqual(frames.classify(result, expected)['status'], 'FAIL')

    def test_records_without_new_identity_fields_are_inconclusive(self):
        def historical(result):
            for doc in result['documents']:
                doc.pop('engineIdentity')
                for record in doc['observer']: record.pop('revision', None)
        verdict = self.verdict(historical)
        self.assertEqual((verdict['status'], verdict['failures']), ('INCONCLUSIVE', []))

if __name__ == '__main__':
    unittest.main()
