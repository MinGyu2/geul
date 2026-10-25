"""새 실행물 전용 native 계약 4. 과거 계약·anchor는 수정하지 않는다."""
from pathlib import Path
import hashlib, subprocess, sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'ownership-poc'))
import native_d1_result as baseline
from native_d1_result import loads_strict, Verdict, SAMPLES, FIXTURE_SHA256, pinned_samples_valid
SCHEMA=4
CURRENT_MANIFEST=4
PREFIX='tests/integration/rhwp/evidence/t010-render-preparation-runtime/'
SUPPORT='tests/integration/rhwp/render-preparation/'
NATIVE_WRAPPER=PREFIX+'run-native.py'
# v3는 그대로 보존한다. 이전 wrapper/gate는 상속 계약의 출처로도 명시한다.
DEPENDENCIES=baseline.DEPENDENCY_MANIFESTS[3]+(NATIVE_WRAPPER,SUPPORT+'native_result.py',SUPPORT+'native-vite.config.mjs',PREFIX+'candidate-identity.json')+tuple(PREFIX+'engine-gates/'+n for n in ('engine-safety-gates.json','chrome.json','webkit.json'))
TRUST_ANCHOR={'path':PREFIX+'candidate-identity.json','sha256':'043b25321baa00e0cd3384e3ed7d59bb5dd503bc6890d098a8dbcb8053ef9b29'}

def load_trust_anchor(root):
 data=subprocess.check_output(['git','-C',str(root),'show','HEAD:'+TRUST_ANCHOR['path']])
 if hashlib.sha256(data).hexdigest()!=TRUST_ANCHOR['sha256']:raise ValueError('새 committed anchor byte mismatch')
 record=loads_strict(data.decode());identity=record['artifacts']
 if type(identity) is not dict or set(identity)!=set(baseline.TRUSTED_KEYS) or not all(baseline.sha256_text(x) for x in identity.values()):raise ValueError('새 anchor 형식')
 return identity

def dependency_digests(root,candidate,version=CURRENT_MANIFEST):
 if type(version) is not int or version!=CURRENT_MANIFEST:raise ValueError('manifest 4 required')
 values=baseline.dependency_digests(root,candidate,3)
 for n in DEPENDENCIES:
  if n in values:continue
  try:values[n]=hashlib.sha256((root/n).read_bytes()).hexdigest()
  except OSError:values[n]=None
 return values

def normalized(v,values,label):
 if type(values) is list:
  names=[p[0] if type(p) in (list,tuple) and len(p)==2 else None for p in values]
  if not v.require(all(type(n) is str for n in names) and len(names)==len(set(names)),'dependency-manifest',label+' 중복/잘못된 이름'):return {}
  values=dict(values)
 if not v.require(type(values) is dict,'dependency-manifest',label+' map 없음'):return {}
 v.require(set(values)==set(DEPENDENCIES),'dependency-manifest',label+' 필수/추가 경로 불일치')
 v.require(all(type(k) is str and k in DEPENDENCIES and baseline.sha256_text(h) for k,h in values.items()),'dependency-manifest',label+' 비정규 이름/digest')
 return values

def check_dependencies(v,before,after,version,trusted):
 if not v.require(type(version) is int and version==4,'dependency-manifest','manifest 4 required'):return
 b=normalized(v,before,'before');a=normalized(v,after,'after')
 baseline.check_dependencies(v,{k:b[k] for k in baseline.DEPENDENCY_MANIFESTS[3] if k in b},{k:a[k] for k in baseline.DEPENDENCY_MANIFESTS[3] if k in a},3,trusted)
 v.require(b==a,'dependency-mutation','전체 manifest 4 입력 변경')

def validate(**kw):
 version=kw.pop('manifest_version');before=kw.pop('dependencies_before');after=kw.pop('dependencies_after')
 v=Verdict();check_dependencies(v,before,after,version,kw['trusted_identity'])
 def project(x):return {k:x[k] for k in baseline.DEPENDENCY_MANIFESTS[3] if type(x) is dict and k in x}
 out=baseline.validate(**kw,manifest_version=3,dependencies_before=project(before),dependencies_after=project(after))
 r=kw.get('result')
 def object_at(value,key):
  child=value.get(key) if type(value) is dict else None
  return child if type(child) is dict else {}
 p=object_at(object_at(object_at(r,'lastObserved'),'jobs'),'preparation')
 v.require(type(p) is dict and p.get('enabled') is True,'incomplete-verification','실제 준비 gate 관찰 없음')
 v.require(type(p.get('ownedBytes')) is int and p['ownedBytes']==0,'cleanup','준비 보존 메모리 미해제')
 c=object_at(object_at(r,'adapterCounters'),'preparation')
 v.require(type(c) is dict and all(type(c.get(k)) is int and c[k]>0 for k in ('polls','ready','complete')) and baseline.duration(c.get('maxPollMs')),'incomplete-verification','실제 Ready/replay poll 관찰 없음')
 witnesses=c.get('witnesses',[]) if type(c) is dict else []
 v.require(type(witnesses) is list and 0<len(witnesses)<=12 and all(type(j) is dict and j.get('enabled') is True and baseline.duration(j.get('ms')) for j in witnesses),'incomplete-verification','준비 관찰 구조')
 v.require(any(j.get('phase')=='ResourcesReady' and j.get('outcome')=='PENDING' and type(j.get('readyTransitions')) is int and j['readyTransitions']==1 and type(j.get('replays')) is int and j['replays']==0 for j in witnesses if type(j) is dict),'incomplete-verification','Ready 반환 경계 없음')
 out['failures']+=v.failures;out['categories']=sorted(set(out['categories'])|{f['category'] for f in v.failures})
 out.update(schema=SCHEMA,dependencyManifest=4,trustAnchor=dict(TRUST_ANCHOR),status='FAIL' if out['failures'] else 'PASS')
 return out

def exit_code(verdict,harness_exit):
 if type(harness_exit) is int and 0<harness_exit<=255:return harness_exit
 valid=(type(harness_exit) is int and harness_exit==0 and type(verdict) is dict and type(verdict.get('schema')) is int and verdict['schema']==SCHEMA and type(verdict.get('status')) is str and verdict['status']=='PASS' and type(verdict.get('failures')) is list and not verdict['failures'] and type(verdict.get('categories')) is list and not verdict['categories'])
 return 0 if valid else 3
