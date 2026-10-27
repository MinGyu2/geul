#!/usr/bin/env python3
"""Summarize diagnostic wall spans without adding nested work twice."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import statistics

from run import validate
from hash_catalog import decode


def exclusive(phases):
    result = defaultdict(lambda: {'inclusiveWallMs': 0, 'selfWallMs': 0, 'calls': 0})
    for phase in phases:
        intervals = sorted((p['at'], p['at'] + p['ms']) for p in phases if p['parent'] == phase['id'])
        covered = 0; end = None
        for start, stop in intervals:
            covered += max(0, stop - max(start, end if end is not None else start))
            end = max(stop, end if end is not None else stop)
        own = phase['ms'] - covered
        if own < -0.01: raise ValueError('children exceed parent')
        row = result[phase['name']]
        row['inclusiveWallMs'] += phase['ms']; row['selfWallMs'] += max(0, own); row['calls'] += 1
    return dict(result)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists(): p.error('preserve previous analysis')
    source = a.input.read_bytes(); run = decode(json.loads(source)); validate(run)
    if run.get('executedDependenciesStable') is not True: raise ValueError('dependencies changed')
    groups = defaultdict(list)
    for row in run['rows']: groups[(row['sample'], row['page'])].append(row)
    rows = []
    for (sample, page), group in groups.items():
        detail = []
        for row in group:
            detail.append({'trial': row['trial'], 'phases': exclusive(row['arms']['on']['phases'])})
        rows.append({'sample': sample, 'page': page,
            'medianWallMs': {arm: statistics.median(r['arms'][arm]['ms'] for r in group) for arm in run.get('requestConfig', {}).get('arms', ['baseline', 'off', 'on'])},
            'disabledInstrumentationDeltaMs': [r['arms']['off']['ms'] - r['arms']['baseline']['ms'] for r in group],
            'enabledInstrumentationDeltaMs': [r['arms']['on']['ms'] - r['arms']['off']['ms'] for r in group],
            'candidateDeltaMs': [r['arms']['candidate']['ms'] - r['arms']['baseline']['ms'] for r in group] if 'candidate' in group[0]['arms'] else None,
            'trials': detail})
    a.output.write_text(json.dumps({'inputSha256': hashlib.sha256(source).hexdigest(), 'official': False,
        'scope': 'real-time browser diagnostic, recorded trial count; wall time includes instrumentation, not CPU; first pass cold, subsequent natural caches',
        'browserBackend': run.get('browserBackend', 'chrome'),
        'nestedAccounting': 'selfWallMs subtracts direct-child interval union; never sum inclusive parents and children', 'rows': rows}, indent=2)+'\n')


if __name__ == '__main__': main()
