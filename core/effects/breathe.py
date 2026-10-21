"""
AutoGlow 2 - Breathe (Test) Effect
A refined breathing effect that mimics natural respiratory rhythm.
Uses a physiologically accurate inhale/exhale asymmetry:
- Inhale is faster (60% of cycle) | Exhale is slower (40% of cycle)
- Gamma-corrected brightness curve for perceptually smooth fade.
- Holds at peak brightness briefly (like a natural breath hold).
"""

import math
from core.models import EffectConfig
from core.effects.base import interpolate_rgb


def render_breathe(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render a Breathe frame with natural respiratory asymmetry.
    - Primary color: peak breath (fully inhaled / brightest).
    - Secondary color: rest color (fully exhaled / dimmest).
    - Speed controls breathing rate in breaths-per-second.
    - Inhale phase: 0.00 - 0.45 of cycle (fast ramp up)
    - Hold phase:   0.45 - 0.55 of cycle (brief plateau at peak)
    - Exhale phase: 0.55 - 1.00 of cycle (slow ramp down)
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    speed = max(0.05, float(effect.speed))
    c1 = effect.color_primary
    c2 = effect.color_secondary

    # Current phase in breath cycle [0.0, 1.0)
    cycle_p = (elapsed * speed) % 1.0

    alpha = _calculate_breathe_alpha(cycle_p)

    # Blend primary (peak) and secondary (rest) by alpha
    r, g, b = interpolate_rgb(c1, c2, alpha)

    # Apply brightness scaling
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0
        r = int(r * scale)
        g = int(g * scale)
        b = int(b * scale)

    # Uniform fill - all LEDs breathe together
    for i in range(count):
        pixels[i * 3 + 0] = r
        pixels[i * 3 + 1] = g
        pixels[i * 3 + 2] = b

    return pixels


def _calculate_breathe_alpha(p: float) -> float:
    """
    Physiologically asymmetric breathing curve.
    Returns alpha in [0.0, 1.0] where 1.0 = fully inhaled (peak brightness).

    Phases:
    - Inhale:  p in [0.00, 0.45] → sinusoidal ramp 0 → 1
    - Hold:    p in [0.45, 0.55] → plateau at 1.0
    - Exhale:  p in [0.55, 1.00] → gamma-corrected ramp 1 → 0
    """
    p = max(0.0, min(1.0, p))

    if p < 0.45:
        # Inhale: smooth sinusoidal ramp up
        phase = (p / 0.45) * (math.pi / 2.0)
        return math.sin(phase) ** 1.5

    elif p < 0.55:
        # Hold: plateau at full brightness
        return 1.0

    else:
        # Exhale: slower, gamma-corrected decay
        t = (p - 0.55) / 0.45
        return math.pow(math.cos(t * (math.pi / 2.0)), 1.8)
