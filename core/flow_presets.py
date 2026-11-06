"""
AutoGlow 2 - The five starting flows, from calm to loud.

Each preset uses only the curated Flow Matrix looks. "Player colour" means the current player's colour
(the winner's on Leg won / Match won). Picking a preset in the Flow Matrix creates an editable profile.
"""

from typing import Dict, List, Optional, Tuple

from core.game_flow import FlowIdle, FlowStep, FlowTransition, GameFlow
from core.models import AnimationType, EffectConfig, RGBColor

Rgb = Tuple[int, int, int]

WHITE: Rgb = (255, 255, 255)
SOFT_WHITE: Rgb = (190, 190, 190)
DIM_WHITE: Rgb = (70, 70, 70)
BLACK: Rgb = (0, 0, 0)
GOLD: Rgb = (255, 175, 0)
RED: Rgb = (255, 0, 30)
GREY: Rgb = (120, 120, 140)
CYAN: Rgb = (0, 190, 255)

PRESET_ORDER: List[str] = ["minimal", "classic", "arena", "show", "party"]

PRESET_INFO: Dict[str, Dict[str, str]] = {
    "minimal": {"name": "Minimal", "summary": "Only shows whose turn it is. Calm and camera-friendly."},
    "classic": {"name": "Classic", "summary": "Clear player colours, gentle changes and a few highlights."},
    "arena": {"name": "Arena", "summary": "Bold, like a stage match, with a hit locator around the board."},
    "show": {"name": "Show", "summary": "Big moments feel big: score tiers, sparkle and rainbow finales."},
    "party": {"name": "Party", "summary": "Everything celebrates. Flashing during turns may disturb dart detection."},
}


def look(anim: str, primary: Rgb = WHITE, secondary: Rgb = BLACK, duration: float = 0.0, speed: float = 1.0,
         player: bool = False, enabled: bool = True, brightness: Optional[int] = None, **options) -> EffectConfig:
    if player:
        options["colour_from"] = "player"
    return EffectConfig(
        animation=AnimationType(anim),
        color_primary=RGBColor(*primary),
        color_secondary=RGBColor(*secondary),
        duration=duration,
        speed=speed,
        enabled=enabled,
        brightness=brightness,
        options=options,
    )


def off(anim: str = "solid", duration: float = 1.0) -> EffectConfig:
    return look(anim, duration=duration, enabled=False)


def comes_in(style: str, duration: float = 0.5, accent: Optional[Rgb] = None) -> FlowTransition:
    return FlowTransition(style=style, duration=duration, accent_color=RGBColor(*accent) if accent else None)


def _minimal() -> GameFlow:
    def fade() -> FlowTransition:
        return comes_in("crossfade", 0.4)

    return GameFlow(
        steps={
            "bull_off": FlowStep(off("breathe", 0), fade()),
            "game_start": FlowStep(off("curtain", 2.0), fade()),
            "turn": FlowStep(look("solid", player=True, brightness=60), fade()),
            "takeout": FlowStep(off("solid", 0), fade()),
            "leg_won": FlowStep(look("breathe", player=True, duration=3.0, speed=1.5, brightness=70), fade()),
            "match_won": FlowStep(look("breathe", player=True, duration=5.0, speed=1.25), fade()),
        },
        hits={},
        camera_friendly=True,
        idle=FlowIdle(fx=0, brightness=50, colors=[RGBColor(255, 190, 130), RGBColor(0, 0, 0), RGBColor(0, 0, 0)]),  # Waiting: WLED effect (0 Solid, 9 Rainbow, 38 Aurora)
    )


def _classic() -> GameFlow:
    return GameFlow(
        steps={
            "bull_off": FlowStep(look("breathe", SOFT_WHITE, (20, 20, 20), speed=0.8), comes_in("crossfade", 0.6)),
            "game_start": FlowStep(look("curtain", CYAN, duration=2.0), comes_in("crossfade", 0.5)),
            "turn": FlowStep(look("solid", player=True), comes_in("wipe", 0.6)),
            "takeout": FlowStep(look("solid", DIM_WHITE), comes_in("crossfade", 0.4)),
            "leg_won": FlowStep(look("curtain", player=True, duration=3.0), comes_in("crossfade", 0.4)),
            "match_won": FlowStep(look("rainbow", duration=6.0, palette="soft"), comes_in("crossfade", 0.8)),
        },
        hits={
            "180": look("flash", GOLD, duration=1.5, pulses=2),
            "bullseye": look("flash", RED, duration=1.0, pulses=1),
        },
        camera_friendly=True,
        idle=FlowIdle(fx=9, brightness=70),  # Waiting: WLED effect (0 Solid, 9 Rainbow, 38 Aurora)
    )


def _arena() -> GameFlow:
    return GameFlow(
        steps={
            "bull_off": FlowStep(look("breathe", WHITE, (25, 25, 25)), comes_in("crossfade", 0.5)),
            "game_start": FlowStep(look("curtain", WHITE, duration=2.0), comes_in("curtain", 0.8)),
            "turn": FlowStep(look("solid", player=True), comes_in("wipe", 0.5)),
            "takeout": FlowStep(look("solid", (170, 170, 170)), comes_in("crossfade", 0.3)),
            "leg_won": FlowStep(look("sparkle", player=True, secondary=(20, 20, 20), duration=4.0, amount="many"),
                                comes_in("flash", 0.5)),
            "match_won": FlowStep(look("rainbow", duration=6.0, palette="vivid"), comes_in("flash", 0.6)),
        },
        hits={
            "180": look("rainbow", duration=2.5, speed=2.0, palette="vivid"),
            "bullseye": look("flash", RED, duration=1.2, pulses=2),
            "bust": look("flash", GREY, duration=0.8, pulses=1),
        },
        camera_friendly=True,
        hit_locator=True,
        idle=FlowIdle(fx=38, brightness=80),  # Waiting: WLED effect (0 Solid, 9 Rainbow, 38 Aurora)
    )


def _show() -> GameFlow:
    return GameFlow(
        steps={
            "bull_off": FlowStep(look("chase", WHITE, (10, 10, 10), speed=0.6, tail="long"), comes_in("crossfade", 0.6)),
            "game_start": FlowStep(look("chase", CYAN, duration=2.5, speed=1.5, comets=2, tail="long"), comes_in("curtain", 0.8)),
            "turn": FlowStep(look("solid", player=True), comes_in("wipe", 0.5)),
            "takeout": FlowStep(look("solid", (170, 170, 170)), comes_in("crossfade", 0.3)),
            "leg_won": FlowStep(look("sparkle", player=True, secondary=(25, 25, 25), duration=5.0, amount="many"),
                                comes_in("flash", 0.6, accent=GOLD)),
            "match_won": FlowStep(look("rainbow", duration=8.0, palette="vivid"), comes_in("curtain", 1.0)),
        },
        hits={
            "180": look("rainbow", duration=3.0, speed=2.0, palette="vivid"),
            "bullseye": look("flash", RED, duration=1.2, pulses=2),
            "bust": look("flash", GREY, duration=0.8, pulses=1),
            "ton": look("sparkle", player=True, duration=2.0, amount="many"),
            "ton40": look("sparkle", GOLD, duration=2.5, amount="many"),
        },
        camera_friendly=True,
        hit_locator=True,
        idle=FlowIdle(fx=38),  # Waiting: WLED effect (0 Solid, 9 Rainbow, 38 Aurora)
    )


def _party() -> GameFlow:
    return GameFlow(
        steps={
            "bull_off": FlowStep(look("rainbow", palette="soft", speed=0.8), comes_in("crossfade", 0.5)),
            "game_start": FlowStep(look("rainbow", duration=3.0, speed=2.0, palette="vivid"), comes_in("flash", 0.4)),
            "turn": FlowStep(look("breathe", player=True, secondary=(30, 30, 30), speed=1.5), comes_in("wipe", 0.3)),
            "takeout": FlowStep(look("sparkle", player=True, secondary=(15, 15, 15), amount="many"), comes_in("crossfade", 0.3)),
            "leg_won": FlowStep(look("rainbow", duration=5.0, speed=2.0, palette="vivid"), comes_in("flash", 0.4)),
            "match_won": FlowStep(look("rainbow", duration=10.0, speed=1.5, palette="vivid"), comes_in("flash", 0.5, accent=GOLD)),
        },
        hits={
            "single": look("flash", player=True, duration=0.5, pulses=1),
            "double": look("flash", player=True, duration=0.8, pulses=2),
            "triple": look("flash", WHITE, duration=1.0, pulses=3),
            "bullseye": look("flash", RED, duration=1.2, pulses=3),
            "bust": look("flash", GREY, duration=0.8, pulses=1),
            "ton": look("sparkle", player=True, duration=2.0, amount="many"),
            "ton40": look("sparkle", GOLD, duration=2.5, amount="many"),
            "180": look("rainbow", duration=3.0, speed=2.5, palette="vivid"),
        },
        camera_friendly=False,
        hit_locator=True,
        idle=FlowIdle(fx=9, speed=170),  # Waiting: WLED effect (0 Solid, 9 Rainbow, 38 Aurora)
    )


_BUILDERS = {"minimal": _minimal, "classic": _classic, "arena": _arena, "show": _show, "party": _party}


def build_preset(preset_id: str, name: Optional[str] = None) -> GameFlow:
    """A fresh copy of a preset as a profile."""
    pid = preset_id if preset_id in _BUILDERS else "classic"
    flow = _BUILDERS[pid]()
    flow.name = name or PRESET_INFO[pid]["name"]
    flow.preset = pid
    return flow


def presets_for_ui() -> List[Dict[str, str]]:
    return [{"id": pid, **PRESET_INFO[pid]} for pid in PRESET_ORDER]
