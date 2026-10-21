"""
AutoGlow 2 - Effects Engine Package
Modular registry and frame generation dispatching for real-time 50 FPS UDP streaming.
"""

import math
from typing import Callable, Dict
from core.models import EffectConfig, AnimationType

from core.effects.base import get_normalized_progress, interpolate_rgb, gamma_correct
from core.effects.solid import render_solid
from core.effects.chase import render_chase
from core.effects.rainbow import render_rainbow
from core.effects.pastel_rainbow import render_pastel_rainbow
from core.effects.flash import render_flash
from core.effects.curtain import render_curtain
from core.effects.heartbeat import render_heartbeat
from core.effects.dual_comet import render_dual_comet
from core.effects.sparkle import render_sparkle
from core.effects.fire import render_fire
from core.effects.radar import render_radar
from core.effects.breathe import render_breathe
from core.effects.transitions import blend_frames


def _render_legacy_pulse(effect: EffectConfig, frame: int, elapsed: float, count: int) -> bytearray:
    pixels = bytearray(count * 3)
    speed = max(0.01, effect.speed)
    c1 = effect.color_primary
    c2 = effect.color_secondary
    factor = 0.5 * (1.0 + math.sin(elapsed * speed * 6.0))
    for i in range(count):
        pixels[i * 3 + 0] = int(c1.r * factor + c2.r * (1.0 - factor))
        pixels[i * 3 + 1] = int(c1.g * factor + c2.g * (1.0 - factor))
        pixels[i * 3 + 2] = int(c1.b * factor + c2.b * (1.0 - factor))
    return pixels


def _render_legacy_wipe(effect: EffectConfig, frame: int, elapsed: float, count: int) -> bytearray:
    pixels = bytearray(count * 3)
    speed = max(0.01, effect.speed)
    c1 = effect.color_primary
    c2 = effect.color_secondary
    progress = (elapsed * speed * 0.8) % 1.0
    fill_leds = int(count * progress)
    for i in range(count):
        p_idx = (count - 1 - i) if effect.reverse else i
        if i <= fill_leds:
            pixels[p_idx * 3 + 0] = c1.r
            pixels[p_idx * 3 + 1] = c1.g
            pixels[p_idx * 3 + 2] = c1.b
        else:
            pixels[p_idx * 3 + 0] = c2.r
            pixels[p_idx * 3 + 1] = c2.g
            pixels[p_idx * 3 + 2] = c2.b
    return pixels


def _render_legacy_breathe(effect: EffectConfig, frame: int, elapsed: float, count: int) -> bytearray:
    pixels = bytearray(count * 3)
    speed = max(0.01, effect.speed)
    c1 = effect.color_primary
    c2 = effect.color_secondary
    phase = elapsed * speed * 3.5
    norm_sin = 0.5 * (1.0 + math.sin(phase))
    factor = math.pow(norm_sin, 2.2)
    for i in range(count):
        pixels[i * 3 + 0] = int(c1.r * factor + c2.r * (1.0 - factor))
        pixels[i * 3 + 1] = int(c1.g * factor + c2.g * (1.0 - factor))
        pixels[i * 3 + 2] = int(c1.b * factor + c2.b * (1.0 - factor))
    return pixels


def _render_legacy_scan(effect: EffectConfig, frame: int, elapsed: float, count: int) -> bytearray:
    pixels = bytearray(count * 3)
    speed = max(0.01, effect.speed)
    c1 = effect.color_primary
    c2 = effect.color_secondary
    period = max(1, 2 * count - 2)
    cycle_pos = int(frame * speed * 2.0) % period
    head = cycle_pos if cycle_pos < count else (2 * count - 2 - cycle_pos)
    if effect.reverse:
        head = (count - 1) - head
    tail_len = min(5, count)
    for i in range(count):
        dist = abs(i - head)
        if dist < tail_len:
            f = max(0.0, 1.0 - (dist / float(tail_len)))
            pixels[i * 3 + 0] = int(c1.r * f + c2.r * (1.0 - f))
            pixels[i * 3 + 1] = int(c1.g * f + c2.g * (1.0 - f))
            pixels[i * 3 + 2] = int(c1.b * f + c2.b * (1.0 - f))
        else:
            pixels[i * 3 + 0] = c2.r
            pixels[i * 3 + 1] = c2.g
            pixels[i * 3 + 2] = c2.b
    return pixels


def _render_legacy_comet(effect: EffectConfig, frame: int, elapsed: float, count: int) -> bytearray:
    pixels = bytearray(count * 3)
    speed = max(0.01, effect.speed)
    c1 = effect.color_primary
    c2 = effect.color_secondary
    trail_len = min(10, count)
    head = int(frame * speed * 2.5) % count
    if effect.reverse:
        head = (count - 1) - head
    for i in range(count):
        pixels[i * 3 + 0] = c2.r
        pixels[i * 3 + 1] = c2.g
        pixels[i * 3 + 2] = c2.b
    for t in range(trail_len):
        pos = (head + t) % count if effect.reverse else (head - t) % count
        if t == 0:
            pixels[pos * 3 + 0] = min(255, int(c1.r * 1.2 + 60))
            pixels[pos * 3 + 1] = min(255, int(c1.g * 1.2 + 60))
            pixels[pos * 3 + 2] = min(255, int(c1.b * 1.2 + 60))
        else:
            f = math.pow(max(0.0, 1.0 - (t / float(trail_len))), 1.8)
            pixels[pos * 3 + 0] = int(c1.r * f + c2.r * (1.0 - f))
            pixels[pos * 3 + 1] = int(c1.g * f + c2.g * (1.0 - f))
            pixels[pos * 3 + 2] = int(c1.b * f + c2.b * (1.0 - f))
    return pixels


# Effect renderer registry mapping AnimationType to dedicated render functions
EFFECT_REGISTRY: Dict[AnimationType, Callable[[EffectConfig, int, float, int], bytearray]] = {
    AnimationType.SOLID: render_solid,
    AnimationType.CHASE: render_chase,
    AnimationType.RAINBOW: render_rainbow,
    AnimationType.PASTEL_RAINBOW: render_pastel_rainbow,
    AnimationType.FLASH: render_flash,
    AnimationType.CURTAIN: render_curtain,
    AnimationType.HEARTBEAT: render_heartbeat,
    AnimationType.DUAL_COMET: render_dual_comet,
    AnimationType.SPARKLE: render_sparkle,
    AnimationType.FIRE: render_fire,
    AnimationType.RADAR: render_radar,
    AnimationType.BREATHE: render_breathe,
    AnimationType.PULSE: _render_legacy_pulse,
    AnimationType.WIPE: _render_legacy_wipe,
    AnimationType.SCAN: _render_legacy_scan,
    AnimationType.COMET: _render_legacy_comet,
}


def render_animation_frame(
    effect: EffectConfig,
    frame: int,
    elapsed: float,
    count: int
) -> bytearray:
    """
    Main dispatch entry point for rendering an animation frame.
    Looks up the effect in EFFECT_REGISTRY, falling back to solid color if unregistered.
    """
    if count <= 0:
        return bytearray(0)

    anim = effect.animation
    renderer = EFFECT_REGISTRY.get(anim)

    if renderer:
        return renderer(effect, frame, elapsed, count)

    return render_solid(effect, frame, elapsed, count)


__all__ = [
    "render_animation_frame",
    "blend_frames",
    "EFFECT_REGISTRY",
    "get_normalized_progress",
    "interpolate_rgb",
    "gamma_correct",
    "render_solid",
    "render_chase",
    "render_rainbow",
    "render_pastel_rainbow",
    "render_flash",
    "render_curtain",
    "render_heartbeat",
    "render_dual_comet",
    "render_sparkle",
    "render_fire",
    "render_radar",
    "render_breathe",
]

