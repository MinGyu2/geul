#!/usr/bin/env python3
"""HWP rectangle-caption IBus and locked-owner native acceptance in a private X11 session."""
import argparse
import importlib.util
import json
import shutil
import struct
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/tests'))
spec = importlib.util.spec_from_file_location('caption_acceptance', ROOT / 'scripts/tests/native-stage3-caption-acceptance.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
p = a.p6

from hwp_record_diff import cfb_streams, records, unpacked


def validate_ime_observations(status, save):
    """Reject incomplete or mismatched revision and synchronization observations."""
    if not isinstance(status, dict) or status.get('revision') != '2':
        raise ValueError('HWP caption input revision must be exactly 2')
    if not isinstance(save, dict) or save.get('revision') != '2':
        raise ValueError('HWP caption saved revision must be exactly 2')
    if save.get('synced') != 'true':
        raise ValueError('HWP caption save must be explicitly synchronized')


# HWP5 identifiers, record levels and flag offsets follow
# src-tauri/src/services/save/hwp/gso.rs: shape_component_pos and ATTR_*.
def inspect_caption_lock_records(rows, expected_locked):
    """Prove the sole root GSO is the captioned rectangle at control index 2."""
    roots = [(i, data) for i, (tag, level, data) in enumerate(rows) if (tag, level) == (71, 1)]
    if (len(roots) != 3 or not roots[0][1].startswith(b'dces')
            or not roots[1][1].startswith(b'dloc') or not roots[2][1].startswith(b' osg')):
        raise ValueError('ambiguous root control ownership')
    index, header = roots[2]
    if len(header) < 46:
        raise ValueError('missing or malformed GSO lock metadata')
    attr = struct.unpack_from('<I', header, 4)[0]
    if not attr & (1 << 29) or bool(attr & (1 << 30)) != expected_locked:
        raise ValueError('caption or lock flag does not match fixture')
    end = next((j for j in range(index + 1, len(rows)) if rows[j][1] <= 1), len(rows))
    child = rows[index + 1:end]
    if not child or child[0][0:2] != (72, 2) or len(child[0][2]) != 30:
        raise ValueError('missing caption list owned by target')
    count = struct.unpack_from('<H', child[0][2], 0)[0]
    if not 1 <= count <= 64:
        raise ValueError('invalid caption paragraph count')
    components = [i for i, row in enumerate(child) if row[0:2] == (76, 2)]
    if len(components) != 1:
        raise ValueError('ambiguous shape component')
    component = components[0]
    prefix = child[1:component]
    if sum(row[0:2] == (66, 2) for row in prefix) != count or any(level < 2 or (level == 2 and tag != 66) for tag, level, _ in prefix):
        raise ValueError('invalid caption paragraph ownership')
    shape = child[component][2]
    if len(shape) < 8 or shape[:8] != b'cer$cer$':
        raise ValueError('target is not the intended rectangle')
    if component + 1 >= len(child) or child[component + 1][0:2] != (79, 3) or len(child[component + 1][2]) < 33:
        raise ValueError('missing rectangle geometry')
    return {'section': 0, 'paragraph': 0, 'control': 2, 'attribute': f'0x{attr:08x}',
            'caption': True, 'locked': bool(attr & (1 << 30))}


def inspect_caption_fixture(path, expected_locked):
    try:
        streams = cfb_streams(path.read_bytes())
        if not streams['FileHeader'].startswith(b'HWP Document File') or len(streams['FileHeader']) < 40:
            raise ValueError('not a valid HWP5 file header')
        rows = records(unpacked(streams, 'BodyText/Section0'))
        # This fixture uses one root paragraph; do not infer an owner in ambiguous stories.
        if sum((tag, level) == (66, 0) for tag, level, _ in rows) != 1:
            raise ValueError('ambiguous root paragraph ownership')
        return inspect_caption_lock_records(rows, expected_locked)
    except (KeyError, IndexError, struct.error, OSError) as error:
        raise ValueError('malformed HWP fixture') from error


def execute(acc, case, out, fixtures):
    source = fixtures / ('fixture.hwp' if case == 'ime' else 'locked.hwp')
    target = out / (case + '.hwp')
    shutil.copyfile(source, target)
    lock_evidence = inspect_caption_fixture(target, case == 'locked')
    before = a.oracle(target)
    shape = before['shape']
    if (shape.get('secIdx'), shape.get('paraIdx'), shape.get('controlIdx')) != (0, 0, 2):
        raise ValueError('rendered shape does not match proven control owner')
    acc.open_native('hwp', target)
    acc.engine('xkb:us::eng')
    p.gso.choose(acc, before['shape'], 'shape')
    before_click = acc.status('hwp')
    at = before['caret']
    p.pointer(acc, (at['pageIndex'], at['x'] + 1, at['y'] + at['height'] / 2))
    if case == 'locked':
        acc.settle('hwp')
        after_click = acc.status('hwp')
        if '@caption/' in after_click['caret']:
            raise ValueError('locked caption entry was permitted')
        if after_click['caret'] != before_click['caret']:
            raise ValueError('locked caption click changed caret')
        if after_click['revision'] != '0' or before_click['revision'] != '0':
            raise ValueError('locked caption click changed revision')
        if a.sha(source) != a.sha(target):
            raise ValueError('locked caption click changed target bytes')
        return {'status': 'PASS', 'format': 'hwp', 'sourceSha256': a.sha(source),
                'beforeCaret': before_click['caret'], 'afterCaret': after_click['caret'],
                'beforeRevision': before_click['revision'], 'afterRevision': after_click['revision'], 'fixtureLock': lock_evidence,
                'note': 'locked rectangle caption click refused entry'}
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/')")
    d = acc.d
    d.js("window.__captionIme=[];for(const t of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(t,e=>window.__captionIme.push({type:t,data:e.data,isTrusted:e.isTrusted}),true)")
    acc.engine('hangul')
    acc.type('gksrmf')
    acc.key('End')
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('한글')")
    acc.settle('hwp')
    status = acc.status('hwp')
    events = d.js('return window.__captionIme')
    if not any(e['type'] == 'compositionstart' and e['isTrusted'] for e in events):
        raise ValueError('trusted compositionstart not observed')
    if not any(e['type'] == 'compositionend' and e['isTrusted'] and e['data'] for e in events):
        raise ValueError('trusted committed compositionend not observed')
    save = acc.save('hwp')
    validate_ime_observations(status, save)
    if save.get('state') != 'saved':
        raise ValueError('HWP caption save did not succeed')
    after = a.oracle(target)
    if after['texts'] != [before['texts'][0] + '한글']:
        raise ValueError('saved caption text differs from committed input')
    for key in ('atnos', 'props', 'body'):
        if after[key] != before[key]:
            raise ValueError(f'HWP caption save changed {key}')
    closed = p.p4.rhwp_poc.close_tab(d, target.name)
    if not closed:
        raise ValueError('HWP caption document tab did not close')
    acc.open_native('hwp', target)
    at = after['caret']
    p.pointer(acc, (at['pageIndex'], at['x'] + 1, at['y'] + at['height'] / 2))
    acc.wait("return document.querySelector('[data-testid=rhwp-status]')?.dataset.caret.includes('@caption/') && document.querySelector('[data-testid=rhwp-status]')?.dataset.paragraphText.endsWith('한글')")
    return {'status': 'PASS', 'format': 'hwp', 'sourceSha256': a.sha(source), 'savedSha256': a.sha(target),
            'events': events, 'revisionAfterInput': status['revision'], 'save': save, 'texts': after['texts'],
            'atnoUnchanged': after['atnos'] == before['atnos'], 'shapeUnchanged': after['props'] == before['props'],
            'bodyUnchanged': after['body'] == before['body'], 'fixtureLock': lock_evidence, 'reopenedInApp': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--xdotool', required=True)
    parser.add_argument('--ibus', required=True)
    parser.add_argument('--driver', default='/tmp/geul-tauri-driver-target/debug/tauri-driver')
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.fixtures = args.fixtures.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    # Both files must pass before a driver or application process is started.
    inspect_caption_fixture(args.fixtures / 'fixture.hwp', False)
    inspect_caption_fixture(args.fixtures / 'locked.hwp', True)
    app = ROOT / 'src-tauri/target/release/geul'
    p.p4.smoke.APP = str(app)
    p.p4.smoke.DRIVER_LOG = str(args.out / 'driver.log')
    report = {'appSha256': a.sha(app), 'cases': {}}
    for case in ['ime', 'locked']:
        try:
            with p.p4.smoke.tauri_driver(args.driver, 4469, str(args.out / ('data-' + case))) as start:
                d = start()
                try:
                    acc = p.p4.P4Acceptance(args, d, report)
                    acc.wait("return !!document.querySelector('.document-bar')", timeout=30)
                    acc.focus_window()
                    acc.calibrate_pointer()
                    report['cases'][case] = execute(acc, case, args.out, args.fixtures)
                finally:
                    d.quit()
        except Exception:
            report['cases'][case] = {'status': 'FAIL', 'error': traceback.format_exc()}
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if all(value['status'] == 'PASS' for value in report['cases'].values()) else 1


if __name__ == '__main__':
    sys.exit(main())
