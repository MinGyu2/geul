#!/usr/bin/env python3
"""HWP rectangle-caption IBus and locked-owner native acceptance in a private X11 session."""
import argparse
import importlib.util
import json
import shutil
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/tests'))
spec = importlib.util.spec_from_file_location('caption_acceptance', ROOT / 'scripts/tests/native-stage3-caption-acceptance.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
p = a.p6


def execute(acc, case, out, fixtures):
    source = fixtures / ('fixture.hwp' if case == 'ime' else 'locked.hwp')
    target = out / (case + '.hwp')
    shutil.copyfile(source, target)
    before = a.oracle(source)
    acc.open_native('hwp', target)
    acc.engine('xkb:us::eng')
    p.gso.choose(acc, before['shape'], 'shape')
    before_click = acc.status('hwp')
    at = before['caret']
    p.pointer(acc, (at['pageIndex'], at['x'] + 1, at['y'] + at['height'] / 2))
    if case == 'locked':
        acc.settle('hwp')
        after_click = acc.status('hwp')
        assert '@caption/' not in after_click['caret'], after_click
        assert after_click['caret'] == before_click['caret'], (before_click, after_click)
        assert after_click['revision'] == before_click['revision'] == '0', (before_click, after_click)
        assert a.sha(source) == a.sha(target)
        return {'status': 'PASS', 'format': 'hwp', 'sourceSha256': a.sha(source),
                'beforeCaret': before_click['caret'], 'afterCaret': after_click['caret'],
                'beforeRevision': before_click['revision'], 'afterRevision': after_click['revision'],
                'note': 'locked rectangle caption click refused entry'}
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    d = acc.d
    d.js("window.__captionIme=[];for(const t of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(t,e=>window.__captionIme.push({type:t,data:e.data,isTrusted:e.isTrusted}),true)")
    acc.engine('hangul')
    acc.type('gksrmf')
    acc.key('End')
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('한글')")
    acc.settle('hwp')
    status = acc.status('hwp')
    events = d.js('return window.__captionIme')
    assert any(e['type'] == 'compositionstart' and e['isTrusted'] for e in events), events
    assert any(e['type'] == 'compositionend' and e['isTrusted'] and e['data'] for e in events), events
    save = acc.save('hwp')
    after = a.oracle(target)
    assert after['texts'] == [before['texts'][0] + '한글'], after
    assert after['atnos'] == before['atnos'] and after['props'] == before['props'] and after['body'] == before['body']
    assert p.p4.rhwp_poc.close_tab(d, target.name)
    acc.open_native('hwp', target)
    at = after['caret']
    p.pointer(acc, (at['pageIndex'], at['x'] + 1, at['y'] + at['height'] / 2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/') && document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('한글')")
    return {'status': 'PASS', 'format': 'hwp', 'sourceSha256': a.sha(source), 'savedSha256': a.sha(target),
            'events': events, 'revisionAfterInput': status['revision'], 'save': save, 'texts': after['texts'],
            'atnoUnchanged': after['atnos'] == before['atnos'], 'shapeUnchanged': after['props'] == before['props'],
            'bodyUnchanged': after['body'] == before['body'], 'reopenedInApp': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--driver', default='/tmp/geul-tauri-driver-target/debug/tauri-driver')
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.fixtures = args.fixtures.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    app = ROOT / 'src-tauri/target/release/geul'
    p.p4.smoke.APP = str(app)
    p.p4.smoke.DRIVER_LOG = str(args.out / 'driver.log')
    report = {'appSha256': a.sha(app), 'cases': {}}
    for case in ['ime', 'locked']:
        try:
            with p.p4.smoke.tauri_driver(args.driver, 4469, str(args.out / ('data-' + case))) as start:
                d = start()
                try:
                    acc = p.p4.P4Acceptance(args, d, report)
                    acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                    acc.focus_window()
                    acc.calibrate_pointer()
                    report['cases'][case] = execute(acc, case, args.out, args.fixtures)
                finally:
                    d.quit()
        except Exception:
            report['cases'][case] = {'status': 'FAIL', 'error': traceback.format_exc()}
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all(value['status'] == 'PASS' for value in report['cases'].values()) else 1


if __name__ == '__main__':
    sys.exit(main())
