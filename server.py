"""
AutoGlow 2 - Web Server & Main Orchestrator
Modularized modern web server with mDNS discovery, REST API, and WebSocket streaming.
"""

import os
import sys
import secrets
import socket
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from typing import Optional
from aiohttp import web

from core.models import AppConfig, DeviceConfig
from core.storage import load_app_config, save_app_config, resolve_config_path
from core.engine import AutoGlowEngine
from core.autodarts_client import AutodartsClient
from core.autodarts_bridge import AutodartsBridgeClient, CLOUD_API_ON_HOLD
from routes import register_routes
from routes.telemetry_routes import broadcast_telemetry
from core.security import security_middleware
from core.errors import AppError, error_body

try:
    from zeroconf import Zeroconf, ServiceInfo
except ImportError:
    Zeroconf = None
    ServiceInfo = None

# Configure Root Logger with Console and Rotating File Handler (5 MB max, 3 backups)
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "autoglow.log")
root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)

log_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Console Handler
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setFormatter(log_formatter)

# Rotating File Handler
file_handler = RotatingFileHandler(
    LOG_FILE,
    maxBytes=5 * 1024 * 1024,
    backupCount=3,
    encoding="utf-8"
)
file_handler.setFormatter(log_formatter)

# Set handlers on root logger (avoiding duplicates if reloaded)
root_logger.handlers.clear()
root_logger.addHandler(console_handler)
root_logger.addHandler(file_handler)

logger = logging.getLogger("autoglow.server")


def _asyncio_loop_exception_handler(loop: asyncio.AbstractEventLoop, context: dict):
    """Global handler for unhandled exceptions in background asyncio tasks."""
    msg = context.get("message", "Unhandled exception in asyncio background task")
    exception = context.get("exception")
    if exception:
        logger.exception(f"Asyncio loop exception: {msg}", exc_info=exception)
    else:
        logger.error(f"Asyncio loop error: {msg} | Context: {context}")

# Server Configuration
PORT = int(os.environ.get("AUTOGLOW_PORT", 8080))
CONFIG_PATH = resolve_config_path(os.environ.get("AUTOGLOW_CONFIG"))
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# Global In-Memory Singletons (for inspection / tests)
engine: Optional[AutoGlowEngine] = None
current_app_config: Optional[AppConfig] = None
zc_instance: Optional[Zeroconf] = None
zc_service_info: Optional[ServiceInfo] = None


def _sync_register_mdns():
    """Register AutoGlow mDNS Zeroconf service on the local network."""
    global zc_instance, zc_service_info
    if not (Zeroconf and ServiceInfo):
        return
    try:
        local_ips = []
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ips.append(s.getsockname()[0])
            s.close()
        except Exception:
            local_ips.append("127.0.0.1")

        zc_instance = Zeroconf()
        zc_service_info = ServiceInfo(
            "_http._tcp.local.",
            "AutoGlow._http._tcp.local.",
            addresses=[socket.inet_aton(ip) for ip in local_ips],
            port=PORT,
            server="autoglow.local.",
            properties={b"path": b"/"}
        )
        zc_instance.register_service(zc_service_info)
        logger.info(f"Registered mDNS: http://autoglow.local:{PORT} on {', '.join(local_ips)}")
    except Exception as e:
        logger.warning(f"Failed to register mDNS service: {e}")


async def _async_sync_hardware_on_boot(app: web.Application):
    """Query live WLED controllers on startup and sync true hardware segments/outputs."""
    global current_app_config
    cfg: Optional[AppConfig] = app.get("current_app_config")
    engine_inst: Optional[AutoGlowEngine] = app.get("engine")
    if not cfg:
        return

    from core.wled_driver import WLEDDriver
    from core.models import SegmentConfig
    from core.storage import save_app_config

    changed = False
    for dev in cfg.devices:
        if not dev.ip or not dev.ip.strip():
            continue
        try:
            info = await asyncio.to_thread(WLEDDriver.fetch_live_device_info, dev.ip.strip())
            if info.get("online") and info.get("segments"):
                live_segs = [
                    SegmentConfig(
                        id=s["id"],
                        name=s.get("name", f"Segment {s['id']}"),
                        type=s.get("type", "WS281x"),
                        gpio=s.get("gpio", ""),
                        start=s.get("start", 0),
                        length=s.get("len", s.get("stop", 0) - s.get("start", 0)),
                        role="white_illumination" if "pwm" in str(s.get("type", "")).lower() or "pwm" in str(s.get("name", "")).lower() else "dartboard_ring"
                    )
                    for s in info["segments"]
                ]
                live_hw = info.get("hw_ins", [])
                if dev.segments != live_segs or dev.hw_ins != live_hw:
                    dev.segments = live_segs
                    dev.hw_ins = live_hw
                    if info.get("name"):
                        dev.name = info.get("name")
                    changed = True
        except Exception as e:
            logger.warning(f"Hardware sync check failed for {dev.ip}: {e}")

    if changed:
        config_path = app.get("config_path", CONFIG_PATH)
        save_app_config(cfg, config_path)
        if engine_inst:
            engine_inst.sync_drivers(cfg)
        sim_inst = app.get("simulator")
        if sim_inst and cfg.primary_device:
            sim_inst.ws_led_count = cfg.primary_device.rgb_count or 45
            sim_inst.pwm_index = cfg.primary_device.pwm_index
        logger.info("Synchronized device configuration with live physical WLED hardware on boot.")


async def on_startup(app: web.Application):
    """Initialize AutoGlow engine, Autodarts client, and mDNS on server boot."""
    global engine, current_app_config
    cfg = load_app_config(CONFIG_PATH)
    from core.storage import sync_presets_with_disk
    if sync_presets_with_disk(cfg):
        save_app_config(cfg, CONFIG_PATH)
    current_app_config = cfg
    app["config_path"] = CONFIG_PATH
    app["current_app_config"] = cfg

    autodarts_client = None
    email = cfg.autodarts_user or cfg.extra.get("autodarts_email", "")
    password = cfg.autodarts_password or cfg.extra.get("autodarts_password", "")
    board_id = cfg.autodarts_board_id or cfg.extra.get("autodarts_board_id", "")
    access_token = cfg.extra.get("autodarts_access_token")
    refresh_token = cfg.extra.get("autodarts_refresh_token")
    token_expires_at = float(cfg.extra.get("autodarts_token_expires_at", 0))

    async def _on_token_refreshed(acc_tok: str, ref_tok: str, exp_at: float):
        from core.storage import load_app_config as _load_cfg, save_app_config as _save_cfg
        cfg_curr = app.get("current_app_config") or _load_cfg(CONFIG_PATH)
        cfg_curr.extra["autodarts_access_token"] = acc_tok
        if ref_tok:
            cfg_curr.extra["autodarts_refresh_token"] = ref_tok
        cfg_curr.extra["autodarts_token_expires_at"] = exp_at
        _save_cfg(cfg_curr, app.get("config_path", CONFIG_PATH))
        app["current_app_config"] = cfg_curr
        logger.info("Persisted refreshed Autodarts OAuth tokens to storage.")

    if CLOUD_API_ON_HOLD:
        # Game data comes from the AutoGlow Chrome extension; stored cloud credentials are kept but unused
        # Earlier builds stored a pairing key for extensions on other computers; the bridge is local-only now
        if cfg.extra.pop("autodarts_bridge_key", None):
            save_app_config(cfg, CONFIG_PATH)
        autodarts_client = AutodartsBridgeClient(board_id=board_id)
        logger.info("Autodarts source: Chrome extension bridge (direct cloud login on hold)")
    elif (email and password) or refresh_token or access_token:
        autodarts_client = AutodartsClient(
            email=email,
            password=password,
            board_id=board_id,
            on_token_refreshed=_on_token_refreshed
        )
        autodarts_client.access_token = access_token
        autodarts_client.refresh_token = refresh_token
        autodarts_client.token_expires_at = token_expires_at

    primary = cfg.primary_device or DeviceConfig(ip="")
    engine = AutoGlowEngine(primary, cfg.profile, autodarts_client, app_config=cfg)
    app["engine"] = engine
    engine.subscribe_telemetry(broadcast_telemetry)

    # Initialize Virtual WLED Simulator UDP Receiver & WebSocket broadcaster
    from core.simulator import get_simulator_server
    from routes.simulator_routes import broadcast_simulator_frame
    sim = get_simulator_server()
    if primary:
        sim.ws_led_count = primary.rgb_count or 45
        sim.pwm_index = primary.pwm_index
    await sim.start()
    app["simulator"] = sim
    sim.subscribe(lambda px, st: asyncio.create_task(broadcast_simulator_frame(px, st)))
    engine.set_frame_tap_callback(sim.tap_frame)

    await engine.start()

    # Sync live hardware segments and outputs from online controllers
    asyncio.create_task(_async_sync_hardware_on_boot(app))

    # Register mDNS service asynchronously in background thread
    if Zeroconf and ServiceInfo:
        asyncio.create_task(asyncio.to_thread(_sync_register_mdns))


async def on_cleanup(app: web.Application):
    """Graceful cleanup on shutdown."""
    global engine, zc_instance, zc_service_info
    if engine:
        await engine.stop()
    sim = app.get("simulator")
    if sim:
        await sim.stop()
    if zc_instance and zc_service_info:
        try:
            zc_instance.unregister_service(zc_service_info)
            zc_instance.close()
            logger.info("Unregistered mDNS service.")
        except Exception as e:
            logger.warning(f"Error unregistering mDNS service during shutdown: {e}")


@web.middleware
async def global_error_middleware(request: web.Request, handler):
    """Turn every API failure into the standard error body (core/errors.py) and never leak exception text."""
    is_api = request.path.startswith("/api/")

    def as_api_error(resp: web.StreamResponse) -> Optional[web.Response]:
        # Unknown /api paths and wrong methods answer in JSON like every other API error
        if not is_api or resp.status < 400 or resp.content_type == "application/json":
            return None
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(resp.status, "HTTP_ERROR")
        return web.json_response(error_body(code, resp.reason), status=resp.status)

    # An /api path that only the static file route matched is an unknown endpoint, not a file
    route = request.match_info.route
    if is_api and isinstance(getattr(route, "resource", None), web.StaticResource):
        return web.json_response(error_body("NOT_FOUND", "Unknown API endpoint"), status=404)

    try:
        resp = await handler(request)
        return as_api_error(resp) or resp
    except AppError:
        raise
    except web.HTTPException as ex:
        converted = as_api_error(ex)
        if converted:
            return converted
        raise
    except Exception:
        request_id = secrets.token_hex(4)
        logger.exception(f"Unhandled exception [{request_id}] processing {request.method} {request.path}")
        return web.json_response(
            error_body("INTERNAL", f"Internal server error (ref {request_id}). Details are in autoglow.log.",
                       details={"request_id": request_id}),
            status=500
        )


def create_app() -> web.Application:
    """Factory creating and configuring the aiohttp Application."""
    app = web.Application(
        client_max_size=300 * 1024 * 1024,
        middlewares=[global_error_middleware, security_middleware]
    )
    app["config_path"] = CONFIG_PATH
    # Set to request a clean process restart
    app["restart_event"] = asyncio.Event()
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    register_routes(app, WEB_DIR)
    return app


async def run_server() -> bool:
    """Asynchronous server lifecycle manager. Returns True if a restart was requested."""
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(_asyncio_loop_exception_handler)

    app = create_app()
    runner = web.AppRunner(app, access_log=logger)
    await runner.setup()
    site = web.TCPSite(runner, host="0.0.0.0", port=PORT)
    await site.start()
    logger.info(f"AutoGlow 2 Web Server running at http://localhost:{PORT}")
    try:
        await app["restart_event"].wait()
        logger.info("Restart requested: shutting down cleanly before relaunch...")
        return True
    except (asyncio.CancelledError, KeyboardInterrupt):
        return False
    finally:
        await runner.cleanup()


def main():
    """Server entry point."""
    from core.legacy_cleanup import remove_legacy_files
    remove_legacy_files()
    try:
        restart = asyncio.run(run_server())
    except (KeyboardInterrupt, SystemExit):
        return
    if restart:
        # Replace this process with a fresh interpreter so updated code and restored config are loaded
        logging.shutdown()
        os.execv(sys.executable, [sys.executable] + sys.argv)


if __name__ == "__main__":
    main()
