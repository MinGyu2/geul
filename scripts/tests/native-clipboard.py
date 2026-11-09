#!/usr/bin/env python3
"""Plain-text clipboard acceptance in the actual Tauri/WebKitGTK app.
Run under the existing private X11 launcher with --app, --driver and --out.
Uses trusted WebDriver keys/buttons, real engines and the OS clipboard.
Write denial is explicit fault injection; successful clipboard operations use the OS.
Generated documents and evidence stay outside source control.
"""
import argparse
import contextlib
import hashlib
import json
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/e2e'))
import tauri_smoke as smoke


def main():
    p = argparse.ArgumentParser()
    for name in ('app', 'driver', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--port', type=int, default=4455)
    args = p.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(Path(args.app).resolve())
    smoke.DRIVER_LOG = out / 'driver.log'
    report = {'appSha256': hashlib.sha256(Path(args.app).read_bytes()).hexdigest(), 'checks': [], 'formats': {}}

    def check(name, ok, detail=None):
        report['checks'].append({'name': name, 'pass': bool(ok), 'detail': detail})
        print(name, 'PASS' if ok else 'FAIL', flush=True)
        if not ok:
            raise smoke.Failure(f'{name}: {detail!r}')

    def wait(d, code, *values, timeout=20):
        return smoke.wait_until(d, code, *values, timeout=timeout)

    def async_js(d, code, *values):
        d.js('window.__clipAsync=null;Promise.resolve().then(async()=>{' + code + '}).then(value=>window.__clipAsync={ok:true,value},error=>window.__clipAsync={ok:false,error:String(error)});', *values)
        wait(d, 'return window.__clipAsync!==null')
        result = d.js('return window.__clipAsync')
        if not result['ok']:
            raise smoke.Failure(str(result))
        return result['value']

    def chord(d, key):
        d.actions([{'type': 'key', 'id': 'clipboard', 'actions': [
            {'type': 'keyDown', 'value': smoke.KEYS['Control']}, {'type': 'keyDown', 'value': key},
            {'type': 'keyUp', 'value': key}, {'type': 'keyUp', 'value': smoke.KEYS['Control']}]}])

    def ribbon(d, op):
        d.click(f'.ribbon__toolbar [data-command="edit.{op}"]')
        check('ribbon ' + op + ' preserves editor focus', d.js("return document.activeElement?.classList.contains('rhwp-input')"))

    def focus(d):
        d.js("document.querySelector('.editor__scroll .rhwp-input').focus()")

    @contextlib.contextmanager
    def external_clipboard(text, delay=None):
        command = [sys.executable, str(Path(__file__).with_name('x11-clipboard-owner.py')), text]
        if delay is not None:
            command.append(str(delay))
        owner = subprocess.Popen(command, stdout=subprocess.PIPE, text=True)
        try:
            if not select.select([owner.stdout], [], [], 10)[0]:
                raise smoke.Failure('external clipboard owner did not start')
            identity = json.loads(owner.stdout.readline())
            report.setdefault('externalOwners', []).append(identity)
            yield owner
        finally:
            if owner.poll() is None:
                owner.terminate()
            owner.wait(timeout=5)

    def write(d, text):
        d.js('window.__clipPayload=arguments[0];window.__clipWritten=null', text)
        d.click('#clipboard-test-write')
        wait(d, 'return window.__clipWritten!==null')
        check('OS clipboard write', d.js('return window.__clipWritten') is True)

    def read(d):
        d.js('window.__clipRead=null')
        d.click('#clipboard-test-read')
        wait(d, 'return window.__clipRead!==null')
        result = d.js('return window.__clipRead')
        if 'error' in result:
            raise smoke.Failure(str(result))
        return result['text']

    def sessions(d):
        return async_js(d, "return await window.__TAURI_INTERNALS__.invoke('document_sessions')")

    def active(d, name):
        return next(s for s in sessions(d) if s['displayName'] == name)

    def settled(d, name, revision=None):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            s = active(d, name)
            if s['state'] == 'ready' and (revision is None or s['revision'] == revision):
                time.sleep(.15)
                return s
            time.sleep(.05)
        raise smoke.Failure(f'not settled: {name}, {s!r}')

    def copy_all(d, name, mode='keyboard'):
        focus(d)
        # Ctrl+A belongs to the hidden textarea, not the document. After paste
        # the document caret is at end; select backwards through all visual lines.
        actions = [{'type': 'keyDown', 'value': '\ue008'}]
        for _ in range(40):
            actions += [{'type': 'keyDown', 'value': '\ue013'}, {'type': 'keyUp', 'value': '\ue013'}]
        actions += [{'type': 'keyDown', 'value': '\ue011'}, {'type': 'keyUp', 'value': '\ue011'}, {'type': 'keyUp', 'value': '\ue008'}]
        d.actions([{'type': 'key', 'id': 'selection', 'actions': actions}])
        wait(d, "const b=document.querySelector('[data-command=\"edit.copy\"]');return b && b.getAttribute('aria-disabled')!=='true'")
        before = active(d, name)
        if mode == 'keyboard':
            chord(d, 'c')
        else:
            ribbon(d, 'copy')
        time.sleep(.3)
        value = read(d)
        after = active(d, name)
        check(name + ' Copy no revision/dirty mutation', (before['revision'], before['dirty']) == (after['revision'], after['dirty']))
        return value

    def open_doc(d, path):
        d.js("const e=document.querySelector('#document-path');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,arguments[0]);e.dispatchEvent(new Event('input',{bubbles:true}));", str(path))
        d.js("document.querySelector('.document-bar__open').requestSubmit()")
        try:
            wait(d, "return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&e.textContent.includes(arguments[0])&&e.dataset.state==='ready')", path.name, timeout=30)
        except Exception:
            print('OPEN DIAGNOSTIC', d.js("return {tabs:[...document.querySelectorAll('.document-tab__select')].map(e=>({text:e.textContent,data:{...e.dataset}})),status:document.querySelector('.statusbar__message')?.textContent,path:document.querySelector('#document-path')?.value}"), flush=True)
            raise
        wait(d, "return document.querySelector('.editor__scroll canvas')?.width>0", timeout=60)
        time.sleep(.3)

    try:
        # Generate only public API blank documents; no repository binary fixtures.
        build = json.loads((ROOT / 'public/rhwp/BUILD.json').read_text())
        folder = ROOT / 'public/rhwp/generations' / build['generation']
        subprocess.run(['node', '--input-type=module', '-e', '''
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [folder,out]=process.argv.slice(1);const m=await import(pathToFileURL(folder+'/rhwp.js'));m.initSync({module:readFileSync(folder+'/rhwp_bg.wasm')});
const d=m.HwpDocument.createEmpty();d.createBlankDocument();for(const f of ['hwp','hwpx']){const e=f==='hwp'?d.exportHwpWithReport():d.exportHwpxWithReport();try{writeFileSync(out+'/clipboard.'+f,e.takeBytes())}finally{e.free()}}d.free();
''', str(folder), str(out)], check=True)
        with tempfile.TemporaryDirectory(prefix='geul-clipboard-native-') as data:
            with smoke.tauri_driver(args.driver, args.port, data) as start, contextlib.ExitStack() as lifecycle:
                d = start()
                lifecycle.callback(d.quit)
                wait(d, "return document.querySelector('footer.statusbar')!==null", timeout=40)
                report['runtime'] = d.js('return {href:location.href,ua:navigator.userAgent,secure:isSecureContext,clipboard:typeof navigator.clipboard}')
                d.js("for(const [id,label] of [['write','W'],['read','R']]){const b=document.createElement('button');b.id='clipboard-test-'+id;b.textContent=label;b.style.position='fixed';b.style.top='0';b.style.right=id==='write'?'0':'40px';b.style.zIndex='9999';document.body.append(b)}document.querySelector('#clipboard-test-write').onclick=async()=>{try{await navigator.clipboard.writeText(window.__clipPayload);window.__clipWritten=true}catch(e){window.__clipWritten=String(e)}};document.querySelector('#clipboard-test-read').onclick=async()=>{try{window.__clipRead={text:await navigator.clipboard.readText()}}catch(e){window.__clipRead={error:String(e)}}}")
                docx = out / 'clipboard.docx'
                async_js(d, "const meta=new TextEncoder().encode(JSON.stringify({path:arguments[0],format:'docx',contentLoss:null}));const b=new Uint8Array(8+meta.length);b.set([71,78,67,49]);new DataView(b.buffer).setUint32(4,meta.length,true);b.set(meta,8);return await window.__TAURI_INTERNALS__.invoke('document_new',b)", str(docx))
                created = sessions(d)[0]
                async_js(d, "return await window.__TAURI_INTERNALS__.invoke('document_close',{sessionId:arguments[0]})", created['sessionId'])
                payload = '한😀글' * 220 + '\r\n둘\t셋\n끝'
                expected = payload.replace('\r\n', '\n')
                for fmt in ('docx', 'hwp', 'hwpx'):
                    name = 'clipboard.' + fmt
                    path = out / name
                    open_doc(d, path)
                    original = active(d, name)
                    # A separate X11 process owns this text: no same-origin
                    # navigator.writeText metadata can mask WebKit read denial.
                    with external_clipboard(payload):
                        focus(d)
                        chord(d, 'v')
                        settled(d, name, original['revision'] + 1)
                        check(name + ' external OS keyboard Paste exactly once', copy_all(d, name) == expected)
                    # Fault injection exercises real document/session failure safety;
                    # it is not claimed as an OS permission-denial experiment.
                    d.js("window.__savedWrite=navigator.clipboard.writeText;Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new DOMException('test denial','NotAllowedError')}})")
                    focus(d)
                    ribbon(d, 'cut')
                    wait(d, "return document.querySelector('.statusbar__message')?.textContent.includes('클립보드 작업')")
                    check(name + ' injected write denial never deletes', active(d, name)['revision'] == original['revision'] + 1)
                    d.js("Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:window.__savedWrite})")
                    focus(d)
                    ribbon(d, 'cut')
                    settled(d, name, original['revision'] + 2)
                    check(name + ' ribbon Cut writes full text', read(d) == expected)
                    # Persist the cut result before any replacement/paste.
                    focus(d)
                    chord(d, 's')
                    deadline = time.monotonic() + 30
                    while active(d, name)['dirty'] and time.monotonic() < deadline:
                        time.sleep(.1)
                    check(name + ' T009 saves successful Cut', not active(d, name)['dirty'])
                    cut_path = out / ('cut-saved.' + fmt)
                    cut_path.write_bytes(path.read_bytes())

                    focus(d)
                    ribbon(d, 'paste')
                    settled(d, name, original['revision'] + 3)
                    check(name + ' ribbon Paste exactly once', copy_all(d, name, 'ribbon') == expected)
                    focus(d)
                    chord(d, 'x')
                    settled(d, name, original['revision'] + 4)
                    check(name + ' keyboard Cut', read(d) == expected)
                    focus(d)
                    chord(d, 'v')
                    settled(d, name, original['revision'] + 5)
                    check(name + ' repeated paste request reads OS clipboard', copy_all(d, name) == expected)
                    write(d, '')
                    before = active(d, name)
                    focus(d)
                    ribbon(d, 'paste')
                    time.sleep(.3)
                    check(name + ' empty clipboard preserves selection/content/revision', active(d, name)['revision'] == before['revision'])
                    focus(d)
                    chord(d, 's')
                    deadline = time.monotonic() + 30
                    while active(d, name)['dirty'] and time.monotonic() < deadline:
                        time.sleep(.1)
                    check(name + ' T009 Save clears dirty', not active(d, name)['dirty'], d.js("return document.querySelector('.statusbar__message')?.textContent"))
                    # Reopen the actual saved bytes independently of the running model.
                    if fmt == 'docx':
                        with zipfile.ZipFile(path) as z:
                            root = ET.fromstring(z.read('word/document.xml'))
                            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                            paragraphs = []
                            for para in root.findall('.//w:body/w:p', ns):
                                paragraphs.append(''.join('\t' if el.tag.endswith('}tab') else (el.text or '') for el in para.iter() if el.tag.endswith('}t') or el.tag.endswith('}tab')))
                    else:
                        result = subprocess.check_output(['node', '--input-type=module', '-e', '''
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const [folder,file]=process.argv.slice(1);const m=await import(pathToFileURL(folder+'/rhwp.js'));m.initSync({module:readFileSync(folder+'/rhwp_bg.wasm')});const d=new m.HwpDocument(readFileSync(file));try{console.log(JSON.stringify(Array.from({length:d.getParagraphCount(0)},(_,p)=>d.getTextRange(0,p,0,d.getParagraphLength(0,p)))))}finally{d.free()}
''', str(folder), str(path)], text=True)
                        paragraphs = json.loads(result)
                    check(name + ' saved bytes independently reopened', paragraphs == expected.split('\n'), paragraphs)
                    report['formats'][fmt] = {'status': 'PASS', 'revision': active(d, name)['revision'], 'paragraphs': len(paragraphs)}
                # App ownership must cancel reads that complete after switching tabs.
                for fmt, other in [('docx','hwp'),('hwp','hwpx'),('hwpx','docx')]:
                    name = 'clipboard.' + fmt
                    d.js("[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0])).click()", name)
                    wait(d, "return [...document.querySelectorAll('.document-tab__select')].some(e=>e.textContent.includes(arguments[0])&&e.getAttribute('aria-selected')==='true')", name)
                    before = {s['sessionId']: s['revision'] for s in sessions(d)}
                    with external_clipboard('WRONG DOCUMENT', delay=1) as owner:
                        focus(d)
                        ribbon(d, 'paste')
                        if not select.select([owner.stdout], [], [], 10)[0]:
                            raise smoke.Failure('native clipboard read did not reach external owner')
                        check(name + ' native async read started', owner.stdout.readline().strip() == 'TEXT_REQUEST')
                        d.js("[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0])).click()", 'clipboard.' + other)
                        time.sleep(1.3)
                    check(name + ' async Paste canceled by document switch', {s['sessionId']:s['revision'] for s in sessions(d)} == before)
                # A protected DOCX still permits full read-only selection copying.
                source = out / 'clipboard.docx'
                protected = out / 'protected.docx'
                ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
                with zipfile.ZipFile(source) as archive, zipfile.ZipFile(protected, 'w', zipfile.ZIP_DEFLATED) as dest:
                    for item in archive.infolist():
                        data = archive.read(item.filename)
                        if item.filename == 'word/settings.xml':
                            settings = ET.fromstring(data)
                            ET.SubElement(settings, '{'+ns+'}documentProtection', {'{'+ns+'}edit':'readOnly','{'+ns+'}enforcement':'1'})
                            data = ET.tostring(settings, encoding='utf-8', xml_declaration=True)
                        dest.writestr(item, data)
                open_doc(d, protected)
                focus(d)
                d.actions([{'type':'key','id':'readonly','actions':[{'type':'keyDown','value':'\ue008'},{'type':'keyDown','value':smoke.KEYS['ArrowRight']},{'type':'keyUp','value':smoke.KEYS['ArrowRight']},{'type':'keyDown','value':smoke.KEYS['ArrowRight']},{'type':'keyUp','value':smoke.KEYS['ArrowRight']},{'type':'keyUp','value':'\ue008'}]}])
                wait(d, "return document.querySelector('[data-command=\"edit.copy\"]')?.getAttribute('aria-disabled')!=='true'")
                before = active(d, protected.name)
                ribbon(d, 'copy')
                time.sleep(.3)
                check('protected DOCX Copy allowed', read(d) == expected[:2])
                check('protected DOCX Cut and Paste blocked', d.js("return ['cut','paste'].every(op=>document.querySelector('[data-command=\"edit.'+op+'\"]')?.getAttribute('aria-disabled')==='true')"))
                focus(d)
                chord(d, 'x')
                time.sleep(.2)
                check('protected DOCX no mutation', active(d, protected.name)['revision'] == before['revision'])

        report['status'] = 'PASS'
        return 0
    except Exception as e:
        report['status'] = 'FAIL'
        report['error'] = str(e)
        traceback.print_exc()
        return 1
    finally:
        (out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.exit(main())
