"""
AutoGlow 2 - Autodarts Browser Extension Bridge
Receives Autodarts game data relayed by the AutoGlow Chrome extension while the user plays
on play.autodarts.com, and feeds it through the same parser as the direct cloud client.

The direct cloud login (email/password and device link) is on hold until Autodarts approves
it; that code stays in AutodartsClient and is re-enabled by setting CLOUD_API_ON_HOLD = False.
"""

import asyncio
import logging
import re
import time
from typing import Any, Dict, List, Optional

from core.autodarts_client import AutodartsClient
from core.models import DartEvent, DartEventType

logger = logging.getLogger("autoglow.autodarts_bridge")

CLOUD_API_ON_HOLD = True
CLOUD_API_HOLD_MESSAGE = (
    "Direct Autodarts login is on hold. Install the AutoGlow Chrome extension and play on "
    "play.autodarts.com; AutoGlow receives the game data from the extension."
)

# Only data from these channels is relayed by the extension and processed here
RELAYED_CHANNELS = ("autodarts.boards", "autodarts.matches")
MATCH_CACHE_LIMIT = 8
# A reloading tab or restarting extension reconnects within seconds; only end the match if it stays gone
SOURCE_LOST_GRACE_SECONDS = 60.0

_BOARDS_LIST_RE = re.compile(r"/bs/v\d+/boards/?$")
_BOARD_ITEM_RE = re.compile(r"/bs/v\d+/boards/([^/?#]+)/?$")
_MATCH_ITEM_RE = re.compile(r"/(?:gs|as)/v\d+/matches/([^/?#]+)/?$")


class AutodartsBridgeClient(AutodartsClient):
    """
    Drop-in replacement for AutodartsClient that never talks to the Autodarts cloud.
    The engine, hub and routes use it exactly like the cloud client; data arrives via ingest().
    """

    def __init__(self, board_id: Optional[str] = None, on_event=None):
        super().__init__(board_id=board_id, on_event=on_event)
        self._sources: List[Any] = []
        self.extension_version: str = ""
        self.tab_url: str = ""
        self.tab_attached: bool = False
        self._match_cache: Dict[str, dict] = {}
        self._source_lost_task: Optional[asyncio.Task] = None

    # -------------------------------------------------------------------------
    # Lifecycle (no network loop: the extension pushes data to us)
    # -------------------------------------------------------------------------
    async def start(self) -> None:
        self._running = True

    async def stop(self) -> None:
        self._running = False
        for task in list(self._background_tasks):
            task.cancel()

    def attach(self, source: Any) -> None:
        """Register an extension connection. Only the oldest one is used, so two browsers never double-fire events."""
        self._sources.append(source)
        self.is_connected = True
        logger.info(f"AutoGlow Chrome extension connected ({len(self._sources)} active connection(s))")

    def detach(self, source: Any) -> None:
        was_primary = bool(self._sources) and self._sources[0] is source
        if source in self._sources:
            self._sources.remove(source)
        if was_primary:
            self.tab_attached = False
            self.tab_url = ""
            self.extension_version = ""
        self.is_connected = bool(self._sources)
        logger.info(f"AutoGlow Chrome extension disconnected ({len(self._sources)} active connection(s))")
        self._check_source_lost()

    def is_primary(self, source: Any) -> bool:
        return bool(self._sources) and self._sources[0] is source

    # -------------------------------------------------------------------------
    # Cloud REST calls are replaced by data observed in the browser
    # -------------------------------------------------------------------------
    async def fetch_user_profile(self) -> Dict[str, Any]:
        return {}

    async def fetch_boards(self) -> List[Dict[str, Any]]:
        return self._boards_cache

    async def fetch_match_details(self, match_id: str) -> Dict[str, Any]:
        data = self._match_cache.get(match_id) or {}
        if data:
            self._extract_and_set_players(data)
        return data

    async def _get_valid_token(self) -> Optional[str]:
        return None

    # -------------------------------------------------------------------------
    # Inbound messages from the extension
    # -------------------------------------------------------------------------
    async def ingest(self, source: Any, message: Any) -> Optional[dict]:
        """Process one message from an extension connection. Returns a reply to send back, if any."""
        if not isinstance(message, dict):
            return None
        msg_type = message.get("type")

        if msg_type == "ping":
            return {"type": "pong", "ts": time.time()}

        if not self.is_primary(source):
            return None

        if msg_type == "hello":
            self.extension_version = str(message.get("version", ""))[:32]
            logger.info(f"Extension handshake: AutoGlow Bridge v{self.extension_version}")
        elif msg_type == "tab":
            self.tab_attached = bool(message.get("attached"))
            self.tab_url = str(message.get("url", ""))[:300] if self.tab_attached else ""
            self._check_source_lost()
        elif msg_type == "ws":
            relayed = message.get("message")
            if isinstance(relayed, dict) and relayed.get("channel") in RELAYED_CHANNELS:
                await self._handle_raw_message(None, relayed)
        elif msg_type == "http":
            await self._ingest_http(str(message.get("url", "")), message.get("body"))
        return None

    def _check_source_lost(self) -> None:
        """Start the grace timer that ends a running match when no Autodarts tab is relaying it any more."""
        receiving = bool(self._sources) and self.tab_attached
        if receiving or not self._active_match_id:
            return
        if self._source_lost_task is None or self._source_lost_task.done():
            self._source_lost_task = self._spawn(self._end_match_after_grace())

    async def _end_match_after_grace(self) -> None:
        await asyncio.sleep(SOURCE_LOST_GRACE_SECONDS)
        if (self._sources and self.tab_attached) or not self._active_match_id:
            return
        logger.info(f"No Autodarts tab for {SOURCE_LOST_GRACE_SECONDS:.0f}s -> ending match {self._active_match_id} and emitting GAME_IDLE")
        self._active_match_id = None
        self._reset_match_state()
        await self._emit_event(DartEvent(event_type=DartEventType.GAME_IDLE, board_id=self.board_id))

    async def _ingest_http(self, url: str, body: Any) -> None:
        path = url.split("?", 1)[0]
        if _BOARDS_LIST_RE.search(path) and isinstance(body, list):
            self._boards_cache = [b for b in body if isinstance(b, dict)]
            return

        board_match = _BOARD_ITEM_RE.search(path)
        if board_match and isinstance(body, dict) and body.get("id"):
            self._boards_cache = [b for b in self._boards_cache if b.get("id") != body["id"]] + [body]
            return

        match_match = _MATCH_ITEM_RE.search(path)
        if match_match and isinstance(body, dict):
            match_id = str(body.get("id") or match_match.group(1))
            self._match_cache[match_id] = body
            while len(self._match_cache) > MATCH_CACHE_LIMIT:
                self._match_cache.pop(next(iter(self._match_cache)))
            if match_id == self._active_match_id:
                self._extract_and_set_players(body)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "extension_connected": self.is_connected,
            "extension_version": self.extension_version,
            "tab_attached": self.tab_attached,
            "tab_url": self.tab_url,
        }
