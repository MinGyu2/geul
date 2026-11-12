#!/usr/bin/env python3
"""RHWP general character formatting: one continuous native GUI scenario per format (Stage 5/6).

Run inside scripts/tests/native-ibus-session.py against the normal product build
(`npm run build` without VITE_GEUL_TEST_* flags, then
`cargo build --bin geul --features tauri/custom-protocol`). Every user interaction is native X11
input (xdotool keyboard/pointer, GTK file chooser, IBus + ibus-hangul); WebDriver only observes
ordinary DOM attributes, the page canvas and screenshots. The product build exposes no model text,
so text and character properties are asserted on the files the product saved, reopened outside the
app with the hash-verified RHWP Release runtime (scripts/tests/rhwp-char-flags.mjs).

Scenario per format: open -> Korean IME text -> bold/italic/underline by shortcut and
strikethrough/bold/italic/underline by ribbon -> bold inside one table cell -> Undo -> Redo ->
save -> close -> reopen through the native chooser -> formatting state on the reopened document.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import traceback
import uuid

import t010_acceptance as gate
import t010_lifecycle as lifecycle

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke  # noqa: E402
import rhwp_poc as rhwp  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/tests' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


production = load('t010_production_native', 'native-t010-production.py')
sha = production.sha
FLAGS = {'bold': 'B', 'italic': 'I', 'underline': 'U', 'strikethrough': 'S'}
IME_KEYS, IME_TEXT = 'dkssud', '안녕'


def marked(text, ranges):
    """Expected per-character flag letters: '-' everywhere except the given (start, end, letters)."""
    flags = ['-'] * len(text)
    for start, end, letters in ranges:
        flags[start:end] = [letters] * (end - start)
    return flags


class Formatting(production.Production):
    def oracle(self, path):
        value = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/rhwp-char-flags.mjs'), str(path)], text=True))
        identity = {'generation': value['generation'], 'artifacts': value['artifacts']}
        gate.require(identity == {'generation': self.args.expected['release']['generation'], 'artifacts': self.args.expected['release']['artifacts']}, 'oracle Release mismatch')
        self.report['oracleIdentity'] = identity
        return value['files'][0]

    def model(self, file):
        return {'body': [[p['text'], ''.join(p['flags'])] for p in file['body']],
                'cells': [[c['text'], ''.join(c['flags'])] for c in file['tables'][0]['cells']]}

    def save_and_verify(self, path, label, expected):
        result = self.a.save(self.row['format'])
        copy = self.args.out / f'{self.row["format"]}-{label}{path.suffix}'
        shutil.copyfile(path, copy)
        actual = self.model(self.oracle(copy))
        self.row['saves'].append({'label': label, 'result': {k: result.get(k) for k in ('state', 'synced', 'changedSince')}, 'sha256': sha(copy), 'model': actual})
        self.check(f'{label}: GUI save succeeded', result.get('state') == 'saved', result)
        self.check(f'{label}: saved file read outside the app has exact text and character flags', actual == expected, {'actual': actual, 'expected': expected})
        self.row['saves'][-1]['verified'] = True

    def button(self, name):
        return self.d.js('const b=document.querySelector(arguments[0]);if(!b)return null;const r=b.getBoundingClientRect();'
                         'return {disabled:b.getAttribute("aria-disabled")==="true",pressed:b.getAttribute("aria-pressed"),visible:r.width>0&&r.height>0,title:b.title}',
                         f'[data-command="format.{name}"]')

    def buttons(self):
        return {name: self.button(name) for name in FLAGS}

    def canvas(self):
        """SHA-256 of the first page canvas pixels (selection and caret are separate DOM overlays)."""
        self.idle(); time.sleep(0.5)
        data = self.d.js("return document.querySelector('.rhwp-page[data-page=\"0\"] canvas, .rhwp-page canvas').toDataURL()")
        return hashlib.sha256(data.encode()).hexdigest()

    def select(self, paragraph, start, end, cell=None):
        """Native keyboard selection inside the paragraph or cell that holds the caret."""
        self.a.key('Home', *['Right'] * start)
        self.a.key(*['shift+Right'] * (end - start))
        suffix = f'@{cell}' if cell else ''
        want = f'0:{paragraph}:{start}{suffix}|0:{paragraph}:{end}{suffix}'
        self.a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.selection===arguments[0]', want)
        return want

    def apply(self, name, how, selection, expect_pressed=True):
        """One formatting command through the real UI; returns canvas hash after it."""
        before_rev, before_canvas = int(self.state()['localRevision']), self.canvas()
        if how == 'ribbon':
            self.click(f'[data-command="format.{name}"]')
        else:
            self.a.key(how)
        self.idle()
        after = self.state()
        label = f'{name} via {how} on {selection}'
        self.check(f'{label}: one accepted revision', int(after['localRevision']) == before_rev + 1 and after['uncertain'] == 'false', [before_rev, after['localRevision'], after['uncertain']])
        self.check(f'{label}: selection and caret kept', after['selection'] == selection, after['selection'])
        pressed = self.button(name)['pressed']
        self.check(f'{label}: ribbon state reflects formatting', pressed == ('true' if expect_pressed else 'false'), pressed)
        canvas = self.canvas()
        self.check(f'{label}: rendered page visibly changed', canvas != before_canvas)
        self.row['operations'].append({'command': f'format.{name}', 'via': how, 'selection': selection, 'canvasBefore': before_canvas, 'canvasAfter': canvas})
        return canvas

    def click_cell(self, file, cell):
        """Native pointer click at a cell start; geometry comes from the out-of-app oracle, not an app hook."""
        start, page = file['tables'][0]['cells'][cell]['start'], file['page']
        point = self.d.js("""const p=document.querySelector('.rhwp-page'),s=document.querySelector('.editor__scroll');s.scrollTop=0;s.scrollLeft=0;
          const r=p.getBoundingClientRect(),k=r.width/arguments[1];return [r.left+(arguments[0].x+1)*k,r.top+(arguments[0].y+arguments[0].height/2)*k]""", start, page['width'])
        self.click_point(point)
        table = file['tables'][0]
        self.cell_key = f'{table["control"]}/{cell}/0'
        self.a.wait('return new RegExp(arguments[0]).test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret??"")',
                    f'^0:{table["paragraph"]}:\\d+@{re.escape(self.cell_key)}$')
        return table['paragraph']

    def run(self, fmt):
        a, d = self.a, self.d
        self.row = {'format': fmt, 'status': 'RUNNING', 'checks': [], 'saves': [], 'operations': []}
        self.rows.append(self.row)
        source = self.args.fixtures / f'basic-ko.{fmt}'
        source_sha = sha(source)
        original = self.oracle(source)
        base = self.model(original)
        self.report.setdefault('fixtureOracle', {})[fmt] = base
        t0, t1 = base['body'][0][0], base['body'][1][0]
        gate.require(t1[6:10] == 'Bold' and base['cells'][1][0][:4] == 'Cell' and t0[10:16] == 'Korean', 'unexpected fixture content')
        path = self.args.out / f'format-{fmt}.{fmt}'
        shutil.copyfile(source, path)

        # A. Open; editable; formatting needs a selection.
        a.open(fmt, path)
        absent = d.js('return !document.querySelector("[data-testid=rhwp-status]").hasAttribute("data-paragraph-text")')
        self.report['testHooksAbsent'] = self.report['testHooksAbsent'] and absent
        self.check('product build: test-only text hook absent', absent)
        self.focus_start(); a.engine('xkb:us::eng')
        d.js('window.__pEvents=[]')
        st = self.state()
        self.check('document editable: ready, clean, input focused', st['status'] == 'ready' and st['dirty'] == 'false' and st['localRevision'] == '0', st)
        controls = self.buttons()
        self.check('four formatting controls visible in the ribbon', all(b and b['visible'] for b in controls.values()), controls)
        self.check('collapsed caret: formatting unavailable', all(b['disabled'] for b in controls.values()), controls)
        d.screenshot(self.args.out / f'{fmt}-01-opened.png')

        # E. Real Korean IME text, then format it.
        a.engine('hangul'); a.type(IME_KEYS); a.key('End'); self.idle(); a.engine('xkb:us::eng')
        events = d.js('return window.__pEvents')
        self.check('native Korean composition through IBus (trusted compositionstart/compositionend)',
                   any(e['type'] == 'compositionstart' and e['trusted'] for e in events) and any(e['type'] == 'compositionend' and e['trusted'] for e in events))
        self.row['imeCommitted'] = [e['data'] for e in events if e['type'] == 'compositionend']
        p0 = IME_TEXT + t0
        n = len(IME_TEXT)
        sel = self.select(0, 0, n)
        controls = self.buttons()
        self.check('valid selection: four formatting commands available and not pressed', all(not b['disabled'] and b['pressed'] == 'false' for b in controls.values()), controls)
        self.apply('bold', 'ctrl+b', sel)

        # B. Remaining shortcuts and all four ribbon controls; C. ordinary text.
        self.apply('italic', 'ctrl+i', self.select(0, n + 3, n + 5))
        self.apply('underline', 'ctrl+u', self.select(0, n + 5, n + 8))
        self.apply('strikethrough', 'ribbon', self.select(0, n + 10, n + 16))
        a.key('Home', 'Down')
        a.wait('return /^0:1:/.test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret??"")')
        sel = self.select(1, 6, 10)
        for name in ('bold', 'italic', 'underline'):
            self.apply(name, 'ribbon', sel)
        d.screenshot(self.args.out / f'{fmt}-02-body-formatted.png')
        body = [[p0, ''.join(marked(p0, [(0, n, 'B'), (n + 3, n + 5, 'I'), (n + 5, n + 8, 'U'), (n + 10, n + 16, 'S')]))],
                [t1, ''.join(marked(t1, [(0, 5, 'B'), (6, 10, 'BIU')]))], *base['body'][2:]]

        # C. One table cell; D. Undo/Redo on that formatting edit.
        table = self.click_cell(original, 1)
        sel = self.select(table, 0, 4, self.cell_key)
        before = self.canvas()
        formatted = self.apply('bold', 'ctrl+b', sel)
        cells = [list(c) for c in base['cells']]
        cells[1][1] = 'BBBB' + cells[1][1][4:]
        self.press('ctrl+z', 'undo')
        self.check('Undo: rendered page equals the state before the cell formatting', self.canvas() == before)
        self.check('Undo: bold no longer reported for the restored selection', self.button('bold')['pressed'] != 'true', self.state()['selection'])
        d.screenshot(self.args.out / f'{fmt}-03-undo.png')
        self.save_and_verify(path, 'undo', {'body': body, 'cells': base['cells']})
        st = self.press('ctrl+y', 'redo')
        self.check('Redo exhausted after Ctrl+Y', st['redo']['disabled'], st['redo'])
        self.check('Redo: rendered page equals the formatted state', self.canvas() == formatted)
        d.screenshot(self.args.out / f'{fmt}-04-redo.png')

        # F. Save, close, reopen through the native chooser.
        expected = {'body': body, 'cells': cells}
        self.save_and_verify(path, 'final', expected)
        final_sha = sha(path)
        gate.require(rhwp.close_tab(d, path.name), 'saved document asked to discard')
        a.open_native(fmt, path)
        st = self.state()
        self.check('reopened document: fresh clean session', st['localRevision'] == '0' and st['dirty'] == 'false' and st['undo']['disabled'], st)
        self.focus_start()

        def pressed_for(selection_args):
            self.select(*selection_args)
            return {k: v['pressed'] == 'true' for k, v in self.buttons().items()}
        got = {'ime-bold': pressed_for((0, 0, n)), 'italic': pressed_for((0, n + 3, n + 5)), 'underline': pressed_for((0, n + 5, n + 8)),
               'strike': pressed_for((0, n + 10, n + 16)), 'unformatted': pressed_for((0, n, n + 2))}
        a.key('Home', 'Down'); a.wait('return /^0:1:/.test(document.querySelector("[data-testid=rhwp-status]")?.dataset.caret??"")')
        got['ribbon-biu'] = pressed_for((1, 6, 10))
        table = self.click_cell(original, 1)
        got['cell-bold'] = pressed_for((table, 0, 4, self.cell_key))
        got['cell-rest'] = pressed_for((table, 4, 8, self.cell_key))
        none = dict.fromkeys(FLAGS, False)
        want = {'ime-bold': none | {'bold': True}, 'italic': none | {'italic': True}, 'underline': none | {'underline': True},
                'strike': none | {'strikethrough': True}, 'unformatted': none, 'ribbon-biu': none | {'bold': True, 'italic': True, 'underline': True},
                'cell-bold': none | {'bold': True}, 'cell-rest': none}
        self.check('reopened document: application reports the saved formatting and unformatted neighbours', got == want, got)
        d.screenshot(self.args.out / f'{fmt}-05-reopened.png')
        st = self.state()
        self.check('reopened document untouched by inspection', st['localRevision'] == '0' and st['dirty'] == 'false', st)
        self.check('saved file unchanged by reopen', sha(path) == final_sha)
        self.check('source fixture bytes unchanged', sha(source) == source_sha)
        gate.require(rhwp.close_tab(d, path.name), 'reopened document did not close cleanly')
        self.check('all observed editor input events trusted', all(e['trusted'] for e in events))
        self.row['status'] = 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ('app', 'driver', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--app-sha256', required=True)
    parser.add_argument('--build-evidence', type=Path, default=ROOT / 'dist/frontend-build.json')
    parser.add_argument('--formats', default='hwp,hwpx')
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    report = {'runId': os.environ.get('GEUL_NATIVE_RUN_ID') or uuid.uuid4().hex, 'status': 'RUNNING',
              'scope': 'normal embedded product build; native X11/IBus input; actual save service; saved files read by the Release runtime outside the app',
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__), 'oracleSha256': sha(ROOT / 'scripts/tests/rhwp-char-flags.mjs'),
              'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src', 'src-tauri', 'public', 'patches'], cwd=ROOT)).hexdigest(),
              'testFlagsInEnvironment': sorted(k for k in os.environ if k.startswith('VITE_GEUL_TEST_'))}
    smoke.APP = str(args.app); smoke.DRIVER_LOG = str(args.out / 'driver.log')
    try:
        args.expected = {'appSha256': args.app_sha256,
                         'release': json.loads((ROOT / 'public/rhwp/RELEASE.json').read_text()),
                         'frontendBuild': json.loads(args.build_evidence.read_text())}
        report['expectedIdentity'] = args.expected
        gate.release(args.expected['release'], args.expected['release'])
        gate.require(report['appSha256'] == args.app_sha256, 'app identity mismatch')
        gate.require(report['testFlagsInEnvironment'] == [], 'unexpected VITE_GEUL_TEST_* runtime environment')
        gate.require(args.expected['frontendBuild']['testFlags'] == {} and args.expected['frontendBuild']['mode'] == 'production', 'test-only/non-production frontend build')
        args.fixtures = args.out / 'fixtures'
        subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(args.fixtures)], check=True, capture_output=True)
        report['fixtureSha256'] = {p.name: sha(p) for p in sorted(args.fixtures.glob('basic-ko.hwp*'))}
        with lifecycle.driver(smoke, str(args.driver), 4444, str(args.out / 'data'), report) as start:
            d = start()
            try:
                smoke.wait_until(d, 'return !!document.querySelector(".document-bar")', timeout=60)
                report['location'] = d.js('return location.href')
                value = production.base.Acceptance(args, d, report).async_js("""
                  const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(x=>x.toString(16).padStart(2,'0')).join('');
                  const get=async p=>{const r=await fetch(p);if(!r.ok)throw Error('fetch '+p+': '+r.status);return r};
                  const build=await(await get('/frontend-build.json')).json();
                  const identity=await(await get('/rhwp/BUILD.json')).json();
                  const assets={},artifacts={};
                  for(const p of Object.keys(arguments[0].frontendBuild.assets))assets[p]=await hash(await(await get('/'+p)).arrayBuffer());
                  for(const n of ['rhwp.js','rhwp_bg.wasm'])artifacts[n]=await hash(await(await get('/rhwp/generations/'+arguments[0].release.generation+'/'+n)).arrayBuffer());
                  const entrypoints=[...document.querySelectorAll('script[src],link[rel=stylesheet][href]')].map(e=>e.getAttribute(e.tagName==='SCRIPT'?'src':'href')).sort();
                  return {frontendBuild:build,frontendAssetHashes:assets,frontendEntrypoints:entrypoints,rhwpIdentity:identity,servedArtifactHashes:artifacts};
                """, args.expected)
                gate.require(value.get('ok') is True, 'embedded identity fetch failed: ' + str(value))
                report.update(value['value'])
                report['testTraceAbsent'] = d.js('return typeof window.__geulTrace==="undefined" && typeof window.__geulTraceRecord==="undefined"')
                report['testHooksAbsent'] = d.js('return typeof window.__geulPerf==="undefined"')
                p = Formatting(args, d, report)
                p.calibrate()
                for fmt in args.formats.split(','):
                    try:
                        p.run(fmt)
                    except Exception as error:
                        p.row['status'] = 'FAIL'; p.row['error'] = f'{type(error).__name__}: {error}'; p.row['trace'] = traceback.format_exc()
                        p.row['stateAtFailure'] = d.js('const e=document.querySelector("[data-testid=rhwp-status]");return e?{...e.dataset}:null')
                        d.screenshot(args.out / f'{fmt}-failure.png')
                        for name in d.js("return [...document.querySelectorAll('.document-tab__select')].map(e=>e.textContent)"):
                            if f'format-{fmt}.{fmt}' in name:
                                d.js("[...document.querySelectorAll('.document-tab__close')].find(b=>b.getAttribute('aria-label').includes(arguments[0]))?.click()", f'format-{fmt}.{fmt}')
                                time.sleep(0.5)
                                d.js("document.querySelector('[data-testid=discard-confirm]')?.click()")
                    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
            finally:
                smoke.end_session(d)
    except Exception as error:
        report.update(error=f'{type(error).__name__}: {error}', trace=traceback.format_exc())

    def accept(report, expected):
        gate.production_identity(report, expected)
        rows = report.get('formats', [])
        gate.require([r['format'] for r in rows] == args.formats.split(',') and all(r['status'] == 'PASS' for r in rows), 'format scenario missing or failed')
        for row in rows:
            gate.require(all(c['status'] == 'PASS' for c in row['checks']) and [s['label'] for s in row['saves']] == ['undo', 'final']
                         and all(s.get('verified') is True for s in row['saves']) and len(row['operations']) == 8, 'incomplete scenario evidence')
        gate.teardown(report.get('teardown'), report.get('sessions'), report.get('runId'))
        gate.require(not report.get('error'), 'execution error')
    report['acceptance'] = gate.verdict(accept, report, getattr(args, 'expected', {}))
    # Launcher cleanup (native-ibus-session.py cleanup.json) is verified by the caller after this process exits.
    report['status'] = 'PASS_PENDING_LAUNCHER_CLEANUP' if report['acceptance']['status'] == 'PASS' else 'FAIL'
    report['summary'] = {r['format']: {'status': r['status'], 'checks': len(r['checks']), 'saves': len(r['saves']), 'error': r.get('error')} for r in report.get('formats', [])}
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'acceptance': report['acceptance'], 'summary': report['summary'], 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] != 'FAIL' else 1


if __name__ == '__main__':
    sys.exit(main())
