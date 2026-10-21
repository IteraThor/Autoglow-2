"""
Tests for secret redaction, access PIN sessions, and the security middleware.
"""

import os
import tempfile
import time
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core import security
from core.models import AppConfig, DeviceConfig
from core.engine import AutoGlowEngine
from core.storage import load_app_config
from routes import register_routes


class TestPinAndSessions(unittest.TestCase):

    def test_hash_and_verify_pin(self):
        stored = security.hash_pin("2468")
        self.assertTrue(security.verify_pin("2468", stored))
        self.assertFalse(security.verify_pin("1357", stored))
        self.assertFalse(security.verify_pin("2468", "garbage"))

    def test_validate_new_pin(self):
        self.assertIsNone(security.validate_new_pin("1234"))
        self.assertIsNotNone(security.validate_new_pin("12"))
        self.assertIsNotNone(security.validate_new_pin("12ab"))

    def test_session_token_bound_to_pin_hash_and_expires(self):
        pin_hash = security.hash_pin("1234")
        token = security.create_session_token(pin_hash)
        self.assertTrue(security.is_valid_session(token, pin_hash))
        # Changing the PIN invalidates existing sessions
        self.assertFalse(security.is_valid_session(token, security.hash_pin("1234")))
        self.assertFalse(security.is_valid_session("tampered", pin_hash))
        with patch("core.security.time.time", return_value=time.time() + security.SESSION_MAX_AGE + 5):
            self.assertFalse(security.is_valid_session(token, pin_hash))


class TestSecretRedaction(unittest.TestCase):

    def test_redact_blanks_every_secret(self):
        cfg = AppConfig(autodarts_password="pw", ai_key="key")
        cfg.extra["autodarts_refresh_token"] = "refresh"
        cfg.extra[security.PIN_HASH_KEY] = "hash"
        data = security.redact_config_dict(cfg.to_dict())
        for key in security.SECRET_KEYS:
            if key in data:
                self.assertEqual(data[key], "", key)

    def test_restore_keeps_stored_secrets_when_client_sends_blanks(self):
        old = AppConfig(autodarts_password="pw", ai_key="key")
        old.extra["autodarts_access_token"] = "access"
        new = AppConfig.from_dict(security.redact_config_dict(old.to_dict()))
        security.restore_redacted_secrets(new, old)
        self.assertEqual(new.autodarts_password, "pw")
        self.assertEqual(new.ai_key, "key")
        self.assertEqual(new.extra["autodarts_access_token"], "access")


class TestSecurityMiddlewareAndRoutes(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "test_config.json")
        security._login_failures.clear()
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application(middlewares=[security.security_middleware])
        register_routes(app, "web")
        app["config_path"] = self.config_path
        app["engine"] = AutoGlowEngine(DeviceConfig(ip=""))
        app["current_app_config"] = AppConfig(autodarts_password="hunter2", ai_key="AIzaKEY")
        return app

    @unittest_run_loop
    async def test_config_response_has_no_secrets(self):
        resp = await self.client.get("/api/config")
        text = await resp.text()
        self.assertEqual(resp.status, 200)
        self.assertNotIn("hunter2", text)
        self.assertNotIn("AIzaKEY", text)

    @unittest_run_loop
    async def test_cross_origin_post_rejected(self):
        resp = await self.client.post("/api/protocol/mode", json={"mode": "http"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(resp.status, 403)

    @unittest_run_loop
    async def test_pin_lifecycle(self):
        # Enable PIN: the setting browser keeps a session cookie
        resp = await self.client.post("/api/auth/pin", json={"new_pin": "4321"})
        self.assertEqual(resp.status, 200)
        self.assertTrue(security.PIN_HASH_KEY in load_app_config(self.config_path).extra)
        self.assertEqual((await self.client.get("/api/config")).status, 200)

        # A fresh browser without a cookie is locked out of the API, but auth status stays public
        self.client.session.cookie_jar.clear()
        resp = await self.client.get("/api/config")
        self.assertEqual(resp.status, 401)
        self.assertTrue((await resp.json())["auth_required"])
        status = await (await self.client.get("/api/auth/status")).json()
        self.assertTrue(status["pin_enabled"])
        self.assertFalse(status["authenticated"])

        # Wrong then right PIN
        self.assertEqual((await self.client.post("/api/auth/login", json={"pin": "0000"})).status, 401)
        self.assertEqual((await self.client.post("/api/auth/login", json={"pin": "4321"})).status, 200)
        self.assertEqual((await self.client.get("/api/config")).status, 200)

        # A config save from the browser cannot overwrite or drop the PIN
        await self.client.post("/api/config", json={"access_pin_hash": "", "devices": []})
        self.assertTrue(self.app["current_app_config"].extra.get(security.PIN_HASH_KEY))

        # Removing requires the current PIN
        self.assertEqual((await self.client.post("/api/auth/pin", json={"new_pin": ""})).status, 403)
        self.assertEqual((await self.client.post("/api/auth/pin", json={"current_pin": "4321", "new_pin": ""})).status, 200)
        self.client.session.cookie_jar.clear()
        self.assertEqual((await self.client.get("/api/config")).status, 200)

    @unittest_run_loop
    async def test_login_rate_limited(self):
        await self.client.post("/api/auth/pin", json={"new_pin": "4321"})
        self.client.session.cookie_jar.clear()
        for _ in range(security.LOGIN_MAX_FAILURES):
            await self.client.post("/api/auth/login", json={"pin": "0000"})
        resp = await self.client.post("/api/auth/login", json={"pin": "4321"})
        self.assertEqual(resp.status, 429)


if __name__ == "__main__":
    unittest.main()
