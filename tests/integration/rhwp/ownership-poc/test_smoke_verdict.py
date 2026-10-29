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


def good_teardown():
    return {'complete':True,'driverKilled':False,'driverExit':0,'sessionDeletes':[{'outcome':'ok'}],
            'remainingAfterWait':[],'survivorsAfterSigterm':[],'sigtermErrors':[]}


def add_teardown(result):
    result['attemptId']='current';result['teardownAttemptId']='current';result['teardown']=good_teardown()
    return result


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
        result=add_teardown({'failures':[]}); m.stop_owned(FakeProcess(),'vite',result);m.stop_owned(FakeProcess(),'xvfb',result)
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

class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.before={'document':'1','localRevision':1,'revision':1,'modelVersion':1}
        self.after={'document':'1','localRevision':2,'revision':2,'modelVersion':2}
        self.comparison={'verified':True,'pixels':0,'width':828,'height':1170}
        self.attached={'page':0,'connected':True,'width':828,'height':1170}
        self.completed=[{'event':'complete','state':'COMPLETE','page':0,'version':2,'job':3}]

    def test_cleanup_evidence_fail_closed(self):
        for cleanup in ({},{'vite':{'ok':True}},{'xvfb':{'ok':True}},
                        {'vite':{'ok':False},'xvfb':{'ok':True}}, {'vite':{'ok':True},'xvfb':{'ok':False}},
                        {'vite':{'ok':True,'returncode':None},'xvfb':{'ok':True}}, {'vite':{'ok':True,'survivors':[7]},'xvfb':{'ok':True}}):
            with self.subTest(cleanup=cleanup):
                r={'failures':[],'cleanup':cleanup};self.assertFalse(m.finalize(r,True));self.assertEqual(r['executionStatus'],'FAIL')
        r=add_teardown({'failures':[],'cleanup':{'vite':{'ok':True},'xvfb':{'ok':True}}})
        self.assertTrue(m.finalize(r,True));self.assertIn('not independently tracked',r['cleanupScope'])
        for td in ({'complete':False},{'complete':True,'driverKilled':False,'sessionDeletes':[{'outcome':'error'}]},
                   {'complete':True,'driverKilled':False,'sessionDeletes':[{'outcome':'ok'}],'remainingAfterWait':[1]}):
            r['teardown']=td;self.assertFalse(m.finalize(r,True))

    def test_teardown_is_required_and_bound_to_attempt(self):
        for bad in (None, {}, [], {'complete':False}, {**good_teardown(),'sessionDeletes':[]},
                    {**good_teardown(),'sessionDeletes':[{'outcome':'error'}]},
                    {**good_teardown(),'driverExit':None}, {**good_teardown(),'driverKilled':True},
                    {**good_teardown(),'remainingAfterWait':[{'pid':1}]},
                    {**good_teardown(),'survivorsAfterSigterm':[{'pid':2}]},
                    {**good_teardown(),'sigtermErrors':['fault']}):
            with self.subTest(teardown=bad):
                r=add_teardown({'failures':[],'cleanup':{'vite':{'ok':True},'xvfb':{'ok':True}}});r['teardown']=bad
                self.assertFalse(m.finalize(r,True));self.assertEqual(r['executionStatus'],'FAIL')
        r=add_teardown({'failures':[],'cleanup':{'vite':{'ok':True},'xvfb':{'ok':True}}});del r['teardown']
        self.assertFalse(m.finalize(r,True));self.assertEqual(r['status'],'FAIL')
        r=add_teardown({'failures':[],'cleanup':{'vite':{'ok':True},'xvfb':{'ok':True}}});r['teardownAttemptId']='previous'
        self.assertFalse(m.finalize(r,True))
        records=[good_teardown()];r={'attemptId':'new'}
        self.assertFalse(m.attach_teardown(r,records,1));self.assertNotIn('teardown',r)
        records.append(good_teardown());self.assertTrue(m.attach_teardown(r,records,1));self.assertEqual(r['teardownAttemptId'],'new')
        records.append(good_teardown());self.assertFalse(m.attach_teardown(r,records,1));self.assertNotIn('teardown',r)

    def test_oracle_fail_closed(self):
        def assess(comp=None, attached=None, version=2, stable=True, jobs=None):
            return m.assess_oracle(True,self.comparison if comp is None else comp,self.attached if attached is None else attached,2,version,stable,self.completed if jobs is None else jobs)
        self.assertEqual(assess()['status'],'PASS')
        for bad in ({'verified':True,'pixels':8,'width':828,'height':1170}, {'verified':False,'pixels':0,'width':828,'height':1170},
                    {'verified':True,'width':828,'height':1170}, {'verified':True,'pixels':None,'width':828,'height':1170},
                    {'verified':True,'pixels':False,'width':828,'height':1170}, {'verified':True,'pixels':-1,'width':828,'height':1170},
                    {'verified':True,'pixels':0,'width':0,'height':1170}, []):
            with self.subTest(bad=bad): self.assertEqual(assess(comp=bad)['status'],'FAIL')
        for kwargs in ({'stable':False},{'version':3},{'jobs':[]},{'jobs':[{'event':'complete','state':'COMPLETE','page':1,'version':2,'job':3}]},{'attached':{'page':1,'connected':True,'width':828,'height':1170}}):
            self.assertEqual(assess(**kwargs)['status'],'FAIL')
        self.assertEqual(m.assess_oracle(False,None,None,None,None,None,None)['status'],'NOT RUN')
        self.assertEqual(m.assess_oracle(True,None,self.attached,2,2,True,self.completed)['status'],'FAIL')
        r=add_teardown({'failures':[],'cleanup':{'vite':{'ok':True},'xvfb':{'ok':True}},'oracleEnabled':True,'oracleAssessment':{'status':'FAIL'}})
        self.assertFalse(m.finalize(r,True));self.assertEqual(r['status'],'FAIL')
        del r['oracleAssessment'];self.assertFalse(m.finalize(r,True))
        r.update(oracleAssessment={'status':'PASS','errors':[]},fixtureExpectedSha256=m.EXPECTED_FIXTURE,fixtureSha256=m.EXPECTED_FIXTURE,fixtureUnchanged=True,
                 candidate={'wasmSha256':'0cb73f70cd98dbef89718534e1bc283f1cb4c200af200703d40b137be1cde956'},revisionObservation={'after':{'modelVersion':2}},
                 visibleFrame={'comparison':dict(self.comparison),'attached':self.attached,'modelVersion':2,'revisionStable':True,'completedJobs':self.completed})
        self.assertTrue(m.finalize(r,True));r['visibleFrame']['comparison']['pixels']=8
        self.assertFalse(m.finalize(r,True));self.assertEqual(r['status'],'FAIL')

    def test_input_timeline_order_and_rounding(self):
        def run(offset, observed, key=10, input_time=None):
            stage={'kind':'type','at':{'key':0,'input':offset,'observed':observed,'raf1':observed+1,'end':observed+2}}
            return m.verify_observation(self.before,self.after,stage,0,1,1,1,key,input_time if input_time is not None else key+offset)
        self.assertTrue(run(2,3));self.assertTrue(run(-1,0));self.assertTrue(run(1.05,1))
        for offset,observed in ((10,5),(10,2),(float('nan'),1),(float('inf'),1)):
            with self.assertRaises(ValueError):run(offset,observed)
        with self.assertRaises(ValueError):run(2,3,input_time=12.2)
        stage={'kind':'type','at':{'key':0,'observed':1,'raf1':2,'end':3}}
        with self.assertRaises(ValueError):m.verify_observation(self.before,self.after,stage,0,1,1,1,10,11)
        with self.assertRaises(ValueError):m.verify_observation(self.before,self.after,stage,1,1,1,1)

    def test_atomic_persist_and_serialization_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            target=Path(folder)/'result.json';r={'text':'한😀','failures':[]}
            self.assertTrue(m.persist_result(r,target));self.assertEqual(json.loads(target.read_text()),r)
            previous=target.read_bytes()
            with mock.patch('sys.stderr'):self.assertFalse(m.persist_result({'failures':[]},target))
            self.assertEqual(target.read_bytes(),previous)
            for value in (object(),float('nan'),float('inf')):
                path=Path(folder)/('bad'+str(len(list(Path(folder).iterdir()))));result={'bad':value,'failures':[]}
                with mock.patch('sys.stderr'):self.assertFalse(m.persist_result(result,path))
                self.assertFalse(path.exists())

    def test_atomic_storage_faults(self):
        for method in ('mkstemp','fsync','link'):
            with self.subTest(method=method), tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'result.json';result={'failures':[]}
                target=m.tempfile if method=='mkstemp' else m.os
                with mock.patch.object(target,method,side_effect=OSError('injected')), mock.patch('sys.stderr'):
                    self.assertFalse(m.persist_result(result,path))
                self.assertFalse(path.exists());self.assertEqual(result['evidenceStatus'],'FAIL')
                pending=list(Path(folder).glob('*.pending'))
                self.assertEqual(len(pending),1 if method=='link' else 0)
                if pending:self.assertEqual(json.loads(pending[0].read_text())['evidenceStatus'],'PASS')

    def test_atomic_partial_write_and_flush_failure(self):
        for method in ('write','short','flush'):
            with self.subTest(method=method), tempfile.TemporaryDirectory() as folder:
                path=Path(folder)/'result.json';result={'failures':[]};real_fdopen=m.os.fdopen
                unrelated=Path(folder)/'other.pending';unrelated.write_text('keep')
                class Broken:
                    def __init__(self, fd, mode): self.real=real_fdopen(fd,mode)
                    def __enter__(self): return self
                    def __exit__(self,*args): self.real.close()
                    def write(self,data):
                        if method=='write': self.real.write(data[:4]); raise OSError('partial write')
                        if method=='short': return self.real.write(data[:4])
                        return self.real.write(data)
                    def flush(self):
                        if method=='flush': raise OSError('flush fault')
                        return self.real.flush()
                    def fileno(self): return self.real.fileno()
                with mock.patch.object(m.os,'fdopen',side_effect=Broken), mock.patch('sys.stderr'):
                    self.assertFalse(m.persist_result(result,path))
                self.assertFalse(path.exists());self.assertEqual(unrelated.read_text(),'keep')
                self.assertEqual(list(Path(folder).glob('*.pending')),[unrelated])

    def test_exclusive_staging_collision_preserves_other_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'result.json'; other=Path(folder)/'.result.json.other.pending';other.write_text('unrelated')
            with mock.patch.object(m.tempfile,'mkstemp',side_effect=FileExistsError('collision')), mock.patch('sys.stderr'):
                self.assertFalse(m.persist_result({'failures':[]},path))
            self.assertFalse(path.exists());self.assertEqual(other.read_text(),'unrelated')

    def test_serialization_exception_does_not_create_final(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'result.json'
            with mock.patch.object(m.json,'dumps',side_effect=RuntimeError('serialization fault')), mock.patch('sys.stderr'):
                self.assertFalse(m.persist_result({'failures':[]},path))
            self.assertFalse(path.exists());self.assertEqual(list(Path(folder).iterdir()),[])

    def test_typing_is_stdlib(self):
        import typing
        self.assertNotEqual(Path(typing.__file__).resolve(),Path(__file__).with_name('typing.py').resolve())
        self.assertNotEqual(Path(typing.__file__).resolve().parent,Path(__file__).resolve().parent)

if __name__ == '__main__': unittest.main()
