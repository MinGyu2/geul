// Decoded-resource lease and ledger contract in a real browser. "baseline" is the previous
// experimental engine (raw HtmlCanvasElement decoded cache); "candidate" is the lease engine.
// putImageData observes each Rust decode's Canvas so backing lifetime (width/height) is checked
// directly; the observer holds a DOM reference only, never an engine lease.
// contract 3: decoded_lease_run.py CONTRACTS[3] names every test and required checkpoint; every ledger
// checkpoint must carry the engine's dimensionMismatches counter (contract 2 evidence predates it).
const result = {schema: 1, contract: 3, status: 'RUNNING', tests: [], ledger: [], transitions: []};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = [[230,20,20],[20,200,20],[20,20,230],[10,10,10]];
let observed = null;
const putImageData = CanvasRenderingContext2D.prototype.putImageData;
CanvasRenderingContext2D.prototype.putImageData = function (...args) {
  if (observed) observed.push(this.canvas);
  return putImageData.apply(this, args);
};
// Redirect the next browser image loads to a server-held URL so PENDING is deterministic.
const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const holdQueue = [];
Object.defineProperty(HTMLImageElement.prototype, 'src', {...srcDescriptor, set(value) {
  if (value && value.startsWith('data:') && holdQueue.length) {
    const {key, error} = holdQueue.shift();
    srcDescriptor.set.call(this, '/held-image.svg?key=' + key + '&data=' + encodeURIComponent(value) + (error ? '&error=1' : ''));
  } else srcDescriptor.set.call(this, value);
}});
let serial = 0;
const hold = (error = false) => { const key = 'k' + (++serial); holdQueue.push({key, error}); return key; };
const release = key => fetch('/release-image?key=' + key);

async function png(w, h, n) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d');
  COLORS.forEach((col, i) => { x.fillStyle = `rgb(${col})`; x.fillRect((i % 2) * w / 2, (i >> 1) * h / 2, w / 2, h / 2); });
  x.fillStyle = `rgb(${(n * 37) % 256},${(n * 91) % 256},${(n * 53) % 256})`; x.fillRect(1, 1, Math.max(2, w >> 3), Math.max(2, h >> 3));
  const blob = await new Promise(r => c.toBlob(r, 'image/png')); c.width = c.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}
// Distinct 1x1 PNGs: almost no RGBA bytes, one decoded backing and lease entry each.
async function tinyPng(n) {
  const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d');
  x.fillStyle = `rgb(${n % 256},${20 + 40 * (n >> 8)},${(n * 7) % 256})`; x.fillRect(0, 0, 1, 1);
  const blob = await new Promise(r => c.toBlob(r, 'image/png')); c.width = c.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}
function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c >>> 0;
}
// Same PNG body with an IHDR that declares w x h (valid CRC), so only the header is oversized.
function withHeaderSize(bytes, w, h) {
  const out = bytes.slice(), view = new DataView(out.buffer);
  view.setUint32(16, w); view.setUint32(20, h); view.setUint32(29, crc32(out.subarray(12, 29)));
  return out;
}
function svg(n) {
  return new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><!--${n}--><rect width="4" height="8" fill="rgb(20,20,230)"/><rect x="4" width="4" height="8" fill="rgb(230,20,20)"/></svg>`);
}
// Each picture at its own paper position so frames show every image.
function build(mod, pngs, svgs = 0, sizes = []) {
  const d = mod.HwpDocument.createEmpty();
  const place = (data, ext, w, h, i) => {
    const p = JSON.parse(d.insertPicture(0, 0, 0, '', data, 6000, 6000, w, h, ext, '', null, null));
    d.setPictureProperties(0, p.paraIdx, p.controlIdx, JSON.stringify({treatAsChar: false, horzRelTo: 'Paper', vertRelTo: 'Paper',
      horzAlign: 'Left', vertAlign: 'Top', horzOffset: 3000 + (i % 4) * 7000, vertOffset: 3000 + Math.floor(i / 4) * 7000}));
  };
  pngs.forEach((data, i) => place(data, 'png', sizes[i] || 64, sizes[i] || 64, i));
  for (let s = 0; s < svgs; s++) place(svg(1000 + s + serial), 'svg', 8, 8, pngs.length + s);
  return d;
}
// Up to 300 small pictures on one page (20 per row).
function buildGrid(mod, pngs, svgs = 0) {
  const d = mod.HwpDocument.createEmpty();
  const place = (data, ext, w, i) => {
    const p = JSON.parse(d.insertPicture(0, 0, 0, '', data, 2400, 2400, w, w, ext, '', null, null));
    d.setPictureProperties(0, p.paraIdx, p.controlIdx, JSON.stringify({treatAsChar: false, horzRelTo: 'Paper', vertRelTo: 'Paper',
      horzAlign: 'Left', vertAlign: 'Top', horzOffset: 3000 + (i % 20) * 2600, vertOffset: 3000 + Math.floor(i / 20) * 2600}));
  };
  pngs.forEach((data, i) => place(data, 'png', 1, i));
  for (let s = 0; s < svgs; s++) place(svg(2000 + s + serial), 'svg', 8, pngs.length + s);
  return d;
}
function pixels(c) { return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
function mismatch(a, b) {
  if (a.width !== b.width || a.height !== b.height) return {extent: false, differences: -1};
  const x = pixels(a), y = pixels(b); let differences = 0, maxDelta = 0;
  for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); if (d) differences++; if (d > maxDelta) maxDelta = d; }
  return {extent: true, differences, maxDelta, width: a.width, height: a.height};
}

const modules = {}, notes = {baseline: 0, candidate: 0}, policy = {};
async function load(arm) {
  const mod = await import(`/${arm}/rhwp.js`); await mod.default();
  mod.setRendererImageLoadListener(() => { notes[arm]++; });
  return mod;
}
async function waitNote(arm, before, ms = 5000) {
  const end = performance.now() + ms;
  while (notes[arm] === before && performance.now() < end) await sleep(5);
  await sleep(0);
  return notes[arm] !== before;
}
// Settled Full render with real (unheld) browser loads; used as the pixel oracle.
async function settle(arm, mod, makeDoc) {
  const d = makeDoc(mod), c = document.createElement('canvas'); c.width = c.height = 1;
  let state = 'PENDING';
  for (let attempt = 0; attempt < 40 && state === 'PENDING'; attempt++) {
    const id = d.beginRenderJob(0, c, 0.5);
    for (let poll = 0; poll < 40 && state === 'PENDING'; poll++) {
      const before = notes[arm]; state = d.pollRenderJob(id);
      if (state === 'PENDING') await waitNote(arm, before, 1000);
    }
  }
  d.free();
  return {canvas: c, state};
}

for (const arm of ['baseline', 'candidate']) modules[arm] = await load(arm);
const lease = arm => arm === 'candidate';
try {
  for (const arm of ['baseline', 'candidate']) {
    const mod = modules[arm], docs = [], canvases = [];
    const snap = label => {
      const value = {label: arm + ':' + label, jobs: JSON.parse(mod.rendererJobStats()), cache: JSON.parse(mod.rendererCacheStats())};
      if (value.jobs.decodedLedger) result.ledger.push({label: value.label, decodedLedger: value.jobs.decodedLedger, jobs: value.jobs});
      return value;
    };
    const L = label => snap(label).jobs.decodedLedger;
    const check = (name, ok, detail = {}) => {
      result.tests.push({name, arm, status: ok ? 'PASS' : 'FAIL', ...detail});
      if (!ok) throw new Error(arm + ': ' + name + ' ' + JSON.stringify(detail).slice(0, 800));
    };
    const canvas = () => { const c = document.createElement('canvas'); c.width = c.height = 16; canvases.push(c); return c; };
    const keep = d => { docs.push(d); return d; };
    const reset = (decoded, images, entries) => { mod.trimRendererCaches(0); mod.setRendererCacheBudget(decoded, images, entries); };
    // Evict the decoded resident by bounded normal admission of another image (frequency policy).
    const evictWith = async (bytes, label) => {
      const other = keep(build(mod, [bytes])), oc = canvas(), start = snap(label + '-before').cache.decoded.evictions;
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = other.pollRenderJob(other.beginRenderJob(0, oc, 0.5));
        if (state !== 'COMPLETE') return {evicted: false, state};
        if (snap(label + '-' + attempt).cache.decoded.evictions > start) return {evicted: true, attempts: attempt + 1};
      }
      return {evicted: false};
    };
    // A pending job holding one decoded PNG; its browser SVG is server-held.
    const pendingWith = async (bytes, {error = false, target} = {}) => {
      const key = hold(error), d = keep(build(mod, [bytes], 1)), c = target || canvas();
      observed = [];
      const id = d.beginRenderJob(0, c, 0.5), state = d.pollRenderJob(id), handle = observed[0];
      observed = null;
      return {d, id, c, key, state, handle};
    };
    try {
      const X = await png(64, 64, 1), Y = await png(64, 64, 2);
      // S0: resident decoded with no job owner; unrelated admission evicts it.
      reset(4 << 20, 2 << 20, 1);
      { const d = keep(build(mod, [X])), c = canvas(); observed = [];
        const state = d.pollRenderJob(d.beginRenderJob(0, c, 0.5)), handle = observed[0]; observed = null;
        const evict = await evictWith(Y, 's0');
        const name = lease(arm) ? 'cache-only-eviction-disposes-backing' : 'baseline-raw-handle-invalidated-by-unrelated-eviction';
        check(name, state === 'COMPLETE' && handle?.width === 0 && evict.evicted, {evict, width: handle?.width,
          ledger: lease(arm) ? L('s0-after') : undefined}); }

      // S1: job lease across a real PENDING boundary while another job evicts the resident.
      // Two entries: the SVG also probes the Rust decoder first and leaves a negative entry.
      reset(4 << 20, 2 << 20, 2);
      const s1 = await pendingWith(X);
      const s1Resident = snap('s1-pending');
      const evict1 = await evictWith(Y, 's1');
      const afterEvict = snap('s1-evicted');
      if (lease(arm)) {
        check('job-lease-survives-unrelated-eviction', s1.state === 'PENDING' && evict1.evicted && s1.handle?.width === 64,
          {evict: evict1, width: s1.handle?.width, decodedEntries: afterEvict.cache.decoded.entries});
        const l = afterEvict.jobs.decodedLedger;
        check('evicted-leased-backing-counted-once-nonresident', l.uniqueCount === 2 && l.residentCount === 1 &&
          l.nonresidentBytes === 16384 && s1Resident.jobs.decodedLedger.nonresidentBytes === 0, {before: s1Resident.jobs.decodedLedger, after: l});
      } else {
        check('baseline-pending-job-handle-invalidated', s1.state === 'PENDING' && evict1.evicted && s1.handle?.width === 0,
          {evict: evict1, width: s1.handle?.width});
      }
      { const before = notes[arm]; await release(s1.key); await waitNote(arm, before);
        observed = []; const state = s1.d.pollRenderJob(s1.id), decodes = observed.length; observed = null;
        if (lease(arm)) {
          check('leased-job-completes-without-redecode', state === 'COMPLETE' && decodes === 0, {state, decodes});
          const done = snap('s1-complete'), l = done.jobs.decodedLedger, residentAfterCompletion = s1.handle.width === 64;
          // The completion offer follows the unchanged admission policy: X is either cache-owned or disposed.
          mod.trimRendererCaches(0);
          const trimmed = L('s1-trimmed');
          check('last-job-release-disposes-evicted-backing', l.jobLeaseReferences === 0 && l.nonresidentBytes === 0 &&
            s1.handle.width === 0 && trimmed.uniqueBytes === 0, {residentAfterCompletion, ledger: l, trimmed});
          check('decoded-cache-policy-identical-to-baseline', JSON.stringify(done.cache.decoded) === JSON.stringify(policy.baseline),
            {candidate: done.cache.decoded, baseline: policy.baseline});
        } else {
          policy.baseline = snap('s1-complete').cache.decoded;
          check('baseline-pending-job-redecodes-after-eviction', state === 'COMPLETE' && decodes === 1, {state, decodes});
        }
        const oracle = await settle('baseline', modules.baseline, m => build(m, [X], 1));
        const diff = mismatch(s1.c, oracle.canvas);
        check(lease(arm) ? 'leased-full-frame-exact' : 'baseline-full-frame-exact', oracle.state === 'COMPLETE' && diff.extent && diff.differences === 0, diff); }

      // S2: nonresident temporary (decoded budget 0) owned across PENDING, released at completion.
      reset(0, 2 << 20, 1);
      { const s2 = await pendingWith(X);
        if (lease(arm)) {
          const l = L('s2-pending');
          check('nonresident-temporary-retained-across-pending', s2.state === 'PENDING' && s2.handle?.width === 64 && l.nonresidentBytes === 16384 && l.residentCount === 0, {width: s2.handle?.width, ledger: l});
        } else check('baseline-temporary-released-before-pending-return', s2.state === 'PENDING' && s2.handle?.width === 0, {width: s2.handle?.width});
        const before = notes[arm]; await release(s2.key); await waitNote(arm, before);
        observed = []; const state = s2.d.pollRenderJob(s2.id), decodes = observed.length; observed = null;
        if (lease(arm)) {
          const l = L('s2-complete');
          check('nonresident-temporary-released-at-completion', state === 'COMPLETE' && decodes === 0 && s2.handle.width === 0 && l.uniqueBytes === 0, {state, decodes, ledger: l});
        }
        const d = keep(build(mod, [X])), c = canvas(); observed = [];
        const one = d.pollRenderJob(d.beginRenderJob(0, c, 0.5)), temp = observed[0]; observed = null;
        check(lease(arm) ? 'zero-budget-synchronous-temporary-released' : 'baseline-zero-budget-temporary-released',
          one === 'COMPLETE' && temp?.width === 0 && (!lease(arm) || L('s2-sync').uniqueBytes === 0), {width: temp?.width}); }

      if (lease(arm)) {
        // S3: two jobs share one backing; eviction and cancellation release only their references.
        reset(4 << 20, 2 << 20, 2);
        { const a1 = await pendingWith(X), a2 = await pendingWith(X);
          const l = L('s3-shared');
          check('shared-jobs-one-backing', a1.state === 'PENDING' && a2.state === 'PENDING' && a2.handle === undefined &&
            l.uniqueCount === 1 && l.jobLeaseReferences === 2 && l.residentCount === 1, {ledger: l});
          const evict = await evictWith(Y, 's3');
          a1.d.cancelRenderJob(a1.id);
          const one = L('s3-cancel-one');
          check('shared-cancel-one-keeps-backing', evict.evicted && a1.handle.width === 64 && one.nonresidentBytes === 16384 && one.jobLeaseReferences === 1, {evict, ledger: one});
          a2.d.cancelRenderJob(a2.id);
          const both = L('s3-cancel-both');
          check('shared-final-cancel-disposes', a1.handle.width === 0 && both.nonresidentBytes === 0 && both.jobLeaseReferences === 0, {ledger: both});
          await release(a1.key); await release(a2.key); await sleep(30); }

        // S4: every terminal path releases job ownership and reservations exactly once.
        reset(0, 2 << 20, 1);
        const lifecycle = async (name, n, action, extra = {}) => {
          const s = await pendingWith(await png(64, 64, n), extra);
          const pending = L(name + '-pending');
          const outcome = await action(s);
          const l = L(name + '-after');
          check(name, s.state === 'PENDING' && pending.nonresidentBytes === 16384 && s.handle.width === 0 && l.nonresidentBytes === 0 && l.reservedBytes === 0 && l.accountingErrors === 0,
            {outcome, width: s.handle.width, pending, after: l});
          await release(s.key);
          return s;
        };
        const canceled = await lifecycle('cancel-pending-releases', 11, s => s.d.cancelRenderJob(s.id));
        await lifecycle('close-pending-releases', 12, s => { s.d.free(); docs.splice(docs.indexOf(s.d), 1); return 'freed'; });
        await lifecycle('mutation-releases', 13, s => { s.d.insertText(0, 0, 0, 'x'); return s.d.pollRenderJob(s.id); });
        await lifecycle('stale-generation-releases', 14, s => { const other = keep(build(mod, [])); return other.beginRenderJob(0, s.c, 0.5); });
        await lifecycle('expiry-releases', 15, s => {
          const now = Date.now, start = now();
          Date.now = () => start + 16000;
          try { JSON.parse(mod.rendererJobStats()); return s.d.pollRenderJob(s.id); } finally { Date.now = now; }
        });
        await lifecycle('resource-error-releases', 16, async s => {
          const before = notes[arm]; await release(s.key); await waitNote(arm, before); return s.d.pollRenderJob(s.id);
        }, {error: true});
        { const before = L('repeat-before'), states = [];
          for (let i = 0; i < 5; i++) { states.push(canceled.d.cancelRenderJob(canceled.id), canceled.d.pollRenderJob(canceled.id)); mod.trimRendererCaches(0); }
          const after = L('repeat-after');
          check('repeated-terminal-no-double-release', states.every(s => s === 'CANCELED') && after.disposed === before.disposed &&
            after.created === before.created && after.accountingErrors === 0, {states, before, after}); }

        // S5a: many decoded images under cache pressure: unique once, resident bounded.
        reset(4 << 20, 2 << 20, 3);
        { const images = []; for (let n = 0; n < 6; n++) images.push(await png(64, 64, 20 + n));
          const key = hold(), d = keep(build(mod, images, 1)), c = canvas();
          const id = d.beginRenderJob(0, c, 0.5), state = d.pollRenderJob(id), l = L('s5a-pending');
          check('pressure-many-images-bounded', state === 'PENDING' && l.uniqueCount === 6 && l.residentCount >= 1 && l.residentCount <= l.decodedCacheMaxEntries &&
            l.nonresidentBytes === (6 - l.residentCount) * 16384 && l.jobLeaseReferences === 6, {ledger: l});
          const before = notes[arm]; await release(key); await waitNote(arm, before);
          const done = d.pollRenderJob(id), oracle = await settle('baseline', modules.baseline, m => build(m, images, 1));
          const diff = mismatch(c, oracle.canvas);
          check('cross-engine-full-frame-exact', done === 'COMPLETE' && diff.extent && diff.differences === 0, diff); }

        // S5b: job-held nonresident bytes beyond the 96 MiB bound are revoked, never exceeded.
        reset(0, 2 << 20, 1);
        { const big = []; for (let n = 0; n < 4; n++) big.push(await png(2600, 2600, 40 + n));
          const sizes = [2600, 2600, 2600, 2600];
          const key = hold(), d = keep(build(mod, big, 1, sizes)), c = canvas();
          observed = []; const id = d.beginRenderJob(0, c, 0.5), state = d.pollRenderJob(id), handles = observed; observed = null;
          const l = L('s5b-pending'), alive = handles.filter(h => h.width > 0).length;
          check('pressure-revocation-bounds-nonresident', state === 'PENDING' && handles.length === 4 && l.nonresidentBytes <= l.maxNonresidentBytes &&
            l.nonresidentBytes === alive * 2600 * 2600 * 4 && alive < 4 && snap('s5b-stats').jobs.decodedRevocations > 0 && l.peakUniquePlusReservedBytes <= l.decodedCacheMaxBytes + l.maxNonresidentBytes,
            {ledger: l, alive, revocations: snap('s5b-revocations').jobs.decodedRevocations});
          const before = notes[arm]; await release(key); await waitNote(arm, before);
          const done = d.pollRenderJob(id), oracle = await settle('baseline', modules.baseline, m => build(m, big, 1, sizes));
          const diff = mismatch(c, oracle.canvas);
          check('pressure-full-frame-exact', done === 'COMPLETE' && diff.extent && diff.differences === 0 && L('s5b-complete').uniqueBytes === 0, diff);
          d.free(); docs.splice(docs.indexOf(d), 1); }

        // S6: releasing decoded ownership never advertises browser capacity.
        reset(0, 2 << 20, 1);
        { const waiting = await pendingWith(await png(64, 64, 60)), holder = await pendingWith(await png(64, 64, 61));
          const before = snap('s6-before').jobs; holder.d.cancelRenderJob(holder.id); await sleep(80);
          const after = snap('s6-after').jobs;
          check('decoded-release-no-false-capacity-notification', holder.handle.width === 0 &&
            after.capacityNotifications === before.capacityNotifications && after.listenerNotifications === before.listenerNotifications,
            {before: {capacity: before.capacityNotifications, listener: before.listenerNotifications}, after: {capacity: after.capacityNotifications, listener: after.listenerNotifications}});
          waiting.d.cancelRenderJob(waiting.id); await release(waiting.key); await release(holder.key); await sleep(30); }

        // S7: 300 distinct tiny images (4 bytes each) bound job lease entries, not only bytes.
        reset(0, 2 << 20, 1);
        { const tiny = []; for (let n = 0; n < 300; n++) tiny.push(await tinyPng(n));
          const before = snap('s7-before').jobs;
          const keyA = hold(), a = keep(buildGrid(mod, tiny, 1)), ca = canvas(); observed = [];
          const ida = a.beginRenderJob(0, ca, 0.5), sa = a.pollRenderJob(ida), handles = observed; observed = null;
          const pa = snap('s7-a-pending').jobs, la = pa.decodedLedger, alive = () => handles.filter(h => h.width > 0).length;
          const aliveA = alive();
          check('tiny-images-job-lease-entries-bounded', sa === 'PENDING' && handles.length === 300 && pa.maxJobDecodedLeases === 256 &&
            pa.maxJobLeaseEntries === 256 && la.jobLeaseReferences === 256 && aliveA === 256 && la.uniqueCount === 256 &&
            la.nonresidentBytes === 1024 && pa.decodedAttachRefusals - before.decodedAttachRefusals === 44 && pa.decodedRegistryEntries <= la.uniqueCount + 1,
            {state: sa, decodes: handles.length, alive: aliveA, maxJobLeaseEntries: pa.maxJobLeaseEntries, refusals: pa.decodedAttachRefusals - before.decodedAttachRefusals,
             registryEntries: pa.decodedRegistryEntries, ledger: la});
          const keyB = hold(), b = keep(buildGrid(mod, tiny, 1)), cb = canvas(); observed = [];
          const idb = b.beginRenderJob(0, cb, 0.5), sb = b.pollRenderJob(idb), decodesB = observed.length; observed = null;
          const pb = snap('s7-b-pending').jobs, lb = pb.decodedLedger;
          check('tiny-images-shared-across-jobs-bounded', sb === 'PENDING' && decodesB === 44 && lb.uniqueCount === 256 && lb.jobLeaseReferences === 512 &&
            pb.maxJobLeaseEntries === 256 && pb.decodedSharedLookups - pa.decodedSharedLookups >= 256 && alive() === 256,
            {state: sb, decodes: decodesB, ledger: lb, sharedLookups: pb.decodedSharedLookups - pa.decodedSharedLookups});
          a.cancelRenderJob(ida);
          const lc = L('s7-cancel-a');
          check('tiny-images-cancel-keeps-shared-backing', alive() === 256 && lc.uniqueCount === 256 && lc.jobLeaseReferences === 256 && lc.reservedBytes === 0,
            {alive: alive(), ledger: lc});
          await release(keyA);
          const note = notes[arm]; await release(keyB); await waitNote(arm, note);
          const done = b.pollRenderJob(idb), complete = snap('s7-complete').jobs;
          const oracle = await settle('baseline', modules.baseline, m => buildGrid(m, tiny, 1)), diff = mismatch(cb, oracle.canvas);
          check('tiny-images-full-frame-exact', done === 'COMPLETE' && oracle.state === 'COMPLETE' && diff.extent && diff.differences === 0 &&
            alive() === 0 && complete.decodedLedger.uniqueBytes === 0 && complete.decodedLedger.jobLeaseReferences === 0 && complete.decodedRegistryEntries === 0,
            {...diff, state: done, alive: alive(), registryEntries: complete.decodedRegistryEntries, ledger: complete.decodedLedger}); }

        // S8: the same metadata bound with cache hits, admission and eviction (16 entries).
        reset(1 << 20, 2 << 20, 16);
        { const tiny = []; for (let n = 300; n < 600; n++) tiny.push(await tinyPng(n));
          const key = hold(), d = keep(buildGrid(mod, tiny, 1)), c = canvas();
          const id = d.beginRenderJob(0, c, 0.5), state = d.pollRenderJob(id), p8 = snap('s8-pending').jobs, l = p8.decodedLedger;
          check('tiny-images-cache-pressure-bounded', state === 'PENDING' && l.residentCount >= 1 && l.residentCount <= 16 && l.jobLeaseReferences === 256 &&
            p8.maxJobLeaseEntries === 256 && l.uniqueCount <= 256 + l.residentCount && l.nonresidentCount <= 256 && l.reservedBytes === 0,
            {state, ledger: l, maxJobLeaseEntries: p8.maxJobLeaseEntries});
          const note = notes[arm]; await release(key); await waitNote(arm, note);
          const done = d.pollRenderJob(id), l2 = L('s8-complete');
          const oracle = await settle('baseline', modules.baseline, m => buildGrid(m, tiny, 1)), diff = mismatch(c, oracle.canvas);
          mod.trimRendererCaches(0);
          const trimmed = snap('s8-trimmed').jobs;
          check('tiny-images-cache-pressure-full-frame-exact', done === 'COMPLETE' && oracle.state === 'COMPLETE' && diff.extent && diff.differences === 0 &&
            l2.jobLeaseReferences === 0 && l2.uniqueCount === l2.residentCount && trimmed.decodedLedger.uniqueBytes === 0 && trimmed.decodedRegistryEntries === 0,
            {...diff, state: done, complete: l2, trimmed: trimmed.decodedLedger}); }

        // S9: malformed data — truncated body, header without body, no header at all. A failed
        // decode releases its reservation and allocates no backing; the outcome equals baseline.
        reset(4 << 20, 2 << 20, 8);
        { const good = await png(64, 64, 70);
          const inputs = [good.slice(0, Math.floor(good.length / 2)), good.slice(0, 33), new TextEncoder().encode('not an image at all')];
          const before = L('s9-before');
          const cand = await settle(arm, mod, m => build(m, inputs)), base = await settle('baseline', modules.baseline, m => build(m, inputs));
          const after = L('s9-after'), diff = mismatch(cand.canvas, base.canvas);
          check('malformed-preflight-matches-baseline', cand.state === base.state && cand.state !== 'PENDING' && diff.extent && diff.differences === 0 &&
            after.created === before.created && after.reservedBytes === 0 && after.uniqueBytes === 0 && after.refusedReservations === before.refusedReservations &&
            after.rejectedCommits === 0 && after.preallocationRejections === 0 && after.unreservedDecodes > before.unreservedDecodes,
            {state: cand.state, baseline: base.state, ...diff, before, after}); }

        // S10: a header declaring 6000 x 6000 (144 MB RGBA) is refused before any allocation.
        reset(4 << 20, 2 << 20, 8);
        { const big = withHeaderSize(await png(64, 64, 71), 6000, 6000), before = L('s10-before');
          const job = m => { const d = keep(build(m, [big])), c = canvas(); return d.pollRenderJob(d.beginRenderJob(0, c, 0.5)); };
          observed = []; const state = job(mod), allocated = observed.length; observed = null;
          const baseState = job(modules.baseline), after = L('s10-after');
          check('oversize-header-refused-before-allocation', state === 'RESOURCE_LIMIT' && baseState === state && allocated === 0 &&
            after.created === before.created && after.reservedBytes === 0 && after.uniqueBytes === 0 && after.rejectedCommits === 0,
            {state, baseline: baseState, allocated, before, after}); }

        // S11: the synchronous API keeps its contract. renderPageToCanvas is a one-poll job here,
        // so the entry bound applies inside it (44 retentions refused) with identical pixels.
        reset(0, 2 << 20, 1);
        { const tiny = []; for (let n = 0; n < 300; n++) tiny.push(await tinyPng(n + 600));
          const before = snap('s11-before').jobs;
          const render = m => { const d = keep(buildGrid(m, tiny)), c = canvas(); d.renderPageToCanvas(0, c, 0.5); return c; };
          const cand = render(mod), base = render(modules.baseline), after = snap('s11-after').jobs, diff = mismatch(cand, base);
          check('legacy-sync-tiny-images-exact', diff.extent && diff.differences === 0 && after.decodedLedger.uniqueBytes === 0 &&
            after.decodedLedger.created - before.decodedLedger.created === 300 && after.decodedAttachRefusals - before.decodedAttachRefusals === 44 &&
            after.decodedLedger.jobLeaseReferences === 0 && after.activeJobs === 0 && after.decodedRegistryEntries === 0 &&
            after.decodedLedger.unenforcedOverLimit === before.decodedLedger.unenforcedOverLimit,
            {...diff, created: after.decodedLedger.created - before.decodedLedger.created,
             refusals: after.decodedAttachRefusals - before.decodedAttachRefusals, ledger: after.decodedLedger}); }
      }
    } finally {
      observed = null; holdQueue.length = 0;
      for (const d of docs) d.free();
      for (const c of canvases) c.width = c.height = 0;
      mod.trimRendererCaches(0); await sleep(50);
      const cleanup = snap('final');
      if (lease(arm)) {
        const l = cleanup.jobs.decodedLedger;
        check('final-ledger-zero', l.uniqueBytes === 0 && l.uniqueCount === 0 && l.reservedBytes === 0 && l.created === l.disposed &&
          l.accountingErrors === 0 && cleanup.jobs.activeJobs === 0 && cleanup.jobs.ownedEstimatedBytes === 0 &&
          l.jobLeaseReferences === 0 && cleanup.jobs.decodedRegistryEntries === 0 && cleanup.jobs.maxJobLeaseEntries === 0,
          {ledger: l, registryEntries: cleanup.jobs.decodedRegistryEntries, maxJobLeaseEntries: cleanup.jobs.maxJobLeaseEntries});
      }
      result.transitions.push({arm, cleanup});
    }
  }
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = String(error && error.stack || error);
} finally {
  observed = null; CanvasRenderingContext2D.prototype.putImageData = putImageData;
  Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
}
await fetch('/result', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(result)});
