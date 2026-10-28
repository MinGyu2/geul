"""Descriptive D4 timeline samples; rounded/overlapping probes are not causal attribution."""
import json
import math
import sys
from pathlib import Path

def stats(values):
    values = sorted(values)
    if not values:
        return {'n': 0}
    return {'n': len(values), 'p50': values[math.ceil(len(values) * .5) - 1],
            'p95': values[math.ceil(len(values) * .95) - 1], 'max': values[-1]}

def main():
    src = Path(sys.argv[1]); output = Path(sys.argv[2])
    d = json.loads(src.read_text())
    rows = []
    for doc in d['measurements']['perf']:
        samples = [s for s in doc['timelineSamples'] if s['kind'] == 'groupStart']
        def call(name):
            return [s['calls'][name]['ms'] for s in samples if name in s['calls']]
        def interval(a, b):
            return [s['at'][b] - s['at'][a] for s in samples if a in s['at'] and b in s['at']]
        rows.append({'sample': doc['sample'], 'n': len(samples), 'keydown_to_input_ms': stats(interval('key', 'input')),
                     'input_to_handler_end_ms': stats(interval('input', 'handlerEnd')),
                     'handler_end_to_frame_ms': stats(interval('handlerEnd', 'end')),
                     'insertText_ms': stats(call('insertText')), 'pollRenderJob_ms': stats(call('pollRenderJob')),
                     'adapterRenderRequest_ms': stats(call('adapterRenderRequest')),
                     'adapterCounters': doc.get('adapterCounters')})
    output.write_text(json.dumps({'scope': 'rounded groupStart probes; call intervals overlap, not causal attribution',
                                  'source': str(src), 'rows': rows}, ensure_ascii=False, indent=2) + '\n')

if __name__ == '__main__': main()
