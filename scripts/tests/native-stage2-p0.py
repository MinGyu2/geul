#!/usr/bin/env python3
"""Stage 2 Phase 0 native GUI acceptance in the production Tauri app; run inside native-ibus-session.py.

1. Open an HWPX fixture with the original failing split-run secPr-handoff paragraph, a multi-run
   paragraph, and a 1x2 table whose first cell contains a split-run paragraph.
2. Select characters inside the split-run paragraph (and crossing an existing run boundary), apply
   superscript through the UI ribbon, and confirm the visual canvas change.
3. Move into the table cell's split-run paragraph, select across its run boundary, and apply
   superscript through the UI ribbon.
4. Save normally (Ctrl+S), close the tab, reopen the saved file in the real app, verify the UI
   formatting state, and verify text + per-character formatting + cell isolation via an independent
   fresh Release-WASM oracle.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('font_native_helpers', ROOT / 'scripts/tests/native-font-acceptance.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
smoke, base, rhwp, sha = helpers.smoke, helpers.base, helpers.rhwp, helpers.sha

CREATE_FIXTURE_JS = r"""
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const out = process.argv[2];
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json'), 'utf8'));
const folder = path.join(root, 'public/rhwp/generations', release.generation);
const engine = require(path.join(folder, 'rhwp.js'));
engine.initSync({ module: fs.readFileSync(path.join(folder, 'rhwp_bg.wasm')) });
const d = engine.HwpDocument.createEmpty();
try {
  d.createBlankDocument();
  const p0 = '한글 Font editing ABC 0123';
  d.insertText(0, 0, 0, p0);
  const fid = d.findOrCreateFontId('NanumGothic');
  d.applyCharFormat(0, 0, 0, [...p0].length, JSON.stringify({ fontId: fid }));
  d.splitParagraph(0, 0, [...p0].length);
  d.insertText(0, 1, 0, 'SplitOneSplitTwo');
  d.applyCharFormat(0, 1, 0, 8, JSON.stringify({ bold: true }));
  d.applyCharFormat(0, 1, 8, 16, JSON.stringify({ italic: true }));
  d.splitParagraph(0, 1, 16);
  const tbl = JSON.parse(d.createTable(0, 2, 0, 1, 2));
  d.insertTextInCell(0, tbl.paraIdx, tbl.controlIdx, 0, 0, 0, 'CellACellB');
  d.applyCharFormatInCell(0, tbl.paraIdx, tbl.controlIdx, 0, 0, 0, 5, JSON.stringify({ bold: true }));
  d.applyCharFormatInCell(0, tbl.paraIdx, tbl.controlIdx, 0, 0, 5, 10, JSON.stringify({ textColor: '#0000ff' }));
  d.insertTextInCell(0, tbl.paraIdx, tbl.controlIdx, 1, 0, 0, 'Neighbor');
  const rep = d.exportHwpxWithReport();
  fs.writeFileSync(out, rep.takeBytes());
  rep.free();
} finally { d.free(); }
"""

ORACLE_JS = r"""
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const file = process.argv[2];
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json'), 'utf8'));
const folder = path.join(root, 'public/rhwp/generations', release.generation);
const engine = require(path.join(folder, 'rhwp.js'));
engine.initSync({ module: fs.readFileSync(path.join(folder, 'rhwp_bg.wasm')) });
const doc = new engine.HwpDocument(new Uint8Array(fs.readFileSync(file)));
try {
  const readRun = (n, fn) => Array.from({ length: n }, (_, i) => JSON.parse(fn(i)));
  const body = [0, 1].map(p => {
    const n = doc.getParagraphLength(0, p);
    const chars = readRun(n, i => doc.getCharPropertiesAt(0, p, i));
    return {
      text: doc.getTextRange(0, p, 0, n),
      superscript: chars.map(c => c.superscript === true),
      bold: chars.map(c => c.bold === true),
      italic: chars.map(c => c.italic === true),
    };
  });
  const tbl = JSON.parse(doc.getControls()).find(c => c.ctrlId === 'tbl');
  const cell = idx => {
    const n = doc.getCellParagraphLength(0, tbl.para, tbl.controlIndex, idx, 0);
    const chars = readRun(n, i => doc.getCellCharPropertiesAt(0, tbl.para, tbl.controlIndex, idx, 0, i));
    return {
      text: doc.getTextInCell(0, tbl.para, tbl.controlIndex, idx, 0, 0, n),
      superscript: chars.map(c => c.superscript === true),
      bold: chars.map(c => c.bold === true),
      textColor: chars.map(c => c.textColor),
    };
  };
  console.log(JSON.stringify({ generation: release.generation, body, cells: [cell(0), cell(1)] }));
} finally { doc.free(); }
"""


def click(d, command):
    ok = d.js('const b=document.querySelector(`[data-command="${arguments[0]}"]`);if(!b||b.disabled||b.getAttribute("aria-disabled")==="true")return false;b.click();return true', command)
    if not ok:
        raise smoke.Failure(f'ribbon command unavailable: {command}')


def pressed(d, command):
    return d.js('return document.querySelector(`[data-command="${arguments[0]}"]`)?.getAttribute("aria-pressed")', command)


def canvas_data(d):
    return d.js("return document.querySelector('.editor__scroll canvas')?.toDataURL() ?? null")


def oracle(file_path: Path):
    return json.loads(subprocess.check_output(['node', '-e', ORACLE_JS, str(ROOT), str(file_path)], cwd=ROOT, text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    docs = args.out / 'docs'
    docs.mkdir()
    path = docs / 'stage2-p0.hwpx'
    subprocess.check_call(['node', '-e', CREATE_FIXTURE_JS, str(ROOT), str(path)], cwd=ROOT)
    before = oracle(path)
    report = {
        'status': 'RUNNING',
        'appSha256': sha(args.app),
        'harnessSha256': sha(__file__),
        'fixtureSha256': sha(path),
        'before': before,
        'wasm': json.loads((ROOT / 'public/rhwp/RELEASE.json').read_text()),
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    }
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
            a.open_native('hwpx', path)
            f.tab('ribbon.tab.home')

            # 1. Paragraph 0 (original P1/F split-run secPr-handoff + NanumGothic run): select "Font" [3..7)
            f.focus_window(); f.focus_editor(); a.engine('xkb:us::eng')
            a.key('Home')
            for _ in range(3):
                a.key('Right')
            for _ in range(4):
                a.key('shift+Right')
            time.sleep(.3)
            canvas_before = canvas_data(d)
            click(d, 'format.superscript')
            a.wait("return document.querySelector('[data-command=\"format.superscript\"]')?.getAttribute('aria-pressed')==='true'")
            time.sleep(.4)
            canvas_after = canvas_data(d)
            assert canvas_before and canvas_after and canvas_before != canvas_after, 'visual canvas did not change after formatting'
            report['visualChangeConfirmed'] = True

            # 2. Paragraph 1 (SplitOneSplitTwo, boundary at 8): select [5..11) "OneSpl"
            f.focus_window(); f.focus_editor()
            a.key('Right')
            a.key('Down')
            a.wait("return (document.querySelector('[data-testid=rhwp-status]')?.dataset.caret||'').startsWith('0:1:')")
            a.key('Home')
            for _ in range(5):
                a.key('Right')
            for _ in range(6):
                a.key('shift+Right')
            time.sleep(.3)
            click(d, 'format.superscript')
            a.wait("return document.querySelector('[data-command=\"format.superscript\"]')?.getAttribute('aria-pressed')==='true'")

            # 3. Table Cell 0 (CellACellB, boundary at 5): Down into cell, select [3..7) "lACe"
            f.focus_window(); f.focus_editor()
            a.key('Right')
            a.key('Down')
            a.wait("return (document.querySelector('[data-testid=rhwp-status]')?.dataset.caret||'').includes('@0/0/0')")
            a.key('Home')
            for _ in range(3):
                a.key('Right')
            for _ in range(4):
                a.key('shift+Right')
            time.sleep(.3)
            click(d, 'format.superscript')
            a.wait("return document.querySelector('[data-command=\"format.superscript\"]')?.getAttribute('aria-pressed')==='true'")

            # 4. Save normally, close tab, reopen in app, check reopened UI state
            f.focus_window(); f.focus_editor()
            report['save'] = a.save('hwpx')
            assert rhwp.close_tab(d, path.name)
            a.open_native('hwpx', path)
            f.focus_window(); f.focus_editor(); a.key('Home')
            for _ in range(4):
                a.key('Right')
            a.wait("return document.querySelector('[data-command=\"format.superscript\"]')?.getAttribute('aria-pressed')==='true'")
            report['reopenUiSuperscriptPressed'] = pressed(d, 'format.superscript')
            d.screenshot(args.out / 'reopened.png')
            assert rhwp.close_tab(d, path.name)
            d.quit(); d = None

        after = oracle(path)
        report['after'] = after
        report['savedSha256'] = sha(path)
        p0, p1 = after['body']
        assert p0['text'] == '한글 Font editing ABC 0123', p0
        assert p0['superscript'] == [3 <= i < 7 for i in range(len(p0['text']))], p0
        assert p1['text'] == 'SplitOneSplitTwo', p1
        assert p1['superscript'] == [5 <= i < 11 for i in range(len(p1['text']))], p1
        assert p1['bold'] == [i < 8 for i in range(len(p1['text']))], p1
        assert p1['italic'] == [i >= 8 for i in range(len(p1['text']))], p1
        c0, c1 = after['cells']
        assert c0['text'] == 'CellACellB', c0
        assert c0['superscript'] == [3 <= i < 7 for i in range(len(c0['text']))], c0
        assert c0['bold'] == [i < 5 for i in range(len(c0['text']))], c0
        assert c0['textColor'] == ['#000000' if i < 5 else '#0000ff' for i in range(len(c0['text']))], c0
        assert c1 == before['cells'][1], (c1, before['cells'][1])
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), trace=traceback.format_exc())
        if d is not None:
            try:
                report['failureDom'] = d.js("return {notice:document.querySelector('footer.statusbar')?.textContent, status:document.querySelector('[data-testid=rhwp-status]')?.dataset}")
                d.screenshot(args.out / 'failure.png')
            finally:
                d.quit(); d = None
    finally:
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'error': report.get('error'), 'visualChangeConfirmed': report.get('visualChangeConfirmed')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
