#!/usr/bin/env python3
"""P5 Linux X11 acceptance for owned DOCX pictures and HWPX textbox paragraphs."""

import importlib.util
import hashlib
import json
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
import zipfile

entry = Path(__file__).with_name("native-stage3-c.py")
spec = importlib.util.spec_from_file_location("stage3c", entry)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

DESCRIPTION = '[aria-labelledby=properties-selection] .object-tools input[maxlength="1024"]'
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
PIC = "{http://schemas.openxmlformats.org/drawingml/2006/picture}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
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


def select_story_note(acc, layout, order, name, require_move=True):
    where = layout[name]
    acc.wait("""
      const canvas = document.querySelectorAll('.docx-page canvas')[arguments[0]];
      return canvas?.width > 0 && canvas.parentElement.dataset.current === 'true' &&
        canvas.parentElement.dataset.revision === document.querySelector('[data-testid=docx-status]').dataset.revision;
    """, where["page"])
    points = story_picture_points(acc, where["page"])
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
    """,DESCRIPTION,name,point)
    owner_verified=selected["descriptionEditor"]==name or selected["descriptionDisplay"]==name
    h.require(selected["objectKind"]=="picture" and (not require_move or selected["moveHandle"])
              and selected["clickInsideFrame"] and owner_verified,
              "native hit test selected the wrong note picture or owner",selected)
    return point, h.frame(acc), selected


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
    _,body_frame,body_selection=select_story_note(acc,layout,remaining_order,"body",require_move=False)
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
    _,reopened_frame,reopened_selection=select_story_note(acc,layout,("body",),"body",require_move=False)
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
    points=story_picture_points(acc,layout["body"]["page"])
    h.require(len(points)==1,"fresh app did not render exactly the retained body picture",points)
    _,frame,selection=select_story_note(acc,layout,("body",),"body",require_move=False)
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


def textbox_join(acc, row, fixtures, out, span=2, replace=False):
    name = "a-p5-textbox-paste" if replace else "a-p5-textbox-join" if span == 2 else "a-p5-textbox-range"
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
    else:
        acc.key("Delete")
        h.revision(acc, "hwpx", revision + 1)
    acc.text_is("hwpx", edited_text)
    acc.key("ctrl+z")
    h.revision(acc, "hwpx", revision + 2)
    acc.text_is("hwpx", "plain")
    acc.key("ctrl+y")
    h.revision(acc, "hwpx", revision + 3)
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
        inserted = h.inspect_rhwp(path, """
          const owner=controls.find(c=>c.list===0 && c.ctrlId==='gso');
          console.log(JSON.stringify(JSON.parse(doc.getCursorRectInCell(0,owner.para,owner.controlIndex,0,2,4))));
        """)
        place(inserted)
    else:
        place(positions[1])
    acc.text_is("hwpx", edited_text)



h.CASES = {"P5.1": stories, "P5.2": textbox, "P5.5": textbox_join,
           "P5-DX-NOTE-MOVE": note_move,
           "P5-DX-HF-MOVE": header_footer_move,
           "P5-DX-NOTE-MOVE-FRESH-REOPEN": note_move_fresh_reopen,
           "P5-DX-HF-MOVE-FRESH-REOPEN": header_footer_move_fresh_reopen,
           "P5-DX-DELETE": delete_docx_story_pictures,
           "P5-DX-DELETE-FRESH-REOPEN": delete_docx_story_pictures_fresh_reopen,
           "P5-TB-REPLACE": lambda *args: textbox_join(*args, span=3, replace=True),
           "P5-DX-STORY-SIZE": lambda *args: stories(*args, resize=True),
           "P5-TB-RANGE": lambda *args: textbox_join(*args, span=3)}

if __name__ == "__main__":
    sys.exit(h.main())
