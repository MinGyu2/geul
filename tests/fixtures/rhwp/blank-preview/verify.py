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
ASSETS = (
    ("prv-image.hex", "src/serializer/hwpx/static_assets.rs#PRV_IMAGE_PNG"),
    ("prv-text-utf8.hex", "src/serializer/hwpx/static_assets.rs#PRV_TEXT"),
    ("prv-text-utf16le.hex", "src/parser/hwpx/blank2010_assets/prvtext.bin"),
)


class VerificationError(ValueError):
    """An explicit integrity failure, including under Python -O/-OO."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def check_hash(data, expected, label):
    require(isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected),
            f"{label}: invalid SHA-256 metadata")
    require(hashlib.sha256(data).hexdigest() == expected, f"{label}: SHA-256 mismatch")


def verify(upstream=None):
    try:
        manifest = json.loads((HERE / "provenance.json").read_text())
    except (ValueError, OSError) as error:
        raise VerificationError(f"provenance.json: {error}") from error
    require(isinstance(manifest, dict), "provenance.json: expected object")
    require(manifest.get("revision") == PIN, "unexpected provenance revision")
    require(manifest.get("upstream") == "https://github.com/edwardkim/rhwp", "unexpected upstream URL")
    assets = manifest.get("assets")
    require(isinstance(assets, list) and len(assets) == len(ASSETS), "provenance.json: expected three assets")
    decoded = []
    for asset, (filename, source_path) in zip(assets, ASSETS, strict=True):
        require(isinstance(asset, dict), "provenance.json: expected asset object")
        require(asset.get("file") == filename and asset.get("source") == source_path,
                f"{filename}: unexpected asset identity")
        require(type(asset.get("bytes")) is int and asset["bytes"] > 0, f"{filename}: invalid byte length")
        encoded = (HERE / filename).read_bytes()
        check_hash(encoded, asset.get("encodedSha256"), f"{filename} encoded")
        try:
            data = bytes.fromhex(encoded.decode("ascii"))
        except ValueError as error:
            raise VerificationError(f"{filename}: invalid hex") from error
        require(len(data) == asset["bytes"], f"{filename}: byte length mismatch")
        check_hash(data, asset.get("sha256"), f"{filename} decoded")
        decoded.append(data)
    # Validate source metadata even when the optional upstream tree is absent.
    require(isinstance(manifest.get("sourceSha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", manifest["sourceSha256"]), "invalid upstream source SHA-256 metadata")
    if upstream is None:
        return {"goldenHashes": "PASS", "pinnedUpstream": "NOT RUN"}
    revision = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    require(revision == PIN, "upstream HEAD differs from pin")
    source = (upstream / "src/serializer/hwpx/static_assets.rs").read_bytes()
    check_hash(source, manifest["sourceSha256"], "upstream source")
    array = re.search(rb"pub const PRV_IMAGE_PNG: &\[u8\] = &\[(.*?)\];", source, re.S)
    require(array is not None, "upstream PRV_IMAGE_PNG declaration missing")
    png = bytes(int(token, 16) for token in re.findall(rb"0x([0-9A-Fa-f]{2})", array[1]))
    text = re.search(rb'pub const PRV_TEXT: &\[u8\] = b"(.*?)";', source)
    require(text is not None and text[1] == rb"\r\n", "unexpected upstream PRV_TEXT literal")
    expected = [png, b"\r\n", (upstream / ASSETS[2][1]).read_bytes()]
    for (_, source_path), actual, golden in zip(ASSETS, expected, decoded, strict=True):
        require(actual == golden, f"{source_path}: upstream asset bytes mismatch")
    return {"goldenHashes": "PASS", "pinnedUpstream": "PASS", "revision": revision}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.upstream)
    except (VerificationError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"verification failed: {error}\n")
    print(json.dumps(result))
