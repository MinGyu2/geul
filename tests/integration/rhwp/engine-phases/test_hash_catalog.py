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


    def test_reserved_tag_collision_is_refused_not_reinterpreted(self):
        record = [{'path': 'x.rs', 'sha256': 'a'*64}]
        for value in [{'note': {'sha256Catalog': record}}, {'sha256Catalog': record}, {'sha256Catalog': 'a'*64},
                      {'outer': [{'sha256Catalog': [], 'other': 1}]}]:
            with self.assertRaises(ValueError): catalog.encode(value)
        with self.assertRaises(ValueError): catalog.decode({'sha256Catalog': record, 'other': 1})

    def test_repeated_encoding_is_refused_and_repeated_decoding_is_stable(self):
        value = {'source': {'src/한글.rs': 'b'*64}, 'nested': {'deeper': {'a.rs': 'c'*64}}, 'empty': {}}
        encoded = catalog.encode(value)
        with self.assertRaises(ValueError): catalog.encode(encoded)
        self.assertEqual(catalog.decode(catalog.decode(encoded)), value)
        self.assertEqual(catalog.encode({}), {})

    def test_malformed_records_are_rejected(self):
        for rows in [[{'path': 'x'}], [{'path': 'x', 'sha256': 'a'*64, 'extra': 1}], [['x', 'a'*64]],
                     [{'path': 1, 'sha256': 'a'*64}], [{'path': 'x', 'sha256': 'A'*64}]]:
            with self.assertRaises(ValueError): catalog.decode({'sha256Catalog': rows})

    def test_utf8_paths_survive_file_round_trip(self):
        import json, tempfile
        value = {'files': {'samples/rnote/연구노트(화학).hwp': 'd'*64}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'x.json'
            path.write_text(json.dumps(catalog.encode(value), ensure_ascii=False), encoding='utf-8')
            self.assertEqual(catalog.load_json(path), value)


if __name__ == '__main__': unittest.main()
