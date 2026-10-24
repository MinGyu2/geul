#!/usr/bin/env python3
"""Continuous native lifecycle diagnostic: 2 large documents x 3 modes x 20 cycles in ONE app/WebProcess session.

Runs undo_native.scenario_lifecycle unchanged. The tauri-driver session is created normally (capability
translation); later commands go directly to the same native WebKitWebDriver session. No request is retried.
Every memory point is saved durably with its sequence, document, session and WebProcess (pid, start time).
No forced GC or cache trim. PASS comes only from lifecycle_evidence.classify; RSS stays INCONCLUSIVE.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import native  # noqa: F401  (sets import paths)
import native_probe
import undo_native as history
import lifecycle_evidence
from native import smoke, poc


def start_time(pid):
    """Process start in clock ticks since boot (/proc/<pid>/stat field 22); None if the process is gone."""
    try:
        return int(Path(f'/proc/{pid}/stat').read_text().rpartition(')')[2].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def with_generation(processes):
    return [{**row, 'startTime': start_time(row['pid'])} for row in processes]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--driver-log', required=True)
    parser.add_argument('--expected-wasm', required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('preserve previous diagnostic output before repeating')
    result = {'status': 'RUNNING', 'scope': 'continuous 2 docs x 3 modes x 20 = 120 cycles in one app/WebProcess session; no concatenation of separate windows',
              'protocol': 'unchanged undo_native.scenario_lifecycle; renderer stats appended at existing memory sampling points; no forced GC or cache trim',
              'transport': 'tauri-driver POST /session (capability translation) then direct native WebKitWebDriver 4445, same session ID; no request retries',
              'samples': [], 'startedAt': time.time(), 'cleanup': dict.fromkeys(lifecycle_evidence.CLEANUP_STEPS, False)}
    def save():
        clean = json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>')
        temporary = args.output.with_name(args.output.name + '.update.' + str(os.getpid()))
        temporary.write_text(clean + '\n'); os.replace(temporary, args.output)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none', LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-lifecycle-continuous-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            documents = [history.S / relative for relative in ('rnote/연구노트(화학).hwp', 'issue6031/3249937_asset_management_rules.hwpx')]
            if [path.name for path in documents] != list(lifecycle_evidence.DOCUMENTS) or not all(path.is_file() for path in documents):
                raise RuntimeError('lifecycle documents do not match the independent contract')
            smoke.APP = str(args.app.resolve())
            smoke.DRIVER_LOG = args.driver_log
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                driver = start()
                driver.base = 'http://127.0.0.1:4445'
                try:
                    smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    poc.open_document(driver, fixtures / 'basic-ko.hwpx')
                    native_probe.install(driver, native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())').replace('/rhwp/rhwp_bg.wasm', '/__ownership_candidate__/rhwp_bg.wasm'))
                    history.close_discard(driver, 'basic-ko.hwpx')
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    driver.native_key_tool = str(args.xdotool)
                    driver.busy_probe = False
                    # Runtime and process identity are observed BEFORE the first cycle.
                    result['engineIdentity'] = driver.js('return window.__geulOwnership.identity')
                    result['processesAtStart'] = with_generation(smoke.owned_processes())
                    result['sessionId'] = driver.session
                    result['fixtures'] = [{'sample': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in documents]
                    save()
                    original_memory = history.memory_sample
                    state = {'doc': None}
                    def measured_memory(current):
                        value = original_memory(current)
                        value['processes'] = with_generation(value['processes'])
                        value.update(renderer=current.js('return window.__geulOwnership.stats()'), sequence=len(result['samples']),
                                     doc=state['doc'], sessionId=current.session, at=round(time.time() - result['startedAt'], 2))
                        result['samples'].append(value)
                        save()
                        return value
                    history.memory_sample = measured_memory
                    try:
                        for fixture in documents:
                            state['doc'] = fixture.name
                            history.scenario_lifecycle(driver, fixture, work, lifecycle_evidence.CYCLES)
                            save()
                    finally:
                        history.memory_sample = original_memory
                    result['engineIdentityAtEnd'] = driver.js('return window.__geulOwnership.identity')
                finally:
                    result['processesBeforeSessionEnd'] = with_generation(smoke.owned_processes())
                    save()
                    smoke.end_session(driver)
                    result['cleanup']['sessionEnded'] = True
            result['cleanup']['driverStopped'] = True
    except Exception as error:
        result.update(error=str(error), errorType=type(error).__name__)
        if callable(getattr(error, 'diagnostic', None)): result['driverDiagnostic'] = error.diagnostic()
    finally:
        try:
            display.terminate(); display.wait(timeout=10)
            result['cleanup']['displayTerminated'] = True
        except Exception as error:
            result.setdefault('error', 'display cleanup: ' + str(error))
        result.update(measurements=history.REPORT, gates=history.GATES, elapsedSeconds=round(time.time() - result['startedAt'], 2),
                      completedCycles=sum(len(r['rows']) for r in history.REPORT.get('lifecycle', [])))
        result['classification'] = lifecycle_evidence.classify(result, args.expected_wasm)
        result['status'] = result['classification']['status']
        result['officialRssGate'] = 'INCONCLUSIVE'
        save()
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
