#!/usr/bin/env python3
"""T012 Phase 2 native acceptance: normal embedded production frontend, actual Tauri save service, X11/IBus.

Nested-table direct editing (native click into a nested cell, typing, trusted Hangul IME composition, Undo/Redo,
real Ctrl+S publication, native reopen) and the table-structure ribbon commands (insert row, merge right,
refusal while composing). No product test hooks or engine observer. Saved files are verified afterwards by the
independent Release-WASM oracle `t012-phase2-native-oracle.mjs`. Run inside native-ibus-session.py.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp

spec = importlib.util.spec_from_file_location('production_native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

LOCATE = ('const g=arguments[0],c=document.querySelectorAll("canvas.rhwp-page__canvas")[g.pageIndex],s=document.querySelector(".editor__scroll"),'
          'r=c.getBoundingClientRect(),v=s.getBoundingClientRect(),y=r.top+(g.y+g.height/2)*r.height/g.page.height;'
          'if(arguments[1])s.scrollTop+=y-(v.top+v.height/2);const n=c.getBoundingClientRect();'
          'return {x:n.left+(g.x+1)*n.width/g.page.width,y:n.top+(g.y+g.height/2)*n.height/g.page.height}')
STRUCTURE = ['table.insertRowAbove', 'table.insertRowBelow', 'table.insertColumnLeft', 'table.insertColumnRight',
             'table.deleteRow', 'table.deleteColumn', 'table.mergeRight', 'table.mergeBelow', 'table.splitCell']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    geometry = json.loads(args.geometry.read_text())
    saved = report.setdefault('saved', [])

    def check(name, value):
        report.setdefault('checks', []).append({'name': name, 'status': 'PASS' if value else 'FAIL'})
        assert value, name

    def idle():
        a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision')

    def revision(fmt):
        return int(a.status(fmt)['localRevision'])

    def tab(name):
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()===arguments[0])b.click()', name)

    def disabled(name):
        tab('한글 도구')
        a.wait('return !!document.querySelector(arguments[0])', '[data-command="' + name + '"]')
        return d.js('return document.querySelector(arguments[0]).getAttribute("aria-disabled")==="true"', '[data-command="' + name + '"]')

    def ribbon(name):
        tab('한글 도구')
        selector = '[data-command="' + name + '"]'
        a.wait('return !!document.querySelector(arguments[0])', selector)
        d.js('const b=document.querySelector(arguments[0]);if(b.getAttribute("aria-disabled")==="true")throw Error(b.title);b.click()', selector)

    def click(item):
        d.js(LOCATE, item, True)
        last, since, deadline = None, time.monotonic(), time.monotonic() + 10
        while True:
            point = d.js(LOCATE, item, False)
            now = time.monotonic()
            if point != last:
                last, since = point, now
            elif now - since >= .7:
                break
            assert now < deadline, 'page rectangle did not settle'
            time.sleep(.05)
        rhwp.click(d, point['x'], point['y'])

    def caret_ends(suffix):
        a.wait('return (document.querySelector("[data-testid=rhwp-status]")?.dataset.caret||"").endsWith(arguments[0])', suffix)

    def save(fmt, path, name):
        result = a.save(fmt)
        check(f'{fmt} {name} durable clean indicator', result['synced'] == 'true' and result['changedSince'] == 'false')
        copy = args.out / f'{name}.{fmt}'
        shutil.copyfile(path, copy)
        saved.append({'format': fmt, 'name': name, 'path': str(copy), 'sha256': sha(copy)})

    def undo_redo(fmt, label):
        before = revision(fmt)
        a.key('ctrl+z'); idle()
        check(f'{fmt} {label} native Undo committed', revision(fmt) == before + 1)
        a.key('ctrl+y'); idle()
        check(f'{fmt} {label} native Redo committed', revision(fmt) == before + 2)

    def calibrate():
        d.js('window.__p2Pointer=null;window.addEventListener("mousemove",e=>window.__p2Pointer=[e.clientX,e.clientY],true)')
        rhwp.perform(d, [{"type": "pointer", "id": "calibrate", "parameters": {"pointerType": "mouse"},
                          "actions": [{"type": "pointerMove", "x": 100, "y": 100, "origin": "viewport"}]}])
        a.wait('return window.__p2Pointer!==null')
        measured = d.js('return window.__p2Pointer')
        d.pointer_scale = (100 / measured[0], 100 / measured[1])

    for row in geometry['fixtures']:
        fmt = row['format']
        # ---- A. nested cell ----
        nested = row['nested']
        source = Path(nested['source'])
        check(f'{fmt} nested source identity', sha(source) == nested['sha256'])
        path = args.out / f'nested-native.{fmt}'
        shutil.copyfile(source, path)
        a.open(fmt, path)
        a.engine('xkb:us::eng')
        check(f'{fmt} test-only text hook absent', d.js('return !document.querySelector("[data-testid=rhwp-status]").hasAttribute("data-paragraph-text")'))
        calibrate()
        click(nested['geometry'])
        caret_ends(nested['caretSuffix'])
        check(f'{fmt} native click resolves the nested cell path', a.status(fmt)['caret'].endswith(nested['caretSuffix']))
        check(f'{fmt} nested cell refuses metrics/formula/structure', all(disabled(c) for c in ['hangul.charWidth', 'hangul.insertTableFormula', *STRUCTURE]))
        a.key('Home'); caret_ends(nested['caretSuffix'])
        before = revision(fmt)
        a.type('N1'); idle()
        check(f'{fmt} nested typing committed', revision(fmt) > before)
        undo_redo(fmt, 'nested typing')
        d.js('window.__p2Ime=[];for(const t of ["compositionstart","compositionupdate","compositionend"])document.querySelector(".rhwp-input").addEventListener(t,e=>window.__p2Ime.push({type:t,data:e.data,trusted:e.isTrusted}),true)')
        a.engine('hangul'); a.type('gk')
        a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.composing==="true"')
        check(f'{fmt} composing refuses structure commands', all(disabled(c) for c in STRUCTURE))
        a.type('s'); a.key('End'); idle(); a.engine('xkb:us::eng')
        events = d.js('return window.__p2Ime')
        check(f'{fmt} trusted native Korean composition in nested cell',
              any(e['type'] == 'compositionstart' and e['trusted'] for e in events) and any(e['type'] == 'compositionend' and e['trusted'] and e['data'] == '한' for e in events))
        report.setdefault('nativeIme', []).append({'format': fmt, 'events': events})
        caret_ends(nested['caretSuffix'])  # still the same nested cell and paragraph
        undo_redo(fmt, 'nested Korean input')
        save(fmt, path, 'nested-save')
        d.screenshot(args.out / f'{fmt}-nested.png')
        assert rhwp.close_tab(d, path.name)
        a.open_native(fmt, path)
        check(f'{fmt} nested published native reopen clean', a.status(fmt)['status'] == 'ready' and a.status(fmt)['dirty'] == 'false')
        assert rhwp.close_tab(d, path.name)
        check(f'{fmt} nested source still immutable', sha(source) == nested['sha256'])

        # ---- B. table structure ribbon commands ----
        table = row['table']
        source = Path(table['source'])
        check(f'{fmt} table source identity', sha(source) == table['sha256'])
        path = args.out / f'table-native.{fmt}'
        shutil.copyfile(source, path)
        a.open(fmt, path)
        a.engine('xkb:us::eng')
        calibrate()
        click(table['cells'][4])
        caret_ends('@0/4/0')
        # HWP structural eligibility waits for the original-document preflight started at load.
        tab('한글 도구')
        try:
            a.wait('return document.querySelector(\'[data-command="table.insertRowBelow"]\')?.getAttribute("aria-disabled")!=="true"', timeout=60)
        except Exception:
            report['insertRowRefusal'] = {'title': d.js('return document.querySelector(\'[data-command="table.insertRowBelow"]\')?.title'),
                                          'status': a.status(fmt)}
            raise
        check(f'{fmt} unmerged cell refuses split', disabled('table.splitCell'))
        before = revision(fmt)
        ribbon('table.insertRowBelow'); idle()
        check(f'{fmt} insert row committed one revision', revision(fmt) == before + 1)
        caret_ends('@0/4/0')
        undo_redo(fmt, 'insert row')
        before = revision(fmt)
        ribbon('table.mergeRight'); idle()
        check(f'{fmt} merge right committed one revision', revision(fmt) == before + 1)
        a.wait('return document.querySelector(\'[data-command="table.splitCell"]\')?.getAttribute("aria-disabled")!=="true"')
        undo_redo(fmt, 'merge right')
        a.key('End'); a.type('M'); idle()
        save(fmt, path, 'table-save')
        d.screenshot(args.out / f'{fmt}-table.png')
        assert rhwp.close_tab(d, path.name)
        a.open_native(fmt, path)
        check(f'{fmt} table published native reopen clean', a.status(fmt)['status'] == 'ready' and a.status(fmt)['dirty'] == 'false')
        assert rhwp.close_tab(d, path.name)
        check(f'{fmt} table source still immutable', sha(source) == table['sha256'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'geometry'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'scope': 'T012 Phase 2; normal embedded production assets; native XTest/IBus; actual Tauri save service; no engine observer'}
    smoke.APP = str(args.app); smoke.DRIVER_LOG = str(args.out / 'driver.log')
    code = 1
    try:
        with smoke.tauri_driver(str(args.driver), 4444, str(args.out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, 'return !!document.querySelector(".document-bar")', timeout=30)
                run(args, d, report)
                report['status'] = 'PASS'; code = 0
            except Exception:
                report['failureDom'] = d.js('return document.body.innerText.slice(-4000)')
                d.screenshot(args.out / 'failure.png')
                raise
            finally:
                smoke.end_session(d)
    except Exception as error:
        traceback.print_exc(); report.update(status='FAIL', error=type(error).__name__ + ': ' + str(error))
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return code


if __name__ == '__main__':
    sys.exit(main())
