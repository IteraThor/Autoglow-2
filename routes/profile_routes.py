"""
AutoGlow 2 - Event Matrix Presets & Profile Routes Module
Handlers for /api/matrix/presets (GET, select, save, rename, delete, export, import).
"""

import json
import logging
from pathlib import Path
from aiohttp import web

from core.models import ProfileConfig
from core.storage import (
    load_app_config, save_app_config, save_preset_file,
    delete_preset_file, sync_presets_with_disk, sanitize_preset_filename
)

logger = logging.getLogger("autoglow.routes.profiles")


async def handle_get_presets(request: web.Request) -> web.Response:
    """Return all available Event Matrix preset names and the currently active preset, syncing with presets/ folder."""
    config_path = request.app.get("config_path", "config.json")
    presets_dir = request.app.get("presets_dir")
    cfg = load_app_config(config_path)

    # Sync with presets/ directory
    if sync_presets_with_disk(cfg, presets_dir=presets_dir):
        save_app_config(cfg, config_path)

    presets = [p.name for p in cfg.profiles]
    return web.json_response({
        "status": "ok",
        "active_profile": cfg.active_profile,
        "presets": presets
    })


async def handle_select_preset(request: web.Request) -> web.Response:
    """Switch active Event Matrix preset and immediately sync engine profile."""
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    cfg = load_app_config(config_path)

    try:
        data = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "Invalid JSON payload"}, status=400)

    target_name = str(data.get("name", "")).strip()
    if not target_name:
        return web.json_response({"status": "error", "message": "Preset name is required"}, status=400)

    if not cfg.set_active_profile(target_name):
        return web.json_response({"status": "error", "message": f"Preset '{target_name}' not found"}, status=404)

    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist active preset '{target_name}' to disk")
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)

    request.app["current_app_config"] = cfg
    if engine:
        engine.profile = cfg.profile
        engine.app_config = cfg

    logger.info(f"Switched active Event Matrix preset to '{target_name}'")
    return web.json_response({
        "status": "ok",
        "active_profile": cfg.active_profile,
        "presets": [p.name for p in cfg.profiles],
        "profile": cfg.profile.to_dict()
    })


async def handle_save_preset(request: web.Request) -> web.Response:
    """Save or create an Event Matrix preset and sync engine profile."""
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    presets_dir = request.app.get("presets_dir")
    cfg = load_app_config(config_path)

    try:
        data = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "Invalid JSON payload"}, status=400)

    preset_name = str(data.get("name", "")).strip()
    if not preset_name:
        return web.json_response({"status": "error", "message": "Preset name cannot be empty"}, status=400)

    if len(preset_name) > 60:
        return web.json_response({"status": "error", "message": "Preset name exceeds 60 characters"}, status=400)

    profile_data = data.get("profile")
    if profile_data and isinstance(profile_data, dict):
        new_profile = ProfileConfig.from_dict(profile_data)
        new_profile.name = preset_name
    else:
        # Clone current active profile with new name
        current = cfg.profile
        new_profile = ProfileConfig.from_dict(current.to_dict())
        new_profile.name = preset_name

    set_active = bool(data.get("set_active", True))
    cfg.add_or_update_profile(new_profile, set_active=set_active)

    # Save to disk (config.json + presets/ folder)
    save_preset_file(new_profile, presets_dir=presets_dir)
    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist preset '{preset_name}' to disk")
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)

    request.app["current_app_config"] = cfg
    if engine and set_active:
        engine.profile = cfg.profile
        engine.app_config = cfg

    logger.info(f"Saved Event Matrix preset '{preset_name}' (active={set_active})")
    return web.json_response({
        "status": "ok",
        "active_profile": cfg.active_profile,
        "presets": [p.name for p in cfg.profiles],
        "profile": cfg.profile.to_dict()
    })


async def handle_rename_preset(request: web.Request) -> web.Response:
    """Rename an existing Event Matrix preset."""
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    presets_dir = request.app.get("presets_dir")
    cfg = load_app_config(config_path)

    try:
        data = await request.json()
    except Exception:
        return web.json_response({"status": "error", "message": "Invalid JSON payload"}, status=400)

    old_name = str(data.get("old_name", "")).strip()
    new_name = str(data.get("new_name", "")).strip()

    if not old_name:
        return web.json_response({"status": "error", "message": "Original preset name is required"}, status=400)

    if not new_name:
        return web.json_response({"status": "error", "message": "New preset name cannot be empty"}, status=400)

    if len(new_name) > 60:
        return web.json_response({"status": "error", "message": "Preset name exceeds 60 characters"}, status=400)

    if old_name.lower() == "default":
        return web.json_response({"status": "error", "message": "The 'Default' preset cannot be renamed"}, status=400)

    if old_name == new_name:
        return web.json_response({
            "status": "ok",
            "active_profile": cfg.active_profile,
            "presets": [p.name for p in cfg.profiles]
        })

    # Ensure new name doesn't collide with existing preset
    if any(p.name.lower() == new_name.lower() for p in cfg.profiles if p.name.lower() != old_name.lower()):
        return web.json_response({"status": "error", "message": f"A preset named '{new_name}' already exists"}, status=400)

    target_profile = cfg.get_profile(old_name)
    if not target_profile:
        return web.json_response({"status": "error", "message": f"Preset '{old_name}' not found"}, status=404)

    target_profile.name = new_name
    if cfg.active_profile == old_name:
        cfg.active_profile = new_name
        cfg.profile = target_profile

    # Update on disk
    delete_preset_file(old_name, presets_dir=presets_dir)
    save_preset_file(target_profile, presets_dir=presets_dir)

    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist renamed preset '{new_name}' to disk")
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)

    request.app["current_app_config"] = cfg
    if engine and cfg.active_profile == new_name:
        engine.profile = cfg.profile
        engine.app_config = cfg

    logger.info(f"Renamed Event Matrix preset '{old_name}' to '{new_name}'")
    return web.json_response({
        "status": "ok",
        "active_profile": cfg.active_profile,
        "presets": [p.name for p in cfg.profiles]
    })


async def handle_delete_preset(request: web.Request) -> web.Response:
    """Delete an existing Event Matrix preset."""
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    presets_dir = request.app.get("presets_dir")
    cfg = load_app_config(config_path)

    try:
        data = await request.json()
    except Exception:
        data = {}

    target_name = str(data.get("name", request.query.get("name", ""))).strip()
    if not target_name:
        return web.json_response({"status": "error", "message": "Preset name to delete is required"}, status=400)

    if target_name.lower() == "default":
        return web.json_response({"status": "error", "message": "The 'Default' preset cannot be deleted"}, status=400)

    if len(cfg.profiles) <= 1:
        return web.json_response({"status": "error", "message": "Cannot delete the only remaining preset"}, status=400)

    target_profile = cfg.get_profile(target_name)
    if not target_profile:
        return web.json_response({"status": "error", "message": f"Preset '{target_name}' not found"}, status=404)

    cfg.profiles = [p for p in cfg.profiles if p.name != target_name]
    delete_preset_file(target_name, presets_dir=presets_dir)

    # If the active preset was deleted, fall back to Default or first available preset
    if cfg.active_profile == target_name:
        default_candidate = cfg.get_profile("Default")
        fallback = default_candidate or cfg.profiles[0]
        cfg.active_profile = fallback.name
        cfg.profile = fallback

    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist configuration after deleting preset '{target_name}'")
        return web.json_response({"status": "error", "message": "Failed to persist configuration to disk"}, status=500)

    request.app["current_app_config"] = cfg
    if engine:
        engine.profile = cfg.profile
        engine.app_config = cfg

    logger.info(f"Deleted Event Matrix preset '{target_name}'. Active is now '{cfg.active_profile}'")
    return web.json_response({
        "status": "ok",
        "active_profile": cfg.active_profile,
        "presets": [p.name for p in cfg.profiles],
        "profile": cfg.profile.to_dict()
    })


async def handle_export_preset(request: web.Request) -> web.Response:
    """Export an individual preset as a downloadable JSON file."""
    config_path = request.app.get("config_path", "config.json")
    cfg = load_app_config(config_path)

    target_name = request.query.get("name", "").strip() or cfg.active_profile
    profile = cfg.get_profile(target_name)
    if not profile:
        return web.json_response({"status": "error", "message": f"Preset '{target_name}' not found"}, status=404)

    export_data = profile.to_dict()
    filename = sanitize_preset_filename(target_name)

    return web.json_response(
        export_data,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


async def handle_import_preset(request: web.Request) -> web.Response:
    """Import a preset from uploaded JSON and add to presets/ and config."""
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    presets_dir = request.app.get("presets_dir")
    cfg = load_app_config(config_path)

    try:
        if request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            part = await reader.next()
            if part is None:
                return web.json_response({"status": "error", "message": "No file uploaded"}, status=400)
            file_bytes = await part.read()
            data = json.loads(file_bytes.decode("utf-8"))
            filename_stem = Path(part.filename).stem if part.filename else "Imported Preset"
        else:
            data = await request.json()
            filename_stem = "Imported Preset"
    except Exception as e:
        return web.json_response({"status": "error", "message": f"Invalid JSON format: {e}"}, status=400)

    if not isinstance(data, dict):
        return web.json_response({"status": "error", "message": "Preset file must contain a JSON object"}, status=400)

    preset_name = str(data.get("name", filename_stem)).strip() or filename_stem
    if len(preset_name) > 60:
        preset_name = preset_name[:60]

    # If preset name already exists, append unique suffix
    existing_lower = {p.name.lower() for p in cfg.profiles}
    final_name = preset_name
    counter = 1
    while final_name.lower() in existing_lower:
        final_name = f"{preset_name} ({counter})"
        counter += 1

    imported_profile = ProfileConfig.from_dict(data)
    imported_profile.name = final_name

    cfg.add_or_update_profile(imported_profile, set_active=True)
    save_preset_file(imported_profile, presets_dir=presets_dir)

    if not save_app_config(cfg, config_path):
        return web.json_response({"status": "error", "message": "Failed to persist configuration"}, status=500)

    request.app["current_app_config"] = cfg
    if engine:
        engine.profile = cfg.profile
        engine.app_config = cfg

    logger.info(f"Successfully imported preset '{final_name}'")
    return web.json_response({
        "status": "ok",
        "active_profile": cfg.active_profile,
        "presets": [p.name for p in cfg.profiles],
        "profile": cfg.profile.to_dict()
    })
