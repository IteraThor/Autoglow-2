"""Studio H.264 cameras (core/studio_video.py): splitting ffmpeg's fragmented MP4 for the viewers."""

import asyncio
import struct
import unittest

from core import studio_video


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(body), kind) + body


def nal(nal_type: int, payload: bytes = b"\x00\x11") -> bytes:
    data = bytes([nal_type]) + payload
    return struct.pack(">I", len(data)) + data


class FakeStdout:
    def __init__(self, data: bytes):
        self.data = data

    async def readexactly(self, n: int) -> bytes:
        if len(self.data) < n:
            raise asyncio.IncompleteReadError(self.data, n)
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk


class FakeProc:
    def __init__(self, data: bytes):
        self.stdout = FakeStdout(data)


class TestStudioVideo(unittest.IsolatedAsyncioTestCase):
    async def test_error_output_is_drained_while_the_process_runs(self):
        """A process that writes far more than a pipe holds (damaged camera frames) must not block."""
        code = "import sys\nfor i in range(5000): sys.stderr.write('Error while decoding frame %d\\n' % i)"
        proc = await asyncio.create_subprocess_exec(
            "python3", "-c", code, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        last = await asyncio.wait_for(studio_video._last_line(proc.stderr), 10)
        await proc.wait()
        self.assertEqual(last, "Error while decoding frame 4999")

    def test_codec_string_from_avcc(self):
        # avcC: version 1, profile 0x64 (High), compatibility 0x00, level 0x28 (4.0)
        init = box(b"moov", box(b"avcC", bytes([1, 0x64, 0x00, 0x28, 0xFF])))
        self.assertEqual(studio_video._codec_string(init), "avc1.640028")
        self.assertEqual(studio_video._codec_string(b"no codec box"), "avc1.640028")

    def test_keyframe_detection(self):
        self.assertTrue(studio_video._is_keyframe(nal(9) + nal(0x65)))   # access unit delimiter + IDR
        self.assertFalse(studio_video._is_keyframe(nal(9) + nal(0x41)))  # non-IDR slice

    async def test_init_segment_and_fragments_go_to_viewers(self):
        cam = studio_video.H264Camera("k", hub=None, acquire_args=(), delay=0)  # type: ignore[arg-type]
        late = studio_video._Viewer()
        cam.viewers.append(late)
        init = box(b"ftyp", b"isom") + box(b"moov", box(b"avcC", bytes([1, 0x64, 0, 0x1F, 0xFF])))
        delta = box(b"moof", b"m1") + box(b"mdat", nal(0x41))
        key = box(b"moof", b"m2") + box(b"mdat", nal(0x65))
        delta2 = box(b"moof", b"m3") + box(b"mdat", nal(0x41))
        await cam._read(FakeProc(init + delta + key + delta2))
        self.assertEqual(cam.init, init)
        self.assertEqual(cam.codec, "avc1.64001f")
        # A viewer starts at the first keyframe; the frame before it would not decode
        got = [late.queue.get_nowait() for _ in range(late.queue.qsize())]
        self.assertEqual(got, [key, delta2])

    def test_slow_viewer_skips_to_next_keyframe(self):
        cam = studio_video.H264Camera("k", hub=None, acquire_args=(), delay=0)  # type: ignore[arg-type]
        viewer = studio_video._Viewer()
        cam.viewers.append(viewer)
        cam._publish(b"key", True)
        for _ in range(studio_video.VIEWER_QUEUE + 5):
            cam._publish(b"delta", False)
        self.assertTrue(viewer.waiting_for_key)
        cam._publish(b"delta", False)
        cam._publish(b"key2", True)
        self.assertEqual(viewer.queue.get_nowait(), b"key2")


if __name__ == "__main__":
    unittest.main()
