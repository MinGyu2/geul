"""Focused regressions for native_recovery_checks (T014 native recovery acceptance helpers)."""
import copy
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


def complete_report():
    launches = [{'id': f'hwp:{phase}', 'pid': 100 + n, 'startTime': 200 + n, 'dataHome': '/isolated/hwp'}
                for n, phase in enumerate(checks.LAUNCH_PHASES)]
    return {'formats': [{'format': 'hwp', 'status': 'PASS', 'steps': [{'step': 'a', 'status': 'PASS'}]}],
            'launches': launches,
            'teardown': [{'launchId': row['id'], **{k: row[k] for k in ('pid', 'startTime', 'dataHome')},
                          'complete': True, 'remainingAfterWait': [], 'survivorsAfterSigterm': [],
                          'sigtermErrors': [], 'driverExit': 0} for row in launches]}


class Accounting(unittest.TestCase):
    def test_failed_step_raises_and_is_recorded(self):
        entry = {}
        step = checks.Steps(entry, 'hwp')
        step('ok', True)
        with self.assertRaises(checks.AcceptanceError) as caught:
            step('bad', False, {'seen': 1}, expected='seen == 2')
        self.assertEqual((caught.exception.format, caught.exception.step, caught.exception.expected), ('hwp', 'bad', 'seen == 2'))
        self.assertEqual([r['status'] for r in entry['steps']], ['PASS', 'FAIL'])
        with self.assertRaises(checks.AcceptanceError):
            checks.require(False, 'hwpx', 'setup', 1, 'x')

    def test_missing_teardown_duplicate_step_and_incomplete_cleanup_explain_failure(self):
        import copy
        for kind, message in (('missing', 'teardown'), ('duplicate', 'exactly once'), ('incomplete', 'incomplete')):
            report = copy.deepcopy(complete_report())
            if kind == 'missing':
                del report['teardown']
            elif kind == 'duplicate':
                report['formats'][0]['steps'] *= 2
            else:
                report['teardown'][0]['complete'] = False
            status, problems = checks.overall(report, {'hwp': ['a']})
            self.assertEqual(status, 'FAIL')
            self.assertIn(message, '; '.join(problems))

    def test_overall_requires_every_format_step_and_clean_teardown(self):
        good = complete_report()
        self.assertEqual(checks.overall(good, {'hwp': ['a']})[0], 'PASS')
        cases = [
            {**good, 'formats': [{**good['formats'][0], 'steps': [{'step': 'a', 'status': 'PASS'}, {'step': 'b', 'status': 'FAIL'}]}]},
            {**good, 'formats': [{**good['formats'][0], 'status': None}]},
            {**good, 'error': 'boom'},
            {**good, 'teardown': [{'complete': True, 'remainingAfterWait': [1], 'survivorsAfterSigterm': []}]},
            {**good, 'teardown': [{'complete': False}]},
        ]
        for report in cases:
            self.assertEqual(checks.overall(report, {'hwp': ['a']})[0], 'FAIL', report)
        self.assertEqual(checks.overall(good, {'hwp': ['a', 'missing']})[0], 'FAIL')
        self.assertEqual(checks.overall(good, {'hwp': ['a'], 'hwpx': ['a']})[0], 'FAIL')
        self.assertEqual(checks.overall(good, {'hwp': []})[0], 'FAIL')


class FalsePassMatrix(unittest.TestCase):
    """Each mutation targets production evidence; no second verifier implementation."""
    def test_negative_evidence_matrix(self):
        mutations = {
            'missing teardown': lambda r: r.pop('teardown'),
            'empty teardown': lambda r: r.update(teardown=[]),
            'too few teardown': lambda r: r['teardown'].pop(),
            'too many teardown': lambda r: r['teardown'].append(copy.deepcopy(r['teardown'][0])),
            'duplicate lifecycle': lambda r: r['launches'].append(copy.deepcopy(r['launches'][0])),
            'duplicate teardown replacing missing launch': lambda r: r['teardown'].__setitem__(1, copy.deepcopy(r['teardown'][0])),
            'incomplete teardown': lambda r: r['teardown'][0].update(complete=False),
            'surviving app': lambda r: r['teardown'][0].update(remainingAfterWait=[{'pid': 100, 'comm': 'geul', 'state': 'S'}]),
            'surviving descendant': lambda r: r['teardown'][0].update(survivorsAfterSigterm=[{'pid': 102, 'comm': 'WebKitWebProcess', 'state': 'S'}]),
            'stale teardown': lambda r: r['teardown'][0].update(launchId='hwp:old'),
            'contradictory teardown': lambda r: r['teardown'][0].update(startTime=999),
            'missing mandatory step': lambda r: r['formats'][0].update(steps=[]),
            'duplicate mandatory PASS': lambda r: r['formats'][0]['steps'].append({'step': 'a', 'status': 'PASS'}),
            'inconsistent duplicate step': lambda r: r['formats'][0]['steps'].append({'step': 'a', 'status': 'FAIL'}),
            'mandatory FAIL': lambda r: r['formats'][0]['steps'][0].update(status='FAIL'),
            'missing format': lambda r: r.update(formats=[]),
            'duplicate format': lambda r: r['formats'].append(copy.deepcopy(r['formats'][0])),
            'missing scenario status': lambda r: r['formats'][0].pop('status'),
            'incomplete scenario': lambda r: r['formats'][0].update(status='RUNNING'),
            'unexpected error': lambda r: r.update(error='unexpected failure'),
            'empty error is still recorded': lambda r: r.update(error=''),
            'missing launches': lambda r: r.pop('launches'),
            'empty launches': lambda r: r.update(launches=[]),
            'reused app process': lambda r: r['launches'][1].update(pid=100, startTime=200),
            'missing process start time': lambda r: r['launches'][0].pop('startTime'),
            'missing survivor observation': lambda r: r['teardown'][0].pop('survivorsAfterSigterm'),
            'truthy complete string': lambda r: r['teardown'][0].update(complete='true'),
            'missing driver exit': lambda r: r['teardown'][0].pop('driverExit'),
            'missing step status': lambda r: r['formats'][0]['steps'][0].pop('status'),
            'malformed step': lambda r: r['formats'][0]['steps'].append(None),
            'malformed step name': lambda r: r['formats'][0]['steps'][0].update(step=[]),
            'malformed format': lambda r: r['formats'].append(None),
            'malformed launch': lambda r: r['launches'].append(None),
            'malformed teardown': lambda r: r['teardown'].__setitem__(0, None),
        }
        for name, mutate in mutations.items():
            with self.subTest(case=name):
                report = copy.deepcopy(complete_report())
                mutate(report)
                status, problems = checks.overall(report, {'hwp': ['a']})
                self.assertEqual(status, 'FAIL')
                self.assertTrue(problems, name)
        for required in ({}, {'hwp': []}, {'hwp': None}, {'hwp': ['a', 'a']}, {'hwp': [None]}):
            with self.subTest(required=required):
                self.assertEqual(checks.overall(complete_report(), required)[0], 'FAIL')
        for field in ('formats', 'launches', 'teardown'):
            for malformed in (None, {}, '', True):
                report = complete_report()
                report[field] = malformed
                with self.subTest(field=field, malformed=malformed):
                    self.assertEqual(checks.overall(report, {'hwp': ['a']})[0], 'FAIL')

    def test_complete_formats_and_optional_steps(self):
        report = complete_report()
        second = copy.deepcopy(report)
        second['formats'][0]['format'] = 'hwpx'
        second['formats'][0]['steps'] = [{'step': 'hwpx-only', 'status': 'PASS'}]
        for launch, teardown in zip(second['launches'], second['teardown']):
            launch.update(id=launch['id'].replace('hwp:', 'hwpx:'), pid=launch['pid'] + 10,
                          dataHome='/isolated/hwpx')
            teardown.update(launchId=launch['id'], pid=launch['pid'], dataHome=launch['dataHome'])
        for field in ('formats', 'launches', 'teardown'):
            report[field] += second[field]
        report['formats'][0]['steps'].append({'step': 'optional diagnostic', 'status': 'PASS'})
        required = {'hwp': ['a'], 'hwpx': ['hwpx-only']}
        self.assertEqual(checks.overall(report, required), ('PASS', []))
        report['formats'].pop()
        status, problems = checks.overall(report, required)
        self.assertEqual(status, 'FAIL')
        self.assertIn('hwpx: not run', problems)


# Runs the real native-recovery-crash.py main() with run_format replaced by one deliberately failing step.
NEGATIVE = r'''
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('crash', sys.argv[1]); crash = importlib.util.module_from_spec(spec); spec.loader.exec_module(crash)
def run_format(args, fmt, engine, report):
    entry = {'format': fmt, 'steps': []}; report['formats'].append(entry)
    step = crash.checks.Steps(entry, fmt)
    step('controlled false acceptance condition', False, {'observed': 0}, expected='1')
    entry['status'] = 'PASS'
crash.run_format = run_format
crash.smoke.TEARDOWN = []
sys.argv = ['crash', '--app', sys.argv[2], '--app-sha256', sys.argv[3], '--driver', sys.argv[2], '--out', sys.argv[4],
            '--fixtures', sys.argv[5], '--xdotool', 'x', '--ibus', 'x', '--formats', 'hwp']
sys.exit(crash.main())
'''


# Controlled evidence only: exercises the real CLI finalization and exit code;
# it is explicitly not a native app acceptance execution.
EVIDENCE_MAIN = r'''
import importlib.util, sys
spec = importlib.util.spec_from_file_location('crash', sys.argv[1]); crash = importlib.util.module_from_spec(spec); spec.loader.exec_module(crash)
case = sys.argv[6]
crash.smoke.TEARDOWN = []
def run_format(args, fmt, engine, report):
    offset = 100 if fmt == 'hwp' else 200
    entry = {'format': fmt, 'status': 'PASS', 'steps': [{'step': n, 'status': 'PASS'} for n in crash.required_steps(fmt)]}
    report['formats'].append(entry)
    for n, phase in enumerate(crash.checks.LAUNCH_PHASES):
        launch = {'id': f'{fmt}:{phase}', 'pid': offset+n, 'startTime': offset+n, 'dataHome': f'/isolated/{fmt}'}
        report.setdefault('launches', []).append(launch)
        crash.smoke.TEARDOWN.append({'launchId': launch['id'], **{k: launch[k] for k in ('pid', 'startTime', 'dataHome')},
                                   'complete': True, 'remainingAfterWait': [], 'survivorsAfterSigterm': [], 'sigtermErrors': [], 'driverExit': 0})
    if fmt == 'hwpx':
        if case == 'empty-teardown': crash.smoke.TEARDOWN.clear()
        elif case == 'duplicate-step': entry['steps'].append(entry['steps'][0].copy())
        elif case == 'stale-teardown': crash.smoke.TEARDOWN[0]['launchId'] = 'stale'
        elif case == 'missing-format': report['formats'].pop()
crash.run_format = run_format
sys.argv = ['crash', '--app', sys.argv[2], '--app-sha256', sys.argv[3], '--driver', sys.argv[2], '--out', sys.argv[4],
            '--fixtures', sys.argv[5], '--xdotool', 'x', '--ibus', 'x']
sys.exit(crash.main())
'''


@unittest.skipUnless((TEST_DIR.parents[1] / 'dist/rhwp/BUILD.json').exists(), 'needs the built dist/rhwp Release engine')
class OptimizedInterpreter(unittest.TestCase):
    def run_main(self, flags, env, code=NEGATIVE, case="failed-step"):
        with tempfile.TemporaryDirectory(prefix='geul-negative-') as tmp:
            tmp = Path(tmp)
            app, fixtures = tmp / 'app', tmp / 'fixtures'
            app.write_bytes(b'not an app')
            fixtures.mkdir()
            import hashlib
            digest = hashlib.sha256(app.read_bytes()).hexdigest()
            done = subprocess.run([sys.executable, *flags, '-c', code, str(TEST_DIR / 'native-recovery-crash.py'), str(app), digest,
                                   str(tmp / 'out'), str(fixtures), case], capture_output=True, text=True, env={**os.environ, **env}, timeout=120)
            result = json.loads((tmp / 'out' / 'result.json').read_text())
            return done, result

    def test_failed_condition_is_fail_under_normal_and_optimized_python(self):
        for flags, env in (([], {'PYTHONOPTIMIZE': ''}), (['-O'], {}), (['-OO'], {}), ([], {'PYTHONOPTIMIZE': '1'})):
            done, result = self.run_main(flags, env)
            with self.subTest(flags=flags, env=env):
                self.assertNotEqual(done.returncode, 0, done.stderr)
                self.assertEqual(result['status'], 'FAIL')
                self.assertIn('AcceptanceError', result['error'])
                self.assertEqual([r['status'] for r in result['formats'][0]['steps']], ['FAIL'])
                self.assertNotIn('status', result['formats'][0])  # the line after the failed step never ran
                self.assertIn('overall FAIL', done.stdout)

    def test_real_main_finalizes_controlled_invalid_evidence(self):
        for flags, env in (([], {'PYTHONOPTIMIZE': ''}), (['-O'], {}), (['-OO'], {}), ([], {'PYTHONOPTIMIZE': '1'})):
            for case, message in (('empty-teardown', 'teardown count'), ('duplicate-step', 'exactly once'),
                                  ('stale-teardown', 'corresponding required launch'), ('missing-format', 'hwpx: not run'),
                                  ('valid', None)):
                with self.subTest(flags=flags, env=env, case=case):
                    done, result = self.run_main(flags, env, EVIDENCE_MAIN, case)
                    self.assertEqual(done.returncode, 0 if case == 'valid' else 1, done.stderr)
                    self.assertEqual(result['status'], 'PASS' if case == 'valid' else 'FAIL')
                    if message:
                        self.assertIn(message, '; '.join(result['problems']))
                        self.assertIn('overall FAIL', done.stdout)

    def test_optimized_interpreter_really_strips_assert(self):
        done = subprocess.run([sys.executable, '-O', '-c', 'assert False; print("stripped")'], capture_output=True, text=True)
        self.assertEqual(done.stdout.strip(), 'stripped')


class PreviewVerifierOptimized(unittest.TestCase):
    def test_cfb_integrity_checks_survive_optimization(self):
        code = ('import importlib.util,sys;s=importlib.util.spec_from_file_location("v",sys.argv[1]);m=importlib.util.module_from_spec(s);'
                's.loader.exec_module(m)\ntry:\n m.cfb_streams(b"not a cfb container"+bytes(600))\nexcept m.VerificationError as e:\n'
                ' print("rejected",e);sys.exit(3)\nprint("accepted")')
        for flags in ([], ['-O']):
            done = subprocess.run([sys.executable, *flags, '-c', code, str(TEST_DIR / 'verify-hwp-preview.py')], capture_output=True, text=True)
            self.assertEqual((done.returncode, done.stdout.strip()), (3, 'rejected not CFB'), (flags, done.stderr))


if __name__ == '__main__':
    unittest.main()
