"""
AutoGlow 2 - Flow Matrix transitions.

Blends the outgoing look (a) into the incoming look (b) of one segment. `factor` runs from 0 to 1
over the transition. Edges are a share of the strip, so a wipe takes the same time and looks the
same on any number of LEDs. Flash fires once per transition, which keeps it under 3 flashes a second.
"""

from typing import Optional, Tuple

from core.effects.flow.catalog import normalize_transition_style
from core.effects.flow.renderers import EDGE_SHARE, _curtain_distance, _smoothstep

FLASH_RISE = 0.2  # share of the transition spent rising into the flash


def blend_flow(
    buf_a: bytes,
    buf_b: bytes,
    factor: float,
    style: str = "crossfade",
    accent: Optional[Tuple[int, int, int]] = None,
    reverse: bool = False,
) -> bytearray:
    style = normalize_transition_style(style)
    n_bytes = max(len(buf_a), len(buf_b))
    if n_bytes == 0:
        return bytearray(0)
    a = bytes(buf_a).ljust(n_bytes, b"\0")
    b = bytes(buf_b).ljust(n_bytes, b"\0")
    f = 0.0 if factor < 0.0 else (1.0 if factor > 1.0 else float(factor))
    count = n_bytes // 3

    if style == "instant":
        return bytearray(b if f > 0.0 else a)

    if style == "crossfade":
        return _lerp_all(a, b, _smoothstep(f))

    if style == "flash":
        peak = bytes(accent or (255, 255, 255)) * count
        if f < FLASH_RISE:
            return _lerp_all(a, peak, _smoothstep(f / FLASH_RISE))
        # Drops quickly from the flash, then settles gently into the new look
        u = (f - FLASH_RISE) / (1.0 - FLASH_RISE)
        return _lerp_all(peak, b, 1.0 - (1.0 - u) ** 2.4)

    # wipe / curtain: a soft edge travels from the start of the strip
    sides = "one" if style == "wipe" else "both"
    edge = max(EDGE_SHARE, 1.0 / max(1, count))
    front = _smoothstep(f) * (1.0 + edge)
    out = bytearray(n_bytes)
    for i in range(count):
        d = _curtain_distance(i, count, sides, reverse)
        t = (front - d) / edge
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        j = i * 3
        for c in range(3):
            va = a[j + c]
            out[j + c] = int(va + (b[j + c] - va) * t + 0.5)
    return out


def _lerp_all(a: bytes, b: bytes, t: float) -> bytearray:
    if t <= 0.0:
        return bytearray(a)
    if t >= 1.0:
        return bytearray(b)
    return bytearray(int(va + (vb - va) * t + 0.5) for va, vb in zip(a, b, strict=True))
