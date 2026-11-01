"""
AutoGlow 2 - Match preview: plays a short made-up match through the flow on the real lights.

It sends the same events a real Autodarts match sends through its own FlowRuntime, so what you see is
exactly what a match will look like. It never runs during a real match.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from core.flow_runtime import EngineFlowOutput, FlowRuntime
from core.game_flow import GameFlow
from core.models import DartEvent, DartEventType

logger = logging.getLogger("autoglow.flow.preview")

DART_GAP = 0.9
TAKEOUT_TIME = 1.4


class PreviewOutput(EngineFlowOutput):
    def __init__(self, engine: Any, flow: Optional[GameFlow], players: List[str]):
        super().__init__(engine)
        self._flow = flow
        self._players = players

    def flow_for(self, ip: str, seg_id: Optional[int]) -> GameFlow:
        return self._flow if self._flow is not None else super().flow_for(ip, seg_id)

    def match_players(self) -> List[str]:
        return self._players

    def match_end_to_waiting(self) -> bool:
        return True

    async def broadcast(self, message: Dict[str, Any]) -> None:
        await super().broadcast({**message, "preview": True})


def _ev(kind: DartEventType, **kw) -> DartEvent:
    return DartEvent(event_type=kind, **kw)


# Three darts per visit: (event, segment number, multiplier, points); visits rotate through these
_VISITS = [
    [(DartEventType.SINGLE, 20, 1), (DartEventType.TRIPLE, 20, 3), (DartEventType.SINGLE, 5, 1)],
    [(DartEventType.TRIPLE, 19, 3), (DartEventType.TRIPLE, 19, 3), (DartEventType.SINGLE, 19, 1)],  # 133: ton
    [(DartEventType.DOUBLE, 16, 2), (DartEventType.BUST, 0, 0), (DartEventType.BULLSEYE, 25, 2)],
    [(DartEventType.TRIPLE, 20, 3), (DartEventType.TRIPLE, 20, 3), (DartEventType.SCORE_180, 20, 3)],  # 180
    [(DartEventType.SINGLE, 1, 1), (DartEventType.SINGLE, 18, 1), (DartEventType.DOUBLE, 4, 2)],
]


def _visit_events(visit_no: int, player: int) -> List[DartEvent]:
    darts = _VISITS[visit_no % len(_VISITS)]
    total = 0
    events = []
    for k, (kind, num, mult) in enumerate(darts):
        points = (num * mult) if kind != DartEventType.BUST else 0
        total += points
        last = k == len(darts) - 1
        if kind == DartEventType.SCORE_180:
            events.append(_ev(kind, score=180, player_index=player))
        elif kind == DartEventType.BUST:
            events.append(_ev(kind, score=0, multiplier=0, segment_number=0, segment_name="Miss", player_index=player))
        else:
            events.append(_ev(kind, score=points, multiplier=mult, segment_number=num, player_index=player,
                              round_score=total if last else None))
    return events


async def _run(engine: Any, runtime: FlowRuntime, players: int, bull_off: bool, legs: int) -> None:
    send = runtime.handle
    try:
        if bull_off:
            await send(_ev(DartEventType.BULL_OFF_START))
            await asyncio.sleep(1.5)
            for p in range(players):
                await send(_ev(DartEventType.THROW, player_index=p))  # ignored during a bull-off, like in a match
                await send(_ev(DartEventType.SINGLE, score=25, segment_number=25, player_index=p))
                await asyncio.sleep(1.2)
            await send(_ev(DartEventType.BULL_OFF_WON, player_index=0))
            await asyncio.sleep(1.5)
        await send(_ev(DartEventType.GAME_START))
        visit = 0
        starter = 0
        for leg in range(legs):
            for rnd in range(2):
                for k in range(players):
                    p = (starter + k) % players
                    await send(_ev(DartEventType.THROW, player_index=p))
                    await asyncio.sleep(DART_GAP)
                    for dart in _visit_events(visit, p):
                        await send(dart)
                        await asyncio.sleep(DART_GAP)
                    visit += 1
                    final_visit = rnd == 1 and k == players - 1
                    if not final_visit:
                        await send(_ev(DartEventType.TAKEOUT_IN_PROGRESS, player_index=p))
                        await asyncio.sleep(TAKEOUT_TIME)
            winner = (starter + players - 1) % players
            if leg < legs - 1:
                await send(_ev(DartEventType.LEG_WON, player_index=winner))
                await asyncio.sleep(1.0)
                starter = (starter + 1) % players
            else:
                await send(_ev(DartEventType.MATCH_WON, player_index=winner))
        # Let the celebration finish, then back to waiting
        await asyncio.sleep(12.0)
    except asyncio.CancelledError:
        pass
    finally:
        runtime.reset()
        try:
            await runtime.out.to_waiting()
        except Exception:
            logger.exception("Could not return to the idle lighting after the preview")
        engine.flow_preview_task = None
        await engine._broadcast_telemetry({"type": "game_flow_state", "phase": "waiting", "preview": True, "ended": True})


async def start_preview(engine: Any, players: int = 2, bull_off: bool = False, legs: int = 1,
                        flow: Optional[GameFlow] = None) -> Dict[str, Any]:
    await stop_preview(engine)
    names = [f"Player {i + 1}" for i in range(players)]
    runtime = FlowRuntime(PreviewOutput(engine, flow, names))
    engine.lighting_test_active = True
    engine.flow_preview_task = asyncio.create_task(_run(engine, runtime, players, bull_off, legs))
    visit_time = 4 * DART_GAP + TAKEOUT_TIME
    seconds = (8 if bull_off else 0) + legs * 2 * players * visit_time + 15
    logger.info(f"Flow preview started: {players} players, bull-off {'on' if bull_off else 'off'}, {legs} leg(s)")
    return {"seconds": round(seconds)}


async def stop_preview(engine: Any) -> None:
    task = getattr(engine, "flow_preview_task", None)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    engine.flow_preview_task = None
