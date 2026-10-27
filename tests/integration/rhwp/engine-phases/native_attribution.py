#!/usr/bin/env python3
"""Attribute recorded native D4 group-start samples to consecutive, non-overlapping segments.

Reads an existing D4 producer result (catalog-encoded or plain). It never re-measures and never changes the
official keyToFrame value: segments are differences of the producer's own timestamps, and engine JS time
counts only top-level adapter calls (adapterRenderRequest wraps pollRenderJob; canvas* are nested in it).
"""
import argparse
import hashlib
import json
from pathlib import Path

from hash_catalog import decode

SEGMENTS = [('delivery', 'key', 'input'), ('handler', 'input', 'handlerEnd'), ('toObserved', 'handlerEnd', 'observed'),
            ('observedToRaf1', 'observed', 'raf1'), ('raf1ToEnd', 'raf1', 'end')]
GROUP_START_LIMIT_MS = 50


def pct(values, q):
    """Nearest-rank on the recorded samples; matches the producer's small-sample reporting closely enough for attribution."""
    if not values: raise ValueError('no samples')
    ordered = sorted(values); return ordered[min(len(ordered)-1, round(q*(len(ordered)-1)))]


def nested(call):
    return call['name'] == 'adapterRenderRequest' or call['name'].startswith('canvas')


def sample_segments(sample):
    at = sample.get('at') or {}
    if any(type(at.get(k)) not in (int, float) for _, a, b in SEGMENTS for k in (a, b)):
        raise ValueError('sample timestamps incomplete')
    segments = {name: at[b]-at[a] for name, a, b in SEGMENTS}
    if any(v < 0 for v in segments.values()): raise ValueError('non-monotonic sample timestamps')
    if abs(sum(segments.values())-sample['keyToFrame']) > 1: raise ValueError('segments do not partition keyToFrame')
    calls = [c for c in sample['engineTimeline'] if c.get('at') is not None and not nested(c)]
    window = lambda lo, hi: sum(c['ms'] for c in calls if at[lo] <= c['at'] < at[hi])
    timeline = {t['name']: t['at'] for t in reversed(sample['timeline'])}
    return {'keyToFrame': sample['keyToFrame'], 'segments': segments, 'engineJsInHandlerMs': window('input', 'handlerEnd'),
            'engineJsObservedToRaf1Ms': window('observed', 'raf1'), 'engineJsBeforeEndMs': window('key', 'end'),
            'renderJobs': sum(c['name'] == 'beginRenderJob' and c['at'] < at['end'] for c in calls),
            'maxPollMs': max([c['ms'] for c in calls if c['name'] == 'pollRenderJob' and c['at'] < at['end']], default=0),
            'raf1AfterKeyupMs': None if 'dom:keyup' not in timeline else at['raf1']-timeline['dom:keyup'],
            'raf1AfterCommitAckMs': None if 'rhwp:commit-ack' not in timeline else at['raf1']-timeline['rhwp:commit-ack']}


def summarize(perf):
    rows = [sample_segments(s) for s in perf['timelineSamples'] if s['kind'] == 'groupStart']
    if len(rows) != perf['groupStart']['n']: raise ValueError('timeline sample count differs from groupStart n')
    failing = [r for r in rows if r['keyToFrame'] > GROUP_START_LIMIT_MS]
    dominant = {}
    for r in failing:
        name = max(r['segments'], key=r['segments'].get); dominant[name] = dominant.get(name, 0)+1
    dist = lambda key: {q: pct([key(r) for r in rows], v) for q, v in [('p50', .5), ('p95', .95)]} | {'max': max(key(r) for r in rows)}
    observed = lambda key: [r[key] for r in rows if r[key] is not None]
    return {'sample': perf['sample'], 'n': len(rows), 'failingOverLimit': len(failing),
            'producerGroupStart': perf['groupStart'], 'zeroWorkFrameFloorMs': perf['zeroWorkFrameFloorMs'],
            'frameGapDuringHistoryAndFollowingInputMs': perf['frameGapDuringHistoryAndFollowingInputMs'],
            'segmentsMs': {name: dist(lambda r, n=name: r['segments'][n]) for name, _, _ in SEGMENTS},
            'dominantSegmentInFailingSamples': dominant,
            'engineJsInHandlerMs': dist(lambda r: r['engineJsInHandlerMs']),
            'nonEngineHandlerMs': dist(lambda r: r['segments']['handler']-r['engineJsInHandlerMs']),
            'engineJsObservedToRaf1Ms': dist(lambda r: r['engineJsObservedToRaf1Ms']),
            'maxSynchronousPollMs': dist(lambda r: r['maxPollMs']),
            'renderJobsBeforeEnd': {str(k): sum(r['renderJobs'] == k for r in rows) for k in sorted({r['renderJobs'] for r in rows})},
            'raf1AfterKeyupMs': dist(lambda r: r['raf1AfterKeyupMs']) if len(observed('raf1AfterKeyupMs')) == len(rows) else 'UNAVAILABLE',
            'raf1AfterCommitAckMs': dist(lambda r: r['raf1AfterCommitAckMs']) if len(observed('raf1AfterCommitAckMs')) == len(rows) else 'UNAVAILABLE',
            # Counterfactual bound only: subtracting overlapping-free top-level engine JS from each sample. Frames are
            # quantized, so real savings may be smaller or larger; this is not a measurement.
            'keyToFrameMinusAllEngineJsP95Ms': pct([r['keyToFrame']-r['engineJsBeforeEndMs'] for r in rows], .95),
            'samplesStillOverLimitWithZeroEngineJs': sum(r['keyToFrame']-r['engineJsBeforeEndMs'] > GROUP_START_LIMIT_MS for r in rows)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve previous analysis')
    source = a.input.read_bytes(); value = decode(json.loads(source.decode('utf-8')))
    data = value['result']['data'] if 'result' in value else value
    if data.get('measurementComplete') is not True: raise ValueError('producer measurement incomplete')
    out = {'inputSha256': hashlib.sha256(source).hexdigest(), 'official': False, 'protocol': data['protocol'],
           'engineIdentity': data['engineIdentity'], 'producerExitReason': data['exitReason'], 'failedGateCount': data['failedGateCount'],
           'scope': 'attribution of recorded samples; official keyToFrame/gates unchanged; segments are consecutive timestamp differences',
           'documents': [summarize(perf) for perf in data['measurements']['perf']]}
    with open(a.output, 'x', encoding='utf-8') as f: f.write(json.dumps(out, ensure_ascii=False, indent=1)+'\n')


if __name__ == '__main__': main()
