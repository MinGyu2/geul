#!/usr/bin/env python3
"""Verify immutable golden hashes; --upstream additionally checks the pinned checkout. Never writes assets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

PIN = "1a76570e833917d15817415a53c09ad61ab3203f"
HERE = Path(__file__).resolve().parent


def verify(upstream=None):
    manifest = json.loads((HERE / "provenance.json").read_text())
    assert manifest["revision"] == PIN, "unexpected provenance revision"
    for asset in manifest["assets"]:
        encoded = (HERE / asset["file"]).read_bytes()
        assert hashlib.sha256(encoded).hexdigest() == asset["encodedSha256"], asset["file"]
        data = bytes.fromhex(encoded.decode("ascii"))
        assert len(data) == asset["bytes"], asset["file"]
        assert hashlib.sha256(data).hexdigest() == asset["sha256"], asset["file"]
    if upstream is None:
        return {"goldenHashes": "PASS", "pinnedUpstream": "NOT RUN"}
    revision = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    assert revision == PIN, "upstream HEAD differs from pin"
    source_path = "src/serializer/hwpx/static_assets.rs"
    source = (upstream / source_path).read_bytes()
    assert hashlib.sha256(source).hexdigest() == manifest["sourceSha256"], "source divergence"
    array = re.search(rb"pub const PRV_IMAGE_PNG: &\[u8\] = &\[(.*?)\];", source, re.S)[1]
    png = bytes(int(token, 16) for token in re.findall(rb"0x([0-9A-Fa-f]{2})", array))
    text = re.search(rb'pub const PRV_TEXT: &\[u8\] = b"(.*?)";', source)[1]
    assert text == rb"\r\n", "unexpected upstream literal"
    expected = [png, b"\r\n", (upstream / "src/parser/hwpx/blank2010_assets/prvtext.bin").read_bytes()]
    assert len(expected) == len(manifest["assets"])
    for asset, data in zip(manifest["assets"], expected):
        assert data == bytes.fromhex((HERE / asset["file"]).read_text()), asset["source"]
    return {"goldenHashes": "PASS", "pinnedUpstream": "PASS", "revision": revision}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.upstream)))
