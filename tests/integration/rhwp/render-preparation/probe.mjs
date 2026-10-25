const result={schema:1,contract:1,status:'FAIL',tests:[],transitions:[]};
const check=(name,ok,detail={})=>{result.tests.push({name,status:ok?'PASS':'FAIL',...detail});if(!ok)throw Error(name);};
const modules={},docs=[],canvases=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const png=n=>{let c=document.createElement('canvas');c.width=c.height=64;c.getContext('2d').fillStyle=`rgb(${n*19%255},${n*53%255},${n*97%255})`;c.getContext('2d').fillRect(0,0,64,64);const b=Uint8Array.from(atob(c.toDataURL().split(',')[1]),x=>x.charCodeAt(0));c.width=c.height=0;return b;};
const data=Array.from({length:12},(_,i)=>png(i+1));
function page(m,bytes){let d=m.HwpDocument.createEmpty();for(const [i,b]of bytes.entries()){let p=JSON.parse(d.insertPicture(0,0,0,'',b,3000,3000,64,64,'png','',null,null));d.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:false,horzRelTo:'Paper',vertRelTo:'Paper',horzOffset:3000+(i%4)*4000,vertOffset:3000+Math.floor(i/4)*4000}));}docs.push(d);return d;}
function canvas(){let c=document.createElement('canvas');c.width=c.height=40;canvases.push(c);return c;}
try{
 for(const n of ['baseline','candidate']){let m=modules[n]=await import(`/${n}/rhwp.js`);await m.default();}
 let d=page(modules.baseline,[data[0]]),c=canvas();check('baseline-single-poll',d.pollRenderJob(d.beginRenderJob(0,c,.5))==='COMPLETE');
 let m=modules.candidate;d=page(m,[data[0]]);c=canvas();check('default-compatibility',d.pollRenderJob(d.beginRenderJob(0,c,.5))==='COMPLETE');
 m.trimRendererCaches(0);m.setRendererCacheBudget(0,1<<20,256);m.setRendererPreparationEnabled(true);
 const td=m.HwpDocument.createEmpty();docs.push(td);td.insertText(0,0,0,'한글 준비 텍스트');const tc=canvas(),ti=td.beginRenderJob(0,tc,.5);let ts;for(let n=0;n<10;n++){ts=td.pollRenderJob(ti);if(ts!=='PENDING')break;}result.textProbeOutcome=ts;if(ts!=='COMPLETE')throw Error('text source contract '+ts);
 d=page(m,data);c=canvas();let id=d.beginRenderJob(0,c,.5),outcome,ready=false,retained=false;
 for(let i=0;i<40;i++){let at=performance.now();outcome=d.pollRenderJob(id);let jobs=JSON.parse(m.rendererJobStats());result.transitions.push({outcome,ms:performance.now()-at,jobs});let j=jobs.preparation.jobs.find(j=>j.id===id);if(j?.phase==='ResourcesReady'&&outcome==='PENDING')ready=true;if(j?.keys>0&&outcome==='PENDING'&&jobs.preparation.ownedBytes>0&&c.width===40)retained=true;if(outcome!=='PENDING')break;await sleep(5);}
 check('actual-multi-poll',outcome==='COMPLETE'&&result.transitions.length>2,{outcome,polls:result.transitions.length});check('ready-before-replay',ready);check('retained-before-publication',retained);
 for(const x of docs)x.free();docs.length=0;m.trimRendererCaches(0);await sleep(20);let j=JSON.parse(m.rendererJobStats());check('final-cleanup',j.preparation.ownedBytes===0&&j.decodedLedger.uniqueBytes===0&&j.activeJobs===0&&j.uniqueResourceCount===0,{jobs:j});result.status='PASS';
}catch(e){result.error=String(e);}
finally{for(const d of docs)d.free();for(const c of canvases)c.width=c.height=0;}
await fetch('/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
