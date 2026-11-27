// Generate a small authentic HWP5 group-caption pair for T009 preservation tests.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { scrubHwp5Fixture } = require('./hwp5-fixture-metadata.cjs');

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/tests/stage3-p6-group-caption-hwp5-fixtures.cjs <new-output-directory>');
fs.mkdirSync(out, { recursive: false });

const root = process.cwd();
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json')));
const generation = path.join(root, 'public/rhwp/generations', release.generation);
const rhwp = require(path.join(generation, 'rhwp.js'));
rhwp.initSync({ module: fs.readFileSync(path.join(generation, 'rhwp_bg.wasm')) });

function makeDocument() {
  const document = rhwp.HwpDocument.createEmpty();
  document.createBlankDocument();
  document.insertText(0, 0, 0, 'group caption anchor');
  const create = (shapeType, x) => JSON.parse(document.createShapeControl(JSON.stringify({
    sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType,
    width: 4200, height: 3000, treatAsChar: false, textWrap: 'Square', horzOffset: x, vertOffset: 2400,
  })));
  const rect = create('rectangle', 800);
  const ellipse = create('ellipse', 5400);
  if (!rect.ok || !ellipse.ok) throw new Error('group caption child creation failed');
  const grouped = JSON.parse(document.groupShapes(JSON.stringify({ sectionIdx: 0, targets: [
    { paraIdx: 0, controlIdx: rect.controlIdx }, { paraIdx: 0, controlIdx: ellipse.controlIdx },
  ] })));
  if (!grouped.ok) throw new Error('group caption group creation failed');
  const props = JSON.parse(document.setShapeProperties(0, 0, grouped.controlIdx, JSON.stringify({
    width: 20000, height: 4000, hasCaption: true, captionDirection: 'Bottom', captionVertAlign: 'Top', captionWidth: 20000,
    captionSpacing: 100, captionIncludeMargin: false,
  })));
  if (!props.ok) throw new Error('group caption owner creation failed');
  const length = document.getCellParagraphLength(0, 0, grouped.controlIdx, 65534, 0);
  const text = JSON.parse(document.insertTextInCell(0, 0, grouped.controlIdx, 65534, 0, length, 'Group-owned caption'));
  if (!text.ok) throw new Error('group caption text creation failed');
  return { document, group: grouped.controlIdx };
}

let document;
try {
  ({ document } = makeDocument());
  const original = scrubHwp5Fixture(document.exportHwp());
  const edited = new rhwp.HwpDocument(original);
  try {
    const control = JSON.parse(edited.getControls()).find(row => row.ctrlId === 'gso' && row.props.Lock === 0);
    if (!control) throw new Error('missing group GSO owner');
    const groupIndex = JSON.parse(edited.getPageControlLayout(0)).controls.find(row => row.type === 'group')?.stableIndex?.[2];
    if (!Number.isInteger(groupIndex)) throw new Error('missing group control index');
    const length = edited.getCellParagraphLength(0, 0, groupIndex, 65534, 0);
    if (!JSON.parse(edited.insertTextInCell(0, 0, groupIndex, 65534, 0, length, ' edited')).ok) {
      throw new Error('group caption text edit failed');
    }
    fs.writeFileSync(path.join(out, 'group-caption-original.hwp'), original);
    fs.writeFileSync(path.join(out, 'group-caption-edited.hwp'), scrubHwp5Fixture(edited.exportHwp()));
  } finally {
    edited.free();
  }
  const hashes = {};
  for (const file of ['group-caption-original.hwp', 'group-caption-edited.hwp']) {
    hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex');
  }
  fs.writeFileSync(path.join(out, 'fixture-meta.json'), JSON.stringify({
    format: 'HWP5', rhwpGeneration: release.generation, hashes,
    expectedCaption: '그림  Group-owned caption edited',
  }, null, 2));
} finally {
  document?.free();
}
