"""Fail-closed classification of the continuous native lifecycle diagnostic (pure; no native tools).

Protocol: undo_native.scenario_lifecycle, unchanged, for two large documents x three modes x twenty
cycles in ONE app/WebDriver session. Each cycle samples before/opened/closed; the last cycle of each mode
adds closedAfter10s, so 2 x 3 x (20 x 3 + 1) = 366 memory points. A child exit code is never evidence.

Declared budgets are renderer/cache estimates (surface_cache.rs DEFAULT_*, render_job.rs limits), not
process RSS or GPU caps. RSS has no approved criterion here, so its verdict is always INCONCLUSIVE.
"""

DOCUMENTS = ('연구노트(화학).hwp', '3249937_asset_management_rules.hwpx')
MODES = ('openClose', 'editCapacityRefusalControl', 'undoRedo')
CYCLES = 20
LABELS = ('before', 'opened', 'closed')
SETTLED = 'closedAfter10s'
EXPECTED_CYCLES = len(DOCUMENTS) * len(MODES) * CYCLES
EXPECTED_POINTS = len(DOCUMENTS) * len(MODES) * (CYCLES * len(LABELS) + 1)
WEBPROCESS_COMM = 'WebKitWebProces'
WEBPROCESS_COUNT = 1
MIB = 1 << 20
DECLARED_JOBS = {'maxOwnedBytes': 256 * MIB, 'maxPending': 2, 'maxResources': 256, 'maxStagingBytes': 128 * MIB, 'maxFrameBytes': 64 * MIB}
DECLARED_CACHES = {'decoded': {'maxBytes': 256 * MIB, 'maxEntries': 256, 'maxEntryBytes': 64 * MIB},
                   'images': {'maxBytes': 64 * MIB, 'maxEntries': 256, 'maxEntryBytes': 16 * MIB}}
NEGATIVE_ENTRY_BYTES = 64  # surface_cache.rs: a remembered decode failure holds no surface
RELEASED_JOB_FIELDS = ('activeJobs', 'activeLeaseCount', 'pendingCount', 'readyLeaseCount', 'transientEstimatedBytes',
                       'temporaryCanvasBytes', 'backupImageDataBytes', 'inFlightEstimatedBytes', 'activeLeaseEstimatedBytes')
JOB_COUNTERS = ('ownedEstimatedBytes', 'uniqueResourceCount', 'peakStagingBytes', 'peakTemporaryCanvasBytes', 'peakBackupImageDataBytes')
CACHE_COUNTERS = ('bytes', 'entries', 'pendingEntries', 'negativeEntries', 'transientEntries')
CLEANUP_STEPS = ('sessionEnded', 'driverStopped', 'displayTerminated')


def count(value):
    return type(value) is int and value >= 0


def positive(value):
    return type(value) is int and value > 0


def process_identity(processes, where, failures):
    """(pid, startTime) of the one WebProcess; start time (clock ticks since boot) detects PID reuse."""
    if not isinstance(processes, list) or len(processes) != WEBPROCESS_COUNT:
        failures.append(f'{where}: expected {WEBPROCESS_COUNT} WebProcess, got {processes!r}'[:200]); return None
    row = processes[0]
    if not isinstance(row, dict) or not positive(row.get('pid')) or not positive(row.get('startTime')):
        failures.append(f'{where}: WebProcess pid/startTime missing or invalid: {row!r}'[:200]); return None
    return row['pid'], row['startTime']


def check_point(point, where, closed, failures):
    local = []
    check_point_fields(point, where, closed, local)
    failures += local


def check_point_fields(point, where, closed, failures):
    if not isinstance(point, dict):
        failures.append(f'{where}: not a memory sample'); return
    identity = process_identity(point.get('processes'), where, failures)
    rss = point.get('aggregateRssBytes')
    if identity and not (positive(point['processes'][0].get('rssBytes')) and rss == point['processes'][0]['rssBytes']):
        failures.append(f'{where}: RSS missing, zero or inconsistent')
    if not positive(point.get('wasmBytes')): failures.append(f'{where}: WASM memory missing')
    renderer = point.get('renderer')
    jobs = renderer.get('jobs') if isinstance(renderer, dict) else None
    caches = renderer.get('cache') if isinstance(renderer, dict) else None
    if not isinstance(jobs, dict) or not isinstance(caches, dict):
        failures.append(f'{where}: renderer stats missing'); return
    changed = [f'{field}={jobs.get(field)!r}' for field, declared in DECLARED_JOBS.items() if jobs.get(field) != declared]
    if changed: failures.append(f'{where}: job budget missing or changed: ' + ', '.join(changed)); return
    invalid = [field for field in (*JOB_COUNTERS, *RELEASED_JOB_FIELDS) if not count(jobs.get(field))]
    if invalid: failures.append(f'{where}: job counters missing or invalid: ' + ', '.join(invalid)); return
    if jobs['ownedEstimatedBytes'] > jobs['maxOwnedBytes'] or jobs['pendingCount'] > jobs['maxPending'] \
            or jobs['uniqueResourceCount'] > jobs['maxResources'] or jobs['peakStagingBytes'] > jobs['maxStagingBytes']:
        failures.append(f'{where}: declared job bound exceeded')
    for name, declared in DECLARED_CACHES.items():
        cache = caches.get(name)
        if not isinstance(cache, dict) or any(cache.get(k) != v for k, v in declared.items()) or not all(count(cache.get(k)) for k in CACHE_COUNTERS):
            failures.append(f'{where}: {name} cache budget/counters missing or changed'); return
        if cache['bytes'] > cache['maxBytes'] or cache['entries'] > cache['maxEntries']: failures.append(f'{where}: {name} cache bound exceeded')
    if not closed: return
    if point.get('owners') != [] or point.get('canvasCount') != 0 or renderer.get('sessions') != [] or renderer.get('subscribers') != 0:
        failures.append(f'{where}: document owner/visible Canvas/session/subscriber retained')
    held = [field for field in RELEASED_JOB_FIELDS if jobs[field]]
    if held: failures.append(f'{where}: unreleased ' + ', '.join(held))
    if jobs.get('expiryTimerActive') is not False: failures.append(f'{where}: expiry timer not stopped')
    if any(caches[name]['pendingEntries'] or caches[name]['transientEntries'] for name in DECLARED_CACHES):
        failures.append(f'{where}: pending/transient cache entries after close')
    # Every engine-held detached Canvas must be a resident decoded-cache surface (no orphaned surface).
    surfaces, decoded = point.get('engineSurfaces'), caches['decoded']
    if not isinstance(surfaces, dict) or not all(count(surfaces.get(k)) for k in ('detachedCanvases', 'canvasCount', 'canvasPixels', 'imageCount', 'externrefSlots')):
        failures.append(f'{where}: engine surface observation missing'); return
    resident = decoded['entries'] - decoded['negativeEntries']
    if surfaces['detachedCanvases'] != resident or surfaces['canvasCount'] != resident \
            or surfaces['canvasPixels'] * 4 != decoded['bytes'] - decoded['negativeEntries'] * NEGATIVE_ENTRY_BYTES:
        failures.append(f'{where}: engine Canvas surfaces {surfaces} not accounted by decoded cache {decoded}'[:300])
    if surfaces['imageCount'] != caches['images']['entries'] - caches['images']['negativeEntries']:
        failures.append(f'{where}: engine image surfaces not accounted by image cache')


def classify(result, expected_wasm):
    """PASS only for complete, ordered, single-session/single-WebProcess evidence with all cleanup and bounds."""
    failures = []
    if not isinstance(result, dict): return {'status': 'FAIL', 'failures': ['result is not an object']}
    if result.get('error'): failures.append('run error: ' + str(result['error'])[:200])
    session = result.get('sessionId')
    if not isinstance(session, str) or not session: failures.append('session id missing')
    for key in ('engineIdentity', 'engineIdentityAtEnd'):
        if (result.get(key) or {}).get('wasmSha256') != expected_wasm: failures.append(f'{key} != expected WASM')
    start = result.get('processesAtStart')
    start_identity = process_identity([p for p in start if isinstance(p, dict) and p.get('comm') == WEBPROCESS_COMM] if isinstance(start, list) else None,
                                      'processesAtStart', failures)
    samples = result.get('samples')
    if not isinstance(samples, list): samples = []; failures.append('samples missing')
    lifecycle = (result.get('measurements') or {}).get('lifecycle')
    if not isinstance(lifecycle, list): lifecycle = []; failures.append('lifecycle measurements missing')
    if [doc.get('sample') if isinstance(doc, dict) else None for doc in lifecycle] != list(DOCUMENTS):
        failures.append(f'lifecycle documents != {list(DOCUMENTS)}')
    point_failures, sequences, cycles = [], [], 0
    for doc in lifecycle:
        rows = doc.get('rows') if isinstance(doc, dict) else None
        if not isinstance(rows, list): failures.append('lifecycle rows missing'); continue
        expected_rows = [(mode, cycle) for mode in MODES for cycle in range(CYCLES)]
        if [(row.get('mode'), row.get('cycle')) if isinstance(row, dict) else None for row in rows] != expected_rows:
            failures.append(f'{doc.get("sample")}: cycles missing, duplicated or reordered ({len(rows)} rows)')
        for row in rows:
            if not isinstance(row, dict): continue
            cycles += 1
            labels = [*LABELS, SETTLED] if row.get('cycle') == CYCLES - 1 else list(LABELS)
            extra = sorted(set(row) - {'mode', 'cycle', *labels})
            if extra: failures.append(f'{doc.get("sample")}:{row.get("mode")}:{row.get("cycle")}: unexpected observations {extra}')
            for label in labels:
                where = f'{doc.get("sample")}:{row.get("mode")}:{row.get("cycle")}:{label}'
                point = row.get(label)
                if not isinstance(point, dict): point_failures.append(where + ': observation missing'); continue
                if point.get('doc') != doc.get('sample') or point.get('sessionId') != session:
                    point_failures.append(where + ': observation not bound to this document/session')
                sequences.append(point.get('sequence'))
                check_point(point, where, label in ('closed', SETTLED), point_failures)
    failures += point_failures[:40]
    if len(point_failures) > 40: failures.append(f'... {len(point_failures) - 40} more observation failures')
    if cycles != EXPECTED_CYCLES or result.get('completedCycles') != EXPECTED_CYCLES:
        failures.append(f'completed cycles {cycles}/{result.get("completedCycles")} != {EXPECTED_CYCLES}')
    if len(sequences) != EXPECTED_POINTS or sequences != list(range(len(sequences))):
        failures.append(f'{len(sequences)}/{EXPECTED_POINTS} memory observations missing, duplicated or reordered')
    if [s.get('sequence') if isinstance(s, dict) else None for s in samples] != list(range(len(samples))) or len(samples) != len(sequences):
        failures.append('durable sample stream does not match the measured observations')
    identities = set()
    for index, sample in enumerate(samples):
        identity = process_identity(sample.get('processes') if isinstance(sample, dict) else None, f'sample {index}', failures)
        identities.add(identity)
    stable = bool(samples) and len(identities) == 1 and None not in identities and identities == {start_identity}
    if not stable: failures.append(f'WebProcess identity not stable/verified: start {start_identity}, samples {sorted(map(str, identities))[:4]}')
    gates = result.get('gates') if isinstance(result.get('gates'), list) else []
    cycle_gates = [g for g in gates if isinstance(g, dict) and g.get('result') != 'INCONCLUSIVE']
    if len(cycle_gates) != EXPECTED_CYCLES or any(g.get('result') != 'PASS' for g in cycle_gates):
        failures.append(f'cycle cleanup gates {sum(g.get("result") == "PASS" for g in cycle_gates)}/{len(cycle_gates)} PASS, expected {EXPECTED_CYCLES}')
    cleanup = result.get('cleanup') if isinstance(result.get('cleanup'), dict) else {}
    incomplete = [step for step in CLEANUP_STEPS if cleanup.get(step) is not True]
    if incomplete: failures.append('run cleanup incomplete: ' + ', '.join(incomplete))
    return {'status': 'FAIL' if failures else 'PASS', 'failures': failures,
            'completedCycles': cycles, 'memoryPoints': len(sequences), 'expectedMemoryPoints': EXPECTED_POINTS,
            'webProcessIdentity': {'verified': stable, 'evidence': 'pid+/proc starttime', 'identity': list(start_identity) if stable else None},
            'rssVerdict': 'INCONCLUSIVE: no approved RSS stability criterion; declared budgets are not process RSS/GPU caps'}
