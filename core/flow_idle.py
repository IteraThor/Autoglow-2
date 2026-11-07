"""
AutoGlow 2 - Waiting lights of the Flow Matrix: write each segment's profile idle look to its controller.

Between games WLED plays its own idle preset (preset 1, also the boot preset), so the waiting look costs no
streaming. A profile only says which WLED effect that is; this module turns the profiles assigned to a
controller's segments into that preset. Light strips (PWM) play no profile: their saved idle brightness is kept.
"""

import asyncio
import logging
from typing import Any, Dict, Iterable, List, Optional

from core.game_flow import GameFlowStorageManager
from core.wled_driver import WLEDDriver, sanitize_wled_name

logger = logging.getLogger("autoglow.flow_idle")

IDLE_PRESET_ID = 1
IDLE_PRESET_NAME = "AutoGlow Default"


def idle_preset_segments(dev: Any, storage: GameFlowStorageManager, saved: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    The idle preset's segments for one controller. saved: the segments of its current idle preset, so
    settings AutoGlow does not manage (offset, grouping, reverse, palette ...) and light strips stay as they are.
    """
    from core.engine import _is_pwm_segment, _seg_attr, _seg_id
    by_id = {int(s["id"]): s for s in saved if isinstance(s, dict) and isinstance(s.get("id"), int)}
    segments = list(dev.segments or [])
    if not segments:
        segments = [{"id": 0, "name": dev.name or "All LEDs", "start": 0, "length": int(dev.rgb_count or 0)}]
    out = []
    for seg in segments:
        sid = _seg_id(seg)
        start = int(_seg_attr(seg, "start", 0) or 0)
        entry = dict(by_id.get(sid) or {"of": int(_seg_attr(seg, "offset", 0) or 0)})
        entry.update({"id": sid, "start": start, "stop": start + max(1, int(_seg_attr(seg, "length", 1) or 1)),
                      "n": sanitize_wled_name(_seg_attr(seg, "name", "") or f"Segment {sid}"), "sel": True})
        if _is_pwm_segment(seg):
            entry.setdefault("on", True)
            entry.setdefault("bri", 181)
            entry["fx"] = 0
        else:
            flow = storage.get_for_segment(dev.ip, sid if dev.segments else None)
            entry.update(flow.idle.wled_segment())
        out.append(entry)
    return out


def _write_device(dev: Any, storage: GameFlowStorageManager) -> None:
    try:
        saved = WLEDDriver.get_wled_preset(dev.ip, IDLE_PRESET_ID, timeout=1.5).get("seg") or []
    except Exception:
        # Unreachable controllers fail on the write below; a missing preset just starts fresh
        saved = []
    segments = idle_preset_segments(dev, storage, saved)
    WLEDDriver.save_wled_preset(dev.ip, IDLE_PRESET_ID, IDLE_PRESET_NAME, segments, 255, True)
    logger.info(f"Idle lighting of {dev.name or dev.ip} set from its flow profiles")


async def apply_idle(engine: Any, storage: GameFlowStorageManager, ips: Optional[Iterable[str]] = None,
                     profile: Optional[str] = None) -> List[str]:
    """
    Write the waiting look to the controllers (all, those in ips, or those with a segment playing profile).
    Saving the preset also shows it, so during a match it waits: the lights switch to it after the match.
    Returns the names of controllers that could not be reached.
    """
    if engine is None or not _flow_mode(engine):
        return []
    wanted = set(ips) if ips is not None else None
    devices = []
    for dev in engine._active_devices():
        if wanted is not None and dev.ip not in wanted:
            continue
        if profile is not None and not _plays(dev, storage, profile):
            continue
        devices.append(dev)
    if not devices:
        return []
    if _streaming(engine):
        # A live match owns the strips; the preset is written when it is back to waiting
        engine.flow_idle_pending = True
        return []
    loop = asyncio.get_running_loop()
    results = await asyncio.gather(*(loop.run_in_executor(None, _write_device, dev, storage) for dev in devices),
                                   return_exceptions=True)
    failed = []
    for dev, res in zip(devices, results, strict=True):
        if isinstance(res, Exception):
            logger.warning(f"Could not set the idle lighting of {dev.name or dev.ip}: {res}")
            failed.append(dev.name or dev.ip)
    return failed


def _plays(dev: Any, storage: GameFlowStorageManager, profile: str) -> bool:
    from core.engine import _is_pwm_segment, _seg_id
    if not dev.segments:
        return storage.profile_name_for(dev.ip, None) == profile
    return any(storage.profile_name_for(dev.ip, _seg_id(s)) == profile for s in dev.segments if not _is_pwm_segment(s))


def _flow_mode(engine: Any) -> bool:
    """The legacy Event Matrix leaves the idle preset to the user."""
    from core.models import LightingMode
    cfg = getattr(engine, "app_config", None)
    return not (cfg and getattr(cfg, "lighting_mode", None) == LightingMode.MATRIX)


def _streaming(engine: Any) -> bool:
    from core.models import ProtocolMode
    return any(getattr(drv, "protocol_mode", None) == ProtocolMode.ACTIVE_UDP for drv in getattr(engine, "drivers", {}).values())
