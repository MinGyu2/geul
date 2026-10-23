import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import base from '../../../../vite.config.ts';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
if(process.env.GEUL_T010_PINNED_PERF_ONLY!=='1'||process.env.VITE_GEUL_TEST_HOOKS!=='1'||process.env.VITE_GEUL_TEST_RHWP_HISTORY!=='1')throw new Error('explicit pinned native performance flags required');
export default mergeConfig(base,{plugins:[{
 name:'explicit-pinned-module-observer',enforce:'pre',
 transform(code,id){
  if(id.split('?')[0]!==resolve(root,'src/components/Editor/rhwp/rhwpModule.ts'))return;
  const before='const HwpDocument = generated.HwpDocument;';
  if(!code.includes(before))throw new Error('pinned module observation boundary changed');
  const importer='(url) => import(/* @vite-ignore */ url)';
  if(!code.includes(importer))throw new Error('pinned runtime import boundary changed');
  code=code.replace(importer,'(url) => Reflect.get(globalThis, "__geulPinnedRuntimeImport")(url)');
  return code.replace(before,'Object.assign(globalThis, { __geulPinnedProbeEngine: generated });\n'+before);
 }
}]});
