// Isolated A/B diagnostic; the official ownership configuration is unchanged.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mergeConfig } from 'vite';
import base from '../t010-final-20261028/page-identity-diagnostic.vite.config.mjs';

const reference = resolve(process.env.GEUL_T010_REFERENCE_CANDIDATE || 'missing-reference');
const manifest = JSON.parse(readFileSync(resolve(reference, 'ENGINE.json'), 'utf8'));
if (manifest.artifacts['rhwp_bg.wasm'] !== 'a59421b800722e240113c54f335cb768c62a8c2ee648e008c3438d015751305a') {
  throw new Error('the q13 reference is required');
}
for (const name of ['rhwp.js', 'rhwp_bg.wasm']) {
  if (createHash('sha256').update(readFileSync(resolve(reference, name))).digest('hex') !== manifest.artifacts[name]) {
    throw new Error('q13 reference identity mismatch');
  }
}
export default mergeConfig(base, { plugins: [{
  name: 'experimental-t010-simd-reference',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (!path.startsWith('/__t010_reference__/')) return next();
      const name = path.slice('/__t010_reference__/'.length);
      if (!['ENGINE.json', 'rhwp.js', 'rhwp_bg.wasm'].includes(name)) {
        response.statusCode = 404; response.end(); return;
      }
      response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      response.end(readFileSync(resolve(reference, name)));
    });
  },
}] });
