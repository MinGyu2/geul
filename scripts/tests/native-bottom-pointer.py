#!/usr/bin/env python3
"""Native short-viewport diagnostic; use the isolated X11/IBus launcher.

Uses the production surface and exact caret identity. Records the native overlay
scrollbar separately from editable page targets; does not center every click.
PASS means the recorded behavior was reproduced, NOT that the bottom-band loss
was fixed. This diagnostic expects the current WebKitGTK overlay hit region.
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
      return {x,y:yy,viewport:v.toJSON(),canvas:n.toJSON(),scrollTop:s.scrollTop,scrollLeft:s.scrollLeft,clientWidth:s.clientWidth,clientHeight:s.clientHeight,scrollWidth:s.scrollWidth,hit:document.elementFromPoint(x,yy)?.className}'''
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
        # Record the old point ~21px above the bottom separately from the
        # visible thumb. It still loses the click on this WebKitGTK runtime.
        d.js(locate, fixture['cells'][3], .905); time.sleep(.8)
        point = d.js(locate, fixture['cells'][3], None)
        before = a.status(fmt)['caret']; d.js('window.__pointerEvents=[]')
        rhwp.click(d, point['x'], point['y'])
        d.screenshot(args.out / (fmt + '-bottom-band.png'))
        events = d.js('return window.__pointerEvents')
        after = a.status(fmt)['caret']
        report.setdefault('bottomBand', []).append({'format': fmt, 'point': point, 'events': events, 'caretBefore': before, 'caretAfter': after})
        check(fmt + ' overlay scrollbar hit region reproduced', after == before and any(e['type'] == 'mousedown' and e['target'] == 'editor__scroll' for e in events))
        # Test the actual visible thumb separately. The DOM reports overlay
        # scrollbars as zero-width gutters; elementFromPoint omits their hit area.
        sx, sy = d.pointer_scale
        thumb_y = point['viewport']['bottom'] - 10
        before_scroll = d.js('return document.querySelector(".editor__scroll").scrollLeft')
        rhwp.drag(d, (point['x'] * sx, thumb_y * sy), ((point['x'] + 60) * sx, thumb_y * sy)); time.sleep(.5)
        after_scroll = d.js('return document.querySelector(".editor__scroll").scrollLeft')
        report.setdefault('scrollbars', []).append({'format': fmt, 'y': thumb_y, 'before': before_scroll, 'after': after_scroll})
        check(fmt + ' visible scrollbar drag scrolls without moving caret', after_scroll > before_scroll and a.status(fmt)['caret'] == before)
        check(fmt + ' pointer tests leave revision and dirty unchanged', a.status(fmt)['localRevision'] == '0' and a.status(fmt)['dirty'] == 'false')
        # Typing following a real page click must affect that exact cell, not
        # the previous cell. Inspect via ordinary caret/dirty UI (no text hooks).
        d.js('document.querySelector(".editor__scroll").scrollLeft=0')
        d.js(locate, fixture['cells'][3], .80); time.sleep(.8)
        point = d.js(locate, fixture['cells'][3], None); rhwp.click(d, point['x'], point['y'])
        a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:0@0/3/0"')
        a.engine('xkb:us::eng'); a.type('X')
        a.wait('return document.querySelector("[data-testid=rhwp-status]").dataset.caret==="0:1:1@0/3/0"')
        check(fmt + ' typing remains in intended cell', a.status(fmt)['dirty'] == 'true')
        result = a.save(fmt)
        check(fmt + ' intended-cell edit published durably', result['synced'] == 'true')
        assert rhwp.close_tab(d, path.name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'geometry'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True); parser.add_argument('--ibus', required=True)
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'bottomViewportIssue': 'REPRODUCED_UNFIXED', 'scope': 'actual production Tauri; trusted native pointer; no routing overrides'}
    smoke.APP = str(args.app); smoke.DRIVER_LOG = str(args.out / 'driver.log')
    try:
        with smoke.tauri_driver(str(args.driver), 4444, str(args.out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, 'return !!document.querySelector(".document-bar")', timeout=30)
                run(args, d, report); report['status'] = 'PASS'
            finally:
                smoke.end_session(d)
    except Exception as error:
        traceback.print_exc(); report.update(status='FAIL', error=str(error))
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
