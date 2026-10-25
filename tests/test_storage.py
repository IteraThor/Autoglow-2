"""
Unit tests for AppConfig and Storage Serialization with Resilient Recovery
"""

import unittest
import os
import tempfile
import json

from core.models import AppConfig, DeviceConfig, SegmentConfig, ProfileConfig, EffectConfig, AnimationType, RGBColor
from core.storage import load_app_config, save_app_config, resolve_config_path


class TestStorageAndAppConfig(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "test_config.json")
        self.bak_path = f"{self.config_path}.bak"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_resolve_config_path(self):
        p1 = resolve_config_path(None)
        self.assertTrue(os.path.isabs(p1))
        self.assertTrue(p1.endswith("config.json"))

        custom_abs = os.path.join(self.temp_dir.name, "custom.json")
        p2 = resolve_config_path(custom_abs)
        self.assertEqual(p2, custom_abs)

        p3 = resolve_config_path("relative.json")
        self.assertTrue(os.path.isabs(p3))
        self.assertTrue(p3.endswith("relative.json"))

    def test_load_default_when_file_missing(self):
        cfg = load_app_config(self.config_path)
        self.assertIsInstance(cfg, AppConfig)
        self.assertEqual(cfg.global_brightness, 200)
        self.assertIsNotNone(cfg.profile)
        self.assertIn("180", cfg.profile.events)

    def test_fresh_config_has_no_controller_after_restart(self):
        # A new install must not invent a controller address on its own
        self.assertTrue(save_app_config(AppConfig(), self.config_path))
        cfg = load_app_config(self.config_path)
        self.assertEqual(cfg.devices, [])
        self.assertEqual(cfg.active_ips, [])

    def test_legacy_ai_keys_load_and_are_dropped(self):
        # The AI Copilot was removed; configs written before that must still load and shed its keys on save
        with open(self.config_path, "w") as f:
            json.dump({"devices": [{"ip": "192.168.1.50"}], "ai_key": "AIzaOLD", "gemini_api_key": "AIzaOLD"}, f)
        cfg = load_app_config(self.config_path)
        self.assertEqual(cfg.devices[0].ip, "192.168.1.50")
        self.assertTrue(save_app_config(cfg, self.config_path))
        with open(self.config_path) as f:
            saved = json.load(f)
        self.assertNotIn("ai_key", saved)
        self.assertNotIn("gemini_api_key", saved)

    def test_save_and_load_roundtrip_multi_device(self):
        dev1 = DeviceConfig(
            id="dev_1",
            name="Ring Light",
            ip="192.168.1.50",
            udp_port=21324,
            rgb_count=60,
            pwm_index=60,
            segments=[
                SegmentConfig(id=0, name="Ring", type="WS281x", gpio="GPIO 33", start=0, length=60)
            ]
        )
        dev2 = DeviceConfig(
            id="dev_2",
            name="Surround Light",
            ip="192.168.1.51",
            udp_port=21324,
            rgb_count=120,
            pwm_index=120,
            segments=[
                SegmentConfig(id=0, name="Surround", type="WS281x", gpio="GPIO 16", start=0, length=120)
            ]
        )
        prof = ProfileConfig(name="CustomProfile")
        prof.events["180"] = EffectConfig(
            animation=AnimationType.RAINBOW,
            color_primary=RGBColor(255, 0, 0),
            duration=3.5,
            speed=2.0
        )

        app_cfg = AppConfig(
            devices=[dev1, dev2],
            profile=prof,
            global_brightness=220,
            autodarts_user="henry@example.com",
            disconnect_udp_on_match_end=True
        )

        # Save to disk
        ok = save_app_config(app_cfg, self.config_path)
        self.assertTrue(ok)
        self.assertTrue(os.path.exists(self.config_path))

        # Load back
        loaded = load_app_config(self.config_path)
        self.assertEqual(len(loaded.devices), 2)
        self.assertEqual(loaded.devices[0].name, "Ring Light")
        self.assertEqual(loaded.devices[0].ip, "192.168.1.50")
        self.assertEqual(len(loaded.devices[0].segments), 1)
        self.assertEqual(loaded.devices[1].name, "Surround Light")
        self.assertEqual(loaded.devices[1].ip, "192.168.1.51")
        self.assertEqual(loaded.profile.events["180"].animation, AnimationType.RAINBOW)
        self.assertEqual(loaded.profile.events["180"].duration, 3.5)
        self.assertEqual(loaded.autodarts_user, "henry@example.com")
        self.assertTrue(loaded.disconnect_udp_on_match_end)
        self.assertEqual(loaded.primary_device.ip, "192.168.1.50")

    def test_backup_created_on_second_save(self):
        cfg1 = AppConfig(autodarts_user="first@test.com")
        save_app_config(cfg1, self.config_path)
        self.assertTrue(os.path.exists(self.config_path))

        cfg2 = AppConfig(autodarts_user="second@test.com")
        save_app_config(cfg2, self.config_path)

        self.assertTrue(os.path.exists(self.bak_path))
        with open(self.bak_path, "r", encoding="utf-8") as f:
            bak_data = json.load(f)
        self.assertEqual(bak_data.get("autodarts_user"), "first@test.com")

    def test_recover_from_zero_byte_config_via_bak(self):
        # 1. Save valid config
        valid_cfg = AppConfig(autodarts_user="saved@valid.com", global_brightness=240)
        save_app_config(valid_cfg, self.config_path)

        # 2. Save second config so .bak exists
        valid_cfg.global_brightness = 250
        save_app_config(valid_cfg, self.config_path)
        self.assertTrue(os.path.exists(self.bak_path))

        # 3. Simulate sudden crash/truncation leaving config.json 0 bytes
        with open(self.config_path, "w", encoding="utf-8"):
            pass  # Truncate to 0 bytes
        self.assertEqual(os.path.getsize(self.config_path), 0)

        # 4. Load should recover from .bak
        recovered = load_app_config(self.config_path)
        self.assertEqual(recovered.autodarts_user, "saved@valid.com")
        self.assertEqual(recovered.global_brightness, 240)

        # 5. Primary file should be auto-healed
        self.assertGreater(os.path.getsize(self.config_path), 0)

    def test_recover_and_quarantine_corrupted_json(self):
        # 1. Save valid config and create .bak
        valid_cfg = AppConfig(autodarts_user="good@data.com")
        save_app_config(valid_cfg, self.config_path)
        save_app_config(valid_cfg, self.config_path)

        # 2. Corrupt primary file with garbage text
        with open(self.config_path, "w", encoding="utf-8") as f:
            f.write("{corrupt-json-truncated: 123,,")

        # 3. Load should quarantine and recover from .bak
        recovered = load_app_config(self.config_path)
        self.assertEqual(recovered.autodarts_user, "good@data.com")

        # 4. Check that quarantine file was created
        quarantine_files = [f for f in os.listdir(self.temp_dir.name) if "corrupt_" in f]
        self.assertGreater(len(quarantine_files), 0)


if __name__ == "__main__":
    unittest.main()
