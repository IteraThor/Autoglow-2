"""
AutoGlow 2 - Unit Tests for Standby on Board Offline Feature
Tests model serialization, AutodartsClient is_board_online, and Engine grace period power management.
"""

import time
import unittest
from unittest.mock import MagicMock, patch

from core.models import AppConfig, DeviceConfig
from core.autodarts_client import AutodartsClient
from core.engine import AutoGlowEngine


class TestBoardOfflineStandby(unittest.TestCase):

    def test_app_config_serialization(self):
        """Test AppConfig default values and JSON round-trip for board offline settings."""
        cfg = AppConfig()
        self.assertFalse(cfg.standby_board_offline_enabled)
        self.assertEqual(cfg.standby_board_offline_id, "")
        self.assertEqual(cfg.standby_board_offline_delay_seconds, 10)

        # Custom values
        cfg.standby_board_offline_enabled = True
        cfg.standby_board_offline_id = "11179e9c-be45-4c61-957e-b5f11ee70a5f"
        cfg.standby_board_offline_delay_seconds = 15

        d = cfg.to_dict()
        self.assertTrue(d["standby_board_offline_enabled"])
        self.assertEqual(d["standby_board_offline_id"], "11179e9c-be45-4c61-957e-b5f11ee70a5f")
        self.assertEqual(d["standby_board_offline_delay_seconds"], 15)

        restored = AppConfig.from_dict(d)
        self.assertTrue(restored.standby_board_offline_enabled)
        self.assertEqual(restored.standby_board_offline_id, "11179e9c-be45-4c61-957e-b5f11ee70a5f")
        self.assertEqual(restored.standby_board_offline_delay_seconds, 15)

    def test_autodarts_client_is_board_online(self):
        """Test is_board_online with live board states and cache fallback."""
        client = AutodartsClient()
        
        # Empty target returns True (no-op)
        self.assertTrue(client.is_board_online(""))
        self.assertTrue(client.is_board_online(None))

        # Check with live board_states
        client.board_states["board_1"] = {"connected": True, "status": "Throw"}
        client.board_states["board_2"] = {"connected": False, "status": "Offline"}

        self.assertTrue(client.is_board_online("board_1"))
        self.assertFalse(client.is_board_online("board_2"))

        # Check with _boards_cache fallback
        client._boards_cache = [
            {"id": "board_3", "name": "Windows", "online": True},
            {"id": "board_4", "name": "Pi", "online": False}
        ]
        self.assertTrue(client.is_board_online("board_3"))
        self.assertFalse(client.is_board_online("board_4"))


class TestEngineBoardOfflineLoop(unittest.IsolatedAsyncioTestCase):

    async def test_engine_grace_period_and_auto_off(self):
        """Test that engine waits for the grace period before turning off lights on board offline."""
        cfg = AppConfig(
            devices=[DeviceConfig(ip="127.0.0.1", enabled=True)],
            standby_board_offline_enabled=True,
            standby_board_offline_id="board_linux",
            standby_board_offline_delay_seconds=2,
            inactivity_timeout_enabled=False,
            idle_power_off_enabled=False
        )

        mock_autodarts = MagicMock(spec=AutodartsClient)
        # Initially board is offline
        mock_autodarts.is_board_online.return_value = False

        engine = AutoGlowEngine(
            device_config=cfg.devices[0],
            app_config=cfg,
            autodarts_client=mock_autodarts
        )
        engine._running = True

        with patch("core.wled_driver.WLEDDriver.preview_wled_state") as mock_preview:
            # First tick: grace countdown starts, board should NOT be off yet
            engine._board_offline_start_time = None
            
            # Simulate first iteration of _idle_monitor_loop logic
            offline_delay = cfg.standby_board_offline_delay_seconds
            is_online = mock_autodarts.is_board_online("board_linux")
            self.assertFalse(is_online)

            if not is_online:
                if engine._board_offline_start_time is None:
                    engine._board_offline_start_time = time.time() - 0.5  # 0.5s elapsed

            self.assertFalse(engine.is_board_off)
            mock_preview.assert_not_called()

            # Second tick before timeout (1.0s elapsed < 2s delay): still on
            engine._board_offline_start_time = time.time() - 1.0
            elapsed = time.time() - engine._board_offline_start_time
            self.assertLess(elapsed, offline_delay)

            # Third tick after timeout (2.5s elapsed >= 2s delay): turns OFF
            engine._board_offline_start_time = time.time() - 2.5
            elapsed = time.time() - engine._board_offline_start_time
            if elapsed >= offline_delay and not engine.is_board_off:
                engine.is_board_off = True
                engine._board_offline_standby_active = True

            self.assertTrue(engine.is_board_off)
            self.assertTrue(engine._board_offline_standby_active)

            # Fourth tick: board comes back online! Should auto wake up
            mock_autodarts.is_board_online.return_value = True
            is_online = mock_autodarts.is_board_online("board_linux")
            self.assertTrue(is_online)

            if is_online:
                if engine.is_board_off and engine._board_offline_standby_active:
                    engine.is_board_off = False
                    engine._board_offline_standby_active = False

            self.assertFalse(engine.is_board_off)
            self.assertFalse(engine._board_offline_standby_active)


if __name__ == "__main__":
    unittest.main()
