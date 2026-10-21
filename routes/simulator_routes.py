"""
AutoGlow 2 - Simulator Routes Module
WebSocket and REST API endpoints for real-time digital LED strip simulation.
"""

import json
import logging
from aiohttp import web
from typing import Set

from core.simulator import get_simulator_server
from core.models import EffectConfig, RGBColor, ProtocolMode

logger = logging.getLogger("autoglow.routes.simulator")

active_simulator_ws_clients: Set[web.WebSocketResponse] = set()
_simulator_stream_dest: str = "both"  # "simulator", "hardware", "both"


def get_stream_dest() -> str:
    return _simulator_stream_dest


def set_stream_dest(dest: str) -> None:
    global _simulator_stream_dest
    if dest in ("simulator", "hardware", "both"):
        _simulator_stream_dest = dest


async def broadcast_simulator_frame(pixel_bytes: bytes, status: dict):
    """Broadcast a new pixel frame to all connected browser simulator WebSockets."""
    if not active_simulator_ws_clients:
        return

    sim = get_simulator_server()
    # The dartboard simulator is strictly for the WS281x addressable LED ring (45 LEDs).
    # Any trailing PWM spotlight channels (e.g. index 45) must not be rendered on the ring.
    total_leds = len(pixel_bytes) // 3
    ws_count = sim.ws_led_count if (sim.ws_led_count and sim.ws_led_count > 0) else 45
    num_ws_leds = min(total_leds, ws_count) if total_leds > 0 else ws_count

    # Build compact pixel array [ [r, g, b], ... ] for WS281x LEDs only
    pixels_nested = []
    for i in range(num_ws_leds):
        offset = i * 3
        pixels_nested.append([pixel_bytes[offset], pixel_bytes[offset + 1], pixel_bytes[offset + 2]])

    msg = json.dumps({
        "type": "frame",
        "led_count": num_ws_leds,
        "pwm": status.get("pwm_value", 0),
        "age_ms": status.get("last_packet_age_ms"),
        "pixels": pixels_nested
    })

    for ws in list(active_simulator_ws_clients):
        try:
            await ws.send_str(msg)
        except Exception:
            pass


async def handle_ws_simulator(request: web.Request) -> web.WebSocketResponse:
    """WebSocket endpoint for the browser simulator."""
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    active_simulator_ws_clients.add(ws)
    logger.debug(f"Simulator WebSocket client connected ({len(active_simulator_ws_clients)} total)")

    sim = get_simulator_server()
    total_leds = len(sim.latest_pixels) // 3
    ws_count = sim.ws_led_count if (sim.ws_led_count and sim.ws_led_count > 0) else 45
    num_ws_leds = min(total_leds, ws_count) if total_leds > 0 else ws_count

    init_pixels = []
    for i in range(num_ws_leds):
        off = i * 3
        init_pixels.append([sim.latest_pixels[off], sim.latest_pixels[off + 1], sim.latest_pixels[off + 2]])

    # Send initial state
    try:
        await ws.send_str(json.dumps({
            "type": "init",
            "simulator": sim.get_status(),
            "dest": _simulator_stream_dest,
            "pixels": init_pixels
        }))
    except Exception:
        pass

    try:
        async for msg in ws:
            # Handle incoming WebSocket commands if any
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                    action = data.get("action")
                    if action == "ping":
                        await ws.send_str(json.dumps({"type": "pong"}))
                except Exception:
                    pass
    finally:
        active_simulator_ws_clients.discard(ws)
        logger.debug(f"Simulator WebSocket client disconnected ({len(active_simulator_ws_clients)} total)")

    return ws


async def handle_simulator_status(request: web.Request) -> web.Response:
    """Get current simulator state, port, and metrics."""
    sim = get_simulator_server()
    return web.json_response({
        "status": "ok",
        "simulator": sim.get_status(),
        "active_clients": len(active_simulator_ws_clients),
        "dest": _simulator_stream_dest
    })


async def handle_simulator_dest(request: web.Request) -> web.Response:
    """Configure stream destination: 'simulator', 'hardware', or 'both'."""
    data = await request.json()
    dest = str(data.get("dest", "both")).lower()
    set_stream_dest(dest)
    return web.json_response({"status": "ok", "dest": _simulator_stream_dest})


async def handle_simulator_test_effect(request: web.Request) -> web.Response:
    """Trigger an effect directly on the simulator / engine."""
    engine = request.app.get("engine")
    if not engine:
        return web.json_response({"status": "error", "message": "Engine not initialized"}, status=500)

    data = await request.json()
    evt_data = data.get("effect", {})

    effect = EffectConfig.from_dict(evt_data)
    if not evt_data.get("color_primary") and not evt_data.get("color"):
        effect.color_primary = RGBColor(0, 240, 255)
    effect.enabled = True

    segment_id = data.get("segment_id", 0)

    # Ensure UDP mode is active
    if engine.driver.protocol_mode != ProtocolMode.ACTIVE_UDP:
        await engine.set_protocol_mode(ProtocolMode.ACTIVE_UDP)

    # Play effect on primary driver (which taps into simulator and broadcasts over UDP)
    await engine.driver.play_effect(effect, segment_id=segment_id, force_enable=True)
    return web.json_response({"status": "ok", "effect": effect.to_dict()})


async def handle_simulator_cable_offset(request: web.Request) -> web.Response:
    """Configure the physical cable entry rotation (0..360 degrees) or discrete offset."""
    data = await request.json()
    sim = get_simulator_server()

    if "rotation" in data or "degrees" in data:
        deg = int(data.get("rotation", data.get("degrees", 0)))
        sim.set_led_rotation(deg)
    else:
        offset = int(data.get("offset", 0))
        sim.set_led0_offset(offset)

    engine = request.app.get("engine")
    if engine and hasattr(engine, "app_config"):
        for dev in engine.app_config.devices:
            dev.led_rotation = sim.led_rotation
            dev.led0_offset = sim.led0_offset
        from core.storage import save_app_config
        save_app_config(engine.app_config)

    return web.json_response({
        "status": "ok",
        "led_rotation": sim.led_rotation,
        "led0_offset": sim.led0_offset
    })

