#!/usr/bin/env python3
"""Stage 3 HWP GSO acceptance in the Release product under native-ibus-session.py.

Generate the inputs with GEUL_STAGE3_OUT using stage3-object-edit.wasm.test.ts.
The GUI edits an isolated copy and opens the published file after an app restart.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import traceback

from hwp_record_diff import cfb_streams, records, unpacked

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("p4", ROOT / "scripts/tests/stage2-p4-native-acceptance.py")
p4 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p4)
PANEL = "#properties-panel .object-tools"
SIZE = PANEL + ' form input[type=number][max="4000"]'
DESCRIPTION = PANEL + ' input[type=text]'
ROTATION = PANEL + ' .shape-tools input[type=number][max="3600"]'
FLIPS = PANEL + ' .shape-tools input[type=checkbox]'


def choose(acc, frame, kind):
    d = acc.d
    pt = d.js("""
      const g=arguments[0], c=document.querySelector('.rhwp-page__canvas');
      const s=document.querySelector('.editor__scroll'), r=c.getBoundingClientRect();
      const v=s.getBoundingClientRect(), scale=r.width/c.clientWidth;
      s.scrollTop += r.top+(g.y+g.h/2)*scale-(v.top+v.height/2);
      const next=c.getBoundingClientRect();
      return [next.left+(g.x+g.w/2)*scale,next.top+(g.y+g.h/2)*scale];
    """, frame)
    p4.rhwp_poc.click(d, *pt)
    acc.wait("return document.querySelector('.object-selection-frame')?.dataset.objectKind===arguments[0]", kind)


def props(acc, kind):
    if kind == "picture":
        return acc.d.js("""const values=document.querySelectorAll('[aria-labelledby=properties-selection] dl dd');
          return {size:[parseFloat(values[0]?.textContent),parseFloat(values[1]?.textContent)],
          description:document.querySelector(arguments[0])?.value}""", DESCRIPTION)
    return acc.d.js("""const f=document.querySelector('.object-selection-frame');
      return {x:parseFloat(f.style.left), y:parseFloat(f.style.top), angle:+document.querySelector(arguments[0]).value,
      flips:[...document.querySelectorAll(arguments[1])].map(e=>e.checked)}""", ROTATION, FLIPS)


def replace(acc, selector, value):
    acc.dom_click(selector)
    acc.key("ctrl+a")
    acc.type(str(value))


def at_revision(acc, revision, dirty):
    acc.wait("""const s=document.querySelector('[data-testid=rhwp-status]');
      return +s?.dataset.revision===arguments[0] && s.dataset.localRevision===s.dataset.revision
        && s.dataset.dirty===String(arguments[1])""", revision, dirty)
    return acc.status("hwp")


def exercise(acc, path, picture, shape, other_picture, report):
    d = acc.d
    acc.open_native("hwp", path)
    report["initial"] = at_revision(acc, 0, False)
    assert report["initial"]["paragraphText"].startswith("seed text for the anchor")
    choose(acc, other_picture, "picture")
    report["unrelatedLive"] = props(acc, "picture")
    assert report["unrelatedLive"] == {"size": [36, 18], "description": ""}
    assert d.js("return !!document.querySelector('[data-testid=object-move]')")
    acc.key("Delete", "BackSpace", "ctrl+z")
    after_refusal = at_revision(acc, 0, False)
    assert after_refusal["paragraphText"] == report["initial"]["paragraphText"]
    assert d.js("return document.querySelector('[data-testid=rhwp-save-result]')?.dataset.state") != "saved"
    assert p4.sha256(path) == report["sourceSha256"]
    report["deleteRefused"] = {"revision": 0, "dirty": False, "diskUntouched": True,
                               "keys": ["Delete", "BackSpace", "Ctrl+Z"]}

    choose(acc, picture, "picture")
    assert props(acc, "picture") == {"size": [40.5, 20.25], "description": ""}
    replace(acc, SIZE, 54)
    acc.key("Return")
    at_revision(acc, 1, True)
    choose(acc, picture, "picture")
    assert props(acc, "picture")["size"] == [54, 27]
    replace(acc, DESCRIPTION, "Native HWP picture")
    acc.key("Return")
    at_revision(acc, 2, True)
    choose(acc, picture, "picture")
    report["picture"] = props(acc, "picture")
    assert report["picture"] == {"size": [54, 27], "description": "Native HWP picture"}
    report["pictureCommands"] = ["object.edit:bounds", "object.edit:altText"]

    choose(acc, shape, "shape")
    original_shape = props(acc, "shape")
    acc.key("shift+Right")
    at_revision(acc, 3, True)
    choose(acc, shape, "shape")
    moved = props(acc, "shape")
    assert moved["x"] > original_shape["x"] + 5 and moved["y"] == original_shape["y"]
    replace(acc, ROTATION, 27)
    acc.dom_click(FLIPS)
    acc.dom_click(PANEL + ' .shape-tools form:has(input[max="3600"]) button[type=submit]')
    at_revision(acc, 4, True)
    choose(acc, shape, "shape")
    report["shape"] = props(acc, "shape")
    assert report["shape"] == {**moved, "angle": 27, "flips": [True, False]}
    report["shapeCommands"] = ["object.edit:nudge", "object.edit:rotate"]
    acc.key("ctrl+z")
    report["undo"] = at_revision(acc, 5, True)
    choose(acc, shape, "shape")
    assert props(acc, "shape") == moved
    choose(acc, other_picture, "picture")
    assert props(acc, "picture") == report["unrelatedLive"]
    acc.key("ctrl+y")
    report["redo"] = at_revision(acc, 6, True)
    choose(acc, shape, "shape")
    assert props(acc, "shape") == report["shape"]

    report["save"] = acc.save("hwp")
    assert report["save"]["synced"] == "true" and report["save"]["changedSince"] == "false"
    report["afterSave"] = at_revision(acc, 6, False)
    report["publishedSha256"] = p4.sha256(path)
    assert report["publishedSha256"] != report["sourceSha256"]
    assert p4.rhwp_poc.close_tab(d, path.name)


def section_objects(streams):
    rows = records(unpacked(streams, "BodyText/Section0"))
    starts = [i for i, (tag, level, _) in enumerate(rows) if (tag, level) == (71, 1)]
    objects = []
    for i in starts:
        j = i + 1
        while j < len(rows) and rows[j][1] > 1:
            j += 1
        objects.append(rows[i:j])
    return rows, objects


def disk_proof(source, path):
    a, b = (cfb_streams(p.read_bytes()) for p in (source, path))
    assert a.keys() == b.keys()
    resources = [key for key in a if key != "BodyText/Section0" and key != "PrvImage"]
    assert all(a[key] == b[key] for key in resources)
    assert "PrvImage" in b and b["PrvImage"] != a["PrvImage"]
    before, old_objects = section_objects(a)
    after, new_objects = section_objects(b)
    assert len(old_objects) == len(new_objects)
    assert [(t, l, v) for t, l, v in before if (t, l) == (67, 1)] == [
        (t, l, v) for t, l, v in after if (t, l) == (67, 1)]
    order = []
    for old, new in zip(old_objects, new_objects):
        old_h, new_h = old[0][2], new[0][2]
        assert old_h[:4] == new_h[:4] and old_h[36:40] == new_h[36:40]
        if old_h[:4] != b" osg" or old == new:
            assert old == new
            order.append({"kind": old_h[:4].decode(), "preserved": True})
            continue
        sc = new[1][2]
        kind = sc[:4]
        at = 8 if sc[:4] == sc[4:8] else 4
        size = struct.unpack_from("<II", new_h, 16)
        assert struct.unpack_from("<II", sc, at + 20) == size
        assert old[1][2][at + 12:at + 20] == sc[at + 12:at + 20]
        assert old[1][2][at + 42:at + 188] == sc[at + 42:at + 188]
        if kind == b"cip$":
            assert size == (5400, 2700) and old[2:] == new[2:]
            length = struct.unpack_from("<H", new_h, 44)[0]
            assert new_h[46:46+2*length].decode("utf-16le") == "Native HWP picture"
        else:
            assert kind == b"cer$" and size == (7200, 3600)
            assert struct.unpack_from("<i", new_h, 12)[0] - struct.unpack_from("<i", old_h, 12)[0] == 1000
            assert struct.unpack_from("<h", sc, at + 32)[0] == 27
            assert struct.unpack_from("<I", sc, at + 28)[0] & 3 == 1
        order.append({"kind": kind.decode(), "id": struct.unpack_from("<I", new_h, 36)[0], "size": size})
    assert sum("size" in row for row in order) == 2
    assert any(row == {"kind": " lbt", "preserved": True} for row in order)
    assert sum(row == {"kind": " osg", "preserved": True} for row in order) == 1
    return {"objects": order, "unchangedStreams": resources, "previewRefreshed": True,
            "tableAndUnrelatedPictureByteIdentical": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "driver", "fixture-dir", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--save-check", type=Path, required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    source = args.fixture_dir / "gso-original.hwp"
    file = args.out / "gso-native.hwp"
    shutil.copyfile(source, file)
    layout = json.loads((args.fixture_dir / "gso-layout.json").read_text())["controls"]
    picture, other_picture = sorted((c for c in layout if c["type"] == "image"), key=lambda c: c["controlIdx"])
    shape, = (c for c in layout if c["type"] == "shape")
    report = {"status": "FAIL", "appSha256": p4.sha256(args.app),
              "source": str(source), "sourceSha256": p4.sha256(source), "published": str(file)}
    p4.smoke.APP = str(args.app)
    p4.smoke.DRIVER_LOG = str(args.out / "driver.log")
    try:
        preflight = subprocess.check_output([
            args.save_check, "preflight", "hwp", source, args.fixture_dir / "gso-noop.hwp",
            args.fixture_dir / "gso-noop-report.json",
        ])
        report["preflight"] = json.loads(preflight)
        assert report["preflight"] == {"outcome": "safe", "findings": []}
        for phase in ("edit", "reopen"):
            with p4.smoke.tauri_driver(str(args.driver), 4444, str(args.out / phase)) as start:
                d = start()
                try:
                    acc = p4.P4Acceptance(args, d, report)
                    acc.wait("return !!document.querySelector('.document-bar')")
                    acc.focus_window()
                    report[phase + "Pid"] = int(acc.command(args.xdotool, "getwindowpid", acc.window))
                    acc.calibrate_pointer()
                    if phase == "edit":
                        exercise(acc, file, picture, shape, other_picture, report)
                        report["recordProof"] = disk_proof(source, file)
                    else:
                        acc.open_native("hwp", file)
                        report["reopen"] = at_revision(acc, 0, False)
                        choose(acc, picture, "picture")
                        assert props(acc, "picture") == report["picture"]
                        choose(acc, shape, "shape")
                        assert props(acc, "shape") == report["shape"]
                        choose(acc, other_picture, "picture")
                        assert props(acc, "picture") == report["unrelatedLive"]
                        assert p4.sha256(file) == report["publishedSha256"]
                        assert p4.rhwp_poc.close_tab(d, file.name)
                except Exception:
                    report["failureDom"] = d.js("return document.body.innerText.slice(-6000)")
                    d.screenshot(args.out / "failure.png")
                    raise
                finally:
                    p4.smoke.end_session(d)
        assert report["editPid"] != report["reopenPid"]
        assert p4.sha256(source) == report["sourceSha256"]
        report["status"] = "PASS"
    except Exception as error:
        traceback.print_exc()
        report["error"] = str(error)
    finally:
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
