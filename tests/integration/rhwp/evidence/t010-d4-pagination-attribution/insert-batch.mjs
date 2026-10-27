import {readFileSync} from 'node:fs';
const [cand, file] = process.argv.slice(2);
const mod = await import(cand + '/rhwp.js');
await mod.default({module_or_path: readFileSync(cand + '/rhwp_bg.wasm')});
const doc = new mod.HwpDocument(new Uint8Array(readFileSync(file)));
const t = f => { const s = performance.now(); f(); return performance.now() - s; };
const med = v => v.sort((a, b) => a - b)[v.length >> 1].toFixed(1);
const ins = [], paginate = [], plain = [];
for (let i = 0; i < 15; i++) {
  doc.beginBatch(); ins.push(t(() => doc.insertText(0, 296, 0, 'a'))); paginate.push(t(() => doc.endBatch()));
  doc.deleteText(0, 296, 0, 1);
  plain.push(t(() => doc.insertText(0, 296, 0, 'a'))); doc.deleteText(0, 296, 0, 1);
}
console.log(JSON.stringify({sections: doc.getSectionCount?.(), insertTextNormalMs: med(plain), insertTextInBatchMs: med(ins), endBatchPaginateMs: med(paginate)}));
