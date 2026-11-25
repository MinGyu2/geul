#!/usr/bin/env python3
"""P5-R-FN real Linux X11 editing, safe save and fresh-process reopen."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import struct
import zipfile
import zlib
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
entry = Path(__file__).with_name("native-stage3a-p5.py")
spec = importlib.util.spec_from_file_location("stage3a_p5", entry)
p5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p5)
h = p5.h

STATE_ORACLE = r"""
const fs=require('fs'),path=require('path');
const root=path.resolve(process.env.GEUL_RHWP_TEST_ARTIFACTS||'public/rhwp');
const release=JSON.parse(fs.readFileSync(path.join(root,'RELEASE.json')));
const folder=path.join(root,'generations',release.generation);
const rhwp=require(path.join(folder,'rhwp.js'));
rhwp.initSync({module:fs.readFileSync(path.join(folder,'rhwp_bg.wasm'))});
const doc=new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
try {
  const sourceType=process.argv[2], wanted=process.argv[3]?JSON.parse(process.argv[3]):null;
  const notes=JSON.parse(doc.getNoteInventory());
  const note=notes.find(n=>n.kind==='footnote'&&n.ownerPath?.sourceType===sourceType
    &&(!wanted||(n.section===wanted.section&&n.anchorParagraph===wanted.anchorParagraph
      &&n.control===wanted.control&&n.instanceId===wanted.instanceId&&n.number===wanted.number
      &&JSON.stringify(n.ownerPath)===JSON.stringify(wanted.ownerPath))));
  if(!note) throw Error('requested authentic note owner is not present');
  const paraIndex=note.editableStarts.findIndex(Number.isSafeInteger);
  if(paraIndex<0) throw Error('authentic note has no supported plain-text paragraph');
  const text=Array.from(note.texts[paraIndex]||'');
  const start=note.editableStarts[paraIndex];
  const offset=Math.max(start,Math.min(text.length-1,Math.floor((start+text.length)/2)));
  const address=JSON.parse(doc.getFootnoteViewAddress(note.section,note.anchorParagraph,note.control,
    note.instanceId,note.number,paraIndex,offset,0,JSON.stringify(note.ownerPath)));
  if(address.ok!==true) throw Error('exact note view address is unavailable');
  const cursor=JSON.parse(doc.getCursorRectInFootnote(address.pageNum,address.footnoteIndex,paraIndex,offset));
  const sections=Array.from({length:doc.getSectionCount()},(_,s)=>
    Array.from({length:doc.getParagraphCount(s)},(_,p)=>
      doc.getTextRange(s,p,0,doc.getParagraphLength(s,p))));
  console.log(JSON.stringify({generation:release.generation,notes,body:sections,
    controls:JSON.parse(doc.getControls()),target:note,paraIndex,offset,address,cursor}));
} finally { doc.free(); }
"""


def state(path, source_type, wanted=None):
    wanted_json = json.dumps(wanted, ensure_ascii=False, separators=(",", ":")) if wanted else ""
    raw = subprocess.check_output(
        ["node", "-e", STATE_ORACLE, str(path), source_type, wanted_json],
        cwd=ROOT, text=True,
    )
    return json.loads(raw)


def exact_note_owner(status, note, para_index):
    prefix = (f'{note["section"]}:note:footnote:{note["section"]}/'
              f'{note["anchorParagraph"]}/{note["control"]}/')
    marker = f'/{note["instanceId"]}/{note["number"]}:{para_index}:'
    caret = status["caret"]
    if not caret.startswith(prefix):
        return False
    encoded_path, separator, _ = caret[len(prefix):].rpartition(marker)
    if not separator:
        return False
    try:
        return json.loads(encoded_path) == note["ownerPath"]
    except (TypeError, ValueError):
        return False


def click_note(acc, fmt, model):
    cursor = model["cursor"]
    page = model["address"]["pageNum"]
    event_offset = acc.d.js("return window.p5FootnoteEvents?.length ?? 0")
    geometry = acc.d.js("""
      const [page,x,y,cursorHeight]=arguments[0], canvas=document.querySelectorAll('.rhwp-page__canvas')[page];
      const scroll=document.querySelector('.editor__scroll'), r=canvas.getBoundingClientRect(), v=scroll.getBoundingClientRect();
      const k=r.width/canvas.clientWidth, delta=r.top+y*k-(v.top+v.height/2);
      return {pageRect:{x:r.x,y:r.y,width:r.width,height:r.height},canvas:{width:canvas.width,height:canvas.height,
        clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight,styleWidth:canvas.style.width,
        styleHeight:canvas.style.height,scaleFromBitmap:canvas.width?parseFloat(canvas.style.width)/canvas.width*(window.devicePixelRatio||1):null},
        scrollRect:{x:v.x,y:v.y,width:v.width,height:v.height},scrollTop:scroll.scrollTop,
        pointerScale:k,predictedScreen:[r.left+(x+1)*k,r.top-delta+(y+cursorHeight/2)*k]};
    """, [page, cursor["x"], cursor["y"], cursor["height"]])
    acc.d.js("""
      window.p5FootnoteEvents=window.p5FootnoteEvents||[];
      if(!window.p5FootnoteCanvasCaptureInstalled){
        for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
          const pages=[...document.querySelectorAll('.rhwp-page__canvas')];
          const canvas=pages.find(c=>c===e.target||c.contains(e.target)||c.parentElement===e.target);
          if(!canvas)return;
          const r=canvas.getBoundingClientRect();
          window.p5FootnoteEvents.push({type,trusted:e.isTrusted,page:pages.indexOf(canvas),x:e.clientX,y:e.clientY,
            localCss:[e.clientX-r.left,e.clientY-r.top],canvas:{width:canvas.width,height:canvas.height,
            clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight,styleWidth:canvas.style.width,
            scaleFromBitmap:canvas.width?parseFloat(canvas.style.width)/canvas.width*(window.devicePixelRatio||1):null},
            target:e.target.tagName+'.'+String(e.target.className||'')});
        },true);
        window.p5FootnoteCanvasCaptureInstalled=true;
      }
    """)
    h.p6.pointer(acc, (page, cursor["x"] + 1, cursor["y"] + cursor["height"] / 2))
    status = acc.status(fmt)
    events = acc.d.js("return (window.p5FootnoteEvents || []).slice(arguments[0])", event_offset)
    h.require(exact_note_owner(status, model["target"], model["paraIndex"]),
              "native pointer did not enter the exact note owner",
              {"status": status, "pageGeometry": geometry, "pointerEvents": events})
    trusted = [(e["type"], e["trusted"]) for e in events
               if e["type"] in ("pointerdown", "pointerup") and e.get("page") == page]
    h.require(trusted[-2:] == [("pointerdown", True), ("pointerup", True)],
              "note selection did not use trusted native pointer input", events)
    return {"status": status, "events": events, "pageGeometry": geometry, "page": page, "cursor": cursor}


def expected_notes(before, target, para_index):
    result = copy.deepcopy(before["notes"])
    matches = [n for n in result if n["section"] == target["section"]
               and n["anchorParagraph"] == target["anchorParagraph"]
               and n["control"] == target["control"]
               and n["instanceId"] == target["instanceId"]
               and n["number"] == target["number"]
               and n["ownerPath"] == target["ownerPath"]]
    h.require(len(matches) == 1, "note inventory owner is ambiguous", matches)
    original = matches[0]["texts"][para_index]
    matches[0]["texts"][para_index] = original + "z"
    matches[0]["totalTextLen"] += 1
    return result


def note_canvas_proof(acc, model):
    cursor = model["cursor"]
    capture = acc.d.js("""
      const [page,y,height]=arguments[0],canvas=document.querySelectorAll('.rhwp-page__canvas')[page];
      if(!canvas||!canvas.width||!canvas.height)return null;
      const top=Math.max(0,Math.floor(y)-32),bottom=Math.min(canvas.height,Math.ceil(y+height)+32);
      const lineTop=Math.max(0,Math.floor(y)-6),lineBottom=Math.min(canvas.height,Math.ceil(y+height)+6);
      const pixels=canvas.getContext('2d').getImageData(0,lineTop,canvas.width,lineBottom-lineTop).data;
      let inkPixels=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]>0&&(pixels[i]<220||pixels[i+1]<220||pixels[i+2]<220))inkPixels++;
      const crop=document.createElement('canvas');crop.width=canvas.width;crop.height=bottom-top;
      crop.getContext('2d').drawImage(canvas,0,top,canvas.width,bottom-top,0,0,canvas.width,bottom-top);
      return {page,top,bottom,inkPixels,dataUrl:crop.toDataURL('image/png')};
    """, [model["address"]["pageNum"], cursor["y"], cursor["height"]])
    h.require(capture and capture["inkPixels"] > 0,
              "note text is not visible at its independently resolved page position", capture)
    return {"page": capture["page"], "top": capture["top"], "bottom": capture["bottom"],
            "inkPixels": capture["inkPixels"],
            "sha256": hashlib.sha256(capture["dataUrl"].encode()).hexdigest()}


def canonical_xml(data):
    return ET.canonicalize(data.decode("utf-8"), with_comments=True)


def canonical_manifest(data):
    root = ET.fromstring(data)
    matches = [node for node in root.iter()
               if node.tag.rsplit("}", 1)[-1] == "meta"
               and node.get("name") == "ModifiedDate"]
    h.require(len(matches) == 1, "OPF manifest ModifiedDate is absent or ambiguous")
    matches[0].text = "GEUL_SERIALIZER_MODIFIED_DATE"
    return ET.canonicalize(ET.tostring(root, encoding="unicode"), with_comments=True)


def png_proof(data):
    h.require(data.startswith(b"\x89PNG\r\n\x1a\n"), "refreshed preview is not a PNG")
    offset = 8
    chunks = []
    dimensions = None
    saw_idat = False
    while offset < len(data):
        h.require(len(data) - offset >= 12, "truncated PNG chunk header", offset)
        size = struct.unpack_from(">I", data, offset)[0]
        end = offset + 12 + size
        h.require(end <= len(data), "truncated PNG chunk", offset)
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + size]
        expected_crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        h.require((zlib.crc32(kind + payload) & 0xffffffff) == expected_crc,
                  "preview PNG chunk CRC differs", kind.decode("ascii", errors="replace"))
        if not chunks:
            h.require(kind == b"IHDR" and size == 13, "preview PNG has no canonical IHDR")
            dimensions = struct.unpack_from(">II", payload)
            h.require(all(1 <= value <= 1024 for value in dimensions),
                      "preview PNG dimensions are unsupported", dimensions)
        if kind == b"IDAT":
            saw_idat = True
        chunks.append(kind.decode("ascii", errors="replace"))
        offset = end
        if kind == b"IEND":
            h.require(size == 0 and offset == len(data), "preview PNG has trailing data")
            break
    h.require(chunks[-1:] == ["IEND"] and saw_idat, "preview PNG is incomplete", chunks)
    return {"sha256": hashlib.sha256(data).hexdigest(),
            "width": dimensions[0], "height": dimensions[1], "chunks": chunks}


def package_proof(source, saved, fmt, section):
    if fmt == "hwp":
        before = h.p6.gso.cfb_streams(source.read_bytes())
        after = h.p6.gso.cfb_streams(saved.read_bytes())
        h.require(before.keys() == after.keys(), "HWP5 CFB stream inventory changed")
        target = f"BodyText/Section{section}"
        h.require(target in before, "edited HWP5 body stream is missing", target)
        changed, previews = [], {}
        for name in before:
            if before[name] == after[name]:
                continue
            changed.append(name)
            if name in (target, "DocInfo"):
                continue
            if name == "PrvText":
                h.require(after[name] == before[name],
                          "footnote-only edit changed top-level HWP5 text preview")
                continue
            if name == "PrvImage":
                proof = png_proof(after[name])
                source_preview = png_proof(before[name]) if before[name].startswith(b"\x89PNG\r\n\x1a\n") else None
                h.require(source_preview is None or (proof["width"], proof["height"])
                          == (source_preview["width"], source_preview["height"]),
                          "refreshed HWP5 preview geometry changed")
                previews[name] = {"source": hashlib.sha256(before[name]).hexdigest(), "saved": proof}
                continue
            h.require(False, "unrelated HWP5 CFB stream changed", name)
        return {"streamCount": len(before), "changedStreams": changed,
                "previewProof": previews,
                "sourceStreamSha256": {n: hashlib.sha256(v).hexdigest() for n, v in before.items()},
                "savedStreamSha256": {n: hashlib.sha256(v).hexdigest() for n, v in after.items()}}

    with zipfile.ZipFile(source) as package:
        before = {name: package.read(name) for name in package.namelist()}
    with zipfile.ZipFile(saved) as package:
        after = {name: package.read(name) for name in package.namelist()}
    h.require(before.keys() == after.keys(), "HWPX OPC part inventory changed")
    target = f"Contents/section{section}.xml"
    h.require(target in before, "edited HWPX section is missing", target)
    canonical_equal, changed, previews = [], [], {}
    for name, source_bytes in before.items():
        output_bytes = after[name]
        if source_bytes == output_bytes:
            continue
        changed.append(name)
        if name == target:
            continue
        if name == "Preview/PrvText.txt":
            h.require(output_bytes == b"\r\n",
                      "stale HWPX preview text was not replaced by the known safe placeholder")
            previews[name] = {"sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
                              "saved": "known-content-independent-CRLF"}
            continue
        if name == "Preview/PrvImage.png":
            proof = png_proof(output_bytes)
            source_proof = png_proof(source_bytes)
            h.require((proof["width"], proof["height"])
                      == (source_proof["width"], source_proof["height"]),
                      "refreshed HWPX preview geometry changed")
            previews[name] = {"sourceSha256": hashlib.sha256(source_bytes).hexdigest(), "saved": proof}
            continue
        if name == "Contents/content.hpf":
            h.require(canonical_manifest(source_bytes) == canonical_manifest(output_bytes),
                      "OPF manifest changed outside ModifiedDate", name)
        elif name.endswith(".xml"):
            h.require(canonical_xml(source_bytes) == canonical_xml(output_bytes),
                      "unrelated HWPX XML changed semantically", name)
        else:
            h.require(False, "unrelated HWPX binary part changed", name)
        canonical_equal.append(name)
    return {"partCount": len(before), "changedParts": changed,
            "semanticallyEqualXmlParts": canonical_equal,
            "previewProof": previews,
            "sourcePartSha256": {n: hashlib.sha256(v).hexdigest() for n, v in before.items()},
            "savedPartSha256": {n: hashlib.sha256(v).hexdigest() for n, v in after.items()}}


def edit_note(acc, row, fixtures, out, fmt, source_type, fixture_name, saved_name):
    fixture = fixtures / fixture_name
    before = state(fixture, source_type)
    row["before"] = before
    path = h.begin(acc, row, fixture, out, saved_name)
    h.require(row["initialSession"].get("dirty") == "false"
              and row["initialSession"].get("unpreserved") == "false",
              "authentic source did not open cleanly", row["initialSession"])
    h.require(row["activeGeneration"] == before["generation"],
              "Native application and independent RHWP oracle differ")

    acc.d.js("""
      window.p5FootnoteEvents=[];
      for(const type of ['pointerdown','pointerup','keydown','beforeinput']) {
        document.addEventListener(type,e=>{
          if(type==='pointerdown'||type==='pointerup'||e.key?.toLowerCase()==='z'||e.data==='z')
            window.p5FootnoteEvents.push({type,trusted:e.isTrusted,key:e.key||'',data:e.data||''});
        },true);
      }
    """)
    row["noteCaret"] = click_note(acc, fmt, before)
    # Selecting an offscreen note changes which lazy page canvases are painted.
    # Capture the undo baseline only after the target page is visible and stable.
    row["sourceCanvasSha256"] = p5.canvas_hashes(acc)
    row["sourceNoteCanvas"] = note_canvas_proof(acc, before)
    acc.key("End")
    at_end = acc.status(fmt)
    h.require(exact_note_owner(at_end, before["target"], before["paraIndex"]),
              "End moved the caret out of its note owner", at_end)
    acc.type("z")
    h.revision(acc, fmt, 1)
    typed_events = acc.d.js("return window.p5FootnoteEvents || []")
    h.require(any(e["type"] == "keydown" and e["key"].lower() == "z" and e["trusted"]
                  for e in typed_events), "note text was not entered by trusted X11 keyboard input", typed_events)
    row["typedCanvasSha256"] = p5.canvas_hashes(acc)
    h.require(row["typedCanvasSha256"] != row["sourceCanvasSha256"],
              "typing did not change the rendered note")

    acc.key("ctrl+z")
    h.revision(acc, fmt, 2)
    row["undoCanvasSha256"] = p5.canvas_hashes(acc)
    h.require(row["undoCanvasSha256"] == row["sourceCanvasSha256"],
              "note Undo did not restore the original rendering", row["undoCanvasSha256"])
    acc.key("ctrl+y")
    h.revision(acc, fmt, 3)
    row["redoCanvasSha256"] = p5.canvas_hashes(acc)
    row["redoNoteCanvas"] = note_canvas_proof(acc, before)
    h.require(row["redoNoteCanvas"]["sha256"] != row["sourceNoteCanvas"]["sha256"],
              "typing did not change the rendered note text", row["redoNoteCanvas"])
    h.require(row["redoCanvasSha256"] == row["typedCanvasSha256"],
              "note Redo did not restore the edited rendering", row["redoCanvasSha256"])
    row["undoRedo"] = {"source": row["sourceCanvasSha256"],
                       "typed": row["typedCanvasSha256"],
                       "undo": row["undoCanvasSha256"],
                       "redo": row["redoCanvasSha256"]}

    h.publish(acc, fmt, row)
    saved_state = state(path, source_type, before["target"])
    expected = expected_notes(before, before["target"], before["paraIndex"])
    h.require(saved_state["notes"] == expected,
              "saved note identity, numbering, owner or unrelated note state changed",
              saved_state["notes"])
    h.require(saved_state["body"] == before["body"],
              "note edit changed body paragraphs", saved_state["body"])
    h.require(saved_state["controls"] == before["controls"],
              "note edit changed unrelated controls or anchor ownership")
    row["savedState"] = saved_state
    row["packageProof"] = package_proof(fixture, path, fmt, before["target"]["section"])
    row["savedSha256"] = h.digest(path)
    expected_path = out / f"{saved_name}.expected.json"
    expected_record = {"format": fmt, "sourceType": source_type, "savedName": saved_name,
                       "sourceSha256": h.digest(fixture), "savedSha256": row["savedSha256"],
                       "appPid": row["appPid"], "appSha256": row["processAppSha256"],
                       "target": before["target"], "paraIndex": before["paraIndex"],
                       "notes": expected, "body": before["body"], "controls": before["controls"],
                       "canvas": row["redoCanvasSha256"],
                       "noteCanvas": row["redoNoteCanvas"], "generation": before["generation"]}
    expected_path.write_text(json.dumps(expected_record, ensure_ascii=False, indent=2) + "\n")
    row["expectedRecordSha256"] = h.digest(expected_path)

    h.reopen(acc, path, row)
    reopened = state(path, source_type, before["target"])
    h.require(reopened["notes"] == expected and reopened["body"] == before["body"]
              and reopened["controls"] == before["controls"],
              "same-process save/reopen changed note ownership or document content")
    row["reopenedNoteCaret"] = click_note(acc, fmt, reopened)
    row["sameProcessReopenCanvasSha256"] = p5.canvas_hashes(acc)
    row["sameProcessReopenNoteCanvas"] = note_canvas_proof(acc, reopened)
    h.require(row["sameProcessReopenNoteCanvas"]["sha256"] == row["redoNoteCanvas"]["sha256"],
              "same-process reopened note text or placement changed", row["sameProcessReopenNoteCanvas"])
    row["sameProcessReopenSha256"] = h.digest(path)


def fresh_note(acc, row, fixtures, out, fmt, source_type, saved_name, fresh_name):
    expected_path = out / f"{saved_name}.expected.json"
    expected = json.loads(expected_path.read_text())
    saved = out / saved_name
    h.require(h.digest(saved) == expected["savedSha256"],
              "fresh process input differs from the saved acceptance package")
    h.require(row["appPid"] != expected["appPid"]
              and row["processAppSha256"] == expected["appSha256"],
              "fresh reopen did not use a distinct process and the same application binary")
    path = h.begin(acc, row, saved, out, fresh_name)
    h.require(row["initialSession"].get("dirty") == "false"
              and row["initialSession"].get("unpreserved") == "false",
              "saved note package opened dirty or unpreserved", row["initialSession"])
    current = state(path, source_type, expected["target"])
    h.require(current["generation"] == expected["generation"]
              and current["notes"] == expected["notes"]
              and current["body"] == expected["body"]
              and current["controls"] == expected["controls"],
              "fresh process reopened a different note or document model")
    row["freshNoteCaret"] = click_note(acc, fmt, current)
    row["freshCanvasSha256"] = p5.canvas_hashes(acc)
    row["freshNoteCanvas"] = note_canvas_proof(acc, current)
    h.require(row["freshNoteCanvas"]["sha256"] == expected["noteCanvas"]["sha256"],
              "fresh process rendered a different saved note position or text", row["freshNoteCanvas"])
    row["freshProcessInputSha256"] = h.digest(saved)


def hwp_body(acc, row, fixtures, out):
    edit_note(acc, row, fixtures, out, "hwp", "body", "footnote-01.hwp", "p5-r-fn-hwp-body.hwp")


def hwp_body_fresh(acc, row, fixtures, out):
    fresh_note(acc, row, fixtures, out, "hwp", "body",
               "p5-r-fn-hwp-body.hwp", "p5-r-fn-hwp-body-fresh.hwp")


def hwpx_table(acc, row, fixtures, out):
    edit_note(acc, row, fixtures, out, "hwpx", "table",
              "hwpx/footnote-01.hwpx", "p5-r-fn-hwpx-table.hwpx")


def hwpx_table_fresh(acc, row, fixtures, out):
    fresh_note(acc, row, fixtures, out, "hwpx", "table",
               "p5-r-fn-hwpx-table.hwpx", "p5-r-fn-hwpx-table-fresh.hwpx")


def hwpx_textbox(acc, row, fixtures, out):
    edit_note(acc, row, fixtures, out, "hwpx", "shape",
              "hwpx/footnote-tbox-01.hwpx", "p5-r-fn-hwpx-textbox.hwpx")


def hwpx_textbox_fresh(acc, row, fixtures, out):
    fresh_note(acc, row, fixtures, out, "hwpx", "shape",
               "p5-r-fn-hwpx-textbox.hwpx", "p5-r-fn-hwpx-textbox-fresh.hwpx")


h.CASES.update({
    "P5-R-FN-HWP-BODY": hwp_body,
    "P5-R-FN-HWP-BODY-FRESH": hwp_body_fresh,
    "P5-R-FN-HWPX-TABLE": hwpx_table,
    "P5-R-FN-HWPX-TABLE-FRESH": hwpx_table_fresh,
    "P5-R-FN-HWPX-TEXTBOX": hwpx_textbox,
    "P5-R-FN-HWPX-TEXTBOX-FRESH": hwpx_textbox_fresh,
})


if __name__ == "__main__":
    raise SystemExit(h.main())
