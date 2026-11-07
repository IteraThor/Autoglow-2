"""
Flow Matrix looks: the 7 curated effects and 5 transitions must work and time the same on any LED count.
"""

import itertools
import time
import unittest

from core.effects import render_animation_frame
from core.effects.flow import (
    FLOW_EFFECTS,
    FLOW_TRANSITIONS,
    MAX_FLASH_HZ,
    blend_flow,
    flash_level,
    normalize_options,
    render_flow_frame,
    to_flow_effect,
)
from core.effects.flow.transitions import FLASH_RISE
from core.game_flow import FlowTransition, GameFlow, create_default_game_flow
from core.models import AnimationType, DeviceConfig, EffectConfig, RGBColor
from core.wled_driver import WLEDDriver

COUNTS = (1, 3, 45, 300, 1500)
RED = RGBColor(255, 0, 0)
BLUE = RGBColor(0, 0, 255)


def look(anim: str, duration: float = 0.0, speed: float = 1.0, **options) -> EffectConfig:
    return EffectConfig(
        animation=AnimationType(anim),
        color_primary=RED,
        color_secondary=BLUE,
        duration=duration,
        speed=speed,
        options=normalize_options(anim, options),
    )


def option_sets(anim: str):
    spec = FLOW_EFFECTS[anim]["options"]
    keys = list(spec)
    for values in itertools.product(*(spec[k][1] for k in keys)):
        yield dict(zip(keys, values, strict=True))


def brightest(buf: bytes) -> int:
    """Index of the reddest LED."""
    reds = buf[0::3]
    return max(range(len(reds)), key=lambda i: reds[i])


class TestEveryLookOnEveryLength(unittest.TestCase):
    def test_all_effects_options_lengths_and_durations_render(self):
        for anim in FLOW_EFFECTS:
            for opts in option_sets(anim):
                for count in COUNTS:
                    for duration in (0.0, 2.0):
                        eff = look(anim, duration=duration, **opts)
                        for t in (0.0, 0.013, 0.5, 1.37, 2.0, 7.9, 3600.0):
                            buf = render_flow_frame(eff, t, count)
                            self.assertEqual(len(buf), count * 3, f"{anim} {opts} {count} LEDs t={t}")

    def test_zero_leds_gives_empty_frame(self):
        for anim in FLOW_EFFECTS:
            self.assertEqual(render_flow_frame(look(anim), 1.0, 0), bytearray())

    def test_flow_effects_go_to_flow_renderers_and_legacy_effects_do_not(self):
        flow = look("chase", tail="long")
        self.assertEqual(render_animation_frame(flow, 7, 0.7, 60), render_flow_frame(flow, 0.7, 60))
        legacy = EffectConfig(animation=AnimationType.CHASE, color_primary=RED, color_secondary=BLUE, duration=2.0)
        self.assertNotEqual(render_animation_frame(legacy, 7, 0.7, 60), render_flow_frame(flow, 0.7, 60))

    def test_brightness_scales_output(self):
        eff = look("solid")
        eff.brightness = 50
        self.assertEqual(render_flow_frame(eff, 0, 2)[0], 127)


class TestTimingIndependentOfLength(unittest.TestCase):
    def test_chase_head_is_at_the_same_place_on_every_length(self):
        for comets in (1, 2):
            for t in (0.3, 0.9, 1.7):
                eff = look("chase", comets=comets)
                spots = [brightest(render_flow_frame(eff, t, n)) / n for n in (45, 300, 1500)]
                for s in spots[1:]:
                    self.assertAlmostEqual(spots[0], s, delta=1.5 / 45, msg=f"t={t} comets={comets}")

    def test_chase_does_one_lap_in_the_same_time_on_every_length(self):
        for n in (10, 45, 300, 1500):
            eff = look("chase")
            self.assertEqual(brightest(render_flow_frame(eff, 0.0, n)), brightest(render_flow_frame(eff, 2.5, n)))

    def test_tail_is_a_share_of_the_strip(self):
        for tail, share in (("short", 0.12), ("long", 0.35)):
            for n in (100, 1000):
                buf = render_flow_frame(look("chase", tail=tail), 0.4, n)
                lit = sum(1 for i in range(n) if buf[i * 3] > 0)
                self.assertAlmostEqual(lit / n, share, delta=0.03, msg=f"{tail} on {n}")

    def test_duration_never_changes_a_loop_speed(self):
        # A step that stays (duration 0) must loop at the same pace as a timed one
        for anim in ("chase", "rainbow", "breathe", "sparkle"):
            for t in (0.2, 1.1):
                self.assertEqual(render_flow_frame(look(anim, 0.0), t, 90), render_flow_frame(look(anim, 5.0), t, 90), anim)

    def test_speed_makes_it_faster(self):
        slow = look("chase", speed=1.0)
        fast = look("chase", speed=2.0)
        self.assertEqual(render_flow_frame(slow, 1.0, 100), render_flow_frame(fast, 0.5, 100))

    def test_curtain_is_full_after_its_fill_time_on_every_length(self):
        for sides in ("both", "one"):
            for n in (3, 45, 1500):
                buf = render_flow_frame(look("curtain", duration=3.0, sides=sides), 1.2, n)
                self.assertTrue(all(buf[i * 3] == 255 for i in range(n)), f"{sides} {n}")

    def test_curtain_both_sides_is_symmetric(self):
        n = 60
        buf = render_flow_frame(look("curtain", duration=3.0), 0.5, n)
        for i in range(n):
            self.assertEqual(buf[i * 3], buf[(n - 1 - i) * 3])

    def test_sparkle_amount_is_a_share_of_the_strip(self):
        for amount in ("few", "some", "many"):
            shares = []
            for n in (200, 1500):
                lit = 0
                for k in range(40):
                    buf = render_flow_frame(look("sparkle", amount=amount), 0.1 + k * 0.37, n)
                    lit += sum(1 for i in range(n) if buf[i * 3] > 40)
                shares.append(lit / (40 * n))
            self.assertAlmostEqual(shares[0], shares[1], delta=0.03, msg=amount)
        # More means more
        self.assertLess(self._share("few"), self._share("many"))

    def _share(self, amount):
        lit = sum(
            sum(1 for i in range(300) if b[i * 3] > 40)
            for b in (render_flow_frame(look("sparkle", amount=amount), k * 0.21, 300) for k in range(30))
        )
        return lit / (30 * 300)


class TestNoSharedState(unittest.TestCase):
    def test_segments_of_different_lengths_do_not_disturb_each_other(self):
        for anim in FLOW_EFFECTS:
            eff = look(anim)
            alone = [render_flow_frame(eff, t, 45) for t in (0.1, 0.2, 0.3)]
            mixed = []
            for t in (0.1, 0.2, 0.3):
                render_flow_frame(eff, t, 300)
                mixed.append(render_flow_frame(eff, t, 45))
                render_flow_frame(eff, t, 7)
            self.assertEqual(alone, mixed, anim)


class TestFlashLimit(unittest.TestCase):
    def _flashes_per_second(self, eff, pulses, span):
        rises, prev_low, step = 0, True, 1 / 400
        t = 0.0
        while t < span:
            lv = flash_level(eff, t, pulses)
            if prev_low and lv > 0.9:
                rises += 1
                prev_low = False
            elif lv < 0.1:
                prev_low = True
            t += step
        return rises / span, rises

    def test_never_more_than_three_flashes_a_second(self):
        for pulses in (1, 2, 3):
            for duration in (0.2, 0.4, 0.6, 1.0, 2.0):
                for speed in (0.25, 1.0, 4.0):
                    eff = look("flash", duration=duration, speed=speed, pulses=pulses)
                    rate, _ = self._flashes_per_second(eff, pulses, max(duration, 1.0))
                    self.assertLessEqual(rate, MAX_FLASH_HZ + 1e-6, f"{pulses}x {duration}s speed {speed}")
                eff = look("flash", duration=0.0, speed=4.0, pulses=pulses)
                rate, _ = self._flashes_per_second(eff, pulses, 6.0)
                self.assertLessEqual(rate, MAX_FLASH_HZ + 1e-6, f"looping {pulses}x")

    def test_timed_flash_plays_the_chosen_pulses_when_there_is_time(self):
        for pulses in (1, 2, 3):
            eff = look("flash", duration=1.5, pulses=pulses)
            _, rises = self._flashes_per_second(eff, pulses, 1.5)
            self.assertEqual(rises, pulses)

    def test_timed_flash_starts_at_full_and_ends_on_the_background(self):
        eff = look("flash", duration=1.0)
        self.assertGreater(flash_level(eff, 0.04, 1), 0.95)
        self.assertEqual(render_flow_frame(eff, 1.0, 3), bytearray(bytes([0, 0, 255]) * 3))


class TestTransitions(unittest.TestCase):
    def test_every_style_starts_on_a_and_ends_on_b_at_every_length(self):
        for style in FLOW_TRANSITIONS:
            for n in COUNTS:
                a = bytes([200, 10, 10]) * n
                b = bytes([10, 10, 200]) * n
                self.assertEqual(blend_flow(a, b, 0.0, style), bytearray(a), f"{style} {n}")
                self.assertEqual(blend_flow(a, b, 1.0, style), bytearray(b), f"{style} {n}")
                for f in (0.1, 0.33, 0.5, 0.77):
                    self.assertEqual(len(blend_flow(a, b, f, style)), n * 3)

    def test_wipe_and_curtain_cover_the_same_share_on_every_length(self):
        for style in ("wipe", "curtain"):
            shares = []
            for n in (45, 300, 1500):
                out = blend_flow(bytes([255, 0, 0]) * n, bytes([0, 0, 255]) * n, 0.5, style)
                shares.append(sum(1 for i in range(n) if out[i * 3 + 2] > 127) / n)
            for s in shares:
                self.assertAlmostEqual(s, 0.5, delta=0.05, msg=style)

    def test_flash_peaks_on_the_accent_colour_once(self):
        a = bytes([255, 0, 0]) * 10
        b = bytes([0, 0, 255]) * 10
        self.assertEqual(blend_flow(a, b, FLASH_RISE, "flash", accent=(0, 255, 0))[:3], bytearray([0, 255, 0]))
        greens = [blend_flow(a, b, k / 100, "flash", accent=(0, 255, 0))[1] for k in range(101)]
        peak = greens.index(max(greens))
        self.assertTrue(all(x <= y for x, y in zip(greens[:peak], greens[1:peak + 1], strict=True)))
        self.assertTrue(all(x >= y for x, y in zip(greens[peak:], greens[peak + 1:], strict=False)))

    def test_cut_switches_immediately(self):
        self.assertEqual(blend_flow(b"\x01\x01\x01", b"\x09\x09\x09", 0.01, "instant"), bytearray(b"\x09\x09\x09"))

    def test_buffers_of_different_sizes_are_padded(self):
        self.assertEqual(len(blend_flow(b"\x01" * 6, b"\x02" * 9, 0.5, "crossfade")), 9)


class TestConversionOfOldFlows(unittest.TestCase):
    def test_old_effects_become_curated_looks(self):
        cases = {
            "radar": ("chase", {"tail": "long", "comets": 1}),
            "comet": ("chase", {"tail": "short", "comets": 1}),
            "dual_comet": ("chase", {"tail": "short", "comets": 2}),
            "heartbeat": ("flash", {"pulses": 2}),
            "pulse": ("breathe", {}),
            "wipe": ("curtain", {"sides": "one"}),
            "pastel_rainbow": ("rainbow", {"palette": "soft"}),
            "fire": ("sparkle", {"amount": "many"}),
        }
        for old, (new, opts) in cases.items():
            eff = to_flow_effect(EffectConfig(animation=AnimationType(old), speed=3.0, color_primary=RED))
            self.assertEqual(eff.animation.value, new, old)
            self.assertEqual(eff.options, {**opts, "colour_from": "custom"}, old)
            self.assertEqual(eff.color_primary, RED)
            self.assertEqual(eff.speed, 1.0)

    def test_off_becomes_a_switched_off_step(self):
        eff = to_flow_effect(EffectConfig(animation=AnimationType.OFF))
        self.assertFalse(eff.enabled)
        self.assertEqual(eff.animation, AnimationType.SOLID)

    def test_curated_effects_keep_their_options_and_bad_values_are_fixed(self):
        eff = to_flow_effect(look("chase", tail="long"))
        self.assertEqual(eff.options, {"tail": "long", "comets": 1, "colour_from": "custom"})
        eff = to_flow_effect(EffectConfig(animation=AnimationType.CHASE, options={"tail": "huge", "x": 1}, speed=99))
        self.assertEqual(eff.options, {"tail": "short", "comets": 1, "colour_from": "custom"})
        self.assertEqual(eff.speed, 4.0)

    def test_every_flow_step_uses_curated_looks(self):
        flows = [create_default_game_flow(), GameFlow.from_dict({"phases": [{"id": "turn_p1", "effect": {"animation": "scan"}}]})]
        for flow in flows:
            for eff in [s.effect for s in flow.steps.values()] + list(flow.hits.values()):
                self.assertIsNotNone(eff.options)
                self.assertIn(eff.animation.value, FLOW_EFFECTS)

    def test_old_transition_styles_are_mapped(self):
        self.assertEqual(FlowTransition(style="cut").style, "instant")
        self.assertEqual(FlowTransition(style="pulse").style, "crossfade")
        self.assertEqual(FlowTransition.from_dict({"style": "nonsense"}).style, "crossfade")

    def test_options_round_trip_and_legacy_effects_save_unchanged(self):
        eff = look("sparkle", amount="many")
        self.assertEqual(EffectConfig.from_dict(eff.to_dict()).options, {"amount": "many", "colour_from": "custom"})
        self.assertNotIn("options", EffectConfig(animation=AnimationType.CHASE).to_dict())


class TestUdpPackets(unittest.TestCase):
    def setUp(self):
        self.driver = WLEDDriver(DeviceConfig())

    def test_up_to_490_leds_is_one_drgb_packet(self):
        frame = bytes(range(256)) * 5 + bytes(190)  # 1470 bytes = 490 LEDs
        packets = self.driver._create_udp_packets(frame)
        self.assertEqual(len(packets), 1)
        self.assertEqual(packets[0][:2], bytes([0x02, 2]))
        self.assertEqual(packets[0][2:], frame)

    def test_longer_frames_split_into_dnrgb_packets_with_start_index(self):
        n = 1500
        frame = bytes((i * 7) % 256 for i in range(n * 3))
        packets = self.driver._create_udp_packets(frame)
        self.assertEqual(len(packets), 4)
        rebuilt = bytearray(n * 3)
        for p in packets:
            self.assertEqual(p[0], 0x04)
            self.assertEqual(p[1], 2)
            start = (p[2] << 8) | p[3]
            body = p[4:]
            self.assertLessEqual(len(body) // 3, 489)
            self.assertLessEqual(len(p), 1472, "must fit in one UDP datagram on a standard network")
            rebuilt[start * 3:start * 3 + len(body)] = body
        self.assertEqual([(p[2] << 8) | p[3] for p in packets], [0, 489, 978, 1467])
        self.assertEqual(bytes(rebuilt), frame)


class TestSpeed(unittest.TestCase):
    def test_1500_leds_render_well_within_a_frame(self):
        # 50 fps leaves 20 ms per frame for every segment together
        for anim in FLOW_EFFECTS:
            eff = look(anim)
            start = time.perf_counter()
            for k in range(10):
                render_flow_frame(eff, k * 0.02, 1500)
            per_frame = (time.perf_counter() - start) / 10
            self.assertLess(per_frame, 0.012, f"{anim}: {per_frame * 1000:.1f} ms")
        a, b = bytes(4500), bytes([255]) * 4500
        start = time.perf_counter()
        for style in FLOW_TRANSITIONS:
            blend_flow(a, b, 0.5, style)
        self.assertLess((time.perf_counter() - start) / len(FLOW_TRANSITIONS), 0.012)


if __name__ == "__main__":
    unittest.main()
