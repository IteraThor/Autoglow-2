"""
AutoGlow 2 - Sparkle (Test) Effect
Random LED pixels flash brightly and decay quickly like glitter or stars.
Each pixel has an independent random lifespan: ignites instantly, decays smoothly.
A configurable density controls how many pixels are active at once.
"""

import math
import random
from core.models import EffectConfig


# Per-channel deterministic sparkle state (persistent across frames via closure)
# Keyed by count to reinitialize when strip size changes
_sparkle_state: dict = {}


def render_sparkle(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Render a Sparkle frame.
    - Primary color: sparkle/flash color.
    - Secondary color: background/base color.
    - Speed controls sparkle ignition rate (higher = more flickering).
    - ~15% of LEDs are sparkling at any given moment.
    """
    if count <= 0:
        return bytearray(0)

    pixels = bytearray(count * 3)
    speed = max(0.1, float(effect.speed))
    c1 = effect.color_primary
    c2 = effect.color_secondary

    # Target density: ~15% of LEDs sparkling at once
    density = 0.15
    n_active = max(1, int(count * density))

    # Use frame-based seed for reproducible-but-changing pattern
    # Each sparkle has a unique offset so they don't all flash together
    for k in range(n_active):
        # Give each sparkle a unique phase offset
        seed_base = int(elapsed * speed * 7.3 + k * 137.5)
        rng = random.Random(seed_base)
        pos = rng.randint(0, count - 1)

        # Sub-frame phase for smooth decay [0.0 = just ignited, 1.0 = fully decayed]
        frac = (elapsed * speed * 7.3 + k * 137.5) % 1.0
        # Sharp attack, exponential decay
        if frac < 0.1:
            alpha = frac / 0.1
        else:
            alpha = math.exp(-5.0 * (frac - 0.1))

        r = min(255, int(c2.r + (c1.r - c2.r) * alpha))
        g = min(255, int(c2.g + (c1.g - c2.g) * alpha))
        b = min(255, int(c2.b + (c1.b - c2.b) * alpha))

        pixels[pos * 3 + 0] = max(0, r)
        pixels[pos * 3 + 1] = max(0, g)
        pixels[pos * 3 + 2] = max(0, b)

    # Fill non-sparkle pixels with secondary color (background)
    # We do this first, then override sparkle positions
    bg_pixels = bytearray(count * 3)
    for i in range(count):
        bg_pixels[i * 3 + 0] = c2.r
        bg_pixels[i * 3 + 1] = c2.g
        bg_pixels[i * 3 + 2] = c2.b

    # Overlay sparkles onto background
    for k in range(n_active):
        seed_base = int(elapsed * speed * 7.3 + k * 137.5)
        rng = random.Random(seed_base)
        pos = rng.randint(0, count - 1)

        frac = (elapsed * speed * 7.3 + k * 137.5) % 1.0
        if frac < 0.1:
            alpha = frac / 0.1
        else:
            alpha = math.exp(-5.0 * (frac - 0.1))

        r = min(255, max(0, int(c2.r + (c1.r - c2.r) * alpha)))
        g = min(255, max(0, int(c2.g + (c1.g - c2.g) * alpha)))
        b = min(255, max(0, int(c2.b + (c1.b - c2.b) * alpha)))

        # Only paint if brighter than background
        if alpha > 0.05:
            bg_pixels[pos * 3 + 0] = r
            bg_pixels[pos * 3 + 1] = g
            bg_pixels[pos * 3 + 2] = b

    # Apply brightness
    scale = 1.0
    if effect.brightness is not None and 0 <= effect.brightness <= 100:
        scale = effect.brightness / 100.0

    for i in range(count):
        pixels[i * 3 + 0] = min(255, int(bg_pixels[i * 3 + 0] * scale))
        pixels[i * 3 + 1] = min(255, int(bg_pixels[i * 3 + 1] * scale))
        pixels[i * 3 + 2] = min(255, int(bg_pixels[i * 3 + 2] * scale))

    return pixels
