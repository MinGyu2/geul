// Build an HWPX group with a genuine group-owned caption for P6-OTHER-CAP acceptance.
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/tests/stage3-p6-group-caption-fixtures.cjs <new-output-directory>');
fs.mkdirSync(out, { recursive: false });

const root = process.cwd();
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json')));
const generation = path.join(root, 'public/rhwp/generations', release.generation);
const rhwp = require(path.join(generation, 'rhwp.js'));
rhwp.initSync({ module: fs.readFileSync(path.join(generation, 'rhwp_bg.wasm')) });

const document = rhwp.HwpDocument.createEmpty();
try {
  document.createBlankDocument();
  document.insertText(0, 0, 0, 'group caption anchor');
  const create = (shapeType, x) => JSON.parse(document.createShapeControl(JSON.stringify({
    sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType,
    width: 4200, height: 3000, treatAsChar: false, textWrap: 'Square', horzOffset: x, vertOffset: 2400,
  })));
  const rectangle = create('rectangle', 800);
  const ellipse = create('ellipse', 5400);
  if (!rectangle.ok || !ellipse.ok) throw new Error('group caption child creation failed');
  const grouped = JSON.parse(document.groupShapes(JSON.stringify({
    sectionIdx: 0,
    targets: [
      { paraIdx: 0, controlIdx: rectangle.controlIdx },
      { paraIdx: 0, controlIdx: ellipse.controlIdx },
    ],
  })));
  if (!grouped.ok) throw new Error('group caption owner creation failed');
  if (!JSON.parse(document.setShapeProperties(0, 0, grouped.controlIdx, JSON.stringify({
    width: 20000, height: 4000, hasCaption: true, captionDirection: 'Bottom', captionVertAlign: 'Top', captionWidth: 20000,
    captionSpacing: 100, captionIncludeMargin: false,
  }))).ok) throw new Error('group caption creation failed');
  const length = document.getCellParagraphLength(0, 0, grouped.controlIdx, 65534, 0);
  if (!JSON.parse(document.insertTextInCell(0, 0, grouped.controlIdx, 65534, 0, length, 'Group-owned caption')).ok) {
    throw new Error('group caption text creation failed');
  }
  const props = JSON.parse(document.getShapeProperties(0, 0, grouped.controlIdx));
  if (props.shapeType !== 'group' || props.hasCaption !== true) throw new Error('fixture lost group caption owner');
  fs.writeFileSync(path.join(out, 'group-caption-original.hwpx'), document.exportHwpx());
} finally {
  document.free();
}
