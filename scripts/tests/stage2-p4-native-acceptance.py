#!/usr/bin/env python3
"""Stage 2 Phase 4 native GTK/WebKitGTK acceptance across DOCX, HWPX, and HWP.

Run under scripts/tests/native-ibus-session.py:
  python3 scripts/tests/native-ibus-session.py --out /tmp/geul-p4-accept -- \
    python3 scripts/tests/stage2-p4-native-acceptance.py --out /tmp/geul-p4-accept

Verifies in the actual Release Tauri desktop app:
- P4-1: Multi-cell Copy, Paste, Undo, Redo, Cut + Undo, and Bold preservation.
- P4-2: Table cell margins (table default + cell override) & table positioning.
- P4-3: Repeating table headers & row pagination break across save/close/reopen.
- Independent disk verification (DOCX ZIP XML, HWPX ZIP XML, HWP CFB + Release WASM oracle).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for folder in ("tests/e2e", "tests/integration/rhwp"):
    sys.path.insert(0, str(ROOT / folder))

import rhwp_poc
import tauri_smoke as smoke

ND_SPEC = importlib.util.spec_from_file_location("native_new_document", ROOT / "scripts/tests/native-new-document.py")
nd = importlib.util.module_from_spec(ND_SPEC)
ND_SPEC.loader.exec_module(nd)

KO = json.loads((ROOT / "src/language/ko.json").read_text(encoding="utf-8"))

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
HP_NS = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HH_NS = "http://www.hancom.co.kr/hwpml/2011/head"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class P4Acceptance(nd.Acceptance):
    def __init__(self, args, driver, report):
        super().__init__(args, driver, report)
        self.window = ""

    def calibrate_pointer(self):
        self.d.js(
            "window.__p4Ptr=[];for(const t of ['mousemove','mousedown'])"
            "window.addEventListener(t,e=>window.__p4Ptr.push({t,x:e.clientX,y:e.clientY}),true)"
        )
        rhwp_poc.perform(
            self.d,
            [
                {
                    "type": "pointer",
                    "id": "p4_cal",
                    "parameters": {"pointerType": "mouse"},
                    "actions": [{"type": "pointerMove", "x": 100, "y": 100, "origin": "viewport"}],
                }
            ],
        )
        self.wait("return window.__p4Ptr.length>0")
        pt = self.d.js("return window.__p4Ptr.at(-1)")
        self.d.pointer_scale = (100 / pt["x"], 100 / pt["y"])

    def focus_window(self):
        self.window = self.command(self.args.xdotool, "search", "--onlyvisible", "--name", "^geul$").split()[-1]
        self.command(self.args.xdotool, "windowfocus", "--sync", self.window)

    def dom_click(self, selector: str, expr: str = "e"):
        self.wait(
            "const e=document.querySelector(arguments[0]);return e && !e.disabled && e.getAttribute('aria-disabled')!=='true'",
            selector,
        )
        pt = self.d.js(
            f"const e=document.querySelector(arguments[0]);const t={expr};t.scrollIntoView({{block:'nearest'}});"
            "const r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};",
            selector,
        )
        rhwp_poc.click(self.d, pt["x"], pt["y"])

    def select_tab(self, tab_label: str):
        selected = self.d.js(
            "return [...document.querySelectorAll('.ribbon__tab')].find(e=>e.textContent.trim()===arguments[0])?.getAttribute('aria-selected')==='true'",
            tab_label,
        )
        if not selected:
            pt = self.d.js(
                "const t=[...document.querySelectorAll('.ribbon__tab')].find(e=>e.textContent.trim()===arguments[0]);"
                "const r=t.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};",
                tab_label,
            )
            rhwp_poc.click(self.d, pt["x"], pt["y"])
            self.wait(
                "return [...document.querySelectorAll('.ribbon__tab')].find(e=>e.textContent.trim()===arguments[0])?.getAttribute('aria-selected')==='true'",
                tab_label,
            )

    def toolbar_cmd(self, cmd_id: str, tab_label: str):
        self.select_tab(tab_label)
        self.dom_click(f'.ribbon__toolbar [data-command="{cmd_id}"]')

    def settle(self, fmt: str):
        if fmt == "docx":
            self.wait(
                "const s=document.querySelector('[data-testid=docx-status]');"
                "return s && s.dataset.status==='ready' && s.dataset.composing==='false' && s.dataset.pending==='0'",
                timeout=30,
            )
        else:
            self.wait(
                "const s=document.querySelector('[data-testid=rhwp-status]');"
                "return s && s.dataset.status==='ready' && s.dataset.composing==='false' "
                "&& s.dataset.revision===s.dataset.localRevision",
                timeout=30,
            )
        time.sleep(0.15)

    def in_table(self, fmt: str) -> bool:
        st = self.status(fmt)
        if fmt == "docx":
            return st.get("inTable") == "true"
        return "@" in (st.get("caret") or "")

    def caret_rel_point(self) -> dict[str, float]:
        self.wait("return document.querySelector('.rhwp-caret')!==null && document.querySelector('.rhwp-page[data-page=\"0\"]')!==null")
        return self.d.js(
            "const c=document.querySelector('.rhwp-caret').getBoundingClientRect();"
            "const p=document.querySelector('.rhwp-page[data-page=\"0\"]').getBoundingClientRect();"
            "return {dx:c.left-p.left+4,dy:c.top-p.top+c.height/2};"
        )

    def resolve_viewport_pts(self, *rel_pts: dict[str, float]) -> list[dict[str, float]]:
        pts = self.d.js(
            "const s=document.querySelector('.editor__scroll');"
            "const p0=document.querySelector('.rhwp-page[data-page=\"0\"]');"
            "const sr=s.getBoundingClientRect();let pr=p0.getBoundingClientRect();"
            "const rels=arguments[0];"
            "const midDy=rels.reduce((a,b)=>a+b.dy,0)/rels.length;"
            "s.scrollTop += (pr.top+midDy) - (sr.top+sr.height*0.5);"
            "pr=p0.getBoundingClientRect();"
            "return rels.map(r=>({x:pr.left+r.dx,y:pr.top+r.dy}));",
            list(rel_pts),
        )
        return pts

    def click_cell_pt(self, fmt: str, rel_pt: dict[str, float]):
        [vp] = self.resolve_viewport_pts(rel_pt)
        rhwp_poc.click(self.d, vp["x"], vp["y"])
        self.settle(fmt)

    def move_next_cell(self, fmt: str):
        before = self.status(fmt).get("caret")
        self.key("Tab")
        self.wait(
            "const s=document.querySelector(arguments[0]);return s && s.dataset.caret!==arguments[1]",
            f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]',
            before,
        )
        self.settle(fmt)

    def set_input_value(self, testid: str, value: str):
        self.wait("const e=document.querySelector(arguments[0]);return e && !e.disabled", f'[data-testid="{testid}"]')
        self.d.js(
            "const e=document.querySelector(arguments[0]);"
            "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,arguments[1]);"
            "e.dispatchEvent(new Event('input',{bubbles:true}));",
            f'[data-testid="{testid}"]',
            value,
        )

    def set_select_value(self, testid: str, value: str):
        self.wait("const e=document.querySelector(arguments[0]);return e && !e.disabled", f'[data-testid="{testid}"]')
        self.d.js(
            "const e=document.querySelector(arguments[0]);"
            "Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,arguments[1]);"
            "e.dispatchEvent(new Event('change',{bubbles:true}));",
            f'[data-testid="{testid}"]',
            value,
        )

    def run_table_dialog(self, cmd_id: str, tab_label: str, fmt: str, fn):
        self.toolbar_cmd(cmd_id, tab_label)
        self.wait(
            "const d=document.querySelector('[data-testid=table-format-dialog]');"
            "return d && d.dataset.command===arguments[0]",
            cmd_id,
        )
        fn()
        self.dom_click("[data-testid=table-format-confirm]")
        self.wait("return document.querySelector('[data-testid=table-format-dialog]')===null")
        self.settle(fmt)

    def read_table_dialog(self, cmd_id: str, tab_label: str, reader_fn):
        self.toolbar_cmd(cmd_id, tab_label)
        self.wait(
            "const d=document.querySelector('[data-testid=table-format-dialog]');"
            "return d && d.dataset.command===arguments[0]",
            cmd_id,
        )
        data = reader_fn()
        self.key("Escape")
        self.wait("return document.querySelector('[data-testid=table-format-dialog]')===null")
        return data

    def drag_cells(self, fmt: str, rel_from: dict[str, float], rel_to: dict[str, float]):
        p_from, p_to = self.resolve_viewport_pts(rel_from, rel_to)
        sx, sy = getattr(self.d, "pointer_scale", (1, 1))
        rhwp_poc.drag(self.d, (p_from["x"] * sx, p_from["y"] * sy), (p_to["x"] * sx, p_to["y"] * sy))
        self.wait(
            "const s=document.querySelector(arguments[0]);return s && !!s.dataset.selection",
            f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]',
        )
        self.settle(fmt)

    def cell_caret_end_offset(self, fmt: str, rel_pt: dict[str, float]) -> int:
        self.click_cell_pt(fmt, rel_pt)
        self.key("End")
        self.settle(fmt)
        st = self.status(fmt)
        if fmt == "docx":
            return int(st.get("caretOffset") or "0")
        caret = st.get("caret") or ""
        head = caret.split("@", 1)[0]
        return int(head.rsplit(":", 1)[-1])

    def verify_format(self, fmt: str):
        path = self.args.out / f"p4-accept.{fmt}"
        row = {"format": fmt, "status": "RUNNING", "steps": []}
        self.report["formats"].append(row)

        table_tab = KO["ribbon.tab.layout"] if fmt == "docx" else KO["ribbon.tab.hangulTools"]
        insert_tab = KO["ribbon.tab.insert"]
        home_tab = KO["ribbon.tab.home"]

        # 1. Create document and insert a 5x2 table
        self.new(fmt, path)
        self.ready(fmt, path.name)
        self.engine("xkb:us::eng")
        self.toolbar_cmd("insert.table", insert_tab)
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')!==null")
        self.set_input_value("command-input-rows", "5")
        self.set_input_value("command-input-cols", "2")
        self.key("Return")
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')===null")
        self.settle(fmt)
        assert self.in_table(fmt), f"{fmt}: caret not inside inserted 5x2 table"

        # 2. Populate rows 0..2 and capture page-relative caret coordinates for all 5x2 cells
        cell_pts: dict[tuple[int, int], dict[str, float]] = {}

        # (0,0) H1, (0,1) H2
        cell_pts[(0, 0)] = self.caret_rel_point()
        self.type("H1")
        self.settle(fmt)
        self.move_next_cell(fmt)

        cell_pts[(0, 1)] = self.caret_rel_point()
        self.type("H2")
        self.settle(fmt)
        self.move_next_cell(fmt)

        # (1,0) Bold "A1" (select text so both WordCraft and RHWP enable format.bold)
        cell_pts[(1, 0)] = self.caret_rel_point()
        self.type("A1")
        self.settle(fmt)
        self.key("shift+Home")
        self.wait(
            "const s=document.querySelector(arguments[0]);return s && !!s.dataset.selection",
            f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]',
        )
        self.settle(fmt)
        self.select_tab(home_tab)
        self.dom_click('.ribbon__toolbar [data-command="format.bold"]')
        self.settle(fmt)
        self.wait('return document.querySelector("[data-command=\\"format.bold\\"]")?.getAttribute("aria-pressed")==="true"')
        self.key("End")
        self.settle(fmt)
        self.move_next_cell(fmt)

        # (1,1) "B1"
        cell_pts[(1, 1)] = self.caret_rel_point()
        self.type("B1")
        self.settle(fmt)
        self.move_next_cell(fmt)

        # (2,0) "A2", (2,1) "B2"
        cell_pts[(2, 0)] = self.caret_rel_point()
        self.type("A2")
        self.settle(fmt)
        self.move_next_cell(fmt)

        cell_pts[(2, 1)] = self.caret_rel_point()
        self.type("B2")
        self.settle(fmt)
        self.move_next_cell(fmt)

        # (3,0), (3,1), (4,0), (4,1) empty target rows
        for rc in [(3, 0), (3, 1), (4, 0), (4, 1)]:
            cell_pts[rc] = self.caret_rel_point()
            if rc != (4, 1):
                self.move_next_cell(fmt)

        # Adjust dx towards column interior so cell centers stay well clear of cell borders
        col0_dx = (cell_pts[(0, 0)]["dx"] + cell_pts[(0, 1)]["dx"]) / 2.0
        col1_dx = cell_pts[(0, 1)]["dx"] + 24.0
        for r in range(5):
            cell_pts[(r, 0)] = {"dx": col0_dx, "dy": cell_pts[(r, 0)]["dy"]}
            cell_pts[(r, 1)] = {"dx": col1_dx, "dy": cell_pts[(r, 1)]["dy"]}
        row["steps"].append("populate_5x2 PASS")

        # 3. P4-1: Multi-cell Copy (1,0..2,1) -> Paste (3,0) -> Undo -> Redo -> Cut (3,0..4,1) -> Undo
        self.select_tab(home_tab)
        self.drag_cells(fmt, cell_pts[(1, 0)], cell_pts[(2, 1)])
        self.wait(
            'const cp=document.querySelector("[data-command=\\"edit.copy\\"]");'
            'const ct=document.querySelector("[data-command=\\"edit.cut\\"]");'
            'return cp && cp.getAttribute("aria-disabled")!=="true" && ct && ct.getAttribute("aria-disabled")!=="true"'
        )
        rev_before_copy = self.status(fmt)["revision"]
        self.dom_click('.ribbon__toolbar [data-command="edit.copy"]')
        time.sleep(0.3)
        self.settle(fmt)
        assert self.status(fmt)["revision"] == rev_before_copy, f"{fmt}: copy altered revision"

        # Paste into (3,0) -> (3,0..4,1)
        self.click_cell_pt(fmt, cell_pts[(3, 0)])
        self.dom_click('.ribbon__toolbar [data-command="edit.paste"]')
        self.settle(fmt)
        assert self.cell_caret_end_offset(fmt, cell_pts[(3, 0)]) == 2, f"{fmt}: pasted (3,0) not len 2"
        assert self.cell_caret_end_offset(fmt, cell_pts[(4, 1)]) == 2, f"{fmt}: pasted (4,1) not len 2"

        # Undo paste -> (3,0) back to empty
        self.key("ctrl+z")
        self.settle(fmt)
        assert self.cell_caret_end_offset(fmt, cell_pts[(3, 0)]) == 0, f"{fmt}: undo paste left text in (3,0)"

        # Redo paste -> (3,0) and (4,1) populated again
        self.key("ctrl+y")
        self.settle(fmt)
        assert self.cell_caret_end_offset(fmt, cell_pts[(3, 0)]) == 2, f"{fmt}: redo paste missing in (3,0)"
        assert self.cell_caret_end_offset(fmt, cell_pts[(4, 1)]) == 2, f"{fmt}: redo paste missing in (4,1)"

        # Cut (3,0..4,1) -> cells cleared -> Undo -> restored
        self.drag_cells(fmt, cell_pts[(3, 0)], cell_pts[(4, 1)])
        self.dom_click('.ribbon__toolbar [data-command="edit.cut"]')
        self.settle(fmt)
        assert self.cell_caret_end_offset(fmt, cell_pts[(3, 0)]) == 0, f"{fmt}: cut did not clear (3,0)"
        self.key("ctrl+z")
        self.settle(fmt)
        assert self.cell_caret_end_offset(fmt, cell_pts[(3, 0)]) == 2, f"{fmt}: undo cut did not restore (3,0)"
        assert self.cell_caret_end_offset(fmt, cell_pts[(4, 1)]) == 2, f"{fmt}: undo cut did not restore (4,1)"
        row["steps"].append("p4_1_clipboard PASS")

        # 4. P4-2: cell margins (table scope + cell override on (1,0)) & positioning (center + HWP/HWPX outer margins)
        self.click_cell_pt(fmt, cell_pts[(1, 0)])

        def apply_table_margins():
            self.dom_click("[data-testid=margin-scope-table]")
            self.set_input_value("table-margin-top", "5")
            self.set_input_value("table-margin-right", "7")
            self.set_input_value("table-margin-bottom", "5")
            self.set_input_value("table-margin-left", "7")

        self.run_table_dialog("table.cellMargins", table_tab, fmt, apply_table_margins)

        def apply_cell_margins():
            self.dom_click("[data-testid=margin-scope-cell]")
            self.set_input_value("table-margin-top", "10")
            self.set_input_value("table-margin-right", "12")
            self.set_input_value("table-margin-bottom", "10")
            self.set_input_value("table-margin-left", "12")

        self.run_table_dialog("table.cellMargins", table_tab, fmt, apply_cell_margins)

        def apply_positioning():
            self.dom_click("[data-testid=table-pos-align-center]")
            if fmt != "docx":
                is_char = self.d.js("return document.querySelector('[data-testid=table-pos-treat-as-char]')?.checked===true")
                if is_char:
                    self.dom_click("[data-testid=table-pos-treat-as-char]")
                self.set_input_value("table-outer-margin-top", "4")
                self.set_input_value("table-outer-margin-right", "6")
                self.set_input_value("table-outer-margin-bottom", "4")
                self.set_input_value("table-outer-margin-left", "6")

        self.run_table_dialog("table.positioning", table_tab, fmt, apply_positioning)
        row["steps"].append("p4_2_margins_positioning PASS")

        # 5. P4-3: Repeat header on row 0 + Row break = "row"
        self.click_cell_pt(fmt, cell_pts[(0, 0)])

        def apply_repeat_header():
            self.wait("const e=document.querySelector('[data-testid=table-repeat-header-toggle]');return e && !e.disabled")
            if not self.d.js("return document.querySelector('[data-testid=table-repeat-header-toggle]').checked"):
                self.dom_click("[data-testid=table-repeat-header-toggle]")

        self.run_table_dialog("table.repeatHeader", table_tab, fmt, apply_repeat_header)

        def apply_row_break():
            self.set_select_value("table-row-break-mode", "row")

        self.run_table_dialog("table.rowBreak", table_tab, fmt, apply_row_break)
        row["steps"].append("p4_3_header_rowbreak PASS")

        # 6. Save, Close Tab, Reopen via native Open dialog, and Verify Persisted UI State
        save_res = self.save(fmt)
        row["save"] = save_res
        row["savedSha256"] = sha256(path)
        self.d.screenshot(self.args.out / f"{fmt}-saved.png")
        assert rhwp_poc.close_tab(self.d, path.name), f"{fmt}: close_tab requested discard after save"

        self.open_native(fmt, path)
        self.settle(fmt)

        # Land inside row 0 cell (0,0) (with small vertical offset scan in case outerMargins shifted top slightly)
        landed_dy = None
        for dy_off in (0, 6, 12, -4):
            self.click_cell_pt(fmt, {"dx": cell_pts[(0, 0)]["dx"], "dy": cell_pts[(0, 0)]["dy"] + dy_off})
            if self.in_table(fmt):
                landed_dy = dy_off
                break
        assert landed_dy is not None, f"{fmt}: could not click back into row 0 after reopen"

        # Read persisted P4-3 settings from row 0
        rh_read = self.read_table_dialog(
            "table.repeatHeader",
            table_tab,
            lambda: self.d.js("return document.querySelector('[data-testid=table-repeat-header-toggle]').checked"),
        )
        assert rh_read is True, f"{fmt}: repeatHeader not persisted on reopen: {rh_read!r}"

        rb_read = self.read_table_dialog(
            "table.rowBreak",
            table_tab,
            lambda: self.d.js("return document.querySelector('[data-testid=table-row-break-mode]').value"),
        )
        assert rb_read == "row", f"{fmt}: rowBreak not persisted on reopen: {rb_read!r}"

        # Re-click (0,0) to ensure editor focus after Escape, then Tab twice to (1,0) and verify P4-2 settings
        self.click_cell_pt(fmt, {"dx": cell_pts[(0, 0)]["dx"], "dy": cell_pts[(0, 0)]["dy"] + landed_dy})
        self.move_next_cell(fmt)  # -> (0,1)
        self.move_next_cell(fmt)  # -> (1,0)

        def read_margins():
            cell_vals = {
                s: self.d.js("return document.querySelector(arguments[0]).value", f"[data-testid=table-margin-{s}]")
                for s in ("top", "right", "bottom", "left")
            }
            self.dom_click("[data-testid=margin-scope-table]")
            table_vals = {
                s: self.d.js("return document.querySelector(arguments[0]).value", f"[data-testid=table-margin-{s}]")
                for s in ("top", "right", "bottom", "left")
            }
            return {"cell": cell_vals, "table": table_vals}

        margins_read = self.read_table_dialog("table.cellMargins", table_tab, read_margins)
        assert margins_read["cell"] == {"top": "10", "right": "12", "bottom": "10", "left": "12"}, (
            f"{fmt}: persisted cell margins mismatch: {margins_read}"
        )
        assert margins_read["table"] == {"top": "5", "right": "7", "bottom": "5", "left": "7"}, (
            f"{fmt}: persisted table margins mismatch: {margins_read}"
        )

        def read_pos():
            res = {
                "alignCenter": self.d.js(
                    "return document.querySelector('[data-testid=table-pos-align-center]').getAttribute('aria-pressed')"
                )
            }
            if fmt != "docx":
                res["treatAsChar"] = self.d.js(
                    "return document.querySelector('[data-testid=table-pos-treat-as-char]').checked"
                )
                res["outer"] = {
                    s: self.d.js("return document.querySelector(arguments[0]).value", f"[data-testid=table-outer-margin-{s}]")
                    for s in ("top", "right", "bottom", "left")
                }
            return res

        pos_read = self.read_table_dialog("table.positioning", table_tab, read_pos)
        assert pos_read["alignCenter"] == "true", f"{fmt}: positioning align=center mismatch: {pos_read}"
        if fmt != "docx":
            assert pos_read["treatAsChar"] is False, f"{fmt}: positioning treatAsChar mismatch: {pos_read}"
            assert pos_read["outer"] == {"top": "4", "right": "6", "bottom": "4", "left": "6"}, (
                f"{fmt}: positioning outer margins mismatch: {pos_read}"
            )
        row["steps"].append("reopen_ui_persisted PASS")

        assert rhwp_poc.close_tab(self.d, path.name)

        # 7. Independent on-disk format verification
        row["diskCheck"] = self.verify_disk(fmt, path)
        row["steps"].append("independent_disk_check PASS")
        row["status"] = "PASS"

    def verify_disk(self, fmt: str, path: Path) -> dict:
        if fmt == "docx":
            with zipfile.ZipFile(path) as zf:
                assert zf.testzip() is None
                doc_xml = zf.read("word/document.xml")
            root = ET.fromstring(doc_xml)
            tbls = root.findall(f".//{{{W_NS}}}tbl")
            assert len(tbls) == 1, f"expected 1 table in docx, got {len(tbls)}"
            tbl = tbls[0]
            tbl_pr = tbl.find(f"{{{W_NS}}}tblPr")
            assert tbl_pr is not None
            jc = tbl_pr.find(f"{{{W_NS}}}jc")
            assert jc is not None and jc.get(f"{{{W_NS}}}val") == "center", f"docx jc={jc}"
            tbl_mar = tbl_pr.find(f"{{{W_NS}}}tblCellMar")
            assert tbl_mar is not None, "docx missing w:tblCellMar"
            trs = tbl.findall(f"{{{W_NS}}}tr")
            assert len(trs) == 5, f"expected 5 rows in docx, got {len(trs)}"
            tr0_pr = trs[0].find(f"{{{W_NS}}}trPr")
            assert tr0_pr is not None and tr0_pr.find(f"{{{W_NS}}}tblHeader") is not None, "docx row 0 missing w:tblHeader"
            cant_splits = [tr.find(f"{{{W_NS}}}trPr/{{{W_NS}}}cantSplit") for tr in trs]
            assert any(cs is not None for cs in cant_splits), "docx missing w:cantSplit"
            tc10 = trs[1].findall(f"{{{W_NS}}}tc")[0]
            assert tc10.find(f"{{{W_NS}}}tcPr/{{{W_NS}}}tcMar") is not None, "docx (1,0) missing w:tcMar"
            cell_texts = ["".join(t.text or "" for t in tc.iter(f"{{{W_NS}}}t")) for tr in trs for tc in tr.findall(f"{{{W_NS}}}tc")]
            assert cell_texts == ["H1", "H2", "A1", "B1", "A2", "B2", "A1", "B1", "A2", "B2"], f"docx cells={cell_texts}"
            tc30 = trs[3].findall(f"{{{W_NS}}}tc")[0]
            bold_runs_30 = tc30.findall(f".//{{{W_NS}}}r/{{{W_NS}}}rPr/{{{W_NS}}}b")
            assert len(bold_runs_30) >= 1, "docx pasted cell (3,0) missing <w:b/> formatting"
            return {"cells": cell_texts, "tblHeader": True, "cantSplit": True, "jc": "center"}

        if fmt == "hwpx":
            with zipfile.ZipFile(path) as zf:
                assert zf.testzip() is None
                sec_xml = zf.read("Contents/section0.xml")
            root = ET.fromstring(sec_xml)
            tbl = root.find(f".//{{{HP_NS}}}tbl")
            assert tbl is not None, "hwpx missing hp:tbl"
            assert tbl.get("repeatHeader") in ("1", "true"), f"hwpx repeatHeader={tbl.get('repeatHeader')}"
            assert tbl.get("pageBreak") == "CELL", f"hwpx pageBreak={tbl.get('pageBreak')}"
            out_m = tbl.find(f"{{{HP_NS}}}outMargin")
            in_m = tbl.find(f"{{{HP_NS}}}inMargin")
            assert out_m is not None and in_m is not None, "hwpx missing outMargin/inMargin"
            trs = tbl.findall(f"{{{HP_NS}}}tr")
            assert len(trs) == 5, f"expected 5 rows in hwpx, got {len(trs)}"
            tcs = [tc for tr in trs for tc in tr.findall(f"{{{HP_NS}}}tc")]
            assert tcs[0].get("header") in ("1", "true"), f"hwpx cell(0,0) header={tcs[0].get('header')}"
            assert tcs[2].find(f"{{{HP_NS}}}cellMargin") is not None, "hwpx cell(1,0) missing hp:cellMargin"
            cell_texts = ["".join(t.text or "" for t in tc.iter(f"{{{HP_NS}}}t")) for tc in tcs]
            assert cell_texts == ["H1", "H2", "A1", "B1", "A2", "B2", "A1", "B1", "A2", "B2"], f"hwpx cells={cell_texts}"
            run10 = tcs[2].find(f".//{{{HP_NS}}}run")
            run11 = tcs[3].find(f".//{{{HP_NS}}}run")
            run30 = tcs[6].find(f".//{{{HP_NS}}}run")
            assert run10 is not None and run11 is not None and run30 is not None
            assert run30.get("charPrIDRef") == run10.get("charPrIDRef") and run30.get("charPrIDRef") != run11.get("charPrIDRef"), (
                f"hwpx pasted bold charPr mismatch: 10={run10.get('charPrIDRef')}, 11={run11.get('charPrIDRef')}, 30={run30.get('charPrIDRef')}"
            )
            return {"cells": cell_texts, "repeatHeader": tbl.get("repeatHeader"), "pageBreak": tbl.get("pageBreak"), "boldCharPr": run30.get("charPrIDRef")}

        # fmt == "hwp": verify via Release WASM oracle (independent Node process)
        build_info = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text(encoding="utf-8"))
        wasm_js = ROOT / "public/rhwp/generations" / build_info["generation"] / "rhwp.js"
        node_script = """
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [wasmJs, hwpPath] = process.argv.slice(1);
const mod = await import(pathToFileURL(wasmJs).href);
mod.initSync({ module: fs.readFileSync(wasmJs.replace(/rhwp\\.js$/, 'rhwp_bg.wasm')) });
const doc = new mod.HwpDocument(fs.readFileSync(hwpPath));
const tbl = JSON.parse(doc.getControls()).find(c => c.ctrlId === 'tbl');
if (!tbl) throw new Error('missing table control in HWP');
const pp = tbl.para;
const tpath = JSON.stringify([{ controlIndex: tbl.controlIndex, cellIndex: 0, cellParaIndex: 0 }]);
const pg = JSON.parse(doc.getTablePaginationByPath(0, pp, tpath, 0, 0));
const m0 = JSON.parse(doc.getTableCellMarginsByPath(0, pp, tpath, 1, 0, 1, 0));
const ext = JSON.parse(doc.extractTableCellsByPath(0, pp, tpath, 0, 0, 4, 1));
const texts = ext.cells.map(c => c.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\\n'));
const bold30 = ext.cells[6].paragraphs[0].runs.some(r => r.bold === true);
doc.free();
console.log(JSON.stringify({ pg, m0, texts, bold30 }));
"""
        out = subprocess.check_output(["node", "--input-type=module", "-e", node_script, str(wasm_js), str(path)], text=True)
        parsed = json.loads(out)
        assert parsed["pg"]["repeatHeader"] is True, f"hwp repeatHeader={parsed}"
        assert parsed["pg"]["pageBreak"] == "row", f"hwp pageBreak={parsed}"
        assert parsed["pg"]["leadingHeaderRows"] >= 1, f"hwp leadingHeaderRows={parsed}"
        assert abs(parsed["m0"]["cell"]["top"] - 10.0) < 0.2 and abs(parsed["m0"]["cell"]["left"] - 12.0) < 0.2, f"hwp cell margins={parsed}"
        assert abs(parsed["m0"]["table"]["top"] - 5.0) < 0.2 and abs(parsed["m0"]["table"]["left"] - 7.0) < 0.2, f"hwp table margins={parsed}"
        assert parsed["texts"] == ["H1", "H2", "A1", "B1", "A2", "B2", "A1", "B1", "A2", "B2"], f"hwp texts={parsed}"
        assert parsed["bold30"] is True, f"hwp pasted cell (3,0) missing bold formatting: {parsed}"
        return parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--xdotool", default="xdotool")
    parser.add_argument("--ibus", default="ibus")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--formats", nargs="+", choices=["docx", "hwpx", "hwp"], default=["docx", "hwpx", "hwp"])
    parser.add_argument("--port", type=int, default=4464)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    report = {
        "status": "RUNNING",
        "formats": [],
        "sourceHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "appSha256": sha256(args.app),
    }
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / "driver.log"
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / "data")) as start:
            d = start()
            acc = P4Acceptance(args, d, report)
            acc.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            acc.focus_window()
            acc.calibrate_pointer()
            for fmt in args.formats:
                acc.verify_format(fmt)
                (args.out / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            d.quit()
            d = None
        report["status"] = "PASS"
    except Exception as exc:
        report.update(status="FAIL", error=str(exc), trace=traceback.format_exc())
        for row in report["formats"]:
            if row["status"] == "RUNNING":
                row["status"] = "FAIL"
        if d:
            try:
                d.screenshot(args.out / "failure.png")
            except Exception:
                pass
            try:
                d.quit()
            except Exception:
                pass
    finally:
        (args.out / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
