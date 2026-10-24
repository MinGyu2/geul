#!/usr/bin/env python3
"""D4 follow-up analysis with independently verified fixture/package identities."""
import argparse
import hashlib
import json
from pathlib import Path
from d4_evidence import analyze_delay, handler_accounting, number, validate


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate_identity(folder, expected):
    """The claimed JSON identity is never an expectation or artifact oracle."""
    manifest=json.loads((folder/'ENGINE.json').read_text())
    if not isinstance(manifest,dict) or manifest.get('buildStatus')!='PASS' or manifest.get('sourceStableDuringBuild') is not True:
        raise ValueError('candidate manifest is not a verified build')
    artifacts=manifest.get('artifacts')
    if not isinstance(artifacts,dict): raise ValueError('missing candidate artifacts')
    for name in ('rhwp_bg.wasm','rhwp.js'):
        if not isinstance(artifacts.get(name),str) or digest(folder/name)!=artifacts[name]:
            raise ValueError('candidate artifact digest mismatch: '+name)
    if artifacts['rhwp_bg.wasm']!=expected: raise ValueError('expected WASM does not match verified artifact')
    return dict(wasmSha256=expected,manifestSha256=digest(folder/'ENGINE.json'),glueSha256=artifacts['rhwp.js'])


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=('input-delay','handler'));p.add_argument('source',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--expected-wasm',required=True);p.add_argument('--candidate',required=True,type=Path)
    p.add_argument('--fixture',type=Path);p.add_argument('--legacy',action='store_true',help='analyze missing loss evidence as INCONCLUSIVE, never complete')
    a=p.parse_args()
    if a.output.exists():p.error('preserve previous output')
    if a.mode=='input-delay' and a.fixture is None:p.error('input-delay requires --fixture')
    out=dict(status='FAIL',official=False,method='clipped interval union; nested calls never summed; no official remeasurement')
    exit_code=1
    try:
        raw=a.source.read_bytes();r=json.loads(raw)
        out['source']=dict(path=a.source.as_posix(),sha256=hashlib.sha256(raw).hexdigest())
        out['independentIdentity']=candidate_identity(a.candidate,a.expected_wasm)
        if a.mode=='input-delay':
            source=digest(a.fixture)
            out['independentIdentity']['fixtureSha256']=source
            verdict=validate(r,a.expected_wasm,source,legacy=a.legacy)
            out.update(status=verdict['status'],pairing=verdict)
            if verdict['status']!='FAIL':
                rows=analyze_delay(r);out.update(rows=rows,slowRows=[x for x in rows if x['deliveryMs']>=50])
            exit_code=0 if verdict['status']=='DIAGNOSTIC_COMPLETE' else 2 if verdict['status']=='INCONCLUSIVE' else 1
        else:
            if not isinstance(r,dict) or not isinstance(r.get('measurements'),dict) or not isinstance(r['measurements'].get('perf'),list):
                raise ValueError('missing official perf measurements')
            if not isinstance(r.get('engineIdentity'),dict) or r['engineIdentity'].get('wasmSha256')!=a.expected_wasm:
                raise ValueError('official evidence WASM identity mismatch/unknown')
            docs=[]
            for doc in r['measurements']['perf']:
                if not isinstance(doc,dict) or not isinstance(doc.get('timelineSamples'),list):raise ValueError('invalid perf document')
                groups=[s for s in doc['timelineSamples'] if isinstance(s,dict) and s.get('kind')=='groupStart']
                if len(groups)!=30:raise ValueError('canonical group count')
                for s in groups:
                    if not isinstance(s.get('at'),dict) or not all(number(s['at'].get(k)) for k in ('input','handlerEnd')) or not isinstance(s.get('calls'),dict) or not isinstance(s.get('engineTimeline'),list):
                        raise ValueError('invalid handler boundaries/calls')
                    if not all(isinstance(c,dict) and isinstance(c.get('name'),str) and number(c.get('at')) and number(c.get('ms')) for c in s['engineTimeline']):raise ValueError('invalid handler intervals')
                    if not all(isinstance(v,dict) and number(v.get('ms')) and type(v.get('n')) is int for v in s['calls'].values()):raise ValueError('invalid aggregate calls')
                rows=[handler_accounting(s) for s in groups]
                docs.append(dict(sample=doc.get('sample'),pages=doc.get('pages'),rows=rows,negativeArithmeticCount=sum(x['nonexclusiveArithmeticResidualMs']<0 for x in rows)))
            out.update(status='ANALYZED',documents=docs,exclusiveAppJs='UNVERIFIED; rounded selected-probe coverage')
            exit_code=0
    except (OSError,json.JSONDecodeError,UnicodeDecodeError,ValueError) as error:
        out.update(status='FAIL',error=str(error))
    # Exclusive creation also prevents accidentally replacing a result created meanwhile.
    with a.output.open('x') as target:target.write(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    return exit_code


if __name__=='__main__':raise SystemExit(main())
