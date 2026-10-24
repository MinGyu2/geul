// Hypothesis: moving an edit late in the same section should expose useful prefix
// reuse if the existing engine already had it. No layout algorithm is changed.
const output={status:'RUNNING',official:false,hypothesis:'same section early/late edit; existing prefix reuse boundary',positions:[]};
try {
 const modules={};for(const arm of ['baseline','phase']){modules[arm]=await import(`/${arm}/rhwp.js`);await modules[arm].default();}
 const bytes=new Uint8Array(await(await fetch('/fixtures/3249937_asset_management_rules.hwpx')).arrayBuffer());
 for(const paragraph of [4,100,500]){
  const row={paragraph,arms:{}};
  for(const arm of ['baseline','phase']){
   const doc=new modules[arm].HwpDocument(bytes);
   try {
    const length=doc.getParagraphLength(0,paragraph),pages=doc.pageCount();
    let offset=length;for(let n=0;n<3;n++){offset=JSON.parse(doc.insertText(0,paragraph,offset,'a')).charOffset;}
    const edits=[];
    for(let n=0;n<10;n++){
     globalThis.__d4phase=arm==='phase'?[]:null;const at=performance.now();
     offset=JSON.parse(doc.insertText(0,paragraph,offset,'a')).charOffset;
     const ms=performance.now()-at,phases=globalThis.__d4phase;globalThis.__d4phase=null;
     edits.push({ms,phases});await new Promise(r=>setTimeout(r,0));
    }
    row.arms[arm]={originalLength:length,pagesBefore:pages,pagesAfter:doc.pageCount(),edits,caret:JSON.parse(doc.getCursorRect(0,paragraph,offset))};
   }finally{globalThis.__d4phase=null;doc.free();}
  }
  output.positions.push(row);
 }
 output.status='DIAGNOSTIC_COMPLETE';
}catch(error){output.status='FAIL';output.error=String(error);}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(output)});
