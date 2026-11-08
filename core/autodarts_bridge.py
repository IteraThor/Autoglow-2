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

logger = logging.getLogger("autoglow.autodarts_bridge")

CLOUD_API_ON_HOLD = True
CLOUD_API_HOLD_MESSAGE = (
    "Direct Autodarts login is on hold. Install the AutoGlow Chrome extension and play on "
    "play.autodarts.com; AutoGlow receives the game data from the extension."
)

# Only data from these channels is relayed by the extension and processed here
RELAYED_CHANNELS = ("autodarts.boards", "autodarts.matches", "autodarts.lobbies")
LOBBY_CHANNEL = "autodarts.lobbies"
MATCH_CACHE_LIMIT = 8
# A reloading tab or restarting extension reconnects within seconds; only end the match if it stays gone
SOURCE_LOST_GRACE_SECONDS = 60.0

_BOARDS_LIST_RE = re.compile(r"/bs/v\d+/boards/?$")
_BOARD_ITEM_RE = re.compile(r"/bs/v\d+/boards/([^/?#]+)/?$")
_MATCH_ITEM_RE = re.compile(r"/(?:gs|as)/v\d+/matches/([^/?#]+)/?$")
_LOBBY_ITEM_RE = re.compile(r"/gs/v\d+/lobbies/([^/?#]+)/?$")
# A tab on a game page (match or lobby), preferred over one on the start page when several browsers connect
_GAME_PAGE_RE = re.compile(r"/(?:matches|lobby|lobbies)/[^/?#]+")
MAX_HTTP_SNAPSHOTS = 8
# Lobby events after which it is gone (started becomes a match, which the match data then shows)
LOBBY_END_EVENTS = ("delete", "deleted", "start", "started", "finish", "finished")
LOBBY_START_EVENTS = ("start", "started")


def is_match_over(state: Dict[str, Any]) -> bool:
    winner = state.get("winner")
    return state.get("finished") is True or (isinstance(winner, int) and not isinstance(winner, bool) and winner >= 0)


class AutodartsBridgeClient(AutodartsClient):
    """
    Drop-in replacement for AutodartsClient that never talks to the Autodarts cloud.
    The engine, hub and routes use it exactly like the cloud client; data arrives via ingest().
    """

    def __init__(self, board_id: Optional[str] = None, on_event=None):
        super().__init__(board_id=board_id, on_event=on_event)
        self._sources: List[Any] = []
        self._primary: Any = None
        # Last hello/tab state per connection, so a standby connection can take over without a gap
        self._source_state: Dict[Any, Dict[str, Any]] = {}
        self.extension_version: str = ""
        self.tab_url: str = ""
        self.tab_attached: bool = False
        self._match_cache: Dict[str, dict] = {}
        # Newest state of the Autodarts lobby the tab has open (players picked, match not started)
        self._lobby: Optional[Dict[str, Any]] = None
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
        """Register an extension connection. Only one (the primary) is used, so two browsers never double-fire events."""
        self._sources.append(source)
        self._source_state[source] = {"version": "", "attached": False, "url": ""}
        self.is_connected = True
        self._update_primary()
        logger.info(f"AutoGlow Chrome extension connected ({len(self._sources)} active connection(s))")

    def detach(self, source: Any) -> None:
        if source in self._sources:
            self._sources.remove(source)
        self._source_state.pop(source, None)
        # Another connection takes over with the tab state it last reported
        self._update_primary()
        self.is_connected = bool(self._sources)
        logger.info(f"AutoGlow Chrome extension disconnected ({len(self._sources)} active connection(s))")
        self._check_source_lost()

    def is_primary(self, source: Any) -> bool:
        return self._primary is not None and self._primary is source

    def _choose_primary(self) -> Any:
        """The connection whose browser shows a match or lobby, else one with any Autodarts tab open, else
        the oldest; the current one while it is still among the best. A Chrome left on the start page
        never blocks the one where the game is played."""
        attached = [s for s in self._sources if self._source_state.get(s, {}).get("attached")]
        playing = [s for s in attached if _GAME_PAGE_RE.search(self._source_state.get(s, {}).get("url", ""))]
        for group in (playing, attached):
            if self._primary in group:
                return self._primary
            if group:
                return group[0]
        return self._sources[0] if self._sources else None

    def _update_primary(self) -> None:
        primary = self._choose_primary()
        switched = primary is not self._primary and primary is not None
        if switched and len(self._sources) > 1:
            logger.info(f"Using the AutoGlow Bridge connection with the Autodarts tab {self._source_state.get(primary, {}).get('url') or '(none)'}")
        self._primary = primary
        self._apply_source_state(primary)
        if switched and self._source_state.get(primary, {}).get("snapshots"):
            # The game started while another browser was listened to: show its newest state at once
            self._spawn(self._replay_snapshots(primary))

    def _keep_snapshot(self, source: Any, message: Dict[str, Any]) -> None:
        """The newest match state, lobby and HTTP replies of every connection, for a later switch to it."""
        state = self._source_state.get(source)
        if state is None:
            return
        snaps = state.setdefault("snapshots", {})
        if message.get("type") == "http":
            key = f"http:{str(message.get('url', '')).split('?', 1)[0]}"
            snaps.pop(key, None)
            snaps[key] = message
            # Only the newest few replies (the match and lobby the tab shows are among them)
            while sum(k.startswith("http:") for k in snaps) > MAX_HTTP_SNAPSHOTS:
                del snaps[next(k for k in snaps if k.startswith("http:"))]
            return
        relayed = message.get("message")
        if not isinstance(relayed, dict):
            return
        channel = relayed.get("channel")
        topic = str(relayed.get("topic", ""))
        if channel == LOBBY_CHANNEL:
            snaps["lobby"] = message
        elif channel == "autodarts.matches" and topic.endswith(".state"):
            snaps["match"] = message

    async def _replay_snapshots(self, source: Any) -> None:
        snaps = dict(self._source_state.get(source, {}).get("snapshots") or {})
        for key in sorted(snaps, key=lambda k: (k != "lobby", k)):
            if not self.is_primary(source):
                return
            message = snaps[key]
            if message.get("type") == "http":
                await self._ingest_http(str(message.get("url", "")), message.get("body"))
                continue
            relayed = message["message"]
            if key == "lobby":
                self._ingest_lobby(str(relayed.get("topic", "")), relayed.get("data"))
            else:
                self._remember_snapshot(relayed.get("data"))

    def _apply_source_state(self, source: Any) -> None:
        state = self._source_state.get(source) or {}
        self.extension_version = state.get("version", "")
        self.tab_attached = bool(state.get("attached"))
        self.tab_url = state.get("url", "") if self.tab_attached else ""

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

        # Every connection's hello/tab state is kept; only the primary's is live
        state = self._source_state.get(source)
        if state is not None and msg_type == "hello":
            state["version"] = str(message.get("version", ""))[:32]
        elif state is not None and msg_type == "tab":
            state["attached"] = bool(message.get("attached"))
            state["url"] = str(message.get("url", ""))[:300] if state["attached"] else ""
        if msg_type in ("hello", "tab"):
            self._update_primary()

        if msg_type in ("ws", "http"):
            self._keep_snapshot(source, message)
        if not self.is_primary(source):
            return None

        if msg_type == "hello":
            logger.info(f"Extension handshake: AutoGlow Bridge v{self.extension_version}")
        elif msg_type == "tab":
            self._check_source_lost()
        elif msg_type == "ws":
            relayed = message.get("message")
            if not isinstance(relayed, dict) or relayed.get("channel") not in RELAYED_CHANNELS:
                return None
            if relayed.get("channel") == LOBBY_CHANNEL:
                # Shown in the Studio; a lobby lights nothing until it starts a match with a bull-off
                started = self._ingest_lobby(str(relayed.get("topic", "")), relayed.get("data"))
                if started is not None and not message.get("replay"):
                    await self._lobby_started(started)
                return None
            if message.get("replay"):
                # Resent by the extension after reconnecting: current state for the Studio, no lighting events
                if relayed.get("channel") == "autodarts.matches" and str(relayed.get("topic", "")).endswith(".state"):
                    self._remember_snapshot(relayed.get("data"))
            else:
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
        logger.info(f"No Autodarts tab for {SOURCE_LOST_GRACE_SECONDS:.0f}s -> pausing match {self._active_match_id} and emitting GAME_IDLE")
        # Nobody ended the match: when the tab relays it again, it continues
        await self._end_match(self.board_id, final=False)

    def _ingest_lobby(self, topic: str, data: Any) -> Optional[Dict[str, Any]]:
        """A lobby update: its full state (players, settings) or an event such as its deletion.
        Returns the lobby when this update started its match."""
        topic_id = topic.split(".", 1)[0]
        if not isinstance(data, dict):
            return None
        event = str(data.get("event", "") or "").lower()
        if event in LOBBY_END_EVENTS:
            ended = self._lobby
            if ended and ended.get("id") in (topic_id, data.get("id")):
                logger.info(f"Autodarts lobby {ended.get('id')} ended ({event})")
                self._lobby = None
                if event in LOBBY_START_EVENTS:
                    return ended
            return None
        if topic.endswith(".state") or isinstance(data.get("players"), list):
            lobby = dict(data)
            lobby.setdefault("id", topic_id)
            if not lobby.get("id"):
                return
            if not self._lobby or self._lobby.get("id") != lobby["id"]:
                logger.info(f"Autodarts lobby {lobby['id']} seen (tab: {self.tab_url or 'unknown'})")
            self._lobby = lobby
        return None

    async def _lobby_started(self, lobby: Dict[str, Any]) -> None:
        """A started lobby becomes the match (same id). With a bull-off, its animation starts now: Autodarts
        sends no match data until the first bull-off dart, and Game Started waits for the first leg."""
        mode = str(lobby.get("bullOffMode") or "")
        match_id = lobby.get("id")
        if match_id and self._active_match_id not in (None, match_id):
            # The next match (often a rematch) can start before Autodarts deletes the last one
            self._leave_match(f"Lobby {match_id} started the next match -> leaving match {self._active_match_id}")
        if match_id != self._paused_match_id:
            self._paused_match_id = None
        if not match_id or mode.lower() in ("", "off"):
            return
        if self._active_match_id != match_id:
            self._active_match_id = match_id
            self._reset_match_state()
        logger.info(f"Match {match_id} started from the lobby with a {mode} bull-off")
        self.begin_bull_off_view(match_id, mode, lobby)
        await self.start_bull_off()

    @property
    def last_lobby_state(self) -> Optional[Dict[str, Any]]:
        return self._lobby

    @property
    def open_lobby(self) -> Optional[Dict[str, Any]]:
        """The lobby the Autodarts tab shows right now, if any. Starting the match or leaving the lobby
        moves the tab to another page, so the lobby is open only while the tab's address names it."""
        lobby = self._lobby
        # The started match keeps the lobby's id, so only the lobby page itself counts (/lobby/<id>)
        if not lobby or not self.tab_attached:
            return None
        if not re.search(rf"/lobb(?:y|ies)/{re.escape(str(lobby.get('id')))}(?:[/?#]|$)", self.tab_url):
            return None
        return lobby

    async def _ingest_http(self, url: str, body: Any) -> None:
        path = url.split("?", 1)[0]
        lobby_match = _LOBBY_ITEM_RE.search(path)
        if lobby_match and isinstance(body, dict):
            self._ingest_lobby(f"{body.get('id') or lobby_match.group(1)}.state", body)
            return
        if _BOARDS_LIST_RE.search(path) and isinstance(body, list):
            self._boards_cache = [b for b in body if isinstance(b, dict)]
            self._own_board_ids = {str(b["id"]) for b in self._boards_cache if b.get("id")}
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
            self._remember_snapshot(body)

    def _remember_snapshot(self, state: Any) -> None:
        """Show a match state in the Studio without running it through the lighting events.
        Taken for the running match, or while none runs for a match that is not over (never old history)."""
        if not isinstance(state, dict) or not state.get("id"):
            return
        if state["id"] == self._active_match_id or (not self._active_match_id and not is_match_over(state)):
            self.remember_match_state(state)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "extension_connected": self.is_connected,
            "extension_version": self.extension_version,
            "tab_attached": self.tab_attached,
            "tab_url": self.tab_url,
            "lobby_open": self.open_lobby is not None,
        }
