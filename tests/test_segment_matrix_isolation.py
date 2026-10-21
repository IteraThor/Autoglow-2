import unittest
from core.models import (
    ProfileConfig, EffectConfig, AnimationType, RGBColor
)


class TestSegmentMatrixIsolation(unittest.TestCase):
    def setUp(self):
        self.profile = ProfileConfig.get_default_profile()
        self.ip = "192.168.2.215"
        # Segment 0 (RGB strip): '180' is enabled
        self.profile.device_events[self.ip] = {
            "0": {
                "180": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(255, 200, 0),
                    duration=3.0,
                    enabled=True
                ),
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(0, 180, 255),
                    duration=0.0,
                    enabled=True
                )
            },
            "1": {
                # Segment 1 (PWM white): only 'bust' is enabled
                "bust": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(110, 110, 110),
                    duration=1.0,
                    enabled=True
                )
            }
        }
        # Global fallback has 180 enabled to test leakage
        self.profile.events["180"] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 200, 0),
            duration=3.0,
            enabled=True
        )

    def test_unconfigured_event_on_segment_does_not_leak_from_global_or_other_segment(self):
        """Querying '180' on Segment 1 should NOT return Segment 0's or global's '180'."""
        eff_seg0 = self.profile.get_effect("180", ip=self.ip, seg_id=0)
        self.assertIsNotNone(eff_seg0)
        self.assertTrue(eff_seg0.enabled)

        # Segment 1 does NOT have '180' configured
        eff_seg1 = self.profile.get_effect("180", ip=self.ip, seg_id=1, hw_key="gpio_25_pwm_45")
        self.assertIsNone(eff_seg1, "Unconfigured event on Segment 1 must return None, not leak from global/seg 0")

    def test_unconfigured_player_slot_on_segment_does_not_leak_from_global_or_other_segment(self):
        """Querying Player 1 on Segment 1 should NOT return Segment 0's or global's Player 1."""
        eff_seg0 = self.profile.resolve_player_effect(player_name="Alex", player_index=0, ip=self.ip, seg_id=0)
        self.assertIsNotNone(eff_seg0)
        self.assertTrue(eff_seg0.enabled)

        # Segment 1 does NOT have player_1 override
        eff_seg1 = self.profile.resolve_player_effect(player_name="Alex", player_index=0, ip=self.ip, seg_id=1, hw_key="gpio_25_pwm_45")
        self.assertIsNone(eff_seg1, "Unconfigured player slot on Segment 1 must return None, not leak from global/seg 0")

    def test_global_query_without_segment_still_returns_global_effect(self):
        """When querying without ip/seg_id, global fallback still returns global events."""
        eff_global = self.profile.get_effect("180")
        self.assertIsNotNone(eff_global)
        self.assertTrue(eff_global.enabled)

    def test_serialization_preserves_strict_segment_isolation(self):
        """Converting to dict and back preserves distinct segment event configurations."""
        serialized = self.profile.to_dict()
        reconstructed = ProfileConfig.from_dict(serialized)

        seg0_events = reconstructed.device_events.get(self.ip, {}).get("0", {})
        seg1_events = reconstructed.device_events.get(self.ip, {}).get("1", {})

        self.assertIn("180", seg0_events)
        self.assertTrue(seg0_events["180"].enabled)

        self.assertNotIn("180", seg1_events, "Segment 1 must not inherit '180' after serialization round-trip")
        self.assertIn("bust", seg1_events)
        self.assertTrue(seg1_events["bust"].enabled)

    def test_mutating_segment_0_does_not_affect_segment_1(self):
        """Mutating an event on Segment 0 never leaks to or creates an override on Segment 1."""
        seg0 = self.profile.device_events[self.ip]["0"]
        seg1 = self.profile.device_events[self.ip]["1"]

        # Mutate Segment 0
        seg0["180"].color_primary = RGBColor(255, 0, 0)
        seg0["bullseye"] = EffectConfig(
            animation=AnimationType.FLASH,
            color_primary=RGBColor(0, 255, 0),
            duration=2.0,
            enabled=True
        )

        self.assertNotIn("bullseye", seg1)
        self.assertNotIn("180", seg1)
        self.assertIsNone(self.profile.get_effect("bullseye", ip=self.ip, seg_id=1))
        self.assertIsNone(self.profile.get_effect("180", ip=self.ip, seg_id=1))

