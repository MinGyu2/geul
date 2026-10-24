#!/usr/bin/env python3
"""D4 follow-up analysis with independently verified fixture/package identities."""
import argparse
import hashlib
import json
from pathlib import Path
from d4_evidence import analyze_delay, handler_accounting, validate, number, verify_finite_tree
from d4_handler import verified_fixtures, validate_handler


# Historical official inputs are <4 MiB and depth <16. Leave ample room for
# full four-document runs while bounding parser memory/recursion exposure.
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_JSON_DEPTH = 64


def strict_json(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n'


def read_json(path):
    with path.open('rb') as source:
        raw = source.read(MAX_JSON_BYTES+1)
    if len(raw) > MAX_JSON_BYTES: raise ValueError('JSON exceeds 32 MiB limit')
    text = raw.decode('utf-8')
    depth=0; quoted=False; escaped=False
    for char in text:
        if quoted:
            if escaped: escaped=False
            elif char == '\\': escaped=True
            elif char == '"': quoted=False
        elif char == '"': quoted=True
        elif char in '[{':
            depth+=1
            if depth > MAX_JSON_DEPTH: raise ValueError('JSON exceeds depth 64 limit')
        elif char in ']}': depth-=1
    def pairs(items):
        out={}
        for key,value in items:
            if key in out: raise ValueError('duplicate JSON object key: '+ascii(key))
            out[key]=value
        return out
    def constant(value): raise ValueError('non-standard JSON constant: '+value)
    result=json.loads(text,object_pairs_hook=pairs,parse_constant=constant)
    pending=[result]
    while pending:
        value=pending.pop()
        if isinstance(value,dict): pending.extend(value.keys());pending.extend(value.values())
        elif isinstance(value,list): pending.extend(value)
        elif isinstance(value,str): value.encode('utf-8')
        elif type(value) in (float,int) and not number(value): raise ValueError('non-finite JSON number')
    return raw,result


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate_identity(folder, expected, expected_js):
    """The claimed JSON identity is never an expectation or artifact oracle."""
    _,manifest=read_json(folder/'ENGINE.json')
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
        raw,r=read_json(a.source)
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
        verify_finite_tree(out)
    except (OSError,UnicodeError,ValueError,RecursionError,OverflowError,TypeError,KeyError) as error:
        out.update(status='FAIL',error=str(error))
        exit_code=1
    try:
        serialized=strict_json(out)
        serialized.encode('utf-8')
    except (ValueError,OverflowError,UnicodeError,RecursionError) as error:
        out=dict(status='FAIL',official=False,error='invalid analysis serialization: '+ascii(str(error)))
        serialized=strict_json(out);exit_code=1
    # Exclusive creation also prevents accidentally replacing a result created meanwhile.
    try:
        with a.output.open('x',encoding='utf-8') as target:target.write(serialized)
    except OSError as error:
        p.exit(1, 'cannot create analysis output: '+str(error)+'\n')
    return exit_code


if __name__=='__main__':raise SystemExit(main())
