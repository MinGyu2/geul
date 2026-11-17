#!/usr/bin/env python3
"""Stage 2 Phase 2 native GUI acceptance in the production Tauri app; run inside native-ibus-session.py.

For HWP and HWPX:
1. Open a document whose 2x2 table holds outer0..outer3, move into cell A1 with the keyboard.
2. Split the ordinary cell through the ribbon (Hangul tools > Split cell) and the shared dimension
   dialog (1 row x 2 columns), after an out-of-range value is refused in the dialog.
3. Confirm the geometry in the app (Tab stops at the 5th cell), Undo (back to 4 cells), Redo (5 cells).
4. Type into the new sub-cell, save normally (Ctrl+S, real T009 + durable publication), close,
   independently reopen the published file with the Release WASM oracle and check grid + texts.
HWP rich-content table (formula =SUM(A1:A2), ClickHere field, caption):
5. Corrected Stage 2 Phase 2 edit: a paragraph break inside cell A3 of the field table (previously
   refused by T009 at save), save normally, reopen independently: fields keep id/command/name,
   caption and every other cell are unchanged.
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

ENGINE_JS = r"""
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
const release = JSON.parse(fs.readFileSync(path.join(root, 'public/rhwp/RELEASE.json'), 'utf8'));
const folder = path.join(root, 'public/rhwp/generations', release.generation);
const engine = require(path.join(folder, 'rhwp.js'));
engine.initSync({ module: fs.readFileSync(path.join(folder, 'rhwp_bg.wasm')) });
"""

FIXTURE_JS = ENGINE_JS + r"""
const [format, kind, out] = process.argv.slice(2);
const NORMAL = { textWrap: 'TopAndBottom', horzRelTo: 'Column', outerLeft: 283, outerRight: 283, outerTop: 283, outerBottom: 283 };
const d = engine.HwpDocument.createEmpty();
try {
  d.createBlankDocument();
  d.insertText(0, 0, 0, 'Before');
  d.splitParagraph(0, 0, 6);
  const rich = kind === 'rich';
  const t = JSON.parse(d.createTable(0, 1, 0, rich ? 3 : 2, 2));
  d.setTableProperties(0, t.paraIdx, t.controlIdx, JSON.stringify(format === 'hwp' ? NORMAL : { textWrap: 'TopAndBottom' }));
  const texts = rich ? ['1', '', '2', '', '', ''] : ['outer0', 'outer1', 'outer2', 'outer3'];
  texts.forEach((v, i) => v && d.insertTextInCell(0, t.paraIdx, t.controlIdx, i, 0, 0, v));
  if (rich) {
    if (!JSON.parse(d.insertTableFormulaField(0, t.paraIdx, t.controlIdx, 2, 1, '=SUM(A1:A2)')).ok) throw new Error('formula');
    if (!JSON.parse(d.insertClickHereFieldInCell(0, t.paraIdx, t.controlIdx, 1, 0, 0, false, 'guide', 'memo', 'nm', true)).ok) throw new Error('clickhere');
    d.setTableProperties(0, t.paraIdx, t.controlIdx, JSON.stringify({ hasCaption: true }));
    d.insertTextInCellByPath(0, t.paraIdx, JSON.stringify([{ controlIndex: t.controlIdx, cellIndex: 65534, cellParaIndex: 0 }]), 0, 'Cap');
  }
  const e = format === 'hwp' ? d.exportHwpWithReport() : d.exportHwpxWithReport();
  fs.writeFileSync(out, e.takeBytes()); e.free();
} finally { d.free(); }
"""

ORACLE_JS = ENGINE_JS + r"""
const doc = new engine.HwpDocument(new Uint8Array(fs.readFileSync(process.argv[2])));
try {
  const t = JSON.parse(doc.getControls()).find(c => c.ctrlId === 'tbl' && c.list === 0);
  const dims = JSON.parse(doc.getTableDimensions(0, t.para, t.controlIndex));
  const cells = [];
  for (let i = 0; i < dims.cellCount; i++) {
    const info = JSON.parse(doc.getCellInfo(0, t.para, t.controlIndex, i));
    const paras = [];
    for (let p = 0, n = doc.getCellParagraphCount(0, t.para, t.controlIndex, i); p < n; p++)
      paras.push(doc.getTextInCell(0, t.para, t.controlIndex, i, p, 0, doc.getCellParagraphLength(0, t.para, t.controlIndex, i, p)));
    cells.push([info.row, info.col, info.rowSpan, info.colSpan, paras.join('|')]);
  }
  const fields = JSON.parse(doc.getFieldList()).map(f => [f.fieldId, f.fieldType, f.command, f.name ?? null]).sort();
  const caption = doc.getTableCaptionByPath(0, t.para, JSON.stringify([{ controlIndex: t.controlIndex, cellIndex: 0, cellParaIndex: 0 }]));
  console.log(JSON.stringify({ generation: release.generation, rows: dims.rowCount, cols: dims.colCount, cells, fields, caption }));
} finally { doc.free(); }
"""


def node(script, *args):
    return subprocess.check_output(['node', '-e', script, str(ROOT), *map(str, args)], cwd=ROOT, text=True)


def oracle(path):
    return json.loads(node(ORACLE_JS, path))


def cmd_state(d, command):
    return d.js("""const b=document.querySelector(`[data-command="${arguments[0]}"]`);
                   return b?{disabled:!!b.disabled||b.getAttribute('aria-disabled')==='true',title:b.title||''}:null""", command)


def click(d, command):
    if not d.js("""const b=document.querySelector(`[data-command="${arguments[0]}"]`);
                   if(!b||b.disabled||b.getAttribute('aria-disabled')==='true')return false;b.click();return true""", command):
        raise smoke.Failure(f'ribbon command unavailable: {command}: {cmd_state(d, command)}')


def caret(a):
    return a.status('hwp').get('caret', '')


def cell_of(a):
    at = caret(a)
    return int(at.split('@')[1].split('/')[1]) if '@' in at else None


def last_cell_by_tab(a, f):
    """Tab through the table from the current cell and return the last reachable cell index."""
    f.focus_window(); f.focus_editor()
    previous = cell_of(a)
    for _ in range(12):
        a.key('Tab'); time.sleep(.2)
        now = cell_of(a)
        if now == previous:
            return now
        previous = now
    return previous


def go_to_cell(a, f, index):
    f.focus_window(); f.focus_editor()
    for _ in range(12):
        now = cell_of(a)
        if now == index:
            return
        a.key('shift+Tab' if now is not None and now > index else 'Tab'); time.sleep(.2)
    raise smoke.Failure(f'cannot reach cell {index}: {caret(a)}')


def split_dialog(a, d, rows, cols):
    click(d, 'table.splitCell')
    a.wait('return document.querySelector(\'[data-command="table.splitCell"][role="dialog"]\')!==null')
    d.js("""const r=document.querySelector('[data-testid="command-input-rows"]'),c=document.querySelector('[data-testid="command-input-cols"]');
            const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
            set.call(r,arguments[0]);r.dispatchEvent(new Event('input',{bubbles:true}));
            set.call(c,arguments[1]);c.dispatchEvent(new Event('input',{bubbles:true}));
            document.querySelector('[data-testid="command-input-confirm"]').click();""", str(rows), str(cols))


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
    files = {}
    for fmt in ('hwp', 'hwpx'):
        files[fmt] = docs / f'split.{fmt}'
        node(FIXTURE_JS, fmt, 'plain', files[fmt])
    files['rich'] = docs / 'rich.hwp'
    node(FIXTURE_JS, 'hwp', 'rich', files['rich'])
    before = {k: oracle(p) for k, p in files.items()}
    report = {
        'status': 'RUNNING', 'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
        'fixtures': {k: sha(p) for k, p in files.items()}, 'before': before,
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
            for fmt in ('hwp', 'hwpx'):
                path = files[fmt]
                a.open_native(fmt, path)
                f.tab('ribbon.tab.hangulTools')
                f.focus_window(); f.focus_editor(); a.engine('xkb:us::eng')
                a.key('ctrl+Home'); a.key('Down')
                a.wait("return (document.querySelector('[data-testid=rhwp-status]')?.dataset.caret||'').includes('@')")
                go_to_cell(a, f, 0)
                # HWP structural edits wait for the original preflight; the command enables when proven.
                a.wait('const b=document.querySelector(\'[data-command="table.splitCell"]\');return b&&!b.disabled&&b.getAttribute("aria-disabled")!=="true"', timeout=60)
                cells_before = last_cell_by_tab(a, f)
                go_to_cell(a, f, 0)
                # Out-of-range rows stay in the dialog with an error, nothing changes.
                click(d, 'table.splitCell')
                a.wait('return document.querySelector(\'[data-command="table.splitCell"][role="dialog"]\')!==null')
                init = d.js("return {rows:document.querySelector('[data-testid=\"command-input-rows\"]').value,cols:document.querySelector('[data-testid=\"command-input-cols\"]').value}")
                d.js("""const r=document.querySelector('[data-testid="command-input-rows"]');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
                        set.call(r,'0');r.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-testid="command-input-confirm"]').click();""")
                a.wait('return document.querySelector(\'[data-testid="command-input-error"]\')!==null')
                d.js("document.querySelector('[data-testid=\"command-input-dialog\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
                a.wait('return document.querySelector(\'[data-command="table.splitCell"][role="dialog"]\')===null')
                revision0 = int(a.status(fmt)['revision'])
                split_dialog(a, d, 1, 2)
                a.wait("return Number(document.querySelector('[data-testid=rhwp-status]')?.dataset.revision)>arguments[0]", revision0)
                assert cell_of(a) == 0, caret(a)
                cells_split = last_cell_by_tab(a, f)
                f.focus_window(); f.focus_editor(); a.key('ctrl+z'); time.sleep(.5)
                go_to_cell(a, f, 0); cells_undo = last_cell_by_tab(a, f)
                f.focus_window(); f.focus_editor(); a.key('ctrl+y'); time.sleep(.5)
                go_to_cell(a, f, 0); cells_redo = last_cell_by_tab(a, f)
                go_to_cell(a, f, 1)
                f.focus_window(); f.focus_editor(); a.type('NEW'); time.sleep(.5)
                save = a.save(fmt)
                assert rhwp.close_tab(d, path.name)
                after = oracle(path)
                report[fmt] = {'dialogInit': init, 'lastCell': {'before': cells_before, 'split': cells_split, 'undo': cells_undo, 'redo': cells_redo},
                               'save': save, 'after': after, 'savedSha256': sha(path)}
                assert (cells_before, cells_split, cells_undo, cells_redo) == (3, 4, 3, 4), report[fmt]['lastCell']
                assert (after['rows'], after['cols']) == (2, 3), after
                assert after['cells'] == [[0, 0, 1, 1, 'outer0'], [0, 1, 1, 1, 'NEW'], [0, 2, 1, 1, 'outer1'],
                                          [1, 0, 1, 2, 'outer2'], [1, 2, 1, 1, 'outer3']], after['cells']
                # Reopen the published file in the app as well.
                a.open_native(fmt, path)
                f.focus_window(); f.focus_editor(); a.key('ctrl+Home'); a.key('Down')
                a.wait("return (document.querySelector('[data-testid=rhwp-status]')?.dataset.caret||'').includes('@')")
                go_to_cell(a, f, 0)
                report[fmt]['appReopenLastCell'] = last_cell_by_tab(a, f)
                assert report[fmt]['appReopenLastCell'] == 4
                assert rhwp.close_tab(d, path.name)

            # Rich HWP: Enter inside A3 of the formula/ClickHere/caption table (corrected T009 path).
            path = files['rich']
            a.open_native('hwp', path)
            f.tab('ribbon.tab.hangulTools')
            f.focus_window(); f.focus_editor(); a.engine('xkb:us::eng')
            a.key('ctrl+Home'); a.key('Down')
            a.wait("return (document.querySelector('[data-testid=rhwp-status]')?.dataset.caret||'').includes('@')")
            go_to_cell(a, f, 4)
            a.type('X'); time.sleep(.3); a.key('Return'); time.sleep(.3); a.type('Y'); time.sleep(.5)
            report['rich'] = {'save': a.save('hwp')}
            assert rhwp.close_tab(d, path.name)
            d.quit(); d = None

        rich = oracle(files['rich'])
        report['rich'].update(after=rich, savedSha256=sha(files['rich']))
        b = before['rich']
        assert rich['fields'] == b['fields'] and len(rich['fields']) == 2, (rich['fields'], b['fields'])
        assert rich['caption'] == b['caption'], rich['caption']
        expected = [c if i != 4 else [*c[:4], 'X|Y'] for i, c in enumerate(b['cells'])]
        assert rich['cells'] == expected, (rich['cells'], expected)
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='FAIL', error=str(error), trace=traceback.format_exc())
        if d is not None:
            try:
                report['failureDom'] = d.js("return {notice:document.querySelector('footer.statusbar')?.textContent, status:{...document.querySelector('[data-testid=rhwp-status]')?.dataset}, save:{...document.querySelector('[data-testid=rhwp-save-result]')?.dataset}}")
                d.screenshot(args.out / 'failure.png')
            finally:
                d.quit(); d = None
    finally:
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
