#!/usr/bin/env python3
"""Stage 3-C Release GUI acceptance. Run under native-ibus-session.py."""
import argparse
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import shutil
import sys
import subprocess
import zipfile
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


p6 = load("native-stage3-p6")
p4 = p6.p4
FRAME = p6.FRAME
HANDLES = ("nw", "n", "ne", "e", "se", "s", "sw", "w")
WIDTH = p6.SHAPE + ' input[max="72"]'


def require(condition, message, observed=None):
    if not condition:
        raise ValueError(f"{message}: {observed!r}")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def frame(acc):
    return acc.d.js("""
      const f=document.querySelector(arguments[0]);
      return f && Object.fromEntries(['left','top','width','height']
        .map(k=>[k,parseFloat(f.style[k])]));
    """, FRAME)


def begin(acc, row, fixture, out, filename):
    path = out / filename
    shutil.copyfile(fixture, path)
    row.update(fixture=fixture.name, fixtureSha256=digest(fixture), file=filename)
    acc.open_native(path.suffix[1:], path)
    row["initialSession"] = acc.status(path.suffix[1:])
    row["engineAssets"] = acc.d.js(r"""
      return performance.getEntriesByType('resource').map(e=>e.name)
        .filter(u=>/\/(rhwp|wordcraft)\//.test(u));
    """)
    if path.suffix != ".docx":
        row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
        engine_root = Path(os.environ.get("GEUL_RHWP_TEST_ARTIFACTS", ROOT / "public/rhwp"))
        require(row["activeGeneration"] == json.loads((engine_root / "RELEASE.json").read_text())["generation"], "app and oracle engine differ")
    return path


def revision(acc, fmt, expected):
    p6.rev(acc, fmt, expected)
    return acc.status(fmt)


class SaveBlocked(ValueError):
    """The application refused publication at the preservation gate."""


def publish(acc, fmt, row):
    prefix = "docx" if fmt == "docx" else "rhwp"
    selector = f"[data-testid={prefix}-save-result]"
    acc.key("ctrl+s")
    acc.wait("return ['saved','failed'].includes(document.querySelector(arguments[0])?.dataset.state)",selector,timeout=60)
    row["save"] = acc.d.js("return {...document.querySelector(arguments[0]).dataset}",selector)
    if row["save"].get("error") == "UnsafeSave":
        raise SaveBlocked(row["save"])
    require(row["save"].get("state") == "saved", "save failed", row["save"])
    require(row["save"].get("synced") == "true", "save did not synchronize", row["save"])
    require(row["save"].get("changedSince") == "false", "save raced with edits", row["save"])
    acc.settle(fmt)
    require(acc.status(fmt)["dirty"] == "false","published session is still dirty")


def reopen(acc, path, row):
    require(p4.rhwp_poc.close_tab(acc.d, path.name), "tab did not close")
    acc.open_native(path.suffix[1:], path)
    row["reopenedSession"] = acc.status(path.suffix[1:])
    row["publishedSha256"] = digest(path)


def select_object(acc, model, kind):
    p6.pointer(acc, (model.get("page", 0), model["x"] + model["w"] / 2, model["y"] + model["h"] / 2))
    acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind===arguments[1]", FRAME, kind, timeout=8)


def require_near(a, b, message, tolerance=1.5):
    require(abs(a - b) <= tolerance, message, [a, b])


def c01(acc, row, fixtures, out):
    fixture = fixtures / "gso-original.hwp"
    before = p6.hwp(fixture)
    picture = next(item for item in before["images"] if item["props"]["treatAsChar"])
    row["before"] = before
    path = begin(acc, row, fixture, out, "c01.hwp")
    select_object(acc, picture, "picture")
    initial = frame(acc)
    handles = acc.d.js("return [...document.querySelectorAll('[data-handle]')].map(e=>e.dataset.handle)")
    require(handles == list(HANDLES), "unexpected picture handles", handles)
    acc.d.js("""
      window.c01Pointers=[];
      for(const type of ['pointerdown','pointerup']) {
        document.addEventListener(type,e=>{
          if(e.target.dataset.handle) window.c01Pointers.push({
            type,handle:e.target.dataset.handle,trusted:e.isTrusted,x:e.clientX,y:e.clientY
          });
        },true);
      }
    """)
    row["handles"] = {}
    rev = 0
    for handle in HANDLES:
        observed = row["handles"][handle] = {}
        x, y = acc.d.js("""
          const e=document.querySelector('[data-handle='+arguments[0]+']'), r=e.getBoundingClientRect();
          return [r.x+r.width/2,r.y+r.height/2];
        """, handle)
        dx = 12 if "e" in handle else -12 if "w" in handle else 0
        dy = 8 if "s" in handle else -8 if "n" in handle else 0
        sx, sy = acc.d.pointer_scale
        p4.rhwp_poc.drag(acc.d, (x*sx,y*sy), ((x+dx)*sx,(y+dy)*sy))
        observed["pointer"] = acc.d.js("return window.c01Pointers.slice()")
        revision(acc, "hwp", rev + 1)
        select_object(acc, picture, "picture")
        current = observed["geometry"] = frame(acc)
        events = observed["pointer"][-2:]
        require([(e["type"],e["handle"],e["trusted"]) for e in events] ==
                [("pointerdown",handle,True),("pointerup",handle,True)], "unexpected pointer events", events)
        dx = abs(events[1]["x"] - events[0]["x"])
        dy = abs(events[1]["y"] - events[0]["y"])
        dw, dh = (dx, dy)
        if dx and dy:
            factor = max(dx / initial["width"], dy / initial["height"])
            dw, dh = initial["width"]*factor, initial["height"]*factor
        require_near(current["width"], initial["width"] + dw, "resized width")
        require_near(current["height"], initial["height"] + dh, "resized height")
        require_near(current["left"], initial["left"], "inline horizontal anchor")
        # Growing an inline image can shift its top as the line box reflows.
        require(abs(current["top"] - initial["top"]) <= dh + 2, "inline vertical reflow", current)
        acc.key("ctrl+z")
        revision(acc,"hwp",rev+2)
        select_object(acc,picture,"picture")
        require(frame(acc) == initial, "undo geometry", frame(acc))
        if handle == HANDLES[-1]:
            acc.key("ctrl+y")
            revision(acc,"hwp",rev+3)
            select_object(acc,picture,"picture")
            require(frame(acc) == current, "redo geometry", frame(acc))
        rev += 2
    publish(acc, "hwp", row)
    after = row["after"] = p6.hwp(path)
    actual = next(item for item in after["images"] if item["controlIdx"] == picture["controlIdx"])
    require([item["props"] for item in after["images"] if item != actual] ==
            [item["props"] for item in before["images"] if item != picture], "other pictures changed")
    require([item["props"] for item in after["shapes"]] ==
            [item["props"] for item in before["shapes"]], "shape properties changed")
    require(after["body"] == before["body"], "body text changed")
    require_near(actual["w"]/picture["w"], current["width"]/initial["width"], "saved width ratio", .02)
    require_near(actual["h"]/picture["h"], current["height"]/initial["height"], "saved height ratio", .02)
    require(all(actual["props"][key] == picture["props"][key] for key in
                ("horzOffset", "vertOffset", "treatAsChar")), "inline anchor changed")
    row["unchangedBinData"] = checked_resources(fixture, path)
    reopen(acc, path, row)
    select_object(acc, actual, "picture")
    require(frame(acc) == current, "reopened geometry", frame(acc))


def c02(acc, row, fixtures, out):
    fixture = fixtures / "combined-outline-original.hwp"
    before = p6.hwp(fixture)
    require(not before["shapes"], "fixture already contains a shape")
    path = begin(acc, row, fixture, out, "c02.hwp")
    acc.key("ctrl+Home")
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.selection===''")
    label = p4.KO["ribbon.tab.insert"]
    acc.toolbar_cmd("insert.shape", label)
    select = '[data-testid=command-input-dialog] select'
    acc.wait("return document.querySelector(arguments[0])?.value==='rectangle'", select)
    acc.dom_click('[data-testid=command-input-confirm]')
    revision(acc, "hwp", 1)
    expected = p6.hwp(fixtures / "combined-outline-edited.hwp")["shapes"][0]
    select_object(acc, expected, "shape")
    row["insertedFrame"] = frame(acc)
    row["initialWidth"] = float(p6.value(acc, WIDTH))
    p6.gso.replace(acc, WIDTH, "2.45")
    acc.dom_click(p6.SHAPE + ' form:has(input[max="72"]) button[type="submit"]')
    revision(acc, "hwp", 2)
    select_object(acc, expected, "shape")
    require(float(p6.value(acc, WIDTH)) == 2.45, "outline width UI")
    acc.key("ctrl+z")
    revision(acc, "hwp", 3)
    select_object(acc, expected, "shape")
    require(float(p6.value(acc, WIDTH)) == row["initialWidth"], "outline undo value")
    acc.key("ctrl+y")
    revision(acc, "hwp", 4)
    select_object(acc, expected, "shape")
    require(float(p6.value(acc, WIDTH)) == 2.45, "outline redo value")
    require(digest(path) == row["fixtureSha256"], "disk changed before first save")
    publish(acc, "hwp", row)
    after = row["after"] = p6.hwp(path)
    require(len(after["shapes"]) == 1, "saved shape count", after)
    shape = after["shapes"][0]
    require(shape["props"]["borderWidth"] == 245, "saved outline width", shape["props"])
    require([shape["props"][k] for k in ("width","height")] == [10800,7200], "saved rectangle geometry", shape)
    require(shape["secIdx"] == 0 and shape["paraIdx"] == 0, "saved owner", shape)
    require(after["body"] == before["body"] and after["images"] == before["images"], "source content changed")
    reopen(acc, path, row)
    select_object(acc, shape, "shape")
    require(float(p6.value(acc, WIDTH)) == 2.45, "reopened outline width")
    require(frame(acc) == row["insertedFrame"], "reopened rectangle geometry", frame(acc))


def checked_resources(before, after, allow_removed=False):
    def resources(path):
        if path.suffix == ".hwp":
            return {name: data for name, data in p6.gso.cfb_streams(path.read_bytes()).items()
                    if name.startswith("BinData/")}
        with zipfile.ZipFile(path) as package:
            return {name: package.read(name) for name in package.namelist() if name.startswith("BinData/")}

    source, output = resources(before), resources(after)
    require(source, "fixture has no media resources")
    require(all(source.get(name) == data for name, data in output.items()), "changed resource payload")
    require(allow_removed or source == output, "resource missing")
    return {name: hashlib.sha256(data).hexdigest() for name, data in output.items()}


def inspect_rhwp(path, fragment):
    script = p6.ORACLE.split("try {", 1)[0] + """
    try {
      const pages = Array.from({length:doc.pageCount()},(_,i)=>JSON.parse(doc.getPageControlLayout(i)).controls);
      const controls = JSON.parse(doc.getControls());
      const body = Array.from({length:doc.getParagraphCount(0)},(_,i)=>
        doc.getTextRange(0,i,0,doc.getParagraphLength(0,i)));
      """ + fragment + """
    } finally { doc.free(); }
    """
    return json.loads(subprocess.check_output(["node","-e",script,str(path)], cwd=ROOT, text=True))


def picture_field(acc, points):
    p6.gso.replace(acc, p6.gso.SIZE, points)
    acc.key("Return")


def c04(acc, row, fixtures, out, fmt):
    fixture = fixtures / f"p2-nested-cell-picture-original.{fmt}"
    snippet = """
      const [layout] = pages, picture=layout.find(c=>c.type==='image');
      const table=layout.find(c=>c.type==='table');
      const path=JSON.stringify(picture.cellPath);
      const props=JSON.parse(doc.getCellPictureByPath(picture.secIdx,picture.paraIdx,path,picture.controlIdx));
      const deep=doc.getTextInCellByPath(picture.secIdx,picture.paraIdx,path,0,9);
      const sibling=doc.getTextInCell(picture.secIdx,picture.paraIdx,picture.outerTableControlIdx,1,0,0,13);
      console.log(JSON.stringify({layout,picture,table,body,props,deep,sibling,owners:controls.filter(c=>c.ctrlId==='tbl ')}));
    """
    before = row["before"] = inspect_rhwp(fixture, snippet)
    path = begin(acc, row, fixture, out, f"c04.{fmt}")
    select_object(acc, before["picture"], "picture")
    require(p6.gso.props(acc,"picture")["size"] == [30,24], "nested picture selection")
    picture_field(acc, 42)
    revision(acc,fmt,1)
    select_object(acc,before["picture"],"picture")
    require(p6.gso.props(acc,"picture")["size"] == [42,33.6], "nested picture resize")
    acc.key("ctrl+z")
    revision(acc,fmt,2)
    select_object(acc,before["picture"],"picture")
    require(p6.gso.props(acc,"picture")["size"] == [30,24], "nested picture undo")
    acc.key("ctrl+y")
    revision(acc,fmt,3)
    if fmt == "hwpx":
        select_object(acc,before["picture"],"picture")
        p6.gso.replace(acc,p6.gso.DESCRIPTION,"Deep cell picture")
        acc.key("Return")
        revision(acc,fmt,4)
        select_object(acc,before["picture"],"picture")
        p6.gso.replace(acc,p6.CROP + " input",12)
        acc.dom_click(p6.CROP + ' button[type="submit"]')
        revision(acc,fmt,5)
        select_object(acc,before["picture"],"picture")
        acc.key("Delete")
        revision(acc,fmt,6)
        acc.key("ctrl+z")
        revision(acc,fmt,7)
    publish(acc,fmt,row)
    after = row["after"] = inspect_rhwp(path,snippet)
    require(all(after[k] == before[k] for k in ("body","deep","sibling")), "body or cell text changed")
    require(after["picture"]["cellPath"] == before["picture"]["cellPath"] and len(after["picture"]["cellPath"]) == 2,
            "nested ownership changed")
    require([(t["colCount"],t["rowCount"],t["w"]) for t in after["layout"] if t["type"] == "table"] ==
            [(t["colCount"],t["rowCount"],t["w"]) for t in before["layout"] if t["type"] == "table"], "table structure changed")
    require(all(after["props"][k] == before["props"][k] for k in before["props"]
                if k not in {"width","height","description","crop"}), "nested picture resource or layout property changed",after["props"])
    require_near(after["picture"]["w"]/before["picture"]["w"],1.4,"saved nested picture width",.01)
    require_near(after["picture"]["h"]/before["picture"]["h"],1.4,"saved nested picture height",.01)
    row["unchangedBinData"] = checked_resources(fixture,path)
    reopen(acc,path,row)
    select_object(acc,after["picture"],"picture")
    require(p6.gso.props(acc,"picture") ==
            {"size":[42,33.6],"description":"Deep cell picture" if fmt == "hwpx" else None}, "reopened nested picture")
    if fmt == "hwpx":
        require(float(p6.value(acc,p6.CROP + " input")) == 12, "reopened crop")


def c05(acc, row, fixtures, out):
    textbox = load("native-stage3-textbox")
    fixture = fixtures / "p2-multipara-original.hwpx"
    before = row["before"] = textbox.inspect(fixture)
    path = begin(acc,row,fixture,out,"c05.hwpx")
    def point(model):
        at = model["caret"]
        xy = acc.d.js("""
          const at=arguments[0], c=document.querySelectorAll('.rhwp-page__canvas')[at.pageIndex];
          const s=document.querySelector('.editor__scroll'), r=c.getBoundingClientRect(), v=s.getBoundingClientRect();
          const k=r.width/c.clientWidth;
          s.scrollTop += r.top+(at.y+at.height/2)*k-(v.top+v.height/2);
          const n=c.getBoundingClientRect();
          return [n.left+(at.x+1)*k,n.top+(at.y+at.height/2)*k];
        """,at)
        sx,sy=acc.d.pointer_scale
        p4.rhwp_poc.perform(acc.d,[{"type":"pointer","id":"textbox-mouse","parameters":{"pointerType":"mouse"},"actions":[
            {"type":"pointerMove","x":round(xy[0]*sx),"y":round(xy[1]*sy),"origin":"viewport"},
            {"type":"pointerDown","button":0},{"type":"pointerUp","button":0},{"type":"pause","duration":40},
            {"type":"pointerDown","button":0},{"type":"pointerUp","button":0}]}])
        acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.endsWith('/0/1')",timeout=6)
    point(before)
    acc.text_is("hwpx",before["paragraphs"][1])
    acc.d.js("""
      window.c05Ime=[];
      for(const type of ['compositionstart','compositionupdate','compositionend'])
        window.addEventListener(type,e=>window.c05Ime.push([e.type,e.data,e.isTrusted]),true);
    """)
    acc.engine("hangul")
    acc.type("gk")
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.composing==='true'")
    acc.type("srmf")
    acc.key("End")
    expected = "한글" + before["paragraphs"][1]
    acc.text_is("hwpx",expected)
    acc.settle("hwpx")
    row["events"] = acc.d.js("return window.c05Ime")
    for event in ("compositionstart","compositionupdate","compositionend"):
        require(any(r[0]==event and r[2] for r in row["events"]), f"missing trusted {event}")
    acc.engine("xkb:us::eng")
    rev = int(acc.status("hwpx")["revision"])
    require(rev > 0,"no committed IME revision")
    acc.key("ctrl+z")
    revision(acc,"hwpx",rev+1)
    acc.text_is("hwpx",before["paragraphs"][1])
    acc.key("ctrl+y")
    revision(acc,"hwpx",rev+2)
    acc.text_is("hwpx",expected)
    publish(acc,"hwpx",row)
    after = row["after"] = textbox.inspect(path)
    require(after["paragraphs"] == [before["paragraphs"][0],expected] and after["body"] == before["body"],
            "saved textbox story",after)
    reopen(acc,path,row)
    point(after)
    acc.text_is("hwpx",expected)


def c06(acc,row,fixtures,out):
    fixture = fixtures / "p3-layer-original.hwp"
    before = row["before"] = p6.hwp(fixture)
    first, second = before["shapes"]
    path = begin(acc,row,fixture,out,"c06.hwp")
    x, y = first["x"]+first["w"]-10,first["y"]+first["h"]-10
    def hit(expected):
        p6.pointer(acc,(0,x,y))
        acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='shape'",FRAME)
        geometry = frame(acc)
        scale = geometry["width"]/expected["w"]
        require_near(geometry["left"],expected["x"]*scale,"overlap hit identity")
        return geometry
    row["topBefore"] = hit(second)
    acc.dom_click(p6.SHAPE + ' button', "Array.from(document.querySelectorAll(arguments[0])).find(b=>b.textContent.trim()=== " + json.dumps(p4.KO["properties.shape.back"]) + ")")
    revision(acc,"hwp",1)
    row["topAfter"] = hit(first)
    acc.key("ctrl+z")
    revision(acc,"hwp",2)
    hit(second)
    acc.key("ctrl+y")
    revision(acc,"hwp",3)
    hit(first)
    publish(acc,"hwp",row)
    after = row["after"] = p6.hwp(path)
    a,b = sorted(after["shapes"],key=lambda s:s["controlIdx"])
    require(a == first and b == {**second,"zOrder":b["zOrder"],"props":{**second["props"],"zOrder":b["props"]["zOrder"]}},
            "z-order changed shape geometry or ownership",after)
    require(b["props"]["zOrder"] < a["props"]["zOrder"] and after["body"] == before["body"],
            "saved layer order or body",after)
    reopen(acc,path,row)
    hit(first)


def c07(acc,row,fixtures,out,fmt):
    fixture = fixtures / f"p3-position-original.{fmt}"
    snippet = """
      const images = pages[0].filter(x=>x.type==='image').map(c=>({...c,
        props:JSON.parse(doc.getPictureProperties(c.secIdx,c.paraIdx,c.controlIdx))}));
      console.log(JSON.stringify({body,images,page:JSON.parse(doc.getPageInfo(0))}));
    """
    before = row["before"] = inspect_rhwp(fixture,snippet)
    picture = next(i for i in before["images"] if not i["props"]["treatAsChar"])
    path = begin(acc,row,fixture,out,f"c07.{fmt}")
    pos = p6.TOOLS + " select:has(option[value=topLeft])"
    expected = picture
    page = before["page"]
    row["presets"] = []
    acc.d.js("""
      window.c07Changes=[];
      document.addEventListener('change',e=>{
        if(e.target.matches(arguments[0])) window.c07Changes.push({value:e.target.value,trusted:e.isTrusted});
      },true);
    """,pos)
    presets=acc.d.js("return [...document.querySelector(arguments[0]).options].slice(1).map(o=>o.value)",pos) if acc.d.exists(pos) else None
    for i in range(9):
        select_object(acc,expected,"picture")
        if presets is None:
            presets=acc.d.js("return [...document.querySelector(arguments[0]).options].slice(1).map(o=>o.value)",pos)
            require(len(presets)==9,"number of available GUI presets",presets)
        # WebKitGTK commits the first arrow key when the list is closed.
        # Use WebDriver's browser-level option click to choose an exact entry.
        acc.d.click(f'{pos} > option[value="{presets[i]}"]')
        row["lastPresetCommand"] = {"index":i,"session":acc.status(fmt),"events":acc.d.js("return window.c07Changes")}
        require(row["lastPresetCommand"]["events"][-1:] == [{"value":presets[i],"trusted":True}],
                "WebDriver option did not emit a trusted choice",row["lastPresetCommand"])
        revision(acc,fmt,i+1)
        fx,fy=(i%3)/2,(i//3)/2
        top=page["marginTop"]+page["marginHeader"]
        bottom=page["height"]-page["marginBottom"]-page["marginFooter"]
        expected={**expected,"x":page["bodyLeft"]+(page["bodyRight"]-page["bodyLeft"]-picture["w"])*fx,
                  "y":top+(bottom-top-picture["h"])*fy}
        select_object(acc,expected,"picture")
        actual=frame(acc)
        scale=actual["width"]/picture["w"]
        require_near(actual["left"],expected["x"]*scale,"preset x")
        require_near(actual["top"],expected["y"]*scale,"preset y")
        row["presets"].append({"index":i,"observed":actual,"expected":expected})
    acc.key("ctrl+z")
    revision(acc,fmt,10)
    select_object(acc,row["presets"][-2]["expected"],"picture")
    require(frame(acc) == row["presets"][-2]["observed"],"preset undo geometry")
    acc.key("ctrl+y")
    revision(acc,fmt,11)
    select_object(acc,expected,"picture")
    require(frame(acc) == row["presets"][-1]["observed"],"preset redo geometry")
    publish(acc,fmt,row)
    after = row["after"] = inspect_rhwp(path,snippet)
    actual = next(i for i in after["images"] if i["controlIdx"] == picture["controlIdx"])
    require(actual["props"] == {**picture["props"],"horzRelTo":"Page","vertRelTo":"Page",
            "horzAlign":"Right","vertAlign":"Bottom","horzOffset":0,"vertOffset":0}, "saved preset properties",actual)
    require(after["body"] == before["body"] and
            [i for i in after["images"] if i != actual] == [i for i in before["images"] if i != picture], "unrelated body or picture changed")
    row["unchangedBinData"] = checked_resources(fixture,path)
    reopen(acc,path,row)
    select_object(acc,actual,"picture")
    require(frame(acc) == row["presets"][-1]["observed"],"reopened preset geometry")


def inspect_docx(path):
    from xml.etree import ElementTree as ET
    fixture = load("stage3-c-docx-fixture")
    ns = {name:getattr(fixture,name.upper()) for name in ("w","wp","a","r","pic","wps")}
    result = {"drawings":[]}
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("word/document.xml"))
        parents = {child:parent for parent in root.iter() for child in parent}
        result["text"] = [t.text for t in root.findall(".//w:t",ns)]
        for inline in root.findall(".//wp:inline",ns):
            props = inline.find("wp:docPr",ns)
            parent = parents.get(inline)
            owners = []
            while parent is not None:
                if parent.tag in (f"{{{ns['w']}}}tc",f"{{{ns['w']}}}txbxContent"):
                    owners.append(parent.tag.split("}")[1])
                parent = parents.get(parent)
            shp = inline.find("./a:graphic/a:graphicData/wps:wsp/wps:spPr",ns)
            color = None if shp is None else shp.find("./a:solidFill/a:srgbClr",ns)
            embed = inline.find("./a:graphic/a:graphicData/pic:pic/pic:blipFill/a:blip",ns)
            image = None
            if embed is not None:
                rid = embed.get(f"{{{ns['r']}}}embed")
                rels = ET.fromstring(package.read("word/_rels/document.xml.rels"))
                rel = next(r for r in rels if r.get("Id") == rid and r.get("Type").endswith("/image"))
                image = hashlib.sha256(package.read("word/" + rel.get("Target"))).hexdigest()
            result["drawings"].append({"id":props.get("id"),"name":props.get("name"),
                "desc":props.get("descr"),"owners":owners,"image":image,
                "extent":inline.find("wp:extent",ns).attrib,
                "color":color.get("val") if color is not None else None})
    return result


def c03(acc,row,fixtures,out):
    fixture = fixtures / "c03-canonical.docx"
    row["before"] = baseline = inspect_docx(fixture)
    path = begin(acc,row,fixture,out,"c03.docx")
    row["operations"] = []
    for i,(color,kind) in enumerate((("D83759","picture"),("28A4C2","shape"),("7A47A8","shape"),("F1BA49","textBox")),1):
        def pixel_point(mark, edge=False):
            return acc.d.js("""
          const rgb=arguments[0];
          for(const c of document.querySelectorAll('.docx-page canvas')){
            const image=c.getContext('2d').getImageData(0,0,c.width,c.height);
            const xs=[],ys=[];
            for(let i=0;i<image.data.length;i+=4){
              if(rgb.every((v,j)=>v===image.data[i+j])){xs.push((i/4)%c.width);ys.push(Math.floor(i/4/c.width));}
            }
            if(xs.length>100){
              const sortedX=xs.sort((a,b)=>a-b),sortedY=ys.sort((a,b)=>a-b);
              return [+c.parentElement.dataset.page,
                (arguments[1] ? sortedX[0]+1 : sortedX[Math.floor(xs.length/2)])*c.clientWidth/c.width,
                sortedY[Math.floor(ys.length/2)]*c.clientHeight/c.height];
            }
          }
          return null;
        """,list(bytes.fromhex(mark)),edge)
        if color == "7A47A8":
            owner_caret = pixel_point("DDDDDD")
            require(owner_caret is not None, "textbox story canvas not painted")
            p6.pointer(acc,owner_caret)
            acc.settle("docx")
            row["bodyTextboxCaret"] = acc.status("docx")["caret"]
        at = pixel_point(color,kind=="textBox")
        require(at is not None,"painted object color unavailable",color)
        p6.pointer(acc,at)
        acc.settle("docx")
        observed=acc.d.js("return document.querySelector(arguments[0])?.dataset.objectKind",FRAME)
        row["operations"].append({"target":color,"point":at,"selectedKind":observed})
        require(observed == kind,"wrong drawing selected",observed)
        if kind == "picture":
            p6.gso.replace(acc,p6.gso.DESCRIPTION,"C03 depth-two picture")
            acc.key("Return")
        else:
            acc.dom_click(p6.SHAPE + ' button', "Array.from(document.querySelectorAll(arguments[0])).find(b=>b.textContent.trim()=== " + json.dumps(p4.KO["properties.shape.noFill"]) + ")")
        revision(acc,"docx",i)
    acc.key("ctrl+z")
    revision(acc,"docx",5)
    acc.key("ctrl+y")
    revision(acc,"docx",6)
    publish(acc,"docx",row)
    row["after"] = result = inspect_docx(path)
    require(result["text"] == baseline["text"],"DOCX story text changed",result)
    expected = [{**drawing, **patch} for drawing,patch in zip(baseline["drawings"],
        [{"desc":"C03 depth-two picture"},{"color":None},{"color":None},{},{"color":None}],strict=True)]
    require(result["drawings"] == expected,"saved drawings, owner paths or resource relationship differ",result)
    reopen(acc,path,row)


def core_shapes(path):
    return inspect_rhwp(path, """
      const frames=pages.flatMap((page,i)=>page.filter(c=>['shape','group'].includes(c.type)).map(c=>
        ({...c,page:i,props:JSON.parse(doc.getShapeProperties(c.secIdx,c.paraIdx,c.controlIdx))})));
      console.log(JSON.stringify({frames,body}));
    """)


def shape_payload(path, group=False):
    if path.suffix == ".hwp":
        rows = p6.gso.records(p6.gso.unpacked(p6.gso.cfb_streams(path.read_bytes()),"BodyText/Section0"))
        return [(tag,level,raw.hex()) for tag,level,raw in rows
                if (group and level >= 3) or (not group and tag in (82,83))]
    from xml.etree import ElementTree as ET
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("Contents/section0.xml"))
    names = ("container",) if group else ("polygon","curve")
    controls = [node for node in root.iter() if node.tag.split("}")[-1] in names]
    return [ET.tostring(child).decode() for node in controls for child in node
            if child.tag.split("}")[-1] in (("rect","ellipse","line","pic","container") if group else ("pt","seg"))]


def c08(acc,row,fixtures,out,fmt):
    fixture = fixtures / f"p3-poly-curve-original.{fmt}"
    before = row["before"] = core_shapes(fixture)
    payload = shape_payload(fixture)
    require(len(before["frames"]) == 2 and payload,"missing polygon/curve records")
    path = begin(acc,row,fixture,out,f"c08.{fmt}")
    for i,shape in enumerate(before["frames"]):
        select_object(acc,shape,"shape")
        old = frame(acc)
        acc.key("shift+Right")
        revision(acc,fmt,i+1)
        select_object(acc,shape,"shape")
        require(frame(acc)["left"] > old["left"],"outer shape did not move",frame(acc))
    acc.key("ctrl+z")
    revision(acc,fmt,3)
    acc.key("ctrl+y")
    revision(acc,fmt,4)
    publish(acc,fmt,row)
    after = row["after"] = core_shapes(path)
    require(after["body"] == before["body"],"body changed")
    require(shape_payload(path) == payload,"original vertices or segments changed")
    for a,b in zip(before["frames"],after["frames"],strict=True):
        require(b["props"] == {**a["props"],"horzOffset":b["props"]["horzOffset"]} and
                b["props"]["horzOffset"] > a["props"]["horzOffset"],"unexpected saved shape properties",b)
    reopen(acc,path,row)
    for shape in after["frames"]:
        select_object(acc,shape,"shape")
        acc.key("Escape")


def group_placement(group):
    """The stored reference, alignment and offsets that locate a group."""
    return {key: group["props"][key] for key in (
        "horzRelTo", "vertRelTo", "horzAlign", "vertAlign", "treatAsChar", "horzOffset", "vertOffset",
    )}


def verify_group_origin(visible, layout, scale, context):
    require_near(visible["left"], layout["x"] * scale, f"{context}: horizontal origin", .2)
    require_near(visible["top"], layout["y"] * scale, f"{context}: vertical origin", .2)


def verify_group_placement(saved, expected):
    actual = group_placement(saved)
    require(actual == expected, "saved group placement does not match the movement and anchor basis",
            {"expected": expected, "observed": actual})


def c09(acc,row,fixtures,out,fmt):
    fixture = fixtures / f"p3-group-original.{fmt}"
    before = row["before"] = core_shapes(fixture)
    payload = shape_payload(fixture,group=True)
    require(len(before["frames"]) == 1 and payload,"missing group or children")
    group = before["frames"][0]
    path = begin(acc,row,fixture,out,f"c09.{fmt}")
    select_object(acc,group,"group")
    start = row["startFrame"] = frame(acc)
    scale = start["width"] / group["w"]
    original_placement = group_placement(group)
    require(not original_placement["treatAsChar"] and
            (original_placement["horzAlign"], original_placement["vertAlign"]) == ("Left", "Top"),
            "fixture must have a movable group anchored at its top left", original_placement)
    verify_group_origin(start, group, scale, "original group")
    acc.key("shift+Right")
    revision(acc,fmt,1)
    select_object(acc,group,"group")
    moved = row["movedFrame"] = frame(acc)
    # Shift+Right nudges 10 pt. The RHWP model stores 100 HWPUNIT/pt
    # and its unzoomed layout uses 96 px/in (72 pt/in).
    nudge_pt = 10
    moved_layout = {**group, "x": group["x"] + nudge_pt * 96 / 72}
    verify_group_origin(moved, moved_layout, scale, "live group movement")
    expected_placement = {**original_placement, "horzOffset": original_placement["horzOffset"] + nudge_pt * 100}
    row["placement"] = {"original": original_placement, "expected": expected_placement}
    row["beforeResize"] = moved
    x,y = acc.d.js("""
      const r=document.querySelector('[data-handle=e]').getBoundingClientRect();
      return [r.x+r.width/2,r.y+r.height/2]
    """)
    sx,sy=acc.d.pointer_scale
    p4.rhwp_poc.drag(acc.d,(x*sx,y*sy),((x+14)*sx,y*sy))
    revision(acc,fmt,2)
    select_object(acc,group,"group")
    resized = row["afterResize"] = frame(acc)
    # Inspect the placement binding before labeling any missing UI as a product gap.
    row["placementControl"] = acc.d.js("return !!document.querySelector(arguments[0])",p6.WRAP)
    acc.key("ctrl+z")
    revision(acc,fmt,3)
    select_object(acc,group,"group")
    require(frame(acc) == moved,"group resize undo")
    acc.key("ctrl+y")
    revision(acc,fmt,4)
    select_object(acc,group,"group")
    require(frame(acc) == resized,"group resize redo")
    if fmt == "hwpx":
        acc.key("Delete")
        revision(acc,fmt,5)
        acc.key("ctrl+z")
        revision(acc,fmt,6)
    wrap_revision = 7 if fmt == "hwpx" else 5
    select_object(acc,group,"group")
    require(p6.value(acc,p6.WRAP) == "square","starting group wrap")
    acc.d.click(p6.WRAP + ' option[value="topAndBottom"]')
    revision(acc,fmt,wrap_revision)
    acc.key("ctrl+z")
    revision(acc,fmt,wrap_revision+1)
    select_object(acc,group,"group")
    require(p6.value(acc,p6.WRAP) == "square","group wrapping undo")
    acc.key("ctrl+y")
    revision(acc,fmt,wrap_revision+2)
    select_object(acc,moved_layout,"group")
    wrapped = row["wrappedFrame"] = frame(acc)
    publish(acc,fmt,row)
    after = row["after"] = core_shapes(path)
    require(after["body"] == before["body"],"group edit changed body")
    require(len(after["frames"]) == 1,"published group count changed")
    saved = after["frames"][0]
    require(all(saved[key] == group[key] for key in ("secIdx","paraIdx","controlIdx","page")),
            "published group address changed", saved)
    require(saved["props"]["textWrap"] == "TopAndBottom","saved group wrap")
    # The known Square -> TopAndBottom transition retains the positioning basis
    # of this fixture. Check it explicitly along with both HWPUNIT offsets.
    row["placement"]["published"] = group_placement(saved)
    verify_group_placement(saved, expected_placement)
    verify_group_origin(wrapped, saved, scale, "published group versus live wrapped group")
    require(shape_payload(path,group=True) == payload,"group child geometry or transforms changed")
    reopen(acc,path,row)
    select_object(acc,saved,"group")
    reopened = row["reopenedFrame"] = frame(acc)
    row["reopenedPage"] = acc.d.js("return +document.querySelector(arguments[0]).closest('.rhwp-page').dataset.page", FRAME)
    require(row["reopenedPage"] == saved["page"], "reopened group page differs")
    verify_group_origin(reopened, saved, scale, "reopened group versus published group")
    require(reopened["width"] == resized["width"] and reopened["height"] == resized["height"],
            "reopened group dimensions differ")
    require(p6.value(acc,p6.WRAP) == "topAndBottom","reopened group wrap")
    require_near(resized["width"],moved["width"]+14,"group width did not follow pointer")
    require_near(resized["height"],moved["height"],"group height changed on east handle")
    require(row["placementControl"],"group wrap binding unavailable")


def clipboard_peer(acc, mime, text, action, *, plain=None):
    libraries = sorted(Path("/nix/store").glob("*-gtk+3-*/lib/libgtk-3.so.0"))
    require(libraries, "GTK clipboard peer dependency")
    argv = [sys.executable,str(HERE / "native-stage3-clipboard-mime.py"),"--peer","offer",
            "--gtk",str(libraries[-1]),"--mime",mime]
    if plain is not None:
        argv.extend(["--plain",plain])
    # The existing GTK peer uses assert around GTK calls with side effects.
    # Run the separate peer with assertions enabled and require its readiness.
    env = {k:v for k,v in os.environ.items() if k != "PYTHONOPTIMIZE"}
    with subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=env) as peer:
        try:
            peer.stdin.write(text)
            peer.stdin.close()
            require(peer.stdout.readline().strip() == "ready","clipboard owner failed to start")
            action()
        finally:
            peer.terminate()
            peer.wait(timeout=10)


def validated_unchanged(acc, state, path, source_hash):
    acc.settle("hwpx")
    current = acc.status("hwpx")
    for k in ("revision","localRevision","dirty","paragraphText","selection","caret"):
        require(current[k] == state[k], f"refusal changed {k}", current)
    require(digest(path) == source_hash,"refusal changed destination file")
    return current


def clip_copy(acc, frame_):
    select_object(acc,frame_,"picture")
    acc.key("ctrl+c")


def body_end(acc):
    acc.key("Escape","ctrl+End")
    acc.wait("return document.querySelector(arguments[0])===null",FRAME)


def c10(acc,row,fixtures,out):
    fixture = fixtures / "p4-clipboard-original.hwpx"
    before = row["before"] = p6.hwp(fixture)
    original = before["images"][0]
    path = begin(acc,row,fixture,out,"c10.hwpx")
    clip_copy(acc,original)
    body_end(acc)
    acc.key("ctrl+v")
    revision(acc,"hwpx",1)
    acc.key("ctrl+z")
    revision(acc,"hwpx",2)
    acc.key("ctrl+y")
    revision(acc,"hwpx",3)
    select_object(acc,original,"picture")
    acc.key("ctrl+x")
    revision(acc,"hwpx",4)
    acc.key("ctrl+z")
    revision(acc,"hwpx",5)
    acc.key("ctrl+y")
    revision(acc,"hwpx",6)
    acc.key("ctrl+z")
    revision(acc,"hwpx",7)
    publish(acc,"hwpx",row)
    after = row["after"] = p6.hwp(path)
    require(len(after["images"]) == 2,"saved picture count",after["images"])
    require(len({(x["paraIdx"],x["controlIdx"]) for x in after["images"]}) == 2,"picture addresses collided")
    props = original["props"]
    require(all(all(p["props"][k] == props[k] for k in ("width","height","description","treatAsChar"))
                for p in after["images"]), "pasted picture properties")
    require(after["body"] == before["body"],"clipboard changed body text")
    require([x["props"] for x in after["shapes"]] == [x["props"] for x in before["shapes"]],"clipboard changed other shapes")
    row["unchangedBinData"] = checked_resources(fixture,path)
    reopen(acc,path,row)
    for picture in after["images"]:
        select_object(acc,picture,"picture")
        acc.key("Escape")


def c11(acc,row,fixtures,out):
    fixture = fixtures / "p4-clipboard-original.hwpx"
    picture = p6.hwp(fixture)["images"][0]
    source = begin(acc,row,fixture,out,"c11-source.hwpx")
    clip_copy(acc,picture)
    destination = out / "c11-destination.hwpx"
    shutil.copyfile(fixtures / "p2-multipara-original.hwpx",destination)
    acc.open_native("hwpx",destination)
    initial = acc.status("hwpx")
    source_hash = digest(destination)
    row["destinationSha256"] = source_hash
    row["negative"] = {}
    acc.key("ctrl+v")
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.revision==='0'")
    row["negative"]["cross-document"] = validated_unchanged(acc,initial,destination,source_hash)
    marker = "Geul picture [" + "0"*24 + "]"
    def refuse(key):
        acc.key("ctrl+v","ctrl+z","ctrl+y")
        row["negative"][key] = validated_unchanged(acc,initial,destination,source_hash)
    clipboard_peer(acc,"UTF8_STRING",marker,lambda:refuse("orphan marker"))
    clipboard_peer(acc,"application/x-geul-object+json","{",lambda:refuse("malformed MIME with plain fallback"),
                   plain="Should not be inserted")
    ordinary = "Geul picture [ordinary]"
    clipboard_peer(acc,"UTF8_STRING",ordinary,lambda:acc.key("ctrl+v"))
    revision(acc,"hwpx",1)
    require(ordinary in acc.status("hwpx")["paragraphText"],"ordinary plain text paste")
    acc.key("ctrl+z")
    revision(acc,"hwpx",2)
    require(acc.status("hwpx")["paragraphText"] == initial["paragraphText"],"normal text undo")
    require(digest(destination) == source_hash,"destination changed on disk")
    row["sourceSha256After"] = digest(source)


def chart_model(path):
    return inspect_rhwp(path,"""
      const frame=pages.flatMap((p,i)=>p.filter(c=>c.type==='ole').map(c=>({...c,page:i})))
        .find(c=>JSON.parse(doc.getChartData(c.secIdx,c.paraIdx,c.controlIdx)).ok);
      const chart=JSON.parse(doc.getChartData(frame.secIdx,frame.paraIdx,frame.controlIdx));
      console.log(JSON.stringify({frame,chart,body,controls}));
    """)


def chart_preservation(source,path):
    if path.suffix == ".hwp":
        files = [p6.gso.cfb_streams(p.read_bytes()) for p in (source,path)]
        old,new = ({k:v for k,v in f.items() if k.startswith("BinData/")} for f in files)
        require(old.keys() == new.keys(),"chart changed HWP resource identifiers")
        changed = [k for k in old if old[k] != new[k]]
        require(len(changed)==1 and changed[0].upper().endswith(".OLE"),"unexpected HWP resource changes",changed)
        def nested(f):
            blob = p6.gso.unpacked(f,changed[0])
            require(len(blob)>4,"empty chart OLE")
            return p6.gso.cfb_streams(blob[4:])
        a,b = map(nested,files)
        require(a.keys()==b.keys(),"nested OLE relationships changed")
        edited = [k for k in a if a[k]!=b[k]]
        require(edited == ["OOXMLChartContents"],"saved non-chart OLE streams changed",edited)
        return {"changedResources":changed,"changedNestedStreams":edited}
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(path) as b:
        refs = lambda p:{n:p.read(n) for n in p.namelist() if n.endswith(".rels")}
        require(refs(a)==refs(b),"chart changed package relationships")
        chart_files = [n for n in a.namelist() if "chart" in n.lower() and n.lower().endswith(".xml")]
        require(any(a.read(n)!=b.read(n) for n in chart_files),"no saved chart part changes")
        old = {n:a.read(n) for n in a.namelist() if n.startswith("BinData/")}
        new = {n:b.read(n) for n in b.namelist() if n.startswith("BinData/")}
        require(old.keys()==new.keys(),"chart changed HWPX resource identifiers")
        changed = [n for n in old if old[n]!=new[n]]
        require(all(n.lower().endswith((".ole",".xml")) for n in changed),"unrelated chart resources changed",changed)
        return {"chartParts":chart_files,"changedResources":changed}


def c12(acc,row,fixtures,out,fmt,alternative=False):
    fixture = ROOT / f"external/rhwp/samples/issue7406/7406_OLE__CHART.{fmt}"
    if alternative and fmt == "hwpx":
        source = ROOT / "external/rhwp/samples/chart/세로막대형/묶은세로막대형.hwpx"
        row["upstreamFixtureSha256"] = digest(source)
        # Match the explicit blank-preview original in T009's chart proof.
        # Create the fixture before opening it, and leave the published file to geul.
        fixture = out / "c12-bar-blank-preview-original.hwpx"
        with zipfile.ZipFile(fixtures / "p2-multipara-original.hwpx") as blank:
            preview = blank.read("Preview/PrvImage.png")
        require(len(preview) == 68,"expected the RHWP empty preview fixture")
        with zipfile.ZipFile(source) as zin, zipfile.ZipFile(fixture,"x") as zout:
            for item in zin.infolist():
                zout.writestr(item,preview if item.filename == "Preview/PrvImage.png" else zin.read(item))
    if alternative and fmt == "hwp":
        row["upstreamFixtureSha256"] = digest(fixture)
        original_streams = p6.gso.cfb_streams(fixture.read_bytes())
        fixture = fixtures / "c12-blank-preview-original.hwp"
        blank_streams = p6.gso.cfb_streams(fixture.read_bytes())
        require(original_streams.keys() == blank_streams.keys(),"chart input storage map changed")
        require(all(blank_streams[k]==v for k,v in original_streams.items() if k!="PrvImage"),
                "chart fixture preparation changed non-preview streams")
        require(hashlib.sha256(blank_streams["PrvImage"]).hexdigest() ==
                "2103d51fb863769afce086d2aa45eda343808e1c478527a9d40b3dfbebe513c6",
                "chart fixture lacks the T009 known blank preview")
    before = row["before"] = chart_model(fixture)
    path = begin(acc,row,fixture,out,f"c12.{fmt}")
    select_object(acc,before["frame"],"chart")
    value = p6.CHART + ' .chart-data-row input[inputmode=decimal]'
    category = p6.CHART + ' .chart-data-fields > input[type=text]'
    series = p6.CHART + ' .chart-data-row input:not([inputmode])'
    expected = before["chart"]["series"][0]["values"][0]
    require(float(p6.value(acc,value)) == float(expected),"selected chart data cell")
    p6.gso.replace(acc,value,"42.5")
    p6.gso.replace(acc,category,"Native category")
    if before["chart"]["series"][0]["name"] is not None:
        p6.gso.replace(acc,series,"Native series")
    acc.dom_click(p6.CHART + ' form:has(.chart-data-fields) button[type=submit]')
    revision(acc,fmt,1)
    select_object(acc,before["frame"],"chart")
    require(float(p6.value(acc,value)) == 42.5 and p6.value(acc,category) == "Native category","new chart data UI")
    acc.key("ctrl+z")
    revision(acc,fmt,2)
    select_object(acc,before["frame"],"chart")
    require(float(p6.value(acc,value)) == float(expected),"chart undo")
    acc.key("ctrl+y")
    revision(acc,fmt,3)
    select_object(acc,before["frame"],"chart")
    require(float(p6.value(acc,value)) == 42.5,"chart redo")
    publish(acc,fmt,row)
    after = row["after"] = chart_model(path)
    require(after["frame"] == before["frame"] and after["body"] == before["body"],"chart geometry or body changed")
    original = before["chart"]
    labels = ["Native category",*original["labels"][1:]]
    series_data = [{**original["series"][0],"name":"Native series","values":["42.5",*original["series"][0]["values"][1:]]},
                   *original["series"][1:]]
    require(after["chart"] == {**original,"labels":labels,"series":series_data},"saved chart data",after["chart"])
    row["resources"] = chart_preservation(fixture,path)
    reopen(acc,path,row)
    select_object(acc,after["frame"],"chart")
    require(float(p6.value(acc,value)) == 42.5 and p6.value(acc,category) == "Native category","reopened chart data")


def caption_model(path):
    return inspect_rhwp(path,"""
      const picture=pages.flatMap((p,page)=>p.filter(c=>c.type==='image').map(c=>({...c,page})))
        .find(c=>JSON.parse(doc.getPictureProperties(c.secIdx,c.paraIdx,c.controlIdx)).hasCaption);
      const owner=[picture.secIdx,picture.paraIdx,picture.controlIdx], a=[...owner,0];
      const count=doc.getCellParagraphCount(...a);
      const texts=Array.from({length:count},(_,i)=>doc.getTextInCell(...a,i,0,doc.getCellParagraphLength(...a,i)));
      const end=JSON.parse(doc.getCursorRectInCell(...a,0,doc.getCellParagraphLength(...a,0)));
      console.log(JSON.stringify({picture,props:JSON.parse(doc.getPictureProperties(...owner)), count,texts,end,body,
        atnos:controls.filter(c=>c.ctrlId==='atno')}));
    """)


def c13(acc,row,fixtures,out,fmt):
    fixture = fixtures / f"c13-original.{fmt}"
    before = row["before"] = caption_model(fixture)
    require(before["count"] == 64 and len(before["atnos"]) == 1,"invalid initial caption fixture")
    path = begin(acc,row,fixture,out,f"c13.{fmt}")
    select_object(acc,before["picture"],"picture")
    def end_of_first(model):
        point=model["end"]
        p6.pointer(acc,(point["pageIndex"],point["x"]+1,point["y"]+point["height"]/2))
        acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
        acc.key("End")
        acc.text_is(fmt,model["texts"][0])
    end_of_first(before)
    row["boundary"] = {}
    def refused(name, action):
        state = acc.status(fmt)
        action()
        acc.settle(fmt)
        now = acc.status(fmt)
        for k in ("revision","localRevision","caret","selection","paragraphText","dirty"):
            require(state[k] == now[k], f"{name} changed {k}", [state,now])
        require(digest(path) == row["fixtureSha256"],"refusal touched published bytes")
        row["boundary"][name] = {"before":state,"after":now}
    refused("Enter at 64",lambda:acc.key("Return"))
    acc.key("shift+Right")
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.selection!==''")
    refused("paste producing 65",lambda:clipboard_peer(acc,"UTF8_STRING","A\nB\nC",lambda:acc.key("ctrl+v")))
    acc.key("Return")
    revision(acc,fmt,1)
    row["boundary"]["Enter replaces boundary"] = acc.status(fmt)
    acc.key("ctrl+z")
    revision(acc,fmt,2)
    end_of_first(before)
    acc.key("shift+Right")
    clipboard_peer(acc,"UTF8_STRING","A\nB",lambda:acc.key("ctrl+v"))
    revision(acc,fmt,3)
    acc.text_is(fmt,"Bx")
    acc.key("ctrl+z")
    revision(acc,fmt,4)
    acc.key("ctrl+y")
    revision(acc,fmt,5)
    acc.text_is(fmt,"Bx")
    acc.key("Home","Left","Home")
    acc.key("Right","Right")
    refused("Delete at auto-number",lambda:acc.key("Delete"))
    acc.key("Right")
    refused("Backspace at auto-number",lambda:acc.key("BackSpace"))
    acc.key("Home","shift+Right","shift+Right","shift+Right")
    refused("replacement over auto-number",lambda:clipboard_peer(acc,"UTF8_STRING","X\nY",lambda:acc.key("ctrl+v")))
    acc.key("End")
    acc.type("Z")
    revision(acc,fmt,6)
    publish(acc,fmt,row)
    after = row["after"] = caption_model(path)
    require(after["count"]==64,"published caption count",after["count"])
    require(after["texts"] == [before["texts"][0]+"AZ","Bx",*before["texts"][2:]],"published caption texts",after["texts"])
    require(all(after[k]==before[k] for k in ("atnos","props","body")),"caption edit affected numbering, owner or body")
    row["unchangedBinData"] = checked_resources(fixture,path)
    reopen(acc,path,row)
    select_object(acc,after["picture"],"picture")
    end_of_first(after)


CASES = {"C01": c01, "C02": c02, "C03": c03,
    "C04-hwp": lambda *args: c04(*args,"hwp"), "C04-hwpx": lambda *args: c04(*args,"hwpx"),
    "C05": c05, "C06": c06,
    "C07-hwp": lambda *args: c07(*args,"hwp"), "C07-hwpx": lambda *args: c07(*args,"hwpx"),
    "C08-hwp": lambda *args: c08(*args,"hwp"), "C08-hwpx": lambda *args: c08(*args,"hwpx"),
    "C09-hwp": lambda *args: c09(*args,"hwp"), "C09-hwpx": lambda *args: c09(*args,"hwpx"),
    "C10":c10, "C11":c11, "C12-hwp":lambda *args:c12(*args,"hwp"), "C12-hwpx":lambda *args:c12(*args,"hwpx"),
    "C13-hwp":lambda *args:c13(*args,"hwp"), "C13-hwpx":lambda *args:c13(*args,"hwpx"),
    "C12-hwpx-bar":lambda *args:c12(*args,"hwpx",alternative=True),
    "C12-hwp-blank":lambda *args:c12(*args,"hwp",alternative=True)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--cases", nargs="+", choices=CASES, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.fixtures = args.fixtures.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    app = args.app.resolve()
    p4.smoke.APP = str(app)
    engine_root = Path(os.environ.get("GEUL_RHWP_TEST_ARTIFACTS", ROOT / "public/rhwp"))
    release = json.loads((engine_root / "RELEASE.json").read_text())
    generation = engine_root / "generations" / release["generation"]
    require(all(digest(generation / name) == sha for name, sha in release["artifacts"].items()),
            "release artifact does not match its manifest")
    report = {"appSha256": digest(app), "os": platform.platform(), "rhwp": release["generation"], "cases": {}}
    for case in args.cases:
        row = report["cases"][case] = {}
        p4.smoke.DRIVER_LOG = str(args.out / (case + "-driver.log"))
        try:
            with tempfile.TemporaryDirectory(prefix="geul-stage3c-") as profile:
                with p4.smoke.tauri_driver(args.driver, 4469, profile) as start:
                    driver = start()
                    try:
                        acc = p4.P4Acceptance(args, driver, row)
                        acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                        acc.focus_window()
                        pid = int(acc.command(args.xdotool,"getwindowpid",acc.window))
                        row["appPid"] = pid
                        row["processAppSha256"] = digest(Path(f"/proc/{pid}/exe"))
                        require(row["processAppSha256"] == report["appSha256"],"unexpected live application binary")
                        acc.calibrate_pointer()
                        CASES[case](acc, row, args.fixtures, args.out)
                    except Exception:
                        row["failureAppState"] = acc.status("docx" if case in {"C03", "P4-DX-GROUP", "P4-DX-CURVE", "P4-DX-PATH", "P4-PATH-XFM-DOCX", "P5-DX-NOTE-MOVE", "P5-DX-NOTE-MOVE-FRESH-REOPEN", "P5-DX-HF-MOVE", "P5-DX-HF-MOVE-FRESH-REOPEN"} else "hwp" if case in {"P4-H5-GROUP", "P4-PATH-XFM-HWP5"} else "hwpx")
                        driver.screenshot(args.out / (case + "-error.png"))
                        raise
                    finally:
                        driver.quit()
            row["status"] = "PASS"
        except SaveBlocked:
            row.update(status="BLOCKED", error=traceback.format_exc())
        except Exception:
            row.update(status="FAIL", error=traceback.format_exc())
        row["driverCleanup"] = p4.smoke.TEARDOWN[-1] if p4.smoke.TEARDOWN else None
        (args.out / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(case, row["status"], row.get("error", ""), flush=True)
    return 0 if all(row["status"] == "PASS" for row in report["cases"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
