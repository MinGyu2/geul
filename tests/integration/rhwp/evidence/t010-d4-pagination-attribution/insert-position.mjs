import {readFileSync} from 'node:fs';
const [cand, file] = process.argv.slice(2);
const mod = await import(cand + '/rhwp.js');
await mod.default({module_or_path: readFileSync(cand + '/rhwp_bg.wasm')});
const doc = new mod.HwpDocument(new Uint8Array(readFileSync(file)));
const pages = doc.pageCount(), secs = doc.getSectionCount ? doc.getSectionCount() : 1;
const paras = doc.getParagraphCount ? doc.getParagraphCount(0) : null;
const time = (f) => { const t = performance.now(); f(); return performance.now() - t; };
const out = {pages, paras, samples: {}};
const targets = paras ? [0, Math.floor(paras / 2), paras - 1] : [0];
for (const p of targets) {
  const v = [];
  for (let i = 0; i < 12; i++) { v.push(time(() => doc.insertText(0, p, 0, 'a'))); doc.deleteText(0, p, 0, 1); }
  v.sort((a, b) => a - b); out.samples['para' + p] = {p50: +v[6].toFixed(1), max: +v[11].toFixed(1)};
}
const pi = time(() => doc.getPageInfo(0)); out.getPageInfoMs = +pi.toFixed(1);
console.log(JSON.stringify(out));
