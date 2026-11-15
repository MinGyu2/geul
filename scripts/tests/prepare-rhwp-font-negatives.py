#!/usr/bin/env python3
"""Build two bounded negative originals from the controlled native font fixtures.
HWP: one opaque FACE_NAME flag, preserved on no-op but outside font mutation proof.
HWPX: one unknown namespaced header attribute, refused by original preflight.
No font files or generated document artifacts are tracked.
"""
import argparse
import json
from pathlib import Path
import struct
import xml.etree.ElementTree as ET
import zipfile
import zlib


def opaque_face(source, destination):
    data = bytearray(source.read_bytes())
    u32 = lambda at: struct.unpack_from('<I', data, at)[0]
    size = 1 << struct.unpack_from('<H', data, 30)[0]
    assert size in (512, 4096) and u32(44) <= 109
    sector = lambda n: data[(n + 1) * size:(n + 2) * size]
    fat = [n for i in struct.unpack_from('<109I', data, 76)[:u32(44)] for n in struct.unpack('<' + 'I' * (size // 4), sector(i))]

    def ids(start, table):
        found = []
        while start != 0xfffffffe:
            assert start < len(table) and start not in found and len(found) < 20_000
            found.append(start); start = table[start]
        return found

    dirs = ids(u32(48), fat)
    directory = b''.join(sector(i) for i in dirs)
    entries = []
    for at in range(0, len(directory), 128):
        row = directory[at:at + 128]
        if row[66] == 0:
            continue
        length = struct.unpack_from('<H', row, 64)[0]
        entries.append((row[:length - 2].decode('utf-16le'), row[66], struct.unpack_from('<I', row, 116)[0],
                        struct.unpack_from('<Q', row, 120)[0], (dirs[at // size] + 1) * size + at % size))
    root = next(e for e in entries if e[1] == 5)
    root_ids = ids(root[2], fat)
    mini = b''.join(sector(i) for i in root_ids)[:root[3]]
    raw_mini_fat = b''.join(sector(i) for i in ids(u32(60), fat))
    mini_fat = struct.unpack('<' + 'I' * (len(raw_mini_fat) // 4), raw_mini_fat)
    entry = next(e for e in entries if e[0] == 'DocInfo')
    small = entry[3] < u32(56)
    chain = ids(entry[2], mini_fat if small else fat)
    payload = (b''.join(mini[n * 64:(n + 1) * 64] for n in chain) if small else b''.join(sector(i) for i in chain))[:entry[3]]
    raw = bytearray(zlib.decompress(payload, -15))
    at = 0
    while at < len(raw):
        header = struct.unpack_from('<I', raw, at)[0]; at += 4
        count = header >> 20
        if count == 4095:
            count = struct.unpack_from('<I', raw, at)[0]; at += 4
        if header & 1023 == 19:
            assert raw[at] & 4 == 0
            raw[at] |= 4
            break
        at += count
    else:
        raise AssertionError('no FACE_NAME')
    compressor = zlib.compressobj(wbits=-15)
    modified = compressor.compress(raw) + compressor.flush()
    unit = 64 if small else size
    assert len(modified) <= len(chain) * unit, 'mutation does not fit existing allocation'
    padded = modified.ljust(len(chain) * unit, b'\0')
    for index, n in enumerate(chain):
        offset = ((root_ids[(n * 64) // size] + 1) * size + (n * 64) % size) if small else (n + 1) * size
        data[offset:offset + unit] = padded[index * unit:(index + 1) * unit]
    struct.pack_into('<Q', data, entry[4] + 120, len(modified))
    destination.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fixtures', type=Path); parser.add_argument('out', type=Path)
    args = parser.parse_args(); args.out.mkdir(parents=True, exist_ok=False)
    opaque_face(args.fixtures / 'font.hwp', args.out / 'negative.hwp')
    with zipfile.ZipFile(args.fixtures / 'font.hwpx') as source, zipfile.ZipFile(args.out / 'negative.hwpx', 'w') as target:
        for info in source.infolist():
            payload = source.read(info.filename)
            if info.filename == 'Contents/header.xml':
                root = ET.fromstring(payload); root.set('{urn:geul-font-negative}opaque', 'preserve-me')
                payload = ET.tostring(root, encoding='utf-8', xml_declaration=True)
            target.writestr(info, payload)
    (args.out / 'policy.json').write_text(json.dumps({'hwp': 'opaque FACE_NAME flag 0x04', 'hwpx': 'unknown header attribute'}, indent=2))


if __name__ == '__main__':
    main()
