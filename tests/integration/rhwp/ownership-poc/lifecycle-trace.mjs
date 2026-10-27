// Diagnostic-only collector: one JS realm, performance.now() milliseconds since timeOrigin.
// Never retains DOM, document, event, or pixel objects. Overflow makes evidence incomplete.
export function createLifecycleTrace(limit = 4096) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new RangeError('invalid trace limit');
  const records = []; let dropped = 0, invalid = 0, sequence = 0;
  return {
    record(row) {
      if (records.length >= limit) { dropped++; return; }
      const allowed = ['event','at','session','document','request','input','page','canvas','scale','generation','version','mode','job','state','reason','relatedRequest'];
      const item = {sequence: ++sequence};
      for (const key of allowed) {
        const value = row[key];
        if (value === undefined) continue;
        if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) { invalid++; throw new TypeError('invalid trace field'); }
        item[key] = value;
      }
      records.push(item);
    },
    requireComplete() { if (dropped || invalid) throw new Error('incomplete lifecycle trace'); return this.snapshot(); },
    snapshot() { return {clock: 'performance.now', timeOrigin: performance.timeOrigin, units: 'ms', limit, dropped, invalid, complete: dropped === 0 && invalid === 0, records: records.map(row => ({...row}))}; },
  };
}

// The input token covers only synchronous dispatch and its microtask checkpoint.
// Requests later in RAF/tasks deliberately carry null: timing proximity is not causation.
export function installLifecycleTrace(target = window, limit = 4096) {
  if (target.__d4LifecycleTrace) throw new Error('trace already installed');
  const trace = createLifecycleTrace(limit); let input = 0;
  const onInput = event => {
    if (!event.target?.classList?.contains('rhwp-input')) return;
    const id = ++input; target.__d4LifecycleInput = id;
    trace.record({event:'input', at:performance.now(), input:id});
    queueMicrotask(() => { if (target.__d4LifecycleInput === id) target.__d4LifecycleInput = null; });
  };
  target.__d4LifecycleTrace = trace; target.document.addEventListener('input', onInput, true);
  return { snapshot: () => trace.snapshot(), stop() {
    target.document.removeEventListener('input', onInput, true);
    if (target.__d4LifecycleTrace === trace) delete target.__d4LifecycleTrace;
    delete target.__d4LifecycleInput;
  } };
}
