"""
AutoGlow 2 - Flow Matrix & Dual-Engine Integration Tests
Validates the Flow Matrix execution engine, mode switching, and REST endpoints.
"""

import unittest
import os
import tempfile
from unittest.mock import AsyncMock

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

from core.models import AppConfig, DeviceConfig, DartEvent, DartEventType, LightingMode, EffectConfig
from core.engine import AutoGlowEngine
from core.game_flow import GameFlowStorageManager
from routes.flow_routes import register_flow_routes


class TestFlowEngineExecution(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dev = DeviceConfig(name="Test WLED", ip="192.168.1.100", rgb_count=45, enabled=True)
        self.cfg = AppConfig(devices=[self.dev], lighting_mode=LightingMode.FLOW)
        self.engine = AutoGlowEngine(device_config=self.dev, app_config=self.cfg)
        self.engine.wake_up = AsyncMock()

        # Mock driver play_effect
        for drv in self.engine.drivers.values():
            drv.play_effect = AsyncMock()

    async def test_mode_switching(self):
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.FLOW)
        self.engine.set_lighting_mode("matrix")
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.MATRIX)
        self.engine.set_lighting_mode(LightingMode.FLOW)
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.FLOW)

    async def test_game_start_flow_dispatch(self):
        event = DartEvent(event_type=DartEventType.GAME_START)
        await self.engine.process_event(event)

        self.assertEqual(self.engine.flow_active_phase, "game_start")
        drv = self.engine.get_driver("192.168.1.100")
        self.assertTrue(drv.play_effect.called)

    async def test_player_turn_baseline_dispatch(self):
        # Player 1 throw
        ev1 = DartEvent(event_type=DartEventType.THROW, player_name="Henry", player_index=0)
        await self.engine.process_event(ev1)
        self.assertEqual(self.engine.flow_active_phase, "turn_p1")

        # Player 2 throw
        ev2 = DartEvent(event_type=DartEventType.THROW, player_name="Guest", player_index=1)
        await self.engine.process_event(ev2)
        self.assertEqual(self.engine.flow_active_phase, "turn_p2")

    async def test_in_turn_hit_dispatch(self):
        # Hit 180
        ev_180 = DartEvent(event_type=DartEventType.SCORE_180, player_name="Henry", player_index=0, score=180)
        await self.engine.process_event(ev_180)

        drv = self.engine.get_driver("192.168.1.100")
        self.assertTrue(drv.play_effect.called)
        # Verify effect passed to driver is the 180 effect
        last_effect = drv.play_effect.call_args[0][0]
        self.assertIsNotNone(last_effect)
        self.assertTrue(last_effect.duration > 0.0)

    async def test_takeout_dispatch(self):
        event = DartEvent(event_type=DartEventType.TAKEOUT)
        await self.engine.process_event(event)
        self.assertEqual(self.engine.flow_active_phase, "takeout")

    async def test_victory_dispatches(self):
        # Leg Won
        ev_leg = DartEvent(event_type=DartEventType.LEG_WON)
        await self.engine.process_event(ev_leg)
        self.assertEqual(self.engine.flow_active_phase, "leg_won")

        # Match Won
        ev_match = DartEvent(event_type=DartEventType.MATCH_WON)
        await self.engine.process_event(ev_match)
        self.assertEqual(self.engine.flow_active_phase, "match_won")

    async def test_flow_duration_isolation(self):
        # Event Matrix profile has game_start configured to 7.5s
        self.engine.profile.events["game_start"] = EffectConfig(duration=7.5, enabled=True)
        # Flow Matrix has game_start configured to 1.8s
        p = self.engine.game_flow.get_phase("game_start")
        if p and p.effect:
            p.effect.duration = 1.8

        # In FLOW mode, _get_max_effect_duration must return 1.8s, NOT 7.5s
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.FLOW)
        self.assertEqual(self.engine._get_max_effect_duration("game_start"), 1.8)

        # In MATRIX mode, _get_max_effect_duration must return 7.5s, NOT 1.8s
        self.engine.set_lighting_mode("matrix")
        self.assertEqual(self.engine._get_max_effect_duration("game_start"), 7.5)

    async def test_game_start_single_task_and_mode_switch_cleanup(self):
        self.engine.set_lighting_mode(LightingMode.FLOW)
        ev_start = DartEvent(event_type=DartEventType.GAME_START)
        await self.engine.process_event(ev_start)

        # Flow Matrix advance task should be created, but Event Matrix game_start_task should NOT be created
        self.assertIsNotNone(self.engine._flow_advance_task)
        self.assertFalse(self.engine._flow_advance_task.done())
        self.assertIsNone(self.engine._game_start_task)
        self.assertGreater(self.engine._game_start_end_time, 0.0)

        # Switching to MATRIX mode must cleanly cancel the in-flight flow advance task and reset end time
        self.engine.set_lighting_mode("matrix")
        self.assertIsNone(self.engine._flow_advance_task)
        self.assertEqual(self.engine._game_start_end_time, 0.0)



    async def test_pwm_segments_excluded(self):
        # Configure device with 2 segments: Seg 0 (WS281x) and Seg 1 (PWM White)
        self.dev.segments = [
            {"id": 0, "name": "Ring Strip", "type": "WS281x", "start": 0, "length": 60},
            {"id": 1, "name": "Spotlight", "type": "PWM White", "start": 60, "length": 1}
        ]
        drv = self.engine.get_driver("192.168.1.100")
        drv.play_effect.reset_mock()

        event = DartEvent(event_type=DartEventType.SCORE_180, score=180)
        await self.engine.process_event(event)

        # Verify play_effect was called for WS281x (seg 0) but NEVER for PWM (seg 1)
        self.assertTrue(drv.play_effect.called)
        called_seg_ids = [call.kwargs.get("segment_id") for call in drv.play_effect.call_args_list]
        self.assertIn(0, called_seg_ids)
        self.assertNotIn(1, called_seg_ids)

    async def test_flow_storage_per_segment_and_fallback(self):
        from core.game_flow import GameFlowStorageManager, RGBColor
        import tempfile, os

        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "test_game_flows.json")
            mgr = GameFlowStorageManager(path)

            # Master default flow
            def_flow = mgr.load()
            self.assertEqual(def_flow.id, "default_flow")

            # Fallback for unconfigured segment
            seg_flow = mgr.load_for_segment("192.168.1.100", 0)
            self.assertEqual(seg_flow.id, "default_flow")

            # Save customized flow for 192.168.1.100 seg 0
            custom = mgr.load()
            custom.id = "custom_flow_seg0"
            custom.phases[0].effect.color_primary = RGBColor(12, 34, 56)
            mgr.save_for_segment(custom, "192.168.1.100", 0)

            # Readback customized flow
            reloaded_seg = mgr.load_for_segment("192.168.1.100", 0)
            self.assertEqual(reloaded_seg.id, "custom_flow_seg0")
            self.assertEqual(reloaded_seg.phases[0].effect.color_primary.r, 12)

            # Unconfigured segment still gets default
            reloaded_seg1 = mgr.load_for_segment("192.168.1.100", 1)
            self.assertEqual(reloaded_seg1.id, "default_flow")


class TestFlowRoutesAPI(AioHTTPTestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_config_path = os.path.join(self.temp_dir.name, "test_config.json")
        self.temp_flow_path = os.path.join(self.temp_dir.name, "test_game_flows.json")
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        self.dev = DeviceConfig(name="Test WLED", ip="192.168.1.100", rgb_count=45, enabled=True)
        self.cfg = AppConfig(devices=[self.dev], lighting_mode=LightingMode.MATRIX)
        self.engine = AutoGlowEngine(device_config=self.dev, app_config=self.cfg)
        app["engine"] = self.engine
        app["current_app_config"] = self.cfg
        app["config_path"] = self.temp_config_path
        app["flow_storage"] = GameFlowStorageManager(self.temp_flow_path)
        register_flow_routes(app)
        return app

    async def test_get_and_set_lighting_mode_api(self):
        # GET default
        resp = await self.client.get("/api/flow/mode")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data.get("mode"), "matrix")

        # POST set to flow
        resp2 = await self.client.post("/api/flow/mode", json={"mode": "flow"})
        self.assertEqual(resp2.status, 200)
        data2 = await resp2.json()
        self.assertEqual(data2.get("mode"), "flow")
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.FLOW)

        # POST set back to matrix
        resp3 = await self.client.post("/api/flow/mode", json={"mode": "matrix"})
        self.assertEqual(resp3.status, 200)
        data3 = await resp3.json()
        self.assertEqual(data3.get("mode"), "matrix")
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.MATRIX)

    async def test_segment_flow_routes_api(self):
        # GET default flow
        resp = await self.client.get("/api/flow/current")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("flow", data)
        flow_obj = data["flow"]

        # POST save for specific IP and segment
        flow_obj["id"] = "custom_ip_seg"
        resp_save = await self.client.post("/api/flow/save", json={
            "ip": "192.168.1.100",
            "seg": 0,
            "flow": flow_obj
        })
        self.assertEqual(resp_save.status, 200)

        # GET for that specific IP and segment
        resp_seg = await self.client.get("/api/flow/current?ip=192.168.1.100&seg=0")
        self.assertEqual(resp_seg.status, 200)
        seg_data = await resp_seg.json()
        self.assertEqual(seg_data["flow"]["id"], "custom_ip_seg")


if __name__ == "__main__":
    unittest.main()
