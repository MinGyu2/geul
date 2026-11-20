// Create isolated HWP inputs for the HWP native caption IME/lock acceptance.
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
if (!out) throw Error('usage: node stage3-hwp-caption-native-fixtures.cjs <new-output-directory>');
fs.mkdirSync(out, { recursive: false });
const root = process.cwd();
const m = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json')));
const dir = path.join(root, 'public/rhwp/generations', m.generation);
const rhwp = require(path.join(dir, 'rhwp.js'));
rhwp.initSync({ module: fs.readFileSync(path.join(dir, 'rhwp_bg.wasm')) });
const doc = rhwp.HwpDocument.createEmpty();
try {
  doc.createBlankDocument();
  doc.insertText(0, 0, 0, 'Caption native anchor text');
  const shape = JSON.parse(doc.createShapeControl(JSON.stringify({ sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: 'rectangle', width: 6000, height: 3200, treatAsChar: false, textWrap: 'Square', horzOffset: 4000, vertOffset: 3000 })));
  if (!shape.ok || shape.controlIdx !== 2) throw Error('unexpected shape owner');
  if (!JSON.parse(doc.setShapeProperties(0, 0, 2, '{"hasCaption":true}')).ok) throw Error('caption fixture failed');
  fs.writeFileSync(path.join(out, 'fixture.hwp'), doc.exportHwp());
  if (!JSON.parse(doc.setControlLock(0, 2, true)).ok) throw Error('lock fixture failed');
  fs.writeFileSync(path.join(out, 'locked.hwp'), doc.exportHwp());
} finally { doc.free(); }
