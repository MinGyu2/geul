// T010 준비 runtime 하드닝 재현: 변환 memo 예약 거부의 종료 분류와 불필요 decode.
// 모든 검사를 기록하고 마지막에 status를 정한다(수정 전 후보의 실패도 항목별로 남긴다).
import {sleep,stats,canvas,makeDocument,frame,same,job,finish,png,svg,holdImages,poll} from './runtime.mjs';
const result={schema:2,contract:'t010-preparation-hardening-2',status:'FAIL',tests:[],cases:[]};
const check=(name,ok,detail={})=>result.tests.push({name,status:ok?'PASS':'FAIL',...detail});
const clean=m=>{const s=stats(m);return s.preparation.ownedBytes===0&&s.activeJobs===0&&s.uniqueResourceCount===0&&s.pendingCount===0&&s.decodedLedger.uniqueBytes===0&&s.decodedLedger.reservedBytes===0&&s.decodedRegistryEntries===0;};
const WATERMARK={brightness:70,contrast:-50,effect:'RealPic'};
// 결정적 xorshift 잡음 PNG. 압축되지 않아 원본과 변환 결과가 모두 큰 실제 그림이 된다.
async function noise(width,height,seed){
 const c=document.createElement('canvas');c.width=width;c.height=height;const x=c.getContext('2d');
 const image=x.createImageData(width,height),data=image.data;let s=seed>>>0||1;
 for(let i=0;i<data.length;i+=4){s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;data[i]=s&255;data[i+1]=(s>>>8)&255;data[i+2]=(s>>>16)&255;data[i+3]=255;}
 x.putImageData(image,0,0);
 const blob=await new Promise(r=>c.toBlob(r,'image/png'));c.width=c.height=0;
 return new Uint8Array(await blob.arrayBuffer());
}
async function witness(f){return {width:f.width,height:f.height,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',f.data)),b=>b.toString(16).padStart(2,'0')).join('')};}
async function run(m,label,bytes){
 const d=makeDocument(m,[bytes],WATERMARK),c=canvas(),old=frame(c),rows=[];
 try{
  const done=await finish(m,d,c,rows,label,{old,timeout:14500});
  const j=job(m,done.id),s=stats(m);
  const row={label,sourceBytes:bytes.length,outcome:done.outcome,polls:done.polls,totalMs:done.totalMs,maxPollMs:done.maxPollMs,
   terminalPolls:[d.pollRenderJob(done.id),d.pollRenderJob(done.id),d.pollRenderJob(done.id)],
   frameBefore:await witness(old),frameAfter:await witness(frame(c)),job:j,unchanged:same(c,old),pendingNeverPublished:rows.every(r=>r.atomicPending),peakBytes:s.preparation.peakBytes,maxJobBytes:s.preparation.maxJobBytes};
  result.cases.push(row);return row;
 }finally{d.free();c.width=c.height=0;m.trimRendererCaches(0);await sleep(30);}
}
try{
 const m=await import('/candidate/rhwp.js');await m.default();
 m.trimRendererCaches(0);m.setRendererPreparationEnabled(true);
 // 대조군: 같은 워터마크 속성이 실제 변환 memo 경로를 타며 정상 완료한다.
 const small=await run(m,'control-small-watermark',await noise(64,64,7));
 check('control-small-watermark-complete',small.outcome==='COMPLETE'&&small.job?.transformAttempts===1&&small.job?.decodeAttempts===1,{row:small});
 check('control-cleanup',clean(m),{stats:stats(m)});
 // 원본은 job 예약(32MiB) 안에 들어오지만 원본+변환 memo는 넘는다.
 const bytes=await noise(2900,2900,11);
 result.largeSourceBytes=bytes.length;
 check('large-source-fits-job-reservation',bytes.length<stats(m).preparation.maxJobBytes-(1<<20),{bytes:bytes.length});
 const big=await run(m,'memo-reservation-refusal',bytes);
 check('memo-refusal-is-resource-limit',big.outcome==='RESOURCE_LIMIT',{outcome:big.outcome});
 check('memo-refusal-transform-attempted',big.job?.transformAttempts===1,{job:big.job});
 check('memo-refusal-no-decode-after-refusal',big.job?.decodeAttempts===0,{job:big.job});
 check('memo-refusal-no-ready-no-replay',big.job?.readyTransitions===0&&big.job?.replays===0,{job:big.job});
 check('memo-refusal-not-published',big.unchanged&&big.pendingNeverPublished);
 check('memo-refusal-reservation-bounded',big.peakBytes<=big.maxJobBytes,{peakBytes:big.peakBytes});
 check('memo-refusal-cleanup',clean(m),{stats:stats(m)});
 result.terminalCases=[];
 for(const close of [false,true]){
  const held=holdImages(),d=makeDocument(m,[svg(close?122:121)]),c=canvas(),old=frame(c),id=d.beginRenderJob(0,c,.5),rows=[];
  try{
   const initial=poll(m,d,id,c,rows,'held',old),before=stats(m),images=[...held.held.keys()];
   if(close)d.free();else d.cancelRenderJob(id);
   for(const image of images)image.dispatchEvent(new Event('error'));
   held.release();await sleep(80);
   const outcomes=close?[]:[d.pollRenderJob(id),d.pollRenderJob(id),d.pollRenderJob(id)];
   m.trimRendererCaches(0);await sleep(30);
   result.terminalCases.push({label:close?'close-pending-image':'cancel-late-decode-error',initial,pendingBefore:before.pendingCount,
    outcomes,unchanged:same(c,old),stats:stats(m)});
  }finally{held.clear();if(!close)d.free();c.width=c.height=0;m.trimRendererCaches(0);}
 }
 // Four distinct 32MiB decoded backings exceed the unchanged 96MiB nonresident bound.
 m.setRendererCacheBudget(0,0,0);
 const before=stats(m),d=makeDocument(m,[0,1,2,3].map(i=>png(i+200,4096,2048))),c=canvas(),old=frame(c),rows=[];
 try{
  const done=await finish(m,d,c,rows,'preparation-revocation',{old});
  const j=job(m,done.id),revocations=stats(m).decodedRevocations-before.decodedRevocations;
  const outcomes=[d.pollRenderJob(done.id),d.pollRenderJob(done.id),d.pollRenderJob(done.id)];
  d.free();m.trimRendererCaches(0);await sleep(30);
  result.terminalCases.push({label:'preparation-resource-revocation',outcome:done.outcome,outcomes,revocations,job:j,
   unchanged:same(c,old),stats:stats(m)});
 }finally{c.width=c.height=0;m.trimRendererCaches(0);}
 result.status=result.tests.every(t=>t.status==='PASS')&&result.terminalCases.every(r=>r.unchanged&&(r.outcomes.length===0||r.outcomes.every(o=>o===(r.label==='preparation-resource-revocation'?'RESOURCE_LIMIT':'CANCELED'))))?'PASS':'FAIL';
}catch(e){result.error=String(e&&e.stack||e).slice(0,1500);}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
