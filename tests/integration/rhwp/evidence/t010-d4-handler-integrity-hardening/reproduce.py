"""Run immutable official JSON and isolated mutations against original/current CLI.

Usage: python3 reproduce.py [--original] OUTPUT_DIRECTORY
Outputs use exclusive creation; candidate identities are independent constants.
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
HIST=ROOT/'tests/integration/rhwp/evidence/t010-d4-performance-remediation'
JS='b69e920c8fb1e9d05dacadf3ebae2396b043da385137ad2b4b3386a9b3433252'
RECORDS=(('baseline-official-frozen-comparison.json','/tmp/geul-t010-caret-geometry/candidate-package','48adaa0f748484d12f59f4805deda0480635f915368392a87e76e95962ec0b27'),
         ('optimized-official-retry.json','/tmp/geul-d4-remediation-gray/candidate-package','ae34c12bd0d20aeb9f94610682bc678ec61f55722df74ea946d09782d7c87983'))
original='--original' in sys.argv
output=Path(sys.argv[-1]);output.mkdir(parents=True,exist_ok=False)
with tempfile.TemporaryDirectory() as temp:
    work=Path(temp);fixtures=work/'fixtures'
    subprocess.run(['node',str(ROOT/'tests/fixtures/rhwp/generate.mjs'),str(fixtures)],check=True,capture_output=True)
    cli=POC/'analyze-d4.py'
    if original:
        for name in ('analyze-d4.py','d4_handler.py','d4_evidence.py'):
            (work/name).write_bytes(subprocess.check_output(['git','show','93004384cc8dd8ea12ff898dc16ac20fbd0a7af1:'+str((POC/name).relative_to(ROOT))],cwd=ROOT))
        # d4_handler derives repository paths from __file__, so patch only the
        # scratch module's ROOT location. Validation logic remains original.
        handler=work/'d4_handler.py';handler.write_text(handler.read_text().replace('ROOT = Path(__file__).resolve().parents[4]',f'ROOT = Path({str(ROOT)!r})'))
        cli=work/'analyze-d4.py'
    outcomes=[]
    for index,(name,package,wasm) in enumerate(RECORDS):
        raw=(HIST/name).read_bytes();record=json.loads(raw)
        def sample(r):return r['measurements']['perf'][0]['timelineSamples'][0]
        def overflow(r):
            for key in ('insertText','saveSnapshot'):sample(r)['calls'][key]['ms']=1e308
        mutations=[('genuine',lambda r:None)]
        if index==0:
            mutations += [('aggregate-ms',lambda r:sample(r)['calls']['insertText'].update(ms=999)),
                          ('aggregate-firstAt',lambda r:sample(r)['calls']['insertText'].update(firstAt=999)),
                          ('call-outside',lambda r:sample(r)['engineTimeline'][0].update(at=99999)),
                          ('extend-handlerEnd',lambda r:r['measurements']['perf'][0]['timelineSamples'][1]['at'].update(handlerEnd=99999)),
                          ('precision',lambda r:sample(r).update(keyToFrame=87.04)),
                          ('origin',lambda r:sample(r)['at'].update(key=.1)),
                          ('latency-end',lambda r:r['measurements']['perf'][0]['timelineSamples'][2].update(keyToFrame=80.9)),
                          ('overflow',overflow),('empty-error',lambda r:r.update(error={})),
                          ('trace-identity',lambda r:sample(r).update(timeline=[dict(name='meaningless',at=1,ms=None)])),
                          ('duplicate-key',lambda r:None),('nested',lambda r:None)]
        for label,mutate in mutations:
            r=copy.deepcopy(record);mutate(r);data=json.dumps(r)
            if label=='duplicate-key':data=data[:-1]+',"measurementComplete":false,"measurementComplete":true}'
            if label=='nested':data='['*20000+'0'+']'*20000
            source=work/'input.json';source.write_text(data)
            target=output/f'{index}-{label}.json'
            cmd=['python3',str(cli),'handler',str(source),str(target),'--candidate',package,'--expected-wasm',wasm,'--expected-js',JS,'--fixtures',str(fixtures)]
            p=subprocess.run(cmd,text=True,capture_output=True)
            analysis=json.loads(target.read_text()) if target.exists() else None
            def nonfinite(v):
                import math
                if isinstance(v,float):return not math.isfinite(v)
                if isinstance(v,dict):return any(nonfinite(x) for x in v.values())
                if isinstance(v,list):return any(nonfinite(x) for x in v)
                return False
            outcomes.append(dict(record=name,case=label,exit=p.returncode,status=analysis.get('status') if analysis else None,
                                 error=analysis.get('error') if analysis else None,nonfinite=nonfinite(analysis),traceback='Traceback' in p.stderr,
                                 inputUnchanged=source.read_text()==data))
        assert (HIST/name).read_bytes()==raw
    summary=dict(original=original,head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
                 sourceHashes={name:hashlib.sha256((HIST/name).read_bytes()).hexdigest() for name,_,_ in RECORDS},results=outcomes)
    with (output/'summary.json').open('x') as f:json.dump(summary,f,indent=2,ensure_ascii=False,allow_nan=False)
