#!/usr/bin/env python3
"""T010 서식 D3: 세션 서식 명령으로 바꾼 HWPX 모델을 실제 저장 서비스(service::save)에 넣는다.

    TMPDIR=<쓰기 가능한 임시 디렉터리> python3 tests/integration/rhwp/format_save.py [--evidence <정리된 결과 JSON>]

1) format-save.wasm.test.ts(GEUL_FORMAT_SAVE_OUT)가 서식 사례마다 원본·편집 전 왕복·서식 적용 출력을 앱과 같은 방식으로 쓰고, 다시 연
   문서에서 범위별 서식을 확인한다.
2) 사례마다 원본 사본 하나에 세션 기록·사전 검사·확정·저장(src-tauri/tests/t010_phase0_save_service.rs, undo_save.py와 같은 시험).
기대(T009 정책 그대로, 글자 서식 덧붙임 규칙): HWPX 서식 출력 → safe·게시·다시 열기 값 모두 같음. HWP 엔진 직접 서식 →
DocInfo 변경·미리보기 낡음으로 거부, 원본 SHA 그대로. 다르면 종료 코드 1.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CARGO = ["cargo", "test", "--quiet", "--locked", "--offline", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
         "--test", "t010_phase0_save_service", "--", "--ignored", "--exact", "진짜_엔진_출력을_저장_서비스에_넣는다"]
HWPX_CASES = ("body-bold", "multi-italic", "cell-underline", "bold-off", "strike", "bold-undone")


def run(cmd: list[str], env: dict) -> None:
    done = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env={**os.environ, **env})
    if done.returncode != 0:
        raise SystemExit(f"실패 {cmd[:4]}: {done.stdout[-1500:]}\n{done.stderr[-1500:]}")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    failures: list[str] = []
    rows = []
    with tempfile.TemporaryDirectory(prefix="geul-t010-format-d3-") as scratch:
        tmp = Path(scratch)
        out = tmp / "out"
        run(["npx", "vitest", "run", "--config", "tests/integration/rhwp/vitest.config.ts", "format-save"], {"GEUL_FORMAT_SAVE_OUT": str(out), "VITE_GEUL_TEST_HOOKS": "1", "VITE_GEUL_TEST_RHWP_HISTORY": "1", "VITE_GEUL_TEST_RHWP_FORMAT": "1"})
        cases = json.loads((out / "cases.json").read_text())
        if sorted(c["name"] for c in cases) != sorted(HWPX_CASES + ("hwp-engine-bold",)):
            raise SystemExit("unexpected case set")
        entries, before = [], {}
        for c in cases:
            d = tmp / "work" / c["name"]
            d.mkdir(parents=True)
            target = d / f"doc.{c['fmt']}"
            shutil.copyfile(c["original"], target)
            before[c["name"]] = sha(target)
            entries.append({"name": c["name"], "fmt": c["fmt"], "mode": "save", "target": str(target),
                            "unedited": c["unedited"]["file"], "uneditedLoss": f"{c['unedited']['file']}.loss.json",
                            "output": c["output"]["file"], "outputLoss": f"{c['output']['file']}.loss.json", "reopen": c["output"]["reopen"]})
        (tmp / "manifest.json").write_text(json.dumps({"cases": entries}))
        run(CARGO, {"GEUL_T010_MANIFEST": str(tmp / "manifest.json"), "GEUL_T010_RESULTS": str(tmp / "results.json")})
        results = {r["name"]: r for r in json.loads((tmp / "results.json").read_text())["results"]}
        by_name = {c["name"]: c for c in cases}
        for e in entries:
            name, r, c = e["name"], results[e["name"]], by_name[e["name"]]
            target = Path(e["target"])
            findings = [[f["code"], f.get("part")] for f in r["checkSaved"]["findings"]]
            preflight = [[f["code"], f.get("part")] for f in r["preflight"]["findings"]]
            published = r["save"]["ok"]
            after = sha(target)
            formats_ok = all(p["model"] == p["value"] and p["reopened"] == p["value"] for p in c["output"]["reopenFormat"])
            if e["fmt"] == "hwpx":
                ok = (r["preflight"]["outcome"] == "safe" and not preflight and r["checkSaved"]["outcome"] == "safe" and not findings
                      and published and r["save"].get("durable") and after == sha(Path(e["output"])) and all(e["reopen"].values())
                      and not r["sessionAfter"]["dirty"] and formats_ok)
            else:
                codes = {f[0] for f in findings}
                ok = (r["checkSaved"]["outcome"] == "unsafe" and not published and after == before[name]
                      and r["sessionAfter"]["dirty"] and "previewStale" in codes and formats_ok)
            ok = ok and r["dirAfter"] == [target.name] and r["sessionAfter"]["revision"] == r["committedRevision"] == 1 and r["dirtyBeforeSave"]
            rows.append({"case": name, "fmt": e["fmt"], "preflight": r["preflight"]["outcome"], "preflightFindings": preflight[:6],
                         "checkSaved": r["checkSaved"]["outcome"], "findings": findings, "published": published,
                         "originalSha256": before[name], "afterSha256": after, "durable": r["save"].get("durable"),
                         "reopen": e["reopen"], "reopenFormat": c["output"]["reopenFormat"], "sessionAfter": r["sessionAfter"],
                         "dirAfter": r["dirAfter"], "ok": ok})
            print(f"[{'ok' if ok else 'MISMATCH'}] {name}: preflight={r['preflight']['outcome']} checkSaved={r['checkSaved']['outcome']} "
                  f"{findings[:3]} 게시={published} 원본 그대로={after == before[name]} 서식 다시 열기={formats_ok}")
            if not ok:
                failures.append(name)
        if args.evidence:
            args.evidence.write_text(json.dumps({"rows": rows, "failures": failures, "engine": "pinned test package"},
                                                ensure_ascii=False, indent=1).replace(str(tmp), "<tmp>") + "\n")
    print(f"불일치 {len(failures)}건 {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
