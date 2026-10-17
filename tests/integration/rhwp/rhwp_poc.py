#!/usr/bin/env python3
"""T007 rhwp HWP/HWPX 중앙 편집 PoC를 실제 Tauri 앱(WebKitGTK)에서 실행하고 측정한다.

필요: 빌드된 앱(`npm run tauri build -- --debug --no-bundle`), `scripts/build-rhwp-wasm.sh` 산출물(public/rhwp/),
tauri-driver 2.x, WebKitWebDriver, Node.js, 그래픽 세션(Wayland weston 또는 X11).
픽스처는 실행할 때 `tests/fixtures/rhwp/generate.mjs`로 임시 디렉터리에 만든다(저장소에 바이너리 없음).

    python3 tests/integration/rhwp/rhwp_poc.py --app src-tauri/target/debug/geul --driver <tauri-driver> \\
        [--report <결과 JSON>] [--screenshots <디렉터리>]

    # 실제 한국어 IME(ibus-hangul, X11 + xdotool) 시나리오만:
    python3 tests/integration/rhwp/rhwp_poc.py --app ... --driver ... --ime --xdotool <xdotool> --ibus <ibus>

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
    perform(d, [{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": int(round(x)), "y": int(round(y)), "origin": "viewport"},
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
    origin = page_origin(d)
    # 고정 픽스처의 2×2 표: 첫 행 y≈181, 두 열 x≈ 120 / 400 (페이지 좌표)
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
    sid, rev = active["sessionId"], active["revision"]
    stale = ipc(d, "document_commit", {"sessionId": sid, "baseRevision": max(0, rev - 1), "count": 1})
    dup = ipc(d, "document_commit", {"sessionId": sid, "baseRevision": rev + 3, "count": 1})
    check(f"{fmt}: 옛·앞선 기준 revision의 확정은 RevisionMismatch로 거부되고 기록은 그대로",
          stale == {"err": {"code": "RevisionMismatch", "sessionId": sid, "revision": rev}} and dup == stale
          and ipc(d, "document_session", {"sessionId": sid})["ok"]["revision"] == rev, json.dumps([stale, dup]))
    REPORT[fmt]["revisionBeforeExternal"] = rev
    _ = st


def scenario_roundtrip_ui(d, fmt: str) -> None:
    press_button(d, "[data-testid=rhwp-roundtrip]")
    smoke.wait_until(d, "return document.querySelector('[data-testid=rhwp-roundtrip-result]') !== null", timeout=30)
    r = d.js("return {...document.querySelector('[data-testid=rhwp-roundtrip-result]').dataset}")
    check(f"{fmt}: 편집한 문서를 메모리에서 원본 형식으로 내보내고 다시 열어 쪽·텍스트·컨트롤 일치, 손실 보고 {r.get('lossCount')}건",
          r.get("format") == fmt and r.get("pagesEqual") == "true" and r.get("textEqual") == "true" and r.get("controlsEqual") == "true",
          json.dumps(r))
    REPORT[fmt]["roundTripInApp"] = r


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
    external = ipc(d, "document_commit", {"sessionId": sid, "baseRevision": after["basic-ko.hwpx"]["revision"], "count": 1})
    click_paragraph_start(d)
    press(d, "q")
    time.sleep(0.6)
    st = status(d)
    backend = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check("다른 쓰는 쪽의 확정 뒤 편집기의 확정은 RevisionMismatch → 편집 중지(failed), 백엔드도 failed",
          "ok" in external and st["status"] == "failed" and backend["state"] == "failed", json.dumps([external, st.get("status"), backend]))
    # 다시 불러오기: 파일 내용으로 돌아가고 revision은 줄지 않으며 깨끗함
    press_button(d, "[data-testid=rhwp-load]")
    st = wait_status(d, "ready")
    backend = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check("failed에서 다시 불러오면 ready, revision 유지·dirty 아님(편집은 버려짐)",
          backend["state"] == "ready" and backend["revision"] == after["basic-ko.hwpx"]["revision"] + 1 and not backend["dirty"]
          and st["paragraphText"].startswith("한글 문단입니다."), json.dumps(backend))

    # 확정을 기다리는 동안 닫기: 늦은 응답이 세션을 되살리지 않음
    click_paragraph_start(d)
    d.js("""const input=document.querySelector('.rhwp-input'); input.value='Z';
            input.dispatchEvent(new InputEvent('input',{bubbles:true,data:'Z',inputType:'insertText'}));
            [...document.querySelectorAll('.document-tab')].find(t=>t.textContent.includes('basic-ko.hwpx')).querySelector('.document-tab__close').click();""")
    time.sleep(0.8)
    remaining = [s["displayName"] for s in ipc(d, "document_sessions")["ok"]]
    stale = ipc(d, "document_session", {"sessionId": sid})
    check("편집 직후(확정 대기 중) 닫은 세션은 목록에서 사라지고 다시 나타나지 않음(StaleSession)",
          "basic-ko.hwpx" not in remaining and stale == {"err": {"code": "StaleSession", "sessionId": sid}}, json.dumps([remaining, stale]))

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
        check(f"{fmt}: 편집해 내보낸 파일(손실 보고 {exported[fmt]['contentLoss']['count']}건)을 앱에서 다시 열면 판별·불러오기 성공, 넣은 글자 유지",
              st["status"] == "ready" and text_ok and exported[fmt]["equalToEdited"] and exported[fmt]["boldKept"], json.dumps(st, ensure_ascii=False))


def scenario_ime(d, fixtures: Path, xdotool: str, ibus: str) -> None:
    run = lambda *a: subprocess.run(["env", "-u", "LD_LIBRARY_PATH", *a], capture_output=True, text=True)
    for name in ("basic-ko.hwp", "basic-ko.hwpx"):
        fmt = name.split(".")[-1]
        open_document(d, fixtures / name)
        d.js("""window.__imeLog=[]; const i=document.querySelector('.rhwp-input');
          for (const t of ['compositionstart','compositionupdate','compositionend','input'])
            i.addEventListener(t, e => window.__imeLog.push([t, e.data ?? null, e.isComposing ?? null]), true);""")
        window = run(xdotool, "search", "--name", "^geul").stdout.split()[-1]
        run(xdotool, "windowfocus", "--sync", window)
        run(ibus, "engine", "hangul")
        top = d.js("return window.outerHeight - window.innerHeight")
        origin = page_origin(d)
        # 첫 문단 글자 끝 오른쪽 빈 곳 → 첫 문단 끝
        run(xdotool, "mousemove", "--window", window, str(int(origin[0] + 600)), str(int(origin[1] + 139 + top)), "click", "1")
        time.sleep(0.4)
        before = status(d)
        run(xdotool, "type", "--delay", "90", "gksrmf dlqfur xptmxm")
        run(xdotool, "key", "End")
        time.sleep(0.8)
        after = status(d)
        log = d.js("return window.__imeLog")
        text = after["paragraphText"]
        check(f"{fmt}: 실제 IME(ibus-hangul 두벌식)로 '한글 입력 테스트'가 커서 위치에 정확히 한 번 확정",
              text == before["paragraphText"] + "한글 입력 테스트", text)
        check(f"{fmt}: IME 확정 음절·공백마다 revision 1(조합 중간은 확정 안 함)",
              int(after["localRevision"]) - int(before["localRevision"]) == 9, f"{before['localRevision']}→{after['localRevision']}")
        updates = [e for e in log if e[0] in ("compositionstart", "compositionupdate")]
        REPORT.setdefault(fmt, {})["ime"] = {"text": text, "events": len(log), "preeditEvents": len(updates)}
        # 조합 중 화살표: 남은 음절(가)을 확정한 뒤 이동
        run(xdotool, "type", "--delay", "90", "rk")
        run(xdotool, "key", "Left")
        time.sleep(0.6)
        st = status(d)
        check(f"{fmt}: 조합 중 ←는 조합 글자를 그 자리에 확정한 뒤 커서를 옮김",
              st["paragraphText"].endswith("테스트가") and offset_of(st["caret"]) == len(st["paragraphText"]) - 1, json.dumps(st, ensure_ascii=False))
        # 조합 중 클릭: 결과만 기록(아래 보고서 참고)
        run(xdotool, "type", "--delay", "90", "gk")
        time.sleep(0.3)
        run(xdotool, "mousemove", "--window", window, str(int(origin[0] + 150)), str(int(origin[1] + 139 + top)), "click", "1")
        time.sleep(0.6)
        run(xdotool, "key", "End")
        time.sleep(0.6)
        st = status(d)
        REPORT[fmt]["ime"]["clickDuringComposition"] = st["paragraphText"]
        REPORT[fmt]["ime"]["preedit"] = "none" if not updates else "present"
        print(f"[기록] {fmt}: 조합 중 클릭 뒤 첫 문단 = {st['paragraphText']!r}, 조합 중 표시 이벤트 {len(updates)}개")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--driver-log", type=Path)
    parser.add_argument("--ime", action="store_true", help="실제 IME 시나리오만 실행(X11 + ibus-hangul + xdotool)")
    parser.add_argument("--xdotool", default=shutil.which("xdotool") or "xdotool")
    parser.add_argument("--ibus", default=shutil.which("ibus") or "ibus")
    args = parser.parse_args()
    smoke.APP = os.path.abspath(args.app)
    smoke.DRIVER_LOG = args.driver_log
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="geul-t007-") as scratch_dir:
            scratch = Path(scratch_dir)
            fixtures = scratch / "fixtures"
            meta = json.loads(subprocess.run(["node", str(ROOT / "tests/fixtures/rhwp/generate.mjs"), str(fixtures)],
                                             check=True, capture_output=True, text=True).stdout)
            REPORT["fixtures"] = {"rhwpCommit": meta["rhwpCommit"], "contentLoss": meta["contentLoss"]}
            exported = json.loads(subprocess.run(["node", str(ROOT / "tests/integration/rhwp/roundtrip.mjs"), str(fixtures),
                                                  str(scratch / "exported")], check=True, capture_output=True, text=True).stdout)
            REPORT["exportedFiles"] = {f: {k: v for k, v in r.items() if k not in ("before", "after", "file")} for f, r in exported.items()}
            with tempfile.TemporaryDirectory(prefix="geul-t007-data-") as data_home:
                with smoke.tauri_driver(args.driver, args.port, data_home) as start:
                    d = start()
                    try:
                        smoke.wait_until(d, "return document.querySelector('.document-bar') !== null", timeout=30)
                        if args.ime:
                            scenario_ime(d, fixtures, args.xdotool, args.ibus)
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
                    finally:
                        try:
                            d.quit()
                        except smoke.Failure as error:  # 앞선 실패를 가리지 않는다
                            print(f"[참고] 세션 종료 실패: {error}", file=sys.stderr)
        print(f"\nT007 rhwp PoC: {len(RESULTS)}개 항목 통과")
        return 0
    except (smoke.Failure, TimeoutError, OSError) as error:
        import traceback
        traceback.print_exc()
        print(f"[실패] {error}", file=sys.stderr)
        return 1
    finally:
        if args.report:
            args.report.write_text(json.dumps({"results": RESULTS, "measurements": REPORT}, ensure_ascii=False, indent=2))


def select_tab(d, name: str) -> None:
    d.js("[...document.querySelectorAll('.document-tab__select')].find(t => t.textContent.replace(/^● /,'').startsWith(arguments[0])"
         " && !t.textContent.includes(arguments[0] + 'x')).click()", name)
    smoke.wait_until(d, "return document.querySelector('[data-testid=rhwp-status] h1')?.textContent === arguments[0]", name, timeout=10)
    wait_status(d, "ready")


if __name__ == "__main__":
    sys.exit(main())
