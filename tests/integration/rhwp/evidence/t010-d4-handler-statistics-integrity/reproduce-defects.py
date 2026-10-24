#!/usr/bin/env python3
"""P0/P1 false-success reproduction against d4_handler.validate_handler (in-process, no remeasurement).

usage: reproduce-defects.py OFFICIAL.json EXPECTED_WASM GENERATED_FIXTURES OUTPUT.json
Each case mutates a deep copy of genuine complete official evidence; the source file is never written.
ACCEPTED on an invalid mutation is a false success. The WASM expectation is supplied independently.
"""
import copy
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ownership-poc'))
from d4_handler import validate_handler, verified_fixtures  # noqa: E402


def kinds(doc, kind):
    return [s for s in doc['timelineSamples'] if s['kind'] == kind]


def shift(sample, delta):
    """Move one raw sample while keeping keyToFrame == end-key and end >= raf1."""
    sample['keyToFrame'] = round(sample['keyToFrame'] + delta, 1)
    sample['at']['end'] = round(sample['at']['end'] + delta, 1)


def largest(doc, kind):
    return max(kinds(doc, kind), key=lambda s: s['keyToFrame'])


def between(m):
    return m['p50'] + (m['p95'] - m['p50']) / 2 if m['p95'] > m['p50'] else m['p95']


def duplicate(doc):
    groups = kinds(doc, 'groupStart')
    index = doc['timelineSamples'].index(largest(doc, 'groupStart'))
    other = min(groups, key=lambda s: s['keyToFrame'])
    doc['timelineSamples'][index] = copy.deepcopy(other)


def set_ordered(m, value):
    m.update(p50=value, p95=value, max=value)


CASES = {
    'P0': [
        ('measurementComplete=False', lambda r: r.update(measurementComplete=False)),
        ('measurementComplete missing', lambda r: r.pop('measurementComplete')),
        ('measurementComplete=None', lambda r: r.update(measurementComplete=None)),
        ('measurementComplete=0', lambda r: r.update(measurementComplete=0)),
        ('measurementComplete=1', lambda r: r.update(measurementComplete=1)),
        ('measurementComplete="true"', lambda r: r.update(measurementComplete='true')),
        ('measurementComplete=[]', lambda r: r.update(measurementComplete=[])),
    ],
    'P1': [
        ('groupStart.p95 moved between p50 and max', lambda r: r['measurements']['perf'][2]['groupStart'].update(
            p95=between(r['measurements']['perf'][2]['groupStart']))),
        ('groupStart.p50 lowered, order preserved', lambda r: r['measurements']['perf'][0]['groupStart'].update(
            p50=r['measurements']['perf'][0]['groupStart']['p50'] - 1)),
        ('groupStart.max raised, order preserved', lambda r: r['measurements']['perf'][0]['groupStart'].update(
            max=r['measurements']['perf'][0]['groupStart']['max'] + 10)),
        ('groupStart p50=p95=max plausible', lambda r: set_ordered(r['measurements']['perf'][0]['groupStart'], 40)),
        ('undo.p95 altered', lambda r: r['measurements']['perf'][1]['undo'].update(p95=r['measurements']['perf'][1]['undo']['max'])),
        ('redo.p50 altered', lambda r: r['measurements']['perf'][3]['redo'].update(p50=r['measurements']['perf'][3]['redo']['p50'] - 1)),
        ('extend.max altered', lambda r: r['measurements']['perf'][2]['extend'].update(max=r['measurements']['perf'][2]['extend']['max'] + 1)),
        ('afterUndo.p50 altered', lambda r: r['measurements']['perf'][0]['afterUndo'].update(p50=r['measurements']['perf'][0]['afterUndo']['p50'] - 1)),
        ('one groupStart raw sample raised, stale aggregate', lambda r: shift(largest(r['measurements']['perf'][0], 'groupStart'), 25)),
        ('one undo raw sample raised, stale aggregate', lambda r: shift(largest(r['measurements']['perf'][1], 'undo'), 25)),
        ('groupStart raw sample duplicated in place of another', lambda r: duplicate(r['measurements']['perf'][0])),
        ('groupStart raw sample missing', lambda r: r['measurements']['perf'][0]['timelineSamples'].remove(
            kinds(r['measurements']['perf'][0], 'groupStart')[0])),
    ],
}


def main():
    source, wasm, fixtures, output = sys.argv[1], sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
    raw = Path(source).read_bytes()
    original = json.loads(raw)
    identities = verified_fixtures(fixtures)
    rows = {}

    def run(r):
        try:
            validate_handler(r, wasm, identities)
            return dict(result='ACCEPTED')
        except ValueError as error:
            return dict(result='REJECTED', error=str(error))

    rows['unmodified'] = run(copy.deepcopy(original))
    for group, cases in CASES.items():
        for name, mutate in cases:
            r = copy.deepcopy(original)
            mutate(r)
            rows[group + ': ' + name] = run(r)
    out = dict(source=dict(path=source, sha256=hashlib.sha256(raw).hexdigest()), expectedWasm=wasm,
               validatorSha256=hashlib.sha256((Path(__file__).resolve().parents[2] / 'ownership-poc/d4_handler.py').read_bytes()).hexdigest(),
               falseSuccessCount=sum(k != 'unmodified' and v['result'] == 'ACCEPTED' for k, v in rows.items()), cases=rows)
    with output.open('x') as target:
        target.write(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: v['result'] for k, v in rows.items()}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
