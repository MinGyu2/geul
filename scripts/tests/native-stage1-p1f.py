#!/usr/bin/env python3
"""Compact native acceptance for Stage 1 P1 + F in the production Tauri app; run inside native-ibus-session.py.
HWPX: caret superscript then >64 typed characters and Korean IME (ibus-hangul), numbered list + Undo/Redo,
combined char + list edits, font embedding through the dialog, real save, close/reopen; independent oracle.
DOCX: font embedding through the dialog, real save, independent package inspection (deobfuscated program).
HWP: the embedding command is unavailable (format limitation). Keyboard/clicks drive the real app; reads observe.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time
import traceback
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('font_native_helpers', ROOT / 'scripts/tests/native-font-acceptance.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
smoke, base, rhwp, sha = helpers.smoke, helpers.base, helpers.rhwp, helpers.sha
TYPED = ''.join(chr(97 + i % 26) for i in range(70))


def oracle(path):
    return json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/stage1-p1f-oracle.mjs'), str(path)], cwd=ROOT, text=True))


def click(d, command):
    ok = d.js('const b=document.querySelector(`[data-command="${arguments[0]}"]`);if(!b||b.disabled||b.getAttribute("aria-disabled")==="true")return false;b.click();return true', command)
    if not ok:
        raise smoke.Failure(f'ribbon command unavailable: {command}')


def pressed(d, command):
    return d.js('return document.querySelector(`[data-command="${arguments[0]}"]`)?.getAttribute("aria-pressed")', command)


def embed(a, d, family, style='Regular'):
    click(d, 'format.embedFont')
    a.wait("return document.querySelector('[data-testid=embed-font-dialog]')!==null")
    d.js("""const s=document.querySelector('[data-testid=embed-font-family]');
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,arguments[0]);
      s.dispatchEvent(new Event('change',{bubbles:true}));""", family)
    time.sleep(.3)
    d.js("""const s=document.querySelector('[data-testid=embed-font-style]');
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;set.call(s,arguments[0]);
      s.dispatchEvent(new Event('change',{bubbles:true}));""", style)
    a.wait("const b=document.querySelector('[data-testid=embed-font-confirm]');return b&&!b.disabled", timeout=30)
    info = d.js("return document.querySelector('[data-testid=embed-font-info]')?.textContent")
    d.js("document.querySelector('[data-testid=embed-font-confirm]').click()")
    a.wait("return document.querySelector('[data-testid=embed-font-dialog]')===null", timeout=60)
    return {'dialog': info, 'notice': d.js("return document.querySelector('footer.statusbar')?.textContent ?? ''")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('--app', '--out', '--fixtures', '--docx'):
        parser.add_argument(name, type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    docs = args.out / 'docs'
    docs.mkdir()
    for fmt in ('hwp', 'hwpx'):
        shutil.copyfile(args.fixtures / ('font.' + fmt), docs / ('stage1.' + fmt))
    shutil.copyfile(args.docx, docs / 'stage1.docx')
    report = {'status': 'RUNNING', 'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'fixtures': {p.name: sha(p) for p in docs.iterdir()},
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
            f = helpers.Fonts(a, d, report)
            f.focus_window()
            # ---- HWPX ----
            path = docs / 'stage1.hwpx'
            before = oracle(path)
            a.open_native('hwpx', path)
            f.tab('ribbon.tab.home')
            f.focus_window(); f.focus_editor(); a.engine('xkb:us::eng'); a.key('End')
            time.sleep(.5)
            click(d, 'format.superscript')            # caret-only: next-input formatting
            a.wait("return document.querySelector('[data-command=\"format.superscript\"]')?.getAttribute('aria-pressed')==='true'")
            f.focus_editor(); a.type(TYPED)
            time.sleep(1)
            a.engine('hangul'); f.focus_editor(); a.type('gksrmf'); a.engine('xkb:us::eng')
            time.sleep(1)
            report['hwpxAfterTyping'] = {'superscriptPressed': pressed(d, 'format.superscript')}
            # Numbered list on a new paragraph, Undo/Redo, then text in the item (combined char + list edits).
            f.focus_editor(); a.key('Return'); time.sleep(.5)
            click(d, 'paragraph.numbering')
            a.wait("return document.querySelector('[data-command=\"paragraph.numbering\"]')?.getAttribute('aria-pressed')==='true'")
            f.focus_window(); f.focus_editor(); a.key('ctrl+z')
            a.wait("return document.querySelector('[data-command=\"paragraph.numbering\"]')?.getAttribute('aria-pressed')!=='true'")
            a.key('ctrl+y')
            a.wait("return document.querySelector('[data-command=\"paragraph.numbering\"]')?.getAttribute('aria-pressed')==='true'")
            f.focus_editor(); a.type('item')
            time.sleep(.5)
            report['hwpxEmbed'] = embed(a, d, 'NanumGothic')
            f.focus_window(); f.focus_editor()
            report['hwpxSave'] = a.save('hwpx')
            after = oracle(path)
            report['hwpx'] = {'before': before, 'after': after, 'outputSha256': sha(path)}
            p0, p1 = after['body'][0], after['body'][1]
            start_at = len(before['body'][0]['text'])
            assert p0['text'].startswith(before['body'][0]['text'] + TYPED), p0['text']
            assert all(p0['superscript'][start_at:start_at + 70]), 'typed run lost superscript'
            assert '한글' in p0['text'][start_at + 70:], p0['text']
            assert all(p0['superscript'][start_at + 70:]), 'IME text lost superscript'
            assert not any(p0['superscript'][:start_at]), 'existing text changed'
            assert p1['headType'] == 'Number' and p1['text'].endswith('item'), p1
            assert any(e['face'] == 'NanumGothic' and e['bytes'] > 0 for e in after['embedded']), after['embedded']
            assert rhwp.close_tab(d, path.name)
            a.open_native('hwpx', path)
            report['hwpxReopened'] = oracle(path)
            assert rhwp.close_tab(d, path.name)
            # ---- HWP: embedding unavailable ----
            hwp = docs / 'stage1.hwp'
            a.open_native('hwp', hwp)
            f.tab('ribbon.tab.home')
            report['hwpEmbedButton'] = d.js('const b=document.querySelector(`[data-command="format.embedFont"]`);return b?{disabled:b.disabled,aria:b.getAttribute("aria-disabled"),title:b.title}:null')
            assert report['hwpEmbedButton'] and (report['hwpEmbedButton']['disabled'] or report['hwpEmbedButton']['aria'] == 'true'), report['hwpEmbedButton']
            assert sha(hwp) == report['fixtures']['stage1.hwp']
            assert rhwp.close_tab(d, hwp.name)
            # ---- DOCX ----
            docx = docs / 'stage1.docx'
            a.open_native('docx', docx)
            f.tab('ribbon.tab.home')
            time.sleep(1)
            report['docxEmbed'] = embed(a, d, 'Inter')
            f.focus_window()
            report['docxSave'] = a.save('docx')
            with zipfile.ZipFile(docx) as z:
                names = z.namelist()
                table = z.read('word/fontTable.xml').decode()
                fonts = [n for n in names if n.endswith('.odttf')]
                assert len(fonts) == 1 and '<w:font w:name="Inter"><w:embedRegular' in table, (names, table[:400])
                key = table.split('w:fontKey="', 1)[1].split('"', 1)[0]
                data = bytearray(z.read(fonts[0]))
                hexd = key.strip('{}').replace('-', '')
                xor = bytes(int(hexd[30 - 2 * i:32 - 2 * i], 16) for i in range(16))
                for i in range(32):
                    data[i] ^= xor[i % 16]
                inter = (ROOT / 'external/wordcraft/assets/fonts/Inter-Regular.ttf').read_bytes()
                report['docx'] = {'parts': names, 'fontKey': key, 'programMatchesInter': bytes(data) == inter,
                                  'contentTypes': 'obfuscatedFont' in z.read('[Content_Types].xml').decode()}
                assert report['docx']['programMatchesInter'] and report['docx']['contentTypes'], report['docx']
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
