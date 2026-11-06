"""
AutoGlow 2 - Studio cameras as H.264, encoded by the graphics chip (Fedora: VAAPI via ffmpeg).

A browser decodes MJPEG on the CPU and has to copy every frame to the GPU (about 25 ms per frame
here), which is what made the Studio output stutter. H.264 is decoded by the graphics chip and its
frames go straight into WebGL (about 2 ms), at a tenth of the network traffic.

One ffmpeg per camera turns the JPEG frames AutoGlow already has (core/studio_camera.py, shared with
the MJPEG previews, delayed for the dart zoom) into fragmented MP4: an init segment, then one fragment
per frame. Every viewer gets the init segment and then the fragments from the next keyframe on, which
the browser plays with Media Source Extensions (web/studio/js/livevideo.js).
Needs ffmpeg with h264_vaapi and a VAAPI driver that encodes H.264 (Fedora: RPM Fusion's ffmpeg and
intel-media-driver); without them the outputs keep the MJPEG streams.
"""

import asyncio
import logging
import os
import shutil
import struct
from typing import Dict, List, Optional, Tuple

from core.studio_camera import CameraHub, FrameSource

logger = logging.getLogger("autoglow.studio.video")

RENDER_NODE = "/dev/dri/renderD128"
BITRATE = "10M"           # Plenty for 1280x960 at 30 fps on the local network (about 6 Mbit/s used)
MAX_RATE = "14M"
GOP = 30                  # A keyframe every second: new viewers start within a second
VIEWER_QUEUE = 90         # Fragments a viewer may fall behind (3 s) before it skips to the next keyframe
CLOSE_AFTER_SECONDS = 10.0
FRAME_TIMEOUT = 10.0

_available: Optional[bool] = None


def encoder_available() -> bool:
    """ffmpeg with the VAAPI H.264 encoder and a render node to run it on (checked once)."""
    global _available
    if _available is None:
        _available = bool(shutil.which("ffmpeg")) and os.path.exists(RENDER_NODE) and _has_vaapi_h264()
        logger.info(f"Studio H.264 cameras: {'available (VAAPI)' if _available else 'not available, MJPEG only'}")
    return _available


def _has_vaapi_h264() -> bool:
    import subprocess
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return " h264_vaapi " in out


def _ffmpeg_command() -> List[str]:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        # JPEGs decoded by the graphics chip; frame times are their arrival (the cameras are not exact)
        "-hwaccel", "vaapi", "-hwaccel_device", RENDER_NODE, "-hwaccel_output_format", "vaapi",
        "-use_wallclock_as_timestamps", "1", "-fflags", "nobuffer", "-f", "mjpeg", "-i", "pipe:0",
        "-vf", "scale_vaapi=format=nv12", "-fps_mode", "passthrough",
        "-c:v", "h264_vaapi", "-profile:v", "high", "-b:v", BITRATE, "-maxrate", MAX_RATE,
        "-bf", "0", "-g", str(GOP),
        # One fragment per frame, so nothing waits for a whole group of frames
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof+frag_every_frame", "pipe:1",
    ]


async def _last_line(stream) -> str:
    """Read a stream to its end and return its last non-empty line."""
    last = ""
    while stream is not None:
        try:
            raw = await stream.readline()
        except ValueError:  # one absurdly long line: skip it
            continue
        if not raw:
            break
        line = raw.decode(errors="replace").strip()
        if line:
            last = line
    return last


def _codec_string(init: bytes) -> str:
    """'avc1.PPCCLL' for Media Source from the avcC box of the init segment."""
    i = init.find(b"avcC")
    if i < 0 or i + 8 > len(init):
        return "avc1.640028"
    profile, compat, level = init[i + 5], init[i + 6], init[i + 7]
    return f"avc1.{profile:02x}{compat:02x}{level:02x}"


def _is_keyframe(mdat_body: bytes) -> bool:
    """An IDR picture among the length-prefixed NAL units of a fragment."""
    pos = 0
    while pos + 5 <= len(mdat_body):
        size = struct.unpack_from(">I", mdat_body, pos)[0]
        if mdat_body[pos + 4] & 0x1F == 5:
            return True
        pos += 4 + size
    return False


class _Viewer:
    def __init__(self) -> None:
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=VIEWER_QUEUE)
        self.waiting_for_key = True


class H264Camera:
    """One camera as fragmented-MP4 H.264, shared by all its viewers; closes when nobody watches."""

    def __init__(self, key: str, hub: CameraHub, acquire_args: Tuple, delay: float):
        self.key = key
        self.hub = hub
        self.acquire_args = acquire_args
        self.delay = delay
        self.init: Optional[bytes] = None
        self.codec = ""
        self.error = ""
        self.viewers: List[_Viewer] = []
        self._ready = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._close_handle: Optional[asyncio.TimerHandle] = None

    # --- viewers ---
    def add_viewer(self) -> _Viewer:
        if self._close_handle:
            self._close_handle.cancel()
            self._close_handle = None
        viewer = _Viewer()
        self.viewers.append(viewer)
        if self._task is None or self._task.done():
            self.error = ""
            self._task = asyncio.get_running_loop().create_task(self._run())
        return viewer

    def remove_viewer(self, viewer: _Viewer, on_idle) -> None:
        if viewer in self.viewers:
            self.viewers.remove(viewer)
        if not self.viewers and not self._close_handle:
            self._close_handle = asyncio.get_running_loop().call_later(CLOSE_AFTER_SECONDS, on_idle, self)

    async def wait_ready(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except asyncio.TimeoutError:
            return False
        return self.init is not None

    def _publish(self, fragment: bytes, keyframe: bool) -> None:
        for viewer in self.viewers:
            if viewer.waiting_for_key and not keyframe:
                continue
            try:
                viewer.queue.put_nowait(fragment)
                viewer.waiting_for_key = False
            except asyncio.QueueFull:
                # Too slow (network): drop what it has not taken and go on from the next keyframe
                while not viewer.queue.empty():
                    viewer.queue.get_nowait()
                viewer.waiting_for_key = True

    def _end_viewers(self) -> None:
        for viewer in self.viewers:
            try:
                viewer.queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    # --- encoder ---
    async def _run(self) -> None:
        source: Optional[FrameSource] = None
        proc = None
        feeder = None
        try:
            source = self.hub.acquire(*self.acquire_args)
            if self.delay > 0:
                source.keep_history(self.delay)
            proc = await asyncio.create_subprocess_exec(
                *_ffmpeg_command(), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            loop = asyncio.get_running_loop()
            feeder = loop.create_task(self._feed(source, proc))
            # Read while ffmpeg runs: a full error pipe (a camera sending damaged frames) would stall the encoder
            err_task = loop.create_task(_last_line(proc.stderr))
            await self._read(proc)
            err = await err_task
            if not self.error:
                self.error = source.error or err or "The video encoder stopped"
        except (OSError, LookupError) as e:
            self.error = f"Video encoder not started: {e}"
        finally:
            if self.error:
                logger.warning(f"Studio H.264 camera {self.key}: {self.error}")
            if feeder:
                feeder.cancel()
            if proc and proc.returncode is None:
                proc.kill()
                await proc.wait()
            if source is not None:
                self.hub.release(source)
            self.init = None
            self._ready.set()
            self._ready = asyncio.Event()
            self._end_viewers()

    async def _feed(self, source: FrameSource, proc) -> None:
        """The camera's JPEG frames into ffmpeg (delayed ones for the dart zoom)."""
        seq = source.seq - 1 if source.frame else 0
        try:
            while True:
                if self.delay > 0:
                    got = await source.delayed_frame(seq, self.delay, FRAME_TIMEOUT)
                    if not got:
                        break
                    seq, frame = got
                else:
                    frame = await source.next_frame(seq, FRAME_TIMEOUT)
                    if frame is None:
                        break
                    seq = source.seq
                proc.stdin.write(frame)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass

    async def _read(self, proc) -> None:
        """Split ffmpeg's MP4 into the init segment and one fragment (moof + mdat) per frame."""
        out = proc.stdout
        init = b""
        moof = b""
        while True:
            try:
                head = await out.readexactly(8)
            except asyncio.IncompleteReadError:
                return
            size, kind = struct.unpack(">I4s", head)
            if size == 1:
                large = await out.readexactly(8)
                size = struct.unpack(">Q", large)[0]
                head += large
            body = await out.readexactly(size - len(head))
            box = head + body
            if kind in (b"ftyp", b"moov"):
                init += box
                if kind == b"moov":
                    self.init = init
                    self.codec = _codec_string(init)
                    self._ready.set()
            elif kind == b"moof":
                moof = box
            elif kind == b"mdat" and moof:
                self._publish(moof + box, _is_keyframe(body))
                moof = b""


class H264Hub:
    """The H.264 cameras by camera, resolution and delay."""

    def __init__(self, hub: CameraHub) -> None:
        self.hub = hub
        self._cams: Dict[str, H264Camera] = {}

    def get(self, cam_id: str, resolution: str, relay_fps: int, controls: Dict[int, int], delay: float) -> H264Camera:
        key = f"{cam_id}|{resolution}|{relay_fps}|{delay:.2f}"
        cam = self._cams.get(key)
        if cam is None:
            cam = H264Camera(key, self.hub, (cam_id, resolution, relay_fps, controls), delay)
            self._cams[key] = cam
        return cam

    def _idle(self, cam: H264Camera) -> None:
        cam._close_handle = None
        if cam.viewers:
            return
        if cam._task and not cam._task.done():
            cam._task.cancel()
        self._cams.pop(cam.key, None)

    def release(self, cam: H264Camera, viewer: _Viewer) -> None:
        cam.remove_viewer(viewer, self._idle)

    def stop_all(self) -> None:
        for cam in self._cams.values():
            if cam._task and not cam._task.done():
                cam._task.cancel()
        self._cams.clear()
