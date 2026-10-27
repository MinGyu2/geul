"""Pure evaluation of the T010 native lease diagnostic (no I/O; re-runnable on raw evidence).

Every value comes from engine counters copied verbatim by lease-probe.js. A check is True only when
the recorded counters show it; a missing step or field makes it False, never assumed.
"""

JOB_FIELDS = ('activeLeaseCount', 'readyLeaseCount', 'pendingCount', 'uniqueResourceCount', 'activeJobs',
              'activeLeaseEstimatedBytes', 'transientEstimatedBytes', 'inFlightEstimatedBytes', 'ownedEstimatedBytes',
              'maxOwnedBytes', 'maxPending', 'maxResources', 'peakStagingBytes', 'maxStagingBytes',
              'cancellations', 'errors', 'resourceLimits', 'loadAttempts', 'maxJobLeaseEntries', 'maxJobDecodedLeases',
              'decodedRegistryLive', 'decodedRegistryEntries')
CACHE_FIELDS = ('entries', 'bytes', 'maxBytes', 'maxEntries', 'evictions', 'oversize')


def _int(value):
    return type(value) is int and value >= 0


def accounting_errors(row):
    """Independent invariants over one checkpoint (the totals are not trusted by themselves)."""
    errors = []
    jobs, cache = row.get('jobs'), row.get('cache')
    if not isinstance(jobs, dict) or not isinstance(cache, dict): return ['missing stats']
    for name in JOB_FIELDS:
        if not _int(jobs.get(name)): errors.append('jobs.' + name)
    for kind in ('decoded', 'images'):
        c = cache.get(kind)
        if not isinstance(c, dict): errors.append('cache.' + kind); continue
        for name in CACHE_FIELDS:
            if not _int(c.get(name)): errors.append(f'cache.{kind}.{name}')
    if errors: return errors
    j = jobs
    if j['readyLeaseCount'] > j['activeLeaseCount']: errors.append('ready > active leases')
    if j['transientEstimatedBytes'] > j['activeLeaseEstimatedBytes']: errors.append('transient > active lease bytes')
    if j['inFlightEstimatedBytes'] > j['ownedEstimatedBytes']: errors.append('in-flight > owned bytes')
    if j['ownedEstimatedBytes'] > j['maxOwnedBytes']: errors.append('owned > max owned bytes')
    if j['pendingCount'] > j['maxPending']: errors.append('pending > max pending')
    if j['pendingCount'] > j['uniqueResourceCount']: errors.append('pending > unique resources')
    if j['uniqueResourceCount'] > j['maxResources']: errors.append('unique > max resources')
    if j['peakStagingBytes'] > j['maxStagingBytes']: errors.append('staging peak > max')
    if j['activeLeaseCount'] and not j['activeJobs']: errors.append('leases without an active job')
    if j['maxJobLeaseEntries'] > j['maxJobDecodedLeases']: errors.append('job decoded leases > per-job bound')
    if j['maxJobLeaseEntries'] and not j['activeJobs']: errors.append('decoded leases without an active job')
    if j['decodedRegistryLive'] > j['decodedRegistryEntries']: errors.append('live decoded registry > entries')
    ledger = j.get('decodedLedger')
    if not isinstance(ledger, dict): errors.append('jobs.decodedLedger')
    else:
        names = ('created', 'disposed', 'uniqueCount', 'residentCount', 'nonresidentCount', 'jobLeaseReferences', 'accountingErrors', 'reservedBytes')
        if not all(_int(ledger.get(n)) for n in names): errors.append('decodedLedger fields')
        else:
            if ledger['created'] - ledger['disposed'] != ledger['uniqueCount']: errors.append('ledger created - disposed != unique')
            if ledger['residentCount'] + ledger['nonresidentCount'] != ledger['uniqueCount']: errors.append('ledger resident + nonresident != unique')
            if ledger['accountingErrors']: errors.append('ledger accounting errors')
            negative = cache['decoded'].get('negativeEntries')
            if not _int(negative) or ledger['residentCount'] != cache['decoded']['entries'] - negative:
                errors.append('ledger resident != decoded cache entries')
    for kind in ('decoded', 'images'):
        c = cache[kind]
        if c['bytes'] > c['maxBytes']: errors.append(kind + ' cache bytes > budget')
        if c['entries'] > c['maxEntries']: errors.append(kind + ' cache entries > max')
    return errors


def _j(steps, label, field):
    row = steps.get(label)
    return row['jobs'].get(field) if isinstance(row, dict) and isinstance(row.get('jobs'), dict) else None


def _c(steps, label, field, kind='images'):
    row = steps.get(label)
    try: return row['cache'][kind][field]
    except (TypeError, KeyError): return None


def _ledger(steps, label, field):
    try: value = steps[label]['jobs']['decodedLedger'][field]
    except (TypeError, KeyError): return None
    return value if _int(value) else None


def _exact(comparison):
    return (isinstance(comparison, dict) and comparison.get('sameExtent') is True
            and comparison.get('channelDifferences') == 0 and _int(comparison.get('nonWhitePixels'))
            and comparison['nonWhitePixels'] > 0)


def evaluate(steps, outcomes, comparisons):
    """steps: label -> checkpoint row; outcomes: label -> engine outcome string; comparisons: label -> compare result."""
    j = lambda label, field: _j(steps, label, field)
    c = lambda label, field: _c(steps, label, field)
    gt = lambda a, b: isinstance(a, int) and isinstance(b, int) and a > b
    eq = lambda a, b: isinstance(a, int) and a == b
    a1, a2 = j('acquire-X', 'activeLeaseCount'), j('acquire-Y', 'activeLeaseCount')
    checks = {
        'positiveLeaseAcquired': outcomes.get('acquire-X') == 'PENDING' and gt(a1, 0) and gt(j('acquire-X', 'pendingCount'), 0),
        'secondOwnerAcquired': outcomes.get('acquire-Y') == 'PENDING' and gt(a2, a1 if isinstance(a1, int) else -1),
        'cancelReleasesOnlyOwnLeases': outcomes.get('cancel-X') == 'CANCELED' and isinstance(a1, int) and isinstance(a2, int)
            and eq(j('cancel-X', 'activeLeaseCount'), a2 - a1) and eq(j('cancel-X', 'cancellations'), (j('acquire-Y', 'cancellations') or 0) + 1),
        'repeatedCancelIdempotent': outcomes.get('cancel-X-again') == 'CANCELED' and outcomes.get('poll-X-canceled') == 'CANCELED'
            and eq(j('cancel-X-again', 'cancellations'), j('cancel-X', 'cancellations'))
            and eq(j('poll-X-canceled', 'activeLeaseCount'), j('cancel-X', 'activeLeaseCount')),
        'leaseRetainedUntilReady': gt(j('ready-Y', 'readyLeaseCount'), 0) and eq(j('ready-Y', 'readyLeaseCount'), j('ready-Y', 'activeLeaseCount'))
            and eq(j('ready-Y', 'pendingCount'), 0),
        'completionReleasesLeases': outcomes.get('complete-Y') == 'COMPLETE' and eq(j('complete-Y', 'activeLeaseCount'), 0)
            and gt(c('complete-Y', 'entries'), c('trimmed', 'entries') if isinstance(c('trimmed', 'entries'), int) else 1 << 62),
        'completedPixelsExact': _exact(comparisons.get('y1-vs-ref')),
        'residentReuseWithoutLoad': outcomes.get('reuse-X') == 'COMPLETE' and eq(j('reuse-X', 'loadAttempts'), j('reference', 'loadAttempts'))
            and eq(j('reuse-X', 'activeLeaseCount'), 0) and _exact(comparisons.get('x2-vs-ref')),
        'trimEmptiesCaches': eq(c('trim-2', 'bytes'), 0) and eq(c('trim-2', 'entries'), 0) and eq(j('trim-2', 'activeLeaseCount'), 0),
        # Budget below the leased image's estimate: the completing owner's insert is refused residency
        # (oversize) or evicts; either way the other live job must still draw from its own lease.
        'cachePressureObserved': isinstance(c('pressure-Y-complete', 'evictions'), int) and isinstance(c('budget-small', 'evictions'), int)
            and (c('pressure-Y-complete', 'evictions') + c('pressure-Y-complete', 'oversize')) > (c('budget-small', 'evictions') + c('budget-small', 'oversize')),
        'leaseSurvivesCachePressure': outcomes.get('pressure-Y-complete') == 'COMPLETE' and gt(j('pressure-Y-complete', 'activeLeaseCount'), 0)
            and outcomes.get('pressure-X-complete') == 'COMPLETE' and _exact(comparisons.get('x3-vs-ref')) and _exact(comparisons.get('y3-vs-ref')),
        'budgetRestored': steps.get('budget-restored', {}).get('restoredEqualsOriginal') is True,
        'freeWithPendingReleases': gt(j('close-acquire-Y', 'activeLeaseCount'), 0) and eq(j('free:Y', 'activeLeaseCount'), 0)
            and eq(j('free:Y', 'activeJobs'), j('close-baseline', 'activeJobs')),
        'lateLoadsAfterFreeHarmless': eq(j('late-after-free', 'activeLeaseCount'), 0) and eq(j('late-after-free', 'pendingCount'), 0)
            and eq(j('late-after-free', 'errors'), j('free:Y', 'errors')),
        'appLeaseAcquired': outcomes.get('app-acquire') == 'PENDING' and gt(j('app-acquire', 'activeLeaseCount'), 0),
        'appLeaseHeldBeforeInput': gt(j('app-before-input', 'activeLeaseCount'), 0) and gt(j('app-before-input', 'activeJobs'), 0),
        'appStaleJobCanceledAfterNewRevision': outcomes.get('app-stale-poll') == 'CANCELED' and steps.get('app-stale-poll', {}).get('channelDifferences') == 0,
        'appLeasesReleasedAfterReplacement': eq(j('app-stale-poll', 'activeLeaseCount'), 0) and eq(j('app-stale-poll', 'activeJobs'), 0),
        'appVisibleFrameExact': isinstance(comparisons.get('app-visible'), dict) and comparisons['app-visible'].get('verified') is True
            and comparisons['app-visible'].get('pixels') == 0,
        'appCloseWithPendingLease': gt(j('app-close-acquire', 'activeLeaseCount'), 0) and eq(j('app-closed', 'activeLeaseCount'), 0)
            and eq(j('app-closed', 'activeJobs'), 0) and eq(j('app-late', 'activeLeaseCount'), 0) and eq(j('app-late', 'errors'), j('app-closed', 'errors')),
        'decodedLeaseAcquired': outcomes.get('P-acquire') == 'PENDING' and gt(j('P-acquire', 'maxJobLeaseEntries'), 0)
            and gt(j('P-acquire', 'decodedRegistryLive'), 0) and steps.get('P-acquire', {}).get('jobs', {}).get('preparation', {}).get('enabled') is True,
        'decodedCancelReleases': outcomes.get('P-cancel') == 'CANCELED' and eq(j('P-cancel', 'maxJobLeaseEntries'), 0) and eq(j('P-cancel', 'activeJobs'), 0)
            and (_ledger(steps, 'P-acquire', 'jobLeaseReferences') or 0) > 0 and _ledger(steps, 'P-cancel', 'jobLeaseReferences') == 0,
        'decodedCompletionReleases': gt(j('P-acquire-2', 'maxJobLeaseEntries'), 0) and outcomes.get('P-complete') == 'COMPLETE'
            and eq(j('P-complete', 'maxJobLeaseEntries'), 0) and _exact(comparisons.get('p2-vs-ref')),
        'decodedFreeReleases': gt(j('P-free-acquire', 'maxJobLeaseEntries'), 0) and eq(j('free:P', 'maxJobLeaseEntries'), 0)
            and eq(j('free:P', 'activeJobs'), 0) and eq(j('P-late', 'maxJobLeaseEntries'), 0) and eq(j('P-late', 'errors'), j('free:P', 'errors')),
        'decodedLeaseSurvivesEviction': gt(_ledger(steps, 'E-acquire', 'jobLeaseReferences'), 0) and outcomes.get('E-evict') == 'COMPLETE'
            and gt(_c(steps, 'E-evict', 'evictions', 'decoded'), _c(steps, 'E-acquire', 'evictions', 'decoded'))
            and gt(_ledger(steps, 'E-evict', 'nonresidentCount'), 0) and gt(_ledger(steps, 'E-evict', 'jobLeaseReferences'), 0)
            and outcomes.get('E-complete') == 'COMPLETE' and _exact(comparisons.get('e1-vs-ref')),
        'evictedBackingDisposedAtLastRelease': eq(_ledger(steps, 'E-complete', 'nonresidentCount'), 0)
            and gt(_ledger(steps, 'E-complete', 'disposed'), _ledger(steps, 'E-evict', 'disposed'))
            and eq(_ledger(steps, 'E-complete', 'jobLeaseReferences'), 0),
        'evictionBudgetRestored': steps.get('E-restored', {}).get('restoredEqualsOriginal') is True,
        'preparationRestored': steps.get('P-restored', {}).get('restoredEqualsOriginal') is True,
    }
    accounting = {label: errs for label, row in steps.items() if (errs := accounting_errors(row))}
    checks['accountingInvariants'] = bool(steps) and not accounting
    before, after = c('pressure-X', 'evictions'), c('pressure-Y-complete', 'evictions')
    held = j('pressure-Y-complete', 'activeLeaseCount')
    coverage = {'residentEvictionWhileLeased': 'VERIFIED' if isinstance(before, int) and isinstance(after, int) and after > before and gt(held, 0)
                else 'NOT EXERCISED', 'cacheNonAdmissionWhileLeased': 'VERIFIED' if isinstance(c('pressure-Y-complete', 'oversize'), int)
                and isinstance(c('pressure-X', 'oversize'), int) and c('pressure-Y-complete', 'oversize') > c('pressure-X', 'oversize') and gt(held, 0) else 'NOT EXERCISED',
                'decodedResidentEvictionWhileLeased': 'VERIFIED' if checks['decodedLeaseSurvivesEviction'] else 'NOT EXERCISED'}
    return {'checks': checks, 'coverage': coverage, 'accountingErrors': accounting, 'sharedBacking': {
        'uniqueAfterX': j('acquire-X', 'uniqueResourceCount'), 'uniqueAfterY': j('acquire-Y', 'uniqueResourceCount'),
        'shared': eq(j('acquire-Y', 'uniqueResourceCount'), j('acquire-X', 'uniqueResourceCount')),
        'uniqueAfterCancelX': j('cancel-X', 'uniqueResourceCount')}}
