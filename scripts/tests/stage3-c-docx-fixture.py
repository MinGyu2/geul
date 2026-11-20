#!/usr/bin/env python3
"""Minimal depth-two DOCX drawing fixture with distinctive rendered colors."""
import argparse
import struct
import zipfile
import zlib
from pathlib import Path

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


def paragraph(text):
    return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"


def drawing(number, label, payload, namespace, width=900000, height=440000):
    return f"""<w:p><w:r><w:drawing><wp:inline>
     <wp:extent cx="{width}" cy="{height}"/><wp:docPr id="{number}" name="{label}" descr="{label}"/>
     <a:graphic><a:graphicData uri="{namespace}">{payload}</a:graphicData></a:graphic>
    </wp:inline></w:drawing></w:r></w:p>"""


def shape(number, label, color, story=""):
    box = f'<wps:txbx><w:txbxContent>{story}</w:txbxContent></wps:txbx>' if story else ""
    box_type = ' txBox="1"' if story else ""
    payload = f"""<wps:wsp><wps:cNvSpPr{box_type}/>
      <wps:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      <a:solidFill><a:srgbClr val="{color}"/></a:solidFill></wps:spPr>
      {box}<wps:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/></wps:wsp>"""
    return drawing(number,label,payload,WPS,2200000 if story else 900000,1300000 if story else 440000)


def table(contents):
    return f"""<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr>
      <w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid>
      <w:tr><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/></w:tcPr>{contents}</w:tc></w:tr></w:tbl>"""


def make(path):
    pic = """<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Depth picture"/><pic:cNvPicPr/></pic:nvPicPr>
     <pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
     <pic:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>"""
    nested = table(table(drawing(1,"Depth picture",pic,PIC) +
                         shape(2,"Depth rectangle","28A4C2") +
                         shape(3,"Depth textbox","F1BA49",paragraph("Cell box keep"))) +
                   paragraph("Outer cell keep"))
    owner = shape(4,"Body textbox","DDDDDD",shape(5,"Owned rectangle","7A47A8") + paragraph("Box story keep"))
    content = paragraph("Body before") + nested + owner + paragraph("Body after")
    xml = f"""<w:document xmlns:w="{W}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:r="{R}"
     xmlns:pic="{PIC}" xmlns:wps="{WPS}"><w:body>{content}
     <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440"
       w:bottom="1440" w:left="1440"/></w:sectPr>
     </w:body></w:document>"""
    def chunk(kind, data):
        return struct.pack(">I",len(data)) + kind + data + struct.pack(">I",zlib.crc32(kind+data))
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR",struct.pack(">IIBBBBB",16,16,8,2,0,0,0))
           + chunk(b"IDAT",zlib.compress((b"\0"+bytes.fromhex("D83759")*16)*16)) + chunk(b"IEND",b""))
    with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml", """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""")
        package.writestr("_rels/.rels",f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>')
        package.writestr("word/_rels/document.xml.rels",f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{R}/image" Target="media/picture.png"/></Relationships>')
        package.writestr("word/document.xml",xml)
        package.writestr("word/media/picture.png",png)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    make(args.output)
