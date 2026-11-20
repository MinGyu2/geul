#!/usr/bin/env python3
"""P4 Linux X11 editor acceptance using published files and independent inspection."""

import importlib.util
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
            path:JSON.parse(doc.getEditableShapePath(...at)),children:JSON.parse(doc.getEditableGroupFills(...at))};
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


h.CASES = {
    "P4.1": lambda *args: points_case(*args, "polygon", "hwpx"),
    "P4.2": lambda *args: points_case(*args, "curve", "hwp"),
    "P4.3": group_case,
}

if __name__ == "__main__":
    sys.exit(h.main())
