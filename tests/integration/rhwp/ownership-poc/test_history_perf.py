import importlib.util
import tempfile
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('ownership_history_perf',Path(__file__).with_name('history-perf.py'))
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class ExitPolicy(unittest.TestCase):
    def value(self):
        row={k:{'n':n,'timeouts':0} for k,n in [('groupStart',30),('extend',30),('undo',25),('redo',20),('afterUndo',5)]}
        source={'frontend':'a'*64}
        return {'measurements':{'perf':[row for _ in range(4)]},'gates':[{'result':'PASS'} for _ in range(8)],
                'sourceIdentityBefore':source,'sourceIdentityAfter':source.copy(),'sourceStableDuringRun':True}
    def test_gate_failure_stays_nonzero(self):
        v=self.value();v['gates'][0]['result']='FAIL';r=runner.classify_result(v)
        self.assertTrue(r['measurementComplete']);self.assertEqual(r['exitReason'],'OFFICIAL_GATE_FAILURE');self.assertEqual(r['status'],'FAIL')
    def test_missing_document(self):
        v=self.value();v['measurements']['perf'].pop();self.assertEqual(runner.classify_result(v)['exitReason'],'INCOMPLETE_MEASUREMENT')
    def test_timeout_cannot_pass(self):
        v=self.value();v['measurements']['perf'][0]['groupStart']['timeouts']=1;self.assertEqual(runner.classify_result(v)['status'],'FAIL')
    def test_missing_gate(self):
        v=self.value();v['gates'].pop();self.assertEqual(runner.classify_result(v)['status'],'FAIL')
    def test_driver_failure_is_separate(self):
        v=self.value();v['error']='driver disconnected';self.assertEqual(runner.classify_result(v)['exitReason'],'HARNESS_ERROR')
    def test_missing_source_identity_cannot_pass(self):
        v=self.value();v.pop('sourceIdentityBefore');r=runner.classify_result(v)
        self.assertTrue(r['measurementComplete']);self.assertEqual(r['exitReason'],'SOURCE_CHANGED');self.assertEqual(r['status'],'FAIL')
    def test_source_change_cannot_pass(self):
        v=self.value();v['sourceStableDuringRun']=False;r=runner.classify_result(v)
        self.assertTrue(r['measurementComplete']);self.assertEqual(r['exitReason'],'SOURCE_CHANGED');self.assertEqual(r['status'],'FAIL')
    def test_source_digest_mismatch_cannot_pass(self):
        v=self.value();v['sourceIdentityAfter']['frontend']='b'*64;r=runner.classify_result(v)
        self.assertTrue(r['measurementComplete']);self.assertEqual(r['exitReason'],'SOURCE_CHANGED');self.assertEqual(r['status'],'FAIL')
    def test_all_actual_gates_pass(self):
        self.assertEqual(runner.classify_result(self.value())['status'],'PASS')


class SourceIdentity(unittest.TestCase):
    def test_tracks_surface_bytes_and_fails_when_required_file_is_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            baseline=runner.source_identity()
            surface='src/components/Editor/rhwp/RhwpSurface.tsx'
            path=root/surface
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_bytes(b'original')
            for relative in baseline:
                if relative != surface:
                    required=root/relative
                    required.parent.mkdir(parents=True,exist_ok=True)
                    required.write_bytes(b'unchanged')
            baseline=runner.source_identity(root)
            path.write_bytes(b'changed')
            updated=runner.source_identity(root)
            self.assertNotEqual(baseline[surface],updated[surface])
            self.assertEqual({key:value for key,value in baseline.items() if key != surface},
                             {key:value for key,value in updated.items() if key != surface})
            path.unlink()
            with self.assertRaises(FileNotFoundError):runner.source_identity(root)
