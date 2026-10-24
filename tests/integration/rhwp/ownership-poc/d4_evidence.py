"""Test-side D4 interval attribution. Does not change canonical MEASURE.

Times share performance's time origin, but event timestamps and observation times
are distinct. Rounded interval unions estimate coverage, not Rust CPU time.
"""
import math
from collections import Counter

EDIT_KINDS = ('groupStart', 'extend', 'afterUndo')


def number(value):
    return (type(value) is int and abs(value) <= 1.7976931348623157e308 or
            type(value) is float and math.isfinite(value))


def union(intervals, start, end):
    """Clip then union; nested wrappers and Canvas calls are never counted twice."""
    if not number(start) or not number(end) or end < start:
        raise ValueError('invalid window')
    clipped = []
    for a, b in intervals:
        if not number(a) or not number(b) or b < a:
            raise ValueError('missing/invalid interval boundary')
        if a < end and b > start:
            clipped.append((max(a, start), min(b, end)))
    merged = []
    for a, b in sorted(clipped):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    return sum(b-a for a, b in merged)


def intervals(calls):
    return [(c['at'], c['at'] + c['ms']) for c in calls
            if number(c.get('at')) and number(c.get('ms')) and c['ms'] >= 0]


def pair_edits(result):
    """Order proposes call pairs; absolute timestamps independently verify each.

    Canonical rows lack absolute keys/IDs. Their insertText-relative offset plus
    the absolute call reconstructs a key timestamp, which must uniquely match an
    event key AND its input timestamp. Extra warmup/history events are allowed.
    Ambiguous/missing/duplicated/displaced events are rejected, never nearest-fit.
    """
    samples = [s for s in result['samples'] if s['kind'] in EDIT_KINDS]
    calls = [c for c in result['probeCalls'] if c['name'] == 'insertText']
    keys, inputs = result['events']['keys'], result['events']['inputs']
    if len(calls) != len(samples):
        raise ValueError('unmatched insertText/canonical rows')
    paired, used_keys, used_inputs = [], set(), set()
    previous = -1
    for s, c in zip(samples, calls):
        local = [x for x in s['engineTimeline'] if x['name'] == 'insertText']
        if len(local) != 1 or abs(local[0]['ms'] - c['ms']) > .11:
            raise ValueError('displaced call duration')
        key = c['at'] - local[0]['at']
        ks = [j for j, e in enumerate(keys) if abs(e['t']-key) <= .11]
        ins = [j for j, e in enumerate(inputs) if abs(e['t']-(key+s['at']['input'])) <= .11]
        if len(ks) != 1 or len(ins) != 1:
            raise ValueError('unmatched/duplicated event timestamp')
        ki, ii = ks[0], ins[0]
        if ki in used_keys or ii in used_inputs or ki <= previous:
            raise ValueError('duplicated/displaced edit event')
        # Dispatch observation order is required; event timeStamp may round 1ms ahead.
        k, i = keys[ki], inputs[ii]
        if not (k['seen'] <= i['seen'] and
                abs(i['seen']-i['t']) <= 2 and ki == ii):
            raise ValueError('event ordering/pairing assumption failed')
        previous = ki; used_keys.add(ki); used_inputs.add(ii)
        paired.append((s, k, i))
    return paired


def analyze_delay(result):
    rows = []
    for s, k, i in pair_edits(result):
        if s['kind'] != 'groupStart':
            continue
        start, end = k['t'], i['t']
        if end < start:
            rows.append(dict(trial=len(rows)+1,deliveryMs=end-start,classification='UNVERIFIED: native/input timestamp inversion'))
            continue
        calls = [c for c in result['probeCalls'] if number(c.get('at')) and
                 number(c.get('ms')) and c['at'] < end and c['at']+c['ms'] > start]
        renders = [c for c in calls if c['name'] == 'pollRenderJob']
        covered = union(intervals(calls), start, end)
        render_covered = union(intervals(renders), start, end)
        last = max((c['at']+c['ms'] for c in calls), default=start)
        rows.append(dict(trial=len(rows)+1, deliveryMs=end-start,
            nativeKeyTimestamp=start, keydownObservedTimestamp=k['seen'],
            inputTimestamp=end,inputObservedTimestamp=i['seen'],
            observedKeyToInputObservationMs=i['seen']-k['seen'],
            recordedCallCount=len(calls),
            busyUnionMs=union([(a,a+b) for a,b in s['busy']],0,end-start),
            keyToObservedMs=k['seen']-start, observedToInputMs=end-k['seen'],
            callsUnionMs=covered, renderUnionMs=render_covered,
            overlapPercent=100*render_covered/(end-start) if end>start else 0,
            residualMs=end-start-covered, afterLastCallMs=max(0,end-last),
            afterLastCallToKeyObservationMs=max(0,k['seen']-last),
            multipleRenderCalls=len(renders)>1,
            renders=[dict(atMs=c['at']-start, ms=c['ms'], outcome=c.get('outcome'),
                          diagnostic=c.get('diagnostic')) for c in renders],
            calls=[dict(name=c['name'],atMs=c['at']-start,ms=c['ms']) for c in calls],
            # Trace time is emission/end; ms may include async waits. Not CPU union.
            spans=[dict(x,at=x['at']-start) for x in result['traceSpans']
                   if start <= x['at'] <= end or number(x.get('ms')) and
                   x['at']-x['ms'] < end and x['at'] > start],
            busy=s['busy'], classification='associated >=95%' if render_covered >= .95*(end-start)
            else 'residual UNVERIFIED'))
    return rows


def handler_accounting(sample):
    start, end = sample['at']['input'], sample['at']['handlerEnd']
    names = ('insertText','saveSnapshot','snapshotCapacity','getPageInfo','pollRenderJob',
             'canvasVisibleDraw','canvasReadback')
    arithmetic = end-start-sum(sample['calls'].get(n, {}).get('ms', 0) for n in names)
    calls = [c for c in sample.get('engineTimeline', []) if c['name'] in names]
    complete = bool(calls) and all(number(c.get('at')) and number(c.get('ms')) and c['ms'] >= 0 for c in calls)
    # Ensure the interval list accounts for every aggregate call before claiming coverage.
    complete = complete and all(sum(c['name']==n for c in calls) == sample['calls'].get(n,{}).get('n',0) for n in names)
    covered = union(intervals(calls),start,end) if complete else None
    return dict(handlerMs=end-start, nonexclusiveArithmeticResidualMs=arithmetic,
                recordedUnionMs=covered, uncoveredMs=None if covered is None else end-start-covered,
                exclusiveAppJs='UNVERIFIED: rounded probes cover selected calls only',
                intervalCoverage='rounded interval estimate' if complete else 'UNVERIFIED: missing boundaries')


def structure_errors(result):
    """Supported input-delay schema, checked before any semantic lookup/arithmetic."""
    if not isinstance(result, dict):
        return ['result must be an object']
    errors = []
    for name in ('events', 'engineIdentity', 'measure'):
        if not isinstance(result.get(name), dict): errors.append(name+' must be an object')
    for name in ('probeCalls', 'traceSpans', 'samples'):
        value = result.get(name)
        if not isinstance(value, list) or not all(isinstance(x, dict) for x in value):
            errors.append(name+' must be an array of objects')
    if errors: return errors
    for name in ('keys','inputs'):
        value=result['events'].get(name)
        if not isinstance(value,list) or not all(isinstance(e,dict) and number(e.get('t')) and number(e.get('seen')) for e in value):
            errors.append('invalid '+name+' timestamp records')
    if not isinstance(result['measure'].get('groupStart'),dict): errors.append('groupStart measure must be an object')
    for name in ('probeCalls','traceSpans'):
        for c in result[name]:
            if (not isinstance(c.get('name'),str) or not number(c.get('at')) or
                not (name=='traceSpans' and c.get('ms') is None or number(c.get('ms')) and c['ms']>=0)):
                errors.append('invalid '+name+' interval');break
    for sample in result['samples']:
        if not isinstance(sample.get('kind'),str) or not isinstance(sample.get('at'),dict):
            errors.append('invalid canonical sample');continue
        if sample['kind'] not in EDIT_KINDS: continue
        if not all(number(sample['at'].get(n)) for n in ('key','input','handlerEnd','observed','raf1','end')):
            errors.append('invalid canonical timestamps')
        local=sample.get('engineTimeline')
        if not isinstance(local,list) or not all(isinstance(c,dict) and isinstance(c.get('name'),str) and
                number(c.get('at')) and number(c.get('ms')) and c['ms']>=0 for c in local):
            errors.append('invalid canonical call boundaries')
    return errors


def validate(result, expected_wasm, expected_source, *, legacy=False):
    """Focused causal-evidence contract; missing logs cannot mean complete."""
    failures = structure_errors(result)
    if failures: return dict(status='FAIL',failures=failures,official=False)
    missing_loss = 'probeCallDropped' not in result
    def require(ok, message):
        if not ok: failures.append(message)
    require(not result.get('error'), 'recorded harness error')
    require(result.get('sourceSha256') == expected_source, 'fixture identity')
    require(result.get('sample') == '연구노트(화학).hwp', 'fixture name')
    require((result.get('engineIdentity') or {}).get('wasmSha256') == expected_wasm, 'candidate identity')
    require(legacy and missing_loss or type(result.get('probeCallDropped')) is int and result['probeCallDropped']==0, 'probe call loss/unknown')
    require(result.get('traceDropped') == 0 and type(result.get('traceDropped')) is int, 'trace loss/unknown')
    for name in ('probeCalls','traceSpans','samples'):
        require(isinstance(result.get(name),list) and bool(result[name]), 'missing '+name)
    events = result.get('events') or {}
    if isinstance(events.get('keys'),list) and isinstance(events.get('inputs'),list):
        require(len(events['keys']) == len(events['inputs']), 'unmatched key/input event counts')
    for name in ('keys','inputs'):
        log = events.get(name)
        require(isinstance(log,list) and bool(log), 'missing '+name)
        if isinstance(log,list):
            require(all(isinstance(e,dict) and number(e.get('t')) and number(e.get('seen')) for e in log), 'invalid '+name+' timestamp')
            if all(isinstance(e,dict) and number(e.get('t')) and number(e.get('seen')) for e in log):
                require(all(a['t'] < b['t'] and a['seen'] <= b['seen'] for a,b in zip(log,log[1:])), 'invalid '+name+' ordering')
    for name in ('probeCalls','traceSpans'):
        log = result.get(name) or []
        require(all(isinstance(c,dict) and isinstance(c.get('name'),str) and number(c.get('at')) and
                    (name=='traceSpans' and c.get('ms') is None or number(c.get('ms')) and c['ms']>=0) for c in log), 'invalid '+name+' intervals')
        # Calls append on return: nesting means array start times need not be sorted.
    groups = [s for s in result.get('samples',[]) if isinstance(s,dict) and s.get('kind')=='groupStart']
    require(len(groups)==30, 'canonical group count')
    measure = (result.get('measure') or {}).get('groupStart') or {}
    require(measure.get('n')==30 and measure.get('timeouts')==0, 'canonical completion')
    for s in groups:
        at=s.get('at') or {}
        require(all(number(at.get(n)) for n in ('key','input','handlerEnd','observed','raf1','end')) and
                all(at[a]<=at[b] for a,b in zip(('key','input','handlerEnd','observed','raf1'),('input','handlerEnd','observed','raf1','end'))), 'canonical timestamps/order')
        busy=s.get('busy')
        require(isinstance(busy,list) and bool(busy) and all(isinstance(g,list) and len(g)==2 and all(number(x) for x in g) and g[1]>=0 for g in busy), 'busy coverage')
    if not failures:
        try:
            pairs=pair_edits(result)
            absolute = Counter((c['name'],round(c['at'],1),round(c['ms'],1)) for c in result['probeCalls'])
            for sample,key,_ in pairs:
                local = sample['engineTimeline']
                require(all(number(c.get('at')) and number(c.get('ms')) for c in local), 'canonical call boundaries')
                if all(number(c.get('at')) and number(c.get('ms')) for c in local):
                    expected = Counter((c['name'],round(key['t']+c['at'],1),round(c['ms'],1)) for c in local)
                    require(all(absolute[item]>=count for item,count in expected.items()), 'missing/displaced canonical call coverage')
            require(sum(s['kind']=='groupStart' for s,_,_ in pairs)==30, 'group association')
            require(any(c['name']=='pollRenderJob' for c in result['probeCalls']), 'no render coverage')
            # Each canonical input should have a trace observation at the same origin.
            require(all(any(t['name']=='dom:input' and abs(t['at']-i['seen'])<=2 for t in result['traceSpans']) for _,_,i in pairs), 'trace input association')
        except ValueError as error:
            failures.append('pairing: '+str(error))
    return dict(status='FAIL' if failures else 'INCONCLUSIVE' if missing_loss else 'DIAGNOSTIC_COMPLETE', failures=failures,
                lossEvidence='UNVERIFIED: legacy result has no probeCallDropped' if missing_loss else 'verified zero loss' if not failures else 'not established',
                pairing='ordered insertText anchors independently checked against absolute key/input timestamps; no shared trial ID',
                official=False)
