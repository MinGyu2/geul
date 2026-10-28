"""lease_verdict unit tests (run directly: python3 -I test_lease_verdict.py).

The positive case re-evaluates the committed native attempt 7 raw result; negative cases mutate a copy.
"""
import copy, json, sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lease_verdict as v

RAW = HERE.parents[0] / 'evidence/t010-native-lease-ownership/native-attempt7.json'


def native():
    return json.loads(RAW.read_text())


def run(r):
    return v.evaluate(r['steps'], r['outcomes'], r['comparisons'])


class LeaseVerdictTest(unittest.TestCase):
    def test_empty_fails_closed(self):
        e = v.evaluate({}, {}, {})
        self.assertTrue(e['checks']); self.assertFalse(any(e['checks'].values()))
        self.assertEqual(set(e['coverage'].values()), {'NOT EXERCISED'})

    def test_native_attempt_reevaluates(self):
        r = native(); e = run(r)
        self.assertEqual({k for k, ok in e['checks'].items() if not ok}, set())
        self.assertEqual(e['accountingErrors'], {})
        self.assertEqual(e['coverage'], {'residentEvictionWhileLeased': 'NOT EXERCISED', 'cacheNonAdmissionWhileLeased': 'VERIFIED',
                                         'decodedResidentEvictionWhileLeased': 'VERIFIED'})
        self.assertTrue(e['sharedBacking']['shared'])
        self.assertEqual(r['leaseVerdict']['checks'], e['checks'])

    def test_pixel_difference_fails(self):
        for label, check in (('y1-vs-ref', 'completedPixelsExact'), ('e1-vs-ref', 'decodedLeaseSurvivesEviction'),
                             ('x3-vs-ref', 'leaseSurvivesCachePressure')):
            r = native(); r['comparisons'][label]['channelDifferences'] = 1
            self.assertFalse(run(r)['checks'][check], label)
        r = native(); r['comparisons']['app-visible']['pixels'] = 3
        self.assertFalse(run(r)['checks']['appVisibleFrameExact'])
        r = native(); r['comparisons']['y1-vs-ref']['nonWhitePixels'] = 0  # blank frames never match as proof
        self.assertFalse(run(r)['checks']['completedPixelsExact'])

    def test_exact_pixel_fields_reject_invalid_types(self):
        missing = object()
        for value in (False, True, 0.0, "0", missing, None, {}):
            for container, label, field, check in (
                ('comparisons', 'y1-vs-ref', 'channelDifferences', 'completedPixelsExact'),
                ('comparisons', 'y1-vs-ref', 'nonWhitePixels', 'completedPixelsExact'),
                ('comparisons', 'app-visible', 'pixels', 'appVisibleFrameExact'),
                ('steps', 'app-stale-poll', 'channelDifferences', 'appStaleJobCanceledAfterNewRevision'),
            ):
                r = native(); row = r[container][label]
                if value is missing: row.pop(field, None)
                else: row[field] = value
                self.assertFalse(run(r)['checks'][check], (label, field, value))
        for label, check in (('y1-vs-ref', 'completedPixelsExact'), ('app-visible', 'appVisibleFrameExact')):
            r = native(); r['comparisons'][label] = []
            self.assertFalse(run(r)['checks'][check], label)

    def test_missing_step_or_outcome_fails(self):
        for label, check in (('cancel-X', 'cancelReleasesOnlyOwnLeases'), ('E-evict', 'decodedLeaseSurvivesEviction'),
                             ('app-late', 'appCloseWithPendingLease'), ('late-after-free', 'lateLoadsAfterFreeHarmless')):
            r = native(); del r['steps'][label]; r['outcomes'].pop(label, None)
            self.assertFalse(run(r)['checks'][check], label)
        r = native(); r['outcomes']['app-stale-poll'] = 'COMPLETE'
        self.assertFalse(run(r)['checks']['appStaleJobCanceledAfterNewRevision'])

    def test_lease_not_released_fails(self):
        r = native(); r['steps']['free:Y']['jobs']['activeLeaseCount'] = 1
        self.assertFalse(run(r)['checks']['freeWithPendingReleases'])
        r = native(); r['steps']['P-cancel']['jobs']['decodedLedger']['jobLeaseReferences'] = 1
        self.assertFalse(run(r)['checks']['decodedCancelReleases'])
        r = native(); r['steps']['E-evict']['cache']['decoded']['evictions'] = r['steps']['E-acquire']['cache']['decoded']['evictions']
        self.assertFalse(run(r)['checks']['decodedLeaseSurvivesEviction'])

    def test_accounting_invariants(self):
        base = native()['steps']['E-evict']
        self.assertEqual(v.accounting_errors(base), [])
        cases = [
            (lambda r: r['jobs'].update(readyLeaseCount=r['jobs']['activeLeaseCount'] + 1), 'ready > active leases'),
            (lambda r: r['jobs']['decodedLedger'].update(created=r['jobs']['decodedLedger']['created'] + 1), 'ledger created - disposed != unique'),
            (lambda r: r['jobs']['decodedLedger'].update(nonresidentCount=0), 'ledger resident + nonresident != unique'),
            (lambda r: r['jobs'].update(activeJobs=0), 'decoded leases without an active job'),
            (lambda r: r['cache']['decoded'].update(bytes=r['cache']['decoded']['maxBytes'] + 1), 'decoded cache bytes > budget'),
            (lambda r: r['jobs'].update(pendingCount=True), 'jobs.pendingCount'),
            (lambda r: r['jobs'].update(activeLeaseCount=1.0), 'jobs.activeLeaseCount'),
            (lambda r: r['jobs'].pop('decodedLedger'), 'jobs.decodedLedger'),
        ]
        for mutate, expected in cases:
            row = copy.deepcopy(base); mutate(row)
            self.assertIn(expected, v.accounting_errors(row), expected)
        r = native(); r['steps']['E-evict'] = row
        self.assertFalse(run(r)['checks']['accountingInvariants'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
