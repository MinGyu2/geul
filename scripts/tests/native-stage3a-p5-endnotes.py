#!/usr/bin/env python3
"""P5-R-EN Linux X11 editing, T009 save and independent endnote reopen."""

import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
entry = Path(__file__).with_name("native-stage3a-p5-notes.py")
spec = importlib.util.spec_from_file_location("stage3a_p5_notes", entry)
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)
h = notes.h

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
  const allNotes=JSON.parse(doc.getNoteInventory());
  const candidate=allNotes.find(n=>n.kind==='endnote'&&n.ownerPath?.sourceType===sourceType
    &&(!wanted||(n.section===wanted.section&&n.anchorParagraph===wanted.anchorParagraph
      &&n.control===wanted.control&&n.instanceId===wanted.instanceId&&n.number===wanted.number
      &&JSON.stringify(n.ownerPath)===JSON.stringify(wanted.ownerPath))));
  if(!candidate) throw Error('requested endnote owner is not present');
  const paraIndex=candidate.editableStarts.findIndex(Number.isSafeInteger);
  if(paraIndex<0) throw Error('endnote has no supported plain-text paragraph');
  const editRaw=candidate.ownerPath.sourceType==='body'
    ? doc.getNoteEditInfo(candidate.section,candidate.anchorParagraph,candidate.control)
    : doc.getEndnoteEditInfo(candidate.section,candidate.anchorParagraph,candidate.control,
        JSON.stringify(candidate.ownerPath));
  const edit=JSON.parse(editRaw);
  if(edit.ok!==true||edit.kind!=='endnote'||edit.virtualParaIndex<doc.getParagraphCount(candidate.section)
      ||JSON.stringify(edit.ownerPath||candidate.ownerPath)!==JSON.stringify(candidate.ownerPath))
    throw Error('endnote virtual paragraph is outside its body section');
  const first=JSON.parse(doc.getEndnoteHitInfo(candidate.section,edit.virtualParaIndex,0,edit.pageNum));
  if(first.hit!==true||first.kind!=='endnote'||first.instanceId!==candidate.instanceId
      ||first.number!==candidate.number||JSON.stringify(first.ownerPath)!==JSON.stringify(candidate.ownerPath))
    throw Error('rendered endnote resolves to a different owner');
  const text=Array.from(candidate.texts[paraIndex]||'');
  const start=candidate.editableStarts[paraIndex];
  const offset=Math.max(start,Math.min(text.length-1,Math.floor((start+text.length)/2)));
  const renderOffset=paraIndex===0
    ? first.renderPrefixLength+offset-first.sourceLeadingSpaces : offset;
  const address=JSON.parse(doc.getEndnoteHitInfo(candidate.section,edit.virtualParaIndex,renderOffset,edit.pageNum));
  if(address.noteOffset!==offset) throw Error('rendered hit did not map to the note-local character offset');
  const exact=JSON.parse(doc.getNoteInfo('endnote',candidate.section,candidate.anchorParagraph,
    candidate.control,JSON.stringify(candidate.ownerPath)));
  if(exact.instanceId!==candidate.instanceId||exact.number!==candidate.number)
    throw Error('exact note API returned a stale or wrong note identity');
  const cursor=JSON.parse(candidate.ownerPath.sourceType==='body'
    ? doc.getCursorRectInNote(candidate.section,candidate.anchorParagraph,candidate.control,paraIndex,offset)
    : doc.getCursorRectInOwnedEndnote(candidate.section,candidate.anchorParagraph,candidate.control,
        JSON.stringify(candidate.ownerPath),paraIndex,offset));
  if(cursor.pageIndex!==address.viewPage) throw Error('endnote cursor page differs from rendered owner page');
  let bodyAliasRejected=false;
  try { doc.getEndnoteHitInfo(candidate.section,0,0,address.viewPage); }
  catch { bodyAliasRejected=true; }
  if(!bodyAliasRejected) throw Error('body paragraph index was accepted as an endnote hit');
  const body=Array.from({length:doc.getSectionCount()},(_,s)=>
    Array.from({length:doc.getParagraphCount(s)},(_,p)=>
      doc.getTextRange(s,p,0,doc.getParagraphLength(s,p))));
  console.log(JSON.stringify({generation:release.generation,notes:allNotes,body,
    controls:JSON.parse(doc.getControls()),target:candidate,paraIndex,offset,
    address:{...address,pageNum:address.viewPage},cursor}));
} finally { doc.free(); }
"""


def state(path, source_type, wanted=None):
    wanted_json = json.dumps(wanted, ensure_ascii=False, separators=(",", ":")) if wanted else ""
    raw = subprocess.check_output(
        ["node", "-e", STATE_ORACLE, str(path), source_type, wanted_json], cwd=ROOT, text=True,
    )
    return json.loads(raw)


def exact_endnote_owner(status, note, para_index):
    prefix = (f'{note["section"]}:note:endnote:{note["section"]}/'
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


def hwp5_record_proof(source, saved, target):
    gso = notes.h.p6.gso
    before = gso.cfb_streams(source.read_bytes())
    after = gso.cfb_streams(saved.read_bytes())
    notes.h.require(before.keys() == after.keys(), "endnote edit changed HWP5 CFB stream inventory")
    before_info = gso.unpacked(before, "DocInfo")
    after_info = gso.unpacked(after, "DocInfo")
    notes.h.require(before_info == after_info,
                    "endnote edit changed decompressed HWP5 DocInfo")
    info_before = gso.records(before_info)
    info_after = gso.records(after_info)
    notes.h.require(info_before == info_after,
                    "endnote edit changed a HWP5 DocInfo record")

    stream_name = "BodyText/Section0"
    body_before = gso.records(gso.unpacked(before, stream_name))
    body_after = gso.records(gso.unpacked(after, stream_name))
    notes.h.require(len(body_before) == len(body_after)
                    and all(old[:2] == new[:2] for old, new in zip(body_before, body_after)),
                    "endnote edit changed HWP5 body record topology")
    changed = [index for index, (old, new) in enumerate(zip(body_before, body_after))
               if old != new]
    notes.h.require(len(changed) == 2 and changed[1] == changed[0] + 1,
                    "endnote edit changed records outside its one PARA_HEADER/PARA_TEXT pair", changed)
    para_header, para_text = (body_before[index] for index in changed)
    saved_header, saved_text = (body_after[index] for index in changed)
    notes.h.require((para_header[0], para_text[0]) == (66, 67),
                    "endnote edit changed records other than PARA_HEADER/PARA_TEXT",
                    [para_header[:2], para_text[:2]])
    owner_path = target["ownerPath"]
    if owner_path.get("sourceType") == "table":
        expected_levels = ((66, 4), (67, 5))
        notes.h.require((para_header[:2], para_text[:2]) == expected_levels,
                        "table-owned endnote paragraph moved outside its nested record levels",
                        [para_header[:2], para_text[:2]])
        control_header, list_header = (body_before[index] for index in (changed[0] - 2, changed[0] - 1))
        notes.h.require(control_header[:2] == (71, 3)
                        and control_header[2][:4] == b"  ne"
                        and int.from_bytes(control_header[2][4:8], "little") == target["number"],
                        "changed table paragraph is not inside the exact source endnote control",
                        {"control": control_header[:2], "payload": control_header[2].hex(),
                         "expectedNumber": target["number"]})
        notes.h.require(list_header[:2] == (72, 4),
                        "table-owned endnote no longer has its original paragraph-list owner",
                        {"listHeader": list_header[:2], "payload": list_header[2].hex()})
    else:
        notes.h.require(owner_path == {"sourceType": "body"},
                        "unsupported HWP5 endnote owner path reached the direct-body proof", owner_path)
        notes.h.require((para_header[:2], para_text[:2]) == ((66, 2), (67, 3)),
                        "body-owned endnote paragraph moved outside its expected record levels",
                        [para_header[:2], para_text[:2]])
        control_header, list_header = (body_before[index] for index in (changed[0] - 2, changed[0] - 1))
        notes.h.require(control_header[:2] == (71, 1)
                        and control_header[2][:4] == b"  ne"
                        and int.from_bytes(control_header[2][4:8], "little") == target["number"],
                        "changed body paragraph is not inside the exact source endnote control",
                        {"control": control_header[:2], "payload": control_header[2].hex(),
                         "expectedNumber": target["number"]})
        notes.h.require(list_header[:2] == (72, 2),
                        "body endnote no longer has its original paragraph-list owner",
                        {"listHeader": list_header[:2], "payload": list_header[2].hex()})
    old_length = int.from_bytes(para_header[2][:4], "little")
    new_length = int.from_bytes(saved_header[2][:4], "little")
    notes.h.require(new_length == old_length + 1 and para_header[2][4:] == saved_header[2][4:],
                    "endnote PARA_HEADER changed fields beyond its one-character text length")
    expected_text = para_text[2][:-2] + "z".encode("utf-16-le") + para_text[2][-2:]
    notes.h.require(saved_text[2] == expected_text,
                    "endnote PARA_TEXT changed outside the typed final character")
    return {
        "streamInventoryPreserved": True,
        "decompressedDocInfoByteIdentical": True,
        "docInfoRecordCount": len(info_before),
        "docInfoSha256": hashlib.sha256(before_info).hexdigest(),
        "bodyRecordCount": len(body_before),
        "ownerPath": owner_path,
        "endnoteRecordNesting": {
            "controlHeader": {"tag": control_header[0], "level": control_header[1]},
            "listHeader": {"tag": list_header[0], "level": list_header[1]},
            "paragraphHeader": {"tag": para_header[0], "level": para_header[1]},
            "paragraphText": {"tag": para_text[0], "level": para_text[1]},
        },
        "changedRecords": [
            {"index": changed[0], "tag": para_header[0], "level": para_header[1],
             "sourceLength": len(para_header[2]), "savedLength": len(saved_header[2]),
             "sourceTextLength": old_length, "savedTextLength": new_length},
            {"index": changed[1], "tag": para_text[0], "level": para_text[1],
             "sourceLength": len(para_text[2]), "savedLength": len(saved_text[2]),
             "insertedUtf16Le": "7a00"},
        ],
        "allOtherBodyRecordsByteIdentical": True,
    }


# Reuse the already-reviewed P5-R-FN transaction/save/reopen sequence while swapping
# its fixture oracle and owner predicate for exact endnote identity.
notes.state = state
notes.exact_note_owner = exact_endnote_owner


def hwp_body(acc, row, fixtures, out):
    notes.edit_note(acc, row, fixtures, out, "hwp", "body",
                    "endnote-body.hwp", "p5-r-en-hwp-body.hwp")
    row["cfbRecordProof"] = hwp5_record_proof(
        fixtures / "endnote-body.hwp", out / "p5-r-en-hwp-body.hwp", row["before"]["target"])


def hwp_body_fresh(acc, row, fixtures, out):
    notes.fresh_note(acc, row, fixtures, out, "hwp", "body",
                     "p5-r-en-hwp-body.hwp", "p5-r-en-hwp-body-fresh.hwp")


def hwpx_body(acc, row, fixtures, out):
    notes.edit_note(acc, row, fixtures, out, "hwpx", "body",
                    "hwpx/endnote-body.hwpx", "p5-r-en-hwpx-body.hwpx")


def hwpx_body_fresh(acc, row, fixtures, out):
    notes.fresh_note(acc, row, fixtures, out, "hwpx", "body",
                     "p5-r-en-hwpx-body.hwpx", "p5-r-en-hwpx-body-fresh.hwpx")




def hwp_table(acc, row, fixtures, out):
    notes.edit_note(acc, row, fixtures, out, "hwp", "table",
                    "endnote-body.hwp", "p5-r-en-hwp-table.hwp")
    row["cfbRecordProof"] = hwp5_record_proof(
        fixtures / "endnote-body.hwp", out / "p5-r-en-hwp-table.hwp", row["before"]["target"])


def hwp_table_fresh(acc, row, fixtures, out):
    notes.fresh_note(acc, row, fixtures, out, "hwp", "table",
                     "p5-r-en-hwp-table.hwp", "p5-r-en-hwp-table-fresh.hwp")


def hwpx_table(acc, row, fixtures, out):
    notes.edit_note(acc, row, fixtures, out, "hwpx", "table",
                    "hwpx/endnote-body.hwpx", "p5-r-en-hwpx-table.hwpx")


def hwpx_table_fresh(acc, row, fixtures, out):
    notes.fresh_note(acc, row, fixtures, out, "hwpx", "table",
                     "p5-r-en-hwpx-table.hwpx", "p5-r-en-hwpx-table-fresh.hwpx")

h.CASES.update({
    "P5-R-EN-HWP-BODY": hwp_body,
    "P5-R-EN-HWP-BODY-FRESH": hwp_body_fresh,
    "P5-R-EN-HWP-TABLE": hwp_table,
    "P5-R-EN-HWP-TABLE-FRESH": hwp_table_fresh,
    "P5-R-EN-HWPX-BODY": hwpx_body,
    "P5-R-EN-HWPX-BODY-FRESH": hwpx_body_fresh,
    "P5-R-EN-HWPX-TABLE": hwpx_table,
    "P5-R-EN-HWPX-TABLE-FRESH": hwpx_table_fresh,
})


if __name__ == "__main__":
    raise SystemExit(h.main())
