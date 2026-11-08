"""
AutoGlow 2 - Classic mode (AutoGlow 1) routes
GET  /api/classic        settings, live status, effects and the USB ports found
POST /api/classic        save the settings (restarts the classic loop when needed)
POST /api/classic/test   show one status's look on the USB controller now
"""

import asyncio
from pathlib import Path

from aiohttp import web

from core.classic import EFFECTS, DEFAULT_STATUSES, ClassicService, list_ports, clean_board_manager_url
from core.errors import ValidationError, DeviceUnreachable, read_json

SERVICE_KEY = "classic_service"


def get_service(app: web.Application) -> ClassicService:
    service = app.get(SERVICE_KEY)
    if service is None:
        config_path = app.get("config_path")
        settings_path = Path(config_path).parent / "classic.json" if config_path else None
        service = ClassicService(settings_path) if settings_path else ClassicService()
        app[SERVICE_KEY] = service
    return service


def _payload(service: ClassicService, ports) -> dict:
    return {
        "status": "ok",
        "settings": service.settings,
        "state": service.snapshot(),
        "effects": [{"id": fx_id, "name": name} for name, fx_id in EFFECTS.items()],
        "status_names": list(DEFAULT_STATUSES),
        "ports": ports,
    }


async def handle_get_classic(request: web.Request) -> web.Response:
    ports = await asyncio.to_thread(list_ports)
    return web.json_response(_payload(get_service(request.app), ports))


async def handle_post_classic(request: web.Request) -> web.Response:
    data = await read_json(request)
    if "board_manager_url" in data and not clean_board_manager_url(data["board_manager_url"]):
        raise ValidationError("Enter the Board Manager address, for example http://localhost:3180",
                              field="board_manager_url")
    service = get_service(request.app)
    merged = {**service.settings, **data}
    await service.apply(merged)
    ports = await asyncio.to_thread(list_ports)
    return web.json_response(_payload(service, ports))


async def handle_test_classic(request: web.Request) -> web.Response:
    data = await read_json(request)
    key = data.get("status")
    if key not in DEFAULT_STATUSES:
        raise ValidationError("Unknown status", field="status")
    look = data.get("look") if isinstance(data.get("look"), dict) else None
    service = get_service(request.app)
    if not await service.test(key, look, data.get("global_brightness")):
        raise DeviceUnreachable(service.serial_error or "No USB controller connected.")
    return web.json_response({"status": "ok", "state": service.snapshot()})


async def _start_classic(app: web.Application) -> None:
    await get_service(app).start()


async def _stop_classic(app: web.Application) -> None:
    service = app.get(SERVICE_KEY)
    if service:
        await service.stop()


def register_classic_routes(app: web.Application) -> None:
    app.on_startup.append(_start_classic)
    app.on_cleanup.append(_stop_classic)
    app.router.add_get("/api/classic", handle_get_classic)
    app.router.add_post("/api/classic", handle_post_classic)
    app.router.add_post("/api/classic/test", handle_test_classic)
