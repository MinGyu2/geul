#!/usr/bin/env python3
"""P4 Linux X11 editor acceptance using published files and independent inspection."""

from copy import deepcopy
import importlib.util
import hashlib
import math
import re
from pathlib import Path
import shutil
import struct
import sys
from xml.etree import ElementTree as ET
import zipfile

entry = Path(__file__).with_name("native-stage3-c.py")
spec = importlib.util.spec_from_file_location("stage3c", entry)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
ROOT = h.ROOT
record_spec = importlib.util.spec_from_file_location("hwp_record_diff", Path(__file__).with_name("hwp_record_diff.py"))
hwp_records = importlib.util.module_from_spec(record_spec)
record_spec.loader.exec_module(hwp_records)

POINT = ".object-path-point"
COORDS = ".object-path-coordinates"
GROUP = "[aria-labelledby=properties-selection] .object-tools details"


def inspect(path):
    return h.inspect_rhwp(path, """
      const frames = pages.flatMap((page,i) => page.filter(c => ['shape','group'].includes(c.type)
        && c.stableIndex.length === 3).map(c => {
          const at=[c.secIdx,c.paraIdx,c.controlIdx];
          return {...c,page:i,props:JSON.parse(doc.getShapeProperties(...at)),
            path:JSON.parse(doc.getEditableShapePath(...at)),
            children:JSON.parse(doc.getEditableGroupFills(...at)),
            groupChildren:JSON.parse(doc.getEditableGroupChildren(...at))};
        }));
      console.log(JSON.stringify({frames,body,controls}));
    """)


def inspect_docx_curve(path):
    ns = {
        "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    }
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("word/document.xml"))
        rels = package.read("word/_rels/document.xml.rels")
        parts = {name: package.read(name) for name in package.namelist() if name != "word/document.xml"}
    shapes = root.findall(".//wps:wsp", ns)
    h.require(len(shapes) == 1, "fixture must contain one DrawingML shape", len(shapes))
    geometry = shapes[0].find("./wps:spPr/a:custGeom", ns)
    h.require(geometry is not None, "fixture lost custom geometry")
    path_list = geometry.find("a:pathLst", ns)
    paths = []
    for path_node in path_list:
        commands = []
        for command in path_node:
            commands.append({
                "type": command.tag.rsplit("}", 1)[-1],
                "points": [dict(point.attrib) for point in command.findall("a:pt", ns)],
            })
        paths.append({"attrs": dict(path_node.attrib), "commands": commands})
    transform = shapes[0].find("./wps:spPr/a:xfrm", ns)
    transform_offset = transform.find("a:off", ns) if transform is not None else None
    transform_extent = transform.find("a:ext", ns) if transform is not None else None
    anchor = root.find(".//wp:anchor", ns)
    anchor_offsets = {}
    if anchor is not None:
        for axis, element in (("horizontal", "positionH"), ("vertical", "positionV")):
            position = anchor.find(f"wp:{element}", ns)
            offset = position.find("wp:posOffset", ns) if position is not None else None
            if position is not None and offset is not None:
                anchor_offsets[axis] = {
                    "relativeFrom": position.get("relativeFrom"),
                    "value": offset.text,
                }
    return {
        "xml": root,
        "geometry": geometry,
        "paths": paths,
        "transform": dict(transform.attrib) if transform is not None else {},
        "transformFrame": {
            "offset": dict(transform_offset.attrib) if transform_offset is not None else {},
            "extent": dict(transform_extent.attrib) if transform_extent is not None else {},
        },
        "anchorOffsets": anchor_offsets,
        "relationshipsSha256": hashlib.sha256(rels).hexdigest(),
        "relationships": rels,
        "parts": parts,
    }


def inspect_docx_group(path):
    ns = {
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
        "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    }
    emu_per_point = 12_700
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("word/document.xml"))
        relationships = package.read("word/_rels/document.xml.rels")
        parts = {name: package.read(name) for name in package.namelist() if name != "word/document.xml"}

    def xfrm(node):
        tag = node.tag.rsplit("}", 1)[-1]
        if tag in ("wgp", "grpSp"):
            return node.find("./wpg:grpSpPr/a:xfrm", ns)
        if tag == "wsp":
            return node.find("./wps:spPr/a:xfrm", ns)
        if tag == "pic":
            return node.find("./pic:spPr/a:xfrm", ns)
        return None

    def group_children(group):
        transform = xfrm(group)
        origin = transform.find("a:chOff", ns) if transform is not None else None
        origin_x = int(origin.get("x", "0")) if origin is not None else 0
        origin_y = int(origin.get("y", "0")) if origin is not None else 0
        children = []
        for child in list(group):
            kind = child.tag.rsplit("}", 1)[-1]
            if kind not in ("wsp", "pic", "grpSp"):
                continue
            frame = xfrm(child)
            if frame is None:
                raise AssertionError(f"group child has no DrawingML transform: {kind}")
            offset = frame.find("a:off", ns)
            extent = frame.find("a:ext", ns)
            if offset is None or extent is None:
                raise AssertionError(f"group child has incomplete DrawingML transform: {kind}")
            ox, oy = int(offset.get("x", "0")), int(offset.get("y", "0"))
            width, height = int(extent.get("cx", "0")), int(extent.get("cy", "0"))
            child_kind = {"wsp": "shape", "pic": "picture", "grpSp": "group"}[kind]
            item = {
                "kind": child_kind,
                "x": (ox - origin_x) / emu_per_point,
                "y": (oy - origin_y) / emu_per_point,
                "width": width / emu_per_point,
                "height": height / emu_per_point,
            }
            if child_kind == "group":
                item["children"] = group_children(child)
            elif child_kind == "shape":
                geometry = child.find("./wps:spPr/a:prstGeom", ns)
                item["preset"] = geometry.get("prst") if geometry is not None else None
                color = child.find("./wps:spPr/a:solidFill/a:srgbClr", ns)
                item["fill"] = color.get("val") if color is not None else None
            elif child_kind == "picture":
                blip = child.find("./pic:blipFill/a:blip", ns)
                item["relationship"] = blip.get(f"{{{ns['r']}}}embed") if blip is not None else None
            children.append(item)
        return children

    groups = root.findall(".//wpg:wgp", ns)
    if len(groups) != 1:
        raise AssertionError(f"expected one outer DrawingML group, found {len(groups)}")
    tree = group_children(groups[0])
    return {
        "xml": root,
        "group": groups[0],
        "tree": tree,
        "relationships": relationships,
        "parts": parts,
    }


def docx_group_click(acc, selector):
    h.require(acc.d.exists(selector), "DOCX group control is missing", selector)
    x, y = acc.d.js("""
      const e=document.querySelector(arguments[0]);
      if(!e) return [null,null];
      const r=e.getBoundingClientRect();
      return [r.left+r.width/2,r.top+r.height/2];
    """, selector)
    h.require(x is not None and y is not None, "DOCX group control has no visible hit target", selector)
    h.p4.rhwp_poc.click(acc.d, x, y)


def docx_group_select(acc):
    if not acc.d.exists(".object-group-child-mode"):
        for y in (0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65):
            for x in (0.17, 0.22, 0.27, 0.32, 0.37, 0.42, 0.47):
                docx_curve_click(acc, x, y)
                if acc.d.exists(".object-group-child-mode"):
                    break
            if acc.d.exists(".object-group-child-mode"):
                break
    h.require(acc.d.exists(".object-group-child-mode"), "native pointer could not select the DrawingML group")
    if acc.d.js("return document.querySelector('.object-group-child-mode')?.getAttribute('aria-pressed')!=='true'"):
        acc.dom_click(".object-group-child-mode")
    h.require(acc.d.js("return document.querySelector('.object-group-child-mode')?.getAttribute('aria-pressed')==='true'"),
              "native direct-child edit mode did not activate")
    h.require(acc.d.js("return document.querySelectorAll('.object-group-child').length") == 2,
              "expected both owned direct group children")


def docx_group_values(acc):
    return acc.d.js("""
      return [...document.querySelectorAll('.object-group-child-coordinates input')]
        .map(input=>Number(input.value));
    """)


def docx_group_set_values(acc, values):
    selectors = (
        ".object-group-child-coordinates label:nth-of-type(1) input",
        ".object-group-child-coordinates label:nth-of-type(2) input",
        ".object-group-child-coordinates label:nth-of-type(3) input",
        ".object-group-child-coordinates label:nth-of-type(4) input",
    )
    for selector, value in zip(selectors, values, strict=True):
        acc.dom_click(selector)
        acc.key("ctrl+a")
        acc.type(str(value))
        acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", selector, str(value))


def docx_group_case(acc, row, fixtures, out):
    fixture = ROOT / "scripts/tests/fixtures/stage3a-p4-dx-group.docx"
    h.require(fixture.is_file(), "tracked nested-group native fixture is missing", str(fixture))
    before = inspect_docx_group(fixture)
    expected_children = before["tree"]
    h.require([child["kind"] for child in expected_children] == ["group", "shape"],
              "fixture must retain a nested group before editing", expected_children)
    nested_before = expected_children[0]
    h.require((nested_before["x"], nested_before["y"], nested_before["width"], nested_before["height"]) == (10.0, 10.0, 80.0, 60.0),
              "nested group local transform changed", nested_before)
    h.require([child["kind"] for child in nested_before["children"]] == ["shape", "picture"],
              "nested group must retain both its shape and owned picture", nested_before)
    h.require(expected_children[0]["children"][1]["relationship"], "nested picture relationship is missing")
    path = h.begin(acc, row, fixture, out, "p4-dx-group-edited.docx")

    acc.d.js("""
      window.docxGroupPointers=[];
      window.docxGroupKeys=[];
      for(const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
        const child=e.target.closest('.object-group-child');
        if(child) docxGroupPointers.push({type,index:Number(child.dataset.index),trusted:e.isTrusted});
      },true);
      addEventListener('keydown',e=>{
        if(e.target.closest('.object-group-child-coordinates')) docxGroupKeys.push({key:e.key,trusted:e.isTrusted});
      },true);
    """)

    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    initial = docx_group_values(acc)
    h.require(initial == [10, 10, 80, 60], "selected direct nested-group frame differs from source", initial)
    docx_group_set_values(acc, [20, 15, 80, 60])
    docx_group_click(acc, ".object-group-child-apply-move")
    row["move"] = h.revision(acc, "docx", 1)
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    moved = docx_group_values(acc)
    h.require(moved == [20, 15, 80, 60], "direct group-child movement did not update local coordinates", moved)

    acc.key("ctrl+z")
    row["undoMove"] = h.revision(acc, "docx", 2)
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    h.require(docx_group_values(acc) == initial, "Undo did not restore the nested group frame")
    acc.key("ctrl+y")
    row["redoMove"] = h.revision(acc, "docx", 3)
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    h.require(docx_group_values(acc) == moved, "Redo did not restore the nested group frame")

    docx_group_set_values(acc, [20, 15, 70, 50])
    docx_group_click(acc, ".object-group-child-apply-resize")
    row["resize"] = h.revision(acc, "docx", 4)
    resized = [20, 15, 70, 50]
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    h.require(docx_group_values(acc) == resized, "direct group-child resize did not update local geometry")
    acc.key("ctrl+z")
    row["undoResize"] = h.revision(acc, "docx", 5)
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    h.require(docx_group_values(acc) == moved, "Undo did not restore the moved nested group")
    acc.key("ctrl+y")
    row["redoResize"] = h.revision(acc, "docx", 6)
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    h.require(docx_group_values(acc) == resized, "Redo did not restore the resized nested group")

    pointers = acc.d.js("return window.docxGroupPointers")
    h.require(any(e == {"type": "pointerdown", "index": 0, "trusted": True} for e in pointers)
              and any(e == {"type": "pointerup", "index": 0, "trusted": True} for e in pointers),
              "direct group child was not selected with trusted native X11 pointer input", pointers)
    keys = acc.d.js("return window.docxGroupKeys")
    h.require(keys and all(event["trusted"] for event in keys),
              "group-child coordinates did not use trusted native keyboard input", keys)

    h.publish(acc, "docx", row)
    after = inspect_docx_group(path)
    expected_tree = deepcopy(before["tree"])
    expected_tree[0].update(x=20.0, y=15.0, width=70.0, height=50.0)
    h.require(after["tree"] == expected_tree,
              "saved group tree changed nested members, sibling order, or local geometry", after["tree"])
    h.require(before["relationships"] == after["relationships"], "DOCX group edit changed OPC relationships")
    h.require(before["parts"] == after["parts"], "DOCX group edit changed package parts outside document.xml")
    row["savedGroupTree"] = after["tree"]
    row["unchangedPackageParts"] = len(before["parts"])

    expected_xml = deepcopy(before["xml"])
    ns = {
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
        "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    }
    expected_group = expected_xml.find(".//wpg:wgp", ns)
    expected_nested = expected_group.find("./wpg:grpSp", ns)
    expected_xfrm = expected_nested.find("./wpg:grpSpPr/a:xfrm", ns)
    expected_offset = expected_xfrm.find("a:off", ns)
    expected_extent = expected_xfrm.find("a:ext", ns)
    expected_offset.set("x", str(int(expected_offset.get("x")) + 127_000))
    expected_offset.set("y", str(int(expected_offset.get("y")) + 63_500))
    expected_extent.set("cx", str(70 * 12_700))
    expected_extent.set("cy", str(50 * 12_700))
    h.require(ET.tostring(expected_xml) == ET.tostring(after["xml"]),
              "saved document.xml differs beyond the selected nested-group frame")
    h.reopen(acc, path, row)
    docx_group_select(acc)
    docx_group_click(acc, '.object-group-child[data-index="0"]')
    h.require(docx_group_values(acc) == resized, "saved nested group did not reopen with edited bounds")
    reopened_tree = inspect_docx_group(path)["tree"]
    h.require(reopened_tree == expected_tree, "independent reopened package lost nested group hierarchy or picture relationship")
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("word/document.xml"))
    shapes = root.findall(".//wps:wsp", ns)
    h.require(len(shapes) == 2, "fixture must retain its nested and sibling DrawingML shapes", len(shapes))
    serialized_shapes = []
    for shape in shapes:
        geometry = shape.find("./wps:spPr/a:prstGeom", ns)
        fill = shape.find("./wps:spPr/a:solidFill/a:srgbClr", ns)
        serialized_shapes.append({
            "preset": geometry.get("prst") if geometry is not None else None,
            "fill": fill.get("val") if fill is not None else None,
        })
    h.require(serialized_shapes == [{"preset": "rect", "fill": "336699"},
                                    {"preset": "ellipse", "fill": "CC8844"}],
              "saved group child and sibling preset/fill changed", serialized_shapes)
    row["serializedShapes"] = serialized_shapes


def docx_curve_click(acc, x_fraction, y_fraction):
    x, y = acc.d.js("""
      const c=document.querySelector('.docx-page canvas'), s=document.querySelector('.editor__scroll');
      const v=s.getBoundingClientRect(), r=c.getBoundingClientRect();
      s.scrollTop += r.top+r.height*arguments[1]-(v.top+v.height*.45);
      const n=c.getBoundingClientRect();
      return [n.left+n.width*arguments[0],n.top+n.height*arguments[1]];
    """, x_fraction, y_fraction)
    h.p4.rhwp_poc.click(acc.d, x, y)


def docx_curve_select_shape(acc):
    # The fixture's inline shape starts at the first body margin and is 100 pt wide.
    # Scan a small interior grid with real native pointer clicks to avoid selecting text.
    for y in (0.145, 0.155, 0.165, 0.175):
        for x in (0.17, 0.20, 0.23, 0.26):
            docx_curve_click(acc, x, y)
            if acc.d.exists(".object-path-mode"):
                return
    h.require(False, "native pointer could not select the DrawingML shape")


def docx_curve_enter_path_mode(acc):
    docx_curve_select_shape(acc)
    if not acc.d.js("return document.querySelector('.object-path-mode')?.getAttribute('aria-pressed')==='true'"):
        acc.dom_click(".object-path-mode")
    h.require(acc.d.js("return document.querySelector('.object-path-mode')?.getAttribute('aria-pressed')==='true'"),
              "native path edit mode did not activate")


def docx_curve_handle(acc, testid):
    selector = f'[data-testid="{testid}"]'
    h.require(acc.d.exists(selector), "DrawingML control handle missing", testid)
    acc.dom_click(selector)
    return acc.d.js("""
      const e=document.querySelector('[data-testid="docx-path-coordinates"]');
      if (!e) return null;
      return [...e.querySelectorAll('input')].map(input=>Number(input.value));
    """)


def docx_curve_set_coordinates(acc, target):
    for selector, value in zip((
        ".object-path-coordinates label:nth-of-type(1) input",
        ".object-path-coordinates label:nth-of-type(2) input",
    ), target, strict=True):
        acc.dom_click(selector)
        acc.key("ctrl+a")
        acc.type(str(value))
        acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", selector, str(value))
    acc.dom_click(".object-path-coordinates button[type=submit]")


def docx_curve_case(acc, row, fixtures, out):
    fixture = fixtures / "bezier.docx"
    before = inspect_docx_curve(fixture)
    h.require([item["commands"][1]["type"] for item in before["paths"]] == ["quadBezTo", "cubicBezTo"],
              "native fixture must retain quadratic and cubic commands", before["paths"])
    path = h.begin(acc, row, fixture, out, "p4-dx-curve-edited.docx")
    docx_curve_enter_path_mode(acc)
    h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == 7,
              "expected move, quadratic, and cubic control handles")
    acc.d.js("""
      window.docxCurvePointers=[];
      window.docxCurveKeys=[];
      for (const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
        if (e.target.matches('.object-path-point'))
          docxCurvePointers.push({type,testid:e.target.dataset.testid,trusted:e.isTrusted});
      },true);
      addEventListener('keydown',e=>{
        if (e.target.closest('.object-path-coordinates')) docxCurveKeys.push({key:e.key,trusted:e.isTrusted});
      },true);
    """)

    control_updates = []
    for index, (testid, command_type, point_index) in enumerate((
        ("docx-path-point-0-1-0", "quadBezTo", 0),
        ("docx-path-point-1-1-1", "cubicBezTo", 1),
    ), 1):
        original = docx_curve_handle(acc, testid)
        expected_original = [
            int(before["paths"][index-1]["commands"][1]["points"][point_index][axis]) for axis in ("x", "y")
        ]
        h.require(original == expected_original, "selected handle did not match the source control point", [original, expected_original])
        moved = [original[0] + 20_000, original[1] + 10_000]
        docx_curve_set_coordinates(acc, moved)
        h.revision(acc, "docx", index * 3 - 2)
        actual = docx_curve_handle(acc, testid)
        h.require(actual == moved, f"{command_type} control point did not update through its coordinate editor", [moved, actual])
        events = acc.d.js("return window.docxCurvePointers")
        h.require(any(e == {"type": "pointerdown", "testid": testid, "trusted": True} for e in events)
                  and any(e == {"type": "pointerup", "testid": testid, "trusted": True} for e in events),
                  "control point was not selected with trusted native pointer input", events)
        keys = acc.d.js("return window.docxCurveKeys")
        h.require(keys and all(event["trusted"] for event in keys), "coordinate edits did not use trusted native keyboard input", keys)
        acc.key("ctrl+z")
        h.revision(acc, "docx", index * 3 - 1)
        docx_curve_enter_path_mode(acc)
        restored = docx_curve_handle(acc, testid)
        h.require(restored == original, "Undo did not restore exact source control point", [restored, original])
        acc.key("ctrl+y")
        h.revision(acc, "docx", index * 3)
        docx_curve_enter_path_mode(acc)
        redone = docx_curve_handle(acc, testid)
        h.require(redone == moved, "Redo did not restore exact edited control point", [redone, moved])
        control_updates.append({"command": command_type, "testid": testid, "before": original, "after": moved})

    h.publish(acc, "docx", row)
    after = inspect_docx_curve(path)
    expected_root = deepcopy(before["xml"])
    expected_geometry = expected_root.find(".//wps:wsp/wps:spPr/a:custGeom", {
        "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    })
    expected_ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    quad = expected_geometry.find("a:pathLst/a:path[1]/a:quadBezTo/a:pt[1]", expected_ns)
    cubic = expected_geometry.find("a:pathLst/a:path[2]/a:cubicBezTo/a:pt[2]", expected_ns)
    for target, update in zip((quad, cubic), control_updates, strict=True):
        target.set("x", str(update["after"][0]))
        target.set("y", str(update["after"][1]))
    h.require(ET.tostring(expected_root) == ET.tostring(after["xml"]),
              "saved DOCX changed unrelated story content or DrawingML structure")
    h.require(before["relationships"] == after["relationships"], "DOCX OPC relationships changed")
    h.require(before["parts"] == after["parts"], "unrelated DOCX package part changed")
    row["savedDrawingMl"] = after["paths"]
    row["controlUpdates"] = control_updates
    row["unchangedPackageParts"] = len(before["parts"])
    h.reopen(acc, path, row)
    docx_curve_enter_path_mode(acc)
    for update in control_updates:
        actual = docx_curve_handle(acc, update["testid"])
        h.require(actual == update["after"], "saved control point did not reopen in the native editor", [update, actual])


def docx_path_vertex_case(acc, row, fixtures, out):
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    cases = (
        ("open", "insert", ["moveTo", "lnTo", "lnTo"]),
        ("closed", "remove", ["moveTo", "lnTo", "lnTo", "lnTo", "close"]),
    )
    previous = None
    for index, (kind, action, expected_types) in enumerate(cases):
        result = row.setdefault("documents", {})[kind] = {}
        fixture = fixtures / f"{kind}.docx"
        before = inspect_docx_curve(fixture)
        h.require(len(before["paths"]) == 1 and
                  [command["type"] for command in before["paths"][0]["commands"]] == expected_types,
                  f"{kind} path fixture command sequence changed", before["paths"])
        if previous is not None:
            h.require(h.p4.rhwp_poc.close_tab(acc.d, previous.name), "previous saved DOCX tab did not close", previous.name)
        path = h.begin(acc, result, fixture, out, f"p4-dx-path-{kind}-edited.docx")
        docx_curve_enter_path_mode(acc)
        acc.d.js("""
          window.docxPathPointers=[];
          for(const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
            const point=e.target.closest('.object-path-point');
            if(point) docxPathPointers.push({type,testid:point.dataset.testid,trusted:e.isTrusted});
          },true);
        """)

        if action == "insert":
            h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == 3,
                      "open path should expose three original vertices")
            h.require(docx_curve_handle(acc, "docx-path-point-0-0-0") == [0, 0], "open path start vertex selection")
            events = acc.d.js("return window.docxPathPointers")
            h.require(any(e == {"type": "pointerdown", "testid": "docx-path-point-0-0-0", "trusted": True} for e in events)
                      and any(e == {"type": "pointerup", "testid": "docx-path-point-0-0-0", "trusted": True} for e in events),
                      "open path vertex was not selected by trusted native pointer input", events)
            acc.dom_click('[data-testid="docx-path-insert-vertex"]')
            result["insert"] = h.revision(acc, "docx", 1)
            docx_curve_enter_path_mode(acc)
            h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == 4,
                      "inserted open path did not expose four vertices")
            inserted = docx_curve_handle(acc, "docx-path-point-0-1-0")
            h.require(inserted == [50, 0], "inserted vertex is not the exact edge midpoint", inserted)
            acc.key("ctrl+z")
            result["undo"] = h.revision(acc, "docx", 2)
            docx_curve_enter_path_mode(acc)
            h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == 3,
                      "Undo did not remove the inserted open-path vertex")
            h.require(docx_curve_handle(acc, "docx-path-point-0-1-0") == [100, 0], "Undo did not restore original open-path coordinates")
            acc.key("ctrl+y")
            result["redo"] = h.revision(acc, "docx", 3)
            docx_curve_enter_path_mode(acc)
            h.require(docx_curve_handle(acc, "docx-path-point-0-1-0") == inserted, "Redo did not restore the exact inserted vertex")
            expected_root = deepcopy(before["xml"])
            drawing_path = expected_root.find(".//wps:wsp/wps:spPr/a:custGeom/a:pathLst/a:path", {
                "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape", **ns,
            })
            vertex = ET.Element("{" + ns["a"] + "}lnTo")
            ET.SubElement(vertex, "{" + ns["a"] + "}pt", {"x": "50", "y": "0"})
            drawing_path.insert(1, vertex)
            result["insertedCoordinates"] = inserted
        else:
            h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == 4,
                      "closed path should expose four original vertices")
            original = docx_curve_handle(acc, "docx-path-point-0-1-0")
            h.require(original == [100, 0], "closed path deletion target did not match its source vertex", original)
            events = acc.d.js("return window.docxPathPointers")
            h.require(any(e == {"type": "pointerdown", "testid": "docx-path-point-0-1-0", "trusted": True} for e in events)
                      and any(e == {"type": "pointerup", "testid": "docx-path-point-0-1-0", "trusted": True} for e in events),
                      "closed path vertex was not selected by trusted native pointer input", events)
            acc.dom_click('[data-testid="docx-path-remove-vertex"]')
            result["remove"] = h.revision(acc, "docx", 1)
            docx_curve_enter_path_mode(acc)
            h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == 3,
                      "closed path deletion did not retain exactly three vertices")
            remaining = docx_curve_handle(acc, "docx-path-point-0-1-0")
            h.require(remaining == [100, 100], "closed path deletion removed the wrong vertex", remaining)
            acc.key("ctrl+z")
            result["undo"] = h.revision(acc, "docx", 2)
            docx_curve_enter_path_mode(acc)
            h.require(docx_curve_handle(acc, "docx-path-point-0-1-0") == original, "Undo did not restore deleted closed-path vertex")
            acc.key("ctrl+y")
            result["redo"] = h.revision(acc, "docx", 3)
            docx_curve_enter_path_mode(acc)
            h.require(docx_curve_handle(acc, "docx-path-point-0-1-0") == remaining, "Redo did not restore closed-path deletion")
            acc.dom_click("[data-testid='docx-path-point-0-1-0']")
            remove_button = acc.d.js("return document.querySelector('[data-testid=docx-path-remove-vertex]')?.disabled")
            h.require(remove_button is True, "three-vertex closed path still offered an unsafe deletion")
            expected_root = deepcopy(before["xml"])
            drawing_path = expected_root.find(".//wps:wsp/wps:spPr/a:custGeom/a:pathLst/a:path", {
                "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape", **ns,
            })
            drawing_path.remove(list(drawing_path)[1])
            result["remainingCoordinates"] = remaining

        h.publish(acc, "docx", result)
        after = inspect_docx_curve(path)
        h.require(ET.tostring(expected_root) == ET.tostring(after["xml"]),
                  f"saved {kind} vertex edit changed unrelated DrawingML or document XML")
        h.require(before["relationships"] == after["relationships"], f"{kind} edit changed DOCX relationships")
        h.require(before["parts"] == after["parts"], f"{kind} edit changed another DOCX package part")
        actual_types = [command["type"] for command in after["paths"][0]["commands"]]
        h.require(actual_types == (expected_types[:1] + ["lnTo"] + expected_types[1:] if action == "insert" else expected_types[:1] + expected_types[2:]),
                  f"saved {kind} path command identity changed", actual_types)
        if kind == "closed":
            h.require(actual_types[-1] == "close", "closed path lost its Close command", actual_types)
        result["savedPaths"] = after["paths"]
        result["unchangedPackageParts"] = len(before["parts"])
        h.reopen(acc, path, result)
        docx_curve_enter_path_mode(acc)
        h.require(acc.d.js("return document.querySelectorAll('[data-testid^=docx-path-point-]').length") == (4 if action == "insert" else 3),
                  f"saved {kind} path did not independently reopen with the expected vertices")
        reopened = docx_curve_handle(acc, "docx-path-point-0-1-0")
        h.require(reopened == (result["insertedCoordinates"] if action == "insert" else result["remainingCoordinates"]),
                  f"saved {kind} vertex edit did not reopen in the native editor", reopened)
        previous = path


def docx_path_transform_fixture(source, out):
    fixture = out / "p4-path-transform-docx-fixture.docx"
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(fixture, "w") as after:
        for item in before.infolist():
            data = before.read(item.filename)
            if item.filename == "word/document.xml":
                root = ET.fromstring(data)
                ns = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                anchor = root.find(f".//{{{ns}}}inline")
                h.require(anchor is not None, "DOCX Bezier fixture is not an inline drawing")
                anchor.tag = f"{{{ns}}}anchor"
                anchor.attrib.update({
                    "distT": "0", "distB": "0", "distL": "0", "distR": "0",
                    "simplePos": "0", "relativeHeight": "251658241", "behindDoc": "0",
                    "locked": "0", "layoutInCell": "1", "allowOverlap": "1",
                })
                simple = ET.Element(f"{{{ns}}}simplePos", {"x": "0", "y": "0"})
                horizontal = ET.Element(f"{{{ns}}}positionH", {"relativeFrom": "margin"})
                ET.SubElement(horizontal, f"{{{ns}}}posOffset").text = "127000"
                vertical = ET.Element(f"{{{ns}}}positionV", {"relativeFrom": "margin"})
                ET.SubElement(vertical, f"{{{ns}}}posOffset").text = "63500"
                anchor.insert(0, simple)
                anchor.insert(1, horizontal)
                anchor.insert(2, vertical)
                effect = anchor.find(f"{{{ns}}}effectExtent")
                h.require(effect is not None, "DOCX drawing is missing effectExtent")
                # WordCraft's exact rotated overhang for this 100 × 50 pt, 30° frame.
                effect.attrib.update(l="73676", r="73676", t="274963", b="274963")
                children = list(anchor)
                doc_pr = next(i for i, child in enumerate(children) if child.tag == f"{{{ns}}}docPr")
                anchor.insert(doc_pr, ET.Element(f"{{{ns}}}wrapSquare", {"wrapText": "bothSides"}))
                transform = root.find(".//{http://schemas.microsoft.com/office/word/2010/wordprocessingShape}spPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm")
                h.require(transform is not None, "DOCX freeform transform is missing")
                transform.set("rot", "1800000")  # 30 degrees in DrawingML units.
                transform.set("flipH", "1")
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            after.writestr(item, data)
    return fixture


def docx_path_transform_case(acc, row, fixtures, out):
    source = fixtures / "bezier.docx"
    h.require(source.is_file(), "tracked DrawingML Bezier fixture is missing", str(source))
    fixture = docx_path_transform_fixture(source, out)
    before = inspect_docx_curve(fixture)
    h.require(before["transform"].get("rot") == "1800000"
              and before["transform"].get("flipH") == "1",
              "native fixture must have a modeled 30-degree horizontal reflection", before["transform"])
    h.require(before["anchorOffsets"] == {
        "horizontal": {"relativeFrom": "margin", "value": "127000"},
        "vertical": {"relativeFrom": "margin", "value": "63500"},
    }, "native DOCX fixture must retain nonzero page placement offsets", before["anchorOffsets"])
    path_index, segment_index, point_index = 1, 1, 0
    point = before["paths"][path_index]["commands"][segment_index]["points"][point_index]
    viewport = before["paths"][path_index]["attrs"]
    viewport_width, viewport_height = int(viewport["w"]), int(viewport["h"])
    shape_xfrm = before["xml"].find(".//{http://schemas.microsoft.com/office/word/2010/wordprocessingShape}spPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm")
    extent = shape_xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}ext")
    width_pt, height_pt = int(extent.get("cx")) / 12_700, int(extent.get("cy")) / 12_700
    path = h.begin(acc, row, fixture, out, "p4-path-transform-docx-edited.docx")
    docx_curve_enter_path_mode(acc)
    selector = f'[data-testid="docx-path-point-{path_index}-{segment_index}-{point_index}"]'
    h.require(acc.d.exists(selector), "transformed DrawingML control handle is missing", selector)
    acc.d.js("""
      window.p4PathTransformPointers=[];
      for(const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
        if(e.target.matches('.object-path-point'))
          p4PathTransformPointers.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      },true);
    """)
    x, y = acc.d.js("""
      const e=document.querySelector(arguments[0]), r=e.getBoundingClientRect();
      return [r.left+r.width/2,r.top+r.height/2];
    """, selector)
    overlay_width = acc.d.js("return parseFloat(document.querySelector('.object-path-points').style.width)")
    scale = overlay_width / width_pt
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x*sx, y*sy), ((x+4)*sx, (y+2)*sy))
    h.revision(acc, "docx", 1)
    events = row["trustedPointer"] = acc.d.js("return window.p4PathTransformPointers")
    h.require(len(events) == 2 and all(event["trusted"] for event in events),
              "transformed DrawingML handle did not receive trusted pointer input", events)
    rotation = math.radians(30)
    dx, dy = events[1]["x"] - events[0]["x"], events[1]["y"] - events[0]["y"]
    mapped = [
        math.floor(int(point["x"]) + (-math.cos(rotation)*dx - math.sin(rotation)*dy) / scale * viewport_width / width_pt + 0.5),
        math.floor(int(point["y"]) + (-math.sin(rotation)*dx + math.cos(rotation)*dy) / scale * viewport_height / height_pt + 0.5),
    ]
    mapped = [min(viewport_width, max(0, mapped[0])), min(viewport_height, max(0, mapped[1]))]
    coords = lambda: acc.d.js("return [...document.querySelectorAll('[data-testid=docx-path-coordinates] input')].map(e=>Number(e.value))")
    h.require(coords() == mapped, "DrawingML handle delta did not map through the inverse rotation/reflection", {"actual": coords(), "expected": mapped})
    acc.key("ctrl+z")
    row["undo"] = h.revision(acc, "docx", 2)
    docx_curve_enter_path_mode(acc)
    h.require(docx_curve_handle(acc, f"docx-path-point-{path_index}-{segment_index}-{point_index}")
              == [int(point["x"]), int(point["y"])], "Undo did not restore transformed path control point")
    acc.key("ctrl+y")
    row["redo"] = h.revision(acc, "docx", 3)
    docx_curve_enter_path_mode(acc)
    h.require(docx_curve_handle(acc, f"docx-path-point-{path_index}-{segment_index}-{point_index}") == mapped,
              "Redo did not restore transformed path control point")
    h.publish(acc, "docx", row)

    expected = deepcopy(before["xml"])
    expected_path = expected.find(".//{http://schemas.openxmlformats.org/drawingml/2006/main}custGeom/{http://schemas.openxmlformats.org/drawingml/2006/main}pathLst")
    expected_path = list(expected_path)[path_index]
    expected_segment = list(expected_path)[segment_index]
    expected_point = list(expected_segment)[point_index]
    h.require(expected_point is not None, "expected DrawingML control point disappeared")
    expected_point.set("x", str(mapped[0]))
    expected_point.set("y", str(mapped[1]))
    after = inspect_docx_curve(path)
    h.require(ET.tostring(expected) == ET.tostring(after["xml"]),
              "saved transformed DOCX changed XML outside the selected control point")
    h.require(before["transform"] == after["transform"], "saved transformed DOCX changed rotation or flips")
    h.require(before["transformFrame"] == after["transformFrame"],
              "saved transformed DOCX changed shape-local offsets or extents")
    h.require(before["anchorOffsets"] == after["anchorOffsets"],
              "saved transformed DOCX changed its nonzero page placement offsets")
    h.require(before["relationships"] == after["relationships"], "saved transformed DOCX changed OPC relationships")
    h.require(before["parts"] == after["parts"], "saved transformed DOCX changed another package part")
    row["savedTransform"] = after["transform"]
    row["savedControl"] = mapped
    row["unchangedPackageParts"] = len(before["parts"])
    h.reopen(acc, path, row)
    docx_curve_enter_path_mode(acc)
    h.require(docx_curve_handle(acc, f"docx-path-point-{path_index}-{segment_index}-{point_index}") == mapped,
              "saved transformed DOCX path did not reopen at the edited source coordinates")


def rhwp_path_transform_case(acc, row, fixtures, out, fmt):
    label = "hwpx" if fmt == "hwpx" else "h5"
    # WebKitWebDriver occasionally resets a read-only HTTP response while the
    # editor swaps the selected path or reopens the saved package. Retry only
    # pure DOM reads after this diagnosed transient; never replay input or edits.
    original_wait = acc.wait

    def retry_remote_read(operation):
        try:
            return operation()
        except h.p4.smoke.DriverLost as error:
            if "Remote end closed connection without response" not in str(error):
                raise
            row.setdefault("transientWebDriverReadRetries", []).append({
                "reason": "RemoteDisconnected", "operation": "read-only",
            })
            return operation()

    def wait(script, *args, timeout=30):
        return retry_remote_read(lambda: original_wait(script, *args, timeout=timeout))

    acc.wait = wait
    fixture = fixtures / f"a-p4-path-transform-{label}-original.{fmt}"
    h.require(fixture.is_file(), "transformed RHWP native fixture is missing", str(fixture))
    before = row["before"] = inspect(fixture)
    target = next((frame for frame in before["frames"]
                   if frame["path"] and frame["props"]["rotationAngle"] == 30
                   and frame["props"]["horzFlip"] and frame["props"]["horzOffset"] > 0), None)
    h.require(target is not None, "fixture must have a rotated, flipped path with a nonzero placement offset")
    model = target["path"]
    point_index = 1 if fmt == "hwpx" else next(
        index for index, point in enumerate(model["points"]) if point.get("control"))
    point = model["points"][point_index]
    path = h.begin(acc, row, fixture, out, f"p4-path-transform-{label}-edited.{fmt}")

    def select():
        h.select_object(acc, target, "shape")
        acc.dom_click(".object-path-mode")

    select()
    point_count = acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT)
    h.require(point_count == len(model["points"]) - int(model["closed"]),
              "transformed path handle count differs from its source path")
    point_selector = f"{POINT}:nth-of-type({point_index + 1})"
    acc.d.js("""
      window.p4PathTransformPointers=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
        if(e.target.classList.contains('object-path-point'))
          window.p4PathTransformPointers.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      },true);
    """)
    x, y = acc.d.js("""
      const e=document.querySelector(arguments[0]), r=e.getBoundingClientRect();
      return [r.x+r.width/2,r.y+r.height/2];
    """, point_selector)
    overlay_width = acc.d.js("return parseFloat(document.querySelector('.object-path-points').style.width)")
    width_pt = target["props"]["width"] / 75
    height_pt = target["props"]["height"] / 75
    scale = overlay_width / width_pt
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x*sx, y*sy), ((x+13)*sx, (y+9)*sy))
    h.revision(acc, fmt, 1)
    events = row["trustedPointer"] = acc.d.js("return window.p4PathTransformPointers")
    h.require(len(events) == 2 and all(event["trusted"] for event in events),
              "transformed RHWP handle did not receive trusted pointer input", events)
    rotation = math.radians(target["props"]["rotationAngle"])
    flip_x = -1 if target["props"]["horzFlip"] else 1
    flip_y = -1 if target["props"]["vertFlip"] else 1
    dx, dy = events[1]["x"] - events[0]["x"], events[1]["y"] - events[0]["y"]
    expected = [
        math.floor(point["x"] + (math.cos(rotation)*flip_x*dx + math.sin(rotation)*flip_x*dy)
                   / scale * model["width"] / width_pt + 0.5),
        math.floor(point["y"] + (-math.sin(rotation)*flip_y*dx + math.cos(rotation)*flip_y*dy)
                   / scale * model["height"] / height_pt + 0.5),
    ]
    expected = [min(model["width"], max(0, expected[0])), min(model["height"], max(0, expected[1]))]
    coords = lambda: retry_remote_read(lambda: acc.d.js(
        "return [...document.querySelectorAll(arguments[0]+' input')].map(e=>Number(e.value))", COORDS))
    h.require(coords() == expected, "transformed RHWP handle delta did not map to source coordinates", {"actual": coords(), "expected": expected})
    acc.key("ctrl+z")
    row["undo"] = h.revision(acc, fmt, 2)
    select()
    acc.dom_click(point_selector)
    h.require(coords() == [point["x"], point["y"]], "Undo did not restore transformed RHWP path point")
    acc.key("ctrl+y")
    row["redo"] = h.revision(acc, fmt, 3)
    select()
    acc.dom_click(point_selector)
    h.require(coords() == expected, "Redo did not restore transformed RHWP path point")
    h.publish(acc, fmt, row)
    after = row["after"] = inspect(path)
    want_path = {**model, "points": [dict(item) for item in model["points"]]}
    want_path["points"][point_index].update(x=expected[0], y=expected[1])
    if model["closed"]:
        want_path["points"][-1] = dict(want_path["points"][0])
    want = {**target, "path": want_path}
    h.require(after == {**before, "frames": [want if item == target else item for item in before["frames"]]},
              "independent RHWP engine changed unrelated shapes or geometry", after)
    if fmt == "hwpx":
        old, new = section_pair(fixture, path)
        vertices = old.findall(".//{*}polygon/{*}pt")
        h.require(len(vertices) == len(want_path["points"]), "saved transformed HWPX polygon point count changed")
        for vertex, value in zip(vertices, want_path["points"], strict=True):
            vertex.attrib.update(x=str(value["x"]), y=str(value["y"]))
        h.require(ET.tostring(old) == ET.tostring(new),
                  "saved transformed HWPX changed rotation, flips, offsets, metadata, or unrelated XML")
        row["unchangedPackageParts"] = "all outside Contents/section0.xml"
    else:
        old_streams, new_streams = [hwp_records.cfb_streams(item.read_bytes()) for item in (fixture, path)]
        h.require(old_streams.keys() == new_streams.keys(), "HWP5 stream ownership changed")
        old_body = hwp_records.unpacked(old_streams, "BodyText/Section0")
        new_body = hwp_records.unpacked(new_streams, "BodyText/Section0")
        changes = hwp_records.diff_stream(old_body, new_body)["changes"]
        h.require(len(changes) == 1 and changes[0]["op"] == "replace",
                  "saved transformed HWP5 changed more than one body record", changes)
        change = changes[0]
        h.require(len(change["original"]) == len(change["output"]) == 1
                  and change["original"][0]["index"] == change["output"][0]["index"]
                  and all(item["tag"] == 83 and item["level"] == 3 and item["len"] == 79
                          for item in (change["original"][0], change["output"][0])),
                  "HWP5 transformed-path edit changed the cubic leaf identity or length", change)
        preview_streams = {"BodyText/Section0", "PrvText", "PrvImage"}
        h.require({key: value for key, value in old_streams.items() if key not in preview_streams}
                  == {key: value for key, value in new_streams.items() if key not in preview_streams},
                  "HWP5 transformed-path edit changed unrelated CFB streams")
        old_records = hwp_records.records(old_body)
        new_records = hwp_records.records(new_body)
        h.require(len(old_records) == len(new_records), "HWP5 transformed-path edit changed record count")
        index = change["original"][0]["index"]
        h.require(all(old == new for i, (old, new) in enumerate(zip(old_records, new_records, strict=True)) if i != index),
                  "HWP5 transformed-path edit changed an adjacent record")
        tail = 4 + len(model["points"]) * 8
        h.require(old_records[index][:2] == new_records[index][:2] == (83, 3)
                  and old_records[index][2][tail:] == new_records[index][2][tail:],
                  "HWP5 transformed-path edit changed cubic commands or record padding")
        row["recordProof"] = change
    row["savedTransform"] = {key: target["props"][key] for key in
                              ("rotationAngle", "horzFlip", "vertFlip", "horzOffset", "vertOffset")}
    h.reopen(acc, path, row)
    select()
    acc.dom_click(point_selector)
    h.require(coords() == expected, "saved transformed RHWP path did not reopen at the edited source coordinate")


def points_case(acc, row, fixtures, out, kind, fmt):
    label = "hwp5-polygon" if (kind, fmt) == ("polygon", "hwp") else kind
    fixture = fixtures / f"a-p4-{label}-original.{fmt}"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["path"] and frame["path"]["kind"] == kind)
    path = h.begin(acc, row, fixture, out, f"a-p4-{label}-edited.{fmt}")
    model = target["path"]
    point_index = 1 if kind == "curve" else 0
    point = model["points"][point_index]
    selector = f"{POINT}:nth-of-type({point_index + 2})"

    def select():
        h.select_object(acc, target, "shape")
        acc.dom_click(".object-path-mode")

    def ui_point():
        return acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", COORDS)

    select()
    h.require(acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT)
              == len(model["points"]) - int(model["closed"]), "wrong number of point handles")
    h.require(acc.d.js("return document.querySelector(arguments[0]).dataset.control", selector)
              == str(point["control"]).lower(), "wrong handle role")
    acc.d.js("""
      window.p4Pointer=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
        if(e.target.classList.contains('object-path-point'))
          window.p4Pointer.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      },true);
    """)
    x, y = acc.d.js("""
      const r=document.querySelector(arguments[0]).getBoundingClientRect();
      return [r.x+r.width/2,r.y+r.height/2];
    """, selector)
    frame = h.frame(acc)
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x*sx, y*sy), ((x+13)*sx, (y+9)*sy))
    h.revision(acc, fmt, 1)
    events = row["pointer"] = acc.d.js("return window.p4Pointer")
    h.require(len(events) == 2 and all(e["trusted"] for e in events), "missing trusted pointer events", events)
    moved = [
        round(point["x"] + (events[1]["x"] - events[0]["x"]) * model["width"] / frame["width"]),
        round(point["y"] + (events[1]["y"] - events[0]["y"]) * model["height"] / frame["height"]),
    ]
    h.require(ui_point() == moved, "pointer did not update the expected local coordinates", ui_point())
    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    select()
    acc.dom_click(selector)
    h.require(ui_point() == [point["x"], point["y"]], "Undo did not restore exact point")
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    select()
    acc.dom_click(selector)
    h.require(ui_point() == moved, "Redo did not restore exact point")

    # A precise single-unit move exercises stored integer precision.
    endpoint_index = ((len(model["points"]) - 2) if model["closed"] else 3) if kind == "curve" else point_index
    endpoint = f"{POINT}:nth-of-type({endpoint_index + 2})"
    acc.dom_click(endpoint)
    exact = ui_point()
    exact[0] += 1
    h.p6.gso.replace(acc, COORDS + " input", exact[0])
    acc.dom_click(COORDS + " button")
    h.revision(acc, fmt, 4)
    h.require(ui_point() == exact, "precision field did not update point")
    acc.key("Escape")
    h.require(not acc.d.exists(POINT), "Escape did not exit point editing")
    h.publish(acc, fmt, row)

    expected = [value.copy() for value in model["points"]]
    expected[point_index].update(x=moved[0], y=moved[1])
    expected[endpoint_index].update(x=exact[0],y=exact[1])
    if model["closed"]:
        expected[-1] = expected[0]
    expected_segments = None
    if fmt == "hwpx" and kind == "curve":
        expected_segments = [[pair.copy() for pair in segment] for segment in model["segments"]]
        for index, attributes in enumerate(expected_segments):
            coordinates = {
                "x1": expected[index]["x"], "y1": expected[index]["y"],
                "x2": expected[index + 1]["x"], "y2": expected[index + 1]["y"],
            }
            for pair in attributes:
                if pair[0] in coordinates:
                    pair[1] = str(coordinates[pair[0]])
    after = row["after"] = inspect(path)
    expected_path = {**model,"points": expected}
    if expected_segments is not None:
        expected_path["segments"] = expected_segments
    want = {**target, "path": expected_path}
    h.require(after == {**before, "frames":[want if item == target else item for item in before["frames"]]},
              "independent engine changed unrelated content or geometry", after)
    if fmt == "hwp" and kind == "polygon":
        inspect_polygon_records(fixture, path, model["points"], expected)
    elif fmt == "hwp":
        streams = [h.p6.gso.cfb_streams(item.read_bytes()) for item in (fixture, path)]
        h.require({k:v for k,v in streams[0].items() if k not in {"BodyText/Section0","PrvText","PrvImage"}}
                  == {k:v for k,v in streams[1].items() if k not in {"BodyText/Section0","PrvText","PrvImage"}},
                  "unrelated HWP streams changed")
        old, new = [h.p6.gso.records(h.p6.gso.unpacked(stream,"BodyText/Section0")) for stream in streams]
        tail = 4 + len(expected)*8
        changes = [(a,b) for a,b in zip(old,new,strict=True) if a != b]
        h.require(len(changes) == 1 and changes[0][0][:2] == changes[0][1][:2] == (83,3),
                  "non-curve HWP records changed", changes)
        old_payload,new_payload = [item[2] for item in changes[0]]
        h.require(old_payload[tail:] == new_payload[tail:] == bytes([1,0,0,0,0,0,0,0]), "stored segment commands changed")
        h.require(list(struct.iter_unpack("<ii",new_payload[4:tail])) == [(p["x"],p["y"]) for p in expected],
                  "raw HWP geometry differs")
    elif fmt == "hwpx" and kind == "curve":
        old, new = section_pair(fixture, path)
        old_segments = old.findall(".//{*}curve/{*}seg")
        new_segments = new.findall(".//{*}curve/{*}seg")
        h.require(len(old_segments) == len(new_segments) == len(expected_segments),
                  "HWPX curve segment count changed")
        for index, segment in enumerate(old_segments):
            segment.attrib.update(
                x1=str(expected[index]["x"]), y1=str(expected[index]["y"]),
                x2=str(expected[index + 1]["x"]), y2=str(expected[index + 1]["y"]),
            )
        h.require(ET.tostring(old) == ET.tostring(new),
                  "HWPX curve segment types, metadata, or unrelated XML changed")
    else:
        old, new = section_pair(fixture, path)
        vertices = old.findall(".//{*}polygon/{*}pt")
        h.require(len(vertices) == len(expected), "raw polygon point count changed")
        for vertex, value in zip(vertices, expected, strict=True):
            vertex.attrib.update(x=str(value["x"]),y=str(value["y"]))
        h.require(ET.tostring(old) == ET.tostring(new), "unrelated HWPX XML or drawing attributes changed")
    h.reopen(acc, path, row)
    select()
    acc.dom_click(endpoint)
    h.require(ui_point() == exact, "published point did not reopen in app")


def hwpx_open_curve_fixture(source, destination):
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(destination, "w") as output:
        for entry in original.infolist():
            data = original.read(entry)
            if entry.filename == "Contents/section0.xml":
                def make_open(match):
                    body = match.group(0)
                    segments = list(re.finditer(rb'<hp:seg\b[^>]*/>', body))
                    h.require(len(segments) >= 4, "open-path fixture needs at least four source segments")
                    last = segments[-1]
                    return body[:last.start()] + body[last.end():]

                data, count = re.subn(rb'<hp:curve\b[^>]*>.*?</hp:curve>', make_open, data,
                                      count=1, flags=re.S)
                h.require(count == 1, "open-path fixture must contain one HWPX curve", count)
            output.writestr(entry, data)


def hwpx_curve_package_evidence(path):
    with zipfile.ZipFile(path) as package:
        root = ET.fromstring(package.read("Contents/section0.xml"))
        curves = root.findall(".//{*}curve")
        h.require(len(curves) == 1, "expected exactly one target HWPX curve", len(curves))
        segments = [list(segment.attrib.items()) for segment in curves[0].findall("./{*}seg")]
        non_segment_root = deepcopy(root)
        non_segment_curves = non_segment_root.findall(".//{*}curve")
        for segment in non_segment_curves[0].findall("./{*}seg"):
            non_segment_curves[0].remove(segment)
        non_segment_xml = ET.tostring(non_segment_root)
        parts = {name: hashlib.sha256(package.read(name)).hexdigest()
                 for name in package.namelist() if name != "Contents/section0.xml"}
    return {
        "segments": segments,
        "nonSegmentSectionSha256": hashlib.sha256(non_segment_xml).hexdigest(),
        "otherPartSha256": parts,
    }


def hwpx_contract_native_document(acc, row, fixture, out, filename, closed):
    before = inspect(fixture)
    target = next(item for item in before["frames"] if item["path"] and item["path"]["kind"] == "curve")
    path = h.begin(acc, row, fixture, out, filename)
    select = lambda: h.select_object(acc, target, "shape")
    select()
    if acc.d.js("return document.querySelector('.object-path-mode')?.getAttribute('aria-pressed')!=='true'"):
        acc.dom_click(".object-path-mode")
    h.require(acc.d.js("return document.querySelector('.object-path-mode')?.getAttribute('aria-pressed')==='true'"),
              "native HWPX curve path mode did not activate")
    expected_count = len(target["path"]["points"]) - int(closed)
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "native curve anchor count differs", expected_count)
    remove = ".object-path-remove-vertex"
    if not closed:
        for endpoint_index in (1, expected_count):
            acc.dom_click(f"{POINT}:nth-of-type({endpoint_index})")
            h.require(acc.d.js("return document.querySelector(arguments[0])?.disabled", remove),
                      "open-path endpoint deletion must remain unavailable", endpoint_index)
    note = acc.d.js("return document.querySelector('[data-testid=hwpx-curve-capability-note]')?.textContent||''")
    h.require("Bezier" in note or "베지어" in note,
              "UI must disclose that HWPX Bezier handles are not independent", note)
    exposed_handles = acc.d.js("return [...document.querySelectorAll('.object-path-point')].map(e=>e.dataset.control)")
    h.require(exposed_handles == ["false"] * expected_count,
              "HWPX exposed a misleading independently editable Bezier control handle", exposed_handles)
    h.require(not acc.d.exists("[data-testid=hwpx-curve-exact-split], [data-testid=hwpx-curve-exact-merge]"),
              "nonrepresentable exact CURVE operation is exposed in the UI")
    row["capabilityNote"] = note
    row["sourcePath"] = target["path"]
    row["pointerEvents"] = []
    acc.d.js("""
      window.p4HwpxCurvePointers=[];
      document.addEventListener('pointerdown', e => {
        if (e.target instanceof Element && e.target.matches('.object-path-point'))
          window.p4HwpxCurvePointers.push({type:e.type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      }, true);
      document.addEventListener('pointerup', e => {
        if (e.target instanceof Element && e.target.matches('.object-path-point'))
          window.p4HwpxCurvePointers.push({type:e.type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      }, true);
    """)
    revision_number = 0

    def commit_revision():
        nonlocal revision_number
        revision_number += 1
        revision(acc, "hwpx", revision_number)

    # Convert a native CURVE segment to LINE, then prove Undo/Redo in the actual UI.
    acc.dom_click(f"{POINT}:nth-of-type(1)")
    convert = "[data-testid=hwpx-curve-segment-convert]"
    h.require(acc.d.exists(convert), "segment type conversion control is missing")
    acc.dom_click(convert)
    commit_revision()
    if closed:
        acc.dom_click(f"{POINT}:nth-of-type(1)")
        h.require(acc.d.js("return document.querySelector(arguments[0])?.disabled", remove),
                  "mixed LINE/CURVE boundary deletion must remain unavailable")
    acc.key("ctrl+z")
    commit_revision()
    acc.key("ctrl+y")
    commit_revision()
    acc.dom_click(f"{POINT}:nth-of-type(1)")
    acc.dom_click(convert)
    commit_revision()
    acc.key("ctrl+z")
    commit_revision()
    acc.key("ctrl+y")
    commit_revision()
    # Leave the persisted first segment as LINE after proving the reverse conversion.
    acc.key("ctrl+z")
    commit_revision()
    acc.dom_click(f"{POINT}:nth-of-type(1)")
    if closed:
        h.require(acc.d.js("return document.querySelector(arguments[0])?.disabled", remove),
                  "mixed LINE/CURVE boundary deletion must remain unavailable after conversion history")

    # Exact operations stay distinct from shape-changing anchors. The current
    # source has one native LINE whose integer lattice contains a midpoint.
    acc.dom_click(f"{POINT}:nth-of-type(1)")
    split = ".object-path-split-line"
    h.require(acc.d.exists(split), "supported straight segment did not expose its exact split")
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "exact LINE split started from unexpected topology")
    acc.dom_click(split)
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count + 1,
              "exact LINE split did not add one anchor")
    acc.key("ctrl+z")
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "exact LINE split Undo did not restore topology")
    acc.key("ctrl+y")
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count + 1,
              "exact LINE split Redo did not restore the split anchor")
    acc.dom_click(f"{POINT}:nth-of-type(2)")
    join = ".object-path-join-lines"
    h.require(acc.d.exists(join), "collinear native LINE halves did not expose exact merge")
    acc.dom_click(join)
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "exact LINE merge did not restore the original topology")
    acc.key("ctrl+z")
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count + 1,
              "exact LINE merge Undo did not restore the split topology")
    acc.key("ctrl+y")
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "exact LINE merge Redo did not restore the joined topology")
    row["exactLineSplitMerge"] = {"undoRedo": True, "anchorCountAfterJoin": expected_count}

    # Ordinary insertion is explicitly shape-changing. Undo/Redo must retain topology.
    acc.dom_click(f"{POINT}:nth-of-type(2)")
    add = ".object-path-add-vertex"
    h.require(not acc.d.js("return document.querySelector(arguments[0])?.disabled", add),
              "valid native curve segment did not offer ordinary anchor insertion")
    acc.dom_click(add)
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count + 1,
              "anchor insertion did not add exactly one native anchor")
    acc.key("ctrl+z")
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "anchor insertion Undo did not restore topology")
    acc.key("ctrl+y")
    commit_revision()

    # The inserted anchor is index 2 and has like-typed neighbors in this fixture.
    acc.dom_click(f"{POINT}:nth-of-type(3)")
    h.require(not acc.d.js("return document.querySelector(arguments[0])?.disabled", remove),
              "supported same-type anchor deletion was not offered")
    acc.dom_click(remove)
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count,
              "anchor deletion did not restore the original anchor count")
    acc.key("ctrl+z")
    commit_revision()
    h.require(acc.d.js("return document.querySelectorAll('.object-path-point').length") == expected_count + 1,
              "anchor deletion Undo did not restore the inserted anchor")
    acc.key("ctrl+y")
    commit_revision()

    # Move a shared endpoint using trusted X11 pointer input. The closed path
    # must retain closure; open paths retain their two independent endpoints.
    first = f"{POINT}:nth-of-type(1)"
    acc.dom_click(first)
    before_coordinates = acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", COORDS)
    x, y = acc.d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]", first)
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x*sx,y*sy), ((x+7)*sx,(y+5)*sy))
    pointer_events = row["pointer"] = acc.d.js("return window.p4HwpxCurvePointers")
    h.require(len(pointer_events) >= 2 and all(event["trusted"] for event in pointer_events[-2:]),
              "anchor movement did not use trusted Native pointer input", pointer_events)
    commit_revision()
    after_coordinates = acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", COORDS)
    h.require(after_coordinates != before_coordinates, "Native pointer did not move the selected curve anchor")
    acc.key("ctrl+z")
    commit_revision()
    select()
    acc.dom_click(first)
    h.require(acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", COORDS)
              == before_coordinates, "anchor movement Undo did not restore the shared endpoint")
    acc.key("ctrl+y")
    commit_revision()
    select()
    acc.dom_click(first)
    h.require(acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", COORDS)
              == after_coordinates, "anchor movement Redo did not restore the moved endpoint")

    acc.key("Escape")
    h.publish(acc, "hwpx", row)
    row["after"] = inspect(path)
    saved = hwpx_curve_package_evidence(path)
    source = hwpx_curve_package_evidence(fixture)
    h.require(saved["otherPartSha256"] == source["otherPartSha256"],
              "curve editing changed unrelated HWPX package parts")
    h.require(saved["nonSegmentSectionSha256"] == source["nonSegmentSectionSha256"],
              "curve editing changed owner, formatting, or unrelated section XML")
    saved_frame = next(item for item in row["after"]["frames"]
                       if item["controlIdx"] == target["controlIdx"] and item["path"])
    saved_path = saved_frame["path"]
    model_segments = [[list(pair) for pair in segment] for segment in saved_path["segments"]]
    h.require(saved["segments"] == model_segments,
              "saved native hp:seg records differ from the reopened engine model", saved)
    types = [dict(segment).get("type") for segment in saved["segments"]]
    h.require(types == ["LINE"] + ["CURVE"] * (len(types) - 1),
              "serialized segment conversion or remaining segment types differ", types)
    h.require(saved_path["closed"] is closed,
              "saved path open/closed state changed", saved_path)
    h.require(row["after"]["body"] == before["body"], "curve edit changed unrelated body text")
    other_before = [item for item in before["frames"] if item["controlIdx"] != target["controlIdx"]]
    other_after = [item for item in row["after"]["frames"] if item["controlIdx"] != target["controlIdx"]]
    h.require(other_after == other_before, "curve edit changed another object or owner")
    row["independentPackageProof"] = saved
    h.require(digest(fixture) == row["fixtureSha256"], "curve source fixture changed on disk")
    reopen(acc, path, row)
    h.require(row["reopenedSession"].get("dirty") == "false",
              "saved curve did not reopen in a clean independent document session", row["reopenedSession"])
    reopened = inspect(path)
    reopened_frame = next(item for item in reopened["frames"]
                          if item["controlIdx"] == target["controlIdx"] and item["path"])
    h.require(reopened_frame["path"] == saved_path, "fresh-session reopened curve differs from saved geometry")
    row["freshSessionPath"] = reopened_frame["path"]
    row["publishedSha256"] = digest(path)


def hwpx_curve_contract_v1_case(acc, row, fixtures, out):
    closed_fixture = ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.canonical.hwpx"
    h.require(closed_fixture.is_file(), "canonical HWPX curve fixture is missing", str(closed_fixture))
    closed_row = row["closed"] = {}
    hwpx_contract_native_document(acc, closed_row, closed_fixture, out,
                                  "p4-hwpx-contract-closed-edited.hwpx", True)

    open_fixture = out / "p4-hwpx-contract-open-fixture.hwpx"
    hwpx_open_curve_fixture(closed_fixture, open_fixture)
    open_row = row["open"] = {}
    hwpx_contract_native_document(acc, open_row, open_fixture, out,
                                  "p4-hwpx-contract-open-edited.hwpx", False)


def inspect_polygon_records(source, path, before, after):
    gso = h.p6.gso
    streams = [gso.cfb_streams(item.read_bytes()) for item in (source, path)]
    ignored = {"BodyText/Section0", "PrvText", "PrvImage"}
    rest = lambda stream: {name: data for name, data in stream.items() if name not in ignored}
    h.require(rest(streams[0]) == rest(streams[1]), "unrelated HWP streams changed")
    records = [gso.records(gso.unpacked(stream, "BodyText/Section0")) for stream in streams]
    changes = [(a, b) for a, b in zip(*records, strict=True) if a != b]
    h.require(len(changes) == 1 and all(item[:2] == (82, 3) for item in changes[0]),
              "non-polygon HWP records changed", changes)
    for (_, _, payload), points in zip(changes[0], (before, after), strict=True):
        count, = struct.unpack_from("<I", payload)
        end = 4 + count * 8
        h.require(count == len(points) and payload[end:] == bytes(4), "polygon count or padding differs")
        h.require(list(struct.iter_unpack("<ii", payload[4:end])) == [(p["x"], p["y"]) for p in points],
                  "raw HWP polygon coordinates differ")


def hwp5_polygon_edges(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-hwp5-polygon-original.hwp"
    before = inspect(fixture)
    target = next(item for item in before["frames"] if item["path"] and item["path"]["kind"] == "polygon")
    points = target["path"]["points"]
    split_row, join_row = row["split"], row["join"] = {}, {}
    split_path = h.begin(acc, split_row, fixture, out, "a-p4-hwp5-polygon-split.hwp")

    def select():
        h.select_object(acc, target, "shape")
        acc.dom_click(".object-path-mode")

    def count(expected):
        h.require(acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT) == expected,
                  "unexpected HWP polygon vertex count", expected)

    select()
    count(3)
    acc.d.js("""
      window.polygonClicks=[];
      addEventListener('click', e => {
        if (e.target.matches('.object-path-add-vertex, .object-path-remove-vertex'))
          polygonClicks.push({ action:e.target.className, trusted:e.isTrusted });
      }, true);
    """)
    acc.dom_click(f"{POINT}:nth-of-type(4)")
    acc.dom_click(".object-path-add-vertex")
    h.revision(acc, "hwp", 1)
    count(4)
    acc.dom_click(f"{POINT}:nth-of-type(2)")
    h.require(acc.d.js("return document.querySelector('.object-path-remove-vertex').disabled"),
              "noncollinear corner removal must be disabled")
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    select()
    count(3)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    select()
    count(4)
    h.publish(acc, "hwp", split_row)
    split_points = points[:-1] + [{"x": 4000, "y": 3900, "control": False}, points[-1]]
    inspect_polygon_records(fixture, split_path, points, split_points)
    split_model = inspect(split_path)
    expected_target = {**target, "path": {**target["path"], "points": split_points}}
    h.require(split_model == {**before, "frames": [expected_target if item == target else item for item in before["frames"]]},
              "independent engine changed shape owner or surrounding content", split_model)
    h.reopen(acc, split_path, split_row)
    select()
    count(4)

    join_path = h.begin(acc, join_row, split_path, out, "a-p4-hwp5-polygon-joined.hwp")
    select()
    acc.dom_click(f"{POINT}:nth-of-type(5)")
    acc.dom_click(".object-path-remove-vertex")
    h.revision(acc, "hwp", 1)
    count(3)
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    select()
    count(4)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    select()
    count(3)
    row["trustedClicks"] = acc.d.js("return window.polygonClicks")
    h.require(row["trustedClicks"] == [
        {"action": "object-path-add-vertex", "trusted": True},
        {"action": "object-path-remove-vertex", "trusted": True},
    ], "missing trusted polygon clicks", row["trustedClicks"])
    h.publish(acc, "hwp", join_row)
    inspect_polygon_records(split_path, join_path, split_points, points)
    h.require(inspect(join_path) == before, "join did not restore the original geometry and owner")
    h.reopen(acc, join_path, join_row)
    select()
    count(3)


def section_pair(fixture, path):
    section = "Contents/section0.xml"
    with zipfile.ZipFile(fixture) as before, zipfile.ZipFile(path) as after:
        rest = lambda package: {entry: package.read(entry) for entry in package.namelist()
                                if entry != section and not entry.startswith("Preview/")}
        h.require(rest(before) == rest(after), "unrelated HWPX package entries changed")
        return ET.fromstring(before.read(section)), ET.fromstring(after.read(section))


def hwpx_curve_catmull_rom_case(acc, row, fixtures, out):
    source_sample = ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.hwpx"
    fixture = ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.canonical.hwpx"
    row["sourceSampleSha256"] = h.digest(source_sample)
    before = row["before"] = inspect(fixture)
    row["canonicalFixtureSha256"] = h.digest(fixture)
    target = next(frame for frame in before["frames"]
                  if frame["path"] and frame["path"].get("curveModel") == "catmull-rom-derived-bezier")
    original_points = target["path"]["points"]
    original_segments = deepcopy(target["path"]["segments"])
    h.require(target["path"]["closed"] and len(original_points) == 7 and len(original_segments) == 6,
              "unexpected authentic Catmull-Rom curve topology", target["path"])
    h.require(all(dict(segment).get("type") == "CURVE" and set(dict(segment)) ==
                  {"type", "x1", "y1", "x2", "y2"} for segment in original_segments),
              "fixture segment envelope is not strict standard HWPX CURVE", original_segments)
    bezier = target["path"]["bezierSegments"][0]
    midpoint_x = (bezier["start"]["x"] + 3 * bezier["control1"]["x"]
                  + 3 * bezier["control2"]["x"] + bezier["end"]["x"]) / 8
    midpoint_y = (bezier["start"]["y"] + 3 * bezier["control1"]["y"]
                  + 3 * bezier["control2"]["y"] + bezier["end"]["y"]) / 8
    midpoint = {
        "x": math.floor(midpoint_x + 0.5),
        "y": math.floor(midpoint_y + 0.5),
        "control": False,
    }
    path = h.begin(acc, row, fixture, out, "a-p4-hwpx-catmull-rom-edited.hwpx")

    def select():
        h.select_object(acc, target, "shape")
        if acc.d.js("return document.querySelector('.object-path-mode')?.getAttribute('aria-pressed')") != "true":
            acc.dom_click(".object-path-mode")

    def count(expected):
        acc.wait("return document.querySelectorAll(arguments[0]).length===arguments[1]", POINT, expected)

    def select_vertex(index, value):
        labels = acc.d.js("return [...document.querySelectorAll(arguments[0])].map(e=>e.getAttribute('aria-label'))", POINT)
        h.require(len(labels) > index, "missing Catmull-Rom anchor handle", labels)
        label = labels[index].replace("\\", "\\\\").replace('"', '\\"')
        acc.dom_click(f'{POINT}[aria-label="{label}"]')
        expected = f'[{value["x"]},{value["y"]}]'
        acc.wait("return JSON.stringify([...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value))===arguments[1]",
                 COORDS, expected)

    acc.d.js("""
      window.catmullRomAnchorActions=[];
      document.addEventListener('click',e=>{
        if(e.target.matches('.object-path-add-vertex,.object-path-remove-vertex'))
          window.catmullRomAnchorActions.push({action:e.target.classList.contains('object-path-add-vertex')?'insert':'remove',trusted:e.isTrusted});
      },true);
    """)
    select()
    count(6)
    select_vertex(0, original_points[0])
    h.require(not acc.d.js("return document.querySelector('.object-path-add-vertex').disabled"),
              "derived Catmull-Rom midpoint insertion is unavailable")
    acc.dom_click(".object-path-add-vertex")
    h.revision(acc, "hwpx", 1)
    select()
    count(7)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    select()
    count(6)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    select()
    count(7)
    select_vertex(1, midpoint)

    inserted_segments = deepcopy(original_segments)
    left = deepcopy(inserted_segments[0])
    right = deepcopy(inserted_segments[0])
    for attributes, updates in ((left, {"x2": str(midpoint["x"]), "y2": str(midpoint["y"])}),
                                (right, {"x1": str(midpoint["x"]), "y1": str(midpoint["y"])})):
        for pair in attributes:
            if pair[0] in updates:
                pair[1] = updates[pair[0]]
    inserted_segments[0:1] = [left, right]
    inserted_points = [*original_points[:1], midpoint, *original_points[1:]]
    inserted_path = {**target["path"], "points": inserted_points, "segments": inserted_segments}
    anchors = inserted_points[:-1]
    inserted_path["bezierSegments"] = []
    for index, start in enumerate(anchors):
        end = anchors[(index + 1) % len(anchors)]
        previous = anchors[(index - 1) % len(anchors)]
        following = anchors[(index + 2) % len(anchors)]
        inserted_path["bezierSegments"].append({
            "start": {"x": start["x"], "y": start["y"]},
            "control1": {"x": start["x"] + (end["x"] - previous["x"]) / 6,
                         "y": start["y"] + (end["y"] - previous["y"]) / 6},
            "control2": {"x": end["x"] - (following["x"] - start["x"]) / 6,
                         "y": end["y"] - (following["y"] - start["y"]) / 6},
            "end": {"x": end["x"], "y": end["y"]},
        })
    inserted_target = {**target, "path": inserted_path}
    expected_inserted = {**before, "frames": [inserted_target if frame == target else frame for frame in before["frames"]]}
    row["trustedAnchorActions"] = acc.d.js("return window.catmullRomAnchorActions")
    h.require(row["trustedAnchorActions"] == [{"action": "insert", "trusted": True}],
              "anchor insertion was not a trusted Native click", row["trustedAnchorActions"])
    h.publish(acc, "hwpx", row)
    row["insertedSave"] = row["save"]
    inserted_model = row["insertedModel"] = inspect(path)
    h.require(inserted_model == expected_inserted,
              "saved anchor insertion changed curve ownership, sibling geometry, or attributes", inserted_model)
    old_section, inserted_section = section_pair(fixture, path)
    expected_section = deepcopy(old_section)
    curve = expected_section.find(".//{*}curve")
    xml_segments = curve.findall("{*}seg")
    first = xml_segments[0]
    second = deepcopy(first)
    first.attrib["x2"], first.attrib["y2"] = str(midpoint["x"]), str(midpoint["y"])
    second.attrib["x1"], second.attrib["y1"] = str(midpoint["x"]), str(midpoint["y"])
    curve.insert(list(curve).index(first) + 1, second)
    h.require(ET.tostring(expected_section) == ET.tostring(inserted_section),
              "saved insertion changed raw segment metadata or unrelated section XML")
    h.reopen(acc, path, row)
    row["insertedReopenedSession"] = row["reopenedSession"]
    h.require(row["insertedReopenedSession"].get("dirty") == "false"
              and row["insertedReopenedSession"].get("unpreserved") == "false",
              "inserted curve did not reopen cleanly", row["insertedReopenedSession"])

    target = next(frame for frame in inserted_model["frames"]
                  if frame["path"] and frame["path"].get("curveModel") == "catmull-rom-derived-bezier")
    select()
    count(7)
    select_vertex(1, midpoint)
    h.require(not acc.d.js("return document.querySelector('.object-path-remove-vertex').disabled"),
              "inserted curve anchor cannot be removed")
    acc.dom_click(".object-path-remove-vertex")
    h.revision(acc, "hwpx", 1)
    select()
    count(6)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    select()
    count(7)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    select()
    count(6)
    row["trustedAnchorActions"] = acc.d.js("return window.catmullRomAnchorActions")
    h.require(row["trustedAnchorActions"] == [
        {"action": "insert", "trusted": True}, {"action": "remove", "trusted": True}],
        "anchor insert/delete were not trusted Native clicks", row["trustedAnchorActions"])
    h.publish(acc, "hwpx", row)
    after = row["after"] = inspect(path)
    h.require(after == before, "deleted anchor did not restore original curve model and ownership", after)
    old_section, new_section = section_pair(fixture, path)
    h.require(ET.tostring(old_section) == ET.tostring(new_section),
              "saved deletion did not restore exact source curve XML")
    h.reopen(acc, path, row)
    row["deletedReopenedSession"] = row["reopenedSession"]
    h.require(row["deletedReopenedSession"].get("dirty") == "false"
              and row["deletedReopenedSession"].get("unpreserved") == "false",
              "deleted curve did not reopen cleanly", row["deletedReopenedSession"])
    target = next(frame for frame in after["frames"]
                  if frame["path"] and frame["path"].get("curveModel") == "catmull-rom-derived-bezier")
    select()
    count(6)
    row["fixtureSha256After"] = h.digest(fixture)
    h.require(row["fixtureSha256After"] == row["fixtureSha256"], "authentic source fixture changed")
    row["sourceSampleSha256After"] = h.digest(source_sample)
    h.require(row["sourceSampleSha256After"] == row["sourceSampleSha256"],
              "upstream source sample changed")


def hwpx_curve_line_segments_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-curve-original.hwpx"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["path"] and frame["path"]["kind"] == "curve")
    original_points = target["path"]["points"]
    original_segments = deepcopy(target["path"]["segments"])
    h.require(target["path"]["closed"] and len(original_points) == 4 and len(original_segments) == 3,
              "unexpected HWPX curve fixture topology", target["path"])
    h.require([dict(segment)["type"] for segment in original_segments] == ["CURVE", "LINE", "CURVE"],
              "fixture must contain one supported interior LINE", original_segments)
    h.require(set(dict(original_segments[1])) == {"type", "x1", "y1", "x2", "y2"},
              "editable LINE source envelope differs", original_segments[1])
    midpoint = {
        "x": (original_points[1]["x"] + original_points[2]["x"]) // 2,
        "y": (original_points[1]["y"] + original_points[2]["y"]) // 2,
        "control": False,
    }
    h.require(midpoint == {"x": 8050, "y": 3600, "control": False}, "unexpected integer line midpoint", midpoint)
    path = h.begin(acc, row, fixture, out, "a-p4-hwpx-curve-lines.hwpx")

    def select():
        h.select_object(acc, target, "shape")
        before = acc.d.js("""
          const e=document.querySelector('.object-path-mode'), f=document.querySelector('.object-selection-frame');
          return {button:!!e,pressed:e?.getAttribute('aria-pressed'),kind:f?.dataset.objectKind,
            points:document.querySelectorAll(arguments[0]).length,revision:document.querySelector('[data-testid=rhwp-status]')?.dataset.revision};
        """, POINT)
        if before["pressed"] != "true":
            acc.dom_click(".object-path-mode")
        after = acc.d.js("""
          const e=document.querySelector('.object-path-mode'), f=document.querySelector('.object-selection-frame');
          return {button:!!e,pressed:e?.getAttribute('aria-pressed'),kind:f?.dataset.objectKind,
            points:document.querySelectorAll(arguments[0]).length,revision:document.querySelector('[data-testid=rhwp-status]')?.dataset.revision,
            clicks:window.hwpxCurveLineModeClicks};
        """, POINT)
        row.setdefault("pathModeTrace", []).append({"before": before, "after": after})
        h.require(after["pressed"] == "true", "native pointer did not activate path edit mode", row["pathModeTrace"][-1])

    def select_vertex(index, value):
        labels = acc.d.js("return [...document.querySelectorAll(arguments[0])].map(e=>e.getAttribute('aria-label'))", POINT)
        h.require(len(labels) > index, "missing curve point handle", labels)
        label = labels[index].replace("\\", "\\\\").replace('"', '\\"')
        acc.dom_click(f'{POINT}[aria-label="{label}"]')
        expected = f'[{value["x"]},{value["y"]}]'
        acc.wait("return JSON.stringify([...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value))===arguments[1]",
                 COORDS, expected)

    def present(selector, expected):
        condition = "!!document.querySelector(arguments[0])" if expected else "!document.querySelector(arguments[0])"
        acc.wait("return " + condition, selector)

    def count(expected):
        acc.wait("return document.querySelectorAll(arguments[0]).length===arguments[1]", POINT, expected)

    acc.d.js("""
      window.hwpxCurveLineActions=[];
      window.hwpxCurveLineModeClicks=[];
      document.addEventListener('click',e=>{
        if(e.target.matches('.object-path-mode'))
          window.hwpxCurveLineModeClicks.push({trusted:e.isTrusted,pressed:e.target.getAttribute('aria-pressed')});
        if(e.target.matches('.object-path-split-line,.object-path-join-lines'))
          window.hwpxCurveLineActions.push({action:e.target.classList.contains('object-path-split-line')?'split':'join',trusted:e.isTrusted});
      },true);
    """)
    select()
    count(3)
    select_vertex(0, original_points[0])
    present(".object-path-split-line", False)
    present(".object-path-join-lines", False)
    select_vertex(1, original_points[1])
    present(".object-path-split-line", True)
    present(".object-path-join-lines", False)
    select_vertex(2, original_points[2])
    present(".object-path-split-line", False)
    present(".object-path-join-lines", False)
    select_vertex(1, original_points[1])
    acc.dom_click(".object-path-split-line")
    h.revision(acc, "hwpx", 1)
    select()
    count(4)
    select_vertex(2, midpoint)
    present(".object-path-join-lines", True)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    select()
    count(3)
    select_vertex(1, original_points[1])
    present(".object-path-join-lines", False)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    select()
    count(4)
    select_vertex(2, midpoint)
    present(".object-path-join-lines", True)

    split_segments = deepcopy(original_segments)
    left = deepcopy(split_segments[1])
    right = deepcopy(split_segments[1])
    for attributes, updates in ((left, {"x2": str(midpoint["x"]), "y2": str(midpoint["y"])}),
                                (right, {"x1": str(midpoint["x"]), "y1": str(midpoint["y"])})):
        for pair in attributes:
            if pair[0] in updates:
                pair[1] = updates[pair[0]]
    split_segments[1:2] = [left, right]
    split_points = [*original_points[:2], midpoint, *original_points[2:]]
    split_path = {**target["path"], "points": split_points, "segments": split_segments}
    split_target = {**target, "path": split_path}
    expected_split = {**before, "frames": [split_target if frame == target else frame for frame in before["frames"]]}
    h.publish(acc, "hwpx", row)
    row["splitSave"] = row["save"]
    split_model = row["splitModel"] = inspect(path)
    h.require(split_model == expected_split, "saved split changed curve ownership, siblings, or geometry", split_model)
    original_section, split_section = section_pair(fixture, path)
    expected_section = deepcopy(original_section)
    curve = expected_section.find(".//{*}curve")
    serialized_segments = curve.findall("{*}seg")
    h.require(len(serialized_segments) == 3, "source XML lost the expected three curve segments")
    line = serialized_segments[1]
    second = deepcopy(line)
    line.attrib["x2"], line.attrib["y2"] = str(midpoint["x"]), str(midpoint["y"])
    second.attrib["x1"], second.attrib["y1"] = str(midpoint["x"]), str(midpoint["y"])
    curve.insert(list(curve).index(line) + 1, second)
    h.require(ET.tostring(expected_section) == ET.tostring(split_section),
              "saved split changed segment metadata, XML siblings, or section structure")
    h.reopen(acc, path, row)
    row["splitReopenedSession"] = row["reopenedSession"]
    h.require(row["splitReopenedSession"].get("dirty") == "false"
              and row["splitReopenedSession"].get("unpreserved") == "false",
              "split document did not reopen cleanly", row["splitReopenedSession"])

    target = next(frame for frame in split_model["frames"] if frame["path"] and frame["path"]["kind"] == "curve")
    select()
    count(4)
    select_vertex(2, midpoint)
    present(".object-path-join-lines", True)
    acc.dom_click(".object-path-join-lines")
    # The independent reopened session starts a fresh revision sequence.
    h.revision(acc, "hwpx", 1)
    select()
    count(3)
    select_vertex(1, original_points[1])
    present(".object-path-split-line", True)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    select()
    count(4)
    select_vertex(2, midpoint)
    present(".object-path-join-lines", True)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    select()
    count(3)
    row["lineActions"] = acc.d.js("return window.hwpxCurveLineActions")
    h.require(row["lineActions"] == [{"action": "split", "trusted": True}, {"action": "join", "trusted": True}],
              "split/join actions were not trusted Native clicks", row["lineActions"])
    h.publish(acc, "hwpx", row)
    row["joinedSave"] = row["save"]
    after = row["after"] = inspect(path)
    h.require(after == before, "joined document did not restore the original owner and geometry", after)
    old, new = section_pair(fixture, path)
    h.require(ET.tostring(old) == ET.tostring(new), "join did not restore exact curve XML and unrelated section data")
    h.reopen(acc, path, row)
    row["joinedReopenedSession"] = row["reopenedSession"]
    h.require(row["joinedReopenedSession"].get("dirty") == "false"
              and row["joinedReopenedSession"].get("unpreserved") == "false",
              "joined document did not reopen cleanly", row["joinedReopenedSession"])
    target = next(frame for frame in after["frames"] if frame["path"] and frame["path"]["kind"] == "curve")
    select()
    count(3)
    select_vertex(1, original_points[1])
    present(".object-path-split-line", True)
    row["publishedSha256"] = h.digest(path)
    h.require(h.digest(fixture) == row["fixtureSha256"], "source fixture was modified")


def polygon_vertices_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-polygon-original.hwpx"
    before = row["before"] = inspect(fixture)
    target = next(item for item in before["frames"] if item["path"] and item["path"]["kind"] == "polygon")
    path = h.begin(acc, row, fixture, out, "a-p4-vertices-published.hwpx")

    def select():
        h.select_object(acc, target, "shape")
        acc.dom_click(".object-path-mode")

    def count(expected):
        h.require(acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT) == expected,
                  "unexpected number of polygon vertices", expected)

    select()
    count(3)
    h.require(acc.d.js("return document.querySelector('.object-path-remove-vertex').disabled"),
              "triangle must retain at least three vertices")
    acc.d.js("""
      window.vertexActions = [];
      document.addEventListener('click', e => {
        if (e.target.matches('.object-path-add-vertex,.object-path-remove-vertex'))
          window.vertexActions.push({action: e.target.className, trusted: e.isTrusted});
      }, true);
    """)
    acc.dom_click(f"{POINT}:nth-of-type(4)")  # Closing edge starts at the third vertex.
    acc.dom_click(".object-path-add-vertex")
    h.revision(acc, "hwpx", 1)
    count(4)
    acc.dom_click(".object-path-add-vertex")
    h.revision(acc, "hwpx", 2)
    count(5)
    acc.dom_click(f"{POINT}:nth-of-type(2)")
    acc.dom_click(".object-path-remove-vertex")
    h.revision(acc, "hwpx", 3)
    count(4)
    actions = row["vertexActions"] = acc.d.js("return window.vertexActions")
    h.require([item["action"] for item in actions] ==
              ["object-path-add-vertex", "object-path-add-vertex", "object-path-remove-vertex"]
              and all(item["trusted"] for item in actions), "missing trusted vertex edit clicks", actions)

    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 4)
    select()
    count(5)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 5)
    select()
    count(4)
    acc.key("Escape")
    h.publish(acc, "hwpx", row)

    points = [(9700,700), (6400,6500), (5200,5200), (4000,3900), (9700,700)]
    want = {**target, "path": {**target["path"],
        "points": [{"x":x, "y":y, "control":False} for x,y in points]}}
    after = row["after"] = inspect(path)
    h.require(after == {**before,"frames":[want if item == target else item for item in before["frames"]]},
              "independent engine polygon projection differs", after)
    old, new = section_pair(fixture, path)
    for section in (old, new):
        polygon = section.find(".//{*}polygon")
        vertices = polygon.findall("{*}pt")
        if section is new:
            h.require([(int(p.attrib["x"]), int(p.attrib["y"])) for p in vertices] == points,
                      "published vertex list differs")
        for vertex in vertices:
            polygon.remove(vertex)
    h.require(ET.tostring(old) == ET.tostring(new), "unrelated HWPX content or properties changed")
    h.reopen(acc, path, row)
    select()
    count(4)


def inspect_saved_curve(fixture, path, before, target, expected, commands):
    want = {**target, "path": {**target["path"], "points": expected}}
    model = inspect(path)
    h.require(model == {**before, "frames": [want if item == target else item for item in before["frames"]]},
              "independent curve projection differs", model)
    gso = h.p6.gso
    streams = [gso.cfb_streams(item.read_bytes()) for item in (fixture, path)]
    ignored = {"BodyText/Section0", "PrvText", "PrvImage"}
    h.require({k: v for k, v in streams[0].items() if k not in ignored}
              == {k: v for k, v in streams[1].items() if k not in ignored}, "unrelated HWP streams changed")
    old, new = [gso.records(gso.unpacked(stream, "BodyText/Section0")) for stream in streams]
    changes = [(a, b) for a, b in zip(old, new, strict=True) if a != b]
    h.require(len(changes) == 1 and changes[0][0][:2] == changes[0][1][:2] == (83, 3),
              "non-curve records changed", changes)
    payload = changes[0][1][2]
    count = struct.unpack_from("<I", payload)[0]
    end = 4 + count * 8
    h.require(count == len(expected)
              and list(struct.iter_unpack("<ii", payload[4:end])) == [(p["x"], p["y"]) for p in expected]
              and payload[end:] == bytes(commands) + bytes(count - 1 - len(commands) + 4),
              "curve record count, points, segment bytes or four-byte padding differs")
    return h.digest(path)


def curve_terminal_line_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-curve-original.hwp"
    before = row["before"] = inspect(fixture)
    target = next(item for item in before["frames"] if item["path"] and item["path"]["kind"] == "curve")
    path = h.begin(acc, row, fixture, out, "a-p4-terminal-line.hwp")
    points = target["path"]["points"]
    appended = [*points, {"x":10600, "y":5500, "control":False}]
    removed = points[:-1]

    def select_end(length):
        h.select_object(acc, target, "shape")
        acc.dom_click(".object-path-mode")
        h.require(acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT) == length, "wrong curve point count")
        acc.dom_click(f"{POINT}:nth-of-type({length + 1})")

    select_end(5)
    h.p6.gso.replace(acc, COORDS + " label:first-of-type input", 10600)
    h.p6.gso.replace(acc, COORDS + " label:nth-of-type(2) input", 5500)
    acc.dom_click(".object-path-append-line")
    h.revision(acc, "hwp", 1)
    acc.key("Escape")
    append_row = row["append"] = {}
    h.publish(acc, "hwp", append_row)
    append_row["publishedSha256"] = inspect_saved_curve(fixture, path, before, target, appended, [1, 0, 0])
    h.reopen(acc, path, append_row)

    select_end(6)
    acc.dom_click(".object-path-remove-line")
    h.revision(acc, "hwp", 1)
    acc.dom_click(f"{POINT}:nth-of-type(6)")
    acc.dom_click(".object-path-remove-line")
    h.revision(acc, "hwp", 2)
    acc.dom_click(f"{POINT}:nth-of-type(5)")
    h.require(acc.d.js("return document.querySelector('.object-path-remove-line').disabled"),
              "cannot remove the remaining cubic command")
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 3)
    select_end(5)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 4)
    select_end(4)
    acc.key("Escape")
    h.publish(acc, "hwp", row)
    row["publishedSha256"] = inspect_saved_curve(fixture, path, before, target, removed, [1])
    h.reopen(acc, path, row)
    select_end(4)
    h.require(acc.d.js("return document.querySelector('.object-path-remove-line').disabled"),
              "reopened endpoint still offers an invalid removal")


def curve_interior_line_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-curve-interior-original.hwp"
    before = row["before"] = inspect(fixture)
    target = next(item for item in before["frames"] if item["path"] and item["path"]["kind"] == "curve")
    path = h.begin(acc, row, fixture, out, "a-p4-interior-line.hwp")
    points = target["path"]["points"]
    split = [*points[:4], {"x": 9050, "y": 5000, "control": False}, *points[4:]]
    split_button, join_button = ".object-path-split-line", ".object-path-join-lines"

    def count(expected):
        h.require(acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT) == expected,
                  "wrong curve point count", expected)

    def enter(expected):
        h.select_object(acc, target, "shape")
        acc.dom_click(".object-path-mode")
        count(expected)

    def select_point(index):
        acc.dom_click(f"{POINT}:nth-of-type({index + 2})")

    enter(8)
    h.require(not acc.d.exists(split_button), "split offered for a cubic")
    select_point(3)
    acc.dom_click(split_button)
    h.revision(acc, "hwp", 1)
    count(9)
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    enter(8)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    enter(9)
    select_point(4)
    h.require(acc.d.exists(join_button), "inserted point is not an interior line vertex")
    acc.key("Escape")
    split_row = row["split"] = {}
    h.publish(acc, "hwp", split_row)
    split_row["publishedSha256"] = inspect_saved_curve(fixture, path, before, target, split, [1, 0, 0, 1])
    split_file = out / "a-p4-interior-line-split.hwp"
    shutil.copyfile(path, split_file)
    h.reopen(acc, path, split_row)

    enter(9)
    select_point(4)
    acc.dom_click(join_button)
    h.revision(acc, "hwp", 1)
    count(8)
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    enter(9)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    enter(8)
    acc.key("Escape")
    h.publish(acc, "hwp", row)
    row["publishedSha256"] = inspect_saved_curve(split_file, path, before, target, points, [1, 0, 1])
    h.reopen(acc, path, row)
    enter(8)


def curve_cubic_segment_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-curve-interior-original.hwp"
    before = row["before"] = inspect(fixture)
    target = next(item for item in before["frames"] if item["path"] and item["path"]["kind"] == "curve")
    points = target["path"]["points"]
    h.require(len(points) == 8 and [point["control"] for point in points] ==
              [False, True, True, False, False, True, True, False], "unexpected cubic-line-cubic fixture", points)

    control_row = row["noncollinearControl"] = {}
    control_path = h.begin(acc, control_row, fixture, out, "a-p4-cubic-control.hwp")
    h.select_object(acc, target, "shape")
    acc.dom_click(".object-path-mode")
    acc.dom_click(f"{POINT}:nth-of-type(3)")
    h.p6.gso.replace(acc, COORDS + " > label:nth-of-type(1) input", 3001)
    h.p6.gso.replace(acc, COORDS + " > label:nth-of-type(2) input", 1402)
    acc.dom_click(COORDS + " > button[type=submit]")
    h.revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    h.select_object(acc, target, "shape")
    acc.dom_click(".object-path-mode")
    acc.dom_click(f"{POINT}:nth-of-type(3)")
    control_row["undoControlSelection"] = acc.d.js("""
      return {
        values: [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value),
        selected: [...document.querySelectorAll(arguments[1])].map((e,i)=>e.getAttribute('aria-pressed')==='true'?i:null).filter(i=>i!==null),
        labels: [...document.querySelectorAll(arguments[1])].map(e=>e.getAttribute('aria-label')),
        target: document.querySelector(arguments[1]+':nth-of-type(3)')?.getAttribute('aria-label')
      }
    """, COORDS, POINT)
    h.require(control_row["undoControlSelection"]["values"][:2] == [2500, 1000],
              "Undo did not restore the original cubic control", control_row["undoControlSelection"])
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    h.select_object(acc, target, "shape")
    acc.dom_click(".object-path-mode")
    acc.dom_click(f"{POINT}:nth-of-type(3)")
    expected_control = [dict(point) for point in points]
    expected_control[1] = {"x": 3001, "y": 1402, "control": True}
    control_row["redoControlSelection"] = acc.d.js("""
      return [...document.querySelectorAll(arguments[0]+' input')].slice(0,2).map(e=>+e.value)
    """, COORDS)
    h.require(control_row["redoControlSelection"] == [3001, 1402],
              "Redo did not restore the noncollinear cubic control", control_row["redoControlSelection"])
    acc.key("Escape")
    h.publish(acc, "hwp", control_row)
    control_row["publishedSha256"] = inspect_saved_curve(
        fixture, control_path, before, target, expected_control, [1, 0, 1])
    h.reopen(acc, control_path, control_row)
    expected_control_model = {**before, "frames": [
        {**target, "path": {**target["path"], "points": expected_control}}
        if item == target else item for item in before["frames"]]}
    h.require(inspect(control_path) == expected_control_model,
              "noncollinear control point did not reopen", inspect(control_path))

    path = h.begin(acc, row, fixture, out, "a-p4-cubic-inserted.hwp")
    h.select_object(acc, target, "shape")
    acc.dom_click(".object-path-mode")
    count = lambda expected: h.require(
        acc.d.js("return document.querySelectorAll(arguments[0]).length", POINT) == expected,
        "unexpected cubic point count", expected)
    count(8)
    acc.d.js("""
      window.hwp5CubicActions=[];
      document.addEventListener('click',e=>{
        if(e.target.matches('.object-path-insert-cubic,.object-path-remove-cubic'))
          window.hwp5CubicActions.push({action:e.target.className,trusted:e.isTrusted});
      },true);
    """)
    acc.dom_click(f"{POINT}:nth-of-type(5)")
    for index, value in enumerate([8500, 6600, 9300, 6600, 10400, 5400], 1):
        h.p6.gso.replace(acc, f".object-path-cubic-actions label:nth-of-type({index}) input", value)
    added = [*points[:4],
             {"x": 8500, "y": 6600, "control": True}, {"x": 9300, "y": 6600, "control": True},
             {"x": 10400, "y": 5400, "control": False}, *points[4:]]
    acc.dom_click(".object-path-insert-cubic")
    h.revision(acc, "hwp", 1)
    count(11)
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    h.select_object(acc, target, "shape")
    acc.dom_click(".object-path-mode")
    count(8)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    h.select_object(acc, target, "shape")
    acc.dom_click(".object-path-mode")
    count(11)
    acc.key("Escape")
    insert_row = row["insert"] = {}
    h.publish(acc, "hwp", insert_row)
    insert_row["publishedSha256"] = inspect_saved_curve(fixture, path, before, target, added, [1, 1, 0, 1])
    insert_row["trustedActions"] = acc.d.js("return window.hwp5CubicActions")
    h.require(insert_row["trustedActions"] == [
        {"action": "object-path-insert-cubic", "trusted": True}],
        "cubic insertion did not come from trusted native input", insert_row["trustedActions"])

    inserted_snapshot = out / "a-p4-cubic-inserted-baseline.hwp"
    shutil.copyfile(path, inserted_snapshot)
    inserted_before = inspect(inserted_snapshot)
    inserted_target = next(item for item in inserted_before["frames"] if item["path"] and item["path"]["kind"] == "curve")
    h.reopen(acc, path, insert_row)
    h.select_object(acc, inserted_target, "shape")
    acc.dom_click(".object-path-mode")
    acc.d.js("window.hwp5CubicActions=[]")
    count(11)
    acc.dom_click(f"{POINT}:nth-of-type(6)")
    acc.dom_click(".object-path-remove-cubic")
    h.revision(acc, "hwp", 1)
    count(8)
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    h.select_object(acc, inserted_target, "shape")
    acc.dom_click(".object-path-mode")
    count(11)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    h.select_object(acc, inserted_target, "shape")
    acc.dom_click(".object-path-mode")
    count(8)
    acc.key("Escape")
    remove_row = row["remove"] = {}
    h.publish(acc, "hwp", remove_row)
    remove_row["publishedSha256"] = inspect_saved_curve(
        inserted_snapshot, path, inserted_before, inserted_target, points, [1, 0, 1])
    remove_row["trustedActions"] = acc.d.js("return window.hwp5CubicActions")
    h.require(remove_row["trustedActions"] == [
        {"action": "object-path-remove-cubic", "trusted": True}],
        "cubic removal did not come from trusted native input", remove_row["trustedActions"])
    h.reopen(acc, path, remove_row)
    h.require(inspect(path) == before, "cubic removal did not restore original geometry and owner", inspect(path))


def group_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-group-original.hwpx"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["children"])
    path = h.begin(acc, row, fixture, out, "a-p4-group-edited.hwpx")
    fill = GROUP + " input"
    original = target["children"][1]["color"].to_bytes(3, "little").hex().upper()
    chosen = "882244"

    def choose():
        h.select_object(acc, target, "group")
        acc.dom_click(GROUP + " summary")
        acc.d.click(GROUP + " option[value='1']")
        acc.wait("return !!document.querySelector(arguments[0])", fill)
        return h.p6.value(acc, fill)

    initial = choose()
    h.require(initial == original, "did not select the intended group child", initial)
    h.p6.gso.replace(acc, fill, "123")
    h.require(acc.d.js("return document.querySelector(arguments[0]).disabled", GROUP + " button"),
              "invalid fill should disable the command")
    h.revision(acc, "hwpx", 0)
    h.p6.gso.replace(acc, fill, chosen)
    acc.dom_click(GROUP + " button")
    h.revision(acc, "hwpx", 1)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    h.require(choose() == original, "Undo restored the wrong child fill")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    h.require(choose() == chosen, "Redo restored the wrong child fill")
    h.publish(acc, "hwpx", row)

    after = row["after"] = inspect(path)
    color = int.from_bytes(bytes.fromhex(chosen), "little")
    expected = {**target, "children": [target["children"][0], {**target["children"][1], "color": color}]}
    h.require(after == {**before,"frames":[expected if item == target else item for item in before["frames"]]},
              "group transform, owner or sibling changed", after)
    old, new = section_pair(fixture, path)
    old_color = old.find(".//{*}container/{*}ellipse/{*}fillBrush/{*}winBrush")
    new_color = new.find(".//{*}container/{*}ellipse/{*}fillBrush/{*}winBrush")
    h.require(old_color is not None and new_color is not None, "expected solid ellipse fill")
    h.require(new_color.attrib["faceColor"].upper() == "#" + chosen, "raw ellipse fill differs", new_color.attrib)
    old_color.attrib["faceColor"] = new_color.attrib["faceColor"]
    h.require(ET.tostring(old) == ET.tostring(new), "unrelated group or document XML changed")
    h.reopen(acc, path, row)
    h.require(choose() == chosen, "published group child did not reopen in app")


def group_child_edit_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-group-original.hwpx"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["groupChildren"])
    gc = target["groupChildren"]
    rect0, ell0 = gc["children"]
    path = h.begin(acc, row, fixture, out, "a-p4-group-child-edited.hwpx")
    CHILD = ".object-group-child"
    HANDLE = ".object-group-child-handle"
    CCOORDS = ".object-group-child-coordinates"

    def enter_mode(child_idx=0):
        h.select_object(acc, target, "group")
        acc.dom_click(".object-group-child-mode")
        acc.wait("return document.querySelectorAll(arguments[0]).length===2", CHILD)
        h.require(acc.d.js("return document.querySelectorAll('[data-testid^=object-handle-]').length") == 0,
                  "outer resize handles remained active in child edit mode")
        acc.dom_click(f"{CHILD}[data-index='{child_idx}']")

    def ui_vals():
        return acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", CCOORDS)

    enter_mode(0)
    h.require(ui_vals() == [rect0["x"], rect0["y"], rect0["width"], rect0["height"]], "initial rect child coords mismatch")
    handles = acc.d.js("return [...document.querySelectorAll(arguments[0])].map(e=>e.dataset.handle)", HANDLE)
    h.require(handles == ["e", "se", "s"], "expected left/top-anchored child resize handles only", handles)

    # Trusted pointer drag to move child 0 rectangle
    acc.d.js("""
      window.p46Move=[];
      for (const type of ['pointerdown', 'pointerup']) document.addEventListener(type, e => {
        if (e.target.closest?.('.object-group-child')) window.p46Move.push({type, x:e.clientX, y:e.clientY, trusted:e.isTrusted});
      }, true);
    """)
    rx0, ry0 = acc.d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2];",
                        f"{CHILD}[data-index='0']")
    frame = h.frame(acc)
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (rx0*sx, ry0*sy), ((rx0+10)*sx, (ry0+7)*sy))
    h.revision(acc, "hwpx", 1)
    mev = row["movePointer"] = acc.d.js("return window.p46Move")
    h.require(len(mev) == 2 and all(e["trusted"] for e in mev), "missing trusted child move pointer events", mev)
    moved_rx = min(gc["width"] - rect0["width"], max(0, round(rect0["x"] + (mev[1]["x"] - mev[0]["x"]) * gc["width"] / frame["width"])))
    moved_ry = min(gc["height"] - rect0["height"], max(0, round(rect0["y"] + (mev[1]["y"] - mev[0]["y"]) * gc["height"] / frame["height"])))
    h.require(ui_vals() == [moved_rx, moved_ry, rect0["width"], rect0["height"]], "pointer move mismatch", ui_vals())

    # Undo & Redo
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    enter_mode(0)
    h.require(ui_vals() == [rect0["x"], rect0["y"], rect0["width"], rect0["height"]], "Undo did not restore rect pos")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    enter_mode(0)
    h.require(ui_vals() == [moved_rx, moved_ry, rect0["width"], rect0["height"]], "Redo did not restore rect pos")

    # Trusted pointer drag on SE handle to shrink rectangle (left/top anchored)
    acc.d.js("""
      window.p46Resize=[];
      for (const type of ['pointerdown', 'pointerup']) document.addEventListener(type, e => {
        if (e.target.closest?.('.object-group-child-handle')) window.p46Resize.push({type, x:e.clientX, y:e.clientY, trusted:e.isTrusted});
      }, true);
    """)
    hx0, hy0 = acc.d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2];",
                        f"{HANDLE}[data-handle='se']")
    h.p4.rhwp_poc.drag(acc.d, (hx0*sx, hy0*sy), ((hx0-9)*sx, (hy0-6)*sy))
    h.revision(acc, "hwpx", 4)
    rev_ev = row["resizePointer"] = acc.d.js("return window.p46Resize")
    h.require(len(rev_ev) == 2 and all(e["trusted"] for e in rev_ev), "missing trusted resize handle events", rev_ev)
    resized_rw = min(gc["width"] - moved_rx, max(1, round(rect0["width"] + (rev_ev[1]["x"] - rev_ev[0]["x"]) * gc["width"] / frame["width"])))
    resized_rh = min(gc["height"] - moved_ry, max(1, round(rect0["height"] + (rev_ev[1]["y"] - rev_ev[0]["y"]) * gc["height"] / frame["height"])))
    h.require(ui_vals() == [moved_rx, moved_ry, resized_rw, resized_rh], "pointer resize mismatch", ui_vals())

    # Precision move + resize on child 1 ellipse
    acc.dom_click(f"{CHILD}[data-index='1']")
    h.require(ui_vals() == [ell0["x"], ell0["y"], ell0["width"], ell0["height"]], "initial ellipse coords mismatch")
    h.p6.gso.replace(acc, f"{CCOORDS} label:nth-of-type(1) input", 5200)
    h.p6.gso.replace(acc, f"{CCOORDS} label:nth-of-type(2) input", 200)
    acc.dom_click(".object-group-child-apply-move")
    h.revision(acc, "hwpx", 5)
    h.p6.gso.replace(acc, f"{CCOORDS} label:nth-of-type(3) input", 4600)
    h.p6.gso.replace(acc, f"{CCOORDS} label:nth-of-type(4) input", 3200)
    acc.dom_click(".object-group-child-apply-resize")
    h.revision(acc, "hwpx", 6)
    h.require(ui_vals() == [5200, 200, 4600, 3200], "precision edit mismatch", ui_vals())

    acc.key("Escape")
    h.require(not acc.d.exists(CHILD), "Escape did not exit group child editing")
    h.publish(acc, "hwpx", row)

    after = row["after"] = inspect(path)
    want_gc = {
        **gc,
        "children": [
            {**rect0, "x": moved_rx, "y": moved_ry, "width": resized_rw, "height": resized_rh},
            {**ell0, "x": 5200, "y": 200, "width": 4600, "height": 3200},
        ],
    }
    want = {**target, "groupChildren": want_gc}
    h.require(after == {**before, "frames": [want if item == target else item for item in before["frames"]]},
              "published group model differs from expected", after)
    old, new = section_pair(fixture, path)
    old_c = old.find(".//{*}container")
    new_c = new.find(".//{*}container")
    h.require(old_c is not None and new_c is not None and old_c.attrib == new_c.attrib, "parent container attributes changed")
    new_r, new_e = new_c.find("{*}rect"), new_c.find("{*}ellipse")
    h.require(new_r.find("{*}offset").attrib == {"x": str(moved_rx), "y": str(moved_ry)}, "saved rect offset differs")
    h.require(new_r.find("{*}orgSz").attrib == {"width": str(resized_rw), "height": str(resized_rh)}, "saved rect orgSz differs")
    h.require(new_e.find("{*}offset").attrib == {"x": "5200", "y": "200"}, "saved ellipse offset differs")
    h.require(new_e.find("{*}orgSz").attrib == {"width": "4600", "height": "3200"}, "saved ellipse orgSz differs")

    h.reopen(acc, path, row)
    enter_mode(0)
    h.require(ui_vals() == [moved_rx, moved_ry, resized_rw, resized_rh], "reopened rect differs")
    acc.dom_click(f"{CHILD}[data-index='1']")
    h.require(ui_vals() == [5200, 200, 4600, 3200], "reopened ellipse differs")


def nested_group_edit_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-hx-nest-original.hwpx"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["groupChildren"])
    group = target["groupChildren"]
    red, green, blue = group["children"]
    h.require(len(group["children"]) == 3 and len(red.get("path", [])) == 2,
              "fixture does not expose a nested leaf and direct sibling", group)
    h.require([red[key] for key in ("x", "y", "width", "height")] == [1400, 0, 1200, 800],
              "fixture nested leaf has unexpected local bounds", red)
    path = h.begin(acc, row, fixture, out, "a-p4-hx-nest-edited.hwpx")
    CHILD = ".object-group-child"
    COORDS = ".object-group-child-coordinates"

    acc.d.js("""
      window.hxNestPointer=[];
      window.hxNestKeys=[];
      for(const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
        if(e.target.closest('.object-group-child')) window.hxNestPointer.push({type,trusted:e.isTrusted});
      },true);
      addEventListener('keydown',e=>{
        if(e.target.closest('.object-group-child-coordinates')) window.hxNestKeys.push({key:e.key,trusted:e.isTrusted});
      },true);
    """)

    def enter_child(index=0):
        h.select_object(acc, target, "group")
        if acc.d.js("return document.querySelector('.object-group-child-mode')?.getAttribute('aria-pressed')!=='true'"):
            acc.dom_click(".object-group-child-mode")
        state = acc.d.js("""
          const mode=document.querySelector('.object-group-child-mode');
          return {pressed:mode?.getAttribute('aria-pressed'),children:document.querySelectorAll(arguments[0]).length,
            selected:document.querySelector('.object-selection-frame')?.dataset.objectKind,
            frames:[...document.querySelectorAll('.object-selection-frame')].length,
            panel:document.querySelector('[aria-labelledby=properties-selection]')?.innerText.slice(0,400)};
        """, CHILD)
        row["lastChildModeState"] = state
        h.require(state["pressed"] == "true" and state["children"] == 3,
                  "nested group child mode did not expose all descendants", state)
        acc.dom_click(f"{CHILD}[data-index='{index}']")

    def values():
        return acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>Number(e.value))", COORDS)

    def replace(field, value):
        selector = f"{COORDS} label:nth-of-type({field}) input"
        h.p6.gso.replace(acc, selector, value)
        acc.wait("return Number(document.querySelector(arguments[0])?.value)===arguments[1]", selector, value)

    enter_child()
    h.require(values() == [1400, 0, 1200, 800], "nested leaf initial coordinates differ", values())
    replace(1, 1600)
    acc.dom_click(".object-group-child-apply-move")
    h.revision(acc, "hwpx", 1)
    enter_child()
    h.require(values() == [1600, 0, 1200, 800], "nested leaf move did not update its local coordinates", values())
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    enter_child()
    h.require(values() == [1400, 0, 1200, 800], "nested move Undo differs", values())
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    enter_child()
    h.require(values() == [1600, 0, 1200, 800], "nested move Redo differs", values())

    replace(3, 1000)
    replace(4, 700)
    acc.dom_click(".object-group-child-apply-resize")
    h.revision(acc, "hwpx", 4)
    enter_child()
    h.require(values() == [1600, 0, 1000, 700], "nested leaf resize did not update its coordinates", values())
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 5)
    enter_child()
    h.require(values() == [1600, 0, 1200, 800], "nested resize Undo differs", values())
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 6)
    enter_child()
    h.require(values() == [1600, 0, 1000, 700], "nested resize Redo differs", values())
    acc.key("Escape")
    h.require(not acc.d.exists(CHILD), "Escape did not leave nested child editing")

    row["trustedPointer"] = acc.d.js("return window.hxNestPointer")
    row["trustedKeys"] = acc.d.js("return window.hxNestKeys")
    h.require(row["trustedPointer"] and all(event["trusted"] for event in row["trustedPointer"]),
              "nested child actions did not use trusted native pointer events", row["trustedPointer"])
    h.require(row["trustedKeys"] and all(event["trusted"] for event in row["trustedKeys"]),
              "nested child coordinates did not use trusted native keyboard events", row["trustedKeys"])
    h.publish(acc, "hwpx", row)

    after = row["after"] = inspect(path)
    want_group = {**group, "children": [
        {**red, "x": 1600, "y": 0, "width": 1000, "height": 700}, green, blue,
    ]}
    want = {**target, "groupChildren": want_group}
    h.require(after == {**before, "frames": [want if item == target else item for item in before["frames"]]},
              "saved nested edit changed another object or group owner", after)

    old, new = section_pair(fixture, path)
    old_root, new_root = old.find(".//{*}container"), new.find(".//{*}container")
    old_inner = old_root.find("{*}container") if old_root is not None else None
    new_inner = new_root.find("{*}container") if new_root is not None else None
    h.require(old_root is not None and old_inner is not None and new_root is not None and new_inner is not None,
              "nested container tree was not serialized")
    h.require(new_root.attrib == old_root.attrib and new_inner.attrib == old_inner.attrib,
              "container identity or hierarchy metadata changed")
    h.require(new_inner.attrib.get("id") == "7001" and new_inner.attrib.get("instid") == "8001"
              and new_inner.attrib.get("groupLevel") == "1", "inner group identity or level changed", new_inner.attrib)
    h.require(new_root.attrib.get("id") == "9001" and new_root.attrib.get("instid") == "9101"
              and new_root.attrib.get("groupLevel") == "0", "outer group identity or level changed", new_root.attrib)
    new_red = next(child for child in list(new_inner) if child.tag.endswith("rect") and child.get("id") == str(red["id"]))
    new_green = next(child for child in list(new_inner) if child.tag.endswith("rect") and child.get("id") == str(green["id"]))
    new_blue = next(child for child in list(new_root) if child.tag.endswith("rect") and child.get("id") == str(blue["id"]))
    old_red = next(child for child in list(old_inner) if child.tag.endswith("rect") and child.get("id") == str(red["id"]))
    old_green = next(child for child in list(old_inner) if child.tag.endswith("rect") and child.get("id") == str(green["id"]))
    old_blue = next(child for child in list(old_root) if child.tag.endswith("rect") and child.get("id") == str(blue["id"]))
    h.require(ET.tostring(new_green) == ET.tostring(old_green) and ET.tostring(new_blue) == ET.tostring(old_blue),
              "unrelated nested or direct sibling geometry changed")
    offset = new_red.find("{*}offset")
    h.require(offset is not None and offset.attrib == {"x": "200", "y": "0"}, "nested local offset differs", offset.attrib if offset is not None else None)
    for name in ("orgSz", "curSz", "sz"):
        old_size = old_red.find("{*}" + name)
        size = new_red.find("{*}" + name)
        expected_size = {**old_size.attrib, "width": "1000", "height": "700"} if old_size is not None else None
        h.require(size is not None and expected_size is not None and size.attrib == expected_size,
                  "saved nested dimensions or size metadata differ", {"name": name, "expected": expected_size,
                  "attrs": size.attrib if size is not None else None})
    row["unchangedPackageEntries"] = True
    h.reopen(acc, path, row)
    enter_child()
    h.require(values() == [1600, 0, 1000, 700], "reopened nested leaf geometry differs", values())


def group_transform_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-group-transform-original.hwpx"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["groupChildren"])
    group = target["groupChildren"]
    rect, sibling = group["children"]
    h.require([rect[key] for key in ("x", "y", "width", "height")] == [200, 100, 2600, 2050],
              "fixture did not expose the expected transformed display bounds", rect)
    path = h.begin(acc, row, fixture, out, "a-p4-group-transform-edited.hwpx")
    CHILD = ".object-group-child"
    COORDS = ".object-group-child-coordinates"

    def enter_mode():
        h.select_object(acc, target, "group")
        acc.dom_click(".object-group-child-mode")
        acc.wait("return document.querySelectorAll(arguments[0]).length===2", CHILD)
        acc.dom_click(f"{CHILD}[data-index='0']")

    def ui_values():
        return acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", COORDS)

    enter_mode()
    h.require(ui_values() == [200, 100, 2600, 2050], "scaled child displayed incorrect edit bounds", ui_values())

    # Move in display coordinates; the engine must update only the original translation matrix.
    h.p6.gso.replace(acc, f"{COORDS} label:nth-of-type(1) input", 400)
    h.p6.gso.replace(acc, f"{COORDS} label:nth-of-type(2) input", 300)
    acc.dom_click(".object-group-child-apply-move")
    h.revision(acc, "hwpx", 1)
    h.require(ui_values() == [400, 300, 2600, 2050], "scaled child move did not use displayed coordinates", ui_values())
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    enter_mode()
    h.require(ui_values() == [200, 100, 2600, 2050], "Undo did not restore transformed child position", ui_values())
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    enter_mode()
    h.require(ui_values() == [400, 300, 2600, 2050], "Redo did not restore transformed child position", ui_values())

    # Resize in display coordinates and verify inverse mapping to the local rectangle dimensions.
    h.p6.gso.replace(acc, f"{COORDS} label:nth-of-type(3) input", 3000)
    h.p6.gso.replace(acc, f"{COORDS} label:nth-of-type(4) input", 2500)
    acc.dom_click(".object-group-child-apply-resize")
    h.revision(acc, "hwpx", 4)
    h.require(ui_values() == [400, 300, 3000, 2500], "scaled child resize did not use displayed coordinates", ui_values())

    acc.key("Escape")
    h.require(not acc.d.exists(CHILD), "Escape did not exit transformed group child editing")
    h.publish(acc, "hwpx", row)

    after = row["after"] = inspect(path)
    want_group = {**group, "children": [
        {**rect, "x": 400, "y": 300, "width": 3000, "height": 2500}, sibling,
    ]}
    expected_target = {**target, "groupChildren": want_group}
    h.require(after == {**before, "frames": [expected_target if item == target else item for item in before["frames"]]},
              "saved transformed child owner, geometry, sibling, or surrounding document changed", after)

    old, new = section_pair(fixture, path)
    old_group, new_group = old.find(".//{*}container"), new.find(".//{*}container")
    h.require(old_group is not None and new_group is not None and old_group.attrib == new_group.attrib,
              "parent group attributes changed")
    old_rect, new_rect = old_group.find("{*}rect"), new_group.find("{*}rect")
    h.require(old_rect is not None and new_rect is not None, "transformed rectangle disappeared")
    old_rect.find("{*}offset").attrib.update(x="400", y="300")
    for name in ("orgSz", "curSz", "sz"):
        old_rect.find("{*}" + name).attrib.update(width="6000", height="5000")
    old_rect.find("{*}rotationInfo").attrib.update(centerX="3000", centerY="2500")
    old_points = [old_rect.find("{*}pt" + str(index)) for index in range(4)]
    h.require(all(point is not None for point in old_points), "unexpected rectangle point representation")
    for point, (x, y) in zip(old_points, ((0, 0), (6000, 0), (6000, 5000), (0, 5000)), strict=True):
        point.attrib.update(x=str(x), y=str(y))
    old_rect.find("{*}sz").attrib.update(width="6000", height="5000")
    old_rect.find("{*}pos").attrib.update(horzOffset="400", vertOffset="300")
    old_translation = old_rect.find("{*}renderingInfo/{*}transMatrix")
    new_translation = new_rect.find("{*}renderingInfo/{*}transMatrix")
    h.require(old_translation is not None and new_translation is not None, "translation matrix disappeared")
    old_translation.attrib.update(e3="400", e6="300")
    h.require(ET.tostring(old) == ET.tostring(new),
              "saved XML changed transform semantics, segment data, sibling, or unrelated section structure")
    h.reopen(acc, path, row)


def group_child_capture_case(acc, row, fixtures, out):
    fixture = fixtures / "a-p4-group-original.hwpx"
    before = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["groupChildren"])
    group = target["groupChildren"]
    rect, sibling = group["children"]
    path = h.begin(acc, row, fixture, out, "a-p4-group-child-capture.hwpx")
    child = ".object-group-child[data-index='0']"
    handle = ".object-group-child-handle[data-handle='se']"
    inputs = ".object-group-child-coordinates input"
    initial = [rect[key] for key in ("x", "y", "width", "height")]

    def select_rect():
        h.select_object(acc, target, "group")
        if not acc.d.exists(child):
            acc.dom_click(".object-group-child-mode")
        acc.dom_click(child)
        acc.wait("return !!document.querySelector(arguments[0])", handle)

    def values():
        return acc.d.js("return [...document.querySelectorAll(arguments[0])].map(e=>+e.value)", inputs)

    select_rect()
    h.require(values() == initial, "wrong initial rectangle", values())
    frame = h.frame(acc)
    sx, sy = acc.d.pointer_scale
    acc.d.js("""
      const selector = arguments[0];
      window.p46Capture = [];
      for (const type of ['pointerdown','gotpointercapture','pointermove','pointerup','lostpointercapture']) {
        document.addEventListener(type, e => {
          const handle = document.querySelector(selector);
          const tracked = e.target === handle;
          if (!tracked && !window.p46Capture.some(p => p.type === 'pointerdown' && p.id === e.pointerId)) return;
          window.p46Capture.push({type, id:e.pointerId, x:e.clientX, y:e.clientY, buttons:e.buttons,
            trusted:e.isTrusted, handle:tracked, hit:document.elementFromPoint(e.clientX,e.clientY) === handle,
            captured:handle?.hasPointerCapture(e.pointerId) ?? false});
        }, true);
      }
    """, handle)

    def move(x, y):
        return {"type": "pointerMove", "x": int(x * sx), "y": int(y * sy),
                "origin": "viewport", "duration": 75}

    def pointer(*actions):
        acc.d.call("POST", "/actions", {"actions": [{
            "type": "pointer", "id": "p46-capture", "parameters": {"pointerType": "mouse"},
            "actions": list(actions),
        }]})

    def drag(evidence, lose_capture=False):
        acc.d.js("window.p46Capture.length = 0")
        x, y = acc.d.js("""
          const r = document.querySelector(arguments[0]).getBoundingClientRect();
          return [r.x+r.width/2, r.y+r.height/2];
        """, handle)
        # Overshoot the parent height so the clamped preview handle cannot follow the pointer.
        delta_y = frame["height"] * (group["height"] - rect["height"] - rect["y"]) / group["height"] + 24
        end_x, end_y = x - 24, y + delta_y
        try:
            pointer(move(x, y), {"type": "pointerDown", "button": 0}, move(end_x, end_y))
            acc.wait("""return window.p46Capture.some(e =>
                e.type === 'pointermove' && e.buttons === 1 && e.trusted && e.handle && e.captured && !e.hit)""")
            if lose_capture:
                # Ask WebKit to end the live capture while the real mouse button is still down.
                # The browser dispatches lostpointercapture itself.
                acc.d.js("""
                  const down = window.p46Capture.find(e => e.type === 'pointerdown');
                  document.querySelector(arguments[0]).releasePointerCapture(down.id);
                """, handle)
                pointer(move(end_x - 2, end_y))
                before_up = acc.d.js("return window.p46Capture")
                row["captureLossBeforeUp"] = before_up
                h.require(not any(e["type"] == "pointerup" for e in before_up)
                          and any(e["type"] == "lostpointercapture" and e["trusted"] and e["handle"] for e in before_up)
                          and any(e["type"] == "pointermove" and e["trusted"] and e["buttons"] == 1
                                  and not e["captured"] and not e["handle"] for e in before_up),
                          "WebKit did not end capture while the pointer was still down", before_up)
            pointer({"type": "pointerUp", "button": 0})
        finally:
            try:
                row[evidence] = acc.d.js("return window.p46Capture")
            finally:
                acc.d.call("DELETE", "/actions")

    drag("captureLoss", lose_capture=True)
    acc.settle("hwpx")
    h.require(acc.status("hwpx")["revision"] == row["initialSession"]["revision"] and values() == initial,
              "capture loss committed a resize", acc.status("hwpx"))

    drag("capturedDrag")
    events = row["capturedDrag"]
    down, = [e for e in events if e["type"] == "pointerdown"]
    up, = [e for e in events if e["type"] == "pointerup"]
    h.require(all(e["trusted"] and e["handle"] for e in (down, up)) and down["id"] == up["id"]
              and up["captured"] and not up["hit"], "trusted pointerup was not routed from off the handle", events)
    h.require(any(e["type"] == "gotpointercapture" and e["trusted"] and e["handle"] and e["id"] == down["id"]
                  for e in events), "WebKit did not establish capture", events)
    # JS Math.round for signed pointer deltas, including half ties.
    dx = math.floor((up["x"] - down["x"]) * group["width"] / frame["width"] + 0.5)
    dy = math.floor((up["y"] - down["y"]) * group["height"] / frame["height"] + 0.5)
    width = min(group["width"] - rect["x"], max(1, rect["width"] + dx))
    height = min(group["height"] - rect["y"], max(1, rect["height"] + dy))
    resized = row["expectedRect"] = [rect["x"], rect["y"], width, height]
    h.require(resized != initial, "pointer did not change the expected bounds", events)

    row["commit"] = h.revision(acc, "hwpx", 1)
    h.require(values() == resized and acc.d.exists(handle), "resize or selection mismatch", values())
    acc.key("ctrl+z")
    row["undo"] = h.revision(acc, "hwpx", 2)
    select_rect()
    h.require(values() == initial, "one Undo did not restore the original rectangle", values())
    acc.key("ctrl+y")
    row["redo"] = h.revision(acc, "hwpx", 3)
    select_rect()
    h.require(values() == resized, "Redo did not restore the resize", values())

    h.publish(acc, "hwpx", row)
    after = inspect(path)
    expected_group = {**group, "children": [{**rect, "width": width, "height": height}, sibling]}
    expected_frames = [{**target, "groupChildren": expected_group} if item == target else item for item in before["frames"]]
    h.require(after == {**before, "frames": expected_frames}, "independent reopen geometry changed unexpectedly", after)
    old, new = section_pair(fixture, path)
    old_c, new_c = old.find(".//{*}container"), new.find(".//{*}container")
    old_r, new_r = old_c.find("{*}rect"), new_c.find("{*}rect")
    for tag in ("orgSz", "curSz", "sz"):
        size = new_r.find("{*}" + tag).attrib
        h.require([int(size["width"]), int(size["height"])] == [width, height], "saved dimensions differ", size)
    h.require(old_r.find("{*}offset").attrib == new_r.find("{*}offset").attrib, "resize changed local anchor")
    old_c.remove(old_r)
    new_c.remove(new_r)
    h.require(ET.tostring(old_c) == ET.tostring(new_c), "parent or sibling XML changed")
    h.reopen(acc, path, row)
    select_rect()
    h.require(values() == resized, "published dimensions did not reopen in the app", values())


def hwp5_group_records(original, output, final_group):
    old_streams = hwp_records.cfb_streams(original.read_bytes())
    new_streams = hwp_records.cfb_streams(output.read_bytes())
    h.require(old_streams.keys() == new_streams.keys(), "HWP5 group edit changed CFB stream ownership")
    changed_streams = [name for name in sorted(old_streams) if old_streams[name] != new_streams[name]]
    h.require(set(changed_streams) <= {"BodyText/Section0", "PrvImage"}
              and "BodyText/Section0" in changed_streams,
              "HWP5 group edit changed unrelated streams", changed_streams)
    before = hwp_records.records(hwp_records.unpacked(old_streams, "BodyText/Section0"))
    after = hwp_records.records(hwp_records.unpacked(new_streams, "BodyText/Section0"))
    h.require(len(before) == len(after), "HWP5 group edit inserted or removed records", [len(before), len(after)])
    h.require([(tag, level) for tag, level, _ in before] == [(tag, level) for tag, level, _ in after],
              "HWP5 group edit changed record identity or order")
    containers = [i for i, (tag, level, data) in enumerate(before)
                  if tag == 76 and level == 2 and len(data) >= 12 and data[:4] == b"noc$"]
    h.require(len(containers) == 1, "fixture must have one owned HWP5 container", containers)
    group_at = containers[0]
    indexes = (group_at + 1, group_at + 2, group_at + 3, group_at + 4)
    h.require(indexes[-1] < len(before), "group children are truncated")
    expected_records = [(76, 3), (79, 4), (76, 3), (80, 4)]
    h.require([(before[i][0], before[i][1]) for i in indexes] == expected_records,
              "fixture group is outside the supported flat rectangle/ellipse shape", [before[i][:2] for i in indexes])
    h.require(before[group_at] == after[group_at], "parent container, ID table, or transforms changed")
    child0_sc_old, child0_leaf_old, child1_sc_old, child1_leaf_old = (before[i][2] for i in indexes)
    child0_sc_new, child0_leaf_new, child1_sc_new, child1_leaf_new = (after[i][2] for i in indexes)
    group_children = final_group["children"]
    for old_sc, new_sc, expected, allow_geometry in (
        (child0_sc_old, child0_sc_new, group_children[0], True),
        (child1_sc_old, child1_sc_new, group_children[1], False),
    ):
        h.require(len(old_sc) == len(new_sc) == 344, "unsupported child component envelope")
        h.require(old_sc[:4] == new_sc[:4] and old_sc[-6:-1] == new_sc[-6:-1],
                  "child identity or instance ID changed")
        allowed = [(305, 309)]
        if allow_geometry:
            allowed += [(4, 12), (16, 32), (64, 72), (88, 96)]
            x, y, width, height = (expected[k] for k in ("x", "y", "width", "height"))
            h.require(struct.unpack_from("<ii", new_sc, 4) == (x, y), "saved child offset differs")
            h.require(struct.unpack_from("<IIII", new_sc, 16) == (width, height, width, height),
                      "saved child dimensions differ")
            tx, ty = struct.unpack_from("<dd", new_sc, 64)[0], struct.unpack_from("<d", new_sc, 88)[0]
            h.require(math.isfinite(tx) and math.isfinite(ty) and tx == x and ty == y,
                      "saved local transform disagrees with child coordinates", [tx, ty, x, y])
        normalized = bytearray(old_sc)
        for start, end in allowed:
            normalized[start:end] = new_sc[start:end]
        h.require(bytes(normalized) == new_sc, "unapproved child component bytes changed")
    rect = group_children[0]
    expected_vertices = (0, 0, rect["width"], 0, rect["width"], rect["height"], 0, rect["height"])
    h.require(len(child0_leaf_new) == 33 and struct.unpack_from("<8i", child0_leaf_new, 1) == expected_vertices,
              "saved rectangle leaf geometry differs", child0_leaf_new.hex())
    h.require(child1_leaf_old == child1_leaf_new, "unaffected ellipse leaf changed")
    changed_records = [i for i, (old, new) in enumerate(zip(before, after, strict=True)) if old != new]
    h.require(set(changed_records) <= set(indexes) and changed_records,
              "records outside the two owned child components changed", changed_records)
    return {"changedStreams": changed_streams, "changedRecordIndexes": changed_records,
            "containerRecordIndex": group_at, "childRecordIndexes": list(indexes)}


def hwp5_group_child_edit_case(acc, row, fixtures, out):
    fixture = fixtures / "p4-h5-group-original.hwp"
    before = row["before"] = inspect(fixture)
    target, = [frame for frame in before["frames"] if frame["groupChildren"]]
    group = target["groupChildren"]
    rect0, ellipse0 = group["children"]
    path = h.begin(acc, row, fixture, out, "p4-h5-group-edited.hwp")
    CHILD = ".object-group-child"
    HANDLE = ".object-group-child-handle"
    CCOORDS = ".object-group-child-coordinates"

    def enter_mode(child_idx=0):
        h.select_object(acc, target, "group")
        acc.dom_click(".object-group-child-mode")
        acc.wait("return document.querySelectorAll(arguments[0]).length===2", CHILD)
        h.require(acc.d.js("return document.querySelectorAll('[data-testid^=object-handle-]').length") == 0,
                  "outer group resize handles remained active")
        acc.dom_click(f"{CHILD}[data-index='{child_idx}']")

    def ui_values():
        return acc.d.js("return [...document.querySelectorAll(arguments[0]+' input')].map(e=>+e.value)", CCOORDS)

    enter_mode(0)
    h.require(ui_values() == [rect0["x"], rect0["y"], rect0["width"], rect0["height"]],
              "initial HWP5 rectangle child coordinates differ", ui_values())
    h.require([e for e in acc.d.js("return [...document.querySelectorAll(arguments[0])].map(e=>e.dataset.handle)", HANDLE)]
              == ["e", "se", "s"], "expected safe left/top-anchored resize handles")
    acc.d.js("""
      window.hwp5GroupMove=[];
      for (const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
        if (e.target.closest?.('.object-group-child')) window.hwp5GroupMove.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      },true);
    """)
    x0, y0 = acc.d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2];",
                      f"{CHILD}[data-index='0']")
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x0*sx,y0*sy), ((x0+10)*sx,y0*sy))
    h.revision(acc, "hwp", 1)
    move_events = row["movePointer"] = acc.d.js("return window.hwp5GroupMove")
    h.require(len(move_events)==2 and all(event["trusted"] for event in move_events),
              "HWP5 child movement did not use trusted native pointer input", move_events)
    frame = h.frame(acc)
    moved_x = min(group["width"]-rect0["width"], max(0, round(rect0["x"] +
        (move_events[1]["x"]-move_events[0]["x"])*group["width"]/frame["width"])))
    moved_y = rect0["y"]
    h.require(ui_values()==[moved_x,moved_y,rect0["width"],rect0["height"]],
              "trusted HWP5 child move differs", ui_values())
    acc.key("ctrl+z")
    h.revision(acc,"hwp",2)
    enter_mode(0)
    h.require(ui_values()==[rect0["x"],rect0["y"],rect0["width"],rect0["height"]], "move Undo differs")
    acc.key("ctrl+y")
    h.revision(acc,"hwp",3)
    enter_mode(0)
    h.require(ui_values()==[moved_x,moved_y,rect0["width"],rect0["height"]], "move Redo differs")

    acc.d.js("""
      window.hwp5GroupResize=[];
      for (const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
        if (e.target.closest?.('.object-group-child-handle')) window.hwp5GroupResize.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted});
      },true);
    """)
    hx, hy = acc.d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2];",
                      f"{HANDLE}[data-handle='se']")
    h.p4.rhwp_poc.drag(acc.d,(hx*sx,hy*sy),((hx-8)*sx,(hy-6)*sy))
    h.revision(acc,"hwp",4)
    resize_events = row["resizePointer"] = acc.d.js("return window.hwp5GroupResize")
    h.require(len(resize_events)==2 and all(event["trusted"] for event in resize_events),
              "HWP5 child resize did not use trusted native pointer input", resize_events)
    resized_width = min(group["width"]-moved_x, max(1,round(rect0["width"]+
        (resize_events[1]["x"]-resize_events[0]["x"])*group["width"]/frame["width"])))
    resized_height = min(group["height"]-moved_y, max(1,round(rect0["height"]+
        (resize_events[1]["y"]-resize_events[0]["y"])*group["height"]/frame["height"])))
    h.require(ui_values()==[moved_x,moved_y,resized_width,resized_height], "HWP5 child resize differs", ui_values())
    acc.key("ctrl+z")
    h.revision(acc,"hwp",5)
    enter_mode(0)
    h.require(ui_values()==[moved_x,moved_y,rect0["width"],rect0["height"]], "resize Undo differs")
    acc.key("ctrl+y")
    h.revision(acc,"hwp",6)
    enter_mode(0)
    h.require(ui_values()==[moved_x,moved_y,resized_width,resized_height], "resize Redo differs")
    acc.key("Escape")
    h.require(not acc.d.exists(CHILD), "Escape did not leave HWP5 child editing")

    original_color = target["children"][1]["color"]
    original_hex = original_color.to_bytes(3,"little").hex().upper()
    chosen = "00AA55"
    fill = GROUP + " input"
    def choose_fill():
        h.select_object(acc,target,"group")
        acc.dom_click(GROUP + " summary")
        acc.d.click(GROUP + " option[value='1']")
        acc.wait("return !!document.querySelector(arguments[0])",fill)
        return h.p6.value(acc,fill)
    h.require(choose_fill()==original_hex,
              "did not select HWP5 ellipse fill", h.p6.value(acc,fill))
    h.p6.gso.replace(acc,fill,chosen)
    acc.dom_click(GROUP + " button")
    h.revision(acc,"hwp",7)
    h.require(choose_fill()==chosen,"HWP5 fill edit was not shown",h.p6.value(acc,fill))
    acc.key("ctrl+z")
    h.revision(acc,"hwp",8)
    h.require(choose_fill()==original_hex,"HWP5 fill Undo differs")
    acc.key("ctrl+y")
    h.revision(acc,"hwp",9)
    h.require(choose_fill()==chosen,"HWP5 fill Redo differs")
    h.publish(acc,"hwp",row)

    after = row["after"] = inspect(path)
    want_group = {**group,"children":[{**rect0,"x":moved_x,"y":moved_y,
        "width":resized_width,"height":resized_height},ellipse0]}
    want_fills = [target["children"][0],
                  {**target["children"][1],"color":int.from_bytes(bytes.fromhex(chosen),"little")}]
    expected_target = {**target,"children":want_fills,"groupChildren":want_group}
    h.require(after=={**before,"frames":[expected_target if item==target else item for item in before["frames"]]},
              "saved HWP5 group child owner, sibling, or document model changed",after)
    row["recordProof"] = hwp5_group_records(fixture,path,want_group)
    h.reopen(acc,path,row)
    enter_mode(0)
    h.require(ui_values()==[moved_x,moved_y,resized_width,resized_height],"reopened HWP5 rectangle differs")
    acc.key("Escape")
    h.require(choose_fill()==chosen,"reopened HWP5 child fill differs")


h.CASES = {
    "P4-DX-GROUP": docx_group_case,
    "P4-DX-CURVE": docx_curve_case,
    "P4-DX-PATH": docx_path_vertex_case,
    "P4-PATH-XFM-DOCX": docx_path_transform_case,
    "P4-PATH-XFM-HWPX": lambda *args: rhwp_path_transform_case(*args, "hwpx"),
    "P4-PATH-XFM-HWP5": lambda *args: rhwp_path_transform_case(*args, "hwp"),
    "P4.1": lambda *args: points_case(*args, "polygon", "hwpx"),
    "P4-HX-CURVE": lambda *args: points_case(*args, "curve", "hwpx"),
    "P4-HX-CURVE-CONTRACT-V1": hwpx_curve_contract_v1_case,
    "P4-HX-CURVE-CATMULL": hwpx_curve_catmull_rom_case,
    "P4-HX-CURVE-LINES": hwpx_curve_line_segments_case,
    "P4.2": lambda *args: points_case(*args, "curve", "hwp"),
    "P4.3": group_case,
    "P4.4": polygon_vertices_case,
    "P4.5": curve_terminal_line_case,
    "P4-H5-SEG-LINE": curve_interior_line_case,
    "P4-H5-SEG": curve_cubic_segment_case,
    "P4-H5-POLY-POINT": lambda *args: points_case(*args, "polygon", "hwp"),
    "P4-H5-POLY-EDGES": hwp5_polygon_edges,
    "P4.6": group_child_edit_case,
    "P4-GROUP-XFM": group_transform_case,
    "P4-HX-NEST": nested_group_edit_case,
    "P4-H5-GROUP": hwp5_group_child_edit_case,
    "P4.6-capture": group_child_capture_case,
}

if __name__ == "__main__":
    sys.exit(h.main())
