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
        if isinstance(value, BaseException):  # HTTP 오류 응답, 읽기 시간 초과(urlopen이 그대로 올리는 TimeoutError) 등
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


def http_error(code: int = 500) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("u", code, "Internal Server Error", {}, io.BytesIO(b'{"value":{"error":"unknown error"}}'))


class Body:
    """HTTP 오류 응답 본문 스트림. fail_after 바이트까지 주고 그 뒤 읽기는 fail(예: 상태·헤더 뒤 본문이 멈춤 → TimeoutError)."""

    def __init__(self, data: bytes = b"", *, fail: BaseException | None = None, fail_after: int = 0,
                 close_fail: BaseException | None = None):
        self.data, self.fail, self.fail_after, self.pos = data, fail, fail_after, 0
        self.close_fail = close_fail
        self.requested: list = []
        self.closes = 0  # close() 호출 수(HTTPError.close()가 스트림을 한 번 닫는다)
        self.closed = False

    def read(self, amt=None):
        self.requested.append(amt)
        if self.fail is not None and (self.pos >= self.fail_after or amt is None or amt < 0):
            raise self.fail  # 끝까지 읽기(read())는 멈춘 본문을 기다리다 실패하고, 그때까지 받은 바이트도 돌려주지 않는다(http.client와 같음)
        limit = len(self.data) if amt is None or amt < 0 else self.pos + amt
        if self.fail is not None:
            limit = min(limit, self.fail_after)
        chunk = self.data[self.pos:limit]
        self.pos += len(chunk)
        return chunk

    def close(self):
        self.closes += 1
        if self.close_fail is not None:
            raise self.close_fail
        self.closed = True


def http_error_body(code: int, body: Body) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://127.0.0.1:4444/session/S", code, "Internal Server Error", {}, body)


def stalled(code: int = 500) -> urllib.error.HTTPError:
    """상태·헤더와 본문 앞 7바이트는 왔고 나머지 본문 읽기가 시간 초과."""
    return http_error_body(code, Body(b'{"value":{"error":"unknown error"}}', fail=TimeoutError("timed out"), fail_after=7))


def stalled_close_bug(code: int = 500) -> urllib.error.HTTPError:
    """본문 앞 7바이트 뒤 읽기가 시간 초과하고, 응답 close()는 예상하지 못한 RuntimeError."""
    return http_error_body(code, Body(b'{"value":{"error":"unknown error"}}', fail=TimeoutError("timed out"), fail_after=7,
                                      close_fail=RuntimeError("close bug")))


CLEANUP = {  # 세션 삭제(DELETE /session/S)의 결과
    "ok": None,
    "http500": lambda: http_error(500),
    "timeout": lambda: TimeoutError("timed out"),  # 연결은 됐고 응답 읽기가 시간 초과(실측: urlopen이 URLError로 감싸지 않음)
    "reset": lambda: Transport.LOST,
    "http500stall": stalled,  # HTTP 500, 본문 읽기 시간 초과
    "closebug": stalled_close_bug,  # HTTP 500, 본문 읽기 시간 초과, 응답 닫기 RuntimeError
}
PROBE = "return 'probe'"  # 시나리오가 보내는 상호작용 요청


class WebDriverPaths(HarnessCase):
    """실제 WebDriver.call() 경로(가짜 urlopen)를 쓰는 시험의 공통 도우미. 시험이 없어 이 클래스 자체로는 돌지 않는다
    (도우미를 물려받으려고 시험 클래스를 물려받으면 그 시험이 한 번 더 돈다)."""

    def transport(self, *, interaction=None, cleanup="ok") -> Transport:
        """interaction: PROBE 요청의 결과(None이면 정상 응답, 아니면 그 예외), cleanup: CLEANUP 키."""
        base = answering({PROBE: "probe", ".document-bar": True, "footer.statusbar": True})

        def handler(method, path, body):
            if method == "DELETE" and path == "/session/S" and CLEANUP[cleanup]:
                return CLEANUP[cleanup]()
            if interaction and body and PROBE in body.get("script", ""):
                return interaction()
            return base(method, path, body)
        return self.use(Transport(handler, dead_after_loss=False))

    def session_started(self) -> smoke.WebDriver:
        driver = self.session()
        driver.js(PROBE)
        return driver

    def http(self, *, interaction=None, cleanup=None) -> Transport:
        """interaction·cleanup: PROBE 요청·DELETE /session/S가 받을 HTTP 오류를 만드는 함수."""
        base = answering({PROBE: "probe"})

        def handler(method, path, body):
            if method == "DELETE" and path == "/session/S" and cleanup:
                return cleanup()
            if interaction and body and PROBE in body.get("script", ""):
                return interaction()
            return base(method, path, body)
        self._transport = self.use(Transport(handler, dead_after_loss=False))
        return self._transport

    def transport_requests(self):
        return self._transport.requests



class TransportTimeoutAndCleanup(WebDriverPaths):
    """T010 전송 시간 초과·세션 삭제 HTTP 오류: 실제 WebDriver.call() 경로(가짜 urlopen)로 분류와 종료 코드를 본다."""

    def test_A_delete_read_timeout_is_cleanup_failure(self):
        """경우 A: 검사가 모두 통과한 뒤 DELETE 응답 읽기가 시간 초과 → 정리 실패(2), DELETE 한 번."""
        transport = self.transport(cleanup="timeout")
        driver = self.session_started()
        with self.assertRaises(smoke.DriverLost) as caught:
            smoke.end_session(driver)
        error = caught.exception
        self.assertIsInstance(error.__cause__, TimeoutError)
        self.assertEqual((error.request, error.phase, error.kind, error.transport), ("DELETE ", "sessionDeletion", "cleanupFailure", "readTimeout"))
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        self.assertEqual(transport.requests.count("DELETE /session/S"), 1)
        smoke.end_session(driver)  # 세션은 이미 비움: 다시 지우지 않는다
        self.assertEqual(transport.requests.count("DELETE /session/S"), 1)

    def test_B_delete_http_500_is_cleanup_failure(self):
        """경우 B: 검사 통과 뒤 DELETE가 HTTP 500 → 정리 실패(2), 상태 코드·요청 유지, 연결 끊김·앱 충돌로 부르지 않음."""
        transport = self.transport(cleanup="http500")
        driver = self.session_started()
        with self.assertRaises(smoke.CleanupFailure) as caught:
            smoke.end_session(driver)
        error = caught.exception
        self.assertNotIsInstance(error, smoke.DriverLost)
        self.assertIsInstance(error.__cause__, urllib.error.HTTPError)
        self.assertEqual((error.request, error.status, error.exit_code), ("DELETE ", 500, 2))
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        self.assertIn("정리 실패(세션 삭제)", self.stderr.getvalue())
        self.assertNotIn("앱 프로세스 종료", self.stderr.getvalue())
        self.assertEqual(transport.requests.count("DELETE /session/S"), 1)

    def test_http_500_during_interaction_stays_functional_failure(self):
        self.transport(interaction=lambda: http_error(500))
        driver = self.session()
        with self.assertRaises(smoke.Failure) as caught:
            driver.js(PROBE)
        self.assertNotIsInstance(caught.exception, (smoke.DriverLost, smoke.CleanupFailure))
        self.assertIn("500", str(caught.exception))

    def test_C_interaction_read_timeout_is_inconclusive_transport(self):
        """경우 C: POST /execute/sync 응답 읽기 시간 초과 → DriverLost(readTimeout), 모두 살아 있어 판단 불가(2), 다시 보내지 않음."""
        transport = self.transport(interaction=lambda: TimeoutError("timed out"))
        driver = self.session()
        with self.assertRaises(smoke.DriverLost) as caught:
            driver.js(PROBE)
        error = caught.exception
        self.assertNotIsInstance(error, smoke.ConditionTimeout)
        self.assertIsInstance(error.__cause__, TimeoutError)
        self.assertEqual((error.request, error.phase, error.kind, error.transport), ("POST /execute/sync", "interaction", "connectionLost", "readTimeout"))
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        self.assertEqual(transport.requests.count("POST /session/S/execute/sync"), 1)

    def test_session_create_read_timeout_is_startup_failure(self):
        self.transport()
        self.stack.enter_context(mock.patch.object(smoke.urllib.request, "urlopen", mock.Mock(side_effect=TimeoutError("timed out"))))
        with self.assertRaises(smoke.DriverLost) as caught:
            self.session()
        self.assertEqual((caught.exception.phase, caught.exception.kind, caught.exception.exit_code), ("sessionStart", "startupFailure", 2))

    def test_connect_timeout_wrapped_in_urlerror_is_timeout(self):
        self.transport(interaction=lambda: urllib.error.URLError(TimeoutError("timed out")))
        driver = self.session()
        with self.assertRaises(smoke.DriverLost) as caught:
            driver.js(PROBE)
        self.assertEqual(caught.exception.transport, "connectTimeout")

    def test_connection_reset_unchanged(self):
        """경우 4: 연결 재설정은 예전 DriverLost 그대로(종류 connection)."""
        self.transport(interaction=lambda: Transport.LOST)
        driver = self.session()
        with self.assertRaises(smoke.DriverLost) as caught:
            driver.js(PROBE)
        self.assertEqual((caught.exception.kind, caught.exception.transport, caught.exception.exit_code), ("connectionLost", "connection", 2))

    def test_programming_error_is_not_transport(self):
        """전송과 무관한 오류(예: 응답 JSON 깨짐)는 전송 실패로 바꾸지 않는다."""
        self.transport()
        self.stack.enter_context(mock.patch.object(smoke.urllib.request, "urlopen", lambda *a, **k: Response(b"not json")))
        driver = smoke.WebDriver("http://127.0.0.1:4444")
        with self.assertRaises(ValueError):
            driver.js(PROBE)

    def test_D_functional_failure_then_delete_timeout_keeps_original(self):
        """경우 D: 기능 실패 뒤 DELETE 시간 초과 → 원래 예외 객체가 그대로(1), 정리 실패는 덧붙임."""
        for cleanup in ("timeout", "http500"):
            with self.subTest(cleanup=cleanup):
                transport = self.transport(cleanup=cleanup)
                driver = self.session_started()
                original = smoke.Failure("기능 단언 실패")
                with self.assertRaises(smoke.Failure) as caught:
                    try:
                        raise original
                    finally:
                        smoke.end_session(driver)
                self.assertIs(caught.exception, original)
                self.assertTrue(any("세션 종료도 실패" in n for n in original.__notes__))
                self.assertEqual(transport.requests.count("DELETE /session/S"), 1)


class EntryPointMatrix(WebDriverPaths):
    """스모크·WordCraft·rhwp main()의 기능 단계 × 세션 삭제 결과 → 종료 코드(가짜 urlopen, 실제 WebDriver.call 경로)."""

    CASES = [  # (기능, 세션 삭제, 종료 코드)
        ("pass", "ok", 0), ("fail", "ok", 1), ("fail", "http500", 1), ("fail", "timeout", 1),
        ("pass", "http500", 2), ("pass", "timeout", 2), ("pass", "reset", 2),
        ("timeout", "ok", 2), ("timeout", "http500", 2), ("timeout", "timeout", 2),
        ("pass", "http500stall", 2), ("fail", "http500stall", 1), ("http500stall", "ok", 1), ("http500stall", "http500stall", 1),
        ("pass", "closebug", 2), ("fail", "closebug", 1), ("closebug", "ok", 1), ("closebug", "closebug", 1),
    ]
    INTERACTION = {"timeout": lambda: TimeoutError("timed out"), "http500stall": stalled, "closebug": stalled_close_bug}

    def scenario(self, functional):
        def run(d, *_):
            d.js(PROBE)
            if functional == "fail":
                raise smoke.Failure("기능 단언 실패(시험)")
            return ["a"]
        return run

    @contextlib.contextmanager
    def fake_tauri_driver(self, _path, _port, data_home):
        smoke.ACTIVE.update(driver=self.driver_process, data_home=data_home)
        try:
            yield self.session
        finally:
            smoke.ACTIVE.clear()

    def run_main(self, entry: str, functional: str) -> int:
        exe = sys.executable
        common = [mock.patch.object(smoke, "tauri_driver", self.fake_tauri_driver)]
        if entry == "smoke":
            patches = [mock.patch.object(sys, "argv", ["tauri_smoke.py", "--app", exe, "--driver", exe, "--skip-restart"]),
                       mock.patch.object(smoke, "run", self.scenario(functional)),
                       mock.patch.object(smoke, "run_document_sessions", lambda *_: None)]
            main = smoke.main
        elif entry == "wordcraft":
            def fixtures(out):
                out.mkdir(parents=True)
                (out / "basic-ko.docx").write_bytes(b"x")
                return {}
            patches = [mock.patch.object(sys, "argv", ["wordcraft_poc.py", "--app", exe, "--driver", exe, "--commands-only"]),
                       mock.patch.object(wordcraft, "generate_fixtures", fixtures),
                       mock.patch.object(wordcraft, "calibrate_pointer", lambda _d: None),
                       mock.patch.object(wordcraft, "scenario_commands", self.scenario(functional)),
                       mock.patch.object(wordcraft, "RESULTS", [])]
            main = wordcraft.main
        else:
            node = {"hwp": {"passed": True, "formatEqual": True, "sourceFormat": "hwp"},
                    "hwpx": {"passed": True, "formatEqual": True, "sourceFormat": "hwpx"}}
            fake_run = mock.Mock(side_effect=[mock.Mock(stdout=json.dumps({"rhwpCommit": "x", "contentLoss": []})),
                                              mock.Mock(stdout=json.dumps(node), returncode=0)])
            patches = [mock.patch.object(sys, "argv", ["rhwp_poc.py", "--app", exe, "--driver", exe, "--commands-only"]),
                       mock.patch.object(rhwp.subprocess, "run", fake_run),
                       mock.patch.object(rhwp, "scenario_commands", self.scenario(functional)),
                       mock.patch.object(rhwp, "RESULTS", [])]
            main = rhwp.main
        with contextlib.ExitStack() as stack:
            for patch in common + patches:
                stack.enter_context(patch)
            return main()

    def test_matrix(self):
        for entry in ("smoke", "wordcraft", "rhwp"):
            for functional, cleanup, expected in self.CASES:
                with self.subTest(entry=entry, functional=functional, cleanup=cleanup):
                    self.stderr.seek(0)
                    self.stderr.truncate()
                    transport = self.transport(interaction=self.INTERACTION.get(functional), cleanup=cleanup)
                    try:
                        code = self.run_main(entry, functional)
                    except BaseException as error:  # 처리되지 않은 예외도 계약 위반으로 본다
                        self.fail(f"main()이 종료 코드 대신 {type(error).__name__}: {error}")
                    err = self.stderr.getvalue()
                    self.assertEqual(code, expected, err[-600:])
                    self.assertEqual(transport.requests.count("DELETE /session/S"), 1)  # 정리는 한 번, 다시 보내지 않음
                    probes = [r for r in transport.requests if r == "POST /session/S/execute/sync"]
                    self.assertGreaterEqual(len(probes), 1)
                    if functional == "fail":
                        self.assertIn("기능 단언 실패(시험)", err)
                    if functional == "closebug":
                        self.assertIn("/execute/sync: 500", err)
                        self.assertIn("본문 읽기 실패: TimeoutError) (응답 닫기 실패: RuntimeError)", err)
                    if functional in ("http500stall", "closebug"):
                        self.assertIn("/execute/sync: 500", err)  # 본문을 못 읽어도 HTTP 상태가 남은 기능 실패
                        sent = [b for b in transport.bodies if b and PROBE in b.get("script", "")]
                        self.assertEqual(len(sent), 1)  # 다시 보내지 않음
                    if functional == "timeout":
                        self.assertIn("POST /execute/sync", err)  # 원래 전송 진단
                        self.assertEqual(transport.requests[-1], "DELETE /session/S")  # 시간 초과 뒤 기능 요청 없음
                    if cleanup != "ok" and functional != "pass":
                        self.assertIn("[참고] 세션 종료도 실패", err)
                    if functional == "pass" and cleanup != "ok":
                        self.assertIn("정리 실패(세션 삭제)", err)
                    self.assertNotIn("앱 프로세스 종료", err)


class HttpErrorBody(WebDriverPaths):
    """T010 HTTP 오류 본문 읽기: 상태를 받은 뒤 본문 읽기가 실패해도 상태·요청·단계를 잃지 않고, 본문은 정해진 만큼만 읽는다."""

    def test_A_delete_500_body_timeout_is_cleanup_failure(self):
        """필수 A: 검사 통과 뒤 DELETE가 HTTP 500, 본문 읽기 시간 초과 → CleanupFailure(2), 상태 500, 읽기 실패는 덧붙인 진단."""
        transport = self.http(cleanup=stalled)
        driver = self.session_started()
        with self.assertRaises(smoke.CleanupFailure) as caught:
            smoke.end_session(driver)
        error = caught.exception
        self.assertNotIsInstance(error, smoke.DriverLost)
        self.assertIsInstance(error.__cause__, urllib.error.HTTPError)
        self.assertEqual((error.request, error.status, error.body_error), ("DELETE ", 500, "TimeoutError"))
        self.assertEqual(error.diagnostic()["kind"], "cleanupFailure")
        self.assertEqual(error.diagnostic()["bodyReadError"], "TimeoutError")
        self.assertIn("HTTP 500", str(error))
        self.assertIn("본문 읽기 실패: TimeoutError", str(error))
        self.assertIn('{"value', str(error))  # 읽은 앞부분은 남긴다
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        self.assertEqual(transport.requests.count("DELETE /session/S"), 1)

    def test_B_interaction_500_body_timeout_stays_functional_failure(self):
        """필수 B: POST /execute/sync가 HTTP 500, 본문 읽기 시간 초과 → 기능 Failure(1), 500이 보이고 다시 보내지 않음."""
        transport = self.http(interaction=stalled)
        driver = self.session()
        with self.assertRaises(smoke.Failure) as caught:
            driver.js(PROBE)
        error = caught.exception
        self.assertNotIsInstance(error, (smoke.DriverLost, smoke.CleanupFailure))
        self.assertIsInstance(error.__cause__, urllib.error.HTTPError)
        self.assertIn("POST /execute/sync: 500", str(error))
        self.assertIn("본문 읽기 실패: TimeoutError", str(error))
        self.assertEqual(transport.requests.count("POST /session/S/execute/sync"), 1)

    def test_C_functional_failure_then_cleanup_body_timeout_keeps_original(self):
        """필수 C: 기능 실패 뒤 DELETE HTTP 500 본문 시간 초과 → 원래 예외 객체가 그대로(1), 정리 실패는 덧붙인 알림만."""
        transport = self.http(cleanup=stalled)
        driver = self.session_started()
        original = smoke.Failure("기능 단언 실패")
        with self.assertRaises(smoke.Failure) as caught:
            try:
                raise original
            finally:
                smoke.end_session(driver)
        self.assertIs(caught.exception, original)
        self.assertEqual(str(original), "기능 단언 실패")
        self.assertTrue(any("세션 종료도 실패" in n and "HTTP 500" in n and "TimeoutError" in n for n in original.__notes__))
        self.assertEqual(transport.requests.count("DELETE /session/S"), 1)

    def body_case(self, body: Body) -> smoke.Failure:
        self.http(interaction=lambda: http_error_body(500, body))
        driver = self.session()
        with self.assertRaises(smoke.Failure) as caught:
            driver.js(PROBE)
        self.assertNotIsInstance(caught.exception, smoke.DriverLost)
        self.assertTrue(body.requested and all(isinstance(n, int) and 0 < n <= 300 for n in body.requested), body.requested)
        return caught.exception

    def test_small_body(self):
        error = self.body_case(Body(b'{"value":{"error":"javascript error"}}'))
        self.assertIn("javascript error", str(error))
        self.assertNotIn("본문 읽기 실패", str(error))

    def test_empty_body(self):
        error = self.body_case(Body(b""))
        self.assertIn("POST /execute/sync: 500 b''", str(error))

    def test_large_body_reads_at_most_excerpt(self):
        body = Body(b"x" * 100_000)
        error = self.body_case(body)
        self.assertEqual(body.pos, 300)  # 300바이트를 넘게 읽지 않는다(다 읽고 자르지 않음)
        self.assertIn("x" * 300, str(error))
        self.assertNotIn("x" * 301, str(error))

    def test_body_connection_reset(self):
        error = self.body_case(Body(b"abc", fail=ConnectionResetError(104, "Connection reset by peer"), fail_after=3))
        self.assertIn("500 b'abc'", str(error))
        self.assertIn("본문 읽기 실패: ConnectionResetError", str(error))

    def test_delete_500_body_reset_is_cleanup_failure(self):
        self.http(cleanup=lambda: http_error_body(500, Body(fail=ConnectionResetError(104, "reset"))))
        driver = self.session_started()
        with self.assertRaises(smoke.CleanupFailure) as caught:
            smoke.end_session(driver)
        self.assertEqual((caught.exception.status, caught.exception.body_error, caught.exception.exit_code), (500, "ConnectionResetError", 2))

    def test_delete_500_readable_body_has_no_read_error(self):
        self.http(cleanup=lambda: http_error(500))
        driver = self.session_started()
        with self.assertRaises(smoke.CleanupFailure) as caught:
            smoke.end_session(driver)
        self.assertIsNone(caught.exception.body_error)
        self.assertIn("unknown error", str(caught.exception))

    def test_body_programming_error_is_not_hidden(self):
        """본문 스트림의 프로그래밍 오류(전송·읽기 오류가 아님)는 삼키지 않는다."""
        self.http(interaction=lambda: http_error_body(500, Body(fail=AttributeError("bug"))))
        driver = self.session()
        with self.assertRaises(AttributeError):
            driver.js(PROBE)


class HttpErrorStreamClose(WebDriverPaths):
    """T010 HTTPError 응답 스트림 정리: 본문을 정해진 만큼 읽거나 읽다 실패해도 응답을 한 번 닫고, 닫기 실패가 상태·분류·앞선 오류를
    지우지 않는다. 직접(_error_excerpt)과 실제 WebDriver.call() 경로(가짜 urlopen) 둘 다 본다."""

    def call_with(self, body: Body, *, delete: bool = False):
        """PROBE 또는 세션 삭제가 body를 가진 HTTP 500을 받게 하고, 일어난 예외를 돌려준다."""
        if delete:
            self.http(cleanup=lambda: http_error_body(500, body))
            driver = self.session_started()
            with self.assertRaises(Exception) as caught:
                smoke.end_session(driver)
        else:
            self.http(interaction=lambda: http_error_body(500, body))
            driver = self.session()
            with self.assertRaises(Exception) as caught:
                driver.js(PROBE)
        return caught.exception

    def assert_closed_once(self, body: Body):
        self.assertEqual(body.closes, 1)
        self.assertTrue(body.closed or body.close_fail is not None)

    def test_direct_large_body_closed(self):
        body = Body(b"x" * 100_000)
        error = http_error_body(500, body)
        text, read_error = smoke._error_excerpt(error)[:2]
        self.assertEqual((body.pos, read_error), (300, None))
        self.assertTrue(all(0 < n <= 300 for n in body.requested))
        self.assert_closed_once(body)
        self.assertIn("x" * 300, text)

    def test_large_body_closed_on_call(self):
        """1: 100,000바이트 500 → 300바이트만 읽고 닫음(남은 본문을 다 읽지 않음)."""
        body = Body(b"x" * 100_000)
        error = self.call_with(body)
        self.assertIsInstance(error, smoke.Failure)
        self.assertEqual(body.pos, 300)
        self.assert_closed_once(body)

    def test_small_body_closed_and_kept(self):
        body = Body(b'{"value":{"error":"javascript error"}}')
        error = self.call_with(body)
        self.assertIn("javascript error", str(error))
        self.assert_closed_once(body)

    def test_empty_body_closed(self):
        body = Body(b"")
        self.assertIn(": 500 b''", str(self.call_with(body)))
        self.assert_closed_once(body)

    def test_partial_then_timeout_closed(self):
        body = Body(b'{"value":{"error":"x"}}', fail=TimeoutError("timed out"), fail_after=7)
        error = self.call_with(body)
        self.assertNotIsInstance(error, smoke.DriverLost)
        self.assertIn("POST /execute/sync: 500 b'{\"value'", str(error))
        self.assertIn("본문 읽기 실패: TimeoutError", str(error))
        self.assert_closed_once(body)

    def test_partial_then_reset_closed(self):
        body = Body(b"abcdef", fail=ConnectionResetError(104, "reset"), fail_after=3)
        error = self.call_with(body)
        self.assertIn("500 b'abc' (본문 읽기 실패: ConnectionResetError)", str(error))
        self.assert_closed_once(body)

    def test_delete_500_closed_cleanup_failure(self):
        body = Body(b'{"value":{"error":"unknown error"}}')
        error = self.call_with(body, delete=True)
        self.assertIsInstance(error, smoke.CleanupFailure)
        self.assertEqual((error.status, smoke.driver_lost_exit(error)), (500, 2))
        self.assertEqual(self.transport_requests().count("DELETE /session/S"), 1)
        self.assert_closed_once(body)

    def test_delete_500_body_timeout_closed(self):
        body = Body(b"abc", fail=TimeoutError("timed out"), fail_after=3)
        error = self.call_with(body, delete=True)
        self.assertEqual((type(error), error.status, error.body_error, error.exit_code), (smoke.CleanupFailure, 500, "TimeoutError", 2))
        self.assert_closed_once(body)

    def test_interaction_500_is_failure_and_closed(self):
        body = Body(b"{}")
        error = self.call_with(body)
        self.assertIs(type(error), smoke.Failure)
        self.assert_closed_once(body)

    def test_read_programming_error_kept_and_closed(self):
        """8: 본문 읽기의 AttributeError는 그대로 보이고(전송 오류로 바꾸지 않음), 스트림은 닫힌다."""
        body = Body(fail=AttributeError("bug"))
        error = self.call_with(body)
        self.assertIsInstance(error, AttributeError)
        self.assertEqual(str(error), "bug")
        self.assert_closed_once(body)

    def test_close_failure_keeps_status_and_classification(self):
        """9: 본문은 읽었고 close()가 OSError → 상태 500·분류 그대로, 닫기 실패는 덧붙인 진단."""
        body = Body(b"{}", close_fail=OSError(5, "close failed"))
        error = self.call_with(body)
        self.assertIs(type(error), smoke.Failure)
        self.assertIn("POST /execute/sync: 500 b'{}'", str(error))
        self.assertIn("응답 닫기 실패: OSError", str(error))
        self.assertEqual(body.closes, 1)
        body = Body(b"{}", close_fail=OSError(5, "close failed"))
        error = self.call_with(body, delete=True)
        self.assertEqual((type(error), error.status, error.close_error, error.exit_code), (smoke.CleanupFailure, 500, "OSError", 2))
        self.assertEqual(error.diagnostic()["closeError"], "OSError")

    def test_read_and_close_failure_keep_primary(self):
        """10: 본문 읽기 시간 초과 + 닫기 실패 → 상태 500과 둘 다의 진단. 읽기 프로그래밍 오류 + 닫기 실패 → 원래 오류가 그대로."""
        body = Body(b"ab", fail=TimeoutError("timed out"), fail_after=2, close_fail=ConnectionResetError(104, "reset"))
        error = self.call_with(body, delete=True)
        self.assertEqual((type(error), error.status, error.body_error, error.close_error), (smoke.CleanupFailure, 500, "TimeoutError", "ConnectionResetError"))
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        bug = AttributeError("bug")
        body = Body(fail=bug, close_fail=OSError(5, "close failed"))
        error = self.call_with(body)
        self.assertIs(error, bug)
        self.assertTrue(any("응답 닫기도 실패" in n and "OSError" in n for n in error.__notes__))
        self.assertEqual(body.closes, 1)

    def test_close_programming_error_with_pending_does_not_replace(self):
        bug = AttributeError("read bug")
        body = Body(fail=bug, close_fail=RuntimeError("close bug"))
        error = self.call_with(body)
        self.assertIs(error, bug)
        self.assertTrue(any("RuntimeError" in n for n in error.__notes__))

    def test_close_programming_error_alone_is_not_hidden(self):
        """읽기는 됐는데 close()가 프로그래밍 오류 → 숨기지 않는다(전송 오류로 바꾸지 않음)."""
        body = Body(b"{}", close_fail=RuntimeError("close bug"))
        error = self.call_with(body)
        self.assertIsInstance(error, RuntimeError)
        self.assertIsInstance(error.__context__, urllib.error.HTTPError)  # 알던 HTTP 오류는 원인 사슬에 남는다

    def test_direct_timeout_before_status_still_driver_lost(self):
        self.http(interaction=lambda: TimeoutError("timed out"))
        driver = self.session()
        with self.assertRaises(smoke.DriverLost):
            driver.js(PROBE)


class HttpErrorReadClosePrecedence(WebDriverPaths):
    """T010 HTTPError 읽기·닫기 오류 우선순위: 예상한 본문 읽기 실패를 이미 기록했으면 닫기의 예상 못 한 오류도 진단으로만 남기고
    HTTP 분류를 지킨다. 읽기의 프로그래밍 오류가 올라가는 중이면 그것이 먼저, 읽기가 성공했으면 닫기 프로그래밍 오류는 숨기지 않는다."""

    def run_call(self, body: Body, *, delete: bool):
        if delete:
            transport = self.http(cleanup=lambda: http_error_body(500, body))
            driver = self.session_started()
            with self.assertRaises(Exception) as caught:
                smoke.end_session(driver)
        else:
            transport = self.http(interaction=lambda: http_error_body(500, body))
            driver = self.session()
            with self.assertRaises(Exception) as caught:
                driver.js(PROBE)
        return caught.exception, transport

    def test_A_delete_read_timeout_close_runtime_error(self):
        body = Body(b"abc", fail=TimeoutError("timed out"), fail_after=3, close_fail=RuntimeError("close bug"))
        error, transport = self.run_call(body, delete=True)
        self.assertIs(type(error), smoke.CleanupFailure)
        diagnostic = error.diagnostic()
        self.assertEqual((error.status, diagnostic["bodyReadError"], diagnostic["closeError"], diagnostic["kind"]),
                         (500, "TimeoutError", "RuntimeError", "cleanupFailure"))
        self.assertEqual(smoke.driver_lost_exit(error), 2)
        self.assertIsInstance(error.__cause__, urllib.error.HTTPError)
        self.assertEqual(body.closes, 1)
        self.assertEqual(transport.requests.count("DELETE /session/S"), 1)

    def test_B_interaction_read_timeout_close_runtime_error(self):
        body = Body(b"abc", fail=TimeoutError("timed out"), fail_after=3, close_fail=RuntimeError("close bug"))
        error, transport = self.run_call(body, delete=False)
        self.assertIs(type(error), smoke.Failure)  # 기능 실패(1), DriverLost·CleanupFailure 아님
        self.assertIn("POST /execute/sync: 500 b'abc' (본문 읽기 실패: TimeoutError) (응답 닫기 실패: RuntimeError)", str(error))
        self.assertEqual(body.closes, 1)
        self.assertEqual(sum(1 for b in transport.bodies if b and PROBE in b.get("script", "")), 1)  # 다시 보내지 않음

    def test_reset_read_close_runtime_error(self):
        body = Body(b"", fail=ConnectionResetError(104, "reset"), close_fail=RuntimeError("close bug"))
        error, _ = self.run_call(body, delete=True)
        self.assertEqual((type(error), error.status, error.body_error, error.close_error), (smoke.CleanupFailure, 500, "ConnectionResetError", "RuntimeError"))

    def test_C_read_bug_close_runtime_error_keeps_read_bug(self):
        bug = AttributeError("read bug")
        body = Body(fail=bug, close_fail=RuntimeError("close bug"))
        error, _ = self.run_call(body, delete=False)
        self.assertIs(error, bug)
        self.assertTrue(any("RuntimeError('close bug')" in n for n in error.__notes__))
        self.assertEqual(body.closes, 1)

    def test_D_read_ok_close_runtime_error_propagates(self):
        body = Body(b"{}", close_fail=RuntimeError("close bug"))
        error, _ = self.run_call(body, delete=True)
        self.assertIs(type(error), RuntimeError)
        self.assertNotIsInstance(error, (smoke.Failure, OSError))
        self.assertIsInstance(error.__context__, urllib.error.HTTPError)
        self.assertEqual(error.__context__.code, 500)
        self.assertEqual(body.closes, 1)

    def test_E_expected_close_failures_unchanged(self):
        body = Body(b"ab", fail=TimeoutError("timed out"), fail_after=2, close_fail=ConnectionResetError(104, "reset"))
        error, _ = self.run_call(body, delete=True)
        self.assertEqual((type(error), error.status, error.body_error, error.close_error, error.exit_code),
                         (smoke.CleanupFailure, 500, "TimeoutError", "ConnectionResetError", 2))
        body = Body(b"{}", close_fail=OSError(5, "close failed"))
        error, _ = self.run_call(body, delete=False)
        self.assertIs(type(error), smoke.Failure)
        self.assertIn("500 b'{}' (응답 닫기 실패: OSError)", str(error))
        self.http(interaction=lambda: TimeoutError("timed out"))
        driver = self.session()
        with self.assertRaises(smoke.DriverLost) as caught:
            driver.js(PROBE)
        self.assertEqual(caught.exception.transport, "readTimeout")


if __name__ == "__main__":
    unittest.main()
