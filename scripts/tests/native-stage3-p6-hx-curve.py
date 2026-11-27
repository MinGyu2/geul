#!/usr/bin/env python3
"""Linux X11 Native acceptance for the verified endpoint-only HWPX curve subset."""

import hashlib
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import importlib.util

spec = importlib.util.spec_from_file_location("stage3b", HERE / "native-stage3-b.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

ROOT = b.ROOT
require = b.require
inspect_hwpx_clip = b.inspect_hwpx_clip
HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
CONTROL_TAGS = {"container", "rect", "ellipse", "line", "arc", "polygon", "curve", "pic", "chart", "ole"}
PASTE_CASCADE_STEP_HU = 567


def local(node):
    return node.tag.rsplit("}", 1)[-1]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalize_curve(node):
    omitted = {"id", "instid", "zOrder"}
    if local(node) == "pos":
        # Floating-object paste applies RHWP's documented one-step cascade to
        # the destination anchor. All other position semantics remain exact.
        omitted.update({"horzOffset", "vertOffset"})
    attrs = sorted((key.rsplit("}", 1)[-1], value) for key, value in node.attrib.items()
                   if key.rsplit("}", 1)[-1] not in omitted)
    return [local(node), attrs, (node.text or "").strip(), [normalize_curve(child) for child in node]]


def package_inventory(path):
    with ZipFile(path) as package:
        names = package.namelist()
        section_names = sorted(name for name in names if name.startswith("Contents/section") and name.endswith(".xml"))
        roots = {name: ET.fromstring(package.read(name)) for name in section_names}
        ids, instids = [], []
        for root in roots.values():
            for node in root.iter():
                if local(node) in CONTROL_TAGS:
                    if node.get("id") is not None:
                        ids.append(node.get("id"))
                    if node.get("instid") is not None:
                        instids.append(node.get("instid"))
        parts = {name: hashlib.sha256(package.read(name)).hexdigest() for name in names}
        return {
            "roots": roots,
            "objectIds": ids,
            "objectInstIds": instids,
            "media": {name: value for name, value in parts.items() if name.startswith("BinData/")},
            "parts": parts,
        }


def curve_snapshot(path):
    inventory = package_inventory(path)
    roots = inventory["roots"]
    curves = [(name, node) for name, root in roots.items() for node in root.iter() if node.tag == HP + "curve"]
    if len(curves) != 1:
        raise ValueError(f"expected exactly one direct curve, got {len(curves)}")
    section, curve = curves[0]
    positions = [child for child in list(curve) if local(child) == "pos"]
    if len(positions) != 1:
        raise ValueError(f"expected exactly one curve placement record, got {len(positions)}")
    placement = dict(positions[0].attrib)
    for key in ("horzOffset", "vertOffset"):
        try:
            placement[key] = int(placement[key])
        except (KeyError, ValueError) as error:
            raise ValueError(f"curve placement has no valid {key}") from error
    parents = {child: parent for root in roots.values() for parent in root.iter() for child in list(parent)}
    owner = parents.get(curve)
    while owner is not None and local(owner) != "p":
        owner = parents.get(owner)
    if owner is None:
        raise ValueError("curve has no paragraph owner")
    return {
        "section": section,
        "id": curve.get("id"),
        "instid": curve.get("instid"),
        "normalized": normalize_curve(curve),
        "placement": placement,
        "segments": [dict(segment.attrib) for segment in curve.findall(HP + "seg")],
        "ownerParagraphText": "".join(text.text or "" for text in owner.iter() if local(text) == "t"),
        "objectIds": inventory["objectIds"],
        "objectInstIds": inventory["objectInstIds"],
        "media": inventory["media"],
        "parts": inventory["parts"],
    }


def prepare_curve_fixtures(out):
    out.mkdir(parents=True, exist_ok=True)
    source_raw = out / "p6-hx-curve-source.raw.hwpx"
    source = out / "p6-hx-curve-source.fixture.hwpx"
    destination = out / "p6-hx-curve-destination.fixture.hwpx"
    marker = "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));"
    create = r"""
const sourcePath=process.argv[1], destinationPath=process.argv[2];
const sourceDoc=rhwp.HwpDocument.createEmpty();
const targetDoc=rhwp.HwpDocument.createEmpty();
const ok=(raw,label)=>{const value=JSON.parse(raw);if(value.ok!==true)throw Error(label+': '+JSON.stringify(value));return value;};
try {
  sourceDoc.createBlankDocument();
  sourceDoc.insertText(0,0,0,'endpoint curve source body');
  const shape=ok(sourceDoc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,
    shapeType:'rectangle',width:5000,height:3000,treatAsChar:false,textWrap:'Square',horzOffset:2000,vertOffset:2000})), 'curve envelope');
  fs.writeFileSync(sourcePath,sourceDoc.exportHwpx());

  targetDoc.createBlankDocument();
  targetDoc.insertText(0,0,0,'curve destination baseline');
  const keep=ok(targetDoc.insertPicture(0,0,0,'[]',fs.readFileSync(path.resolve('src-tauri/icons/128x128.png')),
    2400,1500,128,128,'png','preserve unrelated destination picture'), 'destination picture');
  ok(targetDoc.setPictureProperties(0,0,keep.controlIdx,
    '{"treatAsChar":true,"textWrap":"Square","horzOffset":7800,"vertOffset":2500}'), 'destination picture properties');
  fs.writeFileSync(destinationPath,targetDoc.exportHwpx());
} finally { sourceDoc.free(); targetDoc.free(); }
"""
    template = b.p6.ORACLE.split("try {", 1)[0]
    if marker not in template:
        raise ValueError("P6 curve fixture template no longer matches the RHWP oracle")
    subprocess.run(["node", "-e", template.replace(marker, create), str(source_raw), str(destination)],
                   cwd=ROOT, check=True)

    replacement = (
        b'<hp:seg type="CURVE" x1="0" y1="0" x2="2400" y2="1300"/>'
        b'<hp:seg type="LINE" x1="2400" y1="1300" x2="5000" y2="0"/>'
    )
    with ZipFile(source_raw) as original, ZipFile(source, "w") as output:
        for entry in original.infolist():
            payload = original.read(entry.filename)
            if entry.filename == "Contents/section0.xml":
                def convert(match):
                    shape = match[0].replace(b"<hp:rect", b"<hp:curve", 1).replace(b"</hp:rect>", b"</hp:curve>", 1)
                    shape, ratio_count = re.subn(rb' ratio="[0-9]+"', b"", shape, count=1)
                    if ratio_count != 1:
                        raise ValueError("rectangle fixture did not contain its shape-only ratio attribute")
                    shape, point_count = re.subn(rb"<(?:hp|hc):pt[0-3]\b[^>]*/>", b"", shape)
                    if point_count != 4 or shape.count(b"<hp:sz") != 1:
                        raise ValueError("rectangle fixture envelope differs from the expected HWPX source")
                    return shape.replace(b"<hp:sz", replacement + b"<hp:sz", 1)

                payload, count = re.subn(rb"<hp:rect\b.*?</hp:rect>", convert, payload, count=1, flags=re.S)
                if count != 1:
                    raise ValueError("fixture document did not contain exactly one rectangle envelope")
            output.writestr(entry, payload)
    source_raw.unlink()
    source_snapshot = curve_snapshot(source)
    if source_snapshot["segments"] != [
        {"type": "CURVE", "x1": "0", "y1": "0", "x2": "2400", "y2": "1300"},
        {"type": "LINE", "x1": "2400", "y1": "1300", "x2": "5000", "y2": "0"},
    ]:
        raise ValueError("generated HWPX fixture has unexpected curve segments")
    return source, destination


def p6_hx_curve_partial(acc, row, _b_root, out):
    source_fixture, destination_fixture = prepare_curve_fixtures(out)
    source = out / "p6-hx-curve-source.hwpx"
    destination = out / "p6-hx-curve-destination.hwpx"
    source_fixture_hash = digest(source_fixture)
    destination_fixture_hash = digest(destination_fixture)
    shutil.copyfile(source_fixture, source)
    shutil.copyfile(destination_fixture, destination)
    source_hash = digest(source)
    source_before = row["beforeSource"] = b.inspect_hwpx_clip(source)
    destination_before = row["beforeDestination"] = b.inspect_hwpx_clip(destination)
    source_curve = curve_snapshot(source)
    destination_package = package_inventory(destination)
    row["fixtureHashes"] = {"source": source_fixture_hash, "destination": destination_fixture_hash}
    curve_model = next((shape for shape in source_before["shapes"] if shape["props"].get("shapeType") == "curve"), None)
    if curve_model is None or destination_before["shapes"] or len(destination_before["pictures"]) != 1:
        raise ValueError("Native fixture object inventory is unexpected")
    if source_curve["id"] is None or source_curve["instid"] is None:
        raise ValueError("source curve has no stable object/instance identity")

    acc.d.js("""
      window.p6CurvePointers=[]; window.p6CurveKeys=[];
      document.addEventListener('pointerdown',e=>{
        if(e.target instanceof Element&&e.target.closest('.rhwp-page'))
          window.p6CurvePointers.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});
      },true);
      document.addEventListener('keydown',e=>{
        if(e.ctrlKey&&['c','v','z','y'].includes(e.key.toLowerCase()))
          window.p6CurveKeys.push({key:e.key.toLowerCase(),trusted:e.isTrusted});
      },true);
    """)
    acc.open_native("hwpx", source)
    row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
    if row["activeGeneration"] != json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())["generation"]:
        raise ValueError("app and oracle Release generations differ")
    b.select_object(acc, curve_model, "shape")
    row["trustedPointer"] = acc.d.js("return window.p6CurvePointers.slice()")
    if not any(item["trusted"] for item in row["trustedPointer"]):
        raise ValueError("curve selection did not use a trusted Native pointer")
    acc.key("ctrl+c")
    acc.open_native("hwpx", destination)
    b.c.body_end(acc)
    before_canvas = b._canvas_digest(acc)
    acc.key("ctrl+v")
    row["afterPaste"] = b.revision(acc, "hwpx", 1)
    pasted_canvas = b._canvas_digest(acc)
    if pasted_canvas == before_canvas:
        raise ValueError("trusted curve paste did not change the destination rendering")
    acc.key("ctrl+z")
    row["afterUndo"] = b.revision(acc, "hwpx", 2)
    if b._canvas_digest(acc) != before_canvas:
        raise ValueError("Undo did not restore the destination rendering")
    acc.key("ctrl+y")
    row["afterRedo"] = b.revision(acc, "hwpx", 3)
    if b._canvas_digest(acc) != pasted_canvas:
        raise ValueError("Redo did not restore the curve rendering")
    row["trustedClipboardKeys"] = acc.d.js("return window.p6CurveKeys.slice()")
    for key in ("c", "v", "z", "y"):
        if not any(item["key"] == key and item["trusted"] for item in row["trustedClipboardKeys"]):
            raise ValueError(f"{key.upper()} did not use a trusted Native key")
    if digest(source) != source_hash:
        raise ValueError("copy, paste, Undo, or Redo modified the source document bytes")

    b.publish(acc, "hwpx", row)
    after_model = row["after"] = b.inspect_hwpx_clip(destination)
    after_curve = curve_snapshot(destination)
    source_after = curve_snapshot(source)
    if digest(source) != source_hash or source_after != source_curve:
        raise ValueError("source curve or source package changed")
    if [shape["props"].get("shapeType") for shape in after_model["shapes"]] != ["curve"]:
        raise ValueError("saved destination does not contain exactly one curve shape")
    if after_model["body"] != destination_before["body"] + ["", ""]:
        raise ValueError("curve paste changed destination paragraph ownership/topology")
    if after_model["pictures"] != destination_before["pictures"]:
        raise ValueError("curve paste changed the unrelated destination picture/resource")
    if [body for body in after_model["body"] if body] != [body for body in destination_before["body"] if body]:
        raise ValueError("curve paste changed destination body text")
    if after_curve["normalized"] != source_curve["normalized"] or after_curve["segments"] != source_curve["segments"]:
        raise ValueError("saved curve geometry, formatting, or segment records differ from source")
    pasted_shape, = after_model["shapes"]
    source_props = curve_model["props"]
    pasted_props = pasted_shape["props"]
    identity_and_placement = {"instanceId", "scInstId", "horzOffset", "vertOffset"}
    source_style_geometry = {key: value for key, value in source_props.items() if key not in identity_and_placement}
    pasted_style_geometry = {key: value for key, value in pasted_props.items() if key not in identity_and_placement}
    if pasted_style_geometry != source_style_geometry:
        raise ValueError("saved curve changed modeled geometry or shape formatting")
    expected_offsets = {
        "horzOffset": source_curve["placement"]["horzOffset"] + PASTE_CASCADE_STEP_HU,
        "vertOffset": source_curve["placement"]["vertOffset"] + PASTE_CASCADE_STEP_HU,
    }
    actual_offsets = {key: after_curve["placement"][key] for key in expected_offsets}
    if actual_offsets != expected_offsets or any(pasted_props.get(key) != value for key, value in expected_offsets.items()):
        raise ValueError(f"floating paste did not apply exactly one destination cascade step: {actual_offsets}")
    if after_curve["id"] in {source_curve["id"], *[v for v in destination_package["objectIds"] if v != "0"]}:
        raise ValueError("destination curve reused a source or pre-existing object identifier")
    if after_curve["instid"] in {source_curve["instid"], *[v for v in destination_package["objectInstIds"] if v != "0"]}:
        raise ValueError("destination curve reused a source or pre-existing instance identifier")
    if len(after_curve["objectIds"]) != len(set(after_curve["objectIds"])):
        raise ValueError("saved destination contains duplicate object IDs")
    if after_curve["media"] != destination_package["media"]:
        raise ValueError("curve paste changed an existing destination media resource")
    old_parts, new_parts = set(destination_package["parts"]), set(after_curve["parts"])
    if not old_parts.issubset(new_parts):
        raise ValueError("curve paste removed unrelated OPC parts")
    changed = sorted(name for name in old_parts if after_curve["parts"].get(name) != destination_package["parts"].get(name))
    allowed = {"Contents/section0.xml", "Preview/PrvImage.png", "Preview/PrvText.txt"}
    if "Contents/section0.xml" not in changed or not set(changed).issubset(allowed) or new_parts != old_parts:
        raise ValueError(f"curve paste changed unexpected OPC parts: {changed}")
    row["serializedOpc"] = {"changedParts": changed, "allOtherPartsByteIdentical": True,
                             "existingDestinationMediaPreserved": True, "sourceBytesUnchanged": True}
    row["savedCurve"] = after_curve
    row["floatingPlacement"] = {
        "source": {key: source_curve["placement"][key] for key in expected_offsets},
        "savedDestination": actual_offsets,
        "pasteCascadeStepHwpUnits": PASTE_CASCADE_STEP_HU,
        "shapeStyleAndInternalGeometryPreserved": True,
    }
    row["acceptanceScope"] = "Endpoint-only HWPX segment transfer subset; P6-HX-CURVE remains PARTIAL / BLOCKED_BY_FORMAT_CONTRACT."

    b.reopen(acc, destination, row)
    reopened = curve_snapshot(destination)
    if reopened != after_curve or b.inspect_hwpx_clip(destination) != after_model:
        raise ValueError("same-process save/reopen changed the curve or destination model")
    row["sameProcessReopen"] = {"sha256": digest(destination), "curve": reopened}
    reopened_model = next(shape for shape in b.inspect_hwpx_clip(destination)["shapes"]
                          if shape["props"].get("shapeType") == "curve")
    b.select_object(acc, reopened_model, "shape")
    row["reopenedCurveSelectable"] = True


def p6_hx_curve_partial_fresh(acc, row, _b_root, out):
    previous = json.loads((out / "result.json").read_text())["cases"]["P6-HX-CURVE-PARTIAL"]
    require(previous.get("status") == "PASS" and "sameProcessReopen" in previous,
            "endpoint-only curve save/reopen prerequisites did not pass")
    destination = out / "p6-hx-curve-destination.hwpx"
    require(destination.is_file(), "saved curve package is missing")
    row["previousAppPid"] = previous["appPid"]
    require(row["appPid"] != row["previousAppPid"], "fresh reopen reused the prior application process")
    saved_hash = digest(destination)
    require(saved_hash == previous["sameProcessReopen"]["sha256"],
            "fresh-process probe did not open the verified saved package")
    saved_curve = curve_snapshot(destination)
    require(json.loads(json.dumps(saved_curve)) == previous["sameProcessReopen"]["curve"],
            "independent fresh-process probe sees a different saved curve package")
    model = inspect_hwpx_clip(destination)
    curves = [shape for shape in model["shapes"] if shape["props"].get("shapeType") == "curve"]
    require(len(curves) == 1, "fresh process did not reopen exactly one editable curve", model)
    row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
    require(row["activeGeneration"] == json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())["generation"],
            "fresh process uses a different RHWP Release generation")
    acc.d.js("""
      window.p6CurveFreshPointers=[];
      document.addEventListener('pointerdown',e=>{
        if(e.target instanceof Element&&e.target.closest('.rhwp-page'))
          window.p6CurveFreshPointers.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});
      },true);
    """)
    acc.open_native("hwpx", destination)
    b.select_object(acc, curves[0], "shape")
    pointers = acc.d.js("return window.p6CurveFreshPointers.slice()")
    require(any(pointer["trusted"] for pointer in pointers),
            "reopened curve was not selected with a trusted Native pointer")
    row["freshSession"] = {
        "packageSha256": saved_hash,
        "appPid": row["appPid"],
        "appSha256": row["processAppSha256"],
        "rhwpGeneration": row["activeGeneration"],
        "curveId": saved_curve["id"],
        "curveInstanceId": saved_curve["instid"],
        "segments": saved_curve["segments"],
        "placement": saved_curve["placement"],
        "trustedPointer": pointers,
        "selectable": True,
    }


b.CASES["P6-HX-CURVE-PARTIAL"] = p6_hx_curve_partial
b.CASES["P6-HX-CURVE-PARTIAL-FRESH"] = p6_hx_curve_partial_fresh

if __name__ == "__main__":
    sys.exit(b.main())
