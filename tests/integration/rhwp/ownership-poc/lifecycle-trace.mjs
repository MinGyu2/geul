// Diagnostic-only: limits measure JSON UTF-16 code units, not heap/RSS or UTF-8 bytes.
const MAX_STRING = 128, MAX_RECORD = 2048, MAX_TOTAL = 1048576;
const FIELDS = ['event','at','session','document','request','input','page','canvas','scale','generation','version','mode','job','state','reason','relatedRequest'];
const EVENTS = new Set(['input','request','queue','reuse-pending','reuse-complete','job-start','job-start-failed','prepare-failed','request-failed','poll','complete','completion-rejected','cancel','cancel-failed','stale-drop','release-requested','release-completed','release-failed']);
const REQUEST_EVENTS = new Set(['request','queue','reuse-pending','reuse-complete','job-start','job-start-failed','prepare-failed','request-failed','poll','complete','completion-rejected','cancel','cancel-failed','stale-drop']);
const JOB_EVENTS = new Set(['job-start','poll','complete','completion-rejected','cancel','cancel-failed']);

function validateLifecycle(records, terminal) {
  if (!records.length) return 'INCOMPLETE';
  const requests = new Map(), identities = new Map(), jobs = new Map(), releases = new Set(), releaseFinished = new Set(), polled = new Map(); let incomplete = false, invalid = false, last = -Infinity;
  const key = r => JSON.stringify([r.session,r.document,r.request]);
  for (const r of records) {
    if (r.at < last) invalid = true; last = r.at;
    if (r.event.startsWith('release-')) {
      const release = JSON.stringify([r.session,r.document,r.reason]);
      if (r.event === 'release-requested') { if (releases.has(release)) invalid = true; releases.add(release); releaseFinished.delete(release); }
      else {
        if (!releases.has(release)) {
          const mismatched = [...releases].some(value => { const [session,,reason] = JSON.parse(value); return session === r.session && reason === r.reason; });
          if (mismatched || releaseFinished.has(release)) invalid = true; else incomplete = true;
        }
        releases.delete(release); releaseFinished.add(release);
      }
      continue;
    }
    if (!REQUEST_EVENTS.has(r.event)) continue;
    const k = key(r), previous = requests.get(k);
    if (r.event === 'request') { if (previous) invalid = true; else { requests.set(k,'request'); identities.set(k,r); } continue; }
    if (!previous) { incomplete = true; continue; }
    if (['page','canvas','scale','generation','version','mode'].some(field => identities.get(k)[field] !== r[field])) invalid = true;
    if (r.event === 'queue') { if (previous !== 'request') invalid = true; else requests.set(k,'queued'); }
    else if (r.event === 'job-start') {
      if (previous !== 'queued') invalid = true;
      const j = JSON.stringify([r.session,r.document,r.job]);
      if (jobs.has(j)) invalid = true; else jobs.set(j,k);
      requests.set(k,'active');
    } else if (r.event === 'poll' || r.event === 'complete' || r.event === 'completion-rejected' || r.event === 'cancel' || r.event === 'cancel-failed') {
      const j = JSON.stringify([r.session,r.document,r.job]);
      if (previous !== 'active') invalid = true;
      else if (!jobs.has(j)) incomplete = true;
      else if (jobs.get(j) !== k) invalid = true;
      if (r.event === 'poll') {
        if (!['PENDING','COMPLETE','ERROR','RESOURCE_LIMIT','CANCELED'].includes(r.state)) invalid = true;
        if (polled.has(k) && polled.get(k) !== 'PENDING') invalid = true;
        polled.set(k,r.state);
      }
      if (r.event === 'complete' && r.state != null && r.state !== 'COMPLETE') invalid = true;
      if ((r.event === 'complete' || r.event === 'completion-rejected') && r.state != null && r.state !== 'COMPLETE') invalid = true;
      if ((r.event === 'complete' || r.event === 'completion-rejected') && !polled.has(k)) incomplete = true;
      else if ((r.event === 'complete' || r.event === 'completion-rejected') && polled.get(k) !== 'COMPLETE') invalid = true;
      if (r.event === 'completion-rejected' && !['canvas-owner-changed','canvas-backing-store-changed','canvas-disconnected','render-owner-changed'].includes(r.reason)) invalid = true;
      if (r.event === 'cancel' && polled.get(k) === 'COMPLETE') invalid = true;
      if (r.event !== 'poll') { jobs.delete(j); requests.set(k,r.event); }
    } else if (r.event === 'request-failed') {
      if (previous !== 'request') invalid = true;requests.set(k,r.event);
    } else if (r.event === 'stale-drop' || r.event === 'job-start-failed' || r.event === 'prepare-failed') {
      if (previous !== 'queued') invalid = true; requests.set(k,r.event);
    } else if (r.event === 'reuse-pending' || r.event === 'reuse-complete') {
      if (previous !== 'request' && !(r.event === 'reuse-complete' && previous === 'queued')) invalid = true;
      const related = JSON.stringify([r.session,r.document,r.relatedRequest]);
      const source = requests.get(related);
      if (!source) incomplete = true;
      else if (r.event === 'reuse-pending' && !['queued','active'].includes(source)) invalid = true;
      else if (r.event === 'reuse-pending' && source === 'active' && polled.has(related) && polled.get(related) !== 'PENDING') invalid = true;
      else if (r.event === 'reuse-complete' && !['complete','reuse-complete'].includes(source)) invalid = true;
      if (source) {
        const sourceIdentity = identities.get(related);
        const fields = ['canvas','page','scale','generation','mode'];
        if (fields.some(field => sourceIdentity[field] !== r[field])) invalid = true;
        if (r.event === 'reuse-pending' && sourceIdentity.version !== r.version) invalid = true;
        if (r.event === 'reuse-complete' && !['unchanged-summary','exact-image-page-identity'].includes(r.reason) && sourceIdentity.version !== r.version) invalid = true;
        if (r.event === 'reuse-complete' && r.reason != null && !['unchanged-summary','exact-image-page-identity'].includes(r.reason)) invalid = true;
        if (r.event === 'reuse-complete' && r.reason === 'unchanged-summary' && r.mode !== 'damage') invalid = true;
        if (r.event === 'reuse-complete' && r.reason === 'exact-image-page-identity' && r.mode !== 'full') invalid = true;
      }
      requests.set(k,r.event);
    }
  }
  if (!requests.size) incomplete = true;
  if (terminal && (releases.size || [...requests.values()].some(s => ['request','queued','active'].includes(s)))) incomplete = true;
  return invalid ? 'INVALID' : incomplete ? 'INCOMPLETE' : 'VALID';
}

export function createLifecycleTrace(limit = 4096, limits = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw new RangeError('invalid trace limit');
  const totalLimit = limits.total ?? MAX_TOTAL;
  if (!Number.isSafeInteger(totalLimit) || totalLimit < 1 || totalLimit > MAX_TOTAL) throw new RangeError('invalid total limit');
  const records = []; let dropped = 0, invalid = 0, sequence = 0, units = 0;
  return {
    markFailure() { invalid++; },
    record(row) {
      if (records.length >= limit) { dropped++; return; }
      const item = {sequence: sequence + 1};
      try {
        if (!row || !EVENTS.has(row.event) || typeof row.at !== 'number' || !Number.isFinite(row.at)) throw new TypeError('invalid event or timestamp');
        for (const key of FIELDS) {
          const value = row[key]; if (value === undefined) continue;
          if (typeof value === 'string' && value.length > MAX_STRING) throw new RangeError('string too long');
          if (value !== null && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw new TypeError('invalid trace field');
          item[key] = value;
        }
        if (REQUEST_EVENTS.has(item.event) && ['session','document','request','page','canvas','scale','generation','version','mode'].some(k => item[k] == null)) throw new TypeError('missing request field');
        if (REQUEST_EVENTS.has(item.event) && (['document','request','page','canvas','generation','version'].some(k => !Number.isSafeInteger(item[k]) || item[k] < 0) || typeof item.scale !== 'number' || item.scale <= 0 || !['full','damage'].includes(item.mode))) throw new TypeError('invalid request field');
        if (item.input != null && (!Number.isSafeInteger(item.input) || item.input < 1)) throw new TypeError('invalid input');
        if (item.job != null && (!Number.isSafeInteger(item.job) || item.job < 0)) throw new TypeError('invalid job');
        if (item.relatedRequest != null && (!Number.isSafeInteger(item.relatedRequest) || item.relatedRequest < 1)) throw new TypeError('invalid related request');
        if (JOB_EVENTS.has(item.event) && item.job == null) throw new TypeError('missing job');
        if (item.event.startsWith('reuse-') && item.relatedRequest == null) throw new TypeError('missing reused request');
        if (item.event === 'input' && item.input == null) throw new TypeError('missing input');
        if (item.event.startsWith('release-') && (item.session == null || item.reason == null || !Number.isSafeInteger(item.document))) throw new TypeError('missing release field');
        const size = JSON.stringify(item).length;
        if (size > MAX_RECORD || units + size > totalLimit) { dropped++; return; }
        units += size; sequence++; records.push(item);
      } catch (error) { invalid++; throw error; }
    },
    requireComplete() { if (dropped || invalid) throw new Error('incomplete lifecycle trace'); return this.snapshot(); },
    snapshot(options = {}) {
      const captureComplete = dropped === 0 && invalid === 0;
      return {clock:'performance.now',timeOrigin:performance.timeOrigin,units:'ms',limit,dropped,invalid,
        retainedJsonCodeUnits:units, totalLimitCodeUnits:totalLimit, maxStringCodeUnits:MAX_STRING, maxRecordCodeUnits:MAX_RECORD,
        complete:captureComplete, captureComplete, lifecycleValid:captureComplete ? validateLifecycle(records, options.terminal === true) : 'UNKNOWN',
        causalityComplete:false, records:records.map(row => ({...row}))};
    },
  };
}

export function installLifecycleTrace(target = window, limit = 4096) {
  if (target.__d4LifecycleTrace) throw new Error('trace already installed');
  const trace = createLifecycleTrace(limit); let input = 0;
  const onInput = event => {
    if (!event.target?.classList?.contains('rhwp-input')) return;
    const id = ++input; target.__d4LifecycleInput = id;
    try { trace.record({event:'input', at:performance.now(), input:id}); } catch { /* collector records invalid */ }
    queueMicrotask(() => { if (target.__d4LifecycleInput === id) target.__d4LifecycleInput = null; });
  };
  target.__d4LifecycleTrace = trace; target.document.addEventListener('input', onInput, true);
  return { snapshot: options => trace.snapshot(options), stop() {
    target.document.removeEventListener('input', onInput, true);
    if (target.__d4LifecycleTrace === trace) delete target.__d4LifecycleTrace;
    delete target.__d4LifecycleInput;
  } };
}
