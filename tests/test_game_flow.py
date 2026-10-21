import unittest
import os
import tempfile
import shutil

from core.models import AnimationType
from core.game_flow import (
    GameFlow, create_default_game_flow, GameFlowStorageManager
)
from core.animations import blend_frames


class TestGameFlow(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.flow_file = os.path.join(self.temp_dir, "test_game_flows.json")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_default_game_flow_structure(self):
        flow = create_default_game_flow()
        self.assertEqual(len(flow.phases), 7)
        phase_ids = [p.id for p in flow.phases]
        self.assertIn("idle", phase_ids)
        self.assertIn("game_start", phase_ids)
        self.assertIn("turn_p1", phase_ids)
        self.assertIn("takeout", phase_ids)
        self.assertIn("turn_p2", phase_ids)
        self.assertIn("leg_won", phase_ids)
        self.assertIn("match_won", phase_ids)

        # Check transitions including bidirectional takeout and victory branches
        self.assertIn("idle->game_start", flow.transitions)
        self.assertIn("turn_p1->takeout", flow.transitions)
        self.assertIn("takeout->turn_p2", flow.transitions)
        self.assertIn("turn_p2->takeout", flow.transitions)
        self.assertIn("takeout->turn_p1", flow.transitions)
        self.assertIn("turn_p1->turn_p2", flow.transitions)
        self.assertIn("turn_p2->turn_p1", flow.transitions)
        self.assertIn("turn_p2->leg_won", flow.transitions)
        self.assertIn("turn_p2->match_won", flow.transitions)
        self.assertIn("leg_won->turn_p1", flow.transitions)
        self.assertIn("match_won->idle", flow.transitions)

        t_loop = flow.get_transition("turn_p2", "turn_p1")
        self.assertEqual(t_loop.style, "crossfade")

        t_match = flow.get_transition("turn_p2", "match_won")
        self.assertEqual(t_match.style, "flash")

        t_idle = flow.get_transition("idle", "game_start")
        self.assertEqual(t_idle.style, "pulse")
        self.assertIsNotNone(t_idle.accent_color)

        # Check IDLE phase WLED effect
        idle_phase = next(p for p in flow.phases if p.id == "idle")
        self.assertEqual(idle_phase.effect.animation, AnimationType.BREATHE)
        self.assertEqual(idle_phase.effect.wled_effect_id, 2)
        self.assertEqual(idle_phase.effect.wled_effect_name, "Breathe")

    def test_flow_serialization(self):
        flow = create_default_game_flow()
        d = flow.to_dict()
        restored = GameFlow.from_dict(d)
        self.assertEqual(len(restored.phases), len(flow.phases))
        self.assertEqual(restored.name, flow.name)
        self.assertEqual(len(restored.transitions), len(flow.transitions))
        restored_idle = next(p for p in restored.phases if p.id == "idle")
        self.assertEqual(restored_idle.effect.wled_effect_id, 2)
        self.assertEqual(restored_idle.effect.wled_effect_name, "Breathe")
        self.assertIn("turn_p2->turn_p1", restored.transitions)
        self.assertIn("turn_p2->match_won", restored.transitions)

    def test_storage_manager_save_and_load(self):
        mgr = GameFlowStorageManager(self.flow_file)
        flow = create_default_game_flow()
        flow.name = "Custom Championship Flow"
        saved = mgr.save(flow)
        self.assertTrue(saved)
        self.assertTrue(os.path.exists(self.flow_file))

        loaded = mgr.load()
        self.assertEqual(loaded.name, "Custom Championship Flow")
        self.assertEqual(len(loaded.phases), 7)

    def test_storage_manager_missing_file_fallback(self):
        mgr = GameFlowStorageManager(self.flow_file)
        # Should create default and save
        loaded = mgr.load()
        self.assertEqual(len(loaded.phases), 7)
        self.assertTrue(os.path.exists(self.flow_file))

    def test_blend_frames_crossfade(self):
        buf_a = bytearray([100, 100, 100])
        buf_b = bytearray([200, 200, 200])
        blended = blend_frames(buf_a, buf_b, 0.5, transition_type="crossfade")
        self.assertEqual(blended[0], 150)
        self.assertEqual(blended[1], 150)
        self.assertEqual(blended[2], 150)

    def test_blend_frames_wipe(self):
        buf_a = bytearray([0, 0, 0, 0, 0, 0])
        buf_b = bytearray([255, 255, 255, 255, 255, 255])
        # 50% wipe on 2 LEDs: LED 0 is buf_b, LED 1 is buf_a
        blended = blend_frames(buf_a, buf_b, 0.5, transition_type="wipe")
        self.assertEqual(blended[0], 255)
        self.assertEqual(blended[3], 0)

    def test_blend_frames_instant(self):
        buf_a = bytearray([50, 50, 50])
        buf_b = bytearray([200, 200, 200])
        blend_low = blend_frames(buf_a, buf_b, 0.2, transition_type="instant")
        self.assertEqual(blend_low[0], 50)
        blend_high = blend_frames(buf_a, buf_b, 0.8, transition_type="instant")
        self.assertEqual(blend_high[0], 200)

    def test_blend_frames_pulse(self):
        buf_a = bytearray([200, 200, 200])
        buf_b = bytearray([200, 200, 200])
        # At midpoint 0.5, pulse should dip toward 0 or accent
        blend_mid = blend_frames(buf_a, buf_b, 0.5, transition_type="pulse")
        self.assertLess(blend_mid[0], 50)

    def test_blend_frames_flash(self):
        buf_a = bytearray([10, 10, 10])
        buf_b = bytearray([20, 20, 20])
        accent = (255, 0, 0)
        # Check that flash runs without error
        blended = blend_frames(buf_a, buf_b, 0.25, transition_type="flash", accent_rgb=accent)
        self.assertEqual(len(blended), 3)


if __name__ == "__main__":
    unittest.main()
