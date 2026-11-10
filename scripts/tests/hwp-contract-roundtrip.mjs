#!/usr/bin/env node
// Real selected RHWP HWP insertions + fresh model reopen + real page-1 SVG raster.
// No upstream sample is mandatory; --local-picture optionally investigates its BMP.
// Run generate, the explicit Rust publication test, verify, then repeat/publication/verify.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const [mode='generate',destination='target/hwp-record-investigation/phase2/engine']=process.argv.slice(2);
const out=resolve(destination);mkdirSync(out,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2));
const build=JSON.parse(readFileSync('public/rhwp/BUILD.json'));
const generation=resolve('public/rhwp/generations',build.generation);
assert.deepEqual(JSON.parse(readFileSync(join(generation,'BUILD.json'))),build);
for(const [name,hash]of Object.entries(build.artifacts))assert.equal(sha(readFileSync(join(generation,name))),hash);
for(const patch of build.integration.patches)assert.equal(sha(readFileSync('patches/rhwp/'+patch.name)),patch.sha256);
assert.equal(execFileSync('git',['-C','external/rhwp','rev-parse','HEAD'],{encoding:'utf8'}).trim(),build.commit);
const engine=createRequire(import.meta.url)(join(generation,'rhwp.js'));engine.initSync({module:readFileSync(join(generation,'rhwp_bg.wasm'))});
const parse=s=>{try{return JSON.parse(s);}catch{return s;}};
function state(d){const controls=parse(d.getControls());return{format:d.getSourceFormat(),pages:d.pageCount(),text:parse(d.getTextFileText()),paragraphs:Array.from({length:d.getParagraphCount(0)},(_,p)=>parse(d.getParaPropertiesAt(0,p))),controls,tables:controls.filter(c=>c.ctrlId==='tbl').map(c=>{const dimensions=parse(d.getTableDimensions(0,c.para,c.controlIndex));return{dimensions,cells:Array.from({length:dimensions.cellCount},(_,cell)=>Array.from({length:d.getCellParagraphCount(0,c.para,c.controlIndex,cell)},(_,p)=>d.getTextInCell(0,c.para,c.controlIndex,cell,p,0,d.getCellParagraphLength(0,c.para,c.controlIndex,cell,p))))}})}}
function exportDoc(d){const ex=d.exportHwpWithReport();try{return{bytes:ex.takeBytes(),loss:parse(ex.contentLoss())}}finally{ex.free()}}
function blank(text=''){const d=engine.HwpDocument.createEmpty();d.createBlankDocument();if(text)d.insertText(0,0,0,text);const bytes=exportDoc(d).bytes;d.free();return bytes;}
const load=id=>readFileSync(join(out,id,'edited.hwp'));
let cases=[];
function run(id,source,edit,{negative=false,expectedCode}={}){
 const folder=join(out,id);mkdirSync(folder,{recursive:true});const d=new engine.HwpDocument(source);
 try{const noop=exportDoc(d);const receipts=[];edit(d,receipts);const live=state(d);const exp=exportDoc(d);const reopened=new engine.HwpDocument(exp.bytes);try{
 const current=state(reopened);let reopenEqual;try{assert.deepEqual(current,live);reopenEqual=true;}catch{reopenEqual=false;}
 if(!negative)assert.equal(reopenEqual,true,id+' live/reopen');
 writeFileSync(join(folder,'original.hwp'),source);writeFileSync(join(folder,'noop.hwp'),noop.bytes);json(join(folder,'noop-loss.json'),noop.loss);writeFileSync(join(folder,'edited.hwp'),exp.bytes);json(join(folder,'loss.json'),exp.loss);
 const info=parse(reopened.getPageInfo(0));const w=Math.round(info.width/Math.max(info.width,info.height)*1024),h=Math.round(info.height/Math.max(info.width,info.height)*1024);
 const svg=reopened.renderPageSvgWithProfile(0,'screen');assert.ok(svg.startsWith('<svg')||svg.includes('<svg'));assert.ok(!/(?:href|src)=["']https?:/i.test(svg),'no network resources in renderer evidence');
 writeFileSync(join(folder,'render.svg'),svg);execFileSync('rsvg-convert',['--background-color','white','--width',String(w),'--height',String(h),'--output',join(folder,'render.png'),join(folder,'render.svg')],{timeout:30000});
 json(join(folder,'proof.json'),{engineGeneration:build.generation,wasmSha256:build.artifacts['rhwp_bg.wasm'],originalSha256:sha(source),noopSha256:sha(noop.bytes),editedSha256:sha(exp.bytes),reopenEqual,live,reopened:current,receipts,previewSource:'fresh exact-export RHWP renderPageSvgWithProfile(screen), rasterized by installed librsvg; no mocked Canvas or GUI acceptance',renderSha256:sha(readFileSync(join(folder,'render.png')))});
 cases.push({id,negative,expectedCode});
 }finally{reopened.free();}}finally{d.free();}
}
function table(d,rows=2,cols=2,normalize=true){const t=parse(d.createTable(0,0,Math.min(5,d.getParagraphLength(0,0)),rows,cols));if(normalize)d.setTableProperties(0,t.paraIdx,t.controlIdx,JSON.stringify({textWrap:'TopAndBottom'}));for(let c=0;c<rows*cols;c++)d.insertTextInCell(0,t.paraIdx,t.controlIdx,c,0,0,`셀${c} Cell${c}`);return t;}
function picture(d,receipts,ext,inline=true){const bytes=readFileSync(join(out,'input.'+ext));const p=parse(d.insertPicture(0,0,0,'[]',bytes,7200,4800,3,2,ext,'',undefined,undefined));if(inline)d.setPictureProperties(0,p.paraIdx,p.controlIdx,JSON.stringify({treatAsChar:true}));receipts.push({feature:'picture',inputSha256:sha(bytes),extension:ext,control:p});return p;}
function bullet(d,p,on=true){const id=d.ensureDefaultBullet('•');d.applyParaFormat(0,p,JSON.stringify({headType:on?'Bullet':'None',numberingId:on?id:0,paraLevel:0}));}
if(mode==='generate'){
 json(join(out,'identity.json'),{build,node:process.version,rsvg:execFileSync('rsvg-convert',['--version'],{encoding:'utf8'}).trim()});
 const empty=blank(),text=blank('앞 문장 Before | 뒤 문장 After');
 // Real-engine boundary counterexample: rebuild paragraphs with the public
 // merge/split operations, yielding internally consistent record metadata.
 const boundaryDoc=new engine.HwpDocument(blank('ABCDEF'));
 let boundarySource;
 try{boundaryDoc.splitParagraph(0,0,3);boundarySource=exportDoc(boundaryDoc).bytes;}finally{boundaryDoc.free();}
 run('boundary-shift',boundarySource,d=>{d.mergeParagraph(0,1);d.splitParagraph(0,0,1)},{negative:true,expectedCode:'recordsChanged'});
 run('boundary-split',boundarySource,d=>d.splitParagraph(0,0,1));
 run('B6',empty,d=>table(d));run('B-text',text,d=>table(d,2,3));run('B-reuse',load('B6'),d=>table(d));
 for(const [id,ext,source]of [['C1','png',empty],['C2','jpg',text]])run(id,source,(d,a)=>picture(d,a,ext));
 run('C3',text,(d,a)=>{picture(d,a,'png');picture(d,a,'jpg')});run('C4',load('C1'),(d,a)=>picture(d,a,'jpg'));run('C5',text,(d,a)=>{picture(d,a,'png');picture(d,a,'jpg')});
 if(process.argv.includes('--local-picture'))run('C4-external',readFileSync('external/rhwp/samples/test-image.hwp'),(d,a)=>picture(d,a,'png'));
 run('D1',text,d=>bullet(d,0));run('D2',text,d=>{d.splitParagraph(0,0,10);bullet(d,0);bullet(d,1)});run('D3',load('D1'),d=>{d.splitParagraph(0,0,d.getParagraphLength(0,0));d.insertText(0,1,0,'다음 Next')});run('D4',load('D2'),d=>{bullet(d,0,false);bullet(d,1,false)});run('D5',load('D4'),d=>{bullet(d,0);bullet(d,1);bullet(d,0)});
 run('E3',text,(d,a)=>{d.splitParagraph(0,0,10);bullet(d,0);bullet(d,1);table(d);picture(d,a,'png');picture(d,a,'jpg')});
 run('T012-mixed',text,d=>{d.applyCharFormat(0,0,0,5,JSON.stringify({ratios:Array(7).fill(130),spacings:Array(7).fill(10)}));table(d)});
 run('raw-table',empty,d=>table(d,2,2,false),{negative:true,expectedCode:'recordsChanged'});
 run('raw-floating',empty,(d,a)=>picture(d,a,'png',false),{negative:true,expectedCode:'recordsChanged'});
 if(existsSync('target/hwp-record-investigation/opaque-middle.hwp'))run('opaque-middle',readFileSync('target/hwp-record-investigation/opaque-middle.hwp'),d=>table(d),{negative:true,expectedCode:'recordsChanged'});
 // Zero instance IDs are not used to target objects by these APIs: mutate each by location.
 const copy=new engine.HwpDocument(load('C3'));try{const pics=parse(copy.getControls()).filter(c=>c.userDesc==='그림');assert.equal(pics.length,2);const [a,b]=pics;copy.setPictureProperties(0,a.para,a.controlIndex,JSON.stringify({width:7300}));const current=parse(copy.getControls()).filter(c=>c.userDesc==='그림');assert.equal(current[0].props.Width,7300);assert.equal(current[1].props.Width,7200);copy.setPictureProperties(0,b.para,b.controlIndex,JSON.stringify({width:7400}));const final=parse(copy.getControls()).filter(c=>c.userDesc==='그림');assert.equal(final[0].props.Width,7300);assert.equal(final[1].props.Width,7400);json(join(out,'positional-targeting.json'),{result:'PASS',twoZeroInstanceIds:true,mutatedWidths:[7300,7400],scope:'location-based get/set API only; no third-party identity guarantee'});}finally{copy.free();}
 json(join(out,'cases.json'),cases);json(join(out,'cases-first.json'),cases);
 }else if(mode==='boundary-additive'){
 const source=readFileSync(join(out,'boundary-shift','original.hwp'));
 run('boundary-shift-added',source,d=>{d.mergeParagraph(0,1);d.splitParagraph(0,0,1);d.insertText(0,1,d.getParagraphLength(0,1),'!')},{negative:true,expectedCode:'recordsChanged'});
 const manifest=JSON.parse(readFileSync(join(out,'cases-first.json'))).filter(c=>c.id!=='boundary-shift-added');manifest.push(...cases);json(join(out,'cases-first.json'),manifest);json(join(out,'cases.json'),manifest);
 }else if(mode==='empty-character-seed'){
 run('boundary-empty-character-shape',readFileSync(join(out,'B6','original.hwp')),d=>bullet(d,0),{negative:true,expectedCode:'recordsChanged'});
 // This seed is not registered until the explicit valid existing-ID mutation.
}else if(mode==='empty-character-finish'){
 const id='boundary-empty-character-shape',folder=join(out,id),bytes=readFileSync(join(folder,'edited.hwp'));
 const proof=JSON.parse(readFileSync(join(folder,'proof.json')));const d=new engine.HwpDocument(bytes);
 try{
  const current=state(d);assert.deepEqual(current,proof.live,'observable model stays equal; Rust must protect the terminator shape');
  const original=new engine.HwpDocument(readFileSync(join(folder,'original.hwp')));
  try{proof.emptyCharacterProperties={original:parse(original.getCharPropertiesAt(0,0,0)),edited:parse(d.getCharPropertiesAt(0,0,0))};}finally{original.free();}
  proof.editedSha256=sha(bytes);proof.reopened=current;proof.reopenEqual=true;
  const page=parse(d.getPageInfo(0)),w=Math.round(page.width/Math.max(page.width,page.height)*1024),h=Math.round(page.height/Math.max(page.width,page.height)*1024);
  const svg=d.renderPageSvgWithProfile(0,'screen');assert.ok(!/(?:href|src)=["']https?:/i.test(svg));writeFileSync(join(folder,'render.svg'),svg);
  execFileSync('rsvg-convert',['--background-color','white','--width',String(w),'--height',String(h),'--output',join(folder,'render.png'),join(folder,'render.svg')],{timeout:30000});
  proof.renderSha256=sha(readFileSync(join(folder,'render.png')));proof.mutation='PARA_CHAR_SHAPE existing ID 0 -> 1; header counts, hierarchy, framing and all definitions unchanged';json(join(folder,'proof.json'),proof);
 }finally{d.free();}
 const manifest=JSON.parse(readFileSync(join(out,'cases-first.json'))).filter(c=>c.id!==id);manifest.push({id,negative:true,expectedCode:'recordsChanged'});json(join(out,'cases-first.json'),manifest);json(join(out,'cases.json'),manifest);
}else if(mode==='repeat'){
 run('E4-published',readFileSync(join(out,'E3','published.hwp')),(d,a)=>{picture(d,a,'jpg');d.insertText(0,d.getParagraphCount(0)-1,0,'후속 Followup ')});json(join(out,'cases.json'),cases);
}else if(mode==='verify'){
 if(existsSync(join(out,'E4-published','proof.json')))assert.equal(sha(readFileSync(join(out,'E4-published','original.hwp'))),sha(readFileSync(join(out,'E3','published.hwp'))),'repeat input must be the actual first publication');
 const all=[...JSON.parse(readFileSync(join(out,'cases-first.json'))),...(existsSync(join(out,'E4-published','proof.json'))?[{id:'E4-published'}]:[])];let verified=0;
 for(const item of all){if(item.negative)continue;const file=join(out,item.id,'published.hwp');const d=new engine.HwpDocument(readFileSync(file));try{const proof=JSON.parse(readFileSync(join(out,item.id,'proof.json')));assert.deepEqual(state(d),proof.live,item.id+' published reopen');verified++;}finally{d.free();}}
 json(join(out,'published-reopen.json'),{result:'PASS',verified,engineGeneration:build.generation});console.log(verified+' actually published HWP fresh reopen PASS');
}else throw Error('mode generate|boundary-additive|empty-character-seed|empty-character-finish|repeat|verify');
