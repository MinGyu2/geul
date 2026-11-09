#!/usr/bin/env python3
"""Native Korean IME preedit × plain-text clipboard acceptance (DOCX/HWP/HWPX).

Run only inside scripts/tests/native-ibus-session.py, which provides a private X11 display, D-Bus
session and IBus daemon with the real ibus-hangul engine:

  python3 scripts/tests/native-ibus-session.py --out OUT/session -- \
    python3 scripts/tests/native-clipboard-preedit.py --app src-tauri/target/debug/geul --driver TAURI_DRIVER --out OUT/run

Input is real: keys and pointer clicks are XTEST events from xdotool, delivered by the X server to
GTK, filtered by the GTK IBus IM module and composed by ibus-hangul. The page only *observes* DOM
events (capture listeners that never prevent or alter them); no CompositionEvent/InputEvent is ever
dispatched by this script. A case whose genuine preedit is not observed fails.

Clipboard effects are observed outside the app: a separate X11 process owns CLIPBOARD and reports
every read (TEXT_REQUEST, i.e. a Paste reached the OS) and every ownership loss (SELECTION_CLEAR, i.e.
Copy/Cut wrote the OS clipboard). Document text is verified through normal selection + Copy after the
case, and finally from the saved bytes reopened outside the app.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tests/e2e'))
import tauri_smoke as smoke  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent))
from preedit_classifier import LABELS, NOTICES, classify, command_events, notice_reason, reason_of  # noqa: E402

COMPOSING = '글자 조합 중'
OBSERVER = r"""
if(!window.__pre){window.__pre=[];const t0=performance.now();
 const btn=id=>document.querySelector('.ribbon__toolbar [data-command="edit.'+id+'"]');
 const st=id=>{const b=btn(id);return b?[b.getAttribute('aria-disabled')==='true',b.title]:null};
 const rec=e=>{const p=btn('paste'),t=e.target,el=t&&t.nodeType===1?t:null,cmd=el&&el.closest?el.closest('[data-command]'):null;
  window.__pre.push({type:e.type,t:Math.round((performance.now()-t0)*10)/10,trusted:e.isTrusted,
  target:t===window?'window':(el&&el.classList&&el.classList.length?[...el.classList].join(' ').slice(0,60):(el?el.nodeName:String(t))),
  command:cmd?cmd.dataset.command:null,
  key:e.key,code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,composing:e.isComposing,
  data:e.data===undefined?undefined:e.data,inputType:e.inputType,
  pasteDisabled:p?p.getAttribute('aria-disabled')==='true':null,pasteComposing:p?p.title.includes(arguments_composing):null,
  state:{copy:st('copy'),cut:st('cut'),paste:st('paste')},active:document.activeElement?.className||null,
  defaultPrevented:e.defaultPrevented})};
 for(const type of ['keydown','keyup','compositionstart','compositionupdate','compositionend','beforeinput','input','mousedown','click','focusin','focusout','focus','blur'])
  window.addEventListener(type,rec,{capture:true,passive:true});
 window.__preMove=null;window.addEventListener('mousemove',e=>window.__preMove=[e.clientX,e.clientY],{capture:true,passive:true});
 window.__notices=[];const sm=()=>document.querySelector('.statusbar__message');
 const note=()=>{const m=sm();window.__notices.push({t:Math.round((performance.now()-t0)*10)/10,text:m?m.textContent:null})};
 new MutationObserver(note).observe(document.querySelector('footer.statusbar'),{subtree:true,childList:true,characterData:true});}
return true;
"""


class Owner:
    """External CLIPBOARD owner; reports reads and ownership loss without the app's cooperation."""

    def __init__(self, text, mapped=False):
        argv = [sys.executable, str(Path(__file__).with_name('x11-clipboard-owner.py')), text, '0']
        if mapped:
            argv.append('map')
        self.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, text=True)
        if not select.select([self.proc.stdout], [], [], 10)[0]:
            raise smoke.Failure('external clipboard owner did not start')
        self.identity = json.loads(self.proc.stdout.readline())
        self.lines = []

    def poll(self):
        while select.select([self.proc.stdout], [], [], 0)[0]:
            line = self.proc.stdout.readline()
            if not line:
                break
            self.lines.append(line.strip())
        return list(self.lines)

    def close(self):
        self.poll()
        if self.proc.poll() is None:
            self.proc.terminate()
        self.proc.wait(timeout=5)


def main():
    p = argparse.ArgumentParser()
    for name in ('app', 'driver', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--port', type=int, default=4491)
    p.add_argument('--formats', default='docx,hwp,hwpx')
    args = p.parse_args()
    if not os.environ.get('DISPLAY') or os.environ.get('GTK_IM_MODULE') != 'ibus' or not os.environ.get('IBUS_ADDRESS'):
        print('BLOCKED: run inside scripts/tests/native-ibus-session.py', file=sys.stderr)
        return 2
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    smoke.APP = str(Path(args.app).resolve())
    smoke.DRIVER_LOG = out / 'driver.log'
    report = {'appSha256': hashlib.sha256(Path(args.app).read_bytes()).hexdigest(), 'stages': {}, 'cases': [],
              'checks': [], 'formats': {}}

    def check(name, ok, detail=None):
        report['checks'].append({'name': name, 'pass': bool(ok), 'detail': detail})
        print(name, 'PASS' if ok else 'FAIL', flush=True)
        if not ok:
            raise smoke.Failure(f'{name}: {json.dumps(detail, ensure_ascii=False, default=str)[:4000]}')

    def run(*argv):
        return subprocess.run(argv, check=True, capture_output=True, text=True, timeout=30).stdout.strip()

    def xdo(*argv):
        return run('xdotool', *argv)

    def engine(name):
        run('ibus', 'engine', name)
        if run('ibus', 'engine') != name:
            raise smoke.Failure('IBus engine did not switch to ' + name)

    try:
        build = json.loads((ROOT / 'public/rhwp/BUILD.json').read_text())
        folder = ROOT / 'public/rhwp/generations' / build['generation']
        report['environment'] = {
            'display': os.environ['DISPLAY'], 'gtkImModule': os.environ['GTK_IM_MODULE'], 'xmodifiers': os.environ.get('XMODIFIERS'),
            'gdkBackend': os.environ.get('GDK_BACKEND'), 'ibusVersion': run('ibus', 'version'),
            'ibusEngines': [line.strip() for line in run('ibus', 'list-engine').splitlines() if 'hangul' in line.lower()],
            'rhwpGeneration': build['generation']}
        subprocess.run(['node', '--input-type=module', '-e', '''
import {readFileSync,writeFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [folder,out]=process.argv.slice(1);const m=await import(pathToFileURL(folder+'/rhwp.js'));m.initSync({module:readFileSync(folder+'/rhwp_bg.wasm')});
const d=m.HwpDocument.createEmpty();d.createBlankDocument();for(const f of ['hwp','hwpx']){const e=f==='hwp'?d.exportHwpWithReport():d.exportHwpxWithReport();try{writeFileSync(out+'/preedit.'+f,e.takeBytes())}finally{e.free()}}d.free();
''', str(folder), str(out)], check=True)
        with tempfile.TemporaryDirectory(prefix='geul-preedit-native-') as data, \
                smoke.tauri_driver(args.driver, args.port, data) as start, contextlib.ExitStack() as lifecycle:
            d = start()
            lifecycle.callback(d.quit)
            smoke.wait_until(d, "return document.querySelector('footer.statusbar')!==null", timeout=40)
            report['environment']['webview'] = d.js('return {href:location.href,ua:navigator.userAgent}')
            report['stages']['startup'] = 'PASS'

            def wait(code, *values, timeout=20):
                return smoke.wait_until(d, code, *values, timeout=timeout)

            def async_js(code, *values):
                d.js('window.__preAsync=null;Promise.resolve().then(async()=>{' + code + '}).then(value=>window.__preAsync={ok:true,value},error=>window.__preAsync={ok:false,error:String(error)});', *values)
                wait('return window.__preAsync!==null')
                result = d.js('return window.__preAsync')
                if not result['ok']:
                    raise smoke.Failure(str(result))
                return result['value']

            def sessions():
                return async_js("return await window.__TAURI_INTERNALS__.invoke('document_sessions')")

            def session(name):
                return next(s for s in sessions() if s['displayName'] == name)

            def idle(name):
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    s = session(name)
                    if s['state'] == 'ready':
                        return s
                    time.sleep(.05)
                raise smoke.Failure('session did not settle ' + name)

            def install():
                d.js(OBSERVER.replace('arguments_composing', json.dumps(COMPOSING)))

            def events():
                return d.js('return window.__pre')

            def button(op):
                return d.js("const b=document.querySelector('.ribbon__toolbar [data-command=\"edit.'+arguments[0]+'\"]');return b?{disabled:b.getAttribute('aria-disabled')==='true',title:b.title}:null", op)

            def status():
                return d.js("return document.querySelector('.statusbar__message')?.textContent||''")

            install()
            window = xdo('search', '--onlyvisible', '--name', '^geul$').splitlines()[-1]
            xdo('windowfocus', '--sync', window)
            geometry = dict(line.split('=') for line in xdo('getwindowgeometry', '--shell', window).splitlines())
            # Pointer calibration with a real X pointer motion (screen -> viewport offset).
            gx, gy = int(geometry['X']) + 300, int(geometry['Y']) + 300
            xdo('mousemove', '--sync', str(gx), str(gy))
            wait('return window.__preMove!==null')
            move = d.js('return window.__preMove')
            offset = (gx - move[0], gy - move[1])
            report['environment']['x11'] = {'window': window, 'geometry': geometry, 'viewportOffset': offset}

            def click(selector):
                point = d.js("const r=document.querySelector(arguments[0]).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]", selector)
                xdo('mousemove', '--sync', str(round(point[0] + offset[0])), str(round(point[1] + offset[1])))
                xdo('click', '1')

            def focus_editor():
                xdo('windowfocus', '--sync', window)
                d.js("document.querySelector('.editor__scroll .rhwp-input').focus()")
                wait("return document.activeElement?.classList.contains('rhwp-input')")
                if xdo('getwindowfocus') != window:
                    raise smoke.Failure('X input focus is not the app window')

            def open_doc(path):
                d.js("const e=document.querySelector('#document-path');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,arguments[0]);e.dispatchEvent(new Event('input',{bubbles:true}));", str(path))
                d.js("document.querySelector('.document-bar__open').requestSubmit()")
                wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.getAttribute('aria-selected')==='true'&&e.textContent.includes(arguments[0])&&e.dataset.state==='ready')", path.name, timeout=40)
                wait("return document.querySelector('.editor__scroll canvas')?.width>0", timeout=60)
                time.sleep(.3)

            def select_tab(name):
                d.js("[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0])).click()", name)
                wait("return [...document.querySelectorAll('.document-tab__select')].some(e=>e.textContent.includes(arguments[0])&&e.getAttribute('aria-selected')==='true')", name)
                time.sleep(.3)

            def read_os_clipboard():
                return async_js("return await window.__TAURI_INTERNALS__.invoke('clipboard_read_text')")

            def select_to_start(op):
                """Select from the end to the document start, then wait until the final selection key has
                actually reached the page and the command is available (input delivery is asynchronous)."""
                mark = len(events())
                # The text wraps onto several visual lines: reach the true end first (Down then End), then select
                # upwards past the first line; End alone only reaches the end of the current visual line.
                xdo('key', '--delay', '30', *(['Down'] * 6), 'End', *(['shift+Up'] * 6), 'shift+Home')
                wait("return window.__pre.slice(arguments[0]).some(e=>e.type==='keyup'&&e.key==='Home'&&e.trusted)", mark, timeout=10)
                wait("const b=document.querySelector('.ribbon__toolbar [data-command=\"edit.'+arguments[0]+'\"]');return b&&b.getAttribute('aria-disabled')!=='true'", op, timeout=10)
                time.sleep(.3)
                wait("const b=document.querySelector('.ribbon__toolbar [data-command=\"edit.'+arguments[0]+'\"]');return b&&b.getAttribute('aria-disabled')!=='true'", op, timeout=10)

            def caret_to_end():
                xdo('key', '--delay', '30', *(['Down'] * 6), 'End')

            def text_of(name):
                """Normal (non-IME) selection + Copy; also proves Copy works again after composition."""
                engine('xkb:us::eng')
                focus_editor()
                select_to_start('copy')
                before = session(name)
                xdo('key', 'ctrl+c')
                time.sleep(.4)
                value = read_os_clipboard()
                after = session(name)
                caret_to_end()
                if (before['revision'], before['dirty']) != (after['revision'], after['dirty']):
                    raise smoke.Failure('verification Copy mutated the document')
                return value

            def compose(label):
                """Begin genuine Hangul preedit '하' (2-beolsik g,k) through XTEST -> GTK -> IBus."""
                engine('hangul')
                focus_editor()
                mark = len(events())
                xdo('key', 'shift+space')  # ibus-hangul switch key: Latin -> Hangul
                time.sleep(.15)
                xdo('type', '--delay', '120', 'gk')
                try:
                    wait("const e=window.__pre.slice(arguments[0]);return e.some(x=>x.type==='compositionstart'&&x.trusted)&&e.some(x=>x.type==='compositionupdate'&&x.trusted&&x.data==='하')&&document.querySelector('.ribbon__toolbar [data-command=\"edit.paste\"]')?.title.includes(arguments[1])", mark, COMPOSING, timeout=10)
                except smoke.Failure:
                    raise smoke.Failure(label + ': genuine preedit not observed ' + json.dumps(events()[mark:], ensure_ascii=False))
                observed = events()[mark:]
                check(label + ' genuine trusted preedit + session composing', True,
                      {'events': observed, 'paste': button('paste'), 'copy': button('copy'), 'cut': button('cut'),
                       'focus': d.js("return document.activeElement?.className")})
                return mark

            def act(action):
                if action.startswith('key:'):
                    xdo('key', action[4:])
                else:
                    click(f'.ribbon__toolbar [data-command="edit.{action[7:]}"]')

            def run_case(fmt, name, label, action, state, select_before=False, finish='End', settle_first=False):
                case = {'format': fmt, 'case': label, 'action': action}
                report['cases'].append(case)
                clip = 'CLIP-' + label.upper()
                op = action.split(':', 1)[1].split('+')[-1]
                op = {'c': 'copy', 'x': 'cut', 'v': 'paste'}.get(op, op)
                # Prime the status line with a refusal the tested command cannot produce, so that its own
                # refusal (if any) is always a visible new notice. Done before the external owner starts.
                engine('xkb:us::eng')
                focus_editor()
                prime = 'cut' if op == 'copy' else 'copy'
                xdo('key', 'ctrl+x' if prime == 'cut' else 'ctrl+c')
                prime_text = NOTICES['selectionRequired'].replace('{command}', LABELS[prime])
                wait("return document.querySelector('.statusbar__message')?.textContent===arguments[0]", prime_text, timeout=10)
                notice_mark = len(d.js('return window.__notices'))
                owner = Owner(clip)
                try:
                    if select_before:
                        engine('xkb:us::eng')
                        focus_editor()
                        xdo('key', 'End', 'shift+Left', 'shift+Left')
                        wait("return document.querySelector('[data-command=\"edit.cut\"]')?.getAttribute('aria-disabled')!=='true'", timeout=10)
                        case['selectionBeforeCompose'] = button('cut')
                    case['before'] = session(name)
                    mark = compose(fmt + ' ' + label)
                    if settle_first:
                        # Genuine settlement through real input: ibus-hangul flushes on End, the app applies the
                        # commit, and Paste must be stably available before the trusted click.
                        xdo('key', 'End')
                        wait("const b=document.querySelector('.ribbon__toolbar [data-command=\"edit.paste\"]');return b&&b.getAttribute('aria-disabled')!=='true'", timeout=10)
                        idle(name)
                        time.sleep(.6)
                        check(f'{fmt} {label} settled state stable before command', not button('paste')['disabled']
                              and session(name)['state'] == 'ready', button('paste'))
                    case['atAction'] = {'paste': button('paste'), 'copy': button('copy'), 'cut': button('cut'),
                                        'revision': session(name)['revision'], 'owner': owner.poll()}
                    act_mark = len(events())
                    act(action)
                    time.sleep(.8)
                    case['afterAction'] = {'paste': button('paste'), 'status': status(), 'owner': owner.poll(),
                                           'revision': session(name)['revision'], 'events': events()[act_mark:]}
                    still = COMPOSING in (button('paste') or {}).get('title', '')
                    case['compositionAfterAction'] = still
                    # Finish (commit) the preedit if the command did not already settle it.
                    if finish:
                        xdo('key', finish)
                    wait("return !document.querySelector('.ribbon__toolbar [data-command=\"edit.paste\"]')?.title.includes(arguments[0])", COMPOSING, timeout=10)
                    idle(name)
                    settled = session(name)
                    copy_state = button('copy')
                    case['settledSelection'] = reason_of([copy_state['disabled'], copy_state['title']] if copy_state else None)
                    time.sleep(1.2)  # window for delayed commit / replayed commands
                    late = session(name)
                    case['events'] = events()[mark:]
                    case['owner'] = owner.poll()
                    case['settled'] = settled
                    case['late'] = late
                finally:
                    owner.close()
                lines = owner.lines
                reads = lines.count('TEXT_REQUEST')
                clears = lines.count('SELECTION_CLEAR')
                ev = case['events']
                case['ordering'] = [(e['type'], e.get('key'), e.get('command'), e.get('data'), e.get('composing'), e['t'])
                                    for e in ev if e['type'] in ('keydown', 'keyup', 'compositionstart', 'compositionupdate',
                                                                 'compositionend', 'beforeinput', 'input', 'mousedown', 'click')]
                case['notices'] = d.js('return window.__notices')[notice_mark:]
                verdict = classify(action, ev, case['afterAction']['events'], reads, clears, case['notices'],
                                   case['settledSelection'])
                case.update(expected=verdict['expected'], observed=verdict['observed'], refusalReason=verdict['reason'],
                            displayedReasonAtCommand=verdict['displayedReason'], commandEvent=verdict['command'],
                            reads=reads, clipboardOverwritten=clears)
                for check_name, ok, detail in verdict['checks']:
                    check(f'{fmt} {label} {check_name}', ok, detail)
                executed = verdict['observed'] == 'execute'
                case['outcome'] = 'executed-after-settlement' if executed else 'refused'
                if op == 'paste' or not executed:
                    check(f'{fmt} {label} OS clipboard not overwritten', clears == 0, lines)
                if settle_first:
                    check(f'{fmt} {label} positive path reached (settled, available, executed once)', executed and reads == 1,
                          verdict['observed'])
                    check(f'{fmt} {label} exactly one revision for one insertion',
                          settled['revision'] == case['atAction']['revision'] + 1,
                          {'atAction': case['atAction']['revision'], 'settled': settled['revision']})
                check(f'{fmt} {label} no stale revision after settlement', late['revision'] == settled['revision'],
                      {'settled': settled['revision'], 'late': late['revision']})
                if select_before:
                    state['text'] = state['text'][:-2]
                state['text'] += '하' + (clip if (op == 'paste' and executed) else '')
                actual = text_of(name)
                check(f'{fmt} {label} document text exact (no loss/duplication)', actual == state['text'],
                      {'expected': state['text'], 'actual': actual})
                case['text'] = actual
                case['status'] = 'PASS'
                return case

            def save_and_reopen(fmt, name, path, expected):
                focus_editor()
                xdo('key', 'ctrl+s')
                deadline = time.monotonic() + 30
                while session(name)['dirty'] and time.monotonic() < deadline:
                    time.sleep(.1)
                check(f'{fmt} T009 save after preedit cases', not session(name)['dirty'], status())
                if fmt == 'docx':
                    with zipfile.ZipFile(path) as z:
                        root = ET.fromstring(z.read('word/document.xml'))
                    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                    paragraphs = [''.join(t.text or '' for t in para.iter('{%s}t' % ns['w']))
                                  for para in root.findall('.//w:body/w:p', ns)]
                else:
                    paragraphs = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', '''
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';const [folder,file]=process.argv.slice(1);const m=await import(pathToFileURL(folder+'/rhwp.js'));m.initSync({module:readFileSync(folder+'/rhwp_bg.wasm')});const d=new m.HwpDocument(readFileSync(file));try{console.log(JSON.stringify(Array.from({length:d.getParagraphCount(0)},(_,p)=>d.getTextRange(0,p,0,d.getParagraphLength(0,p)))))}finally{d.free()}
''', str(folder), str(path)], text=True))
                check(f'{fmt} saved bytes reopened independently', paragraphs == [expected], paragraphs)
                return paragraphs

            # DOCX blank document from the app's own creation command (no binary fixture).
            docx = out / 'preedit.docx'
            async_js("const meta=new TextEncoder().encode(JSON.stringify({path:arguments[0],format:'docx',contentLoss:null}));const b=new Uint8Array(8+meta.length);b.set([71,78,67,49]);new DataView(b.buffer).setUint32(4,meta.length,true);b.set(meta,8);return await window.__TAURI_INTERNALS__.invoke('document_new',b)", str(docx))
            created = sessions()[0]
            async_js("return await window.__TAURI_INTERNALS__.invoke('document_close',{sessionId:arguments[0]})", created['sessionId'])

            states = {}
            for fmt in args.formats.split(','):
                name = 'preedit.' + fmt
                path = out / name
                open_doc(path)
                install()
                state = {'text': 'base'}
                states[fmt] = state
                engine('xkb:us::eng')
                focus_editor()
                xdo('type', '--delay', '60', 'base')
                idle(name)
                check(f'{fmt} baseline typing', text_of(name) == 'base')
                before_paste = button('paste')
                check(f'{fmt} Paste available before composition', before_paste and not before_paste['disabled'], before_paste)
                report['stages'].setdefault('engineActivation', 'PASS')
                for label, action, extra in [
                    ('ctrl-c', 'key:ctrl+c', {}),
                    ('ctrl-x', 'key:ctrl+x', {}),
                    ('ctrl-x-over-selection', 'key:ctrl+x', {'select_before': True}),
                    ('ctrl-v', 'key:ctrl+v', {}),
                    ('ribbon-copy', 'ribbon:copy', {}),
                    ('ribbon-cut', 'ribbon:cut', {}),
                    ('ribbon-paste', 'ribbon:paste', {}),
                    ('ribbon-paste-after-settlement', 'ribbon:paste', {'settle_first': True}),
                ]:
                    run_case(fmt, name, label, action, state, **extra)
                report['stages']['preeditObservation'] = 'PASS'

                # D6 genuine cancellation: BackSpace removes both jamo, preedit ends empty.
                owner = Owner('CLIP-AFTER-CANCEL')
                try:
                    mark = compose(fmt + ' cancel')
                    xdo('key', '--delay', '120', 'BackSpace', 'BackSpace')
                    wait("return window.__pre.slice(arguments[0]).some(e=>e.type==='compositionend'&&e.trusted&&!e.data)", mark, timeout=10)
                    time.sleep(.8)
                    cancel = {'events': events()[mark:], 'paste': button('paste'), 'revision': session(name)['revision']}
                    awaiting = COMPOSING in (cancel['paste'] or {}).get('title', '')
                    cancel['awaitingAfterCancel'] = awaiting
                    # Contract (imeInput.ts, T010): rhwp ends the wait on the observed Backspace-keyup cancellation
                    # boundary; WordCraft does not take part and stays fail-closed until the next new-input key.
                    check(f'{fmt} cancellation boundary per engine contract', (fmt == 'docx') or not awaiting, cancel)
                    if awaiting:
                        # Unsettled: a trusted ribbon Paste must be refused, never read the OS clipboard, never replay.
                        rev = session(name)['revision']
                        click_mark = len(events())
                        click('.ribbon__toolbar [data-command="edit.paste"]')
                        time.sleep(.8)
                        hit = command_events('ribbon:paste', events()[click_mark:])
                        check(f'{fmt} trusted Paste click delivered while awaiting', len(hit) == 1
                              and reason_of(hit[0]['state']['paste']) == 'composing', hit)
                        cancel['pasteWhileAwaiting'] = {'status': status(), 'owner': owner.poll(), 'revision': session(name)['revision']}
                        check(f'{fmt} Paste refused while cancellation unsettled', owner.poll().count('TEXT_REQUEST') == 0
                              and session(name)['revision'] == rev, cancel['pasteWhileAwaiting'])
                        focus_editor()
                        xdo('key', 'End')  # next new-input key releases the wait (no timer)
                        wait("return !document.querySelector('.ribbon__toolbar [data-command=\"edit.paste\"]')?.title.includes(arguments[0])", COMPOSING, timeout=10)
                    idle(name)
                    report['cases'].append({'format': fmt, 'case': 'backspace-cancel', **cancel})
                    ends = [e for e in cancel['events'] if e['type'] == 'compositionend']
                    check(f'{fmt} native cancellation ends preedit empty', ends and (ends[-1]['data'] or '') == '', cancel['events'])
                    check(f'{fmt} no stale Paste after release', owner.poll().count('TEXT_REQUEST') == 0, owner.poll())
                    # D5: Paste is not left disabled after a canceled transaction (trusted ribbon click).
                    rev = session(name)['revision']
                    focus_editor()
                    click_mark = len(events())
                    click('.ribbon__toolbar [data-command="edit.paste"]')
                    deadline = time.monotonic() + 10
                    while session(name)['revision'] == rev and time.monotonic() < deadline:
                        time.sleep(.05)
                    idle(name)
                    time.sleep(.8)
                    lines = owner.poll()
                    hit = command_events('ribbon:paste', events()[click_mark:])
                finally:
                    owner.close()
                check(f'{fmt} trusted Paste click after release delivered with Paste available', len(hit) == 1
                      and reason_of(hit[0]['state']['paste']) is None, hit)
                check(f'{fmt} Paste after cancellation executes exactly once', lines.count('TEXT_REQUEST') == 1, lines)
                state['text'] += 'CLIP-AFTER-CANCEL'
                after_paste = text_of(name)
                # Exact text also proves the cancellation removed nothing from the document.
                check(f'{fmt} cancellation removed nothing; Paste after cancellation text exact', after_paste == state['text'],
                      {'expected': state['text'], 'actual': after_paste})

                # D5 normal Copy/Cut/Paste after all preedit cases (keyboard, no IME).
                full = state['text']
                engine('xkb:us::eng')
                focus_editor()
                select_to_start('cut')
                rev = session(name)['revision']
                cut_mark = len(events())
                xdo('key', 'ctrl+x')
                deadline = time.monotonic() + 10
                while session(name)['revision'] == rev and time.monotonic() < deadline:
                    time.sleep(.05)
                idle(name)
                cut_clip = read_os_clipboard()
                cut_detail = {'expected': full, 'clipboard': cut_clip, 'revisionBefore': rev,
                              'revisionAfter': session(name)['revision'], 'status': status(),
                              'events': [(e['type'], e.get('key'), e.get('shift'), e.get('ctrl'), e['t'], e['state']['cut'])
                                         for e in events()[max(0, cut_mark - 12):] if e['type'] in ('keydown', 'keyup')]}
                report.setdefault('normalCut', {})[fmt] = cut_detail
                check(f'{fmt} normal Cut after preedit writes clipboard', cut_clip == full, cut_detail)
                check(f'{fmt} normal Cut removes selection', session(name)['revision'] == rev + 1, cut_detail)
                xdo('key', 'ctrl+v')
                deadline = time.monotonic() + 10
                while session(name)['revision'] == rev + 1 and time.monotonic() < deadline:
                    time.sleep(.05)
                idle(name)
                time.sleep(.5)
                check(f'{fmt} normal Paste after preedit exactly once', text_of(name) == full)
                report['formats'][fmt] = {'text': full, 'revision': session(name)['revision'],
                                          'saved': save_and_reopen(fmt, name, path, full)}

            # D6 window focus change during preedit: real X11 focus to another client and back, verified.
            last = args.formats.split(',')[-1]
            name = 'preedit.' + last
            mapped = Owner('CLIP-FOCUS', mapped=True)
            try:
                other = str(mapped.identity['owner'])
                rev0 = session(name)['revision']
                mark = compose(last + ' focus-away')
                xdo('windowfocus', '--sync', other)          # raises on failure
                time.sleep(.6)
                away = {'xfocus': xdo('getwindowfocus'), 'paste': button('paste'), 'revision': session(name)['revision']}
                away_events = events()[mark:]
                xdo('windowfocus', '--sync', window)
                time.sleep(.6)
                back = {'xfocus': xdo('getwindowfocus'), 'paste': button('paste'), 'revision': session(name)['revision'],
                        'active': d.js("return document.activeElement?.className||null")}
                back_events = events()[mark + len(away_events):]
                check(f'{last} focus change: external X11 window obtained focus', away['xfocus'] == other, away)
                check(f'{last} focus change: app saw a trusted window blur', any(e['type'] == 'blur' and e['target'] == 'window'
                      and e['trusted'] for e in away_events), [(e['type'], e['target']) for e in away_events])
                check(f'{last} focus change: app regained X focus', back['xfocus'] == window, back)
                check(f'{last} focus change: app saw a trusted window focus', any(e['type'] == 'focus' and e['target'] == 'window'
                      and e['trusted'] for e in back_events), [(e['type'], e['target']) for e in back_events])
                if COMPOSING in (button('paste') or {}).get('title', ''):
                    focus_editor()
                    xdo('key', 'End')
                wait("return !document.querySelector('.ribbon__toolbar [data-command=\"edit.paste\"]')?.title.includes(arguments[0])", COMPOSING, timeout=10)
                idle(name)
                time.sleep(1)
                focus_editor()  # editor focus restored for continued typing
                check(f'{last} focus change: editor focus restored', d.js("return document.activeElement?.classList.contains('rhwp-input')"))
                focus_events = events()[mark:]
                lines = mapped.poll()
            finally:
                mapped.close()
            report['cases'].append({'format': last, 'case': 'focus-away-during-preedit', 'away': away, 'back': back,
                                    'events': focus_events, 'owner': lines, 'revisionBefore': rev0})
            check(f'{last} focus change: no clipboard read/write', lines.count('TEXT_REQUEST') == 0 and lines.count('SELECTION_CLEAR') == 0, lines)
            # Expected from the observed IME result: the syllable is in the document iff the IME committed it.
            commits = [e for e in focus_events if e['type'] == 'compositionend' and e['trusted'] and e.get('data') == '하']
            # WebKitGTK may finalize the composition itself on focus loss and IBus then commits the same syllable
            # again (documented in imeInput.ts); the app must consume the duplicate. The exact text below is the gate.
            report['cases'][-1]['commitEvents'] = len(commits)
            states[last]['text'] += '하' if commits else ''
            committed = text_of(name)
            check(f'{last} focus change: document text exact (commit once, nothing lost)', committed == states[last]['text'],
                  {'expected': states[last]['text'], 'actual': committed, 'committed': bool(commits)})

            # D6 document/tab switch during preedit: composition must not cross into the other document.
            if len(args.formats.split(',')) > 1:
                first = 'preedit.' + args.formats.split(',')[0]
                engine('xkb:us::eng')
                focus_editor()
                xdo('key', 'ctrl+c')  # prime: a Copy refusal notice, so a Paste refusal is always a new notice
                wait("return document.querySelector('.statusbar__message')?.textContent===arguments[0]",
                     NOTICES['selectionRequired'].replace('{command}', LABELS['copy']), timeout=10)
                notice_mark = len(d.js('return window.__notices'))
                owner = Owner('CLIP-TAB')
                try:
                    revs = {s['displayName']: s['revision'] for s in sessions()}
                    mark = compose(last + ' tab-switch')
                    point = d.js("const r=[...document.querySelectorAll('.document-tab__select')].find(e=>e.textContent.includes(arguments[0])).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]", first)
                    xdo('mousemove', '--sync', str(round(point[0] + offset[0])), str(round(point[1] + offset[1])))
                    xdo('click', '1')
                    time.sleep(1)
                    tab = d.js("return [...document.querySelectorAll('.document-tab__select')].find(e=>e.getAttribute('aria-selected')==='true')?.textContent")
                    # Ctrl+V in the newly active document after the switch.
                    focus_editor()
                    xdo('key', 'ctrl+v')
                    time.sleep(1.2)
                    tab_events = events()[mark:]
                    lines = owner.poll()
                    after = {s['displayName']: s['revision'] for s in sessions()}
                finally:
                    owner.close()
                report['cases'].append({'format': last, 'case': 'tab-switch-during-preedit', 'activeAfterClick': tab,
                                        'events': tab_events, 'owner': lines, 'revisionsBefore': revs, 'revisionsAfter': after})
                check('tab switch click activated the other document', first in (tab or ''), tab)
                clicks = [e for e in tab_events if e['type'] == 'click' and e['trusted'] and 'document-tab' in (e['target'] or '')]
                check('tab switch: trusted click reached a document tab', len(clicks) == 1, [(e['type'], e['target']) for e in tab_events])
                commits = [e for e in tab_events if e['type'] == 'compositionend' and e['trusted'] and e.get('data') == '하'
                           and e['t'] < clicks[0]['t']]
                late_commits = [e for e in tab_events if e['type'] == 'compositionend' and e.get('data') and e['t'] > clicks[0]['t']]
                check('tab switch: no IME commit arrives after the switch', not late_commits, late_commits)
                downs = [e for e in tab_events if e['type'] == 'keydown' and e['trusted'] and e['ctrl'] and (e['key'] or '').lower() == 'v'
                         and e['t'] > clicks[0]['t'] and 'rhwp-input' in (e['target'] or '')]
                check('tab switch: trusted Ctrl+V delivered to the new document', len(downs) == 1, [(e['type'], e.get('key')) for e in tab_events])
                first_fmt = args.formats.split(',')[0]
                pasted = lines.count('TEXT_REQUEST')
                tab_notices = d.js('return window.__notices')[notice_mark:]
                refusal = [notice_reason('paste', n['text']) for n in tab_notices if n['t'] >= downs[0]['t']]
                refusal = [r for r in refusal if r]
                report['cases'][-1].update(notices=tab_notices, reads=pasted, refusal=refusal[:1])
                check('tab switch: Ctrl+V has exactly one positive outcome (one read or a refusal notice)',
                      (pasted == 1 and not refusal) or (pasted == 0 and len(refusal) >= 1), {'reads': pasted, 'refusal': refusal})
                if refusal:
                    check('tab switch: Paste refusal reason is an IME/edit-ordering guard', refusal[0] in ('composing', 'pendingEdits'), refusal)
                paste_expected = pasted == 1
                states[first_fmt]['text'] += 'CLIP-TAB' if paste_expected else ''
                first_text = text_of(first)
                check('tab switch: composition never crosses into the other document; Paste lands once there',
                      first_text == states[first_fmt]['text'], {'expected': states[first_fmt]['text'], 'actual': first_text})
                select_tab(name)
                states[last]['text'] += '하' if commits else ''
                origin_text = text_of(name)
                check('tab switch: original document has the IME commit exactly once (or nothing if canceled)',
                      origin_text == states[last]['text'], {'expected': states[last]['text'], 'actual': origin_text, 'committed': bool(commits)})
            report['stages']['commandBehavior'] = 'PASS'
            report['stages']['documentVerification'] = 'PASS'
        report['stages']['cleanup'] = 'PASS'
        report['status'] = 'PASS'
        return 0
    except Exception as e:
        report['status'] = 'FAIL'
        report['error'] = str(e)
        traceback.print_exc()
        return 1
    finally:
        (out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + '\n')
        print(json.dumps({k: report.get(k) for k in ('status', 'error', 'stages', 'appSha256')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.exit(main())
