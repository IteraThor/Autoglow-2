"""
Tests for the Chrome extension bridge that relays Autodarts game data into AutoGlow.
"""

import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core import security
from core import autodarts_bridge
from core.autodarts_bridge import AutodartsBridgeClient, ensure_bridge_key
from core.engine import AutoGlowEngine
from core.models import AppConfig, DartEventType, DeviceConfig
from routes import register_routes

EXT_ORIGIN = {"Origin": "chrome-extension://abcdefghijklmnop"}


def _ws(channel, topic, data):
    return {"type": "ws", "message": {"channel": channel, "topic": topic, "data": data}}


class TestBridgeIngest(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.events = []

        async def on_event(ev):
            self.events.append(ev)

        self.client = AutodartsBridgeClient(board_id="board-1", on_event=on_event)
        self.source = object()
        self.client.attach(self.source)

    async def test_board_state_and_match_state_drive_events(self):
        await self.client.ingest(self.source, _ws("autodarts.boards", "board-1.state", {"status": "Throw", "matchId": "m1"}))
        self.assertEqual(self.client._active_match_id, "m1")
        self.assertIn(DartEventType.GAME_START, [e.event_type for e in self.events])

        self.events.clear()
        await self.client.ingest(self.source, _ws("autodarts.matches", "m1.state", {
            "player": 0,
            "players": [{"name": "Alex"}, {"name": "Sam"}],
            "turns": [{"id": "t1", "points": 60, "throws": [{"id": "d1", "segment": {"name": "T20"}}]}],
        }))
        types = [e.event_type for e in self.events]
        self.assertIn(DartEventType.THROW, types)
        self.assertIn(DartEventType.TRIPLE, types)
        self.assertEqual(self.client.current_players, ["Alex", "Sam"])

    async def test_unrelayed_channel_and_secondary_source_are_ignored(self):
        await self.client.ingest(self.source, _ws("autodarts.lobbies", "x.state", {"status": "Throw", "matchId": "m9"}))
        second = object()
        self.client.attach(second)
        await self.client.ingest(second, _ws("autodarts.boards", "board-1.state", {"status": "Throw", "matchId": "m2"}))
        self.assertIsNone(self.client._active_match_id)
        self.assertEqual(self.events, [])

        # When the primary goes away the next connection takes over
        self.client.detach(self.source)
        self.assertTrue(self.client.is_primary(second))
        self.assertTrue(self.client.is_connected)

    async def test_http_responses_fill_boards_and_match_cache(self):
        await self.client.ingest(self.source, {"type": "http", "url": "https://api.autodarts.com/bs/v0/boards",
                                               "body": [{"id": "board-1", "name": "Home"}]})
        self.assertEqual(await self.client.fetch_boards(), [{"id": "board-1", "name": "Home"}])

        await self.client.ingest(self.source, {"type": "http", "url": "https://api.autodarts.com/gs/v0/matches/m5?x=1",
                                               "body": {"id": "m5", "players": [{"name": "Kim"}]}})
        details = await self.client.fetch_match_details("m5")
        self.assertEqual(details["id"], "m5")
        self.assertEqual(self.client.current_players, ["Kim"])

    async def test_ping_and_tab_state(self):
        reply = await self.client.ingest(self.source, {"type": "ping"})
        self.assertEqual(reply["type"], "pong")
        await self.client.ingest(self.source, {"type": "tab", "attached": True, "url": "https://play.autodarts.com/matches/m1"})
        self.assertTrue(self.client.snapshot()["tab_attached"])
        self.client.detach(self.source)
        self.assertFalse(self.client.is_connected)
        self.assertFalse(self.client.tab_attached)

    async def test_match_ends_when_tab_stays_gone(self):
        await self.client.ingest(self.source, {"type": "tab", "attached": True, "url": "https://play.autodarts.com/"})
        await self.client.ingest(self.source, _ws("autodarts.boards", "board-1.state", {"status": "Throw", "matchId": "m1"}))
        self.events.clear()
        with patch.object(autodarts_bridge, "SOURCE_LOST_GRACE_SECONDS", 0.01):
            self.client.detach(self.source)
            await asyncio.sleep(0.05)
        self.assertIsNone(self.client._active_match_id)
        self.assertEqual([e.event_type for e in self.events], [DartEventType.GAME_IDLE])

    async def test_match_survives_quick_reconnect(self):
        await self.client.ingest(self.source, {"type": "tab", "attached": True, "url": "https://play.autodarts.com/"})
        await self.client.ingest(self.source, _ws("autodarts.boards", "board-1.state", {"status": "Throw", "matchId": "m1"}))
        with patch.object(autodarts_bridge, "SOURCE_LOST_GRACE_SECONDS", 0.05):
            self.client.detach(self.source)
            again = object()
            self.client.attach(again)
            await self.client.ingest(again, {"type": "tab", "attached": True, "url": "https://play.autodarts.com/"})
            await asyncio.sleep(0.1)
        self.assertEqual(self.client._active_match_id, "m1")

    def test_ensure_bridge_key_only_creates_once(self):
        cfg = AppConfig()
        self.assertTrue(ensure_bridge_key(cfg))
        key = cfg.extra[security.BRIDGE_KEY_SETTING]
        self.assertFalse(ensure_bridge_key(cfg))
        self.assertEqual(cfg.extra[security.BRIDGE_KEY_SETTING], key)


class TestBridgeRoutes(AioHTTPTestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_path = os.path.join(self.temp_dir.name, "config.json")
        super().setUp()

    def tearDown(self):
        super().tearDown()
        self.temp_dir.cleanup()

    async def get_application(self):
        app = web.Application(middlewares=[security.security_middleware])
        register_routes(app, "web")
        cfg = AppConfig()
        cfg.extra[security.BRIDGE_KEY_SETTING] = "pair-key-123"
        self.bridge = AutodartsBridgeClient()
        app["config_path"] = self.config_path
        app["engine"] = AutoGlowEngine(DeviceConfig(ip=""), autodarts_client=self.bridge)
        app["current_app_config"] = cfg
        return app

    @unittest_run_loop
    async def test_extension_relays_game_data_over_websocket(self):
        ws = await self.client.ws_connect("/ws/autodarts-bridge", headers=EXT_ORIGIN)
        welcome = await ws.receive_json()
        self.assertEqual(welcome["type"], "welcome")
        self.assertTrue(welcome["primary"])

        await ws.send_json({"type": "hello", "version": "1.0.0"})
        await ws.send_json(_ws("autodarts.boards", "b1.state", {"status": "Throw", "matchId": "m1"}))
        await ws.send_json({"type": "ping"})
        self.assertEqual((await ws.receive_json())["type"], "pong")

        resp = await self.client.get("/api/autodarts/status")
        data = await resp.json()
        self.assertEqual(data["source"], "extension")
        self.assertTrue(data["account"]["authenticated"])
        self.assertEqual(data["bridge"]["extension_version"], "1.0.0")
        self.assertEqual(data["match"]["active_match_id"], "m1")
        await ws.close()

    @unittest_run_loop
    async def test_web_page_origin_rejected(self):
        resp = await self.client.get("/ws/autodarts-bridge", headers={"Origin": "https://evil.example"})
        self.assertEqual(resp.status, 403)

    @unittest_run_loop
    async def test_remote_connection_needs_pairing_key(self):
        with patch.object(security, "_is_loopback", return_value=False):
            resp = await self.client.get("/ws/autodarts-bridge", headers=EXT_ORIGIN)
            self.assertEqual(resp.status, 403)
            ws = await self.client.ws_connect("/ws/autodarts-bridge?key=pair-key-123", headers=EXT_ORIGIN)
            self.assertEqual((await ws.receive_json())["type"], "welcome")
            await ws.close()

    @unittest_run_loop
    async def test_bridge_info_and_key_rotation(self):
        data = await (await self.client.get("/api/autodarts/bridge")).json()
        self.assertTrue(data["active"])
        self.assertEqual(data["pairing_key"], "pair-key-123")
        self.assertTrue(data["extension_dir"].endswith("chrome_extension"))

        data = await (await self.client.post("/api/autodarts/bridge/key")).json()
        self.assertNotEqual(data["pairing_key"], "pair-key-123")

    @unittest_run_loop
    async def test_pairing_key_not_exposed_by_config(self):
        text = await (await self.client.get("/api/config")).text()
        self.assertNotIn("pair-key-123", text)

    @unittest_run_loop
    async def test_config_reset_keeps_bridge_and_key(self):
        resp = await self.client.post("/api/config/reset")
        self.assertEqual(resp.status, 200)
        self.assertIs(self.app["engine"].autodarts, self.bridge)
        self.assertEqual(self.app["current_app_config"].extra[security.BRIDGE_KEY_SETTING], "pair-key-123")


if __name__ == "__main__":
    unittest.main()
