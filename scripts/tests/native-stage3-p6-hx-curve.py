#!/usr/bin/env python3
"""Linux X11 Native acceptance for the verified endpoint-only HWPX curve subset."""

import hashlib
import json
import re
import tempfile
import xml.etree.ElementTree as ET
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
OPF = "{http://www.idpf.org/2007/opf/}"
HC = "{http://www.hancom.co.kr/hwpml/2011/core}"
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
    if local(node) in {"img", "image"}:
        # Resource IDs are remapped per destination document and are checked below
        # against the manifest and exact media hashes.
        omitted.add("binaryItemIDRef")
    attributes = {key.rsplit("}", 1)[-1]: value for key, value in node.attrib.items()
                  if key.rsplit("}", 1)[-1] not in omitted}
    if local(node) == "imgBrush" and attributes.get("mode") == "FIT_TO_SIZE":
        # These are aliases in RHWP's HWPX fill model. The writer emits FIT.
        attributes["mode"] = "FIT"
    if local(node) in {"img", "image"}:
        # Omitted HWPX image alpha has the same zero/default value emitted by RHWP.
        attributes.setdefault("alpha", "0")
    attrs = sorted(attributes.items())
    return [local(node), attrs, (node.text or "").strip(), [normalize_curve(child) for child in node]]


def package_inventory(path):
    with ZipFile(path) as package:
        names = package.namelist()
        section_names = sorted(name for name in names if name.startswith("Contents/section") and name.endswith(".xml"))
        roots = {name: ET.fromstring(package.read(name)) for name in section_names}
        manifest = ET.fromstring(package.read("Contents/content.hpf"))
        manifest_items = {item.get("id"): item.get("href") for item in manifest.iter(OPF + "item")}
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
            "manifestItems": manifest_items,
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
    image_nodes = [node for node in curve.iter() if local(node) == "img"]
    if len(image_nodes) > 1:
        raise ValueError("curve has multiple image-fill resources")
    image_fill = None
    if image_nodes:
        image_ref = image_nodes[0].get("binaryItemIDRef")
        image_part = inventory["manifestItems"].get(image_ref)
        if not image_ref or not image_part or image_part not in inventory["parts"]:
            raise ValueError("curve image-fill resource is not owned by its OPC manifest")
        image_fill = {"id": image_ref, "part": image_part,
                      "sha256": inventory["parts"][image_part]}
    return {
        "section": section,
        "id": curve.get("id"),
        "instid": curve.get("instid"),
        "normalized": normalize_curve(curve),
        "placement": placement,
        "segments": [dict(segment.attrib) for segment in curve.findall(HP + "seg")],
        "imageFill": image_fill,
        "ownerParagraphText": "".join(text.text or "" for text in owner.iter() if local(text) == "t"),
        "objectIds": inventory["objectIds"],
        "objectInstIds": inventory["objectInstIds"],
        "media": inventory["media"],
        "parts": inventory["parts"],
    }


def prepare_curve_fixtures(out):
    out.mkdir(parents=True, exist_ok=True)
    source = out / "p6-hx-curve-source.fixture.hwpx"
    destination = out / "p6-hx-curve-destination.fixture.hwpx"
    canonical = ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.canonical.hwpx"
    source_sample = ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.hwpx"
    if not canonical.is_file() or not source_sample.is_file():
        raise ValueError("authentic and canonical HWPX Catmull-Rom fixtures are required")
    shutil.copyfile(canonical, source)
    marker = "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));"
    create = r"""
const destinationPath=process.argv[1];
const targetDoc=rhwp.HwpDocument.createEmpty();
const ok=(raw,label)=>{const value=JSON.parse(raw);if(value.ok!==true)throw Error(label+': '+JSON.stringify(value));return value;};
try {
  targetDoc.createBlankDocument();
  targetDoc.insertText(0,0,0,'curve destination baseline');
  const keep=ok(targetDoc.insertPicture(0,0,0,'[]',fs.readFileSync(path.resolve('src-tauri/icons/128x128.png')),
    2400,1500,128,128,'png','preserve unrelated destination picture'), 'destination picture');
  ok(targetDoc.setPictureProperties(0,0,keep.controlIdx,
    '{"treatAsChar":true,"textWrap":"Square","horzOffset":7800,"vertOffset":2500}'), 'destination picture properties');
  fs.writeFileSync(destinationPath,targetDoc.exportHwpx());
} finally { targetDoc.free(); }
"""
    template = b.p6.ORACLE.split("try {", 1)[0]
    if marker not in template:
        raise ValueError("P6 curve fixture template no longer matches the RHWP oracle")
    subprocess.run(["node", "-e", template.replace(marker, create), str(destination)], cwd=ROOT, check=True)

    if digest(source) != "53806f5004522b5260fac24a9700ed068849e890f0ae492573e62c26c4fd2548":
        raise ValueError("canonical authentic HWPX fixture hash changed")
    resource_bytes = (ROOT / "src-tauri/icons/icon.png").read_bytes()
    resource_part = "BinData/image1.png"
    image_ref = "image1"
    with ZipFile(source) as original_package:
        if resource_part in original_package.namelist():
            raise ValueError("canonical curve fixture unexpectedly owns image-fill media")
        entries = [(entry, original_package.read(entry.filename)) for entry in original_package.infolist()]
    patched_entries = []
    section_count = manifest_count = 0
    for entry, data in entries:
        if entry.filename == "Contents/section0.xml":
            text = data.decode("utf-8")
            replacement = (
                '<hc:fillBrush><hc:imgBrush mode="FIT_TO_SIZE">'
                '<hc:img binaryItemIDRef="image1" bright="0" contrast="0" effect="REAL_PIC"/>'
                '</hc:imgBrush></hc:fillBrush>'
            )
            text, section_count = re.subn(r"<hc:fillBrush[^>]*>.*?</hc:fillBrush>",
                                          replacement, text, count=1)
            data = text.encode("utf-8")
        elif entry.filename == "Contents/content.hpf":
            manifest = ET.fromstring(data)
            if image_ref in {item.get("id") for item in manifest.iter(OPF + "item")}:
                raise ValueError("canonical curve manifest unexpectedly owns image1")
            item = ET.Element(OPF + "item", {"id": image_ref, "href": resource_part,
                                               "media-type": "image/png", "isEmbeded": "1"})
            manifest_node = manifest.find(OPF + "manifest")
            if manifest_node is None:
                raise ValueError("canonical curve manifest has no resource owner")
            manifest_node.append(item)
            data = ET.tostring(manifest, encoding="utf-8", xml_declaration=True)
            manifest_count += 1
        patched_entries.append((entry, data))
    if section_count != 1 or manifest_count != 1:
        raise ValueError("canonical curve resource injection did not match one fill and manifest")
    with tempfile.NamedTemporaryFile(dir=out, prefix="p6-curve-resource-", suffix=".hwpx", delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with ZipFile(temporary, "w") as output_package:
            for entry, data in patched_entries:
                output_package.writestr(entry, data)
            output_package.writestr(resource_part, resource_bytes)
        temporary.replace(source)
    finally:
        temporary.unlink(missing_ok=True)

    source_snapshot = curve_snapshot(source)
    expected = [
        ("450", "6140", "8000", "11215"),
        ("8000", "11215", "2500", "19340"),
        ("2500", "19340", "14175", "20515"),
        ("14175", "20515", "15675", "8440"),
        ("15675", "8440", "2475", "15"),
        ("2475", "15", "450", "6140"),
    ]
    actual = [tuple(segment.get(key) for key in ("x1", "y1", "x2", "y2"))
              for segment in source_snapshot["segments"]]
    if len(actual) != 6 or actual != expected or any(segment.get("type") != "CURVE"
                                                       for segment in source_snapshot["segments"]):
        raise ValueError("authentic HWPX fixture does not contain its six standard CURVE records")
    if digest(source_sample) != "cd403f9facf7ccef55a171b2c824d72ea41a4d13c38e5997eea598a37744c7b0":
        raise ValueError("authentic upstream curve sample hash changed")
    return source, destination


def editable_curve_path(path):
    return b.c.inspect_rhwp(path, """
      const all=pages.flatMap(items=>items);
      const curve=all.find(item=>item.type==='shape'&&JSON.parse(doc.getShapeProperties(
        item.secIdx,item.paraIdx,item.controlIdx)).shapeType==='curve');
      if(!curve)throw Error('editable curve shape is missing');
      const model=JSON.parse(doc.getEditableShapePath(curve.secIdx,curve.paraIdx,curve.controlIdx));
      console.log(JSON.stringify(model));
    """)


def p6_hx_curve_transfer(acc, row, _b_root, out):
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
    source_path = editable_curve_path(source)
    destination_package = package_inventory(destination)
    row["fixtureHashes"] = {"source": source_fixture_hash, "destination": destination_fixture_hash}
    row["authenticCurveSample"] = {
        "sourceSampleSha256": digest(ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.hwpx"),
        "canonicalFixtureSha256": digest(ROOT / "scripts/tests/fixtures/hwpx-catmull-rom/SimpleCurve.canonical.hwpx"),
        "resourceFilledFixtureSha256": source_fixture_hash,
    }
    curve_model = next((shape for shape in source_before["shapes"] if shape["props"].get("shapeType") == "curve"), None)
    if curve_model is None or destination_before["shapes"] or len(destination_before["pictures"]) != 1:
        raise ValueError("Native fixture object inventory is unexpected")
    if source_curve["id"] is None or source_curve["instid"] is None:
        raise ValueError("source curve has no stable object/instance identity")
    if (source_curve["imageFill"] is None
            or source_curve["imageFill"]["sha256"] != digest(ROOT / "src-tauri/icons/icon.png")
            or len(source_curve["media"]) != 1):
        raise ValueError("authentic source curve image-fill resource is not durably owned")
    if (source_path.get("curveModel") != "catmull-rom-derived-bezier"
            or source_path.get("closed") is not True
            or len(source_path.get("bezierSegments", [])) != 6):
        raise ValueError("authentic source curve does not expose the expected derived cubic model")

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
    after_path = editable_curve_path(destination)
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
    if after_path != source_path:
        raise ValueError("saved destination did not preserve the derived Catmull-Rom Bezier control-point model")
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
    if not all(after_curve["media"].get(name) == value
               for name, value in destination_package["media"].items()):
        raise ValueError("curve paste changed an existing destination media resource")
    destination_resource_ids = {resource_id for resource_id, part in destination_package["manifestItems"].items()
                                if part and part.startswith("BinData/")}
    if (after_curve["imageFill"] is None
            or after_curve["imageFill"]["id"] == source_curve["imageFill"]["id"]
            or after_curve["imageFill"]["id"] in destination_resource_ids
            or after_curve["imageFill"]["sha256"] != source_curve["imageFill"]["sha256"]
            or len(after_curve["media"]) != len(destination_package["media"]) + 1):
        raise ValueError("curve image-fill was not independently remapped into destination media")
    old_parts, new_parts = set(destination_package["parts"]), set(after_curve["parts"])
    if not old_parts.issubset(new_parts):
        raise ValueError("curve paste removed unrelated OPC parts")
    changed = sorted(name for name in old_parts if after_curve["parts"].get(name) != destination_package["parts"].get(name))
    allowed = {"Contents/section0.xml", "Preview/PrvImage.png", "Preview/PrvText.txt"}
    expected_new_media = after_curve["imageFill"]["part"]
    allowed_new = {expected_new_media}
    allowed_changed = allowed | {"Contents/content.hpf"}
    if ("Contents/section0.xml" not in changed or not set(changed).issubset(allowed_changed)
            or new_parts - old_parts != allowed_new):
        raise ValueError(f"curve paste changed unexpected OPC parts: {changed}, new={sorted(new_parts-old_parts)}")
    row["serializedOpc"] = {"changedParts": changed, "allOtherPartsByteIdentical": True,
                             "newOwnedResource": expected_new_media,
                             "existingDestinationMediaPreserved": True, "sourceBytesUnchanged": True}
    row["savedCurve"] = after_curve
    row["derivedControlPointRepresentation"] = {
        "curveModel": source_path["curveModel"],
        "source": source_path["bezierSegments"],
        "savedDestination": after_path["bezierSegments"],
        "identical": True,
    }
    row["floatingPlacement"] = {
        "source": {key: source_curve["placement"][key] for key in expected_offsets},
        "savedDestination": actual_offsets,
        "pasteCascadeStepHwpUnits": PASTE_CASCADE_STEP_HU,
        "shapeStyleAndInternalGeometryPreserved": True,
    }
    row["acceptanceScope"] = (
        "Standard HWPX curve transfer preserves exact segment envelopes and deterministic derived cubic controls, "
        "remaps owned resources, and rejects unknown metadata."
    )

    b.reopen(acc, destination, row)
    reopened = curve_snapshot(destination)
    reopened_path = editable_curve_path(destination)
    if reopened != after_curve or b.inspect_hwpx_clip(destination) != after_model or reopened_path != source_path:
        raise ValueError("same-process save/reopen changed the curve or destination model")
    row["sameProcessReopen"] = {"sha256": digest(destination), "curve": reopened}
    reopened_model = next(shape for shape in b.inspect_hwpx_clip(destination)["shapes"]
                          if shape["props"].get("shapeType") == "curve")
    b.select_object(acc, reopened_model, "shape")
    row["reopenedCurveSelectable"] = True


def p6_hx_curve_transfer_fresh(acc, row, _b_root, out):
    previous = json.loads((out / "result.json").read_text())["cases"]["P6-HX-CURVE-TRANSFER"]
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
    saved_path = editable_curve_path(destination)
    require(saved_path.get("curveModel") == "catmull-rom-derived-bezier"
            and saved_path.get("bezierSegments")
            == previous.get("derivedControlPointRepresentation", {}).get("source"),
            "fresh-process derived curve control model differs from the transferred source")
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
        "derivedControlPointRepresentation": saved_path["bezierSegments"],
        "placement": saved_curve["placement"],
        "trustedPointer": pointers,
        "selectable": True,
    }


b.CASES["P6-HX-CURVE-TRANSFER"] = p6_hx_curve_transfer
b.CASES["P6-HX-CURVE-TRANSFER-FRESH"] = p6_hx_curve_transfer_fresh

if __name__ == "__main__":
    sys.exit(b.main())
