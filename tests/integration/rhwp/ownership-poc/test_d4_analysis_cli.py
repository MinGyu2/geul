"""Confirmed P0 identity/loss/type/CLI exit regressions, no generic fuzz corpus."""
import copy
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
        self.wasm=artifacts['rhwp_bg.wasm'];self.fixture=self.work/'fixture.hwp';self.fixture.write_bytes(b'authoritative unit fixture')
        self.source=hashlib.sha256(self.fixture.read_bytes()).hexdigest()
    def run_cli(self,result,**options):
        source=self.work/'source.json';output=self.work/'output.json'
        if output.exists():output.unlink()
        source.write_text(result if isinstance(result,str) else json.dumps(result))
        cmd=['python3',str(Path(__file__).with_name('analyze-d4.py')),'input-delay',str(source),str(output),
             '--fixture',str(self.fixture),'--expected-wasm',options.get('wasm',self.wasm),'--candidate',str(self.package)]
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
             '--fixture',str(self.fixture),'--expected-wasm',self.wasm,'--candidate',str(self.package)]
        p=subprocess.run(cmd,capture_output=True);self.assertNotEqual(p.returncode,0);self.assertEqual(output.read_bytes(),old)
    def test_claimed_wasm_cannot_be_its_expectation(self):
        r=self.valid();r['engineIdentity']['wasmSha256']='a'*64;p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_claimed_source_cannot_be_its_expectation(self):
        r=self.valid();r['sourceSha256']='b'*64;p,out=self.run_cli(r);self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
    def test_arbitrary_expected_digest_rejected_by_artifact(self):
        p,out=self.run_cli(self.valid(),wasm='a'*64);self.assertNotEqual(p.returncode,0);self.assertIn('artifact',out['error'])
    def test_artifact_tampering(self):
        (self.package/'rhwp_bg.wasm').write_bytes(b'changed');p,out=self.run_cli(self.valid());self.assertNotEqual(p.returncode,0);self.assertEqual(out['status'],'FAIL')
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


if __name__=='__main__':unittest.main()
