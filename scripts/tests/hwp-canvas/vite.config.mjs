// Local-only Vite server for scripts/tests/hwp-canvas/canvas.html. Accepts bounded raster evidence for
// cases of a corpus directory under src-tauri/target/ and verifies it against the case's edited.hwp.
import {defineConfig} from 'vite';
import {rhwpGenerationPlugin} from '../../rhwpAssets.ts';
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../../..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const corpus=dir=>{const full=path.resolve(root,dir);if(!full.startsWith(path.join(root,'src-tauri/target')+path.sep))throw Error('corpus outside src-tauri/target');return full;};
export default defineConfig({root,optimizeDeps:{entries:['scripts/tests/hwp-canvas/canvas.html']},plugins:[rhwpGenerationPlugin(),{name:'hwp-canvas-evidence',configureServer(server){server.middlewares.use('/__hwp-canvas',(req,res)=>{let count=0;const chunks=[];req.on('data',b=>{count+=b.length;if(count>8*1024*1024){req.destroy();return;}chunks.push(b);});req.on('end',()=>{try{
 const data=JSON.parse(Buffer.concat(chunks)),out=corpus(data.dir);
 if(data.error){fs.writeFileSync(path.join(out,'canvas-error.json'),JSON.stringify(data));res.end('error recorded');return;}
 if(!/^[A-Za-z0-9-]+$/.test(data.id))throw Error('case');
 const bytes=fs.readFileSync(path.join(out,data.id,'edited.hwp'));if(sha(bytes)!==data.editedSha256)throw Error('source hash');
 const rgb=Buffer.from(data.rgb,'base64'),png=Buffer.from(data.png,'base64');
 if(rgb.length!==data.width*data.height*3||data.width>1032||data.height>1032||sha(rgb)!==data.rgbSha256)throw Error('raster');
 fs.writeFileSync(path.join(out,data.id,'canvas-render.png'),png);delete data.rgb;delete data.png;data.pngSha256=sha(png);
 fs.writeFileSync(path.join(out,data.id,'canvas-proof.json'),JSON.stringify(data,null,2));res.end('ok');
}catch(error){res.statusCode=400;res.end(String(error));}});});}}],server:{host:'127.0.0.1',port:43899,strictPort:true}});
