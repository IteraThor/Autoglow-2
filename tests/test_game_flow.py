"""
Flow profiles: the model, the five presets, player colours, profiles on disk and the conversion of
the first flow format (checked against the real game_flows.json saved on 2026-11-01).
"""

import json
import os
import shutil
import tempfile
import unittest

from core.effects.flow import FLOW_EFFECTS, FLOW_TRANSITIONS
from core.flow_presets import PRESET_ORDER, build_preset, presets_for_ui
from core.game_flow import (
    HIT_IDS, MAX_PLAYERS, STEP_IDS, GameFlow, GameFlowStorageManager, convert_v1_flow,
    create_default_game_flow, player_colour_index,
)
from core.models import EffectConfig

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
V1_FILE = os.path.join(FIXTURES, "game_flows_v1_2026-11-01.json")


class TestModel(unittest.TestCase):
    def test_every_flow_has_all_steps_hits_and_six_players(self):
        flow = GameFlow.from_dict({"steps": {}, "name": "Empty"})
        self.assertEqual(list(flow.steps), list(STEP_IDS))
        self.assertEqual(set(flow.hits), set(HIT_IDS))
        self.assertEqual(len(flow.players), MAX_PLAYERS)

    def test_players_turn_cannot_be_switched_off(self):
        raw = create_default_game_flow().to_dict()
        raw["steps"]["turn"]["effect"]["enabled"] = False
        self.assertTrue(GameFlow.from_dict(raw).steps["turn"].enabled)

    def test_only_timed_steps_have_a_time(self):
        raw = create_default_game_flow().to_dict()
        for sid in STEP_IDS:
            raw["steps"][sid]["effect"]["duration"] = 0
        flow = GameFlow.from_dict(raw)
        for sid in ("game_start", "leg_won", "match_won"):
            self.assertGreater(flow.steps[sid].effect.duration, 0, sid)
        for sid in ("bull_off", "turn", "takeout"):
            self.assertEqual(flow.steps[sid].effect.duration, 0, sid)

    def test_round_trip(self):
        for pid in PRESET_ORDER:
            flow = build_preset(pid)
            self.assertEqual(GameFlow.from_dict(json.loads(json.dumps(flow.to_dict()))).to_dict(), flow.to_dict(), pid)

    def test_cut_has_no_duration(self):
        raw = create_default_game_flow().to_dict()
        raw["steps"]["turn"]["transition"] = {"style": "cut", "duration": 2}
        tr = GameFlow.from_dict(raw).steps["turn"].transition
        self.assertEqual((tr.style, tr.duration), ("instant", 0.0))


class TestPresets(unittest.TestCase):
    def test_five_presets_from_minimal_to_party(self):
        self.assertEqual([p["name"] for p in presets_for_ui()], ["Minimal", "Classic", "Arena", "Show", "Party"])

    def test_presets_only_use_curated_looks(self):
        for pid in PRESET_ORDER:
            flow = build_preset(pid)
            effects = [s.effect for s in flow.steps.values()] + list(flow.hits.values())
            for eff in effects:
                self.assertIn(eff.animation.value, FLOW_EFFECTS, pid)
            for s in flow.steps.values():
                self.assertIn(s.transition.style, FLOW_TRANSITIONS, pid)

    def test_presets_get_louder(self):
        def loudness(flow):
            steps_on = sum(1 for s in flow.steps.values() if s.enabled)
            hits_on = sum(1 for h in flow.hits.values() if h.enabled)
            return steps_on + hits_on + (2 if flow.hit_locator else 0) + (0 if flow.camera_friendly else 2)
        levels = [loudness(build_preset(p)) for p in PRESET_ORDER]
        self.assertEqual(levels, sorted(levels))
        self.assertLess(levels[0], levels[-1])

    def test_minimal_is_quiet_and_party_warns_about_detection(self):
        minimal = build_preset("minimal")
        self.assertFalse(any(h.enabled for h in minimal.hits.values()))
        self.assertTrue(minimal.camera_friendly)
        self.assertFalse(build_preset("party").camera_friendly)
        self.assertIn("detection", {p["id"]: p for p in presets_for_ui()}["party"]["summary"])

    def test_new_installs_start_with_classic(self):
        self.assertEqual(create_default_game_flow().preset, "classic")


class TestPlayerColours(unittest.TestCase):
    def test_players_get_colours_in_match_order(self):
        flow = create_default_game_flow()
        players = ["Anna", "Ben", "Cleo", "Dan"]
        self.assertEqual([player_colour_index(players, i, flow) for i in range(4)], [0, 1, 2, 3])

    def test_a_named_colour_follows_the_player(self):
        flow = create_default_game_flow()
        flow.players[3].name = "Henry"
        players = ["Anna", "henry", "Ben"]
        self.assertEqual(player_colour_index(players, 1, flow), 3)
        # Unnamed players skip the named colour
        self.assertEqual(player_colour_index(players, 0, flow), 0)
        self.assertEqual(player_colour_index(players, 2, flow), 1)

    def test_more_players_than_colours_wrap_around(self):
        flow = create_default_game_flow()
        players = [f"P{i}" for i in range(8)]
        self.assertEqual(player_colour_index(players, 6, flow), 0)

    def test_unknown_players_use_their_position(self):
        flow = create_default_game_flow()
        self.assertEqual(player_colour_index([], 2, flow), 2)
        self.assertEqual(player_colour_index([], None, flow), 0)


class TestConversionOfTheFirstFormat(unittest.TestCase):
    def setUp(self):
        with open(V1_FILE) as f:
            self.v1 = json.load(f)

    def test_real_flow_converts_with_its_colours(self):
        flow = convert_v1_flow(self.v1)
        phases = {p["id"]: p for p in self.v1["phases"]}
        self.assertEqual(flow.name, "My flow")
        self.assertEqual(flow.players[0].color.to_list(), phases["turn_p1"]["effect"]["color_primary"])
        self.assertEqual(flow.players[1].color.to_list(), phases["turn_p2"]["effect"]["color_primary"])
        self.assertEqual(flow.steps["takeout"].effect.color_primary.to_list(), phases["takeout"]["effect"]["color_primary"])
        self.assertEqual(flow.steps["leg_won"].effect.animation.value, "rainbow")
        self.assertTrue(flow.hits["180"].enabled)
        self.assertEqual(flow.steps["turn"].transition.style, self.v1["transitions"]["takeout->turn_p1"]["style"])

    def test_storage_turns_an_old_file_into_profiles(self):
        tmp = tempfile.mkdtemp()
        try:
            path = os.path.join(tmp, "game_flows.json")
            v1 = dict(self.v1)
            v1["device_flows"] = {"10.0.0.9": {"1": self.v1}}
            with open(path, "w") as f:
                json.dump(v1, f)
            mgr = GameFlowStorageManager(path)
            self.assertEqual(mgr.profile_names(), ["My flow", "My flow - 10.0.0.9 segment 1"])
            self.assertEqual(mgr.default_profile, "My flow")
            self.assertEqual(mgr.profile_name_for("10.0.0.9", 1), "My flow - 10.0.0.9 segment 1")
            self.assertEqual(mgr.profile_name_for("10.0.0.9", 0), "My flow")
            with open(path) as f:
                self.assertEqual(json.load(f)["version"], 2)
            self.assertTrue(os.path.exists(path + ".bak"), "the old file is kept as a backup")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class TestProfilesOnDisk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.mgr = GameFlowStorageManager(os.path.join(self.tmp, "game_flows.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unreadable_file_is_kept_under_another_name_before_the_defaults_replace_it(self):
        path = os.path.join(self.tmp, "game_flows.json")
        with open(path, "w") as f:
            f.write('{"version": 2, "profiles": {oops')
        mgr = GameFlowStorageManager(path)
        self.assertTrue(mgr.profile_names())
        kept = [n for n in os.listdir(self.tmp) if n.startswith("game_flows.json.corrupt_")]
        self.assertEqual(len(kept), 1)
        with open(os.path.join(self.tmp, kept[0])) as f:
            self.assertIn("oops", f.read())

    def test_new_file_starts_with_classic(self):
        self.assertEqual(self.mgr.profile_names(), ["Classic"])

    def test_segment_then_controller_then_default(self):
        self.mgr.save_profile(build_preset("party"))
        self.mgr.save_profile(build_preset("minimal"))
        self.mgr.assign("1.1.1.1", "Party")
        self.mgr.assign("1.1.1.1", "Minimal", 2)
        self.assertEqual(self.mgr.profile_name_for("1.1.1.1", 2), "Minimal")
        self.assertEqual(self.mgr.profile_name_for("1.1.1.1", 0), "Party")
        self.assertEqual(self.mgr.profile_name_for("2.2.2.2", 0), "Classic")
        # Choosing for the whole controller replaces its segment choices
        self.mgr.assign("1.1.1.1", "Classic")
        self.assertEqual(self.mgr.profile_name_for("1.1.1.1", 2), "Classic")

    def test_rename_keeps_assignments_and_default(self):
        self.mgr.assign("1.1.1.1", "Classic", 0)
        flow = self.mgr.load_profile("Classic")
        flow.name = "Home"
        self.assertTrue(self.mgr.save_profile(flow, old_name="Classic"))
        self.assertEqual(self.mgr.profile_names(), ["Home"])
        self.assertEqual(self.mgr.default_profile, "Home")
        self.assertEqual(self.mgr.profile_name_for("1.1.1.1", 0), "Home")

    def test_rename_onto_an_existing_name_is_refused(self):
        self.mgr.save_profile(build_preset("party"))
        flow = self.mgr.load_profile("Party")
        flow.name = "Classic"
        self.assertFalse(self.mgr.save_profile(flow, old_name="Party"))

    def test_delete_moves_users_to_the_default_and_keeps_the_last_profile(self):
        self.mgr.save_profile(build_preset("party"))
        self.mgr.assign("1.1.1.1", "Party", 0)
        self.mgr.set_default("Party")
        self.assertTrue(self.mgr.delete_profile("Party"))
        self.assertEqual(self.mgr.default_profile, "Classic")
        self.assertEqual(self.mgr.profile_name_for("1.1.1.1", 0), "Classic")
        self.assertFalse(self.mgr.delete_profile("Classic"))

    def test_effect_options_survive_saving(self):
        flow = self.mgr.load_profile()
        flow.steps["game_start"].effect = EffectConfig.from_dict({"animation": "chase", "options": {"comets": 2}, "duration": 2})
        self.mgr.save_profile(flow)
        again = GameFlowStorageManager(self.mgr.filepath).get_profile("Classic")
        self.assertEqual(again.steps["game_start"].effect.options["comets"], 2)


if __name__ == "__main__":
    unittest.main()
