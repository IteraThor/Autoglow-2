"""
AutoGlow 2 - Game flow model and storage (Flow Matrix).

A flow profile describes how the light strips follow a match:

    Waiting -> Bull-off -> Game starts -> [Player's turn <-> Pulling darts] -> Leg won -> ... -> Match won -> Waiting

- Steps: each has an on/off switch, a look (one of the curated Flow Matrix effects) and the transition it
  comes in with. A step that is off is skipped: the next step simply comes in with its own transition.
- Hits (1x, 180, Bull ...) play on top of the current look and fade back into it.
- Players: up to six colours; a colour can be tied to a player name.
- Waiting (idle): one effect from the controller's own WLED library. It is not streamed: whenever a
  segment gets this profile (or the profile changes), AutoGlow writes it into the controller's idle preset.

game_flows.json holds named profiles and which controller / segment uses which profile.
"""

import copy
import dataclasses
import json
import logging
import os
import shutil
import sys
import tempfile
from datetime import datetime
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from core.effects.flow import normalize_transition_style, to_flow_effect
from core.models import AnimationType, EffectConfig, RGBColor, _safe_float

logger = logging.getLogger("autoglow.game_flow")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FLOW_PATH = os.path.join(PROJECT_ROOT, "game_flows.json")
# Shipped starting file. game_flows.json itself is user data and is not part of a release,
# so unpacking an update over an existing install never replaces the user's flows.
DEFAULT_FLOW_TEMPLATE = os.path.join(PROJECT_ROOT, "defaults", "game_flows.json")

FILE_VERSION = 2

# Steps in match order. Waiting is not a step: it is the profile's idle look (FlowIdle), played by WLED itself.
STEP_IDS: Tuple[str, ...] = ("bull_off", "game_start", "turn", "takeout", "leg_won", "match_won")
STEP_LABELS = {
    "bull_off": "Bull-off",
    "game_start": "Game starts",
    "turn": "Player's turn",
    "takeout": "Pulling darts",
    "leg_won": "Leg won",
    "match_won": "Match won",
}
# Steps that play for a set time (at least that long, if the next step is not known yet)
TIMED_STEPS = ("game_start", "leg_won", "match_won")
# The player's turn is the base look of a match and cannot be switched off
ALWAYS_ON_STEPS = ("turn",)

HIT_IDS: Tuple[str, ...] = ("single", "double", "triple", "bullseye", "miss", "bust", "ton", "ton40", "180")
HIT_LABELS = {
    "single": "Single",
    "double": "Double",
    "triple": "Triple",
    "bullseye": "Bull",
    "miss": "Miss",
    "bust": "Bust",
    "ton": "Ton (100+)",
    "ton40": "Ton-40 (140+)",
    "180": "180",
}

MAX_PLAYERS = 6
# Distinct, colour-blind friendly player colours. Red and gold are left for Bull and 180.
PLAYER_COLOURS: Tuple[Tuple[int, int, int], ...] = (
    (0, 110, 255),    # blue
    (255, 120, 0),    # orange
    (220, 0, 200),    # magenta
    (0, 220, 170),    # teal
    (255, 215, 0),    # yellow
    (235, 235, 235),  # white
)

DEFAULT_PROFILE_NAME = "Classic"


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


# --- Model ------------------------------------------------------------------

@dataclass
class FlowTransition:
    """How a step comes in."""
    style: str = "crossfade"  # instant (Cut), crossfade (Fade), wipe, curtain, flash
    duration: float = 0.6     # seconds
    accent_color: Optional[RGBColor] = None  # Flash only

    def __post_init__(self) -> None:
        self.style = normalize_transition_style(self.style)
        self.duration = max(0.0, min(5.0, float(self.duration)))
        if self.style == "instant":
            self.duration = 0.0

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"style": self.style, "duration": round(float(self.duration), 3)}
        if self.accent_color is not None:
            out["accent_color"] = self.accent_color.to_list()
        return out

    @classmethod
    def from_dict(cls, data: Any) -> "FlowTransition":
        if isinstance(data, FlowTransition):
            return data
        if not isinstance(data, dict):
            return cls()
        acc = data.get("accent_color")
        return cls(
            style=str(data.get("style", "crossfade")),
            duration=_safe_float(data.get("duration"), 0.6),
            accent_color=RGBColor.from_dict(acc) if acc else None,
        )


@dataclass
class FlowIdle:
    """What a strip shows between games: a WLED effect (id from the controller's library) with its settings."""
    on: bool = True
    fx: int = 9            # WLED effect id (9 = Rainbow)
    speed: int = 128       # WLED sx, 0-255
    intensity: int = 128   # WLED ix, 0-255
    brightness: int = 100  # percent
    colors: List[RGBColor] = field(default_factory=lambda: [RGBColor(0, 255, 157), RGBColor(0, 0, 0), RGBColor(0, 0, 0)])

    def __post_init__(self) -> None:
        clamp = lambda v, lo, hi, d: max(lo, min(hi, int(v))) if isinstance(v, (int, float)) and not isinstance(v, bool) else d
        self.fx = clamp(self.fx, 0, 255, 9)
        self.speed = clamp(self.speed, 0, 255, 128)
        self.intensity = clamp(self.intensity, 0, 255, 128)
        self.brightness = clamp(self.brightness, 0, 100, 100)
        self.colors = (list(self.colors) + [RGBColor(0, 0, 0)] * 3)[:3]

    def to_dict(self) -> Dict[str, Any]:
        return {"on": bool(self.on), "fx": self.fx, "speed": self.speed, "intensity": self.intensity,
                "brightness": self.brightness, "colors": [c.to_list() for c in self.colors]}

    @classmethod
    def from_dict(cls, data: Any) -> "FlowIdle":
        if isinstance(data, FlowIdle):
            return data
        if not isinstance(data, dict):
            return cls()
        base = cls()
        raw_cols = _as_list(data.get("colors"))
        return cls(
            on=bool(data.get("on", True)),
            fx=data.get("fx", base.fx),
            speed=data.get("speed", base.speed),
            intensity=data.get("intensity", base.intensity),
            brightness=data.get("brightness", base.brightness),
            colors=[RGBColor.from_dict(raw_cols[i], default=base.colors[i]) if i < len(raw_cols) else base.colors[i]
                    for i in range(3)],
        )

    def wled_segment(self) -> Dict[str, Any]:
        """The look as WLED segment fields (merged into a preset segment)."""
        return {"on": bool(self.on), "bri": round(self.brightness / 100 * 255), "fx": self.fx, "sx": self.speed,
                "ix": self.intensity, "col": [[c.r, c.g, c.b, 0] for c in self.colors]}


@dataclass
class FlowStep:
    effect: EffectConfig = field(default_factory=lambda: EffectConfig(options={}))
    transition: FlowTransition = field(default_factory=FlowTransition)

    def __post_init__(self) -> None:
        self.effect = to_flow_effect(self.effect)

    @property
    def enabled(self) -> bool:
        return bool(self.effect.enabled)

    def to_dict(self) -> Dict[str, Any]:
        return {"effect": self.effect.to_dict(), "transition": self.transition.to_dict()}

    @classmethod
    def from_dict(cls, data: Any) -> "FlowStep":
        if not isinstance(data, dict):
            return cls()
        return cls(
            effect=EffectConfig.from_dict(data.get("effect") or {}),
            transition=FlowTransition.from_dict(data.get("transition") or {}),
        )


@dataclass
class FlowPlayer:
    color: RGBColor
    name: str = ""  # empty = the next player without a named colour

    def to_dict(self) -> Dict[str, Any]:
        return {"color": self.color.to_list(), "name": self.name}

    @classmethod
    def from_dict(cls, data: Any, index: int = 0) -> "FlowPlayer":
        fallback = RGBColor(*PLAYER_COLOURS[index % len(PLAYER_COLOURS)])
        if not isinstance(data, dict):
            return cls(color=fallback)
        return cls(color=RGBColor.from_dict(data.get("color"), default=fallback), name=str(data.get("name") or "").strip())


def default_players() -> List[FlowPlayer]:
    return [FlowPlayer(color=RGBColor(*c)) for c in PLAYER_COLOURS]


@dataclass
class GameFlow:
    name: str = DEFAULT_PROFILE_NAME
    steps: Dict[str, FlowStep] = field(default_factory=dict)
    hits: Dict[str, EffectConfig] = field(default_factory=dict)
    players: List[FlowPlayer] = field(default_factory=default_players)
    camera_friendly: bool = True
    hit_locator: bool = False
    preset: Optional[str] = None  # the preset this profile started from ("Reset to preset")
    origin: str = ""  # where the look came from, shown next to the segment: "Arena", "Copied from RGB1"
    idle: FlowIdle = field(default_factory=FlowIdle)

    def __post_init__(self) -> None:
        for sid in STEP_IDS:
            if sid not in self.steps:
                self.steps[sid] = FlowStep(effect=EffectConfig(enabled=False, options={}))
        for sid in ALWAYS_ON_STEPS:
            self.steps[sid].effect.enabled = True
        # Timed steps need a time; steps that stay have none
        for sid, step in self.steps.items():
            if sid in TIMED_STEPS:
                if step.effect.duration <= 0:
                    step.effect.duration = 3.0
            else:
                step.effect.duration = 0.0
        for hid in HIT_IDS:
            eff = self.hits.get(hid)
            self.hits[hid] = to_flow_effect(eff if eff else EffectConfig(enabled=False, duration=1.0, options={}))
            if self.hits[hid].duration <= 0:
                self.hits[hid].duration = 1.0
        self.players = (list(self.players) + default_players())[:MAX_PLAYERS]

    def step(self, step_id: str) -> FlowStep:
        return self.steps[step_id]

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "name": self.name,
            "steps": {sid: self.steps[sid].to_dict() for sid in STEP_IDS},
            "hits": {hid: self.hits[hid].to_dict() for hid in HIT_IDS},
            "players": [p.to_dict() for p in self.players],
            "camera_friendly": bool(self.camera_friendly),
            "hit_locator": bool(self.hit_locator),
            "idle": self.idle.to_dict(),
        }
        if self.preset:
            out["preset"] = self.preset
        if self.origin:
            out["origin"] = self.origin
        return out

    @classmethod
    def from_dict(cls, data: Any, name: Optional[str] = None) -> "GameFlow":
        if isinstance(data, GameFlow):
            return data
        if not isinstance(data, dict):
            return create_default_game_flow()
        if "phases" in data and "steps" not in data:
            return convert_v1_flow(data, name=name)
        raw_steps = _as_dict(data.get("steps"))
        raw_hits = _as_dict(data.get("hits"))
        raw_players = _as_list(data.get("players"))
        return cls(
            name=str(name or data.get("name") or DEFAULT_PROFILE_NAME),
            steps={sid: FlowStep.from_dict(raw_steps[sid]) for sid in STEP_IDS if isinstance(raw_steps.get(sid), dict)},
            hits={hid: EffectConfig.from_dict(raw_hits[hid]) for hid in HIT_IDS if isinstance(raw_hits.get(hid), dict)},
            players=[FlowPlayer.from_dict(p, i) for i, p in enumerate(raw_players[:MAX_PLAYERS])],
            camera_friendly=bool(data.get("camera_friendly", True)),
            hit_locator=bool(data.get("hit_locator", False)),
            preset=str(data["preset"]) if data.get("preset") else None,
            origin=str(data.get("origin") or "")[:60],
            idle=FlowIdle.from_dict(data.get("idle")),
        )


def player_colour_index(players: List[str], index: Optional[int], flow: GameFlow) -> int:
    """
    Which of the flow's player colours a match player gets: a colour tied to their name first,
    otherwise the next colour not tied to a name, in match order.
    """
    idx = index if (index is not None and index >= 0) else 0
    names = [str(p or "").strip().lower() for p in players]
    named = {i: p.name.strip().lower() for i, p in enumerate(flow.players) if p.name.strip()}

    def named_slot(player_name: str) -> Optional[int]:
        if not player_name:
            return None
        for slot, filt in named.items():
            if player_name == filt:
                return slot
        for slot, filt in named.items():
            if filt in player_name:
                return slot
        return None

    me = names[idx] if idx < len(names) else ""
    slot = named_slot(me)
    if slot is not None:
        return slot
    free = [i for i in range(len(flow.players)) if i not in named]
    if not free:
        return idx % len(flow.players)
    # Count earlier players who also take a free colour
    rank = sum(1 for i in range(min(idx, len(names))) if named_slot(names[i]) is None)
    if idx >= len(names):
        rank = idx
    return free[rank % len(free)]


# --- Conversion of the first flow format -------------------------------------

_V1_ENTRY_EDGES = {
    "game_start": ("idle->game_start",),
    "turn": ("takeout->turn_p1", "game_start->turn_p1", "turn_p2->turn_p1"),
    "takeout": ("turn_p1->takeout", "turn_p2->takeout"),
    "leg_won": ("turn_p1->leg_won", "turn_p2->leg_won"),
    "match_won": ("turn_p1->match_won", "turn_p2->match_won"),
}


def convert_v1_flow(data: Dict[str, Any], name: Optional[str] = None) -> "GameFlow":
    """A flow from the first format (fixed phases, 2 players, edge transitions) in the current model."""
    phases = {str(p.get("id")): p for p in data.get("phases", []) if isinstance(p, dict)}
    events = _as_dict(data.get("events"))
    transitions = _as_dict(data.get("transitions"))

    def effect_of(raw: Any) -> Optional[EffectConfig]:
        if isinstance(raw, dict) and isinstance(raw.get("effect"), dict):
            return EffectConfig.from_dict(raw["effect"])
        return None

    def entry(step_id: str) -> FlowTransition:
        for key in _V1_ENTRY_EDGES.get(step_id, ()):
            if isinstance(transitions.get(key), dict):
                return FlowTransition.from_dict(transitions[key])
        return FlowTransition()

    base = create_default_game_flow()
    steps: Dict[str, FlowStep] = {"bull_off": base.steps["bull_off"]}
    for step_id, phase_id in (("game_start", "game_start"), ("turn", "turn_p1"), ("takeout", "takeout"),
                              ("leg_won", "leg_won"), ("match_won", "match_won")):
        eff = effect_of(phases.get(phase_id))
        steps[step_id] = FlowStep(effect=eff, transition=entry(step_id)) if eff else base.steps[step_id]

    players = default_players()
    for slot, phase_id in ((0, "turn_p1"), (1, "turn_p2")):
        eff = effect_of(phases.get(phase_id))
        if eff:
            players[slot] = FlowPlayer(color=eff.color_primary)

    hits: Dict[str, EffectConfig] = {}
    for hid in ("single", "double", "triple", "bullseye", "bust", "180"):
        eff = effect_of(events.get(hid))
        if eff:
            hits[hid] = eff
    if "bust" in hits:
        hits["miss"] = copy.deepcopy(hits["bust"])

    return GameFlow(name=str(name or "My flow"), steps=steps, hits=hits, players=players)


def create_default_game_flow() -> GameFlow:
    """The flow a fresh install starts with (the Classic preset)."""
    from core.flow_presets import build_preset
    return build_preset("classic")


# --- Storage ------------------------------------------------------------------

class GameFlowStorageManager:
    """
    Reads and atomically writes game_flows.json:

        {"version": 2, "default": "<profile>", "profiles": {"<name>": {...}},
         "assign": {"<controller ip>": {"*": "<profile>", "<segment id>": "<profile>"}},
         "presets": {"<name>": {...}}}

    A segment uses its own profile, else its controller's ("*"), else the default profile. The Lighting page
    gives every segment a profile of its own (give_own_profiles); "presets" are the user's saved looks.
    Parsed profiles are cached and only re-read when the file changes (mtime and size), so the engine can
    look up a segment's flow on every dart without touching the disk. get_*() return shared, read-only
    entries; load_profile() returns a copy to edit.
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
        self._flows: Dict[str, GameFlow] = {}

    # -- reading --

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

    def _read_file(self) -> Dict[str, Any]:
        if not os.path.exists(self.filepath):
            return {}
        for path in (self.filepath, self.bak_filepath):
            if not os.path.exists(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    return data
            except Exception as e:
                logger.warning(f"Failed to read {path}: {e}")
                if path == self.filepath:
                    self._quarantine()
        return {}

    def _quarantine(self) -> None:
        """Keep an unreadable flow file under another name: it is replaced by the backup or the defaults next."""
        try:
            if os.path.getsize(self.filepath) == 0:
                return
            target = f"{self.filepath}.corrupt_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            shutil.copy2(self.filepath, target)
            logger.error(f"Game flow file is not readable; kept a copy as {target}")
        except OSError as e:
            logger.warning(f"Could not keep a copy of the unreadable game flow file: {e}")

    def _data_now(self) -> Dict[str, Any]:
        """The file's contents in the current format (created or converted and saved on first use)."""
        stamp = self._file_stamp()
        if stamp is not None and stamp == self._stamp:
            return self._data
        raw = self._read_file()
        if raw.get("version") == FILE_VERSION and isinstance(raw.get("profiles"), dict) and raw["profiles"]:
            self._remember(raw, stamp)
            return self._data
        data = self._upgrade(raw) if raw else self._starting_data()
        if not self._write_raw(data):
            # Read-only location or a test: keep the converted data in memory
            self._remember(data, stamp)
        return self._data

    def _starting_data(self) -> Dict[str, Any]:
        if self._template and os.path.isfile(self._template):
            try:
                with open(self._template, "r", encoding="utf-8") as f:
                    tpl = json.load(f)
                if isinstance(tpl, dict):
                    return self._upgrade(tpl) if tpl.get("version") != FILE_VERSION else tpl
            except Exception as e:
                logger.warning(f"Could not read the default flows {self._template}: {e}")
        flow = create_default_game_flow()
        return {"version": FILE_VERSION, "default": flow.name, "profiles": {flow.name: flow.to_dict()}, "assign": {}}

    @staticmethod
    def _upgrade(raw: Dict[str, Any]) -> Dict[str, Any]:
        """
        A first-format file (one master flow plus per-segment copies) as profiles: the master flow
        becomes "My flow", each per-segment copy "My flow - <controller> segment <n>", assigned to it.
        """
        if raw.get("version") == FILE_VERSION:
            return raw
        main = GameFlow.from_dict(raw, name="My flow")
        profiles = {main.name: main.to_dict()}
        assign: Dict[str, Dict[str, str]] = {}
        dev_flows = _as_dict(raw.get("device_flows"))
        for ip, segs in dev_flows.items():
            if not isinstance(segs, dict):
                continue
            for seg_id, seg_raw in segs.items():
                if not isinstance(seg_raw, dict):
                    continue
                pname = f"My flow - {ip} segment {seg_id}"
                profiles[pname] = GameFlow.from_dict(seg_raw, name=pname).to_dict()
                assign.setdefault(str(ip), {})[str(seg_id)] = pname
        logger.info(f"Converted game flows to profiles: {', '.join(profiles)}")
        return {"version": FILE_VERSION, "default": main.name, "profiles": profiles, "assign": assign}

    def profile_names(self) -> List[str]:
        return list(self._data_now()["profiles"].keys())

    @property
    def default_profile(self) -> str:
        data = self._data_now()
        name = data.get("default")
        return str(name) if name in data["profiles"] else str(next(iter(data["profiles"])))

    def assignments(self) -> Dict[str, Dict[str, str]]:
        data = self._data_now()
        assign = _as_dict(data.get("assign"))
        return {ip: dict(segs) for ip, segs in assign.items() if isinstance(segs, dict)}

    def profile_name_for(self, ip: Optional[str], seg_id: Optional[Any] = None) -> str:
        data = self._data_now()
        segs = self.assignments().get(ip or "", {})
        for key in ((str(seg_id),) if seg_id is not None else ()) + ("*",):
            name = segs.get(key)
            if name is not None and name in data["profiles"]:
                return name
        return self.default_profile

    def get_profile(self, name: Optional[str] = None) -> GameFlow:
        data = self._data_now()
        pname = name if (name is not None and name in data["profiles"]) else self.default_profile
        flow = self._flows.get(pname)
        if flow is None:
            flow = GameFlow.from_dict(data["profiles"][pname], name=pname)
            self._flows[pname] = flow
        return flow

    def get_for_segment(self, ip: Optional[str] = None, seg_id: Optional[Any] = None) -> GameFlow:
        """The flow a segment plays (shared and read-only: the engine calls this for every event)."""
        return self.get_profile(self.profile_name_for(ip, seg_id))

    def get(self) -> GameFlow:
        return self.get_profile(None)

    def load_profile(self, name: Optional[str] = None) -> GameFlow:
        """A private copy of a profile that the caller may edit."""
        return copy.deepcopy(self.get_profile(name))

    def load(self) -> GameFlow:
        return self.load_profile(None)

    # -- writing --

    def _edit(self) -> Dict[str, Any]:
        data = copy.deepcopy(self._data_now())
        data.setdefault("assign", {})
        return data

    def save_profile(self, flow: GameFlow, old_name: Optional[str] = None) -> bool:
        """Create or update a profile; with old_name it is also renamed (assignments follow)."""
        data = self._edit()
        name = flow.name.strip() or DEFAULT_PROFILE_NAME
        flow = dataclasses.replace(flow, name=name)
        if old_name and old_name != name:
            if name in data["profiles"]:
                return False
            # Keep the profile's position in the list
            data["profiles"] = {(name if k == old_name else k): v for k, v in data["profiles"].items()}
            if data.get("default") == old_name:
                data["default"] = name
            for segs in data["assign"].values():
                for key, val in list(segs.items()):
                    if val == old_name:
                        segs[key] = name
        data["profiles"][name] = flow.to_dict()
        return self._write_raw(data)

    def delete_profile(self, name: str) -> bool:
        data = self._edit()
        if name not in data["profiles"] or len(data["profiles"]) <= 1:
            return False
        del data["profiles"][name]
        if data.get("default") == name:
            data["default"] = next(iter(data["profiles"]))
        data["assign"] = {
            ip: kept for ip, segs in data["assign"].items()
            if (kept := {k: v for k, v in segs.items() if v != name})
        }
        return self._write_raw(data)

    def set_default(self, name: str) -> bool:
        data = self._edit()
        if name not in data["profiles"]:
            return False
        data["default"] = name
        return self._write_raw(data)

    def assign(self, ip: str, name: str, seg_id: Optional[Any] = None) -> bool:
        """seg_id None = the whole controller (replaces its segment choices)."""
        data = self._edit()
        if not ip or name not in data["profiles"]:
            return False
        if seg_id is None:
            data["assign"][ip] = {"*": name}
        else:
            data["assign"].setdefault(ip, {})[str(seg_id)] = name
        return self._write_raw(data)

    def give_own_profiles(self, segments: List[Tuple[str, Any, str]]) -> bool:
        """
        Every segment ((ip, segment id, name), in page order) gets a profile it plays alone: the first segment
        of a shared profile keeps it, the others get a copy named after them. Writes only when something changed.
        """
        data = self._edit()
        taken = set(data["profiles"])
        seen: set = set()
        changed = False
        for ip, seg_id, seg_name in segments:
            name = self.profile_name_for(ip, seg_id)
            key = "*" if seg_id is None else str(seg_id)
            if name not in seen:
                seen.add(name)
                # Pin it, so a later controller-wide or default change does not move it
                if data["assign"].get(ip, {}).get(key) != name:
                    data["assign"].setdefault(ip, {})[key] = name
                    changed = True
                continue
            own = _free_name(taken, seg_name or "Segment")
            taken.add(own)
            seen.add(own)
            data["profiles"][own] = {**copy.deepcopy(data["profiles"][name]), "name": own}
            data["assign"].setdefault(ip, {})[key] = own
            changed = True
        return self._write_raw(data) if changed else True

    def user_presets(self) -> Dict[str, GameFlow]:
        presets = _as_dict(self._data_now().get("presets"))
        return {name: GameFlow.from_dict(raw, name=name) for name, raw in presets.items() if isinstance(raw, dict)}

    def save_user_preset(self, flow: GameFlow) -> bool:
        data = self._edit()
        data.setdefault("presets", {})[flow.name] = flow.to_dict()
        return self._write_raw(data)

    def delete_user_preset(self, name: str) -> bool:
        data = self._edit()
        if name not in _as_dict(data.get("presets")):
            return False
        del data["presets"][name]
        return self._write_raw(data)

    def _write_raw(self, data: Dict[str, Any]) -> bool:
        # SAFETY GUARD: unit tests must never overwrite the production flow file
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
            logger.info(f"Saved game flows to {self.filepath}")
            return True
        except Exception as e:
            logger.exception(f"Error writing game flow data to {self.filepath}: {e}")
            if temp_name and os.path.exists(temp_name):
                os.remove(temp_name)
            return False


def _free_name(taken: set, base: str, limit: int = 40) -> str:
    """base, or "base 2", "base 3", ... when taken."""
    for i in range(1, 1000):
        tail = "" if i == 1 else f" {i}"
        name = base[:limit - len(tail)].rstrip() + tail
        if name not in taken:
            return name
    raise ValueError("no free name")


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


__all__ = [
    "ALWAYS_ON_STEPS", "AnimationType", "DEFAULT_PROFILE_NAME", "FlowIdle", "FlowPlayer", "FlowStep", "FlowTransition",
    "GameFlow", "GameFlowStorageManager", "HIT_IDS", "HIT_LABELS", "MAX_PLAYERS", "PLAYER_COLOURS",
    "STEP_IDS", "STEP_LABELS", "TIMED_STEPS", "convert_v1_flow", "create_default_game_flow", "player_colour_index",
]
