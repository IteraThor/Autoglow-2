"""
AutoGlow 2 - Access PIN Routes Module
Handlers for /api/auth/status, /api/auth/login, /api/auth/logout, /api/auth/pin.
"""

import logging
from aiohttp import web

from core.storage import load_app_config, save_app_config
from core.security import (
    PIN_HASH_KEY, SESSION_COOKIE, get_pin_hash, hash_pin, verify_pin, validate_new_pin,
    is_authenticated, set_session_cookie, login_lockout_remaining, record_login_failure,
    clear_login_failures
)

logger = logging.getLogger("autoglow.routes.auth")


def _client_ip(request: web.Request) -> str:
    return request.remote or "unknown"


async def handle_auth_status(request: web.Request) -> web.Response:
    pin_hash = get_pin_hash(request.app.get("current_app_config"))
    return web.json_response({
        "status": "ok",
        "pin_enabled": bool(pin_hash),
        "authenticated": is_authenticated(request)
    })


async def handle_auth_login(request: web.Request) -> web.Response:
    pin_hash = get_pin_hash(request.app.get("current_app_config"))
    if not pin_hash:
        return web.json_response({"status": "ok", "pin_enabled": False})

    client_ip = _client_ip(request)
    wait = login_lockout_remaining(client_ip)
    if wait:
        return web.json_response({"status": "error", "message": f"Too many attempts. Try again in {wait}s."}, status=429)

    try:
        data = await request.json()
    except Exception:
        data = {}
    pin = str(data.get("pin", "")).strip() if isinstance(data, dict) else ""

    if not verify_pin(pin, pin_hash):
        record_login_failure(client_ip)
        logger.warning(f"Failed access PIN attempt from {client_ip}")
        return web.json_response({"status": "error", "message": "Incorrect PIN."}, status=401)

    clear_login_failures(client_ip)
    resp = web.json_response({"status": "ok", "authenticated": True})
    set_session_cookie(resp, pin_hash)
    return resp


async def handle_auth_logout(request: web.Request) -> web.Response:
    resp = web.json_response({"status": "ok"})
    resp.del_cookie(SESSION_COOKIE, path="/")
    return resp


async def handle_set_pin(request: web.Request) -> web.Response:
    """Set, change or remove the access PIN. An empty new_pin removes protection."""
    config_path = request.app.get("config_path", "config.json")
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}

    current_hash = get_pin_hash(cfg)
    current_pin = str(data.get("current_pin", "")).strip()
    new_pin = str(data.get("new_pin", "")).strip()

    # Re-confirm the existing PIN even with a valid session, so an unattended browser can't lock the owner out
    if current_hash and not verify_pin(current_pin, current_hash):
        return web.json_response({"status": "error", "message": "Current PIN is incorrect."}, status=403)

    if new_pin:
        err = validate_new_pin(new_pin)
        if err:
            return web.json_response({"status": "error", "message": err}, status=400)
        new_hash = hash_pin(new_pin)
        cfg.extra[PIN_HASH_KEY] = new_hash
    else:
        new_hash = ""
        cfg.extra.pop(PIN_HASH_KEY, None)

    if not save_app_config(cfg, config_path):
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)
    request.app["current_app_config"] = cfg

    resp = web.json_response({"status": "ok", "pin_enabled": bool(new_hash)})
    if new_hash:
        # Keep the browser that set the PIN signed in
        set_session_cookie(resp, new_hash)
        logger.info("Access PIN enabled/changed.")
    else:
        resp.del_cookie(SESSION_COOKIE, path="/")
        logger.info("Access PIN removed; API is open on the local network.")
    return resp
