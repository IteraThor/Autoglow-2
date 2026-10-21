"""
AutoGlow 2 - Animation & Pixel Frame Generation Engine
Facade for modular core.effects subsystem, maintaining 100% backward compatibility.
"""

from core.effects import (
    render_animation_frame,
    blend_frames,
    EFFECT_REGISTRY,
    get_normalized_progress,
    interpolate_rgb,
    gamma_correct
)

__all__ = [
    "render_animation_frame",
    "blend_frames",
    "EFFECT_REGISTRY",
    "get_normalized_progress",
    "interpolate_rgb",
    "gamma_correct"
]
