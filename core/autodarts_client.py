import asyncio
import json
import logging
import time
import aiohttp
from typing import Optional, Callable, Awaitable, List, Dict, Any, Set, Tuple

try:
    import websockets
except ImportError:
    websockets = None

from core.models import DartEvent, DartEventType

logger = logging.getLogger("autoglow.autodarts_client")

AUTODARTS_AUTH_URL = "https://api.autodarts.com/auth/v1"
AUTODARTS_WS_URL = "https://play.ws.autodarts.com"
AUTODARTS_GS_URL = "https://api.autodarts.com/gs/v0"
AUTODARTS_BS_URL = "https://api.autodarts.com/bs/v0"
AUTODARTS_AS_URL = "https://api.autodarts.com/as/v0"
CLIENT_ID = "autodarts-play"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AutoGlow/2.0"
RECONNECT_MIN_DELAY = 5.0
# A match may open with a bull-off; its states use these keys for the bull-off itself, not the match
BULL_OFF_VARIANT = "Bull-off"
BULL_OFF_GAME_KEYS = frozenset({
    "variant", "settings", "gameScores", "gameFinished", "gameWinner", "scores", "stats", "state",
    "turns", "turnScore", "turnBusted", "skippedPlayers", "player", "round", "leg", "set",
})
RECONNECT_MAX_DELAY = 60.0

# Event words Autodarts sends when a match ends: a finished match has a winner, the others abort it
MATCH_FINISHED_WORDS = frozenset({"finish", "finished", "end", "ended"})
MATCH_ABORTED_WORDS = frozenset({"abort", "aborted", "delete", "deleted", "stop", "cancel", "cancelled", "canceled"})
MATCH_END_WORDS = MATCH_FINISHED_WORDS | MATCH_ABORTED_WORDS
BUST_EVENTS = frozenset({"bust", "busted", "miss", "outside"})
LEG_WON_EVENTS = frozenset({"leg-won", "leg_won", "leg", "checkout"})
MATCH_WON_EVENTS = frozenset({"match-won", "match_won", "game-won", "game_won", "winner"})
BOARD_IDLE_STATUSES = ("stopped", "idle")
# Fields a player entry may carry its name in, in order of preference
PLAYER_NAME_KEYS = ("name", "username", "userName", "nickname", "alias", "displayName")

# How a throw names its ring: segment name prefix (T20, D16, S5), or the "bed" field
_RING_PREFIXES = {3: "T", 2: "D", 1: "S"}
_RING_MULTIPLIERS = {prefix: mult for mult, prefix in _RING_PREFIXES.items()}
_BED_MULTIPLIERS = {"triple": 3, "double": 2, "single": 1, "outside": 0, "miss": 0, "off": 0}
_BULL_NAMES = frozenset({"BULL", "DBULL", "DOUBLE BULL", "DOUBLE_BULL", "BULLSEYE", "50"})
_OUTER_BULL_NAMES = frozenset({"25", "SBULL", "SINGLE BULL", "SINGLE_BULL", "OUTER BULL"})
_MISS_NAMES = frozenset({"MISS", "OUTSIDE", "OFF", "0", "NONE"})


def _event_name(payload: dict) -> str:
    """The lower-case name of a board or match event."""
    return str(payload.get("event") or payload.get("name") or payload.get("type") or "").lower()


def _takeout_step(ev_name: str) -> Optional[str]:
    """
    The step of the takeout cycle a board or match event name reports: "takeout_start", "takeout_finish",
    "takeout", "calibrating" or "throw"; None for any other event. The first step that matches wins.
    """
    if ("takeout" in ev_name or "motion" in ev_name) and "start" in ev_name:
        return "takeout_start"
    if any(word in ev_name for word in ("takeout finish", "takeout_finish", "darts-pulled", "darts_pulled", "motion finish")):
        return "takeout_finish"
    if "takeout" in ev_name or "take out" in ev_name:
        return "takeout"
    if "calibrat" in ev_name:
        return "calibrating"
    if "throw" in ev_name:
        return "throw"
    return None


def _named_winner(payload: dict) -> Any:
    """The winner a match event names, or None when it names none (Autodarts sends -1 for nobody)."""
    winner = payload.get("winner") or payload.get("player")
    return winner if winner is not None and str(winner) != "-1" else None


def _first_number(*values: Any, default: int) -> int:
    """The first of the values that is a number, as an int; default when none is."""
    return next((int(v) for v in values if isinstance(v, (int, float))), default)


class AutodartsClient:
    """
    Deep Autodarts Client module.
    Encapsulates all cloud API protocols, ticket handshakes, reconnection backoff,
    and event decoding into typed DartEvent instances.
    """

    @property
    def _active_match_id(self) -> Optional[str]:
        return self._match_id

    @_active_match_id.setter
    def _active_match_id(self, value: Optional[str]) -> None:
        # Remember matches that ended so trailing messages for them are not re-adopted as the active match
        if value is None and self._match_id:
            self._ended_match_ids[self._match_id] = None
            while len(self._ended_match_ids) > 20:
                self._ended_match_ids.pop(next(iter(self._ended_match_ids)))
        self._match_id = value

    def __init__(
        self,
        email: Optional[str] = None,
        password: Optional[str] = None,
        board_id: Optional[str] = None,
        on_event: Optional[Callable[[DartEvent], Awaitable[None]]] = None,
        on_token_refreshed: Optional[Callable[[str, str, float], Awaitable[None]]] = None,
    ):
        self.email = email
        self.password = password
        self.board_id = board_id
        self._start_announced_at: float = 0.0
        self.on_event = on_event
        self.on_token_refreshed = on_token_refreshed

        self.access_token: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.token_expires_at: float = 0.0
        self._token_lock: Optional[asyncio.Lock] = None

        self.is_connected = False
        self._running = False
        self._loop_task: Optional[asyncio.Task] = None
        self._background_tasks: Set[asyncio.Task] = set()
        self._reconnect_delay: float = RECONNECT_MIN_DELAY
        self._match_id: Optional[str] = None
        self._ended_match_ids: Dict[str, None] = {}
        # A match AutoGlow lost sight of (see _end_match): its next message picks it up again
        self._paused_match_id: Optional[str] = None

        # Tracking state to deduplicate trigger spam
        self._last_180_fired = False
        self._last_bust_fired = False
        self._last_total_legs_won: Optional[int] = None
        self._last_match_finished: bool = False
        self._last_throw_id: Optional[str] = None
        self._last_turn_id: Optional[str] = None
        self._last_leg_won_time: float = 0.0
        self._last_match_won_time: float = 0.0
        self._in_leg_break: bool = False
        # Bull-off before the first leg: None (none seen), "running" or "decided"; round grows on a tie
        self._bull_off_phase: Optional[str] = None
        self._bull_off_round: int = 0

        self.current_players: List[str] = []
        self.active_player_idx: int = 0
        # Latest match state, read by the Studio scoreboard (core/studio.py)
        self.last_match_state: Optional[dict] = None
        self.last_match_state_at: float = 0.0
        # The bull-off of the running match for the Studio: its latest state and each player's dart per
        # round (a tie starts a new round and Autodarts clears the darts of the round before)
        self.bull_off: Optional[Dict[str, Any]] = None
        self.board_states: Dict[str, dict] = {}
        self._boards_cache: List[Dict[str, Any]] = []
        # The user's own boards (from the board list); in an online match the opponent's board reports too
        self._own_board_ids: Set[str] = set()
        self.user_name: str = ""
        self.username: str = ""
        self._last_flow_state: Optional[str] = None

    # -------------------------------------------------------------------------
    # Public Interface
    # -------------------------------------------------------------------------
    async def start(self) -> None:
        """Start the background connection and event listening loop."""
        if self._running:
            return
        self._running = True
        self._loop_task = asyncio.create_task(self._connection_loop())

    async def stop(self) -> None:
        """Stop connection and cleanup."""
        self._running = False
        for task in list(self._background_tasks):
            task.cancel()
        if self._loop_task and not self._loop_task.done():
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None
        self.is_connected = False

    async def fetch_user_profile(self) -> Dict[str, Any]:
        """Fetch user profile details (name, username, email) from Autodarts Auth API."""
        token = await self._get_valid_token()
        if not token:
            return {}
        headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{AUTODARTS_AUTH_URL}/userinfo", headers=headers, timeout=aiohttp.ClientTimeout(total=4)) as resp:
                    if resp.status == 200:
                        u_info = await resp.json()
                        self.username = u_info.get("preferred_username") or u_info.get("username") or u_info.get("nickname") or u_info.get("name") or (self.email.split("@")[0] if self.email else "")
                        self.user_name = self.username
                        return u_info
        except Exception as e:
            logger.warning(f"Failed to fetch user info: {e}")
        return {}

    async def fetch_boards(self) -> List[Dict[str, Any]]:
        """Fetch list of user dartboards from Autodarts Cloud API."""
        token = await self._get_valid_token()
        if not token:
            return self._boards_cache
        boards = await self._async_get_boards(token)
        if boards:
            self._boards_cache = boards
            self._own_board_ids = {str(b["id"]) for b in boards if b.get("id")}
        return boards

    async def fetch_match_details(self, match_id: str) -> Dict[str, Any]:
        """Fetch real-time match details including player names from Autodarts API."""
        token = await self._get_valid_token()
        if not token or not match_id:
            return {}
        return await self._async_get_match_details(token, match_id)

    async def _async_get_match_details(self, token: str, match_id: str) -> Dict[str, Any]:
        try:
            headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
            async with aiohttp.ClientSession() as session:
                for base_url in [AUTODARTS_GS_URL, AUTODARTS_AS_URL]:
                    url = f"{base_url}/matches/{match_id}"
                    async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=4)) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            self._extract_and_set_players(data)
                            return data
            return {}
        except Exception as e:
            logger.warning(f"Failed to fetch match details for {match_id}: {e}")
            return {}

    async def _fetch_and_parse_match(self, match_id: str) -> None:
        """Fetch match details from REST API and parse initial state to trigger starting player illumination immediately."""
        try:
            data = await self.fetch_match_details(match_id)
            if match_id == self._active_match_id and data and isinstance(data, dict):
                logger.info(f"Successfully fetched initial match state for {match_id} (players: {', '.join(self.current_players) if self.current_players else 'None'}, active_idx: {self.active_player_idx})")
                await self._parse_match_state(data)
        except Exception:
            logger.exception(f"Failed to fetch initial match state for {match_id}")

    # -------------------------------------------------------------------------
    # Token Lifecycle & REST Helpers
    # -------------------------------------------------------------------------
    async def _get_valid_token(self) -> Optional[str]:
        if self.access_token and time.time() < (self.token_expires_at - 60):
            return self.access_token

        if self._token_lock is None:
            self._token_lock = asyncio.Lock()

        async with self._token_lock:
            # Re-check under lock in case another task refreshed while waiting
            if self.access_token and time.time() < (self.token_expires_at - 60):
                return self.access_token

            if self.refresh_token:
                try:
                    res = await self._async_refresh_token(self.refresh_token)
                    self.access_token = res.get("access_token")
                    self.refresh_token = res.get("refresh_token") or self.refresh_token
                    self.token_expires_at = time.time() + res.get("expires_in", 900)
                    if self.on_token_refreshed and self.access_token and self.refresh_token:
                        try:
                            await self.on_token_refreshed(self.access_token, self.refresh_token, self.token_expires_at)
                        except Exception as e:
                            logger.warning(f"Error executing on_token_refreshed callback: {e}")
                    return self.access_token
                except Exception as e:
                    logger.warning(f"Token refresh failed: {e}")

            if self.email and self.password:
                try:
                    res = await self._async_login(self.email, self.password)
                    self.access_token = res.get("access_token")
                    self.refresh_token = res.get("refresh_token") or self.refresh_token
                    self.token_expires_at = time.time() + res.get("expires_in", 900)
                    if self.on_token_refreshed and self.access_token and self.refresh_token:
                        try:
                            await self.on_token_refreshed(self.access_token, self.refresh_token, self.token_expires_at)
                        except Exception as e:
                            logger.warning(f"Error executing on_token_refreshed callback: {e}")
                    return self.access_token
                except Exception:
                    logger.exception("Login failed")

            return None

    async def _async_login(self, email: str, password: str) -> dict:
        url = f"{AUTODARTS_AUTH_URL}/login"
        payload = {"email": email, "username": email, "password": password, "client_id": CLIENT_ID}
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status == 200:
                    return await resp.json()
                raise RuntimeError(f"Login failed with HTTP status {resp.status}")

    async def _async_refresh_token(self, ref_token: str) -> dict:
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        # Try both darts-caller (device flow) and autodarts-play (password flow)
        client_ids = ["darts-caller", CLIENT_ID]
        endpoints = [
            f"{AUTODARTS_AUTH_URL}/token",
            f"{AUTODARTS_AUTH_URL}/refresh",
            f"{AUTODARTS_AUTH_URL}/device/token"
        ]
        async with aiohttp.ClientSession() as session:
            for ep in endpoints:
                for cid in client_ids:
                    try:
                        payload = {"refresh_token": ref_token, "client_id": cid, "grant_type": "refresh_token"}
                        async with session.post(ep, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                            if resp.status == 200:
                                return await resp.json()
                    except Exception:
                        pass
            raise RuntimeError("Token refresh failed on all client IDs")

    async def _async_get_boards(self, token: str) -> list:
        url = f"{AUTODARTS_BS_URL}/boards"
        headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=6)) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data if isinstance(data, list) else []
        except Exception as e:
            logger.warning(f"Error fetching boards: {e}")
        return []

    async def _async_fetch_ws_ticket(self, token: str) -> Optional[str]:
        url = f"{AUTODARTS_WS_URL}/ms/v0/tickets"
        headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers, timeout=aiohttp.ClientTimeout(total=6)) as resp:
                    if resp.status in [200, 201]:
                        res = await resp.json()
                        return res.get("code")
        except Exception:
            logger.exception("Failed to fetch WebSocket ticket")
        return None

    # -------------------------------------------------------------------------
    # WebSocket Connection Loop
    # -------------------------------------------------------------------------
    def _spawn(self, coro) -> asyncio.Task:
        """Run a background coroutine while holding a reference so it is not garbage-collected."""
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    async def _backoff(self, reason: str) -> None:
        """Sleep with exponential backoff (capped) before the next connection attempt."""
        delay = self._reconnect_delay
        logger.warning(f"{reason} Retrying in {delay:.0f}s...")
        await asyncio.sleep(delay)
        self._reconnect_delay = min(RECONNECT_MAX_DELAY, delay * 2)

    async def _connection_loop(self):
        if not websockets:
            logger.error("The 'websockets' library is not installed. AutodartsClient cannot connect.")
            return

        while self._running:
            token = await self._get_valid_token()
            if not token:
                await self._backoff("No valid Autodarts credentials/token.")
                continue

            boards = await self.fetch_boards()
            if not boards and not self.board_id:
                await self._backoff("No boards found for Autodarts account.")
                continue

            # Check if any board already has active match from board service
            for b in boards:
                match_id = b.get("matchId")
                if match_id:
                    self._active_match_id = match_id
                    logger.info(f"Discovered active match on board '{b.get('name', b.get('id'))}': {match_id}")
                    self._spawn(self._fetch_and_parse_match(match_id))
                    break

            ticket = await self._async_fetch_ws_ticket(token)
            if not ticket:
                await self._backoff("Could not obtain Autodarts WebSocket ticket.")
                continue

            ws_url = f"wss://play.ws.autodarts.com/ms/v0/subscribe?code={ticket}"
            try:
                async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20) as ws:
                    self.is_connected = True
                    self._reconnect_delay = RECONNECT_MIN_DELAY
                    logger.info("Connected to Autodarts WebSocket")

                    # Subscribe to all discovered board channels
                    board_ids = set()
                    if self.board_id:
                        board_ids.add(self.board_id)
                    for b in boards:
                        if b.get("id"):
                            board_ids.add(b.get("id"))

                    for b_id in board_ids:
                        for topic in ["state", "events", "matches"]:
                            await ws.send(json.dumps({
                                "type": "subscribe",
                                "channel": "autodarts.boards",
                                "topic": f"{b_id}.{topic}"
                            }))

                    # If match is active, subscribe to match topics
                    if self._active_match_id:
                        await self._subscribe_match(ws, self._active_match_id)

                    async for msg in ws:
                        if not self._running:
                            break
                        try:
                            data = json.loads(msg)
                            await self._handle_raw_message(ws, data)
                        except Exception:
                            logger.exception("Error parsing WS message")

                self.is_connected = False
                if self._running:
                    await self._backoff("Autodarts WebSocket closed by server.")
            except asyncio.CancelledError:
                self.is_connected = False
                break
            except Exception as e:
                self.is_connected = False
                await self._backoff(f"Autodarts WebSocket connection dropped: {e}.")

    # -------------------------------------------------------------------------
    # Message Normalization & Dispatch
    # -------------------------------------------------------------------------
    async def _subscribe_match(self, ws, match_id: str) -> None:
        """Subscribe to a match's state/event topics. ws is None when messages are relayed passively (extension bridge)."""
        if ws is None:
            return
        await ws.send(json.dumps({"type": "subscribe", "channel": "autodarts.matches", "topic": f"{match_id}.state"}))
        await ws.send(json.dumps({"type": "subscribe", "channel": "autodarts.matches", "topic": f"{match_id}.events"}))

    def _current_player(self) -> Optional[str]:
        """Name of the player at the board, if the match players are known."""
        return self.current_players[self.active_player_idx] if self.active_player_idx < len(self.current_players) else None

    async def _emit_player_event(self, event_type: DartEventType, player_name: Optional[str], board_id: Optional[str]) -> None:
        """An event for the player at the board (takeout, throw ...)."""
        await self._emit_event(DartEvent(event_type=event_type, player_name=player_name,
                                         player_index=self.active_player_idx, board_id=board_id))

    async def _adopt_match(self, ws, match_id: str, reason: str) -> None:
        """Make match_id the running match: fresh per-match state, and its topics subscribed."""
        self._active_match_id = match_id
        self._paused_match_id = None
        self._reset_match_state()
        logger.info(reason)
        await self._subscribe_match(ws, match_id)

    async def _start_match(self, ws, match_id: str, board_id: str, reason: str) -> None:
        """A board reports a new match: adopt it, read its players and emit GAME_START."""
        await self._adopt_match(ws, match_id, reason)
        await self._fetch_and_parse_match(match_id)
        await self._emit_event(DartEvent(event_type=DartEventType.GAME_START, board_id=board_id))

    async def _end_match(self, board_id: Optional[str], flow_state: Optional[str] = None, final: bool = True) -> None:
        """The match is over without a result (aborted, deleted ...): back to idle.
        final=False when AutoGlow only lost sight of the match (no Autodarts tab, board left it) and nobody
        ended it: its state is kept, and its next message continues it (_resume_match)."""
        match_id = self._active_match_id
        self._active_match_id = None
        if final:
            self._paused_match_id = None
            self._reset_match_state()
        else:
            self._ended_match_ids.pop(match_id or "", None)
            self._paused_match_id = match_id
        self._last_flow_state = flow_state
        await self._emit_event(DartEvent(event_type=DartEventType.GAME_IDLE, board_id=board_id))

    def _leave_match(self, reason: str) -> None:
        """Another match takes over: drop the current one without going to idle (the new one starts next)."""
        logger.info(reason)
        self._active_match_id = None
        self._paused_match_id = None
        self._reset_match_state()

    async def _resume_match(self, ws, match_id: str) -> None:
        """A match ended softly sends again: it is still running, so its lighting comes back."""
        self._active_match_id = match_id
        self._paused_match_id = None
        # The next state sends the current turn's colour again
        self._last_turn_id = None
        self._last_flow_state = None
        logger.info(f"Match {match_id} is still running -> back to the game lighting")
        await self._subscribe_match(ws, match_id)

    def _is_own_board(self, b_id: str) -> bool:
        """In an online match the page also shows the opponent's board; only ours drives the lights.
        While our boards are unknown every board counts."""
        own = self._own_board_ids | ({self.board_id} if self.board_id else set())
        return not own or b_id in own

    async def _handle_raw_message(self, ws, data: dict):
        channel = data.get("channel")
        topic = data.get("topic", "")
        payload = data.get("data", {})

        if not isinstance(payload, dict):
            return

        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"Autodarts WS RAW: channel='{channel}', topic='{topic}', payload={json.dumps(payload)}")

        if channel == "autodarts.boards":
            if not self._is_own_board(topic.split(".")[0]):
                return
            if topic.endswith(".matches"):
                await self._on_board_matches(ws, topic.split(".")[0], payload)
            elif topic.endswith(".state"):
                await self._on_board_state(ws, topic.split(".")[0], payload)
            elif topic.endswith(".events"):
                await self._on_board_event(topic.split(".")[0], payload)
        elif channel == "autodarts.matches":
            await self._on_match_message(ws, topic, payload)

    async def _on_board_matches(self, ws, b_id: str, payload: dict) -> None:
        """board.matches: a match starts or ends on the board."""
        event = str(payload.get("event") or payload.get("type") or "").lower()
        match_id = payload.get("id") or payload.get("matchId")
        if event in MATCH_END_WORDS:
            logger.info(f"Match ended/stopped on board {b_id}: {event}")
            if event in MATCH_ABORTED_WORDS:
                await self._end_match(b_id)
            elif not self._last_match_finished:
                self._last_match_finished = True
                self._in_leg_break = True
                await self._emit_match_won(winner=payload.get("winner") or payload.get("player"))
        elif match_id and match_id != self._active_match_id:
            await self._start_match(ws, match_id, b_id, f"Match started on board {b_id}: {match_id}")

    async def _on_board_state(self, ws, b_id: str, payload: dict) -> None:
        """board.state: the board's status (throw, takeout, idle ...) and the match it plays, if any."""
        self.board_states[b_id] = payload
        match_id = payload.get("matchId")
        status = payload.get("status", "")
        status_lower = str(status).lower()
        is_idle = status_lower in BOARD_IDLE_STATUSES

        if match_id and match_id != self._active_match_id:
            if not is_idle and match_id == self._paused_match_id:
                await self._resume_match(ws, match_id)
            elif not is_idle:
                await self._start_match(ws, match_id, b_id, f"Active match detected via board.state on {b_id}: {match_id}")
        elif is_idle and self._active_match_id:
            if "matchId" in payload and not match_id:
                # The board names no match any more; should the match go on, its next message continues it
                logger.info(f"Board {b_id} left match {self._active_match_id} ({status}) -> emitting GAME_IDLE")
                await self._end_match(b_id, flow_state="idle", final=False)
            elif self._last_flow_state != "stopped":
                # A detection restart or camera hiccup, not the end: the match itself says when it is over
                self._last_flow_state = "stopped"
                logger.info(f"Board {b_id} reports {status} during match {self._active_match_id} -> keeping the game lighting")

        p_name = self._current_player()
        is_takeout = "takeout" in status_lower or "take out" in status_lower
        if "calibrat" in status_lower:
            logger.info(f"Board calibration status detected: {status}")
            await self._emit_event(DartEvent(event_type=DartEventType.CALIBRATING, board_id=b_id))
        elif is_takeout and "progress" in status_lower:
            if not self._in_leg_break and self._last_flow_state != "takeout_in_progress":
                self._last_flow_state = "takeout_in_progress"
                logger.info(f"Board flow state -> TAKEOUT IN PROGRESS (Status: {status})")
                await self._emit_player_event(DartEventType.TAKEOUT_IN_PROGRESS, p_name, b_id)
        elif is_takeout:
            # A Leg or Match Won celebration is not interrupted by the takeout
            if not self._in_leg_break and self._last_flow_state != "takeout":
                self._last_flow_state = "takeout"
                logger.info(f"Board flow state -> TAKEOUT (Waiting for player to takeout, Status: {status})")
                await self._emit_player_event(DartEventType.TAKEOUT, p_name, b_id)
        elif "throw" in status_lower or "ready" in status_lower or "play" in status_lower:
            if self._active_match_id and not self._in_leg_break and self._last_flow_state != "throw":
                self._last_flow_state = "throw"
                logger.info(f"Board flow state -> THROW (Waiting for player to throw, Status: {status})")
                await self._emit_player_event(DartEventType.THROW, p_name, b_id)

    async def _on_board_event(self, b_id: str, payload: dict) -> None:
        """board.events: motion, takeout and throws the board cameras see."""
        ev_name = _event_name(payload)
        logger.info(f"Board event received on {b_id}: {ev_name}")
        p_name = self._current_player()
        if "manual reset" in ev_name or "manual_reset" in ev_name:
            if not self._in_leg_break:
                await self._emit_player_event(DartEventType.MANUAL_RESET, p_name, b_id)
                # Inside a match the board is clear after a manual reset, so the player can throw
                if self._active_match_id:
                    self._last_flow_state = "throw"
                    logger.info("Board flow state -> THROW after manual reset")
                    await self._emit_player_event(DartEventType.THROW, p_name, b_id)
            return

        step = _takeout_step(ev_name)
        if step == "calibrating":
            await self._emit_event(DartEvent(event_type=DartEventType.CALIBRATING, board_id=b_id))
            return
        if step is None or self._in_leg_break:
            return
        if step == "takeout_start":
            self._last_flow_state = "takeout_in_progress"
            logger.info(f"Board flow state -> TAKEOUT IN PROGRESS (Event: {ev_name})")
            await self._emit_player_event(DartEventType.TAKEOUT_IN_PROGRESS, p_name, b_id)
        elif step == "takeout_finish":
            self._last_flow_state = "takeout_finished"
            logger.info(f"Board flow state -> TAKEOUT FINISHED (Event: {ev_name})")
        elif step == "takeout":
            if self._last_flow_state != "takeout":
                self._last_flow_state = "takeout"
                logger.info(f"Board flow state -> TAKEOUT (Event: {ev_name})")
                await self._emit_player_event(DartEventType.TAKEOUT, p_name, b_id)
        else:  # throw
            self._last_flow_state = "throw"
            logger.info(f"Board flow state -> THROW (Event: {ev_name})")
            await self._emit_player_event(DartEventType.THROW, p_name, b_id)

    async def _on_match_message(self, ws, topic: str, payload: dict) -> None:
        """autodarts.matches: the state and events of the running match."""
        match_id_from_topic = topic.split(".")[0] if "." in topic else None
        if not match_id_from_topic and not self._active_match_id and topic in (".game-events", ".corrections"):
            # A new match announces itself with id-less topics before any throw
            now = time.time()
            if now - self._start_announced_at > 3.0:
                self._start_announced_at = now
                logger.info("Match start signalled by id-less match topic")
                b_id = next(iter(self.board_states), None)
                await self._emit_event(DartEvent(event_type=DartEventType.GAME_START, board_id=b_id))
                # Players are unknown until the first dart, so show player 1's color while waiting
                await self._emit_event(DartEvent(event_type=DartEventType.THROW, player_index=0, board_id=b_id))
            return
        if match_id_from_topic in self._ended_match_ids:
            logger.debug(f"Ignoring message for ended match {match_id_from_topic}")
            return
        if self._last_match_finished and self._active_match_id not in (None, match_id_from_topic) and match_id_from_topic:
            self._leave_match(f"Match {match_id_from_topic} follows the finished match {self._active_match_id}")
        if not self._active_match_id and match_id_from_topic and match_id_from_topic == self._paused_match_id:
            await self._resume_match(ws, match_id_from_topic)
        elif not self._active_match_id and match_id_from_topic:
            # Bridge mode never sees the board's match-start message, so the first match topic starts the match
            await self._adopt_match(ws, match_id_from_topic, f"Match started (first message on match topic): {match_id_from_topic}")
            if time.time() - self._start_announced_at > 120.0:
                await self._emit_event(DartEvent(event_type=DartEventType.GAME_START, board_id=next(iter(self.board_states), None)))

        # Ignore state/events from a stale or different match
        if self._active_match_id and match_id_from_topic and match_id_from_topic != self._active_match_id:
            logger.debug(f"Ignoring message for inactive match {match_id_from_topic} (active: {self._active_match_id})")
            return

        if topic.endswith(".state"):
            await self._parse_match_state(payload)
        elif topic.endswith(".events"):
            await self._on_match_event(payload)

    async def _on_match_event(self, payload: dict) -> None:
        """A match event: a takeout or throw step, 180, bust, or a leg or match result."""
        ev_name = _event_name(payload)
        p_name = self._current_player()
        step = _takeout_step(ev_name)
        if step == "calibrating":
            logger.info(f"Match event '{ev_name}' received -> emitting CALIBRATING")
            await self._emit_event(DartEvent(event_type=DartEventType.CALIBRATING, board_id=self.board_id))
        elif step is not None:
            # Takeout and throw steps wait while a leg or match win is celebrated
            if self._in_leg_break:
                return
            if step == "takeout_start":
                self._last_flow_state = "takeout_in_progress"
                logger.info(f"Match event '{ev_name}' received -> emitting TAKEOUT_IN_PROGRESS")
                await self._emit_player_event(DartEventType.TAKEOUT_IN_PROGRESS, p_name, self.board_id)
            elif step == "takeout_finish":
                self._last_flow_state = "takeout_finished"
                logger.info(f"Match event '{ev_name}' received -> TAKEOUT FINISHED")
            elif step == "takeout":
                if self._last_flow_state != "takeout":
                    self._last_flow_state = "takeout"
                    logger.info(f"Match event '{ev_name}' received -> emitting TAKEOUT")
                    await self._emit_player_event(DartEventType.TAKEOUT, p_name, self.board_id)
            else:  # throw; unlike a board event, a match event leaves the flow state as it is
                logger.info(f"Match event '{ev_name}' received -> emitting THROW")
                await self._emit_player_event(DartEventType.THROW, p_name, self.board_id)
        elif ev_name == "180" and not self._last_180_fired:
            self._last_180_fired = True
            await self._emit_event(DartEvent(event_type=DartEventType.SCORE_180, score=180, board_id=self.board_id))
        elif ev_name in BUST_EVENTS and not self._last_bust_fired:
            self._last_bust_fired = True
            logger.info(f"Match event '{ev_name}' received -> emitting BUST")
            await self._emit_event(DartEvent(event_type=DartEventType.BUST, score=0, multiplier=0, segment_name="Miss", board_id=self.board_id))
        elif ev_name in LEG_WON_EVENTS:
            if not self._last_match_finished:
                logger.info(f"Match event '{ev_name}' received -> emitting LEG_WON")
                p_num = payload.get("player")
                leg_winner = self.current_players[p_num] if isinstance(p_num, int) and 0 <= p_num < len(self.current_players) else None
                await self._emit_leg_won(player_name=leg_winner, player_idx=p_num)
        elif ev_name in MATCH_WON_EVENTS:
            logger.info(f"Match event '{ev_name}' received -> emitting MATCH_WON")
            winner = _named_winner(payload)
            if winner is not None:
                await self._emit_match_won(winner=winner)
        elif ev_name in MATCH_END_WORDS:
            logger.info(f"Match event '{ev_name}' received")
            if ev_name in MATCH_ABORTED_WORDS:
                await self._end_match(self.board_id)
            elif not self._last_match_finished:
                winner = _named_winner(payload)
                if winner is not None:
                    self._last_match_finished = True
                    self._in_leg_break = True
                    await self._emit_match_won(winner=winner)

    def _extract_and_set_players(self, state_or_players: Any):
        if not state_or_players:
            return

        extracted: List[str] = []

        def add_name(val):
            if isinstance(val, str):
                s = val.strip()
                if s and s not in extracted:
                    extracted.append(s)
            elif isinstance(val, dict):
                name = next((v for v in map(val.get, PLAYER_NAME_KEYS) if v), None)
                if isinstance(name, str) and name.strip():
                    if name.strip() not in extracted:
                        extracted.append(name.strip())
                    return
                # Else the user's name; a name already known falls through to the nested player lists
                user = val.get("user")
                user_name = (user.get("name") or user.get("username")) if isinstance(user, dict) else user
                if isinstance(user_name, str) and user_name.strip() and user_name.strip() not in extracted:
                    extracted.append(user_name.strip())
                    return

                for sub_key in ("players", "members", "participants"):
                    sub_list = val.get(sub_key)
                    if isinstance(sub_list, list):
                        for sub in sub_list:
                            add_name(sub)

        if isinstance(state_or_players, dict):
            p_idx = state_or_players.get("player")
            if isinstance(p_idx, int):
                self.active_player_idx = p_idx

            for key in ("players", "participants", "playerNames", "users", "teams", "roster"):
                item_list = state_or_players.get(key)
                if isinstance(item_list, list):
                    for item in item_list:
                        add_name(item)

            turns = state_or_players.get("turns")
            if isinstance(turns, list):
                for turn in turns:
                    if isinstance(turn, dict):
                        for key in ("player", "playerName", "user"):
                            add_name(turn.get(key))
        elif isinstance(state_or_players, list):
            for item in state_or_players:
                add_name(item)

        if extracted:
            self.current_players = extracted
            logger.info(f"Identified match players ({len(extracted)}): {', '.join(extracted)} (Active Idx: {self.active_player_idx})")

    def remember_match_state(self, state: dict) -> None:
        """Keep the latest match state for the Studio. A message may carry only part of it, so merge."""
        prev = self.last_match_state
        same_match = prev is not None and (not state.get("id") or prev.get("id") == state.get("id"))
        if state.get("variant") == BULL_OFF_VARIANT:
            self._remember_bull_off(state)
            # The bull-off before the first leg carries its own variant, settings and scores (bull
            # distances); keep only the match-level fields so the Studio shows the match at its start
            state = {k: v for k, v in state.items() if k not in BULL_OFF_GAME_KEYS}
            state["bullOff"] = True
        elif state.get("gameScores") is not None:
            state = {**state, "bullOff": False}
        self.last_match_state = {**prev, **state} if prev is not None and same_match else dict(state)
        self.last_match_state_at = time.time()

    def begin_bull_off_view(self, match_id: Any, mode: str, lobby: Optional[dict] = None) -> None:
        """A match opens with a bull-off: the Studio shows it from now on (the first dart comes later)."""
        if self.bull_off is None or self.bull_off.get("match_id") != match_id:
            self.bull_off = {"match_id": match_id, "mode": mode, "lobby": lobby, "state": {}, "rounds": {}}

    def _remember_bull_off(self, state: dict) -> None:
        """Keep each player's bull-off dart per round: the state names only the current turn's dart."""
        match_id = state.get("id")
        bull_off = self.bull_off
        if bull_off is None or (match_id and bull_off.get("match_id") not in (None, match_id)):
            bull_off = self.bull_off = {"match_id": match_id, "mode": "", "lobby": None, "state": {}, "rounds": {}}
        merged = bull_off["state"] = {**bull_off["state"], **state}
        bull_off["match_id"] = bull_off.get("match_id") or match_id
        settings = merged.get("settings")
        if isinstance(settings, dict) and settings.get("mode"):
            bull_off["mode"] = str(settings["mode"])
        rnd = merged.get("round")
        rnd = rnd if isinstance(rnd, int) and not isinstance(rnd, bool) else 1
        entry = bull_off["rounds"].setdefault(rnd, {"stats": None, "throws": {}})
        if isinstance(state.get("stats"), list):
            entry["stats"] = state["stats"]
        raw_players = merged.get("players")
        players = raw_players if isinstance(raw_players, list) else []
        player_ids = [p.get("id") if isinstance(p, dict) else None for p in players]
        for turn in state.get("turns") or []:
            if not isinstance(turn, dict) or turn.get("round") not in (None, rnd):
                continue
            throws = [t for t in turn.get("throws") or [] if isinstance(t, dict)]
            if throws and turn.get("playerId") in player_ids:
                entry["throws"][player_ids.index(turn["playerId"])] = throws[-1]

    @property
    def bull_off_view(self) -> Optional[Dict[str, Any]]:
        """The bull-off while it runs or shows its result, until the first leg begins."""
        bull_off = self.bull_off
        if bull_off is None:
            return None
        state = self.last_match_state
        if state is not None and state.get("id") not in (None, bull_off.get("match_id")):
            return None
        if self._bull_off_phase is not None or (state is not None and state.get("bullOff") is True):
            return bull_off
        return None

    @staticmethod
    def _is_aborted(state: dict, status_val: str) -> bool:
        """The match state says the match was aborted, cancelled, deleted or stopped."""
        return (
            status_val in ["aborted", "abort", "cancelled", "canceled", "cancel", "deleted", "delete", "stopped"]
            or state.get("aborted") is True
            or state.get("isAborted") is True
            or state.get("cancelled") is True
            or state.get("canceled") is True
        )

    @staticmethod
    def _read_throw(last_throw: dict) -> Tuple[int, int, str]:
        """(score, multiplier, label) of a throw, from whichever of the segment, score and bed fields the state has."""
        seg = last_throw.get("segment")
        seg_name, seg_number, seg_mult, seg_bed = "", None, None, ""
        if isinstance(seg, dict):
            seg_name = str(seg.get("name") or "").strip()
            seg_number = seg.get("number")
            seg_mult = seg.get("multiplier")
            seg_bed = str(seg.get("bed") or "").strip().lower()
        elif isinstance(seg, str):
            seg_name = seg.strip()
        elif isinstance(seg, (int, float)):
            seg_number = int(seg)

        # Score number (1..20, 25, 50, 0) and multiplier (0..3): the first of the fields that is a number
        score = _first_number(seg_number, last_throw.get("score"), last_throw.get("points"), default=0)
        mult = _first_number(seg_mult, last_throw.get("multiplier"), default=_BED_MULTIPLIERS.get(seg_bed, 1))

        # A segment name ("T20", "D16", "S5", "Bull", "25", "Outside", "Miss" ...) has the last word
        u_name = seg_name.upper()
        ring = _RING_MULTIPLIERS.get(u_name[:1])
        if ring and u_name[1:].isdigit():
            mult, score = ring, int(u_name[1:])
        elif u_name in _BULL_NAMES:
            mult, score, seg_name = 2, 25, "Bull"
        elif u_name in _OUTER_BULL_NAMES:
            mult, score, seg_name = 1, 25, "25"
        elif u_name in _MISS_NAMES:
            mult, score = 0, 0

        if seg_name:
            seg_label = seg_name
        elif score == 0 or mult == 0:
            seg_label = "Miss"
        elif score == 25 and mult == 2:
            seg_label = "Bull"
        elif score == 25 and mult == 1:
            seg_label = "25"
        else:
            prefix = _RING_PREFIXES.get(mult)
            seg_label = f"{prefix}{score}" if prefix else str(score)
        return score, mult, seg_label

    async def _emit_throw_events(self, last_turn: dict, last_throw: dict, throws: list, throw_id: str,
                                 score: int, mult: int, seg_label: str) -> None:
        """The event for a new throw: 180 on the third dart, bust, miss, or the hit by multiplier."""
        # 1. Check 180 (turn score == 180)
        turn_points = last_turn.get("points", 0)
        # The visit total rides on its third dart, so a flow can celebrate a ton (100+) or ton-40
        visit_total = turn_points if (len(throws) == 3 and isinstance(turn_points, int)) else None
        if len(throws) == 3 and turn_points == 180 and not self._last_180_fired:
            self._last_180_fired = True
            await self._emit_event(DartEvent(event_type=DartEventType.SCORE_180, score=180, segment_name="180", board_id=self.board_id))

        # 2. Check Bust (Turn or throw marked as busted)
        elif (last_turn.get("busted") is True or last_throw.get("busted") is True or last_turn.get("bust") is True or last_throw.get("bust") is True):
            if not self._last_bust_fired:
                self._last_bust_fired = True
                logger.info(f"Bust detected on throw {throw_id} (Turn busted)")
                await self._emit_event(DartEvent(event_type=DartEventType.BUST, score=score, segment_name=seg_label or "Bust", board_id=self.board_id))

        # 3. Check Miss (Score 0, Multiplier 0, Outside, or Miss)
        elif ((score == 0 and mult == 0) or seg_label.lower() in ["miss", "outside", "off", "none"]):
            logger.info(f"Miss detected on throw {throw_id} (Score: {score}, Multiplier: {mult}, Segment: {seg_label or 'Miss'})")
            await self._emit_event(DartEvent(event_type=DartEventType.BUST, score=0, multiplier=0, segment_number=0, segment_name=seg_label or "Miss", board_id=self.board_id))

        # 4. Check Triple Hit
        elif mult == 3:
            logger.info(f"Triple hit detected on throw {throw_id}: {seg_label} (Multiplier: 3)")
            await self._emit_event(DartEvent(event_type=DartEventType.TRIPLE, score=score * 3, multiplier=3, segment_number=score, segment_name=seg_label, round_score=visit_total, board_id=self.board_id))

        # 5. Check Bullseye (50 points)
        elif (mult == 2 and score == 25) or seg_label in ["Bull", "50"]:
            logger.info(f"Bullseye hit detected on throw {throw_id}: Bull (50)")
            await self._emit_event(DartEvent(event_type=DartEventType.BULLSEYE, score=50, multiplier=2, segment_number=25, segment_name=seg_label, round_score=visit_total, board_id=self.board_id))

        # 6. Check Double Hit (D1..D20)
        elif mult == 2:
            logger.info(f"Double hit detected on throw {throw_id}: {seg_label} (Multiplier: 2)")
            await self._emit_event(DartEvent(event_type=DartEventType.DOUBLE, score=score * 2, multiplier=2, segment_number=score, segment_name=seg_label, round_score=visit_total, board_id=self.board_id))

        # 7. Check Single Hit (S1..S20, 25)
        elif mult == 1:
            logger.info(f"Single hit detected on throw {throw_id}: {seg_label} (Multiplier: 1)")
            await self._emit_event(DartEvent(event_type=DartEventType.SINGLE, score=score, multiplier=1, segment_number=score, segment_name=seg_label, round_score=visit_total, board_id=self.board_id))

    @staticmethod
    def _count_legs(state: dict) -> Tuple[int, bool, List[int]]:
        """(legs won in total, whether the state has leg data at all, legs won per player)."""
        # Multi-schema completed legs counting
        total_legs = 0
        has_leg_info = False

        # Format 1: state["legs"] = [...] (list of completed leg objects)
        legs_list = state.get("legs")
        if isinstance(legs_list, list):
            has_leg_info = True
            won_legs = sum(1 for lg in legs_list if isinstance(lg, dict) and (lg.get("winner") is not None or lg.get("finished") is True))
            total_legs = max(total_legs, won_legs)

        # Format 2: state["players"] = [{"legs": N}, ...] or [{"legsWon": N}, ...] or [{"stats": {"legsWon": N}}]
        players_list = state.get("players")
        player_leg_counts: List[int] = []
        if isinstance(players_list, list) and players_list:
            for p in players_list:
                if isinstance(p, dict):
                    l_val = p.get("legsWon") if p.get("legsWon") is not None else p.get("legs") if p.get("legs") is not None else p.get("stats", {}).get("legs") if isinstance(p.get("stats"), dict) else None
                    if isinstance(l_val, (int, float)) and int(l_val) < 100:  # < 100 ensures point scores like 501 are never treated as legs
                        player_leg_counts.append(int(l_val))
                        has_leg_info = True
                    else:
                        player_leg_counts.append(0)
            if player_leg_counts:
                total_legs = max(total_legs, sum(player_leg_counts))

        # Format 3: state["scores"] = [{"legs": N}, ...] (only if items are dicts with explicit "legs" key)
        scores = state.get("scores")
        if isinstance(scores, list) and scores:
            score_legs = 0
            for idx, s in enumerate(scores):
                if isinstance(s, dict):
                    legs_val = s.get("legs") if s.get("legs") is not None else s.get("legsWon") if s.get("legsWon") is not None else s.get("legs_won")
                    if isinstance(legs_val, (int, float)) and int(legs_val) < 100:
                        score_legs += int(legs_val)
                        has_leg_info = True
                        if idx < len(player_leg_counts):
                            player_leg_counts[idx] = max(player_leg_counts[idx], int(legs_val))
                        else:
                            player_leg_counts.append(int(legs_val))
            if score_legs > total_legs:
                total_legs = score_legs
        return total_legs, has_leg_info, player_leg_counts

    @staticmethod
    def _legs_to_win(state: dict) -> Optional[int]:
        """Legs needed to win the match (1..30; point targets like 501 are never taken for it)."""
        legs_to_win = None
        for key in ["targetLegs", "legsToWin"]:
            val = state.get(key)
            if isinstance(val, (int, float)) and 1 <= int(val) <= 30:
                legs_to_win = int(val)
                break
        if not legs_to_win:
            match_obj = state.get("match") or state.get("settings") or state.get("game") or state.get("rules")
            if isinstance(match_obj, dict):
                for key in ["targetLegs", "legsToWin", "legs"]:
                    val = match_obj.get(key)
                    if isinstance(val, (int, float)) and 1 <= int(val) <= 30:
                        legs_to_win = int(val)
                        break
        return legs_to_win

    def _explicit_winner(self, state: dict) -> Tuple[Any, bool]:
        """(winner as the state names it, whether it names one)."""
        # Check Match Winner & Finished
        has_explicit_winner = False
        raw_winner = state.get("winner")
        if raw_winner is None and isinstance(state.get("match"), dict):
            raw_winner = state.get("match", {}).get("winner")
        # After a bull-off Autodarts lists the players winner-first, but "winner" still counts in the lobby
        # order (seen in real games 2026-11-02). gameWinner, the winner of the deciding leg, uses the current
        # order, so it names the match winner reliably once that leg is over.
        game_winner = state.get("gameWinner")
        if state.get("gameFinished") is True and isinstance(game_winner, int) and 0 <= game_winner < len(self.current_players):
            raw_winner = game_winner

        if isinstance(raw_winner, int) and 0 <= raw_winner < len(self.current_players):
            has_explicit_winner = True
        elif isinstance(raw_winner, str) and raw_winner.strip() and raw_winner.strip().lower() not in ["-1", "none", "null", "false", ""]:
            has_explicit_winner = True
        elif isinstance(raw_winner, dict) and (raw_winner.get("name") or raw_winner.get("username") or raw_winner.get("displayName")):
            has_explicit_winner = True
        else:
            raw_winner = None
        return raw_winner, has_explicit_winner

    async def _parse_match_state(self, state: dict):
        self.remember_match_state(state)
        # Check if match was aborted / cancelled / deleted / stopped
        status_val = str(state.get("status", "")).lower()
        if self._is_aborted(state, status_val):
            logger.info(f"Match {self._active_match_id} state reported aborted/cancelled (status: {status_val}) -> emitting GAME_IDLE")
            await self._end_match(self.board_id, flow_state="idle")
            return

        # Extract player names (including local players and guests)
        self._extract_and_set_players(state)

        variant = state.get("variant")
        is_bull_off = variant == BULL_OFF_VARIANT
        if is_bull_off:
            # Before the turn color below, so a timed bull-off animation plays first
            await self._track_bull_off_round(state)
        elif variant and self._bull_off_phase is not None and not self._last_match_finished:
            # First state of the first leg: the match itself begins now
            self._bull_off_phase = None
            logger.info(f"Bull-off over, first leg begins ({variant}) -> emitting GAME_START")
            await self._emit_event(DartEvent(event_type=DartEventType.GAME_START, board_id=self.board_id))

        turns = state.get("turns", [])
        if not isinstance(turns, list):
            turns = []
        await self._check_turn_change(turns)
        await self._check_new_throw(turns)

        if is_bull_off:
            # After the deciding dart's own hit effect, which arrives in the same message
            await self._check_bull_off_winner(state)
            return

        await self._check_match_result(state, status_val)
        await self._check_turn_over(turns)

    async def _check_turn_change(self, turns: list) -> None:
        """A new turn (also the first one at a match or leg start): THROW in the active player's color."""
        # Composite turn key, so empty turns at a match or leg start count as well as turn transitions
        if turns:
            raw_turn_id = str(turns[-1].get("id") or f"turn_{len(turns)}")
            turn_key = f"{raw_turn_id}_p{self.active_player_idx}"
        else:
            turn_key = f"turn_0_p{self.active_player_idx}"
        if self._last_match_finished or turn_key == self._last_turn_id:
            return

        # A fresh turn: reset the per-turn flags and end any leg break celebration
        self._last_180_fired = False
        self._last_bust_fired = False
        self._in_leg_break = False
        player_name = self._current_player()
        logger.info(f"Active player turn transition detected (turn_key='{turn_key}', player_idx={self.active_player_idx}, name='{player_name}') -> dispatching THROW")
        # The active player's turn color is the baseline for the turn
        await self._emit_player_event(DartEventType.THROW, player_name, self.board_id)
        self._last_turn_id = turn_key

    async def _check_new_throw(self, turns: list) -> None:
        """The hit events for a dart that was not seen before."""
        if not turns:
            return
        last_turn = turns[-1]
        turn_id = str(last_turn.get("id", f"turn_{len(turns)}"))
        throws = last_turn.get("throws", [])
        if not throws:
            return
        last_throw = throws[-1]
        throw_id = str(last_throw.get("id", f"{turn_id}_{len(throws)}"))
        if throw_id == self._last_throw_id:
            return
        self._last_throw_id = throw_id
        self._in_leg_break = False
        score, mult, seg_label = self._read_throw(last_throw)
        await self._emit_throw_events(last_turn, last_throw, throws, throw_id, score, mult, seg_label)

    async def _check_match_result(self, state: dict, status_val: str) -> None:
        """MATCH_WON once the match is decided; LEG_WON when a leg before the last one is won."""
        total_legs, has_leg_info, player_leg_counts = self._count_legs(state)
        legs_to_win = self._legs_to_win(state)

        # A player who reached legs_to_win (and won at least one leg) has won the match
        winning_player_idx = None
        if legs_to_win:
            winning_player_idx = next((i for i, legs in enumerate(player_leg_counts) if legs > 0 and legs >= legs_to_win), None)

        raw_winner, has_explicit_winner = self._explicit_winner(state)
        match = state.get("match")
        is_match_finished = (
            state.get("finished") is True
            or state.get("isFinished") is True
            or status_val in ("finished", "ended", "completed", "won")
            or (isinstance(match, dict) and match.get("finished") is True)
            or (has_explicit_winner and state.get("finished") is not False)
            or winning_player_idx is not None
        )

        if is_match_finished and not self._last_match_finished:
            self._last_match_finished = True
            self._in_leg_break = True
            self._last_total_legs_won = total_legs
            await self._emit_match_won(winner=raw_winner if raw_winner is not None else winning_player_idx)
        # Leg wins count only for the legs before the deciding one
        elif has_leg_info and not self._last_match_finished:
            if self._last_total_legs_won is None:
                self._last_total_legs_won = total_legs
            elif total_legs > self._last_total_legs_won:
                self._last_total_legs_won = total_legs
                leg_winner = state.get("gameWinner")
                if isinstance(leg_winner, int) and 0 <= leg_winner < len(self.current_players):
                    await self._emit_leg_won(player_name=self.current_players[leg_winner], player_idx=leg_winner)
                else:
                    await self._emit_leg_won()

    async def _check_turn_over(self, turns: list) -> None:
        """Three darts or a bust end the turn: TAKEOUT, unless a leg or match win is celebrated."""
        if not turns or self._in_leg_break or self._last_match_finished:
            return
        last_turn = turns[-1]
        throws = last_turn.get("throws", [])
        is_turn_over = len(throws) >= 3 or last_turn.get("busted") is True or last_turn.get("bust") is True
        if is_turn_over and self._last_flow_state not in ("takeout", "takeout_in_progress"):
            self._last_flow_state = "takeout"
            p_name = self._current_player()
            logger.info(f"Turn {self._last_turn_id} completed ({len(throws)} darts) -> transitioning to TAKEOUT")
            await self._emit_player_event(DartEventType.TAKEOUT, p_name, self.board_id)

    async def start_bull_off(self) -> None:
        """The match opens with a bull-off: play its animation now; Game Started follows when the first leg begins."""
        if self._bull_off_phase is not None:
            return
        self._bull_off_phase = "running"
        self._bull_off_round = 1
        logger.info("Bull-off started -> emitting BULL_OFF_START")
        await self._emit_event(DartEvent(event_type=DartEventType.BULL_OFF_START, board_id=self.board_id))

    async def _track_bull_off_round(self, state: dict) -> None:
        """A bull-off state: start the bull-off if this is the first sign of it, or restart it after a tie."""
        rnd = state.get("round")
        rnd = rnd if isinstance(rnd, int) and not isinstance(rnd, bool) else 1
        if self._bull_off_phase is None:
            await self.start_bull_off()
            self._bull_off_round = rnd
        elif rnd > self._bull_off_round:
            # Nobody won the round (PDC: same segment), so everyone throws again
            self._bull_off_round = rnd
            self._bull_off_phase = "running"
            self._in_leg_break = False
            logger.info(f"Bull-off tie -> round {rnd}, emitting BULL_OFF_START again")
            await self._emit_event(DartEvent(event_type=DartEventType.BULL_OFF_START, board_id=self.board_id))

    async def _check_bull_off_winner(self, state: dict) -> None:
        """Bull-off decided: gameFinished with the winner's index in gameWinner (the game_shot event names
        the last thrower, not the winner)."""
        winner = state.get("gameWinner")
        if self._bull_off_phase != "running" or state.get("gameFinished") is not True:
            return
        if not isinstance(winner, int) or isinstance(winner, bool) or winner < 0:
            return
        self._bull_off_phase = "decided"
        # Hold the winner's animation through the takeout until the first leg begins
        self._in_leg_break = True
        name = self.current_players[winner] if winner < len(self.current_players) else None
        logger.info(f"Bull-off won by {name or f'player {winner + 1}'} -> emitting BULL_OFF_WON")
        await self._emit_event(DartEvent(event_type=DartEventType.BULL_OFF_WON, player_name=name, player_index=winner, board_id=self.board_id))

    def _reset_match_state(self):
        self._last_180_fired = False
        self._last_bust_fired = False
        self._last_total_legs_won = None
        self._last_match_finished = False
        self._last_throw_id = None
        self._last_turn_id = None
        self._last_leg_won_time = 0.0
        self._last_match_won_time = 0.0
        self._in_leg_break = False
        self._last_flow_state = None
        self._bull_off_phase = None
        self._bull_off_round = 0
        self.bull_off = None
        self.current_players = []
        self.active_player_idx = 0
        self.last_match_state = None
        self.last_match_state_at = 0.0

    async def _emit_leg_won(self, player_name: Optional[Any] = None, player_idx: Optional[int] = None):
        # Never emit or overwrite with LEG_WON if match is already won!
        if self._last_match_finished:
            return
        now = time.time()
        if now - self._last_leg_won_time < 2.0:
            return
        self._last_leg_won_time = now
        self._in_leg_break = True

        p_name = None
        if isinstance(player_name, str) and player_name.strip() and player_name.strip().lower() not in ["-1", "none", "null", "false", ""]:
            p_name = player_name.strip()
        elif isinstance(player_name, int) and 0 <= player_name < len(self.current_players):
            p_name = self.current_players[player_name]
        elif isinstance(player_name, dict):
            p_name = player_name.get("name") or player_name.get("username")

        if not p_name:
            idx = player_idx if player_idx is not None else self.active_player_idx
            p_name = self.current_players[idx] if isinstance(idx, int) and 0 <= idx < len(self.current_players) else None

        p_idx = player_idx if player_idx is not None else self.active_player_idx
        logger.info(f"Emitting LEG_WON event on board {self.board_id} (Winner: {p_name})")
        await self._emit_event(DartEvent(
            event_type=DartEventType.LEG_WON,
            player_name=p_name,
            player_index=p_idx,
            board_id=self.board_id
        ))

    async def _emit_match_won(self, winner: Optional[Any] = None):
        now = time.time()
        if now - self._last_match_won_time < 2.0:
            return
        self._last_match_won_time = now
        self._last_match_finished = True
        self._in_leg_break = True

        winner_name = None
        if isinstance(winner, str) and winner.strip() and winner.strip().lower() not in ["-1", "none", "null", "false", ""]:
            winner_name = winner.strip()
        elif isinstance(winner, int) and 0 <= winner < len(self.current_players):
            winner_name = self.current_players[winner]
        elif isinstance(winner, dict):
            winner_name = winner.get("name") or winner.get("username") or winner.get("displayName")
        
        if not winner_name and 0 <= self.active_player_idx < len(self.current_players):
            winner_name = self.current_players[self.active_player_idx]

        logger.info(f"Emitting MATCH_WON event on board {self.board_id} (Winner: {winner_name})")
        await self._emit_event(DartEvent(
            event_type=DartEventType.MATCH_WON,
            player_name=winner_name,
            board_id=self.board_id
        ))

    async def _emit_event(self, event: DartEvent):
        if self.on_event:
            try:
                await self.on_event(event)
            except Exception:
                logger.exception("Error executing on_event callback")
