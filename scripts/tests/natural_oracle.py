"""Independent sfnt advance oracle (standard library only; no RHWP/ttf-parser code).

advances(data, index) -> f(char) -> advance in em, or None when the face has no glyph for it.
Reads the TrueType/OpenType table directory (or a TTC entry), cmap formats 4 and 12, head.unitsPerEm,
hhea.numberOfHMetrics and hmtx. Anything else is refused rather than guessed.
"""
import struct


def _directory(data, index):
    if data[:4] == b'ttcf':
        count = struct.unpack_from('>I', data, 8)[0]
        assert index < count, 'face index outside collection'
        return struct.unpack_from('>I', data, 12 + 4 * index)[0]
    assert index == 0, 'face index on a single-face file'
    return 0


def advances(data, index=0):
    base = _directory(data, index)
    tables = {}
    for i in range(struct.unpack_from('>H', data, base + 4)[0]):
        tag, _, offset, length = struct.unpack_from('>4sIII', data, base + 12 + 16 * i)
        tables[tag.decode('latin-1')] = (offset, length)
    upem = struct.unpack_from('>H', data, tables['head'][0] + 18)[0]
    metrics = struct.unpack_from('>H', data, tables['hhea'][0] + 34)[0]
    hmtx = tables['hmtx'][0]
    cmap = tables['cmap'][0]
    glyphs = {}
    for i in range(struct.unpack_from('>H', data, cmap + 2)[0]):
        platform, encoding, offset = struct.unpack_from('>HHI', data, cmap + 4 + 8 * i)
        if not (platform == 0 or (platform == 3 and encoding in (1, 10))):
            continue
        sub = cmap + offset
        fmt = struct.unpack_from('>H', data, sub)[0]
        if fmt == 4:
            seg = struct.unpack_from('>H', data, sub + 6)[0] // 2
            ends = sub + 14
            starts = ends + 2 * seg + 2
            deltas = starts + 2 * seg
            ranges = deltas + 2 * seg
            for k in range(seg):
                s, e = struct.unpack_from('>H', data, starts + 2 * k)[0], struct.unpack_from('>H', data, ends + 2 * k)[0]
                delta = struct.unpack_from('>h', data, deltas + 2 * k)[0]
                rng = struct.unpack_from('>H', data, ranges + 2 * k)[0]
                for c in range(s, e + 1):
                    if c == 0xFFFF:
                        continue
                    if rng == 0:
                        g = (c + delta) & 0xFFFF
                    else:
                        g = struct.unpack_from('>H', data, ranges + 2 * k + rng + 2 * (c - s))[0]
                        g = (g + delta) & 0xFFFF if g else 0
                    if g:
                        glyphs.setdefault(c, g)
        elif fmt == 12:
            for k in range(struct.unpack_from('>I', data, sub + 12)[0]):
                s, e, g = struct.unpack_from('>III', data, sub + 16 + 12 * k)
                for c in range(s, e + 1):
                    glyphs.setdefault(c, g + c - s)

    def advance(ch):
        g = glyphs.get(ord(ch))
        if g is None:
            return None
        return struct.unpack_from('>H', data, hmtx + 4 * min(g, metrics - 1))[0] / upem
    return advance
