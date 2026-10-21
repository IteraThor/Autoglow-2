"""
AutoGlow 2 - Access Control & Secret Handling
Keeps credentials out of API responses, guards state-changing requests against
cross-site use, and enforces the optional LAN access PIN.
"""

import hashlib
import hmac
import logging
import secrets
import time
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from aiohttp import web

from core.models import AppConfig

logger = logging.getLogger("autoglow.security")

# Keys that must never leave the server. Extras are flattened into the top level by
# AppConfig.to_dict(), so one list covers both dataclass fields and extra entries.
SECRET_KEYS = (
    "autodarts_password",
    "autodarts_access_token",
    "autodarts_refresh_token",
    "ai_key",
    "gemini_api_key",
    "access_pin_hash",
    "autodarts_bridge_key",
)

PIN_HASH_KEY = "access_pin_hash"
SESSION_COOKIE = "autoglow_session"
SESSION_MAX_AGE = 30 * 24 * 3600
PIN_ITERATIONS = 200_000
PIN_MIN_LENGTH = 4
PIN_MAX_LENGTH = 32

LOGIN_MAX_FAILURES = 5
LOGIN_LOCKOUT_SECONDS = 30

# Reachable without a session so the browser can load the UI and show the PIN prompt
PUBLIC_API_PATHS = {"/api/auth/status", "/api/auth/login"}

# The Chrome extension relays Autodarts game data here. It cannot hold a PIN session, so it is
# authorised separately: local connections are trusted, others must present the pairing key.
BRIDGE_WS_PATH = "/ws/autodarts-bridge"
BRIDGE_KEY_SETTING = "autodarts_bridge_key"

_login_failures: Dict[str, list] = {}


# -----------------------------------------------------------------------------
# Secret redaction
# -----------------------------------------------------------------------------
def redact_config_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of a serialized config with every secret blanked out."""
    out = dict(data)
    for key in SECRET_KEYS:
        if key in out:
            out[key] = ""
    return out


def restore_redacted_secrets(new_cfg: AppConfig, old_cfg: Optional[AppConfig]) -> None:
    """
    The browser only ever sees blank secrets, so a blank secret in a saved config means
    "unchanged". Copy the stored value back for each one the client left empty.
    """
    if not old_cfg:
        return
    if not new_cfg.autodarts_password and old_cfg.autodarts_password:
        new_cfg.autodarts_password = old_cfg.autodarts_password
    if not new_cfg.ai_key and old_cfg.ai_key:
        new_cfg.ai_key = old_cfg.ai_key
    for key in SECRET_KEYS:
        if old_cfg.extra.get(key) and not new_cfg.extra.get(key):
            new_cfg.extra[key] = old_cfg.extra[key]


# -----------------------------------------------------------------------------
# PIN hashing & sessions
# -----------------------------------------------------------------------------
def hash_pin(pin: str, salt: Optional[str] = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt), PIN_ITERATIONS)
    return f"pbkdf2_sha256${PIN_ITERATIONS}${salt}${digest.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        algo, iterations, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, AttributeError):
        return False


def validate_new_pin(pin: str) -> Optional[str]:
    """Return an error message if the PIN is not acceptable, else None."""
    if not pin.isdigit():
        return "PIN must contain digits only."
    if not (PIN_MIN_LENGTH <= len(pin) <= PIN_MAX_LENGTH):
        return f"PIN must be {PIN_MIN_LENGTH}-{PIN_MAX_LENGTH} digits long."
    return None


def get_pin_hash(cfg: Optional[AppConfig]) -> str:
    return str(cfg.extra.get(PIN_HASH_KEY, "") or "") if cfg else ""


def _sign(pin_hash: str, issued_at: str) -> str:
    # Keyed on the PIN hash, so changing or removing the PIN invalidates every session
    return hmac.new(pin_hash.encode("utf-8"), f"autoglow-session:{issued_at}".encode("utf-8"), hashlib.sha256).hexdigest()


def create_session_token(pin_hash: str) -> str:
    issued_at = str(int(time.time()))
    return f"{issued_at}.{_sign(pin_hash, issued_at)}"


def is_valid_session(token: Optional[str], pin_hash: str) -> bool:
    if not token or not pin_hash or "." not in token:
        return False
    issued_at, signature = token.split(".", 1)
    try:
        if time.time() - int(issued_at) > SESSION_MAX_AGE:
            return False
    except ValueError:
        return False
    return hmac.compare_digest(signature, _sign(pin_hash, issued_at))


def is_authenticated(request: web.Request) -> bool:
    pin_hash = get_pin_hash(request.app.get("current_app_config"))
    if not pin_hash:
        return True
    return is_valid_session(request.cookies.get(SESSION_COOKIE), pin_hash)


def set_session_cookie(response: web.StreamResponse, pin_hash: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        create_session_token(pin_hash),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="Strict",
        path="/",
    )


# -----------------------------------------------------------------------------
# Login rate limiting
# -----------------------------------------------------------------------------
def login_lockout_remaining(client_ip: str) -> int:
    """Seconds until this client may try again (0 if not locked out)."""
    now = time.time()
    recent = [t for t in _login_failures.get(client_ip, []) if now - t < LOGIN_LOCKOUT_SECONDS]
    _login_failures[client_ip] = recent
    if len(recent) >= LOGIN_MAX_FAILURES:
        return int(LOGIN_LOCKOUT_SECONDS - (now - recent[0])) + 1
    return 0


def record_login_failure(client_ip: str) -> None:
    _login_failures.setdefault(client_ip, []).append(time.time())


def clear_login_failures(client_ip: str) -> None:
    _login_failures.pop(client_ip, None)


# -----------------------------------------------------------------------------
# Middleware
# -----------------------------------------------------------------------------
def _is_cross_origin(request: web.Request) -> bool:
    origin = request.headers.get("Origin")
    if origin is None:
        return False  # Non-browser clients (curl, scripts) send no Origin
    if origin == "null":
        return True  # Sandboxed iframes / file:// pages
    return urlsplit(origin).netloc.lower() != (request.host or "").lower()


def _is_loopback(remote: Optional[str]) -> bool:
    if not remote:
        return False
    return remote == "::1" or remote.startswith("127.") or remote.startswith("::ffff:127.")


def bridge_rejection_reason(request: web.Request) -> Optional[str]:
    """Return why an extension bridge connection is refused, or None if it is allowed."""
    origin = request.headers.get("Origin")
    # Web pages must never reach the bridge; only the extension (or a non-browser test client) may
    if origin is not None and not origin.startswith("chrome-extension://"):
        return "Only the AutoGlow Chrome extension may connect to the bridge"
    if _is_loopback(request.remote):
        return None
    cfg = request.app.get("current_app_config")
    expected = str(cfg.extra.get(BRIDGE_KEY_SETTING, "") or "") if cfg else ""
    supplied = request.query.get("key", "")
    if expected and supplied and hmac.compare_digest(supplied, expected):
        return None
    return "Pairing key required for connections from another computer"


@web.middleware
async def security_middleware(request: web.Request, handler):
    path = request.path

    if path == BRIDGE_WS_PATH:
        reason = bridge_rejection_reason(request)
        if reason:
            logger.warning(f"Rejected extension bridge connection from {request.remote}: {reason}")
            return web.json_response({"status": "error", "message": reason}, status=403)
        return await handler(request)
    is_api = path.startswith("/api/") or path.startswith("/ws/")

    # Block cross-site requests that change state or open live sockets (drive-by CSRF from other web pages)
    if is_api and (request.method not in ("GET", "HEAD", "OPTIONS") or path.startswith("/ws/")):
        if _is_cross_origin(request):
            logger.warning(f"Rejected cross-origin {request.method} {path} from Origin {request.headers.get('Origin')}")
            return web.json_response({"status": "error", "message": "Cross-origin request rejected"}, status=403)

    if is_api and path not in PUBLIC_API_PATHS and not is_authenticated(request):
        return web.json_response({"status": "error", "message": "Access PIN required", "auth_required": True}, status=401)

    return await handler(request)
