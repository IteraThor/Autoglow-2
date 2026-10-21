"""
Tests for the game flow cache, its fixed location, and the engine's per-dart flow lookups.
"""

import builtins
import os
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core import game_flow
from core.engine import AutoGlowEngine
from core.game_flow import DEFAULT_FLOW_PATH, GameFlowStorageManager, create_default_game_flow
from core.models import AppConfig, DartEvent, DartEventType, DeviceConfig, LightingMode, SegmentConfig
from core.wled_driver import WLEDDriver
from routes import register_routes


def _count_opens(path):
    """Patch open() to count how often `path` is opened; returns (patcher, counter)."""
    real_open = builtins.open
    counter = {"n": 0}

    def counting_open(file, *args, **kwargs):
        if os.path.abspath(str(file)) == os.path.abspath(path):
            counter["n"] += 1
        return real_open(file, *args, **kwargs)

    return patch("builtins.open", side_effect=counting_open), counter


class TestFlowStorageCache(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.path = os.path.join(self.temp_dir, "game_flows.json")
        self.mgr = GameFlowStorageManager(self.path)
        self.mgr.save(create_default_game_flow())

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_repeated_lookups_do_not_read_the_file(self):
        first = self.mgr.get_for_segment("10.0.0.5", 0)
        patcher, opens = _count_opens(self.path)
        with patcher:
            for _ in range(50):
                self.assertIs(self.mgr.get_for_segment("10.0.0.5", 0), first)
        self.assertEqual(opens["n"], 0)

    def test_load_returns_an_editable_copy(self):
        copy_a = self.mgr.load()
        copy_a.name = "edited but not saved"
        self.assertNotEqual(self.mgr.get().name, "edited but not saved")
        self.assertIsNot(self.mgr.load_for_segment("10.0.0.5", 0), self.mgr.get_for_segment("10.0.0.5", 0))

    def test_save_from_another_instance_is_picked_up(self):
        self.mgr.get()
        other = GameFlowStorageManager(self.path)
        flow = other.load()
        flow.name = "Saved elsewhere"
        self.assertTrue(other.save_for_segment(flow, "10.0.0.5", 1))
        self.assertEqual(self.mgr.get_for_segment("10.0.0.5", 1).name, "Saved elsewhere")

    def test_own_save_refreshes_the_cache(self):
        flow = self.mgr.load()
        flow.name = "Segment flow"
        self.assertTrue(self.mgr.save_for_segment(flow, "10.0.0.5", 0))
        self.assertEqual(self.mgr.get_for_segment("10.0.0.5", 0).name, "Segment flow")

    def test_failed_write_keeps_the_cache_unchanged(self):
        before = self.mgr.get_for_segment("10.0.0.5", 0).name
        flow = self.mgr.load()
        flow.name = "Never written"
        with patch("core.game_flow.os.replace", side_effect=OSError("disk full")):
            with self.assertLogs("autoglow.game_flow", level="ERROR"):
                self.assertFalse(self.mgr.save_for_segment(flow, "10.0.0.5", 0))
        self.assertEqual(self.mgr.get_for_segment("10.0.0.5", 0).name, before)
        self.assertEqual([f for f in os.listdir(self.temp_dir) if f.startswith("tmp")], [])


class TestFlowFileLocation(unittest.TestCase):

    def setUp(self):
        self.old_cwd = os.getcwd()
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        os.chdir(self.old_cwd)
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_default_path_does_not_depend_on_working_directory(self):
        os.chdir(self.temp_dir)
        self.assertEqual(GameFlowStorageManager().filepath, DEFAULT_FLOW_PATH)
        self.assertTrue(os.path.isabs(DEFAULT_FLOW_PATH))

    def test_flow_file_from_old_working_directory_is_adopted_once(self):
        os.chdir(self.temp_dir)
        with open("game_flows.json", "w") as f:
            f.write('{"name": "From the old location"}')
        target = os.path.join(self.temp_dir, "project", "game_flows.json")
        os.makedirs(os.path.dirname(target))
        with patch.dict(os.environ, {"AUTOGLOW_ALLOW_PROD_CONFIG_IN_TEST": "1"}):
            game_flow._adopt_flow_file_from_cwd(target)
            with open(target, "w") as f:
                f.write('{"name": "Edited at the new location"}')
            game_flow._adopt_flow_file_from_cwd(target)  # must not overwrite
        with open(target) as f:
            self.assertIn("new location", f.read())
        self.assertTrue(os.path.exists(os.path.join(self.temp_dir, "game_flows.json")))


class TestEngineFlowLookups(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.path = os.path.join(self.temp_dir, "game_flows.json")
        dev = DeviceConfig(ip="10.0.0.5", enabled=True, segments=[
            SegmentConfig(id=0, name="Ring", start=0, length=45),
            SegmentConfig(id=1, name="Inner", start=45, length=10),
        ])
        self.engine = AutoGlowEngine(device_config=dev, app_config=AppConfig(devices=[dev], lighting_mode=LightingMode.FLOW))
        self.engine.game_flow_storage = GameFlowStorageManager(self.path)
        self.engine.game_flow_storage.save(create_default_game_flow())
        self.engine.wake_up = AsyncMock()
        for drv in self.engine.drivers.values():
            drv.play_effect = AsyncMock()

    async def asyncTearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    async def test_hundred_darts_read_the_flow_file_at_most_once(self):
        patcher, opens = _count_opens(self.path)
        with patcher:
            for i in range(100):
                await self.engine.process_event(DartEvent(event_type=DartEventType.SINGLE, player_index=i % 2, score=20))
        self.assertLessEqual(opens["n"], 1)
        self.assertTrue(self.engine.get_driver("10.0.0.5").play_effect.called)


class TestWledUpdateSyncsDrivers(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        app["config_path"] = os.path.join(self.temp_dir, "config.json")
        self.engine = AutoGlowEngine(DeviceConfig(ip=""))
        app["engine"] = self.engine
        app["current_app_config"] = AppConfig()
        return app

    @unittest_run_loop
    async def test_new_segments_reach_the_running_driver(self):
        payload = {
            "ip": "10.0.0.7",
            "name": "Board",
            "hw_ins": [{"start": 0, "len": 45, "type": 22, "pin": [33]}],
            "state": {"seg": [{"id": 0, "n": "Ring", "start": 0, "stop": 45}]},
        }
        with patch.object(WLEDDriver, "apply_wled_mutations", return_value={}):
            resp = await self.client.post("/api/wled/update", json=payload)
        self.assertEqual(resp.status, 200)
        drv = self.engine.get_driver("10.0.0.7")
        self.assertIsNotNone(drv)
        self.assertEqual([s.name for s in drv.config.segments], ["Ring"])


if __name__ == "__main__":
    unittest.main()
