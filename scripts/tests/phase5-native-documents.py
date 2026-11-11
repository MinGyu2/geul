#!/usr/bin/env python3
"""Stages 5-3 → 5-4 → 5-5, real native UI and independent disk oracles.

Requires a successful phase5-native-acceptance.py IBus result. No document
mutation is performed by JavaScript or direct model/IPC commands.
"""
import argparse
import importlib.util
import json
import os
import time
import posixpath
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
evidence = base.evidence


def structure(path):
    if path.suffix == '.docx':
        with zipfile.ZipFile(path) as z:
            assert z.testzip() is None
            tree = ET.fromstring(z.read('word/document.xml'))
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            rels = ET.fromstring(z.read('word/_rels/document.xml.rels'))
            targets = {e.get('Id'): e for e in rels}
            refs = tree.findall('.//{http://schemas.openxmlformats.org/drawingml/2006/main}blip')
            hashes = []
            for ref in refs:
                rel = targets[ref.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed')]
                assert rel.get('TargetMode') != 'External' and rel.get('Type').endswith('/image')
                target = posixpath.normpath('word/' + rel.get('Target'))
                assert target.startswith('word/media/')
                hashes.append(sha_bytes(z.read(target)))
            return {'imageHashes': hashes, 'format': 'docx', 'text': ''.join(e.text or '' for e in tree.findall('.//w:t', ns)),
                    'paragraphs': len(tree.findall('.//w:p', ns)), 'tables': len(tree.findall('.//w:tbl', ns)),
                    'images': len(tree.findall('.//w:drawing', ns)), 'bullets': len(tree.findall('.//w:numPr', ns)),
                    'media': {n: sha_bytes(z.read(n)) for n in z.namelist() if n.startswith('word/media/')}}
    code = """
import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';import {pathToFileURL} from 'node:url';
const [root,file]=process.argv.slice(2),build=JSON.parse(readFileSync(root+'/public/rhwp/RELEASE.json')),
folder=root+'/public/rhwp/generations/'+build.generation,m=await import(pathToFileURL(folder+'/rhwp.js'));
m.initSync({module:readFileSync(folder+'/rhwp_bg.wasm')});
const d=new m.HwpDocument(readFileSync(file));try{const c=JSON.parse(d.getControls());
console.log(JSON.stringify({format:d.getSourceFormat(),text:d.getTextFileText(),paragraphs:d.getParagraphCount(0),pages:d.pageCount(),
imageHashes:c.filter(x=>x.userDesc==='그림').map(x=>createHash('sha256').update(d.getControlImageData(x.list,x.para,'[]',x.controlIndex)).digest('hex')),
tables:c.filter(x=>x.ctrlId==='tbl').length,images:c.filter(x=>x.userDesc==='그림').length,
bullets:Array.from({length:d.getParagraphCount(0)},(_,p)=>JSON.parse(d.getParaPropertiesAt(0,p))).filter(x=>x.headType==='Bullet').length,controls:c}));}finally{d.free()}
"""
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-', str(ROOT), str(path)], input=code, text=True))


def sha_bytes(data):
    import hashlib
    return hashlib.sha256(data).hexdigest()


def inspect_artifact(path, fmt, role, source, first_text):
    model = structure(path)
    assert model['format'] == fmt
    if role == 'existing':
        spec = importlib.util.spec_from_file_location('roundtrip', ROOT / 'scripts/tests/native-save-roundtrip.py')
        oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(oracle)
        model['originalPreservation'] = oracle.docx_structure(source, path) if fmt == 'docx' else oracle.rhwp_structure(source, path, first_text)
    else:
        assert sha(source) in model['imageHashes'], 'inserted image bytes/reference changed'
    return model


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

    def freeze(self, artifact, role, path):
        fmt = artifact['format']
        relative = 'verified/' + fmt + '/' + role + '.' + fmt
        target = self.root / relative; target.parent.mkdir(exist_ok=True, parents=True)
        shutil.copyfile(path, target)
        assert sha(target) == sha(path)
        source = Path(artifact['source']) if role == 'existing' else self.sources / 'blue.png'
        model = inspect_artifact(target, fmt, role, source, artifact.get('firstText'))
        value = {'path': relative, 'format': fmt, 'role': role, 'runId': self.report['runId'],
                 'identity': self.report['identity'], 'sha256': sha(target),
                 'sourcePath': str(source.relative_to(self.root)), 'sourceSha256': sha(source),
                 'firstText': artifact.get('firstText'), 'structureVerified': True,
                 'structure': model, 'structureSha256': evidence.canonical(model),
                 'scenarios': evidence.artifact_scenarios(fmt, role)}
        for check in self.report['checks']:
            if check['id'] in value['scenarios']:
                check['artifactSha256'] = value['sha256']
        self.report['artifacts'][fmt+'/'+role] = value
        self.flush()

    def persistence(self):
        self.stage('5-4-persistence')
        for artifact in self.artifacts:
            self.fmt = artifact['format']; self.role = artifact['kind']; path = Path(artifact['path'])
            self.select(path.name)
            result = self.save(self.fmt)
            model = structure(path)
            artifact.update(savedSha256=sha(path), structure=model, save=result)
            self.record('actual GUI save / durable output / independent engine or XML reopen', result['state'] == 'saved' and result.get('synced') == 'true' and '한글' in model['text'], artifact)
            if artifact['kind'] == 'rich':
                self.record('independent text / paragraph / table / image / list preservation', sha(self.sources / 'blue.png') in model['imageHashes'] and model['tables'] >= 1 and model['images'] >= 1 and model['bullets'] >= 1 and 'Cell2' in model['text'] and 'List 한글' in model['text'], model)
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
                self.freeze(artifact, 'saved-as', destination)
            self.freeze(artifact, artifact['kind'], path)
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
    args.out = args.out.resolve(); args.out.relative_to(ROOT / 'target'); args.out.mkdir(exist_ok=False, parents=True)
    root = args.out
    args.xdotool = 'xdotool'; args.ibus = 'ibus'; args.stage = '5-3-editing'
    smoke.APP = str(ROOT / 'src-tauri/target/debug/geul'); smoke.DRIVER_LOG = root / 'driver.log'
    report = evidence.new_report(root, 'documents')
    report['environment'] = {k: os.environ.get(k) for k in ['DISPLAY','GTK_IM_MODULE','XMODIFIERS','IBUS_ADDRESS']}
    evidence_base = ROOT / 'target/phase5-native-gui-ibus'
    report['ibusEvidence'] = {'path': str(args.ibus_result.resolve().relative_to(evidence_base)), 'sha256': sha(args.ibus_result)}
    try:
        with smoke.tauri_driver(args.driver, args.port, str(root / 'data')) as start:
            d = start()
            try:
                smoke.wait_until(d, "return !!document.querySelector('.document-bar')", timeout=60)
                a = Documents(args, d, report)
                evidence.validate_ibus(args.ibus_result.parent, report['identity'])
                first_pid = int(a.command('xdotool','getwindowpid',a.window))
                report['restart'] = {'before': evidence.process_identity(first_pid)}
                if args.resume_persistence_from:
                    previous = args.resume_persistence_from.resolve()
                    relative = str((previous / 'result.json').relative_to(evidence_base))
                    previous_file = evidence.safe_file(evidence_base, relative)
                    previous_report = evidence.authorize_resume(previous, report['identity'], inspect_artifact, evidence_base)
                    source_sha = sha(previous_file)
                    report['reuse'] = {'path': relative, 'sha256': source_sha, 'runId': previous_report['runId']}
                    for check in previous_report['checks']:
                        if check['id'] in evidence.positive_ids():
                            row = dict(check, evidenceMode='REUSED_VERIFIED', sourceReportSha256=source_sha)
                            report['checks'].append(row)
                    for key, artifact in previous_report['artifacts'].items():
                        source = evidence.safe_file(previous, artifact['path'])
                        target = root / 'reuse-copies' / (key.replace('/','-')+'.'+artifact['format'])
                        target.parent.mkdir(exist_ok=True); shutil.copyfile(source, target)
                        assert sha(target) == artifact['sha256']
                        if artifact['role'] in ('saved-as','existing'):
                            working = a.documents / (artifact['role']+'.'+artifact['format'])
                            shutil.copyfile(target, working)
                            a.fmt = artifact['format']; a.open_native(a.fmt, working)
                    for name in ('blue.png', *(('basic-ko.'+f) for f in evidence.FORMATS)):
                        shutil.copyfile(evidence.safe_file(previous, 'sources/'+name), a.sources / name)
                    a.originals = {}  # immutable originals authenticated by source contract
                else:
                    a.editing()
                if args.stop_after != '5-3':
                    a.persistence()
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
            deadline = time.monotonic() + 15
            while evidence.same_process_alive(report['restart']['before']) and time.monotonic() < deadline:
                time.sleep(.1)
            report['restart']['oldProcessGone'] = not evidence.same_process_alive(report['restart']['before'])
            evidence.require(report['restart']['oldProcessGone'], 'old application process still alive')
            d = start() if args.stop_after == '5-5' else None
            try:
                if d is None:
                    report['status'] = 'PARTIAL'
                    return 0
                smoke.wait_until(d, "return !!document.querySelector('.document-bar')", timeout=60)
                restarted = base.Acceptance(args, d, report)
                report['restart']['after'] = evidence.process_identity(int(restarted.command('xdotool','getwindowpid',restarted.window)))
                evidence.validate_restart(report['restart'], report['identity'])
                restarted.record('application process restart proven', True, report['restart'])
                for fmt in ('docx', 'hwpx', 'hwp'):
                    restarted.fmt = fmt
                    path = root / 'documents' / ('saved-as.' + fmt)
                    before = sha(path)
                    restarted.open_native(fmt, path)
                    restarted.key('ctrl+Home')
                    restarted.wait("return document.querySelector(arguments[0])?.dataset.paragraphText.includes('Isolation')", '[data-testid=' + ('docx' if fmt == 'docx' else 'rhwp') + '-status]')
                    independent = structure(path)
                    restarted.record('application restart / native reopen / durable rich content', sha(path) == before and 'Isolation' in independent['text'] and independent['tables'] >= 1 and independent['images'] >= 1 and independent['bullets'] >= 1 and sha(root / 'sources/blue.png') in independent['imageHashes'], {'sha256': before, 'structure': independent, 'status': restarted.status(fmt)})
                    restarted.snap('after-process-restart')
                    restarted.close(path.name)
                restarted.record('all test document handles closed', not restarted.sessions())

            finally:
                if d is not None:
                    smoke.end_session(d)
        report['teardown'] = smoke.TEARDOWN
        report['stageResults'] = evidence.stage_results(report['checks'], ('5-3','5-4','5-5'))
        evidence.bind_files(report, root)
        report['acceptance'] = evidence.finalize_documents(report, root, report['identity'], inspect_artifact, evidence_base)
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='BLOCKED' if isinstance(error, base.EnvironmentBlocked) else 'FAIL', error=str(error), traceback=traceback.format_exc()); traceback.print_exc()
    finally:
        report['teardown'] = smoke.TEARDOWN
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        report['stageResults'] = evidence.stage_results(report['checks'], ('5-3','5-4','5-5'))
        evidence.bind_files(report, root)
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        for stage, state in report['stageResults'].items():
            state = dict(state, runId=report['runId'], checks=[c for c in report['checks'] if c['stage']==stage])
            folder = root / {'5-3':'5-3-editing','5-4':'5-4-persistence','5-5':'5-5-regression'}[stage]; folder.mkdir(exist_ok=True)
            (folder / 'result.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    return 0 if report['status'] == 'PASS' else 2 if report['status'] == 'BLOCKED' else 1


if __name__ == '__main__':
    sys.exit(main())
