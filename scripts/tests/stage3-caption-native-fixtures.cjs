const fs = require('fs');
const base = process.cwd(), gen = JSON.parse(fs.readFileSync(base+'/public/rhwp/RELEASE.json')).generation;
const p = base+'/public/rhwp/generations/'+gen; const rhwp=require(p+'/rhwp.js');rhwp.initSync({module:fs.readFileSync(p+'/rhwp_bg.wasm')});
for (const fmt of ['hwp','hwpx']) {
  const d=rhwp.HwpDocument.createEmpty();
  try {
    d.createBlankDocument(); d.insertText(0,0,0,'Caption native anchor text');
    const c=JSON.parse(d.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,shapeType:'rectangle',width:6000,height:3200,treatAsChar:false,textWrap:'Square',horzOffset:4000,vertOffset:3000})));
    if (!c.ok) throw Error(JSON.stringify(c));
    const st=JSON.parse(d.setShapeProperties(0,0,c.controlIdx,'{"hasCaption":true}'));if(!st.ok)throw Error(JSON.stringify(st));
    const bytes=fmt==='hwp'?d.exportHwp():d.exportHwpx();fs.writeFileSync('target/stage3-caption-native-20261120/fixture.'+fmt,bytes);
    const rd=new rhwp.HwpDocument(bytes); try {
      const shape=JSON.parse(rd.getPageControlLayout(0)).controls.find(x=>x.type==='shape');
      const props=JSON.parse(rd.getShapeProperties(0,0,c.controlIdx));
      const len=rd.getCellParagraphLength(0,0,c.controlIdx,65534,0);
      const caret=JSON.parse(rd.getCursorRectInCell(0,0,c.controlIdx,65534,0,len));
      console.log(JSON.stringify({fmt,control:c.controlIdx,shape,props,caption:rd.getTextInCell(0,0,c.controlIdx,65534,0,0,len),caret,controls:JSON.parse(rd.getControls()).filter(x=>x.ctrlId==='atno')}));
    } finally {rd.free();}
  } finally {d.free();}
}

// A separate locked-owner input for the native refusal scenario.
const locked = new rhwp.HwpDocument(fs.readFileSync('target/stage3-caption-native-20261120/fixture.hwpx'));
try {
  if (!JSON.parse(locked.setControlLock(0, 2, true)).ok) throw Error('lock fixture failed');
  fs.writeFileSync('target/stage3-caption-native-20261120/locked.hwpx', locked.exportHwpx());
} finally { locked.free(); }
