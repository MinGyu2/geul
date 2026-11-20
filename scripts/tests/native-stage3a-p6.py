#!/usr/bin/env python3
"""P6 Linux X11 acceptance for transfers, preset conversion and caption position."""

import importlib.util
from pathlib import Path
import shutil
import sys
from xml.etree import ElementTree as ET
import zipfile

entry = Path(__file__).with_name("native-stage3-c.py")
spec = importlib.util.spec_from_file_location("stage3c", entry)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
CAPTION = "[aria-labelledby=properties-selection] select:has(option[value='Top']):has(option[value='Bottom'])"


def hwpx_polygon(path):
    with zipfile.ZipFile(path) as package:
        return ET.fromstring(package.read("Contents/section0.xml")).find(".//{*}polygon")


def docx_root(path):
    with zipfile.ZipFile(path) as package:
        return ET.fromstring(package.read("word/document.xml"))


def color_point(acc, rgb, lower_edge=False):
    acc.wait("""
      return [...document.querySelectorAll('.docx-page')].some(
        p=>p.dataset.current==='true' && p.dataset.revision===
           document.querySelector('[data-testid=docx-status]').dataset.revision);
    """)
    return acc.d.js("""
      const [rgb, lowerEdge]=arguments;
      for(const c of document.querySelectorAll('.docx-page[data-current=true] canvas')){
        const img=c.getContext('2d').getImageData(0,0,c.width,c.height);
        let x=0,y=0,count=0,bottom=0;
        for(let i=0;i<img.data.length;i+=4) if(rgb.every((v,j)=>v===img.data[i+j])){
          const row=Math.floor(i/4/c.width);
          x+=(i/4)%c.width;y+=row;bottom=Math.max(bottom,row);count++;
        }
        if(count>100) return [+c.parentElement.dataset.page,x/count*c.clientWidth/c.width,
                             (lowerEdge?bottom:y/count)*c.clientHeight/c.height];
      }
      return null;
    """, list(bytes.fromhex(rgb)), lower_edge)


def copy_polygon(acc, row, fixtures, out):
    original = fixtures / "a-p6-polygon-source.hwpx"
    source = h.begin(acc, row, original, out, "a-p6-poly-source.hwpx")
    frame = h.core_shapes(source)["frames"][0]
    h.select_object(acc, frame, "shape")
    acc.key("ctrl+c")
    return source


def verify_other_parts(before, after, ignored):
    with zipfile.ZipFile(before) as a, zipfile.ZipFile(after) as b:
        left = {name:a.read(name) for name in a.namelist() if not ignored(name)}
        right = {name:b.read(name) for name in b.namelist() if not ignored(name)}
        h.require(left == right, "unrelated package entries changed")


def paste_polygon(acc, row, fixtures, out, fmt):
    source = copy_polygon(acc, row, fixtures, out)
    fixture = fixtures / ("a-p6-polygon-destination.hwpx" if fmt == "hwpx" else "a-p6-import-destination.docx")
    path = out / ("a-p6-copy-edited.hwpx" if fmt == "hwpx" else "a-p6-import-edited.docx")
    shutil.copyfile(fixture, path)
    acc.open_native(fmt, path)
    if fmt == "docx":
        body = docx_root(fixture).find(f"{W}body")
        para_index = len([block for block in body if block.tag != f"{W}sectPr"])-1
        # The existing blue shape is immediately above the empty final body paragraph.
        edge = color_point(acc, "156082", lower_edge=True)
        h.require(edge is not None, "destination marker shape was not painted")
        observed = row["destinationCaretAttempts"] = []
        for offset in (16, 24, 32, 40, 48, 56):
            h.p6.pointer(acc, (edge[0], 110, edge[2] + offset))
            acc.settle(fmt)
            observed.append(acc.status(fmt)["caret"])
            if observed[-1] == f"body:{para_index}:0":
                break
        h.require(observed[-1] == f"body:{para_index}:0", "could not select final empty body paragraph", observed)
    else:
        h.body_end(acc)
    initial = acc.status(fmt)
    row["destinationBeforePaste"] = initial
    acc.key("ctrl+v")
    h.revision(acc, fmt, 1)
    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    h.require(acc.status(fmt)["paragraphText"] == initial["paragraphText"], "Undo changed destination text")
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    h.publish(acc, fmt, row)
    h.require(h.digest(source) == row["fixtureSha256"], "source file changed")
    verify_other_parts(fixture, path, lambda name: name == ("Contents/section0.xml" if fmt == "hwpx" else "word/document.xml")
                       or (fmt == "hwpx" and name.startswith("Preview/")))
    original = hwpx_polygon(source)
    vertices = [(int(p.get("x")),int(p.get("y"))) for p in original.findall("{*}pt")]
    if fmt == "hwpx":
        saved = hwpx_polygon(path)
        h.require(saved is not None, "no polygon in destination")
        h.require(h.core_shapes(path)["body"] == h.core_shapes(fixture)["body"], "destination body content changed")
        before_shapes = h.core_shapes(fixture)["frames"]
        after_shapes = h.core_shapes(path)["frames"]
        h.require([shape["props"] for shape in after_shapes if shape["props"]["description"] != "Portable polygon"]
                  == [shape["props"] for shape in before_shapes], "sibling geometry or identity changed")
        h.require(original.get("id") != saved.get("id"), "destination did not get a fresh object ID")
        for attribute in ("id", "instid", "zOrder"):
            original.attrib.pop(attribute, None)
            saved.attrib.pop(attribute, None)
        h.require(ET.tostring(original) == ET.tostring(saved), "pasted path, style, or placement changed")
    else:
        body = docx_root(path)
        drawing = body.find(f".//{A}custGeom")
        h.require(drawing is not None, "target lost editable DrawingML geometry")
        segments = drawing.find(f"{A}pathLst/{A}path")
        tags = [c.tag.rsplit("}",1)[-1] for c in segments]
        h.require(tags == ["moveTo","lnTo","lnTo","close"], "wrong stored segment commands", tags)
        stored = [(int(p.get("x")),int(p.get("y"))) for p in segments.findall(f".//{A}pt")]
        h.require(stored == [(x*127,y*127) for x,y in vertices[:-1]], "wrong HWPUNIT to EMU conversion", stored)
        all_drawings = body.findall(f".//{W}drawing")
        target = all_drawings[-1]
        h.require(target.find(f".//{WP}docPr").get("descr") == "Portable polygon", "description lost in conversion")
        h.require(target.find(f".//{A}solidFill/{A}srgbClr").get("val").upper() == "442277", "fill lost in conversion")
        target_paragraph = body.findall(f".//{W}p")[-1]
        drawing_run = target_paragraph.find(f"{W}r[{W}drawing]")
        target_paragraph.remove(drawing_run)
        h.require(ET.tostring(body) == ET.tostring(docx_root(fixture)), "destination body or sibling drawing changed")
    h.reopen(acc, path, row)
    if fmt == "hwpx":
        frame = next(f for f in h.core_shapes(path)["frames"] if f["props"]["description"] == "Portable polygon")
        h.select_object(acc, frame, "shape")
        h.require(acc.d.exists(".object-path-mode"), "pasted polygon is not point-editable")
    else:
        point = color_point(acc, "442277")
        h.require(point is not None, "converted drawing not painted")
        h.p6.pointer(acc, point)
        acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='shape'", h.FRAME)
        h.require(acc.d.exists("[data-testid='object-handle-se']"), "converted drawing is not editable")


def preset(acc, row, fixtures, out):
    fixture = fixtures / "a-p6-rect-original.docx"
    path = h.begin(acc, row, fixture, out, "a-p6-ellipse-edited.docx")
    selector = "[aria-labelledby=properties-selection] .object-tools button:enabled"

    def pick_shape(label):
        point = color_point(acc, "156082")
        h.require(point is not None, "no painted preset shape")
        h.p6.pointer(acc, point)
        acc.wait("return [...document.querySelectorAll(arguments[0])].some(b=>b.textContent.trim()===arguments[1])", selector,label)

    ellipse, rect = "타원으로 변경","사각형으로 변경"
    pick_shape(ellipse)
    start = h.frame(acc)
    point = acc.d.js("""
      const b=[...document.querySelectorAll(arguments[0])].find(b=>b.textContent.trim()===arguments[1]);
      b.scrollIntoView({block:'nearest'});
      const r=b.getBoundingClientRect();
      return [r.left+r.width/2,r.top+r.height/2];
    """, selector, ellipse)
    h.p4.rhwp_poc.click(acc.d, *point)
    h.revision(acc, "docx", 1)
    h.require(h.frame(acc) == start, "conversion moved or resized the frame")
    acc.key("ctrl+z")
    h.revision(acc, "docx", 2)
    pick_shape(ellipse)
    acc.key("ctrl+y")
    h.revision(acc, "docx", 3)
    pick_shape(rect)
    h.publish(acc, "docx", row)
    verify_other_parts(fixture,path,lambda name: name=="word/document.xml")
    old,new=docx_root(fixture),docx_root(path)
    old.find(f".//{A}prstGeom").set("prst","ellipse")
    h.require(ET.tostring(old)==ET.tostring(new), "more than the shape preset changed")
    h.reopen(acc,path,row)
    pick_shape(rect)


def caption(acc, row, fixtures, out):
    fixture = fixtures / "a-p6-caption-original.hwpx"
    after_fixture = fixtures / "a-p6-caption-edited.hwpx"
    before = row["before"] = h.p6.hwp(fixture)
    expected = h.p6.hwp(after_fixture)
    path = h.begin(acc,row,fixture,out,"a-p6-caption-edited.hwpx")

    def pick(layout, side):
        h.select_object(acc, layout["images"][0], "picture")
        acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", CAPTION,side)

    pick(before,"Bottom")
    acc.d.click(CAPTION + " option[value='Top']")
    h.revision(acc,"hwpx",1)
    acc.key("ctrl+z")
    h.revision(acc,"hwpx",2)
    pick(before,"Bottom")
    acc.key("ctrl+y")
    h.revision(acc,"hwpx",3)
    pick(expected,"Top")
    h.publish(acc,"hwpx",row)
    after = row["after"] = h.p6.hwp(path)
    h.require(after["caption"]["text"] == before["caption"]["text"] and after["body"] == before["body"], "caption or body text changed")
    h.require(after["caption"]["caret"]["y"] < after["images"][0]["y"], "caption not rendered above picture")
    row["resources"] = h.checked_resources(fixture,path)
    verify_other_parts(fixture,path,lambda name: name=="Contents/section0.xml" or name.startswith("Preview/"))
    with zipfile.ZipFile(fixture) as a, zipfile.ZipFile(path) as b:
        old,new=[ET.fromstring(p.read("Contents/section0.xml")) for p in (a,b)]
    owner=old.find(".//{*}pic/{*}caption")
    h.require(owner is not None and owner.get("side")=="BOTTOM","wrong caption owner or side")
    owner.set("side","TOP")
    h.require(ET.tostring(old)==ET.tostring(new), "caption editing changed number, format, or unrelated XML")
    h.reopen(acc,path,row)
    pick(after,"Top")


h.CASES = {
    "P6.1": lambda *args: paste_polygon(*args, "hwpx"),
    "P6.2-type": preset,
    "P6.2-format": lambda *args: paste_polygon(*args, "docx"),
    "P6.3": caption,
}

if __name__ == "__main__":
    sys.exit(h.main())
