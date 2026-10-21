import asyncio
import json
import logging
import time
import aiohttp
from typing import Optional, Callable, Awaitable, List, Dict, Any, Set

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
RECONNECT_MAX_DELAY = 60.0


class AutodartsClient:
    """
    Deep Autodarts Client module.
    Encapsulates all cloud API protocols, ticket handshakes, reconnection backoff,
    and event decoding into typed DartEvent instances.
    """

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
        self._active_match_id: Optional[str] = None

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

        self.current_players: List[str] = []
        self.active_player_idx: int = 0
        self.board_states: Dict[str, dict] = {}
        self._boards_cache: List[Dict[str, Any]] = []
        self.user_name: str = ""
        self.username: str = ""
        self.user_id: Optional[str] = None
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
                        self.user_id = u_info.get("sub")
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
        return boards

    def is_board_online(self, board_id: str) -> bool:
        """
        Check if a specific Autodarts board is online and reachable.
        Returns True if connected/online, False if strictly offline/disconnected.
        """
        if not board_id or not board_id.strip():
            return True

        target_id = board_id.strip().lower()

        # 1. Check live WebSocket state if known
        for b_id, state in self.board_states.items():
            if b_id.lower() == target_id:
                if isinstance(state, dict):
                    conn = state.get("connected")
                    status = str(state.get("status", "")).strip().lower()
                    if conn is False or status == "offline":
                        return False
                    if conn is True or status in ["throw", "takeout", "takeout in progress", "idle", "ready", "calibrating", "starting"]:
                        return True

        # 2. Check cached/fetched boards catalog
        for b in self._boards_cache:
            if str(b.get("id", "")).lower() == target_id:
                if "online" in b:
                    return bool(b["online"])
                b_state = b.get("state")
                if isinstance(b_state, dict):
                    conn = b_state.get("connected")
                    status = str(b_state.get("status", "")).strip().lower()
                    if conn is False or status == "offline":
                        return False
                    if conn is True:
                        return True

        return True

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
                    if self.on_token_refreshed:
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
                    if self.on_token_refreshed:
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
                if b.get("matchId"):
                    self._active_match_id = b.get("matchId")
                    logger.info(f"Discovered active match on board '{b.get('name', b.get('id'))}': {self._active_match_id}")
                    self._spawn(self._fetch_and_parse_match(self._active_match_id))
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

    async def _handle_raw_message(self, ws, data: dict):
        channel = data.get("channel")
        topic = data.get("topic", "")
        payload = data.get("data", {})

        if not isinstance(payload, dict):
            return

        logger.info(f"Autodarts WS RAW: channel='{channel}', topic='{topic}', payload={json.dumps(payload)}")

        # 1. Match Start / Stop Detection from board.matches
        if channel == "autodarts.boards" and topic.endswith(".matches"):
            b_id = topic.split(".")[0]
            event = str(payload.get("event") or payload.get("type") or "").lower()
            match_id = payload.get("id") or payload.get("matchId")
            if event in ["start", "created"] or (event not in ["stop", "finish", "finished", "abort", "aborted", "delete", "deleted", "end", "ended", "cancel", "cancelled", "canceled"] and match_id):
                if match_id and match_id != self._active_match_id:
                    self._active_match_id = match_id
                    self._reset_match_state()
                    logger.info(f"Match started on board {b_id}: {match_id}")
                    await self._subscribe_match(ws, match_id)
                    await self._fetch_and_parse_match(match_id)
                    await self._emit_event(DartEvent(event_type=DartEventType.GAME_START, board_id=b_id))
            elif event in ["stop", "finish", "finished", "abort", "aborted", "delete", "deleted", "end", "ended", "cancel", "cancelled", "canceled"]:
                logger.info(f"Match ended/stopped on board {b_id}: {event}")
                if event in ["finish", "finished", "end", "ended"] and not self._last_match_finished:
                    self._last_match_finished = True
                    self._in_leg_break = True
                    winner = payload.get("winner") or payload.get("player")
                    await self._emit_match_won(winner=winner)
                if event in ["abort", "aborted", "delete", "deleted", "stop", "cancel", "cancelled", "canceled"]:
                    self._active_match_id = None
                    self._reset_match_state()
                    await self._emit_event(DartEvent(event_type=DartEventType.GAME_IDLE, board_id=b_id))

        # 2. Board State (Takeout / Idle / Throw / Match Presence)
        if channel == "autodarts.boards" and topic.endswith(".state"):
            b_id = topic.split(".")[0]
            self.board_states[b_id] = payload
            match_id = payload.get("matchId")
            status = payload.get("status", "")
            status_lower = str(status).lower()

            if match_id and match_id != self._active_match_id:
                if status_lower not in ["stopped", "idle"]:
                    self._active_match_id = match_id
                    self._reset_match_state()
                    logger.info(f"Active match detected via board.state on {b_id}: {match_id}")
                    await self._subscribe_match(ws, match_id)
                    await self._fetch_and_parse_match(match_id)
                    await self._emit_event(DartEvent(event_type=DartEventType.GAME_START, board_id=b_id))
            elif status_lower in ["stopped", "idle"]:
                if self._active_match_id:
                    logger.info(f"Board {b_id} state reported idle/stopped -> clearing match {self._active_match_id} and emitting GAME_IDLE")
                    self._active_match_id = None
                    self._reset_match_state()
                    self._in_leg_break = False
                    self._last_flow_state = "idle"
                    await self._emit_event(DartEvent(event_type=DartEventType.GAME_IDLE, board_id=b_id))

            p_name = self.current_players[self.active_player_idx] if self.active_player_idx < len(self.current_players) else None
            if "calibrat" in status_lower:
                logger.info(f"Board calibration status detected: {status}")
                await self._emit_event(DartEvent(event_type=DartEventType.CALIBRATING, board_id=b_id))
            elif "progress" in status_lower and ("takeout" in status_lower or "take out" in status_lower):
                if not self._in_leg_break and self._last_flow_state != "takeout_in_progress":
                    self._last_flow_state = "takeout_in_progress"
                    logger.info(f"Board flow state -> TAKEOUT IN PROGRESS (Status: {status})")
                    await self._emit_event(DartEvent(event_type=DartEventType.TAKEOUT_IN_PROGRESS, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))
            elif "takeout" in status_lower or "take out" in status_lower:
                # If we are celebrating a Leg or Match Won, don't interrupt with Takeout
                if not self._in_leg_break and self._last_flow_state != "takeout":
                    self._last_flow_state = "takeout"
                    logger.info(f"Board flow state -> TAKEOUT (Waiting for player to takeout, Status: {status})")
                    await self._emit_event(DartEvent(event_type=DartEventType.TAKEOUT, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))
            elif status in ["Throw in progress", "Throw", "Ready for throw", "Playing", "Ready"] or "throw" in status_lower or "ready" in status_lower or "play" in status_lower:
                if self._active_match_id and not self._in_leg_break and self._last_flow_state != "throw":
                    self._last_flow_state = "throw"
                    logger.info(f"Board flow state -> THROW (Waiting for player to throw, Status: {status})")
                    await self._emit_event(DartEvent(event_type=DartEventType.THROW, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))

        # 3. Board Events (motion / takeout / throws from board cameras)
        if channel == "autodarts.boards" and topic.endswith(".events"):
            b_id = topic.split(".")[0]
            ev_name = str(payload.get("event") or payload.get("name") or payload.get("type") or "").lower()
            logger.info(f"Board event received on {b_id}: {ev_name}")
            p_name = self.current_players[self.active_player_idx] if self.active_player_idx < len(self.current_players) else None
            if "manual reset" in ev_name or "manual_reset" in ev_name:
                if not self._in_leg_break:
                    await self._emit_event(DartEvent(event_type=DartEventType.MANUAL_RESET, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))
                    # After manual reset, if inside an active game, board is clear -> ready for player to throw!
                    if self._active_match_id:
                        self._last_flow_state = "throw"
                        logger.info("Board flow state -> THROW after manual reset")
                        await self._emit_event(DartEvent(event_type=DartEventType.THROW, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))
            elif "takeout start" in ev_name or "takeout_start" in ev_name or (("takeout" in ev_name or "motion" in ev_name) and "start" in ev_name):
                if not self._in_leg_break:
                    self._last_flow_state = "takeout_in_progress"
                    logger.info(f"Board flow state -> TAKEOUT IN PROGRESS (Event: {ev_name})")
                    await self._emit_event(DartEvent(event_type=DartEventType.TAKEOUT_IN_PROGRESS, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))
            elif "takeout finish" in ev_name or "takeout_finish" in ev_name or "darts-pulled" in ev_name or "darts_pulled" in ev_name or "motion finish" in ev_name:
                if not self._in_leg_break:
                    self._last_flow_state = "takeout_finished"
                    logger.info(f"Board flow state -> TAKEOUT FINISHED (Event: {ev_name})")
            elif "takeout" in ev_name or "take out" in ev_name:
                if not self._in_leg_break and self._last_flow_state != "takeout":
                    self._last_flow_state = "takeout"
                    logger.info(f"Board flow state -> TAKEOUT (Event: {ev_name})")
                    await self._emit_event(DartEvent(event_type=DartEventType.TAKEOUT, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))
            elif "calibrat" in ev_name:
                await self._emit_event(DartEvent(event_type=DartEventType.CALIBRATING, board_id=b_id))
            elif "throw" in ev_name:
                if not self._in_leg_break:
                    self._last_flow_state = "throw"
                    logger.info(f"Board flow state -> THROW (Event: {ev_name})")
                    await self._emit_event(DartEvent(event_type=DartEventType.THROW, player_name=p_name, player_index=self.active_player_idx, board_id=b_id))

        # 4. Match State & Events
        if channel == "autodarts.matches":
            match_id_from_topic = topic.split(".")[0] if "." in topic else None
            if not self._active_match_id and match_id_from_topic:
                self._active_match_id = match_id_from_topic

            # Ignore state/events from a stale or different match
            if self._active_match_id and match_id_from_topic and match_id_from_topic != self._active_match_id:
                logger.debug(f"Ignoring message for inactive match {match_id_from_topic} (active: {self._active_match_id})")
                return

            if topic.endswith(".state"):
                await self._parse_match_state(payload)
            elif topic.endswith(".events"):
                ev_name = str(payload.get("event") or payload.get("name") or payload.get("type") or "").lower()
                p_name = self.current_players[self.active_player_idx] if self.active_player_idx < len(self.current_players) else None
                if "takeout start" in ev_name or "takeout_start" in ev_name or (("takeout" in ev_name or "motion" in ev_name) and "start" in ev_name):
                    if not self._in_leg_break:
                        self._last_flow_state = "takeout_in_progress"
                        logger.info(f"Match event '{ev_name}' received -> emitting TAKEOUT_IN_PROGRESS")
                        await self._emit_event(DartEvent(event_type=DartEventType.TAKEOUT_IN_PROGRESS, player_name=p_name, player_index=self.active_player_idx, board_id=self.board_id))
                elif "takeout finish" in ev_name or "takeout_finish" in ev_name or "darts-pulled" in ev_name or "darts_pulled" in ev_name or "motion finish" in ev_name:
                    if not self._in_leg_break:
                        self._last_flow_state = "takeout_finished"
                        logger.info(f"Match event '{ev_name}' received -> TAKEOUT FINISHED")
                elif "takeout" in ev_name or "take out" in ev_name:
                    if not self._in_leg_break and self._last_flow_state != "takeout":
                        self._last_flow_state = "takeout"
                        logger.info(f"Match event '{ev_name}' received -> emitting TAKEOUT")
                        await self._emit_event(DartEvent(event_type=DartEventType.TAKEOUT, player_name=p_name, player_index=self.active_player_idx, board_id=self.board_id))
                elif "calibrat" in ev_name:
                    logger.info(f"Match event '{ev_name}' received -> emitting CALIBRATING")
                    await self._emit_event(DartEvent(event_type=DartEventType.CALIBRATING, board_id=self.board_id))
                elif "throw" in ev_name:
                    if not self._in_leg_break:
                        logger.info(f"Match event '{ev_name}' received -> emitting THROW")
                        await self._emit_event(DartEvent(event_type=DartEventType.THROW, player_name=p_name, player_index=self.active_player_idx, board_id=self.board_id))
                elif ev_name == "180" and not self._last_180_fired:
                    self._last_180_fired = True
                    await self._emit_event(DartEvent(event_type=DartEventType.SCORE_180, score=180, board_id=self.board_id))
                elif ev_name in ["bust", "busted", "miss", "outside"] and not self._last_bust_fired:
                    self._last_bust_fired = True
                    logger.info(f"Match event '{ev_name}' received -> emitting BUST")
                    await self._emit_event(DartEvent(event_type=DartEventType.BUST, score=0, multiplier=0, segment_name="Miss", board_id=self.board_id))
                elif ev_name in ["leg-won", "leg_won", "leg", "checkout"]:
                    if not self._last_match_finished:
                        logger.info(f"Match event '{ev_name}' received -> emitting LEG_WON")
                        p_num = payload.get("player")
                        p_name = self.current_players[p_num] if isinstance(p_num, int) and 0 <= p_num < len(self.current_players) else None
                        await self._emit_leg_won(player_name=p_name, player_idx=p_num)
                elif ev_name in ["match-won", "match_won", "game-won", "game_won", "winner"]:
                    logger.info(f"Match event '{ev_name}' received -> emitting MATCH_WON")
                    winner = payload.get("winner") or payload.get("player")
                    if winner is not None and str(winner) != "-1":
                        await self._emit_match_won(winner=winner)
                elif ev_name in ["finish", "finished", "abort", "aborted", "end", "ended", "cancel", "cancelled", "canceled", "delete", "deleted", "stop"]:
                    logger.info(f"Match event '{ev_name}' received")
                    if ev_name in ["finish", "finished", "end", "ended"] and not self._last_match_finished:
                        winner = payload.get("winner") or payload.get("player")
                        if winner is not None and str(winner) != "-1":
                            self._last_match_finished = True
                            self._in_leg_break = True
                            await self._emit_match_won(winner=winner)
                    if ev_name in ["abort", "aborted", "delete", "deleted", "stop", "cancel", "cancelled", "canceled"]:
                        self._active_match_id = None
                        self._reset_match_state()
                        await self._emit_event(DartEvent(event_type=DartEventType.GAME_IDLE, board_id=self.board_id))

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
                n = (
                    val.get("name") or 
                    val.get("username") or 
                    val.get("userName") or 
                    val.get("nickname") or 
                    val.get("alias") or 
                    val.get("displayName")
                )
                if n and isinstance(n, str) and n.strip():
                    if n.strip() not in extracted:
                        extracted.append(n.strip())
                    return
                user_obj = val.get("user")
                if isinstance(user_obj, dict):
                    un = user_obj.get("name") or user_obj.get("username")
                    if un and isinstance(un, str) and un.strip() and un.strip() not in extracted:
                        extracted.append(un.strip())
                        return
                elif isinstance(user_obj, str) and user_obj.strip() and user_obj.strip() not in extracted:
                    extracted.append(user_obj.strip())
                    return

                for sub_key in ["players", "members", "participants"]:
                    sub_list = val.get(sub_key)
                    if isinstance(sub_list, list):
                        for sub in sub_list:
                            add_name(sub)

        if isinstance(state_or_players, dict):
            p_idx = state_or_players.get("player")
            if isinstance(p_idx, int):
                self.active_player_idx = p_idx

            for key in ["players", "participants", "playerNames", "users", "teams", "roster"]:
                item_list = state_or_players.get(key)
                if isinstance(item_list, list):
                    for item in item_list:
                        add_name(item)
            
            turns = state_or_players.get("turns")
            if isinstance(turns, list):
                for t in turns:
                    if isinstance(t, dict):
                        add_name(t.get("player"))
                        add_name(t.get("playerName"))
                        add_name(t.get("user"))
        elif isinstance(state_or_players, list):
            for item in state_or_players:
                add_name(item)

        if extracted:
            self.current_players = extracted
            logger.info(f"Identified match players ({len(extracted)}): {', '.join(extracted)} (Active Idx: {self.active_player_idx})")

    async def _parse_match_state(self, state: dict):
        # Check if match was aborted / cancelled / deleted / stopped
        status_val = str(state.get("status", "")).lower()
        is_match_aborted = (
            status_val in ["aborted", "abort", "cancelled", "canceled", "cancel", "deleted", "delete", "stopped"]
            or state.get("aborted") is True
            or state.get("isAborted") is True
            or state.get("cancelled") is True
            or state.get("canceled") is True
        )
        if is_match_aborted:
            logger.info(f"Match {self._active_match_id} state reported aborted/cancelled (status: {status_val}) -> emitting GAME_IDLE")
            self._active_match_id = None
            self._reset_match_state()
            self._in_leg_break = False
            self._last_flow_state = "idle"
            await self._emit_event(DartEvent(event_type=DartEventType.GAME_IDLE, board_id=self.board_id))
            return

        # Extract player names (including local players and guests)
        self._extract_and_set_players(state)

        turns = state.get("turns", [])

        # Check Turns & Throws
        if not isinstance(turns, list):
            turns = []

        # Determine composite turn key (handles empty turns at match/leg start as well as turn transitions)
        if turns:
            last_turn = turns[-1]
            raw_turn_id = str(last_turn.get("id") or f"turn_{len(turns)}")
            turn_key = f"{raw_turn_id}_p{self.active_player_idx}"
        else:
            turn_key = f"turn_0_p{self.active_player_idx}"

        # Detect Turn Change transition (including initial player at fresh match/leg start)
        if not self._last_match_finished and turn_key != self._last_turn_id:
            # Reset per-turn flags for the fresh turn
            self._last_180_fired = False
            self._last_bust_fired = False

            # When a new turn begins, clear any active leg break celebration
            self._in_leg_break = False

            player_name = self.current_players[self.active_player_idx] if self.active_player_idx < len(self.current_players) else None

            logger.info(f"Active player turn transition detected (turn_key='{turn_key}', player_idx={self.active_player_idx}, name='{player_name}') -> dispatching THROW")
            # Immediately dispatch THROW for the active player's turn color baseline
            await self._emit_event(DartEvent(
                event_type=DartEventType.THROW,
                player_name=player_name,
                player_index=self.active_player_idx,
                board_id=self.board_id
            ))

            self._last_turn_id = turn_key

        if turns:
            last_turn = turns[-1]
            turn_id = str(last_turn.get("id", f"turn_{len(turns)}"))
            throws = last_turn.get("throws", [])
            if throws:
                last_throw = throws[-1]
                throw_id = str(last_throw.get("id", f"{turn_id}_{len(throws)}"))
                if throw_id != self._last_throw_id:
                    self._last_throw_id = throw_id
                    self._in_leg_break = False
                    # Extract segment info
                    seg = last_throw.get("segment")
                    seg_name = ""
                    seg_number = None
                    seg_mult = None
                    seg_bed = ""

                    if isinstance(seg, dict):
                        seg_name = str(seg.get("name") or "").strip()
                        seg_number = seg.get("number")
                        seg_mult = seg.get("multiplier")
                        seg_bed = str(seg.get("bed") or "").strip().lower()
                    elif isinstance(seg, str):
                        seg_name = seg.strip()
                    elif isinstance(seg, (int, float)):
                        seg_number = int(seg)

                    # Extract raw throw score and multiplier
                    raw_score = last_throw.get("score")
                    raw_points = last_throw.get("points")
                    raw_mult = last_throw.get("multiplier")

                    # Compute score number (1..20, 25, 50, 0)
                    score = 0
                    if seg_number is not None and isinstance(seg_number, (int, float)):
                        score = int(seg_number)
                    elif raw_score is not None and isinstance(raw_score, (int, float)):
                        score = int(raw_score)
                    elif raw_points is not None and isinstance(raw_points, (int, float)):
                        score = int(raw_points)

                    # Compute multiplier (0, 1, 2, 3)
                    mult = 1
                    if seg_mult is not None and isinstance(seg_mult, (int, float)):
                        mult = int(seg_mult)
                    elif raw_mult is not None and isinstance(raw_mult, (int, float)):
                        mult = int(raw_mult)
                    elif seg_bed == "triple":
                        mult = 3
                    elif seg_bed == "double":
                        mult = 2
                    elif seg_bed == "single":
                        mult = 1
                    elif seg_bed in ["outside", "miss", "off"]:
                        mult = 0

                    # Parse segment name string if available (e.g. "T20", "D16", "S5", "Bull", "25", "Outside", "Miss")
                    u_name = seg_name.upper()
                    if u_name.startswith("T") and len(u_name) > 1 and u_name[1:].isdigit():
                        mult = 3
                        score = int(u_name[1:])
                    elif u_name.startswith("D") and len(u_name) > 1 and u_name[1:].isdigit():
                        mult = 2
                        score = int(u_name[1:])
                    elif u_name.startswith("S") and len(u_name) > 1 and u_name[1:].isdigit():
                        mult = 1
                        score = int(u_name[1:])
                    elif u_name in ["BULL", "DBULL", "DOUBLE BULL", "DOUBLE_BULL", "BULLSEYE", "50"]:
                        mult = 2
                        score = 25
                        seg_name = "Bull"
                    elif u_name in ["25", "SBULL", "SINGLE BULL", "SINGLE_BULL", "OUTER BULL"]:
                        mult = 1
                        score = 25
                        seg_name = "25"
                    elif u_name in ["MISS", "OUTSIDE", "OFF", "0", "NONE"]:
                        mult = 0
                        score = 0
                        if not seg_name:
                            seg_name = "Miss"

                    # Normalize seg_label notation
                    if seg_name:
                        seg_label = seg_name
                    elif score == 0 or mult == 0:
                        seg_label = "Miss"
                    elif score == 25 and mult == 2:
                        seg_label = "Bull"
                    elif score == 25 and mult == 1:
                        seg_label = "25"
                    elif mult == 3:
                        seg_label = f"T{score}"
                    elif mult == 2:
                        seg_label = f"D{score}"
                    elif mult == 1:
                        seg_label = f"S{score}"
                    else:
                        seg_label = str(score)

                    # 1. Check 180 (turn score == 180)
                    turn_points = last_turn.get("points", 0)
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
                        await self._emit_event(DartEvent(event_type=DartEventType.TRIPLE, score=score * 3, multiplier=3, segment_number=score, segment_name=seg_label, board_id=self.board_id))

                    # 5. Check Bullseye (50 points)
                    elif (mult == 2 and score == 25) or seg_label in ["Bull", "50"]:
                        logger.info(f"Bullseye hit detected on throw {throw_id}: Bull (50)")
                        await self._emit_event(DartEvent(event_type=DartEventType.BULLSEYE, score=50, multiplier=2, segment_number=25, segment_name=seg_label, board_id=self.board_id))

                    # 6. Check Double Hit (D1..D20)
                    elif mult == 2:
                        logger.info(f"Double hit detected on throw {throw_id}: {seg_label} (Multiplier: 2)")
                        await self._emit_event(DartEvent(event_type=DartEventType.DOUBLE, score=score * 2, multiplier=2, segment_number=score, segment_name=seg_label, board_id=self.board_id))

                    # 7. Check Single Hit (S1..S20, 25)
                    elif mult == 1:
                        logger.info(f"Single hit detected on throw {throw_id}: {seg_label} (Multiplier: 1)")
                        await self._emit_event(DartEvent(event_type=DartEventType.SINGLE, score=score, multiplier=1, segment_number=score, segment_name=seg_label, board_id=self.board_id))

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

        # Legs to win check (Only check leg counts <= 30, never point targets like 501)
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

        # Check if any player reached legs_to_win (must have won at least 1 leg)
        winning_player_idx = None
        if legs_to_win and player_leg_counts:
            for idx, p_l in enumerate(player_leg_counts):
                if p_l > 0 and p_l >= legs_to_win:
                    winning_player_idx = idx
                    break

        # Check Match Winner & Finished
        has_explicit_winner = False
        raw_winner = state.get("winner")
        if raw_winner is None and isinstance(state.get("match"), dict):
            raw_winner = state.get("match", {}).get("winner")

        if isinstance(raw_winner, int) and 0 <= raw_winner < len(self.current_players):
            has_explicit_winner = True
        elif isinstance(raw_winner, str) and raw_winner.strip() and raw_winner.strip().lower() not in ["-1", "none", "null", "false", ""]:
            has_explicit_winner = True
        elif isinstance(raw_winner, dict) and (raw_winner.get("name") or raw_winner.get("username") or raw_winner.get("displayName")):
            has_explicit_winner = True
        else:
            raw_winner = None

        is_match_finished = (
            state.get("finished") is True
            or state.get("isFinished") is True
            or str(state.get("status", "")).lower() in ["finished", "ended", "completed", "won"]
            or (isinstance(state.get("match"), dict) and state.get("match", {}).get("finished") is True)
            or (has_explicit_winner and state.get("finished") is not False)
            or (winning_player_idx is not None)
        )

        if is_match_finished and not self._last_match_finished:
            self._last_match_finished = True
            self._in_leg_break = True
            self._last_total_legs_won = total_legs
            if raw_winner is None and winning_player_idx is not None:
                raw_winner = winning_player_idx
            await self._emit_match_won(winner=raw_winner)

        # Detect Leg Win Transition ONLY for non-final intermediate legs
        elif has_leg_info and not self._last_match_finished:
            if self._last_total_legs_won is not None and total_legs > self._last_total_legs_won:
                self._last_total_legs_won = total_legs
                await self._emit_leg_won()
            elif self._last_total_legs_won is None:
                self._last_total_legs_won = total_legs

        # Check Turn Completion -> Transition to TAKEOUT (unless celebrating leg or match won)
        if turns and isinstance(turns, list) and not self._in_leg_break and not self._last_match_finished:
            last_turn = turns[-1]
            throws = last_turn.get("throws", [])
            is_turn_over = (len(throws) >= 3) or (last_turn.get("busted") is True or last_turn.get("bust") is True)
            if is_turn_over and self._last_flow_state != "takeout" and self._last_flow_state != "takeout_in_progress":
                self._last_flow_state = "takeout"
                p_name = self.current_players[self.active_player_idx] if self.active_player_idx < len(self.current_players) else None
                logger.info(f"Turn {self._last_turn_id} completed ({len(throws)} darts) -> transitioning to TAKEOUT")
                await self._emit_event(DartEvent(
                    event_type=DartEventType.TAKEOUT,
                    player_name=p_name,
                    player_index=self.active_player_idx,
                    board_id=self.board_id
                ))

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
        self.current_players = []
        self.active_player_idx = 0

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
