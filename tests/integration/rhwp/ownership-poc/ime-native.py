#!/usr/bin/env python3
"""Candidate D2: bounded actual IBus-Hangul native ordering matrix."""
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
    for name in ('ibus-root','hangul-root','gtk-query'):
        parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--glib-compile',type=Path,default=shutil.which('glib-compile-schemas'))
    parser.add_argument('--setxkbmap',required=True,type=Path)
    args = parser.parse_args()
    ibus_process = None
    ibus_log = tempfile.TemporaryFile(mode="w+")
    result = {'status': 'RUNNING', 'tests': [], 'scope': 'actual IBus-Hangul native event/history protocol and bounded36-attempt ordering matrix; no synthetic DOM composition'}
    def check(name, ok, **data):
        result['tests'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **data})
        if not ok: raise RuntimeError(name)
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none')
        os.environ['PATH'] = os.pathsep.join([str(args.setxkbmap.parent),str(args.webkit_driver.parent),os.environ['PATH']])
        with tempfile.TemporaryDirectory(prefix='geul-candidate-safety-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            ibus = args.ibus_root / 'bin/ibus'
            components = [args.ibus_root/'share/ibus/component',args.hangul_root/'share/ibus/component']
            module = args.ibus_root/'lib/gtk-3.0/3.0.0/immodules/im-ibus.so'
            cache=work/'immodules.cache'
            with cache.open('w') as f:
                subprocess.run([str(args.gtk_query),str(module)],stdout=f,check=True)
            # IBus tests presence, so even IBUS_USE_PORTAL=0 enables its portal.
            os.environ.pop('IBUS_USE_PORTAL',None)
            os.environ.update(GSETTINGS_BACKEND='memory',GTK_IM_MODULE='ibus',GTK_IM_MODULE_FILE=str(cache),XMODIFIERS='@im=ibus',
                              IBUS_COMPONENT_PATH=os.pathsep.join(map(str,components)))
            schema_dir=work/'hangul-schemas';schema_dir.mkdir()
            original_schema=next((args.hangul_root/'share/gsettings-schemas').rglob('org.freedesktop.ibus.engine.hangul.gschema.xml'))
            shutil.copy2(original_schema,schema_dir/original_schema.name)
            (schema_dir/'hangul.gschema.override').write_text("[org.freedesktop.ibus.engine.hangul]\ninitial-input-mode='hangul'\n")
            if not args.glib_compile:raise RuntimeError('glib-compile-schemas required for isolated Hangul defaults')
            subprocess.run([str(args.glib_compile),str(schema_dir)],check=True,capture_output=True)
            os.environ['GSETTINGS_SCHEMA_DIR']=str(schema_dir)
            schema_roots=[str(next((root/'share/gsettings-schemas').iterdir())) for root in (args.ibus_root,args.hangul_root)]
            os.environ['XDG_DATA_DIRS']=os.pathsep.join(schema_roots+[os.environ.get('XDG_DATA_DIRS','/usr/local/share:/usr/share')])
            clean_env={k:v for k,v in os.environ.items() if k!='LD_LIBRARY_PATH'}
            # Hangul requires the IBus config component even with memory GSettings.
            # This D-Bus session and XDG config directory are private to the run.
            ibus_process=subprocess.Popen([str(args.ibus_root/'bin/ibus-daemon'),'--replace','--xim','--panel=disable','--config='+str(args.ibus_root/'libexec/ibus-dconf'),'--emoji-extension=disable','--cache=none'],env=clean_env,stdout=ibus_log,stderr=subprocess.STDOUT)
            deadline=time.monotonic()+15
            while True:
                probe=subprocess.run([str(ibus),'list-engine'],env=clean_env,capture_output=True,text=True)
                if probe.returncode==0 and 'hangul' in probe.stdout:break
                if ibus_process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('isolated ibus hangul registration unavailable')
                time.sleep(.1)
            result['inputEnvironment']={'ibusVersion':subprocess.check_output([str(ibus),'version'],env=clean_env,text=True).strip(),'hangul':'1.5.5','GTK_IM_MODULE':'ibus','nativeKeys':True,'isolatedDisplay':True,'settingsBackend':'memory; temporary Hangul schema initial-input-mode=hangul override, no host settings writes'}
            fixtures = work / 'fixtures' 
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            subprocess.run(['node', str(HERE / 'generate.mjs'), str(work)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            smoke.DRIVER_LOG = str(work/'ime-driver.log')
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
                    # Establish actual engine activation and composition before interpreting history assertions.
                    activated=subprocess.run([str(ibus),'engine','hangul'],env=clean_env,capture_output=True,text=True)
                    engine=subprocess.run([str(ibus),'engine'],env=clean_env,capture_output=True,text=True)
                    result['activationProbe']={'setExit':activated.returncode,'setError':activated.stderr.strip(),
                        'queryExit':engine.returncode,'engine':engine.stdout.strip(),'portalEnvironment':'unset'}
                    check('native-hangul-engine-active',activated.returncode==0 and engine.stdout.strip()=='hangul')
                    poc.open_document(d,fixtures/'basic-ko.hwp');poc.click_paragraph_start(d);d.js(poc.EVENT_LOG)
                    subprocess.run(['env','-u','LD_LIBRARY_PATH',str(args.xdotool),'type','--delay','90','rk'],check=True,capture_output=True)
                    time.sleep(.8)
                    result['compositionPreflight']=d.js("return {events:window.__imeLog,compositionEvents:window.__imeLog.filter(e=>e[0].startsWith('composition')).length}")
                    result['compositionPreflightAttempts']=[{'mode':'initial engine mode',**result['compositionPreflight']}]
                    if not result['compositionPreflight']['compositionEvents']:
                        # Switch the real engine's input mode through X11, never DOM events.
                        d.js('window.__imeLog=[]')
                        subprocess.run(['env','-u','LD_LIBRARY_PATH',str(args.xdotool),'key','shift+space'],check=True,capture_output=True)
                        subprocess.run(['env','-u','LD_LIBRARY_PATH',str(args.xdotool),'type','--delay','90','rk'],check=True,capture_output=True)
                        time.sleep(.8)
                        result['compositionPreflight']=d.js("return {events:window.__imeLog,compositionEvents:window.__imeLog.filter(e=>e[0].startsWith('composition')).length,activeElement:document.activeElement?.tagName}")
                        result['compositionPreflightAttempts'].append({'mode':'native Shift+space switch',**result['compositionPreflight']})
                    check('native-real-composition-preflight',result['compositionPreflight']['compositionEvents']>0)
                    history.close_discard(d,'basic-ko.hwp')
                    history.scenario_ime(d,fixtures,str(args.xdotool),str(ibus))
                    for fmt in ('hwp','hwpx'):history.close_discard(d,'basic-ko.'+fmt)
                    history.scenario_ime_gap_matrix(d,fixtures,str(args.xdotool),str(ibus),rounds=1)
                    result['nativeOrdering']=history.REPORT
                    result['classification']='FAIL' if any(g['result']=='FAIL' for g in history.GATES) else 'PASS' if history.GATES and all(g['result']=='PASS' for g in history.GATES) else 'INCONCLUSIVE'
                    result['status']=result['classification']
                    for fmt in ('hwp','hwpx'):history.close_discard(d,'basic-ko.'+fmt)
                    result['engineIdentity'] = d.js('return window.__geulOwnership.identity')
                    d.js('window.__geulOwnership.trim()')
                    check('native-final-resource-cleanup', d.js('const s=window.__geulOwnership.stats();return s.subscribers===0&&s.jobs.activeLeaseCount===0&&s.jobs.pendingCount===0&&s.jobs.uniqueResourceCount===0'))
                    # Preserve INCONCLUSIVE if no real target ordering was observed.
                finally:
                    try:
                        result['lastObserved'] = d.js("const e=document.querySelector('[data-testid=rhwp-status]');return {status:e?Object.fromEntries(['status','uncertain','revision','localRevision','dirty','history'].map(k=>[k,e.dataset[k]])):null,identity:window.__geulOwnership?.identity,owners:window.__rhwpProbe?.owners(),snapshotCalls:window.__rhwpProbe?.calls.filter(c=>/Snapshot/.test(c.name)).slice(-20),throwAfterDiscard:window.__rhwpProbe?.throwAfterDiscard,jobs:window.__geulOwnership?.stats().jobs}")
                    except Exception: pass
                    smoke.end_session(d)
                    if (work/'ime-driver.log').exists():
                        result['driverLogTail']=(work/'ime-driver.log').read_text(errors='replace')[-6000:]
    except Exception as error:
        result['status']='FAIL';result['error']=str(error)
    finally:
        if ibus_process is not None:
            ibus_process.terminate();ibus_process.wait(timeout=10)
        ibus_log.seek(0);result['ibusLogTail']=ibus_log.read()[-2500:];ibus_log.close()
        display.terminate(); display.wait(timeout=10)
        result['nativeOrdering'] = history.REPORT
        result['nativeHelperAssertions'] = poc.RESULTS
        result['historyGates'] = history.GATES
        result['historyChecks'] = history.RESULTS
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>') + '\n')
    return 0 if result['status']=='PASS' else 1


if __name__=='__main__':
    raise SystemExit(main())
