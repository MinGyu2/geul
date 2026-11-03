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
const [pkg,source,out,planFile]=process.argv.slice(2);
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
 stage='reopen';r=new m.HwpDocument(b);assert.deepEqual(snapshot(r),before);emit(r,'D-reopened');
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
                    events.append(('text', canonical(child), tail))
                else:
                    identity = {k: v for k, v in child.attrib.items() if k == 'id'}
                    inner = [(c.tag, {k: v for k, v in c.attrib.items() if k in ('id', 'beginIDRef', 'fieldid')}) for c in child] if child.tag == HP+'ctrl' else []
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


def run(package, source, out, plan=(), reuse=False):
    if out.exists():
        assert reuse, ('existing output requires explicit verified reuse', out)
        assert json.loads((out/'command.json').read_text())['sourceSha256'] == sha(source)
        assert json.loads((out/'plan.json').read_text()) == list(plan)
        assert (out/'driver.mjs').read_text() == CODE
        return json.loads((out/'node.json').read_text())
    out.mkdir()
    (out/'plan.json').write_text(json.dumps(plan, ensure_ascii=False))
    (out/'driver.mjs').write_text(CODE)
    command = ['node', str(out/'driver.mjs'), str(package), str(source), str(out), str(out/'plan.json')]
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
                a, b = inventory(src[name]), inventory(dst[name])
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
        result = stable(source, folder, name not in ('empty-cdata', 'entities-cdata'), args.checker)
        if name in ('empty-cdata', 'entities-cdata'):
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
        ('format', 'applyCharFormat', [0, 1, 0, 1, '{"bold":true}'], 'stale text, formatting or control-slot anchors'),
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
    # A known output normalization cannot be matched to two source control
    # occurrences. Do not infer identity from equal shape/offset/count.
    ctrl = '<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>'
    source = make_fixture(args.out, 'unsupported-control-merge', r('<hp:t>A</hp:t>'+ctrl+ctrl+'<hp:t/>'))
    folder = args.out/'unsupported-control-merge-run'
    digest = sha(source)
    state = run(args.package, source, folder, reuse=args.reuse_focused)
    assert not state['ok'] and state['stage'] == 'export' and 'emitted text/control event order differs' in state['error'], state
    assert sha(source) == digest and not (folder/'B-first.hwpx').exists()
    rows.append({'name': 'unsupported-control-merge', 'diagnostic': state, 'sourceUnchanged': True, 'noOutputBytes': True})
    # Fixture remains safe for actual native IME save/reopen acceptance.
    safe = make_fixture(args.out, 'native-empty-text', r('<hp:t>A</hp:t><hp:t/><hp:t/>')+r(''), later=False)
    folder = args.out/'native-empty-text-run'
    state = run(args.package, safe, folder, reuse=args.reuse_focused)
    assert state['ok'], state
    stable(safe, folder, True, args.checker)
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
    source_paras, baseline_paras, candidate_paras = (list(x['paragraphs']) for x in (source, baseline, candidate))
    assert len(source_paras) == len(baseline_paras) == len(candidate_paras), 'paragraph ownership occurrence count changed'
    relocations = []
    sensitive = set()
    for item in source['empty']:
        sensitive.add(item['run'].rsplit('/run[', 1)[0])
    for path in source['bare']:
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
    summary = {'total': len(rows), 'before': dict(Counter(r['before'] for r in rows)), 'after': dict(Counter(r['after'] for r in rows)),
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
