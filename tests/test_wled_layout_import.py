"""
Re-running the setup guide on a real controller (BTF-WLED, layout saved 2026-11-02) must keep what AutoGlow
knows about its segments: data pins, the light strip's role and the hit-locator direction.
"""

import json
import os
import unittest

from core.models import SegmentConfig
from routes.wled_routes import _segments_from_wled

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "btf_wled_layout_2026-11-02.json")


class TestSegmentsFromWled(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE) as f:
            self.layout = json.load(f)

    def test_pins_types_and_roles_come_from_the_outputs(self):
        segs = _segments_from_wled(self.layout["seg"], self.layout["hw_ins"], [])
        self.assertEqual([s.gpio for s in segs], ["GPIO 16"] * 4 + ["GPIO 17", "GPIO 26"])
        self.assertEqual([s.type for s in segs], ["WS281x"] * 5 + ["PWM White"])
        self.assertEqual(segs[5].role, "white_illumination")
        self.assertEqual({s.role for s in segs[:5]}, {"dartboard_ring"})
        self.assertEqual([(s.start, s.length) for s in segs], [(0, 12), (12, 11), (23, 11), (34, 11), (45, 45), (90, 1)])

    def test_what_only_autoglow_knows_survives_a_rerun(self):
        before = _segments_from_wled(self.layout["seg"], self.layout["hw_ins"], [])
        before[4].clockwise = False
        before[0].locator = False
        before[4].role = "ambient"
        again = _segments_from_wled(self.layout["seg"], self.layout["hw_ins"], before)
        self.assertFalse(again[4].clockwise)
        self.assertFalse(again[0].locator)
        self.assertEqual(again[4].role, "ambient")
        self.assertTrue(again[1].clockwise and again[1].locator)

    def test_a_moved_segment_starts_fresh(self):
        before = [SegmentConfig(id=0, start=5, clockwise=False, locator=False)]
        again = _segments_from_wled(self.layout["seg"], self.layout["hw_ins"], before)
        self.assertTrue(again[0].clockwise)
        self.assertTrue(again[0].locator)

    def test_layout_without_outputs_keeps_old_pins(self):
        before = _segments_from_wled(self.layout["seg"], self.layout["hw_ins"], [])
        again = _segments_from_wled(self.layout["seg"], [], before)
        self.assertEqual(again[4].gpio, "GPIO 17")


if __name__ == "__main__":
    unittest.main()


class TestSavedControllerRecord(unittest.TestCase):
    """The 'Skip the guide' add path sends segments without pins or roles; loading the record completes them."""

    def test_pins_and_light_strip_role_are_completed_from_the_outputs(self):
        from core.models import DeviceConfig
        with open(FIXTURE) as f:
            layout = json.load(f)
        raw = {
            "ip": "192.168.2.215", "hw_ins": layout["hw_ins"],
            # what web/js/features/controllers.js deviceFromLive() sends
            "segments": [{"id": s["id"], "name": s["n"], "start": s["start"], "length": s["stop"] - s["start"], "offset": s["of"]}
                         for s in layout["seg"]],
        }
        dev = DeviceConfig.from_dict(raw)
        self.assertEqual([s.gpio for s in dev.segments], ["GPIO 16"] * 4 + ["GPIO 17", "GPIO 26"])
        self.assertEqual(dev.segments[5].role, "white_illumination")
        self.assertEqual(dev.segments[4].role, "dartboard_ring")

    def test_existing_pins_and_roles_are_kept(self):
        from core.models import DeviceConfig
        dev = DeviceConfig.from_dict({"hw_ins": [{"start": 0, "len": 10, "type": 22, "pin": [16]}],
                                      "segments": [{"id": 0, "start": 0, "length": 10, "gpio": "GPIO 5", "role": "ambient"}]})
        self.assertEqual((dev.segments[0].gpio, dev.segments[0].role), ("GPIO 5", "ambient"))
