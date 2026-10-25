"""Current vs historical BoundedCache contract split (cache_contract_mapping.json), checked statically from source.

The historical suite stays byte-identical to the recorded one (its two failures remain reproducible); the current suite
is exactly the still-valid historical tests (verbatim) plus the three current-policy replacements (verbatim), and every
required behavior names a test that exists. unit.py must be told which suite to run.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MAPPING = json.loads((HERE / 'cache_contract_mapping.json').read_text())
HISTORICAL = HERE / MAPPING['historicalSuite']
CURRENT = HERE / MAPPING['currentSuite']
DISPOSITION = (HERE / MAPPING['replacementSource']).resolve()
COMPLETE_PATCH = ROOT / 'tests/integration/rhwp/evidence/t010-decoded-lease-contract-finalization/upstream-rhwp-decoded-lease-finalization-complete.patch'
# Recorded in ../evidence/t010-decoded-lease-readiness-closure/cache-contract/cache_contract-current-candidate.json (18 PASS / 2 FAIL).
HISTORICAL_SHA256 = '5abb3878eddf81603438599c060d1429ecd0189caa6c764223555b8fe1c50fc5'


def tests(source):
    """Ordered {name: text} of #[test] functions, each with its leading // comment lines, by brace matching."""
    found = {}
    for match in re.finditer(r'((?://[^\n]*\n)*)#\[test\]\n\s*fn (\w+)\(\) \{', source):
        depth = 0
        for end in range(source.index('{', match.end() - 1), len(source)):
            depth += {'{': 1, '}': -1}.get(source[end], 0)
            if depth == 0: break
        found[match.group(2)] = source[match.start():end + 1]
    return found


def bare(text):
    return text[text.index('#[test]'):]


class Suites(unittest.TestCase):
    def setUp(self):
        self.historical = tests(HISTORICAL.read_text())
        self.current = tests(CURRENT.read_text())
        self.replacements = [n for entry in MAPPING['superseded'].values() for n in entry['replacements']]

    def test_historical_suite_is_unchanged(self):
        self.assertEqual(hashlib.sha256(HISTORICAL.read_bytes()).hexdigest(), HISTORICAL_SHA256)
        self.assertEqual(sorted(self.historical), sorted(MAPPING['carried'] + list(MAPPING['superseded'])))

    def test_current_suite_is_exactly_carried_plus_replacements(self):
        self.assertEqual(list(self.current), MAPPING['carried'] + sorted(set(self.replacements), key=self.replacements.index))
        for name in MAPPING['superseded']:
            self.assertNotIn(name, self.current)

    def test_carried_tests_are_verbatim(self):
        for name in MAPPING['carried']:
            self.assertEqual(bare(self.current[name]), bare(self.historical[name]), name)

    def test_replacements_are_verbatim_from_the_disposition_contract(self):
        disposition = tests(DISPOSITION.read_text())
        self.assertEqual(sorted(disposition), sorted(set(self.replacements)))
        for name in disposition:
            self.assertEqual(self.current[name], disposition[name], name)

    def test_internal_test_list_matches_the_committed_candidate_source(self):
        patch = COMPLETE_PATCH.read_text()
        section = patch.split('diff --git a/src/renderer/surface_cache.rs b/src/renderer/surface_cache.rs\n', 1)[1].split('\ndiff --git ', 1)[0]
        source = '\n'.join(line[1:] for line in section.splitlines() if line.startswith('+') and not line.startswith('+++'))
        self.assertEqual(list(tests(source)), MAPPING['internalTests'])
        counts = MAPPING['expectedCurrentCounts']
        self.assertEqual((counts['internal'], counts['external']), (len(MAPPING['internalTests']), len(self.current)))
        self.assertEqual(counts['total'], counts['internal'] + counts['external'])

    def test_every_required_behavior_names_existing_current_tests(self):
        available = set(self.current) | set(MAPPING['internalTests'])
        for behavior, names in MAPPING['requiredBehaviors'].items():
            self.assertTrue(names, behavior)
            self.assertLessEqual(set(names), available, behavior)

    def test_unit_runner_requires_an_explicit_suite(self):
        with tempfile.TemporaryDirectory() as folder:
            run = subprocess.run([sys.executable, str(HERE / 'unit.py'), '--output', str(Path(folder) / 'x.json')], capture_output=True, text=True)
            both = subprocess.run([sys.executable, str(HERE / 'unit.py'), '--suite', 'current', '--contract', str(HISTORICAL),
                                   '--output', str(Path(folder) / 'y.json')], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn('--suite', run.stderr)
        self.assertEqual(both.returncode, 2)


if __name__ == '__main__':
    unittest.main()
