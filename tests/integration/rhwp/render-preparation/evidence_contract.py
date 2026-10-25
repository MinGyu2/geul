"""준비 runtime 증거 1. 기대 시험/전이 조건은 runner가 선택하며 결과가 낮출 수 없다."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'ownership-poc'))
from native_d1_result import duration, FIXTURE_SHA256

PROBE_NAMES=('baseline-single-poll','default-compatibility','actual-multi-poll','ready-before-replay','retained-before-publication','final-cleanup')
NAMES=(
 'baseline-single-poll','default-compatibility','actual-multi-poll','ready-before-replay','retained-before-publication',
 'quantum-bound-and-monotonic-cursor','notification-only-continuation','deduplicated-no-redecode','incremental-full-exact',
 'prepared-lease-survives-other-job-eviction','eviction-resume-exact','shared-decoded-backing-counted-once',
 'cancel-one-shared-owner-preserves-other','shared-owner-full-exact','cancel-before-first-poll',
 'cancel-after-partial-preparation','cancel-resources-ready-before-replay','mutation-during-partial',
 'output-generation-invalidates','model-replacement-invalidates','same-target-replacement-cancels',
 'replacement-only-publishes','trim-cancels','budget-reduction-cancels','deadline-expires-without-poll',
 'close-during-preparation','cancel-browser-pending-and-late-completion','pending-completion-resumes-without-redecode',
 'multi-job-browser-contention-bounded','more-than-256-refuses-without-publication',
 'scratch-failure-preserves-old-frame','replay-failure-preserves-old-frame','publication-failure-preserves-old-frame',
 'repeated-jobs-and-terminal-polls-stable','resource-decode-error-fails-closed','retained-tree-admission-refuses-before-decode',
 'transformed-variants-separate-identities','jpeg-watermark-conversion-full-exact','crop-transformed-full-exact','watermark-full-exact','watermark-inverse-full-exact','equation-vector-full-exact',
 'raw-svg-resolved-full-exact','pattern-draw-scoped-full-exact','background-image-full-exact','chemical-cold-full-rgba-exact','chemical-warm-historical-matrix-exact',
 'pending-frames-never-published','final-cleanup',
)

def validate(value,probe=False):
 if type(probe) is not bool:raise ValueError('호출자 계약 선택 형식')
 if not isinstance(value,dict) or type(value.get('schema')) is not int or value['schema']!=1:raise ValueError('schema')
 if type(value.get('contract')) is not int or value['contract']!=1:raise ValueError('contract')
 if value.get('status')!='PASS' or 'error' in value:raise ValueError('browser FAIL: '+str(value.get('error','')))
 tests=value.get('tests');names=PROBE_NAMES if probe else NAMES
 if not isinstance(tests,list) or [t.get('name') if type(t) is dict else None for t in tests]!=list(names) or any(t.get('status')!='PASS' for t in tests):raise ValueError('시험 목록 또는 결과')
 if not probe and not value.get('transitions'):raise ValueError('실제 전이 없음')

 if probe:return
 def require(ok,msg):
  if not ok:raise ValueError(msg)
 def integer(x):return type(x) is int and x>=0
 rows=value['transitions'];require(type(rows) is list and all(type(r) is dict for r in rows),'transition 형식')
 active=[]
 for r in rows:
  require(duration(r.get('ms')) and r.get('outcome') in ('PENDING','COMPLETE','CANCELED','ERROR','RESOURCE_LIMIT') and r.get('atomicPending') is True,'poll 시간/원자성/결과')
  for key in ('before','after'):
   s=r.get(key);require(type(s) is dict,'job 통계 없음')
   if 'preparation' not in s:continue
   q=s['preparation'];require(type(q) is dict,'준비 통계 형식');require(type(q.get('jobs')) is list,'job 목록 형식');require(type(q.get('enabled')) is bool,'준비 gate 형식')
   for k,n in [('maxOwnedBytes',64<<20),('maxJobBytes',32<<20),('resourceQuantum',4),('stepQuantum',256)]:require(type(q.get(k)) is int and q[k]==n,'준비 한도 변경 '+k)
   require(integer(q.get('ownedBytes')) and q['ownedBytes']<=64<<20,'보존 메모리 한도')
   require(integer(s.get('pendingCount')) and s['pendingCount']<=2 and all(type(s.get(k)) is int and s[k]==n for k,n in [('maxPending',2),('maxResources',256),('maxOwnedBytes',256<<20)]),'기존 한도')
   require(all(integer(s.get(k)) and s[k]==0 for k in ('temporaryCanvasBytes','backupImageDataBytes')) and all(integer(s.get(k)) and s[k]<=64<<20 for k in ('peakTemporaryCanvasBytes','peakBackupImageDataBytes')),'scratch/backup 한도')
   seen=set()
   for j in q['jobs']:
    require(type(j) is dict and j.get('phase') in ('Compatibility','Preparing','ResourcesReady','FullReplay','Terminal'),'job 형식/phase')
    require(all(integer(j.get(k)) for k in ('id','steps','attempts','readyTransitions','yields','replays','keys','retainedBytes','decodeAttempts','transformAttempts','readyReuses','memoHits','memoCount')),'cursor 계수기 형식')
    require(j['id'] not in seen,'중복 job');seen.add(j['id'])
    require(j['keys']<=256 and j['memoCount']<=256 and j['retainedBytes']<=32<<20,'cursor 소유 한도')
   if key=='after' and q['enabled']:active.append(r)
 require(len(active)>=4,'실제 다중 poll 관찰 없음')
 main=[r for r in active if r.get('label')=='multi-poll'];require(len(main)>=4 and main[-1]['outcome']=='COMPLETE','다중 poll이 아님')
 phases=[j for r in main for j in r['after']['preparation']['jobs'] if j['id']==r['id']]
 require(any(j['phase']=='Preparing' and j['keys']>0 and j['retainedBytes']>0 for j in phases),'poll 사이 자원 보존 없음')
 require(any(j['phase']=='ResourcesReady' and j['keys']==12 and j['replays']==0 for j in phases),'ResourcesReady 경계 없음')
 require(phases[-1]['phase']=='Terminal' and phases[-1]['replays']==1 and phases[-1]['decodeAttempts']==12,'최종 replay/중복 decode')
 for r in main:
  a=next((j for j in r['before']['preparation']['jobs'] if j['id']==r['id']),None);b=next(j for j in r['after']['preparation']['jobs'] if j['id']==r['id'])
  require(0<=b['steps']-(a['steps'] if a else 0)<=256 and 0<=b['attempts']-(a['attempts'] if a else 0)<=4,'quantum 초과/역행')
 rgba=value.get('rgba');expected=[(t,n,p) for t in ('cold','warm') for n in range(3) for p in (14,15,16,19,20,21,23)]
 require(type(rgba) is list and [(r.get('temperature'),r.get('trial'),r.get('page')) for r in rgba]==expected,'Full RGBA 행렬')
 for r in rgba:
  require(type(r.get('trial')) is int and type(r.get('page')) is int and duration(r.get('dpr')) and r['dpr']>0,'RGBA 시험 identity 형식')
  require(type(r.get('pixels')) is int and r['pixels']==0 and type(r.get('maxDelta')) is int and r['maxDelta']==0,'Full RGBA 차이')
  require(integer(r.get('referenceNonWhite')) and r['referenceNonWhite']>=100 and integer(r.get('width')) and r['width']>0 and integer(r.get('height')) and r['height']>0,'빈 reference')
  require(r.get('candidateOutcome')=='COMPLETE' and r.get('referenceOutcome')=='COMPLETE' and r.get('scale')==.5,'Full 완료/배율')
  require(r.get('sourceSha256')==FIXTURE_SHA256['연구노트(화학).hwp'],'공식 fixture 바이트')
 perf=value.get('performance');require(type(perf) is list and len(perf)==42,'성능 관찰 행렬')
 for r in perf:
  require(type(r) is dict and duration(r.get('totalMs')) and duration(r.get('maxPollMs')) and integer(r.get('polls')) and r['polls']>=2 and r.get('outcome')=='COMPLETE','성능 관찰 형식')
 c=value.get('cleanup',{}).get('candidate');require(type(c) is dict,'최종 cleanup 없음')
 require(all(integer(c.get(k)) and c[k]==0 for k in ('activeJobs','uniqueResourceCount','pendingCount','decodedRegistryEntries')) and type(c.get('preparation')) is dict and type(c['preparation'].get('ownedBytes')) is int and c['preparation']['ownedBytes']==0,'최종 소유 누수')
 ledger=c.get('decodedLedger',{});require(all(integer(ledger.get(k)) and ledger[k]==0 for k in ('uniqueBytes','uniqueCount','reservedBytes')) and type(ledger.get('created')) is int and ledger['created']>0 and type(ledger.get('disposed')) is int and ledger['created']==ledger['disposed'],'최종 backing 누수')

def validate_performance(value):
 def need(ok,message):
  if not ok:raise ValueError(message)
 need(type(value) is dict and type(value.get('schema')) is int and value['schema']==1 and type(value.get('contract')) is int and value['contract']==1 and value.get('status')=='PASS' and 'error' not in value,'성능 증거 schema/status')
 need(value.get('sourceSha256')==FIXTURE_SHA256['연구노트(화학).hwp'],'성능 fixture 신원')
 expected=[(t,n,p) for t in ('cold','warm') for n in range(3) for p in (16,20,23)]
 rows=value.get('pairs');need(type(rows) is list and [(r.get('temperature'),r.get('trial'),r.get('page')) for r in rows]==expected,'성능 대조 행렬')
 for r in rows:
  need(type(r.get('trial')) is int and type(r.get('page')) is int and type(r.get('rgba')) is dict and type(r['rgba'].get('pixels')) is int and r['rgba']['pixels']==0 and r['rgba']['maxDelta']==0 and r['rgba']['referenceNonWhite']>=100,'동일 실행물 RGBA')
  for name,on in [('baseline',False),('candidate',True)]:
   arm=r.get(name);need(type(arm) is dict and arm.get('outcome')=='COMPLETE' and type(arm.get('polls')) is int and arm['polls']>=(2 if on else 1) and duration(arm.get('maxPollMs')) and duration(arm.get('totalMs')),'성능 arm')
   need(arm['after']['preparation']['enabled'] is on and arm['after']['preparation']['ownedBytes']==0,'성능 gate/해제')
   if on:need(all(type(w.get('steps')) is int and 0<=w['steps']<=256 and type(w.get('attempts')) is int and 0<=w['attempts']<=4 for w in arm['workPerPoll']),'성능 quantum')
 for c in value.get('cleanup',{}).values():
  need(c['activeJobs']==0 and c['preparation']['ownedBytes']==0 and c['decodedLedger']['uniqueBytes']==0 and c['decodedLedger']['reservedBytes']==0,'성능 cleanup')
 need(set(value.get('cleanup',{}))=={'baseline','candidate'},'성능 cleanup arm')

HISTORICAL_PREPARATION_NAMES=('cancel-before-first-poll-no-preparation','png-full-poll-completes','decoded-resource-created','decoded-resident-has-no-job-lease','unrelated-job-completes','raw-handle-invalidated-by-unrelated-cache-eviction','valid-job-reconstructs-evicted-png','reconstructed-full-frame-exact','terminal-poll-idempotent','zero-decoded-budget-full-frame','uncached-decoded-handle-released-before-return','mutation-rejects-stale-generation','document-close-clears-job','final-cleanup-zero')
def validate_historical_preparation(v):
 if type(v) is not dict or v.get('status')!='DIAGNOSTIC_COMPLETE' or 'error' in v or v.get('runtimeOptimization') is not False:raise ValueError('과거 준비 관찰 계약 실패')
 if type(v.get('arms')) is not dict or set(v['arms'])!={'baseline','phase'}:raise ValueError('과거 준비 arm')
 for arm in v['arms'].values():
  tests=arm.get('tests')
  if type(tests) is not list or [t.get('name') for t in tests]!=list(HISTORICAL_PREPARATION_NAMES) or any(t.get('status')!='PASS' for t in tests):raise ValueError('과거 준비 시험 목록/결과')
  s=arm['cleanup']['jobs']
  if s.get('activeJobs')!=0 or s.get('activeLeaseCount')!=0 or s.get('ownedEstimatedBytes')!=0:raise ValueError('과거 준비 cleanup')
