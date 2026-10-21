"""
AutoGlow 2 - Heartbeat (Physiological Cardiac Double-Pulse) Effect
Simulates a natural cardiac cycle with a signature two-stage pulse:
1. 'lub' (atrial contraction, ~65% amplitude)
2. 'DUB' (ventricular contraction, 100% amplitude)
Followed by a restful diastolic pause at the secondary color until the next beat.
"""

import math
from core.models import EffectConfig
from core.effects.base import interpolate_rgb


def render_heartbeat(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render a synchronized physiological Heartbeat frame across the LED strip.
    - Synchronous full-ring pulse (all LEDs beat together like an organ/heart).
    - Double-pulse waveform:
      * 0.00 - 0.14: Pulse 1 ('lub') - Peaks at ~65% primary color intensity.
      * 0.14 - 0.20: Brief inter-beat transition.
      * 0.20 - 0.38: Pulse 2 ('DUB') - Peaks at 100% primary color intensity.
      * 0.38 - 1.00: Diastole resting pause in secondary color (rest/baseline).
    - If duration > 0, executes N full cardiac cycles where N = max(1, round(duration * speed)).
    - If duration <= 0, continuously beats at frequency = max(0.1, speed) Hz.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    c_pri = effect.color_primary
    c_sec = effect.color_secondary

    speed = max(0.1, float(effect.speed))
    duration = float(effect.duration)

    if duration > 0.0:
        total_cycles = max(1, int(round(duration * speed)))
        norm_progress = min(1.0, max(0.0, float(elapsed) / duration))

        if norm_progress >= 1.0:
            alpha = 0.0
        else:
            cycle_p = (norm_progress * total_cycles) % 1.0
            alpha = _calculate_heartbeat_alpha(cycle_p)
    else:
        # Continuous mode
        cycle_p = (float(elapsed) * speed) % 1.0
        alpha = _calculate_heartbeat_alpha(cycle_p)

    # Blend between primary (peak pulse) and secondary (resting baseline)
    r, g, b = interpolate_rgb(c_pri, c_sec, alpha)

    # Optional brightness scaling
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0
        r = int(r * scale)
        g = int(g * scale)
        b = int(b * scale)

    # Uniform full-ring pulse
    for i in range(count):
        idx = i * 3
        pixels[idx + 0] = r
        pixels[idx + 1] = g
        pixels[idx + 2] = b

    return pixels


def _calculate_heartbeat_alpha(p: float) -> float:
    """
    Calculate the instantaneous heartbeat amplitude alpha in [0.0, 1.0]
    for normalized cycle phase p in [0.0, 1.0).
    """
    if p < 0.0 or p >= 1.0:
        return 0.0

    # Pulse 1: 'lub' (0.00 to 0.14)
    if p < 0.14:
        phase = (p / 0.14) * math.pi
        return 0.65 * (math.sin(phase) ** 2)

    # Inter-beat transition (0.14 to 0.20)
    if p < 0.20:
        return 0.0

    # Pulse 2: 'DUB' (0.20 to 0.38)
    if p < 0.38:
        phase = ((p - 0.20) / 0.18) * math.pi
        return 1.00 * (math.sin(phase) ** 2)

    # Diastole / resting pause (0.38 to 1.00)
    return 0.0
