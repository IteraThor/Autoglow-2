"""
AutoGlow 2 - Unified Async Engine & Event Coordinator
Coordinates Autodarts event ingestion, idle power management timers,
profile-driven lighting effects, and real-time UI telemetry dispatching.
"""

import asyncio
import logging
import time
from typing import Optional, Set, Callable, Awaitable, Dict, Any

from core.models import (
    AppConfig, DeviceConfig, ProfileConfig, DartEvent, DartEventType, EffectConfig, ProtocolMode, LightingMode,
    AnimationType
)
from core.wled_driver import WLEDDriver
from core.autodarts_client import AutodartsClient
from core.game_flow import GameFlowStorageManager, GameFlow, create_default_game_flow

logger = logging.getLogger("autoglow.engine")


def _seg_attr(seg: Any, name: str, default: Any = None) -> Any:
    """Read a segment field from either a SegmentConfig or a raw dict."""
    if isinstance(seg, dict):
        return seg.get(name, default)
    return getattr(seg, name, default)


def _seg_id(seg: Any) -> int:
    try:
        return int(_seg_attr(seg, "id", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _is_pwm_segment(seg: Any) -> bool:
    """PWM white spotlight segments are driven by brightness, not by RGB flow effects."""
    seg_type = (_seg_attr(seg, "type", "") or "").lower()
    seg_name = (_seg_attr(seg, "name", "") or "").lower()
    return "pwm" in seg_type or "white" in seg_type or "pwm" in seg_name


class AutoGlowEngine:
    """
    Central unified async coordinator.
    Manages the Protocol Exclusivity FSM (UDP vs HTTP), Autodarts event dispatching,
    and power management timers.
    """

    def __init__(
        self,
        device_config: DeviceConfig,
        profile_config: Optional[ProfileConfig] = None,
        autodarts_client: Optional[AutodartsClient] = None,
        app_config: Optional[AppConfig] = None
    ):
        self.device_config = device_config
        self.profile = profile_config or ProfileConfig.get_default_profile()
        self.app_config = app_config or AppConfig(devices=[device_config] if (device_config and device_config.ip) else [], profile=self.profile)
        self.autodarts = autodarts_client

        # Dedicated WLEDDriver instances per device IP
        self.drivers: Dict[str, WLEDDriver] = {}
        self._frame_tap_callback: Optional[Callable[[bytes], None]] = None
        self.sync_drivers(self.app_config)

        if self.autodarts:
            self.autodarts.on_event = self.process_event

        # Idle & Activity state
        self.last_activity_time = time.time()
        self.is_board_dimmed = False
        self.is_board_off = False
        self.current_illumination = self.device_config.default_pwm_brightness if self.device_config else 200
        self.last_event_name: str = "Standby"
        self.previous_event_name: str = "—"

        # Background tasks
        self._running = False
        self._idle_task: Optional[asyncio.Task] = None
        self._game_start_end_time: float = 0.0
        self._game_start_task: Optional[asyncio.Task] = None
        self._match_end_task: Optional[asyncio.Task] = None
        self._telemetry_subscribers: Set[Callable[[Dict[str, Any]], Awaitable[None]]] = set()
        self._pending_throw_event: Optional[DartEvent] = None
        # Set when the Lighting page plays a test effect, so leaving the page can restore idle
        self.lighting_test_active = False

        # Flow Matrix (Game Flow) state
        self.game_flow_storage = GameFlowStorageManager()
        try:
            self.game_flow: GameFlow = self.game_flow_storage.load()
        except Exception:
            self.game_flow = create_default_game_flow()
        self.flow_active_phase: str = "idle"
        self.flow_active_player_idx: int = 0
        self._flow_advance_task: Optional[asyncio.Task] = None

    @property
    def driver(self) -> WLEDDriver:
        """Backward-compatible access to primary device driver."""
        primary_ip = self.device_config.ip if self.device_config else ""
        if primary_ip and primary_ip in self.drivers:
            return self.drivers[primary_ip]
        if self.drivers:
            return next(iter(self.drivers.values()))
        fallback = WLEDDriver(self.device_config or DeviceConfig(ip=""))
        if self.device_config and self.device_config.ip:
            self.drivers[self.device_config.ip] = fallback
        return fallback

    def get_driver(self, ip: Optional[str]) -> Optional[WLEDDriver]:
        """Get or initialize driver for a specific device IP."""
        if not ip:
            return self.driver
        clean_ip = ip.strip()
        if clean_ip in self.drivers:
            return self.drivers[clean_ip]
        dev = next((d for d in self.app_config.devices if d.ip == clean_ip), None)
        if dev:
            drv = WLEDDriver(dev)
            self.drivers[clean_ip] = drv
            return drv
        return None

    def _profile_for(self, ip: str, seg_id: Optional[int] = None) -> ProfileConfig:
        """Profile a segment uses; controllers without their own choice use the engine-wide profile."""
        cfg = self.app_config
        if not cfg:
            return self.profile
        name = cfg.profile_name_for(ip, seg_id)
        if name == cfg.active_profile:
            return self.profile
        return cfg.get_profile(name) or self.profile

    def _active_devices(self) -> list:
        """Enabled devices with an IP, falling back to the primary device config."""
        devices = self.app_config.devices if (self.app_config and self.app_config.devices) else ([self.device_config] if self.device_config else [])
        return [d for d in devices if d and d.enabled and d.ip]

    def set_frame_tap_callback(self, callback: Optional[Callable[[bytes], None]]) -> None:
        """Propagate frame tap callback across all active and future drivers."""
        self._frame_tap_callback = callback
        for drv in self.drivers.values():
            drv.set_frame_tap_callback(callback)

    def sync_drivers(self, app_config: AppConfig) -> None:
        """Synchronize the driver pool with current configured devices."""
        self.app_config = app_config
        active_ips = set()
        for dev in app_config.devices:
            if dev.enabled and dev.ip and dev.ip.strip():
                clean_ip = dev.ip.strip()
                active_ips.add(clean_ip)
                if clean_ip in self.drivers:
                    self.drivers[clean_ip].config = dev
                else:
                    drv = WLEDDriver(dev)
                    if self._frame_tap_callback:
                        drv.set_frame_tap_callback(self._frame_tap_callback)
                    self.drivers[clean_ip] = drv

        if self.device_config and self.device_config.enabled and self.device_config.ip and self.device_config.ip.strip() not in self.drivers:
            drv = WLEDDriver(self.device_config)
            if self._frame_tap_callback:
                drv.set_frame_tap_callback(self._frame_tap_callback)
            self.drivers[self.device_config.ip.strip()] = drv
            active_ips.add(self.device_config.ip.strip())

        for ip in list(self.drivers.keys()):
            if ip not in active_ips:
                self.drivers[ip].close()
                del self.drivers[ip]

    def set_lighting_mode(self, mode: Any) -> None:
        """Switch active lighting mode between MATRIX and FLOW."""
        if isinstance(mode, str):
            mode = LightingMode.FLOW if mode.lower() == "flow" else LightingMode.MATRIX
        if self.app_config.lighting_mode != mode:
            # Clean up pending transition tasks from previous mode
            if self._flow_advance_task and not self._flow_advance_task.done():
                self._flow_advance_task.cancel()
                self._flow_advance_task = None
            if self._game_start_task and not self._game_start_task.done():
                self._game_start_task.cancel()
                self._game_start_task = None
            self._game_start_end_time = 0.0
            self._pending_throw_event = None

        self.app_config.lighting_mode = mode
        logger.info(f"AutoGlow Engine active lighting mode set to: {mode.value}")

    def _is_flow_mode(self) -> bool:
        """True while the Flow Matrix (not the Event Matrix) decides what plays."""
        return bool(self.app_config) and self.app_config.lighting_mode == LightingMode.FLOW

    def reload_game_flow(self, flow: Optional[GameFlow] = None) -> None:
        """Reload Game Flow from disk or apply in-memory instance."""
        if flow:
            self.game_flow = flow
        else:
            try:
                self.game_flow = self.game_flow_storage.load()
            except Exception as e:
                logger.warning(f"Failed to reload game flow from disk: {e}")
        logger.info("AutoGlow Engine synchronized with current Game Flow definition.")

    # -------------------------------------------------------------------------
    # Public Lifecycle & Protocol Mode Controls
    # -------------------------------------------------------------------------
    async def start(self) -> None:
        """Start engine, verify WLED configuration, initialize lights, start listeners."""
        if self._running:
            return
        self._running = True
        logger.info("Starting AutoGlow Unified Async Engine...")

        # 1. Ensure WLED configuration (mso: false) across all drivers
        for drv in self.drivers.values():
            await drv.ensure_wled_config()

        # 2. Set default board illumination via HTTP across all drivers
        for drv in self.drivers.values():
            await drv.set_board_light(drv.config.default_pwm_brightness)
        self.current_illumination = self.device_config.default_pwm_brightness if self.device_config else 200

        # 3. Start idle monitoring task
        self._idle_task = asyncio.create_task(self._idle_monitor_loop())

        # 4. Start Autodarts client if present
        if self.autodarts:
            await self.autodarts.start()

        logger.info("AutoGlow Engine is running and ready for game events.")

    async def stop(self) -> None:
        """Gracefully stop all streaming, timers, and client connections."""
        self._running = False
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
            try:
                await self._idle_task
            except asyncio.CancelledError:
                pass
            self._idle_task = None

        for task in (self._match_end_task, self._game_start_task, self._flow_advance_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._match_end_task = None
        self._game_start_task = None
        self._flow_advance_task = None

        if self.autodarts:
            await self.autodarts.stop()

        for drv in self.drivers.values():
            await drv.transition_to_http_mode()
            drv.close()
        logger.info("AutoGlow Engine stopped.")

    async def set_protocol_mode(self, mode: ProtocolMode) -> bool:
        """Explicitly switch between ACTIVE_UDP and IDLE_HTTP mode across all drivers."""
        all_ok = True
        if mode == ProtocolMode.ACTIVE_UDP:
            spotlight_bri = self.app_config.game_mode_spotlight_brightness if self.app_config else 255
            for drv in self.drivers.values():
                ok = await drv.transition_to_udp_mode(spotlight_bri)
                if not ok:
                    all_ok = False
            await self._broadcast_telemetry({"type": "protocol_state", "mode": "udp"})
        else:
            for drv in self.drivers.values():
                ok = await drv.transition_to_http_mode()
                if not ok:
                    all_ok = False
            await self._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
        return all_ok

    async def set_board_light(self, brightness: int, target_ip: Optional[str] = None) -> bool:
        """Set board spotlight brightness across all or a specific driver."""
        self.current_illumination = max(0, min(255, brightness))
        if target_ip:
            drv = self.get_driver(target_ip)
            if drv:
                return await drv.set_board_light(brightness, target_ip=target_ip)
            return False
        all_ok = True
        for drv in self.drivers.values():
            ok = await drv.set_board_light(brightness)
            if not ok:
                all_ok = False
        return all_ok

    async def wake_up(self, mode: ProtocolMode = ProtocolMode.IDLE_HTTP) -> bool:
        """
        Wake up board illumination from Dimmed or Power-Off state:
        1. If board was off (or in standby), turn physical WLED controllers ON via HTTP JSON API.
        2. Reset is_board_off and is_board_dimmed flags.
        3. If mode == ProtocolMode.ACTIVE_UDP: engage Active UDP mode and set spotlight brightness.
           If mode == ProtocolMode.IDLE_HTTP: restore Idle Preset 1 via HTTP mode.
        4. Reset activity timer (last_activity_time).
        5. Broadcast active power and protocol telemetry to UI subscribers.
        """
        self.last_activity_time = time.time()
        was_off = self.is_board_off
        self.is_board_off = False
        self.is_board_dimmed = False

        # 1. Turn on physical hardware controllers if powered off
        ips = [d.ip for d in self._active_devices()]
        if was_off:
            loop = asyncio.get_running_loop()
            for ip in ips:
                try:
                    payload = {"on": True, "lor": 0}
                    if mode == ProtocolMode.IDLE_HTTP:
                        payload["ps"] = 1
                    await loop.run_in_executor(None, WLEDDriver.preview_wled_state, ip, payload)
                except Exception:
                    logger.exception(f"Error waking up WLED controller {ip}")

        # 2. Engage target protocol mode
        if mode == ProtocolMode.ACTIVE_UDP:
            logger.info("Waking up board illumination and restoring Active UDP mode...")
            spotlight_bri = self.app_config.game_mode_spotlight_brightness if self.app_config else 255
            self.current_illumination = spotlight_bri
            for drv in self.drivers.values():
                await drv.transition_to_udp_mode(spotlight_bri)
            await self._broadcast_telemetry({"type": "protocol_state", "mode": "udp"})
            await self._broadcast_telemetry({"type": "power_state", "state": "active"})
        else:
            logger.info("Waking up board illumination and restoring Idle Preset 1 (IDLE_HTTP mode)...")
            self.current_illumination = self.app_config.global_brightness if self.app_config else 200
            for drv in self.drivers.values():
                await drv.transition_to_http_mode(restore_preset_id=1)
                await drv.set_board_light(self.current_illumination)
            await self._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
            await self._broadcast_telemetry({"type": "power_state", "state": "on"})
        return True

    async def end_lighting_test(self) -> bool:
        """Return the lights to idle after Lighting-page testing; never interrupts a running match."""
        if not self.lighting_test_active:
            return False
        self.lighting_test_active = False
        if self.autodarts and getattr(self.autodarts, "_active_match_id", None):
            return False
        logger.info("Lighting test ended -> restoring idle")
        if self.is_board_off or self.is_board_dimmed:
            for drv in self.drivers.values():
                await drv.transition_to_http_mode(restore_preset_id=1)
            await self._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
            return True
        return await self.wake_up(mode=ProtocolMode.IDLE_HTTP)

    def _get_max_effect_duration(self, event_key: str) -> float:
        """Calculate the maximum configured duration for a given event across enabled devices and segments."""
        if self._is_flow_mode():
            max_flow_dur = 0.0
            p = self.game_flow.get_phase(event_key)
            if p and p.effect and p.effect.enabled and p.effect.duration > 0:
                max_flow_dur = max(max_flow_dur, p.effect.duration)
            ev = self.game_flow.events.get(event_key)
            if ev and ev.effect and ev.effect.enabled and ev.effect.duration > 0:
                max_flow_dur = max(max_flow_dur, ev.effect.duration)

            for dev in self._active_devices():
                for seg in dev.segments or []:
                    if _is_pwm_segment(seg):
                        continue
                    seg_flow = self.game_flow_storage.get_for_segment(dev.ip, _seg_id(seg))
                    sp = seg_flow.get_phase(event_key)
                    if sp and sp.effect and sp.effect.enabled and sp.effect.duration > 0:
                        max_flow_dur = max(max_flow_dur, sp.effect.duration)
                    sev = seg_flow.events.get(event_key)
                    if sev and sev.effect and sev.effect.enabled and sev.effect.duration > 0:
                        max_flow_dur = max(max_flow_dur, sev.effect.duration)

            if max_flow_dur == 0.0 and event_key == "game_start":
                max_flow_dur = 2.5
            return max_flow_dur

        max_dur = 0.0
        for dev in self._active_devices():
            for seg_id in ([_seg_id(seg) for seg in dev.segments if not _is_pwm_segment(seg)] if dev.segments else [None]):
                eff = self._profile_for(dev.ip, seg_id).get_effect(event_key)
                if eff and eff.enabled and eff.duration > 0:
                    max_dur = max(max_dur, eff.duration)

        if max_dur == 0.0 and not self._active_devices():
            fallback_eff = self.profile.get_effect(event_key)
            if fallback_eff and fallback_eff.enabled and fallback_eff.duration > 0:
                max_dur = fallback_eff.duration
        return max_dur

    async def _await_game_start_transition(self, duration: float) -> None:
        try:
            await asyncio.sleep(duration)
            self._game_start_end_time = 0.0
            if self._pending_throw_event:
                pending = self._pending_throw_event
                self._pending_throw_event = None
                logger.info("Game Started intro animation finished -> transitioning to active player throw color")
                await self.process_event(pending)
        except asyncio.CancelledError:
            pass

    async def _await_match_end_teardown(self, duration: float) -> None:
        try:
            await asyncio.sleep(duration)
            logger.info(f"Match end celebration finished ({duration:.1f}s) -> releasing UDP mode and restoring Idle Preset 1")
            await self.set_protocol_mode(ProtocolMode.IDLE_HTTP)
        except asyncio.CancelledError:
            pass

    # -------------------------------------------------------------------------
    # Event Processing & Dispatch
    # -------------------------------------------------------------------------
    async def process_event(self, event: DartEvent) -> None:
        """
        Handle a game event:
        1. Wake up board from Dimmed/Off state on ANY active game event.
        2. Reset activity timer.
        3. Trigger WLED driver effect animation on target device drivers.
        4. Broadcast telemetry to subscribers.
        """
        self.last_activity_time = time.time()
        event_key = event.event_type.value
        logger.info(f"AutoGlow Engine processing event: '{event_key}' (player='{event.player_name}', score={event.score}, seg='{event.segment_name}')")

        # Game Started duration gating
        if event.event_type == DartEventType.GAME_START:
            if self._game_start_task and not self._game_start_task.done():
                self._game_start_task.cancel()
            if self._flow_advance_task and not self._flow_advance_task.done():
                self._flow_advance_task.cancel()
            if self._match_end_task and not self._match_end_task.done():
                self._match_end_task.cancel()
                self._match_end_task = None
            self._pending_throw_event = None

            max_game_start_dur = self._get_max_effect_duration("game_start")

            if max_game_start_dur > 0.0:
                self._game_start_end_time = time.time() + max_game_start_dur
                if not self._is_flow_mode():
                    self._game_start_task = asyncio.create_task(self._await_game_start_transition(max_game_start_dur))
            else:
                self._game_start_end_time = 0.0
        elif event.event_type in [
            DartEventType.SINGLE, DartEventType.DOUBLE, DartEventType.TRIPLE,
            DartEventType.BULLSEYE, DartEventType.BUST, DartEventType.SCORE_180,
            DartEventType.TAKEOUT, DartEventType.TAKEOUT_IN_PROGRESS,
            DartEventType.LEG_WON, DartEventType.MATCH_WON, DartEventType.GAME_IDLE
        ]:
            if self._game_start_task and not self._game_start_task.done():
                self._game_start_task.cancel()
            if self._flow_advance_task and not self._flow_advance_task.done():
                self._flow_advance_task.cancel()
            self._game_start_end_time = 0.0
            self._pending_throw_event = None

        if event.event_type == DartEventType.THROW and time.time() < self._game_start_end_time:
            remaining = self._game_start_end_time - time.time()
            logger.info(f"Game Started intro animation playing ({remaining:.1f}s remaining) -> queued player throw color")
            self._pending_throw_event = event
            await self._broadcast_telemetry({
                "type": "game_event",
                "event": event_key,
                "player_name": event.player_name,
                "player_index": event.player_index,
                "score": event.score,
                "multiplier": event.multiplier,
                "segment": event.segment_name or ""
            })
            return

        # Check if this event is match ending or abort teardown
        is_match_end = event.event_type in [DartEventType.MATCH_WON, DartEventType.GAME_FINISH]
        is_game_idle = event.event_type == DartEventType.GAME_IDLE
        is_teardown_enabled = bool(self.app_config and self.app_config.disconnect_udp_on_match_end)

        max_match_won_dur = 0.0
        if is_match_end and is_teardown_enabled:
            max_match_won_dur = self._get_max_effect_duration("match_won")

        # Wake up board from Inactivity Dimming or Standby Power-Off on active game events
        # (Skip wake-up if game_idle or if match_won with 0 duration and disconnect_udp_on_match_end is True)
        skip_wake = is_game_idle or (is_match_end and is_teardown_enabled and max_match_won_dur <= 0.0)

        if not skip_wake:
            if self.autodarts and getattr(self.autodarts, "_active_match_id", None) is None:
                # Autodarts client attached, but no active match in progress
                is_active_game = (
                    event.event_type == DartEventType.GAME_START
                    or event.event_type in [
                        DartEventType.SINGLE, DartEventType.DOUBLE, DartEventType.TRIPLE,
                        DartEventType.BULLSEYE, DartEventType.SCORE_180, DartEventType.BUST
                    ]
                )
            else:
                # Standalone mode OR active match in progress
                is_active_game = event.event_type not in [
                    DartEventType.CALIBRATING, DartEventType.MANUAL_RESET, DartEventType.GAME_IDLE
                ]

            if is_active_game:
                needs_udp_wake = (
                    self.is_board_off
                    or self.is_board_dimmed
                    or any(drv.protocol_mode != ProtocolMode.ACTIVE_UDP for drv in self.drivers.values())
                )
                if needs_udp_wake:
                    await self.wake_up(mode=ProtocolMode.ACTIVE_UDP)
            else:
                # Non-game events (camera calibration, idle reset) only wake to IDLE_HTTP if powered off
                if self.is_board_off or self.is_board_dimmed:
                    await self.wake_up(mode=ProtocolMode.IDLE_HTTP)

        # Handle Match Ending / Abortion teardown if configured
        if is_game_idle:
            if self._match_end_task and not self._match_end_task.done():
                self._match_end_task.cancel()
                self._match_end_task = None
            if is_teardown_enabled:
                logger.info("Match aborted / game idle -> releasing UDP mode and restoring Idle Preset 1 (disconnect_udp_on_match_end is True)")
                await self.set_protocol_mode(ProtocolMode.IDLE_HTTP)

        elif is_match_end:
            if self._match_end_task and not self._match_end_task.done():
                self._match_end_task.cancel()
                self._match_end_task = None
            if is_teardown_enabled:
                if max_match_won_dur > 0.0:
                    logger.info(f"Match won celebration scheduled ({max_match_won_dur:.1f}s) -> will disconnect UDP after effect")
                    self._match_end_task = asyncio.create_task(self._await_match_end_teardown(max_match_won_dur))
                else:
                    logger.info("Match won -> releasing UDP mode and restoring Idle Preset 1 immediately")
                    await self.set_protocol_mode(ProtocolMode.IDLE_HTTP)

        # Lookup effect binding and dispatch across all configured devices and segments
        new_event_name = f"{event_key} ; {event.segment_name}" if event.segment_name else event_key
        if self.last_event_name and self.last_event_name != "Standby":
            self.previous_event_name = self.last_event_name
        self.last_event_name = new_event_name

        dispatched_any = False

        match_players = getattr(self.autodarts, "current_players", []) if self.autodarts else []

        if self._is_flow_mode():
            await self._dispatch_flow_event(event)
            dispatched_any = True
        else:
            for dev in self._active_devices():
                drv = self.get_driver(dev.ip)
                if not drv:
                    continue

                # Each segment plays the effect of the profile it is assigned
                for seg_id in ([_seg_id(seg) for seg in dev.segments if not _is_pwm_segment(seg)] if dev.segments else [None]):
                    profile = self._profile_for(dev.ip, seg_id)
                    if event.event_type == DartEventType.THROW:
                        eff = profile.resolve_player_effect(
                            player_name=event.player_name,
                            player_index=event.player_index,
                            match_players=match_players,
                        )
                    else:
                        eff = profile.get_effect(event_key)
                    if not (eff and eff.enabled):
                        continue
                    where = f"Segment #{seg_id}" if seg_id is not None else "all segments"
                    logger.info(f"Dispatching effect '{eff.animation.value}' on {dev.name} ({dev.ip}) {where} for '{self.last_event_name}'")
                    if seg_id is None:
                        await drv.play_effect(eff)
                    else:
                        await drv.play_effect(eff, segment_id=seg_id)
                    dispatched_any = True

            if not dispatched_any and not self._active_devices():
                # No controller configured: fall back to the active profile across all drivers
                fallback_eff = self.profile.resolve_player_effect(
                    player_name=event.player_name,
                    player_index=event.player_index,
                    match_players=match_players
                ) if event.event_type == DartEventType.THROW else self.profile.get_effect(event_key)
                if fallback_eff and fallback_eff.enabled:
                    logger.info(f"Dispatching global effect '{fallback_eff.animation.value}' for '{self.last_event_name}'")
                    for drv in self.drivers.values():
                        await drv.play_effect(fallback_eff)

        # Notify UI telemetry subscribers
        await self._broadcast_telemetry({
            "type": "game_event",
            "event": event_key,
            "display_event": self.last_event_name,
            "previous_event": self.previous_event_name,
            "segment_name": event.segment_name or "",
            "score": event.score,
            "multiplier": event.multiplier,
            "timestamp": time.time(),
            "players": getattr(self.autodarts, "current_players", []) if self.autodarts else [],
            "active_player_idx": getattr(self.autodarts, "active_player_idx", 0) if self.autodarts else 0,
            "lighting_mode": self.app_config.lighting_mode.value,
            "flow_phase": self.flow_active_phase
        })

    def _resolve_flow_effect(self, flow: GameFlow, event: DartEvent) -> Optional[EffectConfig]:
        """Resolve the target effect from a GameFlow for a given dart event."""
        if event.event_type == DartEventType.GAME_START:
            p = flow.get_phase("game_start")
            if p and p.effect and p.effect.enabled:
                return p.effect
            return EffectConfig(duration=2.5, animation=p.effect.animation if p and p.effect else AnimationType.SOLID)

        if event.event_type == DartEventType.THROW:
            p_idx = event.player_index if event.player_index is not None else 0
            target_phase_id = "turn_p1" if p_idx == 0 else "turn_p2"
            p = flow.get_phase(target_phase_id)
            if p and p.effect and p.effect.enabled:
                return EffectConfig(
                    animation=p.effect.animation,
                    color_primary=p.effect.color_primary,
                    color_secondary=p.effect.color_secondary,
                    duration=0.0,
                    speed=p.effect.speed,
                    enabled=True
                )
            return None

        key_map = {
            DartEventType.SINGLE: "single",
            DartEventType.DOUBLE: "double",
            DartEventType.TRIPLE: "triple",
            DartEventType.SCORE_180: "180",
            DartEventType.BULLSEYE: "bullseye",
            DartEventType.BUST: "bust",
            DartEventType.CALIBRATING: "calibrating"
        }
        if event.event_type in key_map:
            ev_k = key_map[event.event_type]
            ev_phase = flow.events.get(ev_k)
            if ev_phase and ev_phase.effect and ev_phase.effect.enabled:
                return ev_phase.effect
            def_flow = create_default_game_flow()
            def_ev = def_flow.events.get(ev_k)
            if def_ev and def_ev.effect:
                return def_ev.effect
            return None

        if event.event_type in [DartEventType.TAKEOUT, DartEventType.TAKEOUT_IN_PROGRESS]:
            p = flow.get_phase("takeout")
            return p.effect if (p and p.effect and p.effect.enabled) else None

        if event.event_type == DartEventType.LEG_WON:
            p = flow.get_phase("leg_won")
            return p.effect if (p and p.effect and p.effect.enabled) else None

        if event.event_type in [DartEventType.MATCH_WON, DartEventType.GAME_FINISH]:
            p = flow.get_phase("match_won")
            return p.effect if (p and p.effect and p.effect.enabled) else None

        if event.event_type in [DartEventType.GAME_IDLE, DartEventType.MANUAL_RESET]:
            p = flow.get_phase("idle")
            return p.effect if (p and p.effect and p.effect.enabled) else None

        return None

    async def _dispatch_flow_event(self, event: DartEvent) -> None:
        """Dispatch match events according to the active Game Flow state machine (Flow Matrix mode)."""
        event_key = event.event_type.value
        logger.info(f"AutoGlow Engine [FLOW MATRIX] handling event '{event_key}'")

        if event.event_type == DartEventType.GAME_START:
            self.flow_active_phase = "game_start"
            dur = self._get_max_effect_duration("game_start")
            if self._flow_advance_task and not self._flow_advance_task.done():
                self._flow_advance_task.cancel()
            self._flow_advance_task = asyncio.create_task(self._flow_auto_advance("turn_p1", dur))

        elif event.event_type == DartEventType.THROW:
            p_idx = event.player_index if event.player_index is not None else 0
            self.flow_active_player_idx = p_idx
            self.flow_active_phase = "turn_p1" if p_idx == 0 else "turn_p2"

        elif event.event_type in [DartEventType.TAKEOUT, DartEventType.TAKEOUT_IN_PROGRESS]:
            self.flow_active_phase = "takeout"
        elif event.event_type == DartEventType.LEG_WON:
            self.flow_active_phase = "leg_won"
        elif event.event_type in [DartEventType.MATCH_WON, DartEventType.GAME_FINISH]:
            self.flow_active_phase = "match_won"
        elif event.event_type in [DartEventType.GAME_IDLE, DartEventType.MANUAL_RESET]:
            self.flow_active_phase = "idle"

        for dev in self._active_devices():
            drv = self.get_driver(dev.ip)
            if not drv:
                continue

            if dev.segments:
                for seg in dev.segments:
                    if _is_pwm_segment(seg):
                        continue
                    seg_id = _seg_id(seg)
                    seg_flow = self.game_flow_storage.get_for_segment(dev.ip, seg_id)
                    target_eff = self._resolve_flow_effect(seg_flow, event)
                    if target_eff:
                        await drv.play_effect(target_eff, segment_id=seg_id, force_enable=True)
            else:
                seg_flow = self.game_flow_storage.get_for_segment(dev.ip, None)
                target_eff = self._resolve_flow_effect(seg_flow, event)
                if target_eff:
                    await drv.play_effect(target_eff, force_enable=True)

    async def _flow_auto_advance(self, target_phase_id: str, delay: float) -> None:
        """Asynchronously advance the Flow Matrix state machine after an intro or celebration completes."""
        try:
            await asyncio.sleep(delay)
            if not self._is_flow_mode():
                return
            self.flow_active_phase = target_phase_id

            for dev in self._active_devices():
                drv = self.get_driver(dev.ip)
                if not drv:
                    continue

                if dev.segments:
                    for seg in dev.segments:
                        if _is_pwm_segment(seg):
                            continue
                        seg_id = _seg_id(seg)
                        seg_flow = self.game_flow_storage.get_for_segment(dev.ip, seg_id)
                        p = seg_flow.get_phase(target_phase_id)
                        if p and p.effect and p.effect.enabled:
                            baseline_eff = EffectConfig(
                                animation=p.effect.animation,
                                color_primary=p.effect.color_primary,
                                color_secondary=p.effect.color_secondary,
                                duration=0.0,
                                speed=p.effect.speed,
                                enabled=True
                            )
                            await drv.play_effect(baseline_eff, segment_id=seg_id, force_enable=True)
                else:
                    seg_flow = self.game_flow_storage.get_for_segment(dev.ip, None)
                    p = seg_flow.get_phase(target_phase_id)
                    if p and p.effect and p.effect.enabled:
                        baseline_eff = EffectConfig(
                            animation=p.effect.animation,
                            color_primary=p.effect.color_primary,
                            color_secondary=p.effect.color_secondary,
                            duration=0.0,
                            speed=p.effect.speed,
                            enabled=True
                        )
                        await drv.play_effect(baseline_eff, force_enable=True)

            await self._broadcast_telemetry({
                "type": "game_flow_state",
                "phase": self.flow_active_phase,
                "lighting_mode": self.app_config.lighting_mode.value
            })

            self._game_start_end_time = 0.0
            if self._pending_throw_event:
                pending = self._pending_throw_event
                self._pending_throw_event = None
                logger.info("Flow Matrix intro animation finished -> processing queued throw event")
                await self.process_event(pending)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.exception(f"Error in _flow_auto_advance: {e}")

    # -------------------------------------------------------------------------
    # Idle & Power Management Loop
    # -------------------------------------------------------------------------
    async def _power_off_all(self) -> None:
        """Release UDP, darken the spotlight and switch every enabled controller off."""
        self.is_board_off = True
        self.is_board_dimmed = True
        self.current_illumination = 0
        for drv in self.drivers.values():
            if drv.protocol_mode == ProtocolMode.ACTIVE_UDP:
                await drv.transition_to_http_mode()
            await drv.set_board_light(0)
        await self._broadcast_telemetry({"type": "protocol_state", "mode": "http"})

        loop = asyncio.get_running_loop()
        for dev in self._active_devices():
            try:
                await loop.run_in_executor(None, WLEDDriver.preview_wled_state, dev.ip, {"on": False})
            except Exception:
                logger.exception(f"Error turning off WLED controller {dev.ip}")

        await self._broadcast_telemetry({"type": "power_state", "state": "off"})

    async def _idle_monitor_loop(self):
        while self._running:
            try:
                await asyncio.sleep(2.0)
                if not self._running:
                    break

                idle_duration = time.time() - self.last_activity_time
                dim_enabled = self.app_config.inactivity_timeout_enabled if self.app_config else True
                off_enabled = self.app_config.idle_power_off_enabled if self.app_config else True
                dim_limit = (self.app_config.inactivity_timeout_minutes if self.app_config else 5) * 60
                off_limit = (self.app_config.idle_power_off_minutes if self.app_config else 30) * 60

                # Check Standby OFF (e.g. 30 min)
                if off_enabled and idle_duration >= off_limit and not self.is_board_off:
                    logger.info(f"Board idle for {int(idle_duration)}s (>= {off_limit}s). Turning all controllers and board light OFF.")
                    await self._power_off_all()

                # Check Dimming & Inactivity Teardown (e.g. 5 min)
                elif dim_enabled and idle_duration >= dim_limit and not self.is_board_dimmed and not self.is_board_off:
                    logger.info(f"Board idle for {int(idle_duration)}s (>= {dim_limit}s). Dimming, releasing UDP, and restoring Idle Preset 1.")
                    self.is_board_dimmed = True
                    dim_bri = self.app_config.idle_dimming_brightness if self.app_config else 50
                    self.current_illumination = dim_bri
                    for drv in self.drivers.values():
                        await drv.transition_to_http_mode(restore_preset_id=1)
                        await drv.set_board_light(dim_bri)
                    await self._broadcast_telemetry({"type": "protocol_state", "mode": "http"})
                    await self._broadcast_telemetry({"type": "power_state", "state": "dimmed"})

            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Error in idle monitor loop")

    # -------------------------------------------------------------------------
    # Telemetry Subscriptions
    # -------------------------------------------------------------------------
    def subscribe_telemetry(self, callback: Callable[[Dict[str, Any]], Awaitable[None]]):
        self._telemetry_subscribers.add(callback)

    def unsubscribe_telemetry(self, callback: Callable[[Dict[str, Any]], Awaitable[None]]):
        self._telemetry_subscribers.discard(callback)

    async def _broadcast_telemetry(self, payload: Dict[str, Any]):
        for sub in list(self._telemetry_subscribers):
            try:
                await sub(payload)
            except Exception as e:
                logger.warning(f"Telemetry subscriber callback error: {e}")
