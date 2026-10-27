"""Controlled schema mutations; these are not engine performance measurements."""
import copy
import importlib.util
from pathlib import Path
import unittest

_spec = importlib.util.spec_from_file_location('engine_phase_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


def valid():
    result = {'status': 'DIAGNOSTIC_COMPLETE', 'official': False, 'rows': [], 'cleanup': {}}
    for sample, pages in [('basic-ko.hwp', [0]), ('basic-ko.hwpx', [0]),
                          ('chemical.hwp', [0, 14, 15, 16, 19, 20, 21, 23]), ('asset.hwpx', [0])]:
        for page in pages:
            for trial in range(3):
                arm = {'outcome': 'COMPLETE', 'traceComplete': True, 'dropped': 0, 'polls': 1,
                       'ms': 1, 'queueMs': 0, 'afterPublicationRaf1Ms': 1, 'afterPublicationRaf2Ms': 1}
                row = {'sample': sample, 'page': page, 'trial': trial, 'exactRGBA': True,
                       'arms': {k: copy.deepcopy(arm) for k in ['baseline', 'off', 'on']}}
                row['arms']['on']['phases'] = [{'id': 1, 'parent': None, 'name': 'poll.total',
                    'at': 0, 'ms': 1, 'context': dict(sample=sample, page=page, trial=trial, arm='on')}]
                result['rows'].append(row)
    for arm in ['baseline', 'off', 'on']:
        result['cleanup'][arm] = {'jobs': dict(activeJobs=0, activeLeaseCount=0, ownedEstimatedBytes=0),
                                   'cache': {'decoded': {'bytes': 0}, 'images': {'bytes': 0}}}
    return result


class ValidationTests(unittest.TestCase):
    def test_controlled_complete_matrix(self):
        runner.validate(valid())

    def test_matrix_cleanup_pixels_and_completeness(self):
        for mutate in [lambda x: x['rows'].pop(), lambda x: x['cleanup'].pop('off'),
                       lambda x: x['rows'][0].update(exactRGBA=False),
                       lambda x: x['rows'][0]['arms']['on'].update(traceComplete=False),
                       lambda x: x['cleanup']['on']['jobs'].update(activeLeaseCount=1),
                       lambda x: x['rows'][0]['arms']['baseline'].update(ms=float('nan'))]:
            result = valid(); mutate(result)
            with self.assertRaises(ValueError): runner.validate(result)

    def test_span_context_parent_and_intervals(self):
        for mutate in [lambda p: p.update(parent=999), lambda p: p['context'].update(page=99),
                       lambda p: p.update(ms=-1), lambda p: p.update(name='other'),
                       lambda p: p.update(at=float('inf'))]:
            result = valid(); mutate(result['rows'][0]['arms']['on']['phases'][0])
            with self.assertRaises(ValueError): runner.validate(result)
        result = valid()
        child = copy.deepcopy(result['rows'][0]['arms']['on']['phases'][0])
        child.update(id=2, parent=1, at=2, name='child')
        result['rows'][0]['arms']['on']['phases'].append(child)
        with self.assertRaises(ValueError): runner.validate(result)


    def test_candidate_matrix_and_observed_execution_balance(self):
        result = valid(); config = {'arms': ['baseline', 'off', 'on', 'candidate'], 'trials': 8}
        first = [row for row in result['rows'] if row['trial'] == 0]
        result['rows'] = []
        for row in first:
            for trial in range(8):
                value = copy.deepcopy(row); value['trial'] = trial
                value['arms']['candidate'] = copy.deepcopy(value['arms']['baseline'])
                value['arms']['on']['phases'][0]['context']['trial'] = trial
                rotation = config['arms'][trial % 4:] + config['arms'][:trial % 4]
                value['armOrder'] = rotation if trial < 4 else list(reversed(rotation))
                result['rows'].append(value)
        result['cleanup']['candidate'] = copy.deepcopy(result['cleanup']['baseline'])
        runner.validate(result, config)
        result['rows'][0]['armOrder'] = result['rows'][1]['armOrder']
        with self.assertRaises(ValueError): runner.validate(result, config)


if __name__ == '__main__': unittest.main()
