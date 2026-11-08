#!/usr/bin/env python3
"""Genuinely blank first page through the normal embedded product (2026-11-08).

Genuine Hancom re-align-left-hancom.hwp (GIF PrvImage of Korean text, one body
paragraph of 100 characters). Delete every body character through native keys, Ctrl+S
through the actual Tauri save service. `--expect refused`: the pre-fix product must
refuse (previewStale) and keep the file and dirty state. `--expect saved`: durable
save, disk reopen (page-1 canvas captured as reference), follow-up edit (two paragraph
splits, page 1 stays blank), second save, final reopen. Independent output checks: scripts/tests/verify-hwp-blank-preview.py.
No test hooks; the source fixture stays immutable.
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


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    source = args.source
    original = sha(source)
    path = args.out / source.name
    shutil.copyfile(source, path)

    def check(name, value, detail=None):
        report.setdefault('checks', []).append({'name': name, 'status': 'PASS' if value else 'FAIL', **({'detail': detail} if detail is not None else {})})
        assert value, (name, detail)

    def idle():
        a.wait('const s=document.querySelector(arguments[0]);return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision', STATUS)

    def focus_body():
        c = d.js('const c=document.querySelectorAll("canvas.rhwp-page__canvas")[0];document.querySelector(".editor__scroll").scrollTop=0;'
                 'const r=c.getBoundingClientRect();return {x:r.left+r.width*0.2,y:r.top+r.height*0.12}')
        rhwp.click(d, c['x'], c['y'])
        a.wait('return !!document.querySelector(arguments[0])?.dataset.caret', STATUS)

    def save_attempt():
        a.key('ctrl+s')
        a.wait("const e=document.querySelector('[data-testid=rhwp-save-result]');return e && ['saved','failed'].includes(e.dataset.state)", timeout=60)
        return d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")

    def reopen(name):
        assert rhwp.close_tab(d, path.name)
        a.open('hwp', path)
        status = a.status('hwp')
        check(name + ' reopened ready and clean', status['status'] == 'ready' and status['dirty'] == 'false', status)
        d.js('document.querySelector(".editor__scroll").scrollTop=0')
        a.wait('return document.querySelectorAll("canvas.rhwp-page__canvas")[0]?.width>0')
        data = d.js('const c=document.querySelectorAll("canvas.rhwp-page__canvas")[0];return {url:c.toDataURL("image/png"),w:c.width,h:c.height}')
        (args.out / (name + '-display.png')).write_bytes(base64.b64decode(data['url'].split(',', 1)[1]))
        d.screenshot(args.out / (name + '.png'))
        return status

    a.open('hwp', path)
    a.engine('xkb:us::eng')
    focus_body()
    # The product has no select-all for RHWP bodies: delete from the document start, one key per character.
    a.key('Home')
    for start in range(0, args.delete, 20):
        a.key(*['Delete'] * min(20, args.delete - start))
    idle()
    status = a.status('hwp')
    check('all body text deleted (dirty, one page; text verified from saved bytes/screenshot)', status['dirty'] == 'true' and status['pages'] == '1', status)
    d.screenshot(args.out / 'blank-before-save.png')
    result = save_attempt()
    after = a.status('hwp')
    report['firstSave'] = {'result': result, 'status': after}
    if args.expect == 'refused':
        check('blank page save refused (pre-fix)', result['state'] == 'failed' and 'previewStale:PrvImage' in result.get('findings', ''), result)
        check('dirty preserved after refusal', after['dirty'] == 'true', after)
        check('file unchanged after refusal', sha(path) == original)
        check('source fixture immutable', sha(source) == original)
        return
    check('blank page durable save', result['state'] == 'saved' and result.get('synced') == 'true', result)
    check('clean after save', after['dirty'] == 'false', after)
    shutil.copyfile(path, args.out / 'first-save.hwp')
    report['firstReopen'] = reopen('first-reopen')
    focus_body()
    # Follow-up edit that keeps page 1 blank: two paragraph splits. (Inserting text into this
    # HWP 5.0.3 file makes the pinned RHWP re-serialize DocInfo — ID_MAPPINGS 64→72 bytes — which
    # T009 refuses independently of previews; see the acceptance record.)
    before = int(a.status('hwp')['localRevision'])
    a.key('Return', 'Return'); idle()
    check('follow-up paragraph splits', int(a.status('hwp')['localRevision']) == before + 2 and a.status('hwp')['dirty'] == 'true', a.status('hwp'))
    result = save_attempt()
    check('second durable save', result['state'] == 'saved' and result.get('synced') == 'true', result)
    shutil.copyfile(path, args.out / 'second-save.hwp')
    report['finalReopen'] = reopen('final-reopen')
    assert rhwp.close_tab(d, path.name)
    check('source fixture immutable', sha(source) == original)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'source'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expect', required=True, choices=('refused', 'saved'))
    parser.add_argument('--delete', required=True, type=int, help='number of body characters to delete from the start')
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'expect': args.expect, 'appSha256': sha(args.app), 'sourceSha256': sha(args.source),
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
