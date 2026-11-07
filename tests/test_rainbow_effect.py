"""
Unit tests for Dynamic Rainbow (Spectrum Orbit) Effect
"""

import unittest
from core.models import EffectConfig, AnimationType
from core.effects.rainbow import render_rainbow
from core.effects import render_animation_frame


class TestRainbowEffect(unittest.TestCase):

    def test_rainbow_frame_length(self):
        """Frame buffer must match count * 3 bytes for all segment lengths."""
        for count in [10, 45, 60]:
            eff = EffectConfig(
                animation=AnimationType.RAINBOW,
                duration=2.0,
                speed=1.0,
                reverse=False
            )
            buf = render_rainbow(eff, frame=0, elapsed=0.0, count=count)
            self.assertEqual(len(buf), count * 3)

    def test_rainbow_spectrum_distribution_at_zero(self):
        """At elapsed = 0, LED 0 should be pure Red, and subsequent positions should match rainbow progression."""
        count = 50
        eff = EffectConfig(
            animation=AnimationType.RAINBOW,
            duration=2.0,
            speed=1.0,
            reverse=False
        )
        buf = render_rainbow(eff, frame=0, elapsed=0.0, count=count)

        # LED 0 is pure Red (255, 0, 0)
        self.assertEqual(buf[0], 255)  # R
        self.assertEqual(buf[1], 0)    # G
        self.assertEqual(buf[2], 0)    # B

        # LED 30 (pos = 0.60) is Aqua / Cyan
        idx_30 = 30
        self.assertEqual(buf[idx_30 * 3 + 0], 0)    # R
        self.assertEqual(buf[idx_30 * 3 + 1], 220)  # G
        self.assertEqual(buf[idx_30 * 3 + 2], 220)  # B

        # LED 37 (pos = 0.74) is Blue
        idx_37 = 37
        self.assertEqual(buf[idx_37 * 3 + 0], 0)    # R
        self.assertEqual(buf[idx_37 * 3 + 1], 30)   # G
        self.assertEqual(buf[idx_37 * 3 + 2], 240)  # B

    def test_rainbow_rotation_over_time(self):
        """After full cycle elapsed, LED 0 returns to pure Red; intermediate frames shift colors."""
        count = 50
        eff = EffectConfig(
            animation=AnimationType.RAINBOW,
            duration=2.0,
            speed=1.0,
            reverse=False
        )
        buf_half = render_rainbow(eff, frame=50, elapsed=1.0, count=count)
        buf_full = render_rainbow(eff, frame=100, elapsed=2.0, count=count)

        # At full cycle, LED 0 is back to Red (255, 0, 0)
        self.assertEqual(buf_full[0], 255)
        self.assertEqual(buf_full[1], 0)
        self.assertEqual(buf_full[2], 0)

        # Halfway cycle rotated spectrum
        self.assertNotEqual(bytes(buf_half), bytes(buf_full))

    def test_rainbow_reverse_direction(self):
        """Reverse (CCW) rotates spectrum in opposite direction."""
        count = 50
        eff_cw = EffectConfig(animation=AnimationType.RAINBOW, duration=2.0, speed=1.0, reverse=False)
        eff_ccw = EffectConfig(animation=AnimationType.RAINBOW, duration=2.0, speed=1.0, reverse=True)

        buf_cw = render_rainbow(eff_cw, frame=25, elapsed=0.5, count=count)
        buf_ccw = render_rainbow(eff_ccw, frame=25, elapsed=0.5, count=count)

        # LED 10 in CW should match LED (count - 10) in CCW at opposite phase
        self.assertNotEqual(bytes(buf_cw), bytes(buf_ccw))

    def test_render_animation_frame_dispatch(self):
        """EFFECT_REGISTRY dispatches AnimationType.RAINBOW to render_rainbow."""
        eff = EffectConfig(animation=AnimationType.RAINBOW, duration=2.0, speed=1.0)
        buf = render_animation_frame(eff, frame=0, elapsed=0.0, count=45)
        self.assertEqual(len(buf), 45 * 3)
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[1], 0)
        self.assertEqual(buf[2], 0)


if __name__ == "__main__":
    unittest.main()
