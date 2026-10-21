"""
Unit tests for Heartbeat (Physiological Cardiac Double-Pulse) Effect
"""

import unittest
from core.models import EffectConfig, AnimationType, RGBColor
from core.effects.heartbeat import render_heartbeat
from core.effects import render_animation_frame


class TestHeartbeatEffect(unittest.TestCase):

    def test_heartbeat_frame_length(self):
        """Frame buffer must match count * 3 bytes for various segment lengths."""
        for count in [0, 10, 45, 60, 120]:
            eff = EffectConfig(
                animation=AnimationType.HEARTBEAT,
                color_primary=RGBColor(255, 0, 0),
                color_secondary=RGBColor(0, 0, 0),
                duration=1.0,
                speed=1.0
            )
            buf = render_heartbeat(eff, frame=0, elapsed=0.0, count=count)
            self.assertEqual(len(buf), count * 3)

    def test_heartbeat_first_pulse_lub_amplitude(self):
        """At peak of pulse 1 (p ~ 0.07), amplitude alpha should be ~65% of primary color."""
        count = 30
        c_pri = RGBColor(200, 100, 50)
        c_sec = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        # At elapsed = 0.07s (duration=1.0, speed=1.0), p = 0.07 (peak of lub: sin(pi/2)^2 = 1.0 -> alpha = 0.65)
        buf = render_heartbeat(eff, frame=3, elapsed=0.07, count=count)

        expected_r = int(200 * 0.65)  # 130
        expected_g = int(100 * 0.65)  # 65
        expected_b = int(50 * 0.65)   # 32

        for i in range(count):
            self.assertAlmostEqual(buf[i * 3 + 0], expected_r, delta=2)
            self.assertAlmostEqual(buf[i * 3 + 1], expected_g, delta=2)
            self.assertAlmostEqual(buf[i * 3 + 2], expected_b, delta=2)

    def test_heartbeat_inter_beat_notch(self):
        """Between pulse 1 and pulse 2 (p = 0.17), alpha should be 0.0 (resting color)."""
        count = 20
        c_pri = RGBColor(255, 0, 0)
        c_sec = RGBColor(10, 20, 30)
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        buf = render_heartbeat(eff, frame=8, elapsed=0.17, count=count)

        for i in range(count):
            self.assertEqual(buf[i * 3 + 0], 10)
            self.assertEqual(buf[i * 3 + 1], 20)
            self.assertEqual(buf[i * 3 + 2], 30)

    def test_heartbeat_second_pulse_dub_amplitude(self):
        """At peak of pulse 2 (p ~ 0.29), amplitude alpha should be 100% of primary color."""
        count = 30
        c_pri = RGBColor(255, 30, 40)
        c_sec = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        # At elapsed = 0.29s (duration=1.0, speed=1.0), p = 0.29 (peak of DUB: (0.29-0.20)/0.18 = 0.5 -> sin(pi/2)^2 = 1.0)
        buf = render_heartbeat(eff, frame=14, elapsed=0.29, count=count)

        for i in range(count):
            self.assertEqual(buf[i * 3 + 0], 255)
            self.assertEqual(buf[i * 3 + 1], 30)
            self.assertEqual(buf[i * 3 + 2], 40)

    def test_heartbeat_diastole_resting_pause(self):
        """During the diastole rest phase (p >= 0.38), LEDs should rest at secondary color."""
        count = 25
        c_pri = RGBColor(255, 255, 255)
        c_sec = RGBColor(15, 5, 25)
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0
        )
        for elapsed in [0.45, 0.60, 0.85]:
            buf = render_heartbeat(eff, frame=30, elapsed=elapsed, count=count)
            for i in range(count):
                self.assertEqual(buf[i * 3 + 0], 15)
                self.assertEqual(buf[i * 3 + 1], 5)
                self.assertEqual(buf[i * 3 + 2], 25)

    def test_heartbeat_brightness_scaling(self):
        """Brightness scaling (e.g. 50%) should scale peak values proportionally."""
        count = 10
        c_pri = RGBColor(200, 100, 50)
        c_sec = RGBColor(0, 0, 0)
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=c_pri,
            color_secondary=c_sec,
            duration=1.0,
            speed=1.0,
            brightness=50
        )
        buf = render_heartbeat(eff, frame=14, elapsed=0.29, count=count)
        for i in range(count):
            self.assertEqual(buf[i * 3 + 0], 100)
            self.assertEqual(buf[i * 3 + 1], 50)
            self.assertEqual(buf[i * 3 + 2], 25)

    def test_heartbeat_dispatch_registry(self):
        """render_animation_frame must dispatch HEARTBEAT to render_heartbeat."""
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 0),
            duration=1.0,
            speed=1.0
        )
        buf = render_animation_frame(eff, frame=14, elapsed=0.29, count=15)
        self.assertEqual(len(buf), 45)
        # Should be peak 2 red
        self.assertEqual(buf[0], 255)
        self.assertEqual(buf[1], 0)
        self.assertEqual(buf[2], 0)

    def test_heartbeat_dynamic_secondary_inherits_baseline(self):
        """When dynamic_secondary=True and baseline is present, rest phase resolves to baseline color."""
        from core.wled_driver import WLEDDriver
        from core.models import DeviceConfig

        driver = WLEDDriver(DeviceConfig(ip="127.0.0.1", rgb_count=30))
        baseline = EffectConfig(
            animation=AnimationType.BREATHE,
            color_primary=RGBColor(0, 150, 255),
            duration=0.0
        )
        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 0),
            dynamic_secondary=True,
            duration=1.0,
            speed=1.0
        )
        resolved = driver._resolve_effective_config(eff, baseline)
        self.assertEqual(resolved.color_secondary.to_list(), [0, 150, 255])

        # Render during diastole rest phase (elapsed = 0.6s) -> LEDs must be at baseline Cyan, not black
        buf = render_heartbeat(resolved, frame=30, elapsed=0.6, count=30)
        for i in range(30):
            self.assertEqual(buf[i * 3 + 0], 0)
            self.assertEqual(buf[i * 3 + 1], 150)
            self.assertEqual(buf[i * 3 + 2], 255)

    def test_heartbeat_dynamic_secondary_inherits_channel_last_active_color(self):
        """When baseline is None (e.g. testing in UI), rest phase resolves to channel's last active color."""
        from core.wled_driver import WLEDDriver
        from core.models import DeviceConfig

        driver = WLEDDriver(DeviceConfig(ip="127.0.0.1", rgb_count=20))
        # Simulate channel having previous active color Yellow
        driver._segment_channels[0] = {
            "start_idx": 0,
            "stop_idx": 20,
            "baseline_effect": None,
            "transient_effect": None,
            "last_active_color": RGBColor(255, 200, 0)
        }

        eff = EffectConfig(
            animation=AnimationType.HEARTBEAT,
            color_primary=RGBColor(255, 0, 0),
            color_secondary=RGBColor(0, 0, 0),
            dynamic_secondary=True,
            duration=1.0,
            speed=1.0
        )
        resolved = driver._resolve_effective_config(eff, None, s_id=0)
        self.assertEqual(resolved.color_secondary.to_list(), [255, 200, 0])

        buf = render_heartbeat(resolved, frame=30, elapsed=0.6, count=20)
        for i in range(20):
            self.assertEqual(buf[i * 3 + 0], 255)
            self.assertEqual(buf[i * 3 + 1], 200)
            self.assertEqual(buf[i * 3 + 2], 0)


if __name__ == '__main__':
    unittest.main()
