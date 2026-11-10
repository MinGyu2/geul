#!/usr/bin/env node
// Compatibility investigation only: source variants are emitted by the ignored
// Rust generator from fresh selected-WASM exports. Import/export failure is not
// a validator regression. All receipts retain exact input and output hashes.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]);
const build=JSON.parse(readFileSync('public/rhwp/BUILD.json'));
const generation=resolve('public/rhwp/generations',build.generation);
const sha=b=>createHash('sha256').update(b).digest('hex');
for(const [name,hash]of Object.entries(build.artifacts))assert.equal(sha(readFileSync(join(generation,name))),hash);
const engine=createRequire(import.meta.url)(join(generation,'rhwp.js'));
engine.initSync({module:readFileSync(join(generation,'rhwp_bg.wasm'))});
const checker=resolve('src-tauri/target/debug/examples/save_check');
const baselines={parent:resolve('target/hwp-boundary-hardening/save_check-parent'),phase2:resolve('target/hwp-boundary-hardening/save_check-phase2'),fixed:checker};
const json=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2));
const exportDoc=d=>{const e=d.exportHwpWithReport();try{return{bytes:e.takeBytes(),loss:JSON.parse(e.contentLoss())}}finally{e.free()}};
const check=(binary,mode,source,output,loss)=>JSON.parse(execFileSync(binary,[mode,'hwp',source,output,loss,'true'],{encoding:'utf8'}));
const mixed=process.argv.includes('--mixed');
const state=d=>({format:d.getSourceFormat(),pages:d.pageCount(),text:JSON.parse(d.getTextFileText()),paragraphs:Array.from({length:d.getParagraphCount(0)},(_,p)=>JSON.parse(d.getParaPropertiesAt(0,p))),controls:JSON.parse(d.getControls()),tables:[]});
const rows=[];
for(const kind of ['png','jpg','linked','storage','storage-stored','sparse']){
 const source=join(root,`real-existing-${kind}.hwp`),folder=join(root,'compat-'+kind+(mixed?'-mixed':''));mkdirSync(folder,{recursive:true});
 const bytes=readFileSync(source);const row={kind,operation:mixed?'ordinary text + new inline PNG':'ordinary text',sourceSha256:sha(bytes),variants:'record-level variants of fresh approved-WASM source; storage is opaque CFB BinData, not claimed real OLE application content',checks:{}};
 let d;
 try{
  d=new engine.HwpDocument(bytes);const noop=exportDoc(d);
  writeFileSync(join(folder,'noop.hwp'),noop.bytes);json(join(folder,'noop-loss.json'),noop.loss);
  d.insertText(0,0,0,'일반 text ');
  const receipts=[];
  if(mixed){const image=readFileSync(join(root,'input.png'));const pos=JSON.parse(d.insertPicture(0,0,0,'[]',image,7200,4800,3,2,'png','',undefined,undefined));d.setPictureProperties(0,pos.paraIdx,pos.controlIdx,JSON.stringify({treatAsChar:true}));receipts.push({feature:'picture',inputSha256:sha(image),extension:'png',control:pos});}
  const live=state(d);const output=exportDoc(d);
  writeFileSync(join(folder,'edited.hwp'),output.bytes);json(join(folder,'loss.json'),output.loss);
  const reopened=new engine.HwpDocument(output.bytes);
  try{row.reopenEqual=JSON.stringify(live)===JSON.stringify(state(reopened));}finally{reopened.free();}
  row.noopSha256=sha(noop.bytes);row.outputSha256=sha(output.bytes);
  for(const [label,binary]of Object.entries(baselines))row.checks[label]={preflight:check(binary,'preflight',source,join(folder,'noop.hwp'),join(folder,'noop-loss.json')),saved:check(binary,'saved',source,join(folder,'edited.hwp'),join(folder,'loss.json'))};
  const old=row.checks.parent,phase2=row.checks.phase2,fixed=row.checks.fixed;
  const nonPreview=p=>p.findings.filter(f=>f.code!=='previewStale');
  row.classification=old.preflight.outcome!=='safe'?'BASELINE_UNSUPPORTED':mixed?(!nonPreview(fixed.saved).length?'VALID_PRESERVATION':'LEGITIMATE_UNSAFE'):nonPreview(old.saved).length?'BASELINE_UNSUPPORTED':nonPreview(phase2.saved).length&&!nonPreview(fixed.saved).length?'NEW_VALIDATOR_REGRESSION':!nonPreview(fixed.saved).length?'VALID_PRESERVATION':'NOT_VERIFIED';
  if(old.preflight.outcome==='safe'&&!nonPreview(fixed.saved).length&&row.reopenEqual){
   const id='compat-'+kind+(mixed?'-mixed':'');writeFileSync(join(folder,'original.hwp'),bytes);
   const rendered=new engine.HwpDocument(output.bytes);
   try{
    const page=JSON.parse(rendered.getPageInfo(0));const w=Math.round(page.width/Math.max(page.width,page.height)*1024),h=Math.round(page.height/Math.max(page.width,page.height)*1024);
    const svg=rendered.renderPageSvgWithProfile(0,'screen');assert.ok(!/(?:href|src)=["']https?:/i.test(svg));writeFileSync(join(folder,'render.svg'),svg);
    execFileSync('rsvg-convert',['--background-color','white','--width',String(w),'--height',String(h),'--output',join(folder,'render.png'),join(folder,'render.svg')],{timeout:30000});
    json(join(folder,'proof.json'),{engineGeneration:build.generation,wasmSha256:build.artifacts['rhwp_bg.wasm'],originalSha256:sha(bytes),noopSha256:sha(noop.bytes),editedSha256:sha(output.bytes),reopenEqual:true,live,reopened:state(rendered),receipts,previewSource:'fresh exact-output RHWP SVG rasterized by librsvg',renderSha256:sha(readFileSync(join(folder,'render.png')))});
    const manifest=JSON.parse(readFileSync(join(root,'cases-first.json'))).filter(c=>c.id!==id);manifest.push({id,negative:false});json(join(root,'cases-first.json'),manifest);json(join(root,'cases.json'),manifest);row.publicationCase=id;
   }finally{rendered.free();}
  }
  row.publicationEligibility='Only the actual publication harness with exact-export render evidence may establish publication; PreviewStale is never discarded by production.';
 }catch(error){row.classification='NOT_VERIFIED';row.engineLimitation=String(error);}finally{d?.free();}
 rows.push(row);
}
json(join(root,'existing-resources'+(mixed?'-mixed':'')+'.json'),{build,rows});console.log(JSON.stringify(rows,null,2));
