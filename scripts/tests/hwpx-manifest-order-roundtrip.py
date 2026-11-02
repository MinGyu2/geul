#!/usr/bin/env python3
"""Independent manifest-order A/B corpus evidence using real immutable WASMs.

Outputs and source documents stay in ignored local storage. A safe no-edit
preflight is not edited-save acceptance. Unsupported originals remain refused.
"""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('spine', ROOT / 'scripts/tests/hwpx-spine-linear-roundtrip.py')
spine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spine)
oracle = spine.oracle
OPF = '{http://www.idpf.org/2007/opf/}'
REPRESENTATIVES = (
    'samples/issue7193/2983289_picture_inner_margin.hwpx',
    'samples/issue7482/long-boundary-8.hwpx',
    'samples/issue2816/imgbrush_total_page_fill.hwpx',
    'samples/issue6465/press_release_footer_logos.hwpx',
    'samples/hwpx/exam_social.hwpx',
    'samples/종이기준.hwpx',
    'samples/issue7418/list_marker_head_synthetic.hwpx',
    'samples/issue5595_rotated_picture_topbottom.hwpx',  # unsupported hashkey
    'samples/render-p35-font-native-bitmap.hwpx',       # unsupported remapping
)

BATCH = r"""
import{readFileSync,writeFileSync}from'node:fs';import{resolve}from'node:path';
import{pathToFileURL}from'node:url';import{createHash}from'node:crypto';
const[pkg,list,out]=process.argv.slice(2),m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});const rows=[];
for(const [i,source] of JSON.parse(readFileSync(list)).entries()){
 let d,e,stage='open';const row={i,source};
 try{const input=readFileSync(source);row.sourceSha256=createHash('sha256').update(input).digest('hex');
 d=new m.HwpDocument(input);stage='export';e=d.exportHwpxWithReport();
 const loss=e.contentLoss(),bytes=e.takeBytes(),output=resolve(out,`${i}.hwpx`);
 writeFileSync(output,bytes);writeFileSync(output+'.loss.json',loss);
 Object.assign(row,{output,exported:true,outputSha256:createHash('sha256').update(bytes).digest('hex')});
 }catch(error){Object.assign(row,{exported:false,stage,error:String(error?.message??error)});}
 finally{e?.free();d?.free();}rows.push(row);
}
writeFileSync(resolve(out,'export.json'),JSON.stringify(rows,null,2)+'\n');
"""


def manifest(path):
    document = oracle.parse(spine.content_hpf(path))
    assert document.root.tag in (OPF+'package', '{http://www.idpf.org/2007/opf}package')
    ns = document.root.tag[:-len('package')]
    element = document.find(ns+'manifest')
    assert element is not None
    return document, element, [dict(e.attrib) for e in element if e.tag == ns+'item']


def order_and_mapping(path):
    _, _, items = manifest(path)
    ids = [item['id'] for item in items]
    assert len(ids) == len(set(ids)), 'duplicate manifest identity'
    return ids, {item['id']: item for item in items}


def targets(path):
    _, _, items = manifest(path)
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)) and archive.testzip() is None
        for item in items:
            if item.get('isEmbeded', '1') != '0':
                assert item['href'] in names, item
                if item['media-type'] == 'image/jpg':
                    assert archive.read(item['href'])[:3] == b'\xff\xd8\xff', item
    return True


def only_manifest_order_and_jpeg_spelling_changed(before, after, source):
    """Only order and source-proven JPEG spelling restoration may differ."""
    with zipfile.ZipFile(before) as a, zipfile.ZipFile(after) as b:
        assert set(a.namelist()) == set(b.namelist())
        changed = []
        for name in a.namelist():
            if a.read(name) != b.read(name):
                changed.append(name)
                assert name == 'Contents/content.hpf', (name, 'unexpected output change')
        if changed:
            x, mx, _ = manifest(before)
            y, my, _ = manifest(after)
            original_map = order_and_mapping(source)[1] if zipfile.is_zipfile(source) else {}
            actual_map = {e.get('id'): e for e in mx}
            for child in my:
                prior = actual_map.get(child.get('id'))
                if prior is not None and prior.get('media-type') != child.get('media-type'):
                    original = original_map[child.get('id')]
                    assert prior.get('media-type') == 'image/jpeg' and child.get('media-type') == original['media-type'] == 'image/jpg'
                    assert prior.get('href') == child.get('href') == original['href']
                    assert child.get('isEmbeded', '1') == original.get('isEmbeded', '1') == '1'
                    # Independent binary proof was required by targets() too.
                    with zipfile.ZipFile(after) as package:
                        assert package.read(child.get('href'))[:3] == b'\xff\xd8\xff'
                    child.set('media-type', 'image/jpeg')
            for m in (mx, my):
                children = sorted(list(m), key=lambda child: child.get('id', ''))
                m[:] = children
            assert oracle.canonical_events(x) == oracle.canonical_events(y), oracle.first_difference(x, y)
        return changed


def export_corpus(package, fixtures, out, checker):
    out.mkdir()
    inputs = out / 'fixtures.json'
    inputs.write_text(json.dumps([str(p) for p in fixtures])+'\n')
    result = subprocess.run(['node', '--input-type=module', '-', str(package), str(inputs), str(out)],
                            input=BATCH, capture_output=True, text=True, cwd=ROOT)
    (out/'export.log').write_text(result.stdout+result.stderr)
    assert result.returncode == 0, 'batch export aborted; inspect export.log'
    rows = json.loads((out/'export.json').read_text())
    for row in rows:
        assert spine.sha(Path(row['source'])) == row['sourceSha256'], 'fixture changed during run'
        if row['exported']:
            output = Path(row['output'])
            result = subprocess.run([str(checker), 'preflight', 'hwpx', row['source'], str(output), str(output)+'.loss.json'],
                                    capture_output=True, text=True, cwd=ROOT)
            assert result.returncode == 0, result.stderr
            row['verdict'] = json.loads(result.stdout)
    (out/'preflight.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n')
    return rows


def reuse_corpus(fixtures, out):
    rows = json.loads((out/'preflight.json').read_text())
    assert len(rows) == len(fixtures)
    for index, (row, source) in enumerate(zip(rows, fixtures, strict=True)):
        assert row['i'] == index and Path(row['source']) == source
        assert spine.sha(source) == row['sourceSha256']
        if row['exported']:
            assert Path(row['output']).resolve() == (out/f'{index}.hwpx').resolve()
            assert spine.sha(row['output']) == row['outputSha256']
    return rows


def outcome(row):
    return row['verdict']['outcome'] if row['exported'] else 'export-failed'


def findings(row):
    return sorted(f"{f['code']}:{f.get('part')}" for f in row.get('verdict', {}).get('findings', []))


def compare(before, after):
    rows = []
    for a, b in zip(before, after, strict=True):
        assert (a['source'], a['sourceSha256']) == (b['source'], b['sourceSha256'])
        row = {'sample': str(Path(a['source']).relative_to(ROOT)), 'sourceSha256': a['sourceSha256'],
               'before': outcome(a), 'after': outcome(b), 'beforeFindings': findings(a), 'afterFindings': findings(b)}
        if a['exported'] and b['exported']:
            row['changedOutputParts'] = only_manifest_order_and_jpeg_spelling_changed(a['output'], b['output'], a['source'])
            if not zipfile.is_zipfile(a['source']):
                # The corpus contains HWP containers named *.hwpx. These are
                # generated HWPX exports, not originals with a manifest order.
                # Keep their explicit malformed-original / unknown verdict.
                assert row['before'] == row['after'] == 'unknown'
                assert row['beforeFindings'] == row['afterFindings'] == ['originalMalformed:container']
                assert not row['changedOutputParts']
                row['originalContainer'] = 'NOT HWPX: manifest-order check not applicable'
                rows.append(row)
                continue
            source_order, source_mapping = order_and_mapping(a['source'])
            old_order, old_mapping = order_and_mapping(a['output'])
            new_order, new_mapping = order_and_mapping(b['output'])
            normalized = {key: dict(value) for key, value in new_mapping.items()}
            restored = []
            for key, item in normalized.items():
                if item != old_mapping.get(key) and item['media-type'] == 'image/jpg':
                    assert source_mapping[key]['media-type'] == 'image/jpg'
                    item['media-type'] = 'image/jpeg'
                    restored.append(key)
            assert old_mapping == normalized, 'unrelated item identity/metadata changed'
            assert [item for item in new_order if item in source_mapping] == source_order
            assert targets(b['output'])
            row.update(originalOrder=source_order, beforeOrder=old_order, afterOrder=new_order,
                       originalMapping=source_mapping, outputMapping=new_mapping,
                       restoredJpegMimeIds=restored,
                       orderDifferenceRemoved=old_order != source_order and new_order == source_order,
                       contentHpfEqual=oracle.equal(spine.content_hpf(a['source']), spine.content_hpf(b['output'])),
                       addedFindings=sorted(set(findings(b))-set(findings(a))),
                       removedFindings=sorted(set(findings(a))-set(findings(b))))
            assert not row['addedFindings'], row
        elif a['exported']:
            row['newRefusal'] = b.get('error')
            assert outcome(a) != 'safe', ('supported safe document regressed', row)
        else:
            row['beforeError'], row['afterError'] = a.get('error'), b.get('error')
        rows.append(row)
    return rows


def independently_newly_safe(package, before, after, out):
    out.mkdir()
    rows = []
    for a, b in zip(before, after, strict=True):
        if outcome(a) == 'safe' or outcome(b) != 'safe':
            continue
        source, saved = Path(a['source']), Path(b['output'])
        def unchanged(left, right):
            with zipfile.ZipFile(left) as x, zipfile.ZipFile(right) as y:
                assert set(x.namelist()) == set(y.namelist())
                for name in x.namelist():
                    old, new = x.read(name), y.read(name)
                    assert (oracle.equal(old, new) if name.endswith(('.xml', '.hpf', '.rdf', '.rels')) else old == new), name
        unchanged(source, saved)
        repeat = out/f'{a["i"]}-repeat.hwpx'
        result = spine.probe.export(package, saved, repeat)
        assert result['returncode'] == 0, result['diagnostic']
        unchanged(saved, repeat)
        assert order_and_mapping(source) == order_and_mapping(saved) == order_and_mapping(repeat)
        assert targets(saved) and targets(repeat)
        rows.append({'sample': str(source.relative_to(ROOT)), 'independentPackageEqual': True,
                     'modelReopenEquivalent': True, 'referencesValid': True, 'repeatStable': True,
                     'editedNativeSave': 'NOT RUN: no-edit eligibility only'})
    return rows


def focused_roundtrips(package, out):
    out.mkdir()
    rows = []
    # Baseline probe demonstrated model-preserving no-edit exports on these.
    for i, rel in enumerate((REPRESENTATIVES[0], REPRESENTATIVES[2], REPRESENTATIVES[4],
                             REPRESENTATIVES[5], REPRESENTATIVES[6])):
        source = ROOT/'external/rhwp'/rel
        output = out/f'{i}.hwpx'
        result = spine.probe.export(package, source, output)
        assert result['returncode'] == 0, (rel, result['diagnostic'])
        repeat = out/f'{i}-repeat.hwpx'
        again = spine.probe.export(package, output, repeat)
        assert again['returncode'] == 0, (rel, again['diagnostic'])
        assert spine.content_hpf(repeat) == spine.content_hpf(output)
        original_order, original_map = order_and_mapping(source)
        assert order_and_mapping(output)[0] == original_order
        assert targets(output)
        row = {'sample': rel, 'modelReopenEquivalent': True, 'manifestOrderEqual': True,
               'referencesValid': True, 'reexportStable': True, 'mapping': original_map}
        # Actual edit is supported on the two accepted blank-preview documents.
        if rel in REPRESENTATIVES[5:7]:
            edit = out/f'{i}-edit.hwpx'
            edited = spine.probe.export(package, source, edit, edit=True)
            assert edited['returncode'] == 0, edited['diagnostic']
            assert order_and_mapping(edit) == order_and_mapping(source)
            row['editedModelReopenEquivalent'] = True
        rows.append(row)
    return rows


def negatives(package, out):
    out.mkdir()
    source = ROOT/'external/rhwp/samples/종이기준.hwpx'
    content = spine.content_hpf(source).decode()
    needle = '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>'
    assert content.count(needle) == 1
    cases = {
        'duplicate-id': content.replace(needle, needle+needle),
        'duplicate-href': content.replace(needle, needle+needle.replace('id="header"', 'id="alias"')),
        'conflicting-href': content.replace('href="Contents/header.xml"', 'href="Contents/missing.xml"'),
        'missing-reference-target': content.replace(needle, ''),
        'missing-href': content.replace('href="Contents/header.xml"', ''),
        'missing-media-type': content.replace('media-type="application/xml"', '', 1),
        'unknown-attribute': content.replace('id="header"', 'id="header" opaque="keep"'),
        'opaque-item': content.replace(needle, needle+'<opf:item id="opaque" href="Opaque/data.xml" media-type="application/xml"/>'),
        'extension-child': content.replace(needle, needle+'<x:item xmlns:x="urn:foreign"/>'),
        'manifest-comment': content.replace(needle, needle+'<!-- keep -->'),
        'dangling-script': content.replace(needle, needle+'<opf:item id="script" href="Scripts/missing.js" media-type="application/javascript"/>'),
    }
    rows = []
    for name, mutated in cases.items():
        path, output = out/f'{name}.hwpx', out/f'{name}-out.hwpx'
        spine.mutated_package(source, path, mutated.encode())
        digest = spine.sha(path)
        result = spine.probe.export(package, path, output)
        assert result['returncode'] != 0 and result['diagnostic']['stage'] in ('open', 'export'), result
        assert not output.exists() and spine.sha(path) == digest
        rows.append({'name': name, 'sourceUnchanged': True, 'error': result['diagnostic']})
    jpeg_source = ROOT/'external/rhwp/samples/hwpx/156160455-social-pig-farm-income.hwpx'
    for name, replacement in [('jpeg-wrong-signature', b'not a JPEG')]:
        path, output = out/f'{name}.hwpx', out/f'{name}-out.hwpx'
        with zipfile.ZipFile(jpeg_source) as a, zipfile.ZipFile(path, 'w') as b:
            for entry in a.infolist():
                b.writestr(entry, replacement if entry.filename == 'BinData/image1.jpg' else a.read(entry.filename))
        digest = spine.sha(path)
        result = spine.probe.export(package, path, output)
        assert result['returncode'] != 0 and result['diagnostic']['stage'] in ('open', 'export'), result
        assert not output.exists() and spine.sha(path) == digest
        rows.append({'name': name, 'sourceUnchanged': True, 'error': result['diagnostic']})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before-package', type=Path, required=True)
    parser.add_argument('--package', type=Path)
    parser.add_argument('--checker', type=Path, default=ROOT/'src-tauri/target/debug/examples/save_check')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--representatives-only', action='store_true')
    parser.add_argument('--corpus-only', action='store_true', help='reuse separately passed focused regression results')
    parser.add_argument('--reuse-exports', action='store_true', help='reanalyze an identity-sealed completed export/preflight batch')
    parser.add_argument('--baseline-evidence', type=Path, help='reuse a verified before batch from a previous A/B run')
    args = parser.parse_args()
    args.out = args.out.resolve()
    if args.reuse_exports:
        assert args.out.is_dir() and not args.out.is_symlink()
    else:
        args.out.mkdir(parents=True, exist_ok=False)
    if args.package is None:
        identity = json.loads((ROOT/'public/rhwp/RELEASE.json').read_text())
        args.package = ROOT/'public/rhwp/generations'/identity['generation']
    packages = [args.before_package.resolve(), args.package.resolve()]
    identities = []
    for package in packages:
        identity = json.loads((package/'BUILD.json').read_text())
        for name, digest in identity['artifacts'].items():
            assert spine.sha(package/name) == digest
        identities.append(identity)
    fixtures = ([ROOT/'external/rhwp'/p for p in REPRESENTATIVES] if args.representatives_only
                else sorted((ROOT/'external/rhwp').rglob('*.hwpx')))
    run_identity = {'identities': identities, 'checkerSha256': spine.sha(args.checker),
                    'fixtures': [{'path': str(p), 'sha256': spine.sha(p)} for p in fixtures]}
    identity_path = args.out/'run-identity.json'
    if args.reuse_exports:
        assert json.loads(identity_path.read_text()) == run_identity, 'stale corpus evidence identity'
        before, after = (reuse_corpus(fixtures, args.out/name) for name in ('before', 'after'))
    else:
        identity_path.write_text(json.dumps(run_identity, ensure_ascii=False, indent=2)+'\n')
        if args.baseline_evidence:
            cached = args.baseline_evidence.resolve()
            prior = json.loads((cached/'run-identity.json').read_text())
            assert prior['identities'][0] == identities[0] and prior['checkerSha256'] == run_identity['checkerSha256']
            assert prior['fixtures'] == run_identity['fixtures']
            (args.out/'before').symlink_to(cached/'before', target_is_directory=True)
            before = reuse_corpus(fixtures, cached/'before')
        else:
            before = export_corpus(packages[0], fixtures, args.out/'before', args.checker.resolve())
        after = export_corpus(packages[1], fixtures, args.out/'after', args.checker.resolve())
    rows = compare(before, after)
    result = {'status': 'PASS', 'identities': identities, 'checkerSha256': spine.sha(args.checker),
              'fixtureCount': len(fixtures), 'beforeCounts': dict(Counter(outcome(r) for r in before)),
              'afterCounts': dict(Counter(outcome(r) for r in after)),
              'orderDifferencesRemoved': sum(r.get('orderDifferenceRemoved', False) for r in rows),
              'newlySafe': [r['sample'] for r in rows if r['before'] != 'safe' and r['after'] == 'safe'],
              'findingsChanged': sum(r['beforeFindings'] != r['afterFindings'] for r in rows),
              'newRefusals': [r['sample'] for r in rows if r.get('newRefusal')], 'documents': rows}
    (args.out/'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    result['newlySafeIndependent'] = independently_newly_safe(packages[1], before, after, args.out/'newly-safe')
    if not args.corpus_only:
        result['focused'] = focused_roundtrips(packages[1], args.out/'focused')
        result['negative'] = negatives(packages[1], args.out/'negative')
    (args.out/'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('identities', 'documents', 'focused', 'negative')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
