"""역사적 수치에서 만든 통제 입력. 새 브라우저 실행이나 native 승인 증거가 아니다."""
import copy
import json
from pathlib import Path
import unittest
from validation import validate_run, validate_identity

ROOT = Path(__file__).resolve().parents[4]
HISTORICAL = ROOT / 'tests/integration/rhwp/evidence/t010-render-preparation-runtime-hardening/browser/hardening-after-chrome.json'


def sample():
    value = json.loads(HISTORICAL.read_text())['run']
    value.update(schema=2, contract='t010-preparation-hardening-2')
    for row in value['cases']:
        row['terminalPolls'] = [row['outcome']] * 3
        # Test-only digest; no claim about actual historical frame hashes.
        row['frameBefore'] = {'width': 40, 'height': 40, 'sha256': '0' * 64}
        row['frameAfter'] = dict(row['frameBefore'])
    value['tests'][0]['row'] = copy.deepcopy(value['cases'][0])
    stats = copy.deepcopy(value['tests'][9]['stats'])
    value['terminalCases'] = []
    for label in ('cancel-late-decode-error', 'close-pending-image', 'preparation-resource-revocation'):
        revoked = label == 'preparation-resource-revocation'
        snapshot = copy.deepcopy(stats)
        snapshot['resourceLimits'] = 2 if revoked else 1
        snapshot['cancellations'] = 1 if label.startswith('cancel') else 2
        if label.startswith('cancel'):
            snapshot['preparation']['jobs'] = [copy.deepcopy(value['cases'][1]['job'])]
        row = {'label': label, 'initial': 'PENDING', 'pendingBefore': 1, 'unchanged': True,
               'outcomes': ['RESOURCE_LIMIT'] * 3 if revoked else [] if label.startswith('close') else ['CANCELED'] * 3,
               'stats': snapshot}
        if revoked:
            row.update(outcome='RESOURCE_LIMIT', revocations=1, job=copy.deepcopy(value['cases'][1]['job']))
        value['terminalCases'].append(row)
    return value


class ValidationTests(unittest.TestCase):
    def reject(self, mutate):
        value = sample()
        mutate(value)
        with self.assertRaises(ValueError): validate_run(value)
    def test_valid_numeric_fixture(self): validate_run(sample())
    def test_decode(self): self.reject(lambda v: v['cases'][1]['job'].update(decodeAttempts=1))
    def test_outcome(self): self.reject(lambda v: v['cases'][1].update(outcome='ERROR'))
    def test_replay(self): self.reject(lambda v: v['cases'][1]['job'].update(replays=1))
    def test_memory(self): self.reject(lambda v: v['cases'][1].update(peakBytes=(32 << 20) + 1))
    def test_cleanup(self): self.reject(lambda v: v['tests'][9]['stats']['decodedLedger'].update(uniqueBytes=1))
    def test_missing_case(self): self.reject(lambda v: v['cases'].pop())
    def test_missing_test(self): self.reject(lambda v: v['tests'].pop())
    def test_duplicate_test(self): self.reject(lambda v: v['tests'].__setitem__(1, copy.deepcopy(v['tests'][0])))
    def test_missing_field(self): self.reject(lambda v: v['cases'][1]['job'].pop('decodeAttempts'))
    def test_invalid_counters(self):
        for bad in (True, False, 0.0, -1, float('nan'), float('inf'), None, '0'):
            with self.subTest(bad=bad): self.reject(lambda v: v['cases'][1]['job'].update(decodeAttempts=bad))
    def test_invalid_nested_counter(self): self.reject(lambda v: v['tests'][5]['job'].update(decodeAttempts=False))
    def test_invalid_cleanup_counter(self): self.reject(lambda v: v['tests'][9]['stats'].update(activeJobs=False))
    def test_late_terminal(self): self.reject(lambda v: v['cases'][1].update(terminalPolls=['RESOURCE_LIMIT', 'ERROR', 'COMPLETE']))
    def test_frame_digest(self): self.reject(lambda v: v['cases'][1]['frameAfter'].update(sha256='1' * 64))
    def test_boolean_pixel_claim_insufficient(self): self.reject(lambda v: v['cases'][1].pop('frameBefore'))
    def test_nested_inconsistent(self): self.reject(lambda v: v['tests'][3].update(outcome='ERROR'))
    def test_cleanup_disposed_twice(self): self.reject(lambda v: v['tests'][9]['stats']['decodedLedger'].update(disposed=2))
    def test_historical_schema_is_not_relabelled(self):
        with self.assertRaises(ValueError): validate_run(json.loads(HISTORICAL.read_text())['run'])
    def test_identity(self):
        before = {'candidate/' + n: str(i) * 64 for i, n in enumerate(('rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts'), 1)}
        identity = {n: before['candidate/' + n] for n in ('rhwp.js', 'rhwp_bg.wasm')}
        identity['ENGINE.json'] = {'baseline': '1a76570e833917d15817415a53c09ad61ab3203f', 'preparationDefaultEnabled': False, 'buildStatus': 'PASS', 'sourceStableDuringBuild': True,
                                   'artifacts': {n.split('/')[1]: h for n, h in before.items()}}
        validate_identity(identity, before, before)
        forged = copy.deepcopy(identity); forged['rhwp_bg.wasm'] = 'f' * 64
        with self.assertRaises(ValueError): validate_identity(forged, before, before)
        forged = copy.deepcopy(identity); forged['ENGINE.json']['artifacts']['rhwp.js'] = 'e' * 64
        with self.assertRaises(ValueError): validate_identity(forged, before, before)
        with self.assertRaises(ValueError): validate_identity(identity, before, {**before, 'x': 'a' * 64})


if __name__ == '__main__': unittest.main()
