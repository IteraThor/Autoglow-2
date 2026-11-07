"""
Tests for the Studio scoreboard and the match data the bridge keeps for it.
"""

import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase

from core import studio, studio_camera
from routes.studio_routes import register_studio_routes
from core.autodarts_bridge import AutodartsBridgeClient


def _state(match_id="m1", winner=-1, **extra):
    return {
        "id": match_id, "variant": "X01", "settings": {"baseScore": 501}, "legs": 3, "sets": 0,
        "player": 1, "winner": winner,
        "players": [
            {"name": "Alice", "avatarUrl": "https://cdn.example/a.png", "user": {"country": "nl"}},
            {"name": "Bob"},
        ],
        "gameScores": [301, 140],
        "scores": [{"sets": 0, "legs": 1}, {"sets": 0, "legs": 2}],
        "stats": [{"matchStats": {"average": 80.123}}, {}],
        "turns": [{"id": "t9", "player": 1, "points": 180, "throws": [
            {"segment": {"name": "T20"}}, {"segment": {"number": 20, "multiplier": 3}}, {"segment": {"number": 25, "multiplier": 2}},
        ]}],
        **extra,
    }


def _replay(state):
    return {"type": "ws", "replay": True,
            "message": {"channel": "autodarts.matches", "topic": f"{state['id']}.state", "data": state}}


class TestScoreboard(unittest.TestCase):

    def test_builds_rows_turn_and_target(self):
        board = studio.build_scoreboard(_state(), live=True)
        self.assertEqual(board["target"], "First to 3 legs")
        self.assertEqual([p["remaining"] for p in board["players"]], [301, 140])
        self.assertEqual(board["players"][1]["legs"], 2)
        self.assertEqual(board["players"][0]["average"], 80.12)
        self.assertEqual(board["turn"]["darts"], ["T20", "T20", "BULL"])
        self.assertEqual(board["turn"]["points"], 180)
        self.assertIsNone(board["winner"])

    def test_autodarts_avatar_and_country(self):
        alice, bob = studio.build_scoreboard(_state(), live=True)["players"]
        self.assertEqual(alice["avatar_url"], "https://cdn.example/a.png")
        self.assertEqual(alice["country"], "NL")
        self.assertEqual((bob["avatar_url"], bob["country"]), ("", ""))

    def test_no_state_is_empty(self):
        self.assertEqual(studio.build_scoreboard(None, live=False)["players"], [])


class TestBridgeSnapshots(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.events = []

        async def on_event(ev):
            self.events.append(ev)

        self.client = AutodartsBridgeClient(board_id="board-1", on_event=on_event)
        self.source = object()
        self.client.attach(self.source)

    async def test_replay_fills_studio_without_lighting_events(self):
        await self.client.ingest(self.source, _replay(_state()))
        self.assertEqual(self.client.last_match_state["id"], "m1")
        self.assertEqual(self.events, [])
        self.assertIsNone(self.client._active_match_id)

    async def test_replay_of_finished_match_is_ignored(self):
        await self.client.ingest(self.source, _replay(_state(winner=0)))
        self.assertIsNone(self.client.last_match_state)

    async def test_rest_snapshot_of_running_match_is_kept_but_history_is_not(self):
        await self.client.ingest(self.source, {"type": "http", "url": "https://api.autodarts.io/gs/v0/matches/old", "body": _state("old", winner=1)})
        self.assertIsNone(self.client.last_match_state)
        await self.client.ingest(self.source, {"type": "http", "url": "https://api.autodarts.io/gs/v0/matches/m1", "body": _state()})
        self.assertEqual(self.client.last_match_state["id"], "m1")

    async def test_partial_state_merges_into_previous(self):
        await self.client.ingest(self.source, _replay(_state()))
        self.client.remember_match_state({"id": "m1", "gameScores": [261, 140]})
        merged = self.client.last_match_state
        self.assertEqual(merged["gameScores"], [261, 140])
        self.assertEqual(merged["players"][0]["name"], "Alice")

    async def test_live_match_state_reaches_studio(self):
        await self.client.ingest(self.source, {"type": "ws", "message": {
            "channel": "autodarts.matches", "topic": "m1.state", "data": _state()}})
        self.assertEqual(self.client._active_match_id, "m1")
        self.assertEqual(self.client.last_match_state["gameScores"], [301, 140])
        self.assertTrue(self.events)


def _real_shape_state():
    """Trimmed copy of a real Autodarts match state: the visit belongs to the player in playerId."""
    return {
        "id": "m2", "variant": "X01", "legs": 1, "player": 0, "winner": -1, "finished": False,
        "settings": {"baseScore": 501, "outMode": "Double"},
        "players": [{"id": "pa", "name": "iterathor", "user": {"country": "de", "average": 63.07}}, {"id": "pb", "name": "TIM"}],
        "gameScores": [456, 426], "scores": [{"legs": 0, "sets": 0}, {"legs": 0, "sets": 0}],
        "stats": [{"legStats": {"average": 45, "dartsThrown": 3, "total180": 0},
                   "matchStats": {"average": 45, "first9Average": 45, "dartsThrown": 3, "checkoutPercent": 0}}, {}],
        "chalkboards": [{"rows": [{"round": 0, "points": 0, "score": 501}, {"round": 1, "points": 45, "score": 456}]}, {"rows": []}],
        "state": {"checkoutGuide": None, "checkoutGuides": [None, None]},
        "turnBusted": False,
        "turns": [{"id": "t1", "playerId": "pb", "points": 75, "busted": False, "throws": [
            {"id": "d1", "coords": {"x": 0.0163, "y": 0.0156}, "segment": {"bed": "Double", "multiplier": 2, "name": "Bull", "number": 25}},
            {"id": "d2", "coords": {"x": -0.0526, "y": 0.0156}, "segment": {"bed": "Single", "multiplier": 1, "name": "25", "number": 25}},
        ]}],
    }


class TestRealShape(unittest.TestCase):

    def test_visit_owner_darts_stats_and_rounds(self):
        board = studio.build_scoreboard(_real_shape_state(), live=True, phase="throw")
        self.assertEqual(board["turn"]["player"], 1)  # From playerId, although player 0 is active
        self.assertEqual(board["turn"]["darts"], ["Bull", "25"])
        self.assertEqual(board["turn"]["throws"][0]["x"], 0.0163)
        self.assertEqual(board["turn"]["throws"][0]["bed"], "Double")
        self.assertEqual(board["phase"], "throw")
        first = board["players"][0]
        self.assertEqual(first["match_stats"]["first9Average"], 45)
        self.assertEqual(first["leg_stats"]["dartsThrown"], 3)
        self.assertEqual(first["rounds"], [45])
        self.assertEqual(first["account_average"], 63.07)
        self.assertEqual(first["country"], "DE")
        self.assertEqual(board["target"], "First to 1 leg")


class TestProfiles(unittest.TestCase):

    def setUp(self):
        tmp = Path(tempfile.mkdtemp())
        self.patches = [patch.object(studio, "STUDIO_DIR", tmp), patch.object(studio, "PLAYERS_DIR", tmp / "players"),
                        patch.object(studio, "SETTINGS_FILE", tmp / "studio.json")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_profile_fields_round_trip(self):
        player = studio.upsert_player(None, "Timothy", {"nickname": "The Hammer", "club": "DC Bulls", "country": "ned",
                                                        "stat_average": "85.4", "unknown": "x"}, None)
        stored = studio.load_settings()["players"][0]
        self.assertEqual(stored["id"], player["id"])
        self.assertEqual(stored["nickname"], "The Hammer")
        self.assertEqual(stored["country"], "NED")
        self.assertEqual(stored["stat_average"], "85.4")
        self.assertNotIn("unknown", stored)

    def test_mockup_photo_is_stored_kept_and_deleted(self):
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
        player = studio.upsert_player(None, "Thor", {}, png, png)
        self.assertTrue(player["image"] and player["mockup"] and player["image"] != player["mockup"])
        # Saving the settings (as the Studio page does) keeps both pictures
        settings = studio.save_settings({"players": studio.load_settings()["players"], "cameras": {"player": {"kind": "mockup"}}})
        self.assertEqual(settings["players"][0]["mockup"], player["mockup"])
        self.assertEqual(settings["cameras"]["player"]["kind"], "mockup")
        # Updating without a new mockup keeps the old one
        studio.upsert_player(player["id"], "Thor", {}, None, None)
        self.assertEqual(studio.load_settings()["players"][0]["mockup"], player["mockup"])
        with self.assertRaises(ValueError):
            studio.upsert_player(player["id"], "Thor", {}, None, b"not an image")
        studio.delete_player(player["id"])
        self.assertEqual(list(studio.PLAYERS_DIR.iterdir()), [])

    def _two_players(self):
        thor = studio.upsert_player(None, "Thor Odinson", {}, None)
        loki = studio.upsert_player(None, "Loki Laufeyson", {"alias": "Trickster"}, None)
        return thor, loki

    def test_players_are_mapped_by_name_then_autodarts_name(self):
        thor, loki = self._two_players()
        settings = studio.load_settings()
        # Autodarts uppercases names; Loki plays under his Autodarts name
        mapped = studio.map_players([{"name": "THOR ODINSON"}, {"name": "trickster"}], settings)
        self.assertEqual([(m["studio_id"], m["match"]) for m in mapped], [(thor["id"], "name"), (loki["id"], "alias")])
        # A name like nobody's stays unknown
        self.assertEqual(studio.map_players([{"name": "TIM"}], settings)[0], {"studio_id": "", "match": ""})

    def test_players_are_found_by_similar_names_in_any_order(self):
        thor, loki = self._two_players()
        settings = studio.load_settings()
        # Added the other way round in Autodarts, first name only and with a typo
        mapped = studio.map_players([{"name": "LOKKI"}, {"name": "THOR"}], settings)
        self.assertEqual([(m["studio_id"], m["match"]) for m in mapped], [(loki["id"], "similar"), (thor["id"], "similar")])
        # Accents, punctuation and spacing do not matter
        mapped = studio.map_players([{"name": "Lóki-Laufeyson"}, {"name": "Thor  Odinson"}], settings)
        self.assertEqual([m["studio_id"] for m in mapped], [loki["id"], thor["id"]])
        # A name that fits two Studio players equally well is not guessed
        studio.upsert_player(None, "Thor Heyerdahl", {}, None)
        self.assertEqual(studio.map_players([{"name": "THOR"}], studio.load_settings())[0]["studio_id"], "")

    def test_lobby_players_and_format_for_the_pre_match_screens(self):
        lobby = studio.build_lobby({"id": "L1", "variant": "X01", "legs": 3, "settings": {"baseScore": 501, "outMode": "Double"},
                                    "players": [{"name": "LOKI", "user": {"avatarUrl": "https://x/a.png", "country": "no"}},
                                                {"name": "THOR"}, "junk"]})
        assert lobby is not None
        self.assertEqual([p["name"] for p in lobby["players"]], ["LOKI", "THOR"])
        self.assertEqual((lobby["players"][0]["avatar_url"], lobby["players"][0]["country"]), ("https://x/a.png", "NO"))
        self.assertEqual((lobby["base_score"], lobby["target"]), (501, "First to 3 legs"))
        self.assertIsNone(studio.build_lobby(None))

    def test_remembering_an_autodarts_name_moves_it_between_players(self):
        thor, loki = self._two_players()
        studio.remember_autodarts_name(thor["id"], "TIM")
        settings = studio.remember_autodarts_name(loki["id"], "tim")
        by_id = {p["id"]: p for p in settings["players"]}
        self.assertEqual((by_id[thor["id"]]["alias"], by_id[loki["id"]]["alias"]), ("", "tim"))
        # Remembering the display name itself clears the Autodarts name
        settings = studio.remember_autodarts_name(loki["id"], "LOKI LAUFEYSON")
        self.assertEqual({p["id"]: p for p in settings["players"]}[loki["id"]]["alias"], "")

    def test_camera_rotation_is_validated(self):
        saved = studio.save_settings({"cameras": {"board": {"kind": "server", "rotation": 90}, "player": {"rotation": 45}}})
        self.assertEqual(saved["cameras"]["board"]["rotation"], 90)
        self.assertEqual(saved["cameras"]["player"]["rotation"], 0)
        saved = studio.save_settings({"cameras": {"board": {"rotation": True}}})
        self.assertEqual(saved["cameras"]["board"]["rotation"], 0)

    def test_camera_framing_is_clamped(self):
        saved = studio.save_settings({"cameras": {"board": {"zoom": 1.6, "pan_x": -0.4, "pan_y": 0.25},
                                                  "player": {"zoom": 9, "pan_x": -3, "pan_y": "x"}}})
        board, player = saved["cameras"]["board"], saved["cameras"]["player"]
        self.assertEqual((board["zoom"], board["pan_x"], board["pan_y"]), (1.6, -0.4, 0.25))
        self.assertEqual((player["zoom"], player["pan_x"], player["pan_y"]), (4.0, -1.0, 0.0))

    def test_camera_warp_is_validated(self):
        points = [[0.5, 0.1], [0.9, 0.5], [0.5, 0.95], [0.1, 0.5]]
        saved = studio.save_settings({"cameras": {"board": {"warp": {"points": points, "strength": 0.4}},
                                                  "player": {"warp": {"points": points[:3], "strength": 0.4}}}})
        self.assertEqual(saved["cameras"]["board"]["warp"], {"points": points, "strength": 0.4, "sharpen": 0.5})
        self.assertIsNone(saved["cameras"]["player"]["warp"])
        saved = studio.save_settings({"cameras": {"board": {"warp": {"points": [[2, -1], [1, 1], [0, 1], [0, "x"]]}}}})
        self.assertIsNone(saved["cameras"]["board"]["warp"])
        saved = studio.save_settings({"cameras": {"board": {"warp": {"points": [[2, -1], [1, 1], [0, 1], [0, 0]], "strength": 5, "sharpen": -2}}}})
        self.assertEqual(saved["cameras"]["board"]["warp"], {"points": [[1.0, 0.0], [1, 1], [0, 1], [0, 0]], "strength": 1.0, "sharpen": 0.0})

    def test_dart_zoom_is_validated(self):
        saved = studio.save_settings({})
        self.assertEqual(saved["dart_zoom"], studio.DEFAULT_DART_ZOOM)
        self.assertFalse(saved["dart_zoom"]["enabled"])
        saved = studio.save_settings({"dart_zoom": {"enabled": True, "delay": 9, "zoom": 0.5, "lead": 1.2, "hold": "x"}})
        self.assertEqual(saved["dart_zoom"], {"enabled": True, "delay": 5.0, "zoom": 1.2, "lead": 1.2, "hold": 2.0})
        # The zoom has to start after the dart was reported: lead stays below the delay
        saved = studio.save_settings({"dart_zoom": {"enabled": True, "delay": 1.0, "lead": 3}})
        self.assertEqual(saved["dart_zoom"]["lead"], 0.7)

    def test_texts_keep_only_known_changed_values(self):
        saved = studio.save_settings({"texts": {"moment_180": "  ONE HUNDRED AND EIGHTY ", "board_legs": "Legs",
                                                "brand_main": "", "nonsense": "x", "intro_vs": "v" * 200}})
        self.assertEqual(saved["texts"], {"moment_180": "ONE HUNDRED AND EIGHTY", "intro_vs": "v" * studio.MAX_TEXT_LENGTH})
        self.assertEqual(studio.TEXT_DEFAULTS["board_legs"], "Legs")
        # Every key appears once across the groups
        keys = [k for _g, items in studio.TEXT_GROUPS for k, _l, _d in items]
        self.assertEqual(len(keys), len(set(keys)))

    def test_scene_settings_are_validated(self):
        saved = studio.save_settings({"theme": "arena", "layout": "board", "auto_direct": False, "show_intro": False})
        self.assertEqual((saved["theme"], saved["layout"], saved["auto_direct"], saved["show_intro"]), ("arena", "board", False, False))
        saved = studio.save_settings({"theme": "disco", "layout": "pip"})
        self.assertEqual((saved["theme"], saved["layout"]), ("autodarts", "split"))


class TestCueRoute(AioHTTPTestCase):

    async def get_application(self):
        app = web.Application()
        register_studio_routes(app)
        return app

    async def test_overlay_cue_is_saved(self):
        tmp = Path(tempfile.mkdtemp())
        with patch.object(studio, "STUDIO_DIR", tmp), patch.object(studio, "PLAYERS_DIR", tmp / "players"), \
                patch.object(studio, "SETTINGS_FILE", tmp / "studio.json"):
            await self.client.post("/api/studio/cue", json={"scene": "overlay:hide"})
            self.assertFalse(studio.load_settings()["show_overlay"])
            await self.client.post("/api/studio/cue", json={"scene": "overlay:show"})
            self.assertTrue(studio.load_settings()["show_overlay"])
            data = await (await self.client.get("/api/studio")).json()
            self.assertEqual(data["text_defaults"]["moment_180"], "180")
            self.assertTrue(any(g["name"] == "Big moments" for g in data["text_groups"]))

    async def test_cue_is_numbered_and_shown_in_state(self):
        res = await self.client.post("/api/studio/cue", json={"scene": "intro"})
        self.assertEqual((await res.json())["cue"]["id"], 1)
        res = await self.client.post("/api/studio/cue", json={"scene": "layout:board"})
        self.assertEqual((await res.json())["cue"]["id"], 2)
        state = await (await self.client.get("/api/studio/state")).json()
        self.assertEqual(state["cue"]["scene"], "layout:board")
        res = await self.client.post("/api/studio/cue", json={"scene": "explode"})
        self.assertEqual(res.status, 400)

    async def test_picture_over_the_limit_is_refused_while_it_is_read(self):
        import aiohttp
        form = aiohttp.FormData()
        form.add_field("name", "Big")
        form.add_field("image", b"x" * (studio.MAX_IMAGE_BYTES + 1), filename="big.png", content_type="image/png")
        res = await self.client.post("/api/studio/players", data=form)
        self.assertEqual(res.status, 400)
        self.assertIn("5 MB", (await res.json())["message"])


class TestStudioCamera(unittest.TestCase):

    def test_standard_huffman_tables_are_complete(self):
        for tc, bits, vals in studio_camera.HUFFMAN_TABLES:
            self.assertEqual(sum(bits), len(vals), hex(tc))
            self.assertEqual(len(set(vals)), len(vals), hex(tc))
        # AC tables hold end-of-block, zero-run and every run/size code
        expected = {0x00, 0xF0} | {r << 4 | s for r in range(16) for s in range(1, 11)}
        self.assertEqual(set(studio_camera.HUFFMAN_TABLES[1][2]), expected)
        self.assertEqual(set(studio_camera.HUFFMAN_TABLES[3][2]), expected)

    def test_tables_are_added_only_when_missing(self):
        bare = b"\xff\xd8\xff\xdb\x00\x02\xff\xda\x00\x02DATA\xff\xd9"
        fixed = studio_camera.ensure_huffman_tables(bare)
        self.assertTrue(fixed.startswith(b"\xff\xd8\xff\xc4"))
        self.assertEqual(studio_camera.ensure_huffman_tables(fixed), fixed)
        self.assertEqual(studio_camera.ensure_huffman_tables(b"not a jpeg"), b"not a jpeg")

    def test_camera_ids_cannot_leave_the_video_devices(self):
        for bad in ("..", "../../etc/passwd", "/dev/sda", "video0/../../x", ""):
            self.assertIsNone(studio_camera.resolve_device(bad), bad)


if __name__ == "__main__":
    unittest.main()


class TestBoardManagerRelay(AioHTTPTestCase):
    """A fake Board Manager streams numbered JPEG parts at 30 fps, like /api/streams/cams/<n>."""

    async def get_application(self):
        self.connections = 0

        async def stream(request):
            self.connections += 1
            res = web.StreamResponse(headers={"Content-Type": "multipart/x-mixed-replace; boundary=advisionmjpg"})
            await res.prepare(request)
            n = 0
            while True:
                jpeg = b"\xff\xd8\xff\xc4" + n.to_bytes(4, "big") + b"\xff\xda\xff\xd9"
                await res.write(b"--advisionmjpg\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                n += 1
                await asyncio.sleep(1 / 30)

        self.running = False

        async def state(request):
            return web.json_response({"running": self.running, "status": "throw" if self.running else "stopped"})

        async def start(request):
            self.running = True
            return web.json_response({})

        app = web.Application()
        app.router.add_get("/api/streams/cams/{n}", stream)
        app.router.add_get("/api/state", state)
        app.router.add_put("/api/start", start)
        return app

    async def test_start_board_manager(self):
        with patch.object(studio_camera, "BOARD_MANAGER_URL", str(self.server.make_url("")).rstrip("/")):
            self.assertEqual(await studio_camera.board_manager_state(), {"running": False, "status": "stopped"})
            self.assertEqual(await studio_camera.start_board_manager(), {"running": True, "status": "throw"})
        with patch.object(studio_camera, "BOARD_MANAGER_URL", "http://127.0.0.1:9"):
            self.assertIsNone(await studio_camera.start_board_manager())

    async def test_relay_caps_frame_rate_and_shares_one_connection(self):
        with patch.object(studio_camera, "BOARD_MANAGER_URL", str(self.server.make_url("")).rstrip("/")):
            hub = studio_camera.CameraHub()
            a = hub.acquire("autodarts:0", "720p", 10)
            b = hub.acquire("autodarts:0", "720p", 10)
            self.assertIs(a, b)
            first = await a.next_frame(0, 3)
            self.assertTrue(first.startswith(b"\xff\xd8"))
            start, seq, frames = time.monotonic(), a.seq, 0
            while time.monotonic() - start < 1.0:
                await a.next_frame(seq, 2)
                seq, frames = a.seq, frames + 1
            self.assertTrue(7 <= frames <= 12, frames)
            self.assertEqual(self.connections, 1)
            hub.stop_all()

    def test_camera_ids_and_fps_setting(self):
        self.assertTrue(studio_camera.autodarts_stream_url("autodarts:2").endswith("/api/streams/cams/2"))
        self.assertTrue(studio_camera.autodarts_stream_url("autodarts:live").endswith("/api/streams/live"))
        for bad in ("autodarts:12", "autodarts:../x", "autodarts:", "video0"):
            self.assertIsNone(studio_camera.autodarts_stream_url(bad), bad)
        self.assertEqual(studio._clean_settings({"relay_fps": 30})["relay_fps"], 30)
        self.assertEqual(studio._clean_settings({"relay_fps": 7})["relay_fps"], 15)
