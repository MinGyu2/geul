"""하드닝 2의 원시 수치/신원 검증. 픽셀 readback 자체의 진실성은 JS 관찰 경계다."""
import math
import re

NAMES = ['control-small-watermark-complete', 'control-cleanup', 'large-source-fits-job-reservation',
         'memo-refusal-is-resource-limit', 'memo-refusal-transform-attempted', 'memo-refusal-no-decode-after-refusal',
         'memo-refusal-no-ready-no-replay', 'memo-refusal-not-published', 'memo-refusal-reservation-bounded', 'memo-refusal-cleanup']
JOB_COUNTERS = 'attempts decodeAttempts id keys memoCount memoHits readyReuses readyTransitions replays retainedBytes steps transformAttempts yields'.split()
ZERO_STATS = 'activeJobs activeLeaseCount activeLeaseEstimatedBytes backupImageDataBytes decodedRegistryEntries decodedRegistryLive inFlightEstimatedBytes ownedEstimatedBytes pendingCount readyLeaseCount temporaryCanvasBytes transientEstimatedBytes uniqueResourceCount'.split()
ZERO_LEDGER = 'accountingErrors dimensionMismatches jobLeaseReferenceBytes jobLeaseReferences nonresidentBytes nonresidentCount reservedBytes residentBytes residentCount unenforcedOverLimit uniqueBytes uniqueCount'.split()


def require(ok, message):
    if not ok:
        raise ValueError(message)


def equal(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(equal(a, b) for a, b in zip(left, right))
    return left == right


def count(value):
    require(type(value) is int and value >= 0, 'nonnegative exact integer required')
    return value


def numeric_tree(value, key=''):
    # Stats contains counters, two booleans, strings describing the estimate, and jobs arrays.
    if isinstance(value, dict):
        for name, item in value.items():
            numeric_tree(item, name)
    elif isinstance(value, list):
        for item in value:
            numeric_tree(item)
    elif key in ('enabled', 'expiryTimerActive'):
        require(type(value) is bool, 'invalid Boolean: ' + key)
    elif key in ('estimate', 'phase'):
        require(type(value) is str, 'invalid text: ' + key)
    else:
        count(value)


def cleanup(s, limits, errors, canceled=0, terminal=False):
    require(type(s) is dict, 'cleanup stats missing')
    numeric_tree(s)
    for name in ZERO_STATS:
        require(count(s.get(name)) == 0, 'cleanup ' + name)
    require(s.get('expiryTimerActive') is False, 'timer remains active')
    p, d = s.get('preparation', {}), s.get('decodedLedger', {})
    require(p.get('enabled') is True and type(p.get('jobs')) is list, 'preparation schema')
    require(len(p['jobs']) == (1 if terminal else 0), 'unexpected preparation jobs')
    for job in p['jobs']:
        require(set(job) == set(JOB_COUNTERS + ['phase']), 'terminal metadata schema')
        require(job['phase'] == 'Terminal', 'active preparation job remains')
        for name in JOB_COUNTERS:
            count(job[name])
        require(job['keys'] == job['memoCount'] == job['retainedBytes'] == job['readyTransitions'] == job['replays'] == 0, 'terminal job owns resources')
    require(count(p.get('ownedBytes')) == 0, 'retained bytes remain')
    require(count(p.get('maxJobBytes')) == 32 << 20 and count(p.get('maxOwnedBytes')) == 64 << 20, 'changed memory limits')
    require(count(p.get('peakBytes')) <= p['maxOwnedBytes'], 'module memory bound')
    for name in ZERO_LEDGER:
        require(count(d.get(name)) == 0, 'ledger cleanup ' + name)
    require(count(d.get('created')) == count(d.get('disposed')), 'backings not disposed exactly once')
    require(count(s.get('resourceLimits')) == limits and count(s.get('errors')) == errors and count(s.get('cancellations')) == canceled, 'terminal cleanup counters')


def validate_run(run):
    require(type(run) is dict and type(run.get('schema')) is int and run['schema'] == 2, 'schema 2 required')
    require(run.get('contract') == 't010-preparation-hardening-2' and run.get('status') == 'PASS' and not run.get('error'), 'run failed')
    tests, cases = run.get('tests'), run.get('cases')
    require(type(tests) is list and all(type(t) is dict for t in tests), 'invalid tests')
    require([t.get('name') for t in tests] == NAMES and all(t.get('status') == 'PASS' for t in tests), 'case names/order/status')
    require(type(cases) is list and len(cases) == 2 and all(type(c) is dict for c in cases), 'exactly two cases required')
    require([c.get('label') for c in cases] == ['control-small-watermark', 'memo-reservation-refusal'], 'case identity')
    for c, outcome, decode, ready in zip(cases, ['COMPLETE', 'RESOURCE_LIMIT'], [1, 0], [1, 0]):
        require(c.get('outcome') == outcome, 'wrong outcome')
        for name in ('sourceBytes', 'polls', 'peakBytes', 'maxJobBytes'):
            count(c.get(name))
        require(c['sourceBytes'] > 0 and c['polls'] > 0, 'empty observation')
        require(c['maxJobBytes'] == 32 << 20 and c['peakBytes'] <= c['maxJobBytes'], 'job memory bound')
        for name in ('totalMs', 'maxPollMs'):
            v = c.get(name)
            require(type(v) in (int, float) and math.isfinite(v) and v >= 0, 'invalid time')
        j = c.get('job')
        require(type(j) is dict and set(j) == set(JOB_COUNTERS + ['phase']), 'job schema')
        for name in JOB_COUNTERS:
            count(j[name])
        require(j['phase'] == 'Terminal' and j['id'] > 0 and j['transformAttempts'] == 1 and j['decodeAttempts'] == decode
                and j['readyTransitions'] == ready and j['replays'] == ready, 'job counters inconsistent')
        require(j['keys'] == j['memoCount'] == j['retainedBytes'] == 0, 'job cleanup incomplete')
        require(c.get('terminalPolls') == [outcome] * 3, 'unstable terminal polls')
        require(type(c.get('unchanged')) is bool and c.get('pendingNeverPublished') is True, 'publication assertion')
    small, big = cases
    require(small['job']['id'] < big['job']['id'], 'job generation identity')
    require(count(run.get('largeSourceBytes')) == big['sourceBytes'] < big['maxJobBytes'] - (1 << 20), 'source reservation')
    require(equal(tests[0].get('row'), small) and tests[2].get('bytes') == big['sourceBytes'] and type(tests[2].get('bytes')) is int, 'nested source/control mismatch')
    require(tests[3].get('outcome') == big['outcome'], 'nested outcome mismatch')
    for index in (4, 5, 6):
        require(equal(tests[index].get('job'), big['job']), 'nested job mismatch')
    require(type(tests[8].get('peakBytes')) is int and tests[8]['peakBytes'] == big['peakBytes'], 'nested memory mismatch')
    require(big['unchanged'] is True, 'refused frame published')
    frames = [big.get('frameBefore'), big.get('frameAfter')]
    for f in frames:
        require(type(f) is dict and set(f) == {'width', 'height', 'sha256'}, 'frame witness required')
        require(count(f['width']) > 0 and count(f['height']) > 0 and type(f['sha256']) is str
                and re.fullmatch('[0-9a-f]{64}', f['sha256']), 'invalid frame witness')
    require(frames[0] == frames[1], 'frame witness mismatch')
    cleanup(tests[1].get('stats'), 0, 0)
    cleanup(tests[9].get('stats'), 1, 0)

    rows = run.get('terminalCases')
    require(type(rows) is list and len(rows) == 3 and all(type(r) is dict for r in rows), 'terminal cases required')
    require([r.get('label') for r in rows] == ['cancel-late-decode-error', 'close-pending-image', 'preparation-resource-revocation'], 'terminal case order')
    for index, row in enumerate(rows):
        require(row.get('unchanged') is True, 'terminal publication')
        outcomes = ['CANCELED'] * 3 if index == 0 else [] if index == 1 else ['RESOURCE_LIMIT'] * 3
        require(row.get('outcomes') == outcomes, 'terminal reason changed')
        if index < 2:
            require(row.get('initial') == 'PENDING' and count(row.get('pendingBefore')) == 1, 'no pending image witness')
        else:
            require(row.get('outcome') == 'RESOURCE_LIMIT' and count(row.get('revocations')) > 0, 'no preparation revocation')
            j = row.get('job', {})
            for name in JOB_COUNTERS:
                count(j.get(name))
            require(j.get('phase') == 'Terminal' and j['readyTransitions'] == j['replays'] == j['retainedBytes'] == 0, 'revoked job advanced')
        cleanup(row.get('stats'), 1 if index < 2 else 2, 0, 1 if index == 0 else 2, terminal=index == 0)


def validate_identity(identity, before, after):
    require(type(before) is dict and before == after and bool(before), 'unstable input identity')
    for digest in before.values():
        require(type(digest) is str and re.fullmatch('[0-9a-f]{64}', digest), 'invalid hash')
    for name in ('rhwp.js', 'rhwp_bg.wasm'):
        require(identity.get(name) == before.get('candidate/' + name), 'candidate copy identity mismatch')
    manifest = identity.get('ENGINE.json', {})
    require(manifest.get('baseline') == '1a76570e833917d15817415a53c09ad61ab3203f'
            and manifest.get('preparationDefaultEnabled') is False, 'candidate source/default identity')
    require(manifest.get('buildStatus') == 'PASS' and manifest.get('sourceStableDuringBuild') is True, 'unverified candidate build')
    for name in ('rhwp.js', 'rhwp_bg.wasm', 'rhwp.d.ts'):
        require(manifest.get('artifacts', {}).get(name) == before.get('candidate/' + name), 'manifest identity mismatch')
