"""
AutoGlow 2 - Flow Matrix effect & transition catalog.

The Flow Matrix offers a deliberately small set of looks, each with a clear job in a dart game and at
most two options in plain words. Everything is defined in proportions of the segment (laps per second,
tail as a share of the strip), so a look is the same on 10 LEDs as on 1500.
"""

import dataclasses
from typing import Any, Dict, List, Optional

from core.models import AnimationType, EffectConfig

# Effect id -> label, job and options (key -> (default, allowed values))
FLOW_EFFECTS: Dict[str, Dict[str, Any]] = {
    "solid": {"label": "Solid", "job": "A steady colour", "options": {}},
    "breathe": {"label": "Breathe", "job": "A calm, slow glow", "options": {}},
    "flash": {"label": "Flash", "job": "Instant hit feedback", "options": {"pulses": (1, [1, 2, 3])}},
    "chase": {
        "label": "Chase",
        "job": "Light running around the strip",
        "options": {"tail": ("short", ["short", "long"]), "comets": (1, [1, 2])},
    },
    "curtain": {"label": "Curtain", "job": "Fills the strip from the top", "options": {"sides": ("both", ["both", "one"])}},
    "rainbow": {"label": "Rainbow", "job": "A big celebration", "options": {"palette": ("vivid", ["vivid", "soft"])}},
    "sparkle": {"label": "Sparkle", "job": "Glitter over a colour", "options": {"amount": ("some", ["few", "some", "many"])}},
}

# Transition id -> label. "instant" is shown as Cut.
FLOW_TRANSITIONS: Dict[str, str] = {
    "instant": "Cut",
    "crossfade": "Fade",
    "wipe": "Wipe",
    "curtain": "Curtain",
    "flash": "Flash",
}

# Old effect -> (curated effect, options) for flows saved before the curated set
_LEGACY_EFFECTS: Dict[str, tuple] = {
    "solid": ("solid", {}),
    "breathe": ("breathe", {}),
    "pulse": ("breathe", {}),
    "heartbeat": ("flash", {"pulses": 2}),
    "flash": ("flash", {}),
    "chase": ("chase", {"tail": "long"}),
    "comet": ("chase", {"tail": "short"}),
    "scan": ("chase", {"tail": "short"}),
    "radar": ("chase", {"tail": "long"}),
    "dual_comet": ("chase", {"comets": 2}),
    "curtain": ("curtain", {"sides": "both"}),
    "wipe": ("curtain", {"sides": "one"}),
    "rainbow": ("rainbow", {"palette": "vivid"}),
    "pastel_rainbow": ("rainbow", {"palette": "soft"}),
    "sparkle": ("sparkle", {}),
    "fire": ("sparkle", {"amount": "many"}),
}

_LEGACY_TRANSITIONS = {"cut": "instant", "fade": "crossfade", "pulse": "crossfade"}

# Options every look has: where its main colour comes from ("player" = the current player's colour,
# the winner's on Leg won / Match won)
COMMON_OPTIONS: Dict[str, tuple] = {"colour_from": ("custom", ["custom", "player"])}

SPEED_MIN = 0.25
SPEED_MAX = 4.0


def normalize_options(effect_id: str, options: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The full option set for an effect: known keys only, each with an allowed value."""
    spec = {**FLOW_EFFECTS.get(effect_id, FLOW_EFFECTS["solid"])["options"], **COMMON_OPTIONS}
    given = options or {}
    out: Dict[str, Any] = {}
    for key, (default, allowed) in spec.items():
        value = given.get(key, default)
        out[key] = value if value in allowed else default
    return out


def normalize_transition_style(style: Any) -> str:
    s = str(style or "").strip().lower()
    s = _LEGACY_TRANSITIONS.get(s, s)
    return s if s in FLOW_TRANSITIONS else "crossfade"


def to_flow_effect(effect: EffectConfig) -> EffectConfig:
    """
    The curated version of an effect. Effects that already carry options are only tidied;
    older effects are converted (e.g. Radar -> Chase with a long tail). "Off" becomes a switched-off Solid.
    """
    anim = effect.animation.value if isinstance(effect.animation, AnimationType) else str(effect.animation)
    if effect.options is not None and anim in FLOW_EFFECTS:
        return dataclasses.replace(
            effect,
            options=normalize_options(anim, effect.options),
            speed=_clamp_speed(effect.speed),
        )

    if anim == "off":
        return dataclasses.replace(effect, animation=AnimationType.SOLID, enabled=False, options={}, speed=1.0)

    target, extra = _LEGACY_EFFECTS.get(anim, ("solid", {}))
    return dataclasses.replace(
        effect,
        animation=AnimationType(target),
        options=normalize_options(target, extra),
        # Old speeds meant something different per effect; start every converted look at normal speed
        speed=1.0,
        wled_effect_id=None,
        wled_effect_name=None,
    )


def _clamp_speed(speed: Any) -> float:
    try:
        v = float(speed)
    except (TypeError, ValueError):
        return 1.0
    return max(SPEED_MIN, min(SPEED_MAX, v))


def catalog_for_ui() -> Dict[str, List[Dict[str, Any]]]:
    """Effects and transitions as plain lists for the Flow Matrix page."""
    effects = []
    for eid, spec in FLOW_EFFECTS.items():
        effects.append({
            "id": eid,
            "label": spec["label"],
            "job": spec["job"],
            "options": [
                {"key": key, "default": default, "values": allowed}
                for key, (default, allowed) in spec["options"].items()
            ],
        })
    transitions = [{"id": tid, "label": label} for tid, label in FLOW_TRANSITIONS.items()]
    return {"effects": effects, "transitions": transitions}
