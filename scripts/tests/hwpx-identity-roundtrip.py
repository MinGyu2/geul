#!/usr/bin/env python3
"""Focused real-WASM HWPX identity lifecycle and structured-header regressions."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
HH = "http://www.hancom.co.kr/hwpml/2011/head"
OPF = "http://www.idpf.org/2007/opf/"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
PKG = "http://www.hancom.co.kr/hwpml/2016/meta/pkg#"
for prefix, uri in (("hp", HP), ("hh", HH), ("hs", "http://www.hancom.co.kr/hwpml/2011/section"),
                    ("hc", "http://www.hancom.co.kr/hwpml/2011/core"), ("opf", OPF), ("rdf", RDF)):
    ET.register_namespace(prefix, uri)

CODE = r"""
import assert from 'node:assert/strict';
import{readFileSync,writeFileSync}from'node:fs';import{resolve}from'node:path';import{pathToFileURL}from'node:url';
const[pkg,source,out,multiple]=process.argv.slice(2),m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
const ok=s=>{const r=JSON.parse(s);assert.equal(r.ok,true,s);return r;};
const text=d=>Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getTextRange(s,p,0,d.getParagraphLength(s,p))));
const emit=(d,name)=>{
 const expected={text:text(d),controls:d.getControls(),pages:d.pageCount()};const e=d.exportHwpxWithReport();
 try{const loss=JSON.parse(e.contentLoss());assert.equal(loss.count,0);const b=e.takeBytes();writeFileSync(resolve(out,name+'.hwpx'),b);
 const r=new m.HwpDocument(b);try{assert.deepEqual({text:text(r),controls:r.getControls(),pages:r.pageCount()},expected);}finally{r.free();}}
 finally{e.free();}
};
let d=new m.HwpDocument(readFileSync(source));
try{
 emit(d,'identity-original');ok(d.insertText(0,0,0,'처음😀둘째'));emit(d,'identity-insert');
 ok(d.splitParagraph(0,0,2));emit(d,'identity-split1');
 ok(d.splitParagraph(0,0,1));emit(d,'identity-split2');
 assert.deepEqual(text(d)[0],['처','음','😀둘째']);
 ok(d.mergeParagraph(0,1));emit(d,'identity-merge');assert.deepEqual(text(d)[0],['처음','😀둘째']);
 ok(d.splitParagraph(0,0,1));emit(d,'identity-after-delete');emit(d,'identity-repeat');
 // Existing clipboard remapping must not assign one source identity to a copy.
 ok(d.copySelection(0,0,0,2,d.getParagraphLength(0,2)));
 ok(d.pasteInternal(0,2,d.getParagraphLength(0,2)));emit(d,'identity-copy');
}finally{d.free();}
d=new m.HwpDocument(readFileSync(multiple));try{assert.equal(d.getSectionCount(),2);emit(d,'multi-original');ok(d.insertText(1,0,0,'둘째 구역'));emit(d,'multi-edited');}finally{d.free();}
// Create several supported sublists using the actual editing API, then parse
// the generated HWPX so every nested paragraph has an imported identity.
d=m.HwpDocument.createEmpty();d.createBlankDocument();
try{
 ok(d.insertText(0,0,0,'본문'));ok(d.splitParagraph(0,0,2));
 const table=ok(d.createTable(0,1,0,2,2));
 // Both pinned and patched engines normalize the new-table default0 to1.
 // Use the explicit supported SQUARE setting and retain full control equality.
 ok(d.setTableProperties(0,table.paraIdx,table.controlIdx,JSON.stringify({textWrap:1}))); 
 for(let cell=0;cell<4;cell++)ok(d.insertTextInCell(0,table.paraIdx,table.controlIdx,cell,0,0,'셀'+cell));
 ok(d.createHeaderFooter(0,true,0));ok(d.insertTextInHeaderFooter(0,true,0,0,0,'머리말'));
 ok(d.createHeaderFooter(0,false,0));ok(d.insertTextInHeaderFooter(0,false,0,0,0,'꼬리말'));
 const note=ok(d.insertFootnote(0,0,1));
 emit(d,'nested-created');
}finally{d.free();}
d=new m.HwpDocument(readFileSync(resolve(out,'nested-created.hwpx')));
try{emit(d,'nested-original');ok(d.insertTextInCell(0,1,0,0,0,0,'편집'));emit(d,'nested-edit');ok(d.splitParagraphInCell(0,1,0,0,0,1));emit(d,'nested-split');emit(d,'nested-repeat');}finally{d.free();}
// HWP5 input must retain the existing HWP serializer path.
d=m.HwpDocument.createEmpty();d.createBlankDocument();
try{ok(d.insertText(0,0,0,'HWP5 한글😀'));const e=d.exportHwpWithReport();try{assert.equal(JSON.parse(e.contentLoss()).count,0);const b=e.takeBytes();writeFileSync(resolve(out,'hwp5.hwp'),b);const h=new m.HwpDocument(b);try{ok(h.insertText(0,0,0,'보존'));const x=h.exportHwpWithReport();try{assert.equal(JSON.parse(x.contentLoss()).count,0);const r=new m.HwpDocument(x.takeBytes());try{assert.deepEqual(text(r),text(h));}finally{r.free();}}finally{x.free();}}finally{h.free();}}finally{e.free();}}finally{d.free();}
console.log(JSON.stringify({status:'PASS',identityLifecycle:true,nestedTableHeaderFooterNote:true,hwp5Reopen:true}));
"""


def parts(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        return {name: archive.read(name) for name in archive.namelist()}


def write_parts(path, entries):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in entries.items():
            archive.writestr(name, data, compress_type=zipfile.ZIP_STORED if name == 'mimetype' else zipfile.ZIP_DEFLATED)


def ids(path):
    return [e.attrib['id'] for name, data in parts(path).items()
            if name.startswith('Contents/') and name.endswith('.xml')
            for e in ET.fromstring(data).iter('{'+HP+'}p')]


def check_ids(path):
    values = ids(path)
    assert values and len(values) == len(set(values)), (path, values)
    assert all(0 <= int(v) <= 0xffffffff for v in values)
    return values


def check_ids_repeated(path):
    values = ids(path)
    assert values and all(0 <= int(v) <= 0xffffffff for v in values)
    return values


def multi_fixture(source, out):
    entries = parts(source)
    section = ET.fromstring(entries['Contents/section0.xml'])
    next(section.iter('{'+HP+'}p')).set('id', '777')
    entries['Contents/section1.xml'] = ET.tostring(section, encoding='utf-8')
    header = ET.fromstring(entries['Contents/header.xml']);header.set('secCnt','2')
    entries['Contents/header.xml'] = ET.tostring(header, encoding='utf-8')
    package = ET.fromstring(entries['Contents/content.hpf'])
    ET.SubElement(package.find('{'+OPF+'}manifest'),'{'+OPF+'}item', {'id':'section1','href':'Contents/section1.xml','media-type':'application/xml'})
    ET.SubElement(package.find('{'+OPF+'}spine'),'{'+OPF+'}itemref', {'idref':'section1','linear':'yes'})
    entries['Contents/content.hpf'] = ET.tostring(package,encoding='utf-8')
    graph=ET.fromstring(entries['META-INF/container.rdf'])
    for old in list(graph):
        if any(value=='Contents/section0.xml' for el in old.iter() for value in el.attrib.values()):
            clone=copy.deepcopy(old)
            for el in clone.iter():
                for key,value in list(el.attrib.items()):
                    if value=='Contents/section0.xml':el.set(key,'Contents/section1.xml')
            graph.append(clone)
    entries['META-INF/container.rdf']=ET.tostring(graph,encoding='utf-8')
    write_parts(out,entries)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--candidate',type=Path,default=ROOT/'target/hwpx-preservation-candidate/web');parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();args.out=args.out.resolve();args.out.mkdir(parents=True,exist_ok=False)
    source=ROOT/'external/rhwp/samples/종이기준.hwpx';multi=args.out/'two-sections.hwpx';multi_fixture(source,multi)
    result=subprocess.run(['node','--input-type=module','-',str(args.candidate.resolve()),str(source),str(args.out),str(multi)],input=CODE,text=True,capture_output=True,cwd=ROOT)
    (args.out/'node.log').write_text(result.stdout+result.stderr);assert result.returncode==0,result.stderr
    read=lambda name:check_ids(args.out/(name+'.hwpx'))
    original=read('identity-original');assert original==['3121190098']
    assert read('identity-insert')==original
    first,second=read('identity-split1'),read('identity-split2')
    assert first[0]==original[0] and second[0]==original[0] and second[2]==first[1]
    assert read('identity-merge')==first
    later=read('identity-after-delete');assert later[0]==original[0] and later[2]==first[1] and later[1] not in second
    assert later==read('identity-repeat')
    copied=read('identity-copy');assert len(copied)>len(later)
    assert read('multi-original')==['3121190098','777'] and read('multi-edited')==read('multi-original')
    nested=read('nested-original');assert len(nested)>=8 and read('nested-edit')==nested
    assert read('nested-split')==read('nested-repeat') and set(nested).issubset(read('nested-split'))
    # Negative cases must remain readable; only export fails with the exact
    # identity diagnostic. Missing/invalid IDs are not silently turned into 0.
    spec=importlib.util.spec_from_file_location('probe',ROOT/'scripts/tests/hwpx-textdir-roundtrip.py');probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
    negatives=[]
    for name,value in [('missing',None),('invalid','bad'),('overflow','4294967296'),('source-duplicate','duplicate')]:
        entries=parts(source);root=ET.fromstring(entries['Contents/section0.xml']);para=next(root.iter('{'+HP+'}p'))
        if value is None:para.attrib.pop('id')
        elif value=='duplicate':
            extra=ET.Element('{'+HP+'}p',dict(para.attrib));run=ET.SubElement(extra,'{'+HP+'}run',{'charPrIDRef':'0'});ET.SubElement(run,'{'+HP+'}t').text='중복';root.append(extra)
        else:para.set('id',value)
        entries['Contents/section0.xml']=ET.tostring(root,encoding='utf-8');path=args.out/(name+'.hwpx');write_parts(path,entries)
        actual=probe.export(args.candidate,path,args.out/(name+'-out.hwpx'))
        if name=='source-duplicate':
            # A source that itself repeats an id (Hancom output does this
            # routinely) is preserved exactly rather than refused; excess or
            # aliased duplicates are covered by the engine unit tests and
            # scripts/tests/hwpx-duplicate-id-roundtrip.py.
            assert actual['returncode']==0,actual
            assert check_ids_repeated(args.out/(name+'-out.hwpx'))==['3121190098','3121190098']
            negatives.append({'name':name,'readable':True,'preservedExactly':True});continue
        assert actual['returncode']!=0 and actual['diagnostic']['stage']=='export' and actual['diagnostic']['opened']
        assert 'HWPX paragraph id missing or invalid' in actual['diagnostic']['error'],actual
        negatives.append({'name':name,'readable':True,'exportRejectedForIdentity':True})
    report={'status':'PASS','sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'lifecycleIds':{'original':original,'split1':first,'split2':second,'afterDelete':later},'nestedParagraphs':len(nested),'multiSectionIds':read('multi-original'),'negative':negatives,'nodeEvidence':json.loads(result.stdout.splitlines()[-1])}
    (args.out/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
