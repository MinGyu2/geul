#!/usr/bin/env python3
"""Stage 3-B Release Linux X11 GUI acceptance. Run under native-ibus-session.py."""
import argparse
import hashlib
import importlib.util
import json
import platform
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
import zlib
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
p5 = load("native-stage3a-p5")
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


def inspect_hwp_clip(path):
    return c.inspect_rhwp(path, """
      const all = pages.flatMap((p, page) => p.map(item => ({...item, page})));
      const pictures = all.filter(x => x.type === 'image').map(x => {
        const bytes = doc.getControlImageData(x.secIdx, x.paraIdx, '[]', x.controlIdx);
        return {
          ...x,
          props: JSON.parse(doc.getPictureProperties(x.secIdx, x.paraIdx, x.controlIdx)),
          sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
        };
      });
      console.log(JSON.stringify({body, pictures}));
    """)


def prepare_p6_h5_clip_fixtures(staging: Path):
    staging.mkdir(parents=True, exist_ok=True)
    source = staging / "p6-h5-clip-source.hwp"
    destination = staging / "p6-h5-clip-destination.hwp"
    create = r"""
const sourcePath=process.argv[1], destinationPath=process.argv[2];
const sourceDoc=rhwp.HwpDocument.createEmpty();
const targetDoc=rhwp.HwpDocument.createEmpty();
const ok=(raw,label)=>{const value=JSON.parse(raw);if(value.ok!==true)throw Error(label+': '+JSON.stringify(value));return value;};
try {
  sourceDoc.createBlankDocument();
  sourceDoc.insertText(0,0,0,'HWP5 source body');
  const sourcePicture=ok(sourceDoc.insertPicture(0,0,0,'[]',
    fs.readFileSync(path.resolve('src-tauri/icons/32x32.png')),3600,2100,32,32,'png','source transfer'),
    'source picture');
  ok(sourceDoc.setPictureProperties(0,0,sourcePicture.controlIdx,
    '{"treatAsChar":true,"textWrap":"Square","horzOffset":1700,"vertOffset":1800}'),
    'source picture properties');
  fs.writeFileSync(sourcePath,sourceDoc.exportHwp());

  targetDoc.createBlankDocument();
  targetDoc.insertText(0,0,0,'HWP5 destination body');
  const targetPicture=ok(targetDoc.insertPicture(0,0,0,'[]',
    fs.readFileSync(path.resolve('src-tauri/icons/128x128.png')),2400,1500,128,128,'png','keep destination'),
    'destination picture');
  ok(targetDoc.setPictureProperties(0,0,targetPicture.controlIdx,
    '{"treatAsChar":true,"textWrap":"Square","horzOffset":7800,"vertOffset":2500}'),
    'destination picture properties');
  fs.writeFileSync(destinationPath,targetDoc.exportHwp());
} finally { sourceDoc.free(); targetDoc.free(); }
"""
    marker = "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));"
    template = p6.ORACLE.split("try {", 1)[0]
    require(marker in template, "P6 HWP5 fixture template is stale")
    script = template.replace(marker, create)
    subprocess.run(["node", "-e", script, str(source), str(destination)], cwd=ROOT, check=True)
    return source, destination


def _hwp_embedded_payload(data):
    for window in (-15, 15):
        try:
            return zlib.decompress(data, window)
        except zlib.error:
            continue
    return data


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


def inspect_shape_types(path):
    return c.inspect_rhwp(path, """
      const all = pages.flatMap((p, page) => p.map(item => ({...item, page})));
      const shapes = all.filter(x => x.type === 'shape').map(x => ({
        ...x,
        props: JSON.parse(doc.getShapeProperties(x.secIdx, x.paraIdx, x.controlIdx)),
        target: typeof doc.getShapeTypeChangeTarget === 'function'
          ? doc.getShapeTypeChangeTarget(x.secIdx, x.paraIdx, x.controlIdx) : null,
      }));
      console.log(JSON.stringify({body, shapes}));
    """)


def prepare_p6_shape_type_fixtures(out):
    out.mkdir(parents=True, exist_ok=True)
    hwp_path = out / "p6-hx-type.fixture.hwp"
    hwpx_path = out / "p6-hx-type.fixture.hwpx"
    base = ROOT / "external/rhwp/saved/blank2010.hwp"
    marker = "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));"
    create = r"""
const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));
const result=(raw,label)=>{const value=JSON.parse(raw);if(value.ok!==true)throw Error(label+': '+JSON.stringify(value));return value;};
try {
  const standard=result(doc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,
    shapeType:'rectangle',width:4000,height:3000,treatAsChar:false,textWrap:'Square',horzOffset:3000,vertOffset:3000})), 'standard rectangle');
  const rounded=result(doc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:0,charOffset:0,
    shapeType:'rectangle',width:3000,height:2200,treatAsChar:false,textWrap:'Square',horzOffset:11000,vertOffset:3000})), 'rounded rectangle');
  result(doc.setShapeProperties(0,0,rounded.controlIdx,'{"roundRate":35}'), 'rounded rectangle properties');
  const standardProps=JSON.parse(doc.getShapeProperties(0,0,standard.controlIdx));
  const roundedProps=JSON.parse(doc.getShapeProperties(0,0,rounded.controlIdx));
  fs.writeFileSync(process.argv[2],doc.exportHwp());
  fs.writeFileSync(process.argv[3],doc.exportHwpx());
  console.log(JSON.stringify({standard:standardProps,rounded:roundedProps}));
} finally { doc.free(); }
"""
    template = p6.ORACLE.split("try {", 1)[0]
    require(marker in template, "P6 type-change fixture template is stale")
    script = template.replace(marker, create)
    output = subprocess.check_output(
        ["node", "-e", script, str(base), str(hwp_path), str(hwpx_path)], cwd=ROOT, text=True
    )
    return hwp_path, hwpx_path, json.loads(output)


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


def prepare_p6_dx_hx_fixtures(out):
    out.mkdir(parents=True, exist_ok=True)
    base = ROOT / "scripts/tests/fixtures/stage3a-p4-dx-group.docx"
    source_docx = out / "p6-dx-hx-source.docx"
    unsupported_docx = out / "p6-dx-hx-triangle.docx"
    destination_hwpx = out / "p6-dx-hx-destination.fixture.hwpx"
    refusal_hwpx = out / "p6-dx-hx-refusal.fixture.hwpx"
    source_shape = """<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2794000" cy="1651000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Transfer shape" descr="Transfer shape"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvPr id="2" name="Transfer shape" descr="Transfer shape"/><wps:cNvSpPr/><wps:spPr><a:xfrm rot="5400000" flipV="1"><a:off x="0" y="0"/><a:ext cx="2794000" cy="1651000"/></a:xfrm><a:prstGeom prst="{preset}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="CC8844"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"""

    def write_docx(path, preset):
        with ZipFile(base) as src:
            items = [(info, src.read(info.filename)) for info in src.infolist()]
        xml_index = next(i for i, (info, _) in enumerate(items) if info.filename == "word/document.xml")
        info, data = items[xml_index]
        document = data.decode("utf-8")
        opening = document[:document.index("<w:body>") + len("<w:body>")]
        section = re.search(r"<w:sectPr\b.*?</w:sectPr>", document)
        require(section is not None, "DOCX fixture has no final section properties")
        body = opening + source_shape.format(preset=preset) + section.group(0) + "</w:body></w:document>"
        items[xml_index] = (info, body.encode("utf-8"))
        with ZipFile(path, "w") as dst:
            for entry, payload in items:
                dst.writestr(entry, payload)

    write_docx(source_docx, "ellipse")
    write_docx(unsupported_docx, "triangle")

    marker = "const doc = new rhwp.HwpDocument(fs.readFileSync(process.argv[1]));"
    create = r"""
const targetPath=process.argv[1];
const doc=rhwp.HwpDocument.createEmpty();
try {
  doc.createBlankDocument();
  doc.insertText(0,0,0,'destination baseline');
  fs.writeFileSync(targetPath,doc.exportHwpx());
} finally { doc.free(); }
"""
    template = p6.ORACLE.split("try {", 1)[0]
    require(marker in template, "P6 DOCX-to-HWPX fixture template is stale")
    subprocess.run(["node", "-e", template.replace(marker, create), str(destination_hwpx)], cwd=ROOT, check=True)
    shutil.copyfile(destination_hwpx, refusal_hwpx)
    for path, expected in ((source_docx, "ellipse"), (unsupported_docx, "triangle")):
        with ZipFile(path) as package:
            root = ElementTree.fromstring(package.read("word/document.xml"))
        geometries = root.findall(".//{*}prstGeom")
        require(len(geometries) == 1 and geometries[0].get("prst") == expected,
                "generated DOCX shape fixture is ambiguous", path)
    return source_docx, unsupported_docx, destination_hwpx, refusal_hwpx


def _docx_shape_viewport_point(acc, rgb):
    point = acc.d.js("""
      const wanted=arguments[0], target=wanted.match(/../g).map(v=>parseInt(v,16));
      for(const page of document.querySelectorAll('.docx-page')) {
        const canvas=page.querySelector('canvas'), ctx=canvas?.getContext('2d');
        if(!canvas||!ctx) continue;
        const image=ctx.getImageData(0,0,canvas.width,canvas.height);
        let x=0,y=0,count=0;
        for(let i=0;i<image.data.length;i+=4) if(target.every((v,j)=>image.data[i+j]===v)) {
          x+=(i/4)%canvas.width; y+=Math.floor(i/4/canvas.width); count++;
        }
        if(count<100) continue;
        const r=canvas.getBoundingClientRect(), scale=r.width/canvas.width;
        const px=r.left+x/count*scale, py=r.top+y/count*scale;
        const scroll=document.querySelector('.editor__scroll'), viewport=scroll.getBoundingClientRect();
        scroll.scrollTop += py-(viewport.top+viewport.height/2);
        const moved=canvas.getBoundingClientRect();
        return [Number(page.dataset.page||0),moved.left+x/count*scale,moved.top+y/count*scale];
      }
      return null;
    """, rgb)
    require(point is not None, "could not find source DOCX shape fill in rendered page", rgb)
    return point


def _package_parts(path):
    with ZipFile(path) as package:
        return {name: package.read(name) for name in package.namelist()}


def _p6_dx_hx_invalid_v4_payload():
    engine = {
        "fragment": {"blocks": [{"kind": "para", "text": "\uFFFC", "runs": [{"len": 3}], "objects": [{
            "type": "shape", "kind": "ellipse", "w": 108, "h": 72,
            "fill": [21, 96, 130], "stroke": [14, 64, 90], "stroke_width": 1, "story": None,
            "float": {"wrap": "inline", "hRel": "column", "vRel": "column", "x": 0, "y": 0,
                      "dist": 0, "distTop": 0, "distBottom": 0, "effect": [0, 0, 0, 0]},
        }]}]},
        "media": [],
    }
    return json.dumps({
        "kind": "geul.object", "version": 4, "sourceFormat": "docx", "object": "shape",
        "engine": engine,
        "portable": {"kind": "shape", "shapeType": "ellipse", "width": 3811, "height": 2540,
                     "horzOffset": 0, "vertOffset": 0, "treatAsChar": True, "textWrap": "Square",
                     "rotationAngle": 0, "horzFlip": False, "vertFlip": False,
                     "borderColor": 0x5a400e, "borderWidth": 35, "lineType": 1,
                     "fillType": "solid", "fillBgColor": 0x826015},
        "token": "a" * 24,
    }, separators=(",", ":"))


def p6_dx_hx(acc, row, b_root, out):
    fixture_dir = out / "p6-dx-hx-fixtures"
    source_fixture, unsupported_fixture, destination_fixture, refusal_fixture = prepare_p6_dx_hx_fixtures(fixture_dir)
    source = begin(acc, row, source_fixture, out, "p6-dx-hx-source.docx")
    source_hash = digest(source)
    source_parts = _package_parts(source)
    row["fixtureHashes"] = {
        "sourceDocx": source_hash, "destinationHwpx": digest(destination_fixture),
        "unsupportedDocx": digest(unsupported_fixture), "refusalHwpx": digest(refusal_fixture),
    }
    acc.d.js("""
      window.p6DxHxEvents=[];
      for(const type of ['pointerdown','keydown']) document.addEventListener(type,e=>{
        if(type==='pointerdown'||(e.ctrlKey&&['c','v','z','y'].includes(e.key.toLowerCase())))
          window.p6DxHxEvents.push({type,key:e.key||null,trusted:e.isTrusted});
      },true);
    """)
    page, x, y = _docx_shape_viewport_point(acc, "CC8844")
    p4.rhwp_poc.click(acc.d, x, y)
    acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='shape'", FRAME, timeout=10)
    acc.key("ctrl+c")
    row["trustedCopyInput"] = acc.d.js("return window.p6DxHxEvents.slice()")
    row["sourceStatusAfterCopy"] = acc.status("docx")
    require(row["sourceStatusAfterCopy"]["revision"] == "0"
            and row["sourceStatusAfterCopy"]["status"] == "ready"
            and row["sourceStatusAfterCopy"]["dirty"] == "false",
            "cross-format copy changed the DOCX source", row["sourceStatusAfterCopy"])
    require(any(e["type"] == "pointerdown" and e["trusted"] for e in row["trustedCopyInput"])
            and any(e["key"] == "c" and e["trusted"] for e in row["trustedCopyInput"]),
            "DOCX selection/copy did not use trusted Native input", row["trustedCopyInput"])
    require(digest(source) == source_hash, "copy changed source DOCX bytes")

    destination = out / "p6-dx-hx-destination.hwpx"
    shutil.copyfile(destination_fixture, destination)
    destination_parts_before = _package_parts(destination)
    before = row["beforeDestination"] = inspect_hwpx_clip(destination)
    require(not before["shapes"] and not before["pictures"], "HWPX destination fixture is not empty", before)
    acc.open_native("hwpx", destination)
    c.body_end(acc)
    before_canvas = _canvas_digest(acc)
    initial = acc.status("hwpx")
    acc.key("ctrl+v")
    row["afterPaste"] = revision(acc, "hwpx", 1)
    pasted_canvas = _canvas_digest(acc)
    require(pasted_canvas != before_canvas, "trusted DOCX-to-HWPX paste did not render a shape")
    acc.key("ctrl+z")
    row["afterUndo"] = revision(acc, "hwpx", 2)
    require(_canvas_digest(acc) == before_canvas, "Undo did not restore HWPX destination rendering")
    acc.key("ctrl+y")
    row["afterRedo"] = revision(acc, "hwpx", 3)
    require(_canvas_digest(acc) == pasted_canvas, "Redo did not restore the transferred HWPX shape")
    trusted = row["trustedClipboardKeys"] = acc.d.js("return window.p6DxHxEvents.slice()")
    for key in ("v", "z", "y"):
        require(any(e["key"] == key and e["trusted"] for e in trusted),
                "clipboard/history action did not use trusted Native input", key)
    publish(acc, "hwpx", row)
    require(digest(source) == source_hash, "save changed source DOCX bytes")
    after = row["after"] = inspect_hwpx_clip(destination)
    require(len(after["shapes"]) == 1 and not after["pictures"], "target did not own exactly one editable shape", after)
    require([text for text in after["body"] if text] == [text for text in before["body"] if text],
            "destination body text changed", after["body"])
    shape, = after["shapes"]
    props = shape["props"]
    expected = {
        "width": 7761, "height": 4586, "rotationAngle": 90, "horzFlip": False, "vertFlip": True,
        "borderColor": 0x00332211, "borderWidth": 35, "lineType": 1,
        "fillType": "solid", "fillBgColor": 0x004488CC, "treatAsChar": True,
        "horzOffset": 0, "vertOffset": 0, "description": "Transfer shape",
    }
    row["mappedProperties"] = {key: props.get(key) for key in expected}
    for key, value in expected.items():
        require(props.get(key) == value, "DOCX-to-HWPX geometry/style mapping differs", {key: props.get(key), "expected": value, "props": props})
    require(shape["page"] == 0, "transferred shape lost destination page ownership", shape)
    with ZipFile(destination) as package:
        section = ElementTree.fromstring(package.read("Contents/section0.xml"))
    tags = [node.tag.rsplit("}", 1)[-1] for node in section.iter() if node.tag.rsplit("}", 1)[-1] in {"rect", "ellipse", "line", "polygon"}]
    require(tags == ["ellipse"], "serialized HWPX target is not one native editable ellipse", tags)
    destination_parts_after = _package_parts(destination)
    require(destination_parts_before.keys() == destination_parts_after.keys(),
            "shape conversion unexpectedly added or removed OPC parts")
    changed = sorted(name for name in destination_parts_before if destination_parts_before[name] != destination_parts_after[name])
    row["changedOPCParts"] = changed
    require(changed and set(changed) <= {"Contents/section0.xml", "Preview/PrvImage.png", "Preview/PrvText.txt"},
            "conversion changed unrelated HWPX OPC parts", changed)
    require(all(destination_parts_before[name] == destination_parts_after[name]
                for name in destination_parts_before if name.startswith("BinData/")),
            "conversion changed unrelated HWPX resources")
    reopen(acc, destination, row)
    reopened = inspect_hwpx_clip(destination)
    require(reopened == after, "saved HWPX shape changed after independent reopen", reopened)
    select_object(acc, reopened["shapes"][0], "shape")
    row["reopenedEditableSelection"] = "shape selectable"

    unsupported = begin(acc, row, unsupported_fixture, out, "p6-dx-hx-triangle.docx")
    triangle_point = _docx_shape_viewport_point(acc, "CC8844")
    p4.rhwp_poc.click(acc.d, triangle_point[1], triangle_point[2])
    acc.wait("return document.querySelector(arguments[0])?.dataset.objectKind==='shape'", FRAME, timeout=10)
    acc.key("ctrl+c")
    refusal = out / "p6-dx-hx-refusal.hwpx"
    shutil.copyfile(refusal_fixture, refusal)
    refusal_hash = digest(refusal)
    acc.open_native("hwpx", refusal)
    initial_refusal = acc.status("hwpx")
    acc.key("ctrl+v")
    acc.settle("hwpx")
    rejected = acc.status("hwpx")
    row["unsupportedPasteBefore"] = initial_refusal
    row["unsupportedPasteAfter"] = rejected
    for key in ("status", "revision", "localRevision", "dirty", "unpreserved", "uncertain", "selection", "caret"):
        require(rejected[key] == initial_refusal[key], "unsupported shape paste mutated HWPX session", {key: rejected[key], "initial": initial_refusal[key]})
    require(digest(refusal) == refusal_hash, "unsupported shape paste changed file bytes")
    row["unsupportedShape"] = {"state": "refused without mutation", "kind": "triangle"}
    invalid_payload = _p6_dx_hx_invalid_v4_payload()
    c.clipboard_peer(acc, "application/x-geul-object+json", invalid_payload, lambda: (
        acc.key("ctrl+v"), acc.settle("hwpx"), require(
            acc.status("hwpx")["revision"] == initial_refusal["revision"]
            and acc.status("hwpx")["localRevision"] == initial_refusal["localRevision"]
            and acc.status("hwpx")["dirty"] == initial_refusal["dirty"]
            and digest(refusal) == refusal_hash,
            "tampered DOCX-to-HWPX payload was not rejected atomically",
        )
    ), plain="Geul shape [" + "a" * 24 + "]")
    row["tamperedPayload"] = "refused before mutation"
    require(digest(source) == source_hash, "cross-format copy changed source DOCX bytes")
    require(source_parts == _package_parts(source), "source OPC parts changed during copy/paste")
    row["preservation"] = {"sourceDocxBytesAndParts": True, "destinationUnrelatedOpc": True,
                           "destinationUnrelatedResources": True, "savedTargetReopen": True}


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


def _shape_without_type(props):
    return {key: value for key, value in props.items() if key not in {"shapeType", "roundRate"}}


def _shape_type_element(path, instance_id):
    with ZipFile(path) as package:
        root = ElementTree.fromstring(package.read("Contents/section0.xml"))
    matches = [node for node in root.iter()
               if node.tag.rsplit("}", 1)[-1] in {"rect", "ellipse"}
               and node.attrib.get("instid") == str(instance_id)]
    if not matches:
        matches = [node for node in root.iter()
                   if node.tag.rsplit("}", 1)[-1] in {"rect", "ellipse"}
                   and node.attrib.get("id") == str(instance_id)]
    require(len(matches) == 1, "HWPX object ID does not resolve to one shape", [instance_id, len(matches)])
    return matches[0]


def _shape_xml_summary(element, normalize_type=False):
    geometry = {"pt0", "pt1", "pt2", "pt3", "center", "ax1", "ax2",
                "start1", "end1", "start2", "end2"}
    namespace, local = (element.tag[1:].split("}", 1) if element.tag.startswith("{") else ("", element.tag))
    attrs = dict(element.attrib)
    if normalize_type:
        for key in ("ratio", "intervalDirty", "hasArcPr", "arcType"):
            attrs.pop(key, None)
        local = "basic-shape"
    children = []
    for child in list(element):
        child_local = child.tag.rsplit("}", 1)[-1]
        if normalize_type and child_local in geometry:
            continue
        children.append(_shape_xml_summary(child))
    return namespace, local, tuple(sorted(attrs.items())), element.text or "", tuple(children)


def _hwpx_shape_geometry(element, shape_type):
    def one(local):
        matches = [child for child in list(element) if child.tag.rsplit("}", 1)[-1] == local]
        require(len(matches) == 1, "HWPX basic shape geometry child is ambiguous", [local, len(matches)])
        try:
            return (int(matches[0].attrib["x"]), int(matches[0].attrib["y"]))
        except (KeyError, ValueError) as error:
            raise AssertionError(f"HWPX shape point {local} is not an exact integer coordinate") from error

    if shape_type == "rectangle":
        return {name: one(name) for name in ("pt0", "pt1", "pt2", "pt3")}
    return {name: one(name) for name in ("center", "ax1", "ax2", "start1", "end1", "start2", "end2")}


def _prove_hwp_shape_type_package(before_path, after_path, target_id, rounded_id,
                                 source_type="rectangle", target_type="ellipse"):
    before_streams = p6.gso.cfb_streams(before_path.read_bytes())
    after_streams = p6.gso.cfb_streams(after_path.read_bytes())
    require(before_streams.keys() == after_streams.keys(), "HWP5 conversion added or removed CFB streams")
    changed = {name for name, data in before_streams.items() if after_streams[name] != data}
    require(changed <= {"BodyText/Section0", "PrvImage"} and "BodyText/Section0" in changed,
            "HWP5 conversion changed unauthorized streams", sorted(changed))
    require(before_streams["DocInfo"] == after_streams["DocInfo"], "HWP5 conversion changed DocInfo")
    require(all(before_streams[name] == after_streams[name]
                for name in before_streams if name.startswith("BinData/")),
            "HWP5 conversion changed embedded media")
    old_rows, old_objects = p6.gso.section_objects(before_streams)
    new_rows, new_objects = p6.gso.section_objects(after_streams)
    old_shapes = {struct.unpack_from("<I", obj[0][2], 36)[0]: obj for obj in old_objects
                  if len(obj) == 3 and obj[1][0] == 76 and obj[1][2][:4] in (b"cer$", b"lle$")}
    new_shapes = {struct.unpack_from("<I", obj[0][2], 36)[0]: obj for obj in new_objects
                  if len(obj) == 3 and obj[1][0] == 76 and obj[1][2][:4] in (b"cer$", b"lle$")}
    require(set(old_shapes) == set(new_shapes) and target_id in old_shapes and rounded_id in old_shapes,
            "HWP5 shape identities changed", [sorted(old_shapes), sorted(new_shapes)])
    require(old_rows and new_rows and old_shapes[rounded_id] == new_shapes[rounded_id],
            "unconverted HWP5 rounded shape changed")
    old, new = old_shapes[target_id], new_shapes[target_id]
    require(len(old) == len(new) == 3 and old[0] == new[0], "HWP5 shape owner or record topology changed")
    old_component, new_component = old[1][2], new[1][2]
    source_ctrl, source_leaf_tag = ((b"cer$", 79) if source_type == "rectangle" else (b"lle$", 80))
    target_ctrl, target_leaf_tag = ((b"cer$", 79) if target_type == "rectangle" else (b"lle$", 80))
    require(old[1][:2] == new[1][:2] == (76, 2)
            and old_component[:4] == old_component[4:8] == source_ctrl
            and new_component[:4] == new_component[4:8] == target_ctrl
            and old_component[8:] == new_component[8:],
            "HWP5 shape identity/style bytes changed beyond type control IDs")
    width, height = struct.unpack_from("<II", old[0][2], 16)
    require(struct.unpack_from("<II", new[0][2], 16) == (width, height),
            "HWP5 shape geometry changed during type conversion")
    old_leaf, new_leaf = old[2], new[2]
    rect_points = [(0, 0), (width, 0), (width, height), (0, height)]
    rect_bytes = b"\x00" + b"".join(struct.pack("<ii", x, y) for x, y in rect_points)
    center = (width // 2, height // 2)
    endpoint = (width, center[1])
    ellipse_points = [center, endpoint, (center[0], height), endpoint, endpoint, endpoint, endpoint]
    ellipse_bytes = struct.pack("<I", 0) + b"".join(struct.pack("<ii", x, y) for x, y in ellipse_points)
    canonical = {"rectangle": (79, rect_bytes), "ellipse": (80, ellipse_bytes)}
    require(old_leaf[:2] == (canonical[source_type][0], 3)
            and old_leaf[2] == canonical[source_type][1]
            and new_leaf[:2] == (canonical[target_type][0], 3)
            and new_leaf[2] == canonical[target_type][1]
            and old_leaf[0] == source_leaf_tag and new_leaf[0] == target_leaf_tag,
            "HWP5 target leaf geometry or type was not serialized canonically")
    preview_size = p5.hwp_preview_dimensions(after_streams)
    require(after_streams.get("PrvImage") != before_streams.get("PrvImage")
            and p5.canonical_preview_png(after_streams["PrvImage"], preview_size) is not None,
            "HWP5 T009 did not refresh a canonical page preview")
    return {"changedCfbStreams": sorted(changed), "shapeInstanceIds": sorted(old_shapes),
            "sourceTargetType": source_type, "savedTargetType": target_type,
            "targetGeometry": [width, height], "previewDimensions": preview_size}


def _prove_hwpx_shape_type_package(before_path, after_path, target_id, rounded_id,
                                   source_type="rectangle", target_type="ellipse"):
    with ZipFile(before_path) as before_zip, ZipFile(after_path) as after_zip:
        before = {name: before_zip.read(name) for name in before_zip.namelist() if not name.endswith("/")}
        after = {name: after_zip.read(name) for name in after_zip.namelist() if not name.endswith("/")}
    require(before.keys() == after.keys(), "HWPX conversion added or removed OPC parts")
    changed = {name for name in before if before[name] != after[name]}
    allowed = {"Contents/section0.xml", "Preview/PrvImage.png", "Preview/PrvText.txt"}
    require(changed <= allowed and "Contents/section0.xml" in changed,
            "HWPX conversion changed unauthorized OPC parts", sorted(changed))
    before_target = _shape_type_element(before_path, target_id)
    after_target = _shape_type_element(after_path, target_id)
    before_rounded = _shape_type_element(before_path, rounded_id)
    after_rounded = _shape_type_element(after_path, rounded_id)
    shape_tags = {"rectangle": "rect", "ellipse": "ellipse"}
    require(before_target.tag.rsplit("}", 1)[-1] == shape_tags[source_type]
            and after_target.tag.rsplit("}", 1)[-1] == shape_tags[target_type],
            "HWPX target shape tag did not match the requested type conversion")
    require(_shape_xml_summary(before_target, normalize_type=True)
            == _shape_xml_summary(after_target, normalize_type=True),
            "HWPX common geometry, formatting, ownership, or description changed")
    def dimensions(element):
        sizes = [child for child in list(element) if child.tag.rsplit("}", 1)[-1] == "orgSz"]
        require(len(sizes) == 1, "HWPX shape original-size child is ambiguous", len(sizes))
        try:
            return int(sizes[0].attrib["width"]), int(sizes[0].attrib["height"])
        except (KeyError, ValueError) as error:
            raise AssertionError("HWPX shape dimensions are not exact integers") from error

    width, height = dimensions(before_target)
    require(dimensions(after_target) == (width, height), "HWPX conversion changed object dimensions")
    center = (width // 2, height // 2)
    endpoint = (width, center[1])
    expected = {
        "rectangle": {"pt0": (0, 0), "pt1": (width, 0),
                      "pt2": (width, height), "pt3": (0, height)},
        "ellipse": {"center": center, "ax1": endpoint, "ax2": (center[0], height),
                    "start1": endpoint, "end1": endpoint, "start2": endpoint, "end2": endpoint},
    }
    require(_hwpx_shape_geometry(before_target, source_type) == expected[source_type],
            "HWPX source shape is not canonical for the conversion contract")
    require(_hwpx_shape_geometry(after_target, target_type) == expected[target_type],
            "HWPX target shape geometry was not serialized canonically")
    require(_shape_xml_summary(before_rounded) == _shape_xml_summary(after_rounded),
            "unconverted HWPX rounded rectangle changed")
    return {"changedOpcParts": sorted(changed), "targetId": target_id, "roundedId": rounded_id,
            "preservedOtherParts": True, "sourceTargetType": source_type, "savedTargetType": target_type}


def _shape_type_button_label(acc):
    return acc.d.js("return document.querySelector('[data-testid=shape-type-convert]')?.textContent.trim()||null")


def _track_shape_type_native_events(acc):
    acc.d.js("""
      window.__p6ShapeTypeEvents=[];
      document.addEventListener('pointerdown',e=>{
        if(e.target instanceof Element&&(e.target.closest('.rhwp-page__canvas')||e.target.closest('[data-testid=shape-type-convert]')))
          window.__p6ShapeTypeEvents.push({type:'pointerdown',trusted:e.isTrusted,control:!!e.target.closest('[data-testid=shape-type-convert]')});
      },true);
      document.addEventListener('keydown',e=>{
        if(e.ctrlKey&&['z','y'].includes(e.key.toLowerCase()))
          window.__p6ShapeTypeEvents.push({type:'keydown',key:e.key.toLowerCase(),trusted:e.isTrusted});
      },true);
    """)


def _run_p6_shape_type_format(acc, fmt, fixture, out, case_row, target_id, rounded_id, fixture_hash):
    before = inspect_shape_types(fixture)
    case_row["before"] = before
    target = next(shape for shape in before["shapes"] if shape["props"].get("instanceId") == target_id)
    rounded = next(shape for shape in before["shapes"] if shape["props"].get("instanceId") == rounded_id)
    require(target["props"]["shapeType"] == "rectangle" and target["target"] == "ellipse",
            f"{fmt} standard rectangle is not safely convertible", target)
    require(rounded["props"]["shapeType"] == "rectangle" and rounded["target"] == "",
            f"{fmt} rounded rectangle was not fail-closed", rounded)
    path = begin(acc, case_row, fixture, out, f"p6-hx-type.{fmt}")
    require(digest(fixture) == fixture_hash, f"{fmt} source fixture changed after opening")
    _track_shape_type_native_events(acc)
    select_object(acc, rounded, "shape")
    require(_shape_type_button_label(acc) is None, f"{fmt} rounded rectangle exposed a conversion control")
    initial_state = acc.status(fmt)
    select_object(acc, target, "shape")
    before_label = _shape_type_button_label(acc)
    require(before_label, f"{fmt} standard rectangle did not expose its proven target type")
    before_canvas = _canvas_digest(acc)
    acc.dom_click("[data-testid=shape-type-convert]")
    case_row["afterConvert"] = revision(acc, fmt, 1)
    converted_canvas = _canvas_digest(acc)
    # Successful object mutations clear the transient selection; reacquire the same
    # stable object by trusted pointer before inspecting the reverse conversion.
    select_object(acc, target, "shape")
    converted_label = _shape_type_button_label(acc)
    require(converted_label and converted_label != before_label,
            f"{fmt} conversion did not update the target control", converted_label)
    require(converted_canvas != before_canvas, f"{fmt} conversion did not change the rendered shape")
    select_object(acc, target, "shape")
    acc.key("ctrl+z")
    case_row["afterUndo"] = revision(acc, fmt, 2)
    undo_canvas = _canvas_digest(acc)
    require(undo_canvas == before_canvas, f"{fmt} Undo did not restore the original rendering")
    select_object(acc, target, "shape")
    require(_shape_type_button_label(acc) == before_label,
            f"{fmt} Undo did not restore the type capability")
    acc.key("ctrl+y")
    case_row["afterRedo"] = revision(acc, fmt, 3)
    redo_canvas = _canvas_digest(acc)
    require(redo_canvas == converted_canvas, f"{fmt} Redo did not restore the converted rendering")
    select_object(acc, target, "shape")
    require(_shape_type_button_label(acc) == converted_label,
            f"{fmt} Redo did not restore the type capability")
    current_state = acc.status(fmt)
    require(current_state["revision"] == "3" and current_state["dirty"] == "true",
            f"{fmt} conversion transaction state is unexpected", current_state)
    events = acc.d.js("return window.__p6ShapeTypeEvents.slice()")
    trusted_controls = [event for event in events if event.get("trusted")
                        and event.get("type") == "pointerdown" and event.get("control")]
    require(len(trusted_controls) >= 1,
            f"{fmt} conversion control was not used with a trusted pointer", events)
    require(any(event.get("trusted") and event.get("type") == "pointerdown" and not event.get("control") for event in events),
            f"{fmt} object selection was not performed with a trusted pointer", events)
    for key in ("z", "y"):
        require(any(event.get("trusted") and event.get("type") == "keydown" and event.get("key") == key for event in events),
                f"{fmt} {key.upper()} was not a trusted Native key", events)

    publish(acc, fmt, case_row)
    after = case_row["after"] = inspect_shape_types(path)
    saved_target = next(shape for shape in after["shapes"] if shape["props"].get("instanceId") == target_id)
    saved_rounded = next(shape for shape in after["shapes"] if shape["props"].get("instanceId") == rounded_id)
    require(saved_target["props"]["shapeType"] == "ellipse" and saved_target["target"] == "rectangle",
            f"{fmt} saved object type/identity is wrong", saved_target)
    require(_shape_without_type(target["props"]) == _shape_without_type(saved_target["props"]),
            f"{fmt} saved conversion changed object geometry, style, or owner", saved_target["props"])
    require(saved_rounded["props"] == rounded["props"] and saved_rounded["target"] == "",
            f"{fmt} saved conversion changed or enabled the rounded sibling", saved_rounded)
    require(after["body"] == before["body"], f"{fmt} shape conversion changed body text")
    if fmt == "hwp":
        case_row["serializedProof"] = _prove_hwp_shape_type_package(fixture, path, target_id, rounded_id)
    else:
        case_row["serializedProof"] = _prove_hwpx_shape_type_package(fixture, path, target_id, rounded_id)

    # Verify the inverse UI/API path as its own saved transaction, comparing the
    # ellipse package to the new rectangle package instead of only checking Undo.
    forward_path = out / f"p6-hx-type.forward.{fmt}"
    shutil.copyfile(path, forward_path)
    case_row["forwardSavedSha256"] = digest(forward_path)
    reopen(acc, path, case_row.setdefault("forwardReopen", {}))
    _track_shape_type_native_events(acc)
    reopened_forward = case_row["afterForwardReopen"] = inspect_shape_types(path)
    require(reopened_forward == after, f"{fmt} forward conversion changed on save/reopen")
    reopened_target = next(shape for shape in reopened_forward["shapes"]
                           if shape["props"].get("instanceId") == target_id)
    select_object(acc, reopened_target, "shape")
    require(_shape_type_button_label(acc) == converted_label,
            f"{fmt} reopened ellipse did not expose rectangle conversion")
    ellipse_canvas = _canvas_digest(acc)
    reverse_before_label = _shape_type_button_label(acc)
    acc.dom_click("[data-testid=shape-type-convert]")
    case_row["reverseAfterConvert"] = revision(acc, fmt, 1)
    rectangle_canvas = _canvas_digest(acc)
    require(rectangle_canvas == before_canvas, f"{fmt} reverse conversion did not restore rectangle rendering")
    select_object(acc, reopened_target, "shape")
    reverse_label = _shape_type_button_label(acc)
    require(reverse_label == before_label, f"{fmt} reverse conversion did not expose ellipse as the inverse", reverse_label)
    acc.key("ctrl+z")
    case_row["reverseAfterUndo"] = revision(acc, fmt, 2)
    require(_canvas_digest(acc) == ellipse_canvas, f"{fmt} reverse Undo did not restore ellipse rendering")
    select_object(acc, reopened_target, "shape")
    require(_shape_type_button_label(acc) == reverse_before_label,
            f"{fmt} reverse Undo did not restore type capability")
    acc.key("ctrl+y")
    case_row["reverseAfterRedo"] = revision(acc, fmt, 3)
    require(_canvas_digest(acc) == rectangle_canvas, f"{fmt} reverse Redo did not restore rectangle rendering")
    select_object(acc, reopened_target, "shape")
    require(_shape_type_button_label(acc) == reverse_label,
            f"{fmt} reverse Redo did not restore type capability")
    reverse_events = acc.d.js("return window.__p6ShapeTypeEvents.slice()")
    case_row["trustedNativeEvents"] = events + reverse_events
    require(len([event for event in reverse_events if event.get("trusted") and event.get("type") == "pointerdown"
                 and event.get("control")]) >= 1,
            f"{fmt} reverse control was not activated with a trusted pointer", reverse_events)
    for key in ("z", "y"):
        require(len([event for event in reverse_events if event.get("trusted") and event.get("type") == "keydown"
                     and event.get("key") == key]) >= 1,
                f"{fmt} reverse {key.upper()} was not a trusted Native key", reverse_events)
    for key in ("z", "y"):
        require(len([event for event in case_row["trustedNativeEvents"]
                     if event.get("trusted") and event.get("type") == "keydown" and event.get("key") == key]) >= 2,
                f"{fmt} forward and reverse {key.upper()} did not both use trusted Native keys",
                case_row["trustedNativeEvents"])

    case_row["forwardSave"] = case_row.pop("save")
    publish(acc, fmt, case_row)
    case_row["reverseSave"] = case_row.pop("save")
    reversed_after = case_row["afterReverse"] = inspect_shape_types(path)
    reversed_target = next(shape for shape in reversed_after["shapes"]
                           if shape["props"].get("instanceId") == target_id)
    reversed_rounded = next(shape for shape in reversed_after["shapes"]
                            if shape["props"].get("instanceId") == rounded_id)
    require(reversed_target["props"]["shapeType"] == "rectangle" and reversed_target["target"] == "ellipse",
            f"{fmt} saved reverse conversion type/identity is wrong", reversed_target)
    require(_shape_without_type(saved_target["props"]) == _shape_without_type(reversed_target["props"]),
            f"{fmt} reverse conversion changed geometry, style, or owner", reversed_target["props"])
    require(reversed_rounded["props"] == rounded["props"] and reversed_rounded["target"] == "",
            f"{fmt} reverse conversion changed or enabled the rounded sibling", reversed_rounded)
    require(reversed_after["body"] == before["body"], f"{fmt} reverse conversion changed body text")
    if fmt == "hwp":
        case_row["reverseSerializedProof"] = _prove_hwp_shape_type_package(
            forward_path, path, target_id, rounded_id, "ellipse", "rectangle")
    else:
        case_row["reverseSerializedProof"] = _prove_hwpx_shape_type_package(
            forward_path, path, target_id, rounded_id, "ellipse", "rectangle")

    reopen(acc, path, case_row.setdefault("reverseReopen", {}))
    reopened_reverse = case_row["afterReopen"] = inspect_shape_types(path)
    require(reopened_reverse == reversed_after, f"{fmt} reverse conversion changed after save/reopen")
    final_target = next(shape for shape in reopened_reverse["shapes"]
                        if shape["props"].get("instanceId") == target_id)
    select_object(acc, final_target, "shape")
    require(_shape_type_button_label(acc) == reverse_label,
            f"{fmt} reopened rectangle did not expose ellipse conversion")
    select_object(acc, reversed_rounded, "shape")
    require(_shape_type_button_label(acc) is None,
            f"{fmt} reopened rounded sibling unexpectedly became convertible")
    require(digest(fixture) == fixture_hash, f"{fmt} conversion changed its source fixture")
    case_row["preservation"] = {"sourceFixture": True, "bodyText": True, "unconvertedSibling": True,
                                 "forwardSaveReopen": True, "reverseSaveReopen": True,
                                 "forwardT009": case_row["forwardSave"], "reverseT009": case_row["reverseSave"]}


def p6_hx_type(acc, row, b_root, out):
    hwp_fixture, hwpx_fixture, fixture_objects = prepare_p6_shape_type_fixtures(out)
    hwp_shapes = inspect_shape_types(hwp_fixture)["shapes"]
    standard = next(item for item in hwp_shapes if item["props"].get("instanceId") == fixture_objects["standard"]["instanceId"])
    rounded = next(item for item in hwp_shapes if item["props"].get("instanceId") == fixture_objects["rounded"]["instanceId"])
    require(standard["target"] == "ellipse" and rounded["target"] == "",
            "HWP5 fixture does not exercise one safe and one rejected type conversion", [standard, rounded])
    hwp_hash, hwpx_hash = digest(hwp_fixture), digest(hwpx_fixture)
    row["fixtures"] = {"hwp": hwp_hash, "hwpx": hwpx_hash, "objects": fixture_objects,
                       "baseSha256": digest(ROOT / "external/rhwp/saved/blank2010.hwp")}
    _run_p6_shape_type_format(acc, "hwp", hwp_fixture, out, row.setdefault("hwp", {}),
                              fixture_objects["standard"]["instanceId"],
                              fixture_objects["rounded"]["instanceId"], hwp_hash)
    _run_p6_shape_type_format(acc, "hwpx", hwpx_fixture, out, row.setdefault("hwpx", {}),
                              fixture_objects["standard"]["instanceId"],
                              fixture_objects["rounded"]["instanceId"], hwpx_hash)
    row["acceptance"] = "HWP and HWPX: trusted selection/control, conversion, Undo/Redo, T009, independent serialization proof, close/reopen"


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


def p6_h5_clip(acc, row, b_root, out):
    staging = out / "p6-h5-clip-fixtures"
    source_fixture, destination_fixture = prepare_p6_h5_clip_fixtures(staging)
    source_before = inspect_hwp_clip(source_fixture)
    destination_before = inspect_hwp_clip(destination_fixture)
    require(len(source_before["pictures"]) == 1, "source fixture must contain one picture", source_before)
    require(len(destination_before["pictures"]) == 1, "destination fixture must contain one picture", destination_before)
    source_picture, = source_before["pictures"]
    destination_picture, = destination_before["pictures"]
    require(source_picture["sha256"] != destination_picture["sha256"], "fixtures must own distinct media")

    source_path = begin(acc, row, source_fixture, out, "p6-h5-clip-source.hwp")
    source_hash = digest(source_path)
    row["sourceBefore"] = source_before
    source_state = row["sourceInitialState"] = acc.status("hwp")
    acc.d.js("""
      window.__p6H5PointerEvents=[];
      for(const type of ['pointerdown','pointerup']) document.addEventListener(type,e=>{
        if(e.target.closest('.rhwp-page__canvas')) window.__p6H5PointerEvents.push({type,trusted:e.isTrusted});
      },true);
    """)
    select_object(acc, source_picture, "picture")
    pointer_events = row["trustedPointerEvents"] = acc.d.js("return window.__p6H5PointerEvents")
    require(any(e["trusted"] and e["type"] == "pointerdown" for e in pointer_events),
            "source picture selection did not use a trusted pointer", pointer_events)
    acc.key("ctrl+c")
    source_after_copy = row["sourceAfterCopyState"] = acc.status("hwp")
    for key in ("revision", "localRevision", "dirty"):
        require(source_after_copy[key] == source_state[key], f"copy changed source {key}", source_after_copy)

    destination_path = out / "p6-h5-clip-destination.hwp"
    shutil.copyfile(destination_fixture, destination_path)
    row["destinationFixtureSha256"] = digest(destination_fixture)
    row["destinationBefore"] = destination_before
    destination_streams_before = p6.gso.cfb_streams(destination_path.read_bytes())
    acc.open_native("hwp", destination_path)
    row["destinationInitialState"] = acc.status("hwp")
    c.body_end(acc)
    acc.key("ctrl+v")
    row["afterPaste"] = revision(acc, "hwp", 1)
    acc.key("ctrl+z")
    row["afterUndo"] = revision(acc, "hwp", 2)
    acc.key("ctrl+y")
    row["afterRedo"] = revision(acc, "hwp", 3)

    acc.d.js(r"""
      window.__p6H5PreviewRasterEvidence=[];
      const originalGetContext=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(type,...args){
        const context=originalGetContext.call(this,type,...args);
        if(type==='2d'&&context&&!context.__p6H5Wrapped){
          context.__p6H5Wrapped=true;
          const originalGetImageData=context.getImageData.bind(context);
          context.getImageData=(...imageArgs)=>{
            const image=originalGetImageData(...imageArgs), data=image.data;
            let uniform=true, nonWhite=0;
            for(let i=0;i<data.length;i+=4){
              if(i>0&&(data[i]!==data[0]||data[i+1]!==data[1]||data[i+2]!==data[2])) uniform=false;
              if(data[i]!==255||data[i+1]!==255||data[i+2]!==255) nonWhite++;
            }
            window.__p6H5PreviewRasterEvidence.push({canvas:[this.width,this.height],read:[image.width,image.height],uniform,nonWhite});
            return image;
          };
        }
        return context;
      };
    """)
    try:
        publish(acc, "hwp", row)
    finally:
        row["previewRasterEvidence"] = acc.d.js("return window.__p6H5PreviewRasterEvidence||[]")
    row["destinationSavedSha256"] = digest(destination_path)
    require(row["destinationSavedSha256"] != row["destinationFixtureSha256"],
            "cross-document paste did not publish the destination")
    destination_after = row["destinationAfter"] = inspect_hwp_clip(destination_path)
    require(len(destination_after["pictures"]) == 2, "expected old and transferred pictures", destination_after)
    require([p for p in destination_after["body"] if p] == [p for p in destination_before["body"] if p],
            "clipboard changed destination body text", destination_after["body"])
    copied, = [p for p in destination_after["pictures"] if p["sha256"] == source_picture["sha256"]]
    retained, = [p for p in destination_after["pictures"] if p["sha256"] == destination_picture["sha256"]]
    require(copied["props"] == source_picture["props"], "picture geometry or formatting changed", copied)
    require(retained["props"] == destination_picture["props"], "existing destination object changed", retained)
    require(copied["secIdx"] == 0 and retained["secIdx"] == 0, "picture ownership left the destination body")

    destination_streams_after = p6.gso.cfb_streams(destination_path.read_bytes())
    before_media = {k: v for k, v in destination_streams_before.items() if k.startswith("BinData/")}
    after_media = {k: v for k, v in destination_streams_after.items() if k.startswith("BinData/")}
    require(before_media and all(after_media.get(k) == v for k, v in before_media.items()),
            "existing destination BinData changed or disappeared")
    added_media = set(after_media) - set(before_media)
    require(len(added_media) == 1, "paste should add exactly one owned media stream", sorted(added_media))
    source_streams = p6.gso.cfb_streams(source_path.read_bytes())
    source_media = [_hwp_embedded_payload(v) for k, v in source_streams.items() if k.startswith("BinData/")]
    added_payload = [_hwp_embedded_payload(after_media[name]) for name in added_media]
    require(len(source_media) == 1 and added_payload == source_media,
            "new destination media does not contain the source picture bytes")
    allowed_changed = {"DocInfo", "BodyText/Section0", "PrvImage"}
    changed_unrelated = sorted(
        name for name, value in destination_streams_before.items()
        if name not in allowed_changed and not name.startswith("BinData/")
        and destination_streams_after.get(name) != value
    )
    require(not changed_unrelated, "unrelated CFB streams changed", changed_unrelated)
    require(set(destination_streams_before) <= set(destination_streams_after),
            "destination package streams were removed",
            sorted(set(destination_streams_before) - set(destination_streams_after)))
    added_streams = set(destination_streams_after) - set(destination_streams_before)
    require(added_streams == added_media, "paste added an unauthorized CFB stream", sorted(added_streams - added_media))

    old_docinfo = p6.gso.records(p6.gso.unpacked(destination_streams_before, "DocInfo"))
    new_docinfo = p6.gso.records(p6.gso.unpacked(destination_streams_after, "DocInfo"))
    old_mapping, = [record for record in old_docinfo if record[0] == 17]
    new_mapping, = [record for record in new_docinfo if record[0] == 17]
    require(len(old_mapping[2]) == len(new_mapping[2]) == 72
            and int.from_bytes(new_mapping[2][:4], "little") == int.from_bytes(old_mapping[2][:4], "little") + 1
            and old_mapping[2][4:] == new_mapping[2][4:],
            "DocInfo ID_MAPPINGS changed beyond the single BinData addition")
    old_binary_defs = [record for record in old_docinfo if record[0] == 18]
    new_binary_defs = [record for record in new_docinfo if record[0] == 18]
    require(len(new_binary_defs) == len(old_binary_defs) + 1
            and new_binary_defs[:-1] == old_binary_defs,
            "DocInfo changed a BinData definition or failed to append exactly one")
    require([(tag, level, body) for tag, level, body in old_docinfo if tag not in (17, 18)]
            == [(tag, level, body) for tag, level, body in new_docinfo if tag not in (17, 18)],
            "DocInfo changed an unrelated definition")
    output_records = p6.gso.records(p6.gso.unpacked(destination_streams_after, "BodyText/Section0"))
    picture_bin_ids = [int.from_bytes(body[71:73], "little") for tag, _, body in output_records
                       if tag == 85 and len(body) >= 73]
    require(sorted(picture_bin_ids) == [1, 2],
            "destination and transferred pictures do not own distinct BinData IDs", picture_bin_ids)

    require(destination_streams_before.get("PrvImage") != destination_streams_after.get("PrvImage"),
            "T009 did not refresh the stale HWP5 image preview")
    preview_dimensions = p5.hwp_preview_dimensions(destination_streams_after)
    preview_proof = p5.canonical_preview_png(destination_streams_after["PrvImage"], preview_dimensions)
    require(preview_proof is not None,
            "saved HWP5 PrvImage is not a canonical page-sized RGB8 preview", preview_dimensions)
    raster_calls = row.get("previewRasterEvidence", [])
    require(len(raster_calls) == 1, "expected one fresh page-1 render for T009", raster_calls)
    raster = raster_calls[0]
    raster_size = raster.get("read")
    require(raster_size == raster.get("canvas") and isinstance(raster_size, list)
            and len(raster_size) == 2 and max(raster_size) == 1024
            and all(abs(raster_size[index] - preview_dimensions[index]) <= 8 for index in range(2))
            and raster.get("uniform") is False and raster.get("nonWhite", 0) > 0,
            "fresh page-1 raster does not match the saved page geometry/content", raster)
    row["cfbPreservation"] = {
        "retainedBinData": sorted(before_media),
        "addedBinData": sorted(added_media),
        "changedAllowedStreams": sorted(name for name in allowed_changed
                                         if destination_streams_before.get(name) != destination_streams_after.get(name)),
        "docInfoRemap": {"oldBinDataIds": [record[2].hex() for record in old_binary_defs],
                         "newBinDataId": new_binary_defs[-1][2].hex(),
                         "pictureBinDataIds": picture_bin_ids,
                         "unrelatedDefinitionsPreserved": True},
        "previewImage": {"sourceSha256": hashlib.sha256(destination_streams_before["PrvImage"]).hexdigest(),
                         "savedSha256": hashlib.sha256(destination_streams_after["PrvImage"]).hexdigest(),
                         **preview_proof, "render": raster},
        "unrelatedStreamsUnchanged": True,
    }

    reopen(acc, destination_path, row)
    reopened = inspect_hwp_clip(destination_path)
    require(reopened == destination_after, "reopened HWP5 object or resource differs from saved state", reopened)
    row["reopenedObjectSelection"] = {}
    select_object(acc, copied, "picture")
    row["reopenedObjectSelection"]["copiedPicture"] = "selected"
    acc.key("Escape")
    select_object(acc, retained, "picture")
    row["reopenedObjectSelection"]["destinationPicture"] = "selected"
    acc.key("Escape")

    source_tab = json.dumps(source_path.name)
    acc.dom_click(".document-tab__select", f"[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes({source_tab}))")
    acc.wait("return !!document.querySelector('.document-tab[data-active=true]')?.textContent.includes(arguments[0])", source_path.name)
    source_after_paste = row["sourceAfterPasteState"] = acc.status("hwp")
    for key in ("revision", "localRevision", "dirty"):
        require(source_after_paste[key] == source_state[key], f"cross-document paste changed source {key}", source_after_paste)
    require(digest(source_path) == source_hash and inspect_hwp_clip(source_path) == source_before,
            "cross-document paste changed source bytes or object content")

    refusal_path = out / "p6-h5-clip-refusal.hwp"
    shutil.copyfile(destination_fixture, refusal_path)
    refusal_hash = digest(refusal_path)
    acc.open_native("hwp", refusal_path)
    refusal_state = acc.status("hwp")
    invalid_payload = json.dumps({
        "kind": "geul.object", "version": 3, "sourceFormat": "hwp", "object": "picture",
        "sourceSessionId": 999999, "sourceGeneration": 1,
        "hwpFragmentBase64": "A" * 684, "token": "a" * 24,
    })
    c.clipboard_peer(acc, "application/x-geul-object+json", invalid_payload,
                     lambda: (acc.key("ctrl+v"), acc.settle("hwp")),
                     plain="Geul picture [" + "a" * 24 + "]")
    refusal_after = row["malformedPasteRefusal"] = acc.status("hwp")
    for key in ("revision", "localRevision", "dirty"):
        require(refusal_after[key] == refusal_state[key], f"malformed paste changed {key}", refusal_after)
    require(digest(refusal_path) == refusal_hash, "malformed paste changed file on disk")
    row["preservation"] = {"sourceBytesAndModel": True, "destinationMediaAndUnrelatedStreams": True,
                           "malformedPasteAtomicRefusal": True, "saveAndReopen": True}


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
    "P6-H5-CLIP": p6_h5_clip,
    "P6-HX-GROUP": p6_hx_group,
    "P6-HX-GROUP-FRESH": p6_hx_group_fresh,
    "P6-DX-HX": p6_dx_hx,
    "P6-HX-TYPE": p6_hx_type,
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
                        row["failureAppState"] = acc.status("hwpx" if case in {"B3-2", "P6-HX-GROUP", "P6-HX-GROUP-FRESH", "P6-HX-TYPE", "P6-DX-HX"} else "hwp")
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
