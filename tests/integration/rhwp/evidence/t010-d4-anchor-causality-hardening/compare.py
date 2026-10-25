"""Write historical-comparison.json: identities, 40 groups, 240 rows, anchor characterization.

Usage (repository root): python3 -I compare.py BEFORE_DIR AFTER_DIR OUTPUT_JSON
"""
import ast
import hashlib
import json
from collections import Counter
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[5]
HIST=ROOT/'tests/integration/rhwp/evidence/t010-d4-performance-remediation'
PREVIOUS=ROOT/'tests/integration/rhwp/evidence/t010-d4-handler-integrity-hardening'
NAMES={'baseline-official-frozen-comparison.json':'verified-baseline-handler.json','optimized-official-retry.json':'verified-luma8-handler.json'}
KINDS=('groupStart','extend','undo','redo','afterUndo')
tree=ast.parse((ROOT/'tests/integration/rhwp/undo_native.py').read_text())
ns={};exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='pct'],type_ignores=[]),'undo_native.pct','exec'),ns)
before,after,target=(Path(a) for a in sys.argv[1:4])
records={};total_groups=total_rows=0
for index,(name,previous) in enumerate(NAMES.items()):
    raw=(HIST/name).read_bytes();r=json.loads(raw)
    outputs={label:json.loads((folder/f'{index}-genuine.json').read_text()) for label,folder in (('before',before),('after',after))}
    outputs['previousVerified']=json.loads((PREVIOUS/previous).read_text())
    groups=[]
    anchors=Counter();offsets={}
    for doc in r['measurements']['perf']:
        for kind in KINDS:
            values=[s['keyToFrame'] for s in doc['timelineSamples'] if s['kind']==kind]
            reported={k:doc[kind][k] for k in ('n','p50','p95','max','timeouts')}
            groups.append(dict(sample=doc['sample'],kind=kind,statistics=reported,producerRecomputedExactMatch=ns['pct'](values)==reported))
        for s in doc['timelineSamples']:
            anchor_name='command:request' if s['kind'] in ('undo','redo') else 'dom:input'
            found=[t for t in s['timeline'] if t['name']==anchor_name]
            anchors[(s['kind'],len(found),s['timeline'].index(found[0]))]+=1
            o=offsets.setdefault(s['kind'],dict(anchorMinusInput=[],boundaryMinusAnchor=[],firstCallMinusAnchor=[],domKeydown=[]))
            o['anchorMinusInput'].append(found[0]['at']-s['at']['input'])
            o['boundaryMinusAnchor'].append((s['at']['handlerEnd'] if s['at']['handlerEnd'] is not None else s['at']['observed'])-found[0]['at'])
            o['firstCallMinusAnchor'].append(min(c['at'] for c in s['engineTimeline'])-found[0]['at'])
            o['domKeydown']+= [t['at'] for t in s['timeline'] if t['name']=='dom:keydown']
    rows=[row for d in outputs['after']['documents'] for row in d['rows']]
    total_groups+=len(groups);total_rows+=len(rows)
    records[name]=dict(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),measurementComplete=r['measurementComplete'],officialStatus=r['status'],
        wasmClaimed=r['engineIdentity']['wasmSha256'],independentIdentity=outputs['after']['independentIdentity'],
        analysis={k:dict(status=v['status'],official=v['official']) for k,v in outputs.items()},
        groups=groups,groupsExactMatch=sum(g['producerRecomputedExactMatch'] for g in groups),
        handlerRows=len(rows),
        handlerOutputIdentical=dict(beforeVsAfter=outputs['before']==outputs['after'],afterVsPreviousVerified=outputs['after']==outputs['previousVerified']),
        anchorCharacterization=dict(
            kindAnchorCountIndex={f'{k}|count={c}|index={i}':n for (k,c,i),n in sorted(anchors.items())},
            ranges={k:{m:([min(v),max(v)] if v else None) for m,v in o.items()} for k,o in offsets.items()}))
out=dict(records=records,totalGroups=total_groups,totalHandlerRows=total_rows,
         allGroupsExact=all(rec['groupsExactMatch']==20 for rec in records.values()),
         allRowsIdentical=all(all(rec['handlerOutputIdentical'].values()) for rec in records.values()))
with target.open('x') as f:json.dump(out,f,indent=2,ensure_ascii=False,allow_nan=False);f.write('\n')
