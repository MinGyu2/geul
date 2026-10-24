"""Confirmed P0 identity/loss/type/CLI exit regressions, no generic fuzz corpus."""
import copy
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import d4_evidence as d
from test_d4_evidence import complete, WASM, SOURCE


class Integrity(unittest.TestCase):
    def test_missing_loss_current_and_explicit_legacy(self):
        r=complete();r.pop('probeCallDropped')
        self.assertEqual(d.validate(r,WASM,SOURCE)['status'],'FAIL')
        v=d.validate(r,WASM,SOURCE,legacy=True)
        self.assertEqual(v['status'],'INCONCLUSIVE');self.assertIn('UNVERIFIED',v['lossEvidence'])
    def test_loss_exact_types(self):
        for key in ('probeCallDropped','traceDropped'):
            for value in (None,False,0.0,1):
                with self.subTest(key=key,value=value):
                    r=complete();r[key]=value;self.assertEqual(d.validate(r,WASM,SOURCE)['status'],'FAIL')
    def test_supported_structures_fail_without_exception(self):
        for name in ('events','engineIdentity','measure','probeCalls','traceSpans','samples'):
            for value in (None,True,42,'invalid',[None]):
                with self.subTest(name=name,value=value):
                    r=complete();r[name]=value;self.assertEqual(d.validate(r,WASM,SOURCE)['status'],'FAIL')
        for value in (None,[],False,5):self.assertEqual(d.validate(value,WASM,SOURCE)['status'],'FAIL')
    def test_nested_malformed_records(self):
        for mutate in (lambda r:r['measure'].update(groupStart=[]),lambda r:r['events'].update(keys=[None]),
                       lambda r:r['samples'][0].update(at=[]),lambda r:r['samples'][0].update(engineTimeline=[None]),
                       lambda r:r['probeCalls'][0].update(name=[])):
            r=complete();mutate(r);self.assertEqual(d.validate(r,WASM,SOURCE)['status'],'FAIL')


class CLI(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.work=Path(self.temp.name)
        self.package=self.work/'candidate';self.package.mkdir();artifacts={}
        for name in ('rhwp_bg.wasm','rhwp.js'):
            data=('independently checked test artifact '+name).encode();(self.package/name).write_bytes(data);artifacts[name]=hashlib.sha256(data).hexdigest()
        (self.package/'ENGINE.json').write_text(json.dumps(dict(buildStatus='PASS',sourceStableDuringBuild=True,artifacts=artifacts)))
        self.js=artifacts['rhwp.js'];self.wasm=artifacts['rhwp_bg.wasm'];self.fixture=self.work/'fixture.hwp';self.fixture.write_bytes(b'authoritative unit fixture')
        self.source=hashlib.sha256(self.fixture.read_bytes()).hexdigest()
    def run_cli(self,result,**options):
        source=self.work/'source.json';output=self.work/'output.json'
        if output.exists():output.unlink()
        source.write_text(result if isinstance(result,str) else json.dumps(result))
        cmd=['python3',str(Path(__file__).with_name('analyze-d4.py')),'input-delay',str(source),str(output),
             '--fixture',str(self.fixture),'--expected-wasm',options.get('wasm',self.wasm),'--expected-js',self.js,'--candidate',str(self.package)]
        if options.get('legacy'):cmd.append('--legacy')
        process=subprocess.run(cmd,capture_output=True,text=True)
        self.assertNotIn('Traceback',process.stderr)
        return process,json.loads(output.read_text())
    def valid(self):
        r=complete();r.update(sourceSha256=self.source,engineIdentity={'wasmSha256':self.wasm});return r
    def test_valid_and_output_preservation(self):
        p,r=self.run_cli(self.valid());self.assertEqual(p.returncode,0);self.assertEqual(r['status'],'DIAGNOSTIC_COMPLETE')
        # Repeat command may not overwrite its output.
        output=self.work/'output.json';old=output.read_bytes()
        cmd=['python3',str(Path(__file__).with_name('analyze-d4.py')),'input-delay',str(self.work/'source.json'),str(output),
             '--fixture',str(self.fixture),'--expected-wasm',self.wasm,'--expected-js',self.js,'--candidate',str(self.package)]
        p=subprocess.run(cmd,capture_output=True);self.assertNotEqual(p.returncode,0);self.assertEqual(output.read_bytes(),old)
    def test_claimed_wasm_cannot_be_its_expectation(self):
        r=self.valid();r['engineIdentity']['wasmSha256']='a'*64;p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_claimed_source_cannot_be_its_expectation(self):
        r=self.valid();r['sourceSha256']='b'*64;p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_arbitrary_expected_digest_rejected_by_artifact(self):
        p,out=self.run_cli(self.valid(),wasm='a'*64);self.assertNotEqual(p.returncode,0);self.assertIn('artifact',out['error'])
    def test_artifact_tampering(self):
        (self.package/'rhwp_bg.wasm').write_bytes(b'changed');p,out=self.run_cli(self.valid());self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_js_and_manifest_tampering(self):
        (self.package/'rhwp.js').write_bytes(b'changed JS')
        manifest=json.loads((self.package/'ENGINE.json').read_text())
        manifest['artifacts']['rhwp.js']=hashlib.sha256(b'changed JS').hexdigest()
        (self.package/'ENGINE.json').write_text(json.dumps(manifest))
        p,out=self.run_cli(self.valid());self.assertNotEqual(p.returncode,0);self.assertIn('expected JS',out['error'])
    def test_unverified_manifest(self):
        original=json.loads((self.package/'ENGINE.json').read_text())
        for field,value in [('buildStatus','FAIL'),('sourceStableDuringBuild',False)]:
            manifest=copy.deepcopy(original);manifest[field]=value
            (self.package/'ENGINE.json').write_text(json.dumps(manifest))
            p,out=self.run_cli(self.valid());self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_missing_calls_pairing_and_logs_nonzero(self):
        for mutate in (lambda r:r['probeCalls'].pop(0),lambda r:r['events']['inputs'].reverse(),lambda r:r.update(traceSpans=[])):
            r=self.valid();mutate(r);p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_missing_loss_and_legacy_nonzero(self):
        r=self.valid();r.pop('probeCallDropped')
        p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
        p,out=self.run_cli(r,legacy=True);self.assertEqual(p.returncode,2);self.assertEqual(out['status'],'INCONCLUSIVE');self.assertEqual(len(out['rows']),30)
    def test_malformed_json_and_structures(self):
        for r in ('{',[],dict(events=[]),dict(engineIdentity=[])):
            p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')


class HandlerCLI(unittest.TestCase):
    setUp = CLI.setUp

    @classmethod
    def setUpClass(cls):
        cls.generated=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.generated.cleanup)
        cls.fixtures=Path(cls.generated.name)
        root=Path(__file__).resolve().parents[4]
        subprocess.run(['node',str(root/'tests/fixtures/rhwp/generate.mjs'),str(cls.fixtures)],check=True,capture_output=True)
        cls.historical=json.loads((root/'tests/integration/rhwp/evidence/t010-d4-performance-remediation/baseline-official-frozen-comparison.json').read_text())

    def run_handler(self,mutate=lambda r:None, fixtures=None):
        r=copy.deepcopy(self.historical);r['engineIdentity']['wasmSha256']=self.wasm;mutate(r)
        source=self.work/'official.json';source.write_text(json.dumps(r));output=self.work/'handler.json'
        if output.exists():output.unlink()
        p=subprocess.run(['python3',str(Path(__file__).with_name('analyze-d4.py')),'handler',str(source),str(output),
                          '--candidate',str(self.package),'--expected-wasm',self.wasm,'--expected-js',self.js,
                          '--fixtures',str(fixtures or self.fixtures)],capture_output=True,text=True)
        self.assertNotIn('Traceback',p.stderr)
        return p,json.loads(output.read_text())

    def reject(self,mutate,reason):
        p,out=self.run_handler(mutate);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL');self.assertIn(reason,out['error'])

    def test_valid_complete_official_gate_failure_is_analyzable(self):
        p,out=self.run_handler();self.assertEqual(p.returncode,0);self.assertEqual(out['status'],'ANALYZED')
        self.assertEqual(len(out['documents']),4);self.assertTrue(all(d['fixtureIdentity']=='VERIFIED' and len(d['rows'])==30 for d in out['documents']))
    def test_fixture_contract_matches_authoritative_frame_definitions(self):
        from d4_handler import FIXTURES
        tree=ast.parse(Path(__file__).with_name('d4-frame-attribution-native.py').read_text())
        definitions={node.targets[0].id:ast.literal_eval(node.value) for node in tree.body
                     if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name)
                     and node.targets[0].id in ('FIXTURES','EXPECTED_SOURCE_SHA256')}
        self.assertEqual([(f[0],f[1]) for f in FIXTURES],list(definitions['FIXTURES']))
        self.assertEqual({f[0]:f[2] for f in FIXTURES},definitions['EXPECTED_SOURCE_SHA256'])
    def test_empty_perf(self):self.reject(lambda r:r['measurements'].update(perf=[]),'empty')
    def test_missing_collection(self):self.reject(lambda r:r['measurements'].pop('perf'),'perf')
    def test_missing_document(self):self.reject(lambda r:r['measurements']['perf'].pop(),'canonical fixture')
    def test_duplicate_document(self):self.reject(lambda r:r['measurements']['perf'].__setitem__(1,r['measurements']['perf'][0]),'canonical fixture')
    def test_unknown_fixture(self):self.reject(lambda r:r['measurements']['perf'][0].update(sample='unknown.hwp'),'canonical fixture')
    def test_wrong_order(self):self.reject(lambda r:r['measurements']['perf'].reverse(),'canonical fixture')
    def test_invalid_fixture_identity(self):self.reject(lambda r:r['measurements']['perf'][0].update(sourceSha256='a'*64),'fixture identity')
    def test_missing_fixture_identity_not_invented(self):self.reject(lambda r:r['measurements']['perf'][0].pop('sourceSha256'),'fixture identity')
    def test_wrong_independent_fixture_bytes(self):
        (self.work/'basic-ko.hwp').write_bytes(b'wrong bytes')
        p,out=self.run_handler(fixtures=self.work);self.assertNotEqual(p.returncode,0);self.assertIn('independent fixture bytes',out['error'])
    def test_missing_groups(self):self.reject(lambda r:r['measurements']['perf'][0].update(timelineSamples=[]),'timeline counts')
    def test_missing_group_call_coverage(self):self.reject(lambda r:r['measurements']['perf'][0]['timelineSamples'][0].update(engineTimeline=[],calls={}), 'call/trace coverage')
    def test_invalid_timeline(self):self.reject(lambda r:r['measurements']['perf'][0]['timelineSamples'][0].update(engineTimeline=[None]),'intervals')
    def test_invalid_measurements(self):
        for name,value in [('n',30.0),('timeouts',False)]:
            self.reject(lambda r:r['measurements']['perf'][0]['groupStart'].update({name:value}),'completion')
    def test_incomplete_measurement_nonzero(self):
        for value in (False,None,1,'true'):
            with self.subTest(value=value):self.reject(lambda r:r.update(measurementComplete=value),'measurementComplete')
        self.reject(lambda r:r.pop('measurementComplete'),'measurementComplete')
    def test_complete_pass_format_is_analyzable(self):
        p,out=self.run_handler(lambda r:r.update(status='PASS',exitReason='PASS'));self.assertEqual(p.returncode,0);self.assertEqual(out['status'],'ANALYZED')
        self.assertFalse(out['official'])
    def test_false_statistic_nonzero(self):
        self.reject(lambda r:r['measurements']['perf'][2]['groupStart'].update(p95=200),'statistic mismatch: 연구노트(화학).hwp groupStart.p95 reported 200, recomputed 292')



ROOT=Path(__file__).resolve().parents[4]
EVIDENCE=ROOT/'tests/integration/rhwp/evidence/t010-d4-performance-remediation'
OFFICIAL={'baseline-official-frozen-comparison.json':'48adaa0f748484d12f59f4805deda0480635f915368392a87e76e95962ec0b27',
          'optimized-official-retry.json':'ae34c12bd0d20aeb9f94610682bc678ec61f55722df74ea946d09782d7c87983'}


def producer():
    """undo_native.pct compiled alone; importing the module would load the native harness."""
    tree=ast.parse((ROOT/'tests/integration/rhwp/undo_native.py').read_text())
    node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='pct')
    namespace={};exec(compile(ast.Module(body=[node],type_ignores=[]),'undo_native.pct','exec'),namespace)
    return namespace['pct']


class ProducerPercentile(unittest.TestCase):
    def test_equivalent_to_official_producer(self):
        import random
        from d4_handler import producer_pct
        pct=producer();rng=random.Random(10)
        for n in (1,2,3,5,19,20,21,24,25,26,29,30,31,40):
            for _ in range(50):
                values=[rng.choice((rng.randint(0,400),round(rng.uniform(0,400),2),rng.uniform(0,400),-1)) for _ in range(n)]
                with self.subTest(values=values):self.assertEqual(producer_pct(values),pct(values))
        self.assertEqual(producer_pct([]),pct([]))
    def test_nearest_rank_canonical_counts(self):
        from d4_handler import producer_pct
        # ceil(p*n)-1 on ascending 1..n: never interpolated or averaged.
        for n,p50,p95 in ((30,15,29),(25,13,24),(20,10,19),(5,3,5)):
            with self.subTest(n=n):
                values=list(range(n,0,-1))
                self.assertEqual(producer_pct(values),dict(n=n,p50=p50,p95=p95,max=n,timeouts=0))
    def test_one_decimal_rounding_boundary(self):
        from d4_handler import producer_pct
        # Binary floats: 0.25 -> 0.2 and 0.35 -> 0.3; a decimal half-up policy would give 0.3/0.4.
        self.assertEqual(producer_pct([0.25])['p50'],0.2);self.assertEqual(producer_pct([0.35])['max'],0.3)
        self.assertEqual(producer_pct([12.34,12.36])['p95'],12.4)


class HandlerStatistics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from d4_handler import verified_fixtures
        cls.generated=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.generated.cleanup)
        subprocess.run(['node',str(ROOT/'tests/fixtures/rhwp/generate.mjs'),cls.generated.name],check=True,capture_output=True)
        cls.identities=verified_fixtures(Path(cls.generated.name))
        cls.records={name:json.loads((EVIDENCE/name).read_text()) for name in OFFICIAL}

    def check(self,mutate=lambda r:None,record='baseline-official-frozen-comparison.json'):
        from d4_handler import validate_handler
        r=copy.deepcopy(self.records[record]);mutate(r);validate_handler(r,OFFICIAL[record],self.identities)
    def reject(self,mutate,reason):
        with self.assertRaises(ValueError) as caught:self.check(mutate)
        self.assertIn(reason,str(caught.exception));return str(caught.exception)
    def doc(self,r,index=0):return r['measurements']['perf'][index]
    def samples(self,r,kind,index=0):return [s for s in self.doc(r,index)['timelineSamples'] if s['kind']==kind]
    def shift(self,sample,delta):
        # Keep keyToFrame == end-key and end >= raf1 so only the aggregate contract is exercised.
        sample['keyToFrame']=round(sample['keyToFrame']+delta,1);sample['at']['end']=round(sample['at']['end']+delta,1)

    def test_genuine_official_records_all_twenty_groups(self):
        from d4_handler import COUNTS
        pct=producer()
        for name,record in self.records.items():
            with self.subTest(record=name):
                self.assertIs(record['measurementComplete'],True);self.assertEqual(record['status'],'FAIL')
                self.check(record=name)
                groups=[(doc['sample'],kind) for doc in record['measurements']['perf'] for kind in COUNTS
                        if pct([s['keyToFrame'] for s in doc['timelineSamples'] if s['kind']==kind])=={k:doc[kind][k] for k in ('n','p50','p95','max','timeouts')}]
                self.assertEqual(len(groups),20)
    def test_pass_format_complete_is_valid(self):
        self.check(lambda r:r.update(status='PASS',exitReason='PASS',failedGateCount=0))
    def test_measurement_complete_exact_boolean(self):
        self.check(lambda r:r.update(measurementComplete=True))
        for value in (False,None,0,1,'true',[],0.0,'True'):
            with self.subTest(value=value):self.reject(lambda r:r.update(measurementComplete=value),'measurementComplete')
        self.assertIn("'<missing>'",self.reject(lambda r:r.pop('measurementComplete'),'measurementComplete'))
    def test_false_reported_statistics(self):
        for index,kind,key,value in ((0,'groupStart','p50',60),(2,'groupStart','p95',200),(0,'groupStart','max',97),
                                     (1,'undo','p95',166),(3,'redo','p50',239),(1,'undo','max',171),(0,'redo','max',999),
                                     (2,'extend','max',243),(0,'extend','p50',63),(0,'afterUndo','p50',129),(3,'afterUndo','max',999)):
            with self.subTest(kind=kind,key=key):
                reason=self.reject(lambda r:self.doc(r,index)[kind].update({key:value}),'statistic mismatch')
                self.assertIn(f"{self.records['baseline-official-frozen-comparison.json']['measurements']['perf'][index]['sample']} {kind}.{key} reported {value}",reason)
    def test_plausible_ordered_statistics(self):
        self.reject(lambda r:self.doc(r)['groupStart'].update(p50=40,p95=40,max=40),'groupStart.p50 reported 40, recomputed 61')
    def test_float_equal_reported_value_and_integer_types(self):
        self.check(lambda r:self.doc(r)['groupStart'].update(p50=61.0))
        for key,value in (('p95',True),('max',float('nan')),('p50',float('inf')),('p95','87'),('max',None)):
            with self.subTest(key=key,value=value):self.reject(lambda r:self.doc(r)['groupStart'].update({key:value}),'invalid measurement statistics')
        for key,value in (('n',30.0),('n',True),('timeouts',0.0)):
            with self.subTest(key=key,value=value):self.reject(lambda r:self.doc(r)['undo'].update({key:value}),'invalid canonical completion')
    def test_modified_raw_sample_with_stale_aggregate(self):
        self.reject(lambda r:self.shift(max(self.samples(r,'groupStart'),key=lambda s:s['keyToFrame']),25),'groupStart.max reported 87, recomputed 112')
        self.reject(lambda r:self.shift(max(self.samples(r,'redo',1),key=lambda s:s['keyToFrame']),25),'basic-ko.hwpx redo.max')
        self.reject(lambda r:self.shift(max(self.samples(r,'afterUndo',3),key=lambda s:s['keyToFrame']),25),'afterUndo.p95')
    def test_missing_duplicate_and_mislabelled_samples(self):
        def duplicate(r):
            groups=self.samples(r,'groupStart');timeline=self.doc(r)['timelineSamples']
            timeline[timeline.index(max(groups,key=lambda s:s['keyToFrame']))]=copy.deepcopy(min(groups,key=lambda s:s['keyToFrame']))
        self.reject(duplicate,'groupStart.p95 reported 87, recomputed 85')
        self.reject(lambda r:self.doc(r)['timelineSamples'].remove(self.samples(r,'undo')[0]),'canonical timeline counts')
        self.reject(lambda r:self.doc(r)['timelineSamples'].append(copy.deepcopy(self.samples(r,'redo')[0])),'canonical timeline counts')
        def relabel_extreme(r):
            redo=max(self.samples(r,'redo'),key=lambda s:s['keyToFrame']);undo=min(self.samples(r,'undo'),key=lambda s:s['keyToFrame'])
            redo['kind'],undo['kind']='undo','redo'
        self.reject(relabel_extreme,'statistic mismatch')
    def test_invalid_raw_latencies(self):
        for value in (-1,float('nan'),float('inf'),True,None,'61'):
            with self.subTest(value=value):
                self.reject(lambda r:self.samples(r,'extend')[0].update(keyToFrame=value),'invalid canonical timeline measurement')
    def test_serialized_sample_rejects_unrounded_raw_latency(self):
        # pct accepts raw floats, but timeline_samples serializes keyToFrame/end
        # at one decimal. 87.25 is not a possible official serialized sample.
        def mutate(r):
            top=max(self.samples(r,'groupStart'),key=lambda s:s['keyToFrame'])
            top['keyToFrame']=87.25;top['at']['end']=87.25
            self.doc(r)['groupStart'].update(max=87.2)
        self.reject(mutate,'precision')



if __name__=='__main__':unittest.main()
