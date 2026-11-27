#!/usr/bin/env python3
"""Linux X11 acceptance for safe HWP5 caption direction and vertical alignment."""
import argparse
import hashlib
import importlib.util
import json
import shutil
import struct
import subprocess
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("stage3_p6", HERE / "native-stage3-p6.py")
p6 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p6)

from hwp_record_diff import cfb_streams, records, unpacked

FRAME = p6.FRAME
SIDE = "[data-testid=caption-side]"
ALIGN = "[data-testid=caption-vertical-align]"
ORACLE = r"""
const fs=require('fs'),path=require('path'),root=process.cwd();
const m=JSON.parse(fs.readFileSync('public/rhwp/RELEASE.json'));
const p=path.join(root,'public/rhwp/generations',m.generation),r=require(path.join(p,'rhwp.js'));
r.initSync({module:fs.readFileSync(path.join(p,'rhwp_bg.wasm'))});
const d=new r.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const objects=JSON.parse(d.getPageControlLayout(0)).controls.filter(x=>x.type==='shape'||x.type==='image');
  if(objects.length!==1) throw Error('fixture must have one root caption owner');
  const shape=objects[0], picture=shape.type==='image';
  const get=picture?d.getPictureProperties:d.getShapeProperties;
  const set=picture?d.setPictureProperties:d.setShapeProperties;
  const props=JSON.parse(get.call(d,shape.secIdx,shape.paraIdx,shape.controlIdx));
  const a=[shape.secIdx,shape.paraIdx,shape.controlIdx,picture?0:65534], count=d.getCellParagraphCount(...a);
  if(count!==1) throw Error('fixture must have one owned caption paragraph');
  const length=d.getCellParagraphLength(...a,0);
  const captionCaret=()=>JSON.parse(d.getCursorRectInCell(...a,0,length));
  const captionAlignmentPositions={};
  if(props.captionDirection==='Left'||props.captionDirection==='Right') {
    for(const align of ['Top','Center','Bottom']) {
      if(!JSON.parse(set.call(d,shape.secIdx,shape.paraIdx,shape.controlIdx,
        JSON.stringify({hasCaption:true,captionVertAlign:align}))).ok) throw Error('caption alignment oracle refused');
      captionAlignmentPositions[align]=captionCaret();
    }
    if(!JSON.parse(set.call(d,shape.secIdx,shape.paraIdx,shape.controlIdx,
      JSON.stringify({hasCaption:true,captionVertAlign:props.captionVertAlign}))).ok) throw Error('caption alignment restore refused');
  }
  console.log(JSON.stringify({generation:m.generation,kind:shape.type,shape,props,
    caption:{count,text:d.getTextInCell(...a,0,length),caret:captionCaret(),alignmentPositions:captionAlignmentPositions},
    body:d.getTextRange(0,0,0,d.getParagraphLength(0,0)),controls:JSON.parse(d.getControls())}));
} finally {d.free()}
"""


def require(condition, message, observed=None):
    if not condition:
        raise ValueError(f"{message}: {observed!r}")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def oracle(path):
    return json.loads(subprocess.check_output(["node", "-e", ORACLE, str(path)], cwd=ROOT, text=True))


def inspect_owned_caption(path, *, locked=None, expected_kind=None):
    streams = cfb_streams(Path(path).read_bytes())
    rows = records(unpacked(streams, "BodyText/Section0"))
    roots = [(index, payload) for index, (tag, level, payload) in enumerate(rows)
             if (tag, level) == (71, 1)]
    require(len(roots) == 3, "fixture must have its three unambiguous root controls", len(roots))
    require(roots[0][1].startswith(b"dces") and roots[1][1].startswith(b"dloc")
            and roots[2][1].startswith(b" osg"), "unexpected root-control order")
    control_index, header = roots[2]
    require(len(header) >= 46, "missing target GSO header", len(header))
    attr = struct.unpack_from("<I", header, 4)[0]
    require(bool(attr & (1 << 29)), "target GSO has no caption flag", hex(attr))
    if locked is not None:
        require(bool(attr & (1 << 30)) is locked, "target lock flag does not match fixture", hex(attr))
    end = next((i for i in range(control_index + 1, len(rows)) if rows[i][1] <= 1), len(rows))
    child = rows[control_index + 1:end]
    require(bool(child) and child[0][0:2] == (72, 2) and len(child[0][2]) == 30,
            "target has no canonical caption LIST_HEADER")
    list_index = control_index + 1
    listed = child[0][2]
    count = struct.unpack_from("<H", listed)[0]
    require(1 <= count <= 64, "caption paragraph count is outside the supported bound", count)
    shape_indexes = [i for i, row in enumerate(child) if row[0:2] == (76, 2)]
    require(len(shape_indexes) == 1, "target must own one shape component", shape_indexes)
    shape_index = shape_indexes[0]
    component = child[shape_index][2][:8]
    kind = "shape" if component == b"cer$cer$" else "picture" if component == b"cip$cip$" else None
    require(kind in {"shape", "picture"}, "target component is not a supported caption owner", component)
    if expected_kind is not None:
        require(kind == expected_kind, "caption component kind differs from expected owner", [kind, expected_kind])
    prefix = child[1:shape_index]
    require(sum(row[0:2] == (66, 2) for row in prefix) == count
            and all(level >= 2 and (level != 2 or tag == 66) for tag, level, _ in prefix),
            "caption paragraphs do not match their owning list")
    return streams, rows, list_index, {"controlIndex": control_index, "captionListIndex": list_index,
                                      "captionParagraphs": count, "objectKind": kind,
                                      "gsoAttribute": f"0x{attr:08x}"}


def property_without_layout(value):
    return {key: item for key, item in value.items() if key not in ("captionDirection", "captionVertAlign")}


def select_option(acc, selector, choice):
    acc.d.js("""
      const e=document.querySelector(arguments[0]);
      if(!e||e.disabled||![...e.options].some(o=>o.value===arguments[1])) throw Error('caption option unavailable');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,arguments[1]);
      e.dispatchEvent(new Event('change',{bubbles:true}));
    """, selector, choice)


def choose_shape(acc, shape):
    kind = "picture" if shape["type"] == "image" else "shape"
    p6.gso.choose(acc, shape, kind)
    require(acc.d.js("return document.querySelector(arguments[0])?.dataset.objectKind", FRAME) == kind,
            "trusted pointer did not select the exact body caption owner")


def revision(acc, expected, dirty=True):
    acc.wait("""
      const s=document.querySelector('[data-testid=rhwp-status]');
      return +s?.dataset.revision===arguments[0] && s.dataset.localRevision===s.dataset.revision
        && s.dataset.dirty===String(arguments[1]);
    """, expected, dirty, timeout=20)
    acc.settle("hwp")
    return acc.status("hwp")


def prove_saved_package(source, output, before_model, after_model):
    expected_kind = "picture" if before_model["kind"] == "image" else "shape"
    old_streams, old_rows, list_index, owner = inspect_owned_caption(source, locked=False, expected_kind=expected_kind)
    new_streams, new_rows, new_list_index, new_owner = inspect_owned_caption(output, locked=False, expected_kind=expected_kind)
    require(set(old_streams) == set(new_streams), "save changed the CFB stream inventory",
            [sorted(old_streams), sorted(new_streams)])
    changed_streams = sorted(name for name in old_streams if old_streams[name] != new_streams[name])
    require("BodyText/Section0" in changed_streams, "caption fields were not serialized", changed_streams)
    require(set(changed_streams) <= {"BodyText/Section0", "PrvImage"},
            "save changed a stream outside the owned section and its preview", changed_streams)
    if "PrvImage" in changed_streams:
        preview = new_streams["PrvImage"]
        require(preview.startswith(b"\x89PNG\r\n\x1a\n") and len(preview) >= 24,
                "changed HWP preview is not a PNG", preview[:24].hex())
        width, height = struct.unpack_from(">II", preview, 16)
        require(1 <= width <= 4096 and 1 <= height <= 4096, "changed preview dimensions are invalid",
                [width, height])
    require(owner == new_owner, "caption owner metadata changed", [owner, new_owner])
    require(len(old_rows) == len(new_rows), "save changed the HWP5 record count", [len(old_rows), len(new_rows)])
    allowed = {list_index: {4: 0x60, 8: 0x03}}
    require(list_index == new_list_index, "caption LIST_HEADER moved to another owner", [list_index, new_list_index])
    modified = []
    for index, (old, new) in enumerate(zip(old_rows, new_rows)):
        require(old[:2] == new[:2], "save changed record type, level, or order", [index, old[:2], new[:2]])
        if old[2] == new[2]:
            continue
        require(index in allowed and len(old[2]) == len(new[2]),
                "save changed an unrelated record or record payload length", index)
        masks = allowed[index]
        require(all(((left ^ right) & ~masks.get(offset, 0)) == 0
                    for offset, (left, right) in enumerate(zip(old[2], new[2]))),
                "caption LIST_HEADER changed bits outside direction/alignment", index)
        require((old[2][8] & 0x03) != (new[2][8] & 0x03), "caption direction bits did not change")
        require((old[2][4] & 0x60) != (new[2][4] & 0x60), "caption vertical-alignment bits did not change")
        modified.append(index)
    require(modified == [list_index], "expected exactly the owned caption LIST_HEADER to change", modified)
    require(before_model["body"] == after_model["body"], "body text changed")
    require(before_model["shape"]["stableIndex"] == after_model["shape"]["stableIndex"],
            "caption owner identity or address changed")
    require(before_model["shape"]["x"] == after_model["shape"]["x"]
            and before_model["shape"]["y"] == after_model["shape"]["y"]
            and before_model["shape"]["w"] == after_model["shape"]["w"]
            and before_model["shape"]["h"] == after_model["shape"]["h"],
            "caption owner geometry changed")
    require(property_without_layout(before_model["props"]) == property_without_layout(after_model["props"]),
            "caption owner properties outside layout changed")
    require(before_model["controls"] == after_model["controls"], "caption number/control ownership changed")
    require(after_model["props"]["captionDirection"] == "Right"
            and after_model["props"]["captionVertAlign"] == "Center", "saved layout values differ",
            [after_model["props"]["captionDirection"], after_model["props"]["captionVertAlign"]])
    caret = after_model["caption"]["caret"]
    shape = after_model["shape"]
    require(caret["x"] > shape["x"] + shape["w"], "right caption did not render beside its owner",
            [shape, caret])
    if expected_kind == "shape":
        require(abs((caret["y"] + caret["height"] / 2) - (shape["y"] + shape["h"] / 2)) <= 2,
                "center-aligned right caption did not render at the owner midpoint", [shape, caret])
    positions = after_model["caption"]["alignmentPositions"]
    top, center, bottom = (positions[name]["y"] for name in ("Top", "Center", "Bottom"))
    require(top < center < bottom and abs(center - (top + bottom) / 2) <= 0.2,
            "caption vertical alignment did not produce ordered, centered render positions",
            positions)
    return {"changedStreams": changed_streams, "unchangedRecordStructure": True,
            "changedRecordIndexes": modified, "owner": owner,
            "captionListSha256": hashlib.sha256(new_rows[list_index][2]).hexdigest(),
            "savedCaret": caret, "savedShape": shape, "captionAlignmentPositions": positions}


def main_case(acc, out, fixtures, report, picture=False):
    stem = "picture-caption" if picture else "caption"
    source = fixtures / f"{stem}.hwp"
    target = out / f"{stem}-edited.hwp"
    shutil.copyfile(source, target)
    fixture_model = oracle(source)
    expected_kind = "picture" if picture else "shape"
    _, _, _, owner = inspect_owned_caption(source, locked=False, expected_kind=expected_kind)
    require(digest(source) == digest(target), "working copy differs before Native open")
    require(fixture_model["kind"] == ("image" if picture else "shape")
            and fixture_model["props"]["captionWidth"] == 2400
            and fixture_model["props"]["captionSpacing"] == 100,
            "fixture does not exercise positive, serializable lateral-caption geometry",
            fixture_model["props"])
    report.update(fixtureSha256=digest(source), appInputSha256=digest(target), owner=owner,
                  initialModel=fixture_model)
    acc.open_native("hwp", target)
    report["initialSession"] = acc.status("hwp")
    acc.d.js("""
      window.__p6h5capPointers=[];
      window.__p6h5capErrors=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>
        window.__p6h5capPointers.push({type,trusted:e.isTrusted,target:e.target?.className?.baseVal||e.target?.className||e.target?.tagName}),true);
      window.addEventListener('error',e=>window.__p6h5capErrors.push(String(e.error||e.message)));
      window.addEventListener('unhandledrejection',e=>window.__p6h5capErrors.push(String(e.reason)));
    """)
    acc.engine("xkb:us::eng")
    choose_shape(acc, fixture_model["shape"])
    pointer = acc.d.js("return window.__p6h5capPointers.slice()")
    require(len(pointer) >= 2 and all(item["trusted"] for item in pointer[-2:]),
            "caption owner selection did not use trusted X11 pointer events", pointer)
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Bottom",
            "initial caption side control does not match the HWP5 object")
    options = acc.d.js("return [...(document.querySelector(arguments[0])?.options||[])].map(o=>o.value)", SIDE)
    require(options == ["Top", "Bottom", "Left", "Right"],
            "safe lateral caption options were not exposed", options)
    require(acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) is None,
            "vertical alignment appeared for a non-lateral caption")

    select_option(acc, SIDE, "Right")
    time.sleep(0.5)
    side_event = acc.d.js("""
      const e=document.querySelector(arguments[0]), key=e&&Object.keys(e).find(k=>k.startsWith('__reactProps$'));
      const s=document.querySelector('[data-testid=rhwp-status]');
      return {value:e?.value,disabled:e?.disabled,options:e?[...e.options].map(o=>o.value):[],
        status:s?{...s.dataset}:null,panel:document.querySelector('[aria-labelledby=properties-selection]')?.innerText,
        reactOnChange:key?typeof e[key].onChange:null,errors:window.__p6h5capErrors};
    """, SIDE)
    report["afterSideEvent"] = side_event
    (out / "diagnostic-after-side.json").write_text(json.dumps(side_event, ensure_ascii=False, indent=2))
    revision(acc, 1)
    choose_shape(acc, fixture_model["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Right",
            "Native side edit did not update the selected object")
    require(acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) == "Top",
            "right caption vertical alignment control is missing")
    acc.key("ctrl+z")
    report["undoSide"] = revision(acc, 2)
    choose_shape(acc, fixture_model["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Bottom"
            and acc.d.js("return document.querySelector(arguments[0])", ALIGN) is None,
            "Undo did not restore the non-lateral caption direction")
    acc.key("ctrl+y")
    report["redoSide"] = revision(acc, 3)
    choose_shape(acc, fixture_model["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Right"
            and acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) == "Top",
            "Redo did not restore the lateral caption direction")
    select_option(acc, ALIGN, "Center")
    revision(acc, 4)
    choose_shape(acc, fixture_model["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) == "Center",
            "Native alignment edit did not update the selected object")
    acc.key("ctrl+z")
    report["undoAlign"] = revision(acc, 5)
    choose_shape(acc, fixture_model["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Right"
            and acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) == "Top",
            "Undo did not restore the right-caption alignment")
    acc.key("ctrl+y")
    report["redoAlign"] = revision(acc, 6)
    choose_shape(acc, fixture_model["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Right"
            and acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) == "Center",
            "Redo did not restore the final caption layout")
    report["undoRedoRevisions"] = [1, 2, 3, 4, 5, 6]
    report["trustedPointerEvents"] = pointer
    report["save"] = acc.save("hwp")
    require(report["save"].get("state") == "saved" and report["save"].get("synced") == "true"
            and report["save"].get("changedSince") == "false", "T009 save did not complete synchronously",
            report["save"])
    report["savedSha256"] = digest(target)
    saved_model = oracle(target)
    report["serializationProof"] = prove_saved_package(source, target, fixture_model, saved_model)
    report["savedModel"] = saved_model
    report["finalLiveLayout"] = {"kind": saved_model["kind"], "owner": saved_model["shape"],
                                 "captionCaret": saved_model["caption"]["caret"]}
    require(digest(source) == report["fixtureSha256"], "Native editing modified the input fixture")
    require(p6.p4.rhwp_poc.close_tab(acc.d, target.name), "saved Native HWP5 tab did not close")
    acc.open_native("hwp", target)
    report["reopenedSession"] = acc.status("hwp")
    require(report["reopenedSession"].get("dirty") == "false", "saved HWP5 reopened dirty",
            report["reopenedSession"])
    reopened = oracle(target)
    require(reopened["props"] == saved_model["props"] and reopened["caption"] == saved_model["caption"],
            "independent RHWP reopen changed caption layout or rendered placement")
    choose_shape(acc, reopened["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])?.value", SIDE) == "Right"
            and acc.d.js("return document.querySelector(arguments[0])?.value", ALIGN) == "Center",
            "Native reopened controls do not reflect saved caption layout")
    report["freshModelReopen"] = {"kind": reopened["kind"], "props": reopened["props"],
                                  "caption": reopened["caption"], "owner": reopened["shape"],
                                  "sha256": digest(target)}
    report["reopenedInNative"] = True


def locked_case(acc, out, fixtures, report, picture=False):
    stem = "locked-picture-caption" if picture else "locked-caption"
    source = fixtures / f"{stem}.hwp"
    target = out / f"{stem}.hwp"
    shutil.copyfile(source, target)
    before_hash = digest(target)
    before = oracle(target)
    expected_kind = "picture" if picture else "shape"
    _, _, _, owner = inspect_owned_caption(target, locked=True, expected_kind=expected_kind)
    acc.open_native("hwp", target)
    acc.engine("xkb:us::eng")
    choose_shape(acc, before["shape"])
    require(acc.d.js("return document.querySelector(arguments[0])", SIDE) is None,
            "locked HWP5 caption exposed a mutation control")
    require(acc.d.js("return document.querySelector(arguments[0])", ALIGN) is None,
            "locked HWP5 caption exposed an alignment mutation control")
    acc.key("Delete", "BackSpace", "shift+Right")
    acc.settle("hwp")
    after = acc.status("hwp")
    require(after.get("revision") == "0" and after.get("dirty") == "false",
            "locked caption rejection changed document history", after)
    require(digest(target) == before_hash, "locked caption rejection changed file bytes")
    require(before["props"] == oracle(target)["props"], "locked caption properties changed")
    report.update(status="PASS", sha256=before_hash, owner=owner, revision=after["revision"],
                  dirty=after["dirty"], mutationControlsAbsent=True, diskUntouched=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.fixtures = args.fixtures.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    fixture_pairs = [
        (args.fixtures / "caption.hwp", args.fixtures / "locked-caption.hwp", "shape"),
        (args.fixtures / "picture-caption.hwp", args.fixtures / "locked-picture-caption.hwp", "picture"),
    ]
    for source, locked, expected_kind in fixture_pairs:
        require(inspect_owned_caption(source, locked=False, expected_kind=expected_kind)[0]["FileHeader"][0:16] ==
                inspect_owned_caption(locked, locked=True, expected_kind=expected_kind)[0]["FileHeader"][0:16],
                "locked and editable fixtures have different format identity")
        for path, expect_locked in ((source, False), (locked, True)):
            model = oracle(path)
            require(model["kind"] == ("image" if expected_kind == "picture" else "shape")
                    and model["props"]["hasCaption"],
                    "fixture is not a captioned object of the expected kind", model)
            require(model["props"]["captionWidth"] == 2400 and model["props"]["captionSpacing"] == 100,
                    "fixture lacks documented safe lateral geometry", model["props"])
            inspect_owned_caption(path, locked=expect_locked, expected_kind=expected_kind)

    app = ROOT / "src-tauri/target/release/geul"
    p6.p4.smoke.APP = str(app)
    p6.p4.smoke.DRIVER_LOG = str(args.out / "driver.log")
    report = {"status": "IN_PROGRESS", "appSha256": digest(app), "rhwpGeneration":
              oracle(fixture_pairs[0][0])["generation"], "cases": {}}
    for name, action, picture in (
        ("editableShape", main_case, False),
        ("editablePicture", main_case, True),
        ("lockedShape", locked_case, False),
        ("lockedPicture", locked_case, True),
    ):
        try:
            with p6.p4.smoke.tauri_driver(args.driver, 4469, str(args.out / ("data-" + name))) as start:
                driver = start()
                try:
                    acc = p6.p4.P4Acceptance(args, driver, report)
                    acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                    acc.focus_window()
                    acc.calibrate_pointer()
                    case = {}
                    action(acc, args.out, args.fixtures, case, picture)
                    case["status"] = "PASS"
                    report["cases"][name] = case
                finally:
                    driver.quit()
        except Exception:
            report["cases"][name] = {"status": "FAIL", "error": traceback.format_exc()}
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    report["status"] = "PASS" if all(item.get("status") == "PASS" for item in report["cases"].values()) else "FAIL"
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
