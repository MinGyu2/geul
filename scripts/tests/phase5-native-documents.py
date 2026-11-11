#!/usr/bin/env python3
"""Stages 5-3 → 5-4 → 5-5, real native UI and independent disk oracles.

Requires a successful phase5-native-acceptance.py IBus result. No document
mutation is performed by JavaScript or direct model/IPC commands.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import traceback
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('phase5', ROOT / 'scripts/tests/phase5-native-acceptance.py')
base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
smoke, sha = base.smoke, base.sha


def structure(path):
    if path.suffix == '.docx':
        with zipfile.ZipFile(path) as z:
            assert z.testzip() is None
            tree = ET.fromstring(z.read('word/document.xml'))
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            return {'format': 'docx', 'text': ''.join(e.text or '' for e in tree.findall('.//w:t', ns)),
                    'paragraphs': len(tree.findall('.//w:p', ns)), 'tables': len(tree.findall('.//w:tbl', ns)),
                    'images': len(tree.findall('.//w:drawing', ns)), 'bullets': len(tree.findall('.//w:numPr', ns)),
                    'media': {n: sha_bytes(z.read(n)) for n in z.namelist() if n.startswith('word/media/')}}
    code = """
import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,file]=process.argv.slice(2),build=JSON.parse(readFileSync(root+'/public/rhwp/RELEASE.json')),
folder=root+'/public/rhwp/generations/'+build.generation,m=await import(pathToFileURL(folder+'/rhwp.js'));
m.initSync({module:readFileSync(folder+'/rhwp_bg.wasm')});
const d=new m.HwpDocument(readFileSync(file));try{const c=JSON.parse(d.getControls());
console.log(JSON.stringify({format:d.getSourceFormat(),text:d.getTextFileText(),paragraphs:d.getParagraphCount(0),pages:d.pageCount(),
tables:c.filter(x=>x.ctrlId==='tbl').length,images:c.filter(x=>x.userDesc==='그림').length,
bullets:Array.from({length:d.getParagraphCount(0)},(_,p)=>JSON.parse(d.getParaPropertiesAt(0,p))).filter(x=>x.headType==='Bullet').length,controls:c}));}finally{d.free()}
"""
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-', str(ROOT), str(path)], input=code, text=True))


def sha_bytes(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


class Documents(base.Acceptance):
    def __init__(self, args, d, report):
        super().__init__(args, d, report)
        self.root = args.out
        self.documents = self.root / 'documents'; self.documents.mkdir()
        self.sources = self.root / 'sources'; self.sources.mkdir()
        self.artifacts = []
        self.originals = {}
        self.command('xdotool', 'windowsize', self.window, '1440', '1000')

    def stage(self, value):
        self.args.stage = value
        self.args.out = self.root / value
        self.args.out.mkdir(exist_ok=True)

    def first(self):
        self.key('ctrl+Home')
        self.wait("return document.querySelector('.rhwp-caret')!==null")

    def editing(self):
        self.stage('5-3-editing')
        subprocess.run(['node', str(ROOT / 'tests/fixtures/rhwp/generate.mjs'), str(self.sources)], check=True, capture_output=True)
        subprocess.run([str(ROOT / 'src-tauri/target/debug/examples/wordcraft_fixture'), str(self.sources)], check=True, capture_output=True)
        self.originals = {str(p): sha(p) for p in self.sources.iterdir() if p.suffix in ('.hwp', '.hwpx', '.docx')}
        # Small controlled raster fixture; no external image or private document.
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        image = self.sources / 'blue.png'
        image.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 12, 8, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + b'\x20\x60\xd0' * 12) * 8)) + chunk(b'IEND', b''))
        for fmt in self.args.formats:
            self.fmt = fmt
            path = self.documents / ('rich.' + fmt)
            self.new(fmt, path); self.ready(fmt, path.name)
            self.type('English XYZ'); self.key('BackSpace', 'BackSpace', 'BackSpace'); self.type('edit ')
            self.korean('gksrmf', 'English edit 한글')
            self.key('Home', 'shift+Right'); self.type('e'); self.key('End')
            self.text_is(fmt, 'english edit 한글')
            self.record('new format native text / IBus / deletion / selection replacement', True, self.status(fmt))
            if fmt == 'docx':
                self.type('Z'); self.key('ctrl+z'); self.text_is(fmt, 'english edit 한글')
                self.key('ctrl+y'); self.text_is(fmt, 'english edit 한글Z')
                self.key('BackSpace')
                self.record('supported DOCX Undo/Redo restores text and caret', True)
            else:
                self.tab('홈')
                disabled = self.d.js("return document.querySelector('.ribbon__toolbar [data-command=\"edit.undo\"]')?.getAttribute('aria-disabled')")
                self.record('ordinary RHWP Undo remains explicitly disabled', disabled == 'true', disabled)
            self.key('Return')
            self.command_button('paragraph.bullets', '홈'); self.type('List ')
            self.korean('gksrmf', 'List 한글')
            self.record('ribbon bullets and real IBus list text', self.d.js("return document.querySelector('.ribbon__toolbar [data-command=\"paragraph.bullets\"]')?.getAttribute('aria-pressed')") == 'true', self.status(fmt))
            self.key('Return', 'Return')
            revision = self.status(fmt)['revision']
            self.command_button('insert.image', '삽입')
            dialog = self.chooser(image, '그림')
            second_activation = self.finish_native_open(dialog, '그림')
            self.wait("return document.querySelector(arguments[0])?.dataset.revision!==arguments[1]", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-status]', revision)
            self.record('native image chooser changes document model', True, {'editor': self.status(fmt), 'secondDialogActivation': second_activation})
            self.snap('image-inserted')
            self.key('End', 'Return')
            self.command_button('insert.table', '삽입')
            self.wait("return !!document.querySelector('[data-testid=command-input-dialog]')")
            self.key('Return')
            self.wait("return !document.querySelector('[data-testid=command-input-dialog]')")
            self.type('Cell '); self.korean('gksrmf', 'Cell 한글')
            self.key('Tab'); self.type('Cell2'); self.text_is(fmt, 'Cell2')
            self.record('ribbon table / visible cell input / Korean / native cell navigation', True, self.status(fmt))
            self.snap('rich-edited')
            self.artifacts.append({'format': fmt, 'path': str(path), 'kind': 'rich'})
            source = self.sources / ('basic-ko.' + fmt)
            existing = self.documents / ('existing.' + fmt); shutil.copyfile(source, existing)
            self.open_native(fmt, existing)
            self.first()
            self.key('End')
            initial = self.status(fmt)['paragraphText']
            self.type(' Existing ')
            self.korean('gksrmf', initial + ' Existing 한글')
            self.record('existing fixture native open / engine / Korean edit', self.status(fmt)['dirty'] == 'true', self.status(fmt))
            self.snap('existing-edited')
            self.artifacts.append({'format': fmt, 'path': str(existing), 'kind': 'existing', 'source': str(source), 'firstText': initial + ' Existing 한글'})
        self.flush()

    def persistence(self):
        self.stage('5-4-persistence')
        self.report['artifacts'] = self.artifacts
        for artifact in self.artifacts:
            self.fmt = artifact['format']; path = Path(artifact['path'])
            self.select(path.name)
            result = self.save(self.fmt)
            model = structure(path)
            artifact.update(savedSha256=sha(path), structure=model, save=result)
            self.record('actual GUI save / durable output / independent engine or XML reopen', result['state'] == 'saved' and result.get('synced') == 'true' and '한글' in model['text'], artifact)
            if artifact['kind'] == 'rich':
                self.record('independent text / paragraph / table / image / list preservation', model['tables'] >= 1 and model['images'] >= 1 and model['bullets'] >= 1 and 'Cell2' in model['text'] and 'List 한글' in model['text'], model)
            else:
                spec = importlib.util.spec_from_file_location('roundtrip', ROOT / 'scripts/tests/native-save-roundtrip.py')
                oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
                preserved = oracle.docx_structure(Path(artifact['source']), path) if self.fmt == 'docx' else oracle.rhwp_structure(Path(artifact['source']), path, artifact['firstText'])
                self.record('existing fixture untouched styles / paragraphs / tables / controls preserved', True, preserved)
            original_session = next(s['sessionId'] for s in self.sessions() if s['displayName'] == path.name)
            self.close(path.name); self.open_native(self.fmt, path)
            self.first()
            self.text_is(self.fmt, artifact.get('firstText', 'english edit 한글'))
            reopened = next(s for s in self.sessions() if s['displayName'] == path.name)
            self.record('native close / native file chooser reopen / fresh clean session', reopened['sessionId'] != original_session and not reopened['dirty'] and reopened['revision'] == 0, reopened)
            self.snap(artifact['kind'] + '-reopened')
            if artifact['kind'] == 'rich':
                before = sha(path)
                self.key('ctrl+shift+s')
                # Native chooser cancellation must not write either path.
                window = self.native_window('문서를 다른 이름으로 저장')
                self.native_screenshot(self.fmt + '-save-as-dialog')
                self.command('xdotool', 'windowfocus', '--sync', window); self.key('Escape')
                self.record('Save As cancellation preserves original bytes', sha(path) == before)
                destination = self.documents / ('saved-as.' + self.fmt)
                self.key('ctrl+shift+s'); self.chooser(destination, '문서를 다른 이름으로 저장')
                self.ready(self.fmt, destination.name)
                self.wait("return document.querySelector(arguments[0])?.dataset.dirty==='false'", '[data-testid=' + ('docx' if self.fmt == 'docx' else 'rhwp') + '-status]')
                independent = structure(destination)
                self.record('Save As retains current format and complete independent structure', independent == model and sha(path) == before, {'path': str(destination), 'sha256': sha(destination), 'structure': independent})
                self.close(destination.name); self.open_native(self.fmt, destination)
                self.record('Save As native close and reopen', self.status(self.fmt)['dirty'] == 'false')
                artifact['saveAs'] = str(destination)
        self.record('all immutable source fixture hashes preserved', all(sha(p) == digest for p, digest in self.originals.items()), self.originals)
        if 'hwp' not in self.args.formats:
            return
        # Controlled historical corruption fixture: an unknown first-paragraph
        # record prevents proving that a text-deleted first page is truly blank.
        source = ROOT / 'src-tauri/target/native-unknown-first-paragraph.hwp'
        source_hash = sha(source)
        unsafe = self.documents / 'unsafe-blank.hwp'; shutil.copyfile(source, unsafe)
        before = sha(unsafe)
        self.fmt = 'hwp'; self.open_native('hwp', unsafe); self.first()
        text = self.status('hwp')['paragraphText']
        self.key(*(['Delete'] * len(text)))
        self.text_is('hwp', '')
        self.key('ctrl+s')
        self.wait("return document.querySelector('[data-testid=rhwp-save-result]')?.dataset.state==='failed'", timeout=60)
        refused = self.d.js("return {...document.querySelector('[data-testid=rhwp-save-result]').dataset}")
        self.record('HWP unsafe blank-preview save refused / original bytes / dirty / no false success', refused.get('error') == 'UnsafeSave' and sha(unsafe) == before and sha(source) == source_hash and self.status('hwp')['dirty'] == 'true', {'source': str(source), 'sourceSha256': source_hash, 'result': refused, 'editor': self.status('hwp')})
        self.snap('unsafe-save-refused')
        self.click(unsafe.name, "[...document.querySelectorAll('.document-tab')].find(e=>e.textContent.includes(arguments[0]))?.querySelector('.document-tab__close')")
        self.wait("return !!document.querySelector('[role=alertdialog]')")
        self.click('[data-testid=discard-confirm]')
        self.wait("return ![...document.querySelectorAll('.document-tab__select')].some(e=>e.textContent.includes('unsafe-blank.hwp'))")
        self.record('unsafe-save session closes only after explicit discard confirmation', True)
        self.flush()

    def regression(self):
        self.stage('5-5-regression')
        for fmt in ('docx', 'hwpx', 'hwp'):
            self.fmt = fmt; self.select('saved-as.' + fmt); self.first()
            others = {s['sessionId']: (s['revision'], s['dirty']) for s in self.sessions() if s['displayName'] != 'saved-as.' + fmt}
            self.key('End'); self.type(' Isolation')
            after = {s['sessionId']: (s['revision'], s['dirty']) for s in self.sessions() if s['displayName'] != 'saved-as.' + fmt}
            self.record('multi-format native edit is isolated from all other documents', others == after, {'before': others, 'after': after})
            self.save(fmt)
            self.record('each multi-document session saves independently', 'Isolation' in structure(self.documents / ('saved-as.' + fmt))['text'])
        invalid = self.documents / 'invalid.docx'; invalid.write_bytes(b'controlled invalid phase5 fixture')
        self.key('ctrl+o'); dialog = self.chooser(invalid, '문서 열기')
        import time
        time.sleep(.5)
        if subprocess.run(['xdotool', 'getwindowname', dialog], capture_output=True).returncode == 0:
            self.command('xdotool', 'key', '--window', dialog, 'Return')
        self.wait("return /지원하지 않는 형식|확장자와 실제 형식|문서를 읽|파일을 읽/.test(document.querySelector('.statusbar__message')?.textContent||'')")
        self.record('invalid open reports failure without replacing ready documents', len([s for s in self.sessions() if s['state'] == 'ready']) == 6, {'sessions': self.sessions(), 'notice': self.d.js("return document.querySelector('.statusbar__message')?.textContent")})
        self.snap('invalid-open')
        self.fmt = 'docx'; self.select('saved-as.docx'); self.first(); self.key('End')
        before = self.status('docx')['paragraphText']
        external = subprocess.Popen([sys.executable, str(ROOT / 'scripts/tests/x11-clipboard-owner.py'), 'phase5 regression focus', '0', 'map'], stdout=subprocess.PIPE, text=True)
        try:
            identity = json.loads(external.stdout.readline())
            self.command('xdotool', 'windowfocus', '--sync', str(identity['owner']))
            self.command('xdotool', 'windowfocus', '--sync', self.window)
            self.type(' Recovery '); self.korean('gksrmf', before + ' Recovery 한글')
            self.save('docx')
            self.record('after invalid-open refusal / external focus / IBus recovery / save', 'Recovery 한글' in structure(self.documents / 'saved-as.docx')['text'], identity)
        finally:
            external.terminate(); external.wait(timeout=5)
        self.flush()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--ibus-result', type=Path, required=True)
    p.add_argument('--driver', default='/tmp/geul-tauri-driver-target/debug/tauri-driver')
    p.add_argument('--port', type=int, default=4594)
    p.add_argument('--formats', nargs='+', choices=['docx', 'hwpx', 'hwp'], default=['docx', 'hwpx', 'hwp'])
    p.add_argument('--stop-after', choices=['5-3', '5-4', '5-5'], default='5-5')
    p.add_argument('--capture-engine-exports', action='store_true', help='passively retain actual HWP export bytes on a diagnostic failure')
    p.add_argument('--resume-persistence-from', type=Path,
                   help='reuse inspected positive save results from the exact same app/source build; copy saved fixtures and retest refusal/cleanup before stage 5-5')
    args = p.parse_args()
    if args.stop_after == '5-5' and set(args.formats) != {'docx', 'hwpx', 'hwp'}:
        p.error('integrated regression requires all three formats; use --stop-after for a focused diagnostic')
    if args.resume_persistence_from and (args.stop_after != '5-5' or set(args.formats) != {'docx', 'hwpx', 'hwp'}):
        p.error('resumed integrated regression requires all three formats and --stop-after 5-5')
    ibus_result = json.loads(args.ibus_result.read_text())
    assert ibus_result['status'] == 'PASS' and {c['format'] for c in ibus_result['checks']} >= {'docx', 'hwpx', 'hwp'}, 'Stage 5-2 must pass independently for all three formats first'
    args.out = args.out.resolve(); args.out.relative_to(ROOT / 'target'); args.out.mkdir(exist_ok=False, parents=True)
    root = args.out
    args.xdotool = 'xdotool'; args.ibus = 'ibus'; args.stage = '5-3-editing'
    smoke.APP = str(ROOT / 'src-tauri/target/debug/geul'); smoke.DRIVER_LOG = root / 'driver.log'
    report = {'status': 'RUNNING', 'checks': [], 'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
              'appSha256': sha(smoke.APP), 'harnessSha256': sha(__file__), 'inputHarnessSha256': sha(ROOT / 'scripts/tests/phase5-native-acceptance.py'),
              'sourceDiffSha256': sha_bytes(subprocess.check_output(['git', 'diff', 'HEAD', '--', 'src', 'src-tauri'])),
              'rhwpBuild': json.loads((ROOT / 'public/rhwp/BUILD.json').read_text()),
              'environment': {k: os.environ.get(k) for k in ['DISPLAY', 'HOME', 'GTK_IM_MODULE', 'XMODIFIERS', 'IBUS_ADDRESS']}}
    report['scope'] = {'formats': args.formats, 'stopAfter': args.stop_after}
    try:
        with smoke.tauri_driver(args.driver, args.port, str(root / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, "return !!document.querySelector('.document-bar')", timeout=60)
                a = Documents(args, d, report)
                report['completedStages'] = []
                if args.resume_persistence_from:
                    previous = args.resume_persistence_from.resolve()
                    previous.relative_to(ROOT / 'target')
                    previous_report = json.loads((previous / 'result.json').read_text())
                    assert previous_report['appSha256'] == report['appSha256'], 'app build changed; rerun editing/save'
                    assert previous_report['sourceDiffSha256'] == report['sourceDiffSha256'], 'product source changed; rerun editing/save'
                    assert previous_report['rhwpBuild']['generation'] == report['rhwpBuild']['generation'], 'served engine changed; rerun editing/save'
                    assert '5-3-editing' in previous_report['completedStages']
                    for fmt in args.formats:
                        required = [c for c in previous_report['checks'] if c['format'] == fmt and c['stage'] == '5-4-persistence']
                        assert all(c['result'] == 'PASS' for c in required) and len(required) >= 9, 'positive persistence not verified for ' + fmt
                        for stem in ('saved-as', 'existing'):
                            source = previous / 'documents' / (stem + '.' + fmt)
                            target = a.documents / source.name
                            shutil.copyfile(source, target)
                            assert sha(source) == sha(target)
                            a.originals[str(source)] = sha(source)
                            a.fmt = fmt; a.open_native(fmt, target)
                    report['reusedEvidence'] = {'report': str(previous / 'result.json'), 'sha256': sha(previous / 'result.json'),
                                              'scope': '5-3 and positive 5-4 checks only; refusal and discard cleanup retested here',
                                              'checks': len(previous_report['checks'])}
                else:
                    a.editing(); report['completedStages'].append('5-3-editing')
                if args.stop_after != '5-3':
                    a.persistence(); report['completedStages'].append('5-4-persistence')
                if args.stop_after == '5-5':
                    a.regression()
            except Exception:
                report['failureDom'] = d.js("return {focus:document.activeElement?.outerHTML,status:[...document.querySelectorAll('[data-testid$=status]')].map(e=>({...e.dataset})),notice:document.querySelector('footer.statusbar')?.textContent,events:window.__phase5Events?.slice(-30)}")
                d.screenshot(root / 'failure.png')
                if 'a' in locals():
                    a.native_screenshot('failure')
                report['nativeWindows'] = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', '.*'], capture_output=True, text=True).stdout.split()
                for index, capture in enumerate(d.js('return window.__phase5Exports||[]')):
                    (root / ('captured-' + str(index) + '.hwp')).write_bytes(bytes(capture['bytes']))
                    (root / ('captured-' + str(index) + '.loss.json')).write_text(capture['loss'])
                raise
            finally:
                smoke.end_session(d)
            # New process and fresh engine objects, not an in-memory reload.
            d = start() if args.stop_after == '5-5' else None
            try:
                if d is None:
                    report['status'] = 'PASS'
                    return 0
                smoke.wait_until(d, "return !!document.querySelector('.document-bar')", timeout=60)
                restarted = base.Acceptance(args, d, report)
                for fmt in ('docx', 'hwpx', 'hwp'):
                    restarted.fmt = fmt
                    path = root / 'documents' / ('saved-as.' + fmt)
                    before = sha(path)
                    restarted.open_native(fmt, path)
                    restarted.key('ctrl+Home')
                    restarted.wait("return document.querySelector(arguments[0])?.dataset.paragraphText.includes('Isolation')", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-status]')
                    independent = structure(path)
                    restarted.record('application restart / native reopen / durable rich content', sha(path) == before and 'Isolation' in independent['text'] and independent['tables'] >= 1 and independent['images'] >= 1 and independent['bullets'] >= 1, {'sha256': before, 'structure': independent, 'status': restarted.status(fmt)})
                    restarted.snap('after-process-restart')
                    restarted.close(path.name)
                restarted.record('all test document handles closed', not restarted.sessions())
                report['completedStages'].append('5-5-regression')
            finally:
                if d is not None:
                    smoke.end_session(d)
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='BLOCKED' if isinstance(error, base.EnvironmentBlocked) else 'FAIL', error=str(error), traceback=traceback.format_exc()); traceback.print_exc()
    finally:
        report['teardown'] = smoke.TEARDOWN
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        for stage in ('5-3-editing', '5-4-persistence', '5-5-regression'):
            rows = [c for c in report['checks'] if c['stage'] == stage]
            status = 'PASS' if stage in report.get('completedStages', []) else 'FAIL' if rows else 'NOT RUN'
            folder = root / stage; folder.mkdir(exist_ok=True)
            (folder / 'result.json').write_text(json.dumps({'status': status, 'checks': rows}, ensure_ascii=False, indent=2) + '\n')
    return 0 if report['status'] == 'PASS' else 2 if report['status'] == 'BLOCKED' else 1


if __name__ == '__main__':
    sys.exit(main())
