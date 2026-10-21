"""
Unit tests for Hardware-Anchored Segment Identity and Reconciliation
"""

import unittest
from core.models import (
    ProfileConfig,
    EffectConfig,
    AnimationType,
    RGBColor,
    SegmentConfig
)


class TestSegmentReconciliation(unittest.TestCase):

    def setUp(self):
        self.ip = "192.168.2.214"
        self.profile = ProfileConfig.get_default_profile()

    def test_segment_hw_key_survives_index_shift(self):
        """
        Test scenario:
        Device originally had 4 segments:
        - Seg 0: WS281x on GPIO 33, start 0 (hw_key: 'gpio_33_ws281x_0')
        - Seg 1: Ambient on GPIO 25, start 45 (hw_key: 'gpio_25_ws281x_45')
        - Seg 2: Ring 2 on GPIO 26, start 60 (hw_key: 'gpio_26_ws281x_60')
        - Seg 3: PWM White on GPIO 16, start 75 (hw_key: 'gpio_16_pwm_75')

        Segments 1 and 2 are deleted on the controller.
        The PWM segment shifts down from Index 3 to Index 1.
        """
        # Save custom PWM settings under its hardware key
        pwm_hw_key = "gpio_16_pwm_75"
        self.profile.device_events[self.ip] = {
            "gpio_33_ws281x_0": {
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(0, 180, 255),
                    duration=0.0,
                    enabled=True
                )
            },
            pwm_hw_key: {
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(255, 255, 255),
                    brightness=75,
                    duration=0.0,
                    enabled=False  # Custom disabled for P1 on PWM
                ),
                "takeout": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(255, 255, 255),
                    brightness=20,
                    duration=0.0,
                    enabled=True
                )
            },
            # Old stale numerical index 1 which was previously the deleted ambient segment
            "1": {
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(255, 0, 255), # Magenta ambient
                    duration=0.0,
                    enabled=True
                )
            }
        }

        # The newly shifted PWM segment at Index 1 with its permanent hw_key
        shifted_pwm_seg = SegmentConfig(
            id=1,
            name="PWM White",
            type="PWM White",
            gpio="GPIO 16",
            start=75,
            length=1,
            role="white_illumination",
            hw_key=pwm_hw_key
        )

        # 1. Resolve player effect on shifted segment (passing hw_key)
        eff_player = self.profile.resolve_player_effect(
            player_name="Alex",
            player_index=0,
            ip=self.ip,
            seg_id=shifted_pwm_seg.id,
            hw_key=shifted_pwm_seg.hw_key
        )

        # Must resolve to the PWM hardware settings (brightness=75, enabled=False), NOT the stale magenta index 1!
        self.assertFalse(eff_player.enabled)
        self.assertEqual(eff_player.brightness, 75)

        # 2. Resolve takeout effect on shifted segment
        eff_takeout = self.profile.get_effect(
            event_key="takeout",
            ip=self.ip,
            seg_id=shifted_pwm_seg.id,
            hw_key=shifted_pwm_seg.hw_key
        )
        self.assertTrue(eff_takeout.enabled)
        self.assertEqual(eff_takeout.brightness, 20)

    def test_fallback_to_numeric_index_when_hw_key_not_stored(self):
        """Verify backward compatibility when configs only have numeric keys."""
        self.profile.device_events[self.ip] = {
            "0": {
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(0, 180, 255),
                    duration=0.0,
                    enabled=True
                )
            }
        }

        # Query without hardware key in legacy mode
        eff = self.profile.resolve_player_effect(
            player_name="Alex",
            player_index=0,
            ip=self.ip,
            seg_id=0,
            hw_key="unmatched_hw_key"
        )
        self.assertTrue(eff.enabled)
        self.assertEqual(eff.color_primary.to_list(), [0, 180, 255])


if __name__ == "__main__":
    unittest.main()
