#!/usr/bin/env python3
"""Native acceptance: Enter inside a cell of a newly inserted table in a New HWP document saves.

Run under scripts/tests/native-ibus-session.py:
  python3 scripts/tests/native-ibus-session.py --out /tmp/geul-hwp-enter -- \
    python3 scripts/tests/hwp-new-table-enter-native.py --out /tmp/geul-hwp-enter --xdotool @XDOTOOL@ --ibus @IBUS@

In the actual Release desktop app: New HWP (product blank) -> insert.table 2x2 -> type "AB" in (0,0) ->
Enter between A and B (a real paragraph split, not a taller row) -> Undo/Redo checked through the caret ->
neighbour text -> Ctrl+S must report "saved" with no findings -> close -> reopen through the native Open
dialog -> the caret proves two paragraphs in (0,0) -> independent Release WASM disk oracle.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
P4_SPEC = importlib.util.spec_from_file_location("stage2_p4_native_acceptance", ROOT / "scripts/tests/stage2-p4-native-acceptance.py")
p4 = importlib.util.module_from_spec(P4_SPEC)
P4_SPEC.loader.exec_module(p4)
rhwp_poc, smoke, KO = p4.rhwp_poc, p4.smoke, p4.KO


class EnterAcceptance(p4.P4Acceptance):
    def caret(self) -> tuple[int, int, int]:
        """(cell, cellParagraph, offset) from the RHWP caret key `s:p:o@control/cell/cellParagraph`."""
        key = self.status("hwp").get("caret") or ""
        head, _, cell = key.partition("@")
        assert cell, f"caret not in a cell: {key!r}"
        parts = cell.split("/")
        return int(parts[1]), int(parts[2].split(">")[0]), int(head.rsplit(":", 1)[-1])

    def run_case(self):
        path = self.args.out / "enter.hwp"
        row = {"format": "hwp", "status": "RUNNING", "steps": []}
        self.report["formats"].append(row)
        self.new("hwp", path)
        self.ready("hwp", path.name)
        row["blankSha256"] = p4.sha256(path)
        self.engine("xkb:us::eng")
        self.toolbar_cmd("insert.table", KO["ribbon.tab.insert"])
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')!==null")
        self.set_input_value("command-input-rows", "2")
        self.set_input_value("command-input-cols", "2")
        self.key("Return")
        self.wait("return document.querySelector('[data-testid=command-input-dialog]')===null")
        self.settle("hwp")
        assert self.caret()[:2] == (0, 0), self.caret()
        cell0 = self.caret_rel_point()
        self.type("AB")
        self.settle("hwp")
        self.key("Left")
        self.settle("hwp")
        assert self.caret() == (0, 0, 1), self.caret()
        self.key("Return")
        self.settle("hwp")
        assert self.caret() == (0, 1, 0), f"Enter did not split the cell paragraph: {self.caret()}"
        self.key("End")
        self.settle("hwp")
        assert self.caret() == (0, 1, 1), f"second paragraph is not 'B': {self.caret()}"
        row["steps"].append("enter_split PASS")

        self.key("ctrl+z")
        self.settle("hwp")
        self.click_cell_pt("hwp", cell0)
        self.key("End")
        self.settle("hwp")
        assert self.caret() == (0, 0, 2), f"Undo did not rejoin 'AB': {self.caret()}"
        self.key("ctrl+y")
        self.settle("hwp")
        self.click_cell_pt("hwp", cell0)
        self.key("End")
        self.settle("hwp")
        assert self.caret() == (0, 0, 1), f"Redo did not restore 'A': {self.caret()}"
        self.key("Down")
        self.settle("hwp")
        self.key("End")
        self.settle("hwp")
        assert self.caret() == (0, 1, 1), f"Redo did not restore 'B': {self.caret()}"
        row["steps"].append("undo_redo PASS")

        self.move_next_cell("hwp")
        assert self.caret()[:2] == (1, 0), self.caret()
        self.type("N")
        self.settle("hwp")

        row["save"] = self.save("hwp")
        assert row["save"].get("findings", "") == "", f"unexplained findings: {row['save']}"
        row["savedSha256"] = p4.sha256(path)
        self.d.screenshot(self.args.out / "hwp-saved.png")
        row["steps"].append("t009_save PASS")
        assert rhwp_poc.close_tab(self.d, path.name), "close_tab requested discard after save"

        self.open_native("hwp", path)
        self.settle("hwp")
        self.click_cell_pt("hwp", cell0)
        self.key("End")
        self.settle("hwp")
        assert self.caret() == (0, 0, 1), f"reopened first paragraph is not 'A': {self.caret()}"
        self.key("Down")
        self.settle("hwp")
        self.key("End")
        self.settle("hwp")
        assert self.caret() == (0, 1, 1), f"reopened second paragraph is not 'B': {self.caret()}"
        self.d.screenshot(self.args.out / "hwp-reopened.png")
        row["steps"].append("native_reopen PASS")
        assert rhwp_poc.close_tab(self.d, path.name)

        row["diskCheck"] = self.disk(path)
        row["steps"].append("independent_disk_check PASS")
        row["status"] = "PASS"

    def disk(self, path: Path) -> dict:
        build = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text(encoding="utf-8"))
        wasm_js = ROOT / "public/rhwp/generations" / build["generation"] / "rhwp.js"
        script = """
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [wasmJs, hwpPath] = process.argv.slice(1);
const mod = await import(pathToFileURL(wasmJs).href);
mod.initSync({ module: fs.readFileSync(wasmJs.replace(/rhwp\\.js$/, 'rhwp_bg.wasm')) });
const doc = new mod.HwpDocument(fs.readFileSync(hwpPath));
const t = JSON.parse(doc.getControls()).find(c => c.ctrlId === 'tbl');
const cells = [0, 1, 2, 3].map(c => Array.from({ length: doc.getCellParagraphCount(0, t.para, t.controlIndex, c) },
  (_, p) => doc.getTextInCell(0, t.para, t.controlIndex, c, p, 0, doc.getCellParagraphLength(0, t.para, t.controlIndex, c, p))));
const dims = JSON.parse(doc.getTableDimensions(0, t.para, t.controlIndex));
const shapes = [0, 1].map(p => JSON.parse(doc.getCellCharPropertiesAt(0, t.para, t.controlIndex, 0, p, 0)).charShapeId);
console.log(JSON.stringify({ cells, dims, shapes, format: doc.getSourceFormat() }));
doc.free();
"""
        parsed = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, str(wasm_js), str(path)], text=True))
        assert parsed["format"] == "hwp", parsed
        assert parsed["cells"] == [["A", "B"], ["N"], [""], [""]], parsed
        assert parsed["dims"]["rowCount"] == 2 and parsed["dims"]["colCount"] == 2 and parsed["dims"]["cellCount"] == 4, parsed
        assert parsed["shapes"][0] == parsed["shapes"][1], f"split paragraphs differ in character shape: {parsed}"
        parsed["wasmGeneration"] = build["generation"]
        return parsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--xdotool", default="xdotool")
    parser.add_argument("--ibus", default="ibus")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--port", type=int, default=4466)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    build = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text(encoding="utf-8"))
    report = {"status": "RUNNING", "formats": [],
              "sourceHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "appSha256": p4.sha256(args.app), "rhwpWasmGeneration": build["generation"]}
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / "driver.log"
    d = None
    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / "data")) as start:
            d = start()
            acc = EnterAcceptance(args, d, report)
            acc.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            acc.focus_window()
            acc.calibrate_pointer()
            acc.run_case()
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
