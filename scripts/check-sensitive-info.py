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
  - `.sensitive-info-allowlist`: `<rule-id> <경로 glob> -- <사유>` (한 줄에 하나)
사유가 없는 예외 주석은 무시되고 경고가 출력된다. 예외 목록의 형식 오류, 알 수 없는 규칙, 지나치게 넓은
glob은 오류(종료 코드 2)다. Git submodule(gitlink) 내용은 상위 저장소 검사 대상이 아니며 업스트림
검토에서 별도로 다룬다.
"""

from __future__ import annotations

import argparse
import codecs
import fnmatch
import io
import os
import re
import subprocess
import sys
import tempfile
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

ALLOWED_EMAIL_DOMAINS = ("example.com", "example.org", "example.net", "users.noreply.github.com")
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
    if local in ALLOWED_EMAIL_LOCALS or domain.endswith(NON_EMAIL_SUFFIXES):
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


class Allowlist:
    def __init__(self, entries: list[tuple[str, str]], source: str):
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
        entries: list[tuple[str, str]] = []
        for number, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            where = f"{ALLOWLIST_FILE}:{number} ({source})"
            spec, separator, reason = line.partition(" -- ")
            parts = spec.split()
            if not separator or not valid_reason(reason):
                errors.append(f"{where}: 사유가 없거나 너무 짧음(`<rule-id> <glob> -- <사유>`)")
                continue
            if len(parts) != 2:
                errors.append(f"{where}: 형식 오류(`<rule-id> <glob> -- <사유>`)")
                continue
            rule, glob = parts
            if rule not in RULE_IDS:
                errors.append(f"{where}: 알 수 없는 규칙 ID '{rule}'")
                continue
            problem = cls.glob_problem(glob)
            if problem:
                errors.append(f"{where}: 경로 glob '{glob}' 거부 — {problem}")
                continue
            entries.append((rule, glob))
        return cls(entries, source)

    def allows(self, rule: str, path: str) -> bool:
        return any(rule == r and fnmatch.fnmatchcase(path, g) for r, g in self.entries)


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


class ContentScanner:
    """바이트 스트림 하나를 검사해 Hit 목록을 만든다. 경로와 무관한 결과라 blob 단위로 재사용한다."""

    def __init__(self, warnings: list[str]):
        self.warnings = warnings

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
                         subpath: str, hits: set[Hit], limit: int) -> None:
        decoder = codecs.getincrementaldecoder(encoding)(errors="replace")
        pending = ""
        number = 1
        total = 0
        for chunk in chunks:
            total += len(chunk)
            if total > limit:
                raise _TooLarge(total)
            pending += decoder.decode(chunk)
            lines = pending.split("\n")
            pending = lines.pop()
            for line in lines:
                self.scan_line(line, number, kind, where, subpath, hits)
                number += 1
            while len(pending) > MAX_LINE_CHARS:
                self.scan_line(pending[:MAX_LINE_CHARS], number, kind, where, subpath, hits)
                pending = pending[MAX_LINE_CHARS - LINE_OVERLAP:]
        pending += decoder.decode(b"", final=True)
        for line in pending.split("\n"):
            if line:
                self.scan_line(line, number, kind, where, subpath, hits)
            number += 1

    def scan(self, chunks: Iterator[bytes], path: str, where: str) -> set[Hit]:
        """chunks는 끝까지 소비하지 않아도 된다(호출자가 남은 내용을 처리한다)."""
        hits: set[Hit] = set()
        head = b""
        for chunk in chunks:
            head += chunk
            if len(head) >= SNIFF_BYTES:
                break
        stream = _prepend(head, chunks)
        if head.startswith((b"PK\x03\x04", b"PK\x05\x06")):
            self.scan_archive(stream, where, hits)
            return hits
        encoding = _text_encoding(head)
        if encoding is None:
            hits.add(Hit("uninspected-binary", f"{EXTRA_RULES['uninspected-binary']}: {_binary_kind(head)}", 0,
                         PurePosixPath(path).name))
            return hits
        try:
            if encoding == "utf-16":
                # BOM만 보고 UTF-16으로 해석하면 BOM 뒤에 둔 ASCII 비밀이 깨져 보이므로 UTF-8로도 검사한다.
                with tempfile.SpooledTemporaryFile(max_size=8 << 20) as spool:
                    self.scan_text_stream(_tee(stream, spool), encoding, file_kind(path), where, "", hits,
                                          MAX_TEXT_BYTES)
                    spool.seek(0)
                    self.scan_text_stream(iter(lambda: spool.read(CHUNK_BYTES), b""), "utf-8", file_kind(path),
                                          where, "", hits, MAX_TEXT_BYTES)
            else:
                self.scan_text_stream(stream, encoding, file_kind(path), where, "", hits, MAX_TEXT_BYTES)
        except _TooLarge as error:
            hits.add(Hit("uninspected-content", f"{EXTRA_RULES['uninspected-content']} "
                         f"(>{MAX_TEXT_BYTES >> 20} MiB)", 0, f"{error.size} bytes"))
        return hits

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
                             f"(예: {', '.join(skipped[:3])})", 0, skipped[0]))

    def _scan_entries(self, archive: zipfile.ZipFile, where: str, hits: set[Hit], skipped: list[str]) -> None:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            hits.add(Hit("uninspected-binary", f"압축 항목 수가 한도({MAX_ARCHIVE_ENTRIES})를 넘음", 0,
                         f"{len(entries)} entries"))
            return
        if archive.comment:  # 압축 파일 주석(최대 64 KiB)도 텍스트로 검사한다
            self.scan_text_stream(iter([archive.comment]), "utf-8", "data", f"{where}!(comment)", "(comment)",
                                  hits, MAX_ARCHIVE_ENTRY_BYTES)
        total = 0
        for info in entries:
            name = info.filename
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
                try:
                    self.scan_text_stream(_prepend(head, chunks), encoding, "data", f"{where}!{name}", name,
                                          hits, info.file_size)
                except _TooLarge:
                    raise zipfile.BadZipFile("선언된 크기보다 큰 항목")


class _TooLarge(Exception):
    def __init__(self, size: int):
        self.size = size


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


def _text_encoding(head: bytes) -> str | None:
    if head.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    if head.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    if b"\0" in head[:SNIFF_BYTES]:
        return None
    return "utf-8"


def _binary_kind(head: bytes) -> str:
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return "OLE 복합 문서(HWP 등)"
    if head.startswith(b"\x89PNG"):
        return "PNG 이미지"
    return "바이너리"


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

    def add(self, path: str, location: str, hits: Iterable[Hit]) -> None:
        for hit in sorted(hits, key=lambda h: (h.subpath, h.line, h.rule, h.value)):
            if self.allowlist.allows(hit.rule, path):
                continue
            key = (hit.rule, path + "!" + hit.subpath, hit.value)
            if key in self.seen:
                continue
            self.seen.add(key)
            where = f"{location}!{hit.subpath}" if hit.subpath else location
            self.findings.append(Finding(hit.rule, hit.description, where, hit.line, hit.value))

    def check_name(self, path: str, location: str) -> None:
        name = PurePosixPath(path).name
        if name.endswith(SAFE_FILE_SUFFIXES):
            return
        for pattern, label in SENSITIVE_FILE_PATTERNS:
            if fnmatch.fnmatchcase(name, pattern):
                self.add(path, location, [Hit("sensitive-file", f"민감한 파일 형식({label})", 0, name)])
                return


def scan_history(root: str, reader: BlobReader, scanner: ContentScanner, report: Report,
                 errors: list[str]) -> int:
    """모든 ref에서 도달 가능한 (경로, blob) 쌍을 검사한다.

    각 커밋을 첫 번째 부모와 비교한 변경(루트 커밋은 빈 트리와 비교)을 모으면 도달 가능한 모든 트리의
    모든 (경로, blob) 쌍이 빠짐없이 나온다. 병합 커밋에서 새로 생긴 내용도 포함된다.
    """
    log = git(root, "-c", "log.showSignature=false", "log", "--all", "--reverse", "--topo-order", "--root",
              "--raw", "-z", "--no-renames", "--no-abbrev", "--no-color", "--diff-merges=first-parent",
              "--format=%x01%H")
    tokens = log.decode("utf-8", errors="surrogateescape").split("\0")
    cache: dict[str, set[Hit] | None] = {}
    commit = ""
    blobs = 0
    index = 0
    while index < len(tokens):
        token = tokens[index].lstrip("\n")
        index += 1
        if token.startswith("\x01"):
            commit = token[1:].strip()
            continue
        if not token.startswith(":"):
            continue
        path = tokens[index]
        index += 1
        _, new_mode, _, new_oid, status = token[1:].split()
        if status == "D" or new_mode == GITLINK_MODE:
            continue
        location = f"{path}@{commit[:12]}"
        report.check_name(path, location)
        if new_oid not in cache:
            blobs += 1
            try:
                cache[new_oid] = scanner.scan(reader.open(new_oid), path, location)
            except InspectionError as error:
                errors.append(f"{location}: {error}")
                cache[new_oid] = None
        hits = cache[new_oid]
        if hits:
            report.add(path, location, hits)
    return blobs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="공개 저장소 민감정보 검사")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="스테이징된 내용 검사(기본값)")
    mode.add_argument("--all", action="store_true", help="추적 중인 모든 파일 검사")
    mode.add_argument("--history", action="store_true", help="모든 ref의 전체 Git 이력 검사")
    parser.add_argument("paths", nargs="*", help="검사할 파일(지정 시 해당 파일만 검사)")
    args = parser.parse_args(argv)
    if args.paths and (args.staged or args.all or args.history):
        parser.error("파일 경로와 --staged/--all/--history는 함께 쓸 수 없습니다")

    try:
        root = git(os.getcwd(), "rev-parse", "--show-toplevel").decode().strip()
    except (RuntimeError, FileNotFoundError) as error:
        print(f"오류: Git 저장소를 찾을 수 없습니다: {error}", file=sys.stderr)
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
            blobs = scan_history(root, reader, scanner, report, errors)
            scope = f"전체 Git 이력, 고유 파일 버전 {blobs}개"
        elif selected == "staged":
            entries = staged_entries(root)
            for entry in entries:
                report.check_name(entry.path, entry.path)
                try:
                    report.add(entry.path, entry.path, scanner.scan(reader.open(entry.oid), entry.path, entry.path))
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
                        warnings.append(f"{path}: 작업 트리에 없어 내용 검사를 건너뜀(이력 검사 대상)")
                        continue
                    report.add(path, path, scanner.scan(chunks, path, path))
                except InspectionError as error:
                    errors.append(f"{path}: {error}")
    except (RuntimeError, InspectionError) as error:
        errors.append(str(error))
    finally:
        reader.close()

    for warning in warnings:
        print(f"경고: {warning}", file=sys.stderr)
    for finding in report.findings:
        print(finding.render())
    sys.stdout.flush()
    if errors:
        for error in errors:
            print(f"오류: {error}", file=sys.stderr)
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
