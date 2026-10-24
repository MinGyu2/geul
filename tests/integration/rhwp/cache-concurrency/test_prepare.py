"""The caret candidate must not certify artifacts after untracked layout changes."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('candidate_prepare', Path(__file__).with_name('prepare.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class CandidateSourceIdentity(unittest.TestCase):
    def test_canvas_conversion_change_invalidates_candidate_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            helper = work / 'src/renderer/canvas_rgba.rs'
            helper.parent.mkdir(parents=True)
            helper.write_text('original conversion')
            before = prepare.source_hashes(work)
            helper.write_text('changed during build')
            self.assertNotEqual(before, prepare.source_hashes(work))

    def test_layout_and_geometry_contract_changes_invalidate_candidate_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            layout = work / 'src/renderer/layout.rs'
            contract = work / 'src/renderer/layout/caret_geometry_tests.rs'
            contract.parent.mkdir(parents=True)
            layout.write_text('original layout')
            contract.write_text('original contract')
            before = prepare.source_hashes(work)
            layout.write_text('layout changed while building')
            after_layout = prepare.source_hashes(work)
            self.assertNotEqual(before, after_layout)
            contract.write_text('contract changed while building')
            self.assertNotEqual(after_layout, prepare.source_hashes(work))

    def test_older_candidates_keep_their_original_manifest_shape(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            layout = work / 'src/renderer/layout.rs'
            layout.parent.mkdir(parents=True)
            layout.write_text('existing unrelated layout')
            for name in prepare.CHANGED:
                path = work / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('original')
            self.assertEqual(set(prepare.source_hashes(work)), set(prepare.CHANGED))
