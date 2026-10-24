// Isolated diagnostic of tree/decode/replay boundaries, exact Full pixels per pair.
const result={status:'RUNNING',official:false,scope:'Chrome direct full jobs; chemical fixture, not native app latency',rows:[]};
const docs={},canvases={},modules={};
try {
  const bytes=new Uint8Array(await(await fetch('/fixtures/chemical.hwp')).arrayBuffer());
  for(const name of ['baseline','phase']) {
    const mod=modules[name]=await import(`/${name}/rhwp.js`);await mod.default();
    const doc=docs[name]=new mod.HwpDocument(bytes),canvas=canvases[name]=document.createElement('canvas');
    // Fill the same existing decoded budget, without retaining additional frames.
    for(let page=0;page<doc.pageCount();page++) {
      const id=doc.beginRenderJob(page,canvas,.5),state=doc.pollRenderJob(id);
      if(state!=='COMPLETE')throw new Error('warm full job '+state);
    }
  }
  for(let trial=0;trial<3;trial++) {
    for(const doc of Object.values(docs))doc.insertText(0,3,trial,'a');
    for(const page of [14,15,16,19,20,21,23]) {
      const row={trial,page,arms:{}};
      for(const name of ['baseline','phase']) {
        const mod=modules[name],doc=docs[name],canvas=canvases[name];
        const before=JSON.parse(mod.rendererCacheStats());
        const id=doc.beginRenderJob(page,canvas,.5);
        globalThis.__d4phase=name==='phase'?[]:null;
        const at=performance.now(),outcome=doc.pollRenderJob(id),ms=performance.now()-at;
        const phases=globalThis.__d4phase;globalThis.__d4phase=null;
        row.arms[name]={ms,outcome,phases,cacheBefore:before,cacheAfter:JSON.parse(mod.rendererCacheStats()),jobs:JSON.parse(mod.rendererJobStats())};
        if(outcome!=='COMPLETE')throw new Error('full job '+outcome);
      }
      const a=canvases.baseline,b=canvases.phase;
      if(a.width!==b.width||a.height!==b.height)throw new Error('frame extent mismatch');
      const x=a.getContext('2d').getImageData(0,0,a.width,a.height).data,y=b.getContext('2d').getImageData(0,0,b.width,b.height).data;
      let pixels=0,maxDelta=0;
      for(let n=0;n<x.length;n+=4){const delta=Math.max(...[0,1,2,3].map(k=>Math.abs(x[n+k]-y[n+k])));if(delta){pixels++;maxDelta=Math.max(maxDelta,delta);}}
      row.exactRGBA={pixels,maxDelta,width:a.width,height:a.height};result.rows.push(row);
      if(pixels)throw new Error('diagnostic patch changed Full pixels');
      await new Promise(r=>setTimeout(r,0));
    }
  }
  result.status='DIAGNOSTIC_COMPLETE';
} catch(error){result.status='FAIL';result.error=String(error);}
finally {
  globalThis.__d4phase=null;
  for(const doc of Object.values(docs))doc.free();
  for(const canvas of Object.values(canvases))canvas.width=canvas.height=0;
  result.cleanup={};
  for(const [name,mod] of Object.entries(modules)){mod.trimRendererCaches(0);result.cleanup[name]={jobs:JSON.parse(mod.rendererJobStats()),cache:JSON.parse(mod.rendererCacheStats())};}
}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
