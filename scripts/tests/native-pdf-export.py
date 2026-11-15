#!/usr/bin/env python3
"""Stage 5-A S5-4 Linux acceptance: PDF export from the normal production app.

Real Tauri Release app, ribbon command `file.exportPdf`, native GTK chooser (typed destination), actual backend
writer/publication. For each fixture: open, export, then record the source SHA-256 before/after, the backend session
record before/after (revision, dirty, state) and the status notice. Negative cases: chooser cancel, a document with
asynchronously painted content (refused, nothing written) and an unwritable destination directory. The produced
PDFs are inspected afterwards, independently of geul, by pdf-export-inspect.mjs. Run inside native-ibus-session.py:

  python3 scripts/tests/native-ibus-session.py --out OUT-session -- python3 scripts/tests/native-pdf-export.py \\
    --app ABS/src-tauri/target/release/geul --driver tauri-driver --xdotool @XDOTOOL@ --ibus @IBUS@ \\
    --fixtures target/stage5a/fixtures --out OUT
No product test hooks; documents and PDFs stay in ignored target/ directories.
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
import tauri_smoke as smoke
import rhwp_poc as rhwp

spec = importlib.util.spec_from_file_location('production_native_base', ROOT / 'scripts/tests/native-new-document.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

KO = json.loads((ROOT / 'src/language/ko.json').read_text())
TITLE = KO['document.pdfTitle']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


POSITIVE = [('docx', 'rich-ko.docx'), ('hwp', 'hongbo.hwp'), ('hwpx', 'edu-2022.hwpx'), ('hwp', 'landscape.hwp')]


def run(args, d, report):
    a = base.Acceptance(args, d, report)
    work = args.out / 'docs'
    work.mkdir()
    pdfs = args.out / 'pdf'
    pdfs.mkdir()

    def notice():
        return d.js("return document.querySelector('footer.statusbar')?.textContent ?? ''")

    def session(name):
        for s in a.sessions():
            if s['displayName'] == name:
                return {k: s[k] for k in ('revision', 'dirty', 'state', 'loadGeneration', 'format')}
        return None

    def acknowledge():
        """Retained (failure) notices queue; acknowledge them so the next outcome is the one displayed."""
        for _ in range(10):
            if not d.js('const b=[...document.querySelectorAll("footer.statusbar button")].find(e=>e.textContent.trim()===arguments[0]);if(b){b.click();return true}return false', KO['status.acknowledgeNotice']):
                return
            time.sleep(.2)

    def export(name, destination, expect):
        """Click the ribbon command, type the destination in the native chooser, wait for the outcome notice."""
        acknowledge()
        d.js('for(const b of document.querySelectorAll("[role=tab]"))if(b.textContent.trim()===arguments[0])b.click()', KO['ribbon.tab.file'])
        a.wait('const b=document.querySelector(\'[data-command="file.exportPdf"]\');return !!b && b.getAttribute("aria-disabled")!=="true"')
        before = notice()
        d.js('document.querySelector(\'[data-command="file.exportPdf"]\').click()')
        if destination is None:
            # Cancel: the dialog must appear, then Escape closes it without exporting.
            a.engine('xkb:us::eng')
            deadline = time.monotonic() + 15
            window = ''
            while time.monotonic() < deadline and not window:
                probe = subprocess.run([args.xdotool, 'search', '--onlyvisible', '--name', '^' + TITLE + '$'], capture_output=True, text=True)
                window = probe.stdout.split()[-1] if probe.returncode == 0 and probe.stdout.strip() else ''
                time.sleep(.1)
            assert window, 'PDF chooser not visible'
            a.command(args.xdotool, 'windowfocus', '--sync', window)
            a.key('Escape')
            a.wait('return !document.querySelector(\'[data-command="file.exportPdf"]\').closest("[aria-disabled=true]")')
            time.sleep(1.0)
            return notice(), before
        a.chooser(destination, TITLE)
        a.wait('return arguments[0].some(t=>(document.querySelector("footer.statusbar")?.textContent??"").includes(t))', expect, timeout=180)
        return notice(), before

    for fmt, name in POSITIVE:
        src = work / name
        shutil.copyfile(args.fixtures / name, src)
        digest = sha(src)
        a.open(fmt, src)
        info = session(name)
        target = pdfs / (src.stem + '.pdf')
        started = time.monotonic()
        text, _ = export(name, target, [KO['document.pdfExported'].split(':')[0]])
        elapsed = time.monotonic() - started
        after = session(name)
        row = {'format': fmt, 'source': str(src), 'sourceSha256': digest, 'sourceAfterSha256': sha(src), 'session': info,
               'sessionAfter': after, 'pdf': str(target), 'pdfSha256': sha(target) if target.exists() else None,
               'pdfBytes': target.stat().st_size if target.exists() else 0, 'notice': text, 'seconds': round(elapsed, 2)}
        row['status'] = 'PASS' if target.exists() and row['sourceAfterSha256'] == digest and after == info and not after['dirty'] else 'FAIL'
        report['positive'].append(row)
        assert row['status'] == 'PASS', row
        assert rhwp.close_tab(d, name)

    # Negative 1: cancel writes nothing.
    src = work / 'cancel.docx'
    shutil.copyfile(args.fixtures / 'rich-ko.docx', src)
    a.open('docx', src)
    listing = sorted(p.name for p in pdfs.iterdir())
    text, before = export('cancel.docx', None, [])
    report['negative'].append({'case': 'cancel', 'pdfsBefore': listing, 'pdfsAfter': sorted(p.name for p in pdfs.iterdir()),
                               'noticeChanged': text != before, 'notice': text,
                               'status': 'PASS' if listing == sorted(p.name for p in pdfs.iterdir()) else 'FAIL'})
    assert report['negative'][-1]['status'] == 'PASS', report['negative'][-1]

    # Negative 2: unwritable destination directory -> failure notice, no file, source unchanged.
    locked = args.out / 'locked'
    locked.mkdir()
    os.chmod(locked, 0o555)
    target = locked / 'out.pdf'
    try:
        text, _ = export('cancel.docx', target, [KO['document.pdfFailed'][:12], KO['document.pdfConflict'][:12], KO['document.pdfInvalid'][:12]])
    finally:
        os.chmod(locked, 0o755)
    report['negative'].append({'case': 'unwritable-directory', 'exists': target.exists(), 'leftovers': sorted(p.name for p in locked.iterdir()),
                               'notice': text, 'status': 'PASS' if not target.exists() and not any(locked.iterdir()) else 'FAIL'})
    assert report['negative'][-1]['status'] == 'PASS', report['negative'][-1]
    assert rhwp.close_tab(d, 'cancel.docx')

    # Negative 3: asynchronously painted content is refused before anything is written.
    src = work / 'bitmap.hwp'
    shutil.copyfile(args.fixtures / 'bitmap.hwp', src)
    digest = sha(src)
    a.open('hwp', src)
    target = pdfs / 'bitmap.pdf'
    text, _ = export('bitmap.hwp', target, [KO['document.pdf.unavailable.asyncContent'][:20]])
    report['negative'].append({'case': 'async-content', 'exists': target.exists(), 'sourceUnchanged': sha(src) == digest,
                               'notice': text, 'status': 'PASS' if not target.exists() and sha(src) == digest else 'FAIL'})
    assert report['negative'][-1]['status'] == 'PASS', report['negative'][-1]
    assert rhwp.close_tab(d, 'bitmap.hwp')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    args.fixtures = args.fixtures.resolve()
    report = {'status': 'RUNNING', 'positive': [], 'negative': [],
              'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src', 'src-tauri'], cwd=ROOT)).hexdigest(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'fixtures': {p.name: sha(p) for p in sorted(args.fixtures.iterdir()) if p.is_file() and p.name != 'SHA256SUMS'}}
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / 'driver.log'
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / 'data')) as start:
            d = start()
            test = base.Acceptance(args, d, report)
            test.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            window = test.command(args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
            test.command(args.xdotool, 'windowfocus', '--sync', window)
            identity = test.async_js("return await (await fetch('/rhwp/BUILD.json')).json()")
            assert identity['ok'], identity
            report['rhwpIdentity'] = identity['value']
            try:
                run(args, d, report)
            except Exception:
                try:
                    report['failureNotice'] = d.js("return document.querySelector('footer.statusbar')?.textContent")
                    d.screenshot(args.out / 'failure.png')
                finally:
                    d.quit()
                    d = None
                raise
            d.quit()
            d = None
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), trace=traceback.format_exc())
        if d:
            try:
                d.quit()
            except Exception as cleanup:
                report['cleanupError'] = str(cleanup)
    finally:
        report['teardown'] = smoke.TEARDOWN
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'positive': [(r['format'], r['status']) for r in report['positive']],
                      'negative': [(r['case'], r['status']) for r in report['negative']], 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
