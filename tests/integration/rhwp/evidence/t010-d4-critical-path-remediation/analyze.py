"""Independent nearest-rank D4 recomputation and overlap-aware stage attribution.

Input is the unchanged official producer JSON. Signed timestamp offsets survive.
Intervals are synchronous wrapper wall times, not exclusive CPU/GPU measurements.
"""
from pathlib import Path
import argparse
import ast
import hashlib
import importlib.util
import json
import math

# Load the single authority by file: exposing its directory would shadow stdlib typing.
# native_d1_result imports only stdlib modules; no sibling path or sys.modules entry is needed.
_identity_spec = importlib.util.spec_from_file_location(
    '_geul_d4_analyzer_identity',
    Path(__file__).resolve().parents[2] / 'ownership-poc/native_d1_result.py')
_identity = importlib.util.module_from_spec(_identity_spec)
_identity_spec.loader.exec_module(_identity)
SAMPLES = _identity.SAMPLES
FIXTURE_SHA256 = _identity.FIXTURE_SHA256


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


# Mirrors history-perf.classify_result and undo_native.scenario_perf/pct.
# Gate labels repeat across same-suffix documents: mapping is positional, not a set.
COUNTS = {'groupStart': 30, 'extend': 30, 'undo': 25, 'redo': 20, 'afterUndo': 5}
GATE_CONTRACT = (('groupStart', 'group-start key→frame p95 ≤50ms', 50),
                 ('undo', 'Undo p95 ≤1500ms', 1500))


class EvidenceIntegrityError(ValueError):
    """Malformed or contradictory evidence, distinct from a valid D4 FAIL."""


def require(ok, condition):
    if not ok:
        raise EvidenceIntegrityError(condition)


def number(value, field, nullable=False, nonnegative=False):
    if nullable and value is None:
        return
    require(type(value) in (int, float), f'{field}: expected numeric value')
    require(type(value) is int or math.isfinite(value), f'{field}: non-finite number')
    require(not nonnegative or value >= 0, f'{field}: negative duration')


def finite_tree(value, field='producer'):
    if isinstance(value, float):
        require(math.isfinite(value), f'{field}: non-finite number')
    elif isinstance(value, dict):
        for key, child in value.items():
            finite_tree(child, f'{field}.{key}')
    elif isinstance(value, list):
        for index, child in enumerate(value):
            finite_tree(child, f'{field}[{index}]')


def loads_strict(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, f'duplicate JSON key: {key}')
            result[key] = value
        return result
    def constant(name):
        raise EvidenceIntegrityError(f'non-finite JSON number: {name}')
    try:
        result = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError) as error:
        raise EvidenceIntegrityError(f'invalid producer JSON: {error}') from error
    finite_tree(result)  # Also catches exponent overflow (1e999).
    return result


def validate_contract(data):
    """Validate first; neither attribution nor output is produced on integrity failure.

    Complete harness-error measurements remain valid FAIL when classify_result's
    HARNESS_ERROR explains the producer failure. Incomplete measurements cannot be
    independently analyzed as complete evidence. No input values are repaired.
    """
    finite_tree(data)
    require(isinstance(data, dict), 'producer: expected object')
    require(data.get('protocol') == 'unmodified undo_native.scenario_perf/MEASURE', 'protocol mismatch')
    require(data.get('historyEnabled') is True, 'historyEnabled must be true')
    require(data.get('keyDelivery') == 'native X11 xdotool', 'native keyDelivery required')
    require(data.get('measurementComplete') is True, 'measurementComplete must be boolean true')
    require(data.get('status') in ('PASS', 'FAIL'), 'producer status must be PASS or FAIL')
    require(isinstance(data.get('environment'), dict) and data['environment'].get('busyProbe') is False,
            'environment.busyProbe must be false')
    for key, expected in [('warmupGroups', 3), ('groupStartSamplesPerDocument', 30)]:
        require(type(data['environment'].get(key)) is int and data['environment'][key] == expected,
                f'environment.{key}: contradicts measurement contract')
    require(data.get('sourceSha256') == FIXTURE_SHA256[SAMPLES[-1]], 'final sourceSha256 contradicts last document')
    measurements = data.get('measurements')
    require(isinstance(measurements, dict), 'measurements must be an object')
    rows = measurements.get('perf')
    require(isinstance(rows, list) and len(rows) == len(SAMPLES), 'required four measurement documents missing')
    gates = data.get('gates')
    require(isinstance(gates, list) and len(gates) == 8, 'required eight gates missing')
    failures = 0
    for index, (doc, sample_name) in enumerate(zip(rows, SAMPLES)):
        require(isinstance(doc, dict), f'document {index}: expected object')
        require(doc.get('sample') == sample_name, f'document {index}: expected independent document {sample_name}')
        require(doc.get('sourceSha256') == FIXTURE_SHA256[sample_name], f'{sample_name}: source identity mismatch')
        require(type(doc.get('fileBytes')) is int and doc['fileBytes'] > 0, f'{sample_name}: invalid fileBytes')
        require(doc.get('control') == 'normal history' and doc.get('busyProbe') is False,
                f'{sample_name}: control/busyProbe contradict official measurement')
        require(type(doc.get('warmupGroups')) is int and doc['warmupGroups'] == 3,
                f'{sample_name}: warmupGroups contradicts measurement contract')
        samples = doc.get('timelineSamples')
        require(isinstance(samples, list), f'{sample_name}: timelineSamples required')
        require(len(samples) == sum(COUNTS.values()), f'{sample_name}: timeline sample count mismatch')
        for si, sample in enumerate(samples):
            field = f'{sample_name}.timelineSamples[{si}]'
            require(isinstance(sample, dict) and isinstance(sample.get('kind'), str) and sample['kind'] in COUNTS, f'{field}: invalid sample kind')
            number(sample.get('keyToFrame'), field+'.keyToFrame', nonnegative=True)
            at = sample.get('at')
            require(isinstance(at, dict), f'{field}: at required')
            require(set(at) == {'key', 'input', 'handlerEnd', 'observed', 'raf1', 'end'},
                    f'{field}: invalid timestamp fields')
            for key in ('key', 'input', 'handlerEnd', 'observed', 'raf1', 'end'):
                require(key in at, f'{field}.at.{key}: missing')
                number(at[key], f'{field}.at.{key}', nullable=key == 'handlerEnd' and sample['kind'] != 'groupStart')
            require(at['key'] == 0 and at['end'] == sample['keyToFrame'], f'{field}: official end/keyToFrame mismatch')
            require(at['observed'] <= at['raf1'] <= at['end'], f'{field}: revision/RAF order mismatch')
            for timeline_key in ('engineTimeline', 'timeline'):
                timeline = sample.get(timeline_key)
                require(isinstance(timeline, list), f'{field}.{timeline_key}: required list')
                for ci, call in enumerate(timeline):
                    cf = f'{field}.{timeline_key}[{ci}]'
                    require(isinstance(call, dict) and isinstance(call.get('name'), str), f'{cf}: invalid call')
                    require('at' in call and 'ms' in call, f'{cf}: missing timestamp/duration')
                    number(call['at'], cf+'.at', nullable=timeline_key == 'engineTimeline')
                    number(call['ms'], cf+'.ms', nullable=timeline_key == 'timeline', nonnegative=True)
        for kind, count in COUNTS.items():
            values = [s['keyToFrame'] for s in samples if s['kind'] == kind]
            require(len(values) == count, f'{sample_name}.{kind}: sample count {len(values)} != {count}')
            reported = doc.get(kind)
            require(isinstance(reported, dict), f'{sample_name}.{kind}: missing statistics')
            for key, expected in stats(values).items():
                if key == 'min':  # Producer pct does not report min.
                    continue
                value = reported.get(key)
                number(value, f'{sample_name}.{kind}.{key}', nonnegative=True)
                require((type(value) is int if key == 'n' else True) and value == expected,
                        f'{sample_name}.{kind}.{key}: recomputed {expected} != reported {value}')
            require(type(reported.get('timeouts')) is int and reported['timeouts'] == 0,
                    f'{sample_name}.{kind}: timeouts must be integer zero')
        for offset, (kind, label, threshold) in enumerate(GATE_CONTRACT):
            gate = gates[index * 2 + offset]
            gf = f'gates[{index * 2 + offset}] ({sample_name}/{kind})'
            expected = 'PASS' if doc[kind]['p95'] <= threshold else 'FAIL'
            require(isinstance(gate, dict), f'{gf}: invalid gate structure')
            require(gate.get('gate') == 'D4' and gate.get('item') == f'{Path(sample_name).suffix}: {label}',
                    f'{gf}: gate mapping mismatch')
            require(gate.get('result') == expected, f'{gf}: producer gate contradicts recomputed threshold ({expected})')
            # The producer records str(row[kind]); validate that mapping evidence too.
            try:
                detail = ast.literal_eval(gate.get('detail', ''))
            except (ValueError, SyntaxError, TypeError) as error:
                raise EvidenceIntegrityError(f'{gf}: malformed gate detail') from error
            require(detail == doc[kind], f'{gf}: gate detail contradicts document statistics')
            failures += expected == 'FAIL'
    require(type(data.get('failedGateCount')) is int and data['failedGateCount'] == failures,
            f'failedGateCount contradicts gate results: expected {failures}')
    require('error' not in data or isinstance(data['error'], str), 'error must be a producer diagnostic string')
    reason = 'HARNESS_ERROR' if data.get('error') else 'OFFICIAL_GATE_FAILURE' if failures else 'PASS'
    expected_status = 'PASS' if reason == 'PASS' else 'FAIL'
    require(data.get('exitReason') == reason, f'exitReason contradicts acceptance evidence: expected {reason}')
    require(data['status'] == expected_status,
            f'producer status contradicts gates/completion/error: expected {expected_status}')
    return expected_status


def analyze(data):
    verdict = validate_contract(data)
    result = {'measurementComplete': data.get('measurementComplete'), 'producerStatus': data.get('status'),
              'engineIdentity': data.get('engineIdentity'), 'environment': data.get('environment'), 'rows': [],
              'schema': {'clock': 'WebView performance.now and event.timeStamp; signed offsets preserved',
                         'official': 'native keydown -> revision-observing RAF -> two additional RAFs',
                         'percentile': 'nearest rank, ceil(p*n)-1, unchanged',
                         'union': 'per sample, clip synchronous call spans to official [key,end]; merge overlaps, never sum nested APIs',
                         'limits': ['no physical display refresh floor inferred', 'browser decode await is elapsed time, not CPU',
                                    'WASM internal codec/layout and GPU/driver not independently timed',
                                    'no-work RAF probe may include queued rendering', 'timestamp rounding may affect sub-ms spans']}}
    for doc in data['measurements']['perf']:
        samples = doc['timelineSamples']
        official = {}
        for kind in COUNTS:
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
        result['rows'].append(row)
    result['officialVerdict'] = verdict
    finite_tree(result, 'analysis')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('producer', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('preserve earlier analysis')
    data = args.producer.read_bytes()
    try:
        result = analyze(loads_strict(data))
    except EvidenceIntegrityError as error:
        parser.exit(2, f'evidence-integrity failure: {error}\n')
    result['producerSha256'] = hashlib.sha256(data).hexdigest()
    with args.output.open('x') as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    print(result['officialVerdict'])


if __name__ == '__main__':
    main()
