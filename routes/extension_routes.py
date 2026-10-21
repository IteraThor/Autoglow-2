"""
AutoGlow 2 - Chrome Extension Distribution Routes
Serves the signed AutoGlow Bridge extension and its update manifest, so Chrome can install and
update it through the ExtensionInstallForcelist policy written by setup.sh (Linux).
Outside /api/ on purpose: Chrome's updater has no PIN session, and the extension holds no secrets.
"""

import asyncio
import logging
from aiohttp import web

from core.extension_packager import package

logger = logging.getLogger("autoglow.routes.extension")

UPDATE_XML_PATH = "/extension/update.xml"
CRX_PATH = "/extension/autoglow-bridge.crx"

_package_lock = asyncio.Lock()


async def _get_package(app: web.Application):
    async with _package_lock:
        if "extension_package" not in app:
            # Packed once per process; updates restart the server, which picks up a new version
            app["extension_package"] = await asyncio.to_thread(package)
            ext_id, version, _ = app["extension_package"]
            logger.info(f"Packed AutoGlow Bridge extension v{version} (id {ext_id})")
        return app["extension_package"]


async def handle_extension_update_xml(request: web.Request) -> web.Response:
    ext_id, version, _ = await _get_package(request.app)
    codebase = f"{request.scheme}://{request.host}{CRX_PATH}"
    xml = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        f"  <app appid='{ext_id}'>\n"
        f"    <updatecheck codebase='{codebase}' version='{version}' />\n"
        "  </app>\n"
        "</gupdate>\n"
    )
    return web.Response(text=xml, content_type="application/xml")


async def handle_extension_crx(request: web.Request) -> web.Response:
    _, _, crx = await _get_package(request.app)
    return web.Response(body=crx, content_type="application/x-chrome-extension")
