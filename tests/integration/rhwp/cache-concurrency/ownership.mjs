import { historical } from './historical.mjs';
import { jobHistorical } from './job-historical.mjs';
import { svg, classify } from './fixtures.mjs';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const assert = (ok, why) => { if (!ok) throw new Error(why); };
const snapshot = m => ({ ...JSON.parse(m.rendererCacheStats()), jobs: JSON.parse(m.rendererJobStats()) });
const clean = row => { const { runs: _pixels, ...rest } = row; return rest; };
function page(mod, dims=[1200,1210]) {
  const d=mod.HwpDocument.createEmpty();
  dims.forEach((n,i)=>{
    const placed=JSON.parse(d.insertPicture(0,0,0,'',svg(n,n,i+1),9000,9000,n,n,'svg','',null,null));
    d.setPictureProperties(0,placed.paraIdx,placed.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:(100+160*i)*75,vertOffset:7500}));
  });
  return d;
}
export async function ownership(candidate,pinned,{mismatch,loads}) {
  const checkpoints=[]; const tests=[];
  const capture = name => { const row={name,...snapshot(candidate)}; checkpoints.push(row); return row; };
  const check = (name, ok, detail={}) => { tests.push({name,status:ok?'PASS':'FAIL',...detail}); };
  async function complete(d,c,scale=1,pageIndex=0) {
    const id=d.beginRenderJob(pageIndex,c,scale); let state='PENDING', polls=0;
    while (state==='PENDING' && polls++<200) { state=d.pollRenderJob(id); if(state==='PENDING') await sleep(20); }
    assert(state!=='PENDING','job did not terminate');
    return {state,polls,id};
  }
  async function reference(d,c,scale=1,pageIndex=0) { d.renderPageToCanvas(pageIndex,c,scale); await sleep(500); d.renderPageToCanvas(pageIndex,c,scale); return classify(c); }
  candidate.trimRendererCaches(0); candidate.setRendererCacheBudget(8<<20,2<<20,8);
  const before=capture('before'); const started=loads.started;
  const d=page(candidate), c=document.createElement('canvas');
  c.width=40;c.height=40;c.getContext('2d').fillStyle='#123456';c.getContext('2d').fillRect(0,0,40,40);
  const sentinel=classify(c), id=d.beginRenderJob(0,c,1);
  let state=d.pollRenderJob(id); const during=capture('two-oversize-pending');
  check('pending-does-not-publish',state==='PENDING'&&mismatch(sentinel,classify(c))===0);
  await sleep(300); const ready=capture('ready-before-draw');
  for(let n=0;state==='PENDING'&&n<200;n++){state=d.pollRenderJob(id);if(state==='PENDING')await sleep(20);}
  const final=classify(c); const retained=capture('after-complete');
  const loadAttempts=loads.started-started;
  const pd=page(pinned),pc=document.createElement('canvas');const expected=await reference(pd,pc);pd.free();
  const pixelMismatchCount=mismatch(final,expected);
  check('two-oversize-complete',state==='COMPLETE'&&pixelMismatchCount===0,{state,pixelMismatchCount});
  check('resident-budget',retained.images.bytes<=2<<20);
  check('job-complete-releases-transients',retained.jobs.ownedEstimatedBytes===0&&retained.jobs.pendingCount===0);
  check('no-reload-loop',loadAttempts<=2,{loadAttempts});
  d.free();await sleep(100);const afterClose=capture('after-close');
  check('closed-ownership-zero',afterClose.jobs.ownedEstimatedBytes===0);
  const concurrent={status:tests.every(t=>t.status==='PASS')?'PASS':'FAIL',loadAttempts,
    notifications:retained.jobs.completionNotifications-before.jobs.completionNotifications,pixelMismatchCount,
    during,ready,retained,afterClose,final:clean(final)};

  // Same-task burst: at most8 jobs,2 unique in-flight resources; overflow is explicit.
  candidate.trimRendererCaches(0);candidate.setRendererCacheBudget(1<<20,1024,2);
  const docs=[],outcomes=[];
  for(let i=0;i<100;i++){
    const doc=page(candidate,[81+i]),canvas=document.createElement('canvas');let token=null;
    try { token=doc.beginRenderJob(0,canvas,1);outcomes.push(doc.pollRenderJob(token)); }
    catch(e){ outcomes.push(String(e).includes('RESOURCE_LIMIT')?'RESOURCE_LIMIT':'ERROR'); }
    docs.push([doc,canvas,token]);
  }
  const burst=capture('100-burst');
  check('100-burst-bounded',burst.jobs.pendingCount<=2&&burst.jobs.ownedEstimatedBytes<=burst.jobs.maxOwnedBytes&&burst.jobs.activeJobs<=8);
  candidate.setRendererCacheBudget(1<<20,512,1);const reduced=capture('budget-reduction');
  candidate.trimRendererCaches(0);const trimmed=capture('trim-during-load');
  const terminalOutcomes=docs.map(([doc,_canvas,token])=>token===null?'RESOURCE_LIMIT':doc.pollRenderJob(token));
  check('burst-has-terminal-outcomes',terminalOutcomes.every(s=>s==='CANCELED'||s==='RESOURCE_LIMIT'),{outcomes:terminalOutcomes.reduce((r,s)=>(r[s]=(r[s]??0)+1,r),{})});
  docs.forEach(([doc,canvas])=>{doc.free();canvas.width=canvas.height=0;});
  await sleep(500);const closed=capture('after-late-callbacks');
  check('late-callbacks-cannot-resurrect',closed.jobs.ownedEstimatedBytes===0&&closed.jobs.pendingCount===0);
  const pending={requests:100,during:burst,reduced,trimmedWhilePending:trimmed,afterClosedCallbacks:closed,
    afterFinalTrim:capture('post-burst'),terminalOutcomes:terminalOutcomes.reduce((r,s)=>(r[s]=(r[s]??0)+1,r),{}),outcomes:outcomes.reduce((r,s)=>(r[s]=(r[s]??0)+1,r),{}),status:burst.jobs.pendingCount<=2&&closed.jobs.ownedEstimatedBytes===0?'PASS':'FAIL'};

  {
    candidate.setRendererCacheBudget(8<<20,2<<20,8);
    const doc=page(candidate,[201,202,203,204]),ref=page(pinned,[201,202,203,204]),canvas=document.createElement('canvas'),referenceCanvas=document.createElement('canvas');
    const start=loads.started,token=doc.beginRenderJob(0,canvas,1);let state=doc.pollRenderJob(token),peak=snapshot(candidate).jobs.pendingCount;
    for(let n=0;state==='PENDING'&&n<200;n++){await sleep(20);state=doc.pollRenderJob(token);peak=Math.max(peak,snapshot(candidate).jobs.pendingCount);}
    const attempts=loads.started-start;
    const expected=await reference(ref,referenceCanvas),wrong=mismatch(classify(canvas),expected);
    check('waiting-work-progresses',state==='COMPLETE'&&wrong===0&&peak<=2&&attempts===4,{state,pixelMismatchCount:wrong,peakPending:peak,loadAttempts:attempts});doc.free();ref.free();
  }
  // Shared pending decode, disposal of either owner must preserve the other lease.
  candidate.setRendererCacheBudget(8<<20,2<<20,8);
  const a=page(candidate,[200]),b=page(candidate,[200]),ac=document.createElement('canvas'),bc=document.createElement('canvas');
  const shareStart=loads.started,ai=a.beginRenderJob(0,ac,1),bi=b.beginRenderJob(0,bc,1);
  a.pollRenderJob(ai);b.pollRenderJob(bi);a.free();await sleep(300);
  const bState=b.pollRenderJob(bi);
  check('shared-pending-close-one',bState==='COMPLETE'&&loads.started-shareStart===1,{state:bState,loadAttempts:loads.started-shareStart});b.free();

  // Explicit cancellation both before and after decode; never publish the sentinel.
  for(const afterDecode of [false,true]){
    const doc=page(candidate,[afterDecode?222:223]),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;
    const original=classify(canvas),token=doc.beginRenderJob(0,canvas,1);doc.pollRenderJob(token);
    if(afterDecode)await sleep(250);doc.cancelRenderJob(token);await sleep(100);
    check('cancel-'+(afterDecode?'ready':'pending'),doc.pollRenderJob(token)==='CANCELED'&&mismatch(original,classify(canvas))===0);
    doc.free();
  }
  // Mutation cancels old generation. Starting another job on the same Canvas cancels stale publication.
  {
    const doc=page(candidate,[227]),canvas=document.createElement('canvas');const token=doc.beginRenderJob(0,canvas,1);doc.pollRenderJob(token);
    doc.insertText(0,0,0,'generation');await sleep(200);
    check('model-mutation-cancels',doc.pollRenderJob(token)==='CANCELED');doc.free();
  }
  {
    const a=page(candidate,[228]),b=page(candidate,[229]),canvas=document.createElement('canvas');
    const token=a.beginRenderJob(0,canvas,1);a.pollRenderJob(token);b.beginRenderJob(0,canvas,1);
    check('canvas-generation-cancels',a.pollRenderJob(token)==='CANCELED');a.free();b.free();
  }
  {
    const doc=page(candidate,[238]),canvas=document.createElement('canvas'),old=doc.beginRenderJob(0,canvas,1);doc.pollRenderJob(old);
    const current=doc.beginRenderJob(0,canvas,1);doc.pollRenderJob(current);doc.cancelRenderJob(old);await sleep(250);
    check('stale-cancel-cannot-cancel-replacement',doc.pollRenderJob(current)==='COMPLETE');doc.free();
  }
  // Resource exhaustion must preserve a valid old frame (extreme zoom).
  {
    const doc=page(candidate,[230]),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;const original=classify(canvas);
    const r=await complete(doc,canvas,100);
    check('frame-limit-fails-closed',r.state==='RESOURCE_LIMIT'&&mismatch(original,classify(canvas))===0,{state:r.state});doc.free();
  }
  // Cropping, text/image ordering, repeated pressure and DPR/zoom use exact RGBA references.
  for(const [name,scale,crop] of [['cropped-oversize',1,true],['zoom-dpr',1.5,false],['pressure-rerender',1,false]]) {
    candidate.trimRendererCaches(0);
    const actual=page(candidate,[1250,1260]),ref=page(pinned,[1250,1260]);
    actual.insertText(0,0,0,'layer text');ref.insertText(0,0,0,'layer text');
    if(crop)for(const doc of [actual,ref]){
      const info=JSON.parse(doc.getPictureProperties(0,0,0));
      doc.setPictureProperties(0,0,0,JSON.stringify({cropLeft:Math.round(info.width/2)}));
    }
    const canvas=document.createElement('canvas'),refCanvas=document.createElement('canvas');
    ref.renderPageToCanvas(0,refCanvas,scale);await sleep(300);ref.renderPageToCanvas(0,refCanvas,scale);
    const reference=classify(refCanvas);const states=[];let wrong=0;
    for(let n=0;n<(name==='pressure-rerender'?4:1);n++){
      const r=await complete(actual,canvas,scale);states.push(r.state);wrong+=mismatch(classify(canvas),reference);
      if(name==='pressure-rerender')candidate.trimRendererCaches(0);
    }
    check(name,states.every(s=>s==='COMPLETE')&&wrong===0,{states,pixelMismatchCount:wrong});actual.free();ref.free();
  }
  {
    const doc=page(candidate,[235]),canvas=document.createElement('canvas'),token=doc.beginRenderJob(0,canvas,1);
    doc.pollRenderJob(token);await sleep(250);candidate.setRendererCacheBudget(8<<20,1<<20,8);
    check('ready-budget-reduction-cancels',doc.pollRenderJob(token)==='CANCELED'&&snapshot(candidate).jobs.activeLeaseEstimatedBytes===0);doc.free();
  }
  // Repeating the same request while pending cannot restart its decoder.
  {
    candidate.trimRendererCaches(0);const doc=page(candidate,[236]),canvas=document.createElement('canvas'),start=loads.started,token=doc.beginRenderJob(0,canvas,1);
    let state;for(let i=0;i<100;i++)state=doc.pollRenderJob(token);
    const started=loads.started-start;await sleep(250);state=doc.pollRenderJob(token);
    check('identical-request-no-restart',started===1&&state==='COMPLETE',{loadAttempts:started,state});doc.free();
  }
  {
    candidate.trimRendererCaches(0);candidate.setRendererCacheBudget(8<<20,2<<20,8);
    const small=page(candidate,[64]),large=page(candidate,[1214]),canvas=document.createElement('canvas');await complete(small,canvas);
    const before=snapshot(candidate).images.bytes;const r=await complete(large,canvas);const after=snapshot(candidate).images.bytes,start=loads.started;
    const warm=await complete(small,canvas);
    check('oversize-preserves-normal-resident',before>0&&before===after&&r.state==='COMPLETE'&&warm.state==='COMPLETE'&&loads.started===start,{beforeResidentBytes:before,afterResidentBytes:after});small.free();large.free();
  }
  // Failure is explicit and retry is a new job, never an uncontrolled decode loop.
  {
    candidate.trimRendererCaches(0);candidate.setRendererCacheBudget(10,10,1);
    const doc=page(candidate,[237]),canvas=document.createElement('canvas');
    const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){desc.set.call(this,value?'data:image/svg+xml;base64,AAAA':value);}});
    try {
      const first=await complete(doc,canvas),second=await complete(doc,canvas);
      check('decode-failure-explicit-retry',first.state==='ERROR'&&second.state==='ERROR',{states:[first.state,second.state]});
      const tiny=capture('tiny-budget-failure');check('tiny-budget-negative-bounded',tiny.images.bytes<=10&&tiny.decoded.bytes<=10);
    } finally {Object.defineProperty(HTMLImageElement.prototype,'src',desc);doc.free();candidate.setRendererCacheBudget(8<<20,2<<20,8);}
  }

  // Compatibility errors stay observable until an explicit retry or model invalidation.
  {
    const doc=page(candidate,[240]),canvas=document.createElement('canvas'),desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    const states=[];Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){desc.set.call(this,value?'data:image/svg+xml;base64,AAAA':value);}});
    try{
      try{doc.renderPageToCanvas(0,canvas,1);states.push('COMPLETE');}catch(e){states.push(String(e));}
      await sleep(250);
      for(let i=0;i<2;i++)try{doc.renderPageToCanvas(0,canvas,1);states.push('COMPLETE');}catch(e){states.push(String(e));}
    }finally{Object.defineProperty(HTMLImageElement.prototype,'src',desc);}
    check('compatibility-error-is-sticky',states[0]==='PENDING'&&states[1]==='ERROR'&&states[2]==='ERROR',{states});
    doc.insertText(0,0,0,'changed');const afterEdit=[];
    for(let i=0;i<2;i++){try{doc.renderPageToCanvas(0,canvas,1);afterEdit.push('COMPLETE');}catch(e){afterEdit.push(String(e));}await sleep(250);}
    check('mutation-releases-terminal-generation',afterEdit.at(-1)==='COMPLETE',{states:afterEdit});doc.free();
  }
  {
    candidate.trimRendererCaches(0);const doc=page(candidate,[241]),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;
    const original=classify(canvas),method=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(image,...args){if(image instanceof HTMLImageElement)throw new Error('injected image draw failure');return method.call(this,image,...args);};
    try{const r=await complete(doc,canvas);check('draw-failure-does-not-publish',r.state==='ERROR'&&mismatch(original,classify(canvas))===0,{state:r.state});}
    finally{CanvasRenderingContext2D.prototype.drawImage=method;doc.free();}
  }
  {
    const doc=page(candidate,[243]),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;canvas.getContext('2d').fillStyle='#123456';canvas.getContext('2d').fillRect(0,0,20,20);
    const original=classify(canvas),method=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(image,...args){if(this.canvas===canvas)throw new Error('injected publication failure');return method.call(this,image,...args);};
    try{const r=await complete(doc,canvas);check('publication-failure-preserves-visible-frame',r.state==='ERROR'&&mismatch(original,classify(canvas))===0,{state:r.state,pixelMismatchCount:mismatch(original,classify(canvas))});}
    finally{CanvasRenderingContext2D.prototype.drawImage=method;doc.free();}
  }
  {
    const doc=page(candidate,[244]),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;canvas.getContext('2d').fillStyle='#123456';canvas.getContext('2d').fillRect(0,0,20,20);
    const original=classify(canvas),method=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(image,...args){const value=method.call(this,image,...args);if(this.canvas===canvas)throw new Error('injected after publication write');return value;};
    try{const r=await complete(doc,canvas);check('publication-write-then-error-restores-frame',r.state==='ERROR'&&mismatch(original,classify(canvas))===0,{state:r.state,pixelMismatchCount:mismatch(original,classify(canvas))});}
    finally{CanvasRenderingContext2D.prototype.drawImage=method;doc.free();}
  }
  {
    const doc=page(candidate,[245]),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;
    const original=classify(canvas),method=CanvasRenderingContext2D.prototype.getImageData;let r;
    CanvasRenderingContext2D.prototype.getImageData=function(...args){if(this.canvas===canvas)throw new Error('injected readback failure');return method.apply(this,args);};
    try{r=await complete(doc,canvas);}finally{CanvasRenderingContext2D.prototype.getImageData=method;}
    check('backup-failure-preserves-frame',r.state==='ERROR'&&mismatch(original,classify(canvas))===0,{state:r.state});doc.free();
  }
  // Oversized encoded input is rejected before DOM src assignment; preserve valid pixels.
  {
    const doc=candidate.HwpDocument.createEmpty(),canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;
    doc.insertPicture(0,0,0,'',svg(64,64,17<<20),9000,9000,64,64,'svg','',null,null);
    const original=classify(canvas),beforeLoads=loads.started,r=await complete(doc,canvas);
    check('oversize-encoded-rejected',r.state==='RESOURCE_LIMIT'&&loads.started===beforeLoads&&mismatch(original,classify(canvas))===0,{state:r.state});doc.free();
  }
  // Ready leases survive only until a documented bound even without a later insertion.
  {
    const doc=page(candidate,[232]),canvas=document.createElement('canvas'),token=doc.beginRenderJob(0,canvas,1);
    doc.pollRenderJob(token);await sleep(250);const ready=capture('idle-ready-lease');
    check('ready-before-expiry',ready.jobs.readyLeaseCount>=1);
    doc.free();await sleep(50);check('close-ready-releases',snapshot(candidate).jobs.activeLeaseEstimatedBytes===0);
  }
  {
    const docs=[candidate,pinned].map(mod=>{const doc=mod.HwpDocument.createEmpty();doc.insertText(0,0,0,'first');doc.insertPageBreak(0,0,5);doc.insertText(0,1,0,'second');return doc;});
    let wrong=0;const states=[];
    for(const pageIndex of [1,0,1]){
      const canvas=document.createElement('canvas'),ref=document.createElement('canvas');const r=await complete(docs[0],canvas,1,pageIndex);states.push(r.state);
      docs[1].renderPageToCanvas(pageIndex,ref,1);wrong+=mismatch(classify(canvas),classify(ref));canvas.width=canvas.height=ref.width=ref.height=0;
    }
    check('page-ordering',docs.every(doc=>doc.pageCount()===2)&&states.every(s=>s==='COMPLETE')&&wrong===0,{states,pixelMismatchCount:wrong});docs.forEach(doc=>doc.free());
  }
  {
    const docs=[candidate,pinned].map(mod=>{const doc=mod.HwpDocument.createEmpty(),placed=JSON.parse(doc.createTable(0,0,0,2,2));doc.insertTextInCell(0,placed.paraIdx,placed.controlIdx,0,0,0,'cell text');return doc;});
    const canvas=document.createElement('canvas'),ref=document.createElement('canvas'),r=await complete(docs[0],canvas);docs[1].renderPageToCanvas(0,ref,1);const wrong=mismatch(classify(canvas),classify(ref));
    check('table-cell-rendering',r.state==='COMPLETE'&&wrong===0,{state:r.state,pixelMismatchCount:wrong});docs.forEach(doc=>doc.free());
  }
  {
    const doc=page(candidate,[239]),canvas=document.createElement('canvas'),token=doc.beginRenderJob(0,canvas,1);doc.pollRenderJob(token);doc.insertPageBreak(0,0,0);
    check('page-count-change-cancels',doc.pollRenderJob(token)==='CANCELED'&&doc.pageCount()>=2);doc.free();
  }
  // Every existing synchronous replay entry point shares the bounded completion boundary.
  const replayMethods=[
    ['filtered-all','renderPageToCanvasFiltered',canvas=>[0,canvas,1,'all']],
    ['filtered-flow','renderPageToCanvasFiltered',canvas=>[0,canvas,1,'flow']],
    ['filtered-print','renderPageToCanvasFilteredWithProfile',canvas=>[0,canvas,1,'all','print']],
    ['legacy','renderPageToCanvasLegacy',canvas=>[0,canvas,1]],
    ['header-preview','renderHeaderFooterEditPreviewToCanvas',canvas=>[0,0,true,0,canvas,1]],
  ];
  for(const [name,method,args] of replayMethods){
    candidate.trimRendererCaches(0);candidate.setRendererCacheBudget(8<<20,2<<20,8);
    const actual=page(candidate),ref=page(pinned),canvas=document.createElement('canvas'),referenceCanvas=document.createElement('canvas');
    if(name==='header-preview')for(const doc of [actual,ref]){doc.createHeaderFooter(0,true,0);doc.insertTextInHeaderFooter(0,true,0,0,0,'header text');}
    const before=classify(canvas);let state='PENDING',polls=0,unpublished=true;
    for(;state==='PENDING'&&polls++<200;){try{actual[method](...args(canvas));state='COMPLETE';}catch(e){state=String(e);}
      if(state==='PENDING'){unpublished&&=mismatch(before,classify(canvas))===0;await sleep(20);}}
    ref[method](...args(referenceCanvas));await sleep(500);ref[method](...args(referenceCanvas));const wrong=mismatch(classify(canvas),classify(referenceCanvas));
    check('replay-'+name,state==='COMPLETE'&&wrong===0&&unpublished,{state,polls,pixelMismatchCount:wrong,present:classify(canvas).present,referencePresent:classify(referenceCanvas).present});actual.free();ref.free();
  }
  {
    candidate.trimRendererCaches(0);const actual=page(candidate),ref=page(pinned),canvas=document.createElement('canvas'),referenceCanvas=document.createElement('canvas');
    await complete(actual,canvas);await reference(ref,referenceCanvas);actual.insertText(0,0,0,'patch text');ref.insertText(0,0,0,'patch text');
    const before=classify(canvas);let state='PENDING',polls=0,unpublished=true;
    for(;state==='PENDING'&&polls++<200;){try{actual.renderPagePatchToCanvasFilteredWithProfile(0,canvas,1,'all','screen',0,0,250,180);state='COMPLETE';}catch(e){state=String(e);}
      if(state==='PENDING'){unpublished&&=mismatch(before,classify(canvas))===0;await sleep(20);}}
    ref.renderPagePatchToCanvasFilteredWithProfile(0,referenceCanvas,1,'all','screen',0,0,250,180);const wrong=mismatch(classify(canvas),classify(referenceCanvas));
    check('replay-partial-preserves-outside',state==='COMPLETE'&&wrong===0&&unpublished,{state,polls,pixelMismatchCount:wrong});actual.free();ref.free();
  }
  {
    candidate.trimRendererCaches(0);
    const doc=page(candidate,[245]),canvas=document.createElement('canvas');let state='PENDING';
    const descriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');let blockedRequests=0;
    Object.defineProperty(HTMLImageElement.prototype,'src',{...descriptor,set(value){if(value)blockedRequests++;else descriptor.set.call(this,value);}});
    try{doc.renderPageToCanvasFiltered(0,canvas,1,'all');state='COMPLETE';}catch(e){state=String(e);}
    finally{Object.defineProperty(HTMLImageElement.prototype,'src',descriptor);}
    const token=doc.currentRenderJobId();const visible=classify(canvas);
    const cancel=Number.isInteger(token)?doc.cancelRenderJob(token):'NO_TOKEN',after=Number.isInteger(token)?doc.pollRenderJob(token):'NO_TOKEN';
    check('compatibility-job-id-cancel',state==='PENDING'&&Number.isInteger(token)&&cancel==='CANCELED'&&after==='CANCELED'&&mismatch(visible,classify(canvas))===0,{state,token,cancel,after,blockedRequests});
    doc.free();
  }
  {
    const bytes=new Uint8Array(await (await fetch('/multisection.hwpx')).arrayBuffer());
    const actual=new candidate.HwpDocument(bytes),ref=new pinned.HwpDocument(bytes);let wrong=0,states=[];
    const sections=new Set();
    for(let i=0;i<actual.pageCount();i++){
      sections.add(JSON.parse(actual.getPageInfo(i)).sectionIndex);
      const canvas=document.createElement('canvas'),referenceCanvas=document.createElement('canvas');
      const r=await complete(actual,canvas,1,i),expected=await reference(ref,referenceCanvas,1,i);
      states.push(r.state);wrong+=mismatch(classify(canvas),expected);
    }
    check('multisection-physical-page-pixels',sections.size===3&&states.every(s=>s==='COMPLETE')&&wrong===0,{sections:sections.size,pages:states.length,states,pixelMismatchCount:wrong});actual.free();ref.free();
  }
  for(const scroll of [false,true]){
    candidate.trimRendererCaches(0);const actual=page(candidate,[scroll?248:249]),ref=page(pinned,[scroll?248:249]);
    if(scroll)for(const doc of [actual,ref])doc.insertPageBreak(0,0,0);
    const canvas=document.createElement('canvas'),referenceCanvas=document.createElement('canvas');
    const old=actual.beginRenderJob(scroll?1:0,canvas,1),first=actual.pollRenderJob(old);
    const pageIndex=0,scale=scroll?1:1.75,current=actual.beginRenderJob(pageIndex,canvas,scale);
    let state=actual.pollRenderJob(current);for(let n=0;state==='PENDING'&&n<200;n++){await sleep(20);state=actual.pollRenderJob(current);}
    const expected=await reference(ref,referenceCanvas,scale,pageIndex),wrong=mismatch(classify(canvas),expected);
    check(scroll?'scroll-replaces-pending-page':'zoom-replaces-pending-generation',first==='PENDING'&&actual.pollRenderJob(old)==='CANCELED'&&state==='COMPLETE'&&wrong===0,{first,state,pixelMismatchCount:wrong});actual.free();ref.free();
  }
  const idleDoc=page(candidate,[242]),idleCanvas=document.createElement('canvas'),idleToken=idleDoc.beginRenderJob(0,idleCanvas,1);
  idleDoc.pollRenderJob(idleToken);await sleep(300);const idleBefore=capture('ready-awaiting-expiration');
  check('idle-ready-lease-established',idleBefore.jobs.readyLeaseCount>=1);
  // Expiration releases a never-completing browser request without requiring another insertion.
  {
    const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){if(!value)desc.set.call(this,value);}});
    const doc=page(candidate,[231]),canvas=document.createElement('canvas'),token=doc.beginRenderJob(0,canvas,1);
    const first=doc.pollRenderJob(token);Object.defineProperty(HTMLImageElement.prototype,'src',desc);
    await sleep(15500);const expired=capture('stalled-timeout');const last=doc.pollRenderJob(token);
    check('never-complete-times-out',first==='PENDING'&&last==='ERROR'&&expired.jobs.pendingCount===0,{first,last});doc.free();
    const idleState=idleDoc.pollRenderJob(idleToken);check('ready-lease-expires-without-insertion',idleState==='ERROR'&&expired.jobs.activeLeaseEstimatedBytes===0,{state:idleState});idleDoc.free();
  }
  candidate.trimRendererCaches(0);candidate.setRendererCacheBudget(256<<20,64<<20,256);
  const baseline=await historical(pinned),current=await jobHistorical(candidate);
  const failures=[];let draws=0,exact=0;
  const golden=(await (await fetch('/historical-expected.json')).json()).engines[navigator.userAgent.includes('Chrome/')?'chrome':'webkit'];
  for(const [name,scenario] of Object.entries(baseline.results))for(const [i,row] of scenario.rows.entries()){
    const old=golden[name].renders[i];if((old.present!=='0000'||name==='negativeDecode')&&row.hash!==old.hash)failures.push('historical baseline changed: '+name+'/'+row.label);
  }

  for(const [name,scenario] of Object.entries(current.results)){
    const references=baseline.results[name].rows;
    for(const [i,row] of scenario.rows.entries()){
      // Compare each historically nonblank observation with its SAME baseline draw.
      // Cold async observations use a settled reference of the same resource/format.
      let expected=references[i];
      if(expected.present==='0000'&&name!=='negativeDecode'){
        const settled = name==='trimBetweenDraws'?2:name==='sharedAcrossDocs'?4:references.length-1;
        expected=references[settled];
      }
      if(name==='negativeDecode'&&row.browserDecodeRequests!==0)failures.push('negative fixture unexpectedly requested decode');
      draws++; const wrong=mismatch(row,expected);row.pixelMismatchCount=wrong;if(!wrong)exact++;
      if(row.completion!=='COMPLETE'||wrong||row.threw)failures.push(name+'/'+row.label+': '+row.completion+' '+wrong+' '+row.threw);
    }
  }
  check('historical12scenarios50draws',draws===50&&Object.keys(current.results).length===12&&!failures.length,{draws,failures});
  const formats=[];
  for(const format of ['hwp','hwpx']){
    const maker=page(pinned,[128]),out=format==='hwp'?maker.exportHwpWithReport():maker.exportHwpxWithReport(),bytes=out.takeBytes();out.free();maker.free();
    const actual=new candidate.HwpDocument(bytes),ref=new pinned.HwpDocument(bytes),actualCanvas=document.createElement('canvas'),refCanvas=document.createElement('canvas');
    const r=await complete(actual,actualCanvas),expected=await reference(ref,refCanvas),wrong=mismatch(classify(actualCanvas),expected);
    formats.push({format,status:r.state==='COMPLETE'&&!wrong?'PASS':'FAIL',completion:r.state,pixelMismatchCount:wrong});actual.free();ref.free();
  }
  const sanitize=run=>({...run,results:Object.fromEntries(Object.entries(run.results).map(([k,v])=>[k,{...v,rows:v.rows.map(clean)}]))});
  candidate.trimRendererCaches(0);capture('final-trim');
  check('all-accounting-checkpoints-bounded',checkpoints.every(p=>
    p.jobs.pendingCount<=p.jobs.maxPending&&p.jobs.ownedEstimatedBytes<=p.jobs.maxOwnedBytes&&
    p.images.bytes<=p.images.maxBytes&&p.images.entries<=p.images.maxEntries&&
    p.jobs.temporaryCanvasBytes===0&&p.jobs.peakTemporaryCanvasBytes<=p.jobs.maxFrameBytes&&
    p.jobs.backupImageDataBytes===0&&p.jobs.peakBackupImageDataBytes<=p.jobs.maxFrameBytes&&p.jobs.peakStagingBytes<=p.jobs.maxStagingBytes));
  return {schema:1,userAgent:navigator.userAgent,status:tests.every(t=>t.status==='PASS')&&formats.every(f=>f.status==='PASS')?'PASS':'FAIL',
    concurrent,pending,formats,historical:{status:failures.length?'FAIL':'PASS',draws,exactPixelMatches:exact,failures,pinned:sanitize(baseline),candidate:sanitize(current)},
    ownership:{status:tests.every(t=>t.status==='PASS')?'PASS':'FAIL',tests,checkpoints},loads};
}
