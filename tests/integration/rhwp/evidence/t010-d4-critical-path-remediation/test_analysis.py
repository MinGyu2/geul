import unittest
from analyze import stats, union_ms


class IntervalContract(unittest.TestCase):
    def test_nearest_rank_keeps_signed_anomalies(self):
        self.assertEqual(stats([-1, 0, 1])['min'], -1)
        self.assertEqual(stats(list(range(30)))['p95'], 28)

    def test_nested_and_overlapping_intervals_are_counted_once(self):
        self.assertEqual(union_ms([(0, 10), (2, 5), (8, 12), (20, 25)], 30), 17)

    def test_clip_only_for_measured_overlap_not_original_timestamps(self):
        spans = [(-1, 4), (9, 15)]
        self.assertEqual(union_ms(spans, 10), 5)
        self.assertEqual(spans, [(-1, 4), (9, 15)])


if __name__ == '__main__':
    unittest.main()
