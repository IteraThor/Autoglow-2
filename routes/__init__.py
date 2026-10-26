"""
AutoGlow 2 - Routes Registry
Aggregates and registers all REST API and WebSocket route handlers.
"""

import os
from aiohttp import web

from routes.config_routes import (
    handle_get_config, handle_post_config, handle_reset_config
)
from routes.profile_routes import (
    handle_get_presets, handle_select_preset, handle_save_preset,
    handle_rename_preset, handle_delete_preset, handle_export_preset,
    handle_import_preset
)
from routes.wled_routes import (
    handle_ping_device, handle_wled_update, handle_get_wled_preset,
    handle_save_wled_preset, handle_get_wled_effects, handle_preview_wled_state,
    handle_wled_setup_preview, handle_scan_network, handle_test_effect, handle_test_light, handle_test_end,
    handle_get_protocol_mode, handle_post_protocol_mode
)
from routes.autodarts_routes import (
    handle_autodarts_login, handle_get_autodarts_boards,
    handle_get_autodarts_status, handle_autodarts_logout,
    handle_autodarts_device_code, handle_autodarts_device_poll,
    handle_ws_autodarts_bridge, handle_get_autodarts_bridge
)
from core.security import BRIDGE_WS_PATH
from routes.power_routes import (
    handle_test_inactivity_dim, handle_test_power_off, handle_test_wake
)
from routes.telemetry_routes import handle_ws_telemetry
from routes.simulator_routes import (
    handle_ws_simulator, handle_simulator_status, handle_simulator_dest,
    handle_simulator_test_effect, handle_simulator_cable_offset
)
from routes.flow_routes import register_flow_routes
from routes.hub_routes import handle_hub_status, handle_status, handle_setup_checklist
from routes.extension_routes import (
    UPDATE_XML_PATH, CRX_PATH, handle_extension_update_xml, handle_extension_crx
)
from routes.auth_routes import (
    handle_auth_status, handle_auth_login, handle_auth_logout, handle_set_pin
)


# Every page of the single-page app. The first group is canonical; the rest are older links
# that web/js/core/router.js redirects to their canonical page.
SPA_PATHS = [
    "/", "/hub", "/setup", "/setup/controllers", "/setup/connection",
    "/lighting", "/lighting/matrix", "/lighting/flow", "/power", "/settings",
    "/index.html", "/home", "/dashboard", "/devices", "/wled-devices", "/autodarts", "/autodarts-account",
    "/matrix", "/event-matrix", "/simulator", "/led-simulator", "/power-timers", "/idle", "/idle-mode",
    "/updates", "/updates-backups", "/backups",
]


def register_routes(app: web.Application, web_dir: str):
    """Register all SPA, REST API, and WebSocket endpoints."""
    async def handle_index(request: web.Request) -> web.FileResponse:
        return web.FileResponse(
            os.path.join(web_dir, "index.html"),
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
        )

    # SPA Navigation Routes & Aliases
    for path in SPA_PATHS:
        app.router.add_get(path, handle_index)
    # One controller's page; the IP's dots must not be taken for a file extension
    app.router.add_get("/setup/controllers/{ip}", handle_index)

    # Access PIN Routes
    app.router.add_get("/api/auth/status", handle_auth_status)
    app.router.add_post("/api/auth/login", handle_auth_login)
    app.router.add_post("/api/auth/logout", handle_auth_logout)
    app.router.add_post("/api/auth/pin", handle_set_pin)

    # Operational Hub
    app.router.add_get("/api/hub/status", handle_hub_status)
    app.router.add_get("/api/status", handle_status)
    app.router.add_get("/api/setup/checklist", handle_setup_checklist)

    # Config Routes
    app.router.add_get("/api/config", handle_get_config)
    app.router.add_post("/api/config", handle_post_config)
    app.router.add_post("/api/config/reset", handle_reset_config)

    # Event Matrix Presets & Profile Routes
    app.router.add_get("/api/matrix/presets", handle_get_presets)
    app.router.add_post("/api/matrix/presets/select", handle_select_preset)
    app.router.add_post("/api/matrix/presets/save", handle_save_preset)
    app.router.add_post("/api/matrix/presets/rename", handle_rename_preset)
    app.router.add_delete("/api/matrix/presets", handle_delete_preset)
    app.router.add_get("/api/matrix/presets/export", handle_export_preset)
    app.router.add_post("/api/matrix/presets/import", handle_import_preset)

    # WLED & Hardware Routes
    app.router.add_get("/api/ping", handle_ping_device)
    app.router.add_post("/api/wled/update", handle_wled_update)
    app.router.add_get("/api/wled/preset", handle_get_wled_preset)
    app.router.add_post("/api/wled/preset", handle_save_wled_preset)
    app.router.add_get("/api/wled/effects", handle_get_wled_effects)
    app.router.add_post("/api/wled/preview", handle_preview_wled_state)
    app.router.add_post("/api/wled/setup-preview", handle_wled_setup_preview)
    app.router.add_get("/api/scan/network", handle_scan_network)
    app.router.add_get("/api/protocol/mode", handle_get_protocol_mode)
    app.router.add_post("/api/protocol/mode", handle_post_protocol_mode)
    app.router.add_post("/api/test/effect", handle_test_effect)
    app.router.add_post("/api/test/light", handle_test_light)
    app.router.add_post("/api/test/end", handle_test_end)

    # Power & Standby Simulation Routes
    app.router.add_post("/api/power/test_dim", handle_test_inactivity_dim)
    app.router.add_post("/api/power/test_off", handle_test_power_off)
    app.router.add_post("/api/power/test_wake", handle_test_wake)

    # Autodarts Routes
    app.router.add_post("/api/autodarts/login", handle_autodarts_login)
    app.router.add_post("/api/autodarts/logout", handle_autodarts_logout)
    app.router.add_get("/api/autodarts/boards", handle_get_autodarts_boards)
    app.router.add_get("/api/autodarts/status", handle_get_autodarts_status)
    app.router.add_post("/api/autodarts/device/code", handle_autodarts_device_code)
    app.router.add_post("/api/autodarts/device/poll", handle_autodarts_device_poll)
    app.router.add_get("/api/autodarts/bridge", handle_get_autodarts_bridge)
    app.router.add_get(BRIDGE_WS_PATH, handle_ws_autodarts_bridge)

    # Chrome extension auto-install (ExtensionInstallForcelist policy)
    app.router.add_get(UPDATE_XML_PATH, handle_extension_update_xml)
    app.router.add_get(CRX_PATH, handle_extension_crx)

    # Live WebSocket Telemetry
    app.router.add_get("/ws/telemetry", handle_ws_telemetry)

    # Simulator Endpoints
    app.router.add_get("/api/simulator/status", handle_simulator_status)
    app.router.add_post("/api/simulator/dest", handle_simulator_dest)
    app.router.add_post("/api/simulator/cable_offset", handle_simulator_cable_offset)
    app.router.add_post("/api/simulator/test_effect", handle_simulator_test_effect)
    app.router.add_get("/ws/simulator", handle_ws_simulator)

    # Game Flow Simulator & Visual Planner Routes
    register_flow_routes(app)

    # Static Assets Directory
    app.router.add_static("/", web_dir)
