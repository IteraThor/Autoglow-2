"""
AutoGlow 2 - Flash (Impact Flash / Multi-Pulse Strobe) Effect
High-energy snappy flash effect with instant attack and smooth exponential decay.
Supports configurable multi-pulse repetitions (via Speed), duration, primary color (peak),
and secondary color (trough / resting background).
"""

import math
from core.models import EffectConfig
from core.effects.base import interpolate_rgb


def render_flash(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render high-energy Flash frame with instant attack and exponential decay curve.
    - At t=0, starts at 100% Primary Color (peak intensity).
    - Decays smoothly into Secondary Color (trough / background).
    - If duration > 0, executes N flash cycles across the duration where N = max(1, round(duration * speed)).
    - If duration <= 0, continuously pulses at frequency = max(0.1, speed) Hz.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    c_pri = effect.color_primary
    c_sec = effect.color_secondary

    speed = max(0.1, float(effect.speed))
    duration = float(effect.duration)

    if duration > 0.0:
        # Exact number of flash pulses across the duration (e.g. speed=1 -> 1 flash, speed=2 -> 2 flashes)
        total_cycles = max(1, int(round(speed)))
        norm_progress = min(1.0, max(0.0, float(elapsed) / duration))

        if norm_progress >= 1.0:
            alpha = 0.0
        else:
            cycle_progress = (norm_progress * total_cycles) % 1.0
            # Exponential decay curve: 1.0 at start of cycle, decaying rapidly to 0.0
            alpha = math.pow(1.0 - cycle_progress, 2.5)
    else:
        # Continuous pulsing mode (duration = 0)
        cycle_progress = (float(elapsed) * speed) % 1.0
        alpha = math.pow(1.0 - cycle_progress, 2.5)

    # Calculate blended RGB values
    r, g, b = interpolate_rgb(c_pri, c_sec, alpha)

    # Optional brightness scaling
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0
        r = int(r * scale)
        g = int(g * scale)
        b = int(b * scale)

    # Populate frame buffer for all LEDs
    for i in range(count):
        idx = i * 3
        pixels[idx + 0] = r
        pixels[idx + 1] = g
        pixels[idx + 2] = b

    return pixels
