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
import binascii
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile
import zlib

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
    with zipfile.ZipFile(path) as z:
        media = sorted(n for n in z.namelist() if n.startswith('word/media/'))
    return {'paragraphs': paras, 'tables': tables, 'media': media}


def make_png(w: int, h: int, rgba: tuple[int, int, int, int]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', binascii.crc32(tag + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(rgba) * w for _ in range(h))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def inline_drawing(rid: str, docpr_id: int, filename: str, cx: int = 19050, cy: int = 19050) -> str:
    return (
        f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
        f'<wp:docPr id="{docpr_id}" name="Picture {docpr_id}" descr=""/><wp:cNvGraphicFramePr/>'
        f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="{filename}" descr=""/><pic:cNvPicPr>'
        f'<a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
        f'</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )


def build_extra_fixtures(base_docx: Path, docs_dir: Path) -> tuple[Path, Path]:
    vmerge_path = docs_dir / 'vmerge-stage2.docx'
    img_path = docs_dir / 'img-table-stage2.docx'
    with zipfile.ZipFile(base_docx, 'r') as zin:
        items = {n: zin.read(n) for n in zin.namelist()}

    # 1. Vertical merge with nonempty continuation ("셀 하나" Restart in row 0 + "셋째 칸" Continue in row 1)
    doc_xml = items['word/document.xml'].decode('utf-8')
    v_xml = doc_xml.replace(
        '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">셀 하나</w:t>',
        '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">셀 하나</w:t>',
        1,
    ).replace(
        '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">셋째 칸</w:t>',
        '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/><w:vMerge/></w:tcPr><w:p><w:r><w:t xml:space="preserve">셋째 칸</w:t>',
        1,
    )
    assert v_xml != doc_xml
    with zipfile.ZipFile(vmerge_path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for k, v in items.items():
            zout.writestr(k, v_xml.encode('utf-8') if k == 'word/document.xml' else v)

    # 2. Image in table row 0 col 1 (image1.png / rId1, removed on DeleteRow) + body paragraph image (image2.png / rId2, preserved)
    ct_xml = items['[Content_Types].xml'].decode('utf-8').replace(
        '<Override PartName="/word/document.xml"',
        '<Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml"',
        1,
    )
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
        '</Relationships>\n'
    )
    i_xml = doc_xml.replace(
        '<w:t xml:space="preserve">Cell two</w:t></w:r></w:p>',
        '<w:t xml:space="preserve">Cell two</w:t></w:r>' + inline_drawing('rId1', 1, 'image1.png') + '</w:p>',
        1,
    ).replace(
        '<w:t xml:space="preserve">표 다음 문단 End.</w:t></w:r></w:p>',
        '<w:t xml:space="preserve">표 다음 문단 End.</w:t></w:r>' + inline_drawing('rId2', 2, 'image2.png') + '</w:p>',
        1,
    )
    assert i_xml != doc_xml and ct_xml != items['[Content_Types].xml'].decode('utf-8')
    with zipfile.ZipFile(img_path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for k, v in items.items():
            if k == '[Content_Types].xml':
                zout.writestr(k, ct_xml.encode('utf-8'))
            elif k == 'word/_rels/document.xml.rels':
                zout.writestr(k, rels_xml.encode('utf-8'))
            elif k == 'word/document.xml':
                zout.writestr(k, i_xml.encode('utf-8'))
            else:
                zout.writestr(k, v)
        zout.writestr('word/media/image1.png', make_png(2, 2, (220, 20, 20, 255)))
        zout.writestr('word/media/image2.png', make_png(2, 2, (20, 20, 220, 255)))
    return vmerge_path, img_path


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
            assert inside_states['table.splitCell'] and not inside_states['table.splitCell']['disabled'], inside_states['table.splitCell']
            assert v0['table']['maxSplitRows'] >= 2 and v0['table']['maxSplitColumns'] >= 2, v0['table']
            report['insideStates'] = inside_states

            # 2b. Group A: Unmerged 1x1 cell split via real UI CommandInputDialog (invalid guard, 1x3 horizontal, 2x1 vertical, Undo back to 2x2)
            click_cmd(d, 'table.splitCell')
            a.wait('return document.querySelector(\'[data-command="table.splitCell"][role="dialog"]\')!==null')
            dlg_init = d.js("""const r = document.querySelector('[data-testid="command-input-rows"]');
                               const c = document.querySelector('[data-testid="command-input-cols"]');
                               return { rows: r?.value, cols: c?.value };""")
            assert dlg_init == {'rows': '1', 'cols': '2'}, dlg_init
            # Invalid out-of-bounds value stays in dialog with error alert
            d.js("""const r = document.querySelector('[data-testid="command-input-rows"]');
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(r, '99'); r.dispatchEvent(new Event('input', {bubbles:true}));
                    document.querySelector('[data-testid="command-input-confirm"]').click();""")
            a.wait('return document.querySelector(\'[data-testid="command-input-error"]\')!==null')
            # Valid 1x3 split
            d.js("""const r = document.querySelector('[data-testid="command-input-rows"]');
                    const c = document.querySelector('[data-testid="command-input-cols"]');
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(r, '1'); r.dispatchEvent(new Event('input', {bubbles:true}));
                    setter.call(c, '3'); c.dispatchEvent(new Event('input', {bubbles:true}));
                    document.querySelector('[data-testid="command-input-confirm"]').click();""")
            split_1x3 = wait_view(f, meta, lambda v: v['table']['cols'] == 4, 'unmerged 1x3 splitCell failed')
            assert split_1x3['table']['rows'] == 2, split_1x3['table']
            # Split (0,0) vertically 2x1 too
            click_cmd(d, 'table.splitCell')
            a.wait('return document.querySelector(\'[data-command="table.splitCell"][role="dialog"]\')!==null')
            d.js("""const r = document.querySelector('[data-testid="command-input-rows"]');
                    const c = document.querySelector('[data-testid="command-input-cols"]');
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(r, '2'); r.dispatchEvent(new Event('input', {bubbles:true}));
                    setter.call(c, '1'); c.dispatchEvent(new Event('input', {bubbles:true}));
                    document.querySelector('[data-testid="command-input-confirm"]').click();""")
            split_2x1 = wait_view(f, meta, lambda v: v['table']['rows'] == 3 and v['table']['cols'] == 4, 'unmerged 2x1 splitCell failed')
            report['unmergedSplit'] = {'split1x3': split_1x3['table'], 'split2x1': split_2x1['table']}
            for _ in range(2):
                f.focus_window(); f.focus_editor(); a.key('ctrl+z'); time.sleep(0.25)
            wait_view(f, meta, lambda v: v['table']['rows'] == 2 and v['table']['cols'] == 2, 'Undo unmerged splits back to 2x2 failed')

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
            assert rhwp.close_tab(d, name)

            # 6. Group B & C in the same GUI session: nonempty vMerge continuation preservation + image table row delete T009 save
            vmerge_path, img_path = build_extra_fixtures(args.fixture.resolve(), docs)
            # 6a. Group B: open vmerge-stage2.docx, enter row 0, delete row 0, Ctrl+S save, close & reopen, verify both "셀 하나" and "셋째 칸" survived
            a.open_native('docx', vmerge_path)
            meta_vm = f.session(vmerge_path.name)
            assert meta_vm is not None
            f.tab('ribbon.tab.layout')
            f.focus_window(); f.focus_editor()
            a.key('Down'); time.sleep(0.3); a.key('End'); time.sleep(0.3); a.key('Right'); time.sleep(0.3)
            wait_view(f, meta_vm, lambda v: v.get('inTable') and v['table']['row'] == 0, 'vmerge table entry failed')
            click_cmd(d, 'table.deleteRow')
            wait_view(f, meta_vm, lambda v: v['table']['rows'] == 1, 'vmerge deleteRow failed')
            report['vmergeSave'] = a.save('docx')
            assert rhwp.close_tab(d, vmerge_path.name)
            a.open_native('docx', vmerge_path)
            assert f.session(vmerge_path.name) is not None
            vmerge_xml = inspect_docx_xml(vmerge_path)
            vmerge_texts = '\n'.join('\n'.join(c['texts']) for r in vmerge_xml['tables'][0]['rows'] for c in r)
            assert '셀 하나' in vmerge_texts and '셋째 칸' in vmerge_texts, vmerge_texts
            report['vmergeAfterTexts'] = vmerge_texts
            assert rhwp.close_tab(d, vmerge_path.name)

            # 6b. Group C: open img-table-stage2.docx, enter table row 0, delete row 0 (containing image2.png), Ctrl+S save, close & reopen, verify body image1.png kept & image2.png removed cleanly
            a.open_native('docx', img_path)
            meta_im = f.session(img_path.name)
            assert meta_im is not None
            f.tab('ribbon.tab.layout')
            f.focus_window(); f.focus_editor()
            a.key('Down'); time.sleep(0.3); a.key('End'); time.sleep(0.3); a.key('Right'); time.sleep(0.3)
            wait_view(f, meta_im, lambda v: v.get('inTable') and v['table']['row'] == 0, 'img table entry failed')
            click_cmd(d, 'table.deleteRow')
            wait_view(f, meta_im, lambda v: v['table']['rows'] == 1, 'img deleteRow failed')
            report['imgTableSave'] = a.save('docx')
            assert rhwp.close_tab(d, img_path.name)
            a.open_native('docx', img_path)
            assert f.session(img_path.name) is not None
            img_xml = inspect_docx_xml(img_path)
            assert len(img_xml['media']) == 1, img_xml['media']
            assert len(img_xml['tables'][0]['rows']) == 1, img_xml['tables']
            img_texts = '\n'.join('\n'.join(c['texts']) for r in img_xml['tables'][0]['rows'] for c in r)
            assert '셋째 칸' in img_texts and 'Fourth' in img_texts, img_texts
            report['imgTableAfter'] = {'media': img_xml['media'], 'paragraphs': img_xml['paragraphs'], 'texts': img_texts}

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
