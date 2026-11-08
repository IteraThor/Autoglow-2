"""
Flow runtime: a match goes through the flow the way the Flow Matrix page describes it.

Event sequences follow what core/autodarts_client.py emits for real games (THROW at every turn change,
TAKEOUT_IN_PROGRESS when darts are pulled, hits per dart, LEG_WON / MATCH_WON with the winner), and the
bull-off sequence is replayed from messages recorded in real games (tests/fixtures/bull_off_*.json).
"""

import asyncio
import itertools
import json
import os
import unittest

from core.autodarts_bridge import AutodartsBridgeClient
from core.flow_presets import build_preset
from core.flow_runtime import WAITING, FlowRuntime, board_position, hit_key
from core.game_flow import create_default_game_flow
from core.models import DartEvent, DartEventType

T = DartEventType


def _load_fixture(name):
    path = os.path.join(os.path.dirname(__file__), "fixtures", name)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)
OPTIONAL_STEPS = ("bull_off", "game_start", "takeout", "leg_won", "match_won")


class FakeTime:
    def __init__(self):
        self.now = 0.0
        self.sleepers = []

    def clock(self):
        return self.now

    async def sleep(self, delay):
        fut = asyncio.get_running_loop().create_future()
        self.sleepers.append((self.now + delay, fut))
        await fut

    async def advance(self, seconds):
        self.now += seconds
        for _ in range(4):
            for due, fut in list(self.sleepers):
                if due <= self.now + 1e-9 and not fut.done():
                    fut.set_result(None)
            self.sleepers = [(d, f) for d, f in self.sleepers if not f.done()]
            for _ in range(5):
                await asyncio.sleep(0)


class RecordingOutput:
    def __init__(self, flows, segments=None, players=None, to_waiting_after_match=True):
        self.flows = flows  # {(ip, seg): GameFlow}
        self.segs = segments or [(ip, seg, "dartboard_ring") for ip, seg in flows]
        self.players = players or []
        self.after_match = to_waiting_after_match
        self.calls = []
        self.messages = []
        self.streaming = False

    def segments(self):
        return self.segs

    def flow_for(self, ip, seg):
        return self.flows[(ip, seg)]

    def match_players(self):
        return self.players

    def match_end_to_waiting(self):
        return self.after_match

    async def ensure_streaming(self):
        self.streaming = True

    def show(self, ip, seg, effect, transition):
        self.calls.append(("show", ip, seg, effect, transition))

    def hit(self, ip, seg, effect, strength):
        self.calls.append(("hit", ip, seg, effect, strength))

    def can_locate(self, ip, seg):
        return (ip, seg) not in getattr(self, "no_locator", set())

    def locate(self, ip, seg, position, color):
        self.calls.append(("locate", ip, seg, position, color))

    async def to_waiting(self):
        self.streaming = False
        self.calls.append(("waiting",))

    async def broadcast(self, message):
        self.messages.append(message)

    # helpers
    def shown_steps(self, flow=None, seg=("a", 0)):
        """Which steps were shown on a segment, found by the transition each step comes in with."""
        flow = flow or self.flows[seg]
        by_transition = {id(s.transition): sid for sid, s in flow.steps.items()}
        return [by_transition.get(id(c[4]), "?") for c in self.calls if c[0] == "show" and (c[1], c[2]) == seg]

    def kinds(self):
        return [c[0] for c in self.calls]


def ev(kind, **kw):
    return DartEvent(event_type=kind, **kw)


class FlowTest(unittest.IsolatedAsyncioTestCase):
    def make(self, flow=None, flows=None, **kw):
        self.flow = flow or create_default_game_flow()
        self.out = RecordingOutput(flows or {("a", 0): self.flow}, **kw)
        self.time = FakeTime()
        self.rt = FlowRuntime(self.out, clock=self.time.clock, sleep=self.time.sleep)
        return self.rt

    async def send(self, *events):
        for e in events:
            await self.rt.handle(e)
            await asyncio.sleep(0)


class TestMatchFlow(FlowTest):
    async def test_two_player_501_with_legs(self):
        self.make(players=["Anna", "Ben"])
        flow = self.flow
        await self.send(ev(T.GAME_START), ev(T.THROW, player_index=0))
        self.assertEqual(self.rt.step, "game_start")
        self.assertEqual(self.out.shown_steps(), ["game_start"], "the turn waits for the intro")
        await self.time.advance(flow.steps["game_start"].effect.duration)
        self.assertEqual(self.rt.step, "turn")
        turn_call = self.out.calls[-1]
        self.assertEqual(turn_call[3].color_primary, flow.players[0].color)

        await self.send(ev(T.SINGLE, segment_number=20, score=20), ev(T.BULLSEYE, segment_number=25, score=50))
        self.assertEqual(self.out.kinds()[-1], "hit", "Bull is on in Classic")
        self.assertEqual(self.rt.step, "turn", "a hit is not a step change")

        await self.send(ev(T.TAKEOUT_IN_PROGRESS, player_index=0), ev(T.TAKEOUT, player_index=0))
        self.assertEqual(self.rt.step, "takeout")
        self.assertEqual(self.out.shown_steps().count("takeout"), 1, "takeout comes in once")

        await self.send(ev(T.THROW, player_index=1))
        self.assertEqual(self.out.calls[-1][3].color_primary, flow.players[1].color)

        await self.send(ev(T.LEG_WON, player_index=1, player_name="Ben"), ev(T.THROW, player_index=0))
        self.assertEqual(self.rt.step, "leg_won")
        self.assertEqual(self.out.calls[-1][3].color_primary, flow.players[1].color, "winner's colour")
        await self.time.advance(flow.steps["leg_won"].effect.duration)
        self.assertEqual((self.rt.step, self.rt.player), ("turn", 0), "next leg starts with its starter")

        await self.send(ev(T.MATCH_WON, player_name="Anna"))
        self.assertEqual(self.rt.step, "match_won")
        await self.time.advance(flow.steps["match_won"].effect.duration)
        self.assertEqual(self.out.calls[-1], ("waiting",))
        self.assertEqual(self.rt.step, WAITING)
        self.assertEqual(self.out.shown_steps(),
                         ["game_start", "turn", "takeout", "turn", "leg_won", "turn", "match_won"])

    async def test_single_player_goes_back_to_their_own_turn(self):
        self.make(players=["Solo"])
        await self.send(ev(T.GAME_START))
        await self.time.advance(5)
        await self.send(ev(T.THROW, player_index=0), ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=0))
        self.assertEqual(self.out.shown_steps(), ["game_start", "turn", "takeout", "turn"])

    async def test_four_players_each_get_their_colour(self):
        self.make(players=["A", "B", "C", "D"])
        await self.send(ev(T.GAME_START))
        await self.time.advance(5)
        colours = []
        for p in range(4):
            await self.send(ev(T.THROW, player_index=p))
            colours.append(self.out.calls[-1][3].color_primary)
            await self.send(ev(T.TAKEOUT_IN_PROGRESS))
        self.assertEqual(colours, [self.flow.players[i].color for i in range(4)])
        self.assertEqual(len(set((c.r, c.g, c.b) for c in colours)), 4)

    async def test_match_end_keeps_winner_colour_when_power_setting_is_off(self):
        self.make(players=["A", "B"], to_waiting_after_match=False)
        await self.send(ev(T.THROW, player_index=0), ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=1),
                        ev(T.MATCH_WON, player_index=1))
        await self.time.advance(10)
        self.assertNotIn(("waiting",), self.out.calls)
        self.assertEqual(self.rt.step, "turn")
        self.assertEqual(self.out.calls[-1][3].color_primary, self.flow.players[1].color)

    async def test_abort_goes_to_waiting_and_forgets_the_queued_turn(self):
        self.make()
        await self.send(ev(T.GAME_START), ev(T.THROW, player_index=0), ev(T.GAME_IDLE))
        await self.time.advance(10)
        self.assertEqual(self.out.calls[-1], ("waiting",))
        self.assertNotIn("turn", self.out.shown_steps())

    async def test_duplicate_turn_events_do_not_restart_the_look(self):
        self.make()
        await self.send(ev(T.THROW, player_index=0), ev(T.THROW, player_index=0), ev(T.THROW, player_index=0))
        self.assertEqual(self.out.shown_steps(), ["turn"])

    async def test_manual_reset_and_calibration_do_not_change_the_flow(self):
        self.make()
        await self.send(ev(T.THROW, player_index=0), ev(T.MANUAL_RESET), ev(T.CALIBRATING))
        self.assertEqual(self.out.shown_steps(), ["turn"])
        self.assertNotIn(("waiting",), self.out.calls)

    async def test_new_game_during_match_won_starts_cleanly(self):
        self.make()
        await self.send(ev(T.MATCH_WON, player_index=0), ev(T.GAME_START))
        await self.time.advance(30)
        self.assertNotIn(("waiting",), self.out.calls, "the old match's timer must not end the new game")
        self.assertEqual(self.rt.step, "game_start")

    async def test_transitions_are_the_steps_own(self):
        self.make()
        await self.send(ev(T.GAME_START))
        await self.time.advance(5)
        await self.send(ev(T.THROW, player_index=0), ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=1))
        for call in self.out.calls:
            if call[0] == "show":
                step = next(s for s in self.flow.steps.values() if s.transition is call[4])
                self.assertIs(call[4], step.transition)


class TestBullOff(FlowTest):
    async def test_bull_off_holds_its_look_and_ignores_turn_colours(self):
        self.make(players=["A", "B"])
        await self.send(ev(T.BULL_OFF_START), ev(T.THROW, player_index=0), ev(T.BULLSEYE, segment_number=25),
                        ev(T.THROW, player_index=1), ev(T.BULL_OFF_WON, player_index=0))
        self.assertEqual(self.out.shown_steps(), ["bull_off"])
        self.assertIn("hit", self.out.kinds(), "a bull in the bull-off still flashes")
        await self.send(ev(T.GAME_START), ev(T.THROW, player_index=0))
        await self.time.advance(5)
        self.assertEqual(self.out.shown_steps(), ["bull_off", "game_start", "turn"])

    async def test_bull_off_off_keeps_the_waiting_lights(self):
        flow = create_default_game_flow()
        flow.steps["bull_off"].effect.enabled = False
        self.make(flow)
        await self.send(ev(T.BULL_OFF_START), ev(T.THROW, player_index=0))
        self.assertEqual(self.out.calls, [])
        self.assertFalse(self.out.streaming, "nothing to show, so the idle lighting stays")

    async def _replay_fixture(self, messages):
        events = []

        async def collect(e):
            events.append(e)

        client = AutodartsBridgeClient(board_id="11179e9c-be45-4c61-957e-b5f11ee70a5f", on_event=collect)
        source = object()
        client.attach(source)
        for msg in messages:
            await client.ingest(source, {"type": "ws", "message": msg})
        return events

    async def test_recorded_bull_offs(self):
        for name in ("bull_off_normal_2026-11-01.json", "bull_off_wdf_2026-11-01.json", "bull_off_pdc_tie_2026-11-01.json"):
            messages = _load_fixture(name)
            if messages is None:
                self.skipTest(f"fixture {name} missing")
            with self.subTest(name):
                self.make(players=["A", "B", "C"])
                events = await self._replay_fixture(messages)
                kinds = [e.event_type for e in events]
                self.assertIn(T.BULL_OFF_START, kinds)
                for e in events:
                    await self.rt.handle(e)
                    await self.time.advance(0.5)
                await self.time.advance(10)
                steps = self.out.shown_steps()
                self.assertIn("bull_off", steps)
                after_bull_off = steps[steps.index("bull_off"):]
                if T.GAME_START in kinds[kinds.index(T.BULL_OFF_START):]:
                    start = after_bull_off.index("game_start")
                    self.assertNotIn("turn", after_bull_off[:start], "no turn colour during the bull-off")
                    self.assertEqual(after_bull_off[start:], ["game_start", "turn"])
                else:
                    self.assertEqual(set(after_bull_off), {"bull_off"}, "only the bull-off look while it runs")


class TestOffSteps(FlowTest):
    """Every on/off combination of the optional steps and the hits behaves by the same rules."""

    SCRIPT = [
        ev(T.BULL_OFF_START), ev(T.BULLSEYE, segment_number=25), ev(T.BULL_OFF_WON, player_index=0),
        ev(T.GAME_START), ev(T.THROW, player_index=0),
        ev(T.TRIPLE, segment_number=20, score=60), ev(T.SCORE_180, score=180),
        ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=1), ev(T.BUST, segment_number=16, score=32),
        ev(T.LEG_WON, player_index=1), ev(T.THROW, player_index=1),
        ev(T.DOUBLE, segment_number=8, score=16), ev(T.MATCH_WON, player_index=1),
    ]

    async def test_all_64_combinations(self):
        for combo in itertools.product((True, False), repeat=len(OPTIONAL_STEPS) + 1):
            with self.subTest(combo=combo):
                flow = build_preset("show")
                for sid, on in zip(OPTIONAL_STEPS, combo[:-1], strict=True):
                    flow.steps[sid].effect.enabled = on
                for h in flow.hits.values():
                    h.enabled = combo[-1]
                self.make(flow, players=["A", "B"])
                for e in self.SCRIPT:
                    await self.rt.handle(e)
                    # Darts and turns come about a second apart, like in a real match
                    await self.time.advance(1.0)
                await self.time.advance(60)

                shown = self.out.shown_steps(flow)
                for sid, on in zip(OPTIONAL_STEPS, combo[:-1], strict=True):
                    if not on:
                        self.assertNotIn(sid, shown, f"{sid} is off but was shown")
                self.assertIn("turn", shown)
                self.assertNotIn("?", shown, "every look came in with its own step's transition")
                if not combo[-1]:
                    self.assertNotIn("hit", self.out.kinds())
                # The match always ends on the waiting lights
                self.assertEqual(self.out.calls[-1], ("waiting",))
                # Player 2 was shown before the end, with player 2's colour
                p2 = [c for c in self.out.calls if c[0] == "show" and c[3].color_primary == flow.players[1].color]
                self.assertTrue(p2)

    async def test_off_intro_adds_no_delay(self):
        flow = create_default_game_flow()
        flow.steps["game_start"].effect.enabled = False
        self.make(flow)
        await self.send(ev(T.GAME_START), ev(T.THROW, player_index=0))
        self.assertEqual(self.out.shown_steps(), ["turn"], "the turn comes in straight away")

    async def test_off_leg_won_goes_straight_to_the_next_turn(self):
        flow = create_default_game_flow()
        flow.steps["leg_won"].effect.enabled = False
        self.make(flow)
        await self.send(ev(T.THROW, player_index=0), ev(T.LEG_WON, player_index=0), ev(T.THROW, player_index=1))
        self.assertEqual(self.out.shown_steps(), ["turn", "turn"])

    async def test_off_takeout_keeps_the_turn_look(self):
        flow = create_default_game_flow()
        flow.steps["takeout"].effect.enabled = False
        self.make(flow)
        await self.send(ev(T.THROW, player_index=0), ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=1))
        self.assertEqual(self.out.shown_steps(), ["turn", "turn"])

    async def test_off_match_won_goes_to_waiting_right_away(self):
        flow = create_default_game_flow()
        flow.steps["match_won"].effect.enabled = False
        self.make(flow)
        await self.send(ev(T.THROW, player_index=0), ev(T.MATCH_WON, player_index=0))
        self.assertEqual(self.out.calls[-1], ("waiting",))


class TestHits(FlowTest):
    async def test_off_hit_plays_nothing_not_a_default(self):
        flow = create_default_game_flow()
        for h in flow.hits.values():
            h.enabled = False
        self.make(flow)
        await self.send(ev(T.THROW, player_index=0), ev(T.TRIPLE, segment_number=20), ev(T.SCORE_180), ev(T.BULLSEYE))
        self.assertEqual(self.out.kinds(), ["show"])

    async def test_hits_outside_a_match_are_ignored(self):
        self.make()
        await self.send(ev(T.BULLSEYE, segment_number=25))
        self.assertEqual(self.out.calls, [])

    async def test_miss_and_bust_are_different_hits(self):
        flow = create_default_game_flow()
        self.assertEqual(hit_key(ev(T.BUST, segment_number=0, segment_name="Miss"), flow), "miss")
        self.assertEqual(hit_key(ev(T.BUST, segment_number=None, segment_name="Bust"), flow), "bust")
        self.assertEqual(hit_key(ev(T.BUST, segment_number=16), flow), "bust")

    async def test_score_tiers_replace_the_completing_dart(self):
        flow = build_preset("show")
        self.assertEqual(hit_key(ev(T.SINGLE, segment_number=19, round_score=133), flow), "ton")
        self.assertEqual(hit_key(ev(T.TRIPLE, segment_number=20, round_score=140), flow), "ton40")
        self.assertEqual(hit_key(ev(T.TRIPLE, segment_number=20, round_score=99), flow), "triple")
        self.assertEqual(hit_key(ev(T.SCORE_180, score=180, round_score=180), flow), "180")
        flow.hits["ton"].enabled = False
        self.assertEqual(hit_key(ev(T.SINGLE, segment_number=19, round_score=133), flow), "single")

    async def test_camera_friendly_keeps_hits_gentle_during_turns(self):
        flow = build_preset("show")
        self.make(flow)
        await self.send(ev(T.THROW, player_index=0), ev(T.SCORE_180))
        hit = self.out.calls[-1]
        self.assertEqual(hit[0], "hit")
        self.assertEqual(hit[4], 0.5)
        self.assertLessEqual(hit[3].duration, 1.0)
        flow.camera_friendly = False
        await self.send(ev(T.SCORE_180))
        self.assertEqual(self.out.calls[-1][4], 1.0)
        self.assertEqual(self.out.calls[-1][3].duration, flow.hits["180"].duration)

    async def test_player_colour_hits_use_the_current_player(self):
        flow = build_preset("party")
        self.make(flow, players=["A", "B"])
        await self.send(ev(T.THROW, player_index=0), ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=1),
                        ev(T.SINGLE, segment_number=3))
        self.assertEqual(self.out.calls[-2][3].color_primary, flow.players[1].color)

    async def test_hit_locator_points_at_the_number(self):
        flow = build_preset("arena")
        self.make(flow, segments=[("a", 0, "dartboard_ring"), ("a", 1, "ambient")],
                  flows={("a", 0): flow, ("a", 1): flow})
        await self.send(ev(T.THROW, player_index=0), ev(T.SINGLE, segment_number=6), ev(T.BULLSEYE, segment_number=25))
        locs = [c for c in self.out.calls if c[0] == "locate"]
        self.assertEqual(len(locs), 1, "only the board ring, and not for the bull")
        self.out.no_locator = {("a", 0)}
        await self.send(ev(T.SINGLE, segment_number=20))
        self.assertEqual(len([c for c in self.out.calls if c[0] == "locate"]), 1, "a part-ring strip shows no locator")
        self.assertAlmostEqual(locs[0][3], 0.25)
        self.assertEqual(board_position(20), 0.0)
        self.assertAlmostEqual(board_position(3), 0.5)
        self.assertIsNone(board_position(25))


class TestSegmentsWithDifferentProfiles(FlowTest):
    async def test_each_segment_follows_its_own_profile(self):
        ring = build_preset("classic")
        inner = build_preset("minimal")  # no takeout, no hits
        self.make(flows={("a", 0): ring, ("a", 1): inner})
        await self.send(ev(T.THROW, player_index=0), ev(T.BULLSEYE, segment_number=25), ev(T.TAKEOUT_IN_PROGRESS))
        self.assertEqual(self.out.shown_steps(ring, ("a", 0)), ["turn", "takeout"])
        self.assertEqual(self.out.shown_steps(inner, ("a", 1)), ["turn"])
        hits = [c for c in self.out.calls if c[0] == "hit"]
        self.assertEqual([(c[1], c[2]) for c in hits], [("a", 0)])

    async def test_longest_intro_decides_when_the_turn_comes(self):
        a = create_default_game_flow()
        b = create_default_game_flow()
        a.steps["game_start"].effect.duration = 1.0
        b.steps["game_start"].effect.duration = 4.0
        self.make(flows={("a", 0): a, ("a", 1): b})
        await self.send(ev(T.GAME_START), ev(T.THROW, player_index=0))
        await self.time.advance(2.0)
        self.assertNotEqual(self.rt.step, "turn")
        await self.time.advance(2.0)
        self.assertEqual(self.rt.step, "turn")


class TestPresetObjects(unittest.TestCase):
    def test_steps_never_share_a_transition_object(self):
        from core.flow_presets import PRESET_ORDER
        for pid in PRESET_ORDER:
            ids = [id(st.transition) for st in build_preset(pid).steps.values()]
            self.assertEqual(len(ids), len(set(ids)), pid)


class TestAnnouncements(FlowTest):
    async def test_page_hears_every_step_and_hit(self):
        self.make()
        await self.send(ev(T.THROW, player_index=1), ev(T.BULLSEYE, segment_number=25))
        self.assertEqual(self.out.messages[0], {"type": "game_flow_state", "phase": "turn", "player": 1})
        self.assertEqual(self.out.messages[-1]["hit"], "bullseye")


if __name__ == "__main__":
    unittest.main()


class TestRecordedMatches(FlowTest):
    """Whole matches recorded from real Autodarts games (relayed by the bridge, 2026-11-02)."""

    async def _events(self, name):
        messages = _load_fixture(name)
        if messages is None:
            self.skipTest(f"fixture {name} missing")
        events = []

        async def collect(e):
            events.append(e)

        client = AutodartsBridgeClient(board_id="11179e9c-be45-4c61-957e-b5f11ee70a5f", on_event=collect)
        source = object()
        client.attach(source)
        for msg in messages:
            await client.ingest(source, {"type": "ws", "message": msg})
        return events, client

    async def test_pdc_bull_off_winner_starts_and_wins_in_their_colour(self):
        # THOR wins the PDC bull-off (bull against S20), starts the leg and checks out
        events, client = await self._events("pdc_bull_off_match_2026-11-02.json")
        kinds = [e.event_type for e in events]
        won = next(e for e in events if e.event_type == T.MATCH_WON)
        self.assertEqual(won.player_name, "THOR", "the winner after the bull-off reorder")
        self.assertEqual(next(e for e in events if e.event_type == T.BULL_OFF_WON).player_name, "THOR")
        last_start = len(kinds) - 1 - kinds[::-1].index(T.GAME_START)
        self.assertLess(kinds.index(T.BULL_OFF_START), last_start, "the leg starts after the bull-off")

        self.make(players=["THOR", "iterathor"])
        self.out.players = ["THOR", "iterathor"]
        for e in events:
            await self.rt.handle(e)
            await self.time.advance(0.6)
        steps = self.out.shown_steps()
        start = len(steps) - 1 - steps[::-1].index("game_start")
        self.assertEqual(steps[:start][-1], "bull_off")
        self.assertNotIn("turn", steps[:start], "no turn colours during the bull-off")
        self.assertIn("match_won", steps)
        # THOR threw second in the bull-off, so THOR keeps colour 2 although Autodarts lists THOR first now
        self.assertEqual(self.rt.roster, ["iterathor", "THOR"])
        self.assertEqual(self.rt.player, 1)
        turns = [c for c in self.out.calls if c[0] == "show" and c[4] is self.flow.steps["turn"].transition]
        self.assertEqual(turns[0][3].color_primary, self.flow.players[1].color, "THOR starts the leg in colour 2")


class TestColoursStickToPlayers(FlowTest):
    """Autodarts reorders players every leg and after a bull-off; colours must follow the players."""

    async def test_leg_two_order_swap_keeps_colours(self):
        self.make()
        flow = self.flow
        await self.send(ev(T.THROW, player_index=0, player_name="iterathor"), ev(T.TAKEOUT_IN_PROGRESS),
                        ev(T.THROW, player_index=1, player_name="LOKI"))
        leg1 = {"iterathor": self.out.calls[0][3].color_primary, "LOKI": self.out.calls[-1][3].color_primary}
        await self.send(ev(T.LEG_WON, player_index=0, player_name="iterathor"))
        self.assertEqual(self.out.calls[-1][3].color_primary, leg1["iterathor"]) if (
            flow.steps["leg_won"].effect.options or {}).get("colour_from") == "player" else None
        await self.time.advance(10)
        # Leg 2: Autodarts now lists LOKI first
        await self.send(ev(T.THROW, player_index=0, player_name="LOKI"))
        self.assertEqual(self.out.calls[-1][3].color_primary, leg1["LOKI"])
        await self.send(ev(T.TAKEOUT_IN_PROGRESS), ev(T.THROW, player_index=1, player_name="iterathor"))
        self.assertEqual(self.out.calls[-1][3].color_primary, leg1["iterathor"])
        self.assertNotEqual(leg1["iterathor"], leg1["LOKI"])

    async def test_bull_off_winner_keeps_the_colour_from_the_bull_off_order(self):
        self.make()
        await self.send(ev(T.BULL_OFF_START), ev(T.THROW, player_index=0, player_name="iterathor"),
                        ev(T.THROW, player_index=1, player_name="THOR"), ev(T.BULL_OFF_WON, player_name="THOR"),
                        ev(T.GAME_START))
        await self.time.advance(5)
        # THOR won and is listed first now, but keeps player 2's colour
        await self.send(ev(T.THROW, player_index=0, player_name="THOR"))
        self.assertEqual(self.out.calls[-1][3].color_primary, self.flow.players[1].color)
        self.assertEqual(self.rt.roster, ["iterathor", "THOR"])

    async def test_paused_match_keeps_colours(self):
        # The lights went to waiting mid-match (lost tab) and the match continues with player 2's turn
        self.make()
        await self.send(ev(T.GAME_START))
        await self.time.advance(5)
        await self.send(ev(T.THROW, player_index=0, player_name="A"), ev(T.THROW, player_index=1, player_name="B"))
        colour_b = self.out.calls[-1][3].color_primary
        await self.send(ev(T.GAME_IDLE), ev(T.THROW, player_index=1, player_name="B"))
        self.assertEqual(self.out.calls[-1][3].color_primary, colour_b)

    async def test_new_match_starts_a_new_roster(self):
        self.make()
        await self.send(ev(T.GAME_START), ev(T.THROW, player_index=0, player_name="A"))
        await self.send(ev(T.GAME_IDLE), ev(T.GAME_START), ev(T.THROW, player_index=0, player_name="B"))
        await self.time.advance(5)
        self.assertEqual(self.rt.roster, ["B"])
