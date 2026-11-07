"""
Tests for per-controller profiles: one shared preset list, each controller picks the one it uses.
"""

import os
import tempfile

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core.engine import AutoGlowEngine
from core.models import AppConfig, DeviceConfig, EffectConfig, AnimationType, ProfileConfig, SegmentConfig, LightingMode
from core.storage import save_app_config, load_app_config
from routes import register_routes

A, B = "10.0.0.5", "10.0.0.6"


def _profile(name: str, ip: str = "") -> ProfileConfig:
    p = ProfileConfig.get_default_profile()
    p.name = name
    p.events["180"] = EffectConfig(animation=AnimationType.FLASH, enabled=True)
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
        self.assertEqual(data["profile"]["events"]["180"]["animation"], "flash")
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


class TestLegacyPerControllerEffects(AioHTTPTestCase):
    """Profiles from before 2.3 held effects per controller and segment; they are split per controller."""

    async def get_application(self):
        return web.Application()

    def legacy(self):
        flash = EffectConfig(animation=AnimationType.FLASH, enabled=True).to_dict()
        red = EffectConfig(animation=AnimationType.SOLID, enabled=True).to_dict()
        cfg = AppConfig(devices=[DeviceConfig(ip=A, name="Ring"), DeviceConfig(ip=B, name="Strip")]).to_dict()
        profile = ProfileConfig.get_default_profile().to_dict()
        profile["device_events"] = {
            A: {"0": {"180": flash, "player_1": red}, "gpio_16_ws281x_0": {"180": flash}},
            B: {"0": {"180": red}},
        }
        cfg["profiles"] = [profile]
        cfg["active_profile"] = "Default"
        cfg["device_profiles"] = {A: "Default"}
        return cfg

    def test_each_controller_gets_its_own_profile(self):
        cfg = AppConfig.from_dict(self.legacy())
        self.assertEqual(cfg.device_profiles, {A: "Default - Ring", B: "Default - Strip"})
        self.assertEqual([p.name for p in cfg.profiles], ["Default", "Default - Ring", "Default - Strip"])
        self.assertEqual(cfg.profile_for(A).get_effect("180").animation, AnimationType.FLASH)
        self.assertEqual(cfg.profile_for(B).get_effect("180").animation, AnimationType.SOLID)
        self.assertEqual(cfg.active_profile, "Default")

    def test_player_entries_become_slot_effects(self):
        cfg = AppConfig.from_dict(self.legacy())
        slot = next(s for s in cfg.profile_for(A).player_slots if s.id == 1)
        self.assertTrue(slot.enabled)
        self.assertTrue(slot.effect.enabled)

    def test_saved_config_has_no_per_controller_effects(self):
        data = AppConfig.from_dict(self.legacy()).to_dict()
        self.assertTrue(all("device_events" not in p for p in data["profiles"]))
        self.assertEqual(AppConfig.from_dict(data).device_profiles, {A: "Default - Ring", B: "Default - Strip"})

    def test_old_preset_file_keeps_first_controllers_effects(self):
        raw = self.legacy()["profiles"][0]
        profile = ProfileConfig.from_dict(raw)
        self.assertEqual(profile.get_effect("180").animation, AnimationType.FLASH)


class TestSegmentProfiles(AioHTTPTestCase):

    async def get_application(self):
        return web.Application()

    def config(self):
        dev = DeviceConfig(ip=A, segments=[SegmentConfig(id=0, name="Ring"), SegmentConfig(id=1, name="Strip")])
        cfg = AppConfig(devices=[dev], profiles=[ProfileConfig.get_default_profile(), _profile("Party")])
        cfg.device_profiles = {A: "Default"}
        return cfg

    def test_segment_choice_overrides_controller_choice(self):
        cfg = self.config()
        self.assertTrue(cfg.set_segment_profile(A, 1, "Party"))
        self.assertEqual(cfg.profile_name_for(A, 0), "Default")
        self.assertEqual(cfg.profile_name_for(A, 1), "Party")
        self.assertEqual(AppConfig.from_dict(cfg.to_dict()).profile_name_for(A, 1), "Party")

    def test_controller_choice_replaces_segment_choices(self):
        cfg = self.config()
        cfg.set_segment_profile(A, 1, "Party")
        cfg.set_device_profile(A, "Default")
        self.assertEqual(cfg.profile_name_for(A, 1), "Default")

    def test_rename_and_delete_follow_segment_choices(self):
        cfg = self.config()
        cfg.set_segment_profile(A, 1, "Party")
        cfg.rename_profile_refs("Party", "Fiesta")
        self.assertEqual(cfg.segment_profiles, {A: {"1": "Fiesta"}})
        cfg.drop_profile_refs("Fiesta")
        self.assertEqual(cfg.segment_profiles, {})

    def test_engine_plays_each_segments_profile(self):
        import asyncio
        from unittest.mock import AsyncMock
        from core.models import DartEvent, DartEventType
        cfg = self.config()
        cfg.profile.events["single"] = EffectConfig(animation=AnimationType.SOLID, enabled=True, duration=0.5)
        cfg.get_profile("Party").events["single"] = EffectConfig(animation=AnimationType.FLASH, enabled=True, duration=0.5)
        cfg.set_segment_profile(A, 1, "Party")
        engine = AutoGlowEngine(cfg.devices[0], cfg.profile, app_config=cfg)
        engine.app_config.lighting_mode = LightingMode.MATRIX  # these tests cover the Event Matrix
        drv = engine.get_driver(A)
        drv.play_effect = AsyncMock()
        asyncio.run(engine.process_event(DartEvent(event_type=DartEventType.SINGLE, score=20, segment_name="S20")))
        played = {c[1]["segment_id"]: c[0][0].animation for c in drv.play_effect.call_args_list}
        self.assertEqual(played, {0: AnimationType.SOLID, 1: AnimationType.FLASH})
