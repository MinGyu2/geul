#!/usr/bin/env python3
"""Recompute final acceptance against current bytes, runtime and reviewed images.

Run after both private native sessions have exited. No report hashes constitute
an external signature: this gate verifies local consistency, expected contracts,
actual file bytes and independent structure/media inspectors.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
import phase5_evidence as gate

spec=importlib.util.spec_from_file_location('documents', Path(__file__).with_name('phase5-native-documents.py'))
documents=importlib.util.module_from_spec(spec);spec.loader.exec_module(documents)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run', type=Path, required=True)
    args=p.parse_args()
    base=ROOT/'target/phase5-native-gui-ibus'
    run=args.run.absolute()
    relative=str(run.relative_to(base))
    # Resolve each component through the approved evidence root.
    report_file=gate.safe_file(base,relative+'/documents/result.json')
    report=gate.load(report_file.parent)
    gate.require(report['status']=='PASS', 'document run did not PASS')
    current=gate.identity(ROOT, ROOT/'src-tauri/target/debug/geul',report['rhwpBuild'])
    accepted=gate.finalize_documents(report,report_file.parent,current,documents.inspect_artifact,base)
    gate.require(report.get('acceptance')==accepted,'stored acceptance disagrees with recomputation')
    for stage,state in accepted['stages'].items():
        if stage in ('5-1','5-2'): continue
        name={'5-3':'5-3-editing','5-4':'5-4-persistence','5-5':'5-5-regression'}[stage]
        actual=json.loads(gate.safe_file(run,'documents/'+name+'/result.json').read_text())
        expected=dict(state,runId=report['runId'],checks=[c for c in report['checks'] if c['stage']==stage])
        gate.require(actual==expected,'stage file contradicts aggregate: '+stage)
    for session in ('session-input','session-documents'):
        cleanup=json.loads(gate.safe_file(run,session+'/cleanup.json').read_text())
        gate.require(cleanup.get('proven') is True and cleanup.get('exit')==0 and cleanup.get('survivors')==[], 'native session cleanup failed')
    review=json.loads(gate.safe_file(run,'visual-review.json').read_text())
    required={'input/all-launch-x11.png','input/all-new-dialog-x11.png',
              'documents/5-4-persistence/hwp-unsafe-save-refused-x11.png'}
    required|={'documents/5-3-editing/'+fmt+'-rich-edited-x11.png' for fmt in gate.FORMATS}
    required|={'documents/5-5-regression/'+fmt+'-after-process-restart-x11.png' for fmt in gate.FORMATS}
    gate.require(set(review['images'])==required and review['status']=='PASS' and bool(review['reviewer']), 'missing required visual inspection')
    for path,item in review['images'].items():
        gate.require(item['result']=='PASS' and item['sha256']==gate.digest(gate.safe_file(run,path)) and item['observed'], 'uninspected/changed screenshot')
    accepted.update(schema=gate.SCHEMA,closureRunId=run.name,identity=current,
                    documentReportSha256=gate.digest(report_file),visualReviewSha256=gate.digest(run/'visual-review.json'),
                    evidenceFiles={str(p.relative_to(run)):gate.digest(p) for p in sorted(run.rglob('*'))
                        if p.is_file() and (p.name.endswith('.log') or p.name in ('session.json','cleanup.json')) and 'data' not in p.relative_to(run).parts})
    (run/'final-acceptance.json').write_text(json.dumps(accepted,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':accepted['status'],'stages':accepted['stages'],'sourceRunIds':accepted['sourceRunIds']},ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except (OSError,ValueError,KeyError,TypeError,AssertionError) as error:
        print('FAIL:',error,file=sys.stderr);sys.exit(1)
