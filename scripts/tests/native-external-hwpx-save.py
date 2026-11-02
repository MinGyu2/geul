#!/usr/bin/env python3
"""External HWPX acceptance through the real editor and Tauri save IPC.

Requires existing tests/ helpers, debug app, running Vite with test hooks,
X11/IBus hangul/xdotool and tauri-driver. No synthetic composition events.
Always uses a private copy; output must be a new ignored directory.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


_oracle_spec = importlib.util.spec_from_file_location('hwpx_xml_oracle', ROOT / 'scripts/tests/hwpx_xml_oracle.py')
oracle = importlib.util.module_from_spec(_oracle_spec)
_oracle_spec.loader.exec_module(oracle)


def apply_intentional_edit(first, edited, hp):
    """Expect precisely 한글 prepended to the first direct run/hp:t text slot.

    Never import saved character data. All existing text, tails, run attributes
    and nested controls remain owned by their original nodes and are compared
    by the caller. A nested paragraph cannot supply the insertion point.
    """
    assert first is not None and edited is not None, 'missing edited paragraph'
    # Hancom commonly puts secPr/ctrl in a control-only run before the first
    # text run. Select only direct run/t paths, never nested control text.
    texts, saved_texts = first.findall(hp+'run/'+hp+'t'), edited.findall(hp+'run/'+hp+'t')
    assert texts and saved_texts, 'cannot prove insertion point without a direct hp:t'
    target, saved_target = texts[0], saved_texts[0]
    intended = '한글' + (target.text or '')
    assert saved_target.text == intended, 'intended prefix missing or original first text changed'
    target.text = intended


def omit_edited_line_layout(para, hp):
    """Only direct layout children of the edited paragraph may be recalculated.

    Keep their tails: those are paragraph character data, not layout payload.
    Nested paragraphs and their layout stay subject to full comparison.
    """
    for child in list(para):
        if child.tag == hp+'linesegarray':
            index = list(para).index(child)
            if child.tail:
                if index:
                    previous = para[index - 1]
                    previous.tail = (previous.tail or '') + child.tail
                else:
                    para.text = (para.text or '') + child.tail
            para.remove(child)


# Document-independent preview bytes the save service already accepts (geul
# preview.rs): rhwp's 68-byte blank PNG constant and the audited 4502-byte
# white 724x1024 PNG. Anything else is not a blank preview for this harness.
KNOWN_BLANK_IMAGES = {
    'c1bf607dd7214cb64486934b72c335a64b31d7f5203c40afdea5a1b95c826cf8': 'rhwp PRV_IMAGE_PNG',
    'ca5d23cd1aad2853672cdb0d116137a0bdc2ff62148da9886c264305d0025f3d': 'audited 4502-byte blank',
}


def package_preserved(source, saved, expected, prefix):
    """Independent check of the published package against the original.

    Only the first top-level paragraph of section 0 was edited (text prefixed
    by native IME input). Every paragraph id, including Hancom's repeated ids,
    must be identical and in the same order; all other parts are compared as
    canonical XML or bytes. Line-layout of the edited paragraph is recomputed
    by the engine and is checked by the backend on the final bytes instead.
    """
    hp = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
    ids = {}
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(saved) as b:
        assert b.testzip() is None and set(a.namelist()) == set(b.namelist())
        for name in a.namelist():
            before, after = a.read(name), b.read(name)
            if name.endswith(('.xml', '.hpf', '.rdf')):
                x, y = oracle.parse(before), oracle.parse(after)
                if name.startswith('Contents/section'):
                    ids[name] = [p.get('id') for p in x.iter(hp+'p')]
                    assert ids[name] == [p.get('id') for p in y.iter(hp+'p')], name
                if name == 'Contents/section0.xml':
                    first, edited = x.find(hp+'p'), y.find(hp+'p')
                    # Exact character data (itertext keeps tails and whitespace).
                    assert ''.join(''.join(t.itertext()) for t in first.iter(hp+'t')) == prefix
                    assert ''.join(''.join(t.itertext()) for t in edited.iter(hp+'t')) == expected
                    apply_intentional_edit(first, edited, hp)
                    # Line layout of the edited paragraph only is recomputed.
                    for para in (first, edited):
                        omit_edited_line_layout(para, hp)
                assert oracle.canonical_events(x) == oracle.canonical_events(y), (name, oracle.first_difference(x, y))
            elif name == 'Preview/PrvText.txt':
                # Only a known empty text preview is independent of the edit.
                assert before == after and before in (b'', b'\r\n'), name
            elif name == 'Preview/PrvImage.png':
                assert before == after and hashlib.sha256(after).hexdigest() in KNOWN_BLANK_IMAGES, name
            else:
                assert before == after, name
    repeated = sum(len(v) - len(set(v)) for v in ids.values())
    return {'zipValid': True, 'partSetEqual': True, 'headerAndUnrelatedXmlEqual': True,
            'previewIsKnownBlank': True, 'paragraphIdsEqual': True,
            'paragraphCount': sum(len(v) for v in ids.values()), 'repeatedParagraphIds': repeated,
            'expectedText': expected}


MODEL = r"""
import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{resolve}from'node:path';import{pathToFileURL}from'node:url';
const[pkg,source,saved,expected,prefix]=process.argv.slice(2);const m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
const snapshot=d=>({format:d.getSourceFormat(),pages:d.pageCount(),controls:d.getControls(),paragraphs:Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getTextRange(s,p,0,d.getParagraphLength(s,p))))});
const a=new m.HwpDocument(readFileSync(source)),b=new m.HwpDocument(readFileSync(saved));try{const before=snapshot(a),after=snapshot(b);assert.equal(before.paragraphs[0][0],prefix);before.paragraphs[0][0]=expected;assert.deepEqual(after,before);console.log(JSON.stringify({modelEquivalent:true,controlsEqual:true,pagesEqual:true,sections:after.paragraphs.length,paragraphs:after.paragraphs.flat().length,expectedText:expected}));}finally{a.free();b.free();}
"""


def run(args):
    args.out = args.out.resolve(); args.out.mkdir(parents=True, exist_ok=False)
    source = args.source.resolve(); path = args.out/'external.hwpx'; shutil.copyfile(source, path)
    report = {'status': 'RUNNING', 'sourceSha256': sha(source), 'sourceHead': subprocess.check_output(['git','rev-parse','HEAD'],text=True,cwd=ROOT).strip(), 'appSha256': sha(args.app), 'input': 'native xdotool -> IBus hangul -> GTK/WebKit', 'syntheticComposition': False}
    smoke.APP = str(args.app.resolve()); smoke.DRIVER_LOG = args.out/'driver.log'
    env = {k:v for k,v in os.environ.items() if k not in {'LD_LIBRARY_PATH','IBUS_USE_PORTAL'}}
    def command(*cmd):
        return subprocess.check_output(cmd,env=env,text=True,stderr=subprocess.PIPE).strip()
    try:
        with smoke.tauri_driver(args.driver,args.port,str(args.out/'appdata')) as start:
            d=start()
            try:
                smoke.wait_until(d,"return document.querySelector('#document-path')!==null",timeout=30)
                identity=d.js("return fetch('/rhwp/BUILD.json').then(r=>r.json())")
                assert identity['schemaVersion']==3 and identity['integration']['kind']=='patched-upstream'
                assert identity==json.loads((ROOT/'public/rhwp/RELEASE.json').read_bytes())
                pkg=ROOT/'public/rhwp/generations'/identity['generation']
                assert sha(pkg/'rhwp_bg.wasm')==identity['artifacts']['rhwp_bg.wasm']
                report['runtimeIdentity']=identity
                rhwp.open_document(d,path);rhwp.require_test_hooks(d)
                report['opened']=rhwp.status(d)
                # Run the application's real preflight before editing.
                rhwp.press_button(d,'[data-testid=rhwp-save-check]')
                smoke.wait_until(d,"return document.querySelector('[data-testid=rhwp-save-result]')?.dataset.outcome==='safe'",timeout=60)
                report['preflight']=d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
                original_hash=sha(path)
                d.js("document.querySelector('.rhwp-input').focus()")
                window=command(args.xdotool,'search','--onlyvisible','--name','^geul').split()[-1]
                command(args.xdotool,'windowfocus','--sync',window)
                setup=subprocess.run([args.ibus,'engine','hangul'],env=env,capture_output=True,text=True)
                report['imeSetup']={'exit':setup.returncode,'stderr':setup.stderr.strip()}
                command(args.xdotool,'key','Home');before=rhwp.settle(d,'before external edit');prefix=before['paragraphText']
                d.js(rhwp.EVENT_LOG)
                command(args.xdotool,'type','--delay','90','gk');mid=rhwp.settle(d,'external preedit')
                assert mid['composing']=='true' and mid['paragraphText']=='하'+prefix,mid
                command(args.xdotool,'type','--delay','90','srmf');command(args.xdotool,'key','End')
                edited=rhwp.settle(d,'external commit');expected='한글'+prefix
                assert edited['paragraphText']==expected and edited['composing']=='false',edited
                assert int(edited['revision'])>int(before['revision']) and edited['dirty']==edited['unpreserved']=='true'
                assert sha(path)==original_hash
                report['edit']={'before':before,'preedit':mid,'after':edited,'events':d.js('return window.__imeLog')}
                saved=rhwp.save_and_wait(d);current=rhwp.status(d)
                assert saved['state']=='saved' and saved['synced']=='true',saved
                assert saved['revision']==current['revision'] and current['dirty']==current['unpreserved']=='false'
                sessions=rhwp.ipc(d,'document_sessions')['ok'];owner=next(s for s in sessions if s['displayName']==path.name)
                assert owner['revision']==int(current['revision']) and owner['dirty'] is False
                assert sha(path)!=original_hash
                report['save']={'result':saved,'status':current,'session':owner,'publishedSha256':sha(path)}
                assert rhwp.close_tab(d,path.name)
                rhwp.open_document(d,path);reopened=rhwp.status(d)
                assert reopened['paragraphText']==expected and reopened['dirty']==reopened['unpreserved']=='false',reopened
                report['reopen']=reopened
                report['package']=package_preserved(source,path,expected,prefix)
                report['model']=json.loads(subprocess.check_output(['node','--input-type=module','-',str(pkg),str(source),str(path),expected,prefix],input=MODEL,text=True,cwd=ROOT))
                shutil.copyfile(path,args.out/'published.hwpx')
                # An external change after loading must survive the attempted save
                # exactly; the session stays unpreserved (no false success).
                d.js("document.querySelector('.rhwp-input').focus()");command(args.xdotool,'windowfocus','--sync',window)
                command(args.xdotool,'key','Home');again=rhwp.settle(d,'conflict edit start')
                command(args.xdotool,'type','--delay','90','gksrmf');command(args.xdotool,'key','End')
                conflict_edit=rhwp.settle(d,'conflict edit')
                assert conflict_edit['paragraphText']=='한글'+again['paragraphText'] and conflict_edit['dirty']=='true',conflict_edit
                path.write_bytes(path.read_bytes()+b'\0');changed_hash=sha(path)
                conflict=rhwp.save_and_wait(d)
                assert conflict['state']=='failed' and conflict['error']=='FileConflict',conflict
                assert sha(path)==changed_hash and rhwp.status(d)['unpreserved']=='true'
                report['externalConflict']={'result':conflict,'modifiedOriginalUnchanged':True,'sessionUnpreserved':True}
                # Identity boundary that must stay refused through the actual UI:
                # a missing paragraph id is readable, export fails closed, no save
                # success and no change to the input bytes. (Repeated imported ids
                # are legitimate Hancom output and are preserved, see the package check.)
                negative=args.out/'missing-id.hwpx'
                hp='{http://www.hancom.co.kr/hwpml/2011/paragraph}'
                with zipfile.ZipFile(source) as a,zipfile.ZipFile(negative,'w') as b:
                    for info in a.infolist():
                        data=a.read(info.filename)
                        if info.filename=='Contents/section0.xml':
                            root=ET.fromstring(data);next(root.iter(hp+'p')).attrib.pop('id');data=ET.tostring(root,encoding='utf-8')
                        b.writestr(info,data)
                negative_hash=sha(negative);rhwp.open_document(d,negative)
                rhwp.press_button(d,'[data-testid=rhwp-save-check]')
                smoke.wait_until(d,"const e=document.querySelector('[data-testid=rhwp-save-result]');return e && e.dataset.state==='failed'",timeout=60)
                rejected=d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
                # The UI deliberately redacts engine internals to EngineFailure.
                # Verify the exact failure cause separately with the same served WASM.
                assert rejected['error']=='EngineFailure' and rejected['outcome']!='safe',rejected
                probe_path=ROOT/'scripts/tests/hwpx-textdir-roundtrip.py'
                spec=importlib.util.spec_from_file_location('hwpx_probe',probe_path)
                probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
                diagnostic=probe.export(pkg,negative,args.out/'negative-export.hwpx')
                assert diagnostic['returncode']!=0 and diagnostic['diagnostic']['stage']=='export'
                assert diagnostic['diagnostic']['opened'] and 'HWPX paragraph id missing or invalid' in diagnostic['diagnostic']['error']
                assert sha(negative)==negative_hash and rejected['state']!='saved'
                report['negative']={'readable':True,'originalUnchanged':True,'result':rejected,
                                    'engineDiagnostic':diagnostic['diagnostic']}
                if args.preview_negative:
                    # A genuinely Hancom-saved document whose unedited round trip
                    # is preserved exactly (preflight safe) but whose content
                    # previews would go stale after an edit: the save must be
                    # refused and the file must stay byte-identical.
                    stale=args.out/'preview-negative.hwpx';shutil.copyfile(args.preview_negative.resolve(),stale);stale_hash=sha(stale)
                    rhwp.open_document(d,stale)
                    rhwp.press_button(d,'[data-testid=rhwp-save-check]')
                    smoke.wait_until(d,"return document.querySelector('[data-testid=rhwp-save-result]')?.dataset.outcome==='safe'",timeout=60)
                    stale_preflight=d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
                    d.js("document.querySelector('.rhwp-input').focus()");command(args.xdotool,'windowfocus','--sync',window)
                    command(args.xdotool,'key','Home');stale_before=rhwp.settle(d,'preview negative start')
                    command(args.xdotool,'type','--delay','90','gksrmf');command(args.xdotool,'key','End')
                    stale_edit=rhwp.settle(d,'preview negative edit')
                    assert stale_edit['paragraphText']=='한글'+stale_before['paragraphText'] and stale_edit['dirty']=='true',stale_edit
                    refused=rhwp.save_and_wait(d)
                    assert refused['state']=='failed' and refused['error']=='UnsafeSave',refused
                    assert 'previewStale:Preview/PrvImage.png' in refused.get('findings','') and 'previewStale:Preview/PrvText.txt' in refused.get('findings',''),refused
                    assert d.exists('[data-testid=save-findings]')
                    assert sha(stale)==stale_hash and rhwp.status(d)['unpreserved']=='true'
                    report['previewNegative']={'sourceSha256':sha(args.preview_negative.resolve()),'preflight':stale_preflight,
                                               'result':refused,'originalUnchanged':True,'sessionUnpreserved':True}
                assert not list(args.out.glob('.geul-save-*.tmp'))
            finally:smoke.end_session(d)
        report['status']='PASS'
    except Exception as error:
        report.update(status='FAIL',error=type(error).__name__+': '+str(error));traceback.print_exc()
    finally:(args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'error':report.get('error')},ensure_ascii=False))
    return 0 if report['status']=='PASS' else 1


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,default=ROOT/'external/rhwp/samples/종이기준.hwpx')
    p.add_argument('--app',type=Path,required=True);p.add_argument('--driver',required=True);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--xdotool',required=True);p.add_argument('--ibus',required=True);p.add_argument('--port',type=int,default=4444)
    p.add_argument('--preview-negative',type=Path,help='Hancom-saved HWPX with content previews: edited save must be refused')
    return run(p.parse_args())

if __name__=='__main__':sys.exit(main())
