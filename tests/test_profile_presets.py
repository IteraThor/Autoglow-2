import tempfile
import os
import unittest
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core.models import DeviceConfig, ProfileConfig, AppConfig, EffectConfig, AnimationType
from core.engine import AutoGlowEngine
from core.storage import save_app_config, load_app_config
from routes import register_routes


class TestProfilePresets(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_config_path = os.path.join(self.temp_dir.name, "test_config.json")
        self.temp_presets_dir = os.path.join(self.temp_dir.name, "presets")
        os.makedirs(self.temp_presets_dir, exist_ok=True)
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        test_engine = AutoGlowEngine(DeviceConfig(ip="127.0.0.1"))
        test_cfg = AppConfig()
        save_app_config(test_cfg, self.temp_config_path)

        app["config_path"] = self.temp_config_path
        app["presets_dir"] = self.temp_presets_dir
        app["engine"] = test_engine
        app["current_app_config"] = test_cfg
        return app

    def test_app_config_backward_compatibility(self):
        """Verify that loading legacy dict without 'profiles' correctly initializes multi-profile structure."""
        legacy_data = {
            "profile": {
                "name": "CustomLegacy",
                "events": {
                    "match_won": {
                        "animation": "rainbow",
                        "color_primary": [0, 255, 0],
                        "duration": 5.0,
                        "enabled": True
                    }
                }
            }
        }
        cfg = AppConfig.from_dict(legacy_data)
        self.assertEqual(len(cfg.profiles), 1)
        self.assertEqual(cfg.active_profile, "CustomLegacy")
        self.assertEqual(cfg.profile.name, "CustomLegacy")
        self.assertIn("match_won", cfg.profile.events)
        self.assertEqual(cfg.profile.events["match_won"].animation, AnimationType.RAINBOW)

    @unittest_run_loop
    async def test_get_presets_route(self):
        resp = await self.client.request("GET", "/api/matrix/presets")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["active_profile"], "Default")
        self.assertIn("Default", data["presets"])

    @unittest_run_loop
    async def test_save_and_select_preset_flow(self):
        # 1. Create / Save new preset "Party Mode"
        custom_profile = ProfileConfig.get_default_profile()
        custom_profile.name = "Party Mode"
        custom_profile.events["180"] = EffectConfig(animation=AnimationType.FLASH, duration=2.5, enabled=True)

        resp = await self.client.request("POST", "/api/matrix/presets/save", json={
            "name": "Party Mode",
            "profile": custom_profile.to_dict(),
            "set_active": True
        })
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["active_profile"], "Party Mode")
        self.assertIn("Party Mode", data["presets"])
        self.assertEqual(self.app["engine"].profile.name, "Party Mode")

        # 2. Select back to "Default"
        resp = await self.client.request("POST", "/api/matrix/presets/select", json={"name": "Default"})
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["active_profile"], "Default")
        self.assertEqual(self.app["engine"].profile.name, "Default")

        # 3. Select back to "Party Mode"
        resp = await self.client.request("POST", "/api/matrix/presets/select", json={"name": "Party Mode"})
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["active_profile"], "Party Mode")
        self.assertEqual(self.app["engine"].profile.events["180"].duration, 2.5)

    @unittest_run_loop
    async def test_rename_preset(self):
        # Save "TestPreset"
        await self.client.request("POST", "/api/matrix/presets/save", json={"name": "TestPreset", "set_active": True})

        # Rename to "Carnival"
        resp = await self.client.request("POST", "/api/matrix/presets/rename", json={
            "old_name": "TestPreset",
            "new_name": "Carnival"
        })
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("Carnival", data["presets"])
        self.assertNotIn("TestPreset", data["presets"])
        self.assertEqual(data["active_profile"], "Carnival")

    @unittest_run_loop
    async def test_rename_guards(self):
        # Renaming 'Default' must fail
        resp = await self.client.request("POST", "/api/matrix/presets/rename", json={
            "old_name": "Default",
            "new_name": "RenamedDefault"
        })
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertIn("cannot be renamed", data["message"])

    @unittest_run_loop
    async def test_delete_preset_and_fallbacks(self):
        # Save "DeleteMe"
        await self.client.request("POST", "/api/matrix/presets/save", json={"name": "DeleteMe", "set_active": True})

        # Delete "DeleteMe"
        resp = await self.client.request("DELETE", "/api/matrix/presets", json={"name": "DeleteMe"})
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertNotIn("DeleteMe", data["presets"])
        self.assertEqual(data["active_profile"], "Default")

    @unittest_run_loop
    async def test_delete_guards(self):
        # Cannot delete 'Default'
        resp = await self.client.request("DELETE", "/api/matrix/presets", json={"name": "Default"})
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertIn("cannot be deleted", data["message"])

        # If only 1 preset remains, cannot delete
        cfg = load_app_config(self.temp_config_path)
        cfg.profiles = [ProfileConfig(name="OnlyOne")]
        cfg.active_profile = "OnlyOne"
        save_app_config(cfg, self.temp_config_path)

        resp = await self.client.request("DELETE", "/api/matrix/presets", json={"name": "OnlyOne"})
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertIn("only remaining preset", data["message"])

    @unittest_run_loop
    async def test_export_preset_route(self):
        resp = await self.client.request("GET", "/api/matrix/presets/export?name=Default")
        self.assertEqual(resp.status, 200)
        self.assertIn("attachment", resp.headers.get("Content-Disposition", ""))
        self.assertIn("Default.json", resp.headers.get("Content-Disposition", ""))
        data = await resp.json()
        self.assertEqual(data["name"], "Default")

    @unittest_run_loop
    async def test_import_preset_route(self):
        import_payload = {
            "name": "CommunityPack_Blue",
            "events": {
                "bullseye": {
                    "animation": "wipe",
                    "color_primary": [0, 0, 255],
                    "duration": 4.0,
                    "enabled": True
                }
            }
        }
        resp = await self.client.request("POST", "/api/matrix/presets/import", json=import_payload)
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["active_profile"], "CommunityPack_Blue")
        self.assertIn("CommunityPack_Blue", data["presets"])
        self.assertIn("bullseye", data["profile"]["events"])

        # Verify it was saved to the presets directory on disk
        preset_file = os.path.join(self.temp_presets_dir, "CommunityPack_Blue.json")
        self.assertTrue(os.path.exists(preset_file))

    @unittest_run_loop
    async def test_disk_folder_sync(self):
        # Simulate someone dropping a .json file directly into the presets/ folder
        import json
        external_file = os.path.join(self.temp_presets_dir, "SharedFromFriend.json")
        with open(external_file, "w", encoding="utf-8") as f:
            json.dump({
                "name": "SharedFromFriend",
                "events": {}
            }, f)

        # Query GET presets - should discover the file from disk automatically
        resp = await self.client.request("GET", "/api/matrix/presets")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertIn("SharedFromFriend", data["presets"])


if __name__ == "__main__":
    unittest.main()
