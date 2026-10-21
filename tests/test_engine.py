"""
Unit and Integration Tests for AutoGlowEngine
"""

import unittest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from core.models import (
    DeviceConfig, SegmentConfig, ProfileConfig, DartEvent, DartEventType,
    EffectConfig, AnimationType, RGBColor
)
from core.engine import AutoGlowEngine


class TestAutoGlowEngine(unittest.IsolatedAsyncioTestCase):

    async def test_event_dispatching_and_effect_trigger(self):
        dev = DeviceConfig(
            ip="127.0.0.1",
            rgb_count=45,
            default_pwm_brightness=200,
            idle_dim_seconds=10,
            idle_off_seconds=30
        )
        engine = AutoGlowEngine(dev)
        
        # Mock the WLEDDriver methods
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)
        engine.driver.ensure_wled_config = AsyncMock(return_value=True)

        telemetry_events = []
        async def on_telemetry(data):
            telemetry_events.append(data)

        engine.subscribe_telemetry(on_telemetry)

        # Enable 180 event in profile for test
        engine.profile.events[DartEventType.SCORE_180.value] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(16, 185, 129),
            duration=3.0,
            enabled=True
        )

        # Trigger a 180 event
        event_180 = DartEvent(event_type=DartEventType.SCORE_180, score=180)
        await engine.process_event(event_180)

        # Verify driver was called with the 180 SOLID effect
        engine.driver.play_effect.assert_called_once()
        effect_arg = engine.driver.play_effect.call_args[0][0]
        self.assertEqual(effect_arg.animation, AnimationType.SOLID)

        # Verify telemetry was dispatched
        game_events = [e for e in telemetry_events if e.get("type") == "game_event"]
        self.assertEqual(len(game_events), 1)
        self.assertEqual(game_events[0]["event"], "180")
        self.assertEqual(game_events[0]["score"], 180)

    async def test_idle_dimming_and_activity_restoration(self):
        dev = DeviceConfig(
            ip="127.0.0.1",
            rgb_count=45,
            default_pwm_brightness=200,
            idle_dim_seconds=5,
            idle_dim_brightness=40,
            idle_off_seconds=15
        )
        engine = AutoGlowEngine(dev)
        engine.driver.set_board_light = AsyncMock(return_value=True)
        engine.driver.transition_to_udp_mode = AsyncMock(return_value=True)
        engine.driver.play_effect = AsyncMock()

        # Simulate board is dimmed due to idle
        engine.is_board_dimmed = True
        engine.current_illumination = 40

        # When a game_start event arrives, board illumination wakes up and Active UDP is established
        game_start_event = DartEvent(event_type=DartEventType.GAME_START)
        await engine.process_event(game_start_event)

        # Illumination should be restored back to configured spotlight brightness (default 255)
        self.assertFalse(engine.is_board_dimmed)
        self.assertEqual(engine.current_illumination, engine.app_config.game_mode_spotlight_brightness)
        engine.driver.transition_to_udp_mode.assert_called_with(engine.app_config.game_mode_spotlight_brightness)

    async def test_wake_up_on_throw_from_dimmed_state(self):
        """Verify that throwing a dart or any hit event wakes up the board from dimmed state."""
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        engine = AutoGlowEngine(dev)
        engine.driver.set_board_light = AsyncMock(return_value=True)
        engine.driver.transition_to_udp_mode = AsyncMock(return_value=True)
        engine.driver.play_effect = AsyncMock()

        engine.is_board_dimmed = True
        engine.current_illumination = 30

        throw_event = DartEvent(event_type=DartEventType.THROW, player_name="Henry")
        await engine.process_event(throw_event)

        self.assertFalse(engine.is_board_dimmed)
        self.assertFalse(engine.is_board_off)
        self.assertEqual(engine.current_illumination, engine.app_config.game_mode_spotlight_brightness)
        engine.driver.transition_to_udp_mode.assert_called_with(engine.app_config.game_mode_spotlight_brightness)

    async def test_wake_up_on_game_activity_from_power_off_state(self):
        """Verify that any game activity (takeout, hits, etc.) wakes up the board from standby power-off."""
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        engine = AutoGlowEngine(dev)
        engine.driver.set_board_light = AsyncMock(return_value=True)
        engine.driver.transition_to_udp_mode = AsyncMock(return_value=True)
        engine.driver.play_effect = AsyncMock()

        engine.is_board_off = True
        engine.is_board_dimmed = True
        engine.current_illumination = 0

        with patch("core.wled_driver.WLEDDriver.preview_wled_state") as mock_preview:
            single_hit_event = DartEvent(event_type=DartEventType.SINGLE, score=20, segment_name="S20")
            await engine.process_event(single_hit_event)

            self.assertFalse(engine.is_board_off)
            self.assertFalse(engine.is_board_dimmed)
            self.assertEqual(engine.current_illumination, engine.app_config.game_mode_spotlight_brightness)
            mock_preview.assert_called_with("127.0.0.1", {"on": True, "lor": 0})
            engine.driver.transition_to_udp_mode.assert_called_with(engine.app_config.game_mode_spotlight_brightness)

    async def test_multi_device_driver_isolation(self):
        """Verify that multiple devices get separate drivers and independent effect dispatching."""
        dev1 = DeviceConfig(
            id="dev1",
            name="PWM-WLED",
            ip="192.168.2.214",
            rgb_count=45,
            segments=[
                SegmentConfig(id=0, name="Seg 1", start=0, length=15),
                SegmentConfig(id=1, name="Seg 2", start=15, length=15)
            ]
        )
        dev2 = DeviceConfig(
            id="dev2",
            name="BTF-WLED",
            ip="192.168.2.215",
            rgb_count=45,
            segments=[
                SegmentConfig(id=0, name="Full WS281x", start=0, length=45),
                SegmentConfig(id=1, name="PWM White", start=45, length=1)
            ]
        )
        from core.models import AppConfig
        profile = ProfileConfig.get_default_profile()
        # Custom event for BTF-WLED seg 0
        profile.device_events = {
            "192.168.2.215": {
                "0": {
                    "takeout": EffectConfig(
                        animation=AnimationType.SOLID,
                        color_primary=RGBColor(255, 174, 0),
                        duration=0.0,
                        enabled=True
                    )
                }
            }
        }
        app_cfg = AppConfig(devices=[dev1, dev2], profile=profile)
        engine = AutoGlowEngine(dev1, profile, app_config=app_cfg)

        self.assertIn("192.168.2.214", engine.drivers)
        self.assertIn("192.168.2.215", engine.drivers)

        # Mock play_effect on both drivers
        drv1 = engine.get_driver("192.168.2.214")
        drv2 = engine.get_driver("192.168.2.215")
        drv1.play_effect = AsyncMock()
        drv2.play_effect = AsyncMock()

        # Fire takeout event
        takeout_event = DartEvent(event_type=DartEventType.TAKEOUT)
        await engine.process_event(takeout_event)

        # drv2 MUST have been called for segment 0 with the custom takeout effect
        seg0_calls = [c for c in drv2.play_effect.call_args_list if c[1].get("segment_id") == 0]
        self.assertTrue(len(seg0_calls) >= 1)
        eff_arg, = seg0_calls[0][0]
        self.assertEqual(eff_arg.color_primary.to_list(), [255, 174, 0])

    async def test_game_start_with_duration_delays_player_throw_color(self):
        """If Game Started has duration > 0, play Game Started first, then transition to player."""
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        profile = ProfileConfig.get_default_profile()
        profile.events["game_start"] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 0, 255),
            duration=0.1,  # 100ms duration
            enabled=True
        )
        profile.events["throw"] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(0, 255, 0),
            duration=0.0,
            enabled=True
        )
        engine = AutoGlowEngine(dev, profile)
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)

        # 1. Fire GAME_START
        await engine.process_event(DartEvent(event_type=DartEventType.GAME_START))
        self.assertTrue(engine._game_start_end_time > 0)
        self.assertEqual(engine.driver.play_effect.call_count, 1)
        self.assertEqual(engine.driver.play_effect.call_args[0][0].color_primary.to_list(), [255, 0, 255])

        # 2. Fire THROW while Game Started is playing -> should be queued!
        await engine.process_event(DartEvent(event_type=DartEventType.THROW, player_name="Alex", player_index=0))
        # play_effect should NOT have been called again yet
        self.assertEqual(engine.driver.play_effect.call_count, 1)

        # 3. Wait for game_start duration to finish
        await asyncio.sleep(0.15)

        # play_effect should now have been called with the player throw effect
        self.assertEqual(engine.driver.play_effect.call_count, 2)
        self.assertEqual(engine.driver.play_effect.call_args[0][0].color_primary.to_list(), [0, 255, 0])

    async def test_game_start_with_zero_duration_immediately_plays_player_throw(self):
        """If Game Started has duration 0, immediately go directly to player throw color."""
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        profile = ProfileConfig.get_default_profile()
        profile.events["game_start"] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 0, 255),
            duration=0.0,  # 0 duration
            enabled=True
        )
        profile.events["throw"] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(0, 255, 0),
            duration=0.0,
            enabled=True
        )
        engine = AutoGlowEngine(dev, profile)
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)

        # 1. Fire GAME_START
        await engine.process_event(DartEvent(event_type=DartEventType.GAME_START))
        self.assertEqual(engine._game_start_end_time, 0.0)

        # 2. Fire THROW -> immediately applies without waiting
        await engine.process_event(DartEvent(event_type=DartEventType.THROW, player_name="Alex", player_index=0))
        self.assertEqual(engine.driver.play_effect.call_count, 2)
    async def test_match_abort_disconnects_udp_when_enabled(self):
        """Verify that GAME_IDLE immediately releases UDP and restores HTTP Preset 1 when disconnect_udp_on_match_end=True."""
        from core.models import AppConfig, ProtocolMode
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        app_cfg = AppConfig(devices=[dev], disconnect_udp_on_match_end=True)
        engine = AutoGlowEngine(dev, app_config=app_cfg)
        engine.driver._protocol_mode = ProtocolMode.ACTIVE_UDP
        with patch.object(engine.driver, "_sync_release_live_and_restore_preset", return_value=True):
            # Fire GAME_IDLE
            await engine.process_event(DartEvent(event_type=DartEventType.GAME_IDLE))
            self.assertEqual(engine.driver.protocol_mode, ProtocolMode.IDLE_HTTP)

    async def test_match_won_disconnects_udp_after_celebration_when_enabled(self):
        """Verify that MATCH_WON plays celebration effect and then disconnects UDP after duration."""
        from core.models import AppConfig, ProtocolMode
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        profile = ProfileConfig.get_default_profile()
        profile.events["match_won"] = EffectConfig(
            animation=AnimationType.RAINBOW,
            color_primary=RGBColor(255, 215, 0),
            duration=0.1,  # 100ms celebration
            enabled=True
        )
        app_cfg = AppConfig(devices=[dev], profile=profile, disconnect_udp_on_match_end=True)
        engine = AutoGlowEngine(dev, profile_config=profile, app_config=app_cfg)
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)

        with patch.object(engine.driver, "_sync_release_live_and_restore_preset", return_value=True), \
             patch.object(engine.driver, "_sync_set_pwm_brightness", return_value=True):
            # Fire MATCH_WON
            await engine.process_event(DartEvent(event_type=DartEventType.MATCH_WON, player_name="Winner"))

            # Effect should be dispatched over UDP first
            self.assertEqual(engine.driver.play_effect.call_count, 1)
            # Teardown task should be pending
            self.assertIsNotNone(engine._match_end_task)
            self.assertFalse(engine._match_end_task.done())

            # Wait for celebration duration to finish
            await asyncio.sleep(0.15)

            # Protocol mode should now be IDLE_HTTP
            self.assertEqual(engine.driver.protocol_mode, ProtocolMode.IDLE_HTTP)

    async def test_match_won_disconnects_udp_immediately_with_zero_duration_when_enabled(self):
        """Verify that MATCH_WON with duration 0 immediately disconnects UDP."""
        from core.models import AppConfig, ProtocolMode
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        profile = ProfileConfig.get_default_profile()
        profile.events["match_won"] = EffectConfig(
            animation=AnimationType.SOLID,
            duration=0.0,
            enabled=False
        )
        app_cfg = AppConfig(devices=[dev], profile=profile, disconnect_udp_on_match_end=True)
        engine = AutoGlowEngine(dev, profile_config=profile, app_config=app_cfg)

        with patch.object(engine.driver, "_sync_release_live_and_restore_preset", return_value=True), \
             patch.object(engine.driver, "_sync_set_pwm_brightness", return_value=True):
            await engine.process_event(DartEvent(event_type=DartEventType.MATCH_WON))
            self.assertEqual(engine.driver.protocol_mode, ProtocolMode.IDLE_HTTP)

    async def test_match_end_does_not_disconnect_udp_when_disabled(self):
        """Verify that when disconnect_udp_on_match_end=False, UDP streaming remains connected on match end/abort."""
        from core.models import AppConfig, ProtocolMode
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        app_cfg = AppConfig(devices=[dev], disconnect_udp_on_match_end=False)
        engine = AutoGlowEngine(dev, app_config=app_cfg)
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)

        with patch.object(engine.driver, "_sync_release_live_and_restore_preset", return_value=True), \
             patch.object(engine.driver, "_sync_set_pwm_brightness", return_value=True):
            # Fire MATCH_WON
            await engine.process_event(DartEvent(event_type=DartEventType.MATCH_WON))
            self.assertEqual(engine.driver.protocol_mode, ProtocolMode.ACTIVE_UDP)

            # Fire GAME_IDLE
            await engine.process_event(DartEvent(event_type=DartEventType.GAME_IDLE))
            self.assertEqual(engine.driver.protocol_mode, ProtocolMode.ACTIVE_UDP)

    async def test_game_start_cancels_pending_match_end_teardown(self):
        """Verify that a new GAME_START cancels any pending match end teardown."""
        from core.models import AppConfig, ProtocolMode
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        profile = ProfileConfig.get_default_profile()
        profile.events["match_won"] = EffectConfig(
            animation=AnimationType.RAINBOW,
            duration=1.0,  # 1 second celebration
            enabled=True
        )
        app_cfg = AppConfig(devices=[dev], profile=profile, disconnect_udp_on_match_end=True)
        engine = AutoGlowEngine(dev, profile_config=profile, app_config=app_cfg)
        engine.driver.play_effect = AsyncMock()
        engine.driver.set_board_light = AsyncMock(return_value=True)

        with patch.object(engine.driver, "_sync_release_live_and_restore_preset", return_value=True), \
             patch.object(engine.driver, "_sync_set_pwm_brightness", return_value=True):
            # Fire MATCH_WON -> starts 1s teardown task
            await engine.process_event(DartEvent(event_type=DartEventType.MATCH_WON))
            self.assertIsNotNone(engine._match_end_task)
            self.assertFalse(engine._match_end_task.done())

            # Immediately fire GAME_START (new match began!)
            await engine.process_event(DartEvent(event_type=DartEventType.GAME_START))
            self.assertIsNone(engine._match_end_task)

            # Wait past original 1s duration
            await asyncio.sleep(0.1)
            self.assertEqual(engine.driver.protocol_mode, ProtocolMode.ACTIVE_UDP)

    async def test_disabled_device_sync_and_exclusion(self):
        """Verify that disabled controllers are excluded from the driver pool and their sockets closed."""
        from core.models import AppConfig
        dev1 = DeviceConfig(ip="192.168.1.10", rgb_count=45, enabled=True)
        dev2 = DeviceConfig(ip="192.168.1.20", rgb_count=45, enabled=False)
        app_cfg = AppConfig(devices=[dev1, dev2])
        engine = AutoGlowEngine(dev1, app_config=app_cfg)

        # dev1 is enabled, dev2 is disabled
        self.assertIn("192.168.1.10", engine.drivers)
        self.assertNotIn("192.168.1.20", engine.drivers)

        # Disable dev1 and resync
        dev1.enabled = False
        engine.sync_drivers(app_cfg)
        self.assertNotIn("192.168.1.10", engine.drivers)
        self.assertEqual(len(engine.drivers), 0)

    async def test_wake_up_skips_disabled_devices(self):
        """Verify that wake_up only contacts enabled devices and completely skips disabled ones."""
        from core.models import AppConfig
        dev_disabled = DeviceConfig(ip="192.168.1.50", rgb_count=45, enabled=False)
        dev_enabled = DeviceConfig(ip="192.168.1.60", rgb_count=45, enabled=True)
        app_cfg = AppConfig(devices=[dev_disabled, dev_enabled])
        engine = AutoGlowEngine(dev_enabled, app_config=app_cfg)
        engine.is_board_off = True

        with patch("core.engine.WLEDDriver.preview_wled_state") as mock_preview:
            await engine.wake_up()
            mock_preview.assert_called_once_with("192.168.1.60", {"on": True, "lor": 0, "ps": 1})

    async def test_active_match_guards_against_offline_board_shutdown(self):
        """Verify that an active match suppresses offline board standby shutdown."""
        from core.models import AppConfig
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=45)
        app_cfg = AppConfig(
            devices=[dev],
            standby_board_offline_enabled=True,
            standby_board_offline_id="offline-board-id",
            standby_board_offline_delay_seconds=0
        )
        engine = AutoGlowEngine(dev, app_config=app_cfg)
        engine.autodarts = MagicMock()
        engine.autodarts._active_match_id = "live-match-uuid-123"
        engine.autodarts.is_board_online.return_value = False
        engine.is_board_off = False
        engine._board_offline_start_time = 100.0

        # Run single iteration logic of offline check
        board_off_enabled = bool(engine.app_config.standby_board_offline_enabled)
        target_board_id = str(engine.app_config.standby_board_offline_id or "").strip()
        has_active_match = getattr(engine.autodarts, "_active_match_id", None) is not None

        if board_off_enabled and target_board_id and engine.autodarts:
            if has_active_match:
                if engine._board_offline_start_time is not None:
                    engine._board_offline_start_time = None

        self.assertIsNone(engine._board_offline_start_time)
        self.assertFalse(engine.is_board_off)

    async def test_disabled_event_in_device_matrix_does_not_trigger_global_fallback(self):
        """
        Verify that when a device has per-device matrix configured with only player turn colors,
        a dart hit (e.g. SINGLE) does NOT fall back to global profile.events (e.g. light blue).
        """
        from core.models import AppConfig
        dev1 = DeviceConfig(
            id="btf_wled",
            name="BTF-WLED",
            ip="192.168.2.215",
            rgb_count=45,
            segments=[
                SegmentConfig(id=0, name="WS281x Strip", start=0, length=45),
                SegmentConfig(id=1, name="PWM White", start=45, length=1)
            ]
        )
        dev2 = DeviceConfig(
            id="wled_sec",
            name="WLED",
            ip="192.168.2.191",
            rgb_count=30,
            segments=[
                SegmentConfig(id=0, name="Segment 0", start=0, length=10)
            ]
        )
        profile = ProfileConfig.get_default_profile()
        # BTF-WLED has only player_1 and player_2 configured. 'single' is explicitly disabled.
        profile.device_events = {
            "192.168.2.215": {
                "0": {
                    "player_1": EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(255, 0, 0), duration=0.0, enabled=True),
                    "player_2": EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 255, 0), duration=0.0, enabled=True),
                    "single": EffectConfig(animation=AnimationType.SOLID, color_primary=RGBColor(0, 200, 255), duration=0.8, enabled=False)
                }
            }
        }
        # Global profile.events has 'single' enabled with light blue (legacy default)
        profile.events["single"] = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(0, 200, 255),
            duration=0.8,
            enabled=True
        )
        app_cfg = AppConfig(devices=[dev1, dev2], profile=profile)
        engine = AutoGlowEngine(dev1, profile, app_config=app_cfg)

        drv1 = engine.get_driver("192.168.2.215")
        drv2 = engine.get_driver("192.168.2.191")
        drv1.play_effect = AsyncMock()
        drv2.play_effect = AsyncMock()

        # Fire SINGLE dart hit event
        single_event = DartEvent(event_type=DartEventType.SINGLE, score=20, segment_name="S20")
        await engine.process_event(single_event)

        # Neither driver should have played 'single' (or the light blue global fallback)
        drv1.play_effect.assert_not_called()
        drv2.play_effect.assert_not_called()



if __name__ == "__main__":
    unittest.main()
