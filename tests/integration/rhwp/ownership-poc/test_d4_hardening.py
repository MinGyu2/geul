"""Historical-record mutations isolate additional analyzer integrity defects."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import sys
import test_d4_analysis_cli as existing
from d4_evidence import handler_accounting


class HandlerHardening(unittest.TestCase):
    setUpClass = classmethod(existing.HandlerStatistics.setUpClass.__func__)
    check = existing.HandlerStatistics.check
    reject = existing.HandlerStatistics.reject
    doc = existing.HandlerStatistics.doc
    samples = existing.HandlerStatistics.samples

    def sample_mutation(self, change, kind='groupStart'):
        return lambda r: change(self.samples(r,kind)[0])

    def test_aggregate_all_kinds(self):
        for kind in ('groupStart','extend','undo','redo','afterUndo'):
            for field,value in (('ms',999),('n',999),('firstAt',999)):
                with self.subTest(kind=kind,field=field):
                    self.reject(self.sample_mutation(lambda s:next(iter(s['calls'].values())).update({field:value}),kind),'aggregate')
        self.reject(self.sample_mutation(lambda s:s['calls'].update(unused={'n':0,'ms':0,'firstAt':None})),'aggregate')

    def test_temporal_and_precision(self):
        changes = [lambda s:s['at'].update(key=.1),
                   lambda s:s.update(keyToFrame=s['keyToFrame']+.04),
                   lambda s:s.update(keyToFrame=s['keyToFrame']-.1),
                   lambda s:s['at'].update(handlerEnd=s['at']['end']+1),
                   lambda s:s['engineTimeline'][0].update(at=99999),
                   lambda s:s['engineTimeline'][0].update(ms=99999),
                   lambda s:s['timeline'][0].update(at=99999)]
        for i,change in enumerate(changes):
            with self.subTest(change=i):self.reject(self.sample_mutation(change),'')
        self.reject(self.sample_mutation(changes[3],'extend'),'')

    def test_error_and_trace_identity(self):
        for value in ({},[],False,None,0,''):
            with self.subTest(error=value):self.reject(lambda r:r.update(error=value),'error')
        self.reject(self.sample_mutation(lambda s:s.update(timeline=[dict(name='meaningless',at=1,ms=None)])),'trace')

    def test_indistinguishable_duplicates_remain_compatible(self):
        def duplicate(r):
            groups=self.samples(r,'groupStart')
            a,b=next((a,b) for i,a in enumerate(groups) for b in groups[i+1:] if a['keyToFrame']==b['keyToFrame'])
            rows=self.doc(r)['timelineSamples'];rows[rows.index(b)]=copy.deepcopy(a)
        self.check(duplicate)

    def test_producer_serialization_and_rounding_loss(self):
        # Execute the actual producer serializer, independently of copied validation logic.
        import ast
        root=Path(__file__).resolve().parents[4]
        tree=ast.parse((root/'tests/integration/rhwp/undo_native.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='timeline_samples')
        ns={};exec(compile(ast.Module(body=[fn],type_ignores=[]),'producer','exec'),ns)
        def change(r):
            s=self.samples(r,'groupStart')[0]
            raw=dict(kind=s['kind'],keyToFrame=s['keyToFrame'],at=s['at'],
                     calls=[dict(name='insertText',at=1.004,ms=.005),dict(name='insertText',at=1.014,ms=.005)],
                     timeline=s['timeline'])
            serialized=ns['timeline_samples']([raw])[0]
            # 0.005 + rounded 0.01 rounds to 0.01: serialized durations sum to 0.02.
            self.assertEqual(serialized['calls']['insertText']['ms'],.01)
            # Keep the single-insertText edit contract; use a nested snapshot call for rounding example.
            raw['calls']=[dict(name='snapshotCapacity',at=1.004,ms=.005),dict(name='snapshotCapacity',at=1.014,ms=.005),dict(name='insertText',at=2,ms=1)]
            s.update(ns['timeline_samples']([raw])[0])
        self.check(change)

    def test_integer_timestamps_must_be_representable_as_producer_float(self):
        from d4_handler import rounding_bounds
        # JSON integers can be finite yet impossible as a JS/Python binary-float
        # producer timestamp. Reject before searching rounding preimages.
        with self.assertRaises(ValueError):rounding_bounds(10**17+1,1)
        lo,hi=rounding_bounds(10**17,1)
        self.assertLessEqual(lo,10**17);self.assertGreaterEqual(hi,10**17)
        self.reject(self.sample_mutation(lambda s:s['at'].update(observed=10**17+1,raf1=10**17+1,end=10**17+1)), '')

    def test_rounding_bounds_match_binary_round_and_accumulation(self):
        import math
        import random
        from d4_handler import rounding_bounds
        rng=random.Random(10)
        for digits in (1,2):
            for raw in [0,.005,.015,.025,.035,.25,.35,1.005,87.25]+[rng.uniform(-100,100) for _ in range(200)]:
                value=round(raw,digits);lo,hi=rounding_bounds(value,digits)
                self.assertLessEqual(lo,raw);self.assertGreaterEqual(hi,raw)
                self.assertEqual(round(lo,digits),value);self.assertEqual(round(hi,digits),value)
                self.assertNotEqual(round(math.nextafter(lo,-math.inf),digits),value)
                self.assertNotEqual(round(math.nextafter(hi,math.inf),digits),value)
        for _ in range(100):
            raw=[rng.choice([.005,.015,rng.uniform(0,100)]) for _ in range(20)]
            actual=lower=upper=0.0
            for ms in raw:
                actual=round(actual+ms,2)
                lo,hi=rounding_bounds(round(ms,2),2)
                lower=round(lower+max(0,lo),2);upper=round(upper+hi,2)
                self.assertLessEqual(lower,actual);self.assertGreaterEqual(upper,actual)

    def test_accounting_rejects_overflow(self):
        sample=dict(at=dict(input=0,handlerEnd=1),calls={n:dict(n=1,ms=1e308) for n in ('insertText','saveSnapshot')},engineTimeline=[])
        with self.assertRaises(ValueError):handler_accounting(sample)


class JsonHardening(unittest.TestCase):
    setUp=existing.CLI.setUp
    run_cli=existing.CLI.run_cli
    valid=existing.CLI.valid

    def test_parser_fail_closed(self):
        valid=json.dumps(self.valid())
        cases=['{"measurementComplete":false,"measurementComplete":true}',
               valid[:-1]+',"engineIdentity":{}}', '['*20000+'0'+']'*20000,
               '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}',
               '{"x":'+ '9'*5000+'}', ' '* (32*1024*1024+1), '"\\ud800"']
        for i,raw in enumerate(cases):
            with self.subTest(case=i):
                p,out=self.run_cli(raw);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
                self.assertEqual((self.work/'source.json').read_text(),raw)



class HandlerCliHardening(unittest.TestCase):
    setUp=existing.HandlerCLI.setUp
    setUpClass=classmethod(existing.HandlerCLI.setUpClass.__func__)
    run_handler=existing.HandlerCLI.run_handler
    reject=existing.HandlerCLI.reject

    def test_handler_cli_invalid_duration(self):
        for value in (999,1e308):
            self.reject(lambda r:r['measurements']['perf'][0]['timelineSamples'][0]['calls']['insertText'].update(ms=value),'aggregate')

    def test_finite_validated_record_cannot_overflow_accounting(self):
        from d4_handler import validate_handler, verified_fixtures, producer_pct
        def mutate(r):
            doc=r['measurements']['perf'][0];s=doc['timelineSamples'][0]
            s['keyToFrame']=1.7e308
            s['at'].update(handlerEnd=1.7e308,observed=1.7e308,raf1=1.7e308,end=1.7e308)
            for name in ('insertText','saveSnapshot'):
                s['calls'][name]['ms']=1e308
                next(c for c in s['engineTimeline'] if c['name']==name)['ms']=1e308
            doc['groupStart'].update(producer_pct([t['keyToFrame'] for t in doc['timelineSamples'] if t['kind']=='groupStart']))
            # All input fields, sums per call name and intervals remain valid.
            # The cross-name nonexclusive accounting sum alone overflows.
            validate_handler(r,self.wasm,verified_fixtures(self.fixtures))
        self.reject(mutate,'non-finite derived arithmetic')

    def test_serialization_last_defense(self):
        spec=importlib.util.spec_from_file_location('analyze_d4',Path(__file__).with_name('analyze-d4.py'))
        mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
        r=copy.deepcopy(self.historical);r['engineIdentity']['wasmSha256']=self.wasm
        source=self.work/'source.json';source.write_text(json.dumps(r));output=self.work/'strict.json'
        args=['analyze-d4.py','handler',str(source),str(output),'--candidate',str(self.package),
              '--expected-wasm',self.wasm,'--expected-js',self.js,'--fixtures',str(self.fixtures)]
        # Fault injection tests the complete final-output path even if a future
        # arithmetic regression bypasses the accounting function's checks.
        with patch.object(sys,'argv',args), patch.object(mod,'handler_accounting',return_value={'nonexclusiveArithmeticResidualMs':float('inf')}):
            self.assertEqual(mod.main(),1)
        def reject_constant(value):raise AssertionError(value)
        result=json.loads(output.read_text(),parse_constant=reject_constant)
        self.assertEqual(result['status'],'FAIL')
        with self.assertRaises(ValueError):mod.strict_json(dict(value=float('inf')))

    def test_malformed_handler_shapes_fail_structurally(self):
        for change in (lambda s:s.update(at=[]),lambda s:s.update(calls=[]),
                       lambda s:s.update(kind={}),lambda s:s.update(timeline=[None]),
                       lambda s:s['at'].update(handlerEnd={})):
            p,out=self.run_handler(lambda r:change(r['measurements']['perf'][0]['timelineSamples'][0]))
            self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')

    def test_manifest_duplicate_identity_is_rejected(self):
        manifest=self.package/'ENGINE.json';data=manifest.read_text()
        manifest.write_text(data[:-1]+',"buildStatus":"PASS"}')
        p,out=self.run_handler();self.assertEqual(p.returncode,1);self.assertIn('duplicate JSON',out['error'])
