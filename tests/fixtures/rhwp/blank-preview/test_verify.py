"""CLI integrity regressions; all mutations are in temporary copies, including under -O."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
MODES = ((), ("-O",), ("env-optimize",))


class GoldenVerifierTests(unittest.TestCase):
    def setUp(self):
        self.originals = {p.name: p.read_bytes() for p in HERE.iterdir() if p.suffix in (".hex", ".json")}
        self.scratch = tempfile.TemporaryDirectory(prefix="geul-golden-integrity-")
        self.addCleanup(self.scratch.cleanup)
        self.fixture = Path(self.scratch.name) / "fixture"
        self.fixture.mkdir()
        for name, data in self.originals.items():
            (self.fixture / name).write_bytes(data)
        shutil.copyfile(HERE / "verify.py", self.fixture / "verify.py")
        self.manifest = json.loads(self.originals["provenance.json"])

    def tearDown(self):
        for name, data in self.originals.items():
            self.assertEqual((HERE / name).read_bytes(), data, f"tracked fixture changed: {name}")

    def invoke(self, mode, upstream=None, revision=None):
        env = dict(os.environ)
        env.pop("PYTHONOPTIMIZE", None)
        flags = list(mode)
        if mode == ("env-optimize",):
            env["PYTHONOPTIMIZE"] = "1"
            flags = []
        command = [sys.executable, *flags, str(self.fixture / "verify.py")]
        if upstream is not None:
            command += ["--upstream", str(upstream)]
            # Hermetic source tests stub only Git's revision query. A separate real pinned
            # --upstream invocation establishes the actual checkout identity.
            code = ("import runpy,sys; from unittest.mock import patch; "
                    "script=sys.argv.pop(1); "
                    f"p=patch('subprocess.check_output', return_value={revision!r}); "
                    "p.start(); runpy.run_path(script, run_name='__main__')")
            command = [sys.executable, *flags, "-c", code, *command[len(flags) + 1:]]
        return subprocess.run(command, env=env, capture_output=True, text=True, check=False)

    def save_manifest(self):
        (self.fixture / "provenance.json").write_text(json.dumps(self.manifest))

    def rejects(self, diagnostic, upstream=None, revision=None):
        for mode in MODES:
            with self.subTest(mode=mode):
                result = self.invoke(mode, upstream, revision)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(diagnostic, result.stderr)
                self.assertNotIn("PASS", result.stdout + result.stderr)

    def test_valid_normal_and_optimized(self):
        for mode in MODES:
            with self.subTest(mode=mode):
                result = self.invoke(mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"goldenHashes": "PASS", "pinnedUpstream": "NOT RUN"})

    def test_mutated_hex_content(self):
        path = self.fixture / "prv-image.hex"
        text = path.read_text()
        path.write_text(text[:40] + "01" + text[42:])
        self.rejects("prv-image.hex encoded: SHA-256 mismatch")

    def test_changed_encoded_hash(self):
        self.manifest["assets"][0]["encodedSha256"] = "0" * 64
        self.save_manifest()
        self.rejects("encoded: SHA-256 mismatch")

    def test_changed_decoded_hash(self):
        self.manifest["assets"][0]["sha256"] = "0" * 64
        self.save_manifest()
        self.rejects("decoded: SHA-256 mismatch")

    def test_wrong_length(self):
        self.manifest["assets"][0]["bytes"] += 1
        self.save_manifest()
        self.rejects("byte length mismatch")

    def test_missing_asset(self):
        (self.fixture / "prv-image.hex").unlink()
        self.rejects("prv-image.hex")

    def test_invalid_hex(self):
        data = b"not hex\n"
        (self.fixture / "prv-image.hex").write_bytes(data)
        # Isolated metadata mutation reaches hex decoding after the encoded-hash check.
        self.manifest["assets"][0]["encodedSha256"] = hashlib.sha256(data).hexdigest()
        self.save_manifest()
        self.rejects("invalid hex")

    def test_malformed_json(self):
        (self.fixture / "provenance.json").write_text("{")
        self.rejects("provenance.json")

    def test_malformed_schema(self):
        for invalid in [None, {}, {**self.manifest, "assets": []},
                        {**self.manifest, "sourceSha256": "invalid"}]:
            (self.fixture / "provenance.json").write_text(json.dumps(invalid))
            self.rejects("verification failed")

    def test_wrong_pin(self):
        self.manifest["revision"] = "0" * 40
        self.save_manifest()
        self.rejects("unexpected provenance revision")

    def upstream_fixture(self, png):
        upstream = Path(self.scratch.name) / "upstream"
        source = upstream / "src/serializer/hwpx/static_assets.rs"
        source.parent.mkdir(parents=True)
        source.write_bytes(b'pub const PRV_IMAGE_PNG: &[u8] = &['
                           + b",".join(f"0x{byte:02x}".encode() for byte in png)
                           + b'];\npub const PRV_TEXT: &[u8] = b"\\r\\n";\n')
        text = upstream / "src/parser/hwpx/blank2010_assets/prvtext.bin"
        text.parent.mkdir(parents=True)
        text.write_bytes(bytes.fromhex(self.originals["prv-text-utf16le.hex"].decode()))
        return upstream, source

    def test_upstream_source_divergence(self):
        upstream, _ = self.upstream_fixture(b"changed")
        self.rejects("upstream source: SHA-256 mismatch", upstream, self.manifest["revision"])

    def test_upstream_asset_divergence(self):
        upstream, source = self.upstream_fixture(b"changed")
        self.manifest["sourceSha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
        self.save_manifest()
        self.rejects("upstream asset bytes mismatch", upstream, self.manifest["revision"])

    def test_upstream_wrong_revision(self):
        upstream, _ = self.upstream_fixture(b"changed")
        self.rejects("upstream HEAD differs from pin", upstream, "0" * 40)


if __name__ == "__main__":
    unittest.main()
