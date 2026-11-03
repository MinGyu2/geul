#!/usr/bin/env python3
"""Independent empty hp:t/run topology acceptance with immutable real WASMs.

Does not change the Geul canonical comparator. Synthetic cases are derived
from the supported upstream blank package; private corpus bytes stay ignored.
"""
import argparse
from collections import Counter
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
BLANK = ROOT/'external/rhwp/saved/blank_hwpx.hwpx'
REAL = ROOT/'external/rhwp/fuzz/corpus/parse_hwpx/156492236___min.hwpx'
REAL_SHA = 'd6f4d431b9a4d934b3b4e4330546ef61768c953c2e1328010d2f75440fefa070'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT/path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


batch = module('empty_text_corpus', 'scripts/tests/hwpx-manifest-order-roundtrip.py')
oracle = batch.oracle
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()

CODE = r"""
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const [pkg,source,out,planFile,mode]=process.argv.slice(2);
// [#6869] 'fold' only: the serializer emits one hp:pageNum per paragraph, so the
// reopened model lacks later pgnp controls (their slots shift positions).
const fold=mode==='fold';
const project=s=>{if(!fold)return s;const seen=new Set();
 const controls=s.controls.filter(c=>{if(c.ctrlId!=='pgnp')return true;const k=c.list+':'+c.para;if(seen.has(k))return false;seen.add(k);return true;})
  .map(({controlIndex,pos,...c})=>c);return {...s,controls};};
const m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
const snapshot=d=>({
 text:Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getTextRange(s,p,0,d.getParagraphLength(s,p)))),
 unicode:d.getTextFileUnicode(),controls:JSON.parse(d.getControls()),pages:d.pageCount(),
 formatting:Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>JSON.parse(d.getCharShapeRuns(s,p,0,d.getParagraphLength(s,p)))))
});
let d,r;const result={operations:[]};let stage='open';
const emit=(doc,name)=>{let e;try{e=doc.exportHwpxWithReport();const loss=JSON.parse(e.contentLoss()),b=Uint8Array.from(e.takeBytes());
 assert.equal(loss.count,0);writeFileSync(resolve(out,name+'.hwpx'),b);writeFileSync(resolve(out,name+'.hwpx.loss.json'),JSON.stringify(loss));return b;
}finally{e?.free();}};
try{
 d=new m.HwpDocument(readFileSync(source));const before=snapshot(d);writeFileSync(resolve(out,'A-model.json'),JSON.stringify(before,null,2));
 stage='export';const b=emit(d,'B-first');emit(d,'C-repeat');assert.deepEqual(snapshot(d),before);
 stage='reopen';r=new m.HwpDocument(b);assert.deepEqual(project(snapshot(r)),project(before));emit(r,'D-reopened');
 writeFileSync(resolve(out,'D-model.json'),JSON.stringify(snapshot(r),null,2));result.reopenModelEqual=true;
 for(const [i,op] of JSON.parse(readFileSync(planFile)).entries()){
  stage='edit-'+i;const value=JSON.parse(d[op.method](...op.args));assert.equal(value.ok,true,JSON.stringify(value));
  const name=op.export??('edit-'+i);let rejection;
  try{emit(d,name);}catch(e){rejection=String(e?.message??e);if(!op.reject)throw e;}
  if(op.reject){assert.ok(rejection?.includes(op.reject),String(rejection));}
  else{const opened=new m.HwpDocument(readFileSync(resolve(out,name+'.hwpx')));try{assert.deepEqual(snapshot(opened),snapshot(d));}finally{opened.free();}}
  result.operations.push({method:op.method,args:op.args,name,rejection,model:snapshot(d)});
 }
 result.ok=true;
}catch(e){result.ok=false;result.stage=stage;result.error=String(e?.message??e);}
finally{r?.free();d?.free();}
writeFileSync(resolve(out,'node.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:result.ok,stage:result.stage,error:result.error,operations:result.operations.length}));
if(!result.ok)process.exitCode=1;
"""


STABILITY_CODE = r"""
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const[pkg,list,out]=process.argv.slice(2),m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
const hash=b=>createHash('sha256').update(b).digest('hex');
const snapshot=d=>JSON.stringify({unicode:d.getTextFileUnicode(),controls:d.getControls(),pages:d.pageCount(),
 text:Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getTextRange(s,p,0,d.getParagraphLength(s,p)))),
 formatting:Array.from({length:d.getSectionCount()},(_,s)=>Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getCharShapeRuns(s,p,0,d.getParagraphLength(s,p))))});
const emit=d=>{let e;try{e=d.exportHwpxWithReport();return{loss:JSON.parse(e.contentLoss()),bytes:Uint8Array.from(e.takeBytes())};}finally{e?.free();}};
const results=[];
for(const input of JSON.parse(readFileSync(list))){
 let d,r,stage='open';const row={i:input.i,source:input.source,sourceSha256:hash(readFileSync(input.source)),flags:{}};
 try{
  d=new m.HwpDocument(readFileSync(input.source));row.flags.opened=true;const before=snapshot(d);
  stage='export';const b=emit(d),c=emit(d);row.flags.exported=true;
  row.hashes={B:hash(b.bytes),C:hash(c.bytes)};row.lossCounts={B:b.loss.count,C:c.loss.count};
  row.flags.originalHashMatchesBatch=row.hashes.B===input.outputSha256;
  row.flags.sameObjectBytes=row.hashes.B===row.hashes.C;row.flags.sameObjectModel=snapshot(d)===before;
  if(!row.flags.originalHashMatchesBatch)writeFileSync(resolve(out,input.i+'-B.hwpx'),b.bytes);
  if(!row.flags.sameObjectBytes)writeFileSync(resolve(out,input.i+'-C.hwpx'),c.bytes);
  stage='reopen';r=new m.HwpDocument(b.bytes);row.flags.reopened=true;row.flags.reopenModel=snapshot(r)===before;
  stage='reexport';const again=emit(r);row.hashes.D=hash(again.bytes);row.lossCounts.D=again.loss.count;
  row.flags.reopenedBytes=row.hashes.B===row.hashes.D;
  if(!row.flags.reopenedBytes)writeFileSync(resolve(out,input.i+'-D.hwpx'),again.bytes);
  row.ok=true;
 }catch(e){row.ok=false;row.stage=stage;row.error=String(e?.message??e);}
 finally{for(const doc of [r,d]){try{doc?.free();}catch(e){(row.cleanupErrors??=[]).push(String(e?.message??e));}}}
 results.push(row);
}
writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({documents:results.length,errors:results.filter(x=>!x.ok).length}));
"""

def parts(path):
    with zipfile.ZipFile(path) as z:
        assert len(z.namelist()) == len(set(z.namelist()))
        assert z.testzip() is None
        return {n: z.read(n) for n in z.namelist()}


def canonical(node):
    return (node.tag, sorted(node.attrib.items()), node.text or '',
            [(canonical(c), c.tail or '') for c in node])


# Classified control event identity, mirroring hwpx_topology::event_attrs:
# stable ownership ids plus emitted attributes that distinguish otherwise
# equal controls. Serializer-normalized representation (fieldBegin
# dirty/zorder/metaTag, footNote instId/suffixChar, colPr type) is not identity;
# the whole-part oracle and the baseline comparison still assess it.
OWNERSHIP = ('id', 'beginIDRef', 'fieldid')
EVENT_ATTRS = {
    'pageNum': ('pos', 'formatType', 'sideChar'), 'autoNum': ('num', 'numType'), 'newNum': ('num', 'numType'),
    'bookmark': ('name',), 'fieldBegin': ('type', 'name'), 'header': ('applyPageType',), 'footer': ('applyPageType',),
    'footNote': ('number',), 'endNote': ('number',), 'colPr': ('layout', 'colCount', 'sameSz', 'sameGap'),
    'pageHiding': ('hideHeader', 'hideFooter', 'hideMasterPage', 'hideBorder', 'hideFill', 'hidePageNum'),
}


def local(tag):
    return tag.rsplit('}', 1)[-1]


def text_event(t):
    """hp:t occurrence: its attributes, text and inline tokens. Inline layout
    attributes (tab width/leader/type ...) are model-emitted, not identity."""
    inline = [(c.tag, sorted((k, v) for k, v in c.attrib.items() if k in ('id', 'Id', 'TcId')), c.tail or '') for c in t]
    return (sorted(t.attrib.items()), t.text or '', inline)


def is_page_num(event):
    return event[0] == 'control' and event[1] == HP+'ctrl' and [c[0] for c in event[3]] == [HP+'pageNum']


def fold_page_numbers(inv):
    """[#6869] Expected output projection of a source inventory: the serializer
    emits only the first hp:pageNum of each paragraph render scope. Later
    events of the same run shift left by the folded controls."""
    seen, runs, removed = set(), {}, {}
    for path, (attrs, events) in inv['runs'].items():  # document (walk) order
        owner, kept = path.rsplit('/run[', 1)[0], []
        for index, event in enumerate(events):
            if is_page_num(event):
                if owner in seen:
                    removed.setdefault(path, []).append(index)
                    continue
                seen.add(owner)
            kept.append(event)
        runs[path] = (attrs, kept)
    shift = lambda item: {**item, 'event': item['event'] - sum(i < item['event'] for i in removed.get(item['run'], []))}
    emptied = {p for p, (_, e) in runs.items() if not e and inv['runs'][p][1]}
    bare = set(inv['bare']) | emptied
    return {**inv, 'runs': runs, 'bare': [p for p in runs if p in bare],
            'empty': [shift(e) for e in inv['empty']], 'whitespace': [shift(e) for e in inv['whitespace']]}


def inventory(xml):
    root = ET.fromstring(xml)
    runs, paragraphs, empties, bare, whitespace = {}, {}, [], [], []

    def walk(node, path):
        if node.tag == HP+'p':
            paragraphs[path] = dict(node.attrib)
        if node.tag == HP+'run':
            # Run correspondence uses owning occurrence + ordered direct
            # text/control events. Opaque control properties are assessed by
            # the unchanged whole-section oracle and baseline/candidate check.
            events = []
            for child in node:
                if child.tag == HP+'t':
                    # Element-only XML indentation outside hp:t is not its text.
                    # The whole-part oracle still reports that existing difference.
                    tail = child.tail if child.tail and not child.tail.isspace() else ''
                    events.append(('text', text_event(child), tail))
                else:
                    identity = {k: v for k, v in child.attrib.items() if k == 'id'}
                    inner = [(c.tag, {k: v for k, v in c.attrib.items() if k in OWNERSHIP or k in EVENT_ATTRS.get(local(c.tag), ())}) for c in child] if child.tag == HP+'ctrl' else []
                    events.append(('control', child.tag, identity, inner))
            runs[path] = (dict(node.attrib), events)
            if not len(node) and not (node.text or ''):
                bare.append(path)
            for index, child in enumerate(node):
                if child.tag == HP+'t' and not len(child):
                    item = {'run': path, 'event': index, 'shape': node.get('charPrIDRef'), 'attributes': dict(child.attrib)}
                    if not (child.text or ''):
                        empties.append(item)
                    elif child.text.isspace():
                        whitespace.append({**item, 'text': child.text})
        seen = Counter()
        for child in node:
            seen[child.tag] += 1
            walk(child, f'{path}/{child.tag.rsplit("}", 1)[-1]}[{seen[child.tag]}]')
    walk(root, '/'+root.tag.rsplit('}', 1)[-1]+'[1]')
    return {'runs': runs, 'paragraphs': paragraphs, 'empty': empties, 'bare': bare, 'whitespace': whitespace}


def run(package, source, out, plan=(), reuse=False, fold=False):
    if out.exists():
        assert reuse, ('existing output requires explicit verified reuse', out)
        assert json.loads((out/'command.json').read_text())['sourceSha256'] == sha(source)
        assert json.loads((out/'plan.json').read_text()) == list(plan)
        assert (out/'driver.mjs').read_text() == CODE
        return json.loads((out/'node.json').read_text())
    out.mkdir()
    (out/'plan.json').write_text(json.dumps(plan, ensure_ascii=False))
    (out/'driver.mjs').write_text(CODE)
    command = ['node', str(out/'driver.mjs'), str(package), str(source), str(out), str(out/'plan.json')] + (['fold'] if fold else [])
    p = subprocess.run(command, text=True, capture_output=True, cwd=ROOT)
    (out/'node.log').write_text(p.stdout+p.stderr)
    (out/'command.json').write_text(json.dumps({'argv': command, 'exitCode': p.returncode, 'sourceSha256': sha(source)}, indent=2))
    return json.loads((out/'node.json').read_text())


def verdict(checker, source, output):
    argv = [str(checker), 'preflight', 'hwpx', str(source), str(output), str(output)+'.loss.json']
    p = subprocess.run(argv, capture_output=True, text=True, cwd=ROOT)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def rewrite(source, destination, text):
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(destination, 'w') as b:
        for entry in a.infolist():
            b.writestr(entry, text.encode() if entry.filename == 'Contents/section0.xml' else a.read(entry.filename))


def make_fixture(out, name, body, later=True, other=False):
    original = parts(BLANK)['Contents/section0.xml'].decode()
    needles = re.findall(r'<hp:run charPrIDRef="0"><hp:t>[^<]*</hp:t></hp:run>', original)
    assert len(needles) == 1
    needle = needles[0]
    if later:
        paragraph = f'<hp:p id="11" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">{body}</hp:p>'
        xml = original.replace('</hs:sec>', paragraph+'</hs:sec>')
    else:
        xml = original.replace(needle, body)
    if other:
        xml = xml.replace('</hs:sec>', '<hp:p id="12" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>Z</hp:t></hp:run></hp:p></hs:sec>')
    path = out/(name+'.hwpx')
    if not path.exists():
        rewrite(BLANK, path, xml)
    else:
        assert parts(path)['Contents/section0.xml'] == xml.encode()
    return path


def r(body, shape='0'):
    return f'<hp:run charPrIDRef="{shape}">{body}</hp:run>'


def stable(source, folder, require_safe, checker, require_section_equal=True):
    src = parts(source)
    outputs = [folder/(s+'.hwpx') for s in ('B-first', 'C-repeat', 'D-reopened')]
    for output in outputs:
        dst = parts(output)
        assert src.keys() == dst.keys()
        for name in src:
            if re.fullmatch(r'Contents/section[0-9]+\.xml', name):
                a, b = fold_page_numbers(inventory(src[name])), inventory(dst[name])
                assert a == b, (source, output, name, 'run/event occurrence topology changed')
                if require_section_equal:
                    assert oracle.equal(src[name], dst[name]), (source, name, oracle.first_difference(oracle.parse(src[name]), oracle.parse(dst[name])))
    assert len({sha(p) for p in outputs}) == 1, 'package byte identity changed across repeat/reopen'
    result = verdict(checker, source, outputs[0])
    if require_safe:
        assert result['outcome'] == 'safe' and not result.get('findings'), result
    return {'byteIdenticalBCD': True, 'sha256': sha(outputs[0]), 'preflight': result}


def positive(args):
    ctrl = '<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>'
    bodies = {
        'bare': r(''), 'self-closing-bare': '<hp:run charPrIDRef="0"/>',
        'empty': r('<hp:t/>'), 'pair': r('<hp:t></hp:t>'), 'empty-cdata': r('<hp:t><![CDATA[]]></hp:t>'),
        'after': r('<hp:t>A</hp:t><hp:t/>'), 'before': r('<hp:t/><hp:t>A</hp:t>'),
        'between': r('<hp:t>A</hp:t><hp:t/><hp:t/><hp:t>B</hp:t>'),
        'zero-same-shape': r('')+r('<hp:t/><hp:t/>')+r('')+r('<hp:t>A</hp:t><hp:t/>'),
        'different-shape': r('<hp:t/>')+r('<hp:t>A</hp:t><hp:t/>', '1'),
        'control-before': r('<hp:t/>'+ctrl), 'control-after': r(ctrl+'<hp:t/>'),
        'control-both': r('<hp:t/>'+ctrl+'<hp:t/><hp:t/>'),
        'whitespace': r('<hp:t/><hp:t> \t </hp:t><hp:t/>'),
        'entities-cdata': r('<hp:t/><hp:t>&amp;<![CDATA[한글]]></hp:t><hp:t/>'),
        # OWPML character-style reference (style 12 is the blank template's CHAR style).
        'char-style': r('<hp:t charStyleIDRef="12">AB</hp:t><hp:t/>'),
        # Inline tab layout attributes are model-emitted (type 0 -> 1 normalization).
        'inline-tab': r('<hp:t>A<hp:tab width="0" leader="0" type="0"/>B</hp:t><hp:t/>'),
    }
    rows = []
    # Literal tab has its own existing canonical normalization; use ordinary
    # spaces in the whitespace preservation control.
    bodies['whitespace'] = r('<hp:t/><hp:t>  </hp:t><hp:t/>')
    for name, body in bodies.items():
        source = make_fixture(args.out, name, body)
        folder = args.out/(name+'-run')
        state = run(args.package, source, folder, reuse=args.reuse_focused)
        assert state['ok'], (name, state)
        normalized = ('empty-cdata', 'entities-cdata', 'inline-tab')
        result = stable(source, folder, name not in normalized, args.checker, require_section_equal=name != 'inline-tab')
        if name in normalized:
            assert result['preflight']['outcome'] in ('safe', 'unsafe'), result
            assert all(f['code'] == 'partChanged' and f.get('part') == 'Contents/section0.xml' for f in result['preflight'].get('findings', [])), result
        rows.append({'name': name, 'sourceSha256': sha(source), **result})
    for name, body in [('handoff', r('<hp:t/><hp:t>A</hp:t><hp:t/>')),
                       ('handoff-bare', '<hp:run charPrIDRef="0"/>'+r('<hp:t>A</hp:t><hp:t/>'))]:
        source = make_fixture(args.out, name, body, later=False)
        folder = args.out/(name+'-run')
        state = run(args.package, source, folder, reuse=args.reuse_focused)
        assert state['ok'], state
        rows.append({'name': name, **stable(source, folder, True, args.checker)})
    return rows


def edits(args):
    rows = []
    body = r('<hp:t>A</hp:t><hp:t/><hp:t>B</hp:t>')
    for name, offset, expected in [('before', 0, '<hp:t>가A</hp:t><hp:t></hp:t><hp:t>B</hp:t>'),
                                   ('exact', 1, '<hp:t>A가</hp:t><hp:t></hp:t><hp:t>B</hp:t>'),
                                   ('after', 2, '<hp:t>A</hp:t><hp:t></hp:t><hp:t>B가</hp:t>')]:
        source = make_fixture(args.out, 'edit-'+name, body)
        folder = args.out/('edit-'+name+'-run')
        state = run(args.package, source, folder, [{'method': 'insertText', 'args': [0, 1, offset, '가']}], reuse=args.reuse_focused)
        assert state['ok'], state
        xml = parts(folder/'edit-0.hwpx')['Contents/section0.xml'].decode()
        assert r(expected) in xml, xml
        rows.append({'name': name, 'node': state['operations']})
    source = make_fixture(args.out, 'edit-delete', body)
    folder = args.out/'edit-delete-run'
    state = run(args.package, source, folder, [{'method': 'deleteText', 'args': [0, 1, 0, 1]}], reuse=args.reuse_focused)
    assert state['ok'], state
    assert r('<hp:t></hp:t><hp:t></hp:t><hp:t>B</hp:t>') in parts(folder/'edit-0.hwpx')['Contents/section0.xml'].decode()
    rows.append({'name': 'delete', 'node': state['operations']})
    source = make_fixture(args.out, 'unrelated', body, other=True)
    folder = args.out/'unrelated-run'
    state = run(args.package, source, folder, [{'method': 'insertText', 'args': [0, 2, 0, '가']}], reuse=args.reuse_focused)
    assert state['ok'], state
    x, y = (inventory(parts(p)['Contents/section0.xml']) for p in (source, folder/'edit-0.hwpx'))
    for key, value in x['runs'].items():
        if '/p[2]/' in key:
            assert y['runs'][key] == value
    rows.append({'name': 'unrelated', 'node': state['operations']})
    for name, method, values, cause in [
        ('split', 'splitParagraph', [0, 1, 1], 'paragraph split has unsupported run correspondence'),
        ('format', 'applyCharFormat', [0, 1, 0, 1, '{"bold":true}'], 'character formatting changed run occurrence boundaries'),
    ]:
        source = make_fixture(args.out, 'unsupported-'+name, body)
        folder = args.out/('unsupported-'+name+'-run')
        before = sha(source)
        state = run(args.package, source, folder, [{'method': method, 'args': values, 'reject': cause}], reuse=args.reuse_focused)
        assert state['ok'], state
        assert sha(source) == before and not (folder/'edit-0.hwpx').exists()
        noedit = verdict(args.checker, source, folder/'B-first.hwpx')
        assert noedit['outcome'] == 'safe' and not noedit.get('findings'), noedit
        rows.append({'name': 'unsupported-'+name, 'node': state['operations'], 'sourceUnchanged': True, 'noOutputBytes': True})
    # Whole-run character formatting through the real WASM command keeps the
    # occurrence mapping; the new charPrIDRef is emitted with the empty hp:t.
    body2 = r('<hp:t>AB</hp:t><hp:t/>')+r('<hp:t>CD</hp:t>', '1')
    source = make_fixture(args.out, 'format-whole-run', body2)
    folder = args.out/'format-whole-run-run'
    state = run(args.package, source, folder, [{'method': 'applyCharFormat', 'args': [0, 1, 0, 2, '{"bold":true}']}], reuse=args.reuse_focused)
    assert state['ok'], state
    xml = parts(folder/'edit-0.hwpx')['Contents/section0.xml'].decode()
    found = re.findall(r'<hp:run charPrIDRef="([0-9]+)"><hp:t>AB</hp:t><hp:t></hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>CD</hp:t></hp:run>', xml)
    assert len(found) == 1 and found[0] != '0', xml
    a, b = inventory(parts(source)['Contents/section0.xml']), inventory(xml)
    location = lambda inv: [(e['run'], e['event']) for e in inv['empty']]
    assert location(a) == location(b), (a['empty'], b['empty'])
    assert [e['shape'] for e in b['empty'] if '/p[2]/' in e['run']] == [found[0]], b['empty']
    assert list(a['runs']) == list(b['runs']) and a['bare'] == b['bare']
    rows.append({'name': 'format-whole-run', 'node': state['operations'], 'newCharPrIDRef': int(found[0])})
    # [#6869] Mapped serializer normalization: only the first hp:pageNum of a
    # paragraph is emitted; empty hp:t ownership around it is preserved.
    ctrl = '<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>'
    source = make_fixture(args.out, 'page-number-fold', r('<hp:t>A</hp:t>'+ctrl+ctrl+'<hp:t/>'))
    folder = args.out/'page-number-fold-run'
    state = run(args.package, source, folder, reuse=args.reuse_focused, fold=True)
    assert state['ok'], state
    result = stable(source, folder, False, args.checker, require_section_equal=False)
    assert r('<hp:t>A</hp:t>'+ctrl+'<hp:t></hp:t>') in parts(folder/'B-first.hwpx')['Contents/section0.xml'].decode()
    assert result['preflight']['outcome'] == 'unsafe' and [f.get('part') for f in result['preflight']['findings']] == ['Contents/section0.xml'], result
    rows.append({'name': 'page-number-fold', **result})
    # Same event identity, different source representation: no proof of
    # correspondence. Do not infer identity from equal shape/offset/count.
    x = '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>'
    source = make_fixture(args.out, 'unsupported-ambiguous-control', r(x+'<hp:t/>'+x.replace('NEWSPAPER', 'NORMAL')))
    folder = args.out/'unsupported-ambiguous-control-run'
    digest = sha(source)
    state = run(args.package, source, folder, reuse=args.reuse_focused)
    assert not state['ok'] and state['stage'] == 'export' and 'ambiguous control event identity' in state['error'], state
    assert sha(source) == digest and not (folder/'B-first.hwpx').exists()
    rows.append({'name': 'unsupported-ambiguous-control', 'diagnostic': state, 'sourceUnchanged': True, 'noOutputBytes': True})
    # Fixtures remain safe for actual native IME / formatting save acceptance.
    safe = make_fixture(args.out, 'native-empty-text', r('<hp:t>A</hp:t><hp:t/><hp:t/>')+r(''), later=False)
    folder = args.out/'native-empty-text-run'
    state = run(args.package, safe, folder, reuse=args.reuse_focused)
    assert state['ok'], state
    stable(safe, folder, True, args.checker)
    # Own run occurrence (charPr 1 differs from the secPr handoff run's 0):
    # formatting the template's group 0 would split it and is refused.
    safe = make_fixture(args.out, 'native-format', r('<hp:t>AB</hp:t><hp:t/>', '1')+r('<hp:t>CD</hp:t>', '2'), later=False)
    folder = args.out/'native-format-run'
    state = run(args.package, safe, folder, [{'method': 'applyCharFormat', 'args': [0, 0, 0, 2, '{"italic":true}']}], reuse=args.reuse_focused)
    assert state['ok'], state
    stable(safe, folder, True, args.checker)
    xml = parts(folder/'edit-0.hwpx')['Contents/section0.xml'].decode()
    found = re.findall(r'<hp:run charPrIDRef="([0-9]+)"><hp:t>AB</hp:t><hp:t></hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>CD</hp:t></hp:run>', xml)
    assert len(found) == 1 and found[0] not in ('0', '1', '2'), xml
    rows.append({'name': 'native-format-fixture', 'node': state['operations']})
    return rows


def real(args):
    assert sha(REAL) == REAL_SHA
    folder = args.out/'real'
    state = run(args.package, REAL, folder, reuse=args.reuse_focused)
    assert state['ok'], state
    result = stable(REAL, folder, False, args.checker, require_section_equal=False)
    original = parts(REAL)['Contents/section0.xml']
    candidate = parts(folder/'B-first.hwpx')['Contents/section0.xml']
    assert args.baseline_output is not None, 'real target requires a verified same-engine baseline output for unrelated differences'
    baseline = parts(args.baseline_output)['Contents/section0.xml']
    assert neutralize(baseline) == neutralize(candidate), 'new unrelated section changes'
    result['sectionCanonicalEqual'] = oracle.equal(original, candidate)
    result['sectionBaselineCandidateOnlyTopology'] = True
    result['firstRemainingSectionDifference'] = oracle.first_difference(oracle.parse(original), oracle.parse(candidate))
    result['baselineOutputSha256'] = sha(args.baseline_output)
    a = inventory(parts(REAL)['Contents/section0.xml'])
    assert len(a['runs']) == 1428 and len(a['empty']) == 57 and len(a['bare']) == 111 and len(a['whitespace']) == 127
    (folder/'source-inventory.json').write_text(json.dumps(a, ensure_ascii=False, indent=2))
    (folder/'location-comparison.json').write_text(json.dumps({**result, 'originalRunCount': len(a['runs']), 'preservedEmptyLocations': a['empty'], 'preservedBareLocations': a['bare'], 'whitespaceLocations': a['whitespace'], 'modelReopenEqual': state['reopenModelEqual']}, ensure_ascii=False, indent=2))
    return {**result, 'runs': 1428, 'emptyPreserved': 57, 'barePreserved': 111, 'whitespacePreserved': 127}


def neutralize(xml):
    """Explanation-only projection; the production checker remains unchanged."""
    root = ET.fromstring(xml)
    # The baseline drops every hp:t@charStyleIDRef; the candidate replays it
    # only for topology-owned source text elements. Explanation-only.
    for t in root.iter(HP+'t'):
        t.attrib.pop('charStyleIDRef', None)
    for run in root.iter(HP+'run'):
        for t in list(run):
            if t.tag == HP+'t' and not t.attrib and not len(t) and not (t.text or ''):
                assert not t.tail
                run.remove(t)
        previous = None
        for t in list(run):
            if t.tag == HP+'t' and not t.attrib and previous is not None and previous.tag == HP+'t' and not previous.attrib:
                if len(previous):
                    previous[-1].tail = (previous[-1].tail or '')+(t.text or '')
                else:
                    previous.text = (previous.text or '')+(t.text or '')
                previous.extend(list(t)); run.remove(t)
            else:
                previous = t
    # Only the documented first secPr handoff; no blanket run merging.
    for p in root.iter(HP+'p'):
        children = list(p)
        if len(children) >= 2:
            first, second = children[:2]
            if first.tag == second.tag == HP+'run' and first.find(HP+'secPr') is not None and first.attrib == second.attrib:
                first.extend(list(second)); p.remove(second)
                # Empty-run spelling used to retain an extra IR boundary
                # after secPr. The correction shares the same handoff as an
                # explicit-pair bare run. Only zero-width prefix occurrences
                # of this exact shape are neutralized for A/B explanation.
                for child in list(p)[1:]:
                    if child.tag == HP+'run' and child.attrib == first.attrib and not len(child):
                        p.remove(child)
                    else:
                        break
    # Prefix coalescing can make text elements adjacent across that handoff.
    for run in root.iter(HP+'run'):
        previous = None
        for t in list(run):
            if t.tag == HP+'t' and not t.attrib and previous is not None and previous.tag == HP+'t' and not previous.attrib:
                if len(previous):
                    previous[-1].tail = (previous[-1].tail or '')+(t.text or '')
                else:
                    previous.text = (previous.text or '')+(t.text or '')
                previous.extend(list(t)); run.remove(t)
            else:
                previous = t
    return canonical(root)


def verify_source_anchors(source_xml, baseline_xml, candidate_xml):
    """Validate source paragraph/run/event occurrences and preexisting relocation.

    A generated section-prefix run can move a table from run[1] to run[2].
    That ancestor change is allowed only if the baseline already has it;
    the owning paragraph occurrence, ID, every local run and event must match.
    """
    source, baseline, candidate = map(inventory, (source_xml, baseline_xml, candidate_xml))
    # Topology-owned paragraphs are those with a SOURCE empty hp:t or bare run.
    # A run emptied only by the #6869 fold in another paragraph is generic
    # serializer output (unchanged vs baseline, checked by neutralize below).
    owned = source
    source = fold_page_numbers(source)
    source_paras, baseline_paras, candidate_paras = (list(x['paragraphs']) for x in (source, baseline, candidate))
    assert len(source_paras) == len(baseline_paras) == len(candidate_paras), 'paragraph ownership occurrence count changed'
    relocations = []
    sensitive = set()
    for item in owned['empty']:
        sensitive.add(item['run'].rsplit('/run[', 1)[0])
    for path in owned['bare']:
        sensitive.add(path.rsplit('/run[', 1)[0])
    def local_runs(inv, owner):
        return [v for path, v in inv['runs'].items() if path.rsplit('/run[', 1)[0] == owner]
    for owner in sensitive:
        occurrence = source_paras.index(owner)
        mapped, prior = candidate_paras[occurrence], baseline_paras[occurrence]
        def identity(inv, path):
            attrs = inv['paragraphs'][path]
            return tuple(int(attrs.get(k, '0')) for k in ('id', 'paraPrIDRef', 'styleIDRef'))
        assert identity(source, owner) == identity(candidate, mapped) == identity(baseline, prior), 'paragraph identity/occurrence changed'
        assert local_runs(source, owner) == local_runs(candidate, mapped), ('owning run or ordered text/control events changed', owner, mapped)
        if owner != mapped:
            assert prior == mapped, ('unexplained ancestor run relocation', owner, prior, mapped)
            relocations.append({'paragraphOccurrence': occurrence, 'sourceOwner': owner, 'baselineOwner': prior, 'candidateOwner': mapped})
    return relocations


def stability_batch(package, inputs, out, reuse=False):
    if out.exists():
        assert reuse and json.loads((out/'inputs.json').read_text()) == inputs
        assert (out/'driver.mjs').read_text() == STABILITY_CODE
        return json.loads((out/'results.json').read_text())
    out.mkdir()
    (out/'inputs.json').write_text(json.dumps(inputs, ensure_ascii=False))
    (out/'driver.mjs').write_text(STABILITY_CODE)
    argv = ['node', str(out/'driver.mjs'), str(package), str(out/'inputs.json'), str(out)]
    result = subprocess.run(argv, text=True, capture_output=True, cwd=ROOT)
    (out/'node.log').write_text(result.stdout+result.stderr)
    (out/'command.json').write_text(json.dumps({'argv': argv, 'exitCode': result.returncode}, indent=2))
    assert result.returncode == 0, result.stderr[-2000:]
    return json.loads((out/'results.json').read_text())


def corpus_stability(args, before, after):
    inputs = [{'i': r['i'], 'source': r['source'], 'outputSha256': r['outputSha256']} for r in after if r['exported']]
    results = stability_batch(args.package, inputs, args.out/'stability', args.reuse_corpus)
    old_by_id = {r['i']: r for r in before}
    new_by_id = {r['i']: r for r in after}
    flags = ('opened', 'exported', 'reopened', 'originalHashMatchesBatch', 'sameObjectBytes', 'sameObjectModel', 'reopenModel', 'reopenedBytes')
    failures = [r for r in results if not r.get('ok') or r.get('cleanupErrors') or not all(r['flags'].get(k) for k in flags)]
    baseline_inputs = []
    for r in results:
        assert r['sourceSha256'] == new_by_id[r['i']]['sourceSha256']
        if batch.outcome(new_by_id[r['i']]) == 'safe':
            assert r.get('ok') and not r.get('cleanupErrors') and all(r['flags'].get(k) for k in flags) and set(r['lossCounts'].values()) == {0}, ('safe document stability regression', r)
        elif r in failures:
            old = old_by_id[r['i']]
            assert old['exported'], ('new export has unsupported stability', r)
            baseline_inputs.append({'i': old['i'], 'source': old['source'], 'outputSha256': old['outputSha256']})
    baseline_results = []
    if baseline_inputs:
        # The CLI baseline generation is verified independently by its BUILD.
        baseline_package = ROOT/'public/rhwp/generations/f817bec0ffa17773e8f7e5412f3cbcf7458bf7140d329fc5e0986d0d98c157eb'
        identity = json.loads((baseline_package/'BUILD.json').read_text())
        for name, digest in identity['artifacts'].items():
            assert sha(baseline_package/name) == digest
        baseline_results = stability_batch(baseline_package, baseline_inputs, args.out/'stability-baseline', args.reuse_corpus)
        baseline_map = {r['i']: r for r in baseline_results}
        for row in failures:
            original = baseline_map[row['i']]
            for key in flags:
                assert row['flags'].get(key) or not original['flags'].get(key), ('new unsafe-document stability finding', key, row, original)
    summary = {'candidateDocuments': len(results), 'safeDocumentsVerified': sum(batch.outcome(r) == 'safe' for r in after),
               'fullyStable': len(results)-len(failures), 'unsafeBaselineCounterchecks': len(baseline_results),
               'preexistingUnstable': len(failures), 'newStabilityFindings': 0}
    (args.out/'stability-summary.json').write_text(json.dumps({'summary': summary, 'candidate': results, 'baselineCounterchecks': baseline_results}, ensure_ascii=False, indent=2))
    return summary


# The 18 documents first refused by the WIP candidate (0bc2c0f2), classified
# individually (docs/architecture/save-preservation.md). Resolved classes must
# export; retained classes must keep their exact fail-closed cause.
EVENT_ORDER = 'HWPX empty-text provenance: emitted text/control event order differs'
WIP_REFUSALS = {
    # resolved: hp:t@charStyleIDRef (OWPML character-style reference) preserved
    'samples/hwpx/[2027] 온새미로 1 본교재.hwpx': ('3d973ca03799d4ee48840b3a6f670aeb6d5b544212424be60c9fcd2d22ca8e5d', 'char-style-attribute', None),
    'samples/hwpx/exam_social.hwpx': ('c11b117dfc55606bb3ea703f9ea5b0a14481f7e70e918bc09ce4e202a04c9fd0', 'char-style-attribute', None),
    'samples/hwpx/exam_social-p1.hwpx': ('741ae19346e1aa7b5c82d2a07f10ab3bcfcb73ea54d9af60fe040d165875aebe', 'char-style-attribute', None),
    'samples/hwpx/opengov/36388711_사회보장제도 신설 협의요청서(청년오피스)_260624.hwpx': ('8d1e7da9d5e4eda6179565509df7c707a887e175d21542347847f066936a65af', 'char-style-attribute', None),
    'samples/hwpx/pr-1674.hwpx': ('d50cb93dfd1d4cf26391b524897fd11981f6338ef8a243f440435b4f77f32e71', 'char-style-attribute', None),
    'samples/rowbreak-problem-pages.hwpx': ('4ccc321e7eb146f28b768654502a128ba1ae408238fd1ed37d51e963732eb5b0', 'char-style-attribute', None),
    # resolved: [#6869] serializer folds every hp:pageNum after the first in a paragraph (mapped)
    'mydocs/pr/assets/issue7445/75544_pii_bunseok.hwpx': ('f429768ec02e5a849d08c06678cbee029fdc8618ca9e2bdcdbba485087fe71f1', 'page-number-fold', None),
    'samples/task2097/75544_pii_bunseok.hwpx': ('f429768ec02e5a849d08c06678cbee029fdc8618ca9e2bdcdbba485087fe71f1', 'page-number-fold', None),
    'samples/issue6465/press_release_footer_logos.hwpx': ('89ec9065432547ae141328dfb957981a26f9dd1b17b9bba9d721e5ae4fbbf5fa', 'page-number-fold', None),
    # resolved: inline hp:tab layout attributes (type 0 -> 1) are model-emitted, not event identity
    'tests/fixtures/issue_6874/seizure-list-candidate-hancom-2020.hwpx': ('be66f55370f4a9db1248f59a7ad26b36c223b1bdab6bfbf4ad02182e4bad5452', 'inline-token-normalization', None),
    'tests/fixtures/issue_7091/pr7091-sample11-candidate-hancom.hwpx': ('56f36098d70369514ba759b69da3af5fa30672f7e0b4f3f0b8fd73a73a79dd97', 'inline-token-normalization', None),
    # retained: serializer reorders fieldEnd and a table at one position (pre-existing, outside topology)
    'samples/hwpx/opengov/36389312_결재문서본문_특정소방대상물 화재발생 알림(화재번호 2026-177).hwpx': ('a8b5e2604e2bd35e3caf35c94d46999182240fa7d5747c79c15f00ee53fdb504', 'field-end-table-order', EVENT_ORDER+' in IR run occurrence 1'),
    'samples/task2279/36406174_gyeoljae.hwpx': ('4380392eda8225b7fb85d188d11d6b477b5d7c7657d433ba49b0418f9d347f20', 'field-end-table-order', EVENT_ORDER+' in IR run occurrence 0'),
    'samples/task2279/36410902_gyeoljae.hwpx': ('f12612d125e8bc03180cdb217969470210b8f16ed54204db448933c75572b83b', 'field-end-table-order', EVENT_ORDER+' in IR run occurrence 0'),
    'samples/task2279/36477373_gyeoljae.hwpx': ('34adf70eed79902380ba9a1b777cd5fb3c03b90923c92d11e733f91e7a9f5af7', 'field-end-table-order', EVENT_ORDER+' in IR run occurrence 0'),
    # retained: loader renumbers container id 0 -> 1000 (no recorded identity mapping)
    'samples/issue5797_shape_selfclosing_child.hwpx': ('e6b9fe6aacfa5460457131fe1914f29c54030ef892772a32ce1c9822973a90fb', 'object-identity-renumbering', EVENT_ORDER+' in IR run occurrence 0'),
    # retained: hp:unknownObj events are not emitted (replaced by a table)
    'samples/issue6035/cgmp_evaluation_table.hwpx': ('0f03119d6ac3e19f74fc9fcec5315ac6ed436bab5abffd0804e9cf3350dd747a', 'unknown-object-loss', EVENT_ORDER+' in IR run occurrence 0'),
    # retained: inline hp:hypen tokens are dropped by the parser
    'samples/task1725/text_footnote_tail_overpagination.hwpx': ('fccd4f8525feb2e9f2668532444c7e539649c0ec90a5d78273a1ac05dbca5b47', 'inline-token-loss', EVENT_ORDER+' in IR run occurrence 0'),
}


def classify_wip_refusals(rows):
    seen = {}
    for row in rows:
        key = row['source'].split('/external/rhwp/', 1)[-1]
        if key in WIP_REFUSALS:
            digest, cls, cause = WIP_REFUSALS[key]
            assert row['sourceSha256'] == digest, (key, 'source identity')
            if cause is None:
                assert row['after'] != 'export-failed' and 'newRefusal' not in row, (key, cls, row)
            else:
                assert row['after'] == 'export-failed' and row.get('newRefusal', '').endswith(cause), (key, cls, row)
            seen[key] = cls
    assert set(seen) == set(WIP_REFUSALS), sorted(set(WIP_REFUSALS) - set(seen))
    unexpected = [r['source'] for r in rows if 'newRefusal' in r and r['source'].split('/external/rhwp/', 1)[-1] not in WIP_REFUSALS]
    assert not unexpected, unexpected
    return {'classified': len(seen), 'byClass': dict(Counter(seen.values())),
            'resolved': sum(WIP_REFUSALS[k][2] is None for k in seen), 'retained': sum(WIP_REFUSALS[k][2] is not None for k in seen)}


def corpus(args):
    fixtures = [Path(p) for p in args.corpus_list.read_text().splitlines() if p]
    before = batch.reuse_corpus(fixtures, args.reuse_baseline)
    after = (batch.reuse_corpus(fixtures, args.out/'corpus-candidate') if args.reuse_corpus
             else batch.export_corpus(args.package, fixtures, args.out/'corpus-candidate', args.checker))
    rows = []
    for a, b in zip(before, after, strict=True):
        assert (a['source'], a['sourceSha256']) == (b['source'], b['sourceSha256'])
        old, new = batch.outcome(a), batch.outcome(b)
        row = {'source': a['source'], 'sourceSha256': a['sourceSha256'], 'before': old, 'after': new,
               'beforeFindings': batch.findings(a), 'afterFindings': batch.findings(b), 'changedParts': []}
        assert old != 'safe' or new == 'safe', row
        if a['exported'] and not b['exported']:
            row['newRefusal'] = b['error']
            assert 'HWPX empty-text provenance:' in b['error'], row
        if a['exported'] and b['exported']:
            x, y = parts(a['output']), parts(b['output'])
            assert x.keys() == y.keys(), row
            for name in x:
                if x[name] != y[name]:
                    row['changedParts'].append(name)
                    assert re.fullmatch(r'Contents/(?:section|masterpage)[0-9]+\.xml', name), row
                    assert neutralize(x[name]) == neutralize(y[name]), (row, name, 'unexplained non-topology change')
                    original_parts = parts(a['source'])
                    if name in original_parts:
                        relocations = verify_source_anchors(original_parts[name], x[name], y[name])
                        row.setdefault('sourceTopologyVerifiedParts', []).append(name)
                        if relocations:
                            row.setdefault('preexistingAncestorRunRelocations', {})[name] = relocations

            assert not set(row['afterFindings'])-set(row['beforeFindings']), row
        rows.append(row)
    classification = classify_wip_refusals(rows)
    summary = {'total': len(rows), 'before': dict(Counter(r['before'] for r in rows)), 'after': dict(Counter(r['after'] for r in rows)),
               'wipRefusalClassification': classification,
               'newlySafe': sum(r['before'] != 'safe' and r['after'] == 'safe' for r in rows),
               'changedDocuments': sum(bool(r['changedParts']) for r in rows), 'newRefusals': sum('newRefusal' in r for r in rows),
               'safeRegressions': 0, 'unexpectedFindings': 0}
    (args.out/'corpus-comparison-pre-stability.json').write_text(json.dumps({'summary': summary, 'documents': rows}, ensure_ascii=False, indent=2))
    summary['stability'] = corpus_stability(args, before, after)
    (args.out/'corpus-comparison.json').write_text(json.dumps({'summary': summary, 'documents': rows}, ensure_ascii=False, indent=2))
    return summary


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--package', required=True, type=Path)
    p.add_argument('--checker', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--corpus-list', type=Path)
    p.add_argument('--reuse-baseline', type=Path)
    p.add_argument('--baseline-output', type=Path, help='Verified f817 target export for unchanged unrelated XML differences')
    p.add_argument('--reuse-focused', action='store_true', help='Revalidate existing sealed inputs/driver/results without repeating WASM operations')
    p.add_argument('--baseline-reproduction', action='store_true')
    p.add_argument('--reuse-corpus', action='store_true', help='Reanalyze sealed existing candidate exports without repeating WASM or preflight')
    args = p.parse_args()
    args.package = args.package.resolve(); args.checker = args.checker.resolve(); args.out = args.out.resolve()
    if args.reuse_corpus or args.reuse_focused:
        assert args.out.is_dir() and not args.out.is_symlink()
    else:
        args.out.mkdir(exist_ok=False, parents=True)
    identity = json.loads((args.package/'BUILD.json').read_text())
    for name, digest in identity['artifacts'].items():
        assert sha(args.package/name) == digest
    if args.reuse_corpus or args.reuse_focused:
        assert json.loads((args.out/'engine-identity.json').read_text()) == identity
    else:
        (args.out/'engine-identity.json').write_text(json.dumps(identity, indent=2))
    if args.baseline_reproduction:
        assert sha(REAL) == REAL_SHA
        state = run(args.package, REAL, args.out/'real')
        assert state['ok'], state
        a, b = (inventory(parts(s)['Contents/section0.xml']) for s in (REAL, args.out/'real/B-first.hwpx'))
        missing = [x for x in a['empty'] if x not in b['empty']]
        inserted = [x for x in a['bare'] if x not in b['bare']]
        assert len(missing) == 57 and len(inserted) == 111
        (args.out/'expected-defect.json').write_text(json.dumps({'missing': missing, 'bareReceivingText': inserted}, indent=2))
        assert a == b, 'EXPECTED BASELINE FAILURE: 57 empty hp:t lost; 111 bare runs gained hp:t'
    report = (json.loads((args.out/'report.json').read_text()) if args.reuse_corpus
              else {'positive': positive(args), 'editing': edits(args), 'real': real(args)})
    (args.out/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    if args.corpus_list:
        report['corpus'] = corpus(args)
    (args.out/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'status': 'PASS', 'positive': len(report['positive']), 'editing': len(report['editing']), 'real': report['real'], 'corpus': report.get('corpus')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
