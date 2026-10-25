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


BASELINE, LUMA8 = existing.OFFICIAL


def insert_trace(sample, record, index=0):
    sample['timeline'].insert(index, dict(record, ms=None, page=None))


def move_first_call(sample, name, at):
    # The first engineTimeline entry of a name is the aggregate firstAt source.
    call = next(c for c in sample['engineTimeline'] if c['name'] == name)
    call['at'] = at; sample['calls'][name]['firstAt'] = at


def anchor(sample):
    name = 'command:request' if sample['kind'] in ('undo','redo') else 'dom:input'
    return next(t for t in sample['timeline'] if t['name'] == name)


class AnchorCausality(unittest.TestCase):
    """Deep copies of genuine official samples; only targeted fields are changed."""
    setUpClass = classmethod(existing.HandlerStatistics.setUpClass.__func__)
    check = existing.HandlerStatistics.check
    doc = existing.HandlerStatistics.doc
    samples = existing.HandlerStatistics.samples

    def first(self, change, kind='groupStart', index=0):
        return lambda r: change(self.samples(r,kind,index)[0])

    def reject(self, mutate, reason, record=BASELINE):
        with self.assertRaises(ValueError) as caught: self.check(mutate, record)
        self.assertIn(reason, str(caught.exception)); return str(caught.exception)

    def test_early_fabricated_input_anchor(self):
        self.reject(self.first(lambda s:insert_trace(s,dict(name='dom:input',at=-10000))), 'groupStart dom:input before input')

    def test_early_insert_text_call_with_matching_first_at(self):
        self.reject(self.first(lambda s:move_first_call(s,'insertText',-9999)), 'invalid call execution interval')

    def test_reported_anchor_and_call_bypass(self):
        def bypass(s):
            insert_trace(s,dict(name='dom:input',at=-10000)); move_first_call(s,'insertText',-9999)
        for kind in ('groupStart','extend','afterUndo'):
            for record in (BASELINE, LUMA8):
                with self.subTest(kind=kind, record=record):
                    self.reject(self.first(bypass,kind), kind+' dom:input before input', record)

    def test_duplicate_anchor_inside_measured_dispatch(self):
        def duplicate(s):
            a = anchor(s); insert_trace(s, a, s['timeline'].index(a)+1)
        for kind in ('groupStart','extend','afterUndo','undo','redo'):
            with self.subTest(kind=kind):self.reject(self.first(duplicate,kind),'duplicate')
        self.assertIn('dom:input before handlerEnd', self.reject(self.first(duplicate),'duplicate'))
        self.assertIn('command:request before observed', self.reject(self.first(duplicate,'undo'),'duplicate'))

    def test_fabricated_history_command_anchor(self):
        def fabricate(s):
            insert_trace(s,dict(name='dom:keydown',at=-10001)); insert_trace(s,dict(name='command:request',at=-10000),1)
            move_first_call(s,'restoreSnapshot',-9999)
        for kind in ('undo','redo'):
            for record in (BASELINE, LUMA8):
                with self.subTest(kind=kind, record=record):
                    self.reject(self.first(fabricate,kind),kind+' duplicate command:request before observed',record)
        # Same-clock upper relation: the command precedes the frame that observes it.
        self.reject(self.first(lambda s:anchor(s).update(at=s['at']['observed']+1),'undo'), 'undo command:request after observed')
        self.reject(self.first(lambda s:anchor(s).update(ms=0),'redo'), 'redo command:request duration')

    def test_in_tolerance_anchor_no_longer_weakens_call_bound(self):
        # The pre-fix validator accepted any one associated dom:input and took
        # min() over all of them: a fabricated input-2 anchor lowered the bound.
        def edit(s):
            insert_trace(s,dict(name='dom:input',at=s['at']['input']-2)); move_first_call(s,'insertText',s['at']['input']-1.9)
        def history(s):
            insert_trace(s,dict(name='command:request',at=-3)); move_first_call(s,'restoreSnapshot',-2.9)
        self.reject(self.first(edit), 'groupStart duplicate dom:input before handlerEnd')
        self.reject(self.first(history,'undo'), 'undo duplicate command:request before observed')
        self.reject(self.first(lambda s:anchor(s).update(at=s['at']['handlerEnd']+1)), 'dom:input after handlerEnd')

    def test_genuine_anchor_contract_both_records_all_kinds(self):
        from d4_handler import validate_sample_contract
        for record in (BASELINE, LUMA8):
            kinds = set()
            for doc in self.records[record]['measurements']['perf']:
                for s in doc['timelineSamples']:
                    validate_sample_contract(copy.deepcopy(s)); kinds.add(s['kind'])
                    self.assertEqual(sum(t['name']==anchor(s)['name'] for t in s['timeline']), 1)
            self.assertEqual(kinds, {'groupStart','extend','undo','redo','afterUndo'})
            self.check(record=record)

    def test_genuine_negative_native_timestamps_accepted(self):
        luma = [s for doc in self.records[LUMA8]['measurements']['perf'] for s in doc['timelineSamples']]
        keydown = [s for s in luma if s['kind'] in ('undo','redo') and any(t['name']=='dom:keydown' and t['at']==-3 for t in s['timeline'])]
        self.assertEqual(len(keydown), 1); self.assertEqual(anchor(keydown[0])['at'], -2)
        for record in (BASELINE, LUMA8):
            negative = [s for doc in self.records[record]['measurements']['perf'] for s in doc['timelineSamples']
                        if anchor(s)['at'] < 0 and any(c['at'] < 0 for c in s['engineTimeline'])]
            self.assertTrue(negative)
        self.check(record=LUMA8)

    def test_genuine_async_calls_cross_handler_end(self):
        from d4_handler import validate_sample_contract
        for record in (BASELINE, LUMA8):
            late = [s for doc in self.records[record]['measurements']['perf'] for s in doc['timelineSamples']
                    if s['at']['handlerEnd'] is not None and any(c['at']+c['ms'] > s['at']['handlerEnd'] for c in s['engineTimeline'])]
            self.assertEqual(len(late), 59)
            for s in late: validate_sample_contract(copy.deepcopy(s))

    def test_later_harness_input_after_boundary_remains_valid(self):
        # The harness waits for the revision, not the final RAF: a following
        # input may add its anchor once the measured dispatch ended/was observed.
        def later(s):
            boundary = s['at']['handlerEnd'] if s['at']['handlerEnd'] is not None else s['at']['observed']
            name = anchor(s)['name']
            index = next((i for i,t in enumerate(s['timeline']) if t['at'] > boundary), len(s['timeline']))
            insert_trace(s, dict(name=name,at=boundary), index)
            if len(s['timeline']) > 80: s['timeline'].pop()
        for kind in ('groupStart','extend','afterUndo','undo','redo'):
            for record in (BASELINE, LUMA8):
                with self.subTest(kind=kind, record=record):self.check(self.first(later,kind), record)

    def test_emission_and_serialization_rounding_boundary(self):
        from d4_handler import trace_emission_bounds
        lo, hi = trace_emission_bounds(1)
        # Two half-quanta (0.1 ms emission, one-decimal serialization) on each side.
        self.assertAlmostEqual(lo, .9, places=12); self.assertAlmostEqual(hi, 1.1, places=12)
        # Genuine groupStart anchor is at 1: emission rounding admits a 0.90 call start, not 0.89.
        self.assertEqual(anchor(self.samples(self.records[BASELINE],'groupStart')[0])['at'], 1)
        self.check(self.first(lambda s:move_first_call(s,'insertText',.9)))
        self.reject(self.first(lambda s:move_first_call(s,'insertText',.89)), 'invalid call execution interval')


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

    def test_anchor_bypass_fails_through_handler_cli(self):
        def bypass(r):
            s=next(s for s in r['measurements']['perf'][0]['timelineSamples'] if s['kind']=='groupStart')
            insert_trace(s,dict(name='dom:input',at=-10000)); move_first_call(s,'insertText',-9999)
        p,out=self.run_handler(bypass)
        self.assertEqual(p.returncode,1);self.assertEqual(out['status'],'FAIL');self.assertFalse(out['official'])
        self.assertEqual(out['error'],'invalid execution trace association: groupStart dom:input before input')
        self.assertNotIn('documents',out)

    def test_both_complete_official_failures_remain_analyzable(self):
        root=Path(__file__).resolve().parents[4]
        for name in existing.OFFICIAL:
            with self.subTest(record=name):
                record=json.loads((root/'tests/integration/rhwp/evidence/t010-d4-performance-remediation'/name).read_text())
                self.assertIs(record['measurementComplete'],True);self.assertEqual(record['status'],'FAIL')
                with patch.object(self,'historical',record):p,out=self.run_handler()
                self.assertEqual(p.returncode,0);self.assertEqual(out['status'],'ANALYZED');self.assertFalse(out['official'])
                self.assertEqual([len(d['rows']) for d in out['documents']],[30]*4)

    def test_manifest_duplicate_identity_is_rejected(self):
        manifest=self.package/'ENGINE.json';data=manifest.read_text()
        manifest.write_text(data[:-1]+',"buildStatus":"PASS"}')
        p,out=self.run_handler();self.assertEqual(p.returncode,1);self.assertIn('duplicate JSON',out['error'])
