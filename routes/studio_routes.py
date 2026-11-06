"""
AutoGlow 2 - Studio Routes Module
Handlers for /api/studio/*: overlay settings, cameras, players with pictures, and the live
scoreboard that web/studio/live.html polls.
"""

import asyncio
import logging
import socket
import time
from typing import Dict, Optional
from aiohttp import BodyPartReader, web

import aiohttp

from core import studio, studio_camera, studio_darts, studio_video
from core.autodarts_bridge import AutodartsBridgeClient, is_match_over
from core.errors import NotFound, ServiceUnavailable, ValidationError, read_json

logger = logging.getLogger("autoglow.routes.studio")


def _lan_ip() -> str:
    """This computer's address in the local network (no packet is sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))
            return s.getsockname()[0]
    except OSError:
        return ""


async def handle_get_studio(request: web.Request) -> web.Response:
    settings = await asyncio.to_thread(studio.load_settings)
    ip = _lan_ip()
    port = request.url.port or 80
    # The address TVs and other devices open; the page itself may have been opened via localhost
    output_url = f"http://{ip}:{port}/studio/live" if ip else ""
    # Cameras as H.264 from the graphics chip (else the outputs show the MJPEG streams)
    h264 = await asyncio.to_thread(studio_video.encoder_available)
    return web.json_response({"status": "ok", **settings, "output_url": output_url, "h264_cameras": h264, **_text_info()})


def _text_info() -> dict:
    """Defaults of the editable texts (the outputs fall back to them) and their groups for the Studio page."""
    return {
        "text_defaults": studio.TEXT_DEFAULTS,
        "text_groups": [{"name": name, "where": studio.TEXT_GROUP_WHERE.get(name, ""),
                         "toggle": studio.TEXT_GROUP_TOGGLES.get(name),
                         "items": [{"key": k, "label": label} for k, label, _ in items]}
                        for name, items in studio.TEXT_GROUPS],
    }


async def handle_post_studio(request: web.Request) -> web.Response:
    data = await read_json(request)
    settings = await asyncio.to_thread(studio.save_settings, data)
    return web.json_response({"status": "ok", **settings, **_text_info()})


async def handle_save_player(request: web.Request) -> web.Response:
    """Multipart form: name, the profile fields and optional picture files (image, mockup).
    With {id} it updates that player."""
    player_id = request.match_info.get("id")
    if not request.content_type.startswith("multipart/"):
        raise ValidationError("Expected a multipart form")
    fields = {"name": "", **{key: "" for key in studio.PROFILE_FIELDS}}
    pictures: Dict[str, Optional[bytes]] = {"image": None, "mockup": None}
    reader = await request.multipart()
    while True:
        part = await reader.next()
        if part is None:
            break
        if not isinstance(part, BodyPartReader):
            continue
        if part.name in pictures and part.filename:
            # In chunks, so a huge file is refused at the limit instead of being held in memory first
            data = bytearray()
            while chunk := await part.read_chunk(64 * 1024):
                data += chunk
                if len(data) > studio.MAX_IMAGE_BYTES:
                    raise ValidationError("Picture is larger than 5 MB")
            pictures[part.name] = bytes(data) if data else None
        elif part.name in fields:
            fields[part.name] = (await part.text())[:200]
    try:
        player = await asyncio.to_thread(
            studio.upsert_player, player_id, fields.pop("name"), fields, pictures["image"], pictures["mockup"]
        )
    except ValueError as e:
        raise ValidationError(str(e)) from None
    except KeyError:
        raise NotFound("Player not found") from None
    return web.json_response({"status": "ok", "player": player})


async def handle_delete_player(request: web.Request) -> web.Response:
    try:
        await asyncio.to_thread(studio.delete_player, request.match_info["id"])
    except KeyError:
        raise NotFound("Player not found") from None
    return web.json_response({"status": "ok"})


async def handle_player_image(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    path = studio.image_path(name)
    if not path:
        raise NotFound("Picture not found")
    return web.FileResponse(path, headers={
        "Content-Type": studio.image_mime(name),
        "Cache-Control": "public, max-age=86400",
    })


# A match state nobody updated for this long is not shown as live (tab closed without the match ending)
STALE_SNAPSHOT_SECONDS = 600


def _match_client(request: web.Request):
    engine = request.app.get("engine")
    return getattr(engine, "autodarts", None) if engine else None


def _source_info(client) -> dict:
    """Where the game data comes from, for the Studio page's status panel."""
    if not client:
        return {"connected": False}
    info = {
        "connected": bool(client.is_connected),
        "match_running": bool(getattr(client, "_active_match_id", None)),
        "updated_ago": round(time.time() - client.last_match_state_at, 1) if client.last_match_state_at else None,
    }
    if isinstance(client, AutodartsBridgeClient):
        info.update(client.snapshot())
    return info


# Scenes and layouts the Studio page can cue on every open output
CUES = {"idle", "intro", "live", "leg", "match", "180", "bust", "stinger", "bulloff",
        "layout:auto", "layout:split", "layout:board", "layout:player", "overlay:hide", "overlay:show"}


async def handle_studio_cue(request: web.Request) -> web.Response:
    """Play a scene on all outputs now, e.g. to try the animations without a game."""
    data = await read_json(request)
    scene = str(data.get("scene", ""))
    if scene not in CUES:
        raise ValidationError("Unknown scene")
    if scene.startswith("overlay:"):
        # Kept in the settings too, so outputs opened later (or reloaded) show the same
        await asyncio.to_thread(studio.save_settings, {"show_overlay": scene == "overlay:show"})
    previous = request.app.get("studio_cue") or {"id": 0}
    cue = {"id": previous["id"] + 1, "scene": scene, "at": time.time()}
    request.app["studio_cue"] = cue
    return web.json_response({"status": "ok", "cue": cue})


async def handle_studio_state(request: web.Request) -> web.Response:
    """Scoreboard of the running (or last finished) match. ?demo=1 returns sample data."""
    cue = request.app.get("studio_cue")
    if request.query.get("demo") == "1":
        return web.json_response({"status": "ok", **studio.demo_scoreboard(), "cue": cue})
    client = _match_client(request)
    state = getattr(client, "last_match_state", None) if client else None
    live = False
    if client and state:
        fresh = time.time() - client.last_match_state_at < STALE_SNAPSHOT_SECONDS
        # A snapshot resent by the extension counts as live until the match is over
        live = bool(getattr(client, "_active_match_id", None)) or (fresh and not is_match_over(state))
    phase = str(getattr(client, "_last_flow_state", "") or "") if client else ""
    board = studio.build_scoreboard(state, live, phase)
    # Which Studio player each Autodarts player is (name, Autodarts name, or prepared throwing order)
    settings = studio.cached_settings()
    for player, match in zip(board["players"], studio.map_players(board["players"], settings), strict=True):
        player.update(match)
    # Players picked in the Autodarts lobby the tab shows, before the match starts
    lobby = None if live else studio.build_lobby(getattr(client, "open_lobby", None))
    if lobby:
        for player, match in zip(lobby["players"], studio.map_players(lobby["players"], settings), strict=True):
            player.update(match)
    board["lobby"] = lobby
    # The bull-off before the first leg: its own scene on the outputs
    bull_off = studio.build_bull_off(getattr(client, "bull_off_view", None)) if client else None
    if bull_off:
        for player, match in zip(bull_off["players"], studio.map_players(bull_off["players"], settings), strict=True):
            player.update(match)
    board["bull_off"] = bull_off
    source = _source_info(client)
    board["source_connected"] = source["connected"]
    board["source"] = source
    board["cue"] = cue
    # Dart zoom: darts reported by the Board Manager, and this computer's clock to line them up with
    # the delayed camera picture (the page works out how far its own clock is off)
    watcher = request.app.get("studio_dart_watcher")
    board["darts"] = watcher.recent() if watcher and settings.get("dart_zoom", {}).get("enabled") else []
    board["server_time"] = round(time.time(), 3)
    return web.json_response({"status": "ok", **board})


async def handle_autodarts_state(request: web.Request) -> web.Response:
    """Whether the Autodarts Board Manager on this computer is running detection (and so its cameras)."""
    state = await studio_camera.board_manager_state()
    return web.json_response({"status": "ok", "reachable": state is not None, **(state or {})})


async def handle_autodarts_start(request: web.Request) -> web.Response:
    """Start Autodarts detection on this computer (the Start button of the Board Manager)."""
    state = await studio_camera.start_board_manager()
    if state is None:
        raise ServiceUnavailable("The Autodarts Board Manager is not reachable on this computer")
    if not state["running"]:
        raise ServiceUnavailable("Autodarts did not start – check the Board Manager")
    # Camera relays waiting for frames reconnect now instead of after their back-off
    _camera_hub(request.app).retry_relays()
    return web.json_response({"status": "ok", "reachable": True, **state})


async def handle_remember_name(request: web.Request) -> web.Response:
    """Save the Autodarts name of a match player as a Studio player's Autodarts name."""
    data = await read_json(request)
    try:
        settings = await asyncio.to_thread(
            studio.remember_autodarts_name, str(data.get("player_id", "")), str(data.get("autodarts_name", ""))
        )
    except ValueError as e:
        raise ValidationError(str(e)) from None
    except KeyError:
        raise NotFound("Player not found") from None
    return web.json_response({"status": "ok", **settings})


async def handle_studio_raw(request: web.Request) -> web.Response:
    """The match and lobby data exactly as received from Autodarts, to check the Studio against a real game."""
    client = _match_client(request)
    body = {
        "source": _source_info(client),
        "match_state": getattr(client, "last_match_state", None) if client else None,
        # The newest Autodarts lobby (players picked before the start), open or not
        "lobby_state": getattr(client, "last_lobby_state", None) if client else None,
    }
    return web.json_response(body, headers={"Content-Disposition": 'attachment; filename="autoglow-match-data.json"'})


# Autodarts Board Manager on this computer: tells which camera it uses for dart detection
BOARD_MANAGER_CONFIG_URL = f"{studio_camera.BOARD_MANAGER_URL}/api/config"
STREAM_BOUNDARY = "autoglowframe"
STREAM_FRAME_TIMEOUT = 10.0


async def _board_manager_cameras() -> list:
    try:
        timeout = aiohttp.ClientTimeout(total=1.5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(BOARD_MANAGER_CONFIG_URL) as res:
                data = await res.json(content_type=None)
        cams = ((data or {}).get("cam") or {}).get("cams") or []
        return [c.split("location=", 1)[1] for c in cams if isinstance(c, str) and "location=" in c]
    except Exception:
        return []


async def handle_list_cameras(request: web.Request) -> web.Response:
    """Cameras the Studio can stream to every device: the ones the Autodarts Board Manager streams
    (shared with dart detection) and USB cameras on this computer that no other program uses."""
    cams, used, autodarts = await asyncio.gather(
        asyncio.to_thread(studio_camera.list_cameras), _board_manager_cameras(), studio_camera.list_autodarts_cameras()
    )
    for cam in cams:
        cam["source"] = "usb"
        cam["autodarts"] = any(loc and f"-{loc}-" in f"-{cam['id']}-" for loc in used)
    return web.json_response({"status": "ok", "cameras": autodarts + cams,
                              "resolutions": list(studio_camera.RESOLUTIONS), "relay_fps": list(studio_camera.RELAY_FPS)})


def _usb_device(cam_id: str) -> str:
    """/dev/videoN of a USB camera on this computer; only those have picture controls here."""
    if studio_camera.autodarts_stream_url(cam_id):
        raise ValidationError("Picture controls are only for a USB camera on the AutoGlow computer")
    device = studio_camera.resolve_device(cam_id)
    if not device:
        raise NotFound("Camera not found – is it plugged in?")
    return device


async def handle_get_camera_controls(request: web.Request) -> web.Response:
    """Picture controls (brightness, white balance, exposure...) of a USB camera: ?cam=<id>."""
    device = _usb_device(request.query.get("cam", ""))
    try:
        controls = await asyncio.to_thread(studio_camera.get_controls, device)
    except OSError as e:
        raise ServiceUnavailable(f"Camera controls not readable: {e.strerror or e}") from None
    return web.json_response({"status": "ok", "controls": controls})


async def handle_set_camera_controls(request: web.Request) -> web.Response:
    """{cam, slot, values: {"<control id>": value}} sets controls now; {cam, slot, reset: true} returns
    every control to its default. When the slot already shows this camera the values are saved at
    once, so they come back whenever the camera is opened again (otherwise with the page's Save)."""
    data = await read_json(request)
    cam_id = str(data.get("cam", ""))
    slot = str(data.get("slot", ""))
    device = _usb_device(cam_id)
    if any(loc and f"-{loc}-" in f"-{cam_id}-" for loc in await _board_manager_cameras()):
        raise ValidationError("Autodarts uses this camera for dart detection; change its picture in Autodarts")
    reset = bool(data.get("reset"))
    try:
        if reset:
            controls = await asyncio.to_thread(studio_camera.get_controls, device)
            values = {c["id"]: c["default"] for c in controls}
        else:
            values = {int(k): v for k, v in studio_camera.clean_control_values(data.get("values")).items()}
        result = await asyncio.to_thread(studio_camera.set_controls, device, values)
    except OSError as e:
        raise ServiceUnavailable(f"Camera controls not writable: {e.strerror or e}") from None
    saved = {} if reset else {str(k): v for k, v in values.items()}
    await asyncio.to_thread(studio.save_camera_controls, slot, cam_id, saved, reset)
    return web.json_response({"status": "ok", **result})


def _camera_hub(app: web.Application) -> studio_camera.CameraHub:
    hub = app.get("studio_camera_hub")
    if hub is None:
        hub = studio_camera.CameraHub()
        app["studio_camera_hub"] = hub
    return hub


async def handle_camera_stream(request: web.Request) -> web.StreamResponse:
    """MJPEG stream of a camera (?cam=<id>&res=720p): a USB camera of this computer, or one the Autodarts
    Board Manager streams (cam=autodarts:<n>). Any browser shows it as an <img>."""
    settings = await asyncio.to_thread(studio.load_settings)
    resolution = request.query.get("res") or settings["camera_resolution"]
    try:
        cam_id = request.query.get("cam", "")
        stream = _camera_hub(request.app).acquire(cam_id, resolution, settings["relay_fps"], studio.saved_controls(cam_id))
    except LookupError:
        raise NotFound("Camera not found") from None
    # ?delay=<seconds>: the picture a few seconds late, for the dart zoom (the Studio previews stay live)
    try:
        delay = min(studio_camera.MAX_DELAY, max(0.0, float(request.query.get("delay", 0))))
    except ValueError:
        delay = 0.0
    if delay > 0:
        stream.keep_history(delay)
    try:
        seq = stream.seq - 1 if stream.frame else 0
        frame = await stream.next_frame(seq, studio_camera.FIRST_FRAME_TIMEOUT)
        if frame is not None and delay > 0:
            # Wait until the history reaches back far enough (the first `delay` seconds after opening)
            got = await stream.delayed_frame(0, delay, delay + studio_camera.FIRST_FRAME_TIMEOUT)
            frame = got[1] if got else None
            seq = got[0] if got else seq
        if frame is None:
            return web.json_response(
                {"status": "error", "message": stream.error or "The camera sends no picture"}, status=503
            )
        response = web.StreamResponse(headers={
            "Content-Type": f"multipart/x-mixed-replace; boundary={STREAM_BOUNDARY}",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
        })
        await response.prepare(request)
        try:
            while frame is not None:
                if delay <= 0:
                    seq = stream.seq
                await response.write(
                    f"--{STREAM_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n".encode()
                    + frame + b"\r\n"
                )
                # A slow viewer simply gets fewer frames: always the newest one, never a backlog
                if delay > 0:
                    got = await stream.delayed_frame(seq, delay, STREAM_FRAME_TIMEOUT)
                    seq, frame = got if got else (seq, None)
                else:
                    frame = await stream.next_frame(seq, STREAM_FRAME_TIMEOUT)
        except ConnectionResetError:
            pass  # The viewer closed the page
        return response
    finally:
        _camera_hub(request.app).release(stream)


async def handle_output_log(request: web.Request) -> web.Response:
    """A Studio output reports a camera problem (TVs have no developer tools): written to the log."""
    data = await read_json(request)
    camera = str(data.get("camera", ""))[:40]
    message = str(data.get("message", ""))[:200]
    status = str(data.get("status", ""))[:12]
    agent = request.headers.get("User-Agent", "")[:120]
    logger.warning(
        f"Studio output {request.remote}: {camera} – {message or 'no picture'} (status {status}, "
        f"secure={data.get('secure')}, webcodecs={data.get('webcodecs')}) [{agent}]"
    )
    return web.json_response({"status": "ok"})


def _video_hub(app: web.Application) -> studio_video.H264Hub:
    hub = app.get("studio_video_hub")
    if hub is None:
        hub = studio_video.H264Hub(_camera_hub(app))
        app["studio_video_hub"] = hub
    return hub


async def handle_camera_video(request: web.Request) -> web.StreamResponse:
    """A camera as H.264 in fragmented MP4 (?cam=<id>&res=720p&delay=<s>), encoded by the graphics chip;
    the outputs play it with Media Source. The codec string for Media Source is in X-Codec."""
    if not await asyncio.to_thread(studio_video.encoder_available):
        raise ServiceUnavailable("No H.264 encoder (ffmpeg with VAAPI) on this computer")
    settings = await asyncio.to_thread(studio.load_settings)
    cam_id = request.query.get("cam", "")
    resolution = request.query.get("res") or settings["camera_resolution"]
    try:
        delay = min(studio_camera.MAX_DELAY, max(0.0, float(request.query.get("delay", 0))))
    except ValueError:
        delay = 0.0
    hub = _video_hub(request.app)
    cam = hub.get(cam_id, resolution, settings["relay_fps"], studio.saved_controls(cam_id), delay)
    viewer = cam.add_viewer()
    try:
        if not await cam.wait_ready(studio_camera.FIRST_FRAME_TIMEOUT + delay + 5):
            return web.json_response({"status": "error", "message": cam.error or "The camera sends no picture"}, status=503)
        init = cam.init or b""
        response = web.StreamResponse(headers={
            "Content-Type": "video/mp4",
            "X-Codec": cam.codec,
            "Access-Control-Expose-Headers": "X-Codec",
            "Cache-Control": "no-cache, no-store, must-revalidate",
        })
        await response.prepare(request)
        try:
            await response.write(init)
            while True:
                fragment = await viewer.queue.get()
                if fragment is None:
                    break
                await response.write(fragment)
        except ConnectionResetError:
            pass  # The viewer closed the page
        return response
    finally:
        hub.release(cam, viewer)


async def _stop_cameras(app: web.Application) -> None:
    video = app.get("studio_video_hub")
    if video:
        video.stop_all()
    hub = app.get("studio_camera_hub")
    if hub:
        hub.stop_all()
    watcher = app.get("studio_dart_watcher")
    if watcher:
        await watcher.stop()


async def _start_dart_watcher(app: web.Application) -> None:
    watcher = studio_darts.DartWatcher()
    app["studio_dart_watcher"] = watcher
    watcher.start()


def register_studio_routes(app: web.Application) -> None:
    app.on_startup.append(_start_dart_watcher)
    app.on_cleanup.append(_stop_cameras)
    app.router.add_get("/api/studio", handle_get_studio)
    app.router.add_post("/api/studio", handle_post_studio)
    app.router.add_post("/api/studio/players", handle_save_player)
    app.router.add_post("/api/studio/players/{id}", handle_save_player)
    app.router.add_delete("/api/studio/players/{id}", handle_delete_player)
    app.router.add_get("/api/studio/images/{name}", handle_player_image)
    app.router.add_get("/api/studio/state", handle_studio_state)
    app.router.add_get("/api/studio/raw", handle_studio_raw)
    app.router.add_get("/api/studio/cameras", handle_list_cameras)
    app.router.add_get("/api/studio/stream", handle_camera_stream)
    app.router.add_get("/api/studio/video", handle_camera_video)
    app.router.add_post("/api/studio/output-log", handle_output_log)
    app.router.add_get("/api/studio/camera-controls", handle_get_camera_controls)
    app.router.add_post("/api/studio/camera-controls", handle_set_camera_controls)
    app.router.add_post("/api/studio/cue", handle_studio_cue)
    app.router.add_post("/api/studio/remember-name", handle_remember_name)
    app.router.add_get("/api/studio/autodarts", handle_autodarts_state)
    app.router.add_post("/api/studio/autodarts/start", handle_autodarts_start)
