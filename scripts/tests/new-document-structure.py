#!/usr/bin/env python3
"""Independent bounded CFB/record + ZIP/Expat blank-creation oracle (no RHWP).

This audits defaults, blank content and references, not external Hancom fidelity.
Fixtures are generated at runtime; no third-party document bytes are committed.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
import zlib


def cfb_streams(data):
    assert len(data) <= 65536 and data[:8] == bytes.fromhex('d0cf11e0a1b11ae1')
    word = lambda at: struct.unpack_from('<I', data, at)[0]
    size = 1 << struct.unpack_from('<H', data, 30)[0]
    assert size in (512, 4096)
    sector = lambda n: data[(n + 1) * size:(n + 2) * size]
    difat = struct.unpack_from('<109I', data, 76)
    assert word(72) == 0  # no DIFAT extension needed by these tiny documents
    fat = []
    for n in difat:
        if n < 0xfffffffa:
            fat.extend(struct.unpack('<' + str(size // 4) + 'I', sector(n)))

    def chain(n, table):
        result = []
        while n < 0xfffffffa:
            assert n < len(table) and n not in result and len(result) < 128
            result.append(n)
            n = table[n]
        return result

    read = lambda n: b''.join(sector(i) for i in chain(n, fat))
    directory = read(word(48))
    entries = []
    for at in range(0, len(directory), 128):
        e = directory[at:at + 128]
        length = struct.unpack_from('<H', e, 64)[0]
        name = e[:max(0, length - 2)].decode('utf-16le')
        entries.append((name, e[66], *struct.unpack_from('<III', e, 68),
                        struct.unpack_from('<I', e, 116)[0], struct.unpack_from('<Q', e, 120)[0]))
    mini = read(entries[0][5])
    mini_bytes = read(word(60))
    mini_fat = struct.unpack('<' + str(len(mini_bytes) // 4) + 'I', mini_bytes)
    assert struct.unpack_from('<H', data, 32)[0] == 6
    result, visited = {}, set()

    def walk(index, parent):
        if index >= 0xfffffffa:
            return
        assert index < len(entries) and index not in visited
        visited.add(index)
        name, kind, left, right, child, start, length = entries[index]
        walk(left, parent)
        path = parent + name
        if kind == 1:
            walk(child, path + '/')
        elif kind == 2:
            assert length < 65536 and path not in result
            body = (b''.join(mini[i * 64:(i + 1) * 64] for i in chain(start, mini_fat))
                    if length < 4096 else read(start))[:length]
            assert len(body) == length
            result[path] = body
        else:
            raise AssertionError('unexpected directory entry')
        walk(right, parent)

    walk(entries[0][4], '')
    return result


def records(data):
    result, at = [], 0
    while at < len(data):
        head, = struct.unpack_from('<I', data, at)
        at += 4
        length = head >> 20
        if length == 4095:
            length, = struct.unpack_from('<I', data, at)
            at += 4
        assert at + length <= len(data)
        result.append((head & 1023, (head >> 10) & 1023, data[at:at + length]))
        at += length
    return result


def hwp(data):
    parts = cfb_streams(data)
    assert set(parts) == {'FileHeader', 'DocInfo', 'BodyText/Section0', 'PrvText', 'PrvImage', 'RhwpHwpxOrigin'}
    header = parts['FileHeader']
    assert len(header) == 256 and header.startswith(b'HWP Document File') and header[35] == 5
    flags, = struct.unpack_from('<I', header, 36)
    assert flags in (0, 1)

    def unpack(data):
        if not flags & 1:
            return data
        d = zlib.decompressobj(-15)
        out = d.decompress(data, 65537)
        assert d.eof and not d.unused_data and not d.unconsumed_tail and len(out) <= 65536
        return out

    info, section = records(unpack(parts['DocInfo'])), records(unpack(parts['BodyText/Section0']))
    counts = Counter(tag for tag, _, _ in info)
    assert counts[19] == 7 and counts[21] == counts[22] == counts[25] == counts[26] == 1
    assert counts[16] == counts[17] == 1
    assert struct.unpack_from('<H', next(b for tag, _, b in info if tag == 16))[0] == 1
    for tag, _, body in info:
        if tag == 19:
            length, = struct.unpack_from('<H', body, 1)
            assert body[3:3 + length * 2].decode('utf-16le') == 'Noto Sans CJK KR'
        if tag == 21:
            assert struct.unpack_from('<7H', body) == (0,) * 7
    assert Counter(tag for tag, _, _ in section)[66] == 1
    assert Counter(tag for tag, _, _ in section)[67] == 1
    assert Counter(tag for tag, _, _ in section)[69] == 1
    for tag, _, body in section:
        if tag == 66:
            assert struct.unpack_from('<H', body, 8)[0] == 0 and body[10] == 0
            assert struct.unpack_from('<H', body, 16)[0] == 1
        if tag == 69:
            assert struct.unpack('<IiiiiiiiI', body) == (0, 0, 1000, 1000, 850, 600, 0, 42520, 0x80060000)
        if tag == 68:
            assert len(body) % 8 == 0 and len(body) > 0
            for at in range(0, len(body), 8):
                assert struct.unpack_from('<I', body, at + 4)[0] == 0
        if tag == 67:
            units = struct.unpack('<' + str(len(body) // 2) + 'H', body)
            at = 0
            controls = []
            while at < len(units):
                if units[at] == 2:
                    controls.append(body[at * 2 + 2:at * 2 + 6])
                    at += 8
                else:
                    assert units[at] == 13
                    at += 1
            assert sorted(controls) == sorted([b'dces', b'dloc'])
    assert parts['PrvText'] in (b'', b'\r\0\n\0')
    return {'streams': sorted(parts), 'docInfoTags': dict(counts), 'paragraphs': 1}


def hwpx(path):
    ns = {p: 'http://www.hancom.co.kr/hwpml/2011/' + n
          for p, n in [('hh', 'head'), ('hp', 'paragraph'), ('hs', 'section')]}
    ns['opf'] = 'http://www.idpf.org/2007/opf/'
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None and len(z.infolist()) == 12
        assert sum(i.file_size for i in z.infolist()) < 65536
        assert z.infolist()[0].filename == 'mimetype' and z.infolist()[0].compress_type == 0
        assert z.read('mimetype') == b'application/hwp+zip'
        xml = {}
        for item in z.infolist():
            if item.filename.endswith(('.xml', '.hpf', '.rdf')):
                body = z.read(item.filename)
                assert b'<!DOCTYPE' not in body
                xml[item.filename] = ET.fromstring(body)
        header, section = xml['Contents/header.xml'], xml['Contents/section0.xml']
        assert header.get('secCnt') == '1'
        paras = section.findall('hp:p', ns)
        assert len(paras) == 1
        assert not ''.join(e.text or '' for e in section.iter('{' + ns['hp'] + '}t'))
        assert len(section.findall('.//hp:secPr', ns)) == len(section.findall('.//hp:colPr', ns)) == 1
        assert not section.findall('.//hp:tbl', ns) and not section.findall('.//hp:pic', ns)
        for group, tag in [('charProperties', 'charPr'), ('paraProperties', 'paraPr'), ('styles', 'style'), ('tabProperties', 'tabPr')]:
            nodes = header.findall(f'.//hh:{group}/hh:{tag}', ns)
            assert len(nodes) == 1 and nodes[0].get('id') == '0', group
        fonts = header.findall('.//hh:fontface', ns)
        assert len(fonts) == 7
        for face in fonts:
            assert face.get('fontCnt') == '1'
            font = face.find('hh:font', ns)
            assert font.get('id') == '0' and font.get('face') == 'Noto Sans CJK KR' and font.get('isEmbedded') == '0'
        for e in section.iter():
            for key in ['paraPrIDRef', 'charPrIDRef', 'styleIDRef']:
                if key in e.attrib:
                    assert e.attrib[key] == '0'
        manifest = xml['Contents/content.hpf']
        items = manifest.findall('.//opf:item', ns)
        ids = {item.get('id') for item in items}
        for item in items:
            assert item.get('href') in z.namelist()
        for item in manifest.findall('.//opf:itemref', ns):
            assert item.get('idref') in ids
        creator = manifest.find('.//opf:meta[@name="creator"]', ns)
        assert creator.text == 'rhwp'
        assert z.read('Preview/PrvText.txt') in (b'', b'\r\n')
        return {'parts': z.namelist(), 'fonts': 7, 'paragraphs': 1, 'creator': 'rhwp'}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: new-document-structure.py <run-dir>  (writes a new structure.json; never replaces one)')
    root = Path(sys.argv[1])
    output = root / 'structure.json'
    if output.exists():
        raise SystemExit(f'refusing to replace existing {output}; use a new run directory')
    result = {'hwp': hwp((root / 'prepared.hwp').read_bytes()), 'hwpx': hwpx(root / 'prepared.hwpx')}
    for fmt in ('hwp', 'hwpx'):
        data = (root / ('prepared.' + fmt)).read_bytes()
        result[fmt]['sha256'] = hashlib.sha256(data).hexdigest()
    negative = []

    def rejects(name, call):
        try:
            call()
        except (AssertionError, ValueError, struct.error, KeyError, zipfile.BadZipFile, ET.ParseError):
            negative.append(name)
        else:
            raise AssertionError('oracle accepted ' + name)

    raw = (root / 'prepared.hwp').read_bytes()
    rejects('truncated CFB', lambda: hwp(raw[:512]))
    bad = bytearray(raw)
    bad[bad.index(b'HWP Document File') + 35] = 0
    rejects('invalid HWP version', lambda: hwp(bad))
    with tempfile.TemporaryDirectory() as folder:  # negative controls stay outside the run directory
        for label, transform in [
            ('missing header', lambda n, b: None if n == 'Contents/header.xml' else b),
            ('unregistered character reference', lambda n, b: b.replace(b'charPrIDRef="0"', b'charPrIDRef="9"') if n == 'Contents/section0.xml' else b),
            ('nonblank text', lambda n, b: b.replace(b'</hp:t>', '내용</hp:t>'.encode()) if n == 'Contents/section0.xml' else b),
            ('invalid font default', lambda n, b: b.replace(b'face="Noto Sans CJK KR"', b'face="Other"') if n == 'Contents/header.xml' else b),
        ]:
            path = Path(folder) / 'negative.hwpx'
            with zipfile.ZipFile(root / 'prepared.hwpx') as before, zipfile.ZipFile(path, 'w') as after:
                for item in before.infolist():
                    data = transform(item.filename, before.read(item.filename))
                    if data is not None:
                        after.writestr(item, data)
            rejects(label, lambda: hwpx(path))
    result['negativeControls'] = negative
    with output.open('x') as handle:
        handle.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
