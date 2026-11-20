"""Negative cases for the C09 saved and reopened movement checks."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("stage3c", Path(__file__).with_name("native-stage3-c.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class GroupMovementTest(unittest.TestCase):
    placement = {
        "horzRelTo": "Paper", "vertRelTo": "Paper", "horzAlign": "Left",
        "vertAlign": "Top", "treatAsChar": False, "horzOffset": 1500, "vertOffset": 500,
    }

    def test_refuses_stale_incorrect_and_rebased_saved_offsets(self):
        native.verify_group_placement({"props": self.placement}, self.placement)
        for change in ({"horzOffset": 500}, {"horzOffset": 1490}, {"horzRelTo": "Para"}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "saved group placement"):
                native.verify_group_placement({"props": {**self.placement, **change}}, self.placement)

    def test_refuses_reopen_at_original_position_at_non_default_zoom(self):
        published = {"x": 20.0, "y": 6.7}
        native.verify_group_origin({"left": 30, "top": 10.05}, published, 1.5, "reopened")
        with self.assertRaisesRegex(ValueError, "reopened: horizontal origin"):
            native.verify_group_origin({"left": 10.05, "top": 10.05}, published, 1.5, "reopened")
