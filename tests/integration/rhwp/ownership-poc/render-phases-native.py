#!/usr/bin/env python3
"""Diagnostic Canvas attribution for one native D4 fixture; no acceptance claim.

Uses the canonical scenario and frame boundary with additional observer overhead.
Records operation names, dimensions, IDs and timings, never image/document data.
The existing probe, scenario, candidate binary and product files stay unchanged.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(HERE))
import native
import native_probe
import undo_native as history
from native import smoke, poc


def diagnostic_install():
    script = native_probe.INSTALL
    start = script.index('  // Identical read-only Canvas timing')
    end = script.index('  p.selectionAt =', start)
    script = script[:start] + r'''
  const surfaceIds=new WeakMap();let surfaceSerial=0;
  const surface=c=>{
    if(!surfaceIds.has(c))surfaceIds.set(c,++surfaceSerial);
    return {id:surfaceIds.get(c),width:c.width,height:c.height,
      attached:!!c.isConnected,pageCanvas:!!c.classList?.contains('rhwp-page__canvas')};
  };
  for(const name of ['drawImage','getImageData','putImageData','clearRect']){
    const original=CanvasRenderingContext2D.prototype[name];
    CanvasRenderingContext2D.prototype[name]=function(...args){
      const at=performance.now(),phase=p.phase??null,target=surface(this.canvas);
      const source=name!=='drawImage'?null:args[0] instanceof HTMLCanvasElement
        ?{kind:'canvas',...surface(args[0])}:args[0] instanceof HTMLImageElement
        ?{kind:'image',width:args[0].naturalWidth,height:args[0].naturalHeight}:null;
      try{return original.apply(this,args);}
      finally{p.calls.push({name:'canvas:'+name,at,ms:performance.now()-at,phase,target,source});}
    };
  }
  const src=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  if(src?.set){
    const imageStarts=new WeakMap();let imageSerial=0;
    Object.defineProperty(HTMLImageElement.prototype,'src',{...src,set(value){
      const id=++imageSerial,at=performance.now(),phase=p.phase??null;
      imageStarts.set(this,{id,at});
      const loaded=event=>{
        this.removeEventListener('load',loaded);this.removeEventListener('error',loaded);
        if(imageStarts.get(this)?.id!==id)return;
        p.calls.push({name:'image:'+event.type,at,ms:performance.now()-at,id,
          width:this.naturalWidth,height:this.naturalHeight,phase});
      };
      this.addEventListener('load',loaded);this.addEventListener('error',loaded);
      try{return src.set.call(this,value);}
      finally{p.calls.push({name:'image:src',at,ms:performance.now()-at,id,phase});}
    }});
  }
''' + script[end:]
    original = 'value=original.apply(this,args);completed=true;'
    assert script.count(original) == 1
    script = script.replace(original, 'const previous=p.phase;p.phase=name;try{value=original.apply(this,args);completed=true;}finally{p.phase=previous;}')
    return script.replace("import('/rhwp/rhwp.js')", 'Promise.resolve(window.__geulOwnership.probeEngine())').replace('/rhwp/rhwp_bg.wasm', '/__ownership_candidate__/rhwp_bg.wasm')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'webkit-driver', 'xvfb', 'xdotool', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError('Preserve previous diagnostic output before repeating')
    result = {'status': 'RUNNING', 'scope': 'single chemical HWP; additional observers; diagnostic only, not official D4 acceptance',
              'protocol': 'unchanged undo_native.scenario_perf/MEASURE', 'observerSourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    display = subprocess.Popen([str(args.xvfb), '-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        os.environ.update(DISPLAY=':' + display.stdout.readline().strip(), GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1', NO_AT_BRIDGE='1', GTK_A11Y='none', LIBGL_ALWAYS_SOFTWARE='1', WEBKIT_DISABLE_DMABUF_RENDERER='1')
        os.environ['PATH'] = str(args.webkit_driver.parent) + os.pathsep + os.environ['PATH']
        with tempfile.TemporaryDirectory(prefix='geul-render-phases-') as folder:
            work = Path(folder)
            for name in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR'):
                target = work / name; target.mkdir(); os.environ[name] = str(target)
            fixtures = work / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures)], check=True, capture_output=True)
            smoke.APP = str(args.app.resolve())
            with smoke.tauri_driver(str(args.driver.resolve()), 4489, str(work / 'data')) as start:
                driver = start()
                try:
                    smoke.wait_until(driver, "return !!document.querySelector('.document-bar__open')", timeout=30)
                    poc.open_document(driver, fixtures / 'basic-ko.hwpx')
                    native_probe.install(driver, diagnostic_install())
                    history.close_discard(driver, 'basic-ko.hwpx')
                    windows = subprocess.check_output([str(args.xdotool), 'search', '--onlyvisible', '--name', '^geul'], text=True).split()
                    subprocess.run([str(args.xdotool), 'windowfocus', '--sync', windows[-1]], check=True)
                    driver.native_key_tool = str(args.xdotool)
                    driver.busy_probe = False
                    fixture = next(p for p in history.LARGE if p.name == '연구노트(화학).hwp')
                    history.scenario_perf(driver, fixture, work)
                    result['rawStages'] = driver.js('return window.__stages')
                    result['engineIdentity'] = driver.js('return window.__geulOwnership.identity')
                    result['adapterCounters'] = driver.js('return window.__geulOwnership.counters')
                    result['sourceSha256'] = hashlib.sha256(fixture.read_bytes()).hexdigest()
                finally:
                    smoke.end_session(driver)
        row = history.REPORT['perf'][0]
        result['measurementComplete'] = all(row.get(k, {}).get('n') == n and row[k]['timeouts'] == 0 for k, n in [('groupStart', 30), ('extend', 30), ('undo', 25), ('redo', 20), ('afterUndo', 5)])
        result['status'] = 'PASS' if result['measurementComplete'] else 'FAIL'
    except Exception as error:
        result.update(status='FAIL', error=str(error))
    finally:
        display.terminate(); display.wait(timeout=10)
        result.update(measurements=history.REPORT, gates=history.GATES)
        result['officialGateStatus'] = 'PASS' if history.GATES and all(g['result'] == 'PASS' for g in history.GATES) else 'FAIL'
        clean = json.dumps(result, ensure_ascii=False, indent=2).replace(str(ROOT), '<workspace>').replace(str(Path.home()), '<home>')
        args.output.write_text(clean + '\n')
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
