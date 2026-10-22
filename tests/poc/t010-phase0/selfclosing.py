#!/usr/bin/env python3
"""T009 2차 고침 근거(시험 전용): HWPX 자기 닫힘 모양 정의를 고정 rhwp WASM이 실제로 등록하는지, 그리고 판정·저장 서비스가 엔진과
같게 해석하는지 본다. 모든 파일은 임시 디렉터리에서 만들고 지운다.

    TMPDIR=<쓰기 가능한 임시 디렉터리> python3 tests/poc/t010-phase0/selfclosing.py [--evidence <정리된 결과 JSON>]

만드는 원본(픽스처 basic-ko.hwpx의 header만 고침): 내용 있는 charPr id 12(크기 1700, 목록 맨 앞 — 빈 번호·순서 바뀜), 자기 닫힘 charPr
13(크기 2300)·14(쓰지 않음), 내용 있는 paraPr 21, 자기 닫힘 paraPr 22. 출력: 본문 첫 글 run을 12·13·7로, 첫 문단 paraPrIDRef를 21·22로
바꾼 사본(본문만 고친 합성 출력 — 엔진은 13을 가리키는 문서를 내보내지 못한다). 엔진 질의는 실제 WASM, 판정은 실제
`service::check_saved`, 저장은 실제 `service::save`(Rust 시험 t010_phase0_save_service).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from save_service import CARGO, HERE, ROOT, run, sha  # noqa: E402

PROBE = r"""
const { readFileSync, writeFileSync } = require("node:fs");
(async () => {
  const rhwp = await import("file://" + process.cwd() + "/public/rhwp/rhwp.js");
  rhwp.initSync({ module: readFileSync(process.cwd() + "/public/rhwp/rhwp_bg.wasm") });
  const out = {};
  for (const f of process.argv.slice(1)) {
    const name = f.split("/").pop();
    const d = new rhwp.HwpDocument(readFileSync(f));
    const c = JSON.parse(d.getCharPropertiesAt(0, 0, 1));
    const p = JSON.parse(d.getParaPropertiesAt(0, 0));
    const row = { charShapeId: c.charShapeId, fontSize: c.fontSize, bold: c.bold, paraShapeId: p.paraShapeId };
    try {
      const e = d.exportHwpxWithReport();
      const bytes = e.takeBytes(); const loss = e.contentLoss(); e.free();
      writeFileSync(f + ".export", bytes); writeFileSync(f + ".export.loss.json", loss);
      const re = new rhwp.HwpDocument(bytes);
      row.export = { ok: true, lossCount: JSON.parse(loss).count, reopenCharShapeId: JSON.parse(re.getCharPropertiesAt(0, 0, 1)).charShapeId,
        reopenFontSize: JSON.parse(re.getCharPropertiesAt(0, 0, 1)).fontSize };
      re.free();
    } catch (x) { row.export = { ok: false, error: String(x).slice(0, 120) }; }
    out[name] = row;
    d.free();
  }
  console.log(JSON.stringify(out));
})();
"""


def rezip(source: Path, target: Path, part: str, change) -> None:
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            zout.writestr(info, change(data.decode()).encode() if info.filename == part else data)


def craft_header(h: str) -> str:
    c7 = re.search(r'<hh:charPr id="7"[\s\S]*?</hh:charPr>', h).group(0)
    head7 = re.match(r"<hh:charPr [^>]*>", c7).group(0)
    p0 = re.search(r'<hh:paraPr id="0"[\s\S]*?</hh:paraPr>', h).group(0)
    headp0 = re.match(r"<hh:paraPr [^>]*>", p0).group(0)
    start12 = c7.replace('id="7" height="1000"', 'id="12" height="1700"', 1)
    empty13 = head7.replace('id="7" height="1000"', 'id="13" height="2300"')[:-1] + "/>"
    empty14 = head7.replace('id="7" height="1000"', 'id="14" height="900"')[:-1] + "/>"
    start21 = p0.replace('id="0"', 'id="21"', 1)
    empty22 = headp0.replace('id="0"', 'id="22"')[:-1] + "/>"
    h = h.replace('<hh:charProperties itemCnt="8">', '<hh:charProperties itemCnt="11">' + start12, 1)
    h = h.replace("</hh:charProperties>", empty13 + empty14 + "</hh:charProperties>", 1)
    h = h.replace('<hh:paraProperties itemCnt="20">', '<hh:paraProperties itemCnt="22">', 1)
    return h.replace("</hh:paraProperties>", start21 + empty22 + "</hh:paraProperties>", 1)


def run_ref(value: int):
    return lambda s: re.sub(r'<hp:run charPrIDRef="\d+"><hp:t>', f'<hp:run charPrIDRef="{value}"><hp:t>', s, count=1)


def para_ref(value: int):
    return lambda s: re.sub(r'<hp:p id="0" paraPrIDRef="\d+"', f'<hp:p id="0" paraPrIDRef="{value}"', s, count=1)


# 사례 → (본문 바꾸기, 엔진에 등록된 정의인가, 바라는 check_saved)
CASES = {
    "run-12-start": (run_ref(12), True, ("safe", [])),
    "run-7-existing": (run_ref(7), True, ("safe", [])),
    "run-13-self-closing": (run_ref(13), False, ("unsafe", [["referenceInvalid", "Contents/section0.xml"]])),
    "para-21-start": (para_ref(21), True, ("safe", [])),
    "para-22-self-closing": (para_ref(22), False, ("unsafe", [["referenceInvalid", "Contents/section0.xml"]])),
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="geul-t009-selfclosing-") as scratch:
        tmp = Path(scratch)
        run(["node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(tmp / "f")])
        fixture = tmp / "f/basic-ko.hwpx"
        original = tmp / "original.hwpx"
        rezip(fixture, original, "Contents/header.xml", craft_header)
        for name, (change, _, _) in CASES.items():
            rezip(original, tmp / f"{name}.hwpx", "Contents/section0.xml", change)
        engine = json.loads(run(["node", "-e", PROBE, str(original), *[str(tmp / f"{n}.hwpx") for n in CASES]]))
        # 원본의 편집 없는 엔진 출력: 엔진은 자기 닫힘 정의를 빼고 내보낸다 → 사전 검사가 header 변경으로 막는다.
        header_kept = zipfile.ZipFile(original).read("Contents/header.xml") == \
            zipfile.ZipFile(f"{original}.export").read("Contents/header.xml")
        export_defs = {k: bool(re.search(rf'<hh:{el} id="{i}"', zipfile.ZipFile(f"{original}.export").read("Contents/header.xml").decode()))
                       for k, el, i in [("charPr12", "charPr", 12), ("charPr13", "charPr", 13), ("charPr14", "charPr", 14),
                                        ("paraPr21", "paraPr", 21), ("paraPr22", "paraPr", 22)]}
        loss = tmp / "zero-loss.json"
        loss.write_text(json.dumps({"schemaVersion": 1, "outputFormat": "hwpx", "count": 0, "losses": []}))
        reopen = {"formatEqual": True, "pagesEqual": True, "textEqual": True, "controlsEqual": True}
        manifest = []
        for name in CASES:
            d = tmp / "work" / name
            d.mkdir(parents=True)
            shutil.copyfile(original, d / "doc.hwpx")
            manifest.append({"name": name, "fmt": "hwpx", "mode": "check", "target": str(d / "doc.hwpx"),
                             "output": str(tmp / f"{name}.hwpx"), "outputLoss": str(loss), "reopen": reopen})
        # 실제 저장 경로: 고친 원본(자기 닫힘 정의가 있는 header)을 세션에 열고 엔진의 편집 없는 출력으로 사전 검사 → 저장.
        d = tmp / "work" / "save-crafted-original"
        d.mkdir(parents=True)
        shutil.copyfile(original, d / "doc.hwpx")
        before = sha(d / "doc.hwpx")
        manifest.append({"name": "save-crafted-original", "fmt": "hwpx", "mode": "save", "target": str(d / "doc.hwpx"),
                         "unedited": f"{original}.export", "uneditedLoss": f"{original}.export.loss.json",
                         "output": str(tmp / "run-13-self-closing.hwpx"), "outputLoss": str(loss), "reopen": reopen})
        (tmp / "cases.json").write_text(json.dumps({"cases": manifest}))
        run(CARGO + ["진짜_엔진_출력을_저장_서비스에_넣는다"],
            {"GEUL_T010_MANIFEST": str(tmp / "cases.json"), "GEUL_T010_RESULTS": str(tmp / "results.json")})
        results = {r["name"]: r for r in json.loads((tmp / "results.json").read_text())["results"]}
        rows = []
        for name, (_, registered, (outcome, findings)) in CASES.items():
            got = results[name]["checkSaved"]
            got_findings = [[f["code"], f.get("part")] for f in got["findings"]]
            e = engine[f"{name}.hwpx"]
            ok = got["outcome"] == outcome and got_findings == findings
            rows.append({"case": name, "engine": e, "registered": registered, "checkSaved": got["outcome"], "findings": got_findings, "ok": ok})
            print(f"[{'ok' if ok else 'MISMATCH'}] {name}: engine={e} checkSaved={got['outcome']} {got_findings}")
            if not ok:
                failures.append(name)
        save = results["save-crafted-original"]
        save_ok = save["preflight"]["outcome"] != "safe" and not save["save"]["ok"] and save["targetEqualsOriginal"] \
            and sha(d / "doc.hwpx") == before and save["dirAfter"] == ["doc.hwpx"] and save["sessionAfter"]["dirty"]
        print(f"[{'ok' if save_ok else 'MISMATCH'}] 실제 저장: preflight={save['preflight']} save={save['save']} 원본 SHA 그대로={sha(d / 'doc.hwpx') == before}")
        if not save_ok:
            failures.append("save-crafted-original")
        # 엔진 의미(실측)가 판정 기대와 맞는지: 등록된 정의면 엔진이 그 크기·모양으로 읽고, 자기 닫힘이면 기본값으로 대체.
        semantics = {
            "start12_resolved": engine["run-12-start.hwpx"]["fontSize"] == 1700,
            "selfclosing13_fallback": engine["run-13-self-closing.hwpx"]["charShapeId"] == 13 and engine["run-13-self-closing.hwpx"]["fontSize"] == 1000,
            "selfclosing13_export_refused": not engine["run-13-self-closing.hwpx"]["export"]["ok"],
            "selfclosing22_export_allowed": engine["para-22-self-closing.hwpx"]["export"]["ok"],
            "export_drops_selfclosing": export_defs == {"charPr12": True, "charPr13": False, "charPr14": False, "paraPr21": True, "paraPr22": False},
            "unedited_header_changed": not header_kept,
        }
        print("엔진 의미:", semantics)
        failures += [k for k, v in semantics.items() if not v]
        evidence = {"rhwpCommit": json.loads((ROOT / "public/rhwp/BUILD.json").read_text())["commit"], "fixtureSha256": sha(fixture),
                    "craftedOriginalSha256": before, "engineExportDefinitions": export_defs, "semantics": semantics, "rows": rows,
                    "realSave": {k: save[k] for k in ("preflight", "save", "sessionAfter", "targetEqualsOriginal", "dirBefore", "dirAfter")},
                    "failures": failures}
        if args.evidence:
            args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=1).replace(str(tmp), "<tmp>") + "\n")
    print(f"불일치 {len(failures)}건 {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
