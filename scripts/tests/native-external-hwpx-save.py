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


def xml_tree(e):
    return (e.tag, sorted(e.attrib.items()), e.text.strip() if e.text and e.text.strip() else '', [xml_tree(c) for c in e])


def package_preserved(source, saved, expected):
    hp = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(saved) as b:
        assert b.testzip() is None and set(a.namelist()) == set(b.namelist())
        for name in a.namelist():
            before, after = a.read(name), b.read(name)
            if name.endswith(('.xml', '.hpf', '.rdf')):
                x, y = ET.fromstring(before), ET.fromstring(after)
                if name == 'Contents/section0.xml':
                    paras = list(x.iter(hp+'p')); actual = list(y.iter(hp+'p'))
                    assert [p.get('id') for p in paras] == [p.get('id') for p in actual] == ['3121190098']
                    texts = list(x.iter(hp+'t')); saved_texts = list(y.iter(hp+'t'))
                    assert len(texts) == len(saved_texts) == 1 and not texts[0].text
                    assert saved_texts[0].text == expected
                    # Line-layout values are recalculated after the actual edit.
                    # Authoritative backend validation checks these final bytes;
                    # the independent check below retains all other attributes.
                    texts[0].text = expected
                    for root in (x, y):
                        for parent in root.iter():
                            for child in list(parent):
                                if child.tag == hp+'linesegarray': parent.remove(child)
                assert xml_tree(x) == xml_tree(y), name
            elif name == 'Preview/PrvText.txt':
                # This externally authored sample has the known empty preview.
                # Its exact bytes are independent of the new text.
                assert before == after == b'\r\n', name
            elif name == 'Preview/PrvImage.png':
                assert before == after and len(after) == 4502
                assert hashlib.sha256(after).hexdigest() == 'ca5d23cd1aad2853672cdb0d116137a0bdc2ff62148da9886c264305d0025f3d'
            else:
                assert before == after, name
    return {'zipValid': True, 'partSetEqual': True, 'headerAndUnrelatedXmlEqual': True,
            'previewIsAuditedBlank': True,
            'paragraphIds': ['3121190098'], 'expectedText': expected}


MODEL = r"""
import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{resolve}from'node:path';import{pathToFileURL}from'node:url';
const[pkg,source,saved,expected]=process.argv.slice(2);const m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
const snapshot=d=>({format:d.getSourceFormat(),pages:d.pageCount(),controls:d.getControls(),paragraphs:Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getTextRange(s,p,0,d.getParagraphLength(s,p))))});
const a=new m.HwpDocument(readFileSync(source)),b=new m.HwpDocument(readFileSync(saved));try{const before=snapshot(a),after=snapshot(b);assert.equal(before.paragraphs[0][0],'');before.paragraphs[0][0]=expected;assert.deepEqual(after,before);console.log(JSON.stringify({modelEquivalent:true,controlsEqual:true,pagesEqual:true,expectedText:expected}));}finally{a.free();b.free();}
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
                command(args.xdotool,'key','Home');before=rhwp.settle(d,'before external edit');assert before['paragraphText']==''
                d.js(rhwp.EVENT_LOG)
                command(args.xdotool,'type','--delay','90','gk');mid=rhwp.settle(d,'external preedit')
                assert mid['composing']=='true' and mid['paragraphText']=='하',mid
                command(args.xdotool,'type','--delay','90','srmf');command(args.xdotool,'key','End')
                edited=rhwp.settle(d,'external commit');expected='한글'
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
                report['package']=package_preserved(source,path,expected)
                report['model']=json.loads(subprocess.check_output(['node','--input-type=module','-',str(pkg),str(source),str(path),expected],input=MODEL,text=True,cwd=ROOT))
                shutil.copyfile(path,args.out/'published.hwpx')
                # Same imported-ID boundary through actual UI: readable, export
                # fails closed, no save success and no changes to original bytes.
                negative=args.out/'duplicate-id.hwpx'
                hp='{http://www.hancom.co.kr/hwpml/2011/paragraph}'
                with zipfile.ZipFile(source) as a,zipfile.ZipFile(negative,'w') as b:
                    for info in a.infolist():
                        data=a.read(info.filename)
                        if info.filename=='Contents/section0.xml':
                            root=ET.fromstring(data);p=next(root.iter(hp+'p'));extra=ET.Element(hp+'p',dict(p.attrib));run=ET.SubElement(extra,hp+'run',{'charPrIDRef':'0'});ET.SubElement(run,hp+'t').text='중복';root.append(extra);data=ET.tostring(root,encoding='utf-8')
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
                assert diagnostic['diagnostic']['opened'] and 'duplicate HWPX paragraph id' in diagnostic['diagnostic']['error']
                assert sha(negative)==negative_hash and rejected['state']!='saved'
                report['negative']={'readable':True,'originalUnchanged':True,'result':rejected,
                                    'engineDiagnostic':diagnostic['diagnostic']}
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
    return run(p.parse_args())

if __name__=='__main__':sys.exit(main())
