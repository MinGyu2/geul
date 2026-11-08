#!/usr/bin/env python3
"""HWP PrvText/PrvImage regeneration through the normal embedded product (2026-11-08).

Genuine Hancom calc-cell.hwp (GIF PrvImage, non-empty PrvText): edit through product
commands, Ctrl+S through the actual Tauri save service, close, reopen from disk,
follow-up edit, second save, final reopen. For every reopen the displayed page-1
canvas is captured as a separately rendered reference (from the published bytes) for
the independent verifier (scripts/tests/verify-hwp-preview.py). No test hooks.
Run inside the isolated X11/IBus launcher; the source fixture stays immutable.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp

spec = importlib.util.spec_from_file_location('production_native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

STATUS = '[data-testid=rhwp-status]'
LOCATE = ('const g=arguments[0],c=document.querySelectorAll("canvas.rhwp-page__canvas")[g.pageIndex],'
          's=document.querySelector(".editor__scroll"),r=c.getBoundingClientRect(),v=s.getBoundingClientRect();'
          's.scrollTop+=r.top+g.y*r.height/g.page.height-(v.top+v.height/2);const n=c.getBoundingClientRect();'
          'return {x:n.left+(g.x+1)*n.width/g.page.width,y:n.top+(g.y+g.height/2)*n.height/g.page.height}')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    fixture = json.loads(args.fixture.read_text())
    source = Path(fixture['source'])
    original = sha(source)
    assert original == fixture['sha256'], 'fixture changed since geometry capture'
    path = args.out / source.name
    shutil.copyfile(source, path)

    def check(name, value, detail=None):
        report.setdefault('checks', []).append({'name': name, 'status': 'PASS' if value else 'FAIL', **({'detail': detail} if detail is not None else {})})
        assert value, (name, detail)

    def idle():
        a.wait('const s=document.querySelector(arguments[0]);return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision', STATUS)

    def into_cell(cell):
        point = d.js(LOCATE, fixture['geometry'])
        rhwp.click(d, point['x'], point['y'])
        a.wait('return /@\\d+\\/8\\/\\d+$/.test(document.querySelector(arguments[0])?.dataset.caret)', STATUS)
        if cell != 8:
            # cell 8 is row 2 col 0 of the 4-column table; Up moves to the same column above.
            for _ in range((8 - cell) // 4):
                a.key('Up')
            a.wait('return new RegExp("@\\\\d+/"+arguments[1]+"/\\\\d+$").test(document.querySelector(arguments[0])?.dataset.caret)', STATUS, cell)

    def formula(expression):
        into_cell(8)
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()==="한글 도구")b.click()')
        selector = '[data-command="hangul.insertTableFormula"]'
        a.wait('return !!document.querySelector(arguments[0])', selector)
        d.js('const b=document.querySelector(arguments[0]);if(b.getAttribute("aria-disabled")==="true")throw Error(b.title);b.click()', selector)
        a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
        prefill = d.js('return document.querySelector("[data-testid=command-input-dialog] input").value')
        before = int(a.status('hwp')['localRevision'])
        a.key('ctrl+a'); a.type(expression); a.key('Return')
        a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        idle()
        after = int(a.status('hwp')['localRevision'])
        check('formula ' + expression + ' applied (revision advanced)', after == before + 1, {'before': before, 'after': after,
              'notice': d.js("return document.querySelector('footer.statusbar')?.textContent")})
        return prefill

    def save(name):
        before = a.status('hwp')
        result = a.save('hwp')
        after = a.status('hwp')
        check(name + ' durable clean indicator', result.get('synced') == 'true' and result.get('changedSince') == 'false', result)
        check(name + ' not dirty after save', after['dirty'] == 'false', after)
        shutil.copyfile(path, args.out / (name + '.hwp'))
        return {'result': result, 'revisionBefore': before['localRevision'], 'revisionAfter': after['revision'], 'sha256': sha(path)}

    def reopen(name):
        assert rhwp.close_tab(d, path.name)
        a.open('hwp', path)
        status = a.status('hwp')
        check(name + ' reopened ready and clean', status['status'] == 'ready' and status['dirty'] == 'false', status)
        # Separately rendered reference: the editor's own page-1 canvas of the reopened file.
        d.js('document.querySelector(".editor__scroll").scrollTop=0')
        a.wait('return document.querySelectorAll("canvas.rhwp-page__canvas")[0]?.width>0')
        data = d.js('const c=document.querySelectorAll("canvas.rhwp-page__canvas")[0];return {url:c.toDataURL("image/png"),w:c.width,h:c.height}')
        png = base64.b64decode(data['url'].split(',', 1)[1])
        (args.out / (name + '-display.png')).write_bytes(png)
        d.screenshot(args.out / (name + '.png'))
        return {'status': status, 'displayCanvas': [data['w'], data['h']]}

    a.open('hwp', path)
    a.engine('xkb:us::eng')
    report['initialPreview'] = 'Hancom GIF (verified independently)'
    # Phase 1: first-page table text modification + formula replacement/recalculation.
    into_cell(0)
    a.key('End'); a.type('5'); idle()
    check('cell 0 text edited', a.status('hwp')['dirty'] == 'true' and a.status('hwp')['localRevision'] == '1')
    report['firstPrefill'] = formula('=SUM(ABOVE)')
    report['firstSave'] = save('first-save')
    report['firstReopen'] = reopen('first-reopen')
    # Phase 2: follow-up formula edit on the reopened published file.
    report['secondPrefill'] = formula('=MAX(ABOVE)')
    report['secondSave'] = save('second-save')
    report['finalReopen'] = reopen('final-reopen')
    assert rhwp.close_tab(d, path.name)
    check('source fixture immutable', sha(source) == original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'fixture'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'appSha256': sha(args.app),
              'scope': 'normal embedded production assets; native XTest/IBus; actual Tauri save service; no engine observer'}
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
