import unittest
import ast
import copy
import json
import hashlib
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
from analyze import analyze, loads_strict, EvidenceIntegrityError, stats, union_ms

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]


class IntervalContract(unittest.TestCase):
    def test_nearest_rank_keeps_signed_anomalies(self):
        self.assertEqual(stats([-1, 0, 1])['min'], -1)
        self.assertEqual(stats(list(range(30)))['p95'], 28)

    def test_nested_and_overlapping_intervals_are_counted_once(self):
        self.assertEqual(union_ms([(0, 10), (2, 5), (8, 12), (20, 25)], 30), 17)

    def test_clip_only_for_measured_overlap_not_original_timestamps(self):
        spans = [(-1, 4), (9, 15)]
        self.assertEqual(union_ms(spans, 10), 5)
        self.assertEqual(spans, [(-1, 4), (9, 15)])


# Independent complete producer fixture: no native binaries, submodules or raw evidence.
def producer_fixture(group=40, undo=100):
    names = ['basic-ko.hwp', 'basic-ko.hwpx', '연구노트(화학).hwp',
             '3249937_asset_management_rules.hwpx']
    hashes = ['57c901cc394abf6f58f4838315d1ea2c5ecf8a03d9934d3fc098fd8be6e6e12f',
              '26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8',
              '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91',
              '97b5d6c571a6b7626321c6a53d797e3511978447497bb73309bd23eaa8e7ea77']
    data = dict(protocol='unmodified undo_native.scenario_perf/MEASURE', engine='candidate',
                rendererMode='candidate-full', historyEnabled=True, keyDelivery='native X11 xdotool',
                environment={'busyProbe': False, 'warmupGroups': 3, 'groupStartSamplesPerDocument': 30},
                engineIdentity={}, sourceSha256=hashes[-1],
                measurements={'perf': []}, gates=[], measurementComplete=True,
                # 합성 producer도 현재 source guard 계약을 만족해야 한다.
                # 이 해시는 fixture용이며 실제 source 신뢰의 증거가 아니다.
                sourceIdentityBefore={'fixture/frontend': 'a' * 64},
                sourceIdentityAfter={'fixture/frontend': 'a' * 64},
                sourceStableDuringRun=True)
    for name, digest, size in zip(names, hashes, [13312, 8064, 11956736, 423622]):
        row = dict(sample=name, sourceSha256=digest, fileBytes=size, warmupGroups=3, control='normal history',
                   busyProbe=False, timelineSamples=[])
        for kind, count, ms in [('groupStart',30,group), ('extend',30,20), ('undo',25,undo),
                                ('redo',20,100), ('afterUndo',5,30)]:
            row[kind] = dict(n=count, p50=ms, p95=ms, max=ms, timeouts=0)
            for _ in range(count):
                row['timelineSamples'].append(dict(kind=kind, keyToFrame=ms,
                    at=dict(key=0, input=-1 if kind=='groupStart' else 0,
                            handlerEnd=2 if kind in ('groupStart','extend','afterUndo') else None,
                            observed=ms-20, raf1=ms-10, end=ms),
                    calls={'saveSnapshot': dict(n=2, ms=8.0, firstAt=0)}, engineTimeline=[dict(name='saveSnapshot', at=0, ms=4),
                                             dict(name='saveSnapshot', at=2, ms=4)],
                    timeline=[], busy=None))
        data['measurements']['perf'].append(copy.deepcopy(row))
        suffix = '.hwpx' if name.endswith('.hwpx') else '.hwp'
        for kind, label, threshold in [('groupStart','group-start key→frame p95 ≤50ms',50),
                                       ('undo','Undo p95 ≤1500ms',1500)]:
            data['gates'].append(dict(gate='D4', item=f'{suffix}: {label}',
                result='PASS' if row[kind]['p95'] <= threshold else 'FAIL', detail=str(row[kind])))
    data['failedGateCount'] = sum(g['result']=='FAIL' for g in data['gates'])
    data['status'] = 'FAIL' if data['failedGateCount'] else 'PASS'
    data['exitReason'] = 'OFFICIAL_GATE_FAILURE' if data['failedGateCount'] else 'PASS'
    return data


def negative_cases():
    # Each fixture starts with the full, independent four-document producer schema.
    def row(d):
        return d['measurements']['perf'][0]
    def contradictory_fail(d):
        d.update(status='FAIL', failedGateCount=1, exitReason='OFFICIAL_GATE_FAILURE')
        d['gates'][0]['result'] = 'FAIL'
    return {
        'producer FAIL gate FAIL local PASS': contradictory_fail,
        'producer FAIL local PASS': lambda d: d.update(status='FAIL'),
        'producer PASS failed gate': lambda d: d['gates'][0].update(result='FAIL'),
        'producer PASS failure count': lambda d: d.update(failedGateCount=1),
        'producer FAIL inconsistent metadata': lambda d: d.update(status='FAIL', failedGateCount=1, exitReason='OFFICIAL_GATE_FAILURE'),
        'missing gates': lambda d: d.pop('gates'),
        'missing one gate': lambda d: d['gates'].pop(),
        'duplicate gate': lambda d: d['gates'].__setitem__(1, copy.deepcopy(d['gates'][0])),
        'malformed gate': lambda d: d['gates'].__setitem__(0, []),
        'missing gate verdict': lambda d: d['gates'][0].pop('result'),
        'invalid gate verdict': lambda d: d['gates'][0].update(result='INCONCLUSIVE'),
        'wrong gate detail': lambda d: d['gates'][0].update(detail="{'n': 0}"),
        'missing document': lambda d: d['measurements']['perf'].pop(),
        'duplicate document': lambda d: d['measurements']['perf'].__setitem__(1, copy.deepcopy(row(d))),
        'unexpected document': lambda d: row(d).update(sample='other.hwp'),
        'wrong source identity': lambda d: row(d).update(sourceSha256='0'*64),
        'incorrect sample count': lambda d: row(d)['timelineSamples'].pop(),
        'wrong category count': lambda d: row(d)['timelineSamples'][-1].update(kind='extend'),
        'reported count bool': lambda d: row(d)['groupStart'].update(n=True),
        'incorrect p50': lambda d: row(d)['groupStart'].update(p50=39),
        'incorrect p95': lambda d: row(d)['groupStart'].update(p95=39),
        'incorrect maximum': lambda d: row(d)['groupStart'].update(max=39),
        'nonzero timeout': lambda d: row(d)['groupStart'].update(timeouts=1),
        'timeout bool': lambda d: row(d)['redo'].update(timeouts=False),
        'missing completion': lambda d: d.pop('measurementComplete'),
        'wrong completion type': lambda d: d.update(measurementComplete=1),
        'incomplete measurement': lambda d: d.update(measurementComplete=False),
        'missing timelineSamples': lambda d: row(d).pop('timelineSamples'),
        'invalid timestamp': lambda d: row(d)['timelineSamples'][0]['at'].update(input='-1'),
        'invalid duration': lambda d: row(d)['timelineSamples'][0]['engineTimeline'][0].update(ms=True),
        'negative duration': lambda d: row(d)['timelineSamples'][0]['engineTimeline'][0].update(ms=-1),
        'non-finite number': lambda d: row(d)['timelineSamples'][0].update(keyToFrame=float('nan')),
        'non-finite diagnostic': lambda d: d['environment'].update(loadAverageBefore=[float('inf')]),
        'official timestamp mismatch': lambda d: row(d)['timelineSamples'][0]['at'].update(end=41),
        'RAF order mismatch': lambda d: row(d)['timelineSamples'][0]['at'].update(raf1=100),
        'missing handler end': lambda d: row(d)['timelineSamples'][0]['at'].update(handlerEnd=None),
        'unknown kind': lambda d: row(d)['timelineSamples'][0].update(kind=[]),
        'busy probe': lambda d: row(d).update(busyProbe=True),
        'control experiment': lambda d: row(d).update(control='injected capacity refusal'),
        'wrong warmup': lambda d: row(d).update(warmupGroups=0),
        'contradictory environment count': lambda d: d['environment'].update(groupStartSamplesPerDocument=29),
        'contradictory final source': lambda d: d.update(sourceSha256='0'*64),
        'wrong protocol': lambda d: d.update(protocol='other'),
        'wrong exitReason': lambda d: d.update(exitReason='HARNESS_ERROR'),
        'producer PASS with harness error': lambda d: d.update(error='cleanup failure'),
    }


class EvidenceContract(unittest.TestCase):
    def test_valid_pass_and_latency_failures(self):
        for group, undo, verdict in [(40,100,'PASS'),(51,100,'FAIL'),(40,1501,'FAIL'),(50,1500,'PASS')]:
            with self.subTest(group=group, undo=undo):
                data = producer_fixture(group, undo)
                original = copy.deepcopy(data)
                result = analyze(data)
                self.assertEqual(result['officialVerdict'], verdict)
                self.assertEqual(result['producerStatus'], verdict)
                self.assertEqual(len(result['rows']), 4)
                self.assertEqual(data, original)

    def test_varying_fractional_nearest_rank_matches_producer(self):
        data = producer_fixture()
        for row in data['measurements']['perf']:
            for kind in ['groupStart','extend','undo','redo','afterUndo']:
                samples = [s for s in row['timelineSamples'] if s['kind'] == kind]
                values = [round(30 + i / 10, 1) for i in range(len(samples))]
                for sample, value in zip(samples, reversed(values)):
                    sample['keyToFrame'] = value
                    sample['at'].update(observed=value-20, raf1=value-10, end=value)
                n = len(values)
                row[kind].update(p50=values[(50*n+99)//100-1],
                                 p95=values[(95*n+99)//100-1], max=values[-1])
        for i, row in enumerate(data['measurements']['perf']):
            for offset, kind in enumerate(['groupStart', 'undo']):
                data['gates'][2*i+offset]['detail'] = str(row[kind])
        self.assertEqual(analyze(data)['officialVerdict'], 'PASS')
        self.assertEqual(analyze(data)['rows'][0]['official']['groupStart']['p95'],32.8)

    def test_complete_harness_failure_is_explained_fail(self):
        data = producer_fixture()
        data.update(status='FAIL', error='cleanup failure', exitReason='HARNESS_ERROR')
        self.assertEqual(analyze(data)['officialVerdict'], 'FAIL')

    def test_all_integrity_cases_rejected(self):
        for name, mutate in negative_cases().items():
            with self.subTest(name=name):
                data = producer_fixture()
                mutate(data)
                with self.assertRaises(EvidenceIntegrityError) as caught:
                    analyze(data)
                self.assertTrue(str(caught.exception))

    def test_signed_offsets_and_attribution_unchanged(self):
        data = producer_fixture()
        result = analyze(data)
        row = result['rows'][0]
        self.assertEqual(row['negativeTimestampOffsets'], [dict(sampleIndex=i, field='input', ms=-1) for i in range(30)])
        self.assertEqual(row['intervalsMs']['keyToInput'], dict(n=30,min=-1,p50=-1,p95=-1,max=-1))
        self.assertEqual(row['stagePerGroupUnionMs']['snapshot'], dict(n=30,min=6,p50=6,p95=6,max=6))
        self.assertEqual(row['individualSyncAndAwaitCallsMs']['saveSnapshot'], dict(n=60,min=4,p50=4,p95=4,max=4))
        self.assertEqual(row['groupCorrelations'][0]['knownSyncUnionMs'], 6)

    def test_json_rejects_duplicate_nonfinite_and_truncated(self):
        for raw in ['{"status":"FAIL","status":"PASS"}', '{"a":{"n":1,"n":2}}',
                    '{"a":NaN}', '{"a":Infinity}', '{"a":-Infinity}', '{"a":1e999}',
                    '{', 'null trailing', b'\xff']:
            with self.subTest(raw=raw), self.assertRaises(EvidenceIntegrityError):
                loads_strict(raw)

    def test_contract_matches_actual_producer_without_native_imports(self):
        # Execute only pure producer functions, avoiding native/WebKit dependencies.
        historical = ROOT / 'tests/integration/rhwp/undo_native.py'
        wrapper = ROOT / 'tests/integration/rhwp/ownership-poc/history-perf.py'
        namespace = {}
        for path, name in [(historical,'pct'), (wrapper,'classify_result')]:
            tree = ast.parse(path.read_text())
            function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), namespace)
        for data in [producer_fixture(), producer_fixture(51), producer_fixture(40,1501)]:
            self.assertEqual(namespace['classify_result'](data), {k:data[k] for k in ['measurementComplete','exitReason','status','failedGateCount']})
            for row in data['measurements']['perf']:
                for kind in ['groupStart','extend','undo','redo','afterUndo']:
                    values=[s['keyToFrame'] for s in row['timelineSamples'] if s['kind']==kind]
                    self.assertEqual(namespace['pct'](values), row[kind])
        spec = importlib.util.spec_from_file_location('runner_contract_check', HERE/'run-current-perf.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)/'producer.json'
            for data in [producer_fixture(), producer_fixture(51), producer_fixture(40,1501)]:
                output.write_text(json.dumps(data))
                errors = []
                self.assertEqual(runner.producer_result(output, errors), data)
                self.assertEqual(errors, [])
        # Guard the positional contract against drift in producer document/gate order.
        source = historical.read_text()
        self.assertIn('f"{path.suffix}: group-start key→frame p95 ≤50ms"', source)
        self.assertIn('f"{path.suffix}: Undo p95 ≤1500ms"', source)
        self.assertIn("[fixtures / 'basic-ko.hwp', fixtures / 'basic-ko.hwpx', *historical.LARGE]", wrapper.read_text())
        self.assertIn('LARGE = [S / "rnote/연구노트(화학).hwp", S / "issue6031/3249937_asset_management_rules.hwpx"]', source)

    def test_historical_raw_when_available(self):
        for attempt, old in [(1, 'native-attribution.json'), (2, 'native-attribution-attempt2.json')]:
            summary = json.loads((HERE/f'native-d4-off-attempt{attempt}-summary.json').read_text())
            raw = ROOT/summary['rawPath']
            if not raw.is_file():
                self.skipTest('historical raw evidence unavailable; summaries cannot replace replay')
            self.assertEqual(hashlib.sha256(raw.read_bytes()).hexdigest(), summary['rawSha256'])
            result = analyze(loads_strict(raw.read_bytes()))
            self.assertEqual(result['officialVerdict'], 'FAIL')
            self.assertEqual(result['producerStatus'], 'FAIL')
            previous = json.loads((HERE/old).read_text())
            for actual, recorded in zip(result['rows'], previous['rows']):
                for key, value in recorded.items():
                    self.assertEqual(actual[key], value, (attempt, actual['sample'], key))

    def test_cli_all_cases_no_output_on_invalid_input(self):
        # Running the suite with -O / PYTHONOPTIMIZE also exercises the CLI that way.
        flags = ['-O'] if sys.flags.optimize else []
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp)/'producer.json', Path(tmp)/'analysis.json'
            cases = [(name, mutate, False) for name, mutate in negative_cases().items()]
            cases += [('PASS',lambda d: None,True), ('FAIL',lambda d: None,True)]
            for name, mutate, valid in cases:
                with self.subTest(name=name):
                    data = producer_fixture(51 if name=='FAIL' else 40)
                    mutate(data)
                    source.write_text(json.dumps(data))
                    run = subprocess.run([sys.executable,*flags,str(HERE/'analyze.py'),str(source),str(target)], capture_output=True,text=True)
                    self.assertEqual(run.returncode, 0 if valid else 2, run.stderr)
                    self.assertEqual(target.exists(), valid)
                    if valid:
                        self.assertEqual(run.stdout.strip(), name)
                        target.unlink()
                    else:
                        self.assertIn('evidence-integrity failure:', run.stderr)
                        self.assertNotIn('PASS', run.stdout)
            for raw in ['{', '{"status":"FAIL","status":"PASS"}', '{"n":1e999}']:
                source.write_text(raw)
                run = subprocess.run([sys.executable,*flags,str(HERE/'analyze.py'),str(source),str(target)],capture_output=True,text=True)
                self.assertEqual(run.returncode, 2)
                self.assertFalse(target.exists())
            # Existing historical outputs survive both valid and invalid invocation.
            target.write_bytes(b'historical evidence\n')
            for data in [producer_fixture(), {}]:
                source.write_text(json.dumps(data))
                run=subprocess.run([sys.executable,*flags,str(HERE/'analyze.py'),str(source),str(target)],capture_output=True)
                self.assertNotEqual(run.returncode,0)
                self.assertEqual(target.read_bytes(), b'historical evidence\n')


if __name__ == '__main__':
    unittest.main()
