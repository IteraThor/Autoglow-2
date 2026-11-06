"""
AutoGlow 2 - Deep WLED Hardware Driver
Handles DRGB UDP real-time streaming (port 21324) and HTTP JSON segment control
for dual WS281x (RGB) + PWM White setups with zero protocol collisions.
"""

import dataclasses
import itertools
import os
import asyncio
import socket
import select
import time
import json
import logging
import urllib.request
import re
from typing import Optional, List, Tuple, Dict, Any, Callable, Union

from core.models import DeviceConfig, EffectConfig, AnimationType, RGBColor, ProtocolMode, is_pwm_output
from core.animations import render_animation_frame, blend_frames
from core.effects.flow import blend_flow, normalize_options, normalize_transition_style
from core.effects.flow.renderers import FLOW_RENDERERS

# WLED realtime UDP limits: one DRGB packet holds 490 LEDs, one DNRGB packet 489 (it spends 2 bytes on the start index)
DRGB_MAX_LEDS = 490
DNRGB_MAX_LEDS = 489

# A hit fades back into the current look over its last 0.3 s
FLOW_HIT_FADE_BACK = 0.3
# The hit locator lights one board number's width (1/20 of the strip) with soft edges
LOCATOR_WIDTH = 1.0 / 20.0


def _clear_flow_state(ch: Dict[str, Any]) -> None:
    ch["flow"] = False
    ch["fade"] = None
    ch["overlay"] = None
    ch["locator"] = None
    ch["last_base"] = None
    ch["flow_session"] = next(_flow_sessions)


def _composite(base: Union[bytes, bytearray], layer: Union[bytes, bytearray], mask: Union[bytes, bytearray], scale: float) -> bytearray:
    """Lay `layer` over `base`; each LED shows as much of the layer as the mask's brightness says."""
    out = bytearray(base)
    for i in range(0, len(out) - 2, 3):
        m = max(mask[i], mask[i + 1], mask[i + 2])
        if m == 0:
            continue
        a = m / 255.0 * scale
        for c in (i, i + 1, i + 2):
            out[c] = int(base[c] + (layer[c] - base[c]) * a + 0.5)
    return out


def _draw_locator(base: Union[bytes, bytearray], count: int, position: float, color: RGBColor, level: float) -> bytearray:
    out = bytearray(base)
    half = LOCATOR_WIDTH / 2.0
    edge = max(LOCATOR_WIDTH / 2.0, 1.0 / max(1, count))
    col = (color.r, color.g, color.b)
    for i in range(count):
        d = abs(((i + 0.5) / count - position + 0.5) % 1.0 - 0.5)
        if d >= half + edge:
            continue
        a = level * (1.0 if d <= half else 1.0 - (d - half) / edge)
        j = i * 3
        for c in range(3):
            out[j + c] = int(out[j + c] + (col[c] - out[j + c]) * a + 0.5)
    return out

logger = logging.getLogger("autoglow.wled_driver")

# Optional Rust LED engine (rust_core/, built by setup.sh). Without it, or with a build that does not
# match this code (API_VERSION), the LED loop runs in Python. AUTOGLOW_LED_ENGINE=python forces Python.
_RUST_API_VERSION = 2
_rust_core = None
if os.environ.get("AUTOGLOW_LED_ENGINE", "").strip().lower() != "python":
    try:
        import autoglow_core as _rust_core_module
        if getattr(_rust_core_module, "API_VERSION", None) == _RUST_API_VERSION:
            _rust_core = _rust_core_module
        else:
            logger.warning("Rust LED engine %s does not match this AutoGlow (API %s, needs %s); using the Python engine. "
                           "Run setup again to rebuild it.", getattr(_rust_core_module, "__version__", "?"),
                           getattr(_rust_core_module, "API_VERSION", "?"), _RUST_API_VERSION)
    except ImportError:
        pass
    except Exception:
        logger.exception("Rust LED engine failed to load; using the Python engine")

# Every flow-state reset starts a new session, so the Rust engine never hands back an older look picture
_flow_sessions = itertools.count(1)

# Flow options the Rust engine expects for every look (normalize_options fills in the look's own)
_RUST_FLOW_DEFAULTS = {"pulses": 1, "comets": 1, "tail": "short", "sides": "both", "palette": "vivid", "amount": "some"}


def led_engine_name() -> str:
    """'rust' or 'python': which engine streams the LEDs."""
    return "rust" if _rust_core is not None else "python"


def is_host_online(ip: str, port: int = 80, timeout: float = 0.3) -> bool:
    """Ultra-fast non-blocking TCP socket check to instantly verify if WLED controller is reachable."""
    if not ip or not ip.strip():
        return False
    clean_ip = ip.strip()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setblocking(False)
    try:
        s.connect((clean_ip, port))
        s.close()
        return True
    except (BlockingIOError, OSError):
        pass
    except Exception:
        s.close()
        return False

    try:
        _, writeable, _ = select.select([], [s], [], timeout)
        # A refused connection also reports the socket as writable, so check SO_ERROR
        connected = bool(writeable) and s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0
        s.close()
        return connected
    except Exception:
        try:
            s.close()
        except Exception:
            pass
        return False

LED_TYPE_NAMES: Dict[int, str] = {
    20: "WS2811 (400kHz)",
    21: "TM1829",
    22: "WS281x",
    24: "SK6812 RGBW",
    25: "TM1814",
    26: "400kHz",
    29: "WS2801",
    30: "APA102",
    31: "LPD8806",
    40: "On/Off",
    41: "PWM White",
    42: "PWM CCT",
    43: "PWM RGB",
    44: "PWM RGBW",
    45: "PWM RGB+CCT"
}


def _safe_seg_id(seg: dict) -> int:
    try:
        return int(seg.get("id", -1))
    except (TypeError, ValueError):
        return -1


def sanitize_wled_name(name: str) -> str:
    """Strip characters unsupported by WLED ESP32 firmware (quotes, apostrophes, etc.) and limit to 32 chars."""
    if not name:
        return ""
    # "·" (the guided setup's old zone separator) becomes "-"; Python escapes non-ASCII to "\\u00b7", which WLED keeps as text
    name = re.sub(r"[^a-zA-Z0-9 _-]", "", str(name).replace("\u00b7", "-"))
    return re.sub(r"\s+", " ", name).strip()[:32]


class WLEDDriver:
    """
    Deep module controlling a physical WLED controller.
    Presents a small, robust interface for playing dynamic effects, managing board lighting,
    and handling WLED JSON API mutations and readbacks.
    """

    def __init__(self, config: DeviceConfig):
        self.config = config
        self.target_ips: List[str] = [config.ip] if config.ip else []
        self._current_pwm_brightness = config.default_pwm_brightness
        self._segment_channels: Dict[int, Dict[str, Any]] = {}
        self._master_broadcast_task: Optional[asyncio.Task] = None
        self._sock: Optional[socket.socket] = None
        self._protocol_mode: ProtocolMode = ProtocolMode.IDLE_HTTP
        self._frame_tap_callback: Optional[Callable[[bytes], None]] = None
        self._rust_engine = None  # autoglow_core.LedEngine, created on first use

    def set_frame_tap_callback(self, callback: Optional[Callable[[bytes], None]]) -> None:
        """Register a callback for in-memory tap of rendered DRGB frame buffers (used by simulator)."""
        self._frame_tap_callback = callback

    @property
    def protocol_mode(self) -> ProtocolMode:
        return self._protocol_mode

    async def transition_to_udp_mode(self, spotlight_brightness: Optional[int] = None) -> bool:
        """
        Transition from IDLE_HTTP to ACTIVE_UDP mode:
        1. Set PWM spotlight to configured brightness in memory for UDP stream.
        2. Set mode to ACTIVE_UDP.
        """
        # This controller's own brightness during a game wins over the global one
        bri = self.config.game_pwm_brightness
        if bri is None:
            bri = spotlight_brightness if spotlight_brightness is not None else self.config.default_pwm_brightness
        self._current_pwm_brightness = max(0, min(255, bri))
        self._protocol_mode = ProtocolMode.ACTIVE_UDP
        logger.info(f"Transitioned to ACTIVE_UDP mode (Spotlight brightness: {self._current_pwm_brightness})")
        return True

    async def transition_to_http_mode(self, restore_preset_id: int = 1) -> bool:
        """
        Transition from ACTIVE_UDP to IDLE_HTTP mode:
        1. Cancel master UDP broadcast loop.
        2. Release live override lock and restore default preset seamlessly via HTTP JSON API (no black flash).
        3. Verify lor == 0 via Stage 1 readback.
        4. Set mode to IDLE_HTTP.
        """
        logger.info("Transitioning to IDLE_HTTP mode (seamlessly restoring default preset)...")
        for ch in self._segment_channels.values():
            ch["baseline_effect"] = None
            ch["transient_effect"] = None
            _clear_flow_state(ch)

        if self._master_broadcast_task and not self._master_broadcast_task.done():
            self._master_broadcast_task.cancel()
            try:
                await self._master_broadcast_task
            except asyncio.CancelledError:
                pass
            self._master_broadcast_task = None
        
        loop = asyncio.get_running_loop()
        verified = await loop.run_in_executor(None, self._sync_release_live_and_restore_preset, restore_preset_id)
        self._protocol_mode = ProtocolMode.IDLE_HTTP
        return verified

    def _sync_release_live_and_restore_preset(self, preset_id: int = 1, max_retries: int = 10, delay: float = 0.05) -> bool:
        """
        Release WLED live override lock (lor: 0) and activate the default preset (ps: 1)
        simultaneously via HTTP JSON API for a seamless transition without a black flash.
        Returns True only if every target controller reads back lor == 0 (Stage 1 verification).
        """
        ips = self.target_ips if self.target_ips else ([self.config.ip] if self.config.ip else [])
        all_verified = True
        for ip in ips:
            if not ip:
                continue
            if not is_host_online(ip, 80, timeout=0.3):
                logger.warning(f"Cannot release live mode on {ip}: controller unreachable")
                all_verified = False
                continue
            url = f"http://{ip}/json/state"
            payload = {"lor": 0, "ps": preset_id, "tt": 0, "v": True}
            try:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    resp.read()
            except Exception as e:
                logger.warning(f"Error releasing live mode via HTTP on {ip}: {e}")

            # Stage 1: verify lor == 0
            verified = False
            for _ in range(max_retries):
                try:
                    with urllib.request.urlopen(url, timeout=0.5) as resp:
                        data = json.loads(resp.read().decode())
                    if data.get("lor", 0) == 0:
                        verified = True
                        break
                except Exception as e:
                    logger.warning(f"Live mode readback failed on {ip}: {e}")
                    break
                time.sleep(delay)
            if not verified:
                logger.warning(f"Live override lock on {ip} not confirmed released (lor != 0)")
                all_verified = False
        return all_verified

    @staticmethod
    def fetch_live_device_info(ip: str, timeout: float = 0.4) -> Dict[str, Any]:
        """
        Fetch /json and /json/cfg from a WLED device, building a comprehensive
        live breakdown of segments, hardware outputs, and online status.
        Uses a fast socket pre-check to detect offline controllers in < 0.5s.
        """
        if not ip or not ip.strip():
            return {
                "status": "ok",
                "online": False,
                "ip": "",
                "name": "WLED Controller",
                "segments": [],
                "hw_ins": [],
                "message": "No IP specified"
            }
        
        ip_clean = ip.strip()

        # Fast non-blocking TCP socket pre-check (0.3s) to prevent Windows HTTP retry delays on offline IPs
        if not is_host_online(ip_clean, 80, timeout=0.3):
            logger.debug(f"WLED controller at {ip_clean} is offline (TCP check failed)")
            return {
                "status": "ok",
                "online": False,
                "ip": ip_clean,
                "name": ip_clean,
                "segments": [],
                "hw_ins": [],
                "message": "Offline (Host unreachable)"
            }

        # 1. Fetch /json (state and info)
        try:
            url_json = f"http://{ip_clean}/json"
            req_json = urllib.request.Request(url_json)
            with urllib.request.urlopen(req_json, timeout=1.0) as resp:
                data_json = json.loads(resp.read().decode())
        except Exception as e:
            logger.warning(f"WLED controller at {ip_clean} failed HTTP /json query: {e}")
            return {
                "status": "ok",
                "online": False,
                "ip": ip_clean,
                "name": ip_clean,
                "segments": [],
                "hw_ins": [],
                "message": f"Offline ({type(e).__name__})"
            }

        # 2. Fetch hardware pins and types (/cfg.json or /json/cfg or info.leds)
        hw_ins = []
        try:
            url_cfg = f"http://{ip_clean}/cfg.json"
            req_cfg = urllib.request.Request(url_cfg)
            with urllib.request.urlopen(req_cfg, timeout=timeout) as resp:
                data_cfg = json.loads(resp.read().decode())
                hw_ins = data_cfg.get("hw", {}).get("led", {}).get("ins", [])
        except Exception:
            pass

        if not hw_ins:
            try:
                url_cfg = f"http://{ip}/json/cfg"
                req_cfg = urllib.request.Request(url_cfg)
                with urllib.request.urlopen(req_cfg, timeout=timeout) as resp:
                    data_cfg = json.loads(resp.read().decode())
                    hw_ins = data_cfg.get("hw", {}).get("led", {}).get("ins", [])
            except Exception:
                pass

        if not hw_ins:
            # Fallback to info.leds.ins if available in /json
            hw_ins = data_json.get("info", {}).get("leds", {}).get("ins", [])

        # 3. Build live segments breakdown from both state.seg and hardware outputs
        state_segs = data_json.get("state", {}).get("seg", [])
        live_segments = []
        for idx, s in enumerate(state_segs):
            seg_id = s.get("id", idx)
            seg_start = s.get("start", 0)
            seg_stop = s.get("stop", 0)
            seg_len = s.get("len", max(0, seg_stop - seg_start))
            seg_name = s.get("n") or f"Segment {seg_id}"
            seg_on = s.get("on", True)
            seg_bri = s.get("bri", 255)

            hw_type = "WS281x"
            hw_gpio = ""
            if hw_ins:
                for h in hw_ins:
                    h_start = h.get("start", 0)
                    h_len = h.get("len", 0)
                    if seg_start >= h_start and seg_start < (h_start + h_len):
                        led_type_code = h.get("type", 22)
                        hw_type = LED_TYPE_NAMES.get(led_type_code, f"Type {led_type_code}")
                        pins = h.get("pin", [])
                        if pins:
                            hw_gpio = f"GPIO {pins[0]}"
                        break

            live_segments.append({
                "id": seg_id,
                "name": seg_name,
                "start": seg_start,
                "stop": seg_stop,
                "len": seg_len,
                "of": s.get("of", 0),
                "on": seg_on,
                "bri": seg_bri,
                "type": hw_type,
                "gpio": hw_gpio
            })

        return {
            "status": "ok",
            "online": True,
            "name": data_json.get("info", {}).get("name", "WLED Controller"),
            "version": data_json.get("info", {}).get("ver", ""),
            "info": data_json.get("info", {}),
            "state": data_json.get("state", {}),
            "segments": live_segments,
            "hw_ins": hw_ins
        }

    @staticmethod
    def evaluate_state_blockers(state: Dict[str, Any], expect_live: bool = False) -> List[str]:
        """
        Stage 1 hardware blocker checks on a /json/state readback.
        Returns human-readable reasons why LEDs may stay dark (empty list if none).
        """
        warnings: List[str] = []
        if state.get("on") is False:
            warnings.append("Controller power is off (on: false)")
        if state.get("bri", 255) == 0:
            warnings.append("Master brightness is 0 (bri: 0)")
        lor = state.get("lor", 0) or 0
        if lor > 0 and not expect_live:
            warnings.append(f"Live override lock active (lor: {lor}); JSON API changes are blocked")
        for seg in state.get("seg", []):
            if not isinstance(seg, dict):
                continue
            sid = seg.get("id", "?")
            start, stop = seg.get("start", 0), seg.get("stop", 0)
            if stop <= start:
                warnings.append(f"Segment {sid} has invalid bounds (start {start}, stop {stop})")
                continue
            if seg.get("on") is False:
                warnings.append(f"Segment {sid} is switched off")
            if seg.get("bri", 255) == 0:
                warnings.append(f"Segment {sid} brightness is 0")
        return warnings

    @staticmethod
    def fetch_device_health(ip: str, expect_live: bool = False, timeout: float = 1.0) -> Dict[str, Any]:
        """Single lightweight GET /json readback summarizing controller state and hardware blockers."""
        ip_clean = (ip or "").strip()
        if not ip_clean or not is_host_online(ip_clean, 80, timeout=0.3):
            return {"online": False, "warnings": []}
        try:
            with urllib.request.urlopen(f"http://{ip_clean}/json", timeout=timeout) as resp:
                data = json.loads(resp.read().decode())
        except Exception as e:
            return {"online": False, "warnings": [], "error": f"{type(e).__name__}: {e}"}

        state = data.get("state", {}) if isinstance(data, dict) else {}
        info = data.get("info", {}) if isinstance(data, dict) else {}
        return {
            "online": True,
            "name": info.get("name", ""),
            "version": info.get("ver", ""),
            "on": state.get("on"),
            "bri": state.get("bri"),
            "lor": state.get("lor", 0),
            "preset": state.get("ps", -1),
            "segments": [
                {
                    "id": s.get("id"),
                    "name": s.get("n") or f"Segment {s.get('id')}",
                    "start": s.get("start", 0),
                    "stop": s.get("stop", 0),
                    "on": s.get("on", True),
                    "bri": s.get("bri", 255)
                }
                for s in state.get("seg", []) if isinstance(s, dict)
            ],
            "warnings": WLEDDriver.evaluate_state_blockers(state, expect_live=expect_live)
        }

    @staticmethod
    def apply_wled_mutations(
        ip: str,
        name: Optional[str] = None,
        hw_ins: Optional[List[dict]] = None,
        state_payload: Optional[dict] = None,
        timeout: float = 3.0
    ) -> Dict[str, Any]:
        """
        Apply configuration and state mutations to a physical WLED device,
        followed by Stage 1 Readback verification (/json).
        """
        if not ip or not ip.strip():
            raise ValueError("No IP address specified")

        # 1. Mutate WLED Hardware Outputs, Name & Boot Preset (/json/cfg)
        clean_name = sanitize_wled_name(name) if name else None
        cfg_payload = {}
        if clean_name:
            cfg_payload["id"] = {"name": clean_name}
        if hw_ins is not None and isinstance(hw_ins, list):
            WLEDDriver._normalize_pwm_outputs(hw_ins)
            cfg_payload.setdefault("hw", {}).setdefault("led", {})["ins"] = hw_ins
        # Ensure Preset 1 is configured as Boot Preset and live mso=False
        cfg_payload.setdefault("def", {})["ps"] = 1
        cfg_payload.setdefault("if", {}).setdefault("live", {})["mso"] = False

        if cfg_payload:
            url_cfg = f"http://{ip}/json/cfg"
            req = urllib.request.Request(
                url_cfg,
                data=json.dumps(cfg_payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    resp.read()
                # Allow ESP32 WLED firmware to allocate hardware LED bus buffer before segment mutation
                time.sleep(0.08)
            except Exception as e:
                logger.warning(f"Failed to update /json/cfg on {ip}: {e}")

        # 2. Mutate WLED State (/json/state) and write to Preset 1 (Boot Preset)
        if state_payload:
            state_copy = dict(state_payload)
            state_copy["v"] = True
            state_copy["lor"] = 0  # Release live override lock
            state_copy["psave"] = 1  # Persist segments & state into Preset 1
            state_copy["n"] = "AutoGlow Default"
            state_copy["ib"] = True  # Include brightness
            state_copy["sb"] = True  # Include segment bounds (start & stop)
            
            existing_seg_count = 0
            try:
                with urllib.request.urlopen(f"http://{ip}/json/state", timeout=1.5) as r:
                    existing_state = json.loads(r.read().decode())
                    existing_seg_count = len(existing_state.get("seg", []))
            except Exception:
                existing_seg_count = 8

            new_segs = list(state_copy.get("seg", []))
            for s in new_segs:
                if isinstance(s, dict) and "n" in s:
                    s["n"] = sanitize_wled_name(s["n"])

            # Explicitly delete any higher segment IDs on WLED that were removed
            active_ids = {s.get("id") for s in new_segs if isinstance(s, dict) and "id" in s}
            for sid in range(max(existing_seg_count, 8)):
                if sid not in active_ids and (len(new_segs) == 0 or sid >= len(new_segs)):
                    new_segs.append({"id": sid, "stop": 0})

            state_copy["seg"] = new_segs

            url_state = f"http://{ip}/json/state"
            req = urllib.request.Request(
                url_state,
                data=json.dumps(state_copy).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    resp.read()
                if hw_ins:
                    # WLED's LED bus rebuild after new outputs can land after this state and reset the
                    # segments, so send it once more (without saving the preset again)
                    time.sleep(0.8)
                    resend = {k: v for k, v in state_copy.items() if k not in ("psave", "n", "ib", "sb")}
                    req = urllib.request.Request(url_state, data=json.dumps(resend).encode("utf-8"), headers={"Content-Type": "application/json"})
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        resp.read()
            except Exception as e:
                logger.warning(f"Failed to update /json/state on {ip}: {e}")

        # 3. Stage 1: Readback verification
        url_json = f"http://{ip}/json"
        req_json = urllib.request.Request(url_json)
        with urllib.request.urlopen(req_json, timeout=timeout) as resp:
            readback = json.loads(resp.read().decode())

        return readback

    @staticmethod
    def _normalize_pwm_outputs(hw_ins: List[dict]) -> None:
        """PWM outputs need a white-balance mode, or WLED leaves the channel dark."""
        for ins in hw_ins:
            if is_pwm_output(ins):
                if ins.get("rgbwm") not in (1, 2, 3, 4):
                    ins["rgbwm"] = 4

    @staticmethod
    def apply_setup_preview(
        ip: str,
        hw_ins: Optional[List[dict]] = None,
        state_payload: Optional[dict] = None,
        timeout: float = 3.0
    ) -> None:
        """
        Write a temporary LED layout for the setup guide's light tests.
        Unlike apply_wled_mutations nothing is saved to Preset 1 and the boot settings stay untouched.
        """
        if not ip or not ip.strip():
            raise ValueError("No IP address specified")
        ip_clean = ip.strip()

        if hw_ins:
            WLEDDriver._normalize_pwm_outputs(hw_ins)
            body = json.dumps({"hw": {"led": {"ins": hw_ins}}}).encode("utf-8")
            req = urllib.request.Request(f"http://{ip_clean}/json/cfg", data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read()
            # WLED rebuilds its LED buses in the main loop; segments sent earlier would be cut to the old length
            time.sleep(0.4)

        if state_payload:
            state = dict(state_payload)
            state["v"] = False
            state["lor"] = 0
            segs = [s for s in state.get("seg", []) if isinstance(s, dict)]
            if segs:
                # Drop segments left over from the controller's previous layout
                existing_seg_count = 0
                try:
                    with urllib.request.urlopen(f"http://{ip_clean}/json/state", timeout=1.5) as r:
                        existing_seg_count = len(json.loads(r.read().decode()).get("seg", []))
                except Exception:
                    existing_seg_count = 8
                used = {s.get("id") for s in segs}
                segs += [{"id": sid, "stop": 0} for sid in range(max(existing_seg_count, 8)) if sid not in used and sid >= len(segs)]
                for s in segs:
                    if "n" in s:
                        s["n"] = sanitize_wled_name(s["n"])
                state["seg"] = segs
            body = json.dumps(state).encode("utf-8")
            # The bus rebuild after new outputs can land after the first state and wipe single-LED colors,
            # so the state is sent once more when it has settled
            for attempt in range(2 if hw_ins else 1):
                if attempt:
                    time.sleep(0.8)
                req = urllib.request.Request(f"http://{ip_clean}/json/state", data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    resp.read()

    def set_target_ips(self, ips: List[str]):
        """Update list of active target WLED IPs for simultaneous broadcast."""
        self.target_ips = [ip.strip() for ip in ips if ip and ip.strip()]

    def _get_socket(self) -> socket.socket:
        if self._sock is None:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        return self._sock

    def close(self):
        if self._rust_engine is not None:
            self._rust_engine.stop()
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    # -------------------------------------------------------------------------
    # Public Interface
    # -------------------------------------------------------------------------
    async def ensure_wled_config(self) -> bool:
        """
        Verify that all target WLEDs have 'mso: true' (Main Segment Only) in sync config.
        """
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, self._sync_ensure_mso)
        except Exception:
            logger.exception("Failed to check/update WLED config")
            return False

    async def set_board_light(self, brightness: int, target_ip: Optional[str] = None) -> bool:
        """
        Set PWM White strip brightness (0..255).
        If in ACTIVE_UDP mode, updates the in-memory PWM brightness for real-time UDP streaming.
        If in IDLE_HTTP mode, updates the physical controller via HTTP JSON API.
        """
        self._current_pwm_brightness = max(0, min(255, brightness))
        if self._protocol_mode == ProtocolMode.ACTIVE_UDP:
            return True
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, self._sync_set_pwm_brightness, self._current_pwm_brightness, target_ip)
        except Exception:
            logger.exception("Failed to set PWM brightness")
            return False

    async def play_effect(
        self,
        effect: EffectConfig,
        segment_id: Optional[int] = None,
        force_enable: bool = False,
        previous_color: Optional[RGBColor] = None
    ) -> None:
        """
        Play an effect on a specific segment (or all segments) independently over UDP DRGB.
        If duration == 0, it sets a permanent baseline color/state.
        If duration > 0, it plays a transient effect for that duration, then automatically reverts to the baseline!
        """
        s_id = int(segment_id) if segment_id is not None else 0
        start_idx, stop_idx = self._get_segment_bounds(s_id)
        is_cont = (effect.duration <= 0.0)

        # Clean up stale segment channels that no longer exist in current device config
        valid_seg_ids = {s.id for s in self.config.segments} if self.config.segments else {0}
        for stale_id in list(self._segment_channels.keys()):
            if stale_id not in valid_seg_ids:
                del self._segment_channels[stale_id]

        if self._protocol_mode != ProtocolMode.ACTIVE_UDP:
            logger.warning("Blocked UDP effect execution: protocol mode is IDLE_HTTP. Connect UDP first.")
            return

        if not force_enable and (not effect.enabled or effect.animation == AnimationType.OFF):
            if segment_id is not None:
                self.stop_segment(s_id)
            else:
                await self.stop_effect()
            return

        if s_id not in self._segment_channels:
            self._segment_channels[s_id] = {
                "start_idx": start_idx,
                "stop_idx": stop_idx,
                "baseline_effect": None,
                "baseline_start_time": time.time(),
                "transient_effect": None,
                "transient_start_time": 0.0,
                "transient_duration": 0.0,
                "last_active_color": None,
            }

        ch = self._segment_channels[s_id]
        ch["start_idx"] = start_idx
        ch["stop_idx"] = stop_idx
        if ch.get("flow"):
            _clear_flow_state(ch)

        # If previous_color is explicitly provided, record it as the channel's last active color
        if previous_color and (previous_color.r, previous_color.g, previous_color.b) != (0, 0, 0):
            ch["last_active_color"] = previous_color
        else:
            # Capture visible primary color of outgoing effect before replacing it
            curr_active = ch.get("transient_effect") or ch.get("baseline_effect")
            if curr_active and curr_active.color_primary:
                c = curr_active.color_primary
                if (c.r, c.g, c.b) != (0, 0, 0):
                    ch["last_active_color"] = c

        if is_cont:
            # Permanent baseline mutation
            if effect.animation == AnimationType.OFF:
                ch["baseline_effect"] = None
            else:
                ch["baseline_effect"] = effect
                ch["baseline_start_time"] = time.time()
                if effect.color_primary and (effect.color_primary.r, effect.color_primary.g, effect.color_primary.b) != (0, 0, 0):
                    ch["last_active_color"] = effect.color_primary
        else:
            # Transient effect that will expire and revert to baseline
            ch["transient_effect"] = effect
            ch["transient_start_time"] = time.time()
            ch["transient_duration"] = max(0.2, effect.duration)

        # Rust engine: the new effect reaches the LED thread now, not at the next feed tick
        self._sync_rust_engine(start=True)

        # Ensure master broadcast loop is running
        if not self._master_broadcast_task or self._master_broadcast_task.done():
            self._master_broadcast_task = asyncio.create_task(self._run_master_broadcast_loop())

    # -------------------------------------------------------------------------
    # Flow Matrix channels: a look that comes in with a transition, hits on top
    # -------------------------------------------------------------------------
    def _flow_channel(self, segment_id: Optional[int]) -> Dict[str, Any]:
        s_id = int(segment_id) if segment_id is not None else 0
        start_idx, stop_idx = self._get_segment_bounds(s_id)
        ch = self._segment_channels.get(s_id)
        if ch is None:
            ch = {"baseline_effect": None, "baseline_start_time": time.time(), "transient_effect": None,
                  "transient_start_time": 0.0, "transient_duration": 0.0, "last_active_color": None}
            self._segment_channels[s_id] = ch
        ch["start_idx"] = start_idx
        ch["stop_idx"] = stop_idx
        if not ch.get("flow"):
            # Coming from a legacy effect or from nothing: start clean
            _clear_flow_state(ch)
            ch["baseline_effect"] = None
            ch["flow"] = True
        ch["transient_effect"] = None
        return ch

    def _ensure_broadcast(self) -> None:
        self._sync_rust_engine(start=True)
        if not self._master_broadcast_task or self._master_broadcast_task.done():
            self._master_broadcast_task = asyncio.create_task(self._run_master_broadcast_loop())

    def flow_show(
        self,
        segment_id: Optional[int],
        effect: EffectConfig,
        style: str = "crossfade",
        duration: float = 0.0,
        accent: Optional[Tuple[int, int, int]] = None,
    ) -> bool:
        """
        Show a flow step's look on a segment. It blends in from whatever the segment shows now (black when
        coming from the idle lighting) using the step's transition. Returns False when not streaming.
        """
        if self._protocol_mode != ProtocolMode.ACTIVE_UDP:
            logger.warning("Blocked flow look: protocol mode is IDLE_HTTP. Connect UDP first.")
            return False
        ch = self._flow_channel(segment_id)
        prev = ch.get("baseline_effect")
        if prev == effect:
            return True  # the same look again (e.g. a repeated event) keeps running, fade included
        now = time.time()
        if self._rust_engine_enabled():
            self._prune_finished_flow_parts(ch, now)  # the Rust thread does not clear them in this dict
        fade = None
        if duration > 0.0 and style != "instant":
            # Mid-transition (or with nothing to animate) the outgoing picture is frozen; otherwise it keeps moving
            frozen = self._flow_last_base(segment_id, ch) if (ch.get("fade") or prev is None) else None
            fade = {
                "start": now, "duration": float(duration), "style": style, "accent": accent,
                "frame": frozen, "effect": None if frozen is not None else prev,
                "effect_start": ch.get("baseline_start_time", now),
            }
        ch["baseline_effect"] = effect
        ch["baseline_start_time"] = now
        ch["fade"] = fade
        self._ensure_broadcast()
        return True

    def flow_hit(self, segment_id: Optional[int], effect: EffectConfig, strength: float = 1.0) -> bool:
        """Play a hit on top of a segment's current look; it fades back into the look at the end."""
        if self._protocol_mode != ProtocolMode.ACTIVE_UDP:
            return False
        ch = self._flow_channel(segment_id)
        white, black = RGBColor(255, 255, 255), RGBColor(0, 0, 0)
        ch["overlay"] = {
            "start": time.time(),
            "duration": max(0.2, float(effect.duration or 1.0)),
            "strength": max(0.0, min(1.0, strength)),
            # The colour layer, and a white-on-black copy whose brightness says how much of the layer shows
            "layer": dataclasses.replace(effect, color_secondary=effect.color_primary, brightness=None),
            "mask": dataclasses.replace(effect, color_primary=white, color_secondary=black, brightness=None),
            "brightness": effect.brightness,
        }
        self._ensure_broadcast()
        return True

    def flow_locate(self, segment_id: Optional[int], position: float, color: RGBColor,
                    duration: float = 1.2, clockwise: bool = True) -> bool:
        """
        Light the part of a segment next to a board position (0 = top, 0.25 = right, going clockwise),
        e.g. the number just hit. The segment offset says where the top is.
        """
        if self._protocol_mode != ProtocolMode.ACTIVE_UDP:
            return False
        ch = self._flow_channel(segment_id)
        pos = position % 1.0
        ch["locator"] = {"start": time.time(), "duration": max(0.3, duration),
                         "position": pos if clockwise else (1.0 - pos) % 1.0, "color": color}
        self._ensure_broadcast()
        return True

    def flow_clear(self) -> None:
        for ch in self._segment_channels.values():
            if ch.get("flow"):
                ch["baseline_effect"] = None
                _clear_flow_state(ch)
        self._sync_rust_engine()

    def _render_flow_channel(self, ch: Dict[str, Any], now: float, count: int) -> Optional[bytearray]:
        base_eff = ch.get("baseline_effect")
        if base_eff is None:
            return None
        base = render_animation_frame(base_eff, 0, now - ch.get("baseline_start_time", now), count)

        fade = ch.get("fade")
        if fade:
            f = (now - fade["start"]) / fade["duration"]
            if f >= 1.0:
                ch["fade"] = None
            else:
                src = fade.get("frame")
                if src is None and fade.get("effect") is not None:
                    src = render_animation_frame(fade["effect"], 0, now - fade["effect_start"], count)
                if src is None or len(src) != count * 3:
                    src = bytes(count * 3)
                base = blend_flow(src, base, f, fade["style"], fade.get("accent"))
        ch["last_base"] = bytes(base)
        out = base

        ov = ch.get("overlay")
        if ov:
            el = now - ov["start"]
            dur = ov["duration"]
            if el >= dur:
                ch["overlay"] = None
            else:
                back = min(FLOW_HIT_FADE_BACK, dur * 0.4)
                scale = ov["strength"] * min(1.0, (dur - el) / back)
                bri = ov.get("brightness")
                if bri is not None and 0 <= bri < 100:
                    scale *= bri / 100.0
                layer = render_animation_frame(ov["layer"], 0, el, count)
                mask = render_animation_frame(ov["mask"], 0, el, count)
                out = _composite(out, layer, mask, scale)

        loc = ch.get("locator")
        if loc:
            el = now - loc["start"]
            if el >= loc["duration"]:
                ch["locator"] = None
            else:
                out = _draw_locator(out, count, loc["position"], loc["color"], (1.0 - el / loc["duration"]) ** 1.5)
        return out

    def stop_segment(self, segment_id: int) -> None:
        """
        Stop / turn off an individual segment without affecting other segments.
        """
        s_id = int(segment_id)
        if s_id in self._segment_channels:
            self._segment_channels[s_id]["baseline_effect"] = None
            self._segment_channels[s_id]["transient_effect"] = None
            self._sync_rust_engine()

    @property
    def is_playing_effects(self) -> bool:
        """True while the UDP stream renders an AutoGlow effect on any segment."""
        if self._protocol_mode != ProtocolMode.ACTIVE_UDP:
            return False
        now = time.time()
        for ch in self._segment_channels.values():
            transient = ch.get("transient_effect")
            if transient and now - ch.get("transient_start_time", 0.0) < ch.get("transient_duration", 0.0):
                return True
            baseline = ch.get("baseline_effect")
            if baseline and baseline.animation != AnimationType.OFF:
                return True
        return False

    async def stop_effect(self) -> None:
        """
        Stop all active effect channels and release WLED live mode immediately.
        """
        for ch in self._segment_channels.values():
            ch["baseline_effect"] = None
            ch["transient_effect"] = None
            _clear_flow_state(ch)

        if self._master_broadcast_task and not self._master_broadcast_task.done():
            self._master_broadcast_task.cancel()
            try:
                await self._master_broadcast_task
            except asyncio.CancelledError:
                pass
            self._master_broadcast_task = None

    def _get_total_led_count(self) -> int:
        """Calculate the total number of physical/virtual LEDs managed on this controller."""
        if self.config.hw_ins:
            return sum(max(1, int(h.get("len", 1))) for h in self.config.hw_ins)
        if self.config.segments:
            return max([s.start + s.length for s in self.config.segments] + [self.config.rgb_count])
        pwm_idx = self.config.pwm_index if self.config.pwm_index is not None else self.config.rgb_count
        return max(self.config.rgb_count, pwm_idx + 1)

    def _get_segment_bounds(self, seg_id: int) -> Tuple[int, int]:
        """
        Lookup start and stop physical LED indices for a segment.
        """
        total_count = self._get_total_led_count()
        if self.config.segments:
            target_seg = next((s for s in self.config.segments if s.id == seg_id), None)
            if target_seg:
                start_idx = max(0, target_seg.start)
                stop_idx = min(total_count, target_seg.start + max(1, target_seg.length))
                return (start_idx, stop_idx)
        if seg_id == 0:
            return (0, self.config.rgb_count)
        elif seg_id == self._get_pwm_seg_id():
            pwm_idx = self.config.pwm_index if self.config.pwm_index is not None else self.config.rgb_count
            return (pwm_idx, pwm_idx + 1)
        return (0, self.config.rgb_count)

    def _get_segment_offset(self, seg_id: int) -> int:
        """LEDs after the segment start where its effects begin (WLED's "of"), 0 if none."""
        target_seg = next((s for s in self.config.segments if s.id == seg_id), None)
        return target_seg.offset if target_seg else 0

    @staticmethod
    def _apply_offset(seg_rendered: Union[bytes, bytearray], offset: int) -> Union[bytes, bytearray]:
        """Rotate a segment frame so its first LED lands offset LEDs after the segment start."""
        seg_len = len(seg_rendered) // 3
        offset = offset % seg_len if seg_len else 0
        if not offset:
            return seg_rendered
        cut = (seg_len - offset) * 3
        return seg_rendered[cut:] + seg_rendered[:cut]

    def _get_pwm_seg_id(self) -> Optional[int]:
        """
        Dynamically lookup the segment ID corresponding to the PWM White output, or None if no PWM output.
        """
        if self.config.hw_ins:
            has_pwm = any(is_pwm_output(h) for h in self.config.hw_ins)
            if not has_pwm:
                return None
        if self.config.segments:
            for s in self.config.segments:
                if "pwm" in s.name.lower() or "pwm" in s.type.lower():
                    return s.id
        return self.config.pwm_seg_id if (self.config.pwm_seg_id is not None and self.config.pwm_index is not None) else None

    def _get_pwm_seg_ids(self) -> List[int]:
        """Segment IDs of every PWM White output (a controller can have several light strips)."""
        if self.config.hw_ins and not any(is_pwm_output(h) for h in self.config.hw_ins):
            return []
        ids = [s.id for s in self.config.segments if "pwm" in s.name.lower() or "pwm" in s.type.lower()]
        if ids:
            return ids
        single = self._get_pwm_seg_id()
        return [single] if single is not None else []

    def _get_pwm_led_indices(self) -> List[int]:
        """LED index of every PWM White output in the UDP frame, laid out like _get_total_led_count."""
        if self.config.hw_ins:
            indices: List[int] = []
            cursor = 0
            for h in self.config.hw_ins:
                if is_pwm_output(h):
                    indices.append(cursor)
                cursor += max(1, int(h.get("len", 1)))
            return indices
        if self._get_pwm_seg_id() is None or self.config.pwm_index is None:
            return []
        return [self.config.pwm_index]

    # -------------------------------------------------------------------------
    # Internal Synchronous Helpers (Executed in thread pool)
    # -------------------------------------------------------------------------
    def _sync_ensure_mso(self) -> bool:
        ip = self.config.ip.strip() if self.config.ip else ""
        if not ip:
            return True
        # Fast check (0.3s) if device is reachable to avoid startup lag on offline devices
        if not is_host_online(ip, 80, timeout=0.3):
            logger.warning(f"Device at {ip} is offline during startup config check.")
            return False

        url = f"http://{ip}/json/cfg"
        try:
            with urllib.request.urlopen(url, timeout=1.0) as resp:
                cfg = json.loads(resp.read().decode())
            
            needs_update = False
            payload: Dict[str, Any] = {}

            # 1. Ensure mso: False for physical raw pixel streaming
            if cfg.get("if", {}).get("live", {}).get("mso") is not False:
                payload.setdefault("if", {}).setdefault("live", {})["mso"] = False
                needs_update = True

            # 2. Ensure PWM outputs have rgbwm: 4 (Max) so they respond to DRGB values during live mode
            hw_ins = cfg.get("hw", {}).get("led", {}).get("ins", [])
            for ins in hw_ins:
                # Analog types 40-49 (e.g. 41 = PWM 1CH White)
                if is_pwm_output(ins) and ins.get("rgbwm") not in (1, 2, 3, 4):
                    ins["rgbwm"] = 4
                    payload.setdefault("hw", {}).setdefault("led", {})["ins"] = hw_ins
                    needs_update = True

            if needs_update:
                data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    pass

            # 3. Ensure configured segments exist on WLED (recovers if WLED power-cycled and reset to single 0..46 segment)
            if self.config.segments and len(self.config.segments) > 1:
                try:
                    needs_segment_recovery = False
                    with urllib.request.urlopen(f"http://{ip}/json/state", timeout=1.0) as s_resp:
                        live_state = json.loads(s_resp.read().decode())
                        live_segs = live_state.get("seg", [])
                        first_seg_len = self.config.segments[0].length
                        if len(live_segs) < len(self.config.segments) or live_segs[0].get("stop") != first_seg_len:
                            needs_segment_recovery = True

                    # Also verify Preset 1 in LittleFS has valid segment bounds
                    if not needs_segment_recovery:
                        try:
                            with urllib.request.urlopen(f"http://{ip}/presets.json", timeout=1.0) as p_resp:
                                p_data = json.loads(p_resp.read().decode())
                                p1 = p_data.get("1", {})
                                p1_segs = p1.get("seg", [])
                                active_p1 = [s for s in p1_segs if isinstance(s, dict) and s.get("id") is not None]
                                if len(active_p1) < len(self.config.segments) or any(s.get("start") is None or s.get("stop") is None for s in active_p1):
                                    logger.info(f"Preset 1 on {ip} lacks segment bounds in presets.json -> triggering auto-repair")
                                    needs_segment_recovery = True
                        except Exception:
                            pass

                    if needs_segment_recovery:
                        seg_payload = []
                        for s in self.config.segments:
                            seg_payload.append({
                                "id": s.id,
                                "start": s.start,
                                "stop": s.start + s.length,
                                "of": s.offset,
                                "n": sanitize_wled_name(s.name),
                                "on": True,
                                "bri": 255 if s.id == 0 else self.config.default_pwm_brightness
                            })
                        s_req = urllib.request.Request(
                            f"http://{ip}/json/state",
                            data=json.dumps({"seg": seg_payload, "psave": 1, "ib": True, "sb": True, "v": True}).encode("utf-8"),
                            headers={"Content-Type": "application/json"}
                        )
                        with urllib.request.urlopen(s_req, timeout=1.0) as s_commit:
                            s_commit.read()
                        logger.info(f"Restored and saved multi-segment configuration with sb: True on {ip}")
                except Exception as se:
                    logger.warning(f"Error checking/restoring segments on {ip}: {se}")
                    return False
        except Exception as e:
            logger.warning(f"Error ensuring WLED config on {ip}: {e}")
            return False
        return True

    def _sync_set_pwm_brightness(self, brightness: int, target_ip: Optional[str] = None) -> bool:
        ip = target_ip.strip() if target_ip and target_ip.strip() else (self.config.ip.strip() if self.config.ip else "")
        if not ip:
            return True
        pwm_seg_ids = self._get_pwm_seg_ids()
        if not pwm_seg_ids:
            return True  # No PWM hardware output on this controller
        # Fast check (0.3s) if device is reachable
        if not is_host_online(ip, 80, timeout=0.3):
            logger.warning(f"Device at {ip} is offline during set_pwm_brightness.")
            return False

        url = f"http://{ip}/json/state"
        payload = {
            "seg": [{
                "id": seg_id,
                "on": (brightness > 0),
                "bri": brightness
            } for seg_id in pwm_seg_ids],
            "v": True
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                state = json.loads(resp.read().decode() or "{}")
        except Exception as e:
            logger.warning(f"Error setting PWM brightness via HTTP on {ip}: {e}")
            return False

        # Stage 1: verify the PWM segments committed the brightness (v: true returns full state)
        for live_seg in state.get("seg", []):
            if not isinstance(live_seg, dict) or live_seg.get("id") not in pwm_seg_ids:
                continue
            if brightness > 0 and live_seg.get("bri") != brightness:
                logger.warning(f"PWM segment {live_seg.get('id')} on {ip} reads back bri={live_seg.get('bri')} (expected {brightness})")
                return False
        return True

    # -------------------------------------------------------------------------
    # Packet Construction & Master Streaming Loop
    # -------------------------------------------------------------------------
    def _create_drgb_packet(self, rgb_bytes: bytes, timeout_sec: int = 2) -> bytes:
        """
        DRGB protocol (0x02):
        Byte 0: 0x02 (DRGB identifier)
        Byte 1: timeout (seconds)
        Byte 2+: RGB bytes (3 bytes per LED: [R, G, B])
        """
        packet = bytearray([0x02, min(255, max(1, timeout_sec))])
        packet.extend(rgb_bytes)
        return bytes(packet)

    def _create_udp_packets(self, rgb_bytes: bytes, timeout_sec: int = 2) -> List[bytes]:
        """
        The UDP packets for one frame. WLED takes at most 490 LEDs in a DRGB packet, so a longer
        frame goes out as DNRGB packets (0x04) of up to 489 LEDs, each carrying its start index.
        """
        timeout = min(255, max(1, timeout_sec))
        if len(rgb_bytes) <= DRGB_MAX_LEDS * 3:
            return [self._create_drgb_packet(rgb_bytes, timeout_sec=timeout)]
        packets = []
        chunk = DNRGB_MAX_LEDS * 3
        for offset in range(0, len(rgb_bytes), chunk):
            start = offset // 3
            packets.append(bytes([0x04, timeout, (start >> 8) & 0xFF, start & 0xFF]) + bytes(rgb_bytes[offset:offset + chunk]))
        return packets

    def _compose_frame(self, t0: float, frame: int, total_led_count: int) -> Tuple[bytearray, bool]:
        """
        One frame of the broadcast loop: merges all active segment channels (Flow looks, transient effects
        and baseline states) into one frame buffer. Returns the buffer and whether any channel is still
        active. autoglow_core's compose() mirrors this step for step.
        """
        master_buffer = bytearray(total_led_count * 3)
        any_active = False

        # LED ranges an effect drew this frame; light strips outside them keep the spotlight brightness
        rendered_ranges: List[Tuple[int, int]] = []

        for s_id, ch in list(self._segment_channels.items()):
            start_idx = ch.get("start_idx", 0)
            stop_idx = min(ch.get("stop_idx", total_led_count), total_led_count)
            seg_len = stop_idx - start_idx
            if seg_len <= 0:
                continue

            if ch.get("flow"):
                flow_frame = self._render_flow_channel(ch, t0, seg_len)
                if flow_frame is None:
                    continue
                any_active = True
                rendered_ranges.append((start_idx, stop_idx))
                master_buffer[start_idx * 3 : stop_idx * 3] = self._apply_offset(flow_frame, self._get_segment_offset(s_id))
                continue

            # Determine which effect to render: transient overlay or permanent baseline
            active_eff = None
            eff_elapsed = 0.0
            blend_with_baseline = False
            blend_factor = 0.0

            transient_eff = ch.get("transient_effect")
            baseline_eff = ch.get("baseline_effect")

            if transient_eff:
                elapsed = t0 - ch.get("transient_start_time", 0.0)
                dur = ch.get("transient_duration", 0.0)
                if elapsed < dur:
                    active_eff = transient_eff
                    eff_elapsed = elapsed
                    # Check smooth transition blend into baseline near end of transient effect
                    t_dur = transient_eff.transition_duration
                    if t_dur > 0.0 and baseline_eff and (dur - elapsed) <= t_dur:
                        blend_with_baseline = True
                        blend_factor = 1.0 - max(0.0, min(1.0, (dur - elapsed) / t_dur))
                else:
                    # Timed transient effect has expired -> revert to baseline!
                    ch["transient_effect"] = None

            # If no transient effect is active, check permanent baseline
            if not active_eff and baseline_eff:
                active_eff = baseline_eff
                eff_elapsed = t0 - ch.get("baseline_start_time", t0)

            if not active_eff or active_eff.animation == AnimationType.OFF:
                continue

            any_active = True
            rendered_ranges.append((start_idx, stop_idx))

            if blend_with_baseline and transient_eff and baseline_eff:
                t_buf = self._render_frame(transient_eff, frame, eff_elapsed, seg_len, baseline_eff=baseline_eff, s_id=s_id)
                base_elapsed = t0 - ch.get("baseline_start_time", t0)
                b_buf = self._render_frame(baseline_eff, frame, base_elapsed, seg_len, s_id=s_id)
                seg_rendered = blend_frames(t_buf, b_buf, blend_factor, transient_eff.transition)
                master_buffer[start_idx * 3 : stop_idx * 3] = self._apply_offset(seg_rendered, self._get_segment_offset(s_id))
            elif active_eff.animation == AnimationType.SOLID:
                c = active_eff.color_primary
                if (c.r, c.g, c.b) != (0, 0, 0):
                    ch["last_active_color"] = c
                for idx in range(start_idx, stop_idx):
                    master_buffer[idx * 3 + 0] = c.r
                    master_buffer[idx * 3 + 1] = c.g
                    master_buffer[idx * 3 + 2] = c.b
            else:
                seg_rendered = self._render_frame(active_eff, frame, eff_elapsed, seg_len, baseline_eff=baseline_eff, s_id=s_id)
                master_buffer[start_idx * 3 : stop_idx * 3] = self._apply_offset(seg_rendered, self._get_segment_offset(s_id))

        # Light strips without an active matrix event keep the default spotlight brightness
        pwm_val = self._current_pwm_brightness
        for pwm_index in self._get_pwm_led_indices():
            if pwm_index >= total_led_count or any(a <= pwm_index < b for a, b in rendered_ranges):
                continue
            master_buffer[pwm_index * 3 + 0] = pwm_val
            master_buffer[pwm_index * 3 + 1] = pwm_val
            master_buffer[pwm_index * 3 + 2] = pwm_val


        return master_buffer, any_active

    async def _run_master_broadcast_loop(self):
        """
        Unified 50 FPS real-time broadcast loop.
        Runs on the Rust LED engine (its own thread) when autoglow_core is installed, else here.
        """
        if self._rust_engine_enabled():
            return await self._run_rust_broadcast_loop()

        sock = self._get_socket()
        fps = 50
        dt = 1.0 / fps
        frame = 0
        dropped_packets: Dict[str, int] = {}
        last_send_error_log: Dict[str, float] = {}

        try:
            while True:
                t0 = time.time()
                # Re-read each frame so device config edits apply without restarting the stream
                ips_to_stream = [ip for ip in (self.target_ips if self.target_ips else [self.config.ip]) if ip]
                port = self.config.udp_port
                master_buffer, any_active = self._compose_frame(t0, frame, self._get_total_led_count())

                packets = self._create_udp_packets(bytes(master_buffer), timeout_sec=2)

                if self._frame_tap_callback:
                    try:
                        self._frame_tap_callback(bytes(master_buffer))
                    except Exception:
                        pass
                for ip in ips_to_stream:
                    try:
                        for packet in packets:
                            sock.sendto(packet, (ip, port))
                    except Exception as send_err:
                        dropped_packets[ip] = dropped_packets.get(ip, 0) + 1
                        now = time.time()
                        if now - last_send_error_log.get(ip, 0.0) >= 5.0:
                            last_send_error_log[ip] = now
                            logger.warning(
                                f"Failed to send UDP DRGB packet to {ip}:{port} "
                                f"({dropped_packets[ip]} dropped frames): {send_err}"
                            )
                            dropped_packets[ip] = 0

                # If no channels are active, stop broadcast task
                if not any_active:
                    break

                frame += 1
                compute_time = time.time() - t0
                sleep_time = max(0.001, dt - compute_time)
                await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Error in master broadcast loop")
        finally:
            self._master_broadcast_task = None

    # -------------------------------------------------------------------------
    # Rust LED engine (autoglow_core)
    # -------------------------------------------------------------------------
    def _rust_engine_enabled(self) -> bool:
        return _rust_core is not None

    def _get_rust_engine(self):
        if self._rust_engine is None:
            self._rust_engine = _rust_core.LedEngine()
        return self._rust_engine

    @staticmethod
    def _rust_effect(effect: Optional[EffectConfig]) -> Optional[Dict[str, Any]]:
        """An EffectConfig as the dict autoglow_core reads (Flow options normalized like render_flow_frame)."""
        if effect is None:
            return None
        anim = effect.animation.value if hasattr(effect.animation, "value") else str(effect.animation)
        c1, c2 = effect.color_primary, effect.color_secondary
        options = None
        if effect.options is not None:
            opts = {**_RUST_FLOW_DEFAULTS, **normalize_options(anim if anim in FLOW_RENDERERS else "solid", effect.options)}
            options = {"pulses": int(opts["pulses"]), "comets": int(opts["comets"]), "tail": str(opts["tail"]),
                       "sides": str(opts["sides"]), "palette": str(opts["palette"]), "amount": str(opts["amount"])}
        return {
            "animation": anim,
            "color_primary": (int(c1.r), int(c1.g), int(c1.b)),
            "color_secondary": (int(c2.r), int(c2.g), int(c2.b)),
            "dynamic_secondary": bool(effect.dynamic_secondary),
            "duration": float(effect.duration or 0.0),
            "speed": float(effect.speed),
            "reverse": bool(effect.reverse),
            "brightness": int(effect.brightness) if effect.brightness is not None else None,
            "transition": str(effect.transition),
            "transition_duration": float(effect.transition_duration),
            "options": options,
        }

    @staticmethod
    def _prune_finished_flow_parts(ch: Dict[str, Any], now: float) -> None:
        """Drop a finished fade, hit and locator, as _render_flow_channel does when it draws past their end."""
        fade = ch.get("fade")
        if fade and (now - fade["start"]) / fade["duration"] >= 1.0:
            ch["fade"] = None
        ov = ch.get("overlay")
        if ov and now - ov["start"] >= ov["duration"]:
            ch["overlay"] = None
        loc = ch.get("locator")
        if loc and now - loc["start"] >= loc["duration"]:
            ch["locator"] = None

    def _flow_last_base(self, segment_id: Optional[int], ch: Dict[str, Any]) -> Optional[bytes]:
        """The picture the segment's look showed last (the Rust thread keeps it while it runs)."""
        if not self._rust_engine_enabled():
            return ch.get("last_base")
        s_id = int(segment_id) if segment_id is not None else 0
        return self._get_rust_engine().last_base(s_id, int(ch.get("flow_session", 0)))

    def _rust_scene(self) -> Dict[str, Any]:
        """Everything the Rust loop renders from, read fresh like the Python loop does every frame."""
        now = time.time()
        channels = []
        for s_id, ch in list(self._segment_channels.items()):
            transient = ch.get("transient_effect")
            # Finished parts are cleared here, as the Python loop does, so play_effect / flow_show see the rest
            if transient and now - ch.get("transient_start_time", 0.0) >= ch.get("transient_duration", 0.0):
                ch["transient_effect"] = transient = None
            flow = bool(ch.get("flow"))
            fade = overlay = locator = None
            if flow:
                self._prune_finished_flow_parts(ch, now)
                f = ch.get("fade")
                if f:
                    acc = f.get("accent")
                    frame = f.get("frame")
                    fade = {"start": float(f["start"]), "duration": float(f["duration"]),
                            "style": normalize_transition_style(f["style"]),
                            "accent": tuple(int(v) for v in acc[:3]) if acc else None,
                            "frame": bytes(frame) if frame is not None else None,
                            "effect": self._rust_effect(f.get("effect")), "effect_start": float(f.get("effect_start", now))}
                ov = ch.get("overlay")
                if ov:
                    overlay = {"start": float(ov["start"]), "duration": float(ov["duration"]),
                               "strength": float(ov["strength"]), "layer": self._rust_effect(ov["layer"]),
                               "mask": self._rust_effect(ov["mask"]),
                               "brightness": int(ov["brightness"]) if ov.get("brightness") is not None else None}
                loc = ch.get("locator")
                if loc:
                    c = loc["color"]
                    locator = {"start": float(loc["start"]), "duration": float(loc["duration"]),
                               "position": float(loc["position"]), "color": (int(c.r), int(c.g), int(c.b))}
            last = ch.get("last_active_color")
            channels.append({
                "id": int(s_id),
                "start": int(ch.get("start_idx", 0)),
                "stop": int(ch.get("stop_idx", 0)),
                "offset": int(self._get_segment_offset(s_id)),
                "baseline": self._rust_effect(ch.get("baseline_effect")),
                "baseline_start": float(ch.get("baseline_start_time", now)),
                "transient": self._rust_effect(transient),
                "transient_start": float(ch.get("transient_start_time", 0.0)),
                "transient_duration": float(ch.get("transient_duration", 0.0)),
                "last_color": (int(last.r), int(last.g), int(last.b)) if last else None,
                "flow": flow,
                "flow_session": int(ch.get("flow_session", 0)),
                "fade": fade,
                "overlay": overlay,
                "locator": locator,
            })
        return {
            "targets": [ip for ip in (self.target_ips if self.target_ips else [self.config.ip]) if ip],
            "port": int(self.config.udp_port),
            "total": int(self._get_total_led_count()),
            "pwm_indices": [int(i) for i in self._get_pwm_led_indices()],
            "pwm_value": int(max(0, min(255, self._current_pwm_brightness))),
            "channels": channels,
        }

    def _sync_rust_engine(self, start: bool = False) -> None:
        """Hand the current channels to the Rust thread right away (and start it when asked)."""
        if not self._rust_engine_enabled():
            return
        try:
            engine = self._get_rust_engine()
            engine.update(self._rust_scene())
            if start:
                engine.ensure_running()
        except Exception:
            logger.exception("Rust LED engine update failed")

    async def _run_rust_broadcast_loop(self):
        """
        The frames are rendered and sent by the Rust thread; this task only keeps it fed: it passes
        config edits on, forwards frames to the simulator and logs send failures. When this event loop
        is busy the LEDs keep their 50 FPS, only these updates come a little later.
        """
        engine = self._get_rust_engine()
        try:
            engine.update(self._rust_scene())
            engine.ensure_running()
            while True:
                await asyncio.sleep(0.02)
                engine.update(self._rust_scene())
                frame = engine.take_frame()
                if frame is not None and self._frame_tap_callback:
                    try:
                        self._frame_tap_callback(frame)
                    except Exception:
                        pass
                for s_id, (r, g, b) in engine.take_last_colors().items():
                    ch = self._segment_channels.get(s_id)
                    if ch is not None:
                        ch["last_active_color"] = RGBColor(r, g, b)
                for msg in engine.take_errors():
                    logger.warning(msg)
                # The thread ends by itself once no channel is active, like the Python loop
                if not engine.running:
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Error in Rust LED engine loop")
        finally:
            engine.stop()
            self._master_broadcast_task = None

    def send_raw_frame(self, rgb_bytes: bytes) -> None:
        """
        Send a single raw RGB byte frame immediately over UDP to all targets and tap into WebSocket.
        """
        packets = self._create_udp_packets(rgb_bytes, timeout_sec=2)
        if self._frame_tap_callback:
            try:
                self._frame_tap_callback(rgb_bytes)
            except Exception:
                pass
        sock = self._get_socket()
        port = self.config.udp_port
        ips = [ip for ip in (self.target_ips if self.target_ips else [self.config.ip]) if ip]
        for ip in ips:
            try:
                for packet in packets:
                    sock.sendto(packet, (ip, port))
            except Exception:
                pass

    # -------------------------------------------------------------------------
    # Frame Renderers (Delegated to core.animations)
    # -------------------------------------------------------------------------
    def _resolve_effective_config(
        self,
        effect: EffectConfig,
        baseline_eff: Optional[EffectConfig] = None,
        s_id: int = 0
    ) -> EffectConfig:
        """
        If dynamic_secondary (Match Previous) is enabled, resolve the background/secondary color
        from the active baseline color, the last active color of the channel,
        or default to black if idle/off.
        """
        if not effect.dynamic_secondary:
            return effect

        dyn_bg: Optional[RGBColor] = None

        # 1. From active baseline effect (accept any non-OFF effect with a valid non-zero primary color)
        if baseline_eff and baseline_eff.animation != AnimationType.OFF and baseline_eff.color_primary:
            c = baseline_eff.color_primary
            if (c.r, c.g, c.b) != (0, 0, 0):
                dyn_bg = c

        # 2. From channel's recorded last active color
        if not dyn_bg:
            ch = self._segment_channels.get(s_id)
            if ch and ch.get("last_active_color"):
                c = ch["last_active_color"]
                if (c.r, c.g, c.b) != (0, 0, 0):
                    dyn_bg = c

        if not dyn_bg:
            dyn_bg = RGBColor(0, 0, 0)

        return dataclasses.replace(effect, color_secondary=dyn_bg)

    def _render_frame(
        self,
        effect: EffectConfig,
        frame: int,
        elapsed: float,
        count: int,
        baseline_eff: Optional[EffectConfig] = None,
        s_id: int = 0
    ) -> bytearray:
        resolved = self._resolve_effective_config(effect, baseline_eff, s_id=s_id)
        return render_animation_frame(resolved, frame, elapsed, count)

    @staticmethod
    def parse_wled_effect_metadata(fx_id: int, name: str, fxdata_str: str = "") -> Dict[str, Any]:
        """Parse WLED fxdata metadata string into structured effect parameters and color capabilities.
        
        fxdata format: <sliders>;<colors>;<palettes>;<flags>;<defaults>
        - Solid (id 0) defaults to ';!;' (1 color: Primary, no speed/intensity sliders, no palette)
        """
        raw = fxdata_str.strip() if fxdata_str else ""
        if fx_id == 0 and not raw:
            raw = ";!;"

        parts = raw.split(";") if raw else []
        default_names = ["Primary", "Secondary", "Tertiary"]
        color_slots: List[Dict[str, Any]] = []

        if len(parts) > 1 and parts[1]:
            color_tokens = parts[1].split(",")
            for s_idx in range(min(3, len(color_tokens))):
                tok = color_tokens[s_idx].strip()
                if tok:
                    label = tok if tok != "!" else default_names[s_idx]
                    color_slots.append({"slot": s_idx, "label": label})
        elif not raw:
            if fx_id == 0:
                color_slots = [{"slot": 0, "label": "Primary"}]
            else:
                color_slots = [{"slot": 0, "label": "Primary"}, {"slot": 1, "label": "Secondary"}]

        sliders_part = parts[0] if len(parts) > 0 else ""
        slider_tokens = [s.strip() for s in sliders_part.split(",")] if sliders_part else []

        speed_active = len(slider_tokens) > 0 and slider_tokens[0] != ""
        speed_label = "Speed"
        if speed_active and slider_tokens[0] != "!":
            speed_label = slider_tokens[0]

        intensity_active = len(slider_tokens) > 1 and slider_tokens[1] != ""
        intensity_label = "Intensity"
        if intensity_active and slider_tokens[1] != "!":
            intensity_label = slider_tokens[1]

        if not raw:
            if fx_id == 0:
                speed_active = False
                intensity_active = False
            else:
                speed_active = True
                intensity_active = True

        palette_part = parts[2] if len(parts) > 2 else ""
        palette_used = bool(palette_part and palette_part != "") or len(color_slots) == 0
        if fx_id == 0:
            palette_used = False

        return {
            "id": fx_id,
            "name": name,
            "fxdata": raw,
            "colors": len(color_slots),
            "colorSlots": color_slots,
            "speed": speed_active,
            "speedLabel": speed_label,
            "intensity": intensity_active,
            "intensityLabel": intensity_label,
            "palette": palette_used
        }

    @staticmethod
    def get_wled_effects_list(ip: str, timeout: float = 0.8) -> List[Dict[str, Any]]:
        """Fetch all native WLED effects and fxdata metadata with bundled catalog fallback."""
        eff_list = []
        fxdata_list = []

        if ip and is_host_online(ip, 80, timeout=0.3):
            try:
                # 1. Fetch effect names
                url_eff = f"http://{ip}/json/eff"
                req_eff = urllib.request.Request(url_eff)
                with urllib.request.urlopen(req_eff, timeout=timeout) as resp:
                    loaded_eff = json.loads(resp.read().decode())
                    if isinstance(loaded_eff, list) and len(loaded_eff) > 0:
                        eff_list = loaded_eff

                # 2. Fetch fxdata metadata
                url_fxd = f"http://{ip}/json/fxdata"
                req_fxd = urllib.request.Request(url_fxd)
                with urllib.request.urlopen(req_fxd, timeout=timeout) as resp:
                    loaded_fxd = json.loads(resp.read().decode())
                    if isinstance(loaded_fxd, list) and len(loaded_fxd) > 0:
                        fxdata_list = loaded_fxd
            except Exception as e:
                logger.warning(f"Error fetching live WLED effects/fxdata from {ip}: {e}")

        # If live fetch succeeded, parse and return
        if eff_list:
            result = []
            for idx, name in enumerate(eff_list):
                raw_fxd = fxdata_list[idx] if idx < len(fxdata_list) else ""
                result.append(WLEDDriver.parse_wled_effect_metadata(idx, str(name), str(raw_fxd)))
            return result

        # Fallback to bundled effects catalog (187 effects)
        try:
            bundled_path = os.path.join(os.path.dirname(__file__), "wled_effects_data.json")
            if os.path.exists(bundled_path):
                with open(bundled_path, "r", encoding="utf-8") as f:
                    bundled_items = json.load(f)
                    if isinstance(bundled_items, list) and len(bundled_items) > 0:
                        return [
                            WLEDDriver.parse_wled_effect_metadata(
                                item.get("id", i),
                                item.get("name", f"Effect {i}"),
                                item.get("fxdata", "")
                            )
                            for i, item in enumerate(bundled_items)
                        ]
        except Exception as e:
            logger.warning(f"Could not load bundled wled_effects_data.json: {e}")

        # Ultimate minimal fallback
        fallback = [
            "Solid", "Blink", "Breathe", "Wipe", "Wipe Random", "Random Colors", "Sweep",
            "Dynamic", "Colorloop", "Rainbow", "Scan", "Dual Scan", "Fade", "Chase",
            "Running", "Fire Flicker", "Aurora", "Sinelon", "Palette", "Popcorn"
        ]
        return [WLEDDriver.parse_wled_effect_metadata(idx, name, "") for idx, name in enumerate(fallback)]

    @staticmethod
    def get_wled_preset(ip: str, preset_id: int = 1, timeout: float = 0.8) -> Dict[str, Any]:
        """Fetch Preset data from /presets.json or /json/state."""
        if not ip:
            raise ValueError("No IP address specified")
        
        is_conn_error = False
        try:
            url_presets = f"http://{ip}/presets.json"
            req = urllib.request.Request(url_presets)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                presets = json.loads(resp.read().decode())
                key = str(preset_id)
                if isinstance(presets, dict) and key in presets:
                    preset_data = presets[key]
                    return {
                        "id": preset_id,
                        "name": preset_data.get("n", f"Preset {preset_id}"),
                        "on": preset_data.get("on", True),
                        "bri": preset_data.get("bri", 255),
                        "seg": [s for s in preset_data.get("seg", []) if isinstance(s, dict)]
                    }
        except Exception as e:
            logger.warning(f"Could not load presets.json from {ip}: {e}")
            err_str = str(e).lower()
            if "timeout" in err_str or "timed out" in err_str or "refused" in err_str or "unreachable" in err_str:
                is_conn_error = True

        # If the device timed out / unreachable, skip /json/state to avoid doubling timeout latency
        if not is_conn_error:
            try:
                url_state = f"http://{ip}/json/state"
                req = urllib.request.Request(url_state)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    state = json.loads(resp.read().decode())
                    return {
                        "id": preset_id,
                        "name": f"Preset {preset_id}",
                        "on": state.get("on", True),
                        "bri": state.get("bri", 255),
                        "seg": [s for s in state.get("seg", []) if isinstance(s, dict)]
                    }
            except Exception as e:
                logger.warning(f"Failed to fetch WLED state for preset from {ip}: {e}")

        return {"id": preset_id, "name": f"Preset {preset_id}", "on": True, "bri": 255, "seg": []}

    @staticmethod
    def preview_wled_state(ip: str, payload: Dict[str, Any], timeout: float = 2.0) -> bool:
        """Push an immediate preview state to WLED without saving to preset."""
        if not ip:
            raise ValueError("No IP address specified")
        ip_clean = ip.strip()
        if not is_host_online(ip_clean, 80, timeout=0.3):
            logger.debug(f"WLED controller at {ip_clean} is offline (TCP pre-check failed)")
            return False
        url = f"http://{ip_clean}/json/state"
        body = {
            "on": payload.get("on", True),
            "bri": payload.get("bri", 255),
            "transition": payload.get("transition", 0),
            "lor": 0,
            "v": True
        }
        if "ps" in payload:
            body["ps"] = payload["ps"]
        if "seg" in payload:
            body["seg"] = payload["seg"]
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
        return True

    @staticmethod
    def rename_wled_segment(ip: str, seg_id: int, name: str, timeout: float = 2.5) -> None:
        """Rename one segment live, and in preset 1 (the idle and boot look) when it holds that segment.
        Re-saving preset 1 keeps its look; only the segment's name changes."""
        def post_state(body: dict) -> None:
            req = urllib.request.Request(
                f"http://{ip}/json/state",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read()

        post_state({"seg": [{"id": seg_id, "n": name}]})
        try:
            with urllib.request.urlopen(f"http://{ip}/presets.json", timeout=timeout) as resp:
                presets = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.warning(f"Renamed segment {seg_id} on {ip} live, but could not read its presets: {e}")
            return
        preset = presets.get("1") if isinstance(presets, dict) else None
        segs = [s for s in (preset or {}).get("seg", []) if isinstance(s, dict)]
        if not any(_safe_seg_id(s) == seg_id for s in segs):
            return
        for s in segs:
            if _safe_seg_id(s) == seg_id:
                s["n"] = name
        WLEDDriver.save_wled_preset(
            ip, 1, str(preset.get("n") or "AutoGlow Default"), segs,
            int(preset.get("bri", 255)), boot_default=True, timeout=timeout
        )

    @staticmethod
    def save_wled_preset(
        ip: str,
        preset_id: int = 1,
        name: str = "AutoGlow Default",
        segments: Optional[List[Dict[str, Any]]] = None,
        bri: int = 255,
        boot_default: bool = True,
        timeout: float = 2.5
    ) -> bool:
        """
        Save complete multi-segment preset to WLED (psave: preset_id, ib: True)
        and optionally configure def.ps in WLED hardware config.
        """
        if not ip:
            raise ValueError("No IP address specified")

        url = f"http://{ip}/json/state"
        payload = {
            "on": True,
            "bri": max(0, min(255, bri)),
            "transition": 0,
            "psave": preset_id,
            "n": name,
            "ib": True,  # Include brightness
            "sb": True,  # Include segment bounds (start and stop indices)
            "lor": 0,
            "v": True
        }
        if segments:
            payload["seg"] = segments

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()

        if boot_default:
            try:
                cfg_url = f"http://{ip}/json/cfg"
                cfg_payload = {"def": {"ps": preset_id, "on": True, "bri": max(0, min(255, bri))}}
                cfg_req = urllib.request.Request(
                    cfg_url,
                    data=json.dumps(cfg_payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(cfg_req, timeout=timeout) as resp:
                    resp.read()
            except Exception as e:
                logger.warning(f"Could not set boot preset in cfg on {ip}: {e}")

        # Stage 1 Verification: Confirm segment bounds are committed to presets.json
        if segments and len(segments) > 1:
            try:
                time.sleep(0.08)  # Allow WLED littleFS write to settle
                presets_url = f"http://{ip}/presets.json"
                req_p = urllib.request.Request(presets_url)
                with urllib.request.urlopen(req_p, timeout=timeout) as r:
                    p_data = json.loads(r.read().decode("utf-8"))
                    saved_p = p_data.get(str(preset_id), {})
                    saved_segs = saved_p.get("seg", [])
                    active_saved = [s for s in saved_segs if isinstance(s, dict) and s.get("id") is not None]
                    missing_bounds = [
                        s.get("id") for s in active_saved
                        if s.get("start") is None or s.get("stop") is None
                    ]
                    if missing_bounds:
                        logger.warning(
                            f"Preset {preset_id} on {ip} saved without bounds on segments {missing_bounds}! Re-saving with explicit sb: True..."
                        )
                        payload["sb"] = True
                        payload["ib"] = True
                        retry_req = urllib.request.Request(
                            url,
                            data=json.dumps(payload).encode("utf-8"),
                            headers={"Content-Type": "application/json"}
                        )
                        with urllib.request.urlopen(retry_req, timeout=timeout) as retry_resp:
                            retry_resp.read()
                    else:
                        logger.info(f"Verified Preset {preset_id} on {ip} has valid multi-segment bounds in presets.json.")
            except Exception as pe:
                logger.debug(f"Could not verify presets.json on {ip}: {pe}")

        return True

