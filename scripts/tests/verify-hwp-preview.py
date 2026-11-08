#!/usr/bin/env python3
"""Independent verification of regenerated HWP previews (2026-11-08).

Pure standard library; shares no code with geul or RHWP. For each published HWP:
CFB streams, Section0 PAGE_DEF, the PrvImage PNG (strict decode, Hancom size rule),
PrvText, absence of the original preview bytes, preservation of unrelated streams,
and visual agreement with a separately rendered reference (the editor's page-1 canvas
of the reopened file, captured by native-hwp-preview.py).

usage: verify-hwp-preview.py ORIGINAL.hwp RUN_DIR [--out result.json]
RUN_DIR holds first-save.hwp, second-save.hwp, first-reopen-display.png, final-reopen-display.png.
"""
import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

u16 = lambda b, o=0: struct.unpack_from('<H', b, o)[0]
u32 = lambda b, o=0: struct.unpack_from('<I', b, o)[0]


def cfb_streams(data):
    assert data[:8] == bytes.fromhex('d0cf11e0a1b11ae1'), 'not CFB'
    sector, mini = 1 << u16(data, 30), 1 << u16(data, 32)
    sec = lambda i: data[(i + 1) * sector:(i + 2) * sector]
    difat = list(struct.unpack_from('<109I', data, 76)); nxt = u32(data, 68)
    for _ in range(u32(data, 72)):
        values = struct.unpack('<' + 'I' * (sector // 4), sec(nxt)); difat.extend(values[:-1]); nxt = values[-1]
    fat = []
    for i in difat:
        if i < 0xfffffffa:
            fat.extend(struct.unpack('<' + 'I' * (sector // 4), sec(i)))

    def chain(first, table, reader):
        out, seen, i = [], set(), first
        while i < 0xfffffffa:
            assert i not in seen, 'sector loop'; seen.add(i); out.append(reader(i)); i = table[i]
        return b''.join(out)
    directory = chain(u32(data, 48), fat, sec); entries = []
    for off in range(0, len(directory), 128):
        item = directory[off:off + 128]; n = u16(item, 64)
        if n:
            entries.append((item[:n - 2].decode('utf-16le'), item[66], u32(item, 116), struct.unpack_from('<Q', item, 120)[0]))
    root = next(e for e in entries if e[1] == 5)
    mini_data = chain(root[2], fat, sec)[:root[3]] if root[3] else b''
    mf = chain(u32(data, 60), fat, sec) if u32(data, 60) < 0xfffffffa else b''
    mf = struct.unpack('<' + 'I' * (len(mf) // 4), mf)
    cutoff = u32(data, 56)
    return {name: (chain(first, mf, lambda i: mini_data[i * mini:(i + 1) * mini]) if size < cutoff else chain(first, fat, sec))[:size]
            for name, kind, first, size in entries if kind == 2}


def records(d):
    out, o = [], 0
    while o < len(d):
        h = u32(d, o); o += 4; size = h >> 20
        if size == 0xfff:
            size = u32(d, o); o += 4
        out.append((h & 0x3ff, (h >> 10) & 0x3ff, d[o:o + size])); o += size
    assert o == len(d), 'record overrun'
    return out


def section0(streams):
    compressed = u32(streams['FileHeader'], 36) & 1
    raw = streams['Section0']
    return records(zlib.decompress(raw, -15) if compressed else raw)


def expected_size(recs):
    body = next(b for t, _, b in recs if t == 73)
    w, h, landscape = u32(body, 0), u32(body, 4), u32(body, 36) & 1
    if landscape:
        w, h = h, w
    major, minor = max(w, h), min(w, h)
    short = max(1, (2 * 1024 * minor + major) // (2 * major))
    return (1024, short) if w >= h else (short, 1024)


def png_decode(data, strict):
    """Decode 8-bit RGB/RGBA PNG (all filters). strict: only IHDR/IDAT/IEND, RGB, filter 0 rows."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'PNG signature'
    o, chunks = 8, []
    while o < len(data):
        n = struct.unpack_from('>I', data, o)[0]; kind = data[o + 4:o + 8]; body = data[o + 8:o + 8 + n]
        assert struct.unpack_from('>I', data, o + 8 + n)[0] == zlib.crc32(kind + body), 'chunk CRC'
        chunks.append((kind, body)); o += 12 + n
    assert o == len(data), 'trailing bytes'
    kinds = [k for k, _ in chunks]
    w, h, depth, color, comp, filt, inter = struct.unpack('>IIBBBBB', chunks[0][1])
    assert kinds[0] == b'IHDR' and kinds[-1] == b'IEND' and depth == 8 and inter == 0 and color in (2, 6)
    if strict:
        assert kinds == [b'IHDR', b'IDAT', b'IEND'] and color == 2, kinds
    z = zlib.decompressobj(); raw = z.decompress(b''.join(b for k, b in chunks if k == b'IDAT'))
    assert z.eof and not z.unused_data, 'zlib stream'
    bpp = 3 if color == 2 else 4; stride = w * bpp
    assert len(raw) == (stride + 1) * h, 'scanline length'
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]; line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        assert not strict or f == 0, 'non-canonical filter'
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            else:
                assert f == 0, 'filter'
        rows.append(bytes(line)); prev = line
    rgb = bytearray()
    for line in rows:
        if bpp == 3:
            rgb += line
        else:
            for i in range(0, stride, 4):
                al = line[i + 3]
                rgb += bytes(round((line[i + c] * al + 255 * (255 - al)) / 255) for c in range(3))
    return w, h, bytes(rgb)


def gif_decode(data):
    """First frame of a GIF as RGB (global/local palette, LZW, interlace)."""
    assert data[:6] in (b'GIF87a', b'GIF89a')
    W, H, flags = u16(data, 6), u16(data, 8), data[10]; o = 13; gpal = None
    if flags & 0x80:
        n = 3 * (2 << (flags & 7)); gpal = data[o:o + n]; o += n
    while data[o] == 0x21:
        o += 2
        while data[o]:
            o += data[o] + 1
        o += 1
    assert data[o] == 0x2c; x0, y0, w, h, f = u16(data, o + 1), u16(data, o + 3), u16(data, o + 5), u16(data, o + 7), data[o + 9]; o += 10
    pal = gpal
    if f & 0x80:
        n = 3 * (2 << (f & 7)); pal = data[o:o + n]; o += n
    min_code = data[o]; o += 1; stream = bytearray()
    while data[o]:
        stream += data[o + 1:o + 1 + data[o]]; o += data[o] + 1
    clear, end = 1 << min_code, (1 << min_code) + 1
    size, table, out, prev, bit, pos = min_code + 1, None, bytearray(), None, 0, 0
    def reset():
        return [bytes([i]) for i in range(clear)] + [b'', b'']
    table = reset()
    while True:
        code = 0
        for k in range(size):
            if pos >= len(stream) * 8:
                code = end; break
            code |= ((stream[pos >> 3] >> (pos & 7)) & 1) << k; pos += 1
        if code == clear:
            table, size, prev = reset(), min_code + 1, None; continue
        if code == end:
            break
        entry = table[code] if code < len(table) else table[prev] + table[prev][:1]
        out += entry
        if prev is not None and len(table) < 4096:
            table.append(table[prev] + entry[:1])
            if len(table) == (1 << size) and size < 12:
                size += 1
        prev = code
    idx = list(out[:w * h])
    if f & 0x40:
        order = list(range(0, h, 8)) + list(range(4, h, 8)) + list(range(2, h, 4)) + list(range(1, h, 2))
        rows = {order[i]: idx[i * w:(i + 1) * w] for i in range(h)}; idx = sum((rows[y] for y in range(h)), [])
    rgb = bytearray(b'\xff' * (W * H * 3))
    for y in range(h):
        for x in range(w):
            p = idx[y * w + x]; at = ((y + y0) * W + x + x0) * 3; rgb[at:at + 3] = pal[3 * p:3 * p + 3]
    return W, H, bytes(rgb)


def resample(w, h, rgb, dw, dh):
    """Area average (float); independent of the geul integer implementation."""
    out = bytearray()
    for dy in range(dh):
        y0, y1 = dy * h / dh, (dy + 1) * h / dh
        for dx in range(dw):
            x0, x1 = dx * w / dw, (dx + 1) * w / dw; acc = [0.0, 0.0, 0.0]; tot = 0.0
            for sy in range(int(y0), min(h, int(y1) + 1)):
                wy = min(y1, sy + 1) - max(y0, sy)
                if wy <= 0: continue
                for sx in range(int(x0), min(w, int(x1) + 1)):
                    wx = min(x1, sx + 1) - max(x0, sx)
                    if wx <= 0: continue
                    at = (sy * w + sx) * 3
                    for c in range(3): acc[c] += rgb[at + c] * wx * wy
                    tot += wx * wy
            out += bytes(round(v / tot) for v in acc)
    return bytes(out)


def compare(a, b, w, h):
    diff = [abs(x - y) for x, y in zip(a, b)]
    mad = sum(diff) / len(diff)
    changed = [(i // 3) for i, v in enumerate(diff) if v > 64]
    box = None
    if changed:
        xs = [p % w for p in changed]; ys = [p // w for p in changed]
        box = [min(xs), min(ys), max(xs), max(ys)]
    ink = lambda img: sum(1 for i in range(0, len(img), 3) if sum(img[i:i + 3]) < 600)
    return {'meanAbsDiff': round(mad, 3), 'pixelsOver64': len(set(changed)), 'changedBox': box, 'inkA': ink(a), 'inkB': ink(b)}


def block_means(img, w, h, size=8):
    out = []
    for by in range(0, h - size + 1, size):
        for bx in range(0, w - size + 1, size):
            total = 0
            for y in range(by, by + size):
                o = (y * w + bx) * 3
                total += sum(img[o:o + size * 3])
            out.append(total / (size * size * 3))
    return out


# Correspondence threshold (8x8 block mean, 0-255). Calibrated on target/preview-tables-toc-20261108/a/native-final:
# preview vs its own reopened page <= 5.2 (resampling/anti-aliasing), preview vs the other save's page >= 19.5
# (one changed formula digit). Both a correct pairing and a stale pairing are checked on every run.
BLOCK_LIMIT = 10.0


def correspond(preview, display, w, h):
    a, b = block_means(preview, w, h), block_means(display, w, h)
    diffs = [abs(x - y) for x, y in zip(a, b)]
    return {'maxBlockDiff': round(max(diffs), 2), 'blocksOverLimit': sum(1 for d in diffs if d > BLOCK_LIMIT), 'matches': max(diffs) <= BLOCK_LIMIT}


def cell_texts(recs):
    out = []
    for t, lvl, b in recs:
        if t == 67 and lvl == 3:
            units = [u16(b, i) for i in range(0, len(b), 2)]; text = ''; i = 0
            while i < len(units):
                c = units[i]
                if c in (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23): i += 8; continue
                if c >= 32: text += chr(c)
                i += 1
            out.append(text)
    return out


def main():
    p = argparse.ArgumentParser(); p.add_argument('original', type=Path); p.add_argument('run', type=Path); p.add_argument('--out', type=Path)
    args = p.parse_args()
    original = args.original.read_bytes(); orig = cfb_streams(original)
    result = {'original': {'sha256': hashlib.sha256(original).hexdigest(), 'prvImage': orig['PrvImage'][:6].decode('latin1'),
                           'prvTextBytes': len(orig['PrvText'])}, 'saves': {}, 'checks': []}
    def check(name, ok, detail=None):
        result['checks'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **({'detail': detail} if detail is not None else {})})
    gw, gh, grgb = gif_decode(orig['PrvImage'])
    previews = {}
    for name, display in [('first-save', 'first-reopen-display.png'), ('second-save', 'final-reopen-display.png')]:
        data = (args.run / (name + '.hwp')).read_bytes(); s = cfb_streams(data); recs = section0(s)
        row = {'sha256': hashlib.sha256(data).hexdigest(), 'streams': sorted(s)}
        check(name + ' stream set equals original', sorted(s) == sorted(orig))
        unchanged = [k for k in orig if k not in ('PrvText', 'PrvImage', 'Section0', 'DocInfo')]
        check(name + ' unrelated streams byte-identical', all(s[k] == orig[k] for k in unchanged), unchanged)
        try:
            w, h, rgb = png_decode(s['PrvImage'], strict=True); ok = True
        except AssertionError as e:
            ok, w, h, rgb = False, 0, 0, b''; row['pngError'] = str(e)
        check(name + ' PrvImage strict canonical-shape PNG decode', ok)
        check(name + ' PrvImage size = Hancom rule from saved PAGE_DEF', (w, h) == expected_size(recs), [w, h, list(expected_size(recs))])
        check(name + ' original GIF preview bytes absent', orig['PrvImage'] not in data)
        check(name + ' original PrvText bytes absent', orig['PrvText'] not in data)
        try:
            text = s['PrvText'].decode('utf-16le'); row['prvText'] = text
        except UnicodeDecodeError:
            text = None
        check(name + ' PrvText is the content-free blank CRLF (calc-cell has no top-level body text)', text == '\r\n', text)
        cells = cell_texts(recs); row['cellTexts'] = cells
        dw, dh, drgb = png_decode((args.run / display).read_bytes(), strict=False)
        row['display'] = [dw, dh]
        b = resample(dw, dh, drgb, w, h) if (dw, dh) != (w, h) else drgb
        row['vsDisplay'] = compare(rgb, b, w, h) | {'blocks': correspond(rgb, b, w, h)}
        previews[name] = (w, h, rgb, rgb, b)
        result['saves'][name] = row
    first, second = result['saves']['first-save'], result['saves']['second-save']
    check('first save cell texts: A1 "15", SUM(ABOVE) "18"', first['cellTexts'][0] == '15' and first['cellTexts'][8] == '18', first['cellTexts'])
    check('second save MAX(ABOVE) recalculated to "15"', second['cellTexts'][8] == '15', second['cellTexts'])
    small = (previews['first-save'][0], previews['first-save'][1])
    for name in ('first-save', 'second-save'):
        v = result['saves'][name]['vsDisplay']
        # Justification: same renderer at different scales; anti-aliasing and the reference's
        # own scale differ, so require low mean difference and comparable ink, not equality.
        check(name + ' preview agrees with separately rendered reopened page 1', v['inkA'] > 500 and v['meanAbsDiff'] < 4.0
              and abs(v['inkA'] - v['inkB']) <= v['inkB'] // 4 and v['blocks']['matches'], v)
    # Negative control on the same run: each preview against the OTHER save's reopened page must not match,
    # so a structurally valid but stale preview would be detected by this verifier.
    (w1, h1, p1, _, d1), (w2, h2, p2, _, d2) = previews['first-save'], previews['second-save']
    stale = {'firstPreviewVsSecondPage': correspond(p1, d2, w1, h1), 'secondPreviewVsFirstPage': correspond(p2, d1, w2, h2)}
    result['staleControls'] = stale
    check('stale previews (swapped between saves) are detected', not any(x['matches'] for x in stale.values()), stale)
    # Change reflection: first vs second differ only around the formula cell (row 2, col 0).
    d12 = compare(previews['first-save'][3], previews['second-save'][3], *small); result['firstVsSecond'] = d12
    check('first→second preview change is localized and non-empty', d12['pixelsOver64'] > 0 and d12['changedBox'] is not None
          and d12['changedBox'][3] - d12['changedBox'][1] < small[1] // 20, d12)
    g = resample(gw, gh, grgb, *small) if (gw, gh) != small else grgb
    d0 = compare(g, previews['first-save'][3], *small); result['originalGifVsFirst'] = {**d0, 'gif': [gw, gh]}
    check('original Hancom GIF vs first regenerated preview differ (stale content replaced)', d0['pixelsOver64'] > 0, d0)
    result['status'] = 'PASS' if all(c['status'] == 'PASS' for c in result['checks']) else 'FAIL'
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text + '\n')
    print(text)
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
