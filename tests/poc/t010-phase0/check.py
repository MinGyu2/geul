#!/usr/bin/env python3
"""T010 Phase 0 PoC(시험 전용): 픽스처를 만들고 rhwp_phase0.mjs를 돌린 뒤, 내보낸 파일을 실제 T009 판정(`cargo run --example
save_check`, 앱과 같은 `services::save::service::{preflight, check_saved}`)에 넣어 결과와 진단 코드를 기록한다.

    python3 tests/poc/t010-phase0/check.py --out <결과 JSON> [--large-hwp 파일] [--large-hwpx 파일]

모든 파일은 임시 디렉터리에서 만들고 끝나면 지운다. 원본 표본 문서는 읽기만 한다. 음성 대조: HWPX 출력을 고쳐(본문과 무관한
header 속성, 보호 부분, 없는 charPrIDRef) 판정이 막는지 본다.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def run(*cmd: str, cwd: Path = ROOT, allowed: tuple[int, ...] = (0,)) -> str:
    done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if done.returncode not in allowed:
        raise SystemExit(f"실패 {cmd[:3]} (종료 코드 {done.returncode}): {done.stderr[-800:]}")
    return done.stdout


def save_check(*args: str) -> dict:
    out = run("cargo", "run", "--quiet", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
              "--example", "save_check", "--", *args, allowed=(0, 1))  # 판정이 safe가 아니면 1
    return json.loads(out)


def codes(verdict: dict) -> list[list]:
    return [[f["code"], f.get("part")] for f in verdict.get("findings", [])]


def rezip(source: Path, target: Path, change) -> None:
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for info in zin.infolist():
            zout.writestr(info, change(info.filename, zin.read(info.filename)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--large-hwp")
    parser.add_argument("--large-hwpx")
    args = parser.parse_args()
    report: dict = {"verdicts": [], "negative": []}
    with tempfile.TemporaryDirectory(prefix="geul-t010-p0-") as scratch:
        tmp = Path(scratch)
        fixtures, out = tmp / "fixtures", tmp / "out"
        run("node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures))
        extra = [a for a in (args.large_hwp, args.large_hwpx) if a]
        print(run("node", str(Path(__file__).with_name("rhwp_phase0.mjs")), str(fixtures), str(out), *extra)[-3000:])
        results = json.loads((out / "results.json").read_text())
        for entry in results["files"]:
            fmt, file = entry["fmt"], entry["file"]
            original = str(out / f"original.{fmt}")
            loss = f"{file}.loss.json"
            if entry["name"] == "e1-unedited":
                verdict = save_check("preflight", fmt, original, file, loss)
                mode = "preflight"
            else:
                reopen = "true" if all(entry["reopen"].values()) else "false"
                verdict = save_check("saved", fmt, original, file, loss, reopen)
                mode = "saved"
            row = {"name": entry["name"], "fmt": fmt, "mode": mode, "outcome": verdict.get("outcome"), "codes": codes(verdict),
                   "reopen": entry["reopen"], "lossCount": entry["loss"].get("count"), "charShapes": entry["charShapes"], "diff": entry["diff"]}
            report["verdicts"].append(row)
            print(f"[{row['outcome']}] {fmt} {entry['name']} {mode} codes={row['codes']} charShapes={entry['charShapes']}")
        # 음성 대조(HWPX): 안전한 글자 편집 출력을 고친다. 판정은 같은 save_check.
        control = out / "e-control-text.hwpx"
        original = str(out / "original.hwpx")
        loss = f"{control}.loss.json"
        cases = {
            "header 무관 속성 변경(beginNum page)": lambda n, d: re.sub(rb'page="1"', b'page="2"', d, count=1) if n == "Contents/header.xml" else d,
            "보호 부분(settings.xml) 변경": lambda n, d: d.replace(b"CaretPosition", b"CaretPositioX", 1) if n == "settings.xml" else d,
            "본문에 없는 charPrIDRef(9999)": lambda n, d: re.sub(rb'charPrIDRef="\d+"', b'charPrIDRef="9999"', d, count=1)
            if n == "Contents/section0.xml" else d,
            "header에 charPr 하나 덧붙이고 itemCnt +1(좁은 예외 모양)": lambda n, d: (
                re.sub(rb'(<hh:charProperties itemCnt=")(\d+)"', lambda m: m.group(1) + str(int(m.group(2)) + 1).encode() + b'"', d, count=1)
                .replace(b"</hh:charProperties>", re.findall(rb"<hh:charPr\b[\s\S]*?</hh:charPr>", d)[0].replace(b'id="0"', b'id="99"', 1)
                         + b"</hh:charProperties>", 1)) if n == "Contents/header.xml" else d,
        }
        for label, change in cases.items():
            target = tmp / f"neg-{len(report['negative'])}.hwpx"
            rezip(control, target, change)
            changed = zipfile.ZipFile(target).read("Contents/header.xml") != zipfile.ZipFile(control).read("Contents/header.xml") or \
                any(zipfile.ZipFile(target).read(n) != zipfile.ZipFile(control).read(n) for n in zipfile.ZipFile(control).namelist())
            verdict = save_check("saved", "hwpx", original, str(target), loss, "true")
            # 같은 파일을 엔진으로 다시 열어 앱이 보낼 다시 열기 근거도 본다(본문 참조 오류를 엔진이 드러내는가).
            reopen = run("node", "-e", OPEN_SCRIPT, str(target), str(control))
            row = {"case": label, "mutated": changed, "outcome": verdict.get("outcome"), "codes": codes(verdict), "engineReopen": json.loads(reopen)}
            report["negative"].append(row)
            print(f"[neg {row['outcome']}] {label} codes={row['codes']} reopen={row['engineReopen']}")
        report["engine"] = {k: v for k, v in results.items() if k != "files"}
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"wrote {args.out}")
    return 0


# 고친 HWPX를 엔진으로 열어 대조 출력과 쪽 수·본문·컨트롤을 비교(앱의 다시 열기 근거와 같은 값).
OPEN_SCRIPT = r"""
const { readFileSync } = require("node:fs");
(async () => {
  const root = process.cwd();
  const rhwp = await import("file://" + root + "/public/rhwp/rhwp.js");
  rhwp.initSync({ module: readFileSync(root + "/public/rhwp/rhwp_bg.wasm") });
  const [a, b] = process.argv.slice(1).map((p) => new rhwp.HwpDocument(readFileSync(p)));
  const r = { pagesEqual: a.pageCount() === b.pageCount(), textEqual: a.getTextFileText() === b.getTextFileText(),
    controlsEqual: a.getControls() === b.getControls() };
  let props = null; try { props = JSON.parse(a.getCharPropertiesAt(0, 0, 0)).charShapeId; } catch (e) { props = "ERR " + e; }
  console.log(JSON.stringify({ ...r, firstCharShapeId: props }));
})();
"""

if __name__ == "__main__":
    sys.exit(main())
