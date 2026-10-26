"""
AutoGlow 2 - WLED Hardware & Network Routes Module
Handlers for WLED mutations, discovery, preset management, and effects testing.
"""

import asyncio
import logging
from aiohttp import web

from core.errors import DeviceUnreachable, NotFound, PersistenceError, ServiceUnavailable, ValidationError, read_json
from core.models import (
    DeviceConfig, SegmentConfig, EffectConfig, AnimationType,
    RGBColor, ProtocolMode, _safe_int
)
from core.storage import load_app_config, save_app_config
from core.engine import _is_pwm_segment
from core.wled_driver import WLEDDriver
from core.discovery import DiscoveryService

logger = logging.getLogger("autoglow.routes.wled")


async def handle_ping_device(request: web.Request) -> web.Response:
    ip = request.query.get("ip", "").strip()
    if not ip:
        return web.json_response({
            "status": "ok",
            "online": False,
            "ip": "",
            "message": "No IP specified"
        })
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(None, WLEDDriver.fetch_live_device_info, ip)
        return web.json_response(result)
    except Exception as e:
        logger.warning(f"Ping exception for {ip}: {e}")
        return web.json_response({
            "status": "ok",
            "online": False,
            "ip": ip,
            "message": "Controller did not respond"
        })


async def handle_wled_update(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    data = await read_json(request)
    ip = data.get("ip", "").strip()
    if not ip:
        raise ValidationError("No IP specified", field="ip")

    # 1. Update AutoGlow internal config FIRST so changes persist even if hardware is offline
    # Use in-memory config if available to avoid losing devices added since last disk read
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    name = data.get("name")
    udp_port = data.get("udp_port")
    hw_ins = data.get("hw_ins")
    state = data.get("state", {})
    seg_data = state.get("seg", []) if isinstance(state, dict) else []

    found = False
    for dev in cfg.devices:
        if dev.ip == ip:
            found = True
            if name:
                dev.name = name
            if udp_port:
                dev.udp_port = _safe_int(udp_port, 21324)
            if hw_ins and isinstance(hw_ins, list) and len(hw_ins) > 0:
                cum_start = 0
                for b_idx, hw in enumerate(hw_ins):
                    hw_type = _safe_int(hw.get("type"), 22)
                    is_pwm = (hw_type >= 40)
                    if is_pwm:
                        hw["len"] = max(1, _safe_int(hw.get("len"), 1))
                    else:
                        hw["len"] = max(1, _safe_int(hw.get("len"), 45))

                    hw["start"] = cum_start
                    cum_start += _safe_int(hw["len"], 1)

                if isinstance(state, dict):
                    state["seg"] = seg_data

                dev.hw_ins = hw_ins
                dev.rgb_count = _safe_int(hw_ins[0].get("len"), 45)
                pwm_hw = next((h for h in hw_ins if _safe_int(h.get("type"), 22) >= 40), None)
                if pwm_hw:
                    dev.pwm_index = _safe_int(pwm_hw.get("start"), dev.rgb_count)
                else:
                    dev.pwm_index = None

            if seg_data and isinstance(seg_data, list):
                dev.segments = [
                    SegmentConfig(
                        id=_safe_int(s.get("id"), s_idx),
                        name=str(s.get("n") or s.get("name") or f"Segment {s_idx}"),
                        start=_safe_int(s.get("start"), 0),
                        length=max(1, (_safe_int(s.get("stop"), 1) - _safe_int(s.get("start"), 0))),
                        type="PWM White" if any(_safe_int(h.get("type"), 22) >= 40 and _safe_int(h.get("start"), 0) <= _safe_int(s.get("start"), 0) < _safe_int(h.get("start"), 0) + _safe_int(h.get("len"), 1) for h in (hw_ins or [])) else "WS281x",
                        offset=max(0, _safe_int(s.get("of"), 0))
                    )
                    for s_idx, s in enumerate(seg_data) if isinstance(s, dict)
                ]

    if not found:
        segments = [
            SegmentConfig(
                id=_safe_int(s.get("id"), s_idx),
                name=str(s.get("n") or s.get("name") or f"Segment {s_idx}"),
                start=_safe_int(s.get("start"), 0),
                length=max(1, (_safe_int(s.get("stop"), 1) - _safe_int(s.get("start"), 0))),
                type="PWM White" if any(_safe_int(h.get("type"), 22) >= 40 and _safe_int(h.get("start"), 0) <= _safe_int(s.get("start"), 0) < _safe_int(h.get("start"), 0) + _safe_int(h.get("len"), 1) for h in (hw_ins or [])) else "WS281x",
                offset=max(0, _safe_int(s.get("of"), 0))
            )
            for s_idx, s in enumerate(seg_data) if isinstance(s, dict)
        ] if seg_data else []

        pwm_hw = next((h for h in hw_ins if _safe_int(h.get("type"), 22) >= 40), None) if (hw_ins and isinstance(hw_ins, list)) else None
        pwm_idx = _safe_int(pwm_hw.get("start"), 45) if pwm_hw else None

        cfg.devices.append(DeviceConfig(
            ip=ip,
            name=name or "WLED Controller",
            udp_port=_safe_int(udp_port, 21324),
            rgb_count=_safe_int(hw_ins[0].get("len"), 45) if hw_ins and len(hw_ins) > 0 else 45,
            pwm_index=pwm_idx if pwm_idx is not None else None,
            segments=segments,
            hw_ins=hw_ins if hw_ins and isinstance(hw_ins, list) else []
        ))

    if not save_app_config(cfg, config_path):
        logger.error(f"Failed to persist WLED controller update to {config_path}")
        raise PersistenceError("Failed to persist configuration to disk")
    request.app["current_app_config"] = cfg

    # Running drivers pick up the new segments now, not on the next restart
    engine = request.app.get("engine")
    if engine:
        engine.sync_drivers(cfg)

    # 2. Attempt physical WLED hardware mutation
    loop = asyncio.get_running_loop()
    readback_data = None
    hardware_applied = False
    try:
        readback_data = await loop.run_in_executor(
            None,
            WLEDDriver.apply_wled_mutations,
            ip,
            name,
            hw_ins,
            state
        )
        hardware_applied = True
    except Exception as e:
        logger.warning(f"Could not reach physical WLED hardware at {ip} (device offline): {e}")

    return web.json_response({
        "status": "ok",
        "hardware_applied": hardware_applied,
        "readback": readback_data
    })


async def handle_get_wled_preset(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    ip = request.query.get("ip", "").strip()
    preset_id = int(request.query.get("id", "1"))
    if not ip:
        cfg = load_app_config(config_path)
        dev = cfg.primary_device
        if dev:
            ip = dev.ip
    if not ip:
        raise ValidationError("No IP specified", field="ip")
    loop = asyncio.get_running_loop()
    try:
        data = await loop.run_in_executor(None, WLEDDriver.get_wled_preset, ip, preset_id)
        return web.json_response(data)
    except Exception as e:
        logger.warning(f"Error loading WLED preset from {ip}: {e}")
        raise DeviceUnreachable(f"Could not reach the WLED controller at {ip}", field="ip") from e


async def handle_get_wled_effects(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    ip = request.query.get("ip", "").strip()
    if not ip:
        cfg = load_app_config(config_path)
        dev = cfg.primary_device
        if dev:
            ip = dev.ip
    loop = asyncio.get_running_loop()
    try:
        effects = await loop.run_in_executor(None, WLEDDriver.get_wled_effects_list, ip)
        return web.json_response({"effects": effects})
    except Exception as e:
        logger.warning(f"Error fetching WLED effects from {ip}: {e}")
        raise DeviceUnreachable(f"Could not reach the WLED controller at {ip}", field="ip") from e


async def handle_save_wled_preset(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    data = await read_json(request)
    ip = data.get("ip", "").strip()
    if not ip:
        cfg = load_app_config(config_path)
        dev = cfg.primary_device
        if dev:
            ip = dev.ip
    if not ip:
        raise ValidationError("No IP specified", field="ip")

    preset_id = int(data.get("preset_id", 1))
    name = str(data.get("name", "AutoGlow Default"))
    segments = data.get("segments", [])
    bri = int(data.get("bri", 255))
    boot_default = bool(data.get("boot_default", True))

    # Defense-in-Depth Validation: verify segments integrity
    if segments and isinstance(segments, list):
        for s in segments:
            if not isinstance(s, dict):
                continue
            start = s.get("start")
            stop = s.get("stop")
            if start is not None and stop is not None:
                try:
                    if int(stop) <= int(start):
                        raise ValidationError(f"Invalid segment bounds: stop ({stop}) must be greater than start ({start})")
                except (ValueError, TypeError):
                    raise ValidationError("Segment start and stop must be valid integers")

        # Protect against saving single segment when device has multiple segments configured
        cfg = request.app.get("current_app_config") or load_app_config(config_path)
        dev = next((d for d in cfg.devices if d.ip == ip), cfg.primary_device)
        if dev and dev.segments and len(dev.segments) > len(segments):
            raise ValidationError(
                f"Segment count mismatch: device has {len(dev.segments)} segments configured, but preset only provided {len(segments)}."
            )

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(
            None,
            WLEDDriver.save_wled_preset,
            ip,
            preset_id,
            name,
            segments,
            bri,
            boot_default
        )
        return web.json_response({"status": "ok", "message": f"Preset {preset_id} saved to WLED device {ip}."})
    except Exception as e:
        logger.warning(f"Error saving WLED preset to {ip}: {e}")
        raise DeviceUnreachable(f"Could not save the preset on the WLED controller at {ip}", field="ip") from e


async def handle_preview_wled_state(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    data = await read_json(request)
    ip = data.get("ip", "").strip()
    if not ip:
        cfg = load_app_config(config_path)
        dev = cfg.primary_device
        if dev:
            ip = dev.ip
    if not ip:
        raise ValidationError("No IP specified", field="ip")

    if engine and hasattr(engine, "driver") and engine.driver.protocol_mode == ProtocolMode.ACTIVE_UDP:
        logger.info("Live preview requested while in UDP mode -> Releasing UDP stream to allow HTTP state preview...")
        await engine.set_protocol_mode(ProtocolMode.IDLE_HTTP)

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, WLEDDriver.preview_wled_state, ip, data)
        return web.json_response({"status": "ok", "message": "Live preview sent to WLED."})
    except Exception as e:
        logger.warning(f"Error sending live preview to WLED {ip}: {e}")
        raise DeviceUnreachable(f"Could not reach the WLED controller at {ip}", field="ip") from e


async def handle_wled_setup_preview(request: web.Request) -> web.Response:
    """Light tests of the setup guide: a temporary LED layout and state, nothing saved."""
    engine = request.app.get("engine")
    data = await read_json(request)
    ip = str(data.get("ip", "")).strip()
    if not ip:
        raise ValidationError("No IP specified", field="ip")
    hw_ins = data.get("hw_ins")
    if hw_ins is not None and (not isinstance(hw_ins, list) or not all(isinstance(h, dict) for h in hw_ins)):
        raise ValidationError("hw_ins must be a list of LED outputs", field="hw_ins")
    state = data.get("state")
    if state is not None and not isinstance(state, dict):
        raise ValidationError("state must be an object", field="state")

    # WLED ignores HTTP state while it receives a live UDP stream
    if engine and hasattr(engine, "driver") and engine.driver.protocol_mode == ProtocolMode.ACTIVE_UDP:
        await engine.set_protocol_mode(ProtocolMode.IDLE_HTTP)

    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, WLEDDriver.apply_setup_preview, ip, hw_ins, state)
    except Exception as e:
        logger.warning(f"Setup preview failed on WLED {ip}: {e}")
        raise DeviceUnreachable(f"Could not reach the WLED controller at {ip}", field="ip") from e
    return web.json_response({"status": "ok"})


async def handle_scan_network(request: web.Request) -> web.Response:
    devices = await DiscoveryService.scan_network()
    return web.json_response({"status": "ok", "devices": devices})


async def handle_test_effect(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    config_path = request.app.get("config_path", "config.json")
    if not engine:
        raise ServiceUnavailable("Engine not initialized")

    data = await read_json(request)
    evt_data = data.get("effect", {})
    event_key = data.get("event")
    target_ip = data.get("ip")
    segment_id = data.get("segment_id")

    cfg = request.app.get("current_app_config") or load_app_config(config_path)

    if not evt_data and event_key:
        found_effect = cfg.profile_for(target_ip, segment_id).get_effect(event_key)
        if found_effect:
            effect = EffectConfig(
                animation=found_effect.animation,
                color_primary=found_effect.color_primary,
                color_secondary=found_effect.color_secondary,
                dynamic_secondary=found_effect.dynamic_secondary,
                duration=found_effect.duration,
                speed=found_effect.speed,
                fps=found_effect.fps,
                reverse=found_effect.reverse,
                enabled=True
            )
        else:
            effect = EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 255, 0), duration=2.0, enabled=True)
    else:
        anim_str = evt_data.get("animation", "solid")
        anim_enum = AnimationType(anim_str) if anim_str in [a.value for a in AnimationType] else AnimationType.SOLID
        col = evt_data.get("color_primary") or evt_data.get("color")
        col_sec = evt_data.get("color_secondary")

        effect = EffectConfig(
            animation=anim_enum,
            color_primary=RGBColor.from_dict(col, default=RGBColor(0, 255, 0)),
            color_secondary=RGBColor.from_dict(col_sec, default=RGBColor(0, 0, 0)),
            dynamic_secondary=bool(evt_data.get("dynamic_secondary", False)),
            duration=float(evt_data.get("duration", 2.0)),
            speed=float(evt_data.get("speed", 1.0)),
            fps=int(evt_data.get("fps", 50)),
            reverse=bool(evt_data.get("reverse", False)),
            enabled=True
        )

    target_driver = engine.get_driver(target_ip) if target_ip else engine.driver
    if not target_driver:
        raise NotFound(f"No driver configured for controller {target_ip or 'primary'}.", field="ip")
    engine.lighting_test_active = True

    # Ensure UDP mode is active for live effect streaming (auto-connect if currently in HTTP idle)
    if target_driver.protocol_mode != ProtocolMode.ACTIVE_UDP:
        logger.info("Effect test requested while in HTTP mode -> Auto-connecting UDP mode...")
        await engine.set_protocol_mode(ProtocolMode.ACTIVE_UDP)

    prev_col_data = evt_data.get("previous_color") or data.get("previous_color")
    prev_color = RGBColor.from_dict(prev_col_data) if prev_col_data else None

    # If dynamic_secondary is True and no explicit previous_color was provided, resolve from channel/profile
    if effect.dynamic_secondary and not prev_color:
        ch = target_driver._segment_channels.get(segment_id or 0)
        if ch and ch.get("last_active_color"):
            prev_color = ch["last_active_color"]
        else:
            p1 = cfg.profile_for(target_ip, segment_id).get_player_slot(1)
            if p1 and p1.effect and p1.effect.color_primary and p1.effect.color_primary.to_tuple() != (0, 0, 0):
                prev_color = p1.effect.color_primary
            else:
                th = cfg.profile_for(target_ip, segment_id).get_effect("throw")
                if th and th.color_primary and th.color_primary.to_tuple() != (0, 0, 0):
                    prev_color = th.color_primary
                else:
                    gs = cfg.profile_for(target_ip, segment_id).get_effect("game_start")
                    if gs and gs.color_primary and gs.color_primary.to_tuple() != (0, 0, 0):
                        prev_color = gs.color_primary

    segments = getattr(target_driver.config, "segments", None) or []
    if segment_id is None and segments:
        # A profile's effect plays on every light segment of the controller, as it does in a game
        targets = [seg.id for seg in segments if not _is_pwm_segment(seg)]
    else:
        targets = [segment_id]
    for seg_id in targets:
        await target_driver.play_effect(effect, segment_id=seg_id, force_enable=True, previous_color=prev_color)
    return web.json_response({"status": "ok"})


async def handle_test_end(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if not engine:
        raise ServiceUnavailable("Engine not initialized")
    restored = await engine.end_lighting_test()
    return web.json_response({"status": "ok", "restored": restored})


async def handle_test_light(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if not engine:
        raise ServiceUnavailable("Engine not initialized")
    data = await read_json(request)
    try:
        bri = int(data.get("brightness", 200))
    except (TypeError, ValueError):
        raise ValidationError("Brightness must be a number", field="brightness")
    target_ip = data.get("ip")
    engine.lighting_test_active = True
    ok = await engine.set_board_light(bri, target_ip=target_ip)
    if not ok:
        logger.warning(f"set_board_light returned False for brightness {bri} on {target_ip or 'all'}")
    return web.json_response({"status": "ok", "brightness": bri, "success": ok})


async def handle_get_protocol_mode(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if not engine:
        return web.json_response({"status": "ok", "mode": "http"})
    mode = engine.driver.protocol_mode.value if hasattr(engine.driver, "protocol_mode") else "http"
    return web.json_response({"status": "ok", "mode": mode})


async def handle_post_protocol_mode(request: web.Request) -> web.Response:
    engine = request.app.get("engine")
    if not engine:
        raise ServiceUnavailable("Engine not initialized")
    data = await read_json(request)
    req_mode = str(data.get("mode", "http")).lower()
    target_mode = ProtocolMode.ACTIVE_UDP if req_mode == "udp" else ProtocolMode.IDLE_HTTP
    verified = await engine.set_protocol_mode(target_mode)
    return web.json_response({"status": "ok", "mode": target_mode.value, "verified": bool(verified)})
