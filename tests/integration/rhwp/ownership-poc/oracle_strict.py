#!/usr/bin/env python3
"""Strict whole-corpus acceptance for the T010 format-memo equivalence oracle.

The Rust test produces one JSON row per selected document. This module independently pins the
input inventory and decides whether those rows prove complete coverage. Aggregate counters alone
are never sufficient.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath
PINNED_RHWP_REVISION = "1a76570e833917d15817415a53c09ad61ab3203f"
MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
HUGE_TABLE_PATH = "issue2063_huge_cellbreak_table.hwp"
HUGE_TABLE_SHA256 = "47de1ce82472050a4c5f33ccab2a3eac2c7e55d0e2a688febd085f0b4c8320ca"
APPROVED_OPEN_FAILURES = {
    "HWP3-password-123456.hwp": ("db743d084efc9e08e839a5b4d978b16b8676434011776e090e4cda43e57304be", 101244),
    "HWP5-password-123456.hwpx": ("93e7a62565e0f3efa4feee2812aaf518347dbbcc09d2f26a0d9385f9a4e26060", 110701),
    "hwp3-sample16-hwp5-2024-password-123456.hwp": (
        "59d4bed335b9552fe78fa68d2a56f7cfa3d586bcdeaaba839af80df13f3e08dc", 2988032,
    ),
}
MANIFEST_SCHEMA = "geul.t010.oracle-input-manifest.v1"
EXPECTED_MANIFEST_SHA256 = "58c9c25049fa6bf9b6073a07c0e51dab2f104822f7d413bd1aa7d0cf39a7eb2e"
EXPECTED_SOURCE_DOCUMENTS = 1205
EXPECTED_SELECTED_DOCUMENTS = 1150
EXPECTED_STAGE_A_DOCUMENTS = 1149

ERROR_FIELDS = (
    "read", "identity", "openSymmetric", "openAsymmetric", "editSymmetric", "editAsymmetric",
    "pagination", "svgSymmetric", "svgAsymmetric", "svgDifferent",
)


class OracleError(ValueError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise OracleError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> tuple[bytes, dict[str, Any]]:
    raw = path.read_bytes()
    value = json.loads(raw, object_pairs_hook=_unique_object)
    if type(value) is not dict:
        raise OracleError("manifest root must be an object")
    return raw, value


def discover_documents(root: Path) -> tuple[set[str], list[str]]:
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        return set(), ["sample root must be an ordinary directory"]
    found: set[str] = set()
    errors: list[str] = []
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        current_path = Path(current)
        for dirname in list(dirnames):
            directory = current_path / dirname
            if directory.is_symlink():
                dirnames.remove(dirname)
                errors.append(f"symlink directory is not allowed: {directory.relative_to(root).as_posix()}")
        for filename in filenames:
            path = current_path / filename
            if path.suffix not in (".hwp", ".hwpx"):
                continue
            relative = path.relative_to(root).as_posix()
            found.add(relative)
            try:
                mode = path.lstat().st_mode
            except OSError as exc:
                errors.append(f"cannot stat {relative}: {exc}")
                continue
            if not stat.S_ISREG(mode):
                errors.append(f"document is not an ordinary file: {relative}")
    return found, errors


def _safe_relative_path(value: Any) -> bool:
    if type(value) is not str or not value or "\\" in value:
        return False
    path = PurePosixPath(value)
    return not path.is_absolute() and path.as_posix() == value and all(part not in ("", ".", "..") for part in path.parts)


def manifest_exclusions(documents: list[dict[str, Any]]) -> list[dict[str, str]]:
    exclusions: list[dict[str, str]] = []
    for document in documents:
        if type(document) is not dict:
            raise OracleError("document rows must be objects when deriving exclusions")
        path = document.get("path")
        size = document.get("sizeBytes")
        digest = document.get("sha256")
        if type(path) is not str or type(size) is not int or type(digest) is not str:
            raise OracleError("document path, size, and SHA-256 are required when deriving exclusions")
        reason = None
        if size > MAX_DOCUMENT_BYTES:
            reason = "source-size-limit"
        elif path == HUGE_TABLE_PATH:
            reason = "stage-b-separate"
        elif path in APPROVED_OPEN_FAILURES:
            expected_digest, expected_size = APPROVED_OPEN_FAILURES[path]
            if digest != expected_digest or size != expected_size:
                raise OracleError(f"approved open-failure fixture identity mismatch: {path}")
            reason = "approved-open-failure"
        if reason:
            exclusions.append({"path": path, "sha256": digest, "reason": reason})
    return exclusions


def generate_manifest(root: Path) -> dict[str, Any]:
    root = Path(root)
    names, walk_errors = discover_documents(root)
    if walk_errors:
        raise OracleError("; ".join(walk_errors))
    documents: list[dict[str, Any]] = []
    for relative in sorted(names):
        path = root / PurePosixPath(relative)
        info = path.stat()
        documents.append({"path": relative, "sizeBytes": info.st_size, "sha256": sha256_file(path)})
    selected_count = sum(item["sizeBytes"] <= MAX_DOCUMENT_BYTES for item in documents)
    exclusions = manifest_exclusions(documents)
    stage_a_count = selected_count - sum(item["reason"] == "stage-b-separate" for item in exclusions)
    by_reason: dict[str, int] = {}
    for item in exclusions:
        by_reason[item["reason"]] = by_reason.get(item["reason"], 0) + 1
    return {
        "schema": MANIFEST_SCHEMA,
        "source": {
            "repository": "MinGyu2/geul",
            "gitlinkPath": "external/rhwp",
            "gitlinkRevision": PINNED_RHWP_REVISION,
            "sampleRoot": "external/rhwp/samples",
        },
        "selection": {"extensions": [".hwp", ".hwpx"], "maxBytesInclusive": MAX_DOCUMENT_BYTES},
        "requiredEditsPerDocument": 30,
        "expectedDocumentCount": len(documents),
        "expectedSelectedDocumentCount": selected_count,
        "expectedStageADocumentCount": stage_a_count,
        "expectedApprovedExclusionCount": len(exclusions),
        "expectedApprovedExclusionsByReason": by_reason,
        "approvedExclusions": exclusions,
        "documents": documents,
    }


def validate_manifest(
    root: Path,
    manifest: dict[str, Any],
    *,
    raw_manifest: bytes | None = None,
    expected_manifest_sha256: str | None = None,
    require_fixed_corpus: bool = False,
) -> list[str]:
    errors: list[str] = []
    if expected_manifest_sha256 is not None:
        if raw_manifest is None or sha256_bytes(raw_manifest) != expected_manifest_sha256:
            errors.append("manifest SHA-256 does not match the independently supplied expected digest")
    if manifest.get("schema") != MANIFEST_SCHEMA:
        errors.append("unsupported manifest schema")
    source = manifest.get("source")
    if type(source) is not dict or source.get("gitlinkRevision") != PINNED_RHWP_REVISION:
        errors.append("manifest does not identify the pinned RHWP revision")
    selection = manifest.get("selection")
    if selection != {"extensions": [".hwp", ".hwpx"], "maxBytesInclusive": MAX_DOCUMENT_BYTES}:
        errors.append("manifest selection contract differs from the original oracle corpus filter")
    if type(manifest.get("requiredEditsPerDocument")) is not int or manifest["requiredEditsPerDocument"] != 30:
        errors.append("requiredEditsPerDocument must be exactly 30")

    documents = manifest.get("documents")
    if type(documents) is not list:
        return errors + ["documents must be an array"]
    paths: list[str] = []
    by_path: dict[str, dict[str, Any]] = {}
    for index, document in enumerate(documents):
        if type(document) is not dict or set(document) != {"path", "sizeBytes", "sha256"}:
            errors.append(f"documents[{index}] has an invalid shape")
            continue
        path = document["path"]
        if not _safe_relative_path(path):
            errors.append(f"documents[{index}] has an unsafe path")
            continue
        paths.append(path)
        if path in by_path:
            errors.append(f"duplicate manifest document: {path}")
        else:
            by_path[path] = document
        if type(document["sizeBytes"]) is not int or document["sizeBytes"] < 0:
            errors.append(f"invalid size for {path}")
        if type(document["sha256"]) is not str or not re.fullmatch(r"[0-9a-f]{64}", document["sha256"]):
            errors.append(f"invalid SHA-256 for {path}")
    if paths != sorted(paths):
        errors.append("manifest documents must be sorted by relative path")
    if type(manifest.get("expectedDocumentCount")) is not int or manifest["expectedDocumentCount"] != len(documents):
        errors.append("expectedDocumentCount does not match manifest rows")

    actual_paths, walk_errors = discover_documents(root)
    errors.extend(walk_errors)
    missing = sorted(set(by_path) - actual_paths)
    unexpected = sorted(actual_paths - set(by_path))
    if missing:
        errors.append(f"missing documents: {missing[:8]}")
    if unexpected:
        errors.append(f"unexpected documents: {unexpected[:8]}")
    for relative, document in by_path.items():
        path = Path(root) / PurePosixPath(relative)
        if not path.exists() or path.is_symlink():
            continue
        try:
            size = path.stat().st_size
            digest = sha256_file(path)
        except OSError as exc:
            errors.append(f"cannot read {relative}: {exc}")
            continue
        if size != document.get("sizeBytes"):
            errors.append(f"size identity mismatch: {relative}")
        if digest != document.get("sha256"):
            errors.append(f"content identity mismatch: {relative}")

    selected = [doc for doc in documents if type(doc) is dict and type(doc.get("sizeBytes")) is int and doc["sizeBytes"] <= MAX_DOCUMENT_BYTES]
    try:
        expected_exclusions = manifest_exclusions(documents)
    except OracleError as exc:
        errors.append(str(exc))
        expected_exclusions = []
    supplied_exclusions = manifest.get("approvedExclusions")
    if supplied_exclusions != expected_exclusions:
        errors.append("approved exclusion identities, reasons, or counts do not match the manifest document inventory")
    expected_stage_a = len(selected) - sum(entry["reason"] == "stage-b-separate" for entry in expected_exclusions)
    counts = (
        ("expectedSelectedDocumentCount", len(selected)),
        ("expectedStageADocumentCount", expected_stage_a),
        ("expectedApprovedExclusionCount", len(expected_exclusions)),
    )
    for field, expected in counts:
        if type(manifest.get(field)) is not int or manifest[field] != expected:
            errors.append(f"{field} does not match the independently counted inventory")
    by_reason: dict[str, int] = {}
    for exclusion in expected_exclusions:
        by_reason[exclusion["reason"]] = by_reason.get(exclusion["reason"], 0) + 1
    if manifest.get("expectedApprovedExclusionsByReason") != by_reason:
        errors.append("approved exclusion reason counts do not match identities")

    huge = by_path.get(HUGE_TABLE_PATH)
    if require_fixed_corpus and (huge is None or huge.get("sha256") != HUGE_TABLE_SHA256):
        errors.append("the Stage B huge-table fixture identity is missing or changed")
    if require_fixed_corpus:
        fixed = {
            "documents": EXPECTED_SOURCE_DOCUMENTS,
            "selected": EXPECTED_SELECTED_DOCUMENTS,
            "stageA": EXPECTED_STAGE_A_DOCUMENTS,
            "approvedExclusions": 59,
            "approvedOpenFailures": len(APPROVED_OPEN_FAILURES),
        }
        observed = {
            "documents": len(documents), "selected": len(selected), "stageA": expected_stage_a,
            "approvedExclusions": len(expected_exclusions),
            "approvedOpenFailures": sum(item["reason"] == "approved-open-failure" for item in expected_exclusions),
        }
        if observed != fixed:
            errors.append(f"pinned corpus counts differ: expected {fixed}, observed {observed}")
    return errors


def parse_oracle_log(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    documents: list[dict[str, Any]] = []
    summary = None
    for line_number, line in enumerate(Path(path).read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if line.startswith("GEUL_ORACLE_DOC "):
            value = json.loads(line[len("GEUL_ORACLE_DOC "):], object_pairs_hook=_unique_object)
            if type(value) is not dict:
                raise OracleError(f"oracle doc row at line {line_number} is not an object")
            documents.append(value)
        elif line.startswith("GEUL_ORACLE_SUMMARY "):
            value = json.loads(line[len("GEUL_ORACLE_SUMMARY "):], object_pairs_hook=_unique_object)
            if type(value) is not dict:
                raise OracleError(f"oracle summary at line {line_number} is not an object")
            if summary is not None:
                raise OracleError("oracle log contains duplicate final summaries")
            summary = value
    return documents, summary


def _exact_nonnegative_int(value: Any) -> bool:
    return type(value) is int and value >= 0


def _has_empty_exclusion_coverage(row: dict[str, Any], required_edits: Any) -> bool:
    edits = row.get("edits")
    pagination = row.get("pagination")
    svg = row.get("svg")
    return (
        type(required_edits) is int and _exact_nonnegative_int(required_edits)
        and type(edits) is dict and all(_exact_nonnegative_int(edits.get(key)) for key in ("required", "attempted", "applied", "rejected"))
        and edits == {"required": required_edits, "attempted": 0, "applied": 0, "rejected": 0}
        and type(pagination) is dict and all(_exact_nonnegative_int(pagination.get(key)) for key in ("expected", "attempted", "successful"))
        and pagination == {"expected": 0, "attempted": 0, "successful": 0}
        and type(svg) is dict and all(_exact_nonnegative_int(svg.get(key)) for key in ("pageCountA", "pageCountB", "expected", "attempted", "successful"))
        and svg == {"pageCountA": 0, "pageCountB": 0, "expected": 0, "attempted": 0, "successful": 0}
    )


def evaluate_results(
    manifest: dict[str, Any],
    rows: list[dict[str, Any]],
    producer_summary: dict[str, Any] | None,
    cargo_exit_code: int,
    *,
    manifest_errors: list[str] | None = None,
) -> dict[str, Any]:
    failures = list(manifest_errors or [])
    documents = manifest.get("documents", [])
    exclusions_list = manifest.get("approvedExclusions", [])
    if type(documents) is not list or type(exclusions_list) is not list:
        return {"status": "FAIL", "failures": failures + ["invalid manifest input"]}
    try:
        expected_exclusions_list = manifest_exclusions(documents)
    except OracleError as exc:
        failures.append(str(exc))
        expected_exclusions_list = []
    if exclusions_list != expected_exclusions_list:
        failures.append("approved exclusion identities, reasons, or counts do not match fixed expectations")
    if manifest.get("expectedDocumentCount") != len(documents):
        failures.append("expectedDocumentCount does not match result manifest inventory")
    selected_document_count = sum(
        type(item) is dict and type(item.get("sizeBytes")) is int and item["sizeBytes"] <= MAX_DOCUMENT_BYTES
        for item in documents
    )
    stage_b_count = sum(item.get("reason") == "stage-b-separate" for item in expected_exclusions_list)
    if manifest.get("expectedSelectedDocumentCount") != selected_document_count:
        failures.append("expectedSelectedDocumentCount does not match result manifest inventory")
    if manifest.get("expectedStageADocumentCount") != selected_document_count - stage_b_count:
        failures.append("expectedStageADocumentCount does not match result manifest inventory")
    if manifest.get("expectedApprovedExclusionCount") != len(expected_exclusions_list):
        failures.append("expectedApprovedExclusionCount does not match fixed exclusion identities")
    by_path = {item.get("path"): item for item in documents if type(item) is dict and type(item.get("path")) is str}
    exclusions = {item.get("path"): item for item in exclusions_list if type(item) is dict and type(item.get("path")) is str}
    selected = {path: item for path, item in by_path.items() if type(item.get("sizeBytes")) is int and item["sizeBytes"] <= MAX_DOCUMENT_BYTES}
    expected_rows = set(selected)
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        path = row.get("path") if type(row) is dict else None
        if type(path) is not str or path not in expected_rows:
            failures.append(f"unexpected or malformed oracle result row: {path!r}")
            continue
        if path in seen:
            failures.append(f"duplicate oracle result row: {path}")
            continue
        seen[path] = row
    missing = sorted(expected_rows - set(seen))
    if missing:
        failures.append(f"missing oracle result rows: {missing[:8]}")

    totals: dict[str, int] = {
        "opened": 0, "excluded": 0, "failed": 0, "verified": 0,
        "attemptedEdits": 0, "appliedEdits": 0, "rejectedEdits": 0,
        "paginationExpected": 0, "paginationAttempted": 0, "paginationSuccessful": 0,
        "svgExpected": 0, "svgAttempted": 0, "svgSuccessful": 0,
        **{field: 0 for field in ERROR_FIELDS},
    }
    required_edits = manifest.get("requiredEditsPerDocument")
    for path in sorted(expected_rows & set(seen)):
        row = seen[path]
        expected_document = selected[path]
        if row.get("sha256") != expected_document.get("sha256"):
            failures.append(f"result identity mismatch: {path}")
        row_errors = row.get("errors")
        if type(row_errors) is not dict:
            failures.append(f"missing error counters: {path}")
            row_errors = {}
        for field in ERROR_FIELDS:
            value = row_errors.get(field)
            if not _exact_nonnegative_int(value):
                failures.append(f"invalid error counter {field}: {path}")
                value = 0
            totals[field] += value
        opened_a, opened_b = row.get("openedA"), row.get("openedB")
        if opened_a is True and opened_b is True:
            totals["opened"] += 1

        exclusion = exclusions.get(path)
        if exclusion and exclusion.get("reason") == "stage-b-separate":
            valid_skip = (
                row.get("status") == "excluded" and row.get("exclusionReason") == "stage-b-separate"
                and row.get("complete") is False
                and row.get("openedA") is False and row.get("openedB") is False
                and _has_empty_exclusion_coverage(row, required_edits)
                and all(row_errors.get(field) == 0 for field in ERROR_FIELDS)
            )
            if not valid_skip:
                failures.append(f"Stage B document was not reported as the exact separate exclusion: {path}")
            else:
                totals["excluded"] += 1
            continue
        if exclusion and exclusion.get("reason") == "approved-open-failure":
            expected_errors = {field: int(field == "openSymmetric") for field in ERROR_FIELDS}
            valid_open_exclusion = (
                row.get("status") == "excluded" and row.get("exclusionReason") == "approved-open-failure"
                and row.get("complete") is False
                and row.get("openedA") is False and row.get("openedB") is False
                and row_errors == expected_errors
                and _has_empty_exclusion_coverage(row, required_edits)
            )
            if not valid_open_exclusion:
                failures.append(f"approved open exclusion did not reproduce symmetrically: {path}")
            else:
                totals["excluded"] += 1
            continue

        edits = row.get("edits")
        pagination = row.get("pagination")
        svg = row.get("svg")
        if type(edits) is not dict or type(pagination) is not dict or type(svg) is not dict:
            failures.append(f"missing coverage fields: {path}")
            totals["failed"] += 1
            continue
        for field in ("required", "attempted", "applied", "rejected"):
            if not _exact_nonnegative_int(edits.get(field)):
                failures.append(f"invalid edit count {field}: {path}")
        for field in ("expected", "attempted", "successful"):
            if not _exact_nonnegative_int(pagination.get(field)):
                failures.append(f"invalid pagination count {field}: {path}")
        for field in ("pageCountA", "pageCountB", "expected", "attempted", "successful"):
            if not _exact_nonnegative_int(svg.get(field)):
                failures.append(f"invalid SVG count {field}: {path}")

        totals["attemptedEdits"] += edits.get("attempted", 0) if _exact_nonnegative_int(edits.get("attempted")) else 0
        totals["appliedEdits"] += edits.get("applied", 0) if _exact_nonnegative_int(edits.get("applied")) else 0
        totals["rejectedEdits"] += edits.get("rejected", 0) if _exact_nonnegative_int(edits.get("rejected")) else 0
        for target, field in (("paginationExpected", "expected"), ("paginationAttempted", "attempted"), ("paginationSuccessful", "successful")):
            if _exact_nonnegative_int(pagination.get(field)):
                totals[target] += pagination[field]
        for target, field in (("svgExpected", "expected"), ("svgAttempted", "attempted"), ("svgSuccessful", "successful")):
            if _exact_nonnegative_int(svg.get(field)):
                totals[target] += svg[field]

        complete = (
            row.get("status") == "verified" and row.get("complete") is True
            and opened_a is True and opened_b is True
            and type(required_edits) is int
            and edits.get("required") == required_edits
            and edits.get("attempted") == required_edits
            and edits.get("applied") == required_edits
            and edits.get("rejected") == 0
            and pagination.get("expected") == required_edits + 1
            and pagination.get("attempted") == required_edits + 1
            and pagination.get("successful") == required_edits + 1
            and svg.get("pageCountA") == svg.get("pageCountB")
            and svg.get("expected") == svg.get("pageCountA")
            and svg.get("attempted") == svg.get("expected")
            and svg.get("successful") == svg.get("expected")
            and svg.get("expected", 0) > 0
            and all(row_errors.get(field) == 0 for field in ERROR_FIELDS)
        )
        if complete:
            totals["verified"] += 1
        else:
            totals["failed"] += 1
            failures.append(f"mandatory coverage is incomplete or erroneous: {path}")

    if type(producer_summary) is not dict:
        failures.append("oracle log has no final producer summary")
    else:
        expected_producer = {
            "mode": "strict", "files": len(expected_rows), "opened": totals["opened"],
            "excluded": totals["excluded"], "failed": totals["failed"], "verified": totals["verified"],
            "attempted": totals["attemptedEdits"], "applied": totals["appliedEdits"],
            "rejected": totals["rejectedEdits"], "paginationExpected": totals["paginationExpected"],
            "paginationAttempted": totals["paginationAttempted"], "compared": totals["paginationSuccessful"],
            "svgExpected": totals["svgExpected"], "svgAttempted": totals["svgAttempted"],
            "svgPages": totals["svgSuccessful"],
            **{field: totals[field] for field in ERROR_FIELDS},
        }
        for field, actual in expected_producer.items():
            if producer_summary.get(field) != actual:
                failures.append(f"producer aggregate {field} disagrees with per-document records")
    if cargo_exit_code != 0:
        failures.append(f"Cargo oracle process exited with {cargo_exit_code}")

    expected_exclusions = len(exclusions)
    size_exclusions = sum(item.get("reason") == "source-size-limit" for item in exclusions_list if type(item) is dict)
    stage_b_exclusions = sum(item.get("reason") == "stage-b-separate" for item in exclusions_list if type(item) is dict)
    open_exclusions = sum(item.get("reason") == "approved-open-failure" for item in exclusions_list if type(item) is dict)
    accepted = (
        not failures and totals["failed"] == 0
        and totals["verified"] == manifest.get("expectedStageADocumentCount", -1) - open_exclusions
        and totals["excluded"] == stage_b_exclusions + open_exclusions
        and len(documents) == manifest.get("expectedDocumentCount", -1)
        and expected_exclusions == manifest.get("expectedApprovedExclusionCount", -1)
    )
    if not accepted and not failures:
        failures.append("whole-corpus counts do not satisfy manifest acceptance")
    return {
        "schema": "geul.t010.oracle-result.v1",
        "status": "PASS" if accepted else "FAIL",
        "failures": failures,
        "sourceDocumentCount": len(documents),
        "selectedDocumentCount": len(selected),
        "expectedStageADocumentCount": manifest.get("expectedStageADocumentCount"),
        "expectedApprovedExclusionCount": expected_exclusions,
        "approvedExclusionsByReason": {reason: sum(item.get("reason") == reason for item in exclusions_list if type(item) is dict)
                                        for reason in sorted({item.get("reason") for item in exclusions_list if type(item) is dict})},
        "resultRows": len(rows),
        "cargoExitCode": cargo_exit_code,
        "counts": totals,
    }


def verify_pinned_source(root: Path) -> str:
    process = subprocess.run(
        ["git", "-C", str(Path(root).resolve().parent), "rev-parse", "HEAD"],
        text=True, capture_output=True, check=False,
    )
    if process.returncode != 0:
        raise OracleError(f"cannot identify RHWP sample source revision: {process.stderr.strip()}")
    revision = process.stdout.strip()
    if revision != PINNED_RHWP_REVISION:
        raise OracleError(f"sample source revision mismatch: {revision}")
    status = subprocess.run(
        ["git", "-C", str(Path(root).resolve().parent), "status", "--short", "--untracked-files=all"],
        text=True, capture_output=True, check=False,
    )
    if status.returncode != 0 or status.stdout.strip():
        raise OracleError("pinned RHWP sample source is not clean")
    return revision


def _write_manifest(args: argparse.Namespace) -> int:
    source_root = Path(args.samples_root)
    revision = verify_pinned_source(source_root)
    manifest = generate_manifest(source_root)
    if manifest["source"]["gitlinkRevision"] != revision:
        raise OracleError("generated manifest revision differs from pinned submodule")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    output.write_bytes(data)
    print(f"manifestSha256={sha256_bytes(data)}")
    print(f"sourceDocuments={manifest['expectedDocumentCount']} selected={manifest['expectedSelectedDocumentCount']} "
          f"stageA={manifest['expectedStageADocumentCount']} exclusions={manifest['expectedApprovedExclusionCount']}")
    return 0


def _validate_command(args: argparse.Namespace) -> int:
    source_root = Path(args.samples_root)
    verify_pinned_source(source_root)
    raw, manifest = load_json(Path(args.manifest))
    expected = args.expected_manifest_sha256 or EXPECTED_MANIFEST_SHA256
    errors = validate_manifest(source_root, manifest, raw_manifest=raw, expected_manifest_sha256=expected,
                               require_fixed_corpus=True)
    print(json.dumps({"status": "PASS" if not errors else "FAIL", "manifestSha256": sha256_bytes(raw),
                      "errors": errors}, ensure_ascii=False))
    return 0 if not errors else 1


def _parse_log_command(args: argparse.Namespace) -> int:
    _, manifest = load_json(Path(args.manifest))
    rows, summary = parse_oracle_log(Path(args.log))
    result = evaluate_results(manifest, rows, summary, args.cargo_exit_code)
    # A supplied manifest/log pair proves only internal accounting consistency.
    # Only `run` binds pinned source, manifest bytes and the observed producer exit.
    result["diagnosticStatus"] = result["status"]
    result["status"] = "DIAGNOSTIC_ONLY"
    result["authoritativeAcceptance"] = False
    result["acceptanceReason"] = "독립 로그 평가는 입력·생산자 신원을 검증하지 않음; 필수 합격에는 run 사용"
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "diagnosticStatus": result["diagnosticStatus"],
                      "authoritativeAcceptance": False, "rows": result["resultRows"],
                      "failures": len(result["failures"]), "output": str(args.output)}, ensure_ascii=False))
    return 2  # Never return the acceptance-success exit code for diagnostic evaluation.


def _run_command(args: argparse.Namespace) -> int:
    root = Path.cwd()
    sample_root = Path(args.samples_root)
    source_export = Path(args.source_export).resolve()
    manifest_path = Path(args.manifest).resolve()
    log_path = Path(args.log).resolve()
    result_path = Path(args.result).resolve()
    verify_pinned_source(sample_root)
    raw, manifest = load_json(manifest_path)
    manifest_errors = validate_manifest(sample_root, manifest, raw_manifest=raw,
                                         expected_manifest_sha256=args.expected_manifest_sha256 or EXPECTED_MANIFEST_SHA256,
                                         require_fixed_corpus=True)
    if manifest_errors:
        raise OracleError("input manifest preflight failed: " + "; ".join(manifest_errors[:8]))
    if not (source_export / "Cargo.toml").is_file() or not (source_export / "src/document_core/geul_incremental_tests.rs").is_file():
        raise OracleError("source export is missing the applied oracle patch")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "cargo", "test", "--release", "--locked", "--offline", "--manifest-path", str(source_export / "Cargo.toml"),
        "--target-dir", str(Path(args.target_dir).resolve()), "--lib", "geul_format_memo_equivalence_oracle",
        "--", "--ignored", "--nocapture",
    ]
    environment = os.environ.copy()
    environment.update({
        "GEUL_ORACLE_MODE": "strict",
        "GEUL_ORACLE_SAMPLES": str(sample_root.resolve()),
        "GEUL_ORACLE_MANIFEST": str(manifest_path),
        "GEUL_ORACLE_EXPECTED_MANIFEST_SHA256": args.expected_manifest_sha256 or EXPECTED_MANIFEST_SHA256,
        "GEUL_ORACLE_OPS": str(manifest["requiredEditsPerDocument"]),
    })
    started = time.monotonic()
    print("엄격 코퍼스 오라클 실행을 시작했습니다.", flush=True)
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, text=True)
        last_size = 0
        while process.poll() is None:
            time.sleep(args.heartbeat_seconds)
            try:
                size = log_path.stat().st_size
                if size != last_size:
                    lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
                    progress = next((line for line in reversed(lines) if line.startswith("GEUL_PROGRESS ")), None)
                    completed = sum(line.startswith("GEUL_ORACLE_DOC ") for line in lines)
                    print(f"진행: 결과행 {completed}/1150, 최근 작업={progress or '요약 대기'}", flush=True)
                    last_size = size
            except OSError:
                pass
        cargo_exit = process.returncode
    rows, summary = parse_oracle_log(log_path)
    post_errors = validate_manifest(sample_root, manifest, raw_manifest=raw,
                                     expected_manifest_sha256=args.expected_manifest_sha256 or EXPECTED_MANIFEST_SHA256,
                                     require_fixed_corpus=True)
    post_revision = verify_pinned_source(sample_root)
    if post_revision != manifest["source"]["gitlinkRevision"]:
        post_errors.append("source revision changed during oracle run")
    result = evaluate_results(manifest, rows, summary, cargo_exit, manifest_errors=post_errors)
    result.update({
        "manifestSha256": sha256_bytes(raw),
        "sourceRevision": manifest["source"]["gitlinkRevision"],
        "sourcePostRevision": post_revision,
        "sourceExport": str(source_export),
        "sourceExportUpstreamRevision": PINNED_RHWP_REVISION,
        "command": command,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "log": str(log_path),
    })
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"엄격 코퍼스 판정: {result['status']} (열림 {result['counts']['opened']}, 완전 검증 {result['counts']['verified']}, "
          f"제외 {result['counts']['excluded']}, 오류 {len(result['failures'])})", flush=True)
    print(f"원시 로그: {log_path}", flush=True)
    print(f"판정 파일: {result_path}", flush=True)
    return 0 if result["status"] == "PASS" else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    write = subparsers.add_parser("write-manifest")
    write.add_argument("--samples-root", default="external/rhwp/samples")
    write.add_argument("--output", required=True)
    write.set_defaults(func=_write_manifest)
    validate = subparsers.add_parser("validate-manifest")
    validate.add_argument("--samples-root", default="external/rhwp/samples")
    validate.add_argument("--manifest", required=True)
    validate.add_argument("--expected-manifest-sha256")
    validate.set_defaults(func=_validate_command)
    parse = subparsers.add_parser("evaluate-log", help="진단 전용: 필수 합격을 판정하지 않으며 exit 2 반환")
    parse.add_argument("--manifest", required=True)
    parse.add_argument("--log", required=True)
    parse.add_argument("--cargo-exit-code", required=True, type=int)
    parse.add_argument("--output", required=True)
    parse.set_defaults(func=_parse_log_command)
    run = subparsers.add_parser("run")
    run.add_argument("--source-export", required=True)
    run.add_argument("--samples-root", default="external/rhwp/samples")
    run.add_argument("--manifest", required=True)
    run.add_argument("--expected-manifest-sha256")
    run.add_argument("--target-dir", required=True)
    run.add_argument("--log", required=True)
    run.add_argument("--result", required=True)
    run.add_argument("--heartbeat-seconds", type=int, default=30)
    run.set_defaults(func=_run_command)
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (OSError, OracleError, json.JSONDecodeError) as exc:
        print(f"oracle strict failure: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
