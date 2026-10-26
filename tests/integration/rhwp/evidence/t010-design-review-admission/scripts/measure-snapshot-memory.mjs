// one file per process: linear-memory high-water growth per retained snapshot
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [root, pkg, file, K = "24"] = process.argv.slice(2);
const rhwp = await import(pathToFileURL(join(pkg, "rhwp.js")).href);
const wasm = rhwp.initSync({ module: readFileSync(join(pkg, "rhwp_bg.wasm")) });
const bytes = readFileSync(file);
const m0 = wasm.memory.buffer.byteLength;
let d;
try { d = new rhwp.HwpDocument(bytes); } catch (e) { console.log(JSON.stringify({ file, bytes: bytes.length, open: false })); process.exit(0); }
const m1 = wasm.memory.buffer.byteLength;
const mem = [m1];
const k = Number(K);
for (let i = 0; i < k; i++) { d.saveSnapshot(); mem.push(wasm.memory.buffer.byteLength); }
// a second independent document from the same bytes = full model + parse transient (upper reference)
const steps = mem.slice(1).map((v, i) => v - mem[i]);
const firstGrow = steps.findIndex((s) => s > 0);
const tail = firstGrow < 0 ? null : (mem[k] - mem[firstGrow]) / (k - firstGrow);
console.log(JSON.stringify({ file: file.split("/").pop(), ext: file.split(".").pop().toLowerCase(), bytes: bytes.length,
  pages: d.pageCount(), openGrowth: m1 - m0, totalSnapGrowth: mem[k] - m1, k, firstGrow, perSnapshot: tail === null ? 0 : Math.round(tail),
  ratio: tail === null ? 0 : +(tail / bytes.length).toFixed(3), firstSnapGrowth: steps[0] }));
