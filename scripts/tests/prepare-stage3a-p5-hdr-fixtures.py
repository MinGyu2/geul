#!/usr/bin/env python3
"""Prepare deterministic HWP/HWPX header-picture fixtures for P5-R-HDR Native acceptance."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import xml.parsers.expat
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HWP_SOURCE = ROOT / "external/rhwp/samples/pic-in-head-02.hwp"
HWPX_SOURCE = ROOT / "external/rhwp/samples/HWP5-nopassword-123456.hwpx"
HWP_SHA256 = "c9e7d8e42550f13f86f149f9edb2a40918c09cce4dbd2d8155dd0b9511ea237b"
HWPX_SHA256 = "20ed90f48c6501cad99f6aa1f82d81d2a2132eb04f2d1d32805ac251749e4d0e"
PICTURE_ID = b'1153060130'
# These are the pinned RHWP writer's exact content-free preview sentinels. The
# T009 HWPX checker accepts them unchanged when edited package content has no
# freshly rendered thumbnail; arbitrary nonblank/stale previews stay blocked.
RHWP_BLANK_PREVIEW_PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02'
    '0000000b49444154789c6364600000000500016f6867bc0000000049454e44ae426082'
)
RHWP_BLANK_PREVIEW_TEXT = b'\r\n'


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def root_paragraph_spans(section: bytes) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    starts: list[tuple[int, int | None]] = []
    stack: list[str] = []
    parser = xml.parsers.expat.ParserCreate(namespace_separator="}")

    def on_start(name, _attrs):
        if len(stack) == 1 and name.endswith("}p"):
            start = parser.CurrentByteIndex
            open_end = section.find(b">", start) + 1
            self_closing = section[start:open_end].rstrip().endswith(b"/>")
            starts.append((start, open_end if self_closing else None))
        stack.append(name)

    def on_end(name):
        if len(stack) == 2 and stack[-1] == name and name.endswith("}p"):
            start, self_closing_end = starts.pop()
            if self_closing_end is not None:
                end = self_closing_end
            else:
                end = section.find(b">", parser.CurrentByteIndex) + 1
                if end <= 0:
                    raise ValueError("unterminated root paragraph")
            spans.append((start, end))
        stack.pop()

    parser.StartElementHandler = on_start
    parser.EndElementHandler = on_end
    parser.Parse(section, True)
    spans.sort()
    return spans


def minimal_header_section(section: bytes) -> tuple[bytes, int]:
    spans = root_paragraph_spans(section)
    if len(spans) != 365:
        raise ValueError(f"pinned header sample root paragraph count changed: {len(spans)}")
    # Keep the original section-properties paragraph and its authentic header owner paragraph.
    for start, end in reversed(spans[2:]):
        section = section[:start] + section[end:]

    picture_start = section.find(b"<hp:pic id=\"" + PICTURE_ID + b"\"")
    if picture_start < 0:
        raise ValueError("pinned header picture identity is missing")
    picture_end = section.find(b"</hp:pic>", picture_start)
    if picture_end < 0:
        raise ValueError("pinned header picture is unterminated")
    picture_end += len(b"</hp:pic>")
    picture = section[picture_start:picture_end]

    img_start = picture.find(b"<hc:img ")
    img_end = picture.find(b"/>", img_start) + 2 if img_start >= 0 else -1
    img_dim_start = picture.find(b"<hp:imgDim ")
    img_dim_end = picture.find(b"/>", img_dim_start) + 2 if img_dim_start >= 0 else -1
    if img_start < 0 or img_end <= img_start or img_dim_start < 0 or img_dim_end <= img_dim_start:
        raise ValueError("pinned header picture resource metadata is not in the expected form")
    img = picture[img_start:img_end]
    if b'binaryItemIDRef="image2"' not in img:
        raise ValueError("pinned header picture resource identity changed")
    if img_start < img_dim_start:
        picture = picture[:img_start] + picture[img_end:]
        img_dim_start = picture.find(b"<hp:imgDim ")
        img_dim_end = picture.find(b"/>", img_dim_start) + 2
        picture = picture[:img_dim_end] + img + picture[img_dim_end:]
    section = section[:picture_start] + picture + section[picture_end:]

    if len(root_paragraph_spans(section)) != 2:
        raise ValueError("minimal header section did not retain exactly two root paragraphs")
    return section, 363


def build_hwpx(source: Path) -> bytes:
    source_bytes = source.read_bytes()
    if sha256(source_bytes) != HWPX_SHA256:
        raise ValueError("pinned HWPX source hash changed; refusing to reconstruct fixture")
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        entries = [(info, archive.read(info.filename)) for info in infos]
        comment = archive.comment
    found = False
    preview_parts = set()
    updated = []
    for info, data in entries:
        if info.filename == "Contents/section0.xml":
            data, _ = minimal_header_section(data)
            found = True
        elif info.filename == "Preview/PrvImage.png":
            data = RHWP_BLANK_PREVIEW_PNG
            preview_parts.add(info.filename)
        elif info.filename == "Preview/PrvText.txt":
            data = RHWP_BLANK_PREVIEW_TEXT
            preview_parts.add(info.filename)
        updated.append((info, data))
    if not found:
        raise ValueError("pinned HWPX section part is missing")
    if preview_parts != {"Preview/PrvImage.png", "Preview/PrvText.txt"}:
        raise ValueError(f"pinned HWPX preview parts changed: {sorted(preview_parts)}")

    with tempfile.NamedTemporaryFile(dir=ROOT / "target", suffix=".hwpx.tmp", delete=False) as stream:
        temporary = Path(stream.name)
    try:
        with zipfile.ZipFile(temporary, "w") as result:
            result.comment = comment
            for info, data in updated:
                result.writestr(info, data)
        return temporary.read_bytes()
    finally:
        temporary.unlink(missing_ok=True)


def atomic_create(path: Path, data: bytes):
    if path.exists() or path.is_symlink():
        if path.is_file() and not path.is_symlink() and path.read_bytes() == data:
            return
        raise FileExistsError(f"refusing to replace existing fixture or non-file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="new or already generated fixture directory")
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)

    hwp_bytes = HWP_SOURCE.read_bytes()
    if sha256(hwp_bytes) != HWP_SHA256:
        raise ValueError("pinned HWP source hash changed; refusing to reconstruct fixture")
    hwpx_bytes = build_hwpx(HWPX_SOURCE)
    atomic_create(output / "header-original.hwp", hwp_bytes)
    atomic_create(output / "header-original.hwpx", hwpx_bytes)

    provenance = {
        "sourceHwp": str(HWP_SOURCE.relative_to(ROOT)),
        "sourceHwpSha256": HWP_SHA256,
        "fixtureHwpSha256": sha256(hwp_bytes),
        "sourceHwpx": str(HWPX_SOURCE.relative_to(ROOT)),
        "sourceHwpxSha256": HWPX_SHA256,
        "fixtureHwpxSha256": sha256(hwpx_bytes),
        "fixturePreparation": "Retain the original HWPX section properties and authentic header-owner paragraph; remove later body paragraphs and move the owned hc:img child after hp:imgDim to match the pinned RHWP writer order. Replace both nonblank previews with the exact pinned RHWP content-free sentinels so the fixture does not carry a stale source thumbnail; preserve all other package entries and bytes.",
        "previewParts": {
            "Preview/PrvImage.png": {"length": len(RHWP_BLANK_PREVIEW_PNG), "sha256": sha256(RHWP_BLANK_PREVIEW_PNG)},
            "Preview/PrvText.txt": {"length": len(RHWP_BLANK_PREVIEW_TEXT), "sha256": sha256(RHWP_BLANK_PREVIEW_TEXT)},
        },
    }
    atomic_create(output / "header-fixture-provenance.json", (json.dumps(provenance, indent=2) + "\n").encode())
    print(json.dumps({"status": "PASS", "fixtures": str(output), **provenance}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
