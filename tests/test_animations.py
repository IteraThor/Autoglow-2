import unittest
from core.models import EffectConfig, AnimationType, RGBColor
from core.animations import render_animation_frame


class TestAnimations(unittest.TestCase):

    def test_solid_animation(self):
        effect = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 128, 0),
            speed=1.0,
            duration=2.0
        )
        buf = render_animation_frame(effect, frame=0, elapsed=0.5, count=10)
        self.assertEqual(len(buf), 30)
        for i in range(10):
            self.assertEqual(buf[i * 3 + 0], 255)
            self.assertEqual(buf[i * 3 + 1], 128)
            self.assertEqual(buf[i * 3 + 2], 0)

    def test_chase_animation(self):
        effect = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(0, 255, 0),
            speed=1.0,
            duration=3.0,
            reverse=False
        )
        buf = render_animation_frame(effect, frame=0, elapsed=0.0, count=15)
        self.assertEqual(len(buf), 45)
        # Lead pixel (0) should have primary color
        self.assertEqual(buf[0], 0)
        self.assertEqual(buf[1], 255)
        self.assertEqual(buf[2], 0)

    def test_chase_reverse(self):
        effect = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(0, 0, 255),
            speed=1.0,
            duration=3.0,
            reverse=True
        )
        # At elapsed = 0.0, head is at LED 0
        buf0 = render_animation_frame(effect, frame=0, elapsed=0.0, count=15)
        self.assertEqual(len(buf0), 45)
        self.assertEqual(buf0[0], 0)
        self.assertEqual(buf0[1], 0)
        self.assertEqual(buf0[2], 255)

    def test_rainbow_animation(self):
        effect = EffectConfig(
            animation=AnimationType.RAINBOW,
            speed=1.0,
            duration=4.0
        )
        buf = render_animation_frame(effect, frame=10, elapsed=1.0, count=20)
        self.assertEqual(len(buf), 60)
        # Ensure all pixels have valid 0..255 values
        for val in buf:
            self.assertGreaterEqual(val, 0)
            self.assertLessEqual(val, 255)

    def test_flash_animation(self):
        effect = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=RGBColor(255, 255, 255),
            color_secondary=RGBColor(0, 0, 0),
            speed=1.0,
            duration=1.0
        )
        # At elapsed = 0.0 -> peak primary color (flash peak)
        buf_on = render_animation_frame(effect, frame=0, elapsed=0.0, count=5)
        self.assertEqual(buf_on[0], 255)
        self.assertEqual(buf_on[1], 255)
        self.assertEqual(buf_on[2], 255)

        # At elapsed = 1.0 -> fully decayed to secondary color (0, 0, 0)
        buf_off = render_animation_frame(effect, frame=50, elapsed=1.0, count=5)
        self.assertEqual(buf_off[0], 0)
        self.assertEqual(buf_off[1], 0)
        self.assertEqual(buf_off[2], 0)

    def test_pulse_animation(self):
        effect = EffectConfig(
            animation=AnimationType.PULSE,
            color_primary=RGBColor(200, 0, 0),
            color_secondary=RGBColor(0, 0, 100),
            speed=1.0,
            duration=2.0
        )
        buf = render_animation_frame(effect, frame=0, elapsed=0.0, count=8)
        self.assertEqual(len(buf), 24)
        for i in range(8):
            # RGB values should be within the bounds of c1 and c2
            self.assertGreaterEqual(buf[i * 3 + 0], 0)
            self.assertLessEqual(buf[i * 3 + 0], 200)

    def test_wipe_animation(self):
        effect = EffectConfig(
            animation=AnimationType.WIPE,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 255),
            speed=1.0,
            duration=2.0
        )
        buf = render_animation_frame(effect, frame=0, elapsed=0.5, count=10)
        self.assertEqual(len(buf), 30)

    def test_breathe_animation(self):
        effect = EffectConfig(
            animation=AnimationType.BREATHE,
            color_primary=RGBColor(100, 200, 50),
            speed=1.0,
            duration=2.0
        )
        buf = render_animation_frame(effect, frame=0, elapsed=0.0, count=5)
        self.assertEqual(len(buf), 15)

    def test_scan_animation(self):
        effect = EffectConfig(
            animation=AnimationType.SCAN,
            color_primary=RGBColor(255, 100, 0),
            speed=1.0,
            duration=2.0
        )
        buf = render_animation_frame(effect, frame=5, elapsed=0.2, count=10)
        self.assertEqual(len(buf), 30)

    def test_comet_animation(self):
        effect = EffectConfig(
            animation=AnimationType.COMET,
            color_primary=RGBColor(0, 200, 255),
            speed=1.0,
            duration=2.0
        )
        buf = render_animation_frame(effect, frame=10, elapsed=0.5, count=15)
        self.assertEqual(len(buf), 45)

    def test_blend_frames(self):
        from core.animations import blend_frames
        buf1 = bytearray([255, 0, 0, 255, 0, 0])
        buf2 = bytearray([0, 255, 0, 0, 255, 0])
        blended = blend_frames(buf1, buf2, factor=0.5)
        self.assertEqual(blended[0], 127)
        self.assertEqual(blended[1], 127)
        self.assertEqual(blended[2], 0)

    def test_empty_or_zero_count(self):
        effect = EffectConfig(animation=AnimationType.SOLID)
        buf_zero = render_animation_frame(effect, frame=0, elapsed=0.0, count=0)
        self.assertEqual(len(buf_zero), 0)
        buf_neg = render_animation_frame(effect, frame=0, elapsed=0.0, count=-5)
        self.assertEqual(len(buf_neg), 0)


if __name__ == '__main__':
    unittest.main()
