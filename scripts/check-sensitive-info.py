#!/usr/bin/env python3
"""공개 저장소용 민감정보 검사기.

검사 대상
  --staged   (기본값) 스테이징된 파일의 인덱스 내용. 예외 목록도 인덱스 버전을 쓴다. pre-commit 훅에서 사용한다.
  --all      Git이 추적 중인 모든 파일의 작업 트리 내용. 예외 목록은 추적 중인 경우에만 작업 트리 버전을 쓴다.
  --history  모든 ref에서 도달 가능한 모든 커밋의 모든 파일 버전(병합 커밋 포함). 예외 목록은 HEAD에
             커밋된 버전을 쓴다. pre-push 훅과 CI에서 사용한다.
  PATH ...   지정한 파일만 작업 트리에서 검사한다(예외 목록 규칙은 --all과 같다).

내용 검사
  - 텍스트는 크기와 관계없이 1 MiB 단위로 스트리밍해 검사한다(긴 줄은 겹치는 구간으로 나누어 검사).
    MAX_TEXT_BYTES를 넘는 파일은 검사하지 않은 것으로 보고 실패한다.
  - ZIP 기반 문서(DOCX, HWPX 등)는 압축을 디스크에 풀지 않고 항목 수·크기 제한 안에서 텍스트 항목을
    검사하며, 작성자 등 문서 메타데이터를 보고한다. 이미지 같은 바이너리 항목은 검사하지 못한다.
  - 그 밖의 바이너리(HWP, 이미지 등)는 내용을 검사할 수 없으므로 `uninspected-binary`로 보고한다.
    직접 검토한 파일만 예외 목록에 사유와 함께 등록해 통과시킨다.

검출 결과는 파일·줄·규칙·마스킹된 값만 출력하며 비밀 원문은 출력하지 않는다.
종료 코드: 0 = 발견 없음, 1 = 발견 있음, 2 = 실행 오류·예외 목록 오류·검사하지 못한 내용 있음.

오탐 예외(검토 후에만 사용):
  - 같은 줄 주석: `sensitive-info: allow <rule-id> -- <사유>`
  - `.sensitive-info-allowlist`: `<rule-id> <경로 glob> [sha256=<해시>] -- <사유>` (한 줄에 하나).
    바이너리 등 검사하지 못한 내용의 예외는 정확한 경로와 검토한 내용의 sha256이 필요하다.
사유가 없는 예외 주석은 무시되고 경고가 출력된다. 예외 목록의 형식 오류, 알 수 없는 규칙, 지나치게 넓은
glob은 오류(종료 코드 2)다. Git submodule(gitlink) 내용은 상위 저장소 검사 대상이 아니며 업스트림
검토에서 별도로 다룬다.
"""

from __future__ import annotations

import argparse
import codecs
import fnmatch
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zlib
import zipfile
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Callable, Iterable, Iterator

CHUNK_BYTES = 1 << 20
SNIFF_BYTES = 8192
MAX_LINE_CHARS = 1 << 20  # 이보다 긴 줄은 LINE_OVERLAP만큼 겹치는 구간으로 나누어 검사한다
LINE_OVERLAP = 4096
MAX_TEXT_BYTES = 256 << 20
MAX_ARCHIVE_BYTES = 64 << 20
MAX_ARCHIVE_ENTRIES = 4096
MAX_ARCHIVE_ENTRY_BYTES = 64 << 20
MAX_ARCHIVE_TOTAL_BYTES = 256 << 20
MIN_REASON_CHARS = 4
# 바이너리 판정: 64 KiB 구간마다 잘못된 인코딩·제어 문자가 10%를 넘거나(최소 8개), 파일 전체에서 1%를 넘거나,
# UTF-8 텍스트에 NUL이 있으면 텍스트로 검사할 수 없는 내용으로 본다.
BINARY_WINDOW_BYTES = 64 << 10
BINARY_WINDOW_RATIO = 0.10
BINARY_TOTAL_RATIO = 0.01
BINARY_MIN_BAD = 8
BAD_CHARS = re.compile(r"[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]")  # 탭·줄바꿈·VT·FF·CR·ESC는 텍스트로 인정
BAD_CHARS_UTF16 = re.compile(r"[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f\ue000-\uf8ff]")  # UTF-16은 사용자 영역 문자도 센다
# 출력 직전에 이스케이프하는 문자: 제어 문자, 줄·문단 구분자, 방향 제어 등 표시되지 않는 서식 문자.
UNSAFE_OUTPUT_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]")
MAX_OUTPUT_CHARS = 400

ALLOWLIST_FILE = ".sensitive-info-allowlist"
PRAGMA_RE = re.compile(r"sensitive-info:\s*allow\s+([a-z0-9-]+)(?:\s+--\s+(.*))?")
COMMENT_CLOSERS = re.compile(r"\s*(?:-->|\*/|#\}|%>)\s*$")
GITLINK_MODE = "160000"
ZERO_OID = re.compile(r"0+")

# 문서용 자리표시자와 공용 계정 이름. 실제 사용자 홈 경로로 보지 않는다.
PLACEHOLDER_USERS = {
    "<user>", "<username>", "{user}", "{username}", "$user", "${user}", "%username%", "%user%",
    "user", "username", "you", "your-name", "yourname", "example", "runner",
    "public", "default", "default user", "all users", "shared", "guest",
}

# 비밀값 자리에 올 수 있는 명시적 자리표시자·환경 참조. 값 전체가 일치해야 한다(부분 문자열 아님).
EXPLICIT_SECRET_PLACEHOLDER = re.compile(
    r"""\$\{[A-Za-z_][A-Za-z0-9_]*\}          # ${DB_PASSWORD} (기본값 문법 ${X:-값}은 리터럴을 담으므로 제외)
      | \$\{\{[^{}]*\}\}                     # ${{secrets.TOKEN}}
      | \{\{[^{}]*\}\}                       # {{ vault_password }}
      | \$[A-Za-z_][A-Za-z0-9_]*             # $DB_PASSWORD
      | %[A-Za-z_][A-Za-z0-9_]*%             # %DB_PASSWORD%
      | \$\([^()]*\)                         # $(command)
      | <[A-Za-z0-9_.\- ]+>                  # <YOUR_API_KEY>
      | [*\u2022.xX_\-]{6,}                  # ********, xxxxxxxx
      | (?i:changeme|change[-_]me|placeholder|redacted|replace[-_]?me|your[-_][a-z0-9_\-]+)
    """, re.X)
# 따옴표 없는 코드 식: config.api_key, os.environ[, get_secret(, self->key, Settings::KEY
EXPRESSION_REFERENCE = re.compile(
    r"[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)+(?:\(\)?|\[)?"
    r"|[A-Za-z_$][\w$]*(?:\(\)?|\[)")
# 따옴표 없는 식별자·타입 이름: DB_PASSWORD, PasswordType, Option<SecretString>, Vec<u8>
IDENTIFIER_REFERENCE = re.compile(r"[A-Za-z_][\w]*(?:<[\w<>, :&\[\]]*>|\[\])?")

CODE_SUFFIXES = {
    ".py", ".pyi", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".java",
    ".kt", ".kts", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".lua", ".dart",
    ".scala", ".vue", ".svelte",
}
DOC_SUFFIXES = {".md", ".mdx", ".markdown", ".rst", ".adoc"}

# 이메일 예외는 좁게 둔다. 로컬 부분(git, noreply 등)만으로는 허용하지 않는다(사설 도메인 주소가 빠져나감).
# - 문서용 예약 도메인(RFC 2606/6761): example.com/.org/.net과 그 하위 도메인, .example/.invalid/.test 최상위 도메인
# - GitHub가 공개용으로 발급하는 noreply 주소: <ID>+<사용자>@users.noreply.github.com (정확한 도메인만)
# - 공개된 자동화 계정 주소(전체 주소 일치): SSH 원격 주소 git@github.com, GitHub 알림 noreply@github.com,
#   커밋 트레일러 Co-Authored-By의 noreply@anthropic.com
ALLOWED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net")
ALLOWED_EMAIL_EXACT_DOMAINS = ("users.noreply.github.com",)
ALLOWED_EMAIL_TLDS = ("example", "invalid", "test")
ALLOWED_EMAIL_ADDRESSES = ("git@github.com", "noreply@github.com", "noreply@anthropic.com")
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

# 문서 메타데이터(ZIP 기반 문서 내부 XML). 값이 비어 있지 않으면 검토 대상으로 보고한다.
METADATA_PATTERNS = [
    re.compile(r"<(dc:creator|cp:lastModifiedBy|dc:contributor|Company|Manager)>\s*([^<\s][^<]*)</"),
    re.compile(r"<opf:meta\b[^>]*\bname=\"(creator|lastsaveby|author)\"[^>]*>\s*([^<\s][^<]*)</opf:meta>"),
]


@dataclass(frozen=True)
class Rule:
    id: str
    description: str
    pattern: re.Pattern[str]
    groups: tuple[int | str, ...] = (0,)  # 마스킹할 값: 처음으로 일치한 그룹

    def value(self, match: re.Match[str]) -> str:
        for group in self.groups:
            if match.group(group) is not None:
                return match.group(group)
        return match.group(0)


@dataclass(frozen=True)
class Hit:
    """파일 내용에서 찾은 항목. 경로별 예외 목록은 보고 단계에서 적용한다."""
    rule: str
    description: str
    line: int
    value: str
    subpath: str = ""  # 압축 파일 내부 항목 이름


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
    """앞뒤 일부와 길이만 남긴다. 짧은 값은 글자를 전혀 보여 주지 않는다."""
    value = value.strip()
    if len(value) >= 20:
        return f"{value[:4]}***{value[-2:]} (len={len(value)})"
    if len(value) >= 12:
        return f"{value[:2]}*** (len={len(value)})"
    return f"*** (len={len(value)})"


_HOME_LOOKBEHIND = r"(?:(?<=file://)|(?<![\w.\-/~]))"
_SECRET_KEYS = (r"(?:password|passwd|pwd|secret|client[_\-]?secret|api[_\-]?key|access[_\-]?key|"
                r"secret[_\-]?key|access[_\-]?token|auth[_\-]?token|private[_\-]?key|bearer)")

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
         re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s/:@'\"<>]+:([^\s/@'\"<>]+)@[^\s/'\"<>]+", re.I), (1,)),
    # 따옴표 안 값은 공백 없는 6자 이상, 따옴표 없는 값은 8자 이상. 공백이 든 따옴표 값(문장)은 대상이 아니다.
    Rule("secret-assignment", "비밀값 할당",
         re.compile(
             r"(?i)(?<![A-Za-z0-9])" + _SECRET_KEYS + r"(?![A-Za-z0-9])[\"']?\s*(?:[:=]|=>)\s*"
             r"(?:(?P<q>[\"'`])(?P<quoted>[^\s\"'`]{6,})(?P=q)|(?P<bare>[^\s\"'`,;)]{8,}))"),
         ("quoted", "bare")),
    Rule("home-path-unix", "사용자 홈 절대 경로(/home)",
         re.compile(_HOME_LOOKBEHIND + r"(?:/var)?/home/([^/\s\"'`<>:;,()]+)/?"), (1,)),
    Rule("home-path-macos", "사용자 홈 절대 경로(/Users)",
         re.compile(r"(?:(?<=file://)|(?<![\w.\-/~])(?:/mnt/[a-z])?)/Users/([^/\s\"'`<>:;,()]+)/?"), (1,)),
    Rule("home-path-windows", "사용자 홈 절대 경로(C:\\Users)",
         re.compile(r"(?i)\b[a-z]:(?:\\\\|\\|/)+users(?:\\\\|\\|/)+([^\\/\s\"'`<>:;,()]+)"), (1,)),
    Rule("internal-host", "내부 서비스 주소",
         re.compile(r"(?i)\b[a-z][a-z0-9+.\-]*://([a-z0-9.\-]+\.(?:internal|intranet|corp|lan|local))\b"), (1,)),
    Rule("private-ip", "사설 IP 주소",
         re.compile(r"(?<![\w.])(10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|"
                    r"172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])"), (1,)),
    Rule("korean-rrn", "주민등록번호 형식(개인정보 검토 필요)",
         re.compile(r"(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-8]\d{6}(?!\d)")),
    Rule("phone-number", "휴대전화 번호(개인정보 검토 필요)",
         re.compile(r"(?<![\d-])01[016789]-\d{3,4}-\d{4}(?![\d-])")),
    Rule("email-address", "이메일 주소(개인정보 검토 필요)",
         re.compile(r"\b[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})\b"), (1,)),
]

# 내용 규칙 외에 보고 단계에서 쓰는 규칙 ID. 예외 목록에서 쓸 수 있는 ID는 RULE_IDS뿐이다.
EXTRA_RULES = {
    "sensitive-file": "민감한 파일 형식",
    "uninspected-binary": "내용을 검사하지 못한 바이너리(직접 검토 후 예외 등록 필요)",
    "uninspected-content": "크기 제한을 넘어 내용을 검사하지 못한 파일",
    "document-metadata": "문서 메타데이터(작성자 등, 개인정보 검토 필요)",
    "archive-unsafe-path": "압축 파일 내부의 위험한 경로",
}
RULE_IDS = {rule.id for rule in RULES} | set(EXTRA_RULES)
# 내용을 검사하지 못했거나 직접 검토해야 하는 규칙. 예외는 정확한 경로와 검토한 내용의 sha256에만 적용한다.
CONTENT_BOUND_RULES = {"uninspected-binary", "uninspected-content", "document-metadata", "archive-unsafe-path"}
SHA256_RE = re.compile(r"sha256=([0-9a-f]{64})")


def redact(text: str) -> str:
    """출력할 문자열에서 규칙에 걸리는 부분을 마스킹한다(경로·압축 항목 이름·오류 메시지에 든 비밀 차단).

    일치한 부분 전체를 가린다. 홈 경로만 사용자 이름 부분을 가려 `/home/<…>/` 모양을 남긴다.
    """
    for rule in RULES:
        def replace(match: re.Match[str], rule: Rule = rule) -> str:
            if finding_is_exempt(rule, match, "data"):
                return match.group(0)
            if rule.id.startswith("home-path"):
                begin, end = match.start(1) - match.start(0), match.end(1) - match.start(0)
                whole = match.group(0)
                return whole[:begin] + f"<{mask(match.group(1))}>" + whole[end:]
            return f"<{mask(match.group(0))}>"
        text = rule.pattern.sub(replace, text)
    return text


def safe(text: str) -> str:
    """모든 진단 출력의 단일 출구. 비밀을 가리고, 제어 문자를 \\uXXXX로 바꿔 가짜 줄을 만들 수 없게 한다."""
    text = UNSAFE_OUTPUT_CHARS.sub(lambda m: f"\\u{ord(m.group(0)):04x}", redact(text))
    if len(text) > MAX_OUTPUT_CHARS:
        text = text[:MAX_OUTPUT_CHARS] + f"…(+{len(text) - MAX_OUTPUT_CHARS})"
    return text


class InspectionError(Exception):
    """내용을 끝까지 검사하지 못함(읽기 실패 등). 검사 결과를 통과로 볼 수 없다."""


def file_kind(path: str) -> str:
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in CODE_SUFFIXES:
        return "code"
    if suffix in DOC_SUFFIXES:
        return "doc"
    return "data"


def is_placeholder_user(name: str) -> bool:
    lowered = name.lower()
    return lowered in PLACEHOLDER_USERS or lowered.startswith(("<", "{", "$", "%", "*"))


def is_reference_or_placeholder(value: str, quoted: bool, kind: str) -> bool:
    """명시적 자리표시자이거나, 코드에서 따옴표 없이 쓴 변수·속성·타입 참조이면 True.

    따옴표 안 리터럴은 자리표시자 문법이 아닌 한 항상 비밀 후보로 본다. 데이터 파일(YAML, TOML,
    .env, JSON 등)의 따옴표 없는 값도 리터럴이므로 참조로 보지 않는다.
    """
    if EXPLICIT_SECRET_PLACEHOLDER.fullmatch(value):
        return True
    if quoted or kind == "data":
        return False
    if EXPRESSION_REFERENCE.fullmatch(value):
        return True
    return kind == "code" and IDENTIFIER_REFERENCE.fullmatch(value) is not None


def email_is_allowed(local: str, domain: str) -> bool:
    local, domain = local.lower(), domain.lower()
    if domain.endswith(NON_EMAIL_SUFFIXES):  # logo@2x.png 같은 파일 이름
        return True
    if f"{local}@{domain}" in ALLOWED_EMAIL_ADDRESSES or domain in ALLOWED_EMAIL_EXACT_DOMAINS:
        return True
    if domain.rsplit(".", 1)[-1] in ALLOWED_EMAIL_TLDS:
        return True
    return any(domain == allowed or domain.endswith("." + allowed) for allowed in ALLOWED_EMAIL_DOMAINS)


def finding_is_exempt(rule: Rule, match: re.Match[str], kind: str) -> bool:
    value = rule.value(match)
    if rule.id.startswith("home-path"):
        return is_placeholder_user(value)
    if rule.id == "secret-assignment":
        return is_reference_or_placeholder(value, match.group("quoted") is not None, kind)
    if rule.id == "url-credentials":
        return EXPLICIT_SECRET_PLACEHOLDER.fullmatch(value) is not None
    if rule.id == "email-address":
        return email_is_allowed(match.group(0).split("@", 1)[0], value)
    return False


def valid_reason(reason: str) -> bool:
    return len(COMMENT_CLOSERS.sub("", reason).strip()) >= MIN_REASON_CHARS


@dataclass(frozen=True)
class AllowEntry:
    rule: str
    glob: str
    sha256: str | None


class Allowlist:
    def __init__(self, entries: list[AllowEntry], source: str):
        self.entries = entries
        self.source = source

    @staticmethod
    def glob_problem(glob: str) -> str | None:
        if glob.startswith("/") or re.match(r"[A-Za-z]:", glob) or "\\" in glob:
            return "저장소 상대 경로(/ 구분자)만 쓸 수 있음"
        parts = glob.split("/")
        if any(part in ("", ".", "..") for part in parts):
            return "빈 경로 요소, '.', '..'는 쓸 수 없음"
        if re.search(r"[*?\[]", parts[0]):
            return "첫 경로 요소는 와일드카드 없이 구체적이어야 함(지나치게 넓은 예외)"
        return None

    @classmethod
    def parse(cls, text: str, source: str, errors: list[str]) -> "Allowlist":
        entries: list[AllowEntry] = []
        for number, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            where = f"{ALLOWLIST_FILE}:{number} ({source})"
            usage = "`<rule-id> <경로> [sha256=<64자리 16진수>] -- <사유>`"
            spec, separator, reason = line.partition(" -- ")
            parts = spec.split()
            if not separator or not valid_reason(reason):
                errors.append(f"{where}: 사유가 없거나 너무 짧음({usage})")
                continue
            if len(parts) not in (2, 3):
                errors.append(f"{where}: 형식 오류({usage})")
                continue
            rule, glob = parts[0], parts[1]
            digest = None
            if len(parts) == 3:
                match = SHA256_RE.fullmatch(parts[2])
                if not match:
                    errors.append(f"{where}: sha256 형식 오류(소문자 16진수 64자리)")
                    continue
                digest = match.group(1)
            if rule not in RULE_IDS:
                errors.append(f"{where}: 알 수 없는 규칙 ID '{rule}'")
                continue
            problem = cls.glob_problem(glob)
            if problem:
                errors.append(f"{where}: 경로 glob '{glob}' 거부 — {problem}")
                continue
            if rule in CONTENT_BOUND_RULES and (digest is None or re.search(r"[*?\[]", glob)):
                errors.append(f"{where}: '{rule}' 예외는 와일드카드 없는 정확한 경로와 검토한 내용의 "
                              "sha256이 필요함(내용이 바뀌면 다시 검토)")
                continue
            entries.append(AllowEntry(rule, glob, digest))
        return cls(entries, source)

    def allows(self, rule: str, path: str, digest: str | None) -> bool:
        return any(rule == entry.rule and fnmatch.fnmatchcase(path, entry.glob)
                   and (entry.sha256 is None or entry.sha256 == digest) for entry in self.entries)


def pragma_allows(line: str, rule: str, where: str, warnings: list[str]) -> bool:
    for match in PRAGMA_RE.finditer(line):
        if match.group(1) not in RULE_IDS:
            warnings.append(f"{where}: 예외 주석의 규칙 ID '{match.group(1)}'를 알 수 없음")
            continue
        if match.group(1) != rule:
            continue
        if not valid_reason(match.group(2) or ""):
            warnings.append(f"{where}: 사유 없는 예외 주석은 무시됨")
            return False
        return True
    return False


# ---------------------------------------------------------------------------
# 내용 검사


@dataclass
class ScanResult:
    hits: set[Hit]
    digest: str  # 검사한 바이트 전체의 SHA-256. 내용 기반 예외(sha256=)는 이 값과 비교한다.


@dataclass
class TextStats:
    total: int = 0
    bad: int = 0  # 잘못된 인코딩(대체 문자)과 텍스트에 없어야 할 제어 문자 수
    binary_at: int | None = None  # 바이너리 증거를 처음 본 구간의 시작 바이트


def name_hits(name: str, subpath: str = "") -> set[Hit]:
    """파일·압축 항목 이름에 든 비밀·경로·개인정보. 이름 안의 예외 주석은 인정하지 않는다."""
    hits: set[Hit] = set()
    for rule in RULES:
        for match in rule.pattern.finditer(name):
            if not finding_is_exempt(rule, match, "data"):
                hits.add(Hit(rule.id, f"{rule.description}(이름)", 0, rule.value(match), subpath))
    return hits


class ContentScanner:
    """바이트 스트림을 경로별 문법으로 검사한다. 결과에는 원문 Hit가 있어 디스크에 저장하지 않는다."""

    def __init__(self, warnings: list[str]):
        self.warnings = warnings
        self.archive_seconds = 0.0

    def scan_line(self, line: str, number: int, kind: str, where: str, subpath: str, hits: set[Hit]) -> None:
        for rule in RULES:
            for match in rule.pattern.finditer(line):
                if finding_is_exempt(rule, match, kind):
                    continue
                if pragma_allows(line, rule.id, f"{where}:{number}", self.warnings):
                    continue
                hits.add(Hit(rule.id, rule.description, number, rule.value(match), subpath))
        if subpath:
            for pattern in METADATA_PATTERNS:
                for match in pattern.finditer(line):
                    hits.add(Hit("document-metadata", f"{EXTRA_RULES['document-metadata']} <{match.group(1)}>",
                                 number, match.group(2).strip(), subpath))

    def scan_text_stream(self, chunks: Iterable[bytes], encoding: str, kind: str, where: str,
                         subpath: str, hits: set[Hit], limit: int) -> TextStats:
        """텍스트로 검사하면서 바이너리 증거(NUL, 잘못된 인코딩·제어 문자 비율)를 구간별로 센다."""
        decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
        bad_chars = BAD_CHARS_UTF16 if encoding == "utf-16" else BAD_CHARS
        stats = TextStats()
        pending = ""
        number = 1
        for chunk in chunks:
            for offset in range(0, len(chunk), BINARY_WINDOW_BYTES):
                piece = chunk[offset:offset + BINARY_WINDOW_BYTES]
                stats.total += len(piece)
                if stats.total > limit:
                    raise _TooLarge(stats.total)
                text = decoder.decode(piece)
                bad = text.count("\ufffd") + len(bad_chars.findall(text))
                stats.bad += bad
                if stats.binary_at is None and (
                        (encoding != "utf-16" and b"\0" in piece)
                        or (bad >= BINARY_MIN_BAD and bad > len(piece) * BINARY_WINDOW_RATIO)):
                    stats.binary_at = stats.total - len(piece)
                pending += text
                lines = pending.split("\n")
                pending = lines.pop()
                for line in lines:
                    self.scan_line(line, number, kind, where, subpath, hits)
                    number += 1
                while len(pending) > MAX_LINE_CHARS:
                    self.scan_line(pending[:MAX_LINE_CHARS], number, kind, where, subpath, hits)
                    pending = pending[MAX_LINE_CHARS - LINE_OVERLAP:]
        tail = decoder.decode(b"", final=True)
        stats.bad += tail.count("\ufffd")
        pending += tail
        for line in pending.split("\n"):
            if line:
                self.scan_line(line, number, kind, where, subpath, hits)
            number += 1
        if (stats.binary_at is None and stats.bad >= BINARY_MIN_BAD
                and stats.bad > stats.total * BINARY_TOTAL_RATIO):
            stats.binary_at = 0
        return stats

    def scan(self, chunks: Iterator[bytes], path: str, where: str) -> ScanResult:
        """내용을 끝까지 읽어 SHA-256을 계산한다. 검사를 일찍 멈춘 경우에도 나머지를 해시에 넣는다."""
        hasher = hashlib.sha256()
        source = _hashing(chunks, hasher)
        hits: set[Hit] = set()
        self._scan(source, path, where, hits)
        for _ in source:
            pass
        return ScanResult(hits, hasher.hexdigest())

    def _scan(self, source: Iterator[bytes], path: str, where: str, hits: set[Hit]) -> None:
        head = b""
        for chunk in source:
            head += chunk
            if len(head) >= SNIFF_BYTES:
                break
        stream = _prepend(head, source)
        if head.startswith((b"PK\x03\x04", b"PK\x05\x06")):
            started = time.perf_counter()
            try:
                self.scan_archive(stream, where, hits)
            finally:
                self.archive_seconds += time.perf_counter() - started
            return
        encoding = _text_encoding(head)
        name = PurePosixPath(path).name
        if encoding is None:
            hits.add(Hit("uninspected-binary", f"{EXTRA_RULES['uninspected-binary']}: {_binary_kind(head)}", 0, name))
            return
        kind = file_kind(path)
        try:
            if encoding == "utf-16":
                # BOM만 보고 UTF-16으로 해석하면 BOM 뒤에 둔 ASCII 비밀이 깨져 보이므로 UTF-8로도 검사한다.
                # 바이너리 판정은 UTF-16 해석 결과로 한다(UTF-16 텍스트는 UTF-8로 보면 NUL이 많다).
                with tempfile.SpooledTemporaryFile(max_size=8 << 20) as spool:
                    stats = self.scan_text_stream(_tee(stream, spool), encoding, kind, where, "", hits,
                                                  MAX_TEXT_BYTES)
                    spool.seek(0)
                    self.scan_text_stream(iter(lambda: spool.read(CHUNK_BYTES), b""), "utf-8", kind, where, "",
                                          hits, MAX_TEXT_BYTES)
            else:
                stats = self.scan_text_stream(stream, encoding, kind, where, "", hits, MAX_TEXT_BYTES)
        except _TooLarge as error:
            hits.add(Hit("uninspected-content", f"{EXTRA_RULES['uninspected-content']} "
                         f"(>{MAX_TEXT_BYTES >> 20} MiB)", 0, f"{error.size} bytes"))
            return
        if not self.accept_text(stats, where):
            hits.add(Hit("uninspected-binary", f"{EXTRA_RULES['uninspected-binary']}: 텍스트로 해석할 수 없는 내용"
                         f"(약 {stats.binary_at} 바이트 이후)", 0, name))

    def accept_text(self, stats: TextStats, where: str) -> bool:
        """일반 파일·ZIP 항목·ZIP 주석이 함께 쓰는 텍스트 판정. 바이너리 증거가 있으면 False(호출자가 미검사로
        보고), 고칠 수 있는 인코딩 오류만 있으면 경고를 남기고 True."""
        if stats.binary_at is not None:
            return False
        if stats.bad:
            self.warnings.append(f"{where}: 잘못된 인코딩·제어 문자 {stats.bad}개를 대체 문자로 바꿔 검사함")
        return True

    def scan_archive(self, stream: Iterator[bytes], where: str, hits: set[Hit]) -> None:
        with tempfile.SpooledTemporaryFile(max_size=8 << 20) as spool:
            size = 0
            for chunk in stream:
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    hits.add(Hit("uninspected-binary", f"압축 파일이 검사 한도({MAX_ARCHIVE_BYTES >> 20} MiB)를 넘음",
                                 0, f"{size}+ bytes"))
                    return
                spool.write(chunk)
            spool.seek(0)
            skipped: list[str] = []
            try:
                with zipfile.ZipFile(spool) as archive:
                    self._scan_entries(archive, where, hits, skipped)
            except InspectionError:
                raise
            except Exception as error:  # noqa: BLE001 - 신뢰할 수 없는 압축 파일의 모든 해석 오류는 '미검사'로 본다
                hits.add(Hit("uninspected-binary", f"압축 파일을 끝까지 읽지 못함({type(error).__name__})", 0,
                             "archive"))
                return
            if skipped:
                hits.add(Hit("uninspected-binary", f"압축 내부 바이너리·암호화 항목 {len(skipped)}개 미검사"
                             f"(예: {', '.join(skipped[:3])})", 0, f"{len(skipped)} entries"))

    def _scan_entries(self, archive: zipfile.ZipFile, where: str, hits: set[Hit], skipped: list[str]) -> None:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            hits.add(Hit("uninspected-binary", f"압축 항목 수가 한도({MAX_ARCHIVE_ENTRIES})를 넘음", 0,
                         f"{len(entries)} entries"))
            return
        if archive.comment:  # 압축 파일 주석(최대 64 KiB)도 일반 텍스트와 같은 기준으로 검사한다
            comment_where = f"{where}!(comment)"
            stats = self.scan_text_stream(iter([archive.comment]), _text_encoding(archive.comment) or "utf-8",
                                          "data", comment_where, "(comment)", hits, MAX_ARCHIVE_ENTRY_BYTES)
            if _text_encoding(archive.comment) is None or not self.accept_text(stats, comment_where):
                skipped.append("(comment)")
        total = 0
        for info in entries:
            # 항목 이름은 신뢰할 수 없는 입력이다. 출력할 때는 safe()가 비밀을 가리고 제어 문자를 이스케이프한다.
            name = info.filename
            hits |= name_hits(name, name)
            if (name.startswith("/") or "\\" in name or re.match(r"[A-Za-z]:", name)
                    or ".." in PurePosixPath(name).parts):
                hits.add(Hit("archive-unsafe-path", EXTRA_RULES["archive-unsafe-path"], 0, name, name))
                continue
            if info.is_dir():
                continue
            if info.flag_bits & 0x1:
                skipped.append(name + "(암호화)")
                continue
            if info.file_size > MAX_ARCHIVE_ENTRY_BYTES or total + info.file_size > MAX_ARCHIVE_TOTAL_BYTES:
                skipped.append(name + "(크기 초과)")
                continue
            total += info.file_size
            with archive.open(info) as handle:
                chunks = _limited_chunks(handle, info.file_size)
                head = next(chunks, b"")
                encoding = _text_encoding(head)
                if encoding is None or head.startswith(b"PK\x03\x04"):
                    skipped.append(name)
                    continue
                entry_where = f"{where}!{name}"
                try:
                    stats = self.scan_text_stream(_prepend(head, chunks), encoding, "data", entry_where,
                                                  name, hits, info.file_size)
                except _TooLarge:
                    raise zipfile.BadZipFile("선언된 크기보다 큰 항목")
                if not self.accept_text(stats, entry_where):
                    skipped.append(name)


class _TooLarge(Exception):
    def __init__(self, size: int):
        self.size = size


def _hashing(chunks: Iterable[bytes], hasher: "hashlib._Hash") -> Iterator[bytes]:
    for chunk in chunks:
        hasher.update(chunk)
        yield chunk


def _limited_chunks(handle: io.BufferedIOBase, declared: int) -> Iterator[bytes]:
    """선언된 크기만큼만 읽는다. 실제 내용이 더 크면(압축 폭탄 등) 오류로 처리한다."""
    remaining = declared
    while True:
        chunk = handle.read(min(CHUNK_BYTES, remaining + 1) if remaining >= 0 else CHUNK_BYTES)
        if not chunk:
            return
        remaining -= len(chunk)
        if remaining < 0:
            raise zipfile.BadZipFile("선언된 크기보다 큰 항목")
        yield chunk


def _tee(chunks: Iterable[bytes], sink: io.IOBase) -> Iterator[bytes]:
    for chunk in chunks:
        sink.write(chunk)
        yield chunk


def _prepend(head: bytes, rest: Iterator[bytes]) -> Iterator[bytes]:
    if head:
        yield head
    yield from rest


# 알려진 바이너리 형식의 시작 바이트. NUL이 없거나 앞부분이 ASCII여도(HWP 3.0, PDF 등) 바이너리로 본다.
BINARY_SIGNATURES: list[tuple[bytes, str]] = [
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "OLE 복합 문서(HWP 5.0 등)"),
    (b"HWP Document File", "HWP 3.0 문서"),
    (b"\x89PNG\r\n\x1a\n", "PNG 이미지"),
    (b"\xff\xd8\xff", "JPEG 이미지"),
    (b"GIF87a", "GIF 이미지"),
    (b"GIF89a", "GIF 이미지"),
    (b"%PDF-", "PDF 문서"),
    (b"\x7fELF", "ELF 실행 파일"),
    (b"\x1f\x8b", "gzip 압축"),
    (b"\xfd7zXZ\x00", "xz 압축"),
    (b"\x28\xb5\x2f\xfd", "zstd 압축"),
    (b"7z\xbc\xaf\x27\x1c", "7z 압축"),
    (b"Rar!\x1a\x07", "RAR 압축"),
    (b"wOFF", "WOFF 글꼴"),
    (b"wOF2", "WOFF2 글꼴"),
    (b"OTTO", "OpenType 글꼴"),
    (b"icns", "ICNS 아이콘"),
    (b"\xca\xfe\xba\xbe", "Java 클래스/Mach-O"),
    (b"\xcf\xfa\xed\xfe", "Mach-O 실행 파일"),
]


def _binary_signature(head: bytes) -> str | None:
    for signature, label in BINARY_SIGNATURES:
        if head.startswith(signature):
            return label
    if head[:4] == b"RIFF" and head[8:12] in (b"WEBP", b"WAVE", b"AVI "):
        return "RIFF 미디어"
    if re.match(rb"BZh[1-9]1AY&SY", head):
        return "bzip2 압축"
    return None


def _text_encoding(head: bytes) -> str | None:
    """지원하는 텍스트 인코딩: UTF-8, UTF-8 BOM, BOM이 있는 UTF-16.

    알려진 바이너리 형식이거나 첫 구간에 NUL이 있으면 None(바이너리). 나머지 바이너리 증거는
    scan_text_stream()이 내용 전체에서 찾는다.
    """
    if _binary_signature(head):
        return None
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if head.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    if b"\0" in head[:SNIFF_BYTES]:
        return None
    return "utf-8"


def _binary_kind(head: bytes) -> str:
    return _binary_signature(head) or "바이너리"


# ---------------------------------------------------------------------------
# Git과 파일 읽기


def git(root: str, *args: str) -> bytes:
    result = subprocess.run(["git", "-C", root, *args], capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 실패: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


class BlobReader:
    """`git cat-file --batch`로 blob을 스트리밍한다. 반환된 iterator를 다 쓰지 않아도 다음 호출 전에 비운다."""

    def __init__(self, root: str):
        self.process = subprocess.Popen(["git", "-C", root, "cat-file", "--batch"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE)
        self._remaining = -1  # -1: 읽을 blob 없음, 0 이상: 현재 blob에서 남은 바이트(뒤 줄바꿈 제외)

    def _drain(self) -> None:
        assert self.process.stdout is not None
        while self._remaining > 0:
            chunk = self.process.stdout.read(min(CHUNK_BYTES, self._remaining))
            if not chunk:
                raise InspectionError("git cat-file 출력이 예상보다 일찍 끝남")
            self._remaining -= len(chunk)
        if self._remaining == 0:
            self.process.stdout.read(1)  # 내용 뒤의 줄바꿈
            self._remaining = -1

    def open(self, oid: str) -> Iterator[bytes]:
        assert self.process.stdin is not None and self.process.stdout is not None
        if self._remaining >= 0:
            self._drain()
        self.process.stdin.write(oid.encode() + b"\n")
        self.process.stdin.flush()
        header = self.process.stdout.readline().decode(errors="replace").split()
        if len(header) != 3 or header[1] != "blob":
            raise InspectionError(f"blob {oid[:12]}을 읽지 못함: {' '.join(header[1:]) or '응답 없음'}")
        self._remaining = int(header[2])
        return self._chunks()

    def _chunks(self) -> Iterator[bytes]:
        assert self.process.stdout is not None
        while self._remaining > 0:
            chunk = self.process.stdout.read(min(CHUNK_BYTES, self._remaining))
            if not chunk:
                raise InspectionError("git cat-file 출력이 예상보다 일찍 끝남")
            self._remaining -= len(chunk)
            yield chunk

    def read_all(self, oid: str) -> bytes:
        return b"".join(self.open(oid))

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        if self.process.stdout:
            self.process.stdout.close()
        self.process.wait()


def worktree_chunks(root: str, path: str) -> Iterator[bytes] | None:
    full = os.path.join(root, path)
    try:
        if os.path.islink(full):
            return iter([os.fsencode(os.readlink(full))])
        if not os.path.exists(full):
            return None
        if not os.path.isfile(full):
            raise InspectionError(f"{path}: 일반 파일이 아님")
        handle = open(full, "rb")
    except OSError as error:
        raise InspectionError(f"{path}: 읽을 수 없음 ({error.strerror})") from error

    def generate() -> Iterator[bytes]:
        with handle:
            while True:
                try:
                    chunk = handle.read(CHUNK_BYTES)
                except OSError as error:
                    raise InspectionError(f"{path}: 읽기 실패 ({error.strerror})") from error
                if not chunk:
                    return
                yield chunk
    return generate()


@dataclass
class StagedEntry:
    path: str
    mode: str
    oid: str


def staged_entries(root: str) -> list[StagedEntry]:
    """삭제를 제외한 스테이징 항목(형식 변경 포함). gitlink(160000)는 제외한다."""
    fields = git(root, "diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev",
                 "--diff-filter=d").decode("utf-8", errors="surrogateescape").split("\0")
    entries = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        if not meta.startswith(":"):
            continue
        _, new_mode, _, new_oid, status = meta[1:].split()
        if status == "U" or ZERO_OID.fullmatch(new_oid):
            raise RuntimeError(f"{path}: 병합 충돌이 해결되지 않아 인덱스 내용을 검사할 수 없음")
        if new_mode != GITLINK_MODE:
            entries.append(StagedEntry(path, new_mode, new_oid))
    return entries


def tracked_entries(root: str) -> list[str]:
    paths = []
    for line in git(root, "ls-files", "-s", "-z").decode("utf-8", errors="surrogateescape").split("\0"):
        if line and not line.startswith(GITLINK_MODE + " "):
            path = line.split("\t", 1)[1]
            if not paths or paths[-1] != path:  # 충돌 중에는 같은 경로가 여러 단계로 나온다
                paths.append(path)
    return paths


def index_oid(root: str, path: str) -> str | None:
    out = git(root, "ls-files", "-s", "-z", "--", path).decode().split("\0")[0]
    return out.split()[1] if out else None


def load_allowlist(root: str, mode: str, reader: BlobReader, errors: list[str], warnings: list[str]) -> Allowlist:
    """검사 대상과 같은 스냅샷의 예외 목록을 읽는다."""
    full = os.path.join(root, ALLOWLIST_FILE)
    staged_oid = index_oid(root, ALLOWLIST_FILE)
    if mode == "staged":
        if staged_oid is None:
            if os.path.exists(full):
                warnings.append(f"{ALLOWLIST_FILE}: 스테이징되지 않은 예외 목록은 --staged 검사에 쓰지 않음")
            return Allowlist([], "인덱스")
        text = reader.read_all(staged_oid).decode("utf-8", errors="replace")
        if os.path.isfile(full) and not os.path.islink(full):
            with open(full, "rb") as handle:
                if handle.read().decode("utf-8", errors="replace") != text:
                    warnings.append(f"{ALLOWLIST_FILE}: 작업 트리 변경은 반영하지 않음(스테이징된 버전 사용)")
        return Allowlist.parse(text, "인덱스", errors)
    if mode == "history":
        try:
            oid = git(root, "rev-parse", "--verify", "-q", f"HEAD:{ALLOWLIST_FILE}").decode().strip()
        except RuntimeError:
            return Allowlist([], "HEAD")
        return Allowlist.parse(reader.read_all(oid).decode("utf-8", errors="replace"), "HEAD", errors)
    # 작업 트리 기준(--all, 경로 지정): 추적 중인 예외 목록만 인정한다.
    if staged_oid is None:
        if os.path.exists(full):
            warnings.append(f"{ALLOWLIST_FILE}: Git이 추적하지 않는 예외 목록은 무시함")
        return Allowlist([], "작업 트리")
    if not os.path.isfile(full) or os.path.islink(full):
        return Allowlist([], "작업 트리")
    with open(full, "rb") as handle:
        return Allowlist.parse(handle.read().decode("utf-8", errors="replace"), "작업 트리", errors)


# ---------------------------------------------------------------------------
# 보고


@dataclass
class Report:
    allowlist: Allowlist
    findings: list[Finding] = field(default_factory=list)
    seen: set[tuple[str, str, str]] = field(default_factory=set)

    def add(self, path: str, location: str, hits: Iterable[Hit], digest: str | None = None) -> None:
        """digest는 이 경로에서 검사한 내용의 SHA-256(인덱스·작업 트리·이력 중 실제로 읽은 바이트)."""
        for hit in sorted(hits, key=lambda h: (h.subpath, h.line, h.rule, h.value)):
            if self.allowlist.allows(hit.rule, path, digest):
                continue
            key = (hit.rule, path + "!" + hit.subpath, hit.value)
            if key in self.seen:
                continue
            self.seen.add(key)
            where = f"{location}!{hit.subpath}" if hit.subpath else location
            self.findings.append(Finding(hit.rule, hit.description, where, hit.line, hit.value))

    def check_name(self, path: str, location: str) -> None:
        self.add(path, location, name_hits(path))
        name = PurePosixPath(path).name
        if name.endswith(SAFE_FILE_SUFFIXES):
            return
        for pattern, label in SENSITIVE_FILE_PATTERNS:
            if fnmatch.fnmatchcase(name, pattern):
                self.add(path, location, [Hit("sensitive-file", f"민감한 파일 형식({label})", 0, name)])
                return


# Only successful, warning-free content verdicts are reusable. No hits or raw
# paths are persisted; path/name checks still run on every history traversal.
HISTORY_CACHE_MAX_ENTRIES = 100_000
HISTORY_CACHE_MAX_BYTES = 8 << 20


class HistoryPassCache:
    """Local trusted-user optimization; malformed/unavailable caches mean a full scan.

    Hold a nonblocking advisory lock through publication. Contending processes
    scan normally without reading/writing the cache. Atomic replace ensures an
    interruption leaves either the previous complete generation or none.
    """

    def __init__(self, root: str, allowlist: Allowlist, enabled: bool):
        self.entries: set[str] = set()
        self.lock = None
        self.directory = ""
        self.identity = ""
        self.state = "disabled"
        if not enabled or os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
            return
        try:
            import fcntl
            import stat
            common = os.path.realpath(git(root, "rev-parse", "--path-format=absolute",
                                          "--git-common-dir").decode().strip())
            replacement_base = os.environ.get("GIT_REPLACE_REF_BASE", "refs/replace/")
            replacements = git(root, "for-each-ref", "--format=%(refname) %(objectname)", replacement_base)
            with open(__file__, "rb") as source:
                implementation = hashlib.sha256(source.read()).hexdigest()
            context = ["history-pass-v1", common, implementation, sys.version, sys.platform,
                       sys.byteorder, sys.flags.optimize, sys.getfilesystemencoding(),
                       zlib.ZLIB_RUNTIME_VERSION, git(root, "--version").hex(),
                       hashlib.sha256(git(root, "config", "--null", "--list")).hexdigest(),
                       os.environ.get("GIT_NO_REPLACE_OBJECTS"), replacement_base,
                       replacements.hex(),
                       [(e.rule, e.glob, e.sha256) for e in allowlist.entries]]
            self.identity = hashlib.sha256(json.dumps(context, ensure_ascii=True).encode()).hexdigest()
            self.directory = os.path.join(common, "geul-security-history-cache")
            os.makedirs(self.directory, mode=0o700, exist_ok=True)
            info = os.lstat(self.directory)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise OSError("unsafe cache directory")
            fd = os.open(os.path.join(self.directory, "lock"),
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            self.lock = os.fdopen(fd, "a+")
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise OSError("unsafe cache lock")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.state = "cold"
            # The lock excludes live writers; remove leftovers from interrupted
            # atomic publications to keep disk use bounded as well as entries.
            for name in os.listdir(self.directory):
                if name.startswith(".pending-"):
                    pending = os.path.join(self.directory, name)
                    info = os.lstat(pending)
                    if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid():
                        os.unlink(pending)
            path = os.path.join(self.directory, "cache.json")
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                            or info.st_mode & 0o077 or info.st_size > HISTORY_CACHE_MAX_BYTES):
                        raise ValueError("unsafe cache file")
                    data = json.loads(handle.read(HISTORY_CACHE_MAX_BYTES + 1))
                if not isinstance(data, dict) or set(data) != {"identity", "entries", "checksum"}:
                    raise ValueError("invalid cache structure")
                entries = data["entries"]
                if (not isinstance(entries, list) or len(entries) > HISTORY_CACHE_MAX_ENTRIES
                        or any(not isinstance(e, str) or not re.fullmatch(r"[0-9a-f]{64}", e) for e in entries)
                        or len(set(entries)) != len(entries)
                        or data["checksum"] != self.checksum(data["identity"], entries)):
                    raise ValueError("invalid cache checksum or entries")
                if data["identity"] == self.identity:
                    self.entries = set(entries)
                    self.state = "valid"
                else:
                    self.state = "invalidated"
            except FileNotFoundError:
                pass
            except (OSError, ValueError, TypeError, RecursionError):
                self.state = "invalid"
        except (ImportError, OSError, RuntimeError, ValueError):
            self.close()
            self.state = "unavailable"

    @staticmethod
    def checksum(identity: str, entries: list[str]) -> str:
        return hashlib.sha256(json.dumps([identity, entries], ensure_ascii=True,
                                         separators=(",", ":")).encode()).hexdigest()

    @staticmethod
    def key(oid: str, path: str) -> str:
        return hashlib.sha256((oid + "\0" + path).encode("utf-8", errors="surrogateescape")).hexdigest()

    def publish(self, entries: list[str]) -> None:
        if self.lock is None:
            return
        # Keep only entries encountered in the current all-ref traversal; retain
        # recent entries if the bound is exceeded. Eviction only costs rescans.
        entries = entries[-HISTORY_CACHE_MAX_ENTRIES:]
        data = {"identity": self.identity, "entries": entries,
                "checksum": self.checksum(self.identity, entries)}
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.directory,
                                             prefix=".pending-", delete=False) as handle:
                temporary = handle.name
                json.dump(data, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, os.path.join(self.directory, "cache.json"))
            temporary = None
        except OSError:
            self.state = "write-unavailable"
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass

    def close(self) -> None:
        if self.lock is not None:
            self.lock.close()
            self.lock = None


def scan_history(root: str, reader: BlobReader, scanner: ContentScanner, report: Report,
                 errors: list[str], use_cache: bool = True) -> int:
    """Enumerate every ref on every invocation; reuse only verified (blob, path) verdicts.

    The original first-parent raw traversal includes root and merge changes.
    Its coverage and path-dependent detection semantics remain unchanged.
    """
    started = time.perf_counter()
    log = git(root, "-c", "log.showSignature=false", "log", "--all", "--reverse", "--topo-order", "--root",
              "--raw", "-z", "--no-renames", "--no-abbrev", "--no-color", "--diff-merges=first-parent",
              "--format=%x01%H")
    enumeration_seconds = time.perf_counter() - started
    tokens = log.decode("utf-8", errors="surrogateescape").split("\0")
    entries: list[tuple[str, str, str]] = []
    commit = ""
    index = 0
    while index < len(tokens):
        token = tokens[index].lstrip("\n")
        index += 1
        if token.startswith("\x01"):
            commit = token[1:].strip()
        elif token.startswith(":"):
            path = tokens[index]
            index += 1
            _, new_mode, _, new_oid, status = token[1:].split()
            if status != "D" and new_mode != GITLINK_MODE:
                entries.append((new_oid, path, f"{path}@{commit[:12]}"))
    cache: dict[tuple[str, str], ScanResult | None] = {}
    persistent = HistoryPassCache(root, report.allowlist, use_cache)
    verified: list[str] = []
    scanned = reused = 0
    scan_seconds = 0.0
    try:
        # Cached content still requires a present blob. Check headers in one
        # batch without reading large contents (missing objects must fail closed).
        candidates = {oid for oid, path, _ in entries
                      if persistent.key(oid, path) in persistent.entries}
        available: set[str] = set()
        if candidates:
            metadata = subprocess.run(["git", "-C", root, "cat-file",
                                       "--batch-check=%(objectname) %(objecttype)"],
                                      input="".join(oid + "\n" for oid in sorted(candidates)).encode(),
                                      capture_output=True)
            if metadata.returncode == 0:
                available = {line.split()[0] for line in metadata.stdout.decode().splitlines()
                             if len(line.split()) == 2 and line.split()[1] == "blob"}
        for new_oid, path, location in entries:
            report.check_name(path, location)
            key = (new_oid, path)
            if key not in cache:
                pass_key = persistent.key(new_oid, path)
                if pass_key in persistent.entries and new_oid in available:
                    reused += 1
                    verified.append(pass_key)
                    cache[key] = None
                else:
                    scanned += 1
                    before_warnings = len(scanner.warnings)
                    scan_start = time.perf_counter()
                    try:
                        result = scanner.scan(reader.open(new_oid), path, location)
                        cache[key] = result
                        if (len(scanner.warnings) == before_warnings
                                and all(report.allowlist.allows(h.rule, path, result.digest) for h in result.hits)):
                            verified.append(pass_key)
                    except InspectionError as error:
                        errors.append(f"{location}: {error}")
                        cache[key] = None
                    finally:
                        scan_seconds += time.perf_counter() - scan_start
            result = cache[key]
            if result:
                report.add(path, location, result.hits, result.digest)
        # No new generation can certify failed or interrupted invocations.
        if not errors and not report.findings:
            persistent.publish(verified)
        print("history-cache: " + json.dumps({
            "state": persistent.state, "pairs": len(cache), "scanned": scanned, "reused": reused,
            "enumeration_seconds": round(enumeration_seconds, 6),
            "content_seconds": round(scan_seconds, 6),
            "archive_seconds": round(scanner.archive_seconds, 6),
        }), file=sys.stderr)
        return len(cache)
    finally:
        persistent.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="공개 저장소 민감정보 검사")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="스테이징된 내용 검사(기본값)")
    mode.add_argument("--all", action="store_true", help="추적 중인 모든 파일 검사")
    mode.add_argument("--history", action="store_true", help="모든 ref의 전체 Git 이력 검사")
    parser.add_argument("--no-history-cache", action="store_true",
                        help="이력 검사 결과 캐시를 읽거나 쓰지 않음(CI는 항상 비활성화)")
    parser.add_argument("paths", nargs="*", help="검사할 파일(지정 시 해당 파일만 검사)")
    args = parser.parse_args(argv)
    if args.paths and (args.staged or args.all or args.history):
        parser.error("파일 경로와 --staged/--all/--history는 함께 쓸 수 없습니다")

    try:
        root = git(os.getcwd(), "rev-parse", "--show-toplevel").decode().strip()
    except (RuntimeError, FileNotFoundError) as error:
        print(safe(f"오류: Git 저장소를 찾을 수 없습니다: {error}"), file=sys.stderr)
        return 2

    selected = "paths" if args.paths else "all" if args.all else "history" if args.history else "staged"
    warnings: list[str] = []
    errors: list[str] = []
    scanner = ContentScanner(warnings)
    reader = BlobReader(root)
    report = Report(Allowlist([], ""))
    scope = "중단됨"
    try:
        report.allowlist = load_allowlist(root, selected, reader, errors, warnings)
        if selected == "history":
            blobs = scan_history(root, reader, scanner, report, errors, not args.no_history_cache)
            scope = f"전체 Git 이력, 검사한 (파일 버전, 경로) {blobs}개"
        elif selected == "staged":
            entries = staged_entries(root)
            for entry in entries:
                report.check_name(entry.path, entry.path)
                try:
                    result = scanner.scan(reader.open(entry.oid), entry.path, entry.path)
                    report.add(entry.path, entry.path, result.hits, result.digest)
                except InspectionError as error:
                    errors.append(f"{entry.path}: {error}")
            scope = f"스테이징 파일 {len(entries)}개"
        else:
            if selected == "all":
                paths = tracked_entries(root)
                scope = f"추적 파일 {len(paths)}개"
            else:
                paths = [os.path.relpath(os.path.abspath(p), root).replace(os.sep, "/") for p in args.paths]
                scope = f"지정 파일 {len(paths)}개"
            for path in paths:
                report.check_name(path, path)
                try:
                    chunks = worktree_chunks(root, path)
                    if chunks is None:
                        if selected == "paths":
                            raise InspectionError("파일이 없음")
                        # 인덱스에는 있지만 작업 트리에 없음(스테이징하지 않은 삭제 등). 스테이징한 삭제는
                        # 추적 목록에서 이미 빠지므로 여기에 오지 않는다.
                        raise InspectionError("추적 중인 파일이 작업 트리에 없음 — 삭제했다면 `git rm`으로 "
                                              "스테이징하고, 아니면 복원한 뒤 다시 검사하세요")
                    result = scanner.scan(chunks, path, path)
                    report.add(path, path, result.hits, result.digest)
                except InspectionError as error:
                    errors.append(f"{path}: {error}")
    except (RuntimeError, InspectionError) as error:
        errors.append(str(error))
    finally:
        reader.close()

    for warning in warnings:
        print(safe(f"경고: {warning}"), file=sys.stderr)
    for finding in report.findings:
        print(safe(finding.render()))
    sys.stdout.flush()
    if errors:
        for error in errors:
            print(safe(f"오류: {error}"), file=sys.stderr)
        print(f"\n검사를 완료하지 못했습니다 ({scope}). 검사하지 못한 내용이 있으므로 통과로 보지 않습니다.",
              file=sys.stderr)
        return 2
    if report.findings:
        print(f"\n민감정보 의심 항목 {len(report.findings)}건 발견 ({scope}). 값을 제거하거나, 오탐이면 "
              "docs/development/security-policy.md의 예외 절차를 따르세요.", file=sys.stderr)
        return 1
    print(f"민감정보 검사 통과 ({scope})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
