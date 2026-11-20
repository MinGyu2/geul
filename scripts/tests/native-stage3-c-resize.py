#!/usr/bin/env python3
"""Verify the RHWP floating resize boundary with real X11 pointer actions."""
import importlib.util
from pathlib import Path
import sys

entry = Path(__file__).with_name("native-stage3-c.py")
spec = importlib.util.spec_from_file_location("stage3c", entry)
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)

h = acceptance
LEADING = ("nw", "n", "ne", "sw", "w")


def drag(acc, testid, dx, dy):
    x, y = acc.d.js("""
      const rect = document.querySelector('[data-testid="' + arguments[0] + '"]').getBoundingClientRect();
      return [rect.x+rect.width/2, rect.y+rect.height/2];
    """, testid)
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x*sx, y*sy), ((x+dx)*sx, (y+dy)*sy))


def inspect(path, kind):
    if kind == "group":
        model = h.core_shapes(path)
        return model, model["frames"][0]
    model = h.p6.hwp(path)
    if kind == "shape":
        return model, model["shapes"][0]
    return model, next(p for p in model["images"] if not p["props"]["treatAsChar"])


def handles(acc):
    return acc.d.js("return [...document.querySelectorAll('[data-handle]')].map(e=>e.dataset.handle)")


def geometry(acc):
    canvas_width = acc.d.js("""
      const frame=document.querySelector(arguments[0]);
      return parseFloat(frame.parentElement.querySelector('canvas').style.width);
    """, h.FRAME)
    return h.frame(acc), canvas_width


def run(acc, row, fixtures, out, kind):
    fixture = fixtures / ("p3-group-original.hwp" if kind == "group" else "gso-original.hwp")
    before, target = inspect(fixture, kind)
    path = h.begin(acc, row, fixture, out, f"floating-{kind}.hwp")
    row["before"] = before
    h.select_object(acc, target, kind)
    start, canvas_width = geometry(acc)
    row["startFrame"] = start
    available = row["resizeHandles"] = handles(acc)
    row["absentLeadingHandles"] = list(LEADING)
    h.require(acc.d.exists('[data-testid="object-move"]'), "move handle missing")
    h.require(available == ([] if kind == "picture" else ["e", "se", "s"]),
              "unsupported resize handle advertised", available)
    # No handle can fire a mixed request. The untouched session still has no history.
    acc.key("ctrl+z", "ctrl+y")
    h.revision(acc, "hwp", 0)
    h.require(h.frame(acc) == start and h.digest(path) == row["fixtureSha256"],
              "inspecting restricted handles changed the object or file")

    if kind == "picture":
        drag(acc, "object-move", 12, 8)
        h.revision(acc, "hwp", 1)
        point = {**target, "x": target["x"] + 12, "y": target["y"] + 8}
    else:
        drag(acc, "object-handle-s", 0, 12)
        h.revision(acc, "hwp", 1)
        point = target
    h.select_object(acc, point, kind)
    changed = row["editedFrame"] = h.frame(acc)
    if kind == "picture":
        h.require_near(changed["left"], start["left"] + 12, "move x")
        h.require_near(changed["top"], start["top"] + 8, "move y")
        h.require((changed["width"], changed["height"]) == (start["width"], start["height"]),
                  "move changed picture size")
    else:
        h.require_near(changed["height"], start["height"] + 12, "south resize height")
        h.require(all(changed[field] == start[field] for field in ("left", "top", "width")),
                  "south resize displaced northern anchor or changed width")
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    h.select_object(acc, target, kind)
    h.require(h.frame(acc) == start, "undo geometry")
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    h.select_object(acc, point, kind)
    h.require(h.frame(acc) == changed, "redo geometry")

    h.publish(acc, "hwp", row)
    after, saved = inspect(path, kind)
    row["after"] = after
    original_props, saved_props = target["props"], saved["props"]
    h.require((saved["secIdx"], saved["paraIdx"], saved["controlIdx"]) ==
              (target["secIdx"], target["paraIdx"], target["controlIdx"]), "saved object address changed")
    h.require(after["body"] == before["body"], "body text changed")
    if kind == "picture":
        conversion = original_props["width"] / target["w"]
        h.require_near(saved_props["horzOffset"], original_props["horzOffset"] + 12*conversion,
                       "saved horizontal move", 100)
        h.require_near(saved_props["vertOffset"], original_props["vertOffset"] + 8*conversion,
                       "saved vertical move", 100)
        changed_keys = {"horzOffset", "vertOffset"}
    else:
        h.require_near(saved_props["height"], original_props["height"] + 900, "saved resized height", 100)
        changed_keys = {"height"}
    h.require(all(saved_props[key] == value for key, value in original_props.items() if key not in changed_keys),
              "unrelated object properties changed")
    if kind == "group":
        h.require(h.shape_payload(path, group=True) == h.shape_payload(fixture, group=True),
                  "original group child records changed")
    else:
        row["unchangedBinData"] = h.checked_resources(fixture, path)
        collection = "images" if kind == "picture" else "shapes"
        sibling_collection = "shapes" if kind == "picture" else "images"
        h.require(after[sibling_collection] == before[sibling_collection] and
                  [obj for obj in after[collection] if obj != saved] ==
                  [obj for obj in before[collection] if obj != target], "unrelated objects changed")

    h.reopen(acc, path, row)
    h.select_object(acc, saved, kind)
    reopened, reopened_width = geometry(acc)
    row["reopenedFrame"] = reopened
    h.require(canvas_width == reopened_width and reopened == changed, "reopened frame differs")
    h.require(handles(acc) == available, "unsupported handle is advertised after reopen")


if __name__ == "__main__":
    h.CASES = {
        "floating-picture": lambda *args: run(*args, "picture"),
        "floating-shape": lambda *args: run(*args, "shape"),
        "floating-group": lambda *args: run(*args, "group"),
        "inline-picture": h.c01,
    }
    sys.exit(h.main())
