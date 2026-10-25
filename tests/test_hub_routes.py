"""
Tests for the Hub routes: /api/hub/status and the first-run checklist.
"""

import os
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core.engine import AutoGlowEngine
from core.models import AppConfig, DeviceConfig, EffectConfig, LightingMode, ProfileConfig, ProtocolMode
from routes import register_routes


class TestHubRoutes(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        app["config_path"] = os.path.join(self.temp_dir.name, "config.json")
        self.engine = AutoGlowEngine(DeviceConfig(ip=""))
        app["engine"] = self.engine
        app["current_app_config"] = AppConfig()
        return app

    async def checklist(self):
        resp = await self.client.get("/api/setup/checklist")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        return {s["id"]: s["done"] for s in data["steps"]}, data["complete"]

    @unittest_run_loop
    async def test_fresh_install_has_nothing_done(self):
        steps, complete = await self.checklist()
        self.assertEqual(steps, {"controller": False, "autodarts": False, "lighting": False})
        self.assertFalse(complete)

    @unittest_run_loop
    async def test_steps_follow_config_and_live_state(self):
        profile = ProfileConfig(name="Default", device_events={"10.0.0.5": {"0": {"180": EffectConfig(enabled=True)}}})
        self.app["current_app_config"] = AppConfig(devices=[DeviceConfig(ip="10.0.0.5")], profile=profile, profiles=[profile])
        self.engine.autodarts = SimpleNamespace(is_connected=True)
        steps, complete = await self.checklist()
        self.assertEqual(steps, {"controller": True, "autodarts": True, "lighting": True})
        self.assertTrue(complete)

    @unittest_run_loop
    async def test_effects_for_removed_controllers_do_not_count(self):
        profile = ProfileConfig(name="Default", device_events={"10.0.0.99": {"0": {"180": EffectConfig(enabled=True)}}})
        self.app["current_app_config"] = AppConfig(devices=[DeviceConfig(ip="10.0.0.5")], profile=profile, profiles=[profile])
        steps, _ = await self.checklist()
        self.assertFalse(steps["lighting"])

    @unittest_run_loop
    async def test_flow_mode_counts_as_lighting_set_up(self):
        self.app["current_app_config"] = AppConfig(lighting_mode=LightingMode.FLOW)
        steps, _ = await self.checklist()
        self.assertTrue(steps["lighting"])

    @unittest_run_loop
    async def test_hub_status_without_controllers(self):
        resp = await self.client.get("/api/hub/status")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["devices"], [])
        self.assertIn("engine", data)
        self.assertIn("autodarts", data)

    async def device_playing(self):
        resp = await self.client.get("/api/hub/status")
        self.assertEqual(resp.status, 200)
        return (await resp.json())["devices"][0].get("playing")

    @unittest_run_loop
    async def test_streaming_controller_reports_effects_or_idle(self):
        self.app["current_app_config"] = AppConfig(devices=[DeviceConfig(ip="10.0.0.5")])
        drv = SimpleNamespace(protocol_mode=ProtocolMode.ACTIVE_UDP, is_playing_effects=True)
        self.engine.drivers = {"10.0.0.5": drv}
        self.assertEqual(await self.device_playing(), "effects")
        drv.is_playing_effects = False
        self.assertEqual(await self.device_playing(), "idle")

    @unittest_run_loop
    async def test_idle_controller_reports_its_power(self):
        self.app["current_app_config"] = AppConfig(devices=[DeviceConfig(ip="10.0.0.5")])
        with patch("routes.hub_routes.WLEDDriver.fetch_device_health", return_value={"online": True, "on": True, "warnings": []}):
            self.assertEqual(await self.device_playing(), "idle")
        with patch("routes.hub_routes.WLEDDriver.fetch_device_health", return_value={"online": True, "on": False, "warnings": []}):
            self.assertEqual(await self.device_playing(), "off")
        with patch("routes.hub_routes.WLEDDriver.fetch_device_health", return_value={"online": False, "warnings": []}):
            self.assertIsNone(await self.device_playing())


class _FakeDriver:
    protocol_mode = None

    def __init__(self):
        self.board_light = None

    async def transition_to_http_mode(self, restore_preset_id: int = 1) -> bool:
        return True

    async def set_board_light(self, brightness: int, target_ip=None) -> bool:
        self.board_light = brightness
        return True


class TestPerControllerPower(AioHTTPTestCase):
    """The Hub's Wake / Dim / Off buttons target one controller via {"ip": ...}."""

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        self.engine = AutoGlowEngine(DeviceConfig(ip=""))
        self.a, self.b = _FakeDriver(), _FakeDriver()
        self.engine.drivers = {"10.0.0.5": self.a, "10.0.0.6": self.b}
        app["engine"] = self.engine
        app["current_app_config"] = AppConfig(devices=[DeviceConfig(ip="10.0.0.5"), DeviceConfig(ip="10.0.0.6")])
        return app

    @unittest_run_loop
    async def test_off_touches_only_the_requested_controller(self):
        calls = []
        def fake_power(ip, turn_on):
            calls.append((ip, turn_on))
            return {"ip": ip, "success": True}
        with patch("routes.power_routes._sync_set_wled_power", fake_power):
            resp = await self.client.post("/api/power/test_off", json={"ip": "10.0.0.5"})
        self.assertEqual(resp.status, 200)
        self.assertEqual(calls, [("10.0.0.5", False)])
        self.assertEqual(self.a.board_light, 0)
        self.assertIsNone(self.b.board_light)
        self.assertFalse(self.engine.is_board_off)

    @unittest_run_loop
    async def test_dim_one_controller_leaves_engine_state(self):
        resp = await self.client.post("/api/power/test_dim", json={"ip": "10.0.0.6"})
        self.assertEqual(resp.status, 200)
        self.assertIsNotNone(self.b.board_light)
        self.assertIsNone(self.a.board_light)
        self.assertFalse(self.engine.is_board_dimmed)

    @unittest_run_loop
    async def test_unknown_controller_is_404(self):
        for path in ("/api/power/test_wake", "/api/power/test_dim", "/api/power/test_off"):
            resp = await self.client.post(path, json={"ip": "10.0.0.99"})
            self.assertEqual(resp.status, 404, path)
