"""
AutoGlow 2 - Split Curtain (Dual Symmetrical Wipe) Effect
Light sweeps outward symmetrically from top (12 o'clock / LED 0) down both sides to bottom (6 o'clock),
filling the board with color, then retracting or wiping cleanly back to the resting background.
"""

from core.models import EffectConfig
from core.effects.base import interpolate_rgb


def render_curtain(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render Split Curtain animation frame at 50 FPS.
    - Symmetrical dual-beam expansion:
      - Normal (reverse=False): Opens from Top (LED 0) -> Bottom (LED count/2), then closes Top -> Bottom.
      - Inverted (reverse=True): Opens from Bottom (LED count/2) -> Top (LED 0), then closes Bottom -> Top.
    - Uses smooth anti-aliased leading edges for high visual fidelity on physical LEDs.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    c_pri = effect.color_primary
    c_sec = effect.color_secondary

    speed = max(0.1, float(effect.speed))
    duration = float(effect.duration)

    if duration > 0.0:
        # Scale progress by speed: 1.0 cycle completes in duration / speed seconds
        norm_progress = min(1.0, max(0.0, (float(elapsed) * speed) / duration))
    else:
        # Continuous cycling mode (duration = 0)
        norm_progress = (float(elapsed) * speed * 0.5) % 1.0

    # Halfway LED count for symmetrical split
    half_count = count / 2.0
    feather = 1.5 / max(1.0, half_count)  # Smooth anti-aliased edge over ~1.5 LEDs
    span = 1.0 + feather

    bri_scale = (effect.brightness / 100.0) if (effect.brightness is not None and 0 <= effect.brightness <= 100) else 1.0

    # Phase 1: Open (0.0 -> 0.5), Phase 2: Close (0.5 -> 1.0)
    if norm_progress <= 0.5:
        # Opening phase: p goes from -feather -> 1.0
        p = (norm_progress * 2.0) * span - feather
        is_closing = False
    else:
        # Closing phase: p goes from -feather -> 1.0
        p = ((norm_progress - 0.5) * 2.0) * span - feather
        is_closing = True

    for i in range(count):
        # Normalized symmetric distance from top (LED 0): 0.0 at top, 1.0 at bottom
        symmetric_dist = min(float(i), float(count - i)) / max(1.0, half_count)

        # Invert distance if reverse is requested (Bottom-Up curtain)
        dist = (1.0 - symmetric_dist) if effect.reverse else symmetric_dist

        if not is_closing:
            # Opening phase: fill primary color as front p advances
            if dist <= p:
                alpha = 1.0
            elif dist >= p + feather:
                alpha = 0.0
            else:
                alpha = (p + feather - dist) / feather
        else:
            # Closing phase: clear to secondary color as trailing front p advances
            if dist <= p:
                alpha = 0.0
            elif dist >= p + feather:
                alpha = 1.0
            else:
                alpha = (dist - p) / feather

        alpha = max(0.0, min(1.0, alpha))
        r, g, b = interpolate_rgb(c_pri, c_sec, alpha)

        if bri_scale < 1.0:
            r = int(r * bri_scale)
            g = int(g * bri_scale)
            b = int(b * bri_scale)

        idx = i * 3
        pixels[idx + 0] = r
        pixels[idx + 1] = g
        pixels[idx + 2] = b

    return pixels
