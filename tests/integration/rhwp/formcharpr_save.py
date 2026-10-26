#!/usr/bin/env python3
"""Optional pinned-engine positive formCharPr save/reopen regression (ordinary Rust CI is independent).

Synthetic XML controls in an API-generated document; actual service publication and
engine model interpretation are asserted for both body and table cell forms.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "tests/integration/rhwp/formcharpr-save.mjs"


def run(args, env=None):
    try:
        subprocess.run(args, cwd=ROOT, env={**os.environ, "CARGO_NET_OFFLINE": "true", **(env or {})},
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr.decode(errors="replace")[-3000:]) from error


def package(source, target, change):
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for info in zin.infolist():
            zout.writestr(info, change(info.filename, zin.read(info.filename)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    # Gate before generate.mjs can import/initialize RHWP or create a document.
    # The helper independently gates each later engine process as well.
    run(["node", str(HELPER.with_name("production-identity.mjs"))])
    with tempfile.TemporaryDirectory(prefix="geul-formcharpr-") as scratch:
        tmp = Path(scratch)
        run(["node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(tmp)])
        cases = []
        for location in ["body", "cell"]:
            original, output = tmp / f"{location}-original.hwpx", tmp / f"{location}-output.hwpx"
            form = (b'<hp:checkBtn name="GeulGoldenForm"><hp:formCharPr charPrIDRef="0" '
                    b'followContext="0" autoSz="0" wordWrap="0"/><hp:sz width="2400" height="1200"/>'
                    b'</hp:checkBtn>')

            def add_form(name, data):
                if name != "Contents/section0.xml":
                    return data
                start = data.index(b"<hp:tc") if location == "cell" else 0
                # Form is a direct child of the text run, as interpreted by the pinned parser.
                match = re.search(rb'<hp:run charPrIDRef="\d+"><hp:t>', data[start:])
                assert match
                at = start + match.end() - len(b"<hp:t>")
                return data[:at] + form + data[at:]

            package(tmp / "basic-ko.hwpx", original, add_form)
            with zipfile.ZipFile(original) as zin:
                header = zin.read("Contents/header.xml")
            shapes = re.findall(rb'<hh:charPr\b[\s\S]*?</hh:charPr>', header)
            shape_id = len(shapes)
            assert shape_id > 0
            appended = re.sub(rb'\bid="\d+"', f'id="{shape_id}"'.encode(), shapes[0], count=1)
            appended = appended.replace(b"</hh:charPr>", b"<hh:italic/></hh:charPr>")

            def format_form(name, data):
                if name == "Contents/header.xml":
                    data, count = re.subn(rb'(<hh:charProperties itemCnt=")\d+("[^>]*>)',
                                         lambda m: m[1] + str(shape_id + 1).encode() + m[2], data, count=1)
                    assert count == 1
                    return data.replace(b"</hh:charProperties>", appended + b"</hh:charProperties>")
                if name == "Contents/section0.xml":
                    return data.replace(b'<hp:formCharPr charPrIDRef="0"',
                                        f'<hp:formCharPr charPrIDRef="{shape_id}"'.encode())
                return data

            package(original, output, format_form)
            work = tmp / location
            work.mkdir()
            target = work / "doc.hwpx"
            shutil.copyfile(original, target)
            reopen = tmp / f"{location}-reopen.json"
            run(["node", str(HELPER), "prepare", str(original), str(output), str(target), str(reopen), str(shape_id)])
            cases.append({"name": location, "fmt": "hwpx", "mode": "save", "original": str(original),
                          "unedited": str(original), "uneditedLoss": f"{original}.loss.json",
                          "output": str(output), "outputLoss": f"{output}.loss.json",
                          "target": str(target), "expectedId": shape_id, "reopen": json.loads(reopen.read_text())})
        manifest, results = tmp / "manifest.json", tmp / "results.json"
        manifest.write_text(json.dumps({"cases": cases}))
        run(["cargo", "test", "--locked", "--offline", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
             "--test", "t010_phase0_save_service", "진짜_엔진_출력을_저장_서비스에_넣는다", "--", "--ignored", "--exact"],
            {"GEUL_T010_MANIFEST": str(manifest), "GEUL_T010_RESULTS": str(results)})
        rows = []
        for case, saved in zip(cases, json.loads(results.read_text())["results"], strict=True):
            assert saved["save"]["ok"] and saved["checkSaved"]["outcome"] == "safe", saved
            assert saved["targetEqualsOutput"] and not saved["sessionAfter"]["dirty"], saved
            assert saved["dirBefore"] == saved["dirAfter"] == ["doc.hwpx"]
            out = tmp / f'{case["name"]}-verified.json'
            run(["node", str(HELPER), "verify", case["original"], case["output"], case["target"], str(out), str(case["expectedId"])])
            observed = json.loads(out.read_text())
            assert observed["inCell"] == (case["name"] == "cell")
            rows.append({"location": case["name"], **observed, "dirtyCleared": True, "tempClean": True})
        evidence = {"provenance": "synthetic forms in pinned-WASM-generated document; real saved-byte engine reopen",
                    "rhwpRevision": "1a76570e833917d15817415a53c09ad61ab3203f", "results": rows}
        print(json.dumps(evidence, indent=2))
        if args.evidence:
            args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
