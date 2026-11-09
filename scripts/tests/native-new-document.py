#!/usr/bin/env python3
"""T023: real Tauri UI + native GTK chooser + X11/IBus input.

Requires the project's local tests/ harness and a prepared isolated X11/IBus
environment. Never synthesizes DOM composition events. Documents stay ignored.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp', 'tests/integration/wordcraft'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc
import wordcraft_poc


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Acceptance:
    def __init__(self, args, driver, report):
        self.args, self.d, self.report = args, driver, report

    def command(self, *args):
        return subprocess.check_output(args, text=True, env={k: v for k, v in os.environ.items() if k != 'LD_LIBRARY_PATH'}).strip()

    def key(self, *keys):
        self.command(self.args.xdotool, 'key', '--clearmodifiers', '--delay', '60', *keys)

    def type(self, text):
        self.command(self.args.xdotool, 'type', '--clearmodifiers', '--delay', '90', text)

    def engine(self, name):
        self.command(self.args.ibus, 'engine', name)

    def wait(self, script, *args, timeout=30):
        smoke.wait_until(self.d, script, *args, timeout=timeout)

    def async_js(self, code, *args):
        self.d.js("window.__ndAsync=null; Promise.resolve().then(async()=>{" + code + "}).then(value=>window.__ndAsync={ok:true,value},error=>window.__ndAsync={ok:false,error});", *args)
        self.wait('return window.__ndAsync!==null')
        return self.d.js('return window.__ndAsync')

    def sessions(self):
        result = self.async_js("return await window.__TAURI_INTERNALS__.invoke('document_sessions')")
        if not result.get('ok'):  # explicit: must hold under python -O as well
            raise smoke.Failure(f'document_sessions failed: {result!r}')
        return result['value']

    def status(self, fmt):
        prefix = 'docx' if fmt == 'docx' else 'rhwp'
        return self.d.js('const e=document.querySelector(arguments[0]);return e?{...e.dataset}:null', f'[data-testid={prefix}-status]')

    def ready(self, fmt, filename):
        self.wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true' && e.textContent.includes(arguments[0]) && e.dataset.state==='ready')", filename, timeout=60)
        prefix = 'docx' if fmt == 'docx' else 'rhwp'
        self.wait("const e=document.querySelector(arguments[0]);return e?.dataset.status==='ready' && e.dataset.firstPaintMs!==''", f'[data-testid={prefix}-status]', timeout=60)
        self.wait("return document.querySelector('.editor__scroll canvas')?.width>0")

    def text_is(self, fmt, text):
        self.wait("return document.querySelector(arguments[0])?.dataset.paragraphText===arguments[1]", f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]', text)
        self.wait("return document.querySelector(arguments[0])?.dataset.composing==='false'", f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]')

    def chooser(self, path, title):
        self.engine('xkb:us::eng')
        deadline = time.monotonic() + 15
        windows = ''
        while time.monotonic() < deadline:
            result = subprocess.run([self.args.xdotool, 'search', '--onlyvisible', '--name', '^' + title + '$'], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                windows = result.stdout.split()[-1]
                break
            time.sleep(.1)
        if not windows:  # explicit: never type a path into the editor under python -O
            raise smoke.Failure(f'native GTK chooser not visible: {title}')
        self.command(self.args.xdotool, 'windowfocus', '--sync', windows)
        self.key('ctrl+l', 'ctrl+a')
        self.type(str(path))
        self.key('Return')
        return windows

    def new(self, fmt, path):
        self.key('ctrl+n')
        self.wait("return document.querySelector('[data-testid=new-document-dialog]')!==null")
        for _ in range(['docx', 'hwp', 'hwpx'].index(fmt)):
            self.key('Down')
        self.wait("return document.querySelector('input[name=new-document-format]:checked')?.value===arguments[0]", fmt)
        self.key('Tab', 'Tab', 'Return')
        self.wait("return document.querySelector('[data-testid=new-document-dialog]')===null")
        self.chooser(path, '새 문서 만들기')

    def open(self, fmt, path):
        # Reopen through the existing product path form; file I/O and engine
        # loading are real. Only New requires the native destination chooser.
        rhwp_poc.set_path(self.d, path)
        self.d.js("document.querySelector('.document-bar__open').requestSubmit()")
        self.ready(fmt, path.name)

    def open_native(self, fmt, path):
        self.key('ctrl+o')
        window=self.chooser(path,'문서 열기')
        # GTK resolves the typed location asynchronously. If it only selected
        # the file, activate that same dialog once more; target the old XID so
        # a racing close cannot deliver Return to an editor document.
        visible=True;deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            probe=subprocess.run([self.args.xdotool,'getwindowname',window],capture_output=True,text=True)
            if probe.returncode!=0:visible=False;break
            time.sleep(.1)
        if visible:self.command(self.args.xdotool,'key','--window',window,'Return')
        self.ready(fmt,path.name)
        return visible

    def native_reopen(self, fmt, path):
        visible=self.open_native(fmt,path)
        self.text_is(fmt,'한글 Changed Second')
        assert rhwp_poc.close_tab(self.d,path.name)
        self.report.setdefault('nativeReopen',[]).append({'format':fmt,'status':'PASS','secondDialogActivation':visible})

    def save(self, fmt):
        prefix = 'docx' if fmt == 'docx' else 'rhwp'
        self.key('ctrl+s')
        self.wait("const e=document.querySelector(arguments[0]);return e && ['saved','failed'].includes(e.dataset.state)", f'[data-testid={prefix}-save-result]', timeout=60)
        value = self.d.js('return {...document.querySelector(arguments[0]).dataset}', f'[data-testid={prefix}-save-result]')
        assert value['state'] == 'saved', value
        self.wait("return document.querySelector(arguments[0])?.dataset.dirty==='false'", f'[data-testid={prefix}-status]')
        return value

    def positive(self, fmt):
        path = self.args.out / ('created.' + fmt)
        row = {'format': fmt, 'status': 'RUNNING', 'stages': []}
        self.report['positive'].append(row)
        self.new(fmt, path)
        self.ready(fmt, path.name)
        assert path.is_file()
        self.wait("return document.activeElement?.classList.contains('rhwp-input')===true")
        assert self.status(fmt)['paragraphText'] == ''
        assert self.status(fmt)['pages'] == '1'
        session = self.sessions()[0]
        assert session['format'] == fmt and session['engine'] == ('wordcraft' if fmt == 'docx' else 'rhwp')
        self.d.screenshot(self.args.out / (fmt + '-blank.png'))
        row['stages'].append('native New/format/destination/publication/session/first paint/focus PASS')
        self.d.js(rhwp_poc.EVENT_LOG if fmt != 'docx' else wordcraft_poc.EVENT_LOG)
        self.engine('hangul')
        self.type('gk')
        self.wait("return document.querySelector(arguments[0])?.dataset.composing==='true'", f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]')
        self.type('srmf')
        self.key('End')
        self.text_is(fmt, '한글')
        row['imeEvents'] = self.d.js('return window.__imeLog')
        assert any(e[0]=='compositionstart' for e in row['imeEvents']) and any(e[0]=='compositionend' for e in row['imeEvents'])
        row['nativeIme'] = 'PASS: xdotool → IBus hangul → GTK/WebView composition'
        self.engine('xkb:us::eng')
        self.type(' English')
        self.text_is(fmt, '한글 English')
        self.type('XYZ')
        self.key('BackSpace', 'BackSpace', 'BackSpace')
        self.text_is(fmt, '한글 English')
        self.key('Home', 'Right', 'Right', 'Return')
        self.text_is(fmt, ' English')
        self.key('BackSpace')
        self.text_is(fmt, '한글 English')
        self.key('Home', 'Right', 'Right', 'Right', 'shift+End')
        self.type('Changed')
        self.text_is(fmt, '한글 Changed')
        row['editing'] = 'PASS: Korean/English, insert/delete, split/merge, caret, selection replacement'
        row['save1'] = self.save(fmt)
        self.key('End')
        self.type(' Second')
        self.text_is(fmt, '한글 Changed Second')
        row['save2'] = self.save(fmt)
        self.d.screenshot(self.args.out / (fmt + '-edited.png'))
        row['savedSha256'] = sha(path)
        assert rhwp_poc.close_tab(self.d, path.name), 'clean created document requested discard'
        row['nativeOpenSecondActivation']=self.open_native(fmt,path)
        self.text_is(fmt, '한글 Changed Second')
        reopened = self.sessions()[0]
        assert reopened['sessionId'] != session['sessionId'] and reopened['format'] == fmt
        assert reopened['revision'] == 0 and not reopened['dirty']
        row['reopen'] = 'PASS: fresh session, requested format, text, revision 0/clean'
        if fmt in ('hwpx', 'docx'):
            with zipfile.ZipFile(path) as package:
                assert package.testzip() is None
                body = package.read('Contents/section0.xml' if fmt == 'hwpx' else 'word/document.xml')
                xml = ET.fromstring(body)
                namespace = 'http://www.hancom.co.kr/hwpml/2011/paragraph' if fmt == 'hwpx' else 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
                assert ''.join(e.text or '' for e in xml.iter('{' + namespace + '}t')) == '한글 Changed Second'
            row['independentStructure'] = 'PASS: ZIP CRC + complete XML + expected text'
        else:
            import importlib.util
            spec = importlib.util.spec_from_file_location('creation_oracle', ROOT / 'scripts/tests/new-document-structure.py')
            oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
            parts = oracle.cfb_streams(path.read_bytes())
            assert parts['FileHeader'][35] == 5
            assert not any('Summary' in n or n.startswith(('Scripts/', 'DocOptions/')) for n in parts)
            assert parts['PrvText'].decode('utf-16le').rstrip('\r\n') == '한글 Changed Second'
            row['independentStructure'] = 'PASS: CFB + HWP5 header + metadata absent + regenerated current preview'
        assert rhwp_poc.close_tab(self.d, path.name)
        row['status'] = 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--formats', nargs='+', choices=['docx', 'hwp', 'hwpx'], default=['docx', 'hwp', 'hwpx'])
    parser.add_argument('--port', type=int, default=4444)
    parser.add_argument('--open-only',type=Path)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'positive': [], 'negative': [], 'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__), 'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git','diff','HEAD','--','src','src-tauri'],cwd=ROOT)).hexdigest(), 'environment': {'display': 'X11/Xvfb', 'ime': 'IBus hangul native xdotool', 'syntheticComposition': False}}
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / 'driver.log'
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start()
            test = Acceptance(args, d, report)
            test.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            window = test.command(args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
            test.command(args.xdotool, 'windowfocus', '--sync', window)
            identity = test.async_js("return await (await fetch('/rhwp/BUILD.json')).json()")
            assert identity['ok'], identity
            report['rhwpIdentity'] = identity['value']
            report['location'] = d.js('return location.href')
            try:
                for fmt in args.formats:
                    if args.open_only:test.native_reopen(fmt,args.open_only/('created.'+fmt))
                    else:test.positive(fmt)
                    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                d.quit(); d = None
            except Exception:
                try:
                    report['failureDom']=d.js("return {status:[...document.querySelectorAll('[data-testid$=status]')].map(e=>({...e.dataset})),focus:document.activeElement?.outerHTML,notice:document.querySelector('footer.statusbar')?.textContent}")
                    d.screenshot(args.out/'failure.png')
                finally:
                    d.quit(); d=None
                raise
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), trace=traceback.format_exc())
        for row in report['positive']:
            if row['status']=='RUNNING': row['status']='FAIL'
        if d:
            try: report['failureDom']=d.js("return {status:[...document.querySelectorAll('[data-testid$=status]')].map(e=>({...e.dataset})),focus:document.activeElement?.outerHTML,notice:document.querySelector('footer.statusbar')?.textContent}")
            except Exception: pass
        if d:
            try: d.screenshot(args.out / 'failure.png')
            except Exception: pass
            try: d.quit()
            except Exception as cleanup: report['cleanupError'] = str(cleanup)
    finally:
        report['teardown'] = smoke.TEARDOWN
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'positive': report['positive'], 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
