#!/usr/bin/env python3
"""Native Linux X11 acceptance for HWP5 text-box paragraph split and merge."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

from hwp_record_diff import cfb_streams, records, unpacked

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("gso", ROOT / "scripts/tests/native-stage3-hwp-gso.py")
gso = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gso)
p4 = gso.p4

ORACLE = r"""
const fs=require('fs'),path=require('path');
const assets=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(assets,'RELEASE.json')));
const folder=path.join(assets,'generations',release.generation);
const rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
 const boxes=JSON.parse(doc.getControls()).filter(c=>c.ctrlId==='gso'&&c.list===0&&c.props?.Lock===0);
 if(boxes.length!==1)throw new Error('Expected one unlocked body text box');
 const {para,controlIndex}=boxes[0],count=doc.getCellParagraphCount(0,para,controlIndex,0);
 const paragraphs=Array.from({length:count},(_,p)=>doc.getTextInCell(0,para,controlIndex,0,p,0,
   doc.getCellParagraphLength(0,para,controlIndex,0,p)));
 const caret=JSON.parse(doc.getCursorRectInCell(0,para,controlIndex,0,0,0));
 const midCaret=JSON.parse(doc.getCursorRectInCell(0,para,controlIndex,0,0,4));
 process.stdout.write(JSON.stringify({generation:release.generation,body:doc.getTextRange(0,0,0,doc.getParagraphLength(0,0)),
   owner:{para,controlIndex},shape:doc.getShapeProperties(0,para,controlIndex),paragraphs,caret,midCaret}));
} finally {doc.free();}
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inspect(path):
    return json.loads(subprocess.check_output(["node", "-e", ORACLE, str(path)], cwd=ROOT, text=True))


def textbox_object(rows):
    starts = [i for i, (tag, level, data) in enumerate(rows)
              if (tag, level) == (71, 1) and data.startswith(b" osg")]
    if len(starts) != 1:
        raise AssertionError(f"expected one HWP5 text-box owner, got {len(starts)}")
    start = starts[0]
    end = next((i for i in range(start + 1, len(rows)) if rows[i][1] <= 1), len(rows))
    return start, end, rows[start:end]


def textbox_paragraphs(obj):
    starts = [i for i, (tag, level, _) in enumerate(obj) if (tag, level) == (66, 3)]
    if not starts:
        raise AssertionError("textbox has no paragraph records")
    return [obj[a:(starts[i + 1] if i + 1 < len(starts) else len(obj) - 1)]
            for i, a in enumerate(starts)]


def paragraph_text(paragraph):
    rows = [data for tag, level, data in paragraph if (tag, level) == (67, 4)]
    if len(rows) != 1 or not rows[0].endswith(b"\r\0"):
        raise AssertionError("textbox paragraph text record is not canonical")
    return rows[0][:-2].decode("utf-16le")


def paragraph_char_shapes(paragraph):
    rows = [data for tag, level, data in paragraph if (tag, level) == (68, 4)]
    if len(rows) != 1 or len(rows[0]) % 8:
        raise AssertionError("textbox character-shape record is malformed")
    import struct
    return [struct.unpack_from("<II", rows[0], i) for i in range(0, len(rows[0]), 8)]


def char_shape_at(runs, offset):
    current = None
    for start, style in runs:
        if start > offset:
            break
        current = style
    return current


def list_header(obj):
    rows = [data for tag, level, data in obj if (tag, level) == (72, 3)]
    if len(rows) != 1 or len(rows[0]) != 33:
        raise AssertionError("textbox list header is malformed")
    return rows[0]


def disk_proof(source, output, expected):
    before_streams, after_streams = (cfb_streams(Path(p).read_bytes()) for p in (source, output))
    assert before_streams.keys() == after_streams.keys(), "HWP CFB stream set changed"
    changed_streams = sorted(name for name in before_streams if before_streams[name] != after_streams[name])
    assert set(changed_streams) <= {"BodyText/Section0", "PrvImage"}, changed_streams
    before_rows = records(unpacked(before_streams, "BodyText/Section0"))
    after_rows = records(unpacked(after_streams, "BodyText/Section0"))
    before_start, before_end, before_obj = textbox_object(before_rows)
    after_start, after_end, after_obj = textbox_object(after_rows)
    assert before_rows[:before_start] == after_rows[:after_start], "a preceding body record changed"
    assert before_rows[before_end:] == after_rows[after_end:], "a following body record changed"
    assert before_obj[0] == after_obj[0], "textbox owner/placement changed"
    assert before_obj[1] == after_obj[1], "textbox drawing identity or geometry changed"
    assert before_obj[-1] == after_obj[-1], "textbox shape leaf changed"
    old_list, new_list = list_header(before_obj), list_header(after_obj)
    assert old_list[4:] == new_list[4:], "LIST_HEADER metadata changed"
    old_paras, new_paras = textbox_paragraphs(before_obj), textbox_paragraphs(after_obj)
    assert [paragraph_text(p) for p in new_paras] == expected
    assert old_paras[0][0][2][8:11] == new_paras[0][0][2][8:11], "paragraph/style refs changed"
    old_id = int.from_bytes(old_paras[0][0][2][18:22], "little")
    first_id = int.from_bytes(new_paras[0][0][2][18:22], "little")
    if len(new_paras) == 2:
        second_id = int.from_bytes(new_paras[1][0][2][18:22], "little")
        old_ids = {int.from_bytes(data[18:22], "little") for tag, _, data in before_rows
                   if tag == 66 and len(data) >= 22}
        assert first_id == old_id and second_id != 0 and second_id not in old_ids
        assert new_paras[0][0][2][8:11] == new_paras[1][0][2][8:11]
        assert new_paras[0][0][2][22:] == new_paras[1][0][2][22:] == old_paras[0][0][2][22:]
        assert paragraph_text(old_paras[0]) == "".join(paragraph_text(p) for p in new_paras)
        source_runs = paragraph_char_shapes(old_paras[0])
        output_runs = [paragraph_char_shapes(p) for p in new_paras]
        text_parts = [paragraph_text(p) for p in new_paras]
        for offset in range(len(paragraph_text(old_paras[0]))):
            index = 0 if offset < len(text_parts[0]) else 1
            local = offset if index == 0 else offset - len(text_parts[0])
            assert char_shape_at(source_runs, offset) == char_shape_at(output_runs[index], local)
    else:
        assert first_id == old_id
        assert paragraph_text(old_paras[0]) == paragraph_text(new_paras[0])
        old_runs, new_runs = paragraph_char_shapes(old_paras[0]), paragraph_char_shapes(new_paras[0])
        for offset in range(len(paragraph_text(old_paras[0]))):
            assert char_shape_at(old_runs, offset) == char_shape_at(new_runs, offset)
    assert int.from_bytes(old_list[:4], "little") == len(old_paras)
    assert int.from_bytes(new_list[:4], "little") == len(new_paras)
    return {"changedStreams": changed_streams, "sourceParagraphCount": len(old_paras),
            "savedParagraphCount": len(new_paras), "sourceParagraphId": old_id,
            "savedParagraphIds": [int.from_bytes(p[0][2][18:22], "little") for p in new_paras],
            "ownerSha256": hashlib.sha256(after_obj[0][2]).hexdigest(),
            "listCount": [int.from_bytes(old_list[:4], "little"), int.from_bytes(new_list[:4], "little")]}


def point_to_textbox(acc, caret):
    point = acc.d.js("""
      const at=arguments[0],canvas=document.querySelectorAll('.rhwp-page__canvas')[at.pageIndex];
      const scroll=document.querySelector('.editor__scroll'),viewport=scroll.getBoundingClientRect();
      const previous=canvas.getBoundingClientRect(),scale=previous.width/canvas.clientWidth;
      scroll.scrollTop+=previous.top+(at.y+at.height/2)*scale-(viewport.top+viewport.height/2);
      const rect=canvas.getBoundingClientRect();
      const x=rect.left+(at.x+1)*scale,y=rect.top+(at.y+at.height/2)*scale;
      return [x,y,document.elementFromPoint(x,y)?.className];
    """, caret)
    assert point[2] == "rhwp-page__canvas", point
    acc.d.js("""
      window.__stage3Pointer=[];
      for(const type of ['mousedown','click','dblclick']) window.addEventListener(type,e=>window.__stage3Pointer.push({
        type,detail:e.detail,trusted:e.isTrusted,x:e.clientX,y:e.clientY,target:e.target.className,
      }),true);
    """)
    sx, sy = acc.d.pointer_scale

    p4.rhwp_poc.perform(acc.d, [{
        "type": "pointer", "id": "h5-textbox", "parameters": {"pointerType": "mouse"},
        "actions": [
            {"type": "pointerMove", "x": round(point[0] * sx), "y": round(point[1] * sy), "origin": "viewport"},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
            {"type": "pause", "duration": 80},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
        ],
    }])
    time.sleep(0.08)
    status = acc.status("hwp")
    events = acc.d.js("return window.__stage3Pointer")
    assert events and all(event["trusted"] for event in events), events
    acc.report.setdefault("trustedPointerEvents", []).extend(events)
    snapshot = acc.d.js("""
      const f=document.querySelector('.object-selection-frame');
      return {objectKind:f?.dataset.objectKind??null,
        objectFrame:f?{left:f.style.left,top:f.style.top,width:f.style.width,height:f.style.height}:null,
        activeElement:document.activeElement?.className??document.activeElement?.tagName??null};
    """)
    acc.report.setdefault("pointerSnapshots", []).append({"status": status, **snapshot})
    acc.d.screenshot(acc.args.out / f"pointer-{len(acc.report['pointerSnapshots'])}.png")
    assert "textbox" in (status.get("caret") or "").lower(), status
    return status


def at_revision(acc, revision, dirty):
    acc.wait("""
      const s=document.querySelector('[data-testid=rhwp-status]');
      return +s?.dataset.revision===arguments[0]&&s.dataset.localRevision===s.dataset.revision
        &&s.dataset.dirty===String(arguments[1])&&s.dataset.composing==='false';
    """, revision, dirty, timeout=30)
    return acc.status("hwp")


def run_phase(args, path, phase, report):
    with p4.smoke.tauri_driver(str(args.driver), 4444, str(args.out / phase)) as start:
        driver = start()
        try:
            acc = p4.P4Acceptance(args, driver, report)
            acc.wait("return document.querySelector('.document-bar')!==null", timeout=60)
            acc.focus_window()
            acc.calibrate_pointer()
            pid = int(acc.command(args.xdotool, "getwindowpid", acc.window))
            report[phase + "Pid"] = pid
            acc.open_native("hwp", path.resolve())
            generation = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
            assert generation == report["engineGeneration"], generation
            current = inspect(path)
            if phase == "reopen":
                assert current["paragraphs"] == ["abcdef"]
                assert current["body"] == report["original"]["body"]
                assert current["shape"] == report["original"]["shape"]
                screenshot = args.out / "reopened.png"
                driver.screenshot(screenshot)
                rendered = screenshot.read_bytes()
                status = point_to_textbox(acc, current["midCaret"])
                assert status["revision"] == "0" and status["dirty"] == "false", status
                interaction_screenshot = args.out / "reopened-after-pointer.png"
                driver.screenshot(interaction_screenshot)
                interaction_image = interaction_screenshot.read_bytes()
                report["reopen"] = {"status": status, "paragraphs": current["paragraphs"],
                                     "renderedScreenshotSha256": hashlib.sha256(rendered).hexdigest(),
                                     "renderedScreenshot": str(screenshot),
                                     "interactionScreenshotSha256": hashlib.sha256(interaction_image).hexdigest(),
                                     "interactionScreenshot": str(interaction_screenshot)}
                return pid

            assert current["paragraphs"] == ["abcdef"]
            status = point_to_textbox(acc, current["midCaret"])
            acc.command(args.xdotool, "windowfocus", "--sync", acc.window)
            acc.key("End", "Left", "Left")
            status = at_revision(acc, 0, False)
            assert "textbox" in (status.get("caret") or "").lower(), status

            acc.key("Return")
            status = at_revision(acc, 1, True)
            assert "textbox" in (status.get("caret") or "").lower() and status["caret"].endswith("/0/1"), status
            report["splitCaret"] = status["caret"]
            report["splitSave"] = acc.save("hwp")
            assert report["splitSave"]["state"] == "saved", report["splitSave"]
            split = inspect(path)
            assert split["paragraphs"] == ["abcd", "ef"], split
            assert split["body"] == report["original"]["body"] and split["shape"] == report["original"]["shape"]
            report["splitDiskProof"] = disk_proof(args.fixture, path, ["abcd", "ef"])
            report["split"] = split

            acc.key("ctrl+z")
            undo_split = at_revision(acc, 2, True)
            assert undo_split["caret"].endswith("/0/0"), undo_split
            acc.key("ctrl+y")
            redo_split = at_revision(acc, 3, True)
            assert redo_split["caret"].endswith("/0/1"), redo_split
            acc.key("BackSpace")
            merged_caret = at_revision(acc, 4, True)
            assert "textbox" in merged_caret["caret"].lower() and merged_caret["caret"].endswith("/0/0"), merged_caret
            acc.key("ctrl+z")
            undo_merge = at_revision(acc, 5, True)
            assert undo_merge["caret"].endswith("/0/1"), undo_merge
            acc.key("ctrl+y")
            redo_merge = at_revision(acc, 6, True)
            assert redo_merge["caret"].endswith("/0/0"), redo_merge
            report["undoRedo"] = {"splitUndo": undo_split["caret"], "splitRedo": redo_split["caret"],
                                  "mergeUndo": undo_merge["caret"], "mergeRedo": redo_merge["caret"],
                                  "finalRevision": redo_merge["revision"]}

            report["mergeSave"] = acc.save("hwp")
            assert report["mergeSave"]["state"] == "saved", report["mergeSave"]
            final = inspect(path)
            assert final["paragraphs"] == ["abcdef"]
            assert final["body"] == report["original"]["body"] and final["shape"] == report["original"]["shape"]
            report["mergeDiskProof"] = disk_proof(args.fixture, path, ["abcdef"])
            report["saved"] = final
            assert p4.rhwp_poc.close_tab(driver, path.name)
            return pid
        finally:
            p4.smoke.end_session(driver)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--driver", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    path = args.out / "h5-textbox.hwp"
    shutil.copyfile(args.fixture, path)
    original = inspect(path)
    if original["paragraphs"] != ["abcdef"]:
        raise SystemExit(f"unexpected input fixture: {original}")
    report = {"status": "FAIL", "issueId": "P5-H5-TB", "display": "Linux X11/Xvfb",
              "input": "trusted pointer selection + xdotool keyboard through GTK",
              "appSha256": sha(args.app), "fixtureSha256": sha(args.fixture),
              "engineGeneration": original["generation"], "original": original}
    p4.smoke.APP = str(args.app.resolve())
    p4.smoke.DRIVER_LOG = args.out / "driver.log"
    try:
        first_pid = run_phase(args, path, "edit", report)
        second_pid = run_phase(args, path, "reopen", report)
        assert first_pid != second_pid, (first_pid, second_pid)
        report["freshProcess"] = True
        report["savedSha256"] = sha(path)
        report["status"] = "PASS"
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
