#!/usr/bin/env python3
"""Stage 5-A natural font metrics: one focused production Tauri run (HWP + HWPX); run inside native-ibus-session.py.

Per format, on controlled fixtures (rhwp-natural-metrics.mjs --generate):
  body line (mixed Korean/Latin, NanumGothic) -> caret walk vs independently read advances of the exact bound bytes
  wrap paragraph (100 x W) -> font change to the registered monospace user font -> line break moves as predicted
  table cell 0 -> font change -> monospace caret advances, no overlap into cell 1, cell 1 unchanged
  Undo/Redo geometry, save/close/reopen geometry, raster PDF before/after.
Observation is ordinary DOM (product status data-caret/data-selection, .rhwp-caret, canvas pixels) and the backend
font_face_data command for the bytes. Commands use the real keyboard and font picker. No product test hooks.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('font_native_helpers', ROOT / 'scripts/tests/native-font-acceptance.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
smoke, base, rhwp = helpers.smoke, helpers.base, helpers.rhwp
sha = helpers.sha
ospec = importlib.util.spec_from_file_location('natural_oracle', ROOT / 'scripts/tests/natural_oracle.py')
oracle = importlib.util.module_from_spec(ospec)
ospec.loader.exec_module(oracle)

BODY = '한글 Font editing ABC 0123 Wide iiii'
WRAP = 'W' * 100
CELL = ['셀 Cell WWWW iiii', 'Other 다른 칸']
GOTHIC, MONO = 'NanumGothic', helpers.USER_TTF_FAMILY

CARET = """const c=document.querySelectorAll('canvas.rhwp-page__canvas')[0],k=document.querySelector('.rhwp-caret'),
  s=document.querySelector('[data-testid=rhwp-status]');if(!c||!k||!s)return null;const r=c.getBoundingClientRect(),q=k.getBoundingClientRect();
  return {key:s.dataset.caret,selection:s.dataset.selection,x:(q.left-r.left)*arguments[0]/r.width,y:(q.top-r.top)*arguments[1]/r.height,
  h:q.height*arguments[1]/r.height}"""
ALIASES = "return [...document.fonts].filter(f=>f.family.replace(/\"/g,'').startsWith('__geul_nf_')&&f.status==='loaded').length"


def oracle_text(path):
    return json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/rhwp-natural-metrics.mjs'), str(path)], cwd=ROOT, text=True))


class Walker:
    def __init__(self, a, d, page):
        self.a, self.d, self.page = a, d, page

    def caret(self):
        return self.d.js(CARET, self.page['width'], self.page['height'])

    def wait_key(self, key, timeout=6):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            c = self.caret()
            if c and c['key'] == key:
                time.sleep(.05)
                return self.caret()
            time.sleep(.03)
        raise smoke.Failure(f'caret did not reach {key}: {self.caret()}')

    def walk(self, prefix, suffix, count):
        """Positions for offsets 0..count of one paragraph, via native Right presses from offset 0."""
        out = [self.wait_key(f'{prefix}0{suffix}')]
        for k in range(1, count + 1):
            self.a.key('Right')
            out.append(self.wait_key(f'{prefix}{k}{suffix}'))
        return out


def residual(xs, text, advance):
    """Least-squares size from glyph advances (spaces excluded: HWP space rule), max residual in page px."""
    pairs = [(xs[i + 1]['x'] - xs[i]['x'], advance(ch)) for i, ch in enumerate(text[:len(xs) - 1])
             if ch != ' ' and xs[i + 1]['y'] == xs[i]['y']]
    pairs = [(d, a) for d, a in pairs if a is not None]
    size = sum(d * a for d, a in pairs) / sum(a * a for _, a in pairs)
    worst = max(abs(d - size * a) for d, a in pairs)
    return {'sizePx': size, 'maxResidualPx': worst, 'glyphs': len(pairs)}


def break_index(xs):
    """Glyphs on the first visual line. The caret at the break offset is drawn at the end of line 1 (end-of-line
    affinity), so the first offset shown on line 2 is one past the break."""
    for k in range(1, len(xs)):
        if xs[k]['y'] > xs[0]['y'] + 1:
            return k - 1
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('--app', '--driver', '--xdotool', '--ibus'):
        parser.add_argument(name, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.app = Path(args.app)
    args.out.mkdir(parents=True, exist_ok=False)
    docs, pdfs, fonts, faces = [args.out / p for p in ('docs', 'pdf', 'font-files', 'faces')]
    for p in (docs, pdfs, fonts, faces):
        p.mkdir()
    geometry = json.loads((args.fixtures / 'geometry.json').read_text())
    report = {'status': 'RUNNING', 'registration': [], 'rhwp': [], 'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'wasm': json.loads((ROOT / 'public/rhwp/RELEASE.json').read_text()), 'fixtureGeneration': geometry['build']['generation'],
              'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}
    assert report['wasm']['generation'] == report['fixtureGeneration'], 'fixtures from another generation'
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / 'driver.log'
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start()
            a = base.Acceptance(args, d, report)
            a.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            f = helpers.Fonts(a, d, report)
            f.focus_window()
            font = fonts / 'GeulMonoTest1.ttf'
            helpers.renamed_mono(font)
            f.register(font, lambda u: MONO in u['families'])

            def face_bytes(family, style='Regular'):
                value = a.async_js("""const b=await window.__TAURI_INTERNALS__.invoke('font_face_data',{family:arguments[0],style:arguments[1]});
                  const u=new Uint8Array(b);let s='';for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode(...u.subarray(i,i+32768));return btoa(s)""", family, style)
                assert value.get('ok'), value
                raw = base64.b64decode(value['value'])
                path = faces / f'{family}-{style}.bin'
                path.write_bytes(raw[4:])
                return int.from_bytes(raw[:4], 'little'), raw[4:]

            sources = {}
            for family in (GOTHIC, MONO):
                index, data = face_bytes(family)
                sources[family] = {'index': index, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                                   'advance': oracle.advances(data, index)}
            report['sources'] = {k: {x: y for x, y in v.items() if x != 'advance'} for k, v in sources.items()}
            gothic, mono = sources[GOTHIC]['advance'], sources[MONO]['advance']

            def click_page(row, gx, gy):
                """Center a page point in the scroller, wait for a settled page rectangle and click it
                (as native-advanced-production.py does)."""
                locate = """const W=arguments[2],H=arguments[3],c=document.querySelectorAll('canvas.rhwp-page__canvas')[0],
                  s=document.querySelector('.editor__scroll'),r=c.getBoundingClientRect(),v=s.getBoundingClientRect(),y=r.top+arguments[1]*r.height/H;
                  if(arguments[4])s.scrollTop+=y-(v.top+v.height/2);const n=c.getBoundingClientRect();
                  return {x:n.left+arguments[0]*n.width/W,y:n.top+arguments[1]*n.height/H}"""
                W, H = row['page']['width'], row['page']['height']
                d.js(locate, gx, gy, W, H, True)
                last, since, deadline = None, time.monotonic(), time.monotonic() + 10
                while True:
                    point = d.js(locate, gx, gy, W, H, False)
                    now = time.monotonic()
                    if point != last:
                        last, since = point, now
                    elif now - since >= .7:
                        break
                    assert now < deadline, 'page rectangle did not settle'
                    time.sleep(.05)
                rhwp.click(d, point['x'], point['y'])

            layout = {'shift': 0.0}  # vertical move of the table after the wrap paragraph changed its line count

            def click_cell(row, cell):
                g = row['cells'][cell]
                click_page(row, g['x'] + 6, g['y'] + layout['shift'] + g['h'] / 2)
                t = row['table']
                a.wait("return new RegExp('@'+arguments[0]+'/'+arguments[1]+'/0$').test(document.querySelector('[data-testid=rhwp-status]')?.dataset.caret)", t['control'], cell)
                f.focus_editor()
                a.key('Home')

            for row in geometry['fixtures']:
                fmt = row['format']
                path = docs / ('natural.' + fmt)
                shutil.copyfile(row['source'], path)
                assert sha(path) == row['sha256']
                out = {'format': fmt, 'fixtureSha256': row['sha256']}
                layout['shift'] = 0.0
                report['rhwp'].append(out)
                a.open_native(fmt, path)
                a.wait(ALIASES + '>0', timeout=60)
                time.sleep(1.5)
                w = Walker(a, d, row['page'])
                d.js("window.__pointer=null;window.addEventListener('mousemove',e=>window.__pointer=[e.clientX,e.clientY],true)")
                rhwp.perform(d, [{'type': 'pointer', 'id': 'calibrate', 'parameters': {'pointerType': 'mouse'}, 'actions': [{'type': 'pointerMove', 'x': 100, 'y': 100, 'origin': 'viewport'}]}])
                a.wait('return window.__pointer!==null')
                m = d.js('return window.__pointer'); d.pointer_scale = (100 / m[0], 100 / m[1])

                anchors = {}

                def walk_body(p, text):
                    f.focus_window(); f.focus_editor(); a.engine('xkb:us::eng')
                    if p in anchors:
                        # Click the paragraph's first line (known geometry), then Home: works from any caret context.
                        x, y, h = anchors[p]
                        click_page(row, x + 3, y + h / 2)
                        a.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.startsWith(arguments[0])", f'0:{p}:')
                        f.focus_editor()
                    else:
                        a.key('Up', 'Up', 'Up', 'Home')
                        w.wait_key('0:0:0')
                        for _ in range(p):
                            a.key('Down')
                    a.key('Home')
                    result = w.walk(f'0:{p}:', '', len(text))
                    anchors.setdefault(p, (result[0]['x'], result[0]['y'], result[0]['h']))
                    return result

                def walk_cell(cell):
                    f.focus_window(); click_cell(row, cell)
                    t = row['table']
                    return w.walk(f'0:{t["paragraph"]}:', f'@{t["control"]}/{cell}/0', len(CELL[cell]))

                # 1. Natural advances of the bound face on the mixed body line.
                body = walk_body(0, BODY)
                out['body'] = residual(body, BODY, gothic)
                assert out['body']['maxResidualPx'] < 0.6, out['body']
                # 2. Wrap paragraph before the change.
                wrap_before = walk_body(1, WRAP)
                cell_before = [walk_cell(0), walk_cell(1)]
                # Justified paragraph: first-line spacing is stretched by alignment, so only the break is compared.
                out['wrapBefore'] = {'break': break_index(wrap_before), 'lines': len({p['y'] for p in wrap_before})}
                rows_y = sorted({p['y'] for p in wrap_before})
                pitch, base_lines = rows_y[1] - rows_y[0], len(rows_y)
                lines_of = lambda walk: len({p['y'] for p in walk})
                layout['shift'] = 0.0
                out['baselinePdf'] = f.export_pdf(path.name, pdfs / (fmt + '-before.pdf'))
                canvas_before = d.js("return document.querySelectorAll('canvas.rhwp-page__canvas')[0].toDataURL('image/png')")
                (args.out / (fmt + '-before.png')).write_bytes(base64.b64decode(canvas_before.split(',', 1)[1]))

                # 3. Font change on the whole wrap paragraph (native selection + picker).
                f.tab('ribbon.tab.home')
                walk_body(1, '')
                a.command(args.xdotool, 'key', '--clearmodifiers', '--delay', '15', '--repeat', str(len(WRAP)), 'shift+Right')
                a.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.selection===arguments[0]", f'0:1:0|0:1:{len(WRAP)}')
                end_before = w.caret()
                f.choose(MONO, MONO)
                a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", MONO, timeout=30)
                # Ready when the selection-end caret (offset 100) has moved by the re-wrap and stayed put for 1s.
                last, since, deadline = None, time.monotonic(), time.monotonic() + 60
                while True:
                    c = w.caret()
                    point = (round(c['x'], 2), round(c['y'], 2))
                    now = time.monotonic()
                    if point != last:
                        last, since = point, now
                    elif now - since >= 1.0 and point != (round(end_before['x'], 2), round(end_before['y'], 2)):
                        break
                    assert now < deadline, ('re-wrap not observed', end_before, c)
                    time.sleep(.1)
                wrap_after = walk_body(1, WRAP)
                k0, k1 = out['wrapBefore']['break'], break_index(wrap_after)
                out['wrapAfter'] = {'break': k1, 'lines': len({p['y'] for p in wrap_after})}
                layout['shift'] = (lines_of(wrap_after) - base_lines) * pitch
                # The edited paragraph is re-wrapped with the monospace face: the same column holds floor(column/advance)
                # glyphs. Size comes from the unjustified body line; predict the new break from the column interval
                # the stored (pre-edit) break allows, using the independently read GeulMono advance.
                size = out['body']['sizePx']
                column = [k1 * mono('W') * size, (k1 + 1) * mono('W') * size]
                out['column'] = column
                assert k1 is not None and k1 != k0, out
                text_width = row['page']['columns'][0]['width']  # body column (fixture page geometry, no paragraph indent)
                assert column[0] <= text_width + 0.5 < column[1] + 1.0, (column, text_width)
                assert [(p['x'], p['y']) for p in walk_body(0, BODY)] == [(p['x'], p['y']) for p in body], 'unrelated body line moved'

                # 4. Undo / Redo geometry.
                f.focus_editor(); a.key('ctrl+z'); time.sleep(1.2)
                assert [(p['x'], p['y']) for p in walk_body(1, WRAP)] == [(p['x'], p['y']) for p in wrap_before], 'Undo geometry differs'
                f.focus_editor(); a.key('ctrl+y'); time.sleep(1.2)
                assert [(p['x'], p['y']) for p in walk_body(1, WRAP)] == [(p['x'], p['y']) for p in wrap_after], 'Redo geometry differs'

                # 5. Table cell 0 font change.
                f.focus_window(); click_cell(row, 0); a.key('Home', 'shift+End')
                time.sleep(.5)
                f.choose(MONO, MONO)
                a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", MONO, timeout=30)
                time.sleep(1.5)
                cell_after = [walk_cell(0), walk_cell(1)]
                fit = residual(cell_after[0], CELL[0], mono)
                out['cell'] = {'fit': fit, 'cell0EndX': cell_after[0][-1]['x'], 'cell1StartX': cell_after[1][0]['x'],
                               'cell1Unchanged': [p['x'] for p in cell_after[1]] == [p['x'] for p in cell_before[1]]}
                assert fit['maxResidualPx'] < 0.6, fit
                assert cell_after[0][-1]['x'] < cell_after[1][0]['x'] - 2, 'cell text overlaps the next cell'
                assert out['cell']['cell1Unchanged'], 'neighbour cell moved'
                assert [p['x'] for p in cell_after[0]] != [p['x'] for p in cell_before[0]]
                f.focus_editor(); a.key('ctrl+z'); time.sleep(1.2)
                assert [p['x'] for p in walk_cell(0)] == [p['x'] for p in cell_before[0]], 'cell Undo geometry differs'
                f.focus_editor(); a.key('ctrl+y'); time.sleep(1.2)
                assert [p['x'] for p in walk_cell(0)] == [p['x'] for p in cell_after[0]], 'cell Redo geometry differs'
                # Selection rectangle follows the measured text (one line of the cell).
                a.key('Home', 'shift+End'); time.sleep(.4)
                sel = d.js("""const c=document.querySelectorAll('canvas.rhwp-page__canvas')[0].getBoundingClientRect();
                  return [...document.querySelectorAll('.rhwp-selection')].map(e=>{const r=e.getBoundingClientRect();return {x:(r.left-c.left)*arguments[0]/c.width,w:r.width*arguments[0]/c.width}})""", row['page']['width'])
                out['cellSelection'] = sel
                # Same span as the measured caret positions (the caret bar is drawn 1px left of the glyph boundary).
                span = cell_after[0][-1]['x'] - cell_after[0][0]['x']
                assert len(sel) == 1 and abs(sel[0]['w'] - span) < 0.5 and abs(sel[0]['x'] - cell_after[0][0]['x']) <= 1.5, (sel, span)

                # 6. Save, close, reopen: stored families, structure and geometry.
                f.focus_editor()
                out['save'] = a.save(fmt)
                out['saved'] = oracle_text(path)
                out['savedSha256'] = sha(path)
                assert rhwp.close_tab(d, path.name)
                a.open_native(fmt, path)
                a.wait(ALIASES + '>0', timeout=60)
                time.sleep(2)
                assert [(p['x'], p['y']) for p in walk_body(1, WRAP)] == [(p['x'], p['y']) for p in wrap_after], 'reopened wrap geometry differs'
                assert [(p['x'], p['y']) for p in walk_cell(0)] == [(p['x'], p['y']) for p in cell_after[0]], 'reopened cell geometry differs'
                out['modifiedPdf'] = f.export_pdf(path.name, pdfs / (fmt + '-after.pdf'))
                canvas_after = d.js("return document.querySelectorAll('canvas.rhwp-page__canvas')[0].toDataURL('image/png')")
                (args.out / (fmt + '-after.png')).write_bytes(base64.b64decode(canvas_after.split(',', 1)[1]))
                out['pages'] = d.js("return document.querySelector('[data-testid=rhwp-status]').dataset.pages")
                assert rhwp.close_tab(d, path.name)
                out['status'] = 'PASS'
            d.screenshot(args.out / 'final.png')
            d.quit(); d = None
        report['teardown'] = smoke.TEARDOWN
        report['status'] = 'PASS'
    except Exception as error:
        report['status'] = 'FAIL'; report['error'] = str(error); report['traceback'] = traceback.format_exc()
        if d:
            try:
                report['notice'] = d.js("return document.querySelector('footer.statusbar')?.textContent")
                report['statusData'] = d.js("const e=document.querySelector('[data-testid=rhwp-status]');return e?{...e.dataset}:null")
                d.screenshot(args.out / 'failure.png')
            finally:
                d.quit()
        report['teardown'] = smoke.TEARDOWN
    finally:
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print(json.dumps({'status': report['status'], 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
