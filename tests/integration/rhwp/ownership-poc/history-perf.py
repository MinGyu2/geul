#!/usr/bin/env python3
"""Gated candidate: run the existing official native D4 protocol without changes.

Requires the separate GEUL_T010_HISTORY_PERF_ONLY dev-server experiment. This
activates existing test flags in that server only; normal product policy is untouched.
"""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import native
import undo_native as historical
import native_probe
from native import smoke


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument("--engine", choices=("pinned", "candidate"), default="candidate")
    args = parser.parse_args()
    result = {'status': 'RUNNING', 'protocol': 'unmodified undo_native.scenario_perf/MEASURE',
              'engine': args.engine, 'historyEnabled': True, 'keyDelivery': 'native X11 xdotool',
              'environment': {'platform': platform.system(), 'webkitGTK': subprocess.check_output(['pkg-config','--modversion','webkit2gtk-4.1'],text=True).strip(),
                              'debugAppSha256': hashlib.sha256(args.app.read_bytes()).hexdigest(),
                              'cpuAffinity': sorted(os.sched_getaffinity(0)), 'loadAverageBefore': os.getloadavg(),
                              'softwareGLRequested': True, 'webkitDmabufDisabled': True, 'GDK_BACKEND': 'x11',
                              'busyProbe': False, 'warmupGroups': 3, 'groupStartSamplesPerDocument': 30, 'probeBootstrapDocument': 'basic-ko.hwpx in both arms'}}

    def save():
        args.output.write_text(json.dumps(result, indent=2) + '\n')

    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11',
                          WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none',
                          LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-ownership-history-perf-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name
                target.mkdir()
                os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            for index, source in enumerate([fixtures / 'basic-ko.hwp', fixtures / 'basic-ko.hwpx', *historical.LARGE]):
                with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / ('data-' + str(index)))) as start:
                    driver = start()
                    try:
                        smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                        # Bind the existing read-only instrumentation to the candidate module.
                        # All measurement boundaries, sampling, history keys and assertions stay canonical.
                        # Observe the module actually used by the app, including Vite's
                        # dynamic-import query identity; do not initialize an alias instance.
                        if args.engine == 'pinned': driver.js('window.__geulPinnedRuntimeImport = url => import(url)')
                        historical.poc.open_document(driver, fixtures / 'basic-ko.hwpx')
                        actual = 'window.__geulPinnedProbeEngine' if args.engine == 'pinned' else 'window.__geulOwnership.probeEngine()'
                        install = native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(' + actual + ')')
                        native_probe.install(driver, install)
                        historical.close_discard(driver, 'basic-ko.hwpx')
                        windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                        subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                        driver.native_key_tool = str(args.xdotool)
                        driver.busy_probe = False
                        historical.scenario_perf(driver, source, work)
                        result['engineIdentity'] = driver.js('return window.__geulOwnership?.identity||null') if args.engine == 'candidate' else {'wasmSha256': hashlib.sha256((ROOT / 'public/rhwp/rhwp_bg.wasm').read_bytes()).hexdigest()}
                        result['sourceSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
                    finally:
                        result['measurements'] = historical.REPORT
                        result['gates'] = historical.GATES
                        save()
                        smoke.end_session(driver)
        result['status'] = 'PASS' if len(historical.REPORT.get('perf', [])) == 4 and all(g['result'] == 'PASS' for g in historical.GATES) else 'FAIL'
    except Exception as error:
        result['status'] = 'FAIL'
        result['error'] = str(error).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>')
    finally:
        display.terminate()
        display.wait(timeout=10)
        result['measurements'] = historical.REPORT
        result['gates'] = historical.GATES
        result['environment']['loadAverageAfter'] = os.getloadavg()
        # Keep public metrics; remove absolute task paths from inherited diagnostics.
        result = json.loads(json.dumps(result).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>'))
        save()
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
