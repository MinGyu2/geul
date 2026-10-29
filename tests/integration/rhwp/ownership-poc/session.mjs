import { changedBand } from '../../../../src/components/Editor/rhwp/paintDiff.ts';
import { drawsAtRequestedScale } from '../../../../src/components/Editor/rhwp/renderBudget.ts';
// Test-only adapter for the real RhwpEditorSession and its sole WASM document.
// Bounded read-only paint summaries support damage comparison; no document bytes,
// alternate editable model or history are retained here.
const sameRequest = (a, b) => !!a && a.canvas === b.canvas && a.page === b.page
  && a.scale === b.scale && a.generation === b.generation && a.version === b.version && a.mode === b.mode
  && a.backingWidth === b.backingWidth && a.backingHeight === b.backingHeight && a.backingEpoch === b.backingEpoch
  && a.environmentKey === b.environmentKey;
const renderEnvironmentKey = (canvas, engineSha256, page, pageCount, size, scale, mode) => {
  const view = globalThis.window, nav = view?.navigator ?? globalThis.navigator;
  const dpr = view?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
  if (!engineSha256 || !nav?.userAgent || !Number.isFinite(dpr) || !Number.isInteger(pageCount) || pageCount <= 0
      || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)) return null;
  let context, attrs;
  try {
    context = canvas.getContext?.('2d');
    if (!context) return null;
    attrs = context.getContextAttributes?.() ?? null;
  } catch { return null; }
  const screen = view?.screen ?? globalThis.screen;
  return JSON.stringify({
    engineSha256, userAgent:nav.userAgent, platform:nav.platform ?? '', language:nav.language ?? '',
    devicePixelRatio:dpr, colorDepth:screen?.colorDepth ?? null,
    contextAttributes:attrs ? [attrs.alpha ?? null,attrs.colorSpace ?? null,attrs.desynchronized ?? null,attrs.willReadFrequently ?? null] : 'unavailable',
    profile:'Screen', page,pageCount,pageWidth:size.width,pageHeight:size.height,scale,mode,
    backingWidth:canvas.width,backingHeight:canvas.height,
  });
};
// Keep ownership across adapter/module instances in this realm. Canvas dimensions
// and object identity are checked too; arbitrary external pixel writes cannot be observed.
const ownershipKey = Symbol.for('geul.rhwp.render-ownership.v1');
const renderOwnership = globalThis[ownershipKey] ??= {
  owners: new WeakMap(), epochs: new WeakMap(), backingEpochs: new WeakMap(), trackedBackings: new WeakSet(),
};
renderOwnership.uncertainOwners ??= new WeakMap();
const bumpBackingEpoch = canvas => {
  const epoch = (renderOwnership.backingEpochs.get(canvas) ?? 0) + 1;
  renderOwnership.backingEpochs.set(canvas, epoch);
  return epoch;
};
const inheritedDescriptor = (object, key) => {
  for (let prototype = Object.getPrototypeOf(object); prototype; prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) return descriptor;
  }
  return null;
};
const trackCanvasBackingStore = canvas => {
  if (renderOwnership.trackedBackings.has(canvas)) return true;
  const properties = ['width','height'].map(key => {
    const own = Object.getOwnPropertyDescriptor(canvas, key);
    if (own && !own.configurable) return null;
    const source = own ?? inheritedDescriptor(canvas, key);
    if (!source) return null;
    if (source.get && source.set) return { key, own, get:() => source.get.call(canvas), set:value => source.set.call(canvas, value) };
    if (own && Object.prototype.hasOwnProperty.call(own, 'value')) {
      let current = own.value;
      return { key, own, get:() => current, set:value => {
        if (!own.writable) throw new TypeError(`Canvas ${key} is read-only`);
        current = value;
      } };
    }
    return null;
  });
  if (properties.some(property => !property)) return false;
  const installed = [];
  try {
    for (const property of properties) {
      Object.defineProperty(canvas, property.key, {
        configurable:true, enumerable:property.own?.enumerable ?? true,
        get:property.get,
        set(value) { property.set(value); bumpBackingEpoch(canvas); },
      });
      installed.push(property);
    }
    renderOwnership.trackedBackings.add(canvas);
    if (!renderOwnership.backingEpochs.has(canvas)) renderOwnership.backingEpochs.set(canvas, 0);
    return true;
  } catch {
    for (const property of installed.reverse()) {
      if (property.own) Object.defineProperty(canvas, property.key, property.own);
      else delete canvas[property.key];
    }
    return false;
  }
};
const adapterToken = Symbol('rhwp-render-adapter');
const bumpCanvasEpoch = canvas => {
  const epoch = (renderOwnership.epochs.get(canvas) ?? 0) + 1;
  renderOwnership.epochs.set(canvas, epoch);
  return epoch;
};
const hasEngineJobToken = frame => {
  try { return frame?.canvas?.__rhwpExperimentalRenderJob === frame.id; }
  catch { return false; }
};
const ownsFrame = frame => {
  const owner = frame?.ownership, canvas = frame?.canvas;
  return !!owner && !!canvas && renderOwnership.owners.get(canvas) === owner
    && renderOwnership.epochs.get(canvas) === owner.epoch
    && owner.adapter === adapterToken && owner.canvas === canvas
    && owner.session === frame.sessionId && owner.sessionToken === frame.sessionToken
    && hasEngineJobToken(frame)
    && owner.document === frame.ownerDocument && owner.documentId === frame.traceDocument
    && owner.jobId === frame.id && owner.page === frame.page && owner.scale === frame.scale
    && owner.generation === frame.generation && owner.version === frame.version
    && owner.backingWidth === frame.backingWidth && owner.backingHeight === frame.backingHeight
    && owner.backingEpoch === frame.backingEpoch
    && owner.backingEpoch === renderOwnership.backingEpochs.get(canvas)
    && owner.backingWidth === canvas.width && owner.backingHeight === canvas.height
    && canvas.isConnected;
};
const MAX_SESSIONS = 8, MAX_QUEUE = 256, MAX_POLLS = 512;
const MAX_SUMMARIES = 64, MAX_SUMMARY_UNITS = 262144, MAX_SUMMARY_TOTAL_UNITS = 8 * MAX_SUMMARY_UNITS;
const subscribers = new Set();
const sessions = new Set();
const counters = { completed: 0, canceled: 0, errors: 0, limits: 0, notifications: 0, polls: 0, staleDropped: 0, reused: 0, replacements: 0, fullJobs: 0, fullJobElapsedMs: 0, fullJobMaxMs: 0, patchJobs: 0, regionalPatchJobs: 0, wholePagePatchJobs: 0, unchangedFrames: 0, identityFramesSupported: 0, identityFramesUnsupported: 0, identityComputations: 0, identityComputeMs: 0, identityMaxComputeMs: 0, identityUnsupported: 0, identityFailures: 0, identityMismatches: 0, identityReuses: 0, identityJobsSkipped: 0 };
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
    if (window.__GEUL_T010_PAGE_IDENTITY_POC__ === true) {
      if (typeof engine.setRendererPageIdentityEnabled !== 'function') throw new Error('experimental page-identity metadata API unavailable');
      engine.setRendererPageIdentityEnabled(true);
    }
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
  let renderFault = null, freeUncertain = false;
  const uncertainJobs = new Set(), uncertainCanvases = new Map(), subscriptions = new Set();
  // Attempt independent cleanup even after failure. Preserve the original exception
  // (and every secondary exception) rather than claiming successful resource release.
  const cleanup = steps => {
    const errors = [];
    for (const step of steps) { try { step(); } catch (error) { errors.push(error); } }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'render cleanup failed', {cause:errors[0]});
  };
  const failClosed = error => { renderFault ??= error; unsubscribe(); };
  const sessionToken = Symbol(`rhwp-session-${sessionId}`);
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
  const releaseOwnership = ownership => {
    if (ownership && renderOwnership.owners.get(ownership.canvas) === ownership) {
      renderOwnership.owners.delete(ownership.canvas);
      bumpCanvasEpoch(ownership.canvas);
    }
  };
  const invalidateCanvas = (canvas, rejectedOwner) => {
    const current = renderOwnership.owners.get(canvas);
    renderOwnership.owners.delete(canvas);
    bumpCanvasEpoch(canvas);
    if (current && current !== rejectedOwner) {
      try { current.onCanvasInvalidated?.(); } catch { /* invalidation must not claim a valid frame */ }
    }
  };
  const completionFailure = request => {
    if (!request.canvas.isConnected) return 'canvas-disconnected';
    const owner = renderOwnership.owners.get(request.canvas);
    if (owner !== request.ownership || renderOwnership.epochs.get(request.canvas) !== request.ownership?.epoch) return 'canvas-owner-changed';
    if (!hasEngineJobToken(request)) return 'render-owner-changed';
    return 'canvas-backing-store-changed';
  };
  const unsubscribe = () => subscribers.delete(pump);
  const stopActive = reason => {
    const request = active;
    active = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!request) return;
    try {
      const state = request.ownerDocument.cancelRenderJob(request.id);
      if (!['CANCELED','COMPLETE','ERROR','RESOURCE_LIMIT'].includes(state)) throw new Error('render cancellation unconfirmed');
      trace('cancel', request, {job:request.id, reason}); counters.canceled++;
    } catch (error) {
      uncertainJobs.add(request.id);
      const owners = renderOwnership.uncertainOwners.get(request.canvas) ?? new Set();
      owners.add(request.ownership);renderOwnership.uncertainOwners.set(request.canvas,owners);
      uncertainCanvases.set(request.canvas,request.ownership);
      failClosed(error); counters.errors++;
      trace('cancel-failed', request, {job:request.id, reason});
      // The engine may still write after failed cancellation. Revoke foreign proofs too.
      invalidateCanvas(request.canvas, request.ownership);
      throw error;
    } finally { releaseOwnership(request.ownership); }
  };
  const clearRequests = keepPainted => {
    for (const request of queue.values()) trace('stale-drop', request, {reason:'session-cancel'});
    queue.clear(); failed.clear();
    if (!keepPainted || renderFault) { for (const frame of painted.values()) releaseOwnership(frame.ownership); painted.clear(); }
  };
  const cancel = (keepPainted = false) => {
    try { stopActive('session-cancel'); }
    finally { clearRequests(keepPainted); }
  };
  const session = new Session(sessionId, backend, registry, async () => {
    const engine = await module();
    const memory = wasmMemory;
    return { ...(memory ? { memoryBytes: () => memory.buffer.byteLength } : {}), openDocument(bytes) {
      // Save validation reopens are independent read-only handles, never replace
      // this session's authoritative live document or listener registration.
      if (renderFault) throw renderFault;
      if (doc) return new engine.HwpDocument(bytes);
      cancel(); generation++;
      if (disposed || subscribers.size >= MAX_SESSIONS) throw new Error('RESOURCE_LIMIT: PoC sessions');
      doc = new engine.HwpDocument(bytes); documentId++;
      // Snapshot restoration cancels pending jobs but retains completed Canvas
      // ownership. Only the separate exact image-page identity can cross the new
      // revision; text, tables, changed geometry and unsupported paint still use Full.
      const restore = doc.restoreSnapshot?.bind(doc);
      if (restore) doc.restoreSnapshot = (...args) => { cancel(true); return restore(...args); };
      const opened = doc, openedDocumentId = documentId, free = doc.free.bind(doc);
      let freeAttempted = false, freeError = null;
      doc.free = () => {
        if (freeAttempted) { if (freeError) throw freeError; return; }
        freeAttempted = true;
        trace('release-requested', null, {reason:'document-free',document:openedDocumentId});
        try {
          cleanup([
            () => { if (doc === opened) cancel(); },
            () => { if (doc === opened) { generation++; unsubscribe(); sessions.delete(handle); doc = null; } },
            () => {
              try {
                free(); uncertainJobs.clear();
                for (const [canvas,owner] of uncertainCanvases) {
                  const owners = renderOwnership.uncertainOwners.get(canvas);owners?.delete(owner);
                  if (!owners?.size) renderOwnership.uncertainOwners.delete(canvas);
                }
                uncertainCanvases.clear();wake();
              }
              catch (error) { freeUncertain = true; failClosed(error); throw error; }
            },
          ]);
          trace('release-completed', null, {reason:'document-free',document:openedDocumentId});
        } catch (error) {
          freeError = error; failClosed(error);
          trace('release-failed', null, {reason:'document-free',document:openedDocumentId}); throw error;
        }
      };
      subscribers.add(pump); sessions.add(handle);
      return doc;
    } };
  });
  const adoptStartupBackingStore = request => {
    const owner = request.ownership;
    if (owner && renderOwnership.owners.get(request.canvas) === owner
        && owner.initialBackingWidth === 0 && owner.initialBackingHeight === 0
        && request.backingWidth === 0 && request.backingHeight === 0
        && request.canvas.width > 0 && request.canvas.height > 0) {
      // A first render can initialize a zero-sized backing store. Once initialized,
      // every later resize invalidates the proof and requires a fresh request.
      owner.backingWidth = request.backingWidth = request.canvas.width;
      owner.backingHeight = request.backingHeight = request.canvas.height;
      owner.backingEpoch = request.backingEpoch = renderOwnership.backingEpochs.get(request.canvas);
    }
  };
  const valid = request => {
    adoptStartupBackingStore(request);
    return !disposed && !renderFault && !renderOwnership.uncertainOwners.has(request.canvas) && doc && request.generation === generation
    && request.version === session.modelVersion && request.canvas.isConnected
    && request.backingWidth === request.canvas.width && request.backingHeight === request.canvas.height
    && request.backingEpoch === renderOwnership.backingEpochs.get(request.canvas)
    && session.status.kind === 'ready';
  };
  const visible = request => {
    const box = request.canvas.getBoundingClientRect();
    const view = request.canvas.closest?.('.editor__scroll')?.getBoundingClientRect();
    return box.bottom > Math.max(0, view?.top ?? 0) && box.top < Math.min(innerHeight, view?.bottom ?? innerHeight)
      && (!view || (box.right > view.left && box.left < view.right));
  };
  const createRequest = (page, canvas, scale, mode, input = null) => {
    let pageCount = 0, pageSize = null;
    try { pageCount = session.pages?.length ?? 0; const size = session.pages?.[page]; pageSize = size ? {width:size.width,height:size.height} : null; } catch { /* unknown geometry fails reuse closed */ }
    const engineSha256 = globalThis.window?.__geulOwnership?.identity?.wasmSha256 ?? null;
    return {page,canvas,scale,mode,generation,version:session.modelVersion,
      backingWidth:canvas.width,backingHeight:canvas.height,backingEpoch:renderOwnership.backingEpochs.get(canvas) ?? 0,
      pageCount,pageSize,engineSha256,environmentKey:renderEnvironmentKey(canvas,engineSha256,page,pageCount,pageSize,scale,mode),
      traceDocument:documentId,traceRequest:++nextRequest,traceInput:input};
  };
  const repairInvalidatedCanvas = ownership => {
    const canvas = ownership.canvas;
    const currentActive = active?.ownership === ownership ? active : null;
    const currentQueued = queue.get(canvas);
    const currentFrame = painted.get(canvas)?.ownership === ownership ? painted.get(canvas) : null;
    const desired = currentActive ?? currentQueued ?? canvases.get(canvas) ?? currentFrame;
    if (!desired || disposed || renderFault || doc !== ownership.document || generation !== ownership.generation) return;
    // Remove both queued and completed proofs before a cancellation can throw.
    if (currentQueued) trace('stale-drop', currentQueued, {reason:'canvas-owner-invalidated'});
    queue.delete(canvas); painted.delete(canvas);
    if (currentActive) {
      try { stopActive('canvas-owner-invalidated'); }
      catch {
        clearRequests(false);
        failed.set(canvas, {...desired, summary:null, summaryUnits:0});
        return; // cancel-failed + renderFault exposes failure; no retry or valid frame.
      }
    }
    const next = createRequest(desired.page, canvas, desired.scale, 'full');
    failed.delete(canvas);
    canvases.set(canvas, next); queue.set(canvas, next);
    trace('request', next, {reason:'canvas-owner-invalidated', relatedRequest:desired.traceRequest});
    trace('queue', next, {reason:'canvas-owner-invalidated'});
    wake();
  };
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
  function pump(synchronousRequest = null) {
    if (disposed || renderFault || !doc) return;
    if (active && !valid(active)) {
      try { stopActive('stale'); }
      catch { clearRequests(false); return; }
      counters.staleDropped++; wake();
    }
    for (const [canvas, request] of queue) if (!valid(request)) { queue.delete(canvas); trace('stale-drop', request, {reason:'invalid-queue'}); counters.staleDropped++; }
    if (!active) {
      const requests = [...queue.values()].sort((a, b) => Number(visible(b)) - Number(visible(a)));
      const request = requests[0];
      if (!request) return;
      queue.delete(request.canvas);
      let startAttempted = false, ownership = null;
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
            painted.set(request.canvas, {...request, id:previous.id, ownership:previous.ownership,
              ownerDocument:previous.ownerDocument, sessionId:previous.sessionId,
              summary:bounded, summaryUnits:bounded ? summaryUnits : 0, width:request.canvas.width, height:request.canvas.height});
            trimSummaries();
            trace('reuse-complete', request, {reason:'unchanged-summary', relatedRequest:previous.traceRequest});
            counters.unchangedFrames++; queueMicrotask(() => { if (!disposed) for (const listener of listeners) listener(); }); wake(); return;
          }
          // Actual native integer and fractional regional replay differed from Full.
          // Only identical paint input can be skipped; every changed page uses Full.
        }
        startAttempted = true;
        ownership = {
          token: Symbol('canvas-render-owner'), adapter: adapterToken, session: sessionId, sessionToken,
          canvas: request.canvas, document: doc, documentId: request.traceDocument, page: request.page,
          scale: request.scale, generation: request.generation, version: request.version,
          backingWidth: request.backingWidth, backingHeight: request.backingHeight,
          backingEpoch:request.backingEpoch,
          initialBackingWidth:request.backingWidth, initialBackingHeight:request.backingHeight,
          epoch: bumpCanvasEpoch(request.canvas), jobId: null,
          onCanvasInvalidated: null,
        };
        ownership.onCanvasInvalidated = () => repairInvalidatedCanvas(ownership);
        renderOwnership.owners.set(request.canvas, ownership);
        // Advisory scalar hint for isolated engines that support visible-resource
        // cache preference. It conveys no frame identity or publication authority.
        // Older pinned/candidate engines ignore it and take the same Full path.
        try { request.canvas.__geulExperimentalVisibleRender = request.page === session.caretRect?.()?.page || visible(request); }
        catch { /* a non-extensible Canvas simply gets ordinary cache preference */ }
        const id = doc.beginRenderJob(request.page, request.canvas, request.scale);
        ownership.jobId = id;
        adoptStartupBackingStore(request);
        trace('job-start', request, {job:id});
        counters.fullJobs++;
        active = { ...request, ownerDocument:doc, sessionId, sessionToken, ownership,
          summary:bounded, summaryUnits:bounded ? summaryUnits : 0, id, polls: 0, startedAt:performance.now() };
      }
      catch (error) {
        if (startAttempted) releaseOwnership(ownership);
        trace(startAttempted ? 'job-start-failed' : 'prepare-failed', request); failed.set(request.canvas, request); counters.limits++; wake(); return;
      }
    }
    const request = active;
    const backingBeforePoll = { width:request.canvas.width, height:request.canvas.height,
      epoch:renderOwnership.backingEpochs.get(request.canvas) };
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
      if (renderOwnership.owners.get(request.canvas) === request.ownership && hasEngineJobToken(request)) {
        // The engine atomically publishes the completed frame inside this synchronous poll.
        // Record its new bitmap epoch only while this exact engine job still owns the Canvas.
        const changedInPoll = backingBeforePoll.width !== request.canvas.width
          || backingBeforePoll.height !== request.canvas.height
          || backingBeforePoll.epoch !== renderOwnership.backingEpochs.get(request.canvas);
        if (changedInPoll) {
          request.backingWidth = request.ownership.backingWidth = request.canvas.width;
          request.backingHeight = request.ownership.backingHeight = request.canvas.height;
          request.backingEpoch = request.ownership.backingEpoch = renderOwnership.backingEpochs.get(request.canvas);
        }
      }
      adoptStartupBackingStore(request);
      if (!ownsFrame(request)) {
        const reason = completionFailure(request);
        // A late completion may have written over the newer owner's pixels. Invalidate
        // every proof for this backing store and require a fresh Full render.
        invalidateCanvas(request.canvas, request.ownership);
        trace('completion-rejected', request, {job:request.id, state, reason});
        failed.set(request.canvas, {...request, summary:null, summaryUnits:0});
        counters.staleDropped++;
        active = null;
        wake();
        return;
      }
      // Keep repaint/cancel recovery pointed at the backing store the verified
      // completion actually published (startup may have begun at 0x0).
      request.environmentKey = renderEnvironmentKey(request.canvas,request.engineSha256,request.page,request.pageCount,request.pageSize,request.scale,request.mode);
      canvases.set(request.canvas, request);
      trace('complete', request, {job:request.id, state});
      const elapsed = performance.now() - request.startedAt;
      counters.fullJobElapsedMs += elapsed;
      counters.fullJobMaxMs = Math.max(counters.fullJobMaxMs,elapsed);
      let renderIdentity = null;
      try { renderIdentity = doc.renderJobIdentity?.(request.id) ?? null; }
      catch { counters.identityFailures++; }
      if (request.preflightIdentityComputed && request.preflightIdentity !== renderIdentity) {
        counters.identityMismatches++;renderIdentity = null;
      }
      request.pageIdentity = renderIdentity;
      request.identityJobId = renderIdentity ? request.id : null;
      counters[renderIdentity ? 'identityFramesSupported' : 'identityFramesUnsupported']++;
      counters.completed++;
      painted.delete(request.canvas);
      painted.set(request.canvas, {...request, width:request.canvas.width, height:request.canvas.height});
      // Serialized UTF-16 code units, not an actual JS-object or RSS byte certificate.
      trimSummaries();
      const firstPaintChanged = request.page === 0 && session.firstPaintMs === null;
      if (firstPaintChanged) session.firstPaintMs = performance.now() - session.loadStartedAt;
      // 같은 요청의 동기 완료는 renderPage 반환값으로 전달한다. 첫 paint와
      // 실제 비동기 완료는 상태를 갱신할 구독 알림을 계속 보낸다.
      if (firstPaintChanged || synchronousRequest?.traceRequest !== request.traceRequest) {
        queueMicrotask(() => { if (!disposed) for(const listener of listeners)listener(); });
      }
    }
    else {
      try { stopActive('terminal-'+state); }
      catch { clearRequests(false); return; }
      if (state !== 'CANCELED') { failed.set(request.canvas, {...request, summary:null, summaryUnits:0}); counters[state === 'RESOURCE_LIMIT' ? 'limits' : 'errors']++; }
    }
    active = null;
    wake(); // released capacity may unblock a different live session
  }
  const originalRelease = session.releaseRendering.bind(session), originalDispose = session.dispose.bind(session), originalSubscribe = session.subscribe.bind(session);
  session.subscribe = listener => {
    if(listeners.size >= 16)throw new Error('RESOURCE_LIMIT: PoC subscriptions');
    if (disposed) throw new Error('render session disposed');
    const off=originalSubscribe(listener);listeners.add(listener);
    const unsubscribeListener = () => { if (!subscriptions.delete(unsubscribeListener)) return;listeners.delete(listener);off(); };
    subscriptions.add(unsubscribeListener);return unsubscribeListener;
  };
  session.renderPage = (page, canvas, scale) => {
    if (disposed || renderFault || renderOwnership.uncertainOwners.has(canvas) || !doc || !canvas.isConnected || !session.prepareRendering(scale)) return false;
    if (!trackCanvasBackingStore(canvas)) { counters.errors++; return false; }
    const mode = typeof __T010_DAMAGE__ !== 'undefined' && __T010_DAMAGE__ ? 'damage' : 'full';
    const request = createRequest(page, canvas, scale, mode, globalThis.window?.__d4LifecycleInput ?? null);
    if (globalThis.window?.__GEUL_T010_PAGE_IDENTITY_POC__ === true) {
      globalThis.window.__GEUL_T010_LAST_RENDER_ENV_KEY__ = request.environmentKey;
      const moduleWindow = globalThis.window;
      const directWindow = typeof window === 'undefined' ? null : window;
      const ownDpr = directWindow ? Object.getOwnPropertyDescriptor(directWindow, 'devicePixelRatio') : null;
      globalThis.window.__GEUL_T010_LAST_RENDER_ENV_DIAGNOSTIC__ = {
        moduleWindowDpr:moduleWindow?.devicePixelRatio ?? null,
        moduleGlobalDpr:globalThis.devicePixelRatio ?? null,
        directWindowDpr:directWindow?.devicePixelRatio ?? null,
        sameWindow:directWindow === moduleWindow,
        ownDprValue:ownDpr && Object.hasOwn(ownDpr, 'value') ? ownDpr.value : null,
        ownDprGetter:typeof ownDpr?.get === 'function',
      };
    }
    trace('request', request, {reason:'renderPage'});
    const complete = painted.get(canvas);
    if (active && active.version !== session.modelVersion) {
      try { cancel(true); } catch (error) { trace('request-failed', request, {reason:'cancel-failed'});throw error; }
    }
    if (sameRequest(complete, request) && ownsFrame(complete) && complete.width === canvas.width && complete.height === canvas.height
        && complete.environmentKey !== null && complete.environmentKey === request.environmentKey) {
      canvases.set(canvas,request);trace('reuse-complete', request, {relatedRequest:complete.traceRequest});return true;
    }
    if (sameRequest(active, request) || sameRequest(queue.get(canvas), request)) { const matched = sameRequest(active, request) ? active : queue.get(canvas); trace('reuse-pending', request, {job:matched.id ?? null, relatedRequest:matched.traceRequest}); counters.reused++; return false; }
    const identityOwnerMatches = !!complete && !!complete.pageIdentity && complete.identityJobId === complete.id
      && complete.environmentKey !== null && complete.environmentKey === request.environmentKey
      && complete.canvas === canvas && complete.page === page && complete.scale === scale
      && complete.generation === generation && complete.version !== request.version
      && complete.mode === 'full' && request.mode === 'full'
      && complete.backingWidth === request.backingWidth && complete.backingHeight === request.backingHeight
      && complete.backingEpoch === request.backingEpoch && complete.ownerDocument === doc
      && complete.sessionId === sessionId && complete.sessionToken === sessionToken
      && complete.traceDocument === documentId && ownsFrame(complete)
      && typeof doc.geulExperimentalImagePageIdentity === 'function';
    if (identityOwnerMatches && complete.reusedModelVersion === request.version
        && complete.reusedPageIdentity === complete.pageIdentity && ownsFrame(complete)) {
      canvases.set(canvas,request);return true;
    }
    if (identityOwnerMatches) {
      const started = performance.now();let identity = null;
      try { identity = doc.geulExperimentalImagePageIdentity(page) ?? null; }
      catch { counters.identityFailures++; }
      const elapsed = performance.now() - started;
      counters.identityComputations++;counters.identityComputeMs += elapsed;
      counters.identityMaxComputeMs = Math.max(counters.identityMaxComputeMs,elapsed);
      request.preflightIdentityComputed = true;request.preflightIdentity = identity;
      if (!identity) counters.identityUnsupported++;
      if (identity && identity === complete.pageIdentity && ownsFrame(complete) && complete.environmentKey === request.environmentKey) {
        complete.reusedModelVersion = request.version;complete.reusedPageIdentity = identity;
        canvases.set(canvas,request);counters.identityReuses++;counters.identityJobsSkipped++;
        trace('reuse-complete', request, {reason:'exact-image-page-identity',relatedRequest:complete.traceRequest});
        return true;
      }
    }
    const previous = failed.get(canvas);
    if (sameRequest(previous, request)) return false;
    failed.delete(canvas);
    if (!canvases.has(canvas) && canvases.size >= MAX_QUEUE) { counters.limits++; return false; }
    if (active?.canvas === canvas) {
      try { stopActive('replacement'); counters.replacements++; }
      catch (error) { clearRequests(false);trace('request-failed', request, {reason:'cancel-failed'});throw error; }
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
        && complete.height === canvas.height && canvas.width > 0 && canvas.height > 0) pump(request);
    const result = painted.get(canvas);
    // Full은 backing을 원자적으로 교체할 수 있다. 입력 시점 epoch가 아니라
    // 이 요청이 완료한 현재 프레임의 유효성·소유권을 확인한다.
    return !queue.has(canvas) && result?.traceRequest === request.traceRequest
      && valid(result) && ownsFrame(result) && result.width === canvas.width && result.height === canvas.height;
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
      cleanup([
        () => cancel(),
        () => { try { cleanup([...canvases.keys()].map(canvas => () => { canvas.width = 0; canvas.height = 0; })); } finally { canvases.clear(); } },
        () => originalRelease(),
      ]);
      trace('release-completed', null, {reason:'releaseRendering'});
    } catch (error) { failClosed(error); trace('release-failed', null, {reason:'releaseRendering'}); throw error; }
  };
  const handle = { cancel, repeat: count => { for(let n=0;n<Math.min(count,100);n++) for(const request of canvases.values()) session.renderPage(request.page,request.canvas,request.scale); }, repaint: () => {
    if (disposed || renderFault || !doc) return;
    for(const [canvas, request] of canvases) if(canvas.isConnected) {
      const next = createRequest(request.page,canvas,request.scale,'full');
      painted.delete(canvas);canvases.set(canvas,next);
      trace('request',next,{reason:'explicit-repaint',relatedRequest:request.traceRequest});
      const displaced=queue.get(canvas);if(displaced)trace('stale-drop',displaced,{reason:'explicit-repaint'});
      queue.set(canvas,next);trace('queue',next,{reason:'explicit-repaint'});
    }
    wake();
  }, stats: () => ({ sessionId, generation, queued: queue.size, active: active ? 1 : 0, activeJobId: active?.id ?? null,
    disposed, subscribed:subscribers.has(pump), listeners:listeners.size, renderFault:renderFault !== null, uncertainJobs:uncertainJobs.size, freeUncertain,
    canvases: canvases.size, summaries: [...painted.values()].filter(r=>r.summary).length, maxSummaries:MAX_SUMMARIES, summaryCodeUnits:[...painted.values()].reduce((sum,r)=>sum+(r.summary ? r.summaryUnits : 0),0), maxSummaryTotalCodeUnits:MAX_SUMMARY_TOTAL_UNITS, maxSummaryBytes:MAX_SUMMARY_UNITS /* legacy diagnostic name: serialized UTF-16 code units */, failures: failed.size, modelVersion: session.modelVersion }) };
  session.dispose = () => {
    if (disposed) return;
    disposed = true;unsubscribe();sessions.delete(handle);
    trace('release-requested', null, {reason:'dispose'});
    try {
      cleanup([
        () => cancel(),
        () => originalDispose(),
        () => { if (doc) doc.free(); },
        () => { try { cleanup([...subscriptions]); } finally { listeners.clear();canvases.clear(); } },
      ]);
      trace('release-completed', null, {reason:'dispose'});
    } catch (error) { failClosed(error);trace('release-failed', null, {reason:'dispose'});throw error; }
  };
  return session;
}
