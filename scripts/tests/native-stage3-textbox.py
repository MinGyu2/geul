#!/usr/bin/env python3
"""Exercise owned HWP text-box input in the Release Tauri app under native-ibus-session.py."""

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess

SPEC = importlib.util.spec_from_file_location(
    "gso", Path(__file__).with_name("native-stage3-hwp-gso.py")
)
gso = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gso)
p4 = gso.p4

ORACLE = """
const fs = require('fs'), path = require('path');
const assets = path.resolve('public/rhwp');
const release = JSON.parse(fs.readFileSync(path.join(assets, 'RELEASE.json')));
const folder = path.join(assets, 'generations', release.generation);
const rhwp = require(path.join(folder, 'rhwp.js'));
rhwp.initSync({module: fs.readFileSync(path.join(folder, 'rhwp_bg.wasm'))});
const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const hits = JSON.parse(doc.getControls()).filter(c => c.ctrlId === 'gso' && c.list === 0);
  if (hits.length !== 1 || hits[0].props.Lock !== 0) throw new Error('Fixture owner');
  const { para, controlIndex } = hits[0];
  if (doc.getCellParagraphCount(0, para, controlIndex, 0) !== 2) throw new Error('Fixture paragraphs');
  const paragraphs = [0, 1].map(p => doc.getTextInCell(0, para, controlIndex, 0, p, 0,
    doc.getCellParagraphLength(0, para, controlIndex, 0, p)));
  const caret = JSON.parse(doc.getCursorRectInCell(0, para, controlIndex, 0, 1, 0));
  const body = doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0));
  process.stdout.write(JSON.stringify({generation: release.generation, body, paragraphs, caret}));
} finally { doc.free(); }
"""


def inspect(path):
    return json.loads(subprocess.check_output(
        ["node", "-e", ORACLE, str(path)], cwd=p4.ROOT, text=True,
    ))


def point_to_paragraph(acc, caret):
    xy = acc.d.js("""
      const at=arguments[0], canvas=document.querySelectorAll('.rhwp-page__canvas')[at.pageIndex];
      const scroll=document.querySelector('.editor__scroll'), viewport=scroll.getBoundingClientRect();
      const previous=canvas.getBoundingClientRect(), scale=previous.width/canvas.clientWidth;
      scroll.scrollTop += previous.top+(at.y+at.height/2)*scale-(viewport.top+viewport.height/2);
      const rect=canvas.getBoundingClientRect();
      const x=rect.left+(at.x+1)*scale, y=rect.top+(at.y+at.height/2)*scale;
      return [x,y,document.elementFromPoint(x,y)?.className];
    """, caret)
    assert xy[2] == "rhwp-page__canvas", xy
    acc.d.js("""
      window.__stage3Pointer=[];
      window.addEventListener('mousedown', e=>window.__stage3Pointer.push({
        detail:e.detail, x:e.clientX, y:e.clientY, target:e.target.className, trusted:e.isTrusted,
      }), {capture:true});
    """)
    sx, sy = acc.d.pointer_scale
    p4.rhwp_poc.perform(acc.d, [{
        "type": "pointer", "id": "textbox-mouse", "parameters": {"pointerType": "mouse"},
        "actions": [
            {"type": "pointerMove", "x": round(xy[0] * sx), "y": round(xy[1] * sy), "origin": "viewport"},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
            {"type": "pause", "duration": 40},
            {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
        ],
    }])
    acc.report.setdefault("pointer", []).append(acc.d.js("return window.__stage3Pointer"))
    assert acc.status("hwp")["caret"].endswith("/0/1"), acc.status("hwp")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("app", "driver", "fixture", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    path = args.out / "owned-textbox.hwp"
    shutil.copyfile(args.fixture, path)
    before = inspect(path)
    p4.smoke.APP = str(args.app)
    p4.smoke.DRIVER_LOG = str(args.out / "driver.log")
    report = {"status": "FAIL", "appSha256": p4.sha256(args.app), "original": before}
    try:
        for phase in ("edit", "reopen"):
            with p4.smoke.tauri_driver(str(args.driver), 4444, str(args.out / phase)) as start:
                d = start()
                try:
                    acc = p4.P4Acceptance(args, d, report)
                    acc.wait("return !!document.querySelector('.document-bar')")
                    acc.focus_window()
                    acc.calibrate_pointer()
                    report[phase + "Pid"] = int(acc.command(args.xdotool, "getwindowpid", acc.window))
                    acc.open_native("hwp", path.resolve())
                    report["generation"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
                    assert report["generation"] == before["generation"]
                    current = inspect(path)
                    point_to_paragraph(acc, current["caret"])
                    if phase == "reopen":
                        acc.text_is("hwp", "한글second")
                        report["reopen"] = acc.status("hwp")
                        assert report["reopen"]["revision"] == "0"
                        continue
                    assert current["paragraphs"] == ["first", "second"]
                    d.js("""
                      window.__stage3Ime=[];
                      for(const type of ['compositionstart','compositionupdate','compositionend']) {
                        window.addEventListener(type, e=>window.__stage3Ime.push([e.type,e.isTrusted]), true);
                      }
                    """)
                    acc.command(args.xdotool, "windowfocus", "--sync", acc.window)
                    acc.engine("hangul")
                    acc.type("gk")
                    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.composing==='true'")
                    report["preedit"] = acc.status("hwp")
                    acc.type("srmf")
                    acc.key("End")
                    acc.text_is("hwp", "한글second")
                    report["events"] = d.js("return window.__stage3Ime")
                    for event in ("compositionstart", "compositionupdate", "compositionend"):
                        assert [event, True] in report["events"], report["events"]
                    acc.engine("xkb:us::eng")
                    acc.wait("""
                      const s=document.querySelector('[data-testid=rhwp-status]').dataset;
                      return s.revision===s.localRevision && Number(s.revision)>0;
                    """)
                    report["save"] = acc.save("hwp")
                    after = inspect(path)
                    assert after["body"] == before["body"] and after["paragraphs"] == ["first", "한글second"], after
                    report["published"] = after
                finally:
                    p4.smoke.end_session(d)
        assert report["editPid"] != report["reopenPid"]
        report["status"] = "PASS"
    except Exception as error:
        report["error"] = repr(error)
        raise
    finally:
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
