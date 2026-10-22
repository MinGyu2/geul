#!/usr/bin/env python3
"""T007 rhwp HWP/HWPX 중앙 편집 PoC를 실제 Tauri 앱(WebKitGTK)에서 실행하고 측정한다.

필요: 검사 훅을 켠 앱 빌드(`VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` — 커서 문단 글자를
진단 속성으로 노출, 일반 빌드에는 없음), `scripts/build-rhwp-wasm.sh` 산출물(public/rhwp/), tauri-driver 2.x,
WebKitWebDriver, Node.js, 그래픽 세션(Wayland weston 또는 X11).
픽스처는 실행할 때 `tests/fixtures/rhwp/generate.mjs`로 임시 디렉터리에 만든다(저장소에 바이너리 없음).

    python3 tests/integration/rhwp/rhwp_poc.py --app src-tauri/target/debug/geul --driver <tauri-driver> \\
        [--report <결과 JSON>] [--screenshots <디렉터리>]

    # T010 명령 시나리오만(지원하지 않는 Ctrl+Z·Ctrl+B 등은 아무것도 바꾸지 않음, Ctrl+S는 저장 절차):
    python3 tests/integration/rhwp/rhwp_poc.py --app ... --driver ... --commands-only

    # 실제 한국어 IME 게이트(X11 + ibus-hangul + xdotool, 실제 키 입력):
    python3 tests/integration/rhwp/rhwp_poc.py --app ... --driver ... --ime --xdotool <xdotool> --ibus <ibus> \\
        [--focus-window <다른 X 창 이름 정규식>] [--diagnostic-only]

IME 게이트는 실제 입력을 보낸 뒤 고정 시간이 아니라 페이지가 그 입력을 모두 처리할 때까지(settle: 입력 이벤트·편집 상태가
잠시 그대로) 기다린 뒤 판정하고, 기다린 시간은 지연 증거로 보고서 imeDrain에 남긴다. 항목마다 PASS·FAIL·UNVERIFIED·NOT RUN을 출력한다. 선택 항목(창 초점 이동)은 `--focus-window`로 이미 떠 있는
다른 X 창을 줄 때만 실행한다. 탭 전환 중 조합은 필수 항목이 아니라 관찰 기록(`[기록]`, 보고서 imeTabSwitch)이다. 필수 항목이 모두 PASS일 때만 종료 코드 0이고, FAIL이
있으면 1, 실제 입력 환경이 없어 판단할 수 없으면(UNVERIFIED) 2다. `--diagnostic-only`는 관찰만 기록하고 종료 코드로
게이트 결과를 나타내지 않는다(통과 증거가 아님). 합성 DOM 이벤트는 쓰지 않는다.

측정은 화면에 그린 rhwp 페이지·커서(엔진의 getCursorRect)를 기준으로 한다. hit test 편차는 실제 포인터 클릭을 글자 경계
사이 30%/70% 지점에 보내 얻은 커서 오프셋과 기대 오프셋의 차이(글자 수)다. 응답 시간은 입력 이벤트부터 바뀐 페이지를
다시 그린 뒤 두 번째 animation frame까지(앱이 data-latency-*로 보고)다. 실패하면 종료 코드 1.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests" / "e2e"))
import tauri_smoke as smoke  # noqa: E402  (WebDriver·tauri-driver 도우미 재사용)

STATUS = "[data-testid=rhwp-status]"
RESULTS: list[str] = []
REPORT: dict = {}


def perform(d, actions: list[dict]) -> None:
    """WebDriver 입력 동작을 보내고 입력 상태를 놓는다(연속 포인터 동작에서 WebKitWebDriver가 끊기는 것을 줄인다)."""
    d.actions(actions)
    d.call("DELETE", "/actions")


def check(name: str, condition: bool, detail: str = "") -> None:
    smoke.check(RESULTS, name, condition, detail)


def status(d) -> dict:
    return d.js(f"const e=document.querySelector('{STATUS}'); return e ? {{...e.dataset}} : null") or {}


def require_test_hooks(d) -> None:
    """검사 훅(커서 문단 글자 진단)이 있는 빌드인지 확인한다. 없으면 글자 비교 검사를 할 수 없으므로 멈춘다."""
    if "paragraphText" not in status(d):
        raise smoke.Failure("검사 훅이 없는 빌드입니다: VITE_GEUL_TEST_HOOKS=1로 앱을 빌드하세요")


def confirm_discard(d, action: str) -> None:
    """버리기 확인 창이 떴는지 보고 '버리기'를 누른다(앱 버튼은 DOM click)."""
    smoke.wait_until(d, "const e=document.querySelector('[data-testid=discard-dialog]'); return e && e.dataset.action===arguments[0]"
                     " && document.activeElement?.dataset.testid==='discard-cancel'", action, timeout=10)
    press_button(d, "[data-testid=discard-confirm]")


def wait_status(d, expected: str, timeout: float = 60) -> dict:
    smoke.wait_until(d, f"const e=document.querySelector('{STATUS}'); return e && e.dataset.status===arguments[0]",
                     expected, timeout=timeout)
    return status(d)


def set_path(d, path: Path) -> None:
    d.js("""const el=document.querySelector('#document-path');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, arguments[0]);
      el.dispatchEvent(new Event('input',{bubbles:true}));""", str(path))


def open_document(d, path: Path, expected: str = "ready") -> dict:
    set_path(d, path)
    d.js("document.querySelector('.document-bar__open').requestSubmit()")
    smoke.wait_until(d, "return [...document.querySelectorAll('.document-tab__select')].some(t => t.textContent.includes(arguments[0]))"
                     " && document.querySelector('[data-testid=rhwp-status] h1')?.textContent === arguments[0]", path.name, timeout=30)
    return wait_status(d, expected)


def click(d, x: float, y: float) -> None:
    width, height = d.js("return [window.innerWidth, window.innerHeight]")
    if not (0 <= x < width and 0 <= y < height):
        raise smoke.Failure(f"클릭 위치가 화면 밖: {(x, y)} / {(width, height)}")
    # Optional, measured by the T010 native probe; ordinary harness behavior stays unchanged.
    sx, sy = getattr(d, "pointer_scale", (1, 1))
    perform(d, [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(round(x * sx)), "y": int(round(y * sy)), "origin": "viewport"},
        {"type": "pointerDown", "button": 0}, {"type": "pointerUp", "button": 0}]}])


def drag(d, start: tuple[float, float], end: tuple[float, float]) -> None:
    perform(d, [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(start[0]), "y": int(start[1]), "origin": "viewport"},
        {"type": "pointerDown", "button": 0},
        {"type": "pointerMove", "x": int((start[0] + end[0]) / 2), "y": int(start[1]), "origin": "viewport", "duration": 50},
        {"type": "pointerMove", "x": int(end[0]), "y": int(end[1]), "origin": "viewport", "duration": 50},
        {"type": "pointerUp", "button": 0}]}])


KEY = {"Left": "", "Right": "", "Up": "", "Down": "", "Home": "", "End": "",
       "Backspace": "", "Delete": "", "Enter": "", "Tab": "", "Shift": ""}


def press(d, *keys: str, shift: bool = False, pause: int = 0) -> None:
    if getattr(d, "native_key_tool", None):
        subprocess.run(["env","-u","LD_LIBRARY_PATH",d.native_key_tool,"key","--delay",str(pause or 20),
                        *[("shift+" if shift else "")+k for k in keys]],check=True,capture_output=True)
        time.sleep(0.15)
        return
    actions = []
    if shift:
        actions.append({"type": "keyDown", "value": KEY["Shift"]})
    for key in keys:
        value = KEY.get(key, key)
        actions += [{"type": "keyDown", "value": value}, {"type": "keyUp", "value": value}]
        if pause:
            actions.append({"type": "pause", "duration": pause})
    if shift:
        actions.append({"type": "keyUp", "value": KEY["Shift"]})
    perform(d, [{"type": "key", "id": "kbd", "actions": actions}])
    time.sleep(0.15)


def caret_client(d) -> list[float]:
    return d.js("const c=document.querySelector('[data-testid=rhwp-caret]'); if(!c) return null;"
                " const r=c.getBoundingClientRect(); return [r.left + r.width/2, r.top, r.height]")


def caret_key(d) -> str:
    return status(d).get("caret", "")


def offset_of(key: str) -> int:
    return int(key.split("@")[0].split(":")[2])


def press_button(d, css: str) -> None:
    """앱 버튼은 측정 대상이 아니므로 DOM click으로 누른다(WebKitWebDriver의 요소 클릭이 headless에서 멈추는 경우가 있음).
    편집 표면의 마우스·키보드 입력은 WebDriver 포인터·키 동작으로 보낸다."""
    if not d.js("const b=document.querySelector(arguments[0]); if(!b) return false; b.click(); return true", css):
        raise smoke.Failure(f"버튼 없음: {css}")


def ipc(d, command: str, args: dict | None = None):
    return d.js(smoke.INVOKE, command, args or {})


# ---- 시나리오 ----

def scenario_load_render(d, fixtures: Path, shots: Path | None) -> None:
    for name in ("basic-ko.hwp", "basic-ko.hwpx"):
        fmt = name.split(".")[-1]
        info = open_document(d, fixtures / name)
        time.sleep(0.3)
        require_test_hooks(d)
        st = status(d)
        pages = int(st.get("pages", "0"))
        first_paint = float(st.get("firstPaintMs") or "nan")
        check(f"{fmt}: 실제 rhwp 문서를 불러와 편집 가능 상태(ready)", info.get("status") == "ready" and pages >= 1, json.dumps(st, ensure_ascii=False))
        session = ipc(d, "document_sessions")["ok"]
        record = next(s for s in session if s["displayName"] == name)
        check(f"{fmt}: 백엔드 세션도 ready이고 revision 0", record["state"] == "ready" and record["revision"] == 0, json.dumps(record))
        check(f"{fmt}: 첫 페이지 그리기 시간 기록({first_paint:.0f} ms, 10쪽 이하 문서)", first_paint == first_paint and pages <= 10, str(first_paint))
        REPORT.setdefault(fmt, {})["firstPaintMs"] = first_paint
        REPORT[fmt]["pages"] = pages
        text = st.get("paragraphText", "")
        check(f"{fmt}: 첫 문단이 실제 문서 내용(한·영)", text.startswith("한글 문단입니다. Korean paragraph."), text)
        # 배율 100%·200%의 canvas 해상도(페이지 × 배율 × devicePixelRatio)와 화면 크기
        for zoom in (100, 200):
            set_zoom(d, zoom)
            time.sleep(0.4)
            dims = d.js("""const c=document.querySelector('.rhwp-page__canvas'); const r=c.getBoundingClientRect();
                return {w: c.width, h: c.height, cssW: r.width, cssH: r.height, dpr: window.devicePixelRatio}""")
            expected_w = dims["cssW"] * dims["dpr"]
            check(f"{fmt}: 배율 {zoom}%에서 canvas 비트맵이 화면 크기 × devicePixelRatio(선명도)",
                  abs(dims["w"] - expected_w) <= 2 and abs(dims["cssW"] - 793.7 * zoom / 100) <= 2, json.dumps(dims))
            REPORT[fmt][f"canvas{zoom}"] = dims
            if shots:
                # 화면 캡처 대신 그린 canvas 비트맵을 그대로 저장한다(200% 화면 캡처는 headless에서 멈추는 경우가 있음).
                data = d.js("return document.querySelector('.rhwp-page__canvas').toDataURL('image/png')")
                (shots / f"{fmt}-canvas-zoom{zoom}.png").write_bytes(__import__("base64").b64decode(data.split(",", 1)[1]))
        set_zoom(d, 100)


def set_zoom(d, target: int) -> None:
    for _ in range(40):
        current = int(d.js("return parseInt(document.querySelector('.statusbar__zoom-value').textContent)"))
        if current == target:
            return
        press_button(d, 'button[data-command="view.zoomIn"]' if current < target else 'button[data-command="view.zoomOut"]')
        time.sleep(0.05)
    raise smoke.Failure(f"배율 {target}%에 닿지 못함")


def boundaries(d, count: int) -> list[list[float]]:
    """커서를 오른쪽으로 한 글자씩 옮기며 각 경계의 화면 좌표를 모은다."""
    points = []
    for _ in range(count + 1):
        points.append(caret_client(d) + [offset_of(caret_key(d))])
        press(d, "Right")
    return points


def scenario_hit_test(d, fmt: str) -> None:
    # 첫 문단 처음(Home)에서 12글자 경계, 표 셀 0에서 4글자 경계
    deviations = []
    for label, setup, count in (("본문", lambda: (click_paragraph_start(d)), 12), ("표 셀", lambda: click_cell(d, 0), 4)):
        setup()
        start = caret_key(d)
        points = boundaries(d, count)
        for i in range(count):
            left, right = points[i], points[i + 1]
            if abs(right[1] - left[1]) > 1:  # 줄이 바뀌는 경계는 건너뜀
                continue
            y = left[1] + left[2] / 2
            for fraction, expected in ((0.3, left[3]), (0.7, right[3])):
                if os.environ.get("RHWP_POC_TRACE"):
                    print(f"  click {label} {i} {fraction} at {left[0] + (right[0] - left[0]) * fraction:.1f},{y:.1f}", flush=True)
                click(d, left[0] + (right[0] - left[0]) * fraction, y)
                time.sleep(0.05)
                got_key = caret_key(d)
                got = offset_of(got_key)
                same_context = got_key.split(":")[1] == start.split(":")[1] and ("@" in got_key) == ("@" in start)
                deviations.append({"where": label, "expected": expected, "got": got, "sameContext": same_context,
                                   "deviation": abs(got - expected) if same_context else 99})
        worst = max(d_["deviation"] for d_ in deviations if d_["where"] == label)
        check(f"{fmt}: {label} 클릭 hit test 편차 최대 {worst}글자(경계 사이 30%/70% 클릭 {sum(1 for x in deviations if x['where']==label)}회)",
              worst <= 1, json.dumps([x for x in deviations if x["where"] == label and x["deviation"]], ensure_ascii=False))
    REPORT[fmt]["hitTest"] = {"samples": len(deviations), "maxDeviation": max(x["deviation"] for x in deviations),
                              "exact": sum(1 for x in deviations if x["deviation"] == 0)}


def page_origin(d) -> list[float]:
    """첫 페이지 위쪽을 화면에 보이게 한 뒤 그 화면 좌표."""
    return d.js("""const p=document.querySelector('.rhwp-page'); const s=document.querySelector('.editor__scroll');
        s.scrollTop = 0; s.scrollLeft = 0; const r=p.getBoundingClientRect(); return [r.left, r.top]""")


def click_paragraph_start(d) -> None:
    # 첫 문단 글자 위를 클릭하고 Home
    press(d, "Home")
    origin = page_origin(d)
    click(d, origin[0] + 150, origin[1] + 139)
    time.sleep(0.1)
    press(d, "Home")


def click_cell(d, cell: int) -> None:
    if getattr(d, "engine_cell_probe", False):
        # Current engine geometry + actual DOM placement/zoom; only available in
        # the T010 instrumented native test. No fallback to a different text target.
        g = d.js("return window.__rhwpProbe.cell(0,2,0,arguments[0])", cell)
        if not g or not g.get("cellBounds"):
            raise smoke.Failure("목표 셀의 실제 경계가 없음")
        d.js("const s=document.querySelector('.editor__scroll'); s.scrollTop=0; s.scrollLeft=0")
        # T010 후속: 바로 앞 편집의 늦은 화면 변화(판·지연 글자는 SETTLE_MS 500 ms 뒤 바뀜)가 쪽을 몇 px 옮기면, 앞서 잰 자리를
        # 누른 클릭이 아래 행 셀에 들어갔다(실측 6.5 px, HEAD 동작 빌드에서도 6번 중 2번). 쪽 Canvas 사각형이 그 시간보다 길게
        # 그대로일 때 자리를 재고 바로 누른다.
        rect = "const c=document.querySelectorAll('.rhwp-page__canvas')[arguments[0]].getBoundingClientRect();return [c.left,c.top,c.width,c.height]"
        last, since, deadline = None, time.monotonic(), time.monotonic() + 10
        while time.monotonic() < deadline:
            now = d.js(rect, g["pageIndex"])
            if now != last:
                last, since = now, time.monotonic()
            elif time.monotonic() - since >= 0.7:
                break
            time.sleep(0.05)
        else:
            raise smoke.Failure("목표 셀 쪽의 화면 위치가 안정되지 않음")
        point = d.js("""const g=arguments[0], c=document.querySelectorAll('.rhwp-page__canvas')[g.pageIndex],r=c.getBoundingClientRect();
          return [r.left+(g.x+1)*r.width/g.page.width,r.top+(g.y+g.height/2)*r.height/g.page.height]""", g)
        click(d, *point)
    else:
        origin = page_origin(d)
        # Legacy T007 fixture harness; native T010 uses live geometry above.
        x = 130 if cell % 2 == 0 else 410
        y = 182 if cell < 2 else 199
        click(d, origin[0] + x, origin[1] + y)
    time.sleep(0.1)
    press(d, "Home")


def scenario_selection_keyboard(d, fmt: str) -> None:
    click_paragraph_start(d)
    left = caret_client(d)
    press(d, "Right", "Right", "Right")
    right = caret_client(d)
    press(d, "Home")
    drag(d, (left[0] + 1, left[1] + left[2] / 2), (right[0] + 1, right[1] + right[2] / 2))
    time.sleep(0.2)
    st = status(d)
    if os.environ.get("RHWP_POC_TRACE"):
        print(f"  drag {left} -> {right}: {st.get('selection')} caret={st.get('caret')}", flush=True)
    rects = d.js("return document.querySelectorAll('.rhwp-selection').length")
    check(f"{fmt}: 드래그로 선택 범위(3글자)와 선택 표시", st.get("selection", "").endswith(":3") and rects >= 1,
          f"{st.get('selection')} rects={rects}")

    base = status(d)["paragraphText"]
    rev0 = int(status(d)["localRevision"])
    press(d, "End")
    end = offset_of(caret_key(d))
    press(d, "Home")
    check(f"{fmt}: Home·End가 줄 처음·끝으로", offset_of(caret_key(d)) == 0 and end > 10, f"end={end}")
    press(d, "Right", "Right")
    press(d, "Right", "Right", shift=True)
    check(f"{fmt}: Shift+→로 선택 확장", status(d).get("selection", "").split("|")[-1].split(":")[2] == "4", status(d).get("selection", ""))
    press(d, "Backspace")
    after_bs = status(d)["paragraphText"]
    check(f"{fmt}: 선택 영역 Backspace는 선택한 2글자만 지움", after_bs == base[:2] + base[4:], after_bs)
    press(d, "Delete")
    check(f"{fmt}: Delete는 커서 뒤 1글자", status(d)["paragraphText"] == base[:2] + base[5:], status(d)["paragraphText"])
    press(d, "Enter")
    st = status(d)
    check(f"{fmt}: Enter는 문단을 나누고 커서를 새 문단 처음으로", st["caret"].split(":")[1] == "1" and offset_of(st["caret"]) == 0
          and st["paragraphText"] == base[5:], json.dumps(st, ensure_ascii=False))
    press(d, "Backspace")
    st = status(d)
    check(f"{fmt}: 문단 처음의 Backspace는 앞 문단과 합침", st["caret"].split(":")[1] == "0" and offset_of(st["caret"]) == 2
          and st["paragraphText"] == base[:2] + base[5:], json.dumps(st, ensure_ascii=False))
    press(d, "Down")
    down = caret_key(d)
    press(d, "Up")
    check(f"{fmt}: ↓·↑로 다른 줄로 이동하고 돌아옴", down.split(":")[1] != "0" or "@" in down, f"down={down} up={caret_key(d)}")
    # 표: 셀 0에서 Tab → 셀 1, Shift+Tab → 셀 0, 마지막 셀에서 Tab은 이동하지 않음
    click_cell(d, 0)
    c0 = caret_key(d)
    press(d, "Tab")
    c1 = caret_key(d)
    press(d, "Tab", shift=True)
    back = caret_key(d)
    click_cell(d, 3)
    press(d, "Tab")
    last = caret_key(d)
    check(f"{fmt}: 표에서 Tab·Shift+Tab으로 셀 이동, 마지막 셀에서는 그대로",
          c0.endswith("/0/0") and c1.endswith("/1/0") and back == c0.split(":")[0] + ":" + c0.split(":")[1] + ":0@" + c0.split("@")[1]
          and last.endswith("/3/0"), f"{c0} {c1} {back} {last}")
    press(d, "End")
    press(d, "a", "b")
    st = status(d)
    check(f"{fmt}: 표 셀 안 입력", st["paragraphText"].endswith("ab") and "@" in st["caret"], json.dumps(st, ensure_ascii=False))
    rev = int(st["localRevision"])
    # 지운 2글자(선택) + Delete + Enter + 합침 + 셀 입력 2글자 = 6번의 변경
    check(f"{fmt}: 문서를 바꾼 키만 revision을 올림(이동·선택·Tab 제외)", rev - rev0 == 6, f"{rev0}→{rev}")


def scenario_revision(d, fmt: str) -> None:
    st = status(d)
    time.sleep(0.5)
    sessions = ipc(d, "document_sessions")["ok"]
    active = next(s for s in sessions if s["displayName"] == f"basic-ko.{fmt}")
    check(f"{fmt}: 백엔드 revision이 편집 세션의 변경 수와 같고 dirty", active["revision"] == int(status(d)["localRevision"]) and active["dirty"],
          json.dumps(active))
    sid, rev, gen = active["sessionId"], active["revision"], active["loadGeneration"]
    stale = ipc(d, "document_commit", {"sessionId": sid, "loadGeneration": gen, "baseRevision": max(0, rev - 1), "count": 1})
    dup = ipc(d, "document_commit", {"sessionId": sid, "loadGeneration": gen, "baseRevision": rev + 3, "count": 1})
    check(f"{fmt}: 옛·앞선 기준 revision의 확정은 RevisionMismatch로 거부되고 기록은 그대로",
          stale == {"err": {"code": "RevisionMismatch", "sessionId": sid, "revision": rev}} and dup == stale
          and ipc(d, "document_session", {"sessionId": sid})["ok"]["revision"] == rev, json.dumps([stale, dup]))
    old_attempt = ipc(d, "document_commit", {"sessionId": sid, "loadGeneration": gen - 1, "baseRevision": rev, "count": 1})
    old_transition = ipc(d, "document_set_state", {"sessionId": sid, "loadGeneration": gen - 1, "from": "ready", "to": "failed"})
    after = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check(f"{fmt}: 다른 불러오기 시도 번호의 확정·상태 전이는 StaleLoad로 거부되고 기록은 그대로",
          old_attempt == {"err": {"code": "StaleLoad", "sessionId": sid, "loadGeneration": gen}} and old_transition == old_attempt
          and after["revision"] == rev and after["state"] == "ready", json.dumps([old_attempt, old_transition, after]))
    REPORT[fmt]["revisionBeforeExternal"] = rev
    _ = st


def scenario_roundtrip_ui(d, fmt: str) -> None:
    press_button(d, "[data-testid=rhwp-roundtrip]")
    smoke.wait_until(d, "return document.querySelector('[data-testid=rhwp-roundtrip-result]') !== null", timeout=30)
    r = d.js("return {...document.querySelector('[data-testid=rhwp-roundtrip-result]').dataset}")
    check(f"{fmt}: 편집한 문서를 메모리에서 원본 형식으로 내보내고 다시 열어 형식({fmt}, 엔진 판별·컨테이너 서명)·쪽·텍스트·컨트롤 일치, "
          "손실 보고가 올바른 모양이고 0건(통과)",
          r.get("format") == fmt and r.get("passed") == "true" and r.get("lossValid") == "true" and r.get("lossCount") == "0"
          and r.get("reopenedFormat") == fmt and r.get("formatEqual") == "true"
          and r.get("pagesEqual") == "true" and r.get("textEqual") == "true" and r.get("controlsEqual") == "true",
          json.dumps(r))
    REPORT[fmt]["roundTripInApp"] = r
    # 검사한 뒤 문서를 바꾸면 이전 통과 결과를 보이지 않는다
    click_paragraph_start(d)
    press(d, "End")
    press(d, "r")
    check(f"{fmt}: 내보내기 검사 뒤 문서를 바꾸면 이전 통과 결과가 사라짐",
          not d.exists("[data-testid=rhwp-roundtrip-result]"), json.dumps(status(d), ensure_ascii=False))


def scenario_latency(d, fmt: str) -> None:
    click_paragraph_start(d)
    press(d, "End")
    before = int(status(d).get("latencyCount") or 0)
    # 한 번에 한 키씩(사람 입력 간격보다 빠른 80 ms) ASCII 40자 + 한글 음절 40자(조합 없이 확정 문자 입력)
    for chunk in ["abcdefghij" * 4, "가나다라마바사아자차" * 4]:
        for ch in chunk:
            press(d, ch)
    st = status(d)
    count = int(st["latencyCount"]) - before
    p95 = float(st["latencyP95"])
    REPORT[fmt]["latency"] = {"samples": int(st["latencyCount"]), "p95": p95, "max": float(st["latencyMax"])}
    check(f"{fmt}: 키 입력→화면 반영 p95 {p95:.1f} ms(표본 {st['latencyCount']}, 개발 빌드) ≤ 150 ms", count >= 70 and p95 <= 150,
          json.dumps(REPORT[fmt]["latency"]))


def scenario_sessions(d, fixtures: Path, scratch: Path) -> None:
    # 두 문서: HWP에서 편집한 확정이 끝나기 전에 HWPX 탭으로 바꿔도 각 세션 revision은 따로
    tabs = lambda: d.js("return [...document.querySelectorAll('.document-tab__select')].map(t => [t.textContent, t.getAttribute('aria-selected')])")
    hwp_tab = '.document-tab__select[data-session]'
    sessions = {s["displayName"]: s for s in ipc(d, "document_sessions")["ok"]}
    hwp, hwpx = sessions["basic-ko.hwp"], sessions["basic-ko.hwpx"]
    d.js("[...document.querySelectorAll(arguments[0])].find(t=>t.textContent.includes('basic-ko.hwp') && !t.textContent.includes('hwpx')).click()", hwp_tab)
    wait_status(d, "ready")
    click_paragraph_start(d)
    press(d, "x", "y", "z")
    d.js("[...document.querySelectorAll(arguments[0])].find(t=>t.textContent.includes('basic-ko.hwpx')).click()", hwp_tab)
    time.sleep(0.6)
    after = {s["displayName"]: s for s in ipc(d, "document_sessions")["ok"]}
    check("활성 탭을 바꾸는 동안 끝난 HWP 확정은 HWP 세션에만 반영되고 HWPX revision은 그대로",
          after["basic-ko.hwp"]["revision"] == hwp["revision"] + 3 and after["basic-ko.hwpx"]["revision"] == hwpx["revision"]
          and status(d)["revision"] == str(hwpx["revision"]), json.dumps({k: v["revision"] for k, v in after.items()}))
    # 다른 쓰는 쪽이 확정하면(같은 기준) 편집기의 다음 확정이 어긋나 조용히 이어 가지 않고 failed
    sid = after["basic-ko.hwpx"]["sessionId"]
    external = ipc(d, "document_commit", {"sessionId": sid, "loadGeneration": after["basic-ko.hwpx"]["loadGeneration"],
                                          "baseRevision": after["basic-ko.hwpx"]["revision"], "count": 1})
    click_paragraph_start(d)
    press(d, "q")
    time.sleep(0.6)
    st = status(d)
    backend = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check("다른 쓰는 쪽의 확정 뒤 편집기의 확정은 RevisionMismatch → 편집 중지(failed), 백엔드도 failed",
          "ok" in external and st["status"] == "failed" and backend["state"] == "failed", json.dumps([external, st.get("status"), backend]))
    check("편집한 뒤 실패한 문서는 저장되지 않았고 복구가 없다고 알림",
          d.exists("[data-testid=rhwp-unpreserved-warning]"), json.dumps(st, ensure_ascii=False))
    # 다시 불러오기: 편집한 모델을 버리는 것이므로 확인을 거친다. 취소하면 아무것도 바뀌지 않는다.
    press_button(d, "[data-testid=rhwp-load]")
    smoke.wait_until(d, "return document.querySelector('[data-testid=discard-dialog]')?.dataset.action === 'reload'", timeout=10)
    d.js("document.querySelector('[data-testid=discard-dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
    time.sleep(0.3)
    kept = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check("다시 불러오기 확인을 취소(Escape)하면 창이 닫히고 세션·모델 그대로(failed)",
          not d.exists("[data-testid=discard-dialog]") and status(d)["status"] == "failed" and kept["state"] == "failed", json.dumps(kept))
    press_button(d, "[data-testid=rhwp-load]")
    confirm_discard(d, "reload")
    st = wait_status(d, "ready")
    backend = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check("failed에서 다시 불러오면 ready, revision 유지·dirty 아님(편집은 버려짐)",
          backend["state"] == "ready" and backend["revision"] == after["basic-ko.hwpx"]["revision"] + 1 and not backend["dirty"]
          and st["paragraphText"].startswith("한글 문단입니다."), json.dumps(backend))

    # 확정을 기다리는 동안 닫기: 확인 없이 버리지 않고, 버리기를 고르면 닫으며 늦은 응답이 세션을 되살리지 않음
    click_paragraph_start(d)
    modified = d.js("""const input=document.querySelector('.rhwp-input'); input.value='Z';
            input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Z',inputType:'insertText'}));
            const tab=[...document.querySelectorAll('.document-tab')].find(t=>t.textContent.includes('basic-ko.hwpx'));
            const marked = tab.querySelector('.document-tab__select').dataset.modified;
            tab.querySelector('.document-tab__close').click(); return marked;""")
    confirm_discard(d, "close")
    time.sleep(0.8)
    remaining = [s["displayName"] for s in ipc(d, "document_sessions")["ok"]]
    stale = ipc(d, "document_session", {"sessionId": sid})
    check("편집 직후(확정 대기 중) 닫기는 수정 표시·버리기 확인을 거치고, 닫은 세션은 다시 나타나지 않음(StaleSession)",
          modified == "true" and "basic-ko.hwpx" not in remaining and stale == {"err": {"code": "StaleSession", "sessionId": sid}},
          json.dumps([modified, remaining, stale]))

    # 엔진이 읽지 못하는 문서: header.xml이 XML로 깨졌지만 CRC는 맞아 판별(T006)은 통과하고 rhwp가 실패 → failed,
    # 닫고 정상 문서를 열 수 있음. (참고: section0.xml이 깨진 HWPX는 rhwp가 빈 문서로 열어 버린다 — 보고서 참고)
    broken = scratch / "engine-broken.hwpx"
    broken.write_bytes(smoke.with_entry(smoke.make_hwpx(), "Contents/header.xml",
                                        b'<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"><broken'))
    st = open_document(d, broken, expected="failed")
    check("판별은 통과했지만 엔진이 읽지 못한 문서는 가짜 문서 없이 failed(EngineFailure)",
          st["status"] == "failed" and d.exists("[data-testid=rhwp-error]") and not d.exists(".rhwp-page"), json.dumps(st, ensure_ascii=False))
    d.js("[...document.querySelectorAll('.document-tab')].find(t=>t.textContent.includes('engine-broken')).querySelector('.document-tab__close').click()")
    time.sleep(0.4)

    # 엔진은 읽지만 페이지 정보가 그릴 수 없는 값인 문서: 용지 너비를 1 HWPUNIT으로 바꾸면 rhwp getPageInfo의 width가 0이다.
    # 너비 0인 쪽으로 ready가 되지 않고 failed여야 한다(페이지 정보 검사, render 단계).
    import io
    import re
    import zipfile
    source = (fixtures / "basic-ko.hwpx").read_bytes()
    section = zipfile.ZipFile(io.BytesIO(source)).read("Contents/section0.xml").decode()
    narrow_section = re.sub(r'(<hp:pagePr[^>]*?\bwidth=")\d+(")', r"\g<1>1\2", section, count=1)
    narrow = scratch / "zero-width.hwpx"
    narrow.write_bytes(smoke.with_entry(source, "Contents/section0.xml", narrow_section.encode()))
    st = open_document(d, narrow, expected="failed")
    check("엔진은 읽었지만 페이지 너비가 0인 문서(용지 너비 1 HWPUNIT)는 편집 가능(ready)이 아니라 failed",
          narrow_section != section and st["status"] == "failed" and not d.exists(".rhwp-page")
          and [x["state"] for x in ipc(d, "document_sessions")["ok"] if x["displayName"] == "zero-width.hwpx"] == ["failed"],
          json.dumps(st, ensure_ascii=False))
    d.js("[...document.querySelectorAll('.document-tab')].find(t=>t.textContent.includes('zero-width')).querySelector('.document-tab__close').click()")
    time.sleep(0.4)
    reopened = open_document(d, fixtures / "basic-ko.hwpx")
    check("실패한 문서를 닫은 뒤 정상 문서를 다시 열어 편집 가능", reopened["status"] == "ready", json.dumps(reopened))

    # 판별 뒤 바뀐 파일: WebView를 다시 시작하면(모델 없음) failed, 파일이 바뀐 상태에서 다시 불러오면 FileChanged
    changed = scratch / "changed.hwp"
    shutil.copy(fixtures / "basic-ko.hwp", changed)
    open_document(d, changed)
    d.js("location.reload()")
    smoke.wait_until(d, "return document.querySelector('.document-bar') !== null", timeout=30)
    time.sleep(1)
    listed = {s["displayName"]: s for s in ipc(d, "document_sessions")["ok"]}
    check("WebView를 다시 시작하면 백엔드에 남은 ready 세션을 failed로 돌림(모델이 없는 세션을 편집 가능으로 보이지 않음)",
          all(s["state"] in ("failed", "identified") for s in listed.values()) and "changed.hwp" in listed, json.dumps(listed))
    d.js("[...document.querySelectorAll('.document-tab__select')].find(t=>t.textContent.includes('changed.hwp')).click()")
    with open(changed, "ab") as handle:
        handle.write(b"\0")
    press_button(d, "[data-testid=rhwp-load]")
    time.sleep(1)
    st = status(d)
    check("판별한 뒤 바뀐 파일은 다시 불러올 때 FileChanged로 거부(검사하지 않은 바이트를 엔진에 넣지 않음)",
          st["status"] == "failed" and "판별한 뒤 파일이 바뀌었습니다" in d.js("return document.querySelector('[data-testid=rhwp-error]').textContent"),
          json.dumps(st, ensure_ascii=False))
    _ = tabs


def scenario_reopen_exported(d, exported: dict) -> None:
    for fmt in ("hwp", "hwpx"):
        path = Path(exported[fmt]["file"])
        st = open_document(d, path)
        text_ok = d.js("return document.querySelector('[data-testid=rhwp-status]').dataset.paragraphText").endswith("한글 입력 테스트")
        check(f"{fmt}: 편집해 내보낸 파일(손실 보고 올바름·0건, 다시 열어 같음)을 앱에서 다시 열면 판별·불러오기 성공, 넣은 글자 유지",
              st["status"] == "ready" and text_ok and exported[fmt]["passed"], json.dumps(st, ensure_ascii=False))


SAVE_RESULT = "[data-testid=rhwp-save-result]"


def save_and_wait(d, timeout: float = 60) -> dict:
    """저장 단추를 누르고 결과(saved·failed)가 나올 때까지 기다린다."""
    press_button(d, "[data-testid=rhwp-save]")
    smoke.wait_until(d, f"const e=document.querySelector('{SAVE_RESULT}'); return e && ['saved','failed'].includes(e.dataset.state)",
                     timeout=timeout)
    return d.js(f"return {{...document.querySelector('{SAVE_RESULT}').dataset}}")


def type_ascii(d, text: str) -> dict:
    """ASCII 글자를 실제 키로 치고, 확정(로컬 판 = 백엔드 판)까지 기다린다."""
    before = int(status(d)["revision"])
    actions = []
    for ch in text:
        actions += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
    if getattr(d, "native_key_tool", None):
        subprocess.run(["env","-u","LD_LIBRARY_PATH",d.native_key_tool,"type","--delay","20",text],check=True,capture_output=True)
    else:
        perform(d, [{"type": "key", "id": "kbd", "actions": actions}])
    smoke.wait_until(d, f"const e=document.querySelector('{STATUS}'); return e && Number(e.dataset.revision) >= arguments[0]"
                     " && e.dataset.revision === e.dataset.localRevision", before + len(text), timeout=20)
    return status(d)


def close_tab(d, name: str) -> bool:
    """탭을 닫는다. 버리기 확인 창이 뜨면 False(취소하고 남김)."""
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", name)
    time.sleep(0.5)
    if d.exists("[data-testid=discard-dialog]"):
        press_button(d, "[data-testid=discard-cancel]")
        return False
    smoke.wait_until(d, "return ![...document.querySelectorAll('.document-tab__select')].some(t => t.textContent.includes(arguments[0]))",
                     name, timeout=10)
    return True


def rezip(source: Path, target: Path, change) -> None:
    """HWPX 항목 순서·압축 방식을 지키며 다시 쓴다(시험용 결정적 변형)."""
    import zipfile
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(target, "w") as zout:
        for item in zin.infolist():
            zout.writestr(item, change(item.filename, zin.read(item.filename)))


def scenario_save(d, fixtures: Path, scratch: Path) -> None:
    """T009: 실제 앱에서 원본 형식 저장 → 파일 → 다시 열기, 막힌 저장·외부 수정은 원본 그대로."""
    import hashlib
    import zipfile
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    # HWP: 픽스처 PrvText에는 편집 전 본문 글자가 있고 고정 rhwp는 그것을 그대로 내보낸다(T009 안정화 F). 편집한 저장은
    # 편집 전 글자를 파일에 남기므로 막고(previewStale) 원본·편집을 그대로 둔다.
    path = scratch / "save-preview.hwp"
    shutil.copy(fixtures / "basic-ko.hwp", path)
    original = digest(path)
    open_document(d, path)
    click_paragraph_start(d)
    type_ascii(d, "T9")
    result = save_and_wait(d)
    after = status(d)
    shown = d.js(f"return document.querySelector('{SAVE_RESULT}').textContent")
    check("hwp: 편집 전 글자가 남는 미리보기(PrvText)가 있으면 저장하지 않고(unsafe previewStale) 이유를 보이며 원본·편집 그대로",
          result["state"] == "failed" and result["error"] == "UnsafeSave" and result["outcome"] == "unsafe"
          and "previewStale:PrvText" in result["findings"].split(",") and digest(path) == original
          and after["dirty"] == "true" and after["unpreserved"] == "true" and d.exists("[data-testid=save-findings]"),
          json.dumps({"result": result, "dirty": after.get("dirty"), "shown": shown[:120]}, ensure_ascii=False))
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", path.name)
    confirm_discard(d, "close")
    for fmt in ("hwpx",):
        path = scratch / f"save-{fmt}.{fmt}"
        shutil.copy(fixtures / f"basic-ko.{fmt}", path)
        original = digest(path)
        open_document(d, path)
        click_paragraph_start(d)
        typed = type_ascii(d, "T9")
        check(f"{fmt}: 편집 뒤 저장 전에는 파일이 그대로이고 저장하지 않은 편집으로 보임",
              digest(path) == original and typed["dirty"] == "true" and typed["unpreserved"] == "true", json.dumps(typed, ensure_ascii=False)[:300])
        result = save_and_wait(d)
        after = status(d)
        valid = zipfile.is_zipfile(path)
        with zipfile.ZipFile(path) as z:
            first = z.infolist()[0]
            valid = valid and first.filename == "mimetype" and first.compress_type == zipfile.ZIP_STORED and z.testzip() is None
        check(f"{fmt}: 사전 검사(편집 없는 왕복 safe)를 거쳐 원본 형식으로 저장하고 dirty가 풀림(파일이 바뀌고 컨테이너가 올바름)",
              result["state"] == "saved" and result["revision"] == after["revision"] and after["dirty"] == "false"
              and after["unpreserved"] == "false" and digest(path) != original and valid,
              json.dumps({"result": result, "status": {k: after.get(k) for k in ("revision", "dirty", "unpreserved")}}, ensure_ascii=False))
        check(f"{fmt}: 저장한 문서는 버리기 확인 없이 닫힘", close_tab(d, path.name))
        reopened = open_document(d, path)
        click_paragraph_start(d)
        text = status(d)["paragraphText"]
        check(f"{fmt}: 저장한 파일을 앱에서 다시 열면 넣은 글자가 있고 편집 가능", reopened["status"] == "ready" and text.startswith("T9"),
              json.dumps({"status": reopened.get("status"), "start": text[:12]}, ensure_ascii=False))
        # 외부 수정: 연 뒤 다른 프로그램이 파일을 바꾸면 덮어쓰지 않는다.
        type_ascii(d, "X")
        changed = path.read_bytes() + b"\0"
        path.write_bytes(changed)
        result = save_and_wait(d)
        check(f"{fmt}: 연 뒤 파일이 바뀌면(외부 수정) FileConflict로 저장하지 않고 바뀐 파일을 덮어쓰지 않음",
              result["state"] == "failed" and result["error"] == "FileConflict" and path.read_bytes() == changed, json.dumps(result))
        d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", path.name)
        confirm_discard(d, "close")
    # HWPX 음성 사례: rhwp가 열지만 왕복이 원본을 지키지 못하는 문서는 막고 원본 그대로.
    cases = [
        ("본문 XML이 잘림(rhwp는 거의 빈 문서로 엶)", "cut", lambda n, b: b[: len(b) * 2 // 3] if n == "Contents/section0.xml" else b,
         "unknown", "originalMalformed:Contents/section0.xml"),
        ("rhwp가 모르는 요소가 있음", "unknown-element",
         lambda n, b: b.replace(b"</hs:sec>", b'<hp:unknownGeulTest xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"/></hs:sec>')
         if n == "Contents/section0.xml" else b, "unsafe", "partChanged:Contents/section0.xml"),
    ]
    for label, name, change, outcome, finding in cases:
        path = scratch / f"save-{name}.hwpx"
        rezip(fixtures / "basic-ko.hwpx", path, change)
        before = path.read_bytes()
        st = open_document(d, path)
        # 편집 없이 저장해도 사전 검사가 막아야 한다(잘린 문서는 rhwp가 거의 빈 문서로 열어 칠 자리가 없을 수 있다).
        result = save_and_wait(d)
        check(f"hwpx: {label} → 저장하지 않고({outcome}) 이유를 보이며 원본 그대로",
              st["status"] == "ready" and result["state"] == "failed" and result["error"] == "UnsafeSave" and result["outcome"] == outcome
              and finding in result["findings"].split(",") and path.read_bytes() == before
              and d.exists("[data-testid=save-findings]"), json.dumps(result, ensure_ascii=False))
        close_tab(d, path.name)
    leftovers = [p.name for p in scratch.iterdir() if p.name.startswith(".geul-save-")]
    check("저장 시도 뒤 임시 파일(.geul-save-*.tmp)이 남지 않음", leftovers == [], json.dumps(leftovers))


CTRL = "\ue009"


def chord(d, key: str) -> None:
    perform(d, [{"type": "key", "id": "kbd", "actions": [{"type": "keyDown", "value": CTRL}, {"type": "keyDown", "value": key},
                                                          {"type": "keyUp", "value": key}, {"type": "keyUp", "value": CTRL}]}])


def command_button(d, command: str) -> dict:
    """명령 단추(리본·빠른 실행)의 상태. 같은 명령의 단추가 여럿이면 모두 같은 상태여야 한다."""
    states = d.js("return [...document.querySelectorAll('[data-command=\"' + arguments[0] + '\"]')]"
                  ".map(b => ({disabled: b.getAttribute('aria-disabled') === 'true', pressed: b.getAttribute('aria-pressed'), title: b.title}))",
                  command)
    if not states or any(state != states[0] for state in states):
        raise smoke.Failure(f"명령 단추 상태 없음·불일치: {command} {states}")
    return states[0]


def scenario_commands(d, fixtures: Path, scratch: Path) -> None:
    """T010: rhwp 문서에서 엔진이 지원하지 않는 명령(실행 취소·서식)은 실제 키·단추로도 아무것도 바꾸지 않고 이유를 알리며,
    저장 단축키는 기존 저장 절차를 부른다."""
    import hashlib
    path = scratch / "commands.hwpx"
    shutil.copy(fixtures / "basic-ko.hwpx", path)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    open_document(d, path)
    click_paragraph_start(d)
    before = type_ascii(d, "Q")
    unsupported = ("edit.undo", "edit.redo", "format.bold", "format.italic", "format.underline", "format.strikethrough")
    states = {command: command_button(d, command) for command in unsupported}
    check("rhwp 명령: 실행 취소·다시 실행·서식 단추는 이 형식에서 지원하지 않음으로 보이고(설명에 이유) 저장은 쓸 수 있음",
          all(state["disabled"] and "이 문서 형식에서 지원하지 않음" in state["title"] for state in states.values())
          and not command_button(d, "file.save")["disabled"], json.dumps(states, ensure_ascii=False)[:600])
    d.js("document.querySelector('.rhwp-input').focus()")
    d.js("const m=document.querySelector('.statusbar__message'); if (m) m.dataset.before = m.textContent")
    for key in ("z", "y", "b", "i", "u"):
        chord(d, key)
    time.sleep(0.8)
    after = status(d)
    message = d.js("return document.querySelector('.statusbar__message')?.textContent ?? ''")
    keep = ("revision", "localRevision", "paragraphText", "caret", "dirty")
    check("rhwp 명령: Ctrl+Z·Ctrl+Y·Ctrl+B·Ctrl+I·Ctrl+U는 모델·revision을 바꾸지 않고(가짜 성공 없음) 이유를 알림",
          all(after.get(k) == before.get(k) for k in keep) and "이 문서 형식에서는 지원하지 않습니다" in message,
          json.dumps({"before": {k: before.get(k) for k in keep}, "after": {k: after.get(k) for k in keep}, "message": message},
                     ensure_ascii=False)[:600])
    press_button(d, '[data-command="format.bold"]')
    time.sleep(0.3)
    clicked = status(d)
    check("rhwp 명령: 리본의 굵게 단추를 눌러도 모델·revision이 그대로", all(clicked.get(k) == before.get(k) for k in keep))
    d.js("document.querySelector('.rhwp-input').focus()")
    chord(d, "s")
    smoke.wait_until(d, f"const e=document.querySelector('{SAVE_RESULT}'); return e && ['saved','failed'].includes(e.dataset.state)", timeout=60)
    result = d.js(f"return {{...document.querySelector('{SAVE_RESULT}').dataset}}")
    saved = status(d)
    check("rhwp 명령: Ctrl+S → 기존 저장 절차(사전 검사·검사·교체)로 저장하고 dirty가 풀림",
          result["state"] == "saved" and saved["dirty"] == "false" and hashlib.sha256(path.read_bytes()).hexdigest() != original,
          json.dumps(result, ensure_ascii=False))
    check("rhwp 명령: 저장한 문서는 버리기 확인 없이 닫힘", close_tab(d, path.name))


# ---- 실제 한국어 IME 게이트 ----

# (이름, 필수 여부). 필수 항목이 모두 PASS여야 IME 게이트 통과다.
IME_ITEMS = [
    ("조합 중 글자가 문서에 보임(preedit)", True),
    ("조합 중 커서가 조합 글자 뒤에 있음", True),
    ("확정 글자가 커서 위치에 정확히 한 번, 음절 누락 없음", True),
    ("확정 음절·공백마다 revision 1(조합 중간은 확정 안 함)", True),
    ("같은 음절을 연달아 확정해도 모두 남음", True),
    ("조합 중 ←는 조합 글자를 그 자리에 확정한 뒤 이동", True),
    ("조합 중 클릭: 조합 글자를 원래 자리에 한 번 확정하고 커서는 클릭한 곳", True),
    ("조합 중 창 초점 이동 뒤 돌아옴", False),
    ("조합 중 탭 전환: 조합은 원래 문서에 한 번, 다른 문서에 섞이지 않음", False),
]
GATE: dict[str, tuple[str, str]] = {}


def gate(name: str, result: str, detail: str = "") -> None:
    assert name in dict(IME_ITEMS) and result in ("PASS", "FAIL", "UNVERIFIED", "NOT RUN")
    GATE[name] = (result, detail)
    print(f"[{result}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def ime_environment(xdotool: str, ibus: str) -> str | None:
    """실제 IME 입력을 보낼 수 있는지. 안 되면 이유(→ UNVERIFIED)."""
    if not os.environ.get("DISPLAY"):
        return "X11 DISPLAY 없음(xdotool 실제 키 입력 불가)"
    if os.environ.get("GTK_IM_MODULE") != "ibus":
        return "GTK_IM_MODULE=ibus가 아님(앱이 ibus 입력기를 쓰지 않음)"
    for tool in (xdotool, ibus):
        if not (Path(tool).exists() or shutil.which(tool)):
            return f"{Path(tool).name} 없음"
    return None


EVENT_LOG = """window.__imeLog=[]; const i=document.querySelector('.rhwp-input');
  for (const t of ['keydown','compositionstart','compositionupdate','compositionend','input','blur','focus'])
    i.addEventListener(t, e => window.__imeLog.push([t, e.isComposing ?? null, e.inputType ?? null, (e.data ?? '').length]), true);"""


def settle(d, step: str, quiet: float = 0.7, timeout: float = 30.0) -> dict:
    """실제 키·클릭을 페이지가 모두 처리할 때까지 기다린다: 입력 이벤트 기록·편집 상태(문단·커서·조합·revision)가 quiet초
    동안 바뀌지 않으면 끝. 고정 대기는 느린 환경(소프트웨어 렌더링·CPU 경합)에서 처리 전 상태를 읽어 결과를 잘못 판정했다.
    timeout 안에 끝나지 않으면 실패다. 마지막 변화까지 걸린 시간(입력을 보낸 뒤 페이지가 따라잡는 데 걸린 시간)은 지연
    증거로 보고서 imeDrain에 남긴다(판정 기준을 바꾸지 않음). 한계: 입력기에 남은 이벤트가 없다는 증거는 아니다(플랫폼이
    조합 트랜잭션 번호를 주지 않음). 그래서 늦은 이벤트가 나중에 드러나는지는 다음 입력 뒤의 상태로 따로 확인한다(조합 중 클릭)."""
    start = time.monotonic()
    last, changed = None, start
    while True:
        now = time.monotonic()
        current = d.js("const e=document.querySelector('[data-testid=rhwp-status]'); const s=e ? e.dataset : {};"
                       " return [(window.__imeLog || []).length, s.paragraphText, s.caret, s.composing, s.localRevision]")
        if current != last:
            last, changed = current, now
        elif now - changed >= quiet:
            break
        if now - start > timeout:
            raise smoke.Failure(f"입력 처리가 {timeout:.0f}초 안에 끝나지 않음({step})")
        time.sleep(0.05)
    REPORT.setdefault("imeDrain", []).append({"step": step, "seconds": round(changed - start, 2)})
    return status(d)


def ime_counts(log: list) -> dict:
    """이벤트 종류별 개수(글자 내용은 남기지 않음)."""
    counts: dict[str, int] = {}
    for event in log:
        key = event[0] + ("(composing)" if event[0] == "input" and event[1] else "")
        counts[key] = counts.get(key, 0) + 1
    return counts


def probe_plain_textarea(d, run, xdotool: str, window: str) -> dict:
    """화면에 보이는 일반 textarea(앱의 숨긴 입력 설정과 무관)에서 같은 키로 조합 이벤트가 오는지 본다(원인 분리용)."""
    d.js("""const p=document.createElement('textarea'); p.id='ime-probe';
        p.style.cssText='position:fixed;left:20px;top:20px;width:240px;height:48px;z-index:9999;opacity:1;font-size:16px';
        document.body.append(p); window.__probe=[];
        for (const t of ['compositionstart','compositionupdate','compositionend','input'])
          p.addEventListener(t, e => window.__probe.push([t, e.isComposing ?? null, (e.data ?? '').length]), true);
        p.focus();""")
    time.sleep(0.3)
    run(xdotool, "type", "--window", window, "--delay", "120", "gk")
    time.sleep(0.6)
    during = d.js("const p=document.getElementById('ime-probe'); return {valueLength: [...p.value].length, log: window.__probe.slice()}")
    run(xdotool, "key", "--window", window, "space")
    time.sleep(0.5)
    after = d.js("const p=document.getElementById('ime-probe'); const r={valueLength: [...p.value].length, log: window.__probe.slice()};"
                 " p.remove(); return r")
    return {"duringComposition": {"valueLength": during["valueLength"], "events": ime_counts(during["log"])},
            "afterCommit": {"valueLength": after["valueLength"], "events": ime_counts(after["log"])}}


def scenario_ime(d, fixtures: Path, xdotool: str, ibus: str, focus_window: str | None = None,
                 shots: Path | None = None) -> None:
    reason = ime_environment(xdotool, ibus)
    if reason:
        for name, _ in IME_ITEMS:
            gate(name, "UNVERIFIED", reason)
        return
    run = lambda *a: subprocess.run(["env", "-u", "LD_LIBRARY_PATH", *a], capture_output=True, text=True)
    REPORT["imeEnvironment"] = {
        "ibusEngine": run(ibus, "engine").stdout.strip(),
        "ibusVersion": run(ibus, "version").stdout.strip(),
        "embedPreeditText": run("gsettings", "get", "org.freedesktop.ibus.general", "embed-preedit-text").stdout.strip() or "unknown",
        "ibusSyncMode": os.environ.get("IBUS_ENABLE_SYNC_MODE", "unset"),
    }
    results: dict[str, list[tuple[str, str]]] = {name: [] for name, _ in IME_ITEMS}

    def record(name: str, ok: bool, detail: str) -> None:
        results[name].append(("PASS" if ok else "FAIL", detail))

    for name in ("basic-ko.hwp", "basic-ko.hwpx"):
        fmt = name.split(".")[-1]
        open_document(d, fixtures / name)
        require_test_hooks(d)
        # 같은 이름의 X 창이 여럿이다(보이지 않는 창도 있음). 초점을 줄 수 있는 보이는 창을 고른다.
        window = run(xdotool, "search", "--onlyvisible", "--name", "^geul").stdout.split()[-1]
        run(xdotool, "windowfocus", "--sync", window)
        run(ibus, "engine", "hangul")
        if fmt == "hwp":
            REPORT["imePlainTextareaProbe"] = probe_plain_textarea(d, run, xdotool, window)
        d.js(EVENT_LOG)
        top = d.js("return window.outerHeight - window.innerHeight")
        origin = page_origin(d)
        # 첫 문단 글자 끝 오른쪽 빈 곳 → 첫 문단 끝. 이 클릭의 mousedown 위치로 창 좌표↔페이지 좌표 차이를 잰다.
        d.js("window.__down=null; window.addEventListener('mousedown', e => { window.__down=[e.clientX, e.clientY]; }, true)")
        first = (int(origin[0] + 600), int(origin[1] + 139 + top))
        run(xdotool, "mousemove", "--window", window, str(first[0]), str(first[1]), "click", "1")
        time.sleep(0.4)
        down = d.js("return window.__down")
        shift = (first[0] - down[0], first[1] - down[1]) if down else (0, top)
        before = status(d)
        base_text, base_rev = before["paragraphText"], int(before["localRevision"])

        # 1) 조합 중 표시: 'ㅎ+ㅏ'만 누르고(확정 안 함) 문서·커서를 본다
        run(xdotool, "type", "--delay", "90", "gk")
        mid = settle(d, f"{fmt}: ㅎㅏ")
        if shots:  # 조합 중(확정 전) 화면: 문서 안의 조합 글자·밑줄·커서
            d.screenshot(shots / f"{fmt}-ime-preedit.png")
        visible = mid["paragraphText"] == base_text + "하"
        record("조합 중 글자가 문서에 보임(preedit)", visible and mid.get("composing") == "true",
               f"{fmt}: composing={mid.get('composing')}, 문단 글자 수 {len(base_text)}→{len(mid['paragraphText'])}")
        record("조합 중 커서가 조합 글자 뒤에 있음", visible and offset_of(mid["caret"]) == len(base_text) + 1,
               f"{fmt}: caret={mid['caret']}, 기대 오프셋 {len(base_text) + 1}")

        # 2) 이어서 입력해 '한글 입력 테스트'를 확정
        run(xdotool, "type", "--delay", "90", "srmf dlqfur xptmxm")
        run(xdotool, "key", "End")
        after = settle(d, f"{fmt}: 한글 입력 테스트")
        record("확정 글자가 커서 위치에 정확히 한 번, 음절 누락 없음", after["paragraphText"] == base_text + "한글 입력 테스트",
               f"{fmt}: 넣은 부분 {after['paragraphText'][len(base_text):]!r}")
        record("확정 음절·공백마다 revision 1(조합 중간은 확정 안 함)", int(after["localRevision"]) - base_rev == 9,
               f"{fmt}: {base_rev}→{after['localRevision']}")
        REPORT.setdefault(fmt, {})["ime"] = {"events": ime_counts(d.js("return window.__imeLog"))}

        # 3) 같은 음절 반복: '가가' (조합 끝 뒤 같은 글자를 중복으로 버리지 않음)
        text0, rev0 = after["paragraphText"], int(after["localRevision"])
        run(xdotool, "type", "--delay", "90", "rkrk")
        run(xdotool, "key", "End")
        st = settle(d, f"{fmt}: 가가")
        record("같은 음절을 연달아 확정해도 모두 남음", st["paragraphText"] == text0 + "가가" and int(st["localRevision"]) - rev0 == 2,
               f"{fmt}: 넣은 부분 {st['paragraphText'][len(text0):]!r}, revision +{int(st['localRevision']) - rev0}")

        # 4) 조합 중 ←: 남은 음절(가)을 확정한 뒤 이동
        text0 = st["paragraphText"]
        run(xdotool, "type", "--delay", "90", "rk")
        run(xdotool, "key", "Left")
        st = settle(d, f"{fmt}: 가 + ←")
        record("조합 중 ←는 조합 글자를 그 자리에 확정한 뒤 이동",
               st["paragraphText"] == text0 + "가" and offset_of(st["caret"]) == len(st["paragraphText"]) - 1,
               f"{fmt}: 넣은 부분 {st['paragraphText'][len(text0):]!r}, caret={st['caret']}")

        # 5) 조합 중 클릭: 문단 끝에서 '하'를 조합하다 같은 줄 앞쪽(줄 처음에서 30%)을 클릭
        run(xdotool, "key", "Home")
        settle(d, f"{fmt}: Home")
        line_start = caret_client(d)
        run(xdotool, "key", "End")
        st = settle(d, f"{fmt}: End")
        line_end = caret_client(d)
        text0, rev0 = st["paragraphText"], int(st["localRevision"])
        target = (line_start[0] + (line_end[0] - line_start[0]) * 0.3, line_start[1] + line_start[2] / 2)
        run(xdotool, "type", "--delay", "90", "gk")
        composing = settle(d, f"{fmt}: 클릭 전 ㅎㅏ").get("composing") == "true"  # 페이지가 조합 중일 때 누른다
        mark = d.js("return window.__imeLog.length")
        run(xdotool, "mousemove", "--window", window, str(int(target[0] + shift[0])), str(int(target[1] + shift[1])), "click", "1")
        st = settle(d, f"{fmt}: 조합 중 클릭")
        caret = st["caret"]
        clicked_ok = (composing and st["paragraphText"] == text0 + "하" and caret.split(":")[1] == before["caret"].split(":")[1]
                      and "@" not in caret and offset_of(caret) < len(text0) - 1 and int(st["localRevision"]) - rev0 == 1)
        clicked_detail = (f"{fmt}: 클릭 때 조합 중={composing}, 넣은 부분 {st['paragraphText'][len(text0):]!r}, caret {caret},"
                          f" revision +{int(st['localRevision']) - rev0},"
                          f" 클릭 뒤 이벤트 {ime_counts(d.js('return window.__imeLog.slice(arguments[0])', mark))}")
        # 7차: 클릭 뒤 다음 입력까지 본다. 늦게 온 옛 조합의 확정이 다음 키에서야 나타나는 결함을 잡는다.
        # 공백은 클릭한 곳에만 하나 들어가고(옛 음절이 다시 나타나지 않음, revision +1), 그 뒤 새 한글 조합도 그 자리에 한 번.
        clicked, click_text, click_rev = st["caret"], st["paragraphText"], int(st["localRevision"])
        at = offset_of(clicked)
        run(xdotool, "key", "space")
        flushed = settle(d, f"{fmt}: 클릭 뒤 공백")
        space_ok = (flushed["paragraphText"] == click_text[:at] + " " + click_text[at:] and offset_of(flushed["caret"]) == at + 1
                    and int(flushed["localRevision"]) - click_rev == 1)
        run(xdotool, "type", "--delay", "90", "gk")
        run(xdotool, "key", "space")
        again = settle(d, f"{fmt}: 클릭 뒤 새 조합")
        spaced = flushed["paragraphText"]
        again_ok = (again["paragraphText"] == spaced[:at + 1] + "하 " + spaced[at + 1:] and offset_of(again["caret"]) == at + 3
                    and int(again["localRevision"]) - int(flushed["localRevision"]) == 2 and again.get("composing") == "false")
        record("조합 중 클릭: 조합 글자를 원래 자리에 한 번 확정하고 커서는 클릭한 곳",
               clicked_ok and space_ok and again_ok,
               f"{clicked_detail}; 클릭 뒤 공백 {'정상' if space_ok else '어긋남'}(넣은 부분 {inserted_between(click_text, flushed['paragraphText'])!r},"
               f" revision +{int(flushed['localRevision']) - click_rev}); 이어 친 '하 ' {'정상' if again_ok else '어긋남'}"
               f"(넣은 부분 {inserted_between(spaced, again['paragraphText'])!r}, revision +{int(again['localRevision']) - int(flushed['localRevision'])})")
        REPORT[fmt]["ime"]["afterClickNextKey"] = {
            "caretBefore": clicked, "caretAfter": flushed["caret"],
            "insertedAtClick": flushed["paragraphText"][offset_of(clicked):offset_of(flushed["caret"])],
            "originalParagraphUnchanged": flushed["caret"].split(":")[1] != before["caret"].split(":")[1] or flushed["paragraphText"].endswith(text0[-3:]),
        }
        print(f"[기록] {fmt}: 클릭 뒤 다음 키에서 확정된 글자(클릭한 곳) = {REPORT[fmt]['ime']['afterClickNextKey']['insertedAtClick']!r}", flush=True)
        REPORT[fmt]["ime"]["eventsTotal"] = ime_counts(d.js("return window.__imeLog"))

    # 마지막 문서(HWPX)가 활성 상태다. 탭 전환 중 조합(기록)과 창 초점 이동(선택 항목)을 실제 입력으로 본다.
    scenario_ime_tab_switch(d, run, xdotool, window, shift, record)
    if focus_window:
        scenario_ime_focus(d, run, xdotool, window, focus_window, record)

    drains = REPORT.get("imeDrain", [])
    if drains:
        slowest = max(drains, key=lambda item: item["seconds"])
        print(f"[측정] 입력을 보낸 뒤 페이지가 따라잡는 데 걸린 시간: 최대 {slowest['seconds']:.2f}초({slowest['step']}), "
              f"단계 {len(drains)}개(보고서 imeDrain). 판정은 처리가 끝난 뒤의 상태로 한다.", flush=True)
    for name, _ in IME_ITEMS:
        outcomes = results[name]
        if not outcomes:
            gate(name, "NOT RUN", "다른 X 창(--focus-window)을 주지 않아 실제 창 초점 이동을 실행하지 않음(합성 이벤트 테스트만 있음)"
                 if "창 초점" in name else "실행하지 않음")
        else:
            gate(name, "PASS" if all(r == "PASS" for r, _ in outcomes) else "FAIL", "; ".join(detail for _, detail in outcomes))


def inserted_between(before: str, after: str) -> str:
    """before에 없던, after에 새로 생긴 부분(앞뒤 공통 부분을 뺀 가운데)."""
    start = 0
    while start < min(len(before), len(after)) and before[start] == after[start]:
        start += 1
    end = 0
    while end < min(len(before), len(after)) - start and before[-1 - end] == after[-1 - end]:
        end += 1
    return after[start:len(after) - end]


def scenario_ime_tab_switch(d, run, xdotool: str, window: str, shift: tuple, record=None) -> None:
    """HWPX 문단 끝에서 'ㅎㅏ'를 조합하다 실제 포인터로 HWP 탭을 누르고 공백을 친다. 조합한 음절이 어느 문서에 몇 번
    들어갔는지 기록한다(필수 게이트 항목이 아님, 페이지가 받지 못한 조합은 앱이 막을 수 없는 플랫폼 경로)."""
    select_tab(d, "basic-ko.hwp")
    other_before = status(d)["paragraphText"]
    select_tab(d, "basic-ko.hwpx")
    run(xdotool, "key", "End")
    st = settle(d, "탭 전환 전 End")
    text0, rev0, caret0 = st["paragraphText"], int(st["localRevision"]), st["caret"]
    run(xdotool, "type", "--delay", "90", "gk")
    settle(d, "탭 전환 전 ㅎㅏ")
    tab = d.js("const t=[...document.querySelectorAll('.document-tab__select')].find(t => t.textContent.includes('basic-ko.hwp')"
               " && !t.textContent.includes('basic-ko.hwpx')); const r=t.getBoundingClientRect();"
               " return [r.left + r.width/2, r.top + r.height/2]")
    run(xdotool, "mousemove", "--window", window, str(int(tab[0] + shift[0])), str(int(tab[1] + shift[1])), "click", "1")
    smoke.wait_until(d, "return document.querySelector('[data-testid=rhwp-status] h1')?.textContent === 'basic-ko.hwp'", timeout=10)
    wait_status(d, "ready")
    settle(d, "탭 전환 뒤")
    run(xdotool, "key", "space")
    other_after = settle(d, "탭 전환 뒤 공백")["paragraphText"]
    select_tab(d, "basic-ko.hwpx")
    st = status(d)
    original = inserted_between(text0, st["paragraphText"])
    other = inserted_between(other_before, other_after)
    outcome = ("duplicated" if "하" in original and "하" in other else "keptInOriginal" if "하" in original
               else "leakedToOtherDocument" if "하" in other else "lost")
    REPORT["imeTabSwitch"] = {"outcome": outcome, "insertedInOriginal": original, "insertedInOther": other,
                              "originalRevisionDelta": int(st["localRevision"]) - rev0, "originalCaretBefore": caret0,
                              "originalCaretAfter": st["caret"]}
    print(f"[기록] 탭 전환 중 조합(HWPX→HWP 탭 클릭→공백): {outcome}, 원래 문서에 {original!r}, 다른 문서에 {other!r}", flush=True)
    if record:  # 7차: 선택 항목(필수 7개와 별개). 원래 문서에 '하' 한 번, 다른 문서에는 공백만.
        record("조합 중 탭 전환: 조합은 원래 문서에 한 번, 다른 문서에 섞이지 않음", original == "하" and other == " ",
               f"{outcome}, 원래 문서에 {original!r}, 다른 문서에 {other!r}")


def scenario_ime_focus(d, run, xdotool: str, window: str, other_name: str, record) -> None:
    """'ㅎㅏ'를 조합하다 다른 X 창으로 초점을 옮겼다가 돌아와 공백을 친다. 음절이 원래 자리에 한 번 남아야 한다."""
    name = "조합 중 창 초점 이동 뒤 돌아옴"
    other = run(xdotool, "search", "--onlyvisible", "--name", other_name).stdout.split()
    if not other:
        return  # 결과 없음 → NOT RUN
    run(xdotool, "windowfocus", "--sync", window)
    run(xdotool, "key", "End")
    st = settle(d, "초점 이동 전 End")
    text0, rev0 = st["paragraphText"], int(st["localRevision"])
    run(xdotool, "type", "--delay", "90", "gk")
    settle(d, "초점 이동 전 ㅎㅏ")
    run(xdotool, "windowfocus", "--sync", other[-1])
    away = settle(d, "다른 창")
    run(xdotool, "windowfocus", "--sync", window)
    # X 초점이 돌아온 뒤 페이지 초점(focus 이벤트)은 늦게 온다(WM 없는 Xvfb 실측 약 1초). 돌아온 뒤에 친다.
    returned = time.monotonic()
    wait_input_focus(d)
    REPORT.setdefault("imeDrain", []).append({"step": "페이지 초점 돌아옴", "seconds": round(time.monotonic() - returned, 2)})
    settle(d, "돌아옴")
    run(xdotool, "key", "space")
    st = settle(d, "돌아와 공백")
    record(name, st["paragraphText"] == text0 + "하 " and int(st["localRevision"]) - rev0 == 2
           and offset_of(st["caret"]) == len(text0) + 2,
           f"hwpx: 다른 창에 있는 동안 넣은 부분 {inserted_between(text0, away['paragraphText'])!r}, 돌아와 공백 뒤 넣은 부분"
           f" {inserted_between(text0, st['paragraphText'])!r}, revision +{int(st['localRevision']) - rev0}")


def ime_exit_code(diagnostic_only: bool) -> int:
    mandatory = [name for name, required in IME_ITEMS if required]
    statuses = [GATE.get(name, ("NOT RUN", ""))[0] for name in mandatory]
    verdict = "PASS" if all(s == "PASS" for s in statuses) else "FAIL" if "FAIL" in statuses else "UNVERIFIED"
    REPORT["imeGate"] = {"verdict": verdict, "items": {name: {"result": r, "detail": d} for name, (r, d) in GATE.items()},
                         "diagnosticOnly": diagnostic_only}
    print(f"\nIME 게이트: {verdict} (필수 {len(mandatory)}개 중 PASS {statuses.count('PASS')}, FAIL {statuses.count('FAIL')},"
          f" UNVERIFIED/NOT RUN {len(statuses) - statuses.count('PASS') - statuses.count('FAIL')})")
    if diagnostic_only:
        print("[진단 전용] 종료 코드는 게이트 결과가 아니며, 이 실행은 통과 증거가 아니다.")
        return 0
    return {"PASS": 0, "FAIL": 1, "UNVERIFIED": 2}[verdict]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--driver-log", type=Path)
    parser.add_argument("--ime", action="store_true", help="실제 IME 게이트만 실행(X11 + ibus-hangul + xdotool)")
    parser.add_argument("--diagnostic-only", action="store_true", help="IME 관찰만 기록(종료 코드가 게이트 결과가 아님)")
    parser.add_argument("--xdotool", default=shutil.which("xdotool") or "xdotool")
    parser.add_argument("--ibus", default=shutil.which("ibus") or "ibus")
    parser.add_argument("--focus-window", help="창 초점 이동 항목에 쓸, 이미 떠 있는 다른 X 창의 이름(xdotool search --name)")
    parser.add_argument("--commands-only", action="store_true", help="T010 명령 시나리오만 실행")
    args = parser.parse_args()
    smoke.APP = os.path.abspath(args.app)
    smoke.DRIVER_LOG = args.driver_log
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    if args.ime:
        reason = ime_environment(args.xdotool, args.ibus)
        if reason:  # 실제 입력을 보낼 수 없으면 앱을 띄우지 않고 판단 불가로 끝낸다
            for name, _ in IME_ITEMS:
                gate(name, "UNVERIFIED", reason)
            code = ime_exit_code(args.diagnostic_only)
            if args.report:
                args.report.write_text(json.dumps({"results": RESULTS, "measurements": REPORT}, ensure_ascii=False, indent=2))
            return code
    try:
        with tempfile.TemporaryDirectory(prefix="geul-t007-") as scratch_dir:
            scratch = Path(scratch_dir)
            fixtures = scratch / "fixtures"
            meta = json.loads(subprocess.run(["node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures)],
                                             check=True, capture_output=True, text=True).stdout)
            REPORT["fixtures"] = {"rhwpCommit": meta["rhwpCommit"], "contentLoss": meta["contentLoss"]}
            node = subprocess.run(["node", str(ROOT / "tests/integration/rhwp/roundtrip.mjs"), str(fixtures), str(scratch / "exported")],
                                  capture_output=True, text=True)
            exported = json.loads(node.stdout)
            REPORT["exportedFiles"] = {f: {k: v for k, v in r.items() if k not in ("before", "after", "file")} for f, r in exported.items()}
            if not args.ime:
                check("Node 왕복(편집→원본 형식 내보내기→파일→다시 열기): 손실 보고가 올바른 모양이고 0건, 다시 연 형식이 요청한 형식, "
                      "편집한 문서와 같음(HWP·HWPX)",
                      node.returncode == 0 and set(exported) == {"hwp", "hwpx"}
                      and all(r.get("passed") and r.get("formatEqual") and r.get("sourceFormat") == f for f, r in exported.items()),
                      json.dumps(REPORT["exportedFiles"]))
            with tempfile.TemporaryDirectory(prefix="geul-t007-data-") as data_home:
                with smoke.tauri_driver(args.driver, args.port, data_home) as start:
                    d = start()
                    try:
                        smoke.wait_until(d, "return document.querySelector('.document-bar') !== null", timeout=30)
                        if args.ime:
                            scenario_ime(d, fixtures, args.xdotool, args.ibus, args.focus_window, args.screenshots)
                        elif args.commands_only:
                            scenario_commands(d, fixtures, scratch)
                        else:
                            scenario_load_render(d, fixtures, args.screenshots)
                            for fmt in ("hwp", "hwpx"):
                                select_tab(d, f"basic-ko.{fmt}")
                                scenario_hit_test(d, fmt)
                                scenario_selection_keyboard(d, fmt)
                                scenario_revision(d, fmt)
                                scenario_roundtrip_ui(d, fmt)
                                scenario_latency(d, fmt)
                                if args.screenshots:
                                    d.screenshot(args.screenshots / f"{fmt}-edited.png")
                            scenario_sessions(d, fixtures, scratch)
                            scenario_reopen_exported(d, exported)
                            scenario_save(d, fixtures, scratch)
                            scenario_commands(d, fixtures, scratch)
                    finally:
                        smoke.end_session(d)  # 앞선 실패를 가리지 않고, 앞선 실패가 없으면 정리 실패도 보고한다
        if args.ime:
            return ime_exit_code(args.diagnostic_only)
        print(f"\nT007 rhwp PoC: {len(RESULTS)}개 항목 통과")
        return 0
    except smoke.DriverLost as error:
        REPORT["driverLost"] = error.diagnostic()
        print(f"통과한 항목 {len(RESULTS)}개(끊기기 전)", file=sys.stderr)
        return smoke.driver_lost_exit(error)
    except smoke.CleanupFailure as error:
        # 모든 항목 뒤 세션 삭제가 HTTP 오류 응답으로 실패: 정리 실패(2). 기능 실패 뒤라면 end_session이 원래 실패를 올린다.
        REPORT["cleanupFailure"] = error.diagnostic()
        return smoke.driver_lost_exit(error)
    except (smoke.Failure, TimeoutError, OSError) as error:
        import traceback
        traceback.print_exc()
        print(f"[실패] {error}", file=sys.stderr)
        return 1
    finally:
        if args.report:
            args.report.write_text(json.dumps({"results": RESULTS, "measurements": REPORT}, ensure_ascii=False, indent=2))


def wait_input_focus(d, timeout: float = 10) -> None:
    """페이지 초점이 편집 입력(.rhwp-input)에 돌아올 때까지. 오지 않으면 그때의 초점을 묻고 실패로 알린다."""
    try:
        smoke.wait_until(d, "return document.hasFocus() && !!document.activeElement?.classList.contains('rhwp-input')", timeout=timeout)
    except smoke.DriverLost:
        raise  # 끊긴 뒤에는 초점을 더 묻지 않는다(묻는 요청이 원래 끊김 진단을 덮음)
    except smoke.Failure:
        focus = d.js("const a=document.activeElement; return [document.hasFocus(), a ? a.tagName + '.' + a.className : null]")
        raise smoke.Failure(f"창 초점이 돌아온 뒤 편집 입력에 초점이 오지 않음(hasFocus, activeElement = {focus})") from None


def select_tab(d, name: str) -> None:
    d.js("[...document.querySelectorAll('.document-tab__select')].find(t => t.textContent.replace(/^● /,'').startsWith(arguments[0])"
         " && !t.textContent.includes(arguments[0] + 'x')).click()", name)
    smoke.wait_until(d, "return document.querySelector('[data-testid=rhwp-status] h1')?.textContent === arguments[0]", name, timeout=10)
    wait_status(d, "ready")


if __name__ == "__main__":
    sys.exit(main())
