import { changedBand } from '../../../../src/components/Editor/rhwp/paintDiff.ts';
import { drawsAtRequestedScale } from '../../../../src/components/Editor/rhwp/renderBudget.ts';
// Test-only adapter for the real RhwpEditorSession and its sole WASM document.
// Bounded read-only paint summaries support damage comparison; no document bytes,
// alternate editable model or history are retained here.
const sameRequest = (a, b) => !!a && a.canvas === b.canvas && a.page === b.page
  && a.scale === b.scale && a.generation === b.generation && a.version === b.version && a.mode === b.mode;
// The engine changes this token whenever any job takes the target Canvas.
const ownsFrame = frame => !!frame && frame.canvas.__rhwpExperimentalRenderJob === frame.id;
const MAX_SESSIONS = 8, MAX_QUEUE = 256, MAX_POLLS = 512;
const MAX_SUMMARIES = 64, MAX_SUMMARY_UNITS = 262144, MAX_SUMMARY_TOTAL_UNITS = 8 * MAX_SUMMARY_UNITS;
const subscribers = new Set();
const sessions = new Set();
const counters = { completed: 0, canceled: 0, errors: 0, limits: 0, notifications: 0, polls: 0, staleDropped: 0, reused: 0, replacements: 0, fullJobs: 0, patchJobs: 0, regionalPatchJobs: 0, wholePagePatchJobs: 0, unchangedFrames: 0 };
let scheduled = false, loading, probeListener = null, wasmMemory = null;
const wake = () => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; for (const subscriber of [...subscribers]) subscriber(); });
};
async function module() {
  loading ??= (async () => {
    const identity = await (await fetch('/__ownership_candidate__/ENGINE.json')).json();
    const bytes = await (await fetch('/__ownership_candidate__/rhwp_bg.wasm')).arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (identity.buildStatus !== 'PASS' || !identity.sourceStableDuringBuild || hash !== identity.artifacts['rhwp_bg.wasm']) throw new Error('PoC runtime engine identity mismatch');
    const url = '/__ownership_candidate__/rhwp.js';
    const engine = await import(/* @vite-ignore */ url);
    const exports = await engine.default({ module_or_path: bytes });
    // History monitoring needs the real linear memory (RhwpEditorSession refuses unmonitored history).
    if (exports?.memory instanceof WebAssembly.Memory) wasmMemory = exports.memory;
    engine.setRendererImageLoadListener(() => { counters.notifications++; wake(); probeListener?.(); });
    window.__geulOwnership = {
      probeEngine: () => ({ ...engine, setRendererImageLoadListener: listener => { probeListener = listener; } }),
      identity: { baseline: identity.baseline, wasmSha256: hash }, counters,
      repeat: count => { for (const session of sessions) session.repeat(count); },
      stats: () => ({ subscribers: subscribers.size, sessions: [...sessions].map(s => s.stats()),
        jobs: JSON.parse(engine.rendererJobStats()), cache: JSON.parse(engine.rendererCacheStats()) }),
      // Explicit pressure invalidates queued host jobs before canceling module resources.
      repaint: () => { for (const session of sessions) session.repaint(); wake(); },
      trim: () => { for (const session of sessions) session.cancel(); engine.trimRendererCaches(0); },
      budget: bytes => { for (const session of sessions) session.cancel(); engine.setRendererCacheBudget(Math.floor(bytes * .75), Math.floor(bytes * .25), 256); },
    };
    return engine;
  })();
  return loading;
}

export function createOwnershipSession(Session, sessionId, backend, registry) {
  let doc = null, generation = 0, documentId = 0, active = null, timer = null, disposed = false;
  // Optional observer never receives or retains actual canvas/document references.
  const canvasIds = new WeakMap(); let nextCanvas = 0, nextRequest = 0;
  const trace = (event, request, extra = {}) => {
    let observer;
    try {
      observer = globalThis.window?.__d4LifecycleTrace;
      if (!observer) return;
      let canvas = null;
      if (request?.canvas) { canvas = canvasIds.get(request.canvas); if (!canvas) { canvas = ++nextCanvas; canvasIds.set(request.canvas, canvas); } }
      observer.record({ event, at: performance.now(), session: sessionId, document: request?.traceDocument ?? documentId,
        request: request?.traceRequest ?? null, input: request?.traceInput ?? null, canvas,
        page: request?.page, scale: request?.scale, generation: request?.generation ?? generation,
        version: request?.version ?? session.modelVersion, mode: request?.mode, ...extra });
    } catch { try { observer.markFailure?.(); } catch { /* renderer must continue */ } }
  };
  const queue = new Map(), canvases = new Map(), failed = new Map(), painted = new Map(), listeners = new Set();
  const unsubscribe = () => subscribers.delete(pump);
  const cancel = (keepPainted = false) => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (active && doc) { doc.cancelRenderJob(active.id); trace('cancel', active, {job:active.id, reason:'session-cancel'}); counters.canceled++; }
    active = null; for (const request of queue.values()) trace('stale-drop', request, {reason:'session-cancel'});
    queue.clear(); failed.clear(); if (!keepPainted) painted.clear();
  };
  const session = new Session(sessionId, backend, registry, async () => {
    const engine = await module();
    const memory = wasmMemory;
    return { ...(memory ? { memoryBytes: () => memory.buffer.byteLength } : {}), openDocument(bytes) {
      // Save validation reopens are independent read-only handles, never replace
      // this session's authoritative live document or listener registration.
      if (doc) return new engine.HwpDocument(bytes);
      cancel(); generation++;
      if (disposed || subscribers.size >= MAX_SESSIONS) throw new Error('RESOURCE_LIMIT: PoC sessions');
      doc = new engine.HwpDocument(bytes); documentId++;
      // Snapshot restoration can change table paint structure/edge coverage beyond
      // the small serialized band. Discard the damage basis and use atomic full
      // replay after Undo/Redo; never accept a tolerant pixel match as exact.
      const restore = doc.restoreSnapshot?.bind(doc);
      if (restore) doc.restoreSnapshot = (...args) => { cancel(); return restore(...args); };
      const opened = doc, openedDocumentId = documentId, free = doc.free.bind(doc);
      doc.free = () => {
        trace('release-requested', null, {reason:'document-free',document:openedDocumentId});
        try {
          if (doc === opened) { cancel(); generation++; unsubscribe(); sessions.delete(handle); doc = null; }
          free(); trace('release-completed', null, {reason:'document-free',document:openedDocumentId});
        } catch (error) { trace('release-failed', null, {reason:'document-free',document:openedDocumentId}); throw error; }
      };
      subscribers.add(pump); sessions.add(handle);
      return doc;
    } };
  });
  const valid = request => !disposed && doc && request.generation === generation
    && request.version === session.modelVersion && request.canvas.isConnected && session.status.kind === 'ready';
  const visible = request => { const box = request.canvas.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; };
  const trimSummaries = () => {
    const summaries = [...painted.values()].filter(request => request.summary);
    let count = summaries.length, units = summaries.reduce((sum,request) => sum + request.summaryUnits,0);
    if (count <= MAX_SUMMARIES && units <= MAX_SUMMARY_TOTAL_UNITS) return;
    // Keep the original aggregate serialized budget; small unchanged pages can coexist.
    // Background completion must not displace the visible editing frame's basis.
    const victims = summaries.map(request => ({ request, visible: visible(request) }))
      .sort((a,b) => Number(a.visible)-Number(b.visible));
    for (const {request} of victims) {
      if (count <= MAX_SUMMARIES && units <= MAX_SUMMARY_TOTAL_UNITS) break;
      units -= request.summaryUnits; count--; request.summary = null; request.summaryUnits = 0;
    }
  };
  function pump() {
    if (disposed || !doc) return;
    if (active && !valid(active)) { doc.cancelRenderJob(active.id); trace('cancel', active, {job:active.id, reason:'stale'}); counters.staleDropped++; active = null; if(timer!==null)clearTimeout(timer);timer=null; wake(); }
    for (const [canvas, request] of queue) if (!valid(request)) { queue.delete(canvas); trace('stale-drop', request, {reason:'invalid-queue'}); counters.staleDropped++; }
    if (!active) {
      const requests = [...queue.values()].sort((a, b) => Number(visible(b)) - Number(visible(a)));
      const request = requests[0];
      if (!request) return;
      queue.delete(request.canvas);
      let startAttempted = false;
      try {
        const previous = painted.get(request.canvas), size = session.pages?.[request.page];
        // Existing product summaries describe actual paint input; never guess from caret bounds.
        // Cell replay still differs from Full at interior stroke/glyph edges; use the exact full path.
        const summary = request.mode === 'damage' && (!previous || previous.version === request.version) && !session.caret?.cell
          ? session.paintedSummary?.(doc, request.page) : null;
        const summaryUnits = summary ? JSON.stringify(summary).length : 0;
        const bounded = summary && summaryUnits <= MAX_SUMMARY_UNITS ? summary : null;
        // The exported layer JSON rounds geometry and omits render resources. It is
        // not a proof of equality across revisions; until the engine supplies a
        // complete identity, a newer model must take the full render path.
        if (bounded && previous?.summary && ownsFrame(previous) && previous.generation === request.generation
            && previous.version === request.version
            && previous.page === request.page && previous.scale === request.scale && size
            && previous.width === request.canvas.width && previous.height === request.canvas.height
            && request.canvas.width > 0 && request.canvas.height > 0 && drawsAtRequestedScale(size, request.scale)) {
          const band = changedBand(previous.summary, bounded, size.width, size.height);
          if (band === null) {
            painted.delete(request.canvas);
            painted.set(request.canvas, {...request, summary:bounded, summaryUnits:bounded ? summaryUnits : 0, width:request.canvas.width, height:request.canvas.height});
            trimSummaries();
            trace('reuse-complete', request, {reason:'unchanged-summary', relatedRequest:previous.traceRequest});
            counters.unchangedFrames++; queueMicrotask(() => { if (!disposed) for (const listener of listeners) listener(); }); wake(); return;
          }
          // Actual native integer and fractional regional replay differed from Full.
          // Only identical paint input can be skipped; every changed page uses Full.
        }
        startAttempted = true;
        const id = doc.beginRenderJob(request.page, request.canvas, request.scale);
        trace('job-start', request, {job:id});
        counters.fullJobs++;
        active = { ...request, summary:bounded, summaryUnits:bounded ? summaryUnits : 0, id, polls: 0 };
      }
      catch (error) { trace(startAttempted ? 'job-start-failed' : 'prepare-failed', request); failed.set(request.canvas, request); counters.limits++; wake(); return; }
    }
    const request = active;
    let state;
    try { state = ++request.polls > MAX_POLLS ? 'RESOURCE_LIMIT' : doc.pollRenderJob(request.id); }
    catch { state = 'ERROR'; }
    trace('poll', request, {job:request.id, state});
    counters.polls++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (state === 'PENDING') {
      // No RAF retry loop: completion notification or the bounded deadline wakes us.
      timer = setTimeout(() => { timer = null; wake(); }, 15250);
      return;
    }
    if (state === 'COMPLETE') {
      trace('complete', request, {job:request.id, state});
      counters.completed++;
      painted.delete(request.canvas);
      painted.set(request.canvas, {...request, width:request.canvas.width, height:request.canvas.height});
      // Serialized UTF-16 code units, not an actual JS-object or RSS byte certificate.
      trimSummaries();
      if (request.page === 0 && session.firstPaintMs === null) session.firstPaintMs = performance.now() - session.loadStartedAt;
      queueMicrotask(() => { if (!disposed) for(const listener of listeners)listener(); });
    }
    else {
      doc.cancelRenderJob(request.id);
      trace('cancel', request, {job:request.id, reason:'terminal-'+state});
      if (state === 'CANCELED') counters.canceled++;
      else { failed.set(request.canvas, {...request, summary:null, summaryUnits:0}); counters[state === 'RESOURCE_LIMIT' ? 'limits' : 'errors']++; }
    }
    active = null;
    wake(); // released capacity may unblock a different live session
  }
  const originalRelease = session.releaseRendering.bind(session), originalDispose = session.dispose.bind(session), originalSubscribe = session.subscribe.bind(session);
  session.subscribe = listener => {
    if(listeners.size >= 16)throw new Error('RESOURCE_LIMIT: PoC subscriptions');
    listeners.add(listener);const off=originalSubscribe(listener);
    return () => { listeners.delete(listener);off(); };
  };
  session.renderPage = (page, canvas, scale) => {
    if (disposed || !doc || !canvas.isConnected || !session.prepareRendering(scale)) return false;
    const request = { page, canvas, scale, generation, version: session.modelVersion, mode: typeof __T010_DAMAGE__ !== 'undefined' && __T010_DAMAGE__ ? 'damage' : 'full',
      traceDocument: documentId, traceRequest: ++nextRequest, traceInput: globalThis.window?.__d4LifecycleInput ?? null };
    trace('request', request, {reason:'renderPage'});
    const complete = painted.get(canvas);
    if (sameRequest(complete, request) && ownsFrame(complete) && complete.width === canvas.width && complete.height === canvas.height) { trace('reuse-complete', request, {relatedRequest:complete.traceRequest}); return true; }
    if (sameRequest(active, request) || sameRequest(queue.get(canvas), request)) { const matched = sameRequest(active, request) ? active : queue.get(canvas); trace('reuse-pending', request, {job:matched.id ?? null, relatedRequest:matched.traceRequest}); counters.reused++; return false; }
    if (active && active.version !== session.modelVersion) cancel(true);
    const previous = failed.get(canvas);
    if (sameRequest(previous, request)) return false;
    failed.delete(canvas);
    if (!canvases.has(canvas) && canvases.size >= MAX_QUEUE) { counters.limits++; return false; }
    if (active?.canvas === canvas) {
      doc.cancelRenderJob(active.id); trace('cancel', active, {job:active.id, reason:'replacement'}); counters.canceled++; counters.replacements++; active = null;
      if (timer !== null) clearTimeout(timer); timer = null;
    }
    const displaced = queue.get(canvas);
    if (displaced) trace('stale-drop', displaced, {reason:'queue-replacement'});
    queue.set(canvas, request); canvases.set(canvas, request); trace('queue', request);
    // Synchronous first poll matches the product effect boundary; async image continuation
    // still uses normal notifications. One job per request, no recursive renderer polling.
    wake();
    // Initial/resize frames stay deferred: React development mount cleanup may
    // release the backing store after this effect. Keep its pending marker until
    // the post-cleanup pump. Only an established same-size frame may poll here.
    if (!active && complete && complete.page === page && complete.scale === scale
        && complete.generation === generation && complete.width === canvas.width
        && complete.height === canvas.height && canvas.width > 0 && canvas.height > 0) pump();
    const result = painted.get(canvas);
    return !queue.has(canvas) && sameRequest(result, request) && ownsFrame(result) && result.width === canvas.width && result.height === canvas.height; // a queued frame is never reported as completed
  };
  const renderRequest = session.renderPage;
  session.renderPage = (...args) => {
    const at = performance.now();
    // Optional numeric-only diagnostic hook; no document/Canvas references escape.
    globalThis.window?.__d4RenderRequest?.({ at, page:args[0], generation,
      version:session.modelVersion, paintedVersion:painted.get(args[1])?.version ?? null,
      width:args[1].width, height:args[1].height, active:active?.id ?? null, queued:queue.size });
    try { return renderRequest(...args); }
    finally { globalThis.window?.__rhwpProbe?.record?.('adapterRenderRequest', at); }
  };
  session.releaseRendering = () => {
    trace('release-requested', null, {reason:'releaseRendering'});
    try {
      cancel(); for (const canvas of canvases.keys()) { canvas.width = 0; canvas.height = 0; }
      canvases.clear(); originalRelease(); trace('release-completed', null, {reason:'releaseRendering'});
    } catch (error) { trace('release-failed', null, {reason:'releaseRendering'}); throw error; }
  };
  const handle = { cancel, repeat: count => { for(let n=0;n<Math.min(count,100);n++) for(const request of canvases.values()) session.renderPage(request.page,request.canvas,request.scale); }, repaint: () => { for(const [canvas, request] of canvases) { if(canvas.isConnected) { painted.delete(canvas); const next = {...request,generation,version:session.modelVersion,traceDocument:documentId,traceRequest:++nextRequest,traceInput:null}; trace('request',next,{reason:'explicit-repaint',relatedRequest:request.traceRequest}); const displaced=queue.get(canvas); if(displaced)trace('stale-drop',displaced,{reason:'explicit-repaint'}); queue.set(canvas,next); trace('queue',next,{reason:'explicit-repaint'}); } } }, stats: () => ({ sessionId, generation, queued: queue.size, active: active ? 1 : 0, activeJobId: active?.id ?? null,
    canvases: canvases.size, summaries: [...painted.values()].filter(r=>r.summary).length, maxSummaries:MAX_SUMMARIES, summaryCodeUnits:[...painted.values()].reduce((sum,r)=>sum+(r.summary ? r.summaryUnits : 0),0), maxSummaryTotalCodeUnits:MAX_SUMMARY_TOTAL_UNITS, maxSummaryBytes:MAX_SUMMARY_UNITS /* legacy diagnostic name: serialized UTF-16 code units */, failures: failed.size, modelVersion: session.modelVersion }) };
  session.dispose = () => { if (disposed) return; trace('release-requested', null, {reason:'dispose'}); try { cancel(); unsubscribe(); disposed = true; sessions.delete(handle); originalDispose(); trace('release-completed', null, {reason:'dispose'}); } catch (error) { trace('release-failed', null, {reason:'dispose'}); throw error; } };
  return session;
}
