#!/usr/bin/env python3
"""Attribute recorded native D4 group-start samples to consecutive, non-overlapping segments.

Reads an existing D4 producer result (catalog-encoded or plain). It never re-measures and never changes the
official keyToFrame value: segments are differences of the producer's own timestamps. Measured calls are
half-open wall intervals [at, at+ms); occupation is the union of synchronous wrapper intervals clipped to each
segment, so nested wrappers (adapterRenderRequest > pollRenderJob > canvas*) and overlaps count once. Promise
settlement records (*Await/*Rejected) span asynchronous waits and are reported separately, never as sync time.
Wrapper wall time is not engine CPU time. Diagnostic only: not an official D4 result.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

from hash_catalog import decode

SEGMENTS = [('delivery', 'key', 'input'), ('handler', 'input', 'handlerEnd'), ('toObserved', 'handlerEnd', 'observed'),
            ('observedToRaf1', 'observed', 'raf1'), ('raf1ToEnd', 'raf1', 'end')]
BOUNDARIES = ['key', 'input', 'handlerEnd', 'observed', 'raf1', 'end']
ASYNC_SUFFIXES = ('Await', 'Rejected')  # native_probe records these when a promise settles
GROUP_START_LIMIT_MS = 50
PARTITION_TOLERANCE_MS = 0.1  # producer rounds keyToFrame and every timestamp to 0.1 ms independently
SUBTRACTION_CAVEAT = ('arithmetic only: keyToFrame minus clipped sync wrapper occupation per sample. Not a measured latency, '
                      'not a guaranteed best case and not a prediction: removing work changes event, IPC and RAF scheduling.')


def finite(value, what):
    try:
        valid = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid: raise ValueError(f'{what} is not a finite number')
    return value


def pct(values, q):
    """Same nearest-rank rule as the producer (undo_native.pct): v[min(n-1, max(0, ceil(q*n)-1))]."""
    if not values: raise ValueError('no samples')
    ordered = sorted(values); return ordered[min(len(ordered)-1, max(0, math.ceil(q*len(ordered))-1))]


def union(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], end)
        else: merged.append([start, end])
    return merged


def occupied(merged, lo, hi):
    total = 0
    for start, end in merged:
        left, right = max(start, lo), min(end, hi)
        overlap = finite(right-left, 'clipped interval length') if right > left else 0
        total = finite(total+overlap, 'window occupation')
    return total


def calls_of(sample):
    rows = sample.get('engineTimeline')
    if not isinstance(rows, list): raise ValueError('engineTimeline must be a list')
    calls = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('name'), str): raise ValueError('invalid call record')
        at, ms = finite(row.get('at'), 'call start'), finite(row.get('ms'), 'call duration')  # signed offsets allowed
        if ms < 0: raise ValueError('negative call duration')
        end = finite(at+ms, 'call end')
        if end < at: raise ValueError('reversed call interval')
        calls.append((row['name'], at, end))
    return calls


def check_timeline(sample):
    rows = sample.get('timeline')
    if not isinstance(rows, list): raise ValueError('timeline must be a list')
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('name'), str): raise ValueError('invalid timeline record')
        finite(row.get('at'), 'timeline offset')
        if row.get('ms') is not None and finite(row['ms'], 'timeline duration') < 0: raise ValueError('negative timeline duration')
        if row.get('page') is not None and type(row['page']) is not int: raise ValueError('invalid timeline page')


def sample_segments(sample):
    at = sample.get('at')
    if not isinstance(at, dict): raise ValueError('sample timestamps missing')
    points = [finite(at.get(k), f'timestamp {k}') for k in BOUNDARIES]
    if points[0] != 0: raise ValueError('key must be the time origin')
    if any(b < a for a, b in zip(points, points[1:])): raise ValueError('reversed segment boundaries')
    key_to_frame = finite(sample.get('keyToFrame'), 'keyToFrame')
    if key_to_frame < 0: raise ValueError('negative keyToFrame')
    if abs(finite(points[-1]-points[0]-key_to_frame, 'partition difference')) > PARTITION_TOLERANCE_MS: raise ValueError('segments do not partition keyToFrame')
    check_timeline(sample)
    calls = calls_of(sample)
    sync = [(start, end) for name, start, end in calls if not name.endswith(ASYNC_SUFFIXES)]
    merged = union(sync)
    occupation = {name: occupied(merged, at[a], at[b]) for name, a, b in SEGMENTS}
    inside = BOUNDARIES[1:-1]
    others = lambda i: (sync[j] for j in range(len(sync)) if j != i)
    nested = sum(any(s <= start and end <= e for s, e in others(i)) for i, (start, end) in enumerate(sync) if end > start)
    partial = sum(any(s < end and start < e and not (s <= start and end <= e) and not (start <= s and e <= end) for s, e in others(i))
                  for i, (start, end) in enumerate(sync))
    timeline = {t['name']: t['at'] for t in reversed(sample['timeline'])}
    seg = {name: finite(at[b]-at[a], 'segment length') for name, a, b in SEGMENTS}
    for name in seg:
        if occupation[name] < 0 or occupation[name] > seg[name]: raise ValueError('occupation exceeds segment')
    total = finite(sum(occupation.values()), 'total window occupation')
    if total < 0 or total > points[-1]-points[0]: raise ValueError('occupation exceeds window')
    outside = finite(occupied(merged, -math.inf, at['key'])+occupied(merged, at['end'], math.inf), 'outside occupation')
    return {'keyToFrame': key_to_frame, 'segments': seg,
            'syncOccupiedMs': occupation, 'syncOccupiedInWindowMs': total,
            'unattributedMs': {name: seg[name]-occupation[name] for name in seg},
            'syncOutsideWindowMs': outside,
            'callsCrossingSegmentBoundary': sum(any(start < at[b] < end for b in inside) for start, end in sync),
            'callsCrossingWindowEdge': sum(start < at['key'] < end or start < at['end'] < end for start, end in sync),
            'nestedSyncCalls': nested, 'partiallyOverlappingSyncCalls': partial,
            'asyncAwaitRecords': sum(name.endswith(ASYNC_SUFFIXES) for name, _, _ in calls),
            'renderJobs': sum(name == 'beginRenderJob' and at['key'] <= start < at['end'] for name, start, _ in calls),
            'maxPollMs': max([finite(end-start, 'poll duration') for name, start, end in calls if name == 'pollRenderJob' and start < at['end'] and end > at['key']], default=0),
            'raf1AfterKeyupMs': None if 'dom:keyup' not in timeline else finite(at['raf1']-timeline['dom:keyup'], 'keyup offset'),
            'raf1AfterCommitAckMs': None if 'rhwp:commit-ack' not in timeline else finite(at['raf1']-timeline['rhwp:commit-ack'], 'commit offset')}


def summarize(perf):
    if not isinstance(perf.get('timelineSamples'), list): raise ValueError('timelineSamples must be a list')
    rows = [sample_segments(s) for s in perf['timelineSamples'] if isinstance(s, dict) and s.get('kind') == 'groupStart']
    if len(rows) != perf['groupStart']['n']: raise ValueError('timeline sample count differs from groupStart n')
    failing = [r for r in rows if r['keyToFrame'] > GROUP_START_LIMIT_MS]
    dominant = {}
    for r in failing:
        name = max(r['segments'], key=r['segments'].get); dominant[name] = dominant.get(name, 0)+1
    two = lambda x: round(x, 2)
    dist = lambda key: {'p50': two(pct([key(r) for r in rows], .5)), 'p95': two(pct([key(r) for r in rows], .95)), 'max': two(max(key(r) for r in rows))}
    complete = lambda key: all(r[key] is not None for r in rows)
    subtracted = [finite(r['keyToFrame']-r['syncOccupiedInWindowMs'], 'arithmetic subtraction') for r in rows]
    return {'sample': perf['sample'], 'n': len(rows), 'failingOverLimit': len(failing),
            'producerGroupStart': perf['groupStart'], 'diagnosticKeyToFrame': dist(lambda r: r['keyToFrame']),
            'zeroWorkFrameFloorMs': perf['zeroWorkFrameFloorMs'],
            'frameGapDuringHistoryAndFollowingInputMs': perf['frameGapDuringHistoryAndFollowingInputMs'],
            'segmentsMs': {name: dist(lambda r, n=name: r['segments'][n]) for name, _, _ in SEGMENTS},
            'dominantSegmentInFailingSamples': dominant,
            'syncWrapperOccupiedMs': {name: dist(lambda r, n=name: r['syncOccupiedMs'][n]) for name, _, _ in SEGMENTS}
                | {'keyToFrameWindow': dist(lambda r: r['syncOccupiedInWindowMs'])},
            'unattributedMs': {name: dist(lambda r, n=name: r['unattributedMs'][n]) for name, _, _ in SEGMENTS},
            'syncWrapperOutsideWindowMs': dist(lambda r: r['syncOutsideWindowMs']),
            'callsCrossingSegmentBoundary': sum(r['callsCrossingSegmentBoundary'] for r in rows),
            'callsCrossingWindowEdge': sum(r['callsCrossingWindowEdge'] for r in rows),
            'nestedSyncCalls': sum(r['nestedSyncCalls'] for r in rows),
            'partiallyOverlappingSyncCalls': sum(r['partiallyOverlappingSyncCalls'] for r in rows),
            'asyncAwaitRecords': sum(r['asyncAwaitRecords'] for r in rows), 'invalidRecords': 0,
            'maxSynchronousPollMs': dist(lambda r: r['maxPollMs']),
            'renderJobsPerInput': {str(k): sum(r['renderJobs'] == k for r in rows) for k in sorted({r['renderJobs'] for r in rows})},
            'raf1AfterKeyupMs': dist(lambda r: r['raf1AfterKeyupMs']) if complete('raf1AfterKeyupMs') else 'UNAVAILABLE',
            'raf1AfterCommitAckMs': dist(lambda r: r['raf1AfterCommitAckMs']) if complete('raf1AfterCommitAckMs') else 'UNAVAILABLE',
            'arithmeticSubtraction': {'keyToFrameMinusSyncOccupationP95Ms': two(pct(subtracted, .95)),
                                      'samplesStillOverLimit': sum(x > GROUP_START_LIMIT_MS for x in subtracted)}}


def reject_constant(name):
    raise ValueError(f'non-standard JSON constant {name}')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve previous analysis')
    source = a.input.read_bytes(); value = decode(json.loads(source.decode('utf-8'), parse_constant=reject_constant))
    data = value['result']['data'] if 'result' in value else value
    if data.get('measurementComplete') is not True: raise ValueError('producer measurement incomplete')
    out = {'inputSha256': hashlib.sha256(source).hexdigest(), 'official': False, 'protocol': data['protocol'],
           'engineIdentity': data['engineIdentity'], 'producerExitReason': data['exitReason'], 'failedGateCount': data['failedGateCount'],
           'scope': 'attribution of recorded samples; official keyToFrame/gates unchanged; segments are consecutive timestamp differences',
           'measured': 'synchronous JS wrapper wall time (union, clipped); not engine CPU; async awaits excluded',
           'percentile': 'nearest-rank ceil(q*n)-1 as in the producer; diagnostic summary, not the official statistic',
           'arithmeticSubtractionCaveat': SUBTRACTION_CAVEAT,
           'documents': [summarize(perf) for perf in data['measurements']['perf']]}
    with open(a.output, 'x', encoding='utf-8') as f: f.write(json.dumps(out, ensure_ascii=False, indent=1, allow_nan=False)+'\n')


if __name__ == '__main__': main()
