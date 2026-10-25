"""보조 native pending/D3/D5 계약5. D1 39/24 수용 계약과 구별한다."""
from pathlib import Path
import hashlib,sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import native_result as current
from native_result import loads_strict,Verdict,SAMPLES,FIXTURE_SHA256,pinned_samples_valid,TRUST_ANCHOR,load_trust_anchor
SCHEMA=5
CURRENT_MANIFEST=5
NATIVE_WRAPPER=current.PREFIX+'run-auxiliary.py'
DEPENDENCIES=current.DEPENDENCIES+(NATIVE_WRAPPER,current.SUPPORT+'auxiliary_result.py',current.SUPPORT+'auxiliary_harness.py','tests/integration/rhwp/ownership-poc/history-pending-native.py','tests/integration/rhwp/ownership-poc/candidate-safety.py')
# 기존 독립 실행의 정확한 이름 계약. 결과 JSON으로 기대 집합을 고르지 않는다.
EXPECTED={
 'pending':('bootstrap-clean-close',)+tuple(fmt+'-'+suffix for fmt in ('hwp','hwpx') for suffix in ('genuine-pending-history-document','edit-supersedes-pending-exact','undo-images-exact','redo-images-exact','pending-history-model-revisions','trim-pending-preserves-visible-frame','replacement-before-late-exact','replacement-after-late-exact','late-callback-no-publication-or-mutation','history-close-all-resources-zero'))+('native-final-resource-cleanup',),
 'safety':('bootstrap-clean-close','native-T009-save-matrix','observer-reaches-authoritative-WASM')+tuple(fmt+'-'+suffix for fmt in ('hwp','hwpx') for suffix in ('undo-service-save','redo-service-save','discard-failure-reload'))+tuple(fmt+'-'+suffix for fmt in ('hwp','hwpx') for suffix in ('history-failure-image-resources-established','history-failure-image-cleanup'))+('native-final-resource-cleanup',),
}

def dependency_digests(root,candidate,version=CURRENT_MANIFEST):
 if type(version) is not int or version!=5:raise ValueError('보조 manifest5 required')
 values=current.dependency_digests(root,candidate,4)
 for n in DEPENDENCIES:
  if n in values:continue
  try:values[n]=hashlib.sha256((root/n).read_bytes()).hexdigest()
  except OSError:values[n]=None
 return values

def check_dependencies(v,before,after,version,trusted):
 if not v.require(type(version) is int and version==5,'dependency-manifest','보조 manifest5 required'):return
 for label,values in [('before',before),('after',after)]:
  v.require(type(values) is dict and set(values)==set(DEPENDENCIES) and all(current.baseline.sha256_text(h) for h in values.values()),'dependency-manifest',label+' 보조 manifest 구조/신원 누락')
 def project(x):return {k:x[k] for k in current.DEPENDENCIES if type(x) is dict and k in x}
 current.check_dependencies(v,project(before),project(after),4,trusted)
 v.require(before==after,'dependency-mutation','보조 실행 입력 변경')

def validate(*,auxiliary_kind,**kw):
 v=Verdict();b=current.baseline;trusted=kw['trusted_identity']
 check_dependencies(v,kw['dependencies_before'],kw['dependencies_after'],kw['manifest_version'],trusted)
 v.require(type(kw['harness_exit']) is int and kw['harness_exit']==0,'native-subprocess','보조 producer 비정상 종료')
 v.require(type(trusted) is dict and set(trusted)==set(b.TRUSTED_KEYS) and all(b.sha256_text(h) for h in trusted.values()),'candidate-identity','새 anchor 없음')
 wasm=trusted.get('rhwp_bg.wasm') if type(trusted) is dict else None
 v.require(wasm is not None and kw['expected_wasm']==wasm and kw['candidate_wasm_before']==wasm and kw['candidate_wasm_after']==wasm,'candidate-identity','보조 후보 바이트 불일치')
 r=kw['result'];valid=v.require(type(r) is dict and kw['result_error'] is None,'missing-result','보조 결과 없음/잘못된 JSON')
 if valid:
  tests=r.get('tests');v.require(r.get('status')=='PASS' and 'error' not in r,'failed-assertions','보조 producer FAIL')
  v.require(auxiliary_kind in EXPECTED and type(tests) is list and [t.get('name') if type(t) is dict else None for t in tests]==list(EXPECTED[auxiliary_kind]) and all(t.get('status')=='PASS' for t in tests),'incomplete-verification','정확한 보조 시험 집합 불충족')
  v.require(r.get('engineIdentity',{}).get('wasmSha256')==wasm,'candidate-identity','보조 관찰 후보 불일치')
  p=r.get('lastObserved',{}).get('jobs',{}).get('preparation',{})
  v.require(p.get('enabled') is True and type(p.get('ownedBytes')) is int and p['ownedBytes']==0,'cleanup','보조 준비 gate/cleanup')
  gates=r.get('historyGates');checks=r.get('historyChecks')
  v.require(type(gates) is list and all(type(x) is dict and x.get('result')=='PASS' and x.get('gate') in ('D1','D3','D5') for x in gates),'failed-assertions','보조 history gate')
  v.require(type(checks) is list and all(type(x) is str and 0<len(x)<=2000 for x in checks),'failed-assertions','보조 history check')
  b.check_teardown(v,r.get('teardown'))
 b.check_lifecycle(v,kw['lifecycle'],kw['attempt'],kw['harness_exit'])
 for error in kw.get('evidence_errors',()):v.fail('evidence-write',str(error))
 return dict(schema=SCHEMA,status='FAIL' if v.failures else 'PASS',failures=v.failures,categories=sorted({f['category'] for f in v.failures}),dependencyManifest=5,trustAnchor=dict(TRUST_ANCHOR),auxiliary=auxiliary_kind)

def exit_code(verdict,harness_exit):
 if type(verdict) is not dict or type(verdict.get('schema')) is not int or verdict['schema']!=SCHEMA:return harness_exit if type(harness_exit) is int and 0<harness_exit<=255 else 3
 return current.exit_code({**verdict,'schema':current.SCHEMA},harness_exit)
