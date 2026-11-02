#!/usr/bin/env python3
"""Bounded Stage 2 candidate regression; private fixtures/results remain in target.

A corrected attribute is not end-to-end compatibility. All independent geul
preservation findings remain authoritative; no comparator rules are changed.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET
import xml.sax
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesImpl
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HH = "http://www.hancom.co.kr/hwpml/2011/head"
CODE = r"""
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const [pkg,input,out,edit]=process.argv.slice(2);
const m=await import(pathToFileURL(resolve(pkg,'rhwp.js')));
m.initSync({module:readFileSync(resolve(pkg,'rhwp_bg.wasm'))});
let d;
try {
 d=new m.HwpDocument(readFileSync(input));
 if(edit==='true')d.insertText(0,0,0,'검증');
 const text=d.getTextFileText(), controls=d.getControls(), pages=d.pageCount();
 const e=d.exportHwpxWithReport();
 try {
  const loss=e.contentLoss(),bytes=e.takeBytes();
  writeFileSync(out,bytes);writeFileSync(out+'.loss.json',loss);
  const r=new m.HwpDocument(bytes);
  try {if(r.getTextFileText()!==text||r.getControls()!==controls||r.pageCount()!==pages)throw Error('raw reopen mismatch');}
  finally{r.free();}
 } finally{e.free();}
} finally{d?.free();}
"""


def export(package, source, out, edit=False):
    return subprocess.run(["node", "--input-type=module", "-", str(package), str(source), str(out),
                           "true" if edit else "false"], input=CODE, text=True, cwd=ROOT,
                          capture_output=True)


def header(path):
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        return z.read("Contents/header.xml")


def directions(path):
    return [(p.attrib["id"], p.attrib["textDir"])
            for p in ET.fromstring(header(path)).iter("{" + HH + "}paraPr") if "textDir" in p.attrib]


def invalid_direction(source, target, value):
    output = io.BytesIO()

    class Writer(XMLGenerator):
        def startElement(self, name, attrs):
            attrs = dict(attrs)
            if name == "hh:paraPr" and "textDir" in attrs:
                attrs["textDir"] = value
            super().startElement(name, AttributesImpl(attrs))

    parser = xml.sax.make_parser()
    parser.setFeature(xml.sax.handler.feature_external_ges, False)
    parser.setContentHandler(Writer(output, encoding="utf-8"))
    parser.parse(io.BytesIO(header(source)))
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(target, "w") as after:
        for entry in before.infolist():
            after.writestr(entry, output.getvalue() if entry.filename == "Contents/header.xml" else before.read(entry.filename))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, default=ROOT / "target/four-stage/stage2-textdir/web")
    parser.add_argument("--out", type=Path, default=ROOT / "target/four-stage/stage2-textdir/regression")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    identity = json.loads((args.candidate.parent / "candidate.json").read_text())
    assert identity["baseCommit"] == "1a76570e833917d15817415a53c09ad61ab3203f"
    for name, expected_hash in identity["artifacts"].items():
        assert hashlib.sha256((args.candidate / name).read_bytes()).hexdigest() == expected_hash
    baseline_identity = json.loads((ROOT / "public/rhwp/BUILD.json").read_text())
    assert baseline_identity["commit"] == identity["baseCommit"]
    for name, expected_hash in baseline_identity["artifacts"].items():
        assert hashlib.sha256((ROOT / "public/rhwp" / name).read_bytes()).hexdigest() == expected_hash
    sample = ROOT / "external/rhwp/samples/종이기준.hwpx"
    expected = directions(sample)
    assert expected and {v for _, v in expected} == {"LTR"}
    outputs = {}
    for name, package, source, edit in [
        ("baseline", ROOT / "public/rhwp", sample, False),
        ("candidate", args.candidate, sample, False),
        ("edited", args.candidate, sample, True),
        ("repeated", args.candidate, args.out / "edited.hwpx", True),
    ]:
        output = args.out / (name + ".hwpx")
        result = export(package, source, output, edit)
        (args.out / (name + ".log")).write_text(result.stdout + result.stderr)
        assert result.returncode == 0, name
        actual = directions(output)
        assert actual == ([] if name == "baseline" else expected), (name, actual)
        outputs[name] = output
    # Against the pinned export, the candidate's sole package change must be
    # the selected attributes. This does not forgive losses against the source.
    with zipfile.ZipFile(outputs["baseline"]) as before, zipfile.ZipFile(outputs["candidate"]) as after:
        assert set(before.namelist()) == set(after.namelist())
        for name in before.namelist():
            a, b = before.read(name), after.read(name)
            if name != "Contents/header.xml":
                assert a == b, name
            else:
                aa, bb = ET.fromstring(a), ET.fromstring(b)
                for para in bb.iter("{" + HH + "}paraPr"):
                    para.attrib.pop("textDir", None)
                assert ET.tostring(aa) == ET.tostring(bb), "unrelated header XML changed"
    generated = ROOT / "target/four-stage/stage1/basic-ko.hwpx"
    assert directions(generated) == []
    absent = args.out / "absent.hwpx"
    assert export(args.candidate, generated, absent, True).returncode == 0
    assert directions(absent) == [], "absent direction must not be invented"
    negative = []
    for index, value in enumerate(("RTL", "UNKNOWN", "")):
        source = args.out / f"unsupported-{index}.hwpx"
        invalid_direction(sample, source, value)
        result = export(args.candidate, source, args.out / f"invalid-out-{index}.hwpx")
        assert result.returncode != 0, "unsupported direction accepted"
        negative.append({"value": value, "parseRejected": True})
    preflight = {}
    checker = ROOT / "src-tauri/target/debug/examples/save_check"
    for name in ("baseline", "candidate"):
        output = outputs[name]
        result = subprocess.run([str(checker), "preflight", "hwpx", str(sample), str(output),
                                 str(output) + ".loss.json"], check=True, capture_output=True, text=True)
        preflight[name] = json.loads(result.stdout)
        assert preflight[name]["outcome"] != "safe", "independent losses must remain blocked"
    report = {"status": "PARTIAL_DEFECT_FIXED_STAGE_INCOMPLETE", "sample": str(sample.relative_to(ROOT)),
              "explicitLtrCount": len(expected), "baselineRetained": 0,
              "candidateRetained": len(expected), "unrelatedPackageBytesAndHeaderXml": "PASS",
              "absentDirectionUnchanged": "PASS", "editedAndRepeatedRawReopen": "PASS",
              "negative": negative, "preflight": preflight,
              "actualApplicationSafeSave": "NOT RUN: independent preflight losses remain",
              "productAssetsChanged": False}
    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
