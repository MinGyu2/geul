#!/usr/bin/env python3
"""공개 저장소용 민감정보 검사기.

검사 대상
  --staged   (기본값) 스테이징된 파일의 인덱스 내용. pre-commit 훅에서 사용한다.
  --all      Git이 추적 중인 모든 파일의 작업 트리 내용. 최초 공개 전과 CI에서 사용한다.
  --history  모든 ref의 커밋에서 추가된 줄. 최초 공개 전 이력 검사에 사용한다.
  PATH ...   지정한 파일만 검사한다.

검출 결과는 파일·줄·규칙·마스킹된 값만 출력하며 비밀 원문은 출력하지 않는다.
종료 코드: 0 = 발견 없음, 1 = 발견 있음, 2 = 사용법/실행 오류.

오탐 예외(검토 후에만 사용):
  - 같은 줄 주석: `sensitive-info: allow <rule-id> -- <사유>`
  - `.sensitive-info-allowlist`: `<rule-id> <경로 glob> -- <사유>` (한 줄에 하나)
사유가 없는 예외는 무시되고 경고가 출력된다. Git submodule(gitlink) 내용은 상위 저장소 검사
대상이 아니며 업스트림 검토에서 별도로 다룬다.
"""

from __future__ import annotations

import argparse
import fnmatch
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import PurePosixPath

MAX_FILE_BYTES = 2 * 1024 * 1024
ALLOWLIST_FILE = ".sensitive-info-allowlist"
PRAGMA_RE = re.compile(r"sensitive-info:\s*allow\s+([a-z0-9-]+)(?:\s+--\s+(.*))?")
COMMENT_CLOSERS = re.compile(r"\s*(?:-->|\*/|#\}|%>)\s*$")

# 문서용 자리표시자와 공용 계정 이름. 실제 사용자 홈 경로로 보지 않는다.
PLACEHOLDER_USERS = {
    "<user>", "<username>", "{user}", "{username}", "$user", "${user}", "%username%", "%user%",
    "user", "username", "you", "your-name", "yourname", "example", "runner",
    "public", "default", "default user", "all users", "shared", "guest",
}

SECRET_VALUE_PLACEHOLDERS = (
    "<", "${", "{{", "$(", "xxx", "***", "...", "example", "changeme", "change-me", "dummy",
    "placeholder", "your_", "your-", "redacted", "masked", "secrets.", "env.", "process.env",
    "os.environ", "getenv",
)


@dataclass(frozen=True)
class Rule:
    id: str
    description: str
    pattern: re.Pattern[str]
    group: int = 0  # 마스킹할 그룹


@dataclass
class Finding:
    rule: str
    description: str
    location: str
    line: int
    value: str

    def render(self) -> str:
        where = f"{self.location}:{self.line}" if self.line else self.location
        return f"{where}: [{self.rule}] {self.description}: {mask(self.value)}"


def mask(value: str) -> str:
    value = value.strip()
    if len(value) <= 8:
        return f"{value[:2]}*** (len={len(value)})"
    return f"{value[:4]}***{value[-2:]} (len={len(value)})"


_HOME_LOOKBEHIND = r"(?:(?<=file://)|(?<![\w.\-/~]))"

RULES: list[Rule] = [
    Rule("private-key", "개인 키 블록",
         re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")),
    Rule("aws-access-key-id", "AWS 액세스 키 ID",
         re.compile(r"(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])")),
    Rule("github-token", "GitHub 토큰",
         re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b")),
    Rule("gitlab-token", "GitLab 토큰", re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b")),
    Rule("slack-token", "Slack 토큰", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    Rule("slack-webhook", "Slack 웹훅 URL",
         re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_\-]{20,}")),
    Rule("google-api-key", "Google API 키", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    Rule("llm-api-key", "AI 서비스 API 키(sk-…)",
         re.compile(r"\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_\-]{32,}\b")),
    Rule("stripe-key", "Stripe 키", re.compile(r"\b[rs]k_live_[0-9A-Za-z]{20,}\b")),
    Rule("npm-token", "npm 토큰", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    Rule("jwt", "JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}")),
    Rule("url-credentials", "URL에 포함된 인증정보",
         re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s/:@'\"<>]+:([^\s/@'\"<>]+)@[^\s/'\"<>]+", re.I), 1),
    Rule("secret-assignment", "비밀값 할당",
         re.compile(
             r"(?i)(?<![A-Za-z0-9])(?:password|passwd|pwd|secret|client[_\-]?secret|api[_\-]?key|"
             r"access[_\-]?key|secret[_\-]?key|access[_\-]?token|auth[_\-]?token|private[_\-]?key|"
             r"bearer)(?![A-Za-z0-9])[\"']?\s*(?:[:=]|=>)\s*[\"']?([^\s\"'`,;)]{8,})"), 1),
    Rule("home-path-unix", "사용자 홈 절대 경로(/home)",
         re.compile(_HOME_LOOKBEHIND + r"/home/([^/\s\"'`<>:;,()]+)/?"), 1),
    Rule("home-path-macos", "사용자 홈 절대 경로(/Users)",
         re.compile(_HOME_LOOKBEHIND + r"/Users/([^/\s\"'`<>:;,()]+)/?"), 1),
    Rule("home-path-windows", "사용자 홈 절대 경로(C:\\Users)",
         re.compile(r"(?i)\b[a-z]:(?:\\\\|\\|/)+users(?:\\\\|\\|/)+([^\\/\s\"'`<>:;,()]+)"), 1),
    Rule("internal-host", "내부 서비스 주소",
         re.compile(r"(?i)\b[a-z][a-z0-9+.\-]*://([a-z0-9.\-]+\.(?:internal|intranet|corp|lan|local))\b"), 1),
    Rule("private-ip", "사설 IP 주소",
         re.compile(r"(?<![\w.])(10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|"
                    r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])"), 1),
    Rule("korean-rrn", "주민등록번호 형식(개인정보 검토 필요)",
         re.compile(r"(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-8]\d{6}(?!\d)")),
    Rule("phone-number", "휴대전화 번호(개인정보 검토 필요)",
         re.compile(r"(?<![\d-])01[016789]-\d{3,4}-\d{4}(?![\d-])")),
    Rule("email-address", "이메일 주소(개인정보 검토 필요)",
         re.compile(r"\b[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})\b")),
]

ALLOWED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net", "users.noreply.github.com",
                         "noreply.github.com", "anthropic.com")
ALLOWED_EMAIL_LOCALS = ("noreply", "no-reply", "git")
NON_EMAIL_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico")

SENSITIVE_FILE_PATTERNS = [
    (".env", "환경 변수 파일"), (".env.*", "환경 변수 파일"), ("*.pem", "인증서/키 파일"),
    ("*.key", "키 파일"), ("*.p12", "키 저장소"), ("*.pfx", "키 저장소"), ("*.keystore", "키 저장소"),
    ("*.jks", "키 저장소"), ("*.mobileprovision", "프로비저닝 프로필"),
    ("*.provisionprofile", "프로비저닝 프로필"), ("id_rsa", "SSH 개인 키"), ("id_dsa", "SSH 개인 키"),
    ("id_ecdsa", "SSH 개인 키"), ("id_ed25519", "SSH 개인 키"), (".netrc", "인증정보 파일"),
    ("credentials.json", "인증정보 파일"), ("*.tfvars", "인프라 변수 파일"),
]
SAFE_FILE_SUFFIXES = (".example", ".sample", ".template")


def is_placeholder_user(name: str) -> bool:
    lowered = name.lower()
    return lowered in PLACEHOLDER_USERS or lowered.startswith(("<", "{", "$", "%", "*"))


def is_placeholder_secret(value: str) -> bool:
    lowered = value.lower()
    if any(token in lowered for token in SECRET_VALUE_PLACEHOLDERS):
        return True
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+(?:\(\))?", value):
        return True  # 변수/속성 참조 (config.api_key 등)
    if re.fullmatch(r"[A-Z][A-Z0-9_]*", value):
        return True  # 환경 변수 이름
    if re.fullmatch(r"[A-Za-z_]{1,15}(?:<.*>|\[\])?", value):
        return True  # 짧은 식별자·타입 이름 (password: PasswordType)
    return len(set(value)) <= 3  # "aaaaaaaa", "********"


def finding_is_exempt(rule: Rule, match: re.Match[str]) -> bool:
    value = match.group(rule.group)
    if rule.id.startswith("home-path"):
        return is_placeholder_user(value)
    if rule.id in ("secret-assignment", "url-credentials"):
        return is_placeholder_secret(value)
    if rule.id == "email-address":
        local = match.group(0).split("@", 1)[0].lower()
        domain = value.lower()
        return (domain.endswith(ALLOWED_EMAIL_DOMAINS) or domain.endswith(NON_EMAIL_SUFFIXES)
                or local in ALLOWED_EMAIL_LOCALS or local.endswith(("noreply", "no-reply")))
    return False


class Allowlist:
    def __init__(self, entries: list[tuple[str, str]]):
        self.entries = entries

    @classmethod
    def load(cls, root: str, warnings: list[str]) -> "Allowlist":
        path = os.path.join(root, ALLOWLIST_FILE)
        entries: list[tuple[str, str]] = []
        if not os.path.isfile(path):
            return cls(entries)
        with open(path, encoding="utf-8") as handle:
            for number, raw in enumerate(handle, 1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                spec, _, reason = line.partition("--")
                parts = spec.split()
                if len(parts) != 2 or not reason.strip():
                    warnings.append(f"{ALLOWLIST_FILE}:{number}: 형식 오류 또는 사유 누락으로 무시함")
                    continue
                entries.append((parts[0], parts[1]))
        return cls(entries)

    def allows(self, rule: str, path: str) -> bool:
        return any(rule == r and fnmatch.fnmatchcase(path, g) for r, g in self.entries)


def pragma_allows(line: str, rule: str, location: str, number: int, warnings: list[str]) -> bool:
    for match in PRAGMA_RE.finditer(line):
        if match.group(1) != rule:
            continue
        reason = COMMENT_CLOSERS.sub("", match.group(2) or "").strip()
        if len(reason) < 2:
            warnings.append(f"{location}:{number}: 사유 없는 예외 주석은 무시됨")
            return False
        return True
    return False


def scan_text(text: str, location: str, allowlist: Allowlist, warnings: list[str],
              line_numbers: list[int] | None = None) -> list[Finding]:
    findings: list[Finding] = []
    for index, line in enumerate(text.splitlines()):
        number = line_numbers[index] if line_numbers else index + 1
        for rule in RULES:
            for match in rule.pattern.finditer(line):
                if finding_is_exempt(rule, match):
                    continue
                path = location.split("@", 1)[0]
                if allowlist.allows(rule.id, path) or pragma_allows(line, rule.id, location, number, warnings):
                    continue
                findings.append(Finding(rule.id, rule.description, location, number, match.group(rule.group)))
    return findings


def check_file_name(path: str, allowlist: Allowlist) -> list[Finding]:
    name = PurePosixPath(path).name
    if name.endswith(SAFE_FILE_SUFFIXES):
        return []
    for pattern, label in SENSITIVE_FILE_PATTERNS:
        if fnmatch.fnmatchcase(name, pattern) and not allowlist.allows("sensitive-file", path):
            return [Finding("sensitive-file", f"민감한 파일 형식({label})", path, 0, name)]
    return []


def decode(blob: bytes) -> str | None:
    if b"\0" in blob[:8192]:
        return None  # 바이너리
    return blob.decode("utf-8", errors="replace")


def git(root: str, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", root, *args], capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 실패: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def staged_entries(root: str) -> list[str]:
    """추가·수정된 스테이징 파일 경로. gitlink(160000)는 제외한다."""
    fields = git(root, "diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=ACM").decode().split("\0")
    paths = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        if meta.startswith(":") and meta.split()[1] != "160000":
            paths.append(path)
    return paths


def tracked_entries(root: str) -> list[str]:
    paths = []
    for line in git(root, "ls-files", "-s", "-z").decode().split("\0"):
        if line and not line.startswith("160000 "):
            paths.append(line.split("\t", 1)[1])
    return paths


def scan_blobs(root: str, paths: list[str], reader, allowlist: Allowlist, warnings: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    for path in paths:
        findings += check_file_name(path, allowlist)
        blob = reader(path)
        if blob is None:
            continue
        if len(blob) > MAX_FILE_BYTES:
            warnings.append(f"{path}: {len(blob)} bytes, 크기 제한 초과로 내용 검사를 건너뜀(Gitleaks 결과 확인 필요)")
            continue
        text = decode(blob)
        if text is not None:
            findings += scan_text(text, path, allowlist, warnings)
    return findings


def read_index(root: str):
    return lambda path: git(root, "show", f":{path}")


def read_worktree(root: str):
    def reader(path: str) -> bytes | None:
        full = os.path.join(root, path)
        if os.path.islink(full) or not os.path.isfile(full):
            return None
        with open(full, "rb") as handle:
            return handle.read()
    return reader


def scan_history(root: str, allowlist: Allowlist, warnings: list[str]) -> list[Finding]:
    """모든 ref의 커밋 패치에서 추가된 줄을 검사한다. 같은 값은 처음 나온 커밋에서 한 번만 보고한다."""
    log = git(root, "-c", "core.quotePath=false", "log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff",
              "--no-renames", "--format=%x00commit %H").decode("utf-8", errors="replace")
    findings: list[Finding] = []
    seen: set[tuple[str, str, str]] = set()
    commit = path = ""
    lines: list[str] = []
    numbers: list[int] = []
    current_line = 0

    def report(candidates: list[Finding]) -> None:
        for finding in candidates:
            key = (finding.rule, path, finding.value)
            if key not in seen:
                seen.add(key)
                findings.append(finding)

    def flush() -> None:
        if path and lines:
            report(scan_text("\n".join(lines), f"{path}@{commit[:12]}", allowlist, warnings, numbers))
        lines.clear()
        numbers.clear()

    for raw in log.split("\n"):
        if raw.startswith("\0commit "):
            flush()
            commit, path = raw.split(" ", 1)[1], ""
        elif raw.startswith("+++ "):
            flush()
            target = raw[4:]
            path = target[2:] if target.startswith("b/") else ""
            if path:
                report(check_file_name(path, allowlist))
        elif raw.startswith("@@"):
            hunk = re.search(r"\+(\d+)", raw)
            current_line = int(hunk.group(1)) if hunk else 0
        elif raw.startswith("+") and path:
            lines.append(raw[1:])
            numbers.append(current_line)
            current_line += 1
    flush()
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="공개 저장소 민감정보 검사")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="스테이징된 내용 검사(기본값)")
    mode.add_argument("--all", action="store_true", help="추적 중인 모든 파일 검사")
    mode.add_argument("--history", action="store_true", help="전체 Git 이력의 추가된 줄 검사")
    parser.add_argument("paths", nargs="*", help="검사할 파일(지정 시 해당 파일만 검사)")
    args = parser.parse_args(argv)

    try:
        root = git(os.getcwd(), "rev-parse", "--show-toplevel").decode().strip()
    except (RuntimeError, FileNotFoundError) as error:
        print(f"오류: Git 저장소를 찾을 수 없습니다: {error}", file=sys.stderr)
        return 2

    warnings: list[str] = []
    allowlist = Allowlist.load(root, warnings)
    try:
        if args.paths:
            if args.staged or args.all or args.history:
                parser.error("파일 경로와 --staged/--all/--history는 함께 쓸 수 없습니다")
            rel = [os.path.relpath(os.path.abspath(p), root).replace(os.sep, "/") for p in args.paths]
            findings = scan_blobs(root, rel, read_worktree(root), allowlist, warnings)
            scope = f"지정 파일 {len(rel)}개"
        elif args.all:
            paths = tracked_entries(root)
            findings = scan_blobs(root, paths, read_worktree(root), allowlist, warnings)
            scope = f"추적 파일 {len(paths)}개"
        elif args.history:
            findings = scan_history(root, allowlist, warnings)
            scope = "전체 Git 이력"
        else:
            paths = staged_entries(root)
            findings = scan_blobs(root, paths, read_index(root), allowlist, warnings)
            scope = f"스테이징 파일 {len(paths)}개"
    except RuntimeError as error:
        print(f"오류: {error}", file=sys.stderr)
        return 2

    for warning in warnings:
        print(f"경고: {warning}", file=sys.stderr)
    if findings:
        for finding in findings:
            print(finding.render())
        sys.stdout.flush()
        print(f"\n민감정보 의심 항목 {len(findings)}건 발견 ({scope}). 값을 제거하거나, 오탐이면 "
              "docs/development/security-policy.md의 예외 절차를 따르세요.", file=sys.stderr)
        return 1
    print(f"민감정보 검사 통과 ({scope})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
