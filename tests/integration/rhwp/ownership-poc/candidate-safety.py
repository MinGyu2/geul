#!/usr/bin/env python3
"""Native candidate D3/D5, using the real application save and history paths."""
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
sys.path.insert(0, str(HERE))
import native
import undo_native as history
import native_probe
from native import smoke, poc
ROOT = HERE.parents[3]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    result = {'status': 'RUNNING', 'tests': [], 'scope': 'actual candidate native service::save and controlled history boundary exceptions'}
    def check(name, ok, **data):
        result['tests'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **data})
        if not ok: raise RuntimeError(name)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-candidate-safety-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            subprocess.run(['node', str(HERE / 'generate.mjs'), str(work)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                d = start()
                try:
                    smoke.wait_until(d, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    # Bootstrap the real loader, then instrument its authoritative class.
                    poc.open_document(d, fixtures / 'basic-ko.hwpx')
                    smoke.wait_until(d, 'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                    d.js("window.__aliasDiagnostic=null;import('/__ownership_candidate__/rhwp.js').then(m=>window.__aliasDiagnostic={sameConstructor:m.HwpDocument===window.__geulOwnership.probeEngine().HwpDocument,resources:performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname==='/__ownership_candidate__/rhwp.js').map(e=>new URL(e.name).pathname+new URL(e.name).search)})")
                    smoke.wait_until(d, 'return !!window.__aliasDiagnostic', timeout=10)
                    result['observerAliasDiagnostic'] = d.js('return window.__aliasDiagnostic')
                    install = native_probe.INSTALL.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())').replace('/rhwp/rhwp_bg.wasm', '/__ownership_candidate__/rhwp_bg.wasm')
                    native_probe.install(d, install)
                    check('bootstrap-clean-close', poc.close_tab(d, 'basic-ko.hwpx'))
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    d.native_key_tool = str(args.xdotool)
                    poc.scenario_save(d, fixtures, work)
                    check('native-T009-save-matrix', True)
                    check('observer-reaches-authoritative-WASM', d.js('return window.__rhwpProbe.calls.some(c=>c.name==="saveSnapshot")&&window.__rhwpProbe.calls.some(c=>c.name==="insertText")'))
                    for fmt in ('hwp', 'hwpx'):
                        for redo in (False, True):
                            path = work / ('history-' + str(redo) + '.' + fmt); shutil.copyfile(fixtures / ('basic-ko.' + fmt), path)
                            before = hashlib.sha256(path.read_bytes()).hexdigest()
                            poc.open_document(d, path); poc.click_paragraph_start(d); poc.type_ascii(d, 'X'); history.history_key(d, 'z')
                            if redo: history.history_key(d, 'y')
                            st = poc.status(d); revision = int(st['revision']); saved = poc.save_and_wait(d); after = poc.status(d)
                            should_save = fmt == 'hwpx' or not redo
                            check(fmt + ('-redo' if redo else '-undo') + '-service-save', (saved['state']=='saved') == should_save and int(after['revision']) == revision and (after['dirty']=='false') == should_save and (should_save or hashlib.sha256(path.read_bytes()).hexdigest()==before), revision=revision, saved=saved['state'], dirty=after['dirty'], originalPreserved=hashlib.sha256(path.read_bytes()).hexdigest()==before)
                            history.close_discard(d, path.name)
                        history.scenario_discard_failure_reload(d, fixtures / ('basic-ko.' + fmt), fmt)
                        check(fmt + '-discard-failure-reload', True)
                        history.close_discard(d, 'basic-ko.' + fmt)
                    for fmt in ('hwp', 'hwpx'):
                        path = work / ('ownership-' + fmt + '.' + fmt)
                        poc.open_document(d, path)
                        smoke.wait_until(d, 'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                        before = d.js('return window.__geulOwnership.stats().jobs')
                        check(fmt + '-history-failure-image-resources-established', before['uniqueResourceCount'] > 0, resources=before)
                        history.scenario_discard_failure_reload(d, path, fmt + '-images')
                        smoke.wait_until(d, 'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)', timeout=30)
                        history.close_discard(d, path.name)
                        d.js('window.__geulOwnership.trim()')
                        after = d.js('return window.__geulOwnership.stats().jobs')
                        check(fmt + '-history-failure-image-cleanup', after['activeLeaseCount']==0 and after['pendingCount']==0 and after['uniqueResourceCount']==0, resources=after)
                    result['engineIdentity'] = d.js('return window.__geulOwnership.identity')
                    d.js('window.__geulOwnership.trim()')
                    check('native-final-resource-cleanup', d.js('const s=window.__geulOwnership.stats();return s.subscribers===0&&s.jobs.activeLeaseCount===0&&s.jobs.pendingCount===0&&s.jobs.uniqueResourceCount===0'))
                    result['status'] = 'PASS'
                finally:
                    try:
                        result['lastObserved'] = d.js("const e=document.querySelector('[data-testid=rhwp-status]');return {status:e?Object.fromEntries(['status','uncertain','revision','localRevision','dirty','history'].map(k=>[k,e.dataset[k]])):null,identity:window.__geulOwnership?.identity,owners:window.__rhwpProbe?.owners(),snapshotCalls:window.__rhwpProbe?.calls.filter(c=>/Snapshot/.test(c.name)).slice(-20),throwAfterDiscard:window.__rhwpProbe?.throwAfterDiscard,jobs:window.__geulOwnership?.stats().jobs}")
                    except Exception: pass
                    smoke.end_session(d)
    except Exception as error:
        result['status']='FAIL';result['error']=str(error)
    finally:
        display.terminate(); display.wait(timeout=10)
        result['existingSaveAssertions'] = poc.RESULTS
        result['historyGates'] = history.GATES
        result['historyChecks'] = history.RESULTS
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
