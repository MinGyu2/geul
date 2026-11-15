#!/usr/bin/env python3
"""Stage 4 minimal native integration acceptance: normal embedded production frontend, actual Tauri save service, X11/IBus.

Scenario A (per format, compound fixture from stage4-native-geometry.mjs): trusted IBus Hangul input in a cell of a
rich table (inline formulas, inline picture, nested table), structure command refused while composing, character
formatting, replacement of one of two inline formulas, typing next to the inline picture, representative refusals
(selection containing the picture, typing inside a formula) with history coherence, a supported structure command,
Undo -> real Ctrl+S -> Redo -> real Ctrl+S, native close/reopen.
Scenario B (per format, stale fixture): source edit A1 10 -> 11 without recalculation; Ctrl+S must be refused with
the target bytes unchanged and the document dirty/editable; explicit replacement of B1 with the same expression
recalculates; Ctrl+S publishes; native reopen.
No product test hooks or engine observer. Published copies are verified afterwards by stage4-native-oracle.mjs.
Run inside native-ibus-session.py.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/tests' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base = load('production_native_base', 'native-new-document.py')
phase2 = load('t012_phase2_native', 'native-t012-phase2.py')
STRUCTURE = phase2.STRUCTURE
STALE_MESSAGES = [json.loads((ROOT / f'src/language/{lang}.json').read_text())['editor.save.reason.formulaCache'] for lang in ('ko', 'en')]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    geometry = json.loads(args.geometry.read_text())
    saved = report.setdefault('saved', [])

    def check(name, value, detail=None):
        row = {'name': name, 'status': 'PASS' if value else 'FAIL'}
        if detail is not None:
            row['detail'] = detail
        report.setdefault('checks', []).append(row)
        assert value, f'{name}: {detail!r}'

    def st(fmt):
        return a.status(fmt)

    def idle():
        a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision')

    def revision(fmt):
        return int(st(fmt)['localRevision'])

    def tab(name):
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()===arguments[0])b.click()', name)

    def disabled(name):
        tab('한글 도구')
        a.wait('return !!document.querySelector(arguments[0])', '[data-command="' + name + '"]')
        return d.js('return document.querySelector(arguments[0]).getAttribute("aria-disabled")==="true"', '[data-command="' + name + '"]')

    def ribbon(name):
        tab('한글 도구')
        selector = '[data-command="' + name + '"]'
        a.wait('return !!document.querySelector(arguments[0])', selector)
        d.js('const b=document.querySelector(arguments[0]);if(b.getAttribute("aria-disabled")==="true")throw Error(b.title);b.click()', selector)

    def formula_dialog(expected, text=None):
        ribbon('hangul.insertTableFormula')
        a.wait('return !!document.querySelector("[data-testid=command-input-dialog]")')
        prefill = d.js('return document.querySelector("[data-testid=command-input-dialog] input").value')
        check(f'formula dialog prefilled with the owned field expression {expected}', prefill == expected, prefill)
        if text is not None:
            a.key('ctrl+a'); a.command(args.xdotool, 'type', '--clearmodifiers', '--delay', '90', '--', text)
        a.key('Return')
        a.wait('return !document.querySelector("[data-testid=command-input-dialog]")')
        idle()

    def caret(cell):
        """Wait until the caret is in body table cell `cell` (top-level, first paragraph); return its scalar offset."""
        a.wait('return new RegExp("@\\\\d+/"+arguments[0]+"/0$").test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret||"")', cell)
        return int(re.match(r'^\d+:\d+:(\d+)@', a.status(st_fmt[0])['caret']).group(1))

    st_fmt = [None]

    def click(target):
        d.js(phase2.LOCATE, target['rect'], True)
        last, since, deadline = None, time.monotonic(), time.monotonic() + 10
        while True:
            point = d.js(phase2.LOCATE, target['rect'], False)
            now = time.monotonic()
            if point != last:
                last, since = point, now
            elif now - since >= .7:
                break
            assert now < deadline, 'page rectangle did not settle'
            time.sleep(.05)
        rhwp.click(d, point['x'], point['y'])
        return caret(target['cell'])

    def calibrate():
        d.js('window.__s4Pointer=null;window.addEventListener("mousemove",e=>window.__s4Pointer=[e.clientX,e.clientY],true)')
        rhwp.perform(d, [{"type": "pointer", "id": "calibrate", "parameters": {"pointerType": "mouse"},
                          "actions": [{"type": "pointerMove", "x": 100, "y": 100, "origin": "viewport"}]}])
        a.wait('return window.__s4Pointer!==null')
        measured = d.js('return window.__s4Pointer')
        d.pointer_scale = (100 / measured[0], 100 / measured[1])

    def save_result():
        return d.js('const e=document.querySelector("[data-testid=rhwp-save-result]");return e?{...e.dataset}:null')

    def save(fmt, path, name):
        result = a.save(fmt)
        check(f'{fmt} {name} durable clean indicator', result['synced'] == 'true' and result['changedSince'] == 'false', result)
        copy = args.out / f'{name}.{fmt}'
        shutil.copyfile(path, copy)
        saved.append({'format': fmt, 'name': name, 'path': str(copy), 'sha256': sha(copy), 'result': result, 'revision': revision(fmt)})

    def reopen(fmt, path, label):
        assert rhwp.close_tab(d, path.name)
        a.open_native(fmt, path)
        s = st(fmt)
        check(f'{fmt} {label} native reopen ready and clean', s['status'] == 'ready' and s['dirty'] == 'false', s)
        assert rhwp.close_tab(d, path.name)

    def unchanged(fmt, label, before_rev, before_dirty):
        s = st(fmt)
        check(f'{fmt} {label}: no revision/dirty change, session ready', int(s['localRevision']) == before_rev and s['dirty'] == before_dirty and s['status'] == 'ready', s)

    def scenario_a(fmt, row):
        # ================= Scenario A: compound composite editing (+ B1 refusals) =================
        c = row['compound']
        g = c['geometry']
        source = Path(c['source'])
        check(f'{fmt} compound fixture identity', sha(source) == c['sha256'])
        path = args.out / f'compound-native.{fmt}'
        shutil.copyfile(source, path)
        a.open(fmt, path)
        a.engine('xkb:us::eng')
        check(f'{fmt} test-only text hook absent', d.js('return !document.querySelector("[data-testid=rhwp-status]").hasAttribute("data-paragraph-text")'))
        calibrate()
        report.setdefault('statusAtOpen', {})[fmt] = st(fmt)
        # HWP structural eligibility waits for the original-document preflight started at load.
        click(g['format'])
        tab('한글 도구')
        a.wait('return document.querySelector(\'[data-command="table.insertRowBelow"]\')?.getAttribute("aria-disabled")!=="true"', timeout=60)
        report.setdefault('richTableCommands', {})[fmt] = {cmd: not disabled(cmd) for cmd in STRUCTURE}

        # A1. trusted IBus Hangul input in the A3 cell; structure command refused while composing.
        click(g['ime']); a.key('End'); offset = caret(g['ime']['cell'])
        check(f'{fmt} IME target caret at paragraph end', offset == 2, offset)
        d.js('window.__s4Ime=[];for(const t of ["compositionstart","compositionupdate","compositionend"])document.querySelector(".rhwp-input").addEventListener(t,e=>window.__s4Ime.push({type:t,data:e.data,trusted:e.isTrusted}),true)')
        before = revision(fmt)
        a.engine('hangul'); a.type('dlq')
        a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.composing==="true"')
        check(f'{fmt} composing refuses rich-table structure and formula commands', all(disabled(x) for x in [*STRUCTURE, 'hangul.insertTableFormula']))
        a.type('fur'); a.key('End'); idle(); a.engine('xkb:us::eng')
        events = d.js('return window.__s4Ime')
        ends = [e['data'] for e in events if e['type'] == 'compositionend' and e['trusted']]
        check(f'{fmt} trusted native Hangul composition committed 입력', any(e['type'] == 'compositionstart' and e['trusted'] for e in events) and ''.join(ends) == '입력', ends)
        report.setdefault('nativeIme', []).append({'format': fmt, 'events': events})
        check(f'{fmt} Korean input committed', revision(fmt) > before and caret(g['ime']['cell']) == 4)
        phase2_undo = revision(fmt)
        a.key('ctrl+z'); idle()
        check(f'{fmt} Korean input native Undo', revision(fmt) == phase2_undo + 1 and caret(g['ime']['cell']) == 2)
        a.key('ctrl+y'); idle()
        check(f'{fmt} Korean input native Redo', revision(fmt) == phase2_undo + 2 and caret(g['ime']['cell']) == 4)

        # A2. character formatting on the whole C1 paragraph.
        click(g['format']); a.key('Home', 'shift+End')
        before = revision(fmt)
        a.key('ctrl+b'); idle()
        check(f'{fmt} bold applied as one revision', revision(fmt) == before + 1)

        # A3. replace the second of two inline formulas through the product dialog.
        offset = click(g['formulaSecond'])
        second = next(f for f in c['fields'] if f['command'].startswith('=B1*2'))
        check(f'{fmt} caret owns the second formula range', second['startCharIdx'] <= offset < second['startCharIdx'] + len(second['value']), offset)
        before = revision(fmt)
        formula_dialog('=B1*2', '=A1*5')
        check(f'{fmt} formula replacement one revision', revision(fmt) == before + 1)

        # A4. typing next to the existing inline picture.
        click(g['picture']); a.key('End')
        check(f'{fmt} caret after the inline picture', caret(g['picture']['cell']) == 3)
        before = revision(fmt)
        a.type('P'); idle()
        check(f'{fmt} typing after picture committed', revision(fmt) == before + 1 and caret(g['picture']['cell']) == 4)

        # Scenario B1 representative refusals inside the same compound session.
        a.key('Left', 'shift+Left')
        rev, dirty = revision(fmt), st(fmt)['dirty']
        a.key('Delete'); time.sleep(.5); idle()
        unchanged(fmt, 'selection containing the picture refuses Delete', rev, dirty)
        offset = click(g['formulaInside'])
        check(f'{fmt} caret strictly inside the replaced formula', second['startCharIdx'] < offset < second['startCharIdx'] + 2, offset)
        a.type('Z'); time.sleep(.5); idle()
        unchanged(fmt, 'typing inside a formula field refused', rev, dirty)
        a.key('BackSpace'); time.sleep(.5); idle()
        unchanged(fmt, 'deleting inside a formula field refused', rev, dirty)
        # History is not corrupted by the refusals: Undo/Redo still address the picture-adjacent typing.
        # (Undo snapshots the current state with the caret of that moment; Redo restores exactly that caret.)
        at_undo = st(fmt)['caret']
        a.key('ctrl+z'); idle()
        check(f'{fmt} Undo after refusals reverts the last real edit', revision(fmt) == rev + 1 and caret(g['picture']['cell']) == 3)
        a.key('ctrl+y'); idle()
        check(f'{fmt} Redo after refusals restores it', revision(fmt) == rev + 2 and st(fmt)['caret'] == at_undo, {'atUndo': at_undo, 'afterRedo': st(fmt)['caret']})
        # Subsequent supported typing.
        click(g['ime']); a.key('End')
        before = revision(fmt)
        a.type('!'); idle()
        check(f'{fmt} supported typing after refusals', revision(fmt) == before + 1 and caret(g['ime']['cell']) == 5)

        # A5. supported structure command on the rich table.
        click(g['format'])
        before = revision(fmt)
        ribbon('table.insertRowBelow'); idle()
        check(f'{fmt} insert row below on the rich table: one revision', revision(fmt) == before + 1)
        caret(g['format']['cell'])

        # A6. Undo the structure edit -> publish; Redo -> publish.
        # --single-save: Undo/Redo, then one publication of every edit from the original fixture.
        a.key('ctrl+z'); idle()
        check(f'{fmt} structure Undo', revision(fmt) == before + 2)
        if not args.single_save:
            save(fmt, path, 'undo-save')
        a.key('ctrl+y'); idle()
        check(f'{fmt} structure Redo', revision(fmt) == before + 3 and st(fmt)['dirty'] == 'true')
        save(fmt, path, 'composite-single-save' if args.single_save else 'composite-save')
        d.screenshot(args.out / f'{fmt}-composite.png')
        reopen(fmt, path, 'composite')
        check(f'{fmt} compound source still immutable', sha(source) == c['sha256'])

    def scenario_stale(fmt, row):
        # ================= Scenario B2: stale formula cache =================
        s = row['stale']
        sg = s['geometry']
        source = Path(s['source'])
        check(f'{fmt} stale fixture identity', sha(source) == s['sha256'])
        path = args.out / f'stale-native.{fmt}'
        shutil.copyfile(source, path)
        a.open(fmt, path)
        a.engine('xkb:us::eng')
        calibrate()
        click(sg['source']); a.key('End', 'BackSpace'); idle(); a.type('1'); idle()
        check(f'{fmt} A1 edited to 11', caret(sg['source']['cell']) == 2 and st(fmt)['dirty'] == 'true')
        rev = revision(fmt)
        target_before = sha(path)
        a.key('ctrl+s')
        a.wait('const e=document.querySelector("[data-testid=rhwp-save-result]");return e && !["checking","saving"].includes(e.dataset.state) && (e.dataset.error!=="" || e.dataset.state==="saved")', timeout=60)
        time.sleep(1)
        refused = save_result()
        report.setdefault('staleRefusal', {})[fmt] = {'saveResult': refused, 'status': st(fmt)}
        refused['alert'] = d.js('return document.querySelector("[data-testid=rhwp-save-result] [role=alert]")?.textContent ?? ""')
        check(f'{fmt} stale cache save refused', refused['state'] != 'saved' and refused['error'] != '', refused)
        # The refusal names the unrecalculated formula (not an engine export failure).
        check(f'{fmt} stale refusal asks for formula recalculation', any(m in refused['alert'] for m in STALE_MESSAGES), refused['alert'])
        check(f'{fmt} refused save left the target bytes unchanged', sha(path) == target_before == s['sha256'])
        unchanged(fmt, 'stale refusal keeps document dirty and ready', rev, 'true')
        # Explicit recalculation: replace B1 with its own expression.
        click(sg['formula'])
        before = revision(fmt)
        formula_dialog('=A1*2')
        check(f'{fmt} explicit recalculation one revision', revision(fmt) == before + 1)
        save(fmt, path, 'stale-recalculated-save')
        reopen(fmt, path, 'stale recalculated')
        check(f'{fmt} stale source still immutable', sha(source) == s['sha256'])

    for row in geometry['fixtures']:
        fmt = row['format']
        st_fmt[0] = fmt
        if not args.only_stale:
            scenario_a(fmt, row)
        if not args.single_save:
            scenario_stale(fmt, row)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'out', 'geometry'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--only-stale', action='store_true', help='rerun only the stale-cache refusal/recovery scenario')
    parser.add_argument('--single-save', action='store_true', help='Scenario A only, one publication after Undo/Redo')
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'scope': 'Stage 4 minimal native integration; normal embedded production assets; native XTest/IBus; actual Tauri save service; no engine observer',
              'app': str(args.app), 'appSha256': sha(args.app)}
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
                report['failureStatus'] = d.js('const e=document.querySelector("[data-testid=rhwp-status]");return e?{...e.dataset}:null')
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
