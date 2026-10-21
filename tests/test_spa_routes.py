"""
Tests for the single-page app paths and the header status snapshot.
"""

import os
import tempfile

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core.engine import AutoGlowEngine
from core.models import AppConfig, DeviceConfig, LightingMode
from routes import SPA_PATHS, register_routes


class TestSpaRoutes(AioHTTPTestCase):

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
        app["engine"] = AutoGlowEngine(DeviceConfig(ip=""))
        app["current_app_config"] = AppConfig(lighting_mode=LightingMode.FLOW)
        return app

    @unittest_run_loop
    async def test_every_page_serves_the_app_shell(self):
        for path in SPA_PATHS:
            resp = await self.client.get(path)
            self.assertEqual(resp.status, 200, path)
            self.assertIn('class="app-header"', await resp.text(), path)

    @unittest_run_loop
    async def test_old_links_are_still_served(self):
        for path in ["/matrix", "/simulator", "/devices", "/autodarts", "/backups"]:
            self.assertIn(path, SPA_PATHS)

    @unittest_run_loop
    async def test_status_snapshot_is_cheap_and_complete(self):
        resp = await self.client.get("/api/status")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertEqual(data["lighting_mode"], "flow")
        self.assertIn(data["protocol_mode"], ("http", "udp"))
        self.assertIn(data["power_state"], ("on", "dimmed", "off"))
        self.assertIn("connected", data["autodarts"])
        self.assertNotIn("devices", data)
