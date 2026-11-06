#!/usr/bin/env python3
"""Native short-viewport acceptance; use the isolated X11/IBus launcher.

Uses the production surface and exact caret identity. Records the native overlay
scrollbar separately from editable page targets; does not center every click.
Default mode requires the product correction. --expect-bottom-loss preserves the
original overlay diagnostic on the baseline app; it is not repair acceptance.
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
sys.path[:0] = [str(ROOT / 'tests/e2e'), str(ROOT / 'tests/integration/rhwp')]
import tauri_smoke as smoke
import rhwp_poc as rhwp

spec = importlib.util.spec_from_file_location('native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    def check(name, value):
        report.setdefault('checks', []).append({'name': name, 'passed': bool(value)})
        assert value, name
    # Capture trusted events without changing routing or engine methods.
    d.js('window.__pointerEvents=[];for(const t of ["mousemove","mousedown","mouseup","click"])window.addEventListener(t,e=>window.__pointerEvents.push({type:t,x:e.clientX,y:e.clientY,target:e.target.className,trusted:e.isTrusted}),true)')
    rhwp.perform(d, [{'type': 'pointer', 'id': 'calibrate', 'parameters': {'pointerType': 'mouse'}, 'actions': [{'type': 'pointerMove', 'x': 100, 'y': 100, 'origin': 'viewport'}]}])
    a.wait('return window.__pointerEvents.length>0')
    measured = d.js('return window.__pointerEvents.at(-1)')
    d.pointer_scale = (100 / measured['x'], 100 / measured['y'])
    locate = '''const g=arguments[0],fraction=arguments[1],s=document.querySelector('.editor__scroll'),c=document.querySelector('canvas.rhwp-page__canvas');
      const r=c.getBoundingClientRect(),v=s.getBoundingClientRect(),y=r.top+(g.y+g.height/2)*r.height/g.page.height;
      if(fraction!==null)s.scrollTop+=y-(v.top+v.height*fraction);
      const n=c.getBoundingClientRect();const x=n.left+(g.x+1)*n.width/g.page.width,yy=n.top+(g.y+g.height/2)*n.height/g.page.height;
      return {x,y:yy,viewport:v.toJSON(),canvas:n.toJSON(),scrollTop:s.scrollTop,scrollLeft:s.scrollLeft,clientWidth:s.clientWidth,clientHeight:s.clientHeight,scrollWidth:s.scrollWidth,usableBottom:v.top+s.clientHeight,usableRight:v.left+s.clientWidth,hit:document.elementFromPoint(x,yy)?.className}'''
    for fixture in json.loads(args.geometry.read_text())['fixtures']:
        fmt = fixture['format']; source = Path(fixture['source'])
        check(fmt + ' source identity', hashlib.sha256(source.read_bytes()).hexdigest() == fixture['sha256'])
        path = args.out / ('pointer.' + fmt); shutil.copyfile(source, path); a.open(fmt, path)
        # Keep the actual 1280x800 layout with its ~221px editor viewport.
        initial = d.js(locate, fixture['cells'][3], None)
        check(fmt + ' short viewport', 180 < initial['viewport']['height'] < 250)
        for label, fraction, cell in [('top', .14, 0), ('middle', .5, 1), ('bottom-visible', .80, 3), ('scrolled-top', .14, 2)]:
            d.js(locate, fixture['cells'][cell], fraction); time.sleep(.8)
            point = d.js(locate, fixture['cells'][cell], None)
            d.js('window.__pointerEvents=[]')
            rhwp.click(d, point['x'], point['y'])
            expected = f'0:1:0@0/{cell}/0'
            a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret===arguments[0]', expected)
            events = d.js('return window.__pointerEvents')
            check(fmt + ' ' + label + ' exact caret', a.status(fmt)['caret'] == expected)
            check(fmt + ' ' + label + ' trusted page target', any(e['type'] == 'mousedown' and e['target'] == 'rhwp-page__canvas' and e['trusted'] for e in events))
            report.setdefault('pageClicks', []).append({'format': fmt, 'case': label, 'point': point, 'events': events, 'caret': expected})
        # The old invisible overlay band extends above the painted thumb.
        # Classic gutters make the last whole editable pixel explicit. Keep the
        # original rounded y=751 as a separate scrollbar case below.
        d.js(locate, fixture['cells'][3], .9); time.sleep(.8)
        point = d.js(locate, fixture['cells'][3], None)
        if not args.expect_bottom_loss:
            point['unroundedY'] = point['y']
            point['y'] = int(point['y'])
        before = a.status(fmt)['caret']; d.js('window.__pointerEvents=[]')
        rhwp.click(d, point['x'], point['y'])
        d.screenshot(args.out / (fmt + '-bottom-band.png'))
        events = d.js('return window.__pointerEvents')
        after = a.status(fmt)['caret']
        report.setdefault('bottomBand', []).append({'format': fmt, 'point': point, 'events': events, 'caretBefore': before, 'caretAfter': after})
        if args.expect_bottom_loss:
            check(fmt + ' baseline invisible overlay hit region reproduced', after == before and any(e['type'] == 'mousedown' and e['target'] == 'editor__scroll' for e in events))
        else:
            check(fmt + ' last bottom-band pixel is visible page', round(point['y']) < int(point['usableBottom']))
            check(fmt + ' bottom-band native click selects exact cell', after == '0:1:0@0/3/0')
            check(fmt + ' bottom-band native event reaches canvas', any(e['type'] == 'mousedown' and e['target'] == 'rhwp-page__canvas' and e['trusted'] for e in events))
            check(fmt + ' native horizontal gutter reserved', point['clientHeight'] < point['viewport']['height'])
            before = after
        # Original y~751 coordinate is now visibly occupied by a real scrollbar;
        # it must be classified by the measured gutter, not elementFromPoint.
        legacy = d.js(locate, fixture['cells'][3], .905); time.sleep(.8)
        legacy = d.js(locate, fixture['cells'][3], None)
        if not args.expect_bottom_loss:
            check(fmt + ' original751 is now visibly reserved scrollbar', round(legacy['y']) >= int(legacy['usableBottom']))
            d.js('window.__pointerEvents=[]'); rhwp.click(d,legacy['x'],legacy['y'])
            legacy_events=d.js('return window.__pointerEvents')
            check(fmt + ' original751 remains a scrollbar interaction', a.status(fmt)['caret']==before and any(e['type']=='mousedown' and e['target']=='editor__scroll' for e in legacy_events))
        else:
            legacy_events=[]
        report.setdefault('legacy751', []).append({'format':fmt, 'point':legacy, 'events':legacy_events})
        # Test the actual visible thumb separately. The DOM reports overlay
        # scrollbars as zero-width gutters; elementFromPoint omits their hit area.
        sx, sy = d.pointer_scale
        thumb_y = (point['usableBottom'] + point['viewport']['bottom']) / 2 if not args.expect_bottom_loss else point['viewport']['bottom'] - 10
        before_scroll = d.js('return document.querySelector(".editor__scroll").scrollLeft')
        rhwp.drag(d, (point['x'] * sx, thumb_y * sy), ((point['x'] + 60) * sx, thumb_y * sy)); time.sleep(.5)
        after_scroll = d.js('return document.querySelector(".editor__scroll").scrollLeft')
        report.setdefault('scrollbars', []).append({'format': fmt, 'y': thumb_y, 'before': before_scroll, 'after': after_scroll})
        check(fmt + ' visible scrollbar drag scrolls without moving caret', after_scroll > before_scroll and a.status(fmt)['caret'] == before)
        if not args.expect_bottom_loss:
            # Native vertical thumb and mouse wheel; no DOM scroll simulation.
            d.js('document.querySelector(".editor__scroll").scrollTop=0')
            x = (point['usableRight'] + point['viewport']['right']) / 2
            top = point['viewport']['top']
            prior_caret = a.status(fmt)['caret']
            rhwp.drag(d, (x*sx,(top+30)*sy), (x*sx,(top+85)*sy)); time.sleep(.5)
            vertical = d.js('return document.querySelector(".editor__scroll").scrollTop')
            check(fmt + ' native vertical thumb scrolls', vertical > 0 and a.status(fmt)['caret'] == prior_caret)
            report.setdefault('vertical', []).append({'format':fmt, 'scrollTop':vertical})
            wheel_before = vertical
            a.command(args.xdotool, 'mousemove', '--sync', str(round(point['x']*sx)), str(round((top+80)*sy)))
            a.command(args.xdotool, 'click', '5'); time.sleep(.5)
            wheel_after = d.js('return document.querySelector(".editor__scroll").scrollTop')
            check(fmt + ' native wheel scrolls', wheel_after > wheel_before and a.status(fmt)['caret'] == prior_caret)
            # Selection dragging remains a page operation with exact endpoints.
            d.js('document.querySelector(".editor__scroll").scrollLeft=0')
            d.js(locate, fixture['cells'][0], .5); time.sleep(.8)
            q=d.js(locate, fixture['cells'][0], None)
            rhwp.drag(d,(q['x']*sx,q['y']*sy),((q['x']+18)*sx,q['y']*sy))
            a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.selection==="0:1:0@0/0/0|0:1:2@0/0/0"')
            check(fmt + ' native selection exact endpoints', a.status(fmt)['caret'] == '0:1:2@0/0/0')
            # Zoom changes canvas geometry; the same conversion must still select cell2.
            d.js("""document.querySelector('[data-command="view.zoomOut"]').click()""")
            d.js(locate, fixture['cells'][2], .5); time.sleep(.8)
            q=d.js(locate, fixture['cells'][2], None); rhwp.click(d,q['x'],q['y'])
            a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:0@0/2/0"')
            check(fmt + ' zoomed native click exact cell', a.status(fmt)['caret'] == '0:1:0@0/2/0')
            d.js("""document.querySelector('[data-command="view.zoomIn"]').click()""")
        check(fmt + ' pointer tests leave revision and dirty unchanged' , a.status(fmt)['localRevision'] == '0' and a.status(fmt)['dirty'] == 'false')
        # Typing following a real page click must affect that exact cell, not
        # the previous cell. Inspect via ordinary caret/dirty UI (no text hooks).
        d.js('document.querySelector(".editor__scroll").scrollLeft=0')
        d.js(locate, fixture['cells'][3], .9 if not args.expect_bottom_loss else .80); time.sleep(.8)
        point = d.js(locate, fixture['cells'][3], None)
        if not args.expect_bottom_loss: point['y']=int(point['y'])
        rhwp.click(d, point['x'], point['y'])
        a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:0@0/3/0"')
        a.engine('xkb:us::eng'); a.type('X')
        a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:1@0/3/0"')
        check(fmt + ' typing remains in intended cell', a.status(fmt)['dirty'] == 'true')
        if not args.expect_bottom_loss:
            d.js('window.__pointerIme=[];for(const type of ["compositionstart","compositionend"])document.querySelector(".rhwp-input").addEventListener(type,e=>window.__pointerIme.push({type:e.type,data:e.data,trusted:e.isTrusted}),true)')
            a.engine('hangul'); a.type('gksrmf'); a.key('End'); a.engine('xkb:us::eng')
            a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.composing==="false"&&document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:3@0/3/0"')
            ime=d.js('return window.__pointerIme')
            check(fmt + ' Korean IME owns newly clicked cell', any(e['type']=='compositionstart' and e['trusted'] for e in ime) and any(e['type']=='compositionend' and e['trusted'] for e in ime))
            report.setdefault('ime',[]).append({'format':fmt,'events':ime})
        result = a.save(fmt)
        check(fmt + ' intended-cell edit published durably', result['synced'] == 'true')
        shutil.copyfile(path, args.out / ('pointer-first.' + fmt))
        assert rhwp.close_tab(d, path.name)
        if not args.expect_bottom_loss:
            a.open(fmt, path)
            d.js(locate, fixture['cells'][3], .9); time.sleep(.8)
            q=d.js(locate, fixture['cells'][3], None); rhwp.click(d,q['x'],int(q['y']))
            a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:0@0/3/0"')
            check(fmt + ' published reopen exact cell and clean', a.status(fmt)['dirty'] == 'false')
            # The rebuilt production app also exercises A at the real service
            # boundary: an acyclic field is saved twice; its cycle-closing peer
            # must not increment revision or appear in either published file.
            def formula(cell, expression, accepted, prefill=None):
                d.js(locate, fixture['cells'][cell], .5); time.sleep(.8)
                q=d.js(locate, fixture['cells'][cell], None); rhwp.click(d,q['x'],q['y'])
                a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret===arguments[0]', f'0:1:0@0/{cell}/0')
                revision=int(a.status(fmt)['localRevision']); dirty=a.status(fmt)['dirty']
                d.js('for(const t of document.querySelectorAll("[role=tab]"))if(t.textContent.trim()==="한글 도구")t.click()')
                d.js("""const b=document.querySelector('[data-command="hangul.insertTableFormula"]');if(b.getAttribute("aria-disabled")==="true")throw Error(b.title);b.click()""")
                a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
                if prefill is not None:
                    check(fmt + ' reopened formula expression prefilled', d.js('return document.querySelector("[data-testid=command-input-value]").value') == prefill)
                a.key('ctrl+a'); a.type(expression); a.key('Return')
                a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
                a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s.dataset.localRevision===s.dataset.revision&&s.dataset.composing==="false"')
                check(fmt + ' formula ' + expression + (' accepted' if accepted else ' refused before mutation'), int(a.status(fmt)['localRevision']) == revision + (1 if accepted else 0))
                if not accepted:
                    check(fmt + ' cycle refusal preserves dirty', a.status(fmt)['dirty'] == dirty)
            formula(0, '=B1+1', True)
            formula(1, '=A1+1', False)
            check(fmt + ' acyclic formula first durable publication', a.save(fmt)['synced'] == 'true')
            shutil.copyfile(path,args.out/('formula-first.'+fmt))
            assert rhwp.close_tab(d,path.name); a.open(fmt,path)
            formula(0, '=B1+2', True, '=B1+1')
            check(fmt + ' acyclic formula second durable publication', a.save(fmt)['synced'] == 'true')
            shutil.copyfile(path,args.out/('formula-second.'+fmt))
            assert rhwp.close_tab(d,path.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'geometry'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expect-bottom-loss', action='store_true')
    parser.add_argument('--xdotool', required=True); parser.add_argument('--ibus', required=True)
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'bottomViewportIssue': 'BASELINE_DIAGNOSTIC' if args.expect_bottom_loss else 'FIX_REQUIRED', 'scope': 'actual production Tauri; trusted native pointer; no routing overrides'}
    smoke.APP = str(args.app); smoke.DRIVER_LOG = str(args.out / 'driver.log')
    try:
        with smoke.tauri_driver(str(args.driver), 4444, str(args.out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, 'return !!document.querySelector(".document-bar")', timeout=30)
                run(args, d, report); report['status'] = 'PASS'; report['bottomViewportIssue']='REPRODUCED_UNFIXED' if args.expect_bottom_loss else 'CORRECTED'
            finally:
                smoke.end_session(d)
    except Exception as error:
        traceback.print_exc(); report.update(status='FAIL', error=str(error))
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
