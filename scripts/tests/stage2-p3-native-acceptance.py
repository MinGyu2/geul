#!/usr/bin/env python3
"""Stage 2 / Phase 3 real production native GUI acceptance across DOCX, HWPX, and HWP.

Drives the real production Tauri binary via tauri-driver + WebKitWebDriver + private X11/IBus
(native-ibus-session.py), executing P3-1 shading/borders, P3-2 alignment, P3-3 dimensions,
Undo/Redo, safe saving, independent reopening, and package structure inspection.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests/e2e"))
sys.path.insert(0, str(ROOT / "tests/integration/rhwp"))
import tauri_smoke as smoke
import rhwp_poc

spec = importlib.util.spec_from_file_location("nd", ROOT / "scripts/tests/native-new-document.py")
nd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nd)

KO = json.loads((ROOT / "src/language/ko.json").read_text())


class P3Acceptance(nd.Acceptance):
    def __init__(self, args, driver, report):
        super().__init__(args, driver, report)
        self.window = self.command("xdotool", "search", "--onlyvisible", "--name", "^geul$").split()[-1]
        self.command("xdotool", "windowfocus", "--sync", self.window)

    def click(self, selector=None, expression=None):
        expr = expression or "document.querySelector(arguments[0])"
        pt = self.d.js(
            "const e=(" + expr + ");if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});"
            "const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}",
            selector,
        )
        if not pt or not pt["w"] or not pt["h"]:
            raise smoke.Failure(f"target not visible: {selector or expression}")
        scale = self.d.js("return devicePixelRatio")
        self.command(
            self.args.xdotool,
            "mousemove",
            "--window",
            self.window,
            str(round(pt["x"] * scale)),
            str(round(pt["y"] * scale)),
            "click",
            "1",
        )

    def tab(self, label):
        self.click(label, "[...document.querySelectorAll('.ribbon__tabs [role=tab]')].find(e=>e.textContent.includes(arguments[0]))")

    def toolbar_cmd(self, cmd_id, tab_label):
        self.tab(tab_label)
        sel = f'.ribbon__toolbar [data-command="{cmd_id}"]'
        self.wait(
            f"const b=document.querySelector('{sel}');"
            f"return b!==null && !b.disabled && b.getAttribute('aria-disabled')!=='true'"
        )
        self.click(sel)

    def settle(self, fmt):
        prefix = "docx" if fmt == "docx" else "rhwp"
        self.wait(
            f"const e=document.querySelector('[data-testid={prefix}-status]');"
            f"return e?.dataset.status==='ready' && (e?.dataset.pending===undefined || e?.dataset.pending==='0')"
        )
        time.sleep(0.05)

    def run_table_dialog(self, cmd_id, tab_label, fn):
        self.toolbar_cmd(cmd_id, tab_label)
        self.wait(f"return document.querySelector('[data-testid=table-format-dialog]')?.dataset.command==='{cmd_id}'")
        fn()
        self.click("[data-testid=table-format-confirm]")
        self.wait("return document.querySelector('[data-testid=table-format-dialog]')===null")

    def read_table_dialog(self, cmd_id, tab_label, js_extract):
        self.toolbar_cmd(cmd_id, tab_label)
        self.wait(f"return document.querySelector('[data-testid=table-format-dialog]')?.dataset.command==='{cmd_id}'")
        val = self.d.js(js_extract)
        self.key("Escape")
        self.wait("return document.querySelector('[data-testid=table-format-dialog]')===null")
        return val

    def set_input_value(self, testid, val):
        self.click(f"[data-testid={testid}]")
        self.key("ctrl+a")
        self.type(str(val))

    def verify_format(self, fmt):
        out_path = self.args.out / f"p3-accept.{fmt}"
        tab_label = KO["ribbon.tab.layout"] if fmt == "docx" else KO["ribbon.tab.hangulTools"]
        insert_label = KO["ribbon.tab.insert"]
        home_label = KO["ribbon.tab.home"]

        self.new(fmt, out_path)
        self.ready(fmt, out_path.name)

        # Insert 2x2 table via real ribbon command dialog
        self.toolbar_cmd("insert.table", insert_label)
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')!==null")
        self.key("Return")
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')===null")
        self.settle(fmt)

        # Enter cell content into cells (0,0) and (0,1), then return to (0,0)
        self.engine("xkb:us::eng")
        self.type("A1")
        self.key("Tab")
        self.type("B1")
        self.key("shift+Tab")
        self.settle(fmt)

        # P3-1: Shading (#FEF08A) + Borders (outside, double, #DC2626)
        self.run_table_dialog(
            "table.shading",
            tab_label,
            lambda: self.click("[data-testid=shading-swatch-FEF08A]"),
        )
        self.settle(fmt)

        def setup_borders():
            self.click("[data-testid=border-kind-outside]")
            self.d.js(
                "const el=document.querySelector('[data-testid=table-border-style]');"
                "const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;"
                "set.call(el,'double');el.dispatchEvent(new Event('change',{bubbles:true}))"
            )
            self.set_input_value("table-border-color", "#DC2626")

        self.run_table_dialog("table.borders", tab_label, setup_borders)
        self.settle(fmt)

        # P3-2: Alignment (horizontal center, vertical bottom)
        def setup_align():
            self.click("[data-testid=align-h-center]")
            self.click("[data-testid=align-v-bottom]")

        self.run_table_dialog("table.alignment", tab_label, setup_align)
        self.settle(fmt)

        # P3-3: Column width (125 pt) & Row height (36 pt)
        self.run_table_dialog(
            "table.columnWidth",
            tab_label,
            lambda: self.set_input_value("table-col-width", "125"),
        )
        self.settle(fmt)

        self.run_table_dialog(
            "table.rowHeight",
            tab_label,
            lambda: self.set_input_value("table-row-height", "36"),
        )
        self.settle(fmt)

        # Undo -> confirm row height reverted -> Redo -> confirm 36 restored
        self.toolbar_cmd("edit.undo", home_label)
        self.settle(fmt)
        undone_h = self.read_table_dialog(
            "table.rowHeight",
            tab_label,
            "return document.querySelector('[data-testid=table-row-height]')?.value ?? ''",
        )
        assert undone_h != "36", f"{fmt}: undo did not revert row height ({undone_h})"

        self.toolbar_cmd("edit.redo", home_label)
        self.settle(fmt)
        redone_h = self.read_table_dialog(
            "table.rowHeight",
            tab_label,
            "return document.querySelector('[data-testid=table-row-height]')?.value ?? ''",
        )
        assert redone_h == "36", f"{fmt}: redo did not restore row height ({redone_h})"

        # Safe save via real Ctrl+S
        saved = self.save(fmt)
        assert out_path.is_file() and out_path.stat().st_size > 0
        self.d.screenshot(self.args.out / f"p3-{fmt}-saved.png")
        assert rhwp_poc.close_tab(self.d, out_path.name)

        # Independent reopen
        self.open_native(fmt, out_path)
        reopened = self.sessions()[0]
        assert not reopened["dirty"] and reopened["revision"] == 0, reopened
        self.settle(fmt)

        # Read back persisted dialog state after reopen: scroll table into view and click cell (0,0) on canvas
        prefix = "docx" if fmt == "docx" else "rhwp"
        self.tab(tab_label)
        self.command(self.args.xdotool, "windowfocus", "--sync", self.window)
        scale = self.d.js("return devicePixelRatio")
        coords = self.d.js(
            "const s=document.querySelector('.editor__scroll'),c=s?.querySelector('canvas');"
            "if(!s||!c)return null;"
            "s.scrollTop = Math.max(0, c.offsetTop + 40);"
            "const sr=s.getBoundingClientRect(), cr=c.getBoundingClientRect();"
            "const top=Math.max(sr.top+15, cr.top+40), bot=Math.min(sr.bottom-10, cr.bottom-10);"
            "return {x:cr.left+170, top, bot};"
        )
        y = coords["top"]
        while y <= coords["bot"]:
            in_tbl = self.d.js(
                f"const s=document.querySelector('[data-testid={prefix}-status]');"
                f"return arguments[0]==='docx' ? s?.dataset.inTable==='true' : Boolean(s?.dataset.caret?.includes('@'));",
                fmt,
            )
            if in_tbl:
                break
            self.command(
                self.args.xdotool,
                "mousemove",
                "--window",
                self.window,
                str(round(coords["x"] * scale)),
                str(round(y * scale)),
                "click",
                "1",
            )
            self.settle(fmt)
            y += 18
        if fmt != "docx":
            for _ in range(4):
                c = self.d.js("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret ?? ''")
                if "@0/0/" in c:
                    break
                self.key("shift+Tab")
                self.settle(fmt)

        shade_after = self.read_table_dialog(
            "table.shading",
            tab_label,
            "return document.querySelector('[data-testid=table-shading-color]')?.value ?? ''",
        )
        align_after = self.read_table_dialog(
            "table.alignment",
            tab_label,
            "return {h:document.querySelector('[data-testid=align-h-center]')?.getAttribute('aria-pressed'),"
            "v:document.querySelector('[data-testid=align-v-bottom]')?.getAttribute('aria-pressed')}",
        )
        col_after = self.read_table_dialog(
            "table.columnWidth",
            tab_label,
            "return document.querySelector('[data-testid=table-col-width]')?.value ?? ''",
        )
        row_after = self.read_table_dialog(
            "table.rowHeight",
            tab_label,
            "return document.querySelector('[data-testid=table-row-height]')?.value ?? ''",
        )
        assert shade_after.upper() == "#FEF08A", (fmt, shade_after)
        assert align_after == {"h": "true", "v": "true"}, (fmt, align_after)
        assert float(col_after) == 125.0, (fmt, col_after)
        assert float(row_after) == 36.0, (fmt, row_after)

        self.d.screenshot(self.args.out / f"p3-{fmt}-reopened.png")
        assert rhwp_poc.close_tab(self.d, out_path.name)

        # Independent package verification on disk
        if fmt == "docx":
            with zipfile.ZipFile(out_path) as zf:
                assert zf.testzip() is None
                doc_xml = zf.read("word/document.xml").decode("utf-8")
                assert "FEF08A" in doc_xml
                assert 'w:val="double"' in doc_xml
                assert "DC2626" in doc_xml
                assert 'w:val="center"' in doc_xml
                assert 'w:val="bottom"' in doc_xml
                assert "2500" in doc_xml and "720" in doc_xml
                assert "A1" in doc_xml and "B1" in doc_xml
        elif fmt == "hwpx":
            with zipfile.ZipFile(out_path) as zf:
                assert zf.testzip() is None
                hdr = zf.read("Contents/header.xml").decode("utf-8")
                sec = zf.read("Contents/section0.xml").decode("utf-8")
                assert "FEF08A" in hdr and "DC2626" in hdr and "DOUBLE" in hdr
                assert "BOTTOM" in sec and "12500" in sec and "3600" in sec
                assert "A1" in sec and "B1" in sec
        else:
            spec_o = importlib.util.spec_from_file_location("nd_struct", ROOT / "scripts/tests/new-document-structure.py")
            oracle = importlib.util.module_from_spec(spec_o)
            spec_o.loader.exec_module(oracle)
            streams = oracle.cfb_streams(out_path.read_bytes())
            assert streams["FileHeader"][35] == 5

        return {
            "format": fmt,
            "status": "PASS",
            "saved": saved,
            "reopenedState": {
                "shading": shade_after,
                "alignment": align_after,
                "colWidth": col_after,
                "rowHeight": row_after,
            },
        }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    p.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--port", type=int, default=4596)
    p.add_argument("--formats", nargs="+", choices=["docx", "hwpx", "hwp"], default=["docx", "hwpx", "hwp"])
    args = p.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    args.xdotool, args.ibus = "xdotool", "ibus"
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / "driver.log"
    report = {"status": "RUNNING", "app": smoke.APP, "results": []}
    with smoke.tauri_driver(args.driver, args.port, str(args.out / "data")) as start:
        d = start()
        try:
            smoke.wait_until(d, "return !!document.querySelector('.document-bar') && !!document.querySelector('.ribbon')", timeout=60)
            acc = P3Acceptance(args, d, report)
            acc.click(".ribbon__collapse")
            for fmt in args.formats:
                res = acc.verify_format(fmt)
                report["results"].append(res)
                print(f"PASS {fmt}: {res['reopenedState']}", flush=True)
            report["status"] = "PASS"
        except Exception as exc:
            report["status"] = "FAIL"
            report["error"] = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
            try:
                d.screenshot(args.out / "failure.png")
            except Exception:
                pass
            raise
        finally:
            try:
                smoke.end_session(d)
            finally:
                (args.out / "acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
