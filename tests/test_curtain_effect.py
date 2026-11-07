"""
Unit tests for Split Curtain (Dual Symmetrical Wipe) Effect
"""

import unittest
from core.models import EffectConfig, AnimationType, RGBColor
from core.effects.curtain import render_curtain
from core.effects import render_animation_frame


class TestCurtainEffect(unittest.TestCase):

    def test_curtain_frame_length(self):
        """Frame buffer must match count * 3 bytes for all segment lengths."""
        for count in [10, 45, 60]:
            eff = EffectConfig(
                animation=AnimationType.CURTAIN,
                color_primary=RGBColor(255, 0, 0),
                color_secondary=RGBColor(0, 0, 0),
                duration=1.0,
                speed=1.0
            )
            buf = render_curtain(eff, frame=0, elapsed=0.0, count=count)
            self.assertEqual(len(buf), count * 3)

    def test_curtain_bilateral_symmetry(self):
        """Left and Right halves of the ring must be perfectly symmetrical at any timestamp."""
        count = 50
        c_pri = RGBColor(255, 200, 0)
        c_sec = RGBColor(0, 50, 100)
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=2.0,
            speed=1.0
        )
        # Test across multiple progress points (opening and closing phases)
        for elapsed in [0.2, 0.5, 1.0, 1.5]:
            buf = render_curtain(eff, frame=int(elapsed * 50), elapsed=elapsed, count=count)
            for i in range(1, count // 2):
                opp = count - i
                # Pixel i must exactly equal pixel (count - i)
                self.assertEqual(buf[i * 3 + 0], buf[opp * 3 + 0], f"Red mismatch at i={i}, opp={opp} at t={elapsed}")
                self.assertEqual(buf[i * 3 + 1], buf[opp * 3 + 1], f"Green mismatch at i={i}, opp={opp} at t={elapsed}")
                self.assertEqual(buf[i * 3 + 2], buf[opp * 3 + 2], f"Blue mismatch at i={i}, opp={opp} at t={elapsed}")

    def test_curtain_opening_phase(self):
        """At 25% elapsed (t=0.5s of 2.0s duration), top is lit with primary color, bottom remains secondary."""
        count = 50
        c_pri = RGBColor(255, 0, 0)
        c_sec = RGBColor(0, 0, 255)
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=2.0,
            speed=1.0,
            reverse=False
        )
        buf = render_curtain(eff, frame=25, elapsed=0.5, count=count)

        # Top LED (LED 0) is fully Primary Red
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[2], 0)

        # Bottom LED (LED 25) is fully Secondary Blue
        self.assertEqual(buf[25 * 3 + 0], 0)
        self.assertEqual(buf[25 * 3 + 2], 255)

    def test_curtain_midpoint_full_fill(self):
        """At 50% elapsed (t=1.0s of 2.0s duration), entire ring is lit with primary color."""
        count = 50
        c_pri = RGBColor(0, 255, 0)
        c_sec = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=2.0,
            speed=1.0
        )
        buf = render_curtain(eff, frame=50, elapsed=1.0, count=count)

        for i in range(count):
            self.assertEqual(buf[i * 3 + 1], 255, f"LED {i} not fully lit at midpoint")

    def test_curtain_closing_phase(self):
        """At 75% elapsed (t=1.5s of 2.0s duration), top has cleared back to secondary, bottom still primary."""
        count = 50
        c_pri = RGBColor(255, 0, 0)
        c_sec = RGBColor(0, 0, 255)
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=2.0,
            speed=1.0,
            reverse=False
        )
        buf = render_curtain(eff, frame=75, elapsed=1.5, count=count)

        # Top LED (LED 0) has cleared to Secondary Blue
        self.assertEqual(buf[0], 0)
        self.assertEqual(buf[2], 255)

        # Bottom LED (LED 25) is still Primary Red
        self.assertEqual(buf[25 * 3 + 0], 255)
        self.assertEqual(buf[25 * 3 + 2], 0)

    def test_curtain_full_cycle_completion(self):
        """At 100% elapsed (t=2.0s of 2.0s duration), all LEDs have cleanly returned to secondary color."""
        count = 50
        c_pri = RGBColor(255, 255, 255)
        c_sec = RGBColor(10, 20, 30)
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=2.0,
            speed=1.0
        )
        buf = render_curtain(eff, frame=100, elapsed=2.0, count=count)

        for i in range(count):
            self.assertEqual(buf[i * 3 + 0], 10)
            self.assertEqual(buf[i * 3 + 1], 20)
            self.assertEqual(buf[i * 3 + 2], 30)

    def test_curtain_reverse_bottom_up(self):
        """When reverse=True, curtain opens from bottom (6 o'clock) up to top."""
        count = 50
        c_pri = RGBColor(255, 0, 0)
        c_sec = RGBColor(0, 0, 255)
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=2.0,
            speed=1.0,
            reverse=True
        )
        buf = render_curtain(eff, frame=25, elapsed=0.5, count=count)

        # Bottom LED (LED 25) is Primary Red
        self.assertEqual(buf[25 * 3 + 0], 255)
        self.assertEqual(buf[25 * 3 + 2], 0)

        # Top LED (LED 0) is Secondary Blue
        self.assertEqual(buf[0], 0)
        self.assertEqual(buf[2], 255)

    def test_render_animation_frame_dispatch(self):
        """EFFECT_REGISTRY dispatches AnimationType.CURTAIN to render_curtain."""
        eff = EffectConfig(
            animation=AnimationType.CURTAIN,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 0),
            duration=1.0,
            speed=1.0
        )
        buf = render_animation_frame(eff, frame=25, elapsed=0.5, count=50)
        self.assertEqual(len(buf), 50 * 3)
        self.assertEqual(buf[0], 255)


if __name__ == "__main__":
    unittest.main()
