#!/usr/bin/env python3
"""Real-WASM secPr tab attribute preservation, rejection and corpus A/B checks.

Source fixtures stay immutable. Absent, single-attribute and heterogeneous
section variants are explicitly synthetic. Uses the existing XML oracle and
Geul save checker; never removes attributes from the production comparator.
"""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HP = '{http://www.hancom.co.kr/hwpml/2011/paragraph}'
TARGET = ('tabStopVal', 'tabStopUnit')
BLANK = ROOT / 'external/rhwp/saved/blank_hwpx.hwpx'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


batch = module('manifest_corpus', 'scripts/tests/hwpx-manifest-order-roundtrip.py')
oracle = batch.oracle
sha = batch.spine.sha

CODE = r"""
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
const [pkg,source,out,mode]=process.argv.slice(2);
const m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
let d,r,stage='open';const result={};
const snapshot=d=>JSON.stringify({text:Array.from({length:d.getSectionCount()},(_,s)=>
 Array.from({length:d.getParagraphCount(s)},(_,p)=>d.getTextRange(s,p,0,d.getParagraphLength(s,p)))),controls:d.getControls(),pages:d.pageCount()});
const emit=(doc,name)=>{let e;try{e=doc.exportHwpxWithReport();const loss=e.contentLoss(),b=e.takeBytes();
 if(JSON.parse(loss).count!==0)throw new Error('content loss: '+loss);
 writeFileSync(resolve(out,name+'.hwpx'),b);writeFileSync(resolve(out,name+'.hwpx.loss.json'),loss);return b;
}finally{e?.free();}};
const ok=s=>{const v=JSON.parse(s);if(v.ok!==true)throw new Error(s);};
try {
 if(mode==='generated'){d=m.HwpDocument.createEmpty();d.createBlankDocument();}
 else d=new m.HwpDocument(readFileSync(source));
 stage='export';const expected=snapshot(d),b=emit(d,'noedit');emit(d,'repeat');
 r=new m.HwpDocument(b);if(snapshot(r)!==expected)throw new Error('reopen model differs');emit(r,'reopened');
 result.reopenModelEqual=true;
 if(mode==='edits'){
  stage='text-edit';ok(d.insertText(0,0,0,'검증'));emit(d,'text');
  const sd=JSON.parse(d.getSectionDef(0));
  stage='unrelated-edit';ok(d.setSectionDef(0,JSON.stringify({columnSpacing:sd.columnSpacing+1})));emit(d,'unrelated');
  stage='tab-edit';ok(d.setSectionDef(0,JSON.stringify({defaultTabSpacing:sd.defaultTabSpacing+1})));
  try{emit(d,'changed-tab');result.changedTab='UNEXPECTED EXPORT';}
  catch(e){result.changedTab=String(e?.message??e);}
 }
 result.ok=true;
}catch(e){result.ok=false;result.stage=stage;result.opened=!!d;result.error=String(e?.message??e);}
finally{r?.free();d?.free();}
console.log(JSON.stringify(result));
"""


def node(package, source, out, mode='noedit'):
    out.mkdir()
    run = subprocess.run(['node', '--input-type=module', '-', str(package), str(source), str(out), mode],
                         input=CODE, capture_output=True, text=True, cwd=ROOT)
    (out/'node.log').write_text(run.stdout+run.stderr)
    assert run.returncode == 0, run.stderr[-2000:]
    result = json.loads(run.stdout.splitlines()[-1])
    (out/'node.json').write_text(json.dumps(result, indent=2)+'\n')
    return result


def parts(path):
    with zipfile.ZipFile(path) as archive:
        assert len(archive.namelist()) == len(set(archive.namelist()))
        assert archive.testzip() is None
        return {n: archive.read(n) for n in archive.namelist()}


def sections(path):
    return {n: v for n, v in parts(path).items() if re.fullmatch(r'Contents/section[0-9]+\.xml', n)}


def secprs(xml):
    return [dict(e.attrib) for e in oracle.parse(xml).iter(HP+'secPr')]


def target_attributes(xml):
    return [{k: a[k] for k in ('tabStop', *TARGET) if k in a} for a in secprs(xml)]


def check(checker, source, output):
    run = subprocess.run([str(checker), 'preflight', 'hwpx', str(source), str(output), str(output)+'.loss.json'],
                         capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(run.stdout)


def package_equal(source, output):
    before, after = parts(source), parts(output)
    assert before.keys() == after.keys(), 'part set changed'
    for name, data in before.items():
        assert oracle.equal(data, after[name]) if name.endswith(('.xml', '.hpf', '.rdf', '.rels')) else data == after[name], name


def rewrite(source, destination, transforms, extra=None):
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(destination, 'w') as b:
        for info in a.infolist():
            data = a.read(info.filename)
            if info.filename in transforms:
                data = transforms[info.filename](data.decode('utf-8')).encode('utf-8')
            b.writestr(info, data)
        for name, data in (extra or {}).items():
            b.writestr(name, data)


def with_pair(xml, pair, tab_stop='8000'):
    matches = list(re.finditer(r'<hp:secPr\s[^>]*>', xml))
    assert matches, 'fixture has no secPr opening tag'
    m = matches[0]
    tag = re.sub(r' tabStop(?:Val|Unit)="[^"]*"', '', m[0])
    tag, count = re.subn(r' tabStop="[^"]*"', f' tabStop="{tab_stop}"'+pair, tag)
    assert count == 1
    return xml[:m.start()]+tag+xml[m.end():]


def fixture(out, name, pair, tab_stop='8000'):
    path = out/(name+'.hwpx')
    rewrite(BLANK, path, {'Contents/section0.xml': lambda x: with_pair(x, pair, tab_stop)})
    return path


def positive(package, checker, out):
    cases = [
        ('absent', ''),
        ('explicit', ' tabStopVal="4000" tabStopUnit="HWPUNIT"'),
        ('val-only', ' tabStopVal="4000"'),
        ('unit-only', ' tabStopUnit="CHAR"'),
        ('char', ' tabStopVal="2000" tabStopUnit="CHAR"'),
        ('nondefault', ' tabStopVal="3500" tabStopUnit="HWPUNIT"'),
        ('schema-default', ' tabStopVal="0" tabStopUnit="HWPUNIT"'),
        ('integer-spelling', ' tabStopVal=" +004000 " tabStopUnit="HWPUNIT"'),
        ('negative-integer', ' tabStopVal="-1"'),
        ('unbounded-integer', ' tabStopVal="99999999999999999999999999999999999999999999999999"'),
        ('normalized', ' tabStopVal="&#9;+004000&#10;" tabStopUnit="HWP&#85;NIT"'),
    ]
    rows = []
    for name, pair in cases:
        source = BLANK if name == 'absent' else fixture(out, name, pair, '12345')
        run_out = out/name
        result = node(package, source, run_out, 'edits')
        assert result.get('ok'), (name, result)
        original = sections(source)
        for stage in ('noedit', 'repeat', 'reopened', 'text', 'unrelated'):
            emitted = sections(run_out/(stage+'.hwpx'))
            assert emitted.keys() == original.keys()
            for part, data in original.items():
                assert target_attributes(data) == target_attributes(emitted[part]), (name, stage, part, target_attributes(data), target_attributes(emitted[part]))
                if stage in ('noedit', 'repeat', 'reopened'):
                    assert oracle.equal(data, emitted[part]), (name, stage, part, oracle.first_difference(oracle.parse(data), oracle.parse(emitted[part])))
        assert 'tab spacing changed' in result['changedTab'], result
        verdict = check(checker, source, run_out/'noedit.hwpx')
        assert verdict['outcome'] == 'safe' and not verdict.get('findings'), (name, verdict)
        package_equal(source, run_out/'noedit.hwpx')
        rows.append({'name': name, 'origin': 'real upstream' if source == BLANK else 'synthetic',
                     'sourceSha256': sha(source), 'attributes': {n: target_attributes(x) for n, x in original.items()},
                     'preflight': verdict, 'node': result})
    return rows


def multisection(package, checker, out):
    # Deliberately synthetic: two separate section files with independent states.
    second = with_pair(sections(BLANK)['Contents/section0.xml'].decode(), ' tabStopVal="3500"', '7000')
    source = out/'multisection.hwpx'
    rewrite(BLANK, source, {
        'Contents/content.hpf': lambda x: x.replace('</opf:manifest>', '<opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/></opf:manifest>').replace('</opf:spine>', '<opf:itemref idref="section1"/></opf:spine>'),
        'Contents/header.xml': lambda x: x.replace('secCnt="1"', 'secCnt="2"'),
    }, {'Contents/section1.xml': second.encode()})
    result = node(package, source, out/'multisection')
    assert result.get('ok'), result
    for stage in ('noedit', 'repeat', 'reopened'):
        current = sections(out/'multisection'/(stage+'.hwpx'))
        assert len(current) == 2
        for name, data in sections(source).items():
            assert target_attributes(data) == target_attributes(current[name]), (stage, name)
    return {'origin': 'synthetic', 'sections': {n: target_attributes(v) for n, v in sections(source).items()},
            'preflight': check(checker, source, out/'multisection/noedit.hwpx'), 'node': result}


def negative(package, checker, out):
    rows = []
    for name, pair, reason in [
        ('bad-numeric', ' tabStopVal="4.0"', 'tabStopVal: expected xs:integer'),
        ('bad-unit', ' tabStopUnit="PX"', 'tabStopUnit: unsupported unit'),
        ('duplicate-val', ' tabStopVal="1" tabStopVal="2"', 'tab-stop attributes'),
        ('duplicate-unit', ' tabStopUnit="CHAR" tabStopUnit="HWPUNIT"', 'tab-stop attributes'),
        ('malformed-attribute', ' tabStopVal=4000', 'tab-stop attributes'),
        ('unknown-entity', ' tabStopVal="&undefined;"', 'tab-stop attribute value'),
    ]:
        source = fixture(out, name, pair)
        result = node(package, source, out/name)
        assert result.get('ok') is False and result.get('stage') == 'open' and reason in result['error'], (name, result)
        rows.append({'name': name, 'specificRejection': reason, 'node': result})
    # First SectionDef and stream-head disagree because the upstream parser's
    # head owner is the last definition. Preserve that pre-existing ownership
    # model; reject rather than silently using another definition's provenance.
    def inconsistent(xml):
        secpr = re.search(r'<hp:secPr\s.*?</hp:secPr>', xml).group()
        second = with_pair(secpr, ' tabStopVal="3500"', '7000')
        para = '<hp:p id="2" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">'+second+'<hp:t/></hp:run></hp:p>'
        return xml.replace('</hs:sec>', para+'</hs:sec>')
    source = out/'inconsistent-section.hwpx'
    rewrite(BLANK, source, {'Contents/section0.xml': inconsistent})
    result = node(package, source, out/'inconsistent-section')
    assert result.get('ok') is False and result.get('opened') and result.get('stage') == 'export' and 'inconsistent section head' in result['error'], result
    rows.append({'name': 'inconsistent-section', 'specificRejection': 'inconsistent section head', 'node': result})
    # Empty source structure must not silently become a generated SectionDef.
    source = out/'empty-secpr.hwpx'
    rewrite(BLANK, source, {'Contents/section0.xml': lambda x: re.sub(r'<hp:secPr\s.*?</hp:secPr>', '<hp:secPr tabStopVal="1"/>', x, count=1)})
    result = node(package, source, out/'empty-secpr')
    assert result.get('ok') is False and 'empty section definition unsupported' in result['error'], result
    rows.append({'name': 'empty-secpr', 'specificRejection': 'empty section definition unsupported', 'node': result})
    # An unrelated unsupported secPr property must remain unsafe after the two
    # target attributes are preserved. This is also the native UnsafeSave input.
    source = out/'remaining-unsafe.hwpx'
    def line_number(xml):
        changed, count = re.subn(r'(<hp:lineNumberShape[^>]* distance=")0(")', r'\g<1>12345\2', xml, count=1)
        assert count == 1
        return changed
    rewrite(BLANK, source, {'Contents/section0.xml': line_number})
    result = node(package, source, out/'remaining-unsafe')
    assert result.get('ok'), result
    emitted = out/'remaining-unsafe/noedit.hwpx'
    original_xml = sections(source)['Contents/section0.xml']
    emitted_xml = sections(emitted)['Contents/section0.xml']
    assert target_attributes(original_xml) == target_attributes(emitted_xml)
    before = next(oracle.parse(original_xml).iter(HP+'lineNumberShape')).get('distance')
    after = next(oracle.parse(emitted_xml).iter(HP+'lineNumberShape')).get('distance')
    verdict = check(checker, source, emitted)
    assert (before, after) == ('12345', '0') and verdict['outcome'] == 'unsafe'
    assert batch.findings({'verdict': verdict}) == ['partChanged:Contents/section0.xml'], verdict
    rows.append({'name': 'remaining-unsafe', 'specificDifference': {'lineNumberShape@distance': [before, after]}, 'preflight': verdict})
    return rows


def generated(package, baseline, out):
    rows = []
    for label, source in [('generated', BLANK), ('hwp5', ROOT/'external/rhwp/saved/blank2010.hwp')]:
        result = node(package, source, out/label, label)
        assert result.get('ok'), result
        for name, xml in sections(out/label/'noedit.hwpx').items():
            assert all(a.get('tabStopVal') == '4000' and a.get('tabStopUnit') == 'HWPUNIT' for a in secprs(xml)), name
        if baseline:
            prior = out/(label+'-baseline')
            assert node(baseline, source, prior, label).get('ok')
            assert parts(prior/'noedit.hwpx') == parts(out/label/'noedit.hwpx'), label
        rows.append({'name': label, 'defaultsPresent': True, 'baselinePartsIdentical': bool(baseline)})
    return rows


def compare_corpus(before, after):
    rows = []
    for a, b in zip(before, after, strict=True):
        assert (a['source'], a['sourceSha256']) == (b['source'], b['sourceSha256'])
        assert a['exported'] == b['exported'], ('export outcome changed', a['source'], a.get('error'), b.get('error'))
        row = {'sample': str(Path(a['source']).relative_to(ROOT)), 'sourceSha256': a['sourceSha256'],
               'before': batch.outcome(a), 'after': batch.outcome(b), 'beforeFindings': batch.findings(a), 'afterFindings': batch.findings(b),
               'beforeError': a.get('error'), 'afterError': b.get('error'), 'changedOutputParts': []}
        row['removedFindings'] = sorted(set(row['beforeFindings'])-set(row['afterFindings']))
        row['addedFindings'] = sorted(set(row['afterFindings'])-set(row['beforeFindings']))
        if a['exported'] and b['exported']:
            x, y = parts(a['output']), parts(b['output'])
            assert x.keys() == y.keys()
            for name in x:
                if x[name] == y[name]:
                    continue
                row['changedOutputParts'].append(name)
                assert re.fullmatch(r'Contents/section[0-9]+\.xml', name), (row, name)
                left, right = oracle.parse(x[name]), oracle.parse(y[name])
                for tree in (left, right):
                    for secpr in tree.iter(HP+'secPr'):
                        for key in TARGET:
                            secpr.attrib.pop(key, None)
                assert oracle.canonical_events(left) == oracle.canonical_events(right), (row, name, oracle.first_difference(left, right))
            if zipfile.is_zipfile(a['source']):
                for name, original in sections(a['source']).items():
                    # Existing legacy tabStop=0 fallback is intentionally unchanged.
                    expected = [{k: s[k] for k in TARGET if k in s} for s in secprs(original)]
                    actual = [{k: s[k] for k in TARGET if k in s} for s in secprs(y[name])]
                    assert actual == expected, (row, name, expected, actual)
            if row['before'] != 'safe' and row['after'] == 'safe':
                package_equal(a['source'], b['output'])
        assert not row['addedFindings'], row
        assert row['before'] != 'safe' or row['after'] == 'safe', row
        rows.append(row)
    return rows


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--package', required=True, type=Path)
    p.add_argument('--baseline', type=Path)
    p.add_argument('--checker', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    p.add_argument('--reproduce-only', action='store_true')
    p.add_argument('--corpus-list', type=Path)
    p.add_argument('--reuse-baseline', type=Path)
    args = p.parse_args()
    args.out = args.out.resolve(); args.out.mkdir(parents=True, exist_ok=False)
    identity = {'wasmSha256': sha(args.package/'rhwp_bg.wasm'), 'jsSha256': sha(args.package/'rhwp.js'),
                'checkerSha256': sha(args.checker), 'baselineWasmSha256': sha(args.baseline/'rhwp_bg.wasm') if args.baseline else None}
    (args.out/'identity.json').write_text(json.dumps(identity, indent=2)+'\n')
    if args.reproduce_only:
        result = node(args.package, BLANK, args.out/'blank')
        assert result.get('ok'), result
        before, after = sections(BLANK), sections(args.out/'blank/noedit.hwpx')
        assert target_attributes(before['Contents/section0.xml']) == target_attributes(after['Contents/section0.xml']), 'originally absent tabStopVal/tabStopUnit were introduced'
        return
    report = {'identity': identity, 'positive': positive(args.package, args.checker, args.out),
              'multisection': multisection(args.package, args.checker, args.out),
              'negative': negative(args.package, args.checker, args.out), 'generated': generated(args.package, args.baseline, args.out)}
    if args.corpus_list:
        fixtures = [Path(line) for line in args.corpus_list.read_text().splitlines() if line]
        before = batch.reuse_corpus(fixtures, args.reuse_baseline) if args.reuse_baseline else batch.export_corpus(args.baseline, fixtures, args.out/'corpus-baseline', args.checker)
        after = batch.export_corpus(args.package, fixtures, args.out/'corpus-candidate', args.checker)
        rows = compare_corpus(before, after)
        summary = {'total': len(rows), 'before': dict(Counter(r['before'] for r in rows)), 'after': dict(Counter(r['after'] for r in rows)),
                   'changedDocuments': sum(bool(r['changedOutputParts']) for r in rows),
                   'removedSectionFindings': sum(any(f.startswith('partChanged:Contents/section') for f in r['removedFindings']) for r in rows),
                   'newlySafe': sum(r['before'] != 'safe' and r['after'] == 'safe' for r in rows),
                   'safeRegressions': sum(r['before'] == 'safe' and r['after'] != 'safe' for r in rows),
                   'addedFindings': sum(bool(r['addedFindings']) for r in rows), 'unexpectedOutputParts': 0}
        (args.out/'corpus-comparison.json').write_text(json.dumps({'summary': summary, 'documents': rows}, ensure_ascii=False, indent=2)+'\n')
        report['corpus'] = summary
    report['status'] = 'PASS'
    (args.out/'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'status': 'PASS', 'positive': len(report['positive']), 'negative': len(report['negative']), 'corpus': report.get('corpus')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
