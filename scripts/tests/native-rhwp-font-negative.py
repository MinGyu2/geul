#!/usr/bin/env python3
"""Two targeted native font-save refusals; run in the isolated IBus launcher."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import traceback

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_font_negative_helpers', ROOT / 'scripts/tests/native-rhwp-font-editing.py')
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--app', type=Path, required=True); p.add_argument('--driver', required=True)
    p.add_argument('--xdotool', required=True); p.add_argument('--ibus', required=True)
    p.add_argument('--fixtures', type=Path, required=True); p.add_argument('--out', type=Path, required=True)
    p.add_argument('--port', type=int, default=4444)
    args = p.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    result = {'status': 'RUNNING', 'cases': [], 'appSha256': h.sha(args.app)}
    h.smoke.APP = str(args.app); h.smoke.DRIVER_LOG = args.out / 'driver.log'
    try:
        with h.smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start(); a = h.base.Acceptance(args, d, result); f = h.helpers.Fonts(a, d, result)
            a.wait("return document.querySelector('.document-bar')!==null", timeout=60); f.focus_window()
            for fmt in ('hwp', 'hwpx'):
                path = args.out / ('negative.' + fmt); shutil.copyfile(args.fixtures / path.name, path)
                before = h.sha(path); a.open_native(fmt, path); f.tab('ribbon.tab.home'); f.select_all(path.name, docx=False)
                a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent==='NanumGothic'")
                f.choose('NanumMyeongjo', 'NanumMyeongjo')
                if fmt == 'hwp':
                    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent==='NanumMyeongjo'")
                else:
                    assert f.current_font() == 'NanumGothic' and f.session(path.name)['revision'] == 0
                f.focus_window(); f.focus_editor(); a.key('ctrl+s')
                a.wait("return document.querySelector('[data-testid=rhwp-save-result]')?.dataset.state==='failed'", timeout=60)
                save = d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
                assert h.sha(path) == before, 'rejected save replaced original'
                if fmt == 'hwp':
                    a.key('ctrl+z')
                    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent==='NanumGothic'")
                result['cases'].append({'format': fmt, 'inputSha256': before, 'save': save,
                                        'session': f.session(path.name), 'originalIntact': True, 'recoveredFamily': f.current_font()})
                if not h.rhwp.close_tab(d, path.name):
                    # close_tab cancels its diagnostic discard prompt. Request
                    # this task-owned close again before confirming discard.
                    d.js("[...document.querySelectorAll('.document-tab__close')].find(b=>b.getAttribute('aria-label').includes(arguments[0])).click()", path.name)
                    a.wait("return !!document.querySelector('[data-testid=discard-confirm]')")
                    d.js("document.querySelector('[data-testid=discard-confirm]').click()")
                    a.wait("return !document.querySelector('.document-tab__select')")
            d.quit()
        result['status'] = 'PASS'
    except Exception as error:
        result['status'] = 'FAIL'; result['error'] = str(error); result['traceback'] = traceback.format_exc()
    result['teardown'] = h.smoke.TEARDOWN
    (args.out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({'status': result['status'], 'error': result.get('error')}, ensure_ascii=False))
    return int(result['status'] != 'PASS')


if __name__ == '__main__':
    raise SystemExit(main())
