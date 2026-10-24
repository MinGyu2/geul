"""Fail-closed lifecycle evidence classification with synthetic complete/broken results (no native run)."""
import copy
import json
import importlib.util
import os
from pathlib import Path
import unittest

import lifecycle_evidence as evidence

WASM = '48adaa0f748484d12f59f4805deda0480635f915368392a87e76e95962ec0b27'
PROCESS = {'pid': 4242, 'rssBytes': 700 << 20, 'startTime': 123456}
MIB = 1 << 20


def point(sequence, doc, closed):
    decoded = {'maxBytes': 256 * MIB, 'maxEntries': 256, 'maxEntryBytes': 64 * MIB, 'bytes': 400, 'entries': 2,
               'pendingEntries': 0, 'negativeEntries': 0, 'transientEntries': 0}
    images = {'maxBytes': 64 * MIB, 'maxEntries': 256, 'maxEntryBytes': 16 * MIB, 'bytes': 0, 'entries': 0,
              'pendingEntries': 0, 'negativeEntries': 0, 'transientEntries': 0}
    jobs = {**evidence.DECLARED_JOBS, **dict.fromkeys(evidence.JOB_COUNTERS + evidence.RELEASED_JOB_FIELDS, 0), 'expiryTimerActive': False}
    if not closed: jobs.update(activeJobs=1, pendingCount=1)
    return {'sequence': sequence, 'doc': doc, 'sessionId': 's-1', 'processes': [dict(PROCESS)], 'aggregateRssBytes': PROCESS['rssBytes'],
            'wasmBytes': 133 * MIB, 'owners': [] if closed else [{'id': 1}], 'canvasCount': 0 if closed else 3,
            'engineSurfaces': {'detachedCanvases': 2, 'canvasCount': 2, 'canvasPixels': 100, 'imageCount': 0, 'externrefSlots': 1156},
            'renderer': {'sessions': [], 'subscribers': 0, 'jobs': jobs, 'cache': {'decoded': decoded, 'images': images}}}


def complete():
    samples, lifecycle, gates = [], [], []
    for doc in evidence.DOCUMENTS:
        rows = []
        for mode in evidence.MODES:
            for cycle in range(evidence.CYCLES):
                row = {'mode': mode, 'cycle': cycle}
                for label in [*evidence.LABELS, evidence.SETTLED][:4 if cycle == evidence.CYCLES - 1 else 3]:
                    row[label] = point(len(samples), doc, label != 'opened'); samples.append(row[label])
                rows.append(row)
                gates.append({'gate': 'D4', 'item': f'{mode} cycle{cycle}: cleanup', 'result': 'PASS', 'detail': '',
                              'association': {'doc': doc, 'sessionId': 's-1', 'afterSequence': len(samples) - 1}})
        lifecycle.append({'sample': doc, 'cyclesPerMode': evidence.CYCLES, 'rows': rows})
        gates.append({'gate': 'D4', 'item': '.' + doc.rpartition('.')[2] + ': cache/RSS', 'result': 'INCONCLUSIVE', 'detail': '',
                      'association': {'doc': doc, 'sessionId': 's-1', 'afterSequence': len(samples) - 1}})
    return {'sessionId': 's-1', 'engineIdentity': {'wasmSha256': WASM}, 'engineIdentityAtEnd': {'wasmSha256': WASM},
            'processesAtStart': [{'pid': 7, 'comm': 'geul', 'startTime': 9}, {'comm': evidence.WEBPROCESS_COMM, **PROCESS}],
            'samples': samples, 'measurements': {'lifecycle': lifecycle}, 'gates': gates, 'completedCycles': evidence.EXPECTED_CYCLES,
            'cleanup': dict.fromkeys(evidence.CLEANUP_STEPS, True)}


def detached_samples(result):
    """JSON round trip: durable samples and lifecycle rows become independent copies, as in the saved evidence."""
    return json.loads(json.dumps(result))


def rows(result, doc=0):
    return result['measurements']['lifecycle'][doc]['rows']


class LifecycleEvidence(unittest.TestCase):
    def verdict(self, change=None):
        result = complete()
        if change: change(result)
        return evidence.classify(result, WASM)

    def assertFails(self, change, text=None):
        verdict = self.verdict(change)
        self.assertEqual(verdict['status'], 'FAIL')
        if text: self.assertTrue(any(text in failure for failure in verdict['failures']), verdict['failures'][:5])
        return verdict

    def test_complete_synthetic_fixture_passes(self):
        verdict = self.verdict()
        self.assertEqual(verdict['status'], 'PASS', verdict['failures'][:5])
        self.assertEqual((verdict['completedCycles'], verdict['memoryPoints']), (120, 366))
        self.assertTrue(verdict['webProcessIdentity']['verified'])
        self.assertTrue(verdict['rssVerdict'].startswith('INCONCLUSIVE'))

    def test_expected_point_count_matches_protocol(self):
        self.assertEqual(evidence.EXPECTED_POINTS, 366)
        self.assertEqual(len(complete()['samples']), 366)

    def test_zero_webprocess_observations_fail(self):
        def empty(result):
            for sample in result['samples']: sample['processes'] = []; sample['aggregateRssBytes'] = 0
        verdict = self.assertFails(empty, 'expected 1 WebProcess')
        self.assertFalse(verdict['webProcessIdentity']['verified'])

    def test_missing_webprocess_at_start_fails(self):
        self.assertFails(lambda r: r.update(processesAtStart=[p for p in r['processesAtStart'] if p['comm'] != evidence.WEBPROCESS_COMM]), 'processesAtStart')

    def test_missing_or_invalid_pid_fails(self):
        self.assertFails(lambda r: r['samples'][5]['processes'][0].pop('pid'), 'pid/startTime')
        self.assertFails(lambda r: r['samples'][5]['processes'][0].update(pid=True), 'pid/startTime')
        self.assertFails(lambda r: r['samples'][5]['processes'][0].update(pid=0), 'pid/startTime')

    def test_missing_process_generation_fails(self):
        self.assertFails(lambda r: r['samples'][9]['processes'][0].update(startTime=None), 'pid/startTime')

    def test_reused_pid_with_changed_generation_fails(self):
        def replaced(result):
            for sample in result['samples'][200:]: sample['processes'][0]['startTime'] = 999999
        self.assertFails(replaced, 'identity not stable')

    def test_extra_webprocess_fails(self):
        self.assertFails(lambda r: r['samples'][3]['processes'].append({'pid': 5, 'rssBytes': 1, 'startTime': 2}), 'expected 1 WebProcess')

    def test_invalid_or_zero_rss_fails(self):
        for value in (0, -1, 1.5, None, True):
            with self.subTest(value=value):
                self.assertFails(lambda r: r['samples'][4]['processes'][0].update(rssBytes=value), 'RSS')
        self.assertFails(lambda r: r['samples'][4].update(aggregateRssBytes=1), 'RSS')

    def test_incomplete_measurement_count_fails(self):
        def truncated(result):
            dropped = rows(result, 1).pop()
            result['samples'] = [s for s in result['samples'] if s not in dropped.values()]
            result['completedCycles'] = 119
        self.assertFails(truncated, 'cycles missing')

    def test_missing_cycle_fails(self):
        self.assertFails(lambda r: rows(r).pop(25), 'cycles missing')

    def test_missing_observation_fails(self):
        self.assertFails(lambda r: rows(r)[3].pop('closed'), 'observation missing')
        self.assertFails(lambda r: rows(r)[19].pop(evidence.SETTLED), 'observation missing')

    def test_duplicate_observation_fails(self):
        self.assertFails(lambda r: rows(r)[4].update(opened=rows(r)[4]['before']), 'duplicated or reordered')
        self.assertFails(lambda r: rows(r).insert(5, copy.deepcopy(rows(r)[4])), 'cycles missing')

    def test_reordered_observations_fail(self):
        def swap(result):
            row = rows(result)[2]; row['before'], row['opened'] = row['opened'], row['before']
        self.assertFails(swap)

    def test_unexpected_observation_fails(self):
        self.assertFails(lambda r: rows(r)[2].update(closedAfter10s=point(999, evidence.DOCUMENTS[0], True)), 'unexpected observations')

    def test_observation_bound_to_other_session_or_document_fails(self):
        self.assertFails(lambda r: rows(r)[1]['closed'].update(sessionId='other'), 'document/session')
        self.assertFails(lambda r: rows(r)[1]['closed'].update(doc=evidence.DOCUMENTS[1]), 'document/session')

    def test_incomplete_cleanup_fails(self):
        self.assertFails(lambda r: rows(r)[7]['closed'].update(owners=[{'id': 3}]), 'retained')
        self.assertFails(lambda r: rows(r)[7]['closed'].update(canvasCount=1), 'retained')
        self.assertFails(lambda r: rows(r)[7]['closed']['renderer'].update(subscribers=1), 'retained')
        self.assertFails(lambda r: rows(r)[7]['closed']['renderer']['jobs'].update(backupImageDataBytes=4), 'unreleased')
        self.assertFails(lambda r: rows(r)[7]['closed']['renderer']['jobs'].update(expiryTimerActive=None), 'expiry timer')
        self.assertFails(lambda r: rows(r)[7]['closed']['renderer']['cache']['decoded'].update(pendingEntries=1), 'pending/transient')

    def test_missing_budget_field_fails(self):
        self.assertFails(lambda r: rows(r)[0]['opened']['renderer']['jobs'].pop('maxOwnedBytes'), 'job budget')
        self.assertFails(lambda r: rows(r)[0]['opened']['renderer']['jobs'].pop('temporaryCanvasBytes'), 'job counters')
        self.assertFails(lambda r: rows(r)[0]['opened']['renderer']['cache']['decoded'].pop('maxEntries'), 'decoded cache')
        self.assertFails(lambda r: rows(r)[0]['opened']['renderer']['cache'].pop('images'), 'images cache')

    def test_changed_budget_cannot_hide_growth(self):
        def inflate(result):
            cache = rows(result)[0]['opened']['renderer']['cache']['decoded']; cache.update(maxBytes=1 << 40, bytes=300 * MIB)
        self.assertFails(inflate, 'decoded cache budget')

    def test_exceeded_declared_bound_fails(self):
        self.assertFails(lambda r: rows(r)[0]['opened']['renderer']['jobs'].update(ownedEstimatedBytes=257 * MIB), 'job bound')
        self.assertFails(lambda r: rows(r)[0]['opened']['renderer']['cache']['decoded'].update(bytes=257 * MIB), 'decoded cache bound exceeded')

    def test_reported_cycle_count_must_match_rows(self):
        self.assertFails(lambda r: r.update(completedCycles=121), 'completed cycles')

    def test_orphan_detached_canvas_fails(self):
        self.assertFails(lambda r: rows(r)[10]['closed']['engineSurfaces'].update(detachedCanvases=3, canvasCount=3), 'not accounted')
        self.assertFails(lambda r: rows(r)[10]['closed'].update(engineSurfaces=None), 'surface observation missing')

    def test_cycle_gate_failure_or_absence_fails(self):
        self.assertFails(lambda r: r['gates'][0].update(result='FAIL'), 'cycle cleanup gates')
        self.assertFails(lambda r: r.update(gates=[]), 'cycle cleanup gates')

    def test_run_cleanup_and_identity_required(self):
        self.assertFails(lambda r: r['cleanup'].update(displayTerminated=False), 'run cleanup')
        self.assertFails(lambda r: r.update(engineIdentityAtEnd=None), 'engineIdentityAtEnd')
        self.assertFails(lambda r: r.update(error='RemoteDisconnected'), 'run error')

    def independent(self, change):
        result = detached_samples(complete())
        self.assertEqual(evidence.classify(result, WASM)['status'], 'PASS')
        change(result)
        return evidence.classify(result, WASM)

    def assertIndependentFails(self, change, text):
        verdict = self.independent(change)
        self.assertEqual(verdict['status'], 'FAIL')
        self.assertTrue(any(text in f for f in verdict['failures']), verdict['failures'][:5])

    def test_durable_sample_changed_alone_fails(self):
        def rss(result):
            result['samples'][10]['processes'][0]['rssBytes'] += 1; result['samples'][10]['aggregateRssBytes'] += 1
        self.assertIndependentFails(rss, 'durable sample 10 differs')
        self.assertIndependentFails(lambda r: r['samples'][44]['renderer']['jobs'].update(uniqueResourceCount=7), 'durable sample 44 differs')
        self.assertIndependentFails(lambda r: r['samples'][5]['engineSurfaces'].update(externrefSlots=2000), 'durable sample 5 differs')
        self.assertIndependentFails(lambda r: r['samples'][7].update(wasmBytes=1 << 30), 'durable sample 7 differs')

    def test_lifecycle_row_changed_alone_fails(self):
        def rss(result):
            point = rows(result)[3]['closed']; point['processes'][0]['rssBytes'] += 1; point['aggregateRssBytes'] += 1
        self.assertIndependentFails(rss, 'differs from')
        self.assertIndependentFails(lambda r: rows(r, 1)[0]['opened']['renderer']['cache']['decoded'].update(hits=5), 'differs from')

    def test_process_identity_replaced_in_one_representation_fails(self):
        self.assertIndependentFails(lambda r: r['samples'][100]['processes'][0].update(pid=9999), 'durable sample 100 differs')
        self.assertIndependentFails(lambda r: rows(r)[30]['opened']['processes'][0].update(startTime=5), 'differs from')

    def test_sample_stream_missing_duplicated_or_reordered_fails(self):
        self.assertIndependentFails(lambda r: r['samples'].pop(), 'durable samples 365 != lifecycle observations 366')
        self.assertIndependentFails(lambda r: r['samples'].insert(3, copy.deepcopy(r['samples'][3])), 'durable samples 367')
        def swap(result):
            a, b = result['samples'][19], result['samples'][20]  # opened/closed of one cycle
            a['sequence'], b['sequence'] = 20, 19; result['samples'][19], result['samples'][20] = b, a
        self.assertIndependentFails(swap, 'differs from')

    def test_sample_document_or_session_association_alone_fails(self):
        self.assertIndependentFails(lambda r: r['samples'][2].update(doc=evidence.DOCUMENTS[1]), 'durable sample 2 differs')
        self.assertIndependentFails(lambda r: r['samples'][2].update(sessionId='other'), 'durable sample 2 differs')

    def test_gate_missing_duplicated_or_displaced_fails(self):
        self.assertIndependentFails(lambda r: r['gates'].pop(10), 'gates != expected')
        self.assertIndependentFails(lambda r: r['gates'].insert(10, dict(r['gates'][10])), 'gates != expected')
        self.assertIndependentFails(lambda r: r['gates'].insert(4, r['gates'].pop(5)), 'displaced')
        self.assertIndependentFails(lambda r: r['gates'].insert(60, r['gates'].pop(61)), 'displaced')
        self.assertIndependentFails(lambda r: r['gates'][60].update(item='other: summary'), 'summary gate')

    def test_gate_cannot_vouch_for_another_cycle(self):
        self.assertIndependentFails(lambda r: r['gates'][7]['association'].update(afterSequence=r['gates'][8]['association']['afterSequence']), 'does not identify')
        self.assertIndependentFails(lambda r: r['gates'][7]['association'].update(doc=evidence.DOCUMENTS[1]), 'does not identify')
        self.assertIndependentFails(lambda r: r['gates'][7]['association'].update(sessionId='other'), 'does not identify')
        self.assertIndependentFails(lambda r: r['gates'][7].update(item='openClose cycle8: cleanup'), 'displaced')

    def test_gate_result_must_agree_with_recorded_closed_observation(self):
        self.assertIndependentFails(lambda r: r['gates'][3].update(result='FAIL'), 'disagrees')
        def dirty_but_pass(result):
            for point in (rows(result)[3]['closed'], result['samples'][rows(result)[3]['closed']['sequence']]): point['canvasCount'] = 1
        self.assertIndependentFails(dirty_but_pass, 'disagrees')

    def test_unassociated_gates_are_inconclusive_not_pass(self):
        def historical(result):
            for gate in result['gates']: gate.pop('association')
        verdict = self.independent(historical)
        self.assertEqual(verdict['status'], 'INCONCLUSIVE')
        self.assertEqual(verdict['failures'], [])
        self.assertIndependentFails(lambda r: r['gates'][9].pop('association'), 'only some gates')

    def test_driver_reads_process_generation(self):
        spec = importlib.util.spec_from_file_location('lifecycle_driver', Path(__file__).with_name('lifecycle-continuous-native.py'))
        driver = importlib.util.module_from_spec(spec); spec.loader.exec_module(driver)
        own = driver.start_time(os.getpid())
        self.assertTrue(type(own) is int and own > 0)
        self.assertEqual(driver.start_time(os.getpid()), own)
        self.assertIsNone(driver.start_time(2 ** 31))


if __name__ == '__main__':
    unittest.main()
