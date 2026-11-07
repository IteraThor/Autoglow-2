"""
Unit tests for Flash (Impact Flash / Multi-Pulse Strobe) Effect
"""

import unittest
from core.models import EffectConfig, AnimationType, RGBColor
from core.effects.flash import render_flash
from core.effects import render_animation_frame


class TestFlashEffect(unittest.TestCase):

    def test_flash_frame_length(self):
        """Frame buffer must match count * 3 bytes for all segment lengths."""
        for count in [10, 45, 60]:
            eff = EffectConfig(
                animation=AnimationType.FLASH,
                color_primary=RGBColor(255, 255, 255),
                color_secondary=RGBColor(0, 0, 0),
                duration=1.0,
                speed=1.0
            )
            buf = render_flash(eff, frame=0, elapsed=0.0, count=count)
            self.assertEqual(len(buf), count * 3)

    def test_flash_instant_attack_at_zero(self):
        """At t=0, all LEDs must be at 100% Primary Color (peak intensity)."""
        count = 45
        c_pri = RGBColor(255, 200, 0)
        c_sec = RGBColor(10, 20, 30)
        eff = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        buf = render_flash(eff, frame=0, elapsed=0.0, count=count)

        for i in range(count):
            self.assertEqual(buf[i * 3 + 0], 255)
            self.assertEqual(buf[i * 3 + 1], 200)
            self.assertEqual(buf[i * 3 + 2], 0)

    def test_flash_full_decay_at_duration_end(self):
        """At t=duration, all LEDs must have decayed to 100% Secondary Color."""
        count = 45
        c_pri = RGBColor(255, 255, 255)
        c_sec = RGBColor(0, 50, 100)
        eff = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        buf = render_flash(eff, frame=50, elapsed=1.0, count=count)

        for i in range(count):
            self.assertEqual(buf[i * 3 + 0], 0)
            self.assertEqual(buf[i * 3 + 1], 50)
            self.assertEqual(buf[i * 3 + 2], 100)

    def test_flash_exponential_decay_halfway(self):
        """Halfway through single cycle (t=0.5s), alpha is (0.5)^2.5 ≈ 0.1768, closer to secondary than primary."""
        count = 10
        c_pri = RGBColor(255, 0, 0)
        c_sec = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        buf = render_flash(eff, frame=25, elapsed=0.5, count=count)

        # Alpha ≈ 0.1768 * 255 ≈ 45
        self.assertLess(buf[0], 100)
        self.assertGreater(buf[0], 20)
        self.assertEqual(buf[1], 0)
        self.assertEqual(buf[2], 0)

    def test_flash_multi_pulse_cadence(self):
        """At speed=2.0 and duration=1.0s, pulse 2 starts fresh at t=0.5s with peak intensity."""
        count = 10
        c_pri = RGBColor(0, 255, 0)
        c_sec = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=2.0  # 2 pulses
        )
        # Pulse 1 peak at t=0.0
        buf_t0 = render_flash(eff, frame=0, elapsed=0.0, count=count)
        self.assertEqual(buf_t0[1], 255)

        # Pulse 2 peak at t=0.5
        buf_t05 = render_flash(eff, frame=25, elapsed=0.5, count=count)
        self.assertEqual(buf_t05[1], 255)

        # Pulse 2 decay at t=0.75
        buf_t075 = render_flash(eff, frame=37, elapsed=0.75, count=count)
        self.assertLess(buf_t075[1], 100)

        # Complete at t=1.0
        buf_t10 = render_flash(eff, frame=50, elapsed=1.0, count=count)
        self.assertEqual(buf_t10[1], 0)

    def test_flash_exact_count_independent_of_duration(self):
        """When speed=1.0 (1 flash) and duration=3.0s, there is exactly 1 pulse, not 3."""
        count = 10
        eff = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=RGBColor(255, 255, 255),
            color_secondary=RGBColor(0, 0, 0),
            duration=3.0,
            speed=1.0  # Exactly 1 flash
        )
        # Peak at t=0
        buf_0 = render_flash(eff, frame=0, elapsed=0.0, count=count)
        self.assertEqual(buf_0[0], 255)

        # Mid-decay at t=1.5
        buf_mid = render_flash(eff, frame=75, elapsed=1.5, count=count)
        self.assertLess(buf_mid[0], 100)

        # Finished at t=3.0
        buf_end = render_flash(eff, frame=150, elapsed=3.0, count=count)
        self.assertEqual(buf_end[0], 0)

    def test_render_animation_frame_dispatch(self):
        """EFFECT_REGISTRY dispatches AnimationType.FLASH to render_flash."""
        eff = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=RGBColor(255, 255, 255),
            color_secondary=RGBColor(0, 0, 0),
            duration=1.0,
            speed=1.0
        )
        buf = render_animation_frame(eff, frame=0, elapsed=0.0, count=45)
        self.assertEqual(len(buf), 45 * 3)
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[1], 255)
        self.assertEqual(buf[2], 255)


if __name__ == "__main__":
    unittest.main()
