"""
Reading a controller's LED layout from WLED into AutoGlow's segments (core/wled_layout.py).
"""

import unittest

from core.models import DeviceConfig, SegmentConfig
from core.wled_layout import adopt_live_layout, segments_from_wled

HW = [{"pin": [16], "type": 22, "start": 0, "len": 45},
      {"pin": [17], "type": 22, "start": 45, "len": 45},
      {"pin": [26], "type": 41, "start": 90, "len": 1}]

# What the BTF-WLED controller had: leftover segments covering the same LEDs as earlier ones
LEFTOVERS = [
    {"id": 0, "n": "RGB1", "start": 0, "stop": 10},
    {"id": 1, "n": "RGB12", "start": 10, "stop": 45},
    {"id": 2, "n": "RGB strip 2", "start": 45, "stop": 90},
    {"id": 3, "n": "Light strip", "start": 90, "stop": 91},
    {"id": 4, "n": "RGB 2 Strip", "start": 45, "stop": 90},
    {"id": 5, "n": "Light strip", "start": 90, "stop": 91},
]


class TestSegmentsFromWled(unittest.TestCase):

    def test_leftover_segments_on_the_same_leds_are_skipped(self):
        segs = segments_from_wled(LEFTOVERS, HW, [])
        self.assertEqual([s.name for s in segs], ["RGB1", "RGB12", "RGB strip 2", "Light strip"])
        self.assertEqual([s.gpio for s in segs], ["GPIO 16", "GPIO 16", "GPIO 17", "GPIO 26"])
        self.assertEqual(segs[3].type, "PWM White")


class TestAdoptLiveLayout(unittest.TestCase):

    def test_takes_the_controllers_layout_and_keeps_what_only_autoglow_knows(self):
        dev = DeviceConfig(ip="192.168.2.215", hw_ins=HW, segments=[
            SegmentConfig(id=0, name="RGB1", start=0, length=10, clockwise=False),
            SegmentConfig(id=4, name="RGB 2 Strip", start=45, length=45)])
        info = {"online": True, "hw_ins": HW, "state": {"seg": [
            {"id": 0, "n": "RGB1", "start": 0, "stop": 45},
            {"id": 1, "n": "RGB strip 2", "start": 45, "stop": 90},
            {"id": 2, "n": "Light strip", "start": 90, "stop": 91}]}}
        self.assertTrue(adopt_live_layout(dev, info))
        self.assertEqual([(s.id, s.name, s.length) for s in dev.segments],
                         [(0, "RGB1", 45), (1, "RGB strip 2", 45), (2, "Light strip", 1)])
        self.assertFalse(dev.segments[0].clockwise, "the hit-locator direction stays")
        self.assertEqual((dev.rgb_count, dev.pwm_index), (45, 90))
        self.assertFalse(adopt_live_layout(dev, info), "nothing new the second time")

    def test_offline_or_empty_answers_change_nothing(self):
        dev = DeviceConfig(ip="192.168.2.215", segments=[SegmentConfig(id=0, name="Ring")])
        self.assertFalse(adopt_live_layout(dev, {"online": False}))
        self.assertFalse(adopt_live_layout(dev, {"online": True, "state": {"seg": []}}))
        self.assertEqual(dev.segments[0].name, "Ring")


if __name__ == "__main__":
    unittest.main()
