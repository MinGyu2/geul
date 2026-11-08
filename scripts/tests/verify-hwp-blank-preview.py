#!/usr/bin/env python3
"""Independent verification of a blank-first-page HWP preview run (2026-11-08).

Standard library only; reuses the parsers of verify-hwp-preview.py (no geul/RHWP code).
RUN_DIR (native-hwp-blank-preview.py --expect saved) holds first-save.hwp (all body text
deleted), second-save.hwp (two paragraph splits after a disk reopen) and the reopened
page-1 canvases first-reopen-display.png / final-reopen-display.png.

usage: verify-hwp-blank-preview.py ORIGINAL.hwp RUN_DIR [--out result.json]
"""
import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('verify_hwp_preview', Path(__file__).with_name('verify-hwp-preview.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


def first_paragraph_text(recs):
    """Visible characters of Section0's first top-level paragraph (controls skipped)."""
    start = next(i for i, (t, l, _) in enumerate(recs) if t == 66 and l == 0)
    text = ''
    for t, l, b in recs[start + 1:]:
        if t == 66 and l == 0:
            break
        if t == 67 and l == 1:
            units = [v.u16(b, i) for i in range(0, len(b), 2)]
            i = 0
            while i < len(units):
                c = units[i]
                if c in (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23):
                    i += 8
                    continue
                if c >= 32:
                    text += chr(c)
                i += 1
    return text


def main():
    p = argparse.ArgumentParser(); p.add_argument('original', type=Path); p.add_argument('run', type=Path); p.add_argument('--out', type=Path)
    args = p.parse_args()
    original = args.original.read_bytes(); orig = v.cfb_streams(original)
    result = {'original': {'sha256': hashlib.sha256(original).hexdigest(), 'prvImage': orig['PrvImage'][:6].decode('latin1')}, 'saves': {}, 'checks': []}

    def check(name, ok, detail=None):
        result['checks'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **({'detail': detail} if detail is not None else {})})

    gw, gh, grgb = v.gif_decode(orig['PrvImage'])
    check('original Hancom preview is not blank (it showed the deleted text)', len(set(grgb[i:i + 3] for i in range(0, len(grgb), 3))) > 1)
    images = {}
    for name, display in [('first-save', 'first-reopen-display.png'), ('second-save', 'final-reopen-display.png')]:
        data = (args.run / (name + '.hwp')).read_bytes(); s = v.cfb_streams(data); recs = v.section0(s)
        row = {'sha256': hashlib.sha256(data).hexdigest()}
        check(name + ' stream set equals original', sorted(s) == sorted(orig))
        unchanged = [k for k in orig if k not in ('PrvText', 'PrvImage', 'Section0', 'DocInfo')]
        check(name + ' unrelated streams byte-identical', all(s[k] == orig[k] for k in unchanged), unchanged)
        w, h, rgb = v.png_decode(s['PrvImage'], strict=True)
        check(name + ' PrvImage size = Hancom rule from saved PAGE_DEF', (w, h) == v.expected_size(recs), [w, h])
        check(name + ' original GIF preview bytes absent', orig['PrvImage'] not in data)
        row['firstParagraphText'] = first_paragraph_text(recs)
        row['paragraphs'] = sum(1 for t, l, _ in recs if t == 66 and l == 0)
        row['prvText'] = s['PrvText'].decode('utf-16le')
        dw, dh, drgb = v.png_decode((args.run / display).read_bytes(), strict=False)
        ref = v.resample(dw, dh, drgb, w, h)
        colours = len(set(rgb[i:i + 3] for i in range(0, len(rgb), 3)))
        row['previewColours'] = colours
        row['vsDisplay'] = v.compare(rgb, ref, w, h) | {'blocks': v.correspond(rgb, ref, w, h)}
        images[name] = (w, h, rgb, ref)
        result['saves'][name] = row
    first, second = result['saves']['first-save'], result['saves']['second-save']
    check('first save: body text fully deleted', first['firstParagraphText'] == '', first['firstParagraphText'])
    check('first save: PrvText is the content-free CRLF', first['prvText'] == '\r\n', first['prvText'])
    check('first save: preview is one colour (white)', first['previewColours'] == 1 and images['first-save'][2][:3] == b'\xff\xff\xff')
    ref1 = images['first-save'][3]
    ref_colours = len(set(ref1[i:i + 3] for i in range(0, len(ref1), 3)))
    check('first save: separately rendered reopened page 1 is blank too', ref_colours == 1 and first['vsDisplay']['blocks']['matches'], {'colours': ref_colours, **first['vsDisplay']})
    check('second save: still blank after the follow-up paragraph splits', second['firstParagraphText'] == '' and second['paragraphs'] == 3, {'paragraphs': second['paragraphs']})
    check('second save: PrvText is the content-free CRLF', second['prvText'] == '\r\n', second['prvText'])
    check('second save: preview is one colour (white)', second['previewColours'] == 1 and images['second-save'][2][:3] == b'\xff\xff\xff')
    check('second save: separately rendered reopened page 1 agrees', second['vsDisplay']['blocks']['matches'], second['vsDisplay'])
    # Negative control: the stale original Hancom preview (the deleted text) must not match the reopened blank page.
    w, h, _, ref1 = images['first-save']
    gif = v.resample(gw, gh, grgb, w, h)
    stale = {'originalGifVsReopenedBlankPage': v.correspond(gif, ref1, w, h)}
    result['staleControls'] = stale
    check('stale original preview is detected against the reopened blank page', not stale['originalGifVsReopenedBlankPage']['matches'], stale)
    result['status'] = 'PASS' if all(c['status'] == 'PASS' for c in result['checks']) else 'FAIL'
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(text + '\n')
    print(text)
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
