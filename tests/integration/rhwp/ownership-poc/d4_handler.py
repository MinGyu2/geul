"""Complete official-document handler analysis, independent of D4 gate verdict.

Order/bytes follow undo_native.LARGE, tests/fixtures/rhwp/generate.mjs and
d4-frame-attribution-native.EXPECTED_SOURCE_SHA256. No values come from input JSON.
"""
import hashlib
from collections import Counter
from pathlib import Path
from d4_evidence import number, finite
from fractions import Fraction
from functools import lru_cache
import math

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = (
    ('basic-ko.hwp', None, '57c901cc394abf6f58f4838315d1ea2c5ecf8a03d9934d3fc098fd8be6e6e12f', 1),
    ('basic-ko.hwpx', None, '26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8', 1),
    ('연구노트(화학).hwp', 'rnote/연구노트(화학).hwp', '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91', 24),
    ('3249937_asset_management_rules.hwpx', 'issue6031/3249937_asset_management_rules.hwpx', '97b5d6c571a6b7626321c6a53d797e3511978447497bb73309bd23eaa8e7ea77', 60),
)
COUNTS = dict(groupStart=30, extend=30, undo=25, redo=20, afterUndo=5)
STATISTICS = ('n', 'p50', 'p95', 'max', 'timeouts')


def producer_pct(values):
    """Pure copy of undo_native.pct: nearest rank ceil(p*n)-1, one-decimal round (equivalence is tested).

    Importing undo_native would pull native/WebDriver harness modules into the analyzer.
    """
    v = sorted(x for x in values if x >= 0)
    if not v:
        return {"n": 0}
    q = lambda p: v[min(len(v) - 1, max(0, int(-(-p * len(v) // 1)) - 1))]  # noqa: E731
    return {"n": len(v), "p50": round(q(0.5), 1), "p95": round(q(0.95), 1), "max": round(v[-1], 1), "timeouts": len(values) - len(v)}


@lru_cache(maxsize=16384)
def rounding_bounds(value, digits):
    """Extremal binary floats that Python round(..., digits) serializes as value.

    Endpoint membership uses Python round, including binary-float ties; this is
    not an arbitrary epsilon or decimal half-up approximation.
    """
    if not number(value) or float(value) != value or round(value, digits) != value:
        raise ValueError('invalid producer decimal precision')
    half = Fraction(1, 2 * 10**digits)
    try:
        lo, hi = (float(Fraction(value) + sign*half) for sign in (-1, 1))
    except OverflowError as error:
        raise ValueError('invalid producer rounding range') from error
    finite(lo); finite(hi)
    while round(lo, digits) != value:
        lo = math.nextafter(lo, math.inf)
    while round(hi, digits) != value:
        hi = math.nextafter(hi, -math.inf)
    while round(math.nextafter(lo, -math.inf), digits) == value:
        lo = math.nextafter(lo, -math.inf)
    while round(math.nextafter(hi, math.inf), digits) == value:
        hi = math.nextafter(hi, math.inf)
    return lo, hi


def validate_sample_contract(s):
    """Internal serialized MEASURE consistency, not independent event provenance."""
    def require(ok, message):
        if not ok: raise ValueError(message)
    at, calls, timeline, trace = s['at'], s['calls'], s['engineTimeline'], s['timeline']
    require(at['key'] == 0 and s['keyToFrame'] == at['end'],
            'invalid canonical timeline measurement: origin/end mismatch')
    require(set(at) == {'key','input','handlerEnd','observed','raf1','end'}, 'invalid timestamp fields')
    for value in (s['keyToFrame'], *[v for v in at.values() if v is not None]):
        rounding_bounds(value, 1)
    require(at['input'] >= -2, 'invalid event timestamp rounding')
    if s['kind'] in ('undo', 'redo'):
        require(at['input'] == 0 and at.get('handlerEnd') is None, 'invalid shortcut handler boundaries')
    else:
        require(at['input'] <= at['handlerEnd'] <= at['observed'], 'invalid handler boundaries/order')
    require(Counter(c['name'] for c in timeline) == Counter({n:v['n'] for n,v in calls.items()})
            and all(v['n'] > 0 for v in calls.values()), 'aggregate/timeline count mismatch or zero-call entry')
    # Event timeStamp can precede/follow the performance clock (historical
    # shortcut trace reaches -3 ms). Use same-clock emission anchors instead.
    anchor_name = 'command:request' if s['kind'] in ('undo','redo') else 'dom:input'
    anchors = [t for t in trace if t['name'] == anchor_name]
    require(bool(anchors), 'missing execution trace association')
    anchor_lo = min(rounding_bounds(t['at'],1)[0] for t in anchors)
    # Calls append on return (render spans can cross handlerEnd).
    # Their two-decimal start/duration must admit completion by the final RAF.
    final_hi = rounding_bounds(at['end'], 1)[1]
    aggregate = {}
    seen = set()
    for c in timeline:
        require(bool(c['name']), 'invalid call name')
        lo, hi = rounding_bounds(c['ms'], 2)
        start_lo, _ = rounding_bounds(c['at'], 2)
        require(rounding_bounds(c['at'],2)[1] >= anchor_lo and finite(start_lo+max(0,lo)) <= final_hi,
                'invalid call execution interval')
        lower, upper = aggregate.get(c['name'], (0.0, 0.0))
        aggregate[c['name']] = (round(finite(lower+max(0,lo)),2), round(finite(upper+hi),2))
        if c['name'] not in seen:
            first = calls[c['name']].get('firstAt')
            require(number(first) and round(first,2) == c['at'], 'aggregate firstAt mismatch')
            seen.add(c['name'])
    for name, (lower, upper) in aggregate.items():
        value = calls[name]['ms']
        rounding_bounds(value, 2)
        require(lower <= value <= upper, 'aggregate duration mismatch: '+name)
    require(len(trace) <= 80, 'invalid trace truncation')
    for t in trace:
        require(bool(t['name']), 'invalid trace identity')
        lo, _ = rounding_bounds(t['at'], 1)
        require(lo <= final_hi, 'invalid trace emission interval')
        if t['ms'] is not None: rounding_bounds(t['ms'], 2)
    require(all(a['at'] <= b['at'] for a,b in zip(trace,trace[1:])), 'invalid trace emission order')
    if s['kind'] in ('groupStart','extend','afterUndo'):
        # dom:input is emitted synchronously by the real input handler. Other
        # trace names/order and async span starts are not a stable contract.
        require(any(t['name']=='dom:input' and at['input']-2 <= t['at'] <= at['handlerEnd']
                    and t['ms'] is None for t in trace), 'missing/invalid input trace association')
        inserts = [c for c in timeline if c['name']=='insertText']
        require(len(inserts)==1, 'missing edit insertText coverage')
        c=inserts[0]
        require(finite(rounding_bounds(c['at'],2)[0]+max(0,rounding_bounds(c['ms'],2)[0]))
                <= rounding_bounds(at['handlerEnd'],1)[1], 'synchronous insertText exceeds handler')


def verified_fixtures(generated):
    identities = {}
    for name, relative, expected, _ in FIXTURES:
        path = ROOT / 'external/rhwp/samples' / relative if relative else generated / name
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError('independent fixture bytes mismatch: '+name)
        identities[name] = actual
    return identities


def validate_handler(result, expected_wasm, identities):
    def require(ok, reason):
        if not ok: raise ValueError(reason)
    require(isinstance(result, dict), 'official evidence must be an object')
    require('error' not in result, 'recorded/invalid harness error')
    # Collection completeness only; a complete run whose official gate is FAIL stays analyzable.
    require(result.get('measurementComplete') is True,
            'official measurement incomplete: measurementComplete must be exactly true, got '
            + repr(result.get('measurementComplete', '<missing>')))
    measurements = result.get('measurements')
    require(isinstance(measurements, dict), 'missing official measurements')
    perf = measurements.get('perf')
    require(isinstance(perf, list) and bool(perf), 'missing/empty official perf collection')
    require(all(isinstance(d, dict) for d in perf), 'invalid perf document')
    require([d.get('sample') for d in perf] == [f[0] for f in FIXTURES],
            'canonical fixture order/set: missing, duplicate, unknown or reordered document')
    identity = result.get('engineIdentity')
    require(isinstance(identity, dict) and identity.get('wasmSha256') == expected_wasm,
            'official evidence WASM identity mismatch/unknown')
    for doc, (name, _, expected, pages) in zip(perf, FIXTURES):
        require(identities.get(name) == expected and doc.get('sourceSha256') == expected,
                'fixture identity missing/mismatch: '+name)
        require(type(doc.get('pages')) is int and doc['pages'] == pages, 'invalid fixture page count: '+name)
        for kind, count in COUNTS.items():
            m = doc.get(kind)
            require(isinstance(m, dict), 'missing measurement: '+kind)
            require(type(m.get('n')) is int and m['n'] == count and
                    type(m.get('timeouts')) is int and m['timeouts'] == 0, 'invalid canonical completion: '+kind)
            require(all(number(m.get(k)) and m[k] >= 0 for k in ('p50', 'p95', 'max')) and
                    m['p50'] <= m['p95'] <= m['max'], 'invalid measurement statistics: '+kind)
        samples = doc.get('timelineSamples')
        require(isinstance(samples, list) and all(isinstance(s, dict) for s in samples), 'invalid timelines')
        require(Counter(s.get('kind') for s in samples if isinstance(s.get('kind'), str)) == Counter(COUNTS)
                and len(samples) == sum(COUNTS.values()), 'canonical timeline counts')
        for s in samples:
            at, calls, timeline = s.get('at'), s.get('calls'), s.get('engineTimeline')
            require(isinstance(at, dict) and all(number(at.get(k)) for k in ('key', 'input', 'observed', 'raf1', 'end'))
                    and at['input'] <= at['observed'] <= at['raf1'] <= at['end']
                    and number(s.get('keyToFrame')) and s['keyToFrame'] >= 0, 'invalid canonical timeline measurement')
            require(isinstance(at, dict) and number(at.get('input')) and
                    (s['kind'] in ('undo', 'redo') and at.get('handlerEnd') is None or
                     number(at.get('handlerEnd')) and at['input'] <= at['handlerEnd']), 'invalid handler boundaries')
            require(isinstance(calls, dict) and all(isinstance(v, dict) and number(v.get('ms')) and v['ms'] >= 0
                    and type(v.get('n')) is int and v['n'] >= 0 for v in calls.values()), 'invalid aggregate calls')
            require(isinstance(timeline, list) and all(isinstance(c, dict) and isinstance(c.get('name'), str)
                    and number(c.get('at')) and number(c.get('ms')) and c['ms'] >= 0 for c in timeline),
                    'invalid handler intervals')
            trace = s.get('timeline')
            require(isinstance(trace, list) and all(isinstance(t, dict) and isinstance(t.get('name'), str)
                    and number(t.get('at')) and (t.get('ms') is None or number(t.get('ms')) and t['ms'] >= 0)
                    for t in trace), 'invalid trace timeline')
            if s['kind'] == 'groupStart':
                require(bool(timeline) and bool(trace) and calls.get('insertText', {}).get('n') == 1
                        and sum(c['name'] == 'insertText' for c in timeline) == 1, 'missing group-start call/trace coverage')
            validate_sample_contract(s)
        # The reported aggregates must be exactly what the producer derives from these raw samples.
        for kind in COUNTS:
            recomputed = producer_pct([s['keyToFrame'] for s in samples if s['kind'] == kind])
            for k in STATISTICS:
                reported = doc[kind].get(k)
                require(number(reported) and reported == recomputed[k],
                        f'statistic mismatch: {name} {kind}.{k} reported {reported!r}, recomputed {recomputed[k]!r}')
