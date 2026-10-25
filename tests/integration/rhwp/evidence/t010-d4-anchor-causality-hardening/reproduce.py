"""Genuine official JSON and anchor-causality mutations through the real handler CLI.

Usage: python3 reproduce.py [--original] OUTPUT_DIRECTORY
--original runs b80892d's analyzer files from a scratch copy (ROOT patched only).
Candidate identities are independent constants from committed prior evidence
(t010-d4-performance-remediation/identities.json, t010-d4-handler-integrity-hardening).
"""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[5]
POC=ROOT/'tests/integration/rhwp/ownership-poc'
HIST=Path('tests/integration/rhwp/evidence/t010-d4-performance-remediation')
ORIGINAL='b80892d41a65facb8738917239d72ae6d3aaf556'
JS='b69e920c8fb1e9d05dacadf3ebae2396b043da385137ad2b4b3386a9b3433252'
RECORDS=(('baseline-official-frozen-comparison.json','/tmp/geul-t010-caret-geometry/candidate-package','48adaa0f748484d12f59f4805deda0480635f915368392a87e76e95962ec0b27'),
         ('optimized-official-retry.json','/tmp/geul-d4-remediation-gray/candidate-package','ae34c12bd0d20aeb9f94610682bc678ec61f55722df74ea946d09782d7c87983'))


def first(r,kind):return next(s for s in r['measurements']['perf'][0]['timelineSamples'] if s['kind']==kind)
def trace(s,record,index=0):s['timeline'].insert(index,dict(record,ms=None,page=None))
def call(s,name,at):
    # Identity, not list index: the first entry of a name is the firstAt source.
    c=next(c for c in s['engineTimeline'] if c['name']==name);c['at']=at;s['calls'][name]['firstAt']=at
def anchor(s):return next(t for t in s['timeline'] if t['name']==('command:request' if s['kind'] in ('undo','redo') else 'dom:input'))
def reported(s):trace(s,dict(name='dom:input',at=-10000));call(s,'insertText',-9999)
def duplicate(s):a=anchor(s);trace(s,a,s['timeline'].index(a)+1)
def fabricated(s):trace(s,dict(name='dom:keydown',at=-10001));trace(s,dict(name='command:request',at=-10000),1);call(s,'restoreSnapshot',-9999)

MUTATIONS={
    'early-input-anchor':lambda r:trace(first(r,'groupStart'),dict(name='dom:input',at=-10000)),
    'early-insertText-call':lambda r:call(first(r,'groupStart'),'insertText',-9999),
    'anchor-and-call':lambda r:reported(first(r,'groupStart')),
    'duplicate-input-anchor':lambda r:duplicate(first(r,'groupStart')),
    'duplicate-command-anchor':lambda r:duplicate(first(r,'redo')),
    'fabricated-command-anchor':lambda r:fabricated(first(r,'undo')),
    'in-tolerance-input-anchor':lambda r:(trace(first(r,'groupStart'),dict(name='dom:input',at=first(r,'groupStart')['at']['input']-2)),
                                          call(first(r,'groupStart'),'insertText',first(r,'groupStart')['at']['input']-1.9)),
    'in-tolerance-command-anchor':lambda r:(trace(first(r,'undo'),dict(name='command:request',at=-3)),call(first(r,'undo'),'restoreSnapshot',-2.9)),
}

original='--original' in sys.argv
output=Path(sys.argv[-1]).resolve();output.mkdir(parents=True,exist_ok=False)
with tempfile.TemporaryDirectory() as temp:
    work=Path(temp);fixtures=work/'fixtures'
    subprocess.run(['node',str(ROOT/'tests/fixtures/rhwp/generate.mjs'),str(fixtures)],check=True,capture_output=True)
    cli=POC/'analyze-d4.py'
    if original:
        code=work/'original';code.mkdir()
        for name in ('analyze-d4.py','d4_handler.py','d4_evidence.py'):
            (code/name).write_bytes(subprocess.check_output(['git','show',ORIGINAL+':'+str((POC/name).relative_to(ROOT))],cwd=ROOT))
        handler=code/'d4_handler.py';handler.write_text(handler.read_text().replace('ROOT = Path(__file__).resolve().parents[4]',f'ROOT = Path({str(ROOT)!r})'))
        cli=code/'analyze-d4.py'
    def run(source,target,package,wasm,cwd):
        p=subprocess.run(['python3','-E','-s',str(cli),'handler',str(source),str(target),'--candidate',package,'--expected-wasm',wasm,
                          '--expected-js',JS,'--fixtures',str(fixtures)],cwd=cwd,text=True,capture_output=True)
        target=Path(cwd)/target
        text=target.read_text() if target.exists() else None
        def constant(v):raise ValueError('non-standard JSON constant '+v)
        return p,text,(json.loads(text,parse_constant=constant) if text else None)
    results=[]
    for index,(name,package,wasm) in enumerate(RECORDS):
        raw=(ROOT/HIST/name).read_bytes();record=json.loads(raw)
        # Genuine record: repository-relative source path, analysis kept in full.
        p,_,out=run(HIST/name,output/f'{index}-genuine.json',package,wasm,ROOT)
        results.append(dict(record=name,case='genuine',exit=p.returncode,status=out['status'],error=out.get('error'),traceback='Traceback' in p.stderr))
        cases=MUTATIONS if index==0 else {k:MUTATIONS[k] for k in ('anchor-and-call','fabricated-command-anchor')}
        for label,mutate in cases.items():
            r=copy.deepcopy(record);mutate(r);data=json.dumps(r)
            case=work/f'{index}-{label}';case.mkdir();(case/'input.json').write_text(data)
            p,text,out=run('input.json','analysis.json',package,wasm,case)
            row=out['documents'][0]['rows'][0] if out and out.get('documents') else None
            results.append(dict(record=name,case=label,exit=p.returncode,status=out and out['status'],error=out and out.get('error'),
                                strictJson=text is not None,traceback='Traceback' in p.stderr,inputUnchanged=(case/'input.json').read_text()==data,
                                firstGroupStartRow=None if row is None else {k:row[k] for k in ('handlerMs','recordedUnionMs','uncoveredMs')}))
        assert (ROOT/HIST/name).read_bytes()==raw
    summary=dict(original=original,analyzer=ORIGINAL if original else 'working tree',
                 sourceHashes={name:hashlib.sha256((ROOT/HIST/name).read_bytes()).hexdigest() for name,_,_ in RECORDS},results=results)
    with (output/'summary.json').open('x') as f:json.dump(summary,f,indent=2,ensure_ascii=False,allow_nan=False);f.write('\n')
