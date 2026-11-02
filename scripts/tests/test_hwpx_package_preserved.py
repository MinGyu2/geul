"""Archive-level checks of the native HWPX acceptance oracle (package_preserved).

Run: python3 -m unittest scripts/tests/test_hwpx_package_preserved.py
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native', ROOT / 'scripts/tests/native-external-hwpx-save.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph'
HS = 'http://www.hancom.co.kr/hwpml/2011/section'
HH = 'http://www.hancom.co.kr/hwpml/2011/head'
LAYOUT = '<hp:linesegarray><hp:lineseg textpos="0" vertsize="1000"/></hp:linesegarray>'


def section(text):
    return (f'<hs:sec xmlns:hs="{HS}" xmlns:hp="{HP}"><hp:p id="0"><hp:run charPrIDRef="0">'
            f'<hp:t>{text}</hp:t></hp:run>{LAYOUT}</hp:p></hs:sec>').encode()


HEADER = f'<hh:head xmlns:hh="{HH}" version="1.4" secCnt="1"><hh:refList/></hh:head>'.encode()
HEADER_EQUIVALENT = f'<?xml version="1.0"?><h:head secCnt="1" version="1.4" xmlns:h="{HH}"><h:refList/></h:head>'.encode()
BINARY = bytes(range(256)) * 4


def entries(text='AB', header=HEADER, binary=BINARY):
    return [('mimetype', b'application/hwp+zip'), ('Contents/header.xml', header),
            ('Contents/section0.xml', section(text)), ('BinData/image1.bin', binary)]


def legacy_archive_check(source, saved):
    """Former package-set check, kept as false-negative evidence."""
    with zipfile.ZipFile(source) as a, zipfile.ZipFile(saved) as b:
        return b.testzip() is None and set(a.namelist()) == set(b.namelist())


class PackagePreserved(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.dir = Path(self.folder.name)
        self.source = self.write('source.hwpx', entries())

    def tearDown(self):
        self.folder.cleanup()

    def write(self, name, items):
        path = self.dir / name
        with warnings.catch_warnings(), zipfile.ZipFile(path, 'w') as archive:
            warnings.simplefilter('ignore')  # duplicate names are written deliberately
            for part, data in items:
                archive.writestr(part, data, compress_type=zipfile.ZIP_STORED)
        return path

    def check(self, saved, source=None):
        return native.package_preserved(source or self.source, saved, '한글AB', 'AB')

    def refused(self, saved, reason, source=None):
        with self.assertRaises(AssertionError) as caught:
            self.check(saved, source)
        self.assertIn(reason, str(caught.exception))

    def test_valid_packages(self):
        self.assertTrue(self.check(self.write('saved.hwpx', entries('한글AB')))['partSetEqual'])
        reordered = list(reversed(entries('한글AB')))
        self.check(self.write('reordered.hwpx', reordered))
        self.check(self.write('equivalent.hwpx', entries('한글AB', header=HEADER_EQUIVALENT)))

    def test_duplicate_saved_entry(self):
        for name, data in (('identical copy', HEADER), ('different copy', b'<x/>')):
            with self.subTest(name):
                saved = self.write('dup.hwpx', entries('한글AB') + [('Contents/header.xml', data)])
                with zipfile.ZipFile(saved) as archive:
                    self.assertIsNone(archive.testzip(), 'duplicate members keep valid CRCs')
                self.assertTrue(legacy_archive_check(self.source, saved), 'legacy set check hides multiplicity')
                self.refused(saved, 'saved: duplicate ZIP entry names')

    def test_duplicate_source_entry(self):
        source = self.write('dupsource.hwpx', entries() + [('BinData/image1.bin', b'other')])
        saved = self.write('saved.hwpx', entries('한글AB'))
        self.assertTrue(legacy_archive_check(source, saved))
        self.refused(saved, 'original: duplicate ZIP entry names', source)

    def test_part_set_changes(self):
        self.refused(self.write('missing.hwpx', entries('한글AB')[:-1]), 'part set differs')
        self.refused(self.write('extra.hwpx', entries('한글AB') + [('BinData/extra.bin', b'x')]), 'part set differs')

    def test_corrupted_entry(self):
        saved = self.write('corrupt.hwpx', entries('한글AB'))
        data = bytearray(saved.read_bytes())
        offset = bytes(data).index(BINARY[:64]) + 10
        data[offset] ^= 0xFF
        saved.write_bytes(bytes(data))
        self.refused(saved, 'saved: corrupt ZIP entry')

    def test_changed_unrelated_binary_and_xml(self):
        changed = bytearray(BINARY)
        changed[100] ^= 1
        with self.assertRaises(AssertionError) as caught:
            self.check(self.write('binary.hwpx', entries('한글AB', binary=bytes(changed))))
        self.assertEqual(str(caught.exception), 'BinData/image1.bin')
        header = HEADER.replace(b'secCnt="1"', b'secCnt="2"')
        self.refused(self.write('header.hwpx', entries('한글AB', header=header)), 'Contents/header.xml')


if __name__ == '__main__':
    unittest.main()
