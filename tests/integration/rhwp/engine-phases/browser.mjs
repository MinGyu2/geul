// Isolated engine diagnostics. No native keydown measurement or performance acceptance.
const result={status:'RUNNING',official:false,rows:[],cleanup:{}};
const mods={},docs={},canvases={};
const snapshot=m=>({jobs:JSON.parse(m.rendererJobStats()),cache:JSON.parse(m.rendererCacheStats())});
const raf=()=>new Promise(resolve=>requestAnimationFrame(resolve));
function trace(context){return {context,sequence:0,stack:[],pending:new Map(),rows:[],limit:4096,dropped:0,errors:0};}
function pixels(c){return c.getContext('2d').getImageData(0,0,c.width,c.height).data;}
function exact(a,b){if(a.width!==b.width||a.height!==b.height)return false;const x=pixels(a),y=pixels(b);return x.length===y.length&&x.every((v,i)=>v===y[i]);}
try {
 const config=await(await fetch('/config.json')).json();
 for(const arm of config.arms){mods[arm]=await import(`/${arm}/rhwp.js`);await mods[arm].default();}
 for(const sample of ['basic-ko.hwp','basic-ko.hwpx','chemical.hwp','asset.hwpx']){
  const bytes=new Uint8Array(await(await fetch('/fixtures/'+sample)).arrayBuffer());
  for(const arm of Object.keys(mods)){const m=mods[arm];m.trimRendererCaches(0);docs[arm]=new m.HwpDocument(bytes);canvases[arm]=document.createElement('canvas');}
  const pages=sample==='chemical.hwp'?[0,14,15,16,19,20,21,23]:[0];
  for(let trial=0;trial<config.trials;trial++){
   // Same edit across all arms. Layout/mutation itself is outside poll, recorded independently.
   const edits={};
   for(const arm of Object.keys(mods)){const at=performance.now();docs[arm].insertText(0,sample==='chemical.hwp'?3:0,trial,'a');edits[arm]=performance.now()-at;}
   for(const page of pages){
    const row={sample,page,trial,cachePolicy:'existing budget; naturally cold first pass and warm later passes',edits,arms:{}};
    const ordered=config.arms.slice(trial%config.arms.length).concat(config.arms.slice(0,trial%config.arms.length));
    const arms=Math.floor(trial/config.arms.length)%2?ordered.toReversed():ordered;
    row.armOrder=arms;
    for(const arm of arms){const m=mods[arm],d=docs[arm],c=canvases[arm],before=snapshot(m),requested=performance.now();await raf();
     const id=d.beginRenderJob(page,c,.5),t=trace({sample,page,trial,job:id,arm});globalThis.__geulEngineTrace=arm==='on'?t:null;
     const started=performance.now();let outcome=d.pollRenderJob(id),polls=1;
     // Preserve real job continuation, with no invented synchronous zero-duration phases.
     while(outcome==='PENDING'&&polls<512){await new Promise(r=>setTimeout(r,0));outcome=d.pollRenderJob(id);polls++;}
     const published=performance.now();globalThis.__geulEngineTrace=null;
     await raf();const raf1=performance.now();await raf();const raf2=performance.now();
     row.arms[arm]={outcome,polls,ms:published-started,queueMs:started-requested,afterPublicationRaf1Ms:raf1-published,afterPublicationRaf2Ms:raf2-raf1,before,after:snapshot(m),phases:arm==='on'?t.rows:[],traceComplete:t.stack.length===0&&t.pending.size===0&&t.errors===0&&t.dropped===0,dropped:t.dropped};
     if(outcome!=='COMPLETE'||!row.arms[arm].traceComplete)throw Error('incomplete job/trace');
    }
    row.exactRGBA=config.arms.every(arm=>exact(canvases.baseline,canvases[arm]));
    result.rows.push(row);if(!row.exactRGBA)throw Error('exact RGBA mismatch');
   }
  }
  for(const arm of Object.keys(mods)){docs[arm].free();delete docs[arm];canvases[arm].width=canvases[arm].height=0;delete canvases[arm];mods[arm].trimRendererCaches(0);}
 }
 result.status='DIAGNOSTIC_COMPLETE';
}catch(error){result.status='FAIL';result.error=String(error);}
finally{globalThis.__geulEngineTrace=null;for(const d of Object.values(docs))d.free();for(const c of Object.values(canvases))c.width=c.height=0;for(const [arm,m]of Object.entries(mods)){m.trimRendererCaches(0);result.cleanup[arm]=snapshot(m);}}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
