"""
AutoGlow 2 - Fast Hybrid Device Discovery Service
Combines instant mDNS (Zeroconf) multicast with concurrent non-blocking async TCP subnet probing.
"""

import asyncio
import logging
import socket
from typing import List, Dict, Any, Optional

import aiohttp

try:
    from zeroconf import Zeroconf, ServiceBrowser, ServiceListener
except ImportError:
    Zeroconf = None
    ServiceBrowser = None
    ServiceListener = None

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    serial = None

logger = logging.getLogger("autoglow.discovery")

KNOWN_VID_PIDS = [
    (0x10C4, 0xEA60),  # CP210x
    (0x1A86, 0x7523),  # CH340
    (0x0403, 0x6001),  # FTDI
    (0x303A, 0x1001),  # Espressif USB JTAG/serial
    (0x303A, 0x0002),  # ESP32-S2 USB CDC
]


def _get_available_ports() -> List[Dict[str, Any]]:
    """Detect available COM/TTY ports and flag ESP32 devices."""
    if not serial:
        return []
    results = []
    try:
        ports = serial.tools.list_ports.comports()
        for port in ports:
            is_esp32 = (port.vid, port.pid) in KNOWN_VID_PIDS
            results.append({
                "device": port.device,
                "description": port.description or "Unknown",
                "is_esp32": is_esp32
            })
    except Exception:
        logger.exception("Error listing serial ports")
    return results


def _get_primary_subnets() -> List[str]:
    """Detect primary LAN subnets, filtering out virtual/docker networks."""
    subnets = []
    # 1. Probe default gateway interface
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        if local_ip and not local_ip.startswith("127."):
            parts = local_ip.split('.')
            if len(parts) == 4:
                subnets.append('.'.join(parts[:3]))
    except Exception:
        pass

    # 2. Probe remaining physical adapters
    try:
        hostname = socket.gethostname()
        local_ips = socket.gethostbyname_ex(hostname)[2]
        for ip in local_ips:
            # Filter localhost and common Docker/WSL bridge ranges (172.17-31.x.x)
            if not ip.startswith("127.") and not (ip.startswith("172.") and 16 <= int(ip.split('.')[1]) <= 31):
                parts = ip.split('.')
                if len(parts) == 4:
                    sub = '.'.join(parts[:3])
                    if sub not in subnets:
                        subnets.append(sub)
    except Exception:
        pass

    if not subnets:
        subnets = ["192.168.1", "192.168.2", "192.168.0", "192.168.178"]

    return subnets[:2]


if ServiceListener:
    class WLEDMdnsListener(ServiceListener):
        def __init__(self, zc):
            self.zc = zc
            self.discovered = []

        def add_service(self, zc, type_, name):
            try:
                info = zc.get_service_info(type_, name)
                if info and info.addresses:
                    ip = socket.inet_ntoa(info.addresses[0])
                    clean_name = name.split('.')[0].replace('\\', '')
                    self.discovered.append({
                        "ip": ip,
                        "name": clean_name or "WLED Device",
                        "port": info.port or 80,
                        "brand": "WLED"
                    })
            except Exception:
                pass

        def update_service(self, zc, type_, name):
            pass

        def remove_service(self, zc, type_, name):
            pass


async def _async_scan_mdns(timeout: float = 1.0) -> List[Dict[str, Any]]:
    """Instant mDNS Zeroconf scan for WLED services."""
    if not Zeroconf:
        return []

    def _sync_mdns():
        zc = None
        try:
            zc = Zeroconf()
            listener = WLEDMdnsListener(zc)
            _browser = ServiceBrowser(zc, ["_wled._tcp.local.", "_http._tcp.local."], listener)
            import time
            time.sleep(timeout)
            return listener.discovered
        except Exception as e:
            logger.warning(f"mDNS scan error: {e}")
            return []
        finally:
            if zc:
                try:
                    zc.close()
                except Exception:
                    pass

    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, _sync_mdns)
    except Exception:
        return []


async def _async_probe_ip(ip: str, session: aiohttp.ClientSession) -> Optional[Dict[str, Any]]:
    """Fast two-stage probe: non-blocking TCP SYN check + aiohttp /json/info."""
    try:
        # Stage 1: Ultra-fast TCP port 80 check (300ms timeout)
        _, writer = await asyncio.wait_for(asyncio.open_connection(ip, 80), timeout=0.35)
        writer.close()
        await writer.wait_closed()
    except Exception:
        return None

    # Stage 2: Verified port 80 open -> Query WLED JSON API
    try:
        async with session.get(f"http://{ip}/json/info", timeout=aiohttp.ClientTimeout(total=0.8)) as resp:
            if resp.status == 200:
                data = await resp.json(content_type=None)
                if data.get('brand') == 'WLED' or 'leds' in data or 'ver' in data:
                    return {
                        "ip": ip,
                        "name": data.get("name", "WLED Device"),
                        "version": data.get("ver", "Unknown"),
                        "leds": data.get("leds", {}).get("count", 0),
                        "brand": data.get("brand", "WLED")
                    }
    except Exception:
        pass
    return None


async def _async_scan_subnets_fast() -> List[Dict[str, Any]]:
    """Scan top LAN subnets in parallel with async TCP SYN checks."""
    subnets = _get_primary_subnets()
    ips_to_scan = [f"{subnet}.{host}" for subnet in subnets for host in range(1, 255)]

    results = []
    connector = aiohttp.TCPConnector(limit=100, ttl_dns_cache=300)
    async with aiohttp.ClientSession(connector=connector) as session:
        # Run probes with semaphore to avoid socket exhaustion
        sem = asyncio.Semaphore(80)

        async def _bounded_probe(ip: str):
            async with sem:
                return await _async_probe_ip(ip, session)

        tasks = [_bounded_probe(ip) for ip in ips_to_scan]
        probed = await asyncio.gather(*tasks, return_exceptions=True)
        for p in probed:
            if isinstance(p, dict) and p.get("ip"):
                results.append(p)

    return results


class DiscoveryService:
    """Async wrapper for finding WLED devices on network and USB serial ports."""

    @staticmethod
    async def scan_network() -> List[Dict[str, Any]]:
        """Hybrid fast network discovery: mDNS + async subnet sweep in parallel."""
        try:
            mdns_task = asyncio.create_task(_async_scan_mdns(timeout=1.0))
            subnet_task = asyncio.create_task(_async_scan_subnets_fast())

            mdns_results, subnet_results = await asyncio.gather(
                mdns_task, subnet_task, return_exceptions=True
            )

            discovered_by_ip: Dict[str, Dict[str, Any]] = {}

            # Populate subnet results
            if isinstance(subnet_results, list):
                for d in subnet_results:
                    if isinstance(d, dict) and "ip" in d:
                        discovered_by_ip[d["ip"]] = d

            # Merge mDNS results
            if isinstance(mdns_results, list):
                for d in mdns_results:
                    if isinstance(d, dict) and "ip" in d:
                        ip = d["ip"]
                        if ip not in discovered_by_ip:
                            discovered_by_ip[ip] = d
                        else:
                            # Enhance with mDNS details
                            if d.get("name") and not discovered_by_ip[ip].get("name"):
                                discovered_by_ip[ip]["name"] = d["name"]

            return list(discovered_by_ip.values())
        except Exception:
            logger.exception("Fast network discovery failed")
            return []

    @staticmethod
    async def scan_serial() -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, _get_available_ports)
        except Exception:
            logger.exception("Serial port scan failed")
            return []

    @staticmethod
    async def probe_ip(ip: str) -> Optional[Dict[str, Any]]:
        try:
            async with aiohttp.ClientSession() as session:
                return await _async_probe_ip(ip, session)
        except Exception:
            return None
