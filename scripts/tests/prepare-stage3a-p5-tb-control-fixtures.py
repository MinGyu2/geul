#!/usr/bin/env python3
"""Build deterministic HWPX and HWP5 textbox-owned shape fixtures from the pinned Release engine."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
RHWP_PIN = "1a76570e833917d15817415a53c09ad61ab3203f"
PATCH = "stage3a-p5-textbox-nested-paths.patch"

NODE = r"""
const fs = require('fs'), path = require('path');
const root = path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS || 'public/rhwp');
const release = JSON.parse(fs.readFileSync(path.join(root, 'RELEASE.json')));
const generation = path.join(root, 'generations', release.generation);
const rhwp = require(path.join(generation, 'rhwp.js'));
rhwp.initSync({module: fs.readFileSync(path.join(generation, 'rhwp_bg.wasm'))});

function exportDoc(kind, destination) {
  const doc = rhwp.HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, 'body parent sibling');
    if (kind === 'textbox') {
      const created = JSON.parse(doc.createShapeControl(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 5, shapeType: 'textbox',
        width: 18000, height: 12000, treatAsChar: true, textWrap: 'Square',
      })));
      if (created.ok !== true) throw Error('could not create source textbox');
      const ownerControl = created.controlIdx;
      const changed = JSON.parse(doc.setShapeProperties(0, 0, ownerControl, JSON.stringify({
        tbVerticalAlign: 'Bottom', tbMarginLeft: 640, tbMarginTop: 310,
      })));
      if (changed.ok !== true) throw Error('could not set source textbox properties');
      doc.insertTextInCell(0, 0, ownerControl, 0, 0, 0, 'nested shape owner paragraph');
    } else {
      const created = JSON.parse(doc.createShapeControl(JSON.stringify({
        sectionIdx: 0, paraIdx: 0, charOffset: 0, shapeType: 'ellipse',
        width: 4200, height: 3000, treatAsChar: false, textWrap: 'Square',
      })));
      if (created.ok !== true) throw Error('could not create source ellipse');
      const changed = JSON.parse(doc.setShapeProperties(0, 0, created.controlIdx, JSON.stringify({
        fillBgColor: 0x00336699, vertOffset: 1800, horzOffset: 2500,
      })));
      if (changed.ok !== true) throw Error('could not set source ellipse properties');
    }
    const exported = doc.exportHwpxWithReport();
    try {
      const loss = JSON.parse(exported.contentLoss());
      if (loss.count !== 0 || loss.losses?.length) throw Error('source fixture export reported content loss');
      fs.writeFileSync(destination, exported.takeBytes(), {flag: 'wx'});
    } finally { exported.free(); }
  } finally { doc.free(); }
}

exportDoc('textbox', process.argv[1]);
exportDoc('ellipse', process.argv[2]);
"""

HWP5 = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation),rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const exported=doc.exportHwpWithReport();
  try {
    const loss=JSON.parse(exported.contentLoss());
    if(loss.count!==0||loss.losses?.length)throw Error(`HWP5 conversion lost content: ${JSON.stringify(loss)}`);
    fs.writeFileSync(process.argv[2],exported.takeBytes(),{flag:'wx'});
  } finally { exported.free(); }
} finally { doc.free(); }
"""

PICTURE = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation),rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAcElEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bdu2bdu2bWmMnpZKr54yMyLu+Xa3anqmhztr1a9++bs+mn8Fgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8dgn8d/hF2lQEx/PxXPQAAAABJRU5ErkJggg==','base64');
const doc=rhwp.HwpDocument.createEmpty();
try {
  doc.createBlankDocument();
  doc.insertText(0,0,0,'body parent sibling');
  const owner=JSON.parse(doc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:5,
    shapeType:'textbox',width:18000,height:12000,treatAsChar:true,textWrap:'Square'})));
  if(owner.ok!==true)throw Error('could not create source textbox');
  const ownerProps=JSON.parse(doc.setShapeProperties(0,0,owner.controlIdx,
    JSON.stringify({tbVerticalAlign:'Bottom',tbMarginLeft:640,tbMarginTop:310})));
  if(ownerProps.ok!==true)throw Error('could not set source textbox properties');
  doc.insertTextInCell(0,0,owner.controlIdx,0,0,0,'nested picture owner paragraph');
  const picture=JSON.parse(doc.insertPicture(0,0,0,'[]',new Uint8Array(png),4000,2000,1200,1200,'png','Nested textbox picture'));
  if(picture.ok!==true)throw Error('could not create source picture');
  const inline=JSON.parse(doc.setPictureProperties(0,picture.paraIdx,picture.controlIdx,JSON.stringify({treatAsChar:true})));
  if(inline.ok!==true)throw Error('could not make the source picture an inline textbox paragraph child');
  const exported=doc.exportHwpxWithReport();
  try {
    const loss=JSON.parse(exported.contentLoss());
    if(loss.count!==0||loss.losses?.length)throw Error(`source fixture export reported content loss: ${JSON.stringify(loss)}`);
    fs.writeFileSync(process.argv[1],exported.takeBytes(),{flag:'wx'});
  } finally {exported.free()}
} finally {doc.free()}
"""

PICTURE_INSPECT = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation),rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
 const controls=JSON.parse(doc.getControls()),model=JSON.parse(doc.getCursorModel());
 const pages=Array.from({length:doc.pageCount()},(_,page)=>JSON.parse(doc.getPageControlLayout(page)).controls
   .map(control=>({...control,page})));
 const pictures=pages.flat().filter(control=>control.type==='image'&&Array.isArray(control.cellPath));
 if(pictures.length!==1)throw Error(`expected exactly one textbox-owned picture, found ${pictures.length}`);
 const child=pictures[0],ownerPath=child.cellPath;
 const picture=JSON.parse(doc.getCellPictureByPath(child.secIdx,child.parentParaIdx,JSON.stringify(ownerPath),child.controlIdx));
 const rawPicture=JSON.parse(doc.getCellPicturePropertiesByPath(child.secIdx,child.parentParaIdx,JSON.stringify(ownerPath),child.controlIdx));
 const owner=JSON.parse(doc.getShapeProperties(child.secIdx,child.parentParaIdx,ownerPath[0].controlIndex));
 const ownerControl=controls.filter(control=>control.list===0&&control.para===child.parentParaIdx
   &&control.controlIndex===ownerPath[0].controlIndex);
 const body=Array.from({length:doc.getParagraphCount(0)},(_,para)=>
   doc.getTextRange(0,para,0,doc.getParagraphLength(0,para)));
 console.log(JSON.stringify({generation:release.generation,format:doc.getSourceFormat(),body,modelLists:model.lists,
   child,ownerPath,picture,rawPicture,owner,ownerControl}));
} finally {doc.free()}
"""


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def release_info() -> dict:
    artifacts = ROOT / "public/rhwp"
    release = json.loads((artifacts / "RELEASE.json").read_text())
    if release.get("engine") != "rhwp" or release.get("commit") != RHWP_PIN or release.get("profile") != "release":
        raise RuntimeError("fixture preparation requires the pinned RHWP Release product")
    patch = next((item for item in release.get("integration", {}).get("patches", [])
                  if item.get("name") == PATCH), None)
    if not patch or patch.get("sha256") != sha(ROOT / "patches/rhwp" / PATCH):
        raise RuntimeError("Release product does not contain the current textbox owner-path patch")
    generation = artifacts / "generations" / release["generation"]
    for name, expected in release.get("artifacts", {}).items():
        if sha(generation / name) != expected:
            raise RuntimeError(f"RHWP Release artifact hash mismatch: {name}")
    return release


def add_nested_ellipse(base: Path, ellipse: Path, output: Path) -> dict:
    with zipfile.ZipFile(base) as package:
        entries = {item.filename: (item, package.read(item.filename)) for item in package.infolist()}
    with zipfile.ZipFile(ellipse) as package:
        source_section = package.read("Contents/section0.xml")
    nested = re.search(rb"<hp:ellipse\b[^>]*>.*?</hp:ellipse>", source_section, re.S)
    if not nested:
        raise RuntimeError("RHWP did not serialize the source ellipse as an HWPX ellipse")
    child = nested.group(0)

    section_name = "Contents/section0.xml"
    info, section = entries[section_name]
    parent = re.search(rb"<hp:rect\b[^>]*>.*?<hp:drawText\b.*?</hp:drawText>.*?</hp:rect>", section, re.S)
    if not parent:
        raise RuntimeError("generated source HWPX lacks its textbox rectangle")
    owner = parent.group(0)
    id_values = [int(value) for value in re.findall(rb"\bid=\"(\d+)\"", section)]
    instance_values = [int(value) for value in re.findall(rb"\binstid=\"(\d+)\"", section)]
    shape_id = max(id_values, default=2_112_000_000) + 1
    instance_id = max(instance_values, default=1_038_000_000) + 1
    replacements = [
        (rb"\bid=\"\d+\"", f'id="{shape_id}"'.encode(), 1),
        (rb"\binstid=\"\d+\"", f'instid="{instance_id}"'.encode(), 1),
        (rb"\bzOrder=\"\d+\"", b'zOrder="1"', 1),
        (rb"\bgroupLevel=\"\d+\"", b'groupLevel="0"', 1),
    ]
    for pattern, replacement, expected in replacements:
        child, count = re.subn(pattern, replacement, child)
        if count != expected:
            raise RuntimeError(f"expected {expected} shape attribute replacements, got {count}: {pattern!r}")

    draw_text = section.find(b"<hp:drawText")
    para_start = section.rfind(b"<hp:p", 0, draw_text)
    para_end = section.find(b"</hp:p>", draw_text)
    run_end = section.rfind(b"</hp:run>", para_start, para_end)
    if min(draw_text, para_start, para_end, run_end) < 0:
        raise RuntimeError("could not find the first textbox-owned paragraph and run")
    insert_at = run_end + len(b"</hp:run>")
    nested_run = b'<hp:run charPrIDRef="0">' + child + b"</hp:run>"
    entries[section_name] = (info, section[:insert_at] + nested_run + section[insert_at:])
    with zipfile.ZipFile(output, "w") as package:
        for name, (item, contents) in entries.items():
            package.writestr(item, contents)
    # RHWP's `instanceId` maps to the HWPX id attribute; `scInstId` maps to instid.
    return {"instanceId": shape_id, "scInstId": instance_id, "parentXml": owner.decode("utf-8")}


def add_nested_picture(source: Path, output: Path) -> dict:
    with zipfile.ZipFile(source) as package:
        entries = {item.filename: (item, package.read(item.filename)) for item in package.infolist()}
    section_name = "Contents/section0.xml"
    info, section = entries[section_name]
    match = re.search(rb"<hp:pic\b[^>]*>.*?</hp:pic>", section, re.S)
    if not match:
        raise RuntimeError("generated source HWPX lacks its picture control")
    picture = match.group(0)
    id_values = [int(value) for value in re.findall(rb'\bid="(\d+)"', section)]
    instance_values = [int(value) for value in re.findall(rb'\binstid="(\d+)"', section)]
    picture_id = max(id_values, default=2_112_000_000) + 1
    picture_sc_instance = max(instance_values, default=1_038_000_000) + 1
    for pattern, replacement in ((rb'\bid="\d+"', f'id="{picture_id}"'.encode()),
                                 (rb'\binstid="\d+"', f'instid="{picture_sc_instance}"'.encode()),
                                 (rb'\bzOrder="\d+"', b'zOrder="1"')):
        picture, count = re.subn(pattern, replacement, picture, count=1)
        if count != 1:
            raise RuntimeError(f"could not assign a stable nested picture identity: {pattern!r}")
    section = section[:match.start()] + section[match.end():]

    parent = re.search(rb"<hp:rect\b[^>]*>.*?<hp:drawText\b.*?</hp:drawText>.*?</hp:rect>", section, re.S)
    if not parent:
        raise RuntimeError("generated source HWPX lacks its textbox rectangle")
    owner = parent.group(0)
    draw_text = owner.find(b"<hp:drawText")
    para_start = owner.find(b"<hp:p", draw_text)
    para_end = owner.find(b"</hp:p>", para_start)
    run_end = owner.find(b"</hp:run>", para_start, para_end)
    if min(draw_text, para_start, para_end, run_end) < 0:
        raise RuntimeError("could not find the textbox-owned paragraph run")
    insert_at = parent.start() + run_end + len(b"</hp:run>")
    nested_run = b'<hp:run charPrIDRef="0">' + picture + b"</hp:run>"
    entries[section_name] = (info, section[:insert_at] + nested_run + section[insert_at:])
    with zipfile.ZipFile(output, "w") as package:
        for name, (item, contents) in entries.items():
            package.writestr(item, contents)
    return {"instanceId": picture_id, "scInstId": picture_sc_instance}


def inspect_fixture(path: Path, generation: str, expected_instance: int,
                    expected_sc_inst_id: int, expected_format: str) -> dict:
    script = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation),rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
 const controls=JSON.parse(doc.getControls()),model=JSON.parse(doc.getCursorModel());
 const layout=Array.from({length:doc.pageCount()},(_,page)=>JSON.parse(doc.getPageControlLayout(page)).controls
   .map(control=>({...control,page})));
 const shapes=layout.flat().filter(control=>control.type==='shape'&&Array.isArray(control.cellPath));
 if(shapes.length!==1)throw Error(`expected one textbox-owned child shape, found ${shapes.length}`);
 const child=shapes[0],ownerAddress=child.cellPath[0];
 const owner=JSON.parse(doc.getShapeProperties(child.secIdx,child.paraIdx,ownerAddress.controlIndex));
 const childProperties=JSON.parse(doc.getCellShapePropertiesByPath(child.secIdx,child.paraIdx,
   JSON.stringify(child.cellPath),child.controlIdx));
 const ownerControl=controls.filter(control=>control.list===0&&control.para===child.paraIdx
   &&control.controlIndex===ownerAddress.controlIndex);
 const ownerLists=model.lists.filter(list=>!list.isCell&&list.hostListId===0
   &&list.sectionIndex===child.secIdx&&list.hostPara===child.paraIdx
   &&list.controlIndex===ownerAddress.controlIndex&&list.cellIndex===ownerAddress.cellIndex);
 const body=Array.from({length:doc.getParagraphCount(0)},(_,para)=>
   doc.getTextRange(0,para,0,doc.getParagraphLength(0,para)));
 console.log(JSON.stringify({generation:release.generation,format:doc.getSourceFormat(),pageCount:doc.pageCount(),
   body,controls,ownerLists,child,owner,childProperties}));
} finally {doc.free()}
"""
    result = json.loads(subprocess.check_output(["node", "-e", script, str(path)], cwd=ROOT, text=True))
    if result["generation"] != generation or result["format"] != expected_format:
        raise RuntimeError(f"generated fixture is not bound to the requested {expected_format} Release engine")
    child, owner = result["child"], result["owner"]
    if child["cellPath"] != [{"controlIndex": 2, "cellIndex": 0, "cellParaIndex": 0}]:
        raise RuntimeError(f"unexpected textbox owner path: {child['cellPath']}")
    if result["ownerLists"][0]["paraCount"] != 1 or owner.get("tbVerticalAlign") != "Bottom":
        raise RuntimeError("textbox parent is not a single-list owned text box")
    if (child["controlIdx"] != 0 or result["childProperties"].get("instanceId") != expected_instance
            or result["childProperties"].get("scInstId") != expected_sc_inst_id):
        raise RuntimeError("nested shape identity did not roundtrip")
    if result["childProperties"].get("fillBgColor") != 0x00336699:
        raise RuntimeError("nested ellipse source fill differs")
    return result


def inspect_picture_fixture(path: Path, generation: str, expected_format: str) -> dict:
    result = json.loads(subprocess.check_output(["node", "-e", PICTURE_INSPECT, str(path)], cwd=ROOT, text=True))
    child, picture, owner = result["child"], result["picture"], result["owner"]
    if result["generation"] != generation or result["format"] != expected_format:
        raise RuntimeError(f"generated textbox-picture fixture is not bound to {expected_format} Release engine")
    if result["body"] != ["body parent sibling"]:
        raise RuntimeError(f"nested picture fixture changed top-level body text: {result['body']}")
    if result["ownerPath"] != [{"controlIndex": 2, "cellIndex": 0, "cellParaIndex": 0}]:
        raise RuntimeError(f"unexpected picture textbox owner path: {result['ownerPath']}")
    if owner.get("tbVerticalAlign") != "Bottom" or owner.get("width") != 18000 or owner.get("height") != 12000:
        raise RuntimeError("textbox owner geometry or paragraph layout differs from source")
    if len(result["ownerControl"]) != 1 or result["ownerControl"][0].get("ctrlId") != "gso":
        raise RuntimeError("picture does not have one exact shape owner control")
    if picture.get("ok") is not True or not isinstance(picture.get("instanceId"), int) or picture["instanceId"] < 1:
        raise RuntimeError("textbox picture identity is not inspectable")
    if not isinstance(picture.get("binDataId"), int) or picture["binDataId"] < 1:
        raise RuntimeError("textbox picture has no exact binary resource owner")
    if picture.get("treatAsChar") is not True or result["rawPicture"].get("treatAsChar") is not True:
        raise RuntimeError("textbox picture source is not inline in its paragraph owner")
    if (picture.get("width"), picture.get("height"), picture.get("byteLength")) != (4000, 2000, 169):
        raise RuntimeError("textbox picture dimensions or resource length differ from source")
    if picture.get("sha256") != "2e0817c744876e5f3ef3d890ab2601a435cc41a1d4507f67295c4ad968b623b2":
        raise RuntimeError("textbox picture bytes differ from the deterministic PNG fixture")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    if out.exists() or out.is_symlink():
        raise RuntimeError(f"refusing to overwrite fixture output: {out}")
    release = release_info()
    out.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="p5-tb-control-", dir=out.parent) as temporary:
        base, ellipse = Path(temporary) / "textbox.hwpx", Path(temporary) / "ellipse.hwpx"
        subprocess.run(["node", "-e", NODE, str(base), str(ellipse)], cwd=ROOT, check=True)
        fixture = out / "p5-tb-control-hwpx-shape.hwpx"
        identity = add_nested_ellipse(base, ellipse, fixture)
    hwp5_fixture = out / "p5-tb-control-hwp5-shape.hwp"
    subprocess.run(["node", "-e", HWP5, str(fixture), str(hwp5_fixture)], cwd=ROOT, check=True)
    hwpx_model = inspect_fixture(fixture, release["generation"], identity["instanceId"],
                                 identity["scInstId"], "hwpx")
    hwp5_model = inspect_fixture(hwp5_fixture, release["generation"], identity["instanceId"],
                                 identity["scInstId"], "hwp")
    if hwpx_model["childProperties"] != hwp5_model["childProperties"]:
        # The serializers can normalize format-specific placement fields. Identity, geometry,
        # and fill are the cross-format contract established by this fixture conversion.
        for key in ("instanceId", "scInstId", "width", "height", "fillBgColor"):
            if hwpx_model["childProperties"].get(key) != hwp5_model["childProperties"].get(key):
                raise RuntimeError(f"HWP5 roundtrip changed nested shape {key}")
    picture_source = out / "p5-tb-control-textbox-picture-source.hwpx"
    subprocess.run(["node", "-e", PICTURE, str(picture_source)], cwd=ROOT, check=True)
    picture_hwpx = out / "p5-tb-control-hwpx-picture.hwpx"
    picture_identity = add_nested_picture(picture_source, picture_hwpx)
    picture_hwp = out / "p5-tb-control-hwp5-picture.hwp"
    subprocess.run(["node", "-e", HWP5, str(picture_hwpx), str(picture_hwp)], cwd=ROOT, check=True)
    picture_hwpx_model = inspect_picture_fixture(picture_hwpx, release["generation"], "hwpx")
    picture_hwp_model = inspect_picture_fixture(picture_hwp, release["generation"], "hwp")
    for label, model in (("HWPX", picture_hwpx_model), ("HWP5", picture_hwp_model)):
        if model["picture"].get("instanceId") != picture_identity["instanceId"]:
            raise RuntimeError(f"{label} changed the nested picture instance identity")
    manifest = {
        "schemaVersion": 1,
        "issueId": "P5-TB-CONTROL",
        "fixture": fixture.name,
        "fixtureSha256": sha(fixture),
        "hwp5Fixture": hwp5_fixture.name,
        "hwp5FixtureSha256": sha(hwp5_fixture),
        "rhwpPin": RHWP_PIN,
        "rhwpGeneration": release["generation"],
        "rhwpArtifacts": release["artifacts"],
        "orderedPatchCount": len(release["integration"]["patches"]),
        "nestedShapeInstanceId": identity["instanceId"],
        "nestedShapeScInstId": identity["scInstId"],
        "model": {"hwpx": {"child": hwpx_model["child"], "owner": hwpx_model["owner"],
                             "childProperties": hwpx_model["childProperties"]},
                  "hwp": {"child": hwp5_model["child"], "owner": hwp5_model["owner"],
                          "childProperties": hwp5_model["childProperties"]}},
        "nestedPicture": {
            "hwpx": {"fixture": picture_hwpx.name, "fixtureSha256": sha(picture_hwpx),
                     "model": picture_hwpx_model},
            "hwp": {"fixture": picture_hwp.name, "fixtureSha256": sha(picture_hwp),
                    "model": picture_hwp_model},
            "sourceInstanceId": picture_identity["instanceId"],
            "sourceScInstId": picture_identity["scInstId"],
        },
    }
    (out / "fixture-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
