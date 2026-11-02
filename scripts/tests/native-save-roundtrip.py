#!/usr/bin/env python3
"""Native SC-002 probe. Requires prepared X11 + ibus-hangul, a running dev host,
existing external tests/, generated fixtures, and the current geul debug app.
No DOM composition events are synthesized. Outputs/fixtures stay outside Git.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback
import xml.etree.ElementTree as ET
import xml.sax
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesImpl
import zipfile

ROOT = Path(__file__).resolve().parents[2]
for folder in ("tests/e2e", "tests/integration/rhwp", "tests/integration/wordcraft"):
    sys.path.insert(0, str(ROOT / folder))
import tauri_smoke as smoke
import rhwp_poc as rhwp
import wordcraft_poc as docx

TEXT = "한글 입력 테스트"



def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def rezip(source, target, transform):
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(target, "w") as after:
        for item in before.infolist():
            after.writestr(item, transform(item.filename, before.read(item.filename)))


def add_root_attribute(data):
    # Preserve literal namespace declarations/prefixes. ElementTree renames them,
    # and RHWP retains some raw fragments that then have undeclared prefixes.
    output = io.BytesIO()

    class Writer(XMLGenerator):
        first = True

        def startElement(self, name, attrs):
            if self.first:
                attrs = AttributesImpl({**dict(attrs), "unverifiedExtension": "retained-or-blocked"})
                self.first = False
            super().startElement(name, attrs)

    parser = xml.sax.make_parser()
    parser.setFeature(xml.sax.handler.feature_external_ges, False)
    parser.setContentHandler(Writer(output, encoding="utf-8"))
    parser.parse(io.BytesIO(data))
    return output.getvalue()


def rhwp_structure(original, published, expected_first):
    code = r"""
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const [root,original,published,first]=process.argv.slice(2);
const r=await import(pathToFileURL(resolve(root,'public/rhwp/rhwp.js')));
r.initSync({module:readFileSync(resolve(root,'public/rhwp/rhwp_bg.wasm'))});
const snapshot=d=>({format:d.getSourceFormat(),pages:d.pageCount(),
 paragraphs:Array.from({length:d.getParagraphCount(0)},(_,p)=>d.getTextRange(0,p,0,d.getParagraphLength(0,p))),
 controls:d.getControls(),bold:JSON.parse(d.getCharPropertiesAt(0,1,1)).bold,
 cells:Array.from({length:4},(_,c)=>d.getTextInCell(0,2,0,c,0,0,d.getCellParagraphLength(0,2,0,c,0)))});
const a=new r.HwpDocument(readFileSync(original)),b=new r.HwpDocument(readFileSync(published));
try { const before=snapshot(a),after=snapshot(b);before.paragraphs[0]=first;
 assert.deepEqual(after,before);assert.equal(after.bold,true);
 console.log(JSON.stringify({modelEquivalent:true,format:after.format,pages:after.pages,tableCells:after.cells.length,boldKept:true}));
} finally {a.free();b.free();}
"""
    return json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-", str(ROOT), str(original), str(published), expected_first],
        input=code, text=True, cwd=ROOT))


def docx_structure(original, published):
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(original) as a, zipfile.ZipFile(published) as b:
        assert b.testzip() is None
        before = ET.fromstring(a.read("word/document.xml"))
        after = ET.fromstring(b.read("word/document.xml"))
        tables_a = [ET.tostring(e) for e in before.findall(".//w:tbl", ns)]
        tables_b = [ET.tostring(e) for e in after.findall(".//w:tbl", ns)]
        assert tables_a and tables_a == tables_b, "DOCX table XML differs"
        paras_a = before.findall("w:body/w:p", ns)
        paras_b = after.findall("w:body/w:p", ns)
        assert len(paras_a) == len(paras_b)
        assert [ET.tostring(p) for p in paras_a[1:]] == [ET.tostring(p) for p in paras_b[1:]], "untouched paragraph XML differs"
        assert {p.filename for p in a.infolist()} == {p.filename for p in b.infolist()}
    return {"tableXmlEqual": True, "untouchedParagraphXmlEqual": True, "packagePartSetEqual": True}


def run(args):
    report = {"status": "RUNNING", "formats": args.formats, "positive": [], "rejections": [], "imeSetup": []}
    args.out.mkdir(parents=True, exist_ok=False)
    originals = args.out / "originals"
    originals.mkdir()
    smoke.APP = str(args.app.resolve())
    smoke.DRIVER_LOG = args.out / "driver.log"
    report["appSha256"] = sha(args.app)
    report["sourceHead"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    report["rhwpIdentity"] = json.loads((ROOT / "public/rhwp/BUILD.json").read_bytes())
    report["environment"] = {"input": "native xdotool -> IBus hangul -> GTK/WebView", "syntheticComposition": False}
    native_env = {k: v for k, v in os.environ.items() if k not in {"LD_LIBRARY_PATH", "IBUS_USE_PORTAL"}}

    def command(*arguments):
        result = subprocess.run(arguments, env=native_env, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"native command {Path(arguments[0]).name} failed: {result.stderr.strip()}")
        return result.stdout.strip()

    def input_korean(d, probe):
        probe.click_paragraph_start(d)
        window = command(args.xdotool, "search", "--onlyvisible", "--name", "^geul").split()[-1]
        command(args.xdotool, "windowfocus", "--sync", window)
        # The legacy native gate also observes input even if the global selector
        # fails. Keep that diagnostic; actual on-page preedit/commit below is
        # mandatory and must prove the active input context is Korean.
        setup = subprocess.run([args.ibus, "engine", "hangul"], env=native_env, capture_output=True, text=True)
        report["imeSetup"].append({"exit": setup.returncode, "stderr": setup.stderr.strip()})
        command(args.xdotool, "key", "End")
        before = probe.settle(d, "before integrated IME")
        d.js(probe.EVENT_LOG)
        command(args.xdotool, "type", "--delay", "90", "gk")
        mid = probe.settle(d, "integrated preedit")
        assert mid["composing"] == "true"
        if probe is docx:
            assert mid["paragraphText"] == before["paragraphText"]
            assert mid["composition"] == "하"
            overlay = d.js("const e=document.querySelector('[data-testid=docx-composition]');return e && {text:e.textContent,visible:getComputedStyle(e).visibility}")
            assert overlay == {"text": "하", "visible": "visible"}
        else:
            assert mid["paragraphText"] == before["paragraphText"] + "하"
        command(args.xdotool, "type", "--delay", "90", "srmf dlqfur xptmxm")
        command(args.xdotool, "key", "End")
        after = probe.settle(d, "integrated IME commit")
        assert after["paragraphText"] == before["paragraphText"] + TEXT
        assert after["composing"] == "false" and int(after["revision"]) > int(before["revision"])
        assert after["dirty"] == "true" and after["unpreserved"] == "true"
        return after["paragraphText"]

    def memory_roundtrip(d, prefix):
        d.js("document.querySelector(arguments[0]).click()", f"[data-testid={prefix}-roundtrip]")
        selector = f"[data-testid={prefix}-roundtrip-result]"
        smoke.wait_until(d, "return document.querySelector(arguments[0])!==null", selector, timeout=60)
        result = d.js("return {...document.querySelector(arguments[0]).dataset}", selector)
        assert result["passed"] == result["pagesEqual"] == result["textEqual"] == "true"
        assert result["modelEqual" if prefix == "docx" else "controlsEqual"] == "true"
        return result

    def reject(d, probe, path, reason, finding=None):
        before = sha(path)
        input_korean(d, probe)
        result = probe.save_and_wait(d)
        assert result["state"] == "failed" and result["error"] == reason, result
        if finding:
            assert finding in result.get("findings", ""), result
            assert d.exists("[data-testid=save-findings]")
        assert sha(path) == before and probe.status(d)["unpreserved"] == "true"
        report["rejections"].append({"case": path.name, "error": reason, "findings": result.get("findings"), "sha256": before, "originalUnchanged": True, "uiFailed": True})

    try:
        with smoke.tauri_driver(args.driver, args.port, str(args.out / "appdata")) as start:
            for fmt in args.formats:
                probe = docx if fmt == "docx" else rhwp
                path = args.out / f"native.{fmt}"
                shutil.copyfile(args.fixtures / f"basic-ko.{fmt}", path)
                shutil.copyfile(path, originals / path.name)
                d = start()
                try:
                    smoke.wait_until(d, "return document.querySelector('#document-path')!==null", timeout=30)
                    probe.open_document(d, path)
                    old_hash = sha(path)
                    expected = input_korean(d, probe)
                    assert sha(path) == old_hash
                    memory = memory_roundtrip(d, "docx" if fmt == "docx" else "rhwp")
                    prefix = "docx" if fmt == "docx" else "rhwp"
                    probe.press_button(d, f"[data-testid={prefix}-save-check]")
                    smoke.wait_until(d, "const e=document.querySelector(arguments[0]); return e && e.dataset.state==='idle' && e.dataset.outcome==='safe'", f"[data-testid={prefix}-save-result]", timeout=60)
                    result = probe.save_and_wait(d)
                    assert result["state"] == "saved", result
                    current = probe.status(d)
                    assert current["dirty"] == current["unpreserved"] == "false"
                    assert result["revision"] == current["revision"] and sha(path) != old_hash
                    assert result["synced"] == "true", "directory fsync not confirmed"
                    sessions = probe.ipc(d, "document_sessions")["ok"]
                    saved = next(item for item in sessions if item["displayName"] == path.name)
                    assert saved["revision"] == int(current["revision"]) and saved["dirty"] is False
                    # HWP repeat save checks the same WASM model still holding its initial preview.
                    if fmt == "hwp":
                        expected = input_korean(d, probe)
                        result = probe.save_and_wait(d)
                        current = probe.status(d)
                        assert result["state"] == "saved" and result["synced"] == "true"
                        assert result["revision"] == current["revision"] and current["dirty"] == current["unpreserved"] == "false"
                        saved = next(item for item in probe.ipc(d, "document_sessions")["ok"] if item["displayName"] == path.name)
                        assert saved["revision"] == int(current["revision"]) and saved["dirty"] is False
                    closed = probe.close_without_prompt(d, path.name) if fmt == "docx" else probe.close_tab(d, path.name)
                    assert closed, "saved revision unexpectedly prompts discard"
                    reopened = probe.open_document(d, path)
                    probe.click_paragraph_start(d)
                    assert reopened["status"] == "ready" and probe.status(d)["paragraphText"] == expected
                    structure = docx_structure(originals / path.name, path) if fmt == "docx" else rhwp_structure(originals / path.name, path, expected)
                    published = args.out / f"published.{fmt}"
                    shutil.copyfile(path, published)
                    assert sha(published) == sha(path)
                    report["positive"].append({"publishedFile": published.name, "format": fmt, "save": result, "durable": True, "preflight": "safe", "memoryReopen": memory, "publishedSha256": sha(path), "nativeReopenEqual": True, "structure": structure, "repeatSave": fmt == "hwp"})
                    (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))

                    # An external change after loading must survive the attempted save exactly.
                    input_korean(d, probe)
                    path.write_bytes(path.read_bytes() + b"\0")
                    changed_hash = sha(path)
                    result = probe.save_and_wait(d)
                    assert result["state"] == "failed" and result["error"] == "FileConflict", result
                    assert sha(path) == changed_hash and probe.status(d)["unpreserved"] == "true"
                    report["rejections"].append({"case": f"external-conflict-{fmt}", "error": "FileConflict", "originalUnchanged": True, "uiFailed": True})
                    # Other rejection probes use their own documents within the same native session.
                    if fmt == "hwpx":
                        source = args.fixtures / "basic-ko.hwpx"
                        stale = args.out / "stale-preview.hwpx"
                        rezip(source, stale, lambda n, b: b"previous private preview" if n == "Preview/PrvText.txt" else b)
                        probe.open_document(d, stale)
                        reject(d, probe, stale, "UnsafeSave", "previewStale:Preview/PrvText.txt")
                        unknown = args.out / "unknown-attribute.hwpx"
                        def attribute(n, b):
                            if n != "Contents/header.xml": return b
                            return add_root_attribute(b)
                        rezip(source, unknown, attribute)
                        probe.open_document(d, unknown)
                        reject(d, probe, unknown, "UnsafeSave", "partChanged:Contents/header.xml")
                        for label in ("invalid-reference", "truncated-output"):
                            target = args.out / f"{label}.hwpx"
                            shutil.copyfile(source, target)
                            fault = args.out / f"{label}-payload.hwpx"
                            def damage(n, b):
                                if n != "Contents/section0.xml": return b
                                tree = ET.fromstring(b)
                                run = next(e for e in tree.iter() if "charPrIDRef" in e.attrib)
                                run.set("charPrIDRef", "4294967295")
                                return ET.tostring(tree, encoding="utf-8", xml_declaration=True)
                            rezip(source, fault, damage)
                            payload = fault.read_bytes() if label == "invalid-reference" else b"PK\x03"
                            probe.open_document(d, target)
                            input_korean(d, probe)
                            probe.press_button(d, "[data-testid=rhwp-save-check]")
                            smoke.wait_until(d, "return document.querySelector('[data-testid=rhwp-save-result]')?.dataset.outcome==='safe'", timeout=60)
                            before = sha(target)
                            session = next(item for item in probe.ipc(d, "document_sessions")["ok"] if item["displayName"] == target.name)
                            # Direct IPC exercises the backend's untrusted serialization boundary;
                            # it does not pretend the editor exported the injected payload.
                            reply = d.js("""
                              const s=arguments[0],payload=Uint8Array.from(atob(arguments[1]),c=>c.charCodeAt(0));
                              const meta=new TextEncoder().encode(JSON.stringify({contentLoss:{schemaVersion:1,outputFormat:'hwpx',count:0,losses:[]},reopen:{formatEqual:true,pagesEqual:true,textEqual:true,controlsEqual:true}}));
                              const frame=new Uint8Array(32+meta.length+payload.length),view=new DataView(frame.buffer);
                              frame.set(new TextEncoder().encode('GSV1'));[s.sessionId,s.loadGeneration,s.revision].forEach((n,i)=>view.setBigUint64(4+8*i,BigInt(n),true));
                              view.setUint32(28,meta.length,true);frame.set(meta,32);frame.set(payload,32+meta.length);
                              return window.__TAURI_INTERNALS__.invoke('document_save',frame).then(value=>({ok:value}),error=>({err:error}));
                            """, session, base64.b64encode(payload).decode())
                            assert reply["err"]["code"] == "UnsafeSave", reply
                            findings = reply["err"]["preservation"]["findings"]
                            expected = "referenceInvalid" if label == "invalid-reference" else "outputMalformed"
                            assert any(item["code"] == expected for item in findings), reply
                            assert sha(target) == before and probe.status(d)["unpreserved"] == "true"
                            ui = d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
                            assert ui["state"] != "saved"
                            report["rejections"].append({"case": target.name,"mode":"direct IPC serialization fault","error":"UnsafeSave","findings":findings,"originalUnchanged":True,"uiState":ui["state"],"uiFalseSuccess":False})
                    if fmt == "docx":
                        for label in ("unknown-part", "malformed-xml"):
                            target = args.out / f"{label}.docx"
                            source = args.fixtures / "basic-ko.docx"
                            def damage(n, b):
                                if label != "malformed-xml" or n != "word/document.xml": return b
                                # Deliberately truncate a valid serialization in its body text, as the legacy negative fixture does.
                                marker = b"</w:t>"
                                at = b.rfind(marker, 0, len(b) * 2 // 3)
                                assert at > 0
                                return b[:at]
                            rezip(source, target, damage)
                            if label == "unknown-part":
                                with zipfile.ZipFile(target, "a") as archive:
                                    archive.writestr("customXml/item1.xml", b'<root xmlns="urn:geul:unknown"><v>1</v></root>')
                            probe.open_document(d, target)
                            reject(d, probe, target, "UnsafeSave", "partMissing:customXml/item1.xml" if label == "unknown-part" else "originalMalformed:word/document.xml")
                    assert not list(args.out.glob(".geul-save-*.tmp"))
                finally:
                    smoke.end_session(d)
        assert len(report["positive"]) == len(args.formats)
        report["status"] = "PASS"
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = type(error).__name__ + ": " + str(error)
        traceback.print_exc()
    finally:
        (args.out / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"status": report["status"], "positive": len(report["positive"]), "rejections": len(report["rejections"])}))
    return 0 if report["status"] == "PASS" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--xdotool", required=True)
    parser.add_argument("--ibus", required=True)
    parser.add_argument("--formats", nargs="+", choices=["hwp", "hwpx", "docx"], default=["hwp", "hwpx", "docx"], help="focused rerun; default requires all three formats")
    parser.add_argument("--port", type=int, default=4444)
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
