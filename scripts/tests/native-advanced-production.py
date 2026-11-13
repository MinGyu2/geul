#!/usr/bin/env python3
"""T012 normal embedded frontend, actual Tauri save service and native X11/IBus.

No product test hooks or engine/prototype observer. Geometry and saved-file
verification come independently from the hash-verified Release WASM runtime.
Run inside the existing isolated X11/IBus launcher; source fixtures stay immutable.
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


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    geometry = json.loads(args.geometry.read_text())
    def check(name, value):
        report.setdefault('checks', []).append({'name': name, 'status': 'PASS' if value else 'FAIL'})
        assert value, name
    def idle():
        a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision')
    def tab(name):
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()===arguments[0])b.click()', name)
    def command(name):
        tab('한글 도구')
        selector = '[data-command="' + name + '"]'
        a.wait('return !!document.querySelector(arguments[0])', selector)
        d.js('const b=document.querySelector(arguments[0]);if(b.getAttribute("aria-disabled")==="true")throw Error(b.title);b.click()', selector)
        a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
    def input_command(name, text=None, expected=None):
        command(name)
        if expected is not None:
            check(name + ' owned expression prefilled', d.js('return document.querySelector("[data-testid=command-input-dialog] input").value') == expected)
        if text is not None:
            a.key('ctrl+a'); a.command(args.xdotool, 'type', '--clearmodifiers', '--delay', '90', '--', text)  # '--': negative values are text, not options
        a.key('Return')
        a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        idle()
    def save(fmt, name):
        result = a.save(fmt)
        check(fmt + ' ' + name + ' durable clean indicator', result['synced'] == 'true' and result['changedSince'] == 'false')
        shutil.copyfile(path, args.out / (name + '.' + fmt))
    def undo_redo(fmt, label):
        revision = int(a.status(fmt)['localRevision'])
        a.key('ctrl+z'); idle()
        check(fmt + ' ' + label + ' native Undo committed', int(a.status(fmt)['localRevision']) == revision + 1)
        a.key('ctrl+y'); idle()
        check(fmt + ' ' + label + ' native Redo committed', int(a.status(fmt)['localRevision']) == revision + 2)
    def click_position(item):
        # A click in the short editor viewport's bottom band reaches the native
        # scroller, not the page (observed target .editor__scroll while
        # elementFromPoint still reports the canvas). Center the target and wait
        # for a stable page rectangle; late settle/notice changes also move it.
        locate = 'const g=arguments[0],c=document.querySelectorAll("canvas.rhwp-page__canvas")[g.pageIndex],s=document.querySelector(".editor__scroll"),r=c.getBoundingClientRect(),v=s.getBoundingClientRect(),y=r.top+(g.y+g.height/2)*r.height/g.page.height;if(arguments[1])s.scrollTop+=y-(v.top+v.height/2);const n=c.getBoundingClientRect();return {x:n.left+(g.x+1)*n.width/g.page.width,y:n.top+(g.y+g.height/2)*n.height/g.page.height}'
        d.js(locate, item, True)
        last, since, deadline = None, time.monotonic(), time.monotonic() + 10
        while True:
            point = d.js(locate, item, False)
            now = time.monotonic()
            if point != last:
                last, since = point, now
            elif now - since >= .7:
                break
            assert now < deadline, 'page rectangle did not settle'
            time.sleep(.05)
        rhwp.click(d, point['x'], point['y'])
    def click_cell(cell):
        click_position(row['cells'][cell])
        # Exact cell: "@" alone also matches a caret left in another cell by a lost click.
        a.wait('return new RegExp("@\\\\d+/"+arguments[0]+"/\\\\d+$").test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret)', cell)
    for row in geometry['fixtures']:
        fmt = row['format']
        source = Path(row['source'])
        check(fmt + ' immutable source identity', hashlib.sha256(source.read_bytes()).hexdigest() == row['sha256'])
        path = args.out / ('native-formula.' + fmt)
        shutil.copyfile(source, path)
        a.open(fmt, path)
        a.engine('xkb:us::eng')
        check(fmt + ' test-only text hook absent', d.js('return !document.querySelector("[data-testid=rhwp-status]").hasAttribute("data-paragraph-text")'))
        # Native pointer calibration, ordinary DOM observation only.
        d.js('window.__advancedPointer=null;window.addEventListener("mousemove",e=>window.__advancedPointer=[e.clientX,e.clientY],true)')
        rhwp.perform(d, [{"type": "pointer", "id": "calibrate", "parameters": {"pointerType": "mouse"}, "actions": [{"type": "pointerMove", "x": 100, "y": 100, "origin": "viewport"}]}])
        a.wait('return window.__advancedPointer!==null')
        measured = d.js('return window.__advancedPointer')
        d.pointer_scale = (100 / measured[0], 100 / measured[1])
        # New measurement only: Return in a command dialog to observed local revision.
        # It is deliberately not the official D4 group-start endpoint.
        d.js('''window.__advancedUi=[];window.__advancedStart=null;
          document.addEventListener('keydown',e=>{if(e.key==='Escape')window.__advancedStart=null;if(e.key==='Enter'&&e.target.closest('[data-testid=command-input-dialog]'))window.__advancedStart=performance.now()},true);
          new MutationObserver(list=>{if(window.__advancedStart!==null&&list.some(x=>x.attributeName==='data-local-revision')){window.__advancedUi.push(performance.now()-window.__advancedStart);window.__advancedStart=null}}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-local-revision']});''')
        # Character width -> first real save -> spacing/repeated width -> Undo/Redo -> save.
        click_cell(1); a.key('Home', 'shift+Right')
        before = a.status(fmt)['localRevision']
        command('hangul.charWidth'); a.key('ctrl+a'); a.type('49'); a.key('Return')
        a.wait('return !!document.querySelector("[data-testid=command-input-error]")')
        check(fmt + ' invalid width causes no mutation', a.status(fmt)['localRevision'] == before)
        a.key('Escape'); a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        input_command('hangul.charWidth', '150')
        save(fmt, 'width-first-save')
        input_command('hangul.charSpacing', '10')
        input_command('hangul.charWidth', '180')
        undo_redo(fmt, 'cell metric')
        save(fmt, 'metrics-second-save')
        # General production history records Korean input; advanced commands
        # must still refuse while composition is open.
        click_cell(2)
        d.js('window.__advancedIme=[];for(const t of ["compositionstart","compositionupdate","compositionend"])document.querySelector(".rhwp-input").addEventListener(t,e=>window.__advancedIme.push({type:t,data:e.data,trusted:e.isTrusted}),true)')
        a.engine('hangul'); a.type('gk')
        a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.composing==="true"')
        check(fmt + ' active IME refuses metrics and formula', d.js('return ["hangul.charWidth","hangul.insertTableFormula"].every(id=>document.querySelector(`[data-command="${id}"]`).getAttribute("aria-disabled")==="true")'))
        a.type('srmf'); a.key('End'); idle(); a.engine('xkb:us::eng')
        events = d.js('return window.__advancedIme')
        check(fmt + ' trusted native Korean composition', any(e['type'] == 'compositionstart' and e['trusted'] for e in events) and any(e['type'] == 'compositionend' and e['trusted'] for e in events))
        before = a.status(fmt)['localRevision']
        a.key('ctrl+z'); idle()
        check(fmt + ' Korean input Undo committed', int(a.status(fmt)['localRevision']) == int(before) + 1)
        a.key('ctrl+y'); idle()
        check(fmt + ' Korean input Redo committed', int(a.status(fmt)['localRevision']) == int(before) + 2)
        report.setdefault('nativeIme', []).append({'format': fmt, 'events': events})
        # Formula insertion, first publication, native close/reopen, replacement.
        click_cell(3)
        input_command('hangul.insertTableFormula', '=SUM(A1:B1)')
        save(fmt, 'formula-first-save')
        assert rhwp.close_tab(d, path.name)
        a.open_native(fmt, path)
        click_cell(3)
        input_command('hangul.insertTableFormula', '=SUM(A1:B1)+1', expected='=SUM(A1:B1)')
        undo_redo(fmt, 'formula replacement')
        save(fmt, 'formula-replaced-save')
        # Invalid syntax stays in the modal, without changing revision or document.
        before = a.status(fmt)['localRevision']
        command('hangul.insertTableFormula'); a.key('ctrl+a'); a.type('=1+'); a.key('Return')
        a.wait('return !!document.querySelector("[data-testid=command-input-error]")')
        check(fmt + ' invalid formula causes no mutation', a.status(fmt)['localRevision'] == before)
        a.key('Escape'); a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        # A persistent field reading its own cell would grow on each recalculation.
        command('hangul.insertTableFormula'); a.key('ctrl+a'); a.type('=SUM(A1:B2)'); a.key('Return')
        a.wait('return !!document.querySelector("[data-testid=command-input-error]")')
        check(fmt + ' self-referencing formula causes no mutation', a.status(fmt)['localRevision'] == before)
        a.key('Escape'); a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        click_cell(0); a.key('Home', 'shift+End'); a.type('11'); idle()
        click_cell(3)
        input_command('hangul.insertTableFormula', expected='=SUM(A1:B1)+1')
        save(fmt, 'formula-recalculated-save')
        # The body uses a different engine setter than a table cell. Exercise
        # its actual ribbon/save path too, after the mixed cell/formula edits.
        click_position(row['body']); idle()
        check(fmt + ' supported body context', '@' not in a.status(fmt)['caret'])
        a.key('Home', 'shift+Right', 'shift+Right', 'shift+Right', 'shift+Right')
        input_command('hangul.charWidth', '125')
        save(fmt, 'body-width-save')
        input_command('hangul.charSpacing', '-7')
        undo_redo(fmt, 'body spacing')
        save(fmt, 'body-spacing-save')
        # Valid product UI context refusals, without a hidden session API.
        click_position(row['body']); tab('한글 도구'); idle()
        check(fmt + ' body caret refuses table formula', d.js('return document.querySelector(arguments[0]).getAttribute("aria-disabled")==="true"', '[data-command="hangul.insertTableFormula"]'))
        d.screenshot(args.out / (fmt + '-production.png'))
        report.setdefault('uiTiming', []).append({'format': fmt, 'samplesMs': d.js('return window.__advancedUi'), 'endpoint': 'command-dialog native Return to local revision DOM attribute; not D4'})
        assert rhwp.close_tab(d, path.name)
        a.open_native(fmt, path)
        check(fmt + ' second published reopen', a.status(fmt)['status'] == 'ready' and a.status(fmt)['dirty'] == 'false')
        assert rhwp.close_tab(d, path.name)
        check(fmt + ' source still immutable', hashlib.sha256(source.read_bytes()).hexdigest() == row['sha256'])


def stale_preview(args, d, report):
    """Genuine Hancom HWP with non-empty previews: the product path must refuse, not publish."""
    a = base.Acceptance(args, d, report)
    fixture = json.loads(args.stale_preview.read_text())
    source = Path(fixture['source'])
    original = hashlib.sha256(source.read_bytes()).hexdigest()
    assert original == fixture['sha256'], 'fixture changed since geometry capture'
    path = args.out / source.name
    shutil.copyfile(source, path)
    a.open('hwp', path)
    a.engine('xkb:us::eng')
    item = fixture['geometry']
    locate = 'const g=arguments[0],c=document.querySelectorAll("canvas.rhwp-page__canvas")[g.pageIndex],s=document.querySelector(".editor__scroll"),r=c.getBoundingClientRect(),v=s.getBoundingClientRect();s.scrollTop+=r.top+g.y*r.height/g.page.height-(v.top+v.height/2);const n=c.getBoundingClientRect();return {x:n.left+(g.x+1)*n.width/g.page.width,y:n.top+(g.y+g.height/2)*n.height/g.page.height}'
    point = d.js(locate, item)
    rhwp.click(d, point['x'], point['y'])
    a.wait('return new RegExp("@\\\\d+/"+arguments[0]+"/\\\\d+$").test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret)', fixture['cell'])
    d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()==="한글 도구")b.click()')
    selector = '[data-command="hangul.insertTableFormula"]'
    a.wait('return !!document.querySelector(arguments[0])', selector)
    d.js('const b=document.querySelector(arguments[0]);if(b.getAttribute("aria-disabled")==="true")throw Error(b.title);b.click()', selector)
    a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
    prefill = d.js('return document.querySelector("[data-testid=command-input-dialog] input").value')
    # Switching documents while the input dialog is open must drop the request, not apply it elsewhere.
    other = args.out / ('other-' + source.name)
    shutil.copyfile(source, other)
    a.open('hwp', other)
    a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
    switched = {'otherRevision': a.status('hwp')['localRevision'], 'otherDirty': a.status('hwp')['dirty']}
    assert switched == {'otherRevision': '0', 'otherDirty': 'false'}, switched
    d.js("[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0])&&!e.textContent.includes('other-')).click()", source.name)
    a.wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&!e.textContent.includes('other-'))")
    a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.status==="ready"&&s.dataset.localRevision==="0"&&s.dataset.dirty==="false"')
    report['dialogDocumentSwitch'] = {**switched, 'originRevisionAfterSwitch': a.status('hwp')['localRevision'], 'status': 'PASS'}
    point = d.js(locate, item)
    rhwp.click(d, point['x'], point['y'])
    a.wait('return new RegExp("@\\\\d+/"+arguments[0]+"/\\\\d+$").test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret)', fixture['cell'])
    d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()==="한글 도구")b.click()')
    a.wait('return !!document.querySelector(arguments[0])', selector)
    d.js('document.querySelector(arguments[0]).click()', selector)
    a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
    a.key('ctrl+a'); a.type('=SUM(ABOVE)'); a.key('Return')
    a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
    a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision')
    revision = a.status('hwp')['localRevision']
    a.key('ctrl+s')
    a.wait("const e=document.querySelector('[data-testid=rhwp-save-result]');return e && ['saved','failed'].includes(e.dataset.state)", timeout=60)
    result = d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
    status = a.status('hwp')
    d.screenshot(args.out / 'stale-preview.png')
    row = {'fixture': str(source), 'sha256': original, 'unfamiliarFormulaPrefill': prefill, 'revisionAfterEdit': revision, 'saveResult': result,
           'dirtyAfterRefusal': status['dirty'], 'copyUnchanged': hashlib.sha256(path.read_bytes()).hexdigest() == original,
           'sourceUnchanged': hashlib.sha256(source.read_bytes()).hexdigest() == original,
           'notice': d.js("return document.querySelector('footer.statusbar')?.textContent"), 'errorText': d.js('return document.querySelector("[data-testid=rhwp-save-result]").textContent')}
    report['stalePreview'] = row
    assert result['state'] == 'failed', row
    assert status['dirty'] == 'true', row
    assert row['copyUnchanged'] and row['sourceUnchanged'], row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--geometry', type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--stale-preview', type=Path, help='cell-geometry JSON; run only the genuine-file refusal stage')
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'scope': 'normal embedded production assets; native XTest/IBus; actual Tauri save service; no engine observer'}
    smoke.APP = str(args.app); smoke.DRIVER_LOG = str(args.out / 'driver.log')
    code = 1
    try:
        with smoke.tauri_driver(str(args.driver), 4444, str(args.out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, 'return !!document.querySelector(".document-bar")', timeout=30)
                if args.stale_preview:
                    stale_preview(args, d, report)
                else:
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
