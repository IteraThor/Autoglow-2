"""
Unit tests for fast hybrid device discovery.
"""

import unittest
from unittest.mock import patch

from core.discovery import DiscoveryService, _get_primary_subnets


class TestDiscoveryService(unittest.IsolatedAsyncioTestCase):

    def test_get_primary_subnets(self):
        subnets = _get_primary_subnets()
        self.assertIsInstance(subnets, list)
        self.assertTrue(len(subnets) > 0)
        for s in subnets:
            self.assertEqual(len(s.split('.')), 3)

    @patch("core.discovery._async_scan_mdns")
    @patch("core.discovery._async_scan_subnets_fast")
    async def test_scan_network_merges_and_deduplicates(self, mock_subnets, mock_mdns):
        mock_mdns.return_value = [
            {"ip": "192.168.2.100", "name": "WLED-Dartboard", "brand": "WLED"}
        ]
        mock_subnets.return_value = [
            {"ip": "192.168.2.100", "name": "WLED-Dartboard", "version": "0.14.0", "leds": 60, "brand": "WLED"},
            {"ip": "192.168.2.105", "name": "WLED-Surround", "version": "0.14.1", "leds": 30, "brand": "WLED"}
        ]

        devices = await DiscoveryService.scan_network()
        self.assertEqual(len(devices), 2)
        ips = [d["ip"] for d in devices]
        self.assertIn("192.168.2.100", ips)
        self.assertIn("192.168.2.105", ips)

    async def test_probe_invalid_ip(self):
        # Should cleanly return None in milliseconds without throwing
        res = await DiscoveryService.probe_ip("192.0.2.1")
        self.assertIsNone(res)


if __name__ == "__main__":
    unittest.main()
