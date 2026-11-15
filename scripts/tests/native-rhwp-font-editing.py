#!/usr/bin/env python3
"""Small production Tauri RHWP font flow; run inside native-ibus-session.py.
Two controlled one-paragraph originals, existing document font + registered TTF,
Undo/Redo, real save/close/reopen, Canvas bytes/geometry and raster PDFs.
DOM/Canvas reads observe results; keyboard/picker commands use the real app.
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


def oracle(path, family):
    value = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/rhwp-font-editing.mjs'), str(path)], cwd=ROOT, text=True))
    assert value['body'][0]['text'] == '한글 Font editing ABC 0123', value['body']
    assert all(slot == family for refs in value['body'][0]['families'] for slot in refs), value['body']
    return value


def capture(a, d, out, label):
    value = d.js("""const c=document.querySelector('.editor__scroll canvas');
      const rect=e=>e?Object.fromEntries(['left','top','width','height'].map(k=>[k,parseFloat(getComputedStyle(e)[k])])):null;
      return {png:c.toDataURL('image/png'),width:c.width,height:c.height,
        selection:[...document.querySelectorAll('.rhwp-selection')].map(rect),caret:rect(document.querySelector('.rhwp-caret'))};""")
    data = base64.b64decode(value.pop('png').split(',', 1)[1])
    (out / (label + '.png')).write_bytes(data)
    value['sha256'] = hashlib.sha256(data).hexdigest()
    assert value['width'] > 0 and value['height'] > 0
    if value['selection']:
        assert len(value['selection']) == 1, value
        r, caret = value['selection'][0], value['caret']
        assert caret and abs(caret['left'] - r['left'] - r['width']) < 2, value
        assert r['width'] > 0 and r['height'] > 0 and abs(caret['top'] - r['top']) < 3, value
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    docs, pdfs, font_files = [args.out / p for p in ('docs', 'pdf', 'font-files')]
    for p in (docs, pdfs, font_files):
        p.mkdir()
    for fmt in ('hwp', 'hwpx'):
        shutil.copyfile(args.fixtures / ('font.' + fmt), docs / ('font.' + fmt))
    report = {'status': 'RUNNING', 'registration': [], 'rhwp': [], 'fixtures': {p.name: sha(p) for p in docs.iterdir()},
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'wasm': json.loads((ROOT / 'public/rhwp/RELEASE.json').read_text()),
              'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / 'driver.log'
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start()
            a = base.Acceptance(args, d, report)
            a.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            d.js("window.__fontKeys=[];window.addEventListener('keydown',e=>{if(e.ctrlKey)window.__fontKeys.push({code:e.code,trusted:e.isTrusted,target:e.target.className})},true)")
            f = helpers.Fonts(a, d, report)
            f.focus_window()
            font = font_files / 'GeulMonoTest1.ttf'
            helpers.renamed_mono(font)
            f.register(font, lambda u: helpers.USER_TTF_FAMILY in u['families'])
            report['catalog'] = f.catalog()
            for fmt in ('hwp', 'hwpx'):
                path = docs / ('font.' + fmt)
                a.open_native(fmt, path)
                before = oracle(path, 'NanumGothic')
                row = {'format': fmt, 'before': before, 'stages': []}
                report['rhwp'].append(row)
                row['baselinePdf'] = f.export_pdf(path.name, pdfs / (fmt + '-before.pdf'))
                f.select_all(path.name, docx=False)
                baseline = capture(a, d, args.out, fmt + '-before')
                for phase, family in [('existing', 'NanumMyeongjo'), ('user', helpers.USER_TTF_FAMILY)]:
                    # PDF export selects the File ribbon tab; mount the Home picker
                    # before observing its state, rather than treating an absent input as mixed.
                    f.tab('ribbon.tab.home')
                    f.select_all(path.name, docx=False)
                    expected_previous = 'NanumGothic' if phase == 'existing' else 'NanumMyeongjo'
                    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", expected_previous)
                    previous = f.current_font()
                    assert previous == expected_previous
                    previous_pixels = capture(a, d, args.out, fmt + '-' + phase + '-prior')
                    f.choose(family, family)
                    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", family, timeout=30)
                    time.sleep(.5)
                    changed = capture(a, d, args.out, fmt + '-' + phase)
                    assert changed['sha256'] != previous_pixels['sha256'], (fmt, phase, 'no Canvas change')
                    stage = {'phase': phase, 'family': family, 'previous': previous, 'canvas': changed,
                             'sessionBeforeUndo': f.session(path.name)}
                    row['stages'].append(stage)
                    f.focus_window(); f.focus_editor(); a.key('ctrl+z')
                    try:
                        a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", previous, timeout=12)
                    except Exception:
                        report['failureDom'] = d.js("""return {font:document.querySelector('.font-picker__input')?.dataset,
                          focus:document.activeElement?.outerHTML,status:document.querySelector('[data-testid=rhwp-status]')?.dataset,
                          undo:document.querySelector('[data-command="edit.undo"]')?.outerHTML,
                          redo:document.querySelector('[data-command="edit.redo"]')?.outerHTML,
                          keys:window.__fontKeys,notice:[...document.querySelectorAll('[role=status]')].map(e=>e.textContent)}""")
                        report['failureSessions'] = a.sessions()
                        d.screenshot(args.out / 'failure.png')
                        d.quit(); d = None
                        raise
                    time.sleep(.3)
                    undone = capture(a, d, args.out, fmt + '-' + phase + '-undo')
                    assert undone['sha256'] == previous_pixels['sha256'], (fmt, phase, 'Undo pixels differ')
                    a.key('ctrl+y')
                    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", family)
                    time.sleep(.3)
                    redone = capture(a, d, args.out, fmt + '-' + phase + '-redo')
                    assert redone['sha256'] == changed['sha256'], (fmt, phase, 'Redo pixels differ')
                    f.focus_editor()
                    saved = a.save(fmt)
                    reopened = oracle(path, family)
                    stage.update({'undo': undone, 'redo': redone,
                                  'save': saved, 'reopened': reopened, 'outputSha256': sha(path)})
                    assert rhwp.close_tab(d, path.name)
                    a.open_native(fmt, path)
                    f.select_all(path.name, docx=False)
                    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", family)
                    capture(a, d, args.out, fmt + '-' + phase + '-reopened')
                row['modifiedPdf'] = f.export_pdf(path.name, pdfs / (fmt + '-user.pdf'))
                row['baselineCanvas'] = baseline
                assert rhwp.close_tab(d, path.name)
                row['status'] = 'PASS'
            d.screenshot(args.out / 'final.png')
            d.quit(); d = None
        report['teardown'] = smoke.TEARDOWN
        report['status'] = 'PASS'
    except Exception as error:
        report['status'] = 'FAIL'; report['error'] = str(error); report['traceback'] = traceback.format_exc()
        if d:
            try:
                report['notice'] = d.js("return document.querySelector('footer.statusbar')?.textContent")
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
