"""Revalidate preserved raw evidence; exclusively write a compact new replay result.

Run from any directory: python3 <this-file> <new-output.json>.
No native process is launched. Summaries supply recorded hashes, never samples.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PREVIOUS = HERE.parent / 't010-d4-critical-path-remediation'
sys.path.insert(0, str(PREVIOUS))
from analyze import analyze, loads_strict, require


def replay():
    results = []
    for attempt, name in [(1, 'native-attribution.json'), (2, 'native-attribution-attempt2.json')]:
        summary = loads_strict((PREVIOUS/f'native-d4-off-attempt{attempt}-summary.json').read_bytes())
        raw = (ROOT/'.git/t010-d4-critical-path-remediation-raw'/f'native-d4-off-attempt{attempt}.json').read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        require(digest == summary['rawSha256'], f'attempt{attempt}: raw identity mismatch')
        producer = loads_strict(raw)
        result = analyze(producer)
        previous = loads_strict((PREVIOUS/name).read_bytes())
        require(previous['producerSha256'] == digest, f'attempt{attempt}: prior analysis raw identity mismatch')
        require(result['officialVerdict'] == producer['status'] == summary['status'] == 'FAIL', 'verdict changed')
        require(len(result['rows']) == len(previous['rows']) == 4, 'attribution row count changed')
        # attempt2 archived aggregate attribution only; compare every recorded field.
        for row, recorded in zip(result['rows'], previous['rows']):
            require(all(row[k] == v for k, v in recorded.items()), f"{row['sample']}: recorded attribution changed")
        results.append(dict(attempt=attempt, rawSha256=digest, rawIdentity='PASS',
            producerStatus=producer['status'], officialVerdict=result['officialVerdict'],
            measurementComplete=producer['measurementComplete'], failedGateCount=producer['failedGateCount'],
            gateResults=[g['result'] for g in producer['gates']], recordedAttributionEquality='PASS',
            countsPercentilesTimeouts='PASS', signedOffsetsPreserved='PASS', overlapUnionUnchanged='PASS',
            rows=[dict(sample=row['sample'], official=row['official'],
                       negativeTimestampOffsets=row['negativeTimestampOffsets']) for row in result['rows']]))
    return dict(scope='independent historical raw replay, no new native performance run', attempts=results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('preserve earlier replay results')
    result = replay()
    with args.output.open('x') as stream:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n')
    print('Integrity PASS; historical D4 FAIL (both attempts)')


if __name__ == '__main__':
    main()
