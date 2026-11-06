"""Regression for Tauri project discovery after private-root sandbox entry."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
