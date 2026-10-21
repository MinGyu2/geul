#!/usr/bin/env python3
"""실제 Tauri 앱을 띄워 6영역 UI를 검사하는 WebDriver 스모크 테스트(T004).

필요: 빌드된 앱(`npm run tauri build -- --debug --no-bundle`), tauri-driver 2.x, 플랫폼 WebDriver
(Linux: WebKitWebDriver), 그래픽 세션(Wayland 또는 X11). 외부 Python 패키지는 쓰지 않는다.
타일링 창 관리자는 창 크기 변경 요청을 무시하므로 최소 창 크기 검사를 건너뛴다. 이때는 헤드리스 weston
(`weston --backend=headless --renderer=pixman --idle-time=0 --socket=<이름>`)을 띄우고 `WAYLAND_DISPLAY=<이름>`으로 실행한다.

    python3 tests/e2e/tauri_smoke.py --app src-tauri/target/debug/geul \\
        --driver <tauri-driver 경로> [--screenshots <디렉터리>]

검사 항목: 앱 시작, 6영역 표시와 배치 순서, 패널 숨기기·복원과 초점, 리본 접기(버튼·Ctrl+F1),
패널 크기 조절(키보드·포인터), 지원하지 않는 명령의 비활성 동작, 테마 전환, 최소 창 크기에서의 배치,
Tab 키로 닿는 주요 컨트롤, 설정 저장 후 앱 프로세스를 끝내고 다시 띄워 언어·화면 설정이 복원되는지(T005),
더 새로운 버전의 저장값을 화면 설정 변경과 재시작 뒤에도 덮어쓰지 않는지(T005 리뷰 수정), 실행 중 같은
프로세스의 localStorage에서 바뀐 저장값을 다음 화면 설정 변경이 덮어쓰지 않는지(T005 2차 안정화),
문서 세션 IPC(T006: 형식 판별·엔진 배정·세션 ID·닫기·오류 계약, 화면의 문서 명령은 그대로 비활성).
동시에 실행한 다른 geul 프로세스의 변경은 WebKitGTK에서 서로 보이지 않아 감지할 수 없으므로 검사하지 않는다.
시나리오마다 빈 임시 XDG_DATA_HOME을 써서 첫 실행 상태로 시작하며 사용자의 실제 앱 데이터는 건드리지 않는다.
실패하면 종료 코드 1. WebDriver 연결이 응답 없이 끊기면(DriverLost) 끊긴 요청·마지막 통과 항목·그때 이 시나리오의 프로세스
(tauri-driver·WebKitWebDriver·앱·WebKit 보조 프로세스) 상태를 보이고, 앱이나 WebProcess가 사라졌으면 앱 충돌로 1, 살아 있으면
판단 불가로 2(통과로 세지 않음). 모든 항목이 통과한 뒤 세션 삭제만 끊겨도 정리 실패로 2다.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import struct
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
KEYS = {"End": "\ue010", "Tab": "\ue004", "Enter": "\ue007", "ArrowLeft": "\ue012", "ArrowRight": "\ue014",
        "Control": "\ue009", "F1": "\ue031"}  # WebDriver 특수 키 코드


class Failure(Exception):
    pass


class DriverLost(Failure):
    """WebDriver 요청에 응답이 오지 않고 연결이 끊김(T010 최종 검증 P3). 어느 단계에서 끊겼는지와 그때의 프로세스 상태를 담는다.

    단계는 요청으로 정한다: 세션 삭제(DELETE /session/<id>)는 정리, 나머지는 상호작용. 상호작용 중에 끊긴 뒤 앱이나 WebProcess가
    없으면 시험 환경 실패가 아니라 앱 충돌로 본다(crashed). 세션 삭제는 앱을 끝내므로 그때 앱이 없는 것은 정상이다."""

    def __init__(self, request: str, error: Exception):
        self.request = request
        self.teardown = request == "DELETE "
        self.last_check = LAST_CHECK[0]
        self.processes = owned_processes()
        time.sleep(1.0)  # 막 끝나는 중인 프로세스를 살아 있다고 보지 않도록 한 번 더 본다
        self.processes_after = owned_processes()
        driver = ACTIVE.get("driver")
        self.driver_exit = driver.poll() if driver else None
        self.listeners = webdriver_listeners()
        alive = {p["comm"] for p in self.processes_after if p["state"] != "Z"}
        self.crashed = not self.teardown and not {"geul", "WebKitWebProces"} <= alive
        super().__init__(f"WebDriver 연결 끊김({'세션 삭제' if self.teardown else '상호작용'} {request.strip()}): {error} — "
                         f"마지막 통과 항목 {self.last_check or '없음'!r}, tauri-driver 종료 코드 {self.driver_exit}, "
                         f"1초 뒤 프로세스 {sorted(alive)}")

    def diagnostic(self) -> dict:
        return {"request": self.request, "phase": "sessionDeletion" if self.teardown else "interaction", "lastCheck": self.last_check,
                "crashed": self.crashed, "tauriDriverExit": self.driver_exit, "processes": self.processes,
                "processesAfter1s": self.processes_after, "listeners": self.listeners}


def webdriver_listeners() -> list[str]:
    """끊김 진단용: WebDriver 포트(tauri-driver 4444·WebKitWebDriver 4445)에서 듣는 프로세스(ss가 있으면)."""
    try:
        out = subprocess.run(["ss", "-ltnpH", "sport = :4444 or sport = :4445"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [" ".join(line.split()) for line in out.splitlines()]


def driver_lost_exit(error: DriverLost) -> int:
    """끊김의 종료 코드: 앱 충돌 1, 그 밖(앱·WebProcess가 살아 있음, 또는 세션 삭제 단계) 판단 불가 2. 통과(0)로 바꾸지 않는다."""
    if error.crashed:
        print(f"[실패] 상호작용 중 WebDriver가 끊긴 뒤 앱 또는 WebProcess가 없음 — 앱 충돌로 본다: {error}", file=sys.stderr)
        return 1
    kind = "정리 실패(세션 삭제)" if error.teardown else "판단 불가(상호작용 중, 앱·WebProcess는 살아 있음)"
    print(f"[시험 환경 실패] {kind}: {error}", file=sys.stderr)
    return 2


def end_session(driver: "WebDriver") -> None:
    """finally에서 세션을 지운다. 앞선 오류가 있으면 그것을 가리지 않고 알리기만 하고, 없으면 정리 실패도 그대로 올린다."""
    pending = sys.exc_info()[1]
    try:
        driver.quit()
    except Failure as error:
        if pending is None:
            raise
        print(f"[참고] 세션 종료 실패(앞선 오류를 그대로 보고함): {error}", file=sys.stderr)


class WebDriver:
    def __init__(self, base: str):
        self.base = base
        self.session = ""

    def call(self, method: str, path: str, body: dict | None = None):
        url = f"{self.base}{path}" if path.startswith("/session") and not self.session else \
            f"{self.base}/session/{self.session}{path}" if self.session else f"{self.base}{path}"
        data = json.dumps(body if body is not None else {}).encode() if method == "POST" else None
        request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read() or b"{}").get("value")
        except urllib.error.HTTPError as error:
            raise Failure(f"WebDriver {method} {path}: {error.code} {error.read()[:300]!r}") from error
        except (ConnectionError, urllib.error.URLError) as error:
            raise DriverLost(f"{method} {path}", error) from error

    def start(self, app: str) -> None:
        caps = {"capabilities": {"alwaysMatch": {"tauri:options": {"application": app}}}}
        value = self.call("POST", "/session", caps)
        self.session = value["sessionId"]

    def quit(self) -> None:
        if self.session:
            try:
                self.call("DELETE", "")
            finally:
                self.session = ""

    def js(self, script: str, *args):
        return self.call("POST", "/execute/sync", {"script": script, "args": list(args)})

    def find(self, css: str):
        return self.call("POST", "/element", {"using": "css selector", "value": css})

    def exists(self, css: str) -> bool:
        return bool(self.js("return document.querySelector(arguments[0]) !== null", css))

    def click(self, css: str) -> None:
        self.call("POST", f"/element/{self.find(css)[ELEMENT]}/click")

    def send_keys(self, css: str, *keys: str) -> None:
        self.call("POST", f"/element/{self.find(css)[ELEMENT]}/value", {"text": "".join(KEYS[k] for k in keys)})

    def actions(self, actions: list[dict]) -> None:
        self.call("POST", "/actions", {"actions": actions})
        self.call("DELETE", "/actions")

    def screenshot(self, path: Path) -> None:
        time.sleep(0.5)  # 색 전환 애니메이션(120ms)이 끝난 뒤 찍는다
        path.write_bytes(base64.b64decode(self.call("GET", "/screenshot")))


def wait_port(port: int, timeout: float = 20) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise Failure(f"tauri-driver가 포트 {port}에서 응답하지 않음")


def wait_until(driver: WebDriver, script: str, *args, timeout: float = 10) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if driver.js(script, *args):
            return
        time.sleep(0.1)
    raise Failure(f"조건을 만족하지 않음: {script}")


REGIONS = {
    "TitleBar": "header.titlebar",
    "Ribbon": "section.ribbon",
    "NavigationPanel": "#navigation-panel",
    "Editor": "main.editor",
    "PropertiesPanel": "#properties-panel",
    "StatusBar": "footer.statusbar",
}

RECTS = """
const out = {};
for (const [name, css] of Object.entries(arguments[0])) {
  const el = document.querySelector(css);
  if (!el) { out[name] = null; continue; }
  const r = el.getBoundingClientRect();
  out[name] = {x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0};
}
out.viewport = {w: window.innerWidth, h: window.innerHeight,
                scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight};
return out;
"""


SKIPPED: list[str] = []
APP = ""
DRIVER_LOG: Path | None = None
LAST_CHECK = [""]  # 마지막으로 통과한 항목(끊김 진단용)
CHECKS_PASSED = [0]  # 통과한 항목 수(시나리오 함수가 결과를 돌려주기 전에 끊겨도 셈)
ACTIVE: dict = {}  # 지금 시나리오의 tauri-driver 프로세스와 XDG_DATA_HOME(끊김 진단용)


def owned_processes() -> list[dict]:
    """지금 시나리오의 XDG_DATA_HOME을 물려받은 프로세스의 PID·이름·상태(Linux /proc). 명령줄·환경 값은 남기지 않는다."""
    data_home = ACTIVE.get("data_home")
    if not data_home or not sys.platform.startswith("linux"):
        return []
    found = []
    for pid in pids_with(data_home):
        try:
            comm = Path(f"/proc/{pid}/comm").read_text().strip()
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except (OSError, IndexError):
            continue
        found.append({"pid": pid, "comm": comm, "state": state})
    return found


def check(results: list[str], name: str, condition: bool, detail: str = "") -> None:
    if not condition:
        raise Failure(f"{name} 실패 {detail}".strip())
    results.append(name)
    LAST_CHECK[0] = name
    CHECKS_PASSED[0] += 1
    print(f"[통과] {name}")


def run(driver: WebDriver, screenshots: Path | None) -> list[str]:
    results: list[str] = []
    wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
    check(results, "앱 시작(WebView 문서 로드)", driver.js("return document.title") == "geul")

    rects = driver.js(RECTS, REGIONS)
    start_viewport = rects["viewport"]
    print(f"시작 창 내용 크기: {start_viewport['w']}×{start_viewport['h']}")
    check(results, "시작 크기에서 가로 넘침 없음", start_viewport["scrollW"] <= start_viewport["w"],
          json.dumps(start_viewport))
    missing = [name for name in REGIONS if not (rects[name] and rects[name]["visible"])]
    check(results, "6영역 표시", not missing, f"누락: {missing}")
    t, rb, nav, ed, pr, sb = (rects[n] for n in REGIONS)
    check(results, f"시작 크기({start_viewport['w']}px)에서 편집 영역 360px 이상", ed["w"] >= 360, json.dumps(ed))
    check(results, "세로 배치(제목 → 리본 → 작업 영역 → 상태)", t["y"] < rb["y"] < ed["y"] < sb["y"]
          and abs(sb["y"] + sb["h"] - rects["viewport"]["h"]) <= 1)
    check(results, "가로 배치(탐색 | 편집 | 속성, 편집 영역이 가장 넓음)", nav["x"] < ed["x"] < pr["x"] and ed["w"] > max(nav["w"], pr["w"]),
          json.dumps(rects))
    if screenshots:
        driver.screenshot(screenshots / "01-default.png")

    driver.click('button[aria-label="탐색 창 닫기"]')
    check(results, "탐색 창 숨기기", not driver.exists("#navigation-panel"))
    check(results, "숨긴 뒤 초점이 토글로 이동",
          driver.js("return document.activeElement.getAttribute('aria-label')") == "탐색 창 표시")
    driver.click('button[aria-label="탐색 창 표시"]')
    check(results, "탐색 창 복원", driver.exists("#navigation-panel"))

    driver.click('button[aria-label="속성 창 닫기"]')
    check(results, "속성 창 숨기기(탐색 창은 유지)",
          not driver.exists("#properties-panel") and driver.exists("#navigation-panel"))
    width_without = driver.js(RECTS, {"Editor": "main.editor"})["Editor"]["w"]
    check(results, "숨긴 만큼 편집 영역 확장", width_without > ed["w"])
    driver.click('button[aria-label="속성 창 표시"]')
    check(results, "속성 창 복원", driver.exists("#properties-panel"))

    driver.click("button.ribbon__collapse")
    check(results, "리본 접기", not driver.exists("#ribbon-panel"))
    driver.actions([{"type": "key", "id": "kbd", "actions": [
        {"type": "keyDown", "value": KEYS["Control"]}, {"type": "keyDown", "value": KEYS["F1"]},
        {"type": "keyUp", "value": KEYS["F1"]}, {"type": "keyUp", "value": KEYS["Control"]}]}])
    wait_until(driver, "return document.querySelector('#ribbon-panel') !== null", timeout=3)
    check(results, "Ctrl+F1로 리본 펼치기", driver.exists("#ribbon-panel"))

    splitter = '.splitter[aria-controls="navigation-panel"]'
    before = int(driver.js("return document.querySelector(arguments[0]).getAttribute('aria-valuenow')", splitter))
    driver.send_keys(splitter, "ArrowRight")
    after = int(driver.js("return document.querySelector(arguments[0]).getAttribute('aria-valuenow')", splitter))
    check(results, "키보드로 패널 너비 조절", after == before + 16, f"{before} → {after}")
    box = driver.js(RECTS, {"s": splitter})["s"]
    x, y = int(box["x"] + box["w"] / 2), int(box["y"] + box["h"] / 2)
    driver.actions([{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
        {"type": "pointerMove", "x": x, "y": y}, {"type": "pointerDown", "button": 0},
        {"type": "pointerMove", "x": x + 60, "y": y, "duration": 100}, {"type": "pointerUp", "button": 0}]}])
    dragged = int(driver.js("return document.querySelector(arguments[0]).getAttribute('aria-valuenow')", splitter))
    nav_width = driver.js(RECTS, {"n": "#navigation-panel"})["n"]["w"]
    check(results, "포인터 드래그로 패널 너비 조절", dragged > after and abs(nav_width - dragged) <= 1,
          f"{after} → {dragged}, 실제 {nav_width}")

    bold = 'button[data-command="format.bold"]'
    check(results, "서식 명령은 비활성 표시",
          driver.js("return document.querySelector(arguments[0]).getAttribute('aria-disabled')", bold) == "true")
    html_before = driver.js("return document.querySelector('main.editor').innerHTML")
    driver.click(bold)
    message = driver.js("return document.querySelector('.statusbar__message').textContent")
    check(results, "지원하지 않는 명령은 실행하지 않고 이유만 표시",
          "사용할 수 없습니다" in message and driver.js("return document.querySelector('main.editor').innerHTML")
          == html_before, message)
    check(results, "문서 열기·저장 명령 비활성",
          driver.js("return ['file.save','edit.undo'].every(id => document.querySelector("
                    "`[data-command=\"${id}\"]`).getAttribute('aria-disabled') === 'true')"))

    background = "return getComputedStyle(document.body).backgroundColor"
    driver.js("document.documentElement.dataset.theme = 'light'")  # 시스템 설정과 무관하게 시작점을 고정
    light = driver.js(background)
    theme_button = 'button[aria-label^="테마:"]'
    for _ in range(3):
        if driver.js("return document.documentElement.dataset.theme") == "dark":
            break
        driver.click(theme_button)
    dark = driver.js(background)
    check(results, "어두운 테마 전환", driver.js("return document.documentElement.dataset.theme") == "dark"
          and dark != light, f"{light} → {dark}")
    if screenshots:
        driver.screenshot(screenshots / "02-dark.png")
    while driver.js("return document.documentElement.dataset.theme") != "light":
        driver.click(theme_button)

    driver.js("document.activeElement && document.activeElement.blur()")
    reached = set()
    for _ in range(40):
        driver.actions([{"type": "key", "id": "kbd", "actions": [
            {"type": "keyDown", "value": KEYS["Tab"]}, {"type": "keyUp", "value": KEYS["Tab"]}]}])
        reached.add(driver.js("const e = document.activeElement; return e.getAttribute('aria-label') || "
                              "e.getAttribute('role') || e.textContent.trim().slice(0, 20)"))
    wanted = {"탐색 창 표시", "속성 창 표시", "tab", "리본 접기", "탐색 창 너비 조절", "탐색 창 닫기",
              "속성 창 너비 조절", "속성 창 닫기", "확대"}
    check(results, "Tab 키로 주요 컨트롤 도달", wanted <= reached, f"누락: {sorted(wanted - reached)}")

    driver.call("POST", "/window/rect", {"width": 960, "height": 600})
    time.sleep(0.5)
    small = driver.js(RECTS, REGIONS)
    viewport = small["viewport"]
    if viewport["w"] > 1000:
        # 타일링 창 관리자 등은 WebDriver의 창 크기 변경을 무시한다. 그 경우 통과로 세지 않는다.
        SKIPPED.append(f"최소 창 크기 검사(창 관리자가 크기 변경을 반영하지 않음, 실제 {viewport['w']}×{viewport['h']})")
        print(f"[건너뜀] {SKIPPED[-1]}")
        return results
    check(results, "최소 창 크기에서 6영역 유지", all(small[n] and small[n]["visible"] for n in REGIONS),
          json.dumps(small))
    print(f"최소 창 크기 요청 후 창 내용 크기: {viewport['w']}×{viewport['h']}")
    check(results, "최소 창 크기에서 가로 넘침 없음, 편집 영역 360px 이상",
          viewport["scrollW"] <= viewport["w"] and small["Editor"]["w"] >= 360, json.dumps(viewport))
    check(results, "최소 창 크기에서 세로 넘침 없음, 상태 표시줄이 창 안에 있음",
          viewport["scrollH"] <= viewport["h"] and small["StatusBar"]["y"] + small["StatusBar"]["h"] <= viewport["h"] + 1
          and small["Editor"]["h"] > 100, json.dumps(small))

    driver.send_keys('.splitter[aria-controls="navigation-panel"]', "End")
    driver.send_keys('.splitter[aria-controls="properties-panel"]', "End")
    time.sleep(0.2)
    aria = driver.js("""
      return [...document.querySelectorAll('.splitter')].map(s => {
        const panel = document.getElementById(s.getAttribute('aria-controls'));
        return {now: +s.getAttribute('aria-valuenow'), min: +s.getAttribute('aria-valuemin'),
                max: +s.getAttribute('aria-valuemax'), actual: panel.getBoundingClientRect().width};
      });""")
    editor_width = driver.js(RECTS, {"Editor": "main.editor"})["Editor"]["w"]
    check(results, "최소 창 크기에서 두 패널을 최대로 늘려도 aria 범위·실제 너비 일치, 편집 영역 360px 이상",
          all(a["min"] <= a["now"] <= a["max"] and abs(a["actual"] - a["now"]) <= 1 for a in aria)
          and editor_width >= 360 - 1, json.dumps({"aria": aria, "editor": editor_width}))
    if screenshots:
        driver.screenshot(screenshots / "03-min-size.png")
    return results


def app_processes() -> list[int]:
    """APP 실행 파일로 돌고 있는 프로세스 ID(Linux /proc)."""
    pids = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                if os.readlink(entry / "exe") == APP:
                    pids.append(int(entry.name))
            except OSError:
                continue
    return pids


def wait_app_exit(results: list[str], name: str) -> None:
    if sys.platform.startswith("linux"):
        deadline = time.time() + 15
        while app_processes() and time.time() < deadline:
            time.sleep(0.2)
        remaining = app_processes()
        check(results, name, not remaining, " ".join(f"pid={pid}({process_state(pid)})" for pid in remaining))


def process_state(pid: int) -> str:
    """실패 진단용: /proc/<pid>/stat의 상태와 부모 PID."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return f"state={fields[0]} ppid={fields[1]}"
    except (OSError, IndexError):
        return "사라짐"


def run_restart(start_session, results: list[str]) -> None:
    """T005: 설정을 바꾼 뒤 앱 프로세스를 끝내고 새 프로세스에서 복원되는지 확인한다(실제 재시작)."""
    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        check(results, "재시작 검사: 첫 실행은 한국어", driver.js("return document.documentElement.lang") == "ko"
              and driver.js("return document.querySelector('header.titlebar').getAttribute('aria-label')") == "제목 표시줄")
        driver.click('select.titlebar__language option[value="en"]')
        wait_until(driver, "return document.documentElement.lang === 'en'", timeout=5)
        check(results, "언어 선택 즉시 영어로 전환",
              driver.js("return document.querySelector('header.titlebar').getAttribute('aria-label')") == "Title bar"
              and driver.js("return document.querySelector('.editor__notice-title').textContent") == "No document is open")
        driver.click('button[aria-label="Close navigation pane"]')
        driver.send_keys('.splitter[aria-controls="properties-panel"]', "ArrowLeft", "ArrowLeft")
        driver.click("button.ribbon__collapse")
        driver.click('button[aria-label="Theme: System"]')  # → Light
        driver.click('footer.statusbar button[data-command="view.zoomIn"]')
        saved = json.loads(driver.js("return localStorage.getItem('geul.settings')") or "null")
        expected_layout = {"navigationVisible": False, "propertiesVisible": True, "navigationWidth": 240,
                           "propertiesWidth": 312, "ribbonCollapsed": True, "theme": "light", "zoom": 110}
        check(results, "변경한 설정이 저장소에 기록됨",
              saved == {"version": 1, "language": "en", "layout": expected_layout}, json.dumps(saved))
    finally:
        driver.quit()  # 앱 프로세스 종료
    wait_app_exit(results, "첫 앱 프로세스가 끝남(실제 재시작)")

    driver = start_session()  # 같은 데이터 디렉터리로 새 앱 프로세스 시작
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        state = driver.js("""
          return {
            lang: document.documentElement.lang,
            theme: document.documentElement.dataset.theme,
            title: document.querySelector('header.titlebar').getAttribute('aria-label'),
            select: document.querySelector('select.titlebar__language').value,
            navigation: document.querySelector('#navigation-panel') !== null,
            ribbonPanel: document.querySelector('#ribbon-panel') !== null,
            propertiesWidth: +document.querySelector('.splitter[aria-controls="properties-panel"]').getAttribute('aria-valuenow'),
            zoom: document.querySelector('.statusbar__zoom-value').textContent,
            status: document.querySelector('.statusbar__message').textContent,
          };""")
        check(results, "재시작 후 언어 복원(영어, html lang)",
              state["lang"] == "en" and state["select"] == "en" and state["title"] == "Title bar"
              and state["status"] == "Ready", json.dumps(state, ensure_ascii=False))
        check(results, "재시작 후 패널·리본·테마·배율 복원",
              not state["navigation"] and not state["ribbonPanel"] and state["theme"] == "light"
              and state["propertiesWidth"] == 312 and state["zoom"] == "110%", json.dumps(state, ensure_ascii=False))
    finally:
        driver.quit()


# 더 새로운 앱 버전이 썼다고 가정한 저장값(모르는 항목 포함). 바이트 그대로 남아야 한다.
FUTURE_SETTINGS = json.dumps({
    "version": 2, "language": "en",
    "layout": {"navigationVisible": False, "propertiesVisible": True, "navigationWidth": 300, "propertiesWidth": 300,
               "ribbonCollapsed": True, "theme": "dark", "zoom": 150, "density": "compact"},
    "sync": {"enabled": True},
}, separators=(",", ":"))
FUTURE_NOTICE_KO = "저장된 설정이 더 새로운 버전의 형식이라 그대로 두었습니다."


def run_future_version(start_session, results: list[str]) -> None:
    """T005 리뷰 수정: 미지원(더 새로운) 버전 저장값을 실제 앱에서 재시작 2회에 걸쳐 덮어쓰지 않는지 확인한다."""
    stored = "return localStorage.getItem('geul.settings')"
    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        driver.js("localStorage.setItem('geul.settings', arguments[0])", FUTURE_SETTINGS)
    finally:
        driver.quit()
    wait_app_exit(results, "미지원 버전 검사: 저장값을 넣은 앱 프로세스가 끝남")

    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        status = driver.js("return document.querySelector('.statusbar__message').textContent")
        check(results, "미지원 버전: 시작 시 기본값(한국어)과 알림 표시",
              driver.js("return document.documentElement.lang") == "ko" and FUTURE_NOTICE_KO in status, status)
        driver.click('button[aria-label="테마: 시스템"]')  # → 밝게
        driver.click('select.titlebar__language option[value="en"]')
        wait_until(driver, "return document.documentElement.lang === 'en'", timeout=5)
        check(results, "미지원 버전: 바꾼 설정은 이번 실행에 적용됨",
              driver.js("return document.documentElement.dataset.theme") == "light")
        check(results, "미지원 버전: 설정을 바꿔도 저장값이 바이트 그대로", driver.js(stored) == FUTURE_SETTINGS)
    finally:
        driver.quit()
    wait_app_exit(results, "미지원 버전 검사: 두 번째 앱 프로세스가 끝남")

    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        status = driver.js("return document.querySelector('.statusbar__message').textContent")
        check(results, "미지원 버전: 재시작 후에도 저장값이 그대로이고 다시 알림",
              driver.js(stored) == FUTURE_SETTINGS and driver.js("return document.documentElement.lang") == "ko"
              and FUTURE_NOTICE_KO in status, status)
    finally:
        driver.quit()


def run_external_change(start_session, results: list[str]) -> None:
    """T005 2차 안정화: 실행 중 바뀐 저장값(같은 WebView 저장소에서 보이는 변경)을 덮어쓰지 않는지 확인한다."""
    stored = "return localStorage.getItem('geul.settings')"
    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        driver.click('button[aria-label="테마: 시스템"]')  # → 밝게, 정상 저장
        first = json.loads(driver.js(stored) or "null")
        check(results, "외부 변경 검사: 앱이 먼저 정상 저장", first is not None and first["layout"]["theme"] == "light",
              json.dumps(first))
        driver.js("localStorage.setItem('geul.settings', arguments[0])", FUTURE_SETTINGS)  # 다른 쪽이 씀
        driver.click('select.titlebar__language option[value="en"]')
        wait_until(driver, "return document.documentElement.lang === 'en'", timeout=5)
        driver.click('button[aria-label="Theme: Light"]')  # → 어둡게
        status = driver.js("return document.querySelector('.statusbar__message').textContent")
        check(results, "외부 변경 검사: 바뀐 저장값을 덮어쓰지 않고 충돌을 알림",
              driver.js(stored) == FUTURE_SETTINGS and "changed elsewhere" in status
              and driver.js("return document.documentElement.dataset.theme") == "dark", status)
    finally:
        driver.quit()
    wait_app_exit(results, "외부 변경 검사: 앱 프로세스가 끝남")

    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        check(results, "외부 변경 검사: 재시작 후에도 바뀐 저장값이 바이트 그대로", driver.js(stored) == FUTURE_SETTINGS)
    finally:
        driver.quit()


# 들여쓰고 모르는 항목을 넣은 올바른 버전 1 저장값(사람이나 다른 도구가 고쳐 쓴 경우). 다시 쓰지 않으면 바이트 그대로 남는다.
PRETTY_SETTINGS = json.dumps({
    "layout": {"zoom": 100, "theme": "system", "ribbonCollapsed": False, "propertiesWidth": 280, "navigationWidth": 240,
               "propertiesVisible": True, "navigationVisible": True, "density": "compact"},
    "language": "ko", "version": 1, "sync": {"enabled": False},
}, indent=2)
ADJUSTED_SETTINGS = json.dumps({"version": 1, "language": "ko", "layout": {"propertiesWidth": 99999}})
ADJUSTED_NOTICE_KO = "저장된 설정 일부를 조정하거나 기본값으로 복구했습니다."


def run_equivalent_restore(start_session, results: list[str]) -> None:
    """T005 최종 정리: 들여쓴 저장값으로 돌아오면 다시 쓰지 않고 실패 알림을 지우는지, 일부 복구 문구를 확인한다."""
    stored = "return localStorage.getItem('geul.settings')"
    status = "return document.querySelector('.statusbar__message').textContent"
    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        driver.js("localStorage.setItem('geul.settings', arguments[0])", PRETTY_SETTINGS)
    finally:
        driver.quit()
    wait_app_exit(results, "동등성 검사: 저장값을 넣은 앱 프로세스가 끝남")

    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        check(results, "동등성 검사: 들여쓴 버전 1을 알림 없이 복원", driver.js(status) == "준비됨", driver.js(status))
        # 이 WebView에서만 쓰기가 실패하게 한다(저장소 용량 초과를 흉내 냄).
        driver.js("Storage.prototype.setItem = () => { throw new DOMException('synthetic', 'QuotaExceededError'); }")
        driver.click('button[aria-label="테마: 시스템"]')  # → 밝게, 쓰기 실패
        # 실패 알림도 React effect에서 바뀐다. 관측 전에 다음 설정으로 넘어가면 실패를 시험하지 못한다.
        wait_until(driver, "return document.querySelector('.statusbar__message').textContent.includes('설정을 저장하지 못했습니다')", timeout=5)
        failed = driver.js(status)
        driver.click('button[aria-label="테마: 밝게"]')  # → 어둡게
        driver.click('button[aria-label="테마: 어둡게"]')  # → 시스템(저장값과 같은 설정)
        # 알림은 클릭 뒤 React effect에서 약 10 ms 늦게 바뀐다(T007에서 측정, 수정 전 빌드도 같음). 한 번만 읽으면 시점에
        # 따라 통과·실패가 갈리므로, 바뀔 때까지 짧게 기다린 뒤 판단한다(바뀌지 않으면 여전히 실패).
        with contextlib.suppress(Failure):
            wait_until(driver, "return document.querySelector('.statusbar__message').textContent === '준비됨'", timeout=5)
        recovered = driver.js(status)
        check(results, "동등성 검사: 저장값과 같은 설정으로 돌아오면 실패 알림을 지움",
              "설정을 저장하지 못했습니다" in failed and recovered == "준비됨", f"{failed} / {recovered}")
        check(results, "동등성 검사: 저장값(들여쓰기·모르는 항목)이 바이트 그대로", driver.js(stored) == PRETTY_SETTINGS)
    finally:
        driver.quit()
    wait_app_exit(results, "동등성 검사: 두 번째 앱 프로세스가 끝남")

    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        check(results, "동등성 검사: 재시작 후에도 저장값이 바이트 그대로이고 알림 없음",
              driver.js(stored) == PRETTY_SETTINGS and driver.js(status) == "준비됨", driver.js(status))
        driver.js("localStorage.setItem('geul.settings', arguments[0])", ADJUSTED_SETTINGS)
    finally:
        driver.quit()
    wait_app_exit(results, "동등성 검사: 세 번째 앱 프로세스가 끝남")

    driver = start_session()
    try:
        wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
        check(results, "일부 복구 알림: 범위 보정·빠진 항목을 고친 문구로 알리고 시작할 때 쓰지 않음",
              driver.js(status) == ADJUSTED_NOTICE_KO and driver.js(stored) == ADJUSTED_SETTINGS, driver.js(status))
    finally:
        driver.quit()


# ---- T006: 문서 세션 IPC ----
# 픽스처는 실행할 때 임시 디렉터리에 만드는 합성 컨테이너다(판별 규칙 시험용, 엔진이 열 수 있다는 증거가 아님).

DOCX_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"


def make_docx() -> bytes:
    import io
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("[Content_Types].xml",
                         f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         f'<Default Extension="xml" ContentType="application/xml"/>'
                         f'<Override PartName="/word/document.xml" ContentType="{DOCX_MAIN}"/></Types>')
        package.writestr("_rels/.rels",
                         f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         f'<Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" Target="word/document.xml"/></Relationships>')
        package.writestr("word/document.xml", "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>")
    return out.getvalue()


def make_hwpx() -> bytes:
    import io
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr(zipfile.ZipInfo("mimetype"), "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        package.writestr("Contents/content.hpf", "<opf:package xmlns:opf=\"http://www.idpf.org/2007/opf/\"/>")
        package.writestr("Contents/header.xml", "<hh:head xmlns:hh=\"http://www.hancom.co.kr/hwpml/2011/head\"/>")
        package.writestr("Contents/section0.xml", "<hs:sec xmlns:hs=\"http://www.hancom.co.kr/hwpml/2011/section\"/>")
    return out.getvalue()


def patch_entry(data: bytes, name: str, *, flags: int | None = None, crc: int | None = None) -> bytes:
    """ZIP 항목의 로컬 헤더와 중앙 디렉터리 값을 함께 바꾼다(zipfile은 암호화 플래그를 직접 쓰지 않는다)."""
    import io
    out = bytearray(data)
    info = zipfile.ZipFile(io.BytesIO(data)).getinfo(name)
    central = data.find(b"PK\x01\x02")
    while data[central + 46:central + 46 + len(name)] != name.encode():
        central = data.find(b"PK\x01\x02", central + 4)
    for at, flag_at, crc_at in ((info.header_offset, 6, 14), (central, 8, 16)):
        if flags is not None:
            out[at + flag_at:at + flag_at + 2] = struct.pack("<H", flags)
        if crc is not None:
            out[at + crc_at:at + crc_at + 4] = struct.pack("<I", crc)
    return bytes(out)


def with_entry(data: bytes, name: str, content: bytes) -> bytes:
    """기존 패키지에 항목 하나를 더하거나 바꾼다."""
    import io
    source = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        for info in source.infolist():
            if info.filename != name:
                package.writestr(info, source.read(info.filename))
        package.writestr(name, content)
    return out.getvalue()


ODF_MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"


def raw_zip(data: bytes, *, trailing: dict[str, bytes] | None = None,
            flags: dict[str, tuple[int, int]] | None = None) -> bytes:
    """`data`(ZIP)의 항목을 그대로 다시 쓰되, 지정한 항목의 압축 데이터 뒤에 바이트를 붙이거나(선언한 압축 크기에
    포함) 중앙 디렉터리·로컬 헤더의 플래그를 따로 정한다. zipfile로는 만들 수 없는 손상 입력용이다."""
    import io
    import zlib
    trailing, flags = trailing or {}, flags or {}
    source = zipfile.ZipFile(io.BytesIO(data))
    out, central = bytearray(), bytearray()
    for info in source.infolist():
        content = source.read(info.filename)
        if info.compress_type == zipfile.ZIP_DEFLATED:
            packer = zlib.compressobj(6, zlib.DEFLATED, -15)
            body, method = packer.compress(content) + packer.flush(), 8
        else:
            body, method = content, 0
        body += trailing.get(info.filename, b"")
        central_flags, local_flags = flags.get(info.filename, (0, 0))
        name, crc, offset = info.filename.encode(), zlib.crc32(content), len(out)
        out += struct.pack("<IHHHIIIIHH", 0x04034B50, 20, local_flags, method, 0, crc, len(body), len(content),
                           len(name), 0) + name + body
        central += struct.pack("<IHHHHIIIIHHHHHII", 0x02014B50, 20, 20, central_flags, method, 0, crc, len(body),
                               len(content), len(name), 0, 0, 0, 0, 0, offset) + name
    count = len(source.infolist())
    return bytes(out + central + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, count, count, len(central), len(out), 0))


def make_hwp() -> bytes:
    """CFB v3(512바이트 섹터). 스트림을 모두 4096바이트로 만들어 미니 스트림 없이 일반 섹터에 둔다."""
    sector, free, end, fat_sector, no_stream = 512, 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF
    header = bytearray(4096)
    header[:17] = b"HWP Document File"
    header[32:36] = bytes([0, 3, 0, 5])  # revision, build, minor, major
    streams = {"FileHeader": bytes(header), "DocInfo": b"\x01" * 4096, "Section0": b"\x02" * 4096}
    start = {"FileHeader": 3, "DocInfo": 11, "Section0": 19}  # 0: FAT, 1~2: 디렉터리
    fat = [free] * 128
    fat[0], fat[1], fat[2] = fat_sector, 2, end
    for name, first in start.items():
        for i in range(8):
            fat[first + i] = first + i + 1 if i < 7 else end

    def entry(name: str, kind: int, left=no_stream, right=no_stream, child=no_stream, first=end, size=0) -> bytes:
        encoded = (name + "\0").encode("utf-16-le") if name else b""
        return (encoded.ljust(64, b"\0") + struct.pack("<HBB3I", len(encoded), kind, 1, left, right, child)
                + bytes(16) + bytes(4) + bytes(16) + struct.pack("<IQ", first, size))

    directory = b"".join([
        entry("Root Entry", 5, child=2),
        entry("DocInfo", 2, first=start["DocInfo"], size=4096),
        entry("BodyText", 1, left=1, right=3, child=4),  # 이름 길이 순: DocInfo < BodyText < FileHeader
        entry("FileHeader", 2, first=start["FileHeader"], size=4096),
        entry("Section0", 2, first=start["Section0"], size=4096),
    ]).ljust(2 * sector, b"\0")
    directory = directory[:5 * 128] + b"".join(entry("", 0) for _ in range(3))
    head = (bytes.fromhex("D0CF11E0A1B11AE1") + bytes(16) + struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + bytes(6)
            + struct.pack("<IIIIIIIII", 0, 1, 1, 0, 4096, end, 0, end, 0) + struct.pack("<I", 0) + struct.pack("<I", free) * 108)
    body = struct.pack("<128I", *fat) + directory + streams["FileHeader"] + streams["DocInfo"] + streams["Section0"]
    return head + body


INVOKE = """
return window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
  .then((value) => ({ ok: value }), (error) => ({ err: error }));
"""


def run_document_sessions(start_session, results: list[str]) -> None:
    """T006: 실제 앱의 IPC로 형식 판별·세션·오류 계약을 확인한다. 화면에서는 문서를 열지 않는다."""
    with tempfile.TemporaryDirectory(prefix="geul-e2e-docs-") as folder:
        root = Path(folder)
        files = {
            "report.docx": make_docx(), "plan.hwpx": make_hwpx(), "memo.hwp": make_hwp(),
            "renamed.docx": make_hwpx(), "text.docx": b"plain text", "notes.txt": make_docx(),
            "cut.docx": make_docx()[:40],
        }
        for name, data in files.items():
            (root / name).write_bytes(data)
        (root / "folder.docx").mkdir()
        path = lambda name: str(root / name)
        driver = start_session()
        try:
            wait_until(driver, "return document.querySelector('footer.statusbar') !== null", timeout=30)
            call = lambda command, args=None: driver.js(INVOKE, command, args or {})
            check(results, "문서 세션: 시작할 때 열린 세션 없음", call("document_sessions") == {"ok": []})

            opened = [call("document_open", {"path": path(name)}) for name in ("report.docx", "plan.hwpx", "memo.hwp")]
            expected = [
                {"sessionId": 1, "format": "docx", "engine": "wordcraft", "revision": 0, "state": "identified", "displayName": "report.docx", "dirty": False, "sequence": 0, "loadGeneration": 0},
                {"sessionId": 2, "format": "hwpx", "engine": "rhwp", "revision": 0, "state": "identified", "displayName": "plan.hwpx", "dirty": False, "sequence": 0, "loadGeneration": 0},
                {"sessionId": 3, "format": "hwp", "engine": "rhwp", "revision": 0, "state": "identified", "displayName": "memo.hwp", "dirty": False, "sequence": 0, "loadGeneration": 0},
            ]
            check(results, "문서 세션: DOCX→WordCraft, HWPX·HWP→rhwp, ID 1·2·3, revision 0, 경로 없음",
                  opened == [{"ok": info} for info in expected], json.dumps(opened, ensure_ascii=False))

            errors = {
                "report.docx": {"code": "AlreadyOpen", "sessionId": 1},
                "renamed.docx": {"code": "ExtensionMismatch", "declared": "docx", "detected": "hwpx"},
                "text.docx": {"code": "UnsupportedFormat", "kind": "unknown"},
                "notes.txt": {"code": "UnsupportedFormat", "kind": "extension"},
                "cut.docx": {"code": "ParseFailure", "reason": "truncated"},
                "folder.docx": {"code": "Unreadable", "reason": "not-a-file"},
                "missing.docx": {"code": "Unreadable", "reason": "not-found"},
            }
            got = {name: call("document_open", {"path": path(name)}) for name in errors}
            got["(상대 경로)"] = call("document_open", {"path": "report.docx"})
            errors["(상대 경로)"] = {"code": "InvalidPath", "reason": "relative"}
            check(results, "문서 세션: 중복·확장자 불일치·알 수 없는 내용·지원 외 확장자·잘림·디렉터리·없음·상대 경로 오류",
                  got == {name: {"err": error} for name, error in errors.items()}, json.dumps(got, ensure_ascii=False))
            check(results, "문서 세션: 응답·오류에 파일 경로가 없음",
                  folder not in json.dumps([opened, got], ensure_ascii=False))

            closing = [call("document_close", {"sessionId": 1}), call("document_close", {"sessionId": 1})]
            check(results, "문서 세션: 닫기와 되풀이한 닫기",
                  closing == [{"ok": {"sessionId": 1, "alreadyClosed": False}}, {"ok": {"sessionId": 1, "alreadyClosed": True}}],
                  json.dumps(closing))
            lookups = [call("document_session", {"sessionId": 1}), call("document_session", {"sessionId": 999}),
                       call("document_session", {"sessionId": 2})]
            check(results, "문서 세션: 닫힌 세션은 StaleSession, 발급 안 된 ID는 UnknownSession, 다른 세션은 그대로",
                  lookups == [{"err": {"code": "StaleSession", "sessionId": 1}}, {"err": {"code": "UnknownSession", "sessionId": 999}},
                              {"ok": expected[1]}], json.dumps(lookups, ensure_ascii=False))
            listed = call("document_sessions")
            check(results, "문서 세션: 남은 세션 목록", listed == {"ok": expected[1:]}, json.dumps(listed, ensure_ascii=False))
            wrong_type = call("document_close", {"sessionId": "abc"})
            check(results, "문서 세션: 형식이 틀린 인자는 거부하고 앱은 계속 응답",
                  "err" in wrong_type and not isinstance(wrong_type["err"], dict) and call("document_sessions") == listed,
                  json.dumps(wrong_type, ensure_ascii=False))
            reopened = call("document_open", {"path": path("report.docx")})
            check(results, "문서 세션: 닫은 파일을 다시 열면 새 ID", reopened.get("ok", {}).get("sessionId") == 4, json.dumps(reopened))

            # T006 안정화: manifest 요소 인식(A), DOCX 전체 항목 암호화 플래그(B), HWPX 필수 항목 무결성(C), OPC 이름공간(D)
            stabilization = {
                "comment.hwpx": with_entry(make_hwpx(), "META-INF/manifest.xml",
                                           f'<odf:manifest xmlns:odf="{ODF_MANIFEST}"><!-- encryption-data --></odf:manifest>'.encode()),
                "utf16.hwpx": with_entry(make_hwpx(), "META-INF/manifest.xml", b"\xff\xfe" + (
                    f'<odf:manifest xmlns:odf="{ODF_MANIFEST}"><odf:file-entry full-path="Contents/header.xml">'
                    f'<odf:encryption-data/></odf:file-entry></odf:manifest>').encode("utf-16-le")),
                "crc.hwpx": patch_entry(make_hwpx(), "Contents/header.xml", crc=0x12345678),
                "media.docx": patch_entry(with_entry(make_docx(), "word/media/image1.png", b"\x89PNG"),
                                          "word/media/image1.png", flags=1),
                "nons.docx": with_entry(make_docx(), "_rels/.rels",
                                        f'<Relationships><Relationship Id="rId1" Type="{OFFICE_DOCUMENT}" '
                                        f'Target="word/document.xml"/></Relationships>'.encode()),
            }
            for name, data in stabilization.items():
                (root / name).write_bytes(data)
            got = {name: call("document_open", {"path": path(name)}) for name in stabilization}
            want = {
                "comment.hwpx": {"ok": {"sessionId": 5, "format": "hwpx", "engine": "rhwp", "revision": 0,
                                        "state": "identified", "displayName": "comment.hwpx", "dirty": False, "sequence": 0, "loadGeneration": 0}},
                "utf16.hwpx": {"err": {"code": "Encrypted", "format": "hwpx"}},
                "crc.hwpx": {"err": {"code": "ParseFailure", "format": "hwpx", "reason": "corrupt-container"}},
                "media.docx": {"err": {"code": "Encrypted", "format": "docx"}},
                "nons.docx": {"err": {"code": "ParseFailure", "reason": "invalid-part"}},
            }
            check(results, "문서 세션: 주석 속 encryption-data는 암호화가 아니고 UTF-16 manifest의 암호화 요소·필수 항목 CRC 손상·"
                  "DOCX 부가 항목 암호화·이름공간 없는 OPC 관계를 거부",
                  got == want, json.dumps(got, ensure_ascii=False))

            # T006 2차 안정화: 암호화 비트 불일치 우선순위(F), deflate 뒤 바이트(G), 관계없는 mimetype(H)
            second = {
                "mimetype.docx": with_entry(make_docx(), "mimetype", b"x" * 300),
                "trailing.docx": raw_zip(make_docx(), trailing={"[Content_Types].xml": b"JUNK"}),
                "plain.docx": raw_zip(make_docx()),
                "flag.hwpx": raw_zip(make_hwpx(), flags={"Contents/header.xml": (1, 0),
                                                         "Contents/section0.xml": (1, 1)}),
                "locked.hwpx": raw_zip(make_hwpx(), flags={"Contents/section0.xml": (1, 1)}),
            }
            for name, data in second.items():
                (root / name).write_bytes(data)
            got = {name: call("document_open", {"path": path(name)}) for name in second}
            opened_info = lambda session_id, name: {"ok": {"sessionId": session_id, "format": "docx", "engine": "wordcraft",
                                                           "revision": 0, "state": "identified", "displayName": name,
                                                           "dirty": False, "sequence": 0, "loadGeneration": 0}}
            want = {
                "mimetype.docx": opened_info(6, "mimetype.docx"),
                "trailing.docx": {"err": {"code": "ParseFailure", "reason": "corrupt-container"}},
                "plain.docx": opened_info(7, "plain.docx"),
                "flag.hwpx": {"err": {"code": "ParseFailure", "format": "hwpx", "reason": "corrupt-container"}},
                "locked.hwpx": {"err": {"code": "Encrypted", "format": "hwpx"}},
            }
            check(results, "문서 세션: 관계없는 큰 mimetype의 DOCX는 열리고, deflate 뒤에 남은 바이트와 필수 항목의 "
                  "암호화 비트 불일치(다른 항목이 암호화돼 있어도)는 손상, 일관된 암호화는 Encrypted",
                  got == want, json.dumps(got, ensure_ascii=False))

            # T006 3차 안정화: 로컬 헤더 압축 방식 불일치(I), 정확히 19바이트인 mimetype 정책(J)
            def local_method(data: bytes, name: str, method: int) -> bytes:
                import io
                out = bytearray(data)
                at = zipfile.ZipFile(io.BytesIO(data)).getinfo(name).header_offset
                out[at + 8:at + 10] = struct.pack("<H", method)
                return bytes(out)

            third = {
                "method.docx": local_method(make_docx(), "[Content_Types].xml", 0),
                "method.hwpx": local_method(make_hwpx(), "Contents/header.xml", 0),
                "mime19.docx": with_entry(make_docx(), "mimetype", b"application/x-other"),
                "mime19crc.docx": patch_entry(with_entry(make_docx(), "mimetype", b"application/x-other"),
                                              "mimetype", crc=0),
            }
            for name, data in third.items():
                (root / name).write_bytes(data)
            got = {name: call("document_open", {"path": path(name)}) for name in third}
            want = {
                "method.docx": {"err": {"code": "ParseFailure", "reason": "corrupt-container"}},
                "method.hwpx": {"err": {"code": "ParseFailure", "format": "hwpx", "reason": "corrupt-container"}},
                "mime19.docx": opened_info(8, "mime19.docx"),
                "mime19crc.docx": {"err": {"code": "ParseFailure", "reason": "corrupt-container"}},
            }
            check(results, "문서 세션: 필수 항목의 로컬 헤더 압축 방식 불일치는 손상, 읽을 수 있는 19바이트 다른 mimetype의 "
                  "DOCX는 열리고 읽을 수 없는 19바이트 mimetype은 HWPX 선언 여부를 알 수 없어 거부",
                  got == want, json.dumps(got, ensure_ascii=False))

            ui = driver.js("""
              return {
                bold: document.querySelector('button[data-command="format.bold"]')?.getAttribute('aria-disabled'),
                empty: document.querySelector('main.editor')?.textContent.includes('열린 문서가 없습니다'),
              };""")
            check(results, "문서 세션: 세션을 만들어도 화면의 문서 명령은 비활성이고 편집 영역은 빈 상태",
                  ui == {"bold": "true", "empty": True}, json.dumps(ui, ensure_ascii=False))
        finally:
            driver.quit()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", default=shutil.which("tauri-driver") or "tauri-driver")
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--screenshots", type=Path)
    parser.add_argument("--skip-restart", action="store_true", help="설정 저장 후 재시작 검사를 건너뛴다")
    parser.add_argument("--driver-log", type=Path, help="tauri-driver·WebKitWebDriver 출력을 덧붙여 쓸 파일(진단용)")
    args = parser.parse_args()

    global APP, DRIVER_LOG
    APP = app = os.path.abspath(args.app)
    DRIVER_LOG = args.driver_log
    if not os.access(app, os.X_OK):
        print(f"앱 실행 파일이 없습니다: {args.app}", file=sys.stderr)
        return 1
    if shutil.which(args.driver) is None and not os.access(args.driver, os.X_OK):
        print(f"tauri-driver를 찾을 수 없습니다: {args.driver}", file=sys.stderr)
        return 1
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)

    results: list[str] = []
    try:
        # 시나리오마다 빈 데이터 디렉터리(XDG_DATA_HOME)를 써서 첫 실행 상태로 시작하고,
        # 사용자의 실제 앱 데이터(WebView 저장소)를 건드리지 않는다.
        with tempfile.TemporaryDirectory(prefix="geul-e2e-") as data_home:
            with tauri_driver(args.driver, args.port, data_home) as start_session:
                driver = start_session()
                try:
                    results += run(driver, args.screenshots)
                finally:
                    driver.quit()
        with tempfile.TemporaryDirectory(prefix="geul-e2e-") as data_home:
            with tauri_driver(args.driver, args.port, data_home) as start_session:
                run_document_sessions(lambda: start_session(), results)
        if not args.skip_restart:
            with tempfile.TemporaryDirectory(prefix="geul-e2e-") as data_home:
                with tauri_driver(args.driver, args.port, data_home) as start_session:
                    run_restart(lambda: start_session(), results)
                stored = [p for p in Path(data_home).rglob("*") if p.is_file()]
                print(f"재시작 검사 데이터 디렉터리의 파일 {len(stored)}개(WebView 저장소)")
            with tempfile.TemporaryDirectory(prefix="geul-e2e-") as data_home:
                with tauri_driver(args.driver, args.port, data_home) as start_session:
                    run_future_version(lambda: start_session(), results)
            with tempfile.TemporaryDirectory(prefix="geul-e2e-") as data_home:
                with tauri_driver(args.driver, args.port, data_home) as start_session:
                    run_external_change(lambda: start_session(), results)
            with tempfile.TemporaryDirectory(prefix="geul-e2e-") as data_home:
                with tauri_driver(args.driver, args.port, data_home) as start_session:
                    run_equivalent_restore(lambda: start_session(), results)
        else:
            SKIPPED.append("설정 저장 후 재시작 검사(--skip-restart)")
        print(f"\nTauri 스모크 테스트 통과: {len(results)}개 항목, 건너뜀 {len(SKIPPED)}개")
        return 0
    except DriverLost as error:
        print(f"통과한 항목 {CHECKS_PASSED[0]}개(끊기기 전)", file=sys.stderr)
        return driver_lost_exit(error)
    except Failure as error:
        print(f"[실패] {error}", file=sys.stderr)
        return 1


@contextlib.contextmanager
def tauri_driver(path: str, port: int, data_home: str):
    environment = {**os.environ, "XDG_DATA_HOME": data_home}
    log = open(DRIVER_LOG, "ab") if DRIVER_LOG else subprocess.DEVNULL
    process = subprocess.Popen([path, "--port", str(port)], stdout=log, stderr=subprocess.STDOUT, env=environment)
    ACTIVE.update(driver=process, data_home=data_home)
    try:
        wait_port(port)

        def start_session() -> WebDriver:
            driver = WebDriver(f"http://127.0.0.1:{port}")
            driver.start(APP)
            return driver
        yield start_session
    finally:
        ACTIVE.clear()
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        # 앱과 WebKit 보조 프로세스가 끝날 때까지 기다린다. 기다리지 않으면 다음 시나리오의 프로세스 종료 검사나
        # 임시 데이터 디렉터리 삭제가 아직 저장소를 쓰는 프로세스와 겹친다. 그래도 남으면(세션이 비정상으로 끝나 앱이
        # 고아가 된 경우) 이 시나리오의 임시 XDG_DATA_HOME을 가진 프로세스만 끝내고, 앞선 오류가 없으면 실패로 보고한다.
        if DRIVER_LOG:
            log.close()
        remaining = wait_processes_gone(data_home, timeout=30)
        if remaining:
            detail = " ".join(f"pid={pid}({process_state(pid)})" for pid in remaining)
            for pid in remaining:
                with contextlib.suppress(OSError):
                    os.kill(pid, signal.SIGTERM)
            wait_processes_gone(data_home, timeout=10)
            if sys.exc_info()[0] is None:
                raise Failure(f"시나리오 종료 후에도 남은 프로세스(종료 요청함): {detail}")


def wait_processes_gone(data_home: str, timeout: float) -> list[int]:
    """이 시나리오의 XDG_DATA_HOME을 물려받은 프로세스(tauri-driver·앱·WebKit 보조 프로세스)가 끝나기를 기다린다."""
    if not sys.platform.startswith("linux"):
        return []
    deadline = time.time() + timeout
    while True:
        pids = pids_with(data_home)
        if not pids or time.time() >= deadline:
            return pids
        time.sleep(0.2)


def pids_with(data_home: str) -> list[int]:
    """환경에 이 XDG_DATA_HOME이 있는 이 사용자의 프로세스(시나리오 소유)."""
    marker = f"XDG_DATA_HOME={data_home}".encode() + b"\0"
    pids = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                if marker in (entry / "environ").read_bytes():
                    pids.append(int(entry.name))
            except OSError:
                continue
    return pids


if __name__ == "__main__":
    sys.exit(main())
