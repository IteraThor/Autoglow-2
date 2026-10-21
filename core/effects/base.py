"""
AutoGlow 2 - Shared Animation Math & Color Interpolation Utilities
"""

import math
from typing import Tuple, Union
from core.models import RGBColor


def get_normalized_progress(
    elapsed: float,
    duration: float,
    speed: float = 1.0,
    reverse: bool = False
) -> float:
    """
    Calculate normalized cycle progress in range [0.0, 1.0).
    At speed=1.0, 1 full cycle completes exactly in duration seconds.
    """
    safe_dur = max(0.05, float(duration))
    safe_speed = max(0.01, float(speed))
    raw_progress = (float(elapsed) / safe_dur * safe_speed) % 1.0
    if reverse:
        return (1.0 - raw_progress) % 1.0
    return raw_progress


def interpolate_rgb(
    c1: Union[RGBColor, Tuple[int, int, int]],
    c2: Union[RGBColor, Tuple[int, int, int]],
    factor: float
) -> Tuple[int, int, int]:
    """
    Linearly interpolate between color c1 (factor=1.0) and color c2 (factor=0.0).
    """
    f = max(0.0, min(1.0, float(factor)))
    inv = 1.0 - f

    r1, g1, b1 = (c1.r, c1.g, c1.b) if isinstance(c1, RGBColor) else c1[:3]
    r2, g2, b2 = (c2.r, c2.g, c2.b) if isinstance(c2, RGBColor) else c2[:3]

    return (
        int(r1 * f + r2 * inv),
        int(g1 * f + g2 * inv),
        int(b1 * f + b2 * inv)
    )


def gamma_correct(val: float, gamma: float = 2.2) -> float:
    """
    Apply gamma correction to a normalized [0.0, 1.0] intensity value for organic LED perception.
    """
    v = max(0.0, min(1.0, float(val)))
    return math.pow(v, gamma)
