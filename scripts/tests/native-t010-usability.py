#!/usr/bin/env python3
"""T010 native practical usability for general RHWP Undo/Redo (HWP/HWPX).

Run inside an isolated X11/IBus launcher against the Tauri debug host + Vite source built with
VITE_GEUL_TEST_HOOKS=1 only: general history comes from the product registry, not from
VITE_GEUL_TEST_RHWP_HISTORY. Editor input is produced only by X11 keys/pointer (xdotool) through
GTK/IBus/ibus-hangul. JavaScript only reads state, installs observers and opens copied fixtures.
The hooks expose the caret paragraph text and the actual engine model for assertions; the normal
product build is checked separately (native-t010-production.py).

Usage: native-t010-usability.py --app APP --driver DRIVER --xdotool X --ibus I --out DIR [--only a,b]

Final PASS requires native-ibus-session.py --acceptance-report OUT/result.json.
The child records PENDING_CLEANUP until that launcher proves its own cleanup.
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
import traceback
import uuid

import t010_acceptance as gate
import t010_lifecycle as lifecycle

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'tests/e2e'), str(ROOT / 'tests/integration/rhwp')]
import tauri_smoke as smoke  # noqa: E402
import rhwp_poc as poc  # noqa: E402

SAMPLES = ROOT / 'external/rhwp/samples'
COMPLEX = [SAMPLES / 'aift.hwp', SAMPLES / 'issue6031/3249937_asset_management_rules.hwpx', SAMPLES / 'rnote/연구노트(화학).hwp']
SOURCES = ['src/commands/registry.ts', 'src/commands/capability.ts', 'src/components/Editor/rhwp/RhwpEditorSession.ts',
           'src/components/Editor/rhwp/rhwpHistory.ts', 'src/components/Editor/rhwp/imeInput.ts', 'src/components/Editor/textInput.ts',
           'src/components/CommandButton/editorFocus.ts', 'src/components/Editor/rhwp/RhwpSurface.tsx']
from t010_usability_contract import CASES, KOREAN_STATES
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


class Usability:
    def __init__(self, d, args, report):
        self.d, self.args, self.report = d, args, report
        self.rows = report.setdefault('scenarios', [])
        self.latin = False
        self.current = None
        self.session_documents = {}

    # ---- native input ----
    def run(self, *a):
        return subprocess.run(['env', '-u', 'LD_LIBRARY_PATH', *a], check=True, capture_output=True, text=True).stdout.strip()

    def key(self, *keys, delay=40):
        self.run(self.args.xdotool, 'key', '--delay', str(delay), *keys)

    def typ(self, text, delay=40):
        self.run(self.args.xdotool, 'type', '--delay', str(delay), text)

    def engine(self, name):
        gate.require(self.run(self.args.ibus, 'engine') == 'hangul', 'IBus engine is not hangul')
        want = name == 'latin'
        if self.latin != want:
            self.key('Hangul')  # the real Hangul/Latin toggle inside ibus-hangul
            self.latin = want

    def setup(self):
        d = self.d
        self.window = self.run(self.args.xdotool, 'search', '--onlyvisible', '--name', '^geul').split()[-1]
        self.run(self.args.xdotool, 'windowfocus', '--sync', self.window)
        d.js("window.__uMove=null;window.addEventListener('mousemove',e=>window.__uMove=[e.clientX,e.clientY],true)")
        points = []
        for n in (100, 200):
            d.js('window.__uMove=null')
            self.run(self.args.xdotool, 'mousemove', '--window', self.window, str(n), str(n))
            smoke.wait_until(d, 'return !!window.__uMove')
            points.append(d.js('return window.__uMove'))
        self.scale = [100 / (points[1][i] - points[0][i]) for i in (0, 1)]
        self.origin = [100 - points[0][i] * self.scale[i] for i in (0, 1)]
        d.js("""window.__uEvents=[];
          for(const type of ['keydown','compositionstart','compositionend','beforeinput','input'])
            document.addEventListener(type,e=>{
              if(!e.target?.matches?.('.rhwp-input'))return;
              window.__uEvents.push({...window.__uScope,session:document.querySelector('.document-tab__select[aria-selected=true]')?.dataset.session,type,trusted:e.isTrusted,data:e.data??null,key:e.key??null,inputType:e.inputType??null,ctrlKey:!!e.ctrlKey,code:e.code??null,t:performance.now()});
            },true);""")
        # Actual engine model per session: wrap the shared facade before any document opens.
        d.js("""window.__uReady=false;(async()=>{
            const {RhwpEditorSession}=await import('/src/components/Editor/rhwp/RhwpEditorSession.ts');
            const snapshot=RhwpEditorSession.prototype.snapshot, sessions=new Map();
            RhwpEditorSession.prototype.snapshot=function(...a){sessions.set(String(this.sessionId),this);return snapshot.apply(this,a)};
            window.__uIme=sid=>sessions.get(String(sid)).imeDiagnostics();
            const facade=await(await import('/src/components/Editor/rhwp/rhwpModule.ts')).loadRhwpModule();
            const open=facade.openDocument,live=new Map(),bound=new Map();let serial=0;
            facade.openDocument=function(...args){const doc=open.apply(this,args),id=++serial,free=doc.free;live.set(id,doc);
              doc.free=function(...a){live.delete(id);for(const [s,r] of bound)if(r.doc===this)bound.delete(s);return free.apply(this,a)};return doc};
            window.__uBind=sid=>{const owned=new Set([...bound.values()].map(r=>r.id));
              const ids=[...live.keys()].filter(id=>!owned.has(id));if(!ids.length)throw Error('no unbound live model');
              const id=Math.max(...ids);bound.set(sid,{id,doc:live.get(id)});return id};
            window.__uModel=sid=>{const r=bound.get(sid);if(!r)throw Error('no model for '+sid);const doc=r.doc,out=[];
              const sections=doc.getSectionCount?doc.getSectionCount():1;
              for(let s=0;s<sections;s++){const n=doc.getParagraphCount(s);for(let p=0;p<n;p++)out.push(doc.getTextRange(s,p,0,doc.getParagraphLength(s,p)))}
              return {id:r.id,paragraphs:out.length,text:out.join('\\n'),pages:doc.pageCount()}};
            window.__uParagraph=(sid,key)=>{const r=bound.get(sid);if(!r)throw Error('no model for '+sid);const doc=r.doc;
              const [main,cell]=key.split('@');const [sec,par]=main.split(':').map(Number);
              if(!cell)return doc.getTextRange(sec,par,0,doc.getParagraphLength(sec,par));
              const [control,c,cp]=cell.split('/').map(Number);
              return doc.getTextInCell(sec,par,control,c,cp,0,doc.getCellParagraphLength(sec,par,control,c,cp))};
            window.__uReady=true;})().catch(e=>window.__uError=String(e));""")
        smoke.wait_until(d, 'return window.__uReady||!!window.__uError')
        gate.require(d.js('return window.__uReady'), d.js('return window.__uError'))

    def click_point(self, point):
        xy = [str(round(point[i] * self.scale[i] + self.origin[i])) for i in (0, 1)]
        self.run(self.args.xdotool, 'mousemove', '--window', self.window, *xy, 'click', '1')

    def click(self, css):
        self.click_point(self.d.js('const r=document.querySelector(arguments[0]).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]', css))

    def focus_start(self):
        smoke.wait_until(self.d, "return !!document.querySelector('.rhwp-page') && document.querySelector('.editor__scroll canvas')?.width>0", timeout=180)
        g = self.d.js("""const p=document.querySelector('.rhwp-page'),s=document.querySelector('.editor__scroll');s.scrollTop=0;s.scrollLeft=0;
          const r=p.getBoundingClientRect(),q=s.getBoundingClientRect();
          const left=Math.max(r.left,q.left,0),right=Math.min(r.right,q.right,innerWidth),top=Math.max(r.top,q.top,0),bottom=Math.min(r.bottom,q.bottom,innerHeight);
          const point=[left+Math.min(150,(right-left)/2),top+Math.min(20,(bottom-top)/2)];
          return {point,ok:right>left&&bottom>top&&!!document.elementFromPoint(...point)?.closest('.rhwp-page')}""")
        gate.require(g['ok'], json.dumps(g))
        self.click_point(g['point'])
        smoke.wait_until(self.d, "return document.activeElement?.matches('.editor__scroll .rhwp-input')")
        self.key('Home')

    def sid(self):
        return self.d.js("return document.querySelector('.document-tab__select[aria-selected=true]')?.dataset.session")

    def open(self, source, name):
        path = self.args.out / name
        shutil.copyfile(source, path)
        poc.open_document(self.d, path)
        self.d.js('return window.__uBind(arguments[0])', self.sid())
        self.focus_start()
        return path

    def tab(self, name):
        sid = next(s['sessionId'] for s in poc.ipc(self.d, 'document_sessions')['ok'] if s['displayName'] == name)
        css = f'.document-tab__select[data-session="{sid}"]'
        self.click(css)
        smoke.wait_until(self.d, "return document.querySelector(arguments[0])?.getAttribute('aria-selected')==='true'", css)

    def close(self, name, discard=True):
        point = self.d.js("const r=[...document.querySelectorAll('.document-tab__close')].find(e=>e.getAttribute('aria-label').includes(arguments[0])).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]", name)
        self.click_point(point)
        smoke.wait_until(self.d, "return !!document.querySelector('[data-testid=discard-dialog]') || ![...document.querySelectorAll('.document-tab__select')].some(e=>e.textContent.includes(arguments[0]))", name)
        if self.d.exists('[data-testid=discard-dialog]'):
            gate.require(discard, 'unexpected discard prompt')
            self.click('[data-testid=discard-confirm]')
        smoke.wait_until(self.d, "return !document.querySelector('[data-testid=discard-dialog]') && ![...document.querySelectorAll('.document-tab__select')].some(e=>e.textContent.includes(arguments[0]))", name)

    def button(self, command):
        return self.d.js('const b=document.querySelector(\'[data-command="\'+arguments[0]+\'"]\');return b?{disabled:b.getAttribute("aria-disabled")==="true",title:b.title}:null', command)

    # ---- observation ----
    def state(self, label, timeout=60.0):
        started = time.monotonic()
        st = poc.settle(self.d, label, timeout=timeout)
        smoke.wait_until(self.d, "const e=document.querySelector('[data-testid=rhwp-status]');return e&&e.dataset.localRevision===e.dataset.revision", timeout=timeout)
        st = poc.status(self.d)
        st['settleSeconds'] = round(time.monotonic() - started, 3)
        st['label'] = label
        st['session'] = self.sid()
        if st['session'] not in self.session_documents:
            self.session_documents.update({str(s['sessionId']): s['displayName'] for s in poc.ipc(self.d, 'document_sessions')['ok']})
        st.update(runId=self.report['runId'], scenarioId=self.current['scenarioId'], format=self.current['format'], document=self.session_documents[st['session']])
        self.current.setdefault('documentSessions', {})[st['session']] = st['document']
        st['model'] = self.d.js('return window.__uModel(arguments[0])', st['session'])
        # The status hook shows at most 200 characters; compare the whole caret paragraph from the engine model.
        full = self.d.js('return window.__uParagraph(arguments[0],arguments[1])', st['session'], st['caret'])
        self.check(label + ': status paragraph is a prefix of the engine paragraph', full[:200] == st['paragraphText'], [st['paragraphText'][:40], full[:40]])
        st['paragraphText'] = full
        st['ime'] = self.d.js('return window.__uIme(arguments[0])', st['session'])
        st['undo'], st['redo'] = self.button('edit.undo'), self.button('edit.redo')
        self.current['states'].append({'label': label, **{k: st.get(k) for k in ('runId', 'scenarioId', 'format', 'document', 'session', 'paragraphText', 'caret', 'selection', 'localRevision', 'revision', 'composing', 'status', 'uncertain', 'pages', 'settleSeconds', 'undo', 'redo', 'ime')},
                                       'modelParagraphs': st['model']['paragraphs'], 'modelPages': st['model']['pages'], 'modelSha256': hashlib.sha256(st['model']['text'].encode()).hexdigest()})
        return st

    def check(self, name, ok, detail=None):
        self.current['checks'].append({'name': name, 'status': 'PASS' if ok else 'FAIL', **({'detail': detail} if detail is not None else {})})
        if not ok:
            raise smoke.Failure(f'{self.current["format"]}:{self.current["case"]}: {name} {json.dumps(detail, ensure_ascii=False) if detail is not None else ""}')

    def ready_ok(self, st, label):
        self.check(label + ' ready/certain/settled', st['status'] == 'ready' and st.get('uncertain') == 'false' and st['composing'] == 'false'
                   and st['localRevision'] == st['revision'], {k: st.get(k) for k in ('status', 'uncertain', 'composing', 'localRevision', 'revision')})

    def chain(self, label, stop, direction='undo', limit=80, via=None):
        """Press Undo/Redo one step at a time until `stop(state)` or the command becomes unavailable."""
        states = []
        def finish(values):
            self.current.setdefault('chains', []).append({'label': label, 'direction': direction, 'limit': limit, 'states': [s['label'] for s in values]})
            return values
        for i in range(limit):
            st = self.state(f'{label} before {direction} {i}') if not states else states[-1]
            if stop(st) or st[direction]['disabled']:
                return finish(states if states else [st])
            rev = int(st['localRevision'])
            if via and via(i):
                self.click(f'[data-command="edit.{direction}"]')
            else:
                self.key('ctrl+z' if direction == 'undo' else 'ctrl+y')
            nxt = self.state(f'{label} {direction} {i}')
            self.check(f'{label} {direction} {i} advances revision by one', int(nxt['localRevision']) == rev + 1, [rev, nxt['localRevision']])
            if not states:
                states.append(st)
            states.append(nxt)
        raise smoke.Failure(f'{label}: {direction} chain did not stop within {limit}')

    def events_trusted(self):
        events = self.d.js('return window.__uEvents')
        return bool(events) and all(e['trusted'] for e in events), len(events)

    def reset_events(self):
        self.d.js('window.__uEvents=[]')

    # ---- scenarios ----
    def scenario(self, fmt, case, fn):
        row = {'runId': self.report['runId'], 'scenarioId': uuid.uuid4().hex, 'format': fmt, 'case': case, 'status': 'RUNNING', 'checks': [], 'states': [], 'started': time.time()}
        self.rows.append(row)
        self.current = row
        self.d.js('window.__uScope=arguments[0]', {k: row[k] for k in ('runId', 'scenarioId', 'format')})
        try:
            fn(fmt)
            trusted, count = self.events_trusted()
            self.check('all editor input events trusted native', trusted, count)
            row['status'] = 'PASS'
        except Exception as error:  # record and continue with the next scenario
            row['status'] = 'FAIL'
            row['error'] = f'{type(error).__name__}: {error}'
            row['trace'] = traceback.format_exc()
            try:
                row['failureDom'] = self.d.js("return {status:[...document.querySelectorAll('[data-testid$=status]')].map(e=>({...e.dataset})),notice:document.querySelector('footer.statusbar')?.textContent,events:(window.__uEvents||[]).slice(-40)}")
                self.d.screenshot(self.args.out / f'{fmt}-{case}-failure.png')
            except Exception as diag:
                row['diagnosticError'] = str(diag)
        finally:
            row['seconds'] = round(time.time() - row.pop('started'), 1)
            try:
                for s in poc.ipc(self.d, 'document_sessions')['ok']:
                    if s['displayName'].startswith('u-'):
                        self.close(s['displayName'])
            except Exception as cleanup:
                row['cleanupError'] = str(cleanup)
                row['status'] = 'FAIL'
            (self.args.out / 'scenarios.json').write_text(json.dumps(self.rows, ensure_ascii=False, indent=2) + '\n')

    def english(self, fmt):
        self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-english.{fmt}')
        self.engine('latin'); self.reset_events()
        base = self.state('base'); t0 = base['paragraphText']
        self.check('fresh document has no Undo/Redo', base['undo']['disabled'] and base['redo']['disabled'], [base['undo'], base['redo']])
        self.typ('Hello world 123')
        typed = self.state('typed')
        self.check('continuous English exact (no loss/duplication)', typed['paragraphText'] == 'Hello world 123' + t0, typed['paragraphText'])
        self.check('Undo enabled after typing', not typed['undo']['disabled'], typed['undo'])
        self.key('ctrl+z'); un = self.state('Ctrl+Z')
        self.check('one Undo restores text and caret', un['paragraphText'] == t0 and un['caret'] == base['caret'], [un['paragraphText'], un['caret'], base['caret']])
        self.check('Undo exhausted / Redo enabled', un['undo']['disabled'] and not un['redo']['disabled'], [un['undo'], un['redo']])
        self.key('ctrl+y'); re = self.state('Ctrl+Y')
        self.check('Redo restores text and caret', re['paragraphText'] == typed['paragraphText'] and re['caret'] == typed['caret'], [re['paragraphText'], re['caret']])
        rev = re['localRevision']; self.key('ctrl+shift+z'); idle = self.state('Ctrl+Shift+Z with nothing to redo')
        self.check('Ctrl+Shift+Z without Redo is a no-op', idle['paragraphText'] == re['paragraphText'] and idle['localRevision'] == rev)
        # Several transactions separated by caret movement.
        self.key('Home'); self.typ('A'); s1 = self.state('T1')
        self.key('End'); self.typ('Z'); s2 = self.state('T2')
        self.key('Home', 'Right', 'Right'); self.typ('m'); s3 = self.state('T3')
        exp1 = 'AHello world 123' + t0
        self.check('three separated edits exact', s1['paragraphText'] == exp1 and s2['paragraphText'] == exp1 + 'Z' and s3['paragraphText'] == 'AHm' + 'ello world 123' + t0 + 'Z',
                   [s1['paragraphText'], s2['paragraphText'], s3['paragraphText']])
        self.key('ctrl+z'); u1 = self.state('Undo T3 (Ctrl+Z)')
        self.click('[data-command="edit.undo"]'); u2 = self.state('Undo T2 (ribbon button)')
        self.key('ctrl+z'); u3 = self.state('Undo T1 (Ctrl+Z)')
        self.check('Undo walks back each transaction', [u1['paragraphText'], u2['paragraphText'], u3['paragraphText']] == [s2['paragraphText'], s1['paragraphText'], re['paragraphText']],
                   [u1['paragraphText'], u2['paragraphText'], u3['paragraphText']])
        at = base['caret'].rsplit(':', 1)[0] + ':'
        self.check('Undo restores each pre-edit caret', [u1['caret'], u2['caret'], u3['caret']] == [at + '2', at + str(len(exp1)), at + '0'], [u1['caret'], u2['caret'], u3['caret']])
        self.key('ctrl+y'); r1 = self.state('Redo T1 (Ctrl+Y)')
        self.click('[data-command="edit.redo"]'); r2 = self.state('Redo T2 (ribbon button)')
        # Each history state owns one caret checkpoint (where the following edit began, or the caret when its head
        # state was left by Undo); Redo restores the same checkpoint the Undo walk showed for that state.
        self.check('Redo replays transactions with caret', [r1['paragraphText'], r2['paragraphText']] == [s1['paragraphText'], s2['paragraphText']] and [r1['caret'], r2['caret']] == [u2['caret'], u1['caret']],
                   [r1['paragraphText'], r2['paragraphText'], r1['caret'], r2['caret']])
        self.check('Redo still available for T3', not r2['redo']['disabled'], r2['redo'])
        self.key('End'); self.typ('Q'); n = self.state('new edit after Undo')
        self.check('new edit invalidates Redo branch', n['redo']['disabled'] and n['paragraphText'] == s2['paragraphText'] + 'Q', [n['redo'], n['paragraphText']])
        rev = n['localRevision']; self.key('ctrl+y'); nr = self.state('Ctrl+Y on invalidated branch')
        self.check('invalidated Redo does nothing', nr['paragraphText'] == n['paragraphText'] and nr['localRevision'] == rev)
        self.key('ctrl+z'); nu = self.state('Undo new edit')
        self.check('Undo after branch change restores branch point', nu['paragraphText'] == s2['paragraphText'], nu['paragraphText'])
        self.ready_ok(nu, 'english final')

    def korean(self, fmt):
        self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-korean.{fmt}')
        self.engine('hangul'); self.reset_events()
        base = self.state('base'); t0 = base['paragraphText']
        self.typ('dkssudgktpdy'); self.key('space'); self.typ('gksrmf'); self.key('End')
        typed = self.state('Korean typed')
        self.check('continuous Korean IME exact', typed['paragraphText'] == '안녕하세요 한글' + t0, typed['paragraphText'])
        events = self.d.js('return window.__uEvents')
        self.check('real composition lifecycle observed', sum(e['type'] == 'compositionstart' for e in events) >= 2 and sum(e['type'] == 'compositionend' for e in events) >= 2)
        typed_prefix = '안녕하세요 한글'
        undo = self.chain('Korean', lambda st: st['paragraphText'] == t0)
        texts = [st['paragraphText'] for st in undo]
        self.check('Undo chain reaches original', texts[-1] == t0 and undo[-1]['caret'] == base['caret'], [texts[-1], undo[-1]['caret']])
        self.check('every Undo state is a strict typed prefix', all(x.endswith(t0) and typed_prefix.startswith(x[:len(x) - len(t0)]) for x in texts)
                   and all(len(a) > len(b) for a, b in zip(texts, texts[1:])), texts)
        redo = self.chain('Korean redo', lambda st: False, 'redo')
        self.check('Redo chain mirrors Undo chain (text and caret)', [s['paragraphText'] for s in redo] == texts[::-1] and [s['caret'] for s in redo] == [s['caret'] for s in undo[::-1]],
                   [[s['paragraphText'], s['caret']] for s in redo])
        # Korean/English mode switching in ordinary editing.
        mid = redo[-1]['paragraphText']
        self.engine('latin'); self.typ(' abc'); self.engine('hangul'); self.typ('dkssud'); self.key('End')
        mixed = self.state('mixed typed')
        # Redo restored the caret where Undo started (paragraph end after the final End key).
        self.check('Hangul/Latin toggled input exact', mixed['paragraphText'] == typed_prefix + t0 + ' abc안녕', mixed['paragraphText'])
        back = self.chain('mixed', lambda st: st['paragraphText'] == mid)
        self.check('mode-switch edits undo back to previous branch point', back[-1]['paragraphText'] == mid, [s['paragraphText'] for s in back])
        fwd = self.chain('mixed redo', lambda st: False, 'redo')
        self.check('mode-switch redo exact (text and caret)', fwd[-1]['paragraphText'] == mixed['paragraphText'] and fwd[-1]['caret'] == mixed['caret'], [fwd[-1]['paragraphText'], fwd[-1]['caret']])
        # Undo immediately after a completed composition (no settle between commit and Ctrl+Z).
        before = fwd[-1]
        self.typ('rk'); self.key('End', 'ctrl+z', delay=15)
        un = self.state('Undo right after composition commit')
        self.check('immediate Undo removes only the committed syllable', un['paragraphText'] == before['paragraphText'], [un['paragraphText'], before['paragraphText']])
        self.key('ctrl+y'); re = self.state('Redo committed syllable')
        self.check('Redo restores the committed syllable', re['paragraphText'] == mixed['paragraphText'] + '가', re['paragraphText'])
        # Capture only this native trial; do not conflate it with the original E→U→F probe.
        self.reset_events()
        self.d.js("window.__geulTrace={seq:0,dropped:0,records:[]};window.__geulTraceRecord('native:t010-composition-scope',arguments[0])", {**{k:self.current[k] for k in ('runId','scenarioId','format')},'session':re['session']})
        self.typ('sk'); pre = self.state('preedit visible')
        gate.insertion(re, pre, '나')
        self.check('native preedit active before Ctrl+Z', pre['composing'] == 'true')
        self.key('ctrl+z'); cz = self.state('Ctrl+Z during composition')
        events = self.d.js('return window.__uEvents')
        trace = self.d.js('return window.__geulTrace')
        self.current['compositionUndo'] = {**{k:self.current[k] for k in ('runId','scenarioId','format')}, 'session':re['session'], 'stateLabels':list(KOREAN_STATES), 'events': events, 'trace': trace}
        result = gate.verdict(gate.composition_undo, re, pre, cz, events, trace)
        self.check('composition Undo has exact native text/caret/revision/history outcome', result['status'] == 'PASS', result)
        self.current['compositionUndo']['outcome'] = gate.composition_undo(re, pre, cz, events, trace)
        self.typ('ekf'); self.key('End'); after = self.state('typing after composition Undo')
        result = gate.verdict(gate.insertion, cz, after, '달', end=True)
        self.check('editing continues at the exact restored caret', result['status'] == 'PASS', result)
        self.check('new composition commits exactly one revision', int(after['localRevision']) == int(cz['localRevision']) + 1
                   and after['ime']['historyTransaction'] is False, after['ime'])
        self.ready_ok(after, 'korean final')

    def selection(self, fmt):
        self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-selection.{fmt}')
        self.engine('latin'); self.reset_events()
        base = self.state('base'); t0 = base['paragraphText']
        self.key('shift+Right', 'shift+Right', 'shift+Right'); sel = self.state('selection')
        self.check('native selection made', sel['selection'] != '', sel['selection'])
        self.typ('XY'); rep = self.state('replace selection')
        self.check('selection replaced exactly', rep['paragraphText'] == 'XY' + t0[3:] and rep['selection'] == '', [rep['paragraphText'], rep['selection']])
        self.key('ctrl+z'); un = self.state('Undo replacement')
        self.check('Undo restores text and selection', un['paragraphText'] == t0 and un['selection'] == sel['selection'] and un['caret'] == sel['caret'], [un['paragraphText'], un['selection'], un['caret']])
        self.key('ctrl+y'); re = self.state('Redo replacement')
        self.check('Redo restores replacement and caret', re['paragraphText'] == rep['paragraphText'] and re['caret'] == rep['caret'], [re['paragraphText'], re['caret']])
        self.key('Right', 'Right', 'Left'); self.typ('-'); ins = self.state('insert after caret moves')
        self.check('caret movement places insertion', ins['paragraphText'] == 'XY' + t0[3:4] + '-' + t0[4:], ins['paragraphText'])
        self.key('shift+End'); self.key('BackSpace'); cut = self.state('delete selected tail')
        self.check('selection delete exact', cut['paragraphText'] == 'XY' + t0[3:4] + '-', cut['paragraphText'])
        self.key('ctrl+z'); u1 = self.state('Undo delete')
        self.key('ctrl+z'); u2 = self.state('Undo insert')
        self.check('Undo delete then insert', u1['paragraphText'] == ins['paragraphText'] and u2['paragraphText'] == rep['paragraphText'], [u1['paragraphText'], u2['paragraphText']])
        self.key('ctrl+shift+z'); r1 = self.state('Redo insert via Ctrl+Shift+Z')
        self.check('Ctrl+Shift+Z redoes', r1['paragraphText'] == ins['paragraphText'], r1['paragraphText'])
        self.ready_ok(r1, 'selection final')

    def boundary(self, fmt):
        self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-boundary.{fmt}')
        self.engine('latin'); self.reset_events()
        base = self.state('base'); m0 = base['model']
        self.key('End')
        presses = 0
        # Rapid Return presses while pagination/rendering of earlier presses is still pending.
        while int(poc.status(self.d)['pages']) <= int(base['pages']) and presses < 140:
            self.key(*(['Return'] * 20), delay=12); presses += 20
            st = self.state(f'after {presses} Returns', timeout=120)
            self.check(f'{presses} rapid Returns all applied', st['model']['paragraphs'] == m0['paragraphs'] + presses, [st['model']['paragraphs'], m0['paragraphs'] + presses])
        self.check('page boundary crossed', int(st['pages']) > int(base['pages']), [st['pages'], base['pages']])
        self.typ('Page two text'); full = self.state('typed on new page')
        self.check('text typed at new page exact', full['paragraphText'] == 'Page two text', full['paragraphText'])
        undo = self.chain('boundary', lambda s: False, limit=presses + 5)
        steps = len(undo) - 1
        oldest = undo[-1]
        evicted = presses + 1 - steps
        self.current['boundary'] = {'presses': presses, 'evicted': evicted}
        self.check('history depth bounded and oldest state consistent', 0 <= evicted and oldest['model']['paragraphs'] == m0['paragraphs'] + max(0, evicted),
                   {'steps': steps, 'presses': presses, 'paragraphs': oldest['model']['paragraphs']})
        if evicted <= 0:
            self.check('full Undo restores original model and pages', oldest['model']['text'] == m0['text'] and oldest['pages'] == base['pages'])
        redo = self.chain('boundary redo', lambda s: False, 'redo', limit=presses + 5)
        self.check('Redo replays to the full state', redo[-1]['model']['text'] == full['model']['text'] and redo[-1]['pages'] == full['pages'], [redo[-1]['pages'], full['pages']])
        # Rapid history navigation while pagination is pending: 10 Undo presses without waiting.
        k = min(10, steps)
        self.key(*(['ctrl+z'] * k), delay=12)
        fast = self.state('10 rapid Undo', timeout=120)
        expect = undo[k]
        self.check('rapid Undo equals k sequential Undo steps', fast['model']['text'] == expect['model']['text'] and fast['pages'] == expect['pages'] and int(fast['localRevision']) == int(redo[-1]['localRevision']) + k,
                   [fast['pages'], expect['pages'], fast['localRevision']])
        self.key(*(['ctrl+y'] * k), delay=12)
        back = self.state('10 rapid Redo', timeout=120)
        self.check('rapid Redo returns to full state', back['model']['text'] == full['model']['text'], back['pages'])
        # Merge across the paragraph boundary and continue editing.
        self.key('Home', 'BackSpace'); merged = self.state('merge paragraphs')
        self.check('BackSpace merges at paragraph start', merged['model']['paragraphs'] == full['model']['paragraphs'] - 1, merged['model']['paragraphs'])
        self.key('ctrl+z'); split = self.state('Undo merge')
        self.check('Undo merge restores split and caret', split['model']['text'] == full['model']['text'] and split['caret'] == back['caret'].rsplit(':', 1)[0] + ':0', [split['caret'], back['caret']])
        self.ready_ok(split, 'boundary final')

    def switch(self, fmt):
        a = self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-switch-a.{fmt}')
        self.engine('latin'); self.reset_events()
        abase = self.state('A base')
        self.typ('alpha'); atyped = self.state('A typed')
        b = self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-switch-b.{fmt}')
        bbase = self.state('B base')
        self.check('B starts without history (no cross-document Undo)', bbase['undo']['disabled'], bbase['undo'])
        self.typ('beta'); btyped = self.state('B typed')
        self.key('ctrl+z'); bun = self.state('B Undo')
        amodel = self.d.js('return window.__uModel(arguments[0])', atyped['session'])
        self.check('B Undo affects only B', bun['paragraphText'] == bbase['paragraphText'] and amodel['text'] == atyped['model']['text'], [bun['paragraphText']])
        self.tab(a.name); self.focus_start(); self.key('End')
        aundo_before = self.state('A after switch')
        self.check('A history intact after switch', aundo_before['paragraphText'] == atyped['paragraphText'] and not aundo_before['undo']['disabled'])
        self.key('ctrl+z'); aun = self.state('A Undo')
        bmodel = self.d.js('return window.__uModel(arguments[0])', bun['session'])
        self.check('A Undo affects only A', aun['paragraphText'] == abase['paragraphText'] and bmodel['text'] == bun['model']['text'])
        self.key('ctrl+y'); are = self.state('A Redo')
        self.check('A Redo exact', are['paragraphText'] == atyped['paragraphText'])
        # Switch while composing: preedit belongs to A, B stays untouched and keeps its own Redo.
        self.engine('hangul'); self.typ('rk'); self.state('A preedit')
        self.tab(b.name); bafter = self.state('B after composing switch')
        self.check('B unchanged by A composition; B Redo kept', bafter['model']['text'] == bun['model']['text'] and not bafter['redo']['disabled'], bafter['redo'])
        self.focus_start(); self.key('ctrl+y'); bre = self.state('B Redo after switch')
        self.check('B Redo exact', bre['paragraphText'] == btyped['paragraphText'], bre['paragraphText'])
        afinal = self.d.js('return window.__uModel(arguments[0])', are['session'])
        self.check('A received its composed syllable exactly once', afinal['text'].count('가') == are['model']['text'].count('가') + 1, afinal['text'].split('\n')[0])
        self.ready_ok(bre, 'switch final')

    def close_case(self, fmt):
        path = self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-close.{fmt}')
        self.engine('latin'); self.reset_events()
        base = self.state('base')
        self.typ('discard me'); self.state('typed')
        self.close(path.name)
        poc.open_document(self.d, path); self.d.js('return window.__uBind(arguments[0])', self.sid()); self.focus_start()
        fresh = self.state('reopened after discard')
        self.check('discarded edit absent and no stale history', fresh['paragraphText'] == base['paragraphText'] and fresh['undo']['disabled'] and fresh['redo']['disabled'] and fresh['session'] != base['session'],
                   [fresh['paragraphText'], fresh['undo'], fresh['session'], base['session']])
        rev = fresh['localRevision']; self.key('ctrl+z'); noop = self.state('Ctrl+Z on fresh session')
        self.check('Ctrl+Z on fresh session is a no-op', noop['paragraphText'] == fresh['paragraphText'] and noop['localRevision'] == rev)
        self.typ('new'); after = self.state('new input after reopen')
        self.check('new session edits normally', after['paragraphText'] == 'new' + base['paragraphText'])
        self.ready_ok(after, 'close final')

    def save(self, fmt):
        path = self.open(self.args.fixtures / f'basic-ko.{fmt}', f'u-save.{fmt}')
        self.engine('latin'); self.reset_events()
        base = self.state('base'); t0 = base['paragraphText']
        self.typ('Saved line '); self.key('Home'); self.typ('X'); self.state('typed')
        self.key('ctrl+z'); self.key('ctrl+z'); u = self.state('two Undo')
        self.check('two Undo back to original', u['paragraphText'] == t0)
        self.key('ctrl+y'); r = self.state('one Redo')
        self.check('Redo first transaction', r['paragraphText'] == 'Saved line ' + t0, r['paragraphText'])
        self.key('ctrl+s')
        smoke.wait_until(self.d, "const e=document.querySelector('[data-testid=rhwp-save-result]');return e&&['saved','failed'].includes(e.dataset.state)", timeout=90)
        result = self.d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
        self.current['save'] = result
        self.check('save after Undo/Redo succeeded', result.get('state') == 'saved', result)
        smoke.wait_until(self.d, "return document.querySelector('[data-testid=rhwp-status]')?.dataset.dirty==='false'")
        saved = self.state('after save')
        self.check('history remains usable after save', not saved['undo']['disabled'] and not saved['redo']['disabled'], [saved['undo'], saved['redo']])
        self.current['savedSha256'] = sha(path)
        self.close(path.name, discard=False)
        poc.open_document(self.d, path); self.d.js('return window.__uBind(arguments[0])', self.sid()); self.focus_start()
        reopened = self.state('reopened saved file')
        self.check('reopened file holds the Undo/Redo result', reopened['paragraphText'] == 'Saved line ' + t0 and reopened['model']['text'] == saved['model']['text'], reopened['paragraphText'])
        self.check('reopened session has fresh history', reopened['undo']['disabled'] and reopened['redo']['disabled'])
        self.typ('ok '); cont = self.state('edit reopened file'); self.key('ctrl+z'); back = self.state('Undo on reopened file')
        self.check('editing and Undo continue on reopened file', cont['paragraphText'] == 'ok Saved line ' + t0 and back['paragraphText'] == reopened['paragraphText'])
        self.ready_ok(back, 'save final')

    def complex(self, fmt):
        for source in COMPLEX:
            if source.suffix != '.' + fmt:
                continue
            name = 'u-complex-' + hashlib.sha256(source.name.encode()).hexdigest()[:8] + source.suffix
            self.current.setdefault('documents', []).append({'source': str(source.relative_to(ROOT)), 'sha256': sha(source), 'copy': name})
            path = self.args.out / name
            shutil.copyfile(source, path)
            poc.open_document(self.d, path)
            self.d.js('return window.__uBind(arguments[0])', self.sid())
            try:
                smoke.wait_until(self.d, "return !!document.querySelector('.rhwp-page')", timeout=20)
                zoom = 100
            except smoke.ConditionTimeout:
                # Existing product canvas-memory limit at 100% (render notice; editing paused). Same zoom
                # step undo_native uses for this multi-section sample; not related to history.
                zoom = 50
                poc.set_zoom(self.d, zoom)
            self.current['documents'][-1]['zoom'] = zoom
            self.focus_start()
            self.engine('latin'); self.reset_events()
            base = self.state(f'{name} base', timeout=180); t0 = base['paragraphText']
            text = 'The quick brown fox jumps over the lazy dog 0123456789 ' * 2
            sent = time.monotonic()
            # Monitor backlog while typing: keydowns received vs revision applied.
            self.d.js("""window.__uBacklog=[];window.__uBacklogTimer=setInterval(()=>{const e=document.querySelector('[data-testid=rhwp-status]');
              window.__uBacklog.push([performance.now(),(window.__uEvents||[]).filter(x=>x.type==='keydown').length,Number(e?.dataset.localRevision),Number(e?.dataset.revision)])},100)""")
            self.typ(text, delay=8)
            keys_done = time.monotonic()
            typed = self.state(f'{name} rapid typing', timeout=300)
            self.d.js('clearInterval(window.__uBacklogTimer)')
            series = self.d.js('return window.__uBacklog')
            converged = time.monotonic()
            self.current.setdefault('backlog', []).append({'document': name, 'chars': len(text), 'keySendSeconds': round(keys_done - sent, 2),
                                                           'convergedAfterKeysSeconds': round(typed['settleSeconds'], 2), 'samples': series[-60:]})
            self.check(f'{name} rapid typing exact (no loss/duplication)', typed['paragraphText'] == text + t0, len(typed['paragraphText']) - len(t0))
            # Responsiveness after the backlog: a single key is reflected and settles.
            t = time.monotonic(); self.typ('!'); one = self.state(f'{name} single key after backlog', timeout=120)
            self.current['backlog'][-1]['singleKeySettleSeconds'] = round(time.monotonic() - t, 2)
            self.check(f'{name} responsive after typing burst', one['paragraphText'] == text + '!' + t0)
            # Ordinary human typing rate (~8 keys/s): the keydown-vs-applied-revision lag must stay bounded and
            # the document must settle right after the last key (no accumulating queue).
            human = 'Human rate 0123456789 abcdefghij'
            self.d.js("window.__uBacklog=[];window.__uBacklogTimer=setInterval(()=>{const e=document.querySelector('[data-testid=rhwp-status]');window.__uBacklog.push([performance.now(),(window.__uEvents||[]).filter(x=>x.type==='keydown').length,Number(e?.dataset.localRevision),Number(e?.dataset.revision)])},100)")
            k0 = len([e for e in self.d.js('return window.__uEvents') if e['type'] == 'keydown']); r0 = int(one['localRevision'])
            sent = time.monotonic(); self.typ(human, delay=120); keys_done = time.monotonic()
            hs = self.state(f'{name} human-rate typing', timeout=120)
            self.d.js('clearInterval(window.__uBacklogTimer)')
            series = self.d.js('return window.__uBacklog')
            lags = [(k - k0) - (rev - r0) for _, k, rev, _ in series]
            downs = [e['t'] for e in self.d.js('return window.__uEvents') if e['type'] == 'keydown'][k0:]
            self.current['backlog'].append({'document': name, 'mode': 'human-rate 120ms', 'chars': len(human), 'keySendSeconds': round(keys_done - sent, 2),
                                            'settleAfterKeysSeconds': hs['settleSeconds'], 'maxKeydownMinusAppliedLag': max(lags),
                                            'keydownsReceived': len(downs), 'receiptSpanSeconds': round((downs[-1] - downs[0]) / 1000, 2) if downs else None, 'samples': series[-80:]})
            self.check(f'{name} human-rate typing exact', hs['paragraphText'] == text + '!' + human + t0, hs['paragraphText'][len(text):len(text) + 40])
            self.check(f'{name} human-rate typing keeps no input backlog', max(lags) <= 3, max(lags))
            self.engine('hangul'); self.typ('dkssudgktpdy'); self.key('space'); self.typ('gksrmf'); self.key('End'); ko = self.state(f'{name} Korean', timeout=180)
            prefix = text + '!' + human + '안녕하세요 한글'
            self.check(f'{name} Korean IME in complex document exact', ko['paragraphText'] == prefix + t0, ko['paragraphText'][:len(prefix) + 8])
            self.engine('latin')
            undo = self.chain(name, lambda s: s['paragraphText'] == t0, limit=120)
            last = undo[-1]
            self.check(f'{name} Undo restores original model and pages', last['paragraphText'] == t0 and last['model']['text'] == base['model']['text'] and last['pages'] == base['pages'],
                       [last['paragraphText'][:40], last['pages'], base['pages']])
            redo = self.chain(name + ' redo', lambda s: False, 'redo', limit=120)
            self.check(f'{name} Redo restores full edit', redo[-1]['model']['text'] == ko['model']['text'] and redo[-1]['pages'] == ko['pages'])
            self.typ('END'); cont = self.state(f'{name} continued editing', timeout=120)
            at = int(redo[-1]['caret'].split('@')[0].split(':')[2])  # End moves to the visual line end in wrapped paragraphs
            self.check(f'{name} Redo restores the caret checkpoint', redo[-1]['caret'] == ko['caret'], [redo[-1]['caret'], ko['caret']])
            self.check(f'{name} editing continues after long history sequence', cont['paragraphText'] == ko['paragraphText'][:at] + 'END' + ko['paragraphText'][at:], cont['paragraphText'][max(0, at - 10):at + 13])
            self.ready_ok(cont, name + ' final')
            self.close(path.name)
            if zoom != 100:
                poc.set_zoom(self.d, 100)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ('app', 'driver', 'xdotool', 'ibus'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--port', type=int, default=4444)
    parser.add_argument('--only', default='')
    parser.add_argument('--formats', default='hwp,hwpx')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    selected = [c for c in args.only.split(',') if c] or list(CASES)
    report = {'runId': os.environ.get('GEUL_NATIVE_RUN_ID') or uuid.uuid4().hex, 'status': 'RUNNING', 'harnessSha256': sha(__file__), 'validatorSha256': {n: sha(ROOT / 'scripts/tests' / n) for n in ('t010_acceptance.py', 't010_usability_contract.py', 't010_launcher.py', 't010_lifecycle.py', 'native-ibus-session.py')}, 'appSha256': sha(args.app), 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'sourceDiffSha256': hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src'], cwd=ROOT)).hexdigest(),
              'sourceSha256': {p: sha(ROOT / p) for p in SOURCES}, 'cases': selected, 'formatsRequested': args.formats.split(','), 'requestedCoverage': 'full' if set(selected)==set(CASES) and set(args.formats.split(','))==set(gate.FORMATS) else 'selected',
              'environment': {'VITE_GEUL_TEST_HOOKS': os.environ.get('VITE_GEUL_TEST_HOOKS'), 'VITE_GEUL_TEST_RHWP_HISTORY': os.environ.get('VITE_GEUL_TEST_RHWP_HISTORY'),
                              'display': os.environ.get('DISPLAY'), 'gtkIm': os.environ.get('GTK_IM_MODULE'), 'syntheticComposition': False}}
    smoke.APP = os.path.abspath(args.app)
    smoke.DRIVER_LOG = args.out / 'driver.log'
    try:
        gate.require(report['environment']['VITE_GEUL_TEST_RHWP_HISTORY'] in (None, '', '0'), 'general history must come from the product registry')
        gate.require(set(selected) <= set(CASES), 'unknown usability case')
        with tempfile.TemporaryDirectory(prefix='geul-t010-usability-') as scratch:
            args.fixtures = Path(scratch) / 'fixtures'
            subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(args.fixtures)], check=True, capture_output=True)
            report['fixtureSha256'] = {p.name: sha(p) for p in sorted(args.fixtures.glob('basic-ko.hwp*'))}
            report['complexSha256'] = {str(p.relative_to(ROOT)): sha(p) for p in COMPLEX}
            with tempfile.TemporaryDirectory(prefix='geul-t010-usability-data-') as data, lifecycle.driver(smoke, args.driver, args.port, data, report) as start:
                d = start()
                try:
                    smoke.wait_until(d, "return document.querySelector('.document-bar')!==null", timeout=60)
                    d.js("window.__uId=null;fetch('/rhwp/BUILD.json').then(r=>r.json()).then(v=>window.__uId=v)")
                    smoke.wait_until(d, 'return window.__uId!==null')
                    report['servedIdentity'] = d.js('return window.__uId')
                    u = Usability(d, args, report)
                    u.setup()
                    for fmt in args.formats.split(','):
                        for case in selected:
                            fn = {'english': u.english, 'korean': u.korean, 'selection': u.selection, 'boundary': u.boundary, 'switch': u.switch,
                                  'close': u.close_case, 'save': u.save, 'complex': u.complex}[case]
                            u.scenario(fmt, case, fn)
                            print(json.dumps({k: report['scenarios'][-1].get(k) for k in ('format', 'case', 'status', 'error', 'seconds')}, ensure_ascii=False), flush=True)
                finally:
                    smoke.end_session(d)
        report['status'] = 'PENDING'
    except Exception as error:
        report.update(status='FAIL', error=f'{type(error).__name__}: {error}', trace=traceback.format_exc())
    finally:
        report['acceptance'] = gate.verdict(gate.usability, report, args.formats.split(','), selected)
        report['usabilityCoverage'] = gate.usability_coverage(report, args.formats.split(','), selected)
        if report['usabilityCoverage']['fullUsabilityCoverage'] == 'PASS':
            report['usabilityCoverage']['fullUsabilityCoverage'] = 'PENDING_CLEANUP'
        gate.pending_cleanup(report)
        report['summary'] = {f"{r['format']}:{r['case']}": {'status': r['status'], 'checks': len(r['checks']), 'failed': [c['name'] for c in r['checks'] if c['status'] != 'PASS']} for r in report.get('scenarios', [])}
        (args.out / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'summary': report['summary'], 'error': report.get('error')}, ensure_ascii=False, indent=2))
    return 0 if report['status'] in ('PASS', 'PENDING_CLEANUP') else 1


if __name__ == '__main__':
    sys.exit(main())
