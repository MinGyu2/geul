"""scripts/check-sensitive-info.py 회귀 테스트.

가짜 비밀값은 실행 시점에 문자열을 이어 붙여 만든다. 이 파일 자체에 검출 대상 원문이 들어가면
저장소 검사와 Gitleaks가 이 파일을 차단하기 때문이다.

실행: python3 -m unittest discover -s tests/security -v
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCANNER = Path(__file__).resolve().parents[2] / "scripts" / "check-sensitive-info.py"

GIT_ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}


def j(*parts: str) -> str:
    return "".join(parts)


def load_scanner_module():
    spec = importlib.util.spec_from_file_location("check_sensitive_info", SCANNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module  # dataclass가 모듈을 찾을 수 있어야 한다
    spec.loader.exec_module(module)
    return module


# 규칙 ID -> 해당 규칙에 걸려야 하는 가짜 값(실행 시 조립).
SYNTHETIC = {
    "private-key": j("-----BEGIN ", "RSA PRIVATE", " KEY-----"),
    "aws-access-key-id": j("AKIA", "Z7Q2", "M4XW9PLK3TRB"),
    "github-token": j("ghp", "_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"),
    "gitlab-token": j("glpat", "-", "x9Y8z7W6v5U4t3S2r1Q0"),
    "slack-token": j("xox", "b-", "123456789012-abcdefGHIJKL"),
    "google-api-key": j("AIza", "Sy", "D3x4mpl3K3yV4lu3F0rT3st1ngPurp0s3"),
    "llm-api-key": j("sk-", "ant-", "api03-", "Q1w2E3r4", "T5y6U7i8", "O9p0A1s2", "D3f4G5h6"),
    "stripe-key": j("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"),
    "npm-token": j("npm_", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"),
    "jwt": j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N"),
    "url-credentials": j("https://deploy:", "S3cr3tPassw0rd", "@git.example.org/repo.git"),
    "secret-assignment": j("db_pass", "word = ", "\"Tr0ub4dor&3xyz\""),
    "home-path-unix": j("log at /", "home/", "alice/projects/geul/out.txt"),
    "home-path-macos": j("open /", "Users/", "bob/Documents/a.docx"),
    "home-path-windows": j("C:", "\\", "Users", "\\", "carol", "\\", "Desktop\\b.hwp"),
    "internal-host": j("https://", "build.corp", "/api"),
    "private-ip": j("server=", "192.168.", "10.24"),
    "korean-rrn": j("주민번호 ", "900101", "-", "1234567"),
    "phone-number": j("연락처 ", "010-", "1234-", "5678"),
    "email-address": j("contact: ", "kim.minsu", "@", "corp-mail.co.kr"),
}

CLEAN_TEXT = "\n".join([
    "계획 문서는 docs/planning/plan.md 에 있다.",
    "엔진: external/wordcraft/, external/rhwp/, src-tauri/src/",
    "시스템 경로: /usr/bin/python3, /etc/hosts, /opt/tool/bin, /nix/store/abc-git/bin/git, /root/.cargo",
    "Windows 시스템 경로: C:\\Program Files\\App, C:\\Users\\Public\\Documents, C:\\Users\\<USER>\\AppData",
    "자리표시자: /home/<USER>/project, /Users/<USER>/Library, /home/runner/work, $HOME/.config",
    "URL: https://github.com/edwardkim/rhwp, https://example.com/home/alice/page",
    "로컬 주소: http://localhost:1420, 127.0.0.1, 버전 v10.1.2.3",
    "설정 예: password = ${DB_PASSWORD}, api_key: <YOUR_API_KEY>, token: ${{ secrets.GITHUB_TOKEN }}",
    "참조: api_key = config.api_key, secret = os.environ['APP_SECRET']",
    "주소: git@github.com:MinGyu2/geul.git, noreply@example.com, logo@2x.png",
    "날짜: 2026-10-16, 해시 sha256:551f6fc83ea457d62a0d98237cbad105",
])


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def review_line(path: str, data: bytes, rule: str = "uninspected-binary") -> str:
    return f"{rule} {path} sha256={sha256(data)} -- 직접 검토한 테스트 바이너리\n"


def make_zip(entries: dict[str, bytes | str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class Repo:
    def __init__(self, root: Path):
        self.root = root
        self.git("init", "-q", "-b", "main")
        self.git("config", "commit.gpgsign", "false")

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *args], cwd=self.root, env=GIT_ENV, check=True,
                              capture_output=True, text=True).stdout

    def write(self, name: str, content: str | bytes) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")

    def stage(self, name: str, content: str | bytes) -> None:
        self.write(name, content)
        self.git("add", "--", name)

    def commit(self, message: str) -> None:
        self.git("commit", "-q", "-m", message)

    def scan(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(SCANNER), *args], cwd=self.root, env=GIT_ENV,
                              capture_output=True, text=True)

    def reset_index(self) -> None:
        self.git("rm", "-rq", "--cached", "--ignore-unmatch", ".")


class RepoTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def assert_masked(self, result: subprocess.CompletedProcess[str], value: str) -> None:
        output = result.stdout + result.stderr
        self.assertNotIn(value, output, "비밀 원문이 출력에 노출됨")

    def assert_exit(self, result: subprocess.CompletedProcess[str], code: int) -> None:
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        if code != 0:
            self.assertNotIn("검사 통과", result.stdout, "실패한 검사가 통과로 표시됨")

    def scan_staged_file(self, name: str, content: str | bytes) -> subprocess.CompletedProcess[str]:
        self.repo.reset_index()
        self.repo.stage(name, content)
        return self.repo.scan("--staged")


class ScannerTest(RepoTestCase):
    def test_each_rule_detects_synthetic_value_and_masks_it(self) -> None:
        for rule, sample in SYNTHETIC.items():
            with self.subTest(rule=rule):
                self.repo.stage("leak.txt", f"before\n{sample}\nafter\n")
                result = self.repo.scan("--staged")
                self.assert_exit(result, 1)
                self.assertIn(f"leak.txt:2: [{rule}]", result.stdout)
                self.assert_masked(result, sample.split()[-1] if rule.startswith("home") else sample)
                self.assertIn("***", result.stdout)

    def test_secret_values_are_not_echoed(self) -> None:
        token = SYNTHETIC["github-token"]
        self.repo.stage("config.ts", f"const token = '{token}';\n")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assert_masked(result, token)
        self.assertIn("(len=40)", result.stdout)

    def test_clean_content_passes(self) -> None:
        self.repo.stage("docs/notes.md", CLEAN_TEXT + "\n")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 0)
        self.assertIn("통과", result.stdout)

    def test_staged_mode_reads_index_not_worktree(self) -> None:
        self.repo.stage("a.txt", SYNTHETIC["aws-access-key-id"] + "\n")
        self.repo.write("a.txt", "clean now\n")  # 작업 트리만 정리, 인덱스에는 비밀이 남아 있음
        self.assert_exit(self.repo.scan("--staged"), 1)

        self.repo.stage("a.txt", "clean\n")
        self.repo.write("a.txt", SYNTHETIC["aws-access-key-id"] + "\n")  # 스테이징 안 된 변경
        self.assert_exit(self.repo.scan("--staged"), 0)

    def test_pragma_requires_rule_and_reason(self) -> None:
        line = SYNTHETIC["private-ip"]
        self.repo.stage("a.md", f"{line}  <!-- sensitive-info: allow private-ip -- RFC 1918 예시 주소 -->\n")
        self.assert_exit(self.repo.scan("--staged"), 0)

        self.repo.stage("a.md", f"{line}  <!-- sensitive-info: allow private-ip -->\n")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assertIn("사유 없는 예외", result.stderr)

        self.repo.stage("a.md", f"{line}  <!-- sensitive-info: allow email-address -- 다른 규칙 -->\n")
        self.assert_exit(self.repo.scan("--staged"), 1)

    def test_sensitive_file_names(self) -> None:
        for name in (".env", ".env.production", "deploy/id_ed25519", "signing.pem", ".netrc"):
            with self.subTest(name=name):
                result = self.scan_staged_file(name, "harmless\n")
                self.assert_exit(result, 1)
                self.assertIn("[sensitive-file]", result.stdout)
        self.assert_exit(self.scan_staged_file(".env.example", "API_URL=https://api.example.com\n"), 0)

    def test_gitlink_entries_are_skipped(self) -> None:
        self.repo.stage("ok.txt", "clean\n")
        sha = "1a76570e833917d15817415a53c09ad61ab3203f"
        self.repo.git("update-index", "--add", "--cacheinfo", f"160000,{sha},external/engine")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 0)
        self.assertIn("스테이징 파일 1개", result.stdout)

    def test_all_mode_scans_tracked_files(self) -> None:
        self.repo.stage("ok.md", CLEAN_TEXT)
        self.repo.commit("clean")
        self.assert_exit(self.repo.scan("--all"), 0)
        self.repo.stage("src/app.py", SYNTHETIC["home-path-unix"] + "\n")
        self.repo.commit("leak")
        result = self.repo.scan("--all")
        self.assert_exit(result, 1)
        self.assertIn("src/app.py:1: [home-path-unix]", result.stdout)

    def test_history_mode_finds_secret_removed_later(self) -> None:
        self.repo.stage("cfg.yml", "a: 1\n")
        self.repo.commit("init")
        self.repo.stage("cfg.yml", "a: 1\nkey: " + SYNTHETIC["google-api-key"] + "\n")
        self.repo.commit("add key")
        leaked = self.repo.git("rev-parse", "HEAD").strip()
        self.repo.stage("cfg.yml", "a: 1\n")
        self.repo.commit("remove key")

        self.assert_exit(self.repo.scan("--all"), 0)
        result = self.repo.scan("--history")
        self.assert_exit(result, 1)
        self.assertIn(f"cfg.yml@{leaked[:12]}:2: [google-api-key]", result.stdout)
        self.assert_masked(result, SYNTHETIC["google-api-key"])

    def test_explicit_paths(self) -> None:
        self.repo.write("one.txt", SYNTHETIC["slack-token"] + "\n")
        self.repo.write("two.txt", "clean\n")
        self.assert_exit(self.repo.scan("two.txt"), 0)
        self.assert_exit(self.repo.scan("one.txt", "two.txt"), 1)

    def test_outside_git_repository_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as plain:
            result = subprocess.run([sys.executable, str(SCANNER), "--all"], cwd=plain, env=GIT_ENV,
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


class SecretAssignmentTest(RepoTestCase):
    """A1: 글자만으로 된 값·짧은 값·부분 문자열을 자리표시자로 보던 문제."""

    def test_plausible_literal_passwords_are_detected(self) -> None:
        key = j("pass", "word")
        cases = [
            ("config.py", f'{key} = "{j("correct", "horse")}"'),
            ("config.py", f'{key} = "{j("Sunshine", "Pass")}"'),
            ("settings.yaml", f'{key}: "{j("aabb", "aabb")}"'),
            ("settings.yaml", f"{key}: {j('Sunshine', 'Pass')}"),  # YAML의 따옴표 없는 값도 리터럴
            ("app.toml", f'api_key = "{j("MyExample", "Key99")}"'),  # 'example' 부분 문자열
            ("app.toml", f'secret = "{j("prod.env.", "value1")}"'),  # 'env.' 부분 문자열
            ("notes.txt", f'{key} = "{j("Tr0ub4dor", "<3x")}"'),  # '<' 부분 문자열
            ("notes.md", f"{key}: {j('Password', 'Type')}"),  # 문서의 식별자 모양 값
            ("Main.java", f'String {key} = "{j("config.", "api_key")}";'),  # 따옴표 안 점 표기는 리터럴
            ("run.sh", f"{key}={j('hunter2', 'pass')}"),  # 셸의 따옴표 없는 단어는 리터럴
            ("deploy.yml", f"{key}: {j('${DB_PASSWORD', ':-fallback1}')}"),  # 기본값 문법의 리터럴
            ("app.ini", f"{key} = {j('DB_', 'PASSWORD')}"),  # 데이터 파일의 대문자 단어는 리터럴
            ("config.py", f'{key} = "{j("hunt", "er")}"'),  # 따옴표 안 6자(경계)
            ("settings.yaml", f"{key}: {j('hunt', 'er22')}"),  # 따옴표 없는 8자(경계)
        ]
        for name, line in cases:
            with self.subTest(line=line, file=name):
                result = self.scan_staged_file(name, line + "\n")
                self.assert_exit(result, 1)
                self.assertIn("[secret-assignment]", result.stdout)

    def test_explicit_placeholders_and_code_references_pass(self) -> None:
        key = j("pass", "word")
        cases = [
            ("deploy.yml", f"{key}: {j('${', 'DB_PASSWORD}')}"),
            ("deploy.yml", f'{key}: "{j("${", "DB_PASSWORD}")}"'),
            ("deploy.yml", f"api_key: {j('<YOUR_', 'API_KEY>')}"),
            ("run.sh", f"{key}={j('$', 'DB_PASSWORD')}"),
            ("run.bat", f"set {key}={j('%', 'DB_PASSWORD%')}"),
            ("config.json", f'"{key}": "{"*" * 8}"'),
            ("config.json", f'"{key}": "{j("your_", "password_here")}"'),
            ("template.yml", f"{key}: {j('{{', 'vault_password}}')}"),
            ("app.py", f"api_key = {j('config.', 'api_key')}"),
            ("app.py", f"secret = {j('os.environ', '[')}'APP_SECRET']"),
            ("app.py", f"{key} = {j('get_', 'password()')}"),
            ("app.py", f"{key} = {j('DB_', 'PASSWORD')}"),
            ("types.ts", f"  {key}: {j('Password', 'Type')};"),
            ("lib.rs", f"    private_key: {j('Option<', 'SecretString>')},"),
            ("guide.md", f"api_key = {j('settings.', 'api_key')}"),
            ("i18n.json", f'"{key}": "{j("Password must ", "be at least 8 characters")}"'),  # 공백 있는 문장
            ("config.py", f'{key} = "{j("hun", "te")}"'),  # 따옴표 안 5자(검출 하한 미만)
            ("settings.yaml", f"{key}: {j('hunt', 'er2')}"),  # 따옴표 없는 7자(검출 하한 미만)
        ]
        for name, line in cases:
            with self.subTest(line=line, file=name):
                self.assert_exit(self.scan_staged_file(name, line + "\n"), 0)

    def test_short_values_are_fully_masked(self) -> None:
        value = j("correct", "horse")
        result = self.scan_staged_file("a.py", f'{j("pass", "word")} = "{value}"\n')
        self.assert_exit(result, 1)
        self.assert_masked(result, value[:4])
        self.assertIn("*** (len=12)", result.stdout)


class LargeAndMalformedContentTest(RepoTestCase):
    """A2: 2 MiB를 넘는 파일의 내용 검사를 건너뛰고 통과시키던 문제."""

    def big_text(self, at: str) -> str:
        filler = "lorem ipsum dolor sit amet\n" * 120_000  # 약 3.2 MiB
        secret = SYNTHETIC["home-path-unix"] + "\n"
        if at == "start":
            return secret + filler
        if at == "middle":  # 예전 2 MiB 한도 뒤
            return filler[: 2_600_000] + "\n" + secret + filler[2_600_000:]
        return filler + secret

    def test_large_files_are_fully_scanned(self) -> None:
        for at in ("start", "middle", "end"):
            with self.subTest(position=at):
                result = self.scan_staged_file("big.log.txt", self.big_text(at))
                self.assert_exit(result, 1)
                self.assertIn("[home-path-unix]", result.stdout)
                self.assertNotIn("건너뜀", result.stderr)

    def test_large_files_are_scanned_in_all_and_history_modes(self) -> None:
        self.repo.stage("big.txt", self.big_text("middle"))
        self.repo.commit("big")
        self.assert_exit(self.repo.scan("--all"), 1)
        self.assert_exit(self.repo.scan("--history"), 1)

    def test_secret_spanning_long_line_window_is_found(self) -> None:
        token = SYNTHETIC["github-token"]
        line = "a" * ((1 << 20) - 10) + " " + token + " " + "b" * 50  # 1 MiB 구간 경계에 걸침
        result = self.scan_staged_file("min.js", line)
        self.assert_exit(result, 1)
        self.assertIn("[github-token]", result.stdout)
        self.assert_masked(result, token)

    def test_malformed_utf8_is_scanned_predictably(self) -> None:
        token = SYNTHETIC["aws-access-key-id"]
        result = self.scan_staged_file("bad.txt", b"\xc3(\x80" + b" key " + token.encode() + b"\n\xed\xa0\x80\n")
        self.assert_exit(result, 1)
        self.assertIn("[aws-access-key-id]", result.stdout)

    def test_fake_utf16_bom_does_not_hide_ascii_secret(self) -> None:
        # UTF-16 BOM 뒤에 ASCII를 두면 UTF-16으로만 해석할 때 비밀이 깨져 보인다. 두 방식 모두 검사해야 한다.
        token = SYNTHETIC["aws-access-key-id"]
        result = self.scan_staged_file("bom.txt", b"\xff\xfe" + b"key " + token.encode() + b"\n")
        self.assert_exit(result, 1)
        self.assertIn("[aws-access-key-id]", result.stdout)

    def test_utf16_with_bom_is_decoded(self) -> None:
        text = "x\n" + SYNTHETIC["private-ip"] + "\n"
        result = self.scan_staged_file("win.txt", text.encode("utf-16"))
        self.assert_exit(result, 1)
        self.assertIn("win.txt:2: [private-ip]", result.stdout)

    def test_unreadable_file_fails_closed(self) -> None:
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root는 권한 검사를 우회함")
        self.repo.stage("secret.txt", "clean\n")
        self.repo.commit("add")
        target = self.repo.root / "secret.txt"
        target.chmod(0)
        try:
            result = self.repo.scan("--all")
        finally:
            target.chmod(0o644)
        self.assert_exit(result, 2)
        self.assertIn("검사를 완료하지 못했습니다", result.stderr)

    def test_missing_explicit_path_fails_closed(self) -> None:
        self.assert_exit(self.repo.scan("does-not-exist.txt"), 2)

    def test_text_over_hard_limit_is_reported_not_skipped(self) -> None:
        module = load_scanner_module()
        module.MAX_TEXT_BYTES = 64
        hits = module.ContentScanner([]).scan(iter([b"clean line\n" * 100]), "x.txt", "x.txt").hits
        self.assertEqual({hit.rule for hit in hits}, {"uninspected-content"})


class BinaryAndArchiveTest(RepoTestCase):
    """A5: 바이너리·ZIP 기반 문서는 검사하거나, 검사하지 못하면 검토 예외 없이 통과하지 않는다."""

    def test_binary_requires_review(self) -> None:
        result = self.scan_staged_file("image.bin", b"\x00\x01" + SYNTHETIC["aws-access-key-id"].encode())
        self.assert_exit(result, 1)
        self.assertIn("[uninspected-binary]", result.stdout)

        result = self.scan_staged_file("doc.hwp", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64)
        self.assert_exit(result, 1)
        self.assertIn("OLE", result.stdout)

        self.repo.reset_index()
        icon = b"\x89PNG\r\n\x1a\n\x00\x00"
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/icon.png", icon))
        self.repo.stage("assets/icon.png", icon)
        self.assert_exit(self.repo.scan("--staged"), 0)

    def test_utf16_without_bom_is_not_silently_passed(self) -> None:
        result = self.scan_staged_file("w.txt", (SYNTHETIC["private-ip"] + "\n").encode("utf-16-le"))
        self.assert_exit(result, 1)
        self.assertIn("[uninspected-binary]", result.stdout)

    def test_zip_document_text_entries_are_scanned(self) -> None:
        body = f"<w:t>{SYNTHETIC['github-token']}</w:t>"
        result = self.scan_staged_file("fixture.docx", make_zip({"word/document.xml": body}))
        self.assert_exit(result, 1)
        self.assertIn("fixture.docx!word/document.xml:1: [github-token]", result.stdout)
        self.assert_masked(result, SYNTHETIC["github-token"])

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("word/document.xml", "<w:t>hello</w:t>")
            archive.comment = SYNTHETIC["private-ip"].encode()
        result = self.scan_staged_file("comment.docx", buffer.getvalue())
        self.assert_exit(result, 1)
        self.assertIn("comment.docx!(comment):1: [private-ip]", result.stdout)

    def test_document_metadata_is_reported(self) -> None:
        core = "<cp:coreProperties><dc:creator>Kim Minsu</dc:creator><cp:lastModifiedBy></cp:lastModifiedBy>"
        result = self.scan_staged_file("meta.docx", make_zip({"docProps/core.xml": core}))
        self.assert_exit(result, 1)
        self.assertIn("[document-metadata]", result.stdout)
        self.assertNotIn("Kim Minsu", result.stdout)

        hpf = '<opf:meta name="creator" content="text">Lee</opf:meta>'
        result = self.scan_staged_file("meta.hwpx", make_zip({"Contents/content.hpf": hpf}))
        self.assert_exit(result, 1)
        self.assertIn("[document-metadata]", result.stdout)

        empty = "<cp:coreProperties><dc:creator></dc:creator></cp:coreProperties>"
        self.assert_exit(self.scan_staged_file("clean.docx", make_zip({"docProps/core.xml": empty})), 0)

    def test_binary_entries_inside_archive_require_review(self) -> None:
        data = make_zip({"word/document.xml": "<w:t>hello</w:t>", "word/media/image1.png": b"\x89PNG\x00\x00"})
        result = self.scan_staged_file("pic.docx", data)
        self.assert_exit(result, 1)
        self.assertIn("[uninspected-binary]", result.stdout)

    def test_unsafe_archive_paths_are_reported(self) -> None:
        for name in ("../escape.xml", "/abs.xml", "dir\\win.xml"):
            with self.subTest(name=name):
                result = self.scan_staged_file("evil.docx", make_zip({name: "<x/>"}))
                self.assert_exit(result, 1)
                self.assertIn("[archive-unsafe-path]", result.stdout)

    def test_corrupt_archive_is_not_passed(self) -> None:
        data = make_zip({"word/document.xml": "<w:t>" + "hello " * 2000 + "</w:t>"})
        result = self.scan_staged_file("truncated.docx", data[: len(data) // 2])
        self.assert_exit(result, 1)
        self.assertIn("[uninspected-binary]", result.stdout)

    def test_archive_limits(self) -> None:
        module = load_scanner_module()
        module.MAX_ARCHIVE_ENTRIES = 2
        hits = module.ContentScanner([]).scan(iter([make_zip({f"{i}.xml": "<x/>" for i in range(3)})]), "a.zip", "a").hits
        self.assertEqual({hit.rule for hit in hits}, {"uninspected-binary"})

        module = load_scanner_module()
        module.MAX_ARCHIVE_ENTRY_BYTES = 1000
        bomb = make_zip({"big.xml": "<x>" + "A" * 100_000 + "</x>"})  # 압축하면 작지만 풀면 큰 항목
        hits = module.ContentScanner([]).scan(iter([bomb]), "a.zip", "a").hits
        self.assertEqual({hit.rule for hit in hits}, {"uninspected-binary"})


class AllowlistConsistencyTest(RepoTestCase):
    """A3: --staged 검사가 작업 트리의 예외 목록을 읽던 문제와 예외 목록 검증."""

    LINE = "private-ip fixtures/*.txt -- 네트워크 파서 테스트 데이터\n"

    def stage_secret(self) -> None:
        self.repo.stage("fixtures/net.txt", SYNTHETIC["private-ip"] + "\n")

    def test_unstaged_allowlist_does_not_authorize_staged_secret(self) -> None:
        self.stage_secret()
        self.repo.write(".sensitive-info-allowlist", self.LINE)  # 추적되지 않음
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assertIn("스테이징되지 않은 예외 목록", result.stderr)

        self.repo.stage(".sensitive-info-allowlist", "# 빈 목록\n")
        self.repo.write(".sensitive-info-allowlist", self.LINE)  # 스테이징된 버전과 다름
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assertIn("작업 트리 변경은 반영하지 않음", result.stderr)

    def test_staged_allowlist_with_matching_file_passes(self) -> None:
        self.stage_secret()
        self.repo.stage(".sensitive-info-allowlist", self.LINE)
        self.assert_exit(self.repo.scan("--staged"), 0)

    def test_allowlist_modified_after_staging_uses_staged_version(self) -> None:
        self.stage_secret()
        self.repo.stage(".sensitive-info-allowlist", self.LINE)
        self.repo.write(".sensitive-info-allowlist", "# 작업 트리에서 지움\n")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 0)
        self.assertIn("스테이징된 버전 사용", result.stderr)

    def test_removed_allowlist_no_longer_authorizes(self) -> None:
        self.stage_secret()
        self.repo.stage(".sensitive-info-allowlist", self.LINE)
        self.repo.commit("with allowlist")
        self.repo.git("rm", "-q", "--", ".sensitive-info-allowlist")
        self.repo.stage("fixtures/net.txt", SYNTHETIC["private-ip"] + "\nmore\n")
        self.assert_exit(self.repo.scan("--staged"), 1)

    def test_all_mode_ignores_untracked_allowlist(self) -> None:
        self.stage_secret()
        self.repo.commit("secret")
        self.repo.write(".sensitive-info-allowlist", self.LINE)
        result = self.repo.scan("--all")
        self.assert_exit(result, 1)
        self.assertIn("추적하지 않는 예외 목록", result.stderr)
        self.repo.stage(".sensitive-info-allowlist", self.LINE)
        self.assert_exit(self.repo.scan("--all"), 0)

    def test_history_uses_allowlist_committed_at_head(self) -> None:
        self.stage_secret()
        self.repo.stage(".sensitive-info-allowlist", self.LINE)
        self.repo.commit("secret with allowlist")
        self.assert_exit(self.repo.scan("--history"), 0)
        self.repo.stage(".sensitive-info-allowlist", "# 예외 철회\n")
        self.assert_exit(self.repo.scan("--history"), 0)  # 아직 커밋되지 않은 변경은 HEAD 기준에 없음
        self.repo.commit("revoke")
        self.assert_exit(self.repo.scan("--history"), 1)

    def test_invalid_allowlist_entries_are_errors(self) -> None:
        cases = {
            "private-ip fixtures/*.txt\n": "사유",  # 사유 누락
            "private-ip fixtures/*.txt -- \n": "사유",
            "private-ip fixtures/*.txt -- ok\n": "사유",  # 너무 짧은 사유
            "privat-ip fixtures/*.txt -- 오타 규칙 테스트\n": "알 수 없는 규칙",
            "private-ip * -- 모든 파일 허용 시도\n": "지나치게 넓은",
            "private-ip **/*.txt -- 모든 텍스트 허용 시도\n": "지나치게 넓은",
            "private-ip *.txt -- 최상위 와일드카드\n": "지나치게 넓은",
            "private-ip /etc/hosts -- 절대 경로\n": "상대 경로",
            "private-ip fixtures/../x.txt -- 상위 경로\n": "'..'",
            "private-ip fixtures/a.txt extra -- 필드 과다\n": "형식 오류",
        }
        for text, message in cases.items():
            with self.subTest(entry=text.strip()):
                self.repo.reset_index()
                self.stage_secret()
                self.repo.stage(".sensitive-info-allowlist", text)
                result = self.repo.scan("--staged")
                self.assert_exit(result, 2)
                self.assertIn(message, result.stderr)


class RelatedFalseNegativeTest(RepoTestCase):
    """A4: 이메일 도메인 접미사 일치, 홈 경로 변형, 병합 커밋·형식 변경 누락."""

    def test_lookalike_email_domains_are_detected(self) -> None:
        for address in (j("kim", "@", "evil", "example.com"), j("lee", "@", "anthropic.com"),
                        j("park.noreply", "@", "gmail.com"), j("choi", "@", "noreply.github.com.evil.io")):
            with self.subTest(address=address):
                self.assert_exit(self.scan_staged_file("a.txt", f"mail {address}\n"), 1)
        for address in (j("noreply", "@", "anthropic.com"), j("123+u", "@", "users.noreply.github.com"),
                        j("dev", "@", "mail.example.com"), j("git", "@", "github.com")):
            with self.subTest(address=address):
                self.assert_exit(self.scan_staged_file("a.txt", f"mail {address}\n"), 0)

    def test_home_path_variants_are_detected(self) -> None:
        for path in (j("/", "var/home/", "alice/x"), j("/mnt/c/", "Users/", "alice/x"),
                     j("file:///", "home/", "alice/x")):
            with self.subTest(path=path):
                self.assert_exit(self.scan_staged_file("a.txt", path + "\n"), 1)

    def test_secret_introduced_in_merge_commit_is_found(self) -> None:
        self.repo.stage("base.txt", "base\n")
        self.repo.commit("base")
        self.repo.git("switch", "-qc", "topic")
        self.repo.stage("topic.txt", "topic\n")
        self.repo.commit("topic")
        self.repo.git("switch", "-q", "main")
        self.repo.stage("main.txt", "main\n")
        self.repo.commit("main")
        self.repo.git("merge", "-q", "--no-commit", "topic")
        self.repo.stage("merge-only.txt", SYNTHETIC["private-ip"] + "\n")
        self.repo.commit("merge")
        result = self.repo.scan("--history")
        self.assert_exit(result, 1)
        self.assertIn("merge-only.txt@", result.stdout)

    def test_type_change_from_symlink_is_scanned(self) -> None:
        self.repo.write("target.txt", "x\n")
        (self.repo.root / "link").symlink_to("target.txt")
        self.repo.git("add", "target.txt", "link")
        self.repo.commit("link")
        (self.repo.root / "link").unlink()
        self.repo.stage("link", SYNTHETIC["private-ip"] + "\n")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assertIn("link:1: [private-ip]", result.stdout)

    def test_binary_and_sensitive_names_in_history_are_reported(self) -> None:
        self.repo.stage("blob.bin", b"\x00\x01\x02")
        self.repo.stage(".env", "")
        self.repo.commit("binary")
        self.repo.git("rm", "-q", "blob.bin", ".env")
        self.repo.commit("remove")
        result = self.repo.scan("--history")
        self.assert_exit(result, 1)
        self.assertIn("[uninspected-binary]", result.stdout)
        self.assertIn("[sensitive-file]", result.stdout)



PNG_V1 = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16 + b"reviewed-v1"
PNG_V2 = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16 + b"changed-v2"


class BinaryExceptionTest(RepoTestCase):
    """A1: 바이너리 예외는 정확한 경로와 검토한 내용(sha256)에만 적용된다."""

    def test_exact_reviewed_binary_is_accepted(self) -> None:
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V1))
        self.repo.stage("assets/logo.png", PNG_V1)
        self.assert_exit(self.repo.scan("--staged"), 0)
        self.repo.commit("reviewed")
        self.assert_exit(self.repo.scan("--all"), 0)
        self.assert_exit(self.repo.scan("--history"), 0)

    def test_different_binary_at_same_path_is_rejected(self) -> None:
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V1))
        self.repo.stage("assets/logo.png", PNG_V2)
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assertIn("assets/logo.png: [uninspected-binary]", result.stdout)

    def test_wildcard_binary_exception_is_refused_and_new_file_not_covered(self) -> None:
        self.repo.stage(".sensitive-info-allowlist", "uninspected-binary assets/*.png -- 예전 형식의 넓은 예외\n")
        self.repo.stage("assets/new.png", PNG_V2)
        result = self.repo.scan("--staged")
        self.assert_exit(result, 2)
        self.assertIn("정확한 경로", result.stderr)

        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V1))
        self.repo.stage("assets/logo.png", PNG_V1)
        result = self.repo.scan("--staged")
        self.assert_exit(result, 1)
        self.assertIn("assets/new.png: [uninspected-binary]", result.stdout)
        self.assertNotIn("assets/logo.png:", result.stdout)

    def test_renamed_reviewed_binary_is_rejected(self) -> None:
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V1))
        self.repo.stage("assets/renamed.png", PNG_V1)
        self.assert_exit(self.repo.scan("--staged"), 1)

    def test_modified_staged_binary_uses_index_content(self) -> None:
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V1))
        self.repo.stage("assets/logo.png", PNG_V1)
        self.repo.commit("reviewed")
        self.repo.stage("assets/logo.png", PNG_V2)
        self.repo.write("assets/logo.png", PNG_V1)  # 작업 트리는 검토한 내용, 인덱스는 다른 내용
        self.assert_exit(self.repo.scan("--staged"), 1)
        self.assert_exit(self.repo.scan("--all"), 0)  # --all은 작업 트리 내용을 검사한다

        self.repo.stage("assets/logo.png", PNG_V1)
        self.repo.write("assets/logo.png", PNG_V2)  # 반대로 작업 트리만 바뀜
        self.assert_exit(self.repo.scan("--staged"), 0)
        self.assert_exit(self.repo.scan("--all"), 1)

    def test_wrong_or_malformed_sha256(self) -> None:
        self.repo.stage("assets/logo.png", PNG_V1)
        self.repo.stage(".sensitive-info-allowlist",
                        f"uninspected-binary assets/logo.png sha256={'0' * 64} -- 다른 내용의 해시\n")
        self.assert_exit(self.repo.scan("--staged"), 1)
        for bad in ("sha256=" + "A" * 64, "sha256=" + "0" * 63, "sha1=" + "0" * 40):
            with self.subTest(digest=bad):
                self.repo.stage(".sensitive-info-allowlist", f"uninspected-binary assets/logo.png {bad} -- 형식 오류\n")
                result = self.repo.scan("--staged")
                self.assert_exit(result, 2)
                self.assertIn("sha256", result.stderr)

    def test_missing_reason_or_digest_is_rejected(self) -> None:
        self.repo.stage("assets/logo.png", PNG_V1)
        self.repo.stage(".sensitive-info-allowlist", f"uninspected-binary assets/logo.png sha256={sha256(PNG_V1)}\n")
        self.assert_exit(self.repo.scan("--staged"), 2)
        self.repo.stage(".sensitive-info-allowlist", "uninspected-binary assets/logo.png -- 해시 없는 예외\n")
        result = self.repo.scan("--staged")
        self.assert_exit(result, 2)
        self.assertIn("sha256", result.stderr)

    def test_history_versions_need_their_own_review(self) -> None:
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V1))
        self.repo.stage("assets/logo.png", PNG_V1)
        self.repo.commit("v1 reviewed")
        self.repo.stage(".sensitive-info-allowlist", review_line("assets/logo.png", PNG_V2))
        self.repo.stage("assets/logo.png", PNG_V2)
        self.repo.commit("v2 reviewed, v1 entry dropped")
        result = self.repo.scan("--history")
        self.assert_exit(result, 1)  # 이력의 v1은 HEAD 예외 목록의 v2 승인을 물려받지 않는다
        self.assertEqual(result.stdout.count("[uninspected-binary]"), 1)
        self.assert_exit(self.repo.scan("--all"), 0)

        self.repo.stage(".sensitive-info-allowlist",
                        review_line("assets/logo.png", PNG_V1) + review_line("assets/logo.png", PNG_V2))
        self.repo.commit("both versions reviewed")
        self.assert_exit(self.repo.scan("--history"), 0)

    def test_content_bound_rules_cover_archives_and_metadata(self) -> None:
        archive = make_zip({"docProps/core.xml": "<dc:creator>Kim Minsu</dc:creator>"})
        self.repo.stage("fixtures/doc.docx", archive)
        self.repo.stage(".sensitive-info-allowlist", "document-metadata fixtures/*.docx -- 넓은 예외 시도\n")
        self.assert_exit(self.repo.scan("--staged"), 2)
        self.repo.stage(".sensitive-info-allowlist", review_line("fixtures/doc.docx", archive, "document-metadata"))
        self.assert_exit(self.repo.scan("--staged"), 0)


SECRET_TOKEN = SYNTHETIC["github-token"]
SECRET_EMAIL = j("kim.minsu", "@", "corp-mail.co.kr")
SECRET_USER = "alicesecretuser"


class DiagnosticSanitizationTest(RepoTestCase):
    """A2: 압축 항목 이름·경로·오류 메시지에 든 민감정보와 제어 문자가 그대로 출력되지 않는다."""

    def assert_clean_output(self, result: subprocess.CompletedProcess[str]) -> None:
        output = result.stdout + result.stderr
        for value in (SECRET_TOKEN, SECRET_EMAIL, SECRET_USER, "kim.minsu"):
            self.assertNotIn(value, output)
        self.assertNotIn("\x1b", output)
        self.assertNotIn("\r", output)
        for line in output.splitlines():
            self.assertFalse(line.startswith("FAKE"), f"가짜 줄 주입: {line!r}")

    def test_sensitive_archive_entry_names_are_masked(self) -> None:
        home = j("/", "home/", SECRET_USER, "/notes.xml")
        entries = {
            f"word/{SECRET_TOKEN}.xml": "<x/>",
            f"media/{SECRET_EMAIL}.xml": "<x/>",
            home: "<x/>",
            "../" + SECRET_TOKEN + ".xml": "<x/>",
            f"word/{SECRET_TOKEN}.png": b"\x89PNG\x00\x00",
            "word/a\nFAKE: all clean\r.xml": "<w:t>" + SYNTHETIC["private-ip"] + "</w:t>",
            "word/b\x1b[2J\x1b[31mred.xml": SYNTHETIC["private-ip"] + " sensitive-info: allow no-such-rule -- 경고 유도",
        }
        result = self.scan_staged_file("evil.docx", make_zip(entries))
        self.assert_exit(result, 1)
        self.assert_clean_output(result)
        self.assertIn("[github-token]", result.stdout)
        self.assertIn("[email-address]", result.stdout)
        self.assertIn("[home-path-unix]", result.stdout)
        self.assertIn("[archive-unsafe-path]", result.stdout)
        self.assertIn("[uninspected-binary]", result.stdout)
        self.assertIn("evil.docx!word/a\\u000aFAKE", result.stdout)  # 줄바꿈은 이스케이프되어 한 줄에 남는다
        self.assertIn("\\u001b[2J", result.stderr)

    def test_sensitive_repository_path_is_reported_and_masked(self) -> None:
        result = self.scan_staged_file(f"config/{SECRET_TOKEN}.txt", "clean\n")
        self.assert_exit(result, 1)
        self.assertIn("[github-token]", result.stdout)
        self.assert_clean_output(result)

    def test_malformed_archive_entry_is_not_clean(self) -> None:
        data = bytearray(make_zip({"word/document.xml": "<w:t>" + "hello " * 200 + "</w:t>"}))
        data[30 + len("word/document.xml") + 4] ^= 0xFF  # 지역 헤더 뒤 압축 데이터 손상
        result = self.scan_staged_file(f"{SECRET_TOKEN}.docx", bytes(data))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("[uninspected-binary]", result.stdout)
        self.assert_clean_output(result)

    def test_safe_escapes_control_and_bidi_characters(self) -> None:
        module = load_scanner_module()
        text = module.safe("a\nb\rc\x1b[31md\u202ee\u2028f\x00")
        self.assertNotRegex(text, "[\x00-\x1f\u202e\u2028]")
        self.assertIn("\\u000a", text)


def random_binary(size: int, seed: int = 7) -> bytes:
    import random
    generator = random.Random(seed)
    return bytes(generator.randrange(1, 256) for _ in range(size))  # NUL 없음


class BinaryDetectionTest(RepoTestCase):
    """A3: 첫 8 KiB에 NUL이 없는 바이너리를 텍스트로 보고 통과시키던 문제."""

    KOREAN = "한글 문서 편집기 개발 메모입니다. 표와 그림을 다룹니다.\n"

    def test_valid_text_encodings_pass(self) -> None:
        cases = {
            "ko.md": self.KOREAN.encode("utf-8"),
            "bom.txt": b"\xef\xbb\xbf" + self.KOREAN.encode("utf-8"),
            "utf16.txt": self.KOREAN.encode("utf-16"),
            "big-ko.txt": (self.KOREAN * 60_000).encode("utf-8"),  # 약 5 MiB
        }
        for name, data in cases.items():
            with self.subTest(file=name):
                result = self.scan_staged_file(name, data)
                self.assert_exit(result, 0)
                self.assertNotIn("대체 문자", result.stderr)

    def test_slightly_invalid_utf8_is_scanned_with_warning(self) -> None:
        data = self.KOREAN.encode("utf-8") * 20 + b"caf\xe9 latin-1 byte\n"
        result = self.scan_staged_file("legacy.txt", data)
        self.assert_exit(result, 0)
        self.assertIn("대체 문자", result.stderr)

    def test_binary_without_nul_in_first_sample_is_rejected(self) -> None:
        result = self.scan_staged_file("blob.dat", random_binary(20_000))
        self.assert_exit(result, 1)
        self.assertIn("[uninspected-binary]", result.stdout)

    def test_binary_after_text_prefix_is_rejected(self) -> None:
        for name, data in {
            "nul-later.txt": self.KOREAN.encode() * 400 + b"\x00\x01\x02" + self.KOREAN.encode(),
            "blob-later.txt": self.KOREAN.encode() * 2000 + random_binary(70_000),
        }.items():
            with self.subTest(file=name):
                result = self.scan_staged_file(name, data)
                self.assert_exit(result, 1)
                self.assertIn("[uninspected-binary]", result.stdout)

    def test_known_binary_signatures_without_nul_are_rejected(self) -> None:
        samples = {
            "tiny.png": b"\x89PNG\r\n\x1a\nx",
            "photo.jpg": b"\xff\xd8\xff\xe1Exif-like",
            "anim.gif": b"GIF89a-like header",
            "doc.pdf": b"%PDF-1.7\n% text-looking header\n",
            "legacy.hwp": b"HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05",
            "data.gz": b"\x1f\x8b\x08\x08compressed",
        }
        for name, data in samples.items():
            with self.subTest(file=name):
                result = self.scan_staged_file(name, data)
                self.assert_exit(result, 1)
                self.assertIn("[uninspected-binary]", result.stdout)

    def test_secret_near_end_of_large_text_is_found(self) -> None:
        data = (self.KOREAN * 60_000 + SYNTHETIC["aws-access-key-id"] + "\n").encode()
        result = self.scan_staged_file("big.txt", data)
        self.assert_exit(result, 1)
        self.assertIn("[aws-access-key-id]", result.stdout)
        self.assertNotIn("[uninspected-binary]", result.stdout)


class MissingTrackedFileTest(RepoTestCase):
    """A4: --all에서 추적 중인 파일을 읽지 못하면 통과로 보지 않는다."""

    def setUp(self) -> None:
        super().setUp()
        self.repo.stage("keep.txt", "clean\n")
        self.repo.stage("docs/gone.txt", "clean\n")
        self.repo.commit("base")

    def test_clean_repository_and_normal_file(self) -> None:
        result = self.repo.scan("--all")
        self.assert_exit(result, 0)
        self.assertIn("추적 파일 2개", result.stdout)

    def test_unstaged_deletion_is_incomplete(self) -> None:
        (self.repo.root / "docs/gone.txt").unlink()
        result = self.repo.scan("--all")
        self.assert_exit(result, 2)
        self.assertIn("docs/gone.txt", result.stderr)
        self.assertIn("git rm", result.stderr)
        self.assertNotIn(str(self.repo.root), result.stdout + result.stderr)

    def test_unexpectedly_missing_directory_is_incomplete(self) -> None:
        (self.repo.root / "docs/gone.txt").unlink()
        (self.repo.root / "docs").rmdir()
        self.assert_exit(self.repo.scan("--all"), 2)

    def test_staged_deletion_passes(self) -> None:
        self.repo.git("rm", "-q", "docs/gone.txt")
        result = self.repo.scan("--all")
        self.assert_exit(result, 0)
        self.assertIn("추적 파일 1개", result.stdout)

    def test_broken_symlink_is_scanned_by_target_text(self) -> None:
        link = self.repo.root / "link"
        link.symlink_to("no/such/target")
        self.repo.git("add", "link")
        self.assert_exit(self.repo.scan("--all"), 0)
        link.unlink()
        link.symlink_to(j("/", "home/", SECRET_USER, "/missing"))
        self.repo.git("add", "link")
        result = self.repo.scan("--all")
        self.assert_exit(result, 1)
        self.assertIn("link:1: [home-path-unix]", result.stdout)
        self.assertNotIn(SECRET_USER, result.stdout + result.stderr)

    def test_read_failure_is_incomplete(self) -> None:
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self.skipTest("root는 권한 검사를 우회함")
        target = self.repo.root / "keep.txt"
        target.chmod(0)
        try:
            result = self.repo.scan("--all")
        finally:
            target.chmod(0o644)
        self.assert_exit(result, 2)


if __name__ == "__main__":
    unittest.main()
