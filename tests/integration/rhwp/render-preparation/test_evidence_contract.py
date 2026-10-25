"""실제 실행을 대체하지 않는 증거 판정기 음성 회귀."""
import copy, unittest
from pathlib import Path
from evidence_contract import validate,NAMES,FIXTURE_SHA256
import native_result as native

def fixture():
 def job(phase,steps,count,replays=0):
  return dict(
   id=1,phase=phase,steps=steps,attempts=steps,
   readyTransitions=int(phase!='Preparing'),yields=steps,replays=replays,
   retainedBytes=1000 if count else 0,
   decodeAttempts=12 if replays else count,
   transformAttempts=0,readyReuses=4 if replays else 0,
   memoHits=0,memoCount=0,
   keys=count,
  )
 def snapshot(j):return dict(preparation=dict(enabled=True,maxOwnedBytes=64<<20,maxJobBytes=32<<20,resourceQuantum=4,stepQuantum=256,ownedBytes=j['retainedBytes'],jobs=[j]),pendingCount=0,maxPending=2,maxResources=256,maxOwnedBytes=256<<20,temporaryCanvasBytes=0,backupImageDataBytes=0,peakTemporaryCanvasBytes=1024,peakBackupImageDataBytes=1024)
 seq=[job('Preparing',0,0),job('Preparing',4,4),job('Preparing',8,8),job('ResourcesReady',12,12),job('Terminal',12,0,1)]
 rows=[dict(label='multi-poll',id=1,ms=1.,outcome='COMPLETE' if n==3 else 'PENDING',before=snapshot(seq[n]),after=snapshot(seq[n+1]),atomicPending=True) for n in range(4)]
 rgba=[dict(temperature=t,trial=n,page=p,pixels=0,maxDelta=0,width=100,height=100,referenceNonWhite=200,candidateOutcome='COMPLETE',referenceOutcome='COMPLETE',scale=.5,dpr=1,sourceSha256=FIXTURE_SHA256['연구노트(화학).hwp']) for t in ('cold','warm') for n in range(3) for p in (14,15,16,19,20,21,23)]
 cleanup=dict(activeJobs=0,uniqueResourceCount=0,pendingCount=0,decodedRegistryEntries=0,preparation={'ownedBytes':0},decodedLedger=dict(uniqueBytes=0,uniqueCount=0,reservedBytes=0,created=12,disposed=12))
 return dict(schema=1,contract=1,status='PASS',tests=[dict(name=n,status='PASS') for n in NAMES],transitions=rows,rgba=rgba,performance=[dict(totalMs=5,maxPollMs=1,polls=4,outcome='COMPLETE') for _ in rgba],cleanup={'candidate':cleanup})

class EvidenceTests(unittest.TestCase):
 def reject(self,edit):
  v=fixture();edit(v)
  with self.assertRaises((ValueError,TypeError,KeyError,StopIteration)):validate(v)
 def test_synthetic_contract_shape(self):validate(fixture())
 def test_schema(self):
  for x in (1.,'1',True,None,2):
   with self.subTest(x=x):self.reject(lambda v:v.update(schema=x))
 def test_tests_missing_reordered_duplicate_failed(self):
  for edit in (lambda v:v['tests'].pop(),lambda v:v['tests'].reverse(),lambda v:v['tests'].append(v['tests'][0]),lambda v:v['tests'][0].update(status='FAIL'),lambda v:v['tests'].__setitem__(0,None)):
   self.reject(edit)
 def test_no_real_cursor_or_retained_resource(self):
  self.reject(lambda v:v.update(transitions=[]));self.reject(lambda v:[r['after']['preparation']['jobs'][0].update(phase='Terminal') for r in v['transitions']])
 def test_no_ready_boundary(self):self.reject(lambda v:v['transitions'][2]['after']['preparation']['jobs'][0].update(replays=1))
 def test_quantum_bound(self):self.reject(lambda v:v['transitions'][0]['after']['preparation']['jobs'][0].update(attempts=5))
 def test_not_atomic(self):self.reject(lambda v:v['transitions'][0].update(atomicPending=False))
 def test_timing_rejects_invalid_numeric(self):
  for x in (-1,True,float('nan'),float('inf'),'1',10**400):
   with self.subTest(x=str(x)[:20]):self.reject(lambda v:v['transitions'][0].update(ms=x))
 def test_limits_and_counter_types(self):
  for k,x in [('maxOwnedBytes',65<<20),('ownedBytes',True),('resourceQuantum',5),('jobs',{})]:
   with self.subTest(k=k):self.reject(lambda v:v['transitions'][0]['after']['preparation'].update({k:x}))
  self.reject(lambda v:v['transitions'][0]['after']['preparation']['jobs'][0].update(keys=257))
 def test_duplicate_job(self):self.reject(lambda v:v['transitions'][0]['after']['preparation']['jobs'].append(v['transitions'][0]['after']['preparation']['jobs'][0]))
 def test_decode_repetition(self):self.reject(lambda v:v['transitions'][-1]['after']['preparation']['jobs'][0].update(decodeAttempts=13))
 def test_rgba_identity_and_actual_pixels(self):
  for edit in (lambda v:v['rgba'].pop(),lambda v:v['rgba'][0].update(pixels=1),lambda v:v['rgba'][0].update(sourceSha256='0'*64),lambda v:v['rgba'][0].update(referenceNonWhite=0),lambda v:v['rgba'][0].update(page=14.)):
   self.reject(edit)
 def test_cleanup_exact_types_and_last_owner(self):
  for k,x in [('activeJobs',False),('uniqueResourceCount',1),('decodedRegistryEntries',1)]:self.reject(lambda v:v['cleanup']['candidate'].update({k:x}))
  self.reject(lambda v:v['cleanup']['candidate']['decodedLedger'].update(disposed=11))
 def test_performance_required(self):self.reject(lambda v:v.pop('performance'))
 def test_strict_json(self):
  for s in ('{"x":1,"x":2}','{"x":NaN}','{"x":Infinity}'):
   with self.assertRaises(ValueError):native.loads_strict(s)
 def test_native_manifest_malformed(self):
  b={k:'a'*64 for k in native.DEPENDENCIES};b.update({p:native.FIXTURE_SHA256[n] for n,p in native.baseline.PINNED_FIXTURES.items()});identity={k:b[k] for k in native.baseline.TRUSTED_KEYS}
  v=native.Verdict();native.check_dependencies(v,b,b,4,identity);self.assertFalse(v.failures)
  for edit in (lambda x:x.pop(native.NATIVE_WRAPPER),lambda x:x.update(extra='a'*64),lambda x:x.update({native.NATIVE_WRAPPER:None}),lambda x:x.update({native.NATIVE_WRAPPER:'A'*64})):
   a=copy.deepcopy(b);edit(a);v=native.Verdict();native.check_dependencies(v,b,a,4,identity);self.assertTrue(v.failures)
  v=native.Verdict();native.check_dependencies(v,b,list(b.items())+list(b.items())[:1],4,identity);self.assertTrue(v.failures)
 def test_native_exit_exact_schema_and_subprocess(self):
  good=dict(schema=native.SCHEMA,status='PASS',failures=[],categories=[]);self.assertEqual(native.exit_code(good,0),0)
  for x in (4.,'4',True,False,None,3):self.assertNotEqual(native.exit_code({**good,'schema':x},0),0)
  for x in (0.,True,None,-9,1):self.assertNotEqual(native.exit_code(good,x),0)
  self.assertEqual(native.exit_code(good,7),7)
  for k,x in [('failures',()),('categories',None),('status',True)]:self.assertNotEqual(native.exit_code({**good,k:x},0),0)

class NativeContractTests(unittest.TestCase):
 def arguments(self):
  import json
  import test_native_d1_result as old
  root=Path(__file__).resolve().parents[4]
  identity=json.loads((root/native.TRUST_ANCHOR['path']).read_text())['artifacts']
  r=old.complete_result();r['engineIdentity']['wasmSha256']=identity['rhwp_bg.wasm']
  r['lastObserved']={'jobs':{'preparation':{'enabled':True,'ownedBytes':0}}}
  r['adapterCounters']={'preparation':{'polls':2,'ready':1,'complete':1,'maxPollMs':1.,'witnesses':[dict(enabled=True,phase='ResourcesReady',outcome='PENDING',ms=1.,readyTransitions=1,replays=0)]}}
  deps={k:'a'*64 for k in native.DEPENDENCIES};deps.update(identity);deps.update({p:native.FIXTURE_SHA256[n] for n,p in native.baseline.PINNED_FIXTURES.items()})
  return dict(harness_exit=0,result=r,result_error=None,expected_wasm=identity['rhwp_bg.wasm'],candidate_wasm_before=identity['rhwp_bg.wasm'],candidate_wasm_after=identity['rhwp_bg.wasm'],dependencies_before=deps,dependencies_after=copy.deepcopy(deps),lifecycle=old.complete_lifecycle(),trusted_identity=identity,manifest_version=4,attempt=1)
 def test_new_contract_delegates_all_strict_d1_invariants(self):
  v=native.validate(**self.arguments());self.assertEqual(v['status'],'PASS',v);self.assertEqual(native.exit_code(v,0),0);self.assertEqual(v['trustAnchor'],native.TRUST_ANCHOR)
 def test_observation_missing_malformed_or_self_asserted(self):
  for edit in (lambda r:r.pop('lastObserved'),lambda r:r.update(lastObserved={'jobs':None}),lambda r:r['lastObserved']['jobs']['preparation'].update(enabled=False),lambda r:r['adapterCounters']['preparation'].update(ready=True),lambda r:r['adapterCounters']['preparation'].update(witnesses=[]),lambda r:r['adapterCounters']['preparation']['witnesses'][0].update(replays=1)):
   kw=self.arguments();edit(kw['result']);v=native.validate(**kw);self.assertEqual(v['status'],'FAIL');self.assertNotEqual(native.exit_code(v,0),0)
 def test_core_assertion_fixture_lifecycle_teardown_retained(self):
  for edit in (lambda a:a['result']['tests'].pop(),lambda a:a['result']['documents'][0].update(sourceSha256='0'*64),lambda a:a['result']['teardown'][0].update(driverKilled=True),lambda a:a['lifecycle']['processes'][0].pop('pid'),lambda a:a.update(manifest_version=3),lambda a:a['dependencies_after'].update({native.NATIVE_WRAPPER:'b'*64})):
   kw=self.arguments();edit(kw);v=native.validate(**kw);self.assertEqual(v['status'],'FAIL');self.assertNotEqual(native.exit_code(v,0),0)
 def test_anchor_bytes_and_committed_lookup(self):
  from unittest.mock import patch
  root=Path(__file__).resolve().parents[4];blob=(root/native.TRUST_ANCHOR['path']).read_bytes()
  with patch.object(native.subprocess,'check_output',return_value=blob) as call:
   identity=native.load_trust_anchor(root);self.assertEqual(set(identity),set(native.baseline.TRUSTED_KEYS));self.assertIn('HEAD:',call.call_args.args[0][-1])
  with patch.object(native.subprocess,'check_output',return_value=blob+b' '):
   with self.assertRaises(ValueError):native.load_trust_anchor(root)

class AuxiliaryContractTests(unittest.TestCase):
 def arguments(self,kind):
  import auxiliary_result as aux
  import json
  kw=NativeContractTests().arguments();root=Path(__file__).resolve().parents[4]
  original=json.loads((root/'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization'/('native-'+kind+'.json')).read_text())
  self.assertEqual([t['name'] for t in original['tests']],list(aux.EXPECTED[kind]))
  original['teardown']=kw['result']['teardown'];original['lastObserved']['jobs']['preparation']={'enabled':True,'ownedBytes':0};original['engineIdentity']['wasmSha256']=kw['expected_wasm'];kw['result']=original
  for key in ('dependencies_before','dependencies_after'):kw[key].update({n:'a'*64 for n in aux.DEPENDENCIES if n not in kw[key]})
  kw['manifest_version']=5;kw['auxiliary_kind']=kind;return kw
 def test_exact_genuine_historical_names_and_representation(self):
  import auxiliary_result as aux
  for kind in ('pending','safety'):
   v=aux.validate(**self.arguments(kind));self.assertEqual(v['status'],'PASS',v);self.assertEqual(aux.exit_code(v,0),0)
 def test_missing_test_and_teardown_rejected(self):
  import auxiliary_result as aux
  for edit in (lambda x:x['result']['tests'].pop(),lambda x:x['result'].pop('teardown'),lambda x:x.update(auxiliary_kind='other')):
   kw=self.arguments('safety');edit(kw);v=aux.validate(**kw);self.assertEqual(v['status'],'FAIL');self.assertNotEqual(aux.exit_code(v,0),0)

if __name__=='__main__':unittest.main()
