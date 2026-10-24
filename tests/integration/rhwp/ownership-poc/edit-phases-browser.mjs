// Standalone diagnostic: does not activate or substitute the app's engine.
const output={status:'RUNNING',official:false,scope:'Chrome standalone WASM insertText phases; no app handler/history/frame timing',documents:[]};
const percentile=values=>{const v=values.toSorted((a,b)=>a-b);return {n:v.length,p50:v[Math.round((v.length-1)*.5)],p95:v[Math.round((v.length-1)*.95)],max:v.at(-1)};};
try {
  const modules={};
  for(const name of ['baseline','phase']) {const m=await import(`/${name}/rhwp.js`);await m.default();modules[name]=m;}
  for(const [fixture,paragraph,offset] of [['basic-ko.hwpx',3,9],['3249937_asset_management_rules.hwpx',4,51]]) {
    const bytes=new Uint8Array(await (await fetch('/fixtures/'+fixture)).arrayBuffer());
    const row={fixture,paragraph,offset,arms:{}};
    const docs={};
    try {
      for(const name of ['baseline','phase']) {
        const doc=docs[name]=new modules[name].HwpDocument(bytes);
        const pages=doc.pageCount(),length=doc.getParagraphLength(0,paragraph);
        const sections=doc.getSectionCount(),paragraphs=Array.from({length:sections},(_,i)=>doc.getParagraphCount(i));
        // Same three warmup groups; original official editedRegion is AFTER these edits.
        // Reconstruct pre-warmup insertion position by removing three Right movements and six ASCII characters.
        let pos=offset-9;
        for(let n=0;n<3;n++) {pos=Math.min(pos+1,doc.getParagraphLength(0,paragraph));doc.insertText(0,paragraph,pos,'ab');pos+=2;}
        if(pos!==offset)throw new Error('warmup caret differs from official editedRegion');
        const rows=[];
        for(let n=0;n<30;n++) {
          pos=Math.min(pos+1,doc.getParagraphLength(0,paragraph));
          globalThis.__d4phase=name==='phase'?[]:null;
          const start=performance.now();const result=JSON.parse(doc.insertText(0,paragraph,pos,'a'));const wallMs=performance.now()-start;
          const phases=globalThis.__d4phase;globalThis.__d4phase=null;pos=result.charOffset;
          rows.push({wallMs,phases});
          doc.insertText(0,paragraph,pos,'b');pos++;
          await new Promise(r=>setTimeout(r,0));
        }
        row.arms[name]={pages,length,sections,paragraphs,rows,wall:percentile(rows.map(r=>r.wallMs)),phaseSummary:{}};
        if(name==='phase') {
          const names=new Set(rows.flatMap(r=>r.phases.map(p=>p.name)));
          for(const phase of names)row.arms[name].phaseSummary[phase]=percentile(rows.map(r=>r.phases.filter(p=>p.name===phase).reduce((a,p)=>a+p.ms,0)));
        }
      }
      row.equivalence={pages:docs.baseline.pageCount()===docs.phase.pageCount(),
        text:docs.baseline.getTextRange(0,paragraph,0,docs.baseline.getParagraphLength(0,paragraph))===docs.phase.getTextRange(0,paragraph,0,docs.phase.getParagraphLength(0,paragraph)),
        pageInfo:Array.from({length:docs.baseline.pageCount()},(_,i)=>docs.baseline.getPageInfo(i)===docs.phase.getPageInfo(i)).every(Boolean),
        caret:docs.baseline.getCursorRect(0,paragraph,offset)===docs.phase.getCursorRect(0,paragraph,offset)};
      if(!Object.values(row.equivalence).every(Boolean))throw new Error('diagnostic arms disagree');
      row.phaseUnionNote='insert.total contains phase spans; paginate.total/pass/normalize nested, never add them as independent cost';
      output.documents.push(row);
    } finally {globalThis.__d4phase=null;for(const doc of Object.values(docs))doc.free();}
  }
  if(!output.documents.every(d=>d.arms.phase.rows.some(r=>r.wallMs>0)))throw new Error('clock did not advance during synchronous WASM');
  output.status='DIAGNOSTIC_COMPLETE';
} catch(error) {output.status='FAIL';output.error=String(error);}
document.body.textContent=JSON.stringify(output);
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(output)});
