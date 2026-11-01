"""
AutoGlow 2 - Studio cameras
Captures USB cameras on the AutoGlow computer (Linux V4L2, MJPEG mode) and shares each one as
an MJPEG stream, so the Studio output can be shown on any device in the network (TVs included).

The camera already sends JPEG frames, so nothing is decoded or re-encoded: frames go to the
viewers as they come. A camera is opened when its first viewer connects and closed shortly after
the last one leaves. Needs no extra packages; on other systems the list of cameras is just empty.
"""

import asyncio
import collections
import ctypes
import errno
import logging
import mmap
import os
import re
import select
import sys
import threading
import time
from typing import Any, Dict, List, Optional

import aiohttp

if sys.platform != "win32":  # Windows has no fcntl/V4L2: list_cameras() finds no /sys/class/video4linux and returns []
    import fcntl

logger = logging.getLogger("autoglow.studio_camera")

SYS_DIR = "/sys/class/video4linux"
BY_PATH_DIR = "/dev/v4l/by-path"
RESOLUTIONS = {"480p": (848, 480), "720p": (1280, 720), "1080p": (1920, 1080)}
DEFAULT_RESOLUTION = "720p"
FPS = 30
BUFFER_COUNT = 4
CLOSE_AFTER_SECONDS = 10.0
FIRST_FRAME_TIMEOUT = 6.0
# Dart zoom: screens can show a camera a few seconds late (see FrameSource.delayed_frame)
MAX_DELAY = 5.0
_ID_RE = re.compile(r"^[A-Za-z0-9:._-]{1,120}$")


# -----------------------------------------------------------------------------
# V4L2 structures and ioctls (linux/videodev2.h)
# -----------------------------------------------------------------------------
def _ioc(direction: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord("V") << 8) | nr


_IOR, _IOW, _IOWR = 2, 1, 3
BUF_TYPE_VIDEO_CAPTURE = 1
MEMORY_MMAP = 1
CAP_VIDEO_CAPTURE = 0x00000001
CAP_DEVICE_CAPS = 0x80000000
PIX_FMT_MJPEG = int.from_bytes(b"MJPG", "little")
FIELD_ANY = 0


class _Capability(ctypes.Structure):
    _fields_ = [("driver", ctypes.c_char * 16), ("card", ctypes.c_char * 32), ("bus_info", ctypes.c_char * 32),
                ("version", ctypes.c_uint32), ("capabilities", ctypes.c_uint32), ("device_caps", ctypes.c_uint32),
                ("reserved", ctypes.c_uint32 * 3)]


class _FmtDesc(ctypes.Structure):
    _fields_ = [("index", ctypes.c_uint32), ("type", ctypes.c_uint32), ("flags", ctypes.c_uint32),
                ("description", ctypes.c_char * 32), ("pixelformat", ctypes.c_uint32),
                ("mbus_code", ctypes.c_uint32), ("reserved", ctypes.c_uint32 * 3)]


class _PixFormat(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "width", "height", "pixelformat", "field", "bytesperline", "sizeimage", "colorspace", "priv",
        "flags", "ycbcr_enc", "quantization", "xfer_func")]


class _FormatUnion(ctypes.Union):
    # The kernel union holds structs with pointers, so it is 8-byte aligned on 64-bit systems
    _fields_ = [("pix", _PixFormat), ("raw_data", ctypes.c_uint8 * 200), ("_align", ctypes.c_void_p)]


class _Format(ctypes.Structure):
    _fields_ = [("type", ctypes.c_uint32), ("fmt", _FormatUnion)]


class _Fract(ctypes.Structure):
    _fields_ = [("numerator", ctypes.c_uint32), ("denominator", ctypes.c_uint32)]


class _CaptureParm(ctypes.Structure):
    _fields_ = [("capability", ctypes.c_uint32), ("capturemode", ctypes.c_uint32), ("timeperframe", _Fract),
                ("extendedmode", ctypes.c_uint32), ("readbuffers", ctypes.c_uint32), ("reserved", ctypes.c_uint32 * 4)]


class _ParmUnion(ctypes.Union):
    _fields_ = [("capture", _CaptureParm), ("raw_data", ctypes.c_uint8 * 200)]


class _StreamParm(ctypes.Structure):
    _fields_ = [("type", ctypes.c_uint32), ("parm", _ParmUnion)]


class _RequestBuffers(ctypes.Structure):
    _fields_ = [("count", ctypes.c_uint32), ("type", ctypes.c_uint32), ("memory", ctypes.c_uint32),
                ("capabilities", ctypes.c_uint32), ("flags", ctypes.c_uint8), ("reserved", ctypes.c_uint8 * 3)]


class _Timeval(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_long), ("tv_usec", ctypes.c_long)]


class _Timecode(ctypes.Structure):
    _fields_ = [("type", ctypes.c_uint32), ("flags", ctypes.c_uint32), ("frames", ctypes.c_uint8),
                ("seconds", ctypes.c_uint8), ("minutes", ctypes.c_uint8), ("hours", ctypes.c_uint8),
                ("userbits", ctypes.c_uint8 * 4)]


class _BufferM(ctypes.Union):
    _fields_ = [("offset", ctypes.c_uint32), ("userptr", ctypes.c_ulong), ("planes", ctypes.c_void_p),
                ("fd", ctypes.c_int32)]


class _Buffer(ctypes.Structure):
    _fields_ = [("index", ctypes.c_uint32), ("type", ctypes.c_uint32), ("bytesused", ctypes.c_uint32),
                ("flags", ctypes.c_uint32), ("field", ctypes.c_uint32), ("timestamp", _Timeval),
                ("timecode", _Timecode), ("sequence", ctypes.c_uint32), ("memory", ctypes.c_uint32),
                ("m", _BufferM), ("length", ctypes.c_uint32), ("reserved2", ctypes.c_uint32),
                ("request_fd", ctypes.c_int32)]


VIDIOC_QUERYCAP = _ioc(_IOR, 0, ctypes.sizeof(_Capability))
VIDIOC_ENUM_FMT = _ioc(_IOWR, 2, ctypes.sizeof(_FmtDesc))
VIDIOC_S_FMT = _ioc(_IOWR, 5, ctypes.sizeof(_Format))
VIDIOC_REQBUFS = _ioc(_IOWR, 8, ctypes.sizeof(_RequestBuffers))
VIDIOC_QUERYBUF = _ioc(_IOWR, 9, ctypes.sizeof(_Buffer))
VIDIOC_QBUF = _ioc(_IOWR, 15, ctypes.sizeof(_Buffer))
VIDIOC_DQBUF = _ioc(_IOWR, 17, ctypes.sizeof(_Buffer))
VIDIOC_STREAMON = _ioc(_IOW, 18, ctypes.sizeof(ctypes.c_int))
VIDIOC_STREAMOFF = _ioc(_IOW, 19, ctypes.sizeof(ctypes.c_int))
VIDIOC_S_PARM = _ioc(_IOWR, 22, ctypes.sizeof(_StreamParm))


class _QueryCtrl(ctypes.Structure):
    _fields_ = [("id", ctypes.c_uint32), ("type", ctypes.c_uint32), ("name", ctypes.c_char * 32),
                ("minimum", ctypes.c_int32), ("maximum", ctypes.c_int32), ("step", ctypes.c_int32),
                ("default_value", ctypes.c_int32), ("flags", ctypes.c_uint32), ("reserved", ctypes.c_uint32 * 2)]


class _MenuUnion(ctypes.Union):
    _pack_ = 1
    _fields_ = [("name", ctypes.c_char * 32), ("value", ctypes.c_int64)]


class _QueryMenu(ctypes.Structure):
    _pack_ = 1  # __attribute__((packed)) in videodev2.h
    _fields_ = [("id", ctypes.c_uint32), ("index", ctypes.c_uint32), ("u", _MenuUnion), ("reserved", ctypes.c_uint32)]


class _Control(ctypes.Structure):
    _fields_ = [("id", ctypes.c_uint32), ("value", ctypes.c_int32)]


VIDIOC_G_CTRL = _ioc(_IOWR, 27, ctypes.sizeof(_Control))
VIDIOC_S_CTRL = _ioc(_IOWR, 28, ctypes.sizeof(_Control))
VIDIOC_QUERYCTRL = _ioc(_IOWR, 36, ctypes.sizeof(_QueryCtrl))
VIDIOC_QUERYMENU = _ioc(_IOWR, 37, ctypes.sizeof(_QueryMenu))


# -----------------------------------------------------------------------------
# JPEG: cameras often leave out the Huffman tables; add the standard ones (JPEG Annex K.3)
# -----------------------------------------------------------------------------
def _ac_values(head: List[int]) -> List[int]:
    """Standard AC symbol order: the listed leading symbols, then every other run/size code in order."""
    rest = [r << 4 | s for r in range(16) for s in range(1, 11) if (r << 4 | s) not in head]
    return head + rest


_AC_LUMA_HEAD = [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
                 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
                 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
                 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
                 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
                 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
                 0x8A, 0x92]
_AC_CHROMA_HEAD = [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
                   0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0,
                   0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
                   0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
                   0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
                   0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82]

HUFFMAN_TABLES = [
    # (class/id, code counts per length 1..16, symbols)
    (0x00, [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], list(range(12))),
    (0x10, [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D], _ac_values(_AC_LUMA_HEAD)),
    (0x01, [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], list(range(12))),
    (0x11, [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], _ac_values(_AC_CHROMA_HEAD)),
]


def _dht_segment() -> bytes:
    body = b"".join(bytes([tc]) + bytes(bits) + bytes(vals) for tc, bits, vals in HUFFMAN_TABLES)
    return b"\xff\xc4" + (len(body) + 2).to_bytes(2, "big") + body


DHT_SEGMENT = _dht_segment()


def ensure_huffman_tables(frame: bytes) -> bytes:
    """Make a camera MJPEG frame a complete JPEG every browser can show."""
    if not frame.startswith(b"\xff\xd8"):
        return frame
    sos = frame.find(b"\xff\xda")
    if sos == -1 or frame.find(b"\xff\xc4", 2, sos) != -1:
        return frame
    return frame[:2] + DHT_SEGMENT + frame[2:]


# -----------------------------------------------------------------------------
# Camera list
# -----------------------------------------------------------------------------
def _stable_ids() -> Dict[str, str]:
    """/dev/videoN -> USB port name, which stays the same across reboots (these cameras share a serial)."""
    ids: Dict[str, str] = {}
    try:
        names = sorted(os.listdir(BY_PATH_DIR))
    except OSError:
        return ids
    for name in names:
        if "-usbv2-" in name:
            continue  # The same cameras again under the kernel's second naming scheme
        target = os.path.realpath(os.path.join(BY_PATH_DIR, name))
        ids.setdefault(target, name)
    return ids


def _query(dev: str) -> Optional[Dict[str, str]]:
    """Name and bus of a capture node that can deliver MJPEG, or None."""
    try:
        fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        cap = _Capability()
        fcntl.ioctl(fd, VIDIOC_QUERYCAP, cap)
        caps = cap.device_caps if cap.capabilities & CAP_DEVICE_CAPS else cap.capabilities
        if not caps & CAP_VIDEO_CAPTURE:
            return None
        for index in range(32):
            desc = _FmtDesc(index=index, type=BUF_TYPE_VIDEO_CAPTURE)
            try:
                fcntl.ioctl(fd, VIDIOC_ENUM_FMT, desc)
            except OSError:
                return None
            if desc.pixelformat == PIX_FMT_MJPEG:
                return {"card": cap.card.decode(errors="replace"), "bus": cap.bus_info.decode(errors="replace")}
        return None
    except OSError:
        return None
    finally:
        os.close(fd)


def _port_label(stable_id: str) -> str:
    match = re.search(r"usb-\d+:([\d.]+):", stable_id)
    return f"USB port {match.group(1)}" if match else stable_id


def list_cameras() -> List[Dict[str, Any]]:
    """Cameras on this computer that can be streamed: [{id, name, device}]."""
    if not os.path.isdir(SYS_DIR):
        return []
    stable = _stable_ids()
    cams = []
    for node in sorted(os.listdir(SYS_DIR), key=lambda n: int(re.sub(r"\D", "", n) or 0)):
        if not node.startswith("video"):
            continue
        dev = f"/dev/{node}"
        info = _query(dev)
        if not info:
            continue
        cam_id = stable.get(dev, node)
        cams.append({"id": cam_id, "name": f"{info['card']} ({_port_label(cam_id)})", "device": dev})
    return cams


def resolve_device(cam_id: str) -> Optional[str]:
    """/dev/videoN for a camera id from list_cameras(), or None."""
    if not _ID_RE.match(cam_id or "") or cam_id.strip(".") == "":
        return None
    path = f"/dev/{cam_id}" if re.match(r"^video\d+$", cam_id) else os.path.join(BY_PATH_DIR, cam_id)
    real = os.path.realpath(path)
    return real if re.match(r"^/dev/video\d+$", real) and os.path.exists(real) else None


# -----------------------------------------------------------------------------
# Picture controls (brightness, white balance, exposure...): what `v4l2-ctl -L` shows
# -----------------------------------------------------------------------------
CTRL_NEXT = 0x80000000
CTRL_FLAG_DISABLED, CTRL_FLAG_READ_ONLY, CTRL_FLAG_INACTIVE, CTRL_FLAG_WRITE_ONLY = 0x01, 0x04, 0x10, 0x40
CTRL_TYPE_INT, CTRL_TYPE_BOOL, CTRL_TYPE_MENU, CTRL_TYPE_INT_MENU = 1, 2, 3, 9
_CTRL_TYPES = {CTRL_TYPE_INT: "int", CTRL_TYPE_BOOL: "bool", CTRL_TYPE_MENU: "menu", CTRL_TYPE_INT_MENU: "menu"}
MAX_CONTROLS = 64


def _query_controls(fd: int) -> List[Dict[str, Any]]:
    controls: List[Dict[str, Any]] = []
    qc = _QueryCtrl(id=CTRL_NEXT)
    while len(controls) < MAX_CONTROLS * 2:
        try:
            fcntl.ioctl(fd, VIDIOC_QUERYCTRL, qc)
        except OSError:
            break
        kind = _CTRL_TYPES.get(qc.type)
        if kind and not qc.flags & (CTRL_FLAG_DISABLED | CTRL_FLAG_READ_ONLY | CTRL_FLAG_WRITE_ONLY):
            ctrl: Dict[str, Any] = {
                "id": qc.id, "name": qc.name.decode(errors="replace"), "type": kind,
                "min": qc.minimum, "max": qc.maximum, "step": qc.step or 1, "default": qc.default_value,
                "inactive": bool(qc.flags & CTRL_FLAG_INACTIVE), "value": qc.default_value,
            }
            if kind == "menu":
                ctrl["menu"] = []
                for index in range(max(0, qc.minimum), qc.maximum + 1):
                    qm = _QueryMenu(id=qc.id, index=index)
                    try:
                        fcntl.ioctl(fd, VIDIOC_QUERYMENU, qm)
                    except OSError:
                        continue  # Gaps in a menu are normal (e.g. auto exposure 0 and 2)
                    label = str(qm.u.value) if qc.type == CTRL_TYPE_INT_MENU else qm.u.name.decode(errors="replace")
                    ctrl["menu"].append({"value": index, "label": label})
            try:
                c = _Control(id=qc.id)
                fcntl.ioctl(fd, VIDIOC_G_CTRL, c)
                ctrl["value"] = c.value
            except OSError:
                pass
            controls.append(ctrl)
        qc = _QueryCtrl(id=qc.id | CTRL_NEXT)
    return controls[:MAX_CONTROLS]


def _set_controls(fd: int, values: Dict[int, int]) -> List[str]:
    """Set controls; switches (auto white balance, auto exposure...) first, so the manual values
    they unlock can be set after them. Returns the names of controls the camera refused."""
    known = {c["id"]: c for c in _query_controls(fd)}
    order = sorted((cid for cid in values if cid in known), key=lambda cid: known[cid]["type"] == "int")
    failed = []
    for cid in order:
        ctrl = known[cid]
        value = min(ctrl["max"], max(ctrl["min"], int(values[cid])))
        try:
            fcntl.ioctl(fd, VIDIOC_S_CTRL, _Control(id=cid, value=value))
        except OSError as e:
            failed.append(ctrl["name"])
            logger.debug(f"Camera control {ctrl['name']}={value} refused: {e}")
    return failed


def _open_for_controls(device: str) -> int:
    # Controls can be read and set while the camera streams (here or in the Studio's capture thread)
    return os.open(device, os.O_RDWR | os.O_NONBLOCK)


def get_controls(device: str) -> List[Dict[str, Any]]:
    fd = _open_for_controls(device)
    try:
        return _query_controls(fd)
    finally:
        os.close(fd)


def set_controls(device: str, values: Dict[int, int]) -> Dict[str, Any]:
    """Set controls and return {controls, failed}: the new state (an auto switch makes others active)."""
    fd = _open_for_controls(device)
    try:
        failed = _set_controls(fd, values)
        return {"controls": _query_controls(fd), "failed": failed}
    finally:
        os.close(fd)


def clean_control_values(raw: Any) -> Dict[str, int]:
    """Saved control values {"<control id>": value} from untrusted settings."""
    out: Dict[str, int] = {}
    if isinstance(raw, dict):
        for key, value in list(raw.items())[:MAX_CONTROLS]:
            if isinstance(key, str) and key.isdigit() and isinstance(value, int) and not isinstance(value, bool):
                out[key] = max(-(2 ** 31), min(2 ** 31 - 1, value))
    return out


# -----------------------------------------------------------------------------
# Autodarts Board Manager cameras (it streams the cameras it uses for dart detection)
# -----------------------------------------------------------------------------
BOARD_MANAGER_URL = "http://127.0.0.1:3180"
RELAY_FPS = (10, 15, 30)
DEFAULT_RELAY_FPS = 15
FRAME_JITTER = 0.012
# Camera ids: autodarts:0, autodarts:1, ... one camera; autodarts:live all of them side by side
_AUTODARTS_ID_RE = re.compile(r"^autodarts:(\d|live)$")


def autodarts_stream_url(cam_id: str) -> Optional[str]:
    match = _AUTODARTS_ID_RE.match(cam_id or "")
    if not match:
        return None
    which = match.group(1)
    return f"{BOARD_MANAGER_URL}/api/streams/live" if which == "live" else f"{BOARD_MANAGER_URL}/api/streams/cams/{which}"


AUTODARTS_STOPPED = "Autodarts is stopped – its cameras stream only while it runs"


async def board_manager_state() -> Optional[Dict[str, Any]]:
    """Detection state of the Board Manager ({running, status}), or None when it is not reachable."""
    try:
        timeout = aiohttp.ClientTimeout(total=2)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{BOARD_MANAGER_URL}/api/state") as res:
                state = await res.json(content_type=None)
    except Exception:
        return None
    if not isinstance(state, dict):
        return None
    return {"running": bool(state.get("running")), "status": str(state.get("status", ""))}


async def start_board_manager() -> Optional[Dict[str, Any]]:
    """Ask the Board Manager on this computer to start detection, like its own Start button.
    Only on request (a button), never automatically. Returns the new state, None if not reachable."""
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.put(f"{BOARD_MANAGER_URL}/api/start") as res:
                if res.status >= 400:
                    logger.warning(f"Board Manager refused to start ({res.status})")
    except Exception as e:
        logger.warning(f"Board Manager not reachable for start: {e}")
        return None
    return await board_manager_state()


async def list_autodarts_cameras() -> List[Dict[str, Any]]:
    """Cameras the Board Manager streams, or [] when it is not running on this computer."""
    try:
        timeout = aiohttp.ClientTimeout(total=1.5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{BOARD_MANAGER_URL}/api/cams/stats") as res:
                stats = await res.json(content_type=None)
    except Exception:
        return []
    fps = (stats or {}).get("fps") if isinstance(stats, dict) else None
    if not isinstance(fps, list) or not fps:
        return []
    res_info = stats.get("resolution") or {}
    size = f"{res_info.get('width')}x{res_info.get('height')}" if res_info.get("width") else ""
    cams = [{"id": f"autodarts:{i}", "name": f"Autodarts camera {i + 1}" + (f" ({size})" if size else ""), "source": "autodarts"}
            for i in range(len(fps))]
    if len(fps) > 1:
        cams.append({"id": "autodarts:live", "name": "All Autodarts cameras side by side", "source": "autodarts"})
    return cams


# -----------------------------------------------------------------------------
# Capture
# -----------------------------------------------------------------------------
class FrameSource:
    """Newest JPEG frame of one camera; viewers wait for the next one. Subclasses produce the frames."""

    def __init__(self, cam_id: str, variant: Any, loop: asyncio.AbstractEventLoop):
        self.cam_id = cam_id
        self.variant = variant  # What the source was opened with (size, frame rate); a change reopens it
        self.loop = loop
        self.frame: Optional[bytes] = None
        self.seq = 0
        self.error = ""
        self.viewers = 0
        self._event = asyncio.Event()
        self._close_handle: Optional[asyncio.TimerHandle] = None
        # Recent frames (arrival time, seq, frame) for viewers that watch with a delay; kept only as
        # long as a delayed viewer asked for (about 3.5 MB/s of an Autodarts camera at 15 fps)
        self.history: collections.deque = collections.deque()
        self.keep_seconds = 0.0

    def _publish(self, frame: bytes) -> None:
        self.frame = frame
        self.seq += 1
        if self.keep_seconds > 0:
            now = time.time()
            self.history.append((now, self.seq, frame))
            while self.history and now - self.history[0][0] > self.keep_seconds:
                self.history.popleft()
        elif self.history:
            self.history.clear()
        self._wake_soon()

    def _wake_soon(self) -> None:
        try:
            self.loop.call_soon_threadsafe(self._wake)
        except RuntimeError:
            pass  # Event loop already closed (shutdown)

    def _wake(self) -> None:
        event, self._event = self._event, asyncio.Event()
        event.set()

    @property
    def alive(self) -> bool:
        raise NotImplementedError

    # Errors that clear up on their own (a reconnecting relay) keep the source; others reopen it
    retry_on_acquire = True

    async def next_frame(self, after_seq: int, timeout: float) -> Optional[bytes]:
        deadline = time.monotonic() + timeout
        while self.seq <= after_seq and not self.error:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                await asyncio.wait_for(self._event.wait(), remaining)
            except asyncio.TimeoutError:
                return None
        return None if self.error else self.frame

    def keep_history(self, seconds: float) -> None:
        """Keep the frames of the last `seconds` (plus a margin) for a delayed viewer."""
        self.keep_seconds = max(self.keep_seconds, min(MAX_DELAY, seconds) + 1.0)

    async def delayed_frame(self, after_seq: int, delay: float, timeout: float) -> Optional[tuple]:
        """(seq, frame) of the newest frame that arrived at least `delay` seconds ago and is newer than
        after_seq; waits until there is one. A slow viewer skips frames instead of falling behind.
        Frame times are time.time() of their arrival, so dart events (same clock) line up with them."""
        deadline = time.monotonic() + timeout
        while not self.error:
            now = time.time()
            ready = None
            waiting = None
            for item in self.history:
                if item[1] <= after_seq:
                    continue
                if item[0] + delay <= now:
                    ready = item
                else:
                    waiting = item
                    break
            if ready:
                return ready[1], ready[2]
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            if waiting:
                await asyncio.sleep(min(remaining, waiting[0] + delay - now))
            else:
                try:
                    await asyncio.wait_for(self._event.wait(), remaining)
                except asyncio.TimeoutError:
                    return None
        return None

    def stop(self) -> None:
        raise NotImplementedError


class CameraStream(FrameSource):
    """A USB camera on this computer: a capture thread reads its MJPEG frames."""

    def __init__(self, cam_id: str, device: str, size: tuple, loop: asyncio.AbstractEventLoop,
                 controls: Optional[Dict[int, int]] = None):
        super().__init__(cam_id, size, loop)
        self.device = device
        self.size = size
        self.controls = controls or {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"studio-cam-{cam_id}", daemon=True)
        self._thread.start()

    # --- capture thread ---
    def _run(self) -> None:
        fd = -1
        maps: List[mmap.mmap] = []
        try:
            fd = os.open(self.device, os.O_RDWR | os.O_NONBLOCK)
            if self.controls:
                # Saved picture settings: a camera forgets them when it is unplugged
                failed = _set_controls(fd, self.controls)
                if failed:
                    logger.info(f"Studio camera {self.cam_id}: controls not applied: {', '.join(failed)}")
            fmt = _Format(type=BUF_TYPE_VIDEO_CAPTURE)
            fmt.fmt.pix.width, fmt.fmt.pix.height = self.size
            fmt.fmt.pix.pixelformat = PIX_FMT_MJPEG
            fmt.fmt.pix.field = FIELD_ANY
            fcntl.ioctl(fd, VIDIOC_S_FMT, fmt)
            parm = _StreamParm(type=BUF_TYPE_VIDEO_CAPTURE)
            parm.parm.capture.timeperframe.numerator = 1
            parm.parm.capture.timeperframe.denominator = FPS
            try:
                fcntl.ioctl(fd, VIDIOC_S_PARM, parm)
            except OSError:
                pass  # Frame rate is a wish; the camera's default is fine too

            req = _RequestBuffers(count=BUFFER_COUNT, type=BUF_TYPE_VIDEO_CAPTURE, memory=MEMORY_MMAP)
            fcntl.ioctl(fd, VIDIOC_REQBUFS, req)
            for index in range(req.count):
                buf = _Buffer(index=index, type=BUF_TYPE_VIDEO_CAPTURE, memory=MEMORY_MMAP)
                fcntl.ioctl(fd, VIDIOC_QUERYBUF, buf)
                maps.append(mmap.mmap(fd, buf.length, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=buf.m.offset))
                fcntl.ioctl(fd, VIDIOC_QBUF, buf)
            fcntl.ioctl(fd, VIDIOC_STREAMON, ctypes.c_int(BUF_TYPE_VIDEO_CAPTURE))
            logger.info(f"Studio camera {self.cam_id} streaming {fmt.fmt.pix.width}x{fmt.fmt.pix.height} MJPEG from {self.device}")

            while not self._stop.is_set():
                ready, _, _ = select.select([fd], [], [], 1.0)
                if not ready:
                    continue
                buf = _Buffer(type=BUF_TYPE_VIDEO_CAPTURE, memory=MEMORY_MMAP)
                try:
                    fcntl.ioctl(fd, VIDIOC_DQBUF, buf)
                except BlockingIOError:
                    continue
                data = maps[buf.index][:buf.bytesused]
                fcntl.ioctl(fd, VIDIOC_QBUF, buf)
                if len(data) > 4:
                    self._publish(ensure_huffman_tables(data))
        except OSError as e:
            if e.errno == errno.EBUSY:
                self.error = "Camera is in use by another program (Autodarts or a browser tab)"
            elif e.errno in (errno.EACCES, errno.EPERM):
                self.error = "No permission to open the camera (user must be in the 'video' group)"
            else:
                self.error = f"Camera error: {e.strerror or e}"
            logger.warning(f"Studio camera {self.cam_id} ({self.device}): {self.error}")
            self._wake_soon()
        finally:
            if fd >= 0:
                try:
                    fcntl.ioctl(fd, VIDIOC_STREAMOFF, ctypes.c_int(BUF_TYPE_VIDEO_CAPTURE))
                except OSError:
                    pass
            for m in maps:
                m.close()
            if fd >= 0:
                os.close(fd)

    @property
    def alive(self) -> bool:
        return self._thread.is_alive()

    def stop(self) -> None:
        self._stop.set()


class RelayStream(FrameSource):
    """A camera the Autodarts Board Manager already streams (MJPEG over HTTP). One connection to the
    Board Manager serves every viewer, so Autodarts keeps the camera for dart detection and its load
    does not grow with the number of screens. Frames are passed on at most `fps` times a second."""

    retry_on_acquire = False  # It reconnects by itself

    def __init__(self, cam_id: str, url: str, fps: int, loop: asyncio.AbstractEventLoop):
        super().__init__(cam_id, fps, loop)
        self.url = url
        self.min_interval = 1.0 / max(1, fps)
        self._stopped = False
        self._retry_now = asyncio.Event()
        self._task = loop.create_task(self._run())

    async def _run(self) -> None:
        delay = 1.0
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=3, sock_read=5)
        while not self._stopped:
            try:
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(self.url) as res:
                        if res.status != 200:
                            raise ConnectionError(f"Board Manager answered {res.status}")
                        reader = aiohttp.MultipartReader(res.headers, res.content)
                        logger.info(f"Studio camera {self.cam_id} relaying {self.url}")
                        last = 0.0
                        while not self._stopped:
                            part = await reader.next()
                            if part is None:
                                break
                            if not isinstance(part, aiohttp.BodyPartReader):
                                continue
                            data = await part.read(decode=False)
                            now = time.monotonic()
                            # Every frame is read, but only as many as viewers need are passed on.
                            # The tolerance absorbs arrival jitter (30 fps frames are 33 ms apart).
                            if len(data) > 4 and now - last >= self.min_interval - FRAME_JITTER:
                                last = now
                                self.error = ""
                                delay = 1.0
                                self._publish(ensure_huffman_tables(bytes(data)))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if not self._stopped:
                    self.error = await self._explain_outage()
                    logger.warning(f"Studio camera {self.cam_id}: {self.error} ({e})")
                    self._wake()
            if not self._stopped:
                try:
                    await asyncio.wait_for(self._retry_now.wait(), delay)
                except asyncio.TimeoutError:
                    pass
                self._retry_now.clear()
                delay = min(10.0, delay * 2)

    def retry_now(self) -> None:
        """Reconnect at once instead of after the back-off (e.g. Autodarts was just started)."""
        self._retry_now.set()

    async def _explain_outage(self) -> str:
        """Why no frames come: the Board Manager only streams its cameras while Autodarts runs."""
        try:
            timeout = aiohttp.ClientTimeout(total=2)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(f"{BOARD_MANAGER_URL}/api/state") as res:
                    state = await res.json(content_type=None)
        except Exception:
            return "Autodarts Board Manager not reachable – is Autodarts running on this computer?"
        if isinstance(state, dict) and state.get("running") is False:
            return AUTODARTS_STOPPED
        return "Autodarts camera sends no picture"

    @property
    def alive(self) -> bool:
        return not self._task.done()

    def stop(self) -> None:
        self._stopped = True
        self._task.cancel()


class CameraHub:
    """Shares each camera between all viewers and closes it when nobody watches any more."""

    def __init__(self) -> None:
        self._streams: Dict[str, FrameSource] = {}

    def acquire(self, cam_id: str, resolution: str, relay_fps: int = DEFAULT_RELAY_FPS,
                controls: Optional[Dict[int, int]] = None) -> FrameSource:
        relay_url = autodarts_stream_url(cam_id)
        device = None if relay_url else resolve_device(cam_id)
        if not relay_url and not device:
            raise LookupError(f"Camera {cam_id} not found")
        variant: Any = relay_fps if relay_url else RESOLUTIONS.get(resolution, RESOLUTIONS[DEFAULT_RESOLUTION])
        stream = self._streams.get(cam_id)
        if stream and (not stream.alive or stream.variant != variant):
            stream.stop()
            stream = None
        if stream and stream.error and stream.retry_on_acquire:
            # Try again: the program that had the camera may have let go of it
            stream.stop()
            stream = None
        if not stream:
            loop = asyncio.get_running_loop()
            if relay_url:
                stream = RelayStream(cam_id, relay_url, relay_fps, loop)
            else:
                stream = CameraStream(cam_id, device or "", variant, loop, controls)
            self._streams[cam_id] = stream
        if stream._close_handle:
            stream._close_handle.cancel()
            stream._close_handle = None
        stream.viewers += 1
        return stream

    def release(self, stream: FrameSource) -> None:
        stream.viewers = max(0, stream.viewers - 1)
        if stream.viewers == 0 and not stream._close_handle:
            stream._close_handle = stream.loop.call_later(CLOSE_AFTER_SECONDS, self._close, stream)

    def _close(self, stream: FrameSource) -> None:
        stream._close_handle = None
        if stream.viewers == 0:
            stream.stop()
            if self._streams.get(stream.cam_id) is stream:
                del self._streams[stream.cam_id]

    def retry_relays(self) -> None:
        for stream in self._streams.values():
            if isinstance(stream, RelayStream):
                stream.retry_now()

    def stop_all(self) -> None:
        for stream in self._streams.values():
            stream.stop()
        self._streams.clear()
