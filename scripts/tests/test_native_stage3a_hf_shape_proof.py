"""Regression checks for HWPX header-shape section preservation evidence."""

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
HARNESS_PATH = ROOT / "scripts/tests/native-stage3a-p5.py"
SPEC = importlib.util.spec_from_file_location("native_stage3a_p5", HARNESS_PATH)
HARNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HARNESS)


def section_xml(*, offset, comment="keep", instruction="stable", tail="target-tail",
                sibling="stable", nested_position="0"):
    return f'''<hp:section xmlns:hp="urn:hwpml">
      <!--{comment}--><?keep {instruction}?>
      <hp:rect id="1926588463" instid="852846640">
        <hp:pos horzOffset="{offset}" vertOffset="0"/>
        <hp:offset x="{offset}" y="0"/>
        <hp:renderingInfo><hp:transMatrix e3="{offset}" e6="0"/></hp:renderingInfo>
        <hp:drawText><hp:nested><hp:pos horzOffset="{nested_position}" vertOffset="0"/></hp:nested></hp:drawText>
      </hp:rect>{tail}<hp:sibling value="{sibling}"/>
    </hp:section>'''.encode()


def tree(data):
    return HARNESS.parse_hwpx_xml_preserving_events(data)


class HeaderShapeTreeProofTests(unittest.TestCase):
    def test_accepts_only_target_position_changes(self):
        self.assertTrue(HARNESS.hwpx_header_shape_tree_matches(
            tree(section_xml(offset=0)), tree(section_xml(offset=120)), 1926588463,
        ))

    def test_rejects_changed_comments_processing_instructions_and_mixed_content(self):
        original = section_xml(offset=0)
        mutations = [
            section_xml(offset=120, comment="changed"),
            section_xml(offset=120, instruction="changed"),
            section_xml(offset=120, tail="changed-tail"),
            section_xml(offset=120, sibling="changed"),
            section_xml(offset=120, nested_position="120"),
        ]
        for mutated in mutations:
            with self.subTest(mutated=mutated):
                self.assertFalse(HARNESS.hwpx_header_shape_tree_matches(
                    tree(original), tree(mutated), 1926588463,
                ))


if __name__ == "__main__":
    unittest.main()
