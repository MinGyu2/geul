import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createLifecycleTrace, installLifecycleTrace } from './lifecycle-trace.mjs';
const results=[];
globalThis.__testChangedBand=(await import('../../../../src/components/Editor/rhwp/paintDiff.ts')).changedBand;
globalThis.__testDrawScale=(await import('../../../../src/components/Editor/rhwp/renderBudget.ts')).drawsAtRequestedScale;
async function setup() {
 globalThis.window = {};
 globalThis.__T010_DAMAGE__=false;
 const frames=[];globalThis.requestAnimationFrame=f=>{frames.push(f);return 1;};globalThis.innerHeight=1000;
 const docs=[];
 class Doc {
  constructor(){this.patches=0;this.starts=0;this.cancels=0;this.id=0;this.state='PENDING';docs.push(this);}
  beginRenderJob(page,canvas){this.canvas=canvas;this.starts++;return ++this.id;}
  beginRenderPatchJob(page,canvas,scale,...rect){this.lastPatchRect=rect;this.patches++;return this.beginRenderJob(page,canvas);}
  cancelRenderJob(){this.cancels++;return 'CANCELED';}
  pollRenderJob(){if(this.state==='COMPLETE'){this.canvas.width=1;this.canvas.height=1;}return this.state;}
  getSourceFormat(){return this.sourceFormat??'hwpx';}
  restoreSnapshot(){}
  free(){if(this.failFree)throw new Error('free fault');}
 }
 globalThis.__testLoad=async()=>({HwpDocument:Doc});
 class Session {
  constructor(id,backend,registry,loader){this.loader=loader;this.modelVersion=1;this.status={kind:'ready'};}
  prepareRendering(){return true;}
  paintedSummary(){return {structure:'s',leaves:[{ops:[String(this.modelVersion)],boxes:[{x:0,y:100,width:50,height:12}]}]};}
  get pages(){return [{width:600,height:800}];}
  subscribe(){return ()=>{};}
  releaseRendering(){if(this.failRelease)throw new Error('release fault');}
  dispose(){if(this.failDispose)throw new Error('dispose fault');this.doc?.free();}
 }
 let source=readFileSync(new URL('./session.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'');
 source='const changedBand=globalThis.__testChangedBand,drawsAtRequestedScale=globalThis.__testDrawScale;\n'+source;
 source=source.replace('sessions.add(handle);','sessions.add(handle); globalThis.__testHandle=handle;');
 source=source.replace(/const engine = await (?:module|loadEngine)\(\);/,'const engine = await globalThis.__testLoad();');
 const {createOwnershipSession}=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+Math.random()).toString('base64'));
 const session=createOwnershipSession(Session,1,null,null),loader=await session.loader();session.doc=loader.openDocument(new Uint8Array());
 const canvas={isConnected:true,width:1,height:1,getBoundingClientRect:()=>({top:0,bottom:100})};
 let last;const flush=()=>{const f=frames.shift();if(f){last=f;f();}};const notify=()=>last?.();
 return {session,canvas,doc:docs[0],loader,flush,notify,frames,handle:globalThis.__testHandle};
}
test('input scope is bounded and removed', async () => {
 let listener; const target={document:{addEventListener(_name, fn){listener=fn;},removeEventListener(_name, fn){assert.equal(listener,fn);listener=null;}}};
 const installed=installLifecycleTrace(target, 3);
 listener({target:{classList:{contains:()=>true}}, data:'must-not-be-recorded'});
 assert.equal(target.__d4LifecycleInput,1);
 await Promise.resolve();assert.equal(target.__d4LifecycleInput,null);
 const snapshot=installed.snapshot();assert.equal(snapshot.complete,true);assert.equal(snapshot.records[0].input,1);
 assert.ok(!JSON.stringify(snapshot).includes('must-not-be-recorded'));
 installed.stop();assert.equal(listener,null);assert.equal(target.__d4LifecycleTrace,undefined);
});
const cases={
 'trace-correlates-cancel-and-replacement':async x=>{
  const trace=createLifecycleTrace(); window.__d4LifecycleTrace=trace; window.__d4LifecycleInput=17;
  x.session.renderPage(0,x.canvas,1);x.flush(); x.session.modelVersion++; window.__d4LifecycleInput=null;
  x.session.renderPage(1,x.canvas,2);x.flush(); x.doc.state='COMPLETE';x.notify();
  const rows=trace.snapshot().records, starts=rows.filter(r=>r.event==='job-start');
  assert.equal(starts.length,2);assert.deepEqual(starts.map(r=>r.job),[1,2]);
  assert.deepEqual(starts.map(r=>r.version),[1,2]);assert.deepEqual(starts.map(r=>r.page),[0,1]);
  assert.equal(starts[0].input,17);assert.equal(starts[1].input,null);assert.equal(starts[0].canvas,starts[1].canvas);
  assert.ok(rows.some(r=>r.event==='cancel' && r.job===1));
  assert.ok(rows.some(r=>r.event==='complete' && r.job===2));
  assert.ok(!rows.some(r=>r.event==='complete' && r.job===1));
  assert.ok(rows.every(r=>!Object.values(r).some(v=>v && typeof v==='object')));
 },
 'trace-different-targets':async x=>{
  const trace=createLifecycleTrace();window.__d4LifecycleTrace=trace;
  x.session.renderPage(0,x.canvas,1);x.flush();const other={...x.canvas};x.session.renderPage(0,other,1);
  const requests=trace.snapshot().records.filter(r=>r.event==='request');
  assert.notEqual(requests[0].canvas,requests[1].canvas);assert.notEqual(requests[0].request,requests[1].request);
 },
 'trace-bounded-and-detached':async x=>{
  const trace=createLifecycleTrace(2);window.__d4LifecycleTrace=trace;
  x.session.renderPage(0,x.canvas,1);x.flush();x.session.renderPage(0,x.canvas,1);
  const snap=trace.snapshot();assert.equal(snap.records.length,2);assert.ok(snap.dropped>0);assert.equal(snap.complete,false);assert.throws(()=>trace.requireComplete(),/incomplete/);
  snap.records[0].event='tampered';assert.notEqual(trace.snapshot().records[0].event,'tampered');
  assert.throws(()=>createLifecycleTrace().record({event:'test',canvas:{}}),TypeError);
 },
 'identical-pending':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();for(let i=0;i<20;i++)x.session.renderPage(0,x.canvas,1);assert.equal(x.doc.cancels,0);assert.equal(x.doc.starts,1);},
 'different-page':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();x.session.renderPage(1,x.canvas,1);x.flush();assert.equal(x.doc.cancels,1);assert.equal(x.doc.starts,2);},
 'different-scale':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();x.session.renderPage(0,x.canvas,2);x.flush();assert.equal(x.doc.cancels,1);assert.equal(x.doc.starts,2);},
 'mutation':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();x.session.modelVersion++;x.session.renderPage(0,x.canvas,1);x.flush();assert.equal(x.doc.cancels,1);assert.equal(x.doc.starts,2);},
 'reload':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();x.doc.free();x.session.doc=x.loader.openDocument(new Uint8Array());x.session.renderPage(0,x.canvas,1);x.flush();assert.equal(x.doc.cancels,1);assert.equal(x.session.doc.starts,1);},
 'complete-after-duplicates':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();x.session.renderPage(0,x.canvas,1);x.doc.state='COMPLETE';x.notify();x.flush();assert.equal(x.session.renderPage(0,x.canvas,1),true);assert.equal(x.doc.starts,1);},
 'error-then-other-page':async x=>{x.doc.state='ERROR';x.session.renderPage(0,x.canvas,1);x.flush();x.doc.state='COMPLETE';x.session.renderPage(1,x.canvas,1);x.flush();assert.equal(x.session.renderPage(1,x.canvas,1),true);assert.equal(x.doc.starts,2);},
 'disconnected':async x=>{x.session.renderPage(0,x.canvas,1);x.flush();x.canvas.isConnected=false;x.notify();assert.equal(x.doc.cancels,1);},
 'queued-identical':async x=>{for(let i=0;i<20;i++)x.session.renderPage(0,x.canvas,1);x.flush();assert.equal(x.doc.starts,1);assert.equal(x.doc.cancels,0);},
 'damage-retains-valid-previous-frame':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();x.session.modelVersion++;x.session.renderPage(0,x.canvas,1);assert.equal(x.doc.patches,0);assert.equal(x.doc.starts,2);},
 'fractional-region-replays-complete-page':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,.7);x.flush();x.session.modelVersion++;x.session.renderPage(0,x.canvas,.7);x.flush();assert.equal(x.doc.patches,0);assert.equal(x.doc.starts,2);},
 'damage-resize-falls-back-full':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();x.canvas.width++;x.session.modelVersion++;assert.equal(x.session.renderPage(0,x.canvas,1),false);x.flush();assert.equal(x.doc.patches,0);assert.equal(x.doc.starts,2);},
 'cell-edit-falls-back-full':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();x.session.caret={cell:{cell:1}};x.session.modelVersion++;x.session.renderPage(0,x.canvas,1);assert.equal(x.doc.patches,0);assert.equal(x.doc.starts,2);},
 'summary-lru-keeps-newly-touched-frame':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';const targets=Array.from({length:65},()=>({...x.canvas}));for(const c of targets){x.session.renderPage(0,c,1);x.flush();}x.session.modelVersion++;x.session.renderPage(0,targets[0],1);x.flush();x.session.modelVersion++;x.session.renderPage(0,targets[0],1);x.flush();assert.equal(x.doc.patches,0);},
 'background-pages-preserve-visible-damage-basis':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();for(let n=0;n<12;n++){const offscreen={...x.canvas,getBoundingClientRect:()=>({top:2900,bottom:3000})};x.session.renderPage(n+1,offscreen,1);x.flush();}x.session.modelVersion++;x.session.renderPage(0,x.canvas,1);x.flush();assert.equal(x.doc.patches,0);},
 'unchanged-background-pages-reuse-bounded-summaries':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';Object.defineProperty(x.session,'pages',{get:()=>Array.from({length:24},()=>({width:600,height:800}))});const original=x.session.paintedSummary.bind(x.session);x.session.paintedSummary=(doc,page)=>({...original(),leaves:[{ops:[page===0?String(x.session.modelVersion):'fixed'],boxes:[{x:0,y:100,width:50,height:12}]}]});const targets=Array.from({length:24},(_,i)=>({...x.canvas,getBoundingClientRect:()=>({top:i===0?0:2900,bottom:i===0?100:3000})}));for(let i=0;i<24;i++){x.session.renderPage(i,targets[i],1);x.flush();}const before=x.doc.starts;x.session.modelVersion++;for(let i=0;i<24;i++){x.session.renderPage(i,targets[i],1);x.flush();}assert.equal(x.doc.starts-before,1);assert.equal(x.doc.patches,0);},
 'summary-aggregate-budget-remains-bounded':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.paintedSummary=()=>({structure:'s',leaves:[{ops:['a'.repeat(50000)],boxes:[{x:0,y:100,width:50,height:12}]}]});for(let i=0;i<64;i++){x.session.renderPage(0,{...x.canvas},1);x.flush();}const stats=x.handle.stats();assert.ok(stats.summaryCodeUnits<=8*262144);assert.ok(stats.summaries<64);assert.equal(stats.maxSummaryTotalCodeUnits,8*262144);},
 'snapshot-restore-invalidates-damage-basis':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();x.doc.restoreSnapshot(1);x.session.modelVersion++;assert.equal(x.session.renderPage(0,x.canvas,1),false);x.flush();assert.equal(x.doc.patches,0);assert.equal(x.doc.starts,2);},
 'initial-mount-cleanup-preserves-pending':async x=>{x.doc.state='COMPLETE';assert.equal(x.session.renderPage(0,x.canvas,1),false);assert.equal(x.doc.starts,0);x.session.releaseRendering();assert.equal(x.session.renderPage(0,x.canvas,1),false);x.flush();assert.equal(x.doc.starts,1);assert.ok(x.canvas.width>0);assert.equal(x.session.renderPage(0,x.canvas,1),true);},
 'completed-external-resize-rerenders':async x=>{x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();x.canvas.width++;assert.equal(x.session.renderPage(0,x.canvas,1),false);x.flush();assert.equal(x.session.renderPage(0,x.canvas,1),true);assert.equal(x.doc.starts,2);},
 'damage-identical-paint-skips-job':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();const summary=x.session.paintedSummary();x.session.paintedSummary=()=>summary;x.session.modelVersion++;assert.equal(x.session.renderPage(0,x.canvas,1),true);assert.equal(x.doc.starts,1);},
 'explicit-repaint-runs-full-even-unchanged':async x=>{globalThis.__T010_DAMAGE__=true;x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();x.handle.repaint();x.flush();assert.equal(x.doc.starts,2);assert.equal(x.doc.patches,0);assert.equal(x.session.renderPage(0,x.canvas,1),true);},
 'terminal-no-restart':async x=>{x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();for(let i=0;i<20;i++)assert.equal(x.session.renderPage(0,x.canvas,1),true);assert.equal(x.doc.starts,1);}
};
for(const [name,body] of Object.entries(cases))test(name,async()=>{const x=await setup();try{await body(x);results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});throw e;}finally{x.session.dispose();if(process.env.SESSION_RESULT)writeFileSync(process.env.SESSION_RESULT,JSON.stringify({implementation:'session.mjs factory; only module loader replaced with deterministic fake engine',sourceSha256:createHash('sha256').update(readFileSync(new URL('./session.mjs',import.meta.url))).digest('hex'),testSha256:createHash('sha256').update(readFileSync(new URL('./test-session.mjs',import.meta.url))).digest('hex'),tests:results},null,2)+'\n');}});

const sample = (event, extras={}) => ({event, at:1, session:1, document:1, request:1, input:null, page:0, canvas:1, scale:1, generation:1, version:1, mode:'full', ...extras});
test('lifecycle validity is separate from capture integrity', () => {
 const empty=createLifecycleTrace();assert.equal(empty.snapshot().lifecycleValid,'INCOMPLETE');assert.equal(empty.snapshot().complete,true);
 for (const row of [{}, {event:'request'}, sample('unknown'), sample('request',{request:null})]) {
  const c=createLifecycleTrace();assert.throws(()=>c.record(row));assert.equal(c.snapshot().captureComplete,false);
 }
 for(const rows of [[sample('job-start',{job:1})],[sample('poll',{job:1})],[sample('complete',{job:1})]]) {
  const c=createLifecycleTrace();rows.forEach(r=>c.record(r));assert.equal(c.snapshot().lifecycleValid,'INCOMPLETE');
 }
 const c=createLifecycleTrace();[sample('request'),sample('queue'),sample('job-start',{job:3}),sample('poll',{job:3,state:'PENDING'})].forEach(r=>c.record(r));
 assert.equal(c.snapshot().lifecycleValid,'VALID');assert.equal(c.snapshot({terminal:true}).lifecycleValid,'INCOMPLETE');
 c.record(sample('cancel',{job:3,reason:'stale'}));assert.equal(c.snapshot({terminal:true}).lifecycleValid,'VALID');
 c.record(sample('complete',{job:3}));assert.notEqual(c.snapshot({terminal:true}).lifecycleValid,'VALID');
 assert.deepEqual(c.snapshot(),c.snapshot());assert.equal(c.snapshot().causalityComplete,false);
});
test('queue displacement and reuse have explicit source', () => {
 const c=createLifecycleTrace();
 [sample('request'),sample('queue'),sample('request',{request:2}),sample('reuse-pending',{request:2,relatedRequest:1}),sample('stale-drop',{reason:'replacement'})].forEach(r=>c.record(r));
 assert.equal(c.snapshot({terminal:true}).lifecycleValid,'VALID');
});
test('bounded strings and aggregate use UTF-16 code units', () => {
 const c=createLifecycleTrace(20,{total:300});
 c.record({event:'input',at:1,input:1,reason:'한'.repeat(128)});
 c.record({event:'input',at:2,input:2,reason:'😀'.repeat(64)});
 assert.equal(c.snapshot().captureComplete,false);assert.ok(c.snapshot().dropped>0);
 const d=createLifecycleTrace();assert.throws(()=>d.record({event:'input',at:1,input:1,reason:'😀'.repeat(65)}));
 assert.equal(d.snapshot().invalid,1);assert.equal(d.snapshot().records.length,0);
});
test('adapter input event connects synchronous request only', async () => {
 const x=await setup();let listener;window.document={addEventListener(_n,fn){listener=fn;},removeEventListener(){}};
 const capture=installLifecycleTrace(window);listener({target:{classList:{contains:()=>true}}});
 x.session.renderPage(0,x.canvas,1);x.flush();await Promise.resolve();x.session.renderPage(0,x.canvas,1);
 const rows=capture.snapshot().records, requests=rows.filter(r=>r.event==='request');
 assert.equal(requests[0].input,1);assert.equal(requests[1].input,null);
 assert.equal(rows.find(r=>r.event==='job-start').request,requests[0].request);
 x.session.dispose();capture.stop();
});
test('release and repaint identities match observed outcome', async () => {
 const x=await setup();const c=createLifecycleTrace();window.__d4LifecycleTrace=c;x.doc.state='COMPLETE';
 x.session.renderPage(0,x.canvas,1);x.flush();x.session.renderPage(0,x.canvas,1);x.handle.repaint();x.flush();
 const rows=c.snapshot().records, complete=rows.find(r=>r.event==='complete'), reuse=rows.find(r=>r.event==='reuse-complete');
 assert.equal(reuse.relatedRequest,complete.request);assert.ok(rows.some(r=>r.event==='request' && r.reason==='explicit-repaint' && r.relatedRequest===complete.request));
 x.session.dispose();const events=c.snapshot().records.filter(r=>r.event.startsWith('release-'));
 assert.ok(events.some(r=>r.event==='release-requested' && r.reason==='dispose'));
 assert.ok(events.some(r=>r.event==='release-completed' && r.reason==='dispose'));
});

test('release failure is not reported as success', async () => {
 for (const kind of ['document-free','releaseRendering','dispose']) {
  const x=await setup(), trace=createLifecycleTrace();window.__d4LifecycleTrace=trace;
  if(kind==='document-free')x.doc.failFree=true;
  if(kind==='releaseRendering')x.session.failRelease=true;
  if(kind==='dispose')x.session.failDispose=true;
  const run=()=>kind==='document-free'?x.doc.free():kind==='releaseRendering'?x.session.releaseRendering():x.session.dispose();
  assert.throws(run,/fault/);
  const rows=trace.snapshot().records.filter(r=>r.reason===kind);
  assert.deepEqual(rows.map(r=>r.event),['release-requested','release-failed']);
  x.doc.failFree=false;x.session.failDispose=false;x.session.failRelease=false;x.session.dispose();
 }
});
test('diagnostic failure preserves scheduler behavior and invalidates capture', async () => {
 async function run(fail) {
  const x=await setup(), collector=createLifecycleTrace();
  if(fail){const record=collector.record;collector.record=()=>{throw Error('observer fault');};collector.originalRecord=record;window.__d4LifecycleTrace=collector;}
  x.session.renderPage(0,x.canvas,1);x.flush();x.session.renderPage(0,x.canvas,1);x.doc.state='COMPLETE';x.notify();
  const result=[x.doc.starts,x.doc.cancels,x.session.renderPage(0,x.canvas,1),x.canvas.width,x.canvas.height];
  x.session.dispose();if(fail)assert.equal(collector.snapshot().captureComplete,false);return result;
 }
 assert.deepEqual(await run(false),await run(true));
});
test('job-start failure is recorded without invented job', async () => {
 const x=await setup(),c=createLifecycleTrace();window.__d4LifecycleTrace=c;x.doc.beginRenderJob=()=>{throw Error('start fault');};
 x.session.renderPage(0,x.canvas,1);x.flush();const event=c.snapshot().records.find(r=>r.event==='job-start-failed');
 assert.ok(event);assert.equal(event.job,undefined);assert.equal(c.snapshot({terminal:true}).lifecycleValid,'VALID');x.session.dispose();
});
test('active cancellation and document replacement keep release boundaries distinct', async () => {
 const x=await setup(), c=createLifecycleTrace();window.__d4LifecycleTrace=c;
 x.session.renderPage(0,x.canvas,1);x.flush();x.doc.free();x.session.doc=x.loader.openDocument(new Uint8Array());
 x.session.renderPage(0,x.canvas,1);x.flush();
 const rows=c.snapshot().records, starts=rows.filter(r=>r.event==='job-start');
 assert.equal(starts.length,2);assert.notEqual(starts[0].document,starts[1].document);
 const cancel=rows.findIndex(r=>r.event==='cancel' && r.job===starts[0].job);
 const release=rows.findIndex(r=>r.event==='release-completed' && r.reason==='document-free');
 assert.ok(cancel>=0 && cancel<release);x.session.dispose();
});
test('repeated release reports each actual call', async () => {
 const x=await setup(),c=createLifecycleTrace();window.__d4LifecycleTrace=c;
 x.session.releaseRendering();x.session.releaseRendering();
 assert.deepEqual(c.snapshot().records.filter(r=>r.reason==='releaseRendering').map(r=>r.event),
 ['release-requested','release-completed','release-requested','release-completed']);x.session.dispose();
});
test('contradictory request identity and completion after cancel are invalid', () => {
 for (const tail of [[sample('poll',{job:1,page:2})], [sample('cancel',{job:1}),sample('complete',{job:1})]]) {
  const c=createLifecycleTrace();[sample('request'),sample('queue'),sample('job-start',{job:1}),...tail].forEach(r=>c.record(r));
  assert.equal(c.snapshot().lifecycleValid,'INVALID');
 }
});
test('completion without observed poll is incomplete', () => {
 const c=createLifecycleTrace();[sample('request'),sample('queue'),sample('job-start',{job:1}),sample('complete',{job:1})].forEach(r=>c.record(r));
 assert.equal(c.snapshot({terminal:true}).lifecycleValid,'INCOMPLETE');
});

test('preparation failure is not misreported as job-start failure', async () => {
 const x=await setup(), c=createLifecycleTrace();window.__d4LifecycleTrace=c;globalThis.__T010_DAMAGE__=true;
 x.session.paintedSummary=()=>{throw Error('preparation fault');};x.session.renderPage(0,x.canvas,1);x.flush();
 assert.ok(c.snapshot().records.some(r=>r.event==='prepare-failed'));
 assert.ok(!c.snapshot().records.some(r=>r.event==='job-start-failed'));assert.equal(x.doc.starts,0);x.session.dispose();
});
test('poll outcome must justify completion', () => {
 for(const [states,expected] of [[['PENDING','COMPLETE'],'VALID'],[['PENDING'],'INVALID'],[['ERROR'],'INVALID'],[['RESOURCE_LIMIT'],'INVALID'],[['COMPLETE'],'VALID'],[['UNKNOWN'],'INVALID']]) {
  const c=createLifecycleTrace();[sample('request'),sample('queue'),sample('job-start',{job:1}),...states.map(state=>sample('poll',{job:1,state})),sample('complete',{job:1})].forEach(r=>c.record(r));
  assert.equal(c.snapshot({terminal:true}).lifecycleValid,expected,states.join(','));
 }
});
test('pending reuse requires actual render equivalence', () => {
 for(const [field,value] of [['canvas',2],['page',2],['scale',2],['generation',2],['version',2],['mode','damage']]) {
  const c=createLifecycleTrace();[sample('request'),sample('queue'),sample('request',{request:2,[field]:value}),sample('reuse-pending',{request:2,relatedRequest:1,[field]:value})].forEach(r=>c.record(r));
  assert.equal(c.snapshot().lifecycleValid,'INVALID',field);
 }
});
test('completed reuse requires matching target, with explicit unchanged summary exception', () => {
 for(const [change,reason,expected] of [[{},null,'VALID'],[{version:2},null,'INVALID'],[{version:2,mode:'damage'},'unchanged-summary','VALID'],[{canvas:2},null,'INVALID']]) {
  const sourceMode=reason?'damage':'full';const c=createLifecycleTrace();
  [sample('request',{mode:sourceMode}),sample('queue',{mode:sourceMode}),sample('job-start',{job:1,mode:sourceMode}),sample('poll',{job:1,state:'COMPLETE',mode:sourceMode}),sample('complete',{job:1,mode:sourceMode}),sample('request',{request:2,mode:sourceMode,...change}),sample('reuse-complete',{request:2,relatedRequest:1,mode:sourceMode,...change,...(reason?{reason}:{})})].forEach(r=>c.record(r));
  assert.equal(c.snapshot().lifecycleValid,expected);
 }
});
test('release completion must match originating document', () => {
 const c=createLifecycleTrace();[sample('request'),{event:'release-requested',at:1,session:1,document:1,reason:'document-free'},{event:'release-completed',at:1,session:1,document:2,reason:'document-free'}].forEach(r=>c.record(r));
 assert.notEqual(c.snapshot().lifecycleValid,'VALID');
});
test('old document release retains original identity after replacement', async () => {
 const x=await setup(),c=createLifecycleTrace();window.__d4LifecycleTrace=c;const old=x.doc;
 old.free();x.session.doc=x.loader.openDocument(new Uint8Array());old.free();
 const rows=c.snapshot().records.filter(r=>r.reason==='document-free');assert.deepEqual(rows.map(r=>r.document),[1,1,1,1]);x.session.dispose();
});

test('terminal successful poll cannot be canceled or reused as pending', () => {
 const prefix=[sample('request'),sample('queue'),sample('job-start',{job:1}),sample('poll',{job:1,state:'COMPLETE'})];
 for (const tail of [[sample('cancel',{job:1})],[sample('request',{request:2}),sample('reuse-pending',{request:2,relatedRequest:1})]]) {
  const c=createLifecycleTrace();[...prefix,...tail].forEach(r=>c.record(r));assert.equal(c.snapshot().lifecycleValid,'INVALID');
 }
});

test('completion state contradicting a successful poll is invalid', () => {
 const c=createLifecycleTrace();[sample('request'),sample('queue'),sample('job-start',{job:1}),sample('poll',{job:1,state:'COMPLETE'}),sample('complete',{job:1,state:'ERROR'})].forEach(r=>c.record(r));
 assert.equal(c.snapshot().lifecycleValid,'INVALID');
});
