"""
Unit tests for AutodartsClient Turn State Tracking and Event Parsing
"""

import unittest
import asyncio
from core.models import DartEvent, DartEventType
from core.autodarts_client import AutodartsClient


class TestAutodartsClientTurns(unittest.IsolatedAsyncioTestCase):

    async def test_consecutive_180s_on_separate_turns(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Turn 1: Player hits 180 (3x T20)
        state_turn1 = {
            "player": 0,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "points": 180,
                    "throws": [
                        {"id": "t1_1", "score": 20, "multiplier": 3, "segment": {"name": "T20"}},
                        {"id": "t1_2", "score": 20, "multiplier": 3, "segment": {"name": "T20"}},
                        {"id": "t1_3", "score": 20, "multiplier": 3, "segment": {"name": "T20"}}
                    ]
                }
            ]
        }

        await client._parse_match_state(state_turn1)
        event_types = [e.event_type for e in emitted_events]
        self.assertIn(DartEventType.SCORE_180, event_types)

        emitted_events.clear()

        # Turn 2: Opponent hits 180 as well (3x T20)
        state_turn2 = {
            "player": 1,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "turns": [
                state_turn1["turns"][0],
                {
                    "id": "turn_2",
                    "player": 1,
                    "points": 180,
                    "throws": [
                        {"id": "t2_1", "score": 20, "multiplier": 3, "segment": {"name": "T20"}},
                        {"id": "t2_2", "score": 20, "multiplier": 3, "segment": {"name": "T20"}},
                        {"id": "t2_3", "score": 20, "multiplier": 3, "segment": {"name": "T20"}}
                    ]
                }
            ]
        }

        await client._parse_match_state(state_turn2)
        event_types_turn2 = [e.event_type for e in emitted_events]
        
        # Verify THROW was fired for active player turn transition
        self.assertIn(DartEventType.THROW, event_types_turn2)
        # Verify second 180 was ALSO fired without getting swallowed
        self.assertIn(DartEventType.SCORE_180, event_types_turn2)

    async def test_consecutive_busts_on_separate_turns(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Turn 1: Player busts
        state_turn1 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "busted": True,
                    "points": 0,
                    "throws": [{"id": "t1_1", "score": 20, "multiplier": 1, "segment": {"name": "S20"}}]
                }
            ]
        }
        await client._parse_match_state(state_turn1)
        self.assertIn(DartEventType.BUST, [e.event_type for e in emitted_events])

        emitted_events.clear()

        # Turn 2: Opponent busts too
        state_turn2 = {
            "player": 1,
            "turns": [
                state_turn1["turns"][0],
                {
                    "id": "turn_2",
                    "busted": True,
                    "points": 0,
                    "throws": [{"id": "t2_1", "score": 20, "multiplier": 1, "segment": {"name": "S20"}}]
                }
            ]
        }
        await client._parse_match_state(state_turn2)
        self.assertIn(DartEventType.BUST, [e.event_type for e in emitted_events])

    async def test_player_turn_switch_emits_throw_for_active_player(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Turn 1: iterathor (Player 0)
        state_turn1 = {
            "player": 0,
            "players": [{"name": "iterathor"}, {"name": "alex"}],
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "points": 60,
                    "throws": [{"id": "t1_1", "score": 20, "multiplier": 3, "segment": {"name": "T20"}}]
                }
            ]
        }
        await client._parse_match_state(state_turn1)
        throw_events = [e for e in emitted_events if e.event_type == DartEventType.THROW]
        self.assertTrue(len(throw_events) >= 1)
        self.assertEqual(throw_events[0].player_name, "iterathor")
        self.assertEqual(throw_events[0].player_index, 0)

        emitted_events.clear()

        # Turn 2: alex (Player 1)
        state_turn2 = {
            "player": 1,
            "players": [{"name": "iterathor"}, {"name": "alex"}],
            "turns": [
                state_turn1["turns"][0],
                {
                    "id": "turn_2",
                    "player": 1,
                    "points": 0,
                    "throws": []
                }
            ]
        }
        await client._parse_match_state(state_turn2)
        turn2_throws = [e for e in emitted_events if e.event_type == DartEventType.THROW]
        self.assertTrue(len(turn2_throws) >= 1)
        self.assertEqual(turn2_throws[0].player_name, "alex")
        self.assertEqual(turn2_throws[0].player_index, 1)

    async def test_fresh_game_start_with_empty_turns_emits_throw_for_first_player(self):
        """When a fresh match begins with empty turns [], THROW must be emitted for Player 1 immediately."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Initial game start state: turns is empty []
        state_start = {
            "player": 0,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "scores": [{"legs": 0}, {"legs": 0}],
            "turns": [],
            "finished": False
        }
        await client._parse_match_state(state_start)

        throw_events = [e for e in emitted_events if e.event_type == DartEventType.THROW]
        self.assertEqual(len(throw_events), 1)
        self.assertEqual(throw_events[0].player_name, "Henry")
        self.assertEqual(throw_events[0].player_index, 0)

        emitted_events.clear()

        # Repeated state message during turn 0 before throw does not double-fire THROW
        await client._parse_match_state(state_start)
        self.assertEqual(len([e for e in emitted_events if e.event_type == DartEventType.THROW]), 0)

    async def test_player_turn_switch_without_turn_object_emits_throw(self):
        """When player changes to Player 2 before Player 2 throws any darts, THROW must be emitted immediately."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Turn 1: Player 0 (Henry)
        state_turn1 = {
            "player": 0,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "points": 60,
                    "throws": [
                        {"id": "t1_1", "score": 20, "multiplier": 1, "segment": {"name": "S20"}},
                        {"id": "t1_2", "score": 20, "multiplier": 1, "segment": {"name": "S20"}},
                        {"id": "t1_3", "score": 20, "multiplier": 1, "segment": {"name": "S20"}}
                    ]
                }
            ]
        }
        await client._parse_match_state(state_turn1)
        emitted_events.clear()

        # Turn 2: Autodarts sets player=1, but turns list still only has turn_1
        state_turn2_pending = {
            "player": 1,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "turns": state_turn1["turns"]
        }
        await client._parse_match_state(state_turn2_pending)

        turn2_throws = [e for e in emitted_events if e.event_type == DartEventType.THROW]
        self.assertEqual(len(turn2_throws), 1)
        self.assertEqual(turn2_throws[0].player_name, "Opponent")
        self.assertEqual(turn2_throws[0].player_index, 1)

    async def test_fetch_and_parse_match_on_match_start(self):
        """Verify _fetch_and_parse_match queries REST API and triggers initial player THROW."""
        from unittest.mock import AsyncMock
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client._active_match_id = "match_fresh_123"
        client.fetch_match_details = AsyncMock(return_value={
            "id": "match_fresh_123",
            "player": 0,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "turns": [],
            "finished": False
        })

        await client._fetch_and_parse_match("match_fresh_123")

        throw_events = [e for e in emitted_events if e.event_type == DartEventType.THROW]
        self.assertEqual(len(throw_events), 1)
        self.assertEqual(throw_events[0].player_name, "Henry")
        self.assertEqual(throw_events[0].player_index, 0)

    async def test_leg_won_in_multi_leg_match(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Initial game state: 0-0 legs
        state_start = {
            "player": 0,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "scores": [{"legs": 0}, {"legs": 0}],
            "finished": False
        }
        await client._parse_match_state(state_start)
        self.assertNotIn(DartEventType.LEG_WON, [e.event_type for e in emitted_events])

        # Leg 1 won by Henry: 1-0 legs
        state_leg1 = {
            "player": 0,
            "players": [{"name": "Henry"}, {"name": "Opponent"}],
            "scores": [{"legs": 1}, {"legs": 0}],
            "finished": False
        }
        await client._parse_match_state(state_leg1)
        self.assertIn(DartEventType.LEG_WON, [e.event_type for e in emitted_events])

    async def test_leg_won_in_single_leg_game_and_match_won(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Initial state: 0-0
        state_start = {
            "player": 0,
            "players": [{"name": "Henry"}],
            "scores": [{"legs": 0}],
            "finished": False
        }
        await client._parse_match_state(state_start)
        emitted_events.clear()

        # Final throw checkout (Single leg match completes)
        state_win = {
            "player": 0,
            "players": [{"name": "Henry"}],
            "scores": [{"legs": 1}],
            "finished": True,
            "winner": "Henry"
        }
        await client._parse_match_state(state_win)
        types = [e.event_type for e in emitted_events]
        self.assertNotIn(DartEventType.LEG_WON, types)
        self.assertIn(DartEventType.MATCH_WON, types)

    async def test_leg_won_via_events_channel_and_deduplication(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["Henry", "Opponent"]
        client.active_player_idx = 0

        # Receive "leg-won" event on .events channel
        msg_ev = {
            "channel": "autodarts.matches",
            "topic": "match123.events",
            "data": {"event": "leg-won", "player": 0}
        }
        await client._handle_raw_message(None, msg_ev)
        leg_events = [e for e in emitted_events if e.event_type == DartEventType.LEG_WON]
        self.assertEqual(len(leg_events), 1)

        # Immediate following state update for same leg does not double-fire (deduped within 2s)
        state_win = {
            "player": 0,
            "scores": [{"legs": 1}, {"legs": 0}],
            "finished": False
        }
        await client._parse_match_state(state_win)
        leg_events_after = [e for e in emitted_events if e.event_type == DartEventType.LEG_WON]
        self.assertEqual(len(leg_events_after), 1)

    async def test_leg_won_continues_through_takeout_until_next_leg(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["Henry", "Opponent"]
        client.active_player_idx = 0

        # 0. Initial game start: 0-0
        state_init = {
            "player": 0,
            "scores": [{"legs": 0}, {"legs": 0}],
            "finished": False
        }
        await client._parse_match_state(state_init)

        # 1. Leg 1 Won: 1-0
        state_leg1_won = {
            "player": 0,
            "scores": [{"legs": 1}, {"legs": 0}],
            "finished": False
        }
        await client._parse_match_state(state_leg1_won)
        self.assertTrue(client._in_leg_break)
        emitted_events.clear()

        # 2. Board reports Takeout in progress during break -> Ignored so celebration continues!
        msg_takeout = {
            "channel": "autodarts.boards",
            "topic": "test_board.state",
            "data": {"status": "Takeout in progress"}
        }
        await client._handle_raw_message(None, msg_takeout)
        self.assertEqual(len(emitted_events), 0)

        # 3. Next leg starts with Turn 1 for Opponent -> Ends leg break and emits THROW
        state_leg2_turn1 = {
            "player": 1,
            "scores": [{"legs": 1}, {"legs": 0}],
            "turns": [
                {
                    "id": "leg2_turn_1",
                    "player": 1,
                    "points": 0,
                    "throws": []
                }
            ],
            "finished": False
        }
        await client._parse_match_state(state_leg2_turn1)
        self.assertFalse(client._in_leg_break)
        throw_events = [e for e in emitted_events if e.event_type == DartEventType.THROW]
        self.assertEqual(len(throw_events), 1)
        self.assertEqual(throw_events[0].player_name, "Opponent")
        self.assertEqual(throw_events[0].player_index, 1)

    async def test_miss_throws_and_bust(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["Henry"]
        client.active_player_idx = 0

        # Throw 1: Miss outside (score: 0, mult: 0)
        state_throw1 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [{"id": "t1_1", "score": 0, "multiplier": 0, "segment": {"name": "Outside"}}]
                }
            ]
        }
        await client._parse_match_state(state_throw1)
        miss_events = [e for e in emitted_events if e.event_type == DartEventType.BUST]
        self.assertEqual(len(miss_events), 1)
        self.assertEqual(miss_events[0].score, 0)
        self.assertEqual(miss_events[0].segment_name, "Outside")

        emitted_events.clear()

        # Throw 2: Another Miss (score: 0, mult: 1, segment: "Miss")
        state_throw2 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [
                        state_throw1["turns"][0]["throws"][0],
                        {"id": "t1_2", "score": 0, "multiplier": 1, "segment": {"name": "Miss"}}
                    ]
                }
            ]
        }
        await client._parse_match_state(state_throw2)
        miss_events2 = [e for e in emitted_events if e.event_type == DartEventType.BUST]
        self.assertEqual(len(miss_events2), 1)
        self.assertEqual(miss_events2[0].score, 0)

        emitted_events.clear()

        # Throw 3: A third Miss (score: 0)
        state_throw3 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [
                        state_throw1["turns"][0]["throws"][0],
                        state_throw2["turns"][0]["throws"][1],
                        {"id": "t1_3", "score": 0, "multiplier": 0, "segment": 0}
                    ]
                }
            ]
        }
        await client._parse_match_state(state_throw3)
        miss_events3 = [e for e in emitted_events if e.event_type == DartEventType.BUST]
        self.assertEqual(len(miss_events3), 1)

    async def test_triple_hit_detection(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["Henry"]
        client.active_player_idx = 0

        # Throw 1: Triple 20 with name only
        state_t20 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [{"id": "t1_1", "segment": {"name": "T20"}}]
                }
            ]
        }
        await client._parse_match_state(state_t20)
        triples = [e for e in emitted_events if e.event_type == DartEventType.TRIPLE]
        self.assertEqual(len(triples), 1)
        self.assertEqual(triples[0].segment_name, "T20")
        self.assertEqual(triples[0].multiplier, 3)

        emitted_events.clear()

        # Throw 2: Triple 19 with bed: "triple"
        state_t19 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [
                        state_t20["turns"][0]["throws"][0],
                        {"id": "t1_2", "segment": {"name": "T19", "number": 19, "multiplier": 3, "bed": "triple"}}
                    ]
                }
            ]
        }
        await client._parse_match_state(state_t19)
        triples2 = [e for e in emitted_events if e.event_type == DartEventType.TRIPLE]
        self.assertEqual(len(triples2), 1)
        self.assertEqual(triples2[0].segment_name, "T19")

    async def test_single_and_double_hit_detection(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["Henry"]
        client.active_player_idx = 0

        # Throw 1: Single 20
        state_s20 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [{"id": "t1_1", "segment": {"name": "S20"}}]
                }
            ]
        }
        await client._parse_match_state(state_s20)
        singles = [e for e in emitted_events if e.event_type == DartEventType.SINGLE]
        self.assertEqual(len(singles), 1)
        self.assertEqual(singles[0].segment_name, "S20")
        self.assertEqual(singles[0].multiplier, 1)

        emitted_events.clear()

        # Throw 2: Double 16
        state_d16 = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [
                        state_s20["turns"][0]["throws"][0],
                        {"id": "t1_2", "segment": {"name": "D16", "number": 16, "multiplier": 2, "bed": "double"}}
                    ]
                }
            ]
        }
        await client._parse_match_state(state_d16)
        doubles = [e for e in emitted_events if e.event_type == DartEventType.DOUBLE]
        self.assertEqual(len(doubles), 1)
        self.assertEqual(doubles[0].segment_name, "D16")
        self.assertEqual(doubles[0].multiplier, 2)

    async def test_calibrating_detection(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Board status "Calibrating"
        msg_cal = {
            "channel": "autodarts.boards",
            "topic": "test_board.state",
            "data": {"status": "Calibrating"}
        }
        await client._handle_raw_message(None, msg_cal)
        cals = [e for e in emitted_events if e.event_type == DartEventType.CALIBRATING]
        self.assertEqual(len(cals), 1)

    async def test_checkout_throw_immediately_emits_match_won_in_same_frame(self):
        """Verify that a winning throw immediately emits MATCH_WON on the same frame without waiting for next match."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Winning double 16 throw that ends the match
        state_checkout = {
            "player": 0,
            "players": [{"name": "iterathor"}, {"name": "denis"}],
            "scores": [{"legs": 3}, {"legs": 1}],
            "finished": True,
            "winner": 0,
            "turns": [
                {
                    "id": "turn_final",
                    "player": 0,
                    "points": 32,
                    "throws": [
                        {"id": "t_win_1", "score": 16, "multiplier": 2, "segment": {"name": "D16", "number": 16, "multiplier": 2, "bed": "double"}}
                    ]
                }
            ]
        }

        await client._parse_match_state(state_checkout)

        event_types = [e.event_type for e in emitted_events]
        # Must contain DOUBLE and MATCH_WON immediately!
        self.assertIn(DartEventType.DOUBLE, event_types)
        self.assertIn(DartEventType.MATCH_WON, event_types)

        match_won_ev = next(e for e in emitted_events if e.event_type == DartEventType.MATCH_WON)
        # Winner name should be resolved from index 0 to "iterathor"
        self.assertEqual(match_won_ev.player_name, "iterathor")

    async def test_first_dart_in_501_game_does_not_trigger_match_won(self):
        """Verify that throwing the first dart in a 501 game emits TRIPLE/SINGLE and NEVER emits MATCH_WON or LEG_WON."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")

        # Typical start of 501 match payload with score 501, winner: -1, status: "playing"
        state_first_dart = {
            "target": 501,
            "scores": [441, 501],
            "player": 0,
            "players": [{"name": "iterathor"}, {"name": "steven"}],
            "finished": False,
            "winner": -1,
            "status": "playing",
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "throws": [
                        {"id": "t1_1", "score": 20, "multiplier": 3, "segment": {"name": "T20", "number": 20, "multiplier": 3, "bed": "triple"}}
                    ]
                }
            ]
        }

        await client._parse_match_state(state_first_dart)

        event_types = [e.event_type for e in emitted_events]
        self.assertIn(DartEventType.TRIPLE, event_types)
        self.assertNotIn(DartEventType.MATCH_WON, event_types)
        self.assertNotIn(DartEventType.LEG_WON, event_types)

    async def test_takeout_in_progress_and_takeout_events(self):
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["iterathor", "denis"]
        client.active_player_idx = 0

        # 1. Board reports Takeout in progress (via state)
        msg_takeout_prog = {
            "channel": "autodarts.boards",
            "topic": "test_board.state",
            "data": {"status": "Takeout in progress"}
        }
        await client._handle_raw_message(None, msg_takeout_prog)
        self.assertEqual(len(emitted_events), 1)
        self.assertEqual(emitted_events[0].event_type, DartEventType.TAKEOUT_IN_PROGRESS)

        # 2. Board reports takeout started (via events)
        emitted_events.clear()
        msg_takeout_start = {
            "channel": "autodarts.boards",
            "topic": "test_board.events",
            "data": {"event": "takeout started"}
        }
        await client._handle_raw_message(None, msg_takeout_start)
        self.assertEqual(len(emitted_events), 1)
        self.assertEqual(emitted_events[0].event_type, DartEventType.TAKEOUT_IN_PROGRESS)

        # 3. Board reports Takeout state (waiting for player to pull darts)
        emitted_events.clear()
        client._last_flow_state = None
        msg_takeout_state = {
            "channel": "autodarts.boards",
            "topic": "test_board.state",
            "data": {"status": "Takeout"}
        }
        await client._handle_raw_message(None, msg_takeout_state)
        self.assertEqual(len(emitted_events), 1)
        self.assertEqual(emitted_events[0].event_type, DartEventType.TAKEOUT)

        # 4. Board reports takeout finished (via events)
        emitted_events.clear()
        msg_takeout_fin = {
            "channel": "autodarts.boards",
            "topic": "test_board.events",
            "data": {"event": "takeout finished"}
        }
        await client._handle_raw_message(None, msg_takeout_fin)
        # Takeout finished does not emit a duplicate takeout
        self.assertEqual(len(emitted_events), 0)

        # 5. Board reports manual reset in game (via events) -> fires MANUAL_RESET and ready for THROW
        emitted_events.clear()
        client._active_match_id = "test_match_123"
        msg_manual_reset = {
            "channel": "autodarts.boards",
            "topic": "test_board.events",
            "data": {"event": "manual reset"}
        }
        await client._handle_raw_message(None, msg_manual_reset)
        self.assertEqual(len(emitted_events), 2)
        self.assertEqual(emitted_events[0].event_type, DartEventType.MANUAL_RESET)
        self.assertEqual(emitted_events[1].event_type, DartEventType.THROW)

    async def test_turn_completion_3_darts_emits_takeout(self):
        """Verify that when 3 darts are thrown in a turn, the turn completes and emits TAKEOUT."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client.current_players = ["iterathor"]
        client.active_player_idx = 0

        # Throw 3 darts
        state_turn_3_darts = {
            "player": 0,
            "turns": [
                {
                    "id": "turn_1",
                    "player": 0,
                    "points": 60,
                    "throws": [
                        {"id": "t1_1", "score": 20, "multiplier": 1, "segment": {"name": "S20"}},
                        {"id": "t1_2", "score": 20, "multiplier": 1, "segment": {"name": "S20"}},
                        {"id": "t1_3", "score": 20, "multiplier": 1, "segment": {"name": "S20"}}
                    ]
                }
            ]
        }
        await client._parse_match_state(state_turn_3_darts)

        self.assertTrue(emitted_events)
        self.assertEqual(emitted_events[-1].event_type, DartEventType.TAKEOUT)

    async def test_match_abort_via_board_state_clears_match_and_emits_idle(self):
        """Verify that when board.state clears matchId or reports Idle, client emits GAME_IDLE."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client._active_match_id = "match_123"

        # Board state arrives with matchId: null and status: "Idle"
        msg_idle = {
            "channel": "autodarts.boards",
            "topic": "test_board.state",
            "data": {"matchId": None, "status": "Idle"}
        }
        await client._handle_raw_message(None, msg_idle)

        self.assertEqual(len(emitted_events), 1)
        self.assertEqual(emitted_events[0].event_type, DartEventType.GAME_IDLE)
        self.assertIsNone(client._active_match_id)

    async def test_match_abort_via_match_state_emits_idle(self):
        """Verify that when match state reports status: 'aborted', client emits GAME_IDLE."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client._active_match_id = "match_123"

        state_aborted = {
            "id": "match_123",
            "status": "aborted",
            "players": [{"name": "iterathor"}]
        }
        await client._parse_match_state(state_aborted)

        self.assertEqual(len(emitted_events), 1)
        self.assertEqual(emitted_events[0].event_type, DartEventType.GAME_IDLE)
        self.assertIsNone(client._active_match_id)

    async def test_match_cancel_via_match_events_emits_idle(self):
        """Verify that when match events reports event: 'cancel' or 'abort', client emits GAME_IDLE."""
        emitted_events = []

        async def on_event(ev: DartEvent):
            emitted_events.append(ev)

        client = AutodartsClient(on_event=on_event, board_id="test_board")
        client._active_match_id = "match_123"

        msg_cancel = {
            "channel": "autodarts.matches",
            "topic": "match_123.events",
            "data": {"event": "cancelled"}
        }
        await client._handle_raw_message(None, msg_cancel)

        self.assertEqual(len(emitted_events), 1)
        self.assertEqual(emitted_events[0].event_type, DartEventType.GAME_IDLE)
        self.assertIsNone(client._active_match_id)

    async def test_concurrent_token_refresh_locked(self):
        """Verify that concurrent calls to _get_valid_token do not duplicate refresh requests."""
        client = AutodartsClient()
        client.refresh_token = "fake_refresh_token"
        client.token_expires_at = 0.0  # Force refresh needed

        refresh_calls = 0

        async def mock_refresh(ref_tok):
            nonlocal refresh_calls
            refresh_calls += 1
            await asyncio.sleep(0.05)
            return {"access_token": "new_access_token", "refresh_token": "new_refresh_token", "expires_in": 900}

        client._async_refresh_token = mock_refresh

        results = await asyncio.gather(*[client._get_valid_token() for _ in range(5)])

        self.assertEqual(refresh_calls, 1)
        for tok in results:
            self.assertEqual(tok, "new_access_token")
        self.assertEqual(client.access_token, "new_access_token")
        self.assertEqual(client.refresh_token, "new_refresh_token")


if __name__ == "__main__":
    unittest.main()
