// Generate independent inline-caption fixtures for P6-HX-CAP-INLINE Native acceptance.
const fs = require('node:fs');
const path = require('node:path');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAADYAAAAbCAIAAAC4FetiAAAAN0lEQVR4nO3OUQkAIBBAsethFvv3MIklBN/HYAE2Z+24+T5QVFRUbFFUrFBUrFBUrFBUrFBU84QIyEvyvRSPr3QAAAABJRU5ErkJggg==',
  'base64',
);
const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/tests/stage3-p6-hwpx-inline-caption-fixtures.cjs <new-output-directory>');
fs.mkdirSync(out, { recursive: false });

const root = process.cwd();
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json')));
const generation = path.join(root, 'public/rhwp/generations', release.generation);
const rhwp = require(path.join(generation, 'rhwp.js'));
rhwp.initSync({ module: fs.readFileSync(path.join(generation, 'rhwp_bg.wasm')) });

const source = rhwp.HwpDocument.createEmpty();
let original;
try {
  source.createBlankDocument();
  source.insertText(0, 0, 0, 'inline caption before and after');
  const inserted = JSON.parse(source.insertPicture(0, 0, 7, '[]', png, 4050, 2025, 54, 27, 'png', 'Inline caption'));
  if (!inserted.ok || inserted.controlIdx !== 2) throw new Error('unexpected inline picture owner');
  const properties = {
    treatAsChar: true,
    hasCaption: true,
    captionDirection: 'Bottom',
    captionVertAlign: 'Top',
    captionWidth: 4800,
    captionSpacing: 600,
    captionIncludeMargin: false,
  };
  if (!JSON.parse(source.setPictureProperties(0, inserted.paraIdx, inserted.controlIdx, JSON.stringify(properties))).ok) {
    throw new Error('inline caption fixture creation failed');
  }
  if (!JSON.parse(source.insertTextInCell(0, inserted.paraIdx, inserted.controlIdx, 0, 0, 0, '캡션')).ok) {
    throw new Error('inline caption text creation failed');
  }
  original = source.exportHwpx();
} finally {
  source.free();
}

for (const [side, alignment] of [['Left', 'Center'], ['Right', 'Bottom']]) {
  const name = `a-p6-inline-caption-${side.toLowerCase()}`;
  fs.writeFileSync(path.join(out, `${name}-original.hwpx`), original);
  const edited = new rhwp.HwpDocument(original);
  try {
    const inserted = JSON.parse(edited.setPictureProperties(0, 0, 2, JSON.stringify({
      hasCaption: true,
      captionDirection: side,
      captionVertAlign: alignment,
    })));
    if (!inserted.ok) throw new Error(`could not construct ${side} expected layout`);
    fs.writeFileSync(path.join(out, `${name}-edited.hwpx`), edited.exportHwpx());
  } finally {
    edited.free();
  }
}
