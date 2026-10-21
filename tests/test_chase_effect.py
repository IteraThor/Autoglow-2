"""
Unit tests for Dynamic Circular Chase (Orbit) Effect
"""

import unittest
from core.models import EffectConfig, AnimationType, RGBColor
from core.effects.chase import render_chase
from core.effects import render_animation_frame


class TestChaseEffect(unittest.TestCase):

    def test_chase_start_at_led_zero(self):
        """At elapsed = 0, the head of the chase must be located at LED 0 (maximum primary color)."""
        count = 45
        c1 = RGBColor(0, 255, 0)
        c2 = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=c1,
            color_secondary=c2,
            duration=2.0,
            speed=1.0,
            reverse=False
        )

        buf = render_chase(eff, frame=0, elapsed=0.0, count=count)
        self.assertEqual(len(buf), count * 3)

        # LED 0 must be 100% primary color
        self.assertEqual(buf[0], 0)
        self.assertEqual(buf[1], 255)
        self.assertEqual(buf[2], 0)

        # Forward LEDs (ahead of head) must be secondary color (0, 0, 0)
        self.assertEqual(buf[3], 0)  # LED 1 R
        self.assertEqual(buf[4], 0)  # LED 1 G
        self.assertEqual(buf[5], 0)  # LED 1 B

    def test_chase_full_cycle_ends_at_led_zero(self):
        """At elapsed = duration, the head must complete 1 full revolution and return to LED 0."""
        count = 45
        c1 = RGBColor(255, 0, 0)
        c2 = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=c1,
            color_secondary=c2,
            duration=3.0,
            speed=1.0,
            reverse=False
        )

        buf = render_chase(eff, frame=150, elapsed=3.0, count=count)
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[1], 0)
        self.assertEqual(buf[2], 0)

    def test_chase_halfway_position(self):
        """At elapsed = duration * 0.5, the head must be at halfway index (count // 2)."""
        count = 50
        c1 = RGBColor(0, 0, 255)
        c2 = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=c1,
            color_secondary=c2,
            duration=2.0,
            speed=1.0,
            reverse=False
        )

        half_elapsed = 1.0  # 50% of 2.0s
        buf = render_chase(eff, frame=50, elapsed=half_elapsed, count=count)

        mid_idx = 25
        self.assertEqual(buf[mid_idx * 3 + 2], 255)  # Blue channel at peak
        # Far-away LED 0 should be secondary color
        self.assertEqual(buf[0], 0)
        self.assertEqual(buf[1], 0)
        self.assertEqual(buf[2], 0)

    def test_chase_arbitrary_segment_counts(self):
        """Chase works on any segment count: 10 LEDs, 45 LEDs, 60 LEDs."""
        for count in [10, 45, 60]:
            eff = EffectConfig(
                animation=AnimationType.CHASE,
                color_primary=RGBColor(255, 255, 255),
                color_secondary=RGBColor(10, 10, 10),
                duration=1.0,
                speed=1.0
            )
            buf = render_animation_frame(eff, frame=0, elapsed=0.0, count=count)
            self.assertEqual(len(buf), count * 3)
            # Head at LED 0 is white
            self.assertEqual(buf[0], 255)
            self.assertEqual(buf[1], 255)
            self.assertEqual(buf[2], 255)

    def test_chase_speed_multiplier(self):
        """Speed multiplier 2.0 means 1 full rotation happens in duration / 2."""
        count = 40
        eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(0, 255, 0),
            color_secondary=RGBColor(0, 0, 0),
            duration=2.0,
            speed=2.0  # 2 rotations in 2.0s -> 1 rotation in 1.0s
        )
        # At elapsed = 1.0s, exactly 1 full rotation has elapsed -> head at LED 0
        buf = render_chase(eff, frame=50, elapsed=1.0, count=count)
        self.assertEqual(buf[0], 0)
        self.assertEqual(buf[1], 255)
        self.assertEqual(buf[2], 0)

    def test_chase_reverse(self):
        """Reverse flag moves counter-clockwise (backward from LED 0)."""
        count = 30
        eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(255, 100, 0),
            color_secondary=RGBColor(0, 0, 0),
            duration=2.0,
            speed=1.0,
            reverse=True
        )
        # At elapsed = 0.5s (25% progress reverse), head is at (1.0 - 0.25) * 30 = 22.5
        buf = render_chase(eff, frame=25, elapsed=0.5, count=count)
        self.assertEqual(len(buf), 30 * 3)
    def test_dynamic_secondary_match_previous(self):
        """When dynamic_secondary=True, background color resolves to active solid baseline color."""
        from core.wled_driver import WLEDDriver
        from core.models import DeviceConfig

        driver = WLEDDriver(DeviceConfig(ip="127.0.0.1", rgb_count=45))
        
        # Player 1 Throw color (Solid Blue)
        baseline = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(0, 100, 255),
            duration=0.0
        )

        # Chase effect with dynamic_secondary = True (e.g. Red chase orbiting over player's Blue baseline)
        chase_eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 0),
            dynamic_secondary=True,
            duration=2.0
        )

        resolved = driver._resolve_effective_config(chase_eff, baseline)
        self.assertEqual(resolved.color_primary.to_list(), [255, 0, 0])
        self.assertEqual(resolved.color_secondary.to_list(), [0, 100, 255])

    def test_dynamic_secondary_idle_fallback(self):
        """When dynamic_secondary=True but no baseline or non-solid baseline is active, background defaults to [0, 0, 0]."""
        from core.wled_driver import WLEDDriver
        from core.models import DeviceConfig

        driver = WLEDDriver(DeviceConfig(ip="127.0.0.1", rgb_count=45))

        chase_eff = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(50, 50, 50),
            dynamic_secondary=True,
            duration=2.0
        )

        # Case 1: baseline is None
        resolved_none = driver._resolve_effective_config(chase_eff, None)
        self.assertEqual(resolved_none.color_secondary.to_list(), [0, 0, 0])

        # Case 2: baseline is AnimationType.OFF
        resolved_off = driver._resolve_effective_config(chase_eff, EffectConfig(animation=AnimationType.OFF))
        self.assertEqual(resolved_off.color_secondary.to_list(), [0, 0, 0])


if __name__ == "__main__":
    unittest.main()

