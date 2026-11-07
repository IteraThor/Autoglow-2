"""
Unit tests for Virtual WLED Server and UDP DRGB Receiver
"""

import unittest
import asyncio
import socket

from core.simulator import VirtualWLEDServer


class TestVirtualWLEDServer(unittest.IsolatedAsyncioTestCase):

    async def test_udp_packet_reception_and_decoding(self):
        # Use an ephemeral or dedicated local port
        test_port = 21330
        server = VirtualWLEDServer(host="127.0.0.1", port=test_port)
        started = await server.start()
        self.assertTrue(started)
        self.assertTrue(server.is_running)

        received_frames = []
        received_stats = []

        def on_frame(pixels, stats):
            received_frames.append(pixels)
            received_stats.append(stats)

        server.subscribe(on_frame)

        # Construct DRGB packet: 0x02, timeout=2, 3 LEDs: Red, Green, Blue
        payload = bytearray([
            0x02, 0x02,
            255, 0, 0,    # LED 0: Red
            0, 255, 0,    # LED 1: Green
            0, 0, 255     # LED 2: Blue
        ])

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.sendto(payload, ("127.0.0.1", test_port))
        sock.close()

        # Wait briefly for asyncio datagram callback
        for _ in range(20):
            if received_frames:
                break
            await asyncio.sleep(0.01)

        await server.stop()
        self.assertFalse(server.is_running)

        self.assertGreaterEqual(len(received_frames), 1)
        first_frame = received_frames[0]
        self.assertEqual(len(first_frame), 9)
        self.assertEqual(list(first_frame), [255, 0, 0, 0, 255, 0, 0, 0, 255])

        self.assertEqual(server.get_status()["led_count"], 3)

    async def test_direct_frame_tap(self):
        server = VirtualWLEDServer(host="127.0.0.1", port=21331)
        tapped = []
        server.subscribe(lambda px, st: tapped.append(px))

        # Tap raw 3-byte RGB
        raw_pixels = bytes([128, 64, 32, 200, 200, 200])
        server.tap_frame(raw_pixels)

        self.assertEqual(len(tapped), 1)
        self.assertEqual(list(tapped[0]), [128, 64, 32, 200, 200, 200])
        stats = server.get_status()
        self.assertEqual(stats["led_count"], 2)

    def test_mock_wled_api_data(self):
        server = VirtualWLEDServer()
        state = server.get_mock_state()
        self.assertTrue(state["on"])
        self.assertIn("seg", state)
        self.assertEqual(state["seg"][0]["n"], "WS281x Ring")

        info = server.get_mock_info()
        self.assertEqual(info["name"], "AutoGlow LED Simulator")
        self.assertEqual(info["leds"]["count"], 45)

    def test_ws_led_count_and_pwm_isolation(self):
        server = VirtualWLEDServer(host="127.0.0.1", port=21332)
        server.ws_led_count = 45
        server.pwm_index = 45

        # 46 LEDs: 45 WS281x LEDs (0..44) + 1 PWM White spotlight LED at index 45 (255, 255, 255)
        raw_46_leds = bytearray(46 * 3)
        # Set PWM spotlight at index 45 to bright white
        raw_46_leds[45 * 3 : 45 * 3 + 3] = bytes([255, 255, 255])
        server.tap_frame(bytes(raw_46_leds))

        stats = server.get_status()
        # Telemetry and ring led_count must report 45 WS281x LEDs, NOT 46
        self.assertEqual(stats["led_count"], 45)
        # PWM spotlight brightness should be captured in pwm_value
        self.assertEqual(stats["pwm_value"], 255)

    async def test_broadcast_simulator_frame_slices_to_ws_count(self):
        import json
        from routes.simulator_routes import broadcast_simulator_frame, active_simulator_ws_clients
        from unittest.mock import AsyncMock, MagicMock

        mock_ws = MagicMock()
        mock_ws.send_str = AsyncMock()
        active_simulator_ws_clients.add(mock_ws)

        try:
            # 46 LEDs (138 bytes)
            raw_bytes = bytearray(46 * 3)
            # Set pixel 45 to white
            raw_bytes[45 * 3 : 45 * 3 + 3] = bytes([255, 255, 255])

            await broadcast_simulator_frame(bytes(raw_bytes), {"pwm_value": 255})

            self.assertTrue(mock_ws.send_str.called)
            sent_msg = json.loads(mock_ws.send_str.call_args[0][0])
            self.assertEqual(sent_msg["led_count"], 45)
            self.assertEqual(len(sent_msg["pixels"]), 45)
            # Ensure pixel 45 was not included in pixels
            self.assertEqual(sent_msg["pwm"], 255)
        finally:
            active_simulator_ws_clients.discard(mock_ws)

    def test_led0_offset_configuration(self):
        server = VirtualWLEDServer()
        self.assertEqual(server.led0_offset, 0)
        self.assertEqual(server.led_rotation, 0)

        server.set_led_rotation(180)
        self.assertEqual(server.led_rotation, 180)
        self.assertEqual(server.led0_offset, 22)
        self.assertEqual(server.get_status()["led_rotation"], 180)

        # Test 360 degree modulo wrap
        server.set_led_rotation(360)
        self.assertEqual(server.led_rotation, 0)

        server.set_led_rotation(450)
        self.assertEqual(server.led_rotation, 90)

        server.set_led0_offset(22)
        self.assertEqual(server.led0_offset, 22)
        self.assertEqual(server.led_rotation, 176)

        from core.models import DeviceConfig
        dev = DeviceConfig.from_dict({"id": "d1", "led_rotation": 270, "led0_offset": 34})
        self.assertEqual(dev.led_rotation, 270)
        self.assertEqual(dev.led0_offset, 34)
        self.assertEqual(dev.to_dict()["led_rotation"], 270)


if __name__ == "__main__":
    unittest.main()

