#!/usr/bin/env python3
"""Actual Tauri viewport visits vs independent Full replay; not approved-anchor D1."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[5]
POC = ROOT / 'tests/integration/rhwp/ownership-poc'
sys.path.insert(0, str(POC))
import native
import native_probe
import undo_native as history
from native import smoke, poc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output', 'driver-log']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--expected-wasm', required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('preserve prior results')
    result = {'status': 'FAIL', 'official': False, 'approvedAnchorD1': False, 'frames': [], 'tests': []}
    smoke.DRIVER_LOG = args.driver_log
    source = ROOT / 'external/rhwp/samples/rnote/연구노트(화학).hwp'
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    result['fixtureSha256'] = source_sha
    if source_sha != '6717eca43c6fdd9b0530530cf17d33b6687da0c462a433d37eb652afb5394f91':
        raise ValueError('official chemical fixture mismatch')
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, text=True)
    driver = None

    def check(name, passed):
        result['tests'].append({'name': name, 'status': 'PASS' if passed else 'FAIL'})
        if not passed:
            raise RuntimeError(name)

    def visit(label):
        count = driver.js("return document.querySelectorAll('.rhwp-page__canvas').length")
        check(label + '-pages', count == 24)
        for page in range(count):
            driver.js("document.querySelectorAll('.rhwp-page')[arguments[0]].scrollIntoView({block:'center'}); return true", page)
            driver.call('POST', '/execute/async', {'script': 'const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))', 'args': []})
            smoke.wait_until(driver, "return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)", timeout=30)
            frame = driver.js('return window.__rhwpProbe.fullFrameCheck(arguments[0])', page)
            result['frames'].append({'phase': label, 'page': page, **frame})
            if frame.get('verified') is not True:
                raise RuntimeError(f'{label} page {page}: Full reference unavailable')
            if frame.get('pixels') != 0 or frame.get('maxDelta') != 0:
                raise RuntimeError(f'{label} page {page}: Full RGBA mismatch')
        check(label + '-exact-rgba', True)

    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11',
                          WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none',
                          LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-viewport-native-') as folder:
            work = Path(folder)
            for name in ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR']:
                (work / name).mkdir()
                os.environ[name] = str(work / name)
            generated = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(generated)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                driver = start()
                try:
                    smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    poc.open_document(driver, generated / 'basic-ko.hwpx')
                    native_probe.install(driver, native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())'))
                    history.close_discard(driver, 'basic-ko.hwpx')
                    result['engineIdentity'] = driver.js('return window.__geulOwnership.identity')
                    check('candidate-identity', result['engineIdentity']['wasmSha256'] == args.expected_wasm)
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    driver.native_key_tool = str(args.xdotool)
                    poc.open_document(driver, source)
                    poc.set_zoom(driver, 50)
                    # The existing read-only probe binds its authoritative handle
                    # on actual hitTest, not document creation. No edit is made.
                    poc.click_paragraph_start(driver)
                    visit('initial')
                    driver.js("document.querySelector('.editor__scroll').scrollTop=0; return true")
                    poc.click_paragraph_start(driver)
                    poc.type_ascii(driver, 'a')
                    visit('edit')
                    _, changed = history.history_key(driver, 'z')
                    check('native-undo', changed)
                    visit('undo')
                    _, changed = history.history_key(driver, 'y')
                    check('native-redo', changed)
                    visit('redo')
                    history.close_discard(driver, source.name)
                    poc.open_document(driver, source)
                    poc.click_paragraph_start(driver)
                    visit('reopen')
                    poc.set_zoom(driver, 75)
                    visit('zoom')
                    history.close_discard(driver, source.name)
                    clean = driver.js('return window.__geulOwnership.stats()')
                    result['postCloseOwnership'] = clean
                    check('resource-cleanup', clean['subscribers'] == 0 and clean['sessions'] == []
                          and clean['jobs']['activeJobs'] == 0 and clean['jobs']['activeLeaseCount'] == 0)
                    check('source-preserved', hashlib.sha256(source.read_bytes()).hexdigest() == source_sha)
                    result['status'] = 'PASS'
                finally:
                    smoke.end_session(driver)
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        display.terminate()
        result['xvfbExit'] = display.wait(timeout=10)
        args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'frames': len(result['frames']), 'tests': len(result['tests']), 'error': result.get('error')}))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
