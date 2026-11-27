// Build lossless HWP5 caption-layout fixtures with a real owned caption list.
const fs = require('fs');
const path = require('path');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFBU84QIyEvyvRSPr3QAAAABJRU5ErkJggg==', 'base64');

const out = process.argv[2];
if (!out) throw Error('usage: node stage3-p6-h5-caption-native-fixtures.cjs <new-output-directory>');
fs.mkdirSync(out, { recursive: false });

const root = process.cwd();
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json')));
const generation = path.join(root, 'public/rhwp/generations', release.generation);
const rhwp = require(path.join(generation, 'rhwp.js'));
rhwp.initSync({ module: fs.readFileSync(path.join(generation, 'rhwp_bg.wasm')) });

const document = rhwp.HwpDocument.createEmpty();
try {
  document.createBlankDocument();
  document.insertText(0, 0, 0, 'HWP5 caption layout anchor');
  const created = JSON.parse(document.createShapeControl(JSON.stringify({
    sectionIdx: 0,
    paraIdx: 0,
    charOffset: 0,
    shapeType: 'rectangle',
    width: 6000,
    height: 3200,
    treatAsChar: false,
    textWrap: 'Square',
    horzOffset: 4000,
    vertOffset: 3000,
  })));
  if (!created.ok || created.controlIdx !== 2) throw Error('unexpected HWP5 shape owner');
  if (!JSON.parse(document.setShapeProperties(0, 0, created.controlIdx, JSON.stringify({
    hasCaption: true,
    captionDirection: 'Bottom',
    captionVertAlign: 'Top',
    captionWidth: 2400,
    captionSpacing: 100,
  }))).ok) throw Error('HWP5 caption creation failed');

  fs.writeFileSync(path.join(out, 'caption.hwp'), document.exportHwp());
  if (!JSON.parse(document.setControlLock(0, created.controlIdx, true)).ok) {
    throw Error('HWP5 locked-caption fixture failed');
  }
  fs.writeFileSync(path.join(out, 'locked-caption.hwp'), document.exportHwp());
} finally {
  document.free();
}

const picture = rhwp.HwpDocument.createEmpty();
try {
  picture.createBlankDocument();
  picture.insertText(0, 0, 0, 'HWP5 picture caption anchor');
  const inserted = JSON.parse(picture.insertPicture(0, 0, 0, '[]', PNG, 6000, 3200, 54, 29, 'png', 'Captioned picture'));
  if (!inserted.ok || inserted.controlIdx !== 2) throw Error('unexpected HWP5 picture owner');
  const props = {
    treatAsChar: false,
    textWrap: 'Square',
    horzRelTo: 'Paper',
    vertRelTo: 'Paper',
    horzAlign: 'Left',
    vertAlign: 'Top',
    horzOffset: 4000,
    vertOffset: 3000,
    hasCaption: true,
    captionDirection: 'Bottom',
    captionVertAlign: 'Top',
    captionWidth: 2400,
    captionSpacing: 100,
  };
  if (!JSON.parse(picture.setPictureProperties(0, inserted.paraIdx, inserted.controlIdx, JSON.stringify(props))).ok) {
    throw Error('HWP5 picture caption creation failed');
  }
  fs.writeFileSync(path.join(out, 'picture-caption.hwp'), picture.exportHwp());
  if (!JSON.parse(picture.setControlLock(0, inserted.controlIdx, true)).ok) {
    throw Error('HWP5 locked-picture-caption fixture failed');
  }
  fs.writeFileSync(path.join(out, 'locked-picture-caption.hwp'), picture.exportHwp());
} finally {
  picture.free();
}
