"""
Bull-off animations, checked against messages recorded from real Autodarts games on 2026-11-01
(tests/fixtures/bull_off_*.json, relayed by the AutoGlow Bridge extension).

- WDF bull-off (closest to bull wins): LOKI Bull, THOR 25 -> LOKI wins, X01 starts.
- PDC bull-off (segment only): both outside -> tie, round 2: THOR Bull, iterathor S6 -> THOR wins.
"""

import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock

from core.autodarts_bridge import AutodartsBridgeClient
from core.engine import AutoGlowEngine
from core.models import AnimationType, DartEvent, DartEventType, DeviceConfig, EffectConfig, ProfileConfig, RGBColor, LightingMode

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
PDC_MATCH_ID = "01a1978a-6d45-7439-afb5-c03d605bfebf"
# Lobby state as read from /api/studio/raw for a real lobby with a PDC bull-off ("Official")
LOBBY = {
    "bullOffMode": "Official", "id": PDC_MATCH_ID, "isPrivate": True, "legs": 1, "variant": "X01",
    "settings": {"baseScore": 501, "bullMode": "25/50", "inMode": "Straight", "maxRounds": 50, "outMode": "Double"},
    "players": [{"name": "iterathor", "index": 0}, {"name": "THOR", "index": 1}],
}

T = DartEventType


def _load(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


def _ws(msg):
    return {"type": "ws", "message": msg}


class TestBullOffFromRealGames(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        self.events = []

        async def on_event(ev):
            self.events.append(ev)

        self.client = AutodartsBridgeClient(board_id="11179e9c-be45-4c61-957e-b5f11ee70a5f", on_event=on_event)
        self.source = object()
        self.client.attach(self.source)

    async def _replay(self, name):
        for msg in _load(name):
            await self.client.ingest(self.source, _ws(msg))

    def _flow(self):
        """Events without the per-dart hits and board noise, to compare the sequence."""
        keep = {T.GAME_START, T.BULL_OFF_START, T.BULL_OFF_WON, T.THROW}
        return [e.event_type for e in self.events if e.event_type in keep]

    async def test_wdf_bull_off_without_lobby(self):
        """Bridge attached after the lobby: the first bull-off state starts the bull-off."""
        await self._replay("bull_off_wdf_2026-11-01.json")
        types = [e.event_type for e in self.events]
        self.assertEqual(types.count(T.BULL_OFF_START), 1)
        self.assertEqual(types.count(T.BULL_OFF_WON), 1)
        won = next(e for e in self.events if e.event_type == T.BULL_OFF_WON)
        self.assertEqual((won.player_name, won.player_index), ("LOKI", 0))
        # The deciding dart (THOR's 25) plays its own effect first, then the winner
        self.assertLess(types.index(T.SINGLE), types.index(T.BULL_OFF_WON))
        # Game Started fires again when the X01 leg begins, before the first turn color
        last_start = len(types) - 1 - types[::-1].index(T.GAME_START)
        self.assertGreater(last_start, types.index(T.BULL_OFF_WON))
        self.assertEqual(types[last_start + 1], T.THROW)
        self.assertIsNone(self.client._bull_off_phase)

    async def test_pdc_bull_off_with_tie_from_lobby_start(self):
        await self.client.ingest(self.source, {"type": "tab", "attached": True, "url": f"https://play.autodarts.com/lobby/{PDC_MATCH_ID}"})
        await self.client.ingest(self.source, _ws({"channel": "autodarts.lobbies", "topic": f"{PDC_MATCH_ID}.state", "data": LOBBY}))
        self.assertEqual(self.events, [])
        await self.client.ingest(self.source, _ws({"channel": "autodarts.lobbies", "topic": f"{PDC_MATCH_ID}.events", "data": {"event": "start"}}))
        # The bull-off starts with the lobby, before any match data arrives
        self.assertEqual([e.event_type for e in self.events], [T.BULL_OFF_START])
        self.assertEqual(self.client._active_match_id, PDC_MATCH_ID)

        await self._replay("bull_off_pdc_tie_2026-11-01.json")
        flow = self._flow()
        # No Game Started during the bull-off; the tie restarts it; Game Started comes with the first leg
        self.assertEqual(flow.count(T.BULL_OFF_START), 2)
        self.assertEqual(flow.count(T.GAME_START), 1)
        self.assertLess(flow.index(T.BULL_OFF_WON), flow.index(T.GAME_START))
        won = next(e for e in self.events if e.event_type == T.BULL_OFF_WON)
        self.assertEqual((won.player_name, won.player_index), ("THOR", 1))
        # Nothing between the winner and the first leg's Game Started
        after_won = [e.event_type for e in self.events[[e.event_type for e in self.events].index(T.BULL_OFF_WON) + 1:]]
        self.assertEqual(after_won[0], T.GAME_START)

    async def test_lobby_without_bull_off_starts_nothing(self):
        lobby = {**LOBBY, "bullOffMode": "Off"}
        await self.client.ingest(self.source, _ws({"channel": "autodarts.lobbies", "topic": f"{PDC_MATCH_ID}.state", "data": lobby}))
        await self.client.ingest(self.source, _ws({"channel": "autodarts.lobbies", "topic": f"{PDC_MATCH_ID}.events", "data": {"event": "start"}}))
        self.assertEqual(self.events, [])
        self.assertIsNone(self.client._active_match_id)

    async def test_takeout_after_bull_off_keeps_winner_animation(self):
        msgs = _load("bull_off_wdf_2026-11-01.json")
        decided = next(i for i, m in enumerate(msgs) if m["data"].get("variant") == "Bull-off" and m["data"].get("gameFinished"))
        for msg in msgs[:decided + 1]:
            await self.client.ingest(self.source, _ws(msg))
        self.assertEqual(self.events[-1].event_type, T.BULL_OFF_WON)
        self.events.clear()
        # Real darts get pulled before anyone presses Weiter: the takeout must not cover the winner
        await self.client.ingest(self.source, _ws({"channel": "autodarts.boards", "topic": "11179e9c-be45-4c61-957e-b5f11ee70a5f.state",
                                                   "data": {"connected": True, "event": "Takeout started", "numThrows": 1, "status": "Takeout in progress"}}))
        self.assertEqual(self.events, [])


class TestBullOffEngine(unittest.IsolatedAsyncioTestCase):

    async def test_bull_off_start_duration_delays_turn_color(self):
        profile = ProfileConfig.get_default_profile()
        profile.events["bull_off_start"] = EffectConfig(animation=AnimationType.RADAR, color_primary=RGBColor(255, 20, 40), duration=0.1, enabled=True)
        profile.events["throw"] = EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 255, 0), enabled=True)
        engine = AutoGlowEngine(DeviceConfig(ip="127.0.0.1", rgb_count=45), profile)
        engine.app_config.lighting_mode = LightingMode.MATRIX  # these tests cover the Event Matrix
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)

        await engine.process_event(DartEvent(event_type=T.BULL_OFF_START))
        self.assertEqual(engine.driver.play_effect.call_args[0][0].color_primary.to_list(), [255, 20, 40])
        await engine.process_event(DartEvent(event_type=T.THROW, player_index=0))
        self.assertEqual(engine.driver.play_effect.call_count, 1)
        await asyncio.sleep(0.15)
        self.assertEqual(engine.driver.play_effect.call_count, 2)
        self.assertEqual(engine.driver.play_effect.call_args[0][0].color_primary.to_list(), [0, 255, 0])

    def _engine(self, start_duration, start_enabled=True):
        profile = ProfileConfig.get_default_profile()
        profile.events["bull_off_start"] = EffectConfig(animation=AnimationType.HEARTBEAT, color_primary=RGBColor(255, 20, 40), duration=start_duration, enabled=start_enabled)
        profile.events["bull_off_won"] = EffectConfig(animation=AnimationType.FLASH, color_primary=RGBColor(0, 255, 100), enabled=True)
        profile.events["throw"] = EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 255, 0), enabled=True)
        engine = AutoGlowEngine(DeviceConfig(ip="127.0.0.1", rgb_count=45), profile)
        engine.app_config.lighting_mode = LightingMode.MATRIX  # these tests cover the Event Matrix
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)
        return engine

    def _colors(self, engine):
        return [c[0][0].color_primary.to_list() for c in engine.driver.play_effect.call_args_list]

    async def test_held_bull_off_start_skips_turn_colors_until_decided(self):
        """Real order on 2026-11-01: bull-off start, then board 'Throw' status and turn changes within the bull-off."""
        engine = self._engine(0.0)
        await engine.process_event(DartEvent(event_type=T.BULL_OFF_START))
        await engine.process_event(DartEvent(event_type=T.THROW, player_index=0))
        await engine.process_event(DartEvent(event_type=T.THROW, player_index=1))
        self.assertEqual(self._colors(engine), [[255, 20, 40]])
        await engine.process_event(DartEvent(event_type=T.BULL_OFF_WON, player_index=0))
        await engine.process_event(DartEvent(event_type=T.THROW, player_index=0))
        self.assertEqual(self._colors(engine), [[255, 20, 40], [0, 255, 100], [0, 255, 0]])

    async def test_switched_off_bull_off_start_keeps_turn_colors(self):
        engine = self._engine(0.0, start_enabled=False)
        await engine.process_event(DartEvent(event_type=T.BULL_OFF_START))
        await engine.process_event(DartEvent(event_type=T.THROW, player_index=0))
        self.assertEqual(self._colors(engine), [[0, 255, 0]])

    async def test_default_profile_has_bull_off_events_switched_off(self):
        profile = ProfileConfig.get_default_profile()
        for key in ("bull_off_start", "bull_off_won"):
            self.assertFalse(profile.get_effect(key).enabled)


if __name__ == "__main__":
    unittest.main()


class TestStudioBullOff(unittest.IsolatedAsyncioTestCase):
    """What the Studio output gets during a real bull-off (/api/studio/state › bull_off)."""

    async def asyncSetUp(self):
        async def on_event(_ev):
            pass

        self.client = AutodartsBridgeClient(board_id="11179e9c-be45-4c61-957e-b5f11ee70a5f", on_event=on_event)
        self.source = object()
        self.client.attach(self.source)

    async def _views(self, name):
        """The Studio's bull-off after each relayed message that changed it."""
        from core import studio
        views = []
        for msg in _load(name):
            await self.client.ingest(self.source, _ws(msg))
            view = studio.build_bull_off(self.client.bull_off_view)
            if not views or view != views[-1]:
                views.append(view)
        return views

    async def test_normal_bull_off_from_lobby_start(self):
        # Recorded 2026-11-01: lobby "Normal" bull-off, iterathor 121.7 mm, THOR 137.3 mm -> iterathor first
        views = await self._views("bull_off_normal_2026-11-01.json")
        started = next(v for v in views if v)
        # Shown from the lobby start on, before any dart: players and the match format for the intro
        self.assertEqual([p["name"] for p in started["players"]], ["iterathor", "THOR"])
        self.assertEqual(started["mode"], "Normal")
        self.assertEqual((started["variant"], started["base_score"], started["target"]), ("X01", 501, "First to 1 leg"))
        self.assertFalse(any(p["thrown"] for p in started["players"]))
        decided = next(v for v in views if v and v["decided"])
        self.assertEqual((decided["winner"], decided["leader"], decided["active"]), (0, 0, None))
        self.assertEqual([p["distance"] for p in decided["players"]], [121.7, 137.3])
        self.assertEqual([p["label"] for p in decided["players"]], ["S10", "S10"])
        # The first leg ends the bull-off scene
        self.assertIsNone(views[-1])

    async def test_pdc_tie_keeps_the_tied_round(self):
        views = await self._views("bull_off_pdc_tie_2026-11-01.json")
        tie = next(v for v in views if v and v["round"] == 2)
        self.assertEqual(len(tie["history"]), 1)
        self.assertEqual([d["label"] for d in tie["history"][0]["darts"]], ["S10", "S10"])
        self.assertIsNone(tie["leader"])  # PDC: no Bull or 25 yet
        decided = next(v for v in views if v and v["decided"])
        self.assertEqual(decided["winner"], 1)
        self.assertEqual([p["label"] for p in decided["players"]], ["S6", "Bull"])
        self.assertIsNone(views[-1])

    async def test_wdf_official_leader_by_segment(self):
        views = await self._views("bull_off_wdf_2026-11-01.json")
        first = next(v for v in views if v and v["players"][0]["thrown"])
        self.assertEqual((first["leader"], first["players"][0]["label"], first["players"][0]["segment"]), (0, "Bull", 50))
        self.assertIsNone(views[-1])
