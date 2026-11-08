"""
AutoGlow 2 - Classic mode (AutoGlow 1)
The original AutoGlow: a simple USB-only status light. It listens to the local Autodarts Board Manager
API (ws://localhost:3180/api/events, with /api/state polled as a fallback) and sends one WLED JSON
command per board status over USB serial to an ESP32 running WLED.

It runs next to the main engine and is independent of it: no network controllers, no Chrome extension,
no Autodarts login. Settings live in classic.json next to config.json.
"""

import asyncio
import copy
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

import aiohttp

try:
    import serial  # pyserial
    import serial.tools.list_ports
except ImportError:  # pragma: no cover - depends on the install
    serial = None

logger = logging.getLogger("autoglow.classic")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SETTINGS_FILE = PROJECT_ROOT / "classic.json"

BAUD_RATE = 115200
# CP210x, CH340, FTDI and ESP32-S2/S3 native USB, as in AutoGlow 1
KNOWN_VID_PIDS = [(0x10C4, 0xEA60), (0x1A86, 0x7523), (0x0403, 0x6001), (0x303A, 0x1001)]
RETRY_SECONDS = 5
POLL_SECONDS = 1
# A state poll this recent counts as "connected", even while the event socket is down
POLL_FRESH_SECONDS = 5

# WLED effect ids offered by AutoGlow 1's settings window
EFFECTS = {
    "Solid": 0, "Blink": 1, "Breathe": 2, "Wipe": 3, "Scan": 45,
    "Rainbow": 9, "Chase": 28, "Fire": 66, "Strobe": 8,
    "Color Loop": 11, "Heartbeat": 101, "Pacifica": 104,
}

# The "traffic light": board status -> look. Order is the order the page shows them in.
DEFAULT_STATUSES: Dict[str, Dict[str, Any]] = {
    "Throw": {"enabled": True, "fx": 0, "color": [0, 255, 0]},
    "Takeout in progress": {"enabled": True, "fx": 0, "color": [255, 0, 0]},
    "Takeout": {"enabled": True, "fx": 0, "color": [255, 255, 0]},
    "Starting": {"enabled": True, "fx": 0, "color": [0, 0, 255]},
    "Stopped": {"enabled": True, "fx": 0, "color": [255, 0, 255]},
    "Calibrating": {"enabled": True, "fx": 0, "color": [128, 0, 128]},
    "Error": {"enabled": True, "fx": 1, "color": [255, 0, 0]},
}

DEFAULT_SETTINGS: Dict[str, Any] = {
    "enabled": False,
    "show_in_menu": False,  # Settings › Classic mode shows the menu item; hidden means switched off too
    "board_manager_url": "http://localhost:3180",
    "manual_port": "",
    "global_brightness": 255,
    "startup_animation": True,
    "statuses": DEFAULT_STATUSES,
}


# -----------------------------------------------------------------------------
# Settings
# -----------------------------------------------------------------------------
def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _clean_color(value: Any, default: List[int]) -> List[int]:
    if isinstance(value, str):
        text = value.strip().lstrip("#")
        if len(text) == 6:
            try:
                return [int(text[i:i + 2], 16) for i in (0, 2, 4)]
            except ValueError:
                return list(default)
        return list(default)
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return [_clamp_int(c, 0, 255, 0) for c in value[:3]]
    return list(default)


def clean_board_manager_url(value: Any) -> Optional[str]:
    """Return the Board Manager base URL (scheme://host[:port]) or None when it is not an http(s) URL."""
    text = str(value or "").strip().rstrip("/")
    if not text:
        return None
    if "://" not in text:
        text = "http://" + text
    parts = urlsplit(text)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    try:
        _ = parts.port  # raises on a bad port
    except ValueError:
        return None
    return f"{parts.scheme}://{parts.netloc}"


def clean_settings(raw: Any) -> Dict[str, Any]:
    """Fill in defaults and drop anything unexpected."""
    raw = raw if isinstance(raw, dict) else {}
    out = copy.deepcopy(DEFAULT_SETTINGS)
    out["show_in_menu"] = bool(raw.get("show_in_menu", out["show_in_menu"]))
    # Classic mode never runs while its page is hidden from the menu
    out["enabled"] = bool(raw.get("enabled", out["enabled"])) and out["show_in_menu"]
    out["board_manager_url"] = clean_board_manager_url(raw.get("board_manager_url")) or out["board_manager_url"]
    out["manual_port"] = str(raw.get("manual_port") or "").strip()[:200]
    out["global_brightness"] = _clamp_int(raw.get("global_brightness"), 0, 255, out["global_brightness"])
    out["startup_animation"] = bool(raw.get("startup_animation", out["startup_animation"]))
    statuses = raw.get("statuses") if isinstance(raw.get("statuses"), dict) else {}
    for name, default in DEFAULT_STATUSES.items():
        given = statuses.get(name) if isinstance(statuses.get(name), dict) else {}
        fx = _clamp_int(given.get("fx"), 0, 255, default["fx"])
        out["statuses"][name] = {
            "enabled": bool(given.get("enabled", default["enabled"])),
            "fx": fx if fx in EFFECTS.values() else default["fx"],
            "color": _clean_color(given.get("color"), default["color"]),
        }
    return out


def load_settings(path: Path = SETTINGS_FILE) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return clean_settings(json.load(f))
    except FileNotFoundError:
        return clean_settings({})
    except (OSError, ValueError) as e:
        logger.warning(f"Could not read {path.name}, using the defaults: {e}")
        return clean_settings({})


def save_settings(settings: Dict[str, Any], path: Path = SETTINGS_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".classic-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


# -----------------------------------------------------------------------------
# Status parsing (same rules as AutoGlow 1)
# -----------------------------------------------------------------------------
def _norm(name: Any) -> str:
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def resolve_status_key(status: Any) -> Optional[str]:
    """'takeout in progress', 'TakeoutInProgress' ... -> 'Takeout in progress'."""
    wanted = _norm(status)
    for key in DEFAULT_STATUSES:
        if _norm(key) == wanted:
            return key
    return None


def extract_status(data: Any) -> Optional[str]:
    """The board status of a Board Manager event or state, old or new format."""
    if not isinstance(data, dict):
        return None
    inner = data.get("data")
    if isinstance(inner, dict) and inner.get("status"):
        return str(inner["status"])
    if data.get("status"):
        return str(data["status"])
    return None


def wled_command(settings: Dict[str, Any], key: str) -> Dict[str, Any]:
    look = settings["statuses"][key]
    return {"on": True, "bri": settings["global_brightness"], "tt": 0,
            "seg": {"fx": look["fx"], "col": [look["color"]]}}


# -----------------------------------------------------------------------------
# Serial
# -----------------------------------------------------------------------------
def list_ports() -> List[Dict[str, Any]]:
    if serial is None:
        return []
    out = []
    for port in serial.tools.list_ports.comports():
        out.append({
            "device": port.device,
            "description": port.description or "",
            "esp32": (port.vid, port.pid) in KNOWN_VID_PIDS,
        })
    return out


def find_port(manual_port: str = "") -> Optional[str]:
    if manual_port:
        return manual_port
    for port in list_ports():
        if port["esp32"]:
            return port["device"]
    return None


# -----------------------------------------------------------------------------
# Service
# -----------------------------------------------------------------------------
class ClassicService:
    """Board Manager -> USB serial, the AutoGlow 1 loop as a background task of the server."""

    def __init__(self, settings_path: Path = SETTINGS_FILE):
        self.settings_path = settings_path
        self.settings = load_settings(settings_path)
        self._task: Optional[asyncio.Task] = None
        self._ser = None
        self._lock = asyncio.Lock()
        self.port: Optional[str] = None
        self.serial_error: Optional[str] = None
        self._ws_connected = False
        self._poll_ok_at: Optional[float] = None
        self.board_manager_error: Optional[str] = None
        self.last_status: Optional[str] = None
        self.last_status_at: Optional[float] = None
        self._sent_key: Optional[str] = None

    # --- lifecycle -----------------------------------------------------------
    @property
    def running(self) -> bool:
        return bool(self._task and not self._task.done())

    async def start(self) -> None:
        if self.running or not self.settings["enabled"]:
            return
        self._task = asyncio.create_task(self._run(), name="autoglow-classic")
        logger.info("Classic mode (AutoGlow 1) started")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            logger.info("Classic mode (AutoGlow 1) stopped")
        await self._close_serial()
        self._ws_connected = False
        self._poll_ok_at = None

    async def apply(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """Save new settings and restart the loop so they take effect."""
        cleaned = clean_settings(settings)
        await asyncio.to_thread(save_settings, cleaned, self.settings_path)
        reconnect = (cleaned["enabled"] != self.settings["enabled"]
                     or cleaned["manual_port"] != self.settings["manual_port"]
                     or cleaned["board_manager_url"] != self.settings["board_manager_url"])
        self.settings = cleaned
        self._sent_key = None  # the current status shows its new look at once
        if reconnect or not cleaned["enabled"]:
            await self.stop()
            await self.start()
        elif self.last_status:
            await self._show(self.last_status)
        return cleaned

    @property
    def board_manager_connected(self) -> bool:
        fresh = self._poll_ok_at is not None and time.time() - self._poll_ok_at < POLL_FRESH_SECONDS
        return self._ws_connected or fresh

    async def check_board_manager(self) -> None:
        """While the loop is off, look once whether the Board Manager answers, so the page shows the truth."""
        if self.running:
            return
        url = self.settings["board_manager_url"] + "/api/state"
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=1.5)) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"HTTP {resp.status}")
                    status = extract_status(await resp.json(content_type=None))
        except Exception as e:
            self._poll_ok_at = None
            self.board_manager_error = f"Board Manager not reachable at {self.settings['board_manager_url']}"
            logger.debug(f"Classic mode: Board Manager check failed: {e}")
            return
        self._poll_ok_at, self.board_manager_error = time.time(), None
        key = resolve_status_key(status) if status else None
        if key and key != self.last_status:
            self.last_status, self.last_status_at = key, time.time()

    def snapshot(self) -> Dict[str, Any]:
        return {
            "running": self.running,
            "pyserial": serial is not None,
            "serial_connected": bool(self._ser and self._ser.is_open),
            "port": self.port,
            "serial_error": self.serial_error,
            "board_manager_connected": self.board_manager_connected,
            "board_manager_error": self.board_manager_error,
            "last_status": self.last_status,
            "last_status_at": self.last_status_at,
        }

    # --- serial --------------------------------------------------------------
    async def _open_serial(self) -> bool:
        if self._ser and self._ser.is_open:
            return True
        if serial is None:
            self.serial_error = "pyserial is not installed. Run setup again to install it."
            return False
        port = find_port(self.settings["manual_port"])
        if not port:
            self.serial_error = "No ESP32 found on USB. Plug it in or enter its port."
            return False
        try:
            ser = await asyncio.to_thread(serial.Serial, port, BAUD_RATE, timeout=1, write_timeout=2)
        except Exception as e:
            self.port = port
            self.serial_error = f"Could not open {port}: {e}"
            return False
        await asyncio.sleep(2)  # the ESP32 resets when the port opens
        self._ser, self.port, self.serial_error = ser, port, None
        logger.info(f"Classic mode: serial connection on {port}")
        return True

    async def _close_serial(self) -> None:
        ser, self._ser = self._ser, None
        if ser:
            try:
                await asyncio.to_thread(ser.close)
            except Exception:
                pass

    async def send(self, command: Dict[str, Any]) -> bool:
        async with self._lock:
            ser = self._ser
            if not (ser and ser.is_open):
                return False
            try:
                await asyncio.to_thread(ser.write, (json.dumps(command) + "\n").encode())
                return True
            except Exception as e:
                logger.warning(f"Classic mode: serial write failed: {e}")
                self.serial_error = f"Lost the connection to {self.port}: {e}"
                await self._close_serial()
                return False

    async def test(self, key: str, look: Optional[Dict[str, Any]] = None,
                   brightness: Optional[int] = None) -> bool:
        """Show one status's look now, optionally an unsaved one from the page."""
        settings = copy.deepcopy(self.settings)
        if look is not None:
            settings["statuses"][key] = clean_settings({"statuses": {key: look}})["statuses"][key]
        if brightness is not None:
            settings["global_brightness"] = _clamp_int(brightness, 0, 255, settings["global_brightness"])
        if not (self._ser and self._ser.is_open) and not self.running:
            await self._open_serial()
        ok = await self.send(wled_command(settings, key))
        self._sent_key = None  # the next real status is sent again
        return ok

    # --- status --------------------------------------------------------------
    async def handle_status(self, status: Any) -> None:
        key = resolve_status_key(status)
        if not key:
            logger.debug(f"Classic mode: unknown status {status!r}")
            return
        if key != self.last_status:
            self.last_status, self.last_status_at = key, time.time()
            logger.info(f"Classic mode: status {key}")
        await self._show(key)

    async def _show(self, key: str) -> None:
        look = self.settings["statuses"].get(key)
        if not look or not look["enabled"] or key == self._sent_key:
            return
        if await self.send(wled_command(self.settings, key)):
            self._sent_key = key

    # --- loops ---------------------------------------------------------------
    async def _run(self) -> None:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=3)) as session:
            tasks = [asyncio.create_task(self._serial_loop()),
                     asyncio.create_task(self._events_loop(session)),
                     asyncio.create_task(self._poll_loop(session))]
            try:
                await asyncio.gather(*tasks)
            finally:
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _serial_loop(self) -> None:
        while True:
            if not (self._ser and self._ser.is_open):
                if await self._open_serial():
                    self._sent_key = None
                    if self.settings["startup_animation"]:
                        await self.send({"on": True, "bri": self.settings["global_brightness"],
                                         "seg": {"fx": 9, "sx": 128, "ix": 128}})
                        await asyncio.sleep(3)
                    await self._show(self.last_status or "Throw")
            await asyncio.sleep(RETRY_SECONDS)

    async def _events_loop(self, session: aiohttp.ClientSession) -> None:
        base = self.settings["board_manager_url"]
        url = base.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/api/events"
        while True:
            try:
                async with session.ws_connect(url, heartbeat=30) as ws:
                    self._ws_connected, self.board_manager_error = True, None
                    logger.info(f"Classic mode: connected to the Board Manager at {url}")
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                break
                            continue
                        try:
                            data = json.loads(msg.data)
                        except ValueError:
                            continue
                        status = extract_status(data)
                        if status:
                            await self.handle_status(status)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.board_manager_error = f"Board Manager not reachable at {base}: {e or type(e).__name__}"
                logger.debug(f"Classic mode: event stream failed: {e}")
            self._ws_connected = False
            await asyncio.sleep(RETRY_SECONDS)

    async def _poll_loop(self, session: aiohttp.ClientSession) -> None:
        """Newer Board Manager versions do not always push status changes, so poll the state too."""
        url = self.settings["board_manager_url"] + "/api/state"
        while True:
            try:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=2)) as resp:
                    if resp.status == 200:
                        self._poll_ok_at = time.time()
                        status = extract_status(await resp.json(content_type=None))
                        if status:
                            await self.handle_status(status)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.debug(f"Classic mode: state poll failed: {e}")
            await asyncio.sleep(POLL_SECONDS)
