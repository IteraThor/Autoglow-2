"""
Unit tests for Dynamic Pastel Rainbow (Aurora Rainbow) Effect
"""

import unittest
from core.models import EffectConfig, AnimationType
from core.effects.pastel_rainbow import render_pastel_rainbow
from core.effects import render_animation_frame


class TestPastelRainbowEffect(unittest.TestCase):

    def test_pastel_rainbow_frame_length(self):
        """Frame buffer must match count * 3 bytes for all segment lengths."""
        for count in [10, 30, 45, 60]:
            eff = EffectConfig(
                animation=AnimationType.PASTEL_RAINBOW,
                duration=2.0,
                speed=1.0,
                reverse=False
            )
            buf = render_pastel_rainbow(eff, frame=0, elapsed=0.0, count=count)
            self.assertEqual(len(buf), count * 3)

    def test_pastel_rainbow_distribution_at_zero(self):
        """At elapsed = 0, LED 0 is Pastel Coral and halfway LED is Ice Blue."""
        count = 40
        eff = EffectConfig(
            animation=AnimationType.PASTEL_RAINBOW,
            duration=2.0,
            speed=1.0,
            reverse=False
        )
        buf = render_pastel_rainbow(eff, frame=0, elapsed=0.0, count=count)

        # LED 0 at pos 0.0 is Pastel Coral (255, 35, 20)
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[1], 35)
        self.assertEqual(buf[2], 20)

        # LED 20 at pos 0.5 is Ice Aqua (5, 185, 255)
        mid_idx = 20
        self.assertEqual(buf[mid_idx * 3 + 0], 5)
        self.assertEqual(buf[mid_idx * 3 + 1], 185)
        self.assertEqual(buf[mid_idx * 3 + 2], 255)

    def test_pastel_rainbow_rotation_over_time(self):
        """Full cycle returns to initial state; intermediate frames shift colors."""
        count = 40
        eff = EffectConfig(
            animation=AnimationType.PASTEL_RAINBOW,
            duration=2.0,
            speed=1.0,
            reverse=False
        )
        buf_0 = render_pastel_rainbow(eff, frame=0, elapsed=0.0, count=count)
        buf_half = render_pastel_rainbow(eff, frame=50, elapsed=1.0, count=count)
        buf_full = render_pastel_rainbow(eff, frame=100, elapsed=2.0, count=count)

        self.assertNotEqual(bytes(buf_0), bytes(buf_half))
        self.assertEqual(buf_full[0], 255)
        self.assertEqual(buf_full[1], 35)
        self.assertEqual(buf_full[2], 20)

    def test_pastel_rainbow_reverse_direction(self):
        """Reverse (CCW) rotates spectrum in opposite direction."""
        count = 40
        eff_cw = EffectConfig(animation=AnimationType.PASTEL_RAINBOW, duration=2.0, speed=1.0, reverse=False)
        eff_ccw = EffectConfig(animation=AnimationType.PASTEL_RAINBOW, duration=2.0, speed=1.0, reverse=True)

        buf_cw = render_pastel_rainbow(eff_cw, frame=25, elapsed=0.5, count=count)
        buf_ccw = render_pastel_rainbow(eff_ccw, frame=25, elapsed=0.5, count=count)

        self.assertNotEqual(bytes(buf_cw), bytes(buf_ccw))

    def test_pastel_rainbow_brightness_scaling(self):
        """Brightness scales the RGB channels linearly."""
        eff = EffectConfig(
            animation=AnimationType.PASTEL_RAINBOW,
            duration=2.0,
            speed=1.0,
            brightness=50
        )
        buf = render_pastel_rainbow(eff, frame=0, elapsed=0.0, count=10)
        # LED 0 expected ~ (255 * 0.5 = 127, 35 * 0.5 = 17, 20 * 0.5 = 10)
        self.assertAlmostEqual(buf[0], 127, delta=2)
        self.assertAlmostEqual(buf[1], 17, delta=2)
        self.assertAlmostEqual(buf[2], 10, delta=2)

    def test_render_animation_frame_dispatch(self):
        """EFFECT_REGISTRY dispatches AnimationType.PASTEL_RAINBOW to render_pastel_rainbow."""
        eff = EffectConfig(animation=AnimationType.PASTEL_RAINBOW, duration=2.0, speed=1.0)
        buf = render_animation_frame(eff, frame=0, elapsed=0.0, count=30)
        self.assertEqual(len(buf), 30 * 3)
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[1], 35)
        self.assertEqual(buf[2], 20)


if __name__ == "__main__":
    unittest.main()
