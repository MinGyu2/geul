import {scheduler,seedResidents} from '../cache-concurrency/scheduler.mjs';
function mismatch(a, b) {
  if (a.width !== b.width || a.height !== b.height) return Math.max(a.width * a.height, b.width * b.height);
  let ai = 0, bi = 0, an = a.runs[0], bn = b.runs[0], wrong = 0;
  while (ai < a.runs.length && bi < b.runs.length) {
    const n = Math.min(an, bn);
    if (a.runs[ai + 1] !== b.runs[bi + 1]) wrong += n;
    an -= n; bn -= n;
    if (!an) { ai += 2; an = a.runs[ai]; }
    if (!bn) { bi += 2; bn = b.runs[bi]; }
  }
  return wrong;
}
export async function run(pinned) {
 const candidate=window.__geulOwnership.probeEngine();
 return scheduler(candidate,pinned,{mismatch});
}
export async function seed() {return seedResidents(window.__geulOwnership.probeEngine());}
