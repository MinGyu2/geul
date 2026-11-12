#!/usr/bin/env python3
"""Additional D2 native safety oracles. Run in the isolated X11/IBus launcher.

The original undo_native predicates are untouched. Only X11 keys/pointer events
produce editor input. JS reads state, installs observers and opens generated files.
Private raw evidence stays outside the public repository.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'tests/integration/rhwp'), str(ROOT / 'tests/integration/wordcraft')]
import undo_native as c
import wordcraft_poc as wc

CASES = ('repeat-syllables', 'same-after-click', 'new-start-after-click',
         'ordinary-key-between', 'different-after-click', 'english', 'shift-redo',
         'caret', 'focus-native', 'tab-ownership', 'reload-generation', 'close-reopen',
         'busy-key', 'busy-click', 'busy-button')
CROSS = ('rhwp-wordcraft', 'wordcraft-rhwp')


def run_native(d, fixtures, xdotool, ibus):
    poc, smoke = c.poc, c.smoke
    out = Path(os.environ['D2_SUPPORTED_OUT'])
    rows = c.REPORT.setdefault('supportedNative', [])
    selected = set(filter(None, os.environ.get('D2_ONLY', '').split(',')))
    c.REPORT['selectedScenarios'] = sorted(selected) if selected else 'full matrix'
    run = lambda *a: subprocess.run(['env', '-u', 'LD_LIBRARY_PATH', *a], check=True, capture_output=True, text=True).stdout.strip()
    key = lambda *keys: run(xdotool, 'key', '--delay', '30', *keys)
    typ = lambda text: run(xdotool, 'type', '--delay', '30', text)
    latin = False  # launcher's private Hangul initial-input-mode='hangul'
    def engine(name):
        nonlocal latin
        assert run(ibus, 'engine') == 'hangul'
        requested_latin = name == 'latin'
        if latin != requested_latin:
            key('Hangul')  # real native Hangul/Latin toggle within the supported engine
            latin = requested_latin

    window = run(xdotool, 'search', '--onlyvisible', '--name', '^geul').split()[-1]
    run(xdotool, 'windowfocus', '--sync', window)
    # Calibrate window-relative X11 coordinates against observed DOM movement.
    d.js("window.__d2Move=null;window.addEventListener('mousemove',e=>window.__d2Move=[e.clientX,e.clientY],true)")
    points = []
    for n in (100, 200):
        d.js('window.__d2Move=null')
        run(xdotool, 'mousemove', '--window', window, str(n), str(n))
        smoke.wait_until(d, 'return !!window.__d2Move')
        points.append(d.js('return window.__d2Move'))
    scale = [100 / (points[1][i] - points[0][i]) for i in (0, 1)]
    origin = [100 - points[0][i] * scale[i] for i in (0, 1)]

    def click_point(point):
        xy = [str(round(point[i] * scale[i] + origin[i])) for i in (0, 1)]
        run(xdotool, 'mousemove', '--window', window, *xy, 'click', '1')

    def click(css):
        click_point(d.js('const r=document.querySelector(arguments[0]).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]', css))

    def focus_start(docx=False):
        # Click the visible page intersection; fixed first-line coordinates can
        # fall below the scroller after engine-specific notice panels change size.
        selector = '.docx-page' if docx else '.rhwp-page'
        geometry=d.js("""const p=document.querySelector(arguments[0]),s=document.querySelector('.editor__scroll');
          s.scrollTop=0;s.scrollLeft=0;
          const r=p.getBoundingClientRect(),q=s.getBoundingClientRect();
          const left=Math.max(r.left,q.left,0),right=Math.min(r.right,q.right,innerWidth);
          const top=Math.max(r.top,q.top,0),bottom=Math.min(r.bottom,q.bottom,innerHeight);
          const point=[left+Math.min(150,(right-left)/2),top+Math.min(20,(bottom-top)/2)];
          return {page:{x:r.x,y:r.y,width:r.width,height:r.height},scroll:{x:q.x,y:q.y,width:q.width,height:q.height},
            point,visible:right>left&&bottom>top,hit:document.elementFromPoint(...point)?.className,
            pageHit:!!document.elementFromPoint(...point)?.closest(arguments[0])};""",selector)
        c.REPORT['lastFocusGeometry']=geometry
        assert geometry['visible'] and geometry['pageHit'],json.dumps(geometry)
        click_point(geometry['point'])
        smoke.wait_until(d,"return document.activeElement?.matches('.editor__scroll .rhwp-input')")
        key('Home')

    def tab(name):
        # Visible text includes a localized state suffix. Resolve the exact backend
        # document identity instead of relying on presentation or HWP/HWPX prefixes.
        sid = next(s['sessionId'] for s in poc.ipc(d, 'document_sessions')['ok'] if s['displayName'] == name)
        selector = f'.document-tab__select[data-session="{sid}"]'
        click(selector)
        smoke.wait_until(d, "return document.querySelector(arguments[0])?.getAttribute('aria-selected')==='true'", selector)

    d.js("""window.__d2Events=[];
      for(const type of ['keydown','keyup','compositionstart','compositionupdate','compositionend','beforeinput','input','blur','focus','mousedown','click'])
        document.addEventListener(type,e=>{
          if(!e.target?.matches?.('.rhwp-input')&&!['mousedown','click'].includes(type))return;
          window.__d2Events.push({type,trusted:e.isTrusted,data:e.data??null,key:e.key??null,code:e.code??null,
            inputType:e.inputType??null,composing:!!e.isComposing,target:e.target.className,t:performance.now()});
        },true);""")

    # The legacy probe's active model follows hitTest, not tab activation. Bind
    # each actual opened handle to its authoritative session before comparing.
    d.js("""window.__d2ModelReady=false;
      (async()=>{
        const facade=await(await import('/src/components/Editor/rhwp/rhwpModule.ts')).loadRhwpModule();
        const open=facade.openDocument,models=new Map(),owners=new WeakMap(),live=new Map();let serial=0;
        facade.openDocument=function(...args){
          const doc=open.apply(this,args),id=++serial,free=doc.free;
          live.set(id,{doc,id});
          doc.free=function(...a){live.delete(id);for(const [sid,row] of models)if(row.doc===this)models.delete(sid);return free.apply(this,a)};
          return doc;
        };
        window.__d2ModelCheck=(sid,expected,s,p)=>{
          const unbound=[...live.values()].filter(row=>!owners.has(row.doc));
          if(unbound.length>1)throw Error('ambiguous live model ownership');
          if(unbound.length===1){models.set(sid,unbound[0]);owners.set(unbound[0].doc,sid)}
          const row=models.get(sid);if(!row)throw Error('no actual model for session '+sid);
          const actual=row.doc.getTextRange(s,p,0,row.doc.getParagraphLength(s,p));
          return {equals:actual===expected,session:sid,modelId:row.id,expectedLength:[...expected].length,actualLength:[...actual].length};
        };
        window.__d2ModelReady=true;
      })().catch(e=>window.__d2ModelError=String(e));""")
    smoke.wait_until(d,'return window.__d2ModelReady||!!window.__d2ModelError')
    assert d.js('return window.__d2ModelReady'),d.js('return window.__d2ModelError')

    def reset():
        d.js('window.__d2Events=[];window.__geulTrace={seq:0,dropped:0,records:[]}')

    def state(label, docx=False):
        st = (wc.settle if docx else poc.settle)(d, label)
        st['observedAt'] = d.js('return performance.now()')
        st['session'] = d.js("return document.querySelector('.document-tab__select[aria-selected=true]')?.dataset.session")
        if docx:
            st['localRevision'] = st['revision']
        else:
            at = st['caret'].split('@')[0].split(':')
            st['modelCheck'] = d.js('return window.__d2ModelCheck(arguments[0],arguments[1],arguments[2],arguments[3])',st['session'],st['paragraphText'],int(at[0]),int(at[1]))
        c.REPORT['lastNativeState'] = {'state': st, 'events': d.js('return window.__d2Events'), 'trace': d.js('return window.__geulTrace')}
        return st

    def record(fmt, case, assertions, states):
        events = d.js('return window.__d2Events')
        trace = d.js('return window.__geulTrace')
        native = [e for e in events if e['type'] in ('keydown', 'input', 'compositionend')]
        assertions = {**assertions, 'trustedNativeInput': bool(native) and all(e['trusted'] for e in events),
                      'traceComplete': trace['dropped'] == 0,
                      'modelTextMatches': all(st['modelCheck']['equals'] is True for st in states.values() if 'modelCheck' in st)}
        row = {'format': fmt, 'case': case, 'assertions': assertions, 'states': states,
               'events': events, 'trace': trace}
        rows.append(row)
        (out / 'supplement-rows.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2)+'\n')
        c.gate('D2-supported', f'{fmt}:{case}', all(v is True for v in assertions.values()), json.dumps(assertions))

    for fmt in ('hwp', 'hwpx'):
        for case in CASES:
            if selected and f'{fmt}:{case}' not in selected:
                continue
            path = out / f'{fmt}-{case}.{fmt}'
            path.write_bytes((fixtures / f'basic-ko.{fmt}').read_bytes())
            poc.open_document(d, path); focus_start(); engine('hangul')
            base = state('base'); text = base['paragraphText']; rev = int(base['localRevision'])
            reset(); states = {'base': base}; checks = {}
            if case in ('repeat-syllables', 'same-after-click', 'new-start-after-click', 'ordinary-key-between', 'different-after-click'):
                typ('rkrk' if case == 'repeat-syllables' else 'rk'); key('End')
                first = state('first commit'); states['first'] = first
                checks['firstExact'] = first['paragraphText'] == ('가가' if case == 'repeat-syllables' else '가') + text
                if case != 'repeat-syllables':
                    point = poc.caret_client(d); click_point([point[0], point[1]+point[2]/2]); state('click')
                    if case == 'ordinary-key-between': key('space')
                    typ('sk' if case == 'different-after-click' else 'rk'); key('End')
                final = state('new input preserved'); states['final'] = final
                expected = '가가'+text if case=='repeat-syllables' else '가'+text+(' 가' if case=='ordinary-key-between' else '나' if case=='different-after-click' else '가')
                checks['newInputPreserved'] = final['paragraphText'] == expected
                if case == 'new-start-after-click':
                    checks['newCompositionStart'] = sum(e['type']=='compositionstart' for e in d.js('return window.__d2Events')) >= 2
            elif case in ('english', 'shift-redo'):
                engine('latin'); typ('English continuous input 123')
                final = state('English'); states['typed'] = final
                key('ctrl+z'); undone = state('Undo'); key('ctrl+shift+z'); final = state('Shift Redo')
                states.update(undone=undone, final=final)
                checks['exactTextAndRedo'] = final['paragraphText'] == 'English continuous input 123'+text and undone['paragraphText'] == text
                checks['cursorRestored'] = final['caret'] == states['typed']['caret'] and undone['caret'] == base['caret']
                checks['revisionForward'] = int(final['localRevision']) == int(states['typed']['localRevision'])+2
            elif case == 'caret':
                typ('rk'); key('Left'); mid = state('caret after IME'); typ('sk'); key('End'); final = state('caret new input')
                states.update(mid=mid, final=final)
                checks['anchoredInsertion'] = mid['paragraphText']=='가'+text and final['paragraphText']=='나가'+text
                key('ctrl+z'); un=state('caret undo'); key('ctrl+y'); re=state('caret redo'); states.update(undone=un, redone=re)
                checks['cursorRedo'] = re['caret']==final['caret'] and re['paragraphText']==final['paragraphText']
            elif case == 'focus-native':
                typ('rk'); state('preedit')
                click('#document-path'); state('focus away')
                point = poc.caret_client(d); click_point([point[0],point[1]+point[2]/2]); typ('sk'); key('End')
                final=state('focus recovered'); states['final']=final
                checks['focusInputPreserved'] = final['paragraphText']=='가나'+text
                key('ctrl+z'); un=state('focus Undo'); states['undone']=un
                checks['separateTransaction'] = un['paragraphText']=='가'+text
            elif case == 'tab-ownership':
                other = out / f'other-{fmt}.{fmt}';other.write_bytes((fixtures/f'basic-ko.{fmt}').read_bytes())
                poc.open_document(d, other);focus_start(); otherbase=state('other base')
                tab(path.name);focus_start(); reset();typ('rk'); state('tab preedit');tab(other.name)
                otherafter=state('other after');key('ctrl+z');otherundo=state('other Undo');tab(path.name);focus_start()
                final=state('owner after switch');states.update(otherbase=otherbase,otherafter=otherafter,otherundo=otherundo,final=final)
                checks['ownerText'] = final['paragraphText']=='가'+text
                checks['otherUnchanged'] = otherafter['paragraphText']==otherbase['paragraphText']==otherundo['paragraphText'] and otherafter['localRevision']==otherbase['localRevision']==otherundo['localRevision']
            elif case == 'reload-generation':
                typ('rk'); key('End'); committed=state('before reload'); states['committed']=committed
                before=poc.ipc(d,'document_sessions')['ok'];sid=committed['session'];old=next(s for s in before if str(s['sessionId'])==sid)
                # Ready reload is outside the backend state contract. Use the
                # existing D5 actual-discard trap to reach the supported failed →
                # reload recovery UI, with real native IME input around the failure.
                key('ctrl+z');state('prepare redo discard')
                d.js('window.__rhwpProbe.throwAfterDiscard=true')
                typ('sk');states['failurePreedit']=state('failure preedit');key('End')
                failed=poc.wait_status(d,'failed');states['injectedFailure']=failed
                click('[data-testid=rhwp-load]')
                smoke.wait_until(d,"return !!document.querySelector('[data-testid=discard-dialog]')")
                click('[data-testid=discard-confirm]');poc.wait_status(d,'ready');focus_start()
                key('ctrl+z'); fresh=state('fresh Undo'); typ('rk');key('End');final=state('fresh input')
                now=next(s for s in poc.ipc(d,'document_sessions')['ok'] if str(s['sessionId'])==sid)
                states.update(fresh=fresh,final=final,oldSession=old,newSession=now)
                checks['generationAdvanced'] = now['loadGeneration']>old['loadGeneration'] and failed['uncertain']=='true'
                checks['noOldTailOrHistory'] = fresh['paragraphText']==text and final['paragraphText']=='가'+text
            elif case == 'close-reopen':
                typ('rk');key('End');state('before close');typ('sk');state('close preedit')
                click_point(d.js("const r=[...document.querySelectorAll('.document-tab__close')].find(e=>e.getAttribute('aria-label').includes(arguments[0])).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]",path.name))
                smoke.wait_until(d,"return !!document.querySelector('[data-testid=discard-dialog]')");click('[data-testid=discard-confirm]')
                smoke.wait_until(d,"return !document.querySelector('[data-testid=discard-dialog]')")
                poc.open_document(d,path);focus_start();key('ctrl+z');fresh=state('reopened Undo');typ('rk');key('End');final=state('reopened input')
                states.update(fresh=fresh,final=final)
                checks['newSession'] = fresh['session']!=base['session']
                checks['noStaleHistoryOrInput'] = fresh['paragraphText']==text and final['paragraphText']=='가'+text
            else:
                typ('gk');key('End');prefix=state('busy prefix');typ('rk');state('busy preedit')
                point=poc.caret_client(d);button=d.js('const r=document.querySelector(\'[data-command="edit.undo"]\').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]')
                apps=c.own_app_pids();assert apps
                for pid in apps:os.kill(pid,19)
                try:
                    key('ctrl+z' if case=='busy-button' else 'End');time.sleep(.03)
                    if case=='busy-click':click_point([point[0],point[1]+point[2]/2])
                    if case=='busy-button':click_point(button)
                finally:
                    for pid in apps:os.kill(pid,18)
                final=state('busy recovered');states.update(prefix=prefix,final=final)
                expected=text if case=='busy-button' else prefix['paragraphText']+'가'
                checks['noDuplicateOrLoss'] = final['paragraphText']==expected
                checks['exactRevision'] = int(final['localRevision'])-int(prefix['localRevision'])==(3 if case=='busy-button' else 1)
                if case=='busy-button':
                    key('ctrl+y');first_redo=state('busy first Redo');key('ctrl+shift+z');redone=state('busy second Redo')
                    states.update(firstRedo=first_redo,redone=redone)
                    checks['redoExact']=first_redo['paragraphText']==prefix['paragraphText'] and redone['paragraphText']==prefix['paragraphText']+'가'
                    dispatches=[r for r in d.js('return window.__geulTrace.records') if r[2]=='command:dispatch' and r[3]['id']=='edit.undo' and r[3]['accepted']]
                    checks['twoExplicitUndoRequests']=len(dispatches)==2
                typ('rk');key('End');new=state('busy new identical input');states['new']=new
                checks['newIdenticalInputPreserved']=new['paragraphText']==prefix['paragraphText']+'가가'
            checks['readyAndCertain'] = final['status']=='ready' and final.get('uncertain','false')=='false' and final['composing']=='false'
            checks['revisionSynchronized'] = final['localRevision']==final['revision']
            record(fmt,case,checks,states)
            # Close this task-owned tab to bound render/session cost.
            click_point(d.js("const r=[...document.querySelectorAll('.document-tab__close')].find(e=>e.getAttribute('aria-label').includes(arguments[0])).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]",path.name))
            smoke.wait_until(d,"return !!document.querySelector('[data-testid=discard-dialog]') || ![...document.querySelectorAll('.document-tab__select')].some(e=>e.textContent.includes(arguments[0]))",path.name)
            if d.exists('[data-testid=discard-dialog]'):click('[data-testid=discard-confirm]')
            smoke.wait_until(d,"return !document.querySelector('[data-testid=discard-dialog]')")

    # Real shared RHWP/WordCraft surface switches in both directions, in each RHWP format.
    docx=out/'cross.docx'
    meta=json.dumps({'path':str(docx),'format':'docx','contentLoss':None})
    result=d.js("""const meta=new TextEncoder().encode(arguments[0]);const b=new Uint8Array(8+meta.length);b.set([71,78,67,49]);new DataView(b.buffer).setUint32(4,meta.length,true);b.set(meta,8);return window.__TAURI_INTERNALS__.invoke('document_new',b)""",meta)
    assert result.get('engine')=='wordcraft' and result.get('state')=='identified',result
    created=next(s for s in poc.ipc(d,'document_sessions')['ok'] if s['displayName']==docx.name)
    poc.ipc(d,'document_close',{'sessionId':created['sessionId']})
    for fmt in ('hwp','hwpx'):
        if selected and not any(f'{fmt}:{case}' in selected for case in CROSS):
            continue
        path=out/f'cross.{fmt}';path.write_bytes((fixtures/f'basic-ko.{fmt}').read_bytes())
        poc.open_document(d,path);focus_start();rhbase=state('cross rh base')
        wc.open_document(d,docx);focus_start(True);wcbase=state('cross wc base',True)
        for case in CROSS:
            if selected and f'{fmt}:{case}' not in selected:
                continue
            fromwc=case=='wordcraft-rhwp'
            tab(docx.name if fromwc else path.name)
            focus_start(fromwc);engine('hangul');reset();typ('rk');state('cross preedit',fromwc)
            tab(path.name if fromwc else docx.name)
            focus_start(not fromwc);targetbase=state('target before',not fromwc)
            typ('sk');key('End');target=state('target new input',not fromwc)
            tab(docx.name if fromwc else path.name);focus_start(fromwc);owner=state('original owner',fromwc)
            expected_owner='가'+(wcbase if fromwc else rhbase)['paragraphText']
            # The first cross switch inserted 나 in DOCX, so the second owner's baseline includes it.
            if fromwc:expected_owner='가나'+wcbase['paragraphText']
            checks={'noCrossContamination':owner['paragraphText']==expected_owner,
                    'newTargetInputPreserved':target['paragraphText']=='나'+targetbase['paragraphText'],
                    'targetRevisionExact':int(target['localRevision'])==int(targetbase['localRevision'])+1}
            record(fmt,case,checks,{'targetbase':targetbase,'target':target,'owner':owner})


def main():
    # The private launcher supplies the same canonical arguments and uses --ime-gap
    # solely as the entrypoint to these additional scenarios. Original gap tests run separately.
    before="const mod=await import(base+'/rhwp.js');"
    script=c.native_probe.INSTALL.replace(before,"const mod=await window.__geulPinnedRuntimeImport(base+'/rhwp.js');")
    assert script!=c.native_probe.INSTALL
    install=c.native_probe.install
    def pinned(d):
        d.js('window.__geulPinnedRuntimeImport=url=>import(url)')
        return install(d,script)
    c.native_probe.install=pinned
    c.scenario_ime_gap=run_native
    return c.main()


if __name__=='__main__':
    sys.exit(main())
