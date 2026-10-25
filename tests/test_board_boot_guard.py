"""
Unit tests for Board Boot Guard and Idle HTTP Mode retention.
Verifies that spurious camera boot events (Manual Reset, Started, Throw outside game)
do not engage Active UDP streaming mode.
"""

import unittest
import asyncio
from unittest.mock import MagicMock, AsyncMock, patch
from core.models import AppConfig, DeviceConfig, SegmentConfig, ProfileConfig
from core.autodarts_client import AutodartsClient, DartEvent, DartEventType
from core.engine import AutoGlowEngine, ProtocolMode


class TestBoardBootGuard(unittest.TestCase):
    def setUp(self):
        self.device = DeviceConfig(
            id="dev1",
            name="Test WLED",
            ip="192.168.1.100",
            segments=[
                SegmentConfig(id=0, name="Ring", type="WS281x", role="dartboard_ring", start=0, length=60),
                SegmentConfig(id=1, name="Spotlight", type="PWM White", role="white_illumination", start=60, length=1)
            ]
        )
        self.cfg = AppConfig(
            devices=[self.device],
            profile=ProfileConfig.get_default_profile(),
            auto_connect_udp_on_game_start=True,
            disconnect_udp_on_match_end=True,
        )

    def test_boot_signals_outside_active_match_do_not_emit_throw(self):
        """Test that AutodartsClient does NOT emit THROW on camera manual reset when no match is running."""
        async def run_test():
            client = AutodartsClient()
            client._active_match_id = None
            emitted_events = []

            async def on_event(ev: DartEvent):
                emitted_events.append(ev)

            client.on_event = on_event

            mock_ws = AsyncMock()

            # 1. Simulate camera manual reset event on board boot
            msg_reset = {
                "channel": "autodarts.boards",
                "topic": "board-uuid-1.events",
                "data": {"event": "Manual reset", "throw": {"segment": {"bed": "", "multiplier": 0, "name": "", "number": 0}}}
            }
            await client._handle_raw_message(mock_ws, msg_reset)

            # 2. Simulate camera status "Throw" on board boot
            msg_state = {
                "channel": "autodarts.boards",
                "topic": "board-uuid-1.state",
                "data": {"connected": True, "event": "Started", "status": "Throw"}
            }
            await client._handle_raw_message(mock_ws, msg_state)

            # Assert: No THROW event emitted because no match is active!
            throw_events = [e for e in emitted_events if e.event_type == DartEventType.THROW]
            self.assertEqual(len(throw_events), 0)

        asyncio.run(run_test())

    def test_in_game_signals_emit_throw_and_flow_state(self):
        """Test that AutodartsClient emits THROW and flow state when an active match is present."""
        async def run_test():
            client = AutodartsClient()
            client._active_match_id = "match-uuid-123"
            emitted_events = []

            async def on_event(ev: DartEvent):
                emitted_events.append(ev)

            client.on_event = on_event

            mock_ws = AsyncMock()

            # Simulate camera manual reset event during an active game
            msg_reset = {
                "channel": "autodarts.boards",
                "topic": "board-uuid-1.events",
                "data": {"event": "Manual reset", "throw": {"segment": {"bed": "", "multiplier": 0, "name": "", "number": 0}}}
            }
            await client._handle_raw_message(mock_ws, msg_reset)

            # Assert: In active game, THROW event is emitted!
            throw_events = [e for e in emitted_events if e.event_type == DartEventType.THROW]
            self.assertGreaterEqual(len(throw_events), 1)

        asyncio.run(run_test())

    def test_engine_wakes_to_idle_http_on_board_reconnect(self):
        """Test that engine wakes to IDLE_HTTP mode (Preset 1) when board reconnects from standby."""
        async def run_test():
            mock_autodarts = MagicMock()
            mock_autodarts.is_board_online.return_value = True
            mock_autodarts._active_match_id = None

            engine = AutoGlowEngine(
                device_config=self.device,
                app_config=self.cfg,
                autodarts_client=mock_autodarts
            )
            engine.is_board_off = True

            with patch("core.wled_driver.WLEDDriver.preview_wled_state") as mock_preview:
                await engine.wake_up(mode=ProtocolMode.IDLE_HTTP)

                self.assertFalse(engine.is_board_off)
                # Verify that driver is in IDLE_HTTP mode
                driver = engine.get_driver("192.168.1.100")
                self.assertEqual(driver.protocol_mode, ProtocolMode.IDLE_HTTP)
                
                # Check that preview_wled_state turned on with preset 1
                mock_preview.assert_called_with("192.168.1.100", {"on": True, "lor": 0, "ps": 1})

        asyncio.run(run_test())

    def test_engine_process_event_gating_udp_only_in_game(self):
        """Test that process_event only engages UDP mode for game_start or in-game events."""
        async def run_test():
            mock_autodarts = MagicMock()
            mock_autodarts._active_match_id = None

            engine = AutoGlowEngine(
                device_config=self.device,
                app_config=self.cfg,
                autodarts_client=mock_autodarts
            )
            driver = engine.get_driver("192.168.1.100")
            await driver.transition_to_http_mode()

            # 1. Send idle event (calibrating outside match) -> remains in IDLE_HTTP
            await engine.process_event(DartEvent(event_type=DartEventType.CALIBRATING))
            self.assertEqual(driver.protocol_mode, ProtocolMode.IDLE_HTTP)

            # 2. Send GAME_START event -> engages ACTIVE_UDP mode!
            with patch("core.wled_driver.WLEDDriver.preview_wled_state"):
                await engine.process_event(DartEvent(event_type=DartEventType.GAME_START))
                self.assertEqual(driver.protocol_mode, ProtocolMode.ACTIVE_UDP)

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
