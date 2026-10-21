"""
Unit tests for Player Slot Matching, Name Filters, Dynamic Fallback, and Throw Events
"""

import unittest
from core.models import (
    ProfileConfig, PlayerSlotConfig, NameMatchType,
    EffectConfig, AnimationType, RGBColor,
    DartEventType
)


class TestPlayerMatching(unittest.TestCase):

    def setUp(self):
        self.profile = ProfileConfig.get_default_profile()
        # Custom setup:
        # Slot 1: "Alex" (EXACT) -> Red [255, 0, 0]
        # Slot 2: "Henry" (CONTAINS) -> Green [0, 255, 0]
        # Slot 3: Unnamed -> Blue [0, 0, 255]
        # Slot 4: Unnamed -> Yellow [255, 255, 0]
        self.profile.player_slots = [
            PlayerSlotConfig(
                id=1,
                name_filter="Alex",
                match_type=NameMatchType.EXACT,
                effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(255, 0, 0), duration=0.0, enabled=True),
                enabled=True
            ),
            PlayerSlotConfig(
                id=2,
                name_filter="Henry",
                match_type=NameMatchType.CONTAINS,
                effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 255, 0), duration=0.0, enabled=True),
                enabled=True
            ),
            PlayerSlotConfig(
                id=3,
                name_filter="",
                match_type=NameMatchType.CONTAINS,
                effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 0, 255), duration=0.0, enabled=True),
                enabled=True
            ),
            PlayerSlotConfig(
                id=4,
                name_filter="",
                match_type=NameMatchType.CONTAINS,
                effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(255, 255, 0), duration=0.0, enabled=True),
                enabled=True
            )
        ]

    def test_exact_name_match(self):
        # "Alex" exactly matches Slot 1
        eff = self.profile.resolve_player_effect(player_name="Alex", player_index=0)
        self.assertIsNotNone(eff)
        self.assertEqual(eff.color_primary.to_list(), [255, 0, 0])

        # Case-insensitivity: "alex" matches "Alex"
        eff_lower = self.profile.resolve_player_effect(player_name="alex", player_index=0)
        self.assertIsNotNone(eff_lower)
        self.assertEqual(eff_lower.color_primary.to_list(), [255, 0, 0])

        # "Alexander" should NOT match EXACT "Alex"
        eff_alexander = self.profile.resolve_player_effect(player_name="Alexander", player_index=0)
        self.assertIsNotNone(eff_alexander)
        # Should fallback to slot 1 since it's player_index 0 and Slot 1 index fallback
        self.assertEqual(eff_alexander.color_primary.to_list(), [255, 0, 0])

    def test_contains_name_match(self):
        # "Henry" (contains) matches "Sir Henry VIII"
        eff = self.profile.resolve_player_effect(player_name="Sir Henry VIII", player_index=1)
        self.assertIsNotNone(eff)
        self.assertEqual(eff.color_primary.to_list(), [0, 255, 0])

        # Case-insensitivity: "henry-darts" matches "Henry"
        eff2 = self.profile.resolve_player_effect(player_name="henry-darts", player_index=0)
        self.assertIsNotNone(eff2)
        self.assertEqual(eff2.color_primary.to_list(), [0, 255, 0])

    def test_multi_player_unnamed_fallback(self):
        # Match with 4 players: ["Alex", "Bob", "Sir Henry", "Dave"]
        # Alex (idx 0) -> Slot 1 (Red)
        # Bob (idx 1) -> Unnamed -> gets first unallocated slot (Slot 3 / Blue)
        # Sir Henry (idx 2) -> Slot 2 (Green)
        # Dave (idx 3) -> Unnamed -> gets second unallocated slot (Slot 4 / Yellow)
        match_roster = ["Alex", "Bob", "Sir Henry", "Dave"]

        eff_alex = self.profile.resolve_player_effect(player_name="Alex", player_index=0, match_players=match_roster)
        self.assertEqual(eff_alex.color_primary.to_list(), [255, 0, 0])

        eff_bob = self.profile.resolve_player_effect(player_name="Bob", player_index=1, match_players=match_roster)
        self.assertEqual(eff_bob.color_primary.to_list(), [0, 0, 255])  # Slot 3 (Blue)

        eff_henry = self.profile.resolve_player_effect(player_name="Sir Henry", player_index=2, match_players=match_roster)
        self.assertEqual(eff_henry.color_primary.to_list(), [0, 255, 0])  # Slot 2 (Green)

        eff_dave = self.profile.resolve_player_effect(player_name="Dave", player_index=3, match_players=match_roster)
        self.assertEqual(eff_dave.color_primary.to_list(), [255, 255, 0])  # Slot 4 (Yellow)

    def test_fallback_to_default_throw_when_slots_disabled(self):
        for slot in self.profile.player_slots:
            slot.enabled = False

        self.profile.events[DartEventType.THROW.value] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(50, 50, 50),
            duration=0.0
        )

        eff = self.profile.resolve_player_effect(player_name="Alex", player_index=0)
        self.assertIsNotNone(eff)
        self.assertEqual(eff.color_primary.to_list(), [50, 50, 50])

    def test_player_1_prefill_and_customization(self):
        # Default slots created with Autodarts connected username
        slots = ProfileConfig.get_default_player_slots(autodarts_name="Henry")
        self.assertEqual(slots[0].name_filter, "Henry")
        self.assertEqual(slots[1].name_filter, "")

        # User customizes player 1 to another name and enables it
        slots[0].name_filter = "CustomPlayer"
        slots[0].enabled = True
        slots[0].effect.enabled = True
        slots[0].effect.color_primary = RGBColor(0, 180, 255)
        self.assertEqual(slots[0].name_filter, "CustomPlayer")

        # Resolves to player 1 custom name
        self.profile.player_slots = slots
        eff = self.profile.resolve_player_effect(player_name="CustomPlayer", player_index=0)
        self.assertIsNotNone(eff)
        self.assertEqual(eff.color_primary.to_list(), [0, 180, 255])

    def test_player_slot_serialization_disabled(self):
        # Enable slot 3 and disable slots 1 and 2
        self.profile.player_slots[0].enabled = False
        self.profile.player_slots[0].effect.enabled = False
        self.profile.player_slots[1].enabled = False
        self.profile.player_slots[1].effect.enabled = False
        self.profile.player_slots[2].enabled = True
        self.profile.player_slots[2].effect.enabled = True

        data = self.profile.to_dict()
        self.assertIn("player_slots", data)
        self.assertFalse(data["player_slots"][0]["enabled"])
        self.assertFalse(data["player_slots"][1]["enabled"])
        self.assertTrue(data["player_slots"][2]["enabled"])

        # Re-instantiate from dict
        loaded_profile = ProfileConfig.from_dict(data)
        self.assertFalse(loaded_profile.player_slots[0].enabled)
        self.assertFalse(loaded_profile.player_slots[0].effect.enabled)
        self.assertFalse(loaded_profile.player_slots[1].enabled)
        self.assertFalse(loaded_profile.player_slots[1].effect.enabled)
        self.assertTrue(loaded_profile.player_slots[2].enabled)

    def test_per_segment_player_slot_independence(self):
        # Configure Device 1 with Segment 0 (RGB) and Segment 1 (PWM White)
        ip = "192.168.2.215"
        self.profile.device_events[ip] = {
            "0": {
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(0, 180, 255),
                    duration=0.0,
                    enabled=True
                )
            },
            "1": {
                "player_1": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(255, 255, 255),
                    brightness=100,
                    duration=0.0,
                    enabled=False  # Disabled specifically on PWM White!
                ),
                "player_2": EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(200, 200, 200),
                    brightness=80,
                    duration=0.0,
                    enabled=True   # Enabled on PWM White!
                )
            }
        }

        # Player 1 turn (Alex): Segment 0 is enabled (RGB Cyan), Segment 1 is disabled (PWM White)
        eff_seg0 = self.profile.resolve_player_effect(player_name="Alex", player_index=0, ip=ip, seg_id=0)
        eff_seg1 = self.profile.resolve_player_effect(player_name="Alex", player_index=0, ip=ip, seg_id=1)

        self.assertTrue(eff_seg0.enabled)
        self.assertEqual(eff_seg0.color_primary.to_list(), [0, 180, 255])
        self.assertFalse(eff_seg1.enabled)

        # Player 2 turn: Segment 1 (PWM White) is enabled at 80% brightness
        eff_p2_seg1 = self.profile.resolve_player_effect(player_name="Opponent", player_index=1, ip=ip, seg_id=1)
        self.assertTrue(eff_p2_seg1.enabled)
        self.assertEqual(eff_p2_seg1.brightness, 80)


if __name__ == "__main__":
    unittest.main()
