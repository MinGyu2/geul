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


if __name__=='__main__':unittest.main()
