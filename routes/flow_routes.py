"""
AutoGlow 2 - Game Flow Routes Module
REST API endpoints for Game Flow Simulator, visual phase planning, and custom transition testing.
"""

import asyncio
import json
import logging
from aiohttp import web
from typing import Optional

from core.game_flow import GameFlowStorageManager, GameFlow, create_default_game_flow
from core.models import EffectConfig, AnimationType, RGBColor, ProtocolMode, LightingMode
from core.animations import render_animation_frame, blend_frames

logger = logging.getLogger("autoglow.routes.flow")

flow_storage = GameFlowStorageManager()
_active_transition_task: Optional[asyncio.Task] = None


def _get_flow_storage(request: web.Request) -> GameFlowStorageManager:
    """Retrieve flow storage manager, favoring injected test instances."""
    return request.app.get("flow_storage") or flow_storage


async def handle_get_flow(request: web.Request) -> web.Response:
    """Return the active Game Flow definition, enriched with idle sleep config."""
    try:
        storage = _get_flow_storage(request)
        ip = request.query.get("ip")
        seg = request.query.get("seg")
        if ip and ip != "all":
            flow = storage.load_for_segment(ip, seg)
        else:
            flow = storage.load()
        flow_dict = flow.to_dict()

        # Enrich with idle sleep config from AppConfig
        try:
            from core.storage import load_app_config
            config_path = request.app.get("config_path") or "config.json"
            cfg = request.app.get("current_app_config") or load_app_config(config_path)
            dim_mins = getattr(cfg, "inactivity_timeout_minutes", 5)
            off_mins = getattr(cfg, "idle_power_off_minutes", 30)
            dim_bri = getattr(cfg, "idle_dimming_brightness", 50)
            dim_enabled = getattr(cfg, "inactivity_timeout_enabled", True)
            off_enabled = getattr(cfg, "idle_power_off_enabled", True)
            dim_pct = round((dim_bri / 255.0) * 100) if dim_bri > 0 else 0

            flow_dict["idle_sleep"] = {
                "inactivity_minutes": dim_mins,
                "inactivity_enabled": dim_enabled,
                "dim_brightness_raw": dim_bri,
                "dim_percent": dim_pct if dim_pct > 0 else 20,
                "standby_minutes": off_mins,
                "standby_enabled": off_enabled,
                "dim_seconds": dim_mins * 60,
                "dim_brightness": dim_bri,
                "off_seconds": off_mins * 60,
            }
        except Exception:
            flow_dict["idle_sleep"] = {
                "inactivity_minutes": 5,
                "inactivity_enabled": True,
                "dim_brightness_raw": 50,
                "dim_percent": 20,
                "standby_minutes": 30,
                "standby_enabled": True,
                "dim_seconds": 300,
                "dim_brightness": 50,
                "off_seconds": 1800,
            }

        # Enrich in-turn events with active profile settings if missing
        try:
            from core.storage import load_app_config
            config_path = request.app.get("config_path") or "config.json"
            cfg = request.app.get("current_app_config") or load_app_config(config_path)
            if "events" not in flow_dict or not isinstance(flow_dict["events"], dict):
                flow_dict["events"] = {}
            names_map = {
                "single": "Single Hit (1x)",
                "double": "Double Hit (2x)",
                "triple": "Triple Hit (3x)",
                "180": "180 (Maximum!)",
                "bullseye": "Bullseye (Bull)",
                "bust": "Bust / Miss (Bust)",
                "calibrating": "Board Calibration (Calib)"
            }
            for ev_k, ev_name in names_map.items():
                if ev_k not in flow_dict["events"] or not flow_dict["events"][ev_k]:
                    prof_eff = cfg.profile.get_effect(ev_k) if cfg and cfg.profile else None
                    if prof_eff:
                        flow_dict["events"][ev_k] = {
                            "id": ev_k,
                            "name": ev_name,
                            "trigger_key": ev_k,
                            "effect": prof_eff.to_dict()
                        }
        except Exception as e_ev:
            logger.debug(f"Could not enrich flow events: {e_ev}")

        return web.json_response({"status": "ok", "flow": flow_dict})
    except Exception as e:
        logger.exception(f"Error loading game flow: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)



async def handle_save_flow(request: web.Request) -> web.Response:
    """Save user-customized Game Flow definition."""
    try:
        data = await request.json()
        flow_data = data.get("flow", data)
        flow = GameFlow.from_dict(flow_data)

        ip = data.get("ip") or request.query.get("ip")
        seg = data.get("seg") if "seg" in data else request.query.get("seg")

        storage = _get_flow_storage(request)
        if ip and ip != "all":
            success = storage.save_for_segment(flow, ip, seg)
        else:
            success = storage.save(flow)

        # Sync any idle_sleep changes back to AppConfig
        idle_sleep = flow_data.get("idle_sleep")
        if idle_sleep and isinstance(idle_sleep, dict):
            try:
                from core.storage import load_app_config, save_app_config
                config_path = request.app.get("config_path") or "config.json"
                cfg = request.app.get("current_app_config") or load_app_config(config_path)
                if "inactivity_minutes" in idle_sleep:
                    cfg.inactivity_timeout_minutes = max(1, int(idle_sleep["inactivity_minutes"]))
                if "standby_minutes" in idle_sleep:
                    cfg.idle_power_off_minutes = max(1, int(idle_sleep["standby_minutes"]))
                if "dim_percent" in idle_sleep:
                    cfg.idle_dimming_brightness = int(min(255, max(0, round(int(idle_sleep["dim_percent"]) * 2.55))))
                elif "dim_brightness" in idle_sleep:
                    cfg.idle_dimming_brightness = int(idle_sleep["dim_brightness"])
                save_app_config(cfg, config_path)
                request.app["current_app_config"] = cfg
            except Exception as ex:
                logger.warning(f"Could not persist idle_sleep to app config: {ex}")

        # Sync flow_data.get("events") into cfg.profile.events
        flow_events = flow_data.get("events")
        if flow_events and isinstance(flow_events, dict):
            try:
                from core.storage import load_app_config, save_app_config
                config_path = request.app.get("config_path") or "config.json"
                cfg = request.app.get("current_app_config") or load_app_config(config_path)
                if cfg and cfg.profile:
                    for ev_k, ev_obj in flow_events.items():
                        if isinstance(ev_obj, dict):
                            eff_dict = ev_obj.get("effect", ev_obj)
                            if isinstance(eff_dict, dict) and "animation" in eff_dict:
                                cfg.profile.events[ev_k] = EffectConfig.from_dict(eff_dict)
                                if ev_k == "calibrating":
                                    cfg.profile.events["calibration"] = EffectConfig.from_dict(eff_dict)
                    save_app_config(cfg, config_path)
                    request.app["current_app_config"] = cfg
                    logger.info("Synchronized Game Flow in-turn event effects to active profile.")
            except Exception as ex_sync:
                logger.warning(f"Could not sync flow events to profile: {ex_sync}")

        if not success:
            return web.json_response({"status": "error", "message": "Failed to write game_flows.json"}, status=500)

        # Notify engine of updated game flow definition
        engine = request.app.get("engine")
        if engine and hasattr(engine, "reload_game_flow"):
            engine.reload_game_flow(flow)

        return web.json_response({"status": "ok", "flow": flow.to_dict()})
    except Exception as e:
        logger.exception(f"Error saving game flow: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_reset_flow(request: web.Request) -> web.Response:
    """Reset Game Flow to standard 6-phase default pipeline."""
    try:
        flow = create_default_game_flow()
        storage = _get_flow_storage(request)
        storage.save(flow)
        return web.json_response({"status": "ok", "flow": flow.to_dict()})
    except Exception as e:
        logger.exception(f"Error resetting game flow: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_play_phase(request: web.Request) -> web.Response:
    """Execute a single phase effect on the live engine and simulator."""
    engine = request.app.get("engine")
    if not engine:
        return web.json_response({"status": "error", "message": "Engine not available"}, status=500)

    try:
        data = await request.json()
        phase_id = str(data.get("phase_id", "")).lower()

        # Handle Inactivity Dimming simulation
        if phase_id == "idle_timeout":
            dim_bri = engine.app_config.idle_dimming_brightness if engine.app_config else 50
            engine.is_board_dimmed = True
            engine.current_illumination = dim_bri
            if engine.driver.protocol_mode == ProtocolMode.ACTIVE_UDP:
                await engine.driver.transition_to_http_mode(restore_preset_id=1)
                await engine._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
            else:
                await engine.driver.transition_to_http_mode(restore_preset_id=1)
            await engine.driver.set_board_light(dim_bri)
            await engine._broadcast_telemetry({"type": "power_state", "state": "dimmed"})
            return web.json_response({"status": "ok", "message": "Inactivity dimming executed (Idle Preset 1 restored)."})

        # Handle Standby Auto-Off simulation
        if phase_id == "idle_off":
            engine.is_board_off = True
            engine.is_board_dimmed = True
            engine.current_illumination = 0
            if engine.driver.protocol_mode == ProtocolMode.ACTIVE_UDP:
                await engine.driver.transition_to_http_mode()
                await engine._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
            await engine.driver.set_board_light(0)
            await engine._broadcast_telemetry({"type": "power_state", "state": "off"})
            return web.json_response({"status": "ok", "message": "Standby auto-off executed (Lights off)."})

        raw_eff = data.get("effect", {})
        effect = EffectConfig.from_dict(raw_eff)
        target_ip = data.get("ip")
        segment_id = int(data.get("segment_id", data.get("seg", 0)))

        drv = engine.get_driver(target_ip) if target_ip else engine.driver
        if drv:
            if drv.protocol_mode != ProtocolMode.ACTIVE_UDP:
                await drv.transition_to_udp_mode()
            await drv.play_effect(effect, segment_id=segment_id, force_enable=True)

        # If IDLE phase has a native WLED effect ID and physical device is configured,
        # also send HTTP mutation to WLED hardware
        if phase_id == "idle" and effect.wled_effect_id is not None:
            cfg = getattr(engine, "config", None)
            dev = getattr(cfg, "primary_device", None) if cfg else None
            ip = getattr(dev, "ip", None) if dev else (engine.driver.config.ip if engine.driver.config else None)
            if ip:
                loop = asyncio.get_running_loop()
                def _send_wled_idle():
                    try:
                        import urllib.request
                        wled_payload = json.dumps({
                            "on": True,
                            "lor": 0,
                            "seg": [{
                                "id": segment_id,
                                "fx": effect.wled_effect_id,
                                "col": [
                                    effect.color_primary.to_list(),
                                    effect.color_secondary.to_list(),
                                    [0, 0, 0]
                                ],
                                "sx": int(min(255, max(0, effect.speed * 128)))
                            }]
                        }).encode("utf-8")
                        req = urllib.request.Request(
                            f"http://{ip}/json/state",
                            data=wled_payload,
                            headers={"Content-Type": "application/json"},
                            method="POST"
                        )
                        with urllib.request.urlopen(req, timeout=0.8):
                            pass
                    except Exception as err:
                        logger.debug(f"Could not push native WLED idle state to {ip}: {err}")
                await loop.run_in_executor(None, _send_wled_idle)

        return web.json_response({"status": "ok", "effect": effect.to_dict()})
    except Exception as e:
        logger.exception(f"Error playing flow phase: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_test_transition(request: web.Request) -> web.Response:
    """
    Simulates a live transition: plays Phase A, blends smoothly into Phase B using the chosen
    transition style (crossfade, wipe, pulse, flash, curtain) over the configured duration,
    and then settles on Phase B.
    """
    global _active_transition_task
    engine = request.app.get("engine")
    if not engine:
        return web.json_response({"status": "error", "message": "Engine not available"}, status=500)

    try:
        data = await request.json()
        from_phase_id = str(data.get("from_phase_id", "")).strip()
        to_phase_id = str(data.get("to_phase_id", "")).strip()

        eff_a = EffectConfig.from_dict(data.get("effect_a", {}))
        eff_b = EffectConfig.from_dict(data.get("effect_b", {}))

        # Enforce static solid colors for visualization:
        # Load previous event's color as static and transition to next event's static color
        storage = _get_flow_storage(request)
        flow = storage.load()
        if from_phase_id:
            p_a = flow.get_phase(from_phase_id)
            if p_a and p_a.effect and p_a.effect.color_primary:
                eff_a.color_primary = p_a.effect.color_primary
            elif from_phase_id == "idle_timeout":
                eff_a.color_primary = RGBColor(245, 158, 11)
            elif from_phase_id == "idle_off":
                eff_a.color_primary = RGBColor(0, 0, 0)

        if to_phase_id:
            p_b = flow.get_phase(to_phase_id)
            if p_b and p_b.effect and p_b.effect.color_primary:
                eff_b.color_primary = p_b.effect.color_primary
            elif to_phase_id == "idle_timeout":
                eff_b.color_primary = RGBColor(245, 158, 11)
            elif to_phase_id == "idle_off":
                eff_b.color_primary = RGBColor(0, 0, 0)

        # Fallback colors if none found
        if not eff_a.color_primary:
            eff_a.color_primary = RGBColor(0, 160, 255)
        if not eff_b.color_primary:
            eff_b.color_primary = RGBColor(255, 255, 255)

        eff_a.animation = AnimationType.SOLID
        eff_a.duration = 0.0
        eff_a.enabled = True

        eff_b.animation = AnimationType.SOLID
        eff_b.duration = 0.0
        eff_b.enabled = True

        style = str(data.get("style", "crossfade")).lower()
        if style == "cut":
            style = "instant"

        duration = max(0.1, min(5.0, float(data.get("duration", 0.6))))
        accent_raw = data.get("accent_color")
        accent_rgb = tuple(accent_raw[:3]) if (isinstance(accent_raw, list) and len(accent_raw) >= 3) else None
        segment_id = int(data.get("segment_id", 0))

        if _active_transition_task and not _active_transition_task.done():
            _active_transition_task.cancel()

        if getattr(engine, "is_board_dimmed", False) or getattr(engine, "is_board_off", False):
            await engine.wake_up(ProtocolMode.ACTIVE_UDP)
        elif engine.driver.protocol_mode != ProtocolMode.ACTIVE_UDP:
            await engine.set_protocol_mode(ProtocolMode.ACTIVE_UDP)

        async def _run_transition():
            fps = 50
            dt = 1.0 / fps
            total_frames = int(duration * fps)
            driver = engine.driver
            num_leds = getattr(driver.config, "rgb_count", 45) if driver.config else 45

            # Suppress baseline & transient on segment during transition so the master broadcast loop doesn't fight frames
            if segment_id in driver._segment_channels:
                driver._segment_channels[segment_id]["baseline_effect"] = None
                driver._segment_channels[segment_id]["transient_effect"] = None

            try:
                # 1. Audition Phase A static color for a brief moment (0.4s)
                for f in range(int(0.4 * fps)):
                    buf_a = render_animation_frame(eff_a, f, f * dt, num_leds)
                    driver.send_raw_frame(bytes(buf_a))
                    await asyncio.sleep(dt)

                # 2. Run the custom transition blend
                for step in range(total_frames):
                    factor = (step + 1) / float(total_frames)
                    elapsed = 0.4 + step * dt
                    buf_a = render_animation_frame(eff_a, step, elapsed, num_leds)
                    buf_b = render_animation_frame(eff_b, step, step * dt, num_leds)
                    blended = blend_frames(buf_a, buf_b, factor, transition_type=style, accent_rgb=accent_rgb)
                    driver.send_raw_frame(bytes(blended))
                    await asyncio.sleep(dt)

                # 3. Settle on Phase B static color for a brief moment (0.8s)
                for f in range(int(0.8 * fps)):
                    elapsed = f * dt
                    buf_b = render_animation_frame(eff_b, f, elapsed, num_leds)
                    driver.send_raw_frame(bytes(buf_b))
                    await asyncio.sleep(dt)
            except asyncio.CancelledError:
                pass
            finally:
                # Restore normal driver channel state
                try:
                    await driver.play_effect(eff_b, segment_id=segment_id, force_enable=True)
                except Exception:
                    pass

        _active_transition_task = asyncio.create_task(_run_transition())
        return web.json_response({
            "status": "ok",
            "style": style,
            "duration": duration,
            "message": "Transition test started"
        })
    except Exception as e:
        logger.exception(f"Error running transition test: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_get_lighting_mode(request: web.Request) -> web.Response:
    """Return the current active lighting mode (matrix or flow)."""
    engine = request.app.get("engine")
    mode = "matrix"
    if engine and hasattr(engine, "app_config") and hasattr(engine.app_config, "lighting_mode"):
        mode = engine.app_config.lighting_mode.value if isinstance(engine.app_config.lighting_mode, LightingMode) else str(engine.app_config.lighting_mode)
    return web.json_response({"status": "ok", "mode": mode})


async def handle_set_lighting_mode(request: web.Request) -> web.Response:
    """Switch the active lighting mode between Classic Event Matrix and Flow Matrix."""
    try:
        data = await request.json()
        mode_str = str(data.get("mode", "matrix")).strip().lower()
        mode = LightingMode.FLOW if mode_str == "flow" else LightingMode.MATRIX

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

        # Broadcast mode change to UI subscribers
        if engine and hasattr(engine, "_broadcast_telemetry"):
            await engine._broadcast_telemetry({
                "type": "lighting_mode_changed",
                "mode": mode.value
            })

        logger.info(f"Lighting mode changed to '{mode.value}' and persisted.")
        return web.json_response({"status": "ok", "mode": mode.value})
    except Exception as e:
        logger.exception(f"Error setting lighting mode: {e}")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


def register_flow_routes(app: web.Application) -> None:
    """Register all flow planner routes with the aiohttp application."""
    app.router.add_get("/api/flow/current", handle_get_flow)
    app.router.add_post("/api/flow/save", handle_save_flow)
    app.router.add_post("/api/flow/reset", handle_reset_flow)
    app.router.add_post("/api/flow/play_phase", handle_play_phase)
    app.router.add_post("/api/flow/test_transition", handle_test_transition)
    app.router.add_get("/api/flow/mode", handle_get_lighting_mode)
    app.router.add_post("/api/flow/mode", handle_set_lighting_mode)
