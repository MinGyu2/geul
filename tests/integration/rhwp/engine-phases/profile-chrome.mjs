#!/usr/bin/env node
// Optional sampling diagnostic. Its timings are not performance acceptance data.
import fs from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
const chrome=process.env.GEUL_D4_CHROME;
if(!chrome)throw Error('GEUL_D4_CHROME required');
const args=process.argv.slice(2);
if(args.includes('--version')){const r=spawnSync(chrome,['--version'],{stdio:'inherit'});process.exit(r.status??1);}
const output=process.env.GEUL_D4_CPU_PROFILE;
if(!output||fs.existsSync(output))throw Error('new GEUL_D4_CPU_PROFILE output required');
const profile=args.find(a=>a.startsWith('--user-data-dir='))?.split('=').slice(1).join('=');
const url=args.at(-1);
const child=spawn(chrome,[...args.slice(0,-1),'--remote-debugging-port=0','about:blank'],{stdio:'ignore'});
let socket,sequence=0,pending=new Map(),finished=false,started=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function send(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function finish(){
 if(finished)return;finished=true;
 try{if(started){const data=await send('Profiler.stop');fs.writeFileSync(output,JSON.stringify({scope:'separate 500us Chrome CPU sampling; not wall-performance acceptance',profile:data.profile})+'\n',{flag:'wx'});}}
 finally{socket?.close();child.kill('SIGTERM');setTimeout(()=>{child.kill('SIGKILL');process.exit(0);},1000);}
}
process.on('SIGTERM',()=>{finish().catch(e=>{console.error(e);child.kill('SIGKILL');process.exit(1);});});
try{
 let active;
 for(let i=0;i<100;i++){try{active=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0];break;}catch{}await delay(100);}
 if(!active)throw Error('no debug port');
 const tabs=await(await fetch('http://127.0.0.1:'+active+'/json/list')).json();
 const tab=tabs.find(t=>t.type==='page');socket=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:500});await send('Profiler.start');started=true;
 await send('Page.navigate',{url});
 // The parent runner terminates this process only after receiving/validating the browser result.
 await new Promise(()=>{});
}catch(e){console.error(e);child.kill('SIGKILL');process.exit(1);}
