#!/usr/bin/env python3
"""Prepare deterministic HWP/HWPX footer-picture fixtures for P5-R-FTR."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
HWP_SOURCE = ROOT / "external/rhwp/samples/pic-in-head-02.hwp"
HWPX_SOURCE = ROOT / "external/rhwp/samples/issue6179/right_tab_footer_logo.hwpx"
HWP_SHA256 = "c9e7d8e42550f13f86f149f9edb2a40918c09cce4dbd2d8155dd0b9511ea237b"
HWPX_SHA256 = "7e9bb96a5c1c62b09ec7446afa01b16f38bef22a5c8354af2b7fd46b31821ca4"
HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
RHWP_BLANK_PREVIEW_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
    "0000000b49444154789c6364600000000500016f6867bc0000000049454e44ae426082"
)
RHWP_BLANK_PREVIEW_TEXT = b"\r\n"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def footer_pictures(section: bytes) -> list[dict[str, str]]:
    root = ET.fromstring(section)
    owners = list(root.iter(HP + "footer"))
    pictures = [node for owner in owners for node in owner.iter(HP + "pic")]
    if len(owners) != 1 or len(pictures) != 2:
        raise ValueError("pinned HWPX source must have one exact footer owning two pictures")
    output = []
    for picture in pictures:
        image = picture.find(".//{http://www.hancom.co.kr/hwpml/2011/core}img")
        size = picture.find(HP + "sz")
        pos = picture.find(HP + "pos")
        if image is None or size is None or pos is None or pos.get("treatAsChar") != "1":
            raise ValueError("authentic footer picture is missing inline image or size metadata")
        output.append({"id": picture.get("id", ""), "instid": picture.get("instid", ""),
                       "binaryItemIDRef": image.get("binaryItemIDRef", "")})
    return output


def build_hwpx(source: Path) -> bytes:
    source_bytes = source.read_bytes()
    if sha256(source_bytes) != HWPX_SHA256:
        raise ValueError("pinned HWPX source hash changed; refusing to reconstruct fixture")
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        entries = [(info, archive.read(info.filename)) for info in infos]
        comment = archive.comment
    found_section = False
    previews = set()
    updated = []
    for info, data in entries:
        if info.filename == "Contents/section0.xml":
            footer_pictures(data)
            found_section = True
        elif info.filename == "Preview/PrvImage.png":
            data = RHWP_BLANK_PREVIEW_PNG
            previews.add(info.filename)
        elif info.filename == "Preview/PrvText.txt":
            data = RHWP_BLANK_PREVIEW_TEXT
            previews.add(info.filename)
        updated.append((info, data))
    if not found_section:
        raise ValueError("pinned HWPX section part is missing")
    if previews != {"Preview/PrvImage.png", "Preview/PrvText.txt"}:
        raise ValueError(f"pinned HWPX preview parts changed: {sorted(previews)}")

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
    atomic_create(output / "footer-original.hwp", hwp_bytes)
    atomic_create(output / "footer-original.hwpx", hwpx_bytes)
    with zipfile.ZipFile(HWPX_SOURCE) as source_archive:
        pictures = footer_pictures(source_archive.read("Contents/section0.xml"))
    provenance = {
        "sourceHwp": str(HWP_SOURCE.relative_to(ROOT)),
        "sourceHwpSha256": HWP_SHA256,
        "fixtureHwpSha256": sha256(hwp_bytes),
        "sourceHwpx": str(HWPX_SOURCE.relative_to(ROOT)),
        "sourceHwpxSha256": HWPX_SHA256,
        "fixtureHwpxSha256": sha256(hwpx_bytes),
        "fixturePreparation": "Copy the pinned HWP source unchanged. For HWPX, preserve every OPC entry and its original ZIP metadata, replacing only PrvImage and PrvText with the pinned RHWP blank sentinels so a later picture resize cannot carry a stale preview. The HWP source has an exact CTRL_HEADER foot owner with two inline pictures and no header/footer non-picture objects. The HWPX source has one footer owner with two inline picture objects.",
        "footerPictures": pictures,
        "previewParts": {
            "Preview/PrvImage.png": {"length": len(RHWP_BLANK_PREVIEW_PNG), "sha256": sha256(RHWP_BLANK_PREVIEW_PNG)},
            "Preview/PrvText.txt": {"length": len(RHWP_BLANK_PREVIEW_TEXT), "sha256": sha256(RHWP_BLANK_PREVIEW_TEXT)},
        },
    }
    atomic_create(output / "footer-fixture-provenance.json", (json.dumps(provenance, indent=2) + "\n").encode())
    print(json.dumps({"status": "PASS", "fixtures": str(output), **provenance}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
