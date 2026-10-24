// Read-only engine observation. A retained DOM reference is deliberately tested
// across unrelated cache eviction; this is NOT an implementation of a job lease.
const result = {status:'RUNNING', official:false, arms:{}, runtimeOptimization:false};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let observed = null;
const put = CanvasRenderingContext2D.prototype.putImageData;
CanvasRenderingContext2D.prototype.putImageData = function(...args) {
  if (observed) observed.push(this.canvas);
  return put.apply(this, args);
};
function png(color) {
  const c=document.createElement('canvas');c.width=c.height=64;
  c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,64,64);
  const bytes=Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), c=>c.charCodeAt(0));
  c.width=c.height=0;return bytes;
}
function page(mod, bytes) {
  const d=mod.HwpDocument.createEmpty();
  d.insertPicture(0,0,0,'',bytes,9000,9000,64,64,'png','',null,null);
  return d;
}
function pixels(c) {return c.getContext('2d').getImageData(0,0,c.width,c.height).data;}
const modules={};
try {
  for(const arm of ['baseline','phase']) {
    const mod=modules[arm]=await import(`/${arm}/rhwp.js`);await mod.default();
    const tests=[],transitions=[],docs=[],canvases=[];
    const snap=()=>({jobs:JSON.parse(mod.rendererJobStats()),cache:JSON.parse(mod.rendererCacheStats())});
    const check=(name,ok,detail={})=>{tests.push({name,status:ok?'PASS':'FAIL',...detail});if(!ok)throw new Error(arm+': '+name);};
    const poll=(d,id,label)=>{const before=snap(),at=performance.now(),outcome=d.pollRenderJob(id);
      transitions.push({label,outcome,synchronousMs:performance.now()-at,before,after:snap()});return outcome;};
    const canvas=()=>{const c=document.createElement('canvas');c.width=c.height=20;canvases.push(c);return c;};
    try {
      mod.trimRendererCaches(0);mod.setRendererCacheBudget(4<<20,2<<20,1);
      const bytes=png('#369abc'),d=page(mod,bytes);docs.push(d);const c=canvas();
      const first=d.beginRenderJob(0,c,.5),before=snap();d.cancelRenderJob(first);
      check('cancel-before-first-poll-no-preparation',poll(d,first,'canceled-before-poll')==='CANCELED'&&before.jobs.loadAttempts===snap().jobs.loadAttempts&&c.width===20&&snap().jobs.activeLeaseCount===0);
      observed=[];
      const id=d.beginRenderJob(0,c,.5);check('png-full-poll-completes',poll(d,id,'first-png')==='COMPLETE');
      const handle=observed[0];observed=null;
      check('decoded-resource-created',handle?.width===64&&handle?.height===64);
      const ready=snap(),original=pixels(c);
      check('decoded-resident-has-no-job-lease',ready.cache.decoded.entries===1&&ready.jobs.activeLeaseCount===0,
        {decodedBytes:ready.cache.decoded.bytes,jobOwnedBytes:ready.jobs.ownedEstimatedBytes,dimensions:[handle.width,handle.height]});
      const other=page(mod,png('#aa4422'));docs.push(other);const oc=canvas();
      let otherState;
      // Frequency admission can reject the first newcomer. Exercise the existing
      // bounded replacement policy rather than bypassing it with a global trim.
      for(let attempt=0;attempt<8&&handle.width>0;attempt++){
        const oi=other.beginRenderJob(0,oc,.5);otherState=poll(other,oi,'other-job-'+attempt);
      }
      check('unrelated-job-completes',otherState==='COMPLETE');
      check('raw-handle-invalidated-by-unrelated-cache-eviction',handle.width===0&&handle.height===0,
        {retainedDomReference:true,width:handle.width,height:handle.height,implication:'raw HtmlCanvasElement clone is not a prepared-resource lease'});
      const cachedBefore=snap();observed=[];
      const retry=d.beginRenderJob(0,c,.5);check('valid-job-reconstructs-evicted-png',poll(d,retry,'reconstruct-evicted')==='COMPLETE'&&observed.length===1,
        {decodeAllocations:observed.length,cacheBefore:cachedBefore.cache});observed=null;
      const actual=pixels(c);let differences=0,maxDelta=0;
      for(let i=0;i<actual.length;i++){const delta=Math.abs(actual[i]-original[i]);if(delta)differences++;maxDelta=Math.max(maxDelta,delta);}
      check('reconstructed-full-frame-exact',differences===0&&maxDelta===0,{channelDifferences:differences,maxDelta});
      observed=[];const stable=snap();
      check('terminal-poll-idempotent',poll(d,retry,'terminal-repeat')==='COMPLETE'&&observed.length===0&&snap().cache.decoded.misses===stable.cache.decoded.misses);
      observed=null;
      // Admission refusal uses a synchronous temporary, released before poll return.
      mod.setRendererCacheBudget(0,2<<20,1);observed=[];
      const transient=d.beginRenderJob(0,c,.5);check('zero-decoded-budget-full-frame',poll(d,transient,'uncached-transient')==='COMPLETE');
      const temp=observed[0];observed=null;
      check('uncached-decoded-handle-released-before-return',temp?.width===0&&temp?.height===0&&snap().cache.decoded.bytes===0,
        {width:temp?.width,height:temp?.height,implication:'preparation cannot retain an unaccounted temporary across yield'});
      // Begin does not bind an immutable tree. Mutation invalidates the job owner.
      const stale=d.beginRenderJob(0,c,.5);const saved=pixels(c);d.insertText(0,0,0,'x');
      check('mutation-rejects-stale-generation',poll(d,stale,'mutated-before-poll')==='CANCELED'&&pixels(c).every((v,i)=>v===saved[i]));
      const closing=page(mod,bytes),closedId=closing.beginRenderJob(0,c,.5);closing.free();
      check('document-close-clears-job',snap().jobs.activeJobs===0&&snap().jobs.activeLeaseCount===0,{closedJobId:closedId});
      // Cancellation cannot interleave inside synchronous tree/decode/replay/publish.
      transitions.push({label:'interruption-contract',observable:'begin returns; each poll returns terminal or resource/capacity PENDING',
        unavailable:['after-tree callback','partial decoded preparation cursor','ResourcesReady return','after-replay-before-publication callback']});
    } finally {
      observed=null;for(const d of docs)d.free();for(const c of canvases)c.width=c.height=0;
      mod.trimRendererCaches(0);await sleep(20);
      const cleanup=snap();check('final-cleanup-zero',cleanup.jobs.ownedEstimatedBytes===0&&cleanup.jobs.activeJobs===0&&cleanup.cache.decoded.bytes===0&&cleanup.cache.images.bytes===0,{cleanup});
      result.arms[arm]={tests,transitions,cleanup};
    }
  }
  result.status='DIAGNOSTIC_COMPLETE';
} catch(error) {result.status='FAIL';result.error=String(error);}
finally {observed=null;CanvasRenderingContext2D.prototype.putImageData=put;}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
