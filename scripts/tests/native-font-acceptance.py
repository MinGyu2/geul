#!/usr/bin/env python3
"""Stage 5-A font package: focused native acceptance on Linux (normal production frontend, real Tauri app).

Real app, ribbon font picker, native GTK chooser, X11 keyboard (xdotool), actual backend font system. Two app runs share one
private XDG_DATA_HOME, so the second run is a restart of the first:

  run 1  catalog from the active fontconfig configuration -> register a TTF and a WOFF2 user font through the chooser ->
         DOCX A: first line (Korean + English) set in a fontconfig-discovered Korean system font, save, PDF export ->
         DOCX B: first line set in the registered user font (Latin only; Hangul keeps its East Asian font), save, PDF ->
         HWP and HWPX: the picker shows the stored font; a font change is refused (no document change), PDF export.
  run 2  user fonts reloaded from the private folder -> reopen DOCX B, the font is still applied -> remove the WOFF2 font
         (catalog and stored file gone).

The saved DOCX files and PDFs are inspected afterwards, independently of geul, by font-acceptance-inspect.py /
font-pdf-inspect.mjs. Run inside native-ibus-session.py:

  python3 scripts/tests/native-ibus-session.py --out OUT-session -- python3 scripts/tests/native-font-acceptance.py \\
    --app ABS/src-tauri/target/debug/geul --driver tauri-driver --xdotool @XDOTOOL@ --ibus @IBUS@ \\
    --fixtures target/stage5a/fixtures --out OUT
No product test hooks. Documents, fonts and PDFs stay in the ignored output directory.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
for folder in ('tests/e2e', 'tests/integration/rhwp'):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp

spec = importlib.util.spec_from_file_location('production_native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

KO = json.loads((ROOT / 'src/language/ko.json').read_text())
USER_TTF_FAMILY = 'GeulMono Test1'
USER_PS_NAME = 'GeulMonoTest1'
WOFF2_SOURCE = ROOT / 'external/rhwp/assets/fonts/SourceHanSerifK-OldHangul-subset.woff2'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def renamed_mono(target: Path):
    """The bundled OFL JetBrains Mono renamed (equal byte length) so it cannot collide with an installed font."""
    data = bytearray((ROOT / 'external/wordcraft/assets/fonts/JetBrainsMono-Regular.ttf').read_bytes())
    # Family names and the PostScript name (so the PDF BaseFont names the user font, not its OFL source).
    for old, new in [('JetBrains Mono'.encode('utf-16-be'), USER_TTF_FAMILY.encode('utf-16-be')),
                     (b'JetBrains Mono', USER_TTF_FAMILY.encode()),
                     ('JetBrainsMono'.encode('utf-16-be'), USER_PS_NAME.encode('utf-16-be')),
                     (b'JetBrainsMono', USER_PS_NAME.encode())]:
        assert len(old) == len(new)
        at = data.find(old)
        while at >= 0:
            data[at:at + len(new)] = new
            at = data.find(old, at + len(new))
    target.write_bytes(bytes(data))


class Fonts:
    def __init__(self, a, d, report):
        self.a, self.d, self.report = a, d, report

    def invoke(self, command, args=None):
        result = self.a.async_js("return await window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1] ?? {})", command, args)
        if not result.get('ok'):
            raise smoke.Failure(f'{command} failed: {result!r}')
        return result['value']

    def catalog(self):
        return self.invoke('font_catalog')

    def notice(self):
        return self.d.js("return document.querySelector('footer.statusbar')?.textContent ?? ''")

    def acknowledge(self):
        for _ in range(10):
            if not self.d.js('const b=[...document.querySelectorAll("footer.statusbar button")].find(e=>e.textContent.trim()===arguments[0]);if(b){b.click();return true}return false', KO['status.acknowledgeNotice']):
                return
            time.sleep(.2)

    def tab(self, key):
        self.d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()===arguments[0])b.click()', KO[key])

    def open_picker(self):
        self.tab('ribbon.tab.home')
        self.a.wait("return document.querySelector('.font-picker__input')!==null")
        self.d.js("document.querySelector('.font-picker__input').focus()")
        self.a.engine('xkb:us::eng')
        self.a.key('Down')
        self.a.wait("return document.querySelector('.font-picker [role=listbox]')!==null")

    def picker_button(self, label):
        self.open_picker()
        clicked = self.d.js('const b=[...document.querySelectorAll(".font-picker__action")].find(e=>e.textContent.trim()===arguments[0]||e.getAttribute("aria-label")===arguments[0]);if(!b||b.disabled)return false;b.click();return true', label)
        if not clicked:
            raise smoke.Failure(f'font picker action missing: {label}')

    def register(self, path: Path, expect_family):
        self.acknowledge()
        before = len(self.catalog()['userFonts'])
        self.picker_button(KO['font.add'])
        # xdotool --name is a regular expression: the title's parentheses must be literal.
        window = self.a.chooser(path, re.sub(r'([()\[\].*+?^$|{}\\])', r'\\\1', KO['font.addTitle']))
        self.activate_again(window)
        # The outcome is the backend catalog growing (a status notice from an earlier registration may still show).
        deadline = time.monotonic() + 30
        catalog = self.catalog()
        while len(catalog['userFonts']) == before and time.monotonic() < deadline:
            time.sleep(.3)
            catalog = self.catalog()
        time.sleep(.5)
        added = [u for u in catalog['userFonts'] if expect_family(u)]
        row = {'file': path.name, 'sha256': sha(path), 'notice': self.notice(), 'userFontsBefore': before,
               'userFontsAfter': len(catalog['userFonts']), 'registered': added,
               'inFamilies': [f for f in catalog['families'] if f['source'] == 'user' and expect_family({'families': [f['family']]})]}
        row['status'] = 'PASS' if added and all(u['persisted'] for u in added) and row['inFamilies'] and all(f['renderable'] for f in row['inFamilies']) else 'FAIL'
        self.report['registration'].append(row)
        if row['status'] != 'PASS':
            raise smoke.Failure(f'registration failed: {row!r}')
        return added[0]

    def activate_again(self, window):
        """GTK resolves a typed location asynchronously; if it only selected the file, activate that same dialog
        once more (by its XID, so a racing close cannot send Return to the editor) — as native-new-document.py does."""
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if subprocess.run([self.a.args.xdotool, 'getwindowname', window], capture_output=True, text=True).returncode != 0:
                return False
            time.sleep(.1)
        self.a.command(self.a.args.xdotool, 'key', '--window', window, 'Return')
        return True

    def choose(self, query, family):
        """Type a query in the picker and press Enter: the first match must be `family`."""
        self.tab('ribbon.tab.home')
        self.d.js("document.querySelector('.font-picker__input').focus()")
        self.a.engine('xkb:us::eng')
        self.a.key('ctrl+a')
        self.a.type(query)
        self.a.wait("return document.querySelector('.font-picker [role=option]')!==null")
        first = self.d.js("return document.querySelector('.font-picker [role=option]')?.dataset.fontId")
        if not first or not first.endswith(':' + family.lower()):
            raise smoke.Failure(f'first option {first!r} is not {family!r}')
        self.a.key('Return')

    def current_font(self):
        return self.d.js("return document.querySelector('.font-picker__input')?.dataset.fontCurrent ?? null")

    def picker_title(self):
        return self.d.js("return document.querySelector('.font-picker__input')?.title ?? null")

    def session(self, name):
        for s in self.a.sessions():
            if s['displayName'] == name:
                return s
        return None

    def docx_view(self, name):
        s = self.session(name)
        state = self.invoke('docx_view', {'sessionId': s['sessionId'], 'loadGeneration': s['loadGeneration']})
        return state['view']

    def focus_editor(self):
        self.d.js("document.querySelector('.editor__scroll textarea.rhwp-input')?.focus()")

    def focus_window(self):
        window = self.a.command(self.a.args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
        self.a.command(self.a.args.xdotool, 'windowfocus', '--sync', window)

    def select_all(self, name, docx=True):
        """Select the first line with native keys (Home, Shift+End: the surfaces navigate by line); in the fixtures it
        is mixed Korean/English text. For DOCX the backend view must then hold a non-collapsed selection."""
        for _ in range(3):
            self.focus_window()
            self.focus_editor()
            self.a.engine('xkb:us::eng')
            self.a.key('Home', 'shift+End')
            time.sleep(.8)
            if not docx or not self.docx_view(name)['collapsed']:
                return
        raise smoke.Failure(f'selection did not reach {name}')

    def export_pdf(self, name, destination: Path):
        if destination.exists():
            raise smoke.Failure(f'PDF destination already exists: {destination.name}')
        self.acknowledge()
        self.tab('ribbon.tab.file')
        self.a.wait('const b=document.querySelector(\'[data-command="file.exportPdf"]\');return !!b && b.getAttribute("aria-disabled")!=="true"', timeout=60)
        self.d.js('document.querySelector(\'[data-command="file.exportPdf"]\').click()')
        self.activate_again(self.a.chooser(destination, KO['document.pdfTitle']))
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and not destination.exists():
            time.sleep(.3)
        if not destination.exists():  # (a destination is never reused: names are unique per document)
            raise smoke.Failure(f'PDF not written: {destination.name}')
        time.sleep(1)
        return {'pdf': destination.name, 'sha256': sha(destination), 'bytes': destination.stat().st_size, 'notice': self.notice()}


def run_first(args, d, report, docs, pdfs, fonts_src):
    a = base.Acceptance(args, d, report)
    f = Fonts(a, d, report)
    catalog = f.catalog()
    status = catalog['status']
    system = [x for x in catalog['families'] if x['source'] == 'system' and x['available']]
    generics = {g['generic']: g['family'] for g in catalog['generics']}
    korean = next((x for x in system if any(l['lang'].startswith('ko') for l in x['localized']) and 'Myeongjo' in x['family'] and ' ' not in x['family']), None) \
        or next((x for x in system if any(l['lang'].startswith('ko') for l in x['localized'])), None)
    report['discovery'] = {'status': status, 'systemFamilies': len(system), 'generics': generics,
                           'sampleSystemFamilies': [x['family'] for x in system[:12]], 'koreanSystemFamily': korean,
                           'unrenderableSystemFamilies': [x['family'] for x in system if not x['renderable']]}
    ok = status['provider'] == 'fontconfig' and status['fontconfigAvailable'] and status['systemFaces'] > 0 and korean \
        and all(generics.get(g) for g in ('sans-serif', 'serif', 'monospace')) and not report['discovery']['unrenderableSystemFamilies']
    report['discovery']['status_'] = 'PASS' if ok else 'FAIL'
    if not ok:
        raise smoke.Failure(f'discovery failed: {report["discovery"]!r}')

    ttf = fonts_src / 'GeulMonoTest1.ttf'
    renamed_mono(ttf)
    woff2 = fonts_src / WOFF2_SOURCE.name
    shutil.copyfile(WOFF2_SOURCE, woff2)
    f.register(ttf, lambda u: USER_TTF_FAMILY in u['families'])
    woff2_font = f.register(woff2, lambda u: any('Source Han' in fam or 'Old Hangul' in fam or 'Hangul' in fam for fam in u['families']))
    report['woff2Family'] = woff2_font['families'][0]

    for name, query, family in [('font-system.docx', korean['family'], korean['family']), ('font-user.docx', USER_TTF_FAMILY, USER_TTF_FAMILY)]:
        path = docs / name
        a.open('docx', path)
        before = f.docx_view(name)
        f.select_all(name)
        f.choose(query, family)
        a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", family, timeout=30)
        after = f.docx_view(name)
        width = lambda v: round(sum(r['width'] for r in v['selection']), 2)
        row = {'document': name, 'family': family, 'pickerCurrent': f.current_font(), 'viewFont': after['font'] if 'font' in after else after['format'].get('font'),
               'pagesBefore': len(before['pages']), 'pagesAfter': len(after['pages']),
               'selectionWidthBeforeApply': None, 'selectionWidthAfter': width(after), 'revision': f.session(name)['revision']}
        # The same selection laid out in the previous font: compare via native Undo / Redo.
        f.focus_window()
        f.focus_editor()
        a.key('ctrl+z')
        a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent!==arguments[0]", family, timeout=30)
        row['selectionWidthBeforeApply'] = width(f.docx_view(name))
        a.key('ctrl+y')
        a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", family, timeout=30)
        f.focus_window()
        f.focus_editor()
        row['layoutChanged'] = row['selectionWidthBeforeApply'] != row['selectionWidthAfter']
        row['save'] = a.save('docx')
        row['savedSha256'] = sha(path)
        row['export'] = f.export_pdf(name, pdfs / (Path(name).stem + '.pdf'))
        assert rhwp.close_tab(d, name)
        row['status'] = 'PASS' if row['pickerCurrent'] == family and row['layoutChanged'] and row['revision'] >= 1 else 'FAIL'
        report['docx'].append(row)
        if row['status'] != 'PASS':
            raise smoke.Failure(f'DOCX font change failed: {row!r}')

    for fmt, name in [('hwp', 'font.hwp'), ('hwpx', 'font.hwpx')]:
        path = docs / name
        source = sha(path)
        a.open(fmt, path)
        f.select_all(name, docx=False)
        f.tab('ribbon.tab.home')
        a.wait("return !!document.querySelector('.font-picker__input')?.dataset.fontCurrent", timeout=30)
        shown = f.current_font()
        title = f.picker_title()
        before = f.session(name)
        f.acknowledge()
        f.choose(korean['family'], korean['family'])
        time.sleep(1)
        after = f.session(name)
        row = {'format': fmt, 'document': name, 'shownFont': shown, 'pickerTitle': title, 'notice': f.notice(),
               'revisionBefore': before['revision'], 'revisionAfter': after['revision'], 'dirtyAfter': after['dirty'],
               'sourceUnchanged': sha(path) == source}
        row['export'] = f.export_pdf(name, pdfs / (name.replace('.', '-') + '.pdf'))
        assert rhwp.close_tab(d, name)
        refused = KO['command.unavailable.engineUnsupported'].split('{')[0] in row['notice'] or '지원하지 않습니다' in row['notice']
        row['fontChange'] = 'REFUSED' if refused and row['revisionAfter'] == row['revisionBefore'] and not row['dirtyAfter'] else 'UNEXPECTED'
        row['status'] = 'PASS' if shown and row['fontChange'] == 'REFUSED' and row['sourceUnchanged'] else 'FAIL'
        report['rhwp'].append(row)
        if row['status'] != 'PASS':
            raise smoke.Failure(f'RHWP font check failed: {row!r}')


def run_second(args, d, report, docs, data_home: Path):
    a = base.Acceptance(args, d, report)
    f = Fonts(a, d, report)
    catalog = f.catalog()
    users = {fam for u in catalog['userFonts'] for fam in u['families']}
    stored = sorted(p.name for p in data_home.rglob('fonts/*') if p.is_file())
    row = {'userFontsAfterRestart': sorted(users), 'storedFiles': stored, 'skipped': catalog['status']['skippedUserFonts']}
    row['status'] = 'PASS' if USER_TTF_FAMILY in users and report['woff2Family'] in users and not row['skipped'] else 'FAIL'
    report['restart'] = row
    if row['status'] != 'PASS':
        raise smoke.Failure(f'restart persistence failed: {row!r}')
    name = 'font-user.docx'
    a.open('docx', docs / name)
    f.select_all(name)
    a.wait("return document.querySelector('.font-picker__input')?.dataset.fontCurrent===arguments[0]", USER_TTF_FAMILY, timeout=30)
    report['reopen'] = {'document': name, 'pickerCurrent': f.current_font(), 'status': 'PASS'}
    assert rhwp.close_tab(d, name)
    f.acknowledge()
    f.picker_button(KO['font.removeFamily'].replace('{family}', report['woff2Family']))
    a.wait("return document.querySelector('footer.statusbar')?.textContent.includes(arguments[0])", KO['font.removed'].split('{')[0].strip(), timeout=30)
    after = f.catalog()
    remaining = {fam for u in after['userFonts'] for fam in u['families']}
    stored_after = sorted(p.name for p in data_home.rglob('fonts/*') if p.is_file())
    removal = {'removed': report['woff2Family'], 'userFontsAfter': sorted(remaining), 'storedFilesAfter': stored_after,
               'familyListed': any(x['family'] == report['woff2Family'] and x['source'] == 'user' for x in after['families'])}
    removal['status'] = 'PASS' if report['woff2Family'] not in remaining and not removal['familyListed'] and len(stored_after) == len(stored) - 1 else 'FAIL'
    report['removal'] = removal
    if removal['status'] != 'PASS':
        raise smoke.Failure(f'removal failed: {removal!r}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--docx-fixture', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    if not args.out.is_absolute():
        raise SystemExit('--out must be absolute')
    args.out.mkdir(parents=True, exist_ok=False)
    docs, pdfs, fonts_src = args.out / 'docs', args.out / 'pdf', args.out / 'font-files'
    for p in (docs, pdfs, fonts_src):
        p.mkdir()
    # DOCX: the WordCraft-generated basic-ko.docx (src-tauri/examples/wordcraft_fixture.rs), whose save is preservation-safe;
    # HWP/HWPX: the Stage 5-A PDF fixtures (not saved here).
    for src, dst in [(args.docx_fixture, 'font-system.docx'), (args.docx_fixture, 'font-user.docx'),
                     (args.fixtures / 'hongbo.hwp', 'font.hwp'), (args.fixtures / 'edu-2022.hwpx', 'font.hwpx')]:
        shutil.copyfile(src, docs / dst)
    data_home = args.out / 'data'
    report = {'status': 'RUNNING', 'registration': [], 'docx': [], 'rhwp': [],
              'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src', 'src-tauri'], cwd=ROOT)).hexdigest(),
              'fixtures': {p.name: sha(p) for p in sorted(docs.iterdir())},
              'environment': {'display': 'X11/Xvfb', 'input': 'xdotool', 'chooser': 'GTK FileChooserNative'}}
    smoke.APP = str(args.app.resolve())
    teardowns = []
    d = None
    try:
        for phase in ('first', 'second'):
            smoke.DRIVER_LOG = args.out / f'driver-{phase}.log'
            with smoke.tauri_driver(args.driver, args.port, str(data_home)) as start:
                d = start()
                a = base.Acceptance(args, d, report)
                a.wait("return document.querySelector('.document-bar')!==null", timeout=60)
                window = a.command(args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
                a.command(args.xdotool, 'windowfocus', '--sync', window)
                report.setdefault('location', d.js('return location.href'))
                try:
                    if phase == 'first':
                        run_first(args, d, report, docs, pdfs, fonts_src)
                    else:
                        run_second(args, d, report, docs, data_home)
                    d.screenshot(args.out / f'{phase}-final.png')
                    d.quit()
                    d = None
                except Exception:
                    try:
                        report['failureDom'] = d.js("return {notice:document.querySelector('footer.statusbar')?.textContent, focus:document.activeElement?.outerHTML?.slice(0,300)}")
                        d.screenshot(args.out / 'failure.png')
                    finally:
                        d.quit()
                        d = None
                    raise
            teardowns.append(json.loads(json.dumps(smoke.TEARDOWN, default=str)))
            (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), trace=traceback.format_exc())
    finally:
        report['teardown'] = teardowns
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
