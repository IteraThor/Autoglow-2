"""
AutoGlow 2 - Core Domain Models
Clean, typed dataclasses for game events, device configuration, effects, and profiles.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Tuple, Any


def _safe_int(val: Any, default: int = 0) -> int:
    """Safely cast any value to int, handling NoneType and invalid formats gracefully."""
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Safely cast any value to float, handling NoneType and invalid formats gracefully."""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


class ProtocolMode(str, Enum):
    IDLE_HTTP = "http"
    ACTIVE_UDP = "udp"


class LightingMode(str, Enum):
    MATRIX = "matrix"
    FLOW = "flow"


class DartEventType(str, Enum):
    DART_THROWN = "dart_thrown"
    SCORE_180 = "180"
    TRIPLE = "triple"
    DOUBLE = "double"
    SINGLE = "single"
    BULLSEYE = "bullseye"
    BUST = "bust"
    LEG_WON = "leg_won"
    MATCH_WON = "match_won"
    TURN_CHANGE = "turn_change"
    GAME_START = "game_start"
    GAME_FINISH = "game_finish"
    GAME_IDLE = "game_idle"
    CALIBRATING = "calibrating"
    TAKEOUT = "takeout"
    TAKEOUT_IN_PROGRESS = "takeout_in_progress"
    MANUAL_RESET = "manual_reset"
    THROW = "throw"


class NameMatchType(str, Enum):
    CONTAINS = "contains"
    EXACT = "exact"


class AnimationType(str, Enum):
    CHASE = "chase"
    RAINBOW = "rainbow"
    PASTEL_RAINBOW = "pastel_rainbow"
    FLASH = "flash"
    CURTAIN = "curtain"
    HEARTBEAT = "heartbeat"
    PULSE = "pulse"
    SOLID = "solid"
    WIPE = "wipe"
    BREATHE = "breathe"
    SCAN = "scan"
    COMET = "comet"
    DUAL_COMET = "dual_comet"
    SPARKLE = "sparkle"
    FIRE = "fire"
    RADAR = "radar"
    OFF = "off"


@dataclass
class RGBColor:
    r: int = 255
    g: int = 255
    b: int = 255

    def to_tuple(self) -> Tuple[int, int, int]:
        return (self.r, self.g, self.b)

    def to_list(self) -> List[int]:
        return [self.r, self.g, self.b]

    def to_dict(self) -> Dict[str, int]:
        return {"r": self.r, "g": self.g, "b": self.b}

    @classmethod
    def from_dict(cls, val: Any, default: Optional["RGBColor"] = None) -> "RGBColor":
        default_color = default or cls(255, 255, 255)
        if isinstance(val, RGBColor):
            return val
        if isinstance(val, dict):
            return cls(
                r=_safe_int(val.get("r"), default_color.r),
                g=_safe_int(val.get("g"), default_color.g),
                b=_safe_int(val.get("b"), default_color.b)
            )
        if isinstance(val, (list, tuple)) and len(val) >= 3:
            try:
                return cls(r=_safe_int(val[0], default_color.r), g=_safe_int(val[1], default_color.g), b=_safe_int(val[2], default_color.b))
            except (ValueError, TypeError):
                return default_color
        if isinstance(val, str) and val.startswith("#") and len(val) >= 7:
            try:
                return cls(
                    r=int(val[1:3], 16),
                    g=int(val[3:5], 16),
                    b=int(val[5:7], 16)
                )
            except ValueError:
                return default_color
        return default_color


@dataclass
class EffectConfig:
    animation: AnimationType = AnimationType.SOLID
    color_primary: RGBColor = field(default_factory=lambda: RGBColor(0, 255, 0))
    color_secondary: RGBColor = field(default_factory=lambda: RGBColor(0, 0, 0))
    color_tertiary: RGBColor = field(default_factory=lambda: RGBColor(0, 0, 0))
    dynamic_secondary: bool = False         # Match Previous: dynamically inherit active baseline/throw color
    duration: float = 2.0  # seconds
    speed: float = 1.0     # multiplier
    fps: int = 50          # frame rate
    reverse: bool = False
    enabled: bool = True
    brightness: Optional[int] = None
    transition: str = "instant"             # "instant", "crossfade", "wipe"
    transition_duration: float = 0.0        # seconds for reversion blend
    wled_effect_id: Optional[int] = None    # Native WLED HTTP effect ID (e.g. 2 for Breathe)
    wled_effect_name: Optional[str] = None  # Native WLED HTTP effect name (e.g. "Breathe")

    def to_dict(self) -> Dict[str, Any]:
        out = {
            "animation": self.animation.value if hasattr(self.animation, "value") else str(self.animation),
            "color_primary": self.color_primary.to_list(),
            "color_secondary": self.color_secondary.to_list(),
            "color_tertiary": self.color_tertiary.to_list(),
            "dynamic_secondary": bool(self.dynamic_secondary),
            "duration": float(self.duration),
            "speed": float(self.speed),
            "fps": int(self.fps),
            "reverse": bool(self.reverse),
            "enabled": bool(self.enabled),
            "transition": str(self.transition),
            "transition_duration": float(self.transition_duration)
        }
        if self.brightness is not None:
            out["brightness"] = int(self.brightness)
        if self.wled_effect_id is not None:
            out["wled_effect_id"] = int(self.wled_effect_id)
        if self.wled_effect_name is not None:
            out["wled_effect_name"] = str(self.wled_effect_name)
        return out

    @classmethod
    def from_dict(cls, data: Any) -> "EffectConfig":
        if isinstance(data, EffectConfig):
            return data
        if not isinstance(data, dict):
            return cls()

        anim_str = str(data.get("animation", "solid")).lower()
        anim_enum = AnimationType(anim_str) if anim_str in [a.value for a in AnimationType] else AnimationType.SOLID

        col_primary_raw = data.get("color_primary") or data.get("color", [0, 255, 0])
        col_sec_raw = data.get("color_secondary", [0, 0, 0])
        col_ter_raw = data.get("color_tertiary", [0, 0, 0])
        raw_bri = data.get("brightness")
        raw_wled_id = data.get("wled_effect_id")
        raw_wled_name = data.get("wled_effect_name")

        return cls(
            animation=anim_enum,
            color_primary=RGBColor.from_dict(col_primary_raw, default=RGBColor(0, 255, 0)),
            color_secondary=RGBColor.from_dict(col_sec_raw, default=RGBColor(0, 0, 0)),
            color_tertiary=RGBColor.from_dict(col_ter_raw, default=RGBColor(0, 0, 0)),
            dynamic_secondary=bool(data.get("dynamic_secondary", False)),
            duration=_safe_float(data.get("duration"), 2.0),
            speed=_safe_float(data.get("speed"), 1.0),
            fps=_safe_int(data.get("fps"), 50),
            reverse=bool(data.get("reverse", False)),
            enabled=bool(data.get("enabled", True)),
            brightness=_safe_int(raw_bri) if raw_bri is not None else None,
            transition=str(data.get("transition", "instant")),
            transition_duration=_safe_float(data.get("transition_duration"), 0.0),
            wled_effect_id=_safe_int(raw_wled_id) if raw_wled_id is not None else None,
            wled_effect_name=str(raw_wled_name) if raw_wled_name is not None else None
        )



@dataclass
class PlayerSlotConfig:
    id: int  # 1 to 10
    name_filter: str = ""
    match_type: NameMatchType = NameMatchType.CONTAINS
    effect: EffectConfig = field(default_factory=lambda: EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 180, 255), duration=0.0, enabled=True))
    enabled: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name_filter": self.name_filter,
            "match_type": self.match_type.value if hasattr(self.match_type, "value") else str(self.match_type),
            "effect": self.effect.to_dict() if hasattr(self.effect, "to_dict") else dict(self.effect),
            "enabled": self.enabled
        }

    @classmethod
    def from_dict(cls, data: Any, default_id: int = 1) -> "PlayerSlotConfig":
        if isinstance(data, PlayerSlotConfig):
            return data
        if not isinstance(data, dict):
            return cls(id=default_id)

        match_str = str(data.get("match_type", "contains")).lower()
        match_type = NameMatchType.EXACT if match_str == "exact" else NameMatchType.CONTAINS

        effect_data = data.get("effect", {})
        effect = EffectConfig.from_dict(effect_data)

        raw_en = data.get("enabled")
        if raw_en is not None:
            is_enabled = bool(raw_en)
        else:
            is_enabled = bool(effect.enabled) if effect else True

        if effect:
            effect.enabled = is_enabled

        return cls(
            id=_safe_int(data.get("id"), default_id),
            name_filter=str(data.get("name_filter", "")),
            match_type=match_type,
            effect=effect,
            enabled=is_enabled
        )


@dataclass
class SegmentConfig:
    id: int = 0
    name: str = "Segment 0"
    type: str = "WS281x"
    gpio: str = "GPIO 33"
    start: int = 0
    length: int = 45
    role: str = "dartboard_ring"  # "dartboard_ring", "white_illumination", "ambient"
    hw_key: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out = {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "gpio": self.gpio,
            "start": self.start,
            "length": self.length,
            "role": self.role
        }
        if self.hw_key:
            out["hw_key"] = self.hw_key
        return out

    @classmethod
    def from_dict(cls, data: Any, default_id: int = 0) -> "SegmentConfig":
        if isinstance(data, SegmentConfig):
            return data
        if not isinstance(data, dict):
            return cls(id=default_id)

        seg_id = _safe_int(data.get("id"), default_id)
        name = str(data.get("name") or data.get("n") or f"Segment {seg_id}")
        seg_type = str(data.get("type", "WS281x"))
        gpio = str(data.get("gpio", ""))
        start = _safe_int(data.get("start"), 0)

        if data.get("length") is not None:
            length = max(1, _safe_int(data["length"], 15))
        elif data.get("len") is not None:
            length = max(1, _safe_int(data["len"], 15))
        elif data.get("stop") is not None:
            length = max(1, _safe_int(data["stop"], start + 15) - start)
        else:
            length = 15

        role = str(data.get("role", "dartboard_ring"))
        hw_key = data.get("hw_key")
        return cls(id=seg_id, name=name, type=seg_type, gpio=gpio, start=start, length=length, role=role, hw_key=hw_key)


@dataclass
class DeviceConfig:
    id: str = "default_device"
    name: str = "Main Dartboard WLED"
    ip: str = "192.168.2.214"
    udp_port: int = 21324
    rgb_count: int = 45
    pwm_index: Optional[int] = 45
    pwm_seg_id: Optional[int] = 1
    default_pwm_brightness: int = 200
    idle_dim_seconds: int = 300       # 5 minutes -> dim
    idle_dim_brightness: int = 40
    idle_off_seconds: int = 1800      # 30 minutes -> off
    enabled: bool = True
    led_rotation: int = 0             # rotation in degrees (0..360) for LED 0 / cable entry
    led0_offset: int = 0              # discrete sector offset (0..rgb_count-1) indicating where physical LED 0 / cable starts
    segments: List[SegmentConfig] = field(default_factory=list)
    hw_ins: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "ip": self.ip,
            "udp_port": self.udp_port,
            "rgb_count": self.rgb_count,
            "pwm_index": self.pwm_index,
            "pwm_seg_id": self.pwm_seg_id,
            "default_pwm_brightness": self.default_pwm_brightness,
            "idle_dim_seconds": self.idle_dim_seconds,
            "idle_dim_brightness": self.idle_dim_brightness,
            "idle_off_seconds": self.idle_off_seconds,
            "enabled": self.enabled,
            "led_rotation": self.led_rotation,
            "led0_offset": self.led0_offset,
            "segments": [s.to_dict() if hasattr(s, "to_dict") else dict(s) for s in self.segments],
            "hw_ins": self.hw_ins
        }

    @classmethod
    def from_dict(cls, data: Any, default_id: str = "default_device", default_pwm: int = 200) -> "DeviceConfig":
        if isinstance(data, DeviceConfig):
            return data
        if not isinstance(data, dict):
            return cls(id=default_id)

        segments = [
            SegmentConfig.from_dict(s, default_id=s_idx)
            for s_idx, s in enumerate(data.get("segments", []))
            if isinstance(s, (dict, SegmentConfig))
        ]

        hw_ins = data.get("hw_ins", [])
        if not isinstance(hw_ins, list):
            hw_ins = []

        raw_pwm_idx = data.get("pwm_index")
        pwm_index = _safe_int(raw_pwm_idx) if raw_pwm_idx is not None else None

        raw_pwm_seg = data.get("pwm_seg_id")
        pwm_seg_id = _safe_int(raw_pwm_seg) if raw_pwm_seg is not None else None

        raw_rot = data.get("led_rotation")
        raw_offset = _safe_int(data.get("led0_offset"), 0)
        led_rotation = _safe_int(raw_rot, int(round((raw_offset / 45.0) * 360.0))) if raw_rot is not None else int(round((raw_offset / 45.0) * 360.0))

        return cls(
            id=str(data.get("id", default_id)),
            name=str(data.get("name", "Main Dartboard WLED")),
            ip=str(data.get("ip", "")),
            udp_port=_safe_int(data.get("udp_port"), 21324),
            rgb_count=_safe_int(data.get("rgb_count"), 45),
            pwm_index=pwm_index,
            pwm_seg_id=pwm_seg_id,
            default_pwm_brightness=_safe_int(data.get("default_pwm_brightness"), _safe_int(default_pwm, 200)),
            idle_dim_seconds=_safe_int(data.get("idle_dim_seconds"), 300),
            idle_dim_brightness=_safe_int(data.get("idle_dim_brightness"), 40),
            idle_off_seconds=_safe_int(data.get("idle_off_seconds"), 1800),
            enabled=bool(data.get("enabled", True)),
            led_rotation=led_rotation,
            led0_offset=raw_offset,
            segments=segments,
            hw_ins=hw_ins
        )


@dataclass
class DartEvent:
    event_type: DartEventType
    score: int = 0
    multiplier: int = 1
    segment_number: Optional[int] = None
    segment_name: Optional[str] = None
    player_name: Optional[str] = None
    player_index: Optional[int] = None
    round_score: Optional[int] = None
    board_id: Optional[str] = None


@dataclass
class ProfileConfig:
    name: str = "Default"
    events: Dict[str, EffectConfig] = field(default_factory=dict)
    device_events: Dict[str, Dict[str, Dict[str, EffectConfig]]] = field(default_factory=dict)
    player_slots: List[PlayerSlotConfig] = field(default_factory=list)

    def get_effect(self, event_key: str, ip: Optional[str] = None, seg_id: Optional[Any] = None, hw_key: Optional[str] = None) -> Optional[EffectConfig]:
        """Lookup effect by specific device & segment (checking hw_key first, then seg_id), falling back to global profile default."""
        alt_key = "calibrating" if event_key == "calibration" else ("calibration" if event_key == "calibrating" else None)
        if ip and (seg_id is not None or hw_key is not None):
            dev_map = self.device_events.get(ip, {})
            # 1. Hardware Key Anchor Lookup (e.g. gpio_16_pwm_45)
            if hw_key and hw_key in dev_map:
                if event_key in dev_map[hw_key]:
                    return dev_map[hw_key][event_key]
                if alt_key and alt_key in dev_map[hw_key]:
                    return dev_map[hw_key][alt_key]
            # 2. Numerical Index Lookup (e.g. "0", "1")
            if seg_id is not None:
                seg_str = str(seg_id)
                if seg_str in dev_map:
                    if event_key in dev_map[seg_str]:
                        return dev_map[seg_str][event_key]
                    if alt_key and alt_key in dev_map[seg_str]:
                        return dev_map[seg_str][alt_key]
            # Specific segment has no override: do not leak global events across segments
            return None
        eff = self.events.get(event_key)
        if not eff and alt_key:
            eff = self.events.get(alt_key)
        return eff

    def resolve_player_effect(
        self,
        player_name: Optional[str] = None,
        player_index: Optional[int] = None,
        match_players: Optional[List[str]] = None,
        ip: Optional[str] = None,
        seg_id: Optional[Any] = None,
        hw_key: Optional[str] = None
    ) -> Optional[EffectConfig]:
        """
        Resolve the active throwing effect for a player on a specific device & segment:
        1. Exact Name Match (case-insensitive) across player slots.
        2. Contains Name Match (case-insensitive) across player slots.
        3. Dynamic Slot Fallback: Unnamed match players claim available slots sequentially.
        4. Slot Index Fallback: player_index maps to slot id.
        5. Global Base Fallback: default 'throw' effect.

        After matching to slot ID (e.g. 1), checks if (ip, seg_id/hw_key) has a segment-specific
        override in device_events[ip].
        """
        all_slots = self.player_slots or self.get_default_player_slots()

        p_name = player_name.strip().lower() if (player_name and player_name.strip()) else ""
        p_idx = player_index if (player_index is not None and player_index >= 0) else 0

        target_slot: Optional[PlayerSlotConfig] = None

        # Stage 1: Exact Name Match
        if p_name:
            for slot in all_slots:
                filt = slot.name_filter.strip().lower()
                if filt and slot.match_type == NameMatchType.EXACT and p_name == filt:
                    target_slot = slot
                    break

        # Stage 2: Contains Name Match
        if not target_slot and p_name:
            for slot in all_slots:
                filt = slot.name_filter.strip().lower()
                if filt and slot.match_type == NameMatchType.CONTAINS and filt in p_name:
                    target_slot = slot
                    break

        # Stage 3: Dynamic Slot Allocation for Unnamed Players in Match
        if not target_slot and match_players:
            claimed_slot_ids = set()
            for m_p in match_players:
                m_name = m_p.strip().lower() if m_p else ""
                if not m_name:
                    continue
                # Check exact
                for slot in all_slots:
                    filt = slot.name_filter.strip().lower()
                    if filt and slot.match_type == NameMatchType.EXACT and m_name == filt:
                        claimed_slot_ids.add(slot.id)
                        break
                # Check contains if not yet claimed
                for slot in all_slots:
                    if slot.id in claimed_slot_ids:
                        continue
                    filt = slot.name_filter.strip().lower()
                    if filt and slot.match_type == NameMatchType.CONTAINS and filt in m_name:
                        claimed_slot_ids.add(slot.id)
                        break

            unallocated_slots = [s for s in all_slots if s.id not in claimed_slot_ids]
            if unallocated_slots:
                unnamed_rank = 0
                for i in range(min(p_idx, len(match_players))):
                    prev_name = match_players[i].strip().lower() if match_players[i] else ""
                    is_named = any(
                        s.name_filter.strip().lower() and (
                            (s.match_type == NameMatchType.EXACT and prev_name == s.name_filter.strip().lower()) or
                            (s.match_type == NameMatchType.CONTAINS and s.name_filter.strip().lower() in prev_name)
                        )
                        for s in all_slots
                    )
                    if not is_named:
                        unnamed_rank += 1
                target_slot = unallocated_slots[unnamed_rank % len(unallocated_slots)]

        # Stage 4: Index-based slot lookup (Player 1 -> Slot 1)
        if not target_slot:
            target_slot = next((s for s in all_slots if s.id == (p_idx + 1)), None)

        if not target_slot and all_slots:
            target_slot = all_slots[p_idx % len(all_slots)]

        slot_id = target_slot.id if target_slot else (p_idx + 1)

        # Check per-device & per-segment override for this player slot (hw_key first, then seg_id)
        if ip and (seg_id is not None or hw_key is not None):
            dev_map = self.device_events.get(ip, {})
            slot_key = f"player_{slot_id}"

            # 1. Check Hardware Key Anchor (e.g. gpio_16_pwm_45)
            if hw_key and hw_key in dev_map:
                seg_map = dev_map[hw_key]
                if slot_key in seg_map:
                    slot_eff = seg_map[slot_key]
                    if slot_eff.enabled:
                        return slot_eff
                    has_other_player_enabled = any(k.startswith("player_") and k != slot_key and v.enabled for k, v in seg_map.items())
                    if not has_other_player_enabled and DartEventType.THROW.value in seg_map and seg_map[DartEventType.THROW.value].enabled:
                        return seg_map[DartEventType.THROW.value]
                    return slot_eff
                if DartEventType.THROW.value in seg_map and seg_map[DartEventType.THROW.value].enabled:
                    return seg_map[DartEventType.THROW.value]

            # 2. Check Numeric Index Fallback
            if seg_id is not None:
                seg_str = str(seg_id)
                if seg_str in dev_map:
                    seg_map = dev_map[seg_str]
                    if slot_key in seg_map:
                        slot_eff = seg_map[slot_key]
                        if slot_eff.enabled:
                            return slot_eff
                        has_other_player_enabled = any(k.startswith("player_") and k != slot_key and v.enabled for k, v in seg_map.items())
                        if not has_other_player_enabled and DartEventType.THROW.value in seg_map and seg_map[DartEventType.THROW.value].enabled:
                            return seg_map[DartEventType.THROW.value]
                        return slot_eff
                    if DartEventType.THROW.value in seg_map and seg_map[DartEventType.THROW.value].enabled:
                        return seg_map[DartEventType.THROW.value]

            # Specific segment has no player slot or throw override: do not leak global player slots
            return None

        if target_slot and target_slot.enabled and target_slot.effect and target_slot.effect.enabled:
            return target_slot.effect

        enabled_slots = [s for s in all_slots if s.enabled and s.effect and s.effect.enabled]
        if not enabled_slots:
            return self.get_effect(DartEventType.THROW.value, ip=ip, seg_id=seg_id, hw_key=hw_key)

        return EffectConfig(enabled=False)

    def to_dict(self) -> Dict[str, Any]:
        prof_events = {k: v.to_dict() for k, v in self.events.items()}
        prof_dev_events = {}
        for dev_ip, seg_map in self.device_events.items():
            if isinstance(seg_map, dict):
                prof_dev_events[dev_ip] = {}
                for seg_id, evt_map in seg_map.items():
                    if isinstance(evt_map, dict):
                        prof_dev_events[dev_ip][str(seg_id)] = {
                            k: v.to_dict() if isinstance(v, EffectConfig) else dict(v)
                            for k, v in evt_map.items()
                        }
        return {
            "name": self.name,
            "events": prof_events,
            "device_events": prof_dev_events,
            "player_slots": [s.to_dict() for s in self.player_slots]
        }

    @classmethod
    def from_dict(cls, data: Any) -> "ProfileConfig":
        if isinstance(data, ProfileConfig):
            return data
        profile = cls.get_default_profile()
        if not isinstance(data, dict):
            return profile

        profile.name = str(data.get("name", "Default"))
        if "events" in data and isinstance(data["events"], dict):
            for k, v in data["events"].items():
                profile.events[k] = EffectConfig.from_dict(v)

        if "device_events" in data and isinstance(data["device_events"], dict):
            profile.device_events = {}
            for dev_ip, seg_map in data["device_events"].items():
                if isinstance(seg_map, dict):
                    profile.device_events[dev_ip] = {}
                    for seg_id, evt_map in seg_map.items():
                        if isinstance(evt_map, dict):
                            profile.device_events[dev_ip][str(seg_id)] = {
                                k: EffectConfig.from_dict(v) for k, v in evt_map.items()
                            }

        if "player_slots" in data and isinstance(data["player_slots"], list):
            profile.player_slots = [
                PlayerSlotConfig.from_dict(s, default_id=s_idx + 1)
                for s_idx, s in enumerate(data["player_slots"])
            ]
        return profile

    @classmethod
    def get_default_player_slots(cls, autodarts_name: Optional[str] = None) -> List[PlayerSlotConfig]:
        p1_filter = autodarts_name.strip() if (autodarts_name and isinstance(autodarts_name, str)) else ""
        return [
            PlayerSlotConfig(
                id=s_id,
                name_filter=p1_filter if s_id == 1 else "",
                match_type=NameMatchType.CONTAINS,
                effect=EffectConfig(
                    animation=AnimationType.SOLID,
                    color_primary=RGBColor(0, 0, 0),
                    duration=0.0,
                    enabled=False
                ),
                enabled=False
            )
            for s_id in range(1, 11)
        ]

    @classmethod
    def get_default_profile(cls) -> "ProfileConfig":
        profile = cls(name="Default")
        profile.events = {
            DartEventType.SCORE_180.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.MATCH_WON.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.LEG_WON.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.BUST.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.TRIPLE.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.DOUBLE.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.SINGLE.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.BULLSEYE.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.GAME_START.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.CALIBRATING.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.TAKEOUT.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.TAKEOUT_IN_PROGRESS.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.MANUAL_RESET.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            ),
            DartEventType.THROW.value: EffectConfig(
                animation=AnimationType.SOLID,
                color_primary=RGBColor(0, 0, 0),
                duration=0.0,
                speed=1.0,
                enabled=False
            )
        }
        profile.player_slots = cls.get_default_player_slots()
        return profile


@dataclass
class AppConfig:
    devices: List[DeviceConfig] = field(default_factory=list)
    profile: ProfileConfig = field(default_factory=ProfileConfig.get_default_profile)
    profiles: List[ProfileConfig] = field(default_factory=list)
    active_profile: str = "Default"
    global_brightness: int = 200
    wifi_ip: str = "192.168.2.214"
    autodarts_user: str = ""
    autodarts_password: str = ""
    autodarts_board_id: str = ""
    game_mode_spotlight_brightness: int = 255
    lighting_mode: LightingMode = LightingMode.MATRIX
    auto_connect_udp_on_game_start: bool = True
    disconnect_udp_on_match_end: bool = False
    inactivity_timeout_enabled: bool = True
    inactivity_timeout_minutes: int = 5
    idle_power_off_enabled: bool = True
    idle_power_off_minutes: int = 30
    idle_dimming_brightness: int = 50
    standby_board_offline_enabled: bool = False
    standby_board_offline_id: str = ""
    standby_board_offline_delay_seconds: int = 10
    extra: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.profiles:
            if self.profile:
                self.profiles = [self.profile]
                self.active_profile = self.profile.name or "Default"
            else:
                default_p = ProfileConfig.get_default_profile()
                self.profiles = [default_p]
                self.profile = default_p
                self.active_profile = default_p.name
        else:
            active_match = next((p for p in self.profiles if p.name == self.active_profile), None)
            if active_match:
                self.profile = active_match
            else:
                self.profile = self.profiles[0]
                self.active_profile = self.profile.name

    def get_profile(self, name: str) -> Optional[ProfileConfig]:
        for p in self.profiles:
            if p.name == name:
                return p
        return None

    def set_active_profile(self, name: str) -> bool:
        target = self.get_profile(name)
        if target:
            self.active_profile = name
            self.profile = target
            return True
        return False

    def add_or_update_profile(self, profile: ProfileConfig, set_active: bool = True) -> None:
        for idx, p in enumerate(self.profiles):
            if p.name == profile.name:
                self.profiles[idx] = profile
                if set_active or self.active_profile == profile.name:
                    self.active_profile = profile.name
                    self.profile = profile
                return
        self.profiles.append(profile)
        if set_active:
            self.active_profile = profile.name
            self.profile = profile

    @property
    def primary_device(self) -> Optional[DeviceConfig]:
        if self.devices and len(self.devices) > 0:
            return self.devices[0]
        return None

    @property
    def active_ips(self) -> List[str]:
        """List of all configured and enabled device IP addresses."""
        ips = [d.ip.strip() for d in self.devices if d and d.enabled and d.ip and d.ip.strip()]
        if not ips and self.wifi_ip and self.wifi_ip.strip():
            ips = [self.wifi_ip.strip()]
        return ips

    def to_dict(self) -> Dict[str, Any]:
        """Convert entire app configuration to a clean JSON-serializable dictionary."""
        if not self.profiles:
            if self.profile:
                self.profiles = [self.profile]
            else:
                self.profiles = [ProfileConfig.get_default_profile()]

        # Ensure active_profile is valid and self.profile points to active profile
        active_p = next((p for p in self.profiles if p.name == self.active_profile), None)
        if not active_p:
            active_p = self.profiles[0]
            self.active_profile = active_p.name
        self.profile = active_p

        out = {
            "devices": [d.to_dict() for d in self.devices],
            "profiles": [p.to_dict() for p in self.profiles],
            "active_profile": self.active_profile,
            "profile": self.profile.to_dict(),
            "global_brightness": self.global_brightness,
            "wifi_ip": self.devices[0].ip if self.devices else self.wifi_ip,
            "autodarts_user": self.autodarts_user,
            "autodarts_password": self.autodarts_password,
            "autodarts_board_id": self.autodarts_board_id,
            "game_mode_spotlight_brightness": self.game_mode_spotlight_brightness,
            "lighting_mode": self.lighting_mode.value if isinstance(self.lighting_mode, LightingMode) else str(self.lighting_mode or "matrix"),
            "auto_connect_udp_on_game_start": self.auto_connect_udp_on_game_start,
            "disconnect_udp_on_match_end": self.disconnect_udp_on_match_end,
            "inactivity_timeout_enabled": self.inactivity_timeout_enabled,
            "inactivity_timeout_minutes": self.inactivity_timeout_minutes,
            "idle_power_off_enabled": self.idle_power_off_enabled,
            "idle_dimming_brightness": self.idle_dimming_brightness,
            "idle_power_off_minutes": self.idle_power_off_minutes,
            "standby_board_offline_enabled": self.standby_board_offline_enabled,
            "standby_board_offline_id": self.standby_board_offline_id,
            "standby_board_offline_delay_seconds": self.standby_board_offline_delay_seconds
        }
        if self.extra:
            for k, v in self.extra.items():
                if k not in out:
                    out[k] = v
        return out

    @classmethod
    def from_dict(cls, data: Any) -> "AppConfig":
        if isinstance(data, AppConfig):
            return data
        if not isinstance(data, dict):
            return cls()

        devices = []
        raw_devices = data.get("devices", [])
        if isinstance(raw_devices, list) and len(raw_devices) > 0:
            for idx, d in enumerate(raw_devices):
                if isinstance(d, dict) and d.get("ip"):
                    devices.append(DeviceConfig.from_dict(d, default_id=f"device_{idx+1}", default_pwm=_safe_int(data.get("global_brightness"), 200)))
        elif data.get("wifi_ip"):
            devices.append(DeviceConfig(
                ip=str(data.get("wifi_ip")),
                default_pwm_brightness=_safe_int(data.get("global_brightness"), 200)
            ))

        profiles = []
        raw_profiles = data.get("profiles", [])
        if isinstance(raw_profiles, list) and len(raw_profiles) > 0:
            for p in raw_profiles:
                if isinstance(p, dict):
                    profiles.append(ProfileConfig.from_dict(p))

        single_profile = None
        if "profile" in data and isinstance(data["profile"], dict):
            single_profile = ProfileConfig.from_dict(data["profile"])

        if not profiles:
            if single_profile:
                profiles = [single_profile]
            else:
                profiles = [ProfileConfig.get_default_profile()]

        active_profile_name = str(data.get("active_profile", "")).strip()
        if not active_profile_name:
            active_profile_name = single_profile.name if single_profile else profiles[0].name

        active_match = next((p for p in profiles if p.name == active_profile_name), None)
        if not active_match:
            active_match = profiles[0]
            active_profile_name = active_match.name

        return cls(
            devices=devices,
            profiles=profiles,
            active_profile=active_profile_name,
            profile=active_match,
            global_brightness=_safe_int(data.get("global_brightness"), 200),
            wifi_ip=devices[0].ip if devices else str(data.get("wifi_ip", "192.168.2.214")),
            autodarts_user=str(data.get("autodarts_user", "")),
            autodarts_password=str(data.get("autodarts_password", "")),
            autodarts_board_id=str(data.get("autodarts_board_id", "")),
            game_mode_spotlight_brightness=_safe_int(data.get("game_mode_spotlight_brightness"), 255),
            lighting_mode=LightingMode.FLOW if str(data.get("lighting_mode", "")).lower() == "flow" else LightingMode.MATRIX,
            auto_connect_udp_on_game_start=bool(data.get("auto_connect_udp_on_game_start", True)),
            disconnect_udp_on_match_end=bool(data.get("disconnect_udp_on_match_end", False)),
            inactivity_timeout_enabled=bool(data.get("inactivity_timeout_enabled", True)),
            inactivity_timeout_minutes=max(1, _safe_int(data.get("inactivity_timeout_minutes"), 5)),
            idle_power_off_enabled=bool(data.get("idle_power_off_enabled", True)),
            idle_power_off_minutes=max(1, _safe_int(data.get("idle_power_off_minutes"), 30)),
            idle_dimming_brightness=max(0, min(255, _safe_int(data.get("idle_dimming_brightness"), 50))),
            standby_board_offline_enabled=bool(data.get("standby_board_offline_enabled", False)),
            standby_board_offline_id=str(data.get("standby_board_offline_id", "")),
            standby_board_offline_delay_seconds=max(0, min(300, _safe_int(data.get("standby_board_offline_delay_seconds"), 10))),
            extra={k: v for k, v in data.items() if k not in [
                "devices", "profiles", "active_profile", "profile", "global_brightness", "wifi_ip",
                "autodarts_user", "autodarts_password", "autodarts_board_id",
                "ai_key", "gemini_api_key", "game_mode_spotlight_brightness", "lighting_mode", "auto_connect_udp_on_game_start",
                "disconnect_udp_on_match_end",
                "inactivity_timeout_enabled", "inactivity_timeout_minutes",
                "idle_power_off_enabled", "idle_power_off_minutes", "idle_dimming_brightness",
                "standby_board_offline_enabled", "standby_board_offline_id", "standby_board_offline_delay_seconds",
                "device", "status"  # response-only keys echoed back by the UI
            ]}
        )
