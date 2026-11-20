#!/usr/bin/env python3
"""Stage 3-B Release Linux X11 GUI acceptance. Run under native-ibus-session.py."""
import argparse
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import traceback

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load("native-stage3-c")
p6 = c.p6
p4 = c.p4
FRAME = c.FRAME
SHAPE = p6.SHAPE
TOOLS = p6.TOOLS
require = c.require
digest = c.digest
begin = c.begin
revision = c.revision
publish = c.publish
reopen = c.reopen
select_object = c.select_object


def inspect_hwp(path):
    return c.inspect_rhwp(path, """
      const all = pages.flatMap((p, page) => p.map(item => ({...item, page})));
      const withProps = type => all.filter(x => x.type === type).map(x => ({
        ...x,
        props: JSON.parse((type === 'image' ? doc.getPictureProperties : doc.getShapeProperties)
          .call(doc, x.secIdx, x.paraIdx, x.controlIdx)),
      }));
      const readCellTexts = (owner, cell) => {
        const count = doc.getCellParagraphCount(owner.secIdx, owner.paraIdx, owner.controlIdx, cell);
        return Array.from({length: count}, (_, i) => {
          const len = doc.getCellParagraphLength(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, i);
          return doc.getTextInCell(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, i, 0, len);
        });
      };
      const caption = (owner, cell) => {
        const len = doc.getCellParagraphLength(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, 0);
        return {
          cell,
          texts: readCellTexts(owner, cell),
          end: JSON.parse(doc.getCursorRectInCell(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, 0, len)),
        };
      };
      const images = withProps('image').map(img => ({
        ...img,
        caption: img.props.hasCaption ? caption(img, 0) : null,
      }));
      const shapes = withProps('shape').map(shp => ({
        ...shp,
        caption: shp.props.hasCaption ? caption(shp, 65534) : null,
      }));
      const groups = withProps('group');
      console.log(JSON.stringify({body, controls, images, shapes, groups}));
    """)


def inspect_hwpx_clip(path):
    return c.inspect_rhwp(path, """
      const all = pages.flatMap((p, page) => p.map(item => ({...item, page})));
      const shapes = all.filter(x => x.type === 'shape' || x.type === 'group').map(x => {
        const props = JSON.parse(doc.getShapeProperties(x.secIdx, x.paraIdx, x.controlIdx));
        let capTexts = null, capBold = null, boxTexts = null, boxAlign = null, boxRun = null;
        if (props.hasCaption) {
          const cnt = doc.getCellParagraphCount(x.secIdx, x.paraIdx, x.controlIdx, 65534);
          capTexts = Array.from({length: cnt}, (_, i) => {
            const len = doc.getCellParagraphLength(x.secIdx, x.paraIdx, x.controlIdx, 65534, i);
            return doc.getTextInCell(x.secIdx, x.paraIdx, x.controlIdx, 65534, i, 0, len);
          });
          const p0Len = doc.getCellParagraphLength(x.secIdx, x.paraIdx, x.controlIdx, 65534, 0);
          capBold = p0Len > 0 ? JSON.parse(doc.getCellCharPropertiesAt(x.secIdx, x.paraIdx, x.controlIdx, 65534, 0, p0Len - 1)).bold : null;
        }
        try {
          const bcnt = doc.getCellParagraphCount(x.secIdx, x.paraIdx, x.controlIdx, 0);
          if (bcnt > 0) {
            boxTexts = Array.from({length: bcnt}, (_, i) => {
              const len = doc.getCellParagraphLength(x.secIdx, x.paraIdx, x.controlIdx, 0, i);
              return doc.getTextInCell(x.secIdx, x.paraIdx, x.controlIdx, 0, i, 0, len);
            });
            const bp = JSON.stringify([{controlIndex: x.controlIdx, cellIndex: 0, cellParaIndex: 0}]);
            boxAlign = JSON.parse(doc.getCellParaPropertiesAtByPath(x.secIdx, x.paraIdx, bp)).alignment;
            if (boxTexts[0].length > 7) {
              boxRun = JSON.parse(doc.getCellCharPropertiesAt(x.secIdx, x.paraIdx, x.controlIdx, 0, 0, 7));
            }
          }
        } catch {}
        return {...x, props, capTexts, capBold, boxTexts, boxAlign, boxRun};
      });
      console.log(JSON.stringify({body, shapes}));
    """)


def prepare_b3_2_fixtures(staging: Path):
    src_path = staging / "b3-2-source.hwpx"
    dst_path = staging / "b3-2-dest.hwpx"
    dst2_path = staging / "b3-2-dest-refusal.hwpx"
    node_script = p6.ORACLE.split("try {", 1)[0].replace(
        "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));",
        """
        const srcDoc = rhwp.HwpDocument.createEmpty();
        srcDoc.createBlankDocument();
        srcDoc.insertText(0, 0, 0, 'B3.2 portable source');
        const capRect = JSON.parse(srcDoc.createShapeControl(JSON.stringify({
          sectionIdx:0, paraIdx:0, charOffset:0, shapeType:'rectangle',
          width:4800, height:3000, treatAsChar:false, textWrap:'Square', horzOffset:1500, vertOffset:1500
        })));
        if (!capRect.ok) throw Error('capRect create failed');
        JSON.parse(srcDoc.setShapeProperties(0,0,capRect.controlIdx,
          '{"hasCaption":true,"captionDirection":"Top","fillType":"solid","fillBgColor":11223344}'));
        const capLen = srcDoc.getCellParagraphLength(0,0,capRect.controlIdx,65534,0);
        srcDoc.insertTextInCell(0,0,capRect.controlIdx,65534,0,capLen,'cap bold');
        srcDoc.applyCharFormatInCellByPath(0,0,JSON.stringify([{controlIndex:capRect.controlIdx,cellIndex:65534,cellParaIndex:0}]),capLen+4,capLen+8,'{"bold":true}');
        srcDoc.splitParagraphInCell(0,0,capRect.controlIdx,65534,0,capLen+8);
        srcDoc.insertTextInCell(0,0,capRect.controlIdx,65534,1,0,'cap line 2');

        const mixBox = JSON.parse(srcDoc.createShapeControl(JSON.stringify({
          sectionIdx:0, paraIdx:0, charOffset:0, shapeType:'textbox',
          width:5200, height:3200, treatAsChar:false, textWrap:'Square', horzOffset:9000, vertOffset:1500
        })));
        if (!mixBox.ok) throw Error('mixBox create failed');
        srcDoc.insertTextInCell(0,0,mixBox.controlIdx,0,0,0,'plain bold');
        const bp = JSON.stringify([{controlIndex:mixBox.controlIdx,cellIndex:0,cellParaIndex:0}]);
        srcDoc.applyCharFormatInCellByPath(0,0,bp,6,10,'{"bold":true,"italic":true,"fontSize":1400,"textColor":"#cc2200","shadeColor":"#ffff00"}');
        srcDoc.applyParaFormatInCellByPath(0,0,bp,'{"alignment":"center"}');
        srcDoc.splitParagraphInCell(0,0,mixBox.controlIdx,0,0,10);
        srcDoc.insertTextInCell(0,0,mixBox.controlIdx,0,1,0,'second line');
        fs.writeFileSync(process.argv[1], srcDoc.exportHwpx());
        srcDoc.free();

        const dstDoc = rhwp.HwpDocument.createEmpty();
        dstDoc.createBlankDocument();
        dstDoc.insertText(0, 0, 0, 'Destination document body');
        const dstBytes = dstDoc.exportHwpx();
        fs.writeFileSync(process.argv[2], dstBytes);
        fs.writeFileSync(process.argv[3], dstBytes);
        dstDoc.free();
        process.exit(0);
        """,
    )
    subprocess.check_call(["node", "-e", node_script, str(src_path), str(dst_path), str(dst2_path)], cwd=ROOT)
    return src_path, dst_path, dst2_path


def b1_1(acc, row, b_root, out):
    fixture = b_root / "b1/b1-1-multi-layer-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    require(len(before["shapes"]) == 3, "expected 3 shapes in B1.1 fixture", before["shapes"])
    s2, s3, s4 = sorted(before["shapes"], key=lambda s: s["props"]["zOrder"])
    path = begin(acc, row, fixture, out, "b1-1.hwp")
    overlap_pt = (0, s2["x"] + s2["w"] - 10, s2["y"] + s2["h"] - 10)

    def hit_at(pt, expected):
        p6.pointer(acc, pt)
        acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='shape'", FRAME, timeout=8)
        g = c.frame(acc)
        scale = g["width"] / expected["w"]
        c.require_near(g["left"], expected["x"] * scale, "layer hit identity x")
        return g

    hit_at(overlap_pt, s4)
    acc.dom_click(SHAPE + " button", "Array.from(document.querySelectorAll(arguments[0])).find(b=>b.textContent.trim()===" + json.dumps(p4.KO["properties.shape.back"]) + ")")
    revision(acc, "hwp", 1)
    # s2 (zOrder 0) sits behind s3 (zOrder 1); click its non-overlapping top-left corner and bring it to front.
    s2_free = (0, s2["x"] + 6, s2["y"] + 6)
    hit_at(s2_free, s2)
    acc.dom_click(SHAPE + " button", "Array.from(document.querySelectorAll(arguments[0])).find(b=>b.textContent.trim()===" + json.dumps(p4.KO["properties.shape.front"]) + ")")
    revision(acc, "hwp", 2)
    hit_at(overlap_pt, s2)
    acc.key("ctrl+z")
    revision(acc, "hwp", 3)
    hit_at(overlap_pt, s3)
    acc.key("ctrl+y")
    revision(acc, "hwp", 4)
    hit_at(overlap_pt, s2)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    orders = {s["controlIdx"]: s["props"]["zOrder"] for s in after["shapes"]}
    row["savedZOrders"] = orders
    require(orders[s2["controlIdx"]] > orders[s3["controlIdx"]] > orders[s4["controlIdx"]], "multi z-order final order mismatch", orders)
    require(after["body"] == before["body"], "body changed")
    for a, b in zip(sorted(before["shapes"], key=lambda x: x["controlIdx"]), sorted(after["shapes"], key=lambda x: x["controlIdx"])):
        require(a["props"]["width"] == b["props"]["width"] and a["props"]["height"] == b["props"]["height"], "geometry changed", [a, b])
    reopen(acc, path, row)
    hit_at(overlap_pt, s2)


def b1_2(acc, row, b_root, out):
    fixture = b_root / "b1/b1-2-combined-caption-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    shp = before["shapes"][0]
    require(shp["props"]["hasCaption"] and shp["caption"], "expected captioned shape", shp)
    path = begin(acc, row, fixture, out, "b1-2.hwp")
    select_object(acc, shp, "shape")
    handles = acc.d.js("return [...document.querySelectorAll('[data-handle]')].map(e=>e.dataset.handle)")
    row["handles"] = handles
    require(all(h not in handles for h in ("nw", "n", "ne", "w", "sw")), "Stage 3-C west/north handles must stay hidden", handles)
    width_absent = acc.d.js("return document.querySelector(arguments[0]) === null", c.WIDTH)
    row["captionedOutlineWidthDisabled"] = width_absent
    require(width_absent, "outline width on captioned shape must stay absent/disabled", width_absent)
    rect = shp["caption"]["end"]
    p6.pointer(acc, (rect["pageIndex"], rect["x"] + 1, rect["y"] + rect["height"] / 2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    acc.key("End")
    acc.type("X")
    revision(acc, "hwp", 1)
    select_object(acc, shp, "shape")
    fill_input = SHAPE + " > label input[type=color]"
    p6.color(acc, fill_input, "#884422")
    revision(acc, "hwp", 2)
    select_object(acc, shp, "shape")
    acc.dom_click(p6.gso.FLIPS, "document.querySelectorAll(arguments[0])[1]")
    acc.dom_click(SHAPE + " form:has(input[max='3600']) button")
    revision(acc, "hwp", 3)
    acc.key("ctrl+z")
    revision(acc, "hwp", 4)
    acc.key("ctrl+y")
    revision(acc, "hwp", 5)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    saved = after["shapes"][0]
    require(saved["caption"]["texts"][0] == shp["caption"]["texts"][0] + "X", "caption text not saved", saved["caption"])
    rgb = "#" + saved["props"]["fillBgColor"].to_bytes(3, "little").hex()
    require(saved["props"]["fillType"] == "solid" and rgb == "#884422", "fill not saved", [saved["props"]["fillType"], rgb])
    require(saved["props"]["vertFlip"] is True, "vertFlip not saved", saved["props"])
    require([c_["ctrlId"] for c_ in after["controls"] if c_["ctrlId"] == "atno"] ==
            [c_["ctrlId"] for c_ in before["controls"] if c_["ctrlId"] == "atno"], "atno count changed")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)
    select_object(acc, saved, "shape")
    require(p6.value(acc, fill_input) == "#884422", "reopened fill color")


def b2_1(acc, row, b_root, out):
    fixture = b_root / "b2/b2-1-caption-delete-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    cap_img = next(i for i in before["images"] if i["props"]["hasCaption"])
    cap_shp = next(s for s in before["shapes"] if s["controlIdx"] == 5)
    path = begin(acc, row, fixture, out, "b2-1.hwp")
    select_object(acc, cap_img, "picture")
    acc.key("Delete")
    revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    revision(acc, "hwp", 2)
    acc.key("ctrl+y")
    revision(acc, "hwp", 3)
    select_object(acc, cap_shp, "shape")
    acc.key("Delete")
    revision(acc, "hwp", 4)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    require(len(after["images"]) == len(before["images"]) - 1, "captioned picture not deleted")
    require(len(after["shapes"]) == len(before["shapes"]) - 1, "captioned shape not deleted")
    require(after["shapes"][0]["caption"]["texts"] == before["shapes"][0]["caption"]["texts"], "sibling caption affected")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)
    select_object(acc, after["shapes"][0], "shape")


def b2_2(acc, row, b_root, out):
    fixture = b_root / "b2/b2-2-group-delete-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    require(len(before["groups"]) == 1, "expected 1 group", before["groups"])
    group = before["groups"][0]
    path = begin(acc, row, fixture, out, "b2-2.hwp")
    select_object(acc, group, "group")
    handles = acc.d.js("return [...document.querySelectorAll('[data-handle]')].map(e=>e.dataset.handle)")
    row["handles"] = handles
    require(all(h not in handles for h in ("nw", "n", "ne", "w", "sw")), "Stage 3-C west/north handles must stay hidden on group", handles)
    acc.key("Delete")
    revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    revision(acc, "hwp", 2)
    select_object(acc, group, "group")
    acc.key("ctrl+y")
    revision(acc, "hwp", 3)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    require(len(after["groups"]) == 0, "group not deleted", after["groups"])
    require(after["images"] == before["images"] and after["body"] == before["body"], "sibling image or body affected")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)


def b3_1(acc, row, b_root, out):
    fixture = b_root / "b3/b3-1-copy-paste-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    shp3 = next(s for s in before["shapes"] if s["controlIdx"] == 3)
    shp4 = next(s for s in before["shapes"] if s["controlIdx"] == 4)
    path = begin(acc, row, fixture, out, "b3-1.hwp")
    select_object(acc, shp3, "shape")
    acc.key("ctrl+c")
    c.body_end(acc)
    acc.key("ctrl+v")
    revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    revision(acc, "hwp", 2)
    acc.key("ctrl+y")
    revision(acc, "hwp", 3)
    select_object(acc, shp4, "textBox")
    acc.key("ctrl+x")
    revision(acc, "hwp", 4)
    c.body_end(acc)
    acc.key("ctrl+v")
    revision(acc, "hwp", 5)

    # Negative check: cross-document HWP5 paste MUST refuse before history/dirty change
    other = out / "b3-1-cross-doc-dst.hwp"
    shutil.copyfile(b_root / "b2/b2-2-group-delete-original.hwp", other)
    other_hash = digest(other)
    acc.open_native("hwp", other)
    other_init = acc.status("hwp")
    acc.key("ctrl+v")
    acc.settle("hwp")
    other_after = acc.status("hwp")
    for k in ("revision", "localRevision", "dirty", "paragraphText"):
        require(other_after[k] == other_init[k], f"HWP5 cross-doc paste modified {k}", other_after)
    require(digest(other) == other_hash, "HWP5 cross-doc paste modified file on disk")
    row["negativeCrossDocHwp5"] = "refused"
    require(p4.rhwp_poc.close_tab(acc.d, other.name), "cross-doc tab did not close")

    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    require(len(after["shapes"]) == len(before["shapes"]) + 1, "expected +1 copied shape after copy+paste and cut+paste", after["shapes"])
    require([p for p in after["body"] if p != ""] == [p for p in before["body"] if p != ""], "HWP5 clipboard changed body text")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)


def b3_2(acc, row, b_root, out):
    staging = out / "b3-2-staging"
    staging.mkdir(parents=True, exist_ok=True)
    src_orig, dst_orig, dst_refusal = prepare_b3_2_fixtures(staging)
    src = out / "b3-2-source.hwpx"
    dst = out / "b3-2-dest.hwpx"
    shutil.copyfile(src_orig, src)
    shutil.copyfile(dst_orig, dst)
    src_hash = digest(src)
    before_src = row["beforeSource"] = inspect_hwpx_clip(src)
    cap_rect = next(s for s in before_src["shapes"] if s["props"]["hasCaption"])
    mix_box = next(s for s in before_src["shapes"] if s["boxTexts"] is not None)

    acc.open_native("hwpx", src)
    row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
    select_object(acc, cap_rect, "shape")
    acc.key("ctrl+c")

    acc.open_native("hwpx", dst)
    acc.key("ctrl+v")
    revision(acc, "hwpx", 1)

    # Switch back to source tab to copy mixed TextBox
    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(src.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", src.name)
    select_object(acc, mix_box, "textBox")
    acc.key("ctrl+c")

    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(dst.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", dst.name)
    c.body_end(acc)
    acc.key("ctrl+v")
    revision(acc, "hwpx", 2)
    acc.key("ctrl+z")
    revision(acc, "hwpx", 3)
    acc.key("ctrl+y")
    revision(acc, "hwpx", 4)

    publish(acc, "hwpx", row)
    require(digest(src) == src_hash, "B3.2 modified source HWPX on disk")
    after = row["after"] = inspect_hwpx_clip(dst)
    require(len(after["shapes"]) == 2, "expected 2 pasted HWPX objects", after["shapes"])
    pasted_cap = next(s for s in after["shapes"] if s["props"]["hasCaption"])
    pasted_box = next(s for s in after["shapes"] if s["boxTexts"] is not None)
    require(pasted_cap["capTexts"][0].endswith("cap bold") and pasted_cap["capTexts"][1] == "cap line 2" and pasted_cap["capBold"] is True,
            "captioned rectangle fidelity lost", pasted_cap)
    require(pasted_box["boxTexts"] == ["plain bold", "second line"] and pasted_box["boxAlign"] == "center",
            "mixed textbox paragraph/alignment lost", pasted_box)
    require(pasted_box["boxRun"]["bold"] is True and pasted_box["boxRun"]["italic"] is True
            and pasted_box["boxRun"]["textColor"] == "#cc2200" and pasted_box["boxRun"]["shadeColor"] == "#ffff00",
            "mixed textbox run fidelity lost", pasted_box["boxRun"])

    # Negative refusals on a clean third document
    acc.open_native("hwpx", dst_refusal)
    ref_init = acc.status("hwpx")
    ref_hash = digest(dst_refusal)
    row["negative"] = {}

    def verify_refused(label):
        acc.settle("hwpx")
        cur = acc.status("hwpx")
        for k in ("revision", "localRevision", "dirty", "paragraphText"):
            require(cur[k] == ref_init[k], f"{label} changed {k}", cur)
        require(digest(dst_refusal) == ref_hash, f"{label} changed file on disk")
        row["negative"][label] = "refused"

    # Orphan marker
    c.clipboard_peer(acc, "UTF8_STRING", "Geul shape [" + "0" * 24 + "]", lambda: (acc.key("ctrl+v"), verify_refused("orphan marker")))
    # Tampered portable group payload
    fake_group = json.dumps({
        "kind": "geul.object", "version": 3, "sourceFormat": "hwpx", "object": "group",
        "sourceSessionId": 999999, "sourceGeneration": row["activeGeneration"],
        "token": "a" * 24, "portable": {"format": "hwpx", "object": "shape", "shapeType": "rectangle", "props": {"width": 2000, "height": 2000}}
    })
    c.clipboard_peer(acc, "application/x-geul-object+json", fake_group, lambda: (acc.key("ctrl+v"), verify_refused("tampered cross-doc group")), plain="Geul group [" + "a" * 24 + "]")

    require(p4.rhwp_poc.close_tab(acc.d, dst_refusal.name), "refusal tab close")
    reopen(acc, dst, row)
    select_object(acc, pasted_cap, "shape")
    acc.key("Escape")


CASES = {
    "B1-1": b1_1,
    "B1-2": b1_2,
    "B2-1": b2_1,
    "B2-2": b2_2,
    "B3-1": b3_1,
    "B3-2": b3_2,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--b-root", type=Path, default=ROOT / "target/stage3b-safety")
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.b_root = args.b_root.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    app = args.app.resolve()
    p4.smoke.APP = str(app)
    release = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())
    report = {"appSha256": digest(app), "os": platform.platform(), "rhwp": release["generation"], "cases": {}}
    for case in args.cases:
        row = report["cases"][case] = {}
        p4.smoke.DRIVER_LOG = str(args.out / (case + "-driver.log"))
        try:
            with tempfile.TemporaryDirectory(prefix="geul-stage3b-") as profile:
                with p4.smoke.tauri_driver(args.driver, 4469, profile) as start:
                    driver = start()
                    try:
                        acc = p4.P4Acceptance(args, driver, row)
                        acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                        acc.focus_window()
                        pid = int(acc.command(args.xdotool, "getwindowpid", acc.window))
                        row["appPid"] = pid
                        row["processAppSha256"] = digest(Path(f"/proc/{pid}/exe"))
                        require(row["processAppSha256"] == report["appSha256"], "unexpected live application binary")
                        acc.calibrate_pointer()
                        CASES[case](acc, row, args.b_root, args.out)
                    except Exception:
                        row["failureAppState"] = acc.status("hwpx" if case == "B3-2" else "hwp")
                        driver.screenshot(args.out / (case + "-error.png"))
                        raise
                    finally:
                        driver.quit()
            row["status"] = "PASS"
        except Exception:
            row.update(status="FAIL", error=traceback.format_exc())
        row["driverCleanup"] = p4.smoke.TEARDOWN[-1] if p4.smoke.TEARDOWN else None
        (args.out / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(case, row["status"], row.get("error", ""), flush=True)
    return 0 if all(r["status"] == "PASS" for r in report["cases"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
