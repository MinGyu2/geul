"""Regression for Tauri project discovery after private-root sandbox entry."""
import importlib.util
import json
import os
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("tauri_geul", ROOT / "scripts/tauri-geul.py")
tauri = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tauri)


class ProjectDirectoryTests(unittest.TestCase):
    def test_bootstrap_reenters_project_from_root_and_preserves_literal_arguments(self):
        command = tauri.project_command([sys.executable, "-c",
            "import json, os, sys; print(json.dumps([os.getcwd(), sys.argv[1:]]))",
            "space and --option", "literal=$value"])
        result = subprocess.run(command, cwd="/", text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), [str(ROOT), ["space and --option", "literal=$value"]])


class ReleaseBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.env = {"HOME": str(self.base / "home"), "CARGO_HOME": str(self.base / "cargo")}
        configs = patch.object(tauri, "cargo_configs", return_value=[])
        configs.start()
        self.addCleanup(configs.stop)

    def test_flags_preserve_cargo_precedence_and_literal_encoded_arguments(self):
        for original, expected in [({"RUSTFLAGS": "-C target-cpu=generic"}, ["-C", "target-cpu=generic"]),
                                   ({"RUSTFLAGS": "ignored", "CARGO_ENCODED_RUSTFLAGS": "-L\x1fpath with spaces"}, ["-L", "path with spaces"]),
                                   ({"RUSTFLAGS": "ignored", "CARGO_ENCODED_RUSTFLAGS": ""}, [])]:
            with self.subTest(original=original):
                result = tauri.release_environment({**self.env, **original, "CC": "gcc", "NIX_CFLAGS_COMPILE": "-isystem /usr/include"})
                flags = result["CARGO_ENCODED_RUSTFLAGS"].split("\x1f")
                self.assertEqual(flags[:len(expected)], expected)
                self.assertTrue(all(f.startswith("--remap-path-prefix=") for f in flags[len(expected):]))
                self.assertEqual(flags[-1], f"--remap-path-prefix={ROOT}=/src/geul")
                self.assertEqual(result["NIX_CFLAGS_COMPILE"], "-isystem /usr/include")
                self.assertEqual(result["CC"], "gcc")
                self.assertNotIn("RUSTFLAGS", result)

    def test_conflicting_remapping_and_configured_flags_fail_explicitly(self):
        for flags in ("--remap-path-prefix=source=/virtual", "--remap-path-scope=macro"):
            with self.assertRaises(RuntimeError):
                tauri.release_environment({**self.env, "RUSTFLAGS": flags})
        for config in ({"build": {"rustflags": ["-C", "target-cpu=generic"]}},
                       {"target": {"cfg(unix)": {"rustflags": ["-C", "link-arg=-znow"]}}},
                       {"env": {"RUSTFLAGS": {"force": True, "value": "-g"}}}):
            with patch.object(tauri, "cargo_configs", return_value=[(self.base / "config.toml", config)]):
                with self.assertRaises(RuntimeError):
                    tauri.release_environment(self.env)

    def test_only_nonexistent_private_rpath_is_removed_and_nix_store_is_preserved(self):
        missing = self.base / "home" / "absent" / "lib"
        original = f"-rpath {missing}:/nix/store/fixture/lib -L/nix/store/fixture/lib -z now"
        result = tauri.release_environment({**self.env, "NIX_LDFLAGS": original})
        self.assertEqual(result["NIX_LDFLAGS"], "-rpath /nix/store/fixture/lib -L/nix/store/fixture/lib -z now")
        missing.mkdir(parents=True)
        with self.assertRaises(RuntimeError):
            tauri.release_environment({**self.env, "NIX_LDFLAGS": original})

    def test_release_bootstrap_removes_only_final_output_before_build(self):
        artifact = self.base / "geul"
        cache = self.base / "dependency-cache"
        artifact.write_text("stale executable")
        cache.write_text("keep")
        command = tauri.project_command([sys.executable, "-c", "import pathlib,sys; p=pathlib.Path(sys.argv[1]); assert not p.exists(); p.write_text('new executable')", str(artifact)], artifact)
        subprocess.run(command, check=True)
        self.assertEqual(artifact.read_text(), "new executable")
        self.assertEqual(cache.read_text(), "keep")

    def test_output_overrides_fail_and_explicit_target_is_resolved(self):
        for flag in ("--target-dir=elsewhere", "--profile=dev", "--config=override", "--bin=other"):
            with self.assertRaises(RuntimeError):
                tauri.release_artifact(["build", "--", flag], self.env)
        self.assertEqual(tauri.release_artifact(["build", "--target", "x86_64-unknown-linux-gnu"], self.env),
                         ROOT / "src-tauri/target/x86_64-unknown-linux-gnu/release/geul")

    def test_release_gate_follows_successful_protected_build(self):
        order = []
        with patch.object(sys, "argv", ["tauri-geul.py", "build", "--no-bundle"]), patch.dict(os.environ, self.env, clear=True), \
             patch.object(tauri.integrity, "run_readonly", side_effect=lambda *a, **k: order.append(("build", a, k))), \
             patch.object(tauri.subprocess, "run", side_effect=lambda *a, **k: order.append(("gate", a, k))):
            tauri.main()
        self.assertEqual([item[0] for item in order], ["build", "gate"])
        build = order[0]
        self.assertTrue(build[2]["require_clean"])
        self.assertEqual(build[2]["required"], ["external/wordcraft"])
        command = build[1][0][0]
        self.assertIn("--locked", command)
        self.assertIn("--offline", command)
        self.assertIn("CARGO_ENCODED_RUSTFLAGS", build[2]["env"])
        self.assertIn(str(ROOT / "src-tauri/target/release/geul"), order[1][1][0])
        self.assertTrue(order[1][2]["check"])

    def test_failed_build_never_scans_stale_artifact(self):
        with patch.object(sys, "argv", ["tauri-geul.py", "build", "--no-bundle"]), patch.dict(os.environ, self.env, clear=True), \
             patch.object(tauri.integrity, "run_readonly", side_effect=RuntimeError("build failed")), \
             patch.object(tauri.subprocess, "run") as checker:
            with self.assertRaises(RuntimeError):
                tauri.main()
            checker.assert_not_called()

    def test_debug_build_keeps_inherited_flags_and_has_no_release_gate(self):
        for flag in ("--debug", "-d"):
            with patch.object(sys, "argv", ["tauri-geul.py", "build", flag]), patch.dict(os.environ, {**self.env, "RUSTFLAGS": "-g"}, clear=True), \
                 patch.object(tauri.integrity, "run_readonly") as build, patch.object(tauri.subprocess, "run") as checker:
                tauri.main()
                self.assertEqual(build.call_args.kwargs["env"]["RUSTFLAGS"], "-g")
                self.assertEqual(build.call_args.kwargs["env"]["GEUL_RHWP_PROFILE"], "debug" if flag == "--debug" else "release")
                checker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
