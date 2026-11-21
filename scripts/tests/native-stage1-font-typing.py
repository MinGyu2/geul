#!/usr/bin/env python3
"""P0 native acceptance for collapsed-caret DOCX font size and IBus Hangul input.

Run under native-ibus-session.py against the current production Tauri build. The font-size
control is focused and changed through the real Ribbon component, the caret is restored by a
real WebDriver pointer click, and committed text arrives through X11/IBus. T009 saves the file;
the saved DrawingML is inspected directly and the app opens it in a fresh WordCraft session.
"""
import argparse
import hashlib
import importlib.util
import json
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

spec = importlib.util.spec_from_file_location('new_document_acceptance', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
SIZE = '[data-command="format.fontSize"] select'
SAMPLE = '한글 ABC'
ORIGINAL = '한글 문단입니다. Korean paragraph.'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def view_for(a, filename):
    sessions = a.sessions()
    session = next((item for item in sessions if item['displayName'] == filename), None)
    if session is None:
        raise smoke.Failure(f'DOCX session missing: {filename}')
    result = a.async_js(
        "return await window.__TAURI_INTERNALS__.invoke('docx_view',"
        "{sessionId:arguments[0],loadGeneration:arguments[1]})",
        session['sessionId'], session['loadGeneration'])
    if not result.get('ok'):
        raise smoke.Failure(f'docx_view failed: {result!r}')
    return session, result['value']['view']


def wait_view(a, filename, predicate, description, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        _, last = view_for(a, filename)
        if predicate(last):
            return last
        time.sleep(.1)
    raise smoke.Failure(f'timed out waiting for {description}: {last!r}')


def choose_size(a, d, size):
    rect = d.js("const r=document.querySelector(arguments[0])?.getBoundingClientRect();return r?[r.left+r.width/2,r.top+r.height/2]:null", SIZE)
    if not rect:
        raise smoke.Failure('Ribbon font-size select missing')
    base.wordcraft_poc.click(d, *rect)
    focused = d.js('return document.activeElement===document.querySelector(arguments[0])', SIZE)
    if not focused:
        raise smoke.Failure('Ribbon font-size select did not receive focus')
    a.key(*list(str(size)), 'Return')
    current = d.js('return document.querySelector(arguments[0])?.value', SIZE)
    if current != str(size):
        # Some WebKitGTK versions open a native option menu that does not implement type-ahead.
        # Keep the same real select and React command path, while preserving focus transfer.
        d.js("const s=document.querySelector(arguments[0]);if(!s)return false;s.focus();"
             "const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;"
             "set.call(s,arguments[1]);s.dispatchEvent(new Event('change',{bubbles:true}));return true", SIZE, str(size))
    a.wait('return document.querySelector(arguments[0])?.value===arguments[1]', SIZE, str(size), timeout=15)
    return {'size': size, 'selectionMethod': 'native select keyboard' if current == str(size) else 'focused select change event'}


def click_caret(d):
    rect = d.js("const r=document.querySelector('[data-testid=docx-caret]')?.getBoundingClientRect();"
                "return r?[r.left+r.width/2,r.top+r.height/2]:null")
    if not rect:
        raise smoke.Failure('rendered DOCX caret missing')
    base.wordcraft_poc.click(d, *rect)


def inspect_saved(path):
    with zipfile.ZipFile(path) as package:
        bad = package.testzip()
        if bad:
            raise smoke.Failure(f'corrupt ZIP member: {bad}')
        root = ET.fromstring(package.read('word/document.xml'))
    paragraphs = []
    for paragraph in root.findall('.//w:body/w:p', NS):
        runs = []
        text = ''.join(node.text or '' for node in paragraph.findall('.//w:t', NS))
        for run in paragraph.findall('./w:r', NS):
            run_text = ''.join(node.text or '' for node in run.findall('.//w:t', NS))
            if not run_text:
                continue
            size = run.find('./w:rPr/w:sz', NS)
            color = run.find('./w:rPr/w:color', NS)
            highlight = run.find('./w:rPr/w:highlight', NS)
            runs.append({'text': run_text, 'size': size.get(f'{{{W}}}val') if size is not None else None,
                         'color': color.get(f'{{{W}}}val') if color is not None else None,
                         'highlight': highlight.get(f'{{{W}}}val') if highlight is not None else None})
        paragraphs.append({'text': text, 'runs': runs})
    paragraph = next((p for p in paragraphs if SAMPLE in p['text']), None)
    if paragraph is None or not paragraph['text'].endswith(SAMPLE):
        raise smoke.Failure(f'saved text missing or out of order: {paragraphs!r}')
    start = paragraph['text'].rfind(SAMPLE)
    covered = 0
    properties = []
    offset = 0
    for run in paragraph['runs']:
        end = offset + len(run['text'])
        if end > start and offset < start + len(SAMPLE):
            properties.append(run)
            covered = max(covered, min(end, start + len(SAMPLE)) - start)
        offset = end
    if covered != len(SAMPLE) or not properties or any(run['size'] != '48' for run in properties):
        raise smoke.Failure(f'new text lacks serialized 24 pt w:sz=48: {properties!r}')
    original_sizes = []
    offset = 0
    for run in paragraph['runs']:
        end = offset + len(run['text'])
        if end > 0 and offset < len(ORIGINAL):
            original_sizes.append(run['size'])
        offset = end
    if not original_sizes or any(size != '20' for size in original_sizes):
        raise smoke.Failure(f'original selected text was not preserved at 10 pt: {original_sizes!r}')
    return {'paragraph': paragraph, 'originalCharacterSizes': original_sizes,
            'insertedRuns': properties, 'zipIntegrity': 'PASS'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    doc_dir = args.out / 'docs'
    doc_dir.mkdir()
    path = doc_dir / 's1-font-typing.docx'
    path.write_bytes(args.fixture.read_bytes())
    report = {'status': 'RUNNING', 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__), 'fixtureSha256': sha(path),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src', 'src-tauri'], cwd=ROOT)).hexdigest(),
              'environment': {'display': 'Linux X11/Xvfb', 'input': 'trusted xdotool key events', 'ime': 'IBus Hangul',
                              'syntheticComposition': False}}
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / 'driver.log'
    driver = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            driver = start()
            a = base.Acceptance(args, driver, report)
            a.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            base.wordcraft_poc.REPORT = report
            base.wordcraft_poc.calibrate_pointer(driver)
            window = a.command(args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
            a.command(args.xdotool, 'windowfocus', '--sync', window)
            a.open_native('docx', path)
            a.wait("return document.activeElement?.classList.contains('rhwp-input')===true")
            a.d.js("window.__s1Events=[];for(const type of ['compositionstart','compositionupdate','compositionend','input'])"
                   "window.addEventListener(type,e=>window.__s1Events.push({type,trusted:e.isTrusted,data:e.data??null,"
                   "inputType:e.inputType??null,target:e.target?.className??''}),true)")

            a.key('Home', 'shift+End')
            selected = wait_view(a, path.name, lambda v: not v['collapsed'], 'selected original line')
            if not selected['paragraphText'].startswith(ORIGINAL):
                raise smoke.Failure(f'unexpected source paragraph: {selected["paragraphText"]!r}')
            report['setOriginalSize'] = choose_size(a, driver, 10)
            driver.js("document.querySelector('.editor__scroll textarea.rhwp-input')?.focus()")
            a.key('End')
            at_ten = wait_view(a, path.name, lambda v: v['collapsed'] and v['chars']['size'] == 10,
                               'caret collapsed at end of 10 pt paragraph')
            if at_ten['caretOffset'] != len(ORIGINAL):
                raise smoke.Failure(f'caret is not at end of the 10 pt paragraph: {at_ten!r}')
            same_key = at_ten['caretKey']
            report['setPendingSize'] = choose_size(a, driver, 24)
            pending = wait_view(a, path.name, lambda v: v['collapsed'] and v['chars']['size'] == 24,
                                'pending 24 pt at collapsed caret')
            if pending['caretKey'] != same_key:
                raise smoke.Failure(f'font size control moved the caret: {same_key!r} -> {pending["caretKey"]!r}')
            click_caret(driver)
            restored = wait_view(a, path.name, lambda v: v['collapsed'], 'caret after native pointer focus restore')
            if restored['caretKey'] != same_key or restored['chars']['size'] != 24:
                raise smoke.Failure(f'same-caret focus restore lost pending formatting: {restored!r}')
            report['focusReturn'] = {'sameCaret': True, 'size': restored['chars']['size'], 'caretKey': restored['caretKey']}

            a.engine('xkb:us::eng')
            a.engine('hangul')
            driver.js("document.querySelector('.editor__scroll textarea.rhwp-input')?.focus()")
            a.wait("return document.activeElement?.classList.contains('rhwp-input')===true")
            a.type('gksrmf')
            time.sleep(.5)
            a.engine('xkb:us::eng')
            a.type(' ABC')
            typed = wait_view(a, path.name, lambda v: SAMPLE in v['paragraphText'], 'committed Hangul and Latin sample', timeout=30)
            if typed['chars']['size'] != 24:
                raise smoke.Failure(f'caret effective size after typing is not 24 pt: {typed["chars"]!r}')
            a.key('ctrl+z')
            wait_view(a, path.name, lambda v: SAMPLE not in v['paragraphText'], 'native Undo of committed input')
            a.key('ctrl+y')
            typed = wait_view(a, path.name, lambda v: SAMPLE in v['paragraphText'] and v['chars']['size'] == 24,
                              'native Redo of committed input')
            events = driver.js('return window.__s1Events')
            trusted = [event for event in events if event['trusted'] and event['target'] == 'rhwp-input']
            if not any(event['type'] == 'compositionstart' for event in trusted) or not any(event['type'] == 'compositionend' for event in trusted):
                raise smoke.Failure(f'no trusted native IME composition was observed: {events!r}')
            report['nativeIme'] = {'status': 'PASS', 'trustedEvents': trusted, 'paragraphText': typed['paragraphText']}

            report['save'] = a.save('docx')
            report['savedSha256'] = sha(path)
            report['serialized'] = inspect_saved(path)
            old_session, _ = view_for(a, path.name)
            if not base.rhwp_poc.close_tab(driver, path.name):
                raise smoke.Failure('saved DOCX requested discard on close')
            a.open_native('docx', path)
            new_session, reopened = view_for(a, path.name)
            if new_session['sessionId'] == old_session['sessionId'] or new_session['revision'] != 0 or new_session['dirty']:
                raise smoke.Failure(f'DOCX was not reopened in a clean independent session: {new_session!r}')
            if SAMPLE not in reopened['paragraphText']:
                raise smoke.Failure(f'reopened WordCraft model lost typed text: {reopened["paragraphText"]!r}')
            driver.js("document.querySelector('.editor__scroll textarea.rhwp-input')?.focus()")
            a.key('End')
            reopened = wait_view(a, path.name, lambda v: v['collapsed'], 'reopened end caret')
            if reopened['chars']['size'] != 24:
                raise smoke.Failure(f'reopened caret does not inherit 24 pt: {reopened["chars"]!r}')
            report['reopen'] = {'status': 'PASS', 'freshSession': True, 'revision': new_session['revision'],
                                'sizeAtTypedTextEnd': reopened['chars']['size'], 'paragraphText': reopened['paragraphText']}
            driver.screenshot(args.out / 'final.png')
            driver.quit()
            driver = None
        report['teardown'] = smoke.TEARDOWN
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), traceback=traceback.format_exc())
        if driver:
            try:
                report['failureState'] = driver.js("return {notice:document.querySelector('footer.statusbar')?.textContent,focus:document.activeElement?.outerHTML?.slice(0,400)}")
                driver.screenshot(args.out / 'failure.png')
            except Exception as inspection_error:
                report['failureInspectionError'] = str(inspection_error)
            try:
                driver.quit()
            except Exception as cleanup_error:
                report['driverCleanupError'] = str(cleanup_error)
            report['teardown'] = smoke.TEARDOWN
    finally:
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'error': report.get('error'), 'reopen': report.get('reopen')}, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
