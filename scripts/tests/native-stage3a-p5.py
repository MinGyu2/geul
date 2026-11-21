#!/usr/bin/env python3
"""P5 Linux X11 acceptance for owned DOCX pictures and HWPX textbox paragraphs."""

import importlib.util
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
        h.require(not acc.d.exists("[data-testid='object-move']"), "story movement advertised")
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
           "P5-TB-REPLACE": lambda *args: textbox_join(*args, span=3, replace=True),
           "P5-DX-STORY-SIZE": lambda *args: stories(*args, resize=True),
           "P5-TB-RANGE": lambda *args: textbox_join(*args, span=3)}

if __name__ == "__main__":
    sys.exit(h.main())
