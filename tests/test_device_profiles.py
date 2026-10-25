"""
Tests for per-controller profiles: one shared preset list, each controller picks the one it uses.
"""

import os
import tempfile

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core.engine import AutoGlowEngine
from core.models import AppConfig, DeviceConfig, EffectConfig, AnimationType, ProfileConfig
from core.storage import save_app_config, load_app_config
from routes import register_routes

A, B = "10.0.0.5", "10.0.0.6"


def _profile(name: str, ip: str) -> ProfileConfig:
    p = ProfileConfig.get_default_profile()
    p.name = name
    p.device_events = {ip: {"0": {"180": EffectConfig(animation=AnimationType.FLASH, enabled=True)}}}
    return p


class TestAppConfigDeviceProfiles(AioHTTPTestCase):

    async def get_application(self):
        return web.Application()

    def test_round_trip_keeps_known_choices_only(self):
        cfg = AppConfig(devices=[DeviceConfig(ip=A)], profiles=[ProfileConfig.get_default_profile(), _profile("Party", A)])
        cfg.device_profiles = {A: "Party"}
        data = cfg.to_dict()
        data["device_profiles"]["10.0.0.9"] = "Gone"
        loaded = AppConfig.from_dict(data)
        self.assertEqual(loaded.device_profiles, {A: "Party"})
        self.assertEqual(loaded.profile_for(A).name, "Party")
        self.assertEqual(loaded.profile_for(B).name, "Default")

    def test_engine_uses_each_controllers_profile(self):
        party = _profile("Party", A)
        cfg = AppConfig(devices=[DeviceConfig(ip=A), DeviceConfig(ip=B)], profiles=[ProfileConfig.get_default_profile(), party])
        cfg.device_profiles = {A: "Party"}
        engine = AutoGlowEngine(DeviceConfig(ip=""), app_config=cfg, profile_config=cfg.profile)
        self.assertIs(engine._profile_for(A), party)
        self.assertEqual(engine._profile_for(B).name, "Default")


class TestDeviceProfileRoutes(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "config.json")
        self.presets_dir = os.path.join(self.temp_dir.name, "presets")
        os.makedirs(self.presets_dir, exist_ok=True)
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        cfg = AppConfig(devices=[DeviceConfig(ip=A), DeviceConfig(ip=B)],
                        profiles=[ProfileConfig.get_default_profile(), _profile("Party", A)])
        save_app_config(cfg, self.config_path)
        app["config_path"] = self.config_path
        app["presets_dir"] = self.presets_dir
        app["engine"] = AutoGlowEngine(DeviceConfig(ip=""), app_config=cfg)
        app["current_app_config"] = cfg
        return app

    async def select(self, name, ip):
        resp = await self.client.post("/api/matrix/presets/select", json={"name": name, "ip": ip})
        self.assertEqual(resp.status, 200)
        return await resp.json()

    @unittest_run_loop
    async def test_select_for_one_controller_leaves_the_other(self):
        data = await self.select("Party", A)
        self.assertEqual(data["active_profile"], "Party")
        self.assertEqual(data["device_profiles"], {A: "Party", B: "Default"})
        self.assertIn(A, data["profile"]["device_events"])
        cfg = load_app_config(self.config_path)
        self.assertEqual(cfg.active_profile, "Default")
        self.assertEqual(self.app["engine"]._profile_for(A).name, "Party")
        self.assertEqual(self.app["engine"]._profile_for(B).name, "Default")

        resp = await self.client.get(f"/api/matrix/presets?ip={B}")
        self.assertEqual((await resp.json())["active_profile"], "Default")

    @unittest_run_loop
    async def test_save_with_ip_activates_for_that_controller_only(self):
        resp = await self.client.post("/api/matrix/presets/save", json={"name": "Night", "ip": B, "set_active": True})
        self.assertEqual(resp.status, 200)
        cfg = load_app_config(self.config_path)
        self.assertEqual(cfg.device_profiles, {B: "Night"})
        self.assertEqual(cfg.active_profile, "Default")

    @unittest_run_loop
    async def test_rename_and_delete_follow_controller_choices(self):
        await self.select("Party", A)
        resp = await self.client.post("/api/matrix/presets/rename", json={"old_name": "Party", "new_name": "Fiesta", "ip": A})
        self.assertEqual((await resp.json())["active_profile"], "Fiesta")
        self.assertEqual(load_app_config(self.config_path).device_profiles, {A: "Fiesta"})

        resp = await self.client.delete("/api/matrix/presets", json={"name": "Fiesta", "ip": A})
        self.assertEqual((await resp.json())["active_profile"], "Default")
        self.assertEqual(load_app_config(self.config_path).device_profiles, {})

    @unittest_run_loop
    async def test_settings_save_without_choices_keeps_them(self):
        await self.select("Party", A)
        payload = load_app_config(self.config_path).to_dict()
        payload.pop("device_profiles")
        resp = await self.client.post("/api/config", json=payload)
        self.assertEqual(resp.status, 200)
        self.assertEqual(load_app_config(self.config_path).device_profiles, {A: "Party"})
