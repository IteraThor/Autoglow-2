"""
AutoGlow 2 - Flow Matrix routes.

Profiles (named flows), which controller / segment uses which, trying a step or hit on the real lights,
the match preview, and the lighting mode switch.
"""

import logging
from typing import Any, Dict, List, Optional

from aiohttp import web

from core.effects.flow import catalog_for_ui
from core.errors import AppError, PersistenceError, ServiceUnavailable, ValidationError, read_json
from core.flow_idle import apply_idle
from core.flow_presets import build_preset, presets_for_ui
from core.flow_runtime import EngineFlowOutput
from core.game_flow import (
    ALWAYS_ON_STEPS, HIT_IDS, HIT_LABELS, MAX_PLAYERS, STEP_IDS, STEP_LABELS, TIMED_STEPS,
    GameFlow, GameFlowStorageManager, player_colour_index,
)
from core.models import LightingMode

logger = logging.getLogger("autoglow.routes.flow")

flow_storage = GameFlowStorageManager()
MAX_NAME = 40


def _storage(request: web.Request) -> GameFlowStorageManager:
    """The engine's flow storage (one source of truth), or an injected test instance."""
    injected = request.app.get("flow_storage")
    if injected is not None:
        return injected
    engine = request.app.get("engine")
    return getattr(engine, "game_flow_storage", None) or flow_storage


def _engine(request: web.Request) -> Any:
    engine = request.app.get("engine")
    if not engine:
        raise ServiceUnavailable("Engine not available")
    return engine


def _match_running(engine: Any) -> bool:
    """A match is in play (a finished match keeps its id until the board goes idle, but is over)."""
    ad = engine.autodarts
    return bool(ad and getattr(ad, "_active_match_id", None) and not getattr(ad, "_last_match_finished", False))


def _clean_name(raw: Any) -> str:
    name = " ".join(str(raw or "").split())
    if not name:
        raise ValidationError("Give the profile a name.")
    if len(name) > MAX_NAME:
        raise ValidationError(f"Profile names can be at most {MAX_NAME} characters.")
    return name


def _lights(request: web.Request, storage: GameFlowStorageManager) -> List[Dict[str, Any]]:
    """Every controller and its light strips, with the flow profile each one plays."""
    from core.engine import _is_pwm_segment, _seg_attr, _seg_id
    engine = request.app.get("engine")
    devices = list(engine._active_devices()) if engine else []
    out = []
    for dev in devices:
        segs = []
        if dev.segments:
            for seg in dev.segments:
                sid = _seg_id(seg)
                pwm = _is_pwm_segment(seg)
                segs.append({
                    "id": sid,
                    "name": _seg_attr(seg, "name", f"Segment {sid}"),
                    "gpio": str(_seg_attr(seg, "gpio", "") or ""),
                    "length": int(_seg_attr(seg, "length", 0) or 0),
                    "role": _seg_attr(seg, "role", "dartboard_ring"),
                    "light_strip": pwm,
                    "clockwise": bool(_seg_attr(seg, "clockwise", True)),
                    "locator": bool(_seg_attr(seg, "locator", True)),
                    "profile": None if pwm else storage.profile_name_for(dev.ip, sid),
                })
        else:
            segs.append({"id": None, "name": "All LEDs", "gpio": "", "length": int(dev.rgb_count or 0), "role": "dartboard_ring",
                         "light_strip": False, "clockwise": True, "profile": storage.profile_name_for(dev.ip, None)})
        out.append({"ip": dev.ip, "name": dev.name or dev.ip, "segments": segs})
    return out


def _overview(request: web.Request) -> Dict[str, Any]:
    storage = _storage(request)
    lights = _lights(request, storage)
    profiles = []
    for name in storage.profile_names():
        flow = storage.get_profile(name)
        used_by = [
            {"ip": dev["ip"], "controller": dev["name"], "segment": seg["id"], "segment_name": seg["name"]}
            for dev in lights for seg in dev["segments"] if seg["profile"] == name
        ]
        profiles.append({"name": name, "preset": flow.preset, "used_by": used_by})
    engine = request.app.get("engine")
    cfg = getattr(engine, "app_config", None)
    mode = cfg.lighting_mode.value if cfg and isinstance(cfg.lighting_mode, LightingMode) else "flow"
    return {
        "status": "ok",
        "profiles": profiles,
        "default": storage.default_profile,
        "lights": lights,
        "lighting_mode": mode,
        "match_end_to_waiting": bool(cfg and cfg.disconnect_udp_on_match_end),
        # The standby timers (Settings) drawn under Waiting
        "standby": {
            "dim_on": bool(cfg.inactivity_timeout_enabled) if cfg else True,
            "dim_minutes": int(cfg.inactivity_timeout_minutes) if cfg else 5,
            "off_on": bool(cfg.idle_power_off_enabled) if cfg else True,
            "off_minutes": int(cfg.idle_power_off_minutes) if cfg else 30,
            "dim_brightness": int(cfg.idle_dimming_brightness) if cfg else 50,
        },
        "match_running": bool(engine and _match_running(engine)),
        "live": engine.flow_runtime.snapshot() if engine else None,
        "catalog": catalog_for_ui(),
        "presets": presets_for_ui(),
        "steps": [
            {"id": sid, "label": STEP_LABELS[sid], "timed": sid in TIMED_STEPS, "always_on": sid in ALWAYS_ON_STEPS}
            for sid in STEP_IDS
        ],
        "hits": [{"id": hid, "label": HIT_LABELS[hid]} for hid in HIT_IDS],
        "max_players": MAX_PLAYERS,
    }


async def handle_overview(request: web.Request) -> web.Response:
    return web.json_response(_overview(request))


async def handle_get_profile(request: web.Request) -> web.Response:
    storage = _storage(request)
    name = request.query.get("name")
    if name and name not in storage.profile_names():
        raise ValidationError(f"There is no profile called '{name}'.")
    return web.json_response({"status": "ok", "flow": storage.get_profile(name).to_dict()})


async def handle_save_profile(request: web.Request) -> web.Response:
    """Save an edited profile; a changed name renames it (controllers keep using it)."""
    data = await read_json(request)
    storage = _storage(request)
    raw = data.get("flow")
    if not isinstance(raw, dict) or "steps" not in raw:
        raise ValidationError("No flow to save.")
    old_name = str(data.get("old_name") or raw.get("name") or "")
    name = _clean_name(raw.get("name"))
    if old_name and old_name not in storage.profile_names():
        raise ValidationError(f"There is no profile called '{old_name}'.")
    if name != old_name and name in storage.profile_names():
        raise ValidationError(f"A profile called '{name}' already exists.")
    flow = GameFlow.from_dict({**raw, "name": name}, name=name)
    if not storage.save_profile(flow, old_name=old_name or None):
        raise PersistenceError("Could not save the flow profile.")
    failed = await apply_idle(request.app.get("engine"), storage, profile=name)
    return web.json_response({"status": "ok", "flow": storage.get_profile(name).to_dict(), "idle_failed": failed,
                              **_overview(request)})


async def handle_create_profile(request: web.Request) -> web.Response:
    """A new profile from a preset, or a copy of an existing profile."""
    data = await read_json(request)
    storage = _storage(request)
    name = _clean_name(data.get("name"))
    if name in storage.profile_names():
        raise ValidationError(f"A profile called '{name}' already exists.")
    copy_from = data.get("copy_from")
    if copy_from:
        if copy_from not in storage.profile_names():
            raise ValidationError(f"There is no profile called '{copy_from}'.")
        flow = storage.load_profile(copy_from)
        flow.name = name
    else:
        flow = build_preset(str(data.get("preset") or "classic"), name=name)
    if not storage.save_profile(flow):
        raise PersistenceError("Could not create the flow profile.")
    return web.json_response({"status": "ok", "flow": flow.to_dict(), **_overview(request)})


async def handle_delete_profile(request: web.Request) -> web.Response:
    data = await read_json(request)
    storage = _storage(request)
    name = str(data.get("name") or "")
    if name not in storage.profile_names():
        raise ValidationError(f"There is no profile called '{name}'.")
    if len(storage.profile_names()) <= 1:
        raise ValidationError("The last profile cannot be deleted.")
    if not storage.delete_profile(name):
        raise PersistenceError("Could not delete the flow profile.")
    # Its segments now play the default profile, and with it its waiting look
    failed = await apply_idle(request.app.get("engine"), storage)
    return web.json_response({"status": "ok", "idle_failed": failed, **_overview(request)})


async def handle_reset_profile(request: web.Request) -> web.Response:
    """Put a profile back to the preset it started from (Classic when it has none)."""
    data = await read_json(request)
    storage = _storage(request)
    name = str(data.get("name") or "")
    if name not in storage.profile_names():
        raise ValidationError(f"There is no profile called '{name}'.")
    current = storage.get_profile(name)
    flow = build_preset(current.preset or "classic", name=name)
    if not storage.save_profile(flow):
        raise PersistenceError("Could not reset the flow profile.")
    failed = await apply_idle(request.app.get("engine"), storage, profile=name)
    return web.json_response({"status": "ok", "flow": flow.to_dict(), "idle_failed": failed, **_overview(request)})


async def handle_set_default(request: web.Request) -> web.Response:
    data = await read_json(request)
    storage = _storage(request)
    name = str(data.get("name") or "")
    if not storage.set_default(name):
        raise ValidationError(f"There is no profile called '{name}'.")
    failed = await apply_idle(request.app.get("engine"), storage)
    return web.json_response({"status": "ok", "idle_failed": failed, **_overview(request)})


async def handle_assign(request: web.Request) -> web.Response:
    """Choose the profile a controller (segment_id omitted) or one of its segments plays."""
    data = await read_json(request)
    storage = _storage(request)
    ip = str(data.get("ip") or "").strip()
    name = str(data.get("name") or "")
    seg = data.get("segment_id")
    if name not in storage.profile_names():
        raise ValidationError(f"There is no profile called '{name}'.")
    if not ip:
        raise ValidationError("Choose a controller.")
    if not storage.assign(ip, name, None if seg is None else int(seg)):
        raise PersistenceError("Could not save the profile choice.")
    # The segment takes the profile's waiting look straight away
    failed = await apply_idle(request.app.get("engine"), storage, ips=[ip])
    return web.json_response({"status": "ok", "idle_failed": failed, **_overview(request)})


def _own_name(storage: GameFlowStorageManager, base: str, segment: str) -> str:
    """A free profile name for a segment's own lights: "<profile> · <segment>" (2, 3, ... when taken)."""
    suffix = f" · {segment}"
    stem = base if base.endswith(suffix) else base + suffix
    names = set(storage.profile_names())
    for i in range(1, 100):
        tail = "" if i == 1 else f" {i}"
        name = stem[:MAX_NAME - len(tail)].rstrip() + tail
        if name not in names:
            return name
    raise ValidationError("Too many profiles with that name.")


async def handle_own_lights(request: web.Request) -> web.Response:
    """Give one segment its own copy of a (possibly edited) flow, so changing it no longer changes the
    other segments that shared it."""
    data = await read_json(request)
    storage = _storage(request)
    engine = request.app.get("engine")
    ip = str(data.get("ip") or "").strip()
    seg = data.get("segment_id")
    seg_id = None if seg is None else int(seg)
    raw = data.get("flow")
    if not isinstance(raw, dict) or "steps" not in raw:
        raise ValidationError("No flow to save.")
    lights = _lights(request, storage)
    dev = next((d for d in lights if d["ip"] == ip), None)
    entry = next((s for s in dev["segments"] if s["id"] == seg_id), None) if dev else None
    if not entry or entry["light_strip"]:
        raise ValidationError("That RGB strip was not found.")
    name = _own_name(storage, str(raw.get("name") or entry["profile"] or "Lights"), entry["name"])
    flow = GameFlow.from_dict({**raw, "name": name}, name=name)
    if not storage.save_profile(flow) or not storage.assign(ip, name, seg_id):
        raise PersistenceError("Could not save the lights for this strip.")
    failed = await apply_idle(engine, storage, ips=[ip])
    return web.json_response({"status": "ok", "flow": storage.get_profile(name).to_dict(), "idle_failed": failed,
                              **_overview(request)})


async def handle_apply_idle(request: web.Request) -> web.Response:
    """Write the waiting look of the assigned profiles to one controller (ip) or all of them."""
    data = await read_json(request)
    ip = str(data.get("ip") or "").strip()
    failed = await apply_idle(request.app.get("engine"), _storage(request), ips=[ip] if ip else None)
    return web.json_response({"status": "ok", "idle_failed": failed})


def _targets(engine: Any, ip: Optional[str], seg: Any, chosen: Any = None) -> List[tuple]:
    """The RGB segments to try a look on: the chosen ones ([{ip, segment_id}]), one controller / segment, or all."""
    segs = EngineFlowOutput(engine).segments()
    if isinstance(chosen, list):
        want = {(str(c.get("ip") or ""), None if c.get("segment_id") is None else int(c["segment_id"]))
                for c in chosen if isinstance(c, dict)}
        return [s for s in segs if (s[0], s[1]) in want]
    if ip:
        segs = [s for s in segs if s[0] == ip and (seg is None or s[1] == int(seg))]
    return segs


async def handle_try(request: web.Request) -> web.Response:
    """
    Try part of a (possibly unsaved) flow on the real lights:
      kind "step": the step's look, coming in with its transition
      kind "hit": the player's turn look with the hit on top
    """
    engine = _engine(request)
    if _match_running(engine):
        raise ValidationError("A match is running; trying looks would disturb it.")
    data = await read_json(request)
    raw = data.get("flow")
    flow = GameFlow.from_dict(raw) if isinstance(raw, dict) else _storage(request).get_profile(data.get("name"))
    kind = str(data.get("kind") or "step")
    item = str(data.get("id") or "turn")
    player = max(0, min(MAX_PLAYERS - 1, int(data.get("player") or 0)))
    targets = _targets(engine, data.get("ip"), data.get("segment_id"), data.get("segments"))
    if not targets:
        raise ValidationError("No light strip to try it on. Add a controller in Setup first.")

    out = EngineFlowOutput(engine)
    await out.ensure_streaming()
    engine.lighting_test_active = True
    colour = flow.players[player_colour_index([], player, flow)].color

    def coloured(eff, force=False):
        if force or (eff.options or {}).get("colour_from") == "player":
            import dataclasses
            return dataclasses.replace(eff, color_primary=colour)
        return eff

    turn = flow.steps["turn"]
    for ip, sid, _role in targets:
        drv = engine.get_driver(ip)
        if not drv:
            continue
        if kind == "hit":
            if item not in HIT_IDS:
                raise ValidationError("Unknown hit.")
            drv.flow_show(sid, coloured(turn.effect, True), "instant", 0.0)
            drv.flow_hit(sid, coloured(flow.hits[item]), 1.0)
        elif kind == "locator":
            from core.flow_runtime import board_position
            drv.flow_show(sid, coloured(turn.effect, True), "instant", 0.0)
            drv.flow_locate(sid, board_position(int(data.get("number") or 20)) or 0.0, colour,
                            duration=2.0, clockwise=engine.segment_clockwise(ip, sid))
        else:
            if item not in STEP_IDS:
                raise ValidationError("Unknown step.")
            step = flow.steps[item]
            tr = step.transition
            acc = tr.accent_color.to_tuple() if tr.accent_color else None
            drv.flow_show(sid, coloured(step.effect, item == "turn"), tr.style, tr.duration, acc)
    return web.json_response({"status": "ok"})


async def handle_preview(request: web.Request) -> web.Response:
    """Play a short made-up match through the flow on the real lights."""
    engine = _engine(request)
    if _match_running(engine):
        raise ValidationError("A match is running; the preview would disturb it.")
    data = await read_json(request)
    from core.flow_preview import start_preview
    raw = data.get("flow")
    flow = GameFlow.from_dict(raw) if isinstance(raw, dict) else None
    plan = await start_preview(
        engine,
        players=max(1, min(MAX_PLAYERS, int(data.get("players") or 2))),
        bull_off=bool(data.get("bull_off", False)),
        legs=max(1, min(3, int(data.get("legs") or 1))),
        flow=flow,
    )
    return web.json_response({"status": "ok", **plan})


async def handle_preview_stop(request: web.Request) -> web.Response:
    engine = _engine(request)
    from core.flow_preview import stop_preview
    await stop_preview(engine)
    return web.json_response({"status": "ok"})


async def handle_segment_direction(request: web.Request) -> web.Response:
    """Save which way a light strip runs around the board (used by the hit locator)."""
    engine = _engine(request)
    data = await read_json(request)
    ip = str(data.get("ip") or "")
    seg_id = int(data.get("segment_id") or 0)
    direction = str(data.get("direction") or ("cw" if data.get("clockwise", True) else "ccw"))
    clockwise = direction != "ccw"
    locator = direction != "off"
    from core.storage import load_app_config, save_app_config
    config_path = request.app.get("config_path") or "config.json"
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    changed = False
    for config in {id(c): c for c in (cfg, engine.app_config) if c}.values():
        for dev in config.devices:
            if dev.ip != ip:
                continue
            for seg in dev.segments:
                if seg.id == seg_id:
                    seg.clockwise = clockwise
                    seg.locator = locator
                    changed = True
    if not changed:
        raise ValidationError("That light strip was not found.")
    if not save_app_config(cfg, config_path):
        raise PersistenceError("Could not save the strip direction.")
    request.app["current_app_config"] = cfg
    return web.json_response({"status": "ok", "direction": direction})


async def handle_get_lighting_mode(request: web.Request) -> web.Response:
    """Return the current active lighting mode (matrix or flow)."""
    engine = request.app.get("engine")
    mode = "flow"
    if engine and hasattr(engine, "app_config") and hasattr(engine.app_config, "lighting_mode"):
        mode = engine.app_config.lighting_mode.value if isinstance(engine.app_config.lighting_mode, LightingMode) else str(engine.app_config.lighting_mode)
    return web.json_response({"status": "ok", "mode": mode})


async def handle_set_lighting_mode(request: web.Request) -> web.Response:
    """Switch the lighting engine: Flow Matrix (default) or the legacy Event Matrix."""
    try:
        data = await read_json(request)
        # Flow Matrix is the default; the Event Matrix (legacy, unsupported) only when asked for by name
        mode_str = str(data.get("mode", "flow")).strip().lower()
        mode = LightingMode.MATRIX if mode_str == "matrix" else LightingMode.FLOW

        engine = request.app.get("engine")
        if engine and hasattr(engine, "set_lighting_mode"):
            engine.set_lighting_mode(mode)

        # Persist to config.json
        try:
            from core.storage import load_app_config, save_app_config
            config_path = request.app.get("config_path") or "config.json"
            cfg = request.app.get("current_app_config") or load_app_config(config_path)
            if cfg:
                cfg.lighting_mode = mode
                save_app_config(cfg, config_path)
                request.app["current_app_config"] = cfg
        except Exception as e_cfg:
            logger.warning(f"Could not persist lighting_mode to config.json: {e_cfg}")

        if engine and hasattr(engine, "_broadcast_telemetry"):
            await engine._broadcast_telemetry({"type": "lighting_mode_changed", "mode": mode.value})

        logger.info(f"Lighting mode changed to '{mode.value}' and persisted.")
        # Back on the Flow Matrix: the strips wait with their profiles' look again
        failed = await apply_idle(engine, _storage(request)) if mode == LightingMode.FLOW else []
        return web.json_response({"status": "ok", "mode": mode.value, "idle_failed": failed})
    except AppError:
        raise
    except Exception as e:
        logger.exception(f"Error setting lighting mode: {e}")
        raise AppError("Could not change the lighting mode") from e


async def handle_standby(request: web.Request) -> web.Response:
    """Save the standby timers (the same values as Settings > Power) from the Flow Matrix chart."""
    engine = _engine(request)
    data = await read_json(request)
    from core.storage import load_app_config, save_app_config
    config_path = request.app.get("config_path") or "config.json"
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    base = cfg or engine.app_config

    def minutes(key: str, fallback: int) -> int:
        try:
            return max(1, min(240, int(data.get(key, fallback))))
        except (TypeError, ValueError):
            raise ValidationError("Minutes must be a whole number.") from None

    def brightness() -> int:
        """Dimmed light strip brightness, 0-255."""
        try:
            return max(0, min(255, int(data.get("dim_brightness", base.idle_dimming_brightness))))
        except (TypeError, ValueError):
            raise ValidationError("Brightness must be a whole number.") from None

    values = {
        "inactivity_timeout_enabled": bool(data.get("dim_on", base.inactivity_timeout_enabled)),
        "inactivity_timeout_minutes": minutes("dim_minutes", base.inactivity_timeout_minutes),
        "idle_power_off_enabled": bool(data.get("off_on", base.idle_power_off_enabled)),
        "idle_power_off_minutes": minutes("off_minutes", base.idle_power_off_minutes),
        "disconnect_udp_on_match_end": bool(data.get("match_end_to_waiting", base.disconnect_udp_on_match_end)),
        "idle_dimming_brightness": brightness(),
    }
    # Same rule as Settings > Power: switching off never comes before dimming
    values["idle_power_off_minutes"] = max(values["idle_power_off_minutes"], values["inactivity_timeout_minutes"])
    for config in {id(c): c for c in (cfg, engine.app_config) if c}.values():
        for key, value in values.items():
            setattr(config, key, value)
    if not save_app_config(cfg, config_path):
        raise PersistenceError("Could not save the standby timers.")
    request.app["current_app_config"] = cfg
    return web.json_response({"status": "ok", **values})


def register_flow_routes(app: web.Application) -> None:
    """Register all Flow Matrix routes with the aiohttp application."""
    app.router.add_get("/api/flow/overview", handle_overview)
    app.router.add_get("/api/flow/profile", handle_get_profile)
    app.router.add_post("/api/flow/profile/save", handle_save_profile)
    app.router.add_post("/api/flow/profile/create", handle_create_profile)
    app.router.add_post("/api/flow/profile/delete", handle_delete_profile)
    app.router.add_post("/api/flow/profile/reset", handle_reset_profile)
    app.router.add_post("/api/flow/profile/default", handle_set_default)
    app.router.add_post("/api/flow/assign", handle_assign)
    app.router.add_post("/api/flow/segment/own", handle_own_lights)
    app.router.add_post("/api/flow/idle/apply", handle_apply_idle)
    app.router.add_post("/api/flow/try", handle_try)
    app.router.add_post("/api/flow/preview", handle_preview)
    app.router.add_post("/api/flow/preview/stop", handle_preview_stop)
    app.router.add_post("/api/flow/segment-direction", handle_segment_direction)
    app.router.add_post("/api/flow/standby", handle_standby)
    app.router.add_get("/api/flow/mode", handle_get_lighting_mode)
    app.router.add_post("/api/flow/mode", handle_set_lighting_mode)
