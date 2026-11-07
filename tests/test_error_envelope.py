"""
Tests for the standard API error body (core/errors.py) and global_error_middleware.
"""

import os
import tempfile
import unittest

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

import server
from core import security
from core.engine import AutoGlowEngine
from core.errors import DeviceUnreachable, NotFound, ValidationError
from core.models import AppConfig, DeviceConfig
from routes import register_routes


async def _boom(request):
    raise RuntimeError("secret internal detail")


async def _missing(request):
    raise NotFound("Preset 'X' not found", field="name")


async def _offline(request):
    raise DeviceUnreachable("Could not reach the WLED controller at 10.0.0.9", field="ip")


class TestErrorEnvelope(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "test_config.json")
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application(middlewares=[server.global_error_middleware])
        app.router.add_get("/api/test/boom", _boom)
        app.router.add_get("/api/test/missing", _missing)
        app.router.add_get("/api/test/offline", _offline)
        register_routes(app, "web")
        app["config_path"] = self.config_path
        app["engine"] = AutoGlowEngine(DeviceConfig(ip=""))
        app["current_app_config"] = AppConfig()
        return app

    @unittest_run_loop
    async def test_app_error_maps_to_code_and_status(self):
        resp = await self.client.get("/api/test/missing")
        self.assertEqual(resp.status, 404)
        body = await resp.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"], {"code": "NOT_FOUND", "message": "Preset 'X' not found", "field": "name", "retryable": False})
        # Legacy keys stay until every UI call goes through api()
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["message"], "Preset 'X' not found")

    @unittest_run_loop
    async def test_device_errors_are_retryable(self):
        resp = await self.client.get("/api/test/offline")
        self.assertEqual(resp.status, 502)
        body = await resp.json()
        self.assertEqual(body["error"]["code"], "DEVICE_UNREACHABLE")
        self.assertTrue(body["error"]["retryable"])

    @unittest_run_loop
    async def test_unhandled_exception_does_not_leak_details(self):
        with self.assertLogs("autoglow.server", level="ERROR"):
            resp = await self.client.get("/api/test/boom")
        self.assertEqual(resp.status, 500)
        text = await resp.text()
        self.assertNotIn("secret internal detail", text)
        body = await resp.json()
        self.assertEqual(body["error"]["code"], "INTERNAL")
        self.assertIn(body["error"]["details"]["request_id"], body["error"]["message"])

    @unittest_run_loop
    async def test_unknown_api_path_answers_in_json(self):
        resp = await self.client.get("/api/does/not/exist")
        self.assertEqual(resp.status, 404)
        body = await resp.json()
        self.assertEqual(body["error"]["code"], "NOT_FOUND")

    @unittest_run_loop
    async def test_invalid_json_is_a_validation_error(self):
        resp = await self.client.post("/api/matrix/presets/select", data="{not json", headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status, 400)
        body = await resp.json()
        self.assertEqual(body["error"]["code"], "VALIDATION")

    @unittest_run_loop
    async def test_route_validation_names_the_field(self):
        resp = await self.client.post("/api/matrix/presets/select", json={"name": ""})
        self.assertEqual(resp.status, 400)
        body = await resp.json()
        self.assertEqual(body["error"]["field"], "name")


class TestErrorsWithoutMiddleware(unittest.TestCase):

    def test_app_error_is_a_ready_response(self):
        err = ValidationError("Bad", field="ip")
        self.assertEqual(err.status, 400)
        self.assertEqual(err.content_type, "application/json")
        self.assertEqual(str(err), "Bad")


class TestAuthRequiredBody(AioHTTPTestCase):

    async def get_application(self):
        app = web.Application(middlewares=[server.global_error_middleware, security.security_middleware])
        register_routes(app, "web")
        cfg = AppConfig()
        cfg.extra[security.PIN_HASH_KEY] = security.hash_pin("1234")
        app["current_app_config"] = cfg
        app["engine"] = AutoGlowEngine(DeviceConfig(ip=""))
        return app

    @unittest_run_loop
    async def test_pin_required_keeps_auth_flag_and_code(self):
        resp = await self.client.get("/api/config")
        self.assertEqual(resp.status, 401)
        body = await resp.json()
        self.assertTrue(body["auth_required"])
        self.assertEqual(body["error"]["code"], "AUTH_REQUIRED")


if __name__ == "__main__":
    unittest.main()
