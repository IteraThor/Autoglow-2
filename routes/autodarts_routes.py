"""
AutoGlow 2 - Autodarts Cloud Integration Routes Module
Handlers for Autodarts OAuth authentication, boards querying, live telemetry status,
and the Chrome extension bridge that replaces the cloud login while it is on hold.
"""

import os
import json
import time
import logging
import aiohttp
from aiohttp import web, WSMsgType

from core.autodarts_client import AutodartsClient
from core.autodarts_bridge import (
    AutodartsBridgeClient, CLOUD_API_ON_HOLD, CLOUD_API_HOLD_MESSAGE
)
from core.security import BRIDGE_WS_PATH
from core.storage import load_app_config, save_app_config
from core.version import __version__

logger = logging.getLogger("autoglow.routes.autodarts")

AUTODARTS_AUTH_URL = "https://api.autodarts.com/auth/v1"
DEVICE_CLIENT_ID = "darts-caller"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 AutoGlow/2.0"
EXTENSION_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "chrome_extension")


def _cloud_on_hold_response() -> web.Response:
    return web.json_response({"status": "error", "on_hold": True, "message": CLOUD_API_HOLD_MESSAGE}, status=503)


async def handle_autodarts_device_code(request: web.Request) -> web.Response:
    """Request a new OAuth2 Device Code and User Code from Autodarts Auth API."""
    if CLOUD_API_ON_HOLD:
        return _cloud_on_hold_response()
    url = f"{AUTODARTS_AUTH_URL}/device/code"
    payload = {"client_id": DEVICE_CLIENT_ID}
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return web.json_response({"status": "ok", **data})
                err_text = await resp.text()
                return web.json_response({"status": "error", "message": f"Autodarts Auth error ({resp.status}): {err_text}"}, status=400)
    except Exception as e:
        logger.exception("Error requesting device code")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


def _create_token_refresh_callback(app: web.Application, config_path: str):
    async def _on_token_refreshed(acc_tok: str, ref_tok: str, exp_at: float):
        cfg = app.get("current_app_config") or load_app_config(config_path)
        cfg.extra["autodarts_access_token"] = acc_tok
        if ref_tok:
            cfg.extra["autodarts_refresh_token"] = ref_tok
        cfg.extra["autodarts_token_expires_at"] = exp_at
        if not save_app_config(cfg, config_path):
            logger.error(f"Failed to persist refreshed OAuth tokens to {config_path}")
        else:
            app["current_app_config"] = cfg
            logger.info("Persisted refreshed Autodarts OAuth tokens to storage.")
    return _on_token_refreshed


async def handle_autodarts_device_poll(request: web.Request) -> web.Response:
    """Poll Autodarts Auth API for user confirmation of device code."""
    if CLOUD_API_ON_HOLD:
        return _cloud_on_hold_response()
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    
    data = await request.json()
    device_code = data.get("device_code", "")
    if not device_code:
        return web.json_response({"status": "error", "message": "Missing device_code"}, status=400)

    url = f"{AUTODARTS_AUTH_URL}/device/token"
    payload = {
        "client_id": DEVICE_CLIENT_ID,
        "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
    }
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                res_data = await resp.json()
                if resp.status == 200:
                    access_token = res_data.get("access_token")
                    refresh_token = res_data.get("refresh_token")
                    expires_in = res_data.get("expires_in", 900)

                    token_cb = _create_token_refresh_callback(request.app, config_path)
                    if not engine.autodarts:
                        engine.autodarts = AutodartsClient(on_event=engine.process_event, on_token_refreshed=token_cb)
                    else:
                        engine.autodarts.on_token_refreshed = token_cb
                    
                    engine.autodarts.access_token = access_token
                    engine.autodarts.refresh_token = refresh_token
                    engine.autodarts.token_expires_at = time.time() + expires_in

                    u_info = await engine.autodarts.fetch_user_profile()
                    boards = await engine.autodarts.fetch_boards()
                    board_id = boards[0].get("id") if boards else None

                    # Persist tokens in config
                    cfg = load_app_config(config_path)
                    account_name = engine.autodarts.username or engine.autodarts.user_name or (u_info.get("email", "").split("@")[0] if u_info.get("email") else "")
                    cfg.extra["autodarts_access_token"] = access_token
                    cfg.extra["autodarts_refresh_token"] = refresh_token
                    cfg.extra["autodarts_token_expires_at"] = engine.autodarts.token_expires_at
                    cfg.extra["autodarts_client_id"] = DEVICE_CLIENT_ID
                    cfg.extra["autodarts_username"] = account_name
                    cfg.extra["autodarts_name"] = account_name
                    if u_info.get("email"):
                        cfg.extra["autodarts_email"] = u_info.get("email")
                        cfg.autodarts_user = u_info.get("email")
                    if board_id:
                        cfg.autodarts_board_id = board_id
                        cfg.extra["autodarts_board_id"] = board_id

                    # Auto pre-fill player 1 if not customized
                    if account_name and cfg.profile and cfg.profile.player_slots:
                        if not cfg.profile.player_slots[0].name_filter:
                            cfg.profile.player_slots[0].name_filter = account_name

                    if not save_app_config(cfg, config_path):
                        logger.error(f"Failed to persist device token to {config_path}")
                        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)
                    request.app["current_app_config"] = cfg
                    await engine.autodarts.start()

                    return web.json_response({
                        "status": "ok",
                        "authenticated": True,
                        "token": access_token,
                        "user": u_info,
                        "boards": boards
                    })
                
                # Check for pending status
                err = res_data.get("error", "")
                if err == "authorization_pending":
                    return web.json_response({"status": "pending", "message": "Waiting for approval"})
                elif err == "slow_down":
                    return web.json_response({"status": "slow_down", "message": "Polling too quickly"})
                elif err == "expired_token":
                    return web.json_response({"status": "expired", "message": "Code has expired"})
                else:
                    return web.json_response({"status": "error", "error": err, "message": res_data.get("error_description", err)}, status=400)
    except Exception as e:
        logger.exception("Error polling device token")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_autodarts_login(request: web.Request) -> web.Response:
    if CLOUD_API_ON_HOLD:
        return _cloud_on_hold_response()
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    if not engine:
        return web.json_response({"status": "error", "message": "Engine not initialized"}, status=500)

    data = await request.json()
    email = data.get("email", "")
    password = data.get("password", "")

    token_cb = _create_token_refresh_callback(request.app, config_path)
    if not engine.autodarts:
        engine.autodarts = AutodartsClient(email=email, password=password, on_event=engine.process_event, on_token_refreshed=token_cb)
    else:
        engine.autodarts.email = email
        engine.autodarts.password = password
        engine.autodarts.on_token_refreshed = token_cb

    token = await engine.autodarts._get_valid_token()
    if not token:
        return web.json_response({"status": "error", "message": "Invalid email or password."}, status=400)

    await engine.autodarts.fetch_user_profile()
    boards = await engine.autodarts.fetch_boards()
    board_id = boards[0].get("id") if boards else None

    # Persist credentials in config
    cfg = load_app_config(config_path)
    cfg.autodarts_user = email
    cfg.autodarts_password = password
    cfg.extra["autodarts_email"] = email
    cfg.extra["autodarts_name"] = engine.autodarts.username or engine.autodarts.user_name
    cfg.extra["autodarts_username"] = engine.autodarts.username
    cfg.extra["autodarts_password"] = password
    cfg.extra["autodarts_access_token"] = engine.autodarts.access_token
    cfg.extra["autodarts_refresh_token"] = engine.autodarts.refresh_token
    cfg.extra["autodarts_token_expires_at"] = engine.autodarts.token_expires_at
    if board_id:
        cfg.autodarts_board_id = board_id
        cfg.extra["autodarts_board_id"] = board_id

    # Auto pre-fill player 1 if not yet customized
    account_name = engine.autodarts.username or engine.autodarts.user_name or (email.split("@")[0] if email else "")
    if account_name and cfg.profile and cfg.profile.player_slots:
        if not cfg.profile.player_slots[0].name_filter:
            cfg.profile.player_slots[0].name_filter = account_name

    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist login credentials to {config_path}")
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)
    request.app["current_app_config"] = cfg
    await engine.autodarts.start()

    return web.json_response({"status": "ok", "token": token, "boards": boards})


async def handle_get_autodarts_boards(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    client = engine.autodarts if engine else None
    if isinstance(client, AutodartsBridgeClient):
        cfg = request.app.get("current_app_config") or load_app_config(config_path)
        return web.json_response({
            "status": "ok",
            "source": "extension",
            "authenticated": client.is_connected,
            "email": "",
            "selected_board_id": cfg.autodarts_board_id or cfg.extra.get("autodarts_board_id", ""),
            "boards": await client.fetch_boards()
        })
    if not engine or not client or not client.access_token:
        return web.json_response({"status": "ok", "authenticated": False, "boards": []})

    try:
        boards = await client.fetch_boards()
        cfg = request.app.get("current_app_config") or load_app_config(config_path)
        return web.json_response({
            "status": "ok",
            "authenticated": True,
            "email": getattr(client, "email", "") or getattr(client, "username", ""),
            "selected_board_id": cfg.autodarts_board_id or cfg.extra.get("autodarts_board_id", ""),
            "boards": boards
        })
    except Exception as e:
        logger.exception("Error fetching Autodarts boards")
        return web.json_response({"status": "error", "message": str(e)}, status=400)


async def handle_get_autodarts_status(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    client = engine.autodarts if engine else None
    cfg = request.app.get("current_app_config") or load_app_config(config_path)

    if isinstance(client, AutodartsBridgeClient):
        return web.json_response(_bridge_status_payload(engine, client, cfg))

    is_auth = bool(client and client.access_token)
    boards = []

    if client and is_auth:
        if not getattr(client, "username", ""):
            await client.fetch_user_profile()
        boards = await client.fetch_boards()

    # Discover active match
    active_m_id = None
    if client:
        active_m_id = getattr(client, "_active_match_id", None)
        if not active_m_id:
            for b in boards:
                if b.get("matchId"):
                    active_m_id = b.get("matchId")
                    client._active_match_id = active_m_id
                    break

        if active_m_id and not client.current_players:
            await client.fetch_match_details(active_m_id)

    now = time.time()
    token_expires_in = max(0, int(client.token_expires_at - now)) if (client and client.token_expires_at) else 0

    account_email = (client.email if (client and client.email) else cfg.autodarts_user or cfg.extra.get("autodarts_email", "")) or (getattr(client, "username", "") if client else "") or ("Connected (Device Link)" if is_auth else "Not Connected")
    account_username = (getattr(client, "username", "") if client else cfg.extra.get("autodarts_username", "")) or (getattr(client, "user_name", "") if client else cfg.extra.get("autodarts_name", "")) or (account_email.split("@")[0] if "@" in account_email else account_email)
    account_name = account_username

    return web.json_response({
        "status": "ok",
        "source": "cloud",
        "account": {
            "email": account_email,
            "name": account_name,
            "username": account_username,
            "authenticated": is_auth,
            "client_id": "autodarts-play",
            "auth_endpoint": "https://api.autodarts.com/auth/v1",
            "token_expires_in": token_expires_in,
            "has_access_token": bool(client and client.access_token),
            "has_refresh_token": bool(cfg.extra.get("autodarts_refresh_token") or (client and client.refresh_token))
        },
        "connection": {
            "ws_connected": bool(client and client.is_connected),
            "ws_gateway": "play.ws.autodarts.com",
            "ws_endpoint": "wss://play.ws.autodarts.com/ms/v0/subscribe",
            "running": bool(client and client._running),
            "board_id": (client.board_id if client else None) or cfg.autodarts_board_id or cfg.extra.get("autodarts_board_id", "All Boards"),
            "subscribed_topics": [f"autodarts.boards.{b.get('id')}.*" for b in boards if b.get("id")]
        },
        "board": {
            "boards_count": len(boards),
            "boards": boards
        },
        "match": {
            "active_match_id": active_m_id,
            "in_game": bool(any(b.get("matchId") for b in boards)),
            "players": getattr(client, "current_players", []) if client else [],
            "active_player_idx": getattr(client, "active_player_idx", 0) if client else 0,
            "last_throw_id": getattr(client, "_last_throw_id", None) if client else None,
            "last_event": getattr(engine, "last_event_name", "Standby") if engine else "Standby",
            "previous_event": getattr(engine, "previous_event_name", "—") if engine else "—"
        }
    })


async def handle_autodarts_logout(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    if engine and engine.autodarts and not isinstance(engine.autodarts, AutodartsBridgeClient):
        await engine.autodarts.stop()
        engine.autodarts = None

    cfg = load_app_config(config_path)
    cfg.autodarts_user = ""
    cfg.autodarts_password = ""
    cfg.autodarts_board_id = ""
    cfg.extra["autodarts_email"] = ""
    cfg.extra["autodarts_password"] = ""
    cfg.extra["autodarts_access_token"] = ""
    cfg.extra["autodarts_refresh_token"] = ""
    cfg.extra["autodarts_board_id"] = ""
    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist logout changes to {config_path}")
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)
    request.app["current_app_config"] = cfg
    logger.info("Autodarts credentials cleared and user logged out.")
    return web.json_response({"status": "ok", "message": "Logged out."})


# -----------------------------------------------------------------------------
# Chrome extension bridge
# -----------------------------------------------------------------------------
def _bridge_status_payload(engine, client: AutodartsBridgeClient, cfg) -> dict:
    """Status in the same shape as the cloud variant so the hub, power and matrix pages keep working."""
    boards = client._boards_cache
    active_m_id = client._active_match_id
    return {
        "status": "ok",
        "source": "extension",
        "bridge": client.snapshot(),
        "account": {
            "email": "",
            "name": "",
            "username": "",
            "authenticated": client.is_connected,
            "has_access_token": False,
            "has_refresh_token": False
        },
        "connection": {
            "ws_connected": client.is_connected,
            "ws_gateway": "AutoGlow Chrome extension",
            "ws_endpoint": BRIDGE_WS_PATH,
            "running": client._running,
            "board_id": client.board_id or cfg.autodarts_board_id or cfg.extra.get("autodarts_board_id", "All Boards"),
            "subscribed_topics": []
        },
        "board": {
            "boards_count": len(boards),
            "boards": boards
        },
        "match": {
            "active_match_id": active_m_id,
            "in_game": active_m_id is not None,
            "players": client.current_players,
            "active_player_idx": client.active_player_idx,
            "last_throw_id": client._last_throw_id,
            "last_event": getattr(engine, "last_event_name", "Standby") if engine else "Standby",
            "previous_event": getattr(engine, "previous_event_name", "—") if engine else "—"
        }
    }


async def handle_ws_autodarts_bridge(request: web.Request) -> web.StreamResponse:
    """WebSocket the Chrome extension pushes Autodarts game data into (access checked by security_middleware)."""
    engine = request.app.get("engine")
    client = engine.autodarts if engine else None
    if not isinstance(client, AutodartsBridgeClient):
        return web.json_response({"status": "error", "message": "Extension bridge is not active"}, status=409)

    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    client.attach(ws)
    try:
        await ws.send_json({"type": "welcome", "server": "AutoGlow", "version": __version__, "primary": client.is_primary(ws)})
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                reply = await client.ingest(ws, json.loads(msg.data))
            except Exception:
                logger.exception("Error processing message from Chrome extension")
                continue
            if reply:
                await ws.send_json(reply)
    finally:
        client.detach(ws)
    return ws


async def handle_get_autodarts_bridge(request: web.Request) -> web.Response:
    """Extension folder and live status for the setup panel."""
    engine = request.app.get("engine")
    client = engine.autodarts if engine else None
    return web.json_response({
        "status": "ok",
        "cloud_on_hold": CLOUD_API_ON_HOLD,
        "active": isinstance(client, AutodartsBridgeClient),
        "extension_dir": EXTENSION_DIR,
        "ws_path": BRIDGE_WS_PATH,
        "bridge": client.snapshot() if isinstance(client, AutodartsBridgeClient) else None
    })
