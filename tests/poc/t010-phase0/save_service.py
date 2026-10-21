#!/usr/bin/env python3
"""T010 Phase 0 마무리(시험 전용): 진짜 rhwp 서식 출력을 실제 저장 서비스(service::save)에 넣고, T009 글자 모양 참조 공백을
재현한다(Stage A·B). 모든 파일은 임시 디렉터리에서만 만들고 끝나면 지운다. 원본 픽스처는 generate.mjs가 매번 만든다.

    TMPDIR=<쓰기 가능한 임시 디렉터리> python3 tests/poc/t010-phase0/save_service.py [--evidence <정리된 결과 JSON>]

순서: 픽스처 생성 → save_inputs.mjs(엔진 출력·손실 보고·다시 열기 네 값) → Stage B 사본(HWPX는 여기서 zip으로, HWP는 Rust
시험이 CFB로) → 고친 사본을 엔진으로 다시 열기(save_inputs.mjs --probe) → 사례마다 원본 사본 하나를 작업 디렉터리에 두고
Rust 시험(src-tauri/tests/t010_phase0_save_service.rs)이 세션 기록·사전 검사·확정·저장 표·service::save를 부름 → 저장 전후
원본 사본 SHA-256·디렉터리 목록 비교.

판정: CURRENT(지금 동작의 특성 기록, 다르면 종료 코드 1)와 DESIRED(바라는 동작; 지금 실패하는 것은 '미해결 회귀'로 따로
적고 종료 코드에 넣지 않는다, --strict-desired면 넣는다)를 구별한다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
CARGO = ["cargo", "test", "--quiet", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
         "--test", "t010_phase0_save_service", "--", "--ignored", "--exact"]


def run(cmd: list[str], env: dict | None = None) -> str:
    done = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env={**os.environ, **(env or {})})
    if done.returncode != 0:
        raise SystemExit(f"실패 {cmd[:4]} (종료 코드 {done.returncode}):\n{done.stdout[-1500:]}\n{done.stderr[-1500:]}")
    return done.stdout


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rezip(source: Path, target: Path, part: str, change) -> bool:
    """`part` 하나만 바꾼 zip 사본(항목 순서·압축 방식 유지). 실제로 바뀌었는지 돌려준다."""
    changed = False
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename == part:
                new = change(data)
                changed = new != data
                data = new
            zout.writestr(info, data)
    return changed


def first_in_cell(data: bytes, attr: bytes, value: bytes) -> bytes:
    start = data.index(b"<hp:tc")
    head, tail = data[:start], data[start:]
    return head + re.sub(rb'%s="\d+"' % attr, b'%s="%s"' % (attr, value), tail, count=1)


def first(attr: bytes, value: bytes):
    return lambda d: re.sub(rb'%s="\d+"' % attr, b'%s="%s"' % (attr, value), d, count=1)


def text_run(value: bytes):
    """본문 첫 글 run(`<hp:run charPrIDRef=".."><hp:t>`)의 참조. 첫 charPrIDRef는 구역 정의(secPr)를 담은 run이다."""
    return lambda d: re.sub(rb'<hp:run charPrIDRef="\d+"><hp:t>', b'<hp:run charPrIDRef="%s"><hp:t>' % value, d, count=1)


# Stage B HWPX 사본: 엔진이 낸 글자 편집 출력(hwpx-text-body)의 한 곳만 고친다. 앞의 것이 바라는 판정(DESIRED).
HWPX_MUTATIONS = {
    "hwpx-b-body-9999": ("Contents/section0.xml", text_run(b"9999"), "unsafe"),
    "hwpx-b-cell-9999": ("Contents/section0.xml", lambda d: first_in_cell(d, b"charPrIDRef", b"9999"), "unsafe"),
    "hwpx-b-body-hole-8": ("Contents/section0.xml", text_run(b"8"), "unsafe"),  # itemCnt=8, id 0..7
    "hwpx-b-body-overflow-70000": ("Contents/section0.xml", text_run(b"70000"), "unsafe"),
    "hwpx-b-body-nonnumeric": ("Contents/section0.xml", text_run(b"abc"), "unsafe"),
    "hwpx-b-body-negative": ("Contents/section0.xml", text_run(b"-1"), "unsafe"),
    "hwpx-b-secpr-run-9999": ("Contents/section0.xml", first(b"charPrIDRef", b"9999"), "unsafe"),
    "hwpx-b-parapr-9999": ("Contents/section0.xml", first(b"paraPrIDRef", b"9999"), "unsafe"),
    # 대조: 있는 모양(굵게 id 7)을 가리키는 바꿈은 참조가 올바르다(바라는 판정도 safe).
    "hwpx-b-body-existing-7": ("Contents/section0.xml", text_run(b"7"), "safe"),
    # 대조: header의 charPr id 중복은 header 보호가 이미 막는다.
    "hwpx-b-header-duplicate-id": ("Contents/header.xml", lambda d: d.replace(b'<hh:charPr id="1"', b'<hh:charPr id="0"', 1), "unsafe"),
}

# 지금 동작(CURRENT): 사례 이름 → (check_saved 결과, service::save 성공 여부). save_inputs.mjs·위 사본과 짝.
CURRENT = {
    "hwp-italic-body": ("unsafe", False), "hwp-bold-body": ("unsafe", False), "hwp-underline-cell": ("unsafe", False),
    "hwp-text-body": ("unsafe", False), "hwp-italic-restored": ("safe", True),
    "hwpx-italic-body": ("unsafe", False), "hwpx-bold-body": ("safe", True), "hwpx-underline-cell": ("unsafe", False),
    "hwpx-text-body": ("safe", True), "hwpx-italic-restored": ("safe", True),
    "hwpx-b-body-9999": ("safe", True), "hwpx-b-cell-9999": ("safe", True), "hwpx-b-body-hole-8": ("safe", True),
    "hwpx-b-body-overflow-70000": ("safe", True), "hwpx-b-body-nonnumeric": ("safe", True),
    "hwpx-b-body-negative": ("safe", True), "hwpx-b-secpr-run-9999": ("safe", True), "hwpx-b-parapr-9999": ("safe", True),
    "hwpx-b-body-existing-7": ("safe", True), "hwpx-b-header-duplicate-id": ("unsafe", False),
    "hwp-b-dangling-9999": ("unsafe", False), "hwp-b-nopreview-dangling-9999": ("safe", None),
    "hwp-b-nopreview-edited": ("safe", None),
}
DESIRED = {**{k: v[2] for k, v in HWPX_MUTATIONS.items()}, "hwp-b-dangling-9999": "unsafe",
           "hwp-b-nopreview-dangling-9999": "unsafe", "hwp-b-nopreview-edited": "safe"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, help="정리된(경로·내용 없는) 결과를 쓸 파일")
    parser.add_argument("--strict-desired", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="geul-t010-save-") as scratch:
        tmp = Path(scratch)
        fixtures, engine, work = tmp / "fixtures", tmp / "engine", tmp / "work"
        run(["node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures)])
        fixture_sha = {f"basic-ko.{fmt}": sha(fixtures / f"basic-ko.{fmt}") for fmt in ("hwp", "hwpx")}
        print(run(["node", str(HERE / "save_inputs.mjs"), str(fixtures), str(engine)]), end="")
        manifest = json.loads((engine / "manifest.json").read_text())
        by_name = {c["name"]: c for c in manifest["cases"]}

        # Stage B HWPX 사본과 엔진 다시 열기.
        base = by_name["hwpx-text-body"]
        mutated = {}
        for name, (part, change, _) in HWPX_MUTATIONS.items():
            target = engine / f"{name}.hwpx"
            mutated[name] = rezip(Path(base["output"]), target, part, change)
        # Stage B HWP 사본(CFB는 Rust 시험이 고친다).
        hwp_base = by_name["hwp-text-body"]
        run(CARGO + ["hwp_없는_글자_모양_참조_사본을_만든다"],
            {"GEUL_T010_HWP_MUTATE": f"{fixtures / 'basic-ko.hwp'}\t{hwp_base['output']}\t{engine}"})
        hwp_mutation = json.loads((engine / "hwp-mutation.json").read_text())
        probe_hwpx = json.loads(run(["node", str(HERE / "save_inputs.mjs"), "--probe", base["output"],
                                     *[str(engine / f"{n}.hwpx") for n in HWPX_MUTATIONS]]))
        hwp_targets = ["hwp-b-dangling-9999", "hwp-b-nopreview-dangling-9999", "hwp-b-nopreview-edited"]
        probe_hwp = json.loads(run(["node", str(HERE / "save_inputs.mjs"), "--probe", hwp_base["output"],
                                    *[str(engine / f"{n}.hwp") for n in hwp_targets]]))
        probes = {Path(t["file"]).stem: t for t in probe_hwpx["targets"] + probe_hwp["targets"]}

        def derived(name: str, fmt: str, from_case: dict, mode: str = "save", original: Path | None = None) -> dict:
            probe = probes[name]
            reopen = {k: v for k, v in probe.get("reopen", {}).items() if k != "error"} if probe["opened"] else \
                {"formatEqual": False, "pagesEqual": False, "textEqual": False, "controlsEqual": False}
            return {**from_case, "name": name, "fmt": fmt, "mode": mode, "provenance": "synthetic-mutation-of-engine-output",
                    "original": str(original or from_case["original"]), "output": str(engine / f"{name}.{fmt}"), "reopen": reopen,
                    "engine": {"probe": probe.get("at"), "opened": probe["opened"]}}

        cases = list(manifest["cases"])
        cases += [derived(n, "hwpx", base) for n in HWPX_MUTATIONS]
        cases.append(derived("hwp-b-dangling-9999", "hwp", hwp_base))
        bare = engine / "hwp-b-nopreview-original.hwp"
        cases += [derived(n, "hwp", hwp_base, "check", bare) for n in hwp_targets[1:]]

        # 사례마다 원본 사본 하나(저장이 바꿀 수 있는 유일한 파일).
        before = {}
        for case in cases:
            d = work / case["name"]
            d.mkdir(parents=True)
            target = d / f"doc.{case['fmt']}"
            shutil.copyfile(case["original"], target)
            case["target"] = str(target)
            before[case["name"]] = sha(target)
        (tmp / "cases.json").write_text(json.dumps({"cases": cases}))
        run(CARGO + ["진짜_엔진_출력을_저장_서비스에_넣는다"],
            {"GEUL_T010_MANIFEST": str(tmp / "cases.json"), "GEUL_T010_RESULTS": str(tmp / "results.json")})
        results = {r["name"]: r for r in json.loads((tmp / "results.json").read_text())["results"]}

        rows, current_fail, desired_fail = [], [], []
        for case in cases:
            r, name = results[case["name"]], case["name"]
            after = sha(Path(case["target"]))
            out_sha = sha(Path(case["output"]))
            checked = r["checkSaved"]["outcome"]
            saved = r["save"]["ok"] if r["mode"] == "save" else None
            row = {
                "name": name, "fmt": case["fmt"], "mode": r["mode"], "provenance": case.get("provenance"),
                "reopenEqual": r["reopenEqual"], "reopen": case["reopen"],
                "preflight": r.get("preflight", {}).get("outcome"),
                "checkSaved": checked, "findings": [[f["code"], f.get("part")] for f in r["checkSaved"].get("findings", [])],
                "save": ("published" if saved else ("rejected" if saved is False else "not-run")),
                "saveError": None if r["mode"] != "save" or saved else
                    {"code": r["save"]["error"].get("code"),
                     "findings": [[f["code"], f.get("part")] for f in r["save"]["error"].get("preservation", {}).get("findings", [])]},
                "sessionAfter": r.get("sessionAfter"),
                "originalSha256": before[name], "afterSha256": after, "outputSha256": out_sha,
                "originalUnchanged": before[name] == after, "replacedWithOutput": after == out_sha,
                "dirBefore": r.get("dirBefore"), "dirAfter": r.get("dirAfter"), "engine": case.get("engine"),
            }
            rows.append(row)
            expected = CURRENT.get(name)
            ok = expected is not None and checked == expected[0] and (expected[1] is None or saved == expected[1])
            # 저장이 거부됐으면 원본 바이트·디렉터리 목록이 그대로여야 하고, 성공했으면 출력과 같아야 한다.
            if r["mode"] == "save":
                ok &= (row["replacedWithOutput"] if saved else row["originalUnchanged"])
                ok &= r["dirBefore"] == r["dirAfter"] == ["doc." + case["fmt"]]
            if not ok:
                current_fail.append(name)
            if name in DESIRED and checked != DESIRED[name]:
                desired_fail.append(name)
            print(f"[{'ok' if ok else 'CURRENT-MISMATCH'}] {name}: preflight={row['preflight']} checkSaved={checked} "
                  f"{row['findings']} save={row['save']} originalUnchanged={row['originalUnchanged']} reopen={r['reopenEqual']}")
        evidence = {
            "rhwpCommit": manifest["rhwpCommit"], "fixtureSha256": fixture_sha, "hwpMutation": hwp_mutation,
            "mutationApplied": mutated, "referenceProbe": {"hwpx": probe_hwpx["reference"], "hwp": probe_hwp["reference"]},
            "rows": rows, "currentMismatch": current_fail, "unresolvedDesired": desired_fail,
        }
        text = json.dumps(evidence, ensure_ascii=False, indent=1).replace(str(tmp), "<tmp>")
        if args.evidence:
            args.evidence.write_text(text + "\n")
            print(f"wrote {args.evidence}")
    print(f"CURRENT 불일치 {len(current_fail)}건 {current_fail}")
    print(f"DESIRED 미해결 회귀 {len(desired_fail)}건(바라는 판정과 다름, 수정 전이라 예상됨) {desired_fail}")
    return 1 if current_fail or (args.strict_desired and desired_fail) else 0


if __name__ == "__main__":
    sys.exit(main())
