"""
AutoGlow 2 - Circular Chase (Orbit / Comet) Effect
Dynamic, length-independent circular orbit with smooth decaying trail.
Guarantees 1 full continuous rotation from LED 0 back to LED 0 in exactly `duration / speed` seconds.
"""

from core.models import EffectConfig
from core.effects.base import get_normalized_progress, interpolate_rgb


def render_chase(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render circular chase frame.
    - Continuous floating-point head tracking.
    - Circular distance wrapping with dynamic trail length.
    - Non-linear decay curve blending from primary to secondary color.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    c1 = effect.color_primary
    c2 = effect.color_secondary

    # Normalized forward progress [0.0, 1.0)
    progress = get_normalized_progress(
        elapsed=elapsed,
        duration=effect.duration,
        speed=effect.speed,
        reverse=False
    )

    # Dynamic trail length scaled proportionally to segment size (at least 2.5 LEDs)
    trail_len = max(2.5, count * 0.28)
    f_count = float(count)

    if not effect.reverse:
        # Clockwise (CW): Head moves 0 -> 1 -> 2 ... -> count-1 -> 0
        head_pos = progress * f_count
        for i in range(count):
            dist = (head_pos - float(i)) % f_count
            if dist < trail_len:
                factor = max(0.0, 1.0 - (dist / trail_len)) ** 1.4
            else:
                factor = 0.0
            r, g, b = interpolate_rgb(c1, c2, factor)
            idx = i * 3
            pixels[idx + 0] = r
            pixels[idx + 1] = g
            pixels[idx + 2] = b
    else:
        # Counter-Clockwise (CCW): Head moves 0 -> count-1 -> count-2 ... -> 0
        head_pos = (f_count - (progress * f_count)) % f_count
        for i in range(count):
            dist = (float(i) - head_pos) % f_count
            if dist < trail_len:
                factor = max(0.0, 1.0 - (dist / trail_len)) ** 1.4
            else:
                factor = 0.0
            r, g, b = interpolate_rgb(c1, c2, factor)
            idx = i * 3
            pixels[idx + 0] = r
            pixels[idx + 1] = g
            pixels[idx + 2] = b

    return pixels
