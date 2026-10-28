// Experimental-only Chrome runner for the isolated adapter harness.
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
  const evaluate = expression => new Promise((yes, no) => {
    const id = ++sequence;
    pending.set(id, message => message.error ? no(new Error(message.error.message)) : yes(message.result));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  let encoded = null;
  for (let attempt = 0; attempt < 900; attempt++) {
    const response = await evaluate('document.querySelector("#out")?.textContent');
    encoded = response.result?.value;
    if (encoded && encoded !== 'RUNNING') break;
    if (chrome.exitCode !== null) throw new Error(`Chrome exited early (${chrome.exitCode})`);
    await sleep(200);
  }
  socket.close();
  if (!encoded || encoded === 'RUNNING') throw new Error('page reuse diagnostic did not finish within 180 seconds');
  const result = JSON.parse(encoded);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, output, revisions: result.revisions?.map(r => ({ label:r.label, fullJobsStarted:r.fullJobsStarted, identityJobsSkipped:r.identityJobsSkipped, exactPages:r.exactRGBA?.exactPages })), cleanup: result.cleanup }, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
} finally {
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(3000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
