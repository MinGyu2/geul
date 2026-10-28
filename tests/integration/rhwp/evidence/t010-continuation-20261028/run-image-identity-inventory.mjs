// Diagnostic only. Runs an isolated candidate in a real-time headless Chrome instance.
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
const [candidateArg, sampleArg, htmlArg, chromeArg] = process.argv.slice(2);
if (![candidateArg,sampleArg,htmlArg,chromeArg].every(Boolean)) throw new Error('candidate sample html chrome required');
const candidate=resolve(candidateArg), manifest=JSON.parse(readFileSync(join(candidate,'ENGINE.json'),'utf8'));
if(manifest.buildStatus!=='PASS'||manifest.sourceStableDuringBuild!==true) throw new Error('unverified diagnostic build');
for(const name of ['rhwp.js','rhwp_bg.wasm']) if(createHash('sha256').update(readFileSync(join(candidate,name))).digest('hex')!==manifest.artifacts?.[name]) throw new Error('diagnostic artifact mismatch');
const scratch=mkdtempSync(join(tmpdir(),'geul-identity-inventory-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
let server,chrome;
try {
 symlinkSync(candidate,join(scratch,'candidate'));symlinkSync(resolve(sampleArg),join(scratch,'sample.hwp'));symlinkSync(resolve(htmlArg),join(scratch,'index.html'));
 const httpPort=await port(), debugPort=await port();
 server=spawn('python3',['-m','http.server',String(httpPort),'--bind','127.0.0.1','--directory',scratch],{stdio:'ignore'});
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${httpPort}/`)).ok){ready=true;break;}}catch{}await sleep(100);}if(!ready)throw new Error('HTTP server unavailable');
 chrome=spawn(chromeArg,['--headless','--disable-gpu','--no-sandbox','--remote-allow-origins=*',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${join(scratch,'profile')}`,`http://127.0.0.1:${httpPort}/`],{stdio:'ignore'});
 let targets;for(let i=0;i<200;i++){try{targets=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();if(targets.some(t=>t.type==='page'))break;}catch{}await sleep(100);}
 const page=targets?.find(t=>t.type==='page');if(!page)throw new Error('Chrome target unavailable');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((yes,no)=>{ws.onopen=yes;ws.onerror=no;});
 let seq=0;const pending=new Map();ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id&&pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}};
 const evaluate=expression=>new Promise((yes,no)=>{const id=++seq;pending.set(id,m=>m.error?no(new Error(m.error.message)):yes(m.result));ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));});
 let value;for(let i=0;i<600;i++){const r=await evaluate('document.querySelector("#out")?.textContent');value=r.result?.value;if(value&&value!=='RUNNING')break;await sleep(200);}
 ws.close();if(!value||value==='RUNNING')throw new Error('diagnostic timed out');
 const result=JSON.parse(value);console.log(JSON.stringify(result,null,2));if(result.status!=='DIAGNOSTIC_COMPLETE')process.exitCode=1;
} finally {
 for(const child of [chrome,server]) if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 rmSync(scratch,{recursive:true,force:true});
}
