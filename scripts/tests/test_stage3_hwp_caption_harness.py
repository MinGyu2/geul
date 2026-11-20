"""Focused fail-closed checks for HWP caption native acceptance preconditions."""
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).with_name('native-stage3-hwp-caption-ime-lock.py')
spec = importlib.util.spec_from_file_location('hwp_caption_acceptance', SCRIPT)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class ImeObservations(unittest.TestCase):
    def test_expected_observations_are_accepted(self):
        harness.validate_ime_observations({'revision': '2'}, {'revision': '2', 'synced': 'true'})

    def test_incorrect_or_missing_values_are_rejected(self):
        for status, save in [
            ({'revision': '3'}, {'revision': '2', 'synced': 'true'}),
            ({}, {'revision': '2', 'synced': 'true'}),
            ({'revision': None}, {'revision': '2', 'synced': 'true'}),
            ({'revision': '2'}, {'revision': '1', 'synced': 'true'}),
            ({'revision': '2'}, {'synced': 'true'}),
            ({'revision': '2'}, {'revision': '2', 'synced': 'false'}),
            ({'revision': '2'}, {'revision': '2'}),
            ({'revision': '2'}, {'revision': '2', 'synced': None}),
            ({'revision': '2'}, {'revision': '2', 'synced': True}),
        ]:
            with self.subTest(status=status, save=save), self.assertRaises(ValueError):
                harness.validate_ime_observations(status, save)


class FixturePreflight(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='geul-hwp-lock-test-')
        cls.fixtures = Path(cls.temp.name) / 'fixtures'
        subprocess.run(['node', str(Path(__file__).with_name('stage3-hwp-caption-native-fixtures.cjs')), str(cls.fixtures)],
                       cwd=harness.ROOT, check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_actual_serialized_caption_owner_and_lock(self):
        for name, expected in [('fixture.hwp', False), ('locked.hwp', True)]:
            with self.subTest(name=name):
                result = harness.inspect_caption_fixture(self.fixtures / name, expected)
                self.assertEqual((result['section'], result['paragraph'], result['control']), (0, 0, 2))
                self.assertTrue(result['caption'])
                self.assertEqual(result['locked'], expected)
                self.assertEqual(result['attribute'], '0x600a0000' if expected else '0x200a0000')

    def test_unlocked_replacement_refused_before_driver_start(self):
        bad = Path(self.temp.name) / 'bad-fixtures'
        bad.mkdir()
        shutil.copyfile(self.fixtures / 'fixture.hwp', bad / 'fixture.hwp')
        shutil.copyfile(self.fixtures / 'fixture.hwp', bad / 'locked.hwp')
        out = Path(self.temp.name) / 'preflight-out'
        argv = ['acceptance', '--out', str(out), '--fixtures', str(bad), '--xdotool', 'unused', '--ibus', 'unused']
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(harness.p.p4.smoke, 'tauri_driver') as driver:
            with self.assertRaises(ValueError):
                harness.main()
            driver.assert_not_called()

    def test_missing_or_ambiguous_lock_and_owner_rejected(self):
        streams = harness.cfb_streams((self.fixtures / 'locked.hwp').read_bytes())
        rows = harness.records(harness.unpacked(streams, 'BodyText/Section0'))
        target = next(i for i, (tag, level, data) in enumerate(rows) if (tag, level) == (71, 1) and data.startswith(b' osg'))
        broken_header = list(rows)
        broken_header[target] = (71, 1, broken_header[target][2][:6])
        wrong_owner = list(rows)
        wrong_owner[target] = (71, 1, b'bad!' + wrong_owner[target][2][4:])
        missing_list = list(rows)
        missing_list[target + 1] = (72, 2, b'')
        for bad in [broken_header, wrong_owner, missing_list, rows + [rows[target]]]:
            with self.subTest(bad=bad[target][2][:8]), self.assertRaises(ValueError):
                harness.inspect_caption_lock_records(bad, True)
        with self.assertRaises(ValueError):
            harness.inspect_caption_fixture(self.fixtures / 'fixture.hwp', True)
        with self.assertRaises(ValueError):
            harness.inspect_caption_fixture(self.fixtures / 'locked.hwp', False)


if __name__ == '__main__':
    unittest.main()
