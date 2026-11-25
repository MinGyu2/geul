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
    images = acc.d.js("return [...document.querySelectorAll('.rhwp-page__canvas')].map(c=>c.toDataURL())")
    h.require(images, "rendered page canvas is unavailable")
    return [hashlib.sha256(image.encode()).hexdigest() for image in images]


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



h.CASES = {"P5.1": stories, "P5.2": textbox, "P5.5": textbox_join,
           "P5-DX-NOTE-MOVE": note_move,
           "P5-DX-HF-MOVE": header_footer_move,
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
           "P5-DX-STORY-SIZE": lambda *args: stories(*args, resize=True),
           "P5-TB-RANGE": lambda *args: textbox_join(*args, span=3)}

if __name__ == "__main__":
    sys.exit(h.main())
