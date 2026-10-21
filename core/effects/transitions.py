"""
AutoGlow 2 - Frame Transitions & Blending Subsystem
Pure mathematical buffer interpolation for seamless state-aware transitions.
"""

from typing import Optional, Tuple


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
    len_a = len(buf_a)
    len_b = len(buf_b)
    target_len = max(len_a, len_b)
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
        for i in range(num_leds):
            src = buf_b if i < cutoff_led else buf_a
            src_len = len(src)
            for ch in range(3):
                idx = i * 3 + ch
                out[idx] = src[idx] if idx < src_len else 0

    elif transition_type == "curtain":
        half = max(1, num_leds // 2)
        cutoff = int(half * factor)
        for i in range(num_leds):
            edge_dist = i if i < half else (num_leds - 1 - i)
            src = buf_b if edge_dist < cutoff else buf_a
            src_len = len(src)
            for ch in range(3):
                idx = i * 3 + ch
                out[idx] = src[idx] if idx < src_len else 0

    elif transition_type == "flash":
        is_flash_on = (int(factor * 12.0) % 2 == 1)
        if is_flash_on:
            flash_col = accent_rgb or (255, 255, 255)
            for i in range(num_leds):
                for ch in range(3):
                    out[i * 3 + ch] = flash_col[ch]
        else:
            inv = 1.0 - factor
            for i in range(target_len):
                va = buf_a[i] if i < len_a else 0
                vb = buf_b[i] if i < len_b else 0
                out[i] = int(va * inv + vb * factor)

    elif transition_type == "pulse":
        dip = abs(factor - 0.5) * 2.0
        if factor < 0.5:
            for i in range(num_leds):
                for ch in range(3):
                    idx = i * 3 + ch
                    va = buf_a[idx] if idx < len_a else 0
                    if accent_rgb:
                        out[idx] = int(va * dip + accent_rgb[ch] * (1.0 - dip))
                    else:
                        out[idx] = int(va * dip)
        else:
            rise = (factor - 0.5) * 2.0
            for i in range(num_leds):
                for ch in range(3):
                    idx = i * 3 + ch
                    vb = buf_b[idx] if idx < len_b else 0
                    if accent_rgb:
                        out[idx] = int(vb * rise + accent_rgb[ch] * (1.0 - rise))
                    else:
                        out[idx] = int(vb * rise)

    else:
        # Default: Smooth crossfade
        inv = 1.0 - factor
        for i in range(target_len):
            va = buf_a[i] if i < len_a else 0
            vb = buf_b[i] if i < len_b else 0
            out[i] = int(va * inv + vb * factor)

    return out
