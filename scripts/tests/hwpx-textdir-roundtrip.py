#!/usr/bin/env python3
"""Bounded Stage 2 candidate regression; private fixtures/results remain in target.

A corrected attribute is not end-to-end compatibility. All independent geul
preservation findings remain authoritative; no comparator rules are changed.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET
import xml.sax
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesImpl
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HH = "http://www.hancom.co.kr/hwpml/2011/head"
MARKER = "검증"
CODE = r"""
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const [pkg,input,out,edit,expectedPriorCount]=process.argv.slice(2);
const MARKER='검증';
let stage='input', d, e, r;
const fail=(message)=>{throw new Error(message)};
const snapshot=(doc)=>({
 sections:Array.from({length:doc.getSectionCount()},(_,sec)=>
  Array.from({length:doc.getParagraphCount(sec)},(_,para)=>
   doc.getTextRange(sec,para,0,doc.getParagraphLength(sec,para)))),
 unicodeText:doc.getTextFileUnicode(), controls:doc.getControls(), pages:doc.pageCount()
});
const markerCount=(value)=>value.split('검증').length-1;
const digest=(value)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
 const inputBytes=readFileSync(input);
 stage='open';
 const m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
 m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
 d=new m.HwpDocument(inputBytes);
 const before=snapshot(d);
 let after=before, insertResult=null;
 if(edit==='true'){
  stage='edit';
  if(!before.sections.length||!before.sections[0].length)fail('document has no first paragraph');
  const beforeText=before.sections.flat().join('\n');
  const actualPriorCount=markerCount(beforeText);
  if(actualPriorCount!==Number(expectedPriorCount))
   fail(`prior edit marker count ${actualPriorCount} != expected ${expectedPriorCount}`);
  insertResult=JSON.parse(d.insertText(0,0,0,'검증'));
  if(insertResult?.ok!==true)fail(`insertText did not return ok=true: ${JSON.stringify(insertResult)}`);
  after=snapshot(d);
  const expectedFirst=MARKER+before.sections[0][0];
  if(after.sections[0][0]!==expectedFirst)fail('first paragraph does not equal the requested prefix plus original text');
  if(after.sections.length!==before.sections.length)fail('edit changed section count');
  if(after.sections[0].length!==before.sections[0].length)fail('edit changed section 0 paragraph count');
  for(let i=1;i<before.sections[0].length;i++)
   if(after.sections[0][i]!==before.sections[0][i])fail(`edit changed unrelated section 0 paragraph ${i}`);
  for(let sec=1;sec<before.sections.length;sec++)
   if(JSON.stringify(after.sections[sec])!==JSON.stringify(before.sections[sec]))
    fail(`edit changed unrelated section ${sec}`);
  if(after.controls!==before.controls)fail('edit changed document controls');
  const afterText=after.sections.flat().join('\n');
  if(afterText===beforeText)fail('document content did not change');
  const actualAfterCount=markerCount(afterText);
  if(actualAfterCount!==actualPriorCount+1)fail(`edit marker count ${actualAfterCount} != ${actualPriorCount+1}`);
  if(after.unicodeText===before.unicodeText)fail('Unicode document text did not change');
 }
 stage='export';
 e=d.exportHwpxWithReport();
 const loss=JSON.parse(e.contentLoss()), bytes=e.takeBytes();
 writeFileSync(out,bytes); writeFileSync(out+'.loss.json',JSON.stringify(loss));
 stage='reopen';
 r=new m.HwpDocument(bytes);
 const reopened=snapshot(r);
 if(JSON.stringify(reopened)!==JSON.stringify(after))fail('raw export/reopen snapshot differs from intended document model');
 const success={ok:true,stage:'complete',input,inputSha256:createHash('sha256').update(inputBytes).digest('hex'),
  output:out,outputSha256:createHash('sha256').update(bytes).digest('hex'),edited:edit==='true',
  insertResult,beforeSnapshotSha256:digest(before),expectedSnapshotSha256:digest(after),
  reopenedSnapshotSha256:digest(reopened),rawReopenMatchesIntendedModel:true,
  firstParagraphBefore:before.sections?.[0]?.[0]??null,firstParagraphAfter:after.sections?.[0]?.[0]??null,
  priorMarkerCount:edit==='true'?Number(expectedPriorCount):markerCount(before.sections.flat().join('\n')),
  markerCountAfter:markerCount(after.sections.flat().join('\n')),
  unrelatedParagraphsUnchanged:true,controlsUnchanged:edit==='true'?after.controls===before.controls:true,
  sectionCount:after.sections.length,paragraphCounts:after.sections.map(s=>s.length),pages:after.pages,
  contentLoss:loss};
 console.log(JSON.stringify(success));
} catch(error) {
 console.error(JSON.stringify({ok:false,stage,opened:!!d,error:String(error?.message??error),stack:error?.stack??null}));
 process.exitCode=1;
} finally {r?.free();e?.free();d?.free();}
"""


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def export(package, source, out, edit=False, prior_edit_count=0):
    command = ["node", "--input-type=module", "-", str(package), str(source), str(out),
               "true" if edit else "false", str(prior_edit_count)]
    result = subprocess.run(command, input=CODE, text=True, cwd=ROOT, capture_output=True)
    def last_json(text):
        for line in reversed(text.splitlines()):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
        return None

    evidence = last_json(result.stdout) if result.returncode == 0 else None
    diagnostic = last_json(result.stderr) if result.returncode != 0 else None
    return {"command": command, "returncode": result.returncode, "stdout": result.stdout,
            "stderr": result.stderr, "evidence": evidence, "diagnostic": diagnostic}


def package_entries(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, f"invalid ZIP CRC: {path}"
        return archive.namelist(), {item.filename: (item, archive.read(item.filename))
                                   for item in archive.infolist()}


def header(path):
    _, entries = package_entries(path)
    return entries["Contents/header.xml"][1]


def directions(path):
    return [(p.attrib["id"], p.attrib["textDir"])
            for p in ET.fromstring(header(path)).iter("{" + HH + "}paraPr") if "textDir" in p.attrib]


def normalized_header(data):
    root = ET.fromstring(data)
    for para in root.iter("{" + HH + "}paraPr"):
        para.attrib.pop("textDir", None)
    return ET.tostring(root, encoding="utf-8")


def invalid_direction(source, target, value, expected_count):
    source_names, source_entries = package_entries(source)
    source_header = source_entries["Contents/header.xml"][1]
    original_root = ET.fromstring(source_header)
    original_directions = [(para.attrib.get("id"), para.attrib["textDir"])
                           for para in original_root.iter("{" + HH + "}paraPr")
                           if "textDir" in para.attrib]
    assert len(original_directions) == expected_count
    assert {direction for _, direction in original_directions} == {"LTR"}
    output = io.BytesIO()
    changed = 0

    class Writer(XMLGenerator):
        def startElement(self, name, attrs):
            nonlocal changed
            attrs = dict(attrs)
            if name == "hh:paraPr" and "textDir" in attrs:
                attrs["textDir"] = value
                changed += 1
            super().startElement(name, AttributesImpl(attrs))

    parser = xml.sax.make_parser()
    parser.setFeature(xml.sax.handler.feature_external_ges, False)
    parser.setContentHandler(Writer(output, encoding="utf-8"))
    parser.parse(io.BytesIO(source_header))
    assert changed == expected_count, f"mutated {changed} attributes, expected {expected_count}"
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(target, "w") as after:
        for entry in before.infolist():
            after.writestr(entry, output.getvalue() if entry.filename == "Contents/header.xml"
                            else before.read(entry.filename))

    target_names, target_entries = package_entries(target)
    assert target_names == source_names, "package entry names/order changed"
    mutated_header = target_entries["Contents/header.xml"][1]
    mutated_root = ET.fromstring(mutated_header)  # Explicit well-formedness check.
    mutated_directions = [(para.attrib.get("id"), para.attrib["textDir"])
                          for para in mutated_root.iter("{" + HH + "}paraPr")
                          if "textDir" in para.attrib]
    assert len(mutated_directions) == expected_count
    assert all(direction == value for _, direction in mutated_directions)
    assert [ident for ident, _ in mutated_directions] == [ident for ident, _ in original_directions]
    assert normalized_header(source_header) == normalized_header(mutated_header), \
        "unrelated header structure changed"
    for name in source_names:
        original_info, original_bytes = source_entries[name]
        mutated_info, mutated_bytes = target_entries[name]
        if name != "Contents/header.xml":
            assert mutated_bytes == original_bytes, f"unrelated package data changed: {name}"
        assert (mutated_info.date_time, mutated_info.compress_type, mutated_info.comment,
                mutated_info.extra, mutated_info.create_system, mutated_info.external_attr) == \
               (original_info.date_time, original_info.compress_type, original_info.comment,
                original_info.extra, original_info.create_system, original_info.external_attr), \
            f"unrelated ZIP metadata changed: {name}"


def run_command(command):
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, default=ROOT / "target/hwpx-preservation-candidate/web")
    parser.add_argument("--baseline", type=Path, default=ROOT / "public/rhwp")
    parser.add_argument("--out", type=Path, default=ROOT / "target/four-stage/stage2-textdir/regression")
    parser.add_argument("--checker", type=Path,
                        default=ROOT / "src-tauri/target/debug/examples/save_check")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.candidate = args.candidate.resolve()
    args.baseline = args.baseline.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    checker = args.checker.resolve()
    if not checker.is_file() or not os.access(checker, os.X_OK):
        raise SystemExit(f"save_check executable unavailable: {checker}; prepare with: "
                         "python3 scripts/cargo-geul.py build --example save_check")

    identity_path = args.candidate.parent / "candidate.json"
    identity = json.loads(identity_path.read_text())
    assert identity["baseCommit"] == "1a76570e833917d15817415a53c09ad61ab3203f"
    for name, expected_hash in identity["artifacts"].items():
        assert sha256(args.candidate / name) == expected_hash
    baseline_identity = json.loads((args.baseline / "BUILD.json").read_text())
    assert baseline_identity["commit"] == identity["baseCommit"]
    for name, expected_hash in baseline_identity["artifacts"].items():
        assert sha256(args.baseline / name) == expected_hash

    sample = ROOT / "external/rhwp/samples/종이기준.hwpx"
    expected = directions(sample)
    assert len(expected) == 20 and {value for _, value in expected} == {"LTR"}
    fixture_dir = args.out / "generated-fixtures"
    fixture_command = ["node", "tests/fixtures/rhwp/generate.mjs", str(fixture_dir)]
    run_command(fixture_command)
    generated = fixture_dir / "basic-ko.hwpx"
    assert generated.is_file()
    assert directions(generated) == [], "generated absent-direction fixture must have no textDir"

    outputs = {}
    node_commands = []
    export_evidence = {}
    for name, package, source, edit, prior_count in [
        ("baseline", args.baseline, sample, False, 0),
        ("candidate", args.candidate, sample, False, 0),
        ("edited", args.candidate, sample, True, 0),
        ("repeated", args.candidate, args.out / "edited.hwpx", True, 1),
    ]:
        output = args.out / (name + ".hwpx")
        result = export(package, source, output, edit, prior_count)
        node_commands.append(result["command"])
        (args.out / (name + ".log")).write_text(result["stdout"] + result["stderr"])
        if result["returncode"] != 0:
            raise AssertionError(f"{name} export failed at {result['diagnostic']}")
        assert result["evidence"] and result["evidence"]["ok"] is True
        if edit:
            evidence = result["evidence"]
            assert evidence["insertResult"]["ok"] is True
            assert evidence["priorMarkerCount"] == prior_count
            assert evidence["markerCountAfter"] == prior_count + 1
            assert evidence["firstParagraphAfter"] == MARKER + evidence["firstParagraphBefore"]
            assert evidence["rawReopenMatchesIntendedModel"] is True
            assert evidence["unrelatedParagraphsUnchanged"] is True
            assert evidence["controlsUnchanged"] is True
        actual = directions(output)
        assert actual == ([] if name == "baseline" else expected), (name, actual)
        outputs[name] = output
        export_evidence[name] = result["evidence"]

    # Verify exact restoration against the external source, using every XML
    # element/attribute and all opaque parts. The production comparator below
    # remains independently authoritative.
    original_names, original_entries = package_entries(sample)
    candidate_names, candidate_entries = package_entries(outputs["candidate"])
    assert set(original_names) == set(candidate_names)
    def tree(node):
        return (node.tag, tuple(sorted(node.attrib.items())), node.text, node.tail,
                tuple(tree(child) for child in node))
    for name in original_names:
        a, b = original_entries[name][1], candidate_entries[name][1]
        if name.endswith((".xml", ".hpf", ".rdf", ".rels")):
            assert tree(ET.fromstring(a)) == tree(ET.fromstring(b)), name
        else:
            assert a == b, name
    for name in ("candidate", "edited", "repeated"):
        root = ET.fromstring(header(outputs[name]))
        assert tree(root) == tree(ET.fromstring(header(sample))), "header lost during supported text edit"
        with zipfile.ZipFile(outputs[name]) as archive, zipfile.ZipFile(sample) as source:
            ids = lambda z: [e.attrib["id"] for part in z.namelist() if part.startswith("Contents/section") and part.endswith(".xml")
                             for e in ET.fromstring(z.read(part)).iter("{http://www.hancom.co.kr/hwpml/2011/paragraph}p")]
            assert ids(archive) == ids(source), "existing paragraph identities changed"

    absent_result = export(args.candidate, generated, args.out / "absent.hwpx", True, 0)
    node_commands.append(absent_result["command"])
    assert absent_result["returncode"] == 0 and absent_result["evidence"]["ok"] is True
    absent = args.out / "absent.hwpx"
    assert directions(absent) == [], "absent direction must not be invented"
    negative = []
    for index, value in enumerate(("RTL", "UNKNOWN", "")):
        source = args.out / f"unsupported-{index}.hwpx"
        invalid_direction(sample, source, value, expected_count=len(expected))
        result = export(args.candidate, source, args.out / f"invalid-out-{index}.hwpx")
        node_commands.append(result["command"])
        assert result["returncode"] != 0, "unsupported direction accepted"
        error = result["diagnostic"]
        assert error and error["ok"] is False, "failure lacked structured Node diagnostic"
        assert error["stage"] == "export" and error["opened"] is True, f"unexpected rejection stage/cause: {error}"
        assert "unsupported HWPX textDir:" in error["error"], f"unrelated parse error: {error}"
        negative.append({"value": value, "mutationCount": len(expected), "xmlWellFormed": True,
                         "unrelatedHeaderAndPackageUnchanged": True,
                         "rejectionStage": error["stage"], "rejectionCause": error["error"]})

    preflight = {}
    preflight_commands = []
    for name in ("baseline", "candidate"):
        output = outputs[name]
        command = [str(checker), "preflight", "hwpx", str(sample), str(output),
                   str(output) + ".loss.json"]
        result = run_command(command)
        preflight_commands.append(command)
        preflight[name] = json.loads(result.stdout)
        assert preflight[name]["outcome"] == ("unsafe" if name == "baseline" else "safe"), preflight[name]

    commands = [fixture_command, *node_commands, *preflight_commands]
    negative_inputs = {f"{value or 'empty'}": args.out / f"unsupported-{index}.hwpx"
                       for index, value in enumerate(("RTL", "UNKNOWN", ""))}
    report = {"status": "ISOLATED_SAFE_APP_ACCEPTANCE_PENDING",
              "sample": str(sample.relative_to(ROOT)), "sampleSha256": sha256(sample),
              "generatedAbsentDirectionFixture": str(generated.relative_to(ROOT)),
              "generatedFixtureSha256": sha256(generated),
              "explicitLtrCount": len(expected), "baselineRetained": 0,
              "candidateRetained": len(expected), "sourcePackageXmlAndOpaquePartsRestored": "PASS",
              "absentDirectionUnchanged": "PASS", "editedAndRepeatedRawReopen": "PASS",
              "editEvidence": {name: {key: export_evidence[name][key] for key in
                                      ("inputSha256", "outputSha256", "beforeSnapshotSha256",
                                       "expectedSnapshotSha256", "reopenedSnapshotSha256",
                                       "firstParagraphBefore", "firstParagraphAfter",
                                       "priorMarkerCount", "markerCountAfter", "rawReopenMatchesIntendedModel")}
                               for name in ("edited", "repeated")},
              "negative": negative, "preflight": preflight,
              "packageSha256": {name: sha256(path) for name, path in outputs.items()} |
                               {"absentDirection": sha256(absent)} |
                               {f"negative-{name}": sha256(path) for name, path in negative_inputs.items()},
              "candidateIdentity": identity,
              "baselineRuntimeArtifacts": baseline_identity,
              "checker": {"path": str(checker), "sha256": sha256(checker),
                          "sizeBytes": checker.stat().st_size,
                          "mtimeNs": checker.stat().st_mtime_ns},
              "tools": {"node": run_command(["node", "--version"]).stdout.strip(),
                        "python": sys.version.split()[0]},
              "commands": commands,
              "actualApplicationSafeSave": "NOT RUN: isolated test only",
              "productAssetsChanged": False}
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
