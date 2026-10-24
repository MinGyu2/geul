#!/usr/bin/env python3
"""Corrected follow-up analyses; never overwrites historical evidence or output."""
import argparse
import hashlib
import json
from pathlib import Path
from d4_evidence import analyze_delay, handler_accounting, validate


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=('input-delay','handler'));p.add_argument('source',type=Path);p.add_argument('output',type=Path)
    a=p.parse_args()
    if a.output.exists():p.error('preserve previous output')
    r=json.loads(a.source.read_text())
    out=dict(source=dict(path=a.source.as_posix(),sha256=hashlib.sha256(a.source.read_bytes()).hexdigest()),
             method='clipped interval union; rounded timings; nested calls never summed; no official remeasurement')
    if a.mode=='input-delay':
        rows=analyze_delay(r)
        out.update(official=False,pairing=validate(r,r['engineIdentity']['wasmSha256'],r['sourceSha256']),
                   rows=rows,slowRows=[x for x in rows if x['deliveryMs']>=50])
    else:
        docs=[]
        for doc in r['measurements']['perf']:
            rows=[handler_accounting(s) for s in doc['timelineSamples'] if s['kind']=='groupStart']
            docs.append(dict(sample=doc['sample'],pages=doc['pages'],rows=rows,
                             negativeArithmeticCount=sum(x['nonexclusiveArithmeticResidualMs']<0 for x in rows)))
        out.update(documents=docs,exclusiveAppJs='UNVERIFIED; uncovered is only rounded selected-probe interval coverage')
    a.output.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
