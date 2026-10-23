// Public pinned engine generates temporary documents; no binary fixtures are committed.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { svg } from '../cache-concurrency/fixtures.mjs';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const output = process.argv[2];
if (!output) throw new Error('temporary output directory required');
const engine = await import(pathToFileURL(resolve(root, 'public/rhwp/rhwp.js')).href);
engine.initSync({ module: readFileSync(resolve(root, 'public/rhwp/rhwp_bg.wasm')) });
mkdirSync(output, { recursive: true });
for (const format of ['hwp', 'hwpx']) {
  const doc = engine.HwpDocument.createEmpty();
  doc.createBlankDocument();
  doc.insertText(0, 0, 0, 'Renderer ownership fixture');
  for (let i = 0; i < 2; i++) {
    const n = 1200 + i * 10;
    const placed = JSON.parse(doc.insertPicture(0, 0, 0, '', svg(n, n, i + 1), 9000, 9000, n, n, 'svg', '', null, null));
    doc.setPictureProperties(0, placed.paraIdx, placed.controlIdx, JSON.stringify({ treatAsChar: false,
      horzRelTo: 'Paper', vertRelTo: 'Paper', horzAlign: 'Left', vertAlign: 'Top',
      horzOffset: (100 + 160 * i) * 75, vertOffset: 7500 }));
  }
  const placed = JSON.parse(doc.createTable(0, 0, 0, 2, 2));
  doc.insertTextInCell(0, placed.paraIdx, placed.controlIdx, 0, 0, 0, 'cell');
  const result = format === 'hwp' ? doc.exportHwpWithReport() : doc.exportHwpxWithReport();
  writeFileSync(resolve(output, 'ownership-' + format + '.' + format), result.takeBytes());
  result.free(); doc.free();
}
