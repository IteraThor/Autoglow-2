"""
AutoGlow 2 - Game Flow & Visual State Machine Module
Defines models, transitions, and storage for the Game Flow Simulator and Visual Planner.
"""

import os
import sys
import json
import logging
import tempfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from core.models import EffectConfig, AnimationType, RGBColor, _safe_float, _safe_int

logger = logging.getLogger("autoglow.game_flow")


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
    Manages thread-safe atomic reading and writing of game_flows.json,
    supporting both the master default game flow and per-(device, segment) flows.
    """

    def __init__(self, filepath: str = "game_flows.json"):
        self.filepath = filepath
        self.bak_filepath = filepath + ".bak"

    def _read_raw(self) -> Dict[str, Any]:
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

    def load(self) -> GameFlow:
        data = self._read_raw()
        if not data:
            flow = create_default_game_flow()
            self.save(flow)
            return flow
        return GameFlow.from_dict(data)

    def load_for_segment(self, ip: Optional[str] = None, seg_id: Optional[Any] = None) -> GameFlow:
        """
        Load custom GameFlow for a specific (ip, seg_id).
        If not customized, falls back to the default master flow.
        """
        if not ip:
            return self.load()

        data = self._read_raw()
        dev_flows = data.get("device_flows", {})
        if isinstance(dev_flows, dict):
            dev_map = dev_flows.get(ip, {})
            if isinstance(dev_map, dict):
                seg_key = str(seg_id) if seg_id is not None else "0"
                if seg_key in dev_map and isinstance(dev_map[seg_key], dict):
                    return GameFlow.from_dict(dev_map[seg_key])

        # Fallback to default flow
        return self.load()

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
            data = self._read_raw()
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
            project_flow = os.path.abspath(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "game_flows.json"))
            if os.path.abspath(self.filepath) == project_flow:
                logger.error(
                    f"SAFETY GUARD ACTIVATED: Blocked attempt to overwrite production game flow '{self.filepath}' "
                    f"during test execution. Tests must specify an isolated flow file."
                )
                return False

        try:
            json_str = json.dumps(data, indent=2)
            dir_name = os.path.dirname(os.path.abspath(self.filepath))
            with tempfile.NamedTemporaryFile("w", dir=dir_name, delete=False, encoding="utf-8") as tf:
                tf.write(json_str)
                temp_name = tf.name

            if os.path.exists(self.filepath):
                try:
                    import shutil
                    shutil.copyfile(self.filepath, self.bak_filepath)
                except Exception as ce:
                    logger.warning(f"Could not create game flow backup: {ce}")

            os.replace(temp_name, self.filepath)
            logger.info(f"Successfully saved game flow data to {self.filepath}")
            return True
        except Exception as e:
            logger.exception(f"Error writing game flow data to {self.filepath}: {e}")
            return False
