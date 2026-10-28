import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import oracle_strict as oracle


def _errors():
    return {name: 0 for name in oracle.ERROR_FIELDS}


def _verified_row(path="a.hwp", digest="a" * 64):
    return {
        "path": path,
        "sha256": digest,
        "status": "verified",
        "complete": True,
        "exclusionReason": None,
        "openedA": True,
        "openedB": True,
        "edits": {"required": 30, "attempted": 30, "applied": 30, "rejected": 0},
        "pagination": {"expected": 31, "attempted": 31, "successful": 31},
        "svg": {"pageCountA": 2, "pageCountB": 2, "expected": 2, "attempted": 2, "successful": 2},
        "errors": _errors(),
    }


def _stage_b_row():
    return {
        "path": oracle.HUGE_TABLE_PATH,
        "sha256": oracle.HUGE_TABLE_SHA256,
        "status": "excluded",
        "complete": False,
        "exclusionReason": "stage-b-separate",
        "openedA": False,
        "openedB": False,
        "edits": {"required": 30, "attempted": 0, "applied": 0, "rejected": 0},
        "pagination": {"expected": 0, "attempted": 0, "successful": 0},
        "svg": {"pageCountA": 0, "pageCountB": 0, "expected": 0, "attempted": 0, "successful": 0},
        "errors": _errors(),
    }


def _open_failure_row(path, digest):
    return {
        "path": path,
        "sha256": digest,
        "status": "excluded",
        "complete": False,
        "exclusionReason": "approved-open-failure",
        "openedA": False,
        "openedB": False,
        "edits": {"required": 30, "attempted": 0, "applied": 0, "rejected": 0},
        "pagination": {"expected": 0, "attempted": 0, "successful": 0},
        "svg": {"pageCountA": 0, "pageCountB": 0, "expected": 0, "attempted": 0, "successful": 0},
        "errors": {**_errors(), "openSymmetric": 1},
    }


def _summary(rows):
    summary = {
        "mode": "strict", "files": len(rows), "opened": 0, "excluded": 0, "failed": 0, "verified": 0,
        "attempted": 0, "applied": 0, "rejected": 0,
        "paginationExpected": 0, "paginationAttempted": 0, "compared": 0,
        "svgExpected": 0, "svgAttempted": 0, "svgPages": 0,
        **{field: 0 for field in oracle.ERROR_FIELDS},
    }
    for row in rows:
        summary["opened"] += int(row.get("openedA") is True and row.get("openedB") is True)
        summary["excluded"] += int(row.get("status") == "excluded")
        summary["verified"] += int(row.get("status") == "verified")
        summary["failed"] += int(row.get("status") not in ("excluded", "verified"))
        edits = row.get("edits", {})
        pagination = row.get("pagination", {})
        svg = row.get("svg", {})
        summary["attempted"] += edits.get("attempted", 0)
        summary["applied"] += edits.get("applied", 0)
        summary["rejected"] += edits.get("rejected", 0)
        summary["paginationExpected"] += pagination.get("expected", 0)
        summary["paginationAttempted"] += pagination.get("attempted", 0)
        summary["compared"] += pagination.get("successful", 0)
        summary["svgExpected"] += svg.get("expected", 0)
        summary["svgAttempted"] += svg.get("attempted", 0)
        summary["svgPages"] += svg.get("successful", 0)
        for field in oracle.ERROR_FIELDS:
            summary[field] += row.get("errors", {}).get(field, 0)
    return summary


def _toy_manifest():
    documents = [
        {"path": "a.hwp", "sizeBytes": 100, "sha256": "a" * 64},
        {"path": oracle.HUGE_TABLE_PATH, "sizeBytes": 200, "sha256": oracle.HUGE_TABLE_SHA256},
        {"path": "large.hwpx", "sizeBytes": oracle.MAX_DOCUMENT_BYTES + 1, "sha256": "b" * 64},
    ]
    exclusions = [
        {"path": oracle.HUGE_TABLE_PATH, "sha256": oracle.HUGE_TABLE_SHA256, "reason": "stage-b-separate"},
        {"path": "large.hwpx", "sha256": "b" * 64, "reason": "source-size-limit"},
    ]
    return {
        "schema": oracle.MANIFEST_SCHEMA,
        "source": {"gitlinkRevision": oracle.PINNED_RHWP_REVISION},
        "selection": {"extensions": [".hwp", ".hwpx"], "maxBytesInclusive": oracle.MAX_DOCUMENT_BYTES},
        "requiredEditsPerDocument": 30,
        "expectedDocumentCount": 3,
        "expectedSelectedDocumentCount": 2,
        "expectedStageADocumentCount": 1,
        "expectedApprovedExclusionCount": 2,
        "expectedApprovedExclusionsByReason": {"source-size-limit": 1, "stage-b-separate": 1},
        "approvedExclusions": exclusions,
        "documents": documents,
    }


class StrictOracleTests(unittest.TestCase):
    def setUp(self):
        self.manifest = _toy_manifest()
        self.rows = [_verified_row(), _stage_b_row()]
        self.summary = _summary(self.rows)

    def evaluate(self, rows=None, summary=None, cargo_exit=0, manifest=None):
        return oracle.evaluate_results(manifest or self.manifest, self.rows if rows is None else rows,
                                       self.summary if summary is None else summary, cargo_exit)

    def test_complete_document_rows_and_explicit_exclusions_pass(self):
        result = self.evaluate()
        self.assertEqual(result["status"], "PASS", result["failures"])
        self.assertEqual(result["sourceDocumentCount"], 3)
        self.assertEqual(result["selectedDocumentCount"], 2)
        self.assertEqual(result["counts"]["verified"], 1)
        self.assertEqual(result["counts"]["excluded"], 1)

    def test_inflated_aggregate_cannot_hide_a_missing_document(self):
        result = self.evaluate(rows=[self.rows[0]], summary=self.summary)
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("missing oracle result rows" in item for item in result["failures"]))

    def test_aggregate_verified_count_cannot_replace_edit_coverage(self):
        row = copy.deepcopy(self.rows[0])
        row["edits"]["attempted"] = 30
        row["edits"]["applied"] = 29
        summary = copy.deepcopy(self.summary)
        result = self.evaluate(rows=[row, self.rows[1]], summary=summary)
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("coverage is incomplete" in item for item in result["failures"]))
        self.assertTrue(any("producer aggregate applied" in item for item in result["failures"]))

    def test_pagination_comparison_count_is_mandatory(self):
        row = copy.deepcopy(self.rows[0])
        row["pagination"]["successful"] = 30
        result = self.evaluate(rows=[row, self.rows[1]], summary=self.summary)
        self.assertEqual(result["status"], "FAIL")

    def test_every_expected_svg_page_must_succeed(self):
        row = copy.deepcopy(self.rows[0])
        row["svg"]["successful"] = 1
        result = self.evaluate(rows=[row, self.rows[1]], summary=self.summary)
        self.assertEqual(result["status"], "FAIL")

    def test_unexpected_exclusion_is_not_a_verified_document(self):
        row = copy.deepcopy(self.rows[0])
        row.update(status="excluded", complete=False, exclusionReason="symmetric-open-failure", openedA=False, openedB=False)
        row["errors"]["openSymmetric"] = 1
        summary = _summary([row, self.rows[1]])
        result = self.evaluate(rows=[row, self.rows[1]], summary=summary)
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("coverage is incomplete" in item for item in result["failures"]))

    def test_duplicate_and_unexpected_result_rows_fail(self):
        duplicate = self.evaluate(rows=[*self.rows, copy.deepcopy(self.rows[0])], summary=self.summary)
        self.assertEqual(duplicate["status"], "FAIL")
        self.assertTrue(any("duplicate oracle result row" in item for item in duplicate["failures"]))
        unexpected = copy.deepcopy(self.rows[0])
        unexpected["path"] = "not-in-manifest.hwp"
        result = self.evaluate(rows=[*self.rows, unexpected], summary=self.summary)
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("unexpected or malformed" in item for item in result["failures"]))

    def test_wrong_exclusion_identity_and_count_fail(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["approvedExclusions"][0]["sha256"] = "f" * 64
        errors = oracle.validate_manifest(Path("."), manifest)
        self.assertTrue(any("approved exclusion identities" in item for item in errors))

    def test_only_fixed_password_document_identities_can_be_open_exclusions(self):
        self.assertEqual(len(oracle.APPROVED_OPEN_FAILURES), 3)
        path, (digest, size) = next(iter(oracle.APPROVED_OPEN_FAILURES.items()))
        document = {"path": path, "sizeBytes": size, "sha256": digest}
        exclusions = oracle.manifest_exclusions([document])
        self.assertEqual(exclusions, [{"path": path, "sha256": digest, "reason": "approved-open-failure"}])
        document["sha256"] = "0" * 64
        with self.assertRaisesRegex(oracle.OracleError, "approved open-failure fixture identity mismatch"):
            oracle.manifest_exclusions([document])

    def test_approved_open_failure_requires_exact_symmetric_error_and_no_coverage(self):
        manifest = copy.deepcopy(self.manifest)
        path, (digest, size) = next(iter(oracle.APPROVED_OPEN_FAILURES.items()))
        manifest["documents"].append({"path": path, "sizeBytes": size, "sha256": digest})
        manifest["documents"].sort(key=lambda item: item["path"])
        manifest["approvedExclusions"] = oracle.manifest_exclusions(manifest["documents"])
        manifest["expectedDocumentCount"] += 1
        manifest["expectedSelectedDocumentCount"] += 1
        manifest["expectedStageADocumentCount"] += 1
        manifest["expectedApprovedExclusionCount"] = len(manifest["approvedExclusions"])
        manifest["expectedApprovedExclusionsByReason"] = {
            reason: sum(item["reason"] == reason for item in manifest["approvedExclusions"])
            for reason in sorted({item["reason"] for item in manifest["approvedExclusions"]})
        }
        open_row = _open_failure_row(path, digest)
        rows = [self.rows[0], self.rows[1], open_row]
        self.assertEqual(oracle.evaluate_results(manifest, rows, _summary(rows), 0)["status"], "PASS")

        forged_error = copy.deepcopy(open_row)
        forged_error["errors"]["svgDifferent"] = 1
        rows = [self.rows[0], self.rows[1], forged_error]
        result = oracle.evaluate_results(manifest, rows, _summary(rows), 0)
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("did not reproduce symmetrically" in item for item in result["failures"]))

        hidden_coverage = copy.deepcopy(open_row)
        hidden_coverage["edits"]["attempted"] = 1
        rows = [self.rows[0], self.rows[1], hidden_coverage]
        result = oracle.evaluate_results(manifest, rows, _summary(rows), 0)
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("did not reproduce symmetrically" in item for item in result["failures"]))

    def test_nonzero_cargo_exit_and_missing_summary_cannot_pass(self):
        self.assertEqual(self.evaluate(cargo_exit=1)["status"], "FAIL")
        missing_summary = oracle.evaluate_results(self.manifest, self.rows, None, 0)
        self.assertEqual(missing_summary["status"], "FAIL")

    def test_manifest_detects_missing_unexpected_duplicate_and_mutated_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.hwp").write_bytes(b"first")
            (root / "b.hwpx").write_bytes(b"second")
            manifest = oracle.generate_manifest(root)
            self.assertEqual(oracle.validate_manifest(root, manifest), [])

            (root / "a.hwp").unlink()
            errors = oracle.validate_manifest(root, manifest)
            self.assertTrue(any("missing documents" in item for item in errors))

            (root / "a.hwp").write_bytes(b"first")
            (root / "unexpected.hwp").write_bytes(b"extra")
            errors = oracle.validate_manifest(root, manifest)
            self.assertTrue(any("unexpected documents" in item for item in errors))

            (root / "unexpected.hwp").unlink()
            (root / "a.hwp").write_bytes(b"changed")
            errors = oracle.validate_manifest(root, manifest)
            self.assertTrue(any("content identity mismatch" in item for item in errors))

            duplicate = copy.deepcopy(manifest)
            duplicate["documents"].append(copy.deepcopy(duplicate["documents"][0]))
            duplicate["expectedDocumentCount"] += 1
            errors = oracle.validate_manifest(root, duplicate)
            self.assertTrue(any("duplicate manifest document" in item for item in errors))

    def test_manifest_digest_is_checked_when_expected(self):
        manifest = self.manifest
        raw = json.dumps(manifest, sort_keys=True).encode()
        errors = oracle.validate_manifest(Path("."), manifest, raw_manifest=raw,
                                          expected_manifest_sha256="0" * 64)
        self.assertTrue(any("expected digest" in item for item in errors))


if __name__ == "__main__":
    unittest.main()
