// Explicit, gated dev-server PoC. Normal vite/build configuration never imports this file.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mergeConfig } from 'vite';
import base from '../../../../vite.config.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
if (process.env.GEUL_T010_OWNERSHIP_POC !== '1' || process.env.VITE_GEUL_TEST_HOOKS !== '1') throw new Error('explicit ownership PoC flags required');
if (process.env.VITE_GEUL_TEST_RHWP_HISTORY === '1' && process.env.GEUL_T010_HISTORY_PERF_ONLY !== '1' && process.env.GEUL_T010_HISTORY_SAFETY_ONLY !== '1') throw new Error('history requires a separate explicit native performance or safety experiment flag');
const candidate = resolve(process.env.GEUL_T010_CANDIDATE || 'missing-candidate');
const schedulerMode = process.env.GEUL_T010_SCHEDULER_POC === '1';
const evidence = resolve(process.env.GEUL_T010_EVIDENCE || resolve(root, 'tests/integration/rhwp/evidence/' + (schedulerMode ? 't010-resource-scheduler' : 't010-render-ownership')));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const identity = json(resolve(candidate, 'ENGINE.json'));
const gates = json(resolve(evidence, 'engine-safety-gates.json'));
if (schedulerMode && identity.schedulerAPI !== true) throw new Error('scheduler candidate API required');
if (gates.status !== 'PASS' || identity.buildStatus !== 'PASS' || !identity.sourceStableDuringBuild
    || gates.wasmSha256 !== identity.artifacts['rhwp_bg.wasm']) throw new Error('candidate engine gates are not satisfied');
for (const name of ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts']) {
  if (createHash('sha256').update(readFileSync(resolve(candidate, name))).digest('hex') !== identity.artifacts[name]) throw new Error('candidate artifact mismatch');
}
for (const browser of ['chrome', 'webkit']) {
  const result = json(resolve(evidence, browser + '.json'));
  if (result.status !== 'PASS' || result.identities.candidate['rhwp_bg.wasm'] !== gates.wasmSha256) throw new Error('browser gate mismatch');
}

export default mergeConfig(base, {
  root,
  optimizeDeps: { entries: ['index.html'] },
  plugins: [{
    name: 'explicit-t010-ownership-poc',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] === resolve(root, 'src/components/Editor/rhwp/RhwpSurface.tsx')) {
        const before = 'if (canvas) session.renderPage(page, canvas, scale * ratio);';
        if (!code.includes(before)) throw new Error('PoC Surface completion boundary changed');
        return code.replace(before, 'if (canvas && !session.renderPage(page, canvas, scale * ratio)) rendered.current.version = -1;');
      }
      if (id.split('?')[0] !== resolve(root, 'src/components/Editor/documentWorkspace.ts')) return;
      const before = 'new RhwpEditorSession(sessionId, this.backend, this.sessions, this.loadModule)';
      if (!code.includes(before)) throw new Error('PoC injection boundary changed');
      return 'import { createOwnershipSession } from "/tests/integration/rhwp/ownership-poc/session.mjs";\n'
        + code.replace(before, 'createOwnershipSession(RhwpEditorSession, sessionId, this.backend, this.sessions)');
    },
    configureServer(server) {
      const held = new Map();
      server.middlewares.use((request, response, next) => {
        const parsed = new URL(request.url, 'http://localhost');
        if (!['/held-image.svg', '/release-image'].includes(parsed.pathname)) return next();
        const key = parsed.searchParams.get('key');
        if (parsed.pathname === '/release-image') {
          const entry = held.get(key); if(entry)entry.finish();
          response.statusCode = 204;response.end();return;
        }
        const data = parsed.searchParams.get('data');
        if (held.size >= 16 || !data?.startsWith('data:image/svg+xml;base64,') || data.length > (1 << 20)) {
          response.statusCode = 400;response.end();return;
        }
        const entry = { finish() {
          clearTimeout(entry.timer);held.delete(key);
          if(!response.destroyed){response.setHeader('Content-Type','image/svg+xml');response.setHeader('Cache-Control','no-store');response.end(parsed.searchParams.has('error')?'invalid image':Buffer.from(data.split(',')[1],'base64'));}
        } };
        entry.timer = setTimeout(()=>entry.finish(),20000);held.set(key,entry);
      });
      server.httpServer?.once('close',()=>{for(const entry of held.values())entry.finish();});
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split('?')[0].replace('/__ownership_candidate__/', '');
        if (!request.url?.startsWith('/__ownership_candidate__/')) return next();
        if (!['ENGINE.json', 'rhwp.js', 'rhwp_bg.wasm'].includes(name)) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(readFileSync(resolve(candidate, name)));
      });
    },
  }],
});
