// Experimental-only diagnostic config. It intentionally does not satisfy or bypass production gates.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mergeConfig } from 'vite';
import base from '../../../../../vite.config.ts';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
if (process.env.GEUL_T010_PAGE_REUSE_DIAGNOSTIC !== '1') throw new Error('explicit experimental page-reuse flag required');
if (process.env.VITE_GEUL_TEST_HOOKS !== '1') throw new Error('test-hook flag required');
const candidate = resolve(process.env.GEUL_T010_CANDIDATE || 'missing-candidate');
const manifest = JSON.parse(readFileSync(resolve(candidate, 'ENGINE.json'), 'utf8'));
if (manifest.buildStatus !== 'PASS' || manifest.sourceStableDuringBuild !== true || manifest.experimental !== true
    || manifest.productionApproval !== 'NOT_APPROVED' || manifest.imagePageIdentityAPI !== true || manifest.renderJobIdentityAPI !== true
    || manifest.pageIdentityIndependentOfPreparation !== true) {
  throw new Error('isolated experimental identity candidate required');
}
for (const name of ['rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts']) {
  if (createHash('sha256').update(readFileSync(resolve(candidate, name))).digest('hex') !== manifest.artifacts[name]) {
    throw new Error('experimental candidate artifact mismatch');
  }
}

export default mergeConfig(base, {
  root,
  define: { __T010_DAMAGE__: false },
  plugins: [{
    name: 'experimental-t010-page-identity-diagnostic-only',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/complex-hwp.hwp') {
          response.setHeader('Content-Type', 'application/octet-stream');
          response.setHeader('Cache-Control', 'no-store');
          response.end(readFileSync(resolve(root, 'external/rhwp/samples/rnote/연구노트(화학).hwp')));
          return;
        }
        if (!pathname.startsWith('/__ownership_candidate__/')) return next();
        const name = pathname.slice('/__ownership_candidate__/'.length);
        if (!['ENGINE.json', 'rhwp.js', 'rhwp_bg.wasm'].includes(name)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(readFileSync(resolve(candidate, name)));
      });
    },
  }],
});
