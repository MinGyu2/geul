#!/usr/bin/env python3
"""T010 Phase 2 Gate D3: 실행 취소·다시 실행한 실제 세션 모델(rhwp WASM)의 내보내기를 실제 저장 서비스(service::save)에 넣는다.

    TMPDIR=<쓰기 가능한 임시 디렉터리> python3 tests/integration/rhwp/undo_save.py [--evidence <정리된 결과 JSON>]

1) undo-save.wasm.test.ts(GEUL_UNDO_SAVE_OUT)가 편집 → 모두 실행 취소 → 두 단계 다시 실행한 모델을 앱과 같은 방식으로 내보낸다.
2) 사례마다 원본 사본 하나에 세션 기록·사전 검사·확정·저장 표·service::save(src-tauri/tests/t010_phase0_save_service.rs).
3) 저장 전후 원본 사본 SHA-256·디렉터리 목록. 다시 실행한 HWPX 출력의 본문 참조 하나를 없는 모양으로 고친 사본도 넣어 T009 참조 검사가
   실행 취소 뒤에도 그대로인지 본다.

기대(T009 정책 그대로): 모두 되돌린 출력은 원본과 같은 내용 → safe·게시. 다시 실행한 출력: HWPX 글자 편집 → safe·게시, HWP → 미리보기
낡음(previewStale)으로 거부. 고친 참조 → referenceInvalid로 거부. 다르면 종료 코드 1.
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
CARGO = ["cargo", "test", "--quiet", "--locked", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"),
         "--test", "t010_phase0_save_service", "--", "--ignored", "--exact", "진짜_엔진_출력을_저장_서비스에_넣는다"]


def run(cmd: list[str], env: dict) -> None:
    done = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, env={**os.environ, **env})
    if done.returncode != 0:
        raise SystemExit(f"실패 {cmd[:4]}: {done.stdout[-1500:]}\n{done.stderr[-1500:]}")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


PREVIEW = [["previewStale", "PrvText"], ["previewStale", "PrvImage"]]
EXPECT = {  # 사례 → (check_saved, 게시됨, 근거)
    "hwp-undone": ("safe", True, []), "hwpx-undone": ("safe", True, []),
    "hwp-redone": ("unsafe", False, PREVIEW), "hwpx-redone": ("safe", True, []),
    "hwpx-redone-dangling": ("unsafe", False, [["referenceInvalid", "Contents/section0.xml"]]),
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="geul-t010-d3-") as scratch:
        tmp = Path(scratch)
        out = tmp / "out"
        run(["npx", "vitest", "run", "--config", "tests/integration/rhwp/vitest.config.ts", "undo-save"], {"GEUL_UNDO_SAVE_OUT": str(out)})
        cases = json.loads((out / "cases.json").read_text())
        manifest, rows = [], []
        for c in cases:
            fmt = c["fmt"]
            for kind in ("undone", "redone"):
                manifest.append((f"{fmt}-{kind}", fmt, c["original"], c["unedited"], c[kind]))
            if fmt == "hwpx":
                src = Path(c["redone"]["file"])
                bad = out / "hwpx-redone-dangling.hwpx"
                with zipfile.ZipFile(src) as zin, zipfile.ZipFile(bad, "w") as zout:
                    for i in zin.infolist():
                        data = zin.read(i.filename)
                        if i.filename == "Contents/section0.xml":
                            data = re.sub(rb'<hp:run charPrIDRef="\d+"><hp:t>', b'<hp:run charPrIDRef="9999"><hp:t>', data, count=1)
                        zout.writestr(i, data)
                shutil.copyfile(f"{src}.loss.json", f"{bad}.loss.json")
                manifest.append(("hwpx-redone-dangling", fmt, c["original"], c["unedited"], {**c["redone"], "file": str(bad)}))
        entries, before = [], {}
        for name, fmt, original, unedited, output in manifest:
            d = tmp / "work" / name
            d.mkdir(parents=True)
            shutil.copyfile(original, d / f"doc.{fmt}")
            before[name] = sha(d / f"doc.{fmt}")
            entries.append({"name": name, "fmt": fmt, "mode": "save", "target": str(d / f"doc.{fmt}"),
                            "unedited": unedited["file"], "uneditedLoss": f"{unedited['file']}.loss.json",
                            "output": output["file"], "outputLoss": f"{output['file']}.loss.json", "reopen": output["reopen"]})
        (tmp / "manifest.json").write_text(json.dumps({"cases": entries}))
        run(CARGO, {"GEUL_T010_MANIFEST": str(tmp / "manifest.json"), "GEUL_T010_RESULTS": str(tmp / "results.json")})
        results = {r["name"]: r for r in json.loads((tmp / "results.json").read_text())["results"]}
        for e in entries:
            r, name = results[e["name"]], e["name"]
            target = Path(e["target"])
            findings = [[f["code"], f.get("part")] for f in r["checkSaved"]["findings"]]
            published = r["save"]["ok"]
            after = sha(target)
            want = EXPECT[name]
            ok = r["preflight"]["outcome"] == "safe" and r["checkSaved"]["outcome"] == want[0] and published == want[1] \
                and sorted(findings) == sorted(want[2]) and r["dirAfter"] == [target.name] \
                and (after == sha(Path(e["output"])) if published else after == before[name] and r["sessionAfter"]["dirty"])
            rows.append({"case": name, "reopen": e["reopen"], "checkSaved": r["checkSaved"]["outcome"], "findings": findings,
                         "published": published, "originalSha256": before[name], "afterSha256": after,
                         "sessionAfter": r["sessionAfter"], "dirAfter": r["dirAfter"], "ok": ok})
            print(f"[{'ok' if ok else 'MISMATCH'}] {name}: checkSaved={r['checkSaved']['outcome']} {findings} 게시={published} "
                  f"원본 그대로={after == before[name]}")
            if not ok:
                failures.append(name)
        sessions = [{k: c[k] for k in ("fmt",)} | {s: {"revision": c[s]["revision"], "unpreserved": c[s]["modified"]}
                                                   for s in ("edited", "undone", "redone")} for c in cases]
        if args.evidence:
            args.evidence.write_text(json.dumps({"rows": rows, "sessions": sessions, "failures": failures},
                                                ensure_ascii=False, indent=1).replace(str(tmp), "<tmp>") + "\n")
    print(f"불일치 {len(failures)}건 {failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
