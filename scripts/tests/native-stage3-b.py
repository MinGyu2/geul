#!/usr/bin/env python3
"""Stage 3-B Release Linux X11 GUI acceptance. Run under native-ibus-session.py."""
import argparse
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import traceback
from xml.etree import ElementTree
from zipfile import ZipFile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load("native-stage3-c")
p6 = c.p6
p4 = c.p4
FRAME = c.FRAME
SHAPE = p6.SHAPE
TOOLS = p6.TOOLS
require = c.require
digest = c.digest
begin = c.begin
revision = c.revision
publish = c.publish
reopen = c.reopen
select_object = c.select_object


def inspect_hwp(path):
    return c.inspect_rhwp(path, """
      const all = pages.flatMap((p, page) => p.map(item => ({...item, page})));
      const withProps = type => all.filter(x => x.type === type).map(x => ({
        ...x,
        props: JSON.parse((type === 'image' ? doc.getPictureProperties : doc.getShapeProperties)
          .call(doc, x.secIdx, x.paraIdx, x.controlIdx)),
      }));
      const readCellTexts = (owner, cell) => {
        const count = doc.getCellParagraphCount(owner.secIdx, owner.paraIdx, owner.controlIdx, cell);
        return Array.from({length: count}, (_, i) => {
          const len = doc.getCellParagraphLength(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, i);
          return doc.getTextInCell(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, i, 0, len);
        });
      };
      const caption = (owner, cell) => {
        const len = doc.getCellParagraphLength(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, 0);
        return {
          cell,
          texts: readCellTexts(owner, cell),
          end: JSON.parse(doc.getCursorRectInCell(owner.secIdx, owner.paraIdx, owner.controlIdx, cell, 0, len)),
        };
      };
      const images = withProps('image').map(img => ({
        ...img,
        caption: img.props.hasCaption ? caption(img, 0) : null,
      }));
      const shapes = withProps('shape').map(shp => ({
        ...shp,
        caption: shp.props.hasCaption ? caption(shp, 65534) : null,
      }));
      const groups = withProps('group');
      console.log(JSON.stringify({body, controls, images, shapes, groups}));
    """)


def inspect_hwpx_clip(path):
    return c.inspect_rhwp(path, """
      const all = pages.flatMap((p, page) => p.map(item => ({...item, page})));
      const shapes = all.filter(x => x.type === 'shape' || x.type === 'group').map(x => {
        const props = JSON.parse(doc.getShapeProperties(x.secIdx, x.paraIdx, x.controlIdx));
        let capTexts = null, capBold = null, capAlign = null, boxTexts = null, boxAlign = null, boxRun = null;
        if (props.hasCaption) {
          const cnt = doc.getCellParagraphCount(x.secIdx, x.paraIdx, x.controlIdx, 65534);
          capTexts = Array.from({length: cnt}, (_, i) => {
            const len = doc.getCellParagraphLength(x.secIdx, x.paraIdx, x.controlIdx, 65534, i);
            return doc.getTextInCell(x.secIdx, x.paraIdx, x.controlIdx, 65534, i, 0, len);
          });
          capAlign = capTexts.map((_, cellParaIndex) => JSON.parse(doc.getCellParaPropertiesAtByPath(x.secIdx, x.paraIdx,
            JSON.stringify([{controlIndex: x.controlIdx, cellIndex: 65534, cellParaIndex}]))).alignment);
          const p0Len = doc.getCellParagraphLength(x.secIdx, x.paraIdx, x.controlIdx, 65534, 0);
          capBold = p0Len > 0 ? JSON.parse(doc.getCellCharPropertiesAt(x.secIdx, x.paraIdx, x.controlIdx, 65534, 0, p0Len - 1)).bold : null;
        }
        try {
          const bcnt = doc.getCellParagraphCount(x.secIdx, x.paraIdx, x.controlIdx, 0);
          if (bcnt > 0) {
            boxTexts = Array.from({length: bcnt}, (_, i) => {
              const len = doc.getCellParagraphLength(x.secIdx, x.paraIdx, x.controlIdx, 0, i);
              return doc.getTextInCell(x.secIdx, x.paraIdx, x.controlIdx, 0, i, 0, len);
            });
            const bp = JSON.stringify([{controlIndex: x.controlIdx, cellIndex: 0, cellParaIndex: 0}]);
            boxAlign = JSON.parse(doc.getCellParaPropertiesAtByPath(x.secIdx, x.paraIdx, bp)).alignment;
            if (boxTexts[0].length > 7) {
              boxRun = JSON.parse(doc.getCellCharPropertiesAt(x.secIdx, x.paraIdx, x.controlIdx, 0, 0, 7));
            }
          }
        } catch {}
        return {...x, props, capTexts, capBold, capAlign, boxTexts, boxAlign, boxRun};
      });
      const pictures = all.filter(x => x.type === "image").map(x => {
        const props = JSON.parse(doc.getPictureProperties(x.secIdx, x.paraIdx, x.controlIdx));
        const bytes = doc.getControlImageData(x.secIdx, x.paraIdx, "[]", x.controlIdx);
        const sha256 = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
        return {...x, props, sha256};
      });
      console.log(JSON.stringify({body, shapes, pictures}));
    """)


def prepare_p6_hx_group_fixtures(out):
    source = out / "p6-hx-group-source.fixture.hwpx"
    destination = out / "p6-hx-group-destination.fixture.hwpx"
    marker = "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));"
    create = r"""
const sourcePath=process.argv[1], destinationPath=process.argv[2];
const sourceDoc=rhwp.HwpDocument.createEmpty();
const targetDoc=rhwp.HwpDocument.createEmpty();
const ok=(raw,label)=>{const value=JSON.parse(raw);if(value.ok!==true)throw Error(label+': '+JSON.stringify(value));return value;};
try {
  sourceDoc.createBlankDocument();
  sourceDoc.insertText(0,0,0,'source body');
  const rect=ok(sourceDoc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,
    shapeType:'rectangle',width:4100,height:2600,treatAsChar:true,textWrap:'Square',horzOffset:1700,vertOffset:2200})), 'rectangle');
  const ellipse=ok(sourceDoc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,
    shapeType:'ellipse',width:2200,height:2200,treatAsChar:true,textWrap:'Square',horzOffset:7600,vertOffset:2500})), 'ellipse');
  ok(sourceDoc.setShapeProperties(0,0,rect.controlIdx,
    '{"rotationAngle":23,"horzFlip":true,"fillType":"solid","fillBgColor":1122867}'), 'rectangle properties');
  const inner=ok(sourceDoc.groupShapes(JSON.stringify({sectionIdx:0,targets:[
    {paraIdx:0,controlIdx:rect.controlIdx},{paraIdx:0,controlIdx:ellipse.controlIdx}]})), 'inner group');
  const pictureBytes=fs.readFileSync(path.resolve('src-tauri/icons/32x32.png'));
  const picture=ok(sourceDoc.insertPicture(0,0,0,'[]',pictureBytes,3200,1800,32,32,'png','group media'), 'group picture');
  ok(sourceDoc.setPictureProperties(0,0,picture.controlIdx,
    '{"treatAsChar":true,"textWrap":"Square","horzOffset":10800,"vertOffset":2200}'), 'group picture properties');
  const controls=JSON.parse(sourceDoc.getPageControlLayout(0)).controls;
  const nested=controls.find(item=>item.type==='group');
  const image=controls.find(item=>item.type==='image');
  if(!nested||!image||!Array.isArray(nested.stableIndex)||!Array.isArray(image.stableIndex))
    throw Error('nested group or picture owner is missing');
  ok(sourceDoc.groupShapes(JSON.stringify({sectionIdx:0,targets:[nested,image].map(item=>({
    paraIdx:item.stableIndex[1],controlIdx:item.stableIndex[2]}))})), 'outer group');
  fs.writeFileSync(sourcePath,sourceDoc.exportHwpx());

  targetDoc.createBlankDocument();
  targetDoc.insertText(0,0,0,'destination body');
  const keep=ok(targetDoc.insertPicture(0,0,0,'[]',fs.readFileSync(path.resolve('src-tauri/icons/128x128.png')),
    1800,900,128,128,'png','keep me'), 'destination picture');
  ok(targetDoc.setPictureProperties(0,0,keep.controlIdx,
    '{"treatAsChar":true,"textWrap":"Square","horzOffset":2200,"vertOffset":3100}'), 'destination picture properties');
  fs.writeFileSync(destinationPath,targetDoc.exportHwpx());
} finally { sourceDoc.free(); targetDoc.free(); }
"""
    template = p6.ORACLE.split("try {", 1)[0]
    require(marker in template, "P6 group fixture template is stale")
    script = template.replace(marker, create)
    subprocess.run(["node", "-e", script, str(source), str(destination)], cwd=ROOT, check=True)
    return source, destination


def inspect_hwpx_group(path):
    return c.inspect_rhwp(path, """
      const all=pages.flatMap((items,page)=>items.map(item=>({...item,page})));
      const group=all.find(item=>item.type==='group')||null;
      const children=group?JSON.parse(doc.getEditableGroupChildren(group.secIdx,group.paraIdx,group.controlIdx)):null;
      const owner=group?controls.filter(item=>item.ctrlId==='gso'&&item.list===0
        &&item.para===group.paraIdx&&item.controlIndex===group.controlIdx):[];
      console.log(JSON.stringify({group,children,owner}));
    """)


def _local_xml_name(node):
    return node.tag.rsplit("}", 1)[-1]


def _normalized_group_xml(node):
    omitted = {"id", "instid", "href", "binaryItemIDRef"}
    attrs = tuple(sorted((key.rsplit("}", 1)[-1], value) for key, value in node.attrib.items()
                         if key.rsplit("}", 1)[-1] not in omitted))
    return (_local_xml_name(node), attrs, (node.text or "").strip(),
            tuple(_normalized_group_xml(child) for child in node))


def hwpx_group_snapshot(path):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    hc = "{http://www.hancom.co.kr/hwpml/2011/core}"
    opf = "{http://www.idpf.org/2007/opf/}"
    owned = {"container", "rect", "ellipse", "line", "arc", "polygon", "curve", "pic", "chart", "ole"}
    with ZipFile(path) as package:
        names = package.namelist()
        root = ElementTree.fromstring(package.read("Contents/section0.xml"))
        content = ElementTree.fromstring(package.read("Contents/content.hpf"))
        parents = {child: parent for parent in root.iter() for child in list(parent)}
        containers = [node for node in root.iter(hp + "container")]
        roots = []
        for node in containers:
            ancestor = parents.get(node)
            nested = False
            while ancestor is not None:
                if ancestor.tag == hp + "container":
                    nested = True
                    break
                ancestor = parents.get(ancestor)
            if not nested:
                roots.append(node)
        require(len(roots) == 1, "HWPX package must have one top-level group", len(roots))
        group = roots[0]
        picture = group.find(".//" + hp + "pic")
        require(picture is not None, "group has no embedded picture child")
        image = picture.find(hc + "img")
        require(image is not None, "group picture has no image resource reference")
        resource_id = image.get("binaryItemIDRef")
        items = [item for item in content.iter(opf + "item") if item.get("id") == resource_id]
        require(len(items) == 1, "group picture resource relationship is ambiguous", resource_id)
        resource = items[0].get("href")
        require(resource in names, "group picture relationship is unresolved", resource)
        owner = parents.get(group)
        while owner is not None and owner.tag != hp + "p":
            owner = parents.get(owner)
        require(owner is not None, "group has no body paragraph owner")
        group_nodes = [node for node in group.iter() if _local_xml_name(node) in owned]
        group_ids = [node.get("id") for node in group.iter() if node.get("id") is not None]
        group_instids = [node.get("instid") for node in group.iter() if node.get("instid") is not None]
        object_nodes = [node for node in root.iter() if _local_xml_name(node) in owned]
        object_ids = [node.get("id") for node in object_nodes if node.get("id") is not None]
        object_instids = [node.get("instid") for node in object_nodes if node.get("instid") is not None]
        media = {name: hashlib.sha256(package.read(name)).hexdigest()
                 for name in names if name.startswith("BinData/")}
        parts = {name: hashlib.sha256(package.read(name)).hexdigest() for name in names}
        direct = [_local_xml_name(node) for node in group if _local_xml_name(node) in owned]
        inner = group.find(hp + "container")
        inner_direct = ([_local_xml_name(node) for node in inner if _local_xml_name(node) in owned]
                        if inner is not None else [])
        return {
            "groupTree": _normalized_group_xml(group), "directChildren": direct,
            "nestedChildren": inner_direct, "resource": resource,
            "assetSha256": hashlib.sha256(package.read(resource)).hexdigest(),
            "media": media, "parts": parts, "groupIds": group_ids,
            "groupInstIds": group_instids, "objectIds": object_ids,
            "objectInstIds": object_instids, "ownerParagraph": owner.get("id"),
        }


def hwpx_object_ids(path):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    owned = {"container", "rect", "ellipse", "line", "arc", "polygon", "curve", "pic", "chart", "ole"}
    with ZipFile(path) as package:
        ids = []
        for name in package.namelist():
            if not name.startswith("Contents/section") or not name.endswith(".xml"):
                continue
            root = ElementTree.fromstring(package.read(name))
            ids.extend(node.get("id") for node in root.iter()
                       if _local_xml_name(node) in owned and node.get("id") is not None)
        return ids


def hwpx_object_instance_ids(path):
    owned = {"container", "rect", "ellipse", "line", "arc", "polygon", "curve", "pic", "chart", "ole"}
    with ZipFile(path) as package:
        ids = []
        for name in package.namelist():
            if not name.startswith("Contents/section") or not name.endswith(".xml"):
                continue
            root = ElementTree.fromstring(package.read(name))
            ids.extend(node.get("instid") for node in root.iter()
                       if _local_xml_name(node) in owned and node.get("instid") is not None)
        return ids


def prove_p6_hx_group_copy(source, destination_before, destination_after):
    source_group = hwpx_group_snapshot(source)
    source_ids = set(source_group["groupIds"]) - {"0"}
    source_instance_ids = set(source_group["groupInstIds"]) - {"0"}
    destination_ids_before = hwpx_object_ids(destination_before)
    destination_ids_after = hwpx_object_ids(destination_after)
    destination_instance_ids_before = hwpx_object_instance_ids(destination_before)
    destination_instance_ids_after = hwpx_object_instance_ids(destination_after)
    # The destination fixture contains no group; inspect its resources and package parts directly.
    with ZipFile(destination_before) as original, ZipFile(destination_after) as saved:
        old_names, new_names = set(original.namelist()), set(saved.namelist())
        require(old_names <= new_names, "group paste removed unrelated OPC parts",
                {"removed": sorted(old_names - new_names)})
        old_media = {name: hashlib.sha256(original.read(name)).hexdigest()
                     for name in old_names if name.startswith("BinData/")}
        new_media = {name: hashlib.sha256(saved.read(name)).hexdigest()
                     for name in new_names if name.startswith("BinData/")}
        require(all(new_media.get(name) == digest for name, digest in old_media.items()),
                "group paste changed an unrelated destination resource")
        added = new_names - old_names
        after = hwpx_group_snapshot(destination_after)
        require(added == {after["resource"]}, "group paste added an unexpected package part", sorted(added))
        changed = sorted(name for name in old_names if original.read(name) != saved.read(name))
        allowed = {"Contents/section0.xml", "Contents/header.xml", "Contents/content.hpf",
                   "Preview/PrvImage.png", "Preview/PrvText.txt"}
        require("Contents/section0.xml" in changed and set(changed) <= allowed,
                "group paste changed unrelated OPC data", changed)
    require(source_group["directChildren"] == ["container", "pic"]
            and source_group["nestedChildren"] == ["rect", "ellipse"],
            "source fixture does not contain the expected nested group", source_group)
    require(after["groupTree"] == source_group["groupTree"],
            "saved group hierarchy, geometry, or formatting differs from source")
    require(after["assetSha256"] == source_group["assetSha256"],
            "saved group picture does not reference the source media bytes")
    require(after["resource"] not in old_media, "group picture reused or aliased destination media", after["resource"])
    require(len(after["media"]) == len(old_media) + 1, "group resource count is incorrect", after["media"])
    require(len(after["groupIds"]) == len(set(after["groupIds"]))
            and "0" not in after["groupIds"]
            and set(after["groupIds"]).isdisjoint(source_ids)
            and set(after["groupIds"]).isdisjoint(destination_ids_before),
            "group object identifiers were not independently remapped", after["groupIds"])
    require(len(destination_ids_after) == len(set(destination_ids_after))
            and set(destination_ids_before).issubset(destination_ids_after)
            and set(after["groupIds"]).issubset(destination_ids_after),
            "destination object identifiers are duplicated or existing objects were reidentified",
            {"before": destination_ids_before, "after": destination_ids_after,
             "group": after["groupIds"]})
    new_group_instance_ids = [item for item in after["groupInstIds"] if item != "0"]
    existing_instance_ids = set(destination_instance_ids_before) - {"0"}
    require(len(new_group_instance_ids) == len(set(new_group_instance_ids))
            and set(new_group_instance_ids).isdisjoint(source_instance_ids)
            and set(new_group_instance_ids).isdisjoint(existing_instance_ids),
            "nonzero group instance identifiers were not independently remapped", after["groupInstIds"])
    nonzero_destination_instance_ids_after = [item for item in destination_instance_ids_after if item != "0"]
    require(len(nonzero_destination_instance_ids_after) == len(set(nonzero_destination_instance_ids_after)),
            "destination has duplicate non-default instance identifiers", destination_instance_ids_after)
    return {"sourceTreeSha256": hashlib.sha256(repr(source_group["groupTree"]).encode()).hexdigest(),
            "savedTreeSha256": hashlib.sha256(repr(after["groupTree"]).encode()).hexdigest(),
            "sourcePictureSha256": source_group["assetSha256"], "savedPictureSha256": after["assetSha256"],
            "sourceGroupIds": source_group["groupIds"], "savedGroupIds": after["groupIds"],
            "sourceGroupInstIds": source_group["groupInstIds"],
            "savedGroupInstIds": after["groupInstIds"], "savedPictureResource": after["resource"],
            "destinationMediaBefore": old_media, "destinationMediaAfter": new_media,
            "changedOPCParts": changed, "addedOPCParts": sorted(added),
            "unrelatedDestinationResourcesPreserved": True}


def _group_model(path):
    value = inspect_hwpx_group(path)
    require(value["group"] is not None and len(value["owner"]) == 1,
            "editable group has no unique body owner", value)
    value["editableHierarchy"] = {
        "nestedGroupAndLeafChildren": True,
        "flatChildEditorExposesTree": value["children"] is not None,
    }
    return value


def _canvas_digest(acc):
    data = acc.d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL('image/png'))")
    return hashlib.sha256(json.dumps(data, separators=(",", ":")).encode()).hexdigest()


def p6_hx_group(acc, row, b_root, out):
    source_fixture, target_fixture = prepare_p6_hx_group_fixtures(out)
    source = out / "p6-hx-group-source.hwpx"
    destination = out / "p6-hx-group-destination.hwpx"
    shutil.copyfile(source_fixture, source)
    shutil.copyfile(target_fixture, destination)
    source_hash = digest(source)
    before_source = row["beforeSource"] = inspect_hwpx_clip(source)
    before_destination = row["beforeDestination"] = inspect_hwpx_clip(destination)
    source_xml = hwpx_group_snapshot(source)
    row["fixtureHashes"] = {"source": source_hash, "destination": digest(destination)}
    source_groups = [item for item in before_source["shapes"] if item["type"] == "group"]
    require(len(source_groups) == 1 and not before_destination["shapes"],
            "P6 fixture object inventory is unexpected", [before_source, before_destination])
    source_group = source_groups[0]
    require(source_xml["directChildren"] == ["container", "pic"]
            and source_xml["nestedChildren"] == ["rect", "ellipse"],
            "P6 source fixture lost the nested group tree", source_xml)
    target_picture, = before_destination["pictures"]

    acc.d.js("""
      window.p6GroupPointers=[]; window.p6GroupKeys=[];
      document.addEventListener('pointerdown',e=>{
        if(e.target instanceof Element&&e.target.closest('.rhwp-page'))
          window.p6GroupPointers.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});
      },true);
      document.addEventListener('keydown',e=>{
        if(e.ctrlKey&&['c','v','z','y'].includes(e.key.toLowerCase()))
          window.p6GroupKeys.push({key:e.key.toLowerCase(),trusted:e.isTrusted});
      },true);
    """)
    acc.open_native("hwpx", source)
    row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
    require(row["activeGeneration"] == json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())["generation"],
            "app and oracle Release generations differ")
    select_object(acc, source_group, "group")
    row["trustedPointer"] = acc.d.js("return window.p6GroupPointers.slice()")
    require(any(item["trusted"] for item in row["trustedPointer"]), "group selection did not use a trusted pointer")
    acc.key("ctrl+c")
    acc.open_native("hwpx", destination)
    c.body_end(acc)
    before_canvas = _canvas_digest(acc)
    acc.key("ctrl+v")
    row["afterPaste"] = revision(acc, "hwpx", 1)
    pasted_canvas = _canvas_digest(acc)
    require(pasted_canvas != before_canvas, "trusted paste did not change the rendered destination")
    acc.key("ctrl+z")
    row["afterUndo"] = revision(acc, "hwpx", 2)
    undo_canvas = _canvas_digest(acc)
    require(undo_canvas == before_canvas, "Undo did not restore the original rendered destination")
    acc.key("ctrl+y")
    row["afterRedo"] = revision(acc, "hwpx", 3)
    redo_canvas = _canvas_digest(acc)
    require(redo_canvas == pasted_canvas, "Redo did not restore the pasted group rendering")
    row["trustedClipboardKeys"] = acc.d.js("return window.p6GroupKeys.slice()")
    for key in ("c", "v", "z", "y"):
        require(any(item["key"] == key and item["trusted"] for item in row["trustedClipboardKeys"]),
                f"{key.upper()} did not use a trusted Native key")

    require(digest(source) == source_hash, "cross-document copy changed the source file")
    publish(acc, "hwpx", row)
    row["after"] = after = inspect_hwpx_clip(destination)
    # RHWP inserts copied controls into their own paragraph and appends the
    # format-required empty paragraph. At body-end that is exactly two empty
    # paragraphs after the original text; the group's owner is the first one.
    require(after["body"] == before_destination["body"] + ["", ""],
            "group paste changed destination body text or paragraph boundary", after["body"])
    groups = [item for item in after["shapes"] if item["type"] == "group"]
    require(len(groups) == 1 and groups[0]["paraIdx"] == len(before_destination["body"]),
            "published destination does not contain one group in its owned insertion paragraph", groups)
    require(after["pictures"] == [target_picture], "group paste changed the unrelated destination picture")
    row["opcpProof"] = prove_p6_hx_group_copy(source, target_fixture, destination)
    row["editableGroup"] = _group_model(destination)

    reopen(acc, destination, row)
    reopened = inspect_hwpx_clip(destination)
    require(reopened == after, "same-process save/reopen changed the transferred group")
    row["sameProcessReopen"] = {"sha256": digest(destination), "objects": reopened}
    select_object(acc, next(item for item in reopened["shapes"] if item["type"] == "group"), "group")
    row["sameProcessSelection"] = "group remains selectable"


def p6_hx_group_fresh(acc, row, b_root, out):
    source_fixture = out / "p6-hx-group-source.fixture.hwpx"
    target_fixture = out / "p6-hx-group-destination.fixture.hwpx"
    destination = out / "p6-hx-group-destination.hwpx"
    require(source_fixture.is_file() and target_fixture.is_file() and destination.is_file(),
            "saved P6 group fixture is missing")
    previous = json.loads((out / "result.json").read_text())["cases"]["P6-HX-GROUP"]
    row["previousAppPid"] = previous["appPid"]
    require(row["appPid"] != row["previousAppPid"], "fresh reopen reused the prior application process")
    require(digest(destination) == previous["sameProcessReopen"]["sha256"],
            "fresh-process probe did not open the saved package")
    row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
    require(row["activeGeneration"] == json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())["generation"],
            "fresh process uses a different RHWP generation")
    before = inspect_hwpx_clip(destination)
    require(len([item for item in before["shapes"] if item["type"] == "group"]) == 1,
            "fresh process did not reopen the transferred group")
    row["opcpProof"] = prove_p6_hx_group_copy(source_fixture, target_fixture, destination)
    row["editableGroup"] = _group_model(destination)
    acc.open_native("hwpx", destination)
    group = next(item for item in before["shapes"] if item["type"] == "group")
    select_object(acc, group, "group")
    row["freshSession"] = {"sha256": digest(destination), "groupSelectable": True,
                           "pid": row["appPid"], "appSha256": row["processAppSha256"]}


def prepare_b3_2_fixtures(staging: Path):
    src_path = staging / "b3-2-source.hwpx"
    dst_path = staging / "b3-2-dest.hwpx"
    dst2_path = staging / "b3-2-dest-refusal.hwpx"
    node_script = p6.ORACLE.split("try {", 1)[0].replace(
        "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));",
        """
        const srcDoc = rhwp.HwpDocument.createEmpty();
        srcDoc.createBlankDocument();
        srcDoc.insertText(0, 0, 0, 'B3.2 portable source');
        const capRect = JSON.parse(srcDoc.createShapeControl(JSON.stringify({
          sectionIdx:0, paraIdx:0, charOffset:0, shapeType:'rectangle',
          width:4800, height:3000, treatAsChar:false, textWrap:'Square', horzOffset:1500, vertOffset:1500
        })));
        if (!capRect.ok) throw Error('capRect create failed');
        JSON.parse(srcDoc.setShapeProperties(0,0,capRect.controlIdx,
          '{"hasCaption":true,"captionDirection":"Top","fillType":"solid","fillBgColor":11223344}'));
        const capLen = srcDoc.getCellParagraphLength(0,0,capRect.controlIdx,65534,0);
        srcDoc.insertTextInCell(0,0,capRect.controlIdx,65534,0,capLen,'cap bold');
        srcDoc.applyCharFormatInCellByPath(0,0,JSON.stringify([{controlIndex:capRect.controlIdx,cellIndex:65534,cellParaIndex:0}]),capLen+4,capLen+8,'{"bold":true}');
        srcDoc.splitParagraphInCell(0,0,capRect.controlIdx,65534,0,capLen+8);
        srcDoc.insertTextInCell(0,0,capRect.controlIdx,65534,1,0,'cap line 2');
        srcDoc.applyParaFormatInCellByPath(0,0,JSON.stringify([{controlIndex:capRect.controlIdx,cellIndex:65534,cellParaIndex:1}]),
          '{"alignment":"right"}');

        const mixBox = JSON.parse(srcDoc.createShapeControl(JSON.stringify({
          sectionIdx:0, paraIdx:0, charOffset:0, shapeType:'textbox',
          width:5200, height:3200, treatAsChar:false, textWrap:'Square', horzOffset:9000, vertOffset:1500
        })));
        if (!mixBox.ok) throw Error('mixBox create failed');
        if (!JSON.parse(srcDoc.setShapeProperties(0,0,mixBox.controlIdx,JSON.stringify({
          tbVerticalAlign:'Bottom', tbMarginLeft:90, tbMarginRight:110, tbMarginTop:130, tbMarginBottom:150
        }))).ok) throw Error('textbox layout fixture failed');
        srcDoc.insertTextInCell(0,0,mixBox.controlIdx,0,0,0,'plain bold');
        const bp = JSON.stringify([{controlIndex:mixBox.controlIdx,cellIndex:0,cellParaIndex:0}]);
        const fontIds = JSON.parse(srcDoc.resolveDocumentFontFamily('함초롬돋움'));
        srcDoc.applyCharFormatInCellByPath(0,0,bp,6,10,JSON.stringify({
          bold:true, italic:true, fontSize:1400, textColor:'#cc2200', shadeColor:'#ffff00', fontIds
        }));
        srcDoc.applyParaFormatInCellByPath(0,0,bp,'{"alignment":"center"}');
        srcDoc.splitParagraphInCell(0,0,mixBox.controlIdx,0,0,10);
        srcDoc.insertTextInCell(0,0,mixBox.controlIdx,0,1,0,'second line');
        const dotted = JSON.parse(srcDoc.createShapeControl(JSON.stringify({
          sectionIdx:0, paraIdx:0, charOffset:0, shapeType:'rectangle',
          width:4800, height:3000, treatAsChar:false, textWrap:'Square', horzOffset:16500, vertOffset:14000
        })));
        if (!dotted.ok || !JSON.parse(srcDoc.setShapeProperties(0,0,dotted.controlIdx,'{"lineType":3}')).ok) {
          throw Error('DOT rectangle fixture failed');
        }
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAABACAIAAADTQmMRAAAATklEQVR4nO3OMQ0AIBAAsVfCjH8pKMIFx9CkAjpnr69MPhASEhKqB0JCQkL1QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjF4XmIMR3l0LcAAAAAElFTkSuQmCC', 'base64');
        const picture = JSON.parse(srcDoc.insertPicture(0,0,0,'[]',png,4200,2100,48,64,'png','B3.2 cropped'));
        if (!picture.ok || !JSON.parse(srcDoc.setPictureProperties(0,0,picture.controlIdx,JSON.stringify({
          treatAsChar:false, textWrap:'InFrontOfText', horzOffset:11500, vertOffset:8000,
          cropLeft:120, cropTop:60, cropRight:720, cropBottom:90
        }))).ok) throw Error('crop fixture failed');
        fs.writeFileSync(process.argv[1], srcDoc.exportHwpx());
        srcDoc.free();

        const dstDoc = rhwp.HwpDocument.createEmpty();
        dstDoc.createBlankDocument();
        dstDoc.insertText(0, 0, 0, 'Destination document body');
        const dstBytes = dstDoc.exportHwpx();
        fs.writeFileSync(process.argv[2], dstBytes);
        fs.writeFileSync(process.argv[3], dstBytes);
        dstDoc.free();
        process.exit(0);
        """,
    )
    subprocess.check_call(["node", "-e", node_script, str(src_path), str(dst_path), str(dst2_path)], cwd=ROOT)
    return src_path, dst_path, dst2_path


def b1_1(acc, row, b_root, out):
    fixture = b_root / "b1/b1-1-multi-layer-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    require(len(before["shapes"]) == 3, "expected 3 shapes in B1.1 fixture", before["shapes"])
    s2, s3, s4 = sorted(before["shapes"], key=lambda s: s["props"]["zOrder"])
    path = begin(acc, row, fixture, out, "b1-1.hwp")
    overlap_pt = (0, s2["x"] + s2["w"] - 10, s2["y"] + s2["h"] - 10)

    def hit_at(pt, expected):
        p6.pointer(acc, pt)
        acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='shape'", FRAME, timeout=8)
        g = c.frame(acc)
        scale = g["width"] / expected["w"]
        c.require_near(g["left"], expected["x"] * scale, "layer hit identity x")
        return g

    hit_at(overlap_pt, s4)
    acc.dom_click(SHAPE + " button", "Array.from(document.querySelectorAll(arguments[0])).find(b=>b.textContent.trim()===" + json.dumps(p4.KO["properties.shape.back"]) + ")")
    revision(acc, "hwp", 1)
    # s2 (zOrder 0) sits behind s3 (zOrder 1); click its non-overlapping top-left corner and bring it to front.
    s2_free = (0, s2["x"] + 6, s2["y"] + 6)
    hit_at(s2_free, s2)
    acc.dom_click(SHAPE + " button", "Array.from(document.querySelectorAll(arguments[0])).find(b=>b.textContent.trim()===" + json.dumps(p4.KO["properties.shape.front"]) + ")")
    revision(acc, "hwp", 2)
    hit_at(overlap_pt, s2)
    acc.key("ctrl+z")
    revision(acc, "hwp", 3)
    hit_at(overlap_pt, s3)
    acc.key("ctrl+y")
    revision(acc, "hwp", 4)
    hit_at(overlap_pt, s2)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    orders = {s["controlIdx"]: s["props"]["zOrder"] for s in after["shapes"]}
    row["savedZOrders"] = orders
    require(orders[s2["controlIdx"]] > orders[s3["controlIdx"]] > orders[s4["controlIdx"]], "multi z-order final order mismatch", orders)
    require(after["body"] == before["body"], "body changed")
    for a, b in zip(sorted(before["shapes"], key=lambda x: x["controlIdx"]), sorted(after["shapes"], key=lambda x: x["controlIdx"])):
        require(a["props"]["width"] == b["props"]["width"] and a["props"]["height"] == b["props"]["height"], "geometry changed", [a, b])
    reopen(acc, path, row)
    hit_at(overlap_pt, s2)


def b1_2(acc, row, b_root, out):
    fixture = b_root / "b1/b1-2-combined-caption-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    shp = before["shapes"][0]
    require(shp["props"]["hasCaption"] and shp["caption"], "expected captioned shape", shp)
    path = begin(acc, row, fixture, out, "b1-2.hwp")
    select_object(acc, shp, "shape")
    handles = acc.d.js("return [...document.querySelectorAll('[data-handle]')].map(e=>e.dataset.handle)")
    row["handles"] = handles
    require(all(h not in handles for h in ("nw", "n", "ne", "w", "sw")), "Stage 3-C west/north handles must stay hidden", handles)
    width_absent = acc.d.js("return document.querySelector(arguments[0]) === null", c.WIDTH)
    row["captionedOutlineWidthDisabled"] = width_absent
    require(width_absent, "outline width on captioned shape must stay absent/disabled", width_absent)
    rect = shp["caption"]["end"]
    p6.pointer(acc, (rect["pageIndex"], rect["x"] + 1, rect["y"] + rect["height"] / 2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    acc.key("End")
    acc.type("X")
    revision(acc, "hwp", 1)
    select_object(acc, shp, "shape")
    fill_input = SHAPE + " > label input[type=color]"
    p6.color(acc, fill_input, "#884422")
    revision(acc, "hwp", 2)
    select_object(acc, shp, "shape")
    acc.dom_click(p6.gso.FLIPS, "document.querySelectorAll(arguments[0])[1]")
    acc.dom_click(SHAPE + " form:has(input[max='3600']) button")
    revision(acc, "hwp", 3)
    acc.key("ctrl+z")
    revision(acc, "hwp", 4)
    acc.key("ctrl+y")
    revision(acc, "hwp", 5)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    saved = after["shapes"][0]
    require(saved["caption"]["texts"][0] == shp["caption"]["texts"][0] + "X", "caption text not saved", saved["caption"])
    rgb = "#" + saved["props"]["fillBgColor"].to_bytes(3, "little").hex()
    require(saved["props"]["fillType"] == "solid" and rgb == "#884422", "fill not saved", [saved["props"]["fillType"], rgb])
    require(saved["props"]["vertFlip"] is True, "vertFlip not saved", saved["props"])
    require([c_["ctrlId"] for c_ in after["controls"] if c_["ctrlId"] == "atno"] ==
            [c_["ctrlId"] for c_ in before["controls"] if c_["ctrlId"] == "atno"], "atno count changed")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)
    select_object(acc, saved, "shape")
    require(p6.value(acc, fill_input) == "#884422", "reopened fill color")


def b2_1(acc, row, b_root, out):
    fixture = b_root / "b2/b2-1-caption-delete-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    cap_img = next(i for i in before["images"] if i["props"]["hasCaption"])
    cap_shp = next(s for s in before["shapes"] if s["controlIdx"] == 5)
    path = begin(acc, row, fixture, out, "b2-1.hwp")
    select_object(acc, cap_img, "picture")
    acc.key("Delete")
    revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    revision(acc, "hwp", 2)
    acc.key("ctrl+y")
    revision(acc, "hwp", 3)
    select_object(acc, cap_shp, "shape")
    acc.key("Delete")
    revision(acc, "hwp", 4)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    require(len(after["images"]) == len(before["images"]) - 1, "captioned picture not deleted")
    require(len(after["shapes"]) == len(before["shapes"]) - 1, "captioned shape not deleted")
    require(after["shapes"][0]["caption"]["texts"] == before["shapes"][0]["caption"]["texts"], "sibling caption affected")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)
    select_object(acc, after["shapes"][0], "shape")


def b2_2(acc, row, b_root, out):
    fixture = b_root / "b2/b2-2-group-delete-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    require(len(before["groups"]) == 1, "expected 1 group", before["groups"])
    group = before["groups"][0]
    path = begin(acc, row, fixture, out, "b2-2.hwp")
    select_object(acc, group, "group")
    handles = acc.d.js("return [...document.querySelectorAll('[data-handle]')].map(e=>e.dataset.handle)")
    row["handles"] = handles
    require(all(h not in handles for h in ("nw", "n", "ne", "w", "sw")), "Stage 3-C west/north handles must stay hidden on group", handles)
    acc.key("Delete")
    revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    revision(acc, "hwp", 2)
    select_object(acc, group, "group")
    acc.key("ctrl+y")
    revision(acc, "hwp", 3)
    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    require(len(after["groups"]) == 0, "group not deleted", after["groups"])
    require(after["images"] == before["images"] and after["body"] == before["body"], "sibling image or body affected")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)


def b3_1(acc, row, b_root, out):
    fixture = b_root / "b3/b3-1-copy-paste-original.hwp"
    before = row["before"] = inspect_hwp(fixture)
    shp3 = next(s for s in before["shapes"] if s["controlIdx"] == 3)
    shp4 = next(s for s in before["shapes"] if s["controlIdx"] == 4)
    path = begin(acc, row, fixture, out, "b3-1.hwp")
    select_object(acc, shp3, "shape")
    acc.key("ctrl+c")
    c.body_end(acc)
    acc.key("ctrl+v")
    revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    revision(acc, "hwp", 2)
    acc.key("ctrl+y")
    revision(acc, "hwp", 3)
    select_object(acc, shp4, "textBox")
    acc.key("ctrl+x")
    revision(acc, "hwp", 4)
    c.body_end(acc)
    acc.key("ctrl+v")
    revision(acc, "hwp", 5)

    # Negative check: cross-document HWP5 paste MUST refuse before history/dirty change
    other = out / "b3-1-cross-doc-dst.hwp"
    shutil.copyfile(b_root / "b2/b2-2-group-delete-original.hwp", other)
    other_hash = digest(other)
    acc.open_native("hwp", other)
    other_init = acc.status("hwp")
    acc.key("ctrl+v")
    acc.settle("hwp")
    other_after = acc.status("hwp")
    for k in ("revision", "localRevision", "dirty", "paragraphText"):
        require(other_after[k] == other_init[k], f"HWP5 cross-doc paste modified {k}", other_after)
    require(digest(other) == other_hash, "HWP5 cross-doc paste modified file on disk")
    row["negativeCrossDocHwp5"] = "refused"
    require(p4.rhwp_poc.close_tab(acc.d, other.name), "cross-doc tab did not close")

    publish(acc, "hwp", row)
    after = row["after"] = inspect_hwp(path)
    require(len(after["shapes"]) == len(before["shapes"]) + 1, "expected +1 copied shape after copy+paste and cut+paste", after["shapes"])
    require([p for p in after["body"] if p != ""] == [p for p in before["body"] if p != ""], "HWP5 clipboard changed body text")
    row["unchangedBinData"] = c.checked_resources(fixture, path)
    reopen(acc, path, row)


def b3_2(acc, row, b_root, out):
    staging = out / "b3-2-staging"
    staging.mkdir(parents=True, exist_ok=True)
    src_orig, dst_orig, dst_refusal = prepare_b3_2_fixtures(staging)
    src = out / "b3-2-source.hwpx"
    dst = out / "b3-2-dest.hwpx"
    shutil.copyfile(src_orig, src)
    shutil.copyfile(dst_orig, dst)
    src_hash = digest(src)
    row["fixtureSha256"] = {"source": src_hash, "destination": digest(dst_orig), "refusalDestination": digest(dst_refusal)}
    before_dst = inspect_hwpx_clip(dst)
    before_src = row["beforeSource"] = inspect_hwpx_clip(src)
    cap_rect = next(s for s in before_src["shapes"] if s["props"]["hasCaption"])
    mix_box = next(s for s in before_src["shapes"] if s["boxTexts"] is not None)
    source_picture, = before_src["pictures"]
    dotted = next(s for s in before_src["shapes"] if s["props"]["lineType"] == 3)
    require(mix_box["boxRun"]["fontFamilies"] == ["함초롬돋움"] * 7, "source font fixture")

    acc.open_native("hwpx", src)
    row["activeGeneration"] = acc.async_js("return (await (await fetch('rhwp/BUILD.json')).json()).generation")["value"]
    require(row["activeGeneration"] == json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())["generation"],
            "app and oracle engine differ")
    select_object(acc, cap_rect, "shape")
    acc.key("ctrl+c")

    acc.open_native("hwpx", dst)
    acc.key("ctrl+v")
    row["afterCaptionPaste"] = revision(acc, "hwpx", 1)
    select_object(acc, cap_rect, "shape")
    acc.key("Escape")

    # Switch back to source tab to copy mixed TextBox
    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(src.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", src.name)
    row["sourceEditingState"] = revision(acc, "hwpx", 0)
    select_object(acc, mix_box, "textBox")
    acc.key("ctrl+c")

    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(dst.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", dst.name)
    c.body_end(acc)
    acc.key("ctrl+v")
    row["afterTextboxPaste"] = revision(acc, "hwpx", 2)
    acc.key("ctrl+z")
    row["afterUndo"] = revision(acc, "hwpx", 3)
    p6.pointer(acc, (mix_box["page"], mix_box["x"] + mix_box["w"] / 2, mix_box["y"] + mix_box["h"] / 2))
    require(acc.d.js("return !document.querySelector(arguments[0])", FRAME), "Undo left the textbox selectable")
    acc.key("ctrl+y")
    row["afterRedo"] = revision(acc, "hwpx", 4)
    select_object(acc, mix_box, "textBox")
    acc.key("Escape")

    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(src.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", src.name)
    select_object(acc, source_picture, "picture")
    acc.key("ctrl+c")
    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(dst.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", dst.name)
    c.body_end(acc)
    acc.key("ctrl+v")
    row["afterPicturePaste"] = revision(acc, "hwpx", 5)
    select_object(acc, source_picture, "picture")
    acc.key("Escape")

    publish(acc, "hwpx", row)
    require(digest(dst) != row["fixtureSha256"]["destination"], "B3.2 did not publish a changed destination")
    after = row["after"] = inspect_hwpx_clip(dst)
    require(len(after["shapes"]) == 2, "expected 2 pasted HWPX objects", after["shapes"])
    pasted_cap = next(s for s in after["shapes"] if s["props"]["hasCaption"])
    pasted_box = next(s for s in after["shapes"] if s["boxTexts"] is not None)
    require(after["body"] == before_dst["body"], "B3.2 changed destination body text")
    require(pasted_cap["capTexts"] == cap_rect["capTexts"] and pasted_cap["capAlign"] == ["justify", "right"]
            and pasted_cap["capBold"] is True,
            "captioned rectangle fidelity lost", pasted_cap)
    require(pasted_box["boxTexts"] == ["plain bold", "second line"] and pasted_box["boxAlign"] == "center",
            "mixed textbox paragraph/alignment lost", pasted_box)
    require(pasted_box["boxRun"]["bold"] is True and pasted_box["boxRun"]["italic"] is True
            and pasted_box["boxRun"]["textColor"] == "#cc2200" and pasted_box["boxRun"]["shadeColor"] == "#ffff00"
            and pasted_box["boxRun"]["fontSize"] == 1400 and pasted_box["boxRun"]["fontFamilies"] == ["함초롬돋움"] * 7,
            "mixed textbox run fidelity lost", pasted_box["boxRun"])

    expected_box = {"tbVerticalAlign": "Bottom", "tbMarginLeft": 90, "tbMarginRight": 110,
                    "tbMarginTop": 130, "tbMarginBottom": 150}
    require(all(pasted_box["props"][k] == mix_box["props"][k] == v for k, v in expected_box.items()),
            "textbox vertical alignment or margins changed", pasted_box["props"])
    pasted_picture, = after["pictures"]
    expected_picture = {"borderType": 0, "borderWidth": 0, "borderColor": 0,
                        "cropLeft": 120, "cropTop": 60, "cropRight": 720, "cropBottom": 90,
                        "cropRect": {"left": 120, "top": 60, "right": 3480, "bottom": 2010},
                        "cropReferenceWidth": 3600, "cropReferenceHeight": 4800}
    require(all(pasted_picture["props"][k] == source_picture["props"][k] == v for k, v in expected_picture.items())
            and pasted_picture["sha256"] == source_picture["sha256"], "picture crop or bytes changed", pasted_picture)
    with ZipFile(dst) as package:
        section = ElementTree.fromstring(package.read("Contents/section0.xml"))
        captions = section.findall(".//{*}caption")
        numbers = captions[0].findall(".//{*}autoNum") if len(captions) == 1 else []
        require(len(numbers) == 1, "published caption must own exactly one autoNum")
        row["publishedAtno"] = numbers[0].attrib
        clip, = section.findall(".//{*}pic/{*}imgClip")
        require(clip.attrib == {k: str(v) for k, v in expected_picture["cropRect"].items()}, "published crop rectangle changed")
        row["publishedCrop"] = clip.attrib

    # Negative refusals on a clean third document
    acc.open_native("hwpx", dst_refusal)
    ref_init = acc.status("hwpx")
    ref_hash = digest(dst_refusal)
    row["negative"] = {}

    def verify_refused(label):
        acc.settle("hwpx")
        cur = acc.status("hwpx")
        for k in ("revision", "localRevision", "dirty", "paragraphText"):
            require(cur[k] == ref_init[k], f"{label} changed {k}", cur)
        require(digest(dst_refusal) == ref_hash, f"{label} changed file on disk")
        row["negative"][label] = "refused"

    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(src.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", src.name)
    select_object(acc, dotted, "shape")
    acc.key("ctrl+c")
    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({json.dumps(dst_refusal.name)}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", dst_refusal.name)
    acc.key("ctrl+v")
    verify_refused("real DOT outline")

    # Orphan marker
    c.clipboard_peer(acc, "UTF8_STRING", "Geul shape [" + "0" * 24 + "]", lambda: (acc.key("ctrl+v"), verify_refused("orphan marker")))
    # Tampered portable group payload
    fake_group = json.dumps({
        "kind": "geul.object", "version": 3, "sourceFormat": "hwpx", "object": "group",
        "sourceSessionId": 999999, "sourceGeneration": row["activeGeneration"],
        "token": "a" * 24, "portable": {"format": "hwpx", "object": "shape", "shapeType": "rectangle", "props": {"width": 2000, "height": 2000}}
    })
    c.clipboard_peer(acc, "application/x-geul-object+json", fake_group, lambda: (acc.key("ctrl+v"), verify_refused("tampered cross-doc group")), plain="Geul group [" + "a" * 24 + "]")

    require(p4.rhwp_poc.close_tab(acc.d, dst_refusal.name), "refusal tab close")
    reopen(acc, dst, row)
    require(inspect_hwpx_clip(dst) == after, "reopened destination differs from independently inspected save")
    select_object(acc, pasted_cap, "shape")
    acc.key("Escape")
    select_object(acc, pasted_box, "textBox")
    acc.key("Escape")
    select_object(acc, pasted_picture, "picture")
    acc.key("Escape")
    require(digest(src) == src_hash and inspect_hwpx_clip(src) == before_src, "B3.2 changed source HWPX")
    row["preservation"] = {"sourceBytesAndContent": True, "destinationBody": True, "reopenedObjects": True}


CASES = {
    "P6-HX-GROUP": p6_hx_group,
    "P6-HX-GROUP-FRESH": p6_hx_group_fresh,
    "B1-1": b1_1,
    "B1-2": b1_2,
    "B2-1": b2_1,
    "B2-2": b2_2,
    "B3-1": b3_1,
    "B3-2": b3_2,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--b-root", type=Path, default=ROOT / "target/stage3b-safety")
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--app", type=Path, default=ROOT / "src-tauri/target/release/geul")
    parser.add_argument("--driver", default="/tmp/geul-tauri-driver-target/debug/tauri-driver")
    parser.add_argument("--cases", nargs="+", choices=CASES, default=list(CASES))
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.b_root = args.b_root.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    app = args.app.resolve()
    p4.smoke.APP = str(app)
    release = json.loads((ROOT / "public/rhwp/RELEASE.json").read_text())
    report = {"appSha256": digest(app), "os": platform.platform(), "rhwp": release["generation"], "cases": {}}
    for case in args.cases:
        row = report["cases"][case] = {}
        if case == "P6-HX-GROUP-FRESH":
            previous = report["cases"].get("P6-HX-GROUP")
            if previous is None or previous.get("status") != "PASS" or "sameProcessReopen" not in previous:
                row.update(status="BLOCKED", error="P6-HX-GROUP did not complete its same-process save/reopen prerequisites; fresh-process acceptance was not run")
                (args.out / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
                print(case, row["status"], row["error"], flush=True)
                continue
        p4.smoke.DRIVER_LOG = str(args.out / (case + "-driver.log"))
        try:
            with tempfile.TemporaryDirectory(prefix="geul-stage3b-") as profile:
                with p4.smoke.tauri_driver(args.driver, 4469, profile) as start:
                    driver = start()
                    try:
                        acc = p4.P4Acceptance(args, driver, row)
                        acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                        acc.focus_window()
                        pid = int(acc.command(args.xdotool, "getwindowpid", acc.window))
                        row["appPid"] = pid
                        row["processAppSha256"] = digest(Path(f"/proc/{pid}/exe"))
                        require(row["processAppSha256"] == report["appSha256"], "unexpected live application binary")
                        acc.calibrate_pointer()
                        CASES[case](acc, row, args.b_root, args.out)
                    except Exception:
                        row["failureAppState"] = acc.status("hwpx" if case in {"B3-2", "P6-HX-GROUP", "P6-HX-GROUP-FRESH"} else "hwp")
                        driver.screenshot(args.out / (case + "-error.png"))
                        raise
                    finally:
                        driver.quit()
            row["status"] = "PASS"
        except Exception:
            row.update(status="FAIL", error=traceback.format_exc())
        row["driverCleanup"] = p4.smoke.TEARDOWN[-1] if p4.smoke.TEARDOWN else None
        (args.out / "result.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(case, row["status"], row.get("error", ""), flush=True)
    return 0 if all(r["status"] == "PASS" for r in report["cases"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
