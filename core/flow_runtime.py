"""
AutoGlow 2 - Flow Matrix runtime: follows a match and drives the light strips.

    Waiting -> Bull-off -> Game starts -> [Player's turn <-> Pulling darts] -> Leg won -> ... -> Match won -> Waiting

Rules (the same ones the Flow Matrix page explains):
- A step that is off is skipped: nothing plays for it and it adds no waiting time. The next step comes in
  with its own transition.
- Timed steps (Game starts, Leg won, Match won) play at least their time; a turn that starts meanwhile
  waits for them, then comes in.
- Hits play on top of the current look and fade back into it. They never count as a step change.
- The player's turn is always on; it is the look the match returns to.
- Waiting is the idle lighting saved in Setup (a WLED preset), so the strips switch to it without a blend.

Each segment follows its own flow profile; the match itself (which step, whose turn) is shared.

Player colours stick to players, not positions: Autodarts reorders the players for every leg (the starter
goes first) and after a bull-off (the winner goes first), so the runtime keeps a match roster in the order
players first appear and colours them by that.
"""

import asyncio
import dataclasses
import logging
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol, Tuple

from core.game_flow import FlowTransition, GameFlow, player_colour_index
from core.models import DartEvent, DartEventType, EffectConfig, ProtocolMode, RGBColor

logger = logging.getLogger("autoglow.flow")

WAITING = "waiting"

# Board numbers clockwise from the top, for the hit locator
BOARD_ORDER = (20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5)

# Camera-friendly mode: hits during a turn stay gentle so they don't disturb dart detection
CAMERA_FRIENDLY_STRENGTH = 0.5
CAMERA_FRIENDLY_MAX_HIT = 1.0
TURN_STEPS = ("turn", "takeout", "bull_off")

_HIT_EVENTS = {
    DartEventType.SINGLE: "single",
    DartEventType.DOUBLE: "double",
    DartEventType.TRIPLE: "triple",
    DartEventType.BULLSEYE: "bullseye",
    DartEventType.SCORE_180: "180",
}

Segment = Tuple[str, Optional[int], str]  # (controller ip, segment id or None, role)


class FlowOutput(Protocol):
    """Where the runtime sends its decisions (the engine's drivers, or a recorder in tests)."""

    def segments(self) -> List[Segment]: ...
    def flow_for(self, ip: str, seg_id: Optional[int]) -> GameFlow: ...
    def match_players(self) -> List[str]: ...
    def match_end_to_waiting(self) -> bool: ...
    async def ensure_streaming(self) -> None: ...
    def show(self, ip: str, seg_id: Optional[int], effect: EffectConfig, transition: FlowTransition) -> None: ...
    def hit(self, ip: str, seg_id: Optional[int], effect: EffectConfig, strength: float) -> None: ...
    def locate(self, ip: str, seg_id: Optional[int], position: float, color: RGBColor) -> None: ...
    def can_locate(self, ip: str, seg_id: Optional[int]) -> bool: ...
    async def to_waiting(self) -> None: ...
    async def broadcast(self, message: Dict[str, Any]) -> None: ...


def hit_key(event: DartEvent, flow: GameFlow) -> Optional[str]:
    """Which hit of the flow an event plays (a score tier wins over the dart that completed it)."""
    if event.event_type == DartEventType.BUST:
        return "miss" if event.segment_number == 0 else "bust"
    key = _HIT_EVENTS.get(event.event_type)
    if key is None:
        return None
    total = event.round_score
    if key != "180" and isinstance(total, int):
        tier = "ton40" if 140 <= total < 180 else ("ton" if 100 <= total < 140 else None)
        if tier and flow.hits[tier].enabled:
            return tier
    return key


def board_position(segment_number: Optional[int]) -> Optional[float]:
    """Where a board number's centre sits around the board: 0 = top (the 20), going clockwise."""
    if segment_number in BOARD_ORDER:
        return BOARD_ORDER.index(segment_number) / len(BOARD_ORDER)
    return None


class FlowRuntime:
    def __init__(
        self,
        output: FlowOutput,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self.out = output
        self._clock = clock
        self._sleep = sleep
        self.step: str = WAITING
        self.player: int = 0  # position in the match roster (see module doc), not Autodarts' current order
        self.roster: List[str] = []
        self.in_bull_off = False
        self._hold_until = 0.0
        self._hold_step: Optional[str] = None
        self._queued_turn: Optional[int] = None
        self._timer: Optional[asyncio.Task] = None
        self.last_hit: Optional[str] = None

    # -- public --

    def snapshot(self) -> Dict[str, Any]:
        return {"step": self.step, "player": self.player, "bull_off": self.in_bull_off, "hit": self.last_hit}

    def reset(self, keep_roster: bool = False) -> None:
        self._cancel_timer()
        self.step = WAITING
        self.player = 0
        if not keep_roster:
            self.roster = []
        self.in_bull_off = False
        self._hold_until = 0.0
        self._hold_step = None
        self._queued_turn = None

    async def handle(self, event: DartEvent) -> None:
        t = event.event_type
        if t == DartEventType.GAME_IDLE:
            await self._to_waiting()
        elif t == DartEventType.BULL_OFF_START:
            # A PDC tie starts another bull-off round: keep the players seen so far
            self.reset(keep_roster=self.in_bull_off)
            self.in_bull_off = True
            await self._enter("bull_off")
        elif t == DartEventType.BULL_OFF_WON:
            # The bull-off look stays until the first leg starts
            pass
        elif t == DartEventType.GAME_START:
            await self._game_start()
        elif t == DartEventType.THROW:
            await self._turn(self._slot(event.player_index, event.player_name))
        elif t in (DartEventType.TAKEOUT, DartEventType.TAKEOUT_IN_PROGRESS):
            if self.step == "turn" and not self._held():
                await self._enter("takeout")
        elif t == DartEventType.LEG_WON:
            self._queued_turn = None
            await self._timed("leg_won", winner=self._slot(event.player_index, event.player_name))
        elif t in (DartEventType.MATCH_WON, DartEventType.GAME_FINISH):
            self._queued_turn = None
            winner = self._winner_index(event)
            if not await self._timed("match_won", winner=winner):
                await self._finish_match()
        elif t in _HIT_EVENTS or t == DartEventType.BUST:
            await self._hit(event)
        # CALIBRATING and MANUAL_RESET don't change the flow (a manual reset is followed by a THROW)

    # -- steps --

    def _slot(self, player_index: Optional[int], player_name: Optional[str]) -> int:
        """The roster position of a player (added on first sight); falls back to the position given."""
        idx = player_index if (player_index is not None and player_index >= 0) else 0
        name = (player_name or "").strip()
        if not name:
            players = self.out.match_players()
            name = str(players[idx] or "").strip() if idx < len(players) else ""
        if not name:
            return idx
        key = name.lower()
        lowered = [n.lower() for n in self.roster]
        if key not in lowered:
            self.roster.append(name)
            lowered.append(key)
        return lowered.index(key)

    async def _game_start(self) -> None:
        self._cancel_timer()
        self._queued_turn = None
        if not self.in_bull_off:
            self.roster = []  # a new match without a bull-off; after one, its players keep their colours
        self.in_bull_off = False
        await self._timed("game_start")

    async def _turn(self, slot: int) -> None:
        if self.in_bull_off:
            return  # bull-off darts are not turns (the player is in the roster now, though)
        p = slot
        if self._held():
            self._queued_turn = p
            return
        if self.step == "turn" and self.player == p:
            return
        self.player = p
        await self._enter("turn", player=p)

    async def _timed(self, step_id: str, winner: Optional[int] = None) -> bool:
        """Enter a timed step where it is on. Returns False when it is off everywhere (skipped)."""
        segs = self._segments_with(step_id)
        if not segs:
            return False
        self._cancel_timer()
        hold = max(self.out.flow_for(ip, sid).steps[step_id].effect.duration for ip, sid, _ in segs)
        await self._enter(step_id, player=winner)
        self._hold_step = step_id
        self._hold_until = self._clock() + hold
        self._timer = asyncio.create_task(self._release_after(hold, step_id))
        return True

    async def _release_after(self, delay: float, step_id: str) -> None:
        try:
            await self._sleep(delay)
        except asyncio.CancelledError:
            return
        if self._hold_step != step_id:
            return
        self._hold_step = None
        self._hold_until = 0.0
        self._timer = None
        if step_id == "match_won":
            await self._finish_match()
        elif self._queued_turn is not None:
            p, self._queued_turn = self._queued_turn, None
            self.player = p
            await self._enter("turn", player=p)

    async def _finish_match(self) -> None:
        if self.out.match_end_to_waiting():
            await self._to_waiting()
        else:
            # Lights stay on the winner's colour until the next game or the idle timer
            await self._enter("turn", player=self.player)

    async def _to_waiting(self) -> None:
        was = self.step
        self.reset()
        if was != WAITING:
            logger.info("Flow -> waiting lights (idle lighting from Setup)")
        await self.out.to_waiting()
        await self._announce()

    def hold_remaining(self) -> float:
        """Seconds until a playing timed step lets the next turn come in (0 when nothing holds)."""
        return max(0.0, self._hold_until - self._clock()) if self._hold_step else 0.0

    def _held(self) -> bool:
        return self._hold_step is not None and self._clock() < self._hold_until

    def _cancel_timer(self) -> None:
        if self._timer and not self._timer.done():
            self._timer.cancel()
        self._timer = None
        self._hold_step = None
        self._hold_until = 0.0

    def _segments_with(self, step_id: str) -> List[Segment]:
        return [s for s in self.out.segments() if self.out.flow_for(s[0], s[1]).steps[step_id].enabled]

    async def _enter(self, step_id: str, player: Optional[int] = None) -> None:
        segs = self._segments_with(step_id)
        if not segs:
            return  # off everywhere: skipped, the strips keep their current look
        await self.out.ensure_streaming()
        for ip, sid, _role in segs:
            flow = self.out.flow_for(ip, sid)
            step = flow.steps[step_id]
            effect = self._coloured(step.effect, flow, player, force_player=(step_id == "turn"))
            self.out.show(ip, sid, effect, step.transition)
        if player is not None:
            self.player = player
        self.step = step_id
        logger.info(f"Flow -> {step_id}" + (f" (player {self.player + 1})" if step_id in ("turn", "takeout", "leg_won", "match_won") else ""))
        await self._announce()

    def colour_slot(self, flow: GameFlow, player: Optional[int] = None) -> int:
        """Which of the flow's colours a roster player gets (a colour tied to their name wins)."""
        idx = self.player if player is None else player
        return player_colour_index(self.roster, idx, flow)

    def _coloured(self, effect: EffectConfig, flow: GameFlow, player: Optional[int],
                  force_player: bool = False) -> EffectConfig:
        wants_player = force_player or (effect.options or {}).get("colour_from") == "player"
        if not wants_player:
            return effect
        return dataclasses.replace(effect, color_primary=flow.players[self.colour_slot(flow, player)].color)

    async def _hit(self, event: DartEvent) -> None:
        if self.step == WAITING and not self.in_bull_off:
            return
        played: Optional[str] = None
        streaming = False
        for ip, sid, role in self.out.segments():
            flow = self.out.flow_for(ip, sid)
            key = hit_key(event, flow)
            if key is None:
                continue
            effect = flow.hits[key]
            gentle = flow.camera_friendly and self.step in TURN_STEPS
            if effect.enabled:
                if not streaming:
                    await self.out.ensure_streaming()
                    streaming = True
                eff = self._coloured(effect, flow, None)
                if gentle and eff.duration > CAMERA_FRIENDLY_MAX_HIT:
                    eff = dataclasses.replace(eff, duration=CAMERA_FRIENDLY_MAX_HIT)
                self.out.hit(ip, sid, eff, CAMERA_FRIENDLY_STRENGTH if gentle else 1.0)
                played = key
            pos = board_position(event.segment_number)
            if flow.hit_locator and pos is not None and role != "ambient" and self.out.can_locate(ip, sid) and key in ("single", "double", "triple", "ton", "ton40"):
                if not streaming:
                    await self.out.ensure_streaming()
                    streaming = True
                colour = flow.players[self.colour_slot(flow)].color
                self.out.locate(ip, sid, pos, colour)
                played = played or "locator"
        if played:
            logger.info(f"Flow hit: {played}" + (" (gentle)" if any(
                self.out.flow_for(ip, sid).camera_friendly for ip, sid, _ in self.out.segments()) and self.step in TURN_STEPS else ""))
            self.last_hit = played
            await self._announce(hit=played)

    def _winner_index(self, event: DartEvent) -> Optional[int]:
        if event.player_name or event.player_index is not None:
            return self._slot(event.player_index, event.player_name)
        return self.player

    async def _announce(self, hit: Optional[str] = None) -> None:
        msg: Dict[str, Any] = {"type": "game_flow_state", "phase": self.step, "player": self.player}
        segs = self.out.segments()
        if segs and self.roster:
            # Which colour dot the page should light (a colour tied to a name can differ from the position)
            msg["colour"] = self.colour_slot(self.out.flow_for(segs[0][0], segs[0][1]))
        if hit:
            msg["hit"] = hit
        await self.out.broadcast(msg)


class EngineFlowOutput:
    """The runtime's output on the engine's real WLED drivers."""

    def __init__(self, engine: Any):
        self.engine = engine

    def segments(self) -> List[Segment]:
        from core.engine import _is_pwm_segment, _seg_attr, _seg_id
        segs: List[Segment] = []
        for dev in self.engine._active_devices():
            if dev.segments:
                for seg in dev.segments:
                    if not _is_pwm_segment(seg):
                        segs.append((dev.ip, _seg_id(seg), str(_seg_attr(seg, "role", "dartboard_ring") or "")))
            else:
                segs.append((dev.ip, None, "dartboard_ring"))
        return segs

    def flow_for(self, ip: str, seg_id: Optional[int]) -> GameFlow:
        return self.engine.game_flow_storage.get_for_segment(ip, seg_id)

    def match_players(self) -> List[str]:
        ad = self.engine.autodarts
        return list(getattr(ad, "current_players", []) or []) if ad else []

    def match_end_to_waiting(self) -> bool:
        cfg = self.engine.app_config
        return bool(cfg and cfg.disconnect_udp_on_match_end)

    async def ensure_streaming(self) -> None:
        eng = self.engine
        if eng.is_board_off or eng.is_board_dimmed or any(
            drv.protocol_mode != ProtocolMode.ACTIVE_UDP for drv in eng.drivers.values()
        ):
            await eng.wake_up(mode=ProtocolMode.ACTIVE_UDP)

    def show(self, ip: str, seg_id: Optional[int], effect: EffectConfig, transition: FlowTransition) -> None:
        drv = self.engine.get_driver(ip)
        if drv:
            acc = transition.accent_color
            drv.flow_show(seg_id, effect, transition.style, transition.duration, acc.to_tuple() if acc else None)

    def hit(self, ip: str, seg_id: Optional[int], effect: EffectConfig, strength: float) -> None:
        drv = self.engine.get_driver(ip)
        if drv:
            drv.flow_hit(seg_id, effect, strength)

    def can_locate(self, ip: str, seg_id: Optional[int]) -> bool:
        return self.engine.segment_locator(ip, seg_id)

    def locate(self, ip: str, seg_id: Optional[int], position: float, color: RGBColor) -> None:
        drv = self.engine.get_driver(ip)
        if drv:
            drv.flow_locate(seg_id, position, color, clockwise=self.engine.segment_clockwise(ip, seg_id))

    async def to_waiting(self) -> None:
        eng = self.engine
        for drv in eng.drivers.values():
            drv.flow_clear()
        if any(drv.protocol_mode == ProtocolMode.ACTIVE_UDP for drv in eng.drivers.values()):
            await eng.set_protocol_mode(ProtocolMode.IDLE_HTTP)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        await self.engine._broadcast_telemetry({**message, "lighting_mode": "flow"})
