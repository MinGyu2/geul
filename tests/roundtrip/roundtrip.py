#!/usr/bin/env python3
"""T009 HWP·HWPX 실제 엔진 왕복 시험(rhwp WASM + 앱과 같은 저장 판정 함수).

픽스처는 실행할 때 만든다(tests/fixtures/rhwp/generate.mjs, 바이너리를 커밋하지 않음). 음성 사례는 그 픽스처를 결정적으로
고쳐 만든다(본문 XML 자르기, 모르는 요소·부분 넣기, 손실 보고 바꾸기, 형식 바꾸기). 판정은 `cargo run --example save_check`
(src-tauri/src/services/save/service.rs의 preflight·check_saved)로 한다. 파일은 임시 디렉터리에만 쓴다.

    python3 tests/roundtrip/roundtrip.py [--report <결과 JSON>]

종료 코드: 모든 항목이 기대와 같으면 0, 아니면 1.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OPS = ROOT / "tests" / "roundtrip" / "rhwp_ops.mjs"
RESULTS: list[dict] = []


def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, cwd=ROOT).stdout.strip()


def save_check(*args: str) -> dict:
    out = run("cargo", "run", "--quiet", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
              "--example", "save_check", "--", *args)
    return json.loads(out)


def check(name: str, ok: bool, detail: object) -> None:
    RESULTS.append({"name": name, "passed": ok, "detail": detail})
    print(f"[{'통과' if ok else '실패'}] {name} — {json.dumps(detail, ensure_ascii=False)[:400]}", flush=True)


def codes(verdict: dict) -> list[tuple[str, str | None]]:
    return [(f["code"], f.get("part")) for f in verdict["findings"]]


def rezip(source: Path, target: Path, change) -> None:
    """HWPX를 항목 순서·압축 방식을 지키며 다시 쓴다. change(name, data) -> data | None(빼기)."""
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for info in zin.infolist():
            data = change(info.filename, zin.read(info.filename))
            if data is not None:
                zout.writestr(info, data)
        extra = change("<add>", b"")
        if extra:
            name, data = extra
            zout.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_DEFLATED)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="geul-t009-rt-") as scratch:
        tmp = Path(scratch)
        run("node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(tmp))
        # 대표 문서: 열기 → 편집 없는 왕복(사전 검사) → 편집 → 내보내기 → 다시 열기 비교 → 저장 검사.
        for fmt in ("hwp", "hwpx"):
            original = tmp / f"basic-ko.{fmt}"
            unedited, loss0 = tmp / f"unedited.{fmt}", tmp / f"loss0-{fmt}.json"
            run("node", str(OPS), "unedited", str(original), str(unedited), str(loss0))
            verdict = save_check("preflight", fmt, str(original), str(unedited), str(loss0))
            check(f"{fmt}: 대표 문서의 편집 없는 왕복은 safe(손실 0건, 원본과 같음)", verdict["outcome"] == "safe", verdict)
            edited, loss1, reopen = tmp / f"edited.{fmt}", tmp / f"loss1-{fmt}.json", tmp / f"reopen-{fmt}.json"
            info = json.loads(run("node", str(OPS), "edit", str(original), str(edited), str(loss1), str(reopen)))
            reopened = json.loads(reopen.read_text())
            check(f"{fmt}: 편집한 출력을 다시 열면 형식·쪽 수·본문·컨트롤이 편집 모델과 같고 편집 글자가 있음",
                  all(reopened.values()) and info["editPresent"], {"reopen": reopened, **info})
            verdict = save_check("saved", fmt, str(original), str(edited), str(loss1), "true")
            if fmt == "hwp":
                # 고정 rhwp는 원본 PrvText(여기서는 편집 전 본문 글자)가 있으면 그대로 둔다(cfb_writer.rs supplement_preview).
                # 편집 전 글자가 파일에 남으므로 막아야 한다(T009 안정화 F).
                check("hwp: 편집한 저장 출력에 편집 전 미리보기 글자(PrvText)가 남으면 unsafe(previewStale)",
                      verdict["outcome"] == "unsafe" and codes(verdict) == [("previewStale", "PrvText")], verdict)
            else:
                check(f"{fmt}: 편집한 저장 출력은 본문 밖이 원본과 같고 미리보기가 비어 safe", verdict["outcome"] == "safe", verdict)
            # 손실 보고 불일치·손실·다시 열기 불일치·형식 불일치.
            report = json.loads(loss1.read_text())
            tampered = tmp / f"tampered-{fmt}.json"
            tampered.write_text(json.dumps({**report, "count": 1}))
            verdict = save_check("saved", fmt, str(original), str(edited), str(tampered), "true")
            check(f"{fmt}: count와 목록이 다른 손실 보고는 unknown(LossReportInvalid)",
                  verdict["outcome"] == "unknown" and ("lossReportInvalid", None) in codes(verdict), verdict)
            lost = tmp / f"lost-{fmt}.json"
            lost.write_text(json.dumps({**report, "count": 1, "losses": [{"code": "controlOmitted", "subject": "control",
                                                                         "path": "section0/para0/ctrl0", "reason": "unsupportedByOutputFormat"}]}))
            verdict = save_check("saved", fmt, str(original), str(edited), str(lost), "true")
            check(f"{fmt}: 컨트롤 생략 손실 보고는 unsafe(LossReported)",
                  verdict["outcome"] == "unsafe" and ("lossReported", "section0/para0/ctrl0") in codes(verdict), verdict)
            verdict = save_check("saved", fmt, str(original), str(edited), str(loss1), "false")
            check(f"{fmt}: 다시 열기 비교가 다르면 unsafe(ReopenMismatch)", ("reopenMismatch", None) in codes(verdict), verdict)
            other = "hwpx" if fmt == "hwp" else "hwp"
            verdict = save_check("saved", fmt, str(original), str(tmp / f"edited.{other}" if (tmp / f"edited.{other}").exists() else tmp / f"basic-ko.{other}"), str(loss1), "true")
            check(f"{fmt}: 다른 형식의 출력은 unsafe(OutputMalformed container)",
                  verdict["outcome"] != "safe" and ("outputMalformed", "container") in codes(verdict), verdict)
        # HWPX 음성 사례: 원본을 고쳐 엔진 왕복이 원본을 지키지 못하는지 본다.
        source = tmp / "basic-ko.hwpx"

        def case(name: str, change, expect_outcome: str, expect_code: tuple[str, str | None] | None) -> None:
            mutated = tmp / f"case-{len(RESULTS)}.hwpx"
            rezip(source, mutated, change)
            opened = subprocess.run(["node", str(OPS), "open", str(mutated)], capture_output=True, text=True, cwd=ROOT)
            if opened.returncode != 0:
                check(f"hwpx: {name} — rhwp가 열지 못함(저장 대상 아님)", expect_outcome == "unopenable", {"stderr": opened.stderr[-200:]})
                return
            out, loss = tmp / f"case-out-{len(RESULTS)}.hwpx", tmp / f"case-loss-{len(RESULTS)}.json"
            run("node", str(OPS), "unedited", str(mutated), str(out), str(loss))
            verdict = save_check("preflight", "hwpx", str(mutated), str(out), str(loss))
            ok = verdict["outcome"] == expect_outcome and (expect_code is None or expect_code in codes(verdict))
            check(f"hwpx: {name} → {expect_outcome} (rhwp 열기 {opened.stdout.strip()})", ok, verdict)

        def truncate_section(name: str, data: bytes):
            if name == "Contents/section0.xml":
                return data[: len(data) * 2 // 3]
            return None if name == "<add>" else data

        def unknown_element(name: str, data: bytes):
            if name == "Contents/section0.xml":
                return data.replace(b"</hs:sec>", b"<hp:unknownGeulTest xmlns:hp=\"http://www.hancom.co.kr/hwpml/2011/paragraph\"/></hs:sec>")
            return None if name == "<add>" else data

        def unknown_attribute(name: str, data: bytes):
            if name == "Contents/header.xml":
                return data.replace(b"<hh:head ", b"<hh:head geulTest=\"1\" ", 1)
            return None if name == "<add>" else data

        def extra_part(name: str, data: bytes):
            return ("Custom/geul-test.bin", b"\x00\x01extra") if name == "<add>" else data

        case("본문 section0.xml을 2/3에서 자름(끝까지 읽을 수 없는 XML)", truncate_section, "unknown", ("originalMalformed", "Contents/section0.xml"))
        case("본문에 rhwp가 모르는 요소를 넣음", unknown_element, "unsafe", ("partChanged", "Contents/section0.xml"))
        case("header.xml 루트에 모르는 속성을 넣음", unknown_attribute, "unsafe", ("partChanged", "Contents/header.xml"))
        case("manifest에 없는 부분을 넣음", extra_part, "unsafe", ("partMissing", "Custom/geul-test.bin"))
    passed = sum(r["passed"] for r in RESULTS)
    print(f"\nT009 rhwp 왕복: {passed}/{len(RESULTS)}개 통과", flush=True)
    if args.report:
        args.report.write_text(json.dumps(RESULTS, ensure_ascii=False, indent=2))
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
