import tempfile
import os
import unittest
from unittest.mock import AsyncMock, patch
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

import server
from core.models import DeviceConfig, AppConfig, SegmentConfig
from core.engine import AutoGlowEngine
from routes import register_routes


class TestServerRoutes(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_config_path = os.path.join(self.temp_dir.name, "test_config.json")
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        test_engine = AutoGlowEngine(DeviceConfig(ip="127.0.0.1"))
        test_cfg = AppConfig(autodarts_user="test@example.com")
        
        server.engine = test_engine
        server.current_app_config = test_cfg
        app["config_path"] = getattr(self, "temp_config_path", "test_config.json")
        app["engine"] = test_engine
        app["current_app_config"] = test_cfg
        return app

    @unittest_run_loop
    async def test_get_config_route(self):
        resp = await self.client.request("GET", "/api/config")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "ok")

    @unittest_run_loop
    async def test_autodarts_status_no_name_error(self):
        resp = await self.client.request("GET", "/api/autodarts/status")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("account", data)

    @unittest_run_loop
    async def test_ai_routes_removed(self):
        for method, path in [("GET", "/api/ai/status"), ("POST", "/api/ai/key"), ("POST", "/api/ai/chat")]:
            resp = await self.client.request(method, path)
            # POSTs fall through to the GET-only static route, which answers 405 instead of 404
            self.assertIn(resp.status, (404, 405), path)

    @unittest_run_loop
    async def test_status_payloads_carry_no_stats(self):
        resp = await self.client.request("GET", "/api/autodarts/status")
        data = await resp.json()
        self.assertNotIn("stats", data)
        self.assertNotIn("event_count", data.get("match", {}))

        resp = await self.client.request("GET", "/api/hub/status")
        data = await resp.json()
        self.assertNotIn("uptime_seconds", data)
        self.assertNotIn("event_count", data["engine"])

    @unittest_run_loop
    async def test_autodarts_cloud_login_routes_on_hold(self):
        # Direct Autodarts login is on hold until Autodarts approves it; game data comes from the Chrome extension
        for path, body in [
            ("/api/autodarts/device/code", None),
            ("/api/autodarts/device/poll", {"device_code": "abc"}),
            ("/api/autodarts/login", {"email": "a@b.c", "password": "x"}),
        ]:
            resp = await self.client.request("POST", path, json=body)
            self.assertEqual(resp.status, 503, path)
            data = await resp.json()
            self.assertEqual(data["status"], "error")
            self.assertTrue(data["on_hold"])

    @unittest_run_loop
    async def test_wled_update_multi_output_ws281x(self):
        payload = {
            "ip": "192.168.2.215",
            "name": "BTF-WLED",
            "udp_port": 21324,
            "hw_ins": [
                {"pin": [16], "type": 22, "start": 0, "len": 45, "order": 0},
                {"pin": [17], "type": 22, "start": 45, "len": 45, "order": 1}
            ],
            "state": {
                "on": True,
                "bri": 255,
                "seg": [
                    {"id": 0, "n": "WS281x Strip", "start": 0, "stop": 45, "on": True, "bri": 255},
                    {"id": 1, "n": "PWM White GPIO 17", "start": 45, "stop": 90, "on": True, "bri": 255}
                ]
            }
        }
        with unittest.mock.patch("core.wled_driver.WLEDDriver.apply_wled_mutations", return_value={"status": "ok"}):
            resp = await self.client.request("POST", "/api/wled/update", json=payload)
            self.assertEqual(resp.status, 200)
            data = await resp.json()
            self.assertEqual(data["status"], "ok")

        cfg = self.app["current_app_config"]
        dev = next((d for d in cfg.devices if d.ip == "192.168.2.215"), None)
        self.assertIsNotNone(dev)
        self.assertEqual(len(dev.segments), 2)
        self.assertEqual(dev.segments[0].start, 0)
        self.assertEqual(dev.segments[0].length, 45)
        self.assertEqual(dev.segments[1].start, 45)
        # Verify segment 1 length is 45 (45..90), NOT truncated to 1!
        self.assertEqual(dev.segments[1].length, 45)
        self.assertIsNone(dev.pwm_index)
        self.assertEqual(dev.hw_ins[0]["order"], 0)
        self.assertEqual(dev.hw_ins[1]["order"], 1)

    @unittest_run_loop
    async def test_segments_on_one_controller_need_their_own_names(self):
        payload = {"ip": "192.168.2.215", "hw_ins": [{"pin": [16], "type": 22, "start": 0, "len": 90}],
                   "state": {"seg": [{"id": 0, "n": "Ring", "start": 0, "stop": 45},
                                     {"id": 1, "n": "ring ", "start": 45, "stop": 90}]}}
        with unittest.mock.patch("core.wled_driver.WLEDDriver.apply_wled_mutations") as apply:
            resp = await self.client.request("POST", "/api/wled/update", json=payload)
            self.assertEqual(resp.status, 400, "same name, other case and spacing")
            apply.assert_not_called()
        self.assertFalse(any(d.ip == "192.168.2.215" for d in self.app["current_app_config"].devices))

        self.app["current_app_config"].devices.append(DeviceConfig(ip="192.168.2.215", segments=[
            SegmentConfig(id=0, name="Ring"), SegmentConfig(id=1, name="Shelf")]))
        with unittest.mock.patch("core.wled_driver.WLEDDriver.rename_wled_segment") as rename:
            resp = await self.client.request("POST", "/api/wled/segment-name", json={"ip": "192.168.2.215", "segment_id": 1, "name": "RING"})
            self.assertEqual(resp.status, 400)
            rename.assert_not_called()
            resp = await self.client.request("POST", "/api/wled/segment-name", json={"ip": "192.168.2.215", "segment_id": 0, "name": "Ring"})
            self.assertEqual(resp.status, 200, "keeping its own name is fine")

    @unittest_run_loop
    async def test_wled_setup_preview_writes_nothing_to_config(self):
        payload = {"ip": "192.168.2.215", "hw_ins": [{"pin": [16], "type": 22, "start": 0, "len": 45}], "state": {"on": True}}
        with unittest.mock.patch("core.wled_driver.WLEDDriver.apply_setup_preview") as preview:
            resp = await self.client.request("POST", "/api/wled/setup-preview", json=payload)
            self.assertEqual(resp.status, 200)
            preview.assert_called_once_with("192.168.2.215", payload["hw_ins"], payload["state"])
        self.assertFalse(any(d.ip == "192.168.2.215" for d in self.app["current_app_config"].devices))

        resp = await self.client.request("POST", "/api/wled/setup-preview", json={"ip": "192.168.2.215", "hw_ins": "bad"})
        self.assertEqual(resp.status, 400)

        with unittest.mock.patch("core.wled_driver.WLEDDriver.apply_setup_preview", side_effect=OSError("timed out")):
            resp = await self.client.request("POST", "/api/wled/setup-preview", json={"ip": "192.168.2.215", "state": {"on": True}})
            self.assertEqual(resp.status, 502)

    @unittest_run_loop
    async def test_post_config_with_none_pwm_index(self):
        payload = {
            "devices": [
                {
                    "id": "device_1",
                    "name": "BTF-WLED",
                    "ip": "192.168.2.215",
                    "udp_port": 21324,
                    "rgb_count": 90,
                    "pwm_index": None,
                    "pwm_seg_id": None,
                    "default_pwm_brightness": 200,
                    "idle_dim_seconds": 300,
                    "idle_dim_brightness": 40,
                    "idle_off_seconds": 1800,
                    "enabled": True,
                    "segments": [
                        {"id": 0, "name": "WS281x Strip 1", "type": "WS281x", "start": 0, "length": 45},
                        {"id": 1, "name": "WS281x Strip 2", "type": "WS281x", "start": 45, "length": 45}
                    ],
                    "hw_ins": [
                        {"start": 0, "len": 45, "pin": [16], "type": 22},
                        {"start": 45, "len": 45, "pin": [17], "type": 22}
                    ]
                }
            ],
            "global_brightness": 200
        }
        resp = await self.client.request("POST", "/api/config", json=payload)
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "ok")

    @unittest_run_loop
    async def test_post_config_preserves_autodarts_tokens_and_credentials(self):
        test_cfg = self.app["current_app_config"]
        test_cfg.autodarts_user = "player@example.com"
        test_cfg.autodarts_password = "secure_password"
        test_cfg.autodarts_board_id = "board_123"
        test_cfg.extra["autodarts_access_token"] = "access_tok_xyz"
        test_cfg.extra["autodarts_refresh_token"] = "refresh_tok_xyz"
        test_cfg.extra["autodarts_token_expires_at"] = 9999999999.0

        payload = {
            "devices": [
                {
                    "id": "device_test",
                    "name": "WLED Primary",
                    "ip": "192.168.1.100",
                    "enabled": True,
                    "segments": [],
                    "hw_ins": []
                }
            ],
            "global_brightness": 180
        }
        resp = await self.client.request("POST", "/api/config", json=payload)
        self.assertEqual(resp.status, 200)

        saved_cfg = self.app["current_app_config"]
        self.assertEqual(saved_cfg.autodarts_user, "player@example.com")
        self.assertEqual(saved_cfg.autodarts_password, "secure_password")
        self.assertEqual(saved_cfg.autodarts_board_id, "board_123")
        self.assertEqual(saved_cfg.extra.get("autodarts_access_token"), "access_tok_xyz")
        self.assertEqual(saved_cfg.extra.get("autodarts_refresh_token"), "refresh_tok_xyz")
        self.assertEqual(saved_cfg.global_brightness, 180)

    @unittest_run_loop
    async def test_post_config_keeps_settings_the_page_did_not_send(self):
        """A page that sends only its own settings must not reset what other pages saved meanwhile."""
        test_cfg = self.app["current_app_config"]
        test_cfg.inactivity_timeout_minutes = 17
        test_cfg.global_brightness = 111
        resp = await self.client.request("POST", "/api/config", json={"global_brightness": 150})
        self.assertEqual(resp.status, 200)
        saved_cfg = self.app["current_app_config"]
        self.assertEqual(saved_cfg.global_brightness, 150)
        self.assertEqual(saved_cfg.inactivity_timeout_minutes, 17)
        self.assertEqual(saved_cfg.autodarts_user, "test@example.com")

    def test_access_log_skips_successful_reads_only(self):
        import logging
        keep = server._SkipRoutineReads()

        def line(text):
            return keep.filter(logging.LogRecord("x", logging.INFO, "", 0, text, None, None))

        self.assertFalse(line('1.2.3.4 [t] "GET /api/hub/status HTTP/1.1" 200 310 "-" "UA"'))
        self.assertTrue(line('1.2.3.4 [t] "POST /api/config HTTP/1.1" 200 20 "-" "UA"'))
        self.assertTrue(line('1.2.3.4 [t] "GET /api/hub/status HTTP/1.1" 500 20 "-" "UA"'))

    @unittest.skip("WLED Hardware Simulator is switched off for now (routes commented out in routes/__init__.py)")
    @unittest_run_loop
    async def test_simulator_status_route(self):
        resp = await self.client.request("GET", "/api/simulator/status")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertIn("simulator", data)
        self.assertIn("led_count", data["simulator"])

    @unittest_run_loop
    async def test_wled_preset_validation_routes(self):
        # 1. Invalid segment bounds (stop <= start)
        invalid_bounds_payload = {
            "ip": "192.168.1.100",
            "preset_id": 1,
            "segments": [
                {"id": 0, "start": 45, "stop": 40}
            ]
        }
        resp = await self.client.request("POST", "/api/wled/preset", json=invalid_bounds_payload)
        self.assertEqual(resp.status, 400)
        data = await resp.json()
        self.assertIn("Invalid segment bounds", data["message"])

        # 2. Segment count mismatch (configured has 2, but only 1 provided)
        cfg = self.app["current_app_config"]
        cfg.devices = [
            DeviceConfig(
                id="dev1",
                ip="192.168.1.100",
                segments=[
                    SegmentConfig(id=0, name="WS281x", start=0, length=45),
                    SegmentConfig(id=1, name="PWM White", start=45, length=1)
                ]
            )
        ]
        mismatch_payload = {
            "ip": "192.168.1.100",
            "preset_id": 1,
            "segments": [
                {"id": 0, "start": 0, "stop": 46}
            ]
        }
        resp2 = await self.client.request("POST", "/api/wled/preset", json=mismatch_payload)
        self.assertEqual(resp2.status, 400)
        data2 = await resp2.json()
        self.assertIn("Segment count mismatch", data2["message"])

        # 3. Valid segments pass through to driver
        valid_payload = {
            "ip": "192.168.1.100",
            "preset_id": 1,
            "segments": [
                {"id": 0, "start": 0, "stop": 45},
                {"id": 1, "start": 45, "stop": 46}
            ]
        }
        with patch("core.wled_driver.WLEDDriver.save_wled_preset", return_value=True):
            resp3 = await self.client.request("POST", "/api/wled/preset", json=valid_payload)
            self.assertEqual(resp3.status, 200)
            data3 = await resp3.json()
            self.assertEqual(data3["status"], "ok")

    @unittest_run_loop
    async def test_effect_test_dynamic_secondary_without_last_color(self):
        # Regression: the fallback looked up ProfileConfig.get_player_slot, which does not exist (500)
        payload = {"effect": {"animation": "chase", "dynamic_secondary": True, "duration": 0.5}}
        with patch("core.engine.AutoGlowEngine.set_protocol_mode", new=AsyncMock(return_value=True)), \
             patch("core.wled_driver.WLEDDriver.play_effect", new=AsyncMock()) as play:
            resp = await self.client.request("POST", "/api/test/effect", json=payload)
            self.assertEqual(resp.status, 200, await resp.text())
            play.assert_awaited()


if __name__ == "__main__":
    unittest.main()

