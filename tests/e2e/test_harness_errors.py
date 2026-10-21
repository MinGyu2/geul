"""WebDriver 하네스 오류 처리 회귀 시험(T010 하네스 오류 처리 안정화). 실제 앱·WebDriver 없이 결정적으로 돈다.

    python3 -m unittest discover -s tests/e2e

WebDriver 전송(urllib.request.urlopen)·프로세스 관찰(owned_processes)·시계를 바꿔 끼워, 끊김 전파(DriverLost), 기능 실패와
세션 삭제 실패의 우선순위, 끊김 분류(시작 실패·앱 종료·WebKit 보조 프로세스 종료·판단 불가·정리 실패), 종료 코드를 확인한다.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests" / "e2e"))
sys.path.insert(0, str(ROOT / "tests" / "integration" / "wordcraft"))
sys.path.insert(0, str(ROOT / "tests" / "integration" / "rhwp"))
import tauri_smoke as smoke  # noqa: E402
import wordcraft_poc as wordcraft  # noqa: E402
import rhwp_poc as rhwp  # noqa: E402

ALIVE = [{"pid": 10, "comm": "tauri-driver", "state": "S"}, {"pid": 11, "comm": "WebKitWebDriver", "state": "S"},
         {"pid": 12, "comm": "geul", "state": "S"}, {"pid": 13, "comm": "WebKitWebProces", "state": "S"},
         {"pid": 14, "comm": "WebKitNetworkPr", "state": "S"}]


def without(*names: str) -> list[dict]:
    return [p for p in ALIVE if p["comm"] not in names]


class Clock:
    """smoke·wordcraft의 time 대신: sleep은 시각만 넘긴다(시간 초과 경로를 실제로 기다리지 않음)."""

    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    monotonic = time

    def sleep(self, seconds):
        self.now += max(seconds, 0.01)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Transport:
    """가짜 WebDriver 서버. handler(method, path, body)가 값을 돌려주거나 LOST를 돌려주면 응답 없이 끊긴다(그 뒤 요청도 끊김)."""

    LOST = object()

    def __init__(self, handler, *, dead_after_loss: bool = True):
        self.handler = handler
        self.dead_after_loss = dead_after_loss
        self.requests: list[str] = []
        self.bodies: list[dict | None] = []
        self.lost_at: int | None = None

    def urlopen(self, request, timeout=None):
        path = request.full_url.split("127.0.0.1:4444", 1)[1]
        method = request.get_method()
        self.requests.append(f"{method} {path}")
        if self.lost_at is not None and self.dead_after_loss:
            self.bodies.append(None)
            raise urllib.error.URLError(ConnectionResetError(104, "Connection reset by peer"))
        body = json.loads(request.data) if request.data else None
        self.bodies.append(body)
        value = self.handler(method, path, body)
        if value is Transport.LOST:
            self.lost_at = len(self.requests) - 1
            raise ConnectionResetError(104, "Connection reset by peer")
        if isinstance(value, urllib.error.HTTPError):
            raise value
        return Response(json.dumps({"value": value}).encode())

    def after_loss(self) -> list[str]:
        return self.requests[self.lost_at + 1:] if self.lost_at is not None else []


class FakeDriverProcess:
    def __init__(self, code=None):
        self.code = code

    def poll(self):
        return self.code


class HarnessCase(unittest.TestCase):
    """전송·프로세스·시계를 바꿔 끼운다. self.observations는 owned_processes가 차례로 돌려줄 목록(마지막 것을 계속)."""

    def setUp(self):
        self.clock = Clock()
        self.observations: list[list[dict]] = [ALIVE]
        self.driver_process = FakeDriverProcess()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(smoke, "time", self.clock))
        stack.enter_context(mock.patch.object(wordcraft, "time", self.clock))
        stack.enter_context(mock.patch.object(smoke, "owned_processes", self.observe))
        stack.enter_context(mock.patch.object(smoke, "webdriver_listeners", lambda: ["LISTEN 127.0.0.1:4444"]))
        stack.enter_context(mock.patch.object(smoke, "app_processes", lambda: []))
        stack.enter_context(mock.patch.dict(smoke.ACTIVE, {"driver": self.driver_process, "data_home": "/nonexistent"}, clear=True))
        stack.enter_context(mock.patch.object(smoke, "LAST_CHECK", [""]))
        stack.enter_context(mock.patch.object(smoke, "CHECKS_PASSED", [0]))
        stack.enter_context(mock.patch.object(smoke, "APP", "/app/geul"))
        self.stderr = stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack = stack

    def observe(self):
        return self.observations.pop(0) if len(self.observations) > 1 else self.observations[0]

    def use(self, transport: Transport) -> Transport:
        self.stack.enter_context(mock.patch.object(smoke.urllib.request, "urlopen", transport.urlopen))
        return transport

    def session(self) -> smoke.WebDriver:
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.start(smoke.APP)
        return driver


def answering(scripts: dict, *, lose=lambda method, path, body: False):
    """execute/sync를 스크립트 조각으로 답하는 처리기. 세션 만들기·지우기·요소 찾기·클릭은 기본 답."""

    def handler(method, path, body):
        if lose(method, path, body):
            return Transport.LOST
        if method == "POST" and path == "/session":
            return {"sessionId": "S"}
        if method == "DELETE":
            return None
        if path.endswith("/element"):
            return {smoke.ELEMENT: "e1"}
        if path.endswith("/click"):
            return None
        if path.endswith("/execute/sync"):
            for fragment, value in scripts.items():
                if fragment in body["script"]:
                    return value(body) if callable(value) else value
            raise AssertionError(f"모르는 스크립트: {body['script'][:80]}")
        raise AssertionError(f"모르는 요청: {method} {path}")
    return handler


class DriverLostPropagation(HarnessCase):
    def test_equivalent_restore_timeout_region_propagates_driver_lost(self):
        """경우 1: 시간 초과만 견디는 곳(동등성 검사의 '준비됨' 기다림)에서 끊기면 그대로 올라가고, 끊긴 뒤 요청은 세션 삭제뿐."""
        state = {"failing": False}

        def status(_body):
            return "설정을 저장하지 못했습니다" if state["failing"] else "준비됨"

        def break_storage(_body):
            state["failing"] = True

        lost_wait = "=== '준비됨'"
        transport = self.use(Transport(answering({
            "footer.statusbar": True, "localStorage.setItem": None, "Storage.prototype.setItem": break_storage,
            "includes('설정을 저장하지 못했습니다')": True, ".statusbar__message').textContent": status,
        }, lose=lambda m, p, b: b is not None and "script" in b and lost_wait in b["script"])))
        with self.assertRaises(smoke.DriverLost) as caught:
            smoke.run_equivalent_restore(self.session, [])
        error = caught.exception
        self.assertEqual(error.request, "POST /execute/sync")
        self.assertEqual(error.phase, "interaction")
        self.assertEqual(error.last_check, "동등성 검사: 들여쓴 버전 1을 알림 없이 복원")
        self.assertIn(lost_wait, transport.bodies[transport.lost_at]["script"])  # 끊긴 요청이 그 기다림
        self.assertEqual(transport.after_loss(), ["DELETE /session/S"])  # 진단을 덮는 요청 없이 정리 한 번
        self.assertEqual(error.kind, "connectionLost")
        self.assertEqual(smoke.driver_lost_exit(error), 2)

    def test_equivalent_restore_condition_timeout_still_tolerated(self):
        """경우 11: 같은 곳에서 조건이 끝내 참이 아니면(시간 초과) 예전처럼 견디고 다음 검사가 판단한다(여기서는 실패로)."""
        state = {"failing": False}
        transport = self.use(Transport(answering({
            "footer.statusbar": True, "localStorage.setItem": None,
            "Storage.prototype.setItem": lambda _b: state.update(failing=True),
            "includes('설정을 저장하지 못했습니다')": True, "=== '준비됨'": False,
            ".statusbar__message').textContent": lambda _b: "설정을 저장하지 못했습니다" if state["failing"] else "준비됨",
        })))
        with self.assertRaises(smoke.Failure) as caught:
            smoke.run_equivalent_restore(self.session, [])
        self.assertNotIsInstance(caught.exception, smoke.DriverLost)
        self.assertIn("저장값과 같은 설정으로 돌아오면 실패 알림을 지움 실패", str(caught.exception))
        self.assertIsNone(transport.lost_at)

    def test_wordcraft_idle_keeps_original_driver_lost(self):
        """경우 2: WordCraft idle()의 기다림에서 끊기면 진단을 더 묻지 않고 원래 끊김을 올린다."""
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.session = "S"
        transport = self.use(Transport(answering({}, lose=lambda m, p, b: p.endswith("/execute/sync"))))
        with self.assertRaises(smoke.DriverLost) as caught:
            wordcraft.idle(driver)
        self.assertEqual(caught.exception.request, "POST /execute/sync")
        self.assertNotIsInstance(caught.exception.__context__, smoke.Failure)  # 전송 오류에서 바로 생김(다른 실패를 처리하다 생긴 것이 아님)
        self.assertEqual(transport.after_loss(), [])

    def test_wordcraft_idle_timeout_still_enriched(self):
        """경우 11: idle()의 시간 초과는 예전처럼 상태·지금 판이 아닌 쪽을 덧붙인 실패다."""
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.session = "S"
        self.use(Transport(answering({"dataset.pending==='0'": False, ".filter(p =>": [["1", "3", ""]]})))
        with mock.patch.object(wordcraft, "status", lambda _d: {"status": "ready", "revision": "3", "pending": "1"}):
            with self.assertRaises(smoke.Failure) as caught:
                wordcraft.idle(driver, timeout=1)
        self.assertNotIsInstance(caught.exception, smoke.DriverLost)
        self.assertIn("지금 판이 아닌 보이는 쪽 [['1', '3', '']]", str(caught.exception))
        self.assertIsInstance(caught.exception.__cause__, smoke.ConditionTimeout)

    def test_wordcraft_wait_app_does_not_retry_after_loss(self):
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.session = "S"
        transport = self.use(Transport(answering({}, lose=lambda m, p, b: True)))
        with self.assertRaises(smoke.DriverLost):
            wordcraft.wait_app(driver)
        self.assertEqual(transport.after_loss(), [])

    def test_wordcraft_wait_app_still_retries_unload_error(self):
        """경우 11: 시작 직후 'no such window'(HTTP 오류)는 예전처럼 다시 묻는다."""
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.session = "S"
        calls = []

        def ready(_body):
            calls.append(1)
            if len(calls) == 1:
                return urllib.error.HTTPError("u", 404, "no such window", {}, io.BytesIO(b'{"value":{"error":"no such window"}}'))
            return True
        self.use(Transport(answering({".document-bar": ready})))
        wordcraft.wait_app(driver)
        self.assertEqual(len(calls), 2)

    def test_rhwp_focus_recovery_keeps_original_driver_lost(self):
        """경우 3: rhwp 초점 복귀 기다림에서 끊기면 activeElement를 더 묻지 않는다(그 요청의 실패가 원래 진단을 덮지 않음)."""
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.session = "S"
        transport = self.use(Transport(answering({}, lose=lambda m, p, b: "hasFocus() &&" in b["script"])))
        with self.assertRaises(smoke.DriverLost) as caught:
            rhwp.wait_input_focus(driver)
        self.assertEqual(caught.exception.request, "POST /execute/sync")
        self.assertNotIsInstance(caught.exception.__context__, smoke.Failure)  # 전송 오류에서 바로 생김(다른 실패를 처리하다 생긴 것이 아님)
        self.assertEqual(transport.after_loss(), [])

    def test_rhwp_focus_timeout_still_reports_focus(self):
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        driver.session = "S"
        self.use(Transport(answering({"hasFocus() &&": False, "document.activeElement;": [True, "BODY."]})))
        with self.assertRaises(smoke.Failure) as caught:
            rhwp.wait_input_focus(driver, timeout=1)
        self.assertNotIsInstance(caught.exception, smoke.DriverLost)
        self.assertIn("activeElement = [True, 'BODY.']", str(caught.exception))


class CleanupPrecedence(HarnessCase):
    def future_version(self, *, notice: bool, lose_delete: bool):
        """미지원 버전 검사의 두 번째 세션: notice가 거짓이면 첫 검사가 실패한다. lose_delete면 그 세션의 삭제가 끊긴다."""
        sessions = []

        def handler(method, path, body):
            if method == "POST" and path == "/session":
                sessions.append(1)
            if method == "DELETE" and lose_delete and len(sessions) == 2:
                return Transport.LOST
            return answering({
                "footer.statusbar": True, "localStorage.setItem": None, "documentElement.lang === 'en'": True,
                "documentElement.lang": "ko", ".statusbar__message').textContent": smoke.FUTURE_NOTICE_KO if notice else "준비됨",
                "localStorage.getItem": smoke.FUTURE_SETTINGS, "dataset.theme": "light",
            })(method, path, body)
        return self.use(Transport(handler, dead_after_loss=False))

    def test_functional_failure_then_quit_failure_keeps_original(self):
        """경우 4: 기능 검사 실패 뒤 세션 삭제가 끊겨도 원래 기능 실패가 올라가고, 삭제 실패는 덧붙여 알린다."""
        transport = self.future_version(notice=False, lose_delete=True)
        with self.assertRaises(smoke.Failure) as caught:
            smoke.run_future_version(self.session, [])
        error = caught.exception
        self.assertNotIsInstance(error, smoke.DriverLost)
        self.assertIn("미지원 버전: 시작 시 기본값(한국어)과 알림 표시 실패", str(error))
        self.assertTrue(any("세션 종료도 실패" in note and "DELETE" in note for note in getattr(error, "__notes__", [])))
        self.assertIn("[참고] 세션 종료도 실패", self.stderr.getvalue())
        self.assertEqual(transport.requests[transport.lost_at], "DELETE /session/S")

    def test_functional_failure_then_quit_ok_is_plain_failure(self):
        transport = self.future_version(notice=False, lose_delete=False)
        with self.assertRaises(smoke.Failure) as caught:
            smoke.run_future_version(self.session, [])
        self.assertFalse(hasattr(caught.exception, "__notes__"))
        self.assertIsNone(transport.lost_at)

    def test_pass_then_quit_failure_raises_cleanup_failure(self):
        """경우 10: 검사가 모두 통과한 세션의 삭제가 끊기면 정리 실패로 올라간다(통과로 끝나지 않음)."""
        self.future_version(notice=True, lose_delete=True)
        results: list[str] = []
        with self.assertRaises(smoke.DriverLost) as caught:
            smoke.run_future_version(self.session, results)
        self.assertEqual(caught.exception.kind, "cleanupFailure")
        self.assertEqual(smoke.driver_lost_exit(caught.exception), 2)
        self.assertIn("미지원 버전: 설정을 바꿔도 저장값이 바이트 그대로", results)

    def test_end_session_preserves_any_pending_error(self):
        """세션 삭제가 DriverLost가 아닌 오류(읽기 시간 초과 등)로 끝나도 앞선 오류를 덮지 않는다."""
        driver = mock.Mock()
        driver.quit.side_effect = TimeoutError("timed out")
        original = smoke.Failure("기능 실패")
        with self.assertRaises(smoke.Failure) as caught:
            try:
                raise original
            finally:
                smoke.end_session(driver)
        self.assertIs(caught.exception, original)
        driver.quit.assert_called_once()

    def test_end_session_without_pending_raises(self):
        driver = mock.Mock()
        driver.quit.side_effect = smoke.Failure("DELETE 실패")
        with self.assertRaises(smoke.Failure):
            smoke.end_session(driver)


class SmokeMainExit(HarnessCase):
    """경우 5·10·12: main()의 종료 코드. tauri-driver는 띄우지 않고 세션 만들기를 가짜 전송으로 돌린다."""

    def main(self, run, *, lose_delete: bool) -> int:
        self.use(Transport(answering({}, lose=lambda m, p, b: lose_delete and m == "DELETE"), dead_after_loss=False))

        @contextlib.contextmanager
        def fake_driver(_path, _port, data_home):
            smoke.ACTIVE.update(driver=self.driver_process, data_home=data_home)
            try:
                yield self.session
            finally:
                smoke.ACTIVE.clear()
        argv = ["tauri_smoke.py", "--app", sys.executable, "--driver", sys.executable, "--skip-restart"]
        with mock.patch.object(sys, "argv", argv), mock.patch.object(smoke, "tauri_driver", fake_driver), \
                mock.patch.object(smoke, "run", run), mock.patch.object(smoke, "run_document_sessions", lambda *_: None):
            return smoke.main()

    def test_success_is_zero(self):
        self.assertEqual(self.main(lambda d, s: ["a", "b"], lose_delete=False), 0)

    def test_success_then_delete_lost_is_nonzero(self):
        self.assertEqual(self.main(lambda d, s: ["a", "b"], lose_delete=True), 2)
        self.assertIn("정리 실패(세션 삭제)", self.stderr.getvalue())

    def test_failure_then_delete_lost_reports_original(self):
        def run(_driver, _screens):
            raise smoke.Failure("6영역 표시 실패")
        self.assertEqual(self.main(run, lose_delete=True), 1)
        self.assertIn("[실패] 6영역 표시 실패", self.stderr.getvalue())


class Classification(HarnessCase):
    def lose_interaction(self) -> smoke.DriverLost:
        driver = self.session()
        driver.js("return 1")  # 세션 시작 뒤 첫 응답: 이 세션의 프로세스를 본다
        self.transport.handler = lambda *_: Transport.LOST
        with self.assertRaises(smoke.DriverLost) as caught:
            driver.js("return 2")
        return caught.exception

    def setUp(self):
        super().setUp()
        self.transport = self.use(Transport(answering({"return 1": 1})))

    def test_startup_failure_is_not_app_crash(self):
        """경우 6: 세션 만들기가 끊기고 앱 프로세스가 없음 → 시작 실패(2), 앱 충돌 아님."""
        self.observations = [without("geul", "WebKitWebProces")]
        self.transport.handler = lambda *_: Transport.LOST
        with self.assertRaises(smoke.DriverLost) as caught:
            self.session()
        self.assertEqual(caught.exception.kind, "startupFailure")
        self.assertEqual(caught.exception.phase, "sessionStart")
        self.assertEqual(smoke.driver_lost_exit(caught.exception), 2)
        self.assertNotIn("앱 프로세스 종료", self.stderr.getvalue())

    def test_app_exit_during_session(self):
        """경우 7: 이 세션에서 본 앱이 끊긴 뒤(1초 뒤 관찰에서도) 없음 → 앱 종료(1)."""
        self.observations = [ALIVE, ALIVE, without("geul", "WebKitWebProces"), without("geul", "WebKitWebProces")]
        error = self.lose_interaction()
        self.assertEqual(error.kind, "appExited")
        self.assertEqual(error.seen, ["WebKitWebDriver", "WebKitWebProces", "geul"])
        self.assertEqual(smoke.driver_lost_exit(error), 1)

    def test_app_zombie_counts_as_exited(self):
        zombie = [dict(p, state="Z") if p["comm"] == "geul" else p for p in ALIVE]
        self.observations = [ALIVE, ALIVE, zombie, zombie]
        self.assertEqual(self.lose_interaction().kind, "appExited")

    def test_webprocess_exit_is_not_geul_crash(self):
        """경우 8: 앱은 살아 있고 WebProcess만 없음 → WebKit 보조 프로세스 종료, 앱 종료로 부르지 않음."""
        self.observations = [ALIVE, ALIVE, without("WebKitWebProces")]
        error = self.lose_interaction()
        self.assertEqual(error.kind, "webProcessExited")
        self.assertIn("앱 충돌로 보지 않음", str(error))
        self.assertEqual(smoke.driver_lost_exit(error), 1)
        self.assertNotIn("앱 프로세스 종료", self.stderr.getvalue())

    def test_all_alive_is_inconclusive(self):
        """경우 9: 모든 프로세스가 살아 있음 → 판단 불가(2)."""
        error = self.lose_interaction()
        self.assertEqual(error.kind, "connectionLost")
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        diagnostic = error.diagnostic()
        self.assertEqual((diagnostic["phase"], diagnostic["kind"], diagnostic["exitCode"]), ("interaction", "connectionLost", 2))
        self.assertNotIn("environ", json.dumps(diagnostic))

    def test_momentary_absence_is_not_exit(self):
        """한 번(끊긴 직후)만 없고 1초 뒤 다시 보이면 끝났다고 보지 않는다."""
        self.observations = [ALIVE, without("geul"), ALIVE]
        self.assertEqual(self.lose_interaction().kind, "connectionLost")

    def test_never_seen_app_is_insufficient_evidence(self):
        """이 세션에서 앱을 본 적이 없으면(관찰 불가 등) 없다는 것만으로 충돌로 보지 않는다."""
        self.observations = [[]]
        self.assertEqual(self.lose_interaction().kind, "insufficientEvidence")

    def test_driver_exit_is_infrastructure(self):
        self.observations = [ALIVE, ALIVE, without("WebKitWebDriver", "geul", "WebKitWebProces")]
        error = self.lose_interaction()
        self.assertEqual(error.kind, "driverExited")
        self.assertEqual(smoke.driver_lost_exit(error), 2)

    def test_deletion_loss_is_cleanup_failure(self):
        driver = self.session()
        self.transport.handler = lambda m, *_: Transport.LOST if m == "DELETE" else None
        self.observations = [without("geul", "WebKitWebProces")]
        with self.assertRaises(smoke.DriverLost) as caught:
            driver.quit()
        self.assertEqual(caught.exception.kind, "cleanupFailure")
        self.assertEqual(driver.session, "")  # 다시 지우지 않음


if __name__ == "__main__":
    unittest.main()
