import { historical } from './historical.mjs';
import { svg, classify } from './fixtures.mjs';
// Observe the historical 250-ms global interval without retaining callbacks/DOM.
const expiryIntervals = new Set(); let expiryIntervalTicks = 0, expiryIntervalStarts = 0;
const startInterval = window.setInterval.bind(window), stopInterval = window.clearInterval.bind(window);
window.setInterval = (callback, ms, ...args) => {
  if (ms !== 250 || typeof callback !== 'function') return startInterval(callback, ms, ...args);
  const id = startInterval(() => { expiryIntervalTicks++; callback(...args); }, ms);
  expiryIntervals.add(id); expiryIntervalStarts++; return id;
};
window.clearInterval = id => { expiryIntervals.delete(id); stopInterval(id); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const stats = (mod) => mod.rendererCacheStats ? JSON.parse(mod.rendererCacheStats()) : null;

// Compare every pixel from lossless run-length encoded RGBA words; hashes are diagnostic only.
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
function sanitize(row) { const { runs: _pixels, ...metadata } = row; return metadata; }

// Browser handle instrumentation retains counters and hashes only, never image handles or data URLs.
const loads = { started: 0, loaded: 0, errors: 0, canceled: 0, releaseErrorEvents: 0, byImage: {} };
const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
const ids = new WeakMap();
Object.defineProperty(HTMLImageElement.prototype, 'src', { ...descriptor, set(value) {
  if (value && value.startsWith('data:')) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619) >>> 0;
    const id = h.toString(16); const ownership = { id, released: false }; ids.set(this, ownership);
    const item = loads.byImage[id] ??= { started: 0, loaded: 0, errors: 0, encodedUrlChars: value.length };
    item.started++; loads.started++;
    this.addEventListener('load', () => { item.loaded++; loads.loaded++; }, { once: true });
    this.addEventListener('error', () => { if (ownership.released) loads.releaseErrorEvents++; else { item.errors++; loads.errors++; } }, { once: true });
  } else if (!value && ids.has(this)) { loads.canceled++; ids.get(this).released = true; ids.delete(this); }
  descriptor.set.call(this, value);
} });

function makePage(mod, dimensions) {
  const doc = mod.HwpDocument.createEmpty();
  dimensions.forEach((n, i) => {
    const placed = JSON.parse(doc.insertPicture(0, 0, 0, '', svg(n, n, i + 1), 9000, 9000, n, n, 'svg', '', null, null));
    doc.setPictureProperties(0, placed.paraIdx, placed.controlIdx, JSON.stringify({
      treatAsChar: false, horzRelTo: 'Paper', vertRelTo: 'Paper',
      horzAlign: 'Left', vertAlign: 'Top', horzOffset: (100 + 160 * i) * 75, vertOffset: 100 * 75,
    }));
  });
  assert(doc.pageCount() === 1, 'stress fixture must keep all images on one page');
  return doc;
}
function draw(doc, canvas) { doc.renderPageToCanvas(0, canvas, 1); return classify(canvas); }
async function settledReference(mod, dimensions) {
  const d = makePage(mod, dimensions), canvas = document.createElement('canvas');
  draw(d, canvas); await sleep(800);
  const a = draw(d, canvas); await sleep(100); const b = draw(d, canvas);
  assert(mismatch(a, b) === 0 && b.counts.reduce((a, n) => a + n, 0) >= dimensions.length * 120 * 120 * 0.95, 'reference did not settle or pictures overlap');
  d.free(); canvas.width = canvas.height = 0; return b;
}
async function stress(mod, pinned) {
  assert(typeof mod.setRendererImageLoadListener === 'function', 'candidate listener missing');
  mod.trimRendererCaches(0); mod.setRendererCacheBudget(8 << 20, 2 << 20, 8);
  const dims = [1200, 1210];
  const d = makePage(mod, dims), canvas = document.createElement('canvas');
  const beforeLoads = structuredClone(loads);
  const beforeCache = stats(mod);
  const frames = []; let notifications = 0, paints = 0, raf = null, disposed = false;
  const deadline = performance.now() + 4000;
  mod.setRendererImageLoadListener(() => {
    notifications++;
    if (disposed || raf !== null || performance.now() >= deadline || paints >= 32) return;
    raf = requestAnimationFrame(() => {
      raf = null; if (disposed) return;
      frames.push(draw(d, canvas)); paints++;
    });
  });
  frames.push(draw(d, canvas)); paints++;
  await sleep(4200);
  if (raf !== null) cancelAnimationFrame(raf);
  mod.setRendererImageLoadListener(null);
  const final = frames.at(-1), retained = stats(mod);
  disposed = true; d.free();
  const afterClose = stats(mod);
  await sleep(250); const afterIdle = stats(mod);
  mod.trimRendererCaches(0); const afterTrim = stats(mod);
  canvas.width = canvas.height = 0;
  const afterLoads = structuredClone(loads);
  const reference = await settledReference(pinned, dims);
  const result = {
    dimensions: dims.map((n, i) => ({ width: n, height: n, encodedBytes: svg(n, n, i + 1).length, boxPx: 120 })),
    budget: { decodedBytes: 8 << 20, imageBytes: 2 << 20, entries: 8 }, scale: 1,
    notifications, paints, limitReached: paints >= 32,
    cacheMissInsertions: retained.images.misses - beforeCache.images.misses,
    phaseImageLoads: Object.fromEntries(Object.entries(afterLoads.byImage).filter(([key, v]) => v.started > (beforeLoads.byImage[key]?.started ?? 0)).map(([key, v]) => [key, {
      encodedUrlChars: v.encodedUrlChars, started: v.started - (beforeLoads.byImage[key]?.started ?? 0),
      loaded: v.loaded - (beforeLoads.byImage[key]?.loaded ?? 0), errors: v.errors - (beforeLoads.byImage[key]?.errors ?? 0),
    }])) ,
    loadAttempts: afterLoads.started - beforeLoads.started, imageErrors: afterLoads.errors - beforeLoads.errors,
    releaseErrorEvents: afterLoads.releaseErrorEvents - beforeLoads.releaseErrorEvents,
    final: sanitize(final), reference: sanitize(reference), pixelMismatchCount: mismatch(final, reference),
    frameMismatches: frames.map((f) => mismatch(f, reference)),
    retained, afterClose, afterIdle, afterTrim,
  };
  result.pixelStatus = result.pixelMismatchCount === 0 ? 'PASS' : 'FAIL';
  result.notificationStatus = !result.limitReached && result.loadAttempts <= 4 && notifications <= 2 ? 'PASS' : 'FAIL';
  result.memoryStatus = retained.images.bytes <= (2 << 20) ? 'PASS' : 'FAIL';
  result.status = [result.pixelStatus, result.notificationStatus, result.memoryStatus].every((s) => s === 'PASS') ? 'PASS' : 'FAIL';
  return result;
}
async function pendingBurst(mod) {
  mod.trimRendererCaches(0); mod.setRendererCacheBudget(1 << 20, 1024, 2);
  const docs = [], canvas = document.createElement('canvas');
  for (let i = 0; i < 100; i++) {
    const d = makePage(mod, [81 + i]); docs.push(d); draw(d, canvas);
  }
  const during = stats(mod);
  mod.setRendererCacheBudget(1 << 20, 512, 1); const reduced = stats(mod);
  mod.trimRendererCaches(0); const trimmedWhilePending = stats(mod);
  for (const d of docs) d.free();
  await sleep(800); const afterClosedCallbacks = stats(mod);
  mod.trimRendererCaches(0); const afterFinalTrim = stats(mod);
  canvas.width = canvas.height = 0;
  return { requests: 100, during, reduced, trimmedWhilePending, afterClosedCallbacks, afterFinalTrim,
    status: during.images.entries <= 2 && during.images.bytes <= 1024 ? 'PASS' : 'FAIL' };
}

async function formatLoading(candidate, pinned) {
  const results = [];
  for (const format of ['hwp', 'hwpx']) {
    const maker = makePage(pinned, [128]);
    const exported = format === 'hwp' ? maker.exportHwpWithReport() : maker.exportHwpxWithReport();
    const contentLoss = JSON.parse(exported.contentLoss());
    const bytes = exported.takeBytes(); exported.free(); maker.free();
    const referenceDoc = new pinned.HwpDocument(bytes), actualDoc = new candidate.HwpDocument(bytes);
    const referenceCanvas = document.createElement('canvas'), actualCanvas = document.createElement('canvas');
    draw(referenceDoc, referenceCanvas); draw(actualDoc, actualCanvas); await sleep(500);
    const reference = draw(referenceDoc, referenceCanvas), actual = draw(actualDoc, actualCanvas);
    const pixelMismatchCount = mismatch(reference, actual);
    const complete = reference.counts.reduce((a, n) => a + n, 0) >= 120 * 120 * 0.95;
    results.push({ format, encodedBytes: bytes.length, signature: Array.from(bytes.slice(0, 8)),
      pages: actualDoc.pageCount(), scale: 1, contentLoss, reference: sanitize(reference), actual: sanitize(actual),
      pixelMismatchCount, status: complete && pixelMismatchCount === 0 && actualDoc.pageCount() === 1 ? 'PASS' : 'FAIL' });
    referenceDoc.free(); actualDoc.free(); referenceCanvas.width = referenceCanvas.height = actualCanvas.width = actualCanvas.height = 0;
  }
  return results;
}

async function main() {
  const candidate = await import('/candidate/rhwp.js');
  await candidate.default({ module_or_path: '/candidate/rhwp_bg.wasm' });
  const pinned = await import('/pinned/rhwp.js');
  await pinned.default({ module_or_path: '/pinned/rhwp_bg.wasm' });
  if (candidate.HwpDocument.prototype.beginRenderJob) {
    const { ownership } = await import('./ownership.mjs');
    return ownership(candidate, pinned, { mismatch, loads });
  }
  const concurrent = await stress(candidate, pinned);
  const pending = await pendingBurst(candidate);
  candidate.setRendererCacheBudget(256 << 20, 64 << 20, 256);
  const baseline = await historical(pinned);
  const current = await historical(candidate);
  let draws = 0, exact = 0; const failures = [];
  const golden = await (await fetch('/historical-expected.json')).json();
  const historicalExpected = golden.engines[navigator.userAgent.includes('Chrome/') ? 'chrome' : 'webkit'];
  for (const [name, scenario] of Object.entries(baseline.results)) {
    scenario.rows.forEach((row, i) => {
      const old = historicalExpected[name].renders[i];
      if ((old.present !== '0000' || name === 'negativeDecode') && row.hash !== old.hash)
        failures.push(`historical baseline changed: ${name}/${row.label} ${row.hash} != ${old.hash}`);
    });
  }
  for (const [name, scenario] of Object.entries(current.results)) {
    const expected = baseline.results[name];
    assert(scenario.rows.length === expected.rows.length, `missing draws: ${name}`);
    scenario.rows.forEach((row, i) => {
      const count = mismatch(row, expected.rows[i]); row.pixelMismatchCount = count;
      draws++; if (count === 0) exact++;
      if (row.threw) failures.push(`${name}/${row.label}: ${row.threw}`);
      // Preserve every historical nonblank-frame assertion (including r2, which caught the old release bug).
      // A candidate may display a cold asynchronous image earlier than the pinned engine.
      if ((expected.rows[i].present !== '0000' || name === 'negativeDecode') && count) failures.push(`${name}/${row.label}: ${count} differing pixels`);
    });
    const last = scenario.rows.at(-1);
    const expectedColors = name === 'negativeDecode' ? '0000' : name === 'croppedGif' ? '0101' : '1111';
    if (last.present !== expectedColors) failures.push(`${name}: missing final quadrants ${last.present}`);
  }
  assert(draws === 50, `historical coverage changed: ${draws}`);
  const formats = await formatLoading(candidate, pinned);
  const clean = (run) => ({ ...run, results: Object.fromEntries(Object.entries(run.results).map(([k, v]) => [k, { ...v, rows: v.rows.map(sanitize) }])) });
  return { schema: 1, userAgent: navigator.userAgent, concurrent, pending, loads, formats,
    historical: { status: failures.length || current.errors.length || baseline.errors.length ? 'FAIL' : 'PASS', draws, exactPixelMatches: exact, failures,
      pinned: clean(baseline), candidate: clean(current) },
    status: concurrent.status === 'PASS' && pending.status === 'PASS' && !failures.length && !current.errors.length && !baseline.errors.length && formats.every((f) => f.status === 'PASS') ? 'PASS' : 'FAIL' };
}
const errors = [];
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
try {
  const result = await main(); result.unhandledErrors = errors; result.expiryIntervalObservation = { active:expiryIntervals.size, starts:expiryIntervalStarts, ticks:expiryIntervalTicks, pendingJobsAtEnd:result.scheduler?.checkpoints.at(-1)?.jobs.activeJobs ?? null };
  if (errors.length) result.status = 'FAIL';
  await fetch('/result', { method: 'POST', body: JSON.stringify(result) });
} catch (e) {
  await fetch('/result', { method: 'POST', body: JSON.stringify({ schema: 1, status: 'FAIL', error: String(e.stack || e), unhandledErrors: errors }) });
}
