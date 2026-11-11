#!/usr/bin/env python3
"""Ordered native acceptance; run inside native-ibus-session.py against dev geul.

All mutating UI actions use XTEST keys/pointers. JavaScript only observes the
rendered UI, trusted input events, and the normal read-only session IPC.
Generated documents and evidence must be under the ignored target directory.
"""
import argparse
import hashlib
import glob
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
TAB_NAME = "[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()"
sys.path.insert(0, str(ROOT / 'tests/e2e'))
import tauri_smoke as smoke

spec = importlib.util.spec_from_file_location('new_document', ROOT / 'scripts/tests/native-new-document.py')
creation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(creation)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class EnvironmentBlocked(smoke.Failure):
    pass


class Acceptance(creation.Acceptance):
    def __init__(self, args, driver, report):
        super().__init__(args, driver, report)
        self.fmt = None
        self.window = self.command('xdotool', 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
        self.command('xdotool', 'windowfocus', '--sync', self.window)
        identity = self.async_js("return await (await fetch('/rhwp/BUILD.json')).json()")
        if not identity.get('ok'):
            raise smoke.Failure('unable to observe actual served RHWP identity')
        self.report['rhwpBuild'] = identity['value']
        build = identity['value']
        patches = build.get('integration', {}).get('patches', [])
        if build.get('schemaVersion', 0) < 3 or not patches:
            raise EnvironmentBlocked('served RHWP generation lacks current patched-source identity; rebuild with scripts/build-rhwp-wasm.sh --dev and restart Vite')
        for patch in patches:
            path = ROOT / 'patches/rhwp' / patch['name']
            if not path.is_file() or sha(path) != patch['sha256']:
                raise EnvironmentBlocked('served RHWP patch identity differs from workspace: ' + patch['name'])
        if getattr(args, 'capture_engine_exports', False):
            captured = self.async_js("""
              window.__phase5Exports=[];
              const facade=await import('/src/components/Editor/rhwp/rhwpModule.ts').then(m=>m.loadRhwpModule());
              const open=facade.openDocument;
              facade.openDocument=function(...args){
                const doc=open.apply(this,args),original=doc.exportHwpWithReport;
                doc.exportHwpWithReport=function(...params){
                  const exported=original.apply(this,params),take=exported.takeBytes;
                  exported.takeBytes=function(...params){
                    const loss=exported.contentLoss(),bytes=take.apply(this,params);
                    window.__phase5Exports.push({loss,bytes:Array.from(bytes)});
                    if(window.__phase5Exports.length>8)window.__phase5Exports.shift();
                    return bytes;
                  };
                  return exported;
                };
                return doc;
              };
              return true;
            """)
            if not captured.get('ok'):
                raise smoke.Failure('passive export observer could not attach')
        self.d.js("window.__phase5Events=[];for(const type of ['keydown','keyup','compositionstart','compositionupdate','compositionend','beforeinput','input','focusin','focusout'])window.addEventListener(type,e=>window.__phase5Events.push({type,key:e.key,code:e.code,data:e.data,inputType:e.inputType,composing:e.isComposing,trusted:e.isTrusted,target:e.target.className}),{capture:true,passive:true})")

    def engine(self, name):
        # Bare Xvfb has no window manager to reactivate the parent after a GTK
        # chooser closes. PointerRoot routes raw keys but gives GTK no IM focus.
        self.command('xdotool', 'windowfocus', '--sync', self.window)
        previous = self.command('ibus', 'engine')
        super().engine(name)
        time.sleep(.2)  # allow GTK's real input context to adopt the engine
        self.report.setdefault('engineSwitches', []).append({'previous': previous, 'requested': name, 'observed': self.command('ibus', 'engine')})

    def record(self, name, ok, detail=None):
        row = {'stage': self.args.stage, 'format': self.fmt, 'environment': 'native Tauri / X11 Xvfb / IBus hangul',
               'actions': name, 'expected': name, 'observed': detail,
               'result': 'PASS' if ok else 'FAIL', 'evidence': str(self.args.out)}
        self.report['checks'].append(row)
        self.flush()
        print(row['result'], self.fmt, name, flush=True)
        if not ok:
            raise smoke.Failure(name + ': ' + repr(detail))

    def flush(self):
        (self.args.out / 'result.json').write_text(json.dumps(self.report, ensure_ascii=False, indent=2) + '\n')

    def click(self, selector=None, expression=None):
        expr = expression or 'document.querySelector(arguments[0])'
        point = self.d.js('const e=(' + expr + ');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}', selector)
        if not point or not point['w'] or not point['h']:
            raise smoke.Failure('native pointer target not visible: ' + str(selector or expression))
        scale = self.d.js('return devicePixelRatio')
        self.command('xdotool', 'mousemove', '--window', self.window, str(round(point['x'] * scale)), str(round(point['y'] * scale)), 'click', '1')

    def tab(self, text):
        self.click(text, "[...document.querySelectorAll('.ribbon__tabs [role=tab]')].find(e=>e.textContent===arguments[0])")

    def select(self, filename):
        self.click(filename, "[...document.querySelectorAll('.document-tab__select')].find(e=>" + TAB_NAME + "===arguments[0])")
        self.wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&" + TAB_NAME + "===arguments[0])", filename)

    def ready(self, fmt, filename):
        # .hwp is a prefix of .hwpx. Matching textContent.includes(filename)
        # can observe a different session before the requested file even opens.
        self.wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&e.dataset.state==='ready'&&" + TAB_NAME + "===arguments[0])", filename, timeout=60)
        prefix = 'docx' if fmt == 'docx' else 'rhwp'
        self.wait("const e=document.querySelector(arguments[0]);return e?.dataset.status==='ready'&&e.dataset.firstPaintMs!==''", '[data-testid=' + prefix + '-status]', timeout=60)
        self.wait("return document.querySelector('.editor__scroll canvas')?.width>0")

    def close(self, filename):
        self.click(filename, "[...document.querySelectorAll('.document-tab__select')].find(e=>" + TAB_NAME + "===arguments[0])?.parentElement.querySelector('.document-tab__close')")
        self.wait("return ![...document.querySelectorAll('.document-tab__select')].some(e=>" + TAB_NAME + "===arguments[0])", filename)

    def editor(self):
        # A native click on the visible caret restores the engine's current caret.
        self.click('.rhwp-caret')
        self.wait("return document.activeElement?.classList.contains('rhwp-input')")

    def snap(self, name):
        self.d.screenshot(self.args.out / (self.fmt + '-' + name + '.png'))
        self.native_screenshot(self.fmt + '-' + name)

    def native_screenshot(self, name):
        executable = glob.glob('/nix/store/*-scrot-*/bin/scrot')
        if executable:
            self.command(executable[0], str(self.args.out / (name + '-x11.png')))

    def native_window(self, title, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            probe = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + title + '$'], capture_output=True, text=True, timeout=3)
            if probe.returncode == 0 and probe.stdout.strip():
                return probe.stdout.split()[-1]
            time.sleep(.1)
        raise smoke.Failure('native window did not appear: ' + title)

    def finish_native_open(self, window, title):
        # GTK may first select the location typed with Ctrl+L. Activate only
        # that same still-visible dialog so a racing close cannot type into a doc.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            probe = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '^' + title + '$'], capture_output=True, text=True, timeout=3)
            if window not in probe.stdout.split():
                return False
            time.sleep(.1)
        self.native_screenshot(self.fmt + '-native-open-selected')
        self.command('xdotool', 'key', '--window', window, 'Return')
        return True

    def command_button(self, command, tab):
        self.tab(tab)
        selector = '.ribbon__toolbar [data-command="' + command + '"]'
        self.wait("const e=document.querySelector(arguments[0]);return !!e&&e.getAttribute('aria-disabled')!=='true'", selector)
        self.click(selector)

    def korean(self, keys, expected):
        self.engine('hangul')
        self.type(keys)
        self.key('End')
        self.text_is(self.fmt, expected)
        self.engine('xkb:us::eng')

    def ime(self):
        previous = None
        for fmt in self.args.formats:
            self.fmt = fmt
            path = self.args.out / ('ime.' + fmt)
            self.new(fmt, path)
            self.ready(fmt, path.name)
            self.editor()
            self.record('native New format / correct engine / initial focus', self.status(fmt)['paragraphText'] == '' and self.d.js("return document.activeElement.classList.contains('rhwp-input')"), self.sessions())
            self.engine('xkb:us::eng'); self.type('EN ')
            self.text_is(fmt, 'EN ')
            self.engine('hangul'); self.type('gk')
            self.wait("return document.querySelector(arguments[0])?.dataset.composing==='true'", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-status]')
            self.snap('preedit')
            before = sha(path)
            self.key('ctrl+s'); time.sleep(.3)
            state = self.status(fmt)
            if state['composing'] == 'false':
                result = self.d.js("return {...document.querySelector(arguments[0]).dataset}", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-save-result]')
                if result['state'] in ('saving', 'checking'):
                    self.wait("return ['saved','failed'].includes(document.querySelector(arguments[0])?.dataset.state)", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-save-result]', timeout=60)
                    result = self.d.js("return {...document.querySelector(arguments[0]).dataset}", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-save-result]')
                state = self.status(fmt)
                published = sha(path) != before and result['state'] == 'saved' and state['dirty'] == 'false'
                blocked = sha(path) == before and state['dirty'] == 'true' and result['state'] != 'saved'
                self.record('Ctrl+S finalizes preedit and either publishes or safely leaves dirty bytes unchanged', state['paragraphText'] == 'EN 하' and (published or blocked), {'save': result, 'editor': state, 'published': published, 'safelyBlocked': blocked})
                self.key('BackSpace')
                self.type('gksrmf dlqfur')
            else:
                self.record('save during real preedit safely blocked', sha(path) == before and state['dirty'] == 'true', state)
                self.type('srmf dlqfur')
            self.key('End')
            self.text_is(fmt, 'EN 한글 입력')
            self.record('IBus multi-syllable continuous input and commit', True, self.status(fmt))
            self.engine('xkb:us::eng'); self.type(' EN')
            self.text_is(fmt, 'EN 한글 입력 EN')
            self.engine('hangul'); self.type('gks'); self.key('BackSpace', 'End')
            self.text_is(fmt, 'EN 한글 입력 EN하')
            self.record('Backspace updates composition once', True, self.status(fmt))
            self.type('r'); self.key('BackSpace'); time.sleep(.2)
            self.key('End')
            self.text_is(fmt, 'EN 한글 입력 EN하')
            self.record('Backspace cancels one-jamo preedit without deleting committed text', True)
            self.type('gk'); self.key('Return')
            self.text_is(fmt, '')
            self.type('gk'); self.key('Left', 'End')
            self.text_is(fmt, '하')
            self.record('Enter and caret movement during composition', True, self.status(fmt))
            self.engine('xkb:us::eng')
            self.tab('삽입')
            self.type('R')
            self.text_is(fmt, '하R')
            self.record('editor to ribbon and restored editor focus', True)
            self.command_button('insert.table', '삽입')
            self.wait("return !!document.querySelector('[data-testid=command-input-dialog]')")
            self.key('Escape')
            self.wait("return !document.querySelector('[data-testid=command-input-dialog]')")
            self.type('M'); self.text_is(fmt, '하RM')
            self.record('modal cancellation restores input focus', True)
            external = subprocess.Popen([sys.executable, str(ROOT / 'scripts/tests/x11-clipboard-owner.py'), 'phase5 external window', '0', 'map'], stdout=subprocess.PIPE, text=True)
            try:
                identity = json.loads(external.stdout.readline())
                self.command('xdotool', 'windowfocus', '--sync', str(identity['owner']))
                self.command('xdotool', 'windowfocus', '--sync', self.window)
                self.type('F'); self.text_is(fmt, '하RMF')
                self.record('external X11 window focus roundtrip', True, identity)
            finally:
                external.terminate(); external.wait(timeout=5)
            if previous:
                others = {s['sessionId']: (s['revision'], s['dirty']) for s in self.sessions() if s['displayName'] == previous}
                self.engine('hangul'); self.type('gk')
                self.select(previous); time.sleep(.2)
                after = {s['sessionId']: (s['revision'], s['dirty']) for s in self.sessions() if s['displayName'] == previous}
                self.record('tab switch during preedit does not modify recipient document', after == others, {'before': others, 'after': after})
                self.select(path.name)
                self.engine('xkb:us::eng')
                self.type('T')
            else:
                self.type('T')
            self.key('Return')
            self.command_button('paragraph.bullets', '홈')
            self.type('List ')
            self.korean('gksrmf', 'List 한글')
            self.record('real IBus around supported bullets', self.d.js("return document.querySelector('.ribbon__toolbar [data-command=\"paragraph.bullets\"]')?.getAttribute('aria-pressed')") == 'true', self.status(fmt))
            self.key('Return', 'Return')
            # Test table-cell IBus using the actual ribbon dialog.
            self.command_button('insert.table', '삽입')
            self.wait("return !!document.querySelector('[data-testid=command-input-dialog]')")
            self.key('Return')
            self.wait("return !document.querySelector('[data-testid=command-input-dialog]')")
            self.korean('tpf', '셀')
            self.record('IBus inside newly inserted table cell', True, self.status(fmt))
            self.key('Tab'); self.type('Cell2')
            self.text_is(fmt, 'Cell2')
            self.record('table cell keyboard navigation', True, self.status(fmt))
            saved = self.save(fmt)
            self.record('save after committed composition', saved['state'] == 'saved', saved)
            self.snap('committed')
            previous = path.name
        events = self.d.js('return window.__phase5Events')
        (self.args.out / 'trusted-input-trace.json').write_text(json.dumps(events, ensure_ascii=False, indent=2))
        self.record('real IBus trusted composition lifecycle observed', all(any(e['type'] == t and e['trusted'] for e in events) for t in ['compositionstart', 'compositionupdate', 'compositionend']))
        for fmt in self.args.formats:
            self.fmt = fmt; self.select('ime.' + fmt); self.close('ime.' + fmt)
        self.record('close committed documents without stale events', not self.sessions())
        self.fmt = self.args.formats[0]
        self.open_native(self.fmt, self.args.out / ('ime.' + self.fmt))
        self.record('native open after closing composition owners', len(self.sessions()) == 1 and not self.sessions()[0]['dirty'], self.sessions())
        self.close('ime.' + self.fmt)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--stage', choices=['5-2'], required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--app', type=Path, default=ROOT / 'src-tauri/target/debug/geul')
    p.add_argument('--driver', default='/tmp/geul-tauri-driver-target/debug/tauri-driver')
    p.add_argument('--port', type=int, default=4592)
    p.add_argument('--formats', nargs='+', choices=['docx', 'hwpx', 'hwp'], default=['docx', 'hwpx', 'hwp'])
    args = p.parse_args()
    args.out = args.out.resolve()
    args.out.relative_to(ROOT / 'target')
    args.out.mkdir(parents=True, exist_ok=False)
    args.xdotool, args.ibus = 'xdotool', 'ibus'
    smoke.APP = str(args.app.resolve()); smoke.DRIVER_LOG = args.out / 'driver.log'
    report = {'status': 'RUNNING', 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__), 'checks': [],
              'environment': {k: os.environ.get(k) for k in ['DISPLAY', 'GTK_IM_MODULE', 'XMODIFIERS', 'IBUS_ADDRESS']}}
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, "return !!document.querySelector('.document-bar')", timeout=60)
                a = Acceptance(args, d, report)
                a.ime()
            except Exception:
                report['failureDom'] = d.js("return {focus:document.activeElement?.outerHTML,status:[...document.querySelectorAll('[data-testid$=status]')].map(e=>({...e.dataset})),notice:document.querySelector('footer.statusbar')?.textContent,events:window.__phase5Events?.slice(-50)}")
                d.screenshot(args.out / 'failure.png')
                raise
            finally:
                smoke.end_session(d)
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='BLOCKED' if isinstance(error, EnvironmentBlocked) else 'FAIL', error=str(error), traceback=traceback.format_exc())
        traceback.print_exc()
    finally:
        report['teardown'] = smoke.TEARDOWN
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return 0 if report['status'] == 'PASS' else 2 if report['status'] == 'BLOCKED' else 1


if __name__ == '__main__':
    sys.exit(main())
