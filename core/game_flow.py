"""
AutoGlow 2 - Game Flow & Visual State Machine Module
Defines models, transitions, and storage for the Game Flow Simulator and Visual Planner.
"""

import copy
import os
import shutil
import sys
import json
import logging
import tempfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from core.models import EffectConfig, AnimationType, RGBColor, _safe_float, _safe_int

logger = logging.getLogger("autoglow.game_flow")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FLOW_PATH = os.path.join(PROJECT_ROOT, "game_flows.json")
# Shipped starting flow. game_flows.json itself is user data and is not part of a release,
# so unpacking an update over an existing install never replaces the user's flows.
DEFAULT_FLOW_TEMPLATE = os.path.join(PROJECT_ROOT, "defaults", "game_flows.json")


@dataclass
class FlowTransition:
    from_phase_id: str
    to_phase_id: str
    style: str = "crossfade"  # "crossfade", "wipe", "pulse", "flash", "curtain", "instant"
    duration: float = 0.6     # seconds
    accent_color: Optional[RGBColor] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "from_phase_id": str(self.from_phase_id),
            "to_phase_id": str(self.to_phase_id),
            "style": str(self.style),
            "duration": float(self.duration),
            "accent_color": self.accent_color.to_list() if self.accent_color else None
        }

    @classmethod
    def from_dict(cls, data: Any) -> "FlowTransition":
        if isinstance(data, FlowTransition):
            return data
        if not isinstance(data, dict):
            return cls(from_phase_id="", to_phase_id="")
        
        acc = data.get("accent_color")
        return cls(
            from_phase_id=str(data.get("from_phase_id", "")),
            to_phase_id=str(data.get("to_phase_id", "")),
            style=str(data.get("style", "crossfade")),
            duration=max(0.05, _safe_float(data.get("duration"), 0.6)),
            accent_color=RGBColor.from_dict(acc) if acc else None
        )


@dataclass
class FlowPhase:
    id: str
    name: str
    trigger_key: str
    effect: EffectConfig = field(default_factory=EffectConfig)
    order_index: int = 0
    is_baseline: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": str(self.id),
            "name": str(self.name),
            "trigger_key": str(self.trigger_key),
            "effect": self.effect.to_dict(),
            "order_index": int(self.order_index),
            "is_baseline": bool(self.is_baseline)
        }

    @classmethod
    def from_dict(cls, data: Any) -> "FlowPhase":
        if isinstance(data, FlowPhase):
            return data
        if not isinstance(data, dict):
            return cls(id="phase", name="Phase", trigger_key="throw")

        return cls(
            id=str(data.get("id", "phase")),
            name=str(data.get("name", "Phase")),
            trigger_key=str(data.get("trigger_key", "throw")),
            effect=EffectConfig.from_dict(data.get("effect", {})),
            order_index=_safe_int(data.get("order_index"), 0),
            is_baseline=bool(data.get("is_baseline", False))
        )


@dataclass
class GameFlow:
    id: str = "default_flow"
    name: str = "Standard Game Flow"
    phases: List[FlowPhase] = field(default_factory=list)
    transitions: Dict[str, FlowTransition] = field(default_factory=dict)
    events: Dict[str, FlowPhase] = field(default_factory=dict)

    def get_transition_key(self, from_id: str, to_id: str) -> str:
        return f"{from_id}->{to_id}"

    def get_transition(self, from_id: str, to_id: str) -> FlowTransition:
        key = self.get_transition_key(from_id, to_id)
        if key in self.transitions:
            return self.transitions[key]
        # Return sensible default transition
        return FlowTransition(from_phase_id=from_id, to_phase_id=to_id, style="crossfade", duration=0.6)

    def get_phase(self, phase_id: str) -> Optional[FlowPhase]:
        for p in self.phases:
            if p.id == phase_id:
                return p
        if phase_id in self.events:
            return self.events[phase_id]
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "phases": [p.to_dict() for p in sorted(self.phases, key=lambda x: x.order_index)],
            "transitions": {k: t.to_dict() for k, t in self.transitions.items()},
            "events": {k: (v.to_dict() if hasattr(v, "to_dict") else v) for k, v in self.events.items()}
        }

    @classmethod
    def from_dict(cls, data: Any) -> "GameFlow":
        if isinstance(data, GameFlow):
            return data
        if not isinstance(data, dict):
            return create_default_game_flow()

        raw_phases = data.get("phases", [])
        phases = [FlowPhase.from_dict(p) for p in raw_phases if isinstance(p, dict)]
        if not phases:
            return create_default_game_flow()

        raw_trans = data.get("transitions", {})
        transitions = {}
        if isinstance(raw_trans, dict):
            for k, v in raw_trans.items():
                if isinstance(v, dict):
                    transitions[k] = FlowTransition.from_dict(v)

        raw_events = data.get("events", {})
        events = {}
        if isinstance(raw_events, dict):
            for k, v in raw_events.items():
                if isinstance(v, dict):
                    events[k] = FlowPhase.from_dict(v)

        def_events = {
            "single": FlowPhase(id="single", name="Single Hit (1x)", trigger_key="single", effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 200, 255), duration=0.8, speed=1.0, enabled=True)),
            "double": FlowPhase(id="double", name="Double Hit (2x)", trigger_key="double", effect=EffectConfig(animation=AnimationType.PULSE, color_primary=RGBColor(0, 255, 180), color_secondary=RGBColor(0, 40, 20), duration=1.2, speed=1.4, enabled=True)),
            "triple": FlowPhase(id="triple", name="Triple Hit (3x)", trigger_key="triple", effect=EffectConfig(animation=AnimationType.FLASH, color_primary=RGBColor(255, 120, 0), color_secondary=RGBColor(50, 20, 0), duration=1.8, speed=1.6, enabled=True)),
            "180": FlowPhase(id="180", name="180 (Maximum!)", trigger_key="180", effect=EffectConfig(animation=AnimationType.RAINBOW, color_primary=RGBColor(255, 200, 0), duration=3.2, speed=2.0, enabled=True)),
            "bullseye": FlowPhase(id="bullseye", name="Bullseye (Bull)", trigger_key="bullseye", effect=EffectConfig(animation=AnimationType.COMET, color_primary=RGBColor(255, 20, 40), duration=2.2, speed=1.8, enabled=True)),
            "bust": FlowPhase(id="bust", name="Bust / Miss (Bust)", trigger_key="bust", effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(110, 118, 129), duration=1.0, speed=1.0, enabled=True)),
            "calibrating": FlowPhase(id="calibrating", name="Board Calibration (Calib)", trigger_key="calibrating", effect=EffectConfig(animation=AnimationType.SCAN, color_primary=RGBColor(168, 85, 247), color_secondary=RGBColor(80, 20, 140), duration=2.5, speed=1.2, enabled=True))
        }
        for k, v in def_events.items():
            if k not in events:
                events[k] = v

        return cls(
            id=str(data.get("id", "default_flow")),
            name=str(data.get("name", "Standard Game Flow")),
            phases=phases,
            transitions=transitions,
            events=events
        )


def create_default_game_flow() -> GameFlow:
    """Creates the simplified 7-step game flow pipeline requested by the user."""
    p_idle = FlowPhase(
        id="idle",
        name="IDLE",
        trigger_key="standby",
        effect=EffectConfig(
            animation=AnimationType.BREATHE,
            color_primary=RGBColor(0, 240, 255),
            color_secondary=RGBColor(0, 30, 60),
            duration=0.0,
            speed=0.8,
            enabled=True,
            wled_effect_id=2,
            wled_effect_name="Breathe"
        ),
        order_index=0,
        is_baseline=True
    )

    p_game_start = FlowPhase(
        id="game_start",
        name="Game Start",
        trigger_key="game_start",
        effect=EffectConfig(
            animation=AnimationType.BREATHE,
            color_primary=RGBColor(0, 240, 255),
            color_secondary=RGBColor(0, 40, 80),
            duration=2.5,
            speed=1.0,
            enabled=True
        ),
        order_index=1,
        is_baseline=False
    )

    p_turn_p1 = FlowPhase(
        id="turn_p1",
        name="Turn Player 1",
        trigger_key="throw",
        effect=EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(0, 160, 255),
            color_secondary=RGBColor(0, 0, 0),
            duration=0.0,
            speed=1.0,
            enabled=True
        ),
        order_index=2,
        is_baseline=True
    )

    p_takeout = FlowPhase(
        id="takeout",
        name="Takeout",
        trigger_key="takeout",
        effect=EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 255, 255),
            color_secondary=RGBColor(0, 0, 0),
            duration=3.0,
            speed=1.0,
            enabled=True
        ),
        order_index=3,
        is_baseline=False
    )

    p_turn_p2 = FlowPhase(
        id="turn_p2",
        name="Turn Player 2",
        trigger_key="turn_change",
        effect=EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 160, 0),
            color_secondary=RGBColor(30, 15, 0),
            duration=0.0,
            speed=1.0,
            enabled=True
        ),
        order_index=4,
        is_baseline=True
    )

    p_leg_won = FlowPhase(
        id="leg_won",
        name="Leg Won",
        trigger_key="leg_won",
        effect=EffectConfig(
            animation=AnimationType.RAINBOW,
            color_primary=RGBColor(0, 255, 0),
            color_secondary=RGBColor(0, 0, 0),
            duration=4.0,
            speed=1.8,
            enabled=True
        ),
        order_index=5,
        is_baseline=False
    )

    p_match_won = FlowPhase(
        id="match_won",
        name="Match Won",
        trigger_key="match_won",
        effect=EffectConfig(
            animation=AnimationType.COMET,
            color_primary=RGBColor(245, 158, 11),
            color_secondary=RGBColor(255, 215, 0),
            duration=6.0,
            speed=1.5,
            enabled=True
        ),
        order_index=6,
        is_baseline=False
    )

    phases = [p_idle, p_game_start, p_turn_p1, p_takeout, p_turn_p2, p_leg_won, p_match_won]

    transitions = {
        "idle->game_start": FlowTransition("idle", "game_start", style="pulse", duration=0.8, accent_color=RGBColor(0, 240, 255)),
        "game_start->turn_p1": FlowTransition("game_start", "turn_p1", style="curtain", duration=0.6),
        "turn_p1->takeout": FlowTransition("turn_p1", "takeout", style="wipe", duration=0.6),
        "takeout->turn_p2": FlowTransition("takeout", "turn_p2", style="wipe", duration=0.6),
        "turn_p2->takeout": FlowTransition("turn_p2", "takeout", style="wipe", duration=0.6),
        "takeout->turn_p1": FlowTransition("takeout", "turn_p1", style="wipe", duration=0.6),
        "turn_p1->turn_p2": FlowTransition("turn_p1", "turn_p2", style="wipe", duration=0.6),
        "turn_p2->turn_p1": FlowTransition("turn_p2", "turn_p1", style="crossfade", duration=0.6),
        "turn_p2->leg_won": FlowTransition("turn_p2", "leg_won", style="flash", duration=0.5, accent_color=RGBColor(0, 255, 120)),
        "turn_p1->leg_won": FlowTransition("turn_p1", "leg_won", style="flash", duration=0.5, accent_color=RGBColor(0, 255, 120)),
        "turn_p2->match_won": FlowTransition("turn_p2", "match_won", style="flash", duration=0.6, accent_color=RGBColor(245, 158, 11)),
        "turn_p1->match_won": FlowTransition("turn_p1", "match_won", style="flash", duration=0.6, accent_color=RGBColor(245, 158, 11)),
        "leg_won->turn_p1": FlowTransition("leg_won", "turn_p1", style="curtain", duration=0.6),
        "leg_won->idle": FlowTransition("leg_won", "idle", style="crossfade", duration=1.0),
        "match_won->idle": FlowTransition("match_won", "idle", style="cut", duration=0.0),
    }

    events = {
        "single": FlowPhase(id="single", name="Single Hit (1x)", trigger_key="single", effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 200, 255), duration=0.8, speed=1.0, enabled=True)),
        "double": FlowPhase(id="double", name="Double Hit (2x)", trigger_key="double", effect=EffectConfig(animation=AnimationType.PULSE, color_primary=RGBColor(0, 255, 180), color_secondary=RGBColor(0, 40, 20), duration=1.2, speed=1.4, enabled=True)),
        "triple": FlowPhase(id="triple", name="Triple Hit (3x)", trigger_key="triple", effect=EffectConfig(animation=AnimationType.FLASH, color_primary=RGBColor(255, 120, 0), color_secondary=RGBColor(50, 20, 0), duration=1.8, speed=1.6, enabled=True)),
        "180": FlowPhase(id="180", name="180 (Maximum!)", trigger_key="180", effect=EffectConfig(animation=AnimationType.RAINBOW, color_primary=RGBColor(255, 200, 0), duration=3.2, speed=2.0, enabled=True)),
        "bullseye": FlowPhase(id="bullseye", name="Bullseye (Bull)", trigger_key="bullseye", effect=EffectConfig(animation=AnimationType.COMET, color_primary=RGBColor(255, 20, 40), duration=2.2, speed=1.8, enabled=True)),
        "bust": FlowPhase(id="bust", name="Bust / Miss (Bust)", trigger_key="bust", effect=EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(110, 118, 129), duration=1.0, speed=1.0, enabled=True)),
        "calibrating": FlowPhase(id="calibrating", name="Board Calibration (Calib)", trigger_key="calibrating", effect=EffectConfig(animation=AnimationType.SCAN, color_primary=RGBColor(168, 85, 247), color_secondary=RGBColor(80, 20, 140), duration=2.5, speed=1.2, enabled=True))
    }

    return GameFlow(
        id="default_flow",
        name="Simple Game Flow",
        phases=phases,
        transitions=transitions,
        events=events
    )


class GameFlowStorageManager:
    """
    Reads and atomically writes game_flows.json: the master flow plus per-(device, segment) flows.

    Parsed flows are cached and only re-read when the file changes (checked by mtime and size), so the
    engine can look up a segment's flow on every dart without touching the disk. get()/get_for_segment()
    return shared cache entries (read-only); load()/load_for_segment() return copies to edit.
    """

    def __init__(self, filepath: Optional[str] = None):
        self._template: Optional[str] = None
        if filepath is None:
            filepath = DEFAULT_FLOW_PATH
            self._template = DEFAULT_FLOW_TEMPLATE
            _adopt_flow_file_from_cwd(filepath)
        self.filepath = os.path.abspath(filepath)
        self.bak_filepath = self.filepath + ".bak"
        self._stamp: Optional[tuple] = None
        self._data: Dict[str, Any] = {}
        self._flows: Dict[tuple, GameFlow] = {}

    def _file_stamp(self) -> Optional[tuple]:
        try:
            st = os.stat(self.filepath)
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def _remember(self, data: Dict[str, Any], stamp: Optional[tuple]) -> None:
        self._data = data
        self._stamp = stamp
        self._flows.clear()

    def _read_raw(self) -> Dict[str, Any]:
        stamp = self._file_stamp()
        if stamp is not None and stamp == self._stamp:
            return self._data
        self._remember(self._read_file(), stamp)
        return self._data

    def _read_file(self) -> Dict[str, Any]:
        if not os.path.exists(self.filepath):
            return {}
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read {self.filepath}: {e}. Attempting backup recovery.")
            if os.path.exists(self.bak_filepath):
                try:
                    with open(self.bak_filepath, "r", encoding="utf-8") as f:
                        return json.load(f)
                except Exception as be:
                    logger.error(f"Backup recovery also failed: {be}")
            return {}

    def _cached_flow(self, key: tuple, raw: Dict[str, Any]) -> GameFlow:
        flow = self._flows.get(key)
        if flow is None:
            flow = GameFlow.from_dict(raw)
            self._flows[key] = flow
        return flow

    def get(self) -> GameFlow:
        """The master flow as a shared, read-only cache entry (created and saved on first use)."""
        data = self._read_raw()
        if not data:
            flow = self._starting_flow()
            self.save(flow)
            return flow
        return self._cached_flow(("",), data)

    def _starting_flow(self) -> GameFlow:
        if self._template and os.path.isfile(self._template):
            try:
                with open(self._template, "r", encoding="utf-8") as f:
                    return GameFlow.from_dict(json.load(f))
            except Exception as e:
                logger.warning(f"Could not read the default flow {self._template}: {e}")
        return create_default_game_flow()

    def get_for_segment(self, ip: Optional[str] = None, seg_id: Optional[Any] = None) -> GameFlow:
        """
        The flow customised for (ip, seg_id), falling back to the master flow.
        Shared and read-only: the engine calls this for every dart.
        """
        if not ip:
            return self.get()

        data = self._read_raw()
        dev_flows = data.get("device_flows", {})
        if isinstance(dev_flows, dict):
            dev_map = dev_flows.get(ip, {})
            if isinstance(dev_map, dict):
                seg_key = str(seg_id) if seg_id is not None else "0"
                if seg_key in dev_map and isinstance(dev_map[seg_key], dict):
                    return self._cached_flow((ip, seg_key), dev_map[seg_key])

        return self.get()

    def load(self) -> GameFlow:
        """A private copy of the master flow that the caller may edit."""
        return copy.deepcopy(self.get())

    def load_for_segment(self, ip: Optional[str] = None, seg_id: Optional[Any] = None) -> GameFlow:
        """A private copy of the flow for (ip, seg_id) that the caller may edit."""
        return copy.deepcopy(self.get_for_segment(ip, seg_id))

    def save(self, flow: GameFlow) -> bool:
        """Save the default master flow while preserving any existing device_flows."""
        try:
            data = self._read_raw()
            new_data = flow.to_dict()
            if "device_flows" in data and isinstance(data["device_flows"], dict):
                new_data["device_flows"] = data["device_flows"]
            return self._write_raw(new_data)
        except Exception as e:
            logger.exception(f"Error saving default game flow: {e}")
            return False

    def save_for_segment(self, flow: GameFlow, ip: Optional[str] = None, seg_id: Optional[Any] = None) -> bool:
        """Save a custom GameFlow for a specific (ip, seg_id)."""
        if not ip:
            return self.save(flow)

        try:
            # Work on a copy so a failed write never leaves unsaved changes in the cache
            data = copy.deepcopy(self._read_raw())
            if not data:
                def_flow = create_default_game_flow()
                data = def_flow.to_dict()

            if "device_flows" not in data or not isinstance(data["device_flows"], dict):
                data["device_flows"] = {}

            if ip not in data["device_flows"] or not isinstance(data["device_flows"][ip], dict):
                data["device_flows"][ip] = {}

            seg_key = str(seg_id) if seg_id is not None else "0"
            data["device_flows"][ip][seg_key] = flow.to_dict()

            return self._write_raw(data)
        except Exception as e:
            logger.exception(f"Error saving segment game flow for {ip} seg {seg_id}: {e}")
            return False

    def _write_raw(self, data: Dict[str, Any]) -> bool:
        # SAFETY GUARD: Prevent unit test execution from inadvertently overwriting production game flow
        if ("unittest" in sys.modules or "pytest" in sys.modules) and not os.environ.get("AUTOGLOW_ALLOW_PROD_CONFIG_IN_TEST"):
            if self.filepath == DEFAULT_FLOW_PATH:
                logger.error(
                    f"SAFETY GUARD ACTIVATED: Blocked attempt to overwrite production game flow '{self.filepath}' "
                    f"during test execution. Tests must specify an isolated flow file."
                )
                return False

        temp_name = None
        try:
            json_str = json.dumps(data, indent=2)
            dir_name = os.path.dirname(os.path.abspath(self.filepath))
            with tempfile.NamedTemporaryFile("w", dir=dir_name, delete=False, encoding="utf-8") as tf:
                tf.write(json_str)
                tf.flush()
                os.fsync(tf.fileno())
                temp_name = tf.name

            if os.path.exists(self.filepath):
                try:
                    shutil.copyfile(self.filepath, self.bak_filepath)
                except Exception as ce:
                    logger.warning(f"Could not create game flow backup: {ce}")

            os.replace(temp_name, self.filepath)
            self._remember(data, self._file_stamp())
            logger.info(f"Successfully saved game flow data to {self.filepath}")
            return True
        except Exception as e:
            logger.exception(f"Error writing game flow data to {self.filepath}: {e}")
            if temp_name and os.path.exists(temp_name):
                os.remove(temp_name)
            return False


def _adopt_flow_file_from_cwd(target: str) -> None:
    """
    Before the flow path was pinned to the project root it was relative to the working directory.
    If AutoGlow used to be started elsewhere, copy that file over once so no saved flows are lost.
    """
    legacy = os.path.abspath("game_flows.json")
    if legacy == target or os.path.exists(target) or not os.path.isfile(legacy):
        return
    if ("unittest" in sys.modules or "pytest" in sys.modules) and not os.environ.get("AUTOGLOW_ALLOW_PROD_CONFIG_IN_TEST"):
        return
    try:
        shutil.copyfile(legacy, target)
        logger.info(f"Copied game flows from {legacy} to {target} (the original is left in place)")
    except OSError as e:
        logger.warning(f"Could not copy legacy game flows from {legacy}: {e}")
