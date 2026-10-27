import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('engine_phase_checksum_catalog', Path(__file__).with_name('hash_catalog.py'))
catalog = importlib.util.module_from_spec(spec); spec.loader.exec_module(catalog)


class HashCatalogTests(unittest.TestCase):
    def test_maps_round_trip_without_changing_measurements(self):
        value = {'source': {'src/wasm_api.rs': '1'*64, 'src/shaping.rs': 'a'*64},
                 'measurements': [{'ms': 43.15, 'status': 'PASS', 'hash': '2'*64}], 'empty': {}}
        encoded = catalog.encode(value)
        self.assertIn('sha256Catalog', encoded['source'])
        self.assertEqual(catalog.decode(encoded), value)
        self.assertEqual(encoded['measurements'], value['measurements'])

    def test_duplicate_and_invalid_checksums_are_rejected(self):
        for value in [{'sha256Catalog': [{'path': 'x', 'sha256': 'a'*64}]*2},
                      {'sha256Catalog': [{'path': 'x', 'sha256': 'not a digest'}]},
                      {'sha256Catalog': 'not a list'}]:
            with self.assertRaises(ValueError): catalog.decode(value)


if __name__ == '__main__': unittest.main()
