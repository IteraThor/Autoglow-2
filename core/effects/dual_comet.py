"""
AutoGlow 2 - Dual Comet (Test) Effect
Two opposing comets racing around the LED strip simultaneously.
Comet A travels forward, Comet B travels backward - they cross each other
producing a bright collision flash at the intersection point.
"""

import math
from core.models import EffectConfig


def render_dual_comet(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render a Dual Comet frame - two opposing comets chasing each other.
    - Comet A (primary color) moves forward along the strip.
    - Comet B (secondary color) moves backward along the strip.
    - When they overlap, the LED color is additively blended (collision flash).
    - Trail length scales with strip size (min 6, max 20 LEDs).
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    speed = max(0.1, float(effect.speed))
    c1 = effect.color_primary
    c2 = effect.color_secondary

    # Trail length: proportional to strip size
    trail_len = max(6, min(20, count // 6))

    # Head positions (continuous, wrapping)
    pos_a = (elapsed * speed * count * 0.5) % count
    pos_b = count - (elapsed * speed * count * 0.5) % count

    # Build float pixel buffers for additive blending
    r_buf = [0.0] * count
    g_buf = [0.0] * count
    b_buf = [0.0] * count

    def paint_comet(head: float, cr: int, cg: int, cb: int) -> None:
        head_i = int(head)
        for t in range(trail_len):
            pos = (head_i - t) % count
            # Head is brightest, trail fades with power curve
            f = math.pow(max(0.0, 1.0 - (t / float(trail_len))), 1.6)
            # Head gets a brightness boost
            if t == 0:
                f = min(1.0, f * 1.3)
            r_buf[pos] += cr * f
            g_buf[pos] += cg * f
            b_buf[pos] += cb * f

    paint_comet(pos_a, c1.r, c1.g, c1.b)
    paint_comet(pos_b, c2.r, c2.g, c2.b)

    # Apply brightness scaling and clamp to [0, 255]
    scale = 1.0
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0

    for i in range(count):
        pixels[i * 3 + 0] = min(255, int(r_buf[i] * scale))
        pixels[i * 3 + 1] = min(255, int(g_buf[i] * scale))
        pixels[i * 3 + 2] = min(255, int(b_buf[i] * scale))

    return pixels
