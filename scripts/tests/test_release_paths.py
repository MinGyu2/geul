"""Artifact gate tests: real host ELF plus appended strings and controlled readelf failure.

The real fixture is the installed Python interpreter, copied byte-for-byte.
Only the RUNPATH test substitutes dynamic inspection output: its injected tag
uses the exact GNU readelf -dW representation, with all other inspections real.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_paths", ROOT / "scripts/check-release-paths.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReleasePathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.binary = self.base / "fixture"
        shutil.copyfile(Path(sys.executable).resolve(), self.binary)
        self.binary.chmod(0o755)
        self.project = self.base / "workspace"
        self.home = self.base / "developer"
        self.cargo = self.base / "cache"
        self.env = {"HOME": str(self.home), "CARGO_HOME": str(self.cargo)}

    def check(self):
        return gate.check(self.binary, self.env, self.project)

    def append(self, value):
        with self.binary.open("ab") as stream:
            stream.write(b"\x00" + str(value).encode() + b"\x00")

    def test_clean_real_executable_passes_without_claiming_portability(self):
        result = self.check()
        self.assertEqual(result["privacyStatus"], "PASS", result)
        self.assertEqual(result["runtimePathStatus"], "PASS")
        self.assertEqual(result["portabilityStatus"], "NOT VERIFIED")
        self.assertTrue(result["elf"]["interpreter"])

    def test_private_project_and_cargo_sources_fail(self):
        for category, root in [("privateProject", self.project), ("privateCargo", self.cargo), ("developerHome", self.home)]:
            with self.subTest(category=category):
                self.append(root / "source.rs")
                result = self.check()
                self.assertEqual(result["privacyStatus"], "FAIL")
                self.assertEqual(result["counts"][category], 1)

    def test_foreign_home_patterns_and_packed_occurrences(self):
        # Construct common home patterns without committing a developer's real path.
        foreign = str(Path("/home") / "fixture-user" / "source.rs")
        _, findings = gate.scan_paths((foreign + foreign).encode(), [])
        self.assertEqual(len(findings), 2)
        for prefix in (Path("/Users") / "fixture-user", Path("/root")):
            self.assertTrue(gate.scan_paths(str(prefix / "source.rs").encode(), [])[1])

    def test_virtual_and_system_paths_are_classified_and_allowed(self):
        self.append("/src/geul/src/main.rs /src/cargo/registry/source.rs /usr/lib/libc.so /lib64/ld.so /nix/store/fixture/lib.so /rustc/fixture/library.rs")
        result = self.check()
        self.assertEqual(result["privacyStatus"], "PASS", result)
        for category in ("virtualSource", "systemRuntime", "nixStore", "buildSystemSource"):
            self.assertGreater(result["counts"][category], 0)

    def test_private_runpath_fails_independently(self):
        real_run = subprocess.run
        def inspect(command, **kwargs):
            result = real_run(command, **kwargs)
            if command[1] == "-dW":
                result.stdout += f" 0x000000000000001d (RUNPATH) Library runpath: [{self.home}/lib:/usr/lib]\n"
            return result
        with patch.object(gate.subprocess, "run", side_effect=inspect):
            result = self.check()
        self.assertEqual(result["runtimePathStatus"], "FAIL")
        self.assertEqual(result["runtimePrivateCount"], 1)

    def test_missing_empty_and_malformed_artifacts_fail(self):
        for data in (None, b"", b"not an executable", b"\x7fELF" + b"\x00" * 64):
            with self.subTest(data=data):
                self.binary.unlink(missing_ok=True)
                if data is not None:
                    self.binary.write_bytes(data)
                    self.binary.chmod(0o755)
                self.assertEqual(self.check()["privacyStatus"], "ERROR")

    def test_shared_object_without_executable_entry_is_rejected(self):
        data = bytearray(self.binary.read_bytes())
        data[24:32] = b"\x00" * 8
        self.binary.write_bytes(data)
        self.assertEqual(self.check()["privacyStatus"], "ERROR")

    def test_inspector_missing_failure_warning_and_empty_output_fail(self):
        for failure in (FileNotFoundError("readelf"), subprocess.TimeoutExpired("readelf", 30)):
            with patch.object(gate.subprocess, "run", side_effect=failure):
                self.assertEqual(self.check()["privacyStatus"], "ERROR")
        for result in (subprocess.CompletedProcess([], 1, "", "tool failure"),
                       subprocess.CompletedProcess([], 0, "", ""),
                       subprocess.CompletedProcess([], 0, "output", "truncated section")):
            with patch.object(gate.subprocess, "run", return_value=result):
                self.assertEqual(self.check()["runtimePathStatus"], "ERROR")

    def test_cli_exit_codes_and_report(self):
        report = self.base / "report.json"
        result = subprocess.run([sys.executable, str(ROOT / "scripts/check-release-paths.py"), str(self.binary), "--report", str(report)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(report.read_text())["privacyStatus"], "PASS")
        self.append(self.project / "source.rs")
        # CLI derives its own root from the environment, separately from unit fixtures.
        result = subprocess.run([sys.executable, str(ROOT / "scripts/check-release-paths.py"), str(self.binary)],
                                env={**os.environ, "HOME": str(self.base)}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
