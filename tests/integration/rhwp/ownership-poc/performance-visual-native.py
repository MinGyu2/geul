#!/usr/bin/env python3
"""Candidate D4 fixture correctness: actual native edits and strict displayed Full-reference pixels."""
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
FIXTURES = ('basic-ko.hwp', 'basic-ko.hwpx', *(path.name for path in history.LARGE))
FRAME_LABELS = ('warm', 'typed-10', 'typed-20', 'typed-30', 'undo', 'redo')
CLEANUP_STEPS = ('sessionEnded', 'driverStopped', 'displayTerminated')


def select_samples(sample):
    """Default is the strict four-document set; a focused run must name exactly one known fixture."""
    if sample is None: return list(FIXTURES)
    if sample not in FIXTURES: raise ValueError(f'unknown --sample {sample!r}; expected one of {list(FIXTURES)}')
    return [sample]


def required_tests(selected):
    names = ['bootstrap-clean-close']
    for sample in selected:
        names += [f'{sample}-{label}-full-reference-exact' for label in FRAME_LABELS]
        names += [f'{sample}-undo-caret-visible', f'{sample}-history-model-caret', f'{sample}-original-preserved']
        if sample == history.LARGE[0].name: names.append(f'{sample}-original-empty-paragraph-restored')
    return names + ['native-final-resource-cleanup']


def classify(result, selected):
    """PASS only for the complete selected set: every assertion, six exact verified references per document and cleanup."""
    failures = []
    if not selected: failures.append('empty sample selection')
    if result.get('error'): failures.append('error: ' + str(result['error']))
    tests = result.get('tests', [])
    failed = [row.get('name') for row in tests if row.get('status') != 'PASS']
    if failed: failures.append('failed assertions: ' + ', '.join(map(str, failed)))
    present = {row.get('name') for row in tests}
    missing = [name for name in required_tests(selected) if name not in present]
    if missing: failures.append('missing assertions: ' + ', '.join(missing))
    gates = [row for row in result.get('historyGates', []) if row.get('result') != 'PASS']
    if gates: failures.append(f'{len(gates)} failed history gates')
    documents = [row.get('sample') for row in result.get('documents', [])]
    if documents != selected: failures.append(f'documents {documents} != selected {selected}')
    references = result.get('visualReferences', [])
    expected = [f'{sample}-{label}' for sample in selected for label in FRAME_LABELS]
    names = [row.get('name') for row in references]
    if names != expected: failures.append(f'{len(names)} references in order {names} != expected {len(expected)}')
    unverified = [row.get('name') for row in references if row.get('verified') is not True]
    if unverified: failures.append('unverified references: ' + ', '.join(map(str, unverified)))
    mismatched = [row.get('name') for row in references if row.get('verified') is True and (row.get('pixels') != 0 or row.get('maxDelta', 0) != 0)]
    if mismatched: failures.append('pixel mismatch: ' + ', '.join(map(str, mismatched)))
    cleanup = result.get('cleanup', {})
    incomplete = [step for step in CLEANUP_STEPS if cleanup.get(step) is not True]
    if incomplete: failures.append('cleanup incomplete: ' + ', '.join(incomplete))
    exact = sum(row.get('verified') is True and row.get('pixels') == 0 and row.get('maxDelta', 0) == 0 for row in references)
    return {'status': 'FAIL' if failures else 'PASS', 'failures': failures, 'expectedSamples': selected,
            'expectedReferenceCount': len(expected), 'verifiedExactReferenceCount': exact,
            'measurementComplete': bool(selected) and documents == selected and not missing and names == expected,
            'pixelReferencesComplete': bool(selected) and names == expected and exact == len(expected)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--continue-after-caret-failure',action='store_true',help='Collect remaining pixel diagnostics while retaining mandatory caret FAIL and exit1')
    parser.add_argument('--sample',help='Optional single fixture filename for focused failure diagnosis; default all four fixtures')
    args = parser.parse_args()
    try:
        selected = select_samples(args.sample)
    except ValueError as error:
        parser.error(str(error))
    result = {'status': 'RUNNING', 'tests': [], 'scope': 'actual candidate native performance fixtures, same zoom50/warmup3/caret region; separate correctness run, no latency claim',
              'selectedSamples': selected, 'diagnosticContinuation': args.continue_after_caret_failure, 'cleanup': dict.fromkeys(CLEANUP_STEPS, False)}
    def check(name, ok, **data):
        result['tests'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **data})
        if not ok: raise RuntimeError(name)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-candidate-perf-pixels-') as folder:
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
                    result['visualReferences']=[]
                    def frame(label,page=None,require_caret=True):
                        smoke.wait_until(d,'return window.__geulOwnership.stats().sessions.every(s=>!s.active&&!s.queued)',timeout=30)
                        if require_caret:
                            smoke.wait_until(d,"return !!document.querySelector('[data-testid=rhwp-caret]')",timeout=30)
                            page=history.caret_page(d)
                        elif not args.continue_after_caret_failure or page is None or page<0:
                            raise RuntimeError('missing caret cannot waive the page/pixel contract')
                        history.stable_digest(d,page)
                        row=d.js('return window.__rhwpProbe.fullFrameCheck(arguments[0])',page)
                        result['visualReferences'].append({'name':label,**row})
                        check(label+'-full-reference-exact',row.get('verified') is True and row.get('pixels')==0,reference=row)
                    result['documents']=[]
                    for path in [fixtures/'basic-ko.hwp',fixtures/'basic-ko.hwpx',*history.LARGE]:
                        if path.name not in selected:continue
                        original=hashlib.sha256(path.read_bytes()).hexdigest()
                        poc.open_document(d,path);poc.set_zoom(d,50);poc.click_paragraph_start(d)
                        for _ in range(3):
                            poc.press(d,'Right');poc.type_ascii(d,'ab')
                        page=history.caret_page(d)
                        region={'caret':poc.status(d)['caret'],'page':page}
                        frame(path.name+'-warm',page)
                        for index in range(30):
                            poc.press(d,'Right');poc.type_ascii(d,'ab')
                            if (index+1)%10==0:frame(path.name+'-typed-'+str(index+1),history.caret_page(d))
                        before=poc.status(d)
                        before_page=history.caret_page(d)
                        _,undone=history.history_key(d,'z')
                        undo_count=1
                        # The original final HWP paragraph is empty and has no cursor geometry.
                        # Reach that same original state despite timing-dependent typing groups.
                        if path==history.LARGE[0]:
                            while poc.status(d)['paragraphText'] and undo_count<20:
                                _,changed=history.history_key(d,'z');undone=undone and changed;undo_count+=1
                                if not changed:break
                            check(path.name+'-original-empty-paragraph-restored',poc.status(d)['caret']=='0:23:0' and not poc.status(d)['paragraphText'],undoSteps=undo_count)
                        try:
                            smoke.wait_until(d,"return !!document.querySelector('[data-testid=rhwp-caret]')",timeout=5)
                            caret_ready=True
                        except smoke.Failure:
                            caret_ready=False
                        result['tests'].append({'name':path.name+'-undo-caret-visible','status':'PASS' if caret_ready else 'FAIL',
                            'caret':poc.status(d)['caret'],'knownOriginalEndpointFailureEvidence':'original-empty-caret-contract.json' if not caret_ready and path==history.LARGE[0] and poc.status(d)['caret']=='0:23:0' else None})
                        if not caret_ready and not args.continue_after_caret_failure:raise RuntimeError(path.name+'-undo-caret-visible')
                        frame(path.name+'-undo',before_page,require_caret=caret_ready)
                        redone=True
                        for _ in range(undo_count):
                            after,changed=history.history_key(d,'y');redone=redone and changed
                        frame(path.name+'-redo',history.caret_page(d))
                        check(path.name+'-history-model-caret',undone and redone and before['paragraphText']==after['paragraphText']
                              and int(after['localRevision'])>int(before['localRevision']) and history.caret_matches_engine(d))
                        result['documents'].append({'sample':path.name,'sourceSha256':original,'pages':int(after['pages']),
                            'editedRegion':region,'zoom':50,'dpr':d.js('return devicePixelRatio')})
                        history.close_discard(d,path.name);poc.set_zoom(d,100)
                        check(path.name+'-original-preserved',hashlib.sha256(path.read_bytes()).hexdigest()==original)
                    result['engineIdentity']=d.js('return window.__geulOwnership.identity')
                    result['adapterCounters']=d.js('return window.__geulOwnership.counters')
                    d.js('window.__geulOwnership.trim()')
                    check('native-final-resource-cleanup',d.js('const s=window.__geulOwnership.stats();return s.subscribers===0&&s.jobs.activeLeaseCount===0&&s.jobs.pendingCount===0&&s.jobs.uniqueResourceCount===0&&s.jobs.expiryTimerActive===false'))
                finally:
                    try:
                        result['lastObserved'] = d.js("const e=document.querySelector('[data-testid=rhwp-status]');return {status:e?Object.fromEntries(['status','uncertain','revision','localRevision','dirty','history','caret','pages','selection','composing'].map(k=>[k,e.dataset[k]])):null,identity:window.__geulOwnership?.identity,owners:window.__rhwpProbe?.owners(),snapshotCalls:window.__rhwpProbe?.calls.filter(c=>/Snapshot/.test(c.name)).slice(-20),throwAfterDiscard:window.__rhwpProbe?.throwAfterDiscard,jobs:window.__geulOwnership?.stats().jobs,rendering:window.__geulOwnership?.stats(),caretHTML:document.querySelector('.rhwp-caret')?.outerHTML,engineCaret:(()=>{try{return e?.dataset.caret?window.__rhwpProbe?.cursor(e.dataset.caret):null}catch(error){return {error:String(error)}}})()}")
                    except Exception: pass
                    smoke.end_session(d)
                    result['cleanup']['sessionEnded']=True
            result['cleanup']['driverStopped']=True
    except Exception as error:
        result['error']=str(error)
    finally:
        try:
            display.terminate(); display.wait(timeout=10)
            result['cleanup']['displayTerminated']=True
        except Exception as error:
            result.setdefault('error','display cleanup: '+str(error))
        result['existingSaveAssertions'] = poc.RESULTS
        result['historyGates'] = history.GATES
        result['historyChecks'] = history.RESULTS
        result.update(classify(result, selected))
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
