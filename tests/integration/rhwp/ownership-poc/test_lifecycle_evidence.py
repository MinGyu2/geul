"""Fail-closed lifecycle evidence classification with synthetic complete/broken results (no native run)."""
import copy
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
                rows.append(row); gates.append({'gate': 'D4', 'result': 'PASS'})
        lifecycle.append({'sample': doc, 'cyclesPerMode': evidence.CYCLES, 'rows': rows})
        gates.append({'gate': 'D4', 'result': 'INCONCLUSIVE'})
    return {'sessionId': 's-1', 'engineIdentity': {'wasmSha256': WASM}, 'engineIdentityAtEnd': {'wasmSha256': WASM},
            'processesAtStart': [{'pid': 7, 'comm': 'geul', 'startTime': 9}, {'comm': evidence.WEBPROCESS_COMM, **PROCESS}],
            'samples': samples, 'measurements': {'lifecycle': lifecycle}, 'gates': gates, 'completedCycles': evidence.EXPECTED_CYCLES,
            'cleanup': dict.fromkeys(evidence.CLEANUP_STEPS, True)}


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

    def test_driver_reads_process_generation(self):
        spec = importlib.util.spec_from_file_location('lifecycle_driver', Path(__file__).with_name('lifecycle-continuous-native.py'))
        driver = importlib.util.module_from_spec(spec); spec.loader.exec_module(driver)
        own = driver.start_time(os.getpid())
        self.assertTrue(type(own) is int and own > 0)
        self.assertEqual(driver.start_time(os.getpid()), own)
        self.assertIsNone(driver.start_time(2 ** 31))


if __name__ == '__main__':
    unittest.main()
