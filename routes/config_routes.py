"""
AutoGlow 2 - Configuration Routes Module
Handlers for /api/config, /api/config/reset.
"""

import logging
from aiohttp import web

from core.errors import PersistenceError, ValidationError, read_json
from core.models import AppConfig, DeviceConfig
from core.storage import load_app_config, save_app_config
from core.security import redact_config_dict, restore_redacted_secrets, PIN_HASH_KEY
from core.autodarts_bridge import AutodartsBridgeClient

logger = logging.getLogger("autoglow.routes.config")


async def handle_get_config(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    data = redact_config_dict(cfg.to_dict())
    data["status"] = "ok"
    data["device"] = cfg.primary_device.to_dict() if cfg.primary_device else {}
    return web.json_response(data)


async def handle_post_config(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    data = await read_json(request)
    try:
        cfg = AppConfig.from_dict(data)
    except Exception:
        logger.warning("Rejected unparseable configuration", exc_info=True)
        raise ValidationError("Configuration is not valid")

    # Merge & preserve sensitive credentials and tokens if omitted or blank in incoming payload
    existing_cfg = request.app.get("current_app_config") or load_app_config(config_path)
    # The PIN is only changed through /api/auth/pin, never through a config save
    cfg.extra.pop(PIN_HASH_KEY, None)
    if existing_cfg:
        restore_redacted_secrets(cfg, existing_cfg)
        # Profile choices are made on the Hub / Lighting pages; a settings save that omits them keeps them
        if "device_profiles" not in data:
            cfg.device_profiles = {ip: n for ip, n in existing_cfg.device_profiles.items() if cfg.get_profile(n)}
        if not cfg.autodarts_user and existing_cfg.autodarts_user:
            cfg.autodarts_user = existing_cfg.autodarts_user
        if not cfg.autodarts_board_id and existing_cfg.autodarts_board_id:
            cfg.autodarts_board_id = existing_cfg.autodarts_board_id

        for tk in [
            "autodarts_token_expires_at",
            "autodarts_client_id",
            "autodarts_email",
            "autodarts_name",
            "autodarts_username",
            "autodarts_board_id",
        ]:
            if existing_cfg.extra.get(tk) and not cfg.extra.get(tk):
                cfg.extra[tk] = existing_cfg.extra[tk]

    if engine and engine.autodarts:
        ad = engine.autodarts
        if ad.access_token and not cfg.extra.get("autodarts_access_token"):
            cfg.extra["autodarts_access_token"] = ad.access_token
        if ad.refresh_token and not cfg.extra.get("autodarts_refresh_token"):
            cfg.extra["autodarts_refresh_token"] = ad.refresh_token
        if ad.token_expires_at and not cfg.extra.get("autodarts_token_expires_at"):
            cfg.extra["autodarts_token_expires_at"] = ad.token_expires_at
        if ad.email and not cfg.autodarts_user:
            cfg.autodarts_user = ad.email
        if ad.password and not cfg.autodarts_password:
            cfg.autodarts_password = ad.password
        if ad.board_id and not cfg.autodarts_board_id:
            cfg.autodarts_board_id = ad.board_id

    # Save to disk
    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist configuration to disk: {config_path}")
        raise PersistenceError("Failed to persist configuration to disk")
    request.app["current_app_config"] = cfg

    # Update in-memory engine if running
    if engine:
        primary = cfg.primary_device or DeviceConfig(ip="")
        engine.device_config = primary
        engine.profile = cfg.profile
        engine.app_config = cfg
        engine.sync_drivers(cfg)
        sim = request.app.get("simulator")
        if sim:
            sim.ws_led_count = primary.rgb_count or 45
            sim.pwm_index = primary.pwm_index

    return web.json_response({"status": "ok"})


async def handle_reset_config(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    empty_cfg = AppConfig()
    # Keep the access PIN: resetting lighting settings must not silently open the API
    existing_cfg = request.app.get("current_app_config") or load_app_config(config_path)
    if existing_cfg and existing_cfg.extra.get(PIN_HASH_KEY):
        empty_cfg.extra[PIN_HASH_KEY] = existing_cfg.extra[PIN_HASH_KEY]
    if not save_app_config(empty_cfg, config_path):
        logger.error(f"Failed to reset configuration on disk: {config_path}")
        raise PersistenceError("Failed to reset configuration on disk")

    request.app["current_app_config"] = empty_cfg

    if engine:
        engine.device_config = empty_cfg.primary_device or DeviceConfig(ip="")
        engine.profile = empty_cfg.profile
        engine.sync_drivers(empty_cfg)
        if engine.autodarts and not isinstance(engine.autodarts, AutodartsBridgeClient):
            await engine.autodarts.stop()
            engine.autodarts = None

    logger.info("Application settings reset to clean zero-state.")
    return web.json_response({"status": "ok", "message": "Settings cleared."})
