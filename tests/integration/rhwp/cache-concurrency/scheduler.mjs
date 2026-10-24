import { svg, classify } from './fixtures.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export function imageDocument(mod,n,size=8) {
 const d=mod.HwpDocument.createEmpty(), data=svg(size,size,n);
 const p=JSON.parse(d.insertPicture(0,0,0,'',data,9000,9000,size,size,'svg','',null,null));
 d.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:7500,vertOffset:7500}));return d;
}
export async function scheduler(mod,ref,{mismatch}) {
 const tests=[],checkpoints=[];
 const snap=name=>{const jobs=JSON.parse(mod.rendererJobStats()),cache=JSON.parse(mod.rendererCacheStats());const x={name,jobs,...cache};checkpoints.push(x);return x;};
 const check=(name,ok,data={})=>tests.push({name,status:ok?'PASS':'FAIL',...data});
 async function finish(doc,canvas,scale=.2,page=0) {
  const token=doc.beginRenderJob(page,canvas,scale);let state='PENDING',polls=0,notifications=0;
  await new Promise(resolve=>{let done=false;const timer=setTimeout(()=>{done=true;resolve();},3000);
   const poll=()=>{if(done)return;polls++;state=doc.pollRenderJob(token);if(state!=='PENDING'){done=true;clearTimeout(timer);resolve();}};
   mod.setRendererImageLoadListener(()=>{notifications++;queueMicrotask(poll);});poll();
  });mod.setRendererImageLoadListener(null);return {state,token,polls,notifications};
 }
 async function pixels(doc,canvas,n,size=8) {
  const expected=imageDocument(ref,n,size),c=document.createElement('canvas');expected.renderPageToCanvas(0,c,.2);await delay(100);expected.renderPageToCanvas(0,c,.2);
  const wrong=mismatch(classify(canvas),classify(c));expected.free();c.width=c.height=0;return wrong;
 }
 // Exact count saturation: completed documents are freed, leaving cache-only leases.
 for(const [kind,count,size] of [['count',256,8],['bytes',3,4000]]) {
  mod.trimRendererCaches(0);mod.setRendererCacheBudget(1<<20,512<<20,256);let loaded=0;
  for(let i=0;i<count;i++){const doc=imageDocument(mod,1000+i,size),c=document.createElement('canvas');const x=await finish(doc,c);if(x.state==='COMPLETE')loaded++;doc.free();c.width=c.height=0;if(x.state!=='COMPLETE')break;}
  const before=snap(kind+'-resident-full'),doc=imageDocument(mod,2000,size),c=document.createElement('canvas');const x=await finish(doc,c),after=snap(kind+'-new-resource');
  const wrong=x.state==='COMPLETE'?await pixels(doc,c,2000,size):-1;
  check(kind+'-saturation-admits',loaded===count&&before.images.entries===count&&before.jobs.pendingCount===0&&x.state==='COMPLETE'&&wrong===0&&after.images.evictions>before.images.evictions,{loaded,before:before.jobs,entries:before.images.entries,result:x,pixelMismatchCount:wrong,evictions:after.images.evictions-before.images.evictions});doc.free();c.width=c.height=0;
  const again=imageDocument(mod,1000,size),ac=document.createElement('canvas');const a=await finish(again,ac);check(kind+'-redecode-after-eviction',a.state==='COMPLETE'&&await pixels(again,ac,1000,size)===0,{state:a.state});again.free();ac.width=ac.height=0;
 }
 // A whole active working set cannot be evicted to admit another document.
 {
  mod.trimRendererCaches(0);mod.setRendererCacheBudget(1<<20,512<<20,256);
  for(let n=0;n<256;n++){const d=imageDocument(mod,5000+n),c=document.createElement('canvas');await finish(d,c);d.free();c.width=c.height=0;}
  const a=mod.HwpDocument.createEmpty();
  for(let n=0;n<256;n++){
   const p=JSON.parse(a.insertPicture(0,0,0,'',svg(8,8,n===255?7000:5000+n),9000,9000,8,8,'svg','',null,null));
   a.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:7500,vertOffset:7500}));
  }
  const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');let held=false;
  Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){if(value&&!held){held=true;desc.set.call(this,'/held-image.svg?key=active-full&data='+encodeURIComponent(value));}else desc.set.call(this,value);}});
  const ac=document.createElement('canvas'),ai=a.beginRenderJob(0,ac,.2);const as=a.pollRenderJob(ai);
  const b=imageDocument(mod,7001),bc=document.createElement('canvas');bc.width=bc.height=20;const original=classify(bc),bi=b.beginRenderJob(0,bc,.2),bs=b.pollRenderJob(bi),blocked=snap('all-active-full');
  check('active-saturation-waits-without-publication',as==='PENDING'&&bs==='PENDING'&&blocked.jobs.pendingCount===1&&blocked.jobs.activeLeaseCount===256&&mismatch(original,classify(bc))===0,{state:bs,activeLeaseCount:blocked.jobs.activeLeaseCount,uniqueResourceCount:blocked.jobs.uniqueResourceCount});
  let state=bs,notes=0;mod.setRendererImageLoadListener(()=>{notes++;queueMicrotask(()=>{state=b.pollRenderJob(bi);});});a.cancelRenderJob(ai);
  await delay(300);check('active-owner-release-progress',state==='COMPLETE'&&await pixels(b,bc,7001)===0&&notes<=3,{state,notifications:notes,pixelMismatchCount:state==='COMPLETE'?await pixels(b,bc,7001):-1});
  mod.setRendererImageLoadListener(null);Object.defineProperty(HTMLImageElement.prototype,'src',desc);a.free();b.free();await fetch('/release-image?key=active-full');
 }
 // Last active leases vanish without any ImageResource destruction: B retains
 // A's pending image, while A's 255 ready images retain cache references.
 {
  await seedResidents(mod,255);
  const a=mod.HwpDocument.createEmpty();
  for(const n of [...Array.from({length:255},(_,i)=>10000+i),900]) {
   const p=JSON.parse(a.insertPicture(0,0,0,'',svg(8,8,n),9000,9000,8,8,'svg','',null,null));
   a.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:7500,vertOffset:7500}));
  }
  const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');let held=false;
  Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){if(value&&!held){held=true;desc.set.call(this,'/held-image.svg?key=lease-cache-only&data='+encodeURIComponent(value));}else desc.set.call(this,value);}});
  const b=imageDocument(mod,900),c=imageDocument(mod,901),ac=document.createElement('canvas'),bc=document.createElement('canvas'),cc=document.createElement('canvas');
  const ai=a.beginRenderJob(0,ac,.2),as=a.pollRenderJob(ai),bi=b.beginRenderJob(0,bc,.2),bs=b.pollRenderJob(bi),ci=c.beginRenderJob(0,cc,.2);
  let state=c.pollRenderJob(ci),notes=0,polls=1;const original=classify(cc),before=snap('cache-only-before');
  check('cache-only-transition-established',as==='PENDING'&&bs==='PENDING'&&state==='PENDING'&&before.jobs.uniqueResourceCount===256&&before.jobs.activeLeaseCount===257&&before.jobs.pendingCount===1&&before.images.entries===255,{state,before:before.jobs,residentCount:255,reclaimableResidentCount:0});
  // Flush any old tasks before attaching the observer. No polling drives C.
  await delay(50);
  mod.setRendererImageLoadListener(()=>{notes++;queueMicrotask(()=>{if(state==='PENDING'){polls++;state=c.pollRenderJob(ci);}});});
  a.cancelRenderJob(ai);const released=snap('cache-only-released');
  check('cache-only-release-without-destruction',released.jobs.uniqueResourceCount===256&&released.jobs.activeLeaseCount===1&&released.jobs.pendingCount===1&&released.images.entries===before.images.entries&&released.jobs.loadAttempts===before.jobs.loadAttempts,{released:released.jobs,cacheOnlyResidentCount:255,reclaimableResidentCount:255});
  await delay(400);const after=snap('cache-only-after');const wrong=state==='COMPLETE'?await pixels(c,cc,901):-1;
  check('cache-only-notification-progress',state==='COMPLETE'&&wrong===0&&notes>0&&notes<=3&&after.jobs.capacityNotifications>before.jobs.capacityNotifications&&after.jobs.pendingCount===1,{state,notifications:notes,polls,pixelMismatchCount:wrong,unchangedWhilePending:state==='PENDING'?mismatch(original,classify(cc)):null,before:before.jobs,after:after.jobs});
  check('cache-only-no-decode-wait-capacity-notification',state==='COMPLETE'&&after.jobs.capacityNotifications-before.jobs.capacityNotifications===1&&notes<=2,{state,notifications:notes,capacityNotifications:after.jobs.capacityNotifications-before.jobs.capacityNotifications});
  const settled=notes;for(let i=0;i<100;i++)a.cancelRenderJob(ai);c.cancelRenderJob(ci);await delay(100);
  check('cache-only-repeated-terminal-cancel-bounded',notes===settled,{notifications:notes});
  mod.setRendererImageLoadListener(null);Object.defineProperty(HTMLImageElement.prototype,'src',desc);a.free();b.free();c.free();await fetch('/release-image?key=lease-cache-only');await delay(30);mod.trimRendererCaches(0);
  const clean=snap('cache-only-cleanup');check('cache-only-final-cleanup',clean.jobs.uniqueResourceCount===0&&clean.jobs.activeLeaseCount===0&&clean.jobs.pendingCount===0,{after:clean.jobs});
  ac.width=ac.height=bc.width=bc.height=cc.width=cc.height=0;
 }
 // A shared-owner cancellation must not advertise a byte reservation that cannot
 // fit this waiter, even when the old generic96MiB decode minimum would fit.
 {
  mod.trimRendererCaches(0);mod.setRendererCacheBudget(1<<20,512<<20,256);
  for(const [n,size] of [[950,3320],[952,512]]){const ready=imageDocument(mod,n,size),rc=document.createElement('canvas');await finish(ready,rc);ready.free();rc.width=rc.height=0;}
  const b=mod.HwpDocument.createEmpty();
  for(const [n,size] of [[950,3320],[951,8]]) {
   const p=JSON.parse(b.insertPicture(0,0,0,'',svg(size,size,n),9000,9000,size,size,'svg','',null,null));
   b.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:7500,vertOffset:7500}));
  }
  const d=mod.HwpDocument.createEmpty();
  for(const [n,size] of [[952,512],[951,8]]) {
   const p=JSON.parse(d.insertPicture(0,0,0,'',svg(size,size,n),9000,9000,size,size,'svg','',null,null));
   d.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:7500,vertOffset:7500}));
  }
  const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');let held=false;
  Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){if(value&&!held){held=true;desc.set.call(this,'/held-image.svg?key=shared-byte-demand&data='+encodeURIComponent(value));}else desc.set.call(this,value);}});
  const bc=document.createElement('canvas'),bi=b.beginRenderJob(0,bc,.2),bs=b.pollRenderJob(bi),a=imageDocument(mod,951),ac=document.createElement('canvas'),ai=a.beginRenderJob(0,ac,.2),as=a.pollRenderJob(ai);
  const dc=document.createElement('canvas'),di=d.beginRenderJob(0,dc,.2),ds=d.pollRenderJob(di);
  const padding=15<<20,c=imageDocument(mod,padding),cc=document.createElement('canvas'),original=classify(cc),ci=c.beginRenderJob(0,cc,.2);let state=c.pollRenderJob(ci),notes=0;
  const required=svg(8,8,padding).byteLength*2+1024+(96<<20);
  await delay(50);const before=snap('shared-byte-demand-before');
  check('shared-byte-demand-established',bs==='PENDING'&&as==='PENDING'&&ds==='PENDING'&&state==='PENDING'&&before.jobs.uniqueResourceCount===3&&before.jobs.pendingCount===1&&before.jobs.activeLeaseCount===5&&before.jobs.ownedEstimatedBytes+(96<<20)+1<=before.jobs.maxOwnedBytes&&before.jobs.ownedEstimatedBytes+required>before.jobs.maxOwnedBytes&&mismatch(original,classify(cc))===0,{state,requiredReservation:required,before:before.jobs});
  mod.setRendererImageLoadListener(()=>{notes++;queueMicrotask(()=>{state=c.pollRenderJob(ci);});});a.cancelRenderJob(ai);const released=snap('shared-byte-demand-released');await delay(200);
  const after=snap('shared-byte-demand-after');
  check('shared-byte-cancel-no-false-capacity',state==='PENDING'&&notes===0&&released.jobs.uniqueResourceCount===before.jobs.uniqueResourceCount&&released.jobs.pendingCount===1&&released.jobs.activeLeaseCount===4&&released.jobs.ownedEstimatedBytes===before.jobs.ownedEstimatedBytes&&after.jobs.capacityNotifications===before.jobs.capacityNotifications&&mismatch(original,classify(cc))===0,{state,notifications:notes,capacityNotifications:after.jobs.capacityNotifications-before.jobs.capacityNotifications,requiredReservation:required,before:before.jobs,released:released.jobs,after:after.jobs,pixelMismatchCount:mismatch(original,classify(cc))});
  d.cancelRenderJob(di);await delay(200);const partial=snap('shared-byte-demand-partial');
  const reclaimableBytes=partial.jobs.ownedEstimatedBytes-partial.jobs.activeLeaseEstimatedBytes;
  check('shared-byte-partial-release-no-false-capacity',state==='PENDING'&&notes===0&&partial.jobs.uniqueResourceCount===3&&partial.jobs.pendingCount===1&&partial.jobs.activeLeaseCount===2&&reclaimableBytes>0&&reclaimableBytes<(2<<20)&&partial.jobs.ownedEstimatedBytes-reclaimableBytes+required>partial.jobs.maxOwnedBytes&&partial.jobs.capacityNotifications===before.jobs.capacityNotifications&&mismatch(original,classify(cc))===0,{state,notifications:notes,capacityNotifications:partial.jobs.capacityNotifications-before.jobs.capacityNotifications,reclaimableResidentBytes:reclaimableBytes,requiredReservation:required,after:partial.jobs,pixelMismatchCount:mismatch(original,classify(cc))});
  mod.setRendererImageLoadListener(null);Object.defineProperty(HTMLImageElement.prototype,'src',desc);c.free();a.free();b.free();d.free();await fetch('/release-image?key=shared-byte-demand');await delay(30);mod.trimRendererCaches(0);
  const clean=snap('shared-byte-demand-cleanup');check('shared-byte-cleanup',clean.jobs.uniqueResourceCount===0&&clean.jobs.pendingCount===0&&clean.jobs.activeLeaseCount===0&&clean.jobs.ownedEstimatedBytes===0,{after:clean.jobs});bc.width=bc.height=ac.width=ac.height=cc.width=cc.height=dc.width=dc.height=0;
 }
 // An intrinsically oversized active working set terminates, keeping the old pixels.
 {
  mod.trimRendererCaches(0);mod.setRendererCacheBudget(1<<20,512<<20,256);
  const a=mod.HwpDocument.createEmpty();
  for(let n=0;n<4;n++){const p=JSON.parse(a.insertPicture(0,0,0,'',svg(4000,4000,8000+n),9000,9000,4000,4000,'svg','',null,null));a.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:7500,vertOffset:7500}));}
  const c=document.createElement('canvas');c.width=c.height=20;const before=classify(c),r=await finish(a,c);
  check('intrinsic-active-byte-limit-explicit',r.state==='RESOURCE_LIMIT'&&mismatch(before,classify(c))===0,{state:r.state,pixelMismatchCount:mismatch(before,classify(c))});a.free();
 }
 // A cell-anchored image (pinned stores a table-sibling float) uses the same resource path.
 {
  const make=engine=>{const d=engine.HwpDocument.createEmpty();d.createBlankDocument();const t=JSON.parse(d.createTable(0,0,0,2,2));d.insertPicture(0,t.paraIdx,0,JSON.stringify([{controlIndex:t.controlIdx,cellIndex:0,cellParaIndex:0}]),svg(32,32,777),2400,2400,32,32,'svg','',null,null);return d;};
  const d=make(mod),p=make(ref),c=document.createElement('canvas'),expected=document.createElement('canvas');const state=await finish(d,c,1);
  p.renderPageToCanvas(0,expected,1);await delay(100);p.renderPageToCanvas(0,expected,1);const wrong=mismatch(classify(c),classify(expected));
  check('table-image-pixels',state.state==='COMPLETE'&&wrong===0&&classify(expected).counts.every(n=>n>50),{state:state.state,pixelMismatchCount:wrong,referenceColorCounts:classify(expected).counts});d.free();p.free();c.width=c.height=expected.width=expected.height=0;
 }
 // Reclaim inactive residents while two documents lease the same warm resident.
 {
  await seedResidents(mod);
  const make=(engine,unique)=>{const d=engine.HwpDocument.createEmpty();[10000,unique].forEach((n,i)=>{const p=JSON.parse(d.insertPicture(0,0,0,'',svg(8,8,n),9000,9000,8,8,'svg','',null,null));d.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzAlign:'Left',vertAlign:'Top',horzOffset:(100+160*i)*75,vertOffset:7500}));});return d;};
  const before=snap('resident-share-before'),desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');let held=0;
  Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){if(value&&held<2){const key='resident-share-'+held++;desc.set.call(this,'/held-image.svg?key='+key+'&data='+encodeURIComponent(value));}else desc.set.call(this,value);}});
  const a=make(mod,11000),b=make(mod,11001),ac=document.createElement('canvas'),bc=document.createElement('canvas');
  const ai=a.beginRenderJob(0,ac,.2),bi=b.beginRenderJob(0,bc,.2);let ast=a.pollRenderJob(ai),bst=b.pollRenderJob(bi);
  const during=snap('resident-share-during');
  check('resident-eviction-during-shared-draw',ast==='PENDING'&&bst==='PENDING'&&during.jobs.activeLeaseCount===4&&during.jobs.pendingCount===2&&during.images.evictions-before.images.evictions===2,{activeLeaseCount:during.jobs.activeLeaseCount,uniqueResourceCount:during.jobs.uniqueResourceCount,evictions:during.images.evictions-before.images.evictions});
  let doneA,doneB;const aw=new Promise(r=>{doneA=r;}),bw=new Promise(r=>{doneB=r;});
  mod.setRendererImageLoadListener(()=>queueMicrotask(()=>{if(ast==='PENDING')ast=a.pollRenderJob(ai);if(bst==='PENDING')bst=b.pollRenderJob(bi);if(ast!=='PENDING')doneA();if(bst!=='PENDING')doneB();}));
  await fetch('/release-image?key=resident-share-0');await Promise.race([aw,delay(3000)]);
  async function compare(doc,canvas,unique){const expected=make(ref,unique),c=document.createElement('canvas');expected.renderPageToCanvas(0,c,.2);await delay(100);expected.renderPageToCanvas(0,c,.2);const wrong=mismatch(classify(canvas),classify(c));expected.free();c.width=c.height=0;return wrong;}
  const aWrong=ast==='COMPLETE'?await compare(a,ac,11000):-1;a.free();const oneClosed=snap('resident-share-one-closed');
  await fetch('/release-image?key=resident-share-1');await Promise.race([bw,delay(3000)]);
  const bWrong=bst==='COMPLETE'?await compare(b,bc,11001):-1;
  check('shared-resident-close-one-preserves-pixels',ast==='COMPLETE'&&bst==='COMPLETE'&&aWrong===0&&bWrong===0&&oneClosed.jobs.pendingCount===1&&JSON.parse(mod.rendererJobStats()).loadAttempts-before.jobs.loadAttempts===2,{state:bst,pixelMismatchCount:Math.max(aWrong,bWrong),loadAttempts:JSON.parse(mod.rendererJobStats()).loadAttempts-before.jobs.loadAttempts,pendingAfterOneClosed:oneClosed.jobs.pendingCount});
  mod.setRendererImageLoadListener(null);Object.defineProperty(HTMLImageElement.prototype,'src',desc);b.free();ac.width=ac.height=bc.width=bc.height=0;
 }
 // Hold genuine asynchronous HTTP image responses. Only notification callbacks poll waiters.
 let serial=0;
 for(const operation of ['cancel-one','cancel-both','dispose','replace','mutate','shared-owner','complete','error','budget','trim','competition','deadline']) {
  mod.trimRendererCaches(0);mod.setRendererCacheBudget(1<<20,1<<20,256);
  const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src'),keys=[],held=[];let assigned=0;
  Object.defineProperty(HTMLImageElement.prototype,'src',{...desc,set(value){
   if(value&&assigned++<2){const key='case'+(++serial);keys.push(key);held.push(this);desc.set.call(this,'/held-image.svg?key='+key+'&data='+encodeURIComponent(value)+(operation==='error'?'&error=1':''));}else desc.set.call(this,value);
  }});
  const a=imageDocument(mod,3001),b=imageDocument(mod,3002),c=imageDocument(mod,3003),ca=document.createElement('canvas'),cb=document.createElement('canvas'),cc=document.createElement('canvas');
  const ai=a.beginRenderJob(0,ca,.2),bi=b.beginRenderJob(0,cb,.2);a.pollRenderJob(ai);b.pollRenderJob(bi);
  if(operation==='deadline')await delay(1000);
  const sentinel=classify(cc);const ci=c.beginRenderJob(0,cc,.2);let state=c.pollRenderJob(ci),wakeups=0,notes=0,shared=null,extra=null,extraState='PENDING';
  if(operation==='shared-owner'){shared=imageDocument(mod,3001);shared.pollRenderJob(shared.beginRenderJob(0,document.createElement('canvas'),.2));}
  if(operation==='competition'){extra=imageDocument(mod,3004);extra.id=extra.beginRenderJob(0,document.createElement('canvas'),.2);extra.pollRenderJob(extra.id);}
  const before=snap(operation+'-before');const started=performance.now();
  mod.setRendererImageLoadListener(()=>{notes++;queueMicrotask(()=>{wakeups++;state=c.pollRenderJob(ci);if(extra)extraState=extra.pollRenderJob(extra.id);});});
  let aFreed=false;
  if(operation==='dispose'){a.free();aFreed=true;}
  else if(operation==='replace')a.beginRenderJob(0,ca,.2);
  else if(operation==='mutate')a.insertText(0,0,0,'next');
  else if(operation==='budget')mod.setRendererCacheBudget(1<<20,512<<10,128);
  else if(operation==='trim')mod.trimRendererCaches(0);
  else if(operation==='complete'||operation==='error')await fetch('/release-image?key='+keys[0]);
  else if(operation!=='deadline') {a.cancelRenderJob(ai);if(operation==='cancel-both'||operation==='competition')b.cancelRenderJob(bi);if(operation==='cancel-both')for(let n=0;n<100;n++){a.cancelRenderJob(ai);b.cancelRenderJob(bi);}}
  const released=snap(operation+'-released');
  if(operation==='shared-owner') {
   await delay(100);check('shared-cancel-no-false-capacity',notes===0&&state==='PENDING'&&released.jobs.pendingCount===2,{notes,state});shared.free();shared=null;
  }
  await delay(operation==='deadline'?15100:350);const after=snap(operation+'-after'),elapsedMs=performance.now()-started;
  const global=operation==='budget'||operation==='trim';
  const wrong=state==='COMPLETE'?await pixels(c,cc,3003):global?mismatch(sentinel,classify(cc)):-1;
  check('notification-progress-'+operation,global?state==='CANCELED'&&after.jobs.pendingCount===0&&wrong===0:state==='COMPLETE'&&wrong===0&&wakeups>0&&elapsedMs<(operation==='deadline'?16000:2000),{before:before.jobs,released:released.jobs,after:after.jobs,state,wakeups,repeatedCancelCalls:operation==='cancel-both'?202:0,notifications:notes,cancellationNotifications:!['complete','error','deadline'].includes(operation)?Math.max(0,notes-(after.jobs.completionNotifications-before.jobs.completionNotifications)):0,elapsedMs,pixelMismatchCount:wrong});
  if(extra)check('competing-waiters-progress',extraState==='COMPLETE',{state:extraState,notifications:notes});
  const settledNotes=notes;await delay(100);check('bounded-notifications-'+operation,notes===settledNotes&&notes<=5,{notifications:notes});
  mod.setRendererImageLoadListener(null);Object.defineProperty(HTMLImageElement.prototype,'src',desc);
  if(!aFreed)a.free();b.free();c.free();if(shared)shared.free();if(extra)extra.free();
  for(const key of keys)await fetch('/release-image?key='+key);for(const image of held)image.dispatchEvent(new Event('load'));
  await delay(20);check('closed-resources-'+operation,snap(operation+'-closed').jobs.activeLeaseEstimatedBytes===0);
 }
 if (mod.HwpDocument.prototype.beginRenderPatchJob) {
  mod.trimRendererCaches(0);await delay(30);
  const idle=snap('timer-idle-start').jobs;await delay(550);const rested=snap('timer-idle-rested').jobs;
  check('timer-idle-no-ticks',idle.expiryTimerActive===false&&rested.expiryTimerTicks===idle.expiryTimerTicks);
  const a=mod.HwpDocument.createEmpty(),b=mod.HwpDocument.createEmpty(),ca=document.createElement('canvas'),cb=document.createElement('canvas');
  const ai=a.beginRenderJob(0,ca,.5),bi=b.beginRenderJob(0,cb,.5);const two=snap('timer-two-jobs').jobs;
  a.cancelRenderJob(ai);await delay(20);const one=snap('timer-one-job').jobs;
  check('timer-shared-lifetime',two.activeJobs===2&&two.expiryTimerActive===true&&one.activeJobs===1&&one.expiryTimerActive===true);
  // Do not query stats until after the idle interval: stats itself reconciles timers.
  b.cancelRenderJob(bi);await delay(550);const stopped=snap('timer-stopped').jobs;
  check('timer-final-cancel-stops',stopped.expiryTimerActive===false&&stopped.expiryTimerTicks===one.expiryTimerTicks);
  let state='PENDING',notices=0;const restarted=a.beginRenderJob(0,ca,.5);
  mod.setRendererImageLoadListener(()=>{notices++;state=a.pollRenderJob(restarted);});
  await delay(15350);mod.setRendererImageLoadListener(null);const expired=snap('timer-expired').jobs;
  check('timer-restart-and-expire',state==='ERROR'&&notices===1&&expired.expiryTimerActive===false&&expired.expiryTimerTicks>stopped.expiryTimerTicks,{state,notifications:notices});
  let good=true;for(let i=0;i<20;i++){const id=a.beginRenderJob(0,ca,.5);good&&=a.pollRenderJob(id)==='COMPLETE';}
  for(let i=0;i<20;i++){const opened=mod.HwpDocument.createEmpty();opened.beginRenderJob(0,ca,.5);opened.free();}
  await delay(550);const closed=snap('timer-after-repeat').jobs;
  check('timer-repeated-complete-idle',good&&closed.activeJobs===0&&closed.expiryTimerActive===false&&closed.expiryTimerTicks===expired.expiryTimerTicks,{completeCycles:20,disposeCycles:20,withoutInterveningStats:true});
  a.free();b.free();ca.width=ca.height=cb.width=cb.height=0;
  // Same replay rectangle and authoritative model in both engines, exact RGBA.
  const d=mod.HwpDocument.createEmpty(),r=ref.HwpDocument.createEmpty(),target=document.createElement('canvas'),expected=document.createElement('canvas');
  d.insertText(0,0,0,'before');r.insertText(0,0,0,'before');await finish(d,target,.7);r.renderPageToCanvas(0,expected,.7);
  d.insertText(0,0,0,'X');r.insertText(0,0,0,'X');
  const id=d.beginRenderPatchJob(0,target,.7,0,0,800,180);const result=d.pollRenderJob(id);
  r.renderPageToCanvas(0,expected,.7); // Full is the strict oracle, including fractional paper-edge alpha.
  const wrong=mismatch(classify(target),classify(expected));check('patch-job-exact-pinned-replay',result==='COMPLETE'&&wrong===0,{state:result,pixelMismatchCount:wrong,oracle:'pinned Full replay, exact RGBA including fractional edges'});
  const legacy=document.createElement('canvas');legacy.width=expected.width;legacy.height=expected.height;legacy.getContext('2d').drawImage(expected,0,0);
  d.renderPagePatchToCanvasFilteredWithProfile(0,legacy,.7,'all','screen',0,0,800,180);r.renderPagePatchToCanvasFilteredWithProfile(0,expected,.7,'all','screen',0,0,800,180);
  check('patch-job-legacy-compat-exact',mismatch(classify(legacy),classify(expected))===0);legacy.width=legacy.height=0;
  const sentinel=classify(target),old=d.beginRenderPatchJob(0,target,.7,0,0,800,180);d.insertText(0,0,0,'new');
  check('patch-job-mutation-stale-rejected',d.pollRenderJob(old)==='CANCELED'&&mismatch(sentinel,classify(target))===0);
  let rejected=false;try{d.beginRenderPatchJob(0,target,.7,0,0,-1,180);}catch{rejected=true;}check('patch-job-invalid-bounds-rejected',rejected);
  d.free();r.free();target.width=target.height=expected.width=expected.height=0;
  const q=mod.HwpDocument.createEmpty(),p=ref.HwpDocument.createEmpty(),qc=document.createElement('canvas'),pc=document.createElement('canvas');
  q.insertText(0,0,0,'start');p.insertText(0,0,0,'start');await finish(q,qc,1.04205322265625);
  q.insertText(0,0,0,'X');p.insertText(0,0,0,'X');const qi=q.beginRenderPatchJob(0,qc,1.04205322265625,0,0,800,180),qs=q.pollRenderJob(qi);
  p.renderPageToCanvas(0,pc,1.04205322265625);const fractionalWrong=mismatch(classify(qc),classify(pc));
  check('patch-job-fractional-edge-full-exact',qs==='COMPLETE'&&fractionalWrong===0,{state:qs,pixelMismatchCount:fractionalWrong,scale:1.04205322265625});// The explicit fractional API must choose Full even when a small requested region
  // omits changed pixels; this distinguishes fallback from coincidentally exact clipping.
  q.insertText(0,0,0,'Y');p.insertText(0,0,0,'Y');const beforeFallback=classify(qc);
  const fallback=q.beginRenderPatchJob(0,qc,1.04205322265625,0,500,100,1),untouched=mismatch(beforeFallback,classify(qc))===0;
  const fallbackState=q.pollRenderJob(fallback);p.renderPageToCanvas(0,pc,1.04205322265625);const fallbackWrong=mismatch(classify(qc),classify(pc));
  check('fractional-patch-policy-full-fallback',untouched&&fallbackState==='COMPLETE'&&fallbackWrong===0,{state:fallbackState,pixelMismatchCount:fallbackWrong,policy:'fractional effective scale uses Full replay, rectangle validated only'});
  q.free();p.free();qc.width=qc.height=pc.width=pc.height=0;
  const tall=mod.HwpDocument.createEmpty(),tallRef=ref.HwpDocument.createEmpty(),tc=document.createElement('canvas'),tr=document.createElement('canvas');
  for(const d of [tall,tallRef]){const def=JSON.parse(d.getPageDef(0));d.setPageDef(0,JSON.stringify({...def,width:300*75,height:9000*75,marginLeft:750,marginRight:750,marginTop:750,marginBottom:750,marginHeader:0,marginFooter:0}));d.insertText(0,0,0,'before');}
  await finish(tall,tc,2);tallRef.renderPageToCanvas(0,tr,2);tall.insertText(0,0,0,'X');tallRef.insertText(0,0,0,'X');
  const tallJob=tall.beginRenderPatchJob(0,tc,2,0,500,100,1),tallState=tall.pollRenderJob(tallJob);tallRef.renderPageToCanvas(0,tr,2);
  const tallWrong=mismatch(classify(tc),classify(tr));
  check('normalized-integer-patch-policy-full-fallback',tallState==='COMPLETE'&&tc.height>0&&tc.height<18000&&tallWrong===0,{state:tallState,pixelMismatchCount:tallWrong,requestedScale:2,normalizedCanvas:[tc.width,tc.height]});
  tall.free();tallRef.free();tc.width=tc.height=tr.width=tr.height=0;
  const iq=mod.HwpDocument.createEmpty(),ir=ref.HwpDocument.createEmpty(),ic=document.createElement('canvas'),ifull=document.createElement('canvas');
  iq.insertText(0,0,0,'before');ir.insertText(0,0,0,'before');await finish(iq,ic,1);
  iq.insertText(0,0,0,'X');ir.insertText(0,0,0,'X');const ij=iq.beginRenderPatchJob(0,ic,1,0,500,100,1),istate=iq.pollRenderJob(ij);
  ir.renderPageToCanvas(0,ifull,1);const iwrong=mismatch(classify(ic),classify(ifull));
  check('integer-patch-policy-full-fallback',istate==='COMPLETE'&&iwrong===0,{state:istate,pixelMismatchCount:iwrong,policy:'all explicit damage requests use atomic Full until native regional equivalence is established'});
  iq.free();ir.free();ic.width=ic.height=ifull.width=ifull.height=0;
  const complexBytes=new Uint8Array(await(await fetch('/complex-hwp.hwp')).arrayBuffer());
  const complexSha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',complexBytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  for(const scale of [1,0.521026611328125]) {
   const d=new mod.HwpDocument(complexBytes),r=new ref.HwpDocument(complexBytes),shown=document.createElement('canvas'),full=document.createElement('canvas');
   d.insertText(0,13,0,'AB');r.insertText(0,13,0,'AB');const initial=await finish(d,shown,scale,13);r.renderPageToCanvas(13,full,scale);const initialWrong=mismatch(classify(shown),classify(full));
   let complete=initial.state==='COMPLETE';
   for(let i=0;i<10;i++){d.insertText(0,13,0,'X');r.insertText(0,13,0,'X');const id=d.beginRenderPatchJob(13,shown,scale,0,0,793.7,180);complete&&=d.pollRenderJob(id)==='COMPLETE';}
   r.renderPageToCanvas(13,full,scale);const wrong=mismatch(classify(shown),classify(full));
   const sameModel=document.createElement('canvas');const sameState=await finish(d,sameModel,scale,13);const sameWrong=mismatch(classify(shown),classify(sameModel)),fullWrong=mismatch(classify(sameModel),classify(full));
   const diffSamples=[];let insideRegionDifferences=0,outsideRegionDifferences=0;
   if(sameWrong){const a=shown.getContext('2d').getImageData(0,0,shown.width,shown.height).data,b=sameModel.getContext('2d').getImageData(0,0,sameModel.width,sameModel.height).data;
    for(let i=0;i<a.length;i+=4){if([0,1,2,3].every(k=>a[i+k]===b[i+k]))continue;const x=i/4%shown.width,y=Math.floor(i/4/shown.width);
     if(y<Math.ceil(180*scale))insideRegionDifferences++;else outsideRegionDifferences++;
     if(diffSamples.length<8)diffSamples.push({x,y,shown:[...a.slice(i,i+4)],full:[...b.slice(i,i+4)]});}}
   check(scale===1?'complex-integer-patch-full-reference':'complex-fractional-patch-full-reference',complete&&wrong===0,{scale,pixelMismatchCount:wrong,insideRegionDifferences,outsideRegionDifferences,diffSamples,initialFullMismatchCount:initialWrong,sameModelFullMismatchCount:sameWrong,candidateFullVsPinnedFullMismatchCount:fullWrong,sameModelState:sameState.state,fixtureSha256:complexSha,oracle:'public original HWP, two independent models after identical edits; pinned Full RGBA'});
   d.free();r.free();shown.width=shown.height=full.width=full.height=sameModel.width=sameModel.height=0;
  }
 }
 mod.trimRendererCaches(0);mod.setRendererCacheBudget(256<<20,64<<20,256);snap('scheduler-final');
 return {status:tests.every(t=>t.status==='PASS')?'PASS':'FAIL',tests,checkpoints,notificationPolling:'initial poll then normal listener events only; timeout never polls'};
}

// Native test seeding uses the hub observer facade, preserving its single listener.
export async function seedResidents(mod,count=256) {
 mod.trimRendererCaches(0);mod.setRendererCacheBudget(1<<20,64<<20,256);
 for(let n=0;n<count;n++){
  const doc=imageDocument(mod,10000+n),canvas=document.createElement('canvas'),id=doc.beginRenderJob(0,canvas,.1);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('seed timeout')),3000);
   const poll=()=>{const state=doc.pollRenderJob(id);if(state==='COMPLETE'){clearTimeout(timer);resolve();}else if(state!=='PENDING'){clearTimeout(timer);reject(new Error(state));}};
   mod.setRendererImageLoadListener(()=>queueMicrotask(poll));poll();
  });doc.free();canvas.width=canvas.height=0;
 }
 mod.setRendererImageLoadListener(null);return {jobs:JSON.parse(mod.rendererJobStats()),cache:JSON.parse(mod.rendererCacheStats())};
}
