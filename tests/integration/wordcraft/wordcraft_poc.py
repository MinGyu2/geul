#!/usr/bin/env python3
"""T008 WordCraft DOCX 중앙 편집 PoC(W-A)를 실제 Tauri 앱(WebKitGTK)에서 실행하고 측정한다.

필요: 검사 훅을 켠 앱 빌드(`VITE_GEUL_TEST_HOOKS=1 npm run tauri build -- --debug --no-bundle` — 커서 문단 글자·조합 글자를
진단 속성으로 노출, 일반 빌드에는 없음), tauri-driver 2.x, WebKitWebDriver, cargo(픽스처 생성기), 그래픽 세션(X11 또는 Wayland).
픽스처는 실행할 때 WordCraft 엔진 명령으로 임시 디렉터리에 만든다(`cargo run --example wordcraft_fixture`, 저장소에 바이너리 없음).

    python3 tests/integration/wordcraft/wordcraft_poc.py --app <geul 디버그 바이너리> --driver <tauri-driver> \\
        [--report <결과 JSON>] [--screenshots <디렉터리>] [--font-home <디렉터리>]

    # 실제 한국어 IME 게이트(X11 + ibus-hangul + xdotool, 실제 키 입력):
    python3 tests/integration/wordcraft/wordcraft_poc.py --app ... --driver ... --ime --xdotool <xdotool> --ibus <ibus>

판정 기준과 항목 이름은 T007(tests/integration/rhwp/rhwp_poc.py)과 같다. IME 게이트는 실제 입력을 보낸 뒤 페이지가 그 입력을 모두
처리할 때까지(입력 이벤트·편집 상태·보내는 중인 연산이 잠시 그대로) 기다린 뒤 판정하며 PASS·FAIL·UNVERIFIED·NOT RUN을 출력한다.
필수 항목이 모두 PASS일 때만 종료 코드 0, FAIL이 있으면 1, 실제 입력 환경이 없으면 2. 합성 DOM 이벤트는 쓰지 않는다.

W-A의 조합 표시: 엔진은 조합을 모르므로 조합 중 글자는 문서 모델에 넣지 않고 커서 자리에 겹쳐 그린다. 그래서 "조합 중 글자가
보임"은 겹침 요소에 그 글자가 커서 자리에 보이고 모델(문단 글자·revision)은 그대로인지로 본다.

--font-home: 고정 WordCraft는 정해진 글꼴 폴더(~/.fonts, ~/.local/share/fonts, /usr/share/fonts 등)만 찾는다. 글꼴이 fontconfig로만
있는 시스템(NixOS 등)에서는 한글이 빈 상자로 그려지므로, 앱 프로세스의 HOME을 한글 글꼴을 .fonts에 둔 디렉터리로 바꿔 실행한다
(시험 환경 보정이며 앱 동작이 아니다. 이때 ibus 연결은 IBUS_ADDRESS로 준다).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
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
sys.path.insert(0, str(ROOT / "tests" / "integration" / "rhwp"))
import tauri_smoke as smoke  # noqa: E402
import rhwp_poc  # noqa: E402
from rhwp_poc import KEY, ime_counts, inserted_between, perform  # noqa: E402  (T007 입력 도우미 재사용)

STATUS = "[data-testid=docx-status]"
RESULTS: list[str] = []
REPORT: dict = {}
PT = 96 / 72  # CSS px / pt(배율 100%)


# WebDriver 포인터 좌표 → 페이지 clientX 비율. 소수 devicePixelRatio(이 Xvfb에서 1.041)에서 WebKitWebDriver의 포인터 위치가 요청 값 ÷ 비율에
# 떨어졌다(실측: 415.4 요청 → mousedown clientX 398). 앱의 좌표 변환과 무관한 시험기 문제이므로 실행 처음에 상태 표시줄을 한 번 눌러 잰다.
POINTER_SCALE = [1.0]


def calibrate_pointer(d) -> None:
    d.js("window.__cal=null; window.addEventListener('mousedown', e => { window.__cal=[e.clientX, e.clientY]; }, {capture: true, once: true})")
    target = d.js("const r=document.querySelector('.statusbar').getBoundingClientRect(); return [r.left + r.width*0.5, r.top + r.height/2]")
    rhwp_poc.click(d, *target)
    time.sleep(0.2)
    got = d.js("return window.__cal")
    if not got or got[0] <= 0:
        raise smoke.Failure(f"포인터 보정 실패: {got}")
    POINTER_SCALE[0] = target[0] / got[0]
    REPORT["pointerScale"] = {"value": POINTER_SCALE[0], "devicePixelRatio": d.js("return devicePixelRatio")}
    print(f"[보정] WebDriver 포인터 비율 {POINTER_SCALE[0]:.4f} (devicePixelRatio {REPORT['pointerScale']['devicePixelRatio']})", flush=True)


def click(d, x: float, y: float) -> None:
    rhwp_poc.click(d, x * POINTER_SCALE[0], y * POINTER_SCALE[0])


def drag(d, start: tuple[float, float], end: tuple[float, float]) -> None:
    s = POINTER_SCALE[0]
    rhwp_poc.drag(d, (start[0] * s, start[1] * s), (end[0] * s, end[1] * s))


def check(name: str, condition: bool, detail: str = "") -> None:
    smoke.check(RESULTS, name, condition, detail)


def status(d) -> dict:
    return d.js(f"const e=document.querySelector('{STATUS}'); return e ? {{...e.dataset}} : null") or {}


def ipc(d, command: str, args: dict | None = None):
    return d.js(smoke.INVOKE, command, args or {})


def press_button(d, css: str) -> None:
    if not d.js("const b=document.querySelector(arguments[0]); if(!b) return false; b.click(); return true", css):
        raise smoke.Failure(f"버튼 없음: {css}")


def wait_status(d, expected: str, timeout: float = 60) -> dict:
    smoke.wait_until(d, f"const e=document.querySelector('{STATUS}'); return e && e.dataset.status===arguments[0]", expected, timeout=timeout)
    return status(d)


def idle(d, timeout: float = 30) -> dict:
    """보내는 중인 연산이 없고 보이는 쪽 그림이 지금 판일 때까지 기다린다."""
    # 보이는 쪽은 앱(DocxSurface.visiblePages)과 같이 스크롤 영역(.editor__scroll) 사각형으로 정한다. 창 높이(innerHeight)로 보면
    # 스크롤 영역 아래(상태 표시줄 자리)에 걸친, 앱이 그리지 않는 쪽까지 기다린다(여러 쪽 문서에서 실측).
    visible = ("const s=document.querySelector('.editor__scroll')?.getBoundingClientRect();"
               " const shown=(p) => { const r=p.getBoundingClientRect(); return !s || (r.bottom > s.top && r.top < s.bottom); };")
    try:
        smoke.wait_until(d, f"{visible} const e=document.querySelector('{STATUS}'); return e && e.dataset.pending==='0'"
                            " && [...document.querySelectorAll('.docx-page')].every(p => p.dataset.current==='true' || !shown(p))", timeout=timeout)
    except smoke.Failure as error:
        st = status(d)
        stale = d.js(f"{visible} return [...document.querySelectorAll('.docx-page')].filter(p => p.dataset.current!=='true' && shown(p))"
                     ".map(p => [p.dataset.page, p.dataset.revision, p.dataset.renderFailed ?? ''])")
        raise smoke.Failure(f"{error} — 상태 {json.dumps({k: st.get(k) for k in ('status', 'revision', 'pending', 'renderFailed', 'pages')})}, 지금 판이 아닌 보이는 쪽 {stale}") from error
    return status(d)


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
    idle(d)


def open_document(d, path: Path, expected: str = "ready") -> dict:
    d.js("""const el=document.querySelector('#document-path');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, arguments[0]);
      el.dispatchEvent(new Event('input',{bubbles:true}));""", str(path))
    d.js("document.querySelector('.document-bar__open').requestSubmit()")
    smoke.wait_until(d, f"return document.querySelector('{STATUS} h1')?.textContent === arguments[0]", path.name, timeout=30)
    st = wait_status(d, expected)
    return idle(d) if expected == "ready" else st


def select_tab(d, name: str) -> None:
    d.js("[...document.querySelectorAll('.document-tab__select')].find(t => t.textContent.replace(/^● /,'').startsWith(arguments[0])).click()", name)
    smoke.wait_until(d, f"return document.querySelector('{STATUS} h1')?.textContent === arguments[0]", name, timeout=10)
    wait_status(d, "ready")
    idle(d)


def page_origin(d) -> list[float]:
    return d.js("""const p=document.querySelector('.docx-page'); const s=document.querySelector('.editor__scroll');
        s.scrollTop = 0; s.scrollLeft = 0; const r=p.getBoundingClientRect(); return [r.left, r.top]""")


def caret_client(d) -> list[float]:
    return d.js("const c=document.querySelector('[data-testid=docx-caret]'); if(!c) return null;"
                " const r=c.getBoundingClientRect(); return [r.left + r.width/2, r.top, r.height]")


def caret_path(st: dict) -> str:
    return st.get("caret", "::").split(":")[1]


def click_page(d, x_pt: float, y_pt: float) -> None:
    """쪽 좌표(pt, 배율 100%)를 실제 포인터로 누른다."""
    origin = page_origin(d)
    click(d, origin[0] + x_pt * PT, origin[1] + y_pt * PT)
    idle(d)


# 고정 픽스처(tests/fixtures/wordcraft/basic.rs, Letter 612×792pt, 여백 72pt)의 대략적인 자리(pt). 누른 뒤 커서 문단 경로로 확인한다.
PARA0_Y, PARA1_Y = 80.0, 110.0
CELL = {0: (100.0, 138.0), 1: (330.0, 138.0), 2: (100.0, 156.0), 3: (330.0, 156.0)}


def click_paragraph_start(d) -> None:
    click_page(d, 150, PARA0_Y)
    press(d, "Home")


def click_cell(d, cell: int) -> None:
    click_page(d, *CELL[cell])
    press(d, "Home")


# ---- 시나리오 ----

def scenario_load_render(d, fixtures: Path, meta: dict, shots: Path | None) -> None:
    st = open_document(d, fixtures / "basic-ko.docx")
    if "paragraphText" not in st:
        raise smoke.Failure("검사 훅이 없는 빌드입니다: VITE_GEUL_TEST_HOOKS=1로 앱을 빌드하세요")
    pages, first_paint = int(st.get("pages", "0")), float(st.get("firstPaintMs") or "nan")
    check("docx: 실제 WordCraft 문서를 백엔드 엔진에 불러와 편집 가능(ready)", st["status"] == "ready" and pages >= 1, json.dumps(st, ensure_ascii=False))
    record = next(s for s in ipc(d, "document_sessions")["ok"] if s["displayName"] == "basic-ko.docx")
    check("docx: 백엔드 세션 ready·revision 0·엔진 wordcraft", record["state"] == "ready" and record["revision"] == 0 and record["engine"] == "wordcraft",
          json.dumps(record))
    check(f"docx: 첫 쪽 그림 표시 시간 기록({first_paint:.0f} ms)", first_paint == first_paint and pages <= 10, str(first_paint))
    REPORT["docx"] = {"firstPaintMs": first_paint, "pages": pages}
    check("docx: 첫 문단이 실제 문서 내용(한·영)", st["paragraphText"] == meta["content"]["paragraphs"][0], st["paragraphText"])
    for zoom in (100, 200):
        set_zoom(d, zoom)
        idle(d)
        dims = d.js("""const c=document.querySelector('.docx-page canvas'); const r=c.getBoundingClientRect();
            const x=c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, Math.round(c.height*0.3))).data;
            let ink=0; for (let i=0;i<x.length;i+=4) if (x[i]<128) ink++;
            return {w: c.width, h: c.height, cssW: r.width, cssH: r.height, dpr: window.devicePixelRatio, inkPixels: ink}""")
        check(f"docx: 배율 {zoom}%에서 쪽 그림이 화면 크기 × devicePixelRatio(선명도)이고 글자가 그려짐",
              abs(dims["w"] - dims["cssW"] * dims["dpr"]) <= 2 and abs(dims["cssW"] - 612 * PT * zoom / 100) <= 2 and dims["inkPixels"] > 200,
              json.dumps(dims))
        REPORT["docx"][f"canvas{zoom}"] = dims
        if shots:
            data = d.js("return document.querySelector('.docx-page canvas').toDataURL('image/png')")
            (shots / f"docx-canvas-zoom{zoom}.png").write_bytes(base64.b64decode(data.split(",", 1)[1]))
    set_zoom(d, 100)
    idle(d)


def set_zoom(d, target: int) -> None:
    for _ in range(40):
        current = int(d.js("return parseInt(document.querySelector('.statusbar__zoom-value').textContent)"))
        if current == target:
            return
        press_button(d, 'button[data-command="view.zoomIn"]' if current < target else 'button[data-command="view.zoomOut"]')
        time.sleep(0.05)
    raise smoke.Failure(f"배율 {target}%에 닿지 못함")


def boundaries(d, count: int) -> list[list[float]]:
    points = []
    for _ in range(count + 1):
        points.append(caret_client(d) + [int(status(d)["caretOffset"])])
        press(d, "Right")
    return points


def scenario_hit_test(d) -> None:
    deviations = []
    for label, setup, count in (("본문", lambda: click_paragraph_start(d), 12), ("표 셀", lambda: click_cell(d, 0), 4)):
        setup()
        start = status(d)
        if label == "표 셀":
            check("docx: 표 셀을 누르면 커서가 그 셀 문단(표 안)", start.get("inTable") == "true", json.dumps(start, ensure_ascii=False))
        points = boundaries(d, count)
        for i in range(count):
            left, right = points[i], points[i + 1]
            if abs(right[1] - left[1]) > 1:
                continue
            y = left[1] + left[2] / 2
            for fraction, expected in ((0.3, left[3]), (0.7, right[3])):
                click(d, left[0] + (right[0] - left[0]) * fraction, y)
                st = idle(d)
                same = caret_path(st) == caret_path(start)
                got = int(st["caretOffset"])
                deviations.append({"where": label, "expected": expected, "got": got, "sameContext": same,
                                   "deviation": abs(got - expected) if same else 99})
        worst = max(x["deviation"] for x in deviations if x["where"] == label)
        check(f"docx: {label} 클릭 hit test 편차 최대 {worst}글자(경계 사이 30%/70% 클릭 {sum(1 for x in deviations if x['where'] == label)}회)",
              worst <= 1, json.dumps([x for x in deviations if x["where"] == label and x["deviation"]], ensure_ascii=False))
    REPORT["docx"]["hitTest"] = {"samples": len(deviations), "maxDeviation": max(x["deviation"] for x in deviations),
                                 "exact": sum(1 for x in deviations if x["deviation"] == 0)}


def scenario_selection_keyboard(d) -> None:
    click_paragraph_start(d)
    left = caret_client(d)
    press(d, "Right", "Right", "Right")
    right = caret_client(d)
    press(d, "Home")
    drag(d, (left[0] + 1, left[1] + left[2] / 2), (right[0] + 1, right[1] + right[2] / 2))
    st = idle(d)
    rects = d.js("return document.querySelectorAll('.docx-page .rhwp-selection').length")
    check("docx: 드래그로 선택 범위(3글자)와 선택 표시", st.get("selection", "") != "" and st["caretOffset"] == "3" and rects >= 1,
          f"{st.get('selection')} offset={st.get('caretOffset')} rects={rects}")
    base, rev0 = st["paragraphText"], int(st["revision"])
    press(d, "End")
    end = int(status(d)["caretOffset"])
    press(d, "Home")
    check("docx: Home·End가 줄 처음·끝으로", status(d)["caretOffset"] == "0" and end > 10, f"end={end}")
    press(d, "Right", "Right")
    press(d, "Right", "Right", shift=True)
    st = status(d)
    check("docx: Shift+→로 선택 확장", st.get("selection", "") != "" and st["caretOffset"] == "4", st.get("selection", ""))
    press(d, "Backspace")
    check("docx: 선택 영역 Backspace는 선택한 2글자만 지움", status(d)["paragraphText"] == base[:2] + base[4:], status(d)["paragraphText"])
    press(d, "Delete")
    check("docx: Delete는 커서 뒤 1글자", status(d)["paragraphText"] == base[:2] + base[5:], status(d)["paragraphText"])
    press(d, "Enter")
    st = status(d)
    check("docx: Enter는 문단을 나누고 커서를 새 문단 처음으로", caret_path(st) == "1" and st["caretOffset"] == "0" and st["paragraphText"] == base[5:],
          json.dumps(st, ensure_ascii=False))
    press(d, "Backspace")
    st = status(d)
    check("docx: 문단 처음의 Backspace는 앞 문단과 합침", caret_path(st) == "0" and st["caretOffset"] == "2" and st["paragraphText"] == base[:2] + base[5:],
          json.dumps(st, ensure_ascii=False))
    press(d, "Down")
    down = status(d)["caret"]
    press(d, "Up")
    check("docx: ↓·↑로 다른 줄로 이동하고 돌아옴", caret_path({"caret": down}) != "0" and caret_path(status(d)) == "0", f"down={down}")
    rev_before_table = int(status(d)["revision"])
    click_cell(d, 0)
    c0 = status(d)["caret"]
    press(d, "Tab")
    c1 = status(d)["caret"]
    press(d, "Tab", shift=True)
    back = status(d)["caret"]
    check("docx: 표에서 Tab·Shift+Tab으로 셀 이동(이동은 revision 그대로)",
          caret_path({"caret": c0}).endswith(".0.0.0") and caret_path({"caret": c1}).endswith(".0.1.0")
          and caret_path({"caret": back}) == caret_path({"caret": c0}) and int(status(d)["revision"]) == rev_before_table,
          f"{c0} {c1} {back}")
    press(d, "End")
    press(d, "a", "b")
    st = status(d)
    check("docx: 표 셀 안 입력", st["paragraphText"].endswith("ab") and st["inTable"] == "true", json.dumps(st, ensure_ascii=False))
    # 지운 2글자(선택) + Delete + Enter + 합침 + 셀 입력 2글자 = 6번의 변경. 이동·선택·셀 이동 Tab은 세지 않는다.
    check("docx: 문서를 바꾼 키만 revision을 올림(이동·선택·셀 이동 Tab 제외)", int(st["revision"]) - rev0 == 6, f"{rev0}→{st['revision']}")


def scenario_revision(d) -> None:
    st = idle(d)
    active = next(s for s in ipc(d, "document_sessions")["ok"] if s["displayName"] == "basic-ko.docx")
    sid, rev, gen = active["sessionId"], active["revision"], active["loadGeneration"]
    check("docx: 백엔드 revision이 편집 표면의 판과 같고 dirty", active["revision"] == int(st["revision"]) and active["dirty"], json.dumps(active))
    stale = ipc(d, "docx_edit", {"sessionId": sid, "loadGeneration": gen, "baseRevision": max(0, rev - 1), "ops": [{"op": "insertText", "text": "x"}]})
    check("docx: 옛 기준 revision의 편집은 RevisionMismatch로 거부되고 아무것도 실행하지 않음",
          stale == {"err": {"code": "RevisionMismatch", "sessionId": sid, "revision": rev}}
          and ipc(d, "document_session", {"sessionId": sid})["ok"]["revision"] == rev, json.dumps(stale))
    old = ipc(d, "docx_edit", {"sessionId": sid, "loadGeneration": gen + 1, "baseRevision": rev, "ops": [{"op": "insertText", "text": "x"}]})
    check("docx: 다른 불러오기 시도 번호의 편집은 StaleLoad", old == {"err": {"code": "StaleLoad", "sessionId": sid, "loadGeneration": gen}}, json.dumps(old))
    frontend = [ipc(d, "document_commit", {"sessionId": sid, "loadGeneration": gen, "baseRevision": rev, "count": 1}),
                ipc(d, "document_set_state", {"sessionId": sid, "loadGeneration": gen, "from": "ready", "to": "failed"}),
                ipc(d, "document_load", {"sessionId": sid})]
    after = ipc(d, "document_session", {"sessionId": sid})["ok"]
    check("docx: 프런트엔드 모델용 확정·상태 전이·바이트 읽기는 WordCraft 세션에 InvalidRequest(revision 권한 하나)",
          all(r == {"err": {"code": "InvalidRequest"}} for r in frontend) and after["revision"] == rev and after["state"] == "ready",
          json.dumps(frontend))
    arbitrary = ipc(d, "docx_edit", {"sessionId": sid, "loadGeneration": gen, "baseRevision": rev,
                                     "ops": [{"op": "run", "id": "file.saveAs", "params": {"path": "/tmp/geul-x.docx"}}]})
    check("docx: 허용하지 않은 연산(임의 WordCraft 명령)은 거부되고 파일을 쓰지 않음",
          "err" in arbitrary and not Path("/tmp/geul-x.docx").exists() and ipc(d, "document_session", {"sessionId": sid})["ok"]["revision"] == rev,
          json.dumps(arbitrary, ensure_ascii=False)[:300])
    REPORT["docx"]["revision"] = rev


def scenario_roundtrip_ui(d) -> None:
    idle(d)
    press_button(d, "[data-testid=docx-roundtrip]")
    smoke.wait_until(d, "return document.querySelector('[data-testid=docx-roundtrip-result]') !== null", timeout=30)
    r = d.js("return {...document.querySelector('[data-testid=docx-roundtrip-result]').dataset}")
    check("docx: 편집한 문서를 메모리에서 DOCX로 내보내 다시 읽으면 쪽·본문 글자·문서 모델(서식·표 포함)이 같음(통과)",
          r.get("passed") == "true" and r.get("pagesEqual") == "true" and r.get("textEqual") == "true" and r.get("modelEqual") == "true", json.dumps(r))
    REPORT["docx"]["roundTripInApp"] = r
    click_paragraph_start(d)
    press(d, "End")
    press(d, "r")
    check("docx: 검사 뒤 문서를 바꾸면 이전 통과 결과가 사라짐", not d.exists("[data-testid=docx-roundtrip-result]"), json.dumps(status(d), ensure_ascii=False))


def samples(d) -> list[float]:
    raw = status(d).get("latencySamples", "")
    return [float(x) for x in raw.split(",") if x]


def percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, -(-int(q * len(ordered) * 1000) // 1000) - 1))]


def scenario_latency(d) -> None:
    click_paragraph_start(d)
    press(d, "End")
    before = int(status(d).get("latencyCount") or 0)
    start = len(samples(d))
    # 한 번에 한 키씩(T007과 같은 간격). 키마다 상태를 묻지 않는다: 키마다 WebDriver 스크립트를 여러 번 보내면 WebKitWebDriver
    # 연결이 끊겼다(앱·WebProcess는 살아 있음, 시험기 쪽 문제).
    for chunk in ["abcdefghij" * 4, "가나다라마바사아자차" * 4]:
        for ch in chunk:
            perform(d, [{"type": "key", "id": "kbd", "actions": [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]}])
            time.sleep(0.15)
        idle(d)
    st = status(d)
    count = int(st["latencyCount"]) - before
    typed = samples(d)[start:]
    p95 = percentile(typed, 0.95) if typed else float("nan")
    # 앞 시나리오의 키 표본은 시험기가 키마다 WebDriver 스크립트로 상태를 물으며(WebView 주 스레드와 경합) 잰 것이라 따로 보고만 한다.
    REPORT["docx"]["latency"] = {"typingSamples": len(typed), "typingP50": percentile(typed, 0.5) if typed else None, "typingP95": p95,
                                  "typingMax": max(typed) if typed else None, "allSamples": int(st["latencyCount"]),
                                  "allP50": float(st["latencyP50"]), "allP95": float(st["latencyP95"]), "allMax": float(st["latencyMax"])}
    print(f"[측정] 지연(전체 키 표본 {st['latencyCount']}개): p50 {st['latencyP50']} ms, p95 {st['latencyP95']} ms, 최대 {st['latencyMax']} ms", flush=True)
    check(f"docx: 키 입력→화면 반영 p95 {p95:.1f} ms(이 시나리오의 키 {len(typed)}개, 키 간격 150 ms, 개발 빌드) ≤ 150 ms",
          count >= 70 and len(typed) >= 70 and p95 <= 150, json.dumps(REPORT["docx"]["latency"]))


# ---- T008 안정화(붙여넣기·그림 실패·래스터 예산·닫기 보호) ----

INPUT = ".docx-surface .rhwp-input"
# WebKit 편집 명령으로 숨긴 textarea에 글자를 넣는다: WebKit이 실제 beforeinput/input을 만들고 앱의 입력 경로·IPC·Rust 엔진을 그대로
# 지난다(합성 DOM 이벤트가 아님). 실측: 줄바꿈이 있으면 beforeinput 하나 뒤에 줄마다 insertText·insertParagraph input이 따로 온다.
INSERT = """const i=document.querySelector(arguments[0]); i.focus(); return document.execCommand('insertText', false, arguments[1])"""
CTRL = "\ue009"
MAX_RETAINED_PIXELS = 32 * 1024 * 1024  # DocxEditorSession.MAX_RETAINED_PIXELS


def insert_text(d, text: str, timeout: float = 120, changes: bool = True) -> dict:
    """글자를 넣고, 화면 상태가 그 넣기를 반영할 때까지(revision이 바뀌거나 안내가 보임) 기다린 뒤 idle."""
    before = status(d).get("revision")
    if not d.js(INSERT, INPUT, text):
        raise smoke.Failure("execCommand insertText 실패")
    if changes:
        smoke.wait_until(d, f"return document.querySelector('{STATUS}').dataset.revision !== arguments[0]", before, timeout=timeout)
    else:
        smoke.wait_until(d, f"return document.querySelector('{STATUS}').dataset.inputNotice !== ''", timeout=10)
    time.sleep(0.3)
    return idle(d, timeout=timeout)


def brief(st: dict) -> str:
    return json.dumps({k: st.get(k) for k in ("status", "revision", "caret", "paragraphText", "inputNotice", "renderFailed", "pending")},
                      ensure_ascii=False)[:600]


def chord(d, key: str) -> None:
    perform(d, [{"type": "key", "id": "kbd", "actions": [{"type": "keyDown", "value": CTRL}, {"type": "keyDown", "value": key},
                                                          {"type": "keyUp", "value": key}, {"type": "keyUp", "value": CTRL}]}])


def clipboard_paste(d, text: str, timeout: float = 120) -> dict:
    """실제 시스템 클립보드 붙여넣기: 페이지의 임시 textarea에서 Ctrl+C(WebKit 복사 → X11 CLIPBOARD), 편집 입력에서 Ctrl+V(WebKit 붙여넣기)."""
    d.js("const t=document.createElement('textarea'); t.id='clip-src'; t.value=arguments[0]; document.body.appendChild(t); t.focus(); t.select();", text)
    chord(d, "c")
    time.sleep(0.3)
    d.js("document.getElementById('clip-src').remove(); window.__paste=[]; const i=document.querySelector(arguments[0]);"
         " i.addEventListener('input', e => window.__paste.push(e.inputType), {once: true}); i.focus()", INPUT)
    before = status(d).get("revision")
    chord(d, "v")
    smoke.wait_until(d, "return window.__paste.length > 0", timeout=10)
    smoke.wait_until(d, f"return document.querySelector('{STATUS}').dataset.revision !== arguments[0]", before, timeout=timeout)
    time.sleep(0.3)
    return idle(d, timeout=timeout)


def scenario_stabilization(d) -> None:
    # 표 셀의 탭 글자는 셀 이동이 아니다(아래 넣기로 표가 밀리기 전에, 고정 좌표로 누름).
    click_cell(d, 0)
    cell = status(d)
    after = insert_text(d, "a\tb")
    check("docx: 표 셀에 넣은 탭 글자는 셀 이동이 아니라 글자(같은 셀, revision +1)",
          after["inTable"] == "true" and caret_path(after) == caret_path(cell) and after["paragraphText"].startswith("a\tb")
          and int(after["revision"]) == int(cell["revision"]) + 1, json.dumps(after, ensure_ascii=False)[:300])
    click_paragraph_start(d)
    press(d, "End")  # 줄 끝(문단이 여러 줄이면 커서 뒤에 남은 글자가 있다)
    st = status(d)
    rev, tail = int(st["revision"]), st["paragraphText"][int(st["caretOffset"]):]
    # P1-A 여러 줄·탭: 문단을 나누고 편집이 이어진다. WebKit이 줄마다 나눠 보내는 input(insertText·insertParagraph 5개)마다 연산 하나.
    after = insert_text(d, "첫째 줄\n둘째\t줄\n셋째")
    check("docx: 여러 줄·탭 글자 넣기(WebKit이 줄마다 나눈 input)는 문단을 나누고 편집이 이어짐(줄 잃지 않음, input마다 revision +1)",
          after["status"] == "ready" and after["paragraphText"] == "셋째" + tail and int(after["revision"]) == rev + 5
          and caret_path(after) == "2" and after.get("inputNotice") == "", brief(after) + f" (전 revision {rev})")
    # 실제 클립보드 붙여넣기(X11만: 헤드리스 weston에는 키보드 seat가 없어 GTK 클립보드 단축키를 쓸 수 없음). CRLF·탭, input 하나.
    if os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        click_paragraph_start(d)
        press(d, "End")
        st = status(d)
        rev, tail = int(st["revision"]), st["paragraphText"][int(st["caretOffset"]):]
        after = clipboard_paste(d, "붙여 첫째\r\n붙여\t둘째\n붙여 셋째")
        check("docx: 실제 클립보드 붙여넣기(CRLF·LF·탭)는 문단을 나누고 붙여넣기 하나 = revision +1(편집이 이어짐)",
              after["status"] == "ready" and after["paragraphText"] == "붙여 셋째" + tail and int(after["revision"]) == rev + 1
              and d.js("return window.__paste[0]") == "insertFromPaste", brief(after) + f" (전 revision {rev})")
        REPORT.setdefault("stabilization", {})["clipboardPaste"] = True
    else:
        print("[참고] 실제 클립보드 붙여넣기: X11이 아니어서 건너뜀(헤드리스 weston에 키보드 seat 없음)", flush=True)
    click_paragraph_start(d)
    press(d, "End")
    after = status(d)
    # 4096자 넘는 글자(한글·ASCII·이모지): 글자 경계 조각으로 모두, 순서대로.
    long = ("한글ASCII😀𝄞" * 1000)[:9000]
    rev, at = int(after["revision"]), int(after["caretOffset"])
    head, tail = after["paragraphText"][:at], after["paragraphText"][at:]
    started = time.monotonic()
    after = insert_text(d, long)
    REPORT.setdefault("stabilization", {})["long9000Ms"] = round((time.monotonic() - started) * 1000)
    check("docx: 4096자를 넘는 글자(9,000자, 이모지 포함)는 조각으로 모두 순서대로 들어감(revision +3)",
          after["status"] == "ready" and after["paragraphText"] == head + long + tail and int(after["revision"]) == rev + 3,
          f"revision {rev}→{after['revision']}, 길이 {len(after['paragraphText'])}")
    # 넣을 수 없는 제어 문자: 넣지 않고 알림, 편집은 이어 감.
    rev = int(after["revision"])
    after = insert_text(d, "a\u0007b", changes=False)
    check("docx: 넣을 수 없는 제어 문자는 넣지 않고 알림(문서·revision 그대로, ready)",
          after["status"] == "ready" and after.get("inputNotice") == "pasteUnsupported" and int(after["revision"]) == rev
          and d.exists("[data-testid=docx-input-notice]"), json.dumps({k: after.get(k) for k in ("status", "inputNotice", "revision")}))

    # P1-B 그림 실패: WebView의 PNG 디코드(createImageBitmap)를 실패시키고 편집 → 몇 번 다시 시도 뒤 실패를 보이며 편집을 멈춘다.
    click_paragraph_start(d)
    before = status(d)
    d.js("window.__cib = window.createImageBitmap; window.createImageBitmap = () => Promise.reject(new Error('시험 주입'))")
    perform(d, [{"type": "key", "id": "kbd", "actions": [{"type": "keyDown", "value": "x"}, {"type": "keyUp", "value": "x"}]}])
    smoke.wait_until(d, f"return document.querySelector('{STATUS}')?.dataset.renderFailed !== ''", timeout=20)
    failed = status(d)
    shown = d.js("const p=document.querySelector('.docx-page'); return {alert: !!document.querySelector('[data-testid=docx-render-failed]'),"
                 " current: p.dataset.current, marked: p.dataset.renderFailed, disabled: document.querySelector(arguments[0]).disabled}", INPUT)
    check("docx: 편집 뒤 지금 판의 그림이 계속 실패하면 ready로 숨기지 않고 실패를 보이며 편집을 멈춤(편집한 내용은 미보존 보호)",
          failed["status"] == "ready" and failed["renderFailed"] == "0" and int(failed["revision"]) == int(before["revision"]) + 1
          and failed["unpreserved"] == "true" and shown["alert"] and shown["current"] == "false" and shown["marked"] == "true" and shown["disabled"],
          json.dumps({"status": failed, "shown": shown}, ensure_ascii=False)[:500])
    d.js("window.createImageBitmap = window.__cib")
    press_button(d, "[data-testid=docx-render-retry]")
    recovered = idle(d)
    check("docx: 다시 그리기로 지금 판의 그림을 받아 편집을 이어 감",
          recovered["renderFailed"] == "" and not d.exists("[data-testid=docx-render-failed]")
          and not d.js("return document.querySelector(arguments[0]).disabled", INPUT), json.dumps(recovered, ensure_ascii=False)[:300])

    # P2-A 여러 쪽: 여러 쪽 문서를 만들고 끝까지 스크롤한 뒤 화면 canvas가 잡은 픽셀을 잰다. X11이면 실제 클립보드로 262,144자(줄 64자마다
    # 문단, input 하나 → 64조각)를 붙여 넣는다. execCommand로 같은 글자를 넣으면 WebKit이 줄마다 input을 나눠(8,192개 연산) 시험기 시간이
    # 길어지므로, 그 밖의 환경에서는 한 줄 4,000자 넣기 60번으로 만든다.
    click_paragraph_start(d)
    press(d, "End")
    rev = int(status(d)["revision"])
    started = time.monotonic()
    if os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        big = ("가나다라마바사 abcdefg " * 4)[:63] + "\n"
        after = clipboard_paste(d, big * 4096, timeout=300)
        expected, how = rev + 64, f"실제 클립보드 {len(big) * 4096:,}자(64조각)"
    else:
        for _ in range(60):
            after = insert_text(d, ("가나다라마바사 abcdefg " * 300)[:4000], timeout=120)
        expected, how = rev + 60, "4,000자 넣기 60번"
    paste_ms = round((time.monotonic() - started) * 1000)
    pages = int(after["pages"])
    check(f"docx: {how}가 모두 들어가 여러 쪽 문서가 됨({pages}쪽, {paste_ms} ms)",
          after["status"] == "ready" and int(after["revision"]) == expected and pages > 100, brief(after))
    started = time.monotonic()
    step = d.js("return document.querySelector('.editor__scroll').clientHeight")
    total = d.js("return document.querySelector('.editor__scroll').scrollHeight")
    top = 0
    while top < total:
        top += step
        d.js("document.querySelector('.editor__scroll').scrollTop = arguments[0]", top)
        idle(d, timeout=60)
    measured = d.js("""const cs=[...document.querySelectorAll('.docx-page canvas')]; const live=cs.filter(c => c.width > 0);
        const s=document.querySelector('.editor__scroll').getBoundingClientRect();
        const visible=[...document.querySelectorAll('.docx-page')].filter(p => { const r=p.getBoundingClientRect(); return r.bottom > s.top && r.top < s.bottom; }).length;
        return {canvases: cs.length, live: live.length, pixels: live.reduce((n, c) => n + c.width*c.height, 0), visible,
                first: cs[0].width, pagePixels: live.length ? live[0].width*live[0].height : 0}""")
    measured.update({"pages": pages, "scrollMs": round((time.monotonic() - started) * 1000), "pasteMs": paste_ms})
    REPORT["stabilization"]["multiPage"] = measured
    print(f"[측정] 여러 쪽 스크롤: {json.dumps(measured)}", flush=True)
    check(f"docx: {pages}쪽을 끝까지 스크롤해도 화면 canvas 픽셀이 예산 안({measured['live']}개, {measured['pixels']:,} px)이고 지나간 쪽은 놓음",
          measured["pixels"] <= MAX_RETAINED_PIXELS + measured["visible"] * measured["pagePixels"] and measured["first"] == 0
          and measured["live"] < pages, json.dumps(measured))
    d.js("document.querySelector('.editor__scroll').scrollTop = 0")
    back = idle(d, timeout=60)
    check("docx: 다시 처음으로 스크롤하면 놓았던 쪽을 다시 그림",
          d.js("return document.querySelector('.docx-page').dataset.current === 'true' && document.querySelector('.docx-page canvas').width > 0"),
          json.dumps(back, ensure_ascii=False)[:200])


def screen_hash(d) -> list:
    """첫 쪽 화면 canvas의 크기와 픽셀 표본 해시(앱이 문맥을 막아 둔 동안에도 원래 getContext로 읽는다)."""
    return d.js("""const c=document.querySelector('.docx-page canvas'); const g=window.__origGetContext || HTMLCanvasElement.prototype.getContext;
        const x=g.call(c, '2d').getImageData(0, 0, c.width, c.height).data; let h=0; for (let k=0; k<x.length; k+=97) h=(h*31+x[k])|0;
        return [c.width, c.height, h]""")


def paragraphs_above(d, count: int) -> list[str]:
    """커서 문단과 그 위 count개 문단의 글자(위에서부터). 위 방향키로 옮기며 읽는다(문서를 바꾸지 않음)."""
    texts = [status(d)["paragraphText"]]
    for _ in range(count):
        press(d, "Up")
        texts.insert(0, status(d)["paragraphText"])
    return texts


# 화면 밖 래스터(문서에 붙지 않은 canvas)를 세고, PNG 디코드(createImageBitmap)를 붙잡을 수 있게 한다. IPC(__TAURI_INTERNALS__.invoke)는
# 바꿀 수 없어(writable false, 실측) 그림 응답 대신 디코드를 붙잡는다.
RENDER_HOOKS = """window.__created=[]; window.__decodes=0; window.__closed=0; window.__heldDecode=[]; window.__holdDecode=false;
  window.__origCreateElement=document.createElement; window.__origCIB=window.createImageBitmap;
  document.createElement = function(tag, ...rest) { const e=window.__origCreateElement.call(document, tag, ...rest);
    if (String(tag).toLowerCase()==='canvas') window.__created.push(e); return e; };
  window.createImageBitmap = function(...args) { window.__decodes++;
    const p=window.__origCIB.apply(window, args).then(b => { const close=b.close.bind(b); b.close=() => { window.__closed++; close(); }; return b; });
    return window.__holdDecode ? new Promise((res, rej) => window.__heldDecode.push(() => p.then(res, rej))) : p; };"""
RENDER_UNHOOK = """document.createElement=window.__origCreateElement; window.createImageBitmap=window.__origCIB;
  if (window.__origGetContext) HTMLCanvasElement.prototype.getContext=window.__origGetContext; window.__created=[];"""


def click_tab(d, name: str) -> None:
    """탭만 고른다(그림을 기다리지 않음)."""
    d.js("[...document.querySelectorAll('.document-tab__select')].find(t => t.textContent.replace(/^● /,'').startsWith(arguments[0])).click()", name)
    smoke.wait_until(d, f"return document.querySelector('{STATUS} h1')?.textContent === arguments[0]", name, timeout=10)


def scenario_second_stabilization(d, fixtures: Path) -> None:
    """T008 2차 안정화: 줄마다 나뉜 CRLF 넣기, 화면 canvas 그리기 실패·회복, 그림을 기다리는 동안의 탭 전환."""
    d.js("document.querySelector('.editor__scroll').scrollTop = 0")
    idle(d)
    # CRLF: WebKit은 execCommand('insertText', '가\r\n나')를 insertText '가\r' · insertParagraph · insertText '나' input으로 나눈다(실측).
    # 문단 구조는 원래 글자와 같아야 한다(CRLF 하나 = 문단 나누기 하나, LF 둘 = 빈 줄 하나).
    for name, text, lines, revisions in [
        ("CRLF", "가\r\n나", ["가"], 2),
        ("CRLF 빈 줄", "가\r\n\r\n나", ["가", ""], 3),
        ("끝의 CRLF", "가\r\n", ["가"], 1),
        ("LF 빈 줄", "가\n\n나", ["가", ""], 4),
    ]:
        click_paragraph_start(d)
        st = status(d)
        rev, path, tail = int(st["revision"]), int(caret_path(st)), st["paragraphText"]
        after = insert_text(d, text)
        last = ("나" if text.endswith("나") else "") + tail
        got = paragraphs_above(d, len(lines))
        check(f"docx: 줄마다 나뉜 {name} 글자 넣기는 원래 문단 구조 그대로(빈 문단이 더 생기지 않음, revision +{revisions})",
              got == lines + [last] and int(caret_path(after)) == path + len(lines) and int(after["revision"]) == rev + revisions,
              json.dumps({"got": got[:-1] + [got[-1][:20]], "path": [path, caret_path(after)], "revision": [rev, after["revision"]]}, ensure_ascii=False))

    # 화면 canvas 2D 문맥 없음(문서에 붙은 canvas만, 화면 밖 래스터는 그대로): 지금 판으로 보이지 않고, 몇 번 다시 그려 본 뒤 실패를
    # 보이며 편집을 멈춘다. 문맥이 돌아온 뒤 다시 그리기는 PNG를 다시 받지 않고 실제로 다시 그린다.
    d.js(RENDER_HOOKS)
    try:
        click_paragraph_start(d)
        before, st0 = screen_hash(d), status(d)
        d.js("window.__origGetContext=HTMLCanvasElement.prototype.getContext; window.__nullCalls=0;"
             " HTMLCanvasElement.prototype.getContext=function(...a) { if (this.isConnected) { window.__nullCalls++; return null; }"
             " return window.__origGetContext.apply(this, a); }")
        perform(d, [{"type": "key", "id": "kbd", "actions": [{"type": "keyDown", "value": "x"}, {"type": "keyUp", "value": "x"}]}])
        smoke.wait_until(d, f"return document.querySelector('{STATUS}').dataset.renderFailed !== ''", timeout=20)
        time.sleep(1.0)
        failed = status(d)
        shown = d.js("const p=document.querySelector('.docx-page'); return {current: p.dataset.current, revision: p.dataset.revision,"
                     " marked: p.dataset.renderFailed ?? '', alert: !!document.querySelector('[data-testid=docx-render-failed]'),"
                     " disabled: document.querySelector(arguments[0]).disabled, nullCalls: window.__nullCalls, decodes: window.__decodes}", INPUT)
        during = screen_hash(d)
        visible = len(failed["renderFailed"].split(","))
        check("docx: 화면 canvas 문맥이 없으면 지금 판으로 표시하지 않고(첫 쪽 current false) 몇 번만 다시 그려 본 뒤 실패를 보이며 편집을 멈춤"
              "(편집은 미보존 보호, ready 유지)",
              failed["status"] == "ready" and int(failed["revision"]) == int(st0["revision"]) + 1 and failed["unpreserved"] == "true"
              and shown["current"] == "false" and shown["revision"] == failed["revision"] and shown["marked"] == "true" and shown["alert"]
              and shown["disabled"] and shown["nullCalls"] <= 3 * visible and during == before,
              json.dumps({"status": brief(failed), "shown": shown, "screen": [before, during]}, ensure_ascii=False)[:600])
        d.js("HTMLCanvasElement.prototype.getContext=window.__origGetContext")
        press_button(d, "[data-testid=docx-render-retry]")
        recovered = idle(d)
        repainted = d.js("const p=document.querySelector('.docx-page'); return {current: p.dataset.current, decodes: window.__decodes,"
                         " disabled: document.querySelector(arguments[0]).disabled}", INPUT)
        after = screen_hash(d)
        check("docx: 문맥이 돌아온 뒤 다시 그리기는 PNG를 다시 받지 않고 화면에 실제로 다시 그려 편집을 이어 감",
              recovered["renderFailed"] == "" and repainted["current"] == "true" and not repainted["disabled"]
              and repainted["decodes"] == shown["decodes"] and after != before,
              json.dumps({"status": brief(recovered), "repainted": repainted, "screen": [before, after]}, ensure_ascii=False)[:500])

        # 탭 전환: 다른 탭 표면이 쪽 전체 디코드를 기다리는 동안 원래 탭으로 돌아오면, 놓은 표면의 늦은 디코드는 화면 밖 래스터를 다시
        # 만들지 않는다(그림은 닫음). 돌아온 탭은 지금 판을 그리고 편집한 내용·입력이 이어진다.
        shutil.copy(fixtures / "basic-ko.docx", fixtures / "basic-ko-b.docx")
        open_document(d, fixtures / "basic-ko-b.docx")
        select_tab(d, "basic-ko.docx")
        click_paragraph_start(d)
        st1 = status(d)
        d.js("window.__holdDecode=true; window.__created=[]")
        click_tab(d, "basic-ko-b.docx")
        smoke.wait_until(d, "return window.__heldDecode.length >= 1", timeout=10)
        click_tab(d, "basic-ko.docx")
        smoke.wait_until(d, "return window.__heldDecode.length >= 2", timeout=10)
        closed = d.js("return window.__closed")
        d.js("window.__heldDecode.shift()()")  # 놓은 탭(basic-ko-b.docx)의 늦은 디코드
        time.sleep(1.0)
        stale = d.js("return {live: window.__created.filter(c => !c.isConnected && c.width > 0).length, closed: window.__closed}")
        d.js("window.__holdDecode=false; const g=window.__heldDecode; window.__heldDecode=[]; g.forEach(go => go())")
        back = idle(d)
        page = d.js("const p=document.querySelector('.docx-page'); return {current: p.dataset.current, revision: p.dataset.revision,"
                    " width: p.querySelector('canvas').width}")
        check("docx: 그림을 기다리는 동안 탭을 바꾸면 놓은 표면의 늦은 그림은 화면 밖 래스터를 다시 만들지 않고(그림은 닫음),"
              " 돌아온 탭은 지금 판을 그리며 편집한 내용이 그대로",
              stale["live"] == 0 and stale["closed"] == closed + 1 and back["status"] == "ready" and back["revision"] == st1["revision"]
              and back["paragraphText"] == st1["paragraphText"] and page["current"] == "true" and page["revision"] == st1["revision"]
              and page["width"] > 0, json.dumps({"stale": stale, "page": page, "status": brief(back)}, ensure_ascii=False)[:500])
        before_typing = int(back["revision"])
        perform(d, [{"type": "key", "id": "kbd", "actions": [{"type": "keyDown", "value": "w"}, {"type": "keyUp", "value": "w"}]}])
        smoke.wait_until(d, f"return document.querySelector('{STATUS}').dataset.revision !== arguments[0]", str(before_typing), timeout=10)
        typed = idle(d)
        check("docx: 돌아온 탭에서 입력이 이어짐(revision +1, 커서 자리에 한 번)",
              int(typed["revision"]) == before_typing + 1 and typed["paragraphText"] == "w" + st1["paragraphText"], brief(typed))
    finally:
        d.js(RENDER_UNHOOK)
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes('basic-ko-b.docx')).click()")
    smoke.wait_until(d, "return document.querySelectorAll('.document-tab__close').length === 1", timeout=10)
    select_tab(d, "basic-ko.docx")


SAVE_RESULT = "[data-testid=docx-save-result]"


def save_and_wait(d, timeout: float = 60) -> dict:
    """저장 단추를 누르고 결과(saved·failed)가 나올 때까지 기다린다."""
    press_button(d, "[data-testid=docx-save]")
    smoke.wait_until(d, f"const e=document.querySelector('{SAVE_RESULT}'); return e && ['saved','failed'].includes(e.dataset.state)",
                     timeout=timeout)
    return d.js(f"return {{...document.querySelector('{SAVE_RESULT}').dataset}}")


def type_keys(d, text: str) -> dict:
    """ASCII 글자를 실제 키로 치고 백엔드 확정까지 기다린다."""
    before = int(status(d)["revision"])
    actions = []
    for ch in text:
        actions += [{"type": "keyDown", "value": ch}, {"type": "keyUp", "value": ch}]
    perform(d, [{"type": "key", "id": "kbd", "actions": actions}])
    smoke.wait_until(d, f"return Number(document.querySelector('{STATUS}').dataset.revision) >= arguments[0]", before + len(text), timeout=20)
    return idle(d)


def close_without_prompt(d, name: str) -> bool:
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", name)
    time.sleep(0.5)
    if d.exists("[data-testid=discard-dialog]"):
        press_button(d, "[data-testid=discard-cancel]")
        return False
    smoke.wait_until(d, "return ![...document.querySelectorAll('.document-tab__select')].some(t => t.textContent.includes(arguments[0]))",
                     name, timeout=10)
    return True


def discard_close(d, name: str) -> None:
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes(arguments[0])).click()", name)
    smoke.wait_until(d, "return document.querySelector('[data-testid=discard-dialog]')?.dataset.action === 'close'", timeout=10)
    press_button(d, "[data-testid=discard-confirm]")
    smoke.wait_until(d, "return ![...document.querySelectorAll('.document-tab__select')].some(t => t.textContent.includes(arguments[0]))",
                     name, timeout=10)


def scenario_save(d, fixtures: Path) -> None:
    """T009: 실제 앱에서 DOCX 원본 형식 저장 → 파일 → 다시 열기, 막힌 저장·외부 수정은 원본 그대로."""
    import zipfile
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    path = fixtures / "save-basic.docx"
    shutil.copy(fixtures / "basic-ko.docx", path)
    original = digest(path)
    open_document(d, path)
    click_paragraph_start(d)
    typed = type_keys(d, "T9")
    check("docx: 편집 뒤 저장 전에는 파일이 그대로이고 저장하지 않은 편집으로 보임",
          digest(path) == original and typed["dirty"] == "true" and typed["unpreserved"] == "true", brief(typed))
    result = save_and_wait(d)
    after = status(d)
    with zipfile.ZipFile(path) as z:
        valid = z.testzip() is None and "word/document.xml" in z.namelist()
    check("docx: 사전 검사(편집 없는 WordCraft 왕복 safe)를 거쳐 원본 형식으로 저장하고 dirty가 풀림(파일이 바뀌고 ZIP이 올바름)",
          result["state"] == "saved" and result["revision"] == after["revision"] and after["dirty"] == "false"
          and after["unpreserved"] == "false" and digest(path) != original and valid, json.dumps({"result": result, "status": brief(after)}, ensure_ascii=False))
    check("docx: 저장한 문서는 버리기 확인 없이 닫힘", close_without_prompt(d, path.name))
    reopened = open_document(d, path)
    click_paragraph_start(d)
    text = status(d)["paragraphText"]
    check("docx: 저장한 파일을 앱에서 다시 열면 넣은 글자가 있고 편집 가능", reopened["status"] == "ready" and text.startswith("T9"),
          json.dumps({"status": reopened.get("status"), "start": text[:12]}, ensure_ascii=False))
    # 외부 수정.
    type_keys(d, "X")
    changed = path.read_bytes() + b"\0"
    path.write_bytes(changed)
    result = save_and_wait(d)
    check("docx: 연 뒤 파일이 바뀌면(외부 수정) FileConflict로 저장하지 않고 바뀐 파일을 덮어쓰지 않음",
          result["state"] == "failed" and result["error"] == "FileConflict" and path.read_bytes() == changed, json.dumps(result))
    discard_close(d, path.name)
    # 엔진 왕복이 원본을 지키지 못하는 문서(합성 변형, 생성 픽스처에서 결정적으로 만든다).
    def variant(name: str, change, extra: tuple[str, bytes] | None = None) -> Path:
        target = fixtures / name
        with zipfile.ZipFile(fixtures / "basic-ko.docx") as zin, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                zout.writestr(item, change(item.filename, zin.read(item.filename)))
            if extra:
                zout.writestr(extra[0], extra[1])
        return target
    cases = [
        ("WordCraft가 모르는 부분(customXml)이 있음", variant("save-custom.docx", lambda n, b: b, ("customXml/item1.xml", b'<root xmlns="urn:x"><v>1</v></root>')),
         "unsafe", "partMissing:customXml/item1.xml"),
        # 글자 요소 안에서 자른다(T008 J: WordCraft는 끊긴 곳까지 읽어 연다. 속성·UTF-8 가운데를 자르면 열지 않는다).
        ("본문 XML이 잘림(WordCraft는 끊긴 곳까지 읽어 엶)",
         variant("save-cut.docx", lambda n, b: b[: b.rfind(b"</w:t>", 0, len(b) * 2 // 3)] if n == "word/document.xml" else b),
         "unknown", "originalMalformed:word/document.xml"),
    ]
    for label, target, outcome, finding in cases:
        before = target.read_bytes()
        st = open_document(d, target)
        click_paragraph_start(d)
        type_keys(d, "Z")
        result = save_and_wait(d)
        check(f"docx: {label} → 저장하지 않고({outcome}) 이유를 보이며 원본 그대로",
              st["status"] == "ready" and result["state"] == "failed" and result["error"] == "UnsafeSave" and result["outcome"] == outcome
              and finding in result["findings"].split(",") and target.read_bytes() == before and d.exists("[data-testid=save-findings]"),
              json.dumps(result, ensure_ascii=False))
        discard_close(d, target.name)
    leftovers = [p.name for p in fixtures.iterdir() if p.name.startswith(".geul-save-")]
    check("docx: 저장 시도 뒤 임시 파일(.geul-save-*.tmp)이 남지 않음", leftovers == [], json.dumps(leftovers))
    select_tab(d, "basic-ko.docx")


def scenario_restart_inactive_close(d, fixtures: Path) -> None:
    """P2-C: WebView를 다시 시작한 뒤 아직 보지 않은 dirty DOCX 탭도 버리기 확인 없이 닫지 않는다."""
    shutil.copy(fixtures / "basic-ko.docx", fixtures / "basic-ko-c.docx")
    open_document(d, fixtures / "basic-ko-c.docx")  # 편집한 basic-ko.docx는 비활성 탭
    d.js("location.reload()")
    smoke.wait_until(d, "return document.querySelectorAll('.document-tab__close').length === 2", timeout=30)
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes('basic-ko.docx')).click()")
    smoke.wait_until(d, "return document.querySelector('[data-testid=discard-dialog]')?.dataset.action === 'close'", timeout=10)
    press_button(d, "[data-testid=discard-cancel]")
    sessions = ipc(d, "document_sessions")["ok"]
    check("docx: WebView 다시 시작 뒤 아직 보지 않은 dirty 탭도 닫기 전에 버리기를 확인(취소하면 세션 그대로)",
          any(s["displayName"] == "basic-ko.docx" and s["dirty"] for s in sessions), json.dumps(sessions, ensure_ascii=False)[:300])
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes('basic-ko-c.docx')).click()")
    smoke.wait_until(d, "return document.querySelectorAll('.document-tab__close').length === 1", timeout=10)
    select_tab(d, "basic-ko.docx")


def scenario_webview_restart(d) -> None:
    """WebView를 다시 시작해도 WordCraft 모델은 백엔드에 남아 편집 표면이 다시 붙는다(W-A)."""
    st = idle(d)
    text, rev = st["paragraphText"], st["revision"]
    d.js("location.reload()")
    smoke.wait_until(d, "return document.querySelector('.document-bar') !== null", timeout=30)
    after = wait_status(d, "ready", timeout=30)
    after = idle(d)
    check("docx: WebView 다시 시작 뒤 백엔드 모델에 다시 붙어 편집한 내용·revision이 그대로(ready)",
          after["paragraphText"] == text and after["revision"] == rev and after["dirty"] == "true", json.dumps(after, ensure_ascii=False))


def scenario_lifecycle(d, fixtures: Path, meta: dict, original_hash: str) -> None:
    path = fixtures / "basic-ko.docx"
    check("docx: 저장하지 않은 편집은 원본 파일 바이트를 바꾸지 않음", hashlib.sha256(path.read_bytes()).hexdigest() == original_hash)
    # 다시 불러오기: 편집한 모델을 버리는 것이므로 확인을 거친다(백엔드가 그 시도의 ready 모델을 버리고 파일에서 새로 읽음).
    gen0 = int(status(d)["generation"])
    d.js("[...document.querySelectorAll('.document-tab__close')].find(b => b.getAttribute('aria-label').includes('basic-ko.docx')).click()")
    smoke.wait_until(d, "return document.querySelector('[data-testid=discard-dialog]')?.dataset.action === 'close'", timeout=10)
    press_button(d, "[data-testid=discard-cancel]")
    check("docx: 저장하지 않은 편집이 있으면 닫기 전에 버리기를 확인(취소하면 그대로)", status(d)["status"] == "ready", json.dumps(status(d)))
    # 파일이 판별 뒤 바뀌면 다시 불러오기가 FileChanged로 거부된다.
    sid = next(s for s in ipc(d, "document_sessions")["ok"] if s["displayName"] == "basic-ko.docx")["sessionId"]
    reloaded = ipc(d, "docx_load", {"sessionId": sid, "reloadGeneration": gen0})
    check("docx: 백엔드 다시 불러오기는 그 시도의 ready 모델(편집)을 버리고 파일에서 새로 읽음(새 시도 번호, dirty 아님)",
          "ok" in reloaded and reloaded["ok"]["session"]["loadGeneration"] == gen0 + 1 and reloaded["ok"]["session"]["dirty"] is False
          and reloaded["ok"]["view"]["paragraphText"] == meta["content"]["paragraphs"][0], json.dumps(reloaded, ensure_ascii=False)[:300])
    path.write_bytes(path.read_bytes() + b"\0")
    changed = ipc(d, "docx_load", {"sessionId": sid, "reloadGeneration": gen0 + 1})
    check("docx: 판별 뒤 파일이 바뀌면 다시 불러오기는 FileChanged로 거부되고 세션은 failed", changed == {"err": {"code": "FileChanged"}}
          and ipc(d, "document_session", {"sessionId": sid})["ok"]["state"] == "failed", json.dumps(changed))


# ---- 실제 한국어 IME 게이트 ----

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
    # T008 안정화 P1-C(선택 항목): 선택한 글자 위의 조합.
    ("선택 위 조합 확정: 선택을 한 번 바꾸고 확정 글자는 한 번(선택 지우기·음절·공백마다 revision 1)", False),
    ("선택 위 조합 취소(미리보기 뒤 BackSpace로 비움): 선택만 지워지고(계약) 조합 글자는 남지 않음", False),
]
GATE: dict[str, tuple[str, str]] = {}


def gate(name: str, result: str, detail: str = "") -> None:
    assert name in dict(IME_ITEMS) and result in ("PASS", "FAIL", "UNVERIFIED", "NOT RUN")
    GATE[name] = (result, detail)
    print(f"[{result}] {name}" + (f" — {detail}" if detail else ""), flush=True)


def ime_environment(xdotool: str, ibus: str) -> str | None:
    if not os.environ.get("DISPLAY"):
        return "X11 DISPLAY 없음(xdotool 실제 키 입력 불가)"
    if os.environ.get("GTK_IM_MODULE") != "ibus":
        return "GTK_IM_MODULE=ibus가 아님(앱이 ibus 입력기를 쓰지 않음)"
    for tool in (xdotool, ibus):
        if not (Path(tool).exists() or shutil.which(tool)):
            return f"{Path(tool).name} 없음"
    return None


EVENT_LOG = """window.__imeLog=[]; const i=document.querySelector('.docx-surface .rhwp-input');
  for (const t of ['keydown','compositionstart','compositionupdate','compositionend','input','blur','focus'])
    i.addEventListener(t, e => window.__imeLog.push([t, e.isComposing ?? null, e.inputType ?? null, (e.data ?? '').length]), true);"""


def settle(d, step: str, quiet: float = 0.7, timeout: float = 30.0) -> dict:
    """실제 키·클릭을 페이지가 모두 처리할 때까지 기다린다(rhwp_poc.settle과 같고, 보내는 중인 연산 수를 더 본다)."""
    start = time.monotonic()
    last, changed = None, start
    while True:
        now = time.monotonic()
        current = d.js(f"const e=document.querySelector('{STATUS}'); const s=e ? e.dataset : {{}};"
                       " return [(window.__imeLog || []).length, s.paragraphText, s.caret, s.composing, s.composition, s.revision, s.pending]")
        if current != last or (current and current[-1] != "0"):
            last, changed = current, now
        elif now - changed >= quiet:
            break
        if now - start > timeout:
            raise smoke.Failure(f"입력 처리가 {timeout:.0f}초 안에 끝나지 않음({step})")
        time.sleep(0.05)
    REPORT.setdefault("imeDrain", []).append({"step": step, "seconds": round(changed - start, 2)})
    return status(d)


def scenario_ime(d, fixtures: Path, xdotool: str, ibus: str, focus_window: str | None, shots: Path | None) -> None:
    run = lambda *a: subprocess.run(["env", "-u", "LD_LIBRARY_PATH", *a], capture_output=True, text=True)
    REPORT["imeEnvironment"] = {"ibusEngine": run(ibus, "engine").stdout.strip(), "ibusVersion": run(ibus, "version").stdout.strip()}
    results: dict[str, list[tuple[str, str]]] = {name: [] for name, _ in IME_ITEMS}

    def record(name: str, ok: bool, detail: str) -> None:
        results[name].append(("PASS" if ok else "FAIL", detail))

    shutil.copy(fixtures / "basic-ko.docx", fixtures / "basic-ko-b.docx")
    open_document(d, fixtures / "basic-ko-b.docx")
    open_document(d, fixtures / "basic-ko.docx")
    window = run(xdotool, "search", "--onlyvisible", "--name", "^geul").stdout.split()[-1]
    run(xdotool, "windowfocus", "--sync", window)
    run(ibus, "engine", "hangul")
    d.js(EVENT_LOG)
    top = d.js("return window.outerHeight - window.innerHeight")
    origin = page_origin(d)
    d.js("window.__down=null; window.addEventListener('mousedown', e => { window.__down=[e.clientX, e.clientY]; }, true)")
    # 첫 문단 글자 끝 오른쪽 빈 곳 → 첫 문단 끝. 이 클릭의 mousedown 위치로 창 좌표↔페이지 좌표 차이를 잰다.
    first = (int(origin[0] + 520 * PT), int(origin[1] + PARA0_Y * PT + top))
    run(xdotool, "mousemove", "--window", window, str(first[0]), str(first[1]), "click", "1")
    time.sleep(0.4)
    down = d.js("return window.__down")
    shift = (first[0] - down[0], first[1] - down[1]) if down else (0, top)
    before = settle(d, "첫 문단 끝 클릭")
    base_text, base_rev = before["paragraphText"], int(before["revision"])
    base_caret = caret_client(d)

    # 1) 조합 중 표시: 'ㅎ+ㅏ'만 누르고(확정 안 함) 겹침·커서·모델을 본다
    run(xdotool, "type", "--delay", "90", "gk")
    mid = settle(d, "ㅎㅏ")
    overlay = d.js("const o=document.querySelector('[data-testid=docx-composition]'); const c=document.querySelector('[data-testid=docx-caret]');"
                   " if(!o||!c) return null; const r=o.getBoundingClientRect(), k=c.getBoundingClientRect();"
                   " return {text: o.textContent, visible: getComputedStyle(o).visibility, left: r.left, right: r.right, top: r.top, caretX: k.left + k.width/2}")
    if shots:
        d.screenshot(shots / "docx-ime-preedit.png")
    shown = (mid.get("composing") == "true" and mid.get("composition") == "하" and overlay and overlay["text"] == "하"
             and overlay["visible"] == "visible" and abs(overlay["left"] - base_caret[0]) <= 3)
    record("조합 중 글자가 문서에 보임(preedit)", bool(shown and mid["paragraphText"] == base_text and int(mid["revision"]) == base_rev),
           f"composing={mid.get('composing')}, 겹침={overlay}, 모델 그대로={mid['paragraphText'] == base_text}")
    record("조합 중 커서가 조합 글자 뒤에 있음", bool(overlay and overlay["caretX"] >= overlay["right"] - 2 and overlay["right"] > overlay["left"] + 2),
           f"겹침 오른쪽 {overlay and round(overlay['right'], 1)}, 커서 {overlay and round(overlay['caretX'], 1)}")

    # 2) '한글 입력 테스트' 확정
    run(xdotool, "type", "--delay", "90", "srmf dlqfur xptmxm")
    run(xdotool, "key", "End")
    after = settle(d, "한글 입력 테스트")
    record("확정 글자가 커서 위치에 정확히 한 번, 음절 누락 없음", after["paragraphText"] == base_text + "한글 입력 테스트",
           f"넣은 부분 {after['paragraphText'][len(base_text):]!r}")
    record("확정 음절·공백마다 revision 1(조합 중간은 확정 안 함)", int(after["revision"]) - base_rev == 9, f"{base_rev}→{after['revision']}")
    REPORT.setdefault("docx", {})["ime"] = {"events": ime_counts(d.js("return window.__imeLog"))}

    # 3) '가가'
    text0, rev0 = after["paragraphText"], int(after["revision"])
    run(xdotool, "type", "--delay", "90", "rkrk")
    run(xdotool, "key", "End")
    st = settle(d, "가가")
    record("같은 음절을 연달아 확정해도 모두 남음", st["paragraphText"] == text0 + "가가" and int(st["revision"]) - rev0 == 2,
           f"넣은 부분 {st['paragraphText'][len(text0):]!r}, revision +{int(st['revision']) - rev0}")

    # 4) 조합 중 ←
    text0 = st["paragraphText"]
    run(xdotool, "type", "--delay", "90", "rk")
    run(xdotool, "key", "Left")
    st = settle(d, "가 + ←")
    record("조합 중 ←는 조합 글자를 그 자리에 확정한 뒤 이동",
           st["paragraphText"] == text0 + "가" and int(st["caretOffset"]) == len(st["paragraphText"]) - 1,
           f"넣은 부분 {st['paragraphText'][len(text0):]!r}, caretOffset={st['caretOffset']}")

    # 선택 항목(T008 안정화 P1-C): 선택한 두 글자 위에서 조합 → 확정, 그리고 미리보기 뒤 취소.
    run(xdotool, "key", "End")
    st = settle(d, "선택 전 End")
    text0, rev0 = st["paragraphText"], int(st["revision"])
    run(xdotool, "key", "shift+Left", "shift+Left")
    selected = settle(d, "Shift+← ×2")
    run(xdotool, "type", "--delay", "90", "gk")
    run(xdotool, "key", "space")
    st = settle(d, "선택 위 '하 '")
    record("선택 위 조합 확정: 선택을 한 번 바꾸고 확정 글자는 한 번(선택 지우기·음절·공백마다 revision 1)",
           selected.get("selection", "") != "" and st["paragraphText"] == text0[:-2] + "하 " and int(st["revision"]) - rev0 == 3,
           f"선택 {selected.get('selection')!r}, 바뀐 끝 {st['paragraphText'][-6:]!r}, revision +{int(st['revision']) - rev0}")
    text1, rev1 = st["paragraphText"], int(st["revision"])
    run(xdotool, "key", "shift+Left", "shift+Left")
    selected = settle(d, "Shift+← ×2 (취소)")
    run(xdotool, "type", "--delay", "90", "g")
    mid = settle(d, "선택 위 ㅎ")
    run(xdotool, "key", "BackSpace")
    st = settle(d, "ㅎ을 BackSpace로 지움")
    record("선택 위 조합 취소(미리보기 뒤 BackSpace로 비움): 선택만 지워지고(계약) 조합 글자는 남지 않음",
           selected.get("selection", "") != "" and mid.get("composing") == "true" and st.get("composing") == "false"
           and st["paragraphText"] == text1[:-2] and int(st["revision"]) - rev1 == 1,
           f"조합 중={mid.get('composing')}·{mid.get('composition')!r}, 끝 {st['paragraphText'][-6:]!r}, revision +{int(st['revision']) - rev1}")

    # 5) 조합 중 클릭: 문단 끝에서 '하'를 조합하다 같은 줄 앞쪽(줄 처음에서 30%)을 클릭
    run(xdotool, "key", "Home")
    settle(d, "Home")
    line_start = caret_client(d)
    run(xdotool, "key", "End")
    st = settle(d, "End")
    line_end = caret_client(d)
    text0, rev0 = st["paragraphText"], int(st["revision"])
    target = (line_start[0] + (line_end[0] - line_start[0]) * 0.3, line_start[1] + line_start[2] / 2)
    run(xdotool, "type", "--delay", "90", "gk")
    composing = settle(d, "클릭 전 ㅎㅏ").get("composing") == "true"
    mark = d.js("return window.__imeLog.length")
    run(xdotool, "mousemove", "--window", window, str(int(target[0] + shift[0])), str(int(target[1] + shift[1])), "click", "1")
    st = settle(d, "조합 중 클릭")
    at = int(st["caretOffset"])
    clicked_ok = (composing and st["paragraphText"] == text0 + "하" and caret_path(st) == caret_path(before)
                  and at < len(text0) - 1 and int(st["revision"]) - rev0 == 1)
    detail = (f"클릭 때 조합 중={composing}, 넣은 부분 {st['paragraphText'][len(text0):]!r}, caretOffset {at}, revision +{int(st['revision']) - rev0},"
              f" 클릭 뒤 이벤트 {ime_counts(d.js('return window.__imeLog.slice(arguments[0])', mark))}")
    click_text, click_rev = st["paragraphText"], int(st["revision"])
    run(xdotool, "key", "space")
    flushed = settle(d, "클릭 뒤 공백")
    space_ok = (flushed["paragraphText"] == click_text[:at] + " " + click_text[at:] and int(flushed["caretOffset"]) == at + 1
                and int(flushed["revision"]) - click_rev == 1)
    run(xdotool, "type", "--delay", "90", "gk")
    run(xdotool, "key", "space")
    again = settle(d, "클릭 뒤 새 조합")
    spaced = flushed["paragraphText"]
    again_ok = (again["paragraphText"] == spaced[:at + 1] + "하 " + spaced[at + 1:] and int(again["caretOffset"]) == at + 3
                and int(again["revision"]) - int(flushed["revision"]) == 2 and again.get("composing") == "false")
    record("조합 중 클릭: 조합 글자를 원래 자리에 한 번 확정하고 커서는 클릭한 곳", clicked_ok and space_ok and again_ok,
           f"{detail}; 클릭 뒤 공백 {'정상' if space_ok else '어긋남'}({inserted_between(click_text, flushed['paragraphText'])!r});"
           f" 이어 친 '하 ' {'정상' if again_ok else '어긋남'}({inserted_between(spaced, again['paragraphText'])!r})")
    REPORT["docx"]["ime"]["eventsTotal"] = ime_counts(d.js("return window.__imeLog"))

    # 선택 항목: 탭 전환 중 조합(원래 문서에 한 번, 다른 문서에 섞이지 않음)
    select_tab(d, "basic-ko-b.docx")
    other_before = status(d)["paragraphText"]
    select_tab(d, "basic-ko.docx")
    d.js(EVENT_LOG)
    run(xdotool, "key", "End")
    st = settle(d, "탭 전환 전 End")
    text0 = st["paragraphText"]
    run(xdotool, "type", "--delay", "90", "gk")
    settle(d, "탭 전환 전 ㅎㅏ")
    tab = d.js("const t=[...document.querySelectorAll('.document-tab__select')].find(t => t.textContent.includes('basic-ko-b.docx'));"
               " const r=t.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]")
    run(xdotool, "mousemove", "--window", window, str(int(tab[0] + shift[0])), str(int(tab[1] + shift[1])), "click", "1")
    smoke.wait_until(d, f"return document.querySelector('{STATUS} h1')?.textContent === 'basic-ko-b.docx'", timeout=10)
    wait_status(d, "ready")
    d.js(EVENT_LOG)
    settle(d, "탭 전환 뒤")
    run(xdotool, "key", "space")
    other_after = settle(d, "탭 전환 뒤 공백")["paragraphText"]
    select_tab(d, "basic-ko.docx")
    original = inserted_between(text0, status(d)["paragraphText"])
    other = inserted_between(other_before, other_after)
    REPORT["imeTabSwitch"] = {"insertedInOriginal": original, "insertedInOther": other}
    record("조합 중 탭 전환: 조합은 원래 문서에 한 번, 다른 문서에 섞이지 않음", original == "하" and other == " ",
           f"원래 문서에 {original!r}, 다른 문서에 {other!r}")

    if focus_window:
        other_window = run(xdotool, "search", "--onlyvisible", "--name", focus_window).stdout.split()
        if other_window:
            run(xdotool, "windowfocus", "--sync", window)
            d.js(EVENT_LOG)
            run(xdotool, "key", "End")
            st = settle(d, "초점 이동 전 End")
            text0, rev0 = st["paragraphText"], int(st["revision"])
            run(xdotool, "type", "--delay", "90", "gk")
            settle(d, "초점 이동 전 ㅎㅏ")
            run(xdotool, "windowfocus", "--sync", other_window[-1])
            settle(d, "다른 창")
            run(xdotool, "windowfocus", "--sync", window)
            smoke.wait_until(d, "return document.hasFocus() && !!document.activeElement?.classList.contains('rhwp-input')", timeout=10)
            settle(d, "돌아옴")
            run(xdotool, "key", "space")
            st = settle(d, "돌아와 공백")
            record("조합 중 창 초점 이동 뒤 돌아옴", st["paragraphText"] == text0 + "하 " and int(st["revision"]) - rev0 == 2,
                   f"넣은 부분 {inserted_between(text0, st['paragraphText'])!r}, revision +{int(st['revision']) - rev0}")

    for name, _ in IME_ITEMS:
        outcomes = results[name]
        if not outcomes:
            gate(name, "NOT RUN", "다른 X 창(--focus-window)을 주지 않음" if "창 초점" in name else "실행하지 않음")
        else:
            gate(name, "PASS" if all(r == "PASS" for r, _ in outcomes) else "FAIL", "; ".join(x for _, x in outcomes))


def ime_exit_code() -> int:
    mandatory = [name for name, required in IME_ITEMS if required]
    statuses = [GATE.get(name, ("NOT RUN", ""))[0] for name in mandatory]
    verdict = "PASS" if all(s == "PASS" for s in statuses) else "FAIL" if "FAIL" in statuses else "UNVERIFIED"
    REPORT["imeGate"] = {"verdict": verdict, "items": {name: {"result": r, "detail": x} for name, (r, x) in GATE.items()}}
    print(f"\nIME 게이트: {verdict} (필수 {len(mandatory)}개 중 PASS {statuses.count('PASS')}, FAIL {statuses.count('FAIL')})")
    return {"PASS": 0, "FAIL": 1, "UNVERIFIED": 2}[verdict]


def wait_app(d, timeout: float = 30) -> None:
    """앱 화면이 준비될 때까지. 시작 직후 첫 페이지 로드와 겹친 스크립트는 'no such window(unload)'로 끝날 수 있어 다시 묻는다."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            smoke.wait_until(d, "return document.querySelector('.document-bar') !== null", timeout=max(1.0, deadline - time.monotonic()))
            return
        except smoke.Failure:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)


def generate_fixtures(out: Path) -> dict:
    command = ["cargo", "run", "--quiet", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"), "--example", "wordcraft_fixture", "--", str(out)]
    return json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--driver-log", type=Path)
    parser.add_argument("--font-home", type=Path, help="앱 프로세스의 HOME(.fonts에 한글 글꼴, 시험 환경 보정)")
    parser.add_argument("--ime", action="store_true", help="실제 IME 게이트만 실행(X11 + ibus-hangul + xdotool)")
    parser.add_argument("--xdotool", default=shutil.which("xdotool") or "xdotool")
    parser.add_argument("--ibus", default=shutil.which("ibus") or "ibus")
    parser.add_argument("--focus-window", help="창 초점 이동 항목에 쓸, 이미 떠 있는 다른 X 창의 이름")
    args = parser.parse_args()
    smoke.APP = os.path.abspath(args.app)
    smoke.DRIVER_LOG = args.driver_log
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
    if args.ime:
        reason = ime_environment(args.xdotool, args.ibus)
        if reason:
            for name, _ in IME_ITEMS:
                gate(name, "UNVERIFIED", reason)
            return ime_exit_code()
    try:
        with tempfile.TemporaryDirectory(prefix="geul-t008-") as scratch_dir:
            fixtures = Path(scratch_dir) / "fixtures"
            meta = generate_fixtures(fixtures)
            REPORT["fixture"] = meta
            original_hash = hashlib.sha256((fixtures / "basic-ko.docx").read_bytes()).hexdigest()
            if args.font_home:
                os.environ["HOME"] = str(args.font_home.resolve())
            with tempfile.TemporaryDirectory(prefix="geul-t008-data-") as data_home:
                with smoke.tauri_driver(args.driver, args.port, data_home) as start:
                    d = start()
                    try:
                        wait_app(d)
                        if args.ime:
                            scenario_ime(d, fixtures, args.xdotool, args.ibus, args.focus_window, args.screenshots)
                        else:
                            calibrate_pointer(d)
                            scenario_load_render(d, fixtures, meta, args.screenshots)
                            scenario_hit_test(d)
                            scenario_selection_keyboard(d)
                            scenario_revision(d)
                            scenario_roundtrip_ui(d)
                            scenario_latency(d)
                            scenario_stabilization(d)
                            scenario_second_stabilization(d, fixtures)
                            scenario_save(d, fixtures)
                            if args.screenshots:
                                d.screenshot(args.screenshots / "docx-edited.png")
                            scenario_webview_restart(d)
                            scenario_restart_inactive_close(d, fixtures)
                            scenario_lifecycle(d, fixtures, meta, original_hash)
                    finally:
                        try:
                            d.quit()
                        except smoke.Failure as error:
                            print(f"[참고] 세션 종료 실패: {error}", file=sys.stderr)
        if args.ime:
            return ime_exit_code()
        print(f"\nT008 WordCraft PoC: {len(RESULTS)}개 항목 통과")
        return 0
    except (smoke.Failure, TimeoutError, OSError, subprocess.CalledProcessError) as error:
        import traceback
        traceback.print_exc()
        print(f"[실패] {error}", file=sys.stderr)
        return 1
    finally:
        if args.report:
            args.report.write_text(json.dumps({"results": RESULTS, "measurements": REPORT}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
