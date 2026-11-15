#!/usr/bin/env python3
"""Independent binary/XML/PDF inspection. Standard library only, no geul/RHWP code.
Controlled native fixtures only: bounded CFB FAT/minifat, HWP records, HWPX XML,
and the app's Flate/8-bit DeviceRGB PDF images. Unsupported encodings fail.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import xml.etree.ElementTree as ET
import zipfile
import zlib

TEXT = '한글 Font editing ABC 0123'
LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER']
ATTRS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user']
HH, HP = '{http://www.hancom.co.kr/hwpml/2011/head}', '{http://www.hancom.co.kr/hwpml/2011/paragraph}'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def cfb(path):
    data = path.read_bytes()
    assert data[:8] == bytes.fromhex('d0cf11e0a1b11ae1') and len(data) < 8 << 20
    u32 = lambda b, at: struct.unpack_from('<I', b, at)[0]
    size = 1 << struct.unpack_from('<H', data, 30)[0]
    assert size in (512, 4096)
    sector = lambda n: data[(n + 1) * size:(n + 2) * size]
    fat_count = u32(data, 44)
    assert fat_count <= 109, 'large DIFAT outside controlled fixture envelope'
    ids = struct.unpack_from('<109I', data, 76)[:fat_count]
    fat = [n for i in ids for n in struct.unpack('<' + 'I' * (size // 4), sector(i))]

    def chain(start, table, get):
        out, seen = bytearray(), set()
        while start != 0xfffffffe:
            assert start < len(table) and start not in seen and len(seen) < 20_000
            seen.add(start); out.extend(get(start)); start = table[start]
        return bytes(out)

    entries = []
    raw = chain(u32(data, 48), fat, sector)
    for at in range(0, len(raw), 128):
        row = raw[at:at + 128]
        if len(row) != 128 or row[66] == 0:
            continue
        n = struct.unpack_from('<H', row, 64)[0]
        name = row[:n - 2].decode('utf-16le')
        entries.append((name, row[66], u32(row, 116), struct.unpack_from('<Q', row, 120)[0]))
    root = next(e for e in entries if e[1] == 5)
    mini = chain(root[2], fat, sector)[:root[3]]
    mini_raw = chain(u32(data, 60), fat, sector) if u32(data, 64) else b''
    minifat = struct.unpack('<' + 'I' * (len(mini_raw) // 4), mini_raw)
    streams = {}
    for name, kind, start, length in entries:
        if kind != 2:
            continue
        streams[name] = (chain(start, minifat, lambda n: mini[n * 64:(n + 1) * 64])
                         if length < u32(data, 56) else chain(start, fat, sector))[:length]
    return streams


def records(data):
    rows, at = [], 0
    while at < len(data):
        header = struct.unpack_from('<I', data, at)[0]; at += 4
        size = header >> 20
        if size == 4095:
            size = struct.unpack_from('<I', data, at)[0]; at += 4
        assert at + size <= len(data)
        rows.append((header & 1023, (header >> 10) & 1023, data[at:at + size])); at += size
    assert at == len(data)
    return rows


def hwp(path, family):
    streams = cfb(path)
    compressed = struct.unpack_from('<I', streams['FileHeader'], 36)[0] & 1
    unpack = lambda b: zlib.decompress(b, -15) if compressed else b
    info = records(unpack(streams['DocInfo']))
    mapping = [row[2] for row in info if row[0] == 17]
    assert len(mapping) == 1 and len(mapping[0]) >= 40
    counts = struct.unpack_from('<7I', mapping[0], 4)
    faces = [row[2] for row in info if row[0] == 19]
    assert sum(counts) == len(faces)
    fonts, pos = [], 0
    for count in counts:
        slot = faces[pos:pos + count]; pos += count
        fonts.append(slot)
    names = [[raw[3:3 + struct.unpack_from('<H', raw, 1)[0] * 2].decode('utf-16le') for raw in slot] for slot in fonts]
    shapes = [row[2] for row in info if row[0] == 21]
    assert len(shapes) == struct.unpack_from('<I', mapping[0], 36)[0]
    ids = [struct.unpack_from('<7H', shape, 0) for shape in shapes]
    for refs in ids:
        assert all(refs[l] < counts[l] for l in range(7))
    body = records(unpack(streams['Section0']))
    expected = TEXT.encode('utf-16le')
    text_row = next(i for i, row in enumerate(body) if row[0] == 67 and expected in row[2])
    start = body[text_row][2].index(expected) // 2
    runs = next(row[2] for row in body[text_row + 1:] if row[0] == 68)
    pairs = list(struct.iter_unpack('<II', runs))
    active = next((shape for (at, shape), end in zip(pairs, [p[0] for p in pairs[1:]] + [0xffffffff])
                   if at <= start and end >= start + len(expected) // 2), None)
    assert active is not None and all(names[l][ids[active][l]] == family for l in range(7))
    return {'fonts': fonts, 'shapes': shapes, 'mapping': mapping[0], 'info': info, 'activeIds': ids[active]}


def hwpx(path, family):
    with zipfile.ZipFile(path) as z:
        head = ET.fromstring(z.read('Contents/header.xml'))
        body = ET.fromstring(z.read('Contents/section0.xml'))
    groups = head.find('.//' + HH + 'fontfaces')
    assert groups is not None and groups.attrib['itemCnt'] == '7' and len(groups) == 7
    fonts, names = [], []
    for lang, group in enumerate(groups):
        assert group.tag == HH + 'fontface' and group.attrib['lang'] == LANGS[lang]
        assert int(group.attrib['fontCnt']) == len(group)
        assert [int(f.attrib['id']) for f in group] == list(range(len(group)))
        fonts.append([ET.tostring(f) for f in group]); names.append([f.attrib['face'] for f in group])
    props = head.find('.//' + HH + 'charProperties')
    assert props is not None and int(props.attrib['itemCnt']) == len(props)
    assert [int(p.attrib['id']) for p in props] == list(range(len(props)))
    shapes = {p.attrib['id']: p for p in props}
    found = False
    text = ''
    for run in body.iter(HP + 'run'):
        text += ''.join(t.text or '' for t in run.iter(HP + 't'))
        if not any(t.text for t in run.iter(HP + 't')):
            continue
        ref = shapes[run.attrib['charPrIDRef']].find(HH + 'fontRef')
        assert ref is not None and all(names[l][int(ref.attrib[a])] == family for l, a in enumerate(ATTRS))
        found = True
    assert found and text == TEXT
    return {'fonts': fonts, 'shapes': [ET.tostring(p) for p in props]}


def pdf_image(path):
    data = path.read_bytes()
    assert data.startswith(b'%PDF-') and len(data) < 20 << 20
    images = []
    for match in re.finditer(rb'\d+ 0 obj\s*<<(.*?)>>\s*stream\r?\n', data, re.S):
        head = match[1]
        if b'/Subtype/Image' not in head or b'/DeviceRGB' not in head:
            continue
        assert b'/Filter/FlateDecode' in head and b'/BitsPerComponent 8' in head and b'/DecodeParms' not in head
        number = lambda key: int(re.search(rb'/' + key + rb' (\d+)', head)[1])
        w, h, size = number(b'Width'), number(b'Height'), number(b'Length')
        assert w * h <= 16 * 1024 * 1024
        pixels = zlib.decompress(data[match.end():match.end() + size])
        assert len(pixels) == w * h * 3
        images.append((w, h, pixels))
    assert len(images) == 1, 'controlled fixture must produce one RGB page image'
    w, h, pixels = images[0]
    ink = [i // 3 for i in range(0, len(pixels), 3) if min(pixels[i:i + 3]) < 220]
    assert ink
    box = [min(i % w for i in ink), min(i // w for i in ink), max(i % w for i in ink), max(i // w for i in ink)]
    assert 10 < box[0] < box[2] < w - 10 and 10 < box[1] < box[3] < h - 10
    assert box[3] - box[1] < 100, 'unexpected line overlap or extra content'
    return (w, h, pixels), {'sha256': digest(data), 'width': w, 'height': h, 'inkPixels': len(ink), 'inkBounds': box}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path); parser.add_argument('fixtures', type=Path)
    args = parser.parse_args(); result = json.loads((args.out / 'result.json').read_text())
    assert result['status'] == 'PASS'
    results = []
    for fmt, inspect in [('hwp', hwp), ('hwpx', hwpx)]:
        old = inspect(args.fixtures / ('font.' + fmt), 'NanumGothic')
        new = inspect(args.out / 'docs' / ('font.' + fmt), 'GeulMono Test1')
        for a, b in zip(old['fonts'], new['fonts']):
            assert b[:len(a)] == a and len(b) == len(a) + 1
        assert new['shapes'][:len(old['shapes'])] == old['shapes']
        if fmt == 'hwp':
            assert len(old['mapping']) == len(new['mapping'])
            assert all(a == b for i, (a, b) in enumerate(zip(old['mapping'], new['mapping'])) if i not in range(4, 32) and i not in range(36, 40))
            keep = lambda info: [r for r in info if r[0] not in (17, 19, 21)]
            assert keep(old['info']) == keep(new['info'])
        baseline, before = pdf_image(args.out / 'pdf' / (fmt + '-before.pdf'))
        modified, after = pdf_image(args.out / 'pdf' / (fmt + '-user.pdf'))
        assert baseline[:2] == modified[:2]
        changed = sum(a != b for a, b in zip(baseline[2], modified[2]))
        assert changed > 100, 'PDF text pixels did not change'
        results.append({'format': fmt, 'storedFamily': 'GeulMono Test1', 'languageSlots': 7, 'originalDefinitionsPreserved': True,
                        'pdfBefore': before, 'pdfAfter': after, 'changedChannels': changed})
    (args.out / 'independent.json').write_text(json.dumps({'status': 'PASS', 'results': results}, indent=2))
    print(json.dumps({'status': 'PASS', 'formats': 2}))


if __name__ == '__main__':
    main()
