"""
Flow Matrix in the engine, the driver and the REST API:
- the driver blends a segment from its current look into the next step, lays hits on top and fades
  them back, and draws the hit locator;
- the engine hands events to the flow runtime in Flow mode;
- the /api/flow routes manage profiles, assignment and trying looks.
"""

import os
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

from core.effects.flow import normalize_options
from core.engine import AutoGlowEngine
from core.game_flow import GameFlowStorageManager
from core.models import (
    AnimationType, AppConfig, DartEvent, DartEventType, DeviceConfig, EffectConfig, LightingMode,
    ProtocolMode, RGBColor, SegmentConfig,
)
from core.wled_driver import WLEDDriver
from routes.flow_routes import register_flow_routes


def solid(r, g, b):
    return EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(r, g, b), duration=0, options={})


class TestDriverFlowChannels(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.drv = WLEDDriver(DeviceConfig(ip="10.0.0.1", rgb_count=40, segments=[SegmentConfig(id=0, start=0, length=40)]))
        self.drv._protocol_mode = ProtocolMode.ACTIVE_UDP
        self.drv._ensure_broadcast = MagicMock()

    def frame(self, at):
        ch = self.drv._segment_channels[0]
        return self.drv._render_flow_channel(ch, at, 40)

    def test_nothing_is_shown_while_not_streaming(self):
        self.drv._protocol_mode = ProtocolMode.IDLE_HTTP
        self.assertFalse(self.drv.flow_show(0, solid(255, 0, 0)))

    def test_first_look_comes_in_from_black(self):
        self.drv.flow_show(0, solid(200, 0, 0), "crossfade", 1.0)
        t0 = self.drv._segment_channels[0]["baseline_start_time"]
        self.assertEqual(self.frame(t0)[:3], bytearray([0, 0, 0]))
        self.assertEqual(self.frame(t0 + 1.0)[:3], bytearray([200, 0, 0]))

    def test_next_look_blends_from_the_current_one(self):
        self.drv.flow_show(0, solid(200, 0, 0), "instant", 0)
        t0 = self.drv._segment_channels[0]["baseline_start_time"]
        self.frame(t0)
        self.drv.flow_show(0, solid(0, 0, 200), "crossfade", 1.0)
        t1 = self.drv._segment_channels[0]["baseline_start_time"]
        mid = self.frame(t1 + 0.5)
        self.assertTrue(0 < mid[0] < 200 and 0 < mid[2] < 200, mid[:3])
        self.assertEqual(self.frame(t1 + 1.01)[:3], bytearray([0, 0, 200]))

    def test_wipe_moves_along_the_strip(self):
        self.drv.flow_show(0, solid(200, 0, 0), "instant", 0)
        self.frame(self.drv._segment_channels[0]["baseline_start_time"])
        self.drv.flow_show(0, solid(0, 0, 200), "wipe", 1.0)
        t1 = self.drv._segment_channels[0]["baseline_start_time"]
        mid = self.frame(t1 + 0.5)
        self.assertEqual(mid[2], 200, "the start of the strip already shows the new look")
        self.assertEqual((mid[-3], mid[-1]), (200, 0), "the end still shows the old look")

    def test_same_look_again_does_not_restart(self):
        eff = solid(10, 20, 30)
        self.drv.flow_show(0, eff, "crossfade", 1.0)
        start = self.drv._segment_channels[0]["baseline_start_time"]
        self.drv.flow_show(0, eff, "crossfade", 1.0)
        self.assertEqual(self.drv._segment_channels[0]["baseline_start_time"], start)

    def test_hit_lays_over_the_look_and_fades_back(self):
        self.drv.flow_show(0, solid(0, 0, 100), "instant", 0)
        flash = EffectConfig(animation=AnimationType.FLASH, color_primary=RGBColor(255, 255, 0), duration=1.0,
                             options=normalize_options("flash", {}))
        self.drv.flow_hit(0, flash, 1.0)
        ov = self.drv._segment_channels[0]["overlay"]
        peak = self.frame(ov["start"] + 0.04)
        self.assertGreater(peak[0], 200, "the hit shows")
        end = self.frame(ov["start"] + 0.99)
        self.assertEqual(end[:3], bytearray([0, 0, 100]), "and is gone into the look at the end")
        self.frame(ov["start"] + 1.5)
        self.assertIsNone(self.drv._segment_channels[0]["overlay"])

    def test_gentle_hit_shows_at_half_strength(self):
        self.drv.flow_show(0, solid(0, 0, 0), "instant", 0)
        rainbow = EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(200, 200, 200), duration=2.0, options={})
        self.drv.flow_hit(0, rainbow, 0.5)
        ov = self.drv._segment_channels[0]["overlay"]
        self.assertEqual(self.frame(ov["start"] + 0.5)[0], 100)

    def test_locator_lights_the_number_and_nothing_opposite(self):
        self.drv.flow_show(0, solid(0, 0, 0), "instant", 0)
        self.drv.flow_locate(0, 0.25, RGBColor(255, 255, 255))
        loc = self.drv._segment_channels[0]["locator"]
        f = self.frame(loc["start"] + 0.01)
        self.assertGreater(f[10 * 3], 200, "LED at a quarter of the way round")
        self.assertEqual(f[30 * 3], 0)

    def test_anticlockwise_strip_mirrors_the_locator(self):
        self.drv.flow_show(0, solid(0, 0, 0), "instant", 0)
        self.drv.flow_locate(0, 0.25, RGBColor(255, 255, 255), clockwise=False)
        loc = self.drv._segment_channels[0]["locator"]
        f = self.frame(loc["start"] + 0.01)
        self.assertGreater(f[30 * 3], 200)
        self.assertEqual(f[10 * 3], 0)

    async def test_going_to_idle_clears_flow_looks(self):
        self.drv.flow_show(0, solid(1, 2, 3), "instant", 0)
        with patch.object(self.drv, "_sync_release_live_and_restore_preset", return_value=True):
            await self.drv.transition_to_http_mode()
        ch = self.drv._segment_channels[0]
        self.assertFalse(ch["flow"])
        self.assertIsNone(ch["last_base"])

    async def test_legacy_effect_takes_the_channel_back(self):
        self.drv.flow_show(0, solid(1, 2, 3), "instant", 0)
        self.drv._master_broadcast_task = MagicMock(done=MagicMock(return_value=False))
        await self.drv.play_effect(EffectConfig(animation=AnimationType.SOLID, duration=0), segment_id=0)
        self.assertFalse(self.drv._segment_channels[0]["flow"])


class TestEngineInFlowMode(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.mkdtemp()
        self.dev = DeviceConfig(name="Board", ip="192.168.1.100", rgb_count=45, enabled=True,
                                segments=[SegmentConfig(id=0, start=0, length=45)])
        self.cfg = AppConfig(devices=[self.dev], lighting_mode=LightingMode.FLOW)
        self.engine = AutoGlowEngine(device_config=self.dev, app_config=self.cfg)
        self.engine.game_flow_storage = GameFlowStorageManager(os.path.join(self.tmp, "game_flows.json"))
        self.engine.wake_up = AsyncMock()
        self.engine.set_protocol_mode = AsyncMock()
        self.drv = self.engine.get_driver("192.168.1.100")
        self.drv._protocol_mode = ProtocolMode.ACTIVE_UDP
        self.drv.flow_show = MagicMock(return_value=True)
        self.drv.flow_hit = MagicMock(return_value=True)
        self.drv.play_effect = AsyncMock()

    async def asyncTearDown(self):
        self.engine.flow_runtime.reset()
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def test_events_go_through_the_flow(self):
        await self.engine.process_event(DartEvent(event_type=DartEventType.THROW, player_index=1, player_name="B"))
        self.assertEqual(self.engine.flow_active_phase, "turn")
        self.drv.flow_show.assert_called_once()
        self.drv.play_effect.assert_not_called()
        await self.engine.process_event(DartEvent(event_type=DartEventType.BULLSEYE, segment_number=25, score=50))
        self.drv.flow_hit.assert_called_once()

    async def test_streaming_starts_when_a_step_shows(self):
        self.drv._protocol_mode = ProtocolMode.IDLE_HTTP
        await self.engine.process_event(DartEvent(event_type=DartEventType.THROW, player_index=0))
        self.engine.wake_up.assert_awaited_with(mode=ProtocolMode.ACTIVE_UDP)

    async def test_abort_returns_to_the_idle_lighting(self):
        await self.engine.process_event(DartEvent(event_type=DartEventType.THROW, player_index=0))
        await self.engine.process_event(DartEvent(event_type=DartEventType.GAME_IDLE))
        self.engine.set_protocol_mode.assert_awaited_with(ProtocolMode.IDLE_HTTP)
        self.assertEqual(self.engine.flow_active_phase, "waiting")

    async def test_switching_to_event_matrix_stops_the_flow(self):
        await self.engine.process_event(DartEvent(event_type=DartEventType.THROW, player_index=0))
        self.engine.set_lighting_mode("matrix")
        self.assertEqual(self.engine.flow_active_phase, "waiting")
        await self.engine.process_event(DartEvent(event_type=DartEventType.THROW, player_index=1))
        self.assertEqual(self.drv.flow_show.call_count, 1, "Event Matrix events no longer reach the flow")

    async def test_mode_switching(self):
        self.engine.set_lighting_mode("matrix")
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.MATRIX)
        self.engine.set_lighting_mode(LightingMode.FLOW)
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.FLOW)


class TestFlowRoutes(AioHTTPTestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def get_application(self):
        app = web.Application()
        self.dev = DeviceConfig(name="Board", ip="192.168.1.100", rgb_count=60, enabled=True, segments=[
            SegmentConfig(id=0, name="Ring", start=0, length=50),
            SegmentConfig(id=1, name="Spot", type="PWM White", start=50, length=1),
        ])
        self.cfg = AppConfig(devices=[self.dev], lighting_mode=LightingMode.MATRIX)
        self.engine = AutoGlowEngine(device_config=self.dev, app_config=self.cfg)
        self.storage = GameFlowStorageManager(os.path.join(self.tmp, "game_flows.json"))
        self.engine.game_flow_storage = self.storage
        app["engine"] = self.engine
        app["current_app_config"] = self.cfg
        app["config_path"] = os.path.join(self.tmp, "config.json")
        register_flow_routes(app)
        return app

    async def test_overview_lists_profiles_lights_and_the_catalog(self):
        data = await (await self.client.get("/api/flow/overview")).json()
        self.assertEqual([p["name"] for p in data["profiles"]], ["Classic"])
        self.assertEqual(len(data["catalog"]["effects"]), 7)
        self.assertEqual(len(data["catalog"]["transitions"]), 5)
        self.assertEqual(len(data["presets"]), 5)
        segs = data["lights"][0]["segments"]
        self.assertEqual(segs[0]["profile"], "Classic")
        self.assertTrue(segs[1]["light_strip"])
        self.assertIsNone(segs[1]["profile"])
        self.assertEqual(data["profiles"][0]["used_by"][0]["segment_name"], "Ring")

    async def test_create_from_preset_copy_rename_and_delete(self):
        r = await self.client.post("/api/flow/profile/create", json={"name": "Party night", "preset": "party"})
        self.assertEqual(r.status, 200)
        self.assertEqual((await r.json())["flow"]["preset"], "party")
        r = await self.client.post("/api/flow/profile/create", json={"name": "Copy", "copy_from": "Party night"})
        self.assertEqual(r.status, 200)
        r = await self.client.post("/api/flow/profile/create", json={"name": "Copy"})
        self.assertEqual(r.status, 400, "names are unique")
        flow = (await (await self.client.get("/api/flow/profile?name=Copy")).json())["flow"]
        flow["name"] = "Renamed"
        r = await self.client.post("/api/flow/profile/save", json={"flow": flow, "old_name": "Copy"})
        self.assertEqual(r.status, 200)
        self.assertIn("Renamed", self.storage.profile_names())
        r = await self.client.post("/api/flow/profile/delete", json={"name": "Renamed"})
        self.assertEqual(r.status, 200)
        self.assertEqual(self.storage.profile_names(), ["Classic", "Party night"])

    async def test_saved_flow_is_cleaned(self):
        flow = (await (await self.client.get("/api/flow/profile")).json())["flow"]
        flow["steps"]["turn"]["effect"]["enabled"] = False
        flow["steps"]["leg_won"]["effect"]["animation"] = "radar"
        r = await self.client.post("/api/flow/profile/save", json={"flow": flow, "old_name": "Classic"})
        saved = (await r.json())["flow"]
        self.assertTrue(saved["steps"]["turn"]["effect"]["enabled"])
        self.assertEqual(saved["steps"]["leg_won"]["effect"]["animation"], "chase")

    async def test_empty_name_and_last_profile_are_refused(self):
        flow = (await (await self.client.get("/api/flow/profile")).json())["flow"]
        flow["name"] = "  "
        r = await self.client.post("/api/flow/profile/save", json={"flow": flow, "old_name": "Classic"})
        self.assertEqual(r.status, 400)
        r = await self.client.post("/api/flow/profile/delete", json={"name": "Classic"})
        self.assertEqual(r.status, 400)

    async def test_assign_and_reset(self):
        await self.client.post("/api/flow/profile/create", json={"name": "Minimal", "preset": "minimal"})
        r = await self.client.post("/api/flow/assign", json={"ip": "192.168.1.100", "segment_id": 0, "name": "Minimal"})
        self.assertEqual(r.status, 200)
        self.assertEqual((await r.json())["lights"][0]["segments"][0]["profile"], "Minimal")
        flow = self.storage.load_profile("Minimal")
        flow.hit_locator = True
        self.storage.save_profile(flow)
        r = await self.client.post("/api/flow/profile/reset", json={"name": "Minimal"})
        self.assertFalse((await r.json())["flow"]["hit_locator"])

    async def test_try_plays_a_draft_on_the_lights(self):
        drv = self.engine.get_driver("192.168.1.100")
        drv._protocol_mode = ProtocolMode.ACTIVE_UDP
        drv.flow_show = MagicMock(return_value=True)
        drv.flow_hit = MagicMock(return_value=True)
        flow = (await (await self.client.get("/api/flow/profile")).json())["flow"]
        flow["players"][2]["color"] = [1, 2, 3]
        r = await self.client.post("/api/flow/try", json={"flow": flow, "kind": "step", "id": "turn", "player": 2})
        self.assertEqual(r.status, 200)
        eff = drv.flow_show.call_args[0][1]
        self.assertEqual(eff.color_primary.to_list(), [1, 2, 3])
        self.assertEqual(drv.flow_show.call_args[0][0], 0, "only the RGB segment, not the light strip")
        r = await self.client.post("/api/flow/try", json={"flow": flow, "kind": "hit", "id": "180"})
        self.assertEqual(r.status, 200)
        drv.flow_hit.assert_called_once()
        self.assertTrue(self.engine.lighting_test_active)

    async def test_try_is_refused_during_a_match(self):
        self.engine.autodarts = MagicMock(_active_match_id="m1", _last_match_finished=False)
        r = await self.client.post("/api/flow/try", json={"kind": "step", "id": "turn"})
        self.assertEqual(r.status, 400)
        # A finished match keeps its id until the board goes idle, but no longer blocks trying looks
        self.engine.autodarts = MagicMock(_active_match_id="m1", _last_match_finished=True)
        data = await (await self.client.get("/api/flow/overview")).json()
        self.assertFalse(data["match_running"])

    async def test_lighting_mode_api(self):
        data = await (await self.client.get("/api/flow/mode")).json()
        self.assertEqual(data["mode"], "matrix")
        r = await self.client.post("/api/flow/mode", json={"mode": "flow"})
        self.assertEqual((await r.json())["mode"], "flow")
        self.assertEqual(self.engine.app_config.lighting_mode, LightingMode.FLOW)


if __name__ == "__main__":
    unittest.main()
