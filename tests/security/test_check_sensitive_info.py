"""scripts/check-sensitive-info.py 회귀 테스트.

가짜 비밀값은 실행 시점에 문자열을 이어 붙여 만든다. 이 파일 자체에 검출 대상 원문이 들어가면
저장소 검사와 Gitleaks가 이 파일을 차단하기 때문이다.

실행: python3 -m unittest discover -s tests/security -v
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
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
    "타입 선언: password: PasswordType; secret: string",
    "참조: api_key = config.api_key, secret = os.environ['APP_SECRET']",
    "주소: git@github.com:MinGyu2/geul.git, noreply@example.com, logo@2x.png",
    "날짜: 2026-10-16, 해시 sha256:551f6fc83ea457d62a0d98237cbad105",
])


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


class ScannerTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Repo(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def assert_masked(self, result: subprocess.CompletedProcess[str], value: str) -> None:
        output = result.stdout + result.stderr
        self.assertNotIn(value, output, "비밀 원문이 출력에 노출됨")

    def test_each_rule_detects_synthetic_value_and_masks_it(self) -> None:
        for rule, sample in SYNTHETIC.items():
            with self.subTest(rule=rule):
                self.repo.stage("leak.txt", f"before\n{sample}\nafter\n")
                result = self.repo.scan("--staged")
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn(f"leak.txt:2: [{rule}]", result.stdout)
                self.assert_masked(result, sample.split()[-1] if rule.startswith("home") else sample)
                self.assertIn("***", result.stdout)

    def test_secret_values_are_not_echoed(self) -> None:
        token = SYNTHETIC["github-token"]
        self.repo.stage("config.ts", f"const token = '{token}';\n")
        result = self.repo.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assert_masked(result, token)
        self.assertIn("(len=40)", result.stdout)

    def test_clean_content_passes(self) -> None:
        self.repo.stage("docs/notes.md", CLEAN_TEXT + "\n")
        result = self.repo.scan("--staged")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("통과", result.stdout)

    def test_staged_mode_reads_index_not_worktree(self) -> None:
        self.repo.stage("a.txt", SYNTHETIC["aws-access-key-id"] + "\n")
        self.repo.write("a.txt", "clean now\n")  # 작업 트리만 정리, 인덱스에는 비밀이 남아 있음
        self.assertEqual(self.repo.scan("--staged").returncode, 1)

        self.repo.stage("a.txt", "clean\n")
        self.repo.write("a.txt", SYNTHETIC["aws-access-key-id"] + "\n")  # 스테이징 안 된 변경
        self.assertEqual(self.repo.scan("--staged").returncode, 0)

    def test_pragma_requires_rule_and_reason(self) -> None:
        line = SYNTHETIC["private-ip"]
        self.repo.stage("a.md", f"{line}  <!-- sensitive-info: allow private-ip -- RFC 1918 예시 주소 -->\n")
        self.assertEqual(self.repo.scan("--staged").returncode, 0)

        self.repo.stage("a.md", f"{line}  <!-- sensitive-info: allow private-ip -->\n")
        result = self.repo.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("사유 없는 예외", result.stderr)

        self.repo.stage("a.md", f"{line}  <!-- sensitive-info: allow email-address -- 다른 규칙 -->\n")
        self.assertEqual(self.repo.scan("--staged").returncode, 1)

    def test_allowlist_file_requires_reason(self) -> None:
        self.repo.stage("fixtures/net.txt", SYNTHETIC["private-ip"] + "\n")
        self.repo.write(".sensitive-info-allowlist", "private-ip fixtures/*.txt\n")
        result = self.repo.scan("--staged")
        self.assertEqual(result.returncode, 1)
        self.assertIn("사유 누락", result.stderr)

        self.repo.write(".sensitive-info-allowlist", "private-ip fixtures/*.txt -- 네트워크 파서 테스트 데이터\n")
        self.assertEqual(self.repo.scan("--staged").returncode, 0)

    def test_sensitive_file_names(self) -> None:
        for name in (".env", ".env.production", "deploy/id_ed25519", "signing.pem", ".netrc"):
            with self.subTest(name=name):
                self.repo.git("rm", "-rq", "--cached", "--ignore-unmatch", ".")
                self.repo.stage(name, "harmless\n")
                result = self.repo.scan("--staged")
                self.assertEqual(result.returncode, 1)
                self.assertIn("[sensitive-file]", result.stdout)
        self.repo.git("rm", "-rq", "--cached", "--ignore-unmatch", ".")
        self.repo.stage(".env.example", "API_URL=https://api.example.com\n")
        self.assertEqual(self.repo.scan("--staged").returncode, 0)

    def test_binary_and_gitlink_entries_are_skipped(self) -> None:
        self.repo.stage("image.bin", b"\x00\x01" + SYNTHETIC["aws-access-key-id"].encode())
        sha = "1a76570e833917d15817415a53c09ad61ab3203f"
        self.repo.git("update-index", "--add", "--cacheinfo", f"160000,{sha},external/engine")
        result = self.repo.scan("--staged")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("스테이징 파일 1개", result.stdout)

    def test_all_mode_scans_tracked_files(self) -> None:
        self.repo.stage("ok.md", CLEAN_TEXT)
        self.repo.commit("clean")
        self.assertEqual(self.repo.scan("--all").returncode, 0)
        self.repo.stage("src/app.py", SYNTHETIC["home-path-unix"] + "\n")
        self.repo.commit("leak")
        result = self.repo.scan("--all")
        self.assertEqual(result.returncode, 1)
        self.assertIn("src/app.py:1: [home-path-unix]", result.stdout)

    def test_history_mode_finds_secret_removed_later(self) -> None:
        self.repo.stage("cfg.yml", "a: 1\n")
        self.repo.commit("init")
        self.repo.stage("cfg.yml", "a: 1\nkey: " + SYNTHETIC["google-api-key"] + "\n")
        self.repo.commit("add key")
        leaked = self.repo.git("rev-parse", "HEAD").strip()
        self.repo.stage("cfg.yml", "a: 1\n")
        self.repo.commit("remove key")

        self.assertEqual(self.repo.scan("--all").returncode, 0, "현재 트리는 깨끗해야 함")
        result = self.repo.scan("--history")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"cfg.yml@{leaked[:12]}:2: [google-api-key]", result.stdout)
        self.assert_masked(result, SYNTHETIC["google-api-key"])

    def test_explicit_paths(self) -> None:
        self.repo.write("one.txt", SYNTHETIC["slack-token"] + "\n")
        self.repo.write("two.txt", "clean\n")
        self.assertEqual(self.repo.scan("two.txt").returncode, 0)
        self.assertEqual(self.repo.scan("one.txt", "two.txt").returncode, 1)

    def test_outside_git_repository_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as plain:
            result = subprocess.run([sys.executable, str(SCANNER), "--all"], cwd=plain, env=GIT_ENV,
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
