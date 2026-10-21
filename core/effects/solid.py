"""
AutoGlow 2 - Solid Color Effect
Renders uniform static color buffer across all LEDs in segment.
"""

from core.models import EffectConfig


def render_solid(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """Render solid color buffer."""
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    c1 = effect.color_primary
    r, g, b = c1.r, c1.g, c1.b

    for i in range(count):
        idx = i * 3
        pixels[idx + 0] = r
        pixels[idx + 1] = g
        pixels[idx + 2] = b

    return pixels
