"""
Regression tests for hardware verification, config reset, backups, engine bookkeeping and the Hub.
"""

import asyncio
import json
import os
import socket
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core.backup_manager import _is_excluded_archive_path
from core.engine import AutoGlowEngine
from core.models import AppConfig, DeviceConfig, ProtocolMode, SegmentConfig
from core.wled_driver import WLEDDriver, is_host_online
from routes import register_routes


def _http_response(payload: dict) -> MagicMock:
    resp = MagicMock()
    resp.read.return_value = json.dumps(payload).encode("utf-8")
    resp.__enter__.return_value = resp
    return resp


class TestHardwareVerification(unittest.TestCase):

    def test_is_host_online_false_for_refused_port(self):
        # Bind then close to get a local port that refuses connections
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        self.assertFalse(is_host_online("127.0.0.1", port, timeout=0.3))

    def test_is_host_online_true_for_listening_port(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        try:
            self.assertTrue(is_host_online("127.0.0.1", s.getsockname()[1], timeout=0.3))
        finally:
            s.close()

    def test_release_live_mode_reports_offline_controller(self):
        driver = WLEDDriver(DeviceConfig(ip="192.168.1.50"))
        with patch("core.wled_driver.is_host_online", return_value=False):
            self.assertFalse(driver._sync_release_live_and_restore_preset(1))

    def test_release_live_mode_reports_stuck_lor(self):
        driver = WLEDDriver(DeviceConfig(ip="192.168.1.50"))
        stuck = [_http_response({})] + [_http_response({"lor": 1}) for _ in range(3)]
        with patch("core.wled_driver.is_host_online", return_value=True), \
             patch("urllib.request.urlopen", side_effect=stuck), \
             patch("core.wled_driver.time.sleep"):
            self.assertFalse(driver._sync_release_live_and_restore_preset(1, max_retries=3))

    def test_release_live_mode_verified(self):
        driver = WLEDDriver(DeviceConfig(ip="192.168.1.50"))
        with patch("core.wled_driver.is_host_online", return_value=True), \
             patch("urllib.request.urlopen", side_effect=[_http_response({}), _http_response({"lor": 0})]):
            self.assertTrue(driver._sync_release_live_and_restore_preset(1))

    def test_pwm_brightness_readback_mismatch_fails(self):
        dev = DeviceConfig(ip="192.168.1.50", segments=[
            SegmentConfig(id=0, name="Ring", start=0, length=45),
            SegmentConfig(id=1, name="PWM White", type="PWM White", start=45, length=1),
        ])
        driver = WLEDDriver(dev)
        with patch("core.wled_driver.is_host_online", return_value=True), \
             patch("urllib.request.urlopen", return_value=_http_response({"seg": [{"id": 1, "bri": 10}]})):
            self.assertFalse(driver._sync_set_pwm_brightness(200))
        with patch("core.wled_driver.is_host_online", return_value=True), \
             patch("urllib.request.urlopen", return_value=_http_response({"seg": [{"id": 1, "bri": 200}]})):
            self.assertTrue(driver._sync_set_pwm_brightness(200))

    def test_pwm_brightness_offline_fails(self):
        dev = DeviceConfig(ip="192.168.1.50", segments=[SegmentConfig(id=1, name="PWM White", type="PWM White", start=45, length=1)])
        with patch("core.wled_driver.is_host_online", return_value=False):
            self.assertFalse(WLEDDriver(dev)._sync_set_pwm_brightness(200))

    def test_state_blockers(self):
        warnings = WLEDDriver.evaluate_state_blockers({
            "on": False, "bri": 0, "lor": 1,
            "seg": [{"id": 0, "start": 0, "stop": 0}, {"id": 1, "start": 45, "stop": 46, "on": False, "bri": 0}]
        })
        text = " | ".join(warnings)
        for fragment in ["power is off", "brightness is 0", "lor: 1", "Segment 0 has invalid bounds", "Segment 1 is switched off", "Segment 1 brightness is 0"]:
            self.assertIn(fragment, text)
        # lor > 0 is expected while streaming
        self.assertEqual(WLEDDriver.evaluate_state_blockers({"on": True, "bri": 255, "lor": 2}, expect_live=True), [])


class TestBackupExclusions(unittest.TestCase):

    def test_environment_and_vcs_paths_excluded(self):
        for path in ["venv/bin/python3", ".git/HEAD", "core/__pycache__/x.pyc", "autoglow.log"]:
            self.assertTrue(_is_excluded_archive_path(path), path)
        for path in ["core/engine.py", "game_flows.json", "presets/Default.json"]:
            self.assertFalse(_is_excluded_archive_path(path), path)


class TestEngineBookkeeping(unittest.IsolatedAsyncioTestCase):

    async def test_stop_cancels_pending_intro_and_flow_tasks(self):
        engine = AutoGlowEngine(DeviceConfig(ip=""), app_config=AppConfig())
        engine._running = True
        engine._game_start_task = asyncio.create_task(asyncio.sleep(60))
        engine._flow_advance_task = asyncio.create_task(asyncio.sleep(60))
        game_task, flow_task = engine._game_start_task, engine._flow_advance_task
        await engine.stop()
        self.assertTrue(game_task.cancelled())
        self.assertTrue(flow_task.cancelled())


class TestConfigResetAndHub(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "test_config.json")
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        cfg = AppConfig(devices=[
            DeviceConfig(ip="192.168.1.60", name="Board"),
            DeviceConfig(ip="192.168.1.61", name="Streaming"),
        ])
        engine = AutoGlowEngine(cfg.devices[0], app_config=cfg)
        engine.get_driver("192.168.1.61")._protocol_mode = ProtocolMode.ACTIVE_UDP
        app["config_path"] = self.config_path
        app["engine"] = engine
        app["current_app_config"] = cfg
        return app

    @unittest_run_loop
    async def test_reset_replaces_in_memory_config(self):
        resp = await self.client.post("/api/config/reset")
        self.assertEqual(resp.status, 200)
        data = await (await self.client.get("/api/config")).json()
        self.assertEqual(data["devices"], [])

    @unittest_run_loop
    async def test_hub_status_skips_http_for_streaming_controller(self):
        health = {"online": True, "name": "Board", "version": "0.15.0", "on": True, "bri": 128, "lor": 0, "segments": [], "warnings": []}
        with patch("core.wled_driver.WLEDDriver.fetch_device_health", return_value=health) as mock_health:
            resp = await self.client.get("/api/hub/status")
            data = await resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["engine"]["protocol_mode"], "udp")
        by_ip = {d["ip"]: d for d in data["devices"]}
        self.assertTrue(by_ip["192.168.1.60"]["online"])
        self.assertTrue(by_ip["192.168.1.61"]["streaming"])
        mock_health.assert_called_once()


if __name__ == "__main__":
    unittest.main()
