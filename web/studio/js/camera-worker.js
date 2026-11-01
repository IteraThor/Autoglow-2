// AutoGlow Studio - reads one camera stream and decodes its frames off the main thread.
//
// h264:  /api/studio/video, fragmented MP4 with one frame per fragment (core/studio_video.py), decoded
//        by WebCodecs on the graphics chip. Frames go to WebGL without a copy through the CPU.
// mjpeg: /api/studio/stream, split into JPEGs and decoded into ImageBitmaps (on the CPU).
// Either way only the newest frame matters: there is no playback clock to run dry (Media Source stalled
// on the jitter of a live camera), a frame is handed over as soon as it is decoded and the page shows
// the newest one at each screen refresh (livecam.js).
//
// Messages in:  { type: 'open', url, format: 'h264' | 'mjpeg' }  /  { type: 'close' }
// Messages out: { type: 'frame', frame, received, dropped }  /  { type: 'error', message, status }  /  { type: 'ended' }
//               (frame: VideoFrame or ImageBitmap, transferred)

let controller = null;
let received = 0;       // frames read from the stream, and dropped before decoding (diagnostics)
let dropped = 0;

function indexOf(buf, len, pattern, from) {
  outer: for (let i = from; i <= len - pattern.length; i++) {
    for (let k = 0; k < pattern.length; k++) if (buf[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

// Growing byte buffer for a stream read in chunks
class Bytes {
  constructor() { this.buf = new Uint8Array(1 << 20); this.len = 0; }
  push(value) {
    if (this.len + value.length > this.buf.length) {
      const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.len + value.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(value, this.len);
    this.len += value.length;
  }
  consume(n) {
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }
}

// --- MJPEG ----------------------------------------------------------------------------------------
const HEADER_END = [13, 10, 13, 10];
const text = new TextDecoder();

function mjpegReader() {
  const bytes = new Bytes();
  let waiting = null;   // newest JPEG not decoded yet
  let decoding = false;
  const decodeLoop = async () => {
    if (decoding) return;
    decoding = true;
    try {
      while (waiting) {
        const jpeg = waiting;
        waiting = null;
        try {
          // Decoded the way WebGL uploads it (no alpha, no colour conversion): no conversion pass later
          const frame = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }),
            { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          self.postMessage({ type: 'frame', frame, received, dropped }, [frame]);
        } catch {
          // A damaged frame: skip it
        }
      }
    } finally {
      decoding = false;
    }
  };
  return {
    push(value) {
      bytes.push(value);
      const { buf } = bytes;
      let start = 0;
      for (;;) {
        const headEnd = indexOf(buf, bytes.len, HEADER_END, start);
        if (headEnd < 0) break;
        const match = /content-length:\s*(\d+)/i.exec(text.decode(buf.subarray(start, headEnd)));
        if (!match) { start = headEnd + 4; continue; }
        const body = headEnd + 4;
        const size = Number(match[1]);
        if (bytes.len < body + size) break;
        if (waiting) dropped++;
        waiting = buf.slice(body, body + size);
        received++;
        start = body + size;
      }
      if (start) bytes.consume(start);
      decodeLoop();
    },
    close() { waiting = null; }
  };
}

// --- H.264 in fragmented MP4 -------------------------------------------------------------------------
const MAX_DECODE_QUEUE = 4;   // frames waiting in the decoder before the stream skips to the next keyframe

function boxHeader(buf, at, len) {
  if (at + 8 > len) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + at, 8);
  const size = view.getUint32(0);
  const type = String.fromCharCode(buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]);
  return size >= 8 ? { size, type } : null;
}

// The avcC box contents (the decoder's description) from the init segment
function avcC(init) {
  for (let i = 4; i + 4 <= init.length; i++) {
    if (init[i] === 0x61 && init[i + 1] === 0x76 && init[i + 2] === 0x63 && init[i + 3] === 0x43) {
      const size = new DataView(init.buffer, init.byteOffset + i - 4, 4).getUint32(0);
      return init.slice(i + 4, i - 4 + size);
    }
  }
  return null;
}

// An IDR picture among the length-prefixed NAL units of a frame
function isKeyframe(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let pos = 0; pos + 5 <= data.length;) {
    if ((data[pos + 4] & 0x1f) === 5) return true;
    pos += 4 + view.getUint32(pos);
  }
  return false;
}

function h264Reader(codec, fail) {
  const bytes = new Bytes();
  let init = new Uint8Array(0);
  let decoder = null;
  let needKey = true;
  let timestamp = 0;
  const output = frame => self.postMessage({ type: 'frame', frame, received, dropped }, [frame]);

  const configure = async () => {
    const config = { codec, description: avcC(init), hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true };
    let ok = false;
    try { ok = (await VideoDecoder.isConfigSupported(config)).supported; } catch { /* unknown codec */ }
    if (!ok) {
      // Software decoding is still far cheaper than JPEG; only give up without any decoder
      delete config.hardwareAcceleration;
      try { ok = (await VideoDecoder.isConfigSupported(config)).supported; } catch { /* unknown codec */ }
    }
    if (!ok) { fail(`This browser cannot decode ${codec}`, 415); return; }
    decoder = new VideoDecoder({ output, error: e => fail(`Video decoder: ${e.message}`, 0) });
    decoder.configure(config);
  };

  return {
    push(value) {
      bytes.push(value);
      const { buf } = bytes;
      let at = 0;
      let moof = false;
      for (;;) {
        const head = boxHeader(buf, at, bytes.len);
        if (!head || at + head.size > bytes.len) break;
        const box = buf.subarray(at, at + head.size);
        if (head.type === 'ftyp' || head.type === 'moov') {
          const joined = new Uint8Array(init.length + box.length);
          joined.set(init);
          joined.set(box, init.length);
          init = joined;
          if (head.type === 'moov') configure();
        } else if (head.type === 'moof') {
          moof = true;
        } else if (head.type === 'mdat' && moof) {
          moof = false;
          received++;
          const data = box.slice(8);
          const key = isKeyframe(data);
          // Behind (the decoder is still busy): skip to the next keyframe instead of piling up
          if (decoder && decoder.state === 'configured' && decoder.decodeQueueSize > MAX_DECODE_QUEUE) needKey = true;
          if (!decoder || decoder.state !== 'configured' || (needKey && !key)) {
            dropped++;
          } else {
            needKey = false;
            timestamp += 33333;
            decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
          }
        }
        at += head.size;
      }
      // A moof whose mdat has not arrived yet stays in the buffer
      if (moof) {
        let back = 0;
        for (let p = 0; p < at;) { const h = boxHeader(buf, p, bytes.len); if (h.type === 'moof') back = p; p += h.size; }
        at = back;
      }
      if (at) bytes.consume(at);
    },
    close() {
      if (decoder && decoder.state !== 'closed') decoder.close();
    }
  };
}

// --- Stream ------------------------------------------------------------------------------------------
async function open(url, format) {
  close();
  const ctrl = new AbortController();
  controller = ctrl;
  let failed = false;
  const fail = (message, status) => {
    if (failed || ctrl.signal.aborted) return;
    failed = true;
    ctrl.abort();
    self.postMessage({ type: 'error', message, status });
  };
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
  } catch {
    // AutoGlow restarting or the network gone: the page tries again
    fail('Camera not reachable', -1);
    return;
  }
  if (!res.ok) {
    let message = '';
    try { message = (await res.json()).message || ''; } catch { /* not JSON */ }
    fail(message, res.status);
    return;
  }
  if (format === 'h264' && typeof VideoDecoder === 'undefined') {
    fail('This browser has no video decoder (WebCodecs)', 415);
    return;
  }
  const reader = format === 'h264' ? h264Reader(res.headers.get('X-Codec') || 'avc1.640028', fail) : mjpegReader();
  ctrl.signal.addEventListener('abort', () => reader.close());
  const body = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await body.read();
      if (done || ctrl.signal.aborted) break;
      reader.push(value);
    }
  } catch {
    // Connection dropped or closed on purpose
  }
  reader.close();
  if (!ctrl.signal.aborted) self.postMessage({ type: 'ended' });
}

function close() {
  if (controller) controller.abort();
  controller = null;
}

self.onmessage = ({ data }) => {
  if (data?.type === 'open') open(data.url, data.format || 'mjpeg');
  else if (data?.type === 'close') close();
};
