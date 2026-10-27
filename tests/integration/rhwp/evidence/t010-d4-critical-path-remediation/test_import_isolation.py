"""Fresh-process coverage for the combined CI discovery's stdlib import boundary."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent

# Do not preload typing: Python 3.14's asyncio need not import typing.final, whereas
# Python 3.12 does. The explicit final import exposes the same lookup defect on both.
PROBE = r'''
import sys
import importlib.util
import json
from pathlib import Path

if 'typing' in sys.modules:
    raise RuntimeError('probe must start without cached typing')
here = Path(sys.argv[1])
# here is rhwp/evidence/<task>; the authority remains in rhwp/ownership-poc.
authority = here.parents[1] / 'ownership-poc' / 'native_d1_result.py'
original_path = list(sys.path)
# A same-named cached module must not replace the explicitly loaded authority.
sys.modules['native_d1_result'] = type(sys)('unrelated_native_identity')
modules = {}
for filename in sys.argv[2:]:
    spec = importlib.util.spec_from_file_location('probe_' + filename.replace('.', '_'), here / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if sys.path != original_path:
        raise RuntimeError(filename + ' changed sys.path')
    if 'typing' in sys.modules:
        raise RuntimeError(filename + ' preloaded typing')
    identity = module._identity if filename == 'analyze.py' else module.identity
    if Path(identity.__file__).resolve() != authority.resolve():
        raise RuntimeError('identity came from another file')
    if identity.__name__ in sys.modules:
        raise RuntimeError('loader leaked a named module cache entry')
    modules[filename] = (module, identity)
import unittest.mock
import asyncio
import typing
from typing import final
import sysconfig
if Path(typing.__file__).resolve() != (Path(sysconfig.get_path('stdlib')) / 'typing.py').resolve():
    raise RuntimeError('typing did not resolve to the standard library')
if sys.path != original_path:
    raise RuntimeError('global path changed after stdlib imports')
print(json.dumps(dict(typingFile=typing.__file__, stdlibTyping=True, finalAvailable=callable(final),
                     pathUnchanged=True, typingWasUncached=True,
                     rows=[dict(file=name, identityFile=str(Path(identity.__file__).relative_to(here.parents[4])),
                                samples=identity.SAMPLES, hashes=identity.FIXTURE_SHA256)
                           for name, (module, identity) in modules.items()])))
'''


class ImportIsolation(unittest.TestCase):
    def probe(self, *order):
        flags = ['-O'] if sys.flags.optimize else []
        result = subprocess.run([sys.executable, *flags, '-c', PROBE, str(HERE), *order],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data['typingWasUncached'])
        self.assertTrue(data['stdlibTyping'])
        self.assertTrue(data['pathUnchanged'])
        self.assertTrue(data['finalAvailable'])
        # Reuse the independent full fixture's pins, never the module being checked.
        from test_analysis import producer_fixture
        rows = producer_fixture()['measurements']['perf']
        for loaded in data['rows']:
            self.assertEqual(loaded['identityFile'], 'tests/integration/rhwp/ownership-poc/native_d1_result.py')
            self.assertEqual(loaded['samples'], [row['sample'] for row in rows])
            self.assertEqual(loaded['hashes'], {row['sample']:row['sourceSha256'] for row in rows})
        return data

    def test_analyzer_then_stdlib(self):
        self.probe('analyze.py')

    def test_runner_then_stdlib(self):
        self.probe('run-current-perf.py')

    def test_analyzer_before_runner(self):
        self.probe('analyze.py', 'run-current-perf.py')

    def test_runner_before_analyzer(self):
        self.probe('run-current-perf.py', 'analyze.py')


if __name__ == '__main__':
    unittest.main()
