"""
AutoGlow 2 - Power & Hardware Standby Routes Module
Handlers for testing inactivity dimming, standby auto-off, and wake-up.
"""

import json
import asyncio
import logging
import urllib.request
from aiohttp import web
from typing import Dict, Any

from core.models import ProtocolMode
from core.storage import load_app_config

logger = logging.getLogger("autoglow.routes.power")


def _sync_set_wled_power(ip: str, turn_on: bool) -> Dict[str, Any]:
    """
    Mutate physical WLED device power state with Stage 1 Readback verification.
    """
    if not ip:
        return {"ip": ip, "success": False, "error": "No IP"}

    url = f"http://{ip}/json/state"
    if turn_on:
        payload = {
            "on": True,
            "lor": 0,
            "ps": 1,
            "tt": 0,
            "v": True
        }
    else:
        payload = {
            "on": False,
            "lor": 0,
            "tt": 0,
            "v": True
        }

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            resp_data = json.loads(resp.read().decode())

        # Stage 1 Readback Verification (Iron Rule)
        readback_on = resp_data.get("on")
        if readback_on is None:
            with urllib.request.urlopen(url, timeout=1.5) as r_resp:
                rb_data = json.loads(r_resp.read().decode())
                readback_on = rb_data.get("on")

        is_success = (readback_on == turn_on)
        return {
            "ip": ip,
            "success": is_success,
            "on": readback_on,
            "expected": turn_on
        }
    except Exception as e:
        logger.exception(f"Error setting power on {ip}")
        return {"ip": ip, "success": False, "error": str(e)}


def _resolve_power_ips(request: web.Request, engine) -> list:
    """All enabled controller IPs from the live in-memory config (falls back to disk)."""
    cfg = request.app.get("current_app_config") or load_app_config(request.app.get("config_path", "config.json"))
    return cfg.active_ips or list(engine.drivers.keys())


async def handle_test_inactivity_dim(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if engine:
        dim_bri = engine.app_config.idle_dimming_brightness if engine.app_config else 50
        engine.is_board_dimmed = True
        engine.current_illumination = dim_bri
        was_udp = any(drv.protocol_mode == ProtocolMode.ACTIVE_UDP for drv in engine.drivers.values())
        verified = True
        for drv in engine.drivers.values():
            verified = await drv.transition_to_http_mode(restore_preset_id=1) and verified
            verified = await drv.set_board_light(dim_bri) and verified
        if was_udp:
            await engine._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
        await engine._broadcast_telemetry({"type": "power_state", "state": "dimmed"})
        if verified:
            return web.json_response({"status": "ok", "verified": True, "message": "Inactivity dimming executed (Idle Preset 1 restored)."})
        return web.json_response({"status": "warning", "verified": False, "message": "Dimming sent, but not every controller confirmed the new state."})
    return web.json_response({"status": "error", "message": "Engine is not initialized."}, status=500)


async def handle_test_power_off(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if not engine:
        return web.json_response({"status": "error", "message": "Engine is not initialized."}, status=500)

    engine.is_board_off = True
    engine.is_board_dimmed = True
    engine.current_illumination = 0
    was_udp = any(drv.protocol_mode == ProtocolMode.ACTIVE_UDP for drv in engine.drivers.values())
    for drv in engine.drivers.values():
        if drv.protocol_mode == ProtocolMode.ACTIVE_UDP:
            await drv.transition_to_http_mode()
        await drv.set_board_light(0)
    if was_udp:
        await engine._broadcast_telemetry({"type": "protocol_state", "mode": "http"})

    ips = _resolve_power_ips(request, engine)

    loop = asyncio.get_running_loop()
    results = []
    for ip in ips:
        res = await loop.run_in_executor(None, _sync_set_wled_power, ip, False)
        results.append(res)

    all_ok = all(r.get("success", False) for r in results) if results else True
    await engine._broadcast_telemetry({"type": "power_state", "state": "off"})

    if all_ok:
        return web.json_response({
            "status": "ok",
            "message": "Standby Auto-Off verified on physical hardware (All lights turned off).",
            "verified": True,
            "results": results
        })
    else:
        return web.json_response({
            "status": "warning",
            "message": "Auto-Off payload sent, but some devices did not confirm power off.",
            "verified": False,
            "results": results
        })


async def handle_test_wake(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if not engine:
        return web.json_response({"status": "error", "message": "Engine is not initialized."}, status=500)

    ips = _resolve_power_ips(request, engine)

    loop = asyncio.get_running_loop()
    results = []
    for ip in ips:
        res = await loop.run_in_executor(None, _sync_set_wled_power, ip, True)
        results.append(res)

    await engine.wake_up()

    all_ok = all(r.get("success", False) for r in results) if results else True
    if all_ok:
        return web.json_response({
            "status": "ok",
            "message": "Power restored & verified on physical hardware (Active Spotlight).",
            "verified": True,
            "results": results
        })
    else:
        return web.json_response({
            "status": "warning",
            "message": "Turn-on payload sent, but some devices did not confirm power on.",
            "verified": False,
            "results": results
        })
