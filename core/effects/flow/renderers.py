"""
AutoGlow 2 - Flow Matrix effect renderers.

Rules every look follows:
- Timing comes from speed only (cycles per second at speed 1 are fixed per look), never from the LED count.
  A timed step's duration only decides how long it plays.
- Sizes are shares of the segment (tail = 12 % or 35 % of the strip), so 10 and 1500 LEDs look alike.
- No state is kept between frames: a frame depends only on (effect, elapsed, count), so segments never
  disturb each other.
- Strobing never exceeds 3 flashes per second.
"""

import math
from typing import Callable, Dict, List, Tuple

from core.models import EffectConfig
from core.effects.flow.catalog import SPEED_MAX, SPEED_MIN, normalize_options

Color = Tuple[int, int, int]

MAX_FLASH_HZ = 3.0
MIN_FLASH_PERIOD = 1.0 / MAX_FLASH_HZ

# Seconds per cycle at speed 1
BREATHE_PERIOD = 4.0
CHASE_LAP = 2.5
RAINBOW_LAP = 6.0
CURTAIN_FILL = 1.0
CURTAIN_LOOP = 3.0
SPARKLE_SLOT = 0.9
FLASH_REPEAT = 2.0

TAIL_SHARE = {"short": 0.12, "long": 0.35}
SPARKLE_CHANCE = {"few": 0.05, "some": 0.12, "many": 0.25}
EDGE_SHARE = 0.06  # soft edge of fills and wipes, as a share of the strip


def _speed(effect: EffectConfig) -> float:
    try:
        return max(SPEED_MIN, min(SPEED_MAX, float(effect.speed)))
    except (TypeError, ValueError):
        return 1.0


def _rgb(c) -> Color:
    return (int(c.r), int(c.g), int(c.b))


def _mix(a: Color, b: Color, t: float) -> Color:
    """t = 0 -> a, t = 1 -> b."""
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return (
        int(a[0] + (b[0] - a[0]) * t + 0.5),
        int(a[1] + (b[1] - a[1]) * t + 0.5),
        int(a[2] + (b[2] - a[2]) * t + 0.5),
    )


def _fill(count: int, color: Color) -> bytearray:
    return bytearray(bytes(color) * count)


def _smoothstep(t: float) -> float:
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return t * t * (3.0 - 2.0 * t)


def _hash01(a: int, b: int = 0) -> float:
    """Deterministic pseudo-random number in [0, 1) for a pair of integers."""
    h = (a * 0x9E3779B1 + b * 0x85EBCA77 + 0x165667B1) & 0xFFFFFFFF
    h ^= h >> 15
    h = (h * 0x2C1B3C6D) & 0xFFFFFFFF
    h ^= h >> 12
    h = (h * 0x297A2D39) & 0xFFFFFFFF
    h ^= h >> 15
    return h / 4294967296.0


# --- Looks ------------------------------------------------------------------

def render_solid(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    return _fill(count, _rgb(effect.color_primary))


def render_breathe(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    period = BREATHE_PERIOD / _speed(effect)
    p = (elapsed / period) % 1.0
    # Starts bright and eases evenly out and back in, so it glows rather than blinks
    level = 0.5 * (1.0 + math.cos(2.0 * math.pi * p))
    return _fill(count, _mix(_rgb(effect.color_secondary), _rgb(effect.color_primary), level))


def flash_level(effect: EffectConfig, elapsed: float, pulses: int) -> float:
    """Brightness of the Flash look in [0, 1] at a moment; at most 3 pulses per second."""
    duration = float(effect.duration or 0.0)
    if duration > 0.0:
        if elapsed >= duration:
            return 0.0
        n = max(1, min(pulses, int(duration * MAX_FLASH_HZ + 1e-9)))
        pulse_len = min(duration / n, 0.7 / _speed(effect))
        pulse_len = max(MIN_FLASH_PERIOD, pulse_len)
        k = int(elapsed // pulse_len)
        if k >= n:
            return 0.0
        t = elapsed - k * pulse_len
    else:
        pulse_len = max(MIN_FLASH_PERIOD, 0.45 / _speed(effect))
        repeat = max(pulses * pulse_len + 0.4, FLASH_REPEAT / _speed(effect))
        in_group = elapsed % repeat
        k = int(in_group // pulse_len)
        if k >= pulses:
            return 0.0
        t = in_group - k * pulse_len
    attack = min(0.04, pulse_len * 0.15)
    if t < attack:
        return t / attack
    return (1.0 - (t - attack) / (pulse_len - attack)) ** 2.2


def render_flash(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    level = flash_level(effect, elapsed, int(opts["pulses"]))
    return _fill(count, _mix(_rgb(effect.color_secondary), _rgb(effect.color_primary), level))


def render_chase(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    c_head = _rgb(effect.color_primary)
    c_bg = _rgb(effect.color_secondary)
    lap = CHASE_LAP / _speed(effect)
    progress = (elapsed / lap) % 1.0
    tail = max(1.0, count * TAIL_SHARE[opts["tail"]])
    comets = int(opts["comets"])
    n = float(count)
    direction = -1.0 if effect.reverse else 1.0

    heads = [(progress * n * direction) % n]
    if comets == 2:
        # The second comet runs the other way; they meet at the top and at the bottom
        heads.append((-progress * n * direction) % n)
    directions = [direction, -direction][:len(heads)]

    out = bytearray(count * 3)
    for i in range(count):
        centre = i + 0.5
        level = 0.0
        for head, d in zip(heads, directions, strict=True):
            # Distance behind the head along the comet's direction of travel
            behind = ((head - centre) * d) % n
            if behind > n - 1.0:
                # The pixel just ahead of the head: soft leading edge
                lv = 1.0 - (n - behind)
            elif behind <= tail:
                lv = (1.0 - behind / tail) ** 1.5
            else:
                lv = 0.0
            if lv > level:
                level = lv
        r, g, b = _mix(c_bg, c_head, level)
        j = i * 3
        out[j] = r
        out[j + 1] = g
        out[j + 2] = b
    return out


def _curtain_distance(i: int, count: int, sides: str, reverse: bool) -> float:
    """How far a pixel is from where the curtain starts, from 0 (start) to 1 (last to fill)."""
    centre = i + 0.5
    if sides == "one":
        d = centre / count
        return 1.0 - d if reverse else d
    return min(centre, count - centre) / (count / 2.0)


def render_curtain(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    c_fill = _rgb(effect.color_primary)
    c_bg = _rgb(effect.color_secondary)
    speed = _speed(effect)
    duration = float(effect.duration or 0.0)
    closing = False
    if duration > 0.0:
        fill_time = min(CURTAIN_FILL / speed, duration * 0.6)
        q = _smoothstep(elapsed / fill_time) if fill_time > 0 else 1.0
    else:
        p = (elapsed / (CURTAIN_LOOP / speed)) % 1.0
        if p < 0.4:
            q = _smoothstep(p / 0.4)
        elif p < 0.6:
            q = 1.0
        else:
            q = _smoothstep((p - 0.6) / 0.4)
            closing = True

    edge = max(EDGE_SHARE, 1.0 / max(1, count))
    front = q * (1.0 + edge)
    out = bytearray(count * 3)
    for i in range(count):
        d = _curtain_distance(i, count, opts["sides"], effect.reverse)
        covered = (front - d) / edge
        covered = 0.0 if covered < 0.0 else (1.0 if covered > 1.0 else covered)
        level = 1.0 - covered if closing else covered
        r, g, b = _mix(c_bg, c_fill, level)
        j = i * 3
        out[j] = r
        out[j + 1] = g
        out[j + 2] = b
    return out


_VIVID_STOPS = (
    (0.00, (255, 0, 0)), (0.14, (255, 70, 0)), (0.28, (255, 190, 0)), (0.42, (0, 255, 20)),
    (0.57, (0, 210, 230)), (0.71, (0, 40, 255)), (0.86, (190, 0, 210)), (1.00, (255, 0, 0)),
)
_SOFT_STOPS = (
    (0.00, (255, 90, 110)), (0.14, (255, 150, 90)), (0.28, (255, 215, 110)), (0.42, (120, 255, 150)),
    (0.57, (100, 225, 255)), (0.71, (120, 140, 255)), (0.86, (210, 120, 255)), (1.00, (255, 90, 110)),
)


def _palette_lut(stops) -> List[Color]:
    lut: List[Color] = []
    for k in range(512):
        pos = k / 512.0
        for (p0, c0), (p1, c1) in zip(stops, stops[1:], strict=False):
            if p0 <= pos <= p1:
                t = (pos - p0) / (p1 - p0)
                lut.append(_mix(c0, c1, 0.5 * (1.0 - math.cos(math.pi * t))))
                break
    return lut


_PALETTES = {"vivid": _palette_lut(_VIVID_STOPS), "soft": _palette_lut(_SOFT_STOPS)}


def render_rainbow(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    lut = _PALETTES[opts["palette"]]
    size = len(lut)
    progress = (elapsed / (RAINBOW_LAP / _speed(effect))) % 1.0
    if effect.reverse:
        progress = -progress
    out = bytearray(count * 3)
    for i in range(count):
        r, g, b = lut[int((((i + 0.5) / count + progress) % 1.0) * size) % size]
        j = i * 3
        out[j] = r
        out[j + 1] = g
        out[j + 2] = b
    return out


def render_sparkle(effect: EffectConfig, elapsed: float, count: int, opts: dict) -> bytearray:
    c_spark = _rgb(effect.color_primary)
    c_bg = _rgb(effect.color_secondary)
    chance = SPARKLE_CHANCE[opts["amount"]]
    slot = SPARKLE_SLOT / _speed(effect)
    out = _fill(count, c_bg)
    for i in range(count):
        # Every LED runs on its own offset clock, so sparkles never fire in step
        t = elapsed / slot + _hash01(i, 7919)
        k = int(t)
        if _hash01(i, k) >= chance:
            continue
        start = _hash01(k, i) * 0.4
        u = (t - k - start) / 0.6
        if u < 0.0 or u >= 1.0:
            continue
        level = u / 0.12 if u < 0.12 else math.exp(-4.5 * (u - 0.12))
        r, g, b = _mix(c_bg, c_spark, level)
        j = i * 3
        out[j] = r
        out[j + 1] = g
        out[j + 2] = b
    return out


FLOW_RENDERERS: Dict[str, Callable[[EffectConfig, float, int, dict], bytearray]] = {
    "solid": render_solid,
    "breathe": render_breathe,
    "flash": render_flash,
    "chase": render_chase,
    "curtain": render_curtain,
    "rainbow": render_rainbow,
    "sparkle": render_sparkle,
}


def render_flow_frame(effect: EffectConfig, elapsed: float, count: int) -> bytearray:
    """One frame of a Flow Matrix look for a segment of `count` LEDs."""
    if count <= 0:
        return bytearray(0)
    anim = effect.animation.value if hasattr(effect.animation, "value") else str(effect.animation)
    renderer = FLOW_RENDERERS.get(anim, render_solid)
    opts = normalize_options(anim if anim in FLOW_RENDERERS else "solid", effect.options)
    out = renderer(effect, max(0.0, float(elapsed)), count, opts)
    bri = effect.brightness
    if bri is not None and 0 <= bri < 100:
        scale = bri / 100.0
        out = bytearray(int(v * scale) for v in out)
    return out
