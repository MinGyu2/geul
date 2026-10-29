#!/usr/bin/env python3
"""Native candidate typing diagnostic using the unchanged historical RAF boundary.

History stays disabled: this cannot certify the full D4 Undo/Redo activation gate.
Only temporary copies of the four historical public documents are edited.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import native
import undo_native as historical
from native import smoke, poc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    result = {'status': 'RUNNING', 'classification': 'DIAGNOSTIC: history disabled',
              'boundary': 'native keydown -> revision-observed RAF -> two additional RAF',
              'officialD4ActivationEvidence': False, 'samples': []}

    def save():
        args.output.write_text(json.dumps(result, indent=2) + '\n')

    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11',
                          WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-ownership-typing-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name
                target.mkdir()
                os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            paths = [fixtures / 'basic-ko.hwp', fixtures / 'basic-ko.hwpx', *historical.LARGE]
            smoke.APP = str(args.app.resolve())
            for source in paths:
                copy = work / source.name
                shutil.copyfile(source, copy)
                # Fresh native session per document prevents cross-document carryover.
                with smoke.tauri_driver(str(args.driver.resolve()), 4488, str(work / ('data-' + source.suffix[1:] + str(len(result['samples']))))) as start:
                    driver = start()
                    try:
                        smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                        windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                        subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                        driver.native_key_tool = str(args.xdotool)
                        status = poc.open_document(driver, copy)
                        poc.set_zoom(driver, 50)
                        smoke.wait_until(driver, 'return window.__geulOwnership?.stats().sessions.some(s=>s.canvases>0&&!s.active&&!s.queued)', timeout=30)
                        poc.click_paragraph_start(driver)
                        for _ in range(3):
                            poc.press(driver, 'Right')
                            poc.type_ascii(driver, 'ab')
                        time.sleep(1)
                        driver.js('window.__lat=null;window.__gaps=null')
                        driver.js(historical.MEASURE)
                        for _ in range(30):
                            poc.press(driver, 'Right')
                            driver.js("window.__nextKind='groupStart'")
                            poc.type_ascii(driver, 'a')
                            driver.js("window.__nextKind='extend'")
                            poc.type_ascii(driver, 'b')
                        smoke.wait_until(driver, 'return window.__lat.filter(r=>r[0]==="groupStart").length===30 && window.__lat.filter(r=>r[0]==="extend").length===30', timeout=15)
                        raw = historical.latencies(driver)
                        row = {'sample': source.name, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                               'pages': int(status['pages']), 'zoom': 50, 'warmupGroups': 3,
                               'keyDelivery': 'native X11 xdotool', 'historyEnabled': False,
                               'engineIdentity': driver.js('return window.__geulOwnership.identity'),
                               **{name: historical.pct(values) for name, values in raw.items()},
                               'rss': native.rss(), 'ownership': driver.js('return window.__geulOwnership.stats()')}
                        row['typingThreshold'] = 'PASS' if row['groupStart'].get('p95', float('inf')) <= 50 and row['groupStart'].get('timeouts') == 0 else 'FAIL'
                        result['samples'].append(row)
                        save()
                        print(json.dumps({k: row[k] for k in ('sample', 'pages', 'groupStart', 'extend', 'typingThreshold')}), flush=True)
                    finally:
                        smoke.end_session(driver)
        result['status'] = 'MEASURED'
    except Exception as error:
        result['status'] = 'FAIL'
        result['error'] = str(error).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>')
    finally:
        display.terminate()
        display.wait(timeout=10)
        save()
    return 0 if result['status'] == 'MEASURED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
