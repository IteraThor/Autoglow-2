"""
AutoGlow 2 - Virtual WLED Server & Local UDP Receiver
Listens for DRGB (0x02) UDP packets on localhost (default 21324) and provides
high-frequency frame streaming to browser simulators with 0-latency.
"""

import asyncio
import logging
import time
from typing import Optional, Callable, Set, Dict, Any

logger = logging.getLogger("autoglow.simulator")


class VirtualWLEDDatagramProtocol(asyncio.DatagramProtocol):
    """Asyncio UDP protocol for decoding raw WLED DRGB packets."""

    def __init__(self, on_packet_callback: Callable[[bytes, int, tuple], None]):
        self.on_packet_callback = on_packet_callback
        self.transport: Optional[asyncio.DatagramTransport] = None

    def connection_made(self, transport: asyncio.BaseTransport):
        self.transport = transport  # type: ignore

    def datagram_received(self, data: bytes, addr: tuple):
        if not data or len(data) < 2:
            return
        # Byte 0 must be 0x02 (DRGB protocol)
        if data[0] == 0x02:
            timeout_sec = data[1]
            pixel_bytes = data[2:]
            self.on_packet_callback(pixel_bytes, timeout_sec, addr)


class VirtualWLEDServer:
    """
    Virtual WLED controller endpoint that runs on localhost.
    Receives authentic DRGB UDP packets, calculates packet metrics and frame rates,
    and broadcasts frames to connected browser clients or in-memory subscribers.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 21324):
        self.host = host
        self.port = port
        self.actual_port = port
        self.is_running = False
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._protocol: Optional[VirtualWLEDDatagramProtocol] = None

        # Pixel state (WS281x addressable LED strip)
        self.latest_pixels: bytearray = bytearray(45 * 3)  # Default: 45 WS281x LEDs
        self.ws_led_count: int = 45
        self.pwm_index: Optional[int] = 45
        self.led_rotation: int = 0  # Rotation in degrees (0..360) for LED 0 / cable entry
        self.led0_offset: int = 0   # Physical sector offset (0..ws_led_count-1)
        self.last_packet_time: float = 0.0
        self.timeout_sec: int = 2

        # In-memory subscribers: cb(pixels: bytes, status: dict)
        self._subscribers: Set[Callable[[bytes, Dict[str, Any]], None]] = set()

    def set_led_rotation(self, degrees: int) -> None:
        """Set the physical LED 0 rotation in degrees (0..360)."""
        try:
            self.led_rotation = int(degrees) % 360
        except (ValueError, TypeError):
            self.led_rotation = 0
        count = self.ws_led_count if (self.ws_led_count and self.ws_led_count > 0) else 45
        self.led0_offset = int(round((self.led_rotation / 360.0) * count)) % count

    def set_led0_offset(self, offset: int) -> None:
        """Set the physical LED 0 sector offset on the circular ring."""
        count = self.ws_led_count if (self.ws_led_count and self.ws_led_count > 0) else 45
        try:
            self.led0_offset = int(offset) % count
            self.led_rotation = int(round((self.led0_offset / float(count)) * 360.0)) % 360
        except (ValueError, TypeError):
            self.led0_offset = 0
            self.led_rotation = 0

    def subscribe(self, callback: Callable[[bytes, Dict[str, Any]], None]) -> None:
        """Register a frame consumer."""
        self._subscribers.add(callback)

    def unsubscribe(self, callback: Callable[[bytes, Dict[str, Any]], None]) -> None:
        """Remove a frame consumer."""
        self._subscribers.discard(callback)

    async def start(self) -> bool:
        """Start the async UDP receiver on host:port, falling back if busy."""
        if self.is_running:
            return True

        loop = asyncio.get_running_loop()
        ports_to_try = [self.port, self.port + 1, self.port + 2, 21325, 21326]

        for p in ports_to_try:
            try:
                transport, protocol = await loop.create_datagram_endpoint(
                    lambda: VirtualWLEDDatagramProtocol(self._on_udp_packet),
                    local_addr=(self.host, p)
                )
                self._transport = transport
                self._protocol = protocol
                self.actual_port = p
                self.is_running = True
                logger.info(f"Virtual WLED UDP Receiver listening on {self.host}:{self.actual_port}")
                return True
            except OSError as e:
                logger.debug(f"Could not bind UDP simulator to {self.host}:{p} ({e}), trying next...")
                continue
            except Exception as e:
                logger.warning(f"Error starting Virtual WLED UDP Receiver on {self.host}:{p}: {e}")
                break

        # If UDP socket binding failed (e.g. restricted sandbox), allow in-memory tap mode
        logger.warning(f"UDP port binding unavailable on {self.host}. Running simulator in direct-tap mode.")
        self.is_running = True
        return True

    async def stop(self) -> None:
        """Stop the UDP receiver and clean up transports."""
        if self._transport:
            try:
                self._transport.close()
            except Exception:
                pass
            self._transport = None
            self._protocol = None
        self.is_running = False
        logger.info("Virtual WLED UDP Receiver stopped.")

    def _on_udp_packet(self, pixel_bytes: bytes, timeout_sec: int, addr: tuple) -> None:
        """Invoked on every incoming DRGB datagram."""
        self.tap_frame(pixel_bytes, timeout_sec)

    def tap_frame(self, pixel_bytes: bytes, timeout_sec: int = 2) -> None:
        """In-memory tap for direct frame feeding from WLEDDriver or UDP packet."""
        now = time.time()
        self.latest_pixels = bytearray(pixel_bytes)
        self.timeout_sec = timeout_sec
        self.last_packet_time = now

        status = self.get_status()
        # Dispatch to subscribers
        for sub in list(self._subscribers):
            try:
                sub(bytes(self.latest_pixels), status)
            except Exception as ex:
                logger.debug(f"Error in simulator frame subscriber: {ex}")

    def get_status(self) -> Dict[str, Any]:
        """Return the simulator's current state for the status route and preview."""
        total_leds = len(self.latest_pixels) // 3
        ws_count = self.ws_led_count if (self.ws_led_count and self.ws_led_count > 0) else 45
        num_ws_leds = min(total_leds, ws_count) if total_leds > 0 else ws_count
        now = time.time()
        age_ms = round((now - self.last_packet_time) * 1000.0, 1) if self.last_packet_time > 0 else None

        # PWM brightness (index 45 by default)
        pwm_val = 0
        pwm_idx = self.pwm_index if self.pwm_index is not None else ws_count
        if pwm_idx is not None and pwm_idx < total_leds:
            pwm_val = self.latest_pixels[pwm_idx * 3]

        return {
            "listening": self.is_running,
            "host": self.host,
            "port": self.actual_port,
            "led_count": num_ws_leds,
            "led_rotation": self.led_rotation,
            "led0_offset": self.led0_offset,
            "pwm_value": pwm_val,
            "last_packet_age_ms": age_ms,
            "timeout_sec": self.timeout_sec
        }

    # -------------------------------------------------------------------------
    # WLED Mock API Emulation
    # -------------------------------------------------------------------------
    def get_mock_state(self) -> Dict[str, Any]:
        """Generate a valid /json/state payload representing the virtual simulator controller."""
        return {
            "on": True,
            "bri": 255,
            "transition": 7,
            "ps": 1,
            "lor": 0,
            "seg": [
                {
                    "id": 0,
                    "start": 0,
                    "stop": 45,
                    "len": 45,
                    "on": True,
                    "bri": 255,
                    "col": [[0, 255, 128], [0, 0, 0], [0, 0, 0]],
                    "fx": 0,
                    "sx": 128,
                    "ix": 128,
                    "n": "WS281x Ring"
                }
            ]
        }

    def get_mock_info(self) -> Dict[str, Any]:
        """Generate a valid /json/info payload for device discovery/ping."""
        return {
            "ver": "0.15.0-virtual",
            "vid": 2405010,
            "name": "AutoGlow LED Simulator",
            "udpport": self.actual_port,
            "live": False,
            "fxcount": 180,
            "palcount": 71,
            "arch": "Virtual",
            "core": "AutoGlow Python",
            "freeheap": 250000,
            "uptime": int(time.time()),
            "brand": "AutoGlow",
            "product": "Simulator",
            "mac": "02:00:00:00:00:01",
            "ip": self.host,
            "leds": {
                "count": 45,
                "rgbw": False,
                "wv": False,
                "cct": False,
                "pwr": 0,
                "maxpwr": 0,
                "maxseg": 16,
                "ins": [
                    {"start": 0, "len": 45, "pin": [33], "type": 22, "order": 0}
                ]
            }
        }

    def get_mock_cfg(self) -> Dict[str, Any]:
        """Generate a valid /json/cfg payload."""
        return {
            "id": {"name": "AutoGlow LED Simulator"},
            "hw": {
                "led": {
                    "total": 45,
                    "ins": [
                        {"start": 0, "len": 45, "pin": [33], "type": 22, "order": 0}
                    ]
                }
            },
            "if": {"live": {"mso": False}}
        }


# Global singleton instance
_simulator_server: Optional[VirtualWLEDServer] = None


def get_simulator_server() -> VirtualWLEDServer:
    global _simulator_server
    if _simulator_server is None:
        _simulator_server = VirtualWLEDServer()
    return _simulator_server
