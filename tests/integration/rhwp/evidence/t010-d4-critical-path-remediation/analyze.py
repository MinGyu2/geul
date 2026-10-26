"""Independent nearest-rank D4 recomputation and overlap-aware stage attribution.

Input is the unchanged official producer JSON. Signed timestamp offsets survive.
Intervals are synchronous wrapper wall times, not exclusive CPU/GPU measurements.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math


def stats(values):
    values = sorted(values)
    if not values:
        return {'n': 0}
    return {'n': len(values), 'min': values[0],
            'p50': values[math.ceil(.50 * len(values)) - 1],
            'p95': values[math.ceil(.95 * len(values)) - 1], 'max': values[-1]}


def union_ms(spans, end):
    spans = sorted((max(0, a), min(end, b)) for a, b in spans if b > 0 and a < end)
    total, previous = 0, None
    for a, b in spans:
        if b <= a:
            continue
        if previous is None:
            previous = (a, b)
        elif a <= previous[1]:
            previous = (previous[0], max(previous[1], b))
        else:
            total += previous[1] - previous[0]
            previous = (a, b)
    return round(total + (previous[1] - previous[0] if previous else 0), 2)


STAGES = {
    'snapshot': {'saveSnapshot', 'discardSnapshot', 'snapshotCapacity'},
    'mutation': {'insertText', 'insertTextInCell', 'deleteText', 'deleteTextInCell', 'splitParagraph', 'splitParagraphInCell'},
    'pageAndGeometryQueries': {'pageCount', 'getPageInfo', 'getCursorRect', 'getCursorRectInCell', 'getParagraphLength', 'getCellParagraphLength'},
    'jobCreation': {'beginRenderJob', 'beginRenderPatchJob'},
    'jobPollingIncludesLayoutCodecReplay': {'pollRenderJob'},
    'canvasReplayNestedInJob': {'canvasOffscreenDraw', 'canvasVisibleDraw', 'canvasReadback'},
    'browserDecodeAwaitNotExclusiveCPU': {'createImageBitmapAwait', 'imageDecodeAwait', 'createImageBitmapRejected', 'imageDecodeRejected'},
    'explicitLegacyLayoutCalls': {'getPageLayerTreeWithProfile', 'getPageRenderTree', 'getPageTextLayout', 'getPageControlLayout'},
}


def analyze(data):
    result = {'measurementComplete': data.get('measurementComplete'), 'producerStatus': data.get('status'),
              'engineIdentity': data.get('engineIdentity'), 'environment': data.get('environment'), 'rows': [],
              'schema': {'clock': 'WebView performance.now and event.timeStamp; signed offsets preserved',
                         'official': 'native keydown -> revision-observing RAF -> two additional RAFs',
                         'percentile': 'nearest rank, ceil(p*n)-1, unchanged',
                         'union': 'per sample, clip synchronous call spans to official [key,end]; merge overlaps, never sum nested APIs',
                         'limits': ['no physical display refresh floor inferred', 'browser decode await is elapsed time, not CPU',
                                    'WASM internal codec/layout and GPU/driver not independently timed',
                                    'no-work RAF probe may include queued rendering', 'timestamp rounding may affect sub-ms spans']}}
    official_pass = data.get('measurementComplete') is True and len(data['measurements']['perf']) == 4
    for doc in data['measurements']['perf']:
        samples = doc['timelineSamples']
        official = {}
        for kind, count in [('groupStart', 30), ('extend', 30), ('undo', 25), ('redo', 20), ('afterUndo', 5)]:
            values = [s['keyToFrame'] for s in samples if s['kind'] == kind]
            recomputed = stats(values)
            assert len(values) == count, (doc['sample'], kind, len(values))
            assert all(recomputed[k] == doc[kind][k] for k in ['n', 'p50', 'p95', 'max']), (doc['sample'], kind, recomputed, doc[kind])
            assert doc[kind]['timeouts'] == 0
            official[kind] = {k: doc[kind][k] for k in ['n', 'p50', 'p95', 'max', 'timeouts']}
        groups = [s for s in samples if s['kind'] == 'groupStart']
        intervals = {'keyToInput': [], 'inputThroughHandlerEnd': [], 'handlerEndToObservedRevision': [], 'observedThroughTwoRafs': []}
        per_stage = {k: [] for k in STAGES}
        per_call = {}
        signed_anomalies = []
        correlations = []
        for index, sample in enumerate(groups):
            at, end = sample['at'], sample['at']['end']
            for name, value in [('keyToInput', at['input']), ('inputThroughHandlerEnd', at['handlerEnd'] - at['input']),
                                ('handlerEndToObservedRevision', at['observed'] - at['handlerEnd']),
                                ('observedThroughTwoRafs', end - at['observed'])]:
                intervals[name].append(value)
            for key, value in at.items():
                if value is not None and value < 0:
                    signed_anomalies.append({'sampleIndex': index, 'field': key, 'ms': value})
            spans_by_name = {}
            all_sync = []
            for call in sample['engineTimeline']:
                if call['at'] is None:
                    continue
                span = (call['at'], call['at'] + call['ms'])
                spans_by_name.setdefault(call['name'], []).append(span)
                per_call.setdefault(call['name'], []).append(call['ms'])
                if 'Await' not in call['name'] and 'Rejected' not in call['name']:
                    all_sync.append(span)
            stages = {}
            for name, calls in STAGES.items():
                stages[name] = union_ms([span for call in calls for span in spans_by_name.get(call, [])], end)
                per_stage[name].append(stages[name])
            correlations.append({'sampleIndex': index, 'officialMs': sample['keyToFrame'], 'officialFail': sample['keyToFrame'] > 50,
                                 'at': at, 'stageUnionMs': stages, 'knownSyncUnionMs': union_ms(all_sync, end)})
        failed = [s for s in correlations if s['officialFail']]
        row = {'sample': doc['sample'], 'sourceSha256': doc['sourceSha256'], 'fileBytes': doc['fileBytes'], 'official': official,
               'intervalsMs': {k: stats(v) for k, v in intervals.items()},
               'stagePerGroupUnionMs': {k: stats(v) for k, v in per_stage.items()},
               'individualSyncAndAwaitCallsMs': {k: stats(v) for k, v in per_call.items()},
               'overlapWithFailingSamples': {k: {'failingSampleCount': len(failed), 'presentCount': sum(s['stageUnionMs'][k] > 0 for s in failed),
                                                'p95MsWithinFailingSamples': stats([s['stageUnionMs'][k] for s in failed]).get('p95')} for k in STAGES},
               'negativeTimestampOffsets': signed_anomalies, 'groupCorrelations': correlations,
               'adapterCounters': doc.get('adapterCounters')}
        official_pass &= official['groupStart']['p95'] <= 50 and official['undo']['p95'] <= 1500
        result['rows'].append(row)
    result['officialVerdict'] = 'PASS' if official_pass else 'FAIL'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('producer', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('preserve earlier analysis')
    data = args.producer.read_bytes()
    result = analyze(json.loads(data))
    result['producerSha256'] = hashlib.sha256(data).hexdigest()
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(result['officialVerdict'])


if __name__ == '__main__':
    main()
