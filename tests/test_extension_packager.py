"""
Tests for the CRX3 packager and the extension auto-install routes.
"""

import os
import struct
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from core import extension_packager as xp
from routes import register_routes

def _read_varint(buf, i):
    value = shift = 0
    while True:
        byte = buf[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, i


def _pb_fields(buf):
    i, out = 0, []
    while i < len(buf):
        tag, i = _read_varint(buf, i)
        length, i = _read_varint(buf, i)
        out.append((tag >> 3, buf[i:i + length]))
        i += length
    return out


class TestPackager(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.key = xp.generate_key()

    def test_crx_is_signed_and_carries_the_extension_id(self):
        crx = xp.build_crx(self.key)
        self.assertEqual(crx[:4], b"Cr24")
        version, header_len = struct.unpack("<II", crx[4:12])
        self.assertEqual(version, 3)
        header, archive = crx[12:12 + header_len], crx[12 + header_len:]

        fields = _pb_fields(header)
        proof = dict(_pb_fields([v for k, v in fields if k == 2][0]))
        signed = [v for k, v in fields if k == 10000][0]
        self.assertEqual(proof[1], xp.public_key_der(self.key))
        self.assertEqual(dict(_pb_fields(signed))[1], xp._crx_id(self.key))

        payload = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed)) + signed + archive
        self.assertTrue(xp.rsa_verify(self.key, payload, proof[2]))
        self.assertTrue(archive.startswith(b"PK"))

    def test_extension_id_format_and_stability(self):
        ext_id = xp.extension_id(self.key)
        self.assertEqual(len(ext_id), 32)
        self.assertTrue(set(ext_id) <= set("abcdefghijklmnop"))
        self.assertEqual(ext_id, xp.extension_id(dict(self.key)))

    def test_key_is_created_once_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ext.key")
            with patch.object(xp, "generate_key", return_value=self.key) as gen:
                first = xp.load_or_create_key(path)
                second = xp.load_or_create_key(path)
            self.assertEqual(gen.call_count, 1)
            self.assertEqual(first, second)
            if os.name == "posix":
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)


class TestExtensionRoutes(AioHTTPTestCase):

    async def get_application(self):
        app = web.Application()
        register_routes(app, "web")
        app["extension_package"] = ("abcdefghijklmnopabcdefghijklmnop", "1.2.3", b"Cr24test")
        return app

    @unittest_run_loop
    async def test_update_manifest_points_at_served_crx(self):
        resp = await self.client.get("/extension/update.xml")
        self.assertEqual(resp.status, 200)
        text = await resp.text()
        self.assertIn("appid='abcdefghijklmnopabcdefghijklmnop'", text)
        self.assertIn("version='1.2.3'", text)
        self.assertIn("/extension/autoglow-bridge.crx'", text)

        resp = await self.client.get("/extension/autoglow-bridge.crx")
        self.assertEqual(resp.headers["Content-Type"], "application/x-chrome-extension")
        self.assertEqual(await resp.read(), b"Cr24test")


if __name__ == "__main__":
    unittest.main()
