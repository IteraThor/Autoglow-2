"""
AutoGlow 2 - Studio dart zoom: where and when each dart landed, from the Autodarts Board Manager on
this computer. The board camera is shown a few seconds late (studio_camera, ?delay=), so the live page
knows a dart before the picture shows it and can zoom to it in advance.

The Board Manager's event socket (ws://127.0.0.1:3180/api/events) is only a fast trigger: on each
message the current state (/api/state, with the throws of the visit) is read and new darts are noted
with the time they were reported (time.time(), the same clock as the camera frames).
Runs only while the dart zoom is switched on.
"""

import asyncio
import json
import logging
import time
from typing import Any, Dict, List, Optional

import aiohttp

from core import studio
from core.studio_camera import BOARD_MANAGER_URL

logger = logging.getLogger("autoglow.studio_darts")

EVENTS_URL = BOARD_MANAGER_URL.replace("http://", "ws://") + "/api/events"
STATE_URL = f"{BOARD_MANAGER_URL}/api/state"
KEEP_SECONDS = 20.0
FALLBACK_POLL = 1.0   # Read the state at least this often, in case an event is missed
IDLE_CHECK = 3.0      # How often to look whether the dart zoom was switched on


class DartWatcher:
    def __init__(self) -> None:
        self.darts: List[Dict[str, Any]] = []
        self._known = 0          # Throws of the current visit already noted
        self._seq = 0
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if not self._task:
            self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def recent(self) -> List[Dict[str, Any]]:
        """Darts of the last seconds, oldest first: {id, t, x, y, label}."""
        cutoff = time.time() - KEEP_SECONDS
        return [d for d in self.darts if d["t"] >= cutoff]

    # --- state ---
    def note_state(self, state: Any, reported_at: float) -> None:
        throws = state.get("throws") if isinstance(state, dict) else None
        if not isinstance(throws, list):
            return
        if len(throws) < self._known:
            self._known = 0  # Darts pulled (or a correction): a new visit starts
        for throw in throws[self._known:]:
            self._seq += 1
            self.darts.append({"id": self._seq, "t": round(reported_at, 3), **_position(throw)})
        self._known = len(throws)
        cutoff = time.time() - KEEP_SECONDS
        self.darts = [d for d in self.darts if d["t"] >= cutoff]

    async def _read_state(self, session: aiohttp.ClientSession, reported_at: float) -> None:
        try:
            async with session.get(STATE_URL) as res:
                self.note_state(await res.json(content_type=None), reported_at)
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError, ValueError):
            pass

    async def _run(self) -> None:
        delay = 1.0
        while True:
            if not studio.cached_settings().get("dart_zoom", {}).get("enabled"):
                self._known = 0
                await asyncio.sleep(IDLE_CHECK)
                continue
            try:
                timeout = aiohttp.ClientTimeout(total=None, sock_connect=3)
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as http, \
                        aiohttp.ClientSession(timeout=timeout) as ws_session, \
                        ws_session.ws_connect(EVENTS_URL, heartbeat=20) as ws:
                    logger.info("Dart zoom: listening to the Autodarts Board Manager")
                    delay = 1.0
                    # Darts already on the board when we start are not new
                    await self._read_state(http, time.time())
                    self.darts.clear()
                    while studio.cached_settings().get("dart_zoom", {}).get("enabled"):
                        try:
                            msg = await ws.receive(timeout=FALLBACK_POLL)
                        except asyncio.TimeoutError:
                            await self._read_state(http, time.time())
                            continue
                        if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.ERROR):
                            break
                        reported_at = time.time()
                        # The message itself may carry the state; else read it
                        data = _json(msg.data) if msg.type == aiohttp.WSMsgType.TEXT else None
                        inner = data.get("data") if isinstance(data, dict) else None
                        if isinstance(data, dict) and isinstance(data.get("throws"), list):
                            self.note_state(data, reported_at)
                        elif isinstance(inner, dict) and isinstance(inner.get("throws"), list):
                            self.note_state(inner, reported_at)
                        else:
                            await self._read_state(http, reported_at)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.debug(f"Dart zoom: Board Manager not reachable ({e})")
            await asyncio.sleep(delay)
            delay = min(10.0, delay * 2)


def _position(throw: Any) -> Dict[str, Any]:
    """x, y and label of a Board Manager throw. It sends flat fields (coordsX, coordsY, segmentName);
    the play.autodarts.com format (coords {x, y}, segment {name}) is read as well. A bounce-out or a
    failed detection counts as a miss (no position): the camera stays wide."""
    if not isinstance(throw, dict):
        return {"x": None, "y": None, "label": ""}
    detail = studio.throw_detail(throw)
    x = throw.get("coordsX", detail["x"])
    y = throw.get("coordsY", detail["y"])
    usable = all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (x, y))
    if throw.get("bouncer") or throw.get("failed"):
        usable = False
    return {"x": round(x, 4) if usable else None, "y": round(y, 4) if usable else None,
            "label": str(throw.get("segmentName") or detail["label"] or "")}


def _json(text: Any) -> Any:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None
