#!/usr/bin/env python3
"""P4 Linux X11 editor acceptance using published files and independent inspection."""

import importlib.util
import math
from pathlib import Path
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


def points_case(acc, row, fixtures, out, kind, fmt):
    fixture = fixtures / f"a-p4-{kind}-original.{fmt}"
    before = row["before"] = inspect(fixture)
    target = next(frame for frame in before["frames"] if frame["path"] and frame["path"]["kind"] == kind)
    path = h.begin(acc, row, fixture, out, f"a-p4-{kind}-edited.{fmt}")
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
    endpoint_index = 3 if kind == "curve" else point_index
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
    after = row["after"] = inspect(path)
    want = {**target, "path": {**model,"points": expected}}
    h.require(after == {**before, "frames":[want if item == target else item for item in before["frames"]]},
              "independent engine changed unrelated content or geometry", after)
    if fmt == "hwp":
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

    def inspect_saved(expected, commands):
        want = {**target, "path": {**target["path"], "points": expected}}
        model = inspect(path)
        h.require(model == {**before,"frames":[want if item == target else item for item in before["frames"]]},
                  "independent curve projection differs", model)
        gso = h.p6.gso
        streams = [gso.cfb_streams(item.read_bytes()) for item in (fixture, path)]
        ignored = {"BodyText/Section0","PrvText","PrvImage"}
        h.require({k:v for k,v in streams[0].items() if k not in ignored}
                  == {k:v for k,v in streams[1].items() if k not in ignored}, "unrelated HWP streams changed")
        old, new = [gso.records(gso.unpacked(stream,"BodyText/Section0")) for stream in streams]
        changes = [(a,b) for a,b in zip(old,new,strict=True) if a != b]
        h.require(len(changes) == 1 and changes[0][0][:2] == changes[0][1][:2] == (83,3),
                  "non-curve records changed", changes)
        payload = changes[0][1][2]
        count = struct.unpack_from("<I",payload)[0]
        end = 4 + count*8
        h.require(count == len(expected)
                  and list(struct.iter_unpack("<ii",payload[4:end])) == [(p["x"],p["y"]) for p in expected]
                  and payload[end:] == bytes(commands) + bytes(count-1-len(commands)+4),
                  "curve record count, points, segment bytes or four-byte padding differs")
        return h.digest(path)

    select_end(5)
    h.p6.gso.replace(acc, COORDS + " label:first-of-type input", 10600)
    h.p6.gso.replace(acc, COORDS + " label:nth-of-type(2) input", 5500)
    acc.dom_click(".object-path-append-line")
    h.revision(acc, "hwp", 1)
    acc.key("Escape")
    append_row = row["append"] = {}
    h.publish(acc, "hwp", append_row)
    append_row["publishedSha256"] = inspect_saved(appended, [1,0,0])
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
    row["publishedSha256"] = inspect_saved(removed, [1])
    h.reopen(acc, path, row)
    select_end(4)
    h.require(acc.d.js("return document.querySelector('.object-path-remove-line').disabled"),
              "reopened endpoint still offers an invalid removal")


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
    "P4.1": lambda *args: points_case(*args, "polygon", "hwpx"),
    "P4.2": lambda *args: points_case(*args, "curve", "hwp"),
    "P4.3": group_case,
    "P4.4": polygon_vertices_case,
    "P4.5": curve_terminal_line_case,
    "P4.6": group_child_edit_case,
    "P4.6-capture": group_child_capture_case,
}

if __name__ == "__main__":
    sys.exit(h.main())
