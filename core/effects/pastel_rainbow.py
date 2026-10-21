"""
AutoGlow 2 - Pastel Rainbow (Aurora Rainbow) Effect
Soft, dreamy pastel chromatic spectrum rotating smoothly around the LED ring or strip.
Generates an 8-sector pastel aurora color palette with smooth cosine sub-pixel easing.
"""

import math
from core.models import EffectConfig
from core.effects.base import get_normalized_progress

# 8-Sector Pastel / Aurora Palette
# Calibrated for WS2812B LEDs — rich luminous pastel tones with punchy chromatic
# separation that eliminate white washout while preserving soft aurora character:
# 1. Pastel Coral / Soft Red:      [255, 35, 20]
# 2. Soft Apricot / Peach:         [255, 100, 10]
# 3. Buttercup / Warm Cream:       [255, 175, 5]
# 4. Mint / Seafoam Green:         [15, 240, 70]
# 5. Ice Aqua / Sky Cyan:          [5, 185, 255]
# 6. Soft Periwinkle / Sky Blue:   [30, 90, 255]
# 7. Lavender / Vivid Violet:      [160, 25, 255]
# 8. Pastel Rose / Pink Orchid:    [255, 20, 120]
PASTEL_STOPS = (
    (0.000, (255, 35, 20)),      # Pastel Coral / Soft Red
    (0.125, (255, 100, 10)),     # Soft Apricot / Peach
    (0.250, (255, 175, 5)),      # Buttercup / Warm Cream
    (0.375, (15, 240, 70)),      # Mint / Seafoam Green
    (0.500, (5, 185, 255)),      # Ice Aqua / Sky Cyan
    (0.625, (30, 90, 255)),      # Soft Periwinkle / Sky Blue
    (0.750, (160, 25, 255)),     # Lavender / Vivid Violet
    (0.875, (255, 20, 120)),     # Pastel Rose / Pink Orchid
    (1.000, (255, 35, 20)),      # Return to Pastel Coral
)


def render_pastel_rainbow(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render rotating pastel rainbow (aurora) frame.
    - Full 360-degree pastel spectrum spread across the segment length.
    - Continuous orbital rotation driven by speed multiplier and elapsed time.
    - Supports Clockwise (CW) and Counter-Clockwise (CCW) rotation.
    - Continuous sub-pixel cosine interpolation for seamless color transitions.
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

        # Sample pastel stops with smooth S-curve easing
        r_f, g_f, b_f = 255.0, 105.0, 115.0
        for s_idx in range(len(PASTEL_STOPS) - 1):
            p0, c0 = PASTEL_STOPS[s_idx]
            p1, c1 = PASTEL_STOPS[s_idx + 1]
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
