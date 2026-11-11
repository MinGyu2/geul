"""Fail-closed Phase 5 contracts. Local evidence is not an external signature.

Content hashes, an explicit scenario registry, current runtime identity and fresh
independent structure inspection authorize reuse. Legacy count-only reports do
not contain this contract and must be rerun. No freshness/bypass switches.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess

SCHEMA = 'geul.phase5.v2'
CONTROLLED_IMAGE_SHA256 = '5f37c063bb7a5bb13f8cfeb4e66b87f2116eff51eb1d0acd6030c938333c2a98'
FORMATS = ('docx', 'hwpx', 'hwp')
STAGES = ('5-1', '5-2', '5-3', '5-4', '5-5')
# Display prose is not an acceptance identifier. Each action has one stable ID.
ACTIONS = {
 'native window identity': ('5-1','window','none'),
 'visible ribbon document surface and status': ('5-1','render','none'),
 'native mouse and keyboard launch interaction': ('5-1','interaction','none'),
 'native New format / correct engine / initial focus': ('5-2','new','ime'),
 'save composition policy': ('5-2','active-save','ime'),
 'IBus multi-syllable continuous input and commit': ('5-2','commit','ime'),
 'Backspace updates composition once': ('5-2','backspace','ime'),
 'Backspace cancels one-jamo preedit without deleting committed text': ('5-2','cancel','ime'),
 'Enter and caret movement during composition': ('5-2','enter-caret','ime'),
 'editor to ribbon and restored editor focus': ('5-2','ribbon-focus','ime'),
 'modal cancellation restores input focus': ('5-2','modal-focus','ime'),
 'external X11 window focus roundtrip': ('5-2','external-focus','ime'),
 'tab switch during preedit does not modify recipient document': ('5-2','ownership','ime'),
 'real IBus around supported bullets': ('5-2','bullets','ime'),
 'IBus inside newly inserted table cell': ('5-2','table-input','ime'),
 'table cell keyboard navigation': ('5-2','table-nav','ime'),
 'save after committed composition': ('5-2','save','ime'),
 'real IBus trusted composition lifecycle observed': ('5-2','trusted','ime'),
 'close committed documents without stale events': ('5-2','close','none'),
 'native open after closing composition owners': ('5-2','reopen','none'),
 'new format native text / IBus / deletion / selection replacement': ('5-3','text','rich'),
 'supported DOCX Undo/Redo restores text and caret': ('5-3','history','rich'),
 'ordinary RHWP Undo remains explicitly disabled': ('5-3','history-disabled','rich'),
 'ribbon bullets and real IBus list text': ('5-3','bullets','rich'),
 'native image chooser changes document model': ('5-3','image','rich'),
 'ribbon table / visible cell input / Korean / native cell navigation': ('5-3','table','rich'),
 'existing fixture native open / engine / Korean edit': ('5-3','text','existing'),
 'actual GUI save / durable output / independent engine or XML reopen': ('5-4','save',None),
 'independent text / paragraph / table / image / list preservation': ('5-4','structure','rich'),
 'existing fixture untouched styles / paragraphs / tables / controls preserved': ('5-4','structure','existing'),
 'native close / native file chooser reopen / fresh clean session': ('5-4','reopen',None),
 'Save As cancellation preserves original bytes': ('5-4','cancel','rich'),
 'Save As retains current format and complete independent structure': ('5-4','saveas','rich'),
 'Save As native close and reopen': ('5-4','saveas-reopen','rich'),
 'all immutable source fixture hashes preserved': ('5-4','sources','none'),
 'HWP unsafe blank-preview save refused / original bytes / dirty / no false success': ('5-4','unsafe','none'),
 'unsafe-save session closes only after explicit discard confirmation': ('5-4','discard','none'),
 'multi-format native edit is isolated from all other documents': ('5-5','isolation','saved-as'),
 'each multi-document session saves independently': ('5-5','save','saved-as'),
 'invalid open reports failure without replacing ready documents': ('5-5','invalid','none'),
 'after invalid-open refusal / external focus / IBus recovery / save': ('5-5','focus','none'),
 'application process restart proven': ('5-5','process','none'),
 'application restart / native reopen / durable rich content': ('5-5','reopen','saved-as'),
 'all test document handles closed': ('5-5','handles','none'),
}
GLOBAL = {'close','reopen'}  # only for input stage

def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def safe_file(root, relative):
    """No absolute paths, traversal, aliases or symlink components, even internal."""
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), 'invalid evidence root')
    p = PurePosixPath(relative)
    require(isinstance(relative, str) and relative and not p.is_absolute() and str(p) == relative
            and all(x not in ('.','..') for x in p.parts), 'unsafe evidence path')
    current = root
    for part in p.parts:
        current = current / part
        require(not current.is_symlink(), 'symlink evidence path')
    require(current.is_file() and current.resolve().is_relative_to(root.resolve()), 'missing/escaped evidence file: '+relative)
    return current


def run_id(root):
    return Path(root).name + '-' + hashlib.sha256(str(Path(root).absolute()).encode()).hexdigest()[:16]


def load(root, relative='result.json'):
    try:
        d = json.loads(safe_file(root, relative).read_text())
        require(isinstance(d, dict) and d.get('schema') == SCHEMA, 'unsupported/malformed report schema; rerun legacy evidence')
        require(d.get('runId') == run_id(root), 'wrong declared run identity')
        require(d.get('status') in ('PASS','FAIL','RUNNING','PARTIAL','BLOCKED'), 'invalid overall status')
        return d
    except (OSError, TypeError, json.JSONDecodeError) as e:
        raise ValueError('malformed/missing acceptance report') from e


def identity(root, app, build):
    """Hash actual content, not a diff relative to an ever-changing HEAD."""
    paths = subprocess.check_output(['git','ls-files','-co','--exclude-standard','--','src','src-tauri/src','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','package.json','package-lock.json','vite.config.ts','scripts/rhwpAssets.ts','patches'], cwd=root, text=True).splitlines()
    tree = {p: digest(Path(root)/p) for p in sorted(set(paths)) if (Path(root)/p).is_file()}
    require(tree, 'empty product identity')
    for name, sha in build['artifacts'].items():
        require(digest(safe_file(Path(root)/'public/rhwp/generations'/build['generation'], name)) == sha, 'engine artifact mismatch')
    return {'appSha256': digest(app), 'productTreeSha256': canonical(tree),
            'rhwpGeneration': build['generation'], 'rhwpArtifacts': build['artifacts'],
            'rhwpSourceTree': build['integration']['sourceTreeSha256'],
            'wordcraftCommit': subprocess.check_output(['git','-C',str(Path(root)/'external/wordcraft'),'rev-parse','HEAD'], text=True).strip(),
            'inputHarnessSha256': canonical({p:digest(Path(root)/p) for p in [
                'scripts/tests/phase5-native-acceptance.py','scripts/tests/native-new-document.py',
                'scripts/tests/native-ibus-session.py','tests/e2e/tauri_smoke.py']})}


def new_report(root, kind):
    return {'schema':SCHEMA,'runId':run_id(root),'kind':kind,'status':'RUNNING','checks':[],
            'evidenceFiles':{},'artifacts':{},'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()}


def scenario_id(stage, fmt, role, name):
    return '.'.join((stage,fmt,role,name))


def row(name, fmt, role, run_id, ok, observed):
    require(name in ACTIONS, 'unregistered action: '+name)
    stage, short, fixed_role = ACTIONS[name]
    role = fixed_role if fixed_role is not None else role
    require(role in ('none','ime','rich','existing','saved-as'), 'missing artifact role')
    if stage == '5-1' or stage == '5-2' and short in GLOBAL or short in ('sources','unsafe','discard','invalid','focus','process','handles'):
        fmt = 'all' if short not in ('unsafe','discard') else 'hwp'
    return {'id':scenario_id(stage,fmt,role,short),'stage':stage,'format':fmt,'artifact':role,
            'runId':run_id,'evidenceMode':'CURRENT_RUN','actions':name,'expected':name,
            'observed':observed,'result':'PASS' if ok else 'FAIL'}


def requirements(stage):
    result=set()
    for name,(s,short,role) in ACTIONS.items():
        if s != stage: continue
        if stage=='5-1' or stage=='5-2' and short in GLOBAL or short in ('sources','invalid','focus','process','handles'):
            result.add(scenario_id(s,'all',role,short));continue
        if short in ('unsafe','discard'):
            result.add(scenario_id(s,'hwp','none',short));continue
        for fmt in FORMATS:
            if short=='history' and fmt!='docx' or short=='history-disabled' and fmt=='docx':continue
            for r in (('rich','existing') if role is None else (role,)):
                result.add(scenario_id(s,fmt,r,short))
    return result


def stage_results(checks, stages):
    ids=[c['id'] for c in checks]
    require(len(ids)==len(set(ids)), 'duplicate scenario ID')
    expected=set().union(*(requirements(s) for s in stages))
    require(set(ids)<=expected, 'unexpected/unrelated scenario ID')
    result={}
    for stage in stages:
        rows=[c for c in checks if c['stage']==stage]
        for c in rows:
            require(c['id'].split('.')[:3]==[stage,c['format'],c['artifact']], 'scenario format/artifact mismatch')
            require(row(c['actions'], c['format'], c['artifact'], c['runId'], c['result']=='PASS', c.get('observed'))['id']==c['id'], 'unrelated action substituted for required scenario')
            require(c['result'] in ('PASS','FAIL') and c['evidenceMode'] in ('CURRENT_RUN','REUSED_VERIFIED'), 'invalid scenario verdict/origin')
        wanted=requirements(stage);actual={c['id'] for c in rows};current=[c for c in rows if c['evidenceMode']=='CURRENT_RUN']
        failed=any(c['result']!='PASS' for c in rows)
        result[stage]={'executionStatus':('FAIL' if any(c['result']!='PASS' for c in current) else 'PASS') if current else 'NOT_RUN',
                       'evidenceMode':('MIXED' if current and len(current)!=len(rows) else 'CURRENT_RUN' if current else 'REUSED_VERIFIED') if rows else 'NONE',
                       'effectiveAcceptance':'FAIL' if failed else 'PASS' if actual==wanted else 'NOT_RUN',
                       'currentCount':len(current),'reusedCount':len(rows)-len(current),
                       'requiredCount':len(wanted),'missing':sorted(wanted-actual)}
    return result


def bind_files(report, root):
    report['evidenceFiles']={str(p.relative_to(root)):digest(p) for p in sorted(Path(root).rglob('*'))
       if p.is_file() and p.name!='result.json' and not any(x in p.relative_to(root).parts for x in ('data','sources','documents','verified'))}


def verify_files(report, root):
    require(report.get('evidenceFiles'), 'missing evidence file manifest')
    for name,sha in report['evidenceFiles'].items():
        require(digest(safe_file(root,name))==sha, 'evidence file hash mismatch: '+name)


def check_report(report, root, expected_identity, stages):
    require(report.get('schema')==SCHEMA and report.get('runId')==run_id(root), 'report schema/run identity mismatch')
    require(report.get('identity')==expected_identity, 'application/source/engine/input identity mismatch')
    calculated=stage_results(report['checks'],stages)
    if report.get('status')=='PASS':
        require(all(s['effectiveAcceptance']=='PASS' for s in calculated.values()), 'PASS contradicts missing/failed mandatory stage')
    require(report.get('stageResults')==calculated, 'contradictory current/reused stage status')
    for c in report['checks']:
        require(c['runId']==report['runId'] if c['evidenceMode']=='CURRENT_RUN' else bool(c.get('sourceReportSha256')) and c['runId']!=report['runId'], 'forged scenario provenance')
    verify_files(report,root)
    return calculated


def validate_ibus(root, expected_identity):
    report=load(root)
    require(report.get('kind')=='input' and report['status']=='PASS', 'IBus overall PASS required')
    states=check_report(report,root,expected_identity,('5-1','5-2'))
    require(all(s['effectiveAcceptance']=='PASS' for s in states.values()), 'missing/failed GUI or IBus scenario')
    require(all(c['evidenceMode']=='CURRENT_RUN' for c in report['checks']), 'IBus chain reuse unsupported')
    require(report.get('teardown') and all(t.get('complete') and not t.get('survivorsAfterSigterm') for t in report['teardown']), 'missing input teardown')
    session=json.loads(safe_file(root,'native-session.json').read_text())
    require(session['globalEngine']=='hangul' and session['setGlobalEngine']['exit']==0 and
            any('ibus-engine-hangul' in p for p in session['engineProcesses']), 'missing real IBus activation')
    env=report.get('environment',{})
    require(env.get('GTK_IM_MODULE')=='ibus' and env.get('IBUS_ADDRESS')==session.get('ibusAddress') and env.get('DISPLAY')==session.get('display') and bool(env.get('IBUS_ADDRESS')), 'wrong native input session/module')
    require(report.get('launchProcess',{}).get('exeSha256')==expected_identity['appSha256'], 'native launch binary proof missing')
    require(all('ime.'+fmt in report['evidenceFiles'] for fmt in FORMATS), 'missing saved input ownership artifact')
    events=json.loads(safe_file(root,'trusted-input-trace.json').read_text())
    for fmt in FORMATS:
        selected=[e for e in events if e.get('format')==fmt]
        for event in ('compositionstart','compositionupdate','compositionend'):
            require(any(e['type']==event and e.get('trusted') is True and (event=='compositionstart' or bool(e.get('data'))) for e in selected), 'missing trusted '+fmt+' '+event)
        switches=[e for e in report['engineSwitches'] if e.get('format')==fmt]
        require(all(any(e['requested']==name and e['observed']==name for e in switches) for name in ('hangul','xkb:us::eng')), 'missing format engine activation')
    return report


def positive_ids():
    return requirements('5-3') | {s for s in requirements('5-4') if not any(s.endswith('.'+x) for x in ('sources','unsafe','discard'))}


def artifact_scenarios(fmt,role):
    if role=='saved-as':
        return [scenario_id('5-4',fmt,'rich',x) for x in ('saveas','saveas-reopen')]
    return [scenario_id('5-4',fmt,role,x) for x in ('save','structure','reopen')]


def verify_artifacts(report, root, inspector):
    expected={fmt+'/'+role for fmt in FORMATS for role in ('rich','existing','saved-as')}
    require(set(report.get('artifacts',{}))==expected, 'missing/unexpected document artifacts')
    rows={c['id']:c for c in report['checks']}
    for key,a in report['artifacts'].items():
        fmt,role=key.split('/')
        require(isinstance(a.get('sha256'),str) and len(a['sha256'])==64, 'missing/malformed document hash')
        require(a['format']==fmt and a['role']==role and a['runId']==report['runId'] and a['identity']==report['identity'], 'artifact format/run/build mismatch')
        path='verified/'+fmt+'/'+role+'.'+fmt
        require(a['path']==path and a['scenarios']==artifact_scenarios(fmt,role), 'incorrect/aliased artifact path or scenarios')
        for sid in a['scenarios']:
            require(sid in rows and rows[sid]['result']=='PASS' and rows[sid].get('artifactSha256')==a['sha256'], 'artifact not bound to passing scenario')
        file=safe_file(root,path)
        require(digest(file)==a['sha256'], 'document bytes changed: '+key)
        source=safe_file(root,'sources/blue.png' if role!='existing' else 'sources/basic-ko.'+fmt)
        require(a['sourcePath']==str(source.relative_to(root)) and digest(source)==a['sourceSha256'], 'source fixture bytes changed')
        require(a.get('structureVerified') is True and a.get('structureSha256')==canonical(a['structure']), 'missing structural proof')
        observed=inspector(file,fmt,role,source,a.get('firstText'))
        require(observed==a['structure'] and observed.get('format')==fmt, 'independent structure/media/format mismatch')
        if role!='existing':
            require(a['sourceSha256']==CONTROLLED_IMAGE_SHA256, 'wrong controlled source image')
            require(observed['format']==fmt and all(observed[x]>=1 for x in ('tables','images','bullets')) and
                    all(t in observed['text'] for t in ('english edit 한글','List 한글','Cell2')) and
                    a['sourceSha256'] in observed['imageHashes'], 'wrong rich format/content/image')


def authorize_resume(root, expected_identity, inspector, evidence_base=None):
    report=load(root)
    require(report.get('kind')=='documents' and report['status'] in ('PASS','FAIL','PARTIAL'), 'unsupported reuse source')
    check_report(report,root,expected_identity,('5-3','5-4','5-5'))
    require(not report.get('reuse'), 'chained reused evidence unsupported; rerun')
    rows={c['id']:c for c in report['checks']}
    for sid in positive_ids():
        require(sid in rows and rows[sid]['result']=='PASS' and rows[sid]['evidenceMode']=='CURRENT_RUN', 'missing/failed required positive scenario: '+sid)
    base=Path(evidence_base) if evidence_base is not None else Path(root).parent
    link=report['ibusEvidence'];input_file=safe_file(base,link['path'])
    require(digest(input_file)==link['sha256'], 'source IBus report changed')
    validate_ibus(input_file.parent,expected_identity)
    verify_artifacts(report,root,inspector)
    return report


def process_identity(pid):
    p=Path('/proc')/str(pid)
    fields=(p/'stat').read_text().rsplit(')',1)[1].split()
    return {'pid':int(pid),'startTicks':int(fields[19]),'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'exeSha256':digest(p/'exe')}


def same_process_alive(p):
    try:
        return process_identity(p['pid'])==p
    except (OSError, ValueError):
        return False


def validate_restart(proof, identity_value):
    before,after=proof['before'],proof['after']
    require(all(isinstance(p.get('pid'),int) and p['pid']>0 and isinstance(p.get('startTicks'),int) and p['startTicks']>0 and p.get('bootId') for p in (before,after)), 'malformed restart process identity')
    require(before['exeSha256']==after['exeSha256']==identity_value['appSha256'], 'restart executable mismatch')
    require(before['bootId']==after['bootId'] and (before['pid'],before['startTicks'])!=(after['pid'],after['startTicks'])
            and before['startTicks']<=after['startTicks'] and proof['oldProcessGone'] is True, 'restart reused old process')


def finalize_documents(report, root, expected_identity, inspector, evidence_base):
    states=check_report(report,root,expected_identity,('5-3','5-4','5-5'))
    link=report['ibusEvidence'];ibus_path=safe_file(evidence_base,link['path'])
    require(digest(ibus_path)==link['sha256'], 'IBus report changed')
    ibus=validate_ibus(ibus_path.parent,expected_identity)
    if report.get('reuse'):
        link=report['reuse'];source_path=safe_file(evidence_base,link['path'])
        require(digest(source_path)==link['sha256'], 'source report changed')
        source=authorize_resume(source_path.parent,expected_identity,inspector,evidence_base)
        require(source['runId']==link['runId'], 'wrong source run')
        reused=[c for c in report['checks'] if c['evidenceMode']=='REUSED_VERIFIED']
        require({c['id'] for c in reused}==positive_ids(), 'incomplete/unexpected reused scenario set')
        source_rows={c['id']:c for c in source['checks']}
        for c in reused:
            original=dict(c);original.pop('sourceReportSha256');original['evidenceMode']='CURRENT_RUN'
            require(original==source_rows[c['id']] and c['sourceReportSha256']==link['sha256'], 'reused row differs from source')
        for key,a in source['artifacts'].items():
            require(digest(safe_file(root,'reuse-copies/'+key.replace('/','-')+'.'+a['format']))==a['sha256'], 'reused copied artifact mismatch')
    else:
        require(all(c['evidenceMode']=='CURRENT_RUN' for c in report['checks']), 'unauthenticated reuse')
        verify_artifacts(report,root,inspector)
    require(all(s['effectiveAcceptance']=='PASS' for s in states.values()), 'unsatisfied mandatory document stage')
    validate_restart(report['restart'],expected_identity)
    require(report.get('teardown') and all(t.get('complete') and not t.get('survivorsAfterSigterm') for t in report['teardown']), 'missing/failed native teardown')
    return {'status':'PASS','runId':report['runId'],'stages':{**ibus['stageResults'],**states},
            'inputRunId':ibus['runId'],'sourceRunIds':[report['reuse']['runId']] if report.get('reuse') else [],
            'formats':{fmt:{s:'PASS' for s in STAGES} for fmt in FORMATS}}
