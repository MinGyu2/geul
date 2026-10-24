"""Complete official-document handler analysis, independent of D4 gate verdict.

Order/bytes follow undo_native.LARGE, tests/fixtures/rhwp/generate.mjs and
d4-frame-attribution-native.EXPECTED_SOURCE_SHA256. No values come from input JSON.
"""
import hashlib
from collections import Counter
from pathlib import Path
from d4_evidence import number

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = (
    ('basic-ko.hwp', None, '57c901cc394abf6f58f4838315d1ea2c5ecf8a03d9934d3fc098fd8be6e6e12f', 1),
    ('basic-ko.hwpx', None, '26d434b7b427149110751c6ef5b19e9ecb4818f3ba7eadfe201b5afd3de442a8', 1),
    ('연구노트(화학).hwp', 'rnote/연구노트(화학).hwp', '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91', 24),
    ('3249937_asset_management_rules.hwpx', 'issue6031/3249937_asset_management_rules.hwpx', '97b5d6c571a6b7626321c6a53d797e3511978447497bb73309bd23eaa8e7ea77', 60),
)
COUNTS = dict(groupStart=30, extend=30, undo=25, redo=20, afterUndo=5)


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
    require(not result.get('error'), 'recorded harness error')
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
                    and number(s.get('keyToFrame')) and s['keyToFrame'] >= 0
                    and abs(s['keyToFrame'] - (at['end'] - at['key'])) <= .11, 'invalid canonical timeline measurement')
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
                require(Counter(c['name'] for c in timeline) == Counter({name: value['n'] for name, value in calls.items()}),
                        'aggregate/timeline count mismatch')
                keys = ('key', 'input', 'handlerEnd', 'observed', 'raf1', 'end')
                # Native event timestamps can round 1 ms before the key timestamp.
                # Only observation/RAF ordering is a strict same-clock causal chain.
                require(all(number(at.get(k)) for k in keys) and at['input'] >= at['key'] - 2
                        and all(at[a] <= at[b] for a, b in zip(keys[1:], keys[2:])),
                        'invalid group-start timestamps/order')
