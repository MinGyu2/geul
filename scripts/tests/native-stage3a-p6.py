#!/usr/bin/env python3
"""P6 Linux X11 acceptance for transfers, preset conversion and caption position."""

import hashlib
import importlib.util
import json
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


def docx_canvas_digest(acc):
    data = acc.d.js("return [...document.querySelectorAll('.docx-page canvas')].map(c=>c.toDataURL('image/png'))")
    return hashlib.sha256(json.dumps(data, separators=(",", ":")).encode()).hexdigest()


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
    initial_canvas = docx_canvas_digest(acc) if fmt == "docx" else None
    acc.key("ctrl+v")
    pasted = h.revision(acc, fmt, 1)
    if fmt == "docx":
        pasted_canvas = docx_canvas_digest(acc)
        h.require(pasted_canvas != initial_canvas, "DOCX polygon paste did not change the rendered page")
        row["renderedCanvas"] = {"before": initial_canvas, "pasted": pasted_canvas}
        row["pasteStatus"] = pasted
    acc.key("ctrl+z")
    undone = h.revision(acc, fmt, 2)
    if fmt == "docx":
        undo_canvas = docx_canvas_digest(acc)
        h.require(undo_canvas == initial_canvas, "DOCX Undo did not restore destination rendering")
        h.require(all(undone.get(key) == initial.get(key)
                      for key in ("caret", "selection", "rejected")),
                  "DOCX Undo did not restore destination caret/selection", {"before": initial, "after": undone})
        # WordCraft revisions are monotonic: Undo restores document content/rendering but remains dirty
        # until the edited session is saved, even when the content equals the original bytes.
        h.require(undone.get("dirty") == "true" and undone.get("unpreserved") == "true",
                  "DOCX Undo did not retain its unsaved revision", undone)
        row["undoUnsavedRevision"] = {"revision": undone["revision"], "dirty": undone["dirty"],
                                      "unpreserved": undone["unpreserved"]}
        row["renderedCanvas"]["undo"] = undo_canvas
    else:
        h.require(undone["paragraphText"] == initial["paragraphText"], "Undo changed destination text")
    acc.key("ctrl+y")
    redone = h.revision(acc, fmt, 3)
    if fmt == "docx":
        redo_canvas = docx_canvas_digest(acc)
        h.require(redo_canvas == pasted_canvas, "DOCX Redo did not restore the pasted polygon")
        row["renderedCanvas"]["redo"] = redo_canvas
        row["editingStateAfterRedo"] = redone
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


def preset(acc, row, fixtures, out, rounded=False):
    fixture = fixtures / ("a-p6-floating-round-rect-original.docx" if rounded else "a-p6-rect-original.docx")
    output = "a-p6-floating-round-rect-published.docx" if rounded else "a-p6-ellipse-edited.docx"
    path = h.begin(acc, row, fixture, out, output)
    selector = "[aria-labelledby=properties-selection] .object-tools button:enabled"

    def pick_shape(label):
        point = color_point(acc, "156082")
        h.require(point is not None, "no painted preset shape")
        h.p6.pointer(acc, point)
        acc.wait("return [...document.querySelectorAll(arguments[0])].some(b=>b.textContent.trim()===arguments[1])", selector,label)

    ellipse, rect = "타원으로 변경","사각형으로 변경"
    before_label, after_label = (rect, ellipse) if rounded else (ellipse, rect)
    pick_shape(before_label)
    start = h.frame(acc)
    row["sourceFrame"] = start
    acc.d.js("""
      const label=arguments[0];
      window.presetClicks=[];
      addEventListener('click', e => {
        if (e.target.closest('button')?.textContent.trim() === label) presetClicks.push(e.isTrusted);
      }, true);
    """, before_label)
    point = acc.d.js("""
      const b=[...document.querySelectorAll(arguments[0])].find(b=>b.textContent.trim()===arguments[1]);
      b.scrollIntoView({block:'nearest'});
      const r=b.getBoundingClientRect();
      return [r.left+r.width/2,r.top+r.height/2];
    """, selector, before_label)
    h.p4.rhwp_poc.click(acc.d, *point)
    h.revision(acc, "docx", 1)
    row["trustedClicks"] = acc.d.js("return window.presetClicks")
    h.require(row["trustedClicks"] == [True], "missing trusted preset click", row["trustedClicks"])
    h.require(h.frame(acc) == start, "conversion moved or resized the frame")
    acc.key("ctrl+z")
    h.revision(acc, "docx", 2)
    pick_shape(before_label)
    acc.key("ctrl+y")
    h.revision(acc, "docx", 3)
    pick_shape(after_label)
    h.publish(acc, "docx", row)
    verify_other_parts(fixture,path,lambda name: name=="word/document.xml")
    old,new=docx_root(fixture),docx_root(path)
    geometry = old.find(f".//{A}prstGeom")
    h.require(geometry.get("prst") == ("roundRect" if rounded else "rect"), "unexpected source preset")
    if rounded:
        anchor = old.find(f".//{WP}anchor")
        adjustment = geometry.find(f"{A}avLst/{A}gd")
        glow = old.find(f".//{A}effectLst/{A}glow")
        h.require(anchor is not None, "floating anchor changed to inline placement")
        h.require(adjustment is not None and adjustment.get("name") == "adj" and adjustment.get("fmla") == "val 25000", "custom adjustment changed")
        h.require(glow is not None and glow.get("rad") == "25400", "supported glow effect changed")
    geometry.set("prst","rect" if rounded else "ellipse")
    h.require(ET.tostring(old)==ET.tostring(new), "more than the shape preset changed")
    h.reopen(acc,path,row)
    pick_shape(after_label)
    row["sameProcessReopenFrame"] = h.frame(acc)


def preset_fresh_reopen(acc, row, fixtures, out):
    fixture = fixtures / "a-p6-floating-round-rect-published.docx"
    primary_report = json.loads((fixtures / "result.json").read_text())
    primary = primary_report.get("cases", {}).get("P6-DX-TYPE")
    h.require(primary is not None and primary.get("status") == "PASS",
              "primary floating preset acceptance did not pass")

    root = docx_root(fixture)
    geometry = root.find(f".//{A}prstGeom")
    anchor = root.find(f".//{WP}anchor")
    adjustment = geometry.find(f"{A}avLst/{A}gd") if geometry is not None else None
    glow = root.find(f".//{A}effectLst/{A}glow")
    h.require(geometry is not None and geometry.get("prst") == "rect",
              "published preset is not an editable rectangle")
    h.require(anchor is not None, "published shape lost floating anchor")
    h.require(adjustment is not None and adjustment.get("name") == "adj"
              and adjustment.get("fmla") == "val 25000", "published shape lost its custom adjustment")
    h.require(glow is not None and glow.get("rad") == "25400", "published shape lost its supported glow")
    docpr = root.find(f".//{WP}docPr")
    extent = anchor.find(f"{WP}extent")
    h.require(docpr is not None and extent is not None, "published drawing identity or extent is missing")
    row["savedDrawing"] = {
        "docPrId": docpr.get("id"), "name": docpr.get("name"), "description": docpr.get("descr"),
        "anchor": dict(anchor.attrib), "extentEmu": [extent.get("cx"), extent.get("cy")],
        "preset": geometry.get("prst"), "adjustment": dict(adjustment.attrib), "glow": dict(glow.attrib),
    }

    path = h.begin(acc, row, fixture, out, "a-p6-floating-round-rect-fresh.docx")
    row["freshAppPid"] = row["appPid"]
    h.require(row["freshAppPid"] != primary.get("appPid"),
              "fresh reopen reused the primary application process",
              [primary.get("appPid"), row["freshAppPid"]])
    point = color_point(acc, "156082")
    h.require(point is not None, "published rectangle was not rendered in the fresh application")
    h.p6.pointer(acc, point)
    selector = "[aria-labelledby=properties-selection] .object-tools button:enabled"
    acc.wait("return [...document.querySelectorAll(arguments[0])].some(b=>b.textContent.trim()===arguments[1])",
             selector, "타원으로 변경")
    fresh_frame = row["freshProcessFrame"] = h.frame(acc)
    expected_frame = primary.get("sameProcessReopenFrame")
    h.require(expected_frame is not None, "primary same-process reopen frame is absent")
    for field in ("left", "top", "width", "height"):
        h.require(abs(fresh_frame[field] - expected_frame[field]) <= 1.5,
                  "fresh-process rendered placement differs from saved same-process placement",
                  [field, expected_frame[field], fresh_frame[field]])
    row["freshProcessAction"] = "타원으로 변경"
    row["freshProcessDirty"] = acc.status("docx")["dirty"]
    h.require(row["freshProcessDirty"] == "false", "fresh reopen changed the saved document")
    row["freshCopySha256"] = h.digest(path)
    h.require(row["freshCopySha256"] == row["fixtureSha256"], "fresh reopen changed saved package bytes")


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


def caption_spacing(acc, row, fixtures, out):
    fixture = fixtures / "a-p6-caption-spacing-original.hwpx"
    before = row["before"] = h.p6.hwp(fixture)
    path = h.begin(acc,row,fixture,out,"a-p6-caption-spacing-published.hwpx")
    field = ".caption-spacing input"

    def pick(layout, points):
        h.select_object(acc, layout["images"][0], "picture")
        acc.wait("return +document.querySelector(arguments[0])?.value===arguments[1]", field, points)

    pick(before, 0)
    h.p6.gso.replace(acc, field, "4.25")
    acc.dom_click(".caption-spacing button")
    h.revision(acc,"hwpx",1)
    acc.key("ctrl+z")
    h.revision(acc,"hwpx",2)
    pick(before,0)
    acc.key("ctrl+y")
    h.revision(acc,"hwpx",3)
    pick(before,4.25)
    h.publish(acc,"hwpx",row)

    after = row["after"] = h.p6.hwp(path)
    h.require(after["caption"]["text"] == before["caption"]["text"] and after["body"] == before["body"], "caption or body text changed")
    h.require(after["caption"]["caret"]["y"] > before["caption"]["caret"]["y"],
              "the positive gap did not move the bottom caption")
    row["resources"] = h.checked_resources(fixture,path)
    verify_other_parts(fixture,path,lambda name: name=="Contents/section0.xml" or name.startswith("Preview/"))
    with zipfile.ZipFile(fixture) as a, zipfile.ZipFile(path) as b:
        old,new=[ET.fromstring(p.read("Contents/section0.xml")) for p in (a,b)]
    original = old.find(".//{*}pic/{*}caption")
    h.require(original is not None and original.get("gap")=="0", "wrong caption owner or initial gap")
    original.set("gap","425")
    h.require(ET.tostring(old)==ET.tostring(new), "caption gap edit changed atno, formatting or other XML")
    h.reopen(acc,path,row)
    pick(after,4.25)

def caption_lateral(acc, row, fixtures, out, side, align):
    name = f"a-p6-caption-{side.lower()}"
    fixture = fixtures / f"{name}-original.hwpx"
    old_layout = row["before"] = h.p6.hwp(fixture)
    new_layout = h.p6.hwp(fixtures / f"{name}-edited.hwpx")
    path = h.begin(acc, row, fixture, out, f"{name}-published.hwpx")
    alignment = "[data-testid=caption-vertical-align]"

    def pick(layout, position, vertical=None):
        h.select_object(acc, layout["images"][0], "picture")
        acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", CAPTION, position)
        if vertical:
            acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", alignment, vertical)
        else:
            h.require(not acc.d.exists(alignment), "upper and lower captions do not have a vertical alignment control")

    pick(old_layout, "Bottom")
    acc.d.click(f"{CAPTION} option[value='{side}']")
    h.revision(acc, "hwpx", 1)
    pick(new_layout, side, "Top")
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    pick(old_layout, "Bottom")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    pick(new_layout, side, "Top")
    acc.d.click(f"{alignment} option[value='{align}']")
    h.revision(acc, "hwpx", 4)
    pick(new_layout, side, align)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 5)
    pick(new_layout, side, "Top")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 6)
    pick(new_layout, side, align)
    h.publish(acc, "hwpx", row)

    after = row["after"] = h.p6.hwp(path)
    h.require(after == new_layout, "published picture and caption differ from the independent expected layout")
    h.require(after["caption"]["text"] == old_layout["caption"]["text"] and after["body"] == old_layout["body"],
              "caption or body text changed")
    pic, caret = after["images"][0], after["caption"]["caret"]
    h.require(caret["x"] < pic["x"] if side == "Left" else caret["x"] > pic["x"] + pic["w"],
              "caption did not render beside the picture")
    h.require(pic["y"] < caret["y"] < pic["y"] + pic["h"], "caption did not render at the edited vertical alignment")
    row["resources"] = h.checked_resources(fixture, path)
    verify_other_parts(fixture, path, lambda part: part == "Contents/section0.xml" or part.startswith("Preview/"))
    with zipfile.ZipFile(fixture) as a, zipfile.ZipFile(path) as b:
        old, new = [ET.fromstring(p.read("Contents/section0.xml")) for p in (a, b)]
    caption = old.find(".//{*}pic/{*}caption")
    h.require(caption is not None and caption.get("side") == "BOTTOM", "unexpected source caption")
    sub_list = caption.find("{*}subList")
    h.require(sub_list is not None and sub_list.get("vertAlign") == "TOP", "unexpected source alignment")
    caption.set("side", side.upper())
    sub_list.set("vertAlign", align.upper())
    h.require(ET.tostring(old) == ET.tostring(new), "unrelated section XML, including numbering or runs, changed")
    h.reopen(acc, path, row)
    pick(after, side, align)


h.CASES = {
    "P6.1": lambda *args: paste_polygon(*args, "hwpx"),
    "P6.2-type": preset,
    "P6-DX-TYPE": lambda *args: preset(*args, rounded=True),
    "P6-DX-TYPE-FRESH": preset_fresh_reopen,
    "P6.2-format": lambda *args: paste_polygon(*args, "docx"),
    "P6.3": caption,
    "P6.7": caption_spacing,
    "P6-HX-CAP-LEFT": lambda *args: caption_lateral(*args, "Left", "Center"),
    "P6-HX-CAP-RIGHT": lambda *args: caption_lateral(*args, "Right", "Bottom"),
}

if __name__ == "__main__":
    sys.exit(h.main())
