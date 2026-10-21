"""
AutoGlow 2 - Rainbow (Spectrum Orbit) Effect
Continuous 360-degree chromatic spectrum rotating smoothly around the LED ring or strip.
Uses a perceptually balanced 8-sector color wheel (FastLED-grade) with smooth cosine
sub-pixel interpolation to guarantee equal visual balance between warm and cool colors.
"""

import math
from core.models import EffectConfig
from core.effects.base import get_normalized_progress

# Perceptually weighted color stops optimized for physical WS2812B LED optics.
# WS2812B green and blue diodes produce significantly more perceived lumens than red.
# We allocate 35-40% of the wheel to rich Pure Red, Orange, and Amber, and balance
# the blue/violet sector so Red is bold, prominent, and unmistakable on the physical ring.
RAINBOW_STOPS = (
    (0.00, (255, 0, 0)),       # 0.00: Solid Pure Red
    (0.12, (255, 0, 0)),       # 0.12: Pure Red hold
    (0.24, (255, 60, 0)),      # 0.24: Rich Orange / Amber
    (0.36, (255, 180, 0)),     # 0.36: Warm Golden Yellow
    (0.48, (0, 255, 10)),      # 0.48: Vibrant Emerald Green
    (0.60, (0, 220, 220)),     # 0.60: Crisp Aqua / Cyan
    (0.74, (0, 30, 240)),      # 0.74: Deep Electric Blue
    (0.88, (180, 0, 180)),     # 0.88: Royal Purple / Violet
    (1.00, (255, 0, 0)),       # 1.00: Return to Pure Red
)


def render_rainbow(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render rotating full-spectrum rainbow frame.
    - Full 360-degree perceptually balanced hue spread across the segment length.
    - Continuous orbital rotation driven by speed multiplier and elapsed time.
    - Supports Clockwise (CW) and Counter-Clockwise (CCW) rotation.
    - Smooth cosine interpolation for seamless color transitions.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    f_count = float(count)

    # Use effect duration if set (> 0), otherwise standard 2.0s per revolution baseline
    cycle_dur = effect.duration if effect.duration > 0.0 else 2.0
    progress = get_normalized_progress(
        elapsed=elapsed,
        duration=cycle_dur,
        speed=effect.speed,
        reverse=False
    )

    bri_scale = (effect.brightness / 100.0) if (effect.brightness is not None and 0 <= effect.brightness <= 100) else 1.0

    for i in range(count):
        base_pos = float(i) / f_count
        if not effect.reverse:
            # Clockwise (CW): Spectrum rotates 0 -> 1 -> 2 ...
            pos = (base_pos + progress) % 1.0
        else:
            # Counter-Clockwise (CCW): Spectrum rotates backward
            pos = (base_pos - progress) % 1.0

        # Sample weighted color stops with smooth S-curve easing
        r_f, g_f, b_f = 255.0, 0.0, 0.0
        for s_idx in range(len(RAINBOW_STOPS) - 1):
            p0, c0 = RAINBOW_STOPS[s_idx]
            p1, c1 = RAINBOW_STOPS[s_idx + 1]
            if p0 <= pos <= p1:
                t = (pos - p0) / (p1 - p0) if (p1 > p0) else 0.0
                smooth_t = 0.5 * (1.0 - math.cos(t * math.pi))
                r_f = (c0[0] + (c1[0] - c0[0]) * smooth_t) * bri_scale
                g_f = (c0[1] + (c1[1] - c0[1]) * smooth_t) * bri_scale
                b_f = (c0[2] + (c1[2] - c0[2]) * smooth_t) * bri_scale
                break

        idx = i * 3
        pixels[idx + 0] = min(255, max(0, int(r_f)))
        pixels[idx + 1] = min(255, max(0, int(g_f)))
        pixels[idx + 2] = min(255, max(0, int(b_f)))

    return pixels

