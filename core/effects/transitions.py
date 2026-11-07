"""
AutoGlow 2 - Frame Transitions & Blending Subsystem
Pure mathematical buffer interpolation for seamless state-aware transitions.
"""

from typing import Callable, Optional, Tuple


def _crossfade(out: bytearray, buf_a: bytearray, buf_b: bytearray, factor: float) -> None:
    """Smooth RGB interpolation from buf_a to buf_b (a buffer shorter than out counts as black)."""
    inv = 1.0 - factor
    len_a = len(buf_a)
    len_b = len(buf_b)
    for i in range(len(out)):
        va = buf_a[i] if i < len_a else 0
        vb = buf_b[i] if i < len_b else 0
        out[i] = int(va * inv + vb * factor)


def _pick_leds(out: bytearray, buf_a: bytearray, buf_b: bytearray, num_leds: int, from_b: Callable[[int], bool]) -> None:
    """Copy each LED from buf_b where from_b(led) is true, else from buf_a (black past a buffer's end)."""
    for i in range(num_leds):
        src = buf_b if from_b(i) else buf_a
        src_len = len(src)
        for idx in range(i * 3, i * 3 + 3):
            out[idx] = src[idx] if idx < src_len else 0


def blend_frames(
    buf_a: bytearray,
    buf_b: bytearray,
    factor: float,
    transition_type: str = "crossfade",
    accent_rgb: Optional[Tuple[int, int, int]] = None
) -> bytearray:
    """
    Blend two frame buffers according to factor (0.0 = 100% buf_a, 1.0 = 100% buf_b).
    Supports:
      - 'crossfade': smooth RGB interpolation
      - 'wipe': directional replacement around strip
      - 'pulse': dip down (optionally through accent color) before rising into target
      - 'flash': high-energy strobe bursts bridging source into target
      - 'curtain': symmetric dual-sided inward wipe
      - 'instant': hard cut thresholded at 0.5
    """
    factor = max(0.0, min(1.0, float(factor)))
    target_len = max(len(buf_a), len(buf_b))
    if target_len == 0:
        return bytearray(0)

    out = bytearray(target_len)
    num_leds = target_len // 3

    if transition_type == "instant":
        src = buf_b if factor >= 0.5 else buf_a
        src_len = len(src)
        for i in range(target_len):
            out[i] = src[i] if i < src_len else 0

    elif transition_type == "wipe":
        cutoff_led = int(num_leds * factor)
        _pick_leds(out, buf_a, buf_b, num_leds, lambda i: i < cutoff_led)

    elif transition_type == "curtain":
        half = max(1, num_leds // 2)
        cutoff = int(half * factor)
        # Distance from the nearer strip end
        _pick_leds(out, buf_a, buf_b, num_leds, lambda i: (i if i < half else (num_leds - 1 - i)) < cutoff)

    elif transition_type == "flash":
        if int(factor * 12.0) % 2 == 1:
            flash_col = accent_rgb or (255, 255, 255)
            for idx in range(num_leds * 3):
                out[idx] = flash_col[idx % 3]
        else:
            _crossfade(out, buf_a, buf_b, factor)

    elif transition_type == "pulse":
        # Down from buf_a to the dip (accent or black) in the first half, up into buf_b in the second
        level = abs(factor - 0.5) * 2.0
        src = buf_a if factor < 0.5 else buf_b
        src_len = len(src)
        for idx in range(num_leds * 3):
            v = src[idx] if idx < src_len else 0
            if accent_rgb:
                out[idx] = int(v * level + accent_rgb[idx % 3] * (1.0 - level))
            else:
                out[idx] = int(v * level)

    else:
        # Default: Smooth crossfade
        _crossfade(out, buf_a, buf_b, factor)

    return out
