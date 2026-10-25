import {sleep,stats,png,svg,canvas,makeDocument as make,frame,same,pixels,job,poll,finish,untilReady,holdImages} from './runtime.mjs';
const result={schema:1,contract:1,status:'FAIL',tests:[],transitions:[],rgba:[],performance:[]},rows=result.transitions;
const modules={},docs=[],targets=[];
const keep=d=>(docs.push(d),d),target=()=>{const c=canvas();targets.push(c);return c;};
const check=(name,condition,detail={})=>{result.tests.push({name,status:condition?'PASS':'FAIL',...detail});if(!condition)throw Error(name);};
let currentHandles=null;const height=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'height');
Object.defineProperty(HTMLCanvasElement.prototype,'height',{...height,set(v){height.set.call(this,v);if(currentHandles&&this.width===64&&v===64&&!currentHandles.includes(this))currentHandles.push(this);}});
const destroy=()=>{for(const d of docs.splice(0))d.free();for(const c of targets.splice(0))c.width=c.height=0;};
async function reset(decoded=0,entries=256){destroy();for(const m of Object.values(modules))m.trimRendererCaches(0);const m=modules.candidate;m.setRendererCacheBudget(decoded,2<<20,entries);m.setRendererPreparationEnabled(true);m.setRendererImageLoadListener(null);await sleep(20);}
const clean=m=>{const s=stats(m);return s.preparation.ownedBytes===0&&s.activeJobs===0&&s.uniqueResourceCount===0&&s.pendingCount===0&&s.decodedLedger.uniqueBytes===0&&s.decodedLedger.reservedBytes===0&&s.decodedRegistryEntries===0;};
const data=Array.from({length:12},(_,i)=>png(100+i));
async function exact(d,c,bytes,label,options={}){const ref=keep(make(modules.reference,bytes,options)),rc=target();const outcome=await finish(modules.reference,ref,rc,rows,label+'-reference');const diff=pixels(c,rc);if(outcome.outcome!=='COMPLETE'||diff.pixels!==0||diff.maxDelta!==0||diff.referenceNonWhite===0)throw Error(label+': RGBA '+JSON.stringify(diff));return diff;}
try{
 for(const name of ['baseline','reference','candidate']){const m=modules[name]=await import(`/${name}/rhwp.js`);await m.default();}
 const m=modules.candidate;
 {const d=keep(make(modules.baseline,[data[0]])),c=target();check('baseline-single-poll',d.pollRenderJob(d.beginRenderJob(0,c,.5))==='COMPLETE'&&!modules.baseline.setRendererPreparationEnabled);}
 {const d=keep(make(m,[data[0]])),c=target();check('default-compatibility',d.pollRenderJob(d.beginRenderJob(0,c,.5))==='COMPLETE'&&stats(m).preparation.enabled===false);}
 await reset();
 {const d=keep(make(m,[...data,...data.slice(0,4)])),c=target(),old=frame(c),start=stats(m);const id=d.beginRenderJob(0,c,.5);
  const first=poll(m,d,id,c,rows,'multi-poll',old);const partial=stats(m);const done=await finish(m,d,c,rows,'multi-poll',{id,old});const trace=rows.filter(x=>x.label==='multi-poll'&&x.id===id),last=job(m,id);
  check('actual-multi-poll',first==='PENDING'&&done.outcome==='COMPLETE'&&trace.length>=4&&trace.some(x=>x.after.preparation.jobs.some(j=>j.id===id&&j.phase==='Preparing')),{polls:trace.length});
  check('ready-before-replay',trace.some(x=>x.outcome==='PENDING'&&x.after.preparation.jobs.some(j=>j.id===id&&j.phase==='ResourcesReady'&&j.replays===0&&j.keys===12))&&last.replays===1);
  check('retained-before-publication',partial.preparation.ownedBytes>0&&partial.decodedLedger.jobLeaseReferences>0&&trace.every(x=>x.atomicPending));
  check('quantum-bound-and-monotonic-cursor',trace.every(x=>{let a=x.before.preparation.jobs.find(j=>j.id===id),b=x.after.preparation.jobs.find(j=>j.id===id);return b.steps-(a?.steps??0)<=256&&b.attempts-(a?.attempts??0)<=4&&b.steps>=(a?.steps??0); }));
  check('notification-only-continuation',done.outcome==='COMPLETE'&&stats(m).preparation.notifications>start.preparation.notifications&&stats(m).loadAttempts===start.loadAttempts);
  check('deduplicated-no-redecode',last.decodeAttempts===12&&last.readyReuses>=4&&stats(m).decodedLedger.created-start.decodedLedger.created===12,{job:last});
  check('incremental-full-exact',(await exact(d,c,[...data,...data.slice(0,4)],'multi')).pixels===0);
 }
 await reset(65536,2);
 {const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);let handles=[];currentHandles=handles;poll(m,d,id,c,rows,'eviction-A',old);currentHandles=null;const first=handles[0],before=JSON.parse(m.rendererCacheStats());
  for(let n=0;n<8;n++){const b=keep(make(m,[png(300+n)])),bc=target();await finish(m,b,bc,rows,'eviction-B');if(JSON.parse(m.rendererCacheStats()).decoded.evictions>before.decoded.evictions)break;}
  const evicted=JSON.parse(m.rendererCacheStats()).decoded.evictions>before.decoded.evictions;
  check('prepared-lease-survives-other-job-eviction',evicted&&first?.width===64&&job(m,id).phase==='Preparing',{dimensions:[first?.width,first?.height]});
  const done=await finish(m,d,c,rows,'eviction-A',{id,old});check('eviction-resume-exact',done.outcome==='COMPLETE'&&(await exact(d,c,data,'eviction')).pixels===0);
 }
 await reset();
 {const a=keep(make(m,data)),b=keep(make(m,data)),ca=target(),cb=target();const ai=a.beginRenderJob(0,ca,.5),bi=b.beginRenderJob(0,cb,.5);poll(m,a,ai,ca,rows,'shared-A');const before=stats(m);poll(m,b,bi,cb,rows,'shared-B');const shared=stats(m);
  check('shared-decoded-backing-counted-once',shared.decodedLedger.created===before.decodedLedger.created&&shared.decodedLedger.jobLeaseReferences>before.decodedLedger.jobLeaseReferences&&shared.decodedLedger.uniqueBytes===before.decodedLedger.uniqueBytes);
  a.cancelRenderJob(ai);check('cancel-one-shared-owner-preserves-other',stats(m).decodedLedger.uniqueBytes===before.decodedLedger.uniqueBytes&&job(m,bi).keys>0);const done=await finish(m,b,cb,rows,'shared-B',{id:bi});check('shared-owner-full-exact',done.outcome==='COMPLETE'&&(await exact(b,cb,data,'shared')).pixels===0);
 }
 await reset();
 {const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5),before=stats(m);d.cancelRenderJob(id);check('cancel-before-first-poll',poll(m,d,id,c,rows,'cancel-before')==='CANCELED'&&stats(m).decodedLedger.created===before.decodedLedger.created&&same(c,old)&&stats(m).preparation.ownedBytes===0);}
 await reset();
 {const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);poll(m,d,id,c,rows,'cancel-partial',old);const before=stats(m);d.cancelRenderJob(id);check('cancel-after-partial-preparation',before.preparation.ownedBytes>0&&d.pollRenderJob(id)==='CANCELED'&&clean(m)&&same(c,old));}
 await reset();
 {const d=keep(make(m,[data[0]])),c=target(),{id,old}=untilReady(m,d,c,rows,'cancel-ready');d.cancelRenderJob(id);check('cancel-resources-ready-before-replay',d.pollRenderJob(id)==='CANCELED'&&same(c,old)&&clean(m));}
 for(const [name,mutate]of [
  ['mutation-during-partial',d=>d.insertText(0,0,0,'changed')],
  ['output-generation-invalidates',d=>d.setShowParagraphMarks(true)],
  ['model-replacement-invalidates',d=>d.createBlankDocument()],
 ]){await reset();const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);poll(m,d,id,c,rows,name,old);mutate(d);const out=d.pollRenderJob(id);check(name,out==='CANCELED'&&same(c,old)&&clean(m),{outcome:out});}
 await reset();
 {const a=keep(make(m,data)),c=target(),old=frame(c),ai=a.beginRenderJob(0,c,.5);poll(m,a,ai,c,rows,'stale-target',old);const b=keep(make(m,[data[1]])),bi=b.beginRenderJob(0,c,.5);check('same-target-replacement-cancels',a.pollRenderJob(ai)==='CANCELED'&&same(c,old));const done=await finish(m,b,c,rows,'replacement',{id:bi});check('replacement-only-publishes',done.outcome==='COMPLETE'&&(await exact(b,c,[data[1]],'replacement')).pixels===0);}
 for(const [name,operation]of [['trim-cancels',()=>m.trimRendererCaches(0)],['budget-reduction-cancels',()=>m.setRendererCacheBudget(0,0,0)]]){await reset();const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);poll(m,d,id,c,rows,name,old);operation();check(name,d.pollRenderJob(id)==='CANCELED'&&clean(m)&&same(c,old));}
 await reset();
 {const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);poll(m,d,id,c,rows,'deadline',old);const at=performance.now();await sleep(15400);const s=stats(m);check('deadline-expires-without-poll',d.pollRenderJob(id)==='ERROR'&&clean(m)&&same(c,old)&&performance.now()-at>=15000&&s.expiryTimerActive===false,{waitMs:performance.now()-at});}
 await reset();
 {const d=keep(make(m,data)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);poll(m,d,id,c,rows,'close',old);d.free();docs.splice(docs.indexOf(d),1);await sleep(20);check('close-during-preparation',clean(m)&&same(c,old));}
 await reset();
 {const hold=holdImages(),d=keep(make(m,[data[0],svg(55),data[1]])),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);const out=poll(m,d,id,c,rows,'pending-cancel',old);const pending=stats(m);d.cancelRenderJob(id);hold.release();await sleep(150);check('cancel-browser-pending-and-late-completion',out==='PENDING'&&pending.pendingCount===1&&d.pollRenderJob(id)==='CANCELED'&&same(c,old)&&clean(m));hold.clear();}
 await reset();
 {const hold=holdImages(),bytes=[data[0],svg(65),data[1]],d=keep(make(m,bytes)),c=target(),old=frame(c),id=d.beginRenderJob(0,c,.5);const out=poll(m,d,id,c,rows,'pending-progress',old);const pending=stats(m);hold.release();const done=await finish(m,d,c,rows,'pending-progress',{id,old});check('pending-completion-resumes-without-redecode',out==='PENDING'&&pending.pendingCount===1&&done.outcome==='COMPLETE'&&job(m,id).decodeAttempts===3&&(await exact(d,c,bytes,'pending')).pixels===0,{job:job(m,id)});hold.clear();}
 await reset();
 {const hold=holdImages(),all=[];for(let n=0;n<3;n++){const d=keep(make(m,[svg(90+n)])),c=target(),id=d.beginRenderJob(0,c,.5);poll(m,d,id,c,rows,'contention-'+n);all.push({d,c,id});}const bounded=stats(m);all[0].d.cancelRenderJob(all[0].id);poll(m,all[2].d,all[2].id,all[2].c,rows,'contention-admit');hold.release();const done=await finish(m,all[2].d,all[2].c,rows,'contention-complete',{id:all[2].id});all[1].d.cancelRenderJob(all[1].id);check('multi-job-browser-contention-bounded',bounded.pendingCount===2&&stats(m).pendingCount<=2&&done.outcome==='COMPLETE'&&(await exact(all[2].d,all[2].c,[svg(92)],'contention')).pixels===0);hold.clear();}
 await reset();
 {const bytes=Array.from({length:260},(_,i)=>png(1000+i,1,1)),d=keep(make(m,bytes)),c=target(),old=frame(c);const done=await finish(m,d,c,rows,'too-many',{old});check('more-than-256-refuses-without-publication',done.outcome==='RESOURCE_LIMIT'&&same(c,old)&&clean(m)&&job(m,done.id).decodeAttempts<=256,{job:job(m,done.id),polls:done.polls});}
 for(const failure of ['scratch','replay','publication']){await reset();const d=keep(make(m,[data[0]])),c=target(),{id,old}=untilReady(m,d,c,rows,'failure-'+failure);const get=HTMLCanvasElement.prototype.getContext,draw=CanvasRenderingContext2D.prototype.drawImage;
  if(failure==='scratch')HTMLCanvasElement.prototype.getContext=function(...args){return this===c?get.apply(this,args):null;};
  else CanvasRenderingContext2D.prototype.drawImage=function(...args){if((failure==='publication')===(this.canvas===c))throw Error('controlled '+failure);return draw.apply(this,args);};
  let outcome;try{outcome=d.pollRenderJob(id);}finally{HTMLCanvasElement.prototype.getContext=get;CanvasRenderingContext2D.prototype.drawImage=draw;}
  check(failure+'-failure-preserves-old-frame',outcome==='ERROR'&&same(c,old)&&clean(m),{outcome});
 }
 await reset(16<<20);
 {const d=keep(make(m,data)),c=target();let decodeAfterFirst;for(let n=0;n<8;n++){const done=await finish(m,d,c,rows,'repeat-'+n);if(done.outcome!=='COMPLETE')throw Error('repeat '+done.outcome);if(n===0)decodeAfterFirst=stats(m).decodedLedger.created;}const id=d.currentRenderJobId(),before=stats(m);for(let n=0;n<5;n++)if(d.pollRenderJob(id)!=='COMPLETE')throw Error('terminal repeat');check('repeated-jobs-and-terminal-polls-stable',stats(m).decodedLedger.created===decodeAfterFirst&&stats(m).preparation.ownedBytes===0&&stats(m).decodedLedger.created===before.decodedLedger.created);}
 await reset();
 {const bad=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><invalid'),d=keep(make(m,[bad])),c=target(),old=frame(c);const done=await finish(m,d,c,rows,'invalid-resource',{old});check('resource-decode-error-fails-closed',done.outcome==='ERROR'&&same(c,old)&&clean(m));}
 await reset();
 {const huge=new Uint8Array((33<<20)+data[0].length);huge.set(data[0]);const d=keep(make(m,[huge])),c=target(),old=frame(c);const done=await finish(m,d,c,rows,'retained-tree-limit',{old});check('retained-tree-admission-refuses-before-decode',done.outcome==='RESOURCE_LIMIT'&&job(m,done.id).decodeAttempts===0&&same(c,old)&&clean(m));}
 await reset();
 {const options=[{},{brightness:70,contrast:-50,effect:'RealPic'}],bytes=[data[0],data[0]],d=keep(make(m,bytes,options)),c=target(),ready=untilReady(m,d,c,rows,'transformed-variants'),witness=job(m,ready.id),done=await finish(m,d,c,rows,'transformed-variants',{id:ready.id,old:ready.old});check('transformed-variants-separate-identities',witness.keys===2&&witness.decodeAttempts===2&&witness.transformAttempts===1&&done.outcome==='COMPLETE'&&(await exact(d,c,bytes,'transformed-variants',options)).pixels===0,{ready:witness});}
 await reset();
 {const source=document.createElement('canvas');source.width=source.height=64;source.getContext('2d').fillStyle='#518ab3';source.getContext('2d').fillRect(0,0,64,64);const jpeg=Uint8Array.from(atob(source.toDataURL('image/jpeg').split(',')[1]),x=>x.charCodeAt(0));source.width=source.height=0;const options={brightness:-50,contrast:70,effect:'RealPic'},bytes=[jpeg,jpeg],d=keep(make(m,bytes,options)),c=target(),done=await finish(m,d,c,rows,'jpeg-watermark'),j=job(m,done.id);check('jpeg-watermark-conversion-full-exact',done.outcome==='COMPLETE'&&j.transformAttempts===1&&j.memoHits>=1&&j.decodeAttempts===1&&(await exact(d,c,bytes,'jpeg-watermark',options)).pixels===0,{job:j});}
 for(const [name,options]of [
  ['crop-transformed-full-exact',{cropLeft:600,cropTop:450,cropRight:900,cropBottom:300,rotationAngle:30}],
  ['watermark-full-exact',{brightness:70,contrast:-50,effect:'RealPic'}],
  ['watermark-inverse-full-exact',{brightness:-50,contrast:70,effect:'RealPic'}],
 ]){await reset();const bytes=[data[0],data[0]],d=keep(make(m,bytes,options)),c=target();const done=await finish(m,d,c,rows,name);const diff=await exact(d,c,bytes,name,options);check(name,done.outcome==='COMPLETE'&&diff.pixels===0,{job:job(m,done.id),rgba:diff});}
 await reset();
 {const d=keep(m.HwpDocument.createEmpty()),ref=keep(modules.reference.HwpDocument.createEmpty()),c=target(),rc=target();for(const x of [d,ref])x.insertEquation(0,0,0,'{a+b} over {c-d}',1800,0);const done=await finish(m,d,c,rows,'equation-vector'),rd=await finish(modules.reference,ref,rc,rows,'equation-reference'),diff=pixels(c,rc);check('equation-vector-full-exact',done.outcome==='COMPLETE'&&rd.outcome==='COMPLETE'&&diff.pixels===0&&diff.referenceNonWhite>0&&job(m,done.id).keys===0,{rgba:diff,job:job(m,done.id)});}
 await reset();
 {const bytes=new Uint8Array(await(await fetch('/ole.hwpx')).arrayBuffer()),d=keep(new m.HwpDocument(bytes)),ref=keep(new modules.reference.HwpDocument(bytes)),c=target(),rc=target();const layer=JSON.parse(d.getPageLayerTree(0));const text=JSON.stringify(layer);const done=await finish(m,d,c,rows,'raw-svg-ole'),rd=await finish(modules.reference,ref,rc,rows,'raw-svg-reference'),diff=pixels(c,rc),j=job(m,done.id);check('raw-svg-resolved-full-exact',done.outcome==='COMPLETE'&&rd.outcome==='COMPLETE'&&diff.pixels===0&&diff.referenceNonWhite>0&&j.transformAttempts>0&&j.memoHits>0,{rgba:diff,job:j,rawSvgInLayer:/rawSvg|raw-svg|RawSvg/.test(text)});}
 await reset();
 {const d=keep(m.HwpDocument.createEmpty()),ref=keep(modules.reference.HwpDocument.createEmpty()),c=target(),rc=target();for(const x of [d,ref]){const p=JSON.parse(x.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,width:18000,height:9000,horzOffset:3000,vertOffset:3000,treatAsChar:false})));x.setShapeProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({fillType:'solid',fillBgColor:0xddeecc,fillPatColor:0x905723,fillPatType:3}));}
  const original=CanvasRenderingContext2D.prototype.createPattern;let calls=0;CanvasRenderingContext2D.prototype.createPattern=function(...args){calls++;return original.apply(this,args);};let done;try{done=await finish(m,d,c,rows,'pattern-fill');}finally{CanvasRenderingContext2D.prototype.createPattern=original;}const rd=await finish(modules.reference,ref,rc,rows,'pattern-reference'),diff=pixels(c,rc);check('pattern-draw-scoped-full-exact',done.outcome==='COMPLETE'&&rd.outcome==='COMPLETE'&&calls>0&&diff.pixels===0&&diff.referenceNonWhite>0,{patternDrawCalls:calls,rgba:diff});}
 await reset();
 {const bytes=new Uint8Array(await(await fetch('/background.hwp')).arrayBuffer()),d=keep(new m.HwpDocument(bytes)),ref=keep(new modules.reference.HwpDocument(bytes)),c=target(),rc=target();const done=await finish(m,d,c,rows,'background-image'),rd=await finish(modules.reference,ref,rc,rows,'background-reference'),diff=pixels(c,rc),j=job(m,done.id);check('background-image-full-exact',done.outcome==='COMPLETE'&&rd.outcome==='COMPLETE'&&diff.pixels===0&&diff.referenceNonWhite>0&&j.decodeAttempts>0,{rgba:diff,job:j});}
 // Real chemical Full oracle. Seven zero-based pages, three cold and warm trials each.
 await reset(256<<20);const bytes=new Uint8Array(await(await fetch('/chemical.hwp')).arrayBuffer());
 const sourceDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const d=keep(new m.HwpDocument(bytes)),ref=keep(new modules.reference.HwpDocument(bytes)),c=target(),rc=target();
 for(const temperature of ['cold','warm'])for(let trial=0;trial<3;trial++){
  d.insertText(0,3,trial,'a');ref.insertText(0,3,trial,'a');
  for(const page of [14,15,16,19,20,21,23]){
   if(temperature==='cold'){m.trimRendererCaches(0);modules.reference.trimRendererCaches(0);}
   const label=`chemical-${temperature}-${trial}-${page}`,before=stats(m),candidate=await finish(m,d,c,rows,label,{page}),reference=await finish(modules.reference,ref,rc,rows,label+'-reference',{page}),diff=pixels(c,rc),after=stats(m);
   result.rgba.push({temperature,trial,page,scale:.5,dpr:devicePixelRatio,sourceSha256:sourceDigest,candidateOutcome:candidate.outcome,referenceOutcome:reference.outcome,...diff});
   result.performance.push({temperature,trial,page,...candidate,decodedBefore:before.decodedLedger,decodedAfter:after.decodedLedger,browserOwnedBytes:after.ownedEstimatedBytes,browserPending:after.pendingCount,peakRetainedPreparationBytes:after.preparation.peakBytes,peakScratch:after.peakTemporaryCanvasBytes,peakBackup:after.peakBackupImageDataBytes,job:job(m,candidate.id)});
   if(candidate.outcome!=='COMPLETE'||reference.outcome!=='COMPLETE'||diff.pixels!==0||diff.maxDelta!==0||diff.referenceNonWhite<100)throw Error(label+': '+JSON.stringify(diff)+' '+candidate.outcome);
  }
 }
 check('chemical-cold-full-rgba-exact',result.rgba.filter(r=>r.temperature==='cold').length===21&&result.rgba.every(r=>r.pixels===0&&r.maxDelta===0&&r.referenceNonWhite>=100));
 check('chemical-warm-historical-matrix-exact',result.rgba.filter(r=>r.temperature==='warm').length===21&&result.rgba.every(r=>r.pixels===0&&r.maxDelta===0));
 check('pending-frames-never-published',rows.every(r=>r.atomicPending));
 destroy();m.trimRendererCaches(0);await sleep(30);check('final-cleanup',clean(m),{jobs:stats(m)});result.status='PASS';
}catch(error){result.error=String(error);}
finally{destroy();currentHandles=null;Object.defineProperty(HTMLCanvasElement.prototype,'height',height);for(const m of Object.values(modules))m.trimRendererCaches(0);result.cleanup=Object.fromEntries(Object.entries(modules).map(([n,m])=>[n,stats(m)]));}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
