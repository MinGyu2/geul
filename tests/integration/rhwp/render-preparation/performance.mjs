// 같은 실행물의 독립 WASM 인스턴스 두 개. preparation gate만 다르다.
import {stats,canvas,frame,pixels,poll,finish,sleep} from './runtime.mjs';
const result={schema:1,contract:1,status:'FAIL',pairs:[],transitions:[]},modules={},docs=[],targets=[];
try{
 for(const name of ['baseline','candidate']){const m=modules[name]=await import(`/${name}/rhwp.js`);await m.default();m.setRendererCacheBudget(256<<20,64<<20,256);m.setRendererPreparationEnabled(name==='candidate');}
 const bytes=new Uint8Array(await(await fetch('/chemical.hwp')).arrayBuffer());
 result.sourceSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 const arms=Object.fromEntries(Object.entries(modules).map(([name,m])=>{const d=new m.HwpDocument(bytes),c=canvas();docs.push(d);targets.push(c);return [name,{m,d,c}];}));
 for(const temperature of ['cold','warm'])for(let trial=0;trial<3;trial++){
  for(const {d}of Object.values(arms))d.insertText(0,3,trial,'a');
  for(const page of [16,20,23]){
   const row={temperature,trial,page,scale:.5,dpr:devicePixelRatio};
   // 순서는 교대로 한다. 두 모듈은 cache/pool을 공유하지 않는다.
   for(const name of (trial%2?['candidate','baseline']:['baseline','candidate'])){
    const {m,d,c}=arms[name];if(temperature==='cold')m.trimRendererCaches(0);
    const before=stats(m),at=result.transitions.length,label=`${name}-${temperature}-${trial}-${page}`;
    const done=await finish(m,d,c,result.transitions,label,{page});const after=stats(m),trace=result.transitions.slice(at),jobs=trace.flatMap(r=>r.after.preparation.jobs.filter(j=>j.id===done.id));
    row[name]={...done,before,after,workPerPoll:jobs.map((j,i)=>({steps:j.steps-(jobs[i-1]?.steps??0),attempts:j.attempts-(jobs[i-1]?.attempts??0)})),maxObservedRetainedBytes:Math.max(0,...trace.map(r=>r.after.preparation.ownedBytes)),maxObservedResidentBytes:Math.max(...trace.map(r=>r.after.decodedLedger.residentBytes)),maxObservedNonresidentBytes:Math.max(...trace.map(r=>r.after.decodedLedger.nonresidentBytes)),job:jobs.at(-1)};
    if(done.outcome!=='COMPLETE')throw Error(label+' '+done.outcome);
   }
   row.rgba=pixels(arms.candidate.c,arms.baseline.c);if(row.rgba.pixels!==0||row.rgba.referenceNonWhite<100)throw Error('동일 실행물 RGBA');result.pairs.push(row);
  }
 }
 for(const d of docs.splice(0))d.free();for(const m of Object.values(modules))m.trimRendererCaches(0);await sleep(30);
 result.cleanup=Object.fromEntries(Object.entries(modules).map(([n,m])=>[n,stats(m)]));result.status='PASS';
}catch(error){result.error=String(error);}
finally{for(const d of docs)d.free();for(const c of targets)c.width=c.height=0;}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
