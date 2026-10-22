#!/usr/bin/env python3
"""T010 Phase 2 rhwp 실행 취소 활성화 관문(실제 Tauri 앱 · 시험 활성화 빌드 전용).

시험 활성화 빌드(제품 빌드가 아님 — src/commands/registry.ts `RHWP_HISTORY`):
    VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1 npm run tauri build -- --debug --no-bundle

    # D1 그리기·명령·성능(WebDriver 키·포인터, weston 또는 X11):
    python3 tests/integration/rhwp/undo_native.py --app ... --driver ... --render [--report r.json] [--screenshots dir]
    # D2 실제 한국어 입력기(X11 + ibus-hangul + xdotool 실제 키):
    python3 tests/integration/rhwp/undo_native.py --app ... --driver ... --ime --xdotool ... --ibus ... [--report r.json]

단축키(Ctrl+Z·Ctrl+Y·Ctrl+Shift+Z)는 앱의 명령 레지스트리 경로(executeCommand → 세션 execute의 재확인)로 간다. 그리기는 쪽 Canvas의
픽셀(getImageData 해시)로 본다: 편집 전 = 모두 되돌린 뒤, 편집 뒤 = 모두 다시 실행한 뒤. 지연은 페이지 안에서 keydown·input부터
모델 변경(data-local-revision) 뒤 두 번째 animation frame까지 잰다(WebDriver 왕복 제외). 메모리는 WebKitWebProcess RSS(/proc).
문서 내용은 보고서에 넣지 않는다(글자 수·같음 여부·해시만). 실패하면 종료 코드 1, 끊기면 2(tauri_smoke 규약).
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
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rhwp_poc as poc  # noqa: E402  (열기·클릭·키·상태 도우미 재사용)
from rhwp_poc import smoke, status  # noqa: E402

ROOT = poc.ROOT
RESULTS: list[str] = []
GATES: list[dict] = []
REPORT: dict = {}
S = ROOT / "external/rhwp/samples"
# 여러 구역 공개 예제(그리기 예산 안): (파일, 뒤 구역 첫 물리 쪽) — 쪽은 고정 rhwp 1a76570 getPageInfo 실측.
MULTI = [(S / "aift.hwp", None), (S / "issue6031/3249937_asset_management_rules.hwpx", None)]
LARGE = [S / "rnote/연구노트(화학).hwp", S / "issue2006/1790387_prep_final_report.hwpx"]

MEASURE = r"""
if (!window.__lat) {
  window.__lat = []; window.__gaps = [];
  const st = () => document.querySelector('[data-testid=rhwp-status]');
  const watch = (kind, t0) => {
    const before = st()?.dataset.localRevision;
    const tick = () => {
      if (st()?.dataset.localRevision !== before) {
        requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push([kind, performance.now() - t0])));
      } else if (performance.now() - t0 < 8000) requestAnimationFrame(tick);
      else window.__lat.push([kind, -1]);
    };
    requestAnimationFrame(tick);
  };
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    if (e.code === 'KeyZ') watch(e.shiftKey ? 'redo' : 'undo', e.timeStamp);
    if (e.code === 'KeyY') watch('redo', e.timeStamp);
  }, true);
  document.addEventListener('input', (e) => { if (e.target?.classList?.contains('rhwp-input') && !e.isComposing) watch(window.__nextKind || 'type', e.timeStamp); }, true);
  let last = performance.now();
  const frame = (t) => { window.__gaps.push(t - last); last = t; if (window.__gaps.length > 20000) window.__gaps.shift(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
}
"""

DIGEST = r"""
const page = document.querySelectorAll('.rhwp-page__canvas')[arguments[0]];
if (!page || !page.width) return null;
const data = page.getContext('2d').getImageData(0, 0, page.width, page.height).data;
let h = 2166136261 >>> 0, ink = 0;
for (let i = 0; i < data.length; i += 4) {
  const v = (data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2] ^ (data[i + 3] << 24);
  h = Math.imul(h ^ v, 16777619) >>> 0;
  if (data[i] < 200) ink++;
}
return [h, ink, page.width, page.height];
"""


SNAP = ("const c=document.querySelectorAll('.rhwp-page__canvas')[arguments[0]]; window.__snaps = window.__snaps || {};"
        " window.__snaps[arguments[1]] = c.getContext('2d').getImageData(0,0,c.width,c.height).data.slice(); return [c.width, c.height]")
PIXDIFF = r"""
const a = window.__snaps[arguments[0]], b = window.__snaps[arguments[1]];
if (!a || !b || a.length !== b.length) return {comparable: false};
const w = arguments[2], h = arguments[3];
let n = 0, strong = 0, maxd = 0, edge = 0, innerMax = 0;
for (let i = 0; i < a.length; i += 4) {
  const dd = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
  if (!dd) continue;
  n++; if (dd > maxd) maxd = dd;
  const p = i / 4, x = p % w, y = (p / w) | 0;
  if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { edge++; continue; }
  if (dd > 32) strong++;
  if (dd > innerMax) innerMax = dd;
}
return {comparable: true, pixels: n, edgePixels: edge, strongPixels: strong, maxDelta: maxd, innerMaxDelta: innerMax};
"""
# 띠 다시 그리기(쪽 일부만 다시 그림)와 쪽 전체 그리기는 글자 가장자리의 반투명 픽셀이 조금 다르다(실측: 실행 취소 뒤 최대 차 26).
# 그래서 같은 상태를 쪽 전체로 다시 그린 기준과 비교해 차가 32를 넘는 픽셀이 없으면 "같은 내용"으로 본다(글자·선이 다르면 차가 255 가까이).
# 쪽 Canvas 가장자리 1픽셀 줄(위·왼쪽 등)은 배율을 바꿔 다시 그린 기준과 띠 다시 그리기가 늘 다르다(실측: 827×1169 쪽에서 정확히
# 827+1169−1 = 1995픽셀, 내용과 무관) — 따로 세고 판정에서 뺀다.
TOLERANCE = 32


def check(name: str, ok: bool, detail: str = "") -> None:
    """관문 항목(실패해도 다음 항목을 계속한다)."""
    gate("D1", name, ok, detail)
    if ok:
        RESULTS.append(name)


def full_redraw(d) -> None:
    """배율을 바꿨다 돌려 쪽 전체를 다시 그리게 한다(띠 다시 그리기를 거치지 않은 기준)."""
    poc.set_zoom(d, 150)
    time.sleep(1)
    poc.set_zoom(d, 100)
    time.sleep(1)


def snap(d, page: int, name: str) -> list:
    stable_digest(d, page)
    return d.js(SNAP, page, name)


def same_content(d, page: int, reference: str, name: str) -> dict:
    """지금 쪽 그림(name으로 찍음)을 기준(reference, 쪽 전체 그리기)과 비교."""
    size = snap(d, page, name)
    diff = d.js(PIXDIFF, reference, name, size[0], size[1])
    diff["same"] = bool(diff.get("comparable")) and diff["strongPixels"] == 0
    return diff


def gate(gate_id: str, name: str, ok: bool | None, detail: str) -> None:
    result = "NOT RUN" if ok is None else "PASS" if ok else "FAIL"
    GATES.append({"gate": gate_id, "item": name, "result": result, "detail": detail})
    print(f"[{gate_id} {result}] {name} — {detail}", flush=True)


def stable_digest(d, page: int, timeout: float = 20) -> list:
    """그리기가 끝나 같은 해시가 0.4초 동안 이어질 때까지."""
    end = time.monotonic() + timeout
    last, since = None, time.monotonic()
    while time.monotonic() < end:
        value = d.js(DIGEST, page)
        if value != last:
            last, since = value, time.monotonic()
        elif value and time.monotonic() - since > 0.4:
            return value
        time.sleep(0.1)
    raise smoke.Failure(f"쪽 {page} 그리기가 안정되지 않음")


def wait_revision(d, before: int, timeout: float = 20) -> dict:
    smoke.wait_until(d, "const e=document.querySelector('[data-testid=rhwp-status]'); return e && Number(e.dataset.localRevision) > arguments[0]",
                     before, timeout=timeout)
    return status(d)


def caret_page(d) -> int:
    return int(d.js("const c=document.querySelector('[data-testid=rhwp-caret]'); return c ? Number(c.closest('.rhwp-page')?.dataset.page ?? -1) : -1"))


def command_state(d, command: str) -> dict:
    return poc.command_button(d, command)


def chord(d, key: str, shift: bool = False) -> None:
    actions = [{"type": "keyDown", "value": poc.CTRL}]
    if shift:
        actions.append({"type": "keyDown", "value": poc.KEY["Shift"]})
    actions += [{"type": "keyDown", "value": key}, {"type": "keyUp", "value": key}]
    if shift:
        actions.append({"type": "keyUp", "value": poc.KEY["Shift"]})
    actions.append({"type": "keyUp", "value": poc.CTRL})
    poc.perform(d, [{"type": "key", "id": "kbd", "actions": actions}])


def history_key(d, key: str, shift: bool = False) -> tuple[dict, bool]:
    """Ctrl+Z/Y(Shift)를 보내고 모델이 바뀌면 그 상태(바뀌지 않으면 False)."""
    before = int(status(d)["localRevision"])
    d.js("document.querySelector('.rhwp-input').focus()")
    chord(d, key, shift)
    try:
        return wait_revision(d, before, timeout=5), True
    except smoke.Failure:
        return status(d), False


def webprocess_rss() -> int | None:
    total = None
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            if Path(f"/proc/{pid}/comm").read_text().strip().startswith("WebKitWebProces"):
                for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        total = (total or 0) + int(line.split()[1]) * 1024
        except OSError:
            continue
    return total


def pct(values: list[float]) -> dict:
    v = sorted(x for x in values if x >= 0)
    if not v:
        return {"n": 0}
    q = lambda p: v[min(len(v) - 1, max(0, int(-(-p * len(v) // 1)) - 1))]  # noqa: E731
    return {"n": len(v), "p50": round(q(0.5), 1), "p95": round(q(0.95), 1), "max": round(v[-1], 1), "timeouts": len(values) - len(v)}


def latencies(d) -> dict:
    lat = d.js("return window.__lat || []")
    out: dict[str, list[float]] = {}
    for kind, ms in lat:
        out.setdefault(kind, []).append(ms)
    return out


# ---- D1: 그리기·명령 ----

def require_activation(d) -> None:
    state = command_state(d, "edit.undo")
    if "이 문서 형식에서 지원하지 않음" in state["title"]:
        raise smoke.Failure("시험 활성화 빌드가 아닙니다: VITE_GEUL_TEST_HOOKS=1 VITE_GEUL_TEST_RHWP_HISTORY=1로 앱을 빌드하세요")


def scenario_render_basic(d, path: Path, fmt: str, shots: Path | None) -> None:
    poc.open_document(d, path)
    poc.require_test_hooks(d)
    require_activation(d)
    d.js(MEASURE)
    poc.click_paragraph_start(d)
    page = caret_page(d)
    full_redraw(d)
    snap(d, page, "before")  # 편집 전, 쪽 전체 그리기
    before = stable_digest(d, page)
    base = status(d)
    state = command_state(d, "edit.undo")
    check(f"{fmt}: 편집 전 실행 취소는 쓸 수 없음(되돌릴 것 없음)", state["disabled"], state["title"])
    poc.type_ascii(d, "AB")
    poc.press(d, "Enter")
    poc.type_ascii(d, "C")
    edited_text = status(d)
    after = stable_digest(d, page)
    check(f"{fmt}: 편집이 Canvas 픽셀을 바꿈", after != before)
    full_redraw(d)
    snap(d, page, "edited")  # 편집 뒤, 쪽 전체 그리기
    states = []
    for _ in range(3):
        st, changed = history_key(d, "z")
        states.append(changed)
    restored = same_content(d, page, "before", "undone")
    check(f"{fmt}: Ctrl+Z 세 번(글자 묶음·나누기·글자) → 쪽 Canvas가 편집 전(쪽 전체 그리기)과 같은 내용",
          all(states) and restored["same"] and status(d)["paragraphText"] == base["paragraphText"],
          f"변경={states}, 픽셀 차 {restored}")
    _, more = history_key(d, "z")
    check(f"{fmt}: 더 되돌릴 것이 없으면 Ctrl+Z가 모델을 바꾸지 않고 단추는 비활성", not more and command_state(d, "edit.undo")["disabled"])
    st1, a = history_key(d, "y")
    st2, b = history_key(d, "z", shift=True)
    st3, c = history_key(d, "y")
    redone = same_content(d, page, "edited", "redone")
    check(f"{fmt}: Ctrl+Y·Ctrl+Shift+Z·Ctrl+Y → 쪽 Canvas가 편집 뒤(쪽 전체 그리기)와 같은 내용",
          a and b and c and redone["same"] and status(d)["paragraphText"] == edited_text["paragraphText"],
          f"변경={[a, b, c]}, 픽셀 차 {redone}")
    if shots:
        d.screenshot(shots / f"{fmt}-redone.png")
    # 실행 취소 뒤 새 타자: 다시 실행 단추가 비활성(되돌린 단계가 버려짐)
    history_key(d, "z")
    poc.type_ascii(d, "D")
    check(f"{fmt}: 실행 취소 뒤 새 타자는 다시 실행을 버림", command_state(d, "edit.redo")["disabled"])
    # 선택이 있을 때 실행 취소: 모델 되돌림(선택은 그대로 두지 않음)
    poc.press(d, "Left", "Left", shift=True)
    _, sel = history_key(d, "z")
    check(f"{fmt}: 선택이 있어도 Ctrl+Z가 직전 단계를 되돌림", sel)
    # 쪽 배치가 바뀌는 편집(Enter 반복으로 쪽 수 증가) → 되돌리면 쪽 수·픽셀이 그대로
    while history_key(d, "z")[1]:
        pass
    pages0 = int(status(d)["pages"])
    full_redraw(d)
    snap(d, 0, "first")
    for _ in range(45):
        poc.press(d, "Enter")
    smoke.wait_until(d, "return Number(document.querySelector('[data-testid=rhwp-status]').dataset.pages) > arguments[0]", pages0, timeout=20)
    grown = int(status(d)["pages"])
    undone = 0
    while history_key(d, "z")[1]:
        undone += 1
    back = same_content(d, 0, "first", "firstBack")
    check(f"{fmt}: 쪽이 늘어난 편집 {grown - pages0}쪽을 되돌리면 쪽 수와 첫 쪽 Canvas가 편집 전과 같은 내용",
          int(status(d)["pages"]) == pages0 and back["same"], f"쪽 {pages0}→{grown}→{status(d)['pages']}, Ctrl+Z {undone}번, 픽셀 차 {back}")
    # 표 셀 안: 넣기·셀 문단 나누기 → 되돌림·다시 실행
    for _ in range(3):
        poc.click_cell(d, 1)
        if "@" in status(d)["caret"]:
            break
        time.sleep(0.5)
    REPORT.setdefault(fmt, {})["cellClick"] = {"caret": status(d)["caret"], "target": d.js(
        "const p=document.querySelector('.rhwp-page').getBoundingClientRect(); const e=document.elementFromPoint(p.left+410, p.top+182);"
        " return e ? e.tagName + '.' + e.className : null")}
    cell_before = status(d)["paragraphText"]
    poc.type_ascii(d, "X")
    poc.press(d, "Enter")
    history_key(d, "z")
    history_key(d, "z")
    cell_undone = status(d)
    history_key(d, "y")
    check(f"{fmt}: 표 셀 안 넣기·나누기를 되돌리면 셀 글자·셀 커서가 그대로, 다시 실행이 다시 넣음",
          cell_undone["paragraphText"] == cell_before and "@" in cell_undone["caret"], f"caret={cell_undone['caret']}")
    REPORT.setdefault(fmt, {})["latency"] = {k: pct(v) for k, v in latencies(d).items()}


def scenario_render_multi(d, path: Path, scratch: Path) -> None:
    """여러 구역 문서(공개 예제 사본): 열기, 뒤 구역 첫 쪽 클릭 → 커서 쪽, 넣기 → 그 쪽 픽셀 바뀜 → Ctrl+Z → 같음."""
    copy = scratch / path.name
    shutil.copyfile(path, copy)
    fmt = path.suffix.lstrip(".")
    st = poc.open_document(d, copy)
    # 여러 쪽 문서는 배율 100%에서 표시 비트맵 예산(모든 쪽 합)을 넘어 쪽을 그리지 않는다(표시 한도, 설계상): 50%로 본다.
    poc.set_zoom(d, 50)
    smoke.wait_until(d, "return document.querySelectorAll('.rhwp-page__canvas').length === Number(arguments[0])", int(st["pages"]), timeout=30)
    d.js(MEASURE)
    probe = subprocess.run(["node", "--input-type=module", "-e", """
import { readFileSync } from "node:fs";
const rhwp = await import(process.argv[1] + "/public/rhwp/rhwp.js");
rhwp.initSync({ module: readFileSync(process.argv[1] + "/public/rhwp/rhwp_bg.wasm") });
const d = new rhwp.HwpDocument(new Uint8Array(readFileSync(process.argv[2])));
const firsts = []; let last = -1;
for (let p = 0; p < d.pageCount(); p++) { const s = JSON.parse(d.getPageInfo(p)).sectionIndex; if (s !== last) firsts.push(p); last = s; }
console.log(JSON.stringify(firsts));""", str(ROOT), str(copy)], capture_output=True, text=True, check=True)
    firsts = json.loads(probe.stdout)
    check(f"{path.name}: 여러 구역 문서가 실제 앱에서 열리고 쪽 수가 엔진과 같음",
          st["status"] == "ready" and len(firsts) > 1, f"쪽 {st['pages']}, 구역 첫 쪽 {firsts}")
    done = False
    for target in firsts[1:]:
        for frac in (0.3, 0.5, 0.2, 0.7):
            rect = d.js("const p=document.querySelectorAll('.rhwp-page')[arguments[0]]; p.scrollIntoView({block:'center'});"
                        " const r=p.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]", target)
            time.sleep(0.3)
            poc.click(d, rect[0] + rect[2] / 2, rect[1] + rect[3] * frac)
            time.sleep(0.3)
            if caret_page(d) == target:
                done = True
                break
        if done:
            break
    check(f"{path.name}: 뒤 구역 첫 쪽을 누르면 커서가 그 물리 쪽에 보임", done, f"목표 {target}, 커서 쪽 {caret_page(d)}")
    if not done:
        return
    snap(d, target, "mBefore")
    before = stable_digest(d, target)
    poc.type_ascii(d, "ZZ")
    changed = stable_digest(d, target)
    snap(d, target, "mEdited")
    _, ok = history_key(d, "z")
    back = same_content(d, target, "mBefore", "mBack")
    _, ok2 = history_key(d, "y")
    again = same_content(d, target, "mEdited", "mAgain")
    check(f"{path.name}: 뒤 구역 쪽의 넣기 → Ctrl+Z → 그 쪽 Canvas가 넣기 전과 같은 내용 → Ctrl+Y → 넣은 뒤와 같은 내용",
          changed != before and ok and back["same"] and ok2 and again["same"] and caret_page(d) == target,
          f"되돌림 {back}, 다시 실행 {again}, 커서 쪽 {caret_page(d)}")
    if not poc.close_tab(d, copy.name):
        d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", copy.name)
        poc.confirm_discard(d, "close")
    poc.set_zoom(d, 100)


def scenario_reload_close(d, path: Path) -> None:
    poc.open_document(d, path)
    poc.click_paragraph_start(d)
    poc.type_ascii(d, "R")
    history_key(d, "z")
    history_key(d, "y")
    if not poc.close_tab(d, path.name):
        d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", path.name)
        poc.confirm_discard(d, "close")
    poc.open_document(d, path)
    _, changed = history_key(d, "z")
    check(f"{path.name}: 실행 취소·다시 실행 뒤 닫고 다시 열면 기록이 비어 Ctrl+Z가 아무것도 바꾸지 않음", not changed)


def scenario_perf(d, path: Path, scratch: Path) -> None:
    """큰 공개 예제(그리기 예산 안): 그룹 시작 타자·이어 친 타자·실행 취소·다시 실행의 페이지 지연, 프레임 간격, RSS."""
    copy = scratch / path.name
    shutil.copyfile(path, copy)
    rss0 = webprocess_rss()
    st = poc.open_document(d, copy, expected="ready")
    poc.set_zoom(d, 50)  # 표시 비트맵 예산 안(여러 쪽)
    smoke.wait_until(d, "return document.querySelectorAll('.rhwp-page__canvas').length === Number(arguments[0])", int(st["pages"]), timeout=30)
    d.js("window.__lat = null; window.__gaps = null;")
    d.js(MEASURE)
    poc.click_paragraph_start(d)
    rss_open = webprocess_rss()
    for k in range(12):
        poc.press(d, "Right")  # 그룹을 끊는다 → 다음 글자가 그룹 시작(스냅숏)
        d.js("window.__nextKind = 'groupStart'")
        poc.type_ascii(d, "a")
        d.js("window.__nextKind = 'extend'")
        poc.type_ascii(d, "b")
    d.js("window.__gaps.length = 0")
    for _ in range(10):
        history_key(d, "z")
        history_key(d, "y")
    gaps = d.js("return window.__gaps.slice()")
    rss_ops = webprocess_rss()
    lat = latencies(d)
    if not poc.close_tab(d, copy.name):
        d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", copy.name)
        poc.confirm_discard(d, "close")
    time.sleep(2)
    rss_closed = webprocess_rss()
    poc.set_zoom(d, 100)
    row = {"sample": path.name, "fileBytes": path.stat().st_size, "pages": int(st["pages"]),
           **{k: pct(v) for k, v in lat.items()}, "frameGapDuringUndoRedoMs": pct(gaps),
           "rssBytes": {"beforeOpen": rss0, "afterOpen": rss_open, "afterUndoRedo": rss_ops, "afterClose": rss_closed}}
    REPORT.setdefault("perf", []).append(row)
    print("[측정]", json.dumps(row, ensure_ascii=False), flush=True)


# ---- D2: 실제 한국어 입력기 ----

def scenario_ime(d, fixtures: Path, xdotool: str, ibus: str) -> None:
    reason = poc.ime_environment(xdotool, ibus)
    if reason:
        gate("D2", "실제 ibus-hangul 환경", None, reason)
        return
    run = lambda *a: subprocess.run(["env", "-u", "LD_LIBRARY_PATH", *a], capture_output=True, text=True)  # noqa: E731
    REPORT["imeEnvironment"] = {"ibusEngine": run(ibus, "engine").stdout.strip(), "ibusVersion": run(ibus, "version").stdout.strip()}
    for name in ("basic-ko.hwp", "basic-ko.hwpx"):
        fmt = name.split(".")[-1]
        poc.open_document(d, fixtures / name)
        poc.require_test_hooks(d)
        require_activation(d)
        window = run(xdotool, "search", "--onlyvisible", "--name", "^geul").stdout.split()[-1]
        run(xdotool, "windowfocus", "--sync", window)
        run(ibus, "engine", "hangul")
        d.js(poc.EVENT_LOG)
        top = d.js("return window.outerHeight - window.innerHeight")
        origin = poc.page_origin(d)
        d.js("window.__down=null; window.addEventListener('mousedown', e => { window.__down=[e.clientX, e.clientY]; }, true)")
        first = (int(origin[0] + 600), int(origin[1] + 139 + top))
        run(xdotool, "mousemove", "--window", window, str(first[0]), str(first[1]), "click", "1")
        time.sleep(0.4)
        down = d.js("return window.__down")
        shift = (first[0] - down[0], first[1] - down[1]) if down else (0, top)
        key = lambda *k: run(xdotool, "key", "--delay", "60", *k)  # noqa: E731
        typ = lambda s, delay="90": run(xdotool, "type", "--delay", delay, s)  # noqa: E731
        base = poc.settle(d, f"{fmt}: 시작")
        base_text = base["paragraphText"]

        # 1) 조합 중 Ctrl+Z: 조합이 깨지지 않음(남은 자모·중복 없음) — 입력기가 먼저 확정하면 그 조합이 한 단계로 되돌아간다
        typ("gks")
        mid = poc.settle(d, f"{fmt}: 한 조합 중")
        key("ctrl+z")
        st = poc.settle(d, f"{fmt}: 조합 중 Ctrl+Z")
        ok = st.get("composing") == "false" and st["paragraphText"] in (base_text, base_text + "한")
        gate("D2", f"{fmt}: 조합 중 Ctrl+Z가 조합을 깨지 않음", ok,
             f"조합 중={mid.get('composing')}, 결과 {'되돌림' if st['paragraphText'] == base_text else '확정 유지' if ok else '어긋남'}")
        if st["paragraphText"] != base_text:
            key("ctrl+z")
            st = poc.settle(d, f"{fmt}: 정리")

        # 2) 조합 확정 뒤 Ctrl+Z → 그 조합(두 음절) 전체가 한 단계로, Ctrl+Y → 정확히 되돌아옴, Ctrl+Shift+Z는 더 없음
        typ("gksrmf")
        key("End")
        typed = poc.settle(d, f"{fmt}: 한글")
        key("ctrl+z")
        un = poc.settle(d, f"{fmt}: 한글 Ctrl+Z")
        key("ctrl+y")
        re = poc.settle(d, f"{fmt}: 한글 Ctrl+Y")
        key("ctrl+shift+z")
        more = poc.settle(d, f"{fmt}: 더 다시 실행")
        gate("D2", f"{fmt}: 확정한 조합(한글) Ctrl+Z → 한 단계로 되돌림, Ctrl+Y → 정확히 복원", typed["paragraphText"] == base_text + "한글"
             and un["paragraphText"] == base_text and re["paragraphText"] == base_text + "한글"
             and more["paragraphText"] == re["paragraphText"] and int(more["localRevision"]) == int(re["localRevision"]),
             f"넣은 글자 수 {len(typed['paragraphText']) - len(base_text)}, revision {typed['localRevision']}→{un['localRevision']}→{re['localRevision']}")

        # 3) 이어진 음절·공백(입력 테스트)은 한 그룹, 그 앞 그룹(한글)과 따로
        typ("dlqfur xptmxm")
        key("End")
        st3 = poc.settle(d, f"{fmt}: 입력 테스트")
        key("ctrl+z")
        g1 = poc.settle(d, f"{fmt}: 그룹 1 되돌림")
        key("ctrl+z")
        g2 = poc.settle(d, f"{fmt}: 그룹 2 되돌림")
        gate("D2", f"{fmt}: 이어진 한글 음절은 한 단계, 앞 그룹과 경계 유지", st3["paragraphText"] == base_text + "한글입력 테스트"
             and g1["paragraphText"] == base_text + "한글" and g2["paragraphText"] == base_text,
             f"단계별 글자 수 {[len(x['paragraphText']) - len(base_text) for x in (st3, g1, g2)]}")

        # 4) 선택을 조합으로 바꾸다 취소 → Ctrl+Z가 지운 선택 글자를 되살림
        typ("gksrmf")
        key("End")
        poc.settle(d, f"{fmt}: 선택할 글자")
        key("shift+Left", "shift+Left")
        sel = poc.settle(d, f"{fmt}: 선택")
        typ("r")
        key("BackSpace")
        cancel = poc.settle(d, f"{fmt}: 조합 취소")
        key("ctrl+z")
        back = poc.settle(d, f"{fmt}: 선택 되살림")
        restored_now = back["paragraphText"] == base_text + "한글"
        gate("D2", f"{fmt}: 선택을 조합으로 바꾸다 취소 → 바로 Ctrl+Z가 선택 글자를 되살림", bool(sel.get("selection"))
             and cancel["paragraphText"] == base_text and restored_now,
             f"선택={bool(sel.get('selection'))}, 취소 뒤 글자 수 {len(cancel['paragraphText']) - len(base_text)}, Ctrl+Z 뒤 {len(back['paragraphText']) - len(base_text)}"
             " (WebKitGTK의 빈 조합 끝 뒤 최종 글자 기다림 동안 명령은 composing으로 거절된다 — T010 IME 경계 계약)")
        if not restored_now:
            # 관찰(관문 판정에 넣지 않음): 커서 자리를 누르면(새 입력 시작) 기다림이 풀리고 Ctrl+Z가 되살리는가.
            here = poc.caret_client(d)
            run(xdotool, "mousemove", "--window", window, str(int(here[0] + shift[0])), str(int(here[1] + here[2] / 2 + shift[1])), "click", "1")
            poc.settle(d, f"{fmt}: 기다림 풀기 클릭")
            key("ctrl+z")
            later = poc.settle(d, f"{fmt}: 클릭 뒤 Ctrl+Z")
            REPORT.setdefault(fmt, {})["cancelRecoveryAfterClick"] = later["paragraphText"] == base_text + "한글"
            print(f"[관찰] {fmt}: 클릭 뒤 Ctrl+Z가 선택 글자를 되살림 = {REPORT[fmt]['cancelRecoveryAfterClick']}", flush=True)
        key("ctrl+z")
        poc.settle(d, f"{fmt}: 한글 정리")

        # 5) 조합 중 클릭(앱이 먼저 확정·늦은 최종 글자) 뒤 Ctrl+Z / Ctrl+Y
        key("End")
        end = poc.caret_client(d)
        key("Home")
        start = poc.caret_client(d)
        key("End")
        st5 = poc.settle(d, f"{fmt}: 끝")
        target = (start[0] + (end[0] - start[0]) * 0.3, start[1] + start[2] / 2)
        typ("gk")
        poc.settle(d, f"{fmt}: 하 조합")
        run(xdotool, "mousemove", "--window", window, str(int(target[0] + shift[0])), str(int(target[1] + shift[1])), "click", "1")
        clicked = poc.settle(d, f"{fmt}: 조합 중 클릭")
        key("ctrl+z")
        un5 = poc.settle(d, f"{fmt}: 클릭 뒤 Ctrl+Z")
        key("ctrl+y")
        re5 = poc.settle(d, f"{fmt}: 클릭 뒤 Ctrl+Y")
        gate("D2", f"{fmt}: 조합 중 클릭(앱 확정·늦은 최종 글자) 뒤 Ctrl+Z → 그 조합만 되돌리고 Ctrl+Y → 복원",
             clicked["paragraphText"] == st5["paragraphText"] + "하" and un5["paragraphText"] == st5["paragraphText"]
             and re5["paragraphText"] == clicked["paragraphText"] and clicked.get("composing") == "false",
             f"클릭 뒤 글자 수 +{len(clicked['paragraphText']) - len(st5['paragraphText'])}")
        key("ctrl+z")
        poc.settle(d, f"{fmt}: 하 정리")

        # 6) 조합 중 초점 잃음(입력 칸 blur)·되돌아옴 뒤 같은 자리 타자 → 따로 된 단계
        key("End")
        st6 = poc.settle(d, f"{fmt}: 초점 시험 시작")
        typ("gk")
        poc.settle(d, f"{fmt}: 하 조합(초점 전)")
        d.js("document.querySelector('.rhwp-input').blur()")
        blurred = poc.settle(d, f"{fmt}: 초점 잃음")
        d.js("document.querySelector('.rhwp-input').focus()")
        run(xdotool, "windowfocus", "--sync", window)
        typ("rk")
        key("End")
        st6b = poc.settle(d, f"{fmt}: 초점 뒤 가")
        key("ctrl+z")
        un6 = poc.settle(d, f"{fmt}: 초점 뒤 Ctrl+Z")
        gate("D2", f"{fmt}: 조합 중 초점 잃음 뒤 돌아와 친 글자는 따로 된 단계(첫 Ctrl+Z가 뒤 글자만)",
             blurred["paragraphText"] == st6["paragraphText"] + "하" and st6b["paragraphText"] == st6["paragraphText"] + "하가"
             and un6["paragraphText"] == st6["paragraphText"] + "하",
             f"초점 잃음 뒤 +{len(blurred['paragraphText']) - len(st6['paragraphText'])}, 돌아온 뒤 +{len(st6b['paragraphText']) - len(st6['paragraphText'])},"
             f" Ctrl+Z 뒤 +{len(un6['paragraphText']) - len(st6['paragraphText'])} (초점 잃음은 입력 칸 blur — 창 초점 이동이 아님)")
        key("ctrl+z")
        poc.settle(d, f"{fmt}: 초점 정리")

        # 7) 빠른 연속 한글(안녕하세요, 키 간격 20ms) → Ctrl+Z 한 번에 모두, Ctrl+Y 정확히
        key("End")
        st7 = poc.settle(d, f"{fmt}: 빠른 입력 전")
        typ("dkssudgktpdy", "20")
        key("End")
        fast = poc.settle(d, f"{fmt}: 안녕하세요")
        key("ctrl+z")
        un7 = poc.settle(d, f"{fmt}: 빠른 입력 Ctrl+Z")
        key("ctrl+y")
        re7 = poc.settle(d, f"{fmt}: 빠른 입력 Ctrl+Y")
        gate("D2", f"{fmt}: 빠른 연속 한글 → 음절 누락 없음, Ctrl+Z 한 번, Ctrl+Y 정확히", fast["paragraphText"] == st7["paragraphText"] + "안녕하세요"
             and un7["paragraphText"] == st7["paragraphText"] and re7["paragraphText"] == fast["paragraphText"],
             f"넣은 글자 수 {len(fast['paragraphText']) - len(st7['paragraphText'])}")

    # 8) 다시 불러오기·닫기 뒤 기록 없음(마지막 문서)
    name = "basic-ko.hwpx"
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", name)
    time.sleep(0.5)
    if d.exists("[data-testid=discard-dialog]"):
        poc.confirm_discard(d, "close")
    poc.open_document(d, fixtures / name)
    run(xdotool, "windowfocus", "--sync", window)
    poc.click_paragraph_start(d)
    before = status(d)
    key("ctrl+z")
    after = poc.settle(d, "닫고 다시 연 뒤 Ctrl+Z")
    gate("D2", "실행 취소·다시 실행 뒤 닫고 다시 열면 Ctrl+Z가 아무것도 바꾸지 않음",
         after["paragraphText"] == before["paragraphText"] and after["localRevision"] == before["localRevision"], "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--driver-log", type=Path)
    parser.add_argument("--ime", action="store_true")
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--perf", action="store_true", help="큰 공개 예제 성능만")
    parser.add_argument("--xdotool", default=shutil.which("xdotool") or "xdotool")
    parser.add_argument("--ibus", default=shutil.which("ibus") or "ibus")
    args = parser.parse_args()
    smoke.APP = os.path.abspath(args.app)
    smoke.DRIVER_LOG = args.driver_log
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    code = 0
    try:
        with tempfile.TemporaryDirectory(prefix="geul-t010-undo-native-") as scratch_dir:
            scratch = Path(scratch_dir)
            fixtures = scratch / "fixtures"
            subprocess.run(["node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures)], check=True, capture_output=True)
            REPORT["fixtureSha256"] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(fixtures.glob("basic-ko.hwp*"))}
            with tempfile.TemporaryDirectory(prefix="geul-t010-undo-data-") as data_home:
                with smoke.tauri_driver(args.driver, args.port, data_home) as start:
                    d = start()
                    try:
                        smoke.wait_until(d, "return document.querySelector('.document-bar') !== null", timeout=30)
                        if args.ime:
                            scenario_ime(d, fixtures, args.xdotool, args.ibus)
                        if args.render:
                            for fmt in ("hwp", "hwpx"):
                                scenario_render_basic(d, fixtures / f"basic-ko.{fmt}", fmt, args.screenshots)
                            for path, _ in MULTI:
                                scenario_render_multi(d, path, scratch)
                            scenario_reload_close(d, fixtures / "basic-ko.hwp")
                        if args.perf:
                            for path in LARGE:
                                scenario_perf(d, path, scratch)
                    finally:
                        smoke.end_session(d)
        failed = [g for g in GATES if g["result"] != "PASS"]
        print(f"\n항목 통과 {len(RESULTS)}개, 관문 항목 {len(GATES)}개 중 PASS {len(GATES) - len(failed)}")
        code = 1 if failed else 0
        return code
    except smoke.DriverLost as error:
        REPORT["driverLost"] = error.diagnostic()
        print(f"통과한 항목 {len(RESULTS)}개(끊기기 전)", file=sys.stderr)
        return smoke.driver_lost_exit(error)
    except smoke.CleanupFailure as error:
        REPORT["cleanupFailure"] = error.diagnostic()
        return smoke.driver_lost_exit(error)
    except (smoke.Failure, TimeoutError, OSError) as error:
        import traceback
        traceback.print_exc()
        print(f"[실패] {error}", file=sys.stderr)
        return 1
    finally:
        if args.report:
            args.report.write_text(json.dumps({"results": RESULTS, "gates": GATES, "measurements": REPORT}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
