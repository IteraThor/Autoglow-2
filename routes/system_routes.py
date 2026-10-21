"""
AutoGlow 2 - System, Backup & Updater Routes Module
Handlers for snapshots, backups management, and GitHub auto-updates.
"""

import asyncio
import time
import logging
from pathlib import Path
from aiohttp import web
from typing import Optional

from core.backup_manager import BackupManager
from core.updater import UpdateManager
from core.version import __version__ as CURRENT_VERSION

logger = logging.getLogger("autoglow.routes.system")

RESTART_DELAY_SECONDS = 1.0


def _schedule_restart(app: web.Application) -> bool:
    """Ask the server to restart shortly, after the current response has been sent."""
    restart_event = app.get("restart_event")
    if restart_event is None:
        return False
    asyncio.get_running_loop().call_later(RESTART_DELAY_SECONDS, restart_event.set)
    logger.info(f"AutoGlow restart scheduled in {RESTART_DELAY_SECONDS:.0f}s")
    return True

PROJECT_ROOT = Path(__file__).resolve().parent.parent


async def handle_list_backups(request: web.Request) -> web.Response:
    loop = asyncio.get_running_loop()
    try:
        backups = await loop.run_in_executor(None, BackupManager.list_backups)
        return web.json_response({"status": "ok", "backups": backups})
    except Exception as e:
        logger.exception("Error listing backups")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_create_backup(request: web.Request) -> web.Response:
    loop = asyncio.get_running_loop()
    try:
        data = await request.json() if request.can_read_body else {}
    except Exception:
        data = {}
    note = data.get("note", "") if isinstance(data, dict) else ""
    try:
        res = await loop.run_in_executor(None, lambda: BackupManager.create_backup(note=note, version=f"v{CURRENT_VERSION}"))
        return web.json_response(res)
    except Exception as e:
        logger.exception("Error creating backup")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_restore_backup(request: web.Request) -> web.Response:
    data = await request.json()
    filename = data.get("filename", "")
    if not filename:
        return web.json_response({"status": "error", "message": "No filename specified"}, status=400)

    loop = asyncio.get_running_loop()
    try:
        res = await loop.run_in_executor(None, lambda: BackupManager.restore_backup(filename))
        # The running engine still holds the pre-restore config in memory; restart to load the snapshot
        if res.get("status") == "ok":
            res["restarting"] = _schedule_restart(request.app)
        return web.json_response(res)
    except Exception as e:
        logger.exception("Error restoring backup")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_delete_backup(request: web.Request) -> web.Response:
    data = await request.json()
    filename = data.get("filename", "")
    if not filename:
        return web.json_response({"status": "error", "message": "No filename specified"}, status=400)

    loop = asyncio.get_running_loop()
    try:
        ok = await loop.run_in_executor(None, lambda: BackupManager.delete_backup(filename))
        return web.json_response({"status": "ok" if ok else "error"})
    except Exception as e:
        logger.exception("Error deleting backup")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_download_backup(request: web.Request) -> web.Response:
    filename = request.query.get("file", "")
    if not filename:
        return web.Response(status=400, text="Missing file query parameter")

    path = BackupManager.get_backup_path(filename)
    if not path or not path.exists():
        return web.Response(status=404, text="Backup file not found")

    return web.FileResponse(path, headers={
        "Content-Disposition": f'attachment; filename="{path.name}"'
    })


async def handle_update_check(request: web.Request) -> web.Response:
    repo = request.query.get("repo", "")
    loop = asyncio.get_running_loop()
    try:
        if repo:
            res = await loop.run_in_executor(None, lambda: UpdateManager.check_for_updates(repo))
        else:
            res = await loop.run_in_executor(None, UpdateManager.check_for_updates)
        return web.json_response(res)
    except Exception as e:
        logger.exception("Error checking updates")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_update_apply(request: web.Request) -> web.Response:
    loop = asyncio.get_running_loop()
    try:
        res = await loop.run_in_executor(None, UpdateManager.apply_update)
        if res.get("status") == "ok":
            res["restarting"] = _schedule_restart(request.app)
        return web.json_response(res)
    except Exception as e:
        logger.exception("Error applying update")
        return web.json_response({"status": "error", "message": str(e)}, status=500)


async def handle_update_zip(request: web.Request) -> web.Response:
    """Handle upload and extraction of an update ZIP archive."""
    if not request.content_type.startswith("multipart/form-data"):
        return web.json_response({"status": "error", "message": "Expected multipart/form-data request"}, status=400)

    loop = asyncio.get_running_loop()
    auto_backup = True
    temp_zip_path: Optional[Path] = None

    try:
        reader = await request.multipart()
        field = await reader.next()
        while field is not None:
            if field.name == "auto_backup":
                val = await field.text()
                auto_backup = val.lower() in ("true", "1", "yes")
            elif field.name in ("file", "zip_file", "update_file"):
                upload_dir = PROJECT_ROOT / "scratch"
                upload_dir.mkdir(parents=True, exist_ok=True)
                temp_zip_path = upload_dir / f"upload_update_{int(time.time())}.zip"
                with open(temp_zip_path, "wb") as f:
                    while True:
                        chunk = await field.read_chunk()
                        if not chunk:
                            break
                        f.write(chunk)
            field = await reader.next()

        if not temp_zip_path or not temp_zip_path.exists():
            return web.json_response({"status": "error", "message": "No update ZIP file was uploaded"}, status=400)

        res = await loop.run_in_executor(
            None,
            lambda: UpdateManager.apply_zip_update(temp_zip_path, auto_backup=auto_backup)
        )
        if res.get("status") == "ok":
            res["restarting"] = _schedule_restart(request.app)
        return web.json_response(res)
    except Exception as e:
        logger.exception("Error applying ZIP update")
        if temp_zip_path and temp_zip_path.exists():
            try:
                temp_zip_path.unlink()
            except Exception:
                pass
        return web.json_response({"status": "error", "message": str(e)}, status=500)

