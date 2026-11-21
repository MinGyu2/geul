#!/usr/bin/env python3
"""P4 Linux X11 editor acceptance using published files and independent inspection."""

from copy import deepcopy
import importlib.util
import math
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
    return {
        "xml": root,
        "geometry": geometry,
        "paths": paths,
        "relationshipsSha256": __import__("hashlib").sha256(rels).hexdigest(),
        "relationships": rels,
        "parts": parts,
    }


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


h.CASES = {
    "P4-DX-CURVE": docx_curve_case,
    "P4-DX-PATH": docx_path_vertex_case,
    "P4.1": lambda *args: points_case(*args, "polygon", "hwpx"),
    "P4-HX-CURVE": lambda *args: points_case(*args, "curve", "hwpx"),
    "P4.2": lambda *args: points_case(*args, "curve", "hwp"),
    "P4.3": group_case,
    "P4.4": polygon_vertices_case,
    "P4.5": curve_terminal_line_case,
    "P4-H5-SEG-LINE": curve_interior_line_case,
    "P4-H5-SEG": curve_cubic_segment_case,
    "P4-H5-POLY-POINT": lambda *args: points_case(*args, "polygon", "hwp"),
    "P4-H5-POLY-EDGES": hwp5_polygon_edges,
    "P4.6": group_child_edit_case,
    "P4.6-capture": group_child_capture_case,
}

if __name__ == "__main__":
    sys.exit(h.main())
