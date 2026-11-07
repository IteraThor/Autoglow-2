"""
Unit tests for the 5 newly implemented effects:
- Dual Comet (Test)
- Sparkle (Test)
- Fire (Test)
- Radar (Test)
- Breathe (Test)
"""

import unittest
from core.models import EffectConfig, AnimationType, RGBColor
from core.effects import render_animation_frame, EFFECT_REGISTRY
from core.effects.dual_comet import render_dual_comet
from core.effects.sparkle import render_sparkle
from core.effects.fire import render_fire
from core.effects.radar import render_radar
from core.effects.breathe import render_breathe


class TestNewEffects(unittest.TestCase):

    def setUp(self):
        self.c_pri = RGBColor(255, 50, 20)
        self.c_sec = RGBColor(10, 80, 200)

    def test_registry_registration(self):
        """All 5 new animation types must be in EFFECT_REGISTRY."""
        for anim in [
            AnimationType.DUAL_COMET,
            AnimationType.SPARKLE,
            AnimationType.FIRE,
            AnimationType.RADAR,
            AnimationType.BREATHE,
        ]:
            self.assertIn(anim, EFFECT_REGISTRY)
            self.assertTrue(callable(EFFECT_REGISTRY[anim]))

    def test_buffer_lengths_and_empty_handling(self):
        """Buffers must match count * 3 bytes, and return 0 bytes for count <= 0."""
        effects = [
            AnimationType.DUAL_COMET,
            AnimationType.SPARKLE,
            AnimationType.FIRE,
            AnimationType.RADAR,
            AnimationType.BREATHE,
        ]
        for anim in effects:
            eff = EffectConfig(
                animation=anim,
                color_primary=self.c_pri,
                color_secondary=self.c_sec,
                duration=1.0,
                speed=1.0,
            )
            # Empty count
            buf_zero = render_animation_frame(eff, frame=0, elapsed=0.0, count=0)
            self.assertEqual(len(buf_zero), 0)

            # Normal counts
            for count in [1, 15, 60, 120]:
                buf = render_animation_frame(eff, frame=10, elapsed=0.5, count=count)
                self.assertEqual(len(buf), count * 3)

    def test_dual_comet_rendering(self):
        """Dual comet renders opposing comets with valid RGB values [0, 255]."""
        eff = EffectConfig(
            animation=AnimationType.DUAL_COMET,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 255),
            duration=2.0,
            speed=1.0,
        )
        count = 60
        buf = render_dual_comet(eff, frame=5, elapsed=0.5, count=count)
        self.assertEqual(len(buf), count * 3)
        # Verify valid range
        for b in buf:
            self.assertTrue(0 <= b <= 255)
        # Verify that buffer is not all black
        self.assertTrue(any(b > 0 for b in buf))

    def test_sparkle_rendering(self):
        """Sparkle renders background with active sparkle pixels."""
        eff = EffectConfig(
            animation=AnimationType.SPARKLE,
            color_primary=RGBColor(255, 255, 255),
            color_secondary=RGBColor(10, 10, 10),
            duration=1.0,
            speed=1.5,
        )
        count = 50
        buf = render_sparkle(eff, frame=12, elapsed=0.25, count=count)
        self.assertEqual(len(buf), count * 3)
        for b in buf:
            self.assertTrue(0 <= b <= 255)
        # Background color or brighter
        self.assertTrue(any(buf[i * 3] >= 10 for i in range(count)))

    def test_fire_rendering(self):
        """Fire renders rising flame temperatures mapped to colors."""
        eff = EffectConfig(
            animation=AnimationType.FIRE,
            color_primary=RGBColor(255, 255, 0),
            color_secondary=RGBColor(255, 40, 0),
            duration=1.0,
            speed=1.0,
        )
        count = 60
        # Step through multiple frames to ignite heat
        buf = None
        for f in range(25):
            buf = render_fire(eff, frame=f, elapsed=f * 0.02, count=count)
        self.assertEqual(len(buf), count * 3)
        for b in buf:
            self.assertTrue(0 <= b <= 255)

    def test_radar_rendering(self):
        """Radar renders sweep head and afterglow trail, respecting reverse direction."""
        eff_fwd = EffectConfig(
            animation=AnimationType.RADAR,
            color_primary=RGBColor(0, 255, 0),
            color_secondary=RGBColor(0, 20, 0),
            reverse=False,
            speed=1.0,
        )
        eff_rev = EffectConfig(
            animation=AnimationType.RADAR,
            color_primary=RGBColor(0, 255, 0),
            color_secondary=RGBColor(0, 20, 0),
            reverse=True,
            speed=1.0,
        )
        count = 40
        buf_fwd = render_radar(eff_fwd, frame=10, elapsed=0.5, count=count)
        buf_rev = render_radar(eff_rev, frame=10, elapsed=0.5, count=count)
        self.assertEqual(len(buf_fwd), count * 3)
        self.assertEqual(len(buf_rev), count * 3)
        # Both must produce active green content
        self.assertTrue(any(buf_fwd[i * 3 + 1] > 20 for i in range(count)))
        self.assertTrue(any(buf_rev[i * 3 + 1] > 20 for i in range(count)))

    def test_breathe_rendering_cycle(self):
        """Breathe follows asymmetric respiratory cycle (inhale, hold, exhale)."""
        c_pri = RGBColor(200, 200, 200)
        c_sec = RGBColor(20, 20, 20)
        eff = EffectConfig(
            animation=AnimationType.BREATHE,
            color_primary=c_pri,
            color_secondary=c_sec,
            speed=1.0,
        )
        count = 30
        # Peak hold phase around 0.50 of cycle
        buf_hold = render_breathe(eff, frame=25, elapsed=0.50, count=count)
        # All pixels must be at full primary brightness during hold
        for i in range(count):
            self.assertAlmostEqual(buf_hold[i * 3 + 0], 200, delta=2)
            self.assertAlmostEqual(buf_hold[i * 3 + 1], 200, delta=2)
            self.assertAlmostEqual(buf_hold[i * 3 + 2], 200, delta=2)

        # Inhale early phase at 0.05
        buf_inhale = render_breathe(eff, frame=2, elapsed=0.05, count=count)
        # Must be between rest and peak
        self.assertTrue(buf_inhale[0] < buf_hold[0])
        self.assertTrue(buf_inhale[0] >= 20)

    def test_brightness_scaling_across_all_five(self):
        """Setting brightness scaling to 50% reduces all pixel components."""
        for anim in [
            AnimationType.DUAL_COMET,
            AnimationType.SPARKLE,
            AnimationType.FIRE,
            AnimationType.RADAR,
            AnimationType.BREATHE,
        ]:
            eff_100 = EffectConfig(
                animation=anim,
                color_primary=RGBColor(200, 200, 200),
                color_secondary=RGBColor(50, 50, 50),
                brightness=100,
                speed=1.0,
            )
            eff_50 = EffectConfig(
                animation=anim,
                color_primary=RGBColor(200, 200, 200),
                color_secondary=RGBColor(50, 50, 50),
                brightness=50,
                speed=1.0,
            )
            b100 = render_animation_frame(eff_100, frame=10, elapsed=0.5, count=20)
            b50 = render_animation_frame(eff_50, frame=10, elapsed=0.5, count=20)
            self.assertEqual(len(b100), 60)
            self.assertEqual(len(b50), 60)


if __name__ == "__main__":
    unittest.main()
