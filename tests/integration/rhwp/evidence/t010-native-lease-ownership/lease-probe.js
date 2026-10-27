
  // T010 native lease diagnostic (test-only, injected into native_probe.INSTALL before p.owners).
  // Test-owned documents X/Y are separate HwpDocument instances of the same verified bytes in the
  // app's real candidate module, so they share its global resource pool and caches. Every checkpoint
  // copies rendererJobStats/rendererCacheStats verbatim; nothing here derives or fabricates counters.
  const lab = p.lease = {docs: {}, canvases: {}, log: [], appHeld: null};
  const jobStats = () => JSON.parse(mod.rendererJobStats()), cacheStats = () => JSON.parse(mod.rendererCacheStats());
  const snap = (label, extra = {}) => {
    const row = {label, at: performance.now(), jobs: jobStats(), cache: cacheStats(), ...extra};
    lab.log.push(row); return row;
  };
  lab.snap = snap;
  // Deterministic PENDING (same test-only mechanism as the Chrome/WebKit lease contract): the next N
  // SVG data-URL image loads are redirected to the PoC server, which holds the response until
  // release (or its 20 s timeout). The engine's own load/onload path is unchanged.
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  const holdQueue = []; let holdSerial = 0; lab.held = [];
  Object.defineProperty(HTMLImageElement.prototype, 'src', {...srcDescriptor, set(value) {
    if (typeof value === 'string' && value.startsWith('data:image/svg+xml;base64,') && holdQueue.length) {
      const key = holdQueue.shift(); lab.held.push(key);
      srcDescriptor.set.call(this, '/held-image.svg?key=' + key + '&data=' + encodeURIComponent(value));
    } else srcDescriptor.set.call(this, value);
  }});
  lab.hold = n => { for (let i = 0; i < n; i++) holdQueue.push('L' + (++holdSerial)); return holdQueue.length; };
  lab.unhold = () => { const unused = holdQueue.length; holdQueue.length = 0; return unused; };
  lab.release = () => { const keys = lab.held.splice(0); for (const k of keys) fetch('/release-image?key=' + k); return keys; };
  lab.canvas = name => (lab.canvases[name] ??= document.createElement('canvas'));
  lab.scale = () => parseInt(document.querySelector('.statusbar__zoom-value').textContent) / 100 * devicePixelRatio;
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  // Two independent HwpDocument instances of the same verified bytes (base64 from the harness or a PoC route).
  lab.load = (names, expected, base64, route) => {
    lab.loaded = null;
    (async () => {
      const bytes = route ? new Uint8Array(await (await fetch(route, {cache: 'no-store'})).arrayBuffer())
        : Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
      const hash = await digest(bytes);
      if (hash !== expected) throw Error('fixture hash mismatch');
      const pages = {};
      for (const name of names) { lab.docs[name] = new mod.HwpDocument(bytes.slice()); pages[name] = lab.docs[name].pageCount(); }
      lab.loaded = {ok: true, hash, pages};
    })().catch(e => { lab.loaded = {ok: false, error: String(e)}; });
  };
  // Module-level pressure while the app is idle: empties both caches without waking app sessions.
  lab.trim = label => { mod.trimRendererCaches(0); return snap(label); };
  lab.preparation = (enabled, label) => { mod.setRendererPreparationEnabled(enabled); return snap(label, {preparationRequested: enabled}); };
  // Poll synchronously until the job holds an in-flight image lease or leaves PENDING. No await:
  // a browser load event cannot run between the last poll and the stats read.
  // kind 'image': an in-flight browser image lease; 'decoded': a decoded backing retained by the job.
  const holds = (kind, j) => kind === 'decoded' ? j.maxJobLeaseEntries > 0 : j.pendingCount > 0 && j.activeLeaseCount > 0;
  const untilLease = (doc, id, kind = 'image', max = 256) => {
    let outcome = 'PENDING', polls = 0;
    while (polls < max) {
      outcome = doc.pollRenderJob(id); polls++;
      if (outcome !== 'PENDING') break;
      if (holds(kind, jobStats())) break;
    }
    return {outcome, polls};
  };
  lab.begin = (name, canvas, page, label, kind = 'image') => {
    const doc = lab.docs[name], id = doc.beginRenderJob(page, lab.canvas(canvas), lab.scale());
    const r = untilLease(doc, id, kind);
    return {id, ...r, snap: snap(label, {doc: name, canvas, page, id, outcome: r.outcome, polls: r.polls})};
  };
  lab.poll = (name, id, label) => { const outcome = lab.docs[name].pollRenderJob(id); return {outcome, snap: snap(label, {doc: name, id, outcome})}; };
  lab.cancel = (name, id, label) => { const outcome = lab.docs[name].cancelRenderJob(id); return {outcome, snap: snap(label, {doc: name, id, outcome})}; };
  lab.reference = (name, canvas, page) => { lab.docs[name].renderPageToCanvas(page, lab.canvas(canvas), lab.scale()); return snap('reference', {doc: name, canvas, page}); };
  lab.rgba = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  lab.compareCanvas = (a, b) => {
    if (!a.width || !a.height || a.width !== b.width || a.height !== b.height) return {sameExtent: false, a: [a.width, a.height], b: [b.width, b.height]};
    const x = lab.rgba(a), y = lab.rgba(b); let differences = 0, maxDelta = 0, nonWhitePixels = 0;
    for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); if (d) { differences++; if (d > maxDelta) maxDelta = d; } }
    for (let i = 0; i < x.length; i += 4) if (x[i] !== 255 || x[i + 1] !== 255 || x[i + 2] !== 255) nonWhitePixels++;
    return {sameExtent: true, width: a.width, height: a.height, channelDifferences: differences, maxDelta, nonWhitePixels};
  };
  lab.compare = (a, b) => lab.compareCanvas(lab.canvases[a], lab.canvases[b]);
  lab.free = name => { lab.docs[name].free(); delete lab.docs[name]; return snap('free:' + name); };
  lab.setBudget = (decoded, images, entries, label) => { mod.setRendererCacheBudget(decoded, images, entries); return snap(label, {budget: [decoded, images, entries]}); };
  // App-owned document: `active` is the live app HwpDocument recorded by the hitTest wrapper.
  lab.appBegin = (page, canvas, label) => {
    if (!active) throw Error('no active app document');
    const id = active.beginRenderJob(page, lab.canvas(canvas), lab.scale()), r = untilLease(active, id);
    lab.appHeld = {doc: active, id, canvas};
    return {id, ...r, appPages: active.pageCount(), snap: snap(label, {doc: 'app', canvas, page, id, outcome: r.outcome, polls: r.polls})};
  };
  lab.appPollHeld = label => {
    const held = lab.appHeld; if (!held || held.doc !== active) throw Error('held app document changed');
    const c = lab.canvases[held.canvas], before = c.width ? lab.rgba(c) : new Uint8ClampedArray();
    const outcome = held.doc.pollRenderJob(held.id), after = c.width ? lab.rgba(c) : new Uint8ClampedArray();
    let differences = before.length === after.length ? 0 : -1;
    if (differences === 0) for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differences++;
    return {outcome, channelDifferences: differences, snap: snap(label, {doc: 'app', id: held.id, outcome})};
  };
  lab.appForget = () => { lab.appHeld = null; };
