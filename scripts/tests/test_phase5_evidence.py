"""Contract tests for the local Phase 5 evidence validator.

The tiny JSON document artifacts and fake inspector exercise report/path/hash
contracts only; they are not engine validation. Local SHA-256 binding detects
accidental or partial changes, not a coordinated forgery or an external signature.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

SCRIPT = Path(__file__).with_name('phase5_evidence.py')
spec = importlib.util.spec_from_file_location('phase5_evidence', SCRIPT)
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

IDENTITY = {
    'appSha256': '1' * 64,
    'productTreeSha256': '2' * 64,
    'rhwpGeneration': 'generation-test',
    'rhwpArtifacts': {'rhwp.js': '3' * 64, 'rhwp_bg.wasm': '4' * 64},
    'rhwpSourceTree': '5' * 64,
    'wordcraftCommit': '6' * 40,
    'inputHarnessSha256': '7' * 64,
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))


def controlled_png() -> bytes:
    return (b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 12, 8, 8, 2, 0, 0, 0))
            + png_chunk(b'IDAT', zlib.compress((b'\0' + b'\x20\x60\xd0' * 12) * 8))
            + png_chunk(b'IEND', b''))


def make_row(sid: str, run_id: str, result: str = 'PASS') -> dict:
    stage, fmt, role, short = sid.split('.')
    for name, (registered_stage, registered_short, fixed_role) in ev.ACTIONS.items():
        if registered_stage != stage or registered_short != short:
            continue
        candidate = fixed_role if fixed_role is not None else role
        generated = ev.row(name, fmt, candidate, run_id, result == 'PASS', {'fixture': True})
        if generated['id'] == sid:
            generated['result'] = result
            return generated
    raise AssertionError(f'no registered action for {sid}')


def make_checks(stages: tuple[str, ...], run_id: str, omit: set[str] | None = None) -> list[dict]:
    omit = omit or set()
    required = set().union(*(ev.requirements(stage) for stage in stages))
    return [make_row(sid, run_id) for sid in sorted(required - omit)]


def make_trace() -> list[dict]:
    events = []
    for fmt in ev.FORMATS:
        for kind, data in [('compositionstart', ''), ('compositionupdate', 'ㅎ'), ('compositionend', '하')]:
            events.append({'format': fmt, 'type': kind, 'data': data, 'trusted': True})
    return events


def inspector(path: Path, fmt: str, role: str, source: Path, first_text: str | None) -> dict:
    """Test double reads structure encoded in the fake artifact, not an engine."""
    return json.loads(path.read_text())


class EvidenceFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='phase5-evidence-')
        self.base = Path(self.temp.name)
        self.app = self.base / 'fake-app'
        self.app.write_bytes(b'local synthetic app identity')
        self.identity = {**IDENTITY, 'appSha256': sha(self.app)}
        self.evidence = self.base / 'evidence'
        self.evidence.mkdir()
        self.input_root = self.evidence / 'input-fixture'
        self.docs_root = self.evidence / 'documents-fixture'
        self.input_report = self._write_input(self.input_root)
        self.docs_report = self._write_documents(self.docs_root)
        self.pristine_docs = self.base / 'pristine-documents'
        shutil.copytree(self.docs_root, self.pristine_docs)

    def tearDown(self):
        self.temp.cleanup()

    def _write_input(self, root: Path) -> dict:
        root.mkdir(parents=True)
        report = ev.new_report(root, 'input')
        report.update(identity=self.identity, status='PASS')
        report['checks'] = make_checks(('5-1', '5-2'), ev.run_id(root))
        report['stageResults'] = ev.stage_results(report['checks'], ('5-1', '5-2'))
        report['environment'] = {'GTK_IM_MODULE': 'ibus','IBUS_ADDRESS':'unix:test-owned','DISPLAY':':test'}
        report['launchProcess']={'exeSha256':self.identity['appSha256']}
        for fmt in ev.FORMATS:(root/('ime.'+fmt)).write_bytes(('saved ownership '+fmt).encode())
        report['engineSwitches'] = [
            {'format': fmt, 'requested': name, 'observed': name}
            for fmt in ev.FORMATS for name in ('hangul', 'xkb:us::eng')
        ]
        report['teardown'] = [{'complete': True, 'survivorsAfterSigterm': []}]
        (root / 'native-session.json').write_text(json.dumps({
            'globalEngine': 'hangul', 'setGlobalEngine': {'exit': 0}, 'ibusAddress':'unix:test-owned','display':':test',
            'engineProcesses': ['/nix/store/ibus-engine-hangul --ibus'],
        }))
        (root / 'trusted-input-trace.json').write_text(json.dumps(make_trace(), ensure_ascii=False))
        ev.bind_files(report, root)
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False))
        return report

    def _structure(self, fmt: str, role: str, image_hash: str) -> dict:
        if role in ('rich', 'saved-as'):
            return {
                'format': fmt,
                'text': 'english edit 한글\nList 한글\nCell2',
                'paragraphs': 3,
                'tables': 1,
                'images': 1,
                'bullets': 1,
                'imageHashes': [image_hash],
            }
        return {
            'format': fmt,
            'text': '기존 문서 한글 Existing 한글',
            'paragraphs': 2,
            'tables': 0,
            'images': 0,
            'bullets': 0,
            'imageHashes': [],
        }

    def _write_documents(self, root: Path, *, partial: bool = False) -> dict:
        root.mkdir(parents=True)
        (root / 'sources').mkdir()
        (root / 'verified').mkdir()
        (root / 'trace.log').write_text('synthetic evidence fixture\n')
        image = controlled_png()
        self.assertEqual(hashlib.sha256(image).hexdigest(), ev.CONTROLLED_IMAGE_SHA256)
        (root / 'sources/blue.png').write_bytes(image)
        for fmt in ev.FORMATS:
            (root / f'sources/basic-ko.{fmt}').write_bytes(f'fixture:{fmt}:basic-ko'.encode())
        report = ev.new_report(root, 'documents')
        report.update(identity=self.identity, status='FAIL' if partial else 'PASS')
        omitted = set()
        if partial:
            omitted = {sid for sid in ev.requirements('5-4')
                       if sid.endswith('.sources') or sid.endswith('.unsafe') or sid.endswith('.discard')}
            omitted |= ev.requirements('5-5')
        report['checks'] = make_checks(('5-3', '5-4', '5-5'), ev.run_id(root), omitted)
        report['stageResults'] = ev.stage_results(report['checks'], ('5-3', '5-4', '5-5'))
        report['ibusEvidence'] = {
            'path': f'{self.input_root.name}/result.json',
            'sha256': sha(self.input_root / 'result.json'),
        }
        report['teardown'] = [{'complete': True, 'survivorsAfterSigterm': []}]
        report['restart'] = {
            'before': {'pid': 1001, 'startTicks': 2000, 'bootId': 'boot-test', 'exeSha256': self.identity['appSha256']},
            'after': {'pid': 1002, 'startTicks': 3000, 'bootId': 'boot-test', 'exeSha256': self.identity['appSha256']},
            'oldProcessGone': True,
        }
        report['artifacts'] = {}
        for fmt in ev.FORMATS:
            for role in ('rich', 'existing', 'saved-as'):
                structure = self._structure(fmt, role, sha(root / 'sources/blue.png'))
                rel = f'verified/{fmt}/{role}.{fmt}'
                target = root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(structure, ensure_ascii=False))
                document_hash = sha(target)
                scenarios = ev.artifact_scenarios(fmt, role)
                for scenario in scenarios:
                    check = next(c for c in report['checks'] if c['id'] == scenario)
                    check['artifactSha256'] = document_hash
                source_rel = 'sources/basic-ko.' + fmt if role == 'existing' else 'sources/blue.png'
                report['artifacts'][fmt + '/' + role] = {
                    'format': fmt, 'role': role, 'runId': ev.run_id(root), 'identity': self.identity,
                    'path': rel, 'scenarios': scenarios, 'sha256': document_hash,
                    'sourcePath': source_rel, 'sourceSha256': sha(root / source_rel),
                    'structureVerified': True, 'structure': structure,
                    'structureSha256': ev.canonical(structure),
                    'firstText': '기존 문서' if role == 'existing' else None,
                }
        ev.bind_files(report, root)
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False))
        return report

    def rebind_input(self):
        self.input_report['stageResults'] = ev.stage_results(self.input_report['checks'], ('5-1', '5-2'))
        ev.bind_files(self.input_report, self.input_root)
        (self.input_root / 'result.json').write_text(json.dumps(self.input_report, ensure_ascii=False))
        self.docs_report['ibusEvidence']['sha256'] = sha(self.input_root / 'result.json')

    def rebind_documents(self):
        self.docs_report['stageResults'] = ev.stage_results(self.docs_report['checks'], ('5-3', '5-4', '5-5'))
        ev.bind_files(self.docs_report, self.docs_root)
        (self.docs_root / 'result.json').write_text(json.dumps(self.docs_report, ensure_ascii=False))

    def assert_finalize_rejects(self, why: str, *, recalculate: bool = True):
        if recalculate:
            self.docs_report['stageResults'] = ev.stage_results(self.docs_report['checks'], ('5-3', '5-4', '5-5'))
        ev.bind_files(self.docs_report, self.docs_root)
        (self.docs_root / 'result.json').write_text(json.dumps(self.docs_report, ensure_ascii=False))
        with self.assertRaisesRegex(ValueError, '.'):
            ev.finalize_documents(self.docs_report, self.docs_root, self.identity, inspector, self.evidence)

    def finalize(self):
        return ev.finalize_documents(self.docs_report, self.docs_root, self.identity, inspector, self.evidence)

    def restore_documents(self):
        shutil.rmtree(self.docs_root)
        shutil.copytree(self.pristine_docs, self.docs_root)
        self.docs_report = json.loads((self.docs_root / 'result.json').read_text())

    def test_fresh_finalize_pass_exact_registry_counts_and_artifact_bindings(self):
        result = self.finalize()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['runId'], ev.run_id(self.docs_root))
        self.assertEqual(set(result['formats']), set(ev.FORMATS))
        for stage in ('5-1', '5-2'):
            self.assertEqual(self.input_report['stageResults'][stage]['requiredCount'], len(ev.requirements(stage)))
            self.assertEqual(self.input_report['stageResults'][stage]['currentCount'], len(ev.requirements(stage)))
        for stage in ('5-3', '5-4', '5-5'):
            state = result['stages'][stage]
            self.assertEqual(state['requiredCount'], len(ev.requirements(stage)))
            self.assertEqual(state['currentCount'] + state['reusedCount'], state['requiredCount'])
            self.assertEqual(state['effectiveAcceptance'], 'PASS')
        self.assertEqual(set(self.docs_report['artifacts']),
                         {f'{f}/{r}' for f in ev.FORMATS for r in ('rich', 'existing', 'saved-as')})

    def test_authenticated_partial_resume_pass_and_exact_reuse_counts(self):
        source_root = self.evidence / 'partial-source'
        source = self._write_documents(source_root, partial=True)
        source_required = set().union(*(ev.requirements(s) for s in ('5-3', '5-4', '5-5')))
        self.assertEqual(source['status'], 'FAIL')
        self.assertEqual(source['stageResults']['5-4']['effectiveAcceptance'], 'NOT_RUN')
        self.assertEqual(source['stageResults']['5-4']['missing'], sorted(
            sid for sid in ev.requirements('5-4')
            if sid.endswith('.sources') or sid.endswith('.unsafe') or sid.endswith('.discard')))
        self.assertTrue(ev.authorize_resume(source_root, self.identity, inspector)['artifacts'])

        resumed_root = self.evidence / 'resumed-run'
        resumed_root.mkdir()
        (resumed_root / 'trace.log').write_text('resumed current execution\n')
        (resumed_root / 'reuse-copies').mkdir()
        source_result_sha = sha(source_root / 'result.json')
        rows_by_id = {c['id']: c for c in source['checks']}
        all_required = source_required
        checks = []
        reused_ids = ev.positive_ids()
        self.assertTrue(reused_ids <= rows_by_id.keys())
        for sid in sorted(reused_ids):
            c = dict(rows_by_id[sid])
            c['evidenceMode'] = 'REUSED_VERIFIED'
            c['sourceReportSha256'] = source_result_sha
            checks.append(c)
        for sid in sorted(all_required - reused_ids):
            checks.append(make_row(sid, ev.run_id(resumed_root)))
        for key, artifact in source['artifacts'].items():
            filename = key.replace('/', '-') + '.' + artifact['format']
            shutil.copyfile(source_root / artifact['path'], resumed_root / 'reuse-copies' / filename)
        resumed = ev.new_report(resumed_root, 'documents')
        resumed.update(identity=self.identity, status='PASS', checks=checks,
                       ibusEvidence={'path': f'{self.input_root.name}/result.json',
                                     'sha256': sha(self.input_root / 'result.json')},
                       reuse={'path': f'{source_root.name}/result.json', 'sha256': source_result_sha,
                              'runId': ev.run_id(source_root)},
                       artifacts={},
                       restart=self.docs_report['restart'],
                       teardown=[{'complete': True, 'survivorsAfterSigterm': []}])
        resumed['stageResults'] = ev.stage_results(checks, ('5-3', '5-4', '5-5'))
        ev.bind_files(resumed, resumed_root)
        (resumed_root / 'result.json').write_text(json.dumps(resumed, ensure_ascii=False))
        final = ev.finalize_documents(resumed, resumed_root, self.identity, inspector, self.evidence)
        self.assertEqual(final['status'], 'PASS')
        self.assertEqual(final['sourceRunIds'], [ev.run_id(source_root)])
        for stage in ('5-3', '5-4', '5-5'):
            counts = final['stages'][stage]
            self.assertEqual(counts['requiredCount'], len(ev.requirements(stage)))
            self.assertEqual(counts['reusedCount'] + counts['currentCount'], counts['requiredCount'])
            self.assertEqual(counts['effectiveAcceptance'], 'PASS')
        self.assertEqual(final['stages']['5-4']['reusedCount'],
                         len(ev.requirements('5-4')) - len(source['stageResults']['5-4']['missing']))

    def test_partial_resume_rejects_an_altered_reuse_copy(self):
        # Exercise the deep copy binding through the public finalizer in a fresh
        # fixture rather than calling another unittest method for its assertions.
        source_root = self.evidence / 'partial-source'
        source = self._write_documents(source_root, partial=True)
        resumed_root = self._make_resumed(source_root, source)
        copy = next((resumed_root / 'reuse-copies').iterdir())
        copy.write_bytes(copy.read_bytes() + b'altered')
        resumed = json.loads((resumed_root / 'result.json').read_text())
        ev.bind_files(resumed, resumed_root)
        (resumed_root / 'result.json').write_text(json.dumps(resumed, ensure_ascii=False))
        with self.assertRaisesRegex(ValueError, 'reused copied artifact mismatch'):
            ev.finalize_documents(resumed, resumed_root, self.identity, inspector, self.evidence)

    def _make_resumed(self, source_root: Path, source: dict) -> Path:
        root = self.evidence / 'resumed-copy-check'
        root.mkdir(); (root / 'trace.log').write_text('resume\n'); (root / 'reuse-copies').mkdir()
        source_sha = sha(source_root / 'result.json'); rows = {c['id']: c for c in source['checks']}
        required = set().union(*(ev.requirements(s) for s in ('5-3','5-4','5-5')))
        checks=[]
        for sid in sorted(ev.positive_ids()):
            c=dict(rows[sid]); c['evidenceMode']='REUSED_VERIFIED'; c['sourceReportSha256']=source_sha; checks.append(c)
        checks.extend(make_row(sid,ev.run_id(root)) for sid in sorted(required-ev.positive_ids()))
        for key,a in source['artifacts'].items():
            shutil.copyfile(source_root/a['path'],root/'reuse-copies'/(key.replace('/','-')+'.'+a['format']))
        resumed=ev.new_report(root,'documents')
        resumed.update(identity=self.identity,status='PASS',checks=checks,
            ibusEvidence={'path':f'{self.input_root.name}/result.json','sha256':sha(self.input_root/'result.json')},
            reuse={'path':f'{source_root.name}/result.json','sha256':source_sha,'runId':ev.run_id(source_root)},
            artifacts={},restart=self.docs_report['restart'],teardown=[{'complete':True,'survivorsAfterSigterm':[]}])
        resumed['stageResults']=ev.stage_results(checks,('5-3','5-4','5-5'))
        ev.bind_files(resumed,root);(root/'result.json').write_text(json.dumps(resumed,ensure_ascii=False))
        return root

    def test_input_missing_format_or_composition_is_rejected(self):
        for fmt in ev.FORMATS:
            with self.subTest(fmt=fmt):
                self.input_report['checks']=[c for c in self.input_report['checks']
                    if not (c['format']==fmt and c['actions']=='IBus multi-syllable continuous input and commit')]
                self.rebind_input()
                with self.assertRaises(ValueError): ev.validate_ibus(self.input_root,self.identity)
                # Restore a valid report for the next parameterized case.
                self.input_report = self._write_input(self._replace_input_root())
                self.docs_report['ibusEvidence']['sha256']=sha(self.input_root/'result.json')

    def _replace_input_root(self) -> Path:
        shutil.rmtree(self.input_root)
        root=self.evidence/'input-fixture'; self.input_root=root
        # Keep root name == declared runId and update the doc link to its report.
        return root

    def test_missing_trusted_lifecycle_engine_switch_focus_or_ownership_is_rejected(self):
        mutations = [
            ('untrusted composition', lambda: self._untrust_composition()),
            ('missing composition trace', lambda: self._drop_composition()),
            ('missing engine switch', lambda: self.input_report['engineSwitches'].pop()),
            ('missing focus scenario', lambda: self._drop_input_action('external X11 window focus roundtrip')),
            ('missing ownership scenario', lambda: self._drop_input_action('tab switch during preedit does not modify recipient document')),
            ('IBus engine not active', lambda: self._set_native_engine('latin')),
        ]
        for label, mutate in mutations:
            with self.subTest(label=label):
                # Reset all evidence first; then mutate just this contract.
                self.input_root = self.evidence / 'input-fixture'
                self.input_report = self._write_input_clean()
                self.docs_report = json.loads((self.docs_root/'result.json').read_text())
                mutate(); self.rebind_input()
                with self.assertRaises(ValueError): self.finalize()

    def _write_input_clean(self):
        shutil.rmtree(self.input_root)
        return self._write_input(self.input_root)

    def _untrust_composition(self):
        trace_path=self.input_root/'trusted-input-trace.json'; events=json.loads(trace_path.read_text())
        events[0]['trusted']=False; trace_path.write_text(json.dumps(events))

    def _drop_composition(self):
        trace_path=self.input_root/'trusted-input-trace.json'; events=json.loads(trace_path.read_text())
        events=[e for e in events if not (e['format']=='docx' and e['type']=='compositionupdate')]
        trace_path.write_text(json.dumps(events))

    def _drop_input_action(self, action):
        self.input_report['checks']=[c for c in self.input_report['checks'] if c['actions']!=action]

    def _set_native_engine(self, name):
        path=self.input_root/'native-session.json'; session=json.loads(path.read_text());session['globalEngine']=name;path.write_text(json.dumps(session))

    def test_input_session_requires_complete_teardown_and_hangul_activation(self):
        self.input_report['teardown'][0]['survivorsAfterSigterm']=[9001]
        self.rebind_input()
        with self.assertRaisesRegex(ValueError, 'input teardown'):
            ev.validate_ibus(self.input_root,self.identity)

    def test_restart_requires_new_pid_and_start_after_verified_old_exit(self):
        self.docs_report['restart']['after']=dict(self.docs_report['restart']['before'])
        self.assert_finalize_rejects('restart reuse')

    def test_identity_and_structural_oracles_fail_closed(self):
        tests = [
            ('wrong current app/source identity', lambda: self.docs_report.update(identity={**self.identity,'appSha256':'9'*64})),
            ('artifact identity mismatch', lambda: self.docs_report['artifacts']['docx/rich'].update(identity={**self.identity,'rhwpGeneration':'old'})),
            ('missing independent structure', lambda: self.docs_report['artifacts']['docx/rich'].update(structureVerified=False)),
            ('structure digest mismatch', lambda: self.docs_report['artifacts']['docx/rich'].update(structureSha256='0'*64)),
            ('inspector content/media mismatch', lambda: self._alter_fake_artifact_structure('hwpx','rich','imageHashes',['0'*64])),
        ]
        for label, mutate in tests:
            with self.subTest(label=label):
                self.restore_documents();mutate();self.assert_finalize_rejects(label)

    def _alter_fake_artifact_structure(self, fmt, role, key, value):
        artifact=self.docs_report['artifacts'][fmt+'/'+role]
        artifact['structure'][key]=value
        artifact['structureSha256']=ev.canonical(artifact['structure'])

    def test_artifact_formats_bytes_paths_sources_and_symlinks_fail_closed(self):
        cases = [
            ('DOCX bytes changed', 'docx','rich','bytes'),
            ('HWPX bytes changed', 'hwpx','rich','bytes'),
            ('HWP bytes changed', 'hwp','rich','bytes'),
            ('document deleted', 'docx','rich','delete'),
            ('wrong reported hash', 'docx','rich','reported-hash'),
            ('missing reported hash', 'hwp','existing','missing-hash'),
            ('wrong format', 'docx','rich','format'),
            ('wrong source bytes', 'docx','existing','source'),
            ('incorrect path alias', 'docx','rich','alias'),
            ('path traversal', 'docx','rich','traversal'),
            ('symlink artifact path', 'docx','rich','symlink'),
        ]
        for label, fmt, role, mutation in cases:
            with self.subTest(label=label):
                self.restore_documents()
                artifact=self.docs_report['artifacts'][fmt+'/'+role]
                file=self.docs_root/artifact['path']
                if mutation=='bytes': file.write_bytes(file.read_bytes()+b'changed')
                elif mutation=='delete': file.unlink()
                elif mutation=='reported-hash': artifact['sha256']='0'*64
                elif mutation=='missing-hash': artifact.pop('sha256')
                elif mutation=='format': artifact['format']='hwpx' if fmt!='hwpx' else 'docx'
                elif mutation=='source': (self.docs_root/'sources'/f'basic-ko.{fmt}').write_bytes(b'changed original')
                elif mutation=='alias': artifact['path']=artifact['path'].replace('rich.','./rich.')
                elif mutation=='traversal': artifact['path']='../../escape.docx'
                elif mutation=='symlink':
                    file=self.docs_root/'verified'/fmt/(role+'.'+fmt)
                    target=self.docs_root/'verified'/fmt/'link-target'
                    target.write_bytes(file.read_bytes());file.unlink();file.symlink_to(target.name)
                    artifact['path']=f'verified/{fmt}/{role}.{fmt}'
                self.assert_finalize_rejects(label)

    def test_schema_stage_rows_duplicates_failures_and_action_substitution(self):
        mutations = [
            ('missing schema', lambda: self.docs_report.pop('schema'), False),
            ('malformed declared schema', lambda: self.docs_report.update(schema='geul.phase5.v1'), False),
            ('missing required stage', lambda: self._remove_check('5-3'), True),
            ('duplicate scenario ID', lambda: self.docs_report['checks'].append(dict(self.docs_report['checks'][0])), False),
            ('failed mandatory row', lambda: self._fail_one_check(), True),
            ('unrelated action substitution', lambda: self.docs_report['checks'][0].update(actions='invalid open reports failure without replacing ready documents'), False),
            ('contradictory stage result', lambda: self.docs_report['stageResults']['5-3'].update(effectiveAcceptance='FAIL'), False),
            ('wrong scenario format', lambda: self.docs_report['checks'][0].update(format='all'), False),
        ]
        for label, mutate, recalculate in mutations:
            with self.subTest(label=label):
                self.restore_documents();mutate()
                self.assert_finalize_rejects(label, recalculate=recalculate)

    def _remove_check(self, stage):
        self.docs_report['checks'].pop(next(i for i,c in enumerate(self.docs_report['checks']) if c['stage']==stage))

    def _fail_one_check(self):
        next(c for c in self.docs_report['checks'] if c['stage']=='5-3')['result']='FAIL'

    def test_manifest_and_run_identity_fail_closed(self):
        self.docs_report['evidenceFiles']['trace.log']='0'*64
        with self.assertRaisesRegex(ValueError,'evidence file hash mismatch'):
            self.finalize()
        self.docs_report=json.loads((self.docs_root/'result.json').read_text())
        self.docs_report['runId']='some-other-run'
        with self.assertRaises(ValueError): self.finalize()

    def test_resume_rejects_missing_or_forged_source_provenance(self):
        source_root=self.evidence/'partial-source';source=self._write_documents(source_root,partial=True)
        with self.assertRaisesRegex(ValueError,'missing/failed required positive scenario'):
            source['checks']=[c for c in source['checks'] if c['id'] not in ev.positive_ids()]
            source['stageResults']=ev.stage_results(source['checks'],('5-3','5-4','5-5'))
            ev.bind_files(source,source_root);(source_root/'result.json').write_text(json.dumps(source))
            ev.authorize_resume(source_root,self.identity,inspector)

        # The resume finalizer binds each reused row to the exact source report SHA.
        source_root2=self.evidence/'partial-source-two';source2=self._write_documents(source_root2,partial=True)
        resumed=self._make_resumed(source_root2,source2)
        report=json.loads((resumed/'result.json').read_text())
        next(c for c in report['checks'] if c['evidenceMode']=='REUSED_VERIFIED')['sourceReportSha256']='f'*64
        report['stageResults']=ev.stage_results(report['checks'],('5-3','5-4','5-5'))
        ev.bind_files(report,resumed);(resumed/'result.json').write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError,'reused row differs from source'):
            ev.finalize_documents(report,resumed,self.identity,inspector,self.evidence)

    def test_stale_ibus_binary_engine_source_and_harness_rejected(self):
        for key in ('appSha256','rhwpGeneration','productTreeSha256','inputHarnessSha256'):
            with self.subTest(key=key):
                self.input_report=self._write_input_clean()
                self.input_report['identity']={**self.identity,key:'stale'}
                self.rebind_input()
                with self.assertRaises(ValueError):ev.validate_ibus(self.input_root,self.identity)

    def test_duplicate_failed_and_unrelated_ibus_records_rejected(self):
        for mode in ('duplicate','failed','unrelated','missing-format'):
            with self.subTest(mode=mode):
                self.input_report=self._write_input_clean()
                if mode=='duplicate':self.input_report['checks'].append(dict(self.input_report['checks'][0]))
                elif mode=='failed':self.input_report['checks'][3]['result']='FAIL'
                elif mode=='unrelated':self.input_report['checks'][3]['actions']='native window identity'
                else:self.input_report['checks']=[c for c in self.input_report['checks'] if c['format']!='hwp']
                with self.assertRaises(ValueError):
                    self.rebind_input();ev.validate_ibus(self.input_root,self.identity)

    def test_missing_truncated_input_report_and_event_file_rejected(self):
        for data in (None,'{"schema":', '[]'):
            with self.subTest(data=data):
                self.input_report=self._write_input_clean()
                p=self.input_root/'result.json'
                if data is None:p.unlink()
                else:p.write_text(data)
                with self.assertRaises(ValueError):ev.validate_ibus(self.input_root,self.identity)
        self.input_report=self._write_input_clean()
        (self.input_root/'trusted-input-trace.json').unlink()
        with self.assertRaises(ValueError):ev.validate_ibus(self.input_root,self.identity)

    def test_missing_legacy_and_chained_reuse_source_rejected(self):
        source=self.evidence/'missing-source';source.mkdir()
        with self.assertRaises(ValueError):ev.authorize_resume(source,self.identity,inspector)
        (source/'result.json').write_text('{"status":"PASS"}')
        with self.assertRaises(ValueError):ev.authorize_resume(source,self.identity,inspector)
        shutil.rmtree(source);report=self._write_documents(source,partial=True)
        report['reuse']={'path':'unexpected-chain'}
        (source/'result.json').write_text(json.dumps(report))
        with self.assertRaises(ValueError):ev.authorize_resume(source,self.identity,inspector)

    def test_resume_artifact_tampering_all_formats_and_missing_proof_rejected(self):
        for fmt in ev.FORMATS:
            for mutation in ('bytes','delete','source','no-proof','alias','build'):
                with self.subTest(fmt=fmt,mutation=mutation):
                    source=self.evidence/(fmt+'-'+mutation)
                    report=self._write_documents(source,partial=True)
                    a=report['artifacts'][fmt+'/existing'];p=source/a['path']
                    if mutation=='bytes':p.write_bytes(b'changed')
                    elif mutation=='delete':p.unlink()
                    elif mutation=='source':(source/a['sourcePath']).write_bytes(b'changed')
                    elif mutation=='no-proof':a.pop('structureVerified')
                    elif mutation=='alias':a['path']=report['artifacts'][fmt+'/rich']['path']
                    elif mutation=='build':a['identity']={**self.identity,'appSha256':'stale'}
                    (source/'result.json').write_text(json.dumps(report))
                    with self.assertRaises(ValueError):ev.authorize_resume(source,self.identity,inspector)

    def test_resume_missing_source_report_and_wrong_report_hash_rejected(self):
        source=self.evidence/'resume-source';report=self._write_documents(source,partial=True)
        resumed_root=self._make_resumed(source,report)
        resumed=json.loads((resumed_root/'result.json').read_text())
        resumed['reuse']['sha256']='0'*64
        with self.assertRaises(ValueError):ev.finalize_documents(resumed,resumed_root,self.identity,inspector,self.evidence)
        resumed['reuse']['sha256']=sha(source/'result.json');(source/'result.json').unlink()
        with self.assertRaises(ValueError):ev.finalize_documents(resumed,resumed_root,self.identity,inspector,self.evidence)

    def test_malformed_report_and_unsafe_evidence_paths(self):
        (self.docs_root/'result.json').write_text('{not json')
        with self.assertRaisesRegex(ValueError,'malformed/missing acceptance report'):
            ev.load(self.docs_root)
        for value in ('../outside', '/absolute/path', 'verified//docx', './verified/docx/rich.docx'):
            with self.subTest(path=value), self.assertRaises(ValueError):
                ev.safe_file(self.docs_root,value)


if __name__ == '__main__':
    unittest.main()
