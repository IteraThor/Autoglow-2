"""
AutoGlow 2 - Reading a controller's LED layout from WLED into AutoGlow's segments.

Used when a layout is saved (Setup), when the server starts and when the Lighting page loads, so AutoGlow's
segments follow what the controller really has.
"""

from typing import Any, Dict, Optional

from core.models import DeviceConfig, SegmentConfig, _safe_int, is_pwm_output


def unique_ranges(seg_data: list) -> list:
    """The WLED segments without leftovers: a segment covering exactly the same LEDs as an earlier one is dropped."""
    seen = set()
    out = []
    for s in seg_data or []:
        if not isinstance(s, dict):
            continue
        span = (_safe_int(s.get("start"), 0), _safe_int(s.get("stop"), 1))
        if span not in seen:
            seen.add(span)
            out.append(s)
    return out


def segments_from_wled(seg_data: list, hw_ins: Optional[list], previous: list) -> list:
    """
    AutoGlow's segments from a WLED layout. Each segment gets the data pin of the output it sits on, light
    strips are white illumination, and what only AutoGlow knows (role, hit-locator direction) is kept from the
    previous segment with the same id and start, so re-running the setup guide does not reset it. A segment that
    covers exactly the same LEDs as an earlier one is a leftover on the controller and is skipped.
    """
    outputs = [h for h in (hw_ins or []) if isinstance(h, dict)]
    before = {(p.id, p.start): p for p in previous or []}
    segments = []
    for s_idx, s in enumerate(unique_ranges(seg_data)):
        start = _safe_int(s.get("start"), 0)
        out = next((h for h in outputs if _safe_int(h.get("start"), 0) <= start < _safe_int(h.get("start"), 0) + _safe_int(h.get("len"), 1)), None)
        pwm = bool(out and is_pwm_output(out))
        pins = out.get("pin") if out else None
        pin = pins[0] if isinstance(pins, list) and pins else None
        seg_id = _safe_int(s.get("id"), s_idx)
        old = before.get((seg_id, start))
        seg = SegmentConfig(
            id=seg_id,
            name=str(s.get("n") or s.get("name") or f"Segment {s_idx}"),
            start=start,
            length=max(1, (_safe_int(s.get("stop"), 1) - start)),
            type="PWM White" if pwm else "WS281x",
            offset=max(0, _safe_int(s.get("of"), 0)),
        )
        if pin is not None:
            seg.gpio = f"GPIO {pin}"
        elif old:
            seg.gpio = old.gpio
        if pwm:
            seg.role = "white_illumination"
        elif old and old.role != "white_illumination":
            seg.role = old.role
        if old:
            seg.clockwise = old.clockwise
            seg.locator = old.locator
        segments.append(seg)
    return segments


def adopt_live_layout(dev: DeviceConfig, info: Dict[str, Any]) -> bool:
    """Take the layout of a reachable controller (WLEDDriver.fetch_live_device_info) into its config.
    Returns True when something changed."""
    if not info.get("online"):
        return False
    seg_data = (info.get("state") or {}).get("seg") or []
    if not seg_data:
        return False
    hw_ins = info.get("hw_ins") or dev.hw_ins
    segments = segments_from_wled(seg_data, hw_ins, dev.segments)
    if [s.to_dict() for s in segments] == [s.to_dict() for s in dev.segments] and hw_ins == dev.hw_ins:
        return False
    dev.segments = segments
    dev.hw_ins = hw_ins
    outs = [h for h in hw_ins or [] if isinstance(h, dict)]
    rgb = next((h for h in outs if not is_pwm_output(h)), None)
    pwm = next((h for h in outs if is_pwm_output(h)), None)
    if rgb:
        dev.rgb_count = _safe_int(rgb.get("len"), dev.rgb_count)
    dev.pwm_index = _safe_int(pwm.get("start"), 0) if pwm else None
    return True
