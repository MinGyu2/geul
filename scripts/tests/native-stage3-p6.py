#!/usr/bin/env python3
"""Focused Stage 3 desktop integration gaps through the production editor."""
import argparse
import importlib.util
import json
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import zipfile
import xml.etree.ElementTree as ET

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
const assets = path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS || 'public/rhwp');
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
    try:
        acc.open_native(fmt, path)
    except Exception:
        diagnostics = {}
        try:
            diagnostics["sessions"] = acc.sessions()
        except Exception as error:
            diagnostics["sessionsError"] = f"{type(error).__name__}: {error}"
        try:
            diagnostics["dom"] = acc.d.js("""
              const view=e=>e?{...e.dataset,text:e.textContent}:null;
              return {
                tabs:[...document.querySelectorAll('.document-tab__select')].map(e=>({text:e.textContent,...e.dataset,selected:e.getAttribute('aria-selected')})),
                docxStatus:view(document.querySelector('[data-testid=docx-status]')),
                saveStatus:view(document.querySelector('[data-testid=docx-save-result]')),
                notices:[...document.querySelectorAll('[role=alert],[data-testid*=error]')].map(e=>e.textContent).slice(0,12),
                bodyText:document.body.innerText.slice(0,2000)
              };
            """)
        except Exception as error:
            diagnostics["domError"] = f"{type(error).__name__}: {error}"
        acc.report["openDiagnostic"] = diagnostics
        raise
    acc.engine("xkb:us::eng")
    return path


def add_smartart_node_metadata(source, destination):
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(destination, "w") as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename == "word/diagrams/data1.xml":
                xml = data.decode("utf-8")
                doc_end = xml.index("</dgm:pt>") + len("</dgm:pt>")
                node_start = xml.index("<dgm:pt ", doc_end)
                node_end = xml.index("</dgm:pt>", node_start) + len("</dgm:pt>")
                node = xml[node_start:node_end]
                if "<dgm:prSet/>" not in node:
                    raise AssertionError("fixture SmartArt node does not have the expected canonical property set")
                node = node.replace("<dgm:prSet/>", '<dgm:prSet presName="NativeStable" presStyleIdx="1"/>', 1)
                data = (xml[:node_start] + node + xml[node_end:]).encode("utf-8")
            dst.writestr(info, data)


def smartart_nodes(path):
    ns = {"dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram", "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        data = archive.read("word/diagrams/data1.xml")
    root = ET.fromstring(data)
    points = root.find("dgm:ptLst", ns)
    nodes = []
    for point in points.findall("dgm:pt", ns):
        if "type" in point.attrib:
            continue
        text = point.find("dgm:t/a:p/a:r/a:t", ns)
        prop = point.find("dgm:prSet", ns)
        fill = point.find("dgm:spPr/a:solidFill/a:srgbClr", ns)
        line = point.find("dgm:spPr/a:ln/a:solidFill/a:srgbClr", ns)
        line_shape = point.find("dgm:spPr/a:ln", ns)
        rpr = point.find("dgm:t/a:p/a:r/a:rPr", ns)
        text_fill = rpr.find("a:solidFill/a:srgbClr", ns) if rpr is not None else None
        nodes.append({
            "id": point.get("modelId"),
            "text": text.text if text is not None else "",
            "properties": prop.attrib if prop is not None else {},
            "fill": fill.get("val") if fill is not None else None,
            "line": line.get("val") if line is not None else None,
            "lineWidth": line_shape.get("w") if line_shape is not None else None,
            "textFill": text_fill.get("val") if text_fill is not None else None,
            "bold": rpr.get("b") if rpr is not None else None,
            "italic": rpr.get("i") if rpr is not None else None,
        })
    return nodes


def smartart_selected_frame(acc):
    # Return primitive coordinates through WebDriver, then build the Python mapping locally.
    values = acc.d.js("""
      const e=document.querySelector(arguments[0]); if(!e)return null;
      const r=e.getBoundingClientRect();
      return [r.left,r.top,r.width,r.height];
    """, FRAME)
    if not isinstance(values, list) or len(values) != 4:
        raise AssertionError("selected SmartArt object has no complete rendered selection frame")
    return dict(zip(("left", "top", "width", "height"), map(float, values)))


def assert_same_frame(before, after, label):
    for key in ("left", "top", "width", "height"):
        assert abs(before[key] - after[key]) <= 1.5, f"{label} rendered frame differs at {key}: {before} -> {after}"


def docx_canvas_digest(acc):
    acc.wait("""
      return [...document.querySelectorAll('.docx-page')].some(
        p=>p.dataset.current==='true' && p.dataset.revision===
           document.querySelector('[data-testid=docx-status]').dataset.revision && p.querySelector('canvas'));
    """, timeout=15)
    canvases = acc.d.js("return [...document.querySelectorAll('.docx-page canvas')].map(c=>c.toDataURL('image/png'))")
    if not canvases:
        raise AssertionError("DOCX page canvas is not rendered")
    return hashlib.sha256(json.dumps(canvases, separators=(",", ":")).encode()).hexdigest()


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
    metadata_src = acc.args.out / "graphics-node-metadata.docx"
    add_smartart_node_metadata(src, metadata_src)
    path = start(acc, "graphics.docx", metadata_src, "docx")
    original_nodes = smartart_nodes(path)
    assert original_nodes[0]["properties"].get("presName") == "NativeStable"
    progress["fixtureSha256"] = __import__("hashlib").sha256(path.read_bytes()).hexdigest()
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
    acc.type("Launch")
    acc.dom_click(ART+" button[type=submit]")
    rev(acc,"docx",4)
    select(acc,ART+" select","cycle")
    rev(acc,"docx",5)
    style_canvas_before = docx_canvas_digest(acc)
    style = ART + " .smart-art-node-style"
    # Keep both items as Cycle nodes so each has an independently represented
    # DrawingML shape whose fill and text style can be checked after save.
    select(acc, style + " label:nth-of-type(1) select", "1")
    fill_input(acc, style + " label:nth-of-type(2) input", "AABBCC")
    fill_input(acc, style + " label:nth-of-type(3) input", "334455")
    fill_input(acc, style + " label:nth-of-type(4) input", "2")
    fill_input(acc, style + " label:nth-of-type(5) input", "CCDDEE")
    select(acc, style + " label:nth-of-type(6) select", "true")
    select(acc, style + " label:nth-of-type(7) select", "false")
    acc.dom_click(style + " button[type=submit]")
    rev(acc,"docx",6)
    style_canvas_after = docx_canvas_digest(acc)
    assert style_canvas_after != style_canvas_before, "SmartArt node style did not change the rendered page"
    progress["nodeStyleCanvas"] = {"before":style_canvas_before,"after":style_canvas_after}
    acc.key("ctrl+z")
    rev(acc,"docx",7)
    pointer(acc,points[1],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", ART, timeout=12)
    style = ART + " .smart-art-node-style"
    select(acc, style + " label:nth-of-type(1) select", "1")
    assert value(acc, style + " label:nth-of-type(2) input") == ""
    assert value(acc, style + " label:nth-of-type(3) input") == ""
    assert value(acc, style + " label:nth-of-type(4) input") == ""
    assert value(acc, style + " label:nth-of-type(5) input") == ""
    assert value(acc, style + " label:nth-of-type(6) select") == ""
    assert value(acc, style + " label:nth-of-type(7) select") == ""
    undo_canvas = docx_canvas_digest(acc)
    assert undo_canvas == style_canvas_before, "SmartArt style Undo did not restore rendered page pixels"
    progress["nodeStyleCanvas"]["undo"] = undo_canvas
    acc.key("ctrl+y")
    rev(acc,"docx",8)
    pointer(acc,points[1],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", ART, timeout=12)
    style = ART + " .smart-art-node-style"
    select(acc, style + " label:nth-of-type(1) select", "1")
    assert value(acc, style + " label:nth-of-type(2) input") == "AABBCC"
    assert value(acc, style + " label:nth-of-type(3) input") == "334455"
    assert value(acc, style + " label:nth-of-type(4) input") == "2"
    assert value(acc, style + " label:nth-of-type(5) input") == "CCDDEE"
    assert value(acc, style + " label:nth-of-type(6) select") == "true"
    assert value(acc, style + " label:nth-of-type(7) select") == "false"
    progress["sameAppFrame"] = smartart_selected_frame(acc)
    redo_canvas = docx_canvas_digest(acc)
    assert redo_canvas == style_canvas_after, "SmartArt style Redo did not restore rendered page pixels"
    progress["nodeStyleCanvas"]["redo"] = redo_canvas
    progress["nodeStyle"] = {"index":1,"fill":"AABBCC","line":"334455","lineWidthPt":2,"textColor":"CCDDEE","bold":True,"italic":False,"undoRedo":"PASS"}
    progress["smartArt"] = [value(acc,ART+" textarea"),value(acc,ART+" select")]
    assert progress["smartArt"] == ["Plan\nLaunch","cycle"], progress["smartArt"]
    progress["save"] = acc.save("docx")
    progress["savedSha256"] = p4.sha256(path)
    with zipfile.ZipFile(path) as z:
        chart = z.read("word/charts/chart1.xml")
        data = z.read("word/diagrams/data1.xml")
        drawing = z.read("word/diagrams/drawing1.xml")
        assert b"Revenue Native" in chart and b'<c:barDir val="bar"' in chart and b">37<" in chart
        assert b">Plan<" in data and b">Launch<" in data
        assert b'presName="NativeStable"' in data and b'presStyleIdx="1"' in data
        assert b'AABBCC' in data and b'334455' in data and b'w="25400"' in data
        assert b'CCDDEE' in data and b'b="1"' in data and b'i="0"' in data
        assert b'AABBCC' in drawing and b'334455' in drawing and b'w="25400"' in drawing
        assert b'CCDDEE' in drawing
        changed = []
        with zipfile.ZipFile(metadata_src) as original:
            before = {name: original.read(name) for name in original.namelist()}
        with zipfile.ZipFile(path) as saved:
            after = {name: saved.read(name) for name in saved.namelist()}
        assert set(before) == set(after)
        changed = sorted(name for name in before if before[name] != after[name])
        assert changed == ["word/charts/chart1.xml", "word/diagrams/data1.xml", "word/diagrams/drawing1.xml", "word/diagrams/layout1.xml"], changed
        after_nodes = smartart_nodes(path)
        assert [node["id"] for node in after_nodes] == [node["id"] for node in original_nodes[:2]]
        assert after_nodes[0]["properties"] == original_nodes[0]["properties"]
        assert after_nodes[1]["fill"] == "AABBCC" and after_nodes[1]["line"] == "334455"
        assert after_nodes[1]["lineWidth"] == "25400" and after_nodes[1]["textFill"] == "CCDDEE"
        assert after_nodes[1]["bold"] == "1" and after_nodes[1]["italic"] == "0"
        progress["changedOpcParts"] = changed
        progress["nodeMetadataAndIds"] = "PASS"
    assert p4.rhwp_poc.close_tab(acc.d, path.name)
    acc.open_native("docx", path)
    pointer(acc,points[1],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", ART)
    assert value(acc,ART+" textarea") == "Plan\nLaunch" and value(acc,ART+" select") == "cycle"
    progress["sameAppReopenedFrame"] = smartart_selected_frame(acc)
    assert_same_frame(progress["sameAppFrame"], progress["sameAppReopenedFrame"], "same-app reopen")
    pointer(acc,points[0],ratio)
    acc.wait("return !!document.querySelector(arguments[0])", CHART)
    assert [value(acc,title),value(acc,CHART+" select"),value(acc,CHART+' input[inputmode="decimal"]')] == progress["chart"]
    progress["reopenedCanvasSha256"] = docx_canvas_digest(acc)
    assert progress["reopenedCanvasSha256"] == style_canvas_after, "saved same-app reopen changed SmartArt rendering"
    progress["reopened"] = True


def graphics_reopen(acc, progress):
    path = acc.args.saved
    if path is None or not path.is_file():
        raise AssertionError("--saved must name the independently saved SmartArt DOCX")
    progress["savedSha256"] = p4.sha256(path)
    nodes = smartart_nodes(path)
    assert len(nodes) == 2, nodes
    assert nodes[0]["properties"] == {"presName": "NativeStable", "presStyleIdx": "1"}
    assert nodes[1]["fill"] == "AABBCC" and nodes[1]["line"] == "334455"
    assert nodes[1]["lineWidth"] == "25400" and nodes[1]["textFill"] == "CCDDEE"
    assert nodes[1]["bold"] == "1" and nodes[1]["italic"] == "0"
    assert [node["text"] for node in nodes] == ["Plan", "Launch"]
    progress["savedOpcModel"] = "PASS"

    before = [line.split() for line in (acc.args.fixtures / "graphics-layout.txt").read_text().splitlines()]
    points = [(int(page), float(x) + float(w) / 2, float(y) + float(h) / 2) for page, x, y, w, h in before]
    acc.open_native("docx", path)
    acc.engine("xkb:us::eng")
    ratio = acc.d.js("return document.querySelector('.docx-page').clientWidth/612")
    pointer(acc, points[1], ratio)
    acc.wait("return !!document.querySelector(arguments[0])", ART, timeout=12)
    assert value(acc, ART + " textarea") == "Plan\nLaunch"
    assert value(acc, ART + " select") == "cycle"
    progress["freshFrame"] = smartart_selected_frame(acc)
    previous = json.loads(acc.args.previous_report.read_text())["cases"]["graphics"]
    assert_same_frame(previous["sameAppFrame"], progress["freshFrame"], "fresh-process reopen")
    style = ART + " .smart-art-node-style"
    select(acc, style + " label:nth-of-type(1) select", "1")
    assert value(acc, style + " label:nth-of-type(2) input") == "AABBCC"
    assert value(acc, style + " label:nth-of-type(3) input") == "334455"
    assert value(acc, style + " label:nth-of-type(4) input") == "2"
    assert value(acc, style + " label:nth-of-type(5) input") == "CCDDEE"
    assert value(acc, style + " label:nth-of-type(6) select") == "true"
    assert value(acc, style + " label:nth-of-type(7) select") == "false"
    progress["reopenedNodeStyle"] = "PASS"
    pointer(acc, points[0], ratio)
    acc.wait("return !!document.querySelector(arguments[0])", CHART, timeout=12)
    assert value(acc, CHART + " form:first-child input") == "Revenue Native"
    assert value(acc, CHART + " select") == "bar"
    assert value(acc, CHART + ' input[inputmode="decimal"]') == "37"
    progress["reopenedChart"] = "PASS"
    canvas = docx_canvas_digest(acc)
    expected = json.loads(acc.args.previous_report.read_text())["cases"]["graphics"]["reopenedCanvasSha256"]
    assert canvas == expected, "fresh-process reopen changed rendered chart/SmartArt placement or style"
    progress["reopenedCanvasSha256"] = canvas


CASES = {"picture":picture,"deletion":deletion,"shape":shape,"caption":caption,"graphics":graphics,"graphics-reopen":graphics_reopen}
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, default=FIXTURES)
    parser.add_argument("--saved", type=Path, help="previously saved DOCX for a new-app SmartArt reopen case")
    parser.add_argument("--previous-report", type=Path, help="graphics run report used to compare fresh-process rendering")
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
