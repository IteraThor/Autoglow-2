import unittest
from unittest import mock

from core import studio_darts


class DartWatcherTest(unittest.TestCase):
    def test_new_throws_are_noted_once_with_the_report_time(self):
        w = studio_darts.DartWatcher()
        throw = {"segment": {"name": "T20", "number": 20, "multiplier": 3}, "coords": {"x": 0.01, "y": 0.6}}
        with mock.patch("time.time", return_value=1000.0):
            w.note_state({"throws": [throw]}, 999.5)
            w.note_state({"throws": [throw]}, 999.9)          # same visit, nothing new
            w.note_state({"throws": [throw, {"segment": {"name": "Miss"}}]}, 1000.0)
        self.assertEqual([(d["t"], d["x"], d["y"]) for d in w.darts], [(999.5, 0.01, 0.6), (1000.0, None, None)])

    def test_board_manager_format(self):
        # As recorded from the Board Manager's event socket (2026-10-31)
        w = studio_darts.DartWatcher()
        throws = [{"bed": "Triple", "bouncer": False, "coordsX": -0.5712, "coordsY": -0.127, "failed": False,
                   "multiplier": 3, "segmentName": "T16", "segmentNumber": 16},
                  {"bouncer": True, "coordsX": 0.1, "coordsY": 0.2, "segmentName": "S5"}]
        with mock.patch("time.time", return_value=10.0):
            w.note_state({"throws": throws}, 10.0)
        self.assertEqual([(d["x"], d["y"], d["label"]) for d in w.darts], [(-0.5712, -0.127, "T16"), (None, None, "S5")])

    def test_pulled_darts_start_a_new_visit(self):
        w = studio_darts.DartWatcher()
        throw = {"coords": {"x": 0.1, "y": 0.2}}
        with mock.patch("time.time", return_value=50.0):
            w.note_state({"throws": [throw, throw]}, 49.0)
            w.note_state({"throws": []}, 49.5)
            w.note_state({"throws": [throw]}, 50.0)
        self.assertEqual(len(w.darts), 3)

    def test_old_darts_are_dropped(self):
        w = studio_darts.DartWatcher()
        with mock.patch("time.time", return_value=100.0):
            w.note_state({"throws": [{"coords": {"x": 0, "y": 0}}]}, 100.0)
        with mock.patch("time.time", return_value=100.0 + studio_darts.KEEP_SECONDS + 1):
            self.assertEqual(w.recent(), [])


if __name__ == "__main__":
    unittest.main()
