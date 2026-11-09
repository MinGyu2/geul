"""Focused regressions for native_recovery_checks (T014 native recovery acceptance helpers)."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

TEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIR))
import native_recovery_checks as checks

CONTROLS = [
    {"ctrlId": "secd", "ctrlCh": 2, "userDesc": "구역 정의", "list": 0, "para": 0, "pos": 0, "controlIndex": 0, "props": {}},
    {"ctrlId": "cold", "ctrlCh": 2, "userDesc": "단 정의", "list": 0, "para": 0, "pos": 8, "controlIndex": 1, "props": {}},
    {"ctrlId": "tbl", "ctrlCh": 11, "userDesc": "표", "list": 0, "para": 2, "pos": 0, "controlIndex": 0,
     "props": {"Lock": 0, "TreatAsChar": 0, "AllowOverlap": 0, "TextWrap": 1, "Width": 41954, "Height": 2564, "HorzOffset": 0, "VertOffset": 0}},
]


def text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


class Controls(unittest.TestCase):
    def test_identical_and_key_order_only_differences_pass(self):
        reordered = [dict(reversed(list(item.items()))) for item in CONTROLS]
        self.assertEqual(len(checks.compare_controls(text(CONTROLS), text(reordered))), 3)
        self.assertEqual(checks.compare_controls('[]', '[]'), [])

    def test_equal_length_different_structure_fails(self):
        changed = json.loads(text(CONTROLS))
        changed[0]['pos'], changed[1]['pos'] = 8, 0  # same serialized length, different structure
        self.assertEqual(len(text(changed)), len(text(CONTROLS)))
        with self.assertRaises(checks.CheckError):
            checks.compare_controls(text(CONTROLS), text(changed))
        swapped = [CONTROLS[1], CONTROLS[0], CONTROLS[2]]  # order is significant
        self.assertEqual(len(text(swapped)), len(text(CONTROLS)))
        with self.assertRaises(checks.CheckError):
            checks.compare_controls(text(CONTROLS), text(swapped))

    def test_added_removed_and_changed_attribute_fail(self):
        for actual in (CONTROLS[:2], CONTROLS + [CONTROLS[2]], []):
            with self.assertRaises(checks.CheckError):
                checks.compare_controls(text(CONTROLS), text(actual))
        changed = json.loads(text(CONTROLS))
        changed[2]['props']['Width'] = 41955
        with self.assertRaises(checks.CheckError):
            checks.compare_controls(text(CONTROLS), text(changed))

    def test_malformed_or_unexpected_control_data_fails_explicitly(self):
        for bad in ('[{"ctrlId":', '{}', '"[]"', '[1]', text([{**CONTROLS[0], 'extra': 1}]),
                    text([{k: v for k, v in CONTROLS[0].items() if k != 'pos'}]), text([{**CONTROLS[0], 'pos': True}]),
                    text([{**CONTROLS[0], 'props': []}])):
            with self.assertRaises(checks.CheckError, msg=bad):
                checks.parse_controls(bad)
        with self.assertRaises(checks.CheckError):
            checks.parse_controls(414)  # a length is not control data


def cfb(streams):
    """Minimal CFB v3 (512-byte sectors, mini-stream cutoff 0 so every stream uses the FAT)."""
    sector = 512
    end, free, fat_mark, none = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD, 0xFFFFFFFF
    data_sectors, chains, next_sector = [], [], 2
    for _, payload in streams:
        count = max(1, -(-len(payload) // sector))
        chains.append((next_sector, count))
        for i in range(count):
            data_sectors.append(payload[i * sector:(i + 1) * sector].ljust(sector, b'\0'))
        next_sector += count
    fat = [fat_mark, end]
    for first, count in chains:
        fat += [first + i + 1 for i in range(count - 1)] + [end]
    fat += [free] * (sector // 4 - len(fat))

    def entry(name, kind, first, size):
        encoded = (name + '\0').encode('utf-16-le')
        return (encoded.ljust(64, b'\0') + struct.pack('<HBB', len(encoded), kind, 1) + struct.pack('<III', none, none, none)
                + b'\0' * 16 + b'\0' * 4 + b'\0' * 16 + struct.pack('<IQ', first, size))
    directory = entry('Root Entry', 5, end, 0)
    for (name, payload), (first, _) in zip(streams, chains):
        directory += entry(name, 2, first, len(payload))
    assert len(directory) <= sector
    header = (bytes.fromhex('d0cf11e0a1b11ae1') + b'\0' * 16 + struct.pack('<HHHHH', 0x3E, 3, 0xFFFE, 9, 6) + b'\0' * 6
              + struct.pack('<IIIIIIIII', 0, 1, 1, 0, 0, end, 0, end, 0) + struct.pack('<109I', 0, *([free] * 108)))
    return header + struct.pack(f'<{sector // 4}I', *fat) + directory.ljust(sector, b'\0') + b''.join(data_sectors)


def utf16(value):
    return value.encode('utf-16-le')


SOURCE_TEXT = '한글 문단입니다. Korean paragraph.\r\n굵은 글씨 Bold text\r\n'


class PrvText(unittest.TestCase):
    source = cfb([('PrvText', utf16(SOURCE_TEXT)), ('Section0', b'\x78\x9c compressed body')])

    def test_regenerated_preview_in_the_actual_stream_passes(self):
        recovered = cfb([('PrvText', utf16('T014MARK' + SOURCE_TEXT)), ('Section0', b'other')])
        self.assertEqual(checks.check_regenerated_prv_text(self.source, recovered, 'T014MARK')['recovered'], 'T014MARK' + SOURCE_TEXT)

    def test_marker_elsewhere_in_the_container_fails(self):
        # The marker and the name "PrvText" both occur in the container, but the PrvText stream is stale.
        recovered = cfb([('PrvText', utf16(SOURCE_TEXT)), ('Other', utf16('T014MARK PrvText'))])
        self.assertIn(utf16('T014MARK'), recovered)
        with self.assertRaises(checks.CheckError):
            checks.check_regenerated_prv_text(self.source, recovered, 'T014MARK')

    def test_wrong_revision_preview_fails(self):
        newer = cfb([('PrvText', utf16('T014MARKZ' + SOURCE_TEXT))])
        with self.assertRaises(checks.CheckError):
            checks.check_regenerated_prv_text(self.source, newer, 'T014MARK')

    def test_missing_corrupt_or_undecodable_preview_fails(self):
        for recovered in (cfb([('Section0', utf16('T014MARK'))]), cfb([('PrvText', b'\x00\xd8\x41\x00')]),
                          cfb([('PrvText', b'abc')]), cfb([('PrvText', utf16('T014MARK\x00'))]), b'not a cfb container'):
            with self.assertRaises(checks.CheckError):
                checks.check_regenerated_prv_text(self.source, recovered, 'T014MARK')

    def test_source_already_containing_the_marker_fails(self):
        source = cfb([('PrvText', utf16('T014MARK' + SOURCE_TEXT))])
        with self.assertRaises(checks.CheckError):
            checks.check_regenerated_prv_text(source, cfb([('PrvText', utf16('T014MARKT014MARK' + SOURCE_TEXT))]), 'T014MARK')


class Process(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix='geul-pidfd-test-')
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait()
        os.rmdir(self.home)

    def spawn(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], env={**os.environ, 'XDG_DATA_HOME': self.home})
        self.children.append(child)
        return child

    def owned(self, **kwargs):
        return checks.OwnedProcess(sys.executable, self.home, **kwargs)

    def test_signals_only_the_exact_owned_process_and_closes_the_pidfd(self):
        child = self.spawn()
        bystander = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])  # same exe, no marker
        self.children.append(bystander)
        with self.owned() as process:
            self.assertEqual(process.pid, child.pid)
            fd = process.fd
            self.assertTrue(process.alive())
            evidence = process.kill()
            self.assertFalse(process.alive())
        self.assertIsNone(process.fd)
        with self.assertRaises(OSError):
            os.fstat(fd)
        self.assertEqual(child.wait(timeout=5), -9)
        self.assertIsNone(bystander.poll())
        self.assertIn('pidfd_send_signal', evidence['method'])

    def test_process_exited_before_signal_is_not_reported_as_killed(self):
        child = self.spawn()
        with self.owned() as process:
            child.terminate(); child.wait()  # exited and reaped: its PID may now be reused by anything
            with self.assertRaisesRegex(checks.ProcessError, 'already exited'):
                process.kill()

    def test_no_match_identity_mismatch_and_multiple_matches_fail(self):
        with self.assertRaisesRegex(checks.ProcessError, 'exactly one'):
            self.owned().acquire()
        self.spawn()
        with self.assertRaisesRegex(checks.ProcessError, 'exactly one'):
            checks.OwnedProcess('/nonexistent/geul', self.home).acquire()
        self.spawn()
        with self.assertRaisesRegex(checks.ProcessError, 'exactly one'):
            self.owned().acquire()

    def test_pidfd_acquisition_failure_and_identity_change_fail_closed(self):
        child = self.spawn()

        def refuse(_pid):
            raise PermissionError('denied')
        with self.assertRaisesRegex(checks.ProcessError, 'acquisition failed'):
            self.owned(opener=refuse).acquire()

        def reuse(pid):
            child.kill(); child.wait()  # the matched process vanishes before the pidfd exists
            return os.pidfd_open(os.getpid())
        with self.assertRaisesRegex(checks.ProcessError, 'identity changed'):
            self.owned(opener=reuse).acquire()

    def test_api_unavailable_blocks_instead_of_numeric_kill(self):
        self.spawn()
        process = self.owned()
        process._send = None
        with self.assertRaisesRegex(checks.ProcessError, 'unavailable'):
            process.acquire()
        self.assertIsNone(process.fd)

    def test_signal_delivery_failure_is_reported_and_process_survives(self):
        child = self.spawn()

        def fail(_fd, _sig):
            raise PermissionError('EPERM')
        with self.owned(sender=fail) as process:
            with self.assertRaisesRegex(checks.ProcessError, 'delivery failed'):
                process.kill()
            self.assertTrue(process.alive())
        self.assertIsNone(child.poll())


MANIFEST = {"generation": "a" * 64, "profile": "release", "artifacts": {"rhwp.js": "b" * 64, "rhwp_bg.wasm": "c" * 64}}
INDEPENDENT = {"generation": "a" * 64, "manifest": MANIFEST, "jsSha256": "b" * 64, "wasmSha256": "c" * 64}


def runtime(**patch):
    value = {"generation": "a" * 64, "initialized": True, "controlInitialized": False,
             "selected": json.loads(json.dumps(MANIFEST)), "immutable": dict(reversed(list(MANIFEST.items()))),
             "jsSha256": "b" * 64, "wasmSha256": "c" * 64}
    value.update(patch)
    return value


class RuntimeIdentity(unittest.TestCase):
    def test_matching_runtime_passes(self):
        self.assertEqual(checks.compare_runtime_identity(runtime(), INDEPENDENT)['generation'], 'a' * 64)

    def test_mismatches_fail(self):
        for bad in (runtime(generation='d' * 64), runtime(initialized=False), runtime(initialized=None),
                    runtime(controlInitialized=True), runtime(controlInitialized=None),
                    runtime(wasmSha256='e' * 64), runtime(jsSha256='e' * 64), runtime(immutable={}),
                    runtime(selected={**MANIFEST, 'generation': 'd' * 64}),
                    runtime(immutable={**MANIFEST, 'profile': 'debug'})):
            with self.assertRaises(checks.CheckError):
                checks.compare_runtime_identity(bad, INDEPENDENT)


if __name__ == '__main__':
    unittest.main()
