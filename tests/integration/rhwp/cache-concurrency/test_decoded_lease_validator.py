"""Adversarial mutations of genuine decoded-lease browser results (no browser required).

Each mutation of a recorded successful run must be rejected by decoded_lease_run.validate, so a
PASS cannot be produced by an incomplete, duplicated, misattributed or numerically inconsistent
result. The unmodified genuine results must still validate.
"""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent / 'evidence'
GENUINE = {
    # Previous evidence (contract 1, 32 tests / 43 checkpoints per browser); never rewritten.
    1: [EVIDENCE / 't010-decoded-resource-lease-accounting/browser' / f'decoded-lease-{b}.json' for b in ('chrome', 'webkit')],
    # Hardening candidate and the finalization candidate (contract 2; the latter reports dimensionMismatches).
    2: [EVIDENCE / directory / 'browser' / f'decoded-lease-{b}.json'
        for directory in ('t010-decoded-lease-accounting-hardening', 't010-decoded-lease-contract-finalization')
        for b in ('chrome', 'webkit')],
}

spec = importlib.util.spec_from_file_location('decoded_lease_run', HERE / 'decoded_lease_run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def genuine(contract, index=0):
    return json.loads(GENUINE[contract][index].read_text())['run']


def point(value, label):
    return next(p for p in value['ledger'] if p['label'] == 'candidate:' + label)


def set_ledger(p, name, number):
    p['decodedLedger'][name] = number
    p['jobs']['decodedLedger'][name] = number


class GenuineResults(unittest.TestCase):
    def test_every_genuine_result_validates_under_its_contract(self):
        for contract, paths in GENUINE.items():
            for path in paths:
                with self.subTest(path=path.name, contract=contract):
                    value = json.loads(path.read_text())
                    self.assertEqual(value['status'], 'PASS')
                    runner.validate(value['run'], contract)
                    self.assertEqual(runner.outcome(value['run'], contract), 'PASS')

    def test_contract_counts_match_recorded_baselines(self):
        # Comparison baselines, not limits: historical runs had 32 tests and 43 checkpoints.
        self.assertEqual(len(runner.CONTRACTS[1]['baseline']) + len(runner.CONTRACTS[1]['candidate']), 32)
        self.assertEqual(len(genuine(1)['ledger']), 43)
        self.assertGreater(len(runner.CONTRACTS[2]['candidate']), len(runner.CONTRACTS[1]['candidate']))

    def test_historical_result_cannot_satisfy_the_current_contract(self):
        with self.assertRaises(runner.Invalid):
            runner.validate(genuine(1), runner.CURRENT_CONTRACT)

    def test_fail_result_is_never_pass(self):
        value = genuine(2)
        value['status'] = 'FAIL'
        self.assertEqual(runner.outcome(value), 'FAIL')


class Mutations(unittest.TestCase):
    """Each mutation starts from a genuine result and must be rejected."""

    def rejects(self, mutate, contract=runner.CURRENT_CONTRACT):
        for index in range(len(GENUINE[contract])):
            value = copy.deepcopy(genuine(contract, index))
            mutate(value)
            with self.assertRaises(runner.Invalid, msg=mutate.__doc__):
                runner.outcome(value, contract)

    def test_structure(self):
        cases = [
            lambda v: v.update(ledger=[]),
            lambda v: v.pop('ledger'),
            lambda v: v.update(ledger={}),
            lambda v: v.update(tests=[]),
            lambda v: v.pop('tests'),
            lambda v: v.update(schema=2),
            lambda v: v.update(status='pass'),
            lambda v: v.update(error='late failure'),
            lambda v: v.pop('transitions'),
            lambda v: v['transitions'].pop(),
            lambda v: v['transitions'][1]['cleanup']['jobs'].update(activeJobs=1),
            lambda v: v.update(contract=1),
        ]
        for case in cases:
            self.rejects(case)

    def test_missing_final_checkpoint(self):
        self.rejects(lambda v: v['ledger'].pop())
        self.rejects(lambda v: v['ledger'].insert(0, v['ledger'].pop()))

    def test_missing_duplicate_unexpected_or_misattributed_tests(self):
        cases = [
            lambda v: v['tests'].pop(3),
            lambda v: v['tests'].insert(10, copy.deepcopy(v['tests'][10])),
            lambda v: v['tests'].append({**v['tests'][-1], 'name': 'invented-check'}),
            lambda v: v['tests'][0].update(arm='candidate'),
            lambda v: v['tests'][-1].update(arm='baseline'),
            lambda v: v['tests'][7].update(arm='other'),
            lambda v: v['tests'][7].pop('arm'),
            lambda v: v['tests'][7].update(name=None),
            lambda v: v['tests'].reverse(),
            lambda v: v['tests'].__setitem__(slice(8, 10), v['tests'][8:10][::-1]),
            # Baseline arm absent entirely (candidate-only result).
            lambda v: v.update(tests=[t for t in v['tests'] if t['arm'] == 'candidate']),
        ]
        for case in cases:
            self.rejects(case)

    def test_status_representations(self):
        for status in ('pass', 'FAIL', True, 1, None, 'PASS '):
            self.rejects(lambda v, s=status: v['tests'][5].update(status=s))

    def test_checkpoint_identity_and_order(self):
        cases = [
            lambda v: v['ledger'].remove(point(v, 's1-pending')),
            lambda v: v['ledger'].insert(5, copy.deepcopy(v['ledger'][5])),
            lambda v: v['ledger'][2].update(label='baseline:s0-1'),
            lambda v: v['ledger'][2].update(label=7),
            lambda v: v['ledger'].insert(len(v['ledger']) - 1, v['ledger'].pop(4)),
            lambda v: v['ledger'][3].update(extra=True),
        ]
        for case in cases:
            self.rejects(case)

    def test_budget_and_limit_fields(self):
        cases = [
            lambda v: point(v, 's2-pending')['decodedLedger'].pop('maxNonresidentBytes'),
            lambda v: set_ledger(point(v, 's2-pending'), 'maxNonresidentBytes', 128 << 20),
            lambda v: point(v, 's2-pending')['jobs'].update(maxPending=3),
            lambda v: point(v, 's2-pending')['jobs'].pop('maxOwnedBytes'),
            lambda v: point(v, 's5b-pending')['jobs'].update(maxFrameBytes=128 << 20),
            lambda v: set_ledger(point(v, 's5b-pending'), 'nonresidentBytes', (96 << 20) + 4),
            lambda v: set_ledger(point(v, 's1-pending'), 'reservedBytes', 16),
            lambda v: set_ledger(point(v, 's1-pending'), 'accountingErrors', 1),
        ]
        for case in cases:
            self.rejects(case)

    def test_inconsistent_accounting_totals(self):
        cases = [
            lambda v: set_ledger(point(v, 's1-evicted'), 'residentBytes', point(v, 's1-evicted')['decodedLedger']['residentBytes'] + 4),
            lambda v: set_ledger(point(v, 's1-evicted'), 'uniqueBytes', point(v, 's1-evicted')['decodedLedger']['uniqueBytes'] - 4),
            lambda v: set_ledger(point(v, 's1-evicted'), 'nonresidentCount', point(v, 's1-evicted')['decodedLedger']['nonresidentCount'] + 1),
            lambda v: set_ledger(point(v, 's3-shared'), 'created', point(v, 's3-shared')['decodedLedger']['created'] + 1),
            # Copy in the job statistics disagrees with the recorded ledger.
            lambda v: point(v, 's3-shared')['jobs']['decodedLedger'].update(uniqueBytes=1),
        ]
        for case in cases:
            self.rejects(case)

    def test_types(self):
        cases = [
            lambda v: set_ledger(point(v, 's0-after'), 'accountingErrors', False),
            lambda v: set_ledger(point(v, 's0-after'), 'uniqueBytes', '0'),
            lambda v: set_ledger(point(v, 's0-after'), 'uniqueBytes', 0.0),
            lambda v: set_ledger(point(v, 's0-after'), 'created', -1),
            lambda v: point(v, 's0-after').update(decodedLedger=None),
            lambda v: point(v, 's0-after').update(jobs=[]),
            lambda v: point(v, 's0-after')['jobs'].update(activeJobs=True),
            lambda v: v['ledger'].__setitem__(0, 'candidate:s0-before'),
        ]
        for case in cases:
            self.rejects(case)

    def test_incorrect_cleanup_counters(self):
        cases = [
            lambda v: set_ledger(point(v, 'final'), 'disposed', point(v, 'final')['decodedLedger']['disposed'] - 1),
            lambda v: (set_ledger(point(v, 'final'), 'uniqueBytes', 4), set_ledger(point(v, 'final'), 'nonresidentBytes', 4),
                       set_ledger(point(v, 'final'), 'uniqueCount', 1), set_ledger(point(v, 'final'), 'nonresidentCount', 1),
                       set_ledger(point(v, 'final'), 'created', point(v, 'final')['decodedLedger']['created'] + 1)),
            lambda v: set_ledger(point(v, 'final'), 'jobLeaseReferences', 1),
            lambda v: point(v, 'final')['jobs'].update(activeJobs=1),
            lambda v: point(v, 'final')['jobs'].update(ownedEstimatedBytes=64),
            lambda v: point(v, 'final')['jobs'].update(decodedRegistryEntries=1),
            lambda v: point(v, 'final')['jobs'].update(maxJobLeaseEntries=2),
            # A final checkpoint that never created anything proves nothing.
            lambda v: (set_ledger(point(v, 'final'), 'created', 0), set_ledger(point(v, 'final'), 'disposed', 0)),
        ]
        for case in cases:
            self.rejects(case)

    def test_metadata_bounds(self):
        cases = [
            lambda v: point(v, 's7-a-pending')['jobs'].update(maxJobLeaseEntries=257),
            lambda v: point(v, 's7-a-pending')['jobs'].update(maxJobDecodedLeases=1 << 20),
            lambda v: point(v, 's7-a-pending')['jobs'].pop('decodedRegistryEntries'),
            lambda v: set_ledger(point(v, 's7-b-pending'), 'jobLeaseReferences', 8 * 256 + 1),
            lambda v: set_ledger(point(v, 's9-after'), 'rejectedCommits', 1),
            lambda v: set_ledger(point(v, 's9-after'), 'preallocationRejections', 1),
        ]
        for case in cases:
            self.rejects(case)

    def test_historical_contract_mutations(self):
        for case in (lambda v: v.update(ledger=[]), lambda v: v['ledger'].pop(), lambda v: v['tests'].pop(0),
                     lambda v: v['tests'].append(copy.deepcopy(v['tests'][-1])),
                     lambda v: set_ledger(point(v, 'final'), 'uniqueBytes', 4)):
            self.rejects(case, contract=1)



INVALID_VERSIONS = (True, False, 1.0, 2.0, '1', '2', None, [], {}, -1, 0, 3)


class VersionTyping(unittest.TestCase):
    """schema/contract are exact ints: Python's True == 1 and 2.0 == 2 must not produce PASS."""

    def check(self, value, contract):
        with self.assertRaises(runner.Invalid):
            runner.outcome(value, contract)

    def test_invalid_schema_values(self):
        for contract in (1, 2):
            for index in range(len(GENUINE[contract])):
                for bad in INVALID_VERSIONS:
                    with self.subTest(contract=contract, index=index, schema=bad):
                        value = copy.deepcopy(genuine(contract, index))
                        value['schema'] = bad
                        self.check(value, contract)
                value = copy.deepcopy(genuine(contract, index))
                del value['schema']
                self.check(value, contract)

    def test_invalid_schema_is_rejected_even_for_a_fail_result(self):
        for bad in (True, 1.0, '1', None):
            value = copy.deepcopy(genuine(2))
            value.update(status='FAIL', schema=bad)
            self.check(value, 2)

    def test_invalid_contract_values_under_contract_2(self):
        for index in range(len(GENUINE[2])):
            for bad in INVALID_VERSIONS + (1,):
                with self.subTest(index=index, contract=bad):
                    value = copy.deepcopy(genuine(2, index))
                    value['contract'] = bad
                    self.check(value, 2)
            value = copy.deepcopy(genuine(2, index))
            del value['contract']
            self.check(value, 2)

    def test_contract_1_compatibility_is_explicit(self):
        for index in range(len(GENUINE[1])):
            value = genuine(1, index)
            self.assertNotIn('contract', value, 'historical contract-1 evidence omits the field')
            self.assertEqual(runner.outcome(copy.deepcopy(value), 1), 'PASS')
            explicit = copy.deepcopy(value)
            explicit['contract'] = 1
            self.assertEqual(runner.outcome(explicit, 1), 'PASS')
            for bad in (True, 1.0, '1', None, [], {}, 2):
                with self.subTest(index=index, contract=bad):
                    mutated = copy.deepcopy(value)
                    mutated['contract'] = bad
                    self.check(mutated, 1)
            # Omission never falls back to contract 1 during current validation.
            self.check(copy.deepcopy(value), 2)

    def test_validation_contract_argument_is_exact(self):
        for bad in (True, 2.0, '2', None, 3):
            with self.assertRaises(runner.Invalid):
                runner.outcome(copy.deepcopy(genuine(2)), bad)

    def test_dimension_mismatch_counter_when_reported(self):
        def report(number):
            value = copy.deepcopy(genuine(2))
            for p in value['ledger']:
                set_ledger(p, 'dimensionMismatches', number)
            value['transitions'][1]['cleanup']['jobs'] = value['ledger'][-1]['jobs']
            return value
        self.assertEqual(runner.outcome(report(0), 2), 'PASS')
        for bad in (1, False, 0.0, '0', None):
            with self.subTest(dimensionMismatches=bad):
                self.check(report(bad), 2)

if __name__ == '__main__':
    unittest.main()
