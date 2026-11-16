#!/usr/bin/env python3
"""Independent post-run inspection of native-rhwp-natural-metrics.py (standard library + the Rust T009 checker).

1. Saved documents: per-character 7-slot families, text and table shape from the separate-process oracle; only the
   edited wrap paragraph and cell 0 carry the new family.
2. T009: the protected `save_check` example proves each saved file safe against its original fixture.
3. Canvas vs raster PDF: the app's Flate/RGB PDF page image and the Canvas PNG captured in the same state are decoded
   here (no geul/RHWP code), normalized to page coordinates and compared by ink line bands and their right edges.
   Before/after PDFs must differ by the re-wrap (one fewer text band in the wrap paragraph).
"""
import argparse
import json
from pathlib import Path
import re
import struct
import subprocess
import zlib

ROOT = Path(__file__).resolve().parents[2]


def png_rgb(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    at, idat, w = 8, b'', None
    while at < len(data):
        length, kind = struct.unpack_from('>I4s', data, at)
        body = data[at + 8:at + 8 + length]
        if kind == b'IHDR':
            w, h, depth, color, _, _, interlace = struct.unpack('>IIBBBBB', body)
            assert depth == 8 and color in (2, 6) and interlace == 0
            bpp = 3 if color == 2 else 4
        elif kind == b'IDAT':
            idat += body
        at += 12 + length
    raw, stride, out, prev = zlib.decompress(idat), w * bpp, bytearray(), bytearray(w * bpp)
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        for x in range(w):
            px = line[x * bpp:x * bpp + bpp]
            alpha = px[3] if bpp == 4 else 255
            out += bytes(255 - (255 - v) * alpha // 255 for v in px[:3])  # composite on white
    return w, h, bytes(out)


def pdf_rgb(path):
    data = path.read_bytes()
    assert data.startswith(b'%PDF-')
    for match in re.finditer(rb'\d+ 0 obj\s*<<(.*?)>>\s*stream\r?\n', data, re.S):
        head = match[1]
        if b'/Subtype/Image' in head and b'/DeviceRGB' in head:
            assert b'/Filter/FlateDecode' in head and b'/BitsPerComponent 8' in head and b'/DecodeParms' not in head
            n = lambda key: int(re.search(rb'/' + key + rb' (\d+)', head)[1])
            w, h, size = n(b'Width'), n(b'Height'), n(b'Length')
            pixels = zlib.decompress(data[match.end():match.end() + size])
            assert len(pixels) == w * h * 3
            return w, h, pixels
    raise AssertionError('no page image')


def bands(image, top=0.0, bottom=1.0):
    """Text ink row bands (normalized y0, y1, right text edge x) inside [top, bottom] of the page.

    Table rules are excluded on both axes: they are crisp at the PDF's 2x but antialiased lighter at 1x, so they are
    not text and not comparable. A rule row is dense dark ink across the table (observed ~0.70 of the page width;
    text rows of this fixture stay below ~0.32); a rule column is dark through >= 90% of a band's rows, and a rule corner is a lone pixel.
    """
    w, h, px = image
    rows = []
    for y in range(int(top * h), int(bottom * h)):
        line = px[y * w * 3:(y + 1) * w * 3]
        ink = [x for x in range(w) if min(line[x * 3:x * 3 + 3]) < 90]  # text cores are near black at both scales
        rows.append(ink if len(ink) <= 0.5 * w else [])
    out = []
    y0 = None
    for offset, ink in enumerate(rows + [[]]):
        if ink and y0 is None:
            y0 = offset
        elif not ink and y0 is not None:
            band = rows[y0:offset]
            counts = {}
            for line in band:
                for x in line:
                    counts[x] = counts.get(x, 0) + 1
            # >= 2 rows: a lone rule-corner pixel is not text; < 90%: full-height rule columns are not text.
            text = [x for x, n in counts.items() if 2 <= n < 0.9 * len(band)]
            if offset - 1 - y0 >= 2 and text:
                out.append(((y0 + int(top * h)) / h, (offset - 1 + int(top * h)) / h, max(text) / w))
            y0 = None
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('out', type=Path); parser.add_argument('fixtures', type=Path)
    args = parser.parse_args()
    result = json.loads((args.out / 'result.json').read_text())
    assert result['status'] == 'PASS'
    geometry = json.loads((args.fixtures / 'geometry.json').read_text())
    report = []
    for row, run in zip(geometry['fixtures'], result['rhwp']):
        fmt = row['format']
        saved = args.out / 'docs' / ('natural.' + fmt)
        state = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/tests/rhwp-natural-metrics.mjs'), str(saved)], cwd=ROOT, text=True))
        fam = lambda chars: {slot for c in chars for slot in c}
        assert fam(state['body'][0]['families']) == {'NanumGothic'}
        assert fam(state['body'][1]['families']) == {'GeulMono Test1'} and state['body'][1]['text'] == 'W' * 100
        assert fam(state['cells'][0]['families']) == {'GeulMono Test1'} and fam(state['cells'][1]['families']) == {'NanumGothic'}
        assert [c['text'] for c in state['cells']] == [c['text'] for c in row['state']['cells']]
        assert (state['table']['rowCount'], state['table']['colCount']) == (1, 2) and state['pages'] == 1
        loss = args.out / f'{fmt}-loss.json'
        # The in-app save already required an empty engine loss report; the checker needs that report's schema.
        loss.write_text(json.dumps({'schemaVersion': 1, 'outputFormat': fmt, 'count': 0, 'losses': []}))
        proof = json.loads(subprocess.check_output([str(ROOT / 'src-tauri/target/debug/examples/save_check'), 'saved', fmt,
                                                    row['source'], str(saved), str(loss), 'true'], text=True))
        assert proof['outcome'] == 'safe', proof
        canvas = png_rgb(args.out / f'{fmt}-after.png')
        pdf_after, pdf_before = pdf_rgb(args.out / 'pdf' / f'{fmt}-after.pdf'), pdf_rgb(args.out / 'pdf' / f'{fmt}-before.pdf')
        region = (0.08, 0.30)  # header-free body area holding the three paragraphs and the table row
        c_b, a_b, b_b = bands(canvas, *region), bands(pdf_after, *region), bands(pdf_before, *region)
        assert len(c_b) == len(a_b), (c_b, a_b)
        worst = max(max(abs(x - y) for x, y in zip(p, q)) for p, q in zip(c_b, a_b))
        assert worst < 0.01, ('Canvas and PDF layouts differ', worst)
        assert len(b_b) == len(a_b) + 1, ('re-wrap must remove one wrap-paragraph line', len(b_b), len(a_b))
        report.append({'format': fmt, 'saved': state['sha256'], 'proof': proof['outcome'], 'canvasBands': c_b, 'pdfAfterBands': a_b,
                       'pdfBeforeBands': b_b, 'maxCanvasPdfDelta': worst, 'canvasSize': canvas[:2], 'pdfSize': pdf_after[:2]})
    (args.out / 'independent.json').write_text(json.dumps({'status': 'PASS', 'formats': report}, indent=2))
    print(json.dumps({'status': 'PASS', 'formats': [(r['format'], r['proof'], len(r['pdfBeforeBands']), len(r['pdfAfterBands']), round(r['maxCanvasPdfDelta'], 4)) for r in report]}))


if __name__ == '__main__':
    main()
