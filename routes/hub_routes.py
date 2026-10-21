"""
AutoGlow 2 - Operational Hub Routes Module
Handler for /api/hub/status: one aggregated snapshot of engine, Autodarts and controller health.
"""

import asyncio
import time
import logging
from aiohttp import web
from typing import Any, Dict, Optional

from core.models import ProtocolMode
from core.autodarts_bridge import AutodartsBridgeClient
from core.version import __version__
from core.wled_driver import WLEDDriver
from core.storage import load_app_config

logger = logging.getLogger("autoglow.routes.hub")

def _seconds_until(limit_minutes: int, enabled: bool, idle_seconds: float) -> Optional[int]:
    if not enabled:
        return None
    return max(0, int(limit_minutes * 60 - idle_seconds))


def _engine_snapshot(engine, cfg) -> Dict[str, Any]:
    if not engine:
        return {"running": False}
    streaming = any(d.protocol_mode == ProtocolMode.ACTIVE_UDP for d in engine.drivers.values())
    if engine.is_board_off:
        power_state = "off"
    elif engine.is_board_dimmed:
        power_state = "dimmed"
    else:
        power_state = "on"
    idle_seconds = max(0.0, time.time() - engine.last_activity_time)
    return {
        "running": bool(getattr(engine, "_running", False)),
        "lighting_mode": cfg.lighting_mode.value if hasattr(cfg.lighting_mode, "value") else str(cfg.lighting_mode),
        "protocol_mode": "udp" if streaming else "http",
        "power_state": power_state,
        "illumination": engine.current_illumination,
        "idle_seconds": int(idle_seconds),
        "dim_in_seconds": None if engine.is_board_dimmed else _seconds_until(cfg.inactivity_timeout_minutes, cfg.inactivity_timeout_enabled, idle_seconds),
        "off_in_seconds": None if engine.is_board_off else _seconds_until(cfg.idle_power_off_minutes, cfg.idle_power_off_enabled, idle_seconds),
        "last_event": engine.last_event_name,
        "previous_event": engine.previous_event_name,
        "flow_phase": engine.flow_active_phase,
    }


def _autodarts_snapshot(engine) -> Dict[str, Any]:
    client = getattr(engine, "autodarts", None) if engine else None
    if not client:
        return {"configured": False, "connected": False}
    match_id = getattr(client, "_active_match_id", None)
    is_bridge = isinstance(client, AutodartsBridgeClient)
    return {
        "configured": True,
        "source": "extension" if is_bridge else "cloud",
        "connected": bool(client.is_connected),
        "tab_attached": client.tab_attached if is_bridge else None,
        "account": client.user_name or client.username or client.email or "",
        "match_active": match_id is not None,
        "match_id": match_id or "",
        "players": list(client.current_players or []),
        "active_player_idx": client.active_player_idx,
    }


async def _device_snapshot(dev, engine) -> Dict[str, Any]:
    drv = engine.drivers.get(dev.ip.strip()) if (engine and dev.ip) else None
    streaming = bool(drv and drv.protocol_mode == ProtocolMode.ACTIVE_UDP)
    out: Dict[str, Any] = {
        "name": dev.name,
        "ip": dev.ip,
        "enabled": dev.enabled,
        "protocol_mode": "udp" if streaming else "http",
        "configured_segments": len(dev.segments),
    }
    if not dev.enabled or not dev.ip:
        out.update({"online": None, "warnings": []})
        return out
    if streaming:
        # Protocol exclusivity (ADR-001): no HTTP polling while the UDP stream owns the controller
        out.update({"online": None, "streaming": True, "warnings": []})
        return out
    loop = asyncio.get_running_loop()
    health = await loop.run_in_executor(None, WLEDDriver.fetch_device_health, dev.ip)
    out.update(health)
    return out


async def handle_hub_status(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    cfg = request.app.get("current_app_config") or load_app_config(request.app.get("config_path", "config.json"))

    devices = await asyncio.gather(*[_device_snapshot(d, engine) for d in cfg.devices])

    return web.json_response({
        "status": "ok",
        "version": __version__,
        "engine": _engine_snapshot(engine, cfg),
        "autodarts": _autodarts_snapshot(engine),
        "devices": list(devices),
    })
