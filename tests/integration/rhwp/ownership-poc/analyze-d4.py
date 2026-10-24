#!/usr/bin/env python3
"""D4 follow-up analysis with independently verified fixture/package identities."""
import argparse
import hashlib
import json
from pathlib import Path
from d4_evidence import analyze_delay, handler_accounting, validate
from d4_handler import verified_fixtures, validate_handler


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate_identity(folder, expected, expected_js):
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
    if artifacts['rhwp.js']!=expected_js: raise ValueError('expected JS does not match verified artifact')
    return dict(wasmSha256=expected,manifestSha256=digest(folder/'ENGINE.json'),glueSha256=artifacts['rhwp.js'])


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode',choices=('input-delay','handler'));p.add_argument('source',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--expected-js',required=True,help='trusted JS SHA-256 supplied independently of evidence and package');
    p.add_argument('--fixtures',type=Path,help='independently generated canonical basic-ko fixtures directory (handler)')
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
        out['independentIdentity']=candidate_identity(a.candidate,a.expected_wasm,a.expected_js)
        if a.mode=='input-delay':
            source=digest(a.fixture)
            out['independentIdentity']['fixtureSha256']=source
            verdict=validate(r,a.expected_wasm,source,legacy=a.legacy)
            out.update(status=verdict['status'],pairing=verdict)
            if verdict['status']!='FAIL':
                rows=analyze_delay(r);out.update(rows=rows,slowRows=[x for x in rows if x['deliveryMs']>=50])
            exit_code=0 if verdict['status']=='DIAGNOSTIC_COMPLETE' else 2 if verdict['status']=='INCONCLUSIVE' else 1
        else:
            if a.fixtures is None: raise ValueError('handler requires --fixtures with independently generated basic-ko bytes')
            identities=verified_fixtures(a.fixtures)
            validate_handler(r,a.expected_wasm,identities)
            out['independentIdentity']['fixtures']=identities
            docs=[]
            for doc in r['measurements']['perf']:
                groups=[s for s in doc['timelineSamples'] if s['kind']=='groupStart']
                rows=[handler_accounting(s) for s in groups]
                docs.append(dict(sample=doc['sample'],pages=doc['pages'],fixtureIdentity='VERIFIED',
                    rows=rows,negativeArithmeticCount=sum(x['nonexclusiveArithmeticResidualMs']<0 for x in rows)))
            out.update(status='ANALYZED',documents=docs,exclusiveAppJs='UNVERIFIED; rounded selected-probe coverage')
            exit_code=0
    except (OSError,json.JSONDecodeError,UnicodeDecodeError,ValueError) as error:
        out.update(status='FAIL',error=str(error))
    # Exclusive creation also prevents accidentally replacing a result created meanwhile.
    with a.output.open('x') as target:target.write(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    return exit_code


if __name__=='__main__':raise SystemExit(main())
