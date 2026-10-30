import importlib.util
import json
import shutil
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('artifacts', Path(__file__).resolve().parents[1] / 'rhwp-artifacts.py')
a = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a)


class ProfilePublicationTests(unittest.TestCase):
    def test_release_postprocessing_is_explicit_and_debug_cannot_optimize(self):
        tools = {'cargo': '1.99.0', 'rustc': '1.99.0', 'wasm-bindgen': '0.2.127'}
        hashes = {name: '3' * 64 for name in a.ARTIFACTS}
        none = {'tool': 'none', 'version': None, 'flags': []}
        optimized = {'tool': 'wasm-opt', 'version': '117', 'flags': ['-O']}
        for profile in ['release', 'debug']:
            self.assertEqual(a.make_identity('1' * 40, profile, tools, '2' * 64, hashes, optimization=none)['optimization'], none)
        self.assertEqual(a.make_identity('1' * 40, 'release', tools, '2' * 64, hashes, optimization=optimized)['optimization'], optimized)
        with self.assertRaisesRegex(ValueError, 'optimization'):
            a.make_identity('1' * 40, 'debug', tools, '2' * 64, hashes, optimization=optimized)
        with self.assertRaisesRegex(ValueError, 'optimization'):
            a.make_identity('1' * 40, 'release', tools, '2' * 64, hashes, optimization={**optimized, 'flags': ['-O1']})

    def test_debug_publication_cannot_change_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'generated'
            source.mkdir()
            for name in a.ARTIFACTS:
                (source / name).write_text(name)
            tools = {'cargo': '1.99.0', 'rustc': '1.99.0', 'wasm-bindgen': '0.2.127'}
            hashes = {name: a.file_hash(source / name) for name in a.ARTIFACTS}
            release = a.make_identity('1' * 40, 'release', tools, '2' * 64, hashes)
            debug = a.make_identity('1' * 40, 'debug', tools, '2' * 64, hashes)
            a.publish_generation(source, root / 'public', release, root)
            a.publish_generation(source, root / 'public', debug, root)
            self.assertEqual(json.loads((root / 'public/RELEASE.json').read_text()), release)
            self.assertEqual(json.loads((root / 'public/DEBUG.json').read_text()), debug)
            self.assertEqual(json.loads((root / 'public/BUILD.json').read_text()), debug)
            a.verify_files(root / 'public/generations' / release['generation'], release)
            with self.assertRaisesRegex(ValueError, 'cannot embed Debug'):
                a.verify_product(root / 'public', 'release')
            self.assertEqual(a.verify_product(root / 'public', 'debug'), debug)
            (root / 'public/BUILD.json').write_bytes(a.encoded(release))
            with self.assertRaisesRegex(ValueError, 'unselected'):
                a.verify_product(root / 'public', 'release')
            static = root / 'dist'
            shutil.copytree(root / 'public/generations' / release['generation'], static / 'generations' / release['generation'])
            (static / 'BUILD.json').write_bytes(a.encoded(release))
            self.assertEqual(a.verify_product(static, 'release'), release)
            (static / 'generations' / release['generation'] / 'rhwp_bg.wasm').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'invalid generated artifact'):
                a.verify_product(static, 'release')


if __name__ == '__main__':
    unittest.main()
