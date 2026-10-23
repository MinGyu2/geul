// Test-only adapter for the real RhwpEditorSession and its sole WASM document.
// No document bytes, text, secondary editable model or history are retained here.
const sameRequest = (a, b) => !!a && a.canvas === b.canvas && a.page === b.page
  && a.scale === b.scale && a.generation === b.generation && a.version === b.version;
const MAX_SESSIONS = 8, MAX_QUEUE = 256, MAX_POLLS = 512;
const subscribers = new Set();
const sessions = new Set();
const counters = { completed: 0, canceled: 0, errors: 0, limits: 0, notifications: 0, polls: 0, staleDropped: 0, reused: 0, replacements: 0 };
let scheduled = false, loading, probeListener = null;
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
    await engine.default({ module_or_path: bytes });
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
  let doc = null, generation = 0, active = null, timer = null, disposed = false;
  const queue = new Map(), canvases = new Map(), failed = new Map(), painted = new Map(), listeners = new Set();
  const unsubscribe = () => subscribers.delete(pump);
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (active && doc) { doc.cancelRenderJob(active.id); counters.canceled++; }
    active = null; queue.clear(); failed.clear(); painted.clear();
  };
  const session = new Session(sessionId, backend, registry, async () => {
    const engine = await module();
    return { openDocument(bytes) {
      // Save validation reopens are independent read-only handles, never replace
      // this session's authoritative live document or listener registration.
      if (doc) return new engine.HwpDocument(bytes);
      cancel(); generation++;
      if (disposed || subscribers.size >= MAX_SESSIONS) throw new Error('RESOURCE_LIMIT: PoC sessions');
      doc = new engine.HwpDocument(bytes);
      const opened = doc, free = doc.free.bind(doc);
      doc.free = () => {
        if (doc === opened) { cancel(); generation++; unsubscribe(); sessions.delete(handle); doc = null; }
        free();
      };
      subscribers.add(pump); sessions.add(handle);
      return doc;
    } };
  });
  const valid = request => !disposed && doc && request.generation === generation
    && request.version === session.modelVersion && request.canvas.isConnected && session.status.kind === 'ready';
  const visible = request => { const box = request.canvas.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight; };
  function pump() {
    if (disposed || !doc) return;
    if (active && !valid(active)) { doc.cancelRenderJob(active.id); counters.staleDropped++; active = null; if(timer!==null)clearTimeout(timer);timer=null; wake(); }
    for (const [canvas, request] of queue) if (!valid(request)) { queue.delete(canvas); counters.staleDropped++; }
    if (!active) {
      const requests = [...queue.values()].sort((a, b) => Number(visible(b)) - Number(visible(a)));
      const request = requests[0];
      if (!request) return;
      queue.delete(request.canvas);
      try { active = { ...request, id: doc.beginRenderJob(request.page, request.canvas, request.scale), polls: 0 }; }
      catch (error) { failed.set(request.canvas, request); counters.limits++; wake(); return; }
    }
    const request = active;
    let state;
    try { state = ++request.polls > MAX_POLLS ? 'RESOURCE_LIMIT' : doc.pollRenderJob(request.id); }
    catch { state = 'ERROR'; }
    counters.polls++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (state === 'PENDING') {
      // No RAF retry loop: completion notification or the bounded deadline wakes us.
      timer = setTimeout(() => { timer = null; wake(); }, 15250);
      return;
    }
    if (state === 'COMPLETE') {
      counters.completed++;
      painted.set(request.canvas, request);
      if (request.page === 0 && session.firstPaintMs === null) session.firstPaintMs = performance.now() - session.loadStartedAt;
      queueMicrotask(() => { if (!disposed) for(const listener of listeners)listener(); });
    }
    else {
      doc.cancelRenderJob(request.id);
      if (state === 'CANCELED') counters.canceled++;
      else { failed.set(request.canvas, request); counters[state === 'RESOURCE_LIMIT' ? 'limits' : 'errors']++; }
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
    if (disposed || !doc || !session.prepareRendering(scale)) return false;
    const request = { page, canvas, scale, generation, version: session.modelVersion };
    const complete = painted.get(canvas);
    if (sameRequest(complete, request)) return true;
    if (sameRequest(active, request) || sameRequest(queue.get(canvas), request)) { counters.reused++; return false; }
    if (active && active.version !== session.modelVersion) cancel();
    const previous = failed.get(canvas);
    if (sameRequest(previous, request)) return false;
    failed.delete(canvas);
    if (!canvases.has(canvas) && canvases.size >= MAX_QUEUE) { counters.limits++; return false; }
    if (active?.canvas === canvas) {
      doc.cancelRenderJob(active.id); counters.canceled++; counters.replacements++; active = null;
      if (timer !== null) clearTimeout(timer); timer = null;
    }
    queue.set(canvas, request); canvases.set(canvas, request); wake();
    return false; // a queued frame is never reported as completed
  };
  const renderRequest = session.renderPage;
  session.renderPage = (...args) => {
    const at = performance.now();
    try { return renderRequest(...args); }
    finally { globalThis.window?.__rhwpProbe?.record?.('adapterRenderRequest', at); }
  };
  session.releaseRendering = () => {
    cancel();
    for (const canvas of canvases.keys()) { canvas.width = 0; canvas.height = 0; }
    canvases.clear(); originalRelease();
  };
  const handle = { cancel, repeat: count => { for(let n=0;n<Math.min(count,100);n++) for(const request of canvases.values()) session.renderPage(request.page,request.canvas,request.scale); }, repaint: () => { for(const [canvas, request] of canvases) { if(canvas.isConnected)queue.set(canvas,{...request,generation,version:session.modelVersion}); } }, stats: () => ({ sessionId, generation, queued: queue.size, active: active ? 1 : 0, activeJobId: active?.id ?? null,
    canvases: canvases.size, failures: failed.size, modelVersion: session.modelVersion }) };
  session.dispose = () => { if (disposed) return; cancel(); unsubscribe(); disposed = true; sessions.delete(handle); originalDispose(); };
  return session;
}
