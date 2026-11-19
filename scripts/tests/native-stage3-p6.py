#!/usr/bin/env python3
"""Focused Stage 3 desktop integration gaps through the production editor."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("gso", HERE / "native-stage3-hwp-gso.py")
gso = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gso)
p4 = gso.p4
TOOLS = gso.PANEL
CROP = TOOLS + " form:has(.picture-crop-fields)"
WRAP = TOOLS + ' select:has(option[value="topAndBottom"])'
FRAME = ".object-selection-frame"
CHART = TOOLS + " .chart-tools"
ART = TOOLS + " .smart-art-tools"
SHAPE = TOOLS + " .shape-tools"
ORACLE = """
const fs = require('fs'), path = require('path');
const assets = path.resolve('public/rhwp');
const release = JSON.parse(fs.readFileSync(path.join(assets, 'RELEASE.json')));
const folder = path.join(assets, 'generations', release.generation);
const rhwp = require(path.join(folder, 'rhwp.js'));
rhwp.initSync({module: fs.readFileSync(path.join(folder, 'rhwp_bg.wasm'))});
const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const controls = JSON.parse(doc.getPageControlLayout(0)).controls;
  const owned = type => controls.filter(c=>c.type===type).map(c=>({ ...c,
    props: JSON.parse((type==="image" ? doc.getPictureProperties : doc.getShapeProperties)
      .call(doc,c.secIdx,c.paraIdx,c.controlIdx))}));
  const images = owned("image"), shapes = owned("shape");
  const owner = images.find(c=>c.props.hasCaption);
  let caption = null;
  if (owner) {
    const at = [owner.secIdx,owner.paraIdx,owner.controlIdx,0,0];
    const length = doc.getCellParagraphLength(...at);
    caption = { text: doc.getTextInCell(...at,0,length), caret: JSON.parse(doc.getCursorRectInCell(...at,length)) };
  }
  const body = doc.getTextRange(0,0,0,doc.getParagraphLength(0,0));
  console.log(JSON.stringify({generation:release.generation, images, shapes, caption, body}));
} finally { doc.free(); }
"""


def hwp(path):
    return json.loads(subprocess.check_output(["node", "-e", ORACLE, str(path)], cwd=ROOT, text=True))


def section_resources(before, after):
    a, b = [gso.cfb_streams(p.read_bytes()) for p in (before, after)]
    keys = [p for p in a if p.startswith("BinData/")]
    assert keys and {p for p in b if p.startswith("BinData/")} == set(keys)
    assert all(a[p] == b[p] for p in keys)
    return keys


def rev(acc, fmt, expected):
    selector = "[data-testid=docx-status]" if fmt == "docx" else "[data-testid=rhwp-status]"
    acc.wait("return +document.querySelector(arguments[0])?.dataset.revision===arguments[1]", selector, expected, timeout=12)
    acc.settle(fmt)


def value(acc, selector):
    return acc.d.js("return document.querySelector(arguments[0])?.value", selector)


def select(acc, selector, choice):
    # Exercise the actual change binding with the chosen option. The GTK menu
    # keyboard sequence in the first run committed the Home value immediately.
    acc.d.js("""
    const e = document.querySelector(arguments[0]);
    if (!e || e.disabled || ![...e.options].some(o=>o.value===arguments[1])) throw Error('option unavailable');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e, arguments[1]);
    e.dispatchEvent(new Event('change',{bubbles:true}));
    """, selector, choice)


def fill_input(acc, selector, value_):
    gso.replace(acc, selector, value_)


def color(acc, selector, rgb):
    # Exercise the HTML color input binding without platform-owned chooser automation.
    acc.d.js("""
    const e = document.querySelector(arguments[0]);
    if (!e || e.disabled) throw Error('color unavailable');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e, arguments[1]);
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    """, selector, rgb)


def start(acc, name, fixture, fmt):
    path = acc.args.out / name
    shutil.copyfile(fixture, path)
    acc.open_native(fmt, path)
    acc.engine("xkb:us::eng")
    return path


def pointer(acc, point, ratio=1):
    x,y = acc.d.js("""
    const [page,x,y,ratio]=arguments[0], canvas=document.querySelectorAll('.rhwp-page__canvas')[page];
    const s=document.querySelector('.editor__scroll'), r=canvas.getBoundingClientRect();
    const v=s.getBoundingClientRect(), k=r.width/canvas.clientWidth*ratio;
    s.scrollTop += r.top+y*k-(v.top+v.height/2);
    const next=canvas.getBoundingClientRect();
    return [next.left+x*k,next.top+y*k];
    """, [*point, ratio])
    p4.rhwp_poc.click(acc.d, x, y)


def selected_frame(acc):
    return acc.d.js("""
    const f=document.querySelector(arguments[0]), r=f.getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,left:parseFloat(f.style.left),top:parseFloat(f.style.top)};
    """, FRAME)


HWP = ROOT / "target/stage3-gso-acceptance/gso-original.hwp"
CAPTION = ROOT / "target/stage3-caption-story/p5-caption-original.hwp"
FIXTURES = ROOT / "target/stage3-p6"


def picture(acc, progress):
    path = start(acc, "picture.hwp", HWP, "hwp")
    before = hwp(HWP)
    first, floating = sorted(before["images"], key=lambda x:x["controlIdx"])
    gso.choose(acc, floating, "picture")
    old = selected_frame(acc)
    sx,sy = acc.d.pointer_scale
    p4.rhwp_poc.drag(acc.d, (old["x"]*sx,old["y"]*sy), ((old["x"]+46)*sx,(old["y"]+33)*sy))
    rev(acc, "hwp", 1)
    moved = {**floating, "x": floating["x"] + 46, "y": floating["y"] + 33}
    gso.choose(acc, moved, "picture")
    current = selected_frame(acc)
    assert current["left"] > old["left"] + 24 and current["top"] > old["top"] + 15, (old,current)
    progress["pointerMove"] = [old,current]

    gso.choose(acc, first, "picture")
    left = CROP + " input"
    fill_input(acc, left, 12)
    acc.dom_click(CROP + ' button[type="submit"]')
    rev(acc, "hwp", 2)
    gso.choose(acc, first, "picture")
    assert float(value(acc, left)) == 12
    acc.dom_click(CROP + ' button[type="button"]')
    rev(acc, "hwp", 3)
    gso.choose(acc, first, "picture")
    assert float(value(acc, left)) == 0
    progress["cropAndReset"] = [12, 0]
    select(acc, WRAP, "topAndBottom")
    rev(acc, "hwp", 4)
    progress["wrap"] = "topAndBottom"
    progress["save"] = acc.save("hwp")
    after = hwp(path)
    assert after["body"] == before["body"]
    a,b = sorted(after["images"], key=lambda x:x["controlIdx"])
    assert a["props"]["textWrap"] == "TopAndBottom" and a["props"]["treatAsChar"] is False
    assert a["props"]["cropLeft"] == 0 and b["props"]["horzOffset"] > floating["props"]["horzOffset"]
    assert b["props"]["vertOffset"] > floating["props"]["vertOffset"]
    progress["resources"] = section_resources(HWP,path)


def deletion(acc, progress):
    path = start(acc, "delete.hwp", HWP, "hwp")
    before = hwp(HWP)
    first,floating = sorted(before["images"],key=lambda x:x["controlIdx"])
    gso.choose(acc, floating, "picture")
    acc.wait("return !!document.querySelector(arguments[0]+' > button')", TOOLS)
    acc.key("Delete")
    rev(acc, "hwp", 1)
    acc.key("ctrl+z")
    rev(acc, "hwp", 2)
    gso.choose(acc, floating, "picture")
    acc.key("Delete")
    rev(acc, "hwp", 3)
    progress["save"] = acc.save("hwp")
    after = hwp(path)
    assert after["body"] == before["body"]
    a,b = [gso.cfb_streams(p.read_bytes()) for p in (HWP,path)]
    _,old_objects = gso.section_objects(a)
    _,new_objects = gso.section_objects(b)
    _, removed, _ = [i for i,o in enumerate(old_objects) if o[0][2].startswith(b" osg")]
    assert new_objects == old_objects[:removed] + old_objects[removed+1:]
    assert len(after["images"]) == 1 and after["images"][0]["props"] == first["props"]
    progress["resources"] = section_resources(HWP,path)


def shape(acc, progress):
    path = start(acc, "shape.hwp", HWP, "hwp")
    before = hwp(HWP)
    gso.choose(acc, before["shapes"][0], "shape")
    fill = SHAPE + " > label input[type=color]"
    color(acc, fill,"#996633")
    rev(acc, "hwp", 1)
    gso.choose(acc,before["shapes"][0],"shape")
    assert value(acc,fill) == "#996633"
    acc.dom_click(SHAPE + " > button")
    rev(acc, "hwp", 2)
    acc.key("ctrl+z")
    rev(acc, "hwp", 3)
    gso.choose(acc,before["shapes"][0],"shape")
    assert value(acc,fill) == "#996633"
    outline = SHAPE + " form:has(input[type=color])"
    color(acc,outline+" input[type=color]","#442277")
    acc.dom_click(outline+" button")
    rev(acc,"hwp",4)
    gso.choose(acc,before["shapes"][0],"shape")
    acc.dom_click(gso.FLIPS, "document.querySelectorAll(arguments[0])[1]")
    acc.dom_click(SHAPE+" form:has(input[max='3600']) button")
    rev(acc,"hwp",5)
    progress["save"] = acc.save("hwp")
    after = hwp(path)
    assert before["images"] == after["images"] and before["body"] == after["body"]
    saved = after["shapes"][0]["props"]
    def rgb(n):
        return "#" + n.to_bytes(3, "little").hex()
    assert saved["fillType"] == "solid" and rgb(saved["fillBgColor"]) == "#996633"
    assert rgb(saved["borderColor"]) == "#442277" and saved["vertFlip"] is True
    progress["fillLineAndVerticalFlip"] = [rgb(saved["fillBgColor"]),rgb(saved["borderColor"]),saved["vertFlip"]]
    progress["resources"] = section_resources(HWP,path)


def caption(acc, progress):
    path = start(acc, "caption.hwp", CAPTION, "hwp")
    before = hwp(CAPTION)
    at = before["caption"]["caret"]
    pointer(acc,(at["pageIndex"],at["x"]+1,at["y"]+at["height"]/2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    acc.type("Caption")
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('Caption')")
    progress["typed"] = acc.status("hwp")["paragraphText"]
    progress["save"] = acc.save("hwp")
    after = hwp(path)
    assert after["caption"]["text"] == before["caption"]["text"] + "Caption"
    assert after["body"] == before["body"]
    assert [p["props"] for p in after["images"]] == [p["props"] for p in before["images"]]
    progress["resources"] = section_resources(CAPTION,path)


def graphics(acc, progress):
    src = acc.args.fixtures / "graphics-original.docx"
    path = start(acc, "graphics.docx", src, "docx")
    before = [line.split() for line in (acc.args.fixtures / "graphics-layout.txt").read_text().splitlines()]
    points = []
    for page,x,y,w,h in before:
        points.append((int(page),float(x)+float(w)/2,float(y)+float(h)/2))
    ratio = acc.d.js("return document.querySelector('.docx-page').clientWidth/612")
    pointer(acc,points[0],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", CHART, timeout=12)
    title = CHART + " form:first-child input"
    assert value(acc,title) == "Revenue"
    fill_input(acc,title,"Revenue Native")
    acc.dom_click(CHART+" form:first-child button[type=submit]")
    rev(acc,"docx",1)
    select(acc,CHART+" select","bar")
    rev(acc,"docx",2)
    fill_input(acc,CHART+' input[inputmode="decimal"]',"37")
    acc.dom_click(CHART+" form:has(.chart-data-fields) button[type=submit]")
    rev(acc,"docx",3)
    progress["chart"] = [value(acc,title),value(acc,CHART+" select"),value(acc,CHART+' input[inputmode="decimal"]')]
    assert progress["chart"] == ["Revenue Native","bar","37"], progress["chart"]

    pointer(acc,points[1],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", ART, timeout=12)
    acc.dom_click(ART+" textarea")
    acc.key("ctrl+a")
    acc.type("Plan")
    acc.key("Return")
    acc.type("  Launch")
    acc.dom_click(ART+" button[type=submit]")
    rev(acc,"docx",4)
    select(acc,ART+" select","cycle")
    rev(acc,"docx",5)
    progress["smartArt"] = [value(acc,ART+" textarea"),value(acc,ART+" select")]
    assert progress["smartArt"] == ["Plan\n  Launch","cycle"], progress["smartArt"]
    progress["save"] = acc.save("docx")
    with zipfile.ZipFile(path) as z:
        chart = z.read("word/charts/chart1.xml")
        data = z.read("word/diagrams/data1.xml")
        assert b"Revenue Native" in chart and b'<c:barDir val="bar"' in chart and b">37<" in chart
        assert b">Plan<" in data and b">Launch<" in data
    assert p4.rhwp_poc.close_tab(acc.d, path.name)
    acc.open_native("docx", path)
    pointer(acc,points[1],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", ART)
    assert value(acc,ART+" textarea") == "Plan\n  Launch" and value(acc,ART+" select") == "cycle"
    pointer(acc,points[0],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", CHART)
    assert [value(acc,title),value(acc,CHART+" select"),value(acc,CHART+' input[inputmode="decimal"]')] == progress["chart"]
    progress["reopened"] = True


CASES = {"picture":picture,"deletion":deletion,"shape":shape,"caption":caption,"graphics":graphics}
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, default=FIXTURES)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    app = ROOT / "src-tauri/target/release/geul"
    p4.smoke.APP = str(app)
    p4.smoke.DRIVER_LOG = str(args.out / "driver.log")
    report = {"appSha256":p4.sha256(app),"cases":{}}
    for name in args.cases:
        progress = report["cases"][name] = {}
        try:
            with p4.smoke.tauri_driver(args.driver, 4469, str(args.out / ("data-"+name))) as start_session:
                driver = start_session()
                try:
                    acc = p4.P4Acceptance(args,driver,progress)
                    acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                    acc.focus_window()
                    acc.calibrate_pointer()
                    CASES[name](acc,progress)
                finally:
                    driver.quit()
            progress["status"] = "PASS"
        except Exception:
            progress["status"] = "FAIL"
            progress["error"] = traceback.format_exc()
    (args.out / "result.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    sys.exit(0 if all(v["status"] == "PASS" for v in report["cases"].values()) else 1)
