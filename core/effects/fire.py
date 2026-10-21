"""
AutoGlow 2 - Fire (Test) Effect
Classic heat-map fire simulation using a 1D cellular automaton.
Heat propagates upward along the strip with random turbulence,
producing realistic flickering flames in a warm orange-red-yellow palette.
"""

import random
from typing import List
from core.models import EffectConfig


def _heat_to_color(heat: float, c_hot: tuple, c_base: tuple) -> tuple:
    """
    Map heat value [0.0, 1.0] to a color along a black → base_color → hot_color gradient.
    - 0.0 - 0.4: Black to base color (embers/cool zone)
    - 0.4 - 1.0: Base color to hot color (active flame)
    """
    heat = max(0.0, min(1.0, heat))
    if heat < 0.4:
        t = heat / 0.4
        return (
            int(c_base[0] * t),
            int(c_base[1] * t),
            int(c_base[2] * t),
        )
    else:
        t = (heat - 0.4) / 0.6
        return (
            int(c_base[0] + (c_hot[0] - c_base[0]) * t),
            int(c_base[1] + (c_hot[1] - c_base[1]) * t),
            int(c_base[2] + (c_hot[2] - c_base[2]) * t),
        )


# Module-level heat buffer (persists across frames for smooth simulation)
_heat_buf: List[float] = []
_heat_count: int = 0
_heat_frame: int = -1


def render_fire(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render a Fire simulation frame.
    - Primary color: hot flame tip color (e.g., bright yellow/white).
    - Secondary color: base flame body color (e.g., deep orange/red).
    - Speed controls how fast the simulation steps per frame.
    - Fire base (index 0) ignites; heat rises toward the tip (index count-1).
    """
    global _heat_buf, _heat_count, _heat_frame

    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    speed = max(0.1, float(effect.speed))
    c1 = effect.color_primary
    c2 = effect.color_secondary

    # Hot tip: primary color | Base: secondary color
    c_hot = (c1.r, c1.g, c1.b)
    c_base = (c2.r, c2.g, c2.b)

    # Reinitialize heat buffer when strip size changes
    if len(_heat_buf) != count:
        _heat_buf = [0.0] * count
        _heat_count = count
        _heat_frame = -1

    # Step simulation N times per second based on speed (target: speed * 30 steps/s)
    step_interval = max(1, int(50 / max(0.1, speed * 3.0)))
    do_step = (frame % step_interval == 0)

    if do_step:
        rng = random.Random(frame * 1337 + int(elapsed * 100))

        # Cool down every pixel a bit (heat dissipates)
        cooling = 0.02 + 0.06 * (1.0 - min(1.0, speed))
        for i in range(count):
            _heat_buf[i] = max(0.0, _heat_buf[i] - rng.uniform(0, cooling))

        # Diffuse heat upward (heat rises: from index 0 upward to count-1)
        for i in range(count - 1, 1, -1):
            _heat_buf[i] = (
                _heat_buf[i] * 0.3
                + _heat_buf[i - 1] * 0.5
                + _heat_buf[i - 2] * 0.2
            )

        # Ignite bottom pixels (fire source)
        spark_count = max(1, int(count * 0.08))
        for _ in range(spark_count):
            pos = rng.randint(0, max(0, count // 8))
            _heat_buf[pos] = min(1.0, _heat_buf[pos] + rng.uniform(0.6, 1.0))

    # Render heat buffer to pixels
    scale = 1.0
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0

    for i in range(count):
        r, g, b = _heat_to_color(_heat_buf[i], c_hot, c_base)
        pixels[i * 3 + 0] = min(255, int(r * scale))
        pixels[i * 3 + 1] = min(255, int(g * scale))
        pixels[i * 3 + 2] = min(255, int(b * scale))

    return pixels
