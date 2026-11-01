"""
AutoGlow 2 - Flow Matrix looks: a curated set of 7 effects and 5 transitions that work on any LED count.
The Event Matrix (legacy) keeps using the renderers in core/effects.
"""

from core.effects.flow.catalog import (
    FLOW_EFFECTS,
    FLOW_TRANSITIONS,
    catalog_for_ui,
    normalize_options,
    normalize_transition_style,
    to_flow_effect,
)
from core.effects.flow.renderers import MAX_FLASH_HZ, flash_level, render_flow_frame
from core.effects.flow.transitions import blend_flow

__all__ = [
    "FLOW_EFFECTS",
    "FLOW_TRANSITIONS",
    "MAX_FLASH_HZ",
    "blend_flow",
    "catalog_for_ui",
    "flash_level",
    "normalize_options",
    "normalize_transition_style",
    "render_flow_frame",
    "to_flow_effect",
]
