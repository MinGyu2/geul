"""Deterministic interval, pairing and causal-log completeness regressions."""
import copy
import json
from pathlib import Path
import unittest
import d4_evidence as d

WASM='4'*64
SOURCE='6'*64


def complete():
    r=dict(sample='연구노트(화학).hwp',sourceSha256=SOURCE,engineIdentity={'wasmSha256':WASM},
           traceDropped=0,measure={'groupStart':{'n':30,'timeouts':0}},samples=[],
           events={'keys':[], 'inputs':[]},probeCalls=[],traceSpans=[])
    for j in range(30):
        key=j*100+100
        r['events']['keys'].append(dict(t=key,seen=key+2))
        r['events']['inputs'].append(dict(t=key+3,seen=key+3))
        calls=[dict(name='insertText',at=4,ms=1)]
        r['samples'].append(dict(kind='groupStart',at=dict(key=0,input=3,handlerEnd=7,observed=9,raf1=15,end=20),
                                 keyToFrame=20,engineTimeline=calls,busy=[[-1,8]],calls={'insertText':{'n':1,'ms':1}}))
        r['probeCalls'].extend([dict(name='insertText',at=key+4,ms=1),dict(name='pollRenderJob',at=key-1,ms=3)])
        r['traceSpans'].append(dict(name='dom:input',at=key+3,ms=None))
    return r


class Intervals(unittest.TestCase):
    def test_pre_key(self): self.assertEqual(d.union([(0,15)],10,20),5)
    def test_nested(self): self.assertEqual(d.union([(0,20),(5,10)],0,30),20)
    def test_partial(self): self.assertEqual(d.union([(0,10),(5,20)],0,30),20)
    def test_disjoint(self): self.assertEqual(d.union([(0,10),(15,20)],0,30),15)
    def test_identical(self): self.assertEqual(d.union([(0,10)]*2,0,30),10)
    def test_rounding(self):
        self.assertAlmostEqual(d.union([(0,1.01),(.99,2)],0,2),2)
    def test_missing(self):
        with self.assertRaises(ValueError):d.union([(None,10)],0,30)
    def test_handler_nested(self):
        s=complete()['samples'][0]
        s.update(calls={'insertText':{'n':1,'ms':4},'pollRenderJob':{'n':1,'ms':4}},engineTimeline=[dict(name='insertText',at=3,ms=4),dict(name='pollRenderJob',at=3,ms=4)])
        a=d.handler_accounting(s)
        self.assertEqual(a['nonexclusiveArithmeticResidualMs'],-4)
        self.assertEqual(a['uncoveredMs'],0)
    def test_handler_missing(self):
        s=complete()['samples'][0];s['engineTimeline'][0]['at']=None
        self.assertIsNone(d.handler_accounting(s)['uncoveredMs'])


class Completeness(unittest.TestCase):
    def check_fail(self,r): self.assertEqual(d.validate(r,WASM,SOURCE)['status'],'FAIL')
    def test_complete(self): self.assertEqual(d.validate(complete(),WASM,SOURCE)['status'],'DIAGNOSTIC_COMPLETE')
    def test_missing_logs(self):
        for name in ('probeCalls','traceSpans','samples'):
            with self.subTest(name=name):
                r=complete();r[name]=[];self.check_fail(r)
        for name in ('keys','inputs'):
            r=complete();r['events'][name]=[];self.check_fail(r)
    def test_mismatched_counts(self):
        r=complete();r['events']['inputs'].pop();self.check_fail(r)
    def test_unmatched_calls(self):
        r=complete();r['probeCalls'].pop(0);self.check_fail(r)
    def test_displaced(self):
        r=complete();r['probeCalls'][0],r['probeCalls'][2]=r['probeCalls'][2],r['probeCalls'][0];self.check_fail(r)
    def test_duplicate(self):
        r=complete();r['events']['keys'].insert(0,copy.deepcopy(r['events']['keys'][0]));self.check_fail(r)
    def test_invalid_order(self):
        r=complete();r['events']['inputs'].reverse();self.check_fail(r)
    def test_unmatched_extra_input(self):
        r=complete();r['events']['inputs'].append(dict(t=10000,seen=10000));self.check_fail(r)
    def test_timestamp_inversion(self):
        r=complete();r['samples'][0]['at']['input']=-1;self.check_fail(r)
    def test_missing_selected_call_coverage(self):
        r=complete();r['samples'][0]['engineTimeline'].append(dict(name='pollRenderJob',at=5,ms=1));self.check_fail(r)
    def test_probe_call_loss(self):
        r=complete();r['probeCallDropped']=10000;self.check_fail(r)
    def test_trace_loss(self):
        r=complete();r['traceDropped']=1;self.check_fail(r)
    def test_trace_association(self):
        r=complete();r['traceSpans'][0]['at']+=10;self.check_fail(r)
    def test_invalid_numeric(self):
        for value in (True,None,float('inf'),'100'):
            r=complete();r['events']['keys'][0]['t']=value;self.check_fail(r)
    def test_busy_missing(self):
        r=complete();r['samples'][0]['busy']=[];self.check_fail(r)
    def test_fixture_candidate(self):
        r=complete();r['sourceSha256']='x';self.check_fail(r)
        r=complete();r['engineIdentity']['wasmSha256']='x';self.check_fail(r)
    def test_extra_events_allowed(self):
        r=complete()
        for name in ('keys','inputs'):r['events'][name].insert(0,dict(t=1,seen=1))
        self.assertEqual(d.validate(r,WASM,SOURCE)['status'],'DIAGNOSTIC_COMPLETE')


class HistoricalRegression(unittest.TestCase):
    def test_real_alignment_and_ten_slow(self):
        path=Path(__file__).resolve().parent.parent/'evidence/t010-validation-d4-investigation/diagnostic-d4-input-delay-chemical.json'
        r=json.loads(path.read_text())
        self.assertEqual(d.validate(r,r['engineIdentity']['wasmSha256'],r['sourceSha256'])['status'],'DIAGNOSTIC_COMPLETE')
        rows=d.analyze_delay(r);self.assertEqual(len(rows),30)
        slow=[x for x in rows if x['deliveryMs']>=50]
        self.assertEqual(len(slow),10)
        self.assertTrue(all(x['renderUnionMs']>0 for x in slow))
        self.assertEqual(sum(x['overlapPercent']>=95 for x in slow),8)
        self.assertEqual(sum(any(121<=c['ms']<=158 for c in x['renders']) for x in slow),7)
        self.assertEqual([x['trial'] for x in slow if x['overlapPercent']<95],[13,15])
        self.assertEqual([x['residualMs'] for x in slow if x['overlapPercent']<95],[34,31])


if __name__=='__main__':unittest.main()
