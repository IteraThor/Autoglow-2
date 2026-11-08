"""
Tests for Classic mode (AutoGlow 1): settings, status parsing, the serial commands and the routes.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

from core import classic
from core.classic import (ClassicService, clean_settings, extract_status, resolve_status_key,
                          wled_command, clean_board_manager_url)
from routes.classic_routes import register_classic_routes, SERVICE_KEY


class FakeSerial:
    def __init__(self):
        self.is_open = True
        self.lines = []

    def write(self, data):
        self.lines.append(json.loads(data.decode()))

    def close(self):
        self.is_open = False


class TestClassicSettings(unittest.TestCase):

    def test_defaults_are_the_autoglow1_traffic_light(self):
        s = clean_settings({})
        self.assertFalse(s["enabled"])
        self.assertEqual(s["board_manager_url"], "http://localhost:3180")
        self.assertEqual(s["statuses"]["Throw"]["color"], [0, 255, 0])
        self.assertEqual(s["statuses"]["Takeout"]["color"], [255, 255, 0])
        self.assertEqual(s["statuses"]["Error"]["fx"], 1)

    def test_bad_values_are_cleaned(self):
        s = clean_settings({"global_brightness": 999, "board_manager_url": "ftp://x",
                            "statuses": {"Throw": {"fx": 4242, "color": "#0a0b0c", "enabled": False},
                                         "Bogus": {"fx": 1}}})
        self.assertEqual(s["global_brightness"], 255)
        self.assertEqual(s["board_manager_url"], "http://localhost:3180")
        self.assertEqual(s["statuses"]["Throw"], {"enabled": False, "fx": 0, "color": [10, 11, 12]})
        self.assertNotIn("Bogus", s["statuses"])

    def test_board_manager_url(self):
        self.assertEqual(clean_board_manager_url("192.168.1.5:3180/"), "http://192.168.1.5:3180")
        self.assertEqual(clean_board_manager_url("https://board.local"), "https://board.local")
        self.assertIsNone(clean_board_manager_url("file:///etc/passwd"))
        self.assertIsNone(clean_board_manager_url(""))

    def test_status_parsing_old_and_new_formats(self):
        self.assertEqual(extract_status({"data": {"status": "Takeout in progress"}}), "Takeout in progress")
        self.assertEqual(extract_status({"status": "Throw"}), "Throw")
        self.assertIsNone(extract_status({"type": "motion"}))
        self.assertEqual(resolve_status_key("TakeoutInProgress"), "Takeout in progress")
        self.assertEqual(resolve_status_key("takeout in progress"), "Takeout in progress")
        self.assertIsNone(resolve_status_key("Dancing"))

    def test_command_uses_global_brightness(self):
        s = clean_settings({"global_brightness": 80})
        self.assertEqual(wled_command(s, "Throw"),
                         {"on": True, "bri": 80, "tt": 0, "seg": {"fx": 0, "col": [[0, 255, 0]]}})


class TestClassicService(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.service = ClassicService(Path(self.tmp.name) / "classic.json")
        self.ser = FakeSerial()
        self.service._ser = self.ser

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_each_status_is_sent_once(self):
        await self.service.handle_status("Throw")
        await self.service.handle_status("throw")
        await self.service.handle_status("Takeout")
        self.assertEqual([l["seg"]["col"][0] for l in self.ser.lines], [[0, 255, 0], [255, 255, 0]])
        self.assertEqual(self.service.last_status, "Takeout")

    async def test_disabled_status_is_not_sent(self):
        self.service.settings["statuses"]["Stopped"]["enabled"] = False
        await self.service.handle_status("Stopped")
        self.assertEqual(self.ser.lines, [])

    async def test_saving_shows_the_new_look_at_once(self):
        self.service.settings["enabled"] = True
        await self.service.handle_status("Throw")
        settings = clean_settings(self.service.settings)
        settings["statuses"]["Throw"]["color"] = [1, 2, 3]
        await self.service.apply(settings)
        self.assertEqual(self.ser.lines[-1]["seg"]["col"][0], [1, 2, 3])
        self.assertTrue(os.path.exists(self.service.settings_path))  # noqa: ASYNC240

    async def test_switching_off_closes_the_port(self):
        self.service.settings["enabled"] = True
        await self.service.apply({**self.service.settings, "enabled": False})
        self.assertFalse(self.ser.is_open)
        self.assertFalse(self.service.running)

    async def test_test_sends_an_unsaved_look(self):
        ok = await self.service.test("Error", {"fx": 9, "color": [9, 9, 9], "enabled": True}, 10)
        self.assertTrue(ok)
        self.assertEqual(self.ser.lines[-1], {"on": True, "bri": 10, "tt": 0, "seg": {"fx": 9, "col": [[9, 9, 9]]}})
        self.assertEqual(self.service.settings["statuses"]["Error"]["fx"], 1)

    async def test_board_manager_is_checked_while_off(self):
        board_manager = web.Application()
        board_manager.router.add_get("/api/state", lambda r: web.json_response({"connected": True, "status": "throw"}))
        runner = web.AppRunner(board_manager)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # pyright: ignore[reportOptionalMemberAccess]
        try:
            self.service.settings["board_manager_url"] = f"http://127.0.0.1:{port}"
            await self.service.check_board_manager()
            self.assertTrue(self.service.board_manager_connected)
            self.assertEqual(self.service.last_status, "Throw")
        finally:
            await runner.cleanup()
        await self.service.check_board_manager()
        self.assertFalse(self.service.board_manager_connected)
        self.assertIn("not reachable", self.service.board_manager_error)


class TestClassicRoutes(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application()
        app["config_path"] = os.path.join(self.temp_dir.name, "config.json")
        register_classic_routes(app)
        return app

    async def test_get_and_save(self):
        resp = await self.client.get("/api/classic")
        self.assertEqual(resp.status, 200)
        data = await resp.json()
        self.assertFalse(data["settings"]["enabled"])
        self.assertIn("Throw", data["status_names"])
        self.assertTrue(any(fx["name"] == "Rainbow" for fx in data["effects"]))

        resp = await self.client.post("/api/classic", json={"global_brightness": 42})
        self.assertEqual(resp.status, 200)
        self.assertEqual((await resp.json())["settings"]["global_brightness"], 42)
        with open(os.path.join(self.temp_dir.name, "classic.json")) as f:  # noqa: ASYNC230
            self.assertEqual(json.load(f)["global_brightness"], 42)

    async def test_bad_board_manager_url_is_a_field_error(self):
        resp = await self.client.post("/api/classic", json={"board_manager_url": "ftp://nope"})
        self.assertEqual(resp.status, 400)
        self.assertEqual((await resp.json())["error"]["field"], "board_manager_url")

    async def test_test_without_usb_controller(self):
        original = classic.find_port
        classic.find_port = lambda manual="": None
        try:
            resp = await self.client.post("/api/classic/test", json={"status": "Throw"})
        finally:
            classic.find_port = original
        self.assertEqual(resp.status, 502)
        resp = await self.client.post("/api/classic/test", json={"status": "Nope"})
        self.assertEqual(resp.status, 400)

    async def test_service_is_created_next_to_the_config(self):
        await self.client.get("/api/classic")
        service = self.app[SERVICE_KEY]
        self.assertEqual(service.settings_path, Path(self.temp_dir.name) / "classic.json")
