#!/usr/bin/env python3
"""Narrow D2 diagnosis with trusted native events, not a replacement acceptance predicate.

Run only in the existing private X11/IBus launcher. Uses generated fixtures;
local evidence includes their text and actual event payloads. No synthetic input,
composition dispatch, performance protocol, application install, or global settings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'tests/e2e'), str(ROOT / 'tests/integration/rhwp')]
import tauri_smoke as smoke
import rhwp_poc as poc

INSTALL = r"""
window.__d2Ready=false;
(async()=>{
  if(typeof window.__geulTraceRecord!=='function')throw Error('test trace hooks required');
  const facade=await (await import('/src/components/Editor/rhwp/rhwpModule.ts')).loadRhwpModule();
  const open=facade.openDocument; let active=null, serial=0;
  const record=(kind,detail)=>window.__geulTraceRecord(kind,detail);
  window.__d2Read=()=>active?{id:active.id,text:active.doc.getTextFileText()}:null;
  facade.openDocument=function(...args){
    const doc=open.apply(this,args), id=++serial;
    for(const name of ['hitTest','insertText','insertTextInCell','deleteText','deleteTextInCell',
      'deleteRange','deleteRangeInCell','saveSnapshot','restoreSnapshot','discardSnapshot','free']){
      const original=doc[name];if(!original)continue;
      doc[name]=function(...args){
        if(name==='free'){if(active?.id===id)active=null;return original.apply(this,args);}
        active={id,doc:this};
        record('native:model:before',{id,name,args:JSON.stringify(args)});
        const result=original.apply(this,args);
        record('native:model:after',{id,name,text:this.getTextFileText()});
        return result;
      };
    }
    return doc;
  };
  for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup','focus','blur']){
    document.addEventListener(type,e=>{
      if(!e.target?.matches?.('.rhwp-input,#d2-plain'))return;
      record('native:event',{type,target:e.target.id==='d2-plain'?'plain':'editor',
        data:typeof e.data==='string'?e.data:null,key:e.key??null,code:e.code??null,
        keyCode:e.keyCode??null,ctrl:!!e.ctrlKey,meta:!!e.metaKey,isComposing:!!e.isComposing,
        inputType:e.inputType??null,trusted:e.isTrusted,value:e.target.value??null});
    },true);
  }
  window.__d2Ready=true;
})().catch(e=>window.__d2Error=String(e));
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def order(trace):
    """Same original E/U/F observations, limited to the initial trial (no later typing)."""
    records = trace['records']
    empty = [r[0] for r in records if r[2] == 'dom:compositionend' and r[3]['length'] == 0]
    final = [r[0] for r in records if r[2] == 'dom:input' and r[3]['inputType'] == 'insertFromComposition' and r[3]['length'] > 0]
    gap = lambda seq: any(e < seq < f for e in empty for f in final)
    requests = [r for r in records if r[2] == 'command:request' and r[3]['id'] == 'edit.undo']
    command = any(gap(r[0]) and r[3]['reason'] == 'composing' for r in requests)
    chord = any(gap(r[0]) and r[2] in ('dom:keydown', 'dom:keyup') and r[3].get('key') == 'mod:KeyZ' for r in records)
    accepted = any(r[2] == 'command:dispatch' and r[3]['id'] == 'edit.undo' and r[3]['accepted'] for r in records)
    return {'emptyEnds': empty, 'finalInserts': final, 'undoRequests': requests,
            'commandInGap': command, 'chordInGap': chord, 'observed': command or chord, 'accepted': accepted}


def phase(trace):
    return next((r[3] for r in reversed(trace['records']) if r[3] and 'historyUndo' in r[3]), None)


def validate_initial(row):
    first, prefix, observed = row['initial'], row['prefix'], row['observation']
    delta = int(first['localRevision']) - int(prefix['localRevision'])
    assert row['initialPhase'] is not None
    if row['mode'] == 'cancel-then-undo':
        assert first['paragraphText'] == row['base'] and delta == 1
        assert row['initialPhase']['historyUndo'] == 0
    elif observed['accepted']:
        assert first['paragraphText'] == prefix['paragraphText'] and delta == 2
        assert first['composing'] == 'false'
    elif first['composing'] == 'true' and not observed['finalInserts']:
        assert first['paragraphText'] == prefix['paragraphText'] + '가' and delta == 0
    else:
        assert first['paragraphText'] == prefix['paragraphText'] + '가' and delta == 1


def validate_final(row):
    validate_initial(row)
    final, state = row['final'], row['finalPhase']
    assert final['status'] == 'ready' and final['uncertain'] == 'false'
    assert final['localRevision'] == final['revision']
    expected_undo = 1 if row['mode'] == 'cancel-then-undo' else 2
    assert state['historyUndo'] == expected_undo and state['historyRedo'] == 0
    for key in ('session', 'generation', 'epoch'):
        assert state[key] == row['initialPhase'][key]
    ids = {r[3]['id'] for r in row['initialTrace']['records'] if r[2].startswith('native:model:')}
    assert ids == {row['finalModel']['id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('app', 'driver', 'xdotool', 'ibus', 'out'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    out = Path(args.out).resolve(); out.mkdir(parents=True, exist_ok=False)
    report = {'execution': 'RUNNING', 'd2Outcome': 'INCONCLUSIVE', 'syntheticComposition': False,
              'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'appSha256': sha(args.app), 'harnessSha256': sha(__file__),
              'ibusSyncMode': os.environ.get('IBUS_ENABLE_SYNC_MODE', 'unset (GTK3 default asynchronous)'), 'trials': []}
    smoke.APP = str(Path(args.app).resolve()); smoke.DRIVER_LOG = out / 'driver.log'
    poc.ROOT = ROOT
    run = lambda *command: subprocess.run(['env', '-u', 'LD_LIBRARY_PATH', *command], check=True, capture_output=True, text=True).stdout
    key = lambda *keys: run(args.xdotool, 'key', '--delay', '0', *keys)
    typing = lambda text: run(args.xdotool, 'type', '--delay', '80', text)
    trace = lambda d: d.js('return window.__geulTrace')
    reset = lambda d: d.js('window.__geulTrace={seq:0,dropped:0,records:[]}')
    try:
        fixtures = out / 'fixtures'
        generated = run('node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(fixtures))
        report['fixtureMetadata'] = json.loads(generated)
        report['fixtures'] = {p.name: sha(p) for p in fixtures.glob('basic-ko.hwp*')}
        with smoke.tauri_driver(args.driver, 4444, str(out / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, "return !!document.querySelector('.document-bar')", timeout=60)
                window = run(args.xdotool, 'search', '--onlyvisible', '--name', '^geul$').split()[-1]
                run(args.xdotool, 'windowfocus', '--sync', window)
                run(args.ibus, 'engine', 'hangul')
                assert run(args.ibus, 'engine').strip() == 'hangul'
                report['ibusVersion'] = run(args.ibus, 'version').strip()
                d.native_key_tool = args.xdotool
                d.js(INSTALL)
                smoke.wait_until(d, 'return window.__d2Ready===true || !!window.__d2Error')
                assert d.js('return window.__d2Ready'), d.js('return window.__d2Error')
                d.js("window.__d2Move=null;window.addEventListener('mousemove',e=>window.__d2Move=[e.clientX,e.clientY],true)")
                poc.perform(d, [{'type': 'pointer', 'id': 'calibrate', 'parameters': {'pointerType': 'mouse'},
                                 'actions': [{'type': 'pointerMove', 'x': 100, 'y': 100, 'origin': 'viewport'}]}])
                smoke.wait_until(d, 'return !!window.__d2Move')
                measured = d.js('return window.__d2Move'); d.pointer_scale = (100 / measured[0], 100 / measured[1])
                d.js("fetch('/rhwp/BUILD.json').then(r=>r.json()).then(i=>window.__d2Build=i)")
                smoke.wait_until(d, 'return !!window.__d2Build')
                report['servedGeneration'] = d.js('return window.__d2Build')
                for fmt in ('hwp', 'hwpx'):
                    path = fixtures / f'basic-ko.{fmt}'
                    for mode in ('ctrl-during-preedit', 'end-then-undo', 'cancel-then-undo'):
                        poc.open_document(d, path); poc.click_paragraph_start(d)
                        base = poc.status(d)['paragraphText']
                        typing('gk'); key('End'); prefix = poc.settle(d, 'prefix')
                        assert prefix['paragraphText'].startswith('하')
                        reset(d); typing('rk')
                        if mode == 'cancel-then-undo': key('BackSpace', 'BackSpace', 'ctrl+z')
                        elif mode == 'end-then-undo': key('End', 'ctrl+z')
                        else: key('ctrl+z')
                        first = poc.settle(d, mode); initial = trace(d); observed = order(initial)
                        assert initial['dropped'] == 0
                        assert all(r[3]['trusted'] for r in initial['records'] if r[2] == 'native:event')
                        row = {'format': fmt, 'mode': mode, 'base': base, 'prefix': prefix,
                               'initial': first, 'observation': observed, 'initialTrace': initial, 'initialPhase': phase(initial)}
                        validate_initial(row)
                        # Initial E/U/F classification ends here; subsequent typing has a new trace.
                        reset(d)
                        if mode == 'cancel-then-undo':
                            assert first['paragraphText'] == base
                            typing('rk'); key('End'); genuine = poc.settle(d, 'genuine subsequent typing')
                            assert genuine['paragraphText'] == '가' + base
                            expected = '가' + base
                        else:
                            if first['composing'] == 'true': key('End'); poc.settle(d, 'native finalization')
                            if not observed['accepted']: key('ctrl+z'); poc.settle(d, 'later explicit Undo')
                            assert poc.status(d)['paragraphText'] == prefix['paragraphText']
                            key('ctrl+y'); redone = poc.settle(d, 'Redo')
                            expected = prefix['paragraphText'] + '가'
                            assert redone['paragraphText'] == expected
                        key('ctrl+z'); undone = poc.settle(d, 'recovery Undo')
                        key('ctrl+y'); final = poc.settle(d, 'recovery Redo')
                        assert final['paragraphText'] == expected
                        assert final['status'] == 'ready' and final['uncertain'] == 'false'
                        assert final['localRevision'] == final['revision']
                        recovery = trace(d); final_phase = phase(recovery)
                        assert final_phase is not None and final_phase['historyRedo'] == 0
                        row.update({'recoveryTrace': recovery, 'undone': undone, 'final': final,
                                    'finalModel': d.js('return window.__d2Read()'), 'finalPhase': final_phase, 'safe': True})
                        assert row['finalModel'] is not None
                        validate_final(row)
                        report['trials'].append(row)
                        if not poc.close_tab(d, path.name):
                            d.js("[...document.querySelectorAll('.document-tab__close')].find(b=>b.getAttribute('aria-label').includes(arguments[0])).click()", path.name)
                            smoke.wait_until(d, "return !!document.querySelector('[data-testid=discard-dialog]')")
                            d.js("document.querySelector('[data-testid=discard-confirm]').click()")
                            smoke.wait_until(d, "return !document.querySelector('[data-testid=rhwp-status]')")
                # Browser control: the same real input without the editor's IME handlers.
                report['plainControls'] = []
                for mode in ('ctrl-during-preedit', 'end-then-undo', 'cancel-then-undo'):
                    d.js("document.querySelector('#d2-plain')?.remove();const t=document.createElement('textarea');t.id='d2-plain';t.style.cssText='position:fixed;left:200px;top:200px;width:400px;height:100px;z-index:99999';document.body.append(t)")
                    poc.click(d, 250, 230); reset(d); typing('rk')
                    if mode == 'cancel-then-undo': key('BackSpace', 'BackSpace', 'ctrl+z')
                    elif mode == 'end-then-undo': key('End', 'ctrl+z')
                    else: key('ctrl+z')
                    # A real key is a flush boundary; never synthesize an input/composition event.
                    key('End'); poc.settle(d, 'plain control')
                    raw = trace(d)
                    assert raw['dropped'] == 0
                    assert all(r[3]['trusted'] for r in raw['records'] if r[2] == 'native:event')
                    report['plainControls'].append({'mode': mode, 'value': d.js("return document.querySelector('#d2-plain').value"), 'trace': raw})
                report['execution'] = 'PASS'
                # Observation remains separate from safety. Existing native predicate is not changed.
                report['observedTrialCount'] = sum(r['observation']['observed'] for r in report['trials'])
                report['d2Outcome'] = 'PASS' if report['observedTrialCount'] else 'INCONCLUSIVE'
            finally:
                smoke.end_session(d)
    except Exception as error:
        report.update(execution='FAIL', error=type(error).__name__ + ': ' + str(error))
        try:
            report['failureTrace'] = trace(d)
            report['failureStatus'] = poc.status(d)
        except Exception:
            pass  # A disconnected driver is not replaced with fabricated state.
        traceback.print_exc()
    finally:
        (out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(report['execution'], 'D2', report['d2Outcome'])
    return 0 if report['execution'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
