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
import native_probe
import rhwp_poc as poc  # noqa: E402  (열기·클릭·키·상태 도우미 재사용)
from rhwp_poc import smoke, status  # noqa: E402

ROOT = poc.ROOT
RESULTS: list[str] = []
GATES: list[dict] = []
REPORT: dict = {}
S = ROOT / "external/rhwp/samples"
# 여러 구역 공개 예제(그리기 예산 안): (파일, 뒤 구역 첫 물리 쪽) — 쪽은 고정 rhwp 1a76570 getPageInfo 실측.
MULTI = [(S / "aift.hwp", None), (S / "issue6031/3249937_asset_management_rules.hwpx", None)]
LARGE = [S / "rnote/연구노트(화학).hwp", S / "issue6031/3249937_asset_management_rules.hwpx"]

MEASURE = r"""
if (!window.__lat) {
  window.__measureStop?.(); let active=true;
  window.__lat = []; window.__gaps = []; window.__stages=[];
  const st = () => document.querySelector('[data-testid=rhwp-status]');
  let keyTime=null;const handlers=new WeakMap();
  const watch = (kind, inputTime, key=inputTime, handler=null) => {
    const seq=window.__geulTrace?.seq??0;
    const before = st()?.dataset.localRevision, offset=window.__rhwpProbe?.calls.length||0;
    const delivered=performance.now(), calls=window.__rhwpProbe?.calls;
    const tick = () => {
      if(!active)return;
      if (st()?.dataset.localRevision !== before) {
        const observed=performance.now(); let raf1=null;
        requestAnimationFrame(() => {raf1=performance.now(); requestAnimationFrame(() => {
          if(!active)return;
          const end=performance.now(); window.__lat.push([kind,end-key]);
          // Timeline (attribution only; keyToFrame above is the unchanged contract value).
          window.__stages.push({kind,keyToFrame:end-key,inputToFrame:end-inputTime,delivery:delivered-inputTime,
            inputHandlerMs:handler?.end==null?null:handler.end-handler.start,
            at:{key:0,input:inputTime-key,handlerEnd:handler?.end==null?null:handler.end-key,observed:observed-key,raf1:raf1-key,end:end-key},
            calls:(calls?.slice(offset)||[]).map(c=>({...c,at:c.at==null?null:c.at-key})),
            trace:(window.__geulTrace?.records||[]).filter(r=>r[0]>seq && typeof r[3]?.ms==='number').map(r=>({name:r[2],ms:r[3].ms})),
            timeline:(window.__geulTrace?.records||[]).filter(r=>r[0]>seq).map(r=>({name:r[2],at:r[1]-key,ms:typeof r[3]?.ms==='number'?r[3].ms:null,page:typeof r[3]?.page==='number'?r[3].page:null})),
            busy:window.__busy?(window.__busy.gaps.filter(g=>g[0]+g[1]>key-500&&g[0]<end).map(g=>[g[0]-key,g[1]])):null});
        });});
      } else if (performance.now() - key < 8000) requestAnimationFrame(tick);
      else window.__lat.push([kind, -1]);
    };
    requestAnimationFrame(tick);
  };
  const onKey=(e) => {
    if (!e.ctrlKey) {if(e.key.length===1 && !e.isComposing)keyTime=e.timeStamp; return;}
    if (e.code === 'KeyZ') watch(e.shiftKey ? 'redo' : 'undo', e.timeStamp);
    if (e.code === 'KeyY') watch('redo', e.timeStamp);
  };
  window.addEventListener('keydown',onKey,true);
  const onInput=(e) => { if (e.target?.classList?.contains('rhwp-input') && !e.isComposing)
    {const h={start:performance.now(),end:null};handlers.set(e,h);watch(window.__nextKind || 'type', e.timeStamp,keyTime??e.timeStamp,h);keyTime=null;} };
  const onInputEnd=e=>{const h=handlers.get(e);if(h)h.end=performance.now()};
  document.addEventListener('input',onInputEnd);
  document.addEventListener('input',onInput,true);
  window.__measureStop=()=>{active=false;window.removeEventListener('keydown',onKey,true);document.removeEventListener('input',onInput,true);document.removeEventListener('input',onInputEnd)};
  let last = performance.now();
  const frame = (t) => { if(!active)return;window.__gaps.push(t - last); last = t; if (window.__gaps.length > 20000) window.__gaps.shift(); requestAnimationFrame(frame); };
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


def gate(gate_id: str, name: str, ok: bool | None, detail: str, outcome: str | None = None) -> None:
    result = outcome or ("NOT EXECUTED" if ok is None else "PASS" if ok else "FAIL")
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
    if getattr(d,"native_key_tool",None):
        subprocess.run(["env","-u","LD_LIBRARY_PATH",d.native_key_tool,"key","--delay","20","ctrl+"+("shift+" if shift else "")+key],check=True,capture_output=True)
        return
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


def webprocess_memory() -> dict:
    rows=[]
    # Only this driver session; never sum unrelated WebViews on the host.
    for pid in smoke.pids_with(smoke.ACTIVE["data_home"]):
        try:
            if not Path(f"/proc/{pid}/comm").read_text().strip().startswith("WebKitWebProces"):
                continue
            rss=next(int(line.split()[1])*1024 for line in Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("VmRSS:"))
            rows.append({"pid":pid,"rssBytes":rss})
        except (OSError, StopIteration):
            continue
    return {"processes":rows,"aggregateRssBytes":sum(r["rssBytes"] for r in rows)}


def webprocess_rss():
    return webprocess_memory()["aggregateRssBytes"]


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
    REPORT.setdefault(fmt, {})["latency"] = {k: pct(v) for k, v in latencies(d).items()}
    scenario_cells(d,path,fmt)


def caret_matches_engine(d):
    return d.js("""const key=document.querySelector('[data-testid=rhwp-status]').dataset.caret,g=window.__rhwpProbe.cursor(key);
      const c=g&&document.querySelectorAll('.rhwp-page__canvas')[g.pageIndex],caret=document.querySelector('.rhwp-caret');if(!c||!caret)return false;
      const r=c.getBoundingClientRect(),v=caret.getBoundingClientRect(),sx=r.width/g.page.width,sy=r.height/g.page.height;
      return Math.abs(v.left+v.width/2-r.left-g.x*sx)<=1 && Math.abs(v.top-r.top-g.y*sy)<=1
          && Math.abs(v.height-g.height*sy)<=1;""")


def scenario_cells(d, path: Path, fmt: str) -> None:
    original_sha=hashlib.sha256(path.read_bytes()).hexdigest()
    poc.open_document(d, path)
    poc.require_test_hooks(d)
    require_activation(d)
    # Force the previously missed branch: a restored snapshot already exists before
    # moving into the cell. The new edit must refresh its caret checkpoint.
    poc.click_paragraph_start(d);poc.type_ascii(d,"P");history_key(d,"z")
    # Capture the actual viewport event and the production conversion, without changing it.
    d.js("""window.__cellPointer=[]; window.addEventListener('mousedown',e=>{
      const c=e.target.closest('.rhwp-page')?.querySelector('canvas'); if(!c)return;
      const r=c.getBoundingClientRect(); window.__cellPointer.push({client:[e.clientX,e.clientY],target:e.target.tagName,
        canvas:[r.left,r.top,r.width,r.height],dpr:devicePixelRatio});},true)""")
    origin=poc.page_origin(d)
    poc.click(d, origin[0]+410, origin[1]+182)
    original = {"caret":status(d)["caret"],"pointer":d.js("return window.__cellPointer.slice(-1)"),
                "hit":d.js("return window.__rhwpProbe.hits.slice(-1)")}
    geometry = d.js("return window.__rhwpProbe.cell(0,2,0,1)")
    if not geometry:
        check(f"{fmt}: 실제 셀 경계 조회", False, "geometry unavailable")
        return
    poc.click_cell(d,1)
    point = d.js("return window.__cellPointer.slice(-1)[0]?.client")
    accepted = status(d)
    REPORT.setdefault("cellPointer", {})[fmt] = {"old":original,"geometry":geometry,"requested":point,
        "actual":d.js("return window.__cellPointer.slice(-1)"),"hit":d.js("return window.__rhwpProbe.hits.slice(-1)"),
        "caret":accepted["caret"]}
    valid = accepted["caret"].startswith("0:2:") and accepted["caret"].endswith("@0/1/0")
    check(f"{fmt}: 실제 포인터가 목표 셀 1 커서를 만듦", valid, accepted["caret"])
    if not valid:
        return # 셀 진입 실패를 Undo 성공으로 세지 않음
    poc.press(d,"Home")
    initial = status(d)
    full_redraw(d); snap(d,0,"cellBefore")
    poc.type_ascii(d,"X"); inserted=status(d)
    poc.press(d,"Enter"); split=status(d)
    full_redraw(d); snap(d,0,"cellSplit")
    _, un1=history_key(d,"z"); after_split=status(d)
    _, un2=history_key(d,"z"); back=status(d)
    pixels=same_content(d,0,"cellBefore","cellBack")
    back_caret_matches=caret_matches_engine(d)
    _, re1=history_key(d,"y"); again1=status(d)
    _, re2=history_key(d,"y"); again2=status(d)
    again_pixels=same_content(d,0,"cellSplit","cellAgain")
    check(f"{fmt}: 셀 넣기/나누기 Undo 두 번과 Redo 두 번의 정확한 글자·커서·Canvas", un1 and un2 and re1 and re2
        and after_split["paragraphText"]==inserted["paragraphText"] and after_split["caret"]==inserted["caret"]
        and back["paragraphText"]==initial["paragraphText"] and back["caret"]==initial["caret"]
        and again1["paragraphText"]==inserted["paragraphText"] and again1["caret"]==inserted["caret"]
        and again2["paragraphText"]==split["paragraphText"] and again2["caret"]==split["caret"]
        and pixels["same"] and again_pixels["same"] and back_caret_matches and caret_matches_engine(d), f"undo pixels={pixels}, redo pixels={again_pixels}")
    if not poc.close_tab(d,path.name):
        d.js("[...document.querySelectorAll('.document-tab__close')].find(b=>b.getAttribute('aria-label').includes(arguments[0])).click()",path.name)
        poc.confirm_discard(d,"close")
    reopened=poc.open_document(d,path)
    poc.click_paragraph_start(d);poc.click_cell(d,1)
    reopened_cell=status(d)
    check(f"{fmt}: 셀 편집 뒤 버리고 다시 열면 정확한 원본 셀·빈 기록·파일 SHA 보존", reopened["status"]=="ready"
          and reopened_cell["paragraphText"]==initial["paragraphText"] and reopened_cell["caret"]==initial["caret"]
          and command_state(d,"edit.undo")["disabled"] and hashlib.sha256(path.read_bytes()).hexdigest()==original_sha)


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


def scenario_discard_failure_reload(d,path,fmt):
    poc.open_document(d,path);poc.click_paragraph_start(d)
    pristine=status(d)["paragraphText"];sha=hashlib.sha256(path.read_bytes()).hexdigest()
    poc.type_ascii(d,"R");history_key(d,"z")
    phase="return window.__geulTrace.records.filter(r=>typeof r[3]?.generation==='number').slice(-1)[0]?.[3]"
    before=d.js(phase)
    d.js("window.__rhwpProbe.throwAfterDiscard=true")
    if not getattr(d,"native_key_tool",None):
        raise smoke.Failure("failure-safety native test requires --native-keys")
    subprocess.run(["env","-u","LD_LIBRARY_PATH",d.native_key_tool,"type","F"],check=True,capture_output=True)
    failed=poc.wait_status(d,"failed")
    chord(d,"s");time.sleep(0.2)
    still_failed=status(d)
    safe=failed.get("uncertain")=="true" and still_failed["status"]=="failed" and command_state(d,"edit.undo")["disabled"] \
        and hashlib.sha256(path.read_bytes()).hexdigest()==sha and not d.exists('.rhwp-page__canvas')
    gate("D5",f"{fmt}: 실제 discard 뒤 예외 → uncertain, 편집/Undo/Save 차단·원본 SHA 보존",safe,"")
    poc.press_button(d,"[data-testid=rhwp-load]")
    poc.confirm_discard(d,"reload")
    reloaded=poc.wait_status(d,"ready")
    poc.click_paragraph_start(d)
    after=d.js(phase)
    check(f"{fmt}: 불확실 실패 후 버리기/실제 reload → 새 세대·원본 텍스트·빈 기록·새 Canvas",
        status(d)["paragraphText"]==pristine and command_state(d,"edit.undo")["disabled"]
        and after["session"]==before["session"] and after["generation"]>before["generation"]
        and d.js("return document.querySelector('.rhwp-page__canvas')?.width>0")
        and hashlib.sha256(path.read_bytes()).hexdigest()==sha)
    REPORT.setdefault("failureReload",{})[fmt]={"before":before,"after":after,"uncertain":failed.get("uncertain"),"shaPreserved":hashlib.sha256(path.read_bytes()).hexdigest()==sha}


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


def memory_sample(d) -> dict:
    return {**webprocess_memory(),**d.js("""const p=window.__rhwpProbe,cs=[...document.querySelectorAll('.rhwp-page__canvas')];
      return {wasmBytes:p.memory(),engineSurfaces:p.engineSurfaces?.()??null,owners:p.owners(),lastDisposal:p.disposals?.slice(-1)[0]??null,canvasCount:cs.length,canvasPixels:cs.reduce((n,c)=>n+c.width*c.height,0)}""")}


def close_discard(d, name):
    if not poc.close_tab(d,name):
        d.js("[...document.querySelectorAll('.document-tab__close')].find(b=>b.getAttribute('aria-label').includes(arguments[0])).click()", name)
        poc.confirm_discard(d,"close")


def stage_stats(samples):
    result={}
    for kind in {s["kind"] for s in samples}:
        rows=[s for s in samples if s["kind"]==kind]
        groups={name:[] for name in ("saveSnapshot","restoreSnapshot","getPageInfo","mutation","layoutTree","render","discardSnapshot","sessionReadPages","sessionMutation","revisionSchedule","backendCommitAck")}
        counts={name:0 for name in groups}
        for row in rows:
            sums={name:0 for name in groups}
            for c in row["calls"]:
                name=c["name"]
                if name in ("insertText","insertTextInCell","deleteText","deleteTextInCell","splitParagraph","splitParagraphInCell"):name="mutation"
                if name=="getPageLayerTreeWithProfile":name="layoutTree"
                if name.startswith("renderPage"):name="render"
                if name in sums:
                    sums[name]+=c["ms"];counts[name]+=1
            names={"rhwp:readPages":"sessionReadPages","rhwp:text-mutation":"sessionMutation",
                   "rhwp:revision-schedule":"revisionSchedule","rhwp:commit-ack":"backendCommitAck"}
            for span in row.get("trace",[]):
                if span["name"] in names:
                    name=names[span["name"]];sums[name]+=span["ms"];counts[name]+=1
            for name in groups:groups[name].append(sums[name])
        result[kind]={name:{**pct(values),"calls":counts[name]} for name,values in groups.items()}
        for name in ("sessionReadPages","sessionMutation","revisionSchedule","backendCommitAck"):
            if not counts[name]:result[kind][name]={"n":0,"calls":0,"unobserved":True}
        result[kind].update({name:pct([r[name] for r in rows]) for name in ("inputToFrame","keyToFrame","delivery")})
        result[kind]["inputHandlerMs"]=pct([r["inputHandlerMs"] for r in rows if r.get("inputHandlerMs") is not None])
    return result


# Same RAF boundary as MEASURE with no input and no model work: the event "happens" in a timer task, the next RAF
# plays the role of the revision-observing tick, then two more RAFs. Quantifies the contract's frame-wait floor only.
FRAME_FLOOR = r"""
const done = arguments[arguments.length - 1], out = [];
const one = () => setTimeout(() => {
  const start = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    out.push(performance.now() - start);
    if (out.length < 30) setTimeout(one, 37 + (out.length * 7) % 23); else done(out);
  })));
}, 0);
one();
"""


# Diagnostic only (--busy-probe): a self-reposting MessageChannel task records every gap > 8 ms in which this
# page's event loop could not run a task (JS, rendering update, GC — any web-process main-thread work). It perturbs
# scheduling, so its runs are never used for the contract value.
BUSY_PROBE = r"""
window.__busy={gaps:[],stop:false};const ch=new MessageChannel();let last=performance.now();
ch.port1.onmessage=()=>{const t=performance.now();if(t-last>8)window.__busy.gaps.push([last,t-last]);last=t;
  if(window.__busy.gaps.length>5000)window.__busy.gaps.shift();if(!window.__busy.stop)ch.port2.postMessage(0)};
ch.port2.postMessage(0);
"""


def thread_cpu() -> dict:
    """Per-thread CPU ticks (utime+stime) of this session's geul UI process and WebKit web processes."""
    out={}
    for pid in smoke.pids_with(smoke.ACTIVE["data_home"]):
        try:
            comm=Path(f"/proc/{pid}/comm").read_text().strip()
            if not (comm.startswith("WebKitWebProces") or comm=="geul"):
                continue
            for task in Path(f"/proc/{pid}/task").iterdir():
                stat=(task/"stat").read_text()
                name=stat[stat.index("(")+1:stat.rindex(")")]
                fields=stat[stat.rindex(")")+2:].split()
                out[f"{comm}:{'main' if task.name==str(pid) else name}:{task.name}"]=int(fields[11])+int(fields[12])
        except OSError:
            continue
    return out


def cpu_delta(before: dict, after: dict) -> dict:
    tick=os.sysconf("SC_CLK_TCK")
    rows={}
    for key,value in after.items():
        proc,name,_=key.split(":",2)
        ms=(value-before.get(key,0))*1000/tick
        if ms>0: rows[f"{proc}:{name}"]=rows.get(f"{proc}:{name}",0)+ms
    return dict(sorted(((k,round(v)) for k,v in rows.items()),key=lambda kv:-kv[1])[:12])


def timeline_samples(raw):
    """Per-sample attribution (numbers and span names only; no document content)."""
    rows=[]
    for s in raw:
        calls={}
        for c in s.get("calls",[]):
            name=c["name"]
            calls.setdefault(name,{"n":0,"ms":0.0,"firstAt":c.get("at")})
            calls[name]["n"]+=1;calls[name]["ms"]=round(calls[name]["ms"]+c["ms"],2)
        rows.append({"kind":s["kind"],"keyToFrame":round(s["keyToFrame"],1),"at":{k:(None if v is None else round(v,1)) for k,v in (s.get("at") or {}).items()},
                     "calls":calls,"timeline":[{"name":t["name"],"at":round(t["at"],1),"ms":None if t["ms"] is None else round(t["ms"],2),"page":t.get("page")} for t in s.get("timeline",[])][:80],
                     "busy":None if s.get("busy") is None else [[round(a,1),round(b,1)] for a,b in s["busy"]][:40]})
    return rows


def scenario_perf(d, path: Path, scratch: Path, control=False) -> None:
    """Same frame boundary as historical MEASURE; additionally report keydown and API stages."""
    copy = scratch / path.name
    shutil.copyfile(path, copy)
    d.js("window.__rhwpProbe.historyDisabled=arguments[0]",control)
    rss0=memory_sample(d)
    st=poc.open_document(d,copy,expected="ready")
    poc.require_test_hooks(d)
    if not control: require_activation(d)
    poc.set_zoom(d,50)
    smoke.wait_until(d,"return document.querySelectorAll('.rhwp-page__canvas').length===Number(arguments[0])",int(st["pages"]),timeout=30)
    poc.click_paragraph_start(d)
    # Warm up loading/JIT/font/render paths before collecting.
    for _ in range(3):
        poc.press(d,"Right"); poc.type_ascii(d,"ab")
    time.sleep(1)
    rss_open=memory_sample(d)
    d.js("window.__lat=null; window.__gaps=null;window.__rhwpProbe.calls=[];window.__geulTrace={seq:0,dropped:0,records:[]}")
    if getattr(d,"busy_probe",False): d.js(BUSY_PROBE)
    d.js(MEASURE)
    cpu0=thread_cpu()
    for _ in range(30):
        poc.press(d,"Right")
        d.js("window.__nextKind='groupStart'");poc.type_ascii(d,"a")
        d.js("window.__nextKind='extend'");poc.type_ascii(d,"b")
    cpu_typing=cpu_delta(cpu0,thread_cpu())
    d.js("window.__gaps.length=0")
    if not control:
        for _ in range(20):
            history_key(d,"z");history_key(d,"y")
        undo_redo_gaps=d.js("return window.__gaps.slice()")
        for _ in range(5):
            history_key(d,"z");d.js("window.__nextKind='afterUndo'");poc.type_ascii(d,"c")
    time.sleep(0.2)
    gaps=d.js("return window.__gaps.slice()")
    if control: undo_redo_gaps=[]
    raw=d.js("return window.__stages")
    stages=stage_stats(raw)
    floor=d.call("POST","/execute/async",{"script":FRAME_FLOOR,"args":[]})
    if len(latencies(d).get("groupStart",[])) != 30:
        raise smoke.Failure("groupStart sample count mismatch; benchmark is invalid")
    lat=latencies(d);rss_ops=memory_sample(d)
    close_discard(d,copy.name);time.sleep(2)
    rss_closed=memory_sample(d);poc.set_zoom(d,100)
    spans=d.js("return (window.__geulTrace?.records||[]).filter(r=>typeof r[3]?.ms==='number').map(r=>({name:r[2],ms:r[3].ms}))")
    session_spans={kind:pct([r["ms"] for r in spans if r["name"]==kind]) for kind in {r["name"] for r in spans}}
    row={"sample":path.name,"dpr":d.js("return window.devicePixelRatio"),"sessionSpansMs":session_spans,"control":"injected capacity refusal" if control else "normal history","fileBytes":path.stat().st_size,
         "pages":int(st["pages"]),"zoom":50,"warmupGroups":3,**{k:pct(v) for k,v in lat.items()},
         "stages":stages,"timelineSamples":timeline_samples(raw),"busyProbe":getattr(d,"busy_probe",False),"threadCpuDuringTypingMs":cpu_typing,"zeroWorkFrameFloorMs":pct(floor),"frameGapDuringHistoryAndFollowingInputMs":pct(gaps),"frameGapDuringUndoRedoMs":pct(undo_redo_gaps),"memory":{"beforeOpen":rss0,"afterOpen":rss_open,"afterUndoRedo":rss_ops,"afterClose":rss_closed}}
    REPORT.setdefault("perf",[]).append(row)
    print("[측정]",json.dumps({k:row[k] for k in ("sample","pages","groupStart","extend","undo","redo") if k in row},ensure_ascii=False),flush=True)
    if not control and not getattr(d,"busy_probe",False):
        gate("D4",f"{path.suffix}: group-start key→frame p95 ≤50ms",row.get("groupStart",{}).get("p95",float('inf'))<=50 and row.get("groupStart",{}).get("timeouts",1)==0,str(row.get("groupStart")))
        gate("D4",f"{path.suffix}: Undo p95 ≤1500ms",row.get("undo",{}).get("p95",float('inf'))<=1500 and row.get("undo",{}).get("timeouts",1)==0,str(row.get("undo")))


def scenario_lifecycle(d,path,scratch,cycles):
    copy=scratch/path.name;shutil.copyfile(path,copy)
    poc.set_zoom(d,50)
    rows=[]
    for mode in ("openClose","editCapacityRefusalControl","undoRedo"):
        d.js("window.__rhwpProbe.historyDisabled=arguments[0]",mode=="editCapacityRefusalControl")
        for cycle in range(cycles):
            before=memory_sample(d)
            poc.open_document(d,copy,expected="ready")
            smoke.wait_until(d,"return document.querySelector('.rhwp-page__canvas')?.width>0",timeout=30)
            if mode!="openClose":
                poc.click_paragraph_start(d)
                for _ in range(6):
                    poc.press(d,"Right");poc.type_ascii(d,"a")
                if mode=="undoRedo":
                    for _ in range(6):history_key(d,"z");history_key(d,"y")
            time.sleep(1)
            opened=memory_sample(d)
            close_discard(d,copy.name);time.sleep(2)
            closed=memory_sample(d)
            row={"mode":mode,"cycle":cycle,"before":before,"opened":opened,"closed":closed}
            if cycle==cycles-1:
                time.sleep(8)
                row["closedAfter10s"]=memory_sample(d)
            rows.append(row);print("[수명주기]",json.dumps(row),flush=True)
            gate("D4",f"{mode} cycle{cycle}: 문서 핸들/스냅숏 참조/화면 Canvas 정리",not closed["owners"] and closed["canvasCount"]==0,"")
    REPORT.setdefault("lifecycle",[]).append({"sample":path.name,"cyclesPerMode":cycles,"stabilizationSeconds":2,"rows":rows})
    gate("D4",f"{path.suffix}: 전역 캐시와 장기 RSS 안정성 판정",None,
         "소유 참조 검사와 별도: 측정 결과에 대한 엔진 캐시/RSS 진단이 필요함",outcome="INCONCLUSIVE")



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

        # 선택 없는 실제 Backspace 취소는 새 revision/기록이 없다.
        typ("r"); key("BackSpace"); key("ctrl+z")
        no_selection=poc.settle(d,f"{fmt}: 선택 없는 취소 직후 Undo")
        gate("D2",f"{fmt}: 선택 없는 취소는 문서/판/기록을 만들지 않음",no_selection["paragraphText"]==base_text
             and no_selection["localRevision"]==base["localRevision"],"")

        # Backspace that only shrinks a syllable is still active composition, not cancellation.
        typ("gks");key("BackSpace")
        partial=poc.settle(d,f"{fmt}: 한→하")
        typ("r");key("End")
        shrunk_commit=poc.settle(d,f"{fmt}: 하→학 확정")
        key("ctrl+z")
        shrunk_undo=poc.settle(d,f"{fmt}: 학 Undo")
        gate("D2",f"{fmt}: 부분 Backspace는 하를 잃지 않고 학으로 확정·Undo",partial["paragraphText"]==base_text+"하"
             and partial.get("composing")=="true" and shrunk_commit["paragraphText"]==base_text+"학"
             and shrunk_undo["paragraphText"]==base_text,"")
        # After undo, cancel an entirely new composition without touching the old redo state.
        before_full_cancel=shrunk_undo["localRevision"]
        typ("gk");key("BackSpace")
        last_jamo=poc.settle(d,f"{fmt}: 하→ㅎ")
        key("BackSpace")
        full_cancel=poc.settle(d,f"{fmt}: ㄱ→취소")
        gate("D2",f"{fmt}: 여러 자모를 모두 취소해도 revision/기록 추가 없음",last_jamo["paragraphText"]==base_text+"ㅎ"
             and full_cancel["paragraphText"]==base_text and full_cancel["localRevision"]==before_full_cancel
             and not command_state(d,"edit.redo")["disabled"],"")

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
        before_check=d.js("""const expected=arguments[0],at=arguments[1].split(':').map(Number);
          window.__geulTrace = {seq:0,dropped:0,records:[]};window.__cancelModel=null;
          document.querySelector('.rhwp-input').addEventListener('compositionend',e=>{
            if(!e.data) {const trace=window.__geulTrace.records.filter(r=>r[2]==='ime:compositionEnd').slice(-1)[0];
              window.__cancelModel={...window.__rhwpProbe.paragraphCheck(expected,at[0],at[1]),revision:trace?.[3]?.revision};}
          });return window.__rhwpProbe.paragraphCheck(expected+'한글',at[0],at[1])""",base_text,sel["caret"])
        REPORT.setdefault("beforeCancelModel",{})[fmt]=before_check
        typ("r")
        key("BackSpace","ctrl+z")  # 한 native 호출; DOM 조회/settle 없이 Undo
        back = poc.settle(d, f"{fmt}: 선택 되살림")
        cancelled_model=d.js("return window.__cancelModel")
        REPORT.setdefault("cancelModel",{})[fmt]=cancelled_model
        restored_now = back["paragraphText"] == base_text + "한글"
        REPORT.setdefault("cancelTrace", {})[fmt] = d.js("return window.__geulTrace")
        gate("D2", f"{fmt}: 선택을 조합으로 바꾸다 취소 → 바로 Ctrl+Z가 선택 글자를 되살림", bool(sel.get("selection"))
             and cancelled_model and cancelled_model["equals"] and before_check["equals"] and restored_now and back["selection"]==sel["selection"]
             and int(back["localRevision"])==cancelled_model["revision"]+1,
             f"선택={bool(sel.get('selection'))}, 취소 뒤 글자 수 {cancelled_model.get('actualLength',-1) - len(base_text)}, Ctrl+Z 뒤 {len(back['paragraphText']) - len(base_text)}"
             f" (model cancellation={cancelled_model}, before={before_check})")
        if restored_now:
            key("ctrl+y")
            deleted_again=poc.settle(d,f"{fmt}: 취소 삭제 Redo")
            key("ctrl+shift+z")
            no_extra=poc.settle(d,f"{fmt}: 남은 Redo 없음")
            key("ctrl+z")
            restored_again=poc.settle(d,f"{fmt}: 취소 삭제 다시 Undo")
            gate("D2",f"{fmt}: 취소 직후 Undo의 Ctrl+Y/Ctrl+Shift+Z와 정확한 선택 복원",deleted_again["paragraphText"]==base_text
                 and no_extra["localRevision"]==deleted_again["localRevision"] and restored_again["paragraphText"]==base_text+"한글"
                 and restored_again["selection"]==sel["selection"],"")
        if restored_now:
            # Stress the actual native queue: cancellation+Undo in one process at1ms,
            # never insert a WebDriver round trip between the two key sequences.
            fast_before=int(restored_again["localRevision"])
            d.js("window.__geulTrace={seq:0,dropped:0,records:[]};window.__cancelModel=null")
            typ("r")
            run(xdotool,"key","--delay","1","BackSpace","ctrl+z")
            fast_back=poc.settle(d,f"{fmt}: 1ms 취소/Undo")
            fast_cancel=d.js("return window.__cancelModel")
            REPORT.setdefault("cancelFastTrace",{})[fmt]=d.js("return window.__geulTrace")
            gate("D2",f"{fmt}: native 1ms Backspace→Ctrl+Z, 원래 선택/글자와 revision+2",bool(fast_cancel and fast_cancel["equals"])
                 and fast_back["paragraphText"]==base_text+"한글" and fast_back["selection"]==sel["selection"]
                 and int(fast_back["localRevision"])==fast_before+2,"")
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


def scenario_ime_gap(d,fixtures,xdotool,ibus):
    reason=poc.ime_environment(xdotool,ibus)
    if reason:
        gate("D2","native final-gap",None,reason);return
    run=lambda *a:subprocess.run(["env","-u","LD_LIBRARY_PATH",*a],check=True,capture_output=True,text=True)
    for fmt in ("hwp","hwpx"):
        poc.open_document(d,fixtures/f"basic-ko.{fmt}");poc.click_paragraph_start(d)
        window=run(xdotool,"search","--onlyvisible","--name","^geul").stdout.split()[-1]
        run(xdotool,"windowfocus","--sync",window)
        if run(ibus,"engine").stdout.strip()!="hangul":run(ibus,"engine","hangul")
        if run(ibus,"engine").stdout.strip()!="hangul":raise smoke.Failure("ibus hangul engine not active")
        # Native (xdotool window-relative) pointer calibration; no click or IME synthesis.
        d.js("window.__gapMove=null;window.addEventListener('mousemove',e=>{window.__gapMove=[e.clientX,e.clientY]},true)")
        run(xdotool,"mousemove","--window",window,"100","100")
        smoke.wait_until(d,"return window.__gapMove!==null")
        one=d.js("return window.__gapMove")
        d.js("window.__gapMove=null")
        run(xdotool,"mousemove","--window",window,"200","200")
        smoke.wait_until(d,"return window.__gapMove!==null")
        two=d.js("return window.__gapMove")
        scale=[100/(two[i]-one[i]) for i in (0,1)];origin=[100-one[i]*scale[i] for i in (0,1)]
        base=status(d)["paragraphText"];rows=[]
        REPORT.setdefault("nativeFinalGap",{})[fmt]=rows
        for delay,mode in ((0,"key"),(1,"key"),(5,"key"),(0,"pointer"),(1,"pointer")):
            run(xdotool,"type","--delay","90","gk");run(xdotool,"key","End")
            prefix=poc.settle(d,f"{fmt}: 앞 거래")
            d.js("window.__geulTrace={seq:0,dropped:0,records:[]}")
            run(xdotool,"type","--delay","90","rk")
            if mode=="pointer":
                point=poc.caret_client(d);point=[point[0],point[1]+point[2]/2]
                xy=[str(round(point[i]*scale[i]+origin[i])) for i in (0,1)]
                run(xdotool,"mousemove","--window",window,*xy,"click","1","key","--delay",str(delay),"ctrl+z")
            else:
                run(xdotool,"key","--delay",str(delay),"ctrl+z")
            final=poc.settle(d,f"{fmt}: final gap Ctrl+Z")
            trace=d.js("return window.__geulTrace")
            records=trace["records"]
            empties=[r[0] for r in records if r[2]=="dom:compositionend" and r[3]["length"]==0]
            finals=[r[0] for r in records if r[2]=="dom:input" and r[3]["inputType"]=="insertFromComposition" and r[3]["length"]>0]
            gap=lambda seq:any(a<seq<b for a in empties for b in finals)
            requests=[r for r in records if r[2]=="command:request" and r[3]["id"]=="edit.undo"]
            observed=any(gap(r[0]) and r[3]["reason"]=="composing" for r in requests)
            chord_in_gap=any(gap(r[0]) and r[2] in ("dom:keydown","dom:keyup") and r[3].get("key")=="mod:KeyZ" for r in records)
            accepted=any(r[2]=="command:dispatch" and r[3]["id"]=="edit.undo" and r[3]["accepted"] for r in records)
            want=prefix["paragraphText"] if accepted else prefix["paragraphText"]+"가"
            delta=int(final["localRevision"])-int(prefix["localRevision"])
            if not accepted and final.get("composing")=="true" and not finals:
                # This platform delivered the shortcut during active preedit rather than a split tail.
                # Verify that path, finalize natively for cleanup, but never count it as gap coverage.
                safe=final["paragraphText"]==prefix["paragraphText"]+"가" and delta==0
                run(xdotool,"key","End");final=poc.settle(d,f"{fmt}: 활성 조합의 나중 native 확정")
                safe=safe and final["paragraphText"]==prefix["paragraphText"]+"가" and int(final["localRevision"])==int(prefix["localRevision"])+1
            else:
                safe=final["paragraphText"]==want and delta==(2 if accepted else 1)
            if not accepted:
                run(xdotool,"key","ctrl+z");poc.settle(d,f"{fmt}: 나중 명시 Undo")
            run(xdotool,"key","ctrl+y");redone=poc.settle(d,f"{fmt}: 늦은 확정 Redo")
            safe=safe and redone["paragraphText"]==prefix["paragraphText"]+"가"
            rows.append({"mode":mode,"delayMs":delay,"commandInGap":observed,"chordInGap":chord_in_gap,"acceptedAfterFinal":accepted,
                         "safe":safe,"revisionDelta":delta,"trace":trace})
            run(xdotool,"key","ctrl+z","ctrl+z");clean=poc.settle(d,f"{fmt}: 정리")
            if clean["paragraphText"]!=base:raise smoke.Failure("native final-gap cleanup did not restore base")
        REPORT.setdefault("nativeFinalGap",{})[fmt]=rows
        safe=all(r["safe"] for r in rows)
        observed=any(r["commandInGap"] or r["chordInGap"] for r in rows)
        gate("D2",f"{fmt}: 실제 빈 끝~late final 사이 Ctrl+Z 거절·앞 거래 보존·나중 Undo/Redo",False if not safe else True if observed else None,
             f"safe={safe}, native gap observed={observed}",outcome="INCONCLUSIVE" if safe and not observed else None)


def own_engine_pids() -> list[int]:
    """ibus-engine-hangul processes of this X display only (never the host user's input method)."""
    display=os.environ.get("DISPLAY","")
    pids=[]
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit(): continue
        try:
            if "ibus-engine-hangul" not in (proc/"cmdline").read_bytes().decode(errors="replace"): continue
            env=(proc/"environ").read_bytes().split(b"\0")
        except OSError:
            continue
        if f"DISPLAY={display}".encode() in env: pids.append(int(proc.name))
    return pids


def gap_order(records):
    """Compact, content-free event order of one trial (kinds, lengths, awaiting state)."""
    out=[]
    for seq,_t,kind,detail in records:
        detail=detail or {}
        if kind=="dom:compositionend": out.append(f"end{detail.get('length')}")
        elif kind=="dom:input" and "Composition" in str(detail.get("inputType")): out.append(f"{detail['inputType']}:{detail.get('length')}")
        elif kind in ("dom:keydown",) and str(detail.get("key","")).startswith("mod:"): out.append(detail["key"])
        elif kind=="command:request" and detail.get("id")=="edit.undo": out.append(f"undoReq:{detail.get('reason')}")
        elif kind=="command:dispatch" and detail.get("id")=="edit.undo": out.append(f"undoDispatch:{detail.get('accepted')}")
        elif kind=="ime:compositionEnd": out.append(f"awaiting:{detail.get('awaiting')}")
    return out


# 빈 compositionend가 온 뒤 늦은 확정(insertFromComposition)이 그 dispatch 안에서 오는지(다른 task가 끼어들 수 없음)를
# 본다. 빈 끝에서 MessageChannel task를 걸고, 확정이 올 때 그 task가 이미 돌았는지 기록한다(돌지 않았으면 키 입력 task도
# 그 사이에 끼어들지 못했다). 관찰만 하며 이벤트를 만들지 않는다.
FINAL_TASK_PROBE = r"""
window.__gapTasks = [];
if (!window.__gapTaskInstalled) {
  window.__gapTaskInstalled = true;
  document.addEventListener('compositionend', (e) => {
    if (e.data !== '') return;
    const rec = { endAt: performance.now(), task: false, finalAt: null, finalAfterTask: null, keyBeforeFinal: null };
    window.__gapTasks.push(rec);
    const ch = new MessageChannel(); ch.port1.onmessage = () => { rec.task = true; }; ch.port2.postMessage(0);
  }, true);
  document.addEventListener('input', (e) => {
    if (e.inputType !== 'insertFromComposition' || !e.data) return;
    const rec = window.__gapTasks.at(-1);
    if (rec && rec.finalAt === null) { rec.finalAt = performance.now() - rec.endAt; rec.finalAfterTask = rec.task; }
  }, true);
  document.addEventListener('keydown', (e) => {
    const rec = window.__gapTasks.at(-1);
    if (rec && rec.finalAt === null && rec.keyBeforeFinal === null) rec.keyBeforeFinal = e.code;
  }, true);
}
"""


def scenario_ime_gap_matrix(d,fixtures,xdotool,ibus,rounds=1):
    """Bounded native scheduling matrix for the empty-compositionend → Ctrl+Z → late final window (Stage B).

    Every key and click is a real X11 event through ibus-hangul and WebKitGTK; nothing is injected into the DOM.
    Timing is perturbed only externally: chord/press delays, a real pointer click, and briefly stopping this display's
    ibus-engine-hangul process (SIGSTOP/SIGCONT) so that the IME's replies are genuinely late.
    """
    reason=poc.ime_environment(xdotool,ibus)
    if reason:
        gate("D2","native final-gap matrix",None,reason);return
    run=lambda *a:subprocess.run(["env","-u","LD_LIBRARY_PATH",*a],check=True,capture_output=True,text=True)
    specs=[("key",0),("key",1),("key",3),("key",8),("key",15),("earlyCtrl",0),("earlyCtrl",10),("earlyCtrl",30),
           ("pointer",0),("pointer",2),("stall",15),("stall",40),("stall",120),("stallAfterCtrl",0),("stallAfterCtrl",5),
           ("stallAfterCtrl",20),("pointerStall",20),("pointerStall",80)]
    matrix=REPORT.setdefault("nativeFinalGapMatrix",{})
    REPORT["nativeFinalGapEnvironment"]={"ibusSyncMode":os.environ.get("IBUS_ENABLE_SYNC_MODE","unset"),
                                         "hangulEventForwarding":os.environ.get("GEUL_IBUS_FORWARDING","false")}
    for fmt in ("hwp","hwpx"):
        poc.open_document(d,fixtures/f"basic-ko.{fmt}");poc.click_paragraph_start(d)
        window=run(xdotool,"search","--onlyvisible","--name","^geul").stdout.split()[-1]
        run(xdotool,"windowfocus","--sync",window)
        if run(ibus,"engine").stdout.strip()!="hangul":run(ibus,"engine","hangul")
        if run(ibus,"engine").stdout.strip()!="hangul":raise smoke.Failure("ibus hangul engine not active")
        engines=own_engine_pids()
        if not engines: raise smoke.Failure("this display's ibus-engine-hangul process not found")
        d.js("window.__gapMove=null;window.addEventListener('mousemove',e=>{window.__gapMove=[e.clientX,e.clientY]},true)")
        run(xdotool,"mousemove","--window",window,"100","100");smoke.wait_until(d,"return window.__gapMove!==null")
        one=d.js("return window.__gapMove");d.js("window.__gapMove=null")
        run(xdotool,"mousemove","--window",window,"200","200");smoke.wait_until(d,"return window.__gapMove!==null")
        two=d.js("return window.__gapMove")
        scale=[100/(two[i]-one[i]) for i in (0,1)];origin=[100-one[i]*scale[i] for i in (0,1)]
        base=status(d)["paragraphText"];rows=[];matrix[fmt]=rows
        for _round in range(rounds):
            for mode,amount in specs:
                run(xdotool,"type","--delay","90","gk");run(xdotool,"key","End")
                prefix=poc.settle(d,f"{fmt}: 앞 거래")
                d.js("window.__geulTrace={seq:0,dropped:0,records:[]}");d.js(FINAL_TASK_PROBE)
                run(xdotool,"type","--delay","90","rk")
                stopped=False
                try:
                    if mode=="key":
                        run(xdotool,"key","--delay",str(amount),"ctrl+z")
                    elif mode=="earlyCtrl":
                        run(xdotool,"keydown","ctrl");time.sleep(amount/1000);run(xdotool,"key","z");run(xdotool,"keyup","ctrl")
                    elif mode in ("pointer","pointerStall"):
                        point=poc.caret_client(d);point=[point[0],point[1]+point[2]/2]
                        xy=[str(round(point[i]*scale[i]+origin[i])) for i in (0,1)]
                        if mode=="pointerStall":
                            for pid in engines: os.kill(pid,19)
                            stopped=True
                        run(xdotool,"mousemove","--window",window,*xy,"click","1","key","--delay",str(0 if mode=="pointerStall" else amount),"ctrl+z")
                        if stopped: time.sleep(amount/1000)
                    elif mode=="stall":
                        for pid in engines: os.kill(pid,19)
                        stopped=True
                        run(xdotool,"key","ctrl+z");time.sleep(amount/1000)
                    elif mode=="stallAfterCtrl":
                        run(xdotool,"keydown","ctrl")
                        for pid in engines: os.kill(pid,19)
                        stopped=True
                        time.sleep(amount/1000);run(xdotool,"key","z");time.sleep(0.03)
                finally:
                    if stopped:
                        for pid in engines: os.kill(pid,18)
                    if mode=="stallAfterCtrl": run(xdotool,"keyup","ctrl")
                final=poc.settle(d,f"{fmt}: matrix {mode} {amount}")
                if final.get("composing")=="true":
                    run(xdotool,"key","End");final=poc.settle(d,f"{fmt}: matrix 나중 native 확정")
                records=d.js("return window.__geulTrace")["records"]
                empties=[r[0] for r in records if r[2]=="dom:compositionend" and r[3]["length"]==0]
                finals=[r[0] for r in records if r[2]=="dom:input" and r[3]["inputType"]=="insertFromComposition" and r[3]["length"]>0]
                gap=lambda seq:any(a<seq<b for a in empties for b in finals)
                in_gap=any(gap(r[0]) and ((r[2]=="dom:keydown" and r[3].get("key")=="mod:KeyZ") or (r[2]=="command:request" and r[3]["id"]=="edit.undo")) for r in records)
                accepted=any(r[2]=="command:dispatch" and r[3]["id"]=="edit.undo" and r[3]["accepted"] for r in records)
                delta=int(final["localRevision"])-int(prefix["localRevision"])
                text=final["paragraphText"];want=prefix["paragraphText"] if accepted else prefix["paragraphText"]+"가"
                # Safe: exactly the old transaction kept, the new syllable either present once (Undo refused) or undone
                # after it was final (accepted), never duplicated/lost, revision only forward, composition settled.
                safe=text==want and delta==(2 if accepted else 1) and final.get("composing")!="true"
                if not accepted:
                    run(xdotool,"key","ctrl+z");after=poc.settle(d,f"{fmt}: matrix 나중 명시 Undo")
                    safe=safe and after["paragraphText"]==prefix["paragraphText"]
                run(xdotool,"key","ctrl+y");redone=poc.settle(d,f"{fmt}: matrix Redo")
                safe=safe and redone["paragraphText"]==prefix["paragraphText"]+"가"
                rows.append({"mode":mode,"amountMs":amount,"windowObserved":in_gap,"acceptedAfterFinal":accepted,"safe":safe,
                             "revisionDelta":delta,"emptyEnds":len(empties),"finalInserts":len(finals),"order":gap_order(records),
                             "finalDispatch":d.js("return window.__gapTasks")})
                print("[matrix]",fmt,mode,amount,"window" if in_gap else "-","accepted" if accepted else "refused","safe" if safe else "UNSAFE",flush=True)
                run(xdotool,"key","ctrl+z","ctrl+z");clean=poc.settle(d,f"{fmt}: matrix 정리")
                if clean["paragraphText"]!=base:raise smoke.Failure("native final-gap matrix cleanup did not restore base")
        safe=all(r["safe"] for r in rows);observed=any(r["windowObserved"] for r in rows)
        gate("D2",f"{fmt}: native 순서 행렬({len(rows)}회) 빈 끝~late final 사이 Ctrl+Z",False if not safe else True if observed else None,
             f"safe={safe}, window observed={observed}",outcome="INCONCLUSIVE" if safe and not observed else None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--driver-log", type=Path)
    parser.add_argument("--ime", action="store_true")
    parser.add_argument("--ime-gap", action="store_true")
    parser.add_argument("--ime-gap-matrix", action="store_true", help="Stage B: native 순서 행렬(지연·포인터·입력기 정지), --cycles 회 반복")
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--failure-safety", action="store_true")
    parser.add_argument("--cells", action="store_true")
    parser.add_argument("--attribution", action="store_true", help="record supplementary session trace timings (requires latest test build)")
    parser.add_argument("--large-only", action="store_true")
    parser.add_argument("--native-keys", action="store_true", help="X11 xdotool key delivery; same page timing boundaries")
    parser.add_argument("--lifecycle", action="store_true")
    parser.add_argument("--memory-sample", choices=["hwp","hwpx"])
    parser.add_argument("--cycles", type=int, default=5)
    parser.add_argument("--perf-control", action="store_true")
    parser.add_argument("--perf", action="store_true", help="큰 공개 예제 성능만")
    parser.add_argument("--busy-probe", action="store_true", help="진단 전용: 페이지 main-thread 정지 구간 기록(측정값 교란, 관문 판정에 쓰지 않음)")
    parser.add_argument("--perf-only", help="성능 표본 하나만(파일 이름) — 문서마다 앱 세션을 따로 띄울 때")
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
                        native_probe.install(d)
                        d.busy_probe=args.busy_probe
                        REPORT["attributionRequested"]=args.attribution
                        if args.native_keys:
                            if not os.environ.get("DISPLAY"):
                                raise smoke.Failure("native keys require X11 DISPLAY")
                            windows=subprocess.run([args.xdotool,"search","--onlyvisible","--name","^geul"],check=True,capture_output=True,text=True).stdout.split()
                            subprocess.run([args.xdotool,"windowfocus","--sync",windows[-1]],check=True,capture_output=True)
                            d.native_key_tool=args.xdotool
                            REPORT["keyDelivery"]="native X11 xdotool"

                        if args.ime:
                            scenario_ime(d, fixtures, args.xdotool, args.ibus)
                        if args.ime_gap:
                            scenario_ime_gap(d,fixtures,args.xdotool,args.ibus)
                        if args.ime_gap_matrix:
                            scenario_ime_gap_matrix(d,fixtures,args.xdotool,args.ibus,args.cycles)
                        if args.cells:
                            for fmt in ("hwp", "hwpx"):
                                scenario_cells(d, fixtures / f"basic-ko.{fmt}", fmt)
                        if args.render:
                            for fmt in ("hwp", "hwpx"):
                                scenario_render_basic(d, fixtures / f"basic-ko.{fmt}", fmt, args.screenshots)
                            for path, _ in MULTI:
                                scenario_render_multi(d, path, scratch)
                            scenario_reload_close(d, fixtures / "basic-ko.hwp")
                        if args.failure_safety or args.render:
                            for fmt in ("hwp","hwpx"):
                                scenario_discard_failure_reload(d,fixtures / f"basic-ko.{fmt}",fmt)
                        if args.perf:
                            for path in (LARGE if args.large_only else [fixtures / "basic-ko.hwp",fixtures / "basic-ko.hwpx",*LARGE]):
                                if args.perf_only and path.name != args.perf_only: continue
                                scenario_perf(d, path, scratch,args.perf_control)
                        if args.lifecycle:
                            for path in LARGE:
                                if args.memory_sample and path.suffix != "."+args.memory_sample: continue
                                scenario_lifecycle(d,path,scratch,args.cycles)
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
        # Individual scenarios record their own boundary evidence before driver teardown.
        return 1
    finally:
        if args.report:
            args.report.write_text(json.dumps({"results": RESULTS, "gates": GATES, "measurements": REPORT}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
