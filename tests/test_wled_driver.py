"""
Unit tests for WLEDDriver and Domain Models (standard library unittest)
"""

import unittest
import asyncio
import json
from unittest.mock import patch, MagicMock

from core.models import (
    DartEventType, DeviceConfig, EffectConfig, SegmentConfig,
    AnimationType, RGBColor, ProfileConfig, ProtocolMode
)
from core.wled_driver import WLEDDriver, sanitize_wled_name


class TestWLEDDriverAndModels(unittest.IsolatedAsyncioTestCase):

    def test_domain_models(self):
        # Test Default Profile creation
        profile = ProfileConfig.get_default_profile()
        self.assertIn(DartEventType.SCORE_180.value, profile.events)
        self.assertEqual(profile.events[DartEventType.SCORE_180.value].animation, AnimationType.SOLID)
        
        # Test DeviceConfig defaults
        dev = DeviceConfig()
        self.assertEqual(dev.ip, "")
        self.assertEqual(dev.rgb_count, 45)
        self.assertEqual(dev.pwm_index, 45)
        self.assertEqual(dev.udp_port, 21324)

    def test_sanitize_wled_name(self):
        self.assertEqual(sanitize_wled_name("Henry's Board"), "Henrys Board")
        self.assertEqual(sanitize_wled_name('Test "Ring" <1>'), "Test Ring 1")
        self.assertEqual(sanitize_wled_name("Clean-Name_01"), "Clean-Name_01")
        # Ensure 32 character limit
        self.assertEqual(len(sanitize_wled_name("a" * 50)), 32)

    def test_fetch_live_device_info_mocked(self):
        mock_json_resp = MagicMock()
        mock_json_resp.read.return_value = json.dumps({
            "info": {"name": "Gledopto Controller", "ver": "0.14.0"},
            "state": {
                "on": True,
                "bri": 255,
                "seg": [{"id": 0, "n": "Ring", "start": 0, "stop": 45, "on": True, "bri": 255}]
            }
        }).encode("utf-8")
        mock_json_resp.__enter__.return_value = mock_json_resp

        mock_cfg_resp = MagicMock()
        mock_cfg_resp.read.return_value = json.dumps({
            "hw": {"led": {"ins": [{"pin": [33], "type": 22, "start": 0, "len": 45}]}}
        }).encode("utf-8")
        mock_cfg_resp.__enter__.return_value = mock_cfg_resp

        with patch("core.wled_driver.is_host_online", return_value=True), \
             patch("urllib.request.urlopen", side_effect=[mock_json_resp, mock_cfg_resp]):
            info = WLEDDriver.fetch_live_device_info("192.168.1.100")
            self.assertEqual(info["status"], "ok")
            self.assertTrue(info["online"])
            self.assertEqual(info["name"], "Gledopto Controller")
            self.assertEqual(len(info["segments"]), 1)
            self.assertEqual(info["segments"][0]["type"], "WS281x")
            self.assertEqual(info["segments"][0]["gpio"], "GPIO 33")

    def test_apply_wled_mutations_mocked(self):
        mock_cfg_resp = MagicMock()
        mock_cfg_resp.read.return_value = b"{}"
        mock_cfg_resp.__enter__.return_value = mock_cfg_resp

        mock_existing_seg_resp = MagicMock()
        mock_existing_seg_resp.read.return_value = b'{"seg": [{"id": 0, "stop": 45}]}'
        mock_existing_seg_resp.__enter__.return_value = mock_existing_seg_resp

        mock_state_resp = MagicMock()
        mock_state_resp.read.return_value = b"{}"
        mock_state_resp.__enter__.return_value = mock_state_resp

        mock_readback_resp = MagicMock()
        mock_readback_resp.read.return_value = json.dumps({
            "state": {"on": True, "bri": 200},
            "info": {"name": "Updated-Name"}
        }).encode("utf-8")
        mock_readback_resp.__enter__.return_value = mock_readback_resp

        with patch("urllib.request.urlopen", side_effect=[mock_cfg_resp, mock_existing_seg_resp, mock_state_resp, mock_state_resp, mock_readback_resp]) as mock_open, \
             patch("core.wled_driver.time.sleep"):
            result = WLEDDriver.apply_wled_mutations(
                ip="192.168.1.100",
                name="Updated-Name",
                hw_ins=[{"pin": [33], "type": 22, "start": 0, "len": 45, "order": 0}],
                state_payload={"bri": 200, "seg": [{"n": "Ring's Part"}]}
            )
            self.assertEqual(result["state"]["bri"], 200)
            self.assertEqual(result["info"]["name"], "Updated-Name")
            # Verify the first call to urlopen sent the cfg payload containing order: 0
            cfg_call_args = mock_open.call_args_list[0]
            req_sent = cfg_call_args[0][0]
            sent_cfg = json.loads(req_sent.data.decode("utf-8"))
            self.assertEqual(sent_cfg["hw"]["led"]["ins"][0]["order"], 0)
            # New outputs: the state is sent again after the bus rebuild, without saving the preset twice
            first_state = json.loads(mock_open.call_args_list[2][0][0].data.decode())
            resend = json.loads(mock_open.call_args_list[3][0][0].data.decode())
            self.assertEqual(first_state["psave"], 1)
            self.assertNotIn("psave", resend)
            self.assertEqual(resend["seg"], first_state["seg"])

    def test_apply_setup_preview_is_not_saved(self):
        def resp(body=b"{}"):
            r = MagicMock()
            r.read.return_value = body
            r.__enter__.return_value = r
            return r

        hw = [{"pin": [16], "type": 22, "start": 0, "len": 45, "order": 0},
              {"pin": [26], "type": 41, "start": 45, "len": 1, "order": 0}]
        state = {"on": True, "seg": [{"id": 0, "n": "LED Ring", "start": 0, "stop": 45}]}
        with patch("urllib.request.urlopen", side_effect=[resp(), resp(b'{"seg": [{}, {}, {}]}'), resp(), resp()]) as mock_open, \
             patch("core.wled_driver.time.sleep"):
            WLEDDriver.apply_setup_preview("192.168.1.100", hw, state)

        sent_cfg = json.loads(mock_open.call_args_list[0][0][0].data.decode())
        self.assertEqual(set(sent_cfg), {"hw"})  # boot preset and live settings stay untouched
        self.assertEqual(sent_cfg["hw"]["led"]["ins"][1]["rgbwm"], 4)
        sent_state = json.loads(mock_open.call_args_list[2][0][0].data.decode())
        # New outputs: the state goes out again after WLED's bus rebuild
        self.assertEqual(mock_open.call_args_list[3][0][0].data, mock_open.call_args_list[2][0][0].data)
        self.assertNotIn("psave", sent_state)
        # Segments 1 and 2 from the old layout are removed
        self.assertIn({"id": 1, "stop": 0}, sent_state["seg"])
        self.assertIn({"id": 2, "stop": 0}, sent_state["seg"])

    def test_apply_setup_preview_without_outputs_only_sets_state(self):
        r = MagicMock()
        r.read.return_value = b"{}"
        r.__enter__.return_value = r
        with patch("urllib.request.urlopen", return_value=r) as mock_open:
            WLEDDriver.apply_setup_preview("192.168.1.100", None, {"on": False})
        self.assertEqual(mock_open.call_count, 1)
        self.assertTrue(mock_open.call_args[0][0].full_url.endswith("/json/state"))

    def test_drgb_packet_creation(self):
        driver = WLEDDriver(DeviceConfig())
        rgb_data = bytes([255, 0, 0, 0, 255, 0])
        packet = driver._create_drgb_packet(rgb_data, timeout_sec=2)
        
        self.assertEqual(len(packet), 2 + len(rgb_data))
        self.assertEqual(packet[0], 0x02)  # DRGB ID
        self.assertEqual(packet[1], 2)     # Timeout byte
        self.assertEqual(packet[2:], rgb_data)

    def test_render_chase_frame(self):
        driver = WLEDDriver(DeviceConfig(rgb_count=10))
        effect = EffectConfig(
            animation=AnimationType.CHASE,
            color_primary=RGBColor(0, 255, 0),
            speed=1.0
        )
        pixels = driver._render_frame(effect, frame=0, elapsed=0.0, count=10)
        self.assertEqual(len(pixels), 30)  # 10 LEDs * 3 bytes
        self.assertEqual(pixels[1], 255)   # Green component

    def test_render_rainbow_frame(self):
        driver = WLEDDriver(DeviceConfig(rgb_count=10))
        effect = EffectConfig(animation=AnimationType.RAINBOW)
        pixels = driver._render_frame(effect, frame=0, elapsed=0.0, count=10)
        self.assertEqual(len(pixels), 30)

    async def test_driver_playback_and_cancel(self):
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=10, pwm_index=10)
        driver = WLEDDriver(dev)
        driver._protocol_mode = ProtocolMode.ACTIVE_UDP
        
        mock_sock = MagicMock()
        driver._sock = mock_sock
        
        effect = EffectConfig(
            animation=AnimationType.CHASE,
            duration=1.0,
            fps=50
        )
        
        # Start effect
        await driver.play_effect(effect)
        self.assertIsNotNone(driver._master_broadcast_task)
        self.assertFalse(driver._master_broadcast_task.done())
        
        await asyncio.sleep(0.05)
        self.assertTrue(mock_sock.sendto.called)
        
        # Clean stop
        await driver.stop_effect()
        self.assertIsNone(driver._master_broadcast_task)
        driver.close()

    async def test_is_playing_effects(self):
        driver = WLEDDriver(DeviceConfig(ip="127.0.0.1", rgb_count=10))
        driver._sock = MagicMock()
        self.assertFalse(driver.is_playing_effects)

        driver._protocol_mode = ProtocolMode.ACTIVE_UDP
        await driver.play_effect(EffectConfig(animation=AnimationType.CHASE, duration=0.2))
        self.assertTrue(driver.is_playing_effects)

        await asyncio.sleep(0.3)  # the transient expires with no baseline behind it
        self.assertFalse(driver.is_playing_effects)

        await driver.play_effect(EffectConfig(animation=AnimationType.SOLID, duration=0.0))
        self.assertTrue(driver.is_playing_effects)
        await driver.stop_effect()
        self.assertFalse(driver.is_playing_effects)
        driver.close()

    async def test_pwm_spotlight_preserved_during_rgb_effect(self):
        """Verify that playing an RGB effect on WS281x strip preserves PWM spotlight brightness."""
        dev = DeviceConfig(
            ip="192.168.2.215",
            rgb_count=45,
            pwm_index=45,
            pwm_seg_id=1,
            default_pwm_brightness=200
        )
        driver = WLEDDriver(dev)
        driver._protocol_mode = ProtocolMode.ACTIVE_UDP

        sent_packets = []
        mock_sock = MagicMock()
        mock_sock.sendto.side_effect = lambda data, addr: sent_packets.append((data, addr))
        driver._sock = mock_sock

        effect = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 174, 0),  # Takeout orange
            duration=0.0
        )

        # Play on Segment 0 (RGB strip 0..45)
        await driver.play_effect(effect, segment_id=0)
        await asyncio.sleep(0.05)

        self.assertTrue(len(sent_packets) > 0)
        packet_bytes, (dest_ip, dest_port) = sent_packets[0]
        self.assertEqual(dest_ip, "192.168.2.215")

        # DRGB header = 2 bytes
        # First LED (RGB strip index 0)
        self.assertEqual(packet_bytes[2], 255)
        self.assertEqual(packet_bytes[3], 174)
        self.assertEqual(packet_bytes[4], 0)

        # Last RGB LED (RGB strip index 44 -> byte offset 2 + 44*3 = 134)
        self.assertEqual(packet_bytes[134], 255)
        self.assertEqual(packet_bytes[135], 174)
        self.assertEqual(packet_bytes[136], 0)

        # PWM LED (index 45 -> byte offset 2 + 45*3 = 137) MUST be default PWM brightness (200, 200, 200)
        self.assertEqual(packet_bytes[137], 200)
        self.assertEqual(packet_bytes[138], 200)
        self.assertEqual(packet_bytes[139], 200)

        await driver.stop_effect()
        driver.close()

    async def test_multi_output_ws281x_bounds_and_pwm_isolation(self):
        """Verify that multi-output WS281x setups (e.g. 45 + 45 LEDs) calculate total LEDs and bounds accurately."""
        dev = DeviceConfig(
            ip="192.168.2.215",
            rgb_count=45,
            pwm_index=None,
            hw_ins=[
                {"pin": [16], "type": 22, "start": 0, "len": 45},
                {"pin": [17], "type": 22, "start": 45, "len": 45}
            ],
            segments=[
                SegmentConfig(id=0, name="Strip 1", start=0, length=45, type="WS281x"),
                SegmentConfig(id=1, name="Strip 2", start=45, length=45, type="WS281x")
            ]
        )
        driver = WLEDDriver(dev)
        self.assertEqual(driver._get_total_led_count(), 90)
        self.assertIsNone(driver._get_pwm_seg_id())
        self.assertEqual(driver._get_segment_bounds(0), (0, 45))
        self.assertEqual(driver._get_segment_bounds(1), (45, 90))

    async def test_frame_tap_callback(self):
        """Verify that registered frame tap callback receives real-time frame buffers."""
        dev = DeviceConfig(ip="127.0.0.1", rgb_count=5, pwm_index=None)
        driver = WLEDDriver(dev)
        driver._protocol_mode = ProtocolMode.ACTIVE_UDP

        tapped_frames = []
        driver.set_frame_tap_callback(lambda buf: tapped_frames.append(buf))

        eff = EffectConfig(
            animation=AnimationType.SOLID,
            color_primary=RGBColor(255, 0, 128),
            duration=0.5,
            enabled=True
        )

        with patch("socket.socket.sendto"):
            await driver.play_effect(eff, segment_id=0, force_enable=True)
            await asyncio.sleep(0.06)
            await driver.stop_effect()

        self.assertGreaterEqual(len(tapped_frames), 1)
        self.assertEqual(tapped_frames[0][0], 255)
        self.assertEqual(tapped_frames[0][1], 0)
        self.assertEqual(tapped_frames[0][2], 128)
        driver.close()

    def test_parse_wled_effect_metadata(self):
        # 1. Solid (1 color, no sliders, no palette)
        meta_solid = WLEDDriver.parse_wled_effect_metadata(0, "Solid", "")
        self.assertEqual(meta_solid["colors"], 1)
        self.assertEqual(meta_solid["colorSlots"][0]["label"], "Primary")
        self.assertFalse(meta_solid["speed"])
        self.assertFalse(meta_solid["intensity"])
        self.assertFalse(meta_solid["palette"])

        # 2. Blink (2 colors, speed, duty cycle intensity, palette)
        meta_blink = WLEDDriver.parse_wled_effect_metadata(1, "Blink", "!,Duty cycle;!,!;!;01")
        self.assertEqual(meta_blink["colors"], 2)
        self.assertEqual(meta_blink["colorSlots"][0]["label"], "Primary")
        self.assertEqual(meta_blink["colorSlots"][1]["label"], "Secondary")
        self.assertTrue(meta_blink["speed"])
        self.assertEqual(meta_blink["intensityLabel"], "Duty cycle")

        # 3. Breathe (2 colors, speed only, no intensity)
        meta_breathe = WLEDDriver.parse_wled_effect_metadata(2, "Breathe", "!;!,!;!;01")
        self.assertEqual(meta_breathe["colors"], 2)
        self.assertTrue(meta_breathe["speed"])
        self.assertFalse(meta_breathe["intensity"])

        # 4. Rainbow (0 colors, uses palette, size intensity)
        meta_rainbow = WLEDDriver.parse_wled_effect_metadata(9, "Rainbow", "!,Size;;!")
        self.assertEqual(meta_rainbow["colors"], 0)
        self.assertEqual(len(meta_rainbow["colorSlots"]), 0)
        self.assertTrue(meta_rainbow["speed"])
        self.assertEqual(meta_rainbow["intensityLabel"], "Size")
        self.assertTrue(meta_rainbow["palette"])

        # 5. Scan (3 colors: Primary, Secondary, Tertiary)
        meta_scan = WLEDDriver.parse_wled_effect_metadata(10, "Scan", "!,# of dots,,,,,Overlay;!,!,!;!")
        self.assertEqual(meta_scan["colors"], 3)
        self.assertEqual(len(meta_scan["colorSlots"]), 3)
        self.assertEqual(meta_scan["colorSlots"][2]["label"], "Tertiary")

        # 6. Sparkle Dark (custom color labels: Bg, Fx)
        meta_sparkle = WLEDDriver.parse_wled_effect_metadata(21, "Sparkle Dark", "!,!,,,,,Overlay;Bg,Fx;!;;m12=0")
        self.assertEqual(meta_sparkle["colors"], 2)
        self.assertEqual(meta_sparkle["colorSlots"][0]["label"], "Bg")
        self.assertEqual(meta_sparkle["colorSlots"][1]["label"], "Fx")

    def test_get_wled_effects_list_bundled_catalog(self):
        # When offline or IP is None, bundled 187-effect catalog should be returned
        effects = WLEDDriver.get_wled_effects_list(None)
        self.assertEqual(len(effects), 187)
        self.assertEqual(effects[0]["name"], "Solid")
        self.assertEqual(effects[0]["colors"], 1)
        self.assertEqual(effects[1]["name"], "Blink")
        self.assertEqual(effects[1]["colors"], 2)
        self.assertEqual(effects[9]["name"], "Rainbow")
        self.assertEqual(effects[9]["colors"], 0)
        self.assertEqual(effects[10]["name"], "Scan")
    def test_save_wled_preset_includes_sb_and_ib(self):
        mock_state_resp = MagicMock()
        mock_state_resp.read.return_value = b"{}"
        mock_state_resp.__enter__.return_value = mock_state_resp

        mock_cfg_resp = MagicMock()
        mock_cfg_resp.read.return_value = b"{}"
        mock_cfg_resp.__enter__.return_value = mock_cfg_resp

        mock_presets_resp = MagicMock()
        mock_presets_resp.read.return_value = json.dumps({
            "1": {
                "seg": [
                    {"id": 0, "start": 0, "stop": 45},
                    {"id": 1, "start": 45, "stop": 46}
                ]
            }
        }).encode("utf-8")
        mock_presets_resp.__enter__.return_value = mock_presets_resp

        segments = [
            {"id": 0, "start": 0, "stop": 45, "n": "WS281x"},
            {"id": 1, "start": 45, "stop": 46, "n": "PWM White"}
        ]

        with patch("urllib.request.urlopen", side_effect=[mock_state_resp, mock_cfg_resp, mock_presets_resp]) as mock_open:
            result = WLEDDriver.save_wled_preset(
                ip="192.168.1.50",
                preset_id=1,
                name="AutoGlow Default",
                segments=segments,
                bri=255,
                boot_default=True
            )
            self.assertTrue(result)
            self.assertEqual(mock_open.call_count, 3)

            # Check state payload
            state_req = mock_open.call_args_list[0][0][0]
            self.assertEqual(state_req.full_url, "http://192.168.1.50/json/state")
            state_body = json.loads(state_req.data.decode("utf-8"))
            self.assertEqual(state_body["psave"], 1)
            self.assertTrue(state_body.get("ib"), "Preset must include ib: True for brightness preservation")
            self.assertTrue(state_body.get("sb"), "Preset must include sb: True for segment bounds preservation")
            self.assertEqual(len(state_body["seg"]), 2)
            self.assertEqual(state_body["seg"][0]["stop"], 45)
            self.assertEqual(state_body["seg"][1]["start"], 45)
            self.assertEqual(state_body["seg"][1]["stop"], 46)

            # Check cfg payload
            cfg_req = mock_open.call_args_list[1][0][0]
            self.assertEqual(cfg_req.full_url, "http://192.168.1.50/json/cfg")
            cfg_body = json.loads(cfg_req.data.decode("utf-8"))
            self.assertEqual(cfg_body["def"]["ps"], 1)

            # Check presets readback verification payload
            presets_req = mock_open.call_args_list[2][0][0]
            self.assertEqual(presets_req.full_url, "http://192.168.1.50/presets.json")

    async def test_transition_to_udp_mode_no_http_call_and_pwm_retention(self):
        dev = DeviceConfig(
            ip="192.168.2.215",
            rgb_count=45,
            pwm_index=45,
            pwm_seg_id=1,
            default_pwm_brightness=200
        )
        driver = WLEDDriver(dev)
        self.assertEqual(driver.protocol_mode, ProtocolMode.IDLE_HTTP)

        with patch("urllib.request.urlopen") as mock_http:
            res = await driver.transition_to_udp_mode(spotlight_brightness=230)
            self.assertTrue(res)
            self.assertEqual(driver.protocol_mode, ProtocolMode.ACTIVE_UDP)
            self.assertEqual(driver._current_pwm_brightness, 230)
            mock_http.assert_not_called()

    async def test_set_board_light_udp_vs_http_mode(self):
        dev = DeviceConfig(
            ip="192.168.2.215",
            rgb_count=45,
            pwm_index=45,
            pwm_seg_id=1,
            default_pwm_brightness=200
        )
        driver = WLEDDriver(dev)

        # In ACTIVE_UDP mode: updates memory only, no HTTP request
        driver._protocol_mode = ProtocolMode.ACTIVE_UDP
        with patch("urllib.request.urlopen") as mock_http:
            res = await driver.set_board_light(150)
            self.assertTrue(res)
            self.assertEqual(driver._current_pwm_brightness, 150)
            mock_http.assert_not_called()

        # In IDLE_HTTP mode: sends HTTP request
        driver._protocol_mode = ProtocolMode.IDLE_HTTP
        with patch("core.wled_driver.is_host_online", return_value=True), \
             patch("urllib.request.urlopen") as mock_http:
            mock_resp = MagicMock()
            mock_resp.read.return_value = b"{}"
            mock_resp.__enter__.return_value = mock_resp
            mock_http.return_value = mock_resp

            res = await driver.set_board_light(180)
            self.assertTrue(res)
            self.assertEqual(driver._current_pwm_brightness, 180)
            mock_http.assert_called_once()


if __name__ == "__main__":
    unittest.main()


