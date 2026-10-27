"""Hermetic fault injection for smoke verdict; never launches native processes."""
import importlib.util
import json
import sys
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('smoke_verdict', Path(__file__).with_name('smoke_verdict.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeProcess:
    def __init__(self, terminate_error=False, wait_timeout=False, kill_error=False):
        self.code = None; self.terminate_error = terminate_error; self.wait_timeout = wait_timeout; self.kill_error = kill_error; self.kills = 0
    def poll(self): return self.code
    def terminate(self):
        if self.terminate_error: raise OSError('terminate fault')
        if not self.wait_timeout: self.code = -15
    def wait(self, timeout):
        if self.wait_timeout and self.code is None: raise subprocess.TimeoutExpired('fake', timeout)
        return self.code
    def kill(self):
        self.kills += 1
        if self.kill_error: raise OSError('kill fault')
        self.code = -9


class SmokeVerdictTests(unittest.TestCase):
    def test_cleanup_failure_never_succeeds(self):
        for label in ('vite','xvfb'):
            for args in ({'terminate_error':True},{'wait_timeout':True},{'wait_timeout':True,'kill_error':True}):
                with self.subTest(label=label,args=args):
                    result={'failures':[]}; m.stop_owned(FakeProcess(**args),label,result)
                    self.assertFalse(m.finalize(result,True)); self.assertEqual(result['status'],'FAIL')
                    self.assertIn(label+'-',result['failures'][0]['stage'])
    def test_normal_cleanup_and_failure_order(self):
        result={'failures':[]}; m.stop_owned(FakeProcess(),'vite',result);m.stop_owned(FakeProcess(),'xvfb',result)
        self.assertTrue(m.finalize(result,True)); self.assertEqual(result['cleanupStatus'],'PASS')
        m.failure(result,'webdriver',RuntimeError('original')); m.stop_owned(FakeProcess(terminate_error=True),'vite',result)
        m.stop_owned(FakeProcess(terminate_error=True),'xvfb',result)
        self.assertFalse(m.finalize(result,True));self.assertEqual(result['failures'][0]['message'],'original')
        self.assertTrue(any(f['stage']=='xvfb-terminate' for f in result['failures']))
    def test_pending_execution_error_is_recorded_before_cleanup_failure(self):
        result={'failures':[]};seen=set()
        try:
            try: raise ValueError('original execution')
            finally:
                m.record_pending(result,'execution',seen)
                m.stop_owned(FakeProcess(terminate_error=True),'vite',result)
                m.stop_owned(FakeProcess(terminate_error=True),'xvfb',result)
        except ValueError as error:
            self.assertIn(id(error),seen)
        self.assertEqual([f['stage'] for f in result['failures']],['execution','vite-terminate','xvfb-terminate'])
        self.assertFalse(m.finalize(result,True))

    def test_persistence_failure_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'evidence.json';path.write_text('previous')
            result={'status':'PARTIAL','failures':[]}
            with mock.patch('sys.stderr'): self.assertFalse(m.persist_result(result,path))
            self.assertEqual(path.read_text(),'previous');self.assertEqual(result['failures'][-1]['stage'],'evidence-persistence');self.assertEqual(result['status'],'FAIL')
    def test_fixture_mismatch_and_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'fixture';result={}
            with self.assertRaises(FileNotFoundError):m.verify_fixture(p,result)
            p.write_bytes(b'wrong')
            with self.assertRaises(ValueError):m.verify_fixture(p,result)
            self.assertEqual(result['fixtureExpectedSha256'],m.EXPECTED_FIXTURE)
    def test_fixture_success_using_mocked_expected_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'fixture';p.write_bytes(b'fixture')
            with mock.patch.object(m,'EXPECTED_FIXTURE',m.hashlib.sha256(b'fixture').hexdigest()):
                self.assertEqual(m.verify_fixture(p,{}),m.EXPECTED_FIXTURE)
    def test_unexpected_sigkill_is_not_graceful(self):
        p=FakeProcess();p.terminate=lambda: setattr(p,'code',-9)
        result={'failures':[]};m.stop_owned(p,'vite',result)
        self.assertFalse(m.finalize(result,True));self.assertEqual(result['failures'][0]['stage'],'vite-exit')

    def test_fixture_changed_during_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'fixture';p.write_bytes(b'original');before=m.hashlib.sha256(p.read_bytes()).hexdigest()
            self.assertTrue(m.verify_unchanged(p,before));p.write_bytes(b'changed')
            with self.assertRaises(ValueError):m.verify_unchanged(p,before)

    def test_isolated_cleanup_failure_exit_is_nonzero(self):
        script = '''import importlib.util,sys
spec=importlib.util.spec_from_file_location("sv",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class P:
 def poll(self): return None
 def terminate(self): raise OSError("injected")
 def wait(self,timeout): raise TimeoutError("injected")
 def kill(self): raise OSError("injected")
r={"failures":[]};m.stop_owned(P(),"vite",r);ok=m.finalize(r,True);sys.exit(0 if ok else 1)
'''
        completed=subprocess.run([sys.executable,'-I','-c',script,str(Path(__file__).with_name('smoke_verdict.py'))],capture_output=True,text=True,timeout=5)
        self.assertEqual(completed.returncode,1,completed.stderr)

    def test_revision_and_raf_validation(self):
        before={'document':'1:1','localRevision':1,'revision':1,'modelVersion':1};after={'document':'1:1','localRevision':2,'revision':2,'modelVersion':2}
        stage={'kind':'type','at':{'key':0,'observed':1,'raf1':2,'end':3}}
        self.assertTrue(m.verify_observation(before,after,stage,0,1,1,1))
        for changed in ({'document':'2:1','localRevision':2,'revision':2,'modelVersion':2},before,{'document':'1:1','localRevision':2,'revision':1,'modelVersion':2}):
            with self.assertRaises(ValueError):m.verify_observation(before,changed,stage,0,1,1,1)
        for at in ({'key':0,'observed':1,'raf1':None,'end':3},{'key':0,'observed':3,'raf1':2,'end':4},{'key':0,'observed':float('nan'),'raf1':2,'end':3}):
            with self.assertRaises(ValueError):m.verify_observation(before,after,{'kind':'type','at':at},0,1,1,1)
        with self.assertRaises(ValueError):m.verify_observation(before,after,stage,1,1,1,1)
        with self.assertRaises(ValueError):m.verify_observation(before,after,stage,0,1,2,1)
        timed={'kind':'type','at':{'key':0,'input':2,'observed':3,'raf1':4,'end':5}}
        self.assertTrue(m.verify_observation(before,after,timed,0,1,1,1,10,12))
        with self.assertRaises(ValueError):m.verify_observation(before,after,timed,0,1,1,1,10,13)
        with self.assertRaises(ValueError):m.verify_observation(before,after,{'kind':'undo','at':timed['at']},0,1,1,1,10,12)

if __name__ == '__main__': unittest.main()
