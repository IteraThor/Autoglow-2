"""
AutoGlow 2 - WebSocket Live Telemetry Routes Module
Handles high-frequency browser telemetry stream connections.
"""

import json
import logging
from aiohttp import web
from typing import Set

logger = logging.getLogger("autoglow.routes.telemetry")

active_ws_clients: Set[web.WebSocketResponse] = set()


async def handle_ws_telemetry(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    active_ws_clients.add(ws)
    logger.debug(f"WebSocket client connected ({len(active_ws_clients)} total)")

    # Send initial protocol state to newly connected client
    engine = request.app.get("engine")
    if engine and hasattr(engine, "driver"):
        mode = engine.driver.protocol_mode.value if hasattr(engine.driver, "protocol_mode") else "http"
        try:
            await ws.send_str(json.dumps({"type": "protocol_state", "mode": mode}))
        except Exception:
            pass

    try:
        async for msg in ws:
            pass
    finally:
        active_ws_clients.discard(ws)
        logger.debug(f"WebSocket client disconnected ({len(active_ws_clients)} total)")

    return ws


async def broadcast_telemetry(data: dict):
    if not active_ws_clients:
        return
    text = json.dumps(data)
    for ws in list(active_ws_clients):
        try:
            await ws.send_str(text)
        except Exception:
            pass
