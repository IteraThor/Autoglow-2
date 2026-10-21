"""
AutoGlow 2 - Radar (Test) Effect
A rotating sweep line effect, like a radar scanner.
The sweep head is bright primary color, leaving a fading afterglow trail
behind it. The non-swept zone fades to secondary color.
"""

import math
from core.models import EffectConfig


def render_radar(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render a Radar sweep frame.
    - Primary color: sweep head (bright leading edge).
    - Secondary color: background / no-signal zone.
    - Speed controls the rotation speed (full revolution per 1/speed seconds).
    - The sweep leaves a decaying afterglow trail (like phosphor persistence).
    - Reverse flag: changes sweep direction.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    speed = max(0.1, float(effect.speed))
    c1 = effect.color_primary
    c2 = effect.color_secondary

    # Sweep head position [0.0, count)
    if effect.reverse:
        head = count - (elapsed * speed * count * 0.5) % count
    else:
        head = (elapsed * speed * count * 0.5) % count

    head_i = int(head)

    # Trail length: 40% of the strip (the afterglow / phosphor zone)
    trail_len = max(4, int(count * 0.4))

    scale = 1.0
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0

    for i in range(count):
        # How far behind the sweep head is this pixel? (wrap-around)
        dist_behind = (head_i - i) % count

        if dist_behind == 0:
            # Sweep head: full primary color + slight brightness boost
            r = min(255, int(c1.r * 1.2 + 40))
            g = min(255, int(c1.g * 1.2 + 40))
            b = min(255, int(c1.b * 1.2 + 40))
        elif dist_behind <= trail_len:
            # Afterglow trail: primary fades to secondary with power curve
            t = dist_behind / float(trail_len)
            fade = math.pow(1.0 - t, 1.8)
            r = int(c1.r * fade + c2.r * (1.0 - fade))
            g = int(c1.g * fade + c2.g * (1.0 - fade))
            b = int(c1.b * fade + c2.b * (1.0 - fade))
        else:
            # Dead zone: secondary color (background)
            r = c2.r
            g = c2.g
            b = c2.b

        pixels[i * 3 + 0] = min(255, int(r * scale))
        pixels[i * 3 + 1] = min(255, int(g * scale))
        pixels[i * 3 + 2] = min(255, int(b * scale))

    return pixels
