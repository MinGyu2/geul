#!/usr/bin/env python3
"""P5 Linux X11 acceptance for owned DOCX pictures and HWPX textbox paragraphs."""

import importlib.util
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import time
import zlib
from xml.etree import ElementTree as ET
import zipfile

entry = Path(__file__).with_name("native-stage3-c.py")
spec = importlib.util.spec_from_file_location("stage3c", entry)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
h5_entry = Path(__file__).with_name("native-stage3-h5-textbox-paragraphs.py")
h5_spec = importlib.util.spec_from_file_location("stage3h5textbox", h5_entry)
h5 = importlib.util.module_from_spec(h5_spec)
h5_spec.loader.exec_module(h5)

DESCRIPTION = '[aria-labelledby=properties-selection] .object-tools input[maxlength="1024"]'
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
PIC = "{http://schemas.openxmlformats.org/drawingml/2006/picture}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
WPS = "{http://schemas.microsoft.com/office/word/2010/wordprocessingShape}"
RHWP_HEADER_ORACLE = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation);
const rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const controls=JSON.parse(doc.getControls());
  const owners=controls.filter(c=>c.ctrlId==='head'||c.ctrlId==='foot').map(c=>({
    ctrlId:c.ctrlId,userDesc:c.userDesc,list:c.list,para:c.para,controlIndex:c.controlIndex
  }));
  const pictures=new Map();
  for(let page=0;page<Math.min(doc.pageCount(),8);page++) {
    const layout=JSON.parse(doc.getPageControlLayout(page)).controls||[];
    for(const c of layout) {
      const kind=c.headerFooter?.kind;
      if(c.type!=='image'||(kind!=='header'&&kind!=='footer')) continue;
      const hf=c.headerFooter;
      const address={section:c.secIdx,kind,outerParagraph:hf.outerParaIdx,outerControl:hf.outerControlIdx,
        innerParagraph:c.paraIdx,innerControl:c.controlIdx};
      const key=JSON.stringify(address);
      if(pictures.has(key)) continue;
      const owner=owners.filter(o=>o.list===0&&o.para===hf.outerParaIdx&&o.controlIndex===hf.outerControlIdx);
      const properties=JSON.parse(doc.getHeaderFooterPictureProperties(
        address.section,address.outerParagraph,address.outerControl,address.innerParagraph,address.innerControl));
      pictures.set(key,{page,control:c,address,owner:owner.length===1?owner[0]:null,properties});
    }
    if([...pictures.values()].some(p=>p.address.kind==='header')) break;
  }
  console.log(JSON.stringify({generation:release.generation,pageCount:doc.pageCount(),owners,pictures:[...pictures.values()]}));
} finally { doc.free(); }
"""


def rhwp_header_state(path):
    return json.loads(subprocess.check_output(["node", "-e", RHWP_HEADER_ORACLE, str(path)], cwd=h.ROOT, text=True))


RHWP_HEADER_SHAPE_ORACLE = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation);
const rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const controls=JSON.parse(doc.getControls());
  const owners=controls.filter(c=>c.list===0&&(c.ctrlId==='head'||c.ctrlId==='foot'));
  const shapes=new Map();
  for(let page=0;page<Math.min(doc.pageCount(),12);page++) {
    const layout=JSON.parse(doc.getPageControlLayout(page)).controls||[];
    for(const c of layout) {
      const kind=c.headerFooter?.kind;
      if(!['shape','line','group'].includes(c.type)||(kind!=='header'&&kind!=='footer')) continue;
      const cellPath=Array.isArray(c.cellPath)?JSON.stringify(c.cellPath):'[]';
      const address={section:c.secIdx,kind,outerParagraph:c.headerFooter.outerParaIdx,
        outerControl:c.headerFooter.outerControlIdx,innerParagraph:c.paraIdx,innerControl:c.controlIdx,
        ...(cellPath!=='[]'?{cellPath}:{})};
      const key=JSON.stringify(address);
      if(shapes.has(key)) continue;
      const ownerMatches=owners.filter(o=>o.para===address.outerParagraph
        &&o.controlIndex===address.outerControl);
      const properties=JSON.parse(doc.getHeaderFooterShapeProperties(address.section,kind,
        address.outerParagraph,address.outerControl,address.innerParagraph,cellPath,address.innerControl));
      shapes.set(key,{page,control:c,address,
        owner:ownerMatches.length===1?ownerMatches[0]:null,properties});
    }
  }
  console.log(JSON.stringify({generation:release.generation,pageCount:doc.pageCount(),owners,
    shapes:[...shapes.values()]}));
} finally { doc.free(); }
"""


def rhwp_header_shape_state(path):
    return json.loads(subprocess.check_output(
        ["node", "-e", RHWP_HEADER_SHAPE_ORACLE, str(path)], cwd=h.ROOT, text=True))


def header_shape(state):
    candidates = [item for item in state["shapes"]
                  if item["address"]["kind"] == "header" and item["control"]["type"] == "shape"
                  and item["control"]["w"] >= 100]
    h.require(len(candidates) == 1, "fixture must expose exactly one large owned header shape", candidates)
    shape = candidates[0]
    address, owner = shape["address"], shape["owner"]
    h.require(owner is not None and owner["ctrlId"] == "head" and owner["userDesc"] == "머리말"
              and owner["list"] == 0 and owner["para"] == address["outerParagraph"]
              and owner["controlIndex"] == address["outerControl"],
              "header shape address does not resolve to its exact section owner", shape)
    h.require(address.get("cellPath") is not None,
              "acceptance fixture must exercise a nested header table-cell path", address)
    return shape


def select_header_shape(acc, shape):
    control = shape["control"]
    target = (shape["page"], control["x"] + control["w"] / 2,
              control["y"] + control["h"] / 2)
    expected_kind = "textBox" if "tbVerticalAlign" in shape["properties"] else "shape"
    acc.d.js("""
      if(!Array.isArray(window.p5RhfPointers)){
        window.p5RhfPointers=[];
        for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>
          window.p5RhfPointers.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);
      }
    """)
    h.p6.pointer(acc, target)
    acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind===arguments[1]",
             h.p6.FRAME, expected_kind)
    return h.frame(acc)


def header_shape_id(shape):
    # This stable source object id is shared by the HWP and HWPX fixtures and is
    # independently located in their CFB GSO / Contents section XML storage.
    h.require(shape["properties"].get("instanceId") == 1926588463
              and shape["properties"].get("scInstId") == 852846640,
              "fixture's header shape identity changed", shape["properties"])
    return 1926588463


def preview_dimensions(width, height, landscape=False):
    if not (1 <= width <= 2_000_000 and 1 <= height <= 2_000_000):
        return None
    if landscape:
        width, height = height, width
    short = max(1, (2 * 1024 * min(width, height) + max(width, height))
                // (2 * max(width, height)))
    return (short, 1024) if width < height else (1024, short)


def canonical_preview_png(data, expected_size):
    """Independently validate the exact RGB8, filter-0 preview encoding used by T009."""
    signature = b"\x89PNG\r\n\x1a\n"
    if not expected_size or len(data) > 4 * 1024 * 1024 or not data.startswith(signature):
        return None
    at, chunks = len(signature), []
    while at < len(data):
        if len(data) - at < 12:
            return None
        length = int.from_bytes(data[at:at + 4], "big")
        end = at + 12 + length
        if end > len(data):
            return None
        kind, body = data[at + 4:at + 8], data[at + 8:at + 8 + length]
        crc = int.from_bytes(data[at + 8 + length:end], "big")
        if (zlib.crc32(kind + body) & 0xffffffff) != crc:
            return None
        chunks.append((kind, body))
        at = end
    if at != len(data) or len(chunks) != 3:
        return None
    if chunks[0][0] != b"IHDR" or chunks[1][0] != b"IDAT" or chunks[2] != (b"IEND", b""):
        return None
    ihdr, compressed = chunks[0][1], chunks[1][1]
    if len(ihdr) != 13:
        return None
    width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", ihdr)
    if (width, height) != expected_size or depth != 8 or color != 2 or (compression, filtering, interlace) != (0, 0, 0):
        return None
    stride = width * 3 + 1
    expected_raw = stride * height
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(compressed, expected_raw + 1)
    except zlib.error:
        return None
    if len(raw) != expected_raw or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        return None
    pixels = hashlib.sha256()
    for row_at in range(0, expected_raw, stride):
        row = raw[row_at:row_at + stride]
        if len(row) != stride or row[0] != 0:
            return None
        pixels.update(row[1:])
    return {"width": width, "height": height, "pixelSha256": pixels.hexdigest(),
            "chunkTypes": [kind.decode("ascii") for kind, _ in chunks],
            "crcValid": True, "filter0": True, "rgb8": True}


def hwp_preview_dimensions(streams):
    records = h.p6.gso.records(h.p6.gso.unpacked(streams, "BodyText/Section0"))
    page_defs = [record[2] for record in records if record[0] == 73]
    if len(page_defs) != 1 or len(page_defs[0]) < 40:
        return None
    body = page_defs[0]
    width, height, attr = (int.from_bytes(body[at:at + 4], "little") for at in (0, 4, 36))
    return preview_dimensions(width, height, bool(attr & 1))


def hwpx_preview_dimensions(section_xml):
    root = ET.fromstring(section_xml)
    page_prs = list(root.iter("{http://www.hancom.co.kr/hwpml/2011/paragraph}pagePr"))
    if len(page_prs) != 1:
        return None
    values = []
    for name in ("width", "height"):
        value = page_prs[0].get(name, "")
        if not value or not value.isascii() or not value.isdecimal():
            return None
        values.append(int(value))
    return preview_dimensions(*values)


def parse_hwpx_xml_preserving_events(data):
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
    return ET.fromstring(data, parser=parser)


def hwpx_header_shape_tree_matches(old_root, new_root, object_id):
    old_shape = old_root.find(f".//{{*}}rect[@id='{object_id}']")
    new_shape = new_root.find(f".//{{*}}rect[@id='{object_id}']")
    if old_shape is None or new_shape is None:
        return False

    def comparable(node, parent_is_target=False, parent_is_target_rendering=False):
        if node.tag is ET.Comment:
            return ("comment", node.text or "", node.tail or "")
        if node.tag is ET.ProcessingInstruction:
            return ("instruction", node.text or "", node.tail or "")
        if not isinstance(node.tag, str):
            return ("unknown-markup", repr(node.tag), node.text or "", node.tail or "")
        attrs = dict(node.attrib)
        name = node.tag.rsplit("}", 1)[-1]
        is_target = name == "rect" and node.get("id") == str(object_id)
        # Ignore only placement fields within the selected object. The complete
        # section tree, comments, processing instructions and mixed-content tails
        # remain part of the comparison. Geometry exemptions apply only to the
        # selected object's direct placement children, not nested child stories.
        if parent_is_target and name == "pos":
            attrs.pop("horzOffset", None)
            attrs.pop("vertOffset", None)
        if parent_is_target and name == "offset":
            attrs.pop("x", None)
            attrs.pop("y", None)
        if parent_is_target_rendering and name == "transMatrix":
            attrs.pop("e3", None)
            attrs.pop("e6", None)
        return (node.tag, tuple(sorted(attrs.items())), node.text or "", node.tail or "",
                tuple(comparable(child, is_target, parent_is_target and name == "renderingInfo")
                      for child in node))

    return comparable(old_root) == comparable(new_root)


def hwp_header_shape_record_proof(before, after, object_id):
    old = h.p6.gso.cfb_streams(before.read_bytes())
    new = h.p6.gso.cfb_streams(after.read_bytes())
    h.require(set(old) == set(new), "HWP save changed the CFB stream inventory")
    changed_streams = sorted(name for name in old if old[name] != new[name])
    compression_only_sections = []
    for name in sorted(name for name in old if name.startswith("BodyText/Section")
                       and name != "BodyText/Section0" and old[name] != new[name]):
        old_records = h.p6.gso.unpacked(old, name)
        new_records = h.p6.gso.unpacked(new, name)
        h.require(old_records == new_records,
                  "HWP save changed a non-target section beyond its CFB compression envelope", name)
        compression_only_sections.append(name)
    allowed = {"BodyText/Section0", "DocInfo", "PrvImage", "PrvText",
               *compression_only_sections,
               *(name for name in old if name.startswith("BinData/"))}
    h.require("BodyText/Section0" in changed_streams and set(changed_streams) <= allowed,
              "HWP save changed streams outside the header object and previews", changed_streams)
    old_docinfo = h.p6.gso.unpacked(old, "DocInfo")
    new_docinfo = h.p6.gso.unpacked(new, "DocInfo")
    h.require(old_docinfo == new_docinfo, "HWP header shape edit changed DocInfo records")
    for name in sorted(name for name in old if name.startswith("BinData/")):
        h.require(h.p6.gso.unpacked(old, name) == h.p6.gso.unpacked(new, name),
                  "HWP header shape edit changed a BinData resource", name)
    h.require(old["PrvText"] == new["PrvText"], "HWP header shape edit changed the text preview")
    h.require(old["PrvImage"] != new["PrvImage"],
              "HWP header movement did not regenerate its stale image preview")
    image_proof = canonical_preview_png(new["PrvImage"], hwp_preview_dimensions(new))
    h.require(image_proof is not None,
              "HWP header save did not publish a canonical page-sized RGB preview")
    old_records = h.p6.gso.records(h.p6.gso.unpacked(old, "BodyText/Section0"))
    new_records = h.p6.gso.records(h.p6.gso.unpacked(new, "BodyText/Section0"))
    h.require(len(old_records) == len(new_records)
              and all(a[:2] == b[:2] for a, b in zip(old_records, new_records)),
              "HWP header shape edit changed the section record topology")
    target = [i for i, record in enumerate(old_records)
              if record[0] == 71 and record[2].startswith(b" osg")
              and len(record[2]) >= 40 and int.from_bytes(record[2][36:40], "little") == object_id]
    h.require(len(target) == 1, "fixture header shape GSO identity is not unique", target)
    changed = [i for i, pair in enumerate(zip(old_records, new_records)) if pair[0] != pair[1]]
    h.require(changed == target, "HWP save changed records outside the exact header shape", changed)
    index = target[0]
    before_payload, after_payload = old_records[index][2], new_records[index][2]
    changed_bytes = [i for i, pair in enumerate(zip(before_payload, after_payload)) if pair[0] != pair[1]]
    h.require(before_payload[:8] == after_payload[:8] and before_payload[16:] == after_payload[16:]
              and changed_bytes and set(changed_bytes) <= set(range(8, 16)),
              "HWP header shape edit changed identity or non-position fields", changed_bytes)
    return {"changedStreams": changed_streams,
            "compressionOnlySections": compression_only_sections,
            "changedRecords": changed,
            "targetGsoId": object_id, "changedControlBytes": changed_bytes,
            "previewImage": {"sha256": hashlib.sha256(new["PrvImage"]).hexdigest(),
                             "bytes": len(new["PrvImage"]), **image_proof}}


def hwpx_header_shape_proof(before, after, object_id):
    with zipfile.ZipFile(before) as original, zipfile.ZipFile(after) as published:
        old_names, new_names = original.namelist(), published.namelist()
        h.require(len(old_names) == len(set(old_names)) and len(new_names) == len(set(new_names))
                  and set(old_names) == set(new_names),
                  "HWPX save changed or duplicated the OPC part inventory")
        preview_size = hwpx_preview_dimensions(published.read("Contents/section0.xml"))
        h.require(preview_size is not None, "HWPX page geometry is ambiguous for preview validation")
        changed_parts = []
        canonical_xml_parts = []
        preview_proofs = {}
        for name in sorted(original.namelist()):
            source, saved = original.read(name), published.read(name)
            if source == saved:
                continue
            changed_parts.append(name)
            if name == "Contents/section0.xml":
                continue  # The following tree proof admits placement fields only on the selected object.
            if name == "Preview/PrvText.txt":
                h.require(saved == b"\r\n", "HWPX save did not replace stale preview text with the pinned blank value")
                preview_proofs[name] = {"sha256": hashlib.sha256(saved).hexdigest(),
                                        "bytes": len(saved), "exactBlankText": True}
                continue
            if name == "Preview/PrvImage.png":
                image_proof = canonical_preview_png(saved, preview_size)
                h.require(image_proof is not None,
                          "HWPX save did not publish a canonical page-sized RGB preview", preview_size)
                preview_proofs[name] = {"sha256": hashlib.sha256(saved).hexdigest(),
                                        "bytes": len(saved), **image_proof}
                continue
            is_xml = (name.lower().endswith((".xml", ".rels", ".hpf"))
                      or source.startswith(b"<?xml") or source.startswith(b"\xef\xbb\xbf<?xml"))
            if not is_xml:
                h.require(False, "HWPX save changed an unrelated binary OPC part", name)
            try:
                source_xml = ET.canonicalize(xml_data=source.decode("utf-8"),
                                            with_comments=True, rewrite_prefixes=True)
                saved_xml = ET.canonicalize(xml_data=saved.decode("utf-8"),
                                            with_comments=True, rewrite_prefixes=True)
            except (UnicodeDecodeError, ET.ParseError, ValueError) as exc:
                h.require(False, "HWPX save changed an unrelated XML part that cannot be canonicalized",
                          {"part": name, "error": str(exc)})
            h.require(source_xml == saved_xml,
                      "HWPX save changed XML content outside the selected object's placement", name)
            canonical_xml_parts.append(name)
        for name in ("Preview/PrvText.txt", "Preview/PrvImage.png"):
            if name in old_names and name not in changed_parts:
                source = original.read(name)
                if name.endswith("PrvText.txt"):
                    h.require(source in (b"", b"\r\n"),
                              "HWPX save retained stale preview text after changing its body", name)
                else:
                    known_blank = ((len(source) == 68 and hashlib.sha256(source).hexdigest()
                                    == "c1bf607dd7214cb64486934b72c335a64b31d7f5203c40afdea5a1b95c826cf8")
                                   or (len(source) == 4502 and hashlib.sha256(source).hexdigest()
                                       == "ca5d23cd1aad2853672cdb0d116137a0bdc2ff62148da9886c264305d0025f3d"))
                    h.require(known_blank,
                              "HWPX save retained an unproven/stale preview image after changing its body", name)
                    preview_proofs[name] = {"sha256": hashlib.sha256(source).hexdigest(),
                                            "bytes": len(source), "knownBlankEncoding": True}
        old_root = parse_hwpx_xml_preserving_events(original.read("Contents/section0.xml"))
        new_root = parse_hwpx_xml_preserving_events(published.read("Contents/section0.xml"))

    old_shape = old_root.find(f".//{{*}}rect[@id='{object_id}']")
    new_shape = new_root.find(f".//{{*}}rect[@id='{object_id}']")
    h.require(old_shape is not None and new_shape is not None,
              "HWPX save lost the owned header rectangle")

    h.require(hwpx_header_shape_tree_matches(old_root, new_root, object_id),
              "HWPX header shape edit changed the section tree outside selected-object position fields")
    h.require(old_shape.get("id") == new_shape.get("id")
              and old_shape.get("instid") == new_shape.get("instid"),
              "HWPX header shape edit changed document or instance identity")
    h.require("Contents/section0.xml" in changed_parts,
              "HWPX header shape save did not update its owning section")
    h.require(set(changed_parts) <= {"Contents/section0.xml", "Preview/PrvText.txt", "Preview/PrvImage.png"},
              "HWPX save changed unrelated OPC parts", changed_parts)
    return {"changedParts": changed_parts, "canonicalXmlEquivalentParts": canonical_xml_parts,
            "targetShapePart": "Contents/section0.xml", "targetShapeId": object_id,
            "stableIdentity": True, "nonPositionXmlPreserved": True,
            "unrelatedBinaryPartsByteIdentical": True, "previewParts": preview_proofs}


def header_shape_edit(acc, row, fixtures, out, fmt):
    fixture = fixtures / f"header-shape-original.{fmt}"
    before_state = rhwp_header_shape_state(fixture)
    before = header_shape(before_state)
    address = before["address"]
    object_id = header_shape_id(before)
    h.require(before["control"]["type"] == "shape" and before["control"]["w"] >= 100
              and before["control"]["h"] >= 20,
              "fixture's nested header rectangle no longer provides a safe Native target", before["control"])
    path = h.begin(acc, row, fixture, out, f"header-shape-{fmt}-moved.{fmt}")
    opened = rhwp_header_shape_state(path)
    h.require(opened["owners"] == before_state["owners"], "open changed HWP header/footer owners")
    ui_before = select_header_shape(acc, before)
    h.require(acc.d.exists("[data-testid=object-move]"), "header shape has no move affordance")
    events_expr = """
      window.p5RhfKeys=[];
      addEventListener('keydown',e=>{
        if(e.shiftKey&&e.key==='ArrowRight') window.p5RhfKeys.push({trusted:e.isTrusted});
      },true);
    """
    acc.d.js(events_expr)
    acc.key("shift+Right")
    h.revision(acc, fmt, 1)
    key_events = acc.d.js("return window.p5RhfKeys")
    h.require(key_events == [{"trusted": True}], "header shape edit did not use a trusted Native key", key_events)
    select_header_shape(acc, before)
    ui_after = h.frame(acc)
    h.require(ui_after["left"] > ui_before["left"] + 1,
              "Native keyboard edit did not move the selected header shape", [ui_before, ui_after])
    events = acc.d.js("return window.p5RhfPointers.slice(-2)")
    h.require([(event["type"], event["trusted"]) for event in events]
              == [("pointerdown", True), ("pointerup", True)],
              "header shape was not selected by trusted Native pointer input", events)
    after_move = select_header_shape(acc, before)
    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    undo = select_header_shape(acc, before)
    h.require(same_geometry(undo, ui_before), f"{fmt.upper()} header shape Undo did not restore geometry", undo)
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    redo = select_header_shape(acc, before)
    h.require(same_geometry(redo, after_move), f"{fmt.upper()} header shape Redo did not restore movement", redo)
    row["shapeMove"] = {"before": ui_before, "after": after_move, "undo": undo, "redo": redo,
                         "trustedPointerEvents": events, "trustedKeyEvents": key_events,
                         "ownerAddress": address, "propertiesBefore": before["properties"]}
    h.publish(acc, fmt, row)

    after_state = rhwp_header_shape_state(path)
    after = header_shape(after_state)
    h.require(after_state["owners"] == before_state["owners"] and after["address"] == address
              and after["owner"] == before["owner"], "save changed exact HWP header shape ownership", after_state)
    changed_props = [key for key in before["properties"]
                     if before["properties"][key] != after["properties"].get(key)]
    h.require(changed_props and set(changed_props) <= {"horzOffset"},
              "save changed HWP header shape fields outside its horizontal position", changed_props)
    h.require(after["properties"]["horzOffset"] != before["properties"]["horzOffset"],
              "saved header shape has no durable movement", [before["properties"], after["properties"]])
    other_before = {json.dumps(item["address"], sort_keys=True): item["properties"]
                    for item in before_state["shapes"] if item["address"] != address}
    other_after = {json.dumps(item["address"], sort_keys=True): item["properties"]
                   for item in after_state["shapes"] if item["address"] != address}
    h.require(other_before == other_after, "save changed another header/footer shape", [other_before, other_after])
    proof = hwp_header_shape_record_proof(fixture, path, object_id) if fmt == "hwp" else hwpx_header_shape_proof(
        fixture, path, object_id)
    row["serializationProof"] = proof
    h.reopen(acc, path, row)
    reopened_state = rhwp_header_shape_state(path)
    reopened = header_shape(reopened_state)
    h.require(reopened["address"] == address and reopened["owner"] == after["owner"]
              and reopened["properties"] == after["properties"],
              "header shape ownership or properties changed after same-process reopen", reopened)
    reopened_frame = select_header_shape(acc, reopened)
    h.require(same_geometry(reopened_frame, redo, 1.5),
              "header shape layout changed after save/reopen", [redo, reopened_frame])
    row["reopened"] = {"frame": reopened_frame, "shape": reopened, "savedSha256": row["publishedSha256"]}
    (out / f"header-shape-{fmt}-expected.json").write_text(json.dumps({
        "savedFile": path.name, "publishedSha256": row["publishedSha256"],
        "appSha256": row["processAppSha256"], "appPid": row["appPid"],
        "owners": after_state["owners"], "shape": after, "finalFrame": redo,
    }, indent=2, ensure_ascii=False) + "\n")


def header_shape_hwp(acc, row, fixtures, out):
    header_shape_edit(acc, row, fixtures, out, "hwp")


def header_shape_hwpx(acc, row, fixtures, out):
    header_shape_edit(acc, row, fixtures, out, "hwpx")


def header_shape_fresh_reopen(acc, row, fixtures, out, fmt):
    expected = json.loads((fixtures / f"header-shape-{fmt}-expected.json").read_text())
    fixture = fixtures / expected["savedFile"]
    path = h.begin(acc, row, fixture, out, f"header-shape-{fmt}-fresh-reopen.{fmt}")
    row["expectedSavedSha256"] = expected["publishedSha256"]
    row["savedSha256"] = h.digest(path)
    h.require(row["savedSha256"] == expected["publishedSha256"],
              "fresh shape session input differs from the accepted saved file")
    h.require(row["processAppSha256"] == expected["appSha256"] and row["appPid"] != expected["appPid"],
              "header shape fresh reopen did not use a different process with the same Release application")
    h.require(row["initialSession"].get("dirty") == "false"
              and row["initialSession"].get("unpreserved") == "false",
              "saved header shape reopened dirty or unpreserved", row["initialSession"])
    state = rhwp_header_shape_state(path)
    shape = header_shape(state)
    h.require(state["owners"] == expected["owners"] and shape["owner"] == expected["shape"]["owner"]
              and shape["address"] == expected["shape"]["address"]
              and shape["properties"] == expected["shape"]["properties"],
              "fresh reopen changed header shape owner or properties", shape)
    frame = select_header_shape(acc, shape)
    ui = {"selectionFrame": frame, "shapeProperties": shape["properties"]}
    h.require(same_geometry(frame, expected["finalFrame"], 1.5),
              "fresh Release process rendered the saved header shape at a different placement",
              [expected["finalFrame"], frame])
    row["readOnlyFreshProcessReopen"] = {"frame": frame, "shape": shape, "ui": ui,
                                        "savedSha256": row["savedSha256"]}


def header_picture(state):
    pictures = [item for item in state["pictures"] if item["address"]["kind"] == "header"]
    h.require(len(pictures) == 1, "fixture must expose exactly one owned header picture", pictures)
    picture = pictures[0]
    address, owner = picture["address"], picture["owner"]
    h.require(owner is not None and owner["ctrlId"] == "head" and owner["userDesc"] == "머리말"
              and owner["list"] == 0 and owner["para"] == address["outerParagraph"]
              and owner["controlIndex"] == address["outerControl"],
              "header picture address does not resolve to its exact section owner", picture)
    return picture


def select_header_picture(acc, picture, scroll_to_object=False):
    control = picture["control"]
    target = (picture["page"], control["x"] + control["w"] / 2,
              control["y"] + control["h"] / 2)
    acc.d.js("""
      if(!Array.isArray(window.p5RhdrPointers)){
        window.p5RhdrPointers=[];
        for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>
          window.p5RhdrPointers.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);
      }
    """)
    if scroll_to_object:
        screen = acc.d.js("""
          const [page,x,y]=arguments[0], canvas=document.querySelectorAll('.rhwp-page__canvas')[page];
          const scroll=document.querySelector('.editor__scroll'), view=scroll.getBoundingClientRect();
          const zoom=parseInt(document.querySelector('.statusbar__zoom-value')?.textContent||'100',10)/100;
          let rect=canvas.getBoundingClientRect(), k=rect.width/canvas.clientWidth;
          const before={page,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
            client:{width:canvas.clientWidth,height:canvas.clientHeight},zoom,
            view:{x:view.x,y:view.y,width:view.width,height:view.height},
            scroll:{left:scroll.scrollLeft,top:scroll.scrollTop,width:scroll.scrollWidth,height:scroll.scrollHeight,
              clientWidth:scroll.clientWidth,clientHeight:scroll.clientHeight},k,target:{x,y}};
          k*=zoom;
          scroll.scrollTop += rect.top+y*k-(view.top+view.height/2);
          rect=canvas.getBoundingClientRect();
          scroll.scrollLeft += rect.left+x*k-(view.left+view.width/2);
          rect=canvas.getBoundingClientRect();
          return {x:rect.left+x*k,y:rect.top+y*k,before,
            after:{rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
              scroll:{left:scroll.scrollLeft,top:scroll.scrollTop,width:scroll.scrollWidth,height:scroll.scrollHeight,
                clientWidth:scroll.clientWidth,clientHeight:scroll.clientHeight}}};
        """, target)
        try:
            h.p4.rhwp_poc.click(acc.d, screen["x"], screen["y"])
        except Exception as exc:
            raise RuntimeError(f"footer/header trusted hit is outside the viewport: {screen!r}") from exc
    else:
        h.p6.pointer(acc, (picture["page"], control["x"] + control["w"] / 2,
                           control["y"] + control["h"] / 2))
    try:
        acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='picture'", h.p6.FRAME, timeout=10)
    except Exception as exc:
        diagnostic = acc.d.js("""
          const canvas=document.querySelectorAll('.rhwp-page__canvas')[arguments[0][0]],
            scroll=document.querySelector('.editor__scroll'), event=window.p5RhdrPointers?.at(-1),
            point=event&&document.elementFromPoint(event.x,event.y), rect=canvas?.getBoundingClientRect();
          return {target:arguments[0],canvas:canvas&&{rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
              client:{width:canvas.clientWidth,height:canvas.clientHeight},scrollTop:scroll?.scrollTop},
            event:event&&{type:event.type,trusted:event.trusted,x:event.x,y:event.y},
            element:point&&{tag:point.tagName,className:String(point.className||''),testid:point.dataset?.testid,
              text:(point.textContent||'').slice(0,80),html:point.outerHTML.slice(0,500)},
            selection:document.querySelector(arguments[1])?.outerHTML||null,
            caret:document.querySelector('[data-testid=rhwp-status]')?.dataset.caret,
            frame:document.querySelector(arguments[1])?.getBoundingClientRect().toJSON()||null};
        """, target, h.p6.FRAME)
        raise RuntimeError(f"header picture trusted hit did not select a picture: {diagnostic!r}") from exc
    return h.frame(acc)


def same_geometry(left, right, tolerance=0.35):
    return bool(left and right and all(abs(left[key] - right[key]) <= tolerance
                                       for key in ("left", "top", "width", "height")))


def header_fresh_reopen(acc, row, fixtures, out, fmt):
    expected = json.loads((out / f"header-{fmt}-expected.json").read_text())
    fixture = out / expected["savedFile"]
    path = h.begin(acc, row, fixture, out, f"header-{fmt}-fresh-reopen.{fmt}")
    row["expectedSavedSha256"] = expected["publishedSha256"]
    row["savedSha256"] = h.digest(path)
    h.require(row["savedSha256"] == expected["publishedSha256"], "fresh session input differs from accepted saved file")
    h.require(row["processAppSha256"] == expected["appSha256"], "fresh session used a different Release application")
    h.require(row["appPid"] != expected["appPid"], "fresh reopen reused the original application process")
    h.require(row["initialSession"].get("dirty") == "false"
              and row["initialSession"].get("unpreserved") == "false",
              "saved header document reopened dirty or unpreserved", row["initialSession"])
    state = rhwp_header_state(path)
    picture = header_picture(state)
    h.require(state["owners"] == expected["owners"], "fresh reopen changed header/footer owner controls")
    h.require(picture["address"] == expected["header"]["address"]
              and picture["owner"] == expected["header"]["owner"]
              and picture["properties"] == expected["header"]["properties"],
              "fresh reopen changed header picture identity or properties", picture)
    frame = select_header_picture(acc, picture)
    ui = h.p6.gso.props(acc, "picture")
    props = picture["properties"]
    h.require(ui["size"] == [props["width"] / 100, props["height"] / 100],
              "fresh Native rendering selected a different header picture size", [ui, props])
    row["readOnlyFreshProcessReopen"] = {"frame": frame, "picture": picture, "ui": ui,
                                         "savedSha256": row["savedSha256"]}


def header_picture_hwp(acc, row, fixtures, out):
    fixture = fixtures / "header-original.hwp"
    before_state = rhwp_header_state(fixture)
    before = header_picture(before_state)
    address = before["address"]
    h.require(before["properties"]["treatAsChar"] is False,
              "HWP fixture must exercise a floating movable header picture", before["properties"])
    path = h.begin(acc, row, fixture, out, "header-hwp-moved.hwp")
    opened = rhwp_header_state(path)
    h.require(opened["owners"] == before_state["owners"], "HWP open changed story owners")
    events_expr = """
      window.p5RhdrPointers=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>
        window.p5RhdrPointers.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);
    """
    acc.d.js(events_expr)
    frame_before = select_header_picture(acc, before)
    ui = h.p6.gso.props(acc, "picture")
    expected_size = [before["properties"]["width"] / 100, before["properties"]["height"] / 100]
    h.require(all(abs(ui["size"][i] - expected_size[i]) <= 0.02 for i in range(2)),
              "trusted hit selected a different HWP header picture", [ui, expected_size])
    if not acc.d.exists("[data-testid=object-move]"):
        acc.wait("return !!document.querySelector('[data-testid=object-move]')", timeout=30)
        frame_before = select_header_picture(acc, before)
    h.require(acc.d.exists("[data-testid=object-move]"), "floating header picture has no move handle")
    x, y = acc.d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]",
                    h.p6.FRAME)
    sx, sy = acc.d.pointer_scale
    h.p4.rhwp_poc.drag(acc.d, (x * sx, y * sy), ((x + 20) * sx, (y + 12) * sy))
    pointer_events = acc.d.js("return window.p5RhdrPointers.slice(-2)")
    h.require([(event["type"], event["trusted"]) for event in pointer_events]
              == [("pointerdown", True), ("pointerup", True)],
              "HWP header movement did not use trusted Native pointer input", pointer_events)
    h.revision(acc, "hwp", 1)
    moved = {**before, "control": {**before["control"], "x": before["control"]["x"] + 20,
                                   "y": before["control"]["y"] + 12}}
    frame_after = select_header_picture(acc, moved)
    h.require(frame_after and (abs(frame_after["left"] - frame_before["left"]) > 2
                               or abs(frame_after["top"] - frame_before["top"]) > 2),
              "Native drag did not move the selected HWP header picture", [frame_before, frame_after])
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    frame_undo = select_header_picture(acc, before)
    h.require(same_geometry(frame_undo, frame_before), "HWP header Undo did not restore geometry", frame_undo)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    frame_redo = select_header_picture(acc, moved)
    h.require(same_geometry(frame_redo, frame_after), "HWP header Redo did not restore movement", frame_redo)
    row["movement"] = {"before": frame_before, "after": frame_after, "undo": frame_undo,
                        "redo": frame_redo, "trustedPointerEvents": pointer_events,
                        "ownerAddress": address}
    h.publish(acc, "hwp", row)

    after_state = rhwp_header_state(path)
    after = header_picture(after_state)
    h.require(after_state["owners"] == before_state["owners"] and after["address"] == address
              and after["owner"] == before["owner"], "HWP save changed header/footer ownership", after_state)
    before_props, after_props = before["properties"], after["properties"]
    h.require(any(before_props[key] != after_props[key] for key in ("horzOffset", "vertOffset")),
              "saved HWP header picture did not retain its movement", [before_props, after_props])
    for key in before_props:
        if key not in {"horzOffset", "vertOffset"}:
            h.require(before_props[key] == after_props[key], "HWP header edit changed another picture property",
                      [key, before_props[key], after_props[key]])
    before_pictures = {json.dumps(item["address"], sort_keys=True): item["properties"]
                       for item in before_state["pictures"] if item["address"] != address}
    after_pictures = {json.dumps(item["address"], sort_keys=True): item["properties"]
                      for item in after_state["pictures"] if item["address"] != address}
    h.require(before_pictures == after_pictures, "HWP header movement changed another owned picture",
              [before_pictures, after_pictures])

    streams_before = h.p6.gso.cfb_streams(fixture.read_bytes())
    streams_after = h.p6.gso.cfb_streams(path.read_bytes())
    h.require(set(streams_before) == set(streams_after), "HWP save changed the CFB stream inventory",
              [sorted(streams_before), sorted(streams_after)])
    changed = sorted(name for name in streams_before if streams_before[name] != streams_after[name])
    bin_data = {name for name in streams_before if name.startswith("BinData/")}
    allowed = {"BodyText/Section0", "DocInfo", "PrvImage", "PrvText", *bin_data}
    h.require("BodyText/Section0" in changed and set(changed) <= allowed,
              "HWP save changed streams outside the header story, compressed content, and previews", changed)

    # RHWP rewrites raw-DEFLATE envelopes while preserving the complete logical
    # DocInfo and BinData payloads. Compare the decompressed bytes, not compressor
    # output, so resource equality remains exact without rejecting a harmless
    # compression-level/implementation change.
    doc_info_before = h.p6.gso.unpacked(streams_before, "DocInfo")
    doc_info_after = h.p6.gso.unpacked(streams_after, "DocInfo")
    h.require(doc_info_before == doc_info_after,
              "HWP header movement changed DocInfo records after decompression")
    bin_data_hashes = {}
    for name in sorted(bin_data):
        old_bytes = h.p6.gso.unpacked(streams_before, name)
        new_bytes = h.p6.gso.unpacked(streams_after, name)
        h.require(old_bytes == new_bytes, "HWP header movement changed picture resource content", name)
        bin_data_hashes[name] = hashlib.sha256(old_bytes).hexdigest()
    h.require(streams_before["PrvText"] == streams_after["PrvText"],
              "image preview refresh changed the untouched HWP text preview")
    image = streams_after.get("PrvImage", b"")
    h.require(image != streams_before.get("PrvImage") and image.startswith(b"\x89PNG\r\n\x1a\n")
              and image[12:16] == b"IHDR" and len(image) >= 24,
              "HWP image preview was not independently serialized as a PNG")
    preview_size = [int.from_bytes(image[16:20], "big"), int.from_bytes(image[20:24], "big")]
    h.require(all(0 < value <= 1032 for value in preview_size),
              "HWP preview dimensions are outside the supported raster bounds", preview_size)

    before_records = h.p6.gso.records(h.p6.gso.unpacked(streams_before, "BodyText/Section0"))
    after_records = h.p6.gso.records(h.p6.gso.unpacked(streams_after, "BodyText/Section0"))
    h.require(len(before_records) == len(after_records)
              and all(old[:2] == new[:2] for old, new in zip(before_records, after_records)),
              "HWP header movement changed the body record topology")
    changed_records = [index for index, (old, new) in enumerate(zip(before_records, after_records))
                       if old != new]
    h.require(changed_records == [19, 20],
              "HWP header movement changed records outside its single owned picture", changed_records)

    control_before, control_after = before_records[19], after_records[19]
    h.require((control_before[:2], control_after[:2]) == ((71, 3), (71, 3))
              and control_before[2][:8] == control_after[2][:8]
              and control_before[2][16:] == control_after[2][16:],
              "HWP picture control changed identity or non-position fields")
    control_changed_bytes = [index for index, (old, new) in enumerate(zip(control_before[2], control_after[2]))
                             if old != new]
    h.require(control_changed_bytes and set(control_changed_bytes) <= set(range(8, 16)),
              "HWP picture control changed fields outside its position", control_changed_bytes)

    shape_before, shape_after = before_records[20], after_records[20]
    h.require((shape_before[:2], shape_after[:2]) == ((76, 4), (76, 4))
              and shape_before[2][:50] == shape_after[2][:50]
              and shape_before[2][196:] == shape_after[2][196:],
              "HWP picture component changed dimensions, identity, or non-transform data")

    def rendering_matrices(payload):
        count = struct.unpack_from("<H", payload, 50)[0]
        size = 2 + 48 + count * 96
        if count != 1 or len(payload) < 50 + size:
            return None
        raw = payload[50:50 + size]
        return [struct.unpack_from("<6d", raw, 2 + index * 48)
                for index in range(1 + 2 * count)]

    matrices_before = rendering_matrices(shape_before[2])
    matrices_after = rendering_matrices(shape_after[2])
    h.require(matrices_before is not None and matrices_after is not None,
              "HWP picture transform matrix structure is unsupported")
    ox, oy = struct.unpack_from("<ii", shape_before[2], 8)
    original_width, original_height, current_width, current_height = struct.unpack_from(
        "<IIII", shape_before[2], 20)
    h.require(min(original_width, original_height, current_width, current_height) > 0,
              "HWP picture transform has invalid dimensions")
    identity = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0)
    translation = (1.0, 0.0, float(ox), 0.0, 1.0, float(oy))
    source_scale = (current_width / original_width, 0.0, float(-ox),
                    0.0, current_height / original_height, float(-oy))
    close_matrix = lambda actual, expected: all(
        math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12) for a, b in zip(actual, expected)
    )
    h.require(close_matrix(matrices_before[0], translation)
              and close_matrix(matrices_before[1], source_scale)
              and close_matrix(matrices_before[2], identity)
              and close_matrix(matrices_after[0], translation)
              and close_matrix(matrices_after[1], identity)
              and close_matrix(matrices_after[2], identity),
              "HWP movement did not preserve the proven scaled-source transform while normalizing it",
              {"before": matrices_before, "after": matrices_after})
    row["cfbProof"] = {
        "rawChangedStreams": changed,
        "streamInventoryPreserved": True,
        "docInfoUncompressedBytesPreserved": True,
        "binDataUncompressedSha256": bin_data_hashes,
        "textPreviewPreserved": True,
        "imagePreviewPngDimensions": preview_size,
        "changedSectionRecordIndices": changed_records,
        "pictureControlChangedBytes": control_changed_bytes,
        "pictureTransform": {"sourceMatrices": matrices_before, "savedMatrices": matrices_after,
                             "sourceDimensions": [original_width, original_height],
                             "currentDimensions": [current_width, current_height]},
    }

    h.reopen(acc, path, row)
    reopened_state = rhwp_header_state(path)
    reopened = header_picture(reopened_state)
    h.require(reopened["address"] == after["address"] and reopened["owner"] == after["owner"]
              and reopened["properties"] == after["properties"],
              "HWP header ownership or serialized movement changed on reopen", reopened)
    reopened_frame = select_header_picture(acc, reopened)
    h.require(same_geometry(reopened_frame, frame_redo, 1.5),
              "HWP saved header did not render at its moved position after reopen", [frame_redo, reopened_frame])
    row["reopened"] = {"frame": reopened_frame, "picture": reopened,
                       "publishedSha256": row["publishedSha256"]}
    (out / "header-hwp-expected.json").write_text(json.dumps({
        "savedFile": path.name, "publishedSha256": row["publishedSha256"],
        "appSha256": row["processAppSha256"], "appPid": row["appPid"],
        "owners": after_state["owners"], "header": after,
    }, indent=2, ensure_ascii=False) + "\n")


def canonical_xml(data):
    root = ET.fromstring(data)
    return ET.canonicalize(ET.tostring(root, encoding="unicode"))


def hwpx_header_picture_element(root, address):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    paragraphs = [node for node in list(root) if node.tag == hp + "p"]
    outer_index = address["outerParagraph"]
    h.require(outer_index < len(paragraphs), "HWPX header outer paragraph is outside the section", outer_index)
    outer_controls = list(paragraphs[outer_index].iter(hp + "ctrl"))
    control_index = address["outerControl"]
    h.require(control_index < len(outer_controls), "HWPX outer control is outside its paragraph", control_index)
    header = outer_controls[control_index].find(hp + "header")
    h.require(header is not None, "HWPX outer control is not a header", control_index)
    sublist = header.find(hp + "subList")
    h.require(sublist is not None, "HWPX header has no owned subList")
    inner = sublist.findall(hp + "p")
    paragraph_index = address["innerParagraph"]
    h.require(paragraph_index < len(inner), "HWPX header inner paragraph is outside the subList", paragraph_index)
    pictures = list(inner[paragraph_index].iter(hp + "pic"))
    control = address["innerControl"]
    h.require(len(pictures) == 1 and control == 0,
              "HWPX fixture inner paragraph must contain one unambiguous picture control",
              {"control": control, "pictures": len(pictures)})
    picture = pictures[0]
    size = picture.find(hp + "sz")
    h.require(size is not None, "HWPX header picture has no modeled size node")
    return picture, size


def prove_hwpx_header_resize(source, output, address, before_state, after_state):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as saved:
        old_names, new_names = set(original.namelist()), set(saved.namelist())
        h.require(old_names == new_names, "HWPX header resize changed OPC inventory",
                  {"added": sorted(new_names - old_names), "removed": sorted(old_names - new_names)})
        changed = sorted(name for name in old_names if original.read(name) != saved.read(name))
        h.require("Contents/section0.xml" in changed, "HWPX section XML did not contain the header resize", changed)
        h.require(set(changed) <= {"Contents/section0.xml", "Contents/header.xml", "Contents/content.hpf"},
                  "HWPX save changed an unrelated package part", changed)
        for name in ("Contents/header.xml", "Contents/content.hpf"):
            if name in old_names:
                h.require(canonical_xml(original.read(name)) == canonical_xml(saved.read(name)),
                          "HWPX header edit changed shared metadata XML", name)
        for name in old_names:
            if name.endswith(".rels") or "/BinData/" in name:
                h.require(original.read(name) == saved.read(name), "HWPX header edit changed a relationship or media part", name)

        before_root = ET.fromstring(original.read("Contents/section0.xml"))
        after_root = ET.fromstring(saved.read("Contents/section0.xml"))
        before_picture, before_size = hwpx_header_picture_element(before_root, address)
        after_picture, after_size = hwpx_header_picture_element(after_root, address)
        old_size, new_size = dict(before_size.attrib), dict(after_size.attrib)
        h.require(set(old_size) == set(new_size) and
                  {key: value for key, value in old_size.items() if key not in {"width", "height"}} ==
                  {key: value for key, value in new_size.items() if key not in {"width", "height"}},
                  "HWPX picture size edit changed size-node metadata", [old_size, new_size])
        h.require((old_size.get("width"), old_size.get("height")) !=
                  (new_size.get("width"), new_size.get("height")), "HWPX saved picture size did not change", new_size)
        after_size.attrib = old_size
        h.require(ET.canonicalize(ET.tostring(before_root, encoding="unicode")) ==
                  ET.canonicalize(ET.tostring(after_root, encoding="unicode")),
                  "HWPX section changed beyond the exact owned picture size node")

        before_secpr = [node for node in before_root.iter(hp + "secPr")]
        after_secpr = [node for node in ET.fromstring(saved.read("Contents/section0.xml")).iter(hp + "secPr")]
        h.require(len(before_secpr) == len(after_secpr) == 1, "HWPX source section properties are ambiguous")
        before_presentation = before_secpr[0].find(hp + "presentation")
        after_presentation = after_secpr[0].find(hp + "presentation")
        h.require((before_presentation is None) == (after_presentation is None)
                  and (before_presentation is None or
                    canonical_xml(ET.tostring(before_presentation, encoding="unicode").encode()) ==
                    canonical_xml(ET.tostring(after_presentation, encoding="unicode").encode())),
                  "HWPX unknown presentation metadata was lost or changed")
        h.require(after_picture.get("id") == before_picture.get("id"),
                  "HWPX header resize changed picture identity", [before_picture.get("id"), after_picture.get("id")])
        return {"changedParts": changed, "pictureSizeBefore": old_size, "pictureSizeAfter": new_size,
                "presentationPreserved": True, "unrelatedRelationshipsAndMediaPreserved": True}


def header_picture_hwpx(acc, row, fixtures, out):
    fixture = fixtures / "header-original.hwpx"
    before_state = rhwp_header_state(fixture)
    before = header_picture(before_state)
    address = before["address"]
    h.require(address == {"section": 0, "kind": "header", "outerParagraph": 1, "outerControl": 1,
                         "innerParagraph": 0, "innerControl": 0},
              "HWPX authentic header fixture owner changed", address)
    h.require(before["properties"]["treatAsChar"] is True,
              "HWPX fixture must exercise a simple inline header picture", before["properties"])
    path = h.begin(acc, row, fixture, out, "header-hwpx-resized.hwpx")
    frame_before = select_header_picture(acc, before)
    ui_before = h.p6.gso.props(acc, "picture")
    props_before = before["properties"]
    expected_before = [props_before["width"] / 100, props_before["height"] / 100]
    h.require(all(abs(ui_before["size"][i] - expected_before[i]) <= 0.02 for i in range(2)),
              "trusted hit selected a different HWPX header picture", [ui_before, expected_before])
    h.require(acc.d.exists(h.p6.gso.SIZE), "inline header picture has no resize fields")
    width_field = h.p6.gso.SIZE
    requested_width = 100
    h.p6.gso.replace(acc, width_field, str(requested_width))
    acc.dom_click(SIZE_FORM + " button[type=submit]")
    h.revision(acc, "hwpx", 1)
    frame_after = select_header_picture(acc, before)
    ui_after = h.p6.gso.props(acc, "picture")
    h.require(ui_after["size"][0] == requested_width and ui_after["size"][1] > ui_before["size"][1],
              "Native resize did not update the selected inline header picture proportionally", [ui_before, ui_after])
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    frame_undo = select_header_picture(acc, before)
    h.require(same_geometry(frame_undo, frame_before), "HWPX header Undo did not restore geometry", frame_undo)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    frame_redo = select_header_picture(acc, before)
    h.require(same_geometry(frame_redo, frame_after), "HWPX header Redo did not restore resize", frame_redo)
    row["resize"] = {"before": frame_before, "after": frame_after, "undo": frame_undo,
                      "redo": frame_redo, "ownerAddress": address}
    h.publish(acc, "hwpx", row)

    after_state = rhwp_header_state(path)
    after = header_picture(after_state)
    h.require(after_state["owners"] == before_state["owners"] and after["address"] == address
              and after["owner"] == before["owner"], "HWPX resize changed header/footer ownership", after_state)
    props_after = after["properties"]
    h.require(props_after["width"] > props_before["width"] and props_after["height"] > props_before["height"],
              "HWPX serialized header picture did not retain its resize", [props_before, props_after])
    for key in props_before:
        if key not in {"width", "height"}:
            h.require(props_before[key] == props_after[key], "HWPX header resize changed another picture property",
                      [key, props_before[key], props_after[key]])
    before_pictures = {json.dumps(item["address"], sort_keys=True): item["properties"]
                       for item in before_state["pictures"] if item["address"] != address}
    after_pictures = {json.dumps(item["address"], sort_keys=True): item["properties"]
                      for item in after_state["pictures"] if item["address"] != address}
    h.require(before_pictures == after_pictures, "HWPX header resize changed another owned picture",
              [before_pictures, after_pictures])
    row["opcProof"] = prove_hwpx_header_resize(fixture, path, address, before_state, after_state)
    h.reopen(acc, path, row)
    reopened_state = rhwp_header_state(path)
    reopened = header_picture(reopened_state)
    h.require(reopened["address"] == after["address"] and reopened["owner"] == after["owner"]
              and reopened["properties"] == after["properties"],
              "HWPX header ownership or size changed on reopen", reopened)
    reopened_frame = select_header_picture(acc, reopened)
    reopened_ui = h.p6.gso.props(acc, "picture")
    h.require(reopened_ui["size"] == [props_after["width"] / 100, props_after["height"] / 100],
              "HWPX header resize did not render after reopen", [reopened_ui, props_after])
    h.require(same_geometry(reopened_frame, frame_redo, 1.5),
              "HWPX header geometry changed after reopen", [frame_redo, reopened_frame])
    row["reopened"] = {"frame": reopened_frame, "picture": reopened, "ui": reopened_ui,
                       "publishedSha256": row["publishedSha256"]}
    (out / "header-hwpx-expected.json").write_text(json.dumps({
        "savedFile": path.name, "publishedSha256": row["publishedSha256"],
        "appSha256": row["processAppSha256"], "appPid": row["appPid"],
        "owners": after_state["owners"], "header": after,
    }, indent=2, ensure_ascii=False) + "\n")


def header_picture_hwp_fresh(acc, row, fixtures, out):
    header_fresh_reopen(acc, row, fixtures, out, "hwp")


def header_picture_hwpx_fresh(acc, row, fixtures, out):
    header_fresh_reopen(acc, row, fixtures, out, "hwpx")


def footer_picture(state, address=None, treat_as_char=None, require_resizable=False):
    pictures = [item for item in state["pictures"] if item["address"]["kind"] == "footer"]
    if address is not None:
        pictures = [item for item in pictures if item["address"] == address]
    else:
        if treat_as_char is not None:
            pictures = [item for item in pictures if item["properties"]["treatAsChar"] is treat_as_char]
        if require_resizable:
            pictures = [item for item in pictures if item["properties"]["sizeProtect"] is False]
        if pictures:
            first_address = min((item["address"]["innerParagraph"], item["address"]["innerControl"])
                                for item in pictures)
            pictures = [item for item in pictures
                        if (item["address"]["innerParagraph"], item["address"]["innerControl"]) == first_address]
    h.require(len(pictures) == 1, "fixture must expose one exact footer picture address", pictures)
    picture = pictures[0]
    owner = picture["owner"]
    address = picture["address"]
    h.require(owner is not None and owner["ctrlId"] == "foot" and owner["userDesc"] == "꼬리말"
              and owner["list"] == 0 and owner["para"] == address["outerParagraph"]
              and owner["controlIndex"] == address["outerControl"],
              "footer picture address does not resolve to its exact section owner", picture)
    return picture


def footer_fit_large_hwp_document(acc):
    zoom_selector = ".statusbar__zoom-value"
    zoom = int(acc.d.js("return parseInt(document.querySelector(arguments[0])?.textContent||'',10)", zoom_selector))
    starting_zoom = zoom
    while zoom > 50:
        acc.dom_click('[data-command="view.zoomOut"]')
        acc.wait("return parseInt(document.querySelector(arguments[0])?.textContent||'',10)<arguments[1]",
                 zoom_selector, zoom, timeout=5)
        zoom = int(acc.d.js("return parseInt(document.querySelector(arguments[0])?.textContent||'',10)", zoom_selector))
    acc.wait("const e=document.querySelector('[data-testid=rhwp-status]');return e?.dataset.firstPaintMs!==''",
             timeout=60)
    acc.wait("return document.querySelector('.editor__scroll canvas')?.width>0")
    return {"startingZoom": starting_zoom, "renderableZoom": zoom,
            "firstPaintMs": acc.status("hwp")["firstPaintMs"]}


def hwpx_footer_picture_element(root, address):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    paragraphs = [node for node in list(root) if node.tag == hp + "p"]
    outer_index = address["outerParagraph"]
    h.require(outer_index < len(paragraphs), "HWPX footer outer paragraph is outside the section", outer_index)
    outer_controls = list(paragraphs[outer_index].iter(hp + "ctrl"))
    control_index = address["outerControl"]
    h.require(control_index < len(outer_controls), "HWPX footer outer control is outside its paragraph", control_index)
    footer = outer_controls[control_index].find(hp + "footer")
    h.require(footer is not None, "HWPX outer control is not a footer", control_index)
    sublist = footer.find(hp + "subList")
    h.require(sublist is not None, "HWPX footer has no owned subList")
    inner = sublist.findall(hp + "p")
    paragraph_index = address["innerParagraph"]
    h.require(paragraph_index < len(inner), "HWPX footer inner paragraph is outside the subList", paragraph_index)
    pictures = list(inner[paragraph_index].iter(hp + "pic"))
    control = address["innerControl"]
    picture_index = control - 1
    h.require(0 <= picture_index < len(pictures),
              "HWPX footer picture control does not map to its exact source picture",
              {"control": control, "pictures": len(pictures)})
    picture = pictures[picture_index]
    size = picture.find(hp + "sz")
    h.require(size is not None, "HWPX footer picture has no modeled size node")
    return picture, size


def normalize_hwpx_description_line_endings(root):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    for node in root.iter(hp + "shapeComment"):
        if node.text is not None:
            node.text = node.text.replace("\r\n", "\n").replace("\r", "\n")


def prove_hwpx_footer_resize(source, output, address, before_state, after_state):
    hp = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as saved:
        old_names, new_names = set(original.namelist()), set(saved.namelist())
        h.require(old_names == new_names, "HWPX footer resize changed OPC inventory",
                  {"added": sorted(new_names - old_names), "removed": sorted(old_names - new_names)})
        changed = sorted(name for name in old_names if original.read(name) != saved.read(name))
        allowed_changes = {"Contents/section0.xml", "Contents/header.xml", "Contents/content.hpf",
                           "Preview/PrvImage.png", "Preview/PrvText.txt"}
        h.require("Contents/section0.xml" in changed and set(changed) <= allowed_changes,
                  "HWPX save changed a package part outside the footer story or known preview metadata", changed)
        for name in ("Contents/header.xml", "Contents/content.hpf"):
            if name in old_names:
                h.require(canonical_xml(original.read(name)) == canonical_xml(saved.read(name)),
                          "HWPX footer edit changed shared package metadata", name)
        for name in old_names:
            if name.endswith(".rels") or "/BinData/" in name:
                h.require(original.read(name) == saved.read(name),
                          "HWPX footer edit changed a relationship or media part", name)
        if "Preview/PrvText.txt" in old_names:
            h.require(original.read("Preview/PrvText.txt") == saved.read("Preview/PrvText.txt"),
                      "HWPX footer resize changed the untouched text preview")
        preview = saved.read("Preview/PrvImage.png") if "Preview/PrvImage.png" in old_names else b""
        if "Preview/PrvImage.png" in changed:
            h.require(preview.startswith(b"\x89PNG\r\n\x1a\n") and preview[12:16] == b"IHDR" and len(preview) >= 24,
                      "HWPX footer save did not serialize a valid PNG preview")

        before_root = ET.fromstring(original.read("Contents/section0.xml"))
        after_root = ET.fromstring(saved.read("Contents/section0.xml"))
        before_picture, before_size = hwpx_footer_picture_element(before_root, address)
        after_picture, after_size = hwpx_footer_picture_element(after_root, address)
        old_size, new_size = dict(before_size.attrib), dict(after_size.attrib)
        h.require(set(old_size) == set(new_size)
                  and {key: value for key, value in old_size.items() if key not in {"width", "height"}}
                  == {key: value for key, value in new_size.items() if key not in {"width", "height"}},
                  "HWPX picture size edit changed size-node metadata", [old_size, new_size])
        h.require((old_size.get("width"), old_size.get("height")) !=
                  (new_size.get("width"), new_size.get("height")),
                  "HWPX saved footer picture size did not change", new_size)

        before_cur = before_picture.find(hp + "curSz")
        after_cur = after_picture.find(hp + "curSz")
        h.require(before_cur is not None and after_cur is not None,
                  "HWPX footer picture has no current-size node")
        old_cur, new_cur = dict(before_cur.attrib), dict(after_cur.attrib)
        h.require(set(old_cur) == set(new_cur)
                  and {key: value for key, value in old_cur.items() if key not in {"width", "height"}}
                  == {key: value for key, value in new_cur.items() if key not in {"width", "height"}}
                  and (old_cur.get("width"), old_cur.get("height")) ==
                  (old_size.get("width"), old_size.get("height"))
                  and (new_cur.get("width"), new_cur.get("height")) ==
                  (new_size.get("width"), new_size.get("height")),
                  "HWPX resize did not update only the target picture's derived current size",
                  {"before": old_cur, "after": new_cur, "sizeBefore": old_size, "sizeAfter": new_size})

        core = "{http://www.hancom.co.kr/hwpml/2011/core}"
        before_scale = before_picture.find(hp + "renderingInfo/" + core + "scaMatrix")
        after_scale = after_picture.find(hp + "renderingInfo/" + core + "scaMatrix")
        h.require(before_scale is not None and after_scale is not None,
                  "HWPX footer picture has no scaling matrix")
        old_scale, new_scale = dict(before_scale.attrib), dict(after_scale.attrib)
        h.require(set(old_scale) == set(new_scale)
                  and {key: value for key, value in old_scale.items() if key in {"e2", "e3", "e4", "e6"}}
                  == {key: value for key, value in new_scale.items() if key in {"e2", "e3", "e4", "e6"}}
                  and new_scale.get("e1") == new_scale.get("e5") == "1",
                  "HWPX resize changed more than the target picture's derived scale",
                  {"before": old_scale, "after": new_scale})

        after_size.attrib = old_size
        after_cur.attrib = old_cur
        after_scale.attrib = old_scale
        normalize_hwpx_description_line_endings(before_root)
        normalize_hwpx_description_line_endings(after_root)
        h.require(canonical_xml(ET.tostring(before_root, encoding="unicode").encode())
                  == canonical_xml(ET.tostring(after_root, encoding="unicode").encode()),
                  "HWPX section changed outside the footer picture size and its derived geometry")
        h.require(after_picture.get("id") == before_picture.get("id")
                  and after_picture.get("instid") == before_picture.get("instid"),
                  "HWPX footer resize changed picture identity")
        before_pic = footer_picture(before_state, address)
        after_pic = footer_picture(after_state, address)
        h.require(before_pic["properties"]["originalWidth"] == after_pic["properties"]["originalWidth"]
                  and before_pic["properties"]["originalHeight"] == after_pic["properties"]["originalHeight"],
                  "HWPX footer resize changed source image dimensions")
        return {"changedParts": changed, "pictureSizeBefore": old_size, "pictureSizeAfter": new_size,
                "derivedCurrentSizeBefore": old_cur, "derivedCurrentSizeAfter": new_cur,
                "derivedScaleBefore": old_scale, "derivedScaleAfter": new_scale,
                "shapeCommentLineEndingsEquivalent": True,
                "pictureId": before_picture.get("id"), "instid": before_picture.get("instid"),
                "unrelatedRelationshipsAndMediaPreserved": True,
                "sectionChangedOnlyAtOwnedPictureSizeAndDerivedGeometry": True}


def footer_picture_resize(acc, row, fixtures, out, fmt):
    fixture = fixtures / f"footer-original.{fmt}"
    before_state = rhwp_header_state(fixture)
    if fmt == "hwp":
        target_address = {"section": 0, "kind": "footer", "outerParagraph": 4, "outerControl": 0,
                          "innerParagraph": 0, "innerControl": 1}
        before = footer_picture(before_state, address=target_address)
    else:
        before = footer_picture(before_state, treat_as_char=True, require_resizable=True)
    address = before["address"]
    if fmt == "hwp":
        h.require(address == {"section": 0, "kind": "footer", "outerParagraph": 4, "outerControl": 0,
                              "innerParagraph": 0, "innerControl": 1},
                  "authentic HWP footer fixture owner changed", address)
        h.require(0 <= before["control"]["x"]
                  and before["control"]["x"] + before["control"]["w"] <= 794
                  and 0 <= before["control"]["y"]
                  and before["control"]["y"] + before["control"]["h"] <= 1123,
                  "authentic HWP footer target is not within its logical page bounds", before["control"])
    else:
        h.require(address == {"section": 0, "kind": "footer", "outerParagraph": 0, "outerControl": 4,
                              "innerParagraph": 0, "innerControl": 2},
                  "authentic HWPX footer fixture owner changed", address)
    h.require(before["properties"]["treatAsChar"] is True
              and before["properties"]["sizeProtect"] is False,
              "footer resize fixture must be an unlocked inline picture", before["properties"])
    path = h.begin(acc, row, fixture, out, f"footer-{fmt}-resized.{fmt}")
    if fmt == "hwp":
        row["renderBudgetZoom"] = footer_fit_large_hwp_document(acc)
    acc.d.js("""
      window.p5RftrPointers=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>
        window.p5RftrPointers.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY}),true);
    """)
    frame_before = select_header_picture(acc, before, scroll_to_object=fmt == "hwp")
    ui_before = h.p6.gso.props(acc, "picture")
    expected_before = [before["properties"]["width"] / 100, before["properties"]["height"] / 100]
    h.require(all(abs(ui_before["size"][i] - expected_before[i]) <= 0.02 for i in range(2)),
              f"trusted hit selected a different {fmt.upper()} footer picture", [ui_before, expected_before])
    pointer_events = acc.d.js("return window.p5RftrPointers.slice(-2)")
    h.require([(event["type"], event["trusted"]) for event in pointer_events]
              == [("pointerdown", True), ("pointerup", True)],
              f"{fmt.upper()} footer selection did not use trusted Native pointer input", pointer_events)
    h.require(acc.d.exists(h.p6.gso.SIZE), "inline footer picture has no resize fields")
    requested_width = 100
    h.require(abs(ui_before["size"][0] - requested_width) > 0.01,
              "footer fixture size unexpectedly matches the requested test size", ui_before)
    h.p6.gso.replace(acc, h.p6.gso.SIZE, str(requested_width))
    acc.dom_click(SIZE_FORM + " button[type=submit]")
    h.revision(acc, fmt, 1)
    frame_after = select_header_picture(acc, before, scroll_to_object=fmt == "hwp")
    ui_after = h.p6.gso.props(acc, "picture")
    h.require(ui_after["size"][0] == requested_width and ui_after["size"][1] > 0
              and ui_after["size"] != ui_before["size"],
              f"Native {fmt.upper()} resize did not update the selected inline footer picture", [ui_before, ui_after])
    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    frame_undo = select_header_picture(acc, before, scroll_to_object=fmt == "hwp")
    h.require(same_geometry(frame_undo, frame_before), f"{fmt.upper()} footer Undo did not restore geometry", frame_undo)
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    frame_redo = select_header_picture(acc, before, scroll_to_object=fmt == "hwp")
    h.require(same_geometry(frame_redo, frame_after), f"{fmt.upper()} footer Redo did not restore resize", frame_redo)
    row["resize"] = {"before": frame_before, "after": frame_after, "undo": frame_undo,
                      "redo": frame_redo, "ownerAddress": address, "trustedPointerEvents": pointer_events,
                      "sizeBefore": ui_before["size"], "sizeAfter": ui_after["size"]}
    h.publish(acc, fmt, row)

    after_state = rhwp_header_state(path)
    after = footer_picture(after_state, address)
    h.require(after_state["owners"] == before_state["owners"] and after["owner"] == before["owner"],
              f"{fmt.upper()} resize changed footer ownership", after_state)
    for key in before["properties"]:
        if key not in {"width", "height"}:
            h.require(before["properties"][key] == after["properties"][key],
                      f"{fmt.upper()} footer resize changed another picture property",
                      [key, before["properties"][key], after["properties"][key]])
    h.require(after["properties"]["width"] != before["properties"]["width"]
              and after["properties"]["height"] != before["properties"]["height"],
              f"{fmt.upper()} footer resize was not serialized", [before["properties"], after["properties"]])
    before_pictures = {json.dumps(item["address"], sort_keys=True): item["properties"]
                       for item in before_state["pictures"] if item["address"] != address}
    after_pictures = {json.dumps(item["address"], sort_keys=True): item["properties"]
                      for item in after_state["pictures"] if item["address"] != address}
    h.require(before_pictures == after_pictures, f"{fmt.upper()} footer resize changed a sibling picture",
              [before_pictures, after_pictures])

    if fmt == "hwp":
        streams_before = h.p6.gso.cfb_streams(fixture.read_bytes())
        streams_after = h.p6.gso.cfb_streams(path.read_bytes())
        h.require(set(streams_before) == set(streams_after), "HWP footer save changed the CFB stream inventory")
        changed = sorted(name for name in streams_before if streams_before[name] != streams_after[name])
        bin_data = {name for name in streams_before if name.startswith("BinData/")}
        allowed = {"BodyText/Section0", "DocInfo", "PrvImage", "PrvText", *bin_data}
        h.require("BodyText/Section0" in changed and set(changed) <= allowed,
                  "HWP footer save changed streams outside its story, preview, or resources", changed)
        h.require(h.p6.gso.unpacked(streams_before, "DocInfo") == h.p6.gso.unpacked(streams_after, "DocInfo"),
                  "HWP footer resize changed DocInfo records")
        resource_hashes = {}
        for name in sorted(bin_data):
            old, new = h.p6.gso.unpacked(streams_before, name), h.p6.gso.unpacked(streams_after, name)
            h.require(old == new, "HWP footer resize changed image resource bytes", name)
            resource_hashes[name] = hashlib.sha256(old).hexdigest()
        h.require(streams_before["PrvText"] == streams_after["PrvText"],
                  "HWP footer resize changed the text preview")
        image = streams_after.get("PrvImage", b"")
        h.require(image.startswith(b"\x89PNG\r\n\x1a\n") and image[12:16] == b"IHDR" and len(image) >= 24,
                  "HWP footer save did not contain a valid PNG preview")
        preview_size = [int.from_bytes(image[16:20], "big"), int.from_bytes(image[20:24], "big")]
        h.require(all(0 < value <= 1032 for value in preview_size), "HWP preview dimensions are out of bounds", preview_size)
        old_records = h.p6.gso.records(h.p6.gso.unpacked(streams_before, "BodyText/Section0"))
        new_records = h.p6.gso.records(h.p6.gso.unpacked(streams_after, "BodyText/Section0"))
        h.require(len(old_records) == len(new_records)
                  and all(old[:2] == new[:2] for old, new in zip(old_records, new_records)),
                  "HWP footer resize changed Section0 record topology")
        owner_spans = []
        for index, record in enumerate(old_records):
            if record[0] == 71 and record[1] == 1 and record[2].startswith(b"toof"):
                end = next((j for j in range(index + 1, len(old_records)) if old_records[j][1] <= record[1]),
                           len(old_records))
                owner_spans.append((index, end))
        h.require(len(owner_spans) == 1, "HWP Section0 does not contain one exact footer owner", owner_spans)
        start, end = owner_spans[0]
        changed_records = [index for index, (old, new) in enumerate(zip(old_records, new_records)) if old != new]
        h.require(changed_records and all(start <= index < end for index in changed_records),
                  "HWP resize changed records outside the footer owner", changed_records)
        row["cfbProof"] = {"changedStreams": changed, "streamInventoryPreserved": True,
                           "docInfoPreserved": True, "binDataUncompressedSha256": resource_hashes,
                           "textPreviewPreserved": True, "imagePreviewPngDimensions": preview_size,
                           "footerOwnerRecordSpan": [start, end], "changedSectionRecordIndices": changed_records}
    else:
        row["opcProof"] = prove_hwpx_footer_resize(fixture, path, address, before_state, after_state)

    h.reopen(acc, path, row)
    reopened_state = rhwp_header_state(path)
    reopened = footer_picture(reopened_state, address)
    h.require(reopened_state["owners"] == after_state["owners"] and reopened["owner"] == after["owner"]
              and reopened["properties"] == after["properties"],
              f"{fmt.upper()} footer ownership or size changed on reopen", reopened)
    reopened_frame = select_header_picture(acc, reopened, scroll_to_object=fmt == "hwp")
    reopened_ui = h.p6.gso.props(acc, "picture")
    h.require(reopened_ui["size"] == [after["properties"]["width"] / 100,
                                      after["properties"]["height"] / 100],
              f"{fmt.upper()} footer picture did not render at its saved size after reopen", reopened_ui)
    h.require(same_geometry(reopened_frame, frame_redo, 1.5),
              f"{fmt.upper()} footer picture layout changed after reopen", [frame_redo, reopened_frame])
    row["reopened"] = {"frame": reopened_frame, "picture": reopened, "ui": reopened_ui,
                       "publishedSha256": row["publishedSha256"]}
    (out / f"footer-{fmt}-expected.json").write_text(json.dumps({
        "savedFile": path.name, "publishedSha256": row["publishedSha256"],
        "appSha256": row["processAppSha256"], "appPid": row["appPid"],
        "owners": after_state["owners"], "footer": after, "finalFrame": frame_redo,
    }, indent=2, ensure_ascii=False) + "\n")


def footer_picture_hwp(acc, row, fixtures, out):
    footer_picture_resize(acc, row, fixtures, out, "hwp")


def footer_picture_hwpx(acc, row, fixtures, out):
    footer_picture_resize(acc, row, fixtures, out, "hwpx")


def footer_fresh_reopen(acc, row, fixtures, out, fmt):
    expected = json.loads((out / f"footer-{fmt}-expected.json").read_text())
    fixture = out / expected["savedFile"]
    path = h.begin(acc, row, fixture, out, f"footer-{fmt}-fresh-reopen.{fmt}")
    if fmt == "hwp":
        row["renderBudgetZoom"] = footer_fit_large_hwp_document(acc)
    row["expectedSavedSha256"] = expected["publishedSha256"]
    row["savedSha256"] = h.digest(path)
    h.require(row["savedSha256"] == expected["publishedSha256"], "fresh footer session input differs from saved file")
    h.require(row["processAppSha256"] == expected["appSha256"] and row["appPid"] != expected["appPid"],
              "footer fresh reopen did not use a distinct process with the same Release application")
    h.require(row["initialSession"].get("dirty") == "false"
              and row["initialSession"].get("unpreserved") == "false",
              "saved footer document reopened dirty or unpreserved", row["initialSession"])
    state = rhwp_header_state(path)
    picture = footer_picture(state, expected["footer"]["address"])
    h.require(state["owners"] == expected["owners"] and picture["owner"] == expected["footer"]["owner"]
              and picture["properties"] == expected["footer"]["properties"],
              "fresh footer reopen changed story ownership or object properties", picture)
    frame = select_header_picture(acc, picture, scroll_to_object=fmt == "hwp")
    ui = h.p6.gso.props(acc, "picture")
    props = picture["properties"]
    h.require(ui["size"] == [props["width"] / 100, props["height"] / 100],
              "fresh Native footer rendering uses a different picture size", [ui, props])
    h.require(same_geometry(frame, expected["finalFrame"], 1.5),
              "fresh Native footer rendering changed its saved placement", [expected["finalFrame"], frame])
    row["readOnlyFreshProcessReopen"] = {"frame": frame, "picture": picture, "ui": ui,
                                         "savedSha256": row["savedSha256"]}
SIZE_FORM = "[aria-labelledby=properties-selection] .object-tools form:has(input[max='4000'])"
WIDTH = SIZE_FORM + " label:first-of-type input"


def stories(acc, row, fixtures, out, resize=False):
    fixture = fixtures / "a-p5-story-original.docx"
    path = h.begin(acc, row, fixture, out, "a-p5-story-resized.docx" if resize else "a-p5-story-edited.docx")
    layout = json.loads((fixtures / "a-p5-story-layout.json").read_text())
    row["targets"] = []
    picture_order = ("header", "body", "endnote", "footnote", "footer")

    def select_at(name, expected):
        where = layout[name]
        # The fixture's five pictures occupy disjoint rows. WordCraft composites
        # inactive header/footer pictures on white at 45% opacity.
        acc.wait("""
          const canvas = document.querySelectorAll('.docx-page canvas')[arguments[0]];
          return canvas?.width > 0 && canvas.parentElement.dataset.current === 'true' &&
            canvas.parentElement.dataset.revision ===
            document.querySelector('[data-testid=docx-status]').dataset.revision;
        """, where["page"])
        points = acc.d.js("""
          const page = arguments[0], c = document.querySelectorAll('.docx-page canvas')[page];
          const sx = c.width / c.clientWidth, sy = c.height / c.clientHeight;
          const {data} = c.getContext('2d').getImageData(0, 0, c.width, c.height);
          const points = [];
          let count = 0, sumX = 0, sumY = 0;
          for (let y = 0; y <= c.height; y++) {
            let row = 0, rowX = 0;
            if (y < c.height) {
              for (let x = 0; x < c.width; x++) {
                const i=(y*c.width+x)*4;
                const opaque = data[i]===140 && data[i+1]===90 && data[i+2]===40;
                const dimmed = Math.abs(data[i]-203)<=2 && Math.abs(data[i+1]-181)<=2 && Math.abs(data[i+2]-158)<=2;
                if(!opaque && !dimmed) continue;
                row++; rowX += x;
              }
            }
            if(row > 5) { count += row; sumX += rowX; sumY += y*row; }
            else if(count > 0) {
              if(count > 100) points.push([page,sumX/count/sx,sumY/count/sy]);
              count=0; sumX=0; sumY=0;
            }
          }
          return points;
        """, where["page"])
        h.require(len(points) == len(picture_order), "expected exactly five drawn pictures", [name, points])
        point = points[picture_order.index(name)]
        row["targets"].append({"story": name, "description": expected, "point": point})
        h.p6.pointer(acc, point)
        acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", DESCRIPTION, expected, timeout=10)

    next_revision = 0
    row["storyRevisions"] = {}
    def size_is(points):
        acc.wait("return +document.querySelector(arguments[0])?.value === arguments[1]", WIDTH, points)

    for name in layout:
        select_at(name, name)
        if name in ("header", "footer", "footnote", "endnote"):
            h.require(acc.d.exists("[data-testid='object-move']"), "owned note movement unavailable")
        else:
            h.require(not acc.d.exists("[data-testid='object-move']"), "body movement unexpectedly enabled")
        if resize:
            size_is(28)
            h.p6.gso.replace(acc, WIDTH, "35")
            acc.dom_click(SIZE_FORM + " button[type=submit]")
            expected = name
        else:
            acc.dom_click(DESCRIPTION)
            acc.key("End")
            acc.type(" 35")
            expected = f"{name} 35"
            acc.wait("return document.querySelector(arguments[0])?.value===arguments[1]", DESCRIPTION, expected)
            acc.dom_click("[aria-labelledby=properties-selection] .object-tools form:has(input[maxlength='1024']) button[type=submit]")
        next_revision += 1
        h.revision(acc, "docx", next_revision)
        if resize:
            select_at(name, name)
            size_is(35)
        acc.key("ctrl+z")
        next_revision += 1
        h.revision(acc, "docx", next_revision)
        select_at(name, name)
        if resize:
            size_is(28)
        acc.key("ctrl+y")
        next_revision += 1
        h.revision(acc, "docx", next_revision)
        select_at(name, expected)
        if resize:
            size_is(35)
        row["storyRevisions"][name] = next_revision
    h.publish(acc, "docx", row)
    with zipfile.ZipFile(fixture) as before, zipfile.ZipFile(path) as after:
        h.require(set(before.namelist()) == set(after.namelist()), "OPC inventory changed")
        owned = {value["part"]: name for name, value in layout.items()}
        for part in before.namelist():
            if part not in owned:
                h.require(before.read(part) == after.read(part), "unrelated OPC part changed", part)
                continue
            name = owned[part]
            old, new = [ET.fromstring(package.read(part)) for package in (before, after)]
            if resize:
                paths = (f".//{WP}inline/{WP}extent", f".//{PIC}spPr/{A}xfrm/{A}ext")
                for extent in paths:
                    node = old.find(extent)
                    h.require(node is not None and node.attrib == {"cx":"355600", "cy":"279400"},
                              "unexpected original picture dimensions", part)
                    node.set("cx", "444500")
                    node.set("cy", "349250")
            else:
                for tag in (f"{WP}docPr", f"{PIC}cNvPr"):
                    node = old.find(f".//{tag}")
                    h.require(node is not None and node.get("descr") == name, "wrong original owner or description", part)
                    node.set("descr", f"{name} 35")
            h.require(ET.tostring(old) == ET.tostring(new), "unrelated story XML changed", part)
        row["unchangedResources"] = [name for name in before.namelist() if name.startswith("word/media/")]
        h.require(row["unchangedResources"], "missing picture resources")
    h.reopen(acc, path, row)
    for name in layout:
        select_at(name, name if resize else f"{name} 35")
        if resize:
            size_is(35)


def resize_noncanonical_story_picture(acc, row, fixtures, out):
    source_fixture = fixtures / "a-p5-story-original.docx"
    fixture = out / "a-p5-story-noncanonical-source.docx"
    with zipfile.ZipFile(source_fixture) as source, zipfile.ZipFile(fixture, "w") as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "word/header1.xml":
                xml = data.decode("utf-8")
                canonical = '<a:ext cx="355600" cy="279400"/>'
                h.require(xml.count(canonical) == 1, "expected one canonical header shape extent", xml.count(canonical))
                data = xml.replace(canonical, '<a:ext cx="711200" cy="558800"/>').encode("utf-8")
            target.writestr(item, data)

    path = h.begin(acc, row, fixture, out, "a-p5-story-noncanonical-edited.docx")
    layout = json.loads((fixtures / "a-p5-story-layout.json").read_text())
    order = ("header", "body", "endnote", "footnote", "footer")
    point, before_frame, selection = select_story_note(acc, layout, order, "header")
    h.require(selection["objectKind"] == "picture" and selection["moveHandle"],
              "noncanonical resize did not select the owned header picture", selection)
    h.require(before_frame["width"] > 0 and before_frame["height"] > 0,
              "noncanonical source frame has invalid rendered dimensions", before_frame)
    acc.wait("return +document.querySelector(arguments[0])?.value === 28", WIDTH, timeout=10)
    h.p6.gso.replace(acc, WIDTH, "35")
    acc.dom_click(SIZE_FORM + " button[type=submit]")
    h.revision(acc, "docx", 1)
    point, resized_frame, selection = select_story_note(acc, layout, order, "header")
    acc.wait("return +document.querySelector(arguments[0])?.value === 35", WIDTH, timeout=10)
    h.require(abs(resized_frame["width"] / before_frame["width"] - 1.25) <= 0.05
              and abs(resized_frame["height"] / before_frame["height"] - 1.25) <= 0.05,
              "resized noncanonical frame did not scale proportionally", [before_frame, resized_frame])
    acc.key("ctrl+z")
    h.revision(acc, "docx", 2)
    _, undo_frame, _ = select_story_note(acc, layout, order, "header")
    acc.wait("return +document.querySelector(arguments[0])?.value === 28", WIDTH, timeout=10)
    h.require(undo_frame == before_frame, "Undo did not restore noncanonical picture geometry", undo_frame)
    acc.key("ctrl+y")
    h.revision(acc, "docx", 3)
    _, redo_frame, _ = select_story_note(acc, layout, order, "header")
    acc.wait("return +document.querySelector(arguments[0])?.value === 35", WIDTH, timeout=10)
    h.require(redo_frame == resized_frame, "Redo did not restore noncanonical picture geometry", redo_frame)
    row["selection"] = selection
    row["target"] = {"story": "header", "point": point}
    row["geometry"] = {"before": before_frame, "after": resized_frame,
                       "undo": undo_frame, "redo": redo_frame}
    h.publish(acc, "docx", row)

    with zipfile.ZipFile(fixture) as original, zipfile.ZipFile(path) as published:
        h.require(set(original.namelist()) == set(published.namelist()), "noncanonical resize changed OPC inventory")
        for part in original.namelist():
            if part != "word/header1.xml":
                h.require(original.read(part) == published.read(part), "noncanonical resize changed unrelated OPC part", part)
        old, new = [ET.fromstring(package.read("word/header1.xml")) for package in (original, published)]
        frame_path = f".//{WP}inline/{WP}extent"
        shape_path = f".//{PIC}spPr/{A}xfrm/{A}ext"
        old_frame, old_shape = old.find(frame_path), old.find(shape_path)
        new_frame, new_shape = new.find(frame_path), new.find(shape_path)
        h.require(old_frame is not None and old_frame.attrib == {"cx": "355600", "cy": "279400"},
                  "unexpected source frame extent", old_frame.attrib if old_frame is not None else None)
        h.require(old_shape is not None and old_shape.attrib == {"cx": "711200", "cy": "558800"},
                  "unexpected noncanonical source shape extent", old_shape.attrib if old_shape is not None else None)
        h.require(new_frame is not None and new_frame.attrib == {"cx": "444500", "cy": "349250"},
                  "saved frame extent is wrong", new_frame.attrib if new_frame is not None else None)
        h.require(new_shape is not None and new_shape.attrib == {"cx": "889000", "cy": "698500"},
                  "saved shape extent did not retain the source ratio", new_shape.attrib if new_shape is not None else None)
        new_frame.attrib = old_frame.attrib.copy()
        new_shape.attrib = old_shape.attrib.copy()
        h.require(ET.tostring(old) == ET.tostring(new),
                  "saved header XML changed beyond the two owned picture extents")
        row["serializedExtents"] = {"beforeFrame": old_frame.attrib, "beforeShape": old_shape.attrib,
                                    "afterFrame": {"cx": "444500", "cy": "349250"},
                                    "afterShape": {"cx": "889000", "cy": "698500"}}
        row["unchangedRelationshipsAndMedia"] = all(
            original.read(part) == published.read(part) for part in original.namelist()
            if part.endswith(".rels") or part.startswith("word/media/"))
        h.require(row["unchangedRelationshipsAndMedia"], "noncanonical resize changed resources or relationships")

    h.reopen(acc, path, row)
    _, reopened_frame, reopened_selection = select_story_note(acc, layout, order, "header")
    acc.wait("return +document.querySelector(arguments[0])?.value === 35", WIDTH, timeout=10)
    h.require(reopened_selection["objectKind"] == "picture" and reopened_selection["moveHandle"],
              "reopened picture lost its header owner", reopened_selection)
    h.require(all(abs(reopened_frame[key] - resized_frame[key]) <= 1.5
                  for key in ("left", "top", "width", "height")),
              "saved noncanonical picture reopened at a different frame", [resized_frame, reopened_frame])
    row["reopenedFrame"] = reopened_frame


def story_picture_points(acc, page):
    return acc.d.js("""
      const c=document.querySelectorAll('.docx-page canvas')[arguments[0]];
      if(!c?.width) return [];
      const sx=c.width/c.clientWidth, sy=c.height/c.clientHeight, data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const points=[]; let count=0, sumX=0, sumY=0;
      for(let y=0;y<=c.height;y++) { let row=0,rowX=0;
        if(y<c.height) for(let x=0;x<c.width;x++) { const i=(y*c.width+x)*4;
          const opaque=data[i]===140&&data[i+1]===90&&data[i+2]===40;
          const dimmed=Math.abs(data[i]-203)<=2&&Math.abs(data[i+1]-181)<=2&&Math.abs(data[i+2]-158)<=2;
          if(!opaque&&!dimmed) continue; row++; rowX+=x;
        }
        if(row>5){count+=row;sumX+=rowX;sumY+=y*row}
        else if(count>0){if(count>100)points.push([arguments[0],sumX/count/sx,sumY/count/sy]);count=0;sumX=0;sumY=0}
      }
      return points;
    """, page)


def select_story_note(acc, layout, order, name, require_move=True, page_override=None, expected_description=None):
    page = layout[name]["page"] if page_override is None else page_override
    expected_description = name if expected_description is None else expected_description
    acc.wait("""
      const canvas = document.querySelectorAll('.docx-page canvas')[arguments[0]];
      return canvas?.width > 0 && canvas.parentElement.dataset.current === 'true' &&
        canvas.parentElement.dataset.revision === document.querySelector('[data-testid=docx-status]').dataset.revision;
    """, page)
    points = story_picture_points(acc, page)
    h.require(len(points)==len(order), "note fixture picture scan differs", points)
    point=points[order.index(name)]
    x,y=acc.d.js("""
      const [page,x,y]=arguments[0],c=document.querySelectorAll('.docx-page canvas')[page];
      const s=document.querySelector('.editor__scroll'),r=c.getBoundingClientRect(),v=s.getBoundingClientRect(),k=r.width/c.clientWidth;
      s.scrollTop+=r.top+y*k-(v.top+v.height/2);const n=c.getBoundingClientRect();return [n.left+x*k,n.top+y*k];
    """,point)
    h.p4.rhwp_poc.click(acc.d,x,y)
    if require_move:
        try:
            acc.wait("return !!document.querySelector('[data-testid=object-move]')", timeout=5)
        except Exception:
            pass
    selected=acc.d.js("""
      const input=document.querySelector(arguments[0]);
      const section=document.querySelector('[aria-labelledby=properties-selection]');
      const descriptionLabel=[...section.querySelectorAll('dt')]
        .find(node=>['설명','Description'].includes(node.textContent.trim()));
      const frame=document.querySelector('.object-selection-frame');
      const status=document.querySelector('[data-testid=docx-status]');
      const box=frame&&Object.fromEntries(['left','top','width','height'].map(k=>[k,parseFloat(frame.style[k])]));
      const point=arguments[2];
      return {descriptionEditor:input?.value??null,
        descriptionDisplay:descriptionLabel?.nextElementSibling?.textContent.trim()??null,
        objectKind:frame?.dataset.objectKind??null, frame:box,
        clickInsideFrame:!!box&&point[1]>=box.left&&point[1]<=box.left+box.width&&point[2]>=box.top&&point[2]<=box.top+box.height,
        moveHandle:!!document.querySelector('[data-testid=object-move]'),
        revision:status?.dataset.revision??null, point, expected:arguments[1]};
    """,DESCRIPTION,expected_description,point)
    owner_verified=(selected["descriptionEditor"]==expected_description
                    or selected["descriptionDisplay"]==expected_description)
    h.require(selected["objectKind"]=="picture" and (not require_move or selected["moveHandle"])
              and selected["clickInsideFrame"] and owner_verified,
              "native hit test selected the wrong note picture or owner",selected)
    return point, h.frame(acc), selected


def body_picture_target(fixture, layout):
    story_pages={story["page"] for story in layout.values()}
    h.require(len(story_pages)==1,"body picture page is ambiguous in the story fixture",sorted(story_pages))
    with zipfile.ZipFile(fixture) as package:
        document=ET.fromstring(package.read("word/document.xml"))
    body_doc_prs=list(document.iter(WP+"docPr"))
    h.require(len(body_doc_prs)==1 and bool(body_doc_prs[0].get("descr")),
              "source document does not have exactly one described body drawing",body_doc_prs)
    return story_pages.pop(),body_doc_prs[0].get("descr")


def note_move(acc, row, fixtures, out):
    fixture = fixtures / "a-p5-story-original.docx"
    path = h.begin(acc, row, fixture, out, "a-p5-note-move.docx")
    layout = json.loads((fixtures / "a-p5-story-layout.json").read_text())
    order = ("header", "body", "endnote", "footnote", "footer")

    def select_note(name):
        return select_story_note(acc, layout, order, name)

    acc.d.js("""
      window.noteMovePointers=[];
      for(const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
        if(e.target.matches('[data-testid=object-move]')) noteMovePointers.push({type,trusted:e.isTrusted});
      },true);
    """)
    revision_number=0
    row["moves"]={}
    for name in ("footnote", "endnote"):
        select_note(name)
        h.require(acc.d.exists("[data-testid=object-move]"), "owned note has no move handle", name)
        before=h.frame(acc)
        x,y=acc.d.js("""const r=document.querySelector('[data-testid=object-move]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]""")
        sx,sy=acc.d.pointer_scale
        h.p4.rhwp_poc.drag(acc.d,(x*sx,y*sy),((x+16)*sx,(y+10)*sy))
        pointers=acc.d.js("return window.noteMovePointers.slice()")
        h.require([(event["type"],event["trusted"]) for event in pointers[-2:]]==[("pointerdown",True),("pointerup",True)],
                  "note movement did not use trusted native pointer input",pointers)
        revision_number+=1
        h.revision(acc,"docx",revision_number)
        after=h.frame(acc)
        h.require(abs(after["left"]-before["left"])>2 or abs(after["top"]-before["top"])>2,
                  "native drag did not move the selected note picture",[before,after])
        acc.key("ctrl+z"); revision_number+=1; h.revision(acc,"docx",revision_number)
        # Undo restores the text caret and can clear object selection. Reselect the
        # same story-owned picture before inspecting its frame; the native click also
        # proves the restored picture remains hit-testable at its original position.
        select_note(name)
        undo_frame=h.frame(acc)
        h.require(undo_frame==before,"note picture Undo did not restore geometry",undo_frame)
        acc.key("ctrl+y"); revision_number+=1; h.revision(acc,"docx",revision_number)
        select_note(name)
        redo_frame=h.frame(acc)
        h.require(redo_frame==after,"note picture Redo did not restore movement",redo_frame)
        row["moves"][name]={"before":before,"after":after,"undoFrame":undo_frame,"redoFrame":redo_frame,
                             "pointers":pointers[-2:],"revision":revision_number}

    h.publish(acc,"docx",row)
    with zipfile.ZipFile(fixture) as original, zipfile.ZipFile(path) as published:
        h.require(set(original.namelist())==set(published.namelist()),"note movement changed OPC inventory")
        changed={"word/footnotes.xml","word/endnotes.xml"}
        for part in original.namelist():
            if part not in changed:
                h.require(original.read(part)==published.read(part),"note movement changed unrelated OPC part",part)
        row["unchangedRelationshipsAndMedia"] = all(
            original.read(part)==published.read(part) for part in original.namelist()
            if part.endswith(".rels") or part.startswith("word/media/")
        )
        h.require(row["unchangedRelationshipsAndMedia"],"note movement changed relationships or media")
        row["serializedNotes"]={}
        for label,part,tag in (("footnote","word/footnotes.xml","footnote"),("endnote","word/endnotes.xml","endnote")):
            old,new=[ET.fromstring(package.read(part)) for package in (original,published)]
            def inspect(root):
                notes=root.findall(f".//{W}{tag}")
                found=[]
                for note in notes:
                    docpr=next((node for node in note.iter(WP+"docPr") if node.get("descr")==label),None)
                    if docpr is None: continue
                    picture=next((node for node in note.iter(PIC+"cNvPr") if node.get("descr")==label),None)
                    blip=next((node for node in note.iter(A+"blip") if node.get(REL+"embed")),None)
                    run=next((node for node in note.iter(W+"r") if any(child is not None for child in [node.find(W+"drawing")])),None)
                    rpr=run.find(W+"rPr") if run is not None else None
                    positions=[node for node in note.iter(WP+"inline") if docpr in list(node.iter(WP+"docPr"))]
                    anchor=next((node for node in note.iter(WP+"anchor") if docpr in list(node.iter(WP+"docPr"))),None)
                    kind="inline" if positions else "anchor" if anchor is not None else "missing"
                    horizontal=anchor.find(WP+"positionH") if anchor is not None else None
                    vertical=anchor.find(WP+"positionV") if anchor is not None else None
                    text=["".join(t.text or "" for t in para.iter(W+"t")) for para in note.iter(W+"p")]
                    found.append({"noteId":note.get(W+"id"),"docPrId":docpr.get("id"),"description":docpr.get("descr"),
                      "pictureId":picture.get("id") if picture is not None else None,"embed":blip.get(REL+"embed") if blip is not None else None,
                      "runProps":ET.tostring(rpr) if rpr is not None else None,"kind":kind,"text":text,
                      "horizontal":(horizontal.get("relativeFrom"), horizontal.findtext(WP+"posOffset")) if horizontal is not None else None,
                      "vertical":(vertical.get("relativeFrom"), vertical.findtext(WP+"posOffset")) if vertical is not None else None})
                return found
            old_items,new_items=inspect(old),inspect(new)
            h.require(len(old_items)==len(new_items)==1,"note drawing identity is ambiguous",[label,old_items,new_items])
            before_item,after_item=old_items[0],new_items[0]
            h.require(before_item["kind"]=="inline" and after_item["kind"]=="anchor","picture placement was not serialized as a move",[before_item,after_item])
            h.require(after_item["horizontal"][0]=="column" and after_item["vertical"][0]=="paragraph"
                      and after_item["horizontal"][1] is not None and after_item["vertical"][1] is not None,
                      "saved note anchor has unsupported coordinate mapping",after_item)
            for key in ("noteId","docPrId","description","pictureId","embed","runProps","text"):
                h.require(before_item[key]==after_item[key],"note identity, text, media or run formatting changed",[label,key,before_item[key],after_item[key]])
            row["serializedNotes"][label]=after_item

    h.reopen(acc,path,row)
    for name in ("footnote","endnote"):
        select_note(name)
        h.require(acc.d.exists("[data-testid=object-move]"),"reopened note picture lost move capability",name)
        reopened_frame = h.frame(acc)
        expected_frame = row["moves"][name]["after"]
        h.require(all(abs(reopened_frame[key] - expected_frame[key]) <= 1.5
                      for key in ("left", "top", "width", "height")),
                  "saved note picture reopened at a different rendered position", [name, expected_frame, reopened_frame])
        row["moves"][name]["reopenedFrame"] = reopened_frame


def header_footer_move(acc, row, fixtures, out):
    fixture=fixtures/"a-p5-story-original.docx"
    path=h.begin(acc,row,fixture,out,"a-p5-header-footer-move.docx")
    layout=json.loads((fixtures/"a-p5-story-layout.json").read_text())
    order=("header","body","endnote","footnote","footer")

    def select_owned_picture(name):
        point,frame,selection=select_story_note(acc,layout,order,name)
        h.require(acc.d.exists("[data-testid='object-move']"),"header/footer picture has no move handle",name)
        return point,frame,selection

    acc.d.js("""
      window.headerFooterMovePointers=[];
      for(const type of ['pointerdown','pointerup']) addEventListener(type,e=>{
        if(e.target.matches('[data-testid=object-move]')) headerFooterMovePointers.push({type,trusted:e.isTrusted});
      },true);
    """)
    revision_number=0
    row["moves"]={}
    for name in ("header","footer"):
        _,before,_=select_owned_picture(name)
        x,y=acc.d.js("""const r=document.querySelector('[data-testid=object-move]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]""")
        sx,sy=acc.d.pointer_scale
        h.p4.rhwp_poc.drag(acc.d,(x*sx,y*sy),((x+16)*sx,(y+10)*sy))
        pointers=acc.d.js("return window.headerFooterMovePointers.slice()")
        h.require([(event["type"],event["trusted"]) for event in pointers[-2:]]==[("pointerdown",True),("pointerup",True)],
                  "header/footer movement did not use trusted native pointer input",pointers)
        revision_number+=1
        h.revision(acc,"docx",revision_number)
        _,after,_=select_owned_picture(name)
        h.require(abs(after["left"]-before["left"])>2 or abs(after["top"]-before["top"])>2,
                  "native drag did not move the selected header/footer picture",[before,after])
        acc.key("ctrl+z"); revision_number+=1; h.revision(acc,"docx",revision_number)
        _,undo_frame,_=select_owned_picture(name)
        h.require(undo_frame==before,"header/footer picture Undo did not restore geometry",undo_frame)
        acc.key("ctrl+y"); revision_number+=1; h.revision(acc,"docx",revision_number)
        _,redo_frame,_=select_owned_picture(name)
        h.require(redo_frame==after,"header/footer picture Redo did not restore movement",redo_frame)
        row["moves"][name]={"before":before,"after":after,"undoFrame":undo_frame,"redoFrame":redo_frame,
                            "pointers":pointers[-2:],"revision":revision_number}

    h.publish(acc,"docx",row)
    with zipfile.ZipFile(fixture) as original, zipfile.ZipFile(path) as published:
        h.require(set(original.namelist())==set(published.namelist()),"header/footer movement changed OPC inventory")
        changed={"word/header1.xml","word/footer1.xml"}
        for part in original.namelist():
            if part not in changed:
                h.require(original.read(part)==published.read(part),"header/footer movement changed unrelated OPC part",part)
        row["unchangedRelationshipsAndMedia"] = all(
            original.read(part)==published.read(part) for part in original.namelist()
            if part.endswith(".rels") or part.startswith("word/media/")
        )
        h.require(row["unchangedRelationshipsAndMedia"],"header/footer movement changed relationships or media")
        row["serializedPictures"]={}
        for label,part in (("header","word/header1.xml"),("footer","word/footer1.xml")):
            old,new=[ET.fromstring(package.read(part)) for package in (original,published)]
            def inspect(root):
                docpr=next((node for node in root.iter(WP+"docPr") if node.get("descr")==label),None)
                picture=next((node for node in root.iter(PIC+"cNvPr") if node.get("descr")==label),None)
                blip=next((node for node in root.iter(A+"blip") if node.get(REL+"embed")),None)
                run=next((node for node in root.iter(W+"r") if node.find(W+"drawing") is not None
                          and docpr in list(node.find(W+"drawing").iter(WP+"docPr"))),None)
                rpr=run.find(W+"rPr") if run is not None else None
                inline=next((node for node in root.iter(WP+"inline")
                            if docpr in list(node.iter(WP+"docPr"))),None)
                anchor=next((node for node in root.iter(WP+"anchor")
                            if docpr in list(node.iter(WP+"docPr"))),None)
                mode="inline" if inline is not None else "anchor" if anchor is not None else "missing"
                horizontal=anchor.find(WP+"positionH") if anchor is not None else None
                vertical=anchor.find(WP+"positionV") if anchor is not None else None
                text=["".join(item.text or "" for item in para.iter(W+"t")) for para in root.iter(W+"p")]
                return {"docPrId":docpr.get("id") if docpr is not None else None,
                  "description":docpr.get("descr") if docpr is not None else None,
                  "pictureId":picture.get("id") if picture is not None else None,
                  "embed":blip.get(REL+"embed") if blip is not None else None,
                  "runProps":ET.tostring(rpr) if rpr is not None else None,"kind":mode,"text":text,
                  "horizontal":(horizontal.get("relativeFrom"),horizontal.findtext(WP+"posOffset")) if horizontal is not None else None,
                  "vertical":(vertical.get("relativeFrom"),vertical.findtext(WP+"posOffset")) if vertical is not None else None}
            def without_target_placement(root):
                root=ET.fromstring(ET.tostring(root))
                drawing=next((node for node in root.iter(W+"drawing")
                              if any(item.get("descr")==label for item in node.iter(WP+"docPr"))),None)
                h.require(drawing is not None and len(drawing)==1,
                          "expected one directly owned picture placement",[label,part])
                wrapper=drawing[0]
                h.require(wrapper.tag in (WP+"inline",WP+"anchor"),"unsupported placement wrapper",wrapper.tag)
                drawing.remove(wrapper)
                drawing.append(ET.Element(WP+"placement"))
                return ET.canonicalize(ET.tostring(root,encoding="unicode"))
            before_item,after_item=inspect(old),inspect(new)
            h.require(before_item["kind"]=="inline" and after_item["kind"]=="anchor",
                      "header/footer move did not serialize the supported placement transition",[label,before_item,after_item])
            h.require(after_item["horizontal"][0]=="column" and after_item["vertical"][0]=="paragraph"
                      and after_item["horizontal"][1] is not None and after_item["vertical"][1] is not None,
                      "saved header/footer anchor has unsupported coordinate ownership",after_item)
            for key in ("docPrId","description","pictureId","embed","runProps","text"):
                h.require(before_item[key]==after_item[key],"header/footer drawing identity, text, media or run formatting changed",
                          [label,key,before_item[key],after_item[key]])
            h.require(without_target_placement(old)==without_target_placement(new),
                      "unrelated XML in the owning header/footer part changed",part)
            row["serializedPictures"][label]=after_item

    h.reopen(acc,path,row)
    for name in ("header","footer"):
        _,frame,_=select_owned_picture(name)
        expected=row["moves"][name]["after"]
        h.require(all(abs(frame[key]-expected[key])<=1.5 for key in ("left","top","width","height")),
                  "saved header/footer picture reopened at a different rendered position",[name,expected,frame])
        row["moves"][name]["reopenedFrame"]=frame


def note_move_fresh_reopen(acc, row, fixtures, out):
    fixture=fixtures/"a-p5-story-original.docx"
    expected=json.loads((fixtures/"a-p5-note-move-expected.json").read_text())
    path=h.begin(acc,row,fixture,out,"a-p5-note-move-fresh-probe.docx")
    row["expectedSavedSha256"]=expected["publishedSha256"]
    row["savedSha256"]=h.digest(path)
    h.require(row["savedSha256"]==expected["publishedSha256"],"fresh-session input differs from accepted saved package",row)
    h.require(row["processAppSha256"]==expected["appSha256"],"fresh session used a different application binary",row)
    h.require(row["appPid"]!=expected["appPid"],"fresh-session verification reused the original app process",row)
    h.require(row["initialSession"]["dirty"]=="false" and row["initialSession"]["unpreserved"]=="false",
              "saved package was dirty or unpreserved on independent open",row["initialSession"])
    layout=json.loads((fixtures/"a-p5-story-layout.json").read_text())
    order=("header","body","endnote","footnote","footer")
    row["moves"]={}
    for name in ("footnote","endnote"):
        point,frame,selection=select_story_note(acc,layout,order,name)
        wanted=expected["moves"][name]["after"]
        h.require(all(abs(frame[key]-wanted[key])<=1.5 for key in ("left","top","width","height")),
                  "independent app rendered a moved note picture at a different position",[name,wanted,frame])
        row["moves"][name]={"expected":wanted,"frame":frame,"selection":selection,"hitPoint":point}
    row["readOnlyOpen"]=True


def header_footer_move_fresh_reopen(acc,row,fixtures,out):
    expected=json.loads((fixtures/"a-p5-hf-move-expected.json").read_text())
    fixture=fixtures/"a-p5-hf-move-saved.docx"
    path=h.begin(acc,row,fixture,out,"a-p5-hf-move-fresh-probe.docx")
    row["expectedSavedSha256"]=expected["publishedSha256"]
    row["savedSha256"]=h.digest(path)
    h.require(row["savedSha256"]==expected["publishedSha256"],"fresh-session input differs from accepted saved package",row)
    h.require(row["processAppSha256"]==expected["appSha256"],"fresh session used a different application binary",row)
    h.require(row["appPid"]!=expected["appPid"],"fresh-session verification reused the original app process",row)
    h.require(row["initialSession"]["dirty"]=="false" and row["initialSession"]["unpreserved"]=="false",
              "saved package was dirty or unpreserved on independent open",row["initialSession"])
    layout=json.loads((fixtures/"a-p5-story-layout.json").read_text())
    order=("header","body","endnote","footnote","footer")
    row["moves"]={}
    for name in ("header","footer"):
        point,frame,selection=select_story_note(acc,layout,order,name)
        wanted=expected["moves"][name]["after"]
        h.require(all(abs(frame[key]-wanted[key])<=1.5 for key in ("left","top","width","height")),
                  "independent app rendered moved header/footer picture at a different position",[name,wanted,frame])
        row["moves"][name]={"expected":wanted,"frame":frame,"selection":selection,"hitPoint":point}
    row["readOnlyOpen"]=True


def delete_docx_story_pictures(acc, row, fixtures, out):
    fixture=fixtures/"a-p5-story-original.docx"
    path=h.begin(acc,row,fixture,out,"a-p5-story-delete.docx")
    layout=json.loads((fixtures/"a-p5-story-layout.json").read_text())
    order=("header","body","endnote","footnote","footer")
    deletion_order=("header","endnote","footnote","footer")
    delete_selector="[aria-labelledby=properties-selection] .object-tools > button:last-child"
    delete_expr="Array.from(document.querySelectorAll(arguments[0])).find(b=>['Delete object','개체 삭제'].includes(b.textContent.trim()))"
    acc.d.js("""
      window.storyDeletePointers=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
        const button=e.target.closest('[aria-labelledby=properties-selection] .object-tools > button:last-child');
        if(button) storyDeletePointers.push({type,trusted:e.isTrusted,text:button.textContent.trim()});
      },true);
    """)
    revision_number=0
    removed=[]
    row["deletions"]={}
    for name in deletion_order:
        before_order=tuple(item for item in order if item not in removed)
        _,before_frame,selection=select_story_note(acc,layout,before_order,name)
        h.require(acc.d.exists(delete_selector),"owned story picture has no delete action",name)
        button=acc.d.js("return document.querySelector(arguments[0])?.textContent.trim()",delete_selector)
        h.require(button in ("Delete object","개체 삭제"),"unexpected owned-story delete action",button)
        acc.dom_click(delete_selector,delete_expr)
        pointers=acc.d.js("return window.storyDeletePointers.slice()")
        events=pointers[-2:]
        h.require([(event["type"],event["trusted"]) for event in events]==[("pointerdown",True),("pointerup",True)],
                  "story deletion did not use trusted native pointer input",events)
        revision_number+=1
        h.revision(acc,"docx",revision_number)
        after_order=tuple(item for item in before_order if item!=name)
        page=layout[name]["page"]
        acc.wait("""
          const c=document.querySelectorAll('.docx-page canvas')[arguments[0]];
          const s=document.querySelector('[data-testid=docx-status]');
          return c?.width>0 && c.parentElement.dataset.revision===s?.dataset.revision;
        """,page)
        points=story_picture_points(acc,page)
        h.require(len(points)==len(after_order),"deleted picture remains in the rendered stories",[name,points,after_order])
        acc.wait("return !document.querySelector('.object-selection-frame')")
        acc.key("ctrl+z")
        revision_number+=1
        h.revision(acc,"docx",revision_number)
        _,undo_frame,undo_selection=select_story_note(acc,layout,before_order,name)
        h.require(undo_frame==before_frame,"story picture Undo did not restore its selection and geometry",undo_frame)
        h.require(undo_selection["objectKind"]=="picture","Undo restored a different object owner",undo_selection)
        acc.key("ctrl+y")
        revision_number+=1
        h.revision(acc,"docx",revision_number)
        acc.wait("return !document.querySelector('.object-selection-frame')")
        points=story_picture_points(acc,page)
        h.require(len(points)==len(after_order),"story picture Redo did not restore the deletion",[name,points,after_order])
        row["deletions"][name]={"beforeFrame":before_frame,"undoFrame":undo_frame,
                                "selectedOwner":selection,"trustedPointerEvents":events,"revision":revision_number}
        removed.append(name)

    remaining_order=tuple(item for item in order if item not in removed)
    h.require(remaining_order==("body",),"story deletion removed an unrelated drawing",remaining_order)
    # The body picture has no linked-story layout entry; derive its shared page from the fixture stories.
    body_page,body_description=body_picture_target(fixture,layout)
    _,body_frame,body_selection=select_story_note(acc,layout,remaining_order,"body",require_move=False,
                                                   page_override=body_page,
                                                   expected_description=body_description)
    h.require(not body_selection["moveHandle"],"body picture unexpectedly gained a non-body move handle")
    row["remainingBodyPicture"]={"frame":body_frame,"selection":body_selection}
    h.publish(acc,"docx",row)

    changed_story_parts={"word/header1.xml","word/footer1.xml","word/footnotes.xml","word/endnotes.xml"}
    expected_removed_rels={"word/_rels/header1.xml.rels","word/_rels/footer1.xml.rels",
                           "word/_rels/footnotes.xml.rels","word/_rels/endnotes.xml.rels"}
    with zipfile.ZipFile(fixture) as original,zipfile.ZipFile(path) as published:
        before_names=set(original.namelist()); after_names=set(published.namelist())
        h.require(after_names==before_names-expected_removed_rels,
                  "saved story deletion changed an unexpected OPC part inventory",
                  {"added":sorted(after_names-before_names),"missing":sorted(before_names-after_names)})
        for rel_part in expected_removed_rels:
            rel_root=ET.fromstring(original.read(rel_part))
            relations=list(rel_root)
            h.require(len(relations)==1 and relations[0].get("Type","").endswith("/image"),
                      "removed story relationship part was not exclusively owned by its picture",rel_part)
        for part in original.namelist():
            if part in changed_story_parts or part in expected_removed_rels or part=="docProps/app.xml":
                continue
            h.require(original.read(part)==published.read(part),"story deletion changed unrelated OPC bytes",part)
        h.require(original.read("word/document.xml")==published.read("word/document.xml"),
                  "body or note-reference OPC part changed")
        row["unchangedMedia"]={name:hashlib.sha256(original.read(name)).hexdigest() for name in original.namelist()
                                if name.startswith("word/media/")}
        h.require(row["unchangedMedia"] and all(original.read(name)==published.read(name)
                  for name in row["unchangedMedia"]),"shared picture media changed or disappeared")
        row["removedRelationshipParts"]=sorted(expected_removed_rels)
        row["changedStoryParts"]=sorted(changed_story_parts)
        row["preservedNotes"]={}
        for label,part,note_tag in (("header","word/header1.xml",None),
                                    ("footer","word/footer1.xml",None),
                                    ("footnote","word/footnotes.xml","footnote"),
                                    ("endnote","word/endnotes.xml","endnote")):
            old,new=[ET.fromstring(package.read(part)) for package in (original,published)]
            old_pictures=[node for node in old.iter(WP+"docPr") if node.get("descr")==label]
            new_pictures=[node for node in new.iter(WP+"docPr") if node.get("descr")==label]
            h.require(len(old_pictures)==1 and not new_pictures,"deleted drawing identity is still present or ambiguous",
                      [label,len(old_pictures),len(new_pictures)])
            def paragraphs(root):
                return ["".join(node.text or "" for node in para.iter(W+"t")) for para in root.iter(W+"p")]
            old_text=paragraphs(old); new_text=paragraphs(new)
            h.require(old_text==new_text,"story paragraph text changed during picture deletion",[label,old_text,new_text])
            if note_tag:
                def notes(root):
                    return [(note.get(W+"id"),paragraphs(note)) for note in root.iter(W+note_tag)]
                old_notes,new_notes=notes(old),notes(new)
                h.require(old_notes==new_notes,"note IDs, internal text, or numbering changed",[label,old_notes,new_notes])
                row["preservedNotes"][label]=old_notes
            for parent in old.iter():
                for child in list(parent):
                    if child.tag==W+"r" and any(node.get("descr")==label for node in child.iter(WP+"docPr")):
                        parent.remove(child)
            h.require(ET.tostring(old)==ET.tostring(new),"saved story contains changes beyond the deleted picture run",part)
        row["publishedSha256"]=h.digest(path)
    h.reopen(acc,path,row)
    _,reopened_frame,reopened_selection=select_story_note(acc,layout,("body",),"body",require_move=False,
                                                           page_override=body_page,
                                                           expected_description=body_description)
    h.require(all(abs(reopened_frame[key]-body_frame[key])<=1.5 for key in ("left","top","width","height")),
              "body picture moved after deleting other stories",[body_frame,reopened_frame])
    row["sameSessionReopen"]={"bodyFrame":reopened_frame,"selection":reopened_selection,
                               "session":row["reopenedSession"]}


def delete_docx_story_pictures_fresh_reopen(acc,row,fixtures,out):
    expected=json.loads((fixtures/"a-p5-delete-expected.json").read_text())
    fixture=fixtures/"a-p5-delete-saved.docx"
    path=h.begin(acc,row,fixture,out,"a-p5-delete-fresh-probe.docx")
    row["expectedSavedSha256"]=expected["publishedSha256"]
    row["savedSha256"]=h.digest(path)
    h.require(row["savedSha256"]==expected["publishedSha256"],"fresh-session DOCX differs from accepted save",row)
    h.require(row["processAppSha256"]==expected["appSha256"],"fresh session used a different application binary",row)
    h.require(row["appPid"]!=expected["appPid"],"fresh-session verification reused the deleting app process",row)
    h.require(row["initialSession"]["dirty"]=="false" and row["initialSession"]["unpreserved"]=="false",
              "saved DOCX was dirty or unpreserved when reopened independently",row["initialSession"])
    layout=json.loads((fixtures/"a-p5-story-layout.json").read_text())
    body_page,body_description=body_picture_target(fixtures/"a-p5-story-original.docx",layout)
    points=story_picture_points(acc,body_page)
    h.require(len(points)==1,"fresh app did not render exactly the retained body picture",points)
    _,frame,selection=select_story_note(acc,layout,("body",),"body",require_move=False,
                                         page_override=body_page,
                                         expected_description=body_description)
    h.require(not selection["moveHandle"],"freshly reopened body picture has a foreign-story move handle")
    row["remainingBodyPicture"]={"frame":frame,"selection":selection}
    row["readOnlyFreshProcessOpen"]=True


def inspect_box(path):
    return h.inspect_rhwp(path, """
      const owner=controls.find(c=>c.list===0 && c.ctrlId==='gso');
      const address=[0,owner.para,owner.controlIndex,0];
      const shape=JSON.parse(doc.getShapeProperties(...address.slice(0,3)));
      const paragraphs=Array.from({length:doc.getCellParagraphCount(...address)},(_,p)=>{
        const n=doc.getCellParagraphLength(...address,p);
        return {text:doc.getTextInCell(...address,p,0,n), props:JSON.parse(doc.getCellParaPropertiesAt(...address,p)),
          runs:JSON.parse(doc.getFormattingRuns(...address,p,0,n)).runs};
      });
      const caret=JSON.parse(doc.getCursorRectInCell(...address,1,5));
      console.log(JSON.stringify({shape,body,paragraphs,caret}));
    """)


def canvas_hashes(acc):
    deadline = time.monotonic() + 8
    previous = None
    stable_samples = 0
    while time.monotonic() < deadline:
        images = acc.d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
        h.require(images, "rendered page canvas is unavailable")
        current = [hashlib.sha256(image.encode()).hexdigest() for image in images]
        if current == previous:
            stable_samples += 1
            if stable_samples >= 2:
                return current
        else:
            stable_samples = 0
        previous = current
        time.sleep(0.1)
    h.require(False, "rendered page canvases did not stabilize", previous)


def textbox(acc, row, fixtures, out):
    fixture = fixtures / "a-p5-textbox-original.hwpx"
    before = row["before"] = inspect_box(fixture)
    path = h.begin(acc, row, fixture, out, "a-p5-textbox-edited.hwpx")
    point = before["caret"]
    box = h.core_shapes(fixture)["frames"][0]
    h.select_object(acc, box, "textBox")
    h.require(acc.d.exists(h.FRAME), "textbox selection did not resolve to the object")
    acc.key("Escape")
    h.p6.pointer(acc, (point["pageIndex"], point["x"] + 0.1, point["y"] + point["height"] / 2))
    if acc.d.exists(h.FRAME):
        # The first click selected the outer object. A trusted double click
        # then enters the same owned paragraph.
        x, y = acc.d.js("""
          const at=arguments[0], c=document.querySelectorAll('.rhwp-page__canvas')[at.pageIndex];
          const r=c.getBoundingClientRect(), k=r.width/c.clientWidth;
          return [r.left+(at.x+.1)*k,r.top+(at.y+at.height/2)*k];
        """, point)
        sx, sy = acc.d.pointer_scale
        h.p4.rhwp_poc.perform(acc.d, [{"type":"pointer","id":"box-edit","parameters":{"pointerType":"mouse"},
            "actions":[{"type":"pointerMove","x":round(x*sx),"y":round(y*sy),"origin":"viewport"},
                       {"type":"pointerDown","button":0},{"type":"pointerUp","button":0},
                       {"type":"pause","duration":40},{"type":"pointerDown","button":0},{"type":"pointerUp","button":0}]}])
    h.require(":5@textbox/" in acc.status("hwpx")["caret"]
              and acc.status("hwpx")["caret"].endswith("/0/1"), "split caret owner is wrong", acc.status("hwpx"))
    acc.key("Return")
    h.revision(acc, "hwpx", 1)
    acc.text_is("hwpx", "plain")
    h.require(acc.status("hwpx")["caret"].endswith("/0/2"), "split caret left its textbox")
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 2)
    acc.text_is("hwpx", "Bold plain")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 3)
    acc.text_is("hwpx", "plain")
    h.publish(acc, "hwpx", row)

    after = row["after"] = inspect_box(path)
    old = before["paragraphs"]
    expected = [old[0], {**old[1],"text":"Bold ","runs":[[0,4,1],[4,5,0]]},
                {**old[1],"text":"plain","runs":[[0,5,2]]}, old[2]]
    h.require(after["paragraphs"] == expected and after["shape"] == before["shape"] and after["body"] == before["body"],
              "mixed character runs, textbox geometry or nearby content changed", after)
    with zipfile.ZipFile(fixture) as original, zipfile.ZipFile(path) as published:
        section = "Contents/section0.xml"
        unrelated = lambda package: {part: package.read(part) for part in package.namelist()
                                      if part != section and not part.startswith("Preview/")}
        h.require(unrelated(original) == unrelated(published), "unrelated HWPX parts changed")
        roots = [ET.fromstring(package.read(section)) for package in (original,published)]
        subs = [root.find(".//{*}drawText/{*}subList") for root in roots]
        h.require(all(sub is not None for sub in subs), "textbox did not retain drawText ownership")
        # The edited paragraph(s) and generated text layout can differ.
        for sub, count in zip(subs, (1,2), strict=True):
            paras = sub.findall("{*}p")
            for para in paras[1:1+count]:
                sub.remove(para)
            for para in sub.findall("{*}p"):
                for derived in para.findall("{*}linesegarray"):
                    para.remove(derived)
        h.require(ET.tostring(roots[0]) == ET.tostring(roots[1]), "unrelated section XML changed")
    h.reopen(acc, path, row)
    h.require(h.core_shapes(path)["frames"][0]["props"] == after["shape"], "published textbox did not reopen")


def textbox_join(acc, row, fixtures, out, span=2, replace=False, mixed=False):
    name = "a-p5-textbox-mix" if mixed else "a-p5-textbox-paste" if replace else "a-p5-textbox-join" if span == 2 else "a-p5-textbox-range"
    fixture = fixtures / f"{name}-original.hwpx"
    before = row["before"] = inspect_box(fixture)
    path = h.begin(acc, row, fixture, out, f"{name}-published.hwpx")
    positions = h.inspect_rhwp(fixture, """
      const owner=controls.find(c=>c.list===0 && c.ctrlId==='gso');
      const addr=[0,owner.para,owner.controlIndex,0];
      console.log(JSON.stringify([[2,0],[1,2]].map(([p,o])=>JSON.parse(doc.getCursorRectInCell(...addr,p,o)))));
    """)

    def place(at):
        h.p6.pointer(acc, (at["pageIndex"], at["x"]+.1, at["y"]+at["height"]/2))
        if acc.d.exists(h.FRAME):
            x, y = acc.d.js("""
              const at=arguments[0], c=document.querySelectorAll('.rhwp-page__canvas')[at.pageIndex];
              const r=c.getBoundingClientRect(), k=r.width/c.clientWidth;
              return [r.left+(at.x+.1)*k,r.top+(at.y+at.height/2)*k];
            """, at)
            sx, sy = acc.d.pointer_scale
            h.p4.rhwp_poc.perform(acc.d, [{"type":"pointer","id":"join-box","parameters":{"pointerType":"mouse"},
                "actions":[{"type":"pointerMove","x":round(x*sx),"y":round(y*sy),"origin":"viewport"},
                           {"type":"pointerDown","button":0},{"type":"pointerUp","button":0},
                           {"type":"pause","duration":40},{"type":"pointerDown","button":0},{"type":"pointerUp","button":0}]}])

    revision = 0
    if span == 2:
        place(positions[0])
        h.require(acc.status("hwpx")["caret"].endswith("/0/2") and ":0@textbox/" in acc.status("hwpx")["caret"],
                  "did not own the right textbox paragraph boundary", acc.status("hwpx"))
        acc.key("BackSpace")
        h.revision(acc, "hwpx", 1)
        acc.text_is("hwpx", "Bold plain")
        acc.key("ctrl+z")
        h.revision(acc, "hwpx", 2)
        revision = 2
    place(positions[1])
    for _ in range(6 + sum(1 + len(p["text"]) for p in before["paragraphs"][2:span])):
        acc.key("shift+Right")
    h.require(acc.status("hwpx")["selection"] and acc.status("hwpx")["caret"].endswith(f"/0/{span}")
              and ":2@textbox/" in acc.status("hwpx")["caret"], "did not make a cross-paragraph selection", acc.status("hwpx"))
    edited_text = "nextain" if replace else "Boain"
    source_canvas = canvas_hashes(acc) if replace else None
    if replace:
        acc.d.js("""
          window.pasteKeys=[];
          addEventListener('keydown', e => {
            if (e.ctrlKey && e.key.toLowerCase() === 'v') pasteKeys.push(e.isTrusted);
          }, true);
        """)

        def paste():
            acc.key("ctrl+v")
            h.revision(acc, "hwpx", revision + 1)

        h.clipboard_peer(acc, "UTF8_STRING", "새\nnext", paste)
        row["trustedPaste"] = acc.d.js("return window.pasteKeys")
        h.require(row["trustedPaste"] == [True], "missing trusted paste key", row["trustedPaste"])
        pasted_canvas = canvas_hashes(acc)
        h.require(pasted_canvas != source_canvas, "trusted paste did not change rendered textbox pixels")
    else:
        acc.key("Delete")
        h.revision(acc, "hwpx", revision + 1)
        acc.text_is("hwpx", edited_text)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", revision + 2)
    if replace:
        undo_canvas = canvas_hashes(acc)
        h.require(undo_canvas == source_canvas, "paste Undo did not restore the source rendering", undo_canvas)
    else:
        acc.text_is("hwpx", "plain")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", revision + 3)
    if replace:
        redo_canvas = canvas_hashes(acc)
        h.require(redo_canvas == pasted_canvas, "paste Redo did not restore the edited rendering", redo_canvas)
        row["pasteUndoRedoCanvases"] = {"source": source_canvas, "pasted": pasted_canvas,
                                        "undo": undo_canvas, "redo": redo_canvas}
    else:
        acc.text_is("hwpx", edited_text)
    h.publish(acc, "hwpx", row)

    after = row["after"] = inspect_box(path)
    old = before["paragraphs"]
    if replace:
        expected = [old[0],
                    {**old[1], "text": "Bo새", "runs": [[0, 3, old[1]["runs"][0][2]]]},
                    {**old[1], "text": "nextain", "runs": [[0, 7, old[3]["runs"][0][2]]]},
                    old[span + 1]]
    else:
        expected = [old[0], {**old[1], "text":"Boain", "runs":[[0,2,1],[2,5,2]]}, old[span + 1]]
    h.require(after["paragraphs"] == expected and after["shape"] == before["shape"] and after["body"] == before["body"],
              "text, retained formatting or owner differs", after)
    with zipfile.ZipFile(fixture) as original, zipfile.ZipFile(path) as published:
        section = "Contents/section0.xml"
        unrelated = lambda package: {part: package.read(part) for part in package.namelist()
                                      if part != section and not part.startswith("Preview/")}
        h.require(unrelated(original) == unrelated(published), "unrelated HWPX parts changed")
        roots = [ET.fromstring(package.read(section)) for package in (original,published)]
        if mixed:
            subs = [root.find(".//{*}drawText/{*}subList") for root in roots]
            h.require(all(sub is not None for sub in subs), "mixed-style textbox XML owner missing")
            paragraphs = [sub.findall("{*}p") for sub in subs]
            source_paragraphs, saved_paragraphs = paragraphs
            h.require(len(source_paragraphs) == 5 and len(saved_paragraphs) == 3,
                      "mixed-style textbox paragraph count differs", [len(source_paragraphs), len(saved_paragraphs)])
            h.require(source_paragraphs[1].get("paraPrIDRef") != source_paragraphs[2].get("paraPrIDRef"),
                      "fixture does not contain different source paragraph formats")
            owner_attrs = ("id", "paraPrIDRef", "styleIDRef")
            h.require(all(saved_paragraphs[1].get(name) == source_paragraphs[1].get(name) for name in owner_attrs),
                      "joined paragraph did not retain the starting paragraph owner and style",
                      [source_paragraphs[1].attrib, saved_paragraphs[1].attrib])

            def formatted_text(para):
                result = []
                for run in para.findall("{*}run"):
                    text = "".join(node.text or "" for node in run.findall(".//{*}t"))
                    if text:
                        result.append((run.get("charPrIDRef"), text))
                return result

            retained_runs = formatted_text(saved_paragraphs[1])
            expected_runs = [(source_paragraphs[1].find("{*}run").get("charPrIDRef"), "Bo"),
                             (source_paragraphs[3].find("{*}run").get("charPrIDRef"), "ain")]
            h.require(retained_runs == expected_runs,
                      "saved prefix/suffix no longer use their source character styles", retained_runs)
            h.require([saved_paragraphs[0].get("id"), saved_paragraphs[2].get("id")]
                      == [source_paragraphs[0].get("id"), source_paragraphs[4].get("id")],
                      "unselected boundary paragraph identities changed")
            row["paragraphStyleInheritance"] = {
                "sourceParaPrIDRefs": [source_paragraphs[1].get("paraPrIDRef"), source_paragraphs[2].get("paraPrIDRef")],
                "savedOwner": {name: saved_paragraphs[1].get(name) for name in owner_attrs},
                "savedText": "".join(node.text or "" for node in saved_paragraphs[1].iter() if node.tag.endswith("}t")),
                "retainedRuns": [{"charPrIDRef": char_id, "text": text} for char_id, text in retained_runs],
                "unselectedParagraphIds": [saved_paragraphs[0].get("id"), saved_paragraphs[2].get("id")],
            }
        for root,count in zip(roots,(span,2 if replace else 1),strict=True):
            sub = root.find(".//{*}drawText/{*}subList")
            for para in sub.findall("{*}p")[1:1+count]:
                sub.remove(para)
            for para in sub.findall("{*}p"):
                for layout in para.findall("{*}linesegarray"):
                    para.remove(layout)
        h.require(ET.tostring(roots[0]) == ET.tostring(roots[1]), "unrelated section XML changed")
    h.reopen(acc, path, row)
    if replace:
        reopened = inspect_box(path)
        h.require(reopened["paragraphs"] == expected and reopened["shape"] == before["shape"]
                  and reopened["body"] == before["body"],
                  "native reopened paste differs from the independent HWPX model", reopened)
        inserted = h.inspect_rhwp(path, """
          const owner=controls.find(c=>c.list===0 && c.ctrlId==='gso');
          console.log(JSON.stringify(JSON.parse(doc.getCursorRectInCell(0,owner.para,owner.controlIndex,0,2,4))));
        """)
        place(inserted)
    else:
        place(positions[1])
        acc.text_is("hwpx", edited_text)
        row["nativeReopenedParagraphText"] = acc.status("hwpx").get("paragraphText")
        h.require(row["nativeReopenedParagraphText"] == edited_text,
                  "native reopened textbox paragraph differs from the published text",
                  row["nativeReopenedParagraphText"])


def hwp5_textbox_paste_disk_proof(source, output, expected):
    before_streams, after_streams = (
        h5.gso.cfb_streams(Path(path).read_bytes()) for path in (source, output)
    )
    h.require(before_streams.keys() == after_streams.keys(), "HWP CFB stream set changed")
    changed = sorted(name for name in before_streams if before_streams[name] != after_streams[name])
    h.require(set(changed) <= {"BodyText/Section0", "PrvImage"}, "unrelated HWP stream changed", changed)
    before_rows = h5.records(h5.unpacked(before_streams, "BodyText/Section0"))
    after_rows = h5.records(h5.unpacked(after_streams, "BodyText/Section0"))
    before_start, before_end, before_obj = h5.textbox_object(before_rows)
    after_start, after_end, after_obj = h5.textbox_object(after_rows)
    h.require(before_rows[:before_start] == after_rows[:after_start], "preceding body records changed")
    h.require(before_rows[before_end:] == after_rows[after_end:], "following body records changed")
    h.require(before_obj[0] == after_obj[0] and before_obj[1] == after_obj[1],
              "textbox owner, drawing identity or geometry changed")
    h.require(before_obj[-1] == after_obj[-1], "textbox shape leaf changed")
    old_list, new_list = h5.list_header(before_obj), h5.list_header(after_obj)
    h.require(old_list[4:] == new_list[4:], "textbox LIST_HEADER metadata changed")
    old_paras, new_paras = h5.textbox_paragraphs(before_obj), h5.textbox_paragraphs(after_obj)
    h.require([h5.paragraph_text(para) for para in new_paras] == expected,
              "saved HWP5 textbox paragraphs differ", [h5.paragraph_text(para) for para in new_paras])
    old_header = old_paras[0][0][2]
    new_ids = [int.from_bytes(para[0][2][18:22], "little") for para in new_paras]
    old_ids = {int.from_bytes(data[18:22], "little") for tag, _, data in before_rows
               if tag == 66 and len(data) >= 22}
    h.require(new_ids[0] == int.from_bytes(old_header[18:22], "little"),
              "paste did not preserve the first paragraph identity", new_ids)
    h.require(len(set(new_ids)) == len(new_ids)
              and all(value != 0 and value not in old_ids for value in new_ids[1:]),
              "paste reused or duplicated a paragraph identity", new_ids)
    h.require(all(para[0][2][8:11] == old_header[8:11]
                  and para[0][2][22:] == old_header[22:] for para in new_paras),
              "paste changed paragraph style references or raw header tail")

    source_text = "".join(h5.paragraph_text(para) for para in old_paras)
    output_text = "".join(h5.paragraph_text(para) for para in new_paras)
    source_pairs, output_pairs = [], []
    for para in old_paras:
        text = h5.paragraph_text(para)
        runs = h5.paragraph_char_shapes(para)
        source_pairs.extend((char, h5.char_shape_at(runs, offset)) for offset, char in enumerate(text))
    for para in new_paras:
        text = h5.paragraph_text(para)
        runs = h5.paragraph_char_shapes(para)
        output_pairs.extend((char, h5.char_shape_at(runs, offset)) for offset, char in enumerate(text))
    cursor = 0
    preserved_offsets = []
    for pair in source_pairs:
        found = next((index for index in range(cursor, len(output_pairs)) if output_pairs[index] == pair), None)
        h.require(found is not None, "paste removed or reformatted original text", pair)
        preserved_offsets.append(found)
        cursor = found + 1
    source_styles = {style for _, style in source_pairs}
    h.require(all(style in source_styles for index, (_, style) in enumerate(output_pairs)
                  if index not in preserved_offsets), "pasted text used a foreign character style")
    h.require(int.from_bytes(old_list[:4], "little") == len(old_paras)
              and int.from_bytes(new_list[:4], "little") == len(new_paras),
              "textbox paragraph counts do not match LIST_HEADER")
    return {"changedStreams": changed, "sourceParagraphs": [h5.paragraph_text(para) for para in old_paras],
            "savedParagraphs": [h5.paragraph_text(para) for para in new_paras],
            "sourceParagraphIds": sorted(old_ids), "savedTextboxParagraphIds": new_ids,
            "ownerSha256": hashlib.sha256(after_obj[0][2]).hexdigest(),
            "sourceText": source_text, "savedText": output_text,
            "preservedSourceTextOffsets": preserved_offsets}


def place_textbox_point(acc, caret, fmt, pointer_id):
    h.p6.pointer(acc, (caret["pageIndex"], caret["x"] + 0.1, caret["y"] + caret["height"] / 2))
    if acc.d.exists(h.FRAME):
        x, y = acc.d.js("""
          const at=arguments[0], canvas=document.querySelectorAll('.rhwp-page__canvas')[at.pageIndex];
          const rect=canvas.getBoundingClientRect(), scale=rect.width/canvas.clientWidth;
          return [rect.left+(at.x+.1)*scale,rect.top+(at.y+at.height/2)*scale];
        """, caret)
        sx, sy = acc.d.pointer_scale
        h.p4.rhwp_poc.perform(acc.d, [{"type": "pointer", "id": pointer_id,
            "parameters": {"pointerType": "mouse"}, "actions": [
                {"type": "pointerMove", "x": round(x*sx), "y": round(y*sy), "origin": "viewport"},
                {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0},
                {"type": "pause", "duration": 60},
                {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}])
    status = acc.status(fmt)
    h.require("textbox" in (status.get("caret") or "").lower(), "pointer lost textbox ownership", status)
    return status


def textbox_replace_ime_and_hwp5(acc, row, fixtures, out):
    hwpx_path = out / "a-p5-textbox-paste-published.hwpx"
    source = fixtures / "a-p5-textbox-paste-original.hwpx"
    source_model = inspect_box(source)
    positions = h.inspect_rhwp(hwpx_path, """
      const owner=controls.find(c=>c.list===0 && c.ctrlId==='gso');
      const address=[0,owner.para,owner.controlIndex,0];
      console.log(JSON.stringify([[1,2],[2,4]].map(([p,o])=>
        JSON.parse(doc.getCursorRectInCell(...address,p,o)))));
    """)
    paste_canvas = canvas_hashes(acc)
    start = place_textbox_point(acc, positions[0], "hwpx", "p5-ime-start")
    h.require(not start.get("selection"), "IME replacement caret unexpectedly selected text", start)
    for _ in range(6):
        acc.key("shift+Right")
    selection = acc.status("hwpx")
    h.require(selection.get("selection") and "textbox" in (selection.get("caret") or "").lower(),
              "IME replacement did not create an owned cross-paragraph selection", selection)
    acc.d.js("""
      window.p5TextboxIme=[];
      window.p5TextboxDom=[];
      const input=document.querySelector('.rhwp-input');
      for(const type of ['compositionstart','compositionupdate','compositionend','keydown','keyup','beforeinput','input'])
        input.addEventListener(type,e=>window.p5TextboxDom.push({type,key:e.key,code:e.code,keyCode:e.keyCode,
          data:e.data,inputType:e.inputType,isComposing:e.isComposing,trusted:e.isTrusted}),true);
      for(const type of ['compositionstart','compositionupdate','compositionend'])
        input.addEventListener(type,e=>window.p5TextboxIme.push({type,data:e.data,trusted:e.isTrusted}),true);
    """)
    row["imeInputBefore"] = acc.d.js("""
      const input=document.querySelector('.rhwp-input');
      return {activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className,
        inputFocused:document.activeElement===input,inputValueLength:input?.value.length,
        engineStatus:document.querySelector('[data-testid=rhwp-status]')?.dataset.status};
    """)
    acc.engine("xkb:us::eng")
    acc.engine("hangul")
    row["imeEngine"] = acc.command(acc.args.ibus, "engine")
    acc.type("gk")
    try:
        acc.wait("""
          const status=document.querySelector('[data-testid="rhwp-status"]')?.dataset;
          return status?.composing === "true";
        """, timeout=8)
    except Exception:
        row["imeInputFailureDiagnostics"] = acc.d.js("""
          const input=document.querySelector('.rhwp-input');
          const status=document.querySelector('[data-testid=rhwp-status]')?.dataset;
          return {activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className,
            inputFocused:document.activeElement===input,inputValueLength:input?.value.length,
            status:{revision:status?.revision,composing:status?.composing,caret:status?.caret,selection:status?.selection},
            events:window.p5TextboxDom};
        """)
        raise
    preedit = acc.status("hwpx")
    row["imePreeditTrace"] = {
        "status": preedit,
        "compositionEvents": acc.d.js("return window.p5TextboxIme"),
        "domEvents": acc.d.js("return window.p5TextboxDom"),
    }
    acc.type("srmf")
    acc.key("End")
    acc.engine("xkb:us::eng")
    acc.wait("""
      const status=document.querySelector('[data-testid=rhwp-status]')?.dataset;
      return status?.composing==='false' && Number(status.revision)>0;
    """)
    committed = acc.status("hwpx")
    committed_canvas = canvas_hashes(acc)
    events = acc.d.js("return window.p5TextboxIme")
    row["imeCommittedTrace"] = {
        "status": committed,
        "compositionEvents": events,
        "domEvents": acc.d.js("return window.p5TextboxDom"),
    }
    h.require(committed_canvas != paste_canvas, "cross-paragraph IME did not change rendered textbox pixels")
    for kind in ("compositionstart", "compositionupdate", "compositionend"):
        h.require(any(event["type"] == kind and event["trusted"] for event in events),
                  f"missing trusted native IME {kind}", events)
    # IBus committed two Hangul syllables; the selected replacement itself must
    # join the first syllable transaction instead of becoming a third revision.
    h.revision(acc, "hwpx", 2)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 3)
    undo_one = acc.status("hwpx")
    undo_one_canvas = canvas_hashes(acc)
    h.require(undo_one_canvas not in (paste_canvas, committed_canvas),
              "one IME Undo did not restore the first committed syllable", undo_one_canvas)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", 4)
    undo = acc.status("hwpx")
    undo_canvas = canvas_hashes(acc)
    h.require(undo_canvas == paste_canvas, "IME Undo did not restore the published paste rendering", undo_canvas)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 5)
    redo_one = acc.status("hwpx")
    redo_one_canvas = canvas_hashes(acc)
    h.require(redo_one_canvas == undo_one_canvas,
              "first IME Redo did not restore the first committed syllable", redo_one_canvas)
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", 6)
    redo = acc.status("hwpx")
    redo_canvas = canvas_hashes(acc)
    h.require(redo_canvas == committed_canvas, "IME Redo did not restore committed rendering", redo_canvas)
    ime = row["crossParagraphIme"] = {"selection": selection, "preedit": preedit,
                                       "committed": committed, "undoFirst": undo_one, "undo": undo,
                                       "redoFirst": redo_one, "redo": redo,
                                       "trustedCompositionEvents": events,
                                       "canvasSha256": {"paste": paste_canvas, "committed": committed_canvas,
                                                        "undoFirst": undo_one_canvas, "undo": undo_canvas,
                                                        "redoFirst": redo_one_canvas, "redo": redo_canvas}}
    h.publish(acc, "hwpx", row)
    row["imeSave"] = row["save"]
    after = inspect_box(hwpx_path)
    old = source_model["paragraphs"]
    expected = [old[0], {**old[1], "text": "Bo한글ain", "runs": [
        [0, 4, old[1]["runs"][0][2]], [4, 7, old[3]["runs"][0][2]]]}, old[4]]
    h.require(after["paragraphs"] == expected and after["shape"] == source_model["shape"]
              and after["body"] == source_model["body"], "IME save changed textbox ownership or text", after)
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(hwpx_path) as published:
        section = "Contents/section0.xml"
        unrelated = lambda package: {part: package.read(part) for part in package.namelist()
                                     if part != section and not part.startswith("Preview/")}
        h.require(unrelated(original) == unrelated(published), "IME save changed unrelated HWPX package parts")
        roots = [ET.fromstring(package.read(section)) for package in (original, published)]
        source_paras = roots[0].find(".//{*}drawText/{*}subList").findall("{*}p")
        saved_paras = roots[1].find(".//{*}drawText/{*}subList").findall("{*}p")
        h.require(len(source_paras) == 5 and len(saved_paras) == 3, "IME paragraph count differs")
        owner_attrs = ("id", "paraPrIDRef", "styleIDRef")
        h.require(all(saved_paras[1].get(name) == source_paras[1].get(name) for name in owner_attrs),
                  "IME replacement changed the starting paragraph owner/style")
        h.require([saved_paras[0].get("id"), saved_paras[2].get("id")]
                  == [source_paras[0].get("id"), source_paras[4].get("id")],
                  "IME replacement changed unselected paragraph identities")

        def runs(para):
            result = []
            for run in para.findall("{*}run"):
                text = "".join(node.text or "" for node in run.findall(".//{*}t"))
                if text:
                    result.append((run.get("charPrIDRef"), text))
            return result

        expected_runs = [(source_paras[1].find("{*}run").get("charPrIDRef"), "Bo한글"),
                         (source_paras[3].find("{*}run").get("charPrIDRef"), "ain")]
        h.require(runs(saved_paras[1]) == expected_runs, "IME replacement changed retained character styles",
                  runs(saved_paras[1]))
        for root, count in zip(roots, (3, 1), strict=True):
            sub = root.find(".//{*}drawText/{*}subList")
            for para in sub.findall("{*}p")[1:1 + count]:
                sub.remove(para)
            for para in sub.findall("{*}p"):
                for layout in para.findall("{*}linesegarray"):
                    para.remove(layout)
        h.require(ET.tostring(roots[0]) == ET.tostring(roots[1]), "IME changed unrelated section XML")
    h.reopen(acc, hwpx_path, row)
    reopened_hwpx = inspect_box(hwpx_path)
    h.require(reopened_hwpx["paragraphs"] == expected, "HWPX IME result differs after document reopen")
    ime["savedSha256"] = h.digest(hwpx_path)
    ime["reopen"] = acc.status("hwpx")

    h.require(h.p4.rhwp_poc.close_tab(acc.d, hwpx_path.name), "HWPX textbox tab did not close")
    hwp5_fixture = fixtures / "p5-h5tb-paste-original.hwp"
    hwp5_before = h5.inspect(hwp5_fixture)
    h.require(hwp5_before["paragraphs"] == ["abcdef"], "unexpected HWP5 paste fixture", hwp5_before)
    hwp5_row = row["hwp5Paste"] = {"before": hwp5_before}
    hwp5_path = h.begin(acc, hwp5_row, hwp5_fixture, out, "p5-h5tb-paste-edited.hwp")
    pointer_status = h5.point_to_textbox(acc, hwp5_before["midCaret"])
    acc.key("Left")
    caret = acc.status("hwp")
    h.require("textbox" in caret.get("caret", "").lower() and "0:0:3@textbox/" in caret.get("caret", ""),
              "HWP5 paste caret is not at the requested text-box position", caret)
    before_status = acc.status("hwp")
    source_canvas = canvas_hashes(acc)
    acc.d.js("""
      window.p5TextboxPasteKeys=[];
      addEventListener('keydown',e=>{
        if(e.ctrlKey&&e.key.toLowerCase()==='v') window.p5TextboxPasteKeys.push(e.isTrusted);
      },true);
    """)

    def paste_hwp5():
        acc.key("ctrl+v")
        h.revision(acc, "hwp", 1)

    h.clipboard_peer(acc, "UTF8_STRING", "X\nY", paste_hwp5)
    hwp5_row["trustedPasteKeys"] = acc.d.js("return window.p5TextboxPasteKeys")
    h.require(hwp5_row["trustedPasteKeys"] == [True], "HWP5 paste did not use a trusted Ctrl+V key")
    pasted_status = acc.status("hwp")
    h.require("textbox" in pasted_status.get("caret", "").lower(),
              "multiline paste caret lost its HWP5 textbox owner", pasted_status)
    pasted_canvas = canvas_hashes(acc)
    h.require(pasted_canvas != source_canvas, "HWP5 multiline paste did not change rendered textbox pixels")
    acc.key("ctrl+z")
    h.revision(acc, "hwp", 2)
    undo_status = acc.status("hwp")
    undo_canvas = canvas_hashes(acc)
    h.require(undo_canvas == source_canvas, "HWP5 paste Undo did not restore the original rendering", undo_canvas)
    acc.key("ctrl+y")
    h.revision(acc, "hwp", 3)
    redo_status = acc.status("hwp")
    redo_canvas = canvas_hashes(acc)
    h.require(redo_canvas == pasted_canvas, "HWP5 paste Redo did not restore the pasted rendering", redo_canvas)
    hwp5_row["undoRedo"] = {"before": before_status, "pasted": pasted_status,
                            "undo": undo_status, "redo": redo_status,
                            "canvasSha256": {"before": source_canvas, "pasted": pasted_canvas,
                                             "undo": undo_canvas, "redo": redo_canvas}}
    hwp5_row["pointer"] = pointer_status
    h.publish(acc, "hwp", hwp5_row)
    hwp5_after = h5.inspect(hwp5_path)
    h.require(hwp5_after["paragraphs"] == ["abcX", "Ydef"]
              and hwp5_after["shape"] == hwp5_before["shape"]
              and hwp5_after["body"] == hwp5_before["body"],
              "saved HWP5 paste changed text-box owner or paragraph contents", hwp5_after)
    hwp5_row["cfbProof"] = hwp5_textbox_paste_disk_proof(hwp5_fixture, hwp5_path, ["abcX", "Ydef"])
    h.reopen(acc, hwp5_path, hwp5_row)
    reopened_hwp5 = h5.inspect(hwp5_path)
    h.require(reopened_hwp5["paragraphs"] == ["abcX", "Ydef"]
              and reopened_hwp5["shape"] == hwp5_before["shape"]
              and reopened_hwp5["body"] == hwp5_before["body"],
              "HWP5 paste result differs after document reopen", reopened_hwp5)
    h5point = h5.point_to_textbox(acc, reopened_hwp5["midCaret"])
    h.require(h5point["revision"] == "0" and h5point["dirty"] == "false",
              "HWP5 saved textbox did not reopen cleanly", h5point)
    hwp5_row["reopen"] = {"model": reopened_hwp5, "status": h5point,
                          "savedSha256": h.digest(hwp5_path)}


def textbox_replace(acc, row, fixtures, out):
    textbox_join(acc, row, fixtures, out, span=3, replace=True)
    textbox_replace_ime_and_hwp5(acc, row, fixtures, out)


def textbox_nested_shape_state(path):
    return h.inspect_rhwp(path, """
      const nested = pages.flatMap((items,page)=>items.filter(c=>c.type==='shape'
        && Array.isArray(c.cellPath)).map(c=>({...c,page})));
      const children = nested.map(child=>{
        const ownerPath=child.cellPath;
        const owner=JSON.parse(doc.getShapeProperties(child.secIdx,child.paraIdx,ownerPath[0].controlIndex));
        const shape=JSON.parse(doc.getCellShapePropertiesByPath(child.secIdx,child.paraIdx,
          JSON.stringify(ownerPath),child.controlIdx));
        const paragraphs=Array.from({length:doc.getCellParagraphCount(child.secIdx,child.paraIdx,
          ownerPath[0].controlIndex,ownerPath[0].cellIndex)},(_,para)=>{
          const length=doc.getCellParagraphLength(child.secIdx,child.paraIdx,ownerPath[0].controlIndex,
            ownerPath[0].cellIndex,para);
          return doc.getTextInCell(child.secIdx,child.paraIdx,ownerPath[0].controlIndex,
            ownerPath[0].cellIndex,para,0,length);
        });
        return {child,owner,shape,paragraphs,ownerPath};
      });
      const model=JSON.parse(doc.getCursorModel());
      console.log(JSON.stringify({children,controls,lists:model.lists,body}));
    """)


def textbox_nested_picture_state(path):
    return h.inspect_rhwp(path, """
      const nested=pages.flatMap((items,page)=>items.filter(c=>c.type==='image'
        &&Array.isArray(c.cellPath)).map(c=>({...c,page})));
      const pictures=nested.map(child=>{
        const ownerPath=child.cellPath,pathJson=JSON.stringify(ownerPath);
        const picture=JSON.parse(doc.getCellPictureByPath(child.secIdx,child.parentParaIdx,pathJson,child.controlIdx));
        const rawPicture=JSON.parse(doc.getCellPicturePropertiesByPath(child.secIdx,child.parentParaIdx,pathJson,child.controlIdx));
        const owner=JSON.parse(doc.getShapeProperties(child.secIdx,child.parentParaIdx,ownerPath[0].controlIndex));
        const ownerControl=controls.filter(c=>c.list===0&&c.para===child.parentParaIdx
          &&c.controlIndex===ownerPath[0].controlIndex);
        return {child,ownerPath,picture,rawPicture,owner,ownerControl};
      });
      const model=JSON.parse(doc.getCursorModel());
      console.log(JSON.stringify({pictures,controls,lists:model.lists,body}));
    """)


def textbox_nested_shape_package_proof(source, output, instance_id, chosen):
    with zipfile.ZipFile(source) as before_zip, zipfile.ZipFile(output) as after_zip:
        before_names, after_names = set(before_zip.namelist()), set(after_zip.namelist())
        h.require(before_names == after_names, "textbox shape edit changed the OPC part set",
                  [sorted(before_names - after_names), sorted(after_names - before_names)])
        changed = [name for name in sorted(before_names)
                   if before_zip.read(name) != after_zip.read(name)]
        h.require(changed == ["Contents/section0.xml"],
                  "textbox shape edit changed unrelated HWPX parts", changed)
        before = ET.fromstring(before_zip.read("Contents/section0.xml"))
        after = ET.fromstring(after_zip.read("Contents/section0.xml"))

    def ellipse(root):
        matches = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "ellipse"
                   and node.get("id") == str(instance_id)]
        h.require(len(matches) == 1, "nested ellipse identity is absent or ambiguous", len(matches))
        return matches[0]

    before_shape, after_shape = ellipse(before), ellipse(after)
    before_fill = before_shape.find(".//{*}fillBrush/{*}winBrush")
    after_fill = after_shape.find(".//{*}fillBrush/{*}winBrush")
    h.require(before_fill is not None and after_fill is not None, "nested ellipse lost its solid fill")
    old_color = before_fill.get("faceColor")
    h.require(old_color == "#996633" and after_fill.get("faceColor", "").upper() == "#" + chosen,
              "nested ellipse fill differs from source or requested edit",
              {"before": old_color, "after": after_fill.get("faceColor")})
    before_fill.set("faceColor", after_fill.get("faceColor"))

    # After restoring the one requested field, compare the complete section tree.
    h.require(ET.tostring(before) == ET.tostring(after),
              "HWPX section XML changed outside the nested shape fill", changed)
    return {"changedParts": changed, "partSetPreserved": True,
            "nestedShapeInstanceId": instance_id, "fillBefore": old_color,
            "fillAfter": after_fill.get("faceColor"), "sectionSemanticEqualityAfterExpectedFill": True,
            "resourceParts": [name for name in sorted(before_names)
                              if name.startswith("BinData/") or "/media/" in name]}


def textbox_nested_shape_native_select(acc, child, expected_fill="#996633"):
    acc.d.js("""
      window.p5TextboxShapePointers=[];
      document.addEventListener('pointerdown',e=>{
        if(e.target.closest('.rhwp-page__canvas'))
          window.p5TextboxShapePointers.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});
      },true);
    """)
    h.p6.pointer(acc, (child["page"], child["x"] + child["w"] / 2,
                       child["y"] + child["h"] / 2))
    # HWP's original-source SAFE preflight is asynchronous. A pointer hit can expose the
    # frame before the structural edit gate settles; wait for the inspector capability too
    # so an initial read-only transient is not misreported as a permanently blocked object.
    try:
        acc.wait("""
          const f=document.querySelector(arguments[0]);
          return f?.dataset.objectKind==='shape' && !!document.querySelector(arguments[1]);
        """, h.FRAME, h.p6.SHAPE, timeout=30)
    except Exception as error:
        observed = acc.d.js("""
          const f=document.querySelector(arguments[0]);
          const save=document.querySelector(arguments[2]);
          return {kind:f?.dataset.objectKind,shapeTools:!!document.querySelector(arguments[1]),
            saveResult:save&&Object.fromEntries(['state','outcome','error','findings'].map(k=>[k,save.dataset[k]])),
            saveFindings:Array.from(document.querySelectorAll(arguments[3]+' [data-code]')).map(e=>({code:e.dataset.code,part:e.dataset.part})),
            text:document.body.innerText.slice(0,1200)};
        """, h.FRAME, h.p6.SHAPE, "[data-testid='rhwp-save-result']", "[data-testid='save-findings']")
        raise ValueError(f"textbox child inspector did not become editable after the source preflight settled: {observed!r}") from error
    observed = acc.d.js("""
      const f=document.querySelector(arguments[0]);
      const input=document.querySelector(arguments[1]);
      return {frame:f&&Object.fromEntries(['left','top','width','height'].map(k=>[k,parseFloat(f.style[k])])),
        kind:f?.dataset.objectKind,fill:input?.value,shapeTools:!!document.querySelector(arguments[2]),
        pointers:window.p5TextboxShapePointers.slice()};
    """, h.FRAME, h.p6.SHAPE + " > label input[type=color]", h.p6.SHAPE)
    h.require(observed["kind"] == "shape" and observed["shapeTools"],
              "textbox child did not resolve to the editable shape inspector", observed)
    h.require(observed["fill"].upper() == expected_fill.upper(),
              "pointer selected the textbox owner or another sibling instead of the child ellipse", observed)
    h.require(observed["pointers"] and observed["pointers"][-1]["trusted"] is True,
              "nested shape was not selected by trusted Native pointer input", observed["pointers"])
    return observed


def textbox_nested_shape_hwp5_disk_proof(source, output, instance_id, chosen):
    source_streams, output_streams = (h5.cfb_streams(path.read_bytes()) for path in (source, output))
    h.require(source_streams.keys() == output_streams.keys(), "HWP5 CFB stream set changed")
    changed_streams = sorted(name for name in source_streams if source_streams[name] != output_streams[name])
    h.require(set(changed_streams) <= {"BodyText/Section0", "PrvText", "PrvImage"},
              "nested textbox edit changed an unrelated HWP5 stream", changed_streams)
    expected_text_preview = "body parent sibling\r\n".encode("utf-16le")
    h.require(output_streams.get("PrvText") == expected_text_preview,
              "saved HWP5 text preview is not the exact top-level body text", output_streams.get("PrvText"))
    image_proof = canonical_preview_png(
        output_streams.get("PrvImage", b""), hwp_preview_dimensions(output_streams))
    h.require(image_proof is not None, "saved HWP5 page preview is not a canonical output-sized PNG")
    before_rows = h5.records(h5.unpacked(source_streams, "BodyText/Section0"))
    after_rows = h5.records(h5.unpacked(output_streams, "BodyText/Section0"))
    before_start, before_end, before_owner = h5.textbox_object(before_rows)
    after_start, after_end, after_owner = h5.textbox_object(after_rows)
    h.require(before_rows[:before_start] == after_rows[:after_start]
              and before_rows[before_end:] == after_rows[after_end:],
              "HWP5 body records outside the textbox changed")
    h.require(before_start == after_start and before_end - before_start == after_end - after_start,
              "HWP5 textbox record span changed")

    def child_span(owner):
        starts = [index for index, (tag, level, data) in enumerate(owner)
                  if tag == 71 and level > 3 and data.startswith(b" osg")]
        h.require(len(starts) == 1, "expected exactly one direct nested GSO child", starts)
        start = starts[0]
        level = owner[start][1]
        end = next((index for index in range(start + 1, len(owner)) if owner[index][1] <= level), len(owner))
        h.require(owner[start + 1][0] == 76 and owner[start + 1][1] == level + 1,
                  "nested GSO child has no shape component")
        return start, end

    before_child, after_child = child_span(before_owner), child_span(after_owner)
    h.require(before_child == after_child and before_owner[:before_child[0]] == after_owner[:after_child[0]]
              and before_owner[before_child[1]:] == after_owner[after_child[1]:],
              "HWP5 textbox owner, paragraph, or child siblings changed")
    h.require(len(before_owner[before_child[0]:before_child[1]])
              == len(after_owner[after_child[0]:after_child[1]]),
              "nested HWP5 GSO record count changed")
    return {"changedStreams": changed_streams, "streamSetPreserved": True,
            "onlyNestedGsoChildChanged": True, "nestedShapeInstanceId": instance_id,
            "derivedTextPreviewExact": True, "imagePreview": image_proof,
            "sourceChildRecordCount": before_child[1] - before_child[0],
            "savedChildRecordCount": after_child[1] - after_child[0]}


def textbox_nested_picture_hwpx_disk_proof(source, output, instance_id, sc_inst_id, width, height):
    with zipfile.ZipFile(source) as before_zip, zipfile.ZipFile(output) as after_zip:
        before_names, after_names = set(before_zip.namelist()), set(after_zip.namelist())
        h.require(before_names == after_names, "nested HWPX picture resize changed the package part set",
                  [sorted(before_names - after_names), sorted(after_names - before_names)])
        changed = [name for name in sorted(before_names)
                   if before_zip.read(name) != after_zip.read(name)]
        h.require(changed == ["Contents/section0.xml"],
                  "nested HWPX picture resize changed unrelated package parts", changed)
        for name in before_names:
            if name.startswith("BinData/"):
                h.require(before_zip.read(name) == after_zip.read(name),
                          "nested HWPX picture resize changed its media resource", name)
        before = ET.fromstring(before_zip.read("Contents/section0.xml"))
        after = ET.fromstring(after_zip.read("Contents/section0.xml"))

    def picture(root):
        matches = [node for node in root.iter() if node.tag.rsplit("}", 1)[-1] == "pic"
                   and node.get("id") == str(instance_id)]
        h.require(len(matches) == 1, "HWPX textbox picture identity is absent or ambiguous", len(matches))
        return matches[0]

    old_pic, new_pic = picture(before), picture(after)
    h.require(old_pic.get("instid") == str(sc_inst_id) and new_pic.get("instid") == str(sc_inst_id),
              "HWPX textbox picture source identity changed", [old_pic.attrib, new_pic.attrib])
    changed_fields = {}
    for tag in ("sz", "curSz"):
        old = next((node for node in old_pic if node.tag.rsplit("}", 1)[-1] == tag), None)
        new = next((node for node in new_pic if node.tag.rsplit("}", 1)[-1] == tag), None)
        h.require(old is not None and new is not None, f"HWPX textbox picture lost its {tag} size")
        h.require((new.get("width"), new.get("height")) == (str(width), str(height)),
                  f"HWPX textbox picture {tag} differs from the requested dimensions",
                  None if new is None else new.attrib)
        changed_fields[tag] = {"before": dict(old.attrib), "after": dict(new.attrib)}
        new.attrib = dict(old.attrib)
    h.require(ET.tostring(before) == ET.tostring(after),
              "HWPX section changed outside the nested picture's two size records")
    return {"changedParts": changed, "partSetPreserved": True, "mediaBytesUnchanged": True,
            "pictureInstanceId": instance_id, "pictureScInstId": sc_inst_id,
            "sizeFields": changed_fields, "wholeSectionEqualAfterExpectedSize": True}


def textbox_nested_picture_hwp5_disk_proof(source, output, before_model, after_model, width, height):
    source_streams, output_streams = (h5.cfb_streams(path.read_bytes()) for path in (source, output))
    h.require(source_streams.keys() == output_streams.keys(), "nested HWP5 picture resize changed CFB streams")
    changed_streams = sorted(name for name in source_streams if source_streams[name] != output_streams[name])
    h.require(set(changed_streams) <= {"BodyText/Section0", "PrvText", "PrvImage"},
              "nested HWP5 picture resize changed unrelated CFB streams", changed_streams)
    for name in source_streams:
        if name.startswith("BinData/"):
            h.require(source_streams[name] == output_streams[name],
                      "nested HWP5 picture resize changed its BinData resource", name)
    expected_text_preview = "\r\n".join(before_model["body"]) .encode("utf-16le") + "\r\n".encode("utf-16le")
    h.require(output_streams.get("PrvText") == expected_text_preview,
              "saved HWP5 text preview differs from the exact top-level body text",
              output_streams.get("PrvText"))
    image_proof = canonical_preview_png(
        output_streams.get("PrvImage", b""), hwp_preview_dimensions(output_streams))
    h.require(image_proof is not None, "saved HWP5 preview is not a canonical output-sized PNG")

    before_rows = h5.records(h5.unpacked(source_streams, "BodyText/Section0"))
    after_rows = h5.records(h5.unpacked(output_streams, "BodyText/Section0"))
    before_start, before_end, before_owner = h5.textbox_object(before_rows)
    after_start, after_end, after_owner = h5.textbox_object(after_rows)
    h.require(before_rows[:before_start] == after_rows[:after_start]
              and before_rows[before_end:] == after_rows[after_end:],
              "HWP5 body records outside the textbox changed")
    h.require(before_start == after_start and before_end - before_start == after_end - after_start,
              "HWP5 textbox record span changed")

    def child_span(owner):
        starts = [index for index, (tag, level, data) in enumerate(owner)
                  if tag == 71 and level > 3 and data.startswith(b" osg")]
        h.require(len(starts) == 1, "expected exactly one direct nested picture GSO", starts)
        start = starts[0]
        level = owner[start][1]
        end = next((index for index in range(start + 1, len(owner))
                    if owner[index][1] <= level), len(owner))
        return start, end

    before_child, after_child = child_span(before_owner), child_span(after_owner)
    h.require(before_child == after_child and len(before_owner) == len(after_owner),
              "HWP5 nested picture record position or child span changed")
    fields = {71: (16, 20), 76: (28, 32)}
    normalized = []
    seen = {71: 0, 76: 0}
    for index, (old, new) in enumerate(zip(before_owner, after_owner)):
        old_tag, old_level, old_data = old
        new_tag, new_level, new_data = new
        h.require((old_tag, old_level, len(old_data)) == (new_tag, new_level, len(new_data)),
                  "HWP5 nested picture edit changed record tags, levels, or lengths", index)
        if before_child[0] <= index < before_child[1] and old_tag in fields:
            width_offset, height_offset = fields[old_tag]
            old_bytes, new_bytes = bytearray(old_data), bytearray(new_data)
            expected_old = (int(before_model["pictures"][0]["picture"]["width"]),
                            int(before_model["pictures"][0]["picture"]["height"]))
            expected_new = (width, height)
            actual_old = (int.from_bytes(old_bytes[width_offset:width_offset + 4], "little"),
                          int.from_bytes(old_bytes[height_offset:height_offset + 4], "little"))
            actual_new = (int.from_bytes(new_bytes[width_offset:width_offset + 4], "little"),
                          int.from_bytes(new_bytes[height_offset:height_offset + 4], "little"))
            h.require(actual_old == expected_old and actual_new == expected_new,
                      "HWP5 nested picture size fields differ from the inspected object", [old_tag, actual_old, actual_new])
            new_bytes[width_offset:width_offset + 4] = old_bytes[width_offset:width_offset + 4]
            new_bytes[height_offset:height_offset + 4] = old_bytes[height_offset:height_offset + 4]
            normalized.append((new_tag, new_level, bytes(new_bytes)))
            seen[old_tag] += 1
        else:
            normalized.append(new)
    h.require(seen == {71: 1, 76: 1}, "HWP5 picture resize did not touch exactly its two size fields", seen)
    h.require(before_owner == normalized,
              "HWP5 textbox owner or nested picture bytes changed outside width and height")
    return {"changedStreams": changed_streams, "streamSetPreserved": True, "binDataBytesUnchanged": True,
            "pictureInstanceId": before_model["pictures"][0]["picture"]["instanceId"],
            "normalizedNestedRecordsEqual": True, "onlyPictureWidthAndHeightChanged": True,
            "sizeFields": {"width": width, "height": height}, "derivedTextPreviewExact": True,
            "imagePreview": image_proof, "sourceChildRecordCount": before_child[1] - before_child[0],
            "savedChildRecordCount": after_child[1] - after_child[0]}


def textbox_nested_picture_native_select(acc, child, expected_width):
    acc.d.js("""
      if(!Array.isArray(window.p5TextboxPicturePointers)){
        window.p5TextboxPicturePointers=[];
        document.addEventListener('pointerdown',e=>{
          if(e.target.closest('.rhwp-page__canvas'))
            window.p5TextboxPicturePointers.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});
        },true);
      }
    """)
    h.p6.pointer(acc, (child["page"], child["x"] + child["w"] / 2,
                       child["y"] + child["h"] / 2))
    try:
        acc.wait("""
          return document.querySelector(arguments[0])?.dataset.objectKind==='picture'
            &&!!document.querySelector(arguments[1]);
        """, h.FRAME, WIDTH, timeout=30)
    except Exception as error:
        observed = acc.d.js("""
          const f=document.querySelector(arguments[0]),save=document.querySelector(arguments[2]);
          return {kind:f?.dataset.objectKind,sizeTools:!!document.querySelector(arguments[1]),
            saveResult:save&&Object.fromEntries(['state','outcome','error','findings'].map(k=>[k,save.dataset[k]])),
            text:document.body.innerText.slice(0,1000)};
        """, h.FRAME, WIDTH, "[data-testid='rhwp-save-result']")
        raise ValueError(f"textbox picture inspector did not become editable: {observed!r}") from error
    observed = acc.d.js("""
      const f=document.querySelector(arguments[0]);
      const width=document.querySelector(arguments[1]),height=document.querySelector(arguments[2]);
      return {kind:f?.dataset.objectKind,width:width?.value,height:height?.value,
        frame:f&&Object.fromEntries(['left','top','width','height'].map(k=>[k,parseFloat(f.style[k])])),
        pointers:window.p5TextboxPicturePointers.slice()};
    """, h.FRAME, WIDTH, SIZE_FORM + " label:nth-of-type(2) input")
    h.require(observed["kind"] == "picture" and observed["frame"] is not None,
              "trusted hit selected the textbox owner instead of its nested picture", observed)
    h.require(abs(float(observed["width"]) - expected_width) < 0.01,
              "nested picture size inspector is bound to the wrong object or size", observed)
    h.require(observed["pointers"] and observed["pointers"][-1]["trusted"] is True,
              "nested textbox picture was not selected by trusted Native pointer input", observed["pointers"])
    return observed


def textbox_nested_picture(acc, row, fixtures, out, fmt="hwpx"):
    fixture = fixtures / ("p5-tb-control-hwp5-picture.hwp" if fmt == "hwp"
                          else "p5-tb-control-hwpx-picture.hwpx")
    before = row["before"] = textbox_nested_picture_state(fixture)
    h.require(len(before["pictures"]) == 1, "fixture must contain one nested textbox-owned picture", before)
    target = before["pictures"][0]
    h.require(target["ownerPath"] == [{"controlIndex": 2, "cellIndex": 0, "cellParaIndex": 0}]
              and target["owner"].get("tbVerticalAlign") == "Bottom"
              and target["picture"].get("instanceId") != target["owner"].get("instanceId")
              and target["picture"].get("treatAsChar") is True
              and target["picture"].get("width") == 4000 and target["picture"].get("height") == 2000,
              "fixture picture identity, dimensions, or exact textbox ownership differs", target)
    h.require(target["picture"].get("sha256") == "2e0817c744876e5f3ef3d890ab2601a435cc41a1d4507f67295c4ad968b623b2"
              and target["ownerControl"][0].get("ctrlId") == "gso"
              and target["ownerControl"][0].get("props", {}).get("Lock") == 0,
              "fixture media hash or unlocked parent ownership is not verified", target)
    row["initialFixtureSha256"] = h.digest(fixture)
    path = h.begin(acc, row, fixture, out, f"p5-tb-control-{fmt}-picture-edited.{fmt}")
    if fmt == "hwp":
        h.p6.gso.p4.rhwp_poc.press_button(acc.d, "[data-testid=rhwp-save-check]")
        acc.wait("""
          const s=document.querySelector(arguments[0]);
          return s?.dataset.state==='failed'||['safe','unsafe'].includes(s?.dataset.outcome);
        """, "[data-testid=rhwp-save-result]", timeout=60)
        row["originalPreflight"] = acc.d.js("""
          const s=document.querySelector(arguments[0]);
          return s&&Object.fromEntries(['state','outcome','error','findings'].map(k=>[k,s.dataset[k]]));
        """, "[data-testid=rhwp-save-result]")
        row["originalPreflightFindings"] = acc.d.js("""
          return Array.from(document.querySelectorAll(arguments[0]+' [data-code]'))
            .map(e=>({code:e.dataset.code,part:e.dataset.part}));
        """, "[data-testid=save-findings]")
        h.require(row["originalPreflight"].get("outcome") == "safe"
                  and not row["originalPreflight"].get("error"),
                  "HWP source preflight did not prove SAFE before picture mutation",
                  {"check": row["originalPreflight"], "findings": row["originalPreflightFindings"]})

    selected = row["nativeSelection"] = textbox_nested_picture_native_select(acc, target["child"], 40)
    h.p6.fill_input(acc, WIDTH, "50")
    acc.dom_click(SIZE_FORM + " button[type=submit]")
    h.revision(acc, fmt, 1)
    selected = textbox_nested_picture_native_select(acc, target["child"], 50)
    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    textbox_nested_picture_native_select(acc, target["child"], 40)
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    selected = textbox_nested_picture_native_select(acc, target["child"], 50)
    row["trustedPointerEvents"] = selected["pointers"]
    h.require(row["trustedPointerEvents"]
              and all(event["trusted"] is True for event in row["trustedPointerEvents"]),
              "nested picture selection included an untrusted pointer event", row["trustedPointerEvents"])

    h.publish(acc, fmt, row)
    row["savedSha256"] = h.digest(path)
    after = row["after"] = textbox_nested_picture_state(path)
    h.require(len(after["pictures"]) == 1 and after["body"] == before["body"],
              "picture resize changed body ownership or nested child count", after)
    edited = after["pictures"][0]
    h.require(edited["ownerPath"] == target["ownerPath"] and edited["owner"] == target["owner"]
              and edited["ownerControl"] == target["ownerControl"]
              and edited["picture"].get("instanceId") == target["picture"].get("instanceId")
              and edited["picture"].get("binDataId") == target["picture"].get("binDataId")
              and edited["picture"].get("byteLength") == target["picture"].get("byteLength")
              and edited["picture"].get("sha256") == target["picture"].get("sha256")
              and (edited["picture"].get("width"), edited["picture"].get("height")) == (5000, 2500),
              "saved textbox picture changed owner/resource identity or requested dimensions", edited)
    if fmt == "hwpx":
        manifest = json.loads((fixtures / "fixture-manifest.json").read_text())
        sc_inst_id = manifest["nestedPicture"]["sourceScInstId"]
        row["packageProof"] = textbox_nested_picture_hwpx_disk_proof(
            fixture, path, target["picture"]["instanceId"], sc_inst_id, 5000, 2500)
    else:
        row["cfbProof"] = textbox_nested_picture_hwp5_disk_proof(fixture, path, before, after, 5000, 2500)
    row["undoRedo"] = {"undoRestoredWidth": 40, "redoRestoredWidth": 50, "revisions": [1, 2, 3]}
    h.reopen(acc, path, row)
    reopened = textbox_nested_picture_state(path)
    h.require(reopened["pictures"][0]["picture"].get("instanceId") == target["picture"].get("instanceId")
              and (reopened["pictures"][0]["picture"].get("width"),
                   reopened["pictures"][0]["picture"].get("height")) == (5000, 2500),
              "same-session reopen lost nested picture identity or dimensions", reopened)
    row["sameSessionReopen"] = textbox_nested_picture_native_select(
        acc, reopened["pictures"][0]["child"], 50)


def textbox_nested_picture_fresh(acc, row, fixtures, out, fmt="hwpx"):
    prior = json.loads((out / "result.json").read_text())
    prior_case = prior.get("cases", {}).get(f"P5-TB-CONTROL-{fmt.upper()}-PICTURE", {})
    h.require(prior_case.get("status") == "PASS", "fresh picture reopen requires a passing edit case", prior_case)
    fixture = out / f"p5-tb-control-{fmt}-picture-edited.{fmt}"
    path = h.begin(acc, row, fixture, out, f"p5-tb-control-{fmt}-picture-fresh-probe.{fmt}")
    row["expectedSavedSha256"] = prior_case.get("savedSha256")
    row["savedSha256"] = h.digest(path)
    h.require(row["savedSha256"] == row["expectedSavedSha256"],
              "fresh Native process received a different saved picture package", row)
    h.require(row["processAppSha256"] == prior_case.get("processAppSha256")
              and row["appPid"] != prior_case.get("appPid"),
              "fresh reopen did not use the same Release application in a distinct process", row)
    state = row["freshModel"] = textbox_nested_picture_state(path)
    picture = state["pictures"][0]["picture"]
    h.require(row["initialSession"].get("dirty") == "false"
              and row["initialSession"].get("unpreserved") == "false"
              and picture.get("instanceId") == prior_case.get("before", {}).get("pictures", [{}])[0].get("picture", {}).get("instanceId")
              and (picture.get("width"), picture.get("height")) == (5000, 2500),
              "fresh process did not restore the saved nested picture cleanly", state)
    row["freshProcessReopen"] = textbox_nested_picture_native_select(
        acc, state["pictures"][0]["child"], 50)


def textbox_nested_shape(acc, row, fixtures, out, fmt="hwpx"):
    fixture = fixtures / ("p5-tb-control-hwp5-shape.hwp" if fmt == "hwp"
                         else "p5-tb-control-hwpx-shape.hwpx")
    before = row["before"] = textbox_nested_shape_state(fixture)
    h.require(len(before["children"]) == 1, "fixture must contain exactly one nested textbox-owned shape",
              before["children"])
    target = before["children"][0]
    owner_path = target["ownerPath"]
    h.require(owner_path == [{"controlIndex": 2, "cellIndex": 0, "cellParaIndex": 0}]
              and target["owner"].get("tbVerticalAlign") == "Bottom"
              and target["shape"].get("instanceId") != target["owner"].get("instanceId"),
              "fixture child and textbox parent do not have independent owner identities", target)
    row["initialFixtureSha256"] = h.digest(fixture)
    path = h.begin(acc, row, fixture, out, f"p5-tb-control-{fmt}-shape-edited.{fmt}")
    if fmt == "hwp":
        # HWP structural edits require a SAFE proof of the exact source. Request the
        # documented user-visible retry explicitly and record its decision before mutation.
        h.p6.gso.p4.rhwp_poc.press_button(acc.d, "[data-testid=rhwp-save-check]")
        acc.wait("""
          const s=document.querySelector(arguments[0]);
          return s?.dataset.state==='failed' || ['safe','unsafe'].includes(s?.dataset.outcome);
        """, "[data-testid=rhwp-save-result]", timeout=60)
        row["originalPreflight"] = acc.d.js("""
          const s=document.querySelector(arguments[0]);
          return s&&Object.fromEntries(['state','outcome','error','findings'].map(k=>[k,s.dataset[k]]));
        """, "[data-testid=rhwp-save-result]")
        row["originalPreflightFindings"] = acc.d.js("""
          return Array.from(document.querySelectorAll(arguments[0]+' [data-code]'))
            .map(e=>({code:e.dataset.code,part:e.dataset.part}));
        """, "[data-testid=save-findings]")
        h.require(row["originalPreflight"].get("outcome") == "safe"
                  and not row["originalPreflight"].get("error"),
                  "HWP source preflight did not prove SAFE before nested-object mutation",
                  {"check": row["originalPreflight"], "findings": row["originalPreflightFindings"]})
    selected = row["nativeSelection"] = textbox_nested_shape_native_select(acc, target["child"])
    fill = h.p6.SHAPE + " > label input[type=color]"
    original = h.p6.value(acc, fill)
    h.require(original.upper() == "#996633", "nested fill inspector bound to the wrong shape", original)
    chosen = "884422"
    h.p6.color(acc, fill, "#" + chosen)
    h.revision(acc, fmt, 1)
    selected = textbox_nested_shape_native_select(acc, target["child"], "#" + chosen)
    h.require(selected["fill"].upper() == "#" + chosen,
              "nested ellipse color did not change through its textbox owner path", selected)
    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    selected = textbox_nested_shape_native_select(acc, target["child"])
    h.require(selected["fill"].upper() == "#996633", "Undo did not restore the child fill", selected)
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    selected = textbox_nested_shape_native_select(acc, target["child"], "#" + chosen)
    h.require(selected["fill"].upper() == "#" + chosen, "Redo did not restore the child fill", selected)
    row["trustedPointerEvents"] = selected["pointers"]
    h.publish(acc, fmt, row)
    after = row["after"] = textbox_nested_shape_state(path)
    h.require(len(after["children"]) == 1 and after["body"] == before["body"],
              "textbox shape edit changed body ownership or child count", after)
    edited = after["children"][0]
    h.require(edited["ownerPath"] == owner_path and edited["owner"] == target["owner"]
              and edited["paragraphs"] == target["paragraphs"],
              "nested shape edit changed textbox ownership or paragraph text", edited)
    h.require(edited["shape"]["instanceId"] == target["shape"]["instanceId"]
              and edited["shape"]["scInstId"] == target["shape"]["scInstId"]
              and edited["shape"]["fillBgColor"] == int.from_bytes(bytes.fromhex(chosen), "little"),
              "saved nested shape identity or fill is incorrect", edited["shape"])
    row["packageProof"] = textbox_nested_shape_package_proof(
        fixture, path, target["shape"]["instanceId"], chosen) if fmt == "hwpx" else textbox_nested_shape_hwp5_disk_proof(
            fixture, path, target["shape"]["instanceId"], chosen)
    row["undoRedo"] = {"undoRestored": "#996633", "redoRestored": "#" + chosen,
                       "revisions": [1, 2, 3]}
    row["savedSha256"] = h.digest(path)


def textbox_nested_shape_fresh(acc, row, fixtures, out, fmt="hwpx"):
    fixture = out / f"p5-tb-control-{fmt}-shape-edited.{fmt}"
    prior = json.loads((out / "result.json").read_text())
    prior_row = prior.get("cases", {}).get(f"P5-TB-CONTROL-{fmt.upper()}", {})
    h.require(prior_row.get("status") == "PASS", "fresh reopen requires a passing edit case", prior_row)
    h.require(prior_row.get("appPid") != row.get("appPid"),
              "fresh reopen reused the prior Native application process",
              {"editPid": prior_row.get("appPid"), "freshPid": row.get("appPid")})
    before = row["savedModel"] = textbox_nested_shape_state(fixture)
    h.require(len(before["children"]) == 1 and
              before["children"][0]["shape"].get("fillBgColor") == int.from_bytes(bytes.fromhex("884422"), "little"),
              "saved nested ellipse fill did not survive independent model reopen", before)
    acc.open_native(fmt, fixture)
    row["opened"] = acc.status(fmt)
    h.require(row["opened"].get("dirty") == "false", f"fresh {fmt.upper()} session opened dirty", row["opened"])
    selected = row["nativeSelection"] = textbox_nested_shape_native_select(
        acc, before["children"][0]["child"], "#884422")
    h.require(selected["fill"].upper() == "#884422", "fresh Native process rendered or selected a different child", selected)
    row["freshProcessReopen"] = True
    row["savedSha256"] = h.digest(fixture)



def docx_textbox_color_points(acc, rgb):
    return acc.d.js("""
      const want=arguments[0],result=[];
      for(const [page,c] of [...document.querySelectorAll('.docx-page canvas')].entries()){
        if(!c.width||!c.height)continue;
        const sx=c.width/c.clientWidth,sy=c.height/c.clientHeight;
        const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let count=0,sumX=0,sumY=0;
        for(let y=0;y<=c.height;y++){
          let row=0,rowX=0;
          if(y<c.height)for(let x=0;x<c.width;x++){
            const i=(y*c.width+x)*4;
            if(data[i]!==want[0]||data[i+1]!==want[1]||data[i+2]!==want[2]||data[i+3]!==255)continue;
            row++;rowX+=x;
          }
          if(row>5){count+=row;sumX+=rowX;sumY+=y*row}
          else if(count>0){if(count>100)result.push([page,sumX/count/sx,sumY/count/sy,count]);count=0;sumX=0;sumY=0}
        }
      }
      return result;
    """, list(rgb))


def select_docx_textbox_color(acc, rgb, kind):
    points=docx_textbox_color_points(acc,rgb)
    h.require(len(points)==1,"expected one rendered nested textbox target color",[rgb,points])
    point=points[0]
    x,y=acc.d.js("""
      const [page,x,y]=arguments[0],c=document.querySelectorAll('.docx-page canvas')[page];
      const s=document.querySelector('.editor__scroll'),r=c.getBoundingClientRect(),v=s.getBoundingClientRect();
      const k=r.width/c.clientWidth;s.scrollTop+=r.top+y*k-(v.top+v.height/2);
      const n=c.getBoundingClientRect();return[n.left+x*k,n.top+y*k];
    """,point)
    h.p4.rhwp_poc.click(acc.d,x,y)
    acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind===arguments[1]",
             h.FRAME,kind,timeout=10)
    crop=h.p6.TOOLS+" form:has(.picture-crop-fields)"
    state=acc.d.js("""
      const f=document.querySelector(arguments[0]);
      return {kind:f?.dataset.objectKind,
        frame:f&&Object.fromEntries(['left','top','width','height'].map(k=>[k,parseFloat(f.style[k])])),
        width:document.querySelector(arguments[1])?.value??null,
        height:document.querySelector(arguments[2])?.value??null,
        description:document.querySelector(arguments[3])?.value??null,
        fill:document.querySelector(arguments[4])?.value??null,
        crop:[...document.querySelectorAll(arguments[5]+' .picture-crop-fields input')].map(e=>e.value)};
    """,h.FRAME,WIDTH,SIZE_FORM+" label:nth-of-type(2) input",DESCRIPTION,
      h.p6.SHAPE+" label input[type=color]",crop)
    h.require(state["kind"]==kind and state["frame"] is not None,
              "trusted hit did not select the nested textbox child",state)
    return {"point":point,"state":state}


def docx_textbox_picture_proof(source,output):
    with zipfile.ZipFile(source) as before_zip,zipfile.ZipFile(output) as after_zip:
        before_names,after_names=set(before_zip.namelist()),set(after_zip.namelist())
        h.require(before_names==after_names,"textbox child edits changed the OPC part set",
                  [sorted(before_names-after_names),sorted(after_names-before_names)])
        changed=[name for name in sorted(before_names) if before_zip.read(name)!=after_zip.read(name)]
        h.require(set(changed)<={"word/document.xml","docProps/app.xml"}
                  and "word/document.xml" in changed,"textbox child edit changed unrelated OPC parts",changed)
        for name in sorted(before_names):
            if name.endswith(".rels") or name.startswith("word/media/"):
                h.require(before_zip.read(name)==after_zip.read(name),
                          "textbox picture edit changed a relationship or media resource",name)
        before=ET.fromstring(before_zip.read("word/document.xml"))
        after=ET.fromstring(after_zip.read("word/document.xml"))

    def content(root):
        matches=list(root.iter(W+"txbxContent"))
        h.require(len(matches)==1,"DOCX fixture has ambiguous textbox story ownership",len(matches))
        return matches[0]

    def picture(textbox):
        matches=list(textbox.iter(PIC+"pic"))
        h.require(len(matches)==1,"textbox story must contain exactly one picture",len(matches))
        pic=matches[0]
        inline=next((node for node in textbox.iter(WP+"inline")
                     if node.find(".//"+PIC+"pic") is pic),None)
        h.require(inline is not None,"nested textbox picture lost its inline frame")
        return inline,pic

    before_content,after_content=content(before),content(after)
    before_inline,before_pic=picture(before_content)
    after_inline,after_pic=picture(after_content)
    paragraphs=lambda node:["".join(t.text or "" for t in p.iter(W+"t")) for p in node.iter(W+"p")]
    h.require(paragraphs(before_content)==paragraphs(after_content),"picture edit changed textbox paragraph text")
    old_frame,new_frame=before_inline.find(WP+"extent"),after_inline.find(WP+"extent")
    old_shape,new_shape=before_pic.find(".//"+A+"xfrm/"+A+"ext"),after_pic.find(".//"+A+"xfrm/"+A+"ext")
    h.require(all(node is not None for node in (old_frame,new_frame,old_shape,new_shape)),
              "nested picture lost a DrawingML extent")
    h.require(new_frame.attrib=={"cx":"635000","cy":"317500"}
              and new_shape.attrib=={"cx":"635000","cy":"317500"},
              "saved nested picture extents differ from 50×25 pt",[new_frame.attrib,new_shape.attrib])
    old_blip,new_blip=before_pic.find(".//"+A+"blip"),after_pic.find(".//"+A+"blip")
    old_cn,new_cn=before_pic.find(".//"+PIC+"cNvPr"),after_pic.find(".//"+PIC+"cNvPr")
    old_docpr,new_docpr=before_inline.find(WP+"docPr"),after_inline.find(WP+"docPr")
    h.require(old_blip is not None and new_blip is not None and old_blip.attrib==new_blip.attrib,
              "nested picture relationship identity changed")
    h.require(old_cn is not None and new_cn is not None and old_docpr is not None and new_docpr is not None
              and new_cn.get("descr")=="Nested textbox picture"
              and new_docpr.get("descr")=="Nested textbox picture"
              and old_cn.get("id")==new_cn.get("id") and old_docpr.get("id")==new_docpr.get("id"),
              "nested picture identity or alt text changed incorrectly")
    old_crop,new_crop=before_pic.find(".//"+A+"srcRect"),after_pic.find(".//"+A+"srcRect")
    h.require(new_crop is not None and new_crop.get("l")=="10000"
              and all(new_crop.get(side,"0")=="0" for side in ("t","r","b")),
              "saved nested picture crop differs from the requested left crop",
              None if new_crop is None else new_crop.attrib)

    def child_shape(textbox):
        candidates=[]
        for node in textbox.iter(WPS+"wsp"):
            fill=node.find(".//"+A+"solidFill/"+A+"srgbClr")
            if fill is not None and fill.get("val","").upper() in {"7A47A8","884422"}:
                candidates.append((node,fill))
        h.require(len(candidates)==1,"nested textbox child shape is absent or ambiguous",len(candidates))
        return candidates[0]

    (old_shape_obj,old_fill),(new_shape_obj,new_fill)=child_shape(before_content),child_shape(after_content)
    h.require(old_fill.get("val","").upper()=="7A47A8" and new_fill.get("val","").upper()=="884422",
              "nested textbox shape did not preserve the requested fill")
    saved_frame,saved_shape=new_frame.attrib.copy(),new_shape.attrib.copy()
    saved_crop=new_crop.attrib.copy()
    saved_alt_text=new_docpr.get("descr")
    saved_shape_fill=new_fill.get("val")
    saved_relationship=new_blip.get(REL+"embed")
    h.require(saved_relationship is not None,"saved nested picture relationship id is missing")
    new_frame.attrib=old_frame.attrib.copy();new_shape.attrib=old_shape.attrib.copy()
    if old_crop is None:
        for parent in after_pic.iter():
            for child in list(parent):
                if child is new_crop: parent.remove(child)
    else:
        new_crop.attrib=old_crop.attrib.copy()
    for target,source_node in ((new_cn,old_cn),(new_docpr,old_docpr)):
        if "descr" in source_node.attrib: target.set("descr",source_node.get("descr"))
        else: target.attrib.pop("descr",None)
    new_fill.set("val",old_fill.get("val"))
    h.require(ET.tostring(before)==ET.tostring(after),
              "document.xml changed outside the nested picture fields and child shape fill")
    return {"changedParts":changed,"partSetPreserved":True,"relationshipsAndMediaUnchanged":True,
            "textboxParagraphTextPreserved":True,"nestedPictureRelationship":saved_relationship,
            "pictureIdentityPreserved":True,"pictureFrameExtent":saved_frame,
            "pictureShapeExtent":saved_shape,"pictureCrop":saved_crop,
            "pictureAltText":saved_alt_text,"siblingShapeFill":saved_shape_fill,
            "wholeDocumentEqualAfterExpectedEdits":True}


def textbox_nested_docx(acc,row,fixtures,out):
    fixture=fixtures/"p5-tb-control-docx-original.docx"
    path=h.begin(acc,row,fixture,out,"p5-tb-control-docx-edited.docx")
    row["sourceObjects"]={"nestedPictureRgb":[140,90,40],"nestedShapeRgb":[122,71,168]}
    acc.wait("return [...document.querySelectorAll('.docx-page canvas')].some(c=>c.width>0)",timeout=15)
    acc.d.js("""
      window.p5TextboxChildPointers=[];
      document.addEventListener('pointerdown',e=>{
        if(e.target.closest('.docx-page'))window.p5TextboxChildPointers.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});
      },true);
    """)

    def select_picture(expected_width):
        selected=select_docx_textbox_color(acc,(140,90,40),"picture")
        state=selected["state"]
        h.require(float(state["width"])==expected_width and state["height"] is not None
                  and len(state["crop"])==4 and state["description"] is not None,
                  "nested picture inspector lacks the required story-owned edit fields",state)
        return selected

    selected=row["pictureSelection"]=select_picture(40)
    size_button=SIZE_FORM+" button[type=submit]"
    h.p6.fill_input(acc,WIDTH,"50");acc.dom_click(size_button);h.revision(acc,"docx",1)
    select_picture(50);acc.key("ctrl+z");h.revision(acc,"docx",2)
    select_picture(40);acc.key("ctrl+y");h.revision(acc,"docx",3)
    select_picture(50)

    crop_form=h.p6.TOOLS+" form:has(.picture-crop-fields)"
    h.p6.fill_input(acc,crop_form+" .picture-crop-fields label:first-of-type input","10")
    acc.dom_click(crop_form+" button[type=submit]");h.revision(acc,"docx",4)
    crop_state=select_picture(50)["state"]
    h.require(crop_state["crop"][0]=="10","nested picture crop was not applied",crop_state)
    acc.key("ctrl+z");h.revision(acc,"docx",5)
    crop_state=select_picture(50)["state"]
    h.require(float(crop_state["crop"][0])==0,"Undo did not restore the nested picture crop",crop_state)
    acc.key("ctrl+y");h.revision(acc,"docx",6)
    crop_state=select_picture(50)["state"]
    h.require(crop_state["crop"][0]=="10","Redo did not restore the nested picture crop",crop_state)

    alt_form=h.p6.TOOLS+' form:has(input[maxlength="1024"])'
    h.p6.fill_input(acc,DESCRIPTION,"Nested textbox picture")
    acc.dom_click(alt_form+" button[type=submit]");h.revision(acc,"docx",7)
    h.require(select_picture(50)["state"]["description"]=="Nested textbox picture",
              "nested picture alt text did not update")
    acc.key("ctrl+z");h.revision(acc,"docx",8)
    h.require(select_picture(50)["state"]["description"]=="","Undo did not restore nested picture alt text")
    acc.key("ctrl+y");h.revision(acc,"docx",9)
    h.require(select_picture(50)["state"]["description"]=="Nested textbox picture",
              "Redo did not restore nested picture alt text")

    shape=row["shapeSelection"]=select_docx_textbox_color(acc,(122,71,168),"shape")
    fill=h.p6.SHAPE+" label input[type=color]"
    h.require(shape["state"]["fill"].upper()=="#7A47A8",
              "Native hit selected a parent or sibling instead of the nested rectangle",shape)
    h.p6.color(acc,fill,"#884422");h.revision(acc,"docx",10)
    shape=select_docx_textbox_color(acc,(136,68,34),"shape")
    h.require(shape["state"]["fill"].upper()=="#884422","nested shape fill edit missed its child",shape)
    acc.key("ctrl+z");h.revision(acc,"docx",11)
    shape=select_docx_textbox_color(acc,(122,71,168),"shape")
    h.require(shape["state"]["fill"].upper()=="#7A47A8","Undo did not restore nested shape fill",shape)
    acc.key("ctrl+y");h.revision(acc,"docx",12)
    shape=select_docx_textbox_color(acc,(136,68,34),"shape")
    h.require(shape["state"]["fill"].upper()=="#884422","Redo did not restore nested shape fill",shape)
    row["trustedNativePointers"]=acc.d.js("return window.p5TextboxChildPointers.slice()")
    h.require(len(row["trustedNativePointers"])>=12
              and all(event["trusted"] is True for event in row["trustedNativePointers"]),
              "nested textbox children were not reached through trusted Native pointer input",
              row["trustedNativePointers"])

    h.publish(acc,"docx",row)
    row["savedSha256"]=h.digest(path)
    row["packageProof"]=docx_textbox_picture_proof(fixture,path)
    h.reopen(acc,path,row)
    reopened_picture=select_picture(50)
    h.require(reopened_picture["state"]["description"]=="Nested textbox picture",
              "same-session reopen lost nested picture alt text",reopened_picture)
    reopened_shape=select_docx_textbox_color(acc,(136,68,34),"shape")
    h.require(reopened_shape["state"]["fill"].upper()=="#884422",
              "same-session reopen lost nested shape fill",reopened_shape)
    row["sameSessionReopen"]={"picture":reopened_picture,"shape":reopened_shape}


def textbox_nested_docx_fresh(acc,row,fixtures,out):
    prior=json.loads((out/"result.json").read_text())
    prior_row=prior.get("cases",{}).get("P5-TB-CONTROL-DOCX",{})
    h.require(prior_row.get("status")=="PASS","fresh DOCX reopen requires a passing edit case",prior_row)
    fixture=out/"p5-tb-control-docx-edited.docx"
    path=h.begin(acc,row,fixture,out,"p5-tb-control-docx-fresh-probe.docx")
    row["expectedSavedSha256"]=prior_row.get("savedSha256")
    row["savedSha256"]=h.digest(path)
    h.require(row["savedSha256"]==row["expectedSavedSha256"],"fresh DOCX received a different saved package",row)
    h.require(row["processAppSha256"]==prior_row.get("processAppSha256")
              and row["appPid"]!=prior_row.get("appPid"),
              "fresh DOCX did not use the same Release app in a distinct process",row)
    h.require(row["initialSession"].get("dirty")=="false"
              and row["initialSession"].get("unpreserved")=="false",
              "saved DOCX reopened dirty or unpreserved in a fresh process",row["initialSession"])
    picture=select_docx_textbox_color(acc,(140,90,40),"picture")
    h.require(float(picture["state"]["width"])==50
              and picture["state"]["description"]=="Nested textbox picture"
              and picture["state"]["crop"][0]=="10",
              "fresh DOCX did not restore nested picture fields",picture)
    shape=select_docx_textbox_color(acc,(136,68,34),"shape")
    h.require(shape["state"]["fill"].upper()=="#884422",
              "fresh DOCX did not restore nested shape ownership and fill",shape)
    row["freshProcessReopen"]={"picture":picture,"shape":shape}


h.CASES = {"P5.1": stories, "P5.2": textbox, "P5.5": textbox_join,
           "P5-DX-NOTE-MOVE": note_move,
           "P5-DX-HF-MOVE": header_footer_move,
           "P5-R-HF-OBJECTS-HWP": header_shape_hwp,
           "P5-R-HF-OBJECTS-HWPX": header_shape_hwpx,
           "P5-R-HF-OBJECTS-HWP-FRESH": lambda *args: header_shape_fresh_reopen(*args, "hwp"),
           "P5-R-HF-OBJECTS-HWPX-FRESH": lambda *args: header_shape_fresh_reopen(*args, "hwpx"),
           "P5-R-HDR-HWP": header_picture_hwp,
           "P5-R-HDR-HWPX": header_picture_hwpx,
           "P5-R-HDR-HWP-FRESH": header_picture_hwp_fresh,
           "P5-R-HDR-HWPX-FRESH": header_picture_hwpx_fresh,
           "P5-R-FTR-HWP": footer_picture_hwp,
           "P5-R-FTR-HWPX": footer_picture_hwpx,
           "P5-R-FTR-HWP-FRESH": lambda *args: footer_fresh_reopen(*args, "hwp"),
           "P5-R-FTR-HWPX-FRESH": lambda *args: footer_fresh_reopen(*args, "hwpx"),
           "P5-DX-NOTE-MOVE-FRESH-REOPEN": note_move_fresh_reopen,
           "P5-DX-HF-MOVE-FRESH-REOPEN": header_footer_move_fresh_reopen,
           "P5-DX-DELETE": delete_docx_story_pictures,
           "P5-DX-DELETE-FRESH-REOPEN": delete_docx_story_pictures_fresh_reopen,
           "P5-DX-SIZE-NONCANON": resize_noncanonical_story_picture,
           "P5-TB-REPLACE": textbox_replace,
           "P5-TB-MIX": lambda *args: textbox_join(*args, span=3, mixed=True),
           "P5-TB-CONTROL-HWPX": textbox_nested_shape,
           "P5-TB-CONTROL-HWPX-FRESH": lambda *args: textbox_nested_shape_fresh(*args, "hwpx"),
           "P5-TB-CONTROL-HWP": lambda *args: textbox_nested_shape(*args, "hwp"),
           "P5-TB-CONTROL-HWP-FRESH": lambda *args: textbox_nested_shape_fresh(*args, "hwp"),
           "P5-TB-CONTROL-HWPX-PICTURE": lambda *args: textbox_nested_picture(*args, "hwpx"),
           "P5-TB-CONTROL-HWPX-PICTURE-FRESH": lambda *args: textbox_nested_picture_fresh(*args, "hwpx"),
           "P5-TB-CONTROL-HWP-PICTURE": lambda *args: textbox_nested_picture(*args, "hwp"),
           "P5-TB-CONTROL-HWP-PICTURE-FRESH": lambda *args: textbox_nested_picture_fresh(*args, "hwp"),
           "P5-TB-CONTROL-DOCX": textbox_nested_docx,
           "P5-TB-CONTROL-DOCX-FRESH": textbox_nested_docx_fresh,
           "P5-DX-STORY-SIZE": lambda *args: stories(*args, resize=True),
           "P5-TB-RANGE": lambda *args: textbox_join(*args, span=3)}

if __name__ == "__main__":
    sys.exit(h.main())
