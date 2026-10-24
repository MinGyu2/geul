import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('ownership_history_perf',Path(__file__).with_name('history-perf.py'))
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class ExitPolicy(unittest.TestCase):
    def value(self):
        row={k:{'n':n,'timeouts':0} for k,n in [('groupStart',30),('extend',30),('undo',25),('redo',20),('afterUndo',5)]}
        return {'measurements':{'perf':[row for _ in range(4)]},'gates':[{'result':'PASS'} for _ in range(8)]}
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
    def test_all_actual_gates_pass(self):
        self.assertEqual(runner.classify_result(self.value())['status'],'PASS')
