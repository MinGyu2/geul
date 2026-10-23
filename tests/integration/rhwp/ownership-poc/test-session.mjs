import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const results=[];
async function setup() {
 const frames=[];globalThis.requestAnimationFrame=f=>{frames.push(f);return 1;};globalThis.innerHeight=1000;
 const docs=[];
 class Doc {
  constructor(){this.starts=0;this.cancels=0;this.id=0;this.state='PENDING';docs.push(this);}
  beginRenderJob(){this.starts++;return ++this.id;}
  cancelRenderJob(){this.cancels++;return 'CANCELED';}
  pollRenderJob(){return this.state;}
  free(){}
 }
 globalThis.__testLoad=async()=>({HwpDocument:Doc});
 class Session {
  constructor(id,backend,registry,loader){this.loader=loader;this.modelVersion=1;this.status={kind:'ready'};}
  prepareRendering(){return true;}
  subscribe(){return ()=>{};}
  releaseRendering(){}
  dispose(){this.doc?.free();}
 }
 let source=readFileSync(new URL('./session.mjs',import.meta.url),'utf8');
 source=source.replace(/const engine = await (?:module|loadEngine)\(\);/,'const engine = await globalThis.__testLoad();');
 const {createOwnershipSession}=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+Math.random()).toString('base64'));
 const session=createOwnershipSession(Session,1,null,null),loader=await session.loader();session.doc=loader.openDocument(new Uint8Array());
 const canvas={isConnected:true,width:1,height:1,getBoundingClientRect:()=>({top:0,bottom:100})};
 let last;const flush=()=>{const f=frames.shift();if(f){last=f;f();}};const notify=()=>last?.();
 return {session,canvas,doc:docs[0],loader,flush,notify,frames};
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
 'terminal-no-restart':async x=>{x.doc.state='COMPLETE';x.session.renderPage(0,x.canvas,1);x.flush();for(let i=0;i<20;i++)assert.equal(x.session.renderPage(0,x.canvas,1),true);assert.equal(x.doc.starts,1);}
};
for(const [name,body] of Object.entries(cases))test(name,async()=>{const x=await setup();try{await body(x);results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});throw e;}finally{x.session.dispose();if(process.env.SESSION_RESULT)writeFileSync(process.env.SESSION_RESULT,JSON.stringify({implementation:'session.mjs factory; only module loader replaced with deterministic fake engine',tests:results},null,2)+'\n');}});
