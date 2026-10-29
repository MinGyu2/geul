// 원본 WASM Full 경로의 Chrome CPU sampler. 공식 D4 runner와 별개다.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const [chromeArg, url, outputArg] = process.argv.slice(2);
if (![chromeArg, url, outputArg].every(Boolean)) throw new Error('chrome executable, diagnostic URL, and output path are required');
const output = resolve(outputArg);
const scratch = mkdtempSync(join(tmpdir(), 'geul-t010-page-reuse-chrome-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((yes, no) => {
  const server = createServer(); server.once('error', no);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => yes(value)); });
});
let chrome;
try {
  const port = await freePort(), profile = join(scratch, 'profile');
  chrome = spawn(chromeArg, ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
  let targets = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {}
    await sleep(100);
  }
  const target = targets?.find(t => t.type === 'page');
  if (!target) throw new Error('Chrome page target unavailable');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((yes, no) => { socket.onopen = yes; socket.onerror = no; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const done = pending.get(message.id); pending.delete(message.id); done(message); }
  };
  const command = (method, params = {}) => new Promise((yes, no) => {
    const id = ++sequence;
    pending.set(id, message => message.error ? no(new Error(message.error.message)) : yes(message.result));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  let ready=false;
  for(let n=0;n<600;n++){if(await evaluate('window.__t010ProfileReady === true')){ready=true;break;}await sleep(100);}
  if(!ready)throw new Error('CPU 진단 페이지가 준비되지 않음');
  await command('Profiler.enable');
  await command('Profiler.setSamplingInterval',{interval:200});
  const records=[];
  const {writeFileSync}=await import('node:fs');
  try {
    for(const mode of ['asset-warm','chemical-cold']){
      await command('Profiler.start');
      const measurements=await evaluate(`window.__t010ProfileRun(${JSON.stringify(mode)})`);
      const {profile}=await command('Profiler.stop');
      const profilePath=output+'.'+mode+'.cpuprofile';
      writeFileSync(profilePath,JSON.stringify(profile));
      records.push({...measurements,profilePath,sampleCount:profile.samples?.length??0});
    }
  } finally {await evaluate('window.__t010ProfileDispose()');socket.close();}
  writeFileSync(output,JSON.stringify({status:'PASS',official:false,scope:'원본 Full CPU sample 진단; D4 아님',samplingIntervalUs:200,records},null,2)+'\n');
  console.log(JSON.stringify({status:'PASS',records:records.map(r=>({mode:r.mode,iterations:r.iterations,samples:r.sampleCount,renderMs:r.renderMs}))}));

} finally {
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(3000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
