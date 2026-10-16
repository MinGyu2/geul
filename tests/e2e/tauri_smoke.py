#!/usr/bin/env python3
"""실제 Tauri 앱을 띄워 6영역 UI를 검사하는 WebDriver 스모크 테스트(T004).

필요: 빌드된 앱(`npm run tauri build -- --debug --no-bundle`), tauri-driver 2.x, 플랫폼 WebDriver
(Linux: WebKitWebDriver), 그래픽 세션(Wayland 또는 X11). 외부 Python 패키지는 쓰지 않는다.
타일링 창 관리자는 창 크기 변경 요청을 무시하므로 최소 창 크기 검사를 건너뛴다. 이때는 헤드리스 weston
(`weston --backend=headless --renderer=pixman --socket=<이름>`)을 띄우고 `WAYLAND_DISPLAY=<이름>`으로 실행한다.

    python3 tests/e2e/tauri_smoke.py --app src-tauri/target/debug/geul \\
        --driver <tauri-driver 경로> [--screenshots <디렉터리>]

검사 항목: 앱 시작, 6영역 표시와 배치 순서, 패널 숨기기·복원과 초점, 리본 접기(버튼·Ctrl+F1),
패널 크기 조절(키보드·포인터), 지원하지 않는 명령의 비활성 동작, 테마 전환, 최소 창 크기에서의 배치,
Tab 키로 닿는 주요 컨트롤. 실패하면 종료 코드 1.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
KEYS = {"End": "\ue010", "Tab": "\ue004", "Enter": "\ue007", "ArrowLeft": "\ue012", "ArrowRight": "\ue014",
        "Control": "\ue009", "F1": "\ue031"}  # WebDriver 특수 키 코드


class Failure(Exception):
    pass


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


def check(results: list[str], name: str, condition: bool, detail: str = "") -> None:
    if not condition:
        raise Failure(f"{name} 실패 {detail}".strip())
    results.append(name)
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--app", required=True)
    parser.add_argument("--driver", default=shutil.which("tauri-driver") or "tauri-driver")
    parser.add_argument("--port", type=int, default=4444)
    parser.add_argument("--screenshots", type=Path)
    args = parser.parse_args()

    app = os.path.abspath(args.app)
    if not os.access(app, os.X_OK):
        print(f"앱 실행 파일이 없습니다: {args.app}", file=sys.stderr)
        return 1
    if shutil.which(args.driver) is None and not os.access(args.driver, os.X_OK):
        print(f"tauri-driver를 찾을 수 없습니다: {args.driver}", file=sys.stderr)
        return 1
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)

    driver_process = subprocess.Popen([args.driver, "--port", str(args.port)], stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE)
    driver = WebDriver(f"http://127.0.0.1:{args.port}")
    try:
        wait_port(args.port)
        driver.start(app)
        results = run(driver, args.screenshots)
        print(f"\nTauri 스모크 테스트 통과: {len(results)}개 항목, 건너뜀 {len(SKIPPED)}개")
        return 0
    except Failure as error:
        print(f"[실패] {error}", file=sys.stderr)
        return 1
    finally:
        driver.quit()
        driver_process.terminate()
        try:
            driver_process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            driver_process.kill()


if __name__ == "__main__":
    sys.exit(main())
