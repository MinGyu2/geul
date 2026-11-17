#!/usr/bin/env python3
"""Compact native Linux GUI acceptance for Stage 2 / Phase 1 DOCX table structure editing.

Runs against the production `geul` binary inside `scripts/tests/native-ibus-session.py`:
1. Opens a real WordCraft-generated DOCX (`basic-ko.docx`) via the native GTK file chooser.
2. Verifies all ten `table.*` commands appear on the DOCX Layout ribbon tab and are disabled outside tables.
3. Enters the 2x2 table via real keyboard navigation and verifies live capability states.
4. Drives InsertRowAbove/Below, InsertColumnLeft/Right, DeleteRow/Column, MergeRight/Below, SplitCell,
   multi-cell keyboard selection + MergeCells, Undo/Redo, and Hangul IME typing in an edited cell.
5. Saves via real Ctrl+S (T009 publication), closes and independently reopens in the app, and verifies
   the saved OOXML ZIP (`word/document.xml`) independently with Python `xml.etree.ElementTree`.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('font_native_helpers', ROOT / 'scripts/tests/native-font-acceptance.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
smoke, base, rhwp, sha = helpers.smoke, helpers.base, helpers.rhwp, helpers.sha

ALL_TEN = [
    'table.insertRowAbove',
    'table.insertRowBelow',
    'table.insertColumnLeft',
    'table.insertColumnRight',
    'table.deleteRow',
    'table.deleteColumn',
    'table.mergeRight',
    'table.mergeBelow',
    'table.mergeCells',
    'table.splitCell',
]
W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def wtag(local):
    return f'{{{W_NS}}}{local}'


def cmd_state(d, command):
    return d.js(
        """const b = document.querySelector(`[data-command="${arguments[0]}"]`);
           return b ? { disabled: !!b.disabled || b.getAttribute("aria-disabled") === "true",
                        title: b.title || "" } : null;""",
        command,
    )


def click_cmd(d, command):
    ok = d.js(
        """const b = document.querySelector(`[data-command="${arguments[0]}"]`);
           if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
           b.click();
           return true;""",
        command,
    )
    if not ok:
        raise smoke.Failure(f'ribbon command unavailable: {command}')


def fast_view(f, meta):
    return f.invoke('docx_view', {'sessionId': meta['sessionId'], 'loadGeneration': meta['loadGeneration']})['view']


def wait_view(f, meta, pred, message, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fast_view(f, meta)
        if pred(last):
            return last
        time.sleep(0.3)
    raise smoke.Failure(f'{message}; last view={last!r}')


def inspect_docx_xml(path: Path):
    with zipfile.ZipFile(path) as z:
        xml_bytes = z.read('word/document.xml')
    root = ET.fromstring(xml_bytes)
    body = root.find(wtag('body'))
    assert body is not None
    paras = [''.join(t.text or '' for t in p.iter(wtag('t'))) for p in body.findall(wtag('p'))]
    tables = []
    for tbl in body.findall(wtag('tbl')):
        grid = [col.attrib.get(wtag('w')) for col in tbl.findall(f'./{wtag("tblGrid")}/{wtag("gridCol")}')]
        rows = []
        for tr in tbl.findall(wtag('tr')):
            row_cells = []
            for tc in tr.findall(wtag('tc')):
                tc_pr = tc.find(wtag('tcPr'))
                gs = tc_pr.find(wtag('gridSpan')) if tc_pr is not None else None
                vm = tc_pr.find(wtag('vMerge')) if tc_pr is not None else None
                texts = [''.join(t.text or '' for t in p.iter(wtag('t'))) for p in tc.findall(wtag('p'))]
                row_cells.append({
                    'span': int(gs.attrib.get(wtag('val'), '1')) if gs is not None else 1,
                    'vMerge': (vm.attrib.get(wtag('val'), 'continue') if vm is not None else None),
                    'texts': texts,
                })
            rows.append(row_cells)
        tables.append({'gridCols': len(grid), 'grid': grid, 'rows': rows})
    return {'paragraphs': paras, 'tables': tables}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('--app', '--out', '--fixture'):
        parser.add_argument(name, type=Path, required=True)
    parser.add_argument('--driver', required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--port', type=int, default=4444)
    args = parser.parse_args()
    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=False)
    docs = out_dir / 'docs'
    docs.mkdir()
    doc_path = docs / 'table-stage2-p1.docx'
    shutil.copyfile(args.fixture.resolve(), doc_path)

    report = {
        'status': 'RUNNING',
        'appSha256': sha(args.app),
        'harnessSha256': sha(__file__),
        'fixtureSha256': sha(doc_path),
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    }
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = out_dir / 'driver.log'
    d = None
    with smoke.tauri_driver(args.driver, args.port, str(out_dir / 'data')) as start:
        try:
            d = start()
            a = base.Acceptance(args, d, report)
            a.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            f = helpers.Fonts(a, d, report)
            f.focus_window()

            # 1. Open basic-ko.docx
            name = doc_path.name
            before_xml = inspect_docx_xml(doc_path)
            a.open_native('docx', doc_path)
            meta = f.session(name)
            assert meta is not None, 'session missing after open'
            f.tab('ribbon.tab.layout')
            a.wait("return document.querySelector('[data-command=\"table.insertRowAbove\"]')!==null")

            # Outside table: all ten buttons present and disabled
            outside_states = {cmd: cmd_state(d, cmd) for cmd in ALL_TEN}
            assert all(s and s['disabled'] for s in outside_states.values()), outside_states
            report['outsideStates'] = outside_states

            # 2. Navigate from paragraph 0 -> paragraph 1 (Down) -> end of paragraph 1 (End) -> cell (0,0) (Right)
            # Note: fixed WordCraft skips tables vertically on Down from left margin (body:1:0 -> body:3:0);
            # document-order Right from body:1 end enters cell (0,0) directly (wordcraft_poc.py locate_first_cell).
            nav_trace = []
            f.focus_window()
            f.focus_editor()
            a.engine('xkb:us::eng')
            start_v = fast_view(f, meta)
            nav_trace.append(('start', start_v.get('caretKey'), start_v.get('inTable')))
            a.key('Down'); time.sleep(0.35)
            nav_trace.append(('Down', fast_view(f, meta).get('caretKey'), fast_view(f, meta).get('inTable')))
            a.key('End'); time.sleep(0.35)
            nav_trace.append(('End', fast_view(f, meta).get('caretKey'), fast_view(f, meta).get('inTable')))
            a.key('Right'); time.sleep(0.35)
            after_enter = fast_view(f, meta)
            nav_trace.append(('Right', after_enter.get('caretKey'), after_enter.get('inTable')))
            report['navTrace'] = nav_trace
            v0 = wait_view(f, meta, lambda v: v.get('inTable') and v.get('table') and v['table']['row'] == 0 and v['table']['col'] == 0,
                           f'expected caret in (0,0); trace={nav_trace!r}')
            assert v0['table']['rows'] == 2 and v0['table']['cols'] == 2, v0['table']

            inside_states = {cmd: cmd_state(d, cmd) for cmd in ALL_TEN}
            for cmd in ('table.insertRowAbove', 'table.insertRowBelow',
                        'table.insertColumnLeft', 'table.insertColumnRight',
                        'table.deleteRow', 'table.deleteColumn',
                        'table.mergeRight', 'table.mergeBelow'):
                assert inside_states[cmd] and not inside_states[cmd]['disabled'], (cmd, inside_states[cmd])
            assert inside_states['table.mergeCells']['disabled'], inside_states['table.mergeCells']
            assert inside_states['table.splitCell']['disabled'], inside_states['table.splitCell']
            report['insideStates'] = inside_states

            # 3. Row/column inserts & deletes + Undo/Redo
            click_cmd(d, 'table.insertRowAbove')
            wait_view(f, meta, lambda v: v['table']['rows'] == 3, 'insertRowAbove failed')
            click_cmd(d, 'table.insertRowBelow')
            wait_view(f, meta, lambda v: v['table']['rows'] == 4, 'insertRowBelow failed')
            click_cmd(d, 'table.insertColumnLeft')
            wait_view(f, meta, lambda v: v['table']['cols'] == 3, 'insertColumnLeft failed')
            click_cmd(d, 'table.insertColumnRight')
            wait_view(f, meta, lambda v: v['table']['cols'] == 4, 'insertColumnRight failed')
            click_cmd(d, 'table.deleteColumn')
            wait_view(f, meta, lambda v: v['table']['cols'] == 3, 'deleteColumn failed')
            click_cmd(d, 'table.deleteRow')
            wait_view(f, meta, lambda v: v['table']['rows'] == 3, 'deleteRow failed')

            f.focus_window(); f.focus_editor()
            a.key('ctrl+z')
            wait_view(f, meta, lambda v: v['table']['rows'] == 4, 'Undo deleteRow failed')
            a.key('ctrl+y')
            wait_view(f, meta, lambda v: v['table']['rows'] == 3, 'Redo deleteRow failed')

            # Undo all 6 table structure edits back to original 2x2
            for _ in range(6):
                f.focus_window(); f.focus_editor(); a.key('ctrl+z'); time.sleep(0.25)
            wait_view(f, meta, lambda v: v['table']['rows'] == 2 and v['table']['cols'] == 2,
                      'expected Undo back to 2x2')

            # Navigate to (0, 0) ("셀 하나")
            for _ in range(4):
                v = fast_view(f, meta)
                if v['table']['row'] == 0 and v['table']['col'] == 0:
                    break
                a.key('shift+ISO_Left_Tab'); time.sleep(0.25)
            wait_view(f, meta, lambda v: v['table']['row'] == 0 and v['table']['col'] == 0, 'return to (0,0)')

            # Merge Right (0,0)+(0,1) -> colSpan==2, then Split Cell -> colSpan==1
            click_cmd(d, 'table.mergeRight')
            wait_view(f, meta, lambda v: v['table']['colSpan'] == 2, 'mergeRight failed')
            assert not cmd_state(d, 'table.splitCell')['disabled']
            click_cmd(d, 'table.splitCell')
            wait_view(f, meta, lambda v: v['table']['colSpan'] == 1, 'splitCell after mergeRight failed')

            # Merge Below (0,0)+(1,0) -> rowSpan==2, then Split Cell -> rowSpan==1
            click_cmd(d, 'table.mergeBelow')
            wait_view(f, meta, lambda v: v['table']['rowSpan'] == 2, 'mergeBelow failed')
            assert not cmd_state(d, 'table.splitCell')['disabled']
            click_cmd(d, 'table.splitCell')
            wait_view(f, meta, lambda v: v['table']['rowSpan'] == 1, 'splitCell after mergeBelow failed')

            # Multi-cell keyboard selection (Shift+Down across cell paragraphs into row 1) -> MergeCells -> SplitCell
            f.focus_window(); f.focus_editor()
            for _ in range(10):
                if fast_view(f, meta)['table']['selectedCells'] >= 2:
                    break
                a.key('shift+Down')
                time.sleep(0.3)
            sel_view = wait_view(f, meta, lambda v: v['table']['selectedCells'] >= 2 and v['table']['mergeCells'] is None,
                                 'multi-cell Shift selection did not enable mergeCells')
            report['multiCellSelection'] = sel_view['table']
            click_cmd(d, 'table.mergeCells')
            merged_view = wait_view(f, meta, lambda v: v['table']['rowSpan'] >= 2 or v['table']['colSpan'] >= 2,
                                    'mergeCells failed')
            report['afterMergeCells'] = merged_view['table']
            click_cmd(d, 'table.splitCell')
            wait_view(f, meta, lambda v: v['table']['rowSpan'] == 1 and v['table']['colSpan'] == 1,
                      'splitCell after mergeCells failed')

            # Insert a final row below and type Korean text via ibus-hangul in cell
            click_cmd(d, 'table.insertRowBelow')
            wait_view(f, meta, lambda v: v['table']['rows'] == 3, 'final insertRowBelow failed')
            a.engine('hangul')
            time.sleep(0.4)
            f.focus_window(); f.focus_editor()
            time.sleep(0.2)
            a.type('gksrmf')
            a.key('End')
            time.sleep(0.3)
            a.engine('xkb:us::eng')
            time.sleep(0.5)

            # 4. Real Ctrl+S save (T009 publication)
            f.focus_window(); f.focus_editor()
            report['save'] = a.save('docx')
            after_xml = inspect_docx_xml(doc_path)
            report['beforeXml'] = before_xml
            report['afterXml'] = after_xml
            report['outputSha256'] = sha(doc_path)

            assert after_xml['paragraphs'] == before_xml['paragraphs'], (before_xml['paragraphs'], after_xml['paragraphs'])
            assert len(after_xml['tables']) == 1 and len(after_xml['tables'][0]['rows']) == 3, after_xml['tables']
            joined_cells = '\n'.join('\n'.join(c['texts']) for row in after_xml['tables'][0]['rows'] for c in row)
            for expected in ('셀 하나', 'Cell two', '셋째 칸', 'Fourth', '한글'):
                assert expected in joined_cells, (expected, joined_cells)

            # 5. Close tab and independently reopen in app
            assert rhwp.close_tab(d, name)
            a.open_native('docx', doc_path)
            meta2 = f.session(name)
            assert meta2 is not None
            f.tab('ribbon.tab.layout')
            f.focus_window(); f.focus_editor()
            a.key('Down'); time.sleep(0.3)
            a.key('End'); time.sleep(0.3)
            a.key('Right'); time.sleep(0.3)
            reopened_tbl = wait_view(f, meta2, lambda v: v.get('table') is not None, 'reopened table entry failed')
            assert reopened_tbl['table']['rows'] == 3 and reopened_tbl['table']['cols'] == 2, reopened_tbl['table']
            report['reopenedTable'] = reopened_tbl['table']

            d.screenshot(out_dir / 'final.png')
            d.quit(); d = None
            report['status'] = 'PASS'
        except Exception as error:
            report['status'] = 'FAIL'
            report['error'] = str(error)
            report['traceback'] = traceback.format_exc()
            if d:
                try:
                    report['notice'] = d.js("return document.querySelector('footer.statusbar')?.textContent")
                    d.screenshot(out_dir / 'failure.png')
                finally:
                    try:
                        d.quit()
                    except Exception:
                        pass
    report['teardown'] = smoke.TEARDOWN
    (out_dir / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    print(json.dumps({'status': report['status'], 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
