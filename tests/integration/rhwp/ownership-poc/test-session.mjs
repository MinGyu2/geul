import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const results=[];
globalThis.__testChangedBand=(await import('../../../../src/components/Editor/rhwp/paintDiff.ts')).changedBand;
globalThis.__testDrawScale=(await import('../../../../src/components/Editor/rhwp/renderBudget.ts')).drawsAtRequestedScale;
async function setup() {
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
  free(){}
 }
 globalThis.__testLoad=async()=>({HwpDocument:Doc});
 class Session {
  constructor(id,backend,registry,loader){this.loader=loader;this.modelVersion=1;this.status={kind:'ready'};}
  prepareRendering(){return true;}
  paintedSummary(){return {structure:'s',leaves:[{ops:[String(this.modelVersion)],boxes:[{x:0,y:100,width:50,height:12}]}]};}
  get pages(){return [{width:600,height:800}];}
  subscribe(){return ()=>{};}
  releaseRendering(){}
  dispose(){this.doc?.free();}
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
const cases={
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
