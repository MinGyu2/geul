// Decoded-resource lease and ledger contract in a real browser. "baseline" is the previous
// experimental engine (raw HtmlCanvasElement decoded cache); "candidate" is the lease engine.
// putImageData observes each Rust decode's Canvas so backing lifetime (width/height) is checked
// directly; the observer holds a DOM reference only, never an engine lease.
const result = {schema: 1, status: 'RUNNING', tests: [], ledger: [], transitions: []};
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
          l.accountingErrors === 0 && cleanup.jobs.activeJobs === 0 && cleanup.jobs.ownedEstimatedBytes === 0, {ledger: l});
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
