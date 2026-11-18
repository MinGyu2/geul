#!/usr/bin/env python3
"""Stage 2 Phase 4 stabilization: native multipage repeating-header acceptance (DOCX, HWPX, HWP).

Supplements scripts/tests/stage2-p4-native-acceptance.py (5x2 table) with one focused case whose
table actually spans pages. Run under scripts/tests/native-ibus-session.py:
  python3 scripts/tests/native-ibus-session.py --out /tmp/geul-p4-multipage -- \
    python3 scripts/tests/stage2-p4-native-multipage.py --out /tmp/geul-p4-multipage

In the actual Release desktop app, per format:
1. New document, 10x2 table; body rows get table.rowHeight 120pt so the table spans >= 2 pages
   (row height keeps this case about pagination; Enter in new HWP cells has its own native acceptance).
2. Negative control: before headers exist, hit-testing the top of page 2 lands in a body row.
3. Rows 0..1 become repeating header rows; row break mode "row".
4. The rendered continuation page is hit-tested: the header-band points on page 2 land the caret in
   table rows 0 and 1, and the point below them lands in a continued body row (render evidence, not
   stored metadata).
5. Save, close, reopen through the native Open dialog; repeat the page-2 hit test and read the
   persisted dialog state (repeat on, leading count 2, row break "row").
6. Independent disk oracle (DOCX/HWPX XML; HWP via the Release WASM incl. page-2 render tree).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P4_SPEC = importlib.util.spec_from_file_location("stage2_p4_native_acceptance", ROOT / "scripts/tests/stage2-p4-native-acceptance.py")
p4 = importlib.util.module_from_spec(P4_SPEC)
P4_SPEC.loader.exec_module(p4)
rhwp_poc, smoke, KO = p4.rhwp_poc, p4.smoke, p4.KO
W_NS, HP_NS = p4.W_NS, p4.HP_NS
ROWS = 10
BODY_ROW_PT = 120


class Multipage(p4.P4Acceptance):
    def page_point(self, page: int, rel: dict[str, float]) -> dict[str, float]:
        """Scroll page `page` so the page-relative point is mid-viewport; return its viewport point."""
        self.wait("return document.querySelector(arguments[0])!==null", f'.rhwp-page[data-page="{page}"]')
        return self.d.js(
            "const s=document.querySelector('.editor__scroll');"
            "const p=document.querySelector(arguments[0]);const r=arguments[1];"
            "let pr=p.getBoundingClientRect();const sr=s.getBoundingClientRect();"
            "s.scrollTop += (pr.top+r.dy) - (sr.top+sr.height*0.5);"
            "pr=p.getBoundingClientRect();return {x:pr.left+r.dx,y:pr.top+r.dy};",
            f'.rhwp-page[data-page="{page}"]',
            rel,
        )

    def caret_row(self, fmt: str) -> int | None:
        caret = self.status(fmt).get("caret") or ""
        if fmt == "docx":  # body:<table>.<row>.<col>.<paragraph>:<offset>
            parts = caret.split(":")
            path = parts[1].split(".") if len(parts) == 3 else []
            return int(path[1]) if len(path) >= 4 else None
        if "@" not in caret:  # <section>:<paragraph>:<offset>@<control>/<cell>/<cellParagraph>
            return None
        return int(caret.split("@", 1)[1].split("/")[1]) // 2

    def hit_row(self, fmt: str, page: int, rel: dict[str, float]) -> int | None:
        pt = self.page_point(page, rel)
        rhwp_poc.click(self.d, pt["x"], pt["y"])
        self.settle(fmt)
        return self.caret_row(fmt)

    def pages(self, fmt: str) -> int:
        return int(self.status(fmt).get("pages") or "0")

    def continuation_hits(self, fmt: str, pts: dict[str, dict[str, float]]) -> dict[str, int | None]:
        return {name: self.hit_row(fmt, 1, rel) for name, rel in pts.items()}

    def verify_format(self, fmt: str):
        path = self.args.out / f"p4-multipage.{fmt}"
        row = {"format": fmt, "status": "RUNNING", "steps": []}
        self.report["formats"].append(row)
        table_tab = KO["ribbon.tab.layout"] if fmt == "docx" else KO["ribbon.tab.hangulTools"]

        self.new(fmt, path)
        self.ready(fmt, path.name)
        self.engine("xkb:us::eng")
        self.toolbar_cmd("insert.table", KO["ribbon.tab.insert"])
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')!==null")
        self.set_input_value("command-input-rows", str(ROWS))
        self.set_input_value("command-input-cols", "2")
        self.key("Return")
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')===null")
        self.settle(fmt)
        assert self.in_table(fmt), f"{fmt}: caret not inside inserted table"

        pts: dict[tuple[int, int], dict[str, float]] = {}
        # Single-line rows keep the whole table on page 1 while every row position is captured.
        for r in range(ROWS):
            pts[(r, 0)] = self.caret_rel_point()
            self.type("HDR-A" if r == 0 else "HDR-B" if r == 1 else f"B{r:02d}")
            self.settle(fmt)
            self.move_next_cell(fmt)
            pts[(r, 1)] = self.caret_rel_point()
            if r < ROWS - 1:
                self.move_next_cell(fmt)
        assert self.pages(fmt) == 1, f"{fmt}: single-line table already spans pages"
        col0 = (pts[(0, 0)]["dx"] + pts[(0, 1)]["dx"]) / 2.0
        col1 = pts[(0, 1)]["dx"] + 24.0
        # Body rows 2..31 become tall through the supported table.rowHeight path (one selection).
        self.select_tab(KO["ribbon.tab.home"])
        self.drag_cells(fmt, {"dx": col0, "dy": pts[(2, 0)]["dy"]}, {"dx": col1, "dy": pts[(ROWS - 1, 1)]["dy"]})
        self.run_table_dialog("table.rowHeight", table_tab, fmt, lambda: self.set_input_value("table-row-height", str(BODY_ROW_PT)))
        self.wait("return +document.querySelector(arguments[0])?.dataset.pages>=2",
                  f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]', timeout=30)
        row["pagesBeforeHeaders"] = self.pages(fmt)
        row_h = pts[(1, 0)]["dy"] - pts[(0, 0)]["dy"]
        band = {
            "header0": {"dx": col0, "dy": pts[(0, 0)]["dy"]},
            "header1": {"dx": col0, "dy": pts[(1, 0)]["dy"]},
            "body": {"dx": col0, "dy": pts[(1, 0)]["dy"] + row_h},
        }
        cell0 = {"dx": col0, "dy": pts[(0, 0)]["dy"]}
        cell1_right = {"dx": col1, "dy": pts[(1, 0)]["dy"]}
        row["populated"] = {"rows": ROWS, "rowHeightPx": row_h}
        row["steps"].append("populate_multipage PASS")

        # Negative control: without header rows the top of page 2 is a continued body row.
        control = self.hit_row(fmt, 1, band["header0"])
        row["controlTopRow"] = control
        assert control is not None and control >= 2, f"{fmt}: page 2 top before headers hit row {control!r}"
        row["steps"].append("negative_control PASS")

        self.select_tab(KO["ribbon.tab.home"])
        self.drag_cells(fmt, cell0, cell1_right)

        def enable_header():
            self.wait("const e=document.querySelector('[data-testid=table-repeat-header-toggle]');return e && !e.disabled")
            if not self.d.js("return document.querySelector('[data-testid=table-repeat-header-toggle]').checked"):
                self.dom_click("[data-testid=table-repeat-header-toggle]")

        self.run_table_dialog("table.repeatHeader", table_tab, fmt, enable_header)
        self.run_table_dialog("table.rowBreak", table_tab, fmt, lambda: self.set_select_value("table-row-break-mode", "row"))
        row["pagesAfterHeaders"] = self.pages(fmt)
        assert row["pagesAfterHeaders"] >= 2, f"{fmt}: table no longer spans pages: {row['pagesAfterHeaders']}"
        hits = self.continuation_hits(fmt, band)
        row["continuationHits"] = hits
        self.d.screenshot(self.args.out / f"{fmt}-page2-headers.png")
        assert hits["header0"] == 0 and hits["header1"] == 1, f"{fmt}: page 2 header band hit rows {hits}"
        assert hits["body"] is not None and hits["body"] >= 2, f"{fmt}: page 2 body point hit row {hits}"
        row["steps"].append("continuation_page_headers PASS")

        row["save"] = self.save(fmt)
        row["savedSha256"] = p4.sha256(path)
        assert rhwp_poc.close_tab(self.d, path.name), f"{fmt}: close_tab requested discard after save"
        self.open_native(fmt, path)
        self.settle(fmt)
        self.wait("return +document.querySelector(arguments[0])?.dataset.pages>=2",
                  f'[data-testid={"docx" if fmt == "docx" else "rhwp"}-status]', timeout=30)
        row["pagesReopened"] = self.pages(fmt)
        reopened_hits = self.continuation_hits(fmt, band)
        row["reopenedContinuationHits"] = reopened_hits
        self.d.screenshot(self.args.out / f"{fmt}-reopened-page2.png")
        assert reopened_hits["header0"] == 0 and reopened_hits["header1"] == 1, f"{fmt}: reopened page 2 hits {reopened_hits}"
        assert reopened_hits["body"] is not None and reopened_hits["body"] >= 2, f"{fmt}: reopened body hit {reopened_hits}"

        self.click_cell_pt(fmt, cell0)
        assert self.caret_row(fmt) == 0, f"{fmt}: could not land in row 0 after reopen"
        header_state = self.read_table_dialog("table.repeatHeader", table_tab, lambda: self.d.js(
            "const d=document.querySelector('[data-testid=table-format-dialog]');"
            "return {checked:document.querySelector('[data-testid=table-repeat-header-toggle]').checked,text:d.textContent}"))
        assert header_state["checked"] is True, f"{fmt}: repeat header not persisted: {header_state}"
        leading = f'{KO["tableFormat.repeatHeader.leadingCount"]}: 2'
        assert leading in header_state["text"], f"{fmt}: leading header count not 2: {header_state['text']!r}"
        rb = self.read_table_dialog("table.rowBreak", table_tab,
                                    lambda: self.d.js("return document.querySelector('[data-testid=table-row-break-mode]').value"))
        assert rb == "row", f"{fmt}: row break not persisted: {rb!r}"
        row["steps"].append("reopen_continuation_and_dialog PASS")
        assert rhwp_poc.close_tab(self.d, path.name)

        row["diskCheck"] = self.verify_multipage_disk(fmt, path)
        row["steps"].append("independent_disk_check PASS")
        row["status"] = "PASS"

    def verify_multipage_disk(self, fmt: str, path: Path) -> dict:
        labels = ["HDR-A", "HDR-B", *[f"B{r:02d}" for r in range(2, ROWS)]]
        if fmt == "docx":
            with zipfile.ZipFile(path) as zf:
                assert zf.testzip() is None
                root = ET.fromstring(zf.read("word/document.xml"))
            trs = root.findall(f".//{{{W_NS}}}tbl/{{{W_NS}}}tr")
            assert len(trs) == ROWS, f"docx rows={len(trs)}"
            header = [tr.find(f"{{{W_NS}}}trPr/{{{W_NS}}}tblHeader") is not None for tr in trs]
            assert header[:3] == [True, True, False] and not any(header[2:]), f"docx tblHeader={header}"
            firsts = ["".join(t.text or "" for t in tr.findall(f"{{{W_NS}}}tc")[0].iter(f"{{{W_NS}}}t")) for tr in trs]
            assert firsts == labels, f"docx first-column texts={firsts}"
            return {"rows": len(trs), "tblHeader": header[:3]}
        if fmt == "hwpx":
            with zipfile.ZipFile(path) as zf:
                assert zf.testzip() is None
                root = ET.fromstring(zf.read("Contents/section0.xml"))
            tbl = root.find(f".//{{{HP_NS}}}tbl")
            assert tbl is not None and tbl.get("repeatHeader") in ("1", "true"), f"hwpx repeatHeader={tbl is not None and tbl.get('repeatHeader')}"
            trs = tbl.findall(f"{{{HP_NS}}}tr")
            assert len(trs) == ROWS, f"hwpx rows={len(trs)}"
            header = [all(tc.get("header") in ("1", "true") for tc in tr.findall(f"{{{HP_NS}}}tc")) for tr in trs]
            assert header[:2] == [True, True] and not any(header[2:]), f"hwpx header={header}"
            firsts = ["".join(t.text or "" for t in tr.findall(f"{{{HP_NS}}}tc")[0].iter(f"{{{HP_NS}}}t")) for tr in trs]
            assert firsts == labels, f"hwpx first-column texts={firsts}"
            return {"rows": len(trs), "repeatHeader": tbl.get("repeatHeader"), "pageBreak": tbl.get("pageBreak")}
        build = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text(encoding="utf-8"))
        wasm_js = ROOT / "public/rhwp/generations" / build["generation"] / "rhwp.js"
        script = """
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [wasmJs, hwpPath] = process.argv.slice(1);
const mod = await import(pathToFileURL(wasmJs).href);
mod.initSync({ module: fs.readFileSync(wasmJs.replace(/rhwp\\.js$/, 'rhwp_bg.wasm')) });
const doc = new mod.HwpDocument(fs.readFileSync(hwpPath));
const tbl = JSON.parse(doc.getControls()).find(c => c.ctrlId === 'tbl');
const tpath = JSON.stringify([{ controlIndex: tbl.controlIndex, cellIndex: 0, cellParaIndex: 0 }]);
const pg = JSON.parse(doc.getTablePaginationByPath(0, tbl.para, tpath, 0, 0));
const pages = doc.pageCount();
const page2 = doc.getPageRenderTree(1);
console.log(JSON.stringify({ pg, pages, page2HasA: page2.includes('HDR-A'), page2HasB: page2.includes('HDR-B') }));
doc.free();
"""
        parsed = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, str(wasm_js), str(path)], text=True))
        assert parsed["pg"]["repeatHeader"] is True and parsed["pg"]["leadingHeaderRows"] == 2, f"hwp pagination={parsed}"
        assert parsed["pg"]["pageBreak"] == "row", f"hwp pageBreak={parsed}"
        assert parsed["pages"] >= 2 and parsed["page2HasA"] and parsed["page2HasB"], f"hwp page 2 render={parsed}"
        parsed["wasmGeneration"] = build["generation"]
        return parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--xdotool", default="xdotool")
    parser.add_argument("--ibus", default="ibus")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--formats", nargs="+", choices=["docx", "hwpx", "hwp"], default=["docx", "hwpx", "hwp"])
    parser.add_argument("--port", type=int, default=4465)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    build = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text(encoding="utf-8"))
    report = {
        "status": "RUNNING",
        "formats": [],
        "sourceHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "appSha256": p4.sha256(args.app),
        "rhwpWasmGeneration": build["generation"],
    }
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / "driver.log"
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / "data")) as start:
            d = start()
            acc = Multipage(args, d, report)
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
