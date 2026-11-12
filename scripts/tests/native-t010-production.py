#!/usr/bin/env python3
"""T010 general RHWP Undo/Redo in the normal product build (embedded assets, no test hooks).

Run inside scripts/tests/native-ibus-session.py against a protected
`cargo build --bin geul --features tauri/custom-protocol` app built from `npm run build` output
(no VITE_GEUL_TEST_* flags). Input is native X11 (xdotool) through GTK/IBus/ibus-hangul. The app exposes
no model text in this build, so every content assertion is made on files saved by the product's own
save path and reopened outside the app with the hash-verified RHWP Release runtime
(scripts/tests/rhwp-paragraphs.mjs). Ribbon state, revision and caret come from ordinary DOM attributes.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke  # noqa: E402
import rhwp_poc as rhwp  # noqa: E402

spec = importlib.util.spec_from_file_location('production_native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


class Production:
    def __init__(self, args, d, report):
        self.args, self.d, self.report = args, d, report
        self.a = base.Acceptance(args, d, report)
        self.rows = report.setdefault('formats', [])

    def check(self, name, ok, detail=None):
        self.row['checks'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **({'detail': detail} if detail is not None else {})})
        if not ok:
            raise smoke.Failure(f'{self.row["format"]}: {name} {json.dumps(detail, ensure_ascii=False) if detail is not None else ""}')

    def calibrate(self):
        a, d = self.a, self.d
        self.window = a.command(self.args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
        a.command(self.args.xdotool, 'windowfocus', '--sync', self.window)
        d.js("window.__pMove=null;window.addEventListener('mousemove',e=>window.__pMove=[e.clientX,e.clientY],true)")
        points = []
        for n in (100, 200):
            d.js('window.__pMove=null')
            a.command(self.args.xdotool, 'mousemove', '--window', self.window, str(n), str(n))
            a.wait('return !!window.__pMove')
            points.append(d.js('return window.__pMove'))
        self.scale = [100 / (points[1][i] - points[0][i]) for i in (0, 1)]
        self.origin = [100 - points[0][i] * self.scale[i] for i in (0, 1)]
        d.js("""window.__pEvents=[];for(const type of ['keydown','compositionstart','compositionend','input'])
          document.addEventListener(type,e=>{if(e.target?.matches?.('.rhwp-input'))window.__pEvents.push({type,trusted:e.isTrusted,data:e.data??null})},true);""")

    def click_point(self, point):
        xy = [str(round(point[i] * self.scale[i] + self.origin[i])) for i in (0, 1)]
        self.a.command(self.args.xdotool, 'mousemove', '--window', self.window, *xy, 'click', '1')

    def click(self, css):
        self.click_point(self.d.js('const r=document.querySelector(arguments[0]).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]', css))

    def focus_start(self):
        self.a.wait( "return !!document.querySelector('.rhwp-page') && document.querySelector('.editor__scroll canvas')?.width>0", timeout=180)
        point = self.d.js("""const p=document.querySelector('.rhwp-page'),s=document.querySelector('.editor__scroll');s.scrollTop=0;s.scrollLeft=0;
          const r=p.getBoundingClientRect(),q=s.getBoundingClientRect();
          return [Math.max(r.left,q.left)+Math.min(150,r.width/2),Math.max(r.top,q.top)+20]""")
        self.click_point(point)
        self.a.wait("return document.activeElement?.matches('.editor__scroll .rhwp-input')")
        self.a.key('Home')

    def idle(self):
        self.a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision', timeout=60)
        time.sleep(0.4)
        self.a.wait('const s=document.querySelector("[data-testid=rhwp-status]");return s?.dataset.composing==="false" && s.dataset.localRevision===s.dataset.revision', timeout=60)

    def state(self):
        st = self.a.status('hwp')
        st['undo'] = self.d.js('const b=document.querySelector(\'[data-command="edit.undo"]\');return {disabled:b.getAttribute("aria-disabled")==="true",title:b.title}')
        st['redo'] = self.d.js('const b=document.querySelector(\'[data-command="edit.redo"]\');return {disabled:b.getAttribute("aria-disabled")==="true",title:b.title}')
        return st

    def paragraphs(self, path):
        out = subprocess.check_output(['node', str(ROOT / 'scripts/tests/rhwp-paragraphs.mjs'), str(path)], text=True)
        value = json.loads(out)
        self.report['oracleGeneration'] = value['generation']
        return value['files'][0]['paragraphs']

    def save(self, path, label, expected_first):
        result = self.a.save(self.row['format'])
        copy = self.args.out / f'{self.row["format"]}-{label}{path.suffix}'
        shutil.copyfile(path, copy)
        paragraphs = self.paragraphs(copy)
        self.row['saves'].append({'label': label, 'result': {k: result.get(k) for k in ('state', 'synced', 'changedSince')}, 'sha256': sha(copy), 'first': paragraphs[0], 'paragraphs': len(paragraphs)})
        self.check(f'{label}: saved file reopened outside the app holds expected text', paragraphs[0] == expected_first and paragraphs[1:] == self.rest, [paragraphs[0], expected_first])
        return paragraphs

    def press(self, how, direction):
        before = int(self.state()['localRevision'])
        if how == 'button':
            self.click(f'[data-command="edit.{direction}"]')
        else:
            self.a.key(how)
        self.idle()
        after = self.state()
        self.check(f'{direction} via {how} advances revision by one', int(after['localRevision']) == before + 1, [before, after['localRevision']])
        return after

    def run(self, fmt):
        a, d = self.a, self.d
        self.row = {'format': fmt, 'status': 'RUNNING', 'checks': [], 'saves': []}
        self.rows.append(self.row)
        source = self.args.fixtures / f'basic-ko.{fmt}'
        original = self.paragraphs(source)
        t0, self.rest = original[0], original[1:]
        path = self.args.out / f'prod-{fmt}.{fmt}'
        shutil.copyfile(source, path)
        a.open(fmt, path)
        self.check('product build: test-only text hook absent', d.js('return !document.querySelector("[data-testid=rhwp-status]").hasAttribute("data-paragraph-text")'))
        self.check('product build: no advanced-only history notice', '글자 입력' not in d.js('return document.querySelector("[data-testid=rhwp-status]").textContent'))
        self.focus_start(); a.engine('xkb:us::eng')
        d.js('window.__pEvents=[]')
        st = self.state()
        self.check('fresh document: Undo and Redo exposed but unavailable', st['undo']['disabled'] and st['redo']['disabled'] and '되돌릴' in st['undo']['title'], [st['undo'], st['redo']])
        a.type('Alpha '); self.idle()
        st = self.state()
        self.check('ordinary typing makes Undo available', not st['undo']['disabled'], st['undo'])
        a.key('Left', 'Right')  # caret movement closes the typing group
        a.engine('hangul'); a.type('gksrmf'); a.key('End'); self.idle(); a.engine('xkb:us::eng')
        events = d.js('return window.__pEvents')
        self.check('native Korean composition through IBus', any(e['type'] == 'compositionstart' and e['trusted'] for e in events) and any(e['type'] == 'compositionend' and e['trusted'] for e in events))
        self.save(path, 'typed', 'Alpha 한글' + t0)
        self.check('Undo available after save', not self.state()['undo']['disabled'])
        self.press('ctrl+z', 'undo')
        self.save(path, 'ctrl-z-korean', 'Alpha ' + t0)
        st = self.press('ctrl+y', 'redo')
        self.check('Redo exhausted after Ctrl+Y', st['redo']['disabled'], st['redo'])
        self.save(path, 'ctrl-y-korean', 'Alpha 한글' + t0)
        self.press('button', 'undo'); st = self.press('button', 'undo')
        self.check('two ribbon Undo presses exhaust history', st['undo']['disabled'] and not st['redo']['disabled'], [st['undo'], st['redo']])
        rev = st['localRevision']; a.key('ctrl+z'); self.idle()
        self.check('Ctrl+Z with nothing to undo is a no-op', self.state()['localRevision'] == rev)
        self.save(path, 'ribbon-undo-all', t0)
        self.press('ctrl+shift+z', 'redo'); self.press('button', 'redo')
        self.save(path, 'redo-all', 'Alpha 한글' + t0)
        self.press('ctrl+z', 'undo')
        a.type('Z'); self.idle()
        st = self.state()
        self.check('new edit after Undo invalidates Redo', st['redo']['disabled'], st['redo'])
        rev = st['localRevision']; a.key('ctrl+y'); self.idle()
        self.check('Ctrl+Y on invalidated branch is a no-op', self.state()['localRevision'] == rev)
        self.save(path, 'branch', 'Alpha Z' + t0)
        assert rhwp.close_tab(d, path.name), 'saved document asked to discard'
        a.open_native(fmt, path)
        st = self.state()
        self.check('reopened document: fresh session without history', st['localRevision'] == '0' and st['dirty'] == 'false' and st['undo']['disabled'] and st['redo']['disabled'], st)
        # Two documents: history stays with its own document.
        other = self.args.out / f'prod-other-{fmt}.{fmt}'
        shutil.copyfile(source, other)
        self.focus_start(); a.type('a'); self.idle()
        a.open(fmt, other); self.focus_start()
        st = self.state()
        self.check('second document starts without history', st['undo']['disabled'], st['undo'])
        a.type('b'); self.idle(); self.press('ctrl+z', 'undo')
        d.js("[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0])&&!e.textContent.includes('prod-other')).click()", path.name)
        a.wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&e.textContent.includes(arguments[0])&&!e.textContent.includes('prod-other'))", path.name)
        a.wait('return document.querySelector("[data-testid=rhwp-status]")?.dataset.status==="ready"')
        st = self.state()
        self.check('first document keeps its own Undo after switching', not st['undo']['disabled'] and st['redo']['disabled'], [st['undo'], st['redo']])
        self.focus_start(); self.press('ctrl+z', 'undo')
        self.save(path, 'switch-a-undo', 'Alpha Z' + t0)
        d.js("[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes('prod-other')).click()")
        a.wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&e.textContent.includes('prod-other'))")
        st = self.state()
        self.check('second document keeps its own Redo after switching', not st['redo']['disabled'], st['redo'])
        self.focus_start(); self.press('ctrl+y', 'redo')
        self.save(other, 'switch-b-redo', 'b' + t0)
        assert rhwp.close_tab(d, other.name)
        assert rhwp.close_tab(d, path.name)
        self.row['events'] = d.js('return window.__pEvents.length')
        self.check('all observed editor input events trusted', all(e['trusted'] for e in d.js('return window.__pEvents')))
        self.row['status'] = 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ('app', 'driver', 'out'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--app-sha256', required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    report = {'status': 'RUNNING', 'scope': 'normal embedded product build; native X11/IBus; actual save service; saved files read by the Release runtime outside the app',
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__), 'oracleSha256': sha(ROOT / 'scripts/tests/rhwp-paragraphs.mjs'),
              'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src'], cwd=ROOT)).hexdigest(),
              'testFlagsInEnvironment': sorted(k for k in os.environ if k.startswith('VITE_GEUL_TEST_'))}
    assert report['appSha256'] == args.app_sha256, 'app identity mismatch'
    args.fixtures = args.out / 'fixtures'
    subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(args.fixtures)], check=True, capture_output=True)
    report['fixtureSha256'] = {p.name: sha(p) for p in sorted(args.fixtures.glob('basic-ko.hwp*'))}
    smoke.APP = str(args.app); smoke.DRIVER_LOG = str(args.out / 'driver.log')
    code = 1
    try:
        with smoke.tauri_driver(str(args.driver), 4444, str(args.out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, 'return !!document.querySelector(".document-bar")', timeout=60)
                report['location'] = d.js('return location.href')
                assert not report['location'].startswith('http://localhost'), 'dev-URL app is not the product build'
                d.js("window.__pId=null;fetch('/rhwp/BUILD.json').then(r=>r.json()).then(v=>window.__pId=v)")
                smoke.wait_until(d, 'return window.__pId!==null')
                report['rhwpIdentity'] = d.js('return window.__pId')
                report['testTraceAbsent'] = d.js('return typeof window.__geulTrace==="undefined"')
                p = Production(args, d, report)
                p.calibrate()
                for fmt in ('hwp', 'hwpx'):
                    try:
                        p.run(fmt)
                    except Exception as error:
                        p.row['status'] = 'FAIL'; p.row['error'] = f'{type(error).__name__}: {error}'; p.row['trace'] = traceback.format_exc()
                        d.screenshot(args.out / f'{fmt}-failure.png')
                        # Close what this format opened so the next format starts from an empty workspace.
                        for name in d.js("return [...document.querySelectorAll('.document-tab__select')].map(e=>e.textContent)"):
                            for candidate in (f'prod-{fmt}.{fmt}', f'prod-other-{fmt}.{fmt}'):
                                if candidate in name:
                                    d.js("[...document.querySelectorAll('.document-tab__close')].find(b=>b.getAttribute('aria-label').includes(arguments[0]))?.click()", candidate)
                                    time.sleep(0.5)
                                    d.js("document.querySelector('[data-testid=discard-confirm]')?.click()")
                    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
                report['status'] = 'PASS' if all(r['status'] == 'PASS' for r in report['formats']) and report['testTraceAbsent'] else 'FAIL'
                code = 0 if report['status'] == 'PASS' else 1
            finally:
                smoke.end_session(d)
    except Exception as error:
        report.update(status='FAIL', error=f'{type(error).__name__}: {error}', trace=traceback.format_exc())
    report['teardown'] = smoke.TEARDOWN
    report['summary'] = {r['format']: {'status': r['status'], 'checks': len(r['checks']), 'saves': len(r['saves']), 'error': r.get('error')} for r in report.get('formats', [])}
    (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'summary': report['summary'], 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return code


if __name__ == '__main__':
    sys.exit(main())
