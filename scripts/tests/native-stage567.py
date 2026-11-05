#!/usr/bin/env python3
"""Stage 5/6/7: real Tauri commands and IBus keys; reuses T023 infrastructure.

Run in the isolated X11/IBus environment used by native-new-document.py.
No synthetic composition events. Documents and event traces stay in --out.
"""
import argparse
import importlib.util
import json
import shutil
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp', 'tests/integration/wordcraft'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp
import wordcraft_poc as docx
import native_probe
from native_rhwp_observer import app_observer

spec = importlib.util.spec_from_file_location('new_document', ROOT/'scripts/tests/native-new-document.py')
nd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nd)


def run(args, d, report):
    a = nd.Acceptance(args, d, report)
    a.engine("xkb:us::eng")
    def check(name, value):
        report.setdefault('checks', []).append({'name': name, 'status': 'PASS' if value else 'FAIL'})
        assert value, name
    def button(command):
        return f'[data-command="{command}"]'
    def command(command):
        # Select the real ribbon tab before its command. No session methods are invoked.
        tab = '참조' if command.startswith('references.') else '검토' if command.startswith('review.') else '한글 도구'
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()===arguments[0])b.click()', tab)
        a.wait('return !!document.querySelector(arguments[0])', button(command))
        d.js('const b=document.querySelector(arguments[0]);if(b.getAttribute("aria-disabled")==="true")throw Error("unavailable: "+b.title);b.click()', button(command))
    def input_command(command_id,text):
        command(command_id)
        a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
        a.key('ctrl+a');a.type(text);a.key('Return')
        a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        a.wait('return Number(document.querySelector("[data-testid=rhwp-status]")?.dataset.localRevision)===Number(document.querySelector("[data-testid=rhwp-status]")?.dataset.revision)')
    def formula(text):
        input_command('hangul.insertTableFormula',text)
    def click_cell(cell):
        geometry=d.js('return window.__rhwpProbe.cell(0,0,2,arguments[0])',cell)
        assert geometry and geometry['height']>0
        point=d.js('const g=arguments[0],c=document.querySelectorAll("canvas.rhwp-page__canvas")[g.pageIndex],r=c.getBoundingClientRect();return {x:r.left+(g.x+1)*r.width/g.page.width,y:r.top+(g.y+g.height/2)*r.height/g.page.height}',geometry)
        rhwp.click(d,point['x'],point['y'])
        a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.caret.includes("@")')
    for fmt in (() if args.area == 'docx' else ('hwp','hwpx')):
        source=args.formulas/f'created-{fmt}-normalized.{fmt}'
        path=args.out/f'native-formula.{fmt}'
        shutil.copyfile(source,path)
        a.open(fmt,path)
        # Calibrate the existing WebDriver pointer against actual DOM events.
        d.js("window.__stageMove=null;window.addEventListener('mousemove',e=>window.__stageMove=[e.clientX,e.clientY],true)")
        rhwp.perform(d,[{"type":"pointer","id":"calibrate","parameters":{"pointerType":"mouse"},"actions":[{"type":"pointerMove","x":100,"y":100,"origin":"viewport"}]}])
        a.wait('return window.__stageMove!==null')
        measured=d.js('return window.__stageMove');d.pointer_scale=(100/measured[0],100/measured[1])
        rhwp.click_paragraph_start(d)
        # The real loader/prototype observer follows hit tests on the live document.
        click_cell(3)
        d.js('document.querySelector("[data-tab=hangulTools]")?.click()')
        # Existing ribbon tabs use role/name rather than test-only API.
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.includes("한글 도구"))b.click()')
        if args.production:
            input_command('hangul.tableFormula','=SUM(A1:B1)')
            check(fmt+' production read-only calculation', a.status(fmt)['localRevision']=='0' and a.status(fmt)['dirty']=='false' and d.js('return window.__rhwpProbe.fields().length===0'))
            check(fmt+' production formula disabled',d.js('return document.querySelector(arguments[0])?.getAttribute("aria-disabled")==="true"',button('hangul.insertTableFormula')))
            check(fmt+' production metrics disabled',d.js('return document.querySelector(arguments[0])?.getAttribute("aria-disabled")==="true"',button('hangul.charWidth')))
        else:
            click_cell(0);a.key('Home','shift+Right')
            input_command('hangul.charWidth','150')
            input_command('hangul.charSpacing','10')
            input_command('hangul.charWidth','180')
            a.key('ctrl+z');time.sleep(.2);a.key('ctrl+y');time.sleep(.2)
            shape=d.js('return window.__rhwpProbe.cellProperties(0,0,2,0)')
            check(fmt+' repeated metrics and Undo/Redo',shape['ratios']==[180]*7 and shape['spacings']==[10]*7)
            click_cell(2);a.engine('hangul');a.type('gksrmf');a.key('End')
            a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.paragraphText==="한글"')
            check(fmt+' Korean input after formatting',a.status(fmt)['paragraphText']=='한글')
            a.engine('xkb:us::eng');click_cell(3)
            formula('=SUM(A1:B1)')
            a.save(fmt)
            formula('=1+2')
            a.key('ctrl+z');time.sleep(.2);a.key('ctrl+y');time.sleep(.2)
            a.save(fmt)
            check(fmt+' formula two saves',a.status(fmt)['dirty']=='false')
            check(fmt+' live persistent field',any(f['command']=='=1+2??%g,;;3' and f['value']=='3' for f in d.js('return window.__rhwpProbe.fields()')))
        assert rhwp.close_tab(d,path.name)
        a.open_native(fmt,path)
        check(fmt+' native reopen',a.status(fmt)['status']=='ready')
        if not args.production:
            rhwp.click_paragraph_start(d)
            check(fmt+' reopened persistent field',any(f['command']=='=1+2??%g,;;3' and f['value']=='3' for f in d.js('return window.__rhwpProbe.fields()')))
        assert rhwp.close_tab(d,path.name)
    if args.production or args.area == 'rhwp':return
    # Native DOCX tracked insertion/deletion and advanced references.
    path=args.out/'advanced.docx'
    # Source is generated by the existing fixture tool; no private input is published.
    shutil.copyfile(args.docx,path)
    a.open('docx',path)
    def audit(label):
        if args.step_saves:
            report.setdefault('stepSaves',[]).append({'step':label,'status':'RUNNING'})
            a.save('docx');report['stepSaves'][-1]['status']='PASS'
    audit('unedited baseline')
    docx.click_paragraph_start(d)
    a.engine('xkb:us::eng')
    a.key('Home','Right','shift+Right','shift+Right')
    command('review.comment');a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
    a.type('native hyperlink comment');a.key('Return');docx.idle(d);audit('hyperlink comment')
    a.key('Left','ctrl+Home')
    command('references.toc');docx.idle(d);audit('TOC insert')
    command('references.updateToc');docx.idle(d);audit('TOC update')
    a.engine('xkb:us::eng')
    a.key('ctrl+End')
    for cmd,text in [('references.footnote','native footnote'),('references.endnote','native endnote')]:
        command(cmd);a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
        a.type(text);a.key('Return');docx.idle(d);audit(cmd)
    command('review.trackChanges');docx.idle(d);audit('tracking toggle')
    # Real Hangul composition in a tracked document, followed by native deletion.
    d.js('document.querySelector(".docx-surface .rhwp-input").focus()')
    d.js("window.__imeLog=[];for(const t of ['keydown','compositionstart','compositionupdate','compositionend','input','blur','focus'])document.querySelector('.docx-surface .rhwp-input').addEventListener(t,e=>window.__imeLog.push([t,e.isComposing??null,e.inputType??null,(e.data??'').length]),true)")
    a.engine('hangul');a.type('gksrmf');a.key('End');docx.idle(d);audit('Korean tracked input')
    a.engine('xkb:us::eng');a.key('BackSpace');docx.idle(d);audit('tracked deletion')
    events=d.js('return window.__imeLog');check('native Korean composition observed',any(e[0]=='compositionstart' for e in events) and any(e[0]=='compositionend' for e in events))
    report['docxNativeEvents']=events
    a.key('ctrl+z','ctrl+y');docx.idle(d)
    a.save('docx')
    with zipfile.ZipFile(path) as archive:
        xml=archive.read('word/document.xml').decode()
        tree=ET.fromstring(xml)
        ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        check('DOCX TOC persisted', any((node.text or '').strip().startswith('TOC ') for node in tree.findall('.//w:instrText',ns)))
        check('DOCX tracked insertion persisted', bool(tree.findall('.//w:ins',ns)))
        check('DOCX tracked deletion persisted', bool(tree.findall('.//w:del',ns)))
        check('DOCX native footnote persisted', b'native footnote' in archive.read('word/footnotes.xml'))
        check('DOCX native endnote persisted', b'native endnote' in archive.read('word/endnotes.xml'))
        check('DOCX hyperlink comment persisted', b'native hyperlink comment' in archive.read('word/comments.xml'))
    shutil.copyfile(path,args.out/'advanced-tracked.docx')
    command('review.rejectAll');docx.idle(d)
    d.js('document.querySelector(".docx-surface .rhwp-input").focus()');a.type('Accepted');docx.idle(d)
    command('review.acceptAll');docx.idle(d)
    command('review.trackChanges');docx.idle(d);audit('tracking toggle')
    a.save('docx')
    check('DOCX TOC notes tracked edits accepted and two saves',a.status('docx')['dirty']=='false')
    with zipfile.ZipFile(path) as archive:
        xml=archive.read('word/document.xml').decode()
        tree=ET.fromstring(xml)
        check('DOCX acceptance removed revisions', not tree.findall('.//w:ins',ns) and not tree.findall('.//w:del',ns))
    assert docx.close_without_prompt(d,path.name)
    a.open_native('docx',path)
    check('DOCX native reopen',a.status('docx')['status']=='ready')
    assert docx.close_without_prompt(d,path.name)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('app','driver','out','formulas','docx'):
        parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--xdotool',required=True)
    parser.add_argument('--ibus',required=True)
    parser.add_argument('--production',action='store_true')
    parser.add_argument('--step-saves',action='store_true')
    parser.add_argument('--area',choices=['all','rhwp','docx'],default='all')
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=False)
    report={'status':'RUNNING','scope':'real Tauri; native XTest/IBus input; internal formula fixtures'}
    smoke.APP=str(args.app);smoke.DRIVER_LOG=str(args.out/'driver.log')
    code=1
    try:
        with smoke.tauri_driver(str(args.driver),4444,str(args.out/'data')) as start:
            d=start()
            try:
                smoke.wait_until(d,'return !!document.querySelector(".document-bar")',timeout=30)
                native_probe.install(d, app_observer(native_probe.INSTALL))
                run(args,d,report)
                report['status']='PASS';code=0
            except Exception:
                report['failureDom']=d.js('return {text:document.body.innerText.slice(-3000),rhwp:document.querySelector("[data-testid=rhwp-status]")?.dataset,docx:document.querySelector("[data-testid=docx-status]")?.dataset}')
                d.screenshot(args.out/'failure.png')
                raise
            finally:smoke.end_session(d)
    except Exception as error:
        import traceback
        traceback.print_exc();report.update(status='FAIL',error=type(error).__name__+': '+str(error))
    (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return code

if __name__=='__main__':sys.exit(main())
