#!/usr/bin/env python3
"""Focused native HWP5 group-caption text, save, and fresh-process acceptance."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / "scripts/tests"
sys.path.insert(0, str(TESTS))
from hwp_record_diff import cfb_streams, records, unpacked

spec = importlib.util.spec_from_file_location("stage3a_p6", TESTS / "native-stage3a-p6.py")
p6_native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p6_native)
h = p6_native.h
p5_spec = importlib.util.spec_from_file_location("stage3a_p5", TESTS / "native-stage3a-p5.py")
p5_native = importlib.util.module_from_spec(p5_spec)
p5_spec.loader.exec_module(p5_native)

APP = ROOT / "src-tauri/target/release/geul"
OBSERVED = {}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def group_model(path):
    fragment = r"""
      const group=pages.flatMap((page,i)=>page.filter(c=>c.type==='group').map(c=>({...c,page:i})))
        .find(c=>c.secIdx===0&&c.paraIdx===0);
      if(!group) throw Error('missing root HWP5 group');
      const props=JSON.parse(doc.getShapeProperties(group.secIdx,group.paraIdx,group.controlIdx));
      if(props.shapeType!=='group'||!props.hasCaption) throw Error('group does not own a caption');
      const at=[group.secIdx,group.paraIdx,group.controlIdx,65534,0];
      const count=doc.getCellParagraphCount(group.secIdx,group.paraIdx,group.controlIdx,65534);
      if(count!==1) throw Error('expected one group-caption paragraph');
      const length=doc.getCellParagraphLength(...at);
      const caption={count,length,text:doc.getTextInCell(...at,0,length),caret:JSON.parse(doc.getCursorRectInCell(...at,length))};
      const groupChildren=doc.getEditableGroupChildren?.(group.secIdx,group.paraIdx,group.controlIdx)??null;
      console.log(JSON.stringify({group,props,caption,groupChildren,body,controls}));
    """
    return h.inspect_rhwp(path, fragment)


def record_evidence(before_path, after_path):
    before_streams, after_streams = [cfb_streams(Path(p).read_bytes()) for p in (before_path, after_path)]
    if before_streams["FileHeader"][:16] != after_streams["FileHeader"][:16]:
        raise AssertionError("HWP format identity changed")
    names_before, names_after = set(before_streams), set(after_streams)
    if names_before != names_after:
        raise AssertionError(f"CFB stream names changed: {sorted(names_before ^ names_after)}")
    changed_streams = [name for name in sorted(names_before) if before_streams[name] != after_streams[name]]
    if set(changed_streams) != {"BodyText/Section0", "PrvImage"}:
        raise AssertionError(f"unexpected HWP CFB stream changes: {changed_streams}")
    if before_streams["PrvText"] != after_streams["PrvText"]:
        raise AssertionError("caption edit changed the unrelated HWP text preview")
    page_defs = [r[2] for r in records(unpacked(after_streams, "BodyText/Section0")) if r[0] == 73]
    if len(page_defs) != 1 or len(page_defs[0]) < 40:
        raise AssertionError("cannot establish output page geometry for PrvImage")
    page = page_defs[0]
    width = int.from_bytes(page[0:4], "little")
    height = int.from_bytes(page[4:8], "little")
    landscape = bool(int.from_bytes(page[36:40], "little") & 1)
    preview_size = p5_native.preview_dimensions(width, height, landscape)
    preview_proof = p5_native.canonical_preview_png(after_streams["PrvImage"], preview_size)
    if preview_proof is None:
        raise AssertionError("PrvImage is not the canonical output-sized RGB8 preview")
    old = records(unpacked(before_streams, "BodyText/Section0"))
    new = records(unpacked(after_streams, "BodyText/Section0"))
    if len(old) != len(new) or [(r[0], r[1]) for r in old] != [(r[0], r[1]) for r in new]:
        raise AssertionError("HWP record sequence or ownership levels changed")
    roots = [i for i, r in enumerate(old) if r[0] == 71 and r[1] == 1 and r[2].startswith(b" osg")]
    if len(roots) != 1:
        raise AssertionError(f"expected one root group GSO record, found {roots}")
    root = roots[0]
    end = next((i for i in range(root + 1, len(old)) if old[i][1] <= 1), len(old))
    if old[root] != new[root]:
        raise AssertionError("group GSO owner/geometry record changed")
    shape_components = [i for i in range(root + 1, end) if old[i][0] == 76]
    if len(shape_components) != 3 or any(old[i] != new[i] for i in shape_components):
        raise AssertionError("group child ShapeComponent identity/property record changed")
    child_geometry = [i for i in range(root + 1, end) if old[i][0] in (79, 80)]
    if len(child_geometry) < 2 or any(old[i] != new[i] for i in child_geometry):
        raise AssertionError("group child geometry records changed")
    changes=[]
    for i,(a,b) in enumerate(zip(old,new)):
        if a!=b:
            changes.append({"index":i,"tag":a[0],"level":a[1],"oldLength":len(a[2]),"newLength":len(b[2])})
            if (a[0],a[1]) not in {(66,2),(67,3)}:
                raise AssertionError(f"non-caption HWP record changed: {changes[-1]}")
    if not changes or not any(c["tag"]==67 and c["level"]==3 for c in changes):
        raise AssertionError(f"caption text was not represented in the changed HWP records: {changes}")
    return {"changedCfbStreams":changed_streams,"recordCount":len(old),"rootGroupRecordIndex":root,
            "rootGroupRecordPreserved":True,"childShapeComponentRecordIndexes":shape_components,
            "childShapeComponentsPreserved":True,"childGeometryRecordIndexes":child_geometry,
            "childGeometryPreserved":True,"changedRecords":changes,
            "unrelatedCfbStreamsPreserved":True,"FileHeaderIdentityPreserved":True,
            "previewImage":preview_proof}


def caption_offset(acc):
    value=acc.status("hwp").get("caret", "")
    marker="@caption/2/65534/0"
    if not value.endswith(marker):
        raise AssertionError(f"caret does not belong to the group caption: {value!r}")
    head=value.split("@",1)[0]
    offset=int(head.rsplit(":",1)[1])
    return offset


def next_revision(acc, old):
    h.require(acc.status("hwp")["revision"] != str(old), "HWP edit history did not advance")
    h.p6.rev(acc, "hwp", int(old) + 1)
    return int(acc.status("hwp")["revision"])


def edit_save_case(acc, row, fixtures, out):
    fixture=Path(fixtures)/"group-caption-original.hwp"
    fixture_hash=sha(fixture)
    before=row["before"]=group_model(fixture)
    h.require(before["caption"]["text"].endswith("Group-owned caption"),"unexpected fixture caption",before)
    row["fixtureSha256"]=fixture_hash
    path=h.begin(acc,row,fixture,out,"group-caption-edited.hwp")
    acc.d.js("""
      window.p6HwpGroupCaptionPointers=[];
      document.addEventListener('pointerdown',event=>{
        if(!(event.target instanceof Element)) return;
        window.p6HwpGroupCaptionPointers.push({trusted:event.isTrusted,
          canvas:!!event.target.closest('.rhwp-page__canvas'),x:event.clientX,y:event.clientY});
      },true);
    """)
    caret=before["caption"]["caret"]
    h.p6.pointer(acc,(caret["pageIndex"],caret["x"]+1,caret["y"]+caret["height"]/2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')",timeout=12)
    selected=acc.status("hwp")
    row["captionSelectionStatus"]=selected
    row["trustedCanvasPointers"]=acc.d.js("return window.p6HwpGroupCaptionPointers")
    h.require(row["trustedCanvasPointers"] and row["trustedCanvasPointers"][-1]["trusted"]
              and row["trustedCanvasPointers"][-1]["canvas"],"caption was not selected by trusted canvas pointer",row["trustedCanvasPointers"])
    h.require(caption_offset(acc)==before["caption"]["length"],"pointer did not focus the owned group caption end",selected)
    initial=before["caption"]["text"]
    old_revision=int(selected["revision"])
    acc.key("End")
    acc.type(" edited")
    expected_after=before["caption"]["length"]+len(" edited")
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret===`0:0:${arguments[0]}@caption/2/65534/0`",expected_after,timeout=12)
    acc.wait("const s=document.querySelector('[data-testid=rhwp-status]')?.dataset; return s?.composing==='false'&&s.revision===s.localRevision",timeout=12)
    edited=acc.status("hwp")
    h.require(caption_offset(acc)==expected_after,"typing did not remain in the owned group caption",edited)
    row["editStatus"]=edited
    rev=int(edited["revision"])
    acc.key("ctrl+z"); rev=next_revision(acc,rev)
    h.require(caption_offset(acc)==before["caption"]["length"],"Undo did not restore the group-caption caret position",acc.status("hwp"))
    acc.key("ctrl+y"); rev=next_revision(acc,rev)
    h.require(caption_offset(acc)==expected_after,"Redo did not restore the edited group caption",acc.status("hwp"))
    row["undoRedo"]={"undo":"PASS","redo":"PASS","finalRevision":rev}
    h.publish(acc,"hwp",row)
    after=row["after"]=group_model(path)
    h.require(after["caption"]["text"]==before["caption"]["text"]+" edited","caption text did not survive HWP5 save",after)
    h.require(after["body"]==before["body"],"body text changed",after["body"])
    h.require(after["props"]==before["props"],"group owner properties changed",after["props"])
    h.require(after["group"]["stableIndex"]==before["group"]["stableIndex"],"group owner stable address changed")
    row["serializedPreservation"]=record_evidence(fixture,path)
    row["savedSha256"]=sha(path)
    h.require(sha(fixture)==fixture_hash,"source HWP5 fixture bytes changed")
    h.reopen(acc,path,row)
    reopened=row["sameProcessReopen"]=group_model(path)
    h.require(reopened["caption"]["text"]==after["caption"]["text"],"same-process reopen lost group caption text")
    h.require(reopened["props"]==before["props"],"same-process reopen changed group properties")
    OBSERVED["firstAppPid"]=row.get("appPid")
    OBSERVED["savedSha256"]=sha(path)
    OBSERVED["text"]=after["caption"]["text"]
    OBSERVED["frame"]={key:after["group"][key] for key in ("x","y","w","h")}


def fresh_process_case(acc,row,_fixtures,out):
    published=Path(out)/"group-caption-edited.hwp"
    if not published.is_file(): raise AssertionError("prior Native save is unavailable")
    expected_hash=OBSERVED.get("savedSha256")
    h.require(expected_hash and sha(published)==expected_hash,"fresh-process input differs from saved HWP5")
    model=row["before"]=group_model(published)
    path=h.begin(acc,row,published,out,"group-caption-fresh-process.hwp")
    h.require(row["appPid"]!=OBSERVED.get("firstAppPid"),"fresh-process reopen reused the original app PID")
    h.require(row["processAppSha256"]==sha(APP),"fresh app binary differs from reviewed Release application")
    h.require(model["caption"]["text"]==OBSERVED.get("text"),"fresh process model has wrong caption text")
    h.require(acc.status("hwp")["dirty"]=="false","freshly reopened saved HWP5 is dirty")
    caret=model["caption"]["caret"]
    acc.d.js("""
      window.p6HwpFreshPointers=[];
      document.addEventListener('pointerdown',event=>{
        if(!(event.target instanceof Element)) return;
        window.p6HwpFreshPointers.push({trusted:event.isTrusted,canvas:!!event.target.closest('.rhwp-page__canvas'),x:event.clientX,y:event.clientY});
      },true);
    """)
    h.p6.pointer(acc,(caret["pageIndex"],caret["x"]+1,caret["y"]+caret["height"]/2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')",timeout=12)
    status=acc.status("hwp")
    row["freshCaptionSelection"]=status
    pointers=acc.d.js("return window.p6HwpFreshPointers")
    row["trustedCanvasPointers"]=pointers
    h.require(pointers and pointers[-1]["trusted"] and pointers[-1]["canvas"],"fresh reopen selection did not use trusted canvas pointer",pointers)
    h.require(caption_offset(acc)==model["caption"]["length"],"fresh reopen selected another story/caption",status)
    h.require(acc.status("hwp")["dirty"]=="false","fresh caption selection dirtied the document")
    row["savedInputSha256"]=expected_hash
    row["frame"]={key:model["group"][key] for key in ("x","y","w","h")}
    h.require(all(abs(row["frame"][k]-OBSERVED["frame"][k])<=1.5 for k in row["frame"]),"fresh process layout differs from same-process saved layout",row["frame"])


h.CASES["P6-OTHER-CAP-HWP5-NATIVE"] = edit_save_case
h.CASES["P6-OTHER-CAP-HWP5-FRESH-NATIVE"] = fresh_process_case

if __name__=="__main__":
    raise SystemExit(h.main())
